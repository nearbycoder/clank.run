import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, backupSQLite } from '../dist/migrations.js';
import { runSQLiteTask, SQLiteTaskScheduler } from '../dist/sqlite-task.js';
import { pinSQLiteDirectory, prepareSQLiteSandbox } from '../dist/sqlite-sandbox.js';

const linux = { skip: process.platform !== 'linux' };

test('SQLite host namespace denial is actionable without exposing arbitrary worker stderr', linux, async t => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-diagnostic-'));
  try {
    for (const [diagnostics, expected] of [
      ['bwrap: Creating new namespace failed: Permission denied\n', 'SQLITE_ISOLATION_UNAVAILABLE'],
      ['private-tenant-data '+ 'x'.repeat(10000), undefined],
    ]) {
      const mocked = t.mock.method(childProcess, 'spawn', () => {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } }); child.kill = () => true;
        setImmediate(() => { child.stderr.end(diagnostics); child.stdout.end(); child.emit('close', 1); }); return child;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(runSQLiteTask('inspection', 'inspectSQLite', [join(root, 'app.sqlite')]), error => {
          assert.equal(error.code, expected); assert.doesNotMatch(error.message, /private-tenant-data/u);
          if (expected) assert.match(error.message, /host policy denied Linux namespaces/u);
          return true;
        });
      } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
function execute(sandbox) {
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox.executable, sandbox.arguments, { stdio: ['ignore', 'pipe', 'pipe', ...sandbox.descriptors], env: {} });
    let stdout = '', stderr = '';
    child.stdout.on('data', (value) => stdout += value);
    child.stderr.on('data', (value) => stderr += value);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr} ${stdout}`)));
  });
}

test('SQLite namespace denies hostile SQL and database symlinks outside the tenant', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-sql-'));
  const tenant = join(root, 'tenant'), outside = join(root, 'outside');
  await mkdir(tenant); await mkdir(outside);
  const secret = join(outside, 'private.sqlite');
  const database = new DatabaseSync(secret);
  database.exec("CREATE TABLE secrets(value TEXT); INSERT INTO secrets VALUES('host-secret');"); database.close();
  const before = await readFile(secret);
  try {
    const directory = join(tenant, 'migrations'); await mkdir(directory);
    await writeFile(join(directory, '0001_escape.sql'), `ATTACH DATABASE '${secret}' AS escaped; DELETE FROM escaped.secrets;`);
    await assert.rejects(applyMigrations({ path: join(tenant, 'app.sqlite'), directory, allowUnsafe: true }), /unable to open|database/u);
    assert.deepEqual(await readFile(secret), before);
    await symlink(secret, join(tenant, 'linked.sqlite'));
    await assert.rejects(runSQLiteTask('inspection', 'inspectSQLite', [join(tenant, 'linked.sqlite')]), /unable to open/u);
    await symlink(outside, join(tenant, 'linked-directory'));
    await assert.rejects(runSQLiteTask('inspection', 'inspectSQLite', [join(tenant, 'linked-directory', 'private.sqlite')]), /ENOTDIR|ELOOP/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned namespace remains on original inode when tenant ancestors are replaced', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-pin-'));
  const tenant = join(root, 'tenant'), outside = join(root, 'outside');
  await mkdir(tenant); await mkdir(outside);
  await writeFile(join(tenant, 'identity'), 'tenant'); await writeFile(join(outside, 'identity'), 'outside');
  const script = `const fs=require('node:fs'); console.log(fs.readFileSync(${JSON.stringify(join(tenant, 'identity'))},'utf8')); try { fs.readFileSync(${JSON.stringify(join(outside, 'identity'))}); process.exit(99); } catch {}`;
  const sandbox = await prepareSQLiteSandbox('inspection', 'inspectSQLite', [join(tenant, 'app.sqlite')], ['--jitless', '--eval', script]);
  try {
    await rename(tenant, join(root, 'original')); await symlink(outside, tenant);
    assert.equal((await execute(sandbox)).trim(), 'tenant');
  } finally { await sandbox.close(); await rm(root, { recursive: true, force: true }); }
});

test('SQLite namespace has no host network and cannot write host runtime or siblings', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-net-'));
  const tenant = join(root, 'tenant'); await mkdir(tenant);
  await writeFile(join(root, 'outside'), 'host-only');
  const script = `const fs=require('node:fs'),os=require('node:os'); const names=Object.keys(os.networkInterfaces()); if(names.some(n=>n!=='lo'))process.exit(2); for(const path of ['/usr/bin/prlimit','/runtime/framework/sqlite-task.js']) { try { fs.writeFileSync(path,'escape'); process.exit(3); } catch {} } fs.writeFileSync(${JSON.stringify(join(root, 'outside'))},'sandbox-only'); console.log('confined');`;
  const sandbox = await prepareSQLiteSandbox('inspection', 'sanitizePreviewDatabase', [join(tenant, 'app.sqlite')], ['--jitless', '--eval', script]);
  try { assert.equal((await execute(sandbox)).trim(), 'confined'); assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'host-only'); }
  finally { await sandbox.close(); await rm(root, { recursive: true, force: true }); }
});

test('SQLite publication pins its destination parent against swapped ancestors', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-publish-'));
  const tenant = join(root, 'tenant'); await mkdir(tenant);
  const pin = await pinSQLiteDirectory(tenant);
  try {
    await rename(tenant, join(root, 'original'));
    await mkdir(tenant);
    await writeFile(`${pin.anchor}/original`, 'safe');
    assert.equal(await readFile(join(root, 'original', 'original'), 'utf8'), 'safe');
    await assert.rejects(readFile(join(tenant, 'original')), /ENOENT/u);
  } finally { await pin.close(); await rm(root, { recursive: true, force: true }); }
});

test('backup finalization never chmods attacker-provided destination sidecar symlinks', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-backup-'));
  const tenant = join(root, 'tenant'), outside = join(root, 'outside'); await mkdir(tenant); await mkdir(outside);
  const source = join(tenant, 'source.sqlite'), target = join(tenant, 'backup.sqlite');
  const database = new DatabaseSync(source); database.exec('CREATE TABLE records(value TEXT)'); database.close();
  const secret = join(outside, 'secret'); await writeFile(secret, 'unchanged');
  await symlink(secret, `${target}-wal`); await symlink(secret, `${target}-shm`);
  try { await backupSQLite(source, target); assert.equal(await readFile(secret, 'utf8'), 'unchanged'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('SQL scheduler gives other tenants capacity and enforces per-tenant queue admission', async () => {
  const scheduler = new SQLiteTaskScheduler(2, 10, 2, 1000);
  const a = await scheduler.acquire('a');
  const a1 = scheduler.acquire('a'), a2 = scheduler.acquire('a');
  await assert.rejects(scheduler.acquire('a'), /capacity/u);
  const b = await scheduler.acquire('b'); b();
  const c = await scheduler.acquire('c'); c();
  a(); const release1 = await a1; release1(); const release2 = await a2; release2();
});

test('SQL scheduler expires queued operations without starting them and retains bounded admission', async () => {
  const scheduler = new SQLiteTaskScheduler(1, 1, 1, 20);
  const active = await scheduler.acquire('active');
  const pending = scheduler.acquire('waiting');
  await assert.rejects(scheduler.acquire('another'), /capacity/u);
  await assert.rejects(pending, /queue deadline/u);
  active(); active();
  const released = await scheduler.acquire('waiting'); released();
});

test('SQL scheduler rotates waiting tenants between completions', async () => {
  const scheduler = new SQLiteTaskScheduler(1, 10, 3, 1000);
  const release = await scheduler.acquire('a');
  const first = scheduler.acquire('a');
  const second = scheduler.acquire('b');
  const third = scheduler.acquire('a');
  const order = [];
  const done = [first.then((end) => { order.push('a'); end(); }), second.then((end) => { order.push('b'); end(); }), third.then((end) => { order.push('a'); end(); })];
  release(); await Promise.all(done); assert.deepEqual(order, ['a', 'b', 'a']);
});

test('SQLite scratch filesystem has a real 64 MiB allocation ceiling', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-sandbox-scratch-'));
  const script = `const fs=require('node:fs'); try { fs.writeFileSync('/tmp/too-large',Buffer.alloc(70*1024*1024)); process.exit(2); } catch(error) { if(error.code!=='ENOSPC')throw error; console.log('bounded'); }`;
  const sandbox = await prepareSQLiteSandbox('inspection', 'inspectSQLite', [join(root, 'app.sqlite')], ['--jitless', '--eval', script]);
  try { assert.equal((await execute(sandbox)).trim(), 'bounded'); }
  finally { await sandbox.close(); await rm(root, { recursive: true, force: true }); }
});
