import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {request} from 'node:http';
import {fork} from 'node:child_process';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
const requirements={factor:'passkey',ssoOnly:false,sessionMaxAgeMs:3600000,enrollmentGraceMs:0};
async function passkey(f,db,account=f.owner) {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('policy-native-key-'+account.user.id).toString('base64url');
  db.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('policy-key-'+account.user.id,credentialId,account.user.id,'Policy fixture',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await f.call('/__clank/auth/reauthenticate/passkey/start',{},200,undefined,account),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin:f.options.publicUrl,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential},200,undefined,account);
}
async function setup(t) {
  const f=await fixture(t,false,{organizationSecurity:{operatorRecovery:true},onError(error){t.diagnostic(error instanceof Error ? error.stack : String(error));}}),db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>db.close());
  const org=f.development.organizationId,path=`/api/organizations/${org}/security-policy`;await passkey(f,db);return {...f,db,org,path};
}
const change=(expectedVersion=0,factor='passkey',operationId='policy_native_save_01')=>({requirements:{...requirements,factor},expectedVersion,operationId});
async function credential(f,project=f.development,account=f.owner) {
  return (await f.call(`/api/projects/${project.id}/tokens`,{name:'Policy credential',permissions:['read','secrets'],expiresIn:600},201,undefined,account)).token;
}
async function bearer(origin,path,token,status=200) {
  const response=await fetch(origin+path,{headers:{authorization:'Bearer '+token}});const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
}
test('native policy tightening gates actual browser/project CLI authority while preserving another organization and never reviving old grants',async t=>{
  const f=await setup(t),member=await f.account('native-policy-member@example.test');
  f.db.prepare("INSERT INTO clank_platform_memberships VALUES(?,?,'developer',?,?)").run(f.org,member.user.id,Date.now(),Date.now());
  const own=(await f.call('/api/projects',{name:'Member personal',slug:'member-personal'},201,undefined,member)).project;
  await f.call(`/api/projects/${f.development.id}`,undefined,200,undefined,member);
  const original=await credential(f),other=await credential(f,own,member),origin=await f.serve();
  const preview=await f.call(f.path+'/preview',{requirements});assert.equal(preview.preview.proposed.allowed,true);assert.equal(preview.preview.policy.version,0);
  await f.call(f.path,change());await bearer(origin,`/api/projects/${f.development.id}`,original.accessToken,401);
  await bearer(origin,`/api/projects/${own.id}`,other.accessToken);
  await f.call(`/api/projects/${f.development.id}`,undefined,403,undefined,member);
  await f.call(`/api/usage?organizationId=${f.org}`,undefined,403,undefined,member);
  await f.call(`/api/audit?organizationId=${f.org}`,undefined,403,undefined,member);
  const audit=await f.call('/api/audit',undefined,200,undefined,member);assert.ok(audit.events.every(event=>event.organization?.id!==f.org));
  const list=await f.call('/api/projects',undefined,200,undefined,member);assert.ok(!Object.hasOwn(list.usage,f.org));assert.ok(list.projects.every(project=>project.organizationId!==f.org));
  await f.call(`/api/projects/${own.id}`,undefined,200,undefined,member);
  const current=await credential(f);await bearer(origin,`/api/projects/${f.development.id}`,current.accessToken);
  await passkey(f,f.db,member);await f.call(`/api/projects/${f.development.id}`,undefined,200,undefined,member);
  await f.call(f.path,change(1,'none','policy_native_relax_02'));
  for(const key of [original,current])await bearer(origin,`/api/projects/${f.development.id}`,key.accessToken,401);
  const latest=(await f.call(f.path)).policy;assert.equal(latest.version,2);
  await f.call(f.path,change());assert.equal((await f.call(f.path)).policy.version,2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='organization.security-policy.change'").get().n,2);
});

function message(child,predicate) {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('Owned policy HTTP fixture timed out.')),10000);
    const receive=value=>{if(predicate(value))finish(null,value);},exit=()=>finish(new Error('Owned policy HTTP controller exited early.'));
    const finish=(error,value)=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exit);error?reject(error):resolve(value);};child.on('message',receive);child.once('exit',exit);});
}
async function controller(t,options) {
  const child=fork(new URL('./fixtures/organization-policy-http-controller.mjs',import.meta.url),[JSON.stringify(options)],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',value=>stderr=(stderr+value).slice(-4096));const closed=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}});
  try{return {child,closed,...await message(child,value=>value.ready),diagnostics:()=>stderr};}catch(error){child.kill('SIGKILL');await closed;throw new Error(error.message+' '+stderr);}
}
const headers=(f,url,account=f.owner)=>({origin:url,cookie:account.cookie,'x-clank-csrf':account.csrf,'content-type':'application/json'});
async function policyRequest(f,entry,input,status=200,account=f.owner,path=f.path) {
  const response=await fetch(entry.url+path,{method:input===undefined?'GET':'POST',headers:headers(f,entry.url,account),...(input===undefined?{}:{body:JSON.stringify(input)})});
  const body=await response.json();assert.equal(response.status,status,JSON.stringify(body)+' '+entry.diagnostics());return body;
}
test('two actual native policy controllers serialize the same-version CAS and reject the retired CLI proof',{timeout:30000},async t=>{
  const f=await setup(t),key=await credential(f),left=await controller(t,f.options),right=await controller(t,f.options);
  const save=async(entry,operationId)=>{const response=await fetch(entry.url+f.path,{method:'POST',headers:headers(f,entry.url),body:JSON.stringify(change(0,'passkey',operationId))});return {status:response.status,body:await response.json()};};
  const results=await Promise.all([save(left,'policy_race_left_01'),save(right,'policy_race_right_02')]);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal(results.find(result=>result.status===409).body.error.code,'ORGANIZATION_POLICY_VERSION_CONFLICT');
  for(const entry of [left,right])await bearer(entry.url,`/api/projects/${f.development.id}`,key.accessToken,401);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='organization.security-policy.change'").get().n,1);
  for(const entry of [left,right]){entry.child.send({close:true});await entry.closed;}
});
test('actual SIGKILL after native policy commit retains one exact acknowledgement and cannot overwrite a later policy',{timeout:30000},async t=>{
  const f=await setup(t),first=await controller(t,f.options),input=change(),committed=message(first.child,value=>value.committed);
  const delivery=fetch(first.url+f.path,{method:'POST',headers:{...headers(f,first.url),'x-clank-fixture-hold':'after-commit'},body:JSON.stringify(input)}).then(()=>true,()=>false);
  const proof=await committed;assert.equal(proof.policy.version,1);first.child.kill('SIGKILL');await first.closed;assert.equal(await delivery,false);
  const next=await controller(t,f.options);assert.deepEqual((await policyRequest(f,next,input)).policy,proof.policy);
  await policyRequest(f,next,change(1,'passkey','policy_after_kill_change_02'));
  assert.deepEqual((await policyRequest(f,next,input)).policy,proof.policy);assert.equal((await policyRequest(f,next)).policy.version,2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='organization.security-policy.change'").get().n,2);
  next.child.send({close:true});await next.closed;t.diagnostic(JSON.stringify({deliveryBeforeKill:false,exactReplay:true,currentVersion:2}));
});
test('native last-administrator recovery requires a current independent operator and enrolled passkey owner, and exact retries do not reverse later policy',async t=>{
  const f=await setup(t),operator=await f.account('native-policy-operator@example.test'),target=await f.account('native-policy-restored-owner@example.test');
  f.db.prepare("UPDATE clank_auth_users SET role='platform_admin' WHERE id=?").run(operator.user.id);await passkey(f,f.db,operator);await passkey(f,f.db,target);
  await f.call(f.path,change());f.db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=?').run(f.org);
  const recovery={ownerId:target.user.id,confirmation:f.org,reason:'Restore the verified owner after all administrators were removed',expectedVersion:1,operationId:'policy_native_recovery_01'};
  await f.call(f.path+'/recover',{...recovery,confirmation:'wrong_organization'},422,undefined,operator);
  await f.call(f.path+'/recover',recovery,403,undefined,target);
  const accepted=(await f.call(f.path+'/recover',recovery,200,undefined,operator)).policy;assert.equal(accepted.version,2);assert.equal(accepted.factor,'passkey');assert.equal(accepted.ssoOnly,false);
  assert.equal(f.db.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.org,target.user.id).role,'owner');
  await f.call(f.path,change(2,'passkey','policy_native_after_recovery_02'),200,undefined,target);
  assert.deepEqual((await f.call(f.path+'/recover',recovery,200,undefined,operator)).policy,accepted);assert.equal((await f.call(f.path,undefined,200,undefined,target)).policy.version,3);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='organization.security-policy.recover'").get().n,1);
  f.db.prepare("UPDATE clank_auth_users SET role='user' WHERE id=?").run(operator.user.id);await f.call(f.path+'/recover',recovery,403,undefined,operator);
});
test('actual held native HTTP body rejects a policy generation changed by another control-store controller before any guarded effect',async t=>{
  const f=await setup(t);await f.call(f.path,change());const key=await credential(f),origin=await f.serve(),payload=JSON.stringify({values:{POLICY_HELD_FIXTURE:'must never commit'}});
  const pending=new Promise((resolve,reject)=>{
    const upload=request(origin+`/api/projects/${f.development.id}/secrets`,{method:'PUT',headers:{authorization:'Bearer '+key.accessToken,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},response=>{let text='';response.on('data',bytes=>text+=bytes);response.once('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));response.once('error',reject);});
    upload.once('error',reject);upload.setTimeout(5000,()=>upload.destroy(new Error('Owned policy HTTP fixture timed out.')));t.after(()=>upload.destroy());upload.write(payload.slice(0,1));
    void(async()=>{
      const deadline=Date.now()+3000;
      while(f.db.prepare('SELECT last_used_at FROM clank_platform_tokens WHERE id=?').get(key.id).last_used_at===null){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
      // A different real Node process changes the same native SQLite policy;
      // the held HTTP request must consult its persisted generation again.
      const second=await controller(t,f.options);
      try {await policyRequest(f,second,change(1,'passkey','policy_other_controller_02'));}
      finally {second.child.send({close:true});await second.closed;}
      upload.end(payload.slice(1));
    })().catch(error=>upload.destroy(error));
  });
  const result=await pending;assert.equal(result.status,401,JSON.stringify(result.body));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_secrets WHERE name=?').get('POLICY_HELD_FIXTURE').n,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='secrets.update'").get().n,0);
});
