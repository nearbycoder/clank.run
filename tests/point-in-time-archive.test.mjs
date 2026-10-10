import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {s} from '../dist/ai.js';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,restorePointInTimeArchive} from '../dist/point-in-time.js';
const schema=defineDatabase({records:defineTable({value:s.string()})});
async function fixture(t,options={}){
  const scope=await createSQLiteTaskScope('trusted-process');
  return scope.run(async()=>{
    const root=await mkdtemp(join(tmpdir(),'clank-pitr-archive-test-')),source=join(root,'source.sqlite'),directory=join(root,'repository'),key=new Uint8Array(32).fill(71),database=await openSQLite(schema,{path:source}),config={directory,encryptionKey:key,exportIntervalMs:false,maxJournalEntries:10,maxJournalBytes:1024*1024,...options};
    const opening=openPointInTimeRecovery(database,config);
    // Immediate caller mutation must not alter the captured key or capacity.
    config.encryptionKey=new Uint8Array(32).fill(22);config.maxJournalEntries=999;config.directory=join(root,'wrong-directory');
    const recovery=await opening;
    t.after(()=>scope.run(async()=>{await recovery.close();database.close();await rm(root,{recursive:true,force:true});}));
    return {scope,root,source,directory,key,database,recovery};
  });
}
const request=(f,archive,through=archive.sequence,target='restored.sqlite')=>({encryptionKey:f.key,targetPath:join(f.root,target),confirmation:'restore point in time',throughSequence:through,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest});
function sign(archive,key){const {authentication,...content}=archive;return {...content,authentication:createHmac('sha256',key).update(JSON.stringify(content)).digest('hex')};}
async function missing(path){await assert.rejects(readFile(path),{code:'ENOENT'});}

test('native encrypted archive recovers a known committed boundary after complete source/repository loss',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    const id=f.database.transaction(db=>db.table('records').insert({value:'mutation one'}));
    f.database.transaction(db=>db.table('records').patch(id,{value:'mutation two'}));
    f.database.transaction(db=>db.table('records').patch(id,{value:'mutation three'}));
    const archive=await exportPointInTimeRecovery(f.recovery),options=request(f,archive,2);
    assert.equal(archive.sequence,3);assert.equal(archive.files.length,7);assert.ok(Object.isFrozen(archive.files));
    assert.ok(!JSON.stringify(archive).includes('mutation one'));assert.ok(!JSON.stringify(archive).includes(f.directory));
    await f.recovery.close();f.database.close();await rm(f.directory,{recursive:true});await rm(f.source);
    const result=await restorePointInTimeArchive(archive,options);assert.equal(result.sequence,2);
    const restored=await openSQLite(schema,{path:options.targetPath});try{assert.equal(restored.read(db=>db.table('records').get(id)).value,'mutation two');assert.equal(restored.version,2);}finally{restored.close();}
  });
});

test('copied status/JSON handles and closed native handles cannot export a provider checkpoint',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    await assert.rejects(exportPointInTimeRecovery({...f.recovery}),/current native/);
    await assert.rejects(exportPointInTimeRecovery({status:()=>f.recovery.status(),flush:()=>f.recovery.flush(),close:()=>{}}),/current native/);
    await f.recovery.close();await assert.rejects(exportPointInTimeRecovery(f.recovery),/current native/);
  });
});

test('an independently retained newer horizon rejects an older authenticated archive before target publication',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    f.database.transaction(db=>db.table('records').insert({value:'one'}));const old=await exportPointInTimeRecovery(f.recovery);
    f.database.transaction(db=>db.table('records').insert({value:'two'}));const current=await exportPointInTimeRecovery(f.recovery),options=request(f,current,1);
    await assert.rejects(restorePointInTimeArchive(old,options),/retained horizon/);await missing(options.targetPath);
    assert.equal(f.database.read(db=>db.table('records').collect()).length,2);
  });
});

