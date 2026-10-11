import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {openBackend,defineBackend,defineDatabase,defineTable} from '../../dist/backend.js';
import {s} from '../../dist/ai.js';
import {SQLITE_INTERNAL} from '../../dist/sqlite-internal.js';
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
if(config.mode==='restart-refuse'){const runtime=await runtimePending;try{Object.defineProperty(globalThis,Symbol.for('clank.provider.source.bootstrap.v1'),{value:JSON.stringify(config.bootstrap),writable:false,enumerable:false,configurable:true});assert.throws(()=>openBackend[SQLITE_INTERNAL].initializeSourceRuntime(runtime),/pristine/);assert.throws(()=>runtime.database.transaction(()=>{}),/capture|recovery/i);report({ok:true,mode:config.mode});}finally{runtime.close();}}else{
const runtime=await runtimePending;
const anchor=openBackend[SQLITE_INTERNAL],slot=Symbol.for('clank.provider.source.bootstrap.v1');
const cached=runtime.database[SQLITE_INTERNAL].prepare("INSERT INTO clank_meta(_key,_value) VALUES('bootstrap_escape',1)");

let held=false,spawns=0;const queuedInputs=[],queueTasks=[];
const gate=async label=>{if(held)return;held=true;report({phase:'held',label,spawns});const command=JSON.parse((await lines.next()).value);if(command.close)runtime.close();};
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
  else if(config.mode==='refuse'||config.fault||config.nativeFault){await assert.rejects(pending);assert.throws(()=>runtime.database.transaction(()=>{}));if(config.fault)assert.equal(held,true);if(config.fault==='worker-queue'){await Promise.all(queueTasks);assert.equal(spawns,2);const again=await runSQLiteTask('inspection','inspectSQLite',[config.database]);assert.ok(again);}report({ok:true,mode:config.mode,spawns});}
  else {
   await pending;report({phase:'initialized'});
   const command=JSON.parse((await lines.next()).value);
   if(command.revoke)assert.throws(()=>runtime.database.transaction(db=>db.table('records').insert({value:'revoked'})),/grant|catalog|bootstrap/);
   else {assert.throws(()=>runtime.database.transaction(db=>db.table('records').insert({value:'must-not-commit'})),/bootstrap|write|permission/);assert.throws(()=>cached.run(),/bootstrap|write|permission/);}
   report({ok:true,records:runtime.database.read(db=>db.table('records').collect()).length});
  }
 }
}finally{runtime.close();}

}

}
