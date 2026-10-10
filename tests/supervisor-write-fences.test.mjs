import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {s} from '../dist/ai.js';
import {defineDatabase,defineTable,openSQLite} from '../dist/backend.js';
const native=Symbol.for('clank.sqlite.internal');

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-write-')),path=join(root,'catalog.sqlite');
  const definition=defineDatabase({records:defineTable({value:s.string()})}),db=await openSQLite(definition,{path,changePollIntervalMs:0}),sql=db[native];
  sql.exec('CREATE TABLE ownership(singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL);INSERT INTO ownership VALUES(1,1);CREATE TABLE effects(value TEXT NOT NULL)');
  const other=new DatabaseSync(path);other.exec('PRAGMA busy_timeout=5000');
  t.after(async()=>{other.close();db.close();await rm(root,{recursive:true,force:true});});
  const check=connection=>{if(connection.prepare('SELECT epoch FROM ownership WHERE singleton=1').get()?.epoch!==1)throw new Error('Native epoch lost');};
  return {db,sql,other,check};
}

test('native transaction ownership fences cached raw statements, exec and generated writes after another SQLite connection changes epoch',async t=>{
  const f=await fixture(t),statement=f.sql.prepare('INSERT INTO effects VALUES(?)');
  f.sql.guardWrites(f.check);statement.run('accepted');const id=f.db.transaction(db=>db.table('records').insert({value:'accepted'}));
  assert.equal(f.db.read(db=>db.table('records').get(id)).value,'accepted');
  f.other.prepare('UPDATE ownership SET epoch=2 WHERE singleton=1').run();
  assert.throws(()=>statement.run('stale'),/Native epoch lost/);
  assert.throws(()=>f.sql.exec("INSERT INTO effects VALUES('stale')"),/Native epoch lost/);
  assert.throws(()=>f.db.transaction(db=>db.table('records').patch(id,{value:'stale'})),/Native epoch lost/);
  assert.deepEqual(f.other.prepare('SELECT value FROM effects').all().map(row=>({...row})),[{value:'accepted'}]);
  assert.equal(f.db.read(db=>db.table('records').get(id)).value,'accepted');
});

test('ownership is checked before COMMIT and rolls back data, revision and history when authority expires in the synchronous handler',async t=>{
  const f=await fixture(t);let current=true;
  f.sql.guardWrites(connection=>{f.check(connection);if(!current)throw new Error('Authority expired');});
  const revision=f.db.version;
  assert.throws(()=>f.db.transaction(db=>{db.table('records').insert({value:'expired'});current=false;}),/Authority expired/);
  assert.equal(f.db.version,revision);
  assert.equal(f.other.prepare('SELECT count(*) AS count FROM clank_records').get().count,0);
  assert.equal(f.other.prepare('SELECT count(*) AS count FROM clank_document_revisions').get().count,0);
});

test('get/all SQL mutation forms cannot bypass current ownership and raw transaction controls are refused',async t=>{
  const f=await fixture(t);f.sql.guardWrites(f.check);
  assert.deepEqual({...f.sql.prepare('INSERT INTO effects VALUES(?) RETURNING value').get('first')},{value:'first'});
  assert.throws(()=>f.sql.exec('BEGIN IMMEDIATE'),/Native write authority forbids/);
  f.other.prepare('UPDATE ownership SET epoch=2 WHERE singleton=1').run();
  assert.throws(()=>f.sql.prepare('INSERT INTO effects VALUES(?) RETURNING value').get('second'),/Native epoch lost/);
  assert.throws(()=>f.sql.prepare('DELETE FROM effects RETURNING value').all(),/Native epoch lost/);
  assert.deepEqual(f.other.prepare('SELECT value FROM effects').all().map(row=>({...row})),[{value:'first'}]);
});

test('write authority cannot be replaced, installed in a transaction, or represented by an asynchronous callback',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.sql.transaction(()=>f.sql.guardWrites(f.check)),/idle database/);
  assert.throws(()=>f.sql.guardWrites(async()=>{}),/synchronously return undefined/);
  f.sql.guardWrites(f.check);
  assert.throws(()=>f.sql.guardWrites(()=>{}),/only be installed once/);
  f.sql.prepare('INSERT INTO effects VALUES(?)').run('accepted');
});

test('guarded schema accepts trigger bodies, CASE and quoted control words while every actual transaction escape is rejected',async t=>{
  const f=await fixture(t),cached=f.sql.prepare('COMMIT');f.sql.guardWrites(f.check);
  f.sql.exec(`CREATE TABLE trigger_source(value TEXT);CREATE TRIGGER native_cleanup AFTER INSERT ON trigger_source BEGIN
    INSERT INTO effects VALUES(CASE WHEN new.value='rollback; COMMIT' THEN 'release' ELSE new.value END);
    INSERT INTO effects VALUES('END; BEGIN');END;`);
  f.sql.prepare('INSERT INTO trigger_source VALUES(?)').run('rollback; COMMIT');
  assert.equal(f.other.prepare('SELECT count(*) AS count FROM effects').get().count,2);
  assert.ok(f.sql.prepare('PRAGMA table_info(effects)').all().length);
  assert.throws(()=>cached.run(),/Native write authority forbids/);
  for(const sql of ["/* COMMIT */ END TRANSACTION","SELECT 'BEGIN;';COMMIT","CREATE TRIGGER other AFTER INSERT ON trigger_source BEGIN SELECT 1;END;ROLLBACK","PRAGMA foreign_keys=OFF"]){
    assert.throws(()=>f.sql.exec(sql),/Native write authority forbids/);
    assert.throws(()=>f.sql.prepare(sql).run(),/Native write authority forbids/);
  }
  assert.equal(f.other.prepare('SELECT count(*) AS count FROM effects').get().count,2);
});
