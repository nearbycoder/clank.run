import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openSupervisorLease} from '../dist/platform-supervisor.js';
import {prepareShadowSchema} from './fixtures/shadow-schema.mjs';

const options={configurationId:'upload-capability',configurationRevision:1,leaseMs:30000,pollIntervalMs:50};
const upgrade=sql=>sql.exec("ALTER TABLE clank_platform_releases ADD COLUMN upload_publication_receipt TEXT;UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2'");
const downgrade=sql=>sql.exec("UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/1';ALTER TABLE clank_platform_releases DROP COLUMN upload_publication_receipt");
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-upload-protocol-')),path=join(root,'catalog.sqlite'),leases=[],children=[];
  const open=async()=>{const lease=await openSupervisorLease(path,options);leases.push(lease);return lease};
  const first=await open(),sql=new DatabaseSync(path);sql.exec('PRAGMA busy_timeout=5000;CREATE TABLE baseline_writer_effects(pid INTEGER NOT NULL) STRICT');
  t.after(async()=>{for(const child of children){if(child.process.exitCode===null&&child.process.signalCode===null)child.process.kill('SIGKILL');await child.exited}for(const lease of leases)lease.close();sql.close();await rm(root,{recursive:true,force:true})});
  const start=async mode=>{
    const process=fork(new URL('./fixtures/supervisor-upload-worker.mjs',import.meta.url),[],{env:{...globalThis.process.env,CLANK_UPLOAD_SUPERVISOR_ROOT:root,CLANK_UPLOAD_SUPERVISOR_MODE:mode},stdio:['ignore','pipe','pipe','ipc']});
    let output='';for(const stream of [process.stdout,process.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));
    const exited=new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal}))),messages=[],waiters=[];
    process.on('message',value=>{const waiter=waiters.shift();if(waiter)waiter(value);else messages.push(value)});
    const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned child reply timeout: '+output)),10000);const accept=value=>{clearTimeout(timer);resolve(value)};waiters.push(accept);void exited.then(()=>{if(waiters.includes(accept)){clearTimeout(timer);waiters.splice(waiters.indexOf(accept),1);reject(new Error('Owned child exited: '+output))}})});
    const child={process,exited,next};children.push(child);return{...child,initial:await next()};
  };
  return{root,path,first,sql,open,start};
}

test('provisional version-two reads cannot poison the live schema floor after native rollback',async t=>{
  const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.enrollProviderShadow();
  f.sql.exec('BEGIN IMMEDIATE');try{upgrade(f.sql);f.first.assertCurrent(f.sql)}finally{f.sql.exec('ROLLBACK')}
  f.first.assertCurrent();f.first.renew();assert.equal(f.sql.prepare('SELECT schema_id FROM clank_platform_shadow_state').get().schema_id,'clank-platform-shadow/1');
  f.sql.exec('BEGIN IMMEDIATE');upgrade(f.sql);f.sql.exec('COMMIT');f.first.assertCurrent();f.first.enrollProviderCanaries();
  assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,3);
  f.sql.exec('BEGIN IMMEDIATE');downgrade(f.sql);f.sql.exec('COMMIT');assert.throws(()=>f.first.assertCurrent(),{code:'SUPERVISOR_SHADOW_SCHEMA'});
});

test('legacy schema cannot adopt a publication column without its reviewed version transition',async t=>{
  const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.enrollProviderShadow();f.sql.exec('ALTER TABLE clank_platform_releases ADD COLUMN upload_publication_receipt TEXT');
  assert.throws(()=>f.first.assertCurrent(),{code:'SUPERVISOR_SHADOW_SCHEMA'});
  await assert.rejects(f.open(),{code:'SUPERVISOR_SHADOW_SCHEMA'});
});

test('version-two missing receipt column refuses startup without native repair',async t=>{
  const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.enrollProviderShadow();f.sql.exec('BEGIN IMMEDIATE');upgrade(f.sql);f.sql.exec('COMMIT');f.first.assertCurrent();f.first.release();f.first.close();f.sql.exec('ALTER TABLE clank_platform_releases DROP COLUMN upload_publication_receipt');
  const before=f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();await assert.rejects(f.open(),{code:'SUPERVISOR_SHADOW_SCHEMA'});assert.deepEqual(f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),before);
});

test('actual schema-one baseline refuses both startup and held writer continuation after upgrade',async t=>{
  const f=await fixture(t),old=await f.start('old-owner');assert.equal(old.initial.kind,'ready');f.sql.exec('BEGIN IMMEDIATE');upgrade(f.sql);f.sql.exec('COMMIT');old.process.send({kind:'write'});assert.equal((await old.next()).code,'SUPERVISOR_SHADOW_SCHEMA');assert.deepEqual(await old.exited,{code:0,signal:null});
  const fresh=await f.start('old-owner');assert.equal(fresh.initial.code,'SUPERVISOR_SHADOW_SCHEMA');assert.deepEqual(await fresh.exited,{code:0,signal:null});assert.equal(f.sql.prepare('SELECT count(*) n FROM baseline_writer_effects').get().n,0);
});

test('an already armed current guardian reads a schema upgrade and stops gracefully under the same identity',async t=>{
  const f=await fixture(t),child=await f.start('new-guardian');assert.equal(child.initial.kind,'ready');const before=f.sql.prepare('SELECT enrollment_id FROM clank_platform_shadow_state').get();
  child.process.send({kind:'upgrade'});assert.equal((await child.next()).kind,'upgraded');child.process.send({kind:'stop'});assert.equal((await child.next()).kind,'stopped');assert.deepEqual(await child.exited,{code:0,signal:null});
  assert.deepEqual(f.sql.prepare('SELECT enrollment_id FROM clank_platform_shadow_state').get(),before);assert.deepEqual(await readdir(join(f.root,'supervisor-guardians')),[]);
});

for(const kind of ['old-refusal','current-downgrade'])test(`actual guardian ${kind} kills the stopped owner before its real lease expires`,async t=>{
  const f=await fixture(t),child=await f.start(kind==='old-refusal'?'old-guardian':'new-enrolled-guardian');assert.equal(child.initial.kind,'ready');
  // Guardian arm returns only after its genuine initial committed schema read.
  child.process.kill('SIGSTOP');const lease=f.sql.prepare('SELECT * FROM clank_platform_supervisor_lease').get();assert.ok(lease.expires_at-Date.now()>25000);
  f.sql.exec('BEGIN IMMEDIATE');if(kind==='old-refusal')upgrade(f.sql);else downgrade(f.sql);f.sql.exec('COMMIT');
  let timer;const result=await Promise.race([child.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Guardian did not fence schema incompatibility')),2000)})]).finally(()=>clearTimeout(timer));
  assert.deepEqual(result,{code:null,signal:'SIGKILL'});assert.ok(f.sql.prepare('SELECT expires_at FROM clank_platform_supervisor_lease').get().expires_at>Date.now());
});
