import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import * as h from '../../dist/provider-handoff.js';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createSQLiteTaskScope,runSQLiteTask,SQLiteTaskScheduler} from '../../dist/sqlite-task.js';
import {DatabaseSync} from 'node:sqlite';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {openDeploymentProviderDataStore} from '../../dist/provider-data.js';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
const hash=v=>createHash('sha256').update(typeof v==='string'||v instanceof Uint8Array?v:JSON.stringify(v)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const nonce=randomUUID(),directory=fs.mkdtempSync('/tmp/clank-container-native-'),root=join(directory,'provider'),source=join(directory,'capsule'),image=process.argv[2],mode=process.argv[3]??'pipeline';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.match(image,/^sha256:[a-f0-9]{64}$/);fs.chmodSync(directory,0o755);
const config=join(directory,'docker-config');fs.mkdirSync(config,{mode:0o700});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
const command=(args)=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const events={qualification:'Genuine owner/domain/grant, native data-store commit and C1 acknowledgments, running immutable default-profile container. Native provider-derived fixed host workers; application capture/bootstrap, readiness, stop certificate and full feature07 acceptance remain unproved.',version:process.version,nonce,directory,image,mode};
let owner,grant,data,container,worker,cid,labels,stage='prepare',failed;
const descriptors=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const stat=fs.fstatSync(Number(fd));return [{fd:Number(fd),path:fs.readlinkSync('/proc/self/fd/'+fd),dev:stat.dev,ino:stat.ino}];}catch{return [];}});
const pins=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root+'/')?[{fd:Number(fd),path}]:[];}catch{return [];}});
try{
 fs.mkdirSync(source);fs.mkdirSync(join(source,'dist'));fs.mkdirSync(join(source,'migrations'));
 fs.writeFileSync(join(source,'dist','server.js'),'setInterval(()=>{},1000);\n');fs.writeFileSync(join(source,'migrations','0001_seed.sql'),"CREATE TABLE seed(value TEXT); INSERT INTO seed VALUES('approved source');\n");
 const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'source.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:15000},env:{}},{frameworkVersion:'0.9.4-test',nodeVersion:process.version.slice(1)});
 const runtime=await createDeploymentRuntimeCapsule({projectId:'native_project',releaseId:'native_release',generation:1,environment:{},database:{path:'source.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/native_project',token:'clanki_native-test-token-12345678901234567890'},artifact},{maxDatabaseBytes:16777216});
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,client,'native_node','native_owner_'+nonce),identity=await h.initializeProviderHandoff(owner,domain),project=await h.installProviderHandoffProject(owner,domain,'native_project'),bridge=await h.enableProviderHandoffBridge(owner,domain,limits);
 const store=await openDeploymentProviderDataStore({rootDirectory:root,maxDatabaseBytes:16777216});let prepared;
 await store.apply({operation:{id:'native_operation',projectId:project.projectId,fence:1,attempt:1,maxAttempts:3},desired:{generation:1,releaseId:'native_release',state:'running',runtimeProtocol:'clank-runtime/1'},runtime,signal:new AbortController().signal},v=>{prepared=v;});
 const key=randomBytes(32),binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:project.projectId,releaseId:'native_release',generation:1,capsuleSha256:runtime.sha256,sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:image,uid:1000,gid:1000,capture:{keyId:'native_key',keySha256:hash(randomBytes(32)),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
 const issued=await h.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:hash(randomBytes(32)),controlSecretSha256:hash(key)});
 labels={'run.clank.managed':'provider-runtime','run.clank.owner':domain.owner,'run.clank.project':binding.projectId,'run.clank.release':binding.releaseId,'run.clank.generation':'1','run.clank.role':'web','run.clank.instance':'0','run.clank.handoff.protocol':binding.protocol,'run.clank.handoff.node':domain.nodeId,'run.clank.handoff.daemon':domain.daemonId,'run.clank.handoff.domain':binding.domainSha256,'run.clank.handoff.enablement':binding.enablementId,'run.clank.handoff.index':binding.indexId,'run.clank.handoff.catalog':binding.catalogId,'run.clank.handoff.grant':binding.grantId,'run.clank.handoff.binding':issued.bindingSha256,'run.clank.handoff.capsule':binding.capsuleSha256,'run.clank.handoff.incarnation':binding.sourceIncarnation};
 const args=['container','create','--name','clank-container-native-'+nonce,'--interactive','--pull','never','--restart','no','--read-only','--init','--cap-drop','ALL','--security-opt','no-new-privileges=true','--pids-limit','128','--memory','512m','--memory-swap','512m','--cpus','1','--user','1000:1000','--network','bridge','--stop-timeout','2','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--tmpfs','/run:rw,noexec,nosuid,nodev,size=8m,mode=755','--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=3'];
 for(const [k,v] of Object.entries(labels))args.push('--label',k+'='+v);
 args.push('--mount','type=bind,source='+prepared.releaseDirectory+',target=/app,readonly','--mount','type=bind,source='+join(root,'projects',project.projectId,'data')+',target=/data','--mount','type=bind,source='+join(root,'service','handoff','catalogs',project.catalogId)+',target=/run/clank-source,readonly','--workdir','/app',image,'node','dist/server.js');
 stage='create';cid=(await command(args)).stdout.trim();assert.match(cid,/^[a-f0-9]{64}$/);events.containerId=cid;
 const input={projectId:project.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,containerId:cid,expectedVersion:2};
 stage='created acknowledgment';events.created=await h.recordProviderHandoffContainerCreated(bridge,input);await command(['container','start',cid]);
 stage='started acknowledgment';events.started=await h.recordProviderHandoffContainerStarted(bridge,{...input,expectedVersion:3});
 grant=await h.retainProviderSourceGrant(bridge,{...input,expectedVersion:4},key);key.fill(0);data=await h.retainProviderSourceRuntimeData(grant);events.pinCountBefore=pins().length;events.descriptorsBefore=descriptors();
 events.inspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];events.projectedHost=JSON.parse((await command(['container','inspect','--format','{{json .HostConfig}}',cid])).stdout);stage='container admission';container=await h.retainProviderSourceContainer(data);container.assertCurrent();h.assertProviderSourceContainerLease(container);for(let i=0;i<12;i++)await container.verifyCurrent();events.descriptorsAdmitted=descriptors();const added=events.descriptorsAdmitted.filter(v=>!events.descriptorsBefore.some(w=>JSON.stringify(w)===JSON.stringify(v)));assert.equal(added.length,7);events.admitted={pid:container.pid,birth:container.birth,pinDelta:pins().length-events.pinCountBefore};
 const pid=container.pid;events.independent={stat:fs.readFileSync('/proc/'+pid+'/stat','utf8'),status:fs.readFileSync('/proc/'+pid+'/status','utf8'),cgroup:fs.readFileSync('/proc/'+pid+'/cgroup','utf8'),mountinfo:fs.readFileSync('/proc/'+pid+'/mountinfo','utf8'),apparmor:fs.readFileSync('/proc/'+pid+'/attr/current','utf8'),namespaces:Object.fromEntries(['mnt','pid','net','ipc','cgroup','user'].map(n=>[n,[fs.readlinkSync('/proc/'+pid+'/ns/'+n),fs.readlinkSync('/proc/self/ns/'+n)]]))};
 const originalDatabase=fs.readFileSync(data.databasePath);
 stage='worker authority';
 let getters=0;for(const candidate of [{...container},{},new Proxy({}, {get(){getters++;throw Error('getter');}})])await assert.rejects(h.retainProviderSourceWorker(candidate),/genuine/);assert.equal(getters,0);
 worker=await h.retainProviderSourceWorker(container);h.assertProviderSourceWorkerLease(worker);assert.throws(()=>h.assertProviderSourceWorkerLease({...worker}),/genuine/);await assert.rejects(h.retainProviderSourceWorker(container),/duplicated|recycled/);
 const parent=dirname(data.databasePath),recovery=join(parent,'.clank-source-recovery-'+grant.binding.sourceIncarnation),base=join(recovery,'base'),id='bk_'+Date.now()+'_abcdefghijklmnopqrstuvwx';
 for(const path of [recovery,base,join(base,'.stage-'+id)])fs.mkdirSync(path,{mode:0o700});
 const request=Object.freeze({protocol:'clank-source-sqlite-task/1',operation:'backup',backupId:id,temporaryId:randomUUID()}),snapshot=join(base,'.snapshot-'+id+'.sqlite');
 const originalSpawn=cp.spawn;let owned,closed=false,heldResolve;const ordinaryInputs=[],ordinaryChildren=[],ordinaryTasks=[];const held=new Promise(resolve=>heldResolve=resolve),seen=[];
 cp.spawn=(executable,args,options)=>{const child=originalSpawn(executable,args,options);if(executable==='/usr/bin/setpriv'&&args.includes('/usr/bin/bwrap')){seen.push({executable,args,environmentNames:Object.keys(options.env)});if(mode==='queue'&&seen.length<=2){ordinaryChildren.push(child);const end=child.stdin.end.bind(child.stdin);child.stdin.end=(...args)=>{ordinaryInputs.push(()=>end(...args));return child.stdin;};}if(['close','replace','data-close','revocation','stop','deadline'].includes(mode)){owned=child;child.once('close',()=>closed=true);if(mode==='deadline'){const on=child.on;child.on=function(event,handler){return on.call(this,event,event==='close'?(...args)=>setTimeout(()=>handler(...args),12000):handler);};}child.stdin.end=()=>{heldResolve();return child.stdin;};}}return child;};syncBuiltinESMExports();
 try{
  if(mode==='scope'){
   await assert.rejects(worker.execute({...request,path:'/tmp/unapproved.sqlite'}),/protocol/);assert.equal(seen.length,0);assert.throws(()=>worker.assertCurrent());await worker.close();
  }else if(mode==='pipeline'){
   const trusted=await createSQLiteTaskScope('trusted-process');await trusted.run(()=>worker.execute(request));
   assert.equal(seen.length,1);assert.equal(seen[0].executable,'/usr/bin/setpriv');assert.ok(seen[0].args.includes('--unshare-all'));assert.ok(seen[0].args.includes('--cap-drop'));assert.deepEqual(seen[0].environmentNames.sort(),['NODE_NO_WARNINGS']);
   const temporary=snapshot+'.tmp-'+request.temporaryId;assert.equal(fs.existsSync(snapshot),false);assert.equal(fs.existsSync(temporary),true);worker.assertCurrent();fs.linkSync(temporary,snapshot);fs.unlinkSync(temporary);worker.assertCurrent();
   const db=new DatabaseSync(snapshot,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM seed').get().value,'approved source');}finally{db.close();}
   events.inspection=await trusted.run(()=>worker.execute({...request,operation:'inspect',temporaryId:null}));
   fs.copyFileSync(snapshot,join(base,'.verified-'+id+'.sqlite'));fs.chmodSync(join(base,'.verified-'+id+'.sqlite'),0o600);
   await trusted.run(()=>worker.execute({...request,operation:'verify',temporaryId:null}));assert.equal(seen.length,3);assert.throws(()=>worker.assertCurrent());await worker.close();
  }else if(mode==='idle-close'){
   await worker.execute(request);assert.equal(pins().filter(p=>p.path===recovery||p.path===base||p.path===join(base,'.stage-'+id)).length,3);data.close();await worker.close();assert.throws(()=>worker.assertCurrent());events.idlePinsReleased=true;
  }else if(mode==='between'){
   await worker.execute(request);const temporary=snapshot+'.tmp-'+request.temporaryId;fs.linkSync(temporary,snapshot);fs.unlinkSync(temporary);
   fs.renameSync(base,base+'.retained');fs.mkdirSync(base,{mode:0o700});fs.mkdirSync(join(base,'.stage-'+id),{mode:0o700});fs.copyFileSync(join(base+'.retained','.snapshot-'+id+'.sqlite'),snapshot);fs.chmodSync(snapshot,0o600);
   await assert.rejects(worker.execute({...request,operation:'inspect',temporaryId:null}),/workspace changed/);await worker.close();events.betweenOperationsRefused=true;
  }else if(mode==='queue'){
   const acquire=SQLiteTaskScheduler.prototype.acquire;let admissions=0;SQLiteTaskScheduler.prototype.acquire=function(...args){const pending=acquire.apply(this,args);admissions++;if(admissions===3)heldResolve();return pending;};
   try{
    for(let n=0;n<2;n++){const ordinaryDirectory=join(directory,'ordinary-'+n);fs.mkdirSync(ordinaryDirectory,{mode:0o700});const path=join(ordinaryDirectory,'data.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE record(value TEXT)');db.close();ordinaryTasks.push(runSQLiteTask('inspection','inspectSQLite',[path]));}
    const until=Date.now()+5000;while(ordinaryInputs.length!==2){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,5));}
    const pending=worker.execute(request);pending.catch(()=>{});await held;assert.equal(seen.length,2);const closing=worker.close();closing.catch(()=>{});await assert.rejects(pending,/closed/);await assert.rejects(closing,/closed/);assert.equal(seen.length,2);
    for(const child of ordinaryChildren)assert.equal(fs.existsSync('/proc/'+child.pid),true);for(const send of ordinaryInputs)send();await Promise.all(ordinaryTasks);await runSQLiteTask('inspection','inspectSQLite',[data.databasePath]);assert.equal(seen.length,3);
   }finally{SQLiteTaskScheduler.prototype.acquire=acquire;}
  }else if(mode==='deadline'){
   const pending=worker.execute(request);pending.catch(()=>{});await held;const before=performance.now();await assert.rejects(worker.close(),/unsettled.*10000ms/);const elapsed=performance.now()-before;assert.ok(elapsed>=9900&&elapsed<11500);assert.equal(closed,true);assert.equal(fs.existsSync('/proc/'+owned.pid),false);
   const retained=pins().filter(p=>p.path===recovery||p.path===base||p.path===join(base,'.stage-'+id));assert.equal(retained.length,3,'timed-out close must retain owned operation pins');await assert.rejects(h.retainProviderSourceWorker(container),/duplicated|recycled/);await assert.rejects(pending,/closed/);await worker.close();events.closeDeadline={elapsedMs:elapsed,retainedPins:retained.length,injectedCloseObservationDelayMs:12000,qualification:'Actual child is killed; its framework close callback is deliberately held. No kernel-stall or host certificate claim.'};
  }else if(['close','replace','data-close','revocation','stop'].includes(mode)){
   const pending=worker.execute(request);pending.catch(()=>{});await held;assert.ok(owned.pid>0);
   if(mode==='replace'){fs.renameSync(base,base+'.retained');fs.mkdirSync(base,{mode:0o700});}
   else if(mode==='data-close')data.close();
   else if(mode==='revocation')await h.revokeProviderHandoffGrant(bridge,{...input,expectedVersion:4});
   else if(mode==='stop')await command(['container','stop','--time','2',cid]);
   const before=Date.now(),closing=worker.close();closing.catch(()=>{});await assert.rejects(pending);let closeFailure;await closing.catch(error=>closeFailure=error);if(closeFailure)assert.doesNotMatch(closeFailure.message,/unsettled|cleanup is uncertain/);assert.equal(closed,true);assert.equal(fs.existsSync('/proc/'+owned.pid),false);assert.equal(owned.signalCode,'SIGKILL');assert.ok(Date.now()-before<2000);events.workerClosed={pid:owned.pid,signal:owned.signalCode,elapsedMs:Date.now()-before};
  }else throw Error('Unknown native worker case');
  const heldDirs=pins().filter(p=>p.path===recovery||p.path===base||p.path.startsWith(base+'/')||p.path.startsWith(base+'.retained'));assert.deepEqual(heldDirs,[]);
  assert.deepEqual(fs.readFileSync(data.databasePath),originalDatabase);events.worker={spawns:seen.length,mode,sourceBytesUnchanged:true,qualification:'Default native Bubblewrap execution and owned ChildProcess close. Worker descendant namespaces are not independently sampled; no host certificate.'};
 }finally{cp.spawn=originalSpawn;syncBuiltinESMExports();}
 container.close();data.close();grant.close();owner.close();assert.equal(pins().length,0);events.pinsReleased=true;events.complete=true;
}catch(e){failed=e;events.complete=false;events.failure={stage,name:e.name,message:e.message,stack:e.stack};}
finally{
 if(failed&&cid)try{events.failureInspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];}catch(e){events.failureInspectError=e.message;}
 try{await worker?.close();container?.close();data?.close();grant?.close();owner?.close();}catch(e){events.cleanupError=e.message;failed??=e;}
 if(cid){try{const v=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(v.Id,cid);assert.equal(v.Image,image);assert.deepEqual(v.Config.Labels,labels);if(v.State.Paused)await command(['container','unpause',cid]);if(v.State.Running)await command(['container','stop','--time','2',cid]);const final=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(final.Id,cid);assert.deepEqual(final.Config.Labels,labels);assert.equal(final.State.Running,false);events.finalState=final.State;await command(['container','rm',cid]);assert.equal((await command(['container','ls','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}'])).stdout.trim(),'');events.cleanup={removed:true,absence:true};}catch(e){events.cleanupError=e.message;failed??=e;}}
 fs.writeFileSync(join(directory,'evidence.json'),JSON.stringify(events,null,2)+'\n');console.log(JSON.stringify(events));
}
if(failed)process.exitCode=1;
