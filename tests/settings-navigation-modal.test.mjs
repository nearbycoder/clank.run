import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {platformConsolePage} from '../dist/platform-console.js';

const html=await platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false).text();
const lines=html.split('\n');
const names=['navigate','settingsHaveDraft','confirmSettingsNavigation','requestIncidentConfirmation','finishIncidentConfirmation','clearCostView','disposeTemporaryAccess'];
const emitted=names.map(name=>{const line=lines.find(line=>line.startsWith('function '+name+'('));assert.ok(line,name);return line;}).join('\n')+'\n'+lines.find(line=>line.startsWith('q("#incident-confirm-cancel").onclick='));
function fixture(kind='cost'){
 const nodes=new Map(),document={activeElement:null};
 const q=selector=>{if(!nodes.has(selector))nodes.set(selector,{isConnected:true,hidden:false,focus(){document.activeElement=this;},showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,callback){this[name]=callback;}});return nodes.get(selector);};
 document.activeElement=q('#settings-link');const origin=document.activeElement;
 const location=new URL('http://localhost/projects/development/settings');
 const view={disposed:false,hasPendingChanges:()=>true,dispose(){this.disposed=true;}};
 const state={currentProject:'project_exact_01',projectTab:'settings',dashboard:{account:{id:'owner_exact_01'}},projectData:{detail:{access:{role:'owner'}}}};
 const initial={authenticated:true,email:'owner@example.test',authSessionId:'session_exact_01'};
 const context={state,initial,document,q,Boolean,Promise,temporaryAccessGeneration:0,temporaryAccessScope:'original',temporaryAccessView:kind==='temporary'?view:null,costView:kind==='cost'?view:null,costViewProject:'project_exact_01',clear(){},window:{location,history:{pushState(_s,_t,path){location.href=new URL(path,location).href;}}},applyRoute(){context.navigations++;},navigations:0,confirm(){throw Error('Native confirmation must not run.');}};
 runInNewContext(emitted+'\nglobalThis.ui={navigate,finishIncidentConfirmation,clearCostView,disposeTemporaryAccess};',context);
 return {context,state,initial,q,document,origin,view,ui:context.ui};
}
for(const kind of ['cost','temporary'])test(kind+' settings navigation preserves drafts on cancellation, restores focus and leaves only after review',async()=>{
 const f=fixture(kind),pending=f.ui.navigate('/overview');
 assert.equal(f.q('#incident-confirmation').open,true);assert.equal(f.document.activeElement,f.q('#incident-confirm-cancel'));assert.equal(f.context.navigations,0);
 assert.match(f.q('#incident-confirm-message').textContent,/does not retry or undo/);
 f.ui.finishIncidentConfirmation(false);await pending;assert.equal(f.document.activeElement,f.origin);assert.equal(f.view.disposed,false);assert.equal(f.context.navigations,0);
 const confirmed=f.ui.navigate('/overview');f.ui.finishIncidentConfirmation(true);await confirmed;assert.equal(f.context.navigations,1);assert.equal(f.context.window.location.pathname,'/overview');
});
for(const loss of ['account','session','project','role','replacement','disposed'])test('settings navigation cannot run after '+loss+' changes during review',async()=>{
 const f=fixture(),pending=f.ui.navigate('/overview');
 if(loss==='account')f.state.dashboard.account.id='another_exact_01';
 if(loss==='session')f.initial.authSessionId='new_session_01';
 if(loss==='project')f.state.currentProject='another_project_01';
 if(loss==='role')f.state.projectData.detail.access.role='viewer';
 if(loss==='replacement')f.context.costView={...f.view};
 if(loss==='disposed')f.view.disposed=true;
 f.ui.finishIncidentConfirmation(true);await pending;assert.equal(f.context.navigations,0);assert.equal(f.q('#incident-confirmation').open,false);
});
for(const kind of ['cost','temporary'])test(kind+' disposal cancels a queued settings navigation',async()=>{
 const f=fixture(kind),pending=f.ui.navigate('/overview');
 kind==='cost'?f.ui.clearCostView():f.ui.disposeTemporaryAccess();await pending;
 assert.equal(f.context.navigations,0);assert.equal(f.q('#incident-confirmation').open,false);assert.equal(f.view.disposed,true);
});
test('same-route settings navigation does not ask to leave, and a second destination cannot hijack a pending review',async()=>{
 const f=fixture();f.ui.navigate('/projects/development/settings');assert.equal(f.context.navigations,1);assert.equal(f.state.incidentConfirmation,undefined);
 const first=f.ui.navigate('/overview'),second=f.ui.navigate('/usage');await second;f.ui.finishIncidentConfirmation(true);await first;
 assert.equal(f.context.navigations,2);assert.equal(f.context.window.location.pathname,'/overview');
});

test('disposal of an absent unrelated panel does not cancel the cost review',async()=>{
 const f=fixture(),pending=f.ui.navigate('/overview');f.ui.disposeTemporaryAccess();
 assert.equal(f.q('#incident-confirmation').open,true);f.ui.finishIncidentConfirmation(true);await pending;assert.equal(f.context.navigations,1);
});

test('Escape through the emitted dialog handler preserves the draft and returns focus',async()=>{
 const f=fixture('temporary'),pending=f.ui.navigate('/overview');let prevented=false;f.q('#incident-confirmation').cancel({preventDefault(){prevented=true;}});await pending;
 assert.equal(prevented,true);assert.equal(f.context.navigations,0);assert.equal(f.view.disposed,false);assert.equal(f.document.activeElement,f.origin);
});
