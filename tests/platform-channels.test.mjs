import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures/platform-environment-fixture.mjs';

const path = (f, name = 'stable') => `/api/projects/${f.development.id}/channels/${name}`;
const pin = (release, artifact, expectedVersion = 0) => ({ sourceEnvironment: 'development', releaseId: release.id, digest: artifact.digest, expectedVersion });
const activation = (expectedVersion, expectedActiveReleaseId = null, idempotencyKey = 'channel_exact_action_01') => ({
  targetEnvironment: 'staging', expectedVersion, expectedEnvironmentVersion: 1, expectedActiveReleaseId, idempotencyKey,
});
async function entered(file) {
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'The actual runtime must enter candidate health checking.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('channel promotion preserves exact bytes and rollback appends history only after actual activation', { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'), first = await f.upload(f.development, v1, 'channel_first_source_01');
  assert.equal((await f.call(path(f), pin(first, v1), 200, 'PUT')).channel.version, 1);
  const request = activation(1), promoted = await f.call(path(f) + '/promote', request, 201);
  assert.equal(promoted.action.appliedVersion, 1);
  assert.deepEqual(await readFile(join(f.options.dataDirectory, 'projects', f.staging.id, 'artifacts', `${promoted.release.id}.clank.gz`)), v1.bytes);
  await f.probe(f.staging, '/write/target-only');
  const v2 = await f.artifact('v2'), second = await f.upload(f.development, v2, 'channel_second_source_01');
  await f.call(path(f), pin(second, v2, 1), 200, 'PUT');
  const upgraded = await f.call(path(f) + '/promote', activation(2, promoted.release.id, 'channel_upgrade_action_01'), 201);
  assert.equal((await f.probe(f.staging)).label, 'v2');
  const before = (await f.call(path(f) + '/history')).entries;
  const rollbackRequest = { ...activation(2, upgraded.release.id, 'channel_rollback_action_01'), fromVersion: 1 };
  const rolledBack = await f.call(path(f) + '/rollback', rollbackRequest, 201);
  assert.equal(rolledBack.action.appliedVersion, 3);
  assert.deepEqual({ label: (await f.probe(f.staging)).label, value: (await f.probe(f.staging)).value }, { label: 'v1', value: 'target-only' });
  const channel = (await f.call(path(f))).channel;
  assert.equal(channel.version, 3); assert.equal(channel.current.sourceReleaseId, first.id);
  const after = (await f.call(path(f) + '/history')).entries;
  assert.equal(after.length, 3); assert.deepEqual(after.slice(1), before);
  await f.restart();
  assert.equal((await f.call(path(f) + '/rollback', rollbackRequest, 201)).release.id, rolledBack.release.id);
  assert.equal((await f.call(path(f) + '/promote', request, 201)).release.id, promoted.release.id);
  assert.equal((await f.probe(f.staging)).label, 'v1', 'An old accepted response must not reactivate its former target.');
  assert.equal((await f.call(path(f) + '/history')).entries.length, 3);
  const changed = await f.call(path(f) + '/promote', { ...request, targetEnvironment: 'production' }, 409);
  assert.equal(changed.error.code, 'CHANNEL_RETRY_CHANGED');
});

