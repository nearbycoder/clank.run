import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {defineDatabase,openSQLite,openDeploymentOrchestrator} from '../dist/index.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {openSupervisorLease} from '../dist/platform-supervisor.js';
import * as shadow from '../dist/managed-shadow.js';
import {prepareShadowSchema} from './fixtures/shadow-schema.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
async function until(check,label){const end=performance.now()+5000;while(performance.now()<end){const result=check();if(result)return result;await delay(5)}throw new Error('Timed out: '+label)}
const policy=()=>shadow.normalizeShadowPolicy({revision:1,readPaths:['/'],methods:['GET'],maxSamplePercent:10,maxDurationMs:60000,maxAttempts:10,maxConcurrent:2,maxResponseBytes:1024,maxRequestMs:1000,maxReports:1});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-shadow-journal-')),path=join(root,'control.sqlite'),lease=await openSupervisorLease(path,{configurationId:'native-shadow-journal',configurationRevision:1,leaseMs:30000,pollIntervalMs:50});
  assert.equal(lease.acquire(),true);
  const database=await openSQLite(defineDatabase({}),{path}),sql=new DatabaseSync(path),internal=database[SQLITE_INTERNAL];sql.exec('PRAGMA busy_timeout=5000');
  prepareShadowSchema(sql);sql.exec("ALTER TABLE clank_platform_releases ADD COLUMN upload_publication_receipt TEXT;UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2';INSERT INTO clank_platform_projects(id) VALUES('project')");
  lease.enrollProviderShadow();const authorityConnection={prepare:sql=>internal.prepare(sql==="PRAGMA table_list"?"SELECT * FROM pragma_table_list":sql)};internal.guardWrites(()=>lease.assertCurrent(authorityConnection));
  const orchestrator=openDeploymentOrchestrator(database,{distributedLeaseMs:30000}),held=new Map(),controllers=[];
  const current=project=>{lease.assertCurrent(authorityConnection);const capability=held.get(project);assert.ok(capability,'Actual project lease is held');assert.ok(internal.prepare('SELECT 1 FROM clank_distributed_leases WHERE resource=? AND owner=? AND token_hash=? AND fence=? AND expires_at>?').get(capability.resource,capability.owner,createHash("sha256").update(capability.token).digest("base64url"),capability.fence,Date.now()),'Native project lease is current')};
  const acquire=async(project='project')=>{const capability=await orchestrator.acquireLease('project:'+project,'shadow-native-'+randomUUID());assert.ok(capability);held.set(project,capability);return()=>current(project)};
  const read=(project='project')=>{const row=internal.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(project);if(!row)return null;const record=shadow.readShadowRecord(row,project,hash);assert.equal(internal.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(project).provider_canary_epoch,record.epoch);shadow.assertShadowReplay(internal,project,record,hash);return record};
  const operation=(project='project',configured=policy())=>{const epoch=Number(internal.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(project).provider_canary_epoch)+1,now=Date.now(),sessionId='shadow_'+randomUUID();return{kind:'shadow',sessionId,operationId:'operation_'+randomUUID(),idempotencyKeyDigest:hash(sessionId),inputDigest:hash('input:'+sessionId),reviewDigest:hash('review:'+sessionId),releaseId:'candidate_'+epoch,artifactSha256:hash('artifact'),capsuleSha256:null,controllerEpoch:epoch,retirementEpoch:epoch,primary:null,primaryReleaseId:'primary',primaryFence:1,nodeId:'node',origin:'http://127.0.0.1:12345',credentialGeneration:1,policyRevision:configured.revision,policyDigest:hash(JSON.stringify(configured)),policy:shadow.narrowShadowPolicy(configured,{}),maxReports:configured.maxReports,phase:'binding',outcome:null,stopRequested:false,snapshot:null,report:shadow.emptyShadowReport(),reservations:[],retirement:null,createdAt:now,expiresAt:now+configured.maxDurationMs,updatedAt:now}};
  const save=(project,prior,op,authority=()=>current(project))=>shadow.saveShadowRecord(internal,project,prior,op,authority,hash);
  const retirement=record=>{const op=record.operation;return{protocol:'clank-provider-canary-retirement/1',primary:op.primary,operationId:op.operationId,controllerEpoch:op.controllerEpoch,releaseId:op.releaseId,capsuleSha256:op.capsuleSha256,candidateProjectId:shadow.shadowCandidateProjectId(op,hash),retirementEpoch:op.retirementEpoch,phase:'retired'}};
  const adapter={read,save,retire:async(project,record,guard)=>{guard();return retirement(record)}};
  const controller=prepare=>{const value=shadow.createShadowController({...adapter,lock:async(project,work)=>{assert.equal(held.has(project),false);const authority=await acquire(project);try{return await work()}finally{const capability=held.get(project);held.delete(project);await orchestrator.releaseLease(capability)}},authority:project=>{const captured=held.get(project);return()=>{assert.equal(held.get(project),captured);current(project)}},scope:async(current,work)=>{current();return work()},admit(){},begin:(project,op,guard)=>save(project,read(project),op,guard),
    replay(project,key,guard,bySession=false){return internal.transaction(()=>{guard();const record=read(project),replay=shadow.readShadowReplays(internal,project,hash).find(row=>bySession?row.receipt.identity.sessionId===key:row.receipt.identity.idempotencyKeyDigest===key);guard();return replay?Object.freeze({replay,current:record?.operation.sessionId===replay.receipt.identity.sessionId?record:null,epoch:record?.epoch??0}):null})},prepare,onError(){}});controllers.push(value);return value};
  t.after(async()=>{for(const value of controllers)await value.close();for(const value of held.values())await orchestrator.releaseLease(value).catch(()=>{});orchestrator.close();database.close();sql.close();lease.close();await rm(root,{recursive:true,force:true})});
  return{root,sql,internal,lease,orchestrator,held,acquire,current,read,operation,save,retirement,adapter,controller};
}
function preparing(f,record){const op=record.operation;return f.save('project',record,{...op,capsuleSha256:hash('capsule'),primary:{projectId:'project',releaseId:op.primaryReleaseId,generation:op.credentialGeneration,fence:op.primaryFence,incarnation:randomUUID()},phase:'preparing',updatedAt:Math.max(Date.now(),op.updatedAt)})}

