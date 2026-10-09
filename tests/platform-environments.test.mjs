import { fixture } from './fixtures/platform-environment-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPlatform } from '../dist/platform.js';

const origin = 'http://127.0.0.1:4200';
test('operator promotion host registry rejects invalid node identities and an unbounded inventory before opening resources', async () => {
  const options={dataDirectory:'/never-created-promotion-registry',publicUrl:origin};
  await assert.rejects(openPlatform({...options,providerPromotionHosts:[]}),/Invalid provider promotion host registry/);
  await assert.rejects(openPlatform({...options,providerPromotionHosts:{'../node':{}}}),/Invalid provider promotion node ID/);
  await assert.rejects(openPlatform({...options,providerPromotionHosts:Object.fromEntries(Array.from({length:101},(_,index)=>['node_'+index,{}]))}),/Invalid provider promotion host registry/);
});
test('promotion preserves original upload bytes, independent target data and secrets, and accepted replay across restart', { timeout: 45000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1');
  for (const project of [f.development, f.staging, f.production]) await f.call(`/api/projects/${project.id}/secrets`, { values: { ENVIRONMENT_VALUE: project.slug } }, 200, 'PUT');
  const source = await f.upload(f.development, artifact, 'development_upload_01');
  await f.probe(f.development, '/write/source-only');
  const input = f.promotion(source, artifact);
  const promoted = await f.call(f.path('staging') + '/promotions', input, 201);
  assert.equal(promoted.release.digest, artifact.digest); assert.equal(promoted.promotion.state, 'accepted');
  const original = await readFile(join(f.options.dataDirectory, 'projects', f.staging.id, 'artifacts', `${promoted.release.id}.clank.gz`));
  assert.deepEqual(original, artifact.bytes);
  assert.deepEqual(await f.probe(f.staging), { label: 'v1', value: 'initial', secret: 'staging', bucketPrefix: f.staging.id });
  await f.probe(f.staging, '/write/staging-only'); assert.equal((await f.probe(f.development)).value, 'source-only');
  await f.restart();
  const replay = await f.call(f.path('staging') + '/promotions', input, 201);
  assert.equal(replay.release.id, promoted.release.id); assert.equal((await f.probe(f.staging)).value, 'staging-only');
  const changed = await f.call(f.path('staging') + '/promotions', { ...input, expectedActiveReleaseId: promoted.release.id }, 409);
  assert.equal(changed.error.code, 'PROMOTION_RETRY_CHANGED');
  const history = await f.call(f.path('staging') + '/promotions'); assert.equal(history.promotions.length, 1);
  const releases = await f.call(`/api/projects/${f.staging.id}/releases`); assert.equal(releases.releases.length, 1);
});

test('binding waits for actual target deletion and preserves the unbound version', { timeout: 60000 }, async t => {
  const f=await fixture(t),hold=join(f.root,'delete-hold'),entered=join(f.root,'delete-entered');
  await f.call(f.path('staging'),{expectedVersion:1},200,'DELETE');
  const artifact=await f.artifact('v1','',{},'',{hold,entered});
  await f.upload(f.staging,artifact,'target_delete_binding_01');await writeFile(hold,'waiting');
  const deleting=f.call(`/api/projects/${f.staging.id}`,{confirmation:'delete-site staging',acknowledgeDataLoss:true},200,'DELETE');
  deleting.catch(()=>{});
  try {
    const deadline=Date.now()+10000;
    while(true){try{await readFile(entered);break}catch(error){if(error.code!=='ENOENT')throw error}
      assert.ok(Date.now()<deadline,'The actual prior runtime must enter its deletion stop.');await new Promise(resolve=>setTimeout(resolve,10))}
    let finished=false;
    const binding=f.call(f.path('staging'),{projectId:f.staging.id,expectedVersion:2},404,'PUT');
    binding.then(()=>{finished=true},()=>{finished=true});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false,'Binding must share the target deletion lease.');
    await rm(hold);await deleting;
    assert.equal((await binding).error.code,'PROJECT_NOT_FOUND');
    const state=(await f.call(f.path())).environments.find(row=>row.name==='staging');
    assert.equal(state.projectId,null);assert.equal(state.version,2);
  } finally {await rm(hold,{force:true})}
});

