import {pointInTimeReceiptCount} from './fixtures/point-in-time-receipts.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
const token='owned_native_provider_credential_0123456789';
const message=(entry,predicate)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('Owned native process barrier deadline: '+entry.stderr())),15000);const receive=value=>{if(value.failed)done(new Error(value.failed));else if(predicate(value))done(null,value);},exit=()=>done(new Error('Owned native process exited before barrier.'));function done(error,value){clearTimeout(timer);entry.worker.off('message',receive);entry.worker.off('exit',exit);error?reject(error):resolve(value);}entry.worker.on('message',receive);entry.worker.once('exit',exit);});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'clank-platform-pitr-process-')),provider=join(root,'provider'),controller=join(root,'controller'),children=[];await mkdir(provider);await mkdir(controller);
  t.after(async()=>{for(const entry of children){if(entry.worker.exitCode===null&&entry.worker.signalCode===null)entry.worker.kill('SIGKILL');await entry.closed;}await rm(root,{recursive:true,force:true});});
  const start=(name,input)=>{const worker=fork(new URL('./fixtures/'+name,import.meta.url),[JSON.stringify(input)],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';worker.stderr.on('data',part=>stderr=(stderr+part).slice(-4096));const entry={worker,closed:new Promise(resolve=>worker.once('close',resolve)),stderr:()=>stderr};children.push(entry);return entry;};
  return {root,provider,controller,start};
}

test('actual controller SIGKILL during an undelivered provider checkpoint retains its exact native intent and retries one source receipt after both processes reopen',{timeout:30000},async t=>{
  const f=await fixture(t),provider=f.start('point-in-time-provider-worker.mjs',{root:f.provider,token,holdFirstCheckpoint:true}),ready=await message(provider,v=>v.ready);
  const controller=f.start('platform-point-in-time-worker.mjs',{root:f.controller,origin:ready.url,binding:ready.binding,token});await message(controller,v=>v.ready);
  const published=message(provider,v=>v.published);controller.worker.send({capture:true});const durable=await published;
  controller.worker.kill('SIGKILL');await controller.closed;provider.worker.kill('SIGKILL');await provider.closed;
  const observer=new DatabaseSync(join(f.controller,'controller.sqlite'));try{assert.equal(observer.prepare('SELECT count(*) AS n FROM clank_platform_pitr_archives').get().n,0);const pending=observer.prepare("SELECT state,receipt FROM clank_platform_pitr_operations WHERE kind='export'").get();assert.equal(pending.state,'pending');assert.equal(JSON.parse(pending.receipt).binding.generation,3);
    // A real restart must wait for expiry; make the persisted lease genuinely due
    // rather than weakening product admission or substituting a mocked clock.
    observer.prepare('UPDATE clank_platform_pitr_policies SET lease_until=?').run(Date.now()-1);
  }finally{observer.close();}
  const replacementProvider=f.start('point-in-time-provider-worker.mjs',{root:f.provider,token}),replacement=await message(replacementProvider,v=>v.ready);
  const wrote=message(replacementProvider,v=>v.wrote);replacementProvider.worker.send({write:'mutation after controller death'});assert.equal((await wrote).sequence,4);
  const replacementController=f.start('platform-point-in-time-worker.mjs',{root:f.controller,origin:replacement.url,binding:replacement.binding,token});await message(replacementController,v=>v.ready);const captured=message(replacementController,v=>v.captured);replacementController.worker.send({capture:true});const result=await captured;
  assert.equal(result.checkpoint.sequence,3);assert.equal(result.checkpoint.digest,durable.digest);assert.equal(result.archives,1);assert.equal(pointInTimeReceiptCount(f.provider),1);
  t.diagnostic('Two actual controller/provider restarts; retained generation 3; later source sequence 4; one accepted controller checkpoint at the original sequence 3.');
});

test('actual controller SIGKILL after the native archive/receipt commit but before delivery replays one accepted checkpoint',{timeout:30000},async t=>{
  const f=await fixture(t),provider=f.start('point-in-time-provider-worker.mjs',{root:f.provider,token}),ready=await message(provider,v=>v.ready);
  const first=f.start('platform-point-in-time-worker.mjs',{root:f.controller,origin:ready.url,binding:ready.binding,token,holdAcknowledgment:true});await message(first,v=>v.ready);const accepted=message(first,v=>v.accepted);first.worker.send({capture:true});const receipt=await accepted;first.worker.kill('SIGKILL');await first.closed;
  const replacement=f.start('platform-point-in-time-worker.mjs',{root:f.controller,origin:ready.url,binding:ready.binding,token});await message(replacement,v=>v.ready);const captured=message(replacement,v=>v.captured);replacement.worker.send({capture:true});const result=await captured;
  assert.deepEqual(result.checkpoint,receipt.checkpoint);assert.equal(result.archives,1);assert.equal(pointInTimeReceiptCount(f.provider),1);
});
