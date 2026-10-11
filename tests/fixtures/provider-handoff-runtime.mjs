import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {openBackend,defineBackend,defineDatabase,defineTable} from '../../dist/backend.js';
import {s} from '../../dist/ai.js';
import {SQLITE_INTERNAL} from '../../dist/sqlite-internal.js';
import {exportPointInTimeRecovery,exportPointInTimeTransfer,openPointInTimeTransferSource} from '../../dist/point-in-time.js';
import {runSQLiteTask,SQLiteTaskScheduler} from '../../dist/sqlite-task.js';
import {join} from 'node:path';
if(process.argv[2]==='foreign-lock'){
 const db=new DatabaseSync(process.argv[3]);try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');db.prepare("INSERT INTO clank_meta(_key,_value) VALUES('foreign_lock',1)").run();db.exec('COMMIT');process.stdout.write(JSON.stringify({admitted:true})+'\n');}catch(error){process.stdout.write(JSON.stringify({admitted:false,message:error.message})+'\n');}finally{db.close();}
}else{
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
const report=value=>process.stdout.write(JSON.stringify(value)+'\n');
const schema=defineDatabase({records:defineTable({value:s.string()})});
const runtimePending=openBackend(defineBackend({schema}).functions(()=>({})),{path:config.database,agent:false,changePollIntervalMs:0});
if(config.mode==='restart-refuse'){
 let runtime;
 try{runtime=await runtimePending;}catch(error){
  assert.ok(error instanceof Error);
  assert.equal(error.message,'This database requires point-in-time recovery capture before admitting writes.');
  report({ok:true,mode:config.mode,refusal:'backend-open'});
 }
 if(runtime)try{
  Object.defineProperty(globalThis,Symbol.for('clank.provider.source.bootstrap.v1'),{value:JSON.stringify(config.bootstrap),writable:false,enumerable:false,configurable:true});
  assert.throws(()=>openBackend[SQLITE_INTERNAL].initializeSourceRuntime(runtime),/pristine/);
  assert.throws(()=>runtime.database.transaction(()=>{}),/capture|recovery/i);
  report({ok:true,mode:config.mode,refusal:'source-initialize'});
 }finally{runtime.close();}
}else{
const runtime=await runtimePending;
const anchor=openBackend[SQLITE_INTERNAL],slot=Symbol.for('clank.provider.source.bootstrap.v1');
const cached=runtime.database[SQLITE_INTERNAL].prepare("INSERT INTO clank_meta(_key,_value) VALUES('bootstrap_escape',1)");

let held=false,spawns=0;const queuedInputs=[],queueTasks=[];
const gate=async label=>{if(held)return;held=true;report({phase:'held',label,spawns});const command=JSON.parse((await lines.next()).value);if(command.close)runtime.close();};
if(config.sourceTask){
 let token;const pins=[];const freeze=Object.freeze;
 Object.freeze=function(value){
  const result=freeze(value);
  if(value?.path===config.database&&Object.hasOwn(value,'token')&&typeof value.control==='function')token=value.token;
  if(value?.path?.startsWith(config.app)&&typeof value.fd==='number'&&typeof value.close==='function'&&value.anchor===`/proc/self/fd/${value.fd}`)pins.push(value);
  return result;
 };
 const spawn=childProcess.spawn;childProcess.spawn=(...args)=>{spawns++;return spawn(...args);};syncBuiltinESMExports();
 const acquire=SQLiteTaskScheduler.prototype.acquire;let exercised=false;
 SQLiteTaskScheduler.prototype.acquire=async function(tenant){
  if(tenant!==config.app||exercised)return acquire.call(this,tenant);
  exercised=true;Object.freeze=freeze;
  assert.ok(token);const stage=pins.find(pin=>pin.path.includes('/base/.stage-bk_'));assert.ok(stage);
  const id=stage.path.split('/.stage-')[1],base=join(config.app,'.clank-source-recovery-'+config.bootstrap.binding.sourceIncarnation,'base');
  const directories=[config.app,join(config.app,'.clank-source-recovery-'+config.bootstrap.binding.sourceIncarnation),base,stage.path].map(path=>pins.find(pin=>pin.path===path));
  assert.ok(directories.every(Boolean));
  const snapshot=join(base,'.snapshot-'+id+'.sqlite'),verified=join(base,'.verified-'+id+'.sqlite'),temporaryId=crypto.randomUUID();
  const backup=[config.database,snapshot,snapshot+'.tmp-'+temporaryId];
  const request=runSQLiteTask[SQLITE_INTERNAL]?.sourceRequest;
  const before=spawns;
  if(config.sourceTask==='queued-argument-mutation'||config.sourceTask==='queued-directory-mutation'){
   const foreign=join(config.app,'unapproved.sqlite');
   for(const [file,revision] of [[snapshot,73],[foreign,51]]){const db=new DatabaseSync(file);try{db.exec("CREATE TABLE clank_meta(_key TEXT PRIMARY KEY,_value INTEGER); INSERT INTO clank_meta VALUES('global_version',"+revision+")");}finally{db.close();}}
   const snapshotIdentity=fs.statSync(snapshot),args=[snapshot],mutableDirectories=[...directories];
   SQLiteTaskScheduler.prototype.acquire=async function(tenant){
    if(config.sourceTask==='queued-argument-mutation')args[0]=foreign;
    else mutableDirectories[2]={...mutableDirectories[2]};
    return acquire.call(this,tenant);
   };
   const result=await runSQLiteTask('inspection','inspectSQLite',args,mutableDirectories,token);
   report({phase:'source-task-mutation-result',case:config.sourceTask,revision:result.revision});
   assert.equal(result.revision,73,'worker must use the immutable approved task scope');
   assert.equal(spawns,before+1);const current=fs.statSync(snapshot);assert.equal(current.dev,snapshotIdentity.dev);assert.equal(current.ino,snapshotIdentity.ino);fs.unlinkSync(snapshot);
   SQLiteTaskScheduler.prototype.acquire=acquire;
  }else if(config.sourceTask==='foreign-inspection'||config.sourceTask==='foreign-backup'){
   // Actual ordinary native file, inside the already-mounted source parent.
   // The old opaque token could read/copy it through its general worker API.
   const foreign=join(config.app,'unapproved.sqlite'),db=new DatabaseSync(foreign);
   try{db.exec("CREATE TABLE clank_meta(_key TEXT PRIMARY KEY,_value INTEGER); INSERT INTO clank_meta VALUES('global_version',51)");}finally{db.close();}
   const invoke=async()=>{
    const result=config.sourceTask==='foreign-inspection'?await runSQLiteTask('inspection','inspectSQLite',[foreign],directories,token):await runSQLiteTask('migrations','stageSQLiteBackup',[foreign,snapshot,backup[2]],directories,token);
    report({phase:'unapproved-source-task',case:config.sourceTask,result:result??'completed',temporaryExists:fs.existsSync(backup[2])});return result;
   };
   await assert.rejects(invoke,/Private source/);
  }else{
   assert.equal(typeof request,'function');
   if(config.sourceTask==='projection'){
    for(const [module,operation,args,opcode,nonce] of [['migrations','stageSQLiteBackup',backup,'backup',temporaryId],['inspection','inspectSQLite',[snapshot],'inspect',null],['inspection','verifySQLite',[verified],'verify',null]]){
     const result=await request(token,module,operation,args,directories);
     assert.deepEqual(result,{protocol:'clank-source-sqlite-task/1',operation:opcode,backupId:id,temporaryId:nonce});assert.equal(Object.isFrozen(result),true);assert.ok(Buffer.byteLength(JSON.stringify(result))<256);assert.equal(JSON.stringify(result).includes(config.app),false);
    }
   }else if(config.sourceTask==='fake-token')await assert.rejects(request({},'inspection','inspectSQLite',[snapshot],directories),/genuine private/);
   else if(config.sourceTask==='operation')await assert.rejects(runSQLiteTask('jobs','mutatePlatformJob',[{databasePath:config.database}],directories,token),/fixed initialization operation/);
   else if(config.sourceTask==='accessor'){
    let getters=0;const args=[];Object.defineProperty(args,'0',{get(){getters++;throw Error('invoked accessor');}});
    await assert.rejects(request(token,'inspection','inspectSQLite',args,directories),/bounded own path/);assert.equal(getters,0);
   }else if(config.sourceTask==='directory-accessor'){
    let getters=0;const caps=[...directories];Object.defineProperty(caps,'2',{get(){getters++;throw Error('invoked directory accessor');}});
    await assert.rejects(request(token,'inspection','inspectSQLite',[snapshot],caps),/own capability data/);assert.equal(getters,0);
   }else if(config.sourceTask==='copied-directory')await assert.rejects(request(token,'inspection','inspectSQLite',[snapshot],directories.map(pin=>({...pin}))),/directory capability/);
   else if(config.sourceTask==='extra-directory')await assert.rejects(request(token,'inspection','inspectSQLite',[snapshot],[...directories,directories[0]]),/exact retained directories/);
   else if(config.sourceTask==='wrong-role')await assert.rejects(request(token,'inspection','verifySQLite',[snapshot],directories),/differs from its initialization operation/);
   else if(config.sourceTask==='temporary')await assert.rejects(request(token,'migrations','stageSQLiteBackup',[...backup.slice(0,2),snapshot+'.tmp-not-a-uuid'],directories),/backup paths cannot be rebound/);
   else if(config.sourceTask==='directory-replacement'){
    const retained=base+'.retained';fs.renameSync(base,retained);fs.mkdirSync(base,{mode:0o700});
    try{await assert.rejects(request(token,'inspection','inspectSQLite',[snapshot],directories),/retained directory identity changed/);}finally{fs.rmdirSync(base);fs.renameSync(retained,base);}
   }else throw Error('Unknown source task fixture');
  }
  assert.equal(spawns,before+(config.sourceTask.startsWith('queued-')?1:0),'refusal must precede worker admission; valid mutation test owns one inspection');
  report({phase:'source-task-checked',case:config.sourceTask,spawns,passed:true});return acquire.call(this,tenant);
 };
}
if(config.fault){
 const functions={readdir:'repository-read',appendFile:'encryption',writeFile:'manifest',rename:'rename'};
 for(const [name,label] of Object.entries(functions)){
  const original=fs.promises[name];fs.promises[name]=async(...args)=>{const value=await original(...args),file=String(args[0]).replace(/^\/proc\/self\/fd\/\d+/u,part=>fs.readlinkSync(part));
   if(config.fault===label&&file.includes('.clank-source-recovery-')&&(label==='repository-read'||label==='encryption'&&file.endsWith('database.enc')||label==='manifest'&&file.endsWith('manifest.json')||label==='rename'&&file.includes('.stage-bk_')))await gate(label);return value;};
 }
 const access=fs.promises.access;fs.promises.access=async(...args)=>{const value=await access(...args);if(config.fault==='worker-admission'&&args[0]==='/usr/bin/setpriv')await gate(config.fault);return value;};
 const open=fs.promises.open;fs.promises.open=async(...args)=>{const handle=await open(...args);if(config.fault==='file-sync'&&String(args[0]).endsWith('/database.enc')){const sync=handle.sync.bind(handle);handle.sync=async()=>{const value=await sync();await gate(config.fault);return value;};}return handle;};
 const spawn=childProcess.spawn;childProcess.spawn=(...args)=>{spawns++;const child=spawn(...args);if(config.fault==='worker-queue'&&spawns<=2){const end=child.stdin.end.bind(child.stdin);child.stdin.end=(...input)=>{queuedInputs.push(()=>end(...input));return child.stdin;};}if(config.fault==='worker-close'){const on=child.on;child.on=function(event,handler){return on.call(this,event,event==='close'?async(...values)=>{await gate(config.fault);handler(...values);}:handler);};}return child;};
 syncBuiltinESMExports();
}
if(config.fault==='worker-queue'){
 const acquire=SQLiteTaskScheduler.prototype.acquire;let acquisitions=0;SQLiteTaskScheduler.prototype.acquire=async function(...args){const pending=acquire.apply(this,args);acquisitions++;if(acquisitions===3){await gate('worker-queue');for(const send of queuedInputs)send();}return await pending;};
 for(let n=0;n<2;n++){const directory=join(config.app,'queued-'+n);fs.mkdirSync(directory,{mode:0o700});const path=join(directory,'data.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE record(value TEXT)');db.close();queueTasks.push(runSQLiteTask('inspection','inspectSQLite',[path]));}
 const deadline=Date.now()+5000;while(queuedInputs.length!==2){assert.ok(Date.now()<deadline,'two actual workers must own scheduler slots');await new Promise(resolve=>setTimeout(resolve,5));}
}
if(config.nativeFault){
 const prepare=DatabaseSync.prototype.prepare;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){
  if(!injected&&sql.startsWith(config.nativeFault.startsWith('bootstrap')?'INSERT INTO clank_pitr_state':'UPDATE clank_pitr_state SET base_id=')){
   injected=true;this.exec(config.nativeFault.endsWith('ignore')?
    (config.nativeFault.startsWith('bootstrap')?'CREATE TRIGGER ignore_state BEFORE INSERT ON clank_pitr_state BEGIN SELECT RAISE(IGNORE); END':'CREATE TRIGGER ignore_base BEFORE UPDATE OF base_id ON clank_pitr_state BEGIN SELECT RAISE(IGNORE); END'):
    "CREATE TRIGGER alter_base AFTER UPDATE OF base_id ON clank_pitr_state BEGIN UPDATE clank_pitr_state SET base_id='wrong' WHERE id=1; END");
  }
  return prepare.call(this,sql);
 };
}

let completionConnection,completionInjected=false;
if(config.completionFault||config.finalFault){
 const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO clank_pitr_state'))completionConnection=this;return prepare.call(this,sql);};
 if(config.completionFault==='before-base'){
  const rename=fs.promises.rename;fs.promises.rename=async(...args)=>{const value=await rename(...args);if(String(args[0]).includes('/.stage-bk_')){completionInjected=true;completionConnection.exec('UPDATE clank_pitr_state SET committed_at=committed_at+1');}return value;};
 }
 const link=fs.promises.link;
 fs.promises.link=async(...args)=>{const value=await link(...args);if(config.completionFault&&config.completionFault!=='before-base'&&String(args[1]).endsWith('/head.json')){
  assert.ok(completionConnection);completionInjected=true;
  if(config.completionFault==='foreign'){
   const foreign=new DatabaseSync(config.database);try{foreign.exec("UPDATE clank_pitr_state SET committed_at=committed_at+1");}finally{foreign.close();}
  }else completionConnection.exec(config.completionSQL);
 }return value;};syncBuiltinESMExports();
}

const cleanupErrors=[],cleanupAttempts=[];let runtimeCloseError;
if(config.cleanupFault){
 const close=fs.closeSync;
 fs.closeSync=function(fd){const path=fs.readlinkSync('/proc/self/fd/'+fd),value=close(fd),kind=path==='/run/clank-source/catalog.sqlite'?'reader':path===join(config.app,'.clank-source-recovery-'+config.bootstrap.binding.sourceIncarnation)?'root':undefined;
  if(kind&&(config.cleanupFault===kind||config.cleanupFault==='both'||config.cleanupFault==='reader-runtime-close'&&kind==='reader')){cleanupAttempts.push(kind);const error=new Error('injected '+kind+' close acknowledgment');cleanupErrors.push(error);throw error;}return value;
 };syncBuiltinESMExports();
}

let completionHandle,finalAwaitReached=false;
if(config.finalFault||config.mode==='completion'){
 const freeze=Object.freeze;
 Object.freeze=function(value){const result=freeze(value);if(value&&typeof value.close==='function'&&Object.keys(value).length===2&&('complete' in value||'result' in value)){
  Object.freeze=freeze;completionHandle=result;
  if(config.finalFault)queueMicrotask(()=>{
   finalAwaitReached=true;
   if(config.finalFault==='native')completionConnection.exec("UPDATE clank_pitr_state SET committed_at=committed_at+1");
   else if(config.finalFault==='close'){try{runtime.close();}catch(error){if(config.cleanupFault!=='reader-runtime-close')throw error;runtimeCloseError=error;}}
   else{
    report({phase:'final-held'});const command=join(config.app,'completion-command.json'),pause=new Int32Array(new SharedArrayBuffer(4)),deadline=Date.now()+10000;
    while(!fs.existsSync(command)){assert.ok(Date.now()<deadline,'parent must release final completion boundary');Atomics.wait(pause,0,0,5);}
    assert.deepEqual(JSON.parse(fs.readFileSync(command,'utf8')),{resume:true});
   }
  });
 }return result;};
}

try{
 if(['missing','oversized','nonconfigurable','writable','enumerable','nonstring'].includes(config.mode)){
  if(config.mode!=='missing')Object.defineProperty(globalThis,slot,{value:config.mode==='oversized'?'x'.repeat(16385):config.mode==='nonstring'?{}:JSON.stringify(config.bootstrap),writable:config.mode==='writable',enumerable:config.mode==='enumerable',configurable:config.mode!=='nonconfigurable'});
  assert.throws(()=>anchor.initializeSourceRuntime(runtime),/bootstrap/i);assert.equal(Object.hasOwn(globalThis,slot),config.mode==='nonconfigurable');assert.throws(()=>runtime.database.transaction(()=>{}),/unavailable/);assert.throws(()=>anchor.initializeSourceRuntime(runtime),/already been attempted/);report({ok:true,mode:config.mode});
 }else if(config.mode==='malformed'){
  let getters=0;Object.defineProperty(globalThis,slot,{configurable:true,get(){getters++;throw Error('invoked getter');}});
  assert.throws(()=>anchor.initializeSourceRuntime(runtime),/own data/);assert.equal(getters,0);assert.equal(Object.hasOwn(globalThis,slot),false);
  Object.defineProperty(globalThis,slot,{value:config.encoded??JSON.stringify(config.bootstrap),writable:false,enumerable:false,configurable:true});
  assert.throws(()=>anchor.initializeSourceRuntime(runtime),/already been attempted/);assert.throws(()=>runtime.database.transaction(()=>{}),/unavailable/);report({ok:true,mode:config.mode});
 }else{
  Object.defineProperty(globalThis,slot,{value:config.encoded??JSON.stringify(config.bootstrap),writable:false,enumerable:false,configurable:true});
  const pending=anchor.initializeSourceRuntime(runtime);assert.equal(Object.hasOwn(globalThis,slot),false);
  assert.throws(()=>runtime.database[SQLITE_INTERNAL].captureTransactions(()=>{}),/only be installed/);
  assert.throws(()=>runtime.database[SQLITE_INTERNAL].guardWrites(()=>undefined),/only be installed/);
  assert.throws(()=>runtime.database.transaction(()=>{}),/unavailable|not completed/);
  if(config.mode==='close'){runtime.close();await assert.rejects(pending);report({ok:true,mode:config.mode});}
  else if(config.mode==='refuse'||config.fault||config.nativeFault||config.completionFault||config.finalFault){let rejected;await assert.rejects(pending,error=>{rejected=error;return true;});if(config.completionFault)assert.equal(completionInjected,true);
   if(config.finalFault){
    assert.equal(finalAwaitReached,true);assert.ok(completionHandle);
    const closing=completionHandle.close();assert.equal(completionHandle.close(),closing);
    if(config.cleanupFault){
     assert.ok(cleanupErrors.length);if(config.cleanupFault==='reader-runtime-close')assert.equal(runtimeCloseError,cleanupErrors[0]);else assert.equal(rejected,cleanupErrors[0]);
     if(config.cleanupFault==='root'||config.cleanupFault==='both')await assert.rejects(closing,error=>error===cleanupErrors.at(-1));else await closing;
     runtime.close();assert.deepEqual(cleanupAttempts,config.cleanupFault==='both'?['reader','root']:[config.cleanupFault==='reader-runtime-close'?'reader':config.cleanupFault]);
    }else await closing;
    if(config.finalFault==='native')assert.throws(()=>completionHandle.complete(),/consumed/);
    else{assert.throws(()=>completionHandle.complete(),/closed|consumed/);assert.throws(()=>completionHandle.complete(),/consumed/);}
    const retained=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.includes('.clank-source-recovery-')||config.cleanupFault&&(path===config.app||path.startsWith(config.app+'/')||path==='/run/clank-source')?[path]:[];}catch{return [];}});assert.deepEqual(retained,[],'owned repository pins must settle before rejection');
   }assert.throws(()=>runtime.database.transaction(()=>{}));if(config.fault)assert.equal(held,true);if(config.fault==='worker-queue'){await Promise.all(queueTasks);assert.equal(spawns,2);const again=await runSQLiteTask('inspection','inspectSQLite',[config.database]);assert.ok(again);}report({ok:true,mode:config.mode,spawns});}
  else {
   const completion=await pending;
   if(config.mode==='completion'){
    assert.ok(completion&&typeof completion==='object','successful initialization must return completion data');
    assert.deepEqual(Object.keys(completion),['captureEpoch','keyId','schemaHash','baseBackupId','observedCursor']);
    assert.deepEqual(Object.keys(completion.observedCursor),['epoch','sequence','digest']);
    assert.equal(Object.isFrozen(completion),true);assert.equal(Object.isFrozen(completion.observedCursor),true);
    assert.ok(Buffer.byteLength(JSON.stringify(completion))<=1024);assert.throws(()=>completionHandle.complete(),/consumed/);
    assert.throws(()=>{completion.keyId='changed';},TypeError);assert.throws(()=>{completion.observedCursor.sequence=1;},TypeError);
    assert.throws(()=>anchor.assertSourceRuntime(completion),/genuine/);assert.throws(()=>anchor.sourceContext(completion),/genuine/);
    assert.throws(()=>anchor.initializeSourceRuntime(runtime),/already been attempted/);
    await assert.rejects(exportPointInTimeRecovery(completion),/native.*capture/);await assert.rejects(exportPointInTimeTransfer(completion,{}),/native.*capture/);
    assert.throws(()=>openPointInTimeTransferSource(completion,{}),/native.*capture/);
    assert.throws(()=>runtime.database[SQLITE_INTERNAL].exec("INSERT INTO clank_meta(_key,_value) VALUES('raw_escape',1)"),/bootstrap|write|permission/);
    report({phase:'initialized',completion});
   }else report({phase:'initialized'});
   const command=JSON.parse((await lines.next()).value);
   if(command.revoke)assert.throws(()=>runtime.database.transaction(db=>db.table('records').insert({value:'revoked'})),/grant|catalog|bootstrap/);
   else {assert.throws(()=>runtime.database.transaction(db=>db.table('records').insert({value:'must-not-commit'})),/bootstrap|write|permission/);assert.throws(()=>cached.run(),/bootstrap|write|permission/);}
   report({ok:true,records:runtime.database.read(db=>db.table('records').collect()).length});
  }
 }
}finally{runtime.close();}

}

}
