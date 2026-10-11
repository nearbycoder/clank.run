import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {inspectLinuxHostCertification} from '../dist/host-certification.js';
import {shadowPlatformFixture,origin,artifact,request,until} from './fixtures/platform-shadow-native.mjs';

const enabled=process.env.CLANK_DOCKER_INTEGRATION==='1' && process.env.CLANK_DISPOSABLE_TEST_HOST==='1' && Boolean(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG);
const settings={skip:enabled?false:'requires the explicit disposable Docker host opt-in and independently generated CLANK_SHADOW_CERTIFICATE_CONFIG',timeout:240000};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);await stat('/etc/clank-disposable-test-host');
  const certificate=JSON.parse(await readFile(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG,'utf8'));
  const inspected=await inspectLinuxHostCertification(certificate);assert.equal(inspected.current,true,JSON.stringify(inspected));assert.equal(inspected.report.status,'passed');
  assert.ok(inspected.report.expiresAt>Date.now()+240000,'The independently generated actual certificate must cover this entire bounded run.');
  const f=await shadowPlatformFixture(t,undefined,undefined,{providerPromotionHosts:{'canary-native-provider':certificate}});await f.fresh();
  t.diagnostic(JSON.stringify({certificateId:inspected.report.id,certificatePolicy:inspected.report.policyDigest,certificateExpiresAt:inspected.report.expiresAt,runtimeLauncher:'fixture; not Docker isolation acceptance'}));
  const bytes=await artifact(f.root,'certified-public-shadow'),response=await f.platform.nativeRequest(new Request(origin+`/api/projects/${f.project.id}/releases/stage`,{method:'POST',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':'certified-shadow-stage-01'},body:bytes}));
  const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));f.release=result.release;return f;
}
async function call(f,operation,body,auth=f.owner){const response=await f.platform.nativeRequest(request(`/api/projects/${f.project.id}/shadow/`+operation,{method:'POST',body,cookie:auth.cookie,csrf:auth.csrf}));return{status:response.status,body:await response.json()}}
const input=(review,idempotencyKey)=>({reviewToken:review.reviewToken,idempotencyKey});
async function preview(f){const response=await call(f,'preview',{releaseId:f.release.id,expectedEpoch:f.raw()?.epoch??0,policy:{}});assert.equal(response.status,200,JSON.stringify(response));assert.ok(response.body.reviewToken.length<=4150);return response.body}
async function start(f,review,key){const result=await call(f,'start',input(review,key));assert.equal(result.status,202,JSON.stringify(result));return result.body.session}
async function stop(f,session){const result=await call(f,session.sessionId+'/stop',{operationId:session.operationId,controllerEpoch:session.controllerEpoch});assert.equal(result.status,202,JSON.stringify(result));await until(()=>f.raw()?.operation.sessionId===session.sessionId&&f.raw().operation.phase==='complete','actual exact shadow retirement',15000);assert.equal(f.runtimes.size,1);assert.equal(f.raw().operation.report.counters.reserved,0);return result.body}
const counts=f=>({rows:f.control.prepare('SELECT count(*) n FROM clank_platform_shadow_reports WHERE project_id=?').get(f.project.id).n,controls:f.controlCounts,launches:f.events.filter(event=>event.kind==='launch').length});

