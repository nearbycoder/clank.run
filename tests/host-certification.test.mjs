import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, lstat, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { certifyLinuxHost, inspectLinuxHostCertification, requireCurrentLinuxHostCertification } from '../dist/host-certification.js';

const profile = (mount) => ({ mode: 'docker-isolated', image: `node@sha256:${'a'.repeat(64)}`, user: '1000:1000',
  diskQuota: { mountDirectory: mount, hardBytes: 32 * 1024 * 1024, hardFiles: 64 },
  outboundNetwork: { allowCidrs: ['1.1.1.1/32'], hosts: { 'allowed.example.test': '1.1.1.1' } },
  networkProbe: { allowedAddress: '1.1.1.1', deniedAddress: '9.9.9.9' } });
const signed = async (directory, report) => {
  const key = await readFile(join(directory, 'key'));
  await writeFile(join(directory, 'report.json'), JSON.stringify({ report, signature: createHmac('sha256', key).update(JSON.stringify(report)).digest('hex') }));
};

// Concurrent build tests deliberately add/remove dist files. Bind this fixture
// to its own installation rather than requiring that mutable tree to stay fixed.
async function isolatedInstallation(root) {
  const installation = join(root, 'installation'), distribution = join(installation, 'dist');
  await mkdir(distribution, { recursive: true, mode: 0o700 });
  await mkdir(join(installation, 'scripts'), { mode: 0o700 });
  await writeFile(join(installation, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  const modules = (await readdir(new URL('../src/', import.meta.url)))
    .filter(name => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => name.replace(/\.tsx?$/, '.js'));
  for (const name of [...modules, 'agent-setup-prompt.js'])
    await copyFile(new URL(`../dist/${name}`, import.meta.url), join(distribution, name));
  const cli = join(installation, 'scripts/clank-provider.mjs');
  await copyFile(new URL('../scripts/clank-provider.mjs', import.meta.url), cli);
  return { cli, ...await import(pathToFileURL(join(distribution, 'host-certification.js')).href) };
}

test('certification captures only static bounded policies and rejects unsafe or unsupported input before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-cert-input-'));
  try {
    const base = { directory: join(root, 'reports'), profile: profile(root), disposable: true, quotaId: 2147481000 };
    for (const mutation of [{ disposable: false }, { quotaId: 0 }, { quotaId: 2 ** 32 }, { ttlMs: 59999 }, { ttlMs: 86400001 }]) await assert.rejects(certifyLinuxHost({ ...base, ...mutation }), TypeError);
    const profiles = [{ mode: 'trusted' }, { image: 'node:latest' }, { user: '0:0' }, { pidsLimit: 0 }, { memory: '512m; touch /tmp/invalid' }, { memory: '64m' }, { memory: '3g' }, { cpus: '0' }, { cpus: '4.1' }, { cpus: '1.0001' }, { cpus: 'auto' }, { extra: true },
      { diskQuota: { ...base.profile.diskQuota, hardBytes: 1024 } }, { diskQuota: { ...base.profile.diskQuota, hardBytes: 4 * 1024 * 1024 + 1 } },
      { diskQuota: { ...base.profile.diskQuota, hardFiles: 129 } }, { diskQuota: { ...base.profile.diskQuota, mountDirectory: '../outside' } },
      { outboundNetwork: { allowCidrs: ['1.1.1.1/24'] } }, { outboundNetwork: { allowCidrs: ['1.1.1.1/32'], hosts: { 'bad;host': '1.1.1.1' } } },
      { outboundNetwork: { allowCidrs: ['1.1.1.1/32'], hosts: { 'api.example.test': '127.0.0.1' } } },
      { networkProbe: { deniedAddress: '9.9.9.9' } }, { networkProbe: { allowedAddress: '127.0.0.1', deniedAddress: '9.9.9.9' } },
      { networkProbe: { allowedAddress: '9.9.9.9', deniedAddress: '1.1.1.1' } }, { networkProbe: { allowedAddress: '1.1.1.1', deniedAddress: '1.1.1.1' } },
      { outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '999.1.1.1' } }, { outboundNetwork: { allowCidrs: [] } }];
    for (const mutation of profiles) await assert.rejects(certifyLinuxHost({ ...base, profile: { ...base.profile, ...mutation } }), TypeError);
    for (const bad of [Object.assign(Object.create({}), base.profile), { ...base.profile, [Symbol('hidden')]: 1 }]) await assert.rejects(certifyLinuxHost({ ...base, profile: bad }), TypeError);
    let accessed = false;
    const accessor = { ...base.profile }; Object.defineProperty(accessor, 'image', { enumerable: true, get() { accessed = true; return base.profile.image; } });
    await assert.rejects(certifyLinuxHost({ ...base, profile: accessor }), TypeError); assert.equal(accessed, false);
    await assert.rejects(lstat(base.directory), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aborted actual attempts persist an authenticated blocked report; detached inspection rejects tampering, expiry and changed policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-cert-state-'));
  try {
    const { cli, certifyLinuxHost, inspectLinuxHostCertification, requireCurrentLinuxHostCertification } = await isolatedInstallation(root);
    const directory = join(root, 'reports'), selected = profile(root), signal = AbortSignal.abort();
    const report = await certifyLinuxHost({ directory, profile: selected, disposable: true, quotaId: 2147481001, signal });
    assert.equal(report.status, 'blocked'); assert.equal(report.checks.length, 7); assert.equal(report.checks.some(check => check.status === 'passed'), false);
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.checks) && Object.isFrozen(report.checks[0]));
    const text = JSON.stringify(report); assert.equal(text.includes(root), false); assert.equal(text.includes('node@'), false);
    assert.equal((await lstat(directory)).mode & 0o077, 0); assert.equal((await lstat(join(directory, 'key'))).mode & 0o077, 0);
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'blocked');
    await assert.rejects(requireCurrentLinuxHostCertification({ directory, profile: selected }), { code: 'LINUX_HOST_CERTIFICATION_REQUIRED', reason: 'blocked' });
    const config = join(root, 'config.json'); await writeFile(config, JSON.stringify({ directory, profile: selected }));
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'certification', '--config', config], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 1, child.stderr); assert.equal(JSON.parse(child.stdout).reason, 'blocked');
    assert.equal((await inspectLinuxHostCertification({ directory, profile: { ...selected, memory: '256m' } })).reason, 'policy-changed');
    const saved = await readFile(join(directory, 'report.json'), 'utf8'), envelope = JSON.parse(saved);
    envelope.report.status = 'passed'; await writeFile(join(directory, 'report.json'), JSON.stringify(envelope));
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'invalid-report');
    await writeFile(join(directory, 'report.json'), saved);
    await signed(directory, { ...report, createdAt: Date.now() - 120000, expiresAt: Date.now() - 60000 });
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'expired');
    await signed(directory, { ...report, bootUptimeMs: Math.ceil(uptime() * 1000) + 60000 });
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'expired');
    await signed(directory, { ...report, hostDigest: '0'.repeat(64) });
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'host-changed');
    await signed(directory, { ...report, checks: [...report.checks].reverse() });
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'invalid-report');
    await writeFile(join(directory, 'report.json'), saved);
    await writeFile(join(directory, 'attempt'), '{"pid":0}');
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'attempt-in-progress');
    await assert.rejects(certifyLinuxHost({ directory, profile: selected, disposable: true, quotaId: 2147481002, signal }), { code: 'EEXIST' });
    assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), saved);
    await rm(join(directory, 'attempt')); await chmod(directory, 0o755);
    await assert.rejects(inspectLinuxHostCertification({ directory, profile: selected }), /private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual non-XFS host cannot obtain a green certificate and leaves its private probe files cleaned up', { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-cert-denied-'));
  try {
    const { statfs, readdir } = await import('node:fs/promises');
    assert.notEqual(Number((await statfs(root)).type), 0x58465342, 'ordinary test root must be separate from privileged XFS fixtures');
    const directory = join(root, 'reports'), selected = profile(root);
    const report = await certifyLinuxHost({ directory, profile: selected, disposable: true, quotaId: 2147481003 });
    assert.equal(report.status, 'blocked');
    assert.equal(report.checks.find(check => check.capability === 'disk-quota').status, 'blocked');
    assert.equal(report.checks.find(check => check.capability === 'runner').reason, 'prerequisite-blocked');
    assert.deepEqual(await readdir(root), ['reports']);
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).current, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing reports, symlink storage and malformed CLI configuration fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-cert-path-'));
  try {
    const directory = join(root, 'missing'), selected = profile(root);
    assert.equal((await inspectLinuxHostCertification({ directory, profile: selected })).reason, 'missing');
    await symlink(root, join(root, 'link'));
    await assert.rejects(certifyLinuxHost({ directory: join(root, 'link', 'report'), profile: selected, disposable: true, quotaId: 1, signal: AbortSignal.abort() }));
    for (const args of [['certify'], ['certification', '--quota-id', '1'], ['certify', '--config', 'missing', '--quota-id', '1'], ['certification', '--config', 'missing', '--config', 'missing']]) {
      const child = spawnSync(process.execPath, ['scripts/clank-provider.mjs', ...args], { encoding: 'utf8' }); assert.equal(child.status, 1); assert.doesNotMatch(child.stderr, /CLANK_PROVIDER_TOKEN/);
    }
    const help = spawnSync(process.execPath, ['scripts/clank-provider.mjs', '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0); assert.match(help.stdout, /reserved-id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
