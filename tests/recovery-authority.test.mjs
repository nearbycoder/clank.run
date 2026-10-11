import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,createHmac} from 'node:crypto';
import {openBackupManager} from '../dist/recovery.js';
import {openLocalObjectStore} from '../dist/object-storage.js';
import {openSupervisorLease} from '../dist/platform-supervisor.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';

function gate(){let enter,release;return{entered:new Promise(resolve=>enter=resolve),released:new Promise(resolve=>release=resolve),enter:()=>enter(),release:()=>release()};}
const lost=error=>['SUPERVISOR_LEASE_LOST','SUPERVISOR_STATE_INVALID'].includes(error.code);
async function fixture(t,objects=true,maxBackups=30){
  const root=await mkdtemp(join(tmpdir(),'clank-backup-authority-')),managers=[],holds=[],deletes=[],puts=[];
  const lease=await openSupervisorLease(join(root,'lease.sqlite'),{configurationId:'backup-deletion',configurationRevision:1,leaseMs:30000,pollIntervalMs:50});
  assert.equal(lease.acquire(),true);const operator=new DatabaseSync(join(root,'lease.sqlite'));
  const databasePath=join(root,'source.sqlite'),source=new DatabaseSync(databasePath);
  source.exec('CREATE TABLE content(id INTEGER PRIMARY KEY, bytes BLOB NOT NULL);INSERT INTO content VALUES(1,randomblob(200000))');source.close();
  const bytes=new Uint8Array(await readFile(databasePath)),nativeStore=await openLocalObjectStore({directory:join(root,'objects')});
  let catalogHold,deleteHold,deleteIndex=0;
  const store={...nativeStore,
    async get(key){const result=await nativeStore.get(key);if(catalogHold&&key.endsWith('/catalog.json')){catalogHold.enter();await catalogHold.released;}return result;},
    async put(key,value,options){puts.push(key);return nativeStore.put(key,value,options);},
    async delete(key){deletes.push(key);const result=await nativeStore.delete(key);if(deleteHold&&++deleteIndex===deleteHold.index){deleteHold.gate.enter();await deleteHold.gate.released;}return result;},
  };
  const options={repositoryDirectory:join(root,'backups'),encryptionKey:new Uint8Array(32).fill(79),verifyAfterCreate:false,maxDatabaseBytes:bytes.length,maxBackups,
    ...(objects?{objects:{store,namespace:'native-deletion-authority',repositoryId:'source-01',chunkBytes:64*1024}}:{})};
  const open=async(guard)=>{const manager=await openBackupManager(options,guard);managers.push(manager);return manager;};
  t.after(async()=>{for(const held of holds)held.release();for(const manager of managers)manager.close();operator.close();lease.close();await rm(root,{recursive:true,force:true});});
  const initial=await open();const scope=await createSQLiteTaskScope('trusted-process');
  const backup=await scope.run(()=>initial.createFromSnapshot({bytes,source:'source.sqlite'}));initial.close();
  const manager=await open(()=>lease.assertCurrent());
  const catalogKey='backups/source-01/catalog.json';
  const catalog=objects?await nativeStore.get(catalogKey):null;
  const chunks=catalog?JSON.parse(new TextDecoder().decode(catalog.bytes)).catalog.entries[0].chunks:[];
  if(objects)assert.ok(chunks.length>=3,'Native encrypted snapshot spans actual local object chunks.');
  deletes.length=0;puts.length=0;
  return{root,manager,backup,bytes,chunks,catalog,catalogKey,nativeStore,deletes,puts,open,
    create:()=>scope.run(()=>manager.createFromSnapshot({bytes,source:'source.sqlite'})),
    async abandonUpload(){
      const signed=JSON.parse(new TextDecoder().decode(catalog.bytes));
      signed.catalog.entries[0].state='uploading';signed.catalog.entries[0].updatedAt=Date.now()-2*60*60_000;
      signed.mac=createHmac('sha256',createHash('sha256').update(options.encryptionKey).digest()).update(JSON.stringify(signed.catalog)).digest('base64url');
      await nativeStore.put(catalogKey,new TextEncoder().encode(JSON.stringify(signed)),{contentType:catalog.metadata.contentType});
      return nativeStore.get(catalogKey);
    },
    invalidate(mode='replace'){if(mode==='delete')operator.exec('DELETE FROM clank_platform_supervisor_lease');else operator.prepare('UPDATE clank_platform_supervisor_lease SET token_hash=?,epoch=epoch+1').run('9'.repeat(64));},
    holdCatalog(){const held=gate();holds.push(held);catalogHold=held;return held;},
    holdDelete(index){const held=gate();holds.push(held);deleteHold={index,gate:held};return held;},
    holdLocalList(){const held=gate();holds.push(held);const list=manager.list;manager.list=async()=>{const result=await list();held.enter();await held.released;return result;};return held;},
  };
}

