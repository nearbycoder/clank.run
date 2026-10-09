import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures/platform-environment-fixture.mjs';
import { createDeploymentBundle, parseDeploymentConfig } from '../dist/deploy.js';
import { deploymentDigest } from '../dist/deploy.js';
const path = (f, project = f.staging) => `/api/projects/${project.id}/dependencies`;
const configuration = (requirements, expectedVersion = 0, timeoutMs = 5000, overridePolicy = 'deny') => ({ expectedVersion, requirements, timeoutMs, overridePolicy });
async function serviceArtifact(f, label) {
  await f.artifact(label);
  await writeFile(join(f.root, label, 'dist/server.mjs'), await readFile(new URL('./fixtures/platform-dependency-application.mjs', import.meta.url)));
  const bytes = await createDeploymentBundle(join(f.root, label), parseDeploymentConfig({ version: 1, entry: 'dist/server.mjs', include: ['dist','migrations'], database: { path: 'app.sqlite', migrations: 'migrations' }, health: { path: '/healthz', timeoutMs: 5000 }, env: {} }));
  return { bytes, digest: await deploymentDigest(bytes) };
}
async function entered(file) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await readFile(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'The real service health request must start.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('dependency configuration is bounded, versioned and persistent; referenced services cannot be deleted', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call(path(f))).configuration, { version: 0, requirements: [], timeoutMs: 5000, overridePolicy: 'deny', updatedAt: null });
  const request = configuration([{ projectId: f.development.id, readiness: 'active' }]);
  const first = (await f.call(path(f), request, 200, 'PUT')).configuration;
  assert.equal(first.version, 1); assert.deepEqual(first.requirements, request.requirements);
  assert.equal((await f.call(path(f), request, 409, 'PUT')).error.code, 'DEPENDENCY_VERSION_STALE');
  assert.equal((await f.call(path(f) + '/check', { expectedVersion: 0 }, 409)).error.code, 'DEPENDENCY_VERSION_STALE');
  const check = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  assert.equal(check.ready, false); assert.equal(check.observations[0].reason, 'inactive');
  await f.restart(); assert.deepEqual((await f.call(path(f))).configuration, first);
  assert.equal((await f.call(path(f) + '/checks')).checks.length, 1);
  for (const name of ['development', 'staging', 'production']) await f.call(f.path(name), { expectedVersion: 1 }, 200, 'DELETE');
  assert.equal((await f.call(`/api/projects/${f.development.id}`, { confirmation: 'delete-site development', acknowledgeDataLoss: true }, 409, 'DELETE')).error.code, 'PROJECT_DEPENDENCY_REQUIRED');
  await f.call(path(f), configuration([], 1), 200, 'PUT');
  assert.equal((await f.call(`/api/projects/${f.development.id}`, { confirmation: 'delete-site development', acknowledgeDataLoss: true }, 200, 'DELETE')).ok, true);
});
test('dependency graph rejects cycles, self references, duplicate services, arbitrary URLs and excessive checks', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active' }]), 200, 'PUT');
  assert.equal((await f.call(path(f, f.development), configuration([{ projectId: f.staging.id, readiness: 'active' }]), 409, 'PUT')).error.code, 'DEPENDENCY_CYCLE');
  assert.equal((await f.call(path(f), configuration([{ projectId: f.staging.id, readiness: 'healthy' }], 1), 409, 'PUT')).error.code, 'DEPENDENCY_WORKSPACE_CHANGED');
  for (const requirements of [Array(17).fill({ projectId: f.development.id, readiness: 'healthy' }), [{ projectId: f.development.id, readiness: 'active' }, { projectId: f.development.id, readiness: 'healthy' }], [{ projectId: f.development.id, readiness: 'healthy', url: 'http://127.0.0.1/private' }]]) await f.call(path(f), configuration(requirements, 1), 422, 'PUT');
  for (const timeout of [0, 99, 10001, 1.5, Number.MAX_SAFE_INTEGER + 1]) await f.call(path(f), configuration([], 1, timeout), 422, 'PUT');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active', digest: 'a'.repeat(64) }], 1), 200, 'PUT');
});
test('real dependency health checks bind exact uploads and reject redirects without recording application payloads', { timeout: 45000 }, async t => {
  const f = await fixture(t), file = join(f.root, 'health-policy.json');
  await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: file } }, 200, 'PUT');
  const artifact = await serviceArtifact(f, 'service'), release = await f.upload(f.development, artifact, 'dependency_service_health_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy', digest: artifact.digest }]), 200, 'PUT');
  const check = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  assert.equal(check.ready, true); assert.equal(check.observations[0].releaseId, release.id); assert.equal(check.observations[0].digest, artifact.digest); assert.ok(check.observations[0].activationSequence > 0);
  let redirected = 0; const forbidden = createServer((request, response) => { redirected++; response.end('forbidden'); });
  await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => forbidden.close(resolve)));
  await writeFile(file, JSON.stringify({ redirect: `http://127.0.0.1:${forbidden.address().port}/private` }));
  assert.equal((await f.call(path(f) + '/check', { expectedVersion: 1 })).check.observations[0].reason, 'health-failed'); assert.equal(redirected, 0);
  assert.ok(!JSON.stringify((await f.call(path(f) + '/checks')).checks).includes('private-application-health-payload'));
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active', digest: 'a'.repeat(64) }], 1), 200, 'PUT');
  assert.equal((await f.call(path(f) + '/check', { expectedVersion: 2 })).check.observations[0].reason, 'digest-mismatch');
});
test('real dependency timeout is bounded and read revocation during a held check fails closed', { timeout: 45000 }, async t => {
  const f = await fixture(t), file = join(f.root, 'health-policy.json'), hold = join(f.root, 'hold'), barrier = join(f.root, 'entered');
  await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: file } }, 200, 'PUT');
  const artifact = await serviceArtifact(f, 'service'); await f.upload(f.development, artifact, 'dependency_service_timeout_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }], 0, 100), 200, 'PUT');
  await writeFile(hold, 'hold'); await writeFile(file, JSON.stringify({ hold, entered: barrier }));
  const started = Date.now(), timed = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  assert.equal(timed.ready, false); assert.equal(timed.observations[0].reason, 'health-timeout'); assert.ok(Date.now() - started < 2000);
  await rm(hold); await rm(barrier);
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }], 1, 5000), 200, 'PUT');
  const developer = await f.account('dependency-reader@example.test'), control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.staging.organizationId, developer.user.id, 'developer', Date.now(), Date.now());
  await writeFile(hold, 'hold'); const pending = f.call(path(f) + '/check', { expectedVersion: 2 }, 403, 'POST', developer); pending.catch(() => {});
  try {
    await entered(barrier);
    control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)').run(f.development.id, developer.user.id, '["deploy"]');
    await rm(hold); assert.equal((await pending).error.code, 'DEPENDENCY_ACCESS_REQUIRED');
    assert.equal((await f.call(path(f), undefined, 403, 'GET', developer)).error.code, 'DEPENDENCY_ACCESS_REQUIRED');
    assert.equal((await f.call(path(f) + '/checks', undefined, 200, 'GET', developer)).checks.length, 0);
  } finally { await rm(hold, { force: true }); }
});

