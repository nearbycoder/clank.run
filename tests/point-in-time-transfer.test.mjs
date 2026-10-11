import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {existsSync,readdirSync,readlinkSync,renameSync,mkdirSync,writeFileSync,watch,lstatSync} from 'node:fs';
import nativeFS from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {createSQLiteTaskScope,runSQLiteTask} from '../dist/sqlite-task.js';
import {pinSQLiteDirectory,createPinnedSQLiteChildDirectory,prepareSQLiteSandbox} from '../dist/sqlite-sandbox.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,exportPointInTimeTransfer,stagePointInTimeTransfer,applyPointInTimeTransfer} from '../dist/point-in-time.js';
const key=new Uint8Array(32).fill(53),identity={handoffId:'handoff_fixture',source:{projectId:'project',nodeId:'source',releaseId:'release',generation:1},targetNodeId:'target',targetGeneration:2,artifactSha256:'a'.repeat(64)};
const cursor=archive=>({epoch:archive.epoch,sequence:archive.sequence,digest:archive.digest});
function inspect(path,work){const db=new DatabaseSync(path);try{return work(db);}finally{db.close();}}
function state(path){return inspect(path,db=>({rows:db.prepare('SELECT _data FROM clank_records ORDER BY _id').all(),capture:db.prepare('SELECT sequence,digest,state_hash FROM clank_pitr_state').get(),receipts:db.prepare('SELECT * FROM clank_pitr_transfer_receipts ORDER BY sequence').all()}));}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'clank-transfer-')),target=join(root,'target.sqlite'),source=join(root,'source.sqlite'),authority=new DatabaseSync(join(root,'authority.sqlite'));
 authority.exec('CREATE TABLE current_owners(kind TEXT PRIMARY KEY,active INTEGER);INSERT INTO current_owners VALUES(\'source\',1),(\'target\',1)');
 const check=kind=>{if(authority.prepare('SELECT active FROM current_owners WHERE kind=?').get(kind)?.active!==1)throw new Error('Native '+kind+' ownership lost.');};
 const options={identity,encryptionKey:key,targetPath:target,assertSourceCurrent(){check('source');},assertTargetCurrent(){check('target');}};
 const db=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:source});
 const recovery=await openPointInTimeRecovery(db,{directory:join(root,'journal'),encryptionKey:key,exportIntervalMs:false});
 t.after(async()=>{await recovery.close();db.close();authority.close();await rm(root,{recursive:true,force:true});});
 const archive=await exportPointInTimeRecovery(recovery,{operationId:'base_1',binding:identity.source});
 const initial=cursor(archive),stageOptions={...options,operationId:'base_1',expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest};
 return {root,source,target,db,recovery,archive,initial,options,stageOptions,authority,stage:()=>stagePointInTimeTransfer(archive,stageOptions),write(value){return db.transaction(tx=>tx.table('records').insert({value}));},batch(after,extra={}){return exportPointInTimeTransfer(recovery,{identity,after,throughSequence:recovery.status().committedThrough,...extra});},apply(batch,extra={}){return applyPointInTimeTransfer(batch,{...options,expectedCursor:batch.after,...extra});}};
}
const native=async(t,work)=>{const scope=await createSQLiteTaskScope('trusted-process');return scope.run(async()=>work(await fixture(t)));};

