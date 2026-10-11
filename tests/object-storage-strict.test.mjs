import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,stat,symlink,mkdir,writeFile} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import * as publicStorage from '../dist/object-storage.js';
import {strictArtifactStore} from '../dist/object-storage-internal.js';
import {openStrictArtifactS3} from './fixtures/strict-artifact-s3.mjs';
const {createS3ObjectStore,openLocalObjectStore,ObjectStoreError}=publicStorage;
const current=()=>{},type='application/vnd.clank.deploy+gzip',key='shadow/project/artifact.gz',bytes=()=>new TextEncoder().encode('exact original artifact');
const hash=value=>createHash('sha256').update(value).digest('hex');
function gate(){let release;const promise=new Promise(resolve=>{release=resolve});return{promise,release}}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'clank-strict-artifact-'));const server=await openStrictArtifactS3(join(root,'remote'));t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true})});const options={endpoint:server.endpoint,region:'test',bucket:'artifacts',pathStyle:true,accessKeyId:'NATIVETESTKEY',secretAccessKey:'native-test-secret-key-123456',timeoutMs:1000,retries:2};return{root,server,options,store:()=>createS3ObjectStore(options)}}
function lease(root){const file=join(root,'lease.sqlite'),owner=new DatabaseSync(file);owner.exec('CREATE TABLE lease(id INTEGER PRIMARY KEY,token TEXT);INSERT INTO lease VALUES(1,\'original\')');const other=new DatabaseSync(file);return{current(){assert.equal(owner.prepare('SELECT token FROM lease WHERE id=1').get()?.token,'original','actual native authority lost')},revoke(){other.exec('DELETE FROM lease')},close(){other.close();owner.close()}}}