test('gated ordinary uploads preserve target data, publish one receipt and do not reactivate accepted retries', { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'); await f.upload(f.development, v1, 'dependency_deploy_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy', digest: v1.digest }]), 200, 'PUT');
  const first = await f.upload(f.staging, v1, 'dependency_deploy_target_01'); await f.probe(f.staging, '/write/target-only');
  const v2 = await f.artifact('v3'), second = await f.upload(f.staging, v2, 'dependency_deploy_target_02');
  await f.restart(); assert.equal((await f.upload(f.staging, v1, 'dependency_deploy_target_01')).id, first.id);
  const current = (await f.call(`/api/projects/${f.staging.id}`)).project;
  assert.equal(current.activeReleaseId, second.id); assert.equal((await f.probe(f.staging)).label, 'v3'); assert.equal((await f.probe(f.staging)).value, 'target-only');
  const activations = (await f.call(path(f) + '/activations')).activations;
  assert.equal(activations.length, 2); assert.ok(activations.every(row => row.state === 'accepted' && row.check.ready && !row.check.overridden));
  assert.equal(activations.find(row => row.candidateReleaseId === first.id).check.observations[0].digest, v1.digest);
});

for (const boundary of ['service','configuration']) test(`a ${boundary} change during actual candidate health blocks publication and restores the prior target`, { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'); await f.upload(f.development, v1, `dependency_${boundary}_service_01`);
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, v1, `dependency_${boundary}_target_01`); await f.probe(f.staging, '/write/prior-target');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='unaccepted-candidate'; CREATE TABLE candidate_only(id INTEGER PRIMARY KEY);");
  const pending = f.upload(f.staging, v2, `dependency_${boundary}_held_target_01`, 409); pending.catch(() => {});
  try {
    await entered(barrier);
    if (boundary === 'service') { const changed = await f.artifact('changed-service'); await f.upload(f.development, changed, 'dependency_changed_service_02'); }
    else await f.call(path(f), configuration([], 1), 200, 'PUT');
    await rm(hold); await pending;
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, first.id);
    assert.equal((await f.probe(f.staging)).label, 'v1'); assert.equal((await f.probe(f.staging)).value, 'prior-target');
    const db = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data/app.sqlite'));
    try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(), undefined); } finally { db.close(); }
    const activations = (await f.call(path(f) + '/activations')).activations;
    assert.equal(activations.find(row => row.state === 'failed').check.version, 1);
  } finally { await rm(hold, { force: true }); }
});

test('an unready service blocks new artifact staging and denied overrides cannot bypass policy', { timeout: 30000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active' }]), 200, 'PUT');
  await f.upload(f.staging, artifact, 'dependency_unready_target_01', 409);
  assert.equal((await f.call(`/api/projects/${f.staging.id}/releases`)).releases.length, 0);
  const check = (await f.call(path(f) + '/checks')).checks[0]; assert.equal(check.ready, false); assert.equal(check.observations[0].reason, 'inactive');
  await f.upload(f.staging, artifact, 'dependency_denied_override_01', 403, { headers: { 'x-clank-dependency-override': JSON.stringify({ expectedVersion: 1, reason: 'Approved maintenance operation', confirmation: 'override-dependencies staging 1' }) } });
});

