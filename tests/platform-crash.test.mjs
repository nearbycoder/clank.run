import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../dist/platform.js';

test('controller SIGKILL stops canary writers before immediate startup admits the prior release', { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-controller-crash-'));
  const child = fork(new URL('./fixtures/platform-crash-controller.mjs', import.meta.url), [JSON.stringify({ root, port: 4950 })], { stdio: ['ignore','ignore','pipe','ipc'] });
  let errors = '', platform, state, database; child.stderr.on('data', chunk => { errors += chunk; });
  try {
    state = await new Promise((resolve,reject) => { child.once('message', resolve); child.once('exit', code => reject(Error(`Controller exited ${code}: ${errors}`))); });
    assert.ok(state.ready); assert.ok(state.guardians.length >= 3);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    // openPlatform itself must wait for the private guardian fences, before launching any replacement.
    platform = await openPlatform(state.options);
    database = new DatabaseSync(state.databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 5000');
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
  } finally { child.kill('SIGKILL'); database?.close(); await platform?.close(); await rm(root,{recursive:true,force:true}); }
});

test('unresolved private runtime fence prevents startup from admitting writers', { timeout: 12000 }, async () => {
  const root = await mkdtemp(join(tmpdir(),'clank-unresolved-runtime-'));
  try {
    await mkdir(join(root,'runtime-guardians')); await writeFile(join(root,'runtime-guardians','runtime-unresolved.json'),'{}');
    await assert.rejects(openPlatform({dataDirectory:root, publicUrl:'http://127.0.0.1:4200'}),/cleanup is unresolved/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