test('native shadow admission and completion retain the worst policy identity when aggregate bodies are pruned',async t=>{
  const f=await fixture(t),current=await f.acquire(),configured={...policy(),readPaths:Array.from({length:32},(_,i)=>'/'+String(i).padStart(3,'0')+'x'.repeat(252))};
  const first=f.save('project',null,f.operation('project',configured),current);assert.equal(first.epoch,1);
  const complete=await shadow.retireShadow(f.adapter,'project',first,current,'interrupted');assert.equal(complete.operation.phase,'complete');
  const before=shadow.readShadowReplays(f.internal,'project',hash)[0],receiptBytes=Buffer.byteLength(JSON.stringify(before.receipt));assert.ok(receiptBytes<=16*1024);assert.ok(receiptBytes>8192);
  const second=f.save('project',complete,f.operation(),current);await shadow.retireShadow(f.adapter,'project',second,current,'interrupted');
  const rows=shadow.readShadowReplays(f.internal,'project',hash),old=rows.find(row=>row.receipt.identity.sessionId===first.operation.sessionId);
  assert.equal(old.report,null);assert.deepEqual(old.receipt,before.receipt);assert.deepEqual(old.receipt.identity.policy.readPaths,[...configured.readPaths].sort());
  assert.equal(rows.filter(row=>row.report!==null).length,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_shadow_reports').get().n,2);
  assert.equal(Object.hasOwn(old.receipt.identity.snapshot??{},'elapsedSinceObservationMs'),false);
  t.diagnostic(JSON.stringify({maximumPolicyReceiptBytes:receiptBytes,retainedIdentities:rows.length,fullReports:1}));
});

for(const [name,trigger] of [
  ['journal ignored','CREATE TRIGGER fault BEFORE INSERT ON clank_platform_provider_canaries BEGIN SELECT RAISE(IGNORE); END'],
  ['project epoch ignored','CREATE TRIGGER fault BEFORE UPDATE OF provider_canary_epoch ON clank_platform_projects BEGIN SELECT RAISE(IGNORE); END'],
  ['replay ignored','CREATE TRIGGER fault BEFORE INSERT ON clank_platform_shadow_reports BEGIN SELECT RAISE(IGNORE); END'],
  ['mirror ignored','CREATE TRIGGER fault BEFORE UPDATE OF shadow_replay_receipt ON clank_platform_projects BEGIN SELECT RAISE(IGNORE); END'],
  ['native authority revoked','CREATE TRIGGER fault AFTER INSERT ON clank_platform_shadow_reports BEGIN DELETE FROM clank_distributed_leases; END'],
])test('shadow admission rolls back atomically when '+name,async t=>{
  const f=await fixture(t),current=await f.acquire(),before=f.sql.prepare('SELECT * FROM clank_distributed_leases').all();f.sql.exec(trigger);
  assert.throws(()=>f.save('project',null,f.operation(),current));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_provider_canaries').get().n,0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_shadow_reports').get().n,0);assert.deepEqual(f.sql.prepare('SELECT * FROM clank_distributed_leases').all(),before);
  assert.deepEqual({...f.sql.prepare('SELECT provider_canary_epoch,shadow_replay_receipt FROM clank_platform_projects').get()},{provider_canary_epoch:0,shadow_replay_receipt:null});
  f.sql.exec('DROP TRIGGER fault');f.save('project',null,f.operation(),current);
});

