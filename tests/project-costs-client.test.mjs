import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runInNewContext} from 'node:vm';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,defineTable,openSQLite} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {openPlatformProjectCosts} from '../dist/platform-project-costs.js';
import {platformConsolePage} from '../dist/platform-console.js';
import {createProjectCostClient,createProjectCostView} from '../dist/project-costs.js';

test('cost transport binds current authorization and exact intents without automatic retries',async()=>{
  const calls=[];let token='first',csrf='first-csrf';const client=createProjectCostClient({url:'https://cost.test/',headers:()=>({authorization:token}),auth:{csrfHeader:()=>({'x-clank-csrf':csrf})},fetch:async(url,input)=>{calls.push({url,input});return Response.json({ok:true,snapshot:measuredSnapshot(),snapshots:[],report:{month:'2026-10'}});}});
  const intent={month:'2026-10',expectedVersion:0,operationId:'cost_exact_intent_01',reason:'Reviewed'};await client.reconcile('project_exact_01',intent);token='second';csrf='second-csrf';await client.reconcile('project_exact_01',intent);
  assert.equal(calls[0].url,'https://cost.test/api/projects/project_exact_01/costs/reconcile');assert.equal(calls[0].input.body,calls[1].input.body);assert.equal(calls[1].input.headers.get('authorization'),'second');assert.equal(calls[1].input.headers.get('x-clank-csrf'),'second-csrf');assert.equal(calls[0].input.redirect,'error');assert.equal(calls[0].input.credentials,'same-origin');
  await client.history('project_exact_01','2026-10');assert.match(calls[2].url,/costs\/history\?month=2026-10$/);const before=calls.length;await assert.rejects(client.read('../foreign'),/identifier/);await assert.rejects(client.reconcile('project_exact_01',{reason:'x'.repeat(9000)}),/envelope/);assert.equal(calls.length,before);
});
test('cost transport bounds stalled response bodies and redacts malformed server payloads',async()=>{
  for(const fetch of [()=>new Promise(()=>{}),()=>Promise.resolve(new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}})))]){
    const started=Date.now();await assert.rejects(createProjectCostClient({timeoutMs:500,fetch}).read('project_exact_01'),/timed out/);assert.ok(Date.now()-started<1500);
  }
  await assert.rejects(createProjectCostClient({fetch:async()=>new Response('x'.repeat(256*1024+1))}).read('project_exact_01'),/envelope/);
  await assert.rejects(createProjectCostClient({fetch:async()=>new Response('private malformed cost details')}).read('project_exact_01'),error=>error.message.includes('invalid JSON')&&!error.message.includes('private'));
  await assert.rejects(createProjectCostClient({fetch:async()=>Response.json({ok:false,error:'private cost details'},{status:403})}).read('project_exact_01'),error=>error.status===403&&!error.message.includes('private'));
});
// Focused fake-DOM state tests supplement, rather than certify, native browser acceptance.
function dom(t){
  const previous={document:globalThis.document,confirm:globalThis.confirm};
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.style={};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.events=new Map();}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    setAttribute(name,value){this[name]=value;}
    contains(value){return this===value||this.children.some(child=>child.contains(value));}
    querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(child=>[...(tags.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]);}
    addEventListener(type,handler){this.events.set(type,handler);}
    focus(){globalThis.document.activeElement=this;}
    fire(type){this.events.get(type)?.({preventDefault(){}});}
  }
  globalThis.document={createElement:tag=>new Element(tag),activeElement:null};globalThis.confirm=()=>true;t.after(()=>{globalThis.document=previous.document;globalThis.confirm=previous.confirm;});return new Element('root');
}
function state(version=2){return {protocol:'clank-project-costs/1',projectId:'project_exact_01',month:'2026-10',snapshot:null,policy:{version,currency:'USD',limitMinor:'100',warningPercent:80,admission:'observe',maxMeasurementAgeMs:60000,reason:'Reviewed',updatedAt:Date.now()},override:null,status:'unknown',admission:'allowed',asOf:Date.now()};}
const label=(root,text)=>root.querySelectorAll('label').find(node=>node.textContent===text).children[0];
const button=(root,text)=>root.querySelectorAll('button').find(node=>node.textContent===text);
async function settled(){for(let n=0;n<4;n++)await tick();}
test('version-pinned budget drafts can explicitly recover from a stale rejection',async t=>{
  const root=dom(t),calls=[];let report=state();const client={read:async()=>report,history:async()=>[],policy:async(_id,input)=>{calls.push(input);if(calls.length===1)throw Object.assign(new Error('stale'),{status:409});report=state(4);report.policy.reason=input.reason;return report.policy;}};
  const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=> 'human_exact_01',canManage:()=>true});t.after(()=>view.dispose());await settled();
  const reason=label(root,'Budget change reason'),form=reason.parent.parent;reason.value='Review draft';form.fire('input');report=state(3);await view.refresh();form.fire('submit');await settled();assert.equal(calls[0].expectedVersion,2);assert.equal(reason.value,'Review draft');assert.equal(button(root,'Discard draft and refresh').disabled,false);
  button(root,'Discard draft and refresh').fire('click');await settled();assert.equal(reason.value,'');reason.value='Reviewed current policy';form.fire('input');form.fire('submit');await settled();assert.equal(calls[1].expectedVersion,3);assert.equal(document.activeElement.tagName,'p');
});
test('uncertain mutation keeps exact intent through a failing read and disables draft replacement',async t=>{
  const root=dom(t),calls=[];let readError=false,report=state();const client={read:async()=>{if(readError)throw Object.assign(new Error('read failed'),{status:409});return report;},history:async()=>[],policy:async(_id,input)=>{calls.push(structuredClone(input));if(calls.length===1)throw new TypeError('lost acknowledgment');report=state(3);report.policy.reason=input.reason;return report.policy;}};
  const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=> 'human_exact_01',canManage:()=>true});t.after(()=>view.dispose());await settled();const reason=label(root,'Budget change reason'),form=reason.parent.parent;reason.value='Unchanged intent';form.fire('input');form.fire('submit');await settled();assert.equal(reason.disabled,true);assert.equal(button(root,'Retry unchanged operation').hidden,false);assert.equal(button(root,'Discard draft and refresh').disabled,true);
  readError=true;await view.refresh();assert.equal(button(root,'Retry unchanged operation').hidden,false);assert.equal(reason.disabled,true);readError=false;button(root,'Retry unchanged operation').fire('click');await settled();assert.deepEqual(calls[0],calls[1]);assert.equal(reason.disabled,false);
});
test('account change fences a late private read and clears form drafts',async t=>{
  const root=dom(t);let account='human_exact_01',release;const held=new Promise(resolve=>release=resolve);const report=state(),client={read:async()=>{await held;return report;},history:async()=>[]};const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=>account,canManage:()=>true});t.after(()=>view.dispose());const reason=label(root,'Budget change reason');reason.value='Private draft';account='human_other_02';release();await settled();assert.equal(root.children.length,0);assert.equal(reason.value,'');
});