test('one real base and three incremental batches preserve the independent source mutation ledger and exact duplicate receipts',t=>native(t,async f=>{
 const first=await f.stage();assert.deepEqual(first.cursor,f.initial);let after=first.cursor;const ledger=[];let journalBytes=0;
 for(let batchNumber=1;batchNumber<=3;batchNumber++){
  for(let item=0;item<2;item++){const value=`batch ${batchNumber} row ${item}`;ledger.push(value);f.write(value);}
  const batch=await f.batch(after);assert.equal(batch.envelopes.length,2);assert.equal(Object.hasOwn(batch,'files'),false);journalBytes+=JSON.stringify(batch).length;
  const applied=await f.apply(batch);assert.equal(applied.appliedEntries,2);assert.equal(applied.replayed,false);after=applied.cursor;
  const before=state(f.target),replay=await f.apply(batch);assert.equal(replay.replayed,true);assert.equal(replay.appliedEntries,0);assert.deepEqual(state(f.target),before);
 }
 const rows=inspect(f.target,db=>db.prepare('SELECT _data FROM clank_records ORDER BY _id').all().map(row=>JSON.parse(row._data).value).sort());assert.deepEqual(rows,ledger.sort());
 assert.equal(state(f.target).receipts.length,3);assert.equal(state(f.target).capture.sequence,6);assert.deepEqual(state(f.target).capture,inspect(f.source,db=>db.prepare('SELECT sequence,digest,state_hash FROM clank_pitr_state').get()));assert.equal(inspect(f.target,db=>db.prepare('PRAGMA integrity_check').get().integrity_check),'ok');
 assert.equal(inspect(f.target,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('clank_pitr_state','clank_pitr_journal','clank_pitr_transfer_state')").get().n),3);
 const retry=await f.stage();assert.equal(retry.replayed,true);assert.deepEqual(retry.cursor,after);assert.equal(state(f.target).receipts.length,3);
 t.diagnostic(JSON.stringify({baseArchives:1,journalBatches:3,sourceCommits:6,journalBytes,finalSequence:after.sequence}));
}));

test('a missing prefix or changed transfer identity cannot overwrite a stopped stage',t=>native(t,async f=>{
 await f.stage();f.write('one');const first=await f.batch(f.initial);f.write('two');const second=await f.batch(first.through),before=state(f.target);
 await assert.rejects(f.apply(second),/predecessor/);assert.deepEqual(state(f.target),before);
 await assert.rejects(f.apply(first,{identity:{...identity,artifactSha256:'b'.repeat(64)}}),/identity/);
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,identity:{...identity,targetNodeId:'other'}}),/identity/);
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,expectedSequence:1}),/identity|base/);assert.deepEqual(state(f.target),before);
}));

test('tampered authenticated batches and altered native entries never publish partial application effects',t=>native(t,async f=>{
 await f.stage();f.write('one');f.write('two');const batch=await f.batch(f.initial),before=state(f.target);
 await assert.rejects(f.apply({...batch,authentication:'0'.repeat(64)}),/authentication/);
 const divergent=structuredClone(batch),entry=JSON.parse(divergent.envelopes[1]);entry.previousDigest='f'.repeat(64);divergent.envelopes[1]=JSON.stringify(entry);
 const {authentication,...content}=divergent;divergent.authentication=createHmac('sha256',key).update(JSON.stringify(content)).digest('hex');
 await assert.rejects(f.apply(divergent),/gap|divergence/);assert.deepEqual(state(f.target),before);
}));

for(const fault of ['ignore-cursor','ignore-receipt','alter-receipt','ignore-capture','alter-capture'])test(`native ${fault} rolls back the whole batch and leaves its original destination intact`,t=>native(t,async f=>{
 await f.stage();f.write('one');const batch=await f.batch(f.initial);
 inspect(f.target,db=>db.exec(fault==='ignore-capture'?"CREATE TRIGGER clank_pitr_transfer_fault BEFORE UPDATE ON clank_pitr_state BEGIN SELECT RAISE(IGNORE); END":fault==='alter-capture'?"CREATE TRIGGER clank_pitr_transfer_fault AFTER UPDATE ON clank_pitr_state BEGIN UPDATE clank_pitr_state SET digest='altered' WHERE id=NEW.id; END":fault==='ignore-cursor'?"CREATE TRIGGER clank_pitr_transfer_fault BEFORE UPDATE ON clank_pitr_transfer_state BEGIN SELECT RAISE(IGNORE); END":fault==='ignore-receipt'?"CREATE TRIGGER clank_pitr_transfer_fault BEFORE INSERT ON clank_pitr_transfer_receipts BEGIN SELECT RAISE(IGNORE); END":"CREATE TRIGGER clank_pitr_transfer_fault AFTER INSERT ON clank_pitr_transfer_receipts BEGIN UPDATE clank_pitr_transfer_receipts SET fingerprint='altered' WHERE sequence=NEW.sequence; END"));
 const before=state(f.target);await assert.rejects(f.apply(batch),/retained|diverged/);assert.deepEqual(state(f.target),before);
 inspect(f.target,db=>db.exec('DROP TRIGGER clank_pitr_transfer_fault'));assert.equal((await f.apply(batch)).appliedEntries,1);
}));

test('an independently retained cursor rejects a target rolled back to an older valid database',t=>native(t,async f=>{
 await f.stage();const old=join(f.root,'older.sqlite');await copyFile(f.target,old);f.write('one');const first=await f.batch(f.initial);await f.apply(first);
 f.write('two');const second=await f.batch(first.through);await copyFile(old,f.target);const before=state(f.target);
 await assert.rejects(f.apply(second),/predecessor/);assert.deepEqual(state(f.target),before);
}));

