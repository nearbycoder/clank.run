import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectIncidentClient} from '../dist/project-incidents.js';

const project='project_exact_01',incident='incident_exact_01';
const ok = value => Response.json({ok:true,...value});

test('incident transport resolves current credentials per request and preserves caller-owned retry identity',async()=>{
  const requests=[];let revision=1;
  const client=createProjectIncidentClient({url:'https://platform.example.test/',headers:()=>({'authorization':`Bearer revision-${revision}`}),auth:{csrfHeader:()=>({'x-clank-csrf':`csrf-${revision}`})},fetch:async(url,options)=>{
    requests.push({url,options});return ok({incident:{id:incident},incidents:[],next:null,detail:{incident:{id:incident}}});
  }});
  const input={expectedVersion:7,operationId:'operation_exact_01',change:{kind:'note',text:'Verified recovery.'}};
  await client.change(project,incident,input);revision++;await client.change(project,incident,input);
  assert.equal(requests[0].options.body,requests[1].options.body);
  assert.equal(requests[1].options.headers.get('authorization'),'Bearer revision-2');assert.equal(requests[1].options.headers.get('x-clank-csrf'),'csrf-2');
  assert.equal(requests[0].options.credentials,'same-origin');assert.equal(requests[0].options.redirect,'error');
  await client.read(project,incident,{afterNotes:25,afterLinks:8});assert.match(requests[2].url,/afterNotes=25&afterLinks=8$/);
  await assert.rejects(client.read('../wrong',incident),/identifier/);assert.equal(requests.length,3);
});

test('incident transport bounds fetch and body reads even when a supplied transport ignores abort',async()=>{
  let signal, cancelled=false;
  const stuckFetch=createProjectIncidentClient({timeoutMs:500,fetch:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  const start=Date.now();await assert.rejects(stuckFetch.list(project),/timed out/);assert.equal(signal.aborted,true);assert.ok(Date.now()-start<1500);
  const stuckBody=createProjectIncidentClient({timeoutMs:500,fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}))});
  await assert.rejects(stuckBody.list(project),/timed out/);assert.equal(cancelled,true);
});

test('incident transport cancels oversized responses without waiting for an uncooperative cancellation',async()=>{
  let cancelled=false,calls=0;
  const client=createProjectIncidentClient({fetch:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;return new Promise(()=>{});}}));}});
  await assert.rejects(client.list(project),/bounded envelope/);assert.equal(cancelled,true);assert.equal(calls,1);
  await assert.rejects(client.create(project,{title:'x'.repeat(17000)}),/bounded envelope/);assert.equal(calls,1);
});

test('incident transport preserves refusal status, rejects invalid envelopes and never retries automatically',async()=>{
  let calls=0;
  const client=createProjectIncidentClient({fetch:async()=>{calls++;return Response.json({ok:false,error:{message:'private source payload'}},{status:403});}});
  await assert.rejects(client.list(project),error=>error.status===403&&!error.message.includes('private'));assert.equal(calls,1);
  const malformed=createProjectIncidentClient({fetch:async()=>new Response('not json')});await assert.rejects(malformed.list(project),/invalid JSON/);
  const redirected=createProjectIncidentClient({fetch:async()=>({redirected:true,body:null})});await assert.rejects(redirected.list(project),/redirected/);
});