test('environment configuration and target activation reject stale expected versions and changed active targets', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), source = await f.upload(f.development, artifact, 'source_version_upload');
  const stale = await f.call(f.path('staging'), { projectId: f.staging.id, expectedVersion: 0 }, 409, 'PUT');
  assert.equal(stale.error.code, 'ENVIRONMENT_VERSION_STALE');
  const target = await f.upload(f.staging, artifact, 'target_version_upload');
  const result = await f.call(f.path('staging') + '/promotions', f.promotion(source, artifact), 409);
  assert.equal(result.error.code, 'PROMOTION_TARGET_STALE');
  assert.equal((await f.call(f.path('staging') + '/promotions')).promotions.length, 0);
  const configuration = await f.bind('staging', f.staging, 1, 'code-only'); assert.equal(configuration.version, 2);
  const policyChanged = await f.call(f.path('staging') + '/promotions', f.promotion(source, artifact, target.id), 409);
  assert.equal(policyChanged.error.code, 'ENVIRONMENT_VERSION_STALE');
  const valid = await f.call(f.path('staging') + '/promotions', f.promotion(source, artifact, target.id, 'version_updated_request', 2), 201);
  assert.equal(valid.promotion.state, 'accepted');
});

test('production defaults to code-only and a failed candidate restores the target snapshot and prior runtime', { timeout: 45000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'), first = await f.upload(f.development, v1, 'source_initial_upload');
  const blocked = await f.call(f.path('production') + '/promotions', f.promotion(first, v1), 409);
  assert.equal(blocked.error.code, 'PROMOTION_MIGRATIONS_BLOCKED');
  const target = await f.upload(f.production, v1, 'production_initialize'); await f.probe(f.production, '/write/production-only');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='candidate-only'; CREATE TABLE newer(id INTEGER PRIMARY KEY);");
  const source = await f.upload(f.development, v2, 'source_candidate_upload');
  const codeOnly = await f.call(f.path('production') + '/promotions', f.promotion(source, v2, target.id, 'production_code_only'), 409);
  assert.equal(codeOnly.error.code, 'PROMOTION_MIGRATIONS_BLOCKED'); assert.equal((await f.probe(f.production)).value, 'production-only');
  await f.bind('production', f.production, 1, 'apply-safe');
  await f.call(`/api/projects/${f.production.id}/secrets`, { values: { FAIL_HEALTH: '1' } }, 200, 'PUT');
  // The old runtime retains its already-resolved environment while the candidate
  // resolves the target's current secrets and fails its actual health request.
  f.options.onError = () => Promise.reject(new Error('private observer failure'));
  const failed = await f.call(f.path('production') + '/promotions', f.promotion(source, v2, target.id, 'production_health_fail', 2), 422);
  assert.equal(failed.error.code, 'DEPLOYMENT_FAILED');
  const database = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.production.id, 'data', 'app.sqlite'));
  try {
    assert.equal(database.prepare('SELECT value FROM sample').get().value, 'production-only');
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='newer'").get().n, 0);
  } finally { database.close(); }
  assert.equal((await f.probe(f.production)).label, 'v1', 'the actual prior target serves after rollback');
  const history = await f.call(f.path('production') + '/promotions'); assert.ok(history.promotions.every(row => row.state === 'failed'));
  const retry = await f.call(f.path('production') + '/promotions', f.promotion(source, v2, target.id, 'production_health_fail', 2), 409);
  assert.equal(retry.error.code, 'PROMOTION_FAILED');
});

