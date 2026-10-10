import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

async function step(f,db,account) {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),key='temporary-key-'+randomUUID(),credentialId=Buffer.from(key).toString('base64url');
  db.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(key,credentialId,account.user.id,'Owned UV fixture',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await f.call('/__clank/auth/reauthenticate/passkey/start',{},200,undefined,account),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin:f.options.publicUrl,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential:{id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}}},200,undefined,account);
}
async function setup(t,subprocess=false) {
  const controlPorts=await reservePlatformTestPorts(),origin='http://127.0.0.1:'+controlPorts.start;
  const f=await fixture(t,subprocess,{publicUrl:origin,organizationSecurity:{},temporaryAccess:{},freshAuthentication:{required:false}});
  t.after(()=>controlPorts.release());
  const db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>db.close());
  const recipient=await f.account('temporary-recipient@example.test'),other=await f.account('temporary-other@example.test'),org=f.development.organizationId;
  for(const account of [recipient,other])db.prepare("INSERT INTO clank_platform_memberships VALUES(?,?,'viewer',?,?)").run(org,account.user.id,Date.now(),Date.now());
  await step(f,db,f.owner);await step(f,db,recipient);await f.serve();
  const path=`/api/projects/${f.development.id}`,input=(expectedVersion=0,operationId='temporary_http_create_01',durationMs=60000)=>({recipientId:recipient.user.id,action:'preview.create',durationMs,reason:'Create one reviewed isolated preview.',expectedVersion,operationId});
  const http=async(suffix,body,expected=200,account=f.owner,grantId)=>{
    const response=await fetch(origin+path+suffix,{method:body===undefined?'GET':'POST',redirect:'error',headers:{origin,cookie:account.cookie,'x-clank-csrf':account.csrf,...(body===undefined?{}:{'content-type':'application/json'}),...(grantId?{'x-clank-temporary-access':grantId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
  };
  const grant=async(durationMs=60000)=> (await http('/temporary-access',input(0,'temporary_http_create_01',durationMs),201)).result.grant;
  const passwordLogin=async account=>{const response=await fetch(origin+'/__clank/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:account.user.email,password:'correct horse battery staple'})});assert.equal(response.status,200);const state=await response.json();return {user:state.user,csrf:state.csrfToken,cookie:response.headers.get('set-cookie').split(';')[0]};};
  return {...f,db,org,recipient,other,origin,projectPath:path,input,http,grant,passwordLogin,step:account=>step(f,db,account)};
}
test('native HTTP grants permit only a new preview, keep quotas and roles, reject tokens, and revoke immediately across restart',async t=>{
  const f=await setup(t);await f.http('/previews',{name:'first'},403,f.recipient);
  const grant=await f.grant(),created=await f.http('/previews',{name:'first'},201,f.recipient,grant.id);assert.equal(created.created,true);assert.equal(created.preview.organizationId,f.org);assert.equal(created.preview.parentProjectId,f.development.id);
  assert.equal(f.db.prepare('SELECT role FROM clank_platform_memberships WHERE user_id=? AND organization_id=?').get(f.recipient.user.id,f.org).role,'viewer');
  await f.http('/previews',{name:'first'},409,f.recipient,grant.id);await f.http('/rollback',{releaseId:'not_a_release_01'},403,f.recipient,grant.id);await f.http('/previews',{name:'wrong-recipient'},403,f.other,grant.id);
  const token=(await f.call(f.projectPath+'/tokens',{name:'Cannot inherit human grants',permissions:['read','previews'],expiresIn:600},201)).token;
  const denied=await fetch(f.origin+f.projectPath+'/previews',{method:'POST',headers:{authorization:'Bearer '+token.accessToken,'content-type':'application/json','x-clank-temporary-access':grant.id},body:JSON.stringify({name:'token-preview'})});assert.equal(denied.status,403);
  const snapshot=(await f.http('/temporary-access')).snapshot,revoke={grantId:grant.id,expectedVersion:snapshot.version,operationId:'temporary_http_revoke_01',reason:'Preview creation window is closed.'};
  await f.http('/temporary-access/revoke',revoke);await f.http('/temporary-access/revoke',revoke);await f.http('/previews',{name:'after-revoke'},403,f.recipient,grant.id);
  const audit=f.db.prepare("SELECT metadata FROM clank_platform_audit WHERE action='preview.create'").all().map(row=>JSON.parse(row.metadata));assert.equal(audit.length,1);assert.ok(audit.every(row=>row.temporaryAccessGrantId===grant.id));await f.restart();await f.http('/previews',{name:'after-restart'},403,f.recipient,grant.id);
});
for(const mutation of ['revoke','membership','policy','expiry'])test(`a real streamed HTTP body held after grant capture cannot commit after ${mutation}`,async t=>{
  const f=await setup(t),grant=await f.grant(mutation==='expiry'?1000:60000),previous=f.db.prepare('SELECT clock FROM clank_platform_temporary_access_state').get().clock;
  while(Date.now()<=previous)await delay(1);
  let bodyController;const body=new ReadableStream({start(controller){bodyController=controller;controller.enqueue(new TextEncoder().encode('{"name":"held'));}});
  const pending=fetch(f.origin+f.projectPath+'/previews',{method:'POST',duplex:'half',body,signal:AbortSignal.timeout(10000),headers:{origin:f.origin,cookie:f.recipient.cookie,'x-clank-csrf':f.recipient.csrf,'x-clank-temporary-access':grant.id,'content-type':'application/json'}});
  const end=Date.now()+3000;while(f.db.prepare('SELECT clock FROM clank_platform_temporary_access_state').get().clock<=previous){assert.ok(Date.now()<end,'Native grant capture must occur before the held-body mutation.');await delay(10);}
  if(mutation==='revoke')await f.http('/temporary-access/revoke',{grantId:grant.id,expectedVersion:1,operationId:'temporary_held_revoke_01',reason:'Revoke the held decision.'});
  if(mutation==='membership') {const row=f.db.prepare('SELECT * FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.org,f.recipient.user.id);f.db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.org,f.recipient.user.id);f.db.prepare('INSERT INTO clank_platform_memberships VALUES(?,?,?,?,?)').run(row.organization_id,row.user_id,row.role,row.created_at,row.updated_at);}
  if(mutation==='policy')await f.call('/api/organizations/'+f.org+'/security-policy',{requirements:{factor:'passkey',ssoOnly:false,sessionMaxAgeMs:3600000,enrollmentGraceMs:0},expectedVersion:0,operationId:'temporary_held_policy_01'});
  if(mutation==='expiry')await delay(Math.max(0,grant.expiresAt-Date.now()+1));
  bodyController.enqueue(new TextEncoder().encode('-preview"}'));bodyController.close();const response=await pending;assert.equal(response.status,403,await response.text());
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_projects WHERE parent_project_id=?').get(f.development.id).n,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='preview.create'").get().n,0);
});
for(const mode of ['ignore','alter'])test(`native ${mode} preview audit acknowledgment rolls back the actual preview allocation`,async t=>{
  const f=await setup(t),grant=await f.grant();f.db.exec(mode==='ignore'?`CREATE TRIGGER test_preview_audit BEFORE INSERT ON clank_platform_audit WHEN NEW.action='preview.create' BEGIN SELECT RAISE(IGNORE); END;`:`CREATE TRIGGER test_preview_audit AFTER INSERT ON clank_platform_audit WHEN NEW.action='preview.create' BEGIN UPDATE clank_platform_audit SET metadata='{}' WHERE id=NEW.id; END;`);
  await f.http('/previews',{name:'no-partial-preview'},503,f.recipient,grant.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_projects WHERE parent_project_id=?').get(f.development.id).n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='preview.create'").get().n,0);
});
test('native assurance is mandatory even with global freshness disabled and inventories do not disclose another recipient',async t=>{
  const f=await setup(t),grant=await f.grant(),passwordOwner=await f.passwordLogin(f.owner);await f.http('/temporary-access',f.input(1,'temporary_password_create_02'),403,passwordOwner);
  await f.http('/temporary-access/revoke',{grantId:grant.id,expectedVersion:1,operationId:'temporary_password_revoke_02',reason:'Requires a new native step-up.'},403,passwordOwner);
  const own=(await f.http('/temporary-access',undefined,200,f.recipient)).snapshot,other=(await f.http('/temporary-access',undefined,200,f.other)).snapshot;assert.equal(own.grants.length,1);assert.equal(other.grants.length,0);
  const passwordRecipient=await f.passwordLogin(f.recipient);await f.http('/previews',{name:'password-preview'},403,passwordRecipient,grant.id);
});
test('SIGKILL of the native controller retires active privileges and preserves historical exact receipts',async t=>{
  const f=await setup(t,true),grant=await f.grant();await f.http('/previews',{name:'before-process-loss'},201,f.recipient,grant.id);
  await f.killAndRestart();await f.http('/previews',{name:'after-process-loss'},403,f.recipient,grant.id);
  const snapshot=(await f.http('/temporary-access')).snapshot;assert.equal(snapshot.grants[0].state,'revoked');assert.equal(snapshot.grants[0].active,false);
  const replay=await f.http('/temporary-access',f.input(),201);assert.equal(replay.result.grant.id,grant.id);assert.equal(replay.result.grant.active,false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='temporary-access.create'").get().n,1);
  const next=f.input(snapshot.version,'temporary_post_loss_create_02');const replacement=(await f.http('/temporary-access',next,201)).result.grant;
  assert.notEqual(replacement.id,grant.id);await f.http('/previews',{name:'after-new-review'},201,f.recipient,replacement.id);
});
