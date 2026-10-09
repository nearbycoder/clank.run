import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {defineAuth,defineBackend,defineDatabase,openBackend,createAuthClient,renderToString} from '../dist/index.js';
import {openOrganizationSso} from '../dist/organization-sso.js';
import {AccountSecurity,PasswordRecoveryForm,EmailVerificationForm,createOrganizationIdentityClient} from '../dist/account-security.js';
const origin='https://security.test',key=Symbol.for('clank.sqlite.internal');
function req(path,body,session,method=body===undefined?'GET':'POST'){return new Request(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-clank-csrf':session.csrf}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})})}
async function fixture(options={}){const dir=await mkdtemp(join(tmpdir(),'clank-org-security-'));const runtime=await openBackend(defineBackend({schema:defineDatabase({}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024},...options})}).functions(()=>({})),{path:join(dir,'app.sqlite')});return{runtime,async close(){runtime.close();await rm(dir,{recursive:true,force:true})}}}
async function register(runtime,email='security@example.test'){const response=await runtime.handle(req('/__clank/auth/register',{email,password:'password-for-tests',profile:{name:'Security'}}));assert.equal(response.status,201);const result=await response.json();return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:result.csrfToken,user:result.user,session:result.session}}
async function post(runtime,path,body,session,status=200){const response=await runtime.handle(req(path,body,session));const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json}

test('password+MFA step-up is bound to the current session, expires, and consumes once',async()=>{
 const deliveries=[];const f=await fixture({mfa:{send:delivery=>deliveries.push(delivery)}});try{
  const owner=await register(f.runtime),other=await register(f.runtime,'other@example.test');
  const auth=await f.runtime.auth.resolve(req('/',undefined,owner));assert.throws(()=>f.runtime.auth.requireFreshAuthentication(auth),/passkey or MFA/);
  const start=await post(f.runtime,'/__clank/auth/reauthenticate/mfa/start',{password:'password-for-tests'},owner);
  await post(f.runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:start.challengeId,code:deliveries.at(-1).code},other,401);
  await post(f.runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:start.challengeId,code:deliveries.at(-1).code},owner);
  assert.equal(f.runtime.auth.requireFreshAuthentication(auth).session.authenticationMethod,'mfa');
  await post(f.runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:start.challengeId,code:deliveries.at(-1).code},owner,401);
  f.runtime.database[key].prepare('UPDATE clank_auth_sessions SET authenticated_at = ? WHERE id = ?').run(Date.now()-400000,owner.session.id);
  assert.throws(()=>f.runtime.auth.requireFreshAuthentication(auth),/passkey or MFA/);
  const latest=await post(f.runtime,'/__clank/auth/reauthenticate/mfa/start',{password:'password-for-tests'},owner);
  for(let i=0;i<5;i++)await post(f.runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:latest.challengeId,code:'wrong'},owner,401);
  await post(f.runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:latest.challengeId,code:deliveries.at(-1).code},owner,401);
 }finally{await f.close()}
});

test('passkey step-up verifies a real signed assertion with UV and rejects cross-session replay',async()=>{
 const f=await fixture();try{
  const owner=await register(f.runtime),other=await register(f.runtime,'second@example.test'),sql=f.runtime.database[key];
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('stepup-key-credential').toString('base64url');
  sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES (?, ?, ?, ?, ?, -7, 0, ?, ?)').run('stepup-key',credentialId,owner.user.id,'Security key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await post(f.runtime,'/__clank/auth/reauthenticate/passkey/start',{},owner);assert.equal(start.options.userVerification,'required');assert.deepEqual(start.options.allowCredentials,[{type:'public-key',id:credentialId,transports:[]}]);
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update('security.test').digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  const input={challengeId:start.challengeId,challenge:start.options.challenge,credential};
  const verified=await post(f.runtime,'/__clank/auth/reauthenticate/passkey/finish',input,owner);assert.equal(verified.session.id,owner.session.id);assert.equal(verified.session.authenticationMethod,'passkey');
  await post(f.runtime,'/__clank/auth/reauthenticate/passkey/finish',input,other,400);
  assert.equal(f.runtime.auth.requireFreshAuthentication(await f.runtime.auth.resolve(req('/',undefined,owner))).session.authenticationMethod,'passkey');
 }finally{await f.close()}
});

test('session inventory and revocation are owner scoped and security screens expose complete flows',async()=>{
 const f=await fixture();try{
  const owner=await register(f.runtime),other=await register(f.runtime,'other@example.test');
  const list=await(await f.runtime.handle(req('/__clank/auth/sessions',undefined,owner))).json();assert.equal(list.sessions.length,1);assert.equal(list.sessions[0].current,true);
  await post(f.runtime,'/__clank/auth/sessions/revoke',{id:other.session.id},owner,404);
  const client=createAuthClient({initial:{user:owner.user,session:owner.session,csrfToken:owner.csrf},fetch:async(url,init)=>f.runtime.handle(new Request(new URL(url,origin),{...init,headers:{...init?.headers,cookie:owner.cookie,origin}}))});
  assert.equal((await client.listSessions()).length,1);
  const html=await renderToString(AccountSecurity({auth:client}));for(const label of ['Active sessions','Passkeys','Email verification','Change password','Verify with a passkey'])assert.ok(html.includes(label));
  assert.match(await renderToString(PasswordRecoveryForm({auth:client})),/Send recovery email/);assert.match(await renderToString(PasswordRecoveryForm({auth:client,resetToken:'secret'})),/Reset password/);assert.doesNotMatch(await renderToString(EmailVerificationForm({auth:client,token:'secret-token'})),/secret-token/);
  await client.revokeSession(owner.session.id);assert.equal(client.user.value,null);
 }finally{await f.close()}
});

async function mockIdp(){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'ES256',use:'sig'};
 let issuer='',overrides={},wrongSignature=false,discoveryOverride={};const codes=new Map();let tokenCalls=0,heldKeys;
 const server=createServer(async(request,response)=>{const url=new URL(request.url,issuer);response.setHeader('content-type','application/json');
  if(url.pathname==='/.well-known/openid-configuration')return response.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['ES256'],...discoveryOverride}));
  if(url.pathname==='/keys'){if(heldKeys){const held=heldKeys;heldKeys=undefined;held.reached();await held.wait;}return response.end(JSON.stringify({keys:[jwk]}));}
  if(url.pathname==='/authorize'){const code=crypto.randomUUID();codes.set(code,Object.fromEntries(url.searchParams));response.writeHead(302,{location:url.searchParams.get('redirect_uri')+'?'+new URLSearchParams({code,state:url.searchParams.get('state')})});return response.end()}
  if(url.pathname==='/token'){tokenCalls++;let body='';for await(const chunk of request)body+=chunk;const input=new URLSearchParams(body),flow=codes.get(input.get('code'));codes.delete(input.get('code'));
   if(!flow||input.get('redirect_uri')!==flow.redirect_uri||createHash('sha256').update(input.get('code_verifier')).digest('base64url')!==flow.code_challenge){response.statusCode=400;return response.end('{}')}
   const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'clank-client',sub:'employee-1',nonce:flow.nonce,iat:now,auth_time:now,exp:now+300,email:'employee@example.test',email_verified:true,name:'Employee',...overrides};
   const message=[{alg:'ES256',kid:jwk.kid},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
   const signature=wrongSignature?Buffer.alloc(64):sign('sha256',Buffer.from(message),{key:privateKey,dsaEncoding:'ieee-p1363'});return response.end(JSON.stringify({id_token:message+'.'+signature.toString('base64url'),token_type:'Bearer',access_token:'ignored'}));
  }response.statusCode=404;response.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));issuer='http://127.0.0.1:'+server.address().port;
 return {issuer,get tokenCalls(){return tokenCalls},holdKeys(){let reached,release;const ready=new Promise(resolve=>reached=resolve),wait=new Promise(resolve=>release=resolve);heldKeys={reached,wait};return {ready,release}},setClaims(value){overrides=value},badSignature(value){wrongSignature=value},setDiscovery(value){discoveryOverride=value},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}
async function ssoFixture(){const f=await fixture(),idp=await mockIdp(),secret='offboard-test-secret-32-characters-minimum',options={applicationOrigin:origin,allowInsecureLoopback:true,providers:[{organizationId:'company',issuer:idp.issuer,clientId:'clank-client',offboardingToken:secret}]};const sso=openOrganizationSso(f.runtime.database,f.runtime.auth,options);return{...f,idp,secret,sso,async close(){await idp.close();await f.close()}}}
async function flow(f,alter){const start=await f.sso.handle(req('/__clank/sso/start/company'));assert.equal(start.status,303);const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});const callback=new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}});return f.sso.handle(alter?alter(callback):callback)}

