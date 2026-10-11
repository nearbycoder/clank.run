import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,access,rm,readdir,lstat } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { deploymentRuntimeDigest } from '../dist/runtime-placement.js';
import { openDeploymentProviderService as openV1 } from './fixtures/provider-service-v1-215f594.mjs';
import { fixture,projectId,token,shadow,input,controlRequest,gate } from './fixtures/provider-shadow-service.mjs';
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const absent=path=>assert.rejects(access(path),{code:'ENOENT'});

async function http(t,service) {
 const server=createServer(async(req,res)=>{try{const request=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers:req.headers,...(req.method==='GET'?{}:{body:Readable.toWeb(req),duplex:'half'})});const response=await service.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return async request=>fetch(`http://127.0.0.1:${server.address().port}${new URL(request.url).pathname}`,{method:request.method,headers:request.headers,...(request.body?{body:request.body,duplex:'half'}:{})});
}

test('shadow prepare persists exact checkpoint provenance before native candidate apply and retries the same checkpoint',async t=>{
 let beforeApply;
 const f=await fixture(t,{beforeApply:request=>beforeApply(request)});
 beforeApply=async request=>{
  const record=await json(f.journal);assert.equal(record.protocol,'clank-provider-canary/2');assert.equal(record.current.phase,'preparing');
  assert.equal(record.current.snapshot.sha256,await deploymentRuntimeDigest(request.runtime.databaseSnapshot));
  assert.equal(record.current.snapshot.bytes,request.runtime.databaseSnapshot.byteLength);
  assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/2');
  assert.deepEqual(Object.keys(request.runtime.manifest.environment),[]);assert.equal(request.codeOnly,true);
 };
 await f.primaryValue('before-checkpoint');
 const state=await f.service.canaries.prepare(f.prepare);
 assert.equal(state.protocol,shadow.stateProtocol);assert.equal(state.purpose,'shadow');assert.equal(state.phase,'running');
 assert.equal(state.snapshot.sha256,await deploymentRuntimeDigest(f.events.lastSnapshot.bytes));
 assert.equal(state.snapshot.bytes,f.events.lastSnapshot.bytes.byteLength);assert.ok(state.snapshot.startedAt<=state.snapshot.completedAt);assert.ok(state.snapshot.completedAt<state.expiresAt);
 assert.ok(Object.isFrozen(state.snapshot));assert.notEqual(state.snapshot.sha256,state.capsuleSha256);
 await f.primaryValue('after-checkpoint');
 assert.deepEqual(await f.service.canaries.prepare(f.prepare),state);assert.equal(f.events.snapshots,1);assert.equal(f.events.applies,1);
 const candidate=await f.data.inspect(state.candidateProjectId),sql=new DatabaseSync(join(f.root,'projects',state.candidateProjectId,candidate.databasePath));
 assert.deepEqual(sql.prepare('SELECT id FROM todo ORDER BY id').all().map(row=>row.id),['before-checkpoint']);sql.close();
 await assert.rejects(f.service.canaries.prepare({...f.prepare,purpose:undefined,stateProtocol:undefined}));
 const {purpose,stateProtocol,...ordinary}=f.prepare;await assert.rejects(f.service.canaries.prepare(ordinary),/retry identity/);
 const retired=await f.service.canaries.retire(f.retirement(state,2));assert.equal(retired.phase,'retired');
 assert.deepEqual((await f.service.canaries.inspect(projectId)).snapshot,state.snapshot);await absent(join(f.root,'projects',state.candidateProjectId));
});

test('ordinary canary remains protocol1 after shadow enrollment and disabled reopen never downgrades owner2',async t=>{
 const f=await fixture(t);const state=await f.service.canaries.prepare(f.prepare);await f.service.canaries.retire(f.retirement(state,2));
 const {purpose,stateProtocol,...ordinary}=f.prepare;
 const canary=await f.service.canaries.prepare({...ordinary,operationId:'ordinary_operation_02',controllerEpoch:3});
 assert.equal(canary.protocol,'clank-provider-canary/1');assert.equal(Object.hasOwn(canary,'snapshot'),false);assert.equal(Object.hasOwn(canary,'purpose'),false);
 await f.service.close();const reopened=await f.open({disabled:true});assert.equal(reopened.service.canaries,undefined);
 assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/2');assert.equal((await json(f.journal)).current.phase,'stopped');
});

test('shadow metadata pair is mandatory and captured before a held native snapshot',async t=>{
 let holding=false;const held=gate(),entered=gate();const f=await fixture(t,{snapshot:async snapshot=>{if(holding){entered.resolve();await held.promise;}return snapshot;}});
 for(const pair of [{purpose:'shadow'},{stateProtocol:shadow.stateProtocol},{purpose:'canary',stateProtocol:shadow.stateProtocol},{purpose:'shadow',stateProtocol:'clank-provider-canary/1'}]){
  const {purpose,stateProtocol,...ordinary}=f.prepare;await assert.rejects(f.service.canaries.prepare({...ordinary,...pair}),/explicit/);
 }
 assert.equal(f.events.snapshots,0);assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/1');
 holding=true;const captured={...f.prepare};const pending=f.service.canaries.prepare(captured);await entered.promise;
 delete captured.purpose;delete captured.stateProtocol;captured.operationId='different_operation';held.resolve();
 const state=await pending;assert.equal(state.protocol,shadow.stateProtocol);assert.equal(state.operationId,f.prepare.operationId);
});

test('native authenticated HTTP explicitly returns shadow2 while the actual prior provider rejects the new prepare metadata',async t=>{
 const f=await fixture(t);const send=await http(t,f.service);
 const binding=await (await send(controlRequest('binding'))).json();assert.ok(binding.binding);
 const prepared=await send(controlRequest('prepare',{...f.prepare,primary:binding.binding}));assert.equal(prepared.status,200);const payload=await prepared.json();assert.equal(payload.state.protocol,shadow.stateProtocol);
 assert.equal(payload.state.snapshot.sha256,f.events.lastSnapshot.sha256);
 const inspect=await send(controlRequest('inspect',{primary:binding.binding,operationId:f.prepare.operationId,controllerEpoch:1}));assert.equal(inspect.status,200);assert.equal(Object.hasOwn((await inspect.json()).state,'route'),false);
 const retired=await send(controlRequest('retire',f.retirement(payload.state,2)));assert.equal(retired.status,200);
 await f.service.close();await assert.rejects(f.open({open:openV1}),/owner protocol/);
 const old=await fixture(t,{open:openV1});const oldSend=await http(t,old.service);const oldBinding=await (await oldSend(controlRequest('binding'))).json();
 const refused=await oldSend(controlRequest('prepare',{...old.prepare,primary:oldBinding.binding}));assert.equal(refused.status,503);assert.equal((await refused.json()).error.code,'CANARY_CONTROL_UNCERTAIN');
 assert.equal(old.events.applies,0);assert.equal(old.events.snapshots,0);await absent(old.journal);
});

test('ignored owner enrollment cannot create a shadow intent or checkpoint',async t=>{
 const f=await fixture(t),rename=fsPromises.rename;
 fsPromises.rename=async(from,to)=>{if(to===f.owner)return;return rename(from,to);};syncBuiltinESMExports();
 try{await assert.rejects(f.service.canaries.prepare(f.prepare),/owner persistence/);}finally{fsPromises.rename=rename;syncBuiltinESMExports();}
 assert.equal(f.events.snapshots,0);assert.equal(f.events.applies,0);await absent(f.journal);assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/1');
});

for(const fault of ['ignored','altered'])test(`${fault} snapshot journal persistence prevents native candidate apply`,async t=>{
 const f=await fixture(t),rename=fsPromises.rename;
 fsPromises.rename=async(from,to)=>{
  if(to===f.journal){const row=await json(from);if(row.current.phase==='preparing'&&row.current.snapshot){if(fault==='ignored')return;row.current.snapshot.sha256='0'.repeat(64);await writeFile(from,JSON.stringify(row));}}
  return rename(from,to);
 };syncBuiltinESMExports();
 try{await assert.rejects(f.service.canaries.prepare(f.prepare),/persistence/);}finally{fsPromises.rename=rename;syncBuiltinESMExports();}
 assert.equal(f.events.applies,0);assert.equal(f.events.launches,1);assert.equal((await json(f.journal)).current.phase,'stopped');
});

for(const fault of ['digest','clock'])test(`invalid snapshot ${fault} cannot produce running shadow state`,async t=>{
 let f;
 if(fault==='digest')f=await fixture(t,{snapshot:value=>({...value,sha256:'0'.repeat(64)})});
 else f=await fixture(t,{snapshot:value=>{const before=Date.now;Date.now=()=>before()-10000;t.after(()=>{Date.now=before;});return value;}});
 try{await assert.rejects(f.service.canaries.prepare(f.prepare),/checkpoint|clock/);}finally{if(fault==='clock'){/* Date hook restored by cleanup registered last. */}}
 assert.equal(f.events.applies,0);assert.equal((await json(f.journal)).current.phase,'stopped');
});

for(const corrupt of ['missing-snapshot','wrong-purpose','unknown-key','primary-extra','clock-interval','missing-owner'])test(`retained shadow ${corrupt} refuses restart before cleanup`,async t=>{
 const f=await fixture(t);await f.service.canaries.prepare(f.prepare);await f.service.close();const row=await json(f.journal);
 if(corrupt==='missing-snapshot')delete row.current.snapshot;
 if(corrupt==='wrong-purpose')row.current.purpose='canary';
 if(corrupt==='unknown-key')row.current.snapshot.secret='forbidden';
 if(corrupt==='primary-extra')row.current.primary.untrusted='extra';
 if(corrupt==='clock-interval')row.current.snapshot.completedAt=row.current.snapshot.startedAt-1;
 if(corrupt==='missing-owner')await rm(f.owner);
 await writeFile(f.journal,JSON.stringify(row));
 await assert.rejects(f.open({disabled:true}),/shadow|checkpoint|control request|owner.*missing/u);
 assert.deepEqual(await json(f.journal),row);
});

// Preserve every retained byte; only the native lifetime-lock sidecars may change.
async function retainedFiles(root,prefix='') {
 const files={};
 for(const name of (await readdir(join(root,prefix))).sort()) {
  const relative=prefix?`${prefix}/${name}`:name;
  if(/^service\/\.writer\.sqlite(?:-journal|-wal|-shm)?$/u.test(relative))continue;
  const info=await lstat(join(root,relative));
  if(info.isDirectory())Object.assign(files,await retainedFiles(root,relative));
  else files[relative]=(await readFile(join(root,relative))).toString('base64');
 }
 return files;
}
for(const ordinary of [false,true])test(`missing owner after shadow${ordinary?' then ordinary1':''} refuses without replacing metadata or cleaning state`,async t=>{
 let deletes=0;const f=await fixture(t,{onDelete:()=>{deletes++;}});
 const state=await f.service.canaries.prepare(f.prepare);
 if(ordinary) {
  await f.service.canaries.retire(f.retirement(state,2));
  const {purpose,stateProtocol,...input}=f.prepare;
  await f.service.canaries.prepare({...input,operationId:'ordinary_after_shadow',controllerEpoch:3});
 }
 await f.service.close();await rm(f.owner);
 const before=await retainedFiles(f.root),priorDeletes=deletes;
 await assert.rejects(f.open({disabled:true}),/owner.*missing/u);
 await absent(f.owner);assert.deepEqual(await retainedFiles(f.root),before);assert.equal(deletes,priorDeletes);
});

async function worker(t,f,mode) {
 const filename=join(f.directory,'primary.capsule');await writeFile(filename,f.primaryRuntime.bytes);
 const child=fork(new URL('./fixtures/provider-shadow-worker.mjs',import.meta.url),[f.root,filename,mode],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--disable-warning=ExperimentalWarning']});
 let diagnostic='';child.stdout.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-4000);});child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-4000);});
 const exited=once(child,'exit');let alive=true;child.once('exit',()=>{alive=false;});
 t.after(async()=>{if(alive)child.kill('SIGKILL');await exited;});
 const message=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`Worker startup expired: ${diagnostic}`)),10000);child.once('message',value=>{clearTimeout(timeout);resolve(value);});child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(new Error(`Worker exited before startup: ${diagnostic}`));});});
 return {child,exited,...message,async kill(){child.kill('SIGKILL');const result=await exited;assert.equal(result[1],'SIGKILL');},async close(){child.send('close');await exited;}};
}
const atPhase=(child,phase)=>new Promise(resolve=>{const listen=value=>{if(value.phase===phase){child.off('message',listen);resolve(value);}};child.on('message',listen);});
async function sendTo(url,request){return fetch(url+new URL(request.url).pathname,{method:request.method,headers:request.headers,...(request.body?{body:request.body,duplex:'half'}:{})});}

