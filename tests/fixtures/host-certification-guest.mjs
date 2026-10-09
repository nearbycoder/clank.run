// Explicit manual privileged acceptance driver. Never discovered as an ordinary test.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { certifyLinuxHost, inspectLinuxHostCertification, requireCurrentLinuxHostCertification } from '../../dist/host-certification.js';
import { createLinuxDockerNetworkPlan, removeLinuxDockerNetworkPolicy } from '../../dist/linux-project-isolation.js';

assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1');
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
assert.match(await readFile('/etc/clank-disposable-test-host', 'utf8'), /^clank-disposable-/);
const mount = process.env.CLANK_XFS_TEST_MOUNT, image = process.env.CLANK_DOCKER_TEST_IMAGE;
assert.ok(mount && image && /@sha256:[a-f0-9]{64}$/.test(image));
assert.deepEqual(await readdir(mount), [], 'only a newly owned empty dedicated mount');
const root = await mkdtemp('/root/clank-host-acceptance-');
const profile = { mode: 'docker-isolated', image, user: '1000:1000', diskQuota: { mountDirectory: mount, hardBytes: 32 * 1024 * 1024, hardFiles: 64 },
  outboundNetwork: { allowCidrs: ['1.1.1.1/32'], hosts: { 'allowed.example.test': '1.1.1.1' } }, networkProbe: { allowedAddress: '1.1.1.1', deniedAddress: '9.9.9.9' } };
let id = 2147481100;
const selected = (name, chosen = profile) => ({ directory: join(root, name), profile: chosen });
const results = [];
const certify = async (name, chosen = profile) => {
  const options = selected(name, chosen), report = await certifyLinuxHost({ ...options, disposable: true, quotaId: ++id });
  results.push({ name, report }); console.log(JSON.stringify({ name, report })); return { options, report };
};
const docker = (...args) => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' });
const initialImages = docker('image', 'ls', '--quiet', '--no-trunc').trim().split('\n').sort();
const allowed = await certify('allowed');
assert.equal(allowed.report.status, 'passed'); assert.ok(allowed.report.checks.every(check => check.status === 'passed'));
assert.equal((await requireCurrentLinuxHostCertification(allowed.options)).id, allowed.report.id);
const config = join(root, 'allowed.json'); await writeFile(config, JSON.stringify(allowed.options));
const cli = spawnSync(process.execPath, ['scripts/clank-provider.mjs', 'certification', '--config', config], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).current, true);
assert.equal((await inspectLinuxHostCertification({ ...allowed.options, profile: { ...profile, memory: '256m' } })).reason, 'policy-changed');

const setting = '/proc/sys/user/max_user_namespaces', previous = (await readFile(setting, 'utf8')).trim();
try {
  execFileSync('/usr/sbin/sysctl', ['-w', 'user.max_user_namespaces=0']);
  assert.equal((await inspectLinuxHostCertification(allowed.options)).reason, 'host-changed');
  const denied = await certify('namespace-denied');
  assert.equal(denied.report.status, 'blocked'); assert.equal(denied.report.checks[0].reason, 'host-policy-denied');
  assert.equal((await inspectLinuxHostCertification(denied.options)).reason, 'blocked');
} finally { execFileSync('/usr/sbin/sysctl', ['-w', `user.max_user_namespaces=${previous}`]); }
assert.equal((await inspectLinuxHostCertification(allowed.options)).current, true);

const denyAllProfile = { ...profile, outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } };
const denyAll = await certify('deny-all-egress', denyAllProfile);
assert.equal(denyAll.report.status, 'passed'); assert.equal((await inspectLinuxHostCertification(denyAll.options)).current, true);
const missing = await certify('missing-image', { ...profile, image: `node@sha256:${'a'.repeat(64)}` });
assert.equal(missing.report.status, 'blocked'); assert.equal(missing.report.checks.find(check => check.capability === 'runner').status, 'blocked');
assert.deepEqual(docker('image', 'ls', '--quiet', '--no-trunc').trim().split('\n').sort(), initialImages, 'certification never pulls an image');

