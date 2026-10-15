// Fresh process only: authenticate retained STOPPED state before either factory opens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {openPlatform} from '../../dist/platform.js';
import {createDeploymentCoordinatorClient} from '../../dist/runner.js';
import {serve} from '../../dist/node.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {nativeFallbackSourceRevocationState} from './provider-platform-api-native.mjs';

assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const checkpointPath=resolve(process.argv[2]),checkpointStat=fs.lstatSync(checkpointPath);
assert.ok(checkpointStat.isFile()&&!checkpointStat.isSymbolicLink());assert.equal(checkpointStat.uid,process.getuid());assert.equal(checkpointStat.mode&0o777,0o600);assert.equal(checkpointStat.nlink,1);
const input=JSON.parse(fs.readFileSync(checkpointPath,'utf8'));assert.equal(input.protocol,'clank-native-cold-stopped-fixture/1');
const key=new Uint8Array(fs.readFileSync(input.keyPath)),controlPath=join(input.directory,'platform','control.sqlite'),origin='http://127.0.0.1:47451';
const hash=value=>createHash('sha256').update(value).digest('hex'),authenticate=(domain,journal,authentication)=>assert.equal(createHmac('sha256',key).update(domain+'\n'+journal).digest('hex'),authentication);
// Public CI diagnostics contain only fixed categories and code locations. Raw
// messages/API bodies remain in the private result file because they can hold
// credentials; hashes let maintainers match static errors without printing them.
const diagnostic=(error,depth=0)=>{
 const name=['Error','AssertionError','AggregateError','TypeError','RangeError','AbortError','TimeoutError','PlatformError','PlatformLocalProviderCloseError'].includes(error?.name)?error.name:'Error';
 const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)?error.code:undefined;
 const locations=[...String(error?.stack??'').matchAll(/(?:dist|src|tests\/fixtures)\/([a-z0-9.-]+\.(?:js|ts|mjs)):(\d+):(\d+)/gu)].slice(0,8).map(match=>({file:match[1],line:Number(match[2]),column:Number(match[3])}));
 return {name,...(code?{code}:{}),...(Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?{status:error.status}:{}),
  ...(['open','read','stat','lstat','realpath','readdir','readlink'].includes(error?.syscall)?{syscall:error.syscall}:{}),
  ...(['unresolved-root','service-close'].includes(error?.kind)?{kind:error.kind}:{}),messageSha256:hash(String(error?.message??error??'')),locations,
  ...(depth<2&&Array.isArray(error?.errors)?{causes:error.errors.slice(0,4).map(cause=>diagnostic(cause,depth+1))}:{})};
};
const client=providerDockerClient({dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.configDirectory}});
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:4*1024*1024});
const birth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
const allRows=async()=>{const ids=(await command(['container','ls','--all','--no-trunc','--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean);assert.ok(ids.length<=1000);return ids.length?JSON.parse((await command(['container','inspect',...ids])).stdout):[];};
const absentProcesses=roles=>{for(const role of roles){if(role.pid)try{assert.notEqual(birth(role.pid),role.birth,'Original process remains live.');}catch(error){if(error.code!=='ENOENT')throw error;}for(const group of [role.cgroup,'/sys/fs/cgroup/system.slice/docker-'+role.containerId+'.scope','/sys/fs/cgroup/docker/'+role.containerId].filter(Boolean))try{assert.equal(fs.readFileSync(group+'/cgroup.procs','utf8').trim(),'','Original cgroup retains a process.');}catch(error){if(error.code!=='ENOENT')throw error;}}};
const records=[input.source,input.target,input.failedRuntime],originalRoles=records.flatMap(record=>record.roles),unrelatedIds=new Set(input.unrelated.roles.map(role=>role.containerId));
let preflightComplete=false,runtime,server,control,heartbeat,heartbeatTail=Promise.resolve(),heartbeatFailure,failure;
const proof={protocol:'clank-native-cold-restart-result/1',process:process.pid,version:process.version,complete:false,stage:'validate-checkpoint',qualification:'Actual process restart from authenticated STOPPED; native role writes use inspected Docker loopback ports. Public provider ingress and cross-host recovery are not claimed.'};
const originalSpawn=childProcess.spawn,removals=[];
const webRequest=async(row,path)=>{const ports=Object.values(row.NetworkSettings.Ports??{}).flatMap(value=>value??[]).filter(port=>port.HostIp==='127.0.0.1');assert.equal(ports.length,1);const response=await fetch('http://127.0.0.1:'+ports[0].HostPort+path,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return path==='/'?response.json():response.text();};
const verifyUnrelated=async()=>{const rows=await allRows(),observed=[];for(const role of input.unrelated.roles){const row=rows.find(row=>row.Id===role.containerId);assert.ok(row);assert.equal(row.State.Status,'running');assert.equal(row.State.Pid,role.pid);assert.equal(birth(role.pid),role.birth);assert.equal(fs.readFileSync('/proc/'+role.pid+'/cgroup','utf8').trim(),'0::'+role.cgroup.slice('/sys/fs/cgroup'.length));assert.ok(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim().split('\n').includes(String(role.pid)));const before=await webRequest(row,'/'),last=before.at(-1)?.id??0;await webRequest(row,'/write');const after=await webRequest(row,'/');assert.ok(after.some(value=>value.id>last&&value.host===row.Config.Hostname&&value.role==='web'));observed.push({containerId:row.Id,pid:role.pid,birth:role.birth,lastRecord:after.at(-1).id});}return observed;};
try{
 try{assert.notEqual(birth(input.controller.pid),input.controller.birth,'First controller still exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
 assert.notEqual(process.pid,input.controller.pid);proof.originalControllerAbsent=true;
 assert.equal(JSON.parse((await command(['info','--format','{{json .ID}}'])).stdout),input.daemonId);
 authenticate('clank-provider-fallback/1',input.retained.journal,input.retained.authentication);
 authenticate('clank-provider-fallback-resume-attempt/1',input.stopped.journal,input.stopped.authentication);
 const stopped=JSON.parse(input.stopped.journal);assert.equal(stopped.phase,'stopped');assert.equal(stopped.selected,'target');assert.equal(stopped.intent.roles.length,4);
 const file=fs.lstatSync(controlPath),parent=fs.lstatSync(join(input.directory,'platform'));
 assert.deepEqual({canonicalPath:fs.realpathSync(controlPath),databaseDev:file.dev,databaseIno:file.ino,parentDev:parent.dev,parentIno:parent.ino,uid:file.uid},input.controlIdentity);
 // This observer is closed before openPlatform so it cannot make constructor FD
 // provenance ambiguous or interfere with SQLite's process-wide lock ownership.
 const observer=new DatabaseSync(controlPath,{readOnly:true});
 try{
  assert.deepEqual({...observer.prepare('SELECT * FROM clank_platform_fallback_resume_heads WHERE resume_id=?').get(input.head.resume_id)},input.head);
  assert.deepEqual({...observer.prepare('SELECT journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?').get(input.head.resume_id,input.head.revision)},input.stopped);
  assert.equal(JSON.stringify(observer.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(input.projectId)),stopped.settlement.placement);
  assert.equal(JSON.parse(stopped.settlement.placement).observed_state,'stopped');assert.equal(JSON.parse(stopped.settlement.operation).state,'cancelled');
  for(const node of input.credentials.nodeImages)assert.deepEqual({...observer.prepare('SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?').get(node.id)},node);
 }finally{observer.close();}
 proof.stage='verify-native-absence';const before=await allRows();
 for(const role of originalRoles)assert.ok(!before.some(row=>row.Id===role.containerId),'Original source/target CID must be absent before factory admission.');
 absentProcesses(originalRoles);
 const protectedPaths=[...(input.source.paths??[]),...(input.target.paths??[])];assert.ok(protectedPaths.length>=4);
 for(const pin of protectedPaths){const st=fs.lstatSync(pin.path);assert.ok(!st.isSymbolicLink());assert.equal(st.dev,pin.dev);assert.equal(st.ino,pin.ino);assert.equal(fs.realpathSync(pin.path),pin.path);}
 for(const row of before){assert.ok(!(row.Config?.Labels?.['run.clank.project']===input.projectId&&[input.label,input.targetLabel].includes(row.Config?.Labels?.['run.clank.owner'])));for(const mount of row.Mounts??[]){if(!mount.RW)continue;const path=fs.realpathSync(mount.Source),st=fs.statSync(path);assert.ok(!protectedPaths.some(pin=>path===pin.path||path.startsWith(pin.path+'/')||pin.path.startsWith(path+'/')||st.dev===pin.dev&&st.ino===pin.ino),'Project has a competing writable mount before factory admission.');}}
 proof.unrelatedBefore=await verifyUnrelated();preflightComplete=true;
 proof.beforeFactory={sourceCidsAbsent:input.source.roles.length,allOriginalCidsAbsent:originalRoles.length,processBirthAndCgroupsAbsent:true,projectWritableMountsAbsent:true,controlIdentityUnchanged:true,stoppedAuthenticationVerified:true};
 childProcess.spawn=function(executable,args,options){if(executable==='docker'&&args?.[0]==='container'&&args[1]==='rm'){assert.equal(preflightComplete,true);const ids=args.slice(2).filter(value=>!value.startsWith('-'));assert.ok(ids.every(id=>/^[a-f0-9]{64}$/u.test(id)&&!unrelatedIds.has(id)),'Cold recovery must not remove unrelated containers.');removals.push(...ids);}return originalSpawn.call(this,executable,args,options);};syncBuiltinESMExports();
 const platformErrors=[];proof.platformErrorDiagnostics=[];proof.stage='open-platform';
 runtime=await openPlatform({onError:error=>{platformErrors.push({name:error.name,message:error.message});proof.platformErrorDiagnostics.push(diagnostic(error));},dataDirectory:join(input.directory,'platform'),publicUrl:origin,masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',platformAdminEmails:['native-api-handoff@example.test'],appPortStart:47451,appPortEnd:47460,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'native-platform-registration-12345678901234567890',localFallback:true,placement:{}}});
 server=await serve(request=>runtime.handle(request),{hostname:'127.0.0.1',port:47451,maxBodySize:100*1024*1024,allowedHosts:['127.0.0.1:47451']});
 control=new DatabaseSync(controlPath,{readOnly:true});control.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000');
 const coordinator=createDeploymentCoordinatorClient({baseUrl:origin}),sessions=[input.credentials.sourceSession,input.credentials.targetSession];
 proof.stage='bind-factories';for(const [index,side] of ['source','target'].entries()){
  const node=input.credentials.nodeImages[index],session=sessions[index];assert.equal(session.node.id,node.id);
  await coordinator.heartbeat(node.id,session.token);
  assert.deepEqual({...control.prepare('SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?').get(node.id)},node);
  await runtime.bindLocalProviderFactory(node.id,session.token,input.providerOptions[side]);
 }
 proof.persistedNodeTokensReused=true;proof.exactFactoriesBound=true;
 heartbeat=setInterval(()=>{heartbeatTail=heartbeatTail.then(async()=>{const revoked=nativeFallbackSourceRevocationState(control,input.credentials.sourceRevocation);if(!revoked)try{await coordinator.heartbeat('native_node',sessions[0].token);}catch(error){if(error?.status!==401||error?.code!=='NODE_AUTH_FAILED'||!nativeFallbackSourceRevocationState(control,input.credentials.sourceRevocation))throw error;}await coordinator.heartbeat('native_target',sessions[1].token);}).catch(error=>{heartbeatFailure??=error;});},1000);heartbeat.unref();
 proof.stage='resume-plan';const response=await fetch(origin+'/api/admin/runners/native_node/evacuations/'+input.plan.id+'/run',{method:'POST',headers:{'content-type':'application/json',origin,cookie:input.credentials.cookie,'x-clank-csrf':input.credentials.csrfToken},body:JSON.stringify({confirmation:input.plan.id}),signal:AbortSignal.timeout(60000)}),body=await response.json();
 proof.resumeResponse={status:response.status,...(body.error?{error:diagnostic(body.error)}:{})};
 const planReadback=control.prepare('SELECT state,phase,error FROM clank_platform_evacuations WHERE id=?').get(input.plan.id);
 proof.planReadback={state:['planned','running','failed','completed','cancelled'].includes(planReadback?.state)?planReadback.state:'other',phase:['planned','quiescing','fenced','completed','failed','cancelled'].includes(planReadback?.phase)?planReadback.phase:'other',...(planReadback?.error?{error:diagnostic(planReadback.error)}:{})};
 assert.equal(response.status,200,JSON.stringify({response:body,platformErrors}));assert.equal(body.plan.id,input.plan.id);assert.equal(body.plan.state,'completed');assert.equal(body.plan.projects.find(item=>item.projectId===input.projectId).fallbackState,'running');
 proof.persistedAdminSessionReused=true;proof.persistedPlanCompleted=true;proof.stage='verify-terminal';
 const head=control.prepare('SELECT * FROM clank_platform_fallback_resume_heads WHERE predecessor_id=? ORDER BY attempt DESC LIMIT 1').get(input.retained.operation_id);
 assert.equal(head.phase,'published');assert.ok(head.attempt>input.head.attempt);
 const rows=control.prepare('SELECT revision,phase,journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? ORDER BY revision').all(head.resume_id);assert.deepEqual(rows.map(row=>row.phase),['planned','claimed','staged','running','published']);
 let previous=null;for(const row of rows){authenticate('clank-provider-fallback-resume-attempt/1',row.journal,row.authentication);assert.equal(JSON.parse(row.journal).previousAuthentication,previous);previous=row.authentication;}assert.equal(head.authentication,previous);
 const terminal=JSON.parse(rows.at(-1).journal),plan=control.prepare('SELECT projects FROM clank_platform_evacuations WHERE id=?').get(input.plan.id);assert.equal(plan.projects,terminal.publication);
 proof.stage='verify-native-writes';const native=await allRows(),fresh=native.filter(row=>row.Config?.Labels?.['run.clank.owner']===input.targetLabel&&row.Config?.Labels?.['run.clank.project']===input.projectId);
 assert.equal(fresh.length,4);assert.deepEqual(fresh.map(row=>row.Id).sort(),terminal.running.roles.map(role=>role.containerId).sort());assert.deepEqual(fresh.map(row=>row.Config.Labels['run.clank.role']+':'+row.Config.Labels['run.clank.instance']).sort(),['scheduler:0','web:0','worker:0','worker:1']);
 for(const row of fresh){const role=terminal.running.roles.find(role=>role.containerId===row.Id);assert.ok(!originalRoles.some(old=>old.containerId===row.Id));assert.equal(row.State.Status,'running');assert.equal(row.State.Pid,role.pid);assert.equal(birth(role.pid),role.birth);assert.equal(fs.readFileSync('/proc/'+role.pid+'/cgroup','utf8').trim(),'0::'+role.cgroup.slice('/sys/fs/cgroup'.length));assert.ok(fs.readFileSync(role.cgroup+'/cgroup.procs','utf8').trim().split('\n').includes(String(role.pid)));assert.equal(row.HostConfig.Memory,384*1024*1024);assert.equal(row.HostConfig.NanoCpus,500000000);assert.equal(row.HostConfig.PidsLimit,96);assert.ok(row.Config.Env.includes('MULTILINE=line one\nline two'));}
 const web=fresh.find(row=>row.Config.Labels['run.clank.role']==='web');await webRequest(web,'/write');const until=performance.now()+5000;let ledger;
 for(;;){ledger=await webRequest(web,'/');if(fresh.every(row=>ledger.some(value=>value.role===row.Config.Labels['run.clank.role']&&value.host===row.Config.Hostname&&value.value==='line one\nline two')))break;assert.ok(performance.now()<until,'Fresh roles did not commit real writes.');await new Promise(resolve=>setTimeout(resolve,25));}
 for(const row of input.baselineRows)assert.ok(ledger.some(value=>JSON.stringify(value)===JSON.stringify(row)),'Known source ledger changed.');
 proof.unrelatedAfter=await verifyUnrelated();absentProcesses(originalRoles);
 Object.assign(proof,{persistedAdminSessionReused:true,persistedPlanCompleted:true,terminal:{resumeId:head.resume_id,attempt:head.attempt,revision:head.revision,journalSha256:hash(rows.at(-1).journal),authenticated:true,planAfterimageExact:true},freshRoles:terminal.running.roles,allFreshRolesWrote:true,knownLedgerRetained:true,unrelatedPreserved:true,removals});
} catch(error){failure=error;proof.failedStage=proof.stage;proof.failureDiagnostic=diagnostic(error);proof.failure={name:error.name,message:error.message,stack:error.stack};}
finally{
 clearInterval(heartbeat);await heartbeatTail;if(heartbeatFailure){failure??=heartbeatFailure;proof.heartbeatFailure=heartbeatFailure.message;}
 proof.stage='close-platform';control?.close();for(const close of [()=>runtime?.close(),()=>server?.close()])try{await close();}catch(error){failure??=error;(proof.closeFailures??=[]).push(error.message);(proof.closeDiagnostics??=[]).push(diagnostic(error));}
 childProcess.spawn=originalSpawn;syncBuiltinESMExports();key.fill(0);
 try{const remaining=await allRows();proof.remainingProjectIds=remaining.filter(row=>[input.label,input.targetLabel].includes(row.Config?.Labels?.['run.clank.owner'])&&row.Config?.Labels?.['run.clank.project']===input.projectId).map(row=>row.Id);assert.equal(proof.remainingProjectIds.length,0);proof.unrelatedAfterClose=await verifyUnrelated();}catch(error){failure??=error;proof.cleanupFailure=error.message;}
 const pinTargets=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const target=fs.readlinkSync('/proc/self/fd/'+fd);return target.startsWith(input.directory+'/')?[target]:[];}catch{return [];}});
 proof.pins=pinTargets.length;proof.pinCategories={};for(const target of pinTargets){const category=target===controlPath?'control-database':target===controlPath+'-wal'?'control-wal':target===controlPath+'-shm'?'control-shm':target===join(input.directory,'platform')?'platform-directory':target.startsWith(join(input.directory,'platform')+'/')?'platform-other':target===input.root||target.startsWith(input.root+'/')?'source-provider':target===input.targetRoot||target.startsWith(input.targetRoot+'/')?'target-provider':'fixture-other';proof.pinCategories[category]=(proof.pinCategories[category]??0)+1;}
 proof.complete=!failure&&proof.pins===0;
 if(proof.complete)proof.stage='complete';
 fs.writeFileSync(join(input.directory,'cold-restart-result.json'),JSON.stringify(proof),{mode:0o600});
 process.stdout.write(JSON.stringify({event:'cold-restart-result',complete:proof.complete,path:join(input.directory,'cold-restart-result.json')})+'\n');
}
if(!proof.complete)process.exitCode=1;