test('shadow retained state refuses missing compact receipts, mirror changes and aggregate substitution',async t=>{
  const f=await fixture(t),current=await f.acquire(),record=f.save('project',null,f.operation(),current),row=f.sql.prepare('SELECT * FROM clank_platform_shadow_reports').get();
  f.sql.exec('DELETE FROM clank_platform_shadow_reports');assert.throws(()=>f.read());assert.throws(()=>shadow.readShadowReplays(f.internal,'project',hash));
  f.sql.prepare('INSERT INTO clank_platform_shadow_reports VALUES(?,?,?,?,?,?)').run(...Object.values(row));
  f.sql.exec("UPDATE clank_platform_projects SET shadow_replay_receipt='{}'");assert.throws(()=>shadow.readShadowReplays(f.internal,'project',hash));
  f.sql.prepare('UPDATE clank_platform_projects SET shadow_replay_receipt=?').run(JSON.stringify({protocol:1,count:1,sha256:hash(JSON.stringify([JSON.parse(row.receipt_json)]))}));
  f.sql.prepare('UPDATE clank_platform_shadow_reports SET report_json=?').run(JSON.stringify({...JSON.parse(row.report_json),extra:true}));assert.throws(()=>f.read());
  f.sql.prepare('UPDATE clank_platform_shadow_reports SET report_json=?').run(row.report_json);assert.equal(f.read().serialized,record.serialized);
});

test('lost native ownership after held retirement cannot acknowledge cleanup and retry preserves original epoch',async t=>{
  const f=await fixture(t);let current=await f.acquire(),record=preparing(f,f.save('project',null,f.operation(),current));
  const entered=gate(),release=gate(),inputs=[];const adapter={...f.adapter,retire:async(project,value,guard)=>{inputs.push(value.operation.retirementEpoch);entered.resolve();await release.promise;guard();return f.retirement(value)}};
  const pending=shadow.retireShadow(adapter,'project',record,current,'interrupted');await entered.promise;
  const retained=f.read();assert.equal(retained.operation.phase,'retiring');f.sql.exec('DELETE FROM clank_distributed_leases');release.resolve();await assert.rejects(pending);
  assert.equal(f.read().serialized,retained.serialized);f.held.delete('project');current=await f.acquire();record=await shadow.retireShadow(f.adapter,'project',f.read(),current,'interrupted');
  assert.equal(record.operation.phase,'complete');assert.equal(record.operation.retirementEpoch,1);assert.ok(record.epoch>record.operation.retirementEpoch);assert.deepEqual(inputs,[1]);
});

