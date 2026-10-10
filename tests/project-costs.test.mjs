import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {defineDatabase,defineTable,openSQLite} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {openPlatformProjectCosts,ProjectCostError} from '../dist/platform-project-costs.js';

const start=Date.UTC(2026,9,1),month='2026-10',project='project_native_cost_01';
const schema=defineDatabase({items:defineTable({text:s.string()})});
const rateCard=()=>({id:'operator-native',revision:1,currency:'USD',effectiveFrom:start,rates:{storageByteMilliseconds:{amountMinor:3,perUnits:2},transferBytes:{amountMinor:1,perUnits:3},runtimeMilliseconds:{amountMinor:5,perUnits:10}}});
const meters=(storage='2',transfer='3',runtime='10',complete=true)=>Object.fromEntries(['storageByteMilliseconds','transferBytes','runtimeMilliseconds'].map((name,index)=>[name,{units:[storage,transfer,runtime][index],complete:[storage,transfer,runtime][index]===null?false:complete}]));
const code=expected=>error=>error instanceof ProjectCostError&&error.code===expected;
async function fixture(t,extra={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-project-costs-')),path=join(root,'control.sqlite');let database,costs,at=start+60_000,enabled=true,calls=0;
  const source={source:'native-fixture-counter',sourceRevision:'revision_01',periodStartedAt:start,observedUntil:at,meters:meters()};
  const audit=[];const authority={actorId:'human_cost_admin',authorize(){if(!enabled)throw new ProjectCostError(403,'COST_REVOKED','Revoked fixture authority.');},audit(action,metadata){audit.push({action,metadata});}};
  const options={rateCards:[rateCard()],measure:async()=>{calls++;return structuredClone(source);},...extra};
  const reopen=async(config=options)=>{costs?.close();database?.close();database=await openSQLite(schema,{path});costs=openPlatformProjectCosts(database[SQLITE_INTERNAL],config,()=>at);};
  await reopen();t.after(async()=>{costs?.close();database?.close();await rm(root,{recursive:true,force:true});});
  return {root,path,source,audit,authority,options,reopen,get costs(){return costs;},get sql(){return database[SQLITE_INTERNAL];},get calls(){return calls;},setTime(value){at=value;},revoke(){enabled=false;},reconcile(expectedVersion=0,operationId='reconcile_native_01',reason='Measured native fixture'){return costs.reconcile(project,authority,{month,expectedVersion,operationId,reason});},policy(overrides={}){return costs.changePolicy(project,authority,{expectedVersion:0,operationId:'budget_native_01',currency:'USD',limitMinor:'10',warningPercent:80,admission:'deny-at-observed-limit',maxMeasurementAgeMs:10_000,reason:'Reviewed test budget',...overrides});}};
}
test('native cumulative components expose exact arithmetic, measured zero and unavailable cost distinctly',async t=>{
  const f=await fixture(t),first=await f.reconcile();assert.equal(first.amountMinor,'9');assert.equal(first.components[0].numerator,'6');assert.equal(first.components[0].denominator,2);
  f.source.sourceRevision='revision_02';f.source.meters=meters('0','0','0');const zero=await f.reconcile(1,'reconcile_zero_02');assert.equal(zero.amountMinor,'0');
  f.source.sourceRevision='revision_03';f.source.meters=meters('0',null,'10');const unknown=await f.reconcile(2,'reconcile_unknown_03');assert.equal(unknown.amountMinor,null);assert.equal(unknown.knownAmountMinor,'5');assert.equal(unknown.components[1].amountMinor,null);
  f.source.sourceRevision='revision_04';f.source.meters=meters('3','4','11');const rounded=await f.reconcile(3,'reconcile_round_04');assert.deepEqual(rounded.components.map(c=>c.amountMinor),['5','2','6']);assert.equal(rounded.amountMinor,'13');
});
test('native corrections replace cumulative quantities, retain history and replay exact acknowledgment after reopen',async t=>{
  const f=await fixture(t),initial=await f.reconcile();f.source.sourceRevision='correction_02';f.source.meters=meters('1','0','0');const corrected=await f.reconcile(1,'correction_exact_02','Correct measured transfer duplication');assert.equal(corrected.amountMinor,'2');
  await f.reopen();const calls=f.calls;assert.deepEqual(await f.reconcile(1,'correction_exact_02','Correct measured transfer duplication'),corrected);assert.equal(f.calls,calls);assert.equal(f.costs.read(project,f.authority,month).snapshot.version,2);
  assert.deepEqual(f.costs.history(project,f.authority,month),[corrected,initial]);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,2);
  await assert.rejects(f.reconcile(1,'correction_exact_02','Changed intent'),code('COST_RETRY_CHANGED'));await assert.rejects(f.reconcile(1,'other_stale_03'),code('COST_STALE'));
});
test('exact quantities above Number precision retain integer arithmetic without floating point',async t=>{
  const f=await fixture(t);f.source.meters=meters('9007199254740993','0','0');const value=await f.reconcile();assert.equal(value.components[0].numerator,'27021597764222979');assert.equal(value.amountMinor,'13510798882111490');
});
test('retained rate cards cannot change and new cards cannot reprice an accepted month',async t=>{
  const f=await fixture(t),first=await f.reconcile(),changed=rateCard();changed.rates.runtimeMilliseconds.amountMinor=999;
  await assert.rejects(f.reopen({...f.options,rateCards:[changed]}),code('COST_RATE_CHANGED'));await f.reopen();
  const future={...rateCard(),id:'operator-next',revision:2,effectiveFrom:Date.UTC(2026,10,1)};future.rates={...future.rates,runtimeMilliseconds:{amountMinor:999,perUnits:1}};
  await f.reopen({...f.options,rateCards:[rateCard(),future]});f.source.sourceRevision='correct_after_rate';assert.deepEqual((await f.reconcile(1,'same_month_rate_02')).rateCard,first.rateCard);
});
test('native observed-budget admission rejects missing, stale and exhausted coverage; expiry and policy changes revoke overrides',async t=>{
  const f=await fixture(t);assert.equal(f.costs.admission(project).allowed,true);const policy=f.policy();assert.equal(f.costs.admission(project).allowed,false);
  await f.reconcile();assert.equal(f.costs.read(project,f.authority).status,'warning');assert.equal(f.costs.admission(project).allowed,true);
  f.setTime(start+80_000);assert.equal(f.costs.read(project,f.authority).status,'stale');assert.equal(f.costs.admission(project).allowed,false);
  const input={expectedVersion:0,policyVersion:policy.version,operationId:'override_native_01',expiresAt:start+90_000,reason:'Bounded incident recovery'};
  assert.equal(f.costs.changeOverride(project,f.authority,input).active,true);assert.equal(f.costs.read(project,f.authority).admission,'overridden');
  f.setTime(start+91_000);assert.equal(f.costs.admission(project).allowed,false);assert.equal(f.costs.changeOverride(project,f.authority,input).active,false);
  await f.reopen(undefined);assert.equal(f.costs.admission(project).allowed,false);
  f.policy({expectedVersion:1,operationId:'policy_after_override_02',limitMinor:'1'});assert.equal(f.costs.read(project,f.authority).override.active,false);
});
test('disabling the trusted collector preserves stored deny policy across native reopen',async t=>{
  const f=await fixture(t);f.policy();await f.reconcile();f.setTime(start+80_000);await f.reopen(null);assert.equal(f.costs.admission(project).allowed,false);
  await assert.rejects(f.reconcile(1,'disabled_collect_02'),code('COST_COLLECTOR_DISABLED'));
});
test('current authorization is rechecked after a real held collector before any persistent observation',async t=>{
  let ready,release;const entered=new Promise(resolve=>ready=resolve),held=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{measure:async()=>{ready();await held;return f.source;}});const pending=f.reconcile();await entered;f.revoke();release();await assert.rejects(pending,code('COST_REVOKED'));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,0);
});
test('concurrent native reconciliation commits one revision and rejects the other changed operation',async t=>{
  let entered=0,release;const held=new Promise(resolve=>release=resolve);let ready;const all=new Promise(resolve=>ready=resolve);
  const f=await fixture(t,{measure:async()=>{if(++entered===2)ready();await held;return f.source;}});
  const a=f.reconcile(0,'concurrent_cost_a'),b=f.reconcile(0,'concurrent_cost_b');const results=Promise.allSettled([a,b]);await all;release();const out=await results;
  assert.equal(out.filter(r=>r.status==='fulfilled').length,1);assert.ok(code('COST_STALE')(out.find(r=>r.status==='rejected').reason));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_receipts').get().n,1);
});
test('ignored receipt rolls back native observation and policy with no acknowledged change',async t=>{
  const f=await fixture(t);f.sql.exec('CREATE TRIGGER cost_ignore_receipt BEFORE INSERT ON clank_project_cost_receipts BEGIN SELECT RAISE(IGNORE); END');
  await assert.rejects(f.reconcile(),code('COST_WRITE_FAILED'));assert.throws(()=>f.policy(),code('COST_WRITE_FAILED'));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_policies').get().n,0);
});
test('ignored observation and altered policy are refused and rolled back by native acknowledgment checks',async t=>{
  const f=await fixture(t);f.sql.exec('CREATE TRIGGER cost_ignore_observation BEFORE INSERT ON clank_project_cost_observations BEGIN SELECT RAISE(IGNORE); END');
  await assert.rejects(f.reconcile(),code('COST_WRITE_FAILED'));f.sql.exec('DROP TRIGGER cost_ignore_observation');
  f.sql.exec("CREATE TRIGGER cost_alter_policy AFTER INSERT ON clank_project_cost_policies BEGIN UPDATE clank_project_cost_policies SET version=99; END");assert.throws(()=>f.policy(),code('COST_WRITE_FAILED'));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_policies').get().n,0);
});
test('bounded noncooperative collector timeout and later completion have no durable effects',async t=>{
  let release;const held=new Promise(resolve=>release=resolve);const f=await fixture(t,{timeoutMs:100,measure:async()=>{await held;return f.source;}});
  await assert.rejects(f.reconcile(),code('COST_COLLECTOR_TIMEOUT'));release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,0);
});
test('unsupported storage protocol blocks admission and survives reopen without being reset',async t=>{
  const f=await fixture(t);f.policy();f.sql.exec('UPDATE clank_project_cost_state SET protocol=2');assert.throws(()=>f.costs.admission(project),code('COST_PROTOCOL_UNSUPPORTED'));await assert.rejects(f.reopen(),code('COST_PROTOCOL_UNSUPPORTED'));assert.equal(f.sql.prepare('SELECT protocol FROM clank_project_cost_state').get().protocol,2);
});
test('corrupt retained receipt and prior observation fail closed on replay and history',async t=>{
  const f=await fixture(t);await f.reconcile();f.source.sourceRevision='later_02';await f.reconcile(1,'later_cost_02');
  f.sql.prepare("UPDATE clank_project_cost_receipts SET result=json_set(result,'$.amountMinor','0') WHERE operation_id=?").run('reconcile_native_01');await assert.rejects(f.reconcile(),code('COST_STORAGE_INVALID'));
  f.sql.exec("UPDATE clank_project_cost_observations SET snapshot=json_set(snapshot,'$.knownAmountMinor','0') WHERE version=1");assert.throws(()=>f.costs.history(project,f.authority,month),code('COST_STORAGE_INVALID'));
});
test('unknown rate period and altered stored effective dates cannot fabricate a price',async t=>{
  const f=await fixture(t);f.sql.exec('UPDATE clank_project_cost_rates SET effective_from=effective_from+1');await assert.rejects(f.reconcile(),code('COST_RATE_UNAVAILABLE'));
  f.sql.exec('UPDATE clank_project_cost_rates SET effective_from=effective_from-2');await assert.rejects(f.reconcile(),code('COST_RATE_CHANGED'));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_project_cost_observations').get().n,0);
});
