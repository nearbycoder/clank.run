// Owned loopback platform. Browser signs in through ordinary native AuthServer HTTP.
// Signed UV assertions use an enrolled fixture key; this is not physical device certification.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './platform-environment-fixture.mjs';
import {stepUpProjectCosts} from './project-costs-step-up.mjs';
const port=Number(process.argv[2]);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Supply an owned disposable loopback port.');
const after=[],t={after(fn){after.push(fn);},diagnostic(message){console.log(message);}},origin='http://127.0.0.1:'+port;
const date=new Date(),start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1),month=new Date(start).toISOString().slice(0,7);
const ledger={source:'owned-browser-ledger',sourceRevision:'sample-01',periodStartedAt:start,observedUntil:Date.now(),meters:{storageByteMilliseconds:{units:'200',complete:true},transferBytes:{units:'300',complete:true},runtimeMilliseconds:{units:'100',complete:true}}};
const base=await fixture(t,false,{publicUrl:origin,projectCosts:{rateCards:[{id:'owned-browser-card',revision:1,currency:'USD',effectiveFrom:start,rates:{storageByteMilliseconds:{amountMinor:1,perUnits:100},transferBytes:{amountMinor:1,perUnits:100},runtimeMilliseconds:{amountMinor:1,perUnits:100}}}],measure:async({asOf})=>{ledger.observedUntil=asOf;return structuredClone(ledger);}}});
const db=new DatabaseSync(join(base.options.dataDirectory,'control.sqlite')),f={...base,db};await stepUpProjectCosts(f);
await f.call('/api/projects/'+f.development.id+'/costs/reconcile',{month,expectedVersion:0,operationId:'browser_baseline_reconcile',reason:'Owned measured baseline'});
await f.call('/api/projects/'+f.development.id+'/costs/policy',{expectedVersion:0,operationId:'browser_baseline_policy',currency:'USD',limitMinor:'100',warningPercent:80,admission:'observe',maxMeasurementAgeMs:86400000,reason:'Owned baseline observed budget'});
const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native project cost verification</title><style>body{font:16px system-ui;max-width:56rem;margin:1rem auto;padding:1rem}button{margin:8px 8px 8px 0;padding:12px;touch-action:manipulation}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #125bcc;outline-offset:3px}p,dd{overflow-wrap:anywhere}main{min-width:0}input,select{font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Native project cost verification</h1><p>Disposable browser → native authentication → project API → control SQLite. Fixture UV assertions do not certify a physical passkey device.</p><p id="fixture-status" role="status">Signing in through native HTTP…</p><button id="sign-out" type="button">Sign out of cost fixture</button><div id="view"></div></main><script type="module" src="/fixture.js"></script></html>';
const serverUrl=await f.serve(async(request,response)=>{
  const path=new URL(request.url).pathname;
  if(path==='/')return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(path==='/fixture.js')return new Response(await readFile(new URL('./project-costs-browser-client.mjs',import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  if(/^\/runtime\/[a-z0-9-]+\.js$/u.test(path))return new Response(await readFile(new URL('../../dist/'+path.slice(9),import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  const account={cookie:request.headers.get('cookie')??'',csrf:request.headers.get('x-clank-csrf')??'',user:f.owner.user};
  if(path==='/fixture/info')return Response.json({projectId:f.development.id,month});
  if(path==='/fixture/step-up'&&request.method==='POST'){
    const dashboard=await f.call('/api/dashboard',undefined,200,'GET',account);if(dashboard.account.id!==f.owner.user.id)return Response.json({ok:false},{status:403});
    await stepUpProjectCosts({...f,call:(route,body)=>f.call(route,body,200,'POST',account)});return Response.json({ok:true});
  }
  if(path==='/fixture/inspect'){
    const dashboard=await f.call('/api/dashboard',undefined,200,'GET',account);if(dashboard.account.id!==f.owner.user.id)return Response.json({ok:false},{status:403});
    return Response.json({observations:db.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,receipts:db.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,policies:db.prepare('SELECT version,policy FROM clank_project_cost_policies').all(),audit:db.prepare("SELECT action FROM clank_platform_audit WHERE action LIKE 'project.cost.%'").all()});
  }
  console.log(JSON.stringify({method:request.method,path:path.slice(0,160),status:response.status}));return response;
});
console.log(JSON.stringify({fixture:'owned-native-project-costs',url:serverUrl,root:f.root,projectId:f.development.id,month,pid:process.pid}));
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{if(closing)return;closing=true;db.close();for(const cleanup of after)await cleanup();process.exit(0);});
