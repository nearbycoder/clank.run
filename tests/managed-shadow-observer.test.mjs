import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {defineDatabase,openSQLite,openDeploymentOrchestrator} from '../dist/index.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {openSupervisorLease} from '../dist/platform-supervisor.js';
import {createManagedIngress} from '../dist/data-plane.js';
import {serve} from '../dist/node.js';
import * as shadow from '../dist/managed-shadow.js';
import {prepareShadowSchema} from './fixtures/shadow-schema.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const testGates=new Set();
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);const item={promise,settled:false,resolve:()=>{item.settled=true;testGates.delete(item);resolve()}};testGates.add(item);return item};
async function until(check,label,ms=10000){const end=performance.now()+ms;while(performance.now()<end){const result=check();if(result)return result;await delay(5)}throw new Error('Timed out: '+label)}
// Keep actual peer cleanup outcomes pending through the capacity inspection.
// Peer request deadlines still run; releasing this gate never fabricates EOF.
function retainNativeCleanup(response,held){
 if(!held||!response.body)return response;
 const body=response.body,cancel=body.cancel.bind(body),getReader=body.getReader.bind(body);
 body.cancel=async(...args)=>{try{return await cancel(...args)}finally{await held.promise}};
 body.getReader=(...args)=>{const reader=getReader(...args),cancel=reader.cancel.bind(reader);reader.cancel=async(...values)=>{try{return await cancel(...values)}finally{await held.promise}};return reader};
 return response;
}
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'clank-shadow-observer-')),path=join(root,'control.sqlite'),leaseMs=options.leaseMs??30000;
 const lease=await openSupervisorLease(path,{configurationId:'shadow-observer',configurationRevision:1,leaseMs,pollIntervalMs:50});assert.equal(lease.acquire(),true);
 const database=await openSQLite(defineDatabase({}),{path}),internal=database[SQLITE_INTERNAL],sql=new DatabaseSync(path),scope=new AsyncLocalStorage(),held=new Map(),events=[],errors=[],gates=[];
 prepareShadowSchema(sql);sql.exec("ALTER TABLE clank_platform_releases ADD COLUMN upload_publication_receipt TEXT;UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2';INSERT INTO clank_platform_projects(id) VALUES('projecttest')");
 lease.enrollProviderShadow();const schema={prepare:query=>internal.prepare(query==='PRAGMA table_list'?'SELECT * FROM pragma_table_list':query)};
 internal.guardWrites(()=>{lease.assertCurrent(schema);scope.getStore()?.()});
 const orchestrator=openDeploymentOrchestrator(database,{distributedLeaseMs:leaseMs});
 const current=project=>{lease.assertCurrent(schema);const cap=held.get(project);assert.ok(cap);assert.ok(internal.prepare('SELECT 1 FROM clank_distributed_leases WHERE resource=? AND owner=? AND token_hash=? AND fence=? AND expires_at>?').get(cap.resource,cap.owner,hashToken(cap.token),cap.fence,Date.now()))};
 const read=(project='projecttest')=>{const row=internal.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(project);if(!row)return null;const record=shadow.readShadowRecord(row,project,hash);assert.equal(sql.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(project).provider_canary_epoch,record.epoch);shadow.assertShadowReplay(internal,project,record,hash);return record};
 const primary=createServer((req,res)=>{if(options.primary)return options.primary(req,res);res.setHeader('content-type','application/json');res.end('primary')});
 const candidate=createServer((req,res)=>{events.push({method:req.method,path:req.url,headers:req.headers});if(options.candidate)return options.candidate(req,res);res.setHeader('content-type','application/json');res.end('candidate')});
 for(const server of[primary,candidate])await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const upstream='http://127.0.0.1:'+primary.address().port,target='http://127.0.0.1:'+candidate.address().port;
 const route=project=>Object.freeze({id:'route_'+project,projectId:project,releaseId:'release_primary',active:true,hosts:Object.freeze([project+'.test']),upstream});
 let admitted=true,callbackDepth=0;
 const authority=project=>{const captured=held.get(project);return()=>{assert.equal(callbackDepth,0,'No native assertion inside any primary observer callback');assert.equal(held.get(project),captured);current(project)}};
 const controller=shadow.createShadowController({read,save:(project,prior,operation,guard)=>{assert.equal(callbackDepth,0);return shadow.saveShadowRecord(internal,project,prior,operation,guard,hash)},
  lock:async(project,work)=>{const cap=await orchestrator.acquireLease('project:'+project,'shadow-'+randomUUID());assert.ok(cap);held.set(project,cap);try{return await work()}finally{await orchestrator.releaseLease(cap);held.delete(project)}},authority,scope:(guard,work)=>scope.run(guard,work),admit(){assert.equal(callbackDepth,0);if(!admitted)throw Object.assign(new Error('Principal revoked'),{code:'SHADOW_AUTHORITY_REVOKED'})},
  begin:(project,operation,guard)=>{shadow.upgradeShadowReportSchema(internal,guard);lease.enrollProviderShadow();return shadow.saveShadowRecord(internal,project,read(project),operation,guard,hash)},
  replay(project,key,guard,bySession=false){return internal.transaction(()=>{guard();const record=read(project),replay=shadow.readShadowReplays(internal,project,hash).find(row=>bySession?row.receipt.identity.sessionId===key:row.receipt.identity.idempotencyKeyDigest===key);guard();return replay?Object.freeze({replay,current:record?.operation.sessionId===replay.receipt.identity.sessionId?record:null,epoch:record?.epoch??0}):null})},
  prepare:async(project,record,change,current)=>{
   current();change(op=>({...op,capsuleSha256:hash('capsule'),primary:{projectId:project,releaseId:'release_primary',generation:1,fence:1,incarnation:randomUUID()},phase:'preparing',updatedAt:Math.max(Date.now(),op.updatedAt)}));
   const snapshot={sha256:hash('checkpoint'),bytes:4096,providerStartedAt:Date.now(),providerCompletedAt:Date.now(),platformObservedAt:Date.now()};
   const request=options.productionRequest?shadow.createShadowCandidateRequest({origin:target,projectId:project,path:'/candidate',token:'private-fixture-token',protocol:'clank-runtime/1',generation:1,readPaths:['/catalog'],methods:['GET','HEAD']}):async(exact,signal,guard)=>{guard();const url=target+'/candidate'+exact.path;const response=await fetch(url,{method:exact.method,headers:{...(exact.accept===null?{}:{accept:exact.accept}),'accept-encoding':'identity','cache-control':'no-store'},signal,redirect:'error'});guard();return response};
   const held=project==='projecttest1'?options.heldPeerCleanup:undefined;
   return{snapshot,observation:Object.freeze({primary:route(project),request:async(...args)=>{try{return retainNativeCleanup(await request(...args),held)}catch(error){if(held)await held.promise;throw error}}})};
  },
  retire:async(project,record,guard)=>{guard();const op=record.operation;return{protocol:'clank-provider-canary-retirement/1',primary:op.primary,operationId:op.operationId,controllerEpoch:op.controllerEpoch,releaseId:op.releaseId,capsuleSha256:op.capsuleSha256,candidateProjectId:shadow.shadowCandidateProjectId(op,hash),retirementEpoch:op.retirementEpoch,phase:'retired'}},onError:error=>errors.push(error)});
 const observer=controller.observer&&{observe(...args){callbackDepth++;try{const tap=controller.observer.observe(...args);if(!tap)return undefined;return{chunk(n){callbackDepth++;try{return tap.chunk(n)}finally{callbackDepth--}},finish(...values){callbackDepth++;try{return tap.finish(...values)}finally{callbackDepth--}}}}finally{callbackDepth--}}};
 const ingress=createManagedIngress({routes:()=>[...held.keys()].map(route),shadow:observer,retries:0});
 const server=await serve(req=>options.handler?options.handler(req,ingress):ingress.handle(req),{port:0,hostname:'127.0.0.1',onError:error=>{errors.push(error);t.diagnostic(String(error.stack))},allowedHosts:['projecttest.test',...Array.from({length:17},(_,i)=>'projecttest'+i+'.test')]});
 const start=async(project='projecttest',policy={})=>{
  if(!sql.prepare('SELECT 1 FROM clank_platform_projects WHERE id=?').get(project))sql.prepare('INSERT INTO clank_platform_projects(id) VALUES(?)').run(project);
  const configured=shadow.normalizeShadowPolicy({revision:1,readPaths:['/catalog'],methods:['GET','HEAD'],maxSamplePercent:100,maxDurationMs:10000,maxAttempts:100,maxConcurrent:4,maxResponseBytes:1024,maxRequestMs:1000,maxReports:2,...options.policy,...policy}),epoch=Number(sql.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(project).provider_canary_epoch)+1,now=Date.now(),sessionId='shadow_'+randomUUID();
  const record=await controller.start(project,{kind:'shadow',sessionId,operationId:'op_'+randomUUID(),idempotencyKeyDigest:hash(sessionId),inputDigest:hash('input'+sessionId),reviewDigest:hash('review'+sessionId),releaseId:'candidate',artifactSha256:hash('artifact'),capsuleSha256:null,controllerEpoch:epoch,retirementEpoch:epoch,primary:null,primaryReleaseId:'release_primary',primaryFence:1,nodeId:'node',origin:target,credentialGeneration:1,policyRevision:configured.revision,policyDigest:hash(JSON.stringify(configured)),policy:shadow.narrowShadowPolicy(configured,{}),maxReports:configured.maxReports,phase:'binding',outcome:null,stopRequested:false,snapshot:null,report:shadow.emptyShadowReport(2),reservations:[],retirement:null,createdAt:now,expiresAt:now+configured.maxDurationMs,updatedAt:now},()=>{});
  await until(()=>read(project)?.operation.phase==='observing','real native observing owner');return record;
 };
 const request=({project='projecttest',path='/catalog',method='GET',headers={},firstByte}={})=>new Promise((resolve,reject)=>{const req=httpRequest(new URL(path,server.url),{method,agent:false,headers:{host:project+'.test',...headers}},res=>{const chunks=[];res.on('data',chunk=>{firstByte?.();firstByte=null;chunks.push(chunk)});res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));res.on('error',reject)});req.on('error',reject);req.end()});
 t.after(async()=>{for(const item of [...testGates,...gates])item.resolve();await controller.close();await server.close();for(const native of[primary,candidate]){native.closeAllConnections();await new Promise(resolve=>native.close(resolve))}orchestrator.close();database.close();sql.close();lease.close();await rm(root,{recursive:true,force:true})});
 return{root,sql,internal,controller,lease,read,start,request,events,errors,url:server.url,gate:()=>{const item=gate();gates.push(item);return item},revoke:()=>{admitted=false},target,route,assertDetached:()=>assert.equal(callbackDepth,0,'Candidate cancellation must not run in a primary callback')};
}
const hashToken=value=>createHash('sha256').update(value).digest('base64url');