test('channel CAS, retained pins and retirement tombstones prevent deletion and stale retries', { timeout: 45000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'), first = await f.upload(f.development, v1, 'channel_pin_source_01');
  await f.call(path(f), pin(first, v1), 200, 'PUT');
  const stale = await f.call(path(f), pin(first, v1), 409, 'PUT'); assert.equal(stale.error.code, 'CHANNEL_VERSION_STALE');
  const v2 = await f.artifact('v2'), second = await f.upload(f.development, v2, 'channel_pin_source_02');
  await f.call(path(f), pin(second, v2, 1), 200, 'PUT');
  const releases = (await f.call(`/api/projects/${f.development.id}/releases`)).releases;
  assert.equal(releases.find(row => row.id === first.id).cleanup.channelPinned, true);
  assert.equal(releases.find(row => row.id === first.id).cleanup.allowed, false);
  const cleanup = { confirmation: `delete-release development ${first.id}`, allowRollbackLoss: true };
  const blocked = await f.call(`/api/projects/${f.development.id}/releases/${first.id}`, cleanup, 409, 'DELETE');
  assert.equal(blocked.error.code, 'RELEASE_CHANNEL_PINNED');
  for (const name of ['development', 'staging', 'production']) await f.call(f.path(name), { expectedVersion: 1 }, 200, 'DELETE');
  const deletion = await f.call(`/api/projects/${f.development.id}`, { confirmation: 'delete-site development', acknowledgeDataLoss: true }, 409, 'DELETE');
  assert.equal(deletion.error.code, 'PROJECT_CHANNEL_PINNED');
  const retirement = { expectedVersion: 2, confirmation: 'retire-channel development stable' };
  const retired = (await f.call(path(f), retirement, 200, 'DELETE')).channel;
  assert.equal(retired.version, 3); assert.equal(retired.current, null);
  assert.equal((await f.call(path(f) + '/history')).entries.length, 0);
  assert.equal((await f.call(path(f), retirement, 200, 'DELETE')).channel.version, 3);
  const storage = await readFile(join(f.options.dataDirectory, 'projects', f.development.id, 'artifacts', `${first.id}.clank.gz`));
  assert.deepEqual(storage, v1.bytes, 'Retirement removes channel metadata and leaves the upload intact.');
  await f.bind('development', f.development, 2);
  await f.call(path(f), pin(second, v2, 3), 200, 'PUT');
  assert.equal((await f.call(path(f), retirement, 409, 'DELETE')).error.code, 'CHANNEL_VERSION_STALE');
  assert.equal((await f.call(path(f), pin(first, v1, 2), 409, 'PUT')).error.code, 'CHANNEL_VERSION_STALE');
  await f.call(`/api/projects/${f.development.id}/releases/${first.id}`, cleanup, 200, 'DELETE');
});

test('failed channel rollback preserves the current pin and the target database', { timeout: 45000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v2'), first = await f.upload(f.development, v1, 'channel_failure_source_01');
  await f.call(path(f), pin(first, v1), 200, 'PUT');
  const promoted = await f.call(path(f) + '/promote', activation(1), 201);
  await f.probe(f.staging, '/write/prior-target');
  const v2 = await f.artifact('v3'), second = await f.upload(f.development, v2, 'channel_failure_source_02');
  await f.call(path(f), pin(second, v2, 1), 200, 'PUT');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { FAIL_HEALTH: '1' } }, 200, 'PUT');
  const request = { ...activation(2, promoted.release.id, 'channel_failed_rollback_01'), fromVersion: 1 };
  assert.equal((await f.call(path(f) + '/rollback', request, 422)).error.code, 'DEPLOYMENT_FAILED');
  assert.equal((await f.call(path(f))).channel.version, 2);
  assert.equal((await f.call(path(f) + '/history')).entries.length, 2);
  assert.equal((await f.call(path(f) + '/actions')).actions[0].state, 'failed');
  assert.equal((await f.call(path(f) + '/rollback', request, 409)).error.code, 'PROMOTION_FAILED');
  assert.equal((await f.probe(f.staging)).value, 'prior-target');
});