test('strict capabilities come only from exact genuine frozen factories and public exports remain unchanged',async t=>{
 const f=await fixture(t),local=await openLocalObjectStore({directory:join(f.root,'local')}),s3=f.store();
 assert.deepEqual(Object.keys(publicStorage).sort(),['ObjectStoreError','createS3ObjectStore','openLocalObjectStore']);
 for(const store of [local,s3]){assert.ok(Object.isFrozen(store));assert.ok(Object.isFrozen(strictArtifactStore(store)));assert.equal(strictArtifactStore({...store}),null);assert.equal(strictArtifactStore(new Proxy(store,{})),null);assert.equal(strictArtifactStore({kind:store.kind,put:store.put,get:store.get,stat:store.stat,delete:store.delete}),null)}
 assert.equal(strictArtifactStore(createS3ObjectStore({...f.options,fetch:globalThis.fetch})),null);
 assert.equal(strictArtifactStore(createS3ObjectStore({...f.options,fetch:async()=>new Response(null,{status:200})})),null);
});
test('genuine S3 strict publication is signed conditional and copies exact bytes with a native clock',async t=>{
 const f=await fixture(t),options={...f.options,now:()=>new Date(0)},store=createS3ObjectStore(options),strict=strictArtifactStore(store),input=bytes(),expected=bytes();
 const pending=strict.put(key,input,type,current);input.fill(0);options.endpoint='http://127.0.0.1:1';const metadata=await pending;
 assert.equal(metadata.sha256,hash(expected));assert.ok(metadata.createdAt>1700000000000);assert.deepEqual((await strict.get(key,current)).bytes,expected);assert.deepEqual(await strict.stat(key,current),metadata);
 const puts=f.server.requests.filter(r=>r.method==='PUT');assert.equal(puts.length,1);assert.equal(puts[0].headers['if-none-match'],'*');assert.match(puts[0].headers.authorization,/SignedHeaders=[^ ]*if-none-match/);assert.ok(!puts[0].headers['x-amz-date'].startsWith('1970'));
 assert.equal(await strict.delete(key,current),true);assert.equal(await strict.delete(key,current),false);assert.equal(await f.server.nativeStore.get(key),null);
});
test('strict S3 never adopts or replaces an existing matching target',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(f.store());await strict.put(key,bytes(),type,current);const before=await f.server.nativeStore.get(key),puts=f.server.requests.filter(r=>r.method==='PUT').length;
 await assert.rejects(strict.put(key,bytes(),type,current),error=>error instanceof ObjectStoreError&&error.code==='OBJECT_STORE_FAILED');assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,puts+1);assert.deepEqual(await f.server.nativeStore.get(key),before);assert.equal(f.server.requests.at(-1).status,412);
});
test('strict PUT has one submission on503 while the ordinary public API retains retries',async t=>{
 const f=await fixture(t),store=f.store(),strict=strictArtifactStore(store);f.server.hooks.before=({record})=>record.method==='PUT'?{status:503}:undefined;
 await assert.rejects(strict.put(key,bytes(),type,current));assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,1);
 const start=f.server.requests.length;await assert.rejects(store.put('ordinary/artifact.gz',bytes(),{contentType:type}));assert.equal(f.server.requests.slice(start).filter(r=>r.method==='PUT').length,3);assert.equal(await f.server.nativeStore.get(key),null);
});
test('a real lost network acknowledgment leaves one PUT and the actual stored artifact',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(f.store());f.server.hooks.after=({response})=>response.destroy();await assert.rejects(strict.put(key,bytes(),type,current),error=>error.code==='OBJECT_STORE_UNAVAILABLE');
 assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,1);assert.equal((await f.server.nativeStore.get(key)).metadata.sha256,hash(bytes()));assert.equal(f.server.requests.filter(r=>r.method==='HEAD').length,0);
});
test('held native PUT response loses actual SQLite authority without a second submission or acknowledgment',async t=>{
 const f=await fixture(t),authority=lease(f.root),entered=gate(),hold=gate(),strict=strictArtifactStore(f.store());t.after(()=>authority.close());t.after(()=>hold.release());
 f.server.hooks.put=async(_key,_bytes,_metadata,commit)=>{entered.release();await hold.promise;return commit()};const pending=strict.put(key,bytes(),type,authority.current);await entered.promise;authority.revoke();hold.release();await assert.rejects(pending,/actual native authority lost/);
 assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,1);assert.equal(f.server.requests.filter(r=>r.method==='HEAD').length,0);assert.ok(await f.server.nativeStore.get(key));
});
test('held native read and delete responses cannot acknowledge after native authority replacement',async t=>{
 for(const operation of ['get','delete']){
  const f=await fixture(t),authority=lease(f.root),strict=strictArtifactStore(f.store());t.after(()=>authority.close());await strict.put(key,bytes(),type,authority.current);const entered=gate(),hold=gate();t.after(()=>hold.release());
  if(operation==='get')f.server.hooks.get=async(_key,read)=>{entered.release();await hold.promise;return read()};
  else f.server.hooks.delete=async(_key,remove)=>{const result=await remove();entered.release();await hold.promise;return result};
  const pending=strict[operation](key,authority.current);await entered.promise;authority.revoke();hold.release();await assert.rejects(pending,/actual native authority lost/);
  assert.equal(f.server.requests.filter(r=>r.method==='DELETE').length,operation==='delete'?1:0);
 }
});
test('strict idempotent retry rechecks native authority before the next actual HTTP request',async t=>{
 const f=await fixture(t),authority=lease(f.root),strict=strictArtifactStore(f.store());t.after(()=>authority.close());f.server.hooks.before=({record})=>{if(record.method==='HEAD'){authority.revoke();return{status:503}}};await assert.rejects(strict.stat(key,authority.current),/actual native authority lost/);assert.equal(f.server.requests.length,1);
});
test('ambient fake fetch cannot acknowledge native cleanup or hide a retained object',async t=>{
 const f=await fixture(t),original=globalThis.fetch;let fakeCalls=0;globalThis.fetch=async(_url,options)=>{fakeCalls++;return new Response(null,{status:options?.method==='DELETE'?204:404})};
 try{
  const strict=strictArtifactStore(f.store());await strict.put(key,bytes(),type,current);f.server.hooks.delete=async()=>true;
  await assert.rejects(strict.delete(key,current),error=>error instanceof ObjectStoreError&&error.code==='OBJECT_DELETE_UNCERTAIN');assert.ok(await f.server.nativeStore.get(key));assert.equal(f.server.requests.filter(r=>r.method==='DELETE').length,1);assert.equal(fakeCalls,0);
  delete f.server.hooks.delete;assert.equal(await strict.delete(key,current),true);assert.equal(await f.server.nativeStore.get(key),null);assert.equal(fakeCalls,0);
 }finally{globalThis.fetch=original}
});
test('strict local publication is exclusive, durable and private with exact retained bytes',async t=>{
 const f=await fixture(t),root=join(f.root,'nested','new','local'),strict=strictArtifactStore(await openLocalObjectStore({directory:root}));
 const metadata=await strict.put(key,bytes(),type,current),digest=hash(key),file=join(root,'objects',digest.slice(0,2),digest+'.object'),before=await readFile(file);
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(file)).nlink,1);assert.deepEqual((await strict.get(key,current)).bytes,bytes());assert.deepEqual(await strict.stat(key,current),metadata);
 await assert.rejects(strict.put(key,bytes(),type,current),error=>error.code==='EEXIST');assert.deepEqual(await readFile(file),before);assert.deepEqual(await readdir(join(root,'objects',digest.slice(0,2))),[digest+'.object']);
 assert.equal(await strict.delete(key,current),true);assert.equal(await strict.delete(key,current),false);assert.equal(await strict.get(key,current),null);
});
test('strict local publication cannot continue after native lease loss at an awaited file creation',async t=>{
 const f=await fixture(t),root=join(f.root,'local'),authority=lease(f.root),strict=strictArtifactStore(await openLocalObjectStore({directory:root})),digest=hash(key),shard=join(root,'objects',digest.slice(0,2)),target=join(shard,digest+'.object');t.after(()=>authority.close());let revoked=false;
 const current=()=>{if(!revoked&&existsSync(shard)&&readdirSync(shard).some(name=>name.endsWith('.tmp'))){revoked=true;authority.revoke()}authority.current()};
 await assert.rejects(strict.put(key,bytes(),type,current),/actual native authority lost/);assert.equal(revoked,true);assert.equal(existsSync(target),false);assert.deepEqual(await readdir(shard),[]);
});
test('strict local reads refuse a symbolic shard without following its target',async t=>{
 const f=await fixture(t),root=join(f.root,'local'),strict=strictArtifactStore(await openLocalObjectStore({directory:root})),outside=join(f.root,'outside'),shard=hash(key).slice(0,2);await mkdir(outside);await symlink(outside,join(root,'objects',shard));await assert.rejects(strict.get(key,current),error=>error.code==='UNSAFE_LOCAL_OBJECT');assert.deepEqual(await readdir(outside),[]);
});
test('retained strict reads and cleanup remain possible after lower local and S3 intake limits',async t=>{
 const f=await fixture(t),root=join(f.root,'local');
 for(const make of [limit=>openLocalObjectStore({directory:root,maxObjectBytes:limit}),limit=>createS3ObjectStore({...f.options,maxObjectBytes:limit})]){
  const high=strictArtifactStore(await make(1024));await high.put(key,bytes(),type,current);const lower=strictArtifactStore(await make(1));assert.equal((await lower.get(key,current)).metadata.size,bytes().length);assert.equal((await lower.stat(key,current)).size,bytes().length);await assert.rejects(lower.put('new/artifact.gz',bytes(),type,current),error=>error.code==='OBJECT_TOO_LARGE');assert.equal(await lower.delete(key,current),true);
 }
});
test('strict dynamically supplied async or truthy authority is refused before HTTP effects',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(f.store());for(const invalid of [()=>true,async()=>{throw new Error('not synchronous')}])await assert.rejects(strict.put(key,bytes(),type,invalid),/synchronously return undefined/);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.server.requests.length,0);
});

