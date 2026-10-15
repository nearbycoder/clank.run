import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {defineDatabase,openSQLite,openDeploymentOrchestrator} from '../dist/index.js';
import {openPlatform,platformProviderFallbackContext,assertPlatformFallbackParticipant} from '../dist/platform.js';
import {providerFallbackOrchestrationContext} from '../dist/orchestration.js';
import {providerFallbackResumeJournalContext,providerFallbackResumeCompletionJournal,providerFallbackResumeSettlementJournal,providerFallbackCancelledSourceContext,providerFallbackSourceClaimContext,providerFallbackSourceCompletionContext,providerFallbackReservationContext,providerFallbackRecoveryContext,providerFallbackJournalContext,providerFallbackCancellationContext,providerFallbackEndpointProbeContext,assertProviderFallbackCommit,assertProviderFallbackCompletion,providerFallbackRetirementContext,providerFallbackResumeContext,providerFallbackResumeCleanupContext,providerFallbackResumeReady,assertProviderFallbackSettlement,reserveProviderFallback,transferDockerProviderFallback,recoverProviderFallback} from '../dist/provider-fallback-coordinator.js';
import {retireDockerProviderFallbackCancellation,providerFallbackRuntimeCancellationContext,providerFallbackSourceIngressStoppedContext,retireDockerProviderFallbackRecovery,providerFallbackRuntimeRetirementContext,verifyDockerProviderFallbackResumed,providerFallbackRuntimeResumeContext,beginDockerProviderFallbackResume,cleanupDockerProviderFallbackResume,completeDockerProviderFallbackResume,providerFallbackRuntimeResumeLifecycleContext,providerFallbackRuntimeResumeCleanupContext,providerFallbackIngressStoppedContext,providerFallbackIngressReactivationContext} from '../dist/provider-service.js';
import {retireProviderDockerFallbackCancellation,retireProviderDockerFallbackRecovery,verifyProviderDockerFallbackResumed,beginProviderDockerFallbackResume,cleanupProviderDockerFallbackResume,completeProviderDockerFallbackResume,finishProviderDockerFallbackResumeCleanup} from '../dist/provider-docker.js';
import {providerFallbackNativeRecoveryContext,verifyProviderFallbackRecovery} from '../dist/provider-fallback-recovery.js';

test('fallback refuses structural authority before reading caller selectors or callbacks',async()=>{
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 assert.throws(()=>platformProviderFallbackContext(fake),/genuine original platform/);
 assert.throws(()=>assertPlatformFallbackParticipant(fake),/genuine original platform/);
 assert.throws(()=>providerFallbackOrchestrationContext(fake),/genuine original deployment orchestrator/);
 assert.throws(()=>providerFallbackReservationContext(fake),/genuine original fallback reservation/);
 assert.throws(()=>providerFallbackRecoveryContext(fake),/genuine original fallback recovery/);
 assert.throws(()=>providerFallbackJournalContext(fake,fake),/genuine coordinator journal capability/);
 assert.throws(()=>providerFallbackCancellationContext(fake),/genuine coordinator source cancellation capability/);
 assert.throws(()=>providerFallbackEndpointProbeContext(fake),/genuine coordinator endpoint probe capability/);
 assert.throws(()=>assertProviderFallbackCommit(fake,fake),/genuine coordinator commit capability/);
 assert.throws(()=>assertProviderFallbackCompletion(fake,fake),/genuine coordinator completion capability/);
 assert.throws(()=>providerFallbackRetirementContext(fake),/genuine finalized fallback retirement capability/);
 assert.throws(()=>assertProviderFallbackSettlement(fake,fake),/genuine coordinator settlement capability/);
 assert.throws(()=>providerFallbackNativeRecoveryContext(fake),/genuine authenticated fallback/);
 await assert.rejects(reserveProviderFallback(fake,fake,fake,fake,fake),/genuine original platform/);
 await assert.rejects(transferDockerProviderFallback(fake,fake,fake,fake,fake),/genuine original platform/);
 await assert.rejects(recoverProviderFallback(fake,fake,fake,fake,fake,fake),/genuine original platform/);
 await assert.rejects(verifyProviderFallbackRecovery(fake,fake,fake,fake),/genuine original fallback recovery/);
 assert.throws(()=>providerFallbackCancelledSourceContext(fake),/genuine cancelled reserved-source capability/);
 assert.throws(()=>providerFallbackSourceClaimContext(fake),/genuine original stopped-source claim capability/);
 assert.throws(()=>providerFallbackSourceCompletionContext(fake,fake),/genuine original source-completion capability/);
 assert.throws(()=>providerFallbackRuntimeCancellationContext(fake),/genuine cancelled reserved-source capability/);
 assert.throws(()=>providerFallbackSourceIngressStoppedContext(fake),/genuine finalized fallback retirement capability/);
 await assert.rejects(retireDockerProviderFallbackCancellation(fake,fake),/genuine cancelled reserved-source capability/);
 await assert.rejects(retireProviderDockerFallbackCancellation(fake,fake),/genuine cancelled reserved-source capability/);
 assert.equal(reads,0);
});

