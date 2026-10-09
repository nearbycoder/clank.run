import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../dist/platform.js';

const execute = promisify(execFile);
async function docker(args, allowFailure = false) {
  try { return { code: 0, ...await execute('/usr/bin/docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }) }; }
  catch (error) { if (!allowFailure) throw error; return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}

test('real Docker controller crash removes old web and canary workers before immediate restart admits writers', {
  skip: process.env.CLANK_DOCKER_INTEGRATION !== '1' ? 'requires CLANK_DOCKER_INTEGRATION=1 on a disposable VM' : false,
  timeout: 120_000,
}, async () => {
  assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1', 'this real-container fixture requires an explicitly disposable host');
  assert.equal(process.platform, 'linux');
  const image = process.env.CLANK_DOCKER_TEST_IMAGE ?? 'node:24-bookworm-slim';
  await docker(['image', 'inspect', image]); // Do not implicitly pull a mutable tag.
  const root = await mkdtemp(join(tmpdir(), 'clank-docker-controller-crash-'));
  const fenceDirectory = join(root, 'platform/runtime-guardians');
  const child = fork(new URL('./fixtures/platform-crash-controller.mjs', import.meta.url), [JSON.stringify({
    root, port: 4960, runner: { kind: 'docker', executable: '/usr/bin/docker', image },
  })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', platform, database, state;
  const ownedContainers = new Set();
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-32_768); });
  const childExited = new Promise(resolve => child.once('exit', resolve));
  try {
    state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Controller startup timed out: ${errors}`)), 60_000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Controller exited ${code}: ${errors}`)); });
    });
    assert.equal(state.ready, true);
    assert.ok(state.guardians.length >= 3, 'stable web, candidate web and candidate worker must be running');
    const containers = [];
    for (const guardian of state.guardians) {
      assert.match(guardian.containerName, /^clank-[A-Za-z0-9_-]+$/);
      ownedContainers.add(guardian.containerName);
      const inspected = JSON.parse((await docker(['container', 'inspect', guardian.containerName])).stdout)[0];
      assert.equal(inspected.State.Running, true);
      containers.push({ name: guardian.containerName, id: inspected.Id });
    }
    assert.ok(containers.some(container => container.name.includes('-worker-')));
    assert.equal(await fetch('http://127.0.0.1:4961/').then(response => response.text()), 'candidate');
    // The observer only selects, but a killed writer can leave a hot journal
    // whose recovery requires a writable SQLite handle.
    database = new DatabaseSync(state.databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    const oldStableBoundary = database.prepare("SELECT MAX(id) AS id FROM writer_events WHERE release='stable'").get().id;
    assert.ok(oldStableBoundary > 0);
    child.kill('SIGKILL'); await childExited;
    // No sleep: the production startup barrier must await verified old-runtime cleanup.
    platform = await openPlatform(state.options);
    for (const container of containers) {
      const inspected = await docker(['container', 'inspect', container.id], true);
      assert.equal(inspected.code, 1, `old runtime ${container.name} must no longer exist`);
      assert.match(inspected.stderr, /No such (?:container|object):/);
    }
    const candidateCount = database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='candidate'").get().count;
    assert.ok(candidateCount > 0);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='candidate'").get().count, candidateCount);
    const lastCandidate = database.prepare("SELECT MAX(id) AS id FROM writer_events WHERE release='candidate'").get().id;
    const resumedWrites = database.prepare("SELECT MIN(id) AS id, COUNT(*) AS count FROM writer_events WHERE release='stable' AND id>?");
    const writerDeadline = Date.now() + 10000;
    let resumedStable = resumedWrites.get(oldStableBoundary);
    while (resumedStable.count <= 1) {
      assert.ok(Date.now() < writerDeadline, 'the prior stable worker must resume');
      await new Promise(resolve => setTimeout(resolve, 25));
      resumedStable = resumedWrites.get(oldStableBoundary);
    }
    assert.ok(lastCandidate < resumedStable.id, 'all candidate writes must precede admission of the replacement stable worker');
    assert.equal(await platform.handle(new Request('https://crash-fixture.apps.example.test/')).then(response => response.text()), 'stable');
    database.close(); database = undefined;
    await platform.close(); platform = undefined;
    assert.deepEqual(await readdir(fenceDirectory), [], 'verified clean shutdown clears every private runtime fence');
  } finally {
    child.kill('SIGKILL'); await childExited;
    database?.close();
    await platform?.close();
    // Exact fixture-owned names only, including a launch that failed before IPC readiness.
    for (const filename of await readdir(fenceDirectory).catch(() => [])) {
      try {
        const fence = JSON.parse(await readFile(join(fenceDirectory, filename), 'utf8'));
        if (/^clank-[A-Za-z0-9_-]+$/.test(fence.containerName)) ownedContainers.add(fence.containerName);
      } catch {}
    }
    for (const name of ownedContainers) await docker(['rm', '--force', name], true);
    await rm(root, { recursive: true, force: true });
  }
});
