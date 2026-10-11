import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readlink,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork,spawn} from 'node:child_process';
import {prepareSQLiteSandbox} from '../dist/sqlite-sandbox.js';
import {openSupervisorLease,linuxProcessBirth} from '../dist/platform-supervisor.js';
import {stagePointInTimeTransfer,applyPointInTimeTransfer,inspectPointInTimeTransferSourceSeal,exportSealedPointInTimeTransfer} from '../dist/point-in-time.js';

const linux={skip:process.platform!=='linux',timeout:180000};
const key=new Uint8Array(32).fill(83),limit=2*1024*1024;
const observerCode=await readFile(new URL('./fixtures/point-in-time-native-observer.mjs',import.meta.url),'utf8');
const namespaces=()=>Promise.all(['mnt','pid','net','user'].map(async name=>[name,await readlink(`/proc/self/ns/${name}`)])).then(Object.fromEntries);

function bounded(promise,label,milliseconds=30000){
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded ${milliseconds}ms.`)),milliseconds);})]).finally(()=>clearTimeout(timer));
}
function childOutput(child,label){
  let stdout='',stderr='',overflow;
  child.stdin?.on('error',error=>{overflow??=error;});
  for(const [stream,save] of [[child.stdout,value=>stdout+=value],[child.stderr,value=>stderr+=value]]){
    stream.setEncoding('utf8');stream.on('data',chunk=>{
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>limit){overflow??=new Error(`${label} exceeded its output bound.`);child.kill('SIGKILL');return;}
      save(chunk);
    });
  }
  let exit;
  const closed=new Promise(resolve=>{child.once('error',error=>{overflow??=error;});child.once('close',(code,signal)=>{exit={code,signal};resolve(exit);});});
  return {closed,get exit(){return exit;},get stdout(){return stdout;},get stderr(){return stderr;},get error(){return overflow;},
    async cleanup(){if(!exit){child.kill('SIGKILL');await bounded(closed,`${label} failure cleanup`,10000);}}};
}
async function sourceProcess(cleanup,root,mode){
  const child=fork(new URL('./fixtures/point-in-time-native-source.mjs',import.meta.url),[root,mode],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  const output=childOutput(child,'source capture'),messages=[],waiters=[];
  child.on('message',message=>{messages.push(message);for(const wake of waiters.splice(0))wake();});
  output.closed.then(()=>{for(const wake of waiters.splice(0))wake();});
  cleanup.push(()=>output.cleanup());
  const next=event=>bounded((async()=>{
    while(true){
      if(output.error)throw output.error;
      const failure=messages.find(message=>message.event==='failure');if(failure)throw new Error(failure.message);
      const index=messages.findIndex(message=>message.event===event);if(index!==-1)return messages.splice(index,1)[0];
      if(output.exit)throw new Error(`Source exited before ${event}: ${JSON.stringify(output.exit)}; stderr: ${output.stderr}`);
      await new Promise(resolve=>waiters.push(resolve));
    }
  })(),`source ${event}`);
  const ready=await next('ready');assert.equal(ready.pid,child.pid);assert.equal(await linuxProcessBirth(child.pid),ready.birth);
  return {ready,next,output,send:message=>new Promise((resolve,reject)=>child.send(message,error=>error?reject(error):resolve())),
    async kill(){assert.equal(child.kill('SIGKILL'),true);const exit=await bounded(output.closed,'source SIGKILL close',10000);assert.deepEqual(exit,{code:null,signal:'SIGKILL'});
      try{assert.notEqual(await linuxProcessBirth(ready.pid),ready.birth,'the original source process remains alive');}catch(error){if(error.code!=='ENOENT')throw error;}
      assert.equal(output.error,undefined);return {pid:ready.pid,birth:ready.birth,...exit,stdout:output.stdout,stderr:output.stderr};}};
}
async function observation(path,denied,mode='inspect'){
  const sandbox=await prepareSQLiteSandbox('inspection','inspectSQLite',[path],['--jitless','--max-old-space-size=128','--input-type=module','--eval',observerCode,JSON.stringify({path,denied,mode})]);
  let child,output;
  try{
    child=spawn(sandbox.executable,sandbox.arguments,{stdio:['pipe','pipe','pipe',...sandbox.descriptors],env:{NODE_NO_WARNINGS:'1',...(process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{})}});
    output=childOutput(child,'native observation');
    const value=await bounded(new Promise((resolve,reject)=>{
      const parse=()=>{if(output.error){reject(output.error);return;}if(output.stdout.includes('\n')){try{resolve(JSON.parse(output.stdout.split('\n')[0]));}catch(error){reject(error);}}};
      child.stdout.on('data',parse);output.closed.then(exit=>reject(new Error(`Observation exited before acknowledgment: ${JSON.stringify(exit)}; stderr: ${output.stderr}`)));
    }),'native observation acknowledgment');
    assert.deepEqual(value.visible,denied.map(()=>false),'an observation namespace exposed a sibling or host path');
    return {value,async close(){try{child.stdin.end('finish\n');const exit=await bounded(output.closed,'native observation natural exit',10000);assert.deepEqual(exit,{code:0,signal:null},output.stderr);assert.equal(output.error,undefined);}finally{await output.cleanup();await sandbox.close();}}};
  }catch(error){try{await output?.cleanup();}finally{await sandbox.close();}throw error;}
}
async function observePair(f){
  const source=await observation(f.source,[f.target,f.hostSentinel]);
  let target;
  try{
    target=await observation(f.target,[f.source,f.hostSentinel]);
    for(const name of ['mnt','pid','net','user']){
      assert.notEqual(source.value.namespaces[name],target.value.namespaces[name],`source/target ${name} namespace must differ`);
      assert.notEqual(source.value.namespaces[name],f.hostNamespaces[name]);assert.notEqual(target.value.namespaces[name],f.hostNamespaces[name]);
    }
    return {source:source.value,target:target.value};
  }finally{try{await target?.close();}finally{await source.close();}}
}
async function fixture(t,mode){
  const root=await mkdtemp(join(tmpdir(),'clank-native-transfer-'));
  const cleanup=[];
  t.after(async()=>{
    const failures=[];for(const close of cleanup.toReversed())try{await close();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,`Owned process cleanup was uncertain; retained ${root}.`);
    await rm(root,{recursive:true,force:true});
  });
  const sourceRoot=join(root,'source'),targetRoot=join(root,'target'),authorityRoot=join(root,'authority');
  await Promise.all([sourceRoot,targetRoot,authorityRoot].map(path=>mkdir(path,{mode:0o700})));
  const hostSentinel=join(root,'host-private');await writeFile(hostSentinel,'must not be granted');
  const leases=[];
  for(const name of ['retained-data','target']){
    const lease=await openSupervisorLease(join(authorityRoot,`${name}.sqlite`),{configurationId:`native-${name}`,configurationRevision:1,leaseMs:120000,pollIntervalMs:500});
    leases.push(lease);cleanup.push(()=>lease.close());assert.equal(lease.acquire(),true);
  }
  const child=await sourceProcess(cleanup,sourceRoot,mode),{archive,binding}=child.ready;
  const authority={assertSourceCurrent:()=>leases[0].assertCurrent(),assertTargetCurrent:()=>leases[1].assertCurrent()};
  const options={...authority,identity:binding.identity,encryptionKey:key,targetPath:join(targetRoot,'target.sqlite')};
  const stage=()=>stagePointInTimeTransfer(archive,{...options,operationId:binding.baseOperationId,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest});
  const source=join(sourceRoot,'source.sqlite');
  const inspection=after=>({...binding,sourcePath:source,encryptionKey:key,after,assertCurrent:()=>leases[0].assertCurrent()});
  return {root,source,target:options.targetPath,hostSentinel,hostNamespaces:await namespaces(),child,binding,options,stage,inspection,leases};
}

test('native namespace transfer recovers a committed tail after capture SIGKILL without activating the stopped target',linux,async t=>{
  const f=await fixture(t,'committed'),staged=await f.stage();assert.deepEqual(staged.cursor,f.binding.initialCursor);
  let cursor=staged.cursor,ledger=[];
  for(let batchNumber=0;batchNumber<3;batchNumber++){
    await f.child.send({operation:'batch',after:cursor,count:2});const acknowledged=await f.child.next('batch');
    assert.equal(acknowledged.batch.envelopes.length,2);assert.equal(Object.hasOwn(acknowledged.batch,'files'),false);ledger=acknowledged.ledger;
    const result=await applyPointInTimeTransfer(acknowledged.batch,{...f.options,expectedCursor:cursor});assert.equal(result.appliedEntries,2);cursor=result.cursor;
    const probe=await observation(f.source,[f.target,f.hostSentinel],'write-probe');
    try{assert.equal(probe.value.result.committed,false);assert.equal(probe.value.result.errcode,5);assert.match(probe.value.result.message,/locked/);}finally{await probe.close();}
  }
  const after=cursor;await f.child.send({operation:'tail',count:3});const final=await f.child.next('tail');ledger=final.ledger;assert.equal(final.throughSequence,9);
  await f.child.send({operation:'seal',after});await f.child.next('committed');const stopped=await f.child.kill();
  const before=await observePair(f);assert.equal(before.source.result.capture.remote_exports_protocol,2);assert.equal(before.target.result.capture.sequence,6);
  assert.deepEqual(before.source.result.rows,ledger.toSorted());assert.equal(before.target.result.rows.length,6);
  const seal=await inspectPointInTimeTransferSourceSeal(f.inspection(after));assert.equal(seal.through.sequence,9);assert.deepEqual(seal.after,after);
  assert.deepEqual(await inspectPointInTimeTransferSourceSeal(f.inspection(after)),seal);
  const batches=[];
  for(let sequence=7;sequence<=9;sequence++){
    const request={...f.inspection(after),expectedCursor:cursor,throughSequence:sequence,maxEntries:1};
    const batch=await exportSealedPointInTimeTransfer(request);assert.equal(batch.envelopes.length,1);assert.deepEqual(await exportSealedPointInTimeTransfer(request),batch);
    batches.push(batch);cursor=batch.through;
  }
  await assert.rejects(applyPointInTimeTransfer(batches[1],{...f.options,expectedCursor:batches[1].after}),/predecessor/);
  await assert.rejects(applyPointInTimeTransfer({...batches[0],authentication:'0'.repeat(64)},{...f.options,expectedCursor:after}),/authentication/);
  await assert.rejects(exportSealedPointInTimeTransfer({...f.inspection(after),identity:{...f.binding.identity,targetNodeId:'other'},expectedCursor:after,throughSequence:7,maxEntries:1}),/evidence/);
  assert.deepEqual((await observePair(f)).target.result,before.target.result,'rejected requests must not change the staged target');
  cursor=after;
  for(const batch of batches){
    const applied=await applyPointInTimeTransfer(batch,{...f.options,expectedCursor:cursor});assert.equal(applied.appliedEntries,1);cursor=applied.cursor;
    const replay=await applyPointInTimeTransfer(batch,{...f.options,expectedCursor:batch.after});assert.equal(replay.replayed,true);assert.equal(replay.appliedEntries,0);assert.deepEqual(replay.cursor,cursor);
  }
  const finalPair=await observePair(f),source=finalPair.source.result,target=finalPair.target.result;
  assert.deepEqual(source,before.source.result,'readonly seal/tail export preserves native application, journal and receipt state');
  assert.deepEqual(target.rows,ledger.toSorted());assert.equal(target.integrity,'ok');assert.equal(source.integrity,'ok');
  for(const name of ['epoch','sequence','digest','state_hash','committed_at'])assert.equal(target.capture[name],source.capture[name]);
  assert.deepEqual(cursor,seal.through);assert.equal(target.receipts.length,6);assert.equal(target.transfer.length,1);
  const retry=await f.stage();assert.equal(retry.replayed,true);assert.deepEqual(retry.cursor,cursor);
  assert.deepEqual((await observePair(f)).target.result,target,'base retry and batch replay preserve exact durable target state');
  // A real native capability is required on retry even after all data is durable.
  f.leases[1].release();await assert.rejects(applyPointInTimeTransfer(batches.at(-1),{...f.options,expectedCursor:batches.at(-1).after}),/ownership|availability/);
  f.leases[0].release();await assert.rejects(inspectPointInTimeTransferSourceSeal(f.inspection(after)),/ownership|availability/);
  assert.deepEqual((await observePair(f)).target.result,target,'revoked native ownership cannot acknowledge or mutate a durable target');
  t.diagnostic(JSON.stringify({scope:'capture SIGKILL and SQLite namespaces only; no provider stop or target activation',stopped,baseArchives:1,liveBatches:3,terminalBatches:3,sourceCommits:9,finalSequence:cursor.sequence,sourceNamespace:finalPair.source.namespaces,targetNamespace:finalPair.target.namespaces}));
});

test('uncommitted native source decision rolls back after SIGKILL and cannot authorize readonly tail recovery',linux,async t=>{
  const f=await fixture(t,'uncommitted'),staged=await f.stage();
  await f.child.send({operation:'tail',count:3});const acknowledged=await f.child.next('tail');
  await f.child.send({operation:'seal',after:staged.cursor});await f.child.next('uncommitted');const stopped=await f.child.kill();
  const before=await observePair(f);assert.equal(before.source.result.capture.remote_exports_protocol,1);assert.deepEqual(before.source.result.seal,[]);
  assert.deepEqual(before.source.result.rows,acknowledged.ledger.toSorted());assert.deepEqual(before.target.result.rows,[]);
  await assert.rejects(inspectPointInTimeTransferSourceSeal(f.inspection(staged.cursor)),/evidence/);
  await assert.rejects(exportSealedPointInTimeTransfer({...f.inspection(staged.cursor),expectedCursor:staged.cursor,throughSequence:1,maxEntries:1}),/evidence/);
  assert.deepEqual((await observePair(f)).target.result,before.target.result);assert.equal(before.target.result.capture.sequence,0);
  t.diagnostic(JSON.stringify({scope:'uncommitted capture decision only; stopped target retained',stopped,sourceNamespace:before.source.namespaces,targetNamespace:before.target.namespaces}));
});
