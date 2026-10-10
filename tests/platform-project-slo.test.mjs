import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
const configuration={name:'Checkout success',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
const path=f=>`/api/projects/${f.development.id}/slo-policies`;
const input={configuration,operationId:'slo_native_create_01'};
test('native SLO policies retain exact actor receipts and current versions across restart',async t=>{
 const f=await fixture(t),policy=(await f.call(path(f),input,201)).policy;
 assert.equal(policy.version,1);let assessment=(await f.call(path(f)+'/'+policy.id)).assessment;
 assert.equal(assessment.evaluation.status,'insufficient-data');assert.equal(assessment.evaluation.burning,null);assert.equal(assessment.alert,null);
 const change={configuration:{...configuration,enabled:false,name:'Paused objective'},expectedVersion:1,operationId:'slo_native_pause_01'};
 assert.equal((await f.call(path(f)+'/'+policy.id+'/change',change)).policy.version,2);
 await f.call(path(f)+'/'+policy.id+'/change',{...change,operationId:'slo_stale_version_01'},409);
 await f.restart();assert.equal((await f.call(path(f),input,201)).policy.version,1);
 assert.equal((await f.call(path(f)+'/'+policy.id+'/change',change)).policy.version,2);
 assessment=(await f.call(path(f)+'/'+policy.id)).assessment;assert.equal(assessment.policy.enabled,false);assert.equal(assessment.policy.version,2);
 await f.call(path(f)+'?unknown=1',undefined,422,'GET');await f.call(path(f),{...input,configuration:{...configuration,objective:{kind:'latency',maximumMs:501}},operationId:'slo_bad_latency_01'},422);
});
test('SLO viewers can inspect coverage while writes require a current explicit project grant',async t=>{
 const f=await fixture(t),reader=await f.account('slo-reader@example.test'),outside=await f.account('slo-outside@example.test');
 const control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());const now=Date.now();
 control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
 await f.call(path(f),undefined,200,'GET',reader);await f.call(path(f),input,403,'POST',reader);
 await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','slo']},200,'PUT');
 const policy=(await f.call(path(f),{...input,operationId:'slo_reader_create_01'},201,'POST',reader)).policy;
 await f.call(path(f)+'/'+policy.id,undefined,404,'GET',outside);
 await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read']},200,'PUT');await f.call(path(f),{...input,operationId:'slo_reader_create_01'},403,'POST',reader);
 control.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId,reader.user.id);await f.call(path(f),undefined,404,'GET',reader);
});
test('native SLO body intake revalidates exact tokens, membership, session, permission and storage protocol',async t=>{
 const f=await fixture(t),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
 for(const boundary of ['permission','membership','session','rotated-token','revoked-token','protocol']){
  let headers,reader,token;
  if(boundary.endsWith('token')){
   token=(await f.call(`/api/projects/${f.development.id}/tokens`,{name:'SLO test credential',permissions:['read','slo'],expiresIn:300},201)).token;
   headers={authorization:'Bearer '+token.accessToken,'content-type':'application/json'};
  }else{
   reader=await f.account('slo-held-'+boundary+'@example.test');const now=Date.now();
   control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
   await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','slo']},200,'PUT');
   headers={origin:f.options.publicUrl,cookie:reader.cookie,'x-clank-csrf':reader.csrf,'content-type':'application/json'};
  }
  let controller,enter;const entered=new Promise(resolve=>enter=resolve),body=new ReadableStream({start(value){controller=value;},pull(){enter();}},{highWaterMark:0});
  const pending=f.handle(new Request(f.options.publicUrl+path(f),{method:'POST',headers,body,duplex:'half'}));await entered;
  if(boundary==='permission')await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read']},200,'PUT');
  else if(boundary==='membership')control.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId,reader.user.id);
  else if(boundary==='session')control.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(reader.user.id);
  else if(boundary==='rotated-token')control.prepare('UPDATE clank_platform_tokens SET token_hash=? WHERE id=?').run(createHash('sha256').update('clnk_'+'s'.repeat(43)).digest('hex'),token.id);
  else if(boundary==='revoked-token')control.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id=?').run(Date.now(),token.id);
  else control.prepare('UPDATE clank_platform_slo_state SET protocol=99 WHERE singleton=1').run();
  controller.enqueue(new TextEncoder().encode(JSON.stringify({...input,operationId:'slo_held_'+boundary})));controller.close();
  assert.equal((await pending).status,boundary==='permission'?403:boundary==='membership'?404:boundary==='protocol'?409:401);
  assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies').get().n,0);assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_slo_receipts').get().n,0);
  control.prepare('UPDATE clank_platform_slo_state SET protocol=1 WHERE singleton=1').run();
 }
});
