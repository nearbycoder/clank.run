import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {setImmediate as immediate} from 'node:timers/promises';
import {platformConsolePage} from '../dist/platform-console.js';

const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text();
const start=html.indexOf('const incidentClient='),end=html.indexOf('function renderRuntimePolicy(',start);assert.ok(start>0&&end>start);
const fragment=html.slice(start,end),navigate=html.split('\n').find(line=>line.startsWith('function navigate('));assert.ok(navigate);
const project='project_exact_01',id='incident_exact_01';
function fixture(){
  const nodes=new Map(),calls=[],initial={authenticated:true,email:'operator@example.test',impersonation:null,csrfToken:'csrf-current'};
  const q=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',hidden:false,disabled:false,children:[],isConnected:true,append(...children){this.children.push(...children);},setAttribute(name,value){this[name]=value;},focus(){document.activeElement=this;this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,callback){this[name]=callback;},reset(){}});return nodes.get(selector);};
  const document={activeElement:q('#incident-note')},location=new URL('http://localhost/projects/development/incidents');
  const state={currentProject:project,projectTab:'incidents',incidentScope:project+':'+initial.email,incidentGeneration:0,incidentOwners:[{userId:'operator_exact_01',label:initial.email}],incidentRows:[],incidentNext:null,incidentBusy:false,incidentPending:null,incidentDetail:null,projectData:{detail:{access:{canUseIncidents:true}}}};
  const context={initial,state,q,document,URL,URLSearchParams,Headers,Response,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'operation_exact_ui_01'},
    clear(node){node.children=[];},el(tag,className,textContent){return {tag,className,textContent,children:[],append(...children){this.children.push(...children);}};},qa(){return [];},formatDate:String,formatNumber:String,handleAuthFailure(){},
    window:{location,history:{replaceState(_state,_title,path){location.href=new URL(path,location).href;},pushState(_state,_title,path){location.href=new URL(path,location).href;}}},applyRoute(){context.navigations++;},navigations:0,
    fetch(url,options){return new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));},
  };
  runInNewContext(fragment+'\n'+navigate+'\nglobalThis.ui={loadIncidents,readIncident,mutateIncident,retryIncident,resetIncidentWorkspace,navigate,finishIncidentConfirmation};',context);
  return {context,initial,state,q,calls,ui:context.ui,document};
}
const detail=(version=1,state='open')=>({incident:{id,projectId:project,title:'Recovery',severity:'critical',state,ownerId:null,version,updatedAt:1000,noteCount:1,linkCount:0},notes:[{sequence:1,authorId:'operator_exact_01',createdAt:1000,text:'Current recovery note.'}],nextNotes:null,links:[],nextLinks:null});

test('the emitted incident console refuses late detail responses after an account or project boundary',async()=>{
  const f=fixture(),pending=f.ui.readIncident(id,true);await immediate();assert.equal(f.calls.length,1);
  f.initial.email='other@example.test';f.ui.resetIncidentWorkspace();f.calls[0].resolve(Response.json({ok:true,detail:detail()}));await pending;
  assert.equal(f.state.incidentDetail,null);assert.equal(f.q('#incident-detail').hidden,true);assert.equal(f.q('#incident-detail-title').textContent,'');assert.equal(f.q('#incident-note').value,'');
});

test('an accessible emitted in-page dialog preserves a cancelled draft and explicitly allows navigation',async()=>{
  const f=fixture();f.q('#incident-note').value='Keep this recovery draft.';
  const cancelled=f.ui.navigate('/overview',false,true);assert.equal(f.q('#incident-confirmation').open,true);assert.equal(f.document.activeElement,f.q('#incident-confirm-cancel'));assert.equal(f.context.navigations,0);
  f.ui.finishIncidentConfirmation(false);await cancelled;assert.equal(f.q('#incident-note').value,'Keep this recovery draft.');assert.equal(f.q('#incident-confirmation').open,false);assert.equal(f.context.navigations,0);
  const accepted=f.ui.navigate('/overview');f.ui.finishIncidentConfirmation(true);await accepted;assert.equal(f.context.navigations,1);assert.equal(f.context.window.location.pathname,'/overview');
});

test('access loss closes an outstanding confirmation and prevents its queued navigation',async()=>{
  const f=fixture();f.q('#incident-note').value='Private pending note.';const pending=f.ui.navigate('/overview');assert.equal(f.q('#incident-confirmation').open,true);
  f.ui.resetIncidentWorkspace();await pending;assert.equal(f.context.navigations,0);assert.equal(f.q('#incident-confirmation').open,false);assert.equal(f.state.incidentScope,null);assert.equal(f.q('#incident-note').value,'');
});

test('lost-response retries keep exact emitted request identity and read current state rather than the old receipt',async()=>{
  const f=fixture();f.state.incidentDetail=detail();
  const first=f.ui.mutateIncident({kind:'note',text:'Verified recovery.'});await immediate();const request=f.calls[0];request.reject(new Error('Owned lost response'));await first;
  assert.ok(f.state.incidentPending);assert.equal(f.q('#incident-retry-panel').hidden,false);
  const retry=f.ui.retryIncident();await immediate();assert.equal(f.calls[1].options.body,request.options.body);f.calls[1].resolve(Response.json({ok:true,incident:detail(2).incident}));await immediate();
  assert.match(f.calls[2].url,/incident_exact_01$/);f.calls[2].resolve(Response.json({ok:true,detail:detail(3,'resolved')}));await immediate();
  const list=f.calls.find(call=>call.url.endsWith('incidents?limit=25')),owners=f.calls.find(call=>call.url.endsWith('incidents/owners'));assert.ok(list&&owners);list.resolve(Response.json({ok:true,incidents:[detail(3,'resolved').incident],next:null}));owners.resolve(Response.json({ok:true,owners:[]}));await immediate();
  const refresh=f.calls.at(-1);assert.match(refresh.url,/incident_exact_01$/);refresh.resolve(Response.json({ok:true,detail:detail(3,'resolved')}));await retry;
  assert.equal(f.state.incidentDetail.incident.version,3);assert.equal(f.state.incidentDetail.incident.state,'resolved');assert.equal(f.state.incidentPending,null);assert.equal(f.q('#incident-retry-panel').hidden,true);assert.equal(f.q('#incident-status').textContent,'Incident saved. Current state is shown.');
});