test('controller interruption fences channel mutation until verified recovery without advancing the pin', { timeout: 60000 }, async t => {
  const f = await fixture(t, true), v1 = await f.artifact('v1'), first = await f.upload(f.development, v1, 'channel_crash_source_01');
  const target = await f.upload(f.staging, v1, 'channel_crash_target_01'); await f.probe(f.staging, '/write/prior-target');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='candidate-only'; CREATE TABLE newer(id INTEGER PRIMARY KEY);"), second = await f.upload(f.development, v2, 'channel_crash_source_02');
  await f.call(path(f), pin(second, v2), 200, 'PUT');
  const v3 = await f.artifact('v3', "UPDATE sample SET value='candidate-only'; CREATE TABLE newer(id INTEGER PRIMARY KEY);"), third = await f.upload(f.development, v3, 'channel_crash_source_03');
  await f.call(path(f), pin(third, v3, 1), 200, 'PUT');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const pending = f.call(path(f) + '/rollback', { ...activation(2, target.id, 'channel_crash_action_01'), fromVersion: 1 }, 201); pending.catch(() => {});
  await entered(barrier); await f.killAndRestart(); await assert.rejects(pending, /controller stopped/); await rm(hold);
  assert.equal((await f.call(path(f), pin(first, v1, 2), 409, 'PUT')).error.code, 'CHANNEL_ACTIVATION_PENDING');
  assert.equal((await f.call(path(f), { expectedVersion: 2, confirmation: 'retire-channel development stable' }, 409, 'DELETE')).error.code, 'CHANNEL_ACTIVATION_PENDING');
  assert.equal((await f.call(path(f))).channel.version, 2);
  await f.probe(f.staging, '', 503);
  // Fill only a separate channel's valid retained history. The interrupted
  // rollback must reserve the one remaining family slot across restart.
  const inventory = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite'));
  try {
    inventory.exec('BEGIN');
    inventory.prepare('INSERT INTO clank_platform_release_channels(root_id,name,current_version,retired,updated_at) VALUES(?,\'beta\',997,0,?)').run(f.development.id, Date.now());
    const insert = inventory.prepare('INSERT INTO clank_platform_channel_entries(root_id,name,version,source_name,source_project_id,source_release_id,artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?)');
    for (let version = 1; version <= 997; version++) insert.run(f.development.id, 'beta', version, 'development', f.development.id, first.id, v1.digest, Date.now());
    inventory.exec('COMMIT');
  } finally { inventory.close(); }
  assert.equal((await f.call(path(f, 'gamma'), pin(first, v1), 409, 'PUT')).error.code, 'CHANNEL_HISTORY_CAPACITY');

  const history = (await f.call(f.path('staging') + '/promotions')).promotions, receipt = history[0];
  await f.call(f.path('staging') + `/promotions/${receipt.idempotencyKey}/recover`, { confirmation: `recover-promotion staging ${receipt.idempotencyKey}` }, 200);
  assert.equal((await f.probe(f.staging)).value, 'prior-target');
  assert.equal((await f.call(path(f) + '/actions')).actions[0].state, 'failed');
  assert.equal((await f.call(path(f, 'gamma'), pin(first, v1), 200, 'PUT')).channel.version, 1);
  await f.call(path(f, 'beta'), { expectedVersion: 997, confirmation: 'retire-channel development beta' }, 200, 'DELETE');
  assert.equal((await f.call(path(f), pin(first, v1, 2), 200, 'PUT')).channel.version, 3);
  const database = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data', 'app.sqlite'));
  try { assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='newer'").get().n, 0); }
  finally { database.close(); }
});

for (const boundary of ['source', 'target']) test(`revoked ${boundary} access during channel rollback restores the prior runtime and never publishes a new pin`, { timeout: 45000 }, async t => {
  const f = await fixture(t), oldArtifact = await f.artifact('v2'), oldRelease = await f.upload(f.development, oldArtifact, 'channel_revocation_old_01');
  await f.call(path(f), pin(oldRelease, oldArtifact), 200, 'PUT');
  const currentArtifact = await f.artifact('v3'), currentRelease = await f.upload(f.development, currentArtifact, 'channel_revocation_new_01');
  await f.call(path(f), pin(currentRelease, currentArtifact, 1), 200, 'PUT');
  const target = await f.upload(f.staging, currentArtifact, 'channel_revocation_target_01'); await f.probe(f.staging, '/write/retained-target');
  const developer = await f.account(`channel-${boundary}@example.test`), control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite'));
  t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(f.development.organizationId, developer.user.id, 'developer', Date.now(), Date.now());
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const request = { ...activation(2, target.id, `channel_revoke_${boundary}_01`), fromVersion: 1 };
  const pending = f.call(path(f) + '/rollback', request, 403, 'POST', developer); pending.catch(() => {});
  try {
    await entered(barrier);
    control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)')
      .run(boundary === 'source' ? f.development.id : f.staging.id, developer.user.id, JSON.stringify(boundary === 'source' ? ['deploy'] : ['read']));
    await rm(hold); assert.equal((await pending).error.code, 'ROLE_DENIED');
    assert.equal((await f.call(path(f))).channel.version, 2);
    assert.equal((await f.call(path(f) + '/history')).entries.length, 2);
    assert.deepEqual({ label: (await f.probe(f.staging)).label, value: (await f.probe(f.staging)).value }, { label: 'v3', value: 'retained-target' });
    if (boundary === 'source') assert.equal((await f.call(path(f) + '/history/1', undefined, 403, 'GET', developer)).error.code, 'ROLE_DENIED');
    else {
      assert.equal((await f.call(path(f) + '/actions', undefined, 200, 'GET', developer)).actions[0].state, 'failed', 'Target read permission still permits observing the failed action.');
      control.prepare('UPDATE clank_platform_project_members SET permissions=? WHERE project_id=? AND user_id=?')
        .run('[]', f.staging.id, developer.user.id);
      assert.equal((await f.call(path(f) + '/actions', undefined, 200, 'GET', developer)).actions.length, 0);
    }
  } finally { await rm(hold, { force: true }); }
});

