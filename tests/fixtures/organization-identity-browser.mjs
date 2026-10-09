import {createServer} from 'node:http';
import {readFile,readdir,mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {defineAuth,createAuthClient} from '../../dist/auth.js';
import {defineBackend,defineDatabase,openBackend} from '../../dist/backend.js';
import {openOrganizationSso} from '../../dist/organization-sso.js';
const root=process.env.CLANK_IDENTITY_FIXTURE_STATE??await mkdtemp(join(tmpdir(),'clank-identity-browser-'));
await mkdir(root,{recursive:true,mode:0o700});
const port=Number(process.env.CLANK_IDENTITY_FIXTURE_PORT??43184),origin=`http://127.0.0.1:${port}`,repository=fileURLToPath(new URL('../../',import.meta.url));
const assets=new Map();for(const name of await readdir(join(repository,'dist')))if(/^[a-z0-9-]+\.js$/u.test(name))assets.set('/dist/'+name,await readFile(join(repository,'dist',name)));
assets.set('/fixture/entry.mjs',await readFile(new URL('./organization-identity-browser-entry.mjs',import.meta.url)));
const mail=new Map(),audit=[];
const runtime=await openBackend(defineBackend({schema:defineDatabase({}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024},mfa:{send:delivery=>mail.set(delivery.userId,delivery)}})}).functions(()=>({})),{path:join(root,'identities.sqlite'),agent:false});
const sql=runtime.database[Symbol.for('clank.sqlite.internal')];
for(const email of ['identity-alice@example.invalid','identity-bob@example.invalid'])if(!sql.prepare('SELECT 1 FROM clank_auth_users WHERE email=?').get(email)){
 const response=await runtime.handle(new Request(origin+'/__clank/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password:'disposable-identity-password',profile:{name:email.startsWith('identity-alice')?'Alice':'Bob'}})}));if(response.status!==201)throw Error('Fixture registration failed');
}
const idps=[];
for(const [index,organization] of ['company-a','company-b'].entries()){
 const issuer=`http://127.0.0.1:${port+index+1}`,codes=new Map(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...publicKey.export({format:'jwk'}),kid:organization,alg:'ES256',use:'sig'};
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,issuer);res.setHeader('cache-control','no-store');
  if(url.pathname==='/authorize'&&(url.searchParams.get('redirect_uri')!==origin+'/__clank/sso/callback'||url.searchParams.get('client_id')!=='fixture-client')){res.writeHead(400);return res.end('Invalid fixture callback')}
  if(url.pathname==='/.well-known/openid-configuration'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['ES256']}))}
  if(url.pathname==='/keys'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({keys:[jwk]}))}
  if(url.pathname==='/authorize'&&req.method==='GET'){
   if(url.searchParams.get('prompt')!=='login'||url.searchParams.get('max_age')!=='0'){res.writeHead(400);return res.end('Fresh login required')}
   res.setHeader('content-type','text/html');return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disposable organization provider</title><style>body{font:16px system-ui;padding:20px;max-width:650px}label{display:block;margin:16px 0}input,button{font:inherit;max-width:100%;box-sizing:border-box;padding:8px}</style><h1>Verify '+organization+' identity</h1><p>Disposable local provider. Password: provider-fixture-password</p><form method="POST"><label>Provider account<input name="account" value="employee" required></label><label>Provider password<input name="password" type="password" required autocomplete="off"></label><button type="submit">Verify organization identity</button></form></html>');
  }
  if(url.pathname==='/authorize'&&req.method==='POST'){
   const body=await boundedBody(req),input=new URLSearchParams(body);
   if(input.get('account')!=='employee'||input.get('password')!=='provider-fixture-password'||url.searchParams.get('prompt')!=='login'||url.searchParams.get('max_age')!=='0'){res.writeHead(403);return res.end('Provider verification failed')}
   const code=crypto.randomUUID();codes.set(code,{...Object.fromEntries(url.searchParams),authTime:Math.floor(Date.now()/1000)});audit.push({organization,event:'provider-password-verified'});res.writeHead(303,{location:origin+'/__clank/sso/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code})});return res.end();
  }
  if(url.pathname==='/token'){
   const input=new URLSearchParams(await boundedBody(req)),flow=codes.get(input.get('code'));codes.delete(input.get('code'));
   if(!flow||input.get('client_id')!=='fixture-client'||input.get('redirect_uri')!==flow.redirect_uri||createHash('sha256').update(input.get('code_verifier')).digest('base64url')!==flow.code_challenge){res.writeHead(400);return res.end('{}')}
   const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'fixture-client',sub:'employee',email:`employee-${organization}@example.invalid`,email_verified:true,nonce:flow.nonce,iat:now,auth_time:flow.authTime,exp:now+300};
   const message=[{alg:'ES256',kid:organization},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');const signature=sign('sha256',Buffer.from(message),{key:privateKey,dsaEncoding:'ieee-p1363'});res.setHeader('content-type','application/json');return res.end(JSON.stringify({id_token:message+'.'+signature.toString('base64url')}));
  }
  res.writeHead(404);res.end('Not found');
 }catch{res.writeHead(500);res.end('Disposable provider failed')}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port+index+1,'127.0.0.1',resolve)});idps.push({server,provider:{organizationId:organization,issuer,clientId:'fixture-client',offboardingToken:'disposable-fixture-offboarding-secret-'+organization}});
}
const sso=openOrganizationSso(runtime.database,runtime.auth,{applicationOrigin:origin,allowInsecureLoopback:true,providers:idps.map(idp=>idp.provider),identityLinking:{policyRevision:1}});
let loseUnlink=false,revokeInventory=false;
const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verified identity linking fixture</title><style>body{font:16px system-ui;max-width:900px;margin:24px auto;padding:0 16px}label{display:block;margin:12px 0}input,select,button{font:inherit;max-width:100%;box-sizing:border-box;padding:8px}button{margin:6px 8px 6px 0}li,p{overflow-wrap:anywhere}h1{font-size:26px}section{min-width:0}</style><h1>Disposable identity linking verification</h1><p>Local accounts: identity-alice@example.invalid or identity-bob@example.invalid. Password: disposable-identity-password.</p><form id="login"><label>Fixture email<input id="email" type="email" autocomplete="off" required></label><label>Fixture password<input id="password" type="password" autocomplete="off" required></label><button>Sign in to fixture</button></form><p id="fixture-status" role="status"></p><button id="mailbox">Read disposable MFA mailbox</button><p id="mail-code"></p><button id="lose-unlink">Lose next accepted unlink response</button><button id="revoke-inventory">Revoke during next inventory response</button><button id="signout">Sign out fixture</button><main id="app"></main><script type="module" src="/fixture/entry.mjs"></script></html>';
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,origin);res.setHeader('cache-control','no-store');
 if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(html)}
 if(assets.has(url.pathname)){res.setHeader('content-type','text/javascript');return res.end(assets.get(url.pathname))}
 const body=['GET','HEAD'].includes(req.method)?undefined:await boundedBody(req),request=new Request(url,{method:req.method,headers:req.headers,...(body===undefined?{}:{body})});
 if(url.pathname.startsWith('/fixture/')){
  const context=await runtime.auth.resolve(request);if(!context.user||!context.session||req.headers.origin!==origin||req.method!=='POST'){res.writeHead(403);return res.end('{}')};await runtime.auth.verifyCsrf(request,context);
  res.setHeader('content-type','application/json');
  if(url.pathname==='/fixture/mailbox')return res.end(JSON.stringify({code:mail.get(context.user.id)?.code??'No pending code'}));
  if(url.pathname==='/fixture/lose-unlink-response'){loseUnlink=true;return res.end('{}')}
  if(url.pathname==='/fixture/revoke-inventory'){revokeInventory=true;return res.end('{}')}
  res.writeHead(404);return res.end('{}');
 }
 const response=sso.handles(request)?await sso.handle(request):await runtime.handle(request),bytes=Buffer.from(await response.arrayBuffer());
 if(loseUnlink&&url.pathname==='/__clank/sso/unlink'&&response.ok){loseUnlink=false;audit.push({event:'accepted-unlink-response-lost'});res.writeHead(500,{'content-type':'application/json'});return res.end(JSON.stringify({ok:false,error:{code:'FIXTURE_RESPONSE_LOST',message:'Accepted response lost; sign in again and inspect the retained identity.'}}))}
 if(revokeInventory&&url.pathname==='/__clank/sso/identities'&&response.ok){revokeInventory=false;const context=await runtime.auth.resolve(request);if(context.user)runtime.auth.revokeUserSessions(context.user.id);audit.push({event:'inventory-auth-revoked-before-response'});}
 res.statusCode=response.status;for(const [name,value] of response.headers)res.setHeader(name,value);res.end(bytes);
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'FIXTURE_FAILED',message:'Disposable fixture request failed'}}))}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});console.log(JSON.stringify({origin,root,pid:process.pid,providers:idps.map(idp=>idp.provider.organizationId)}));
async function boundedBody(req){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw Error('Fixture body too large')}return body}
let closing=false;async function close(){if(closing)return;closing=true;server.closeAllConnections();server.close();for(const idp of idps){idp.server.closeAllConnections();idp.server.close()}await writeFile(join(root,'browser-evidence.json'),JSON.stringify({audit,identities:sql.prepare('SELECT id,organization,user_id,active,version FROM clank_sso_identities').all(),events:sql.prepare('SELECT organization,event FROM clank_sso_events').all()},null,2));runtime.close();console.log('Fixture stopped; evidence retained at '+root)}
process.once('SIGTERM',()=>{void close()});process.once('SIGINT',()=>{void close()});
