import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
const callback='http://127.0.0.1:42421/__clank/sso/callback';
export async function mockPolicyIdp(){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'ES256',use:'sig'};
 let issuer='',overrides={},wrongSignature=false,discoveryOverride={};const codes=new Map();let tokenCalls=0,heldKeys;
 const server=createServer(async(request,response)=>{const url=new URL(request.url,issuer);response.setHeader('content-type','application/json');
  if(url.pathname==='/.well-known/openid-configuration')return response.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['ES256'],...discoveryOverride}));
  if(url.pathname==='/keys'){if(heldKeys){const held=heldKeys;heldKeys=undefined;held.reached();await held.wait;}return response.end(JSON.stringify({keys:[jwk]}));}
  if(url.pathname==='/authorize'){
   if(url.searchParams.get('redirect_uri')!==callback){response.statusCode=400;return response.end('{}')}
   const code=crypto.randomUUID();codes.set(code,Object.fromEntries(url.searchParams));response.writeHead(302,{location:callback+'?'+new URLSearchParams({code,state:url.searchParams.get('state')})});return response.end()
  }
  if(url.pathname==='/token'){tokenCalls++;let body='';for await(const chunk of request)body+=chunk;const input=new URLSearchParams(body),flow=codes.get(input.get('code'));codes.delete(input.get('code'));
   if(!flow||input.get('redirect_uri')!==flow.redirect_uri||createHash('sha256').update(input.get('code_verifier')).digest('base64url')!==flow.code_challenge){response.statusCode=400;return response.end('{}')}
   const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'clank-client',sub:'employee-1',nonce:flow.nonce,iat:now,auth_time:now,exp:now+300,email:'employee@example.test',email_verified:true,name:'Employee',...overrides};
   const message=[{alg:'ES256',kid:jwk.kid},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
   const signature=wrongSignature?Buffer.alloc(64):sign('sha256',Buffer.from(message),{key:privateKey,dsaEncoding:'ieee-p1363'});return response.end(JSON.stringify({id_token:message+'.'+signature.toString('base64url'),token_type:'Bearer',access_token:'ignored'}));
  }response.statusCode=404;response.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));issuer='http://127.0.0.1:'+server.address().port;
 return {issuer,get tokenCalls(){return tokenCalls},holdKeys(){let reached,release;const ready=new Promise(resolve=>reached=resolve),wait=new Promise(resolve=>release=resolve);heldKeys={reached,wait};return {ready,release}},setClaims(value){overrides=value},badSignature(value){wrongSignature=value},setDiscovery(value){discoveryOverride=value},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}