test('current source and target roles govern promotion and production cannot be bypassed by direct upload', { timeout: 45000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), source = await f.upload(f.development, artifact, 'source_role_test_upload');
  await f.upload(f.production, artifact, 'production_role_initialize');
  const developer = await f.account('developer@example.test'), viewer = await f.account('viewer@example.test');
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite'));
  t.after(() => control.close());
  for (const [account, role] of [[developer, 'developer'], [viewer, 'viewer']]) control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(f.development.organizationId, account.user.id, role, Date.now(), Date.now());
  const input = f.promotion(source, artifact);
  const deniedConfig = await f.call(f.path('staging'), { projectId: f.staging.id, expectedVersion: 1 }, 403, 'PUT', developer);
  assert.equal(deniedConfig.error.code, 'ROLE_DENIED');
  const deniedReadOnly = await f.call(f.path('staging') + '/promotions', input, 403, 'POST', viewer);
  assert.equal(deniedReadOnly.error.code, 'ROLE_DENIED');
  const staging = await f.call(f.path('staging') + '/promotions', input, 201, 'POST', developer);
  assert.equal(staging.promotion.state, 'accepted');
  const production = await f.call(`/api/projects/${f.production.id}`);
  const productionInput = f.promotion(source, artifact, production.project.activeReleaseId, 'production_role_request');
  const deniedProduction = await f.call(f.path('production') + '/promotions', productionInput, 403, 'POST', developer);
  assert.equal(deniedProduction.error.code, 'PRODUCTION_ROLE_REQUIRED');
  control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)').run(f.production.id, developer.user.id, JSON.stringify(['read','deploy','rollback']));
  const deniedExplicit = await f.call(f.path('production') + '/promotions', productionInput, 403, 'POST', developer);
  assert.equal(deniedExplicit.error.code, 'PRODUCTION_ROLE_REQUIRED');
  const response = await f.call(`/api/projects/${f.production.id}/releases`, {}, 403, 'POST', developer);
  assert.equal(response.error.code, 'PRODUCTION_ROLE_REQUIRED', 'production checks precede artifact body processing');
  control.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId, developer.user.id);
  const revoked = await f.call(f.path('staging') + '/promotions', input, 404, 'POST', developer);
  assert.equal(revoked.error.code, 'PROJECT_NOT_FOUND', 'a retained accepted receipt does not restore removed membership');
});

test('binding tombstones prevent old retries after reconfiguration and deleted targets never expose stale provenance', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), source = await f.upload(f.development, artifact, 'source_tombstone_upload');
  const input = f.promotion(source, artifact), result = await f.call(f.path('staging') + '/promotions', input, 201);
  await f.call(f.path('staging'), { expectedVersion: 1 }, 200, 'DELETE');
  const absent = await f.call(f.path('staging') + '/promotions', input, 404); assert.equal(absent.error.code, 'ENVIRONMENT_NOT_FOUND');
  const reconfigured = await f.bind('staging', f.staging, 2); assert.equal(reconfigured.version, 3);
  const old = await f.call(f.path('staging') + '/promotions', input, 409); assert.equal(old.error.code, 'ENVIRONMENT_VERSION_STALE');
  const retained = await f.call(f.path('staging') + '/promotions'); assert.equal(retained.promotions[0].targetReleaseId, result.release.id);
  const deleteInput = { confirmation: `delete-site ${f.staging.slug}`, acknowledgeDataLoss: true };
  const bound = await f.call(`/api/projects/${f.staging.id}`, deleteInput, 409, 'DELETE'); assert.equal(bound.error.code, 'ENVIRONMENTS_EXIST');
  await f.call(f.path('staging'), { expectedVersion: 3 }, 200, 'DELETE');
  await f.call(`/api/projects/${f.staging.id}`, deleteInput, 200, 'DELETE');
  assert.equal((await f.call(f.path('staging') + '/promotions')).promotions.length, 0);
  const targets = await f.call(f.path()); assert.equal(targets.environments.find(row => row.name === 'staging').projectId, null);
});