test('tracked owner permits exact prompt stop during a real held HTTP prepare and rejects a stale stop epoch',async t=>{
  const f=await fixture(t),entered=gate(),release=gate(),finished=gate(),events=[];
  const server=createServer(async(req,res)=>{events.push(req.url);if(req.url==='/prepare'){entered.resolve();await release.promise;res.end('late');finished.resolve()}else res.end('retired')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{release.resolve();await finished.promise;server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  const controller=f.controller(async(project,read,change,current,signal)=>{
    change(op=>({...op,capsuleSha256:hash('capsule'),primary:{projectId:project,releaseId:op.primaryReleaseId,generation:op.credentialGeneration,fence:op.primaryFence,incarnation:randomUUID()},phase:'preparing',updatedAt:Date.now()}));
    current();await fetch(origin+'/prepare',{signal});current();throw new Error('Held prepare must be cancelled.');
  });
  const record=await controller.start('project',f.operation(),()=>{});await entered.promise;const preparing=f.read();
  await assert.rejects(controller.stop('project',record.operation.sessionId,record.epoch,()=>{}),{code:'SHADOW_SUPERSEDED'});
  const stopped=await Promise.race([controller.stop('project',record.operation.sessionId,preparing.epoch,()=>{}),delay(1500).then(()=>{throw new Error('Exact stop waited for held prepare.')})]);
  assert.equal(stopped.operation.phase,'complete');assert.equal(stopped.operation.outcome,'stopped');assert.equal(stopped.operation.stopRequested,true);assert.equal(events.length,1);
  release.resolve();await finished.promise;assert.equal(f.read().serialized,stopped.serialized);assert.equal(f.held.size,0);
});

test('native altered pruning refuses commit and preserves the prior replay mirror',async t=>{
  const f=await fixture(t),current=await f.acquire();let record=f.save('project',null,f.operation(),current);
  record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');record=f.save('project',record,f.operation(),current);
  const before=f.sql.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),mirror=f.sql.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects').get();
  f.sql.exec('CREATE TRIGGER restore_pruned AFTER UPDATE OF report_json ON clank_platform_shadow_reports WHEN NEW.report_json IS NULL BEGIN UPDATE clank_platform_shadow_reports SET report_json=OLD.report_json WHERE project_id=NEW.project_id AND session_id=NEW.session_id; END');
  await assert.rejects(shadow.retireShadow(f.adapter,'project',record,current,'interrupted'));
  assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),before);assert.deepEqual(f.sql.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects').get(),mirror);assert.equal(f.read().serialized,record.serialized);
});

test('native report resurrection cannot exceed the configured retained-body bound',async t=>{
  const f=await fixture(t),current=await f.acquire();let record=f.save('project',null,f.operation(),current);
  record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');
  const first=f.sql.prepare('SELECT session_id,report_json FROM clank_platform_shadow_reports').get();
  record=f.save('project',record,f.operation(),current);record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');
  assert.equal(f.sql.prepare('SELECT report_json FROM clank_platform_shadow_reports WHERE session_id=?').get(first.session_id).report_json,null);
  record=f.save('project',record,f.operation(),current);
  const before=f.sql.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),mirror=f.sql.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects').get();
  // Restore an older, already-pruned body when the newer completion is written.
  // The current prune target can still read back as NULL while total retention exceeds one.
  f.sql.exec(`CREATE TABLE fault_body(session_id TEXT,body TEXT);CREATE TRIGGER resurrect_body AFTER UPDATE OF receipt_json ON clank_platform_shadow_reports BEGIN UPDATE clank_platform_shadow_reports SET report_json=(SELECT body FROM fault_body) WHERE session_id=(SELECT session_id FROM fault_body); END`);
  f.sql.prepare('INSERT INTO fault_body VALUES(?,?)').run(first.session_id,first.report_json);
  await assert.rejects(shadow.retireShadow(f.adapter,'project',record,current,'interrupted'));
  assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),before);assert.deepEqual(f.sql.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects').get(),mirror);assert.equal(f.read().serialized,record.serialized);
});

test('the shared native catalog refuses a seventeenth unresolved shadow slot without evicting an intent',async t=>{
  const f=await fixture(t);
  for(let index=0;index<17;index++){
    const project='project_'+index;f.sql.prepare('INSERT INTO clank_platform_projects(id) VALUES(?)').run(project);const current=await f.acquire(project),operation=f.operation(project);
    if(index<16)f.save(project,null,operation,current);
    else{assert.throws(()=>f.save(project,null,operation,current),{code:'SHADOW_CAPACITY'});assert.equal(f.sql.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(project).provider_canary_epoch,0)}
  }
  assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_provider_canaries').get().n,16);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_shadow_reports').get().n,16);
});

test('same-key replay fences reject changed inputs and a new live session cannot replace an unresolved owner',async t=>{
  const f=await fixture(t),current=await f.acquire(),first=f.save('project',null,f.operation(),current),attempt=f.operation();
  assert.throws(()=>f.save('project',first,attempt,current));assert.equal(f.read().serialized,first.serialized);
  const complete=await shadow.retireShadow(f.adapter,'project',first,current,'interrupted');
  for(const change of [{inputDigest:hash('changed')},{reviewDigest:hash('changed')},{}]){
    const next={...f.operation(),idempotencyKeyDigest:first.operation.idempotencyKeyDigest,...change};
    assert.throws(()=>f.save('project',complete,next,current));assert.equal(f.read().serialized,complete.serialized);
  }
  const replay=shadow.readShadowReplays(f.internal,'project',hash)[0];assert.equal(replay.receipt.identity.inputDigest,first.operation.inputDigest);
});

for(const version of [1,2])test(`report v${version}: terminal retirement classifies every retained unresolved reservation as interrupted without inventing agreement`,async t=>{
  const f=await fixture(t),current=await f.acquire();if(version===2){shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();}const op=f.operation();if(version===2)op.report=shadow.emptyShadowReport(2);let record=preparing(f,f.save('project',null,op,current));
  const snapshot={sha256:hash('actual-checkpoint-fixture'),bytes:4096,providerStartedAt:Date.now(),providerCompletedAt:Date.now(),platformObservedAt:Date.now()};
  record=f.save('project',record,{...record.operation,phase:'observing',snapshot,report:{...record.operation.report,counters:{...record.operation.report.counters,reserved:2}},reservations:[1,2],updatedAt:Date.now()},current);
  record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');assert.equal(record.operation.report.counters.settled,2);assert.equal(record.operation.report.counters.comparable,0);assert.equal(record.operation.report.counters.unknown.interrupted,2);
  assert.deepEqual(record.operation.reservations,[]);assert.equal(record.operation.report.latency.primary.unknown,2);assert.equal(record.operation.report.latency.candidate.unknown,2);
  const receipt=shadow.readShadowReplays(f.internal,'project',hash)[0];assert.equal(receipt.report.protocol,version===2?2:undefined);assert.deepEqual(receipt.receipt.identity.snapshot,snapshot);assert.equal(receipt.report.counters.comparable,0);
});


