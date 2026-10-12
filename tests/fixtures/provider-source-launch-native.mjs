// Opt-in production source launcher proof on the retained native Docker daemon.
// Original source construction and first-base capture are not ready/write/stop authority.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import * as h from '../../dist/provider-handoff.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {openDeploymentProviderDataStore} from '../../dist/provider-data.js';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {launchProviderSourceContainer} from '../../dist/provider-source-launch.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const image=process.argv[2],mode=process.argv[3]??'normal';assert.match(image,/^sha256:[a-f0-9]{64}$/);
assert.ok(['normal','close-owner','mount-drift'].includes(mode));
const directory=fs.mkdtempSync('/var/tmp/clank-production-source-'),root=join(directory,'provider'),source=join(directory,'capsule'),nonce=randomUUID();
const events={version:process.version,image,mode,nonce,directory,qualification:'Actual production source function with an already committed native baseline, original Docker domain, C1/grant/channel/stdin and original backend initialization. Source writes remain fenced. No readiness/control/write admission, all-role stop/target/ingress/fallback/interruption or host certificate is claimed.'};
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const config=join(directory,'docker-config');fs.mkdirSync(config,{mode:0o700});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
let owner,service,data,launched,failed;const ownerLabel='native_source_launch_'+nonce;
const originalSpawn=cp.spawn;events.nativeChildren=[];events.dockerCommands=[];
cp.spawn=(executable,args,options)=>{
 const child=originalSpawn(executable,args,options);
 if(executable==='/usr/bin/docker'){
  const observation={args,pid:child.pid,stdout:'',stderr:''};events.dockerCommands.push(observation);
  for(const name of ['stdout','stderr'])child[name]?.on('data',chunk=>{if(observation[name].length<8192)observation[name]+=chunk.toString().slice(0,8192-observation[name].length);});
  child.once('close',(code,signal)=>{observation.close={code,signal};});
 }
 if(executable==='/usr/bin/setpriv'){
  const observation={pid:child.pid,executable,broker:args.includes('--input-type=module'),stdio:options.stdio.map(value=>typeof value==='number'?{fd:value,path:fs.readlinkSync('/proc/self/fd/'+value)}:value),stderr:''};events.nativeChildren.push(observation);
  child.stderr?.on('data',chunk=>{if(observation.stderr.length<8192)observation.stderr+=chunk.toString().slice(0,8192-observation.stderr.length);});
  child.once('error',error=>{observation.error=error.message;});child.once('close',(code,signal)=>{observation.close={code,signal};});
 }
 return child;
};syncBuiltinESMExports();
const pins=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===root||path.startsWith(root+'/')?[path]:[];}catch{return [];}});
try{
 fs.mkdirSync(source);fs.mkdirSync(join(source,'dist'));fs.mkdirSync(join(source,'migrations'));
 fs.writeFileSync(join(source,'dist','server.js'),`import http from 'node:http';
import {openBackend,defineBackend,defineDatabase,defineTable} from '@clank.run/framework/backend';
import {s} from '@clank.run/framework/ai';
const definition=defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({}));
const slot=Symbol.for('clank.provider.source.startup.v1');const explicit=Object.hasOwn(globalThis,slot);
let runtime;try{runtime=await openBackend(definition,{path:process.env.CLANK_DATABASE_PATH,changePollIntervalMs:0,agent:false});}catch(error){const fs=await import('node:fs');fs.writeFileSync('/data/native-constructor-failure.json',JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600});throw error;}
let writesFenced=false;try{runtime.database.transaction(tx=>tx.table('records').insert({value:'must be refused'}));}catch{writesFenced=true;}
const result={constructorReturned:true,explicitStartup:explicit,bootstrapConsumed:!Object.hasOwn(globalThis,slot),writesFenced,rows:runtime.database.read(tx=>tx.table('records').collect()).length};
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));});server.listen(Number(process.env.PORT),'0.0.0.0');
process.on('SIGTERM',()=>{server.close();runtime.close();});
`);
 fs.writeFileSync(join(source,'migrations','0001_seed.sql'),"CREATE TABLE seed(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO seed VALUES(1,'original committed baseline');\n");
 const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'source.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:15000},env:{}},{frameworkVersion:'0.24.0-test',nodeVersion:process.version,frameworkRoot:fileURLToPath(new URL('../../',import.meta.url))});
 const runtime=await createDeploymentRuntimeCapsule({projectId:'native_project',releaseId:'native_release',generation:1,environment:{CLANK_PROCESS_ROLE:'worker'},database:{path:'source.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/native_project',token:'clanki_source-launch-native-12345678901234567890'},artifact},{maxDatabaseBytes:16777216});
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,client,'native_node',ownerLabel);assert.equal(domain.daemonId,'0a2ad0ab-df92-4c7b-a346-3ea757783f52');
 await h.initializeProviderHandoff(owner,domain);const project=await h.installProviderHandoffProject(owner,domain,'native_project'),bridge=await h.enableProviderHandoffBridge(owner,domain,limits);service=await h.admitProviderSourceService(bridge);
 const store=await openDeploymentProviderDataStore({rootDirectory:root,maxDatabaseBytes:16777216});await store.apply({operation:{id:'native_source_operation',projectId:'native_project',fence:1,attempt:1,maxAttempts:3},desired:{generation:1,releaseId:'native_release',state:'running',runtimeProtocol:'clank-runtime/1'},runtime,signal:new AbortController().signal},()=>{});
 data=await h.retainProviderSourceLaunchData(service,{projectId:'native_project',releaseId:'native_release',generation:1,capsuleSha256:runtime.sha256,fence:1});events.pinsBefore=pins().length;
 launched=await launchProviderSourceContainer(service,data,runtime.bytes,image,47031);events.container={pid:launched.container.pid,birth:launched.container.birth};launched.assertCurrent();await launched.container.verifyCurrent();
 await assert.rejects(h.retainProviderSourceWorker(launched.container),/channel is closed|duplicated or recycled/);events.retiredChannelCannotMintWorker=true;
 const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+ownerLabel,'--format','{{.ID}}'])).stdout.trim().split('\n');assert.equal(ids.length,1);events.container.id=ids[0];
 const response=await fetch('http://127.0.0.1:47031/healthz',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);events.originalBackend=await response.json();assert.deepEqual(events.originalBackend,{constructorReturned:true,explicitStartup:true,bootstrapConsumed:true,writesFenced:true,rows:0});
 const db=new DatabaseSync(data.databasePath,{readOnly:true});try{const state=db.prepare('SELECT * FROM clank_pitr_state').get();assert.ok(state.base_id);assert.equal(state.sequence,0);assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_journal').get().n,0);assert.equal(db.prepare('SELECT value FROM seed').get().value,'original committed baseline');events.originalNativeState=state;}finally{db.close();}
 const catalog=new DatabaseSync(join(root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite'),{readOnly:true});try{assert.equal(catalog.prepare('SELECT state FROM clank_provider_handoff_source_grant').get().state,'started');assert.equal(catalog.prepare('SELECT version FROM clank_provider_handoff_bridge_state').get().version,4);events.grantStillStarted=true;}finally{catalog.close();}
 assert.equal('activate'in launched,false);assert.equal('write'in launched,false);assert.equal('ready'in launched,false);
 if(mode==='mount-drift'){
  const inspected=JSON.parse((await command(['container','inspect',events.container.id])).stdout)[0];assert.equal(inspected.Id,events.container.id);assert.equal(inspected.Image,image);
  const original=inspected.Mounts.find(row=>row.Destination==='/run/clank-source-worker').Source,saved=original+'.original';
  fs.renameSync(original,saved);fs.mkdirSync(original,{mode:0o700});assert.throws(()=>launched.assertCurrent(),/mount observation changed|mount identity differs/);
  fs.rmdirSync(original);fs.renameSync(saved,original);assert.throws(()=>launched.assertCurrent(),/closed/);events.originalMountRestorationCannotRevive=true;
 }
 if(mode==='close-owner'){owner.close();assert.throws(()=>launched.assertCurrent());}
 await launched.close();data.close();service.close();owner.close();assert.equal(pins().length,0);events.originalPinsReleased=true;
 const remaining=await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+ownerLabel,'--format','{{.ID}}']);assert.equal(remaining.stdout.trim(),'');events.exactOwnedContainerAbsent=true;events.complete=true;
}catch(error){failed=error;events.complete=false;events.failure={message:error.message,stack:error.stack,errors:error.errors?.map(e=>({message:e.message,errors:e.errors?.map(x=>x.message)}))};}
finally{
 try{await launched?.close();}catch(error){events.cleanupFailure=error.message;failed??=error;}
 try{data?.close();service?.close();owner?.close();}catch(error){events.ownerCleanupFailure=error.message;failed??=error;}
 cp.spawn=originalSpawn;syncBuiltinESMExports();events.pinsAfterCleanup=pins().length;
 const constructorFailure=join(root,'projects','native_project','data','native-constructor-failure.json');if(fs.existsSync(constructorFailure))events.constructorFailure=JSON.parse(fs.readFileSync(constructorFailure,'utf8'));
 fs.writeFileSync(join(directory,'evidence.json'),JSON.stringify(events,null,2)+'\n');console.log(JSON.stringify(events));
}
if(failed)process.exitCode=1;