test('real mock OIDC code+PKCE sign-in creates a subject bound session and offboarding atomically revokes access',async()=>{
 const f=await ssoFixture();try{
  const response=await flow(f);assert.equal(response.status,303,await response.clone().text());const cookie=response.headers.get('set-cookie').split(';')[0];
  const session=await f.runtime.auth.resolve(new Request(origin,{headers:{cookie}}));assert.equal(session.user.email,'employee@example.test');assert.equal(session.session.authenticationMethod,'sso');
  const token='oauth-issued-to-employee';const digest=createHash('sha256').update(token).digest('base64url');
  const sql=f.runtime.database[key];sql.prepare('INSERT INTO clank_oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES (?, ?, ?, ?)').run('offboard-client','Agent','[]',Date.now());
  sql.prepare("INSERT INTO clank_oauth_tokens(token_hash,kind,family_id,client_id,user_id,scope,resource,expires_at,created_at) VALUES (?, 'access', ?, ?, ?, 'agent:read', ?, ?, ?)").run(digest,'offboard-family','offboard-client',session.user.id,origin+'/__clank/mcp',Date.now()+60000,Date.now());
  const offboard=()=>f.sso.handle(new Request(origin+'/__clank/sso/offboard/company',{method:'POST',headers:{authorization:'Bearer '+f.secret,'content-type':'application/json'},body:JSON.stringify({subject:'employee-1'})}));
  assert.equal((await offboard()).status,200);assert.equal((await f.runtime.auth.resolve(new Request(origin,{headers:{cookie}}))).user,null);assert.ok(sql.prepare('SELECT consumed_at FROM clank_oauth_tokens WHERE token_hash = ?').get(digest).consumed_at);assert.equal((await flow(f)).status,403);assert.equal((await offboard()).status,200);
 }finally{await f.close()}
});

test('OIDC rejects state forgery, token signature and claim failures, untrusted discovery endpoints and email takeover',async()=>{
 const f=await ssoFixture();try{
  assert.equal((await flow(f,request=>new Request(request.url))).status,400);
  for(const claims of [{nonce:'forged'},{iss:'https://evil.test'},{aud:'wrong-client'},{aud:['clank-client','other']},{exp:1},{email_verified:false}]){f.idp.setClaims(claims);assert.notEqual((await flow(f)).status,303)}
  f.idp.setClaims({});f.idp.badSignature(true);assert.equal((await flow(f)).status,400);f.idp.badSignature(false);
  f.idp.setDiscovery({token_endpoint:'https://evil.test/token'});const discovery=await f.sso.handle(req('/__clank/sso/start/company'));assert.equal(discovery.status,400);f.idp.setDiscovery({});
  await register(f.runtime,'employee@example.test');assert.equal((await flow(f)).status,409);
 }finally{await f.close()}
});

test('offboarding before first sign-in retains a tombstone and requires the organization secret',async()=>{
 const f=await ssoFixture();try{
  const request=token=>new Request(origin+'/__clank/sso/offboard/company',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({subject:'employee-1'})});
  assert.equal((await f.sso.handle(request('bad'))).status,401);assert.equal((await f.sso.handle(request(f.secret))).status,200);assert.equal((await flow(f)).status,403);
 }finally{await f.close()}
});

async function platformFixture(options={}){
 const {openPlatform}=await import('../dist/platform.js');const {DatabaseSync}=await import('node:sqlite');const dir=await mkdtemp(join(tmpdir(),'clank-team-security-'));
 const settings={dataDirectory:dir,publicUrl:origin,signup:true,backups:{intervalMs:false},...options};let platform=await openPlatform(settings);const sql=new DatabaseSync(join(dir,'control.sqlite'));
 return {dir,sql,get platform(){return platform},async reopen(extra){await platform.close();platform=await openPlatform({...settings,...extra})},async close(){sql.close();await platform.close();await rm(dir,{recursive:true,force:true})}};
}
async function pcall(f,path,body,session,status=200,method){const response=await f.platform.handle(req(path,body,session,method));const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value}
async function addMember(f,project,owner,member){const invitation=await pcall(f,`/api/organizations/${project.organizationId}/invitations`,{email:member.user.email,role:'viewer'},owner,201);await pcall(f,'/api/invitations/accept',{token:invitation.invitation.token},member);}

test('project permissions fence routes, listings, escalation, cross-workspace members and removal/reinvite',async()=>{
 const f=await platformFixture();try{
  const owner=await register(f.platform),member=await register(f.platform,'teammate@example.test'),outsider=await register(f.platform,'outsider@example.test');
  const {project}=await pcall(f,'/api/projects',{name:'Team project'},owner,201);await addMember(f,project,owner,member);
  await pcall(f,`/api/projects/${project.id}/members/${outsider.user.id}`,{permissions:['read']},owner,404,'PUT');
  await pcall(f,`/api/projects/${project.id}/members/${member.user.id}`,{permissions:['read','secrets']},owner,200,'PUT');
  await pcall(f,`/api/projects/${project.id}/secrets`,undefined,member);await pcall(f,`/api/projects/${project.id}/logs`,undefined,member,403);
  await pcall(f,`/api/projects/${project.id}/members/${member.user.id}`,{permissions:['tokens']},member,403,'PUT');
  await pcall(f,`/api/projects/${project.id}/members/${member.user.id}`,{permissions:[]},owner,200,'PUT');
  await pcall(f,`/api/projects/${project.id}`,undefined,member,403);const list=await pcall(f,'/api/projects',undefined,member);assert.ok(!list.projects.some(item=>item.id===project.id));
  await pcall(f,`/api/organizations/${project.organizationId}/members/${member.user.id}`,{},owner,200,'DELETE');assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_project_members WHERE user_id=?').get(member.user.id).n,0);
  await addMember(f,project,owner,member);await pcall(f,`/api/projects/${project.id}/logs`,undefined,member);
 }finally{await f.close()}
});

test('platform sensitive changes require current passkey assurance when enabled',async()=>{
 const f=await platformFixture({freshAuthentication:{required:true,maxAgeMs:60000}});try{
  const owner=await register(f.platform),member=await register(f.platform,'fresh-member@example.test');const {project}=await pcall(f,'/api/projects',{name:'Fresh protected'},owner,201);await addMember(f,project,owner,member);
  const path=`/api/projects/${project.id}/members/${member.user.id}`;const denied=await pcall(f,path,{permissions:['read']},owner,403,'PUT');assert.equal(denied.error.code,'FRESH_AUTH_REQUIRED');
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('platform-stepup-key').toString('base64url');
  f.sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES (?, ?, ?, ?, ?, -7, 0, ?, ?)').run('platform-stepup-key',credentialId,owner.user.id,'Security key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await pcall(f,'/__clank/auth/reauthenticate/passkey/start',{},owner);const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update('security.test').digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  await pcall(f,'/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential},owner);await pcall(f,path,{permissions:['read']},owner,200,'PUT');
  f.sql.prepare('UPDATE clank_auth_sessions SET authenticated_at = ? WHERE id = ?').run(Date.now()-60001,owner.session.id);await pcall(f,path,{permissions:['read','logs']},owner,403,'PUT');
 }finally{await f.close()}
});

test('platform SSO provisions viewer membership and durable offboarding revokes device and platform tokens',async()=>{
 const f=await platformFixture(),idp=await mockIdp(),secret='platform-offboarding-secret-long-enough';try{
  const owner=await register(f.platform);const {project}=await pcall(f,'/api/projects',{name:'SSO workspace'},owner,201);
  await f.reopen({organizationSso:{applicationOrigin:origin,allowInsecureLoopback:true,providers:[{organizationId:project.organizationId,issuer:idp.issuer,clientId:'clank-client',offboardingToken:secret}]}});
  const start=await f.platform.handle(req(`/__clank/sso/start/${project.organizationId}`));assert.equal(start.status,303);const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});const callback=new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}});const response=await f.platform.handle(callback.clone());assert.equal(response.status,303,await response.clone().text());assert.equal((await f.platform.handle(callback)).status,400);
  const cookie=response.headers.get('set-cookie').split(';')[0];const state=await(await f.platform.handle(new Request(origin+'/__clank/auth/session',{headers:{cookie}}))).json();const employee={cookie,csrf:state.csrfToken,user:state.user};assert.equal(f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(project.organizationId,employee.user.id).role,'viewer');
  const started=await pcall(f,'/api/device/start',{clientName:'Employee CLI'},undefined,201);await pcall(f,'/api/device/approve',{code:started.userCode},employee);const cli=await pcall(f,'/api/device/token',{deviceCode:started.deviceCode});
  const pending=await pcall(f,'/api/device/start',{clientName:'Pending CLI'},undefined,201);await pcall(f,'/api/device/approve',{code:pending.userCode},employee);
  const offboard=await f.platform.handle(new Request(origin+`/__clank/sso/offboard/${project.organizationId}`,{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({subject:'employee-1'})}));assert.equal(offboard.status,200,await offboard.clone().text());
  assert.equal((await f.platform.handle(new Request(origin+'/api/projects',{headers:{authorization:'Bearer '+cli.accessToken}}))).status,401);assert.equal((await f.platform.handle(req('/api/projects',undefined,employee))).status,401);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_memberships WHERE user_id=?').get(employee.user.id).n,0);await pcall(f,'/api/device/token',{deviceCode:pending.deviceCode},undefined,400);
 }finally{await idp.close();await f.close()}
});

