// Invoked by the root native runner after a retained fallback checkpoint, never as a unit test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openPlatform} from '../../dist/platform.js';
import {recoverProviderFallback} from '../../dist/provider-fallback-coordinator.js';
import {acquireProviderServiceOwnership} from '../../dist/provider-handoff.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
export async function recoverNativeFallbackCheckpoint(checkpointPath){
 const input=JSON.parse(fs.readFileSync(checkpointPath,'utf8')),key=new Uint8Array(fs.readFileSync(input.keyPath)),journal=JSON.parse(input.journal);
 const reserved=journal.phase==='reserved',early=['stopping','stopped'].includes(journal.phase),targetRoles=journal.target?.roles??journal.launchIntent?.roles??[];
 assert.ok(['reserved','stopping','stopped','launching','prepared'].includes(journal.phase));
 const client=providerDockerClient({dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.configDirectory}}),command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:1024*1024});
 assert.equal(JSON.parse((await command(['info','--format','{{json .ID}}'])).stdout),input.daemonId);
 const proof={directory:input.directory,mode:input.mode,phase:journal.phase,qualification:'Original signed phase recovery with native all-role evidence: untouched source cancellation, source STOPPED settlement, or target STOPPED settlement. The independent observer verifies target absence by the original deadline. This core slice does not claim subsequent writer startup or cross-host recovery.',complete:false};
 let runtime,sourceOwner,targetOwner,control,failure;
 const birth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
 const inventory=async(owner,project)=>((await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--filter','label=run.clank.project='+project,'--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean)).sort();
 const proveRunning=async role=>{
  const rows=JSON.parse((await command(['container','inspect',role.containerId])).stdout);assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.Id,role.containerId);assert.equal(row.State.Running,true);assert.equal(row.State.Status,'running');assert.equal(row.State.Pid,role.pid);assert.equal(birth(role.pid),role.birth);
  assert.equal(fs.readFileSync('/proc/'+role.pid+'/cgroup','utf8').trim(),'0::'+role.cgroup.slice('/sys/fs/cgroup'.length));assert.ok(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim().split('\n').includes(String(role.pid)));
 };
 const proveAbsent=async roles=>{
  const all=(await command(['container','ls','--all','--no-trunc','--format','{{.ID}}'])).stdout.trim().split('\n');
  for(const role of roles){
   assert.ok(!all.includes(role.containerId),'Retained role container remains: '+role.containerId);
   if(role.pid)try{assert.notEqual(birth(role.pid),role.birth);}catch(error){if(error.code!=='ENOENT')throw error;}
   for(const cgroup of [role.cgroup,'/sys/fs/cgroup/system.slice/docker-'+role.containerId+'.scope','/sys/fs/cgroup/docker/'+role.containerId].filter(Boolean))try{assert.equal(fs.readFileSync(cgroup+'/cgroup.procs','utf8').trim(),'');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 };
 const unrelated=async()=>{
  assert.ok(input.unrelatedNative?.length);assert.deepEqual(await inventory(input.label,'unrelated_source'),input.unrelatedIds);
  const records=[];
  for(const role of input.unrelatedNative){
   await proveRunning(role);
   const beforeResponse=await fetch(role.url+'/',{signal:AbortSignal.timeout(10000)});assert.equal(beforeResponse.status,200);const before=await beforeResponse.json(),previous=before.at(-1)?.id??0;
   const write=await fetch(role.url+'/write',{signal:AbortSignal.timeout(10000)});assert.equal(write.status,200);await write.arrayBuffer();
   const afterResponse=await fetch(role.url+'/',{signal:AbortSignal.timeout(10000)});assert.equal(afterResponse.status,200);const after=await afterResponse.json();
   const fresh=after.find(row=>row.id>previous&&row.role==='web'&&row.host===role.host&&row.value==='line one\nline two');assert.ok(fresh,'Unrelated original process did not perform a fresh write.');
   await proveRunning(role);records.push({containerId:role.containerId,pid:role.pid,birth:role.birth,recordId:fresh.id});
  }
  return records;
 };
 try{
  // Read-only observation continues beyond the original deadline to detect late starts.
  // No cleanup performed by this helper can count toward that acceptance bound.
  const observationUntil=BigInt(journal.deadline)+8000000000n;
  while(!fs.existsSync(input.deadlineObservation)){assert.ok(process.hrtime.bigint()<observationUntil,'Independent deadline observation did not finish.');await new Promise(resolve=>setTimeout(resolve,50));}
  const observation=JSON.parse(fs.readFileSync(input.deadlineObservation,'utf8'));
  assert.equal(observation.originalDeadline,journal.deadline);assert.equal(observation.complete,true,observation.failure);assert.equal(observation.phase,journal.phase);
  if(targetRoles.length)assert.deepEqual(observation.expectedRoleIds.sort(),targetRoles.map(role=>role.containerId).sort());
  if(input.mode==='controller-loss-partial-target'){
   assert.ok(input.partialLaunchBoundary?.running.length>=1&&input.partialLaunchBoundary.running.length<=3);assert.ok(input.partialLaunchBoundary.neverStarted.length>=1);
   assert.deepEqual([...input.partialLaunchBoundary.running.map(role=>role.containerId),...input.partialLaunchBoundary.neverStarted].sort(),targetRoles.map(role=>role.containerId).sort());
   assert.ok(input.partialLaunchBoundary.running.every(role=>observation.observedStartedIds.includes(role.containerId)),'Partial target start was not independently observed.');proof.partialLaunchBoundary=input.partialLaunchBoundary;
  }
  proof.independentDeadlineObservation=observation;proof.independentWatchdogRemovedTarget=true;
  proof.unrelatedBeforeRecovery=await unrelated();
  runtime=await openPlatform({dataDirectory:join(input.directory,'platform'),publicUrl:'http://127.0.0.1:47451',masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:47451,appPortEnd:47460,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'native-platform-registration-12345678901234567890',placement:{}}});
  sourceOwner=await acquireProviderServiceOwnership(input.root);targetOwner=await acquireProviderServiceOwnership(input.targetRoot);
  await assert.rejects(recoverProviderFallback(runtime,input.journal,input.authentication.replace(/^./u,input.authentication[0]==='0'?'1':'0'),sourceOwner,targetOwner,client),/authentication/);proof.changedSignatureRefused=true;
  await recoverProviderFallback(runtime,input.journal,input.authentication,sourceOwner,targetOwner,client);
  control=new DatabaseSync(join(input.directory,'platform','control.sqlite'),{readOnly:true});
  const placement=control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(input.projectId),handoff=control.prepare('SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?').get(input.operationId);
  const expected=reserved?journal.placement:early?journal.sourceStoppedPlacement:journal.stoppedPlacement;
  assert.deepEqual({...placement},expected);assert.equal(handoff.state,reserved||early?'cancelled':'committed');
  // An exact retry reconfirms its authenticated outcome without publishing a writer.
  await recoverProviderFallback(runtime,input.journal,input.authentication,sourceOwner,targetOwner,client);
  assert.deepEqual({...control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(input.projectId)},expected);
  assert.deepEqual(await inventory(input.targetLabel,input.projectId),[]);await proveAbsent(targetRoles);
  if(reserved){assert.deepEqual(await inventory(input.label,input.projectId),journal.source.roles.map(role=>role.containerId).sort());for(const role of journal.source.roles)await proveRunning(role);proof.untouchedSourceStayedRunning=true;}
  else{assert.deepEqual(await inventory(input.label,input.projectId),[]);await proveAbsent(journal.source.roles);proof.staleRetryStayedStopped=true;}
  if(!reserved){const binding=early?journal.endpointBindings.source:journal.endpointBindings.target;assert.equal(fs.existsSync(join(binding.serviceDirectory,input.projectId+'.evacuation.json')),false);if(early)assert.equal(fs.existsSync(join(binding.serviceDirectory,input.projectId+'.fallback-source.json')),false);proof.authenticatedAdmissionBarrierRetired=true;}
  proof.unrelatedAfterRecovery=await unrelated();proof.unrelatedProjectStayedRunning=true;
  for(let index=0;index<proof.unrelatedAfterRecovery.length;index++)assert.ok(proof.unrelatedAfterRecovery[index].recordId>proof.unrelatedBeforeRecovery[index].recordId);
  proof.settlement={nodeId:placement.assigned_node_id,generation:placement.generation,state:placement.observed_state,reservation:handoff.state};
 }catch(error){failure=error;proof.failure={message:error.message,stack:error.stack,causes:error.errors?.map(error=>error.message)};}
 finally{
  control?.close();for(const close of [()=>sourceOwner?.close(),()=>targetOwner?.close(),()=>runtime?.close()])try{await close();}catch(error){failure??=error;(proof.closeFailures??=[]).push(error.message);}
  // Test-owned cleanup uses only the exact retained source/target/unrelated CID roster.
  const ids=[...new Set([...journal.source.roles,...targetRoles].map(role=>role.containerId).concat(input.unrelatedIds))];
  try{if(ids.length)await runProviderDockerClient(client,['container','rm','--force',...ids],{timeoutMs:15000,maxOutputBytes:65536,allowFailure:true});proof.remaining=[];for(const owner of [input.label,input.targetLabel]){const output=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--format','{{.ID}}'])).stdout.trim();if(output)proof.remaining.push({owner,ids:output});}}catch(error){failure??=error;proof.cleanupFailure=error.message;}
  proof.pins=fs.readdirSync('/proc/self/fd').filter(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(input.root)||path.startsWith(input.targetRoot);}catch{return false;}}).length;key.fill(0);
 }
 proof.complete=!failure&&!proof.remaining?.length&&!proof.pins;
 if(!proof.complete)throw Object.assign(new Error('Native fallback recovery did not complete.'),{proof});return proof;
}
