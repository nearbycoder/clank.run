import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {chmod,copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {linuxProcessBirth} from '../dist/platform-supervisor.js';
import test from 'node:test';
import {providerDockerClient,runProviderDockerClient} from '../dist/provider-docker-client.js';
import {acquireProviderServiceOwnership,admitProviderService,createProviderHandoffDomain,initializeProviderHandoff,installProviderHandoffProject,insertProviderHandoffBarrier} from '../dist/provider-handoff.js';
import {openDeploymentProviderService,openDockerDeploymentProviderService} from '../dist/provider-service.js';
import {openDockerDeploymentRuntimeLauncher} from '../dist/provider-docker.js';
const digest='a'.repeat(64),projectId='project_handoff_01';
const input={identity:{handoffId:'handoff_01',source:{projectId,nodeId:'node_source',releaseId:'release_source',generation:1},targetNodeId:'node_target',targetGeneration:2,artifactSha256:digest},stepId:'step_stop',sourceCapsuleSha256:'b'.repeat(64),sourceIncarnation:'12345678-1234-4123-8123-123456789abc'};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'clank-private-handoff-')),root=join(directory,'provider'),executable=join(directory,'docker.mjs'),log=join(directory,'commands.jsonl');
 await writeFile(executable,`#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({args:process.argv.slice(2),domain:process.env.DAEMON})+'\\n');\nif(process.argv[2]==='info'){if(process.env.MODE==='fail')process.exit(9);if(process.env.MODE==='large')process.stdout.write('x'.repeat(4097));else if(process.env.MODE==='extra')process.stdout.write(JSON.stringify(process.env.DAEMON)+'\\n\\n');else process.stdout.write(JSON.stringify(process.env.DAEMON)+'\\n');}\n`,{mode:0o700});
 const owned=[];t.after(async()=>{for(const owner of owned.reverse())owner.close();await rm(directory,{recursive:true,force:true});});
 const options={executable,dockerEnvironment:{DAEMON:'daemon_original',COMMAND_LOG:log}};
 const open=async()=>{const owner=await acquireProviderServiceOwnership(root,true);owned.push(owner);return owner;};
 const getDomain=async(owner,changes={})=>createProviderHandoffDomain(owner,providerDockerClient({...options,dockerEnvironment:{...options.dockerEnvironment,...changes}}),'node_source','owner-original');
 return {directory,root,log,options,open,getDomain,async commands(){try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}}};
}
async function installed(t){const f=await fixture(t),owner=await f.open(),domain=await f.getDomain(owner),root=await initializeProviderHandoff(owner,domain),project=await installProviderHandoffProject(owner,domain,projectId);return {...f,owner,domain,rootIdentity:root,project,catalog:join(f.root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite'),index:join(f.root,'service','handoff','index.sqlite')};}
test('private handoff requires genuine native owner and domain capabilities',async t=>{
 const f=await fixture(t),owner=await f.open();await assert.rejects(acquireProviderServiceOwnership(f.root),/active writer/);
 await assert.rejects(initializeProviderHandoff({...owner},{}),/native provider owner/);
 await assert.rejects(initializeProviderHandoff(owner,{protocol:'clank-provider-handoff-domain/1',nodeId:'node_source',daemonId:'daemon_original',owner:'owner-original'}),/genuine owner-bound/);
 owner.close();const next=await f.open(),domain=await f.getDomain(next);assert.deepEqual(await initializeProviderHandoff(next,domain),await initializeProviderHandoff(next,domain));
 const db=new DatabaseSync(join(f.root,'service','.writer.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clank_provider_handoff_owner').get().n,1);}finally{db.close();}
});
test('complete marker and catalogs admit only the exact original Docker domain and revoke private mutation',async t=>{
 const f=await installed(t);f.owner.close();
 let owner=await f.open();await assert.rejects(admitProviderService(owner),/original native Docker domain/);owner.close();
 owner=await f.open();await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'changed-owner'),/original native Docker domain/);owner.close();
 owner=await f.open();await assert.rejects(admitProviderService(owner,providerDockerClient({...f.options,dockerEnvironment:{...f.options.dockerEnvironment,DAEMON:'daemon_new'}}),'owner-original'),/execution domain changed/);owner.close();
 owner=await f.open();const domain=await f.getDomain(owner);await admitProviderService(owner,providerDockerClient(f.options),'owner-original');await assert.rejects(installProviderHandoffProject(owner,domain,'other'),/pre-admission/);
 assert.ok((await f.commands()).every(command=>command.args[0]==='info'));
});
test('barriers are irreversible exact-input records, survive reopen and refuse the whole root',async t=>{
 const f=await installed(t),first=await insertProviderHandoffBarrier(f.owner,f.domain,projectId,input);assert.match(first.inputSha256,/^[a-f0-9]{64}$/);assert.deepEqual(await insertProviderHandoffBarrier(f.owner,f.domain,projectId,input),first);
 await assert.rejects(insertProviderHandoffBarrier(f.owner,f.domain,projectId,{...input,stepId:'other'}),/conflicts/);f.owner.close();
 const owner=await f.open(),domain=await f.getDomain(owner);assert.deepEqual(await insertProviderHandoffBarrier(owner,domain,projectId,input),first);await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'),/barrier refuses ordinary root startup/);owner.close();
 const db=new DatabaseSync(f.catalog,{readOnly:true});try{const row=db.prepare('SELECT * FROM clank_provider_handoff_barrier').get(),meta=db.prepare('SELECT * FROM clank_provider_handoff_catalog').get();assert.equal(row.input_sha256,first.inputSha256);assert.equal(meta.barrier_sha256,first.inputSha256);assert.equal(row.version,1);}finally{db.close();}
 const before=(await f.commands()).length;await assert.rejects(openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}}),/barrier refuses/);const added=(await f.commands()).slice(before);assert.equal(added.length,1);assert.equal(added[0].args[0],'info');
});
test('ordinary structural factory refuses retained marker before calling supplied adapters',async t=>{
 const f=await installed(t);f.owner.close();const touched=[];const adapter=new Proxy({}, {get(_target,key){touched.push(String(key));return async()=>{};}});
 await assert.rejects(openDeploymentProviderService({rootDirectory:f.root,data:adapter,runtimes:adapter,ingress:adapter}),/original native Docker domain/);assert.deepEqual(touched,[]);
});
test('unmarked and complete zero-barrier roots preserve native ordinary startup',async t=>{
 const f=await fixture(t);const options={rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}};
 let service=await openDockerDeploymentProviderService(options);await service.close();assert.ok((await f.commands()).every(command=>command.args[0]!=='info'));
 const owner=await f.open(),domain=await f.getDomain(owner);await initializeProviderHandoff(owner,domain);await installProviderHandoffProject(owner,domain,projectId);owner.close();
 const before=(await f.commands()).length;service=await openDockerDeploymentProviderService(options);await service.close();const commands=(await f.commands()).slice(before);assert.equal(commands[0].args[0],'info');assert.ok(commands.slice(1).every(command=>command.args[0]==='container'));
});
test('native Docker identity failures retain original marker and never run cleanup',async t=>{
 const f=await installed(t);f.owner.close();const markerBefore=await readFile(join(f.root,'service','.writer.sqlite'));
 for(const MODE of ['fail','large','extra']){const before=(await f.commands()).length;await assert.rejects(openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,dockerEnvironment:{...f.options.dockerEnvironment,MODE},user:'1000:1000'}}));assert.ok((await f.commands()).slice(before).every(command=>command.args[0]==='info'));}
 assert.deepEqual(await readFile(join(f.root,'service','.writer.sqlite')),markerBefore);
});
test('frozen Docker client retains endpoint environment across caller mutation',async t=>{
 const f=await fixture(t),owner=await f.open(),options={...f.options,dockerEnvironment:{...f.options.dockerEnvironment}},client=providerDockerClient(options);options.dockerEnvironment.DAEMON='changed';options.executable='/missing/changed';const domain=await createProviderHandoffDomain(owner,client,'node_source','owner-original');assert.equal(domain.daemonId,'daemon_original');await initializeProviderHandoff(owner,domain);
});
test('unknown catalog schema, missing barrier and altered marker pairs refuse without repair',async t=>{
 for(const mutate of [db=>db.exec('CREATE TABLE unexpected(x)'),db=>db.exec('DELETE FROM clank_provider_handoff_barrier'),db=>db.exec("UPDATE clank_provider_handoff_catalog SET barrier_sha256=NULL")]){
  const f=await installed(t);await insertProviderHandoffBarrier(f.owner,f.domain,projectId,input);f.owner.close();const db=new DatabaseSync(f.catalog);try{mutate(db);}finally{db.close();}const before=await readFile(f.catalog);const owner=await f.open();await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'));owner.close();assert.deepEqual(await readFile(f.catalog),before);
 }
});
test('reserved catalog, missing index and orphan directory deny startup without implicit recovery',async t=>{
 for(const mode of ['reserved','missing','orphan']){const f=await installed(t);f.owner.close();if(mode==='reserved'){const db=new DatabaseSync(f.index);try{db.exec("UPDATE clank_provider_handoff_projects SET installation='reserved'");}finally{db.close();}}else if(mode==='missing')await rm(f.index);else await writeFile(join(f.root,'service','handoff','unexpected'),'retained');const owner=await f.open();await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'));owner.close();}
});
test('native unknown schema rejects ignored-write trigger before a barrier can be acknowledged',async t=>{
 const f=await installed(t),db=new DatabaseSync(f.catalog);try{db.exec('CREATE TRIGGER ignore_barrier BEFORE INSERT ON clank_provider_handoff_barrier BEGIN SELECT RAISE(IGNORE); END');}finally{db.close();}
 await assert.rejects(insertProviderHandoffBarrier(f.owner,f.domain,projectId,input),/schema is unsupported/);const verify=new DatabaseSync(f.catalog,{readOnly:true});try{assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM clank_provider_handoff_barrier').get().n,0);}finally{verify.close();}
});
test('native owner close after asynchronous domain start prevents publication',async t=>{
 const f=await fixture(t),owner=await f.open(),pending=createProviderHandoffDomain(owner,providerDockerClient(f.options),'node_source','owner-original');owner.close();await assert.rejects(pending,/native provider owner/);const next=await f.open();await admitProviderService(next);assert.equal(await readFile(join(f.root,'service','.writer.sqlite')).then(buffer=>buffer.includes(Buffer.from('clank_provider_handoff_owner'))),false);
});
test('exact native readback refuses false-success and altered barrier writes atomically',async t=>{
 for(const mode of ['ignored-insert','altered-insert','ignored-mirror']){
  const f=await installed(t),original=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql){const statement=original.call(this,sql),run=statement.run.bind(statement);if(sql.startsWith('INSERT INTO clank_provider_handoff_barrier'))statement.run=(...args)=>mode==='ignored-insert'?{changes:1,lastInsertRowid:1}:run(...(mode==='altered-insert'?[args[0],'altered_step',...args.slice(2)]:args));if(mode==='ignored-mirror'&&sql.startsWith('UPDATE clank_provider_handoff_catalog SET barrier_sha256'))statement.run=()=>({changes:1});return statement;};
  try{await assert.rejects(insertProviderHandoffBarrier(f.owner,f.domain,projectId,input));}finally{DatabaseSync.prototype.prepare=original;}
  const db=new DatabaseSync(f.catalog,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clank_provider_handoff_barrier').get().n,0);assert.equal(db.prepare('SELECT barrier_sha256 FROM clank_provider_handoff_catalog').get().barrier_sha256,null);}finally{db.close();}
 }
});
test('owner marker alone and reserved namespace without marker are preserved, never adopted',async t=>{
 for(const marked of [false,true]){const f=await fixture(t),owner=await f.open();if(marked){const domain=await f.getDomain(owner);await initializeProviderHandoff(owner,domain);owner.close();await rm(join(f.root,'service','handoff'),{recursive:true});}else{owner.close();await writeFile(join(f.root,'service','handoff'),'foreign sentinel');}
  const next=await f.open();await assert.rejects(admitProviderService(next,providerDockerClient(f.options),'owner-original'));next.close();if(!marked)assert.equal(await readFile(join(f.root,'service','handoff'),'utf8'),'foreign sentinel');
 }
});
test('catalog identity, file bounds, unsafe sidecars and permissions are refused before native cleanup',async t=>{
 for(const mode of ['identity','oversize','wal','permission']){const f=await installed(t);f.owner.close();if(mode==='identity'){const db=new DatabaseSync(f.catalog);try{db.prepare('UPDATE clank_provider_handoff_catalog SET project_id=?').run('wrong_project');}finally{db.close();}}else if(mode==='oversize')await writeFile(f.catalog,Buffer.alloc(65537));else if(mode==='wal')await writeFile(f.catalog+'-wal',Buffer.alloc(0),{mode:0o600});else await chmod(f.catalog,0o644);const before=(await f.commands()).length;const owner=await f.open();await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'));owner.close();assert.equal((await f.commands()).length,before);}
});
test('actual SIGKILL at metadata durability boundaries preserves denial or exact completed retry',async t=>{
 for(const boundary of ['marker','index','reserved','catalog','ready','barrier']){
  const f=await fixture(t),child=fork(new URL('./fixtures/provider-handoff-owner.mjs',import.meta.url),[f.root,f.options.executable,f.log,boundary],{stdio:['ignore','pipe','pipe','ipc']}),exit=once(child,'exit');let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-16384);});
  let timer;try{const message=await Promise.race([once(child,'message').then(([value])=>value),exit.then(value=>{throw new Error('Metadata child exited before checkpoint '+JSON.stringify(value)+' '+output);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Metadata checkpoint timeout '+boundary+' '+output)),10000);})]);assert.deepEqual(message,{boundary});assert.equal(child.kill('SIGKILL'),true);const [status,signal]=await exit;assert.equal(status,null);assert.equal(signal,'SIGKILL');}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}}
  const owner=await f.open();if(['marker','reserved','catalog'].includes(boundary)){await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'));}
  else if(boundary==='barrier'){const domain=await f.getDomain(owner),ack=await insertProviderHandoffBarrier(owner,domain,projectId,input);assert.match(ack.inputSha256,/^[a-f0-9]{64}$/);await assert.rejects(admitProviderService(owner,providerDockerClient(f.options),'owner-original'),/barrier refuses/);}
  else {const domain=await f.getDomain(owner);if(boundary==='ready')assert.equal((await installProviderHandoffProject(owner,domain,projectId)).projectId,projectId);await admitProviderService(owner,providerDockerClient(f.options),'owner-original');}
  owner.close();
 }
});
test('post-publication domain awaits cannot acknowledge a catalog whose committed mirror disappeared',async t=>{
 const f=await installed(t),original=fsSync.fsyncSync;let scheduled=false,mutated=false;
 fsSync.fsyncSync=function(fd){original(fd);if(!scheduled&&fsSync.readlinkSync('/proc/self/fd/'+fd)===f.catalog){scheduled=true;queueMicrotask(()=>{const db=new DatabaseSync(f.catalog);try{db.exec('DELETE FROM clank_provider_handoff_barrier');mutated=true;}finally{db.close();}});}};
 syncBuiltinESMExports();
 try{const result=await insertProviderHandoffBarrier(f.owner,f.domain,projectId,input).then(value=>({value}),error=>({error}));assert.equal(mutated,true,'native retained barrier row was deleted during awaited domain proof');assert.match(result.error?.message??'acknowledged corrupted catalog',/unavailable/);}finally{fsSync.fsyncSync=original;syncBuiltinESMExports();}
});
test('one hundred complete catalogs fit the native bounds and a further reservation refuses without eviction',async t=>{
 const f=await installed(t);f.owner.close();const db=new DatabaseSync(f.index);try{db.exec('BEGIN IMMEDIATE');for(let number=1;number<100;number++){const catalogId=randomUUID(),project='project_'+number,directory=join(f.root,'service','handoff','catalogs',catalogId);await mkdir(directory,{mode:0o700});const filename=join(directory,'catalog.sqlite');await copyFile(f.catalog,filename);const catalog=new DatabaseSync(filename);try{catalog.prepare('UPDATE clank_provider_handoff_catalog SET catalog_id=?,project_id=?').run(catalogId,project);}finally{catalog.close();}db.prepare("INSERT INTO clank_provider_handoff_projects VALUES(?,?,'ready')").run(project,catalogId);}db.exec('COMMIT');}finally{db.close();}
 let owner=await f.open(),domain=await f.getDomain(owner);await assert.rejects(installProviderHandoffProject(owner,domain,'one_too_many'),/capacity/);owner.close();owner=await f.open();await admitProviderService(owner,providerDockerClient(f.options),'owner-original');owner.close();const check=new DatabaseSync(f.index,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM clank_provider_handoff_projects').get().n,100);}finally{check.close();}
});
test('the frozen native command deadline includes inherited output pipes after its direct child exits',async t=>{
 const f=await fixture(t),program=fileURLToPath(new URL('./fixtures/provider-handoff-pipe-parent.mjs',import.meta.url)),pidFile=join(f.directory,'pipe-child.pid');
 const client=providerDockerClient({executable:process.execPath}),start=performance.now();let identity;
 try{await assert.rejects(runProviderDockerClient(client,[program,pidFile],{timeoutMs:300,maxOutputBytes:4096}),/deadline/);identity=JSON.parse(await readFile(pidFile,'utf8'));assert.ok(performance.now()-start<3000);}finally{if(identity===undefined){try{identity=JSON.parse(await readFile(pidFile,'utf8'));}catch{}}if(Number.isInteger(identity?.pid)&&identity.pid>0&&typeof identity.birth==='string'){try{if(await linuxProcessBirth(identity.pid)===identity.birth)process.kill(identity.pid,'SIGKILL');}catch(error){if(!['ESRCH','ENOENT'].includes(error.code))throw error;}}}
});
test('a real parent replacement during the domain await refuses and preserves the replacement sentinel',async t=>{
 const f=await fixture(t),owner=await f.open(),pending=f.getDomain(owner),service=join(f.root,'service'),retained=join(f.root,'retained-service');fsSync.renameSync(service,retained);fsSync.mkdirSync(service,{mode:0o700});fsSync.writeFileSync(join(service,'foreign-sentinel'),'preserve',{mode:0o600});await assert.rejects(pending,/identity changed/);owner.close();assert.equal(await readFile(join(service,'foreign-sentinel'),'utf8'),'preserve');assert.ok((await readFile(join(retained,'.writer.sqlite'))).byteLength>0);
});
test('reopening the public launcher with the same options takes a fresh client snapshot for that lifetime',async t=>{
 const f=await fixture(t),owner=await f.open();owner.close();const options={rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,user:'1000:1000',...f.options,dockerEnvironment:{...f.options.dockerEnvironment}};
 let launcher=await openDockerDeploymentRuntimeLauncher(options);await launcher.close();const before=(await f.commands()).length;options.dockerEnvironment.DAEMON='daemon_next_lifetime';launcher=await openDockerDeploymentRuntimeLauncher(options);await launcher.close();const commands=(await f.commands()).slice(before);assert.ok(commands.length>0);assert.ok(commands.every(command=>command.domain==='daemon_next_lifetime'));
});

function retainedTree(directory){return fsSync.readdirSync(directory).sort().flatMap(name=>{const path=join(directory,name),stat=fsSync.lstatSync(path);return [{path,mode:stat.mode&0o777,dev:stat.dev,ino:stat.ino,bytes:stat.isFile()?fsSync.readFileSync(path).toString('hex'):null},...(stat.isDirectory()?retainedTree(path):[])];});}
for(const target of ['root','service'])test('marked '+target+' permissions refuse without normalization or factory effects',async t=>{
 for(const mode of [0o750,0o500]){const f=await installed(t);f.owner.close();const directory=target==='root'?f.root:join(f.root,'service');await chmod(directory,mode);try{const before=retainedTree(f.directory),commands=await f.commands();let failure,service;try{service=await openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}});}catch(error){failure=error;}finally{await service?.close();}assert.ok(failure,'marked permission mismatch must refuse startup');assert.equal(fsSync.statSync(directory).mode&0o777,mode);assert.deepEqual(retainedTree(f.directory),before);assert.deepEqual(await f.commands(),commands);}finally{await chmod(directory,0o700);}}
});
test('unmarked root and service retain legacy permission normalization',async t=>{
 const f=await fixture(t),owner=await f.open();owner.close();await chmod(f.root,0o750);await chmod(join(f.root,'service'),0o750);const service=await openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}});try{assert.equal(fsSync.statSync(f.root).mode&0o777,0o700);assert.equal(fsSync.statSync(join(f.root,'service')).mode&0o777,0o700);}finally{await service.close();}
});
test('permission-drifted retained WAL refuses without changing absent or existing sidecars',async t=>{
 for(const kind of ['checkpointed','marker-existing-shm','marker-absent-shm','active']){
  const f=await installed(t);f.owner.close();const filename=join(f.root,'service','.writer.sqlite');let child,exit,timer;
  if(kind==='checkpointed'){const db=new DatabaseSync(filename);try{db.exec('PRAGMA journal_mode=WAL');}finally{db.close();}assert.equal(fsSync.existsSync(filename+'-wal'),false);assert.equal(fsSync.existsSync(filename+'-shm'),false);}
  else {
   const db=new DatabaseSync(filename);let marker;try{marker={sql:db.prepare("SELECT sql FROM sqlite_schema WHERE name='clank_provider_handoff_owner'").get().sql,values:Object.values(db.prepare('SELECT * FROM clank_provider_handoff_owner').get())};db.exec('DROP TABLE clank_provider_handoff_owner');}finally{db.close();}
   child=fork(new URL('./fixtures/provider-handoff-permissions.mjs',import.meta.url),[filename,kind==='active'?'active':'retained',JSON.stringify(marker)],{stdio:['ignore','pipe','pipe','ipc']});exit=once(child,'exit');let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-16384);});
   try{const message=await Promise.race([once(child,'message').then(([value])=>value),exit.then(value=>{throw new Error('WAL child exited '+JSON.stringify(value)+' '+output);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('WAL child timeout '+output)),10000);})]);assert.deepEqual(message,{ready:true,marker:true});if(kind!=='active'){child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL']);if(kind==='marker-absent-shm')fsSync.unlinkSync(filename+'-shm');}}catch(error){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}throw error;}finally{clearTimeout(timer);}
  }
  try{await chmod(join(f.root,'service'),0o750);const before=retainedTree(f.directory);await assert.rejects(openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}}));assert.deepEqual(retainedTree(f.directory),before);}finally{await chmod(join(f.root,'service'),0o700);if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL']);}}
 }
});
test('legacy WAL keeps private startup while uncertain permission repair refuses unchanged',async t=>{
 const f=await fixture(t),owner=await f.open();owner.close();const filename=join(f.root,'service','.writer.sqlite'),db=new DatabaseSync(filename);try{db.exec('PRAGMA journal_mode=WAL');}finally{db.close();}await chmod(f.root,0o750);const before=retainedTree(f.directory);await assert.rejects(f.open());assert.deepEqual(retainedTree(f.directory),before);await chmod(f.root,0o700);const service=await openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-original',image:'example.invalid/app@sha256:'+digest,docker:{...f.options,user:'1000:1000'}});await service.close();
});
test('permission inspection never repairs malformed state or bypasses an active native owner',async t=>{
 for(const mode of ['malformed','locked']){const f=await fixture(t),owner=await f.open();if(mode==='malformed'){owner.close();fsSync.writeFileSync(join(f.root,'service','.writer.sqlite'),'not-sqlite',{mode:0o600});}await chmod(join(f.root,'service'),0o750);const before=retainedTree(f.directory);await assert.rejects(f.open());assert.deepEqual(retainedTree(f.directory),before);await chmod(join(f.root,'service'),0o700);owner.close();}
});
