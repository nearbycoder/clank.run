import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openProjectSlos} from '../src/platform-slo.ts';
import {createManagedIngress} from '../dist/data-plane.js';
import {createServer} from 'node:http';
const internal=Symbol.for('clank.sqlite.internal'),project='project_slo_exact_01',other='project_slo_other_01';
const configuration={name:'Request success',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
async function setup(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'clank-slo-controller-')),schema=defineDatabase({}),database=await openSQLite(schema,{path:join(root,'control.sqlite')}),sql=database[internal];
 sql.exec('CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)');for(const value of [project,other])sql.prepare('INSERT INTO clank_platform_projects VALUES(?,0)').run(value);
 let now=20*86400000,mono=0,auditFailure=false,authorized=true;
 const errors=[],clock={wall:()=>now,monotonic:()=>mono},hooks={collecting:true,manual:true,clock,onError:error=>errors.push(error)};
 const controller=openProjectSlos(sql,options,hooks);
 const authority={userId:'actor_slo_exact_01',authorize(){if(!authorized)throw new Error('Current access revoked.');},audit(){if(auditFailure)throw new Error('Owned SLO audit failure.');}};
 const controllers=[controller],databases=[database];
 t.after(()=>{for(const value of controllers)value.close();for(const value of databases)value.close();return rm(root,{recursive:true,force:true});});
 const tick=(milliseconds=1000)=>{now+=milliseconds;mono+=milliseconds;return controller.pulse();};
 const outcome=(statusCode=200,durationMs=100,responseOutcome='complete')=>controller.record({projectId:project,routeId:'route_slo_exact_01',method:'GET',statusCode,durationMs,responseOutcome,recordedAt:0,requestBytes:0,responseBytes:0,admitted:true});
 const fresh=async()=>{const db=await openSQLite(schema,{path:join(root,'control.sqlite')}),c=openProjectSlos(db[internal],options,hooks);databases.push(db);controllers.push(c);return c;};
 return {controller,authority,sql,clock,errors,tick,outcome,fresh,now:()=>now,jump(wall,monotonic=wall){now+=wall;mono+=monotonic;},failAudit(value){auditFailure=value;},revoke(){authorized=false;}};
}
const create=f=>f.controller.create(project,f.authority,{configuration,operationId:'slo_create_exact_01'});
async function traffic(f,status=200){
 // Each 1-second pulse is a deterministic replay of collector wall/monotonic clocks.
 for(let second=1;second<=360;second++){f.tick();if(second>=60&&second<360&&second%60===0)for(let i=0;i<100;i++)f.outcome(i<5?status:200);}
}
test('sole persistent SLO collector seals known-zero minutes and records real terminal fractions',async t=>{
 const f=await setup(t),policy=create(f);await traffic(f,503);
 const current=f.controller.read(project,policy.id,f.authority);
 assert.equal(current.evaluation.coverage.complete,true);assert.deepEqual([current.evaluation.requests,current.evaluation.good,current.evaluation.bad,current.evaluation.burnRate,current.alert.state],[500,475,25,5,'open']);
 assert.equal(current.alert.policyVersion,1);const alertId=current.alert.id;
 // Completion time, rather than the old request-start recordedAt, chooses the minute.
 const starts=f.sql.prepare('SELECT started_at FROM clank_platform_slo_buckets WHERE requests>0 ORDER BY started_at').all();assert.ok(starts.every(row=>row.started_at>0));
 f.outcome(200,20,'cancelled');f.outcome(200,20,'error');
 const last=f.sql.prepare('SELECT * FROM clank_platform_slo_buckets WHERE started_at=?').get(f.now());assert.deepEqual([last.requests,last.completed,last.successful],[2,0,0]);
 const first=f.sql.prepare('SELECT started_at FROM clank_platform_slo_buckets WHERE requests>0 ORDER BY started_at LIMIT 1').get().started_at;
 f.sql.prepare('DELETE FROM clank_platform_slo_buckets WHERE project_id=? AND started_at=?').run(project,first);
 const missing=f.controller.read(project,policy.id,f.authority);assert.equal(missing.evaluation.reason,'missing-measurements');assert.equal(missing.alert.id,alertId);assert.equal(missing.alert.state,'unknown');assert.equal(missing.evaluation.burning,null);
 // A new zero bucket is written only when its entire minute was observed.
 for(let second=0;second<60;second++)f.tick();
 const zero=f.sql.prepare('SELECT requests FROM clank_platform_slo_buckets WHERE project_id=? AND started_at=?').get(project,f.now()-60000);assert.equal(zero.requests,2);
 for(let second=0;second<60;second++)f.tick();
 const empty=f.sql.prepare('SELECT requests FROM clank_platform_slo_buckets WHERE project_id=? AND started_at=?').get(project,f.now()-60000);assert.equal(empty.requests,0);
});
test('restart, overlapping collectors, missed heartbeats and wall-clock reversal cannot certify a window',async t=>{
 const f=await setup(t),policy=create(f);await traffic(f,503);
 const prior=f.controller.read(project,policy.id,f.authority).alert;assert.equal(prior.state,'open');
 const second=await f.fresh();assert.equal(f.controller.pulse(),false);second.record({projectId:project,routeId:'route_slo_exact_01',method:'GET',statusCode:200,durationMs:1,responseOutcome:'complete',recordedAt:0,requestBytes:0,responseBytes:0,admitted:true});
 const total=f.sql.prepare('SELECT sum(requests) AS n FROM clank_platform_slo_buckets').get().n;assert.equal(total,500);
 second.close();f.controller.pulse();f.tick(60000);
 assert.equal(f.controller.read(project,policy.id,f.authority).evaluation.reason,'missing-measurements');
 f.jump(-120000,1000);f.controller.pulse();assert.equal(f.controller.read(project,policy.id,f.authority).evaluation.reason,'missing-measurements');
 f.controller.close();const replacement=await f.fresh();
 const after=replacement.read(project,policy.id,f.authority);assert.equal(after.alert.id,prior.id);assert.equal(after.alert.state,'unknown');assert.equal(after.evaluation.burning,null);
 assert.equal(replacement.create(project,f.authority,{configuration,operationId:'slo_create_exact_01'}).id,policy.id);
});
test('SLO exact receipts, versions, capacity, current authority and failed audit preserve atomic effects',async t=>{
 const f=await setup(t,{maxPolicies:1,maxReceipts:2,maxBuckets:7});
 f.failAudit(true);assert.throws(()=>create(f),/audit failure/);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_receipts').get().n,0);
 f.failAudit(false);const policy=create(f);assert.equal(create(f).id,policy.id);
 assert.throws(()=>f.controller.create(other,f.authority,{configuration,operationId:'slo_other_create_01'}),error=>error.code==='SLO_CAPACITY');
 assert.throws(()=>f.controller.create(project,f.authority,{configuration:{...configuration,name:'Another'},operationId:'slo_create_exact_01'}),error=>error.code==='SLO_OPERATION_CONFLICT');
 const input={configuration:{...configuration,name:'Renamed'},operationId:'slo_change_exact_01',expectedVersion:1};
 f.failAudit(true);assert.throws(()=>f.controller.change(project,policy.id,f.authority,input),/audit failure/);assert.equal(f.controller.read(project,policy.id,f.authority).policy.version,1);
 f.failAudit(false);const changed=f.controller.change(project,policy.id,f.authority,input);assert.equal(changed.version,2);assert.equal(f.controller.change(project,policy.id,f.authority,input).version,2);
 assert.throws(()=>f.controller.change(project,policy.id,f.authority,{...input,operationId:'slo_stale_version_01'}),error=>error.code==='SLO_CAPACITY');
 f.revoke();assert.throws(()=>create(f),/revoked/);assert.throws(()=>f.controller.read(project,policy.id,f.authority),/revoked/);
});
test('unsupported persisted SLO protocols and insufficient storage reject new work without rewriting history',async t=>{
 const f=await setup(t,{maxBuckets:6});assert.throws(()=>create(f),error=>error.code==='SLO_CAPACITY');
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies').get().n,0);
 f.sql.prepare('UPDATE clank_platform_slo_state SET protocol=99 WHERE singleton=1').run();
  assert.throws(()=>f.controller.pulse(),error=>error.code==='SLO_PROTOCOL_UNSUPPORTED');await assert.rejects(f.fresh(),error=>error.code==='SLO_PROTOCOL_UNSUPPORTED');
  const coverage=f.sql.prepare('SELECT * FROM clank_platform_slo_coverage').all();f.outcome();assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_slo_coverage').all(),coverage);
  assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_slo_state').get().protocol,99);
});
test('closed SLO collectors ignore late terminal callbacks without writing metadata',async t=>{
 const f=await setup(t);create(f);f.controller.close();
 const before=f.sql.prepare('SELECT * FROM clank_platform_slo_coverage ORDER BY started_at').all();f.outcome();
 assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_slo_coverage ORDER BY started_at').all(),before);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_buckets').get().n,0);
});
test('actual native ingress completion, server failure and cancelled body reach the SLO histogram',async t=>{
 const f=await setup(t),policy=f.controller.create(project,f.authority,{configuration:{...configuration,minimumRequests:1},operationId:'slo_actual_ingress_01'}),observed=[];
 const server=createServer((request,response)=>{
  if(request.url==='/failure'){response.writeHead(503);response.end('unavailable');}
  else if(request.url==='/stream'){response.writeHead(200);response.write('started');}
  else{response.writeHead(200);response.end('healthy');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const ingress=createManagedIngress({routes:()=>[{id:'route_slo_exact_01',projectId:project,hosts:['slo.example.test'],upstream:'http://127.0.0.1:'+server.address().port,active:true}],onRequest:metric=>{observed.push(metric);f.controller.record(metric);}});
 for(let second=0;second<60;second++)f.tick();
 for(const path of ['/healthy','/failure']){const response=await ingress.handle(new Request('https://slo.example.test'+path));await response.text();}
 const stream=await ingress.handle(new Request('https://slo.example.test/stream'));const reader=stream.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();
 assert.equal(observed.length,3);assert.deepEqual(observed.map(metric=>[metric.statusCode,metric.responseOutcome]),[[200,'complete'],[503,'complete'],[200,'cancelled']]);
 for(let second=0;second<300;second++)f.tick();
 const result=f.controller.read(project,policy.id,f.authority);assert.deepEqual([result.evaluation.requests,result.evaluation.good,result.evaluation.bad,result.evaluation.coverage.complete,result.alert.state],[3,1,2,true,'open']);
 const stored=f.sql.prepare('SELECT * FROM clank_platform_slo_buckets WHERE requests>0').get();assert.equal(stored.requests,3);assert.equal(stored.completed,2);assert.equal(stored.successful,1);
 assert.deepEqual(Object.keys(stored).sort(),['completed','latency','project_id','requests','started_at','successful']);
});
test('two real SQLite policy controllers preserve one exact creation and one accepted stale-version contender',async t=>{
 const f=await setup(t),other=await f.fresh(),policy=create(f);
 assert.equal(other.create(project,f.authority,{configuration,operationId:'slo_create_exact_01'}).id,policy.id);
 const input={configuration:{...configuration,name:'First accepted'},expectedVersion:1,operationId:'slo_concurrent_first_01'};
 assert.equal(other.change(project,policy.id,f.authority,input).version,2);
 assert.throws(()=>f.controller.change(project,policy.id,f.authority,{...input,configuration:{...configuration,name:'Stale rejected'},operationId:'slo_concurrent_second_01'}),error=>error.code==='SLO_VERSION_CONFLICT');
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_receipts').get().n,2);
});