async function identityFixture(extra={}) {
 const dir=await mkdtemp(join(tmpdir(),'clank-linked-identities-')),deliveries=[],idp=await mockIdp(),second=await mockIdp();
 const definition=defineBackend({schema:defineDatabase({}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024},mfa:{send:delivery=>deliveries.push(delivery)}})}).functions(()=>({}));
 let runtime=await openBackend(definition,{path:join(dir,'identities.sqlite')});
 const options={applicationOrigin:origin,allowInsecureLoopback:true,identityLinking:{policyRevision:1},providers:[{organizationId:'company',issuer:idp.issuer,clientId:'clank-client',offboardingToken:'organization-one-offboarding-secret-32chars'},{organizationId:'second',issuer:second.issuer,clientId:'clank-client',offboardingToken:'organization-two-offboarding-secret-32chars'}],...extra};
 let sso=openOrganizationSso(runtime.database,runtime.auth,options);
 return {dir,idp,second,options,deliveries,get runtime(){return runtime},get sso(){return sso},get sql(){return runtime.database[key]},
  async fresh(session){const start=await post(runtime,'/__clank/auth/reauthenticate/mfa/start',{password:'password-for-tests'},session);await post(runtime,'/__clank/auth/reauthenticate/mfa/finish',{challengeId:start.challengeId,code:deliveries.at(-1).code},session);return session},
  async reopen(updated=options){runtime.close();runtime=await openBackend(definition,{path:join(dir,'identities.sqlite')});sso=openOrganizationSso(runtime.database,runtime.auth,updated)},
  async close(){runtime.close();await idp.close();await second.close();await rm(dir,{recursive:true,force:true})}};
}
async function identityCall(f,path,body,session,status=200){const response=await f.sso.handle(req('/__clank/sso/'+path,body,session));const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json}
async function linkingFlow(f,session,organization='company') {
 const start=await f.sso.handle(req('/__clank/sso/link/'+organization,{},session)),body=await start.json();assert.equal(start.status,200,JSON.stringify(body));
 const location=new URL(body.authorizationUrl);assert.equal(location.searchParams.get('prompt'),'login');assert.equal(location.searchParams.get('max_age'),'0');
 const authorized=await fetch(location,{redirect:'manual'}),request=new Request(authorized.headers.get('location'),{headers:{cookie:session.cookie+'; '+start.headers.get('set-cookie').split(';')[0]}});
 return {request,finish:()=>f.sso.handle(request.clone())};
}
async function loginLocal(runtime,email='local@example.test'){
 const response=await runtime.handle(req('/__clank/auth/login',{email,password:'password-for-tests'}));const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:result.csrfToken,user:result.user,session:result.session};
}
async function identityOffboard(f,organization='company',subject='employee-1') {const provider=f.options.providers.find(provider=>provider.organizationId===organization);return f.sso.handle(new Request(origin+'/__clank/sso/offboard/'+organization,{method:'POST',headers:{authorization:'Bearer '+provider.offboardingToken,'content-type':'application/json'},body:JSON.stringify({subject})}));}

async function provisioningIdentityFixture() {
 const f=await identityFixture(),assignments=[],token='separate-scim-organization-identity-proof-token';
 const options={...f.options,identityLinking:{policyRevision:2},providers:f.options.providers.map(provider=>provider.organizationId==='company'
  ?{...provider,provisioning:{token,expiresAt:Date.now()+600000,groupRoles:[{externalId:'developers',role:'developer'}]}}:provider),
  onProvision(){throw new Error('Managed identities must use provisioning ownership hooks.')},
  onProvisioning(userId,organizationId,assignment){assignments.push({userId,organizationId,...assignment})}};
 await f.reopen(options);
 const scim=async(path,body,method=body===undefined?'GET':'POST',etag,expected=200,retryKey)=>{
  const response=await f.sso.handle(new Request(origin+'/scim/v2/company/'+path,{method,headers:{authorization:'Bearer '+token,
   ...(body===undefined?{}:{'content-type':'application/scim+json'}),...(etag?{'if-match':etag}:{}),...(retryKey?{'x-clank-idempotency-key':retryKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const result=response.status===204?null:await response.json();assert.equal(response.status,expected,JSON.stringify(result));return{response,body:result};
 };
 return{...f,get runtime(){return f.runtime},get sql(){return f.sql},get sso(){return f.sso},options,assignments,scim};
}

test('SCIM binding requires signed OIDC proof; disable and reactivation retain ownership and independent offboarding denial',async()=>{
 const f=await provisioningIdentityFixture(),USER='urn:ietf:params:scim:schemas:core:2.0:User',GROUP='urn:ietf:params:scim:schemas:core:2.0:Group',PATCH='urn:ietf:params:scim:api:messages:2.0:PatchOp';try{
  assert.equal((await flow(f)).status,403);assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_auth_users').get().n),0);
  const created=await f.scim('Users',{schemas:[USER],externalId:'employee-1',userName:'metadata-name@example.test',emails:[{value:'metadata@example.test'}]},'POST',undefined,201);
  await f.scim('Groups',{schemas:[GROUP],externalId:'developers',displayName:'Developers',members:[{value:created.body.id}]},'POST',undefined,201);
  assert.equal(f.assignments.length,0);
  const signed=await flow(f);assert.equal(signed.status,303,await signed.clone().text());const cookie=signed.headers.get('set-cookie').split(';')[0];
  const context=await f.runtime.auth.resolve(new Request(origin,{headers:{cookie}}));assert.equal(context.user.email,'employee@example.test');
  const userId=context.user.id;assert.equal(f.assignments.at(-1).userId,userId);assert.equal(f.assignments.at(-1).role,'developer');assert.equal(f.assignments.at(-1).active,true);
  assert.equal(f.sql.prepare('SELECT user_id FROM clank_scim_users WHERE id=?').get(created.body.id).user_id,userId);
  const current=await f.scim('Users/'+created.body.id);
  const disabled=await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:false}]},'PATCH',current.response.headers.get('etag'),200,'signed_disable_resource_01');
  assert.equal((await f.runtime.auth.resolve(new Request(origin,{headers:{cookie}}))).user,null);
  assert.equal(f.assignments.at(-1).deactivated,true);assert.equal((await flow(f)).status,403);
  const inactive=f.sql.prepare('SELECT active,version FROM clank_sso_identities WHERE user_id=?').get(userId);assert.equal(inactive.active,0);
  await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:true}]},'PATCH',disabled.response.headers.get('etag'));
  assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE user_id=?').get(userId).active,0);
  assert.equal(f.assignments.at(-1).active,false);assert.equal(f.assignments.at(-1).deactivated,false);
  const reactivated=await flow(f);assert.equal(reactivated.status,303,await reactivated.clone().text());
  assert.equal(f.sql.prepare('SELECT version FROM clank_sso_identities WHERE user_id=?').get(userId).version,inactive.version+1);
  const fresh=await f.scim('Users/'+created.body.id);
  const again=await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:false}]},'PATCH',fresh.response.headers.get('etag'));
  assert.equal((await identityOffboard(f)).status,200);
  await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:true}]},'PATCH',again.response.headers.get('etag'));
  assert.equal((await flow(f)).status,403);assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_auth_users').get().n),1);
 }finally{await f.close()}
});

test('SCIM cannot select an existing email account or turn an independently unlinked binding into an automatic sign-in',async()=>{
 const f=await provisioningIdentityFixture(),USER='urn:ietf:params:scim:schemas:core:2.0:User',PATCH='urn:ietf:params:scim:api:messages:2.0:PatchOp';try{
  const local=await register(f.runtime,'employee@example.test');await f.fresh(local);
  const created=await f.scim('Users',{schemas:[USER],externalId:'employee-1',userName:'employee@example.test'},'POST',undefined,201);
  assert.equal((await flow(f)).status,409);assert.equal(f.sql.prepare('SELECT user_id FROM clank_scim_users WHERE id=?').get(created.body.id).user_id,null);
  const linking=await linkingFlow(f,local);assert.equal((await linking.finish()).status,303);
  const bound=f.sql.prepare('SELECT id,active,version FROM clank_sso_identities WHERE user_id=?').get(local.user.id);assert.equal(bound.active,1);
  await identityCall(f,'unlink',{identityId:bound.id,expectedVersion:bound.version,idempotencyKey:'independent_scim_unlink_01'},local);
  assert.equal((await flow(f)).status,403);
  const before=await f.scim('Users/'+created.body.id);
  const disabled=await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:false}]},'PATCH',before.response.headers.get('etag'));
  assert.equal(f.sql.prepare('SELECT disabled_version FROM clank_scim_subjects WHERE resource_id=?').get(created.body.id).disabled_version,null);
  await f.scim('Users/'+created.body.id,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:true}]},'PATCH',disabled.response.headers.get('etag'));
  assert.equal((await flow(f)).status,403);
  const returned=await loginLocal(f.runtime,'employee@example.test');await f.fresh(returned);
  const explicit=await linkingFlow(f,returned);assert.equal((await explicit.finish()).status,303);
  assert.equal(f.sql.prepare('SELECT user_id FROM clank_scim_users WHERE id=?').get(created.body.id).user_id,local.user.id);
 }finally{await f.close()}
});