test('actual channel CLI pins, promotes, rolls back, inspects exact history and retires without rebuilding', { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'), first = await f.upload(f.development, v1, 'channel_cli_source_01');
  const server = await f.serve(), started = await f.call('/api/device/start', { clientName: 'Release channel CLI acceptance' }, 201);
  await f.call('/api/device/approve', { code: started.userCode });
  const token = await f.call('/api/device/token', { deviceCode: started.deviceCode }), home = join(f.root, 'cli-home');
  await mkdir(home); await mkdir(join(f.root, '.clank'));
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, current: server, profiles: { [server]: { token: token.accessToken, expiresAt: token.expiresAt } } }), { mode: 0o600 });
  await writeFile(join(f.root, '.clank/project.json'), JSON.stringify({ version: 1, server, projectId: f.development.id }), { mode: 0o600 });
  const cli = new URL('../scripts/clank.mjs', import.meta.url).pathname;
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'channel', ...args, '--json'], {
    cwd: f.root, env: { ...process.env, CLANK_HOME: home }, timeout: 30000, maxBuffer: 1024 * 1024,
  })).stdout);
  assert.equal((await run(['list'])).channels.length, 0);
  await assert.rejects(run(['list', '--digest', v1.digest]), /does not apply to channel list/);
  await run(['pin', 'stable', '--from', 'development', '--release', first.id, '--digest', v1.digest, '--expected-version', '0']);
  const args = ['promote', 'stable', '--to', 'staging', '--expected-version', '1', '--environment-version', '1', '--expected-active', 'none', '--key', 'channel_cli_promote_01'];
  const promoted = await run(args); assert.equal(promoted.release.digest, v1.digest);
  assert.equal((await run(args)).release.id, promoted.release.id);
  const v2 = await f.artifact('v2'), second = await f.upload(f.development, v2, 'channel_cli_source_02');
  await run(['pin', 'stable', '--from', 'development', '--release', second.id, '--digest', v2.digest, '--expected-version', '1']);
  const rollback = await run(['rollback', 'stable', '--to', 'staging', '--expected-version', '2', '--environment-version', '1', '--expected-active', promoted.release.id, '--from-version', '1', '--key', 'channel_cli_rollback_01']);
  assert.equal(rollback.action.appliedVersion, 3); assert.equal((await run(['get', 'stable'])).channel.current.sourceReleaseId, first.id);
  assert.equal((await run(['history', 'stable'])).entries.length, 3);
  assert.equal((await run(['history', 'stable', '--version', '1'])).entry.digest, v1.digest);
  assert.equal((await run(['actions', 'stable'])).actions.length, 2);
  await assert.rejects(run(['promote', 'stable', '--to', 'staging']), /Pass --expected-active explicitly/);
  await assert.rejects(run(['pin', 'stable', '--from', 'development', '--release', first.id, '--digest', v1.digest, '--expected-version', '01']), /Pass an exact --expected-version/);
  await run(['retire', 'stable', '--expected-version', '3', '--confirm', 'retire-channel development stable']);
  assert.equal((await run(['get', 'stable'])).channel.current, null);
  assert.deepEqual(await readFile(join(f.options.dataDirectory, 'projects', f.development.id, 'artifacts', `${first.id}.clank.gz`)), v1.bytes);
});

