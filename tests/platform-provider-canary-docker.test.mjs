import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, artifact, command, until, ownedContainers } from './fixtures/platform-provider-docker-native.mjs';
const options = { skip: process.env.CLANK_DOCKER_INTEGRATION !== '1' ? 'requires CLANK_DOCKER_INTEGRATION=1 on a disposable VM' : false, timeout: 240000 };

test('real Docker platform stages retire the isolated candidate and preserve primary writes made after its checkpoint', options, async t => {
  const f = await fixture(t), samples = [];
  const pending = f.deploy(await artifact(f.root, 'candidate'), 'docker-canary-candidate-0001'); pending.catch(() => {});
  await until(() => f.raw()?.operation.phase === 'measuring', 'Actual candidate admitted for measurement');
  const candidate = await f.candidate(), ids = await ownedContainers(f.owner, candidate); assert.equal(ids.length, 1);
  const details = JSON.parse((await command('docker', ['container', 'inspect', ids[0]])).stdout)[0];
  assert.equal(details.State.Running, true); assert.equal(details.Mounts.find(mount => mount.Destination === '/data').RW, false); assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.equal(details.Config.Env.some(value => value.startsWith('CANARY_FIXTURE_')), false);
  const write = await f.traffic('POST', '/write'); assert.equal(write.status, 200); assert.equal((await write.json()).label, 'primary');
  assert.equal((await (await f.traffic('GET', '/', { authorization: 'Bearer owned-private-request' })).json()).label, 'primary');
  const result = await f.drive(pending, samples); assert.equal(result.status, 201, JSON.stringify(result));
  assert.ok(samples.length >= 10); assert.ok(samples.every(sample => sample.body.label === 'candidate' && !sample.body.writer && !sample.body.secretPresent));
  for (const sample of samples) {
    assert.equal(sample.body.sqlite.ok, false); assert.match(sample.body.sqlite.message, /readonly/iu); assert.equal(sample.body.file.code, 'EROFS');
    assert.equal(sample.headers['set-cookie'], undefined); assert.equal(sample.headers['clear-site-data'], undefined); assert.equal(sample.headers['cache-control'], 'no-store');
    assert.equal(sample.body.headers.authorization, undefined); assert.equal(sample.body.headers.cookie, undefined);
    assert.ok(sample.body.rows.every(row => row.kind !== 'after-checkpoint'), 'Isolated snapshot must not receive later primary writes.');
  }
  const state = await f.state(); assert.equal(state.provider.phase, 'complete'); assert.equal(state.provider.outcome, 'passed'); assert.equal(state.canaries[0].state, 'passed');
  assert.equal(f.raw().operation.retirement.phase, 'retired'); await f.absent(candidate);
  const final = await (await f.traffic()).json(); assert.equal(final.label, 'candidate'); assert.equal(final.writer, true);
  assert.ok(final.rows.some(row => row.label === 'primary' && row.kind === 'after-checkpoint')); assert.ok(final.rows.every(row => row.kind !== 'forbidden-candidate-write'));
  const reconciles = (await f.provider.rpc('status')).events.filter(event => event.kind === 'reconcile');
  assert.deepEqual(reconciles.map(event => event.mode), ['initialize', 'preserve']);
  assert.deepEqual(reconciles[1].cleanup, [{ candidateProjectId: candidate, retired: true, absent: true }]);
});