test('genuine certificate and native HTTP admission preserve lost202, historical/pruned replay and original session authority',settings,async t=>{
  const f=await fixture(t);
  const otherSession=await f.login();await f.fresh(otherSession);
  const other=await f.invite('other-shadow-deployer@example.test');await f.fresh(other);
  const review=await preview(f),key='certified-shadow-start-original',before=counts(f),primary=f.control.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id);
  const dropped=await f.platform.nativeRequest(request(`/api/projects/${f.project.id}/shadow/start`,{method:'POST',body:input(review,key),cookie:f.owner.cookie,csrf:f.owner.csrf}),{dropResponse:true});assert.equal(dropped.status,202);assert.equal(dropped.dropped,true);
  await until(()=>f.raw()?.operation.phase==='observing','real provider snapshot preparation',15000);const active=f.raw(),started=counts(f);assert.equal(started.rows,before.rows+1);assert.equal(started.controls.prepare,before.controls.prepare+1);assert.ok(active.epoch>active.operation.controllerEpoch);
  const replay=await start(f,review,key);assert.equal(replay.sessionId,active.operation.sessionId);assert.equal(replay.operationId,active.operation.operationId);assert.equal(replay.controllerEpoch,active.operation.controllerEpoch);assert.equal(replay.snapshot.crossHostFreshness,'unknown');assert.ok(Number.isSafeInteger(replay.snapshot.elapsedSinceObservationMs));assert.deepEqual(counts(f),started);
  const changed=await call(f,'start',{...input(review,key),reviewToken:review.reviewToken.slice(0,-1)+(review.reviewToken.endsWith('A')?'B':'A')});assert.equal(changed.status,409);assert.equal(changed.body.error.code,'SHADOW_REPLAY_CONFLICT');assert.deepEqual(counts(f),started);
  const rejectedSession=await call(f,'start',input(review,key),otherSession);assert.equal(rejectedSession.status,409,JSON.stringify(rejectedSession));assert.deepEqual(counts(f),started);
  const rejectedUser=await call(f,'start',input(review,key),other);assert.equal(rejectedUser.status,409,JSON.stringify(rejectedUser));assert.deepEqual(counts(f),started);
  await stop(f,replay);const terminal=f.raw(),reviewB=await preview(f),second=await start(f,reviewB,'certified-shadow-start-second');await until(()=>f.raw()?.operation.phase==='observing','second owner preparation',15000);const secondState=f.raw(),secondCounts=counts(f);
  const historical=await start(f,review,key);assert.equal(historical.sessionId,replay.sessionId);assert.equal(historical.phase,'complete');assert.equal(historical.epoch,terminal.epoch);assert.equal(historical.snapshot.elapsedSinceObservationMs,null);assert.deepEqual(counts(f),secondCounts);assert.equal(f.raw().operation.sessionId,second.sessionId);
  const oldStop=await call(f,replay.sessionId+'/stop',{operationId:replay.operationId,controllerEpoch:replay.controllerEpoch});assert.equal(oldStop.status,202);assert.equal(oldStop.body.session.sessionId,replay.sessionId);assert.equal(f.raw().epoch,secondState.epoch);assert.equal(f.raw().operation.stopRequested,false);assert.deepEqual(counts(f),secondCounts);
  await stop(f,second);const third=await start(f,await preview(f),'certified-shadow-start-third');await until(()=>f.raw()?.operation.phase==='observing','third owner preparation',15000);await stop(f,third);
  const completeCounts=counts(f),pruned=await start(f,review,key);assert.equal(pruned.reportAvailable,false);assert.equal(pruned.report,null);assert.equal(pruned.sessionId,replay.sessionId);assert.deepEqual(counts(f),completeCounts);
  assert.deepEqual(f.control.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id),primary);assert.equal(f.events.filter(event=>event.kind==='traffic'&&event.projectId.startsWith('canary_')).length,0,'P1 submits no mirrored application traffic.');
  // Real elapsed wall time, never a substituted clock or edited token/receipt.
  await until(()=>Date.now()>review.expiresAt,'the actual signed review lifetime',130000);
  const expired=await start(f,review,key);assert.equal(expired.sessionId,replay.sessionId);assert.deepEqual(counts(f),completeCounts);
  const unusedExpired=await call(f,'start',input(review,'certified-unused-expired-key'));assert.equal(unusedExpired.status,409);assert.equal(unusedExpired.body.error.code,'SHADOW_REVIEW_EXPIRED');assert.deepEqual(counts(f),completeCounts);
  f.options.shadowTraffic={...f.options.shadowTraffic,revision:2,maxSamplePercent:1};await f.reopen(false,{agent:false});
  const changedPolicy=await start(f,review,key);assert.equal(changedPolicy.sessionId,replay.sessionId);assert.equal(changedPolicy.policy.samplePercent,10);assert.equal(changedPolicy.snapshot.elapsedSinceObservationMs,null);assert.deepEqual(counts(f),completeCounts);
  f.options.masterKey=randomBytes(32).toString('base64url');await f.reopen(false,{agent:false});
  const rotated=await start(f,review,key);assert.equal(rotated.sessionId,replay.sessionId);assert.equal(rotated.report,null);assert.deepEqual(counts(f),completeCounts);
  const unconsumed=await call(f,'start',input(review,'certified-unused-rotated-key'));assert.equal(unconsumed.status,409);assert.equal(unconsumed.body.error.code,'SHADOW_REVIEW_EXPIRED');assert.deepEqual(counts(f),completeCounts);
  t.diagnostic(JSON.stringify({originalSession:replay.sessionId,newerSession:second.sessionId,prunedReports:true,actualExpiredAt:review.expiresAt,replayedAfter:Date.now(),retainedIdentities:completeCounts.rows,providerPrepareCount:completeCounts.controls.prepare}));
});

for(const revoke of['session','lease'])test('genuine certified held binding refuses '+revoke+' loss before review publication',settings,async t=>{
  const f=await fixture(t),before=counts(f),held=f.hold('binding-response');
  const pending=call(f,'preview',{releaseId:f.release.id,expectedEpoch:0,policy:{}});await until(()=>held.entered.done,'actual authenticated binding response held',15000);
  if(revoke==='session')f.control.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(f.owner.session.id);else f.control.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:'+f.project.id);
  held.release.resolve();const result=await pending;assert.notEqual(result.status,200,JSON.stringify(result));assert.equal(result.body.reviewToken,undefined);assert.equal(f.raw(),null);assert.equal(counts(f).rows,before.rows);assert.equal(counts(f).controls.prepare,before.controls.prepare);assert.equal(counts(f).launches,before.launches);
});
