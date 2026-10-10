import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createProjectCostClient,createProjectCostView} from '../dist/project-costs.js';

test('cost transport binds current authorization and exact intents without automatic retries',async()=>{
  const calls=[];let token='first',csrf='first-csrf';const client=createProjectCostClient({url:'https://cost.test/',headers:()=>({authorization:token}),auth:{csrfHeader:()=>({'x-clank-csrf':csrf})},fetch:async(url,input)=>{calls.push({url,input});return Response.json({ok:true,snapshot:{version:1},snapshots:[],report:{month:'2026-10'}});}});
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
  const root=dom(t),calls=[];let report=state();const client={read:async()=>report,history:async()=>[],policy:async(_id,input)=>{calls.push(input);if(calls.length===1)throw Object.assign(new Error('stale'),{status:409});report=state(4);return report.policy;}};
  const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=> 'human_exact_01',canManage:()=>true});t.after(()=>view.dispose());await settled();
  const reason=label(root,'Budget change reason'),form=reason.parent.parent;reason.value='Review draft';form.fire('input');report=state(3);await view.refresh();form.fire('submit');await settled();assert.equal(calls[0].expectedVersion,2);assert.equal(reason.value,'Review draft');assert.equal(button(root,'Discard draft and refresh').disabled,false);
  button(root,'Discard draft and refresh').fire('click');await settled();assert.equal(reason.value,'');reason.value='Reviewed current policy';form.fire('input');form.fire('submit');await settled();assert.equal(calls[1].expectedVersion,3);assert.equal(document.activeElement.tagName,'p');
});
test('uncertain mutation keeps exact intent through a failing read and disables draft replacement',async t=>{
  const root=dom(t),calls=[];let readError=false,report=state();const client={read:async()=>{if(readError)throw Object.assign(new Error('read failed'),{status:409});return report;},history:async()=>[],policy:async(_id,input)=>{calls.push(structuredClone(input));if(calls.length===1)throw new TypeError('lost acknowledgment');report=state(3);return report.policy;}};
  const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=> 'human_exact_01',canManage:()=>true});t.after(()=>view.dispose());await settled();const reason=label(root,'Budget change reason'),form=reason.parent.parent;reason.value='Unchanged intent';form.fire('input');form.fire('submit');await settled();assert.equal(reason.disabled,true);assert.equal(button(root,'Retry unchanged operation').hidden,false);assert.equal(button(root,'Discard draft and refresh').disabled,true);
  readError=true;await view.refresh();assert.equal(button(root,'Retry unchanged operation').hidden,false);assert.equal(reason.disabled,true);readError=false;button(root,'Retry unchanged operation').fire('click');await settled();assert.deepEqual(calls[0],calls[1]);assert.equal(reason.disabled,false);
});
test('account change fences a late private read and clears form drafts',async t=>{
  const root=dom(t);let account='human_exact_01',release;const held=new Promise(resolve=>release=resolve);const report=state(),client={read:async()=>{await held;return report;},history:async()=>[]};const view=createProjectCostView(root,{client,projectId:report.projectId,month:report.month,getAccountId:()=>account,canManage:()=>true});t.after(()=>view.dispose());const reason=label(root,'Budget change reason');reason.value='Private draft';account='human_other_02';release();await settled();assert.equal(root.children.length,0);assert.equal(reason.value,'');
});