for (const boundary of ['source', 'target']) test(`revoking ${boundary} permission during actual candidate health checking fences activation and restores target data`, { timeout: 45000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1');
  await f.upload(f.development, v1, 'source_revocation_initial');
  const target = await f.upload(f.staging, v1, 'target_revocation_initial'); await f.probe(f.staging, '/write/retained-target');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='candidate-only'; CREATE TABLE newer(id INTEGER PRIMARY KEY);");
  const source = await f.upload(f.development, v2, 'source_revocation_candidate');
  const developer = await f.account(`revoked-${boundary}@example.test`);
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(f.development.organizationId, developer.user.id, 'developer', Date.now(), Date.now());
  const hold = join(f.root, 'hold'), entered = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: entered } }, 200, 'PUT');
  const pending = f.call(f.path('staging') + '/promotions', f.promotion(source, v2, target.id, `revoke_${boundary}_request`), 403, 'POST', developer);
  pending.catch(() => {}); // The assertion is awaited after the real health barrier below.
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(entered); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'actual candidate did not enter health checking'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)')
    .run(boundary === 'source' ? f.development.id : f.staging.id, developer.user.id, JSON.stringify(boundary === 'source' ? ['deploy'] : ['read']));
  await rm(hold); const rejected = await pending; assert.equal(rejected.error.code, 'ROLE_DENIED');
  assert.deepEqual({ label: (await f.probe(f.staging)).label, value: (await f.probe(f.staging)).value }, { label: 'v1', value: 'retained-target' });
  const database = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data', 'app.sqlite'));
  try { assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='newer'").get().n, 0); }
  finally { database.close(); }
  const history = await f.call(f.path('staging') + '/promotions'); assert.equal(history.promotions[0].state, 'failed');
});

test('real controller SIGKILL after migration fences startup and requires verified explicit recovery before another writer', { timeout: 60000 }, async t => {
  const f = await fixture(t, true), v1 = await f.artifact('v1');
  await f.upload(f.development, v1, 'source_crash_initial');
  const target = await f.upload(f.staging, v1, 'target_crash_initial'); await f.probe(f.staging, '/write/prior-target');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='candidate-only'; CREATE TABLE newer(id INTEGER PRIMARY KEY);");
  const source = await f.upload(f.development, v2, 'source_crash_candidate');
  const hold = join(f.root, 'hold'), entered = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: entered } }, 200, 'PUT');
  const input = f.promotion(source, v2, target.id, 'controller_crash_request');
  const pending = f.call(f.path('staging') + '/promotions', input, 201); pending.catch(() => {});
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(entered); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'actual candidate did not enter health checking'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.killAndRestart(); await assert.rejects(pending, /controller stopped/); await rm(hold);
  const databasePath = join(f.options.dataDirectory, 'projects', f.staging.id, 'data', 'app.sqlite');
  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(migrated.prepare('SELECT value FROM sample').get().value, 'candidate-only'); }
  finally { migrated.close(); }
  await f.probe(f.staging, '', 503);
  const blockedUpload = await f.upload(f.staging, v1, 'blocked_crash_upload', 409);
  assert.equal(blockedUpload, undefined);
  const retry = await f.call(f.path('staging') + '/promotions', input, 409); assert.equal(retry.error.code, 'PROMOTION_RECOVERY_REQUIRED');
  const newKey = await f.call(f.path('staging') + '/promotions', { ...input, idempotencyKey: 'controller_bypass_attempt' }, 409);
  assert.equal(newKey.error.code, 'PROMOTION_RECOVERY_REQUIRED');
  const recoveryPath = f.path('staging') + `/promotions/${input.idempotencyKey}/recover`;
  const confirmation = `recover-promotion ${f.staging.slug} ${input.idempotencyKey}`;
  const recovered = await f.call(recoveryPath, { confirmation }); assert.equal(recovered.promotion.state, 'failed');
  const stable = await f.probe(f.staging); assert.equal(stable.label, 'v1'); assert.equal(stable.value, 'prior-target');
  const restored = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(restored.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='newer'").get().n, 0); }
  finally { restored.close(); }
  const repeated = await f.call(recoveryPath, { confirmation }); assert.deepEqual(repeated.promotion, recovered.promotion);
  const next = await f.call(f.path('staging') + '/promotions', { ...input, idempotencyKey: 'controller_recovered_next' }, 201);
  assert.equal(next.promotion.state, 'accepted'); assert.equal((await f.probe(f.staging)).value, 'candidate-only');
});