test('SCIM policy reconciliation rolls back all membership writes and publication when a synchronous or asynchronous hook fails',async()=>{
 const f=await provisioningIdentityFixture();try{
  await f.scim('Users',{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],externalId:'employee-1',userName:'metadata@example.test'},'POST',undefined,201);
  assert.equal((await flow(f)).status,303);
  f.sql.exec("CREATE TABLE provisioning_hook_proof(role TEXT NOT NULL); INSERT INTO provisioning_hook_proof VALUES('before')");
  const replacement={...f.options,identityLinking:{policyRevision:3},providers:f.options.providers.map(provider=>provider.organizationId==='company'
   ?{...provider,provisioning:{...provider.provisioning,groupRoles:[{externalId:'developers',role:'viewer'}]}}:provider)};
  for(const asynchronous of [false,true]){
   assert.throws(()=>openOrganizationSso(f.runtime.database,f.runtime.auth,{...replacement,onProvisioning(){
    f.sql.prepare('UPDATE provisioning_hook_proof SET role=?').run('uncommitted');
    if(asynchronous)return Promise.reject(new Error('unsupported asynchronous hook'));
    throw new Error('transactional hook rejected');
   }}),asynchronous?/synchronous/:/transactional hook/);
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(f.sql.prepare('SELECT role FROM provisioning_hook_proof').get().role,'before');
   assert.equal(f.sql.prepare('SELECT revision FROM clank_sso_policy').get().revision,2);
   assert.equal((await f.scim('Users')).body.totalResults,1);
  }
  const current=openOrganizationSso(f.runtime.database,f.runtime.auth,{...replacement,onProvisioning(){f.sql.prepare('UPDATE provisioning_hook_proof SET role=?').run('accepted')}});
  assert.equal(f.sql.prepare('SELECT revision FROM clank_sso_policy').get().revision,3);
  assert.equal(f.sql.prepare('SELECT role FROM provisioning_hook_proof').get().role,'accepted');
  const request=new Request(origin+'/scim/v2/company/Users',{headers:{authorization:'Bearer '+f.options.providers[0].provisioning.token}});
  assert.equal((await f.sso.handle(request.clone())).status,401);assert.equal((await current.handle(request)).status,200);
 }finally{await f.close()}
});

test('verified linking retains the local profile, spans two organizations and replays accepted callbacks after SQLite reopen',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test'));const first=await linkingFlow(f,owner);assert.equal((await first.finish()).status,303);
  const tokenCalls=f.idp.tokenCalls;await f.reopen();assert.equal((await first.finish()).status,303);assert.equal(f.idp.tokenCalls,tokenCalls);
  assert.equal((await f.sso.handle(new Request(first.request.url.replace(/code=[^&]+/u,'code=wrong'),{headers:first.request.headers}))).status,409);
  const other=await linkingFlow(f,owner,'second');assert.equal((await other.finish()).status,303);
  const list=await identityCall(f,'identities',undefined,owner);assert.equal(list.identities.length,2);assert.ok(list.identities.every(row=>row.active && row.version===1));
  const local=f.sql.prepare('SELECT email,profile FROM clank_auth_users WHERE id=?').get(owner.user.id);assert.equal(local.email,'local@example.test');assert.deepEqual(JSON.parse(local.profile),{name:'Security'});
  const events=f.sql.prepare("SELECT count(*) n FROM clank_sso_events WHERE event='linked'").get().n;assert.equal(events,2);
  await identityCall(f,'link/company',{},owner,409);
 }finally{await f.close()}
});

test('linking denies anonymous, bearer, wrong-origin, CSRF, non-fresh and cross-session callbacks',async()=>{
 const f=await identityFixture();try{
  await identityCall(f,'identities',undefined,undefined,401);
  const owner=await register(f.runtime,'local@example.test'),other=await f.fresh(await register(f.runtime,'other@example.test'));
  await identityCall(f,'link/company',{},owner,403);await f.fresh(owner);
  const bearer=req('/__clank/sso/link/company',{},owner);bearer.headers.set('authorization','Bearer made-up-token');assert.equal((await f.sso.handle(bearer)).status,401);
  const csrf=req('/__clank/sso/link/company',{},owner);csrf.headers.delete('x-clank-csrf');assert.equal((await f.sso.handle(csrf)).status,403);
  const crossOrigin=req('/__clank/sso/link/company',{},owner);crossOrigin.headers.set('origin','https://other.test');assert.equal((await f.sso.handle(crossOrigin)).status,403);
  await identityCall(f,'link/company',{userId:other.user.id},owner,422);
  const flow=await linkingFlow(f,owner);const wrong=new Request(flow.request.url,{headers:{cookie:other.cookie+'; '+flow.request.headers.get('cookie').split('; ').at(-1)}});assert.equal((await f.sso.handle(wrong)).status,403);
  assert.equal((await flow.finish()).status,303);const inventory=await identityCall(f,'identities',undefined,other);assert.equal(inventory.identities.length,0);
 }finally{await f.close()}
});

test('signed provider auth_time is required and stale/future verification never creates a binding',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test'));
  for(const auth_time of [undefined,Math.floor(Date.now()/1000)-301,Math.floor(Date.now()/1000)+31,'fresh']){f.idp.setClaims({auth_time});const flow=await linkingFlow(f,owner);const response=await flow.finish();assert.equal(response.status,403,await response.text());}
  assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_sso_identities').get().n,0);
  f.idp.setClaims({});const pending=await linkingFlow(f,owner);f.sql.prepare('UPDATE clank_auth_sessions SET authenticated_at=? WHERE id=?').run(Date.now()-300001,owner.session.id);assert.equal((await pending.finish()).status,403);
 }finally{await f.close()}
});

test('provider subjects cannot transfer across accounts or organizations, including retained inactive ownership',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),other=await f.fresh(await register(f.runtime,'other@example.test'));
  const accepted=await linkingFlow(f,owner);assert.equal((await accepted.finish()).status,303);
  const collision=await linkingFlow(f,other);assert.equal((await collision.finish()).status,409);
  const row=(await identityCall(f,'identities',undefined,owner)).identities[0],input={identityId:row.id,expectedVersion:row.version,idempotencyKey:'identity_unlink_collision_1'};
  await identityCall(f,'unlink',input,other,404);await identityCall(f,'unlink',input,owner);const inactiveCollision=await linkingFlow(f,other);assert.equal((await inactiveCollision.finish()).status,409);
  // Reusing the issuer and subject under a second organization cannot create another human account.
  const providers=[f.options.providers[0],{...f.options.providers[1],issuer:f.idp.issuer}];await f.reopen({...f.options,providers,identityLinking:{policyRevision:2}});
  const cross=await linkingFlow(f,other,'second');assert.equal((await cross.finish()).status,409);
  const start=await f.sso.handle(req('/__clank/sso/start/second'));const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});f.idp.setClaims({email:'changed-email@example.test'});
  const ordinary=await f.sso.handle(new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}}));assert.equal(ordinary.status,409);
 }finally{await f.close()}
});

test('unlink is versioned, survives lost responses/restart, preserves ownership and permits a fresh explicit relink',async()=>{
 const f=await identityFixture();try{
  let owner=await f.fresh(await register(f.runtime,'local@example.test'));const first=await linkingFlow(f,owner);assert.equal((await first.finish()).status,303);
  const row=(await identityCall(f,'identities',undefined,owner)).identities[0],input={identityId:row.id,expectedVersion:row.version,idempotencyKey:'unlink_restart_exact_receipt'};
  await identityCall(f,'unlink',{...input,expectedVersion:999},owner,409);const receipt=await identityCall(f,'unlink',input,owner);assert.equal(receipt.signedOut,true);assert.equal(receipt.identity.version,2);
  assert.equal((await f.runtime.auth.resolve(req('/',undefined,owner))).user,null);assert.equal(f.sql.prepare('SELECT disabled FROM clank_auth_users WHERE id=?').get(owner.user.id).disabled,0);
  await f.reopen();owner=await f.fresh(await loginLocal(f.runtime));assert.deepEqual(await identityCall(f,'unlink',input,owner),receipt);
  await identityCall(f,'unlink',{...input,expectedVersion:2},owner,409);
  const relink=await linkingFlow(f,owner);assert.equal((await relink.finish()).status,303);const next=(await identityCall(f,'identities',undefined,owner)).identities[0];assert.equal(next.id,row.id);assert.equal(next.version,3);assert.equal(next.active,true);
  assert.deepEqual(await identityCall(f,'unlink',input,owner),receipt);assert.equal((await identityCall(f,'identities',undefined,owner)).identities[0].active,true);
  assert.equal((await first.finish()).status,401);assert.equal(f.sql.prepare("SELECT count(*) n FROM clank_sso_events WHERE event='unlinked'").get().n,1);
 }finally{await f.close()}
});

