// Opt-in real Linux/Docker process-death proof. Never replaces native evidence with mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST,'1','Requires CLANK_DISPOSABLE_TEST_HOST=1 on an owned disposable host.');
assert.equal(process.platform,'linux');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const image=process.argv[2];assert.match(image,/@sha256:[a-f0-9]{64}$/u,'Supply a pre-pulled immutable Node image.');
const repo=fileURLToPath(new URL('../',import.meta.url));
const docker=args=>{const result=spawnSync('docker',args,{env:{...process.env,DOCKER_HOST:'unix:///var/run/docker.sock'},encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout;};
const daemonId=JSON.parse(docker(['info','--format','{{json .ID}}']));assert.equal(typeof daemonId,'string');assert.ok(daemonId.length>0);
const inspected=JSON.parse(docker(['image','inspect',image]));assert.equal(inspected.length,1);assert.ok(inspected[0].RepoDigests.includes(image),'Image must already exist under its immutable repository digest.');
assert.ok(fs.existsSync('/sys/fs/cgroup/cgroup.controllers'),'Native cgroup v2 is required.');
const logs=fs.mkdtempSync('/var/tmp/clank-cold-run-');fs.chmodSync(logs,0o700);
let owned,checkpoint,state,producer,consumer,failure;const summary={protocol:'clank-native-cold-stopped-run/1',version:process.version,daemonId,image,complete:false,logs};
const runChild=(fixture,args,name,onMessage)=>{
 const out=fs.openSync(join(logs,name+'.stdout'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600),err=fs.openSync(join(logs,name+'.stderr'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
 const child=fork(join(repo,'tests','fixtures',fixture),args,{cwd:repo,env:{...process.env,DOCKER_HOST:'unix:///var/run/docker.sock'},stdio:['ignore',out,err,'ipc'],execArgv:[]});fs.closeSync(out);fs.closeSync(err);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 if(onMessage)child.on('message',onMessage);
 const timer=setTimeout(()=>child.kill('SIGKILL'),240000);done.finally(()=>clearTimeout(timer)).catch(()=>{});
 return {child,done};
};
try{
 let resolveCheckpoint,rejectCheckpoint;const ready=new Promise((resolve,reject)=>{resolveCheckpoint=resolve;rejectCheckpoint=reject;});
 producer=runChild('provider-fallback-resume-journal-native.mjs',[image,'cold-stopped'],'producer',message=>{
  try{
   if(message?.event==='cold-fixture-start'){
    assert.match(message.directory,/^\/var\/tmp\/clank-fallback-resume-journal-[A-Za-z0-9]+$/u);assert.match(message.label,/^fallback_[a-f0-9-]{36}$/u);assert.equal(message.targetLabel,message.label+'_target');owned=message;
   }
   if(message?.event==='cold-stopped-checkpoint'){
    assert.ok(owned);assert.equal(message.path,join(owned.directory,'cold-stopped-checkpoint.json'));checkpoint=message.path;resolveCheckpoint(checkpoint);
   }
  }catch(error){rejectCheckpoint(error);}
 });
 const stopped=await Promise.race([ready,producer.done.then(result=>{throw new Error('Producer exited before durable STOPPED checkpoint: '+JSON.stringify(result));})]);
 const stat=fs.lstatSync(stopped);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.uid,1000);assert.equal(stat.mode&0o777,0o600);assert.equal(stat.nlink,1);
 const input=JSON.parse(fs.readFileSync(stopped,'utf8'));state=input;assert.equal(input.controller.pid,producer.child.pid);assert.equal(input.daemonId,daemonId);assert.equal(input.directory,owned.directory);assert.equal(input.image,image);
 const key=fs.readFileSync(input.keyPath);try{
  assert.equal(createHmac('sha256',key).update('clank-provider-fallback-resume-attempt/1\n'+input.stopped.journal).digest('hex'),input.stopped.authentication);
  const record=JSON.parse(input.stopped.journal);assert.equal(record.phase,'stopped');assert.equal(JSON.parse(record.settlement.placement).observed_state,'stopped');assert.equal(JSON.parse(record.settlement.operation).state,'cancelled');
  const db=new DatabaseSync(join(input.directory,'platform','control.sqlite'),{readOnly:true});try{
   assert.deepEqual({...db.prepare('SELECT * FROM clank_platform_fallback_resume_heads WHERE resume_id=?').get(input.head.resume_id)},input.head);assert.equal(input.head.phase,'stopped');
   assert.deepEqual({...db.prepare('SELECT journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?').get(input.head.resume_id,input.head.revision)},input.stopped);
   assert.equal(JSON.stringify(db.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(input.projectId)),record.settlement.placement);
  }finally{db.close();}
 }finally{key.fill(0);}
 producer.child.kill('SIGKILL');const killed=await producer.done;assert.equal(killed.signal,'SIGKILL');assert.equal(killed.code,null);summary.firstProcessKilledAfterDurableStopped=true;
 consumer=runChild('provider-fallback-cold-restart-native.mjs',[checkpoint],'consumer');const result=await consumer.done;
 const evidence=JSON.parse(fs.readFileSync(join(owned.directory,'cold-restart-result.json'),'utf8'));summary.proof=evidence;assert.equal(result.code,0,'Fresh process failed; private diagnostics: '+logs);assert.equal(result.signal,null);assert.equal(evidence.complete,true);
 assert.equal(evidence.persistedNodeTokensReused,true);assert.equal(evidence.persistedAdminSessionReused,true);assert.equal(evidence.persistedPlanCompleted,true);assert.equal(evidence.unrelatedPreserved,true);assert.equal(evidence.allFreshRolesWrote,true);assert.equal(evidence.terminal.authenticated,true);assert.equal(evidence.terminal.planAfterimageExact,true);assert.equal(evidence.beforeFactory.projectWritableMountsAbsent,true);assert.ok(evidence.activeCloseRace.observedStartedTargetRoles>=1);assert.equal(evidence.activeCloseRace.freshRolesWroteBeforeClose,true);assert.equal(evidence.activeCloseRace.closeWaitedForActiveResume,true);assert.equal(evidence.activeCloseRace.planCompletedDuringClose,true);assert.equal(evidence.activeCloseRace.platformCloseCompletedAfterResume,true);assert.equal(evidence.pins,0);
 summary.proof=evidence;summary.checkpointDirectory=owned.directory;
}catch(error){failure=error;summary.failure={name:error.name,message:error.message};}
finally{
 for(const running of [producer,consumer])if(running&&running.child.exitCode===null&&running.child.signalCode===null){running.child.kill('SIGKILL');await running.done.catch(()=>{});}
 if(owned)try{
  // Only this fixture's exact freshly generated owner labels may select cleanup.
  const ids=[];for(const owner of [owned.label,owned.targetLabel]){const found=docker(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);for(const id of found){assert.match(id,/^[a-f0-9]{64}$/u);const row=JSON.parse(docker(['container','inspect',id]))[0];assert.equal(row.Config.Labels['run.clank.owner'],owner);assert.ok(row.Mounts.some(mount=>mount.Source.startsWith(owned.directory+'/')));ids.push(id);}}
  if(ids.length)docker(['container','rm','--force',...ids]);
  for(const owner of [owned.label,owned.targetLabel])assert.equal(docker(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}']).trim(),'');
  for(const id of ids)for(const group of ['/sys/fs/cgroup/system.slice/docker-'+id+'.scope','/sys/fs/cgroup/docker/'+id])try{assert.equal(fs.readFileSync(group+'/cgroup.procs','utf8').trim(),'');}catch(error){if(error.code!=='ENOENT')throw error;}
  const knownRoles=[state?.source,state?.target,state?.failedRuntime,state?.unrelated].filter(Boolean).flatMap(value=>value.roles).concat(summary.proof?.freshRoles??[]);
  for(const role of knownRoles){
   if(role.pid)try{const text=fs.readFileSync('/proc/'+role.pid+'/stat','utf8');assert.notEqual(text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19],role.birth,'Recorded native process remains after cleanup.');}catch(error){if(error.code!=='ENOENT')throw error;}
   for(const group of [role.cgroup,'/sys/fs/cgroup/system.slice/docker-'+role.containerId+'.scope','/sys/fs/cgroup/docker/'+role.containerId].filter(Boolean))try{assert.equal(fs.readFileSync(group+'/cgroup.procs','utf8').trim(),'');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  summary.exactOwnedCleanup=true;summary.removedOwnedContainers=ids.length;summary.recordedNativeIdentitiesAbsent=knownRoles.length;
 }catch(error){failure??=error;summary.cleanupFailure=error.message;}
 summary.complete=!failure&&Boolean(summary.proof?.complete)&&summary.exactOwnedCleanup===true;
 fs.writeFileSync(join(logs,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
 // Never print retained node tokens, administrator session, master key or journals.
 const evidence=summary.proof;
 console.log(JSON.stringify({complete:summary.complete,nativeProcessRestart:summary.complete,summary:join(logs,'summary.json'),
  firstProcessKilledAfterDurableStopped:summary.firstProcessKilledAfterDurableStopped,exactOwnedCleanup:summary.exactOwnedCleanup,recordedNativeIdentitiesAbsent:summary.recordedNativeIdentitiesAbsent,
  ...(evidence?{proof:{originalControllerAbsent:evidence.originalControllerAbsent,beforeFactory:evidence.beforeFactory,persistedNodeTokensReused:evidence.persistedNodeTokensReused,exactFactoriesBound:evidence.exactFactoriesBound,persistedAdminSessionReused:evidence.persistedAdminSessionReused,persistedPlanCompleted:evidence.persistedPlanCompleted,activeCloseRace:evidence.activeCloseRace,terminal:evidence.terminal,freshRoles:evidence.freshRoles,allFreshRolesWrote:evidence.allFreshRolesWrote,knownLedgerRetained:evidence.knownLedgerRetained,unrelatedPreserved:evidence.unrelatedPreserved,unrelatedBefore:evidence.unrelatedBefore,unrelatedAfter:evidence.unrelatedAfter,unrelatedAfterClose:evidence.unrelatedAfterClose,pins:evidence.pins,pinCategories:evidence.pinCategories,stage:evidence.stage,failedStage:evidence.failedStage,failureDiagnostic:evidence.failureDiagnostic,platformErrorDiagnostics:evidence.platformErrorDiagnostics,resumeResponse:evidence.resumeResponse,planReadback:evidence.planReadback,closeDiagnostics:evidence.closeDiagnostics,qualification:evidence.qualification}}:{}),
  ...(failure?{failure:'Native assertion failed; raw diagnostics remain in the private fixture directory.'}:{})}));
}
if(!summary.complete)process.exitCode=1;
