import test from 'node:test';
import assert from 'node:assert/strict';
import {readRequestBytes,readResponseBytes,readJsonRequest} from '../dist/security.js';
const request = (body,headers={}) => new Request('https://app.example.invalid/',{method:'POST',body,duplex:'half',headers});

test('body readers copy reused views and ignore empty chunks',async()=>{
 const buffer=new Uint8Array(1024*1024);let sent=0;
 const body=new ReadableStream({pull(controller){if(sent===4){controller.close();return;}buffer[0]=++sent;controller.enqueue(buffer.subarray(0,1));controller.enqueue(new Uint8Array());}});
 assert.deepEqual([...await readRequestBytes(request(body),4)],[1,2,3,4]);
});
test('many tiny chunks coalesce correctly across slab boundaries at the exact byte limit',async()=>{
 const count=70000;let at=0;
 const body=new ReadableStream({pull(controller){if(at===count)controller.close();else controller.enqueue(Uint8Array.of(at++%251));}});
 const bytes=await readResponseBytes(new Response(body),count);assert.equal(bytes.length,count);
 for(let i=0;i<count;i++)assert.equal(bytes[i],i%251);
});
test('over-limit streams reject promptly even when producer cancellation never settles',async()=>{
 let canceled=0;
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));},cancel(){canceled++;return new Promise(()=>{});}});
 await assert.rejects(readRequestBytes(request(body),4),error=>error.status===413&&error.code==='PAYLOAD_TOO_LARGE');assert.equal(canceled,1);
});
test('declared oversize bodies reject without waiting for untrusted cancellation',async()=>{
 for(const response of [false,true]){
  let canceled=0;const body=new ReadableStream({cancel(){canceled++;return new Promise(()=>{});}});
  await assert.rejects(response?readResponseBytes(new Response(body,{headers:{'content-length':'10'}}),4):readRequestBytes(request(body,{'content-length':'10'}),4));assert.equal(canceled,1);
 }
});
test('empty bodies, malformed chunks and producer failures release stream locks',async()=>{
 assert.equal((await readRequestBytes(new Request('https://app.example.invalid/'),0)).length,0);
 assert.equal((await readResponseBytes(new Response(),0)).length,0);
 const body=new ReadableStream({start(controller){controller.enqueue('wrong');}});
 await assert.rejects(readResponseBytes(new Response(body),4),/byte chunks/);assert.equal(body.locked,false);
 const failed=new ReadableStream({pull(controller){controller.error(new Error('producer failed'));}});
 await assert.rejects(readResponseBytes(new Response(failed),4),/producer failed/);assert.equal(failed.locked,false);
});
test('JSON parsing still validates UTF-8 and size before parsing untrusted content',async()=>{
 await assert.rejects(readJsonRequest(request(Uint8Array.of(0xff),{'content-type':'application/json'})),error=>error.code==='INVALID_ENCODING');
 assert.deepEqual(await readJsonRequest(request('{"ok":true}',{'content-type':'application/json'})),{ok:true});
 await assert.rejects(readJsonRequest(request('{"ok":true}',{'content-type':'application/json'}),2),error=>error.status===413);
});
