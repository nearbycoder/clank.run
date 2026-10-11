import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fixture as platformFixture} from './fixtures/platform-environment-fixture.mjs';
import {createProjectIncidentClient} from '../dist/project-incidents.js';

const project='project_exact_01',incident='incident_exact_01';
const receipt=(version=1)=>({id:incident,projectId:project,sequence:1,title:'Recovery',severity:'critical',state:'open',ownerId:null,version,createdAt:1000,updatedAt:1000,resolvedAt:null,resolution:null,noteCount:1,linkCount:0});
const ok = value => Response.json({ok:true,...value});

test('incident transport resolves current credentials per request and preserves caller-owned retry identity',async()=>{
  const requests=[];let revision=1;
  const client=createProjectIncidentClient({url:'https://platform.example.test/',headers:()=>({'authorization':`Bearer revision-${revision}`}),auth:{csrfHeader:()=>({'x-clank-csrf':`csrf-${revision}`})},fetch:async(url,options)=>{
    requests.push({url,options});return ok({incident:receipt(8)});
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

async function host(t,reply){const calls=[],errors=[],server=createServer(async(request,response)=>{try{let raw='';for await(const part of request)raw+=part;const call={method:request.method,url:request.url,raw};calls.push(call);const value=await reply(call);response.writeHead(200,{'content-type':'application/json'});response.end(typeof value==='string'?value:JSON.stringify(value));}catch(error){errors.push(error);response.writeHead(500);response.end('{}')}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});assert.deepEqual(errors,[])});return{origin:'http://127.0.0.1:'+server.address().port,calls}}

for(const kind of ['create','change'])for(const mode of ['malformed','missing','project','id','version','echo','shape'])test('native HTTP incident client rejects '+kind+' '+mode+' acknowledgment without retry',async t=>{
 const input=kind==='create'?{title:'Recovery',severity:'critical',ownerId:null,operationId:'incident_client_create_01'}:{expectedVersion:1,operationId:'incident_client_change_01',change:{kind:'assign',ownerId:'actor_exact_01'}};
 let value={...receipt(kind==='create'?1:2),noteCount:kind==='create'?0:1,ownerId:kind==='create'?null:'actor_exact_01'};
 if(mode==='project')value.projectId='foreign_project_01';if(mode==='id')value.id=kind==='create'?'invalid!':'foreign_incident_01';if(mode==='version')value.version=99;if(mode==='echo')value.ownerId='different_actor_01';if(mode==='shape')delete value.createdAt;
 const server=await host(t,()=>mode==='malformed'?'{':mode==='missing'?{ok:true}:{ok:true,incident:value}),client=createProjectIncidentClient({url:server.origin});
 await assert.rejects(kind==='create'?client.create(project,input):client.change(project,incident,input),error=>!error.status&&/acknowledgment|invalid JSON/.test(error.message));assert.equal(server.calls.length,1);assert.equal(server.calls[0].raw,JSON.stringify(input));
});
test('native HTTP incident client validates the serialized request despite mutable caller input',async t=>{
 const input={expectedVersion:1,operationId:'incident_client_captured_01',change:{kind:'assign',ownerId:'actor_exact_01'}};let release,enter;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>enter=resolve);
 const server=await host(t,async()=>{enter();await gate;return{ok:true,incident:{...receipt(2),ownerId:'actor_exact_01'}}}),client=createProjectIncidentClient({url:server.origin});t.after(()=>release());
 const work=client.change(project,incident,input);await ready;input.expectedVersion=9;input.change.ownerId='other_actor_01';release();assert.equal((await work).ownerId,'actor_exact_01');assert.equal(JSON.parse(server.calls[0].raw).expectedVersion,1);assert.equal(server.calls.length,1);
});
test('actual native controller receipts validate and historical retries remain exact after later mutations',async t=>{
 const f=await platformFixture(t),origin=await f.serve(),client=createProjectIncidentClient({url:origin,headers:()=>({origin,cookie:f.owner.cookie}),auth:{csrfHeader:()=>({'x-clank-csrf':f.owner.csrf})}}),projectId=f.development.id;
 const input={title:'  Native receipt title  ',severity:'warning',ownerId:f.owner.user.id,operationId:'incident_native_receipt_create'},created=await client.create(projectId,input);
 const note={expectedVersion:1,operationId:'incident_native_receipt_note',change:{kind:'note',text:'  Native note text  '}},noted=await client.change(projectId,created.id,note);
 const assign={expectedVersion:2,operationId:'incident_native_receipt_assign',change:{kind:'assign',ownerId:null}},assigned=await client.change(projectId,created.id,assign);
 const resolve={expectedVersion:3,operationId:'incident_native_receipt_resolve',change:{kind:'resolve',resolution:'  Native resolution  '}},resolved=await client.change(projectId,created.id,resolve);
 await client.change(projectId,created.id,{expectedVersion:4,operationId:'incident_native_receipt_reopen',change:{kind:'reopen'}});await f.restart();
 assert.deepEqual(await client.create(projectId,input),created);assert.deepEqual(await client.change(projectId,created.id,note),noted);assert.deepEqual(await client.change(projectId,created.id,assign),assigned);assert.deepEqual(await client.change(projectId,created.id,resolve),resolved);
 const current=await client.read(projectId,created.id);assert.equal(current.incident.version,5);assert.equal(current.incident.state,'open');assert.equal(current.notes[0].text,note.change.text);
});
