import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext,Script} from 'node:vm';
import {setImmediate as immediate} from 'node:timers/promises';
import {platformConsolePage} from '../dist/platform-console.js';
const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text();
const start=html.indexOf('const sloClient='),end=html.indexOf('const incidentClient=',start);assert.ok(start>0&&end>start);
const fragment=html.slice(start,end),lines=html.split('\n');
const shared=['navigate','incidentHasDraft','requestIncidentConfirmation','finishIncidentConfirmation','confirmIncidentNavigation'].map(name=>lines.find(line=>line.startsWith('function '+name+'('))).join('\n');
const project='project_slo_exact_01',policyId='policy_slo_exact_01';
const configuration={name:'Checkout',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
const assessment=(version=1,target=9900)=>({policy:{...configuration,targetBasisPoints:target,id:policyId,projectId:project,version:version,createdAt:1000,updatedAt:1000},evaluation:{status:'insufficient-data',reason:'missing-measurements',from:1000,until:2000,coverage:{complete:false,expectedMinutes:5,coveredMinutes:0,missingMinutes:5},requests:0,good:0,bad:0,allowedBadRequests:null,remainingBudgetRequests:null,burnRate:null,burning:null},alert:null});
function fixture(){
 const nodes=new Map(),calls=[],initial={authenticated:true,email:'operator@example.test',impersonation:null,csrfToken:'csrf-current'};
 const q=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',checked:true,textContent:'',hidden:false,disabled:false,children:[],isConnected:true,dataset:{},append(...children){this.children.push(...children);},focus(){document.activeElement=this;},showModal(){this.open=true;},close(){this.open=false;},addEventListener(){},reset(){}});return nodes.get(selector);};
 const document={activeElement:q('#slo-name')},location=new URL('http://localhost/projects/development/slo');
 const state={currentProject:project,projectTab:'slo',sloScope:project+':'+initial.email,sloGeneration:0,sloRows:[],sloSelected:null,sloPending:null,sloBusy:false,sloDraftBaseline:null,projectData:{detail:{access:{canManageSlos:true}}}};
 const context={state,initial,q,document,URL,URLSearchParams,Headers,Response,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,Intl,crypto:{randomUUID:()=> 'operation_slo_ui_01'},qa(){return [];},clear(node){node.children=[];},el(tag,className,textContent){return {tag,className,textContent,dataset:{},children:[],append(...children){this.children.push(...children);}};},formatDate:String,formatNumber:String,handleAuthFailure(){},copyRenderedText(){},loadProject(){},window:{location,history:{replaceState(_state,_title,path){location.href=new URL(path,location).href;},pushState(_state,_title,path){location.href=new URL(path,location).href;}}},applyRoute(){context.navigations++;},navigations:0,fetch(url,options){return new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));}};
 runInNewContext(fragment+'\n'+shared+'\nglobalThis.ui={loadSlos,paintSloEditor,submitSloPending,resetSloWorkspace,navigate,finishIncidentConfirmation,sloHasDraft};',context);
 context.ui.paintSloEditor(assessment());return {context,initial,state,q,calls,document,ui:context.ui};
}
test('the complete emitted console parses and exposes the canonical service-objective pane',()=>{
 let scripts=0;for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)){if(/src=|application\//u.test(match[1]))continue;new Script(match[2]);scripts++;}
 assert.equal(scripts,1);assert.ok(html.includes('data-project-tab="slo"'));assert.ok(html.includes('data-tab="slo"'));assert.ok(html.includes('id="tab-slo"'));
});
test('emitted SLO console drops late account/project data and preserves the original version of an unsaved edit',async()=>{
 const f=fixture();f.q('#slo-target').value='98';const updating=f.ui.loadSlos();await immediate();f.calls[0].resolve(Response.json({ok:true,policies:[assessment(2,9950)]}));await updating;
 assert.equal(f.state.sloSelected.policy.version,1);assert.equal(f.q('#slo-target').value,'98');assert.match(f.q('#slo-error').textContent,/original expected version/);
 const late=f.ui.loadSlos();await immediate();f.initial.email='another@example.test';f.state.currentProject='project_other_exact_01';f.ui.resetSloWorkspace();f.calls[1].resolve(Response.json({ok:true,policies:[assessment(3)]}));await late;
 assert.equal(f.state.sloScope,null);assert.equal(f.state.sloSelected,null);assert.equal(f.state.sloRows.length,0);assert.equal(f.q('#slo-list').children.length,0);
});
test('SLO same-change retry preserves exact intent and paints newer current state after a historical acknowledgement',async()=>{
 const f=fixture();f.q('#slo-target').value='98';f.q('#slo-editor').onsubmit({preventDefault(){}});await immediate();const original=f.calls[0].options.body;
 assert.equal(JSON.parse(original).expectedVersion,1);f.calls[0].reject(new Error('Owned response disappeared'));await immediate();assert.ok(f.state.sloPending);assert.equal(f.state.sloBusy,false);
 const refreshing=f.ui.loadSlos();await immediate();f.calls[1].resolve(Response.json({ok:true,policies:[assessment(3,9950)]}));await refreshing;
 const retry=f.ui.submitSloPending();await immediate();assert.equal(f.calls[2].options.body,original);f.calls[2].resolve(Response.json({ok:true,policy:assessment(2,9800).policy}));await immediate();
 f.calls[3].resolve(Response.json({ok:true,assessment:assessment(3,9950)}));await immediate();f.calls[4].resolve(Response.json({ok:true,policies:[assessment(3,9950)]}));await retry;
 assert.equal(f.state.sloSelected.policy.version,3);assert.equal(f.q('#slo-target').value,'99.5');assert.equal(f.state.sloPending,null);assert.equal(f.document.activeElement,f.q('#slo-editor-title'));
});
test('SLO drafts use cancellable in-page navigation and access loss clears queued confirmation',async()=>{
 const f=fixture();f.q('#slo-name').value='Unsaved objective';const cancelled=f.ui.navigate('/overview');assert.equal(f.q('#incident-confirmation').open,true);f.ui.finishIncidentConfirmation(false);await cancelled;
 assert.equal(f.context.navigations,0);assert.equal(f.q('#slo-name').value,'Unsaved objective');
 const losingAccess=f.ui.navigate('/overview');f.ui.resetSloWorkspace();await losingAccess;assert.equal(f.context.navigations,0);assert.equal(f.state.sloScope,null);assert.equal(f.q('#incident-confirmation').open,false);
});

