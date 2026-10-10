import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openMediaCatalog} from './fixtures/media-process-catalog.mjs';
const native=Symbol.for('clank.sqlite.internal'),bytes=value=>Buffer.from(value),input={operationId:'process-operation-01',transform:'uppercase',sourceKey:'source',destinationKey:'output'};

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'clank-media-process-')),ledger=new DatabaseSync(join(root,'actual-provider.sqlite'));
  ledger.exec('CREATE TABLE operations(operation_key TEXT PRIMARY KEY,input_digest TEXT NOT NULL,output TEXT NOT NULL);');let requests=0,loseNext=false;
  const server=createServer(async(request,response)=>{
    if(request.url!=='/transform'||request.method!=='POST'){response.writeHead(404);return response.end();}
    requests++;let body='';for await(const chunk of request)body+=chunk;const value=JSON.parse(body),source=Buffer.from(value.base64,'base64'),digest=createHash('sha256').update(source).digest('hex');
    const previous=ledger.prepare('SELECT * FROM operations WHERE operation_key=?').get(value.operationKey);
    if(previous&&previous.input_digest!==digest){response.writeHead(409);return response.end();}
    if(!previous)ledger.prepare('INSERT INTO operations VALUES(?,?,?)').run(value.operationKey,digest,bytes(source.toString().toUpperCase()).toString('base64'));
    const accepted=ledger.prepare('SELECT output FROM operations WHERE operation_key=?').get(value.operationKey);
    if(loseNext){loseNext=false;return response.destroy();}
    response.setHeader('content-type','application/json');response.end(JSON.stringify({base64:accepted.output}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const provider='http://127.0.0.1:'+server.address().port,instances=[];
  const open=async()=>{const value=await openMediaCatalog(root,provider);instances.push(value);return value;};let app=await open();
  const registered=await app.auth.handle(new Request('http://127.0.0.1:42422/auth/register',{method:'POST',headers:{origin:'http://127.0.0.1:42422','content-type':'application/json'},body:JSON.stringify({email:'native-process-owner@example.test',password:'correct horse battery staple'})}),'/auth');assert.equal(registered.status,201);
  const cookie=registered.headers.get('set-cookie').split(';')[0],caller=app=>app.auth.resolve(new Request('http://127.0.0.1:42422/',{headers:{cookie}})),owner=(await caller(app)).user.id;
  await app.buckets.bucket('media').put('source',bytes('actual provider input'),{userId:owner,contentType:'text/plain'});
  const childProcesses=[];t.after(async()=>{for(const child of childProcesses)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');for(const value of instances)value.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));ledger.close();await rm(root,{recursive:true,force:true});});
  return {root,provider,ledger,app,open,caller,owner,childProcesses,get requests(){return requests;},set loseNext(value){loseNext=value;}};
}

test('actual SIGKILL after bucket and receipt commit reclaims the lease and settles without another provider operation or publication',async t=>{
  const f=await fixture(t),app=f.app,caller=await f.caller(app),bucket=app.buckets.bucket('media');
  await bucket.put('output',bytes('retired destination'),{userId:f.owner,contentType:'text/plain'});
  const queued=app.processing.enqueue(caller,input);app.close();
  const child=fork(new URL('./fixtures/media-processing-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_MEDIA_FIXTURE_ROOT:f.root,CLANK_MEDIA_FIXTURE_PROVIDER:f.provider,CLANK_MEDIA_FIXTURE_HOLD:'after-publish'},stdio:['ignore','pipe','pipe','ipc']});f.childProcesses.push(child);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const publication=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned media worker did not publish: '+output)),15000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned media worker exited before publication: '+output));});});
  assert.equal(publication.kind,'published');assert.equal(publication.operation,queued.id);assert.equal(publication.job,queued.jobId);
  // A response barrier must keep the actual process alive while its parent
  // inspects the committed native receipt, rather than winning an exit race.
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(child.exitCode,null,'The committed worker must remain held until the actual SIGKILL.');
  assert.equal(child.signalCode,null);
  const inspection=new DatabaseSync(join(f.root,'catalog.sqlite'),{readOnly:true});
  // The live native worker can briefly hold a catalog lock while renewing its
  // attempt. Match the catalog's bounded wait before inspecting committed rows.
  inspection.exec('PRAGMA busy_timeout=5000');
  let before,lease;
  try {
    before=inspection.prepare('SELECT result,output_generation FROM clank_media_operations WHERE id=?').get(queued.id);
    lease=inspection.prepare('SELECT lease_until FROM clank_jobs WHERE id=?').get(queued.jobId);
    assert.ok(before.result);assert.ok(before.output_generation);
  } finally { inspection.close(); }
  child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');assert.equal(f.requests,1);assert.equal(ledgerCount(f),1);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(lease.lease_until)-Date.now()+50)));
  const reopened=await f.open(),fresh=await f.caller(reopened);
  // The native queue first reclaims an expired attempt and schedules its normal retry.
  await reopened.processing.workOnce({workerId:'actual-recovery-worker',leaseMs:1000});
  const recovered=reopened.database[native].prepare('SELECT state,run_at FROM clank_jobs WHERE id=?').get(queued.jobId);assert.equal(recovered.state,'retry');
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(recovered.run_at)-Date.now()+30)));
  assert.equal(await reopened.processing.workOnce({workerId:'actual-recovery-worker',leaseMs:1000}),true);
  const accepted=reopened.processing.get(fresh,queued.id);assert.equal(accepted.state,'published');assert.equal(accepted.attempt,2);assert.equal(accepted.outputCurrent,true);assert.equal(f.requests,1);assert.equal(ledgerCount(f),1);
  assert.deepEqual(reopened.database[native].prepare('SELECT result,output_generation FROM clank_media_operations WHERE id=?').get(queued.id),before);
  assert.equal(reopened.database[native].prepare('SELECT state FROM clank_jobs WHERE id=?').get(queued.jobId).state,'succeeded');assert.equal(reopened.processing.enqueue(fresh,input).id,queued.id);assert.equal(reopened.processing.cancel(fresh,queued.id),false);
  assert.equal(Buffer.from((await reopened.buckets.bucket('media').get('output',{userId:f.owner})).bytes).toString(),'ACTUAL PROVIDER INPUT');
  await reopened.buckets.bucket('media').put('output',bytes('later independent output'),{userId:f.owner,contentType:'text/plain'});
  assert.throws(()=>reopened.processing.enqueue(fresh,input),error=>error.code==='MEDIA_DESTINATION_CHANGED');assert.equal(reopened.processing.get(fresh,queued.id).object,null);assert.equal(f.requests,1);
});
function ledgerCount(f){return Number(f.ledger.prepare('SELECT count(*) AS count FROM operations').get().count);}

test('an actually dropped HTTP provider response retries the same operation key and accepts one external transform',async t=>{
  const f=await fixture(t),caller=await f.caller(f.app),queued=f.app.processing.enqueue(caller,input);f.loseNext=true;
  await f.app.processing.workOnce();assert.equal(f.app.processing.get(caller,queued.id).state,'retry');assert.equal(ledgerCount(f),1);assert.equal(f.app.buckets.bucket('media').stat('output',{userId:f.owner}),null);
  const job=f.app.database[native].prepare('SELECT run_at FROM clank_jobs WHERE id=?').get(queued.jobId);await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(job.run_at)-Date.now()+30)));
  await f.app.processing.workOnce();assert.equal(f.app.processing.get(caller,queued.id).state,'published');assert.equal(f.requests,2);assert.equal(ledgerCount(f),1);
  assert.equal(f.ledger.prepare('SELECT operation_key FROM operations').get().operation_key,'clank-media:'+queued.id);
});

