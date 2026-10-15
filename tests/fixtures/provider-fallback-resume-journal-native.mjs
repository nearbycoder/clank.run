// Opt-in durable resume journal/terminal publication regression (Stage1/2). Root runs only on the approved native host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
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
const mode=process.argv[3]??'observer-failure';assert.ok(['observer-failure','early-admission-failure','plan-commit-loss','terminal-afterimage-mutation','cold-stopped'].includes(mode));
const image=process.argv[2];assert.match(image,/@sha256:[a-f0-9]{64}$/u);
const directory=fs.mkdtempSync('/var/tmp/clank-fallback-resume-journal-'),root=join(directory,'provider'),targetRoot=join(directory,'target'),source=join(directory,'source'),configDirectory=join(directory,'docker-config');
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
if(mode==='cold-stopped')process.send?.({event:'cold-fixture-start',directory,label,targetLabel});
const key=randomBytes(32),keyPath=join(directory,'master.key');fs.writeFileSync(keyPath,key,{mode:0o600});
const proof={directory,mode,version:process.version,qualification:'Stage1/2 only: real administrator target resume, append-only authenticated native intent before start, signed running roster, and atomic terminal plan publication before guard release. No cold startup or unrelated-runtime adoption claim.',complete:false};
let service,target,api,sourceServer,targetServer,failure,lastSourceProbe;
const originalExec=DatabaseSync.prototype.exec,originalPrepare=DatabaseSync.prototype.prepare,originalSpawn=childProcess.spawn;
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
 api=await openNativePlatformAPI(directory,key,{capacity:4,localFallback:true});
 const initial=await api.deploy(service,await bundle(true)),primary=initial.capsule,projectId=primary.manifest.projectId;
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
 let initialInjected=false;
 // Lose a real durable placement COMMIT response, producing an authenticated
 // stopped target to resume through the existing administrator route.
 DatabaseSync.prototype.exec=function(sql){
  if(!initialInjected&&sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath){
   const handoff=originalPrepare.call(this,"SELECT handoff_id,state FROM clank_deployment_handoffs WHERE project_id=?").get(projectId);
   if(handoff?.state==='committed'){
    const stored=originalPrepare.call(this,'SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(handoff.handoff_id);assert.equal(JSON.parse(stored.journal).phase,'prepared');
    originalExec.call(this,sql);initialInjected=true;throw new Error('resume fixture initial placement COMMIT response lost');
   }
  }
  return originalExec.call(this,sql);
 };
 try{await assert.rejects(api.runEvacuation(plan),error=>{proof.initialApiRejection={name:error.name,message:error.message,stack:error.stack};return true;});}finally{DatabaseSync.prototype.exec=originalExec;}
 assert.equal(initialInjected,true);await verifyUnrelated();
 const retained=api.control.prepare('SELECT operation_id,journal,authentication FROM clank_deployment_fallback_journals').get(),journal=JSON.parse(retained.journal),operationId=retained.operation_id;
 assert.equal(journal.phase,'prepared');assert.equal(journal.platform.evacuation.identity.planId,plan.id);
 await proveAbsent(journal.source);await proveAbsent(journal.target);
 const firstState=api.control.prepare('SELECT state,projects FROM clank_platform_evacuations WHERE id=?').get(plan.id);assert.notEqual(firstState.state,'completed');
 const phaseCommits=[];
 const captureJournalCommit=db=>{
  const schema=originalPrepare.call(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='clank_platform_fallback_resume_heads'").get();if(!schema)return;
  const head=originalPrepare.call(db,'SELECT * FROM clank_platform_fallback_resume_heads WHERE predecessor_id=? ORDER BY attempt DESC LIMIT 1').get(operationId);if(!head)return;
  const row=originalPrepare.call(db,'SELECT * FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?').get(head.resume_id,head.revision);assert.ok(row);const signed=JSON.parse(row.journal);
  assert.equal(createHmac('sha256',key).update('clank-provider-fallback-resume-attempt/1\n'+row.journal).digest('hex'),row.authentication);assert.equal(head.authentication,row.authentication);assert.equal(signed.predecessorAuthentication,retained.authentication);assert.equal(signed.predecessorId,operationId);assert.equal(signed.identity.projectId,projectId);assert.equal(signed.selected,'target');
  const previous=originalPrepare.call(db,'SELECT authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?').get(head.resume_id,head.revision-1);assert.equal(signed.previousAuthentication,previous?.authentication??null);
  const last=phaseCommits.find(entry=>entry.resumeId===head.resume_id&&entry.revision===head.revision);if(last)return;
  const result={resumeId:head.resume_id,attempt:head.attempt,revision:head.revision,phase:head.phase,authentication:row.authentication,deadline:signed.deadline,recordedAt:process.hrtime.bigint().toString()};
  if(head.phase==='staged'){
   const ids=signed.intent.roles.map(role=>role.containerId).sort(),actual=childProcess.spawnSync('docker',['container','inspect',...ids],{env:{...process.env,DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory},encoding:'utf8',timeout:5000,maxBuffer:1024*1024});assert.equal(actual.status,0,actual.stderr);const rows=JSON.parse(actual.stdout);assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.Id).sort(),ids);assert.ok(rows.every(row=>row.State.Status==='created'&&row.State.Running===false&&row.State.Pid===0));assert.deepEqual(signed.intent.roles.map(role=>role.role+':'+role.instance).sort(),['scheduler:0','web:0','worker:0','worker:1']);
   result.allRolesNeverStarted=true;result.containerIds=ids;
  }
  if(head.phase==='running'||head.phase==='published'){
   assert.equal(signed.running.roles.length,4);assert.deepEqual(signed.running.roles.map(role=>role.containerId).sort(),signed.intent.roles.map(role=>role.containerId).sort());assert.ok(signed.running.roles.every(role=>role.pid>0&&role.birth&&role.cgroup));result.runningRoles=signed.running.roles;
  }
  if(head.phase==='published'){const planRow=originalPrepare.call(db,'SELECT projects FROM clank_platform_evacuations WHERE id=?').get(plan.id);assert.equal(planRow.projects,signed.publication);assert.equal(JSON.parse(planRow.projects).find(item=>item.projectId===projectId).fallbackState,'running');result.atomicPlanAfterimage=true;}
  phaseCommits.push(result);
 };
 let resumeInjected=false,faultNative,failedOperation;
 const operation=()=>api.control.prepare("SELECT * FROM clank_deployment_operations WHERE project_id=? ORDER BY created_at DESC").all(projectId).find(row=>String(row.idempotency_key).startsWith('fallback_resume_'+operationId+'_'));
 const captureFault=()=>{failedOperation=operation();assert.ok(failedOperation);faultNative=nativeSync(targetLabel,projectId);assert.equal(faultNative.roles.length,mode==='early-admission-failure'?0:4);for(const role of faultNative.roles)assert.ok(!journal.target.roles.some(old=>old.containerId===role.containerId));};
 if(mode==='plan-commit-loss'||mode==='terminal-afterimage-mutation'){
  DatabaseSync.prototype.exec=function(sql){
   if(sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath)captureJournalCommit(this);
   if(!resumeInjected&&sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath){
    const row=originalPrepare.call(this,'SELECT projects FROM clank_platform_evacuations WHERE id=?').get(plan.id),attempt=originalPrepare.call(this,"SELECT * FROM clank_deployment_operations WHERE project_id=? AND state='succeeded' ORDER BY created_at DESC").all(projectId).find(row=>String(row.idempotency_key).startsWith('fallback_resume_'+operationId+'_'));
    if(attempt&&JSON.parse(row.projects).some(item=>item.projectId===projectId&&item.fallbackState==='running')){
     captureFault();assert.equal(attempt.state,'succeeded');originalExec.call(this,sql);resumeInjected=true;
     if(mode==='terminal-afterimage-mutation'){const other=new DatabaseSync(api.controlPath);try{const changed=other.prepare('UPDATE clank_deployment_project_fences SET fence=fence+1 WHERE project_id=? AND fence=?').run(projectId,attempt.fence);assert.equal(changed.changes,1);proof.externalFence={before:attempt.fence,after:attempt.fence+1};}finally{other.close();}return;}
     throw new Error('resume fixture final plan COMMIT response lost');
    }
   }
   return originalExec.call(this,sql);
  };
 }else{
  DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath)captureJournalCommit(this);return originalExec.call(this,sql);};
  childProcess.spawn=function(executable,args,options){
   if(!resumeInjected&&executable==='docker'&&args?.[0]==='info'){
    const attempt=operation();let state;try{state=JSON.parse(fs.readFileSync(join(targetRoot,'service',projectId+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const reconciled=state?.phase==='running'&&state.operationId===attempt?.id;
    if(attempt?.state==='leased'&&(['observer-failure','cold-stopped'].includes(mode)?reconciled:!reconciled)){
     captureFault();resumeInjected=true;
     // Original launcher/observer receives an actual failed CLI process. No
     // fake role/readiness evidence or fallback capabilities are supplied.
     return originalSpawn.call(this,process.execPath,['--eval','process.stderr.write("injected resume Docker observation failure\\n");process.exit(77)'],options);
    }
   }
   return originalSpawn.call(this,executable,args,options);
  };syncBuiltinESMExports();
 }
 let terminalCompleted;try{if(mode==='plan-commit-loss'){terminalCompleted=await api.runEvacuation(plan);assert.equal(terminalCompleted.state,'completed');}else await assert.rejects(api.runEvacuation(plan),error=>{proof.resumeApiRejection={name:error.name,message:error.message,stack:error.stack};return true;});}finally{DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
 assert.equal(resumeInjected,true,'The intended failure boundary was not reached.');assert.ok(failedOperation);
 if(mode==='terminal-afterimage-mutation'){
  assert.ok(proof.resumeApiRejection,'Concurrent terminal mutation must reject the original run.');
  const terminal=phaseCommits.find(row=>row.phase==='published');assert.ok(terminal);const deadline=BigInt(terminal.deadline);let absentAt;
  while(process.hrtime.bigint()<deadline){if((await inventory(targetLabel,projectId)).length===0){await proveAbsent(faultNative);absentAt=process.hrtime.bigint();break;}await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(absentAt&&absentAt<=deadline,'Original guard must retain cleanup ownership through terminal afterimage refusal.');
  // A foreign newer fence is never rolled back or adopted as this attempt's release authority.
  assert.equal(api.control.prepare('SELECT fence FROM clank_deployment_project_fences WHERE project_id=?').get(projectId).fence,proof.externalFence.after);await verifyUnrelated();await proveAbsent(journal.source);await proveAbsent(journal.target);
  const row=api.control.prepare('SELECT state FROM clank_platform_evacuations WHERE id=?').get(plan.id);assert.notEqual(row.state,'completed');
  Object.assign(proof,{ownedRoots:[directory,root,targetRoot],initialCommittedResponseLost:true,mode,terminalMutationRefused:true,guardCleanupByOriginalDeadline:true,deadline:String(deadline),absentAt:String(absentAt),failedRuntime:faultNative,unrelatedProjectStayedRunning:true,resumeJournal:{authenticated:true,phaseCommits},complete:true});
 }else{
 let retry,failedFence=failedOperation.fence,providerState,failedRow;
 if(mode==='plan-commit-loss'){
  failedRow=api.control.prepare('SELECT * FROM clank_deployment_operations WHERE id=?').get(failedOperation.id);assert.equal(failedRow.state,'succeeded');retry=operation();assert.equal(retry.id,failedRow.id);assert.equal(retry.fence,failedFence);assert.equal(phaseCommits.filter(row=>row.phase==='planned').length,1);proof.terminalCommitLossResolved=true;
 }else{
  await proveAbsent(faultNative);await proveAbsent(journal.source);await proveAbsent(journal.target);await verifyUnrelated();
  const placement=api.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(projectId),afterFailure=api.control.prepare('SELECT state,projects FROM clank_platform_evacuations WHERE id=?').get(plan.id);failedRow=api.control.prepare('SELECT * FROM clank_deployment_operations WHERE id=?').get(failedOperation.id);providerState=await target.inspect(projectId);
  assert.equal(placement.assigned_node_id,'native_target');assert.equal(placement.observed_state,'stopped');assert.equal(placement.observed_release_id,null);assert.notEqual(afterFailure.state,'completed');assert.equal(JSON.parse(afterFailure.projects).find(item=>item.projectId===projectId).fallbackState,'stopped');assert.equal(failedRow.state,'cancelled');assert.equal(failedRow.lease_token_hash,null);assert.equal(failedRow.lease_expires_at,null);
  assert.equal(providerState.state,'stopped');assert.equal(providerState.phase,'stopped');assert.equal(providerState.generation,2);assert.equal(providerState.releaseId,null);assert.equal(providerState.capsuleSha256,null);
  const failedData=JSON.parse(fs.readFileSync(join(targetRoot,'projects',projectId,'state.json'),'utf8'));if(mode==='early-admission-failure')assert.ok(failedData.active.fence<failedFence);
  if(mode==='cold-stopped'){
   assert.equal(typeof process.send,'function','Cold checkpoint requires its supervising native runner.');
   const head=api.control.prepare('SELECT * FROM clank_platform_fallback_resume_heads WHERE predecessor_id=? ORDER BY attempt DESC LIMIT 1').get(operationId);
   assert.equal(head.phase,'stopped');
   const stopped=api.control.prepare('SELECT journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?').get(head.resume_id,head.revision),record=JSON.parse(stopped.journal);
   assert.equal(record.phase,'stopped');assert.equal(record.selected,'target');assert.equal(record.intent.roles.length,4);
   assert.equal(createHmac('sha256',key).update('clank-provider-fallback-resume-attempt/1\n'+stopped.journal).digest('hex'),stopped.authentication);assert.equal(head.authentication,stopped.authentication);
   assert.equal(record.settlement.placement,JSON.stringify(placement));assert.equal(record.settlement.operation,JSON.stringify(failedRow));
   const checkpoint={protocol:'clank-native-cold-stopped-fixture/1',directory,root,targetRoot,keyPath,configDirectory,image,label,targetLabel,projectId,plan,
    credentials:api.restartState(plan),retained,stopped,head,source:journal.source,target:journal.target,failedRuntime:faultNative,unrelated:unrelatedNative,
    baselineRows:beforeRows,providerOptions:{source:{rootDirectory:root,owner:label,image,docker:{...docker,portStart:47260,portEnd:47265}},target:{rootDirectory:targetRoot,owner:targetLabel,image,docker:{...docker,portStart:47460,portEnd:47465}}},
    controller:{pid:process.pid,birth:nativeBirth(process.pid)},controlIdentity:record.controlIdentity,daemonId:journal.source.daemonId};
   const checkpointPath=join(directory,'cold-stopped-checkpoint.json'),fd=fs.openSync(checkpointPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   try{fs.writeFileSync(fd,JSON.stringify(checkpoint));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   const keyFd=fs.openSync(keyPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(keyFd);}finally{fs.closeSync(keyFd);}
   const directoryFd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
   await new Promise((resolve,reject)=>process.send({event:'cold-stopped-checkpoint',path:checkpointPath},error=>error?reject(error):resolve()));
   // Parent sends actual SIGKILL only after independent durable-state validation.
   // Do not close providers: the unrelated original container must survive it.
   await new Promise(()=>{});
  }
  DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath)captureJournalCommit(this);return originalExec.call(this,sql);};
  try{const completed=await api.runEvacuation(plan);assert.equal(completed.state,'completed');assert.equal(completed.projects.find(item=>item.projectId===projectId).fallbackState,'running');}finally{DatabaseSync.prototype.exec=originalExec;}
  retry=operation();assert.notEqual(retry.id,failedRow.id);assert.equal(retry.state,'succeeded');assert.equal(retry.fence,failedFence+1);
  proof.failedRuntimeAbsentBeforeRetry=true;proof.validStoppedState=providerState;
 }
 const fresh=nativeSync(targetLabel,projectId);assert.equal(fresh.roles.length,4);if(mode==='plan-commit-loss')assert.deepEqual(fresh.roles.map(role=>role.containerId).sort(),faultNative.roles.map(role=>role.containerId).sort());else assert.ok(fresh.roles.every(role=>!faultNative.roles.some(old=>old.containerId===role.containerId)));await inspectRoles(fresh);await verifyUnrelated();await proveAbsent(journal.source);await proveAbsent(journal.target);
 const histories=api.control.prepare('SELECT resume_id,revision,phase,journal,authentication FROM clank_platform_fallback_resume_records WHERE predecessor_id=? ORDER BY attempt,revision').all(operationId),byAttempt=new Map();
 for(const row of histories){assert.equal(createHmac('sha256',key).update('clank-provider-fallback-resume-attempt/1\n'+row.journal).digest('hex'),row.authentication);const list=byAttempt.get(row.resume_id)??[];assert.equal(row.revision,list.length+1);const data=JSON.parse(row.journal);assert.equal(data.previousAuthentication,list.at(-1)?.authentication??null);list.push(row);byAttempt.set(row.resume_id,list);}
 const lists=[...byAttempt.values()];assert.deepEqual(lists.at(-1).map(row=>row.phase),['planned','claimed','staged','running','published']);if(mode!=='plan-commit-loss')assert.equal(lists[0].at(-1).phase,'stopped');assert.ok(phaseCommits.some(row=>row.phase==='staged'&&row.allRolesNeverStarted));assert.ok(phaseCommits.some(row=>row.phase==='published'&&row.atomicPlanAfterimage));
 proof.resumeJournal={authenticated:true,appendOnly:true,phaseCommits,histories:histories.map(({journal,...row})=>({...row,data:JSON.parse(journal)})),allRolesCreatedBeforeStart:true,terminalPlanAtomic:true};
 const write=await publicRequest('/write');assert.equal(write.status,200,await write.text());
 const expectedWrites=[];for(const role of fresh.roles){const inspected=JSON.parse((await command(['container','inspect',role.containerId])).stdout)[0];expectedWrites.push({role:role.role,host:inspected.Config.Hostname});}
 const writeDeadline=performance.now()+5000;let rows;for(;;){const response=await publicRequest('/');assert.equal(response.status,200);rows=await response.json();if(expectedWrites.every(role=>rows.some(row=>row.role===role.role&&row.host===role.host&&row.value==='line one\nline two')))break;assert.ok(performance.now()<writeDeadline,'Fresh resumed role did not write its own environment within the fixture observation budget.');await new Promise(resolve=>setTimeout(resolve,25));}
 Object.assign(proof,{ownedRoots:[directory,root,targetRoot],initialCommittedResponseLost:true,mode,failureBoundary:mode,failedOperation:{id:failedRow.id,state:failedRow.state,fence:failedFence},failedRuntime:faultNative,retry:{id:retry.id,state:retry.state,fence:retry.fence},independentTargetRoles:fresh.roles,targetRolesWroteOwnEnvironment:true,unrelatedProjectStayedRunning:true,complete:true});
 }
}catch(error){failure=error;proof.failure={message:error.message,stack:error.stack,causes:error.errors?.map(error=>error.message)};}
finally{
 DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();
 const cleanupErrors=[];for(const close of [()=>api?.close(),()=>sourceServer?.close(),()=>targetServer?.close(),()=>target?.close(),()=>service?.close()])try{await close();}catch(error){cleanupErrors.push(error.message);failure??=error;}
 if(cleanupErrors.length)proof.cleanupFailures=cleanupErrors;
 try{proof.remaining=[];for(const owner of [label,targetLabel]){const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}'])).stdout.trim();if(ids)proof.remaining.push({owner,ids});}}catch(error){failure??=error;proof.inventoryFailure=error.message;}
 proof.pins=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root)||path.startsWith(targetRoot)?[fd]:[];}catch{return[];}}).length;if(failure||proof.remaining?.length||proof.pins)proof.complete=false;console.log(JSON.stringify(proof));
}
if(failure||proof.remaining?.length||proof.pins)process.exitCode=1;
