import test from 'node:test';
import assert from 'node:assert/strict';
import {openPlatformTemporaryAccess} from '../dist/platform-temporary-access.js';
import {fixture,company,defaults} from './fixtures/organization-policy-fixture.mjs';

const project='temporary_project_01';
async function setup(t,overrides={}) {
  const f=await fixture(t);f.grant(company,f.target,'viewer');
  f.sql.exec(`CREATE TABLE clank_platform_memberships(organization_id TEXT,user_id TEXT,role TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(organization_id,user_id));
    CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY,organization_id TEXT,parent_project_id TEXT);
    CREATE TABLE temporary_test_audit(actor TEXT,project TEXT,action TEXT,metadata TEXT);`);
  f.sql.prepare('INSERT INTO clank_platform_projects VALUES(?,?,NULL)').run(project,company);
  for(const [account,role]of [[f.owner,'owner'],[f.target,'viewer']])f.sql.prepare('INSERT INTO clank_platform_memberships VALUES(?,?,?,?,?)').run(company,account.user.id,role,f.now,f.now);
  const options={membership(projectId,userId){const row=f.sql.prepare('SELECT m.*,p.organization_id FROM clank_platform_memberships m JOIN clank_platform_projects p ON p.organization_id=m.organization_id JOIN clank_auth_users u ON u.id=m.user_id WHERE p.id=? AND m.user_id=? AND u.disabled=0 AND p.parent_project_id IS NULL').get(projectId,userId);return row?{organizationId:row.organization_id,role:row.role,createdAt:row.created_at,updatedAt:row.updated_at,policyVersion:f.controller.read(company,f.auth.refreshSession(f.owner.session.id)).version}:null;},audit(actor,projectId,action,metadata){const encoded=JSON.stringify(metadata);const write=f.sql.prepare('INSERT INTO temporary_test_audit VALUES(?,?,?,?)').run(actor,projectId,action,encoded);const row=f.sql.prepare('SELECT * FROM temporary_test_audit WHERE rowid=?').get(write.lastInsertRowid);if(write.changes!==1||row?.metadata!==encoded||row?.action!==action)throw new Error('Native audit was not acknowledged.');},now:()=>f.now,...overrides};
  let controller=openPlatformTemporaryAccess(f.sql,options);t.after(()=>controller.close());
  const authority=account=>({userId:account.user.id,assertCurrent(fresh){const live=f.auth.refreshSession(account.session.id);if(live?.user?.id!==account.user.id)throw new Error('Current native session required.');f.controller.authorizeAuth(company,live);if(fresh)f.auth.requireFreshAuthentication(live,300000);}});
  await f.step();await f.step(f.target);f.now=Date.now();
  const create=(expectedVersion=0,operationId='temporary_create_intent_01')=>({recipientId:f.target.user.id,action:'preview.create',durationMs:60000,reason:'Create the reviewed isolated preview.',expectedVersion,operationId});
  return {...f,options,create,authority,ownerAuthority:authority(f.owner),targetAuthority:authority(f.target),get now(){return f.now;},set now(value){f.now=value;},get access(){return controller;},restart(){controller.close();controller=openPlatformTemporaryAccess(f.sql,options);}};
}

