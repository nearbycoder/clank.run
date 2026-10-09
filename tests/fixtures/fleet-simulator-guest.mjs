// Manual acceptance only: this file is never discovered by the ordinary test runner.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, stat, chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { certifyLinuxHost, inspectLinuxHostCertification } from '../../dist/host-certification.js';
import { runLocalProviderFleetScenario, exportLocalProviderFleetScenario } from '../../dist/fleet-simulator.js';
import { createLinuxDockerNetworkPlan, removeLinuxDockerNetworkPolicy } from '../../dist/linux-project-isolation.js';

assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1');
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
assert.match(await readFile('/etc/clank-disposable-test-host', 'utf8'), /^clank-disposable-/);
const mount = process.env.CLANK_XFS_TEST_MOUNT, image = process.env.CLANK_DOCKER_TEST_IMAGE;
assert.ok(mount && image && /@sha256:[a-f0-9]{64}$/.test(image));
assert.deepEqual(await readdir(mount), [], 'only a new, empty, dedicated XFS mount');
const root = await mkdtemp('/root/clank-fleet-acceptance-');
const profile = { mode: 'docker-isolated', image, user: '1000:1000', diskQuota: { mountDirectory: mount, hardBytes: 32 * 1024 * 1024, hardFiles: 64 },
  outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } };
