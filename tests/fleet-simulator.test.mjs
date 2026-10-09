import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseLocalProviderFleetScenario, exportLocalProviderFleetScenario, runLocalProviderFleetScenario } from '../dist/fleet-simulator.js';

const scenario = { protocol: 'clank-fleet-scenario/1', kind: 'takeover' };
const profile = mount => ({ mode: 'docker-isolated', image: `node@sha256:${'a'.repeat(64)}`, user: '1000:1000',
  diskQuota: { mountDirectory: mount, hardBytes: 32 * 1024 * 1024, hardFiles: 64 }, outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } });
const options = root => ({ certificate: { directory: join(root, 'missing'), profile: profile(root) }, scenario, disposable: true, quotaIds: [2147481201, 2147481202], portStart: 47000 });

test('portable scenarios normalize deterministically and reject undeclared executable or unbounded data', () => {
  const result = parseLocalProviderFleetScenario(scenario);
  assert.deepEqual(result, { ...scenario, nodeTtlMs: 5000, operationLeaseMs: 3000, transportDelayMs: 1500 });
  assert.ok(Object.isFrozen(result));
  assert.equal(exportLocalProviderFleetScenario(result), exportLocalProviderFleetScenario(scenario));
  for (const kind of ['takeover', 'lease-loss', 'slow-transport', 'disk-read-only', 'coordinator-restart', 'provider-restart']) assert.equal(parseLocalProviderFleetScenario({ ...scenario, kind }).kind, kind);
  for (const mutation of [{ protocol: 'v2' }, { kind: 'shell' }, { nodeTtlMs: 1999 }, { nodeTtlMs: 30001 }, { operationLeaseMs: 999 }, { operationLeaseMs: 30001 }, { transportDelayMs: 199 }, { transportDelayMs: 10001 }, { transportDelayMs: NaN }, { execute: () => true }, { root: '/production' }, { token: 'private' }]) assert.throws(() => parseLocalProviderFleetScenario({ ...scenario, ...mutation }), TypeError);
  for (const bad of [null, [], 'takeover', Object.assign(Object.create({}), scenario), { ...scenario, [Symbol('hidden')]: true }]) assert.throws(() => parseLocalProviderFleetScenario(bad), TypeError);
  let accessed = false;
  const accessor = { ...scenario }; Object.defineProperty(accessor, 'kind', { enumerable: true, get() { accessed = true; return 'takeover'; } });
  assert.throws(() => parseLocalProviderFleetScenario(accessor), TypeError); assert.equal(accessed, false);
  const hidden = { ...scenario }; Object.defineProperty(hidden, 'protocol', { enumerable: false, value: scenario.protocol });
  assert.throws(() => parseLocalProviderFleetScenario(hidden), TypeError);
  const mutable = { ...scenario, nodeTtlMs: 7000 }; const captured = parseLocalProviderFleetScenario(mutable); mutable.nodeTtlMs = 9000; assert.equal(captured.nodeTtlMs, 7000);
});

test('fleet admission rejects unsafe IDs, ports, signals and nested descriptors before host mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-fleet-input-'));
  try {
    const base = options(root);
    for (const mutation of [{ disposable: false }, { quotaIds: [1] }, { quotaIds: [1, 1] }, { quotaIds: [0, 1] }, { quotaIds: [1, 2 ** 32] }, { quotaIds: ['1', 2] }, { portStart: 1023 }, { portStart: 65527 }, { portStart: 47000.5 }, { signal: {} }, { executable: '/bin/true' }]) await assert.rejects(runLocalProviderFleetScenario({ ...base, ...mutation }), TypeError);
    let accessed = false;
    const accessor = { ...base.certificate.profile }; Object.defineProperty(accessor, 'image', { enumerable: true, get() { accessed = true; return 'private'; } });
    await assert.rejects(runLocalProviderFleetScenario({ ...base, certificate: { ...base.certificate, profile: accessor } }), TypeError); assert.equal(accessed, false);
    for (const quotaIds of [[, 2], Object.assign([1, 2], { extra: 3 }), Object.assign(Object.create(Array.prototype), { 0: 1, 1: 2, length: 2 })]) await assert.rejects(runLocalProviderFleetScenario({ ...base, quotaIds }), TypeError);
    const recursive = {}; recursive.self = recursive;
    for (const bad of [recursive, { ...base.certificate, directory: 'x'.repeat(16385) }, { ...base.certificate, extra: new Array(129).fill('x') }]) await assert.rejects(runLocalProviderFleetScenario({ ...base, certificate: bad }), TypeError);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pre-aborted and missing-certified attempts are immutable, bounded and contain no operator data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-fleet-blocked-'));
  try {
    const base = options(root), pending = runLocalProviderFleetScenario({ ...base, signal: AbortSignal.abort() });
    base.scenario = { protocol: 'clank-fleet-scenario/1', kind: 'provider-restart' }; base.certificate.profile.user = '0:0'; base.quotaIds[0] = 0;
    const aborted = await pending;
    assert.equal(aborted.reason, 'aborted'); assert.equal(aborted.scenario.kind, 'takeover'); assert.equal(aborted.status, 'blocked'); assert.equal(aborted.artifactSha256, null);
    const blocked = await runLocalProviderFleetScenario(options(root));
    assert.equal(blocked.reason, 'certification-required'); assert.equal(blocked.status, 'blocked');
    for (const report of [aborted, blocked]) {
      assert.ok(Object.isFrozen(report) && Object.isFrozen(report.scenario) && Object.isFrozen(report.checks) && Object.isFrozen(report.timeline));
      assert.equal(report.checks.length, 7); assert.equal(report.checks.find(check => check.name === 'cleanup').status, 'passed');
      assert.deepEqual(report.timeline.map(event => event.sequence), [1]);
      assert.doesNotMatch(JSON.stringify(report), /node@|1000:1000|missing|2147481201/); assert.equal(JSON.stringify(report).includes(root), false);
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fleet CLI requires private explicit bounded input and reports certification failure without starting provider mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-fleet-cli-'));
  try {
    const config = join(root, 'fleet.json'), base = options(root); delete base.disposable;
    await writeFile(config, JSON.stringify(base), { mode: 0o600 });
    const run = args => spawnSync(process.execPath, ['scripts/clank-provider.mjs', ...args], { encoding: 'utf8', timeout: 30000 });
    const blocked = run(['fleet', '--config', config, '--disposable']); assert.equal(blocked.status, 1, blocked.stderr); assert.equal(JSON.parse(blocked.stdout).reason, 'certification-required');
    for (const args of [['fleet'], ['fleet', '--config', config], ['fleet', '--disposable'], ['fleet', '--config', config, '--disposable', '--disposable'], ['fleet', '--config', config, '--disposable', '--command', 'private']]) { const result = run(args); assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /CLANK_PROVIDER_TOKEN/); }
    await symlink(config, join(root, 'link')); assert.equal(run(['fleet', '--config', join(root, 'link'), '--disposable']).status, 1);
    const publicConfig = join(root, 'public.json'); await writeFile(publicConfig, JSON.stringify(base), { mode: 0o644 }); assert.equal(run(['fleet', '--config', publicConfig, '--disposable']).status, 1);
    await writeFile(config, JSON.stringify({ ...base, command: 'private' })); assert.equal(run(['fleet', '--config', config, '--disposable']).status, 1);
    await writeFile(config, ' '.repeat(16385)); assert.equal(run(['fleet', '--config', config, '--disposable']).status, 1);
    const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /private-fleet.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
