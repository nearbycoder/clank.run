import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openPlatform } from '../../dist/platform.js';
import { createDeploymentBundle, deploymentDigest, parseDeploymentConfig } from '../../dist/deploy.js';


const origin = 'http://127.0.0.1:4200';
async function childPlatform(options) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'tests/fixtures/platform-promotion-controller.mjs', JSON.stringify(options)], { stdio: ['ignore','ignore','pipe','ipc'] });
  let sequence = 0, stderr = ''; const pending = new Map();
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  let ready, failed; const initialized = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const closed = new Promise(resolve => child.once('close', code => {
    failed(new Error(`Controller closed before ready: ${code} ${stderr}`));
    for (const entry of pending.values()) entry.reject(new Error('Owned controller stopped.')); pending.clear(); resolve();
  }));
  child.on('message', message => {
    if (message.ready) { ready(); return; }
    const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id);
    if (message.error) entry.reject(new Error('Controller request failed.'));
    else entry.resolve(new Response(message.body, { status: message.status, headers: message.headers }));
  });
  await initialized;
  return {
    async handle(request) {
      const body = request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null;
      return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject });
        child.send({ id, url: request.url, method: request.method, headers: [...request.headers], body }, error => { if (error) { pending.delete(id); reject(error); } }); });
    },
    async close() { if (child.exitCode === null && child.signalCode === null) child.send({ close: true }); await closed; },
    async kill() { child.kill('SIGKILL'); await closed; },
  };
}
export async function fixture(t, subprocess = false, overrides = {}) {
  const origin = overrides.publicUrl ?? 'http://127.0.0.1:4200';
  const root = await mkdtemp(join(tmpdir(), 'clank-environment-'));
  // Other desktop applications can occupy a previously free fixed test port.
  // Probe a fresh bounded range for this fixture; never terminate its occupant.
  let appPortStart;
  for(let attempt=0;attempt<20&&appPortStart===undefined;attempt++){
    const start=35000+Math.floor(Math.random()*25000),probes=[];
    try {
      for(let port=start;port<=start+30;port++){
        const probe=createServer();probes.push(probe);
        await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve)});
      }
      appPortStart=start;
    } catch(error){if(error.code!=='EADDRINUSE')throw error}
    finally{await Promise.all(probes.filter(probe=>probe.listening).map(probe=>new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()))))}
  }
  assert.ok(appPortStart!==undefined,'An available owned application port range is required.');
  const options = { dataDirectory: join(root, 'platform'), publicUrl: origin, signup: true,
    appPortStart, appPortEnd: appPortStart+30, backups: { intervalMs: false }, previews: { cleanupIntervalMs: false },
    ingress: { baseDomain: 'apps.example.test', domainRecheckIntervalMs: false }, ...overrides };
  const open = () => subprocess ? childPlatform(options) : openPlatform(options);
  let platform = await open();
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); await platform.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path, body, method = body === undefined ? 'GET' : 'POST', account) => new Request(origin + path, {
    method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(account ? { cookie: account.cookie, 'x-clank-csrf': account.csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = async (path, body, expected = 200, method, account = owner) => {
    const response = await platform.handle(request(path, body, method, account)), data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  const account = async email => {
    const response = await platform.handle(request('/__clank/auth/register', { email, password: 'correct horse battery staple' }));
    assert.equal(response.status, 201); const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken, user: data.user };
  };
  const owner = await account('promotion-owner@example.test');
  const create = async slug => (await call('/api/projects', { name: slug, slug }, 201)).project;
  const development = await create('development'), staging = await create('staging'), production = await create('production');
  const path = name => `/api/projects/${development.id}/environments${name ? '/' + name : ''}`;
  const bind = async (name, project, expectedVersion = 0, migrationPolicy) => (await call(path(name), { projectId: project.id, expectedVersion, ...(migrationPolicy ? { migrationPolicy } : {}) }, 200, 'PUT')).environment;
  await bind('development', development); await bind('staging', staging); await bind('production', production);
  const artifact = async (label, additional = '', settings = {}, stopWrite = '', stopBarrier = null) => {
    const source = join(root, label); await mkdir(join(source, 'dist'), { recursive: true }); await mkdir(join(source, 'migrations'));
    await writeFile(join(source, 'migrations/0001_rows.sql'), "CREATE TABLE sample(value TEXT NOT NULL); INSERT INTO sample VALUES('initial');");
    if (additional) await writeFile(join(source, 'migrations/0002_change.sql'), additional);
    await writeFile(join(source, 'dist/server.mjs'), await readFile(new URL('./platform-promotion-application.mjs', import.meta.url)));
    await writeFile(join(source, 'dist/fixture-config.json'), JSON.stringify({ label, stopWrite, stopBarrier }));
    const bytes = await createDeploymentBundle(source, parseDeploymentConfig({ version: 1, entry: 'dist/server.mjs', include: ['dist', 'migrations'],
      database: { path: 'app.sqlite', migrations: 'migrations', ...settings }, health: { path: '/healthz', timeoutMs: 5000 }, env: {} }));
    return { bytes, digest: await deploymentDigest(bytes) };
  };
  const upload = async (project, artifact, key, expected = 201) => {
    const response = await platform.handle(new Request(origin + `/api/projects/${project.id}/releases`, {
      method: 'POST', headers: { origin, cookie: owner.cookie, 'x-clank-csrf': owner.csrf,
        'content-type': 'application/vnd.clank.deploy+gzip', 'x-clank-content-sha256': artifact.digest, 'x-clank-idempotency-key': key }, body: artifact.bytes,
    })); const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data.release;
  };
  const promotion = (release, artifact, expectedActiveReleaseId = null, idempotencyKey = 'promotion_exact_request_01', expectedVersion = 1) => ({
    sourceEnvironment: 'development', releaseId: release.id, digest: artifact.digest, expectedVersion, expectedActiveReleaseId, idempotencyKey,
  });
  const probe = async (project, suffix = '', expected = 200) => {
    const response = await platform.handle(new Request(`https://${project.slug}.apps.example.test${suffix || '/'}`));
    const value=await response.json();
    if(response.status!==expected)t.diagnostic(JSON.stringify(await call(`/api/projects/${project.id}/logs`)));
    assert.equal(response.status, expected,JSON.stringify(value)); return value;
  };
  return { root, owner, options, development, staging, production, path, bind, artifact, upload, promotion, probe, account, call,
    async serve(transform) { const { serve } = await import('../../dist/node.js'); const server = await serve(async request => { const response = await platform.handle(request); return transform ? transform(request, response) : response; }, { hostname: '127.0.0.1', port: overrides.publicUrl ? Number(new URL(origin).port) : 0 }); servers.push(server); return `http://127.0.0.1:${server.port}`; },
    async restart() { await platform.close(); platform = await open(); },
    async killAndRestart() { assert.ok(subprocess); await platform.kill(); platform = await open(); },
  };
}
