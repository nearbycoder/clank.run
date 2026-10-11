import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {stepUpProjectCosts as stepUp} from './fixtures/project-costs-step-up.mjs';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';
import {createProjectCostClient} from '../dist/project-costs.js';
import {createProjectCostMcpTools} from '../dist/project-costs.js';
import {createMcpServer} from '../dist/mcp.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

async function setup(t,changes={},platformOptions={}) {
  const at=Date.now(),d=new Date(at),start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1),month=new Date(start).toISOString().slice(0,7);
  const ledger={source:'owned-host-measurements',sourceRevision:'sample_01',periodStartedAt:start,observedUntil:at,meters:{storageByteMilliseconds:{units:'200',complete:true},transferBytes:{units:'300',complete:true},runtimeMilliseconds:{units:'100',complete:true}}};
  let calls=0;
  const costs={rateCards:[{id:'owned-operator-card',revision:1,currency:'USD',effectiveFrom:start,rates:{storageByteMilliseconds:{amountMinor:1,perUnits:100},transferBytes:{amountMinor:1,perUnits:100},runtimeMilliseconds:{amountMinor:1,perUnits:100}}}],measure:async({asOf})=>{calls++;ledger.observedUntil=asOf;return structuredClone(ledger);},...changes};
  const publicPorts=await reservePlatformTestPorts();
  const base=await fixture(t,false,{publicUrl:`http://127.0.0.1:${publicPorts.start}`,projectCosts:costs,serviceAccounts:{},...platformOptions}),db=new DatabaseSync(join(base.options.dataDirectory,'control.sqlite'));t.after(()=>publicPorts.release());t.after(()=>db.close());
  const f={...base,db,ledger,month,path:`/api/projects/${base.development.id}/costs`,costs,get calls(){return calls;}};
  const origin=await f.serve();f.origin=origin;
  f.client=(account=f.owner,transport=fetch)=>createProjectCostClient({url:origin,headers:()=>({cookie:account.cookie,origin:f.options.publicUrl,'x-clank-csrf':account.csrf}),fetch:async(...args)=>{
    const response=await transport(...args);
    if(!response.ok){const problem=await response.clone().json();t.diagnostic(JSON.stringify({status:response.status,error:problem.error}));}
    return response;
  }});
  f.intent=(expectedVersion=0,operationId='cost_http_reconcile_01')=>({month,expectedVersion,operationId,reason:'Reconcile controlled measured usage'});
  f.policy=()=>({expectedVersion:0,operationId:'cost_http_policy_01',currency:'USD',limitMinor:'5',warningPercent:80,admission:'deny-at-observed-limit',maxMeasurementAgeMs:60_000,reason:'Reviewed observed traffic budget'});
  return f;
}
test('actual native HTTP costs require signed fresh human authority and isolate project reads',async t=>{
  const f=await setup(t),client=f.client();await assert.rejects(client.reconcile(f.development.id,f.intent()),error=>error.status===403);assert.equal(f.calls,0);
  await stepUp(f);const measured=await client.reconcile(f.development.id,f.intent());assert.equal(measured.amountMinor,'6');assert.equal(measured.projectId,f.development.id);
  const other=await f.account('foreign-cost-reader@example.test');await assert.rejects(f.client(other).read(f.development.id),error=>error.status===404);assert.equal((await client.read(f.staging.id)).snapshot,null);
  const denied=await fetch(f.origin+f.path+'/policy',{method:'POST',headers:{cookie:f.owner.cookie,origin:f.options.publicUrl,'content-type':'application/json'},body:JSON.stringify(f.policy())});assert.equal(denied.status,403);
  const rows=f.db.prepare("SELECT metadata FROM clank_platform_audit WHERE action='project.cost.reconcile'").all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(f.owner.cookie));
});
test('actual lost HTTP acknowledgment and native controller reopen preserve one correction and exact rate identity',async t=>{
  const f=await setup(t);await stepUp(f);let lost=true;
  const client=f.client(f.owner,async(...args)=>{const response=await fetch(...args);if(lost&&new URL(args[0]).pathname.endsWith('/costs/reconcile')&&response.ok){lost=false;await response.clone().arrayBuffer();throw new Error('Owned fixture loses an actually committed response.');}return response;});
  await assert.rejects(client.reconcile(f.development.id,f.intent()),/actually committed/);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,1);
  await f.restart();const acknowledged=await client.reconcile(f.development.id,f.intent());assert.equal(acknowledged.version,1);assert.equal(f.calls,1);
  f.ledger.sourceRevision='corrected_sample_02';f.ledger.meters.transferBytes.units='100';const correction=await client.reconcile(f.development.id,f.intent(1,'cost_correction_02'));assert.equal(correction.amountMinor,'4');assert.deepEqual(correction.rateCard,acknowledged.rateCard);
  const history=await client.history(f.development.id,f.month);assert.deepEqual(history.map(row=>row.amountMinor),['4','6']);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,2);
});
test('real native ingress retains measured-budget blocks and audited override behavior across restart',async t=>{
  const f=await setup(t);await stepUp(f);const client=f.client(),artifact=await f.artifact('cost-admission-runtime');await f.upload(f.development,artifact,'cost_native_release_01');
  await f.probe(f.development);await client.policy(f.development.id,f.policy());await f.probe(f.development,'/',429);
  await client.reconcile(f.development.id,f.intent());const report=await client.read(f.development.id);assert.equal(report.status,'exhausted');assert.equal(report.admission,'blocked');
  const temporary=await client.override(f.development.id,{expectedVersion:0,policyVersion:1,operationId:'cost_http_override_01',expiresAt:Date.now()+60_000,reason:'Bounded recovery traffic'});assert.equal(temporary.active,true);await f.probe(f.development);
  await f.restart();await f.probe(f.development);await client.override(f.development.id,{expectedVersion:1,policyVersion:1,operationId:'cost_http_revoke_02',expiresAt:0,reason:'Recovery traffic complete'});await f.probe(f.development,'/',429);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='project.cost.override'").get().n,2);
});
test('actual HTTP collector await revalidates native session revocation with no cost commit',{timeout:15000},async t=>{
  let ready,release;const entered=new Promise(resolve=>ready=resolve),held=new Promise(resolve=>release=resolve);let f;
  f=await setup(t,{measure:async()=>{ready();await held;return structuredClone(f.ledger);}});await stepUp(f);const pending=f.client().reconcile(f.development.id,f.intent());const rejected=assert.rejects(pending,error=>error.status===401||error.status===403);
  await entered;await f.call('/__clank/auth/logout',{});release();await rejected;assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,0);
});
test('native machine read scopes expose only authorized cost metadata and cannot change budgets',async t=>{
  const f=await setup(t);await stepUp(f);await f.client().reconcile(f.development.id,f.intent());const org=f.development.organizationId,path=`/api/organizations/${org}/service-accounts`;
  const account=(await f.call(path,{name:'Cost reader',ownerId:f.owner.user.id,operationId:'cost_machine_create_01'},201)).account;
  const issued=(await f.call(`${path}/${account.id}/credentials`,{projectId:f.development.id,permissions:['read'],expiresAt:Date.now()+600_000,expectedVersion:account.version,operationId:'cost_machine_issue_01'},201)).issued;
  const machine=createProjectCostClient({url:f.origin,headers:()=>({authorization:'Bearer '+issued.accessToken})});assert.equal((await machine.read(f.development.id)).snapshot.amountMinor,'6');assert.equal((await machine.history(f.development.id,f.month)).length,1);
  await assert.rejects(machine.read(f.staging.id),error=>error.status===404);await assert.rejects(machine.policy(f.development.id,f.policy()),error=>error.status===403);
  const mcp=createMcpServer({name:'owned-project-cost-tools',tools:createProjectCostMcpTools((_context,request)=>createProjectCostClient({url:f.origin,headers:()=>({authorization:request.headers.get('authorization')??''})})),authenticate:async request=>{
    try {const principal=await f.authenticateServiceAccount(request);principal.assertCurrent();return {context:principal.identity,scopes:new Set(['agent:read'])};}catch{return null;}
  }});
  const rpc=async(method,params)=>{const response=await mcp.handle(new Request(f.origin+'/owned-cost-mcp',{method:'POST',headers:{authorization:'Bearer '+issued.accessToken,'content-type':'application/json',accept:'application/json','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'owned-cost-fixture',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));return {status:response.status,data:await response.json()};};
  const listed=await rpc('tools/list',{});assert.equal(listed.status,200,JSON.stringify(listed.data));assert.deepEqual(listed.data.result.tools.map(tool=>tool.name),['project_costs_history','project_costs_read']);assert.ok(listed.data.result.tools.every(tool=>tool.annotations.readOnlyHint));
  const invoked=await rpc('tools/call',{name:'project_costs_read',arguments:{projectId:f.development.id}});assert.equal(invoked.data.result.structuredContent.report.snapshot.amountMinor,'6');
  assert.equal((await rpc('tools/call',{name:'project_costs_history',arguments:{projectId:f.development.id,month:f.month}})).data.result.structuredContent.snapshots.length,1);
  assert.equal((await rpc('tools/call',{name:'project_costs_read',arguments:{projectId:f.staging.id}})).data.result.isError,true);
  assert.equal((await rpc('tools/call',{name:'project_costs_read',arguments:{projectId:f.development.id,meters:{transferBytes:'0'}}})).data.result.isError,true);
  const config=join(f.root,'owned-cli-config'),linked=join(f.root,'owned-linked-costs');await mkdir(config,{mode:0o700});await mkdir(join(linked,'.clank'),{recursive:true,mode:0o700});
  await writeFile(join(config,'config.json'),JSON.stringify({version:1,current:f.origin,profiles:{[f.origin]:{token:issued.accessToken,expiresAt:issued.credential.expiresAt}}}),{mode:0o600});
  await writeFile(join(linked,'.clank/project.json'),JSON.stringify({version:1,server:f.origin,projectId:f.development.id}),{mode:0o600});
  const cli=async args=>{const child=spawn(process.execPath,[new URL('../scripts/clank.mjs',import.meta.url).pathname,'costs',...args],{cwd:linked,env:{...process.env,CLANK_HOME:config},stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.ok(!output.includes(issued.accessToken));assert.ok(!error.includes(issued.accessToken));return {code,output,error};};
  const cliRead=await cli(['--json']);assert.equal(cliRead.code,0,cliRead.error);assert.equal(JSON.parse(cliRead.output).report.snapshot.amountMinor,'6');
  const cliHistory=await cli(['--history','--month',f.month,'--json']);assert.equal(cliHistory.code,0,cliHistory.error);assert.equal(JSON.parse(cliHistory.output).snapshots.length,1);
  assert.notEqual((await cli(['--history','--json'])).code,0);assert.notEqual((await cli(['--month','2026-13','--json'])).code,0);
  f.db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(org,f.owner.user.id);await assert.rejects(machine.read(f.development.id),error=>error.status===403);
  assert.equal((await rpc('tools/list',{})).status,401);assert.notEqual((await cli(['--json'])).code,0);
});

test('native operational alerts distinguish unknown, exhausted, corrected and retained project costs',async t=>{
  const f=await setup(t,{}, {operations:{intervalMs:false},platformAdminEmails:['promotion-owner@example.test']});await stepUp(f);await f.client().policy(f.development.id,f.policy());
  const alerts=async()=>{const result=await f.call('/api/admin/operations/run',{});return result.alerts.filter(alert=>alert.kind==='cost_budget'&&alert.state==='open');};
  let active=await alerts();assert.equal(active.length,1);assert.equal(active[0].severity,'warning');
  await f.client().reconcile(f.development.id,f.intent());active=await alerts();assert.equal(active.length,1);assert.equal(active[0].severity,'critical');
  await f.restart();active=await alerts();assert.equal(active.length,1);assert.equal(active[0].resourceId,f.development.id);
  for(const meter of Object.values(f.ledger.meters))meter.units='100';f.ledger.sourceRevision='corrected_02';await f.client().reconcile(f.development.id,f.intent(1,'cost_alert_correct_02'));assert.equal((await alerts()).length,0);
  f.ledger.meters.runtimeMilliseconds={units:null,complete:false};f.ledger.sourceRevision='coverage_gap_03';await f.client().reconcile(f.development.id,f.intent(2,'cost_alert_gap_03'));active=await alerts();assert.equal(active.length,1);assert.equal(active[0].severity,'warning');
  const foreign=await f.account('cost-alert-foreign@example.test');await f.call('/api/admin/operations',undefined,403,'GET',foreign);
});

for(const mode of ['ignored','altered'])test('native '+mode+' audit acknowledgment rolls back budget and exact receipt',async t=>{
  const f=await setup(t);await stepUp(f);
  if(mode==='ignored')f.db.exec("CREATE TRIGGER cost_audit_ignore BEFORE INSERT ON clank_platform_audit WHEN NEW.action LIKE 'project.cost.%' BEGIN SELECT RAISE(IGNORE); END");
  else f.db.exec("CREATE TRIGGER cost_audit_alter AFTER INSERT ON clank_platform_audit WHEN NEW.action LIKE 'project.cost.%' BEGIN UPDATE clank_platform_audit SET metadata=json_set(metadata,'$.reason','altered') WHERE id=NEW.id; END");
  await assert.rejects(f.client().policy(f.development.id,f.policy()),error=>error.status===503);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_policies').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action LIKE 'project.cost.%'").get().n,0);
});
