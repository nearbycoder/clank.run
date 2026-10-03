import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDockerDeploymentRuntimeLauncher } from '../dist/provider-docker.js';
import { createLinuxDockerNetworkPlan } from '../dist/linux-project-isolation.js';
import { parseDeploymentConfig } from '../dist/deploy.js';

const executable = (name) => existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : `/usr/sbin/${name}`;
const run = promisify(execFile);
const command = async (name, args, allowFailure = false) => {
  try { return { code: 0, ...await run(executable(name), args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }) }; }
  catch (error) { if (!allowFailure) throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
};

test('real Docker runtime enforces filesystem/process restrictions, outbound policy, and exact cleanup', {
  skip: process.env.CLANK_DOCKER_INTEGRATION !== '1' ? 'requires CLANK_DOCKER_INTEGRATION=1 on a disposable VM' : false,
  timeout: 120_000,
}, async () => {
  assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1', 'this privileged network fixture must run on an explicitly disposable host');
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const image = process.env.CLANK_DOCKER_TEST_IMAGE ?? 'node:24-bookworm-slim';
  await command('docker', ['image', 'inspect', image]); // Never implicitly pull images.
  const suffix = process.pid.toString(16), hostLink = `cth${suffix}`, peerLink = `ctp${suffix}`;
  const root = await mkdtemp(join(tmpdir(), 'clank-real-docker-'));
  const owner = `integration-${suffix}`, projectId = 'integration_project', releaseId = 'integration_release';
  const plan = await createLinuxDockerNetworkPlan(owner, projectId, { allowCidrs: ['1.1.1.1/32'], hosts: { 'allowed.example.test': '1.1.1.1' } });
  const remote = spawn('/usr/bin/unshare', ['--net', process.execPath, '--eval', "require('node:http').createServer((q,s)=>s.end('endpoint')).listen(40219,'0.0.0.0',()=>console.log('ready'));"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let remoteError = ''; remote.stderr.on('data', (bytes) => { remoteError += bytes; });
  let launcher, host;
  const addresses = ['1.1.1.1', '9.9.9.9', '10.99.0.3', '169.254.169.254'];
  const inside = (args) => command('nsenter', ['--target', String(remote.pid), '--net', executable('ip'), ...args]);
  try {
    await new Promise((resolve, reject) => { remote.stdout.once('data', resolve); remote.once('error', reject); remote.once('exit', (code) => reject(new Error(`endpoint namespace exited ${code}: ${remoteError}`))); });
    await command('ip', ['link', 'add', hostLink, 'type', 'veth', 'peer', 'name', peerLink]);
    await command('ip', ['addr', 'add', '10.201.0.1/24', 'dev', hostLink]);
    await command('ip', ['link', 'set', hostLink, 'up']);
    await command('ip', ['link', 'set', peerLink, 'netns', String(remote.pid)]);
    await inside(['addr', 'add', '10.201.0.2/24', 'dev', peerLink]);
    await inside(['link', 'set', peerLink, 'up']); await inside(['link', 'set', 'lo', 'up']);
    await inside(['route', 'add', 'default', 'via', '10.201.0.1']);
    for (const address of addresses) {
      await inside(['addr', 'add', `${address}/32`, 'dev', 'lo']);
      await command('ip', ['route', 'add', `${address}/32`, 'via', '10.201.0.2']);
    }
    await command('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
    host = createServer((_request, response) => response.end('host'));
    await new Promise((resolve) => host.listen(40219, '0.0.0.0', resolve));
    // Real positive controls: every destination works from a Docker container
    // before a policy exists, so broken routing cannot satisfy denial checks.
    const before = await command('docker', ['run', '--rm', '--network', 'bridge', image, 'node', '--input-type=module', '--eval',
      `for(const host of ${JSON.stringify(addresses)}){const value=await fetch('http://'+host+':40219',{signal:AbortSignal.timeout(2000)}).then(r=>r.text());if(value!=='endpoint')throw Error(host);console.log(host)}`]);
    assert.equal(before.stdout.trim().split('\n').length, addresses.length);
    const providerRoot = join(root, 'provider'), project = join(providerRoot, 'projects', projectId);
    const releaseDirectory = join(project, 'generations', `g1-${releaseId}`), data = join(project, 'data');
    await mkdir(join(releaseDirectory, 'dist'), { recursive: true, mode: 0o700 });
    await mkdir(join(releaseDirectory, 'migrations'), { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
    await writeFile(join(root, 'host-secret'), 'must never be mounted', { mode: 0o600 });
    await writeFile(join(data, 'app.sqlite'), '', { mode: 0o600 });
    await writeFile(join(releaseDirectory, 'dist', 'server.mjs'), `
      import {createServer} from 'node:http'; import {readFile,writeFile,rm} from 'node:fs/promises';
      const attempt=async(fn)=>{try{await fn();return 'ok'}catch(e){return e.code??e.name}};
      createServer(async(q,s)=>{
        const url=new URL(q.url,'http://localhost'); let value='ok';
        if(url.pathname==='/probe') {try{value={ok:true,body:await fetch(url.searchParams.get('url'),{signal:AbortSignal.timeout(700)}).then(r=>r.text())}}catch(e){value={ok:false}}}
        if(url.pathname==='/isolation') value={uid:process.getuid(),status:await readFile('/proc/self/status','utf8'),
          app:await attempt(()=>writeFile('/app/write-denied','bad')),root:await attempt(()=>writeFile('/etc/write-denied','bad')),
          data:await attempt(()=>writeFile('/data/write-ok','ok')),host:await attempt(()=>readFile(${JSON.stringify(join(root, 'host-secret'))})),
          tmp:await attempt(()=>writeFile('/tmp/oversized',Buffer.alloc(80*1024*1024)))};
        if(url.pathname==='/isolation') await rm('/tmp/oversized',{force:true});
        s.setHeader('content-type','application/json');s.end(JSON.stringify(value));
      }).listen(Number(process.env.PORT),process.env.HOST);
    `, { mode: 0o600 });
    const own = async (directory) => { await chown(directory, 1000, 1000); for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name); if (entry.isDirectory()) await own(file); else await chown(file, 1000, 1000);
    } };
    await own(releaseDirectory); await own(data);
    const config = parseDeploymentConfig({ version: 1, entry: 'dist/server.mjs', include: ['dist', 'migrations'], database: { path: 'app.sqlite', migrations: 'migrations' }, health: { path: '/healthz', timeoutMs: 10_000 }, env: {} });
    launcher = await openDockerDeploymentRuntimeLauncher({ rootDirectory: providerRoot, owner, image, allowMutableImage: true,
      user: '1000:1000', portStart: 25310, portEnd: 25315, stopTimeoutMs: 1000,
      outboundNetwork: { allowCidrs: ['1.1.1.1/32'], hosts: { 'allowed.example.test': '1.1.1.1' } } });
    const candidate = await launcher.launch({ signal: new AbortController().signal, prepared: {
      projectId, releaseId, generation: 1, fence: 1, capsuleSha256: 'a'.repeat(64), releaseDirectory, databasePath: join(data, 'app.sqlite'), config,
      environment: { APP_SECRET: 'runtime-only-sensitive-value' }, ingress: { route: `/v1/clank/apps/${projectId}`, token: 'integration-runtime-token-long-enough' },
      migrationCount: 0, previous: null, alreadyCommitted: false,
    } });
    launcher.commit(candidate);
    const isolation = await fetch(`${candidate.upstream}/isolation`).then((response) => response.json());
    assert.equal(isolation.uid, 1000); assert.match(isolation.status, /^CapEff:\s+0+$/m); assert.match(isolation.status, /^NoNewPrivs:\s+1$/m);
    assert.equal(isolation.app, 'EROFS'); assert.equal(isolation.root, 'EROFS'); assert.equal(isolation.data, 'ok'); assert.equal(isolation.host, 'ENOENT'); assert.equal(isolation.tmp, 'ENOSPC');
    const network = JSON.parse((await command('docker', ['network', 'inspect', plan.network])).stdout)[0];
    assert.equal(network.EnableIPv6, false); const gateway = network.IPAM.Config[0].Gateway;
    const probe = (url) => fetch(`${candidate.upstream}/probe?url=${encodeURIComponent(url)}`).then((response) => response.json());
    assert.deepEqual(await probe('http://allowed.example.test:40219'), { ok: true, body: 'endpoint' });
    for (const address of [...addresses.slice(1), gateway]) assert.deepEqual(await probe(`http://${address}:40219`), { ok: false }, address);
    const containers = (await command('docker', ['container', 'ls', '--all', '--quiet', '--filter', `label=run.clank.owner=${owner}`])).stdout.trim().split('\n').filter(Boolean);
    assert.equal(containers.length, 1);
    const inspected = JSON.parse((await command('docker', ['container', 'inspect', containers[0]])).stdout)[0];
    assert.equal(JSON.stringify(inspected.Config).includes('runtime-only-sensitive-value'), false);
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true); assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
    assert.equal(await launcher.stop(projectId, 1), true);
    assert.equal((await command('docker', ['container', 'ls', '--all', '--quiet', '--filter', `label=run.clank.owner=${owner}`])).stdout.trim(), '');
    assert.notEqual((await command('docker', ['network', 'inspect', plan.network], true)).code, 0);
    assert.notEqual((await command('nft', ['list', 'table', 'inet', plan.table], true)).code, 0);
  } finally {
    await launcher?.close();
    if (host) await new Promise((resolve) => host.close(resolve));
    for (const address of addresses) await command('ip', ['route', 'del', `${address}/32`, 'via', '10.201.0.2'], true);
    await command('ip', ['link', 'del', hostLink], true); remote.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