test('actual environment CLI promotes without rebuilding and preserves explicit state and request identity', { timeout: 45000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), source = await f.upload(f.development, artifact, 'cli_environment_source');
  const server = await f.serve();
  const started = await f.call('/api/device/start', { clientName: 'environment CLI acceptance' }, 201);
  await f.call('/api/device/approve', { code: started.userCode });
  const token = await f.call('/api/device/token', { deviceCode: started.deviceCode });
  const home = join(f.root, 'cli-home'); await mkdir(home); await mkdir(join(f.root, '.clank'));
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, current: server, profiles: { [server]: { token: token.accessToken, expiresAt: token.expiresAt } } }), { mode: 0o600 });
  await writeFile(join(f.root, '.clank/project.json'), JSON.stringify({ version: 1, server, projectId: f.development.id }), { mode: 0o600 });
  const cli = new URL('../scripts/clank.mjs', import.meta.url).pathname;
  const run = async args => {
    const result = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'environment', ...args, '--json'], { cwd: f.root, env: { ...process.env, CLANK_HOME: home }, timeout: 30000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const list = await run(['list']); assert.equal(list.environments.length, 3);
  await assert.rejects(run(['list', '--digest', artifact.digest]), /does not apply to environment list/);
  const promotionArgs = ['promote', 'staging', '--from', 'development', '--release', source.id, '--digest', artifact.digest,
    '--expected-version', '1', '--expected-active', 'none', '--key', 'cli_exact_promotion_01'];
  const promoted = await run(promotionArgs); assert.equal(promoted.release.digest, artifact.digest); assert.equal(promoted.promotion.state, 'accepted');
  const replay = await run(promotionArgs); assert.equal(replay.release.id, promoted.release.id);
  const history = await run(['history', 'staging']); assert.equal(history.promotions.length, 1);
  const policy = await run(['bind', 'staging', f.staging.id, '--expected-version', '1', '--migration-policy', 'code-only']); assert.equal(policy.environment.version, 2);
  await assert.rejects(run(promotionArgs), error => JSON.parse(error.stderr).error.code === 'ENVIRONMENT_VERSION_STALE');
  await assert.rejects(run(['promote', 'staging', '--from', 'development']), /Pass --expected-active explicitly/);
  const unbound = await run(['unbind', 'staging', '--expected-version', '2']); assert.equal(unbound.environment.projectId, null);
  // This directory contains no package.json or build script. Promotion succeeds
  // using the retained upload through the real CLI, HTTP server and platform.
});


test('migration safety copy preserves the final write from the quiesced prior runtime', { timeout: 45000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1', '', {}, 'last-accepted-write');
  const target = await f.upload(f.staging, v1, 'target_final_write');
  await f.probe(f.staging, '/write/before-shutdown');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='failed-candidate';");
  const source = await f.upload(f.development, v2, 'source_final_write');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { FAIL_HEALTH: '1' } }, 200, 'PUT');
  await f.call(f.path('staging') + '/promotions', f.promotion(source, v2, target.id, 'final_write_promotion'), 422);
  assert.equal((await f.probe(f.staging)).label, 'v1');
  assert.equal((await f.probe(f.staging)).value, 'last-accepted-write');
});
