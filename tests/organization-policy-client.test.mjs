import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthClient,defineBackend,defineDatabase,openBackend} from '../dist/index.js';
import {createOrganizationSecurityClient} from '../dist/organization-security-policy.js';
import {fixture,company,defaults} from './fixtures/organization-policy-fixture.mjs';
async function clients(t) {
  const f=await fixture(t);await f.step();
  const runtime=await openBackend(defineBackend({schema:defineDatabase({}),auth:f.definition}).functions(()=>({})),{database:f.db,organizationSecurity:{organizationId:company,policy:f.hooks}});t.after(()=>runtime.close());
  let cookie=f.owner.cookie,sessionReads=0;
  const transport=async(url,options={})=>{const request=new Request(new URL(url,'http://127.0.0.1:42421'),{...options,headers:{...options.headers,cookie,origin:'http://127.0.0.1:42421'}});if(new URL(request.url).pathname==='/__clank/auth/session')sessionReads++;
    const response=await runtime.handle(request);if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;};
  const auth=createAuthClient({initial:{user:f.owner.user,session:f.owner.session,csrfToken:f.owner.csrf},fetch:transport});await auth.reload();
  return {...f,auth,transport,get sessionReads(){return sessionReads;}};
}
test('policy client exercises real auth, preview, CAS, lost-body acknowledgement and exact receipt against a bound backend',async t=>{
  const f=await clients(t);let lose=true;
  const client=createOrganizationSecurityClient({auth:f.auth,prefix:'/__clank/organizations',fetch:async(url,options)=>{
    const response=await f.transport(url,options);if(lose&&options.method==='POST'&&url.endsWith('/security-policy')&&response.ok){lose=false;return new Response(new ReadableStream({start(controller){controller.error(new Error('Owned fixture loses committed response'));}}),{status:response.status});}return response;
  }});
  assert.equal((await client.read(company)).version,0);const requirements={...defaults,factor:'mfa-or-passkey'},preview=await client.preview(company,requirements);assert.equal(preview.proposed.allowed,true);assert.equal(preview.capableAdministrators,1);
  const input={requirements,expectedVersion:0,operationId:'policy_client_lost_body_01'};await assert.rejects(client.change(company,input),/loses committed response/);
  assert.equal((await client.read(company)).version,1);assert.equal((await client.change(company,input)).version,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM policy_test_audit').get().n,1);
  await assert.rejects(client.change(company,{...input,requirements:defaults}),error=>error.code==='ORGANIZATION_POLICY_OPERATION_CONFLICT');
});
test('an actual account replacement during a held policy response cannot publish that response or reload the replacement account',async t=>{
  const f=await clients(t);let release,reached;const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>reached=resolve);
  const client=createOrganizationSecurityClient({auth:f.auth,prefix:'/__clank/organizations',fetch:async(url,options)=>{const response=await f.transport(url,options);reached();await held;return response;}});
  const pending=client.read(company);await ready;await f.auth.login({email:f.target.user.email,password:'correct horse battery staple'});assert.equal(f.auth.user.peek().id,f.target.user.id);const reads=f.sessionReads;release();
  await assert.rejects(pending,error=>error.code==='AUTH_CHANGED');assert.equal(f.sessionReads,reads);assert.equal(f.auth.user.peek().id,f.target.user.id);
});
test('synthetic oversized or inconsistent transport responses fail closed and remain distinct from real server acceptance',async t=>{
  const f=await clients(t),valid=createOrganizationSecurityClient({auth:f.auth,prefix:'/__clank/organizations',fetch:f.transport}),preview=await valid.preview(company,defaults);
  const large=createOrganizationSecurityClient({auth:f.auth,fetch:async()=>Response.json({ok:true,padding:'x'.repeat(33000)})});await assert.rejects(large.read(company),error=>error.code==='ORGANIZATION_POLICY_RESPONSE');
  const malformed=createOrganizationSecurityClient({auth:f.auth,fetch:async()=>Response.json({ok:true,preview:{...preview,proposed:{...preview.proposed,allowed:true,reasons:['factor']}}})});await assert.rejects(malformed.preview(company,defaults),error=>error.code==='ORGANIZATION_POLICY_RESPONSE');
});

const timeoutAuth=reload=>({user:{peek:()=>({id:'policy_timeout_user'})},session:{peek:()=>({id:'policy_timeout_session'})},csrfHeader:()=>({}),reload});
async function assertDeadline(operation) {
  let timer;
  try {await assert.rejects(Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Policy deadline did not settle the held operation.')),1000);})]),error=>error.code==='ORGANIZATION_POLICY_TIMEOUT'&&error.status===504);}
  finally {clearTimeout(timer);}
}
test('bounded policy deadline rejects an abort-ignoring transport and discards its late response without reloading auth',async()=>{
  let release,signal,reloads=0,cancelled=0,calls=0;
  const held=new Promise(resolve=>release=resolve),client=createOrganizationSecurityClient({auth:timeoutAuth(async()=>{reloads++;}),timeoutMs:100,fetch:(_url,options)=>{calls++;signal=options.signal;return held;}});
  try {await assertDeadline(client.read(company));assert.equal(signal.aborted,true);}
  finally {release(new Response(new ReadableStream({cancel(){cancelled++;}})));await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(calls,1);assert.equal(reloads,0);assert.equal(cancelled,1);
});
test('bounded policy deadline covers an abort-ignoring response body and an uncooperative stream cancellation',async()=>{
  let signal,reloads=0,cancelled=0;
  const response=new Response(new ReadableStream({start(){},cancel(){cancelled++;return new Promise(()=>{});}}));
  const client=createOrganizationSecurityClient({auth:timeoutAuth(async()=>{reloads++;}),timeoutMs:100,fetch:async(_url,options)=>{signal=options.signal;return response;}});
  try {await assertDeadline(client.read(company));assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(reloads,0);}
  finally {void response.body?.cancel().catch(()=>{});}
});
test('bounded policy deadline includes auth reload after either an accepted response or a transport error',async()=>{
  for(const failTransport of [false,true]) {
    let release,reloads=0;
    const held=new Promise(resolve=>release=resolve),client=createOrganizationSecurityClient({auth:timeoutAuth(()=>{reloads++;return held;}),timeoutMs:100,fetch:async()=>{
      if(failTransport)throw new Error('Controlled transport failure.');
      return Response.json({ok:true,policy:{organizationId:company,...defaults,version:0,updatedAt:0}});
    }});
    try {await assertDeadline(client.read(company));assert.equal(reloads,1);}
    finally {release();await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(reloads,1);
  }
});