for (const boundary of ['release status', 'runtime policy']) test(`a ${boundary} change during the final real dependency health response prevents acceptance`, { timeout: 60000 }, async t => {
  const f = await fixture(t), policy = join(f.root, 'service-health.json');
  await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: policy } }, 200, 'PUT');
  const service = await f.upload(f.development, await serviceArtifact(f, 'service'), 'dependency_runtime_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, await f.artifact('v1'), 'dependency_runtime_target_01');
  await f.probe(f.staging, '/write/prior-target');
  const candidateHold = join(f.root, 'candidate-hold'), candidateEntered = join(f.root, 'candidate-entered');
  const serviceHold = join(f.root, 'service-hold'), serviceEntered = join(f.root, 'service-entered');
  await writeFile(candidateHold, 'hold');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: candidateHold, HEALTH_ENTERED: candidateEntered } }, 200, 'PUT');
  const candidate = await f.artifact('v2', "UPDATE sample SET value='unaccepted'; CREATE TABLE candidate_only(id INTEGER PRIMARY KEY);");
  const pending = f.upload(f.staging, candidate, 'dependency_runtime_held_target_01', 409); pending.catch(() => {});
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  try {
    await entered(candidateEntered);
    await writeFile(serviceHold, 'hold'); await writeFile(policy, JSON.stringify({ hold: serviceHold, entered: serviceEntered, status: 200, waitOnCall: 2, countFile: join(f.root, 'service-count') }));
    await rm(candidateHold); await entered(serviceEntered);
    // Change owned controller state while the application's actual HTTP 200 is pending,
    // without replacing the accepted release, generation or activation sequence.
    if (boundary === 'release status') control.prepare("UPDATE clank_platform_releases SET status='crashed' WHERE id=?").run(service.id);
    else control.prepare("UPDATE clank_platform_projects SET runtime_policy='suspended' WHERE id=?").run(f.development.id);
    await rm(serviceHold); await pending;
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, first.id);
    assert.equal((await f.probe(f.staging)).value, 'prior-target');
    const db = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data/app.sqlite'));
    try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(), undefined); } finally { db.close(); }
    const receipts = (await f.call(path(f) + '/activations')).activations;
    assert.equal(receipts.find(row => row.candidateReleaseId !== first.id).state, 'failed');
    for (const field of ['runtimeIdentity', 'releaseStatus']) assert.ok(!JSON.stringify(receipts).includes(field), 'Private runtime identity must not enter public history.');
  } finally { await rm(candidateHold, { force: true }); await rm(serviceHold, { force: true }); }
});

test('an explicitly permitted human override bypasses readiness alone and changed retries still reject', { timeout: 60000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('v1');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }], 0, 5000, 'administrator'), 200, 'PUT');
  const override = { expectedVersion: 1, reason: 'Approved isolated maintenance operation', confirmation: 'override-dependencies staging 1' }, options = { headers: { 'x-clank-dependency-override': JSON.stringify(override) } };
  const accepted = await f.upload(f.staging, artifact, 'dependency_allowed_override_01', 201, options);
  const record = (await f.call(path(f) + '/activations')).activations[0];
  assert.equal(record.state, 'accepted'); assert.equal(record.check.ready, false); assert.equal(record.check.overridden, true); assert.equal(record.overrideReason, override.reason);
  await f.restart(); assert.equal((await f.upload(f.staging, artifact, 'dependency_allowed_override_01', 201, options)).id, accepted.id);
  await f.upload(f.staging, artifact, 'dependency_allowed_override_01', 409, { headers: { 'x-clank-dependency-override': JSON.stringify({ ...override, reason: 'A different operation is not the original request' }) } });
  await f.upload(f.staging, artifact, 'dependency_wrong_confirmation_01', 403, { headers: { 'x-clank-dependency-override': JSON.stringify({ ...override, confirmation: 'override-dependencies development 1' }) } });
  await f.upload(f.staging, artifact, 'dependency_invalid_json_01', 422, { headers: { 'x-clank-dependency-override': '{invalid' } });
});

for (const boundary of ['service','target']) test(`revoked ${boundary} authority during gated candidate health never commits and permits only prior-writer compensation`, { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'); await f.upload(f.development, v1, `dependency_revoke_${boundary}_service_01`);
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, v1, `dependency_revoke_${boundary}_target_01`); await f.probe(f.staging, '/write/retained-target');
  const developer = await f.account(`dependency-revoke-${boundary}@example.test`), control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.staging.organizationId, developer.user.id, 'developer', Date.now(), Date.now());
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='unaccepted';");
  const pending = f.upload(f.staging, v2, `dependency_revoke_${boundary}_held_01`, 403, { account: developer }); pending.catch(() => {});
  try {
    await entered(barrier);
    control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)').run(boundary === 'service' ? f.development.id : f.staging.id, developer.user.id, boundary === 'service' ? '["deploy"]' : '["read"]');
    await rm(hold); await pending;
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, first.id); assert.equal((await f.probe(f.staging)).value, 'retained-target');
    const activations = (await f.call(path(f) + '/activations', undefined, 200, 'GET', developer)).activations;
    assert.equal(activations[0].state, 'failed'); if (boundary === 'service') { assert.equal(activations[0].detailsAvailable, false); assert.equal(activations[0].check, undefined); }
  } finally { await rm(hold, { force: true }); }
});

