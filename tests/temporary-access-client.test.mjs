import test from 'node:test';
import assert from 'node:assert/strict';
import {createTemporaryAccessClient,createTemporaryAccessView} from '../dist/temporary-access.js';
const project='temporary_project_01',account={userId:'temporary_owner_01',sessionId:'temporary_session_01'};
const grant={id:'elevation_example_01',projectId:project,organizationId:'temporary_company_01',issuerId:account.userId,recipientId:'temporary_member_01',action:'preview.create',reason:'Reviewed isolated preview.',createdAt:Date.UTC(2026,9,10),expiresAt:Date.UTC(2026,9,10)+60000,version:1,state:'active',active:true};
const snapshot={projectId:project,version:1,observedAt:grant.createdAt,grants:[grant]};
const input={recipientId:grant.recipientId,action:'preview.create',durationMs:60000,reason:grant.reason,expectedVersion:0,operationId:'temporary_client_exact_01'};
const auth=()=>({user:{peek:()=>({id:account.userId})},session:{peek:()=>({id:account.sessionId})},csrfHeader:()=>({'x-clank-csrf':'owned-csrf-fixture'})});
test('bounded session-bound client sends current CSRF and distinguishes a create receipt from inventory',async()=>{
  const requests=[],client=createTemporaryAccessClient({auth:auth(),fetch:async(url,options)=>{requests.push({url,options});return Response.json(options.method==='GET'?{ok:true,snapshot}:{ok:true,result:{grant,acceptedVersion:1}});}});
  assert.deepEqual(await client.read(project),snapshot);assert.equal((await client.create(project,input)).grant.id,grant.id);assert.equal(requests[0].options.redirect,'error');assert.equal(requests[1].options.credentials,'same-origin');assert.equal(requests[1].options.headers['x-clank-csrf'],'owned-csrf-fixture');assert.deepEqual(JSON.parse(requests[1].options.body),input);
});
test('account switching during a real response read rejects the stale account payload',async()=>{
  let session=account.sessionId,release;const started=new Promise(resolve=>{release=resolve;});
  const client=createTemporaryAccessClient({auth:{...auth(),session:{peek:()=>({id:session})}},fetch:async()=>{await started;return Response.json({ok:true,snapshot});}});
  const read=client.read(project);session='a_new_native_session_01';release();await assert.rejects(read,e=>e.code==='AUTH_CHANGED');
});
test('timeouts cover a transport and response body that ignore abort; oversized and private malformed responses fail generically',async()=>{
  const hung=createTemporaryAccessClient({auth:auth(),timeoutMs:100,fetch:()=>new Promise(()=>{})});await assert.rejects(hung.read(project),e=>e.code==='TEMPORARY_ACCESS_TIMEOUT');
  const stream=createTemporaryAccessClient({auth:auth(),timeoutMs:100,fetch:async()=>new Response(new ReadableStream({start(){}}))});await assert.rejects(stream.read(project),e=>e.code==='TEMPORARY_ACCESS_TIMEOUT');
  for(const text of ['{"private_native_secret":"keep-private",','x'.repeat(65537)]){
    const client=createTemporaryAccessClient({auth:auth(),fetch:async()=>new Response(text)});await assert.rejects(client.read(project),e=>e.code==='TEMPORARY_ACCESS_RESPONSE'&&!e.message.includes('keep-private'));
  }
});
test('lost acknowledgment retries preserve exact body and operation identity, with no automatic retry',async()=>{
  const bodies=[],client=createTemporaryAccessClient({auth:auth(),fetch:async(_url,options)=>{bodies.push(options.body);if(bodies.length===1)throw new Error('Owned lost response.');return Response.json({ok:true,result:{grant,acceptedVersion:1}});}});
  await assert.rejects(client.create(project,input));assert.equal(bodies.length,1);await client.create(project,input);assert.equal(bodies[0],bodies[1]);
});
test('transport rejects another project, unsupported privilege and unbounded inventories',async()=>{
  for(const value of [{...snapshot,projectId:'other_project_01'},{...snapshot,grants:[{...grant,action:'jobs.cancel'}]},{...snapshot,grants:Array(101).fill(grant)}]){
    const client=createTemporaryAccessClient({auth:auth(),fetch:async()=>Response.json({ok:true,snapshot:value})});await assert.rejects(client.read(project),e=>e.code==='TEMPORARY_ACCESS_RESPONSE');
  }
});

class Element {
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.listeners=new Map();this.attributes=new Map();this.value='';this.textContent='';this.hidden=false;this.disabled=false;}
  append(...values){this.children.push(...values);if(this.tagName==='SELECT'&&!this.value&&this.children.length===values.length)this.value=values[0]?.value??'';}
  replaceChildren(...values){this.children=[];this.append(...values);}
  setAttribute(name,value){this.attributes.set(name,value);}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  focus(){this.ownerDocument.activeElement=this;}
  fire(type){this.listeners.get(type)?.({preventDefault(){}});}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function dom(){const events=new Map(),doc={activeElement:null,defaultView:{crypto:globalThis.crypto,confirm:()=>true,prompt:()=> 'Reviewed revocation.',addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);}},createElement(tag){return new Element(tag,doc);}};return {root:new Element('div',doc),doc,events};}
function descendants(root){return [root,...root.children.flatMap(descendants)];}
test('native-form fixture retains uncertain mutation intent across a failed read and explicitly retries without changing it',async t=>{
  const d=dom(),calls=[];let failRead=false;const client={read:async()=>{if(failRead)throw Object.assign(new Error('Read conflict'),{status:409});return snapshot;},create:async(_id,body)=>{calls.push({...body});if(calls.length===1)throw new Error('Lost acknowledgment.');return {grant,acceptedVersion:1};},revoke:async()=>({grant,acceptedVersion:1})};
  const view=createTemporaryAccessView(d.root,{projectId:project,client,account:()=>account,canManage:()=>true,members:[{id:grant.recipientId,label:'Current member'}]});t.after(()=>view.dispose());await settle();
  const form=descendants(d.root).find(node=>node.tagName==='FORM'),recipient=descendants(form).find(node=>node.name==='temporary-recipient'),why=descendants(form).find(node=>node.name==='temporary-reason');recipient.value=grant.recipientId;why.value='Keep this exact review.';why.fire('input');form.fire('submit');await settle();
  assert.equal(calls.length,1);assert.equal(view.hasPendingChanges(),true);assert.equal(why.disabled,true);failRead=true;await view.refresh();assert.equal(view.hasPendingChanges(),true);assert.equal(why.disabled,true);
  const retry=descendants(d.root).find(node=>node.textContent==='Retry unchanged request');retry.fire('click');await settle();assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});
test('native-form fixture clears all private grant/reason DOM on native revocation or account switch',async t=>{
  for(const mode of ['revocation','account']){const d=dom();let current=account,denied=false;const client={read:async()=>{if(denied)throw Object.assign(new Error('Current native access denied.'),{status:403});return snapshot;},create:async()=>({grant,acceptedVersion:1}),revoke:async()=>({grant,acceptedVersion:1})};
    const view=createTemporaryAccessView(d.root,{projectId:project,client,account:()=>current,canManage:()=>true,members:[]});t.after(()=>view.dispose());await settle();assert.ok(descendants(d.root).some(node=>node.textContent===grant.reason));if(mode==='account')current={userId:'another_owner_01',sessionId:'another_session_01'};else denied=true;await view.refresh();assert.equal(view.disposed,true);assert.equal(d.root.children.length,0);assert.equal(d.events.has('beforeunload'),false);
  }
});
