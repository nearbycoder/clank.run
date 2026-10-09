import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineAuth, defineBackend, defineDatabase, openBackend } from '../dist/index.js';
import { openOrganizationSso } from '../dist/organization-sso.js';
import { serve } from '../dist/node.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User', GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp', internal = Symbol.for('clank.sqlite.internal');
const token = 'separate-provisioning-credential-company-01', otherToken = 'separate-provisioning-credential-other-02';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clank-scim-http-'));
  const runtime = await openBackend(defineBackend({ schema: defineDatabase({}), auth: defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }) }).functions(() => ({})), { path: join(root, 'app.sqlite') });
  let sso;
  const server = await serve(request => sso.handle(request), { hostname: '127.0.0.1', port: 0 });
  t.after(async () => { await server.close(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.port}`;
  const options = { applicationOrigin: origin, allowInsecureLoopback: true, identityLinking: { policyRevision: 1 },
    providers: [{ organizationId: 'company', issuer: 'https://company-idp.test', clientId: 'company-client', offboardingToken: 'independent-offboarding-credential-company',
      provisioning: { token, expiresAt: Date.now() + 60000, groupRoles: [{ externalId: 'developers', role: 'developer' }] } },
    { organizationId: 'other', issuer: 'https://other-idp.test', clientId: 'other-client', offboardingToken: 'independent-offboarding-credential-other',
      provisioning: { token: otherToken, expiresAt: Date.now() + 60000 } }], onProvisioning() { throw new Error('Unbound resources must not invoke membership hooks.'); } };
  sso = openOrganizationSso(runtime.database, runtime.auth, options);
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}, expected = 200) => {
    const response = await fetch(origin + '/scim/v2/' + path, { method, headers: { authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    assert.match(response.headers.get('content-type'), /^application\/scim\+json/);
    return { response, body: result };
  };
  return { runtime, sql: runtime.database[internal], request, options, origin, get sso(){return sso}, replace(value) { sso = openOrganizationSso(runtime.database, runtime.auth, value); } };
}
const user = (externalId, userName = externalId + '@example.test') => ({ schemas: [USER], externalId, userName, active: true });

test('real HTTP SCIM discovery and User inventory stay scoped and cannot select a local account by email', async t => {
  const f = await fixture(t);
  const config = (await f.request('company/ServiceProviderConfig')).body;
  assert.equal(config.patch.supported, true); assert.equal(config.bulk.supported, false); assert.equal(config.filter.maxResults, 100);
  const types = (await f.request('company/ResourceTypes')).body; assert.deepEqual(types.Resources.map(type => type.id), ['User', 'Group']);
  const schemas = (await f.request('company/Schemas')).body; assert.equal(schemas.Resources.length, 2);
  assert.equal((await f.request('company/Schemas/' + encodeURIComponent(USER))).body.id, USER);
  const created = await f.request('company/Users', { ...user('subject-A', 'Employee@example.test'), displayName: 'Employee',
    name: { givenName: 'Example' }, emails: [{ value: 'existing@example.test', primary: true }], id: 'client-read-only-id', groups: [{ value: 'ignored' }] }, 'POST', {}, 201);
  assert.match(created.body.id, /^scim_[a-f0-9]{32}$/); assert.equal(created.body.userName, 'Employee@example.test'); assert.deepEqual(created.body.groups, []);
  assert.equal(created.body.meta.version, created.response.headers.get('etag'));
  assert.equal(created.body.meta.location, created.response.headers.get('location'));
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_auth_users').get().n), 0);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_auth_sessions').get().n), 0);
  await f.request('company/Users', user('subject-B', 'employee@EXAMPLE.test'), 'POST', {}, 409);
  const filtered = (await f.request('company/Users?filter=' + encodeURIComponent('userName eq "employee@EXAMPLE.test"'))).body;
  assert.equal(filtered.totalResults, 1); assert.equal(filtered.Resources[0].id, created.body.id);
  assert.equal((await f.request('company/Users?count=0')).body.itemsPerPage, 0);
  await f.request('company/Users?filter=' + encodeURIComponent('externalId eq "subject-A" or active eq true'), undefined, 'GET', {}, 400);
  await f.request('company/Groups?filter=' + encodeURIComponent('userName eq "Employee"'), undefined, 'GET', {}, 400);
  await f.request('other/Users', undefined, 'GET', {}, 401);
  const other = await f.request('other/Users', user('subject-A'), 'POST', { authorization: 'Bearer ' + otherToken }, 201);
  await f.request('company/Users/' + other.body.id, undefined, 'GET', {}, 404);
  assert.equal((await f.request('company/Users')).body.totalResults, 1);
});

test('real HTTP SCIM groups use atomic PATCH, current resource references and competing conditional versions', async t => {
  const f = await fixture(t);
  const first = (await f.request('company/Users', user('subject-1'), 'POST', {}, 201)).body;
  const second = (await f.request('company/Users', user('subject-2'), 'POST', {}, 201)).body;
  const foreign = (await f.request('other/Users', user('subject-3'), 'POST', { authorization: 'Bearer ' + otherToken }, 201)).body;
  await f.request('company/Groups', { schemas: [GROUP], externalId: 'developers', displayName: 'Developers', members: [{ value: foreign.id }] }, 'POST', {}, 400);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_groups').get().n), 0);
  const created = await f.request('company/Groups', { schemas: [GROUP], externalId: 'developers', displayName: 'Developers', members: [{ value: first.id }] }, 'POST', {}, 201);
  const path = 'company/Groups/' + created.body.id, etag = created.response.headers.get('etag');
  const firstVersion=await f.request('company/Users/'+first.id);
  assert.equal((await f.request('company/Users/' + first.id)).body.groups[0].value, created.body.id);
  await f.request(path, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: second.id }] },
    { op: 'remove', path: `members[value eq "${foreign.id}"]` }] }, 'PATCH', { 'if-match': etag, 'x-clank-idempotency-key': 'rejected_atomic_patch_01' }, 400);
  const unchanged = await f.request(path); assert.equal(unchanged.response.headers.get('etag'), etag); assert.deepEqual(unchanged.body.members.map(member => member.value), [first.id]);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts').get().n), 0);
  const patched = await f.request(path, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: second.id }] },
    { op: 'replace', path: 'displayName', value: 'Current developers' }] }, 'PATCH', { 'if-match': etag });
  assert.deepEqual(patched.body.members.map(member => member.value).sort(), [first.id, second.id].sort());
  const changedUser=await f.request('company/Users/'+first.id);assert.notEqual(changedUser.response.headers.get('etag'),firstVersion.response.headers.get('etag'));
  await f.request('company/Users/'+first.id,changedUser.body,'PUT',{'if-match':firstVersion.response.headers.get('etag')},412);
  await f.request(path, { schemas: [GROUP], externalId: 'developers', displayName: 'Stale', members: [] }, 'PUT', { 'if-match': etag }, 412);
  const nextEtag = patched.response.headers.get('etag');
  const competing = await Promise.all(['one', 'two'].map(label => fetch(f.origin + '/scim/v2/' + path, { method: 'PATCH',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/scim+json', 'if-match': nextEtag, 'x-clank-idempotency-key': 'competing_group_patch_' + label },
    body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: 'replace', path: 'displayName', value: label }] }) })));
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 412]);
  for (const response of competing) await response.arrayBuffer();
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts').get().n), 1);
  const beforeDelete = await f.request('company/Users/' + first.id);
  await f.request('company/Users/' + first.id, undefined, 'DELETE', { 'if-match': beforeDelete.response.headers.get('etag'), 'x-clank-idempotency-key': 'delete_user_resource_01' }, 204);
  assert.deepEqual((await f.request(path)).body.members.map(member => member.value), [second.id]);
  assert.equal((await f.request('company/Users')).body.totalResults, 1);
  await f.request('company/Users/' + first.id, undefined, 'GET', {}, 404);
});

test('retained SCIM receipts replay accepted versions after restart without changing later resources', async t => {
  const f = await fixture(t), created = await f.request('company/Users', user('receipt-subject'), 'POST', {}, 201);
  const path = 'company/Users/' + created.body.id, headers = { 'if-match': created.response.headers.get('etag'), 'x-clank-idempotency-key': 'accepted_user_patch_01' };
  const body = { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] };
  const accepted = await f.request(path, body, 'PATCH', headers);
  f.replace(f.options);
  const replay = await f.request(path, body, 'PATCH', headers); assert.deepEqual(replay.body, accepted.body);
  const later = await f.request(path, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] }, 'PATCH', { 'if-match': accepted.response.headers.get('etag') });
  const oldReceipt = await f.request(path, body, 'PATCH', headers); assert.deepEqual(oldReceipt.body, accepted.body);
  const current = await f.request(path); assert.equal(current.body.active, true); assert.equal(current.response.headers.get('etag'), later.response.headers.get('etag'));
  await f.request(path, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] }, 'PATCH', headers, 409);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts').get().n), 1);
});

test('SCIM attribute PATCH and full response replacement preserve arrays, opaque ownership and conditional bounds',async t=>{
 const f=await fixture(t),first=await f.request('company/Users',{...user('array-owner','x'.repeat(255)),emails:[{value:'first@example.test'}]},'POST',{},201);
 const path='company/Users/'+first.body.id;
 await f.request(path,{schemas:[PATCH],Operations:[{op:'replace',path:'active',value:false}]},'PATCH',{},428);
 await f.request(path,{schemas:[PATCH],Operations:[{op:'replace',path:'externalId',value:'another-owner'}]},'PATCH',{'if-match':first.response.headers.get('etag')},400);
 const appended=await f.request(path,{schemas:[PATCH],Operations:[{op:'add',path:'emails',value:[{value:'second@example.test'}]},
  {op:'add',value:{emails:[{value:'third@example.test'}],name:{givenName:'Bounded'}}}]},'PATCH',{'if-match':first.response.headers.get('etag')});
 assert.deepEqual(appended.body.emails.map(email=>email.value),['first@example.test','second@example.test','third@example.test']);
 const second=await f.request('company/Users',user('another-user'),'POST',{},201);
 const group=await f.request('company/Groups',{schemas:[GROUP],externalId:'roundtrip',displayName:'Roundtrip',members:[{value:first.body.id}]},'POST',{},201);
 assert.equal(group.body.members[0].display.length,255);
 const replaced=await f.request('company/Groups/'+group.body.id,group.body,'PUT',{'if-match':group.response.headers.get('etag')});
 const added=await f.request('company/Groups/'+group.body.id,{schemas:[PATCH],Operations:[{op:'add',value:{members:[{value:second.body.id}]}}]},'PATCH',{'if-match':replaced.response.headers.get('etag')});
 assert.deepEqual(added.body.members.map(member=>member.value).sort(),[first.body.id,second.body.id].sort());
 await f.request('company/Schemas/%ZZ',undefined,'GET',{},400);
 await f.request('company/Users?count=101',undefined,'GET',{},400);
 await f.request('company/Users?count=1&count=2',undefined,'GET',{},400);
 const beforeRejected=await f.request(path);
 await f.request(path,{...user('array-owner'),displayName:'x'.repeat(65536)},'PUT',{'if-match':beforeRejected.response.headers.get('etag')},413);
 await f.request(path,user('array-owner'),'PUT',{'if-match':beforeRejected.response.headers.get('etag'),'content-type':'text/plain'},415);
 await f.request('company/Users',{schemas:[USER],externalId:'duplicate-fields',userName:'first',USERNAME:'second'},'POST',{},400);
 assert.equal((await f.request(path)).response.headers.get('etag'),beforeRejected.response.headers.get('etag'));
});

test('SCIM expiry, separate credentials and durable rotation reject older live instances without losing receipts',async t=>{
 const f=await fixture(t),original=f.sso;
 const created=await f.request('company/Users',user('rotated-subject'),'POST',{'x-clank-idempotency-key':'retained_creation_before_rotation'},201);
 const rotate={...f.options,identityLinking:{policyRevision:2},providers:f.options.providers.map(provider=>provider.organizationId==='company'
  ?{...provider,provisioning:{...provider.provisioning,token:'rotated-separate-provisioning-company-token'}}:provider)};
 assert.throws(()=>f.replace({...rotate,identityLinking:{policyRevision:1}}),/Increase/);
 f.replace(rotate);
 assert.equal((await original.handle(new Request(f.origin+'/scim/v2/company/Users',{headers:{authorization:'Bearer '+token}}))).status,401);
 await f.request('company/Users',undefined,'GET',{},401);
 const headers={authorization:'Bearer '+rotate.providers[0].provisioning.token};
 const replay=await f.request('company/Users',user('rotated-subject'),'POST',{...headers,'x-clank-idempotency-key':'retained_creation_before_rotation'},201);
 assert.deepEqual(replay.body,created.body);
 const configuration=String(f.sql.prepare('SELECT configuration FROM clank_sso_policy').get().configuration);
 assert.ok(!configuration.includes(token));assert.ok(!configuration.includes(rotate.providers[0].provisioning.token));
 const expires={...rotate,identityLinking:{policyRevision:3},providers:rotate.providers.map(provider=>provider.organizationId==='company'
  ?{...provider,provisioning:{...provider.provisioning,expiresAt:Date.now()-1}}:provider)};
 f.replace(expires);await f.request('company/Users',undefined,'GET',headers,401);
 const disabled={...expires,identityLinking:{policyRevision:4},providers:expires.providers.map(provider=>({...provider,provisioning:undefined}))};
 f.replace(disabled);await f.request('company/Users',undefined,'GET',headers,401);
 assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_users').get().n),1);
 assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts').get().n),1);
 assert.throws(()=>f.replace({...f.options,providers:f.options.providers.map(provider=>({...provider,provisioning:{...provider.provisioning,token:provider.offboardingToken}}))}),/separate/);
});

test('deleted SCIM Users retain subject ownership while rehire has a new ID and cannot inherit stale group references',async t=>{
 const f=await fixture(t),first=await f.request('company/Users',user('rehire-subject'),'POST',{},201);
 const group=await f.request('company/Groups',{schemas:[GROUP],externalId:'rehire-group',displayName:'Rehire',members:[{value:first.body.id}]},'POST',{},201);
 const beforeDelete=await f.request('company/Users/'+first.body.id);
 await f.request('company/Users/'+first.body.id,undefined,'DELETE',{'if-match':beforeDelete.response.headers.get('etag'),'x-clank-idempotency-key':'retained_rehire_delete_01'},204);
 const current=await f.request('company/Groups/'+group.body.id);assert.notEqual(current.response.headers.get('etag'),group.response.headers.get('etag'));
 const rehire=await f.request('company/Users',user('rehire-subject'),'POST',{},201);assert.notEqual(rehire.body.id,first.body.id);assert.deepEqual(rehire.body.groups,[]);
 await f.request('company/Groups/'+group.body.id,{schemas:[PATCH],Operations:[{op:'add',path:'members',value:[{value:first.body.id}]}]},'PATCH',{'if-match':current.response.headers.get('etag')},400);
 await f.request('company/Users/'+first.body.id,undefined,'DELETE',{'if-match':beforeDelete.response.headers.get('etag'),'x-clank-idempotency-key':'retained_rehire_delete_01'},204);
 assert.equal((await f.request('company/Users/'+rehire.body.id)).body.active,true);
 assert.equal(f.sql.prepare('SELECT resource_id FROM clank_scim_subjects WHERE subject=?').get('rehire-subject').resource_id,rehire.body.id);
 assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_users').get().n),2);
});

test('full retained receipt and resource capacity rejects new work while exact accepted retries remain readable',async t=>{
 const f=await fixture(t),created=await f.request('company/Users',user('capacity-origin'),'POST',{'x-clank-idempotency-key':'capacity_retained_creation'},201);
 const receipt=f.sql.prepare('SELECT * FROM clank_scim_receipts').get(),row=f.sql.prepare('SELECT * FROM clank_scim_users').get();
 f.sql.transaction(()=>{
  for(let index=1;index<1000;index++){
   f.sql.prepare('INSERT INTO clank_scim_receipts VALUES(?,?,?,?,?,?,?,?)').run(receipt.organization,'occupied_retention_key_'+index,receipt.issuer,receipt.input,receipt.status,receipt.body,receipt.etag,receipt.location);
   f.sql.prepare('INSERT INTO clank_scim_users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('scim_'+index.toString(16).padStart(32,'0'),row.organization,row.issuer,'retained-subject-'+index,'retained-name-'+index,row.data,0,1,null,1,row.created_at,row.updated_at);
  }
 });
 await f.request('company/Users',user('new-capacity'),'POST',{'x-clank-idempotency-key':'new_capacity_request_01'},409);
 await f.request('company/Users',user('new-capacity'),'POST',{},409);
 const replay=await f.request('company/Users',user('capacity-origin'),'POST',{'x-clank-idempotency-key':'capacity_retained_creation'},201);assert.deepEqual(replay.body,created.body);
 assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_users').get().n),1000);
 assert.equal(Number(f.sql.prepare('SELECT count(*) AS n FROM clank_scim_receipts').get().n),1000);
});
