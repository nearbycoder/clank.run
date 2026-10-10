import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {fixture} from './fixtures/platform-environment-fixture.mjs';

async function signedStepUp(f,native){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id=Buffer.from('recovery-admin-'+f.owner.user.id).toString('base64url');
  // Enroll only a fixture public key. Actual UV ECDSA verification and challenge
  // consumption occur through AuthServer; no session freshness is injected.
  native.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('recovery-key-'+f.owner.user.id,id,f.owner.user.id,'Recovery fixture key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await f.call('/__clank/auth/reauthenticate/passkey/start',{}),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin:f.options.publicUrl,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential:{id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}}});
}
async function setup(t){let sources=0;const f=await fixture(t,false,{pointInTime:{source:async()=>{sources++;throw new Error('No registered captured provider in this API fixture.');}}}),native=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));native.exec('PRAGMA busy_timeout=5000');t.after(()=>native.close());const path=`/api/projects/${f.development.id}/point-in-time`,input={operationId:'native_recovery_configuration',expectedVersion:0,enabled:false,intervalMs:60000,confirmation:'configure-recovery '+f.development.slug};return {...f,native,path,input,get sources(){return sources;}};}

test('recovery is disabled by default without creating recovery protocol tables',async t=>{
  const f=await fixture(t);await f.call(`/api/projects/${f.development.id}/point-in-time`,undefined,404);const native=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'),{readOnly:true});try{native.exec('PRAGMA busy_timeout=5000');assert.equal(native.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_platform_pitr_state'").get().n,0);}finally{native.close();}
});

test('native current human policy configuration requires a real signed fresh assertion, records one audit per operation, and returns current policy beside a historical receipt',async t=>{
  const f=await setup(t);await f.call(f.path,f.input,403,'PUT');await f.call(f.path+'/resolve',{operationId:'resolve_before_verification',pendingOperationId:'missing_pending',expectedVersion:1,confirmation:'abandon-recovery '+f.development.slug+' missing_pending'},403);assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_policies').get().n,0);await signedStepUp(f,f.native);
  const first=await f.call(f.path,f.input,200,'PUT');assert.equal(first.receipt.version,1);assert.equal(first.policy.version,1);assert.equal(first.policy.enabled,false);assert.equal(f.sources,0);
  await f.call(f.path,{...f.input,operationId:'unsupported_source_enable',expectedVersion:1,enabled:true},409,'PUT');assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations').get().n,1);
  await f.call(f.path,f.input,200,'PUT');assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.policy'").get().n,1);
  await f.call(f.path,{...f.input,operationId:'native_recovery_configuration_02',expectedVersion:1,intervalMs:120000},200,'PUT');
  const replay=await f.call(f.path,f.input,200,'PUT');assert.equal(replay.receipt.version,1);assert.equal(replay.policy.version,2);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.policy'").get().n,2);
  await f.call(f.path,{...f.input,operationId:'native_recovery_stale_03'},409,'PUT');assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations').get().n,2);
  f.native.exec("CREATE TRIGGER refuse_recovery_audit BEFORE INSERT ON clank_platform_audit WHEN NEW.action='recovery.policy' BEGIN SELECT RAISE(ABORT,'owned native recovery audit failure'); END;");
  const interrupted={...f.input,operationId:'native_recovery_audit_failure',expectedVersion:2,intervalMs:180000};await f.call(f.path,interrupted,409,'PUT');
  assert.equal(f.native.prepare('SELECT version FROM clank_platform_pitr_policies').get().version,2);assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations').get().n,2);
  f.native.exec('DROP TRIGGER refuse_recovery_audit');await f.call(f.path,interrupted,200,'PUT');assert.equal(f.native.prepare('SELECT version FROM clank_platform_pitr_policies').get().version,3);
  assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.policy'").get().n,3);
  const resolution={operationId:'resolve_missing_export',pendingOperationId:'missing_pending',expectedVersion:3,confirmation:'abandon-recovery '+f.development.slug+' missing_pending'};
  await f.call(f.path+'/resolve',{...resolution,confirmation:'incorrect confirmation'},400);await f.call(f.path+'/resolve',resolution,409);
  assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations').get().n,3);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.resolve'").get().n,0);
  const foreign=await f.account('foreign-recovery@example.test');await f.call(f.path,undefined,404,undefined,foreign);
});

test('recovery configuration revalidates native workspace membership after a held request body and leaves no receipt or audit',async t=>{
  const f=await setup(t);await signedStepUp(f,f.native);let entered,deliver;const reading=new Promise(resolve=>{entered=resolve;}),release=new Promise(resolve=>{deliver=resolve;});
  const body=new ReadableStream({async pull(controller){entered();await release;controller.enqueue(new TextEncoder().encode(JSON.stringify(f.input)));controller.close();}},{highWaterMark:0});
  const pending=f.handle(new Request(f.options.publicUrl+f.path,{method:'PUT',duplex:'half',headers:{origin:f.options.publicUrl,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body}));
  await reading;assert.equal(Number(f.native.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId,f.owner.user.id).changes),1);deliver();
  const response=await pending;assert.ok([403,404].includes(response.status),JSON.stringify(await response.json()));assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations').get().n,0);assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='recovery.policy'").get().n,0);assert.equal(f.sources,0);
});