test('partial offboarding retains unrelated identities after linking is disabled and revokes live sessions',async()=>{
 const f=await identityFixture();try{
  let owner=await f.fresh(await register(f.runtime,'local@example.test'));
  for(const organization of ['company','second']){const flow=await linkingFlow(f,owner,organization);assert.equal((await flow.finish()).status,303)}
  await f.reopen({...f.options,identityLinking:undefined});assert.equal((await identityCall(f,'identities',undefined,owner)).enabled,false);await identityCall(f,'link/company',{},owner,403);
  assert.equal((await identityOffboard(f)).status,200);assert.equal((await f.runtime.auth.resolve(req('/',undefined,owner))).user,null);
  const rows=f.sql.prepare('SELECT organization,active FROM clank_sso_identities ORDER BY organization').all();assert.deepEqual(rows.map(row=>[row.organization,row.active]),[['company',0],['second',1]]);
  assert.equal(f.sql.prepare('SELECT disabled FROM clank_auth_users WHERE id=?').get(owner.user.id).disabled,0);
  owner=await loginLocal(f.runtime);const start=await f.sso.handle(req('/__clank/sso/start/second'));const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});const signedIn=await f.sso.handle(new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}}));assert.equal(signedIn.status,303);
  assert.equal((await identityOffboard(f)).status,200);assert.equal(f.sql.prepare("SELECT version FROM clank_sso_identities WHERE organization='company'").get().version,2);
 }finally{await f.close()}
});

test('held real JWKS response cannot publish a link after local revocation, offboarding or policy replacement',async()=>{
 for(const mode of ['session','offboard','policy']){const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),flow=await linkingFlow(f,owner),held=f.idp.holdKeys(),finishing=flow.finish();await held.ready;
  if(mode==='session') f.runtime.auth.revokeUserSessions(owner.user.id);
  if(mode==='offboard') assert.equal((await identityOffboard(f)).status,200);
  if(mode==='policy') openOrganizationSso(f.runtime.database,f.runtime.auth,{...f.options,identityLinking:{policyRevision:2}});
  held.release();assert.equal((await finishing).status,mode==='session'?401:403);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_sso_identities').get().n,0);
 }finally{await f.close()}}
});

test('changed provider configuration and account generation reject pending links; original policy cannot overwrite newer revisions',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),pending=await linkingFlow(f,owner),second=await linkingFlow(f,owner,'second');assert.equal((await second.finish()).status,303);assert.equal((await pending.finish()).status,409);
  const providerChange=await linkingFlow(f,owner);const updated={...f.options,providers:f.options.providers.map(provider=>({...provider,clientSecret:'new-server-secret'}))};await f.reopen(updated);assert.equal((await providerChange.finish()).status,409);
  assert.throws(()=>openOrganizationSso(f.runtime.database,f.runtime.auth,{...f.options,providers:f.options.providers.map(provider=>({...provider,clientId:'changed-client'}))}),/Increase/);
  openOrganizationSso(f.runtime.database,f.runtime.auth,{...f.options,identityLinking:{policyRevision:2}});assert.throws(()=>openOrganizationSso(f.runtime.database,f.runtime.auth,f.options),/Increase/);
 }finally{await f.close()}
});

test('identity and receipt capacities stay bounded without pruning issuer ownership or accepted retry keys',async()=>{
 const f=await identityFixture({identityLinking:{policyRevision:1,maxActiveIdentities:1,maxRetainedIdentities:1}});try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),first=await linkingFlow(f,owner);assert.equal((await first.finish()).status,303);await identityCall(f,'link/second',{},owner,409);
  const row=(await identityCall(f,'identities',undefined,owner)).identities[0];
  for(let index=0;index<100;index++)f.sql.prepare('INSERT INTO clank_sso_unlinks VALUES(?,?,?,?)').run(owner.user.id,'seeded-receipt-'+index,'[]','{}');
  await identityCall(f,'unlink',{identityId:row.id,expectedVersion:1,idempotencyKey:'bounded_unlink_101'},owner,409);assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE id=?').get(row.id).active,1);
  f.sql.prepare('DELETE FROM clank_sso_unlinks WHERE user_id=?').run(owner.user.id);
  await identityCall(f,'unlink',{identityId:row.id,expectedVersion:1,idempotencyKey:'bounded_unlink_accepted'},owner);
  const nextOwner=await f.fresh(await loginLocal(f.runtime));f.idp.setClaims({sub:'another-subject'});const different=await linkingFlow(f,nextOwner);assert.equal((await different.finish()).status,409);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_sso_identities').get().n,1);
 }finally{await f.close()}
});

test('last usable identity unlink fails closed and a failing transactional hook retains all identity state',async()=>{
 const f=await identityFixture({onOffboard(){throw new Error('hook unavailable')}});try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),flow=await linkingFlow(f,owner);assert.equal((await flow.finish()).status,303);const row=(await identityCall(f,'identities',undefined,owner)).identities[0],input={identityId:row.id,expectedVersion:1,idempotencyKey:'transactional_unlink_1'};
  await identityCall(f,'unlink',input,owner,400);assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE id=?').get(row.id).active,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_sso_unlinks').get().n,0);assert.ok((await f.runtime.auth.resolve(req('/',undefined,owner))).user);
  const password=f.sql.prepare('SELECT password_hash FROM clank_auth_users WHERE id=?').get(owner.user.id).password_hash;f.sql.prepare('UPDATE clank_auth_users SET password_hash=? WHERE id=?').run('federated:unusable',owner.user.id);
  await identityCall(f,'unlink',input,owner,409);f.sql.prepare('UPDATE clank_auth_users SET password_hash=? WHERE id=?').run(password,owner.user.id);
 }finally{await f.close()}
});

test('legacy identity schema upgrades atomically, keeps revocations/audit, and failed configuration rolls back table replacement',async()=>{
 const f=await fixture(),idp=await mockIdp();try{
  const owner=await register(f.runtime),sql=f.runtime.database[key];
  sql.exec('CREATE TABLE clank_sso_identities (organization TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE REFERENCES clank_auth_users(id) ON DELETE CASCADE,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(organization,issuer,subject))');
  sql.prepare('INSERT INTO clank_sso_identities VALUES(?,?,?,?,1)').run('company',idp.issuer,'legacy-subject',owner.user.id);
  sql.exec('CREATE TABLE clank_sso_policy(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,configuration TEXT NOT NULL)');sql.prepare('INSERT INTO clank_sso_policy VALUES(1,2,1,?)').run('different-configuration');
  const options={applicationOrigin:origin,allowInsecureLoopback:true,providers:[{organizationId:'company',issuer:idp.issuer,clientId:'clank-client',offboardingToken:'legacy-offboarding-secret-32chars-long'}],identityLinking:{policyRevision:1}};
  assert.throws(()=>openOrganizationSso(f.runtime.database,f.runtime.auth,options),/Increase/);assert.ok(!sql.prepare('PRAGMA table_info(clank_sso_identities)').all().some(column=>column.name==='id'));assert.equal(sql.prepare('SELECT subject FROM clank_sso_identities').get().subject,'legacy-subject');
  sql.exec('DELETE FROM clank_sso_policy');sql.exec('CREATE TABLE clank_sso_revocations(organization TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(organization,issuer,subject))');sql.prepare('INSERT INTO clank_sso_revocations VALUES(?,?,?,?)').run('company',idp.issuer,'earlier-offboard',42);
  const sso=openOrganizationSso(f.runtime.database,f.runtime.auth,options),row=sql.prepare('SELECT * FROM clank_sso_identities').get();assert.match(row.id,/^sso_[a-f0-9]{32}$/u);assert.equal(row.user_id,owner.user.id);assert.equal(row.version,1);assert.equal(row.active,1);assert.equal(sql.prepare('SELECT at FROM clank_sso_revocations').get().at,42);
  openOrganizationSso(f.runtime.database,f.runtime.auth,options);assert.equal(sql.prepare('SELECT id FROM clank_sso_identities').get().id,row.id);assert.equal((await sso.handle(req('/__clank/sso/identities',undefined,owner))).status,200);assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await idp.close();await f.close()}
});

test('actual federated session creation cannot outlive an offboarding during its asynchronous publication boundary',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test'));
  for(const organization of ['company','second']){const flow=await linkingFlow(f,owner,organization);assert.equal((await flow.finish()).status,303)}
  let reached,release;const ready=new Promise(resolve=>reached=resolve),held=new Promise(resolve=>release=resolve);
  const auth=new Proxy(f.runtime.auth,{get(target,property){if(property==='issueFederatedSession')return async(...args)=>{reached();await held;return target.issueFederatedSession(...args)};const value=target[property];return typeof value==='function'?value.bind(target):value}});
  const sso=openOrganizationSso(f.runtime.database,auth,f.options);
  const start=await sso.handle(req('/__clank/sso/start/second'));const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});const finishing=sso.handle(new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}}));await ready;
  assert.equal((await identityOffboard(f,'company')).status,200);release();const response=await finishing;assert.equal(response.status,403);assert.equal(response.headers.get('set-cookie'),null);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_auth_sessions WHERE user_id=?').get(owner.user.id).n,0);assert.equal(f.sql.prepare("SELECT active FROM clank_sso_identities WHERE organization='second'").get().active,1);
 }finally{await f.close()}
});

