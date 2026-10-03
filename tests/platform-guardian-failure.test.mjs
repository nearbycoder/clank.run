import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../dist/platform.js';
import { createDeploymentBundle, deploymentDigest, parseDeploymentConfig } from '../dist/deploy.js';

// This runs real platform orchestration with a local fake daemon, never real Docker.
test('failed daemon cleanup fences initial-deploy data rollback and later writers in the same controller', {
  skip: process.platform !== 'linux', timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-guardian-failed-cleanup-'));
  const runner = join(root, 'docker.mjs'), origin = 'http://127.0.0.1:4200';
  const fixture = new URL('./fixtures/fake-docker-daemon.mjs', import.meta.url).href;
  await writeFile(runner, `#!${process.execPath}\nimport {fakeDockerDaemon} from ${JSON.stringify(fixture)};await fakeDockerDaemon(${JSON.stringify(root)});`, { mode: 0o700 });
  const platform = await openPlatform({ dataDirectory: join(root, 'platform'), publicUrl: origin,
    signup: true, appPortStart: 4970, appPortEnd: 4972, backups: { intervalMs: false },
    runner: { kind: 'docker', executable: runner, image: 'fixture-only' } });
  let database;
  try {
    const request = (path, method, body, session) => new Request(origin + path, { method,
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { cookie: session.cookie, 'x-clank-csrf': session.csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const registered = await platform.handle(request('/__clank/auth/register', 'POST', {
      email: 'guardian-failure@example.test', password: 'correct horse battery staple' }));
    assert.equal(registered.status, 201);
    const account = await registered.json(), session = { cookie: registered.headers.get('set-cookie').split(';')[0], csrf: account.csrfToken };
    const created = await platform.handle(request('/api/projects', 'POST', { name: 'Guardian failure', slug: 'guardian-failure' }, session));
    assert.equal(created.status, 201); const { project } = await created.json();
    const application = join(root, 'application');
    await mkdir(join(application, 'dist'), { recursive: true }); await mkdir(join(application, 'migrations'));
    await writeFile(join(application, 'migrations/0001_writes.sql'), 'CREATE TABLE writer_events(id INTEGER PRIMARY KEY,at INTEGER);');
    await writeFile(join(application, 'dist/server.mjs'), `import{DatabaseSync}from'node:sqlite';import{createServer}from'node:http';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);const add=db.prepare('INSERT INTO writer_events(at) VALUES(?)');add.run(Date.now());setInterval(()=>add.run(Date.now()),20);createServer((q,s)=>{s.statusCode=q.url==='/healthz'?503:200;s.end('unhealthy writer');}).listen(Number(process.env.PORT),process.env.HOST);`);
    const bytes = await createDeploymentBundle(application, parseDeploymentConfig({ version: 1,
      entry: 'dist/server.mjs', include: ['dist', 'migrations'], database: { path: 'app.sqlite', migrations: 'migrations' },
      health: { path: '/healthz', timeoutMs: 1000 }, env: {} }), { frameworkVersion: 'test', nodeVersion: process.versions.node });
    const deploy = key => platform.handle(new Request(origin + `/api/projects/${project.id}/releases`, {
      method: 'POST', headers: { origin, cookie: session.cookie, 'x-clank-csrf': session.csrf,
        'content-type': 'application/vnd.clank.deploy+gzip', 'content-length': String(bytes.byteLength),
        'x-clank-content-sha256': digest, 'x-clank-idempotency-key': key }, body: bytes }));
    const digest = await deploymentDigest(bytes);
    await writeFile(join(root, 'fail-cleanup'), 'daemon unavailable');
    const failed = await deploy('guardian-failed-initial-0001');
    assert.ok(failed.status >= 400, await failed.text());
    const fences = await readdir(join(root, 'platform/runtime-guardians'));
    assert.equal(fences.length, 1);
    const fence = JSON.parse(await readFile(join(root, 'platform/runtime-guardians', fences[0]), 'utf8'));
    assert.equal(fence.cleanupFailed, true);
    const databasePath = join(root, 'platform/projects', project.id, 'data/app.sqlite');
    assert.equal((await stat(databasePath)).isFile(), true, 'failed initial deployment must preserve data while cleanup is unverified');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const before = database.prepare('SELECT COUNT(*) AS n FROM writer_events').get().n;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(database.prepare('SELECT COUNT(*) AS n FROM writer_events').get().n > before,
      'the simulated daemon-owned writer really outlives failed client cleanup');
    const containersBefore = await readdir(join(root, 'containers'));
    const retried = await deploy('guardian-blocked-retry-0002');
    assert.ok(retried.status >= 400, await retried.text());
    assert.deepEqual(await readdir(join(root, 'containers')), containersBefore, 'retry must not create a replacement runtime');
    const deleted = await platform.handle(request(`/api/projects/${project.id}`, 'DELETE', {
      confirmation: 'delete-site guardian-failure', acknowledgeDataLoss: true }, session));
    assert.ok(deleted.status >= 400, await deleted.text());
    assert.equal((await stat(databasePath)).isFile(), true, 'unverified cleanup must also prevent project data deletion');
  } finally {
    database?.close();
    // Simulate explicit operator recovery, restricted to this fixture's exact process groups.
    for (const filename of await readdir(join(root, 'containers')).catch(() => [])) {
      const record = JSON.parse(await readFile(join(root, 'containers', filename), 'utf8'));
      if (record.pid) try { process.kill(-record.pid, 'SIGKILL'); } catch {}
    }
    await rm(join(root, 'platform/runtime-guardians'), { recursive: true, force: true });
    await mkdir(join(root, 'platform/runtime-guardians'));
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});
