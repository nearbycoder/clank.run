import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectSloClient} from '../src/project-slo.ts';
const configuration={name:'Checkout',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
test('SLO browser client binds fresh authorization and explicit exact requests to project policy paths',async()=>{
 let credential='first',csrf='first-csrf';const calls=[];
 const client=createProjectSloClient({url:'https://clank.example/',headers:()=>({authorization:credential}),auth:{csrfHeader:()=>({'x-clank-csrf':csrf})},fetch:async(url,request)=>{calls.push({url,request});return Response.json({ok:true,policies:[],assessment:{current:true},policy:{version:2}});}});
 const input={configuration,expectedVersion:1,operationId:'slo_exact_retry_01'};
 await client.change('project_exact_01','policy_exact_01',input);credential='second';csrf='second-csrf';await client.change('project_exact_01','policy_exact_01',input);
 assert.equal(calls[0].url,'https://clank.example/api/projects/project_exact_01/slo-policies/policy_exact_01/change');assert.equal(calls[0].request.body,calls[1].request.body);assert.equal(calls[1].request.headers.get('authorization'),'second');assert.equal(calls[1].request.headers.get('x-clank-csrf'),'second-csrf');assert.equal(calls[0].request.credentials,'same-origin');assert.equal(calls[0].request.redirect,'error');
 assert.deepEqual(await client.list('project_exact_01'),[]);assert.deepEqual(await client.read('project_exact_01','policy_exact_01'),{current:true});
 await assert.rejects(client.read('../other','policy_exact_01'),/identifier/);await assert.rejects(client.create('project_exact_01',{...input,configuration:{...configuration,name:'a'.repeat(20000)}}),/bounded envelope/);
});
test('SLO client actually bounds a fetch or body that ignores cancellation and exposes no raw error payload',async()=>{
 for(const fetch of [()=>new Promise(()=>{}),()=>Promise.resolve(new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}})))]){
  const started=Date.now();await assert.rejects(createProjectSloClient({timeoutMs:500,fetch}).list('project_exact_01'),/timed out/);assert.ok(Date.now()-started<1000);
 }
 await assert.rejects(createProjectSloClient({fetch:async()=>Response.json({ok:false,error:{message:'private account detail'}},{status:403})}).list('project_exact_01'),error=>error.status===403&&!error.message.includes('private'));
});
