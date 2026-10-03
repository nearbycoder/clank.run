import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSQLite, defineDatabase, defineTable } from '../dist/backend.js';
import { s } from '../dist/ai.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
import { openPointInTimeRecovery, restorePointInTime } from '../dist/point-in-time.js';

const schema = defineDatabase({ records: defineTable({ value: s.string() }) });
const key = new Uint8Array(32).fill(9);

test('real per-commit recovery replays inserts, updates, deletes, service SQL and atomic rollback at exact boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-pitr-test-'));
  const source = join(root, 'source.sqlite'), directory = join(root, 'archive'), target = join(root, 'restored.sqlite');
  let database = await openSQLite(schema, { path: source });
  const internal = database[SQLITE_INTERNAL];
  internal.exec('CREATE TABLE service(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL)');
  let manager = await openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false });
  try {
    const id = database.transaction((db) => db.table('records').insert({ value: 'first' }));
    const first = manager.status(); assert.equal(first.committedThrough, 1);
    assert.throws(() => database.transaction((db) => { db.table('records').patch(id, { value: 'rolled back' }); throw new Error('abort'); }), /abort/);
    assert.equal(manager.status().committedThrough, 1);
    database.transaction((db) => db.table('records').patch(id, { value: 'second' }));
    internal.prepare('INSERT INTO service(value) VALUES(?)').run('service write');
    const third = manager.status(); assert.equal(third.committedThrough, 3);
    database.transaction((db) => db.table('records').delete(id));
    await manager.close(); database.close();
    database = await openSQLite(schema, { path: source });
    assert.throws(() => database.transaction(() => {}), /requires point-in-time/);
    manager = await openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false });
    assert.equal(manager.status().committedThrough, 4);
    const result = await restorePointInTime({ directory, encryptionKey: key, targetPath: target, throughSequence: 3, confirmation: 'restore point in time' });
    assert.equal(result.sequence, 3);
    let restored = new DatabaseSync(target);
    assert.equal(JSON.parse(restored.prepare('SELECT _data FROM clank_records').get()._data).value, 'second');
    assert.equal(restored.prepare('SELECT value FROM service').get().value, 'service write'); restored.close();
    await restorePointInTime({ directory, encryptionKey: key, targetPath: target, asOf: first.lastCommittedAt, confirmation: 'restore point in time' });
    restored = new DatabaseSync(target); assert.equal(JSON.parse(restored.prepare('SELECT _data FROM clank_records').get()._data).value, 'first'); assert.equal(restored.prepare('SELECT count(*) AS count FROM service').get().count, 0); restored.close();
    const files = (await readdir(directory)).filter((name) => /^0.*json$/.test(name)).sort();
    const original = await readFile(join(directory, files[1]), 'utf8'); const changed = JSON.parse(original); changed.body = changed.body.slice(0, -4) + 'AAAA';
    await writeFile(join(directory, files[1]), JSON.stringify(changed));
    await assert.rejects(restorePointInTime({ directory, encryptionKey: key, targetPath: target, throughSequence: 3, confirmation: 'restore point in time' }), /[Ii]nvalid recovery|authentication/);
    restored = new DatabaseSync(target); assert.equal(JSON.parse(restored.prepare('SELECT _data FROM clank_records').get()._data).value, 'first'); restored.close();
    await writeFile(join(directory, files[1]), original); await rm(join(directory, files[1]));
    await assert.rejects(restorePointInTime({ directory, encryptionKey: key, targetPath: target, throughSequence: 3, confirmation: 'restore point in time' }), /missing|reorders/);
  } finally { await manager.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test('recovery fences schema transitions, null primary keys, oversized commits and concurrent/restarted unjournaled writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-pitr-fence-'));
  const source = join(root, 'source.sqlite'), directory = join(root, 'archive');
  let database = await openSQLite(schema, { path: source });
  let manager = await openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false, maxTransactionBytes: 1024 });
  try {
    assert.throws(() => database.transaction((db) => db.table('records').insert({ value: 'x'.repeat(2000) })), /maxTransactionBytes/);
    assert.equal(database.read((db) => db.table('records').collect()).length, 0);
    assert.throws(() => database[SQLITE_INTERNAL].exec('CREATE TABLE unsupported(id INTEGER PRIMARY KEY)'), /schema change/);
    // A schema violation fences this writer even though SQLite rolls the DDL back.
    assert.throws(() => database.transaction(() => {}), /schema change/);
    await manager.close(); database.close();
    database = await openSQLite(schema, { path: source }); manager = await openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false });
    const other = new DatabaseSync(source); other.prepare("UPDATE clank_meta SET _value=5 WHERE _key='global_version'").run(); other.close();
    assert.throws(() => database[SQLITE_INTERNAL].prepare('SELECT 1').get(), /another SQLite writer/);
    await manager.close(); database.close();
    database = await openSQLite(schema, { path: source, integrityCheck: false });
    await assert.rejects(openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false }), /seal mismatch/);
  } finally { try { await manager.close(); } catch {} database.close(); await rm(root, { recursive: true, force: true }); }
});