test('actual anonymous native GET reserves and settles one detached candidate without changing primary',async t=>{
 // This is a positive metadata-comparison story, not a one-second deadline
 // story. A real delayed candidate also proves that primary delivery remains
 // independent; dedicated deadline tests below retain their short limits.
 const f=await fixture(t,{policy:{maxRequestMs:10000,maxDurationMs:30000},candidate:async(req,res)=>{await delay(1500);res.setHeader('content-type','application/json');res.end('candidate')}});await f.start();assert.deepEqual(await f.request({headers:{accept:'application/json','user-agent':'never-forward'}}),{status:200,body:'primary'});
 await until(()=>f.read().operation.report.counters.settled===1,'one native settlement');
 assert.equal(f.events.length,1);assert.equal(f.events[0].path,'/candidate/catalog');assert.equal(f.events[0].headers.accept,'application/json');assert.notEqual(f.events[0].headers['user-agent'],'never-forward');
 const report=f.read().operation.report;assert.equal(report.counters.reserved,1);assert.equal(report.counters.comparable,1);assert.equal(report.counters.statusClassEqual,1);assert.equal(report.counters.mediaTypeEqual,1);assert.equal(report.counters.bothComplete,1);assert.equal(report.counters.unknown['candidate-timeout'],0);assert.deepEqual(f.read().operation.reservations,[]);
});
test('bodyless native HEAD finishes before handoff but still creates exactly one comparable observation',async t=>{
 const f=await fixture(t);await f.start();assert.deepEqual(await f.request({method:'HEAD'}),{status:200,body:''});await until(()=>f.read().operation.report.counters.settled===1,'HEAD native settlement');assert.equal(f.events.length,1);assert.equal(f.events[0].method,'HEAD');assert.equal(f.read().operation.report.counters.comparable,1);
});

