import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';
import {access,mkdir,writeFile} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {capturedProvider} from './fixtures/platform-point-in-time-provider.mjs';
import {signedStepUp} from './fixtures/platform-recovery-fresh-auth.mjs';
import {recoveryMcpRequest} from './fixtures/platform-recovery-mcp.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

async function setup(t,controllerProcess=false,http=false){
  const provider=await capturedProvider(t),errors=[];let gate;
  const restoreKey=provider.configuration.restoreKey;
  provider.configuration.restoreKey=async(...args)=>{await gate?.();return restoreKey(...args);};
  const holdDirectory=join(provider.root,'key-lookup-barrier');if(controllerProcess)await mkdir(holdDirectory);
  const publicPorts=http?await reservePlatformTestPorts():null;let f;
  try{f=await fixture(t,controllerProcess?'tests/fixtures/platform-point-in-time-project-controller.mjs':false,{...(publicPorts?{publicUrl:'http://127.0.0.1:'+publicPorts.start}:{}),pointInTime:controllerProcess?{...provider.descriptor,holdDirectory}:provider.configuration,deploymentAgents:{registrationToken:provider.registrationToken,placement:{default:'local',activationTimeoutMs:30000}},onError(error){errors.push(error);t.diagnostic(String(error?.stack??error));}});}catch(error){await publicPorts?.release();throw error;}
  if(publicPorts)t.after(()=>publicPorts.release());
  const native=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));native.exec('PRAGMA busy_timeout=5000');t.after(()=>native.close());
  await provider.openAgent(f);
  const project=(await f.call('/api/projects',{name:'Captured source',slug:'captured-source',placement:'provider'},201)).project,artifact=await provider.artifact(),release=await f.upload(project,artifact,'owned_native_captured_release');
  assert.deepEqual((await f.probe(project)).value,['mutation three']);await signedStepUp(f,native);
  const path=`/api/projects/${project.id}/point-in-time`;
  await f.call(path,{operationId:'enable_native_capture',expectedVersion:0,enabled:true,intervalMs:86400000,confirmation:'configure-recovery '+project.slug},200,'PUT');
  const checkpoint=(await f.call(path+'/checkpoints',{operationId:'capture_native_source',expectedVersion:1},201)).checkpoint;assert.equal(checkpoint.sequence,3);assert.equal(checkpoint.binding.releaseId,release.id);
  await provider.loseSource();await assert.rejects(access(provider.node),{code:'ENOENT'});
  const input={operationId:'restore_native_point_two',checkpointId:checkpoint.id,expectedVersion:1,throughSequence:2,name:'Recovered point two',slug:'recovered-point-two',confirmation:`restore-recovery ${project.slug} ${checkpoint.id} 2 recovered-point-two`};
  return {...f,provider,project,release,artifact,native,path,input,checkpoint,errors,holdDirectory,setGate(value){gate=value;}};
}
function target(f){const row=f.native.prepare("SELECT id,active_release_id,runtime_policy FROM clank_platform_projects WHERE slug='recovered-point-two'").get();assert.ok(row);return row;}

test('a native provider is killed and its volume deleted before a separate suspended project restores the retained mutation ledger and portable release',async t=>{
  const f=await setup(t,false,true),origin=await f.serve();
  const plannedInput={...f.input};delete plannedInput.confirmation;const planResponse=await fetch(recoveryMcpRequest(origin,f.path+'/mcp','tools/call',{name:'recovery_restore_plan',arguments:plannedInput},{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf})),planBody=await planResponse.json();assert.equal(planResponse.status,200,JSON.stringify(planBody));const plan=planBody.result;assert.equal(plan.isError,false);assert.equal(plan.structuredContent.browserOnly,true);assert.deepEqual(plan.structuredContent.request,f.input);assert.equal(plan.structuredContent.method,'POST');assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind='restore'").get().n,0);
  const withoutCsrf=await fetch(recoveryMcpRequest(origin,f.path+'/mcp','tools/call',{name:'recovery_status',arguments:{}},{origin,cookie:f.owner.cookie}));assert.equal(withoutCsrf.status,403);const crossOrigin=await fetch(recoveryMcpRequest(origin,f.path+'/mcp','tools/call',{name:'recovery_status',arguments:{}},{origin:'https://foreign.example.test',cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf}));assert.equal(crossOrigin.status,403);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind='restore'").get().n,0);
  await f.call(f.path+'/restores',{...f.input,confirmation:'wrong'},400);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_projects WHERE slug='recovered-point-two'").get().n,0);
  const accepted=(await f.call(f.path+'/restores',f.input,201)).receipt,project=target(f);assert.equal(accepted.sequence,2);assert.equal(project.id,accepted.destinationProjectId);assert.equal(project.active_release_id,accepted.releaseId);assert.equal(project.runtime_policy,'suspended');assert.notEqual(project.id,f.project.id);
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.reserve'").get().n,1);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.accept'").get().n,1);
  await f.probe({id:project.id,slug:f.input.slug},'',503);
  assert.deepEqual((await f.call(f.path+'/restores',f.input,201)).receipt,accepted);
  await f.restart();assert.deepEqual((await f.call(f.path+'/restores',f.input,201)).receipt,accepted);assert.equal(target(f).runtime_policy,'suspended');
  const status=await f.call(f.path);assert.deepEqual(status.restores,[accepted]);assert.equal(status.checkpoints.length,1);
  await f.call(`/api/projects/${project.id}/runtime`,{policy:'always_on',idleTimeoutMs:1800000},200,'PUT');assert.deepEqual((await f.probe({id:project.id,slug:f.input.slug})).value,['mutation two']);
  assert.equal(f.errors.length,0);t.diagnostic(JSON.stringify({sourceProcessKilled:true,sourceVolumeDeleted:true,capturedSequence:3,restoredSequence:2,distinctProject:true,suspendedUntilHumanActivation:true,controllerReopened:true,exactRetries:2,acceptedRestoreAudits:1}));
});