test('actual SIGKILL after checkpoint persistence: old provider refuses, disabled successor cleans and authenticates exact retirement', {timeout:20000},async t=>{
 const f=await fixture(t);await f.service.close();
 const first=await worker(t,f,'checkpoint');assert.equal(first.phase,'ready');
 const binding=await (await sendTo(first.url,controlRequest('binding'))).json();
 const entered=atPhase(first.child,'checkpoint-held');
 const pending=sendTo(first.url,controlRequest('prepare',{...f.prepare,primary:binding.binding})).catch(error=>error);await entered;
 const before=await json(f.journal);assert.equal(before.protocol,shadow.stateProtocol);assert.ok(before.current.snapshot);assert.equal(before.current.phase,'preparing');
 await first.kill();await pending;
 const old=await worker(t,f,'old');assert.equal(old.phase,'rejected');assert.match(old.message,/owner protocol/);await old.exited;
 const next=await worker(t,f,'recover');assert.equal(next.phase,'ready');
 const stopped=await json(f.journal);assert.equal(stopped.current.phase,'stopped');assert.deepEqual(stopped.current.snapshot,before.current.snapshot);assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/2');
 const receipt=await sendTo(next.url,controlRequest('retire',f.retirement(before.current,2)));assert.equal(receipt.status,200);assert.equal((await receipt.json()).retirement.phase,'retired');
 await absent(join(f.root,'projects',before.current.candidateProjectId));await next.close();
 const reopened=await f.open();assert.equal((await json(f.owner)).protocol,'clank-provider-canary-owner/2');
 await reopened.service.reconcile(input(f.primaryRuntime));
 await assert.rejects(reopened.service.canaries.prepare({...f.prepare,primary:binding.binding}),/binding is stale/);
});