test('fallback fresh claims retain node authentication and never claim unrelated queued work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-fallback-claims-'));let database,orchestrator;
 try{
  database=await openSQLite(defineDatabase({}),{path:join(root,'control.sqlite')});orchestrator=openDeploymentOrchestrator(database);
  const node=await orchestrator.registerNode({id:'fallback-node',region:'test',capacity:10});
  const first=await orchestrator.enqueue({projectId:'unrelated',nodeId:node.node.id,action:'reconcile',payload:{name:'unrelated'},idempotencyKey:'unrelated-work'});
  const selected=await orchestrator.enqueue({projectId:'fallback',nodeId:node.node.id,action:'reconcile',payload:{name:'fallback'},idempotencyKey:'selected-work'});
  const scope=providerFallbackOrchestrationContext(orchestrator);
  await assert.rejects(scope.claimOperation(selected.operation.id,()=>orchestrator.claim(node.node.id,'invalid-node-token',1)),/authentication failed/);
  const claimed=await scope.claimOperation(selected.operation.id,async()=>{await Promise.resolve();return orchestrator.claim(node.node.id,node.token,1);});
  assert.deepEqual(claimed.map(row=>row.id),[selected.operation.id]);assert.equal(orchestrator.operation(first.operation.id).state,'queued');
  assert.ok(await orchestrator.authenticateOperation(claimed[0]));
  assert.deepEqual((await orchestrator.claim(node.node.id,node.token,1)).map(row=>row.id),[first.operation.id]);
  assert.deepEqual(await scope.claimOperation('missing-operation',()=>orchestrator.claim(node.node.id,node.token,10)),[]);
 }finally{orchestrator?.close();database?.close();await rm(root,{recursive:true,force:true});}
});

test('fallback original platform rejects unauthenticated recovery and fake source capabilities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-fallback-platform-'));let runtime;
 try{
  runtime=await openPlatform({dataDirectory:root,publicUrl:'http://127.0.0.1:47651',masterKey:randomBytes(32),hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:47651,appPortEnd:47655,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'fallback-test-registration-1234567890',placement:{}}});
  const authority=platformProviderFallbackContext(runtime);
  assert.throws(()=>authority.recovery('{broken','0'.repeat(64)),/authentication differs/);
  assert.throws(()=>authority.recovery(JSON.stringify({protocol:'clank-provider-fallback/1',phase:'prepared',controlIdentity:{}}),'0'.repeat(64)),/authentication differs/);
  let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
  await assert.rejects(authority.prepare(fake,new Uint8Array(),'node',process.hrtime.bigint()+1000000000n),/genuine original fallback source/);assert.equal(reads,0);
  await runtime.close();runtime=undefined;
  assert.throws(()=>authority.recovery('{}','0'.repeat(64)),/unavailable/);
 }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('retirement and resumed observation refuse copied or accessor-shaped permits before caller reads',async()=>{
 for(const candidate of [{},Object.freeze({protocol:'clank-provider-fallback/1'}),new Proxy({}, {get(){throw Error('caller permit getter read');}})]){
  assert.throws(()=>providerFallbackRetirementContext(candidate),/genuine finalized fallback retirement/);
  assert.throws(()=>providerFallbackResumeContext(candidate),/genuine original fallback resume observation/);
  assert.throws(()=>providerFallbackResumeCleanupContext(candidate),/genuine original fallback resume cleanup/);
  assert.throws(()=>providerFallbackIngressStoppedContext(candidate),/genuine original fallback resume cleanup/);
  assert.throws(()=>providerFallbackIngressReactivationContext(candidate),/genuine original fallback resume observation/);
  assert.throws(()=>providerFallbackResumeReady(candidate,candidate,candidate),/genuine original platform/);
  assert.throws(()=>providerFallbackRuntimeRetirementContext(candidate),/genuine finalized fallback retirement/);
  assert.throws(()=>providerFallbackRuntimeResumeContext(candidate),/genuine original fallback resume observation/);
  await assert.rejects(retireDockerProviderFallbackRecovery(candidate,candidate),/genuine finalized fallback retirement/);
  assert.throws(()=>retireProviderDockerFallbackRecovery(candidate,candidate),/genuine finalized fallback retirement/);
  await assert.rejects(verifyDockerProviderFallbackResumed(candidate,candidate),/genuine original fallback resume observation/);
  assert.throws(()=>verifyProviderDockerFallbackResumed(candidate,candidate),/genuine original fallback resume observation/);
  assert.throws(()=>providerFallbackRuntimeResumeLifecycleContext(candidate),/genuine original fallback resume observation/);
  assert.throws(()=>providerFallbackRuntimeResumeCleanupContext(candidate),/genuine original fallback resume cleanup/);
  for(const fn of [beginDockerProviderFallbackResume,completeDockerProviderFallbackResume])await assert.rejects(fn(candidate,candidate),/genuine original fallback resume observation/);
  await assert.rejects(cleanupDockerProviderFallbackResume(candidate,candidate),/genuine original fallback resume cleanup/);
  for(const fn of [beginProviderDockerFallbackResume,completeProviderDockerFallbackResume])assert.throws(()=>fn(candidate,candidate),/genuine original fallback resume observation/);
  for(const fn of [cleanupProviderDockerFallbackResume,finishProviderDockerFallbackResumeCleanup])assert.throws(()=>fn(candidate,candidate),/genuine original fallback resume cleanup/);

 }
});


