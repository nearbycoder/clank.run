import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSQLiteTask } from '../dist/sqlite-task.js';
import { pinSQLiteDirectory } from '../dist/sqlite-sandbox.js';
import { createSourceWorkerClientProtocol as clientProtocol, createSourceWorkerServerProtocol as serverProtocol,
  SOURCE_WORKER_REQUEST_MAX_BYTES, SOURCE_WORKER_RESPONSE_MAX_BYTES } from '../dist/provider-source-worker-wire.js';

const identity={bindingSha256:'a'.repeat(64),containerId:'b'.repeat(64),sourceIncarnation:randomUUID()};
const secret=new Uint8Array(32).fill(41),backupId='bk_1791750000000_'+Buffer.alloc(18,7).toString('base64url');
const task=operation=>({protocol:'clank-source-sqlite-task/1',operation,backupId,temporaryId:operation==='backup'?randomUUID():null});
const inspected={revision:17,migrationCount:1,latestMigration:'0001_bootstrap'};
const hash=text=>createHash('sha256').update(text).digest('hex');
const key=(scope,direction,control=secret)=>createHmac('sha256',control).update(JSON.stringify({protocol:'clank-provider-source-worker-key/1',direction,binding:scope})).digest();
const signed=(body,scope,direction)=>JSON.stringify({...body,mac:createHmac('sha256',key(scope,direction)).update(JSON.stringify(body)).digest('hex')});
const unsigned=text=>{const {mac,...body}=JSON.parse(text);return body;};
const pair=()=>{const server=serverProtocol(secret,identity);return {server,client:clientProtocol(secret,server.binding)};};
const backupAccepted=({client,server})=>{const encoded=client.begin(task('backup'));return {encoded,accepted:server.accept(encoded)};};
const finishBackup=p=>{const {encoded,accepted}=backupAccepted(p);const response=p.server.reply(accepted);assert.equal(p.client.finish(response),undefined);return {encoded,accepted,response};};

test('first-base frames independently authenticate all three native worker result shapes',()=>{
 const p=pair();let first;
 for(const operation of ['backup','inspect','verify']){
  const encoded=p.client.begin(task(operation)),body=unsigned(encoded),mac=JSON.parse(encoded).mac;
  assert.equal(mac,createHmac('sha256',key(p.server.binding,'request')).update(JSON.stringify(body)).digest('hex'));
  assert.ok(Buffer.byteLength(encoded)<=SOURCE_WORKER_REQUEST_MAX_BYTES);
  const accepted=p.server.accept(encoded);assert.equal(Object.isFrozen(accepted),true);assert.equal(Object.isFrozen(accepted.task),true);
  const response=p.server.reply(accepted,operation==='inspect'?inspected:undefined),result=unsigned(response);
  assert.equal(result.requestSha256,hash(encoded));assert.equal(result.nonce,body.nonce);assert.equal(result.sequence,body.sequence);
  assert.equal(JSON.parse(response).mac,createHmac('sha256',key(p.server.binding,'response')).update(JSON.stringify(result)).digest('hex'));
  assert.notEqual(JSON.parse(response).mac,createHmac('sha256',key(p.server.binding,'request')).update(JSON.stringify(result)).digest('hex'));
  assert.ok(Buffer.byteLength(response)<=SOURCE_WORKER_RESPONSE_MAX_BYTES);
  assert.deepEqual(p.client.finish(response),operation==='inspect'?inspected:undefined);first??=encoded;
 }
 assert.throws(()=>p.client.begin(task('backup')),/protocol/);assert.throws(()=>p.server.accept(first),/protocol/);
});

for(const change of ['mac','binding','sequence','operation','extra-root','extra-task','temporary','backup-id','canonical','duplicate-field','nonce'])test('request refuses '+change+' without consuming a valid sequence',()=>{
 const p=pair(),original=p.client.begin(task('backup')),body=unsigned(original);let altered;
 if(change==='mac')altered=JSON.stringify({...body,mac:'0'.repeat(64)});
 else if(change==='canonical')altered=original+' ';
 else if(change==='duplicate-field')altered=original.replace('"sequence":1','"sequence":1,"sequence":1');
 else{
  if(change==='binding')body.binding.containerId='c'.repeat(64);
  if(change==='sequence')body.sequence=2;
  if(change==='operation')body.task.operation='executeSql';
  if(change==='extra-root')body.sql='SELECT 1';
  if(change==='extra-task')body.task.path='/data/other.sqlite';
  if(change==='temporary')body.task.temporaryId='../outside';
  if(change==='backup-id')body.task.backupId='bk_0_'+'a'.repeat(24);
  if(change==='nonce')body.nonce='short';
  altered=signed(body,p.server.binding,'request');
 }
 assert.throws(()=>p.server.accept(altered),/protocol/);
 const accepted=p.server.accept(original);assert.equal(p.client.finish(p.server.reply(accepted)),undefined);
});