for(const path of ['/outside','/catalog?secret=hidden','/%63atalog'])test('raw request '+path+' never forwards a candidate',async t=>{
 const f=await fixture(t);await f.start();assert.equal((await f.request({path})).body,'primary');await delay(150);assert.equal(f.events.length,0);assert.equal(f.read().operation.report.counters.reserved,0);assert.equal(f.read().operation.report.skips.ineligible,path==='/outside'?1:0);
});
for(const headers of [{cookie:'secret=x'},{authorization:'Bearer secret'},{'x-tenant':'private'}])test('credential or custom header has no observer visibility: '+Object.keys(headers)[0],async t=>{
 const f=await fixture(t);await f.start();assert.equal((await f.request({headers})).body,'primary');await delay(130);assert.equal(f.events.length,0);assert.deepEqual(Object.values(f.read().operation.report.skips),[0,0,0,0,0,0]);
});
for(const status of [204,304])test('actual bodyless '+status+' preserves first completion and handoff',async t=>{
 const response=(req,res)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end()};const f=await fixture(t,{primary:response,candidate:response});await f.start();assert.equal((await f.request()).status,status);await until(()=>f.read().operation.report.counters.settled===1,'bodyless settlement');assert.equal(f.read().operation.report.counters.comparable,1);
});
test('parallel candidates use latest owned native record across intervening skip flushes',async t=>{
 // This case holds two real requests across a native skip flush. Its deadline
 // must allow that setup under concurrent CI load before testing both results.
 const held=gate(),seen=[];const f=await fixture(t,{policy:{maxRequestMs:10000},candidate:async(req,res)=>{seen.push(req.url);await held.promise;res.setHeader('content-type','application/json');res.end('candidate')}});t.after(()=>held.resolve());await f.start();
 assert.deepEqual(await Promise.all([f.request(),f.request()]),[{status:200,body:'primary'},{status:200,body:'primary'}]);await until(()=>seen.length===2,'two independent candidate requests');const floor=f.read().epoch;assert.equal(f.read().operation.report.counters.reserved,2);assert.deepEqual(f.read().operation.reservations,[1,2]);
 await f.request({path:'/ineligible'});await until(()=>f.read().operation.report.skips.ineligible===1,'native coalesced skip flush');assert.ok(f.read().epoch>floor);held.resolve();await until(()=>f.read().operation.report.counters.settled===2,'both concurrent settlements');assert.equal(f.read().operation.report.counters.comparable,2);assert.deepEqual(f.read().operation.reservations,[]);
});
test('a missing actual write/end handoff expires without reservation or candidate request',async t=>{
 const held=gate(),ready=gate();const f=await fixture(t,{policy:{maxRequestMs:100},handler:async(req,ingress)=>{const response=await ingress.handle(req);ready.resolve();await held.promise;return response}});t.after(()=>held.resolve());await f.start();const primary=f.request();await until(()=>ready.settled,'actual primary handoff entry');
 await until(()=>f.read().operation.report.skips['handoff-timeout']===1,'pre-handoff deadline flush');assert.equal(f.read().operation.report.counters.reserved,0);assert.equal(f.events.length,0);held.resolve();assert.equal((await primary).body,'primary');await delay(20);assert.equal(f.events.length,0);
});
for(const kind of ['headers','body'])test('candidate '+kind+' deadline never delays complete primary delivery',{timeout:10000},async t=>{
 // Observe actual admission before checking expiration at the held phase. A
 // short admission deadline can otherwise expire before HTTP reaches this
 // fixture and leave an unconditional seen.promise waiting forever.
 const held=gate(),seen=gate();const f=await fixture(t,{policy:{maxRequestMs:2000},candidate:async(req,res)=>{seen.resolve();if(kind==='body'){res.setHeader('content-type','application/json');res.write('candidate-prefix')}await held.promise;res.end('candidate-suffix')}});t.after(()=>held.resolve());await f.start();assert.deepEqual(await f.request(),{status:200,body:'primary'});await until(()=>seen.settled,'actual candidate '+kind+' admission');await until(()=>f.read().operation.report.counters.settled===1,'candidate timeout settlement');
 assert.equal(f.events.length,1);assert.equal(f.read().operation.report.counters.unknown['candidate-timeout'],1);assert.equal(f.read().operation.report.counters.bothComplete,0);held.resolve();
});
for(const side of ['primary','candidate'])test(side+' overshoot preserves primary bytes and counts incomplete only',async t=>{
 const large='x'.repeat(2048),responder=(req,res)=>{res.setHeader('content-type','application/json');res.end(large)};
 const f=await fixture(t,{[side]:responder});await f.start();const response=await f.request();assert.equal(response.body,side==='primary'?large:'primary');
 if(side==='primary'){await until(()=>f.read().operation.report.skips.withdrawn===1,'pre-reservation oversize withdrawal');assert.equal(f.read().operation.report.counters.reserved,0);assert.equal(f.events.length,0)}
 else{await until(()=>f.read().operation.report.counters.settled===1,'candidate oversize settlement');assert.equal(f.read().operation.report.counters.unknown['candidate-oversized'],1);assert.equal(f.read().operation.report.counters.bothComplete,0)}
});
test('invalid media is unknown after both bounded EOFs, never equal empty metadata',async t=>{
 const f=await fixture(t,{candidate:(req,res)=>res.end('candidate')});await f.start();await f.request();await until(()=>f.read().operation.report.counters.settled===1,'invalid media settlement');const report=f.read().operation.report;assert.equal(report.counters.comparable,0);assert.equal(report.counters.unknown['content-type-invalid'],1);assert.equal(report.counters.bothComplete,1);
});
test('session capacity has no queue and is released after actual candidate completion',async t=>{
 const held=gate();const f=await fixture(t,{policy:{maxConcurrent:1,maxRequestMs:2000},candidate:async(req,res)=>{await held.promise;res.setHeader('content-type','application/json');res.end('candidate')}});t.after(()=>held.resolve());await f.start();await f.request();await until(()=>f.events.length===1,'candidate admitted');await f.request();await until(()=>f.read().operation.report.skips.capacity===1,'capacity skip');assert.equal(f.read().operation.report.counters.reserved,1);held.resolve();await until(()=>f.read().operation.report.counters.settled===1,'candidate completed');await f.request();await until(()=>f.read().operation.report.counters.settled===2,'new request after actual completion');assert.equal(f.events.length,2);
});
for(const fault of ['ignored','altered','lease'])test('native reservation '+fault+' cannot submit a candidate',async t=>{
 const f=await fixture(t);await f.start();const before=f.read();
 const when="WHEN json_extract(NEW.operation,'$.report.counters.reserved')>json_extract(OLD.operation,'$.report.counters.reserved')";
 f.sql.exec(fault==='ignored'?`CREATE TRIGGER fault BEFORE UPDATE OF operation ON clank_platform_provider_canaries ${when} BEGIN SELECT RAISE(IGNORE); END`:fault==='altered'?`CREATE TRIGGER fault AFTER UPDATE OF operation ON clank_platform_provider_canaries ${when} BEGIN UPDATE clank_platform_projects SET provider_canary_epoch=provider_canary_epoch+100; END`:`CREATE TRIGGER fault AFTER UPDATE OF operation ON clank_platform_provider_canaries ${when} BEGIN DELETE FROM clank_distributed_leases; END`);
 assert.equal((await f.request()).body,'primary');await until(()=>f.read().operation.report.skips.withdrawn===1,'rolled-back reservation withdrawal');assert.equal(f.events.length,0);assert.equal(f.read().operation.report.counters.reserved,0);assert.ok(f.read().epoch>=before.epoch);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_distributed_leases').get().n,1);f.sql.exec('DROP TRIGGER fault');
});
for(const point of ['headers','body'])test('native project lease loss at candidate '+point+' leaves the ordinal for successor interruption',async t=>{
 const held=gate(),seen=gate();const f=await fixture(t,{candidate:async(req,res)=>{if(point==='body'){res.setHeader('content-type','application/json');res.write('prefix')}seen.resolve();await held.promise;res.end('candidate')}});t.after(()=>held.resolve());await f.start();await f.request();await until(()=>seen.settled,'actual native candidate admission');const before=f.read();assert.equal(before.operation.report.counters.reserved,1);f.sql.exec('DELETE FROM clank_distributed_leases');held.resolve();await until(()=>f.errors.length>0,'stale native continuation refusal');assert.equal(f.read().operation.report.counters.settled,0);assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.events.length,1);
});
test('initiating authority revocation cancels owned candidate and retires with native cleanup authority',async t=>{
 const held=gate(),seen=gate();const f=await fixture(t,{candidate:async(req,res)=>{seen.resolve();await held.promise;res.setHeader('content-type','application/json');res.end('candidate')}});t.after(()=>held.resolve());await f.start();await f.request();await until(()=>seen.settled,'actual native candidate admission');f.revoke();held.resolve();await until(()=>f.read().operation.phase==='complete','native retirement after initiating revocation');assert.equal(f.read().operation.outcome,'authority-revoked');assert.equal(f.read().operation.report.counters.unknown['authority-lost'],1);assert.equal(f.read().operation.report.counters.comparable,0);assert.equal(f.events.length,1);
});
test('exact stop cancels a held candidate without waiting for or cancelling primary',async t=>{
 const held=gate(),seen=gate();const f=await fixture(t,{policy:{maxRequestMs:2000},candidate:async(req,res)=>{seen.resolve();await held.promise;res.end('late')}});t.after(()=>held.resolve());const initial=await f.start();assert.equal((await f.request()).body,'primary');await until(()=>seen.settled,'actual native candidate admission');await f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{});await until(()=>f.read().operation.phase==='complete','exact stop cleanup');assert.equal(f.read().operation.report.counters.unknown.cancelled,1);assert.equal(f.events.length,1);held.resolve();await delay(20);assert.equal(f.read().operation.report.counters.settled,1);
});