for(const kind of ['source','target'])test(`actual native ${kind} ownership loss after replay refuses publication`,t=>native(t,async f=>{
 await f.stage();f.write('one');const batch=await f.batch(f.initial),before=state(f.target);let revoked=false;
 const check=()=>{
  const directory=readdirSync(f.root).find(name=>name.startsWith('.clank-transfer-')),working=directory&&join(f.root,directory,'apply.sqlite');
  if(!revoked&&working&&existsSync(working)){
   try{if(inspect(working,db=>db.prepare('SELECT sequence FROM clank_pitr_state').get().sequence)===1){f.authority.prepare('UPDATE current_owners SET active=0 WHERE kind=?').run(kind);revoked=true;}}catch(error){if(!/no such table/.test(error.message))throw error;}
  }
  f.options[kind==='source'?'assertSourceCurrent':'assertTargetCurrent']();
 };
 await assert.rejects(f.apply(batch,{[kind==='source'?'assertSourceCurrent':'assertTargetCurrent']:check}),new RegExp('Native '+kind+' ownership lost'));
 assert.equal(revoked,true);assert.deepEqual(state(f.target),before);assert.deepEqual((await readdir(f.root)).filter(name=>name.startsWith('.clank-transfer-')),[]);
}));

test('loss of the actual publication acknowledgment retries the retained receipt without replaying application writes',t=>native(t,async f=>{
 await f.stage();f.write('one');const batch=await f.batch(f.initial);let lost=false;
 await assert.rejects(f.apply(batch,{assertTargetCurrent(){f.options.assertTargetCurrent();if(!lost&&state(f.target).capture.sequence===1){lost=true;throw new Error('Owned lost acknowledgment after actual publication.');}}}),/lost acknowledgment/);
 assert.equal(lost,true);const before=state(f.target),retry=await f.apply(batch);assert.equal(retry.replayed,true);assert.equal(retry.appliedEntries,0);assert.deepEqual(state(f.target),before);
}));

test('ordinary live databases and interrupted unknown workspaces are never adopted or overwritten',t=>native(t,async f=>{
 inspect(f.target,db=>db.exec('CREATE TABLE live(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO live VALUES(1,\'preserved\')'));const before=await readFile(f.target);
 await assert.rejects(f.stage(),/no such table|identity/);assert.deepEqual(await readFile(f.target),before);
 await rm(f.target);const workspace=join(f.root,'.clank-transfer-'+createHash('sha256').update(f.target).digest('hex'));await mkdir(workspace);await writeFile(join(workspace,'owned-sentinel'),'preserve');
 await assert.rejects(f.stage(),{code:'EEXIST'});assert.equal(await readFile(join(workspace,'owned-sentinel'),'utf8'),'preserve');assert.equal(existsSync(f.target),false);
}));

test('copied capture handles, a second SQLite writer and asynchronous ownership assertions are refused',t=>native(t,async f=>{
 await assert.rejects(exportPointInTimeTransfer({...f.recovery},{identity,after:f.initial,throughSequence:0}),/native.*handle/);
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,assertTargetCurrent:async()=>{}}),/synchronously/);
 f.write('captured');inspect(f.source,db=>db.exec("INSERT INTO clank_records(_id,_data,_creation_time,_version) VALUES('foreign','{}',0,1)"));
 await assert.rejects(f.batch(f.initial),/another SQLite writer/);assert.equal(existsSync(f.target),false);
}));


test('replaced parent directories preserve foreign sentinels and clean only the owned workspace',t=>native(t,async f=>{
 const parent=join(f.root,'destination'),retained=join(f.root,'retained');await mkdir(parent);let swapped=false,workspace;
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,targetPath:join(parent,'target.sqlite'),assertTargetCurrent(){
  f.options.assertTargetCurrent();workspace=readdirSync(parent).find(name=>name.startsWith('.clank-transfer-'));
  if(!swapped&&workspace){renameSync(parent,retained);mkdirSync(parent);mkdirSync(join(parent,workspace));writeFileSync(join(parent,workspace,'foreign-sentinel'),'preserved');swapped=true;}
 }}),/directory changed/);
 assert.equal(swapped,true);assert.equal(await readFile(join(parent,workspace,'foreign-sentinel'),'utf8'),'preserved');assert.deepEqual(await readdir(retained),[]);assert.equal(existsSync(join(parent,'target.sqlite')),false);
}));

test('authority loss immediately after pin acquisition closes the actual directory descriptor',t=>native(t,async f=>{
 const descriptors=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===f.root;}catch{return false;}});
 const before=descriptors();let revoked=false;
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,assertTargetCurrent(){if(descriptors().length>before.length){revoked=true;throw new Error('Ownership revoked after native pin.');}}}),/revoked after native pin/);
 assert.equal(revoked,true);assert.deepEqual(descriptors(),before);assert.equal(existsSync(f.target),false);
}));