test('recovery preserves trigger effects, cascades, cached whole-table deletes and empty autoincrement state at every boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-pitr-relations-'));
  const source = join(root, 'source.sqlite'), directory = join(root, 'archive'), target = join(root, 'restored.sqlite');
  const database = await openSQLite(schema, { path: source }), internal = database[SQLITE_INTERNAL];
  let manager;
  try {
    internal.exec(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
      CREATE TRIGGER parent_child AFTER INSERT ON parent BEGIN INSERT INTO child VALUES(new.id,new.id); END;
      CREATE TABLE sequence_test(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE nullable_pk(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO parent VALUES(100,'base');
    `);
    // This statement is compiled before capture attaches. Reusing it must not
    // retain SQLite's truncate optimization and silently omit deleted rows.
    const cachedDelete = internal.prepare('DELETE FROM sequence_test');
    const state = (connection) => JSON.parse(JSON.stringify({
      parents: connection.prepare('SELECT * FROM parent ORDER BY id').all(),
      children: connection.prepare('SELECT * FROM child ORDER BY id').all(),
      rows: connection.prepare('SELECT * FROM sequence_test ORDER BY id').all(),
      sequences: connection.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all(),
      triggers: connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all(),
    }));
    const snapshots = [state(internal)];
    manager = await openPointInTimeRecovery(database, { directory, encryptionKey: key, exportIntervalMs: false });
    const commit = (write) => {
      write();
      assert.equal(manager.status().committedThrough, snapshots.length);
      snapshots.push(state(internal));
    };
    commit(() => internal.prepare('INSERT INTO parent VALUES(1,?)').run('triggered'));
    commit(() => internal.prepare('DELETE FROM parent WHERE id=100').run());
    commit(() => internal.prepare('INSERT INTO sequence_test(id,value) VALUES(10,?)').run('ten'));
    commit(() => cachedDelete.run());
    commit(() => internal.prepare('INSERT INTO sequence_test(id,value) VALUES(20,?)').run('twenty'));
    commit(() => internal.prepare('DELETE FROM sequence_test').run());
    commit(() => internal.prepare('DELETE FROM sqlite_sequence WHERE name=?').run('sequence_test'));
    assert.deepEqual(snapshots.at(-1).sequences, []);
    assert.throws(() => internal.prepare('INSERT INTO nullable_pk VALUES(NULL,?)').run('invalid'), /non-null primary/);
    assert.equal(manager.status().committedThrough, snapshots.length - 1);
    assert.equal(internal.prepare('SELECT count(*) AS count FROM nullable_pk').get().count, 0);
    await manager.flush();
    for (let sequence = 0; sequence < snapshots.length; sequence++) {
      const result = await restorePointInTime({ directory, encryptionKey: key, targetPath: target, throughSequence: sequence, confirmation: 'restore point in time' });
      assert.equal(result.sequence, sequence);
      const restored = new DatabaseSync(target);
      try {
        assert.deepEqual(state(restored), snapshots[sequence], `logical state at committed boundary ${sequence}`);
        assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
        if (sequence === snapshots.length - 1) {
          assert.equal(Number(restored.prepare("INSERT INTO sequence_test(value) VALUES('next')").run().lastInsertRowid), 1);
          restored.exec('PRAGMA foreign_keys=ON');
          restored.prepare("INSERT INTO parent VALUES(2,'after restore')").run();
          assert.equal(restored.prepare('SELECT count(*) AS count FROM child WHERE parent_id=2').get().count, 1);
          restored.prepare('DELETE FROM parent WHERE id=2').run();
          assert.equal(restored.prepare('SELECT count(*) AS count FROM child WHERE parent_id=2').get().count, 0);
        }
      } finally { restored.close(); }
    }
  } finally { await manager?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});


test('recovery uses a literal private-table prefix and rolls back rejected capture installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-pitr-prefix-'));
  const database = await openSQLite(schema, { path: join(root, 'source.sqlite') });
  const internal = database[SQLITE_INTERNAL];
  try {
    internal.exec("CREATE TABLE clank_pitrXapplication(value TEXT); INSERT INTO clank_pitrXapplication VALUES('must be covered')");
    await assert.rejects(openPointInTimeRecovery(database, { directory: join(root, 'archive'), encryptionKey: key, exportIntervalMs: false }), /without primary keys/);
    assert.equal(internal.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_pitr_state'").get().n, 0);
    assert.doesNotThrow(() => database.transaction((db) => db.table('records').insert({ value: 'installation rolled back' })));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