test('actual controller interruption keeps the prior writer fenced until exact snapshot recovery', { timeout: 65000 }, async t => {
  const f = await fixture(t, true), v1 = await f.artifact('v1'); await f.upload(f.development, v1, 'dependency_crash_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, v1, 'dependency_crash_target_01'); await f.probe(f.staging, '/write/retained-before-crash');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const v2 = await f.artifact('v2', "UPDATE sample SET value='unaccepted-candidate'; CREATE TABLE candidate_only(id INTEGER PRIMARY KEY);");
  const pending = f.upload(f.staging, v2, 'dependency_crash_held_target_01'); pending.catch(() => {});
  await entered(barrier); await f.killAndRestart(); await assert.rejects(pending, /controller stopped/); await rm(hold);
  await f.probe(f.staging, '', 503);
  await f.upload(f.staging, v2, 'dependency_crash_held_target_01', 409);
  await f.upload(f.staging, v2, 'dependency_crash_unrelated_01', 409);
  const activation = (await f.call(path(f) + '/activations')).activations.find(row => row.state === 'recovery-required' || row.state === 'staging');
  assert.ok(activation); assert.equal(activation.previousReleaseId, first.id);
  await f.call(path(f) + `/activations/${activation.id}/recover`, { confirmation: `recover-dependencies staging ${activation.id}` });
  assert.equal((await f.probe(f.staging)).value, 'retained-before-crash');
  assert.equal((await f.call(path(f) + '/activations')).activations.find(row => row.id === activation.id).state, 'failed');
  await f.call(path(f) + `/activations/${activation.id}/recover`, { confirmation: `recover-dependencies staging ${activation.id}` });
  const db = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data/app.sqlite'));
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(), undefined); } finally { db.close(); }
});

test('gated explicit rollback uses exact target activation fencing and retained replay does not reactivate old code', { timeout: 60000 }, async t => {
  const f = await fixture(t), v1 = await f.artifact('v1'); await f.upload(f.development, v1, 'dependency_rollback_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, v1, 'dependency_rollback_target_01'), v2 = await f.artifact('v3'), second = await f.upload(f.staging, v2, 'dependency_rollback_target_02');
  const reviewed = (await f.call(path(f))).target;
  const request = { releaseId: first.id, idempotencyKey: 'dependency_rollback_request_01', expectedActiveReleaseId: second.id, expectedActivationSequence: reviewed.activationSequence };
  const rolled = (await f.call(`/api/projects/${f.staging.id}/rollback`, request)).release; assert.equal(rolled.id, first.id);
  const v3 = await f.artifact('v4'), third = await f.upload(f.staging, v3, 'dependency_rollback_target_03');
  await f.restart(); assert.equal((await f.call(`/api/projects/${f.staging.id}/rollback`, request)).release.id, first.id);
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, third.id); assert.equal((await f.probe(f.staging)).label, 'v4');
  assert.equal((await f.call(`/api/projects/${f.staging.id}/rollback`, { ...request, idempotencyKey: 'dependency_rollback_stale_01' }, 409)).error.code, 'DEPENDENCY_TARGET_CHANGED');
  assert.equal((await f.call(`/api/projects/${f.staging.id}/rollback`, { ...request, releaseId: second.id }, 409)).error.code, 'DEPENDENCY_RETRY_CHANGED');
  const current = (await f.call(path(f))).target;
  assert.equal((await f.call(`/api/projects/${f.staging.id}/rollback`, { releaseId: third.id, idempotencyKey: 'dependency_rollback_noop_01', expectedActiveReleaseId: third.id, expectedActivationSequence: current.activationSequence }, 409)).error.code, 'DEPENDENCY_TARGET_ALREADY_ACTIVE');
  assert.equal((await f.call(path(f) + '/activations')).activations.filter(row => row.id.startsWith('rollback_')).length, 1);
});

for (const kind of ['environment','channel']) test(`${kind} promotion applies the target dependency configuration and accepted retries do not recheck health`, { timeout: 60000 }, async t => {
  const f = await fixture(t), service = await f.call('/api/projects', { name: 'Required service', slug: 'required-service' }, 201), v1 = await f.artifact('v1');
  await f.upload(service.project, v1, `dependency_${kind}_required_01`);
  await f.call(path(f), configuration([{ projectId: service.project.id, readiness: 'active' }]), 200, 'PUT');
  const source = await f.upload(f.development, v1, `dependency_${kind}_source_01`);
  let route, request;
  if (kind === 'environment') { route = f.path('staging') + '/promotions'; request = f.promotion(source, v1, null, 'dependency_environment_action_01'); }
  else {
    route = `/api/projects/${f.development.id}/channels/stable/promote`;
    await f.call(`/api/projects/${f.development.id}/channels/stable`, { sourceEnvironment: 'development', releaseId: source.id, digest: v1.digest, expectedVersion: 0 }, 200, 'PUT');
    request = { targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, expectedActiveReleaseId: null, idempotencyKey: 'dependency_channel_action_01' };
  }
  const accepted = await f.call(route, request, 201);
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare("UPDATE clank_platform_releases SET status='crashed' WHERE project_id=? AND id=?").run(service.project.id, (await f.call(`/api/projects/${service.project.id}`)).project.activeReleaseId);
  assert.equal((await f.call(route, request, 201)).release.id, accepted.release.id);
  assert.equal((await f.call(path(f) + '/check', { expectedVersion: 1 })).check.ready, false);
  const newRequest = { ...request, expectedActiveReleaseId: accepted.release.id, idempotencyKey: `dependency_${kind}_blocked_02` };
  assert.equal((await f.call(route, newRequest, 409)).error.code, 'DEPENDENCY_NOT_READY');
});

