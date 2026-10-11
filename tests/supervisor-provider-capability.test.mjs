import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openSupervisorLease} from '../dist/platform-supervisor.js';

const options={configurationId:'provider-capability',configurationRevision:1,leaseMs:5000,pollIntervalMs:50};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-capability-')),path=join(root,'catalog.sqlite'),leases=[],children=[];
  const open=async(config=options)=>{const lease=await openSupervisorLease(path,config);leases.push(lease);return lease;};
  const first=await open(),sql=new DatabaseSync(path);sql.exec('PRAGMA busy_timeout=5000;CREATE TABLE baseline_writer_effects(pid INTEGER NOT NULL) STRICT');
  t.after(async()=>{
    for(const {child,exited} of children){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
    for(const lease of leases)lease.close();sql.close();await rm(root,{recursive:true,force:true});
  });
  const protocol=()=>sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol;
  const retained=()=>sql.prepare('SELECT * FROM clank_platform_supervisor_lease').get();
  const start=async(active=false)=>{
    const child=fork(new URL('./fixtures/supervisor-protocol1-worker.mjs',import.meta.url),[],{
      env:{...process.env,CLANK_SUPERVISOR_BASELINE_CATALOG:path,CLANK_SUPERVISOR_BASELINE_ACTIVE:active?'1':'0'},stdio:['ignore','pipe','pipe','ipc'],
    });
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-8192));
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));children.push({child,exited});
    const messages=[],waiters=[];child.on('message',message=>{const waiter=waiters.shift();if(waiter)waiter(message);else messages.push(message);});
    const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Baseline child did not respond: '+output)),10000);
      const receive=message=>{clearTimeout(timer);resolve(message);};waiters.push(receive);
      exited.then(()=>{if(waiters.includes(receive)){clearTimeout(timer);waiters.splice(waiters.indexOf(receive),1);reject(new Error('Baseline child exited without response: '+output));}});
    });
    const initial=await next();return {child,exited,initial,next};
  };
  return {root,path,first,sql,open,protocol,retained,start};
}

test('provider capability requires the exact live owner and atomically advances only the retained protocol',async t=>{
  const f=await fixture(t),standby=await f.open();assert.equal(f.protocol(),1);
  assert.throws(()=>f.first.enrollProviderCanaries(),{code:'SUPERVISOR_LEASE_LOST'});
  assert.equal(f.protocol(),1);assert.equal(f.first.acquire(),true);
  assert.throws(()=>standby.enrollProviderCanaries(),{code:'SUPERVISOR_LEASE_LOST'});
  const before=f.retained();assert.equal(f.first.enrollProviderCanaries(),undefined);assert.equal(f.protocol(),2);
  assert.deepEqual(f.retained(),before);assert.equal(f.first.enrollProviderCanaries(),undefined);assert.deepEqual(f.retained(),before);
  f.first.renew();assert.equal(f.first.assertCurrent(),undefined);
});

test('ordinary catalogs stay protocol one while enrolled catalogs retain protocol two across release and higher revisions',async t=>{
  const ordinary=await fixture(t);ordinary.first.acquire();ordinary.first.release();ordinary.first.close();
  const reopened=await ordinary.open({...options,configurationRevision:2});reopened.acquire();assert.equal(ordinary.protocol(),1);
  const f=await fixture(t);f.first.acquire();f.first.enrollProviderCanaries();f.first.release();f.first.close();
  const current=await f.open();assert.equal(f.protocol(),2);assert.equal(current.acquire(),true);assert.equal(current.status('leader').epoch,2);
  current.release();current.close();
  const revised=await f.open({...options,configurationId:'new-provider-capability',configurationRevision:2});
  assert.equal(f.protocol(),2);assert.equal(revised.acquire(),true);assert.equal(revised.status('leader').epoch,3);
  revised.release();assert.equal(f.protocol(),2);
});

test('expired and replaced native authority cannot enroll provider capability',async t=>{
  const f=await fixture(t);f.first.acquire();f.sql.exec('UPDATE clank_platform_supervisor_lease SET expires_at=0');
  assert.throws(()=>f.first.enrollProviderCanaries(),{code:'SUPERVISOR_LEASE_LOST'});assert.equal(f.protocol(),1);
  const next=await f.open();assert.equal(next.acquire(),true);const before=f.retained();
  assert.throws(()=>f.first.enrollProviderCanaries(),{code:'SUPERVISOR_LEASE_LOST'});assert.equal(f.protocol(),1);assert.deepEqual(f.retained(),before);
  next.enrollProviderCanaries();assert.equal(f.protocol(),2);
});