import {createServer} from 'node:http';
import {once} from 'node:events';
async function httpFixture(t,respond){
 const f=fixture(),requests=[],server=createServer(async(request,response)=>{const parts=[];for await(const part of request)parts.push(part);const entry={method:request.method,path:request.url,headers:request.headers,body:Buffer.concat(parts).toString()};requests.push(entry);const payload=await respond(entry,requests);response.setHeader('content-type','application/json');response.end(typeof payload==='string'?payload:JSON.stringify(payload));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 f.context.fetch=(url,options)=>fetch('http://127.0.0.1:'+server.address().port+url,options);return {...f,requests};
}
async function settled(f){const deadline=Date.now()+5000;while(f.state.sloBusy){assert.ok(Date.now()<deadline,'Owned Console request must settle');await new Promise(resolve=>setTimeout(resolve,5));}}
for(const damage of ['empty','not-ok','malformed','missing','project','id','version','configuration'])test('actual HTTP emitted Console '+damage+' acknowledgment keeps exact pending until explicit retry with fresh CSRF',async t=>{
 let posts=0;const f=await httpFixture(t,entry=>{
  if(entry.method==='GET')return entry.path.endsWith('/'+policyId)?{ok:true,assessment:assessment(3,9950)}:{ok:true,policies:[assessment(3,9950)]};
  posts++;if(posts>1)return {ok:true,policy:assessment(2,9800).policy};
  const policy=assessment(2,9800).policy;if(damage==='project')policy.projectId='project_other_01';if(damage==='id')policy.id='policy_other_01';if(damage==='version')policy.version=1;if(damage==='configuration')policy.targetBasisPoints=9950;
  return damage==='empty'?{}:damage==='not-ok'?{ok:false}:damage==='malformed'?'{':damage==='missing'?{ok:true}:{ok:true,policy};
 });
 f.q('#slo-target').value='98';f.q('#slo-editor').onsubmit({preventDefault(){}});await settled(f);
 assert.ok(f.state.sloPending);assert.equal(f.q('#slo-target').value,'98');assert.equal(posts,1);assert.equal(f.requests.length,1);assert.equal(f.requests[0].headers['x-clank-csrf'],'csrf-current');
 const original=f.requests[0].body,operation=f.state.sloPending.input.operationId;f.initial.csrfToken='csrf-rotated';await f.ui.submitSloPending();
 assert.equal(posts,2);assert.equal(f.requests[1].body,original);assert.equal(f.requests[1].headers['x-clank-csrf'],'csrf-rotated');assert.equal(JSON.parse(original).operationId,operation);assert.equal(f.state.sloPending,null);assert.equal(f.state.sloSelected.policy.version,3);assert.equal(f.q('#slo-target').value,'99.5');
});
test('actual HTTP emitted Console ignores a late mutation acknowledgment after account navigation',async t=>{
 let release,arrived;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>arrived=resolve);
 const f=await httpFixture(t,async()=>{arrived();await gate;return {ok:true,policy:assessment(2,9800).policy};});const submit=f.context.submitSloPending;let completing;f.context.submitSloPending=()=>completing=submit();f.q('#slo-target').value='98';f.q('#slo-editor').onsubmit({preventDefault(){}});await entered;
 f.initial.email='different@example.test';f.state.currentProject='project_other_01';f.ui.resetSloWorkspace();release();assert.ok(completing);await completing;
 assert.equal(f.requests.length,1);assert.equal(f.state.sloPending,null);assert.equal(f.state.sloSelected,null);assert.equal(f.state.sloScope,null);assert.equal(f.document.activeElement,f.q('#slo-name'));
});