test('sixteen leader-wide slots include all sessions and never queue a seventeenth selected request',async t=>{
 // Use fresh candidate connections so this capacity check does not depend on
 // reusing a socket cancelled after the first batch's native EOF.
 const held=gate();const f=await fixture(t,{policy:{maxConcurrent:16,maxRequestMs:10000,maxDurationMs:30000},candidate:async(req,res)=>{await held.promise;res.setHeader('connection','close');res.setHeader('content-type','application/json');res.end('candidate')}});t.after(()=>held.resolve());await f.start();await f.start('projecttest1');
 const responses=await Promise.all(Array.from({length:16},()=>f.request()));assert.ok(responses.every(value=>value.body==='primary'));await until(()=>f.events.length===16,'all sixteen candidate requests',5000);
 await f.request({project:'projecttest1'});await until(()=>f.read('projecttest1').operation.report.skips.capacity===1,'leader-wide capacity refusal');assert.equal(f.read('projecttest1').operation.report.counters.reserved,0);assert.equal(f.events.length,16);
 held.resolve();await until(()=>f.read().operation.report.counters.settled===16,'all real candidates completed',10000);await f.request({project:'projecttest1'});await until(()=>f.read('projecttest1').operation.report.counters.settled===1,'new owner can use actually released capacity');assert.equal(f.events.length,17);
});
test('the configured native attempt limit retires without a later candidate submission',async t=>{
 const f=await fixture(t,{policy:{maxAttempts:2}});await f.start();await f.request();await until(()=>f.read().operation.report.counters.settled===1,'first attempt');await f.request();await until(()=>f.read().operation.report.counters.settled===2,'second attempt');
 await f.request();await until(()=>f.read().operation.phase==='complete','attempt-limited retirement');assert.equal(f.events.length,2);assert.equal(f.read().operation.outcome,'attempt-limit');assert.equal(f.read().operation.report.counters.reserved,2);assert.equal(f.read().operation.report.counters.settled,2);
});
test('the exact native request mutated after observation never reaches candidate fetch',async t=>{
 const f=await fixture(t,{handler:async(req,ingress)=>{const response=await ingress.handle(req);req.headers.set('cookie','later=secret');return response}});await f.start();assert.equal((await f.request()).body,'primary');await delay(150);assert.equal(f.events.length,0);assert.equal(f.read().operation.report.counters.reserved,0);
});
test('actual separate native SQLite writer observes the primary first byte before releasing reservation contention',async t=>{
 const f=await fixture(t,{policy:{maxRequestMs:2000}});await f.start();
 const script=`const {DatabaseSync}=require('node:sqlite'),http=require('node:http');const sql=new DatabaseSync(process.argv[1]);sql.exec('BEGIN IMMEDIATE');const held=Date.now();const req=http.get(process.argv[2],{headers:{host:'projecttest.test'}},res=>{let first;res.on('data',()=>{if(first)return;first=Date.now();setTimeout(()=>{sql.exec('COMMIT');sql.close();process.send({held,first,released:Date.now()});process.disconnect()},150)});res.resume()});req.on('error',error=>{process.send({error:String(error)});process.exitCode=1;sql.close();process.disconnect()});`;
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','-e',script,join(f.root,'control.sqlite'),new URL('/catalog',f.url).href],{stdio:['ignore','pipe','pipe','ipc']});let output='';child.stderr.on('data',chunk=>output+=chunk);const messages=[];child.on('message',value=>messages.push(value));
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}});
 await until(()=>messages.length||child.exitCode!==null||child.signalCode!==null,'independent native writer/client evidence',5000);assert.ok(messages.length,output);assert.ok(!messages[0].error,JSON.stringify(messages));assert.ok(messages[0].first>=messages[0].held);assert.ok(messages[0].released-messages[0].first>=100);assert.deepEqual(await exited,{code:0,signal:null},output);
 await until(()=>f.read().operation.report.counters.settled===1,'reservation after actual independent native COMMIT');assert.equal(f.events.length,1);t.diagnostic(JSON.stringify(messages[0]));
});
for(const field of ['operation','provider_canary_epoch'])test('altered native settlement '+field+' cannot persist a comparison',async t=>{
 const held=gate(),seen=gate();const f=await fixture(t,{candidate:async(req,res)=>{seen.resolve();await held.promise;res.setHeader('content-type','application/json');res.end('candidate')}});t.after(()=>held.resolve());await f.start();await f.request();await until(()=>seen.settled,'actual native candidate admission');
 f.sql.exec(`CREATE TRIGGER fault AFTER UPDATE OF operation ON clank_platform_provider_canaries WHEN json_extract(NEW.operation,'$.report.counters.comparable')>0 BEGIN ${field==='operation'?"UPDATE clank_platform_provider_canaries SET operation=json_set(operation,'$.report.counters.comparable',0);":"UPDATE clank_platform_projects SET provider_canary_epoch=provider_canary_epoch+1;"} END`);
 held.resolve();await until(()=>f.errors.length>0,'native altered settlement refusal');assert.equal(f.read().operation.report.counters.comparable,0);assert.equal(f.events.length,1);f.sql.exec('DROP TRIGGER fault');
});