for(const action of ['purge','delete'])test(`private backup authority refuses ${action} after a held authenticated catalog read loses its native lease`,async t=>{
  const f=await fixture(t),held=f.holdCatalog();
  const pending=action==='purge'?f.manager.purge({confirmation:'delete all backups'}):f.manager.delete(f.backup.id);
  const rejected=assert.rejects(pending,lost);await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(f.deletes,[]);assert.deepEqual(f.puts,[]);assert.deepEqual(await f.nativeStore.get(f.catalogKey),f.catalog);
  for(const chunk of f.chunks)assert.ok(await f.nativeStore.stat(chunk.key));
});

test('private local purge refuses deletion after a held real repository list loses native authority',async t=>{
  const f=await fixture(t,false),held=f.holdLocalList(),before=await readFile(join(f.root,'backups',f.backup.id,'database.enc'));
  const rejected=assert.rejects(f.manager.purge({confirmation:'delete all backups'}),lost);
  await held.entered;f.invalidate('delete');held.release();await rejected;
  assert.deepEqual(await readFile(join(f.root,'backups',f.backup.id,'database.enc')),before);
  assert.ok((await readdir(join(f.root,'backups'))).includes(f.backup.id));
});

for(const action of ['purge','delete'])test(`private backup ${action} stops after its already-submitted first chunk and retains catalog recovery state`,async t=>{
  const f=await fixture(t),held=f.holdDelete(1);
  const pending=action==='purge'?f.manager.purge({confirmation:'delete all backups'}):f.manager.delete(f.backup.id);
  const rejected=assert.rejects(pending,lost);await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(f.deletes,[f.chunks[0].key]);assert.equal(await f.nativeStore.stat(f.chunks[0].key),null);
  for(const chunk of f.chunks.slice(1))assert.ok(await f.nativeStore.stat(chunk.key));
  const retained=await f.nativeStore.get(f.catalogKey);assert.ok(retained);
  assert.equal(JSON.parse(new TextDecoder().decode(retained.bytes)).catalog.entries[0].state,action==='delete'?'deleting':'active');
  assert.equal(f.puts.length,action==='delete'?1:0,'No stale final catalog publication.');
});

test('private backup deletion cannot finalize a catalog after native authority is lost on its last submitted chunk',async t=>{
  const f=await fixture(t),held=f.holdDelete(f.chunks.length),rejected=assert.rejects(f.manager.delete(f.backup.id),lost);
  await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(f.deletes,f.chunks.map(chunk=>chunk.key));assert.equal(f.puts.length,1);
  const retained=await f.nativeStore.get(f.catalogKey);assert.equal(JSON.parse(new TextDecoder().decode(retained.bytes)).catalog.entries[0].state,'deleting');
});

test('private backup authority requires synchronous undefined while ordinary and current-owner deletion still work',async t=>{
  const f=await fixture(t);
  for(const guard of [()=>true,async()=>undefined])await assert.rejects(f.open(guard),/synchronously return undefined/u);
  assert.equal(await f.manager.purge({confirmation:'delete all backups'}),1);assert.equal(await f.nativeStore.get(f.catalogKey),null);
  assert.equal(await f.manager.purge({confirmation:'delete all backups'}),0);
  const local=await fixture(t,false);assert.equal(await local.manager.delete(local.backup.id),true);assert.equal(await local.manager.delete(local.backup.id),false);
});

test('private local retention keeps prior backups after its held real list loses native authority',async t=>{
  const f=await fixture(t,false,1),held=f.holdLocalList(),before=await readFile(join(f.root,'backups',f.backup.id,'database.enc'));
  await new Promise(resolve=>setTimeout(resolve,2));
  const rejected=assert.rejects(f.create(),lost);
  await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(await readFile(join(f.root,'backups',f.backup.id,'database.enc')),before);
  assert.equal((await readdir(join(f.root,'backups'))).filter(name=>!name.startsWith('.')).length,2,'The newly published backup and prior retained backup both remain.');
  assert.deepEqual(await readdir(join(f.root,'backups','.staging')),[],'Owned temporary cleanup still completes.');
});

test('private abandoned-upload cleanup refuses deletion after a held authenticated catalog loses native authority',async t=>{
  const f=await fixture(t),retained=await f.abandonUpload(),held=f.holdCatalog(),rejected=assert.rejects(f.create(),lost);
  await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(f.deletes,[]);assert.deepEqual(f.puts,[]);assert.deepEqual(await f.nativeStore.get(f.catalogKey),retained);
  for(const chunk of f.chunks)assert.ok(await f.nativeStore.stat(chunk.key));
});

for(const boundary of ['first','last'])test(`private abandoned-upload cleanup stops after its submitted ${boundary} chunk without finalizing the catalog`,async t=>{
  const f=await fixture(t),retained=await f.abandonUpload(),count=boundary==='first'?1:f.chunks.length,held=f.holdDelete(count),rejected=assert.rejects(f.create(),lost);
  await held.entered;f.invalidate();held.release();await rejected;
  assert.deepEqual(f.deletes,f.chunks.slice(0,count).map(chunk=>chunk.key));assert.deepEqual(f.puts,[]);
  for(const chunk of f.chunks.slice(0,count))assert.equal(await f.nativeStore.stat(chunk.key),null);
  for(const chunk of f.chunks.slice(count))assert.ok(await f.nativeStore.stat(chunk.key));
  assert.deepEqual(await f.nativeStore.get(f.catalogKey),retained);
});