test('pending link capacity is bounded, exact receipt replay checks current configuration, and invalid contracts fail closed',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test'));
  for(let index=0;index<10;index++)await identityCall(f,'link/company',{},owner);
  await identityCall(f,'link/company',{},owner,503);f.sql.prepare('UPDATE clank_sso_states SET expires=1').run();
  const accepted=await linkingFlow(f,owner);assert.equal((await accepted.finish()).status,303);
  await f.reopen({...f.options,providers:f.options.providers.map(provider=>({...provider,clientSecret:'changed-secret'}))});assert.equal((await accepted.finish()).status,409);
  for(const input of [{},null,{identityId:'invalid',expectedVersion:1,idempotencyKey:'valid_key_123456789'}])await identityCall(f,'unlink',input,owner,422);
  assert.throws(()=>openOrganizationSso(f.runtime.database,f.runtime.auth,{...f.options,identityLinking:{policyRevision:3,maxActiveIdentities:11}}),/policy/);
 }finally{await f.close()}
});

test('identity client uses current CSRF/browser ownership and clears session after real unlink',async()=>{
 const f=await identityFixture();try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),other=await f.fresh(await register(f.runtime,'other@example.test'));let heldResponse,release,hold=false;
  const transport=async(url,init)=>{const request=new Request(new URL(url,origin),{...init,headers:{...init?.headers,cookie:owner.cookie,origin}});const response=new URL(request.url).pathname.startsWith('/__clank/sso')?await f.sso.handle(request):await f.runtime.handle(request);if(hold){heldResponse=response;await new Promise(resolve=>release=resolve);}return response};
  const client=createAuthClient({initial:{user:owner.user,session:owner.session,csrfToken:owner.csrf},fetch:transport});const identities=createOrganizationIdentityClient({auth:client,fetch:transport});assert.equal((await identities.list()).identities.length,0);const started=await identities.start('company');assert.equal(new URL(started.authorizationUrl).searchParams.get('max_age'),'0');
  const flow=await linkingFlow(f,owner);assert.equal((await flow.finish()).status,303);const row=(await identities.list()).identities[0];assert.equal(row.organizationId,'company');
  const html=await renderToString(AccountSecurity({auth:client,identities}));assert.match(html,/Organization identities/);assert.match(html,/Refresh organization identities/);assert.match(html,/Sign back in/);
  hold=true;const pending=identities.list();while(!heldResponse)await new Promise(resolve=>setImmediate(resolve));client.user.value=other.user;client.session.value=other.session;release();await assert.rejects(pending,/Account changed/);
  hold=false;client.user.value=owner.user;client.session.value=owner.session;
  const result=await identities.unlink({identityId:row.id,expectedVersion:row.version,idempotencyKey:'client_exact_unlink_key'});assert.equal(result.signedOut,true);assert.equal(client.user.value,null);
  await assert.rejects(identities.start('company'),/Sign in/);assert.throws(()=>createOrganizationIdentityClient({auth:client,prefix:'/invalid/'}),/prefix/);
 }finally{await f.close()}
});

async function verifyPlatformPasskey(f,owner){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('identity-link-passkey-'+owner.user.id).toString('base64url');
 f.sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('identity-key-'+owner.user.id,credentialId,owner.user.id,'Identity key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
 const start=await pcall(f,'/__clank/auth/reauthenticate/passkey/start',{},owner),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update('security.test').digest(),Buffer.from([5,0,0,0,1])]);
 const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
 await pcall(f,'/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential},owner);
}

async function nativeProvisioningFixture() {
 const f=await platformFixture(),idp=await mockIdp(),token='native-platform-scim-separate-provisioning-token';
 const owner=await register(f.platform,'scim-owner@example.test'),member=await register(f.platform,'local@example.test');
 const project=(await pcall(f,'/api/projects',{name:'Provisioned workspace'},owner,201)).project;
 await addMember(f,project,owner,member);
 const settings={applicationOrigin:origin,allowInsecureLoopback:true,identityLinking:{policyRevision:1},providers:[{
  organizationId:project.organizationId,issuer:idp.issuer,clientId:'clank-client',offboardingToken:'native-platform-scim-independent-offboarding-token',
  provisioning:{token,expiresAt:Date.now()+600000,groupRoles:[{externalId:'developers',role:'developer'}]}}]};
 await f.reopen({organizationSso:settings});
 const scim=async(path,body,method=body===undefined?'GET':'POST',etag,expected=200,retryKey)=>{
  const response=await f.platform.handle(new Request(origin+'/scim/v2/'+project.organizationId+'/'+path,{method,headers:{authorization:'Bearer '+token,
   ...(body===undefined?{}:{'content-type':'application/scim+json'}),...(etag?{'if-match':etag}:{}),...(retryKey?{'x-clank-idempotency-key':retryKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const result=response.status===204?null:await response.json();assert.equal(response.status,expected,JSON.stringify(result));return{response,body:result};
 };
 const created=await scim('Users',{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],externalId:'employee-1',userName:'metadata@example.test'},'POST',undefined,201);
 const group=await scim('Groups',{schemas:['urn:ietf:params:scim:schemas:core:2.0:Group'],externalId:'developers',displayName:'Developers',members:[{value:created.body.id}]},'POST',undefined,201);
 await verifyPlatformPasskey(f,member);const linked={sso:{handle:request=>f.platform.handle(request)},options:settings};
 const proof=await linkingFlow(linked,member,project.organizationId);assert.equal((await proof.finish()).status,303);
 const signed=async()=>{
  const start=await f.platform.handle(req('/__clank/sso/start/'+project.organizationId));assert.equal(start.status,303);
  const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});
  const response=await f.platform.handle(new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}}));
  assert.equal(response.status,303,await response.clone().text());return response;
 };
 const patch=async(path,operations)=>{const current=await scim(path);return scim(path,{schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:operations},'PATCH',current.response.headers.get('etag'));};
 return{...f,get platform(){return f.platform},idp,owner,member,project,settings,created,group,scim,patch,signed,
  async close(){await idp.close();await f.close()}};
}

test('native SCIM respects manual role changes and removals until a fresh versioned adoption, with historical retry receipts',async()=>{
 const f=await nativeProvisioningFixture();try{
  const path=`/api/organizations/${f.project.organizationId}/provisioning/${f.member.user.id}`;
  const role=()=>f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.project.organizationId,f.member.user.id)?.role??null;
  assert.equal(role(),'developer');
  await pcall(f,`/api/organizations/${f.project.organizationId}/members/${f.member.user.id}`,{role:'viewer'},f.owner,200,'PATCH');
  await f.patch('Groups/'+f.group.body.id,[{op:'remove',path:'members'}]);
  await f.patch('Groups/'+f.group.body.id,[{op:'add',value:{members:[{value:f.created.body.id}]}}]);
  await f.signed();assert.equal(role(),'viewer');
  await pcall(f,`/api/organizations/${f.project.organizationId}/members/${f.member.user.id}`,undefined,f.owner,200,'DELETE');
  await f.patch('Groups/'+f.group.body.id,[{op:'replace',path:'displayName',value:'Managed developers'}]);
  await f.signed();assert.equal(role(),null);
  const preview=(await pcall(f,path,undefined,f.owner)).assignment;
  assert.equal(preview.manualOverride,true);assert.equal(preview.eligible,true);assert.equal(preview.desiredRole,'developer');
  const input={resourceId:preview.resourceId,expectedVersion:preview.version,expectedCurrentRole:null,idempotencyKey:'reviewed_native_adoption_01',confirmed:true};
  const freshRequired=await pcall(f,path,input,f.owner,403);assert.equal(freshRequired.error.code,'FRESH_AUTH_REQUIRED');
  await verifyPlatformPasskey(f,f.owner);
  await pcall(f,path,{...input,expectedVersion:preview.version-1},f.owner,409);
  const accepted=await pcall(f,path,input,f.owner);assert.equal(role(),'developer');assert.equal(accepted.assignment.manualOverride,false);
  const audits=()=>Number(f.sql.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='organization.provisioning.adopt'").get().n);
  assert.equal(audits(),1);
  await pcall(f,`/api/organizations/${f.project.organizationId}/members/${f.member.user.id}`,undefined,f.owner,200,'DELETE');
  const replay=await pcall(f,path,input,f.owner);assert.deepEqual(replay,accepted);assert.equal(role(),null);assert.equal(audits(),1);
  await pcall(f,path,{...input,expectedCurrentRole:'viewer'},f.owner,409);
  await f.reopen({organizationSso:f.settings});assert.deepEqual(await pcall(f,path,input,f.owner),accepted);assert.equal(role(),null);
 }finally{await f.close()}
});