test('the actual linked CLI configures, checks and inspects dependency gates and performs exact reviewed rollback', { timeout: 65000 }, async t => {
  const { mkdir } = await import('node:fs/promises'), { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const f = await fixture(t), server = await f.serve(), artifact = await f.artifact('v1'); await f.upload(f.development, artifact, 'dependency_cli_service_01');
  const started = await f.call('/api/device/start', { clientName: 'Dependency CLI acceptance' }, 201); await f.call('/api/device/approve', { code: started.userCode });
  const token = await f.call('/api/device/token', { deviceCode: started.deviceCode }), home = join(f.root, 'cli-home');
  await mkdir(home); await mkdir(join(f.root, '.clank'));
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, current: server, profiles: { [server]: { token: token.accessToken, expiresAt: token.expiresAt } } }), { mode: 0o600 });
  await writeFile(join(f.root, '.clank/project.json'), JSON.stringify({ version: 1, server, projectId: f.staging.id }), { mode: 0o600 });
  const cli = new URL('../scripts/clank.mjs', import.meta.url).pathname;
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args, '--json'], { cwd: f.root, env: { ...process.env, CLANK_HOME: home }, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
  assert.equal((await run(['dependency','get'])).configuration.version, 0);
  const config = join(f.root, 'dependencies.json'); await writeFile(config, JSON.stringify({ requirements: [{ projectId: f.development.id, readiness: 'healthy' }], timeoutMs: 5000, overridePolicy: 'deny' }));
  assert.equal((await run(['dependency','configure','--config',config,'--expected-version','0'])).configuration.version, 1);
  assert.equal((await run(['dependency','check','--expected-version','1'])).check.ready, true);
  assert.equal((await run(['dependency','history'])).checks.length, 1);
  await assert.rejects(run(['dependency','get','--config',config]), /does not apply to dependency get/);
  await assert.rejects(run(['dependency','check','--expected-version','01']), /exact --expected-version/);
  const first = await f.upload(f.staging, artifact, 'dependency_cli_target_01'), next = await f.artifact('v3'), second = await f.upload(f.staging, next, 'dependency_cli_target_02');
  const reviewed = (await run(['dependency','get'])).target;
  const checked = (await run(['dependency','check','--expected-version','1'])).check;
  const args = ['rollback',first.id,'--key','dependency_cli_rollback_01','--expected-active',second.id,'--expected-activation',String(reviewed.activationSequence),'--dependency-version','1','--dependency-check',checked.id];
  assert.equal((await run(args)).release.id, first.id); assert.equal((await run(args)).release.id, first.id);
  assert.equal((await run(['dependency','activations'])).activations.length, 3);
  await assert.rejects(run(['rollback',first.id,'--dependency-check','bad!']), /exact --dependency-check/);
});

test('service deletion and configuration publication share a graph fence before any artifact is removed', { timeout: 45000 }, async t => {
  const f = await fixture(t), hold = join(f.root, 'stop-hold'), barrier = join(f.root, 'stop-entered');
  const artifact = await f.artifact('v1', '', {}, '', { hold, entered: barrier }); await f.upload(f.development, artifact, 'dependency_deletion_service_01');
  await f.call(path(f), configuration([]), 200, 'PUT');
  for (const name of ['development','staging','production']) await f.call(f.path(name), { expectedVersion: 1 }, 200, 'DELETE');
  await writeFile(hold, 'hold');
  const deletion = f.call(`/api/projects/${f.development.id}`, { confirmation: 'delete-site development', acknowledgeDataLoss: true }, 200, 'DELETE'); deletion.catch(() => {});
  try {
    await entered(barrier);
    const configurationRequest = f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active' }], 1), 403, 'PUT'); configurationRequest.catch(() => {});
    await rm(hold); await deletion;
    assert.equal((await configurationRequest).error.code, 'DEPENDENCY_ACCESS_REQUIRED');
    assert.equal((await f.call(path(f))).configuration.requirements.length, 0);
  } finally { await rm(hold, { force: true }); }
});

test('a retained dependency review binds the exact service activation, configuration and current credential before staging', { timeout: 60000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('reviewed-service');
  await f.upload(f.development, artifact, 'dependency_check_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const reviewed = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  assert.match(reviewed.id, /^check_[a-f0-9]{32}$/);
  const headers = { 'x-clank-dependency-check': reviewed.id, 'x-clank-dependency-version': '1' };
  const administrator = await f.account('other-dependency-admin@example.test'), control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.staging.organizationId, administrator.user.id, 'admin', Date.now(), Date.now());
  await f.upload(f.staging, artifact, 'dependency_check_other_actor_01', 403, { headers, account: administrator });
  assert.equal((await f.call(`/api/projects/${f.staging.id}/releases`)).releases.length, 0);
  const next = await f.artifact('replacement-service'); await f.upload(f.development, next, 'dependency_check_service_02');
  await f.upload(f.staging, artifact, 'dependency_check_changed_service_01', 409, { headers });
  assert.equal((await f.call(`/api/projects/${f.staging.id}/releases`)).releases.length, 0);
  const current = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'active' }], 1), 200, 'PUT');
  await f.upload(f.staging, artifact, 'dependency_check_changed_config_01', 409, { headers: { ...headers, 'x-clank-dependency-check': current.id } });
});