test('actual SIGKILL during shadow prejournal HTTP body preserves unknown-prepare retirement and rejects delayed creation', {timeout:20000},async t=>{
 const {request:nativeRequest}=await import('node:http');const f=await fixture(t);await f.service.close();const first=await worker(t,f,'body');
 const binding=await (await sendTo(first.url,controlRequest('binding'))).json();const request=controlRequest('prepare',{...f.prepare,primary:binding.binding});
 const entered=atPhase(first.child,'body-held');
 const pending=nativeRequest(first.url+new URL(request.url).pathname,{method:'POST',headers:Object.fromEntries(request.headers)});pending.on('error',()=>{});pending.write(f.candidateRuntime.bytes.subarray(0,1));await entered;
 await absent(f.journal);await first.kill();pending.destroy();
 const next=await worker(t,f,'recover');assert.equal(next.phase,'ready');
 const retirement={primary:binding.binding,operationId:f.prepare.operationId,controllerEpoch:1,releaseId:f.candidateRuntime.manifest.releaseId,capsuleSha256:f.candidateRuntime.sha256,retirementEpoch:2};
 const receipt=await sendTo(next.url,controlRequest('retire',retirement));assert.equal(receipt.status,200);const retired=(await receipt.json()).retirement;
 assert.equal(retired.phase,'retired');await absent(join(f.root,'projects',retired.candidateProjectId));await next.close();
 const reopened=await f.open();await reopened.service.reconcile(input(f.primaryRuntime));
 await assert.rejects(reopened.service.canaries.prepare({...f.prepare,primary:binding.binding}),/binding is stale/);assert.equal(reopened.events.applies,0);
});

