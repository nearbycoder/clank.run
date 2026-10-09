import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { platformConsolePage } from '../dist/platform-console.js';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
async function fixture(api){
  const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text(),nodes=new Map();
  const node=()=>({children:[],textContent:'',disabled:false,dataset:{},append(...children){this.children.push(...children)},setAttribute(name,value){this[name]=value},removeAttribute(name){delete this[name]}});
  const q=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)};
  const state={currentProject:'root-a',projectData:{detail:{project:{slug:'root-a'}}},windowGeneration:0,windowMutationBusy:false},initial={authenticated:true,email:'operator@example.test',impersonation:null};
  const context={state,initial,q,api,qa:()=>q('#release-window-list').children.flatMap(card=>card.children.filter(child=>child.tag==='button')),el(tag,className,text){return Object.assign(node(),{tag,className,textContent:text??''})},clear(element){element.children=[]},environmentCurrent(project,email){return initial.authenticated&&state.currentProject===project&&initial.email===email},handleAuthFailure(error){if(error.status===401){initial.authenticated=false;context.resetReleaseWindowView()}},environmentError(selector,error){q(selector).textContent=error.message}};
  const source=['loadReleaseWindows','mutateReleaseWindow'].map(name=>{const match=html.match(new RegExp('^async function '+name+'\\([\\s\\S]*?^\\}','m'));assert.ok(match,name);return match[0]}).join('\n')+'\n'+html.match(/^function resetReleaseWindowView\([^\n]+/m)[0];
  runInNewContext(source,context);return{...context,nodes};
}
const row={id:'window_exact_retained_001',version:1,channel:'stable',targetEnvironment:'staging',state:'pending',preview:{startsAt:'reviewed start',expiresAt:'reviewed end'},timeZone:'UTC',startsAt:'2026-11-01T06:30:00.000Z',expiresAt:'2026-11-01T06:45:00.000Z',source:{digest:'private exact artifact'},targetReleaseId:null,failureCode:null};

test('late schedule inspection cannot paint another project or a signed-out session',async()=>{
  for(const change of ['project','sign-out','credential']){
    const response=deferred(),f=await fixture(()=>response.promise),loading=f.loadReleaseWindows();
    if(change==='project')f.state.currentProject='root-b';else if(change==='sign-out')f.initial.authenticated=false;else f.initial.email='different@example.test';
    f.resetReleaseWindowView();response.resolve({schedules:[row]});await loading;
    assert.equal(f.q('#release-window-list').children.length,0);assert.equal(f.q('#release-window-status').textContent,'');
  }
});

test('an old cancellation response cannot paint after navigating away and back to the same project',async()=>{
  const response=deferred(),calls=[],f=await fixture((path,request)=>{calls.push([path,request]);return response.promise});
  const mutation=f.mutateReleaseWindow(row,'cancel',null,'root-a',f.initial.email);f.state.currentProject='root-b';f.resetReleaseWindowView();f.state.currentProject='root-a';f.resetReleaseWindowView();
  response.resolve({schedule:{...row,state:'cancelled',version:2}});await mutation;
  assert.equal(calls.length,1);assert.equal(f.q('#release-window-status').textContent,'');assert.equal(f.state.windowMutationBusy,false);
});

test('a current cancellation refresh keeps terminal schedules without restoring stale mutation buttons',async()=>{
  const calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);return request?{schedule:{...row,state:'cancelled',version:2}}:{schedules:[{...row,state:'cancelled',version:2}]}});
  await f.mutateReleaseWindow(row,'cancel',null,'root-a',f.initial.email);
  assert.equal(calls.length,2);assert.equal(calls[0][1].body.expectedVersion,1);assert.equal(calls[0][1].method,'POST');
  assert.equal(f.q('#release-window-list').children.length,1);assert.equal(f.qa().length,0);assert.match(f.q('#release-window-status').textContent,/cancelled/);assert.equal(f.state.windowMutationBusy,false);
});

test('a stale cancellation refreshes the authorized current version without sending another mutation',async()=>{
  const calls=[],f=await fixture(async(path,request)=>{calls.push([path,request]);if(request)throw new Error('Review the current schedule version.');return{schedules:[{...row,version:2,state:'running'}]}});
  await f.mutateReleaseWindow(row,'cancel',null,'root-a',f.initial.email);
  assert.equal(calls.length,2);assert.match(f.q('#release-window-error').textContent,/current schedule version/);assert.equal(f.qa().length,1);assert.equal(f.qa()[0].disabled,false);assert.equal(f.state.windowMutationBusy,false);
});
