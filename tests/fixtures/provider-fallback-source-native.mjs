// Opt-in cohesive ordinary-provider fallback fixture. Execute only on the approved native host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {recoverNativeFallbackCheckpoint} from './provider-fallback-recovery-native.mjs';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
import {transferDockerProviderFallback} from '../../dist/provider-fallback-coordinator.js';
import {serve} from '../../dist/node.js';
import {openNativePlatformAPI} from './provider-platform-api-native.mjs';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
if(process.argv[2]==='--recover'){
 let proof;try{proof=await recoverNativeFallbackCheckpoint(process.argv[3]);}catch(error){proof=error.proof??{complete:false,failure:error.message};process.exitCode=1;}
 // Complete the pipe write before exiting; deadline sample reports can exceed 64KiB.
 await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(proof)+'\n',error=>error?reject(error):resolve()));
 process.exit(process.exitCode??0);
}
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const mode=process.argv[3]??'normal';assert.ok(['normal','product-normal','commit-loss','controller-loss-before','controller-loss-after','controller-stall','reservation-loss-after','controller-loss-stopping','controller-loss-stopped','controller-loss-launching','controller-loss-source-stop','controller-loss-partial-target'].includes(mode));
const normalMode=mode==='normal'||mode==='product-normal';
const image=process.argv[2];assert.match(image,/@sha256:[a-f0-9]{64}$/u);
const directory=fs.mkdtempSync('/var/tmp/clank-fallback-source-'),root=join(directory,'provider'),targetRoot=join(directory,'target'),source=join(directory,'source'),configDirectory=join(directory,'docker-config');
for(const path of [source,join(source,'dist'),join(source,'migrations'),configDirectory])fs.mkdirSync(path,{mode:0o700});
fs.writeFileSync(join(source,'migrations','0001_seed.sql'),'CREATE TABLE entries(id INTEGER PRIMARY KEY,role TEXT NOT NULL,value TEXT NOT NULL,host TEXT NOT NULL);');
const shared=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);db.exec('PRAGMA busy_timeout=5000');const write=(role,value)=>db.prepare('INSERT INTO entries(role,value,host) VALUES(?,?,?)').run(role,value,process.env.HOSTNAME);`;
fs.writeFileSync(join(source,'dist','server.js'),shared+`import http from 'node:http';const server=http.createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}if(req.url==='/write'){write('web',process.env.MULTILINE);res.end('written');return;}res.end(JSON.stringify(db.prepare('SELECT id,role,value,host FROM entries ORDER BY id').all()));});server.listen(Number(process.env.PORT),'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));`);
fs.writeFileSync(join(source,'dist','jobs.js'),shared+`
// Serial real writes retain the original five-second budget under SQLite contention.
db.exec('PRAGMA busy_timeout=50');let stopped=false,sequence=0;const role=process.env.CLANK_PROCESS_ROLE;
process.on('SIGTERM',()=>{stopped=true;});
const commit=async value=>{const deadline=performance.now()+5000;let attempts=0,lastError;const fatal=error=>{console.error(JSON.stringify({role,host:process.env.HOSTNAME,pid:process.pid,sequence,attempts,code:error.code,errcode:error.errcode,errstr:error.errstr,stack:error.stack}));throw error;};while(!stopped){const remaining=deadline-performance.now();if(remaining<=0)fatal(lastError??new Error('Fixture write budget expired.'));db.exec('PRAGMA busy_timeout='+Math.max(1,Math.min(50,Math.floor(remaining))));attempts++;try{write(role,value);sequence++;return;}catch(error){if(error.code!=='ERR_SQLITE_ERROR'||error.errcode!==5||performance.now()>=deadline)fatal(error);lastError=error;await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(deadline-performance.now(),5+Math.floor(Math.random()*20)))));}}};
try{await commit(process.env.MULTILINE);while(!stopped){await new Promise(resolve=>setTimeout(resolve,50));if(!stopped)await commit('tick');}}finally{db.close();}
`);
const label='fallback_'+randomUUID(),targetLabel=label+'_target',client=providerDockerClient({dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory}});
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const key=randomBytes(32),keyPath=join(directory,'master.key');fs.writeFileSync(keyPath,key,{mode:0o600});
const proof={directory,mode,version:process.version,qualification:'Real platform HTTP registration/release and runner capsule acquisition, original native platform reservation, ordinary four-role source/target, final snapshot and fresh runner API publication. Native acceptance is reported only after this fixture succeeds.',complete:false};
let service,target,api,sourceServer,targetServer,failure,cloneSource,cloneTarget,lastSourceProbe;
const request=runtime=>({operation:{id:'native_'+runtime.manifest.projectId,projectId:runtime.manifest.projectId,fence:1,attempt:1,maxAttempts:3},desired:{state:'running',releaseId:runtime.manifest.releaseId,generation:1,runtimeProtocol:'clank-runtime/1'},artifact:runtime.artifact,runtime,signal:new AbortController().signal});
const unrelatedRequest=async(runtime,path)=>{const response=await service.handle(new Request('http://provider.test'+runtime.manifest.ingress.route+path,{headers:{'x-clank-project-id':runtime.manifest.projectId,'x-clank-runtime-protocol':'clank-runtime/1','x-clank-runtime-generation':'1','x-clank-runtime-ingress':runtime.manifest.ingress.token}}));await response.arrayBuffer();return response;};
const publicRequest=path=>api.runtime.handle(new Request('http://native-platform.apps.example.test'+path));
const inventory=async(owner,project)=>((await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--filter','label=run.clank.project='+project,'--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean)).sort();
const nativeBirth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
const inspectRoles=async(record)=>{
 const ids=await inventory(record.owner,record.projectId);assert.deepEqual(ids,record.roles.map(role=>role.containerId).sort());
 const observed=[];
 for(const role of record.roles){
  const rows=JSON.parse((await command(['container','inspect',role.containerId])).stdout);assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.Id,role.containerId);assert.equal(row.State.Running,true);assert.equal(row.State.Status,'running');assert.equal(row.State.Pid,role.pid);assert.equal(nativeBirth(role.pid),role.birth);
  assert.equal(fs.readFileSync('/proc/'+role.pid+'/cgroup','utf8').trim(),'0::'+role.cgroup.slice('/sys/fs/cgroup'.length));assert.ok(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim().split('\n').includes(String(role.pid)));
  assert.equal(row.HostConfig.Memory,384*1024*1024);assert.equal(row.HostConfig.NanoCpus,500000000);assert.equal(row.HostConfig.PidsLimit,96);assert.equal(row.Config.User,'1000:1000');assert.equal(row.HostConfig.Privileged,false);assert.ok(row.HostConfig.CapDrop.includes('ALL'));assert.ok(row.HostConfig.SecurityOpt.includes('no-new-privileges=true')||row.HostConfig.SecurityOpt.includes('no-new-privileges'));assert.equal(row.AppArmorProfile,'docker-default');
assert.equal(row.Config.Labels['run.clank.role'],role.role);assert.equal(Number(row.Config.Labels['run.clank.instance']),role.instance);assert.equal(row.Image,record.imageId);
  observed.push({role:role.role,instance:role.instance,containerId:row.Id,pid:row.State.Pid,birth:nativeBirth(row.State.Pid),host:row.Config.Hostname,memory:row.HostConfig.Memory,nanoCpus:row.HostConfig.NanoCpus,pidsLimit:row.HostConfig.PidsLimit});
 }
 return observed;
};
const proveAbsent=async(record)=>{
 assert.deepEqual(await inventory(record.owner,record.projectId),[]);
 for(const role of record.roles){try{assert.notEqual(nativeBirth(role.pid),role.birth);}catch(error){if(error.code!=='ENOENT')throw error;}try{assert.equal(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim(),'');}catch(error){if(error.code!=='ENOENT')throw error;}}
};

