import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApi,createSyncClient,defineBackend,defineDatabase,defineTable,openBackend} from '../dist/backend.js';
import {defineAuth} from '../dist/auth.js';
import {s} from '../dist/ai.js';
import {defineBucket,openBucketManager,createBucketClient,resolveBucketAttachment} from '../dist/buckets.js';
import {openLocalObjectStore} from '../dist/object-storage.js';
const origin='https://attachments.example',referenceSchema=s.object({bucket:s.string(),key:s.string(),objectId:s.string(),sha256:s.string(),generation:s.string()}),api=createApi();
async function fixture(t,{separate=false,copyManager=false,onAttach}={}){
  const root=await mkdtemp(join(tmpdir(),'clank-attachments-native-')),databasePath=join(root,'app.sqlite'),store=await openLocalObjectStore({directory:join(root,'objects')});
  const manager=await openBucketManager({definitions:[defineBucket({name:'files',ownership:'user',visibility:'private',browserAccess:'authenticated',resumable:true,maxChunkBytes:3,maxObjectBytes:1000,allowedContentTypes:['text/plain']})],store,databasePath:separate?join(root,'catalog.sqlite'):databasePath,stagingDirectory:join(root,'staging'),signingKey:'owned_attachment_signing_credential_0123456789',publicOrigin:origin,capabilityTtlMs:1000});
  let retained, runtime, session, loseMutation=false, loseUpload=false, partial=false, hook;
  t.after(async()=>{runtime?.close();manager.close();await rm(root,{recursive:true,force:true});});
  const definition=defineBackend({schema:defineDatabase({records:defineTable({name:s.string(),attachment:referenceSchema}).owned()}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}})}).functions(({mutation,query})=>({
    attach:mutation({args:{name:s.string(),attachment:referenceSchema,copy:s.optional(s.boolean())},agent:false,handler(context,args){retained=context;resolveBucketAttachment(args.copy?{...context}:context,args.attachment);onAttach?.(databasePath);return context.db.table('records').insert({name:args.name,attachment:args.attachment});}}),
    list:query({args:{},handler:({db})=>db.table('records').collect()}),
  }));
  const options={path:databasePath,buckets:copyManager?{...manager}:manager,offlineMutations:{},agent:false};
  runtime=await openBackend(definition,options);
  async function register(email){const r=await runtime.handle(new Request(origin+'/__clank/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password:'correct horse battery staple'})}));assert.equal(r.status,201);const p=await r.json();return {cookie:r.headers.get('set-cookie').split(';',1)[0],csrf:p.csrfToken,userId:p.user.id};}
  const alice=await register('alice@example.test'),bob=await register('bob@example.test');session=alice;
  const transport=async(url,init={})=>{const r=await runtime.handle(new Request(new URL(url,origin),{...init,headers:{...init.headers,origin,cookie:session.cookie}}));await hook?.(url,r);
    if(loseMutation&&String(url).includes('/mutation/')){loseMutation=false;throw new TypeError('Owned fixture lost mutation acknowledgment after native commit.');}
    if(String(url).includes('/cap/')&&((loseUpload&&r.status===201)||(partial&&r.status===204))){loseUpload=false;partial=false;throw new TypeError('Owned fixture lost upload acknowledgment.');}return r;};
  const client=createSyncClient({url:origin,fetch:transport,auth:{csrfHeader:()=>({'x-clank-csrf':session.csrf})}}),bucket=createBucketClient('files',{fetch:transport,csrfToken:()=>session.csrf});
  const f={root,manager,client,bucket,alice,bob,get runtime(){return runtime;},set session(value){session=value;},set loseMutation(value){loseMutation=value;},set loseUpload(value){loseUpload=value;},set partial(value){partial=value;},set hook(value){hook=value;},
    inspect(work){const db=new DatabaseSync(databasePath);try{return work(db);}finally{db.close();}},async reopen(){runtime.close();runtime=await openBackend(definition,options);},
    reference(object){return {bucket:object.bucket,key:object.key,objectId:object.id,sha256:object.sha256,generation:object.generation};},
    async upload(key='offline-owned'){return bucket.upload({key,value:new Blob(['owned attachment'],{type:'text/plain'}),ifSha256:null});},get retained(){return retained;},
    request(name,attachment,key=Date.now()+'.'+crypto.randomUUID(),extra={}){return client.mutateOnce(api.attach,{name,attachment,...extra},{key,userId:alice.userId});},
  };return f;
}
test('completed private attachment and replay receipt commit once across a lost response and backend restart',async t=>{
  const f=await fixture(t),object=await f.upload(),attachment=f.reference(object),key=Date.now()+'.'+crypto.randomUUID();assert.ok(object.generation);f.loseMutation=true;
  await assert.rejects(f.request('Known attachment',attachment,key),/lost mutation/);assert.equal((await f.client.query(api.list)).length,1);
  await f.reopen();const id=await f.request('Known attachment',attachment,key);const rows=await f.client.query(api.list);assert.equal(rows.length,1);assert.equal(rows[0]._id,id);assert.deepEqual(rows[0].attachment,attachment);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) AS n FROM clank_mutation_receipts').get().n),1);
  await assert.rejects(f.request('Changed input',attachment,key),e=>e.code==='MUTATION_KEY_REUSED');
});
test('foreign ownership, altered object identity/digest and an identical-byte rewrite cannot attach',async t=>{
  const f=await fixture(t),object=await f.upload(),reference=f.reference(object);
  for(const wrong of [{...reference,objectId:'another_object'},{...reference,sha256:'0'.repeat(64)},{...reference,generation:'another_generation'}])await assert.rejects(f.request('Wrong attachment',wrong),e=>e.code==='ATTACHMENT_CHANGED');
  f.session=f.bob;await assert.rejects(f.client.mutateOnce(api.attach,{name:'Foreign owner',attachment:reference},{key:Date.now()+'.'+crypto.randomUUID(),userId:f.bob.userId}),e=>e.code==='ATTACHMENT_CHANGED');f.session=f.alice;
  const rewritten=await f.manager.bucket('files').put(object.key,new TextEncoder().encode('owned attachment'),{userId:f.alice.userId,contentType:'text/plain'});assert.equal(rewritten.sha256,object.sha256);assert.notEqual(rewritten.generation,object.generation);
  await assert.rejects(f.request('Stale generation',reference),e=>e.code==='ATTACHMENT_CHANGED');assert.equal((await f.client.query(api.list)).length,0);
});
test('copied and retained mutation contexts have no attachment capability',async t=>{
  const f=await fixture(t),reference=f.reference(await f.upload());await assert.rejects(f.request('Copied context',reference,undefined,{copy:true}),e=>e.code==='ATTACHMENT_CONTEXT_REQUIRED');
  await f.request('Live context',reference);assert.throws(()=>resolveBucketAttachment(f.retained,reference),e=>e.code==='ATTACHMENT_CONTEXT_REQUIRED');assert.equal((await f.client.query(api.list)).length,1);
});
for(const variant of ['separate','copyManager'])test(`attachment rejects ${variant} native catalog capability`,async t=>{
  const f=await fixture(t,{[variant]:true}),reference=f.reference(await f.upload());await assert.rejects(f.request('Unsupported boundary',reference),e=>e.code===(variant==='separate'?'ATTACHMENT_CATALOG_REQUIRED':'ATTACHMENT_CONTEXT_REQUIRED'));assert.equal((await f.client.query(api.list)).length,0);
});
test('ignored native receipt insert rolls back the attachment record before any acknowledgment',async t=>{
  const f=await fixture(t),reference=f.reference(await f.upload()),key=Date.now()+'.'+crypto.randomUUID();f.inspect(db=>db.exec('CREATE TRIGGER owned_ignore_receipt BEFORE INSERT ON clank_mutation_receipts BEGIN SELECT RAISE(IGNORE); END'));
  await assert.rejects(f.request('Ignored receipt',reference,key),e=>e.code==='MUTATION_RECEIPT_FAILED');assert.equal((await f.client.query(api.list)).length,0);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) AS n FROM clank_mutation_receipts').get().n),0);
  f.inspect(db=>db.exec('DROP TRIGGER owned_ignore_receipt'));await f.request('Ignored receipt',reference,key);assert.equal((await f.client.query(api.list)).length,1);
});
test('a native trigger altering a newly inserted receipt also rolls back the attachment',async t=>{
  const f=await fixture(t),reference=f.reference(await f.upload()),key=Date.now()+'.'+crypto.randomUUID();f.inspect(db=>db.exec("CREATE TRIGGER owned_alter_receipt AFTER INSERT ON clank_mutation_receipts BEGIN UPDATE clank_mutation_receipts SET expires=0 WHERE owner=NEW.owner AND key=NEW.key; END"));
  await assert.rejects(f.request('Altered receipt',reference,key),e=>e.code==='MUTATION_RECEIPT_FAILED');assert.equal((await f.client.query(api.list)).length,0);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) AS n FROM clank_mutation_receipts').get().n),0);
});
test('lost final upload response reconciles the same completed key without replacing its generation',async t=>{
  const f=await fixture(t);f.loseUpload=true;await assert.rejects(f.upload(),/lost upload/);const object=await f.bucket.stat('offline-owned');assert.ok(object);
  await assert.rejects(f.upload(),e=>e.code==='BUCKET_OBJECT_EXISTS');assert.equal((await f.bucket.stat(object.key)).generation,object.generation);await f.request('Reconciled upload',f.reference(object));assert.equal((await f.client.query(api.list)).length,1);
});
test('a partial upload remains unpublished and cannot attach; the same key can restart after native expiry',async t=>{
  const f=await fixture(t);f.partial=true;await assert.rejects(f.upload(),/lost upload/);assert.equal(await f.bucket.stat('offline-owned'),null);assert.equal((await f.client.query(api.list)).length,0);
  await new Promise(resolve=>setTimeout(resolve,1100));await f.manager.sweep();const object=await f.upload();await f.request('Completed retry',f.reference(object));assert.equal((await f.client.query(api.list)).length,1);assert.equal(f.manager.bucket('files').list({userId:f.alice.userId}).objects.length,1);
});
test('current account assertion stops further chunks after an actual first chunk; revoked sessions cannot attach completed bytes',async t=>{
  const f=await fixture(t);let current=f.alice.userId,chunks=0;f.hook=async(url,r)=>{if(String(url).includes('/cap/')){chunks++;if(r.status===204)current=f.bob.userId;}};
  await assert.rejects(f.bucket.upload({key:'guarded-upload',value:new Blob(['multiple chunks'],{type:'text/plain'}),ifSha256:null,assertCurrent(){if(current!==f.alice.userId)throw new Error('Owned account changed.');}}),/account changed/);assert.equal(chunks,1);assert.equal(await f.bucket.stat('guarded-upload'),null);
  f.hook=undefined;const object=await f.upload();const r=await f.runtime.handle(new Request(origin+'/__clank/auth/logout',{method:'POST',headers:{origin,cookie:f.alice.cookie,'x-clank-csrf':f.alice.csrf,'content-type':'application/json'},body:'{}'}));assert.equal(r.status,200);
  await assert.rejects(f.request('Revoked session',f.reference(object)),e=>e.code==='OFFLINE_ACCOUNT_CHANGED');assert.equal(f.inspect(db=>db.prepare('SELECT count(*) AS n FROM clank_mutation_receipts').get().n),0);
});
test('an expired native upload capability leaves no completed object or attachment',async t=>{
  const f=await fixture(t);let chunks=0;f.hook=async(url,response)=>{if(String(url).includes('/cap/')){chunks++;if(chunks===1&&response.status===204)await new Promise(resolve=>setTimeout(resolve,1100));}};
  await assert.rejects(f.upload('expired-upload'),error=>error.code==='INVALID_CAPABILITY');assert.equal(chunks,2);assert.equal(await f.bucket.stat('expired-upload'),null);assert.equal((await f.client.query(api.list)).length,0);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) AS n FROM clank_mutation_receipts').get().n),0);
});
test('native SQLite writer locking preserves the checked object through application attachment commit',async t=>{
  let blocked=0;const f=await fixture(t,{onAttach(databasePath){const contender=new DatabaseSync(databasePath);try{contender.exec('PRAGMA busy_timeout=0');assert.throws(()=>contender.prepare('DELETE FROM clank_bucket_objects').run(),/locked/u);blocked++;}finally{contender.close();}}});
  const object=await f.upload();await f.request('Atomic native attachment',f.reference(object));assert.equal(blocked,1);assert.equal((await f.client.query(api.list)).length,1);assert.equal((await f.bucket.stat(object.key)).generation,object.generation);
});