test('retained dependency reviews expire and prune, while accepted exact retries keep their original result', { timeout: 60000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('reviewed-target'); await f.upload(f.development, artifact, 'dependency_expiry_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const check = (await f.call(path(f) + '/check', { expectedVersion: 1 })).check;
  const headers = { 'x-clank-dependency-check': check.id, 'x-clank-dependency-version': '1' };
  const first = await f.upload(f.staging, artifact, 'dependency_expiry_target_01', 201, { headers });
  const control = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite')); t.after(() => control.close());
  control.prepare('UPDATE clank_platform_dependency_checks SET created_at=? WHERE id=?').run(Date.now() - 300001, check.id);
  await f.upload(f.staging, artifact, 'dependency_expired_unaccepted_01', 409, { headers });
  const template = control.prepare('SELECT * FROM clank_platform_dependency_checks WHERE id=?').get(check.id);
  const insert = control.prepare('INSERT INTO clank_platform_dependency_checks(id,project_id,report,review,principal_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 100; index++) insert.run(`check_${String(index).padStart(32, '0')}`, f.staging.id, template.report, template.review, template.principal_hash, Date.now() + index);
  await f.call(path(f) + '/check', { expectedVersion: 1 });
  assert.equal(control.prepare('SELECT COUNT(*) AS count FROM clank_platform_dependency_checks WHERE project_id=?').get(f.staging.id).count, 100);
  assert.equal(control.prepare('SELECT 1 FROM clank_platform_dependency_checks WHERE id=?').get(check.id), undefined);
  const next = await f.artifact('newer-target'), second = await f.upload(f.staging, next, 'dependency_expiry_target_02');
  await f.restart(); assert.equal((await f.upload(f.staging, artifact, 'dependency_expiry_target_01', 201, { headers })).id, first.id);
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, second.id);
  await f.upload(f.staging, artifact, 'dependency_expiry_target_01', 409, { headers: { ...headers, 'x-clank-dependency-check': 'check_' + 'a'.repeat(32) } });
});

test('an explicit empty-configuration review cannot be silently upgraded before upload or rollback', { timeout: 45000 }, async t => {
  const f = await fixture(t), artifact = await f.artifact('empty-review'), first = await f.upload(f.staging, artifact, 'dependency_empty_target_01');
  const next = await f.artifact('empty-newer'), second = await f.upload(f.staging, next, 'dependency_empty_target_02');
  const review = await f.call(path(f)), check = (await f.call(path(f) + '/check', { expectedVersion: 0 })).check;
  const body = { releaseId: first.id, idempotencyKey: 'dependency_empty_rollback_01', expectedActiveReleaseId: second.id, expectedActivationSequence: review.target.activationSequence, expectedDependencyVersion: 0, dependencyCheckId: check.id };
  await f.call(`/api/projects/${f.staging.id}/rollback`, { ...body, expectedDependencyVersion: 1 }, 409);
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, second.id);
  await f.call(path(f), configuration([]), 200, 'PUT');
  await f.call(`/api/projects/${f.staging.id}/rollback`, body, 409);
  await f.upload(f.staging, artifact, 'dependency_empty_upload_01', 409, { headers: { 'x-clank-dependency-check': check.id, 'x-clank-dependency-version': '0' } });
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, second.id);
});

test('failed gated data rollback restores its own pre-rollback safety snapshot and keeps the accepted writer', { timeout: 60000 }, async t => {
  const f = await fixture(t), policy = join(f.root, 'service-policy.json'), service = await serviceArtifact(f, 'rollback-service');
  await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: policy } }, 200, 'PUT');
  await f.upload(f.development, service, 'dependency_data_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const old = await f.artifact('v2'), first = await f.upload(f.staging, old, 'dependency_data_target_01');
  await f.probe(f.staging, '/write/before-upgrade');
  const newer = await f.artifact('v3', "CREATE TABLE retained_new_schema(id INTEGER PRIMARY KEY);"), second = await f.upload(f.staging, newer, 'dependency_data_target_02');
  await f.probe(f.staging, '/write/accepted-current-data');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const current = (await f.call(path(f))).target;
  const body = { releaseId: first.id, restoreData: true, confirmation: 'restore staging', idempotencyKey: 'dependency_data_rollback_01', expectedActiveReleaseId: second.id, expectedActivationSequence: current.activationSequence };
  const pending = f.call(`/api/projects/${f.staging.id}/rollback`, body, 409); pending.catch(() => {});
  try {
    await entered(barrier); await writeFile(policy, JSON.stringify({ status: 503 })); await rm(hold);
    assert.equal((await pending).error.code, 'DEPENDENCY_NOT_READY');
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, second.id);
    assert.equal((await f.probe(f.staging)).value, 'accepted-current-data');
    const db = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data/app.sqlite'));
    try { assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='retained_new_schema'").get()); } finally { db.close(); }
    assert.equal((await f.call(path(f) + '/activations')).activations.find(row => row.id.startsWith('rollback_')).state, 'failed');
  } finally { await rm(hold, { force: true }); }
});

