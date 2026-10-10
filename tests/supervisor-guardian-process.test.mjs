import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openSupervisorLease,waitForSupervisorCleanup} from '../dist/platform-supervisor.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-guardian-')),children=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}await rm(root,{recursive:true,force:true});});
  const start=async()=>{
    const child=fork(new URL('./fixtures/supervisor-guardian-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:root},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let output='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-8192));
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned supervisor did not become ready: '+output)),15000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned supervisor exited before readiness: '+output));});});
    assert.equal(ready.kind,'ready');return {child,exited,status:ready.status};
  };
  const inspect=()=>{const database=new DatabaseSync(join(root,'catalog.sqlite'),{readOnly:true});database.exec('PRAGMA busy_timeout=5000');return database;};
  return {root,start,inspect};
}

for(const interruption of ['SIGKILL','SIGSTOP']){
  test(`actual ${interruption} of a coordinator is fenced by its independent guardian before the next native writer epoch`,async t=>{
    const f=await fixture(t),first=await f.start();assert.equal(first.status.epoch,1);
    first.child.kill(interruption);
    let timer;const result=await Promise.race([first.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned coordinator was not fenced')),12000);})]).finally(()=>clearTimeout(timer));
    assert.equal(result.signal,'SIGKILL');
    const second=await f.start();assert.equal(second.status.epoch,2);
    const observer=f.inspect();try{
      const old=Number(observer.prepare('SELECT count(*) AS count FROM actual_supervisor_writes WHERE epoch=1').get().count);
      assert.ok(old>=1);assert.ok(Number(observer.prepare('SELECT count(*) AS count FROM actual_supervisor_writes WHERE epoch=2').get().count)>=1);
      await new Promise(resolve=>setTimeout(resolve,250));assert.equal(Number(observer.prepare('SELECT count(*) AS count FROM actual_supervisor_writes WHERE epoch=1').get().count),old);
    }finally{observer.close();}
    second.child.send({kind:'stop'});assert.deepEqual(await second.exited,{code:0,signal:null});
    assert.deepEqual(await readdir(join(f.root,'supervisor-guardians')),[]);
  });
}

test('actual guardian death terminates its dedicated coordinator and a clean successor retains the increasing native epoch',async t=>{
  const f=await fixture(t),first=await f.start(),folder=join(f.root,'supervisor-guardians'),names=await readdir(folder);assert.equal(names.length,1);
  const record=JSON.parse(await readFile(join(folder,names[0]),'utf8'));assert.equal(record.controllerPid,first.child.pid);assert.equal(record.phase,'armed');assert.ok(record.guardianPid>0);
  process.kill(record.guardianPid,'SIGKILL');assert.equal((await first.exited).signal,'SIGKILL');
  const second=await f.start();assert.equal(second.status.epoch,2);second.child.send({kind:'stop'});assert.deepEqual(await second.exited,{code:0,signal:null});
});

test('an unresolved cleanup record refuses successor admission even after its prior process has exited',async t=>{
  const f=await fixture(t),first=await f.start();first.child.send({kind:'stop'});assert.deepEqual(await first.exited,{code:0,signal:null});
  const folder=join(f.root,'supervisor-guardians'),name='supervisor-00000000-0000-4000-8000-000000000001.json';
  await writeFile(join(folder,name),JSON.stringify({protocol:1,controllerPid:first.child.pid,controllerBirth:'1',epoch:1,phase:'failed'}),{mode:0o600});
  const lease=await openSupervisorLease(join(f.root,'catalog.sqlite'),{configurationId:'actual-process-cluster',configurationRevision:1,leaseMs:5000,pollIntervalMs:50});
  try{assert.equal(lease.acquire(),true);await assert.rejects(waitForSupervisorCleanup(f.root,lease),error=>error.code==='SUPERVISOR_CLEANUP_REQUIRED');assert.equal((await readdir(folder)).includes(name),true);}finally{lease.release();lease.close();}
});

test('actual native expiry after preparing-fence publication terminates the unarmed coordinator and permits a retained-epoch successor',async t=>{
  const f=await fixture(t),child=fork(new URL('./fixtures/supervisor-guardian-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:f.root,CLANK_SUPERVISOR_ARM_EXPIRY:'1'},stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr.on('data',value=>errors=(errors+value).slice(-4096));const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let timer;
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned unarmed coordinator did not fence: '+errors)),10000);})]).finally(()=>clearTimeout(timer));
  assert.equal(result.signal,'SIGKILL');assert.equal((await readdir(join(f.root,'supervisor-guardians'))).length,1,'Retain the preparing fence until actual process death is verified.');
  const successor=await f.start();assert.equal(successor.status.epoch,2);successor.child.send({kind:'stop'});assert.deepEqual(await successor.exited,{code:0,signal:null});
});

test('actual SIGKILL after native lease commit before guardian or acknowledgement retains one increasing successor epoch',async t=>{
  const f=await fixture(t),child=fork(new URL('./fixtures/supervisor-guardian-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:f.root,CLANK_SUPERVISOR_PAUSE_AFTER_ACQUIRE:'1'},stdio:['ignore','ignore','pipe','ipc']});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const acquired=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned native acquisition did not commit')),10000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  assert.equal(acquired.kind,'acquired');assert.equal(acquired.status.epoch,1);child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
  const successor=await f.start();assert.equal(successor.status.epoch,2);const observer=f.inspect();try{assert.equal(observer.prepare('SELECT count(*) AS count FROM actual_supervisor_writes WHERE epoch=1').get().count,0);}finally{observer.close();}
  successor.child.send({kind:'stop'});assert.deepEqual(await successor.exited,{code:0,signal:null});
});