test('two actual Node worker processes contend for one queued transform and one provider receipt',async t=>{
  const f=await fixture(t),caller=await f.caller(f.app),queued=f.app.processing.enqueue(caller,input);f.app.close();
  const launches=[0,1].map(()=>{
    const child=fork(new URL('./fixtures/media-processing-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_MEDIA_FIXTURE_ROOT:f.root,CLANK_MEDIA_FIXTURE_PROVIDER:f.provider,CLANK_MEDIA_FIXTURE_WAIT_FOR_START:'1'},stdio:['ignore','pipe','pipe','ipc']});f.childProcesses.push(child);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
    let ready,done;const prepared=new Promise(resolve=>ready=resolve),finished=new Promise((resolve,reject)=>{done=resolve;const timer=setTimeout(()=>reject(new Error('Owned concurrent worker timed out: '+output)),15000);child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Owned worker failed: '+output));});});
    child.on('message',message=>{if(message.kind==='ready')ready();if(message.kind==='finished')done(message.worked);});
    const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));return {child,prepared,finished,exited};
  });
  await Promise.all(launches.map(value=>value.prepared));for(const value of launches)value.child.send({kind:'start'});
  const worked=await Promise.all(launches.map(value=>value.finished));assert.equal(worked.filter(Boolean).length,1);assert.deepEqual(await Promise.all(launches.map(value=>value.exited)),[0,0]);
  const reopened=await f.open(),fresh=await f.caller(reopened);assert.equal(reopened.processing.get(fresh,queued.id).state,'published');assert.equal(f.requests,1);assert.equal(ledgerCount(f),1);
  assert.equal(Number(reopened.database[native].prepare('SELECT count(*) AS count FROM clank_media_operations WHERE result IS NOT NULL').get().count),1);
});