test('public owner start captures caller input before the actual native project lock await',async t=>{
  const f=await fixture(t),entered=gate(),controller=f.controller(async(id,read,change,current,signal)=>{entered.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));current();throw new Error('Stopped')});
  const input=f.operation(),expected=structuredClone(input),pending=controller.start('project',input,()=>{});input.releaseId='changed';input.policy={...input.policy,readPaths:['/changed']};input.reservations.push(999);
  const record=await pending;await entered.promise;assert.equal(record.operation.releaseId,expected.releaseId);assert.deepEqual(record.operation.policy,expected.policy);assert.deepEqual(record.operation.reservations,[]);
  await controller.requestStop('project',record.operation.sessionId,record.operation.operationId,record.operation.controllerEpoch,()=>{});await until(()=>f.read()?.operation.phase==='complete','exact owned stop');
});

test('read-only live-owner replay returns retained history without new owner, writes, provider calls or reservation',async t=>{
  const f=await fixture(t),entered=[],controller=f.controller(async(id,read,change,current,signal)=>{entered.push(read().operation.sessionId);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));current();throw new Error('Stopped')});
  const first=await controller.start('project',f.operation(),()=>{});await until(()=>entered.length===1,'first preparation');
  const before=f.read().serialized,live=controller.replay('project',first.operation.idempotencyKeyDigest);assert.equal(live.current.serialized,before);assert.equal(f.read().serialized,before);assert.equal(entered.length,1);
  await controller.requestStop('project',first.operation.sessionId,first.operation.operationId,first.operation.controllerEpoch,()=>{});await until(()=>f.held.size===0,'first exact owner released');
  const second=await controller.start('project',f.operation(),()=>{});await until(()=>entered.length===2,'newer owner');
  const latest=f.read().serialized,old=controller.replay('project',first.operation.idempotencyKeyDigest);assert.equal(old.replay.receipt.identity.sessionId,first.operation.sessionId);assert.equal(old.replay.receipt.identity.phase,'complete');assert.equal(old.current,null);assert.equal(old.epoch,second.epoch);assert.equal(f.read().serialized,latest);assert.equal(entered.length,2);assert.equal(f.read().operation.report.counters.reserved,0);
  await assert.rejects(controller.requestStop('project',first.operation.sessionId,first.operation.operationId,first.operation.controllerEpoch,()=>{}),{code:'SHADOW_SUPERSEDED'});assert.equal(f.read().serialized,latest);
  f.sql.exec('DELETE FROM clank_distributed_leases');assert.throws(()=>controller.replay('project',first.operation.idempotencyKeyDigest));assert.equal(f.read().serialized,latest);
});

test('original stop identity follows actual status floor while ignored native CAS never aborts the owner',async t=>{
  const f=await fixture(t),entered=gate();let activeSignal;
  const controller=f.controller(async(id,read,change,current,signal)=>{activeSignal=signal;change(op=>({...op,capsuleSha256:hash('capsule'),primary:{projectId:id,releaseId:op.primaryReleaseId,generation:op.credentialGeneration,fence:op.primaryFence,incarnation:randomUUID()},phase:'preparing',updatedAt:Date.now()}));entered.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));current();throw new Error('Stopped')});
  const accepted=await controller.start('project',f.operation(),()=>{});await entered.promise;assert.ok(f.read().epoch>accepted.epoch);
  f.sql.exec("CREATE TRIGGER ignore_stop BEFORE UPDATE ON clank_platform_provider_canaries WHEN json_extract(NEW.operation,'$.stopRequested')=1 BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(controller.requestStop('project',accepted.operation.sessionId,accepted.operation.operationId,accepted.operation.controllerEpoch,()=>{}));assert.equal(activeSignal.aborted,false);assert.equal(f.read().operation.stopRequested,false);
  f.sql.exec('DROP TRIGGER ignore_stop');const stopped=await controller.requestStop('project',accepted.operation.sessionId,accepted.operation.operationId,accepted.operation.controllerEpoch,()=>{});assert.equal(stopped.operation.stopRequested,true);assert.equal(activeSignal.aborted,true);await until(()=>f.read().operation.phase==='complete','bounded exact cleanup');
});