test('actual interruption during gated data rollback recovers the durable pre-rollback safety snapshot', { timeout: 65000 }, async t => {
  const f = await fixture(t, true), service = await f.artifact('service'); await f.upload(f.development, service, 'dependency_data_crash_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, await f.artifact('v2'), 'dependency_data_crash_target_01'); await f.probe(f.staging, '/write/old-data');
  const second = await f.upload(f.staging, await f.artifact('v3', "CREATE TABLE retained_after_crash(id INTEGER PRIMARY KEY);"), 'dependency_data_crash_target_02'); await f.probe(f.staging, '/write/current-data-before-rollback');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const current = (await f.call(path(f))).target;
  const body = { releaseId: first.id, restoreData: true, confirmation: 'restore staging', idempotencyKey: 'dependency_data_crash_rollback_01', expectedActiveReleaseId: second.id, expectedActivationSequence: current.activationSequence };
  const pending = f.call(`/api/projects/${f.staging.id}/rollback`, body); pending.catch(() => {});
  await entered(barrier); await f.killAndRestart(); await assert.rejects(pending, /controller stopped/); await rm(hold);
  await f.probe(f.staging, '', 503); await f.call(`/api/projects/${f.staging.id}/rollback`, body, 409);
  const activation = (await f.call(path(f) + '/activations')).activations.find(row => row.id.startsWith('rollback_'));
  assert.equal(activation.previousReleaseId, second.id);
  await f.call(path(f) + `/activations/${activation.id}/recover`, { confirmation: `recover-dependencies staging ${activation.id}` });
  assert.equal((await f.probe(f.staging)).value, 'current-data-before-rollback');
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, second.id);
  const db = new DatabaseSync(join(f.options.dataDirectory, 'projects', f.staging.id, 'data/app.sqlite'));
  try { assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='retained_after_crash'").get()); } finally { db.close(); }
  assert.equal((await f.call(path(f) + '/activations')).activations.find(row => row.id === activation.id).state, 'failed');
});

test('combined dependency and channel interruption finishes both durable fences through original promotion recovery', { timeout: 65000 }, async t => {
  const f = await fixture(t, true), required = (await f.call('/api/projects', { name: 'Service', slug: 'service' }, 201)).project;
  const base = await f.artifact('v1'); await f.upload(required, base, 'dependency_combined_service_01');
  await f.call(path(f), configuration([{ projectId: required.id, readiness: 'healthy' }]), 200, 'PUT');
  const prior = await f.upload(f.staging, base, 'dependency_combined_target_01'); await f.probe(f.staging, '/write/prior-target-data');
  const candidate = await f.artifact('v2', "UPDATE sample SET value='candidate-data';"), source = await f.upload(f.development, candidate, 'dependency_combined_source_01');
  const channelPath = `/api/projects/${f.development.id}/channels/stable`;
  await f.call(channelPath, { sourceEnvironment: 'development', releaseId: source.id, digest: candidate.digest, expectedVersion: 0 }, 200, 'PUT');
  const hold = join(f.root, 'hold'), barrier = join(f.root, 'entered'); await writeFile(hold, 'waiting');
  await f.call(`/api/projects/${f.staging.id}/secrets`, { values: { HEALTH_HOLD: hold, HEALTH_ENTERED: barrier } }, 200, 'PUT');
  const body = { targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, expectedActiveReleaseId: prior.id, idempotencyKey: 'dependency_combined_channel_01' };
  const pending = f.call(channelPath + '/promote', body, 201); pending.catch(() => {});
  await entered(barrier); await f.killAndRestart(); await assert.rejects(pending, /controller stopped/); await rm(hold);
  const activation = (await f.call(path(f) + '/activations')).activations.find(row => row.state === 'staging'); assert.ok(activation);
  assert.equal((await f.call(path(f) + `/activations/${activation.id}/recover`, { confirmation: `recover-dependencies staging ${activation.id}` }, 409)).error.code, 'PROMOTION_RECOVERY_REQUIRED');
  const promotion = (await f.call(f.path('staging') + '/promotions')).promotions[0];
  await f.call(f.path('staging') + `/promotions/${promotion.idempotencyKey}/recover`, { confirmation: `recover-promotion staging ${promotion.idempotencyKey}` });
  assert.equal((await f.call(path(f) + '/activations')).activations.find(row => row.id === activation.id).state, 'failed');
  assert.equal((await f.call(channelPath + '/actions')).actions[0].state, 'failed');
  assert.equal((await f.probe(f.staging)).value, 'prior-target-data');
  const fresh = await f.artifact('v3'); await f.upload(f.staging, fresh, 'dependency_combined_after_recovery_01');
});

test('real canary traffic cannot publish after dependency health fails during a measured stage', { timeout: 60000 }, async t => {
  const f = await fixture(t, false, { canary: { stages: [{ trafficPercent: 50, durationMs: 600, minimumSamples: 2 }, { trafficPercent: 100, durationMs: 400, minimumSamples: 2 }], maximumErrorRate: 0.1, maximumP95Ms: 1000 } });
  const policy = join(f.root, 'canary-service-health.json'), service = await serviceArtifact(f, 'canary-service');
  await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: policy } }, 200, 'PUT');
  await f.upload(f.development, service, 'dependency_canary_service_01');
  await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
  const first = await f.upload(f.staging, await f.artifact('canary-prior'), 'dependency_canary_prior_01');
  await f.probe(f.staging, '/write/accepted-canary-data');
  let finished = false, injected = false; const observed = new Set();
  const pending = f.upload(f.staging, await f.artifact('canary-candidate'), 'dependency_canary_candidate_01', 409).finally(() => { finished = true; }); pending.catch(() => {});
  while (!finished) {
    const rows = await Promise.all(Array.from({ length: 8 }, () => f.probe(f.staging)));
    for (const row of rows) observed.add(row.label);
    if (!injected && observed.has('canary-candidate')) { injected = true; await writeFile(policy, JSON.stringify({ status: 503 })); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await pending; assert.ok(injected); assert.ok(observed.has('canary-prior'));
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, first.id);
  assert.equal((await f.probe(f.staging)).value, 'accepted-canary-data');
  const report = (await f.call(`/api/projects/${f.staging.id}/canary`)).canaries[0]; assert.equal(report.state, 'failed');
  assert.equal((await f.call(path(f) + '/activations')).activations.find(row => row.candidateReleaseId !== first.id).state, 'failed');
});

