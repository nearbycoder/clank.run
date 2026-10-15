import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import test from 'node:test';
import {closePlatformOwnedLocalProviders,createEvacuationAdmissionScope,drainPlatformLocalFallbackOperations} from '../dist/platform-local-provider-close.js';

test('platform close waits for active fallback work before service and control cleanup',async()=>{
 let resolveOperation;const events=[];
 const active=new Promise(resolve=>{resolveOperation=resolve;}).then(()=>{events.push('operation-finished');});
 const close=drainPlatformLocalFallbackOperations([active],async()=>{events.push('service-close');events.push('control-close');});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,[]);
 resolveOperation();await close;
 assert.deepEqual(events,['operation-finished','service-close','control-close']);
});

test('platform close drains an admitted multi-project plan while rejecting new scopes',async()=>{
 const admission=createEvacuationAdmissionScope(AsyncLocalStorage),events=[];let closing=false,closed=false,releaseFirst;
 const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
 const plan=admission.run(async()=>{
  for(const project of ['first','second']){
   admission.assertAllowed(closing,closed);events.push(project+':scope-started');
   if(project==='first')await firstGate;
   admission.assertAllowed(closing,closed);events.push(project+':scope-completed');
  }
  events.push('plan:terminal');
 });
 const close=drainPlatformLocalFallbackOperations([plan],async()=>{events.push('close:services');closed=true;});
 await new Promise(resolve=>setImmediate(resolve));closing=true;
 assert.throws(()=>admission.assertAllowed(closing,closed),/cannot admit a new fallback operation/u);
 assert.deepEqual(events,['first:scope-started']);
 releaseFirst();await close;
 assert.deepEqual(events,['first:scope-started','first:scope-completed','second:scope-started','second:scope-completed','plan:terminal','close:services']);
});

test('unresolved factory roots preflight before closing any owned service',async()=>{
 let closed=0,removed=0;
 const entries=new Map([
  ['opened',{owned:true,service:{async close(){closed++}}}],
  ['incomplete',{owned:true,ownership:{}}],
 ]);
 await assert.rejects(closePlatformOwnedLocalProviders(entries,()=>{removed++}),error=>error.kind==='unresolved-root');
 assert.equal(closed,0);assert.equal(removed,0);
});

test('failed owned service close remains retryable with its platform binding retained',async()=>{
 let attempts=0,removed=0;
 const service={async close(){if(++attempts===1)throw new Error('temporary close failure');}};
 const entries=new Map([['node',{owned:true,service}]]);
 await assert.rejects(closePlatformOwnedLocalProviders(entries,()=>{removed++}),error=>error.kind==='service-close');
 assert.equal(removed,0);
 await closePlatformOwnedLocalProviders(entries,()=>{removed++});
 assert.equal(attempts,2);assert.equal(removed,1);
});
