import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../dist/platform.js';

// Allow 40s for the fixture, 60s for guardian cleanup + the crashed controller's
// unmodified 30s project lease + application health, and 20s for probing/cleanup.
test('controller SIGKILL stops canary writers before immediate startup admits the prior release', { skip: process.platform !== 'linux', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-controller-crash-'));
  const child = fork(new URL('./fixtures/platform-crash-controller.mjs', import.meta.url), [JSON.stringify({ root, port: 4950 })], { stdio: ['ignore','ignore','pipe','ipc'] });
  const childExited = new Promise(resolve => child.once('exit', resolve));
  let errors = '', platform, state, database, startup; child.stderr.on('data', chunk => { errors += chunk; });
  try {
    state = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('message', ready); child.off('exit', exited); child.off('error', failed);
        if (error) reject(error); else resolve(value);
      };
      const ready = value => finish(undefined, value);
      const exited = code => finish(Error(`Controller exited ${code}: ${errors}`));
      const failed = error => finish(error);
      const timer = setTimeout(() => finish(Error(`Controller readiness timed out: ${errors}`)), 40000);
      child.once('message', ready); child.once('exit', exited); child.once('error', failed);
    });
    assert.ok(state.ready); assert.ok(state.guardians.length >= 3);
    database = new DatabaseSync(state.databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 5000');
    const priorWriterPids = database.prepare('SELECT DISTINCT pid FROM writer_events').all().map(row => row.pid);
    const priorWrites = database.prepare(`SELECT COUNT(*) AS count FROM writer_events WHERE pid IN (${priorWriterPids.map(() => '?').join(',')})`);
    const guardianDirectory = join(root, 'platform/runtime-guardians');
    const priorFences = new Set(await readdir(guardianDirectory));
    child.kill('SIGKILL'); await childExited;
    // Invoke startup immediately. It must first stop the old guardians, then
    // honor the dead controller's durable lease before admitting a replacement.
    let startupFinished = false;
    startup = openPlatform(state.options).then(value => { platform = value; return value; });
    void startup.finally(() => { startupFinished = true; }).catch(() => undefined);
    const recoveryDeadline = Date.now() + 60000, cleanupDeadline = Date.now() + 10000;
    while ((await readdir(guardianDirectory)).some(name => priorFences.has(name))) {
      assert.ok(Date.now() < cleanupDeadline, 'the crashed controller guardians must stop before recovery');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const priorWritesAfterCleanup = priorWrites.get(...priorWriterPids).count;
    while (!startupFinished) {
      assert.equal(priorWrites.get(...priorWriterPids).count, priorWritesAfterCleanup,
        'old runtime writers must stay stopped while startup waits for lease expiry');
      assert.ok(Date.now() < recoveryDeadline, 'startup must finish within the bounded lease and health budget');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await startup;
    assert.equal(priorWrites.get(...priorWriterPids).count, priorWritesAfterCleanup,
      'replacement admission must not overlap any old runtime writer');
    const before = database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='candidate'").get().count;
    assert.ok(before > 0); await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='candidate'").get().count, before);
    const stableWrites = database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='stable'");
    const stableBefore = stableWrites.get().count, writerDeadline = Date.now() + 10000;
    while (stableWrites.get().count <= stableBefore) {
      assert.ok(Date.now() < writerDeadline, 'the prior stable worker must resume writing');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    database.close(); database = undefined;
    assert.equal(await platform.handle(new Request('https://crash-fixture.apps.example.test/')).then(response => response.text()), 'stable');
    await platform.close(); platform = undefined;
    assert.deepEqual(await readdir(join(root,'platform/runtime-guardians')), []);
  } finally {
    child.kill('SIGKILL'); await childExited;
    database?.close();
    // Retain a late-resolving startup handle even when an observation fails.
    await startup?.catch(() => undefined);
    try { await platform?.close(); }
    finally { await rm(root,{recursive:true,force:true}); }
  }
});

test('unresolved private runtime fence prevents startup from admitting writers', { timeout: 12000 }, async () => {
  const root = await mkdtemp(join(tmpdir(),'clank-unresolved-runtime-'));
  try {
    await mkdir(join(root,'runtime-guardians')); await writeFile(join(root,'runtime-guardians','runtime-unresolved.json'),'{}');
    await assert.rejects(openPlatform({dataDirectory:root, publicUrl:'http://127.0.0.1:4200'}),/cleanup is unresolved/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