for(const kind of ['redirect','encoded'])test('candidate '+kind+' is unknown with one request and no primary fallback',async t=>{
 const f=await fixture(t,{candidate:(req,res)=>{res.setHeader('content-type','application/json');if(kind==='redirect'){res.statusCode=302;res.setHeader('location','/forbidden-target')}else res.setHeader('content-encoding','gzip');res.end('not-comparable')}});await f.start();assert.equal((await f.request()).body,'primary');await until(()=>f.read().operation.report.counters.settled===1,'candidate transport rejection');assert.equal(f.events.length,1);assert.equal(f.read().operation.report.counters.unknown['candidate-error'],1);assert.equal(f.read().operation.report.counters.bothComplete,0);
});
test('equal completed error responses compare transport facts without changing primary status',async t=>{
 const response=(req,res)=>{res.statusCode=503;res.setHeader('content-type','application/json');res.end('service-unavailable')};const f=await fixture(t,{primary:response,candidate:response});await f.start();assert.deepEqual(await f.request(),{status:503,body:'service-unavailable'});await until(()=>f.read().operation.report.counters.settled===1,'completed errors');const report=f.read().operation.report;assert.equal(report.counters.comparable,1);assert.equal(report.counters.statusClassEqual,1);assert.equal(report.counters.mediaTypeEqual,1);assert.equal(f.events.length,1);
});
test('primary overshoot after a committed reservation leaves delivery intact and cannot compare',async t=>{
 const held=gate(),seen=gate(),large='x'.repeat(2048);const f=await fixture(t,{primary:async(req,res)=>{res.setHeader('content-type','application/json');res.write('prefix');await held.promise;res.end(large)},candidate:async(req,res)=>{seen.resolve();await held.promise;res.setHeader('content-type','application/json');res.end('candidate')}});await f.start();const primary=f.request();await until(()=>seen.settled,'actual native candidate admission');assert.equal(f.read().operation.report.counters.reserved,1);held.resolve();assert.equal((await primary).body,'prefix'+large);await until(()=>f.read().operation.report.counters.settled===1,'post-reservation primary overshoot');assert.equal(f.read().operation.report.counters.unknown['primary-oversized'],1);assert.equal(f.read().operation.report.counters.comparable,0);assert.equal(f.read().operation.report.counters.bothComplete,0);
});

