import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {defineAuth,openAuth} from '../dist/auth.js';
import {defineBucket,openBucketManager,bucketProcessingBinding} from '../dist/buckets.js';
import {openLocalObjectStore} from '../dist/object-storage.js';
import {openMediaProcessing} from '../dist/media-processing.js';

const native=Symbol.for('clank.sqlite.internal'),encode=value=>new TextEncoder().encode(value),decode=value=>new TextDecoder().decode(value);
function barrier(){let release;const wait=new Promise(resolve=>release=resolve);return {wait,release};}
async function fixture(t,changes={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-media-')),path=join(root,'catalog.sqlite');
  const db=await openSQLite(defineDatabase({}),{path,changePollIntervalMs:0}),sql=db[native],auth=await openAuth(defineAuth({password:{cost:1024,maxMemory:4*1024*1024}}),db);
  const request=(path,account,body)=>new Request('http://127.0.0.1:42422'+path,{method:body===undefined?'GET':'POST',headers:{origin:'http://127.0.0.1:42422',...(account?{cookie:account.cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const account=async email=>{const response=await auth.handle(request('/auth/register',null,{email,password:'correct horse battery staple'}),'/auth');assert.equal(response.status,201);const {user}=await response.json();return {user,cookie:response.headers.get('set-cookie').split(';')[0]};};
  const owner=await account('media-owner@example.test'),other=await account('media-other@example.test'),caller=account=>auth.resolve(request('/',account));
  const definition=defineBucket({name:'media',ownership:'user',allowedContentTypes:['text/plain'],maxObjectBytes:4096,maxBytes:16384,maxObjects:20}),local=await openLocalObjectStore({directory:join(root,'objects'),maxObjectBytes:4096});
  const manager=await openBucketManager({definitions:[definition,defineBucket({name:'public-media',ownership:'user',visibility:'public',allowedContentTypes:['text/plain']}),defineBucket({name:'shared-media',ownership:'app',allowedContentTypes:['text/plain']})],store:changes.wrapStore?.(local)??local,databasePath:path,stagingDirectory:join(root,'staging'),signingKey:'media-signing-key-with-32-bytes-minimum'}),bucket=manager.bucket('media');
  const errors=[];let calls=0,clock=Date.now(),allowed=true;
  const transform={name:'uppercase',revision:'1',sourceBucket:'media',destinationBucket:'media',maxInputBytes:4096,maxOutputBytes:4096,
    async handler(input){calls++;input.progress(20);return {bytes:encode(decode(input.source.bytes).toUpperCase()),contentType:'text/plain'};},...changes.transform};
  const options={database:db,buckets:manager,auth,transforms:[transform],policyRevision:1,maxAttempts:1,now:()=>clock,
    authorize(){if(!allowed)throw new Error('Current media policy revoked.');},onError:error=>errors.push(error),...changes.options};
  let controller=await openMediaProcessing(options);const controllers=[controller];
  t.after(async()=>{for(const value of controllers)value.close();auth.close();manager.close();db.close();await rm(root,{recursive:true,force:true});});
  await bucket.put('source',encode('original'),{userId:owner.user.id,contentType:'text/plain'});
  return {root,path,db,sql,auth,manager,bucket,owner,other,caller,transform,options,controller,errors,get calls(){return calls;},get clock(){return clock;},set clock(value){clock=value;},set allowed(value){allowed=value;},async reopen(overrides={}){controller=await openMediaProcessing({...options,...overrides});controllers.push(controller);return controller;}};
}
const input={operationId:'media-operation-01',transform:'uppercase',sourceKey:'source',destinationKey:'output'};

test('native jobs process verified source bytes, persist progress and publish one owner-scoped output with an exact retry receipt',async t=>{
  const f=await fixture(t),owner=await f.caller(f.owner),other=await f.caller(f.other);
  const queued=f.controller.enqueue(owner,input);assert.equal(queued.state,'queued');assert.equal(f.controller.enqueue(owner,input).jobId,queued.jobId);
  assert.equal(f.controller.get(other,queued.id),null);assert.equal(f.controller.cancel(other,queued.id),false);
  assert.throws(()=>f.controller.enqueue(JSON.parse(JSON.stringify(owner)),input),error=>error.code==='MEDIA_AUTH_REQUIRED');
  assert.throws(()=>f.controller.get(JSON.parse(JSON.stringify(owner)),'unknown-operation'),error=>error.code==='MEDIA_AUTH_REQUIRED');
  assert.throws(()=>f.controller.cancel(JSON.parse(JSON.stringify(owner)),'unknown-operation'),error=>error.code==='MEDIA_AUTH_REQUIRED');
  assert.throws(()=>f.controller.enqueue(owner,{...input,destinationKey:'different'}),error=>error.code==='MEDIA_RETRY_CONFLICT');
  assert.equal(await f.controller.workOnce({workerId:'native-media-worker'}),true);
  const result=f.controller.get(owner,queued.id);assert.equal(result.state,'published');assert.equal(result.progress,100);assert.equal(result.attempt,1);assert.equal(result.outputCurrent,true);
  assert.equal(decode((await f.bucket.get('output',{userId:f.owner.user.id})).bytes),'ORIGINAL');assert.equal(f.bucket.stat('output',{userId:f.other.user.id}),null);
  assert.equal(f.controller.enqueue(owner,input).jobId,queued.jobId);assert.equal(f.calls,1);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS count FROM clank_media_operations WHERE result IS NOT NULL').get().count),1);
  const reopened=await f.reopen();assert.equal(reopened.get(owner,queued.id).outputCurrent,true);assert.equal(reopened.enqueue(owner,input).id,queued.id);assert.equal(await reopened.workOnce(),false);
});

for(const change of ['same-byte-replacement','delete','replace-restore','destination-replacement','session-revocation','policy-revocation','cancel','lease-replacement','protocol-change','expiry','controller-close']){
  test(`held actual transform cannot publish after ${change}`,async t=>{
    const reached=barrier(),release=barrier();const f=await fixture(t,{transform:{async handler({source,signal}){reached.release();await release.wait;signal.throwIfAborted();return {bytes:encode(decode(source.bytes).toUpperCase()),contentType:'text/plain'};}}});
    const owner=await f.caller(f.owner),queued=f.controller.enqueue(owner,input),pending=f.controller.workOnce({leaseMs:30_000,workerId:'held-media-worker'});await reached.wait;
    if(change==='same-byte-replacement')await f.bucket.put('source',encode('original'),{userId:f.owner.user.id,contentType:'text/plain'});
    if(change==='delete')await f.bucket.delete('source',{userId:f.owner.user.id});
    if(change==='replace-restore'){await f.bucket.put('source',encode('changed'),{userId:f.owner.user.id,contentType:'text/plain'});await f.bucket.put('source',encode('original'),{userId:f.owner.user.id,contentType:'text/plain'});}
    if(change==='destination-replacement')await f.bucket.put('output',encode('independent output'),{userId:f.owner.user.id,contentType:'text/plain'});
    if(change==='session-revocation')f.auth.revokeUserSessions(f.owner.user.id);
    if(change==='policy-revocation')f.allowed=false;
    if(change==='cancel')assert.equal(f.controller.cancel(owner,queued.id),true);
    if(change==='lease-replacement')f.sql.prepare("UPDATE clank_jobs SET lease_token='another-actual-claim',lease_owner='replacement-worker' WHERE id=?").run(queued.jobId);
    if(change==='protocol-change')f.sql.prepare('UPDATE clank_media_state SET protocol=99 WHERE singleton=1').run();
    if(change==='expiry')f.clock+=24*60*60_000+1;
    if(change==='controller-close')f.controller.close();
    release.release();if(change==='controller-close')await assert.rejects(pending,/Job runtime is closed/);else await pending;
    assert.equal(f.sql.prepare('SELECT result FROM clank_media_operations WHERE id=?').get(queued.id).result,null);
    if(change==='destination-replacement')assert.equal(decode((await f.bucket.get('output',{userId:f.owner.user.id})).bytes),'independent output');
    else assert.equal(f.bucket.stat('output',{userId:f.owner.user.id}),null);
    assert.equal(Number(f.sql.prepare('SELECT count(*) AS count FROM clank_bucket_reservations').get().count),0);
  });
}

test('actual storage delay rechecks source and native cancellation under the metadata and receipt publication lock',async t=>{
  let held=false;const reached=barrier(),release=barrier();
  const f=await fixture(t,{wrapStore:store=>({...store,async put(key,bytes,options){if(held){held=false;reached.release();await release.wait;}return store.put(key,bytes,options);}})});
  const owner=await f.caller(f.owner),queued=f.controller.enqueue(owner,input);held=true;const pending=f.controller.workOnce();await reached.wait;
  assert.equal(f.controller.cancel(owner,queued.id),true);await f.bucket.put('source',encode('later source'),{userId:f.owner.user.id,contentType:'text/plain'});
  release.release();await pending;assert.equal(f.bucket.stat('output',{userId:f.owner.user.id}),null);
  assert.equal(f.sql.prepare('SELECT result FROM clank_media_operations WHERE id=?').get(queued.id).result,null);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS count FROM clank_bucket_reservations').get().count),0);
});

test('two real native controllers claim one durable job and cannot replay over a later output generation',async t=>{
  const f=await fixture(t),owner=await f.caller(f.owner),queued=f.controller.enqueue(owner,input),second=await f.reopen();
  const results=await Promise.all([f.controller.workOnce({workerId:'media-left'}),second.workOnce({workerId:'media-right'})]);assert.equal(results.filter(Boolean).length,1);assert.equal(f.calls,1);
  await f.bucket.put('output',encode('later output'),{userId:f.owner.user.id,contentType:'text/plain'});
  assert.equal(f.controller.get(owner,queued.id).outputCurrent,false);assert.equal(f.controller.get(owner,queued.id).object,null);
  assert.throws(()=>second.enqueue(owner,input),error=>error.code==='MEDIA_DESTINATION_CHANGED');assert.equal(f.calls,1);
});

test('capacity, expiry, progress and unknown protocol refuse new authority without evicting receipts',async t=>{
  const f=await fixture(t,{options:{maxOperations:1,receiptLifetimeMs:1000,maxProgressUpdates:1},transform:{async handler({progress}){progress(40);progress(50);return {bytes:encode('output'),contentType:'text/plain'};}}}),owner=await f.caller(f.owner),queued=f.controller.enqueue(owner,input);
  assert.throws(()=>f.controller.enqueue(owner,{...input,operationId:'another-operation'}),error=>error.code==='MEDIA_CAPACITY');
  await f.controller.workOnce();assert.equal(f.controller.get(owner,queued.id).state,'dead');assert.equal(f.bucket.stat('output',{userId:f.owner.user.id}),null);
  f.clock+=1001;assert.throws(()=>f.controller.enqueue(owner,input),error=>error.code==='MEDIA_EXPIRED');assert.equal(Number(f.sql.prepare('SELECT count(*) AS count FROM clank_media_operations').get().count),1);
  f.sql.prepare('UPDATE clank_media_state SET protocol=99 WHERE singleton=1').run();assert.throws(()=>f.controller.get(owner,queued.id),error=>error.code==='MEDIA_POLICY_CHANGED');await assert.rejects(f.reopen(),error=>error.code==='MEDIA_PROTOCOL');
});

test('actual source and output byte limits refuse admission or publication without a partial receipt',async t=>{
  const source=await fixture(t,{transform:{maxInputBytes:1}}),caller=await source.caller(source.owner);
  assert.throws(()=>source.controller.enqueue(caller,input),error=>error.code==='MEDIA_INPUT_TOO_LARGE');assert.equal(Number(source.sql.prepare('SELECT count(*) AS count FROM clank_jobs').get().count),0);
  const output=await fixture(t,{transform:{maxOutputBytes:1,handler(){return {bytes:encode('too large'),contentType:'text/plain'};}}}),owner=await output.caller(output.owner),queued=output.controller.enqueue(owner,input);
  await output.controller.workOnce();assert.equal(output.controller.get(owner,queued.id).state,'dead');assert.equal(output.bucket.stat('output',{userId:output.owner.user.id}),null);assert.equal(output.sql.prepare('SELECT result FROM clank_media_operations WHERE id=?').get(queued.id).result,null);
});

test('a compatible higher policy revision fences an old controller and a transform already in flight',async t=>{
  const reached=barrier(),release=barrier(),f=await fixture(t,{transform:{async handler(){reached.release();await release.wait;return {bytes:encode('stale output'),contentType:'text/plain'};}}}),owner=await f.caller(f.owner),queued=f.controller.enqueue(owner,input);
  const pending=f.controller.workOnce();await reached.wait;await f.reopen({policyRevision:2});release.release();await pending;
  assert.equal(f.bucket.stat('output',{userId:f.owner.user.id}),null);assert.equal(f.sql.prepare('SELECT result FROM clank_media_operations WHERE id=?').get(queued.id).result,null);
  assert.throws(()=>f.controller.enqueue(owner,{...input,operationId:'retired-controller'}),error=>error.code==='MEDIA_POLICY_CHANGED');
});

test('native bindings reject copied managers, unrelated catalogs, fake auth and private-to-public or cross-owner transforms',async t=>{
  const f=await fixture(t);assert.throws(()=>bucketProcessingBinding({...f.manager}),/native bucket manager/);
  await assert.rejects(openMediaProcessing({...f.options,auth:{...f.auth}}),/native auth/);
  const other=await openSQLite(defineDatabase({}),{path:join(f.root,'other.sqlite'),changePollIntervalMs:0}),otherAuth=await openAuth(f.auth.definition,other);t.after(()=>{otherAuth.close();other.close();});
  await assert.rejects(openMediaProcessing({...f.options,database:other,auth:otherAuth}),/same persistent native catalog/);
  for(const destinationBucket of ['public-media','shared-media'])await assert.rejects(openMediaProcessing({...f.options,transforms:[{...f.transform,destinationBucket}]}),/cannot change ownership or publish private sources publicly/);
  const asynchronous=await f.reopen({policyRevision:2,authorize:async()=>undefined}),owner=await f.caller(f.owner);
  assert.throws(()=>asynchronous.enqueue(owner,input),/synchronously return undefined/);
  assert.equal(Number(f.sql.prepare('SELECT count(*) AS count FROM clank_media_operations').get().count),0);
});
