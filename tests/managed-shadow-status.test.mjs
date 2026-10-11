import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac,createHash,randomUUID} from 'node:crypto';
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
    history(project,guard){return internal.transaction(()=>{guard();const record=read(project),replays=shadow.readShadowReplays(internal,project,hash);const view=Object.freeze({replays,current:record,epoch:record?.epoch??0});shadow.selectShadowHistory(view,1);guard();return view})},
    replay(project,key,guard,bySession=false){return internal.transaction(()=>{guard();const record=read(project),replay=shadow.readShadowReplays(internal,project,hash).find(row=>bySession?row.receipt.identity.sessionId===key:row.receipt.identity.idempotencyKeyDigest===key);guard();return replay?Object.freeze({replay,current:record?.operation.sessionId===replay.receipt.identity.sessionId?record:null,epoch:record?.epoch??0}):null})},prepare,onError(){}});controllers.push(value);return value};
  t.after(async()=>{for(const value of controllers)await value.close();for(const value of held.values())await orchestrator.releaseLease(value).catch(()=>{});orchestrator.close();database.close();sql.close();lease.close();await rm(root,{recursive:true,force:true})});
  return{root,sql,internal,lease,orchestrator,held,acquire,current,read,operation,save,retirement,adapter,controller};
}
function preparing(f,record){const op=record.operation;return f.save('project',record,{...op,capsuleSha256:hash('capsule'),primary:{projectId:'project',releaseId:op.primaryReleaseId,generation:op.credentialGeneration,fence:op.primaryFence,incarnation:randomUUID()},phase:'preparing',updatedAt:Math.max(Date.now(),op.updatedAt)})}


