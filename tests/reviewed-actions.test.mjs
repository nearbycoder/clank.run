import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from '../dist/index.js';
import { defineReviewedAction, renderApprovalInbox } from '../dist/reviewed-actions.js';
const origin = 'https://review.test';
const internal = Symbol.for('clank.sqlite.internal');
function request(path, body, session, method = body === undefined ? 'GET' : 'POST') {
  return new Request(origin + path, { method, headers: { origin, ...(body === undefined ? {} : {'content-type':'application/json'}), ...(session ? {cookie: session.cookie, 'x-clank-csrf': session.csrf} : {}) }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
}
async function register(runtime, email = 'one@example.test') {
  const response = await runtime.handle(request('/__clank/auth/register', { email, password: 'passphrase-123456', profile: {name: email} }));
  assert.equal(response.status, 201); const data = await response.json();
  const session = {cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken};
  return {...session, auth: await runtime.auth.resolve(request('/', undefined, session))};
}
function action(overrides = {}) { return { revision: 'v1', title: 'Mark item done', args: s.object({ id: s.string() }),
  authorize: () => true, authorizeApproval: ({auth}, plan) => auth.user.id === plan.requestedBy,
  preview: ({db}, {id}) => { const item = db.table('items').get(id); if (!item) throw new Error('Missing'); return {id, oldDone:item.done, nextDone:true}; },
  execute: ({db}, {id}) => { db.table('items').patch(id,{done:true}); return {id}; },
  compensate: ({db}, receipt) => { db.table('items').patch(receipt.output.id,{done:false}); return {id:receipt.output.id}; }, ...overrides }; }
async function fixture(overrides = {}, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(),'clank-reviewed-'));
  const schema = defineDatabase({items: defineTable({done:s.boolean()}).owned()});
  const backend = defineBackend({schema,auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}})}).functions(({mutation,query}) => ({
    add: mutation({args:{},handler:({db})=>db.table('items').insert({done:false})}),
    change: mutation({args:{id:s.string(),workspace:s.string()},handler:({db},{id})=>db.table('items').patch(id,{done:true})}),
    read:query({args:{},handler:({db})=>db.table('items').collect()}),
  }));
  const options = {path:join(directory,'app.sqlite'), reviewedActions:{actions:{done:defineReviewedAction(schema, action(overrides))}},...extra};
  let runtime=await openBackend(backend,options);
  return {get runtime(){return runtime},async reopen(){runtime.close();runtime=await openBackend(backend,options)},async close(){runtime.close();await rm(directory,{recursive:true,force:true})}};
}
async function seed(f, session) { const caller=await f.runtime.caller(request('/',undefined,session));return caller.mutation('add',{}).value; }

test('reviewed mutations require approval, persist across restart, commit once, and produce exact undo receipts',async()=>{
  const f=await fixture();try{
    let session=await register(f.runtime);const id=await seed(f,session), reviews=f.runtime.reviewedActions;
    const plan=reviews.plan('done',{id},session.auth);assert.deepEqual(plan.preview,{id,oldDone:false,nextDone:true});
    assert.throws(()=>reviews.commit(plan.id,session.auth),/approval is required/);
    reviews.decide(plan.id,'approve',session.auth);await f.reopen();session.auth=await f.runtime.auth.resolve(request('/',undefined,session));
    const receipt=f.runtime.reviewedActions.commit(plan.id,session.auth);
    assert.deepEqual(receipt.changes,[{table:'items',id,beforeVersion:1,afterVersion:2}]);
    assert.equal(receipt.committedRevision,f.runtime.database.version);assert.equal(receipt.compensationAvailable,true);
    assert.deepEqual(f.runtime.reviewedActions.commit(plan.id,session.auth),receipt);
    const undone=f.runtime.reviewedActions.compensate(receipt.id,session.auth);
    assert.deepEqual(undone.changes,[{table:'items',id,beforeVersion:2,afterVersion:3}]);
    assert.deepEqual(f.runtime.reviewedActions.compensate(receipt.id,session.auth),undone);
    assert.equal(f.runtime.reviewedActions.receipt(receipt.id,session.auth).compensatedBy,undone.id);
    assert.deepEqual(f.runtime.reviewedActions.events(session.auth).map(e=>e.transition),['requested','approved','consumed','compensated']);
  }finally{await f.close()}
});

