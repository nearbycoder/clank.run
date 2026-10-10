import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {defineAuth,defineBackend,defineDatabase,defineTable,openBackend,s} from '../dist/index.js';
import {defineReviewedAction,renderApprovalInbox} from '../dist/reviewed-actions.js';
const origin='http://127.0.0.1:42507',native=Symbol.for('clank.sqlite.internal'),company='quorum_company_01';
const request=(path,account,body,extra={})=>new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,...(account?{cookie:account.cookie,'x-clank-csrf':account.csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function fixture(t,{quorum={},action={},security=false,ttlMs=300000}={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-native-quorum-'));
  let runtime,code;
  const schema=defineDatabase({items:defineTable({done:s.boolean()}).owned(),members:defineTable({userId:s.string(),role:s.string(),epoch:s.string()})});
  const resolve=({db,auth})=>{
    const member=db.table('members').query().where('userId',auth.user.id).first();
    if(!member)return null;
    const policyVersion=security?String(runtime.organizationSecurity.read(company,auth).version):'policy_v1';
    return {scope:company,role:member.role,version:member._id+':'+member._version+':'+member.epoch,policyVersion};
  };
  const reviewed=defineReviewedAction(schema,{revision:'finish_v1',title:'Reviewed finish',args:s.object({id:s.string()}),previewDependencies:'records',
    authorize:({auth})=>Boolean(auth.user),authorizeApproval:({auth})=>Boolean(auth.user),
    preview:({db},{id})=>{const item=db.table('items').get(id);assert.ok(item);return {id,before:item.done};},
    approvalQuorum:{revision:'quorum_v1',minimum:2,requiredRoles:['reviewer','operator'],membership:resolve,...quorum},
    execute:({db},{id})=>{db.table('items').patch(id,{done:true});return {id};},...action});
  const definition=defineBackend({schema,auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024},mfa:{send(message){code=message.code;}}})}).functions(()=>({}));
  const options={path:join(root,'app.sqlite'),reviewedActions:{ttlMs,actions:{finish:reviewed}}};
  if(security)options.organizationSecurity={organizationId:company,policy:{exists:id=>id===company,
    membership(id,userId){const row=runtime.database[native].prepare("SELECT _creation_time FROM clank_members WHERE json_extract(_data,'$.userId')=?").get(userId);return id===company&&row?{role:'admin',createdAt:row._creation_time}:null;},
    members(id){return id===company?runtime.database[native].prepare('SELECT _creation_time,_data FROM clank_members').all().map(row=>({userId:JSON.parse(row._data).userId,membership:{role:'admin',createdAt:row._creation_time}})):[];},
    audit(actor,organization,action,metadata){runtime.database[native].prepare('INSERT INTO quorum_policy_audit VALUES(?,?,?,?)').run(actor,organization,action,JSON.stringify(metadata));}}};
  runtime=await openBackend(definition,options);
  if(security)runtime.database[native].exec('CREATE TABLE quorum_policy_audit(actor TEXT,organization TEXT,action TEXT,metadata TEXT)');
  t.after(async()=>{runtime.close();await rm(root,{recursive:true,force:true});});
  const accounts=[];
  const register=async(role)=>{
    const response=await runtime.handle(request('/__clank/auth/register',null,{email:role+'-'+accounts.length+'@example.test',password:'correct horse battery staple',profile:{name:role}}));assert.equal(response.status,201,await response.clone().text());
    const body=await response.json(),account={cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrfToken,user:body.user};
    account.auth=await runtime.auth.resolve(request('/',account));
    account.member=runtime.database.transaction(db=>db.table('members').insert({userId:account.user.id,role,epoch:crypto.randomUUID()}));accounts.push(account);return account;
  };
  const owner=await register('requester'),left=await register('reviewer'),right=await register('operator');
  const id=runtime.database.transaction(db=>db.table('items').insert({done:false}),{userId:owner.user.id});
  const f={get runtime(){return runtime},path:options.path,owner,left,right,id,register,reviewed,
    plan:()=>runtime.reviewedActions.plan('finish',{id},owner.auth),
    vote:(plan,account)=>runtime.reviewedActions.decide(plan.id,'approve',account.auth),
    commit:plan=>runtime.reviewedActions.commit(plan.id,owner.auth),
    member(account,patch){runtime.database.transaction(db=>db.table('members').patch(account.member,patch));},
    async reopen(){runtime.close();runtime=await openBackend(definition,options);for(const a of accounts)a.auth=await runtime.auth.resolve(request('/',a));},
    async step(account=owner){
      const start=await runtime.auth.handle(request('/__clank/auth/reauthenticate/mfa/start',account,{password:'correct horse battery staple'}));assert.equal(start.status,200,await start.clone().text());
      const {challengeId}=await start.json();const finish=await runtime.auth.handle(request('/__clank/auth/reauthenticate/mfa/finish',account,{challengeId,code}));assert.equal(finish.status,200,await finish.clone().text());account.auth=await runtime.auth.resolve(request('/',account));return account.auth;
    }};
  return f;
}
const denied=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('distinct native human roles commit once; duplicate and lost-response votes never increase counts or events',async t=>{
  const f=await fixture(t),plan=f.plan();assert.equal(plan.quorum.minimum,2);assert.equal(plan.quorum.recordedVotes,0);
  denied(()=>f.vote(plan,f.owner),'QUORUM_REQUESTER');
  const first=f.vote(plan,f.left);assert.equal(first.status,'pending');assert.equal(first.quorum.recordedVotes,1);
  const sql=f.runtime.database[native],events=sql.prepare('SELECT count(*) AS n FROM clank_reviewed_events').get().n;
  assert.deepEqual(f.vote(plan,f.left),first);assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_events').get().n,events);
  denied(()=>f.commit(plan),'APPROVAL_REQUIRED');
  assert.equal(f.vote(plan,f.right).status,'approved');
  assert.equal(sql.prepare('SELECT approved_session FROM clank_reviewed_plans WHERE id=?').get(plan.id).approved_session,null);
  const receipt=f.commit(plan);assert.equal(receipt.changes.length,1);assert.deepEqual(f.commit(plan),receipt);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_receipts').get().n,1);
  assert.equal(f.runtime.database.read(db=>db.table('items').get(f.id),{userId:f.owner.user.id}).done,true);
});
test('two humans with the same role cannot satisfy a required role set, and sessionless identities cannot vote',async t=>{
  const f=await fixture(t),third=await f.register('reviewer'),plan=f.plan();
  f.vote(plan,f.left);assert.equal(f.vote(plan,third).status,'pending');denied(()=>f.commit(plan),'APPROVAL_REQUIRED');
  denied(()=>f.runtime.reviewedActions.decide(plan.id,'approve',{...f.right.auth,session:null}),'FORBIDDEN');
  assert.equal(f.vote(plan,f.right).status,'approved');assert.ok(f.commit(plan).id);
});
test('native role restoration and member removal cannot revive a vote, and revoked roles lose inbox access',async t=>{
  const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  f.member(f.left,{role:'viewer'});f.member(f.left,{role:'reviewer'});
  denied(()=>f.commit(plan),'QUORUM_REQUIRED');
  f.vote(plan,f.left);f.vote(plan,f.right);assert.ok(f.commit(plan).id);
  const next=f.plan();f.vote(next,f.left);f.vote(next,f.right);
  f.runtime.database.transaction(db=>db.table('members').delete(f.left.member));
  assert.deepEqual(f.runtime.reviewedActions.inbox(f.left.auth),[]);assert.deepEqual(f.runtime.reviewedActions.events(f.left.auth),[]);
  denied(()=>f.commit(next),'QUORUM_REQUIRED');
});
test('native expired/revoked sessions and policy changes do not satisfy a previously recorded quorum',async t=>{
  for(const mode of ['expires','revoked','policy']) {
    const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
    if(mode==='expires')f.runtime.database[native].prepare('UPDATE clank_auth_sessions SET expires_at=? WHERE id=?').run(Date.now()-1,f.left.auth.session.id);
    if(mode==='revoked')f.runtime.auth.revokeUserSessions(f.left.user.id);
    if(mode==='policy')f.reviewed.approvalQuorum.revision='quorum_v2';
    denied(()=>f.commit(plan),mode==='policy'?'QUORUM_POLICY_CHANGED':'QUORUM_REQUIRED');
  }
});
test('restart retains historical votes and receipts but requires new human votes before a pending quorum can execute',async t=>{
  const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);await f.reopen();
  const sql=f.runtime.database[native];assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_votes WHERE invalidated=1').get().n,2);
  denied(()=>f.commit(plan),'APPROVAL_REQUIRED');f.vote(plan,f.left);f.vote(plan,f.right);const receipt=f.commit(plan);
  await f.reopen();assert.deepEqual(f.commit(plan),receipt);assert.equal(sql===f.runtime.database[native],false);
});
test('native journal gaps fence approval dependencies while unrelated application writes preserve a quorum',async t=>{
  const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  f.runtime.database.transaction(db=>db.table('items').insert({done:false}),{userId:f.owner.user.id});assert.ok(f.commit(plan).id);
  const next=f.plan();f.vote(next,f.left);f.vote(next,f.right);
  f.runtime.database.transaction(db=>db.table('items').insert({done:false}),{userId:f.owner.user.id});
  f.runtime.database[native].prepare('DELETE FROM clank_changes').run();denied(()=>f.commit(next),'PREVIEW_STALE');
});
test('membership mutation and same-value restoration inside execute roll back application writes and consumption',async t=>{
  let member;
  const f=await fixture(t,{action:{execute({db},{id}){db.table('items').patch(id,{done:true});db.table('members').patch(member,{role:'viewer'});db.table('members').patch(member,{role:'reviewer'});return {id};}}});
  member=f.left.member;const plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);const version=f.runtime.database.version;
  denied(()=>f.commit(plan),'QUORUM_REQUIRED');assert.equal(f.runtime.database.version,version);
  const sql=f.runtime.database[native];assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_receipts').get().n,0);
  assert.equal(sql.prepare('SELECT status FROM clank_reviewed_plans WHERE id=?').get(plan.id).status,'approved');
  assert.equal(f.runtime.database.read(db=>db.table('items').get(f.id),{userId:f.owner.user.id}).done,false);
});
test('native ignored and altered vote writes cannot acknowledge unstored or substituted authority',async t=>{
  for(const mode of ['ignore','alter']) {
    const f=await fixture(t),plan=f.plan(),sql=f.runtime.database[native],version=f.runtime.database.version;
    sql.exec(mode==='ignore'?"CREATE TRIGGER quorum_bad_vote BEFORE INSERT ON clank_reviewed_votes BEGIN SELECT RAISE(IGNORE); END;":"CREATE TRIGGER quorum_bad_vote AFTER INSERT ON clank_reviewed_votes BEGIN UPDATE clank_reviewed_votes SET record=json_set(record,'$.sessionId','substituted_session') WHERE plan=NEW.plan AND actor=NEW.actor; END;");
    denied(()=>f.vote(plan,f.left),'QUORUM_WRITE');assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_votes').get().n,0);assert.equal(f.runtime.database.version,version);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM clank_reviewed_events WHERE transition='vote.approved'").get().n,0);
  }
});
test('native receipt, audit and consumption failures roll back the reviewed application write',async t=>{
  for(const target of ['receipt','audit','consume']) {
    const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);const sql=f.runtime.database[native];
    sql.exec(target==='receipt'?"CREATE TRIGGER quorum_bad_commit BEFORE INSERT ON clank_reviewed_receipts BEGIN SELECT RAISE(IGNORE); END;":target==='audit'?"CREATE TRIGGER quorum_bad_commit BEFORE INSERT ON clank_reviewed_events WHEN NEW.transition='consumed' BEGIN SELECT RAISE(IGNORE); END;":"CREATE TRIGGER quorum_bad_commit BEFORE UPDATE OF status ON clank_reviewed_plans WHEN NEW.status='consumed' BEGIN SELECT RAISE(IGNORE); END;");
    denied(()=>f.commit(plan),'QUORUM_WRITE');assert.equal(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_receipts').get().n,0);
    assert.equal(f.runtime.database.read(db=>db.table('items').get(f.id),{userId:f.owner.user.id}).done,false);
  }
});
test('actual native organization tightening rejects password votes and current quorum authority',async t=>{
  const f=await fixture(t,{security:true});await f.step();const plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  f.runtime.organizationSecurity.change(company,f.owner.auth,{expectedVersion:0,operationId:'quorum_policy_tightening_01',requirements:{factor:'mfa-or-passkey',ssoOnly:false,sessionMaxAgeMs:30*86400000,enrollmentGraceMs:0}});
  denied(()=>f.vote(plan,f.left),'ORGANIZATION_POLICY_REQUIRED');denied(()=>f.commit(plan),'PREVIEW_STALE');
  assert.equal(f.runtime.database[native].prepare('SELECT count(*) AS n FROM quorum_policy_audit').get().n,1);
});
test('native HTTP held-body decisions recheck revoked sessions and CSRF before persisting a vote',async t=>{
  const f=await fixture(t),plan=f.plan();
  const deniedCsrf=await f.runtime.handle(request('/__clank/approvals/decide',f.left,{id:plan.id,decision:'approve'},{'x-clank-csrf':'wrong'}));assert.equal(deniedCsrf.status,403);
  let stream,requested;const reading=new Promise(resolve=>{requested=resolve;});
  const req=new Request(origin+'/__clank/approvals/decide',{method:'POST',duplex:'half',headers:{origin,cookie:f.left.cookie,'x-clank-csrf':f.left.csrf,'content-type':'application/json'},body:new ReadableStream({start(controller){stream=controller;},pull(){requested();}},{highWaterMark:0})});
  const held=f.runtime.handle(req);await reading;f.runtime.auth.revokeUserSessions(f.left.user.id);
  stream.enqueue(new TextEncoder().encode(JSON.stringify({id:plan.id,decision:'approve'})));stream.close();assert.equal((await held).status,401);
  assert.equal(f.runtime.database[native].prepare('SELECT count(*) AS n FROM clank_reviewed_votes').get().n,0);
  const html=renderApprovalInbox([plan]);assert.doesNotMatch(html,new RegExp(f.left.auth.session.id));assert.match(html,/form/);
});
test('expired vote observation survives a denied transaction and clock rollback; reopening cannot revive prior votes',async t=>{
  const f=await fixture(t,{quorum:{voteTtlMs:1000},ttlMs:60000}),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  const before=Date.now,base=Date.now();
  try {
    Date.now=()=>base+1500;denied(()=>f.commit(plan),'QUORUM_REQUIRED');
    Date.now=()=>base;denied(()=>f.commit(plan),'QUORUM_REQUIRED');
  }finally{Date.now=before;}
  await f.reopen();denied(()=>f.commit(plan),'APPROVAL_REQUIRED');
  f.vote(plan,f.left);f.vote(plan,f.right);assert.ok(f.commit(plan).id);
});
test('unknown retained quorum protocols fail closed without deleting historical votes',async t=>{
  const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);const sql=f.runtime.database[native];
  sql.prepare('UPDATE clank_reviewed_quorum_state SET protocol=2').run();
  await assert.rejects(f.reopen(),error=>error.code==='QUORUM_PROTOCOL');
});
test('async or untracked membership callbacks cannot create a durable quorum plan',async t=>{
  for(const membership of [async()=>null,()=>({scope:company,role:'reviewer',version:'v1',policyVersion:'p1'})]) {
    const f=await fixture(t,{quorum:{membership}});
    assert.throws(()=>f.plan());assert.equal(f.runtime.database[native].prepare('SELECT count(*) AS n FROM clank_reviewed_plans').get().n,0);
  }
});
test('the native store rejects legacy single-approver session updates and removal of a retained quorum policy',async t=>{
  const f=await fixture(t),plan=f.plan();f.vote(plan,f.left);const sql=f.runtime.database[native];
  assert.throws(()=>sql.prepare("UPDATE clank_reviewed_plans SET status='approved',approved_by=?,approved_session=? WHERE id=? AND status='pending'").run(f.left.user.id,f.left.auth.session.id,plan.id),/Native quorum/);
  assert.throws(()=>sql.prepare('UPDATE clank_reviewed_plans SET quorum=NULL WHERE id=?').run(plan.id),/Native quorum/);
  assert.equal(sql.prepare('SELECT approved_session FROM clank_reviewed_plans WHERE id=?').get(plan.id).approved_session,null);
  denied(()=>f.commit(plan),'APPROVAL_REQUIRED');
});
test('compensation of a quorum mutation requires a new reviewed action and cannot inherit the original votes',async t=>{
  let executed=false;
  const f=await fixture(t,{action:{compensate(){executed=true;return true;}}}),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  const receipt=f.commit(plan);assert.equal(receipt.compensationAvailable,false);
  denied(()=>f.runtime.reviewedActions.compensate(receipt.id,f.owner.auth),'QUORUM_COMPENSATION_REVIEW');assert.equal(executed,false);
});
const message=(child,predicate)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('Native quorum controller message timed out.'));},15000);
  const onMessage=value=>{if(predicate(value)){cleanup();resolve(value);}},onExit=()=>{cleanup();reject(new Error('Native quorum controller exited before its signal.'));};
  const cleanup=()=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);};child.on('message',onMessage);child.once('exit',onExit);
});
async function controller(t,f) {
  const child=fork(new URL('./fixtures/approval-quorum-controller.mjs',import.meta.url),[f.path],{execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','pipe','ipc']});
  let diagnostic='';child.stderr.on('data',part=>{diagnostic=(diagnostic+part).slice(-8000);});
  const closed=once(child,'exit');t.after(async()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await closed;});
  try{return {child,closed,...await message(child,value=>value.ready)};}catch(error){throw new Error(error.message+' '+diagnostic);}
}
const commitHttp=(entry,f,plan,hold=false)=>fetch(entry.url+'/commit',{method:'POST',headers:{cookie:f.owner.cookie,'content-type':'application/json'},body:JSON.stringify({planId:plan.id,hold})});
test('actual controller SIGKILL after commit and before its HTTP reply preserves one exact native receipt',async t=>{
  const f=await fixture(t),entry=await controller(t,f),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  const committed=message(entry.child,value=>typeof value.committed==='string');
  const delivery=commitHttp(entry,f,plan,true).then(()=>true,()=>false);const signal=await committed;
  entry.child.kill('SIGKILL');await entry.closed;assert.equal(await delivery,false);
  await f.reopen();const replay=f.commit(plan);assert.equal(replay.id,signal.committed);
  assert.equal(f.runtime.database[native].prepare('SELECT count(*) AS n FROM clank_reviewed_receipts').get().n,1);
  assert.equal(f.runtime.database.read(db=>db.table('items').get(f.id),{userId:f.owner.user.id})._version,2);
});
test('two actual native controllers racing commit serialize one application write and return the same receipt',async t=>{
  const f=await fixture(t),left=await controller(t,f),right=await controller(t,f),plan=f.plan();f.vote(plan,f.left);f.vote(plan,f.right);
  const responses=await Promise.all([commitHttp(left,f,plan),commitHttp(right,f,plan)]);
  for(const response of responses)assert.equal(response.status,200,await response.clone().text());
  const [a,b]=await Promise.all(responses.map(response=>response.json()));assert.deepEqual(a,b);
  assert.equal(f.runtime.database[native].prepare("SELECT count(*) AS n FROM clank_reviewed_events WHERE transition='consumed'").get().n,1);
  assert.equal(f.runtime.database.read(db=>db.table('items').get(f.id),{userId:f.owner.user.id})._version,2);
});