test('draining source admission stays closed to ordinary selectors and structural recovery claims',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-fallback-draining-'));let database,orchestrator;
 try{
  database=await openSQLite(defineDatabase({}),{path:join(root,'control.sqlite')});orchestrator=openDeploymentOrchestrator(database);
  const node=await orchestrator.registerNode({id:'draining-source',region:'test',capacity:10});
  const selected=await orchestrator.enqueue({projectId:'recover-source',nodeId:node.node.id,action:'reconcile',payload:{generation:1},idempotencyKey:'recover-source'});
  const unrelated=await orchestrator.enqueue({projectId:'other-project',nodeId:node.node.id,action:'reconcile',idempotencyKey:'ordinary-other'});
  const scope=providerFallbackOrchestrationContext(orchestrator);orchestrator.setNodeDraining(node.node.id,true);
  assert.deepEqual(await orchestrator.claim(node.node.id,node.token,10),[]);
  assert.deepEqual(await scope.claimOperation(selected.operation.id,()=>orchestrator.claim(node.node.id,node.token,10)),[]);
  let reads=0,calls=0;for(const candidate of [{},Object.freeze({operationId:selected.operation.id,nodeId:node.node.id}),new Proxy({}, {get(){reads++;throw Error('caller getter');}})]){
   await assert.rejects(scope.claimSourceOperation(candidate,async()=>{calls++;return orchestrator.claim(node.node.id,node.token,10);}),/genuine original stopped-source claim capability/);
  }
  assert.equal(reads,0);assert.equal(calls,0);
  assert.equal(orchestrator.operation(selected.operation.id).state,'queued');assert.equal(orchestrator.operation(unrelated.operation.id).state,'queued');
  orchestrator.setNodeDraining(node.node.id,false);
  assert.deepEqual((await scope.claimOperation(selected.operation.id,()=>orchestrator.claim(node.node.id,node.token,10))).map(row=>row.id),[selected.operation.id]);
  assert.equal(orchestrator.operation(unrelated.operation.id).state,'queued');
 }finally{orchestrator?.close();database?.close();await rm(root,{recursive:true,force:true});}
});


test('resume journal signing and settlement refuse copied capabilities before inspecting caller data',()=>{
 let reads=0;const authority=Object.freeze({});
 for(const candidate of [{},Object.freeze({phase:'published',previous:{phase:'running'}}),new Proxy({}, {get(){reads++;throw Error('caller journal field read');}})]){
  assert.throws(()=>providerFallbackResumeJournalContext(candidate,authority),/genuine original resume journal capability/);
  assert.throws(()=>providerFallbackResumeCompletionJournal(candidate,authority),/genuine coordinator completion capability/);
  assert.throws(()=>providerFallbackResumeSettlementJournal(candidate,authority),/genuine coordinator settlement capability/);
 }
 assert.equal(reads,0);
});