const signing=canonical=>createHmac('sha256','native-shadow-cursor-key').update('clank-shadow-cursor/1\n').update(canonical).digest();
const cursor=(change={})=>({version:1,projectId:'project',ceilingEpoch:9,beforeEpoch:5,...change});
const encode=canonical=>'clankshc1.'+Buffer.from(canonical).toString('base64url')+'.'+signing(canonical).toString('base64url');
test('shadow cursor selected canonical bytes, signature and maximum are deterministic',()=>{
 const maximum=cursor({projectId:'_'.repeat(128),ceilingEpoch:Number.MAX_SAFE_INTEGER,beforeEpoch:Number.MAX_SAFE_INTEGER}),token=shadow.shadowCursorToken(maximum,signing),parsed=shadow.parseShadowCursorToken(token);
 assert.deepEqual(parsed.payload,maximum);assert.deepEqual(Buffer.from(parsed.signature),signing(parsed.canonical));assert.equal(Buffer.byteLength(parsed.canonical),219);assert.ok(token.length<=512);assert.equal(token,encode(JSON.stringify(maximum)));
 assert.deepEqual(shadow.shadowStatusQuery('?limit=20&before='+token),{limit:20,before:token});assert.deepEqual(shadow.shadowStatusQuery('?before='+token+'&limit=1'),{limit:1,before:token});
});
for(const [name,canonical]of[
 ['unknown property',JSON.stringify({...cursor(),extra:1})],['duplicate property','{"version":1,"version":1,"projectId":"project","ceilingEpoch":9,"beforeEpoch":5}'],
 ['order','{"projectId":"project","version":1,"ceilingEpoch":9,"beforeEpoch":5}'],['whitespace',' '+JSON.stringify(cursor())],['escaped key','{"version":1,"projectId":"proje\\u0063t","ceilingEpoch":9,"beforeEpoch":5}'],
 ['decimal epoch','{"version":1,"projectId":"project","ceilingEpoch":9.0,"beforeEpoch":5}'],['exponent epoch','{"version":1,"projectId":"project","ceilingEpoch":9e0,"beforeEpoch":5}'],
 ['zero',JSON.stringify(cursor({beforeEpoch:0}))],['future boundary',JSON.stringify(cursor({beforeEpoch:10}))],['unsafe integer',JSON.stringify(cursor({ceilingEpoch:Number.MAX_SAFE_INTEGER+1}))],
 ['non-ASCII project',JSON.stringify(cursor({projectId:'é'}))],['overlong project',JSON.stringify(cursor({projectId:'x'.repeat(129)}))],['decoded byte overflow',' '.repeat(257)],
])test('closed cursor rejects '+name,()=>assert.throws(()=>shadow.parseShadowCursorToken(encode(canonical)),{code:'SHADOW_CURSOR_INVALID'}));
test('cursor transport refuses padding, extra segments, short signatures and invalid UTF8',()=>{
 const good=shadow.shadowCursorToken(cursor(),signing),parts=good.split('.');
 for(const bad of[good+'=',good+'.tail',parts[0]+'.'+parts[1]+'=.'+parts[2],parts.slice(0,2).join('.')+'.'+parts[2].slice(1),'x'.repeat(513),'clankshc1._w.'+parts[2]])assert.throws(()=>shadow.parseShadowCursorToken(bad),{code:'SHADOW_CURSOR_INVALID'});
 assert.throws(()=>shadow.shadowCursorToken(cursor(),()=>new Uint8Array(31)),{code:'SHADOW_CURSOR_INVALID'});
});
test('literal shadow query grammar rejects decoding and alternate framing',()=>{
 assert.deepEqual(shadow.shadowStatusQuery(''),{limit:20});
 for(const bad of['?','?limit=','?limit=0','?limit=21','?limit=01','?limit=1.0','?limit=1e0','?limit=+1','?limit=%31','?%6cimit=1','?LIMIT=1','?limit=1&limit=1','?limit=1&','?&limit=1','?limit=1;before=x','?limit=1=2','?before=','?before=x','?extra=1'])assert.throws(()=>shadow.shadowStatusQuery(bad),{code:'SHADOW_CURSOR_INVALID'});
});
const nativeView=f=>f.internal.transaction(()=>{f.current('project');const record=f.read();const view={replays:shadow.readShadowReplays(f.internal,'project',hash),current:record,epoch:record?.epoch??0};shadow.selectShadowHistory(view,1);f.current('project');return view});
test('native history keeps stable original-epoch membership across new sessions and configured pruning',async t=>{
 const f=await fixture(t),current=await f.acquire();let record=null;
 for(let index=0;index<5;index++){record=f.save('project',record,f.operation(),current);record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted')}
 const view=nativeView(f),page=shadow.selectShadowHistory(view,2),before={version:1,projectId:'project',ceilingEpoch:page.ceilingEpoch,beforeEpoch:page.nextEpoch};
 assert.equal(page.views.length,2);assert.ok(page.nextEpoch);assert.equal(view.replays.filter(row=>row.report!==null).length,1);
 const firstIDs=page.views.map(row=>row.replay.receipt.identity.sessionId);record=f.save('project',record,f.operation(),current);record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');
 const later=shadow.selectShadowHistory(nativeView(f),20,before);assert.equal(later.views.length,3);assert.equal(later.nextEpoch,null);assert.equal(later.ceilingEpoch,page.ceilingEpoch);assert.ok(later.views.every(row=>!firstIDs.includes(row.replay.receipt.identity.sessionId)));assert.ok(later.views.every(row=>row.replay.report===null));
 assert.throws(()=>shadow.selectShadowHistory(view,1,cursor({ceilingEpoch:view.epoch+1,beforeEpoch:1})),{code:'SHADOW_STATE_INVALID'});
});
test('history publication retains the same native owner capability across awaits and later owners',async t=>{
 const f=await fixture(t),entered=[],controller=f.controller(async(id,read,change,current,signal)=>{entered.push(read().operation.sessionId);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));current();throw new Error('Stopped')});
 const first=await controller.start('project',f.operation(),()=>{});await until(()=>entered.length===1,'first native owner');
 const captured=controller.history('project'),before=f.read().serialized;assert.deepEqual(Object.keys(captured).sort(),['assertCurrent','view']);await Promise.resolve();captured.assertCurrent();assert.equal(f.read().serialized,before);
 await controller.requestStop('project',first.operation.sessionId,first.operation.operationId,first.operation.controllerEpoch,()=>{});await until(()=>f.held.size===0,'old owner release');
 const second=await controller.start('project',f.operation(),()=>{});await until(()=>entered.length===2,'replacement native owner');assert.throws(captured.assertCurrent,{code:'SHADOW_SUPERSEDED'});
 const history=controller.history('project'),old=history.view.replays.find(row=>row.receipt.identity.sessionId===first.operation.sessionId);assert.equal(old.receipt.identity.phase,'complete');assert.equal(history.view.current.operation.sessionId,second.operation.sessionId);assert.equal(entered.length,2);
 f.sql.exec('DELETE FROM clank_distributed_leases');assert.throws(history.assertCurrent);assert.throws(()=>controller.history('project'));assert.equal(f.read().operation.sessionId,second.operation.sessionId);
});