const certificate = { directory: join(root, 'certificate'), profile };
const certified = await certifyLinuxHost({ ...certificate, disposable: true, quotaId: 2147481200, ttlMs: 3600000 });
console.log(JSON.stringify({ name: 'current-host-certification', report: certified }));
assert.equal(certified.status, 'passed');
const docker = (...args) => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' });
const initialImages = docker('image', 'ls', '--quiet', '--no-trunc').trim().split('\n').sort();
const selected = process.argv.slice(2);
const cases = selected.length ? selected : ['takeover', 'lease-loss', 'slow-transport', 'disk-read-only', 'coordinator-restart', 'provider-restart'];
const results = [];
const common = { certificate, disposable: true, quotaIds: [2147481201, 2147481202], portStart: 47000 };
for (const kind of cases) {
  assert.equal((await inspectLinuxHostCertification(certificate)).current, true);
  const scenario = JSON.parse(exportLocalProviderFleetScenario({ protocol: 'clank-fleet-scenario/1', kind }));
  const report = await runLocalProviderFleetScenario({ ...common, scenario });
  console.log(JSON.stringify({ name: kind, report }));
  results.push({ name: kind, report });
  assert.equal(report.status, 'passed'); assert.ok(report.checks.every(check => check.status === 'passed'));
  assert.deepEqual(await readdir(mount), []);
  await assert.rejects(lstat('/run/clank-host-certification.attempt'), { code: 'ENOENT' });
  assert.equal(docker('container', 'ls', '--all', '--quiet', '--filter', 'label=run.clank.managed=provider-runtime').trim(), '');
  assert.equal((await inspectLinuxHostCertification(certificate)).current, true);
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nativeQuota = (id, operation) => execFileSync('/usr/sbin/xfs_quota', ['-x', '-D', '/dev/null', '-P', '/dev/null', '-c', operation, mount], { encoding: 'utf8' });
const quotaRow = (id, kind) => {
  const output = nativeQuota(id, `report -p -n -N -${kind} -L ${id} -U ${id}`);
  const row = output.split('\n').map(line => line.trim().split(/\s+/)).find(parts => [String(id), `#${id}`].includes(parts[0]));
  return row ? row.slice(1, 4).map(Number) : [0, 0, 0];
};
const held = { protocol: 'clank-fleet-scenario/1', kind: 'lease-loss', operationLeaseMs: 30000 };
async function pausedAttempt(pid) {
  for (let index = 0; index < 600; index++) {
    try {
      const attempt = JSON.parse(await readFile('/run/clank-host-certification.attempt', 'utf8'));
      assert.equal(attempt.pid, pid); assert.equal(attempt.protocol, 'clank-fleet-attempt/1');
      if (attempt.root) {
        const database = new DatabaseSync(join(attempt.root, 'control.sqlite'), { readOnly: true, timeout: 100 });
        try { if (database.prepare("SELECT count(*) AS n FROM clank_deployment_operations WHERE project_id='fleet_project' AND state='leased' AND json_extract(payload,'$.generation')=2").get().n === 1) return attempt; }
        finally { database.close(); }
      }
    } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    await delay(50);
  }
  throw new Error('Actual second-generation lease was not reached.');
}
async function removeOwnedAttempt(attempt) {
  const marker = await lstat('/run/clank-host-certification.attempt');
  assert.equal(attempt.boot, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
  assert.ok(attempt.root.startsWith(`${mount}/clank-fleet-`));
  assert.deepEqual(attempt.quotaIds, common.quotaIds); assert.equal(attempt.quotaMount, mount); assert.equal(attempt.projectId, 'fleet_project');
  assert.ok(attempt.owners.every(owner => /^fleet-[a-f0-9]{24}-[ab]$/.test(owner)));
  for (const worker of attempt.workers) {
    for (let index = 0; index < 600; index++) { try { await lstat(`/proc/${worker.pid}`); } catch (error) { if (error.code === 'ENOENT') break; throw error; } await delay(50); }
    await assert.rejects(lstat(`/proc/${worker.pid}`), { code: 'ENOENT' });
  }
  for (const owner of attempt.owners) {
    assert.equal(docker('container', 'ls', '--all', '--quiet', '--filter', `label=run.clank.owner=${owner}`).trim(), '');
    const plan = await createLinuxDockerNetworkPlan(owner, attempt.projectId, profile.outboundNetwork);
    const tables = JSON.parse(execFileSync('/usr/sbin/nft', ['-j', 'list', 'tables'], { encoding: 'utf8' }));
    if (tables.nftables.some(entry => entry.table?.name === plan.table && entry.table.family === 'inet')) await removeLinuxDockerNetworkPolicy(plan);
    if (docker('network', 'ls', '--format', '{{.Name}}').split('\n').includes(plan.network)) {
      const network = JSON.parse(docker('network', 'inspect', plan.network))[0];
      assert.equal(network.Labels?.['run.clank.owner'], owner); assert.equal(network.Labels?.['run.clank.project'], attempt.projectId);
      docker('network', 'rm', plan.network);
    }
    const after = JSON.parse(execFileSync('/usr/sbin/nft', ['-j', 'list', 'tables'], { encoding: 'utf8' }));
    assert.equal(after.nftables.some(entry => entry.table?.name === plan.table), false);
    assert.equal(docker('network', 'ls', '--format', '{{.Name}}').split('\n').includes(plan.network), false);
  }
  await rm(attempt.root, { recursive: true });
  for (const id of attempt.quotaIds) {
    for (const kind of ['b', 'i']) { for (let index = 0; index < 50 && quotaRow(id, kind)[0] !== 0; index++) await delay(100); assert.equal(quotaRow(id, kind)[0], 0); }
    nativeQuota(id, `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${id}`);
    for (const kind of ['b', 'i']) assert.deepEqual(quotaRow(id, kind), [0, 0, 0]);
  }
  assert.equal((await lstat('/run/clank-host-certification.attempt')).ino, marker.ino);
  await rm('/run/clank-host-certification.attempt');
  assert.deepEqual(await readdir(mount), []);
  assert.equal((await inspectLinuxHostCertification(certificate)).current, true);
}
if (!selected.length) {
  const controller = new AbortController();
  const pending = runLocalProviderFleetScenario({ ...common, scenario: held, signal: controller.signal });
  await pausedAttempt(process.pid); controller.abort(); const cancelled = await pending;
  assert.equal(cancelled.reason, 'aborted'); assert.equal(cancelled.checks.find(check => check.name === 'cleanup').status, 'passed');
  assert.deepEqual(await readdir(mount), []); await assert.rejects(lstat('/run/clank-host-certification.attempt'), { code: 'ENOENT' });
  results.push({ name: 'cancelled-during-real-lease', report: cancelled }); console.log(JSON.stringify(results.at(-1)));

  const config = join(root, 'fleet.json'); await writeFile(config, JSON.stringify({ certificate, scenario: held, quotaIds: common.quotaIds, portStart: common.portStart }), { mode: 0o600 });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/clank-provider.mjs', 'fleet', '--config', config, '--disposable'], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  let killed;
  try {
    killed = await pausedAttempt(child.pid); child.kill('SIGKILL'); await closed;
    assert.equal((await inspectLinuxHostCertification(certificate)).reason, 'attempt-in-progress');
    assert.equal((await runLocalProviderFleetScenario({ ...common, scenario: { protocol: held.protocol, kind: 'takeover' } })).reason, 'certification-required');
    await removeOwnedAttempt(killed);
    results.push({ name: 'parent-killed-during-real-lease', blockedUntilOwnedCleanup: true, childrenExited: true }); console.log(JSON.stringify(results.at(-1)));
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }

  const deniedController = new AbortController(), nftMode = (await stat('/usr/sbin/nft')).mode & 0o7777;
  const deniedPending = runLocalProviderFleetScenario({ ...common, scenario: held, signal: deniedController.signal });
  let deniedAttempt;
  try {
    deniedAttempt = await pausedAttempt(process.pid); await chmod('/usr/sbin/nft', 0); deniedController.abort();
    const denied = await deniedPending;
    assert.equal(denied.reason, 'cleanup-failed'); assert.equal(denied.status, 'blocked');
    assert.equal((await inspectLinuxHostCertification(certificate)).reason, 'attempt-in-progress');
    await chmod('/usr/sbin/nft', nftMode); await removeOwnedAttempt(deniedAttempt);
    results.push({ name: 'cleanup-denied', report: denied, markerRetainedUntilOwnedCleanup: true }); console.log(JSON.stringify(results.at(-1)));
  } finally { await chmod('/usr/sbin/nft', nftMode); deniedController.abort(); await deniedPending; }

  const reservedId = 2147481203;
  for (const kind of ['b', 'i']) assert.deepEqual(quotaRow(reservedId, kind), [0, 0, 0]);
  nativeQuota(reservedId, `limit -p bhard=8192 ${reservedId}`);
  try {
    const before = quotaRow(reservedId, 'b'); assert.notEqual(before[2], 0);
    const reserved = await runLocalProviderFleetScenario({ ...common, quotaIds: [reservedId, common.quotaIds[1]], scenario: { protocol: held.protocol, kind: 'takeover' } });
    assert.equal(reserved.status, 'blocked'); assert.deepEqual(quotaRow(reservedId, 'b'), before); assert.deepEqual(await readdir(mount), []);
    results.push({ name: 'reserved-quota-unchanged', report: reserved }); console.log(JSON.stringify(results.at(-1)));
  } finally { nativeQuota(reservedId, `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${reservedId}`); }

  const short = { directory: join(root, 'short-certificate'), profile };
  const shortReport = await certifyLinuxHost({ ...short, disposable: true, quotaId: 2147481200, ttlMs: 60000 }); assert.equal(shortReport.status, 'passed');
  const insufficient = await runLocalProviderFleetScenario({ ...common, certificate: short, scenario: { protocol: held.protocol, kind: 'takeover' } });
  assert.equal(insufficient.reason, 'certification-required'); assert.deepEqual(await readdir(mount), []);
  results.push({ name: 'insufficient-validity', report: insufficient }); console.log(JSON.stringify(results.at(-1)));

  await writeFile(config, JSON.stringify({ certificate, scenario: { protocol: held.protocol, kind: 'provider-restart' }, quotaIds: common.quotaIds, portStart: common.portStart }));
  const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/clank-provider.mjs', 'fleet', '--config', config, '--disposable'], { encoding: 'utf8', timeout: 180000 });
  assert.equal(cli.status, 0, cli.stderr); const cliReport = JSON.parse(cli.stdout); assert.equal(cliReport.status, 'passed');
  results.push({ name: 'actual-cli-provider-restart', report: cliReport }); console.log(JSON.stringify(results.at(-1)));
}
const aborted = await runLocalProviderFleetScenario({ certificate, scenario: { protocol: 'clank-fleet-scenario/1', kind: 'takeover' }, disposable: true,
  quotaIds: [2147481201, 2147481202], portStart: 47000, signal: AbortSignal.abort() });
assert.equal(aborted.status, 'blocked'); assert.equal(aborted.reason, 'aborted');
assert.deepEqual(await readdir(mount), []);
assert.deepEqual(docker('image', 'ls', '--quiet', '--no-trunc').trim().split('\n').sort(), initialImages);
console.log(JSON.stringify({ protocol: 'clank-fleet-acceptance/1', realGuest: true, node: process.version, cases: results, aborted,
  finalMountEmpty: true, finalOwnedRuntimesEmpty: true, imagesUnchanged: true }));
