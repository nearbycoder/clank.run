import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('actual platform coordinators admit one active runtime and the existing standby automatically recovers after stopped-leader fencing',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-platform-')),children=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}await rm(root,{recursive:true,force:true});});
  const start=async()=>{
    const child=fork(new URL('./fixtures/supervisor-platform-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:root},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let output='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-8192));
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned platform not ready: '+output)),15000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned platform exited before readiness: '+output));});});
    assert.equal(ready.kind,'ready');return {child,exited,...ready};
  };
  const first=await start(),second=await start();assert.equal(first.status.state,'leader');assert.equal(second.status.state,'standby');assert.equal(first.status.epoch,1);
  assert.equal((await fetch(first.url+'/')).status,200);const unavailable=await fetch(second.url+'/');assert.equal(unavailable.status,503);assert.ok(unavailable.headers.get('retry-after'));
  first.child.kill('SIGSTOP');let timer;
  const killed=await Promise.race([first.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Stopped platform leader was not fenced')),12000);})]).finally(()=>clearTimeout(timer));assert.equal(killed.signal,'SIGKILL');
  const deadline=Date.now()+12000;let status;
  do{status=(await fetch(second.url+'/')).status;if(status===200)break;assert.equal(status,503);await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
  assert.equal(status,200);
  const current=await new Promise(resolve=>{second.child.once('message',resolve);second.child.send({kind:'status',id:'after-takeover'});});assert.equal(current.status.state,'leader');assert.equal(current.status.epoch,2);assert.deepEqual(current.errors,[]);
  second.child.send({kind:'stop'});assert.deepEqual(await second.exited,{code:0,signal:null});
});