test('preview revision fences concurrent changes, expired decisions, account isolation, and stale compensation',async()=>{
  const f=await fixture();try{
    const session=await register(f.runtime), other=await register(f.runtime,'other@example.test'),id=await seed(f,session);
    const reviews=f.runtime.reviewedActions, plan=reviews.plan('done',{id},session.auth);reviews.decide(plan.id,'approve',session.auth);
    assert.deepEqual(reviews.inbox(other.auth),[]);assert.deepEqual(reviews.events(other.auth),[]);
    assert.throws(()=>reviews.commit(plan.id,other.auth),/not found/);assert.throws(()=>reviews.decide(plan.id,'approve',other.auth),/signed-in approver/);
    await seed(f,session);assert.throws(()=>reviews.commit(plan.id,session.auth),/Data changed/);
    const second=reviews.plan('done',{id},session.auth);reviews.decide(second.id,'approve',session.auth);const receipt=reviews.commit(second.id,session.auth);
    await seed(f,session);assert.throws(()=>reviews.compensate(receipt.id,session.auth),/Records changed/);
    const expired=reviews.plan('done',{id},session.auth);f.runtime.database[internal].prepare('UPDATE clank_reviewed_plans SET expires = ? WHERE id = ?').run(Date.now()-1,expired.id);
    assert.throws(()=>reviews.decide(expired.id,'approve',session.auth),/no longer pending/);
    assert.equal(reviews.inbox(session.auth).find(p=>p.id===expired.id).status,'expired');
  }finally{await f.close()}
});

test('failed or asynchronous execution rolls back writes, consumption and receipts',async()=>{
  for(const execute of [({db},{id})=>{db.table('items').patch(id,{done:true});throw new Error('failure')},({db},{id})=>{db.table('items').patch(id,{done:true});return Promise.resolve(true)},({db},{id})=>{db.table('items').patch(id,{done:true});return 'x'.repeat(70000)}]){
    const f=await fixture({execute});try{
      const session=await register(f.runtime),id=await seed(f,session), reviews=f.runtime.reviewedActions;
      const plan=reviews.plan('done',{id},session.auth);reviews.decide(plan.id,'approve',session.auth);const version=f.runtime.database.version;
      assert.throws(()=>reviews.commit(plan.id,session.auth));assert.equal(f.runtime.database.version,version);
      assert.equal(reviews.inbox(session.auth)[0].status,'approved');assert.equal(Number(f.runtime.database[internal].prepare('SELECT COUNT(*) AS n FROM clank_reviewed_receipts').get().n),0);
      assert.equal((await f.runtime.caller(request('/',undefined,session))).query('read',{}).value[0].done,false);
    }finally{await f.close()}
  }
});

test('approval inbox serves escaped previews and requires current session and CSRF for human decisions',async()=>{
  const f=await fixture({preview:()=>({text:'<script>alert(1)</script>'})});try{
    const session=await register(f.runtime), id=await seed(f,session), plan=f.runtime.reviewedActions.plan('done',{id},session.auth);
    assert.equal((await f.runtime.handle(request('/__clank/approvals'))).status,401);
    const html=await f.runtime.handle(new Request(origin+'/__clank/approvals',{headers:{cookie:session.cookie,accept:'text/html'}}));
    assert.equal(html.status,200);assert.doesNotMatch(await html.text(),/<script>/);
    assert.equal((await f.runtime.handle(request('/__clank/approvals/decide',{id:plan.id,decision:'approve'},{...session,csrf:'bad'}))).status,403);
    assert.equal((await f.runtime.handle(request('/__clank/approvals/decide',{id:plan.id,decision:'approve'},session))).status,200);
    f.runtime.auth.revokeUserSessions(session.auth.user.id);assert.throws(()=>f.runtime.reviewedActions.commit(plan.id,session.auth),/Sign in/);
    assert.match(renderApprovalInbox([]),/No approval requests/);
  }finally{await f.close()}
});