test('strict native PUT timeout remains one uncertain submission even when the server later commits',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(createS3ObjectStore({...f.options,timeoutMs:100,retries:3})),entered=gate(),hold=gate();
 f.server.hooks.put=async(_key,_bytes,_metadata,commit)=>{entered.release();await hold.promise;return commit()};
 const pending=strict.put(key,bytes(),type,current);await entered.promise;await assert.rejects(pending,error=>error.code==='OBJECT_STORE_TIMEOUT');assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,1);
 hold.release();let stored;for(let n=0;n<100;n++){stored=await f.server.nativeStore.get(key);if(stored)break;await new Promise(resolve=>setTimeout(resolve,5))}assert.ok(stored);assert.equal(stored.metadata.sha256,hash(bytes()));assert.equal(f.server.requests.filter(r=>r.method==='PUT').length,1);
});
test('strict native transport refuses redirects and bounds actual provider error bodies',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(createS3ObjectStore({...f.options,maxErrorBytes:256}));
 f.server.hooks.before=()=>({status:307,headers:{location:f.server.endpoint+'/artifacts/replacement'}});await assert.rejects(strict.put(key,bytes(),type,current),error=>error.code==='OBJECT_STORE_FAILED');assert.equal(f.server.requests.length,1);
 f.server.hooks.before=()=>({status:503,body:'x'.repeat(257)});await assert.rejects(strict.put(key,bytes(),type,current),error=>error.code==='OBJECT_TOO_LARGE');assert.equal(f.server.requests.length,2);
});
test('strict native response deadline includes an incomplete actual GET body',async t=>{
 const f=await fixture(t),strict=strictArtifactStore(createS3ObjectStore({...f.options,timeoutMs:100,retries:0})),metadata=await strict.put(key,bytes(),type,current),hold=gate();
 f.server.hooks.before=async({record,response})=>{
  if(record.method!=='GET')return;
  response.writeHead(200,{'content-length':metadata.size,'content-type':metadata.contentType,'x-amz-meta-clank-sha256':metadata.sha256,'x-amz-meta-clank-created-at':String(metadata.createdAt),'x-amz-meta-clank-updated-at':String(metadata.updatedAt)});response.write(bytes().subarray(0,2));await hold.promise;return'destroy';
 };
 try{await assert.rejects(strict.get(key,current),error=>error.code==='OBJECT_STORE_TIMEOUT');assert.equal(f.server.requests.filter(r=>r.method==='GET').length,1)}finally{hold.release()}
});

// Deterministic UUID collision injection tests ownership of a real native file;
// it is not a claim of resistance to process-level tampering.
test('strict local failed exclusive creation preserves the preexisting temporary name',async t=>{
 const f=await fixture(t),root=join(f.root,'local'),strict=strictArtifactStore(await openLocalObjectStore({directory:root})),digest=hash(key),shard=join(root,'objects',digest.slice(0,2)),uuid='e1881978-138e-4bd6-a8e2-f7ca43c6ee03',temporary=join(shard,digest+'.object.'+uuid+'.tmp'),original=crypto.randomUUID;
 await mkdir(shard,{mode:0o700});await writeFile(temporary,'existing unrelated temporary bytes',{mode:0o600});
 try{crypto.randomUUID=()=>uuid;await assert.rejects(strict.put(key,bytes(),type,current),error=>error.code==='EEXIST');assert.equal(existsSync(temporary),true,'failed exclusive open must preserve a file it did not create');assert.equal(await readFile(temporary,'utf8'),'existing unrelated temporary bytes');assert.equal(existsSync(join(shard,digest+'.object')),false)}finally{crypto.randomUUID=original}
});