test('post-header cancellation beyond the original deadline retains global occupancy and native cleanup obligation',async t=>{
 const body=gate(),cancelEntered=gate(),cancelRelease=gate(),nativeFetch=globalThis.fetch;let pendingCancellation=false,first=true;
 const f=await fixture(t,{productionRequest:true,policy:{maxRequestMs:2000,maxConcurrent:16,maxDurationMs:30000},candidate:async(req,res)=>{res.setHeader('content-type','application/json');res.write('prefix');await body.promise;res.end('suffix')}});
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(...args)=>{
  const response=await nativeFetch(...args);
  if(first&&String(args[0]).startsWith(f.target+'/candidate/')){
   first=false;const cancel=response.body.cancel.bind(response.body);response.body.cancel=async(...values)=>{pendingCancellation=true;cancelEntered.resolve();await cancelRelease.promise;try{return await cancel(...values)}finally{pendingCancellation=false}};
   f.sql.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:projecttest');
  }
  return response;
 };
 await f.start();assert.equal((await f.request()).body,'primary');await until(()=>cancelEntered.settled,'actual native cancellation entry');await until(()=>f.errors.length>0,'original deadline reports retained cleanup');
 assert.equal(pendingCancellation,true);assert.equal(f.read().operation.phase,'observing');assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await f.start('projecttest1',{maxRequestMs:10000});await Promise.all(Array.from({length:16},()=>f.request({project:'projecttest1'})));
 await until(()=>f.read('projecttest1').operation.report.counters.reserved+f.read('projecttest1').operation.report.skips.capacity===16,'all sixteen detached admission decisions');assert.equal(f.read('projecttest1').operation.report.counters.reserved,15);assert.equal(f.read('projecttest1').operation.report.skips.capacity,1);await until(()=>f.events.length===16,'fifteen candidate submissions reach native HTTP');assert.ok(f.errors.some(error=>String(error).includes('cleanup remains uncertain')));
 cancelRelease.resolve();await until(()=>!pendingCancellation,'actual held cancellation settles');body.resolve();await until(()=>f.read('projecttest1').operation.report.counters.settled===15,'other exact owner settles');
 await f.request({project:'projecttest1'});await until(()=>f.read('projecttest1').operation.report.counters.settled===16,'global slot reusable only after tracked cancellation');assert.equal(f.events.length,17);assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
});