test('bounded channel inventory and exact old-entry reads preserve identity outside the newest history page', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), release = await f.upload(f.development, artifact, 'channel_capacity_source_01');
  await f.call(path(f), pin(release, artifact), 200, 'PUT');
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  const entry = control.prepare('SELECT * FROM clank_platform_channel_entries WHERE root_id=? AND name=? AND version=1').get(f.development.id, 'stable');
  const insert = control.prepare(`INSERT INTO clank_platform_channel_entries(root_id,name,version,source_name,source_project_id,source_release_id,artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  control.exec('BEGIN');
  try {
    for (let version = 2; version <= 1000; version++) insert.run(entry.root_id, entry.name, version, entry.source_name, entry.source_project_id, entry.source_release_id, entry.artifact_digest, entry.created_at);
    control.prepare('UPDATE clank_platform_release_channels SET current_version=1000 WHERE root_id=? AND name=?').run(f.development.id, 'stable');
    control.exec('COMMIT');
  } catch (error) { control.exec('ROLLBACK'); throw error; }
  assert.equal((await f.call(path(f) + '/history')).entries.length, 100);
  assert.equal((await f.call(path(f) + '/history')).entries.at(-1).version, 901);
  const original = (await f.call(path(f) + '/history/1')).entry;
  assert.equal(original.digest, artifact.digest); assert.equal(original.sourceReleaseId, release.id);
  assert.equal((await f.call(path(f), pin(release, artifact, 1000), 409, 'PUT')).error.code, 'CHANNEL_HISTORY_CAPACITY');
  assert.equal((await f.call(path(f, 'beta'), pin(release, artifact), 409, 'PUT')).error.code, 'CHANNEL_HISTORY_CAPACITY');
  assert.equal((await f.call(path(f) + '/history/9007199254740992', undefined, 404)).error.code, 'CHANNEL_ENTRY_NOT_FOUND');
  await f.call(path(f), { expectedVersion: 1000, confirmation: 'retire-channel development stable' }, 200, 'DELETE');
  const names = control.prepare('INSERT INTO clank_platform_release_channels(root_id,name,current_version,retired,updated_at) VALUES(?,?,1,1,?)');
  for (let index = 1; index < 100; index++) names.run(f.development.id, 'retained-' + index, Date.now());
  assert.equal((await f.call(`/api/projects/${f.development.id}/channels`)).channels.length, 100);
  assert.equal((await f.call(path(f, 'beta'), pin(release, artifact), 409, 'PUT')).error.code, 'CHANNEL_CAPACITY');
  assert.equal((await f.call(path(f), pin(release, artifact, 1001), 200, 'PUT')).channel.version, 1002);
});

test('only current administrators may retire channel history and confirmation remains exact', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), release = await f.upload(f.development, artifact, 'channel_retire_authority_01');
  await f.call(path(f), pin(release, artifact), 200, 'PUT');
  const developer = await f.account('channel-retire-developer@example.test'), control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite'));
  t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(f.development.organizationId, developer.user.id, 'developer', Date.now(), Date.now());
  const request = { expectedVersion: 1, confirmation: 'retire-channel development stable' };
  assert.equal((await f.call(path(f), request, 403, 'DELETE', developer)).error.code, 'ROLE_DENIED');
  assert.equal((await f.call(path(f) + '/promote', { ...activation(1), targetEnvironment: 'production' }, 403, 'POST', developer)).error.code, 'PRODUCTION_ROLE_REQUIRED');
  assert.equal((await f.call(path(f), { ...request, confirmation: 'stable' }, 400, 'DELETE')).error.code, 'CONFIRMATION_REQUIRED');
  await f.restart();
  assert.equal((await f.call(path(f))).channel.version, 1);
});


test('channel retirement obeys the configured fresh passkey or MFA policy', { timeout: 30000 }, async t => {
  const f = await fixture(t, false, { freshAuthentication: { required: true } }), artifact = await f.artifact('v1');
  const release = await f.upload(f.development, artifact, 'channel_fresh_auth_source_01');
  await f.call(path(f), pin(release, artifact), 200, 'PUT');
  const request = { expectedVersion: 1, confirmation: 'retire-channel development stable' };
  assert.equal((await f.call(path(f), request, 403, 'DELETE')).error.code, 'FRESH_AUTH_REQUIRED');
  assert.equal((await f.call(path(f))).channel.version, 1);
  assert.equal((await f.call(path(f) + '/history')).entries.length, 1);
});

test('concurrent channel pins admit one immutable entry and reject the stale writer', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), release = await f.upload(f.development, artifact, 'channel_concurrent_source_01');
  const [accepted, rejected] = await Promise.all([
    f.call(path(f), pin(release, artifact), 200, 'PUT'),
    f.call(path(f), pin(release, artifact), 409, 'PUT'),
  ]);
  assert.equal(accepted.channel.version, 1); assert.equal(rejected.error.code, 'CHANNEL_VERSION_STALE');
  assert.equal((await f.call(path(f) + '/history')).entries.length, 1);
  await f.restart();
  assert.equal((await f.call(path(f))).channel.current.sourceReleaseId, release.id);
});

test('channel actions cannot reinterpret a historical source after its environment is rebound', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1'), release = await f.upload(f.development, artifact, 'channel_rebind_source_01');
  await f.call(path(f), pin(release, artifact), 200, 'PUT');
  const request = activation(1), result = await f.call(path(f) + '/promote', request, 201);
  const replacement = (await f.call('/api/projects', { name: 'replacement', slug: 'replacement' }, 201)).project;
  await f.call(f.path('development'), { expectedVersion: 1 }, 200, 'DELETE');
  await f.bind('development', replacement, 2);
  assert.equal((await f.call(path(f) + '/promote', request, 409)).error.code, 'CHANNEL_SOURCE_CHANGED');
  assert.equal((await f.call(path(f) + '/promote', { ...activation(1, result.release.id, 'channel_rebound_new_01') }, 409)).error.code, 'CHANNEL_SOURCE_CHANGED');
  assert.equal((await f.call(path(f))).channel.current.sourceReleaseId, release.id);
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, result.release.id);
});
