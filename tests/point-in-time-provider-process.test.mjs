import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {s} from '../dist/ai.js';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {restorePointInTimeArchive} from '../dist/point-in-time.js';
const token='owned_native_provider_credential_0123456789';
function message(worker,predicate){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>done(new Error('Owned native provider IPC deadline.')),10000),receive=value=>{if(value.failed)done(new Error(value.failed));else if(predicate(value))done(null,value);},exit=()=>done(new Error('Owned provider exited before its native barrier.'));
  function done(error,value){clearTimeout(timer);worker.off('message',receive);worker.off('exit',exit);error?reject(error):resolve(value);}
  worker.on('message',receive);worker.once('exit',exit);
});}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'clank-pitr-provider-proof-')),node=join(root,'node');await mkdir(node);t.after(()=>rm(root,{recursive:true,force:true}));return {root,node};}
async function start(t,f){
  const worker=fork(new URL('./fixtures/point-in-time-provider-worker.mjs',import.meta.url),[JSON.stringify({root:f.node,token})],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';worker.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-4096));const closed=new Promise(resolve=>worker.once('close',resolve));
  t.after(async()=>{if(worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGKILL');await closed;}});
  let ready;try{ready=await message(worker,value=>value.ready);}catch(error){throw new Error(error.message+' '+stderr);}
  return {...ready,worker,closed};
}
function headers(source,operationId,extra={}){return {authorization:'Bearer '+token,'x-clank-project-id':source.binding.projectId,'x-clank-node-id':source.binding.nodeId,'x-clank-release-id':source.binding.releaseId,'x-clank-runtime-generation':String(source.binding.generation),'x-clank-recovery-operation-id':operationId,...extra};}
const checkpoint=(source,operationId,extra)=>fetch(source.url+'/__clank/pitr/checkpoint',{headers:headers(source,operationId,extra),signal:AbortSignal.timeout(10000)});

test('actual SIGKILL after a durable provider checkpoint before HTTP delivery replays one exact encrypted archive after restart and recovers after node loss',async t=>{
  const f=await fixture(t),first=await start(t,f),published=message(first.worker,value=>value.published),pending=checkpoint(first,'remote_exact_01',{'x-owned-fixture-hold':'after-receipt'}).catch(error=>error);
  const native=await published;first.worker.kill('SIGKILL');await first.closed;assert.ok(await pending instanceof Error);
  const second=await start(t,f),wrote=message(second.worker,value=>value.wrote);second.worker.send({write:'later mutation four'});assert.equal((await wrote).sequence,4);
  const response=await checkpoint(second,'remote_exact_01');assert.equal(response.status,200);const archive=await response.json();
  assert.equal(archive.sequence,3);assert.equal(archive.digest,native.digest);assert.equal(createHash('sha256').update(JSON.stringify(archive)).digest('hex'),native.sha256);
  assert.equal((await readdir(join(f.node,'repository','remote-exports'))).length,1);
  await writeFile(join(f.root,'off-node-checkpoint.json'),JSON.stringify(archive),{flag:'wx',mode:0o600});
  second.worker.kill('SIGKILL');await second.closed;await rm(f.node,{recursive:true});
  const scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{
    const target=join(f.root,'separate-project.sqlite'),result=await restorePointInTimeArchive(archive,{encryptionKey:new Uint8Array(32).fill(71),targetPath:target,confirmation:'restore point in time',throughSequence:2,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest,expectedBinding:second.binding});assert.equal(result.sequence,2);
    const database=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:target});try{assert.deepEqual(database.read(db=>db.table('records').collect()).map(row=>row.value),['mutation two']);}finally{database.close();}
  });
  t.diagnostic(JSON.stringify({providerRequests:2,acceptedCheckpoints:1,capturedAtSequence:3,laterSourceSequence:4,restoredSequence:2,sourceNodeRemoved:true}));
});

test('real HTTP provider credentials and exact generation binding reject stale/foreign reads and persisted ownership loss',async t=>{
  const f=await fixture(t),source=await start(t,f);
  for(const [extra,status] of [[{authorization:'Bearer wrong'},401],[{'x-clank-runtime-generation':'2'},404],[{'x-clank-node-id':'another_node'},404],[{'x-clank-project-id':'another_project'},404],[{'x-clank-release-id':'another_release'},404]]){
    const response=await checkpoint(source,'refused_checkpoint',extra);assert.equal(response.status,status);assert.ok(!JSON.stringify(await response.json()).includes('mutation'));
  }
  const deactivated=message(source.worker,value=>value.deactivated);source.worker.send({deactivate:true});await deactivated;
  const response=await checkpoint(source,'after_ownership_loss');assert.equal(response.status,503);assert.equal((await response.json()).error.code,'RECOVERY_UNAVAILABLE');
  await assert.rejects(readdir(join(f.node,'repository','remote-exports')),{code:'ENOENT'});
});

test('a real persisted generation/ownership change during asynchronous checkpoint export prevents the HTTP archive response',async t=>{
  const f=await fixture(t),source=await start(t,f),armed=message(source.worker,value=>value.armed);source.worker.send({armRevocation:true});await armed;
  const response=await checkpoint(source,'revoked_during_export');assert.equal(response.status,503);assert.equal((await response.json()).error.code,'RECOVERY_UNAVAILABLE');
  assert.equal((await checkpoint(source,'retry_after_revocation')).status,503);
});