// This fixture exercises real HTTP parsing and native SQLite receipts; its DOM is
// deliberately synthetic and supplies no browser or human-auth acceptance claim.
function measuredSnapshot(){
  const start=Date.UTC(2026,9,1),meters=['storageByteMilliseconds','transferBytes','runtimeMilliseconds'];
  return {protocol:'clank-project-costs/1',projectId:'project_exact_01',month:'2026-10',version:1,observedUntil:start,reconciledAt:start,source:'native-fixture',sourceRevision:'one',rateCard:{id:'native-card',revision:1,currency:'USD',effectiveFrom:start,rates:Object.fromEntries(meters.map(meter=>[meter,{amountMinor:1,perUnits:1}]))},components:meters.map(meter=>({meter,units:'1',complete:true,numerator:'1',denominator:1,amountMinor:'1'})),knownAmountMinor:'3',amountMinor:'3',reason:'Reviewed'};
}
async function until(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Owned cost UI did not settle');}
async function nativeCosts(t){
  const root=await mkdtemp(join(tmpdir(),'clank-cost-client-')),database=await openSQLite(defineDatabase({items:defineTable({text:s.string()})}),{path:join(root,'native.sqlite')});
  let at=Date.now();const date=new Date(at),start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1),month=new Date(start).toISOString().slice(0,7),meters=['storageByteMilliseconds','transferBytes','runtimeMilliseconds'];
  const costs=openPlatformProjectCosts(database[SQLITE_INTERNAL],{rateCards:[{id:'genuine-native-card',revision:1,currency:'USD',effectiveFrom:start,rates:Object.fromEntries(meters.map(meter=>[meter,{amountMinor:1,perUnits:1}]))}],measure:async()=>({source:'native-client-fixture',sourceRevision:'one',periodStartedAt:start,observedUntil:at,meters:Object.fromEntries(meters.map(meter=>[meter,{units:'1',complete:true}]))})},()=>at);
  t.after(async()=>{costs.close();database.close();await rm(root,{recursive:true,force:true});});
  const project='project_exact_01',authority={actorId:'native_human_01',authorize(){},audit(){}};
  const input={policy:{expectedVersion:0,operationId:'native_policy_01',currency:'USD',limitMinor:'100',warningPercent:80,admission:'observe',maxMeasurementAgeMs:60000,reason:'  Preserved reviewed reason  '},reconcile:{month,expectedVersion:0,operationId:'native_reconcile_01',reason:'  Preserved reviewed reason  '},override:{expectedVersion:0,policyVersion:1,operationId:'native_override_01',expiresAt:at+60000,reason:'  Preserved reviewed reason  '}};
  return {project,month,input,advance(ms){at+=ms;},read:()=>costs.read(project,authority,month),history:()=>costs.history(project,authority,month),invoke:(kind,value)=>kind==='policy'?costs.changePolicy(project,authority,value):kind==='override'?costs.changeOverride(project,authority,value):costs.reconcile(project,authority,value)};
}
async function http(t,reply){
  const calls=[],errors=[],server=createServer(async(request,response)=>{try{let raw='';for await(const part of request)raw+=part;const call={method:request.method,path:request.url,raw,body:raw?JSON.parse(raw):null,headers:request.headers};calls.push(call);const result=await reply(call);response.writeHead(200,{'content-type':'application/json'});response.end(typeof result==='string'?result:JSON.stringify(result));}catch(error){errors.push(error);response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({ok:false}));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});assert.deepEqual(errors,[]);});return {calls,origin:'http://127.0.0.1:'+server.address().port};
}
const receiptKey=kind=>kind==='reconcile'?'snapshot':kind;
async function mountConsole(t,root,host,f){
  const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text(),start=html.indexOf('const createProjectCostClient='),end=html.indexOf('const sortConsoleProjects=',start);
  assert.ok(start>=0&&end>start,'Console must embed its actual bounded client and self-contained view.');
  const context={document:globalThis.document,confirm:()=>true,q:()=>root,initial:{authenticated:true,projectCostsEnabled:true,csrfToken:'fresh-first',impersonation:null},state:{currentProject:f.project,projectTab:'settings',dashboard:{account:{id:'human_exact_01'}},projectData:{detail:{access:{role:'owner'}}}},fetch:(path,input)=>fetch(host.origin+path,input),Headers,TextEncoder,TextDecoder,Uint8Array,AbortController,Error,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval};
  runInNewContext(html.slice(start,end),context);t.after(()=>context.clearCostView());context.mountProjectCosts({id:f.project});await until(()=>host.calls.length===2&&label(root,'Currency code').value==='USD');return context;
}
for(const kind of ['policy','reconcile','override'])test('Console '+kind+' preserves native committed intent after malformed HTTP acknowledgment and explicitly retries identical bytes',async t=>{
  const f=await nativeCosts(t);await f.invoke('policy',f.input.policy);const root=dom(t);let first=true;
  const host=await http(t,async call=>{if(call.method==='GET')return call.path.includes('/history')?{ok:true,snapshots:f.history()}:{ok:true,report:f.read()};const value=await f.invoke(kind,call.body);if(first){first=false;return '{';}return {ok:true,[receiptKey(kind)]:value};});
  const context=await mountConsole(t,root,host,f),input=label(root,kind==='policy'?'Budget change reason':kind==='reconcile'?'Reconciliation reason':'Override reason'),form=input.parent.parent;
  input.value='  Keep exact reviewed intent  ';if(kind!=='reconcile')form.fire('input');form.fire('submit');await until(()=>root.querySelectorAll('p').some(node=>node.textContent.includes('uncertain')));
  assert.equal(host.calls.filter(call=>call.method==='POST').length,1);assert.equal(input.disabled,true);assert.equal(button(root,'Retry unchanged operation').hidden,false);assert.equal(button(root,'Discard draft and refresh').disabled,true);
  context.initial.csrfToken='fresh-retry';button(root,'Retry unchanged operation').fire('click');await until(()=>host.calls.filter(call=>call.method==='POST').length===2&&!input.disabled);
  const posts=host.calls.filter(call=>call.method==='POST');assert.equal(posts[0].raw,posts[1].raw);assert.equal(posts[0].headers['x-clank-csrf'],'fresh-first');assert.equal(posts[1].headers['x-clank-csrf'],'fresh-retry');assert.equal(posts[0].body.reason,'  Keep exact reviewed intent  ');assert.equal(button(root,'Retry unchanged operation').hidden,true);
});
for(const kind of ['policy','reconcile','override'])for(const mode of ['missing','mismatched'])test('native HTTP bounded client refuses '+kind+' '+mode+' successful receipt',async t=>{
  const f=await nativeCosts(t);if(kind==='override')await f.invoke('policy',f.input.policy);const host=await http(t,async call=>{const value=await f.invoke(kind,call.body);return mode==='missing'?{ok:true}:{ok:true,[receiptKey(kind)]:{...value,version:99}};}),client=createProjectCostClient({url:host.origin});
  await assert.rejects(client[kind](f.project,f.input[kind]),/acknowledgment is uncertain/);assert.equal(host.calls.length,1);
});
test('genuine native historical receipts remain accepted after newer versions and override expiry',async t=>{
  const f=await nativeCosts(t),host=await http(t,async call=>{const kind=call.path.split('/').at(-1);return {ok:true,[receiptKey(kind)]:await f.invoke(kind,call.body)};}),client=createProjectCostClient({url:host.origin});
  const first={};for(const kind of ['policy','reconcile','override'])first[kind]=await client[kind](f.project,f.input[kind]);
  await client.policy(f.project,{...f.input.policy,expectedVersion:1,operationId:'native_policy_02',limitMinor:'200'});await client.reconcile(f.project,{...f.input.reconcile,expectedVersion:1,operationId:'native_reconcile_02'});f.advance(70000);
  for(const kind of ['policy','reconcile','override'])assert.deepEqual(await client[kind](f.project,f.input[kind]),kind==='override'?{...first[kind],active:false}:first[kind]);
  assert.equal(host.calls.length,8);assert.equal(first.override.active,true);
});
test('bounded client matches the serialized request even when caller input changes during native HTTP await',async t=>{
  const f=await nativeCosts(t);let entered,release;const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);t.after(()=>release());
  const host=await http(t,async call=>{const value=await f.invoke('policy',call.body);entered();await held;return {ok:true,policy:value};}),client=createProjectCostClient({url:host.origin}),input={...f.input.policy};
  const pending=client.policy(f.project,input);await ready;input.reason='Changed after serialization';input.limitMinor='999';input.expectedVersion=50;release();const receipt=await pending;assert.equal(receipt.reason,f.input.policy.reason);assert.equal(receipt.limitMinor,'100');assert.equal(host.calls.length,1);
});
for(const kind of ['policy','reconcile','override'])test('injected '+kind+' client cannot discard pending identity with malformed or substituted acknowledgment',async t=>{
  const f=await nativeCosts(t);await f.invoke('policy',f.input.policy);const root=dom(t),calls=[];const client={read:async()=>f.read(),history:async()=>f.history(),[kind]:async(_id,input)=>{calls.push(structuredClone(input));if(calls.length===1){const value=await f.invoke(kind,input);input.reason='Injected changed intent';return {...value,reason:input.reason};}return await f.invoke(kind,input);}};
  const view=createProjectCostView(root,{client,projectId:f.project,month:f.month,getAccountId:()=> 'human_exact_01',canManage:()=>true});t.after(()=>view.dispose());await settled();const input=label(root,kind==='policy'?'Budget change reason':kind==='reconcile'?'Reconciliation reason':'Override reason'),form=input.parent.parent;input.value='Unchanged original';if(kind!=='reconcile')form.fire('input');form.fire('submit');await until(()=>button(root,'Retry unchanged operation').hidden===false&&!button(root,'Retry unchanged operation').disabled);
  assert.equal(calls.length,1);assert.equal(input.disabled,true);button(root,'Retry unchanged operation').fire('click');await settled();assert.deepEqual(calls[0],calls[1]);assert.equal(calls.length,2);assert.equal(view.hasPendingChanges(),false);assert.equal(input.disabled,false);
});
test('Console fences a valid late native mutation receipt after the account changes',async t=>{
  const f=await nativeCosts(t);await f.invoke('policy',f.input.policy);const root=dom(t);let entered,release;const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);t.after(()=>release());
  const host=await http(t,async call=>{if(call.method==='GET')return call.path.includes('/history')?{ok:true,snapshots:f.history()}:{ok:true,report:f.read()};const policy=await f.invoke('policy',call.body);entered();await held;return {ok:true,policy};});
  const context=await mountConsole(t,root,host,f),input=label(root,'Budget change reason');input.value='Private reviewed intent';input.parent.parent.fire('input');input.parent.parent.fire('submit');await ready;context.state.dashboard.account.id='human_other_02';release();await until(()=>root.children.length===0);assert.equal(input.value,'');assert.equal(host.calls.filter(call=>call.method==='POST').length,1);
});