for(const version of [1,2])test(`report v${version}: native compact replay round trip retains maximum safe identities, snapshot and policy within byte ceilings`,async t=>{
  const f=await fixture(t),project='p'.repeat(128),maximum=Number.MAX_SAFE_INTEGER,configured={...policy(),revision:maximum,readPaths:Array.from({length:32},(_,i)=>'/'+String(i).padStart(3,'0')+'x'.repeat(252)),methods:['GET','HEAD'],maxSamplePercent:100,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100};
  f.sql.prepare('INSERT INTO clank_platform_projects(id) VALUES(?)').run(project);const current=await f.acquire(project);if(version===2){shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();}
  const base=f.operation(project,configured),operation={...base,sessionId:'s'.repeat(128),operationId:'o'.repeat(128),releaseId:'c'.repeat(128),primaryReleaseId:'r'.repeat(128),nodeId:'n'.repeat(128),controllerEpoch:maximum-4,retirementEpoch:maximum-4,primaryFence:maximum,credentialGeneration:maximum,capsuleSha256:hash('capsule'),phase:'complete',outcome:'authority-revoked',createdAt:maximum-1800000,expiresAt:maximum,updatedAt:maximum,
    primary:{projectId:project,releaseId:'r'.repeat(128),generation:maximum,fence:maximum,incarnation:randomUUID()},snapshot:{sha256:hash('snapshot'),bytes:2*1024*1024*1024-2*1024*1024-100*1024*1024-32,providerStartedAt:maximum,providerCompletedAt:maximum,platformObservedAt:maximum}};
  if(version===2){operation.report=shadow.emptyShadowReport(2);operation.report=shadow.addShadowSkips(operation.report,Object.fromEntries(Object.keys(operation.report.skips).map(name=>[name,2147483647])),10000);}
  operation.retirement=f.retirement({operation});const serialized=JSON.stringify(operation),record=shadow.readShadowRecord({project_id:project,protocol:2,epoch:maximum,operation:serialized,updated_at:maximum},project,hash);
  // This is native receipt validation/roundtrip, not a claim that billions of
  // real sessions or a host clock near MAX_SAFE_INTEGER were executed.
  const admissionOperation={...operation,report:version===2?shadow.emptyShadowReport(2):shadow.emptyShadowReport(),capsuleSha256:null,primary:null,phase:'binding',outcome:null,snapshot:null,retirement:null,updatedAt:operation.createdAt};
  const admission=shadow.readShadowRecord({project_id:project,protocol:2,epoch:operation.controllerEpoch,operation:JSON.stringify(admissionOperation),updated_at:admissionOperation.updatedAt},project,hash);
  f.internal.transaction(()=>{current();shadow.writeShadowReplay(f.internal,project,admission,[],hash);current()});
  const admitted=shadow.readShadowReplays(f.internal,project,hash);
  f.internal.transaction(()=>{current();shadow.writeShadowReplay(f.internal,project,record,admitted,hash);current()});
  const [roundtrip]=shadow.readShadowReplays(f.internal,project,hash),bytes=Buffer.byteLength(JSON.stringify(roundtrip.receipt)),full=Buffer.byteLength(JSON.stringify({identity:roundtrip.receipt.identity,report:roundtrip.report}));
  assert.equal(roundtrip.receipt.identity.primary.incarnation,operation.primary.incarnation);assert.deepEqual(roundtrip.receipt.identity.snapshot,operation.snapshot);assert.deepEqual(roundtrip.receipt.identity.policy,operation.policy);assert.equal(roundtrip.receipt.identity.epoch,maximum);assert.ok(bytes<=16384);assert.ok(full<=32768);assert.ok(bytes>10000);t.diagnostic(JSON.stringify({receiptBytes:bytes,identityAndReportBytes:full}));
});

test('report schema upgrade commits only its exact singleton with no DDL changes and retains supervisor protocol three',async t=>{
  const f=await fixture(t),current=await f.acquire(),before=f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),identity=shadow.assertProviderShadowSchema(f.sql);
  const next=shadow.upgradeShadowReportSchema(f.internal,current);assert.equal(next.version,3);assert.equal(next.enrollmentId,identity.enrollmentId);
  assert.deepEqual(f.sql.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),before);f.lease.enrollProviderShadow();f.lease.enrollProviderCanaries();
  assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,3);assert.deepEqual(shadow.upgradeShadowReportSchema(f.internal,current),next);
});

