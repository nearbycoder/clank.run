import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp,rm,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSupervisorLease } from '../dist/platform-supervisor.js';
import { prepareShadowSchema } from './fixtures/shadow-schema.mjs';

const options={configurationId:'shadow-capability',configurationRevision:1,leaseMs:5000,pollIntervalMs:50};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-shadow-protocol-')),path=join(root,'catalog.sqlite'),leases=[],children=[];
  const open=async(config=options)=>{const lease=await openSupervisorLease(path,config);leases.push(lease);return lease;};
  const first=await open(),sql=new DatabaseSync(path);sql.exec('PRAGMA busy_timeout=5000;CREATE TABLE baseline_writer_effects(pid INTEGER NOT NULL) STRICT');
  t.after(async()=>{for(const {child,exited} of children){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
    for(const lease of leases)lease.close();sql.close();await rm(root,{recursive:true,force:true});});
  const protocol=()=>sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol;
  const retained=()=>sql.prepare('SELECT * FROM clank_platform_supervisor_lease').get();
  const start=async(mode='standby')=>{
    const child=fork(new URL('./fixtures/supervisor-shadow-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SHADOW_SUPERVISOR_ROOT:root,CLANK_SHADOW_SUPERVISOR_MODE:mode},stdio:['ignore','pipe','pipe','ipc']});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-8192));
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));children.push({child,exited});
    const messages=[],waiters=[];child.on('message',message=>{const waiter=waiters.shift();if(waiter)waiter(message);else messages.push(message);});
    const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Owned child response timeout: '+output)),12000);
      const receive=message=>{clearTimeout(timer);resolve(message);};waiters.push(receive);
      exited.then(()=>{if(waiters.includes(receive)){clearTimeout(timer);waiters.splice(waiters.indexOf(receive),1);reject(new Error('Owned child exited: '+output));}});
    });
    return {child,exited,next,initial:await next()};
  };
  return {root,path,first,sql,open,protocol,retained,start};
}

test('shadow enrollment needs exact current native authority and verified prepared schema',async t=>{
  const f=await fixture(t),standby=await f.open();assert.equal(f.protocol(),1);
  assert.throws(()=>f.first.enrollProviderShadow(),{code:'SUPERVISOR_LEASE_LOST'});
  f.first.acquire();assert.throws(()=>f.first.enrollProviderShadow(),{code:'SUPERVISOR_SHADOW_SCHEMA'});assert.equal(f.protocol(),1);
  prepareShadowSchema(f.sql);assert.throws(()=>standby.enrollProviderShadow(),{code:'SUPERVISOR_LEASE_LOST'});
  const before=f.retained();f.first.enrollProviderShadow();assert.equal(f.protocol(),3);assert.deepEqual(f.retained(),before);
  f.first.enrollProviderShadow();f.first.enrollProviderCanaries();assert.equal(f.protocol(),3);assert.deepEqual(f.retained(),before);
  f.first.renew();f.first.assertCurrent();
});

test('prepared schema without enrollment admits no shadow capability and enrolled restart preserves protocol three',async t=>{
  const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.release();f.first.close();
  const next=await f.open();assert.equal(f.protocol(),1);next.acquire();next.enrollProviderCanaries();assert.equal(f.protocol(),2);
  next.enrollProviderShadow();next.release();next.close();
  const current=await f.open({...options,configurationRevision:2});assert.equal(f.protocol(),3);current.acquire();current.enrollProviderCanaries();assert.equal(f.protocol(),3);
});

test('expired and replaced native owners cannot enroll shadow state',async t=>{
  const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.sql.exec('UPDATE clank_platform_supervisor_lease SET expires_at=0');
  assert.throws(()=>f.first.enrollProviderShadow(),{code:'SUPERVISOR_LEASE_LOST'});assert.equal(f.protocol(),1);
  const next=await f.open();next.acquire();const before=f.retained();
  assert.throws(()=>f.first.enrollProviderShadow(),{code:'SUPERVISOR_LEASE_LOST'});assert.deepEqual(f.retained(),before);next.enrollProviderShadow();
});

test('ignored, reverted, changed-sentinel and lost-authority enrollment transactions roll back without poisoning a valid retry',async t=>{
  for(const body of ['SELECT RAISE(IGNORE);','UPDATE clank_platform_supervisor_state SET protocol=1;',
    "UPDATE clank_platform_shadow_state SET enrollment_id=printf('%064d',2);",'UPDATE clank_platform_supervisor_lease SET expires_at=0;']){
    const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();const before=f.retained(),sentinel=f.sql.prepare('SELECT * FROM clank_platform_shadow_state').get();
    f.sql.exec(`CREATE TRIGGER shadow_fault ${body.includes('IGNORE')?'BEFORE':'AFTER'} UPDATE OF protocol ON clank_platform_supervisor_state BEGIN ${body} END`);
    assert.throws(()=>f.first.enrollProviderShadow(),error=>['SUPERVISOR_PROTOCOL','SUPERVISOR_SHADOW_SCHEMA','SUPERVISOR_LEASE_LOST'].includes(error.code));
    assert.equal(f.protocol(),1);assert.deepEqual(f.retained(),before);assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_shadow_state').get(),sentinel);
    f.sql.exec('DROP TRIGGER shadow_fault');f.first.enrollProviderShadow();assert.equal(f.protocol(),3);
  }
});

