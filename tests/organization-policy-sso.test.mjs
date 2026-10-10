import test from 'node:test';
import assert from 'node:assert/strict';
import {openOrganizationSso} from '../dist/organization-sso.js';
import {fixture,company,other,defaults} from './fixtures/organization-policy-fixture.mjs';
import {mockPolicyIdp} from './fixtures/organization-policy-idp.mjs';

async function linked(f,sso,organization) {
  const start=await sso.handle(f.request('/__clank/sso/link/'+organization,f.owner,{}));assert.equal(start.status,200,await start.clone().text());
  const {authorizationUrl}=await start.json(),authorized=await fetch(authorizationUrl,{redirect:'manual'});
  const response=await sso.handle(new Request(authorized.headers.get('location'),{headers:{cookie:f.owner.cookie+'; '+start.headers.get('set-cookie').split(';')[0]}}));assert.equal(response.status,303,await response.clone().text());
}
async function login(sso,organization) {
  const start=await sso.handle(new Request('http://127.0.0.1:42421/__clank/sso/start/'+organization));assert.equal(start.status,303,await start.clone().text());
  const authorized=await fetch(start.headers.get('location'),{redirect:'manual'});
  return sso.handle(new Request(authorized.headers.get('location'),{headers:{cookie:start.headers.get('set-cookie').split(';')[0]}}));
}
test('real signed OIDC code and PKCE prove authentication to the exact organization, rather than mere linked identity enrollment',async t=>{
  const f=await fixture(t),left=await mockPolicyIdp(),right=await mockPolicyIdp();t.after(()=>left.close());t.after(()=>right.close());
  for(const idp of [left,right])idp.setClaims({email:f.owner.user.email});await f.step();
  const sso=openOrganizationSso(f.db,f.auth,{applicationOrigin:'http://127.0.0.1:42421',allowInsecureLoopback:true,identityLinking:{policyRevision:1},providers:[{organizationId:company,issuer:left.issuer,clientId:'clank-client',offboardingToken:'policy-left-offboarding-secret-32bytes'},{organizationId:other,issuer:right.issuer,clientId:'clank-client',offboardingToken:'policy-right-offboarding-secret-32bytes'}]});
  await linked(f,sso,company);await linked(f,sso,other);f.now=Date.now();const caller=await f.caller(f.owner),requirements={...defaults,ssoOnly:true};
  for(const organization of [company,other])f.controller.change(organization,caller,{requirements,expectedVersion:0,operationId:'policy_real_sso_save_01'});
  const localResponse=await f.auth.handle(f.request('/auth/login',null,{email:f.owner.user.email,password:'correct horse battery staple'}),'/auth');assert.equal(localResponse.status,200);const local=await f.auth.resolve(f.request('/',{cookie:localResponse.headers.get('set-cookie').split(';')[0]}));f.now=Date.now();
  assert.throws(()=>f.controller.authorizeAuth(company,local),error=>error.code==='ORGANIZATION_POLICY_REQUIRED');
  const response=await login(sso,company);assert.equal(response.status,303,await response.clone().text());const session=await f.auth.resolve(f.request('/',{cookie:response.headers.get('set-cookie').split(';')[0]}));f.now=Date.now();
  assert.equal(session.session.authenticationMethod,'sso');assert.doesNotThrow(()=>f.controller.authorizeAuth(company,session));assert.throws(()=>f.controller.authorizeAuth(other,session),error=>error.code==='ORGANIZATION_POLICY_REQUIRED');
  f.controller.captureDelegation(company,'mcp_real_sso_proof_01',session);
  // An independently unlinked current identity invalidates the exact session
  // and its retained delegation even if the authentication session still exists.
  f.sql.prepare('UPDATE clank_sso_identities SET version=version+1 WHERE organization=?').run(company);
  assert.throws(()=>f.controller.authorizeAuth(company,session),error=>error.code==='ORGANIZATION_POLICY_REQUIRED');assert.throws(()=>f.controller.authorizeDelegation(company,'mcp_real_sso_proof_01',session.user.id),error=>error.code==='ORGANIZATION_POLICY_REQUIRED');
});
test('a real OIDC login whose session-proof publication fails removes only its unpublished session',async t=>{
  const f=await fixture(t),idp=await mockPolicyIdp();t.after(()=>idp.close());idp.setClaims({email:f.owner.user.email});await f.step();
  const sso=openOrganizationSso(f.db,f.auth,{applicationOrigin:'http://127.0.0.1:42421',allowInsecureLoopback:true,identityLinking:{policyRevision:1},providers:[{organizationId:company,issuer:idp.issuer,clientId:'clank-client',offboardingToken:'policy-failed-proof-offboarding-secret-32bytes'}]});
  await linked(f,sso,company);const before=f.sql.prepare('SELECT id FROM clank_auth_sessions WHERE user_id=? ORDER BY id').all(f.owner.user.id);
  f.sql.exec("CREATE TRIGGER policy_test_refuse_proof BEFORE INSERT ON clank_sso_session_bindings BEGIN SELECT RAISE(ABORT,'Owned fixture refuses new proof'); END;");
  const response=await login(sso,company);assert.equal(response.status,400);assert.equal(response.headers.get('set-cookie'),null);
  assert.deepEqual(f.sql.prepare('SELECT id FROM clank_auth_sessions WHERE user_id=? ORDER BY id').all(f.owner.user.id),before);assert.ok(await f.caller(f.owner));
});
