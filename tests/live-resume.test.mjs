import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveReplayStore,applyLiveSplice} from '../dist/live-resume.js';
import {defineBackend,defineDatabase,defineTable,openBackend,createSyncClient,createApi} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
const big={rows:Array.from({length:100},(_,i)=>({id:i,title:'long title '+i}))};
test('scoped replay sends a smaller splice and falls back for missing, expired or evicted snapshots',context=>{
 let at=1000;context.mock.method(Date,'now',()=>at);
 const store=createLiveReplayStore({maxEntries:2,maxAgeMs:1000,maxBytes:20000});
 const before=store.encode('session/query',null,big,1),next=structuredClone(big);next.rows[50].title='changed';
 const delta=store.encode('session/query',before.id,next,2);
 assert.equal(delta.payload.kind,'splice-v1');assert.ok(JSON.stringify(delta.payload).length<JSON.stringify(next).length/10);assert.deepEqual(applyLiveSplice(big,delta.payload.splice),next);
 assert.equal(store.encode('other-session/query',delta.id,next,2).payload.kind,undefined);
 assert.equal(store.encode('session/query',before.id,next,2).payload.kind,undefined,'evicted');
 at+=1001;assert.equal(store.encode('session/query',delta.id,next,2).payload.kind,undefined,'expired');
 store.clear();assert.equal(store.encode('session/query',delta.id,next,2).payload.kind,undefined);
 assert.throws(()=>applyLiveSplice(big,{start:-1,deleteCount:0,insert:''}));assert.throws(()=>applyLiveSplice(big,{start:0,deleteCount:0,insert:'x'.repeat(1000)},50));
});
async function frame(response){const reader=response.body.getReader();const text=new TextDecoder().decode((await reader.read()).value);await reader.cancel();return{id:text.match(/^id: (.+)$/m)[1],payload:JSON.parse(text.match(/^data: (.+)$/m)[1]),bytes:text.length};}
test('real SSE reconnect uses deltas and resets to snapshots after auth invalidation or legacy negotiation',async()=>{
 const definition=defineBackend({schema:defineDatabase({rows:defineTable({text:s.string()})})}).functions(({query,mutation})=>({read:query({args:{filter:s.optional(s.string())},handler:({db})=>db.table('rows').collect()}),write:mutation({args:{text:s.string()},handler:({db},{text})=>{const old=db.table('rows').collect()[0];return old?db.table('rows').patch(old._id,{text}):db.table('rows').insert({text});}})}));
 const backend=await openBackend(definition,{liveResume:{}});
 const request=(id,resume=true,args={})=>new Request('http://localhost/__clank/live/read?args='+encodeURIComponent(JSON.stringify(args))+(resume?'&resume=splice-v1':''),{headers:id?{'last-event-id':id}:{}});
 try{
  backend.mutation('write',{text:'a'.repeat(10000)});const first=await frame(await backend.handle(request()));
  backend.mutation('write',{text:'a'.repeat(9999)+'b'});const next=await frame(await backend.handle(request(first.id)));
  assert.equal(next.payload.kind,'splice-v1');assert.deepEqual(applyLiveSplice(first.payload.value,next.payload.splice),backend.query('read',{}).value);assert.ok(next.bytes<first.bytes/5);
  assert.equal((await frame(await backend.handle(request(next.id,true,{filter:'different'})))).payload.kind,undefined);
  backend.database[SQLITE_INTERNAL].transaction(changes=>changes.record('__auth','user','user'));
  assert.equal((await frame(await backend.handle(request(next.id)))).payload.kind,undefined);
  assert.match((await frame(await backend.handle(request(undefined,false)))).id,/^\d+$/);
 }finally{backend.close()}
});
test('browser client applies deltas and falls back once to snapshots on an unknown base',()=>{
 const sources=[];class Source{constructor(url){this.url=url;sources.push(this)}close(){this.closed=true}}
 const client=createSyncClient({eventSource:Source,liveResume:true}),live=client.live(createApi().list,{});
 sources[0].onmessage({data:JSON.stringify({value:big,version:1}),lastEventId:'first'});
 const store=createLiveReplayStore(),initial=store.encode('scope',null,big,1),changed={...big,extra:'value'},delta=store.encode('scope',initial.id,changed,2);
 sources[0].onmessage({data:JSON.stringify({...delta.payload,baseId:'first'}),lastEventId:'second'});assert.deepEqual(live.data.peek(),changed);
 sources[0].onmessage({data:JSON.stringify({...delta.payload,version:3,baseId:'missing'}),lastEventId:'third'});
 assert.equal(sources[0].closed,true);assert.equal(sources.length,2);assert.doesNotMatch(sources[1].url,/resume=/);
 sources[1].onmessage({data:JSON.stringify({value:changed,version:3}),lastEventId:'3'});assert.equal(live.error.peek(),undefined);assert.equal(live.version.peek(),3);
 live.dispose();assert.equal(sources[1].closed,true);
});