// Kill the parent during a real pending SQLite transaction, before any quota/network mutation.
const killedOptions = { ...selected('killed'), disposable: true, quotaId: ++id };
const child = spawn(process.execPath, ['--input-type=module', '--eval', `import {certifyLinuxHost} from './dist/host-certification.js';await certifyLinuxHost(${JSON.stringify(killedOptions)});`], { stdio: ['ignore', 'pipe', 'pipe'] });
let childError = ''; child.stderr.on('data', value => childError += value); child.stdout.on('data', () => {});
const closed = new Promise(resolve => child.once('close', resolve));
let attempt;
try {
  for (let n = 0; n < 100; n++) {
    try {
      attempt = JSON.parse(await readFile(join(killedOptions.directory, 'attempt'), 'utf8'));
      if (attempt.scratch && (await readdir(join(attempt.scratch, 'worker-migrations'))).includes('0002_rejected.sql')) break;
    } catch { /* Wait for this exact child's private attempt record and pending migration. */ }
    assert.equal(child.exitCode, null, childError); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(attempt?.scratch, 'child entered its actual worker probe');
  assert.ok((await readdir(join(attempt.scratch, 'worker-migrations'))).includes('0002_rejected.sql'));
  await new Promise(resolve => setTimeout(resolve, 250)); child.kill('SIGKILL'); await closed;
  assert.equal((await inspectLinuxHostCertification(killedOptions)).reason, 'attempt-in-progress');
  for (let n = 0; n < 50; n++) {
    if (!execFileSync('/usr/bin/ps', ['-e', '-o', 'args='], { encoding: 'utf8' }).includes(attempt.scratch)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(execFileSync('/usr/bin/ps', ['-e', '-o', 'args='], { encoding: 'utf8' }).includes(attempt.scratch), false, 'worker terminated after parent death');
  const database = new DatabaseSync(join(attempt.scratch, 'worker.sqlite'));
  try { assert.equal(database.prepare('SELECT count(*) AS n FROM proof').get().n, 1); assert.equal(database.prepare('SELECT count(*) AS n FROM clank_migrations').get().n, 1); }
  finally { database.close(); }
  const hostAttempt = JSON.parse(await readFile('/run/clank-host-certification.attempt', 'utf8'));
  assert.equal(hostAttempt.pid, child.pid); assert.equal(attempt.pid, child.pid);
  await rm(attempt.scratch, { recursive: true }); await rm(join(killedOptions.directory, 'attempt')); await rm('/run/clank-host-certification.attempt');
  assert.equal((await inspectLinuxHostCertification(killedOptions)).reason, 'missing');
  results.push({ name: 'parent-killed-during-real-sqlite', blockedAfterDeath: true, atomicRollback: true, childExited: true, explicitOwnedCleanup: true });
} finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }

// Make the guest's nft command non-executable after its exact owned policy is installed.
// This is an actual denied cleanup, and is restored only on this explicitly disposable VM.
const cleanupOptions = { ...selected('cleanup-denied'), disposable: true, quotaId: ++id };
const cleanupChild = spawn(process.execPath, ['--input-type=module', '--eval', `import {certifyLinuxHost} from './dist/host-certification.js';console.log(JSON.stringify(await certifyLinuxHost(${JSON.stringify(cleanupOptions)})));`], { stdio: ['ignore', 'pipe', 'pipe'] });
let cleanupOutput = '', cleanupError = '';
cleanupChild.stdout.on('data', value => cleanupOutput += value); cleanupChild.stderr.on('data', value => cleanupError += value);
const cleanupClosed = new Promise(resolve => cleanupChild.once('close', resolve));
const nftMode = (await stat('/usr/sbin/nft')).mode & 0o7777;
let cleanupAttempt, cleanupPlan, deniedCleanup = false;
try {
  for (let n = 0; n < 250; n++) {
    try {
      cleanupAttempt = JSON.parse(await readFile(join(cleanupOptions.directory, 'attempt'), 'utf8'));
      if (cleanupAttempt.owner) {
        // A different private directory cannot admit an old report during a host-wide probe.
        assert.equal((await inspectLinuxHostCertification(allowed.options)).reason, 'attempt-in-progress');
        cleanupPlan = await createLinuxDockerNetworkPlan(cleanupAttempt.owner, cleanupAttempt.projectId, profile.outboundNetwork);
        const tables = JSON.parse(execFileSync('/usr/sbin/nft', ['-j', 'list', 'tables'], { encoding: 'utf8' }));
        if (tables.nftables.some(entry => entry.table?.name === cleanupPlan.table)) { await chmod('/usr/sbin/nft', 0); deniedCleanup = true; break; }
      }
    } catch { /* Wait for the exact attempt's policy, never affect a foreign table. */ }
    assert.equal(cleanupChild.exitCode, null, cleanupError); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(deniedCleanup, true); await cleanupClosed;
  assert.equal(cleanupChild.exitCode, 0, cleanupError);
  const report = JSON.parse(cleanupOutput); assert.equal(report.status, 'blocked');
  assert.equal(report.checks.find(check => check.capability === 'cleanup').status, 'blocked');
  assert.equal((await inspectLinuxHostCertification(cleanupOptions)).reason, 'attempt-in-progress');
  const hostAttempt = JSON.parse(await readFile('/run/clank-host-certification.attempt', 'utf8'));
  assert.equal(hostAttempt.pid, cleanupChild.pid); assert.equal(cleanupAttempt.pid, cleanupChild.pid);
  await chmod('/usr/sbin/nft', nftMode);
  // Existing ownership-verified helper removes only the exact leftover table.
  await removeLinuxDockerNetworkPolicy(cleanupPlan, '/usr/sbin/nft');
  assert.equal(docker('container', 'ls', '--all', '--quiet', '--filter', `label=run.clank.owner=${cleanupAttempt.owner}`).trim(), '');
  assert.equal(docker('network', 'ls', '--format', '{{.Name}}').split('\n').includes(cleanupPlan.network), false);
  assert.deepEqual(await readdir(mount), []);
  await rm(join(cleanupOptions.directory, 'attempt')); await rm('/run/clank-host-certification.attempt');
  assert.equal((await inspectLinuxHostCertification(cleanupOptions)).reason, 'blocked');
  results.push({ name: 'cleanup-denied', report, persistedAttemptMarkers: true, explicitOwnedFirewallCleanup: true });
} finally {
  await chmod('/usr/sbin/nft', nftMode);
  if (cleanupChild.exitCode === null && cleanupChild.signalCode === null) { cleanupChild.kill('SIGKILL'); await cleanupClosed; }
}
assert.deepEqual(await readdir(mount), []);
assert.equal(docker('container', 'ls', '--all', '--quiet', '--filter', 'label=run.clank.managed=provider-runtime').trim(), '');
assert.equal(execFileSync('/usr/sbin/ip', ['-o', 'link', 'show'], { encoding: 'utf8' }).split('\n').some(line => /: ch[a-f0-9]{10}[:@]/.test(line)), false);
console.log(JSON.stringify({ protocol: 'clank-host-certification-acceptance/1', realGuest: true, node: process.version, cases: results, initialImages, finalMountEmpty: true, finalOwnedRuntimesEmpty: true, finalOwnedLinksEmpty: true }));