try {
 const baseConfig={version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/health',timeoutMs:15000},env:{MULTILINE:'line one\nline two'}};
 const bundle=jobs=>createDeploymentBundle(source,{...baseConfig,...(jobs?{jobs:{entry:'dist/jobs.js',workers:2,concurrency:1,queues:[],scheduler:true}}:{})},{frameworkVersion:'0.24.0-test',nodeVersion:process.version,frameworkRoot:fileURLToPath(new URL('../../',import.meta.url))});
 const docker={memory:'384m',cpus:'0.5',pidsLimit:96,dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory}};
 service=await openDockerDeploymentProviderService({rootDirectory:root,owner:label,image,docker:{...docker,portStart:47260,portEnd:47265}});
 target=await openDockerDeploymentProviderService({rootDirectory:targetRoot,owner:targetLabel,image,docker:{...docker,portStart:47460,portEnd:47465}});
 sourceServer=await serve(request=>{if(new URL(request.url).pathname.startsWith('/v1/clank/fallback-owner/'))lastSourceProbe=request.url;return service.handle(request);},{hostname:'127.0.0.1',port:47231,allowedHosts:['127.0.0.1:47231']});
 targetServer=await serve(request=>target.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
 api=await openNativePlatformAPI(directory,key,{capacity:4,localFallback:mode==='product-normal'});
 const initial=await api.deploy(service,await bundle(true)),primary=initial.capsule,projectId=primary.manifest.projectId;
 const originalSourceRequest={...request(primary),operation:{id:initial.operation.id,projectId,fence:initial.operation.fence,attempt:initial.operation.attempts,maxAttempts:initial.operation.maxAttempts}};
 assert.equal(primary.manifest.environment.MULTILINE,'line one\nline two');
 const unrelated='unrelated_source',other=await createDeploymentRuntimeCapsule({projectId:unrelated,releaseId:'release_'+unrelated,generation:1,environment:baseConfig.env,database:{path:'app.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/'+unrelated,token:'clanki_'+unrelated+'_token_123456789012345678901234',controlToken:'clankc_'+unrelated+'_token_123456789012345678901234'},artifact:await bundle(false)});
 await service.reconcile(request(other));
 const first=await publicRequest('/write');assert.equal(first.status,200,await first.text());
 assert.equal((await unrelatedRequest(other,'/write')).status,200);
 const before=await publicRequest('/');assert.equal(before.status,200);const beforeRows=await before.json();
 assert.ok(beforeRows.some(row=>row.role==='web'&&row.value==='line one\nline two'));
 if(mode==='normal'){
  const originalBytes=Buffer.from(primary.bytes),originalIds=await inventory(label,projectId),reject=async(sourceProvider,targetProvider,node='native_target')=>{
   await assert.rejects(transferDockerProviderFallback(api.runtime,sourceProvider,targetProvider,primary.bytes,{projectId,operationId:'evac_rejected_'+randomUUID().replaceAll('-',''),targetNodeId:node,targetNodeToken:api.targetSession.token,maximumDowntimeMs:30000}),/endpoint|preflight|placement|distinct/i);
   assert.deepEqual(Buffer.from(primary.bytes),originalBytes,'Rejected fallback must preserve caller capsule bytes.');assert.deepEqual(await inventory(label,projectId),originalIds);const response=await publicRequest('/write');assert.equal(response.status,200,await response.text());
  };
  cloneSource=await openDockerDeploymentProviderService({rootDirectory:join(directory,'clone-source'),owner:label+'_clone_source',image,docker:{...docker,portStart:47660,portEnd:47665}});
  await cloneSource.reconcile(request(primary));await reject(cloneSource,target);await cloneSource.reconcile(request(primary));assert.equal((await cloneSource.inspect(projectId)).state,'running');await cloneSource.close();cloneSource=undefined;
  cloneTarget=await openDockerDeploymentProviderService({rootDirectory:join(directory,'clone-target'),owner:label+'_clone_target',image,docker:{...docker,portStart:47760,portEnd:47765}});
  await reject(service,cloneTarget);await service.reconcile(originalSourceRequest);await cloneTarget.close();cloneTarget=undefined;
  await reject(service,target,'missing_target_node');await service.reconcile(originalSourceRequest);
  assert.ok(lastSourceProbe);assert.notEqual((await service.handle(new Request(lastSourceProbe))).status,204);assert.notEqual((await service.handle(new Request('http://provider.test/v1/clank/fallback-owner/'+'0'.repeat(64)))).status,204);
  proof.clonedSourceAndTargetRefused=true;proof.preflightCaptureReleased=true;proof.staleAndReplayedProbeRefused=true;
 }
 const productPlan=mode==='product-normal'?await api.planEvacuation(service,target):undefined,began=performance.now();let operationId='evac_native_fallback_'+randomUUID().replaceAll('-','');
 const daemonId=JSON.parse((await command(['info','--format','{{json .ID}}'])).stdout);if(process.env.CLANK_SOURCE_EXPECTED_DAEMON_ID)assert.equal(daemonId,process.env.CLANK_SOURCE_EXPECTED_DAEMON_ID);
 const unrelatedIds=await inventory(label,unrelated);
 const unrelatedNative=[];
 for(const cid of unrelatedIds){const row=JSON.parse((await command(['container','inspect',cid])).stdout)[0],ports=Object.values(row.NetworkSettings.Ports??{}).flat().filter(Boolean);assert.equal(row.State.Running,true);assert.equal(ports.length,1);unrelatedNative.push({containerId:cid,pid:row.State.Pid,birth:nativeBirth(row.State.Pid),cgroup:'/sys/fs/cgroup'+fs.readFileSync('/proc/'+row.State.Pid+'/cgroup','utf8').trim().slice(3),host:row.Config.Hostname,url:'http://127.0.0.1:'+ports[0].HostPort});}
 const deadlineObservation=join(directory,'deadline-observation.json');
 if(!normalMode){
  const observer=childProcess.spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./provider-fallback-deadline-observer-native.mjs',import.meta.url)),api.controlPath,operationId,targetLabel,projectId,configDirectory,deadlineObservation],{detached:true,stdio:'ignore'});observer.unref();
  const readyUntil=performance.now()+5000;while(!fs.existsSync(deadlineObservation+'.ready')){assert.ok(performance.now()<readyUntil,'Independent deadline observer failed to start.');await new Promise(resolve=>setTimeout(resolve,10));}
 }
 const checkpoint=join(directory,'fallback-checkpoint.json');let injected=false,partialLaunchBoundary;
 const save=()=>{const stored=api.control.prepare('SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId);assert.ok(stored?.journal);const value={directory,root,targetRoot,configDirectory,keyPath,label,targetLabel,mode,projectId,operationId,daemonId,unrelatedIds,unrelatedNative,deadlineObservation,partialLaunchBoundary,image,sourceSession:api.sourceSession,targetSession:api.targetSession,...stored};fs.writeFileSync(checkpoint,JSON.stringify(value)+'\n',{mode:0o600});const fd=fs.openSync(checkpoint,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return value;};
 const originalExec=DatabaseSync.prototype.exec,originalPrepare=DatabaseSync.prototype.prepare,originalSpawn=childProcess.spawn;
 const terminate=()=>{save();fs.writeSync(1,JSON.stringify({directory,checkpoint,mode,requiresRecovery:true})+'\n');process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);};
 const phaseModes={'reservation-loss-after':'reserved','controller-loss-stopping':'stopping','controller-loss-stopped':'stopped','controller-loss-launching':'launching'};
 if(!normalMode)DatabaseSync.prototype.exec=function(sql){
  if(injected||sql!=='COMMIT'||originalPrepare.call(this,'PRAGMA database_list').get().file!==api.controlPath)return originalExec.call(this,sql);
  const stored=originalPrepare.call(this,'SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId),phase=stored?JSON.parse(stored.journal).phase:null;
  if(phaseModes[mode]===phase){injected=true;const result=originalExec.call(this,sql);terminate();return result;}
  if(!['commit-loss','controller-loss-before','controller-loss-after','controller-stall'].includes(mode)||originalPrepare.call(this,'SELECT state FROM clank_deployment_handoffs WHERE handoff_id=?').get(operationId)?.state!=='committed')return originalExec.call(this,sql);
  injected=true;if(mode==='controller-loss-before')terminate();if(mode==='controller-stall')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,35000);
  const result=originalExec.call(this,sql);save();if(mode==='controller-loss-after')terminate();throw Error('fallback original native commit response lost');
 };
 if(['controller-loss-source-stop','controller-loss-partial-target'].includes(mode)){
  let firstTargetStart;
  childProcess.spawn=function(executable,args,options){
   if(mode==='controller-loss-partial-target'&&!injected&&executable==='docker'&&args[0]==='container'&&args[1]==='start'){
    const stored=api.control.prepare('SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId),journal=stored?JSON.parse(stored.journal):null,roles=journal?.phase==='launching'?journal.launchIntent.roles:[],role=roles.find(role=>args.includes(role.containerId));
    if(role){
     if(!firstTargetStart)firstTargetStart=role.containerId;
     else{
      // Hold a later exact start before spawning it; inspect the real first role
      // until the independent observer also saw it, then lose the controller.
      const until=performance.now()+5000;
      for(;;){
       assert.ok(performance.now()<until,'First intended role was not observed before the partial-start fault.');
       const result=childProcess.spawnSync('docker',['container','inspect',...roles.map(role=>role.containerId)],{env:options.env,encoding:'utf8',timeout:1500,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);
       const rows=JSON.parse(result.stdout),running=rows.filter(row=>row.State.Running&&row.State.Pid>0),created=rows.filter(row=>row.State.Status==='created'&&row.State.Pid===0);
       let observed=[];try{observed=JSON.parse(fs.readFileSync(deadlineObservation+'.progress','utf8')).observedStartedIds;}catch(error){if(error.code!=='ENOENT')throw error;}
       if(running.some(row=>row.Id===firstTargetStart)&&observed.includes(firstTargetStart)){
        assert.equal(rows.length,4);assert.ok(running.length>=1&&running.length<=3);assert.ok(created.length>=1);assert.equal(running.length+created.length,4);
        partialLaunchBoundary={at:process.hrtime.bigint().toString(),heldStart:role.containerId,running:running.map(row=>({containerId:row.Id,pid:row.State.Pid,birth:nativeBirth(row.State.Pid)})),neverStarted:created.map(row=>row.Id)};
        injected=true;terminate();
       }
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
     }
    }
   }
   const child=originalSpawn.call(this,executable,args,options);
   if(!injected&&executable==='docker'&&args[0]==='container'&&args[1]===(mode==='controller-loss-source-stop'?'stop':'start')){
    const retained=()=>{const stored=api.control.prepare('SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId);if(!stored)return;const journal=JSON.parse(stored.journal),expected=mode==='controller-loss-source-stop'?journal.source.roles:journal.launchIntent?.roles;return journal.phase===(mode==='controller-loss-source-stop'?'stopping':'launching')?expected?.find(role=>args.includes(role.containerId)):undefined;};
    if(mode==='controller-loss-source-stop')child.once('exit',code=>{if(code===0&&!injected&&retained()){injected=true;terminate();}});
   }return child;};syncBuiltinESMExports();
 }
 let result,transferFailure;try{if(productPlan){result=await api.runEvacuation(productPlan);const item=result.projects.find(item=>item.projectId===projectId);assert.equal(item.fallbackState,'running');assert.equal(item.targetGeneration,2);assert.equal(item.targetNodeId,'native_target');operationId=item.fallbackOperationId;proof.productEvacuationPlan=result;}else result=await transferDockerProviderFallback(api.runtime,service,target,primary.bytes,{projectId,operationId,targetNodeId:'native_target',targetNodeToken:api.targetSession.token,maximumDowntimeMs:30000});}catch(error){transferFailure=error;}finally{DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
 if(!normalMode){
  assert.equal(injected,true);assert.ok(transferFailure);assert.equal((await unrelatedRequest(other,'/write')).status,200);proof.unrelatedProjectStayedRunning=true;proof.injectedCommitFailure=transferFailure.message;
  // Preserve unrelated native roles across the real controller-process boundary.
  terminate();
 }else{
 if(transferFailure)throw transferFailure;

 proof.elapsedMs=performance.now()-began;assert.ok(proof.elapsedMs<30000);if(!productPlan){assert.equal(result.roles,4);assert.equal(result.generation,2);}
 const stored=api.control.prepare('SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId),journal=JSON.parse(stored.journal);
 assert.equal(journal.phase,'prepared');if(productPlan){assert.equal(journal.platform.evacuation.identity.planId,productPlan.id);assert.equal(journal.platform.evacuation.identity.projectId,projectId);assert.equal(JSON.parse(journal.platform.evacuation.projectsRunning)[0].fallbackState,'running');}assert.match(stored.authentication,/^[a-f0-9]{64}$/u);
 assert.deepEqual(journal.source.roles.map(role=>role.role),['web','worker','worker','scheduler']);assert.deepEqual(journal.target.roles.map(role=>role.role),['web','worker','worker','scheduler']);
 assert.equal(journal.source.policySha256,journal.target.policySha256);
 await proveAbsent(journal.source);proof.independentTargetRoles=await inspectRoles(journal.target);assert.deepEqual(await inventory(label,unrelated),unrelatedIds);
 const fresh=api.control.prepare('SELECT * FROM clank_deployment_operations WHERE project_id=? AND idempotency_key=?').get(projectId,'fallback_'+operationId);
 assert.equal(fresh.state,'succeeded');assert.ok(fresh.fence>journal.fence);assert.equal(fresh.node_id,'native_target');
 const placement=api.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(projectId);assert.equal(placement.assigned_node_id,'native_target');assert.equal(placement.observed_state,'running');assert.equal(placement.generation,2);
 const write=await publicRequest('/write');assert.equal(write.status,200,await write.text());
 const after=await publicRequest('/');assert.equal(after.status,200);const rows=await after.json();
 assert.ok(rows.filter(row=>row.role==='web'&&row.value==='line one\nline two').length>=2);assert.ok(rows.some(row=>row.role==='worker'));assert.ok(rows.some(row=>row.role==='scheduler'));
 for(const role of proof.independentTargetRoles)assert.ok(rows.some(row=>row.host===role.host&&row.role===role.role&&row.value==='line one\nline two'),'Target role did not write its own multiline environment: '+role.role+':'+role.instance);
 assert.equal(new Set(proof.independentTargetRoles.map(role=>role.host)).size,4);proof.targetRolesWroteOwnEnvironment=true;
 assert.equal((await unrelatedRequest(other,'/write')).status,200);assert.equal((await service.inspect(unrelated)).state,'running');
 fs.appendFileSync(join(source,'dist','server.js'),'\n// Ordinary API generation after fallback acknowledgement.\n');
 const ordinary=await api.deployNext(target,await bundle(true));assert.equal(ordinary.capsule.manifest.generation,3);
 const next=await publicRequest('/write');assert.equal(next.status,200,await next.text());
 const nextIds=await inventory(targetLabel,projectId);assert.equal(nextIds.length,4);assert.ok(nextIds.every(id=>!journal.target.roles.some(role=>role.containerId===id)));
 assert.deepEqual(await inventory(label,unrelated),unrelatedIds);assert.equal((await unrelatedRequest(other,'/write')).status,200);
 proof.ordinaryNextGeneration={generation:3,fence:ordinary.operation.fence,roleIds:nextIds};
 proof.result=result;proof.roles=journal.target.roles;proof.policySha256=journal.target.policySha256;proof.unrelatedProjectStayedRunning=true;proof.unrelatedProjectAuthority='Independent ordinary provider capsule';proof.freshFence=fresh.fence;proof.records=rows.length;proof.initialRecords=beforeRows.length;proof.complete=true;
 }
}catch(error){failure=error;proof.failure={message:error.message,stack:error.stack,causes:error.errors?.map(error=>error.message)};}
finally{
 const cleanupErrors=[];for(const close of [()=>cloneSource?.close(),()=>cloneTarget?.close(),()=>api?.close(),()=>sourceServer?.close(),()=>targetServer?.close(),()=>target?.close(),()=>service?.close()])try{await close();}catch(error){cleanupErrors.push(error.message);failure??=error;}
 if(cleanupErrors.length)proof.cleanupFailures=cleanupErrors;
 try{proof.remaining=[];for(const owner of [label,targetLabel,label+'_clone_source',label+'_clone_target']){const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}'])).stdout.trim();if(ids)proof.remaining.push({owner,ids});}}catch(error){failure??=error;proof.inventoryFailure=error.message;}
 proof.pins=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root)||path.startsWith(targetRoot)?[fd]:[];}catch{return[];}}).length;if(failure||proof.remaining?.length||proof.pins)proof.complete=false;console.log(JSON.stringify(proof));
}
if(failure||proof.remaining?.length||proof.pins)process.exitCode=1;