test('ignored, reverted and authority-changing native enrollment writes cannot acknowledge capability',async t=>{
  for(const trigger of [
    'CREATE TRIGGER enrollment_fault BEFORE UPDATE OF protocol ON clank_platform_supervisor_state BEGIN SELECT RAISE(IGNORE); END',
    'CREATE TRIGGER enrollment_fault AFTER UPDATE OF protocol ON clank_platform_supervisor_state BEGIN UPDATE clank_platform_supervisor_state SET protocol=1; END',
    'CREATE TRIGGER enrollment_fault AFTER UPDATE OF protocol ON clank_platform_supervisor_state BEGIN UPDATE clank_platform_supervisor_lease SET expires_at=0; END',
  ]){
    const f=await fixture(t);f.first.acquire();const before=f.retained();f.sql.exec(trigger);
    assert.throws(()=>f.first.enrollProviderCanaries(),error=>['SUPERVISOR_PROTOCOL','SUPERVISOR_LEASE_LOST'].includes(error.code));
    assert.equal(f.protocol(),1);assert.deepEqual(f.retained(),before);
    f.sql.exec('DROP TRIGGER enrollment_fault');assert.equal(f.first.enrollProviderCanaries(),undefined);assert.equal(f.protocol(),2);
  }
});

test('native contention and missing protocol state refuse enrollment without acknowledging or recreating it',async t=>{
  const f=await fixture(t);f.first.acquire();const before=f.retained();f.sql.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>f.first.enrollProviderCanaries(),error=>error.code==='ERR_SQLITE_ERROR'&&error.errcode===5);assert.equal(f.protocol(),1);}
  finally{f.sql.exec('ROLLBACK');}
  assert.deepEqual(f.retained(),before);f.sql.exec('DELETE FROM clank_platform_supervisor_state');
  assert.throws(()=>f.first.enrollProviderCanaries(),{code:'SUPERVISOR_PROTOCOL'});
  assert.equal(f.sql.prepare('SELECT count(*) AS count FROM clank_platform_supervisor_state').get().count,0);assert.deepEqual(f.retained(),before);
});

test('actual protocol-one binary refuses fresh startup and a previously opened standby before any native writer admission',async t=>{
  const f=await fixture(t);f.first.acquire();const standby=await f.start();assert.equal(standby.initial.kind,'ready');
  f.first.enrollProviderCanaries();f.first.release();const before=f.retained();
  standby.child.send({kind:'acquire-and-write'});assert.deepEqual(await standby.next(),{kind:'refused',code:'SUPERVISOR_PROTOCOL',message:'Unsupported supervisor protocol.'});
  assert.deepEqual(await standby.exited,{code:0,signal:null});assert.deepEqual(f.retained(),before);
  const fresh=await f.start();assert.equal(fresh.initial.kind,'refused');assert.equal(fresh.initial.code,'SUPERVISOR_PROTOCOL');
  assert.deepEqual(await fresh.exited,{code:0,signal:null});assert.equal(f.sql.prepare('SELECT count(*) AS count FROM baseline_writer_effects').get().count,0);
  assert.deepEqual(f.retained(),before);assert.equal(f.protocol(),2);
});

test('actual already-running protocol-one owner refuses a stale native writer continuation after capability enrollment',async t=>{
  const f=await fixture(t),old=await f.start(true);assert.equal(old.initial.kind,'ready');
  f.sql.exec('UPDATE clank_platform_supervisor_lease SET expires_at=0');assert.equal(f.first.acquire(),true);f.first.enrollProviderCanaries();
  const before=f.retained();old.child.send({kind:'write'});const refusal=await old.next();
  assert.equal(refusal.kind,'refused');assert.equal(refusal.code,'SUPERVISOR_PROTOCOL');assert.deepEqual(await old.exited,{code:0,signal:null});
  assert.equal(f.sql.prepare('SELECT count(*) AS count FROM baseline_writer_effects').get().count,0);assert.deepEqual(f.retained(),before);
});
