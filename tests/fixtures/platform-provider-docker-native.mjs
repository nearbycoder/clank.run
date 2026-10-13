import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentBundle, deploymentDigest } from '../../dist/index.js';
import { createLinuxDockerNetworkPlan } from '../../dist/linux-project-isolation.js';
import { reservePlatformTestPorts } from './platform-test-ports.mjs';

const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = name => existsSync('/usr/bin/' + name) ? '/usr/bin/' + name : '/usr/sbin/' + name;
async function command(name, args, allowFailure = false) {
  try { return { code: 0, ...await execute(executable(name), args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }) }; }
  catch (error) { if (!allowFailure) throw error; return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
async function until(check, description, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; assert.ok(Date.now() < deadline, description); await pause(50); }
}
async function ownedContainers(owner, projectId) {
  const result = await command('docker', ['container', 'ls', '--all', '--quiet', '--filter', 'label=run.clank.owner=' + owner,
    ...(projectId ? ['--filter', 'label=run.clank.project=' + projectId] : [])]);
  return result.stdout.trim().split('\n').filter(Boolean);
}
async function jsonResponse(response, context) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Owned fixture expected JSON: ' + JSON.stringify({ context, url: response.url, status: response.status, contentType: response.headers.get('content-type'), prefix: text.slice(0, 120) })); }
}
function applicationRequest(origin, method, path, headers) {
  // Native fetch deliberately replaces a caller-supplied Host on both supported
  // runtimes. Use the actual HTTP transport to send the managed application host.
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin + path, { method, headers: { host: 'docker-canary.apps.example.test', ...headers } }, incoming => {
      const chunks = []; let size = 0;
      incoming.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { request.destroy(new Error('Owned application response exceeds bound.')); return; } chunks.push(chunk); });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Owned application request timed out.')));
    request.on('error', reject); request.end(method === 'POST' ? 'write' : undefined);
  });
}
function worker(role, rootOperator = false) {
  const framework = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const restrictions = ['--reuid=1000', '--regid=1000', '--clear-groups', ...(role === 'provider'
    ? ['--inh-caps=+sys_admin,+net_admin,+dac_override', '--ambient-caps=+sys_admin,+net_admin,+dac_override', '--bounding-set=-all,+sys_admin,+net_admin,+dac_override']
    : ['--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all']), '--no-new-privs', process.execPath,
    join(framework, 'tests/fixtures/platform-provider-canary-docker-worker.mjs'), role];
  const child = rootOperator
    ? spawn(process.execPath, [join(framework, 'tests/fixtures/platform-provider-canary-docker-worker.mjs'), role], { cwd: framework,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', NODE_NO_WARNINGS: '1', CLANK_SHADOW_OPERATOR_ROOT: '1' } })
    : spawn(role === 'provider' ? '/usr/bin/unshare' : '/usr/bin/setpriv', role === 'provider'
      ? ['--mount', '--propagation', 'private', '/usr/bin/setpriv', ...restrictions] : restrictions,
      { cwd: framework, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', NODE_NO_WARNINGS: '1' } });
  let sequence = 0, stderr = ''; const pending = new Map();
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`Owned ${role} exited (${code}/${signal}): ${stderr}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  child.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  child.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.value); });
  return { child, exited, rpc(method, input) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Owned ${role} ${method} timed out: ${stderr}`)); }, 90000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, method, input }, error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
    });
  } };
}

