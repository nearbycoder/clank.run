import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerStatusClient,validateCustomerStatusSnapshot,validateCustomerStatusConfiguration} from '../dist/customer-status.js';
const snapshot={protocol:'clank-customer-status/1',slug:'customer-health',title:'Public service health',description:'',components:[{key:'checkout',label:'Checkout',health:'unknown',observedAt:0,expiresAt:0,complete:false}],updates:[],publishedAt:0};
test('public SDK uses a trusted canonical origin, omits credentials and rejects private fields from the wire',async()=>{
 let seen;const client=createCustomerStatusClient({url:'https://status.example.test',headers:()=>({authorization:'private credential'}),auth:{csrfHeader:()=>({'x-clank-csrf':'private csrf'})},fetch:async(url,options)=>{seen={url,options};return Response.json(snapshot);}});
 assert.deepEqual(await client.publicPage('customer-health'),snapshot);assert.equal(seen.url,'https://status.example.test/api/status/customer-health');assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.headers.has('authorization'),false);assert.equal(seen.options.headers.has('x-clank-csrf'),false);assert.equal(seen.options.redirect,'error');
 assert.throws(()=>createCustomerStatusClient({url:'https://credentials@status.example.test'}));assert.throws(()=>createCustomerStatusClient({url:'http://status.example.test'}));assert.throws(()=>validateCustomerStatusSnapshot({...snapshot,privateIncident:{title:'secret'}}));
 const leaking=createCustomerStatusClient({fetch:async()=>Response.json({...snapshot,tenantId:'secret'})});await assert.rejects(leaking.publicPage('customer-health'),TypeError);
});
test('native mutations preserve exact unknown intents while bounded timeout also handles non-cooperative fetch',async()=>{
 let captured;const input={expectedVersion:1,previewId:'native_preview_01',previewDigest:'a'.repeat(64),operationId:'native_operation_01'},client=createCustomerStatusClient({timeoutMs:100,auth:{csrfHeader:()=>({'x-clank-csrf':'native csrf'})},fetch:async(url,options)=>{captured={url,options};return new Promise(()=>{});}});
 await assert.rejects(client.publish('native_project_01',input),e=>e.code==='STATUS_TIMEOUT');assert.deepEqual(JSON.parse(captured.options.body),input);assert.equal(captured.options.signal.aborted,true);assert.equal(captured.options.credentials,'include');assert.equal(captured.options.headers.get('x-clank-csrf'),'native csrf');
 const overflowing=createCustomerStatusClient({fetch:async()=>new Response(' '.repeat(128*1024+1))});await assert.rejects(overflowing.publicPage('customer-health'),e=>e.code==='STATUS_RESPONSE_BOUND');
 const invalid=createCustomerStatusClient({fetch:async()=>new Response(new Uint8Array([0xff]))});await assert.rejects(invalid.publicPage('customer-health'),TypeError);
});
test('twenty maximum public updates remain within the response limit and epoch retirement has an explicit unknown value',()=>{
 const update={id:'public_update_01',title:'t'.repeat(160),message:'m'.repeat(4000),state:'investigating',components:Array.from({length:20},(_,n)=>'component-'+n+'x'.repeat(33)),publishedAt:0},maximum={...snapshot,components:Array.from({length:20},(_,n)=>({...snapshot.components[0],key:'component-'+n+'x'.repeat(33),label:'l'.repeat(120)})),updates:Array.from({length:20},(_,n)=>({...update,id:'public_update_'+n}))};
 assert.ok(Buffer.byteLength(JSON.stringify(maximum))<128*1024);assert.equal(validateCustomerStatusSnapshot(maximum).updates.length,20);assert.throws(()=>validateCustomerStatusSnapshot({...maximum,updates:[...maximum.updates,update]}));
 assert.throws(()=>validateCustomerStatusConfiguration({slug:'customer-health',title:'Health',description:'',components:[{key:'x',label:'X',source:{kind:'manual',health:'operational',observedAt:4102444800000,expiresAt:4102444801000}}]}));
});