test('copied or foreign receipts cannot acknowledge work; exact receipt settles once',()=>{
 const p=pair(),q=pair(),{encoded,accepted}=backupAccepted(p);
 assert.throws(()=>p.server.reply({...accepted}),/protocol/);assert.throws(()=>q.server.reply(accepted),/protocol/);
 assert.throws(()=>p.server.accept(encoded),/protocol/);
 const response=p.server.reply(accepted);assert.throws(()=>p.server.reply(accepted),/protocol/);p.client.finish(response);
 assert.throws(()=>p.server.accept(encoded),/protocol/);
 const next=p.client.begin(task('inspect'));assert.equal(p.server.accept(next).task.operation,'inspect');p.client.close();p.server.close();q.client.close();q.server.close();
});
test('fresh server epoch refuses an earlier authenticated request with the same original control key',()=>{
 const p=pair(),encoded=p.client.begin(task('backup')),fresh=serverProtocol(secret,identity);
 assert.notEqual(fresh.binding.channelId,p.server.binding.channelId);
 assert.throws(()=>fresh.accept(encoded),/protocol/);assert.equal(fresh.accept(clientProtocol(secret,fresh.binding).begin(task('backup'))).task.operation,'backup');
 assert.throws(()=>serverProtocol(secret,{...identity,channelId:p.server.binding.channelId}),/protocol/);
 p.client.close();p.server.close();fresh.close();
});
test('authenticated repeated nonce and changed backup identity refuse later stages',()=>{
 const p=pair(),first=finishBackup(p),original=p.client.begin(task('inspect')),body=unsigned(original);
 body.nonce=JSON.parse(first.encoded).nonce;assert.throws(()=>p.server.accept(signed(body,p.server.binding,'request')),/protocol/);
 body.nonce=JSON.parse(original).nonce;body.task.backupId='bk_1791750000000_'+'x'.repeat(24);
 assert.throws(()=>p.server.accept(signed(body,p.server.binding,'request')),/protocol/);
 const accepted=p.server.accept(original);assert.deepEqual(p.client.finish(p.server.reply(accepted,inspected)),inspected);
 p.client.close();p.server.close();
});
for(const change of ['mac','direction','binding','sequence','nonce','request-digest','status','result','extra','canonical'])test('response refuses '+change+' and closes uncertain initialization',()=>{
 const p=pair(),{accepted}=backupAccepted(p),original=p.server.reply(accepted),body=unsigned(original);let altered;
 if(change==='mac')altered=JSON.stringify({...body,mac:'0'.repeat(64)});
 else if(change==='canonical')altered=original+'\n';
 else{
  if(change==='binding')body.binding.bindingSha256='c'.repeat(64);
  if(change==='sequence')body.sequence=2;
  if(change==='nonce')body.nonce='a'.repeat(24);
  if(change==='request-digest')body.requestSha256='d'.repeat(64);
  if(change==='status')body.status='ready';
  if(change==='result')body.result={revision:17};
  if(change==='extra')body.path='/host/data.sqlite';
  altered=signed(body,p.server.binding,change==='direction'?'request':'response');
 }
 assert.throws(()=>p.client.finish(altered),/protocol/);assert.throws(()=>p.client.finish(original),/protocol/);assert.throws(()=>p.client.begin(task('backup')),/protocol/);p.server.close();
});
test('an authenticated refusal closes both roles and admits no further operation',()=>{
 const p=pair(),{accepted}=backupAccepted(p),response=p.server.refuse(accepted);
 assert.equal(JSON.parse(response).status,'refused');assert.equal(JSON.parse(response).result,null);
 assert.throws(()=>p.client.finish(response),/refused initialization/);
 assert.throws(()=>p.client.begin(task('backup')),/protocol/);assert.throws(()=>p.server.reply(accepted),/protocol/);
});
test('own-data copies preserve producer tasks, channel identity and result fields without calling accessors',()=>{
 const descriptor={...identity},server=serverProtocol(secret,descriptor),client=clientProtocol(secret,server.binding);descriptor.containerId='c'.repeat(64);
 const original=task('backup'),encoded=client.begin(original);original.backupId='modified';assert.equal(server.accept(encoded).task.backupId,backupId);client.close();server.close();
 for(const target of ['identity','task','result']){
  const p=pair();let invoked=0;
  const getter={get(){invoked++;throw Error('must not invoke');},enumerable:true};
  if(target==='identity'){const value={...identity};Object.defineProperty(value,'containerId',getter);assert.throws(()=>serverProtocol(secret,value),/protocol/);}
  if(target==='task'){const value=task('backup');Object.defineProperty(value,'backupId',getter);assert.throws(()=>p.client.begin(value),/protocol/);finishBackup(p);}
  if(target==='result'){finishBackup(p);const accepted=p.server.accept(p.client.begin(task('inspect'))),value={...inspected};Object.defineProperty(value,'revision',getter);assert.throws(()=>p.server.reply(accepted,value),/protocol/);assert.deepEqual(p.client.finish(p.server.reply(accepted,inspected)),inspected);}
  assert.equal(invoked,0);p.client.close();p.server.close();
 }
});
test('key inputs use native bounded slots, reject shared memory and preserve caller bytes',()=>{
 const original=new Uint8Array(secret),server=serverProtocol(original,identity),client=clientProtocol(secret,server.binding);original.fill(0);const accepted=server.accept(client.begin(task('backup')));client.finish(server.reply(accepted));server.close();client.close();assert.deepEqual(secret,new Uint8Array(32).fill(41));
 for(const value of [[],new Uint8Array(31),new Uint8Array(33),new Uint8Array(new SharedArrayBuffer(32)),new Proxy(new Uint8Array(32),{})])assert.throws(()=>serverProtocol(value,identity),/protocol/);
 let invoked=0;const value=new Uint8Array(secret);Object.defineProperty(value,'byteLength',{get(){invoked++;throw Error('getter');}});Object.defineProperty(value,'buffer',{get(){invoked++;throw Error('getter');}});
 serverProtocol(value,identity).close();assert.equal(invoked,0);
});
test('wire bounds, malformed JSON and unsafe numbers refuse before allocating pending receipts',()=>{
 const p=pair(),encoded=p.client.begin(task('backup'));
 for(const value of ['{"secret":"not-for-errors",',encoded+' '.repeat(SOURCE_WORKER_REQUEST_MAX_BYTES),null]){
  assert.throws(()=>p.server.accept(value),error=>error.message==='Invalid private source worker protocol.');
 }
 const accepted=p.server.accept(encoded);p.client.finish(p.server.reply(accepted));
 const inspecting=p.server.accept(p.client.begin(task('inspect')));
 for(const value of [{...inspected,revision:NaN},{...inspected,revision:-0},{...inspected,migrationCount:2**53},{...inspected,latestMigration:'x'.repeat(1025)},{...inspected,latestMigration:'line\nbreak'}])assert.throws(()=>p.server.reply(inspecting,value),/protocol/);
 assert.deepEqual(p.client.finish(p.server.reply(inspecting,inspected)),inspected);p.client.close();p.server.close();
});
test('explicit close invalidates pending work and sequence/order mistakes cannot silently retry',()=>{
 const p=pair();assert.throws(()=>p.client.begin(task('inspect')),/protocol/);const encoded=p.client.begin(task('backup'));assert.throws(()=>p.client.begin(task('backup')),/protocol/);
 const accepted=p.server.accept(encoded);p.server.close();p.server.close();assert.throws(()=>p.server.reply(accepted),/protocol/);p.client.close();p.client.close();assert.throws(()=>p.client.finish('{}'),/protocol/);
});

