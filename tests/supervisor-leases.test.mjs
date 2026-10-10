import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openSupervisorLease,normalizeSupervisorOptions} from '../dist/platform-supervisor.js';
const options={configurationId:'native-cluster',configurationRevision:1,leaseMs:5000,pollIntervalMs:50};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-lease-')),path=join(root,'catalog.sqlite'),leases=[];
  const open=async(config=options)=>{const lease=await openSupervisorLease(path,config);leases.push(lease);return lease;};
  const first=await open(),observer=new DatabaseSync(path);observer.exec('PRAGMA busy_timeout=5000');
  t.after(async()=>{for(const lease of leases)lease.close();observer.close();await rm(root,{recursive:true,force:true});});
  return {root,path,first,observer,open};
}

test('two independent native connections admit one ownership epoch and retained release never resets its fence',async t=>{
  const f=await fixture(t),second=await f.open();assert.equal(f.first.acquire(),true);assert.equal(second.acquire(),false);
  assert.equal(f.first.acquire(),true);assert.equal(f.first.status('leader').epoch,1);f.first.renew();assert.equal(f.first.assertCurrent(),undefined);
  assert.equal(f.first.release(),true);assert.equal(f.observer.prepare('SELECT epoch FROM clank_platform_supervisor_lease').get().epoch,1);
  assert.equal(second.acquire(),true);assert.equal(second.status('leader').epoch,2);assert.equal(f.first.release(),false);
  assert.throws(()=>f.first.assertCurrent(),error=>error.code==='SUPERVISOR_LEASE_LOST');
  assert.equal(f.observer.prepare('SELECT count(*) AS count FROM clank_platform_supervisor_lease').get().count,1);
});

test('expired ownership cannot be renewed or reacquired by a controller retaining its old capability',async t=>{
  const f=await fixture(t),second=await f.open();f.first.acquire();
  f.observer.exec('UPDATE clank_platform_supervisor_lease SET expires_at=0');
  assert.throws(()=>f.first.renew(),error=>error.code==='SUPERVISOR_LEASE_LOST');
  assert.throws(()=>f.first.acquire(),error=>error.code==='SUPERVISOR_LEASE_LOST');
  assert.equal(second.acquire(),true);assert.equal(second.status('leader').epoch,2);
  assert.throws(()=>f.first.assertCurrent(),error=>error.code==='SUPERVISOR_LEASE_LOST');
});

test('configuration changes require a higher revision and immediately fence already-open owners',async t=>{
  const f=await fixture(t);f.first.acquire();
  await assert.rejects(f.open({...options,configurationId:'other-cluster'}),error=>error.code==='SUPERVISOR_CONFIGURATION_CHANGED');
  await assert.rejects(f.open({...options,leaseMs:6000}),error=>error.code==='SUPERVISOR_CONFIGURATION_CHANGED');
  const next=await f.open({...options,configurationRevision:2,configurationId:'other-cluster'});
  assert.throws(()=>f.first.renew(),error=>error.code==='SUPERVISOR_CONFIGURATION_CHANGED');
  assert.equal(next.acquire(),true);assert.equal(next.status('leader').epoch,2);
  await assert.rejects(f.open(),error=>error.code==='SUPERVISOR_CONFIGURATION_CHANGED');
});

test('unknown persisted protocol refuses bootstrap and every already-open ownership operation',async t=>{
  const f=await fixture(t);f.first.acquire();const before=f.observer.prepare('SELECT * FROM clank_platform_supervisor_lease').get();
  f.observer.exec('UPDATE clank_platform_supervisor_state SET protocol=99');
  await assert.rejects(f.open(),error=>error.code==='SUPERVISOR_PROTOCOL');
  for(const invoke of [()=>f.first.acquire(),()=>f.first.renew(),()=>f.first.release(),()=>f.first.status('leader')])assert.throws(invoke,error=>error.code==='SUPERVISOR_PROTOCOL');
  assert.deepEqual(f.observer.prepare('SELECT * FROM clank_platform_supervisor_lease').get(),before);
});

test('malformed native ownership, future clocks and exhausted epochs fail without deleting retained authority',async t=>{
  const f=await fixture(t);
  f.observer.exec("UPDATE clank_platform_supervisor_lease SET owner='forged-owner'");assert.throws(()=>f.first.acquire(),error=>error.code==='SUPERVISOR_STATE_INVALID');
  f.observer.prepare('UPDATE clank_platform_supervisor_lease SET owner=NULL,updated_at=?').run(Date.now()+60000);assert.throws(()=>f.first.acquire(),error=>error.code==='SUPERVISOR_CLOCK_REGRESSION');
  f.observer.prepare('UPDATE clank_platform_supervisor_lease SET updated_at=?,epoch=9007199254740991').run(Date.now());assert.throws(()=>f.first.acquire(),error=>error.code==='SUPERVISOR_EPOCH_EXHAUSTED');
  assert.equal(f.observer.prepare('SELECT epoch FROM clank_platform_supervisor_lease').get().epoch,Number.MAX_SAFE_INTEGER);
});

test('malformed persisted configuration cannot be healed by opening a higher revision',async t=>{
  const f=await fixture(t);f.observer.exec('UPDATE clank_platform_supervisor_state SET configuration_revision=0');
  await assert.rejects(f.open({...options,configurationRevision:2}),error=>error.code==='SUPERVISOR_STATE_INVALID');
  assert.equal(f.observer.prepare('SELECT configuration_revision FROM clank_platform_supervisor_state').get().configuration_revision,0);
});

test('alias and multiply-linked catalogs are refused before leadership schema changes',async t=>{
  const f=await fixture(t),alias=join(f.root,'alias.sqlite');await symlink(f.path,alias);
  await assert.rejects(openSupervisorLease(alias,options),/exact private native SQLite catalog/);
  await link(f.path,join(f.root,'hard.sqlite'));await assert.rejects(f.open(),/exact private native SQLite catalog/);
  assert.equal(f.observer.prepare('SELECT epoch FROM clank_platform_supervisor_lease').get().epoch,0);
});

test('supervisor timer/configuration bounds reject unsupported values before touching a catalog',()=>{
  for(const changes of [{leaseMs:0},{leaseMs:120001},{pollIntervalMs:5000},{configurationRevision:0},{configurationId:'../foreign'}])assert.throws(()=>normalizeSupervisorOptions({...options,...changes}),TypeError);
  assert.equal(normalizeSupervisorOptions({configurationId:'cluster',configurationRevision:1}).leaseMs,15000);
});

test('startup refuses a deleted retained lease or partial schema without recreating epoch zero',async t=>{
  for(const fault of ['DELETE FROM clank_platform_supervisor_lease','DROP TABLE clank_platform_supervisor_lease','DROP TABLE clank_platform_supervisor_state']){
    const f=await fixture(t);assert.equal(f.first.acquire(),true);f.first.release();f.first.close();f.observer.exec(fault);
    await assert.rejects(f.open(),error=>error.code==='SUPERVISOR_STATE_INVALID');
    if(fault.startsWith('DELETE'))assert.equal(f.observer.prepare('SELECT count(*) AS count FROM clank_platform_supervisor_lease').get().count,0);
  }
});