test('native SCIM deactivation revokes exact workspace and broad credentials while preserving unrelated membership and scopes',async()=>{
 const f=await nativeProvisioningFixture();try{
  const otherOwner=await register(f.platform,'scim-other-owner@example.test');
  const other=(await pcall(f,'/api/projects',{name:'Unrelated workspace'},otherOwner,201)).project;
  await addMember(f,other,otherOwner,f.member);
  for(const project of [f.project,other])await pcall(f,`/api/projects/${project.id}/members/${f.member.user.id}`,{permissions:['read','tokens']},project===other?otherOwner:f.owner,200,'PUT');
  const scoped=await pcall(f,`/api/projects/${f.project.id}/tokens`,{name:'Managed scope',permissions:['read']},f.member,201);
  const unrelated=await pcall(f,`/api/projects/${other.id}/tokens`,{name:'Other scope',permissions:['read']},f.member,201);
  const start=await pcall(f,'/api/device/start',{clientName:'Managed broad CLI'},undefined,201);
  await pcall(f,'/api/device/approve',{code:start.userCode},f.member);const broad=await pcall(f,'/api/device/token',{deviceCode:start.deviceCode});
  await f.patch('Users/'+f.created.body.id,[{op:'replace',path:'active',value:false}]);
  const bearer=(token,project)=>f.platform.handle(new Request(origin+'/api/projects/'+project.id,{headers:{authorization:'Bearer '+token}}));
  assert.equal((await bearer(scoped.token.accessToken,f.project)).status,401);
  assert.equal((await bearer(unrelated.token.accessToken,other)).status,200);
  assert.equal((await bearer(broad.accessToken,other)).status,401);
  await pcall(f,'/api/projects',undefined,f.member,401);
  assert.equal(f.sql.prepare('SELECT disabled FROM clank_auth_users WHERE id=?').get(f.member.user.id).disabled,0);
  assert.equal(f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(other.organizationId,f.member.user.id).role,'viewer');
  await f.patch('Users/'+f.created.body.id,[{op:'replace',path:'active',value:true}]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.project.organizationId,f.member.user.id).n,0);
  await f.signed();assert.equal(f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.project.organizationId,f.member.user.id).role,'developer');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_project_members WHERE project_id=? AND user_id=?').get(f.project.id,f.member.user.id).n,0);
 }finally{await f.close()}
});

test('native SCIM retains deleted local ownership without recreating an account or blocking resource maintenance',async()=>{
 const f=await nativeProvisioningFixture();try{
  const oldId=f.member.user.id;
  f.sql.prepare('DELETE FROM clank_auth_users WHERE id=?').run(oldId);
  assert.equal(f.sql.prepare('SELECT user_id FROM clank_scim_subjects WHERE subject=?').get('employee-1').user_id,oldId);
  assert.equal(f.sql.prepare('SELECT 1 FROM clank_sso_identities WHERE user_id=?').get(oldId),undefined);
  await f.patch('Users/'+f.created.body.id,[{op:'replace',path:'displayName',value:'Retained metadata'}]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_memberships WHERE user_id=?').get(oldId).n,0);
  const replacement=await register(f.platform,'replacement-local@example.test');await verifyPlatformPasskey(f,replacement);
  const proof=await linkingFlow({sso:{handle:request=>f.platform.handle(request)}},replacement,f.project.organizationId);
  const denied=await proof.finish();assert.equal(denied.status,409,await denied.clone().text());
  assert.equal(f.sql.prepare('SELECT user_id FROM clank_scim_subjects WHERE subject=?').get('employee-1').user_id,oldId);
 }finally{await f.close()}
});

test('SCIM accepted disable survives controller SIGKILL and closes another process live stream and browser, CLI and MCP access',async()=>{
 const f=await nativeProvisioningFixture(),children=new Set();let reader;
 async function stop(child,signal='SIGTERM'){
  if(child.exitCode!==null||child.signalCode!==null){children.delete(child);return}
  const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned provisioning child did not exit')),10000);
   child.once('exit',()=>{clearTimeout(timer);resolve()})});child.kill(signal);await exited;children.delete(child);
 }
 async function start(){
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','tests/fixtures/organization-provisioning-process.mjs'],{
   cwd:new URL('../',import.meta.url),env:{...process.env,CLANK_SCIM_PROCESS_FIXTURE:JSON.stringify({directory:f.dir,options:f.settings,organizationId:f.project.organizationId})},stdio:['ignore','ignore','pipe','ipc']});
  children.add(child);let errors='';child.stderr.on('data',data=>{errors=(errors+data).slice(-4096)});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Provisioning child startup deadline: '+errors)),10000);
   child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Provisioning child startup failed: '+errors))});
   child.on('message',message=>{if(message.ready){clearTimeout(timer);resolve(message)}})});
  return{child,url:'http://127.0.0.1:'+ready.port};
 }
 const proxy={'x-forwarded-proto':'https','x-forwarded-host':'security.test'};
 const http=(worker,path,init={})=>fetch(worker.url+path,{...init,headers:{...proxy,...init.headers}});
 async function deadline(pending,message){let timer;try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),5000)})])}finally{clearTimeout(timer)}}
 try{
  const startDevice=await pcall(f,'/api/device/start',{clientName:'Cross-process CLI'},undefined,201);
  await pcall(f,'/api/device/approve',{code:startDevice.userCode},f.member);const cli=await pcall(f,'/api/device/token',{deviceCode:startDevice.deviceCode});
  let first=await start();const second=await start();
  const browser={cookie:f.member.cookie};
  const initialBrowser=await http(second,'/api/projects/'+f.project.id,{headers:browser});
  assert.equal(initialBrowser.status,200,await initialBrowser.clone().text());
  assert.equal((await http(second,'/api/projects/'+f.project.id,{headers:{authorization:'Bearer '+cli.accessToken}})).status,200);
  const registered=await http(second,'/__clank/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   client_name:'Cross-process SCIM agent',redirect_uris:[second.url+'/fixture/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
  assert.equal(registered.status,201,await registered.clone().text());const client=await registered.json();
  const verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const authorization={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',state:'scim-process-client-state',
   code_challenge:challenge,code_challenge_method:'S256',scope:'agent:read',resource:origin+'/__clank/mcp'};
  const consent=await http(second,'/__clank/oauth/authorize?'+new URLSearchParams(authorization),{headers:browser});
  assert.equal(consent.status,200,await consent.clone().text());const html=await consent.text(),consentToken=/name="consent_token" value="([^"]+)"/u.exec(html)?.[1];assert.ok(consentToken);
  const approved=await http(second,'/__clank/oauth/authorize',{method:'POST',redirect:'manual',headers:{...browser,origin,'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({...authorization,csrf_token:f.member.csrf,consent_token:consentToken,decision:'approve'})});
  assert.equal(approved.status,303,await approved.clone().text());const callback=new URL(approved.headers.get('location'));assert.equal(callback.origin,second.url);assert.equal(callback.searchParams.get('state'),authorization.state);
  const exchanged=await http(second,'/__clank/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
   grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code'),redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:authorization.resource})});
  assert.equal(exchanged.status,200,await exchanged.clone().text());const delegated=await exchanged.json();assert.ok(delegated.access_token);
  const mcp={method:'POST',headers:{authorization:'Bearer '+delegated.access_token,'content-type':'application/json',accept:'application/json, text/event-stream',
   'mcp-protocol-version':'2026-07-28','mcp-method':'tools/list'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{
    'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'scim-fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})};
  const listed=await http(second,'/__clank/mcp',mcp);assert.equal(listed.status,200,await listed.clone().text());
  assert.ok((await listed.json()).result.tools.some(tool=>tool.name.includes('protected')));
  const live=await http(second,'/__clank/live/protected?args=%7B%7D',{headers:browser});assert.equal(live.status,200);
  reader=live.body.getReader();assert.equal((await reader.read()).done,false);
  const current=await f.scim('Users/'+f.created.body.id),retryKey='process_accepted_disable_01';
  const input={schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]};
  const accepted=new Promise(resolve=>first.child.on('message',message=>{if(message.accepted)resolve()}));
  const request={method:'PATCH',headers:{authorization:'Bearer '+f.settings.providers[0].provisioning.token,'content-type':'application/scim+json',
   'if-match':current.response.headers.get('etag'),'x-clank-idempotency-key':retryKey},body:JSON.stringify(input)};
  const lost=http(first,'/scim/v2/'+f.project.organizationId+'/Users/'+f.created.body.id,{...request,headers:{...request.headers,'x-fixture-lose-response':'accepted'}})
   .then(()=>{throw new Error('Lost accepted response unexpectedly returned')},()=>undefined);
  await deadline(accepted,'SCIM commit was not reached');
  await stop(first.child,'SIGKILL');await lost;
  const closed=await deadline(reader.read(),'Cross-process live stream stayed authorized');
  assert.equal(closed.done,true);reader=undefined;
  for(const headers of [browser,{authorization:'Bearer '+cli.accessToken}])assert.equal((await http(second,'/api/projects/'+f.project.id,{headers})).status,401);
  assert.equal((await http(second,'/__clank/mcp',mcp)).status,401);
  first=await start();const replay=await http(first,'/scim/v2/'+f.project.organizationId+'/Users/'+f.created.body.id,request);
  assert.equal(replay.status,200,await replay.clone().text());assert.equal((await replay.json()).active,false);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts WHERE key=?').get(retryKey).n),1);
  const afterDisable=await f.scim('Users/'+f.created.body.id);await f.scim('Users/'+f.created.body.id,{...input,Operations:[{op:'replace',path:'active',value:true}]},'PATCH',afterDisable.response.headers.get('etag'));
  const old=await http(first,'/scim/v2/'+f.project.organizationId+'/Users/'+f.created.body.id,request);assert.equal((await old.json()).active,false);
  assert.equal((await f.scim('Users/'+f.created.body.id)).body.active,true);
  assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE user_id=?').get(f.member.user.id).active,0);
  await stop(first.child);await stop(second.child);
 }finally{await reader?.cancel();for(const child of children)await stop(child);await f.close()}
});

