import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSQLiteDatabase, defineDatabase, defineTable } from '../dist/backend.js';
import { s } from '../dist/ai.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
import { openPointInTimeRecovery } from '../dist/point-in-time.js';
import { createSQLiteTaskScope } from '../dist/sqlite-task.js';

const schema = defineDatabase({ records: defineTable({ value: s.string() }) });
const forbidden = /forbids raw transaction controls and connection-changing SQL/u;
const prefixes = ['', 'EXPLAIN ', 'EXPLAIN QUERY PLAN ', 'EXPLAIN /* plan */ QUERY /* detail */ PLAN '];

async function fixture(t, mode, beforeInstall = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'clank-sqlite-prepare-'));
  const path = join(root, 'source.sqlite'), native = new DatabaseSync(path);
  const database = createSQLiteDatabase(schema, native, { path, busyTimeout: 100, changePollIntervalMs: 0 });
  const sql = database[SQLITE_INTERNAL];
  native.exec('CREATE TABLE effects(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  let recovery, foreign, checks = 0;
  t.after(async () => {
    try { foreign?.close(); await recovery?.close(); }
    finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
  const cached = beforeInstall(sql);
  if (mode !== 'capture') {
    // Exercise the real native guard entry point; this fixture is not a provider lease proof.
    sql.guardWrites(() => { checks++; });
  }
  if (mode !== 'guard') {
    // Trusted fixture data still uses a real, bounded backup worker. No namespace claim.
    const scope = await createSQLiteTaskScope('trusted-process');
    recovery = await scope.run(() => openPointInTimeRecovery(database, {
      directory: join(root, 'journal'), encryptionKey: new Uint8Array(32).fill(83), exportIntervalMs: false,
    }));
  }
  foreign = new DatabaseSync(path);
  foreign.exec('PRAGMA busy_timeout=100');
  return { database, sql, native, foreign, recovery, cached, checks: () => checks };
}

for (const mode of ['guard', 'capture', 'capture and guard']) {
  test(`${mode} refuses locking-mode changes before native preparation can release exclusivity`, async t => {
    const f = await fixture(t, mode);
    f.native.exec('PRAGMA main.locking_mode=EXCLUSIVE; BEGIN IMMEDIATE; COMMIT');
    const foreignWrite = () => f.foreign.prepare("INSERT INTO effects VALUES(99,'foreign')").run();
    assert.throws(foreignWrite, /locked/u);
    for (const prefix of prefixes) for (const [context, run] of [
      ['idle', callback => callback()],
      ['read snapshot', callback => f.database.read(callback)],
      ['write transaction', callback => f.database.transaction(callback)],
    ]) {
      run(() => {
        let error;
        try { f.sql.prepare(`${prefix}PRAGMA main.locking_mode=NORMAL`); } catch (caught) { error = caught; }
        const observed = f.native.prepare('PRAGMA main.locking_mode').get().locking_mode;
        t.diagnostic(JSON.stringify({ prefix, context, modeAfterPreparation: observed, refused: !!error }));
        assert.equal(observed, 'exclusive', 'connection must be unchanged before any statement invocation');
        assert.match(error?.message ?? '', forbidden);
      });
    }
    f.database.transaction(db => db.table('records').insert({ value: 'owned' }));
    assert.throws(foreignWrite, /locked/u, 'the rejection must not release the lock at the next commit');
    assert.equal(f.native.prepare('SELECT count(*) AS count FROM effects').get().count, 0);
    if (f.recovery) assert.equal(f.recovery.status().committedThrough, 1);
  });

  test(`${mode} rechecks previously prepared connection controls before invocation or native recompilation`, async t => {
    const f = await fixture(t, mode, sql => ({
      modes: prefixes.map(prefix => sql.prepare(`${prefix}PRAGMA main.locking_mode=NORMAL`)), commit: sql.prepare('COMMIT'),
    }));
    f.native.exec('PRAGMA main.locking_mode=EXCLUSIVE; BEGIN IMMEDIATE; COMMIT');
    for (const statement of f.cached.modes) assert.throws(() => statement.get(), forbidden);
    assert.equal(f.native.prepare('PRAGMA main.locking_mode').get().locking_mode, 'exclusive');
    assert.throws(() => f.cached.commit.run(), forbidden);
    f.database.transaction(db => db.table('records').insert({ value: 'still captured' }));
    assert.throws(() => f.foreign.prepare("INSERT INTO effects VALUES(99,'foreign')").run(), /locked/u);
    if (f.recovery) assert.equal(f.recovery.status().committedThrough, 1);
  });

  test(`${mode} refuses prepare-time PRAGMA effects while preserving metadata and cached prepared writes`, async t => {
    const f = await fixture(t, mode, sql => sql.prepare('INSERT INTO effects(value) VALUES(?)'));
    const initialChecks = f.checks();
    for (const [name, replacement] of [['foreign_keys', 0], ['query_only', 1], ['wal_autocheckpoint', 7]]) {
      const before = f.native.prepare(`PRAGMA main.${name}`).get();
      assert.throws(() => f.sql.prepare(`/* before prepare */ PRAGMA main.${name}=${replacement}`), forbidden);
      assert.deepEqual(f.native.prepare(`PRAGMA main.${name}`).get(), before);
    }
    assert.equal(f.checks(), initialChecks, 'rejected SQL never enters a native write transaction');
    assert.equal(f.database.version, 0);
    if (f.recovery) assert.equal(f.recovery.status().committedThrough, 0);
    for (const statement of [
      'PRAGMA main.table_info(effects)', 'PRAGMA table_xinfo(effects)', 'PRAGMA index_list(effects)',
      'PRAGMA index_info(missing)', 'PRAGMA index_xinfo(missing)', 'PRAGMA database_list', 'PRAGMA foreign_key_list(effects)',
    ]) assert.deepEqual(f.sql.prepare(statement).all(), f.native.prepare(statement).all());
    for (const prefix of ['EXPLAIN ', 'EXPLAIN QUERY PLAN ']) for (const statement of [
      'SELECT * FROM effects', "INSERT INTO effects(value) VALUES('explain only')",
      "UPDATE effects SET value='explain only'", 'DELETE FROM effects', 'PRAGMA main.table_info(effects)',
    ]) assert.deepEqual(f.sql.prepare(prefix + statement).all(), f.native.prepare(prefix + statement).all());
    f.cached.run('cached');
    assert.equal(f.sql.prepare('INSERT INTO effects(value) VALUES(?) RETURNING value').get('get').value, 'get');
    assert.equal(f.sql.prepare('INSERT INTO effects(value) VALUES(?) RETURNING value').all('all')[0].value, 'all');
    assert.throws(() => f.sql.transaction(() => {
      f.cached.run('rolled back'); throw new Error('abort');
    }), /abort/u);
    assert.deepEqual(f.native.prepare('SELECT value FROM effects ORDER BY id').all().map(row => row.value), ['cached', 'get', 'all']);
    assert.equal(f.sql.prepare("SELECT 'COMMIT; PRAGMA query_only=ON' AS literal").get().literal, 'COMMIT; PRAGMA query_only=ON');
    if (f.recovery) assert.equal(f.recovery.status().committedThrough, 3);
  });
}

test('ordinary SQLite setup retains unguarded prepared connection configuration', async t => {
  const native = new DatabaseSync(':memory:'), database = createSQLiteDatabase(schema, native);
  t.after(() => database.close());
  assert.equal(database[SQLITE_INTERNAL].prepare('PRAGMA main.locking_mode=EXCLUSIVE').get().locking_mode, 'exclusive');
  assert.equal(native.prepare('PRAGMA main.locking_mode').get().locking_mode, 'exclusive');
});
