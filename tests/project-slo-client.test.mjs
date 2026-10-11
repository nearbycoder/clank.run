import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectSloClient} from '../dist/project-slo.js';
const configuration={name:'Checkout',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
test('SLO browser client binds fresh authorization and explicit exact requests to project policy paths',async()=>{
 let credential='first',csrf='first-csrf';const calls=[];
 const client=createProjectSloClient({url:'https://clank.example/',headers:()=>({authorization:credential}),auth:{csrfHeader:()=>({'x-clank-csrf':csrf})},fetch:async(url,request)=>{calls.push({url,request});return Response.json(request.method==='POST'?{ok:true,policy:{...configuration,id:'policy_exact_01',projectId:'project_exact_01',version:2,createdAt:1000,updatedAt:1000}}:{ok:true,policies:[],assessment:{current:true}});}});
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

// Real native HTTP exercises the bounded client parser; no mocked Response path here.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openProjectSlos} from '../dist/platform-slo.js';
async function nativeServer(t,respond){
 const calls=[],server=createServer(async(request,response)=>{try{const parts=[];for await(const part of request)parts.push(part);const body=Buffer.concat(parts).toString();calls.push({path:request.url,body,headers:request.headers});const result=await respond(body,request);response.writeHead(result.status??200,{'content-type':'application/json'});response.end(typeof result.body==='string'?result.body:JSON.stringify(result.body));}catch(error){response.writeHead(500);response.end('{}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return {calls,url:'http://127.0.0.1:'+server.address().port};
}
const project='project_exact_01',policyId='policy_exact_01';
for(const damage of ['empty','not-ok','missing','project','id','version','configuration','extra-envelope','extra-policy','bad-name','bad-objective','bad-time','malformed'])test('actual HTTP SLO '+damage+' acknowledgement preserves uncertainty with exactly one POST',async t=>{
 const policy={...configuration,id:policyId,projectId:project,version:2,createdAt:2000,updatedAt:1000};let payload={ok:true,policy};
 if(damage==='empty')payload={};else if(damage==='not-ok')payload={ok:false};else if(damage==='missing')payload={ok:true};else if(damage==='project')policy.projectId='project_other_01';else if(damage==='id')policy.id='policy_other_01';else if(damage==='version')policy.version=1;else if(damage==='configuration')policy.name='Another intent';else if(damage==='extra-envelope')payload.private='unrequested';else if(damage==='extra-policy')policy.unexpected=true;else if(damage==='bad-name')policy.name='\u0000';else if(damage==='bad-objective')policy.objective={kind:'request-success',maximumMs:50};else if(damage==='bad-time')policy.updatedAt=1.5;
 const f=await nativeServer(t,()=>({body:damage==='malformed'?'{':payload})),client=createProjectSloClient({url:f.url});
 await assert.rejects(client.change(project,policyId,{configuration,expectedVersion:1,operationId:'slo_http_operation_01'}),error=>error.status===undefined);assert.equal(f.calls.length,1);
});
test('actual HTTP SLO validates the captured serialized input despite mutation during a held response',async t=>{
 let release,arrived;const held=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>arrived=resolve);
 const f=await nativeServer(t,async body=>{const input=JSON.parse(body);arrived();await held;return {body:{ok:true,policy:{...input.configuration,id:policyId,projectId:project,version:2,createdAt:2000,updatedAt:1000}}};});
 const input={configuration:{...configuration,name:'  Kept spaces  ',objective:{kind:'latency',maximumMs:250},burnThreshold:1.25},expectedVersion:1,operationId:'slo_immutable_http_01'},client=createProjectSloClient({url:f.url});
 const before=JSON.stringify(input),pending=client.change(project,policyId,input);await entered;input.configuration.name='Mutated';input.configuration.objective.maximumMs=500;input.expectedVersion=8;release();
 const result=await pending;assert.equal(result.name,'  Kept spaces  ');assert.equal(result.burnThreshold,1.25);assert.equal(result.objective.maximumMs,250);assert.equal(f.calls[0].body,before);assert.equal(f.calls.length,1);
});
test('genuine native controller HTTP receipts retain historical create/change acknowledgments after newer changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-slo-client-')),db=await openSQLite(defineDatabase({}),{path:join(root,'native.sqlite')}),sql=db[Symbol.for('clank.sqlite.internal')];sql.exec('CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)');sql.prepare('INSERT INTO clank_platform_projects VALUES(?,0)').run(project);
 let now=2000;const controller=openProjectSlos(sql,{}, {collecting:false,manual:true,clock:{wall:()=>now,monotonic:()=>0}}),authority={userId:'actor_slo_exact_01',authorize(){},audit(){}};
 t.after(async()=>{controller.close();db.close();await rm(root,{recursive:true,force:true});});
 const f=await nativeServer(t,(body,request)=>{const input=JSON.parse(body),id=request.url.endsWith('/change')?request.url.split('/').at(-2):null;return {status:id?200:201,body:{ok:true,policy:id?controller.change(project,id,authority,input):controller.create(project,authority,input)}};}),client=createProjectSloClient({url:f.url});
 const input={configuration:{...configuration,name:'  Historical policy  ',burnThreshold:1.125},operationId:'slo_create_receipt_01'},created=await client.create(project,input);assert.equal(created.name,input.configuration.name);now=1000;
 const change={configuration:{...input.configuration,enabled:false,objective:{kind:'latency',maximumMs:500}},operationId:'slo_change_receipt_01',expectedVersion:1},changed=await client.change(project,created.id,change);assert.equal(changed.createdAt,2000);assert.equal(changed.updatedAt,1000);
 await client.change(project,created.id,{...change,configuration:{...configuration,name:'Current'},operationId:'slo_current_receipt_01',expectedVersion:2});
 assert.deepEqual(await client.create(project,input),created);assert.deepEqual(await client.change(project,created.id,change),changed);assert.equal(f.calls[0].body,f.calls[3].body);assert.equal(f.calls[1].body,f.calls[4].body);assert.equal(f.calls.length,5);
});