const application = `
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
const config=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
const writer=process.env.CANARY_FIXTURE_WRITER==='1';
const database=new DatabaseSync('/data/app.sqlite',{readOnly:!writer});
database.exec('PRAGMA busy_timeout=5000');
const insert=kind=>database.prepare('INSERT INTO events(label,kind) VALUES(?,?)').run(config.label,kind);
const attempt=async action=>{try{await action();return{ok:true}}catch(error){return{ok:false,code:error.code,message:error.message}}};
if(writer)insert('startup');
createServer(async(request,response)=>{
 const path=new URL(request.url,'http://localhost').pathname;
 if(!writer)console.log(JSON.stringify({kind:'candidate-request',method:request.method,path,headers:request.headers}));
 if(path==='/healthz'){response.end('ok');return;}
 let result={label:config.label,writer,secretPresent:process.env.CANARY_FIXTURE_SECRET!==undefined};
 if(path==='/write'&&request.method==='POST'){insert('after-checkpoint');result.written=true;}
 if(!writer)result={...result,sqlite:await attempt(()=>insert('forbidden-candidate-write')),file:await attempt(()=>writeFile('/data/forbidden','forbidden')),headers:request.headers};
 result.rows=database.prepare('SELECT label,kind FROM events ORDER BY id').all();
 response.statusCode=config.status;
 response.setHeader('content-type','application/json');
 response.setHeader('set-cookie','canary-fixture=must-not-escape');
 response.setHeader('clear-site-data','"cookies"');
 response.end(JSON.stringify(result));
}).listen(Number(process.env.PORT),process.env.HOST);
`;
async function artifact(root, label, status = 200) {
  const directory = join(root, 'artifact-' + label);
  await mkdir(join(directory, 'dist'), { recursive: true }); await mkdir(join(directory, 'migrations'));
  await writeFile(join(directory, 'dist/server.mjs'), application);
  await writeFile(join(directory, 'dist/fixture.json'), JSON.stringify({ label, status }));
  await writeFile(join(directory, 'migrations/0001_events.sql'), 'CREATE TABLE events(id INTEGER PRIMARY KEY,label TEXT NOT NULL,kind TEXT NOT NULL);');
  return createDeploymentBundle(directory, { version: 1, entry: 'dist/server.mjs', include: ['dist', 'migrations'],
    database: { path: 'app.sqlite', migrations: 'migrations', allowUnsafeMigrations: false }, health: { path: '/healthz', timeoutMs: 10000 }, env: {} });
}
async function fixture(t, stages = [{ trafficPercent: 50, durationMs: 3000, minimumSamples: 5 }, { trafficPercent: 100, durationMs: 1500, minimumSamples: 5 }], fixtureOptions = {}) {
  assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1');
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(existsSync('/etc/clank-disposable-test-host'), true, 'The disposable-host marker must precede privileged effects.');
  const image = process.env.CLANK_DOCKER_TEST_IMAGE ?? 'node:24-bookworm-slim';
  await command('docker', ['image', 'inspect', image]); // No implicit pull.
  const ports = await reservePlatformTestPorts(), root = await mkdtemp(join(tmpdir(), 'clank-platform-docker-canary-'));
  const children = [], plans = new Map(), owner = 'platform-canary-' + randomUUID().replaceAll('-', '').slice(0, 16);
  const providerRoot = join(root, 'provider'), platformRoot = join(root, 'platform');
  let platform, provider, control, project;
  t.after(async () => {
    try {
      if (provider?.child.connected) { await provider.rpc('stop-agent').catch(() => {}); }
      for (const child of children) if (child.child.connected) await child.rpc('close').catch(() => {});
    } finally {
      for (const child of children) { if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL'); await child.exited; }
      control?.close();
      for (const id of await ownedContainers(owner)) await command('docker', ['container', 'rm', '--force', id], true);
      if (project) {
        try { const journal = JSON.parse(await readFile(join(providerRoot, 'service', project.id + '.canary.json'), 'utf8')); plans.set(journal.current.candidateProjectId, await createLinuxDockerNetworkPlan(owner, journal.current.candidateProjectId, { allowCidrs: [] })); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const plan of plans.values()) { await command('docker', ['network', 'rm', plan.network], true); await command('nft', ['delete', 'table', 'inet', plan.table], true); }
      await rm(root, { recursive: true, force: true }); await ports.release();
    }
  });
  // SQLite workers drop all capabilities; uid1000 must traverse every private ancestor.
  await chown(root, 1000, 1000);
  for (const directory of [providerRoot, platformRoot]) { await mkdir(directory, { mode: 0o700 }); await chown(directory, 1000, 1000); }
  const origin = 'http://127.0.0.1:' + ports.start, endpoint = 'http://127.0.0.1:' + (ports.start + 1);
  const registrationToken = 'owned-docker-canary-registration-12345678901234567890';
  async function startPlatform(disabled = false) {
    const next = worker('platform', Boolean(fixtureOptions.shadowCertificate)); children.push(next);
    await next.rpc('open', { root: platformRoot, origin, port: ports.start, appPortStart: ports.start + 12, appPortEnd: ports.end, registrationToken, stages, disabled, ...fixtureOptions });
    await until(async () => (await next.rpc('status')).supervisor.state === 'leader', 'Native supervisor leadership and startup cleanup', 90000);
    return next;
  }
  platform = await startPlatform(); provider = worker('provider'); children.push(provider);
  await provider.rpc('open', { root: providerRoot, origin, endpoint, port: ports.start + 1, portStart: ports.start + 2, portEnd: ports.start + 10, registrationToken, owner, image });
  async function json(path, { method = 'GET', body, token, cookie, csrf } = {}, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-clank-csrf': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    const value = await jsonResponse(response, method + ' ' + path); assert.equal(response.status, expected, JSON.stringify(value)); return { value, response };
  }
  const registered = await json('/__clank/auth/register', { method: 'POST', body: { email: 'docker-canary@example.test', password: 'correct horse battery staple', profile: { name: 'Docker canary' } } }, 201);
  const cookie = registered.response.headers.get('set-cookie').split(';')[0], csrf = registered.value.csrfToken;
  const started = (await json('/api/device/start', { method: 'POST', body: { clientName: 'Owned Docker canary acceptance' } }, 201)).value;
  await json('/api/device/approve', { method: 'POST', body: { code: started.userCode }, cookie, csrf });
  const token = (await json('/api/device/token', { method: 'POST', body: { deviceCode: started.deviceCode } })).value.accessToken;
  project = (await json('/api/projects', { method: 'POST', token, body: { name: 'Docker canary', slug: 'docker-canary', placement: 'provider' } }, 201)).value.project;
  plans.set(project.id, await createLinuxDockerNetworkPlan(owner, project.id, { allowCidrs: [] }));
  await json('/api/projects/' + project.id + '/secrets', { method: 'PUT', token, body: { values: { CANARY_FIXTURE_WRITER: '1', CANARY_FIXTURE_SECRET: 'primary-only-owned-fixture' } } });
  control = new DatabaseSync(join(platformRoot, 'control.sqlite')); control.exec('PRAGMA busy_timeout=5000');
  const f = {
    root, providerRoot, owner, project, control, provider, origin, cookie, csrf, user: registered.value.user, session: registered.value.session, json,
    raw() { const row = control.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(project.id); return row ? { ...row, operation: JSON.parse(row.operation) } : null; },
    async deploy(bytes, key) {
      const response = await fetch(origin + '/api/projects/' + project.id + '/releases', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/vnd.clank.deploy+gzip', 'content-length': String(bytes.byteLength), 'x-clank-content-sha256': await deploymentDigest(bytes), 'x-clank-idempotency-key': key }, body: bytes, signal: AbortSignal.timeout(120000) });
      return { status: response.status, body: await jsonResponse(response, 'POST release ' + key) };
    },
    async traffic(method = 'GET', path = '/', headers = {}) {
      const response = await applicationRequest(origin, method, path, headers);
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Owned application routing failed: ' + JSON.stringify({ method, path, sentHost: 'docker-canary.apps.example.test', status: response.status, contentType: response.headers.get('content-type'), prefix: (await response.text()).slice(0, 120), platform: await platform.rpc('status') }));
      }
      return response;
    },
    async drive(pending, samples = []) {
      let done = false; const result = pending.finally(() => { done = true; }); result.catch(() => {});
      while (!done) { await Promise.all(Array.from({ length: 4 }, async () => { const response = await f.traffic(); const body = await response.json(); if (!body.writer && body.label) samples.push({ body, headers: Object.fromEntries(response.headers), status: response.status }); })); await pause(40); }
      return result;
    },
    async state() { return (await json('/api/projects/' + project.id + '/canary', { token })).value; },
    async recover() { const state = await f.state(); return (await json('/api/projects/' + project.id + '/canary/recover', { method: 'POST', token, body: { operationId: state.provider.operationId, expectedEpoch: state.provider.controllerEpoch } })).value; },
    async held(action) { await until(async () => (await provider.rpc('status')).gates[action] > 0, 'Provider received complete held ' + action + ' request'); },
    async candidate() {
      const op = f.raw().operation; assert.ok(op.primary && op.capsuleSha256);
      const id = 'canary_' + createHash('sha256').update([op.primary.projectId, op.primary.incarnation, op.controllerEpoch, op.operationId, op.capsuleSha256].join('\n')).digest('hex');
      if (!plans.has(id)) plans.set(id, await createLinuxDockerNetworkPlan(owner, id, { allowCidrs: [] })); return id;
    },
    async absent(id) {
      assert.deepEqual(await ownedContainers(owner, id), [], 'Candidate containers must be absent.');
      assert.equal(existsSync(join(providerRoot, 'projects', id)), false, 'Candidate data must be absent.');
      const plan = plans.get(id); assert.ok(plan);
      assert.notEqual((await command('docker', ['network', 'inspect', plan.network], true)).code, 0, 'Candidate bridge must be absent.');
      assert.notEqual((await command('nft', ['list', 'table', 'inet', plan.table], true)).code, 0, 'Candidate nft policy must be absent.');
    },
    async restartDisabled() {
      await provider.rpc('stop-agent'); platform.child.kill('SIGKILL'); assert.equal((await platform.exited).signal, 'SIGKILL');
      // No clock or lease-row edits: real project lease expiry gates takeover.
      platform = await startPlatform(true); await provider.rpc('start-agent');
    },
  };
  const initial = await f.deploy(await artifact(root, 'primary'), 'docker-canary-primary-0001');
  assert.equal(initial.status, 201, JSON.stringify({ initial, provider: await provider.rpc('status'), platform: await platform.rpc('status') }));
  await until(() => !control.prepare("SELECT 1 FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased')").get(project.id), 'Primary operation completion');
  assert.equal((await (await f.traffic()).json()).writer, true);
  return f;
}


export { fixture, artifact, command, until, ownedContainers };