test('rejected native response without a reader retains cancellation occupancy and the durable stop barrier',async t=>{
 const body=gate(),cancelRelease=gate(),nativeFetch=globalThis.fetch;let pendingCancellation=false,first=true;
 const f=await fixture(t,{productionRequest:true,policy:{maxRequestMs:2000,maxConcurrent:16,maxDurationMs:30000},candidate:async(req,res)=>{res.setHeader('content-type','application/json');if(f.events.length===1)res.setHeader('content-encoding','identity');res.write('prefix');await body.promise;res.end('suffix')}});
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(...args)=>{
  const response=await nativeFetch(...args);
  if(first&&String(args[0]).startsWith(f.target+'/candidate/')){
   first=false;const cancel=response.body.cancel.bind(response.body);response.body.cancel=async(...values)=>{pendingCancellation=true;await cancelRelease.promise;try{return await cancel(...values)}finally{pendingCancellation=false}};
  }
  return response;
 };
 const initial=await f.start();assert.equal((await f.request()).body,'primary');
 await until(()=>pendingCancellation||f.read().operation.report.counters.settled===1,'native response cleanup or premature settlement');
 assert.equal(pendingCancellation,true,'Received native response cancellation must begin before settlement.');assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{});
 await until(()=>f.errors.some(error=>String(error).includes('cleanup remains uncertain')),'original deadline retains stopped cleanup obligation');
 assert.equal(pendingCancellation,true);assert.equal(f.read().operation.phase,'observing');assert.equal(f.read().operation.stopRequested,true);assert.equal(f.read().operation.retirement,null);assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await until(()=>f.sql.prepare('SELECT count(*) n FROM clank_distributed_leases WHERE resource=?').get('project:projecttest').n===0,'bounded owner task released its actual native project lease');
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{}));
 assert.throws(()=>f.controller.replay('projecttest',initial.operation.idempotencyKeyDigest));
 await assert.rejects(f.controller.recover('projecttest'),error=>error.code==='SHADOW_BUSY');
 await assert.rejects(f.controller.start('projecttest',initial.operation,()=>{}),error=>error.code==='SHADOW_BUSY');
 assert.equal(pendingCancellation,true);assert.equal(f.events.length,1);assert.equal(f.read().operation.phase,'observing');assert.deepEqual(f.read().operation.reservations,[1]);
 await f.start('projecttest1',{maxRequestMs:10000});await Promise.all(Array.from({length:16},()=>f.request({project:'projecttest1'})));
 await until(()=>f.read('projecttest1').operation.report.counters.reserved+f.read('projecttest1').operation.report.skips.capacity===16,'global admission decisions while rejected body cancellation is held');
 assert.equal(f.read('projecttest1').operation.report.counters.reserved,15);assert.equal(f.read('projecttest1').operation.report.skips.capacity,1);await until(()=>f.events.length===16,'fifteen candidate native HTTP submissions');
 cancelRelease.resolve();await until(()=>!pendingCancellation,'actual rejected-response cancellation settles');body.resolve();await until(()=>f.read('projecttest1').operation.report.counters.settled===15,'other owner settles');
 await f.request({project:'projecttest1'});await until(()=>f.read('projecttest1').operation.report.counters.settled===16,'global slot reusable after actual rejected-response cancellation');
 assert.equal(f.events.length,17);assert.equal(f.read().operation.phase,'observing');assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await until(()=>f.controller.elapsed('projecttest',initial.operation.sessionId)===null,'exact tombstone removed after actual tracked drain');
 const recovered=await f.controller.recover('projecttest');assert.equal(recovered.operation.phase,'complete');assert.equal(recovered.operation.retirement.phase,'retired');assert.deepEqual(recovered.operation.reservations,[]);assert.equal(recovered.operation.report.counters.unknown.interrupted,1);assert.equal(f.events.length,17);
});