for (const mode of ['failed', 'undersampled']) test(`real Docker platform ${mode} stages retain the primary and remove candidate data, bridge and nft policy`, options, async t => {
  const f = await fixture(t, [{ trafficPercent: 100, durationMs: 1500, minimumSamples: 5 }]);
  const pending = f.deploy(await artifact(f.root, mode, mode === 'failed' ? 500 : 200), 'docker-canary-failure-0001'); pending.catch(() => {});
  await until(() => f.raw()?.operation.phase === 'measuring', 'Actual failing candidate measurement');
  const candidate = await f.candidate(); assert.equal((await ownedContainers(f.owner, candidate)).length, 1);
  const result = mode === 'failed' ? await f.drive(pending) : await pending;
  assert.equal(result.status, 409, JSON.stringify(result)); assert.equal(result.body.error.code, 'PROVIDER_CANARY_FAILED');
  assert.equal(f.raw().operation.phase, 'complete'); assert.equal(f.raw().operation.retirement.phase, 'retired'); await f.absent(candidate);
  assert.equal((await (await f.traffic()).json()).label, 'primary'); assert.equal((await ownedContainers(f.owner, f.project.id)).length, 1);
  assert.equal((await f.provider.rpc('status')).events.filter(event => event.kind === 'reconcile').length, 1);
  const report = (await f.state()).canaries[0]; assert.equal(report.state, 'failed'); assert.match(report.reason, mode === 'failed' ? /error/iu : /sample/iu);
});

test('real coordinator SIGKILL with a received prepare recovers under disabled policy before a new Docker writer', options, async t => {
  const f = await fixture(t); await f.provider.rpc('hold', 'prepare');
  const pending = f.deploy(await artifact(f.root, 'killed'), 'docker-canary-killed-0001').catch(error => ({ interrupted: error.name }));
  await f.held('prepare'); const before = f.raw(), candidate = await f.candidate(); assert.equal(before.operation.phase, 'preparing'); await f.absent(candidate);
  await f.restartDisabled(); await pending;
  const recovered = f.raw(); assert.equal(recovered.operation.operationId, before.operation.operationId); assert.equal(recovered.operation.phase, 'complete'); assert.equal(recovered.operation.outcome, 'interrupted'); assert.equal(recovered.operation.retirement.phase, 'retired'); assert.ok(recovered.epoch > before.epoch);
  const state = await f.state(); assert.equal(state.enabled, false); assert.equal(state.provider.cleanupRequired, false); await f.absent(candidate);
  await f.provider.rpc('release', 'prepare');
  await until(async () => (await f.provider.rpc('status')).events.some(event => event.kind === 'control' && event.action === 'prepare' && event.status !== 200), 'Delayed old prepare must be refused by the actual service');
  await f.absent(candidate);
  const next = await f.deploy(await artifact(f.root, 'replacement'), 'docker-canary-replacement-0001'); assert.equal(next.status, 201, JSON.stringify(next));
  assert.equal((await (await f.traffic()).json()).label, 'replacement'); await f.absent(candidate);
  assert.deepEqual((await f.provider.rpc('status')).events.filter(event => event.kind === 'reconcile').at(-1).cleanup, [{ candidateProjectId: candidate, retired: true, absent: true }]);
});

test('native project lease loss cannot accept a held real-provider prepare and retirement prevents its delayed recreation', options, async t => {
  const f = await fixture(t); await f.provider.rpc('hold', 'prepare');
  const pending = f.deploy(await artifact(f.root, 'revoked'), 'docker-canary-revoked-0001'); pending.catch(() => {});
  await f.held('prepare'); const candidate = await f.candidate();
  const before = f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id);
  assert.equal(f.control.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:' + f.project.id).changes, 1);
  const result = await pending; assert.equal(result.status, 503, JSON.stringify(result));
  assert.deepEqual(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id), before);
  assert.equal(f.raw().operation.retirement, null); await f.absent(candidate);
  const blocked = await f.deploy(await artifact(f.root, 'blocked'), 'docker-canary-blocked-0001'); assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'PROVIDER_CANARY_RECOVERY_REQUIRED');
  await f.recover(); assert.equal(f.raw().operation.retirement.phase, 'retired'); await f.absent(candidate);
  await f.provider.rpc('release', 'prepare');
  await until(async () => (await f.provider.rpc('status')).events.some(event => event.kind === 'control' && event.action === 'prepare' && event.status !== 200), 'Delayed lease-lost prepare must be refused');
  await f.absent(candidate); assert.equal((await (await f.traffic()).json()).label, 'primary');
  assert.equal((await f.provider.rpc('status')).events.filter(event => event.kind === 'reconcile').length, 1);
});