test('actual default Linux SQLite workers carry a first base through independently checked wire results',async t=>{
 if(process.platform!=='linux')return t.skip('Default namespace integration requires Linux.');
 const root=await mkdtemp(join(tmpdir(),'clank-source-wire-')),source=join(root,'data.sqlite'),snapshot=join(root,'snapshot.sqlite'),temporary=join(root,'snapshot.tmp');
 const database=new DatabaseSync(source);try{database.exec("CREATE TABLE clank_meta(_key TEXT PRIMARY KEY,_value INTEGER); INSERT INTO clank_meta VALUES('global_version',17); CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'first'),(2,'second')");}finally{database.close();}
 const original=hash(await readFile(source)),directory=await pinSQLiteDirectory(root),p=pair();
 t.after(async()=>{p.client.close();p.server.close();await directory.close();await rm(root,{recursive:true,force:true});});
 // Component broker: fixed local paths and native default workers. This fixture
 // does not mint provider authority or prove coupled Docker source bootstrap.
 for(const operation of ['backup','inspect','verify']){
  const encoded=p.client.begin(task(operation)),accepted=p.server.accept(encoded);let result;
  if(accepted.task.operation==='backup'){
   await runSQLiteTask('migrations','stageSQLiteBackup',[source,snapshot,temporary],[directory]);await rename(temporary,snapshot);
  }else if(accepted.task.operation==='inspect')result=await runSQLiteTask('inspection','inspectSQLite',[snapshot],[directory]);
  else await runSQLiteTask('inspection','verifySQLite',[snapshot],[directory]);
  const response=p.server.reply(accepted,result),decoded=p.client.finish(response);
  if(operation==='inspect')assert.deepEqual(decoded,{revision:17,migrationCount:0,latestMigration:null});else assert.equal(decoded,undefined);
 }
 const independent=new DatabaseSync(snapshot,{readOnly:true});try{
  assert.equal(Object.values(independent.prepare('PRAGMA integrity_check').get())[0],'ok');
  assert.deepEqual(independent.prepare('SELECT * FROM records ORDER BY id').all().map(row=>({...row})),[{id:1,value:'first'},{id:2,value:'second'}]);
 }finally{independent.close();}
 assert.equal(hash(await readFile(source)),original);
});