for(const [label,body]of[
  ['ignored','SELECT RAISE(IGNORE);'],['reverted',"UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2';"],
  ['identity replaced',"UPDATE clank_platform_shadow_state SET enrollment_id=printf('%064d',2);"],
  ['project authority revoked','DELETE FROM clank_distributed_leases;'],['supervisor authority revoked','DELETE FROM clank_platform_supervisor_lease;'],
])test('report schema native '+label+' write rolls back schema and authority without poisoning the committed floor',async t=>{
  const f=await fixture(t),current=await f.acquire(),state=f.sql.prepare('SELECT * FROM clank_platform_shadow_state').all(),supervisor=f.sql.prepare('SELECT * FROM clank_platform_supervisor_lease').all(),project=f.sql.prepare('SELECT * FROM clank_distributed_leases').all();
  f.sql.exec(`CREATE TRIGGER report_fault ${label==='ignored'?'BEFORE':'AFTER'} UPDATE OF schema_id ON clank_platform_shadow_state BEGIN ${body} END`);
  assert.throws(()=>shadow.upgradeShadowReportSchema(f.internal,current));assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_shadow_state').all(),state);assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_supervisor_lease').all(),supervisor);assert.deepEqual(f.sql.prepare('SELECT * FROM clank_distributed_leases').all(),project);f.lease.assertCurrent();
  f.sql.exec('DROP TRIGGER report_fault');shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();assert.equal(shadow.assertProviderShadowSchema(f.sql).version,3);
});