test('actual prior journal reader rejects retained shadow2 even if its independent owner marker is rolled back',async t=>{
 const f=await fixture(t);await f.service.canaries.prepare(f.prepare);await f.service.close();
 const owner=await json(f.owner);owner.protocol='clank-provider-canary-owner/1';await writeFile(f.owner,JSON.stringify(owner));const before=await readFile(f.journal,'utf8');
 await assert.rejects(f.open({open:openV1}),/journal protocol/);assert.equal(await readFile(f.journal,'utf8'),before);
});

test('real HTTP credential rotation while shadow body is held refuses the old prepare without candidate effects', {timeout:10000},async t=>{
 const {request:nativeRequest}=await import('node:http');const f=await fixture(t);const send=await http(t,f.service);const binding=await (await send(controlRequest('binding'))).json();
 // Use a real native HTTP server and a partial body. Waiting for data intake
 // proves authentication happened before ordinary primary token replacement.
 const entered=gate();const original=f.service.handle;const service={handle:request=>{
  if(new URL(request.url).pathname.endsWith('/prepare')){const reader=request.body.getReader.bind(request.body);request.body.getReader=(...args)=>{entered.resolve();return reader(...args);};}
  return original(request);
 }};
 const server=createServer(async(req,res)=>{const request=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers:req.headers,body:Readable.toWeb(req),duplex:'half'});const result=await service.handle(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const prepared=controlRequest('prepare',{...f.prepare,primary:binding.binding});let result;
 const response=new Promise(resolve=>{result=nativeRequest(`http://127.0.0.1:${server.address().port}${new URL(prepared.url).pathname}`,{method:'POST',headers:Object.fromEntries(prepared.headers)},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});});
 result.on('error',()=>{});result.write(f.candidateRuntime.bytes.subarray(0,1));await entered.promise;
 const rotated=await f.runtime(2,'clankc_rotated-shadow-control-123456789012345678901234567890');await f.service.reconcile(input(rotated));result.end(f.candidateRuntime.bytes.subarray(1));assert.equal(await response,503);
 assert.equal(f.events.applies,0);assert.equal(f.events.snapshots,0);await absent(f.journal);
 assert.equal((await f.service.inspect(projectId)).releaseId,f.candidateRuntime.manifest.releaseId);
});


test('a lower future checkpoint intake bound still reads retained shadow provenance with policy disabled',async t=>{
 const f=await fixture(t),state=await f.service.canaries.prepare(f.prepare);assert.ok(state.snapshot.bytes>1024);await f.service.close();
 const reopened=await f.open({disabled:true,maxDatabaseBytes:1024});assert.equal(reopened.service.canaries,undefined);assert.equal((await json(f.journal)).current.phase,'stopped');assert.deepEqual((await json(f.journal)).current.snapshot,state.snapshot);
});
