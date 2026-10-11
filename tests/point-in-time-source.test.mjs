import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {openSQLite,createSQLiteDatabase,defineDatabase,defineTable} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,exportPointInTimeTransfer,openPointInTimeTransferSource,inspectPointInTimeTransferSourceSeal,exportSealedPointInTimeTransfer,stagePointInTimeTransfer,applyPointInTimeTransfer} from '../dist/point-in-time.js';
const key=new Uint8Array(32).fill(73),schema=defineDatabase({records:defineTable({value:s.string()})});
const identity={handoffId:'source_fixture',source:{projectId:'project',nodeId:'source',releaseId:'release',generation:1},targetNodeId:'target',targetGeneration:2,artifactSha256:'a'.repeat(64)};
const cursor=a=>({epoch:a.epoch,sequence:a.sequence,digest:a.digest});
const native=async(t,work)=>{const scope=await createSQLiteTaskScope('trusted-process');return scope.run(async()=>work(await fixture(t)));};
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'clank-source-')),path=join(root,'source.sqlite'),authority=new DatabaseSync(join(root,'authority.sqlite'));
 authority.exec('CREATE TABLE owner(id INTEGER PRIMARY KEY, active INTEGER);INSERT INTO owner VALUES(1,1)');
 const assertSourceCurrent=()=>{assert.equal(authority.prepare('SELECT active FROM owner WHERE id=1').get().active,1,'native authority lost');};
 const db=await openSQLite(schema,{path,busyTimeout:25,changePollIntervalMs:0,...options});
 const recovery=await openPointInTimeRecovery(db,{directory:join(root,'journal'),encryptionKey:key,exportIntervalMs:false});
 const archive=await exportPointInTimeRecovery(recovery,{operationId:'base_1',binding:identity.source});
 const binding={identity,baseOperationId:'base_1',baseArchiveSha256:createHash('sha256').update(JSON.stringify(archive)).digest('hex'),initialCursor:cursor(archive)};
 let closed=false;async function close(){if(closed)return;try{await recovery.close();}catch{}db.close();closed=true;}
 t.after(async()=>{await close();authority.close();await rm(root,{recursive:true,force:true});});
 return {root,path,db,recovery,archive,binding,assertSourceCurrent,authority,close,write(value){return db.transaction(tx=>tx.table('records').insert({value}));},open(extra={}){return openPointInTimeTransferSource(recovery,{...binding,assertSourceCurrent,...extra});},inspect(after,extra={}){return inspectPointInTimeTransferSourceSeal({...binding,sourcePath:path,encryptionKey:key,after,assertCurrent:assertSourceCurrent,...extra});}};
}
function foreign(path){const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=25');return db;}
function processWrite(path){return spawnSync(process.execPath,['--input-type=module','--eval',`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);try{d.exec("PRAGMA busy_timeout=25;INSERT INTO clank_meta VALUES('foreign_probe',1)");process.stdout.write('committed');}catch(e){process.stdout.write(e.code+':'+e.message);process.exitCode=7;}finally{d.close();}`,path],{encoding:'utf8',timeout:3000});}

test('native ownership bars actual foreign handles and processes across three batches, then seals without changing journal/application history',t=>native(t,async f=>{
 const early=foreign(f.path);t.after(()=>early.close());
 const source=f.open();assert.equal(f.open(),source);
 let after=f.binding.initialCursor;const acknowledged=[];
 for(let i=0;i<3;i++){
  f.write(`owned-${i}`);acknowledged.push(`owned-${i}`);
  assert.throws(()=>early.prepare('SELECT * FROM clank_meta').all(),/locked/);
  const attempt=processWrite(f.path);assert.equal(attempt.status,7);assert.match(attempt.stdout,/locked/);
  const batch=await source.export({after,throughSequence:f.recovery.status().committedThrough});assert.equal(batch.envelopes.length,1);after=batch.through;
 }
 const before=f.recovery.status(),version=f.db.version;const seal=source.seal(after);
 assert.deepEqual(f.recovery.status(),before);assert.equal(f.db.version,version);assert.deepEqual(seal.through,after);assert.deepEqual(source.seal(after),seal);
 assert.throws(()=>f.write('forbidden'),/terminal/);assert.equal(f.db.read(db=>db.table('records').collect()).length,3);
 await assert.rejects(source.export({after:f.binding.initialCursor,throughSequence:3,identity:{...identity,targetNodeId:'override'}}),/overridden/);
 await assert.rejects(exportPointInTimeTransfer(f.recovery,{identity:{...identity,targetNodeId:'other'},after:f.binding.initialCursor,throughSequence:3}),/identity/);
 const replay=await exportPointInTimeRecovery(f.recovery,{operationId:'base_1',binding:identity.source});assert.deepEqual(replay,f.archive);
 await assert.rejects(exportPointInTimeRecovery(f.recovery,{operationId:'new',binding:identity.source}),/retained base/);
 await assert.rejects(f.inspect(after),/locked|busy|resource|deadline/);
 early.close=(()=>{const close=early.close.bind(early);let done=false;return()=>{if(!done){close();done=true;}};})();early.close();
 await f.close();assert.deepEqual(await f.inspect(after),seal);
 assert.equal(processWrite(f.path).status,0,'native close releases lock; seal does not claim stop proof');
}));

test('warmed foreign connection refuses native enrollment and the failed acquisition poisons managed writes',t=>native(t,async f=>{
 const other=foreign(f.path);other.prepare('SELECT * FROM clank_meta').all();
 assert.throws(()=>f.open(),/locked/);other.close();
 assert.throws(()=>f.write('no fallback'),/fenced|uncertain/);assert.throws(()=>f.open(),/fenced|uncertain/);
}));

test('foreign commit after the authenticated base refuses continuity even if later exclusive acquisition would succeed',t=>native(t,async f=>{
 const other=foreign(f.path);other.exec("INSERT INTO clank_meta VALUES('gap',1)");other.close();
 assert.throws(()=>f.open(),/another SQLite writer|evidence/);assert.throws(()=>f.write('no rebase'),/writer|fenced/);
}));

test('readonly restart seal and bounded terminal tail catch up the same stopped target',t=>native(t,async f=>{
 const target=join(f.root,'target.sqlite'),authority={assertSourceCurrent:f.assertSourceCurrent,assertTargetCurrent:f.assertSourceCurrent};
 await stagePointInTimeTransfer(f.archive,{...authority,identity,encryptionKey:key,targetPath:target,operationId:'base_1',expectedEpoch:f.archive.epoch,expectedSequence:f.archive.sequence,expectedDigest:f.archive.digest});
 const source=f.open();for(let i=0;i<3;i++)f.write(`tail-${i}`);
 const seal=source.seal(f.binding.initialCursor);await f.close();assert.deepEqual(await f.inspect(f.binding.initialCursor),seal);
 let expected=f.binding.initialCursor;
 for(let i=1;i<=3;i++){
  const options={...f.binding,sourcePath:f.path,encryptionKey:key,after:f.binding.initialCursor,assertCurrent:f.assertSourceCurrent,expectedCursor:expected,throughSequence:i,maxEntries:1};
  const batch=await exportSealedPointInTimeTransfer(options);assert.deepEqual(await exportSealedPointInTimeTransfer(options),batch);
  const result=await applyPointInTimeTransfer(batch,{...authority,identity,encryptionKey:key,targetPath:target,expectedCursor:expected});expected=result.cursor;
 }
 const db=foreign(target);try{assert.deepEqual(db.prepare('SELECT _data FROM clank_records ORDER BY _data').all().map(r=>JSON.parse(r._data).value),['tail-0','tail-1','tail-2']);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
 assert.deepEqual(expected,seal.through);
 await assert.rejects(f.inspect({...f.binding.initialCursor,digest:'f'.repeat(64)}),/evidence/);
 await assert.rejects(f.inspect(f.binding.initialCursor,{encryptionKey:new Uint8Array(32)}),/evidence/);
 await assert.rejects(f.inspect(f.binding.initialCursor,{sourcePath:join(f.root,'missing.sqlite')}),/ENOENT/);
}));

for(const setting of [{durability:'normal'},{wal:false}])test(`nonexclusive configuration ${JSON.stringify(setting)} refuses without changing operator modes`,async t=>{
 const scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{const f=await fixture(t,setting);assert.throws(()=>f.open(),/WAL|FULL/);f.write('ordinary capture still works');});
});

test('active transactions, read snapshots and authority reentry cannot begin a source control decision',t=>native(t,async f=>{
 assert.throws(()=>f.db.read(()=>f.open()),/idle/);assert.throws(()=>f.db.transaction(()=>f.open()),/idle/);
 const original=f.assertSourceCurrent;assert.throws(()=>f.open({assertSourceCurrent(){original();f.db.close();}}),/control|reent|idle/);
 f.write('still open');
 assert.throws(()=>f.open({assertSourceCurrent:async()=>{}}),/synchronously/);
}));

test('enrollment requires the real operation-bound base and frozen exact identity',t=>native(t,async f=>{
 for(const change of [{baseOperationId:'missing'},{baseArchiveSha256:'f'.repeat(64)},{initialCursor:{...f.binding.initialCursor,digest:'f'.repeat(64)}},{identity:{...identity,targetGeneration:1}}])assert.throws(()=>f.open(change),/evidence|Invalid/);
 const source=f.open();assert.throws(()=>f.open({identity:{...identity,targetNodeId:'other'}}),/conflict/);
 f.write('one');await assert.rejects(source.export({after:f.binding.initialCursor,throughSequence:1,assertSourceCurrent(){}}),/overridden/);
 const promise=source.export({after:f.binding.initialCursor,throughSequence:1});f.authority.exec('UPDATE owner SET active=0');await assert.rejects(promise,/authority/);assert.throws(()=>f.write('stale'),/uncertain/);
}));

for(const alteration of ['DROP TABLE clank_pitr_source_seal','DELETE FROM clank_pitr_source_seal','UPDATE clank_pitr_source_seal SET receipt=\'{}\'','UPDATE clank_pitr_state SET remote_exports_protocol=9'])test(`read-only inspection never heals ${alteration}`,t=>native(t,async f=>{
 const source=f.open();source.seal(f.binding.initialCursor);await f.close();const db=foreign(f.path);db.exec(alteration);db.close();
 const before=await readFile(f.path);await assert.rejects(f.inspect(f.binding.initialCursor),/evidence|table/);assert.deepEqual(await readFile(f.path),before);
}));

for(const mode of ['before','uncommitted','committed'])test(`real SIGKILL ${mode} terminal decision preserves exact proof and never manufactures an uncommitted seal`,async t=>{
 const {fork}=await import('node:child_process'),root=await mkdtemp(join(tmpdir(),'clank-source-kill-'));
 const child=fork(new URL('./fixtures/point-in-time-source-worker.mjs',import.meta.url),[root,mode],{stdio:['ignore','pipe','pipe','ipc']});let exited=false;
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
 let output='';child.stderr.on('data',chunk=>output+=chunk.toString());child.stdout.resume();
 const messages=[],waiting=[];child.on('message',message=>{const waiter=waiting.shift();if(waiter)waiter(message);else messages.push(message);});
 const next=()=>new Promise((resolve,reject)=>{if(messages.length)return resolve(messages.shift());const timer=setTimeout(()=>reject(new Error('source fixture timed out: '+output)),10000);waiting.push(value=>{clearTimeout(timer);resolve(value);});});
 t.after(async()=>{if(!exited){child.kill('SIGKILL');await exit;}await rm(root,{recursive:true,force:true});});
 const ready=await next();assert.equal(ready.event,'ready');child.send('seal');assert.equal((await next()).event,mode);child.kill('SIGKILL');assert.deepEqual(await exit,{code:null,signal:'SIGKILL'});
 const scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{
  const authority=foreign(join(root,'authority.sqlite')),assertCurrent=()=>{assert.equal(authority.prepare('SELECT active FROM owner WHERE id=1').get().active,1);};
  try{
   const options={...ready.binding,sourcePath:join(root,'source.sqlite'),encryptionKey:key,after:ready.binding.initialCursor,assertCurrent};
   if(mode!=='committed'){await assert.rejects(inspectPointInTimeTransferSourceSeal(options),/evidence/);const db=foreign(options.sourcePath);try{assert.equal(db.prepare('SELECT remote_exports_protocol FROM clank_pitr_state').get().remote_exports_protocol,1);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_pitr_source_seal'").get().n,0);}finally{db.close();}return;}
   const seal=await inspectPointInTimeTransferSourceSeal(options);assert.equal(seal.through.sequence,3);
   const target=join(root,'target.sqlite'),targetAuthority={assertSourceCurrent:assertCurrent,assertTargetCurrent:assertCurrent};
   await stagePointInTimeTransfer(ready.archive,{...targetAuthority,identity,encryptionKey:key,targetPath:target,operationId:'base_1',expectedEpoch:ready.archive.epoch,expectedSequence:ready.archive.sequence,expectedDigest:ready.archive.digest});
   let expected=ready.binding.initialCursor;
   for(let sequence=1;sequence<=3;sequence++){const batch=await exportSealedPointInTimeTransfer({...options,expectedCursor:expected,throughSequence:sequence,maxEntries:1});const applied=await applyPointInTimeTransfer(batch,{...targetAuthority,identity,encryptionKey:key,targetPath:target,expectedCursor:expected});expected=applied.cursor;}
   const db=foreign(target);try{assert.deepEqual(db.prepare('SELECT _data FROM clank_records ORDER BY _data').all().map(row=>JSON.parse(row._data).value),ready.ledger);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
   assert.deepEqual(expected,seal.through);t.diagnostic(JSON.stringify({signal:'SIGKILL',acknowledgedCommits:ready.ledger.length,tailBatches:3,finalSequence:expected.sequence}));
  }finally{authority.close();}
 });
});

for(const fault of ['ignore-insert','alter-insert','ignore-state','alter-state'])test(`actual native ${fault} rolls back terminal table and protocol together`,t=>native(t,async f=>{
 const source=f.open(),exec=DatabaseSync.prototype.exec;let injected=false;
 DatabaseSync.prototype.exec=function(sql){const result=Reflect.apply(exec,this,[sql]);if(sql.startsWith('CREATE TABLE clank_pitr_source_seal')&&!injected){injected=true;Reflect.apply(exec,this,[fault==='ignore-insert'?"CREATE TRIGGER clank_pitr_fault BEFORE INSERT ON clank_pitr_source_seal BEGIN SELECT RAISE(IGNORE); END":fault==='alter-insert'?"CREATE TRIGGER clank_pitr_fault AFTER INSERT ON clank_pitr_source_seal BEGIN UPDATE clank_pitr_source_seal SET receipt='{}'; END":fault==='ignore-state'?"CREATE TRIGGER clank_pitr_fault BEFORE UPDATE OF remote_exports_protocol ON clank_pitr_state BEGIN SELECT RAISE(IGNORE); END":"CREATE TRIGGER clank_pitr_fault AFTER UPDATE OF remote_exports_protocol ON clank_pitr_state BEGIN UPDATE clank_pitr_state SET digest='altered'; END"]);}return result;};
 try{assert.throws(()=>source.seal(f.binding.initialCursor),/evidence|retained/);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(injected,true);assert.throws(()=>f.write('no uncertainty fallback'),/uncertain/);await f.close();const db=foreign(f.path);try{assert.equal(db.prepare('SELECT remote_exports_protocol FROM clank_pitr_state').get().remote_exports_protocol,1);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_pitr_source_seal'").get().n,0);}finally{db.close();}
}));

for(const kind of ['terminal','unknown','partial','seal-view'])test(`bootstrap refuses ${kind} before connection PRAGMAs or schema effects`,t=>native(t,async f=>{
 const source=f.open();source.seal(f.binding.initialCursor);await f.close();const db=foreign(f.path);
 try{
  if(kind==='unknown')db.exec('DROP TABLE clank_pitr_source_seal;UPDATE clank_pitr_state SET remote_exports_protocol=9');
  if(kind==='partial')db.exec('DROP TABLE clank_pitr_source_seal;DROP TABLE clank_pitr_remote_exports;UPDATE clank_pitr_state SET remote_exports_protocol=1');
  if(kind==='seal-view')db.exec('DROP TABLE clank_pitr_source_seal;UPDATE clank_pitr_state SET remote_exports_protocol=1;CREATE VIEW clank_pitr_source_seal AS SELECT 1');
  db.exec('PRAGMA foreign_keys=OFF;PRAGMA synchronous=NORMAL');const before=db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
  assert.throws(()=>createSQLiteDatabase(schema,db,{path:f.path}),/terminal|partial|unsupported|metadata/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,0);assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,1);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(),before);
 }finally{db.close();}
 await assert.rejects(openSQLite(schema,{path:f.path}),/terminal|partial|unsupported|metadata/);
}));

for(const structural of [false,true])test(`a manually supplied ${structural?'structural adapter':'genuine DatabaseSync'} cannot acquire native source capability`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-unregistered-')),path=join(root,'source.sqlite'),raw=new DatabaseSync(path);
 const adapter=structural?{exec:sql=>raw.exec(sql),prepare:sql=>raw.prepare(sql),createSession:opts=>raw.createSession(opts),close:()=>raw.close()}:raw;
 const db=createSQLiteDatabase(schema,adapter,{path,changePollIntervalMs:0});let connection;
 db[SQLITE_INTERNAL].captureTransactions(value=>{connection=value;return {before(){},commit(){},after(){},close(){}};});
 try{assert.throws(()=>connection.assertNativeIdle(),/opened by openSQLite/);assert.throws(()=>connection.withNativeControl(()=>{}),/opened by openSQLite/);}finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('native control rejects raw transactions, async handlers and every managed reentry while clearing its flag on failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-native-control-')),db=await openSQLite(schema,{path:join(root,'source.sqlite'),changePollIntervalMs:0});let connection;
 const cached=db[SQLITE_INTERNAL].prepare('SELECT 1');db[SQLITE_INTERNAL].captureTransactions(value=>{connection=value;return {before(){},commit(){},after(){},close(){}};});
 try{
  connection.exec('BEGIN');assert.throws(()=>connection.assertNativeIdle(),/idle/);assert.throws(()=>connection.withNativeControl(()=>{}),/idle/);connection.exec('ROLLBACK');
  for(const reenter of [()=>db.close(),()=>db.version,()=>db.read(()=>{}),()=>db.transaction(()=>{}),()=>cached.get(),()=>db[SQLITE_INTERNAL].prepare('SELECT 1'),()=>connection.withNativeControl(()=>{})])assert.throws(()=>connection.withNativeControl(reenter),/reentry/);
  assert.throws(()=>connection.withNativeControl(async()=>{}),/synchronously/);assert.doesNotThrow(()=>connection.assertNativeIdle());assert.equal(db.read(()=>42),42);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('lost native COMMIT acknowledgment can replay its exact durable seal without resuming source writes',t=>native(t,async f=>{
 const source=f.open(),exec=DatabaseSync.prototype.exec;let armed=false,lost=false;
 DatabaseSync.prototype.exec=function(sql){const result=Reflect.apply(exec,this,[sql]);if(sql.startsWith('CREATE TABLE clank_pitr_source_seal'))armed=true;if(armed&&sql==='COMMIT'&&!lost){lost=true;throw new Error('lost native commit acknowledgment');}return result;};
 try{assert.throws(()=>source.seal(f.binding.initialCursor),/lost native/);}finally{DatabaseSync.prototype.exec=exec;}
 const receipt=source.seal(f.binding.initialCursor);assert.equal(receipt.protocol,'clank-pitr-source-seal/1');assert.deepEqual(source.seal(f.binding.initialCursor),receipt);
 assert.throws(()=>f.write('cannot resume'),/uncertain/);await f.close();assert.deepEqual(await f.inspect(f.binding.initialCursor),receipt);
}));

test('authenticated final journal time cannot be replaced even when target is caught up',t=>native(t,async f=>{
 const source=f.open();f.write('one');const batch=await source.export({after:f.binding.initialCursor,throughSequence:1});
 const prepare=DatabaseSync.prototype.prepare;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=Reflect.apply(prepare,this,[sql]);if(sql==='SELECT * FROM clank_pitr_state LIMIT 2'&&!injected){injected=true;Reflect.apply(prepare,this,['UPDATE clank_pitr_state SET committed_at=committed_at+1']).run();}return statement;};
 try{assert.throws(()=>source.seal(batch.through),/evidence/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(injected,true);await f.close();const db=foreign(f.path);try{assert.equal(db.prepare('SELECT remote_exports_protocol FROM clank_pitr_state').get().remote_exports_protocol,1);}finally{db.close();}
}));

test('read-only returned proof is deeply immutable and authority is rechecked after pinned descriptor cleanup',t=>native(t,async f=>{
 const source=f.open(),seal=source.seal(f.binding.initialCursor);await f.close();const proof=await f.inspect(f.binding.initialCursor);
 assert.throws(()=>{proof.identity.source.generation=99;},TypeError);assert.throws(()=>{proof.after.sequence=99;},TypeError);assert.deepEqual(proof,seal);
}));

test('authority revoked during final directory close cannot acknowledge read-only inspection',t=>native(t,async f=>{
 const source=f.open();source.seal(f.binding.initialCursor);await f.close();
 const {default:fs}=await import('node:fs/promises'),{syncBuiltinESMExports}=await import('node:module'),open=fs.open;let revoked=false;
 fs.open=async function(path,...args){const handle=await Reflect.apply(open,this,[path,...args]);if(String(path).endsWith('/'+f.root.split('/').at(-1))){const close=handle.close.bind(handle);handle.close=async()=>{await close();f.authority.exec('UPDATE owner SET active=0');revoked=true;};}return handle;};syncBuiltinESMExports();
 try{await assert.rejects(f.inspect(f.binding.initialCursor),/authority/);assert.equal(revoked,true);}finally{fs.open=open;syncBuiltinESMExports();}
}));

test('oversized terminal tail refuses before mutation and allows further catchup',t=>native(t,async f=>{
 const source=f.open();for(let i=0;i<5;i++)f.write(`${i}:`+'x'.repeat(500000));
 assert.throws(()=>source.seal(f.binding.initialCursor),/bounded transfer window|byte bound/);
 const prefix=await source.export({after:f.binding.initialCursor,throughSequence:2});
 const receipt=source.seal(prefix.through);assert.equal(receipt.through.sequence,5);assert.equal(receipt.after.sequence,2);
}));

test('loss of actual native locking mode poisons the enrolled source before a managed handler',t=>native(t,async f=>{
 const exec=DatabaseSync.prototype.exec;let owner;
 DatabaseSync.prototype.exec=function(sql){if(sql==='PRAGMA locking_mode=EXCLUSIVE')owner=this;return Reflect.apply(exec,this,[sql]);};
 try{f.open();}finally{DatabaseSync.prototype.exec=exec;}
 assert.ok(owner);assert.equal(owner.prepare('PRAGMA locking_mode=NORMAL').get().locking_mode,'normal');let entered=false;
 assert.throws(()=>f.db.transaction(()=>{entered=true;}),/exclusivity/);assert.equal(entered,false);owner.exec('PRAGMA locking_mode=EXCLUSIVE');assert.throws(()=>f.write('no unfence'),/uncertain/);
}));

test('authority loss after the first native acquisition effect leaves failed enrollment fenced',t=>native(t,async f=>{
 const exec=DatabaseSync.prototype.exec;let affected=false;
 DatabaseSync.prototype.exec=function(sql){const result=Reflect.apply(exec,this,[sql]);if(sql==='PRAGMA locking_mode=EXCLUSIVE'){affected=true;f.authority.exec('UPDATE owner SET active=0');}return result;};
 try{assert.throws(()=>f.open(),/authority/);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(affected,true);f.authority.exec('UPDATE owner SET active=1');assert.throws(()=>f.write('no fallback'),/uncertain/);
}));

test('an empty epoch compares native commit time to its authenticated retained base',t=>native(t,async f=>{
 const source=f.open(),prepare=DatabaseSync.prototype.prepare;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=Reflect.apply(prepare,this,[sql]);if(sql==='SELECT * FROM clank_pitr_state LIMIT 2'&&!injected){injected=true;Reflect.apply(prepare,this,['UPDATE clank_pitr_state SET committed_at=committed_at+1234']).run();}return statement;};
 try{assert.throws(()=>source.seal(f.binding.initialCursor),/evidence/);}finally{DatabaseSync.prototype.prepare=prepare;}
}));

test('duplicate native journal rows cannot be adopted as a valid terminal prefix',t=>native(t,async f=>{
 const source=f.open();f.write('one');const batch=await source.export({after:f.binding.initialCursor,throughSequence:1});const prepare=DatabaseSync.prototype.prepare;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=Reflect.apply(prepare,this,[sql]);if(sql==='SELECT * FROM clank_pitr_state LIMIT 2'&&!injected){injected=true;this.exec('ALTER TABLE clank_pitr_journal RENAME TO clank_pitr_old;CREATE TABLE clank_pitr_journal(sequence INTEGER,envelope TEXT);INSERT INTO clank_pitr_journal SELECT * FROM clank_pitr_old;INSERT INTO clank_pitr_journal SELECT * FROM clank_pitr_old;DROP TABLE clank_pitr_old');}return statement;};
 try{assert.throws(()=>source.seal(batch.through),/evidence/);}finally{DatabaseSync.prototype.prepare=prepare;}
}));

test('a foreign commit in the actual base-validation-to-exclusive-acquisition gap is detected after successful native acquisition',t=>native(t,async f=>{
 const exec=DatabaseSync.prototype.exec;let injected=false,acquired=false;
 DatabaseSync.prototype.exec=function(sql){
  if(sql==='PRAGMA locking_mode=EXCLUSIVE'&&!injected){injected=true;const other=foreign(f.path);try{other.exec("INSERT INTO clank_meta VALUES('acquisition_gap',1)");}finally{other.close();}}
  const result=Reflect.apply(exec,this,[sql]);if(injected&&sql==='BEGIN IMMEDIATE')acquired=true;return result;
 };
 try{assert.throws(()=>f.open(),/another SQLite writer/);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(injected,true);assert.equal(acquired,true);let entered=false;assert.throws(()=>f.db.transaction(()=>{entered=true;}),/writer|uncertain/);assert.equal(entered,false);
}));