test('native HTTP acknowledgments bind every established reviewed identity field and reject altered snapshot arithmetic',async t=>{
  const f=await nativeCosts(t);await f.invoke('policy',f.input.policy);let alteration;
  const host=await http(t,async call=>{const kind=call.path.split('/').at(-1),value=structuredClone(await f.invoke(kind,call.body));alteration(value);return {ok:true,[receiptKey(kind)]:value};}),client=createProjectCostClient({url:host.origin});
  const changes={policy:{version:99,reason:'Other reason',currency:'EUR',limitMinor:'101',warningPercent:90,admission:'deny-at-observed-limit',maxMeasurementAgeMs:1000},override:{version:99,reason:'Other reason',policyVersion:2,expiresAt:0},reconcile:{version:99,reason:'Other reason',projectId:'foreign_project_01',month:'2020-01',protocol:'clank-project-costs/2'}};
  let count=0;for(const [kind,fields] of Object.entries(changes))for(const [key,value] of Object.entries(fields)){alteration=receipt=>receipt[key]=value;await assert.rejects(client[kind](f.project,f.input[kind]),/acknowledgment is uncertain/);count++;}
  for(const change of [value=>value.components[0].numerator='0',value=>value.components.pop(),value=>value.rateCard.rates.storageByteMilliseconds.perUnits=0]){alteration=change;await assert.rejects(client.reconcile(f.project,f.input.reconcile),/acknowledgment is uncertain/);count++;}
  assert.equal(host.calls.length,count);
});
