import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {defineAuth,openAuth} from '../dist/auth.js';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openOrganizationSecurityPolicies} from '../dist/organization-security-policy.js';

import {fixture,company,other,defaults} from './fixtures/organization-policy-fixture.mjs';
const change=(requirements,expectedVersion=0,operationId='policy_change_operation_01')=>({requirements:{...defaults,...requirements},expectedVersion,operationId});

test('current actual factor proof, policy previews and immutable delegation generations preserve unrelated organization access',async t=>{
  const f=await fixture(t),password=await f.caller(f.owner);
  assert.throws(()=>f.controller.change(company,password,change({factor:'mfa-or-passkey'})),e=>e.code==='FRESH_AUTH_REQUIRED');
  const caller=await f.step();assert.equal(f.auth.refreshSession(caller.session.id).session.authenticationMethod,'mfa');
  f.controller.captureDelegation(company,'cli_original_key_01',caller);f.controller.captureDelegation(other,'cli_other_key_02',caller);
  const preview=f.controller.preview(company,caller,{...defaults,factor:'mfa-or-passkey'});assert.equal(preview.capableAdministrators,1);assert.equal(preview.proposed.allowed,true);assert.equal(preview.policy.version,0);
  const input=change({factor:'mfa-or-passkey'}),accepted=f.controller.change(company,caller,input);assert.equal(accepted.version,1);
  assert.throws(()=>f.controller.authorizeDelegation(company,'cli_original_key_01',caller.user.id),e=>e.code==='ORGANIZATION_POLICY_DELEGATION');
  assert.doesNotThrow(()=>f.controller.authorizeDelegation(other,'cli_other_key_02',caller.user.id));
  f.controller.captureDelegation(company,'cli_new_key_03',caller);assert.doesNotThrow(()=>f.controller.authorizeDelegation(company,'cli_new_key_03',caller.user.id));
  const relaxed=f.controller.change(company,caller,change({},1,'policy_relax_operation_02'));assert.equal(relaxed.version,2);
  assert.deepEqual(f.controller.change(company,caller,input),accepted);assert.equal(f.controller.read(company,caller).version,2);
  for(const key of ['cli_original_key_01','cli_new_key_03'])assert.throws(()=>f.controller.authorizeDelegation(company,key,caller.user.id),e=>e.code==='ORGANIZATION_POLICY_DELEGATION');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM policy_test_audit').get().n,2);
  assert.throws(()=>f.controller.captureDelegation(company,'cli_original_key_01',caller),e=>e.code==='ORGANIZATION_POLICY_DELEGATION_CONFLICT');
});
test('enrollment grace cannot be extended by a repeated tightening or a leave/rejoin, and session age is independent of step-up',async t=>{
  const f=await fixture(t),fresh=await f.step(),password=await f.caller(f.target);f.grant(company,f.target,'viewer');f.now=Date.now();
  f.controller.change(company,fresh,change({factor:'mfa-or-passkey',enrollmentGraceMs:60000}));
  assert.doesNotThrow(()=>f.controller.authorizeAuth(company,password));
  const deadline=f.sql.prepare('SELECT factor_deadline FROM clank_organization_security_enrollments WHERE organization_id=? AND user_id=?').get(company,password.user.id).factor_deadline;
  f.now+=30000;f.controller.change(company,fresh,change({factor:'mfa-or-passkey',enrollmentGraceMs:120000},1,'policy_grace_retry_02'));
  assert.equal(f.sql.prepare('SELECT factor_deadline FROM clank_organization_security_enrollments WHERE organization_id=? AND user_id=?').get(company,password.user.id).factor_deadline,deadline);
  f.sql.prepare('DELETE FROM policy_test_members WHERE organization=? AND user_id=?').run(company,password.user.id);f.grant(company,f.target,'viewer');
  f.now=deadline;assert.throws(()=>f.controller.authorizeAuth(company,password),e=>e.code==='ORGANIZATION_POLICY_REQUIRED');
  assert.doesNotThrow(()=>f.controller.authorizeAuth(other,fresh));
  f.now=Date.now();f.controller.change(company,fresh,change({factor:'mfa-or-passkey',sessionMaxAgeMs:60000},2,'policy_age_change_03'));f.now=fresh.session.createdAt+60000;
  assert.throws(()=>f.controller.authorizeAuth(company,fresh),e=>e.code==='ORGANIZATION_POLICY_REQUIRED');
});
test('last-admin safeguards, real signed passkey recovery and current independent operator authority are transactional',async t=>{
  const f=await fixture(t,{authorizeRecovery(current){if(current.user.role!=='operator')throw new Error('Current operator required.');},recoverOwner(organization,userId){f.sql.prepare("INSERT OR REPLACE INTO policy_test_members VALUES(?,?,'owner',?)").run(organization,userId,f.now);}}),caller=await f.step();
  const input=change({factor:'passkey'});f.controller.change(company,caller,input);
  const recovery={ownerId:f.target.user.id,confirmation:company,reason:'Restore the enrolled recovery administrator.',expectedVersion:1,operationId:'policy_operator_recovery_01'};
  f.auth.setRole(f.operator.user.id,'operator');const operator=await f.step(f.operator);
  assert.throws(()=>f.controller.recover(company,operator,recovery),e=>e.code==='ORGANIZATION_POLICY_RECOVERY_OWNER');
  const signed=await f.passkey();assert.equal(signed.session.authenticationMethod,'passkey');
  const restored=f.controller.recover(company,operator,recovery);assert.equal(restored.version,2);assert.equal(restored.factor,'passkey');assert.equal(restored.ssoOnly,false);
  assert.doesNotThrow(()=>f.controller.authorizeAuth(company,signed));assert.deepEqual(f.controller.recover(company,operator,recovery),restored);
  assert.throws(()=>f.controller.recover(company,operator,{...recovery,expectedVersion:2,operationId:'policy_unneeded_recovery_02'}),e=>e.code==='ORGANIZATION_POLICY_RECOVERY_UNNEEDED');
  f.auth.setRole(f.operator.user.id,'user');assert.throws(()=>f.controller.recover(company,operator,recovery),/Current operator required/);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM policy_test_audit WHERE action='organization.security-policy.recover'").get().n,1);
});
test('failed audit, exact receipt conflict, bounded capacity and unknown protocol never publish a policy',async t=>{
  const f=await fixture(t,{maxReceipts:1}),caller=await f.step(),input=change({factor:'mfa-or-passkey'});
  f.rejectAudit=true;assert.throws(()=>f.controller.change(company,caller,input),/Test audit refused/);assert.equal(f.controller.read(company,caller).version,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_organization_security_receipts').get().n,0);
  f.rejectAudit=false;f.controller.change(company,caller,input);
  assert.throws(()=>f.controller.change(company,caller,{...input,requirements:defaults}),e=>e.code==='ORGANIZATION_POLICY_OPERATION_CONFLICT');
  assert.throws(()=>f.controller.change(company,caller,change({},1,'policy_capacity_change_02')),e=>e.code==='ORGANIZATION_POLICY_CAPACITY');
  assert.equal(f.controller.read(company,caller).version,1);
  f.sql.prepare('UPDATE clank_organization_security_state SET protocol=99').run();
  assert.throws(()=>f.controller.read(company,caller),e=>e.code==='ORGANIZATION_POLICY_PROTOCOL');assert.throws(()=>openOrganizationSecurityPolicies(f.db,f.auth,f.hooks),e=>e.code==='ORGANIZATION_POLICY_PROTOCOL');
});
test('serialized state cannot authenticate, and a server OAuth identity binding never crosses organizations',async t=>{
  const f=await fixture(t),caller=await f.step();f.controller.change(company,caller,change({factor:'mfa-or-passkey'}));
  assert.throws(()=>f.controller.authorizeAuth(company,{user:caller.user,session:null}),e=>e.code==='ORGANIZATION_POLICY_SESSION');
  assert.throws(()=>f.controller.authorizeAuth(company,JSON.parse(JSON.stringify(caller))),e=>e.code==='ORGANIZATION_POLICY_SESSION');
  f.controller.captureDelegation(company,'mcp_native_family_01',caller);const delegated={...caller,session:null};f.controller.bindDelegationAuth(company,'mcp_native_family_01',delegated);
  assert.doesNotThrow(()=>f.controller.authorizeAuth(company,delegated));assert.throws(()=>f.controller.authorizeAuth(other,delegated),e=>e.code==='ORGANIZATION_POLICY_DELEGATION');
  f.sql.prepare('DELETE FROM policy_test_members WHERE organization=? AND user_id=?').run(company,caller.user.id);assert.throws(()=>f.controller.authorizeAuth(company,delegated),e=>e.code==='ORGANIZATION_POLICY_REQUIRED');
  f.controller.close();assert.throws(()=>f.controller.authorizeAuth(other,caller),e=>e.code==='ORGANIZATION_POLICY_CLOSED');
});