test('a replaced private workspace is never recursively deleted during owned cleanup',t=>native(t,async f=>{
 await f.stage();f.write('one');const batch=await f.batch(f.initial);let replaced=false,original,retained=join(f.root,'retained-workspace');
 await assert.rejects(f.apply(batch,{assertTargetCurrent(){
  f.options.assertTargetCurrent();original=readdirSync(f.root).find(name=>name.startsWith('.clank-transfer-'));
  if(!replaced&&original&&existsSync(join(f.root,original,'apply.sqlite'))){renameSync(join(f.root,original),retained);mkdirSync(join(f.root,original));writeFileSync(join(f.root,original,'foreign-sentinel'),'preserved');replaced=true;throw new Error('Ownership revoked after workspace replacement.');}
 }}),/workspace replacement/);
 assert.equal(replaced,true);assert.equal(await readFile(join(f.root,original,'foreign-sentinel'),'utf8'),'preserved');assert.deepEqual(await readdir(retained),[]);assert.equal(state(f.target).capture.sequence,0);
}));

test('a retained base retry authenticates its key and exact operation before acknowledging',t=>native(t,async f=>{
 await f.stage();const before=state(f.target);
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,encryptionKey:new Uint8Array(32).fill(99)}),/authentication/);
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,operationId:'different'}),/authentication/);
 assert.deepEqual(state(f.target),before);
}));

test('the staged checkpoint may contain captured commits and subsequent batches remain incremental',t=>native(t,async f=>{
 f.write('before checkpoint');const archive=await exportPointInTimeRecovery(f.recovery,{operationId:'later_base',binding:identity.source});
 const staged=await stagePointInTimeTransfer(archive,{...f.stageOptions,operationId:'later_base',expectedSequence:archive.sequence,expectedDigest:archive.digest});
 assert.equal(staged.cursor.sequence,1);f.write('after checkpoint');const batch=await f.batch(staged.cursor);assert.equal(batch.envelopes.length,1);await f.apply(batch);assert.equal(state(f.target).rows.length,2);
}));

test('batch count, byte, prefix and closed-source limits reject without altering the destination',t=>native(t,async f=>{
 await f.stage();f.write('a'.repeat(3000));f.write('b'.repeat(3000));const before=state(f.target);
 await assert.rejects(f.batch(f.initial,{maxEntries:1}),/prefix/);await assert.rejects(f.batch(f.initial,{maxBatchBytes:4096}),/byte bound/);
 await assert.rejects(f.batch({...f.initial,digest:'f'.repeat(64)}),/prefix/);const batch=await f.batch(f.initial);
 await assert.rejects(f.apply(batch,{maxEntries:1}),/authentication/);await assert.rejects(f.apply(batch,{maxBatchBytes:4096}),/byte bound/);
 await f.recovery.close();await assert.rejects(f.batch(f.initial),/native.*handle/);assert.deepEqual(state(f.target),before);
}));


test('real trusted native workers retain the original directory after its visible parent is replaced',t=>native(t,async f=>{
 await f.stage();const parent=join(f.root,'pinned-worker'),retained=join(f.root,'retained-worker');await mkdir(parent);await copyFile(f.target,join(parent,'database.sqlite'));
 const pin=await pinSQLiteDirectory(parent);
 assert.equal(Object.isFrozen(pin),true);assert.throws(()=>{pin.fd=0;},TypeError);
 try{
  renameSync(parent,retained);await mkdir(parent);inspect(join(parent,'database.sqlite'),db=>db.exec("CREATE TABLE foreign_sentinel(value TEXT);INSERT INTO foreign_sentinel VALUES('preserved')"));const foreign=await readFile(join(parent,'database.sqlite'));
  const result=await runSQLiteTask('recovery','inspectTransfer',[join(parent,'database.sqlite'),{identity}],[pin]);assert.deepEqual(result.cursor,f.initial);assert.deepEqual(await readFile(join(parent,'database.sqlite')),foreign);
  await assert.rejects(runSQLiteTask('recovery','inspectTransfer',[join(parent,'database.sqlite'),{identity}],[{...pin}]),/capability/);
  await assert.rejects(createPinnedSQLiteChildDirectory({...pin},'child',()=>{}),/capability/);
  await assert.rejects(prepareSQLiteSandbox('recovery','inspectTransfer',[join(parent,'database.sqlite')],[],[{...pin}]),/capability/);
 }finally{await pin.close();}
 await assert.rejects(runSQLiteTask('recovery','inspectTransfer',[join(parent,'database.sqlite'),{identity}],[pin]),/capability/);
}));


