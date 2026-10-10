import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {request} from 'node:http';
import {fork} from 'node:child_process';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {defineDatabase,defineTable,openSQLite} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {openAgentBudgets} from '../dist/agent-budgets.js';

async function signedStepUp(f,db,account=f.owner) {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('machine-admin-passkey-'+account.user.id).toString('base64url');
  // Seed only an enrolled public key. Fresh authentication is proved by an actual
  // UV signed assertion through AuthServer, never by changing session timestamps.
  db.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('machine-key-'+account.user.id,credentialId,account.user.id,'Machine administration key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const started=await f.call('/__clank/auth/reauthenticate/passkey/start',{},200,undefined,account);
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin:f.options.publicUrl,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:started.challengeId,challenge:started.options.challenge,credential},200,undefined,account);
}
async function setup(t) {
  const f=await fixture(t,false,{serviceAccounts:{}}),db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));
  t.after(()=>db.close());const org=f.development.organizationId,path=`/api/organizations/${org}/service-accounts`;
  const create={name:'Native build robot',ownerId:f.owner.user.id,operationId:'machine_native_create_01'};
  return {...f,db,org,path,create};
}
async function issued(f,permissions=['read']) {
  await signedStepUp(f,f.db);
  const account=(await f.call(f.path,f.create,201)).account;
  const input={projectId:f.development.id,permissions,expiresAt:Date.now()+600000,expectedVersion:account.version,operationId:'machine_native_issue_01'};
  const result=(await f.call(`${f.path}/${account.id}/credentials`,input,201)).issued;
  return {account,input,...result};
}
async function machine(origin,path,token,status=200,body,method=body===undefined?'GET':'POST') {
  const response=await fetch(origin+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
test('native machine administration requires signed recent human authentication and separates machine identity',async t=>{
  const f=await setup(t);
  await f.call(f.path,f.create,403);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_machine_accounts').get().n,0);
  const key=await issued(f),origin=await f.serve();
  const result=await machine(origin,'/api/service-account',key.accessToken);
  assert.equal(result.identity.kind,'service-account');assert.equal(result.identity.id,key.account.id);assert.notEqual(result.identity.id,f.owner.user.id);
  assert.equal(result.identity.ownerId,f.owner.user.id);assert.equal(result.identity.credentialId,key.credential.id);
  const projects=await machine(origin,'/api/projects',key.accessToken);
  assert.deepEqual(projects.projects.map(p=>p.id),[f.development.id]);
  await machine(origin,`/api/projects/${f.development.id}`,key.accessToken);
  await machine(origin,`/api/projects/${f.staging.id}`,key.accessToken,404);
  await machine(origin,`/api/projects/${f.development.id}/logs`,key.accessToken,403);
  for(const path of [f.path,`/api/projects/${f.development.id}/tokens`,`/api/projects/${f.development.id}/members`,'/api/credits','/api/admin/projects']) await machine(origin,path,key.accessToken,403);
  const metadata=f.db.prepare('SELECT metadata FROM clank_platform_audit WHERE action=?').all('service-account.credential');
  assert.equal(metadata.length,1);assert.ok(!JSON.stringify(metadata).includes(key.accessToken));
  const detail=(await f.call(`${f.path}/${key.account.id}`)).detail;
  assert.equal(detail.credentials[0].authenticatedRequests,10);
  assert.ok(!JSON.stringify(detail).includes(key.accessToken));
});
test('native machine operations carry machine audit identity and lose authority after owner removal or expiry',async t=>{
  const f=await setup(t),key=await issued(f,['read','secrets']),origin=await f.serve();
  await machine(origin,`/api/projects/${f.development.id}/secrets`,key.accessToken,200,{values:{MACHINE_FIXTURE:'private fixture'}},'PUT');
  const row=f.db.prepare("SELECT metadata,actor_user_id,actor_token_id FROM clank_platform_audit WHERE action='secrets.update'").get(),metadata=JSON.parse(row.metadata);
  assert.equal(metadata.principalKind,'service-account');assert.equal(metadata.serviceAccountId,key.account.id);assert.equal(metadata.credentialId,key.credential.id);
  assert.equal(row.actor_user_id,f.owner.user.id);assert.equal(row.actor_token_id,key.credential.id);assert.ok(!row.metadata.includes(key.accessToken));
  f.db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.org,f.owner.user.id);
  await machine(origin,'/api/service-account',key.accessToken,403);
  f.db.prepare("INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,'owner',?,?)").run(f.org,f.owner.user.id,Date.now(),Date.now());
  await machine(origin,'/api/service-account',key.accessToken);
  f.db.prepare('UPDATE clank_platform_machine_credentials SET expires_at=? WHERE id=?').run(Date.now()-1,key.credential.id);
  await machine(origin,'/api/service-account',key.accessToken,401);
});
test('real held native HTTP machine writes reject rotated keys without secret or audit effects',async t=>{
  const f=await setup(t),key=await issued(f,['read','secrets']),origin=await f.serve();
  const payload=JSON.stringify({values:{HELD_MACHINE_FIXTURE:'must never commit'}});
  const pending=new Promise((resolve,reject)=>{
    const upload=request(origin+`/api/projects/${f.development.id}/secrets`,{method:'PUT',headers:{authorization:'Bearer '+key.accessToken,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},incoming=>{let bytes='';incoming.on('data',b=>bytes+=b);incoming.once('end',()=>resolve({status:incoming.statusCode,data:JSON.parse(bytes)}));incoming.once('error',reject);});
    upload.once('error',reject);upload.setTimeout(5000,()=>upload.destroy(new Error('Held machine fixture timed out.')));t.after(()=>upload.destroy());upload.write(payload.slice(0,1));
    void(async()=>{
      const deadline=Date.now()+3000;
      while(f.db.prepare('SELECT authenticated_requests AS n FROM clank_platform_machine_credentials WHERE id=?').get(key.credential.id).n===0){assert.ok(Date.now()<deadline,'Real headers must authenticate before rotation.');await new Promise(r=>setTimeout(r,10));}
      await f.call(`${f.path}/${key.account.id}/credentials`,{...key.input,expectedVersion:key.account.version,operationId:'machine_native_rotate_01'},201);
      upload.end(payload.slice(1));
    })().catch(error=>upload.destroy(error));
  });
  const result=await pending;assert.equal(result.status,401);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_secrets WHERE name=?').get('HELD_MACHINE_FIXTURE').n,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='secrets.update'").get().n,0);
  t.diagnostic(JSON.stringify({status:result.status,secrets:0,audits:0,authenticatedAttempts:1}));
});
test('native authenticated machines debit their own agent budget once and cannot administer human grants',async t=>{
  const f=await setup(t),key=await issued(f),schema=defineDatabase({items:defineTable({text:s.string()}).owned()});
  const app=await openSQLite(schema,{path:join(f.root,'machine-budget.sqlite')});t.after(()=>app.close());
  const machineCaller=f.authenticateServiceAccount(new Request(f.options.publicUrl+'/api/service-account',{headers:{authorization:'Bearer '+key.accessToken}}));
  // This trusted server manager is a separate capability. It is never derived
  // from a machine's responsible owner or from client-supplied identity JSON.
  const manager=Object.freeze({kind:'server-budget-manager'});
  const budgets=await openAgentBudgets(app,{identity(caller){if(caller===manager)return {ownerId:f.org,principalId:f.owner.user.id};caller.assertCurrent();return {ownerId:caller.identity.organizationId,principalId:caller.identity.id};},authorizeManage:({caller})=>caller===manager,
    actions:{add:{revision:'machine-budget/1',args:s.object({text:s.string()}),authorize:({caller})=>caller!==manager,execute:({db},input)=>({id:db.table('items').insert(input)})}}});
  const grantInput={principalId:key.account.id,actions:['add'],limits:{calls:1,writes:1,records:1,externalOperations:0},expiresAt:Date.now()+600000,reason:'Scoped machine work'};
  assert.throws(()=>budgets.grant(grantInput,machineCaller),error=>error.code==='BUDGET_FORBIDDEN');
  const grant=budgets.grant(grantInput,manager),operation={grantId:grant.id,operationId:'machine_budget_exact_01',action:'add',input:{text:'One accepted operation'}};
  const receipt=budgets.execute(operation,machineCaller);assert.deepEqual(budgets.execute(operation,machineCaller),receipt);
  const measured=budgets.preview(grant.id,machineCaller);assert.equal(measured.ownerId,f.org);assert.equal(measured.principalId,key.account.id);assert.equal(measured.used.calls,1);assert.equal(measured.used.writes,1);
  assert.equal(app.read(db=>db.table('items').collect(),{userId:f.org}).length,1);
  await f.call(`${f.path}/${key.account.id}/credentials`,{...key.input,expectedVersion:key.account.version,operationId:'machine_budget_rotation_01'},201);
  assert.throws(()=>budgets.execute(operation,machineCaller),error=>error.code==='SERVICE_ACCOUNT_INVALID_CREDENTIAL');
  assert.equal(budgets.preview(grant.id,manager).used.calls,1);
});
function childMessage(child,predicate) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Owned machine HTTP fixture timed out.')),10000);
    const receive=value=>{if(predicate(value))finish(null,value);},exit=()=>finish(new Error('Owned machine HTTP fixture exited before acknowledgement.'));
    const finish=(error,value)=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exit);error?reject(error):resolve(value);};
    child.on('message',receive);child.once('exit',exit);
  });
}
async function controller(t,options) {
  const child=fork(new URL('./fixtures/service-accounts-http-controller.mjs',import.meta.url),[JSON.stringify(options)],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',value=>stderr=(stderr+value).slice(-4096));const closed=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}});
  try{return {child,closed,...await childMessage(child,value=>value.ready),diagnostics:()=>stderr};}catch(error){child.kill('SIGKILL');await closed;throw new Error(error.message+' '+stderr);}
}
function humanHeaders(f,url){return {origin:url,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'};}
test('actual SIGKILL after native credential commit replays the encrypted key without reviving later disabled authority',{timeout:30000},async t=>{
  const f=await setup(t),key=await issued(f),endpoint=`${f.path}/${key.account.id}/credentials`,first=await controller(t,f.options);
  const input={...key.input,expectedVersion:key.account.version,operationId:'machine_killed_rotation_01'},committed=childMessage(first.child,value=>value.committed);
  const delivery=fetch(first.url+endpoint,{method:'POST',headers:{...humanHeaders(f,first.url),'x-clank-fixture-hold':'after-commit'},body:JSON.stringify(input)}).then(()=>({delivered:true}),()=>({delivered:false}));
  const receipt=await committed;assert.equal(receipt.version,3);first.child.kill('SIGKILL');await first.closed;assert.deepEqual(await delivery,{delivered:false});
  const second=await controller(t,f.options);
  const replay=async()=>{const response=await fetch(second.url+endpoint,{method:'POST',headers:humanHeaders(f,second.url),body:JSON.stringify(input)});assert.equal(response.status,201,second.diagnostics());return (await response.json()).issued;};
  const recovered=await replay();assert.equal(recovered.credential.id,receipt.id);assert.equal(createHash('sha256').update(recovered.accessToken).digest('hex'),receipt.secretHash);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_machine_credentials WHERE account_id=?').get(key.account.id).n,2);
  await machine(second.url,'/api/service-account',recovered.accessToken);
  await f.call(`${f.path}/${key.account.id}/change`,{name:key.account.name,ownerId:f.owner.user.id,enabled:false,expectedVersion:3,operationId:'machine_after_kill_disable_01'});
  assert.deepEqual(await replay(),recovered);await machine(second.url,'/api/service-account',recovered.accessToken,401);
  const current=(await f.call(`${f.path}/${key.account.id}`)).detail;assert.equal(current.account.enabled,false);assert.equal(current.account.version,4);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='service-account.credential'").get().n,2);
  second.child.send({close:true});await second.closed;
  t.diagnostic(JSON.stringify({deliveredBeforeKill:false,replayedOneCredential:true,currentDisabled:true}));
});
test('two actual native controllers serialize the same-version credential rotation and preserve one current key',{timeout:30000},async t=>{
  const f=await setup(t),key=await issued(f),left=await controller(t,f.options),right=await controller(t,f.options),endpoint=`${f.path}/${key.account.id}/credentials`;
  const rotate=async(entry,operationId)=>{const response=await fetch(entry.url+endpoint,{method:'POST',headers:humanHeaders(f,entry.url),body:JSON.stringify({...key.input,expectedVersion:key.account.version,operationId})});return {status:response.status,data:await response.json()};};
  const results=await Promise.all([rotate(left,'machine_race_rotation_left'),rotate(right,'machine_race_rotation_right')]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(results.find(r=>r.status===409).data.error.code,'SERVICE_ACCOUNT_VERSION_CONFLICT');
  const accepted=results.find(r=>r.status===201).data.issued;assert.equal(accepted.account.version,3);assert.equal(accepted.credential.generation,2);
  await machine(left.url,'/api/service-account',key.accessToken,401);await machine(right.url,'/api/service-account',accepted.accessToken);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_machine_credentials WHERE account_id=?').get(key.account.id).n,2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='service-account.credential'").get().n,2);
  for(const entry of [left,right]){entry.child.send({close:true});await entry.closed;}
});