test('protocol-three startup refuses missing or malformed schema before any native bootstrap repair',async t=>{
  for(const damage of ['DROP TABLE clank_platform_shadow_reports','DROP TABLE clank_platform_shadow_state','DROP TABLE clank_platform_provider_canaries',
    'ALTER TABLE clank_platform_projects DROP COLUMN provider_canary_epoch',
    'DELETE FROM clank_platform_shadow_state',"UPDATE clank_platform_shadow_state SET schema_id='unknown'",
    'ALTER TABLE clank_platform_releases DROP COLUMN upload_request_digest','ALTER TABLE clank_platform_projects DROP COLUMN shadow_replay_receipt']){
    const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.enrollProviderShadow();f.first.release();f.first.close();f.sql.exec(damage);
    const before=f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),lease=f.retained();
    await assert.rejects(f.open(),{code:'SUPERVISOR_SHADOW_SCHEMA'});assert.deepEqual(f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),before);assert.deepEqual(f.retained(),lease);
  }
});

test('live native assertions reject enrollment identity replacement and protocol downgrade',async t=>{
  for(const damage of ["UPDATE clank_platform_shadow_state SET enrollment_id=printf('%064d',2)",'UPDATE clank_platform_supervisor_state SET protocol=2']){
    const f=await fixture(t);prepareShadowSchema(f.sql);f.first.acquire();f.first.enrollProviderShadow();f.sql.exec(damage);
    assert.throws(()=>f.first.assertCurrent(),error=>['SUPERVISOR_SHADOW_SCHEMA','SUPERVISOR_PROTOCOL'].includes(error.code));
  }
});

test('actual old protocol-two startup and standby refuse shadow admission before native writer effects',async t=>{
  const f=await fixture(t);f.first.acquire();prepareShadowSchema(f.sql);const old=await f.start();assert.equal(old.initial.kind,'ready');
  f.first.enrollProviderShadow();f.first.release();const before=f.retained();old.child.send({kind:'write'});
  assert.equal((await old.next()).code,'SUPERVISOR_PROTOCOL');assert.deepEqual(await old.exited,{code:0,signal:null});
  const fresh=await f.start();assert.equal(fresh.initial.code,'SUPERVISOR_PROTOCOL');assert.deepEqual(await fresh.exited,{code:0,signal:null});
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM baseline_writer_effects').get().n,0);assert.deepEqual(f.retained(),before);
});

test('actual old protocol-two owner refuses its native writer continuation after enrollment',async t=>{
  const f=await fixture(t),old=await f.start('active');assert.equal(old.initial.kind,'ready');prepareShadowSchema(f.sql);
  f.sql.exec('UPDATE clank_platform_supervisor_lease SET expires_at=0');f.first.acquire();f.first.enrollProviderShadow();const before=f.retained();
  old.child.send({kind:'write'});assert.equal((await old.next()).code,'SUPERVISOR_PROTOCOL');assert.deepEqual(await old.exited,{code:0,signal:null});
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM baseline_writer_effects').get().n,0);assert.deepEqual(f.retained(),before);
});

test('actual old guardian fences its unchanged live owner when persisted protocol becomes three',async t=>{
  const f=await fixture(t),old=await f.start('old-guardian');assert.equal(old.initial.kind,'ready');prepareShadowSchema(f.sql);
  // Only the protocol is externally changed, isolating the old guardian's
  // compatibility refusal from lease expiry/replacement. No shadow intent runs.
  f.sql.exec('UPDATE clank_platform_supervisor_state SET protocol=3');
  let timer;const result=await Promise.race([old.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Old guardian did not fence')),10000);})]).finally(()=>clearTimeout(timer));
  assert.equal(result.signal,'SIGKILL');assert.equal(f.protocol(),3);
});

test('already-armed current guardian survives shadow enrollment and retains its identity through graceful shutdown',async t=>{
  const f=await fixture(t),current=await f.start('new-guardian');assert.equal(current.initial.kind,'ready');
  const directory=join(f.root,'supervisor-guardians'),[name]=await readdir(directory),before=await readFile(join(directory,name),'utf8');
  current.child.send({kind:'enroll'});assert.equal((await current.next()).kind,'enrolled');assert.equal(f.protocol(),3);
  await new Promise(resolve=>setTimeout(resolve,350));assert.equal(current.child.exitCode,null);assert.equal(current.child.signalCode,null);
  assert.equal(await readFile(join(directory,name),'utf8'),before);current.child.send({kind:'stop'});assert.equal((await current.next()).kind,'stopped');
  assert.deepEqual(await current.exited,{code:0,signal:null});assert.deepEqual(await readdir(directory),[]);assert.equal(f.protocol(),3);
});

for(const damage of ['DROP TABLE clank_platform_shadow_reports',"UPDATE clank_platform_shadow_state SET enrollment_id=printf('%064d',2)"]){
  test(`actual current guardian fences a stopped coordinator after retained shadow damage: ${damage}`,async t=>{
    const f=await fixture(t),current=await f.start('new-guardian-enrolled');assert.equal(current.initial.kind,'ready');
    // Guardian readiness acknowledges its initial committed protocol-three read.
    // The separate upgrade-survival case exercises enrollment after arming.
    assert.equal(f.protocol(),3);current.child.kill('SIGSTOP');
    assert.ok(f.retained().expires_at-Date.now()>3000,'Native lease remains live throughout this schema-specific refusal.');
    f.sql.exec(damage);let timer;
    const result=await Promise.race([current.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Guardian did not reject damaged shadow state before lease expiry')),1500);})]).finally(()=>clearTimeout(timer));
    assert.deepEqual(result,{code:null,signal:'SIGKILL'});assert.ok(f.retained().expires_at>Date.now());
  });
}