test('native fresh human grants, exact lost-response receipts, current inventory and revocation survive restart',async t=>{
  const f=await setup(t),input=f.create(),accepted=f.access.create(project,f.ownerAuthority,input);assert.equal(accepted.acceptedVersion,1);assert.equal(accepted.grant.active,true);
  assert.deepEqual(f.access.create(project,f.ownerAuthority,input),accepted);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM temporary_test_audit').get().n,1);
  const held=f.access.capture(project,f.targetAuthority,accepted.grant.id);held();f.sql.transaction(()=>held());
  const current=f.access.read(project,f.targetAuthority);assert.equal(current.grants.length,1);assert.equal(current.grants[0].active,true);
  const revoke={grantId:accepted.grant.id,reason:'The review window is finished.',expectedVersion:1,operationId:'temporary_revoke_intent_01'};
  const revoked=f.access.revoke(project,f.ownerAuthority,revoke);assert.equal(revoked.grant.active,false);assert.equal(revoked.acceptedVersion,2);assert.deepEqual(f.access.revoke(project,f.ownerAuthority,revoke),revoked);
  assert.throws(()=>held(),e=>e.code==='TEMPORARY_ACCESS_DENIED');assert.throws(()=>f.access.capture(project,f.targetAuthority,accepted.grant.id),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  assert.equal(f.access.create(project,f.ownerAuthority,input).grant.active,false);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM temporary_test_audit').get().n,2);f.restart();assert.equal(f.access.read(project,f.ownerAuthority).grants[0].active,false);
});
test('expiry invalidates held decisions, persists after restart, and clock rollback cannot revive grants',async t=>{
  const f=await setup(t),grant=f.access.create(project,f.ownerAuthority,f.create()).grant,held=f.access.capture(project,f.targetAuthority,grant.id);f.now=grant.expiresAt;
  assert.throws(()=>held(),e=>e.code==='TEMPORARY_ACCESS_DENIED');assert.equal(f.access.read(project,f.ownerAuthority).grants[0].state,'expired');f.restart();
  assert.equal(f.access.create(project,f.ownerAuthority,f.create()).grant.active,false);f.now=grant.createdAt;assert.throws(()=>f.access.read(project,f.ownerAuthority),e=>e.code==='TEMPORARY_ACCESS_CLOCK');
  f.now=grant.expiresAt;assert.throws(()=>f.access.capture(project,f.targetAuthority,grant.id),e=>e.code==='TEMPORARY_ACCESS_DENIED');
});
test('a denied expiry decision cannot roll back the clock fence and then revive authority',async t=>{
  const f=await setup(t),grant=f.access.create(project,f.ownerAuthority,f.create()).grant,held=f.access.capture(project,f.targetAuthority,grant.id);
  f.now=grant.expiresAt;assert.throws(()=>held(),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  f.now=grant.createdAt;assert.throws(()=>f.access.capture(project,f.targetAuthority,grant.id),e=>['TEMPORARY_ACCESS_CLOCK','TEMPORARY_ACCESS_DENIED'].includes(e.code));
});
for(const who of ['issuer','recipient'])test(`${who} membership removal/rejoin with identical timestamps permanently fences a held grant`,async t=>{
  const f=await setup(t),grant=f.access.create(project,f.ownerAuthority,f.create()).grant,held=f.access.capture(project,f.targetAuthority,grant.id),user=who==='issuer'?f.owner:f.target;
  const row=f.sql.prepare('SELECT * FROM clank_platform_memberships WHERE user_id=?').get(user.user.id);
  let release;const resumed=new Promise(resolve=>{release=resolve;});const inFlight=(async()=>{await resumed;held();})();
  f.sql.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(company,user.user.id);f.sql.prepare('INSERT INTO clank_platform_memberships VALUES(?,?,?,?,?)').run(company,user.user.id,row.role,row.created_at,row.updated_at);release();
  await assert.rejects(inFlight,e=>e.code==='TEMPORARY_ACCESS_DENIED');f.restart();assert.equal(f.access.read(project,f.ownerAuthority).grants[0].state,'revoked');
});
test('role removal, project reassignment and policy version changes invalidate rather than revive privileges',async t=>{
  const f=await setup(t),grant=f.access.create(project,f.ownerAuthority,f.create()).grant,held=f.access.capture(project,f.targetAuthority,grant.id);
  f.sql.prepare("UPDATE clank_platform_memberships SET role='viewer' WHERE user_id=?").run(f.owner.user.id);assert.throws(()=>held(),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  f.sql.prepare("UPDATE clank_platform_memberships SET role='owner' WHERE user_id=?").run(f.owner.user.id);assert.throws(()=>held(),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  const next=f.access.create(project,f.ownerAuthority,f.create(f.access.read(project,f.ownerAuthority).version,'temporary_create_policy_02')).grant;
  f.controller.change(company,await f.caller(f.owner),{requirements:{...defaults,factor:'mfa-or-passkey'},expectedVersion:0,operationId:'temporary_policy_tighten_01'});
  assert.throws(()=>f.access.capture(project,f.targetAuthority,next.id),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  f.controller.change(company,await f.caller(f.owner),{requirements:defaults,expectedVersion:1,operationId:'temporary_policy_relax_02'});assert.throws(()=>f.access.capture(project,f.targetAuthority,next.id),e=>e.code==='TEMPORARY_ACCESS_DENIED');
  const third=f.access.create(project,f.ownerAuthority,f.create(f.access.read(project,f.ownerAuthority).version,'temporary_create_move_03')).grant;
  f.sql.prepare('UPDATE clank_platform_projects SET parent_project_id=? WHERE id=?').run('another_project_01',project);f.sql.prepare('UPDATE clank_platform_projects SET parent_project_id=NULL WHERE id=?').run(project);assert.throws(()=>f.access.capture(project,f.targetAuthority,third.id),e=>e.code==='TEMPORARY_ACCESS_DENIED');
});
for(const change of ['ignore','alter'])test(`native ${change} audit writes roll back grant, clock, version and receipt acceptance`,async t=>{
  const f=await setup(t);f.sql.exec(change==='ignore'?`CREATE TRIGGER test_audit BEFORE INSERT ON temporary_test_audit BEGIN SELECT RAISE(IGNORE); END;`:`CREATE TRIGGER test_audit AFTER INSERT ON temporary_test_audit BEGIN UPDATE temporary_test_audit SET metadata='{}' WHERE rowid=NEW.rowid; END;`);
  assert.throws(()=>f.access.create(project,f.ownerAuthority,f.create()),/audit/);
  for(const table of ['clank_platform_temporary_access_grants','clank_platform_temporary_access_versions','clank_platform_temporary_access_receipts','temporary_test_audit'])assert.equal(f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  assert.equal(f.sql.prepare('SELECT clock FROM clank_platform_temporary_access_state').get().clock,0);
});
for(const change of ['ignore','alter'])test(`native ${change} receipts cannot acknowledge an unstored or substituted grant`,async t=>{
  const f=await setup(t);f.sql.exec(change==='ignore'?`CREATE TRIGGER test_receipt BEFORE INSERT ON clank_platform_temporary_access_receipts BEGIN SELECT RAISE(IGNORE); END;`:`CREATE TRIGGER test_receipt AFTER INSERT ON clank_platform_temporary_access_receipts BEGIN UPDATE clank_platform_temporary_access_receipts SET accepted_version=99; END;`);
  assert.throws(()=>f.access.create(project,f.ownerAuthority,f.create()),e=>['TEMPORARY_ACCESS_STATE','TEMPORARY_ACCESS_WRITE'].includes(e.code));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_temporary_access_grants').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM temporary_test_audit').get().n,0);
});
test('capacity, exact scope, stale concurrent intents, recipient visibility and current native assurance remain bounded',async t=>{
  const f=await setup(t,{maxGrants:1}),grant=f.access.create(project,f.ownerAuthority,f.create()).grant;
  assert.throws(()=>f.access.create(project,f.ownerAuthority,f.create(0,'temporary_other_intent_02')),e=>e.code==='TEMPORARY_ACCESS_CAPACITY');
  assert.throws(()=>f.access.create(project,f.ownerAuthority,{...f.create(),action:'jobs.cancel'}),e=>e.code==='TEMPORARY_ACCESS_INPUT');
  assert.throws(()=>f.access.create(project,f.ownerAuthority,{...f.create(),reason:'Different intent.'}),e=>e.code==='TEMPORARY_ACCESS_RETRY');
  assert.throws(()=>f.access.create(project,f.targetAuthority,f.create()),e=>e.code==='TEMPORARY_ACCESS_ADMIN');
  f.auth.revokeUserSessions(f.target.user.id);assert.throws(()=>f.access.capture(project,f.targetAuthority,grant.id),/native session/);
  f.sql.prepare('UPDATE clank_platform_temporary_access_state SET protocol=9').run();assert.throws(()=>f.restart(),e=>e.code==='TEMPORARY_ACCESS_PROTOCOL');
});