test('changed ciphertext and authenticated missing/foreign/duplicate archive files refuse destination publication',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    f.database.transaction(db=>db.table('records').insert({value:'original'}));const archive=await exportPointInTimeRecovery(f.recovery),options=request(f,archive);
    const corrupt=JSON.parse(JSON.stringify(archive));corrupt.files.at(-1).contents='AAAA';
    await assert.rejects(restorePointInTimeArchive(corrupt,options),/authentication/);
    for(const change of [value=>{value.files.pop();},value=>{value.files.at(-1).name='../source.sqlite';},value=>{value.files.at(-1).name=value.files[0].name;}]){
      const changed=JSON.parse(JSON.stringify(archive));change(changed);
      await assert.rejects(restorePointInTimeArchive(sign(changed,f.key),options),/horizon|invalid|duplicate|missing|foreign/);await missing(options.targetPath);
    }
    assert.equal(f.database.read(db=>db.table('records').collect()).length,1);
  });
});

test('bounded exports retain every journal entry and refuse malformed bounds without widening capacity',async t=>{
  const f=await fixture(t,{maxJournalEntries:1});await f.scope.run(async()=>{
    f.database.transaction(db=>db.table('records').insert({value:'one'}));
    await assert.rejects(exportPointInTimeRecovery(f.recovery,{maxArchiveBytes:4096}),/byte bound/);
    await assert.rejects(exportPointInTimeRecovery(f.recovery,{maxEntries:0}),/maxEntries/);
    assert.throws(()=>f.database.transaction(db=>db.table('records').insert({value:'two'})),/journal capacity/);
    const archive=await exportPointInTimeRecovery(f.recovery);assert.equal(archive.sequence,1);
  });
});

test('a tampered local encrypted base cannot be authenticated into a remote archive',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    const id=f.recovery.status().baseBackupId,path=join(f.directory,'base',id,'database.enc'),bytes=await readFile(path);bytes[30]^=1;await writeFile(path,bytes);
    await assert.rejects(exportPointInTimeRecovery(f.recovery),/authenticate|Unsupported state/);
    assert.equal(f.recovery.status().committedThrough,0);
  });
});

test('an actual second SQLite writer fences a live archive exporter and all later captured mutations',async t=>{
  const f=await fixture(t);await f.scope.run(async()=>{
    const id=f.database.transaction(db=>db.table('records').insert({value:'captured'})),outside=new DatabaseSync(f.source);
    try{outside.prepare("UPDATE clank_records SET _data=json_set(_data,'$.value',?) WHERE _id=?").run('unjournaled',id);}finally{outside.close();}
    await assert.rejects(exportPointInTimeRecovery(f.recovery),/another SQLite writer/);
    assert.throws(()=>f.database.transaction(db=>db.table('records').patch(id,{value:'refused'})),/another SQLite writer/);
    assert.equal(f.database.read(db=>db.table('records').get(id)).value,'unjournaled');
  });
});

test('durable remote export receipts replay the exact encrypted horizon after reopening and preserve capacity evidence',async t=>{
  const f=await fixture(t,{maxRemoteExports:1});await f.scope.run(async()=>{
    f.database.transaction(db=>db.table('records').insert({value:'one'}));
    const archive=await exportPointInTimeRecovery(f.recovery,{operationId:'checkpoint_exact_01'});
    f.database.transaction(db=>db.table('records').insert({value:'two'}));
    assert.deepEqual(await exportPointInTimeRecovery(f.recovery,{operationId:'checkpoint_exact_01'}),archive);
    await assert.rejects(exportPointInTimeRecovery(f.recovery,{operationId:'checkpoint_exact_01',maxEntries:2}),/retry conflict/);
    await assert.rejects(exportPointInTimeRecovery(f.recovery,{operationId:'checkpoint_other_02'}),/receipt capacity/);
    await f.recovery.close();f.database.close();
    const database=await openSQLite(schema,{path:f.source}),recovery=await openPointInTimeRecovery(database,{directory:f.directory,encryptionKey:f.key,exportIntervalMs:false,maxRemoteExports:1});
    try{assert.deepEqual(await exportPointInTimeRecovery(recovery,{operationId:'checkpoint_exact_01'}),archive);assert.equal(recovery.status().committedThrough,2);}finally{await recovery.close();database.close();}
  });
});
