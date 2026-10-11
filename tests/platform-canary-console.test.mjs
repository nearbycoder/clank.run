import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {platformConsolePage} from '../dist/platform-console.js';
const row={operationId:'canary_exact_operation_01',controllerEpoch:9,releaseId:'release_01',phase:'retiring',outcome:null,cleanupRequired:true,retryable:true,reason:'<script>private input</script>',updatedAt:123};
const payload={enabled:false,provider:row,canaries:[{releaseId:'release_01',state:'interrupted',stage:1,trafficPercent:10,samples:5,errorRate:.2,p95Ms:42,reason:'Interrupted'}]};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
async function fixture(api=async()=>payload){
 const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text(),nodes=new Map();
 const node=()=>({children:[],textContent:'',hidden:false,disabled:false,append(...children){this.children.push(...children)},focus(){this.focused=true}});
 const q=s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s)};
 const context={q,api,initial:{authenticated:true,email:'owner@example.test',csrfToken:'csrf-a',impersonation:null},state:{currentProject:'project_a',projectTab:'deployments',routeGeneration:1,projectData:{detail:{access:{canManageRuntime:true}}}},clear(n){n.children=[]},el(tag,className,text){return Object.assign(node(),{tag,className,textContent:text??''})},formatDate:x=>String(x),handleAuthFailure(error){if(error.status===401){context.initial.authenticated=false;return true}return false}};
 const names=['renderCanaryStatus','loadCanaryStatus','recoverCanary'];const source=html.match(/^function canaryViewCurrent\([^\n]+/m)?.[0]+'\n'+names.map(name=>{const m=html.match(new RegExp('^(?:async )?function '+name+'\\([\\s\\S]*?^\\}','m'));assert.ok(m,name);return m[0]}).join('\n');
 runInNewContext(source,context);return{...context,html,nodes};
}
function text(n){return n.textContent+' '+n.children.map(text).join(' ')}
test('canary Console renders disabled-policy measurements safely and exposes exact cleanup',async()=>{
 const calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);return payload});await f.loadCanaryStatus();
 assert.match(f.q('#canary-status').textContent,/disabled/);assert.match(text(f.q('#canary-reports')),/5 samples/);assert.match(text(f.q('#canary-reports')),/20.00%/);assert.match(text(f.q('#canary-detail')),/<script>private input<\/script>/);assert.equal(f.q('#canary-cleanup').hidden,false);
 await f.q('#canary-cleanup').onclick();assert.equal(calls.length,3);assert.equal(calls[1][0],'/api/projects/project_a/canary/recover');assert.equal(JSON.stringify(calls[1][1].body),JSON.stringify({operationId:row.operationId,expectedEpoch:9}));assert.match(f.q('#canary-error').textContent,/completed/);
});
test('canary Console never paints late reads after project, tab, session or route changes',async()=>{
 for(const change of ['project','tab','email','csrf','signout','away-back']){const held=deferred(),f=await fixture(()=>held.promise),pending=f.loadCanaryStatus();if(change==='project')f.state.currentProject='project_b';if(change==='tab')f.state.projectTab='logs';if(change==='email')f.initial.email='other@example.test';if(change==='csrf')f.initial.csrfToken='csrf-b';if(change==='signout')f.initial.authenticated=false;if(change==='away-back')f.state.routeGeneration+=2;held.resolve(payload);await pending;assert.equal(f.state.canarySnapshot,null,change);assert.equal(f.q('#canary-detail').children.length,0,change);assert.equal(f.q('#canary-cleanup').hidden,true,change);}
});
test('old cleanup controls cannot use a new operation or renewed permissions',async()=>{
 const calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);return payload});await f.loadCanaryStatus();const old=f.q('#canary-cleanup').onclick;await f.loadCanaryStatus();await old();assert.equal(calls.length,2);
 f.state.projectData.detail.access.canManageRuntime=false;await f.q('#canary-cleanup').onclick();assert.equal(calls.length,2);
});
test('read-only, no-deploy and retired views have no cleanup action',async()=>{
 for(const mode of ['impersonation','permission','retired']){const f=await fixture(async()=>mode==='retired'?{...payload,provider:{...row,phase:'complete',cleanupRequired:false,retryable:false}}:payload);if(mode==='impersonation')f.initial.impersonation={readOnly:true};if(mode==='permission')f.state.projectData.detail.access.canManageRuntime=false;await f.loadCanaryStatus();assert.equal(f.q('#canary-cleanup').hidden,true,mode);}
});
test('uncertain cleanup refreshes once without resubmitting and retains the failure explanation',async()=>{
 const calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);if(request)throw Object.assign(new Error('Cleanup uncertain'),{status:503});return payload});await f.loadCanaryStatus();await f.q('#canary-cleanup').onclick();assert.equal(calls.filter(c=>c[1]).length,1);assert.equal(calls.length,3);assert.match(f.q('#canary-error').textContent,/not confirmed/);assert.equal(f.q('#canary-cleanup').disabled,false);
});
test('double activation and a late mutation response cannot act in another view',async()=>{
 const held=deferred(),calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);return request?held.promise:payload});await f.loadCanaryStatus();const click=f.q('#canary-cleanup').onclick,pending=click();await click();assert.equal(calls.length,2);f.state.routeGeneration+=2;held.resolve({ok:true});await pending;assert.equal(calls.length,2);assert.equal(f.state.canaryBusy,null);assert.equal(f.q('#canary-error').textContent,'');
});
test('failed status refresh removes stale actions and latest read wins',async()=>{
 const first=deferred(),second=deferred();let n=0;const f=await fixture(()=>++n===1?first.promise:second.promise);const a=f.loadCanaryStatus(),b=f.loadCanaryStatus();second.resolve({...payload,provider:null});await b;first.resolve(payload);await a;assert.equal(f.q('#canary-cleanup').hidden,true);assert.equal(f.state.canarySnapshot.payload.provider,null);
 const failed=await fixture(async()=>{throw new Error('unavailable')});await failed.loadCanaryStatus();assert.equal(failed.q('#canary-cleanup').hidden,true);assert.match(failed.q('#canary-status').textContent,/unavailable/);
});

test('cleanup completion does not steal focus from another control while awaiting the response',async()=>{
 const held=deferred(),f=await fixture(async(path,request)=>request?held.promise:payload);await f.loadCanaryStatus();const pending=f.q('#canary-cleanup').onclick();f.q('#release-search').focus();held.resolve({ok:true});await pending;assert.equal(f.q('#release-search').focused,true);assert.notEqual(f.q('#canary-error').focused,true);assert.match(f.q('#canary-error').textContent,/completed/);
});