test('an actual native acknowledgment transaction abort leaves one stopped reservation, blocks mutation, and completes its exact retained code and data on retry',async t=>{
  const f=await setup(t);f.native.exec("CREATE TRIGGER fail_recovery_ack BEFORE INSERT ON clank_platform_audit WHEN NEW.action='recovery.restore.accept' BEGIN SELECT RAISE(ABORT,'owned recovery acknowledgment failure'); END;");
  await f.call(f.path+'/restores',f.input,409);const reserved=target(f);assert.equal(reserved.active_release_id,null);assert.equal(reserved.runtime_policy,'suspended');
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_releases WHERE project_id=?").get(reserved.id).n,0);
  await f.call(`/api/projects/${reserved.id}/runtime`,{policy:'always_on',idleTimeoutMs:1800000},409,'PUT');
  await f.call(f.path+'/restores',{...f.input,throughSequence:1,confirmation:`restore-recovery ${f.project.slug} ${f.checkpoint.id} 1 ${f.input.slug}`},409);
  f.native.exec('DROP TRIGGER fail_recovery_ack');await f.restart();const accepted=(await f.call(f.path+'/restores',f.input,201)).receipt;assert.equal(accepted.destinationProjectId,reserved.id);assert.equal(accepted.sequence,2);
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.reserve'").get().n,1);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.accept'").get().n,1);
});

test('current native membership loss during independent key resolution cannot publish a release or start the reserved destination',async t=>{
  const f=await setup(t);let entered,release;const lookup=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});f.setGate(async()=>{entered();await held;});
  const pending=f.call(f.path+'/restores',f.input,404);await lookup;const reserved=target(f);
  assert.equal(Number(f.native.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.project.organizationId,f.owner.user.id).changes),1);release();assert.equal((await pending).error.code,'PROJECT_NOT_FOUND');
  assert.equal(target(f).active_release_id,null);assert.equal(target(f).runtime_policy,'suspended');assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.accept'").get().n,0);
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_releases WHERE project_id=?").get(reserved.id).n,0);assert.equal(f.native.prepare("SELECT state FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(f.project.id,f.input.operationId).state,'pending');
});

test('a native ignored project update cannot acknowledge an unusable restore and retains its exact stopped reservation for retry',async t=>{
  const f=await setup(t);f.native.exec("CREATE TRIGGER ignore_recovery_selection BEFORE UPDATE OF active_release_id ON clank_platform_projects WHEN OLD.slug='recovered-point-two' BEGIN SELECT RAISE(IGNORE); END;");
  const refused=await f.call(f.path+'/restores',f.input,409);assert.equal(refused.error.code,'RECOVERY_ACKNOWLEDGMENT_CHANGED');const reserved=target(f);assert.equal(reserved.active_release_id,null);assert.equal(reserved.runtime_policy,'suspended');
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_releases WHERE project_id=?").get(reserved.id).n,0);assert.equal(f.native.prepare("SELECT state FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(f.project.id,f.input.operationId).state,'pending');assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.accept'").get().n,0);
  f.native.exec('DROP TRIGGER ignore_recovery_selection');const accepted=(await f.call(f.path+'/restores',f.input,201)).receipt;assert.equal(accepted.destinationProjectId,reserved.id);assert.equal(target(f).active_release_id,accepted.releaseId);
});

test('actual SIGKILL during project key resolution retains one native stopped destination and retries after its real lease expires',async t=>{
  const f=await setup(t,true),pending=f.call(f.path+'/restores',f.input,201).then(value=>({value}),error=>({error})),deadline=performance.now()+15000;
  while(true){try{await access(join(f.holdDirectory,'entered'));break;}catch(error){if(error.code!=='ENOENT')throw error;if(performance.now()>=deadline)throw new Error('Actual controller did not enter its independent key lookup.');await setTimeout(20);}}
  const reserved=target(f),original=JSON.parse(f.native.prepare('SELECT receipt FROM clank_platform_pitr_operations WHERE project=? AND id=?').get(f.project.id,f.input.operationId).receipt);assert.equal(reserved.active_release_id,null);assert.equal(reserved.runtime_policy,'suspended');assert.ok(original.leaseUntil>Date.now());
  await f.killAndRestart(()=>writeFile(join(f.holdDirectory,'resume'),'Only after the owned controller process has closed.\n',{flag:'wx'}));assert.match(String((await pending).error),/Owned controller stopped/);
  const busy=await f.call(f.path+'/restores',f.input,409);assert.equal(busy.error.code,'RECOVERY_RESTORE_BUSY');assert.equal(target(f).id,reserved.id);assert.equal(target(f).active_release_id,null);
  // No timestamp edits or shortened production leases: wait for the actual
  // retained native lease deadline before admitting a successor.
  await setTimeout(Math.max(0,original.leaseUntil-Date.now())+30);
  const accepted=(await f.call(f.path+'/restores',f.input,201)).receipt;assert.equal(accepted.destinationProjectId,reserved.id);assert.equal(accepted.sequence,2);assert.equal(target(f).runtime_policy,'suspended');
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.reserve'").get().n,1);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.restore.accept'").get().n,1);
  t.diagnostic(JSON.stringify({controllerSIGKILL:true,sourceVolumeDeleted:true,nativeLeaseDurationMs:120000,nativeLeaseTimestampsUnchanged:true,resumedOriginalDestination:true,restoredSequence:2,acceptedRestoreAudits:1}));
});