test('native 1024-fence history remains bounded with exactly 100 retained reports',{timeout:240000},async t=>{
 const f=await fixture(t),current=await f.acquire(),configured={...policy(),maxReports:100};let record=null;const started=performance.now();
 for(let index=0;index<1024;index++){
  if(index%8===0){f.lease.renew();const renewed=await f.orchestrator.renewLease(f.held.get('project'));assert.ok(renewed);f.held.set('project',renewed)}
  record=f.save('project',record,f.operation('project',configured),current);record=await shadow.retireShadow(f.adapter,'project',record,current,'interrupted');
 }
 const before=f.sql.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports ORDER BY session_id').all(),view=nativeView(f);assert.equal(view.replays.length,1024);assert.equal(view.replays.filter(row=>row.report!==null).length,100);
 let cursorValue,read=0,pages=0;do{const page=shadow.selectShadowHistory(view,20,cursorValue);assert.ok(page.views.length<=20);read+=page.views.length;pages++;cursorValue=page.nextEpoch===null?undefined:cursor({ceilingEpoch:page.ceilingEpoch,beforeEpoch:page.nextEpoch});if(page.nextEpoch===null)break;}while(pages<=52);
 assert.equal(read,1024);assert.equal(pages,52);assert.deepEqual(f.sql.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports ORDER BY session_id').all(),before);
 assert.throws(()=>shadow.selectShadowHistory({...view,replays:[...view.replays,view.replays[0]]},20),{code:'SHADOW_STATE_INVALID'});t.diagnostic(JSON.stringify({fences:1024,bodies:100,pages,elapsedMs:Math.floor(performance.now()-started)}));
});

test('canonical review token refuses a UTF8 BOM wire alias using its original signature',()=>{
 const configured=policy(),effective=shadow.narrowShadowPolicy(configured,{}),now=Date.now(),raw=shadow.normalizeShadowReview({version:1,projectId:'project',releaseId:'candidate',artifactSha256:hash('artifact'),primaryReleaseId:'primary',primaryGeneration:1,primaryFence:2,primaryIncarnation:randomUUID(),primaryArtifactSha256:hash('primary'),nodeId:'node',providerBindingDigest:hash('binding'),credentialGeneration:1,principalBindingDigest:hash('principal'),policyRevision:1,policyDigest:hash(JSON.stringify(configured)),selection:shadow.shadowReviewSelection(configured,effective),expectedEpoch:0,issuedAt:now,expiresAt:now+120000,nonce:Buffer.alloc(16,1).toString('base64url'),reviewDigest:hash('review')}),good=shadow.shadowReviewToken(raw,signing),parts=good.split('.');
 assert.deepEqual(shadow.parseShadowReviewToken(good).payload,raw);parts[1]=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(parts[1],'base64url')]).toString('base64url');assert.throws(()=>shadow.parseShadowReviewToken(parts.join('.')),{code:'SHADOW_REVIEW_INVALID'});
});
