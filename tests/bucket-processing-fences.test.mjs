import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {defineBucket,openBucketManager} from '../dist/buckets.js';
import {openLocalObjectStore} from '../dist/object-storage.js';
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7GkAAAAASUVORK5CYII=','base64');
function barrier(){let release;const wait=new Promise(resolve=>release=resolve);return {wait,release};}
async function fixture(t,transformer,wrap=value=>value){
  const root=await mkdtemp(join(tmpdir(),'clank-bucket-transform-fence-')),store=await openLocalObjectStore({directory:join(root,'objects')});
  const manager=await openBucketManager({definitions:[defineBucket({name:'images',ownership:'user',image:{variants:{thumb:{width:1,height:1,format:'png'}}}})],store:wrap(store),databasePath:join(root,'catalog.sqlite'),stagingDirectory:join(root,'staging'),signingKey:'image-processing-fence-private-key-32bytes',imageTransformer:transformer});
  t.after(async()=>{manager.close();await rm(root,{recursive:true,force:true});});const bucket=manager.bucket('images');await bucket.put('original.png',png(),{userId:'original-owner',contentType:'image/png'});return {bucket};
}
for(const operation of ['replace-with-identical-bytes','delete','abort'])test(`immediate image transform fences ${operation} during its actual adapter callback`,async t=>{
  const reached=barrier(),release=barrier(),f=await fixture(t,async()=>{reached.release();await release.wait;return {bytes:png(),contentType:'image/png'};}),controller=new AbortController();
  const pending=f.bucket.transform('original.png','thumb',{userId:'original-owner',signal:controller.signal});await reached.wait;
  if(operation==='replace-with-identical-bytes')await f.bucket.put('original.png',png(),{userId:'original-owner',contentType:'image/png'});
  if(operation==='delete')await f.bucket.delete('original.png',{userId:'original-owner'});
  if(operation==='abort')controller.abort(new Error('Actual abort request'));
  release.release();await assert.rejects(pending);assert.equal(f.bucket.list({userId:'original-owner',prefix:'variants/'}).objects.length,0);
});
test('immediate image transform checks its source inside publication after an actual object-store delay',async t=>{
  const reached=barrier(),release=barrier();let hold=false;const f=await fixture(t,()=>({bytes:png(),contentType:'image/png'}),store=>({...store,async put(key,bytes,options){if(hold){hold=false;reached.release();await release.wait;}return store.put(key,bytes,options);}}));
  hold=true;const pending=f.bucket.transform('original.png','thumb',{userId:'original-owner'});await reached.wait;await f.bucket.put('original.png',png(),{userId:'original-owner',contentType:'image/png'});release.release();
  await assert.rejects(pending,error=>error.code==='BUCKET_OBJECT_CHANGED');assert.equal(f.bucket.list({userId:'original-owner',prefix:'variants/'}).objects.length,0);
});
test('an immediate transform retains the invoking owner when its options are mutated during the adapter',async t=>{
  const reached=barrier(),release=barrier(),f=await fixture(t,async()=>{reached.release();await release.wait;return {bytes:png(),contentType:'image/png'};}),options={userId:'original-owner'};
  const pending=f.bucket.transform('original.png','thumb',options);await reached.wait;options.userId='other-owner';release.release();const result=await pending;assert.equal(result.ownerId,'original-owner');assert.equal(f.bucket.stat(result.key,{userId:'other-owner'}),null);
});
test('bucket reads verify actual bytes even when a provider returns matching native metadata',async t=>{
  const f=await fixture(t,()=>({bytes:png(),contentType:'image/png'}),store=>({...store,async get(key){const value=await store.get(key);if(value){const bytes=new Uint8Array(value.bytes);bytes[bytes.length-1]^=1;return {...value,bytes};}return value;}}));
  await assert.rejects(f.bucket.get('original.png',{userId:'original-owner'}),error=>error.code==='BUCKET_INTEGRITY_FAILED');
});
