import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {restoreSQLiteBackup} from '../dist/migrations.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {s} from '../dist/ai.js';
import {defineDatabase,defineTable,openSQLite} from '../dist/backend.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,restorePointInTimeArchive} from '../dist/point-in-time.js';

async function authority(t){
  const root=await mkdtemp(join(tmpdir(),'clank-pitr-authority-')),native=new DatabaseSync(join(root,'authority.sqlite'));
  native.exec('CREATE TABLE current_owner(id INTEGER PRIMARY KEY,active INTEGER);INSERT INTO current_owner VALUES(1,1)');
  const current=()=>{if(native.prepare('SELECT active FROM current_owner WHERE id=1').get()?.active!==1)throw new Error('Native restore authority was revoked.');};
  t.after(async()=>{native.close();await rm(root,{recursive:true,force:true});});return {root,native,current};
}
async function sqlite(path,value){const db=new DatabaseSync(path);try{db.exec('CREATE TABLE mutations(value TEXT)');db.prepare('INSERT INTO mutations VALUES(?)').run(value);}finally{db.close();}}

test('native authority lost after the actual replacement worker closes preserves the stopped destination and owned sidecar sentinels',async t=>{
  const f=await authority(t),source=join(f.root,'source.sqlite'),target=join(f.root,'target.sqlite');await sqlite(source,'source mutation');await sqlite(target,'destination mutation');const before=await readFile(target);
  await writeFile(target+'-wal','owned WAL sentinel');await writeFile(target+'-shm','owned SHM sentinel');let checks=0;
  const scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{
    await assert.rejects(restoreSQLiteBackup(source,target,()=>{
      if(++checks===2){
        const staged=readdirSync(f.root).filter(name=>name.startsWith('target.sqlite.tmp-')&&!/-wal$|-shm$|-journal$/u.test(name));assert.equal(staged.length,1);
        const db=new DatabaseSync(join(f.root,staged[0]),{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM mutations').get().value,'source mutation');}finally{db.close();}
        f.native.prepare('UPDATE current_owner SET active=0 WHERE id=1').run();
      }f.current();
    }),/Native restore authority was revoked/);
  });
  assert.equal(checks,2);assert.deepEqual(await readFile(target),before);assert.equal(await readFile(target+'-wal','utf8'),'owned WAL sentinel');assert.equal(await readFile(target+'-shm','utf8'),'owned SHM sentinel');assert.equal((await readdir(f.root)).filter(name=>name.includes('.tmp-')).length,0);
});

test('a current synchronous native assertion permits a verified stopped-database replacement',async t=>{
  const f=await authority(t),source=join(f.root,'source.sqlite'),target=join(f.root,'target.sqlite');await sqlite(source,'verified mutation');await sqlite(target,'old mutation');let checks=0;
  const scope=await createSQLiteTaskScope('trusted-process');await scope.run(()=>restoreSQLiteBackup(source,target,()=>{checks++;f.current();}));assert.ok(checks>=3);
  const db=new DatabaseSync(target,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM mutations').get().value,'verified mutation');}finally{db.close();}
});

test('asynchronous publication assertions are refused before a worker or destination is admitted',async t=>{
  const f=await authority(t),target=join(f.root,'never-created.sqlite');await assert.rejects(restoreSQLiteBackup(join(f.root,'missing.sqlite'),target,async()=>{}),/synchronously/);await assert.rejects(readFile(target),{code:'ENOENT'});
});

test('an archive restore consults native current ownership between asynchronous verification boundaries and never publishes after revocation',async t=>{
  const f=await authority(t),scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{
    const schema=defineDatabase({records:defineTable({value:s.string()})}),db=await openSQLite(schema,{path:join(f.root,'source.sqlite')});let capture;
    try{
      capture=await openPointInTimeRecovery(db,{directory:join(f.root,'journal'),encryptionKey:new Uint8Array(32).fill(71),exportIntervalMs:false});db.transaction(tx=>tx.table('records').insert({value:'native committed mutation'}));const archive=await exportPointInTimeRecovery(capture),target=join(f.root,'refused.sqlite');let checks=0;
      await assert.rejects(restorePointInTimeArchive(archive,{encryptionKey:new Uint8Array(32).fill(71),targetPath:target,confirmation:'restore point in time',throughSequence:1,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest,assertCurrent(){if(++checks===2)f.native.prepare('UPDATE current_owner SET active=0 WHERE id=1').run();f.current();}}),/Native restore authority was revoked/);
      await assert.rejects(readFile(target),{code:'ENOENT'});assert.equal(db.read(tx=>tx.table('records').collect()).length,1);
      await assert.rejects(restorePointInTimeArchive(archive,{encryptionKey:new Uint8Array(32).fill(71),targetPath:target,confirmation:'restore point in time',throughSequence:1,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest,assertCurrent:async()=>{}}),/synchronously/);
      await assert.rejects(restorePointInTimeArchive(archive,{encryptionKey:new Uint8Array(32).fill(71),targetPath:target,confirmation:'restore point in time',throughSequence:1,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest,maxDurationMs:1,assertCurrent(){const until=performance.now()+10;while(performance.now()<until){}}}),/deadline/);await assert.rejects(readFile(target),{code:'ENOENT'});
    }finally{await capture?.close();db.close();}
  });
});
