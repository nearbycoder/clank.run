import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {linuxProcessBirth} from '../dist/platform-supervisor.js';
import {shadowPlatformFixture,origin,artifact,json,until,deploy,request} from './fixtures/platform-shadow-native.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function stage(f){
  const auth=f.owner,{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id='shadow-key-'+crypto.randomUUID(),credentialId=Buffer.from(id).toString('base64url');
  f.control.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(id,credentialId,auth.user.id,'Native shadow key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const started=await json(f.platform,'/__clank/auth/reauthenticate/passkey/start',{method:'POST',body:{},cookie:auth.cookie,csrf:auth.csrf});
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update('127.0.0.1').digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  await json(f.platform,'/__clank/auth/reauthenticate/passkey/finish',{method:'POST',body:{challengeId:started.challengeId,challenge:started.options.challenge,credential},cookie:auth.cookie,csrf:auth.csrf});
  const bytes=await artifact(f.root,'shadow-candidate'),response=await f.platform.handle(new Request(origin+`/api/projects/${f.project.id}/releases/stage`,{method:'POST',headers:{origin,cookie:auth.cookie,'x-clank-csrf':auth.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':'native-shadow-candidate-0001'},body:bytes}));
  const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));assert.equal(body.release.purpose,'shadow-upload');return body.release;
}
async function source(f,release,reportVersion){
  const child=fork(new URL('./fixtures/platform-shadow-controller.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:join(f.root,'platform'),CLANK_SUPERVISOR_FIXTURE_OPTIONS:JSON.stringify(f.options),CLANK_SHADOW_NATIVE_OWNER:'1',CLANK_SHADOW_NATIVE_INPUT:JSON.stringify({projectId:f.project.id,releaseId:release.id,endpoint:f.endpoint,reportVersion})},stdio:['ignore','pipe','pipe','ipc']});
  const birth=await f.track(child),messages=[];let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));child.on('message',message=>messages.push(message));
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error('Source exited: '+output);const failure=messages.find(item=>item.kind==='owner-error');if(failure)throw new Error(JSON.stringify(failure));return messages.find(item=>item.kind==='ready')},'native source readiness');
  return{child,birth,messages,exited};
}

for(const reportVersion of [1,2])test(`report v${reportVersion}: actual native shadow owner SIGKILL and disabled-policy platform restart retire before a delayed prepare can launch`,{timeout:110000},async t=>{
  const f=await shadowPlatformFixture(t),release=await stage(f),before=f.control.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id);
  await f.pausePlatform();const held=f.hold('prepare'),owner=await source(f,release,reportVersion);await until(()=>held.entered.done,'actual provider prepare received before its journal');
  const record=f.raw(),nativeLease=f.control.prepare('SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1').get();
  assert.equal(record.protocol,2);assert.equal(record.operation.report.protocol,reportVersion===2?2:undefined);assert.equal(f.control.prepare('SELECT schema_id FROM clank_platform_shadow_state').get().schema_id,'clank-platform-shadow/'+(reportVersion===2?3:2));assert.equal(record.operation.phase,'preparing');assert.equal(record.operation.releaseId,release.id);
  assert.equal(nativeLease.controller_pid,owner.child.pid);assert.equal(nativeLease.controller_birth,owner.birth);assert.ok(nativeLease.expires_at>Date.now());
  assert.equal(f.control.prepare('SELECT count(*) n FROM clank_platform_shadow_reports WHERE project_id=?').get(f.project.id).n,1);
  assert.equal(f.events.filter(event=>event.kind==='launch'&&event.isolatedReadOnly).length,0);
  assert.equal(await linuxProcessBirth(owner.child.pid),owner.birth);owner.child.kill('SIGKILL');assert.deepEqual(await owner.exited,{code:null,signal:'SIGKILL'});
  await assert.rejects(linuxProcessBirth(owner.child.pid),error=>['ENOENT','ESRCH'].includes(error.code));
  const successor=await f.successor(),status=await successor.rpc({kind:'status'});assert.equal(status.status.state,'leader');
  const complete=f.raw();assert.equal(complete.operation.phase,'complete');assert.equal(complete.operation.report.protocol,reportVersion===2?2:undefined);assert.equal(complete.operation.outcome,'interrupted');assert.equal(complete.operation.controllerEpoch,record.operation.controllerEpoch);assert.equal(complete.operation.retirementEpoch,record.operation.retirementEpoch);
  assert.equal(complete.operation.retirement.phase,'retired');assert.ok(complete.epoch>record.epoch);
  assert.deepEqual(f.control.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id),before);
  assert.equal(f.control.prepare('SELECT status,purpose FROM clank_platform_releases WHERE id=?').get(release.id).status,'staged');
  assert.equal(f.events.filter(event=>event.kind==='control'&&event.path.endsWith('/canary/retire')&&event.status===200).length,1);
  held.release.resolve();await until(()=>f.events.some(event=>event.kind==='control'&&event.path.endsWith('/canary/prepare')),'late prepare receives retained retirement refusal');
  assert.ok(f.events.find(event=>event.kind==='control'&&event.path.endsWith('/canary/prepare')).status>=400);
  assert.equal(f.events.filter(event=>event.kind==='launch'&&event.isolatedReadOnly).length,0);assert.equal(f.runtimes.size,1);assert.equal(f.raw().epoch,complete.epoch);
  assert.equal((await(await f.traffic()).json()).label,'primary');
  t.diagnostic(JSON.stringify({sourcePid:owner.child.pid,sourceBirth:owner.birth,oldLeaseExpiresAt:nativeLease.expires_at,successorEpoch:status.status.epoch,originalControllerEpoch:record.operation.controllerEpoch,terminalStatusEpoch:complete.epoch,latePrepare:f.events.find(event=>event.kind==='control'&&event.path.endsWith('/canary/prepare')).status}));
});


