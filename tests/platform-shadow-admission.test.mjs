import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {shadowPlatformFixture,origin,artifact,request} from './fixtures/platform-shadow-native.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function call(f,path,body,auth=f.owner,extra={}){const response=await f.platform.nativeRequest(request(path,{method:'POST',body,cookie:auth.cookie,csrf:auth.csrf,...extra}));return{status:response.status,body:await response.json()}}
async function stage(f){const bytes=await artifact(f.root,'public-shadow-candidate');const response=await f.platform.nativeRequest(new Request(origin+`/api/projects/${f.project.id}/releases/stage`,{method:'POST',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':'shadow-public-candidate-01'},body:bytes}));const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));return body.release}
const snapshot=f=>({rows:f.control.prepare('SELECT count(*) n FROM clank_platform_shadow_reports').get().n,journal:f.raw(),launches:f.events.filter(e=>e.kind==='launch').length,controls:f.controlCounts});

test('actual HTTP shadow mutations require fresh original human session before native or provider effects',{timeout:45000},async t=>{
  const f=await shadowPlatformFixture(t),base=`/api/projects/${f.project.id}/shadow`,before=snapshot(f);
  for(const [path,body]of[[base+'/preview',{releaseId:'candidate',expectedEpoch:0,policy:{}}],[base+'/start',{reviewToken:'x',idempotencyKey:'native-shadow-key-01'}],[base+'/shadow_missing/stop',{operationId:'operation',controllerEpoch:1}]]){
    const unfresh=await call(f,path,body);assert.equal(unfresh.status,403,JSON.stringify(unfresh));assert.equal(unfresh.body.error.code,'FRESH_AUTH_REQUIRED');
    const bearer=await call(f,path,body,f.owner,{token:f.owner.accessToken});assert.equal(bearer.status,403,JSON.stringify(bearer));assert.equal(bearer.body.error.code,'HUMAN_AUTH_REQUIRED');
  }
  assert.deepEqual(snapshot(f),before);await f.fresh();
  const candidate=await stage(f),beforeReview=snapshot(f);
  const missing=await call(f,base+'/preview',{releaseId:candidate.id,expectedEpoch:0,policy:{}});assert.equal(missing.status,409,JSON.stringify(missing));assert.equal(missing.body.error.code,'PROMOTION_HOST_CERTIFICATION_REQUIRED');
  assert.deepEqual(snapshot(f),beforeReview,'A genuine certificate is mandatory before provider binding or candidate preparation.');
  const freshSession=await f.login();assert.notEqual(freshSession.session.id,f.owner.session.id);await f.fresh(freshSession);
  const second=await call(f,base+'/preview',{releaseId:candidate.id,expectedEpoch:0,policy:{}},freshSession);assert.equal(second.status,409);assert.equal(second.body.error.code,'PROMOTION_HOST_CERTIFICATION_REQUIRED');
  f.control.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(f.owner.session.id);
  const revoked=await call(f,base+'/preview',{releaseId:candidate.id,expectedEpoch:0,policy:{}});assert.equal(revoked.status,401,JSON.stringify(revoked));assert.deepEqual(snapshot(f),beforeReview);
});

test('actual HTTP admission preserves closed 8KiB inputs, strict keys, CSRF and origin refusal',{timeout:45000},async t=>{
  const f=await shadowPlatformFixture(t),base=`/api/projects/${f.project.id}/shadow`;await f.fresh();const before=snapshot(f);
  for(const [path,body]of[[base+'/preview',{releaseId:'candidate',expectedEpoch:0,policy:{},extra:true}],[base+'/preview?extra=1',{releaseId:'candidate',expectedEpoch:0,policy:{}}],[base+'/start',{reviewToken:'x',idempotencyKey:'non-ascii-key-é-12345'}],[base+'/shadow_missing/stop',{operationId:'operation',controllerEpoch:0}],[base+'/start',{reviewToken:'x'.repeat(8200),idempotencyKey:'native-shadow-key-01'}]]){
    const result=await call(f,path,body);assert.ok([413,422].includes(result.status),JSON.stringify({path,result}));
  }
  const input={releaseId:'candidate',expectedEpoch:0,policy:{}};
  const csrf=await call(f,base+'/preview',input,f.owner,{csrf:'wrong'});assert.equal(csrf.status,403);
  const bad=request(base+'/preview',{method:'POST',body:input,cookie:f.owner.cookie,csrf:f.owner.csrf});bad.headers.set('origin','https://attacker.example');
  const originResponse=await f.platform.nativeRequest(bad);assert.equal(originResponse.status,403);assert.deepEqual(snapshot(f),before);
});

// The certified fixture uses the same closed-signup actor path. This local test
// validates real onboarding independently of host certification availability.
test('actual HTTP invited deployer onboarding preserves closed public signup',{timeout:45000},async t=>{
  const f=await shadowPlatformFixture(t),before=snapshot(f);
  const denied=await f.platform.nativeRequest(request('/__clank/auth/register',{method:'POST',body:{email:'not-invited@example.test',password:'correct horse battery staple'}}));
  assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'SIGNUP_DISABLED');
  const other=await f.invite('invited-shadow-deployer@example.test');assert.notEqual(other.user.id,f.owner.user.id);assert.notEqual(other.session.id,f.owner.session.id);await f.fresh(other);
  const response=await f.platform.nativeRequest(request(`/api/projects/${f.project.id}`,{cookie:other.cookie}));assert.equal(response.status,200);
  const membership=f.control.prepare('SELECT permissions FROM clank_platform_project_members WHERE project_id=? AND user_id=?').get(f.project.id,other.user.id);assert.deepEqual(JSON.parse(membership.permissions),['read','deploy']);
  const fresh=await call(f,`/api/projects/${f.project.id}/shadow/preview`,{releaseId:'missing_candidate',expectedEpoch:0,policy:{}},other);assert.equal(fresh.status,409,JSON.stringify(fresh));assert.equal(fresh.body.error.code,'SHADOW_CANDIDATE_INELIGIBLE');
  assert.deepEqual(snapshot(f),before);
});
