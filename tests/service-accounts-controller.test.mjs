import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openPlatformServiceAccounts} from '../dist/platform-service-accounts.js';

const org='machine_org_exact_01',owner='machine_owner_exact_01',project='machine_project_exact_01';
async function setup(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-service-accounts-')),schema=defineDatabase({}),database=await openSQLite(schema,{path:join(root,'control.sqlite')}),sql=database[Symbol.for('clank.sqlite.internal')];
  sql.exec(`CREATE TABLE clank_platform_organizations(id TEXT PRIMARY KEY); CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY);
    CREATE TABLE clank_platform_tokens(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,user_id TEXT,name TEXT,created_at INTEGER,expires_at INTEGER,organization_id TEXT,project_id TEXT,permissions TEXT,last_used_at INTEGER,revoked_at INTEGER,preview_name TEXT);`);
  sql.prepare('INSERT INTO clank_platform_organizations VALUES(?)').run(org);sql.prepare('INSERT INTO clank_platform_projects VALUES(?)').run(project);
  let currentTime=20000000,allowed=true,eligible=true,auditFailure=false;const events=[],key=randomBytes(32);
  const hooks={hash:value=>createHash('sha256').update(value).digest('hex'),now:()=>currentTime,eligibleOwner:(organizationId,ownerId,projectId)=>eligible&&organizationId===org&&ownerId===owner&&(!projectId||projectId===project),
    encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');},
    decrypt(value){const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}};
  // Audit effects share the same transaction; capture them in SQLite rather than a mock sink.
  sql.exec('CREATE TABLE machine_test_audit(action TEXT,metadata TEXT)');
  const authority={userId:owner,authorize(organizationId){if(!allowed||organizationId!==org)throw new Error('Current organization authority denied.');},audit(action,metadata){sql.prepare('INSERT INTO machine_test_audit VALUES(?,?)').run(action,JSON.stringify(metadata));if(auditFailure)throw new Error('Audit unavailable.');events.push({action,metadata});}};
  let store=openPlatformServiceAccounts(sql,options,hooks);
  t.after(async()=>{store.close();database.close();await rm(root,{recursive:true,force:true});});
  return {sql,hooks,authority,get store(){return store;},events,restart(){store.close();store=openPlatformServiceAccounts(sql,options,hooks);},time(value){currentTime=value;},allowed(value){allowed=value;},eligible(value){eligible=value;},auditFailure(value){auditFailure=value;}};
}
const creation={name:'Build robot',ownerId:owner,operationId:'machine_create_exact_01'};
const issue=(version=1,operationId='machine_issue_exact_01')=>({projectId:project,permissions:['read','secrets'],expiresAt:21000000,expectedVersion:version,operationId});
test('dedicated service identities retain encrypted exact credential receipts across restart without human sessions',async t=>{
  const f=await setup(t),account=f.store.create(org,f.authority,creation),issued=f.store.issue(org,account.id,f.authority,issue());
  assert.match(issued.accessToken,/^clsa_[A-Za-z0-9_-]{43}$/);assert.equal(issued.account.version,2);assert.equal(issued.credential.generation,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_accounts').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_tokens').get().n,1);
  assert.ok(!f.sql.prepare('SELECT result FROM clank_platform_machine_receipts').all().some(row=>row.result.includes(issued.accessToken)));
  assert.ok(!JSON.stringify(f.events).includes(issued.accessToken));assert.equal(f.sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_auth_sessions'").get(),undefined);
  f.restart();assert.deepEqual(f.store.create(org,f.authority,creation),account);assert.deepEqual(f.store.issue(org,account.id,f.authority,issue()),issued);
  const caller=f.store.resolve(issued.accessToken);assert.equal(caller.identity.kind,'service-account');assert.equal(caller.identity.id,account.id);assert.equal(caller.identity.ownerId,owner);caller.assertCurrent();
  assert.equal(f.store.read(org,account.id,f.authority).credentials[0].authenticatedRequests,1);
  assert.throws(()=>f.store.issue(org,account.id,f.authority,{...issue(),permissions:['read','audit']}),error=>error.code==='SERVICE_ACCOUNT_OPERATION_CONFLICT');
});
test('rotation, revocation, owner loss, expiry and closed controllers fence already-resolved machine authority',async t=>{
  const f=await setup(t),account=f.store.create(org,f.authority,creation),first=f.store.issue(org,account.id,f.authority,issue()),prior=f.store.resolve(first.accessToken);
  const second=f.store.issue(org,account.id,f.authority,issue(2,'machine_rotation_exact_01'));assert.equal(second.credential.generation,2);assert.throws(()=>prior.assertCurrent(),error=>error.status===401);
  assert.throws(()=>f.store.resolve(first.accessToken),error=>error.status===401);assert.deepEqual(f.store.issue(org,account.id,f.authority,issue()),first);
  const current=f.store.resolve(second.accessToken);f.eligible(false);assert.throws(()=>current.assertCurrent(),error=>error.code==='SERVICE_ACCOUNT_OWNER_INELIGIBLE');f.eligible(true);
  f.sql.prepare('UPDATE clank_platform_tokens SET preview_name=? WHERE id=?').run('unexpected-preview',second.credential.id);assert.throws(()=>current.assertCurrent(),error=>error.status===401);
  f.sql.prepare('UPDATE clank_platform_tokens SET preview_name=NULL WHERE id=?').run(second.credential.id);current.assertCurrent();
  f.time(second.credential.expiresAt);assert.throws(()=>current.assertCurrent(),error=>error.status===401);f.time(20000000);
  f.store.change(org,account.id,f.authority,{...creation,enabled:false,expectedVersion:3,operationId:'machine_disable_exact_01'});assert.throws(()=>current.assertCurrent(),error=>error.status===401);
  f.restart();assert.throws(()=>f.store.resolve(second.accessToken),error=>error.status===401);f.store.close();assert.throws(()=>current.assertCurrent(),error=>error.code==='SERVICE_ACCOUNT_CLOSED');
});
test('failed audits, stale versions, capacity and untrusted grants leave no partial machine credentials',async t=>{
  const f=await setup(t,{maxAccounts:1,maxCredentials:1,maxReceipts:3});f.auditFailure(true);
  assert.throws(()=>f.store.create(org,f.authority,creation),/Audit unavailable/);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_accounts').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM machine_test_audit').get().n,0);
  f.auditFailure(false);const account=f.store.create(org,f.authority,creation);
  assert.throws(()=>f.store.create(org,f.authority,{...creation,operationId:'machine_over_capacity_01'}),error=>error.code==='SERVICE_ACCOUNT_CAPACITY');
  for(const grant of [['read','tokens'],['read','read'],[],['secrets']])assert.throws(()=>f.store.issue(org,account.id,f.authority,{...issue(),permissions:grant}),error=>error.status===422);
  assert.throws(()=>f.store.issue(org,account.id,f.authority,{...issue(),projectId:'foreign_project_exact_01'}),error=>error.status===403);
  f.auditFailure(true);assert.throws(()=>f.store.issue(org,account.id,f.authority,issue()),/Audit unavailable/);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_tokens').get().n,0);
  f.auditFailure(false);const accepted=f.store.issue(org,account.id,f.authority,issue());
  assert.throws(()=>f.store.issue(org,account.id,f.authority,issue(1,'machine_stale_version_01')),error=>error.code==='SERVICE_ACCOUNT_VERSION_CONFLICT');
  assert.throws(()=>f.store.issue(org,account.id,f.authority,issue(2,'machine_over_credentials_01')),error=>error.code==='SERVICE_ACCOUNT_CAPACITY');
  f.allowed(false);assert.throws(()=>f.store.issue(org,account.id,f.authority,issue()),/authority denied/);f.allowed(true);assert.equal(f.store.resolve(accepted.accessToken).identity.id,account.id);
});
test('unknown persisted protocols refuse startup and held authority without altering machine history',async t=>{
  const f=await setup(t),account=f.store.create(org,f.authority,creation),issued=f.store.issue(org,account.id,f.authority,issue()),caller=f.store.resolve(issued.accessToken);
  f.sql.prepare('UPDATE clank_platform_machine_state SET protocol=99').run();const before=f.sql.prepare('SELECT * FROM clank_platform_machine_credentials').all();
  assert.throws(()=>caller.assertCurrent(),error=>error.code==='SERVICE_ACCOUNT_PROTOCOL_UNSUPPORTED');assert.throws(()=>openPlatformServiceAccounts(f.sql,{},f.hooks),error=>error.code==='SERVICE_ACCOUNT_PROTOCOL_UNSUPPORTED');
  assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_machine_credentials').all(),before);
});
test('current administrators can emergency-disable an account after its responsible owner loses eligibility',async t=>{
  const f=await setup(t),account=f.store.create(org,f.authority,creation),issued=f.store.issue(org,account.id,f.authority,issue());
  f.eligible(false);
  const disabled=f.store.change(org,account.id,f.authority,{...creation,enabled:false,expectedVersion:issued.account.version,operationId:'machine_ineligible_disable_01'});
  assert.equal(disabled.enabled,false);assert.equal(disabled.version,3);
  assert.equal(f.sql.prepare('SELECT revoked_at FROM clank_platform_machine_credentials WHERE id=?').get(issued.credential.id).revoked_at,20000000);
  f.eligible(true);assert.throws(()=>f.store.resolve(issued.accessToken),error=>error.status===401);
});