test('version-two native report cannot precede committed schema3, rewrite legacy evidence or change version mid-operation',async t=>{
  const f=await fixture(t),current=await f.acquire(),legacy=f.save('project',null,f.operation(),current),complete=await shadow.retireShadow(f.adapter,'project',legacy,current,'interrupted');
  const original=f.sql.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports').get();const operation={...f.operation(),maxReports:2,report:shadow.emptyShadowReport(2)};
  assert.equal(operation.report.protocol,2);assert.throws(()=>f.save('project',complete,operation,current));assert.equal(f.read().serialized,complete.serialized);
  shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();const newer=f.save('project',complete,operation,current);
  assert.deepEqual(f.sql.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports WHERE session_id=?').get(legacy.operation.sessionId),original);
  assert.throws(()=>f.save('project',newer,{...newer.operation,report:shadow.emptyShadowReport()},current));
  const done=await shadow.retireShadow(f.adapter,'project',newer,current,'interrupted');assert.equal(done.operation.report.protocol,2);assert.deepEqual(done.operation.report.skips,shadow.emptyShadowReport(2).skips);
  assert.deepEqual(f.sql.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports WHERE session_id=?').get(legacy.operation.sessionId),original);
  f.sql.exec("UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2'");assert.throws(()=>shadow.readShadowReplays(f.sql,'project',hash));assert.throws(()=>f.lease.assertCurrent(),{code:'SUPERVISOR_SHADOW_SCHEMA'});
});

test('version-two native canonical reports reject duplicate keys, alternate bytes, tampering and malformed skip vocabulary',async t=>{
  const f=await fixture(t),current=await f.acquire();shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();
  f.save('project',null,{...f.operation(),report:shadow.emptyShadowReport(2)},current);const row=f.sql.prepare('SELECT * FROM clank_platform_shadow_reports').get(),report=JSON.parse(row.report_json);
  for(const altered of ['{"protocol":2,'+row.report_json.slice(1),' '+row.report_json,JSON.stringify({...report,skips:{...report.skips,ineligible:1}}),JSON.stringify({...report,skips:{...report.skips,private:1}})]){
    f.sql.prepare('UPDATE clank_platform_shadow_reports SET report_json=?').run(altered);assert.throws(()=>shadow.readShadowReplays(f.internal,'project',hash));
  }
  f.sql.prepare('UPDATE clank_platform_shadow_reports SET report_json=?').run(row.report_json);assert.equal(JSON.stringify(shadow.readShadowReplays(f.internal,'project',hash)[0].report),row.report_json);
});

test('version-two maximum native identity and saturated skips remain within receipt/report bounds through pruning',async t=>{
  const f=await fixture(t),project='p'.repeat(128);f.sql.prepare('INSERT INTO clank_platform_projects(id) VALUES(?)').run(project);const current=await f.acquire(project),configured={...policy(),readPaths:Array.from({length:32},(_,i)=>'/'+String(i).padStart(3,'0')+'x'.repeat(252))};
  shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();
  const op={...f.operation(project,configured),sessionId:'s'.repeat(128),operationId:'o'.repeat(128),releaseId:'c'.repeat(128),primaryReleaseId:'r'.repeat(128),report:shadow.emptyShadowReport(2)};
  let record=f.save(project,null,op,current);record=f.save(project,record,{...record.operation,primary:{projectId:project,releaseId:op.primaryReleaseId,generation:1,fence:1,incarnation:randomUUID()},capsuleSha256:hash('capsule'),phase:'preparing'},current);
  record=f.save(project,record,{...record.operation,phase:'observing',snapshot:{sha256:hash('snapshot'),bytes:4096,providerStartedAt:op.createdAt,providerCompletedAt:op.createdAt,platformObservedAt:op.createdAt}},current);
  const skips=Object.fromEntries(Object.keys(record.operation.report.skips).map(name=>[name,2147483647]));record=f.save(project,record,{...record.operation,report:shadow.addShadowSkips(record.operation.report,skips,op.policy.maxAttempts)},current);
  assert.throws(()=>f.save(project,record,{...record.operation,report:{...record.operation.report,skips:{...skips,withdrawn:0}}},current));
  const complete=await shadow.retireShadow(f.adapter,project,record,current,'stopped'),before=shadow.readShadowReplays(f.internal,project,hash)[0];
  const receiptBytes=Buffer.byteLength(JSON.stringify(before.receipt)),fullBytes=Buffer.byteLength(JSON.stringify({identity:before.receipt.identity,report:before.report}));assert.ok(receiptBytes<=16384&&receiptBytes>10000);assert.ok(fullBytes<=32768);assert.deepEqual(before.report.skips,skips);
  const next=f.save(project,complete,{...f.operation(project),report:shadow.emptyShadowReport(2)},current);await shadow.retireShadow(f.adapter,project,next,current,'interrupted');
  const retained=shadow.readShadowReplays(f.internal,project,hash).find(row=>row.receipt.identity.sessionId===op.sessionId);assert.deepEqual(retained.receipt,before.receipt);assert.equal(retained.report,null);
  t.diagnostic(JSON.stringify({receiptBytes,identityAndReportBytes:fullBytes,maximumReadPaths:32,maximumPathBytes:256,skipMaximum:2147483647}));
});


test('report enrollment refuses a caller-owned transaction and unprepared schema-one catalog without effects',async t=>{
  const f=await fixture(t),current=await f.acquire(),before=f.sql.prepare('SELECT * FROM clank_platform_shadow_state').all();
  f.internal.transaction(()=>{assert.throws(()=>shadow.upgradeShadowReportSchema(f.internal,current));current()});assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_shadow_state').all(),before);
  // A fresh reader has no captured schema2 floor; /1 must still be explicitly prepared by staging first.
  f.sql.exec("UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/1';ALTER TABLE clank_platform_releases DROP COLUMN upload_publication_receipt");
  assert.throws(()=>shadow.upgradeShadowReportSchema(f.internal,()=>{}));assert.equal(f.sql.prepare('SELECT schema_id FROM clank_platform_shadow_state').get().schema_id,'clank-platform-shadow/1');
});

for(const reason of ['ineligible','sampled-out','capacity','attempt-limit','handoff-timeout','withdrawn'])test(`version-two binding report refuses coherent ${reason} skips before any observation`,async t=>{
  const f=await fixture(t),current=await f.acquire();shadow.upgradeShadowReportSchema(f.internal,current);f.lease.enrollProviderShadow();
  const record=f.save('project',null,{...f.operation(),report:shadow.emptyShadowReport(2)},current),row=f.sql.prepare('SELECT * FROM clank_platform_shadow_reports').get(),receipt=JSON.parse(row.receipt_json),report=JSON.parse(row.report_json);
  report.skips[reason]=1;receipt.reportDigest=hash(JSON.stringify({identity:receipt.identity,report}));
  const altered=JSON.stringify(receipt),mirror=JSON.stringify({protocol:1,count:1,sha256:hash(JSON.stringify([receipt]))});
  f.sql.exec('BEGIN IMMEDIATE');f.sql.prepare('UPDATE clank_platform_shadow_reports SET receipt_json=?,report_json=?').run(altered,JSON.stringify(report));f.sql.prepare('UPDATE clank_platform_projects SET shadow_replay_receipt=?').run(mirror);f.sql.exec('COMMIT');
  assert.equal(hash(JSON.stringify({identity:receipt.identity,report})),JSON.parse(f.sql.prepare('SELECT receipt_json FROM clank_platform_shadow_reports').get().receipt_json).reportDigest);
  assert.equal(f.sql.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects').get().shadow_replay_receipt,mirror);
  assert.throws(()=>shadow.readShadowReplays(f.internal,'project',hash),{code:'SHADOW_STATE_INVALID'});
  assert.throws(()=>shadow.assertShadowReplay(f.internal,'project',record,hash),{code:'SHADOW_STATE_INVALID'});
});
