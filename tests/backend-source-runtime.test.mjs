import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openBackend,createSQLiteDatabase,defineBackend,defineDatabase,defineTable} from '../dist/backend.js';
import {defineAuth} from '../dist/auth.js';
import {defineJobs} from '../dist/jobs.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';

const schema=defineDatabase({records:defineTable({value:s.string()})});
const definition=()=>defineBackend({schema}).functions(()=>({}));
const check=runtime=>openBackend[SQLITE_INTERNAL].assertSourceRuntime(runtime);
async function fixture(t,backend=definition(),options={}){
  const root=await mkdtemp(join(tmpdir(),'clank-runtime-brand-'));
  const runtime=await openBackend(backend,{path:join(root,'data.sqlite'),changePollIntervalMs:0,agent:false,...options});
  t.after(async()=>{runtime.close();await rm(root,{recursive:true,force:true});});
  return runtime;
}

test('genuine file-backed runtime stays eligible across actual managed commits and idle reads',async t=>{
  const runtime=await fixture(t);check(runtime);
  for(let i=0;i<3;i++)runtime.database.transaction(db=>db.table('records').insert({value:String(i)}));
  assert.equal(runtime.database.read(db=>db.table('records').collect()).length,3);check(runtime);
});
test('private constructor lookup cannot be replaced and copied or proxied handles cannot enroll',async t=>{
  const runtime=await fixture(t),anchor=openBackend[SQLITE_INTERNAL];
  assert.throws(()=>{openBackend[SQLITE_INTERNAL]={assertSourceRuntime(){}};},TypeError);
  assert.throws(()=>{anchor.assertSourceRuntime=()=>{};},TypeError);
  for(const value of [{...runtime},new Proxy(runtime,{}),{},null])assert.throws(()=>check(value),/genuine live backend/);
  check(runtime);
});
test('uninitialized and copied completion claims refuse before getters without reserving ordinary runtime writes',async t=>{
  const runtime=await fixture(t),anchor=openBackend[SQLITE_INTERNAL];let reads=0;
  const claimed=Object.freeze({get captureEpoch(){reads++;throw Error('never read a claimed completion');}});
  for(const handle of [runtime,{...runtime},new Proxy(runtime,{}),{},null]){
    assert.throws(()=>anchor.assertSourceRuntimeCompletion(handle,claimed),/genuine current source runtime completion/);
  }
  assert.equal(reads,0);check(runtime);
  runtime.database.transaction(db=>db.table('records').insert({value:'ordinary support remains'}));
  assert.equal(runtime.database.read(db=>db.table('records').collect()).length,1);
});
test('runtime database and definition replacements refuse even when structurally identical',async t=>{
  const runtime=await fixture(t),database=runtime.database,backend=runtime.definition;
  runtime.database={...database};assert.throws(()=>check(runtime),/original backend|identity changed/);runtime.database=database;
  runtime.definition={...backend};assert.throws(()=>check(runtime),/original backend|identity changed/);runtime.definition=backend;check(runtime);
});
test('caller replacement of internal hooks never establishes authority',async t=>{
  const runtime=await fixture(t),database=runtime.database,internal=database[SQLITE_INTERNAL],original=internal.captureTransactions;
  internal.captureTransactions=()=>{};assert.throws(()=>check(runtime),/identity changed/);internal.captureTransactions=original;check(runtime);
  const replacement={...runtime.database,[SQLITE_INTERNAL]:{assertNativeIdle(){},captureTransactions(){}}};
  runtime.database=replacement;assert.throws(()=>check(runtime),/original backend|identity changed/);
  const other=await fixture(t);runtime.database=other.database;
  // A second genuine native database also cannot replace the captured one.
  assert.throws(()=>check(runtime),/original backend|identity changed/);runtime.database=database;check(runtime);
});
test('runtime accessors refuse before invoking even an alternating or throwing getter',async t=>{
  const runtime=await fixture(t);
  for(const key of ['database','definition','jobs']){
    const descriptor=Object.getOwnPropertyDescriptor(runtime,key);let reads=0;
    Object.defineProperty(runtime,key,{...descriptor,value:undefined});
    Object.defineProperty(runtime,key,{configurable:true,enumerable:true,get(){reads++;return reads%2?descriptor.value:{};}});
    assert.throws(()=>check(runtime),/identity changed/);assert.equal(reads,0);
    Object.defineProperty(runtime,key,{configurable:true,enumerable:true,get(){throw Error('must never invoke replacement getter');}});
    assert.throws(()=>check(runtime),/identity changed/);
    Object.defineProperty(runtime,key,descriptor);check(runtime);
  }
});
test('ordinary authentication adapters stay opaque during startup and source identity checking',async t=>{
  let inspected=0;
  const store=new Proxy({async consume(){return undefined;}},{ownKeys(){inspected++;throw Error('opaque adapter');}});
  const auth=defineAuth({profile:{name:s.string()},rateLimit:{store}});
  const backend=defineBackend({schema,auth}).functions(()=>({})),runtime=await fixture(t,backend);
  assert.equal(inspected,0);check(runtime);assert.equal(inspected,0);
});
test('unsupported reflective source metadata refuses only source eligibility, preserving ordinary startup',async t=>{
  const metadata=new Proxy({},{ownKeys(){throw Error('opaque metadata');}});
  const backend={...definition(),schema:{...schema,metadata}},runtime=await fixture(t,backend);
  runtime.database.transaction(db=>db.table('records').insert({value:'ordinary'}));
  assert.throws(()=>check(runtime),/cannot be safely verified/);
  assert.equal(runtime.database.read(db=>db.table('records').collect()).length,1);
});
test('changed nested definition data refuses and restoring exact identity allows recheck',async t=>{
  const backend={...definition(),functions:{},schema:{tables:{...schema.tables}}},runtime=await fixture(t,backend);
  const original=backend.schema.tables.records;backend.schema.tables.records={...original};
  assert.throws(()=>check(runtime),/identity changed/);backend.schema.tables.records=original;check(runtime);
  backend.functions.extra={};assert.throws(()=>check(runtime),/identity changed/);delete backend.functions.extra;check(runtime);
});
test('native active reads and writes refuse enrollment and regain eligibility only after actual idleness',async t=>{
  const runtime=await fixture(t);
  runtime.database.read(()=>assert.throws(()=>check(runtime),/idle/));
  runtime.database.transaction(()=>assert.throws(()=>check(runtime),/idle/));check(runtime);
});
test('closing either the backend or its original native database invalidates the retained runtime',async t=>{
  const runtime=await fixture(t);runtime.close();assert.throws(()=>check(runtime),/genuine live backend/);
  const second=await fixture(t);second.database.close();assert.throws(()=>check(second),/genuine openSQLite/);
});
test('declared jobs captured before the first await cannot be removed to gain source eligibility',async t=>{
  const jobs=defineJobs({schema}).jobs(()=>({})),backend={...definition(),jobs};
  const root=await mkdtemp(join(tmpdir(),'clank-brand-jobs-'));
  const pending=openBackend(backend,{path:join(root,'data.sqlite'),changePollIntervalMs:0,agent:false});
  backend.jobs=undefined;
  const runtime=await pending;t.after(async()=>{runtime.close();await rm(root,{recursive:true,force:true});});
  assert.equal(runtime.jobs,undefined);assert.throws(()=>check(runtime),/identity changed|without jobs/);
});
test('memory and compatible caller-created SQLite backends retain ordinary support without source identity',async t=>{
  const memory=await fixture(t,definition(),{path:':memory:'});assert.throws(()=>check(memory),/file-backed/);
  const native=new DatabaseSync(':memory:'),database=createSQLiteDatabase(schema,native,{changePollIntervalMs:0});
  const runtime=await fixture(t,definition(),{database});assert.throws(()=>check(runtime),/genuine openSQLite/);
  database.transaction(db=>db.table('records').insert({value:'ordinary'}));assert.equal(database.read(db=>db.table('records').collect()).length,1);
});
