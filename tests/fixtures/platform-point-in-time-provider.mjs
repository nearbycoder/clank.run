// Explicitly owned trusted native adapter, not an untrusted Docker host certificate.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';import {fork} from 'node:child_process';
import {serve} from '../../dist/node.js';import {createDeploymentBundle,deploymentDigest,extractDeploymentBundle} from '../../dist/deploy.js';
import {applyMigrations} from '../../dist/migrations.js';import {openProviderDeploymentAgent} from '../../dist/provider.js';
import {createDeploymentCoordinatorClient} from '../../dist/runner.js';
const registrationToken='owned_captured_provider_registration_0123456789';
export async function capturedProvider(t){
  const root=await mkdtemp(join(tmpdir(),'clank-captured-native-provider-')),node=join(root,'node');await mkdir(node);const catalog=join(root,'provider-control.sqlite'),native=new DatabaseSync(catalog),key=new Uint8Array(32).fill(71),entries=new Map(),children=new Set();let agent,server;
  native.exec('PRAGMA busy_timeout=5000;CREATE TABLE current_binding(project TEXT PRIMARY KEY,release TEXT,generation INTEGER,active INTEGER) STRICT;CREATE TABLE retained_keys(project TEXT PRIMARY KEY,key BLOB) STRICT;');
  t.after(async()=>{await agent?.close();for(const owned of children){if(owned.child.exitCode===null&&owned.child.signalCode===null)owned.child.kill('SIGKILL');await owned.closed;}await server?.close();native.close();await rm(root,{recursive:true,force:true});});
  server=await serve(async request=>{
    const path=new URL(request.url).pathname;
    const entry=path==='/__clank/pitr/checkpoint'?entries.get(request.headers.get('x-clank-project-id')):[...entries.values()].find(value=>path.startsWith(value.ingress.route));
    if(!entry||entry.child.exitCode!==null||entry.child.signalCode!==null)return new Response(null,{status:503});
    const suffix=path==='/__clank/pitr/checkpoint'?path:path.slice(entry.ingress.route.length)||'/';
    if(path!=='/__clank/pitr/checkpoint'&&request.headers.get('authorization')!=='Bearer '+entry.ingress.token)return new Response(null,{status:404});
    return fetch(entry.origin+suffix,{headers:request.headers,redirect:'error'});
  },{hostname:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+server.port;
  const configuration={source:async(projectId)=>{
    const entry=entries.get(projectId);if(!entry)throw new Error('Native captured source is unavailable.');return {binding:entry.binding,origin,token:entry.token,encryptionKey:new Uint8Array(key),assertCurrent(){const row=native.prepare('SELECT release,generation,active FROM current_binding WHERE project=?').get(projectId);if(row?.release!==entry.binding.releaseId||row.generation!==entry.binding.generation||row.active!==1||entry.child.exitCode!==null||entry.child.signalCode!==null)throw new Error('Native captured source changed.');}};
  },restoreKey:async(projectId)=>{const key=native.prepare('SELECT key FROM retained_keys WHERE project=?').get(projectId)?.key;if(!(key instanceof Uint8Array))throw new Error('Independent native recovery key unavailable.');return new Uint8Array(key);},maxArchiveBytes:1024*1024};
  const openAgent=async f=>{
    agent=await openProviderDeploymentAgent({client:createDeploymentCoordinatorClient({baseUrl:f.options.publicUrl,fetch:(url,init)=>f.handle(new Request(url,init))}),registrationToken,node:{id:'owned-native-pitr-provider',region:'local',endpoint:origin,capacity:5},pollIntervalMs:20,heartbeatIntervalMs:100,
      provider:{kind:'owned-native-pitr',async reconcile(request){
        const project=request.operation.projectId;if(request.desired.state==='stopped'){const previous=entries.get(project);if(previous){native.prepare('UPDATE current_binding SET active=0 WHERE project=?').run(project);previous.child.kill('SIGTERM');await previous.closed;}return;}
        const manifest=request.runtime?.manifest;assert.ok(manifest);assert.ok(request.artifact?.bundle);const existing=entries.get(project);if(existing&&existing.binding.generation===manifest.generation&&existing.binding.releaseId===manifest.releaseId&&existing.child.exitCode===null&&existing.child.signalCode===null)return;
        assert.equal(existing,undefined,'This fixture admits one actual release per project.');const projectRoot=join(node,project),directory=join(projectRoot,'release'),databasePath=join(projectRoot,manifest.database.path);await mkdir(projectRoot,{recursive:true});await extractDeploymentBundle(request.artifact.bundle,directory);await applyMigrations({path:databasePath,directory:join(directory,request.artifact.bundle.config.database.migrations),restrictToDatabase:true});
        const binding={projectId:project,nodeId:'owned-native-pitr-provider',releaseId:manifest.releaseId,generation:manifest.generation};native.prepare('INSERT INTO current_binding VALUES(?,?,?,1)').run(project,binding.releaseId,binding.generation);native.prepare('INSERT INTO retained_keys VALUES(?,?)').run(project,key);
        const child=fork(join(directory,request.artifact.bundle.config.entry),[],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,PORT:'0',CLANK_DATABASE_PATH:databasePath,OWNED_PROVIDER_CATALOG:catalog,OWNED_PROVIDER_BINDING:JSON.stringify(binding),OWNED_RECOVERY_TOKEN:manifest.ingress.controlToken,OWNED_RECOVERY_KEY:Buffer.from(key).toString('base64')}}),closed=new Promise(resolve=>child.once('close',resolve)),owned={child,closed};children.add(owned);let output='';child.stderr.on('data',bytes=>output=(output+bytes).slice(-4096));
        const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned captured application startup: '+output)),15000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('close',()=>{clearTimeout(timer);reject(new Error('Owned captured application closed: '+output));});});assert.equal(ready.ready,true);
        const health=await fetch(ready.origin+'/healthz');assert.equal(health.status,200);assert.deepEqual((await health.json()).value,['mutation three']);entries.set(project,{...owned,binding,origin:ready.origin,token:manifest.ingress.controlToken,ingress:manifest.ingress});
      }}});
  };
  return {root,node,configuration,registrationToken,openAgent,
    async artifact(){const source=join(root,'artifact');await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'migrations'));await cp(fileURLToPath(new URL('../../dist/',import.meta.url)),join(source,'dist/framework'),{recursive:true});await writeFile(join(source,'dist/server.mjs'),await readFile(new URL('./platform-point-in-time-application.mjs',import.meta.url)));await writeFile(join(source,'migrations/0001_marker.sql'),"CREATE TABLE native_marker(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO native_marker VALUES(1,'verified migration');");const bytes=await createDeploymentBundle(source,{version:1,entry:'dist/server.mjs',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:10000},env:{}});return {bytes,digest:await deploymentDigest(bytes)};},
    async loseSource(){await agent?.close();agent=null;for(const entry of entries.values()){entry.child.kill('SIGKILL');await entry.closed;native.prepare('UPDATE current_binding SET active=0 WHERE project=?').run(entry.binding.projectId);}await rm(node,{recursive:true,force:true});},
  };
}
