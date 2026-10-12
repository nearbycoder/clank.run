import net from 'node:net';
import {createSourceWorkerClientProtocol} from '../../dist/provider-source-worker-wire.js';
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
const nonce=randomUUID(),directory=fs.mkdtempSync('/tmp/clank-container-native-'),root=join(directory,'provider'),source=join(directory,'capsule'),image=process.argv[2],mode=process.argv[3]??'mount';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.match(image,/^sha256:[a-f0-9]{64}$/);fs.chmodSync(directory,0o755);
const config=join(directory,'docker-config');fs.mkdirSync(config,{mode:0o700});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
const command=(args)=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const events={qualification:'Genuine owner/domain/grant, native data-store commit and C1 acknowledgments, running immutable default-profile container. Original issued-grant channel and fourth read-only mount admission. Authenticated dispatch cases use a host-process client and genuine provider workers; no original application capture/bootstrap, readiness, stop certificate or full feature07 acceptance is claimed.',version:process.version,nonce,directory,image,mode};
let owner,grant,data,container,worker,channel,wireClient,cid,labels,stage='prepare',failed;
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
 channel=await h.prepareProviderSourceWorkerChannel(bridge,{projectId:project.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,expectedVersion:2},key);events.channelMount=channel.mountSource;
 labels={'run.clank.managed':'provider-runtime','run.clank.owner':domain.owner,'run.clank.project':binding.projectId,'run.clank.release':binding.releaseId,'run.clank.generation':'1','run.clank.role':'web','run.clank.instance':'0','run.clank.handoff.protocol':binding.protocol,'run.clank.handoff.node':domain.nodeId,'run.clank.handoff.daemon':domain.daemonId,'run.clank.handoff.domain':binding.domainSha256,'run.clank.handoff.enablement':binding.enablementId,'run.clank.handoff.index':binding.indexId,'run.clank.handoff.catalog':binding.catalogId,'run.clank.handoff.grant':binding.grantId,'run.clank.handoff.binding':issued.bindingSha256,'run.clank.handoff.capsule':binding.capsuleSha256,'run.clank.handoff.incarnation':binding.sourceIncarnation};
 const args=['container','create','--name','clank-container-native-'+nonce,'--interactive','--pull','never','--restart','no','--read-only','--init','--cap-drop','ALL','--security-opt','no-new-privileges=true','--pids-limit','128','--memory','512m','--memory-swap','512m','--cpus','1','--user','1000:1000','--network','bridge','--stop-timeout','2','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--tmpfs','/run:rw,noexec,nosuid,nodev,size=8m,mode=755','--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=3'];
 for(const [k,v] of Object.entries(labels))args.push('--label',k+'='+v);
 let channelMount=channel.mountSource;if(mode==='foreign-mount'){channelMount=join(directory,'unapproved-channel');fs.mkdirSync(channelMount,{mode:0o700});}
 args.push('--mount','type=bind,source='+channelMount+',target=/run/clank-source-worker'+(mode==='writable-mount'?'':',readonly'));
 args.push('--mount','type=bind,source='+prepared.releaseDirectory+',target=/app,readonly','--mount','type=bind,source='+join(root,'projects',project.projectId,'data')+',target=/data','--mount','type=bind,source='+join(root,'service','handoff','catalogs',project.catalogId)+',target=/run/clank-source,readonly','--workdir','/app',image,'node','dist/server.js');
 stage='create';cid=(await command(args)).stdout.trim();assert.match(cid,/^[a-f0-9]{64}$/);events.containerId=cid;
 const input={projectId:project.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,containerId:cid,expectedVersion:2};
 stage='created acknowledgment';events.created=await h.recordProviderHandoffContainerCreated(bridge,input);events.channelBinding=await channel.bindCreated({...input,expectedVersion:3});wireClient=createSourceWorkerClientProtocol(key,events.channelBinding);await command(['container','start',cid]);
 stage='started acknowledgment';events.started=await h.recordProviderHandoffContainerStarted(bridge,{...input,expectedVersion:3});
 grant=await h.retainProviderSourceGrant(bridge,{...input,expectedVersion:4},key);key.fill(0);data=await h.retainProviderSourceRuntimeData(grant);events.pinCountBefore=pins().length;events.descriptorsBefore=descriptors();
 events.inspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];stage='channel mount admission';
 if(['writable-mount','foreign-mount'].includes(mode)){
  await assert.rejects(h.retainProviderSourceContainer(data),/mount topology/);events.expectedMountRefusal=true;
 }else{
  container=await h.retainProviderSourceContainer(data);container.assertCurrent();for(let i=0;i<5;i++)await container.verifyCurrent();
  const added=descriptors().filter(v=>!events.descriptorsBefore.some(w=>JSON.stringify(w)===JSON.stringify(v)));assert.equal(added.length,7);events.admitted={pid:container.pid,birth:container.birth,descriptorDelta:added.length};
  events.independentMountinfo=fs.readFileSync('/proc/'+container.pid+'/mountinfo','utf8');
  const host=fs.lstatSync(channel.mountSource),mounted=fs.statSync('/proc/'+container.pid+'/root/run/clank-source-worker');assert.equal(mounted.dev,host.dev);assert.equal(mounted.ino,host.ino);events.channelInode={dev:host.dev,ino:host.ino};
  const probe=await command(['container','exec',cid,'node','--input-type=module','--eval',"import fs from 'node:fs';const p='/run/clank-source-worker/sqlite.sock';const s=fs.lstatSync(p);let code;try{fs.unlinkSync(p);}catch(e){code=e.code;}process.stdout.write(JSON.stringify({socket:s.isSocket(),mode:s.mode&511,code})+'\\n');"]);
  events.nativeReadOnlyProbe=JSON.parse(probe.stdout);assert.deepEqual(events.nativeReadOnlyProbe,{socket:true,mode:384,code:'EROFS'});
  if(['dispatch','bad-auth','disconnect'].includes(mode)){
   const parent=dirname(data.databasePath),recovery=join(parent,'.clank-source-recovery-'+binding.sourceIncarnation),base=join(recovery,'base'),id='bk_'+Date.now()+'_abcdefghijklmnopqrstuvwx';for(const path of [recovery,base,join(base,'.stage-'+id)])fs.mkdirSync(path,{mode:0o700});
   let owned,workerClosed=false,heldResolve;const held=new Promise(resolve=>heldResolve=resolve),originalSpawn=cp.spawn,spawns=[];
   cp.spawn=(executable,args,options)=>{const child=originalSpawn(executable,args,options);if(executable==='/usr/bin/setpriv'&&args.includes('/usr/bin/bwrap')){spawns.push({executable,args,environmentNames:Object.keys(options.env)});if(mode==='disconnect'){owned=child;child.once('close',()=>workerClosed=true);child.stdin.end=()=>{heldResolve();return child.stdin;};}}return child;};syncBuiltinESMExports();
   const trusted=await createSQLiteTaskScope('trusted-process'),before=fs.readFileSync(data.databasePath),dispatch=trusted.run(()=>channel.dispatch(container));dispatch.catch(()=>{});await assert.rejects(channel.dispatch(container),/consumed/);
   const mountFd=fs.openSync(channel.mountSource,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW),socket=net.createConnection('/proc/self/fd/'+mountFd+'/sqlite.sock');socket.on('error',()=>{});
   const response=()=>new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);const onData=chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>8193){reject(Error('response bound'));return;}const end=bytes.indexOf(10);if(end!==-1){socket.off('data',onData);resolve(bytes.subarray(0,end).toString('utf8'));}};socket.on('data',onData);socket.once('error',reject);socket.once('close',()=>reject(Error('channel closed')));});
   try{
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
    if(mode==='disconnect'){
     socket.write(wireClient.begin({protocol:'clank-source-sqlite-task/1',operation:'backup',backupId:id,temporaryId:randomUUID()})+'\n');await held;const beforeClose=Date.now();socket.destroy();await assert.rejects(dispatch);await channel.close();assert.equal(workerClosed,true);assert.equal(owned.signalCode,'SIGKILL');assert.equal(fs.existsSync('/proc/'+owned.pid),false);assert.ok(Date.now()-beforeClose<2000);events.disconnectedWorker={pid:owned.pid,signal:owned.signalCode,elapsedMs:Date.now()-beforeClose};
    }else if(mode==='bad-auth'){
     const frame=JSON.parse(wireClient.begin({protocol:'clank-source-sqlite-task/1',operation:'backup',backupId:id,temporaryId:randomUUID()})),reply=response(),rejected=assert.rejects(reply,/closed/);frame.mac='0'.repeat(64);socket.write(JSON.stringify(frame)+'\n');await rejected;await assert.rejects(dispatch,/protocol/);events.authenticationRefused=true;assert.equal(spawns.length,0);
    }else{
     const temporaryId=randomUUID(),snapshot=join(base,'.snapshot-'+id+'.sqlite');
     for(const operation of ['backup','inspect','verify']){
      const encoded=wireClient.begin({protocol:'clank-source-sqlite-task/1',operation,backupId:id,temporaryId:operation==='backup'?temporaryId:null}),reply=response();socket.write(encoded+'\n');const result=wireClient.finish(await reply);
      if(operation==='backup'){const temporary=snapshot+'.tmp-'+temporaryId;assert.equal(fs.existsSync(snapshot),false);assert.equal(fs.existsSync(temporary),true);fs.linkSync(temporary,snapshot);fs.unlinkSync(temporary);}
      if(operation==='inspect'){events.inspection=result;fs.copyFileSync(snapshot,join(base,'.verified-'+id+'.sqlite'));fs.chmodSync(join(base,'.verified-'+id+'.sqlite'),0o600);}
     }
     await dispatch;assert.equal(spawns.length,3);for(const spawn of spawns){assert.ok(spawn.args.includes('--unshare-all'));assert.deepEqual(spawn.environmentNames,['NODE_NO_WARNINGS']);}events.workerSpawns=spawns;events.authenticatedOperations=3;const db=new DatabaseSync(snapshot,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM seed').get().value,'approved source');}finally{db.close();}
    }
    assert.deepEqual(fs.readFileSync(data.databasePath),before);events.sourceBytesUnchanged=true;
   }finally{cp.spawn=originalSpawn;syncBuiltinESMExports();socket.destroy();fs.closeSync(mountFd);wireClient.close();await channel.close();}
   assert.deepEqual(pins().filter(p=>p.path===recovery||p.path===base||p.path.startsWith(base+'/')),[]);
  }else if(mode==='mount-replaced'){
   fs.renameSync(channel.mountSource,channel.mountSource+'.retained');fs.mkdirSync(channel.mountSource,{mode:0o700});fs.writeFileSync(join(channel.mountSource,'unknown'),'retained replacement');assert.throws(()=>container.assertCurrent());await channel.close();assert.equal(fs.readFileSync(join(channel.mountSource,'unknown'),'utf8'),'retained replacement');events.replacementRefused=true;
  }else if(mode==='grant-close'){
   grant.close();assert.throws(()=>channel.assertCurrent());await channel.close();assert.equal(fs.existsSync(join(channel.mountSource,'sqlite.sock')),false);events.linkedGrantClose=true;
  }else{assert.equal(mode,'mount');container.close();await channel.close();}
 }
 await channel.close();container?.close();data.close();grant.close();owner.close();assert.equal(pins().length,0);events.pinsReleased=true;events.complete=true;
}catch(e){failed=e;events.complete=false;events.failure={stage,name:e.name,message:e.message,stack:e.stack};}
finally{
 if(failed&&cid)try{events.failureInspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];}catch(e){events.failureInspectError=e.message;}
 try{wireClient?.close();await channel?.close();await worker?.close();container?.close();data?.close();grant?.close();owner?.close();}catch(e){events.cleanupError=e.message;failed??=e;}
 if(cid){try{const v=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(v.Id,cid);assert.equal(v.Image,image);assert.deepEqual(v.Config.Labels,labels);if(v.State.Paused)await command(['container','unpause',cid]);if(v.State.Running)await command(['container','stop','--time','2',cid]);const final=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(final.Id,cid);assert.deepEqual(final.Config.Labels,labels);assert.equal(final.State.Running,false);events.finalState=final.State;await command(['container','rm',cid]);assert.equal((await command(['container','ls','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}'])).stdout.trim(),'');events.cleanup={removed:true,absence:true};}catch(e){events.cleanupError=e.message;failed??=e;}}
 fs.writeFileSync(join(directory,'evidence.json'),JSON.stringify(events,null,2)+'\n');console.log(JSON.stringify(events));
}
if(failed)process.exitCode=1;
