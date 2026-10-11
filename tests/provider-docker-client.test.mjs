import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerDockerClient, runProviderDockerClient } from '../dist/provider-docker-client.js';

const fixture = fileURLToPath(new URL('./fixtures/provider-docker-client.mjs', import.meta.url));
async function observeChild(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'clank-docker-client-'));
  const statePath = join(directory, 'child.json');
  const original = childProcess.spawn;
  let child, exit, spawnError, close;
  childProcess.spawn = function (executable, args, options) {
    const selected = executable === process.execPath && args[0] === fixture && args[2] === statePath;
    // Reject an unexpected retry before it can create an untracked child.
    if (selected) assert.equal(child, undefined, 'one actual owned subprocess');
    const spawned = original.call(this, executable, args, options);
    if (selected) {
      child = spawned;
      child.once('exit', (code, signal) => { exit = { code, signal }; });
      child.once('error', error => { spawnError = error; });
      close = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    }
    return spawned;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (close) await close;
    await rm(directory, { recursive: true, force: true });
  });
  const client = providerDockerClient({ executable: process.execPath });
  return {
    invoke: () => runProviderDockerClient(client, [fixture, mode, statePath], { timeoutMs: 1000, maxOutputBytes: 1024 }),
    async assertSettled(expected) {
      assert.ok(child, 'the real spawn was observed');
      assert.equal(spawnError, undefined);
      assert.deepEqual(exit, expected, 'client settles only after actual child exit');
      assert.deepEqual(await close, expected, 'actual stdio close also settles');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { pid: child.pid, mode });
      t.diagnostic(JSON.stringify({ mode, pid: child.pid, exit: expected, stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed }));
      assert.equal(child.stdout.closed, true);
      assert.equal(child.stderr.closed, true);
    },
  };
}

test('Docker client preserves natural exit and complete bounded output', { timeout: 10000 }, async t => {
  const observed = await observeChild(t, 'ordinary');
  assert.deepEqual(await observed.invoke(), { stdout: 'ordinary output\n', stderr: 'ordinary diagnostic\n', code: 0 });
  await observed.assertSettled({ code: 0, signal: null });
});

test('Docker client deadline observes stream rejection before awaiting actual child exit', { timeout: 10000 }, async t => {
  const observed = await observeChild(t, 'deadline');
  await assert.rejects(observed.invoke(), { message: 'Docker command deadline exceeded.' });
  await observed.assertSettled({ code: null, signal: 'SIGKILL' });
});

for (const mode of ['stdout-overflow', 'stderr-overflow', 'combined-overflow']) {
  test('Docker client bounds ' + mode + ' and settles the owned child', { timeout: 10000 }, async t => {
    const observed = await observeChild(t, mode);
    await assert.rejects(observed.invoke(), { message: 'Docker command output exceeded its configured limit.' });
    await observed.assertSettled({ code: null, signal: 'SIGKILL' });
  });
}