for(const reportVersion of [1,2])test(`report v${reportVersion}: disabled-policy startup retains all writer and artifact barriers while exact shadow retirement is uncertain`,{timeout:110000},async t=>{
  const f=await shadowPlatformFixture(t),rollbackId=f.control.prepare('SELECT active_release_id FROM clank_platform_projects WHERE id=?').get(f.project.id).active_release_id;
  const replacement=await deploy(f,await artifact(f.root,'second-primary'),'shadow-second-primary-0001');assert.equal(replacement.status,201,JSON.stringify(replacement));
  await until(()=>!f.control.prepare("SELECT 1 FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased')").get(f.project.id),'replacement primary completion');
  const release=await stage(f);await f.pausePlatform();const prepare=f.hold('prepare'),retire=f.hold('retire'),owner=await source(f,release,reportVersion);
  await until(()=>prepare.entered.done,'held real prepare');assert.equal(await linuxProcessBirth(owner.child.pid),owner.birth);owner.child.kill('SIGKILL');assert.deepEqual(await owner.exited,{code:null,signal:'SIGKILL'});
  await f.successor();assert.ok(retire.entered.done);assert.equal(f.raw().operation.phase,'retiring');const retained=f.raw(),before=f.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(f.project.id);
  const blocked=await deploy(f,await artifact(f.root,'blocked-shadow-writer'),'shadow-blocked-deploy-0001');assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,'PROVIDER_CANARY_RECOVERY_REQUIRED');
  const backupId='bk_0123456789abcdef';
  for(const[path,method,body]of[
    [`/api/projects/${f.project.id}/rollback`,'POST',{releaseId:rollbackId,restoreData:false}],
    [`/api/projects/${f.project.id}/backups/${backupId}/restore`,'POST',{confirmation:`restore-backup ${f.project.slug} ${backupId}`}],
    [`/api/admin/projects/${f.project.id}/provider-failover`,'POST',{backupId,sourceNodeId:'canary-native-provider',confirmation:`failover ${f.project.slug} from canary-native-provider using ${backupId}`,acknowledgeDataLoss:true,acknowledgeSourceFenced:true}],
    [`/api/projects/${f.project.id}/releases/${release.id}`,'DELETE',{confirmation:`delete-release ${f.project.slug} ${release.id}`,allowRollbackLoss:true}],
    [`/api/projects/${f.project.id}`,'DELETE',{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true}],
  ]){const response=await f.platform.handle(request(path,{method,body,cookie:f.owner.cookie,csrf:f.owner.csrf})),result=await response.json();assert.equal(response.status,409,JSON.stringify({path,result}));assert.equal(result.error.code,'PROVIDER_CANARY_RECOVERY_REQUIRED',path);}
  assert.deepEqual(f.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),before);assert.equal(f.events.filter(event=>event.kind==='reconcile').length,2);assert.equal(f.raw().epoch,retained.epoch);
  retire.release.resolve();await until(()=>f.events.some(event=>event.kind==='control'&&event.path.endsWith('/canary/retire')&&event.status===200),'real provider late retirement');
  assert.equal(f.raw().epoch,retained.epoch,'An old timed-out response cannot acknowledge native cleanup.');await f.pausePlatform();await f.successor();
  assert.equal(f.raw().operation.phase,'complete');assert.equal(f.raw().operation.report.protocol,reportVersion===2?2:undefined);assert.equal(f.raw().operation.retirementEpoch,retained.operation.retirementEpoch);prepare.release.resolve();
  await until(()=>f.events.some(event=>event.kind==='control'&&event.path.endsWith('/canary/prepare')),'late prepare refusal');assert.equal(f.events.filter(event=>event.kind==='launch').length,2);assert.equal(f.runtimes.size,1);
});
