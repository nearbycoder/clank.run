import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {openPointInTimeRecovery} from '../dist/point-in-time.js';
const schema=defineDatabase({records:defineTable({value:s.string()})});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'clank-capture-authority-'));
 const owner=new DatabaseSync(join(root,'authority.sqlite'));
 owner.exec('CREATE TABLE authority(id INTEGER PRIMARY KEY,active INTEGER);INSERT INTO authority VALUES(1,1)');
 const db=await openSQLite(schema,{path:join(root,'data.sqlite'),changePollIntervalMs:0});
 const observer=new DatabaseSync(join(root,'data.sqlite'));let recovery;
 t.after(async()=>{await recovery?.close();observer.close();db.close();owner.close();await rm(root,{recursive:true,force:true});});
 db[SQLITE_INTERNAL].guardWrites(()=>{if(owner.prepare('SELECT active FROM authority WHERE id=1').get().active!==1)throw Error('native capture authority lost');});
 return {root,db,owner,observer,setRecovery(value){recovery=value;}};
}
test('revoked native write authority refuses recovery capture bootstrap before retained table writes',async t=>{
 const f=await fixture(t);f.owner.exec('UPDATE authority SET active=0');
 await assert.rejects(async()=>{f.setRecovery(await openPointInTimeRecovery(f.db,{directory:join(f.root,'journal'),encryptionKey:new Uint8Array(32).fill(79),exportIntervalMs:false}));},/native capture authority lost/);
 assert.deepEqual(f.observer.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'clank_pitr_*'").all(),[]);
});
test('capture connection rechecks native write authority at commit and permits rollback cleanup',async t=>{
 const f=await fixture(t);f.observer.exec('CREATE TABLE capture_guard_probe(value TEXT)');
 assert.throws(()=>f.db[SQLITE_INTERNAL].captureTransactions(connection=>{
  connection.exec('BEGIN IMMEDIATE');
  try{
   connection.prepare('INSERT INTO capture_guard_probe VALUES(?)').run('unacknowledged');
   f.owner.exec('UPDATE authority SET active=0');
   connection.exec('COMMIT');
  }catch(error){connection.exec('ROLLBACK');throw error;}
  return {before(){},commit(){},after(){},close(){}};
 }),/native capture authority lost/);
 assert.deepEqual(f.observer.prepare('SELECT * FROM capture_guard_probe').all(),[]);
});
test('a capture statement prepared before revocation cannot submit a later write',async t=>{
 const f=await fixture(t);f.observer.exec('CREATE TABLE capture_guard_probe(value TEXT)');
 assert.throws(()=>f.db[SQLITE_INTERNAL].captureTransactions(connection=>{
  connection.exec('BEGIN IMMEDIATE');
  try{
   const statement=connection.prepare('INSERT INTO capture_guard_probe VALUES(?)');
   f.owner.exec('UPDATE authority SET active=0');
   statement.run('stale');
  }catch(error){connection.exec('ROLLBACK');throw error;}
  return {before(){},commit(){},after(){},close(){}};
 }),/native capture authority lost/);
 assert.deepEqual(f.observer.prepare('SELECT * FROM capture_guard_probe').all(),[]);
});
test('current native write authority supports ordinary recovery bootstrap, captured commit and export',async t=>{
 const f=await fixture(t);
 const recovery=await openPointInTimeRecovery(f.db,{directory:join(f.root,'journal'),encryptionKey:new Uint8Array(32).fill(79),exportIntervalMs:false});
 f.setRecovery(recovery);
 f.db.transaction(tx=>tx.table('records').insert({value:'current'}));
 const result=await recovery.flush();
 assert.equal(result.committedThrough,1);assert.equal(result.exportedThrough,1);
 assert.equal(f.db.read(db=>db.table('records').collect()).length,1);
});