async function issueToken(runtime, session) {
  const client=await(await runtime.handle(request('/__clank/oauth/register',{client_name:'Review agent',redirect_uris:['http://127.0.0.1:4444/callback']}))).json();
  const verifier='reviewed-agent-test-pkce-verifier-012345678901234567890';
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const params={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',state:'review-test',code_challenge:challenge,code_challenge_method:'S256',scope:'agent:read agent:write',resource:origin+'/__clank/mcp'};
  const consent=await(await runtime.handle(request('/__clank/oauth/authorize?'+new URLSearchParams(params),undefined,session))).text();
  const consentToken=/name="consent_token" value="([^"]+)"/.exec(consent)[1];
  const form=(path,body)=>new Request(origin+path,{method:'POST',headers:{origin,cookie:session.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  const authorized=await runtime.handle(form('/__clank/oauth/authorize',{...params,csrf_token:session.csrf,consent_token:consentToken,decision:'approve'}));
  const code=new URL(authorized.headers.get('location')).searchParams.get('code');
  const tokens=await(await runtime.handle(form('/__clank/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code,code_verifier:verifier,resource:params.resource}))).json();
  assert.ok(tokens.access_token);return tokens;
}
async function call(runtime, token, name, args={}) {
  const result=await runtime.handle(new Request(origin+'/__clank/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name,authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'review-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
  const json=await result.json();return json.result;
}

test('OAuth exact action, workspace, resources and durable quotas protect real backend MCP calls',async()=>{
  const f=await fixture({}, {agent:{actionContext:(_action,input)=>({workspaceId:input.workspace,resourceIds:input.id?[input.id]:undefined})}});try{
    const session=await register(f.runtime),id=await seed(f,session),tokens=await issueToken(f.runtime,session);
    let list=await(await f.runtime.handle(request('/__clank/oauth/grants',undefined,session))).json();const grant=list.grants[0];
    const narrow=(constraints)=>f.runtime.handle(request('/__clank/oauth/grants/'+grant.id,{constraints},session,'PATCH'));
    assert.equal((await narrow({actions:['change'],workspaceIds:['workspace-1'],resourceIds:[id],maxOperations:2})).status,200);
    assert.equal((await narrow({actions:['change','read']})).status,422);
    assert.equal((await call(f.runtime,tokens.access_token,'read')).structuredContent.error.code,'GRANT_RESTRICTED');
    assert.equal((await call(f.runtime,tokens.access_token,'change',{id,workspace:'workspace-2'})).structuredContent.error.code,'GRANT_RESTRICTED');
    assert.equal((await call(f.runtime,tokens.access_token,'change',{id:'other',workspace:'workspace-1'})).structuredContent.error.code,'GRANT_RESTRICTED');
    assert.equal((await call(f.runtime,tokens.access_token,'change',{id,workspace:'workspace-1'})).isError,false);
    await f.reopen();assert.equal((await call(f.runtime,tokens.access_token,'change',{id,workspace:'workspace-1'})).isError,false);
    assert.equal((await call(f.runtime,tokens.access_token,'change',{id,workspace:'workspace-1'})).structuredContent.error.code,'GRANT_RESTRICTED');
    list=await(await f.runtime.handle(request('/__clank/oauth/grants',undefined,session))).json();assert.equal(list.grants[0].operationsUsed,2);
    assert.equal((await narrow({maxOperations:3})).status,422);
  }finally{await f.close()}
});

test('review MCP plan and commit return receipts only after browser approval',async()=>{
  const f=await fixture({}, {agentActivity:{}});try{
    const session=await register(f.runtime),id=await seed(f,session),tokens=await issueToken(f.runtime,session);
    const planned=await call(f.runtime,tokens.access_token,'review_plan_done',{id});assert.equal(planned.isError,false);
    const plan=planned.structuredContent;assert.equal((await call(f.runtime,tokens.access_token,'review_commit',{id:plan.id})).structuredContent.error.code,'APPROVAL_REQUIRED');
    assert.equal((await f.runtime.handle(request('/__clank/approvals/decide',{id:plan.id,decision:'approve'},session))).status,200);
    const result=await call(f.runtime,tokens.access_token,'review_commit',{id:plan.id});assert.equal(result.isError,false);assert.equal(result.structuredContent.protocol,'clank-action-receipt/1');
    const event=f.runtime.inspectAgentActivity().events[0];assert.equal(event.receiptId,result.structuredContent.id);assert.deepEqual(event.changes,result.structuredContent.changes);assert.equal(event.compensationAvailable,true);
  }finally{await f.close()}
});

test('current requester and approver authority is rechecked and definition changes invalidate reviews',async()=>{
  let allowed=true, canApprove=true;
  const selected=action({authorize:()=>allowed,authorizeApproval:()=>canApprove});
  const f=await fixture({}, {reviewedActions:{actions:{done:selected}}});try{
    const owner=await register(f.runtime), approver=await register(f.runtime,'approver@example.test'),id=await seed(f,owner),reviews=f.runtime.reviewedActions;
    const plan=reviews.plan('done',{id},owner.auth);reviews.decide(plan.id,'approve',approver.auth);
    canApprove=false;assert.throws(()=>reviews.commit(plan.id,owner.auth),/review this action again/);canApprove=true;
    allowed=false;assert.throws(()=>reviews.commit(plan.id,owner.auth),/no longer permitted/);allowed=true;
    selected.revision='v2';assert.throws(()=>reviews.commit(plan.id,owner.auth),/action changed/);selected.revision='v1';
    f.runtime.auth.revokeUserSessions(approver.auth.user.id);assert.throws(()=>reviews.commit(plan.id,owner.auth),/Data changed|review this action again/);
  }finally{await f.close()}
});

test('denied approvals are final, previews have no write methods, and expired plans have durable audit events',async()=>{
  const f=await fixture({preview:({db},{id})=>{assert.equal(db.table('items').patch,undefined);return{id};}});try{
    const session=await register(f.runtime),id=await seed(f,session),reviews=f.runtime.reviewedActions;
    const denied=reviews.plan('done',{id},session.auth);reviews.decide(denied.id,'deny',session.auth);
    assert.throws(()=>reviews.decide(denied.id,'approve',session.auth),/no longer pending/);assert.throws(()=>reviews.commit(denied.id,session.auth),/approval is required/);
    const expired=reviews.plan('done',{id},session.auth);f.runtime.database[internal].prepare('UPDATE clank_reviewed_plans SET expires = ? WHERE id = ?').run(Date.now()-1,expired.id);
    assert.equal(reviews.events(session.auth).filter(event=>event.planId===expired.id).at(-1).transition,'expired');
    assert.throws(()=>reviews.events(session.auth,-1),/cursor/);
    assert.equal((await f.runtime.handle(request('/__clank/approvals/events?after=0',undefined,session))).status,200);
  }finally{await f.close()}
});

test('grant restrictions survive token rotation, deny absent resource mapping, and reject forgery',async()=>{
  const f=await fixture();try{
    const session=await register(f.runtime),other=await register(f.runtime,'other@example.test'),id=await seed(f,session),tokens=await issueToken(f.runtime,session);
    const list=await(await f.runtime.handle(request('/__clank/oauth/grants',undefined,session))).json(), grant=list.grants[0];
    const path='/__clank/oauth/grants/'+grant.id;
    assert.equal((await f.runtime.handle(request(path,{constraints:{actions:['change']}},other,'PATCH'))).status,404);
    assert.equal((await f.runtime.handle(request(path,{constraints:{actions:['*']}},session,'PATCH'))).status,422);
    assert.equal((await f.runtime.handle(request(path,{constraints:{resourceIds:[id]}},session,'PATCH'))).status,200);
    assert.equal((await call(f.runtime,tokens.access_token,'change',{id,workspace:'workspace-1'})).structuredContent.error.code,'GRANT_RESTRICTED');
    const form=new Request(origin+'/__clank/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:grant.clientId,refresh_token:tokens.refresh_token,resource:origin+'/__clank/mcp'})});
    const refreshed=await(await f.runtime.handle(form)).json();assert.ok(refreshed.access_token);
    assert.equal((await call(f.runtime,refreshed.access_token,'change',{id,workspace:'workspace-1'})).structuredContent.error.code,'GRANT_RESTRICTED');
    assert.equal((await f.runtime.handle(request(path,{constraints:{resourceIds:null}},session,'PATCH'))).status,422);
  }finally{await f.close()}
});

test('two SQLite connections consume the same approval exactly once and return the durable receipt',async()=>{
  const f=await fixture();try{
    const session=await register(f.runtime),id=await seed(f,session),reviews=f.runtime.reviewedActions;
    const plan=reviews.plan('done',{id},session.auth);reviews.decide(plan.id,'approve',session.auth);
    const other=await openBackend(f.runtime.definition,{path:f.runtime.database[internal].prepare('PRAGMA database_list').all().find(row=>row.name==='main').file, reviewedActions:{actions:{done:action()}}});
    try{
      const secondAuth=await other.auth.resolve(request('/',undefined,session));const result=reviews.commit(plan.id,session.auth);
      assert.deepEqual(other.reviewedActions.commit(plan.id,secondAuth),result);
      assert.equal(other.database.read(db=>db.table('items').get(id),{userId:session.auth.user.id})._version,2);
    }finally{other.close()}
  }finally{await f.close()}
});

test('approver reauthorization reads the approver owned records rather than requester records',async()=>{
  const f=await fixture({authorizeApproval:({db})=>db.table('items').collect().some(item=>item.done)});try{
    const requester=await register(f.runtime), approver=await register(f.runtime,'reviewer@example.test'),id=await seed(f,requester), reviewerItem=await seed(f,approver);
    (await f.runtime.caller(request('/',undefined,approver))).mutation('change',{id:reviewerItem,workspace:'one'});
    const review=f.runtime.reviewedActions.plan('done',{id},requester.auth);f.runtime.reviewedActions.decide(review.id,'approve',approver.auth);
    assert.equal(f.runtime.reviewedActions.commit(review.id,requester.auth).changes[0].id,id);
  }finally{await f.close()}
});

test('grant identity mapping receives scoped database reads and simultaneous calls cannot exceed its last operation',async()=>{
  const f=await fixture({}, {agent:{actionContext:(_action,input,_auth,db)=>{const record=db.table('items').get(input.id);return record?{workspaceId:'trusted-workspace',resourceIds:[record._id]}:{}}}});try{
    const session=await register(f.runtime),id=await seed(f,session),tokens=await issueToken(f.runtime,session);
    const list=await(await f.runtime.handle(request('/__clank/oauth/grants',undefined,session))).json(),grant=list.grants[0];
    assert.equal((await f.runtime.handle(request('/__clank/oauth/grants/'+grant.id,{constraints:{actions:['change'],workspaceIds:['trusted-workspace'],resourceIds:[id],maxOperations:1}},session,'PATCH'))).status,200);
    const results=await Promise.all([call(f.runtime,tokens.access_token,'change',{id,workspace:'untrusted-input'}),call(f.runtime,tokens.access_token,'change',{id,workspace:'untrusted-input'})]);
    assert.equal(results.filter(result=>!result.isError).length,1);assert.equal(results.filter(result=>result.structuredContent.error?.code==='GRANT_RESTRICTED').length,1);
  }finally{await f.close()}
});

test('browser grant form narrows permissions, rejects expansion and shows current restrictions',async()=>{
  const f=await fixture();try{
    const session=await register(f.runtime);await issueToken(f.runtime,session);
    const list=await(await f.runtime.handle(request('/__clank/oauth/grants',undefined,session))).json(),grant=list.grants[0];
    const send=actions=>f.runtime.handle(new Request(origin+'/__clank/oauth/access',{method:'POST',headers:{origin,cookie:session.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:session.csrf,grant_id:grant.id,decision:'restrict',actions,max_operations:'0'})}));
    assert.equal((await send('read')).status,303);assert.equal((await send('read,change')).status,422);
    const html=await(await f.runtime.handle(request('/__clank/oauth/access',undefined,session))).text();assert.match(html,/Narrow action limits/);assert.match(html,/Operations used: 0/);
  }finally{await f.close()}
});

test('revoked action access hides persisted plans, events and both receipt kinds, including HTTP and MCP reads',async()=>{
 let allowed=true;const selected=action({authorize:()=>allowed});const f=await fixture({}, {reviewedActions:{actions:{done:selected}}});try{
  const owner=await register(f.runtime),id=await seed(f,owner),reviews=f.runtime.reviewedActions,tokens=await issueToken(f.runtime,owner);
  const plan=reviews.plan('done',{id},owner.auth);reviews.decide(plan.id,'approve',owner.auth);const receipt=reviews.commit(plan.id,owner.auth),undo=reviews.compensate(receipt.id,owner.auth);
  assert.equal(reviews.receipt(undo.id,owner.auth).id,undo.id);allowed=false;
  assert.deepEqual(reviews.inbox(owner.auth),[]);assert.deepEqual(reviews.events(owner.auth),[]);for(const record of [receipt,undo])assert.throws(()=>reviews.receipt(record.id,owner.auth),/no longer permitted/);
  const http=await(await f.runtime.handle(request('/__clank/approvals',undefined,owner))).json();assert.deepEqual(http.plans,[]);
  const mcp=await call(f.runtime,tokens.access_token,'review_receipt',{id:receipt.id});assert.equal(mcp.isError,true);assert.equal(mcp.structuredContent.error.code,'FORBIDDEN');
  allowed=true;selected.revision='v2';assert.deepEqual(reviews.inbox(owner.auth),[]);assert.deepEqual(reviews.events(owner.auth),[]);assert.throws(()=>reviews.receipt(undo.id,owner.auth),/action changed/);
 }finally{await f.close()}
});