for (const stalled of [false, true]) {
  test(`failed canary ${stalled ? 'bounds a stalled response drain' : 'drains an admitted response before stopping'}`, { timeout: 60000 }, async t => {
    const f = await fixture(t, false, { canary: {
      stages: [{ trafficPercent: 100, durationMs: 2500, minimumSamples: 2 }],
      maximumErrorRate: 0.1, maximumP95Ms: 1000,
    } });
    const policy = join(f.root, 'service-policy.json');
    const hold = join(f.root, 'request-hold'), admittedFile = join(f.root, 'request-admitted');
    // Observe the persisted phase directly: a public API request can spend
    // the entire drain interval waiting on other controller work.
    const sql = new DatabaseSync(join(f.root, 'platform/control.sqlite'), { readOnly: true });
    const report = () => {
      const row = sql.prepare('SELECT report FROM clank_platform_canaries WHERE project_id=? ORDER BY updated_at DESC LIMIT 1').get(f.staging.id);
      return row ? JSON.parse(row.report) : null;
    };
    const waitFor = async (check, message) => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    let deploy, admitted;
    try {
      await f.call(`/api/projects/${f.development.id}/secrets`, { values: { DEPENDENCY_HEALTH_FILE: policy } }, 200, 'PUT');
      await f.upload(f.development, await serviceArtifact(f, 'drain-service'), 'candidate_drain_service_01');
      await f.call(path(f), configuration([{ projectId: f.development.id, readiness: 'healthy' }]), 200, 'PUT');
      const prior = await f.upload(f.staging, await f.artifact('canary-prior'), 'candidate_drain_prior_01');
      await f.probe(f.staging, '/write/retained-data');
      await writeFile(hold, 'hold');
      await f.call(`/api/projects/${f.staging.id}/secrets`, { values: {
        CANARY_REQUEST_HOLD: hold, CANARY_REQUEST_ENTERED: admittedFile,
      } }, 200, 'PUT');
      let deploymentFinished = false, responseFinished = false;
      deploy = f.upload(f.staging, await f.artifact('canary-candidate'), 'candidate_drain_upload_01', 409)
        .finally(() => { deploymentFinished = true; });
      deploy.catch(() => {});
      await waitFor(() => report()?.state === 'running' && report()?.trafficPercent === 100, 'Candidate must enter measured traffic.');
      await f.probe(f.staging, '/fast'); await f.probe(f.staging, '/fast');
      admitted = f.probe(f.staging, '/held', stalled ? 502 : 200)
        .then(value => ({ value }), error => ({ error }))
        .finally(() => { responseFinished = true; });
      await entered(admittedFile);
      await writeFile(policy, JSON.stringify({ status: 503 }));
      await waitFor(() => report()?.state === 'failed', 'Dependency failure must retire the candidate.');
      const failedAt = Date.now();
      assert.equal(responseFinished, false, 'An admitted request must survive the start of rollback.');
      assert.equal(deploymentFinished, false, 'Candidate cleanup must wait for the admitted request.');
      assert.equal((await f.probe(f.staging, '/fast')).label, 'canary-prior', 'New traffic must use the prior release while the candidate drains.');
      if (!stalled) await rm(hold);
      const result = await admitted;
      assert.equal(result.error, undefined, result.error?.stack);
      if (stalled) {
        assert.equal(result.value.error.code, 'UPSTREAM_FAILED');
        assert.ok(Date.now() - failedAt >= 1800, 'Termination must respect the two-second drain interval.');
      } else {
        assert.equal(result.value.label, 'canary-candidate');
        assert.equal(result.value.value, 'retained-data');
      }
      await deploy;
      assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId, prior.id);
      assert.equal((await f.probe(f.staging)).label, 'canary-prior');
      assert.equal((await f.probe(f.staging)).value, 'retained-data');
      const logs = (await f.call(`/api/projects/${f.staging.id}/logs`)).logs;
      assert.equal(logs.some(row => row.message === 'Candidate drain reached its two-second limit; terminating remaining streams.'), stalled);
    } finally {
      await rm(hold, { force: true });
      await Promise.allSettled([deploy, admitted].filter(Boolean));
      sql.close();
    }
  });
}
