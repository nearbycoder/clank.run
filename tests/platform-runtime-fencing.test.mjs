import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../dist/platform.js';
import { createDeploymentBundle, deploymentDigest, parseDeploymentConfig } from '../dist/deploy.js';

const origin = 'http://127.0.0.1:4200';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'runtime condition did not settle');
    await pause(20);
  }
}
async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('startup recovery loses its lease during health checking without publishing or starting workers', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-runtime-fencing-'));
  const hold = join(root, 'health-hold'), entered = join(root, 'health-entered'), worker = join(root, 'worker-started');
  const port = await unusedPort(), errors = [];
  const options = { dataDirectory: join(root, 'platform'), publicUrl: origin, signup: true,
    appPortStart: port, appPortEnd: port,
    ingress: { baseDomain: 'apps.example.test', domainRecheckIntervalMs: false },
    backups: { intervalMs: false }, onError: error => errors.push(error) };
  let platform, database;
  try {
    platform = await openPlatform(options);
    const request = (path, body, session) => new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { cookie: session.cookie, 'x-clank-csrf': session.csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const signup = await platform.handle(request('/__clank/auth/register', {
      email: 'runtime-fencing@example.test', password: 'correct horse battery staple',
    }));
    assert.equal(signup.status, 201);
    const account = await signup.json();
    const session = { cookie: signup.headers.get('set-cookie').split(';')[0], csrf: account.csrfToken };
    const created = await platform.handle(request('/api/projects', { name: 'Runtime fencing', slug: 'runtime-fencing' }, session));
    assert.equal(created.status, 201);
    const { project } = await created.json();
    const source = join(root, 'source');
    await mkdir(join(source, 'dist'), { recursive: true });
    await mkdir(join(source, 'migrations'));
    await writeFile(join(source, 'dist/server.mjs'), `
      import { createServer } from 'node:http';
      import { existsSync, writeFileSync } from 'node:fs';
      createServer(async (request, response) => {
        if (request.url === '/healthz' && existsSync(${JSON.stringify(hold)})) {
          writeFileSync(${JSON.stringify(entered)}, 'waiting');
          while (existsSync(${JSON.stringify(hold)})) await new Promise(resolve => setTimeout(resolve, 10));
        }
        response.end('ok');
      }).listen(Number(process.env.PORT), process.env.HOST);
    `);
    await writeFile(join(source, 'dist/worker.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(worker)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    await writeFile(join(source, 'migrations/0001_items.sql'), 'CREATE TABLE items(id INTEGER PRIMARY KEY);');
    const bytes = await createDeploymentBundle(source, parseDeploymentConfig({
      version: 1, entry: 'dist/server.mjs', include: ['dist', 'migrations'],
      database: { path: 'app.sqlite', migrations: 'migrations' },
      health: { path: '/healthz', timeoutMs: 10000 }, env: {},
      jobs: { entry: 'dist/worker.mjs', workers: 1, scheduler: false, concurrency: 1, queues: [] },
    }), { frameworkVersion: 'test', nodeVersion: process.versions.node });
    const deployed = await platform.handle(new Request(origin + `/api/projects/${project.id}/releases`, {
      method: 'POST', headers: { origin, cookie: session.cookie, 'x-clank-csrf': session.csrf,
        'content-type': 'application/vnd.clank.deploy+gzip', 'content-length': String(bytes.byteLength),
        'x-clank-content-sha256': await deploymentDigest(bytes), 'x-clank-idempotency-key': 'runtime-fencing-release-0001' }, body: bytes,
    }));
    assert.equal(deployed.status, 201, await deployed.text());
    await waitFor(() => stat(worker).then(() => true, () => false));
    await platform.close(); platform = undefined;
    await rm(worker);
    await writeFile(hold, 'hold');
    platform = await openPlatform({ ...options, startupRecovery: 'background' });
    await waitFor(() => stat(entered).then(() => true, () => false));

    database = new DatabaseSync(join(root, 'platform/control.sqlite'));
    database.exec('PRAGMA busy_timeout = 5000');
    const resource = `project:${project.id}`;
    // Model another controller taking an expired lease while this controller
    // is waiting for application health, before its ten-second renewer runs.
    const replacement = database.prepare(`UPDATE clank_distributed_leases SET
      owner='replacement-controller', token_hash='replacement-token', fence=fence+1,
      expires_at=? WHERE resource=?`).run(Date.now() + 60000, resource);
    assert.equal(Number(replacement.changes), 1);
    const releaseId = database.prepare('SELECT active_release_id FROM clank_platform_projects WHERE id=?').get(project.id).active_release_id;
    assert.equal(Number(database.prepare("UPDATE clank_platform_releases SET status='active', failure=NULL WHERE id=?").run(releaseId).changes), 1);
    await rm(hold);
    await waitFor(async () => errors.length > 0 || await stat(worker).then(() => true, () => false));
    await assert.rejects(readFile(worker), { code: 'ENOENT' }, 'rejected recovery must not start background writers');
    assert.match(String(errors[0]), /lease|availability/i);
    const guardians = join(root, 'platform/runtime-guardians');
    await waitFor(async () => (await readdir(guardians)).length === 0);
    const detail = await platform.handle(request(`/api/projects/${project.id}`, undefined, session));
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).runtime.state, 'degraded', 'stale recovery must not publish an online runtime');
    assert.deepEqual({ ...database.prepare('SELECT status,failure FROM clank_platform_releases WHERE id=?').get(releaseId) },
      { status: 'active', failure: null }, 'stale recovery must preserve the successor controller\'s release status');
    assert.equal(database.prepare('SELECT owner FROM clank_distributed_leases WHERE resource=?').get(resource).owner, 'replacement-controller');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), 'the rejected web process must stop');
    await platform.close(); platform = undefined;
    assert.deepEqual(await readdir(guardians), []);
  } finally {
    await rm(hold, { force: true });
    await platform?.close();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});
