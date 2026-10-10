import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,runInNewContext} from 'node:vm';
import {platformConsolePage} from '../dist/platform-console.js';
async function source() {return platformConsolePage('http://localhost',{user:null,csrfToken:null},'',false,false,{platformRole:null,impersonation:null,organizationSecurityEnabled:true}).text();}
test('the complete rendered native console script parses after adding policy and factor controls',async()=>{
  const html=await source(),script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];assert.ok(script);assert.doesNotThrow(()=>new Script(script));
});
test('a held dashboard response cannot republish private workspace/policy discovery after sign-out or account replacement',async()=>{
  const html=await source(),load=html.match(/^async function loadDashboard\([^\n]+/mu)?.[0];assert.ok(load);
  for(const replacement of [false,true]) {
    let release;const response=new Promise(resolve=>release=resolve),renders=[];
    const initial={authenticated:true,email:'old@example.test',authUserId:'old-account',authSessionId:'old-session',csrfToken:'old-csrf'},state={dashboard:null};
    const context={initial,state,api:()=>response,renderDashboard:()=>renders.push(state.dashboard),toast(){throw new Error('Obsolete response produced a notification');},handleAuthFailure(){throw new Error('Obsolete response changed authentication');}};
    runInNewContext(load,context);const pending=context.loadDashboard();initial.authenticated=replacement;if(replacement)Object.assign(initial,{email:'new@example.test',authUserId:'new-account',authSessionId:'new-session',csrfToken:'new-csrf'});
    release({account:{id:'old-account'},organizations:[{id:'private-old-workspace'}],securityRemediation:[{id:'private-remediation'}]});await pending;assert.equal(state.dashboard,null);assert.deepEqual(renders,[]);
  }
});
test('overlapping dashboard reads retain the current result and cannot replace it with an earlier snapshot',async()=>{
  const html=await source(),load=html.match(/^async function loadDashboard\([^\n]+/mu)?.[0],responses=[];
  const initial={authenticated:true,email:'owner@example.test',authUserId:'owner-account',authSessionId:'owner-session',csrfToken:'owner-csrf'},state={dashboard:null},renders=[];
  const context={initial,state,api:()=>new Promise(resolve=>responses.push(resolve)),renderDashboard:()=>renders.push(state.dashboard),toast(){},handleAuthFailure(){return false;}};
  runInNewContext(load,context);const first=context.loadDashboard(true),second=context.loadDashboard(true),newer={account:{id:'owner-account'},currentVersion:2};responses[1](newer);await second;responses[0]({account:{id:'owner-account'},currentVersion:1});await first;
  assert.equal(state.dashboard,newer);assert.deepEqual(renders,[newer]);
});