for(const firstReleased of ['read','cancel'])test('deadline independently cancels native reader and retains both observed completions: '+firstReleased+' first',async t=>{
 const body=gate(),readRelease=gate(),cancelRelease=gate(),nativeFetch=globalThis.fetch;
 let intercepted=false,readStarted=false,readDelivered=false,cancelStarted=false,cancelDelivered=false,nativeReadSettled=false,nativeCancelSettled=false;
 const f=await fixture(t,{productionRequest:true,leaseMs:120000,heldPeerCleanup:body,policy:{maxRequestMs:2000,maxConcurrent:16,maxDurationMs:120000},candidate:async(req,res)=>{res.setHeader('connection','close');res.setHeader('content-type','application/json');res.write('prefix');await body.promise;res.end('suffix')}});
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(...args)=>{
  const response=await nativeFetch(...args);
  if(!intercepted&&String(args[0]).startsWith(f.target+'/candidate/')){
   intercepted=true;const getReader=response.body.getReader.bind(response.body);
   response.body.getReader=(...values)=>{const reader=getReader(...values),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader);let count=0;
    reader.read=(...input)=>{const actual=read(...input);if(++count!==2)return actual;readStarted=true;
     // Synchronization only: retain the actual native outcome; never fabricate EOF or rejection.
     return actual.then(async value=>{nativeReadSettled=true;await readRelease.promise;readDelivered=true;return value},async error=>{nativeReadSettled=true;await readRelease.promise;readDelivered=true;throw error});};
    reader.cancel=async(...input)=>{f.assertDetached();cancelStarted=true;try{return await cancel(...input)}finally{nativeCancelSettled=true;await cancelRelease.promise;cancelDelivered=true}};
    return reader;
   };
  }
  return response;
 };
 const initial=await f.start();assert.deepEqual(await f.request(),{status:200,body:'primary'});await until(()=>readStarted,'actual second native read starts');
 await until(()=>cancelStarted,'deadline submits real cancellation independently of held read outcome');
 await until(()=>nativeReadSettled&&nativeCancelSettled,'both actual native operations settle while acknowledgement delivery is held');
 assert.equal(readDelivered,false);assert.equal(cancelDelivered,false);assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{});
 await until(()=>f.errors.some(error=>String(error).includes('cleanup remains uncertain')),'bounded close refuses retained actual cleanup');
 await until(()=>f.sql.prepare('SELECT count(*) n FROM clank_distributed_leases WHERE resource=?').get('project:projecttest').n===0,'bounded close releases only native project lease');
 await assert.rejects(f.controller.recover('projecttest'),error=>error.code==='SHADOW_BUSY');await assert.rejects(f.controller.start('projecttest',initial.operation,()=>{}),error=>error.code==='SHADOW_BUSY');
 await assert.rejects(f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{}));
 await f.start('projecttest1',{maxRequestMs:10000});await Promise.all(Array.from({length:16},()=>f.request({project:'projecttest1'})));
 await until(()=>f.read('projecttest1').operation.report.counters.reserved+f.read('projecttest1').operation.report.skips.capacity===16,'held native reader occupies one of sixteen global slots');
 assert.equal(f.read('projecttest1').operation.report.counters.reserved,15);assert.equal(f.read('projecttest1').operation.report.skips.capacity,1);
 (firstReleased==='read'?readRelease:cancelRelease).resolve();await until(()=>firstReleased==='read'?readDelivered:cancelDelivered,'only first actual outcome is delivered');
 assert.equal(firstReleased==='read'?cancelDelivered:readDelivered,false);assert.deepEqual(f.read().operation.reservations,[1]);assert.equal(f.read().operation.report.counters.settled,0);
 await assert.rejects(f.controller.recover('projecttest'),error=>error.code==='SHADOW_BUSY');await f.request({project:'projecttest1'});
 await until(()=>f.read('projecttest1').operation.report.skips.capacity===2,'one settled operation cannot release global occupancy');assert.equal(f.read('projecttest1').operation.report.counters.reserved,15);
 readRelease.resolve();cancelRelease.resolve();await until(()=>readDelivered&&cancelDelivered,'both observed native outcomes delivered');
 await until(()=>f.controller.elapsed('projecttest',initial.operation.sessionId)===null,'exact tombstone released only after both outcomes');
 body.resolve();await until(()=>f.read('projecttest1').operation.report.counters.settled===15,'other owner native candidates complete');
 const recovered=await f.controller.recover('projecttest');assert.equal(recovered.operation.phase,'complete');assert.equal(recovered.operation.retirement.phase,'retired');assert.equal(recovered.operation.report.counters.unknown.interrupted,1);assert.deepEqual(recovered.operation.reservations,[]);
 await f.request({project:'projecttest1'});await until(()=>f.read('projecttest1').operation.report.counters.settled===16,'released slot admits only a fresh request');assert.equal(f.events.length,17);
});

test('late native headers consume cancellation intent without acquiring a reader',async t=>{
 const body=gate(),headersRelease=gate(),cancelRelease=gate(),nativeFetch=globalThis.fetch;let intercepted=false,headersReceived=false,cancelStarted=false,cancelDelivered=false,reads=0;
 const f=await fixture(t,{productionRequest:true,policy:{maxRequestMs:2000},candidate:async(req,res)=>{res.setHeader('content-type','application/json');res.write('prefix');await body.promise;res.end('suffix')}});
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(...args)=>{const response=await nativeFetch(...args);if(!intercepted&&String(args[0]).startsWith(f.target+'/candidate/')){
  intercepted=true;headersReceived=true;const getReader=response.body.getReader.bind(response.body),cancel=response.body.cancel.bind(response.body);
  response.body.getReader=(...values)=>{reads++;return getReader(...values)};
  response.body.cancel=async(...values)=>{f.assertDetached();cancelStarted=true;try{return await cancel(...values)}finally{await cancelRelease.promise;cancelDelivered=true}};
  await headersRelease.promise;
 }return response};
 const initial=await f.start();assert.deepEqual(await f.request(),{status:200,body:'primary'});await until(()=>headersReceived,'actual native response received before held delivery');
 await f.controller.requestStop('projecttest',initial.operation.sessionId,initial.operation.operationId,initial.operation.controllerEpoch,()=>{});
 await until(()=>f.errors.some(error=>String(error).includes('cleanup remains uncertain')),'original bound expires with outstanding response');
 headersRelease.resolve();await until(()=>cancelStarted,'late received body is actually cancelled');assert.equal(reads,0);assert.equal(cancelDelivered,false);assert.equal(f.events.length,1);assert.deepEqual(f.read().operation.reservations,[1]);
 await assert.rejects(f.controller.recover('projecttest'),error=>error.code==='SHADOW_BUSY');cancelRelease.resolve();await until(()=>cancelDelivered,'late body cancellation settles');
 await until(()=>f.controller.elapsed('projecttest',initial.operation.sessionId)===null,'late cleanup releases exact owner');const recovered=await f.controller.recover('projecttest');assert.equal(recovered.operation.phase,'complete');assert.equal(recovered.operation.report.counters.unknown.interrupted,1);assert.equal(reads,0);assert.equal(f.events.length,1);body.resolve();
});
