import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineAuth,defineBackend,defineDatabase,openBackend,createAuthClient,renderToString} from '../dist/index.js';
import {openOrganizationSso} from '../dist/organization-sso.js';
import {AccountSecurity,PasswordRecoveryForm,EmailVerificationForm} from '../dist/account-security.js';
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
 let issuer='',overrides={},wrongSignature=false,discoveryOverride={};const codes=new Map();
 const server=createServer(async(request,response)=>{const url=new URL(request.url,issuer);response.setHeader('content-type','application/json');
  if(url.pathname==='/.well-known/openid-configuration')return response.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['ES256'],...discoveryOverride}));
  if(url.pathname==='/keys')return response.end(JSON.stringify({keys:[jwk]}));
  if(url.pathname==='/authorize'){const code=crypto.randomUUID();codes.set(code,Object.fromEntries(url.searchParams));response.writeHead(302,{location:url.searchParams.get('redirect_uri')+'?'+new URLSearchParams({code,state:url.searchParams.get('state')})});return response.end()}
  if(url.pathname==='/token'){let body='';for await(const chunk of request)body+=chunk;const input=new URLSearchParams(body),flow=codes.get(input.get('code'));codes.delete(input.get('code'));
   if(!flow||input.get('redirect_uri')!==flow.redirect_uri||createHash('sha256').update(input.get('code_verifier')).digest('base64url')!==flow.code_challenge){response.statusCode=400;return response.end('{}')}
   const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'clank-client',sub:'employee-1',nonce:flow.nonce,iat:now,exp:now+300,email:'employee@example.test',email_verified:true,name:'Employee',...overrides};
   const message=[{alg:'ES256',kid:jwk.kid},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
   const signature=wrongSignature?Buffer.alloc(64):sign('sha256',Buffer.from(message),{key:privateKey,dsaEncoding:'ieee-p1363'});return response.end(JSON.stringify({id_token:message+'.'+signature.toString('base64url'),token_type:'Bearer',access_token:'ignored'}));
  }response.statusCode=404;response.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));issuer='http://127.0.0.1:'+server.address().port;
 return {issuer,setClaims(value){overrides=value},badSignature(value){wrongSignature=value},setDiscovery(value){discoveryOverride=value},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
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
