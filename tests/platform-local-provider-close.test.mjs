import assert from 'node:assert/strict';
import test from 'node:test';
import {closePlatformOwnedLocalProviders,drainPlatformLocalFallbackOperations} from '../dist/platform-local-provider-close.js';

test('platform close waits for active fallback work before service and control cleanup',async()=>{
 let resolveOperation;const events=[];
 const active=new Promise(resolve=>{resolveOperation=resolve;}).then(()=>{events.push('operation-finished');});
 const close=drainPlatformLocalFallbackOperations([active],async()=>{events.push('service-close');events.push('control-close');});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,[]);
 resolveOperation();await close;
 assert.deepEqual(events,['operation-finished','service-close','control-close']);
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
