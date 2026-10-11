import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openProjectSlos} from '../dist/platform-slo.js';
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
 const fresh=async()=>{const db=await openSQLite(schema,{path:join(root,'control.sqlite')});databases.push(db);const c=openProjectSlos(db[internal],options,hooks);controllers.push(c);return c;};
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

const retainedSnapshot=sql=>JSON.stringify(sql.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name LIKE 'clank_platform_slo_%' ORDER BY name").all().map(entry=>({...entry,rows:entry.type==='table'?sql.prepare('SELECT * FROM '+entry.name+' ORDER BY rowid').all():null})));
for(const damage of ['missing','layout'])for(const suffix of ['state','collectors','coverage','buckets','policies','receipts','alerts'])test('retained SLO '+suffix+' '+damage+' refuses live and reopened work without rebuilding history',async t=>{
 const f=await setup(t);create(f);f.controller.close();const name='clank_platform_slo_'+suffix;
 if(damage==='missing')f.sql.exec('DROP TABLE '+name);else f.sql.exec('ALTER TABLE '+name+' ADD COLUMN unexpected TEXT');
 const before=retainedSnapshot(f.sql);
 await assert.rejects(f.fresh(),error=>error.code==='SLO_STORAGE_INVALID');
 assert.equal(retainedSnapshot(f.sql),before);
 // A separate already-open controller detects damage before even allocating a policy.
 const g=await setup(t);create(g);g.sql.exec(damage==='missing'?'DROP TABLE '+name:'ALTER TABLE '+name+' ADD COLUMN unexpected TEXT');const live=retainedSnapshot(g.sql);
 assert.throws(()=>g.controller.create(project,g.authority,{configuration:{...configuration,name:'Changed historical input'},operationId:'slo_create_exact_01'}),error=>error.code==='SLO_STORAGE_INVALID');
 assert.equal(retainedSnapshot(g.sql),live);
});
for(const damage of ['missing','multiple'])test('retained SLO '+damage+' singleton is not normalized',async t=>{
 const f=await setup(t);create(f);f.controller.close();
 if(damage==='missing')f.sql.exec('DELETE FROM clank_platform_slo_state');else f.sql.exec('ALTER TABLE clank_platform_slo_state RENAME TO native_prior_state;CREATE TABLE clank_platform_slo_state(singleton INTEGER PRIMARY KEY,protocol INTEGER NOT NULL,owner TEXT,epoch TEXT);INSERT INTO clank_platform_slo_state SELECT * FROM native_prior_state;INSERT INTO clank_platform_slo_state(singleton,protocol) VALUES(2,1);DROP TABLE native_prior_state');
 const before=retainedSnapshot(f.sql);await assert.rejects(f.fresh(),error=>error.code==='SLO_STORAGE_INVALID');assert.equal(retainedSnapshot(f.sql),before);
});
for(const kind of ['create','change'])for(const target of ['policy','receipt'])for(const fault of ['ignored','altered'])test('native '+fault+' SLO '+kind+' '+target+' rolls back exact effect and receipt',async t=>{
 const f=await setup(t),prior=kind==='change'?create(f):null,input={configuration:{...configuration,name:'  Exact intent  ',burnThreshold:1.5},operationId:'slo_fault_operation_01',...(prior?{expectedVersion:1}:{})};
 const table=target==='policy'?'clank_platform_slo_policies':'clank_platform_slo_receipts',verb=target==='policy'&&prior?'UPDATE':'INSERT';
 const action=fault==='ignored'?'SELECT RAISE(IGNORE);':target==='policy'?"UPDATE clank_platform_slo_policies SET configuration=json_set(configuration,'$.name','Changed by trigger') WHERE id=NEW.id;":"UPDATE clank_platform_slo_receipts SET result=json_set(result,'$.version',999) WHERE project_id=NEW.project_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id;";
 f.sql.exec(`CREATE TRIGGER native_slo_fault ${fault==='ignored'?'BEFORE':'AFTER'} ${verb} ON ${table} BEGIN ${action} END`);
 const before=retainedSnapshot(f.sql);const submit=()=>prior?f.controller.change(project,prior.id,f.authority,input):f.controller.create(project,f.authority,input);
 assert.throws(submit,error=>error.code==='SLO_STORAGE_INVALID');assert.equal(retainedSnapshot(f.sql),before);
 f.sql.exec('DROP TRIGGER native_slo_fault');const accepted=submit();assert.equal(accepted.name,input.configuration.name);assert.equal(accepted.burnThreshold,1.5);assert.deepEqual(submit(),accepted);
});
for(const target of ['policy','receipt','authority'])test('SLO audit '+target+' change cannot publish or commit an earlier authorization',async t=>{
 const f=await setup(t);f.sql.exec('CREATE TABLE native_slo_audit(action TEXT);CREATE TABLE native_slo_permission(allowed INTEGER);INSERT INTO native_slo_permission VALUES(1)');
 const authority={userId:f.authority.userId,authorize(){if(f.sql.prepare('SELECT allowed FROM native_slo_permission').get().allowed!==1)throw new Error('Native authority revoked');},audit(action){f.sql.prepare('INSERT INTO native_slo_audit VALUES(?)').run(action);if(target==='authority')f.sql.exec('UPDATE native_slo_permission SET allowed=0');else if(target==='policy')f.sql.exec("UPDATE clank_platform_slo_policies SET version=99");else f.sql.exec('DELETE FROM clank_platform_slo_receipts');}};
 const before=retainedSnapshot(f.sql);assert.throws(()=>f.controller.create(project,authority,{configuration,operationId:'slo_audit_fault_01'}),target==='authority'?/revoked/:error=>error.code==='SLO_STORAGE_INVALID');
 assert.equal(retainedSnapshot(f.sql),before);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM native_slo_audit').get().n,0);assert.equal(f.sql.prepare('SELECT allowed FROM native_slo_permission').get().allowed,1);
});
for(const verb of ['INSERT','UPDATE'])for(const fault of ['ignored','altered'])test('actual ingress '+fault+' metric '+verb+' invalidates replayed coverage rather than proving health',async t=>{
 const f=await setup(t),policy=f.controller.create(project,f.authority,{configuration:{...configuration,minimumRequests:1},operationId:'slo_metric_failure_01'}),observed=[];
 const server=createServer((request,response)=>{response.writeHead(request.url==='/failure'?503:200);response.end('observed');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const ingress=createManagedIngress({routes:()=>[{id:'route_slo_exact_01',projectId:project,hosts:['slo.example.test'],upstream:'http://127.0.0.1:'+server.address().port,active:true}],onRequest:metric=>{observed.push(metric);f.controller.record(metric);}});
 for(let second=0;second<60;second++)f.tick();
 if(verb==='UPDATE')await (await ingress.handle(new Request('https://slo.example.test/healthy'))).text();
 const before=JSON.stringify(f.sql.prepare('SELECT * FROM clank_platform_slo_buckets').all());
 const action=fault==='ignored'?'SELECT RAISE(IGNORE);':'UPDATE clank_platform_slo_buckets SET requests=99 WHERE project_id=NEW.project_id AND started_at=NEW.started_at;';
 f.sql.exec(`CREATE TRIGGER native_metric_fault ${fault==='ignored'?'BEFORE':'AFTER'} ${verb} ON clank_platform_slo_buckets BEGIN ${action} END`);
 const response=await ingress.handle(new Request('https://slo.example.test/failure'));assert.equal(response.status,503);await response.text();
 assert.deepEqual(observed.map(metric=>[metric.statusCode,metric.responseOutcome]),verb==='UPDATE'?[[200,'complete'],[503,'complete']]:[[503,'complete']]);
 assert.equal(JSON.stringify(f.sql.prepare('SELECT * FROM clank_platform_slo_buckets').all()),before);assert.ok(f.errors.some(error=>error.code==='SLO_STORAGE_INVALID'));
 assert.equal(f.sql.prepare('SELECT complete FROM clank_platform_slo_coverage WHERE started_at=?').get(f.now()).complete,0);
 f.sql.exec('DROP TRIGGER native_metric_fault');for(let second=0;second<300;second++)f.tick();
 const result=f.controller.read(project,policy.id,f.authority);assert.equal(result.evaluation.status,'insufficient-data');assert.equal(result.evaluation.burning,null);assert.equal(result.evaluation.coverage.complete,false);
});
for(const target of ['state','collectors'])test('native metric write loses '+target+' authority before commit without keeping a bucket',async t=>{
 const f=await setup(t);create(f);for(let second=0;second<60;second++)f.tick();
 const action=target==='state'?"UPDATE clank_platform_slo_state SET owner='foreign_native_owner';":'DELETE FROM clank_platform_slo_collectors;';
 f.sql.exec(`CREATE TRIGGER native_metric_authority AFTER INSERT ON clank_platform_slo_buckets BEGIN ${action} END`);f.outcome();
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_buckets').get().n,0);assert.ok(f.errors.some(error=>/ownership changed/.test(error.message)));assert.equal(f.sql.prepare('SELECT complete FROM clank_platform_slo_coverage WHERE started_at=?').get(f.now()).complete,0);
});
