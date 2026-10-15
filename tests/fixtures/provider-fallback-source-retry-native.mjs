// Opt-in original administrator source recovery/successor regression. Root alone runs this on the approved native host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
import {serve} from '../../dist/node.js';
import {openNativePlatformAPI} from './provider-platform-api-native.mjs';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const mode=process.argv[3];assert.ok(['reserved-commit-loss','stopping-commit-loss','stopped-commit-loss','source-resume-observer-failure','successor-commit-loss'].includes(mode));
const image=process.argv[2];assert.match(image,/@sha256:[a-f0-9]{64}$/u);
const directory=fs.mkdtempSync('/var/tmp/clank-fallback-source-retry-'),root=join(directory,'provider'),targetRoot=join(directory,'target'),source=join(directory,'source'),configDirectory=join(directory,'docker-config');
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
const proof={directory,ownedRoots:[root,targetRoot],mode,version:process.version,qualification:'Real administrator evacuation, same-process authenticated source recovery and append-only signed successor. No cold, cross-host or physical host-loss claim.',startedIdentities:[],complete:false};
const digest=value=>createHash('sha256').update(value).digest('hex');
const endpointError=error=>{const errors=proof.sourceEndpointErrors??=[];if(errors.length<8)errors.push({name:String(error?.name??'Error').slice(0,128),message:String(error?.message??error).slice(0,4096),stack:String(error?.stack??'').slice(0,4096)});};
let service,target,api,sourceServer,targetServer,failure,lastSourceProbe,beforeSuccessorProbe;
const originalExec=DatabaseSync.prototype.exec,originalPrepare=DatabaseSync.prototype.prepare,originalSpawn=childProcess.spawn;
const request=runtime=>({operation:{id:'native_'+runtime.manifest.projectId,projectId:runtime.manifest.projectId,fence:1,attempt:1,maxAttempts:3},desired:{state:'running',releaseId:runtime.manifest.releaseId,generation:1,runtimeProtocol:'clank-runtime/1'},artifact:runtime.artifact,runtime,signal:new AbortController().signal});
const unrelatedRequest=async(runtime,path)=>{const response=await service.handle(new Request('http://provider.test'+runtime.manifest.ingress.route+path,{headers:{'x-clank-project-id':runtime.manifest.projectId,'x-clank-runtime-protocol':'clank-runtime/1','x-clank-runtime-generation':'1','x-clank-runtime-ingress':runtime.manifest.ingress.token}}));await response.arrayBuffer();return response;};
const publicRequest=path=>api.runtime.handle(new Request('http://native-platform.apps.example.test'+path));
const inventory=async(owner,project)=>((await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--filter','label=run.clank.project='+project,'--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean)).sort();
const nativeBirth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
const inspectRoles=async(record)=>{
 if(record.roles.length===4)assert.deepEqual(record.roles.map(role=>role.role+':'+role.instance).sort(),['scheduler:0','web:0','worker:0','worker:1']);
 const ids=await inventory(record.owner,record.projectId);assert.deepEqual(ids,record.roles.map(role=>role.containerId).sort());
 const observed=[];
 for(const role of record.roles){
  const rows=JSON.parse((await command(['container','inspect',role.containerId])).stdout);assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.Id,role.containerId);assert.equal(row.State.Running,true);assert.equal(row.State.Status,'running');assert.equal(row.State.Pid,role.pid);assert.equal(nativeBirth(role.pid),role.birth);
  assert.equal(fs.readFileSync('/proc/'+role.pid+'/cgroup','utf8').trim(),'0::'+role.cgroup.slice('/sys/fs/cgroup'.length));assert.ok(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim().split('\n').includes(String(role.pid)));
  assert.equal(row.HostConfig.Memory,384*1024*1024);assert.equal(row.HostConfig.NanoCpus,500000000);assert.equal(row.HostConfig.PidsLimit,96);assert.equal(row.Config.User,'1000:1000');assert.equal(row.HostConfig.Privileged,false);assert.ok(row.HostConfig.CapDrop.includes('ALL'));assert.ok(row.HostConfig.SecurityOpt.includes('no-new-privileges=true')||row.HostConfig.SecurityOpt.includes('no-new-privileges'));assert.equal(row.AppArmorProfile,'docker-default');
assert.equal(row.Config.Labels['run.clank.role'],role.role);assert.equal(Number(row.Config.Labels['run.clank.instance']),role.instance);assert.equal(row.Image,record.imageId);
  observed.push({role:role.role,instance:role.instance,containerId:row.Id,pid:row.State.Pid,birth:nativeBirth(row.State.Pid),cgroup:role.cgroup,host:row.Config.Hostname,memory:row.HostConfig.Memory,nanoCpus:row.HostConfig.NanoCpus,pidsLimit:row.HostConfig.PidsLimit});
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
 sourceServer=await serve(async request=>{if(new URL(request.url).pathname.startsWith('/v1/clank/fallback-owner/')){lastSourceProbe=request.url;await beforeSuccessorProbe?.();}return service.handle(request);},{hostname:'127.0.0.1',port:47231,allowedHosts:['127.0.0.1:47231'],onError:endpointError});
 targetServer=await serve(request=>target.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
 api=await openNativePlatformAPI(directory,key,{capacity:4,localFallback:true});
 const initial=await api.deploy(service,await bundle(true)),primary=initial.capsule,projectId=primary.manifest.projectId;
 // The source stays draining during recovery. Exercise its actual original
 // HTTP listener with the original capsule ingress credentials; public ingress
 // is intentionally unavailable until the administrator publishes the target.
 const sourceRequest=path=>fetch('http://127.0.0.1:47231'+primary.manifest.ingress.route+path,{headers:{'x-clank-project-id':projectId,'x-clank-runtime-protocol':'clank-runtime/1','x-clank-runtime-generation':String(primary.manifest.generation),'x-clank-runtime-ingress':primary.manifest.ingress.token},redirect:'error',signal:AbortSignal.timeout(5000)});
 const originalSourceRequest={operation:{id:initial.operation.id,projectId:initial.operation.projectId,fence:initial.operation.fence,attempt:initial.operation.attempts,maxAttempts:initial.operation.maxAttempts},desired:initial.operation.payload,runtime:primary,artifact:primary.artifact,signal:new AbortController().signal};
 assert.equal(primary.manifest.environment.MULTILINE,'line one\nline two');
 const unrelated='unrelated_source',other=await createDeploymentRuntimeCapsule({projectId:unrelated,releaseId:'release_'+unrelated,generation:1,environment:baseConfig.env,database:{path:'app.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/'+unrelated,token:'clanki_'+unrelated+'_token_123456789012345678901234',controlToken:'clankc_'+unrelated+'_token_123456789012345678901234'},artifact:await bundle(false)});
 await service.reconcile(request(other));
 const first=await publicRequest('/write');assert.equal(first.status,200,await first.text());
 assert.equal((await unrelatedRequest(other,'/write')).status,200);
 const before=await publicRequest('/');assert.equal(before.status,200);const beforeRows=await before.json();
 assert.ok(beforeRows.some(row=>row.role==='web'&&row.value==='line one\nline two'));
 const plan=await api.planEvacuation(service,target),unrelatedIds=await inventory(label,unrelated);
 const nativeSync=(selectedOwner,selectedProject)=>{
  const execute=args=>{const result=childProcess.spawnSync('docker',args,{env:{...process.env,DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory},encoding:'utf8',timeout:5000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);return result.stdout;};
  const ids=execute(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+selectedOwner,'--filter','label=run.clank.project='+selectedProject,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);
  if(!ids.length)return {owner:selectedOwner,projectId:selectedProject,roles:[]};
  const rows=JSON.parse(execute(['container','inspect',...ids]));
  return {owner:selectedOwner,projectId:selectedProject,imageId:rows[0].Image,roles:rows.map(row=>{assert.equal(row.State.Running,true);assert.ok(row.State.Pid>0);const cgroup='/sys/fs/cgroup'+fs.readFileSync('/proc/'+row.State.Pid+'/cgroup','utf8').trim().slice(3);return {containerId:row.Id,pid:row.State.Pid,birth:nativeBirth(row.State.Pid),cgroup,role:row.Config.Labels['run.clank.role'],instance:Number(row.Config.Labels['run.clank.instance'])};})};
 };
 const unrelatedNative=nativeSync(label,unrelated);assert.equal(unrelatedNative.roles.length,1);
 const verifyUnrelated=async()=>{assert.deepEqual(await inventory(label,unrelated),unrelatedIds);await inspectRoles(unrelatedNative);assert.equal((await unrelatedRequest(other,'/write')).status,200);};

 const originalNative=nativeSync(label,projectId);assert.equal(originalNative.roles.length,4);proof.startedIdentities.push({kind:'original-source',...originalNative},{kind:'unrelated',...unrelatedNative});
 const expectedPhase=mode==='reserved-commit-loss'?'reserved':mode==='stopping-commit-loss'?'stopping':'stopped';
 let initialInjected=false;
 DatabaseSync.prototype.exec=function(sql){
  if(!initialInjected&&sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath){
   const stored=originalPrepare.call(this,'SELECT operation_id,journal,authentication FROM clank_deployment_fallback_journals').get();
   if(stored&&JSON.parse(stored.journal).phase===expectedPhase){
    const value=JSON.parse(stored.journal);assert.equal(value.identity.projectId,projectId);assert.equal(value.platform.evacuation.identity.planId,plan.id);
    const remaining=BigInt(value.deadline)-process.hrtime.bigint();assert.ok(remaining>0n&&remaining<=30000000000n);
    originalExec.call(this,sql);initialInjected=true;throw new Error('source retry fixture '+expectedPhase+' COMMIT response lost');
   }
  }
  return originalExec.call(this,sql);
 };
 try{await assert.rejects(api.runEvacuation(plan),error=>{proof.initialApiRejection={name:error.name,message:error.message,stack:error.stack};return true;});}finally{DatabaseSync.prototype.exec=originalExec;}
 assert.equal(initialInjected,true);proof.initialInjected=true;await verifyUnrelated();
 const retained=api.control.prepare('SELECT operation_id,journal,authentication FROM clank_deployment_fallback_journals').get(),journal=JSON.parse(retained.journal),operationId=retained.operation_id;
 assert.equal(journal.phase,expectedPhase);assert.equal(journal.platform.evacuation.identity.planId,plan.id);assert.deepEqual(await inventory(targetLabel,projectId),[]);
 assert.deepEqual(journal.source.roles.map(row=>row.containerId).sort(),originalNative.roles.map(row=>row.containerId).sort());
 if(expectedPhase==='stopped')await proveAbsent(originalNative);else await inspectRoles(originalNative);
 proof.predecessor={operationId,phase:journal.phase,journalSha256:digest(retained.journal),authentication:retained.authentication,handoffState:'reserved'};
 proof.recovery={selected:'source'};
 const unrelatedWork=await api.coordinator.enqueue({projectId:'unrelated-queued-source',nodeId:'native_node',action:'reconcile',payload:{state:'running'},idempotencyKey:'source-retry-unrelated-'+randomUUID()});
 assert.deepEqual(await api.client.claim('native_node',api.sourceSession.token,10),[]);proof.generalDrainingClaimEmpty=true;
 assert.equal(api.coordinator.operation(unrelatedWork.operation.id).state,'queued');
 let sourceStoppedBeforeResume=false,sourceObserved,sourceWrites,sourceProbeComplete=false,successorInjected=false,resumeInjected=false,faultNative,failedOperation;
 const resumeOperation=()=>api.control.prepare('SELECT * FROM clank_deployment_operations WHERE project_id=? ORDER BY created_at DESC').all(projectId).find(row=>String(row.idempotency_key).startsWith('fallback_resume_'+operationId+'_'));
 const finalWriteProof=async(record)=>{
  const inspected=await inspectRoles(record),before=await sourceRequest('/');assert.equal(before.status,200);
  const floor=Math.max(0,...(await before.json()).map(row=>row.id));proof.sourceWriteFloor=floor;
  const response=await sourceRequest('/write');assert.equal(response.status,200,await response.text());
  const deadline=performance.now()+5000;let rows;
  const fresh=(row,role)=>row.id>floor&&row.role===role.role&&row.host===role.host&&row.value===(role.role==='web'?'line one\nline two':'tick');
  for(;;){const response=await sourceRequest('/');assert.equal(response.status,200);rows=await response.json();if(inspected.every(role=>rows.some(row=>fresh(row,role))&&rows.some(row=>row.role===role.role&&row.host===role.host&&row.value==='line one\nline two')))break;assert.ok(performance.now()<deadline,'Every exact recovered source role must make a fresh write and retain its own multiline environment before successor snapshot.');await new Promise(resolve=>setTimeout(resolve,25));}
  proof.sourceAllRolesWriteEnvironment=true;
  return inspected.map(role=>{const row=rows.find(row=>fresh(row,role));return {id:row.id,role:row.role,value:row.value,host:row.host};});
 };
 beforeSuccessorProbe=async()=>{
  if(sourceProbeComplete)return;
  const linkRow=api.control.prepare('SELECT * FROM clank_platform_fallback_successors WHERE predecessor_id=?').get(operationId);if(!linkRow)return;
  sourceObserved=nativeSync(label,projectId);assert.equal(sourceObserved.roles.length,4);proof.startedIdentities.push({kind:'successor-source',...sourceObserved});
  if(expectedPhase==='reserved'){
   assert.deepEqual(sourceObserved.roles.map(role=>role.containerId).sort(),originalNative.roles.map(role=>role.containerId).sort());proof.recovery.sourceOriginalCidsPreserved=true;
  }else{
   assert.equal(sourceStoppedBeforeResume,true);assert.ok(sourceObserved.roles.every(role=>!originalNative.roles.some(old=>old.containerId===role.containerId)));
   const resumed=resumeOperation();assert.equal(resumed.state,'succeeded');assert.equal(resumed.node_id,'native_node');assert.ok(resumed.fence>journal.fence);assert.ok(resumed.updated_at-resumed.created_at<30000);proof.sourceResumeElapsedMs=resumed.updated_at-resumed.created_at;
   Object.assign(proof.recovery,{sourceResumed:true,sourceStoppedBeforeResume:true,newCids:sourceObserved.roles.map(role=>role.containerId),freshFence:resumed.fence,operationId:resumed.id});
  }
  assert.deepEqual(await api.client.claim('native_node',api.sourceSession.token,10),[]);assert.equal(api.coordinator.operation(unrelatedWork.operation.id).state,'queued');
  sourceWrites=await finalWriteProof(sourceObserved);assert.equal(sourceWrites.length,4);sourceProbeComplete=true;
 };
 // Observe actual source absence at the genuine fresh source writer admission.
 // A failure is injected only after ordinary reconciliation has reached running.
 childProcess.spawn=function(executable,args,options){
  if(executable==='docker'&&args?.[0]==='info'&&!sourceProbeComplete){
   const attempt=resumeOperation();
   if(attempt?.state==='leased'){
    let state;try{state=JSON.parse(fs.readFileSync(join(root,'service',projectId+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const reconciled=state?.phase==='running'&&state.operationId===attempt.id;
    if(!sourceStoppedBeforeResume&&!reconciled){const placed=api.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(projectId);assert.equal(placed.assigned_node_id,'native_node');assert.equal(placed.observed_state,'stopped');assert.deepEqual(nativeSync(label,projectId).roles,[]);for(const role of originalNative.roles){try{assert.notEqual(nativeBirth(role.pid),role.birth);}catch(error){if(error.code!=='ENOENT')throw error;}try{assert.equal(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim(),'');}catch(error){if(error.code!=='ENOENT')throw error;}}sourceStoppedBeforeResume=true;}
    if(mode==='source-resume-observer-failure'&&!resumeInjected&&reconciled){
     faultNative=nativeSync(label,projectId);assert.equal(faultNative.roles.length,4);failedOperation=attempt;proof.startedIdentities.push({kind:'failed-source-resume',...faultNative});resumeInjected=true;
     return originalSpawn.call(this,process.execPath,['--eval','process.stderr.write("injected source resume observation failure\\n");process.exit(77)'],options);
    }
   }
  }
  return originalSpawn.call(this,executable,args,options);
 };syncBuiltinESMExports();
 if(mode==='source-resume-observer-failure'){
  try{await assert.rejects(api.runEvacuation(plan),error=>{proof.resumeApiRejection={name:error.name,message:error.message,stack:error.stack};return true;});}finally{childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
  assert.equal(resumeInjected,true);await proveAbsent(faultNative);await proveAbsent(originalNative);await verifyUnrelated();
  const state=await service.inspect(projectId),placed=api.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(projectId),failed=api.control.prepare('SELECT * FROM clank_deployment_operations WHERE id=?').get(failedOperation.id);
  assert.equal(state.state,'stopped');assert.equal(state.phase,'stopped');assert.equal(state.generation,1);assert.equal(state.releaseId,null);assert.equal(state.capsuleSha256,null);assert.equal(placed.observed_state,'stopped');assert.equal(placed.assigned_node_id,'native_node');assert.equal(failed.state,'cancelled');assert.equal(failed.lease_token_hash,null);assert.equal(failed.lease_expires_at,null);
  assert.equal(api.control.prepare('SELECT count(*) count FROM clank_platform_fallback_successors').get().count,0);
  Object.assign(proof,{resumeInjected:true,failedSourceAbsent:true,canonicalStopped:true,failedSourceFence:failed.fence,failedSourceOperation:failed.id});
 }
 if(mode==='successor-commit-loss'){
  DatabaseSync.prototype.exec=function(sql){
   if(!successorInjected&&sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath){
    const link=originalPrepare.call(this,'SELECT * FROM clank_platform_fallback_successors WHERE predecessor_id=?').get(operationId);
    if(link){const value=JSON.parse(link.journal);assert.equal(value.predecessorId,operationId);assert.equal(JSON.parse(value.sourceOperation).state,'succeeded');assert.equal(value.sourceEvidence.roles.length,4);originalExec.call(this,sql);successorInjected=true;throw new Error('source retry fixture successor COMMIT response lost');}
   }
   return originalExec.call(this,sql);
  };
 }
 let completed;
 try{completed=await api.runEvacuation(plan);}finally{DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
 assert.equal(completed.state,'completed');assert.equal(sourceProbeComplete,true);assert.ok(sourceWrites);
 const linkRow=api.control.prepare('SELECT * FROM clank_platform_fallback_successors WHERE predecessor_id=?').get(operationId),link=JSON.parse(linkRow.journal),head=completed.projects.find(item=>item.projectId===projectId);
 assert.equal(createHmac('sha256',key).update('clank-provider-fallback-successor/1\n').update(linkRow.journal).digest('hex'),linkRow.authentication);proof.successorAuthenticationVerified=true;assert.equal(linkRow.successor_id,head.fallbackAttemptId);assert.notEqual(linkRow.successor_id,operationId);assert.equal(link.predecessorId,operationId);assert.equal(link.successorId,linkRow.successor_id);
 const old=api.control.prepare('SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId);assert.equal(old.journal,retained.journal);assert.equal(old.authentication,retained.authentication);
 assert.equal(api.control.prepare('SELECT state FROM clank_deployment_handoffs WHERE handoff_id=?').get(operationId).state,'cancelled');
 const next=JSON.parse(api.control.prepare('SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(linkRow.successor_id).journal);assert.equal(next.phase,'prepared');assert.equal(next.identity.sourceGeneration,1);assert.equal(next.identity.targetGeneration,2);assert.ok(BigInt(next.deadline)>process.hrtime.bigint(),'Successor transfer must finish within its original deadline.');
 assert.equal(head.fallbackState,'running');assert.equal(head.targetNodeId,'native_target');assert.equal(head.targetGeneration,2);assert.equal(head.backupId,JSON.parse(next.platform.targetGeneration).restore_backup_id);
 if(mode==='successor-commit-loss')assert.equal(successorInjected,true);
 Object.assign(proof,{successor:{operationId:linkRow.successor_id,predecessorId:operationId,linkSha256:digest(linkRow.journal),authentication:linkRow.authentication,planHead:head.fallbackAttemptId,journalPreserved:true,afterimageRecovered:successorInjected},originalAttemptDeadline:journal.deadline,successorDeadline:next.deadline});
 if(mode==='source-resume-observer-failure'){proof.freshRetryFence=proof.recovery.freshFence;assert.ok(proof.freshRetryFence>proof.failedSourceFence);}
 await proveAbsent(originalNative);await proveAbsent(sourceObserved);await verifyUnrelated();
 const queued=api.coordinator.operation(unrelatedWork.operation.id);assert.ok(['queued','cancelled'].includes(queued.state));assert.equal(queued.attempts,0);proof.unrelatedOperationUnclaimed=true;
 const fresh=nativeSync(targetLabel,projectId);assert.equal(fresh.roles.length,4);const observedTarget=await inspectRoles(fresh);proof.startedIdentities.push({kind:'final-target',...fresh});
 const write=await publicRequest('/write');assert.equal(write.status,200,await write.text());
 const writeDeadline=performance.now()+5000;let rows;
 for(;;){const response=await publicRequest('/');assert.equal(response.status,200);rows=await response.json();if(observedTarget.every(role=>rows.some(row=>row.role===role.role&&row.host===role.host&&row.value==='line one\nline two')))break;assert.ok(performance.now()<writeDeadline,'Final target roles must write their own multiline environment.');await new Promise(resolve=>setTimeout(resolve,25));}
 for(const retained of sourceWrites)assert.ok(rows.some(row=>row.id===retained.id&&row.role===retained.role&&row.host===retained.host&&row.value===retained.value),'The new successor snapshot must retain fresh recovered-source writes.');
 Object.assign(proof,{sourceWritesRetainedInSuccessorSnapshot:true,sourceWrites,targetRoles:observedTarget,targetAllRolesWriteEnvironment:true,unrelatedProjectStayedRunning:true,sourceAbsent:true,complete:true});
}catch(error){failure=error;proof.failure={message:error.message,stack:error.stack,causes:error.errors?.map(error=>error.message)};}
finally{
 DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();
 const cleanupErrors=[];for(const close of [()=>api?.close(),()=>sourceServer?.close(),()=>targetServer?.close(),()=>target?.close(),()=>service?.close()])try{await close();}catch(error){cleanupErrors.push(error.message);failure??=error;}
 if(cleanupErrors.length)proof.cleanupFailures=cleanupErrors;
 try{proof.remaining=[];for(const owner of [label,targetLabel]){const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}'])).stdout.trim();if(ids)proof.remaining.push({owner,ids});}}catch(error){failure??=error;proof.inventoryFailure=error.message;}
 proof.pins=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root)||path.startsWith(targetRoot)?[fd]:[];}catch{return[];}}).length;
 if(failure||proof.remaining?.length||proof.pins)proof.complete=false;
 await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(proof)+'\n',error=>error?reject(error):resolve()));
}
if(failure||proof.remaining?.length||proof.pins)process.exitCode=1;