test('platform partial offboarding revokes only affected project scopes, all broad credentials, and preserves unrelated organization access',async()=>{
 const f=await platformFixture(),first=await mockIdp(),second=await mockIdp();try{
  const a=await register(f.platform,'owner-a@example.test'),b=await register(f.platform,'owner-b@example.test'),member=await register(f.platform,'local@example.test');
  const projectA=(await pcall(f,'/api/projects',{name:'Linked workspace A'},a,201)).project,projectB=(await pcall(f,'/api/projects',{name:'Linked workspace B'},b,201)).project;
  const providers=[{organizationId:projectA.organizationId,issuer:first.issuer,clientId:'clank-client',offboardingToken:'first-organization-offboarding-secret-32chars'},{organizationId:projectB.organizationId,issuer:second.issuer,clientId:'clank-client',offboardingToken:'second-organization-offboarding-secret-32chars'}];
  const settings={applicationOrigin:origin,allowInsecureLoopback:true,providers,identityLinking:{policyRevision:1}};await f.reopen({organizationSso:settings});await verifyPlatformPasskey(f,member);
  const linked={sso:{handle:request=>f.platform.handle(request)},options:settings};
  for(const project of [projectA,projectB]){const flow=await linkingFlow(linked,member,project.organizationId);assert.equal((await flow.finish()).status,303);assert.equal(f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(project.organizationId,member.user.id).role,'viewer')}
  await pcall(f,`/api/organizations/${projectA.organizationId}/members/${member.user.id}`,{role:'admin'},a,200,'PATCH');await pcall(f,`/api/organizations/${projectB.organizationId}/members/${member.user.id}`,{role:'admin'},b,200,'PATCH');
  await pcall(f,`/api/projects/${projectA.id}/members/${member.user.id}`,{permissions:['read','tokens']},a,200,'PUT');await pcall(f,`/api/projects/${projectB.id}/members/${member.user.id}`,{permissions:['read','tokens']},b,200,'PUT');
  const scopedA=await pcall(f,`/api/projects/${projectA.id}/tokens`,{name:'Scoped A',permissions:['read']},member,201),scopedB=await pcall(f,`/api/projects/${projectB.id}/tokens`,{name:'Scoped B',permissions:['read']},member,201);
  const broadStart=await pcall(f,'/api/device/start',{clientName:'Broad CLI'},undefined,201);await pcall(f,'/api/device/approve',{code:broadStart.userCode},member);const broad=await pcall(f,'/api/device/token',{deviceCode:broadStart.deviceCode});
  const pending=await pcall(f,'/api/device/start',{clientName:'Pending broad CLI'},undefined,201);await pcall(f,'/api/device/approve',{code:pending.userCode},member);
  await f.reopen({organizationSso:{...settings,identityLinking:undefined}});assert.equal((await identityOffboard(linked,projectA.organizationId)).status,200);
  assert.equal(f.sql.prepare('SELECT disabled FROM clank_auth_users WHERE id=?').get(member.user.id).disabled,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(projectA.organizationId,member.user.id).n,0);assert.equal(f.sql.prepare('SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(projectB.organizationId,member.user.id).role,'admin');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_project_members WHERE project_id=? AND user_id=?').get(projectA.id,member.user.id).n,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_project_members WHERE project_id=? AND user_id=?').get(projectB.id,member.user.id).n,1);
  const bearer=(token,project)=>f.platform.handle(new Request(origin+'/api/projects/'+project.id,{headers:{authorization:'Bearer '+token}}));
  assert.equal((await bearer(scopedA.token.accessToken,projectA)).status,401);assert.equal((await bearer(scopedB.token.accessToken,projectB)).status,200);assert.equal((await bearer(broad.accessToken,projectB)).status,401);await pcall(f,'/api/device/token',{deviceCode:pending.deviceCode},undefined,400);await pcall(f,'/api/projects',undefined,member,401);
  const local=await loginLocal(f.platform);await pcall(f,`/api/projects/${projectA.id}`,undefined,local,404);await pcall(f,`/api/projects/${projectB.id}`,undefined,local);
 }finally{await first.close();await second.close();await f.close()}
});

test('platform voluntary unlink keeps the last owner while explicit provider offboarding still revokes organization access',async()=>{
 const f=await platformFixture(),idp=await mockIdp();try{
  const owner=await register(f.platform,'local@example.test'),project=(await pcall(f,'/api/projects',{name:'Last owner linking'},owner,201)).project;
  const settings={applicationOrigin:origin,allowInsecureLoopback:true,providers:[{organizationId:project.organizationId,issuer:idp.issuer,clientId:'clank-client',offboardingToken:'last-owner-offboarding-secret-32chars'}],identityLinking:{policyRevision:1}};await f.reopen({organizationSso:settings});await verifyPlatformPasskey(f,owner);
  const linked={sso:{handle:request=>f.platform.handle(request)},options:settings},flow=await linkingFlow(linked,owner,project.organizationId);assert.equal((await flow.finish()).status,303);
  const row=(await pcall(f,'/__clank/sso/identities',undefined,owner)).identities[0];const failure=await pcall(f,'/__clank/sso/unlink',{identityId:row.id,expectedVersion:row.version,idempotencyKey:'last_owner_unlink_attempt'},owner,409);assert.equal(failure.error.code,'LAST_OWNER');assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE id=?').get(row.id).active,1);await pcall(f,'/api/projects',undefined,owner);
  const disabledOwner=await register(f.platform,'disabled-owner@example.test');await addMember(f,project,owner,disabledOwner);await pcall(f,`/api/organizations/${project.organizationId}/members/${disabledOwner.user.id}`,{role:'owner'},owner,200,'PATCH');f.sql.prepare('UPDATE clank_auth_users SET disabled=1 WHERE id=?').run(disabledOwner.user.id);await pcall(f,'/api/projects',undefined,disabledOwner,401);
  const disabledFailure=await pcall(f,'/__clank/sso/unlink',{identityId:row.id,expectedVersion:row.version,idempotencyKey:'disabled_owner_unlink_attempt'},owner,409);assert.equal(disabledFailure.error.code,'LAST_OWNER');assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE id=?').get(row.id).active,1);
  assert.equal((await identityOffboard(linked,project.organizationId)).status,200);assert.equal(f.sql.prepare('SELECT disabled FROM clank_auth_users WHERE id=?').get(owner.user.id).disabled,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(project.organizationId,owner.user.id).n,0);
 }finally{await idp.close();await f.close()}
});

test('lost accepted unlink transport and body failures immediately reload real authority and clear client account state',async()=>{
 for(const failureMode of ['json','html','network','oversized']){const f=await identityFixture();let pulls=0,cancelled=false;try{
  const owner=await f.fresh(await register(f.runtime,'local@example.test')),flow=await linkingFlow(f,owner);assert.equal((await flow.finish()).status,303);
  const transport=async(url,init)=>{const request=new Request(new URL(url,origin),{...init,headers:{...init?.headers,cookie:owner.cookie,origin}}),isSso=new URL(request.url).pathname.startsWith('/__clank/sso');const response=isSso?await f.sso.handle(request):await f.runtime.handle(request);if(request.url.endsWith('/unlink')&&response.ok){if(failureMode==='network')throw new TypeError('Network response lost');return new Response(failureMode==='html'?'<html>upstream failure</html>':failureMode==='oversized'?new ReadableStream({pull(controller){pulls++;if(pulls>2)throw Error('Read past response budget');controller.enqueue(new Uint8Array(pulls===1?262144:1))},cancel(){cancelled=true}},{highWaterMark:0}):JSON.stringify({ok:false,error:{code:'RESPONSE_LOST',message:'Accepted response lost'}}),{status:500})}return response};
  const client=createAuthClient({initial:{user:owner.user,session:owner.session,csrfToken:owner.csrf},fetch:transport}),identities=createOrganizationIdentityClient({auth:client,fetch:transport}),row=(await identities.list()).identities[0],input={identityId:row.id,expectedVersion:row.version,idempotencyKey:'lost_accepted_unlink_retry'};
  await assert.rejects(identities.unlink(input),failureMode==='html'?/Invalid identity response/:failureMode==='network'?/Network response lost/:failureMode==='oversized'?/too large/:/Accepted response lost/);assert.equal(client.user.value,null);assert.equal(client.session.value,null);assert.equal(f.sql.prepare('SELECT active FROM clank_sso_identities WHERE id=?').get(row.id).active,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_sso_unlinks').get().n,1);if(failureMode==='oversized'){assert.equal(pulls,2);assert.equal(cancelled,true)}
  const fresh=await f.fresh(await loginLocal(f.runtime));const receipt=await identityCall(f,'unlink',input,fresh);assert.equal(receipt.identity.version,2);assert.equal(f.sql.prepare("SELECT count(*) n FROM clank_sso_events WHERE event='unlinked'").get().n,1);
 }finally{await f.close()}}
});
