import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {defineBackend,defineDatabase,openBackend,s} from '../dist/index.js';
import {serve} from '../dist/node.js';
import {fixture,company,defaults} from './fixtures/organization-policy-fixture.mjs';

async function application(t,f,configured=true) {
  const definition=defineBackend({schema:defineDatabase({}),auth:f.definition}).functions(({query,mutation})=>({
    protected:query({args:{},handler:()=>({authorized:true})}),effect:mutation({args:{},handler:()=>{f.sql.prepare('INSERT INTO policy_test_audit VALUES(?,?,?,?)').run('guarded-effect','fixture',company,'{}');return {committed:true};}}),
  }));
  const runtime=await openBackend(definition,{database:f.db,...(configured?{organizationSecurity:{organizationId:company,policy:f.hooks}}:{}),reviewedActions:{actions:{review:{revision:'1',title:'Policy review',args:s.object({}),authorize:()=>true,authorizeApproval:()=>true,preview:()=>({}),execute:()=>({committed:true})}}}});
  t.after(()=>runtime.close());const server=await serve(request=>runtime.handle(request),{hostname:'127.0.0.1',port:0});t.after(()=>server.close());
  return {runtime,url:`http://127.0.0.1:${server.port}`};
}
async function delegate(app,account) {
  const post=async(path,input,headers={})=>fetch(app.url+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:input instanceof URLSearchParams?input:JSON.stringify(input),redirect:'manual'});
  const register=await post('/__clank/oauth/register',{client_name:'Native security policy agent',redirect_uris:[app.url+'/fixture/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},{'content-type':'application/json'});
  assert.equal(register.status,201,await register.clone().text());const client=await register.json(),verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const authorization={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',state:'policy-client-state',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'agent:read agent:write',resource:app.url+'/__clank/mcp'};
  const page=await fetch(app.url+'/__clank/oauth/authorize?'+new URLSearchParams(authorization),{headers:{cookie:account.cookie}});assert.equal(page.status,200,await page.clone().text());
  const consent=/name="consent_token" value="([^"]+)"/u.exec(await page.text())?.[1];assert.ok(consent);
  const approved=await post('/__clank/oauth/authorize',new URLSearchParams({...authorization,csrf_token:account.csrf,consent_token:consent,decision:'approve'}),{cookie:account.cookie,origin:app.url});assert.equal(approved.status,303,await approved.clone().text());
  const exchanged=await post('/__clank/oauth/token',new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:new URL(approved.headers.get('location')).searchParams.get('code'),redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:authorization.resource}));
  assert.equal(exchanged.status,200,await exchanged.clone().text());return {client,...await exchanged.json()};
}
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'policy-fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
async function mcp(app,grant,method='tools/list',params={},status=200) {
  const response=await fetch(app.url+'/__clank/mcp',{method:'POST',headers:{authorization:'Bearer '+grant.access_token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{_meta:meta,...params}})});
  const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
}
async function refresh(app,grant,status=200) {
  const response=await fetch(app.url+'/__clank/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:grant.client.client_id,refresh_token:grant.refresh_token,resource:app.url+'/__clank/mcp'})});
  const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return {...grant,...body};
}
const save=(version=0,operationId='policy_mcp_save_01')=>({requirements:{...defaults,factor:'mfa-or-passkey'},expectedVersion:version,operationId});
test('real native MCP consent, PKCE and refresh retain their human policy generation and reject tightening, relaxation and origin revocation',async t=>{
  const f=await fixture(t),app=await application(t,f),caller=await f.step(),legacy=await delegate(app,f.owner);
  assert.ok((await mcp(app,legacy)).result.tools.some(tool=>tool.name.includes('protected')));
  f.controller.change(company,caller,save());await mcp(app,legacy,'tools/list',{},401);await refresh(app,legacy,401);
  const grant=await delegate(app,f.owner),listed=await mcp(app,grant),tool=listed.result.tools.find(tool=>tool.name.includes('effect'));assert.ok(tool);
  const invoked=await mcp(app,grant,'tools/call',{name:tool.name,arguments:{}});assert.ok(!invoked.error&&!invoked.result.isError);
  const rotated=await refresh(app,grant);await mcp(app,rotated);const exact=await refresh(app,grant);assert.equal(exact.access_token,rotated.access_token);
  f.controller.change(company,caller,{...save(1,'policy_mcp_relax_02'),requirements:defaults});await mcp(app,rotated,'tools/call',{name:tool.name,arguments:{}},401);await refresh(app,grant,401);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM policy_test_audit WHERE action='guarded-effect'").get().n,1);
  const latest=await delegate(app,f.owner);f.sql.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(caller.session.id);await mcp(app,latest,'tools/list',{},401);await refresh(app,latest,401);
});
test('a live backend without a configured binding rejects newly persisted policy, including direct reviewed actions',async t=>{
  const f=await fixture(t),app=await application(t,f,false),caller=await f.step();
  assert.equal((await app.runtime.caller(f.request('/',f.owner))).query('protected',{}).value.authorized,true);
  app.runtime.reviewedActions.plan('review',{},caller);const grant=await delegate(app,f.owner);await mcp(app,grant);
  f.controller.change(company,caller,save());
  await mcp(app,grant,'tools/list',{},500);
  const held=await app.runtime.caller(f.request('/',f.owner));assert.throws(()=>held.query('protected',{}),error=>error.code==='ORGANIZATION_POLICY_UNCONFIGURED');
  assert.throws(()=>app.runtime.reviewedActions.plan('review',{},caller),error=>error.code==='ORGANIZATION_POLICY_UNCONFIGURED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_reviewed_plans').get().n,1);
});