test('caller code cannot replace a newly created workspace before its ownership is retained',t=>native(t,async f=>{
 let replaced=false,name;const retained=join(f.root,'retained-new-workspace');
 await assert.rejects(stagePointInTimeTransfer(f.archive,{...f.stageOptions,assertTargetCurrent(){
  name=readdirSync(f.root).find(value=>value.startsWith('.clank-transfer-'));
  if(!replaced&&name){renameSync(join(f.root,name),retained);mkdirSync(join(f.root,name));writeFileSync(join(f.root,name,'foreign-sentinel'),'preserved');replaced=true;}
 }}),/workspace changed/);
 assert.equal(replaced,true);assert.equal(await readFile(join(f.root,name,'foreign-sentinel'),'utf8'),'preserved');assert.deepEqual(await readdir(retained),[]);assert.equal(existsSync(f.target),false);
}));

test('a real filesystem watcher cannot make transfer cleanup adopt a replacement workspace',t=>native(t,async f=>{
 const name='.clank-transfer-'+createHash('sha256').update(f.target).digest('hex'),workspace=join(f.root,name),retained=join(f.root,'watcher-retained-workspace');
 let replaced=false,watchError,originalInode,replacementInode;
 const watcher=watch(f.root,()=>{
  if(replaced||!existsSync(workspace))return;
  try{
   originalInode=lstatSync(workspace).ino;renameSync(workspace,retained);mkdirSync(workspace);
   writeFileSync(join(workspace,'foreign-sentinel'),'preserved');replacementInode=lstatSync(workspace).ino;replaced=true;
  }catch(error){watchError=error;}
 });
 let failure;
 try{await f.stage();}catch(error){failure=error;}finally{watcher.close();}
 assert.equal(watchError,undefined);assert.equal(replaced,true);assert.notEqual(originalInode,replacementInode);
 assert.equal(await readFile(join(workspace,'foreign-sentinel'),'utf8'),'preserved');
 assert.match(failure?.message??'',/workspace changed/);assert.deepEqual(await readdir(retained),[]);assert.equal(existsSync(f.target),false);
 t.diagnostic(JSON.stringify({originalInode,replacementInode,foreignSentinelPreserved:true,retainedWorkspaceEmpty:true}));
}));

for(const fault of ['open-failure-empty','open-failure-sentinel','identity-mismatch'])test(`failed workspace retention preserves uncertain paths: ${fault}`,t=>native(t,async f=>{
 const name='.clank-transfer-'+createHash('sha256').update(f.target).digest('hex'),workspace=join(f.root,name),retained=join(f.root,'failed-pin-retained');
 const originalOpen=nativeFS.openSync;let replaced=false,descriptor,originalInode,replacementInode;
 // Fault injection covers the failed-pin branch; the separate watcher test uses
 // actual fs.watch and no mocked filesystem operations.
 const mock=t.mock.method(nativeFS,'openSync',(path,...args)=>{
  if(!replaced&&String(path).endsWith('/'+name)){
   if(fault==='identity-mismatch')descriptor=originalOpen(path,...args);
   originalInode=lstatSync(workspace).ino;renameSync(workspace,retained);mkdirSync(workspace);
   if(fault!=='open-failure-empty')writeFileSync(join(workspace,'foreign-sentinel'),'preserved');
   replacementInode=lstatSync(workspace).ino;replaced=true;
   if(fault==='identity-mismatch')return descriptor;
   throw Object.assign(new Error('Injected native workspace open failure.'),{code:'EACCES'});
  }
  return originalOpen(path,...args);
 });syncBuiltinESMExports();
 try{await assert.rejects(f.stage(),/open failure|changed while being retained/);}finally{mock.mock.restore();syncBuiltinESMExports();}
 assert.equal(replaced,true);assert.notEqual(originalInode,replacementInode);
 assert.equal(lstatSync(workspace).ino,replacementInode);assert.deepEqual(await readdir(retained),[]);assert.equal(existsSync(f.target),false);
 if(fault!=='open-failure-empty')assert.equal(await readFile(join(workspace,'foreign-sentinel'),'utf8'),'preserved');
 else assert.deepEqual(await readdir(workspace),[]);
 if(descriptor!==undefined)assert.throws(()=>nativeFS.fstatSync(descriptor),{code:'EBADF'});
}));
