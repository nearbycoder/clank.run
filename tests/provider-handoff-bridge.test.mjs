import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import * as handoff from '../dist/provider-handoff.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';
import * as oldReader from './fixtures/provider-handoff-protocol1.mjs';
import {openDockerDeploymentProviderService} from '../dist/provider-service.js';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const projectId='project_source';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'clank-bridge-catalog-')),root=join(dir,'provider'),executable=join(dir,'docker.mjs'),log=join(dir,'commands');
 await writeFile(executable,`#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(process.env.LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='info')process.stdout.write(JSON.stringify('daemon_native_fixture')+'\\n');`,{mode:0o700});
 const options={executable,dockerEnvironment:{LOG:log}},owned=[];
 const open=async()=>{const owner=await handoff.acquireProviderServiceOwnership(root,true);owned.push(owner);return owner;};
 const domain=owner=>handoff.createProviderHandoffDomain(owner,providerDockerClient(options),'node_source','owner-source');
 t.after(async()=>{for(const owner of owned.reverse())owner.close();await rm(dir,{recursive:true,force:true});});
 const owner=await open(),nativeDomain=await domain(owner),identity=await handoff.initializeProviderHandoff(owner,nativeDomain),project=await handoff.installProviderHandoffProject(owner,nativeDomain,projectId);
 return {dir,root,log,options,open,domain,owner,nativeDomain,identity,project,writer:join(root,'service','.writer.sqlite'),index:join(root,'service','handoff','index.sqlite'),catalog:join(root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite')};
}
function rows(file,table){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all().map(row=>({...row}));}finally{db.close();}}
function snapshot(f){return Object.fromEntries([f.writer,f.index,f.catalog].map(path=>[path,fs.readFileSync(path)]));}
function native(file,action){const db=new DatabaseSync(file);try{return action(db);}finally{db.close();}}
function mirroredGrant(db){return {grant:db.prepare('SELECT * FROM clank_provider_handoff_source_grant').get()??null,transfer:null,operations:[],spools:[]};}
async function enabled(t,overrides={}){const f=await fixture(t),bridge=await handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,{...limits,...overrides});return {...f,bridge};}
async function issued(t,overrides={}){const f=await enabled(t,overrides),binding=grant(f,f.bridge.enablementId);for(const [key,name] of [['maxTransactionBytes','maxCaptureTransactionBytes'],['maxStateBytes','maxCaptureStateBytes'],['maxJournalEntries','maxJournalEntries'],['maxJournalBytes','maxJournalBytes']])binding.capture[key]=overrides[name]??limits[name];const input={binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)};await handoff.issueProviderHandoffGrant(f.bridge,input);return {...f,binding,input};}
function grant(f,enablementId){return {protocol:'clank-provider-source-grant/1',enablementId,indexId:f.identity.indexId,catalogId:f.project.catalogId,domainSha256:f.identity.domainSha256,projectId,releaseId:'release_source',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:1000,gid:1000,capture:{keyId:'source_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};}
test('explicit protocol2 enablement preserves legacy rows and fixed identities',async t=>{
 const f=await fixture(t),before={owner:rows(f.writer,'clank_provider_handoff_owner'),index:rows(f.index,'clank_provider_handoff_index'),projects:rows(f.index,'clank_provider_handoff_projects'),catalog:rows(f.catalog,'clank_provider_handoff_catalog')};
 assert.equal(typeof handoff.enableProviderHandoffBridge,'function');
 const bridge=await handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits);assert.equal(bridge.mode,'bridge-live');
 assert.deepEqual(rows(f.writer,'clank_provider_handoff_owner'),before.owner);assert.deepEqual(rows(f.index,'clank_provider_handoff_index'),before.index);assert.deepEqual(rows(f.index,'clank_provider_handoff_projects'),before.projects);assert.deepEqual(rows(f.catalog,'clank_provider_handoff_catalog'),before.catalog);
 const view=await handoff.inspectProviderHandoffBridge(bridge);assert.equal(view.projects.length,1);assert.equal(view.projects[0].grant,null);assert.equal(view.reservations.length,0);
});
test('issued grants survive native reopen as cleanup-only and cannot be recycled',async t=>{
 const f=await fixture(t);assert.equal(typeof handoff.enableProviderHandoffBridge,'function');const bridge=await handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits),binding=grant(f,bridge.enablementId);
 const input={binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)};await handoff.issueProviderHandoffGrant(bridge,input);f.owner.close();
 const owner=await f.open(),domain=await f.domain(owner),reopened=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(reopened.mode,'cleanup-only');
 assert.equal((await handoff.inspectProviderHandoffBridge(reopened)).projects[0].grant.binding_json,JSON.stringify(binding));
 await assert.rejects(handoff.issueProviderHandoffGrant(reopened,input));
});
test('legacy owner reader refuses an extra bridge schema before native domain or cleanup effects',async t=>{
 const f=await fixture(t);f.owner.close();const db=new DatabaseSync(f.writer);try{db.exec('CREATE TABLE clank_provider_handoff_bridge_owner(id INTEGER PRIMARY KEY, protocol INTEGER) STRICT');}finally{db.close();}
 const before=await readFile(f.writer),commands=await readFile(f.log,'utf8');await assert.rejects(f.open(),/schema is unsupported/);assert.deepEqual(await readFile(f.writer),before);assert.equal(await readFile(f.log,'utf8'),commands);
});
test('actual frozen protocol1 reader rejects the exact empty protocol2 owner before effects',async t=>{
 const f=await enabled(t);f.owner.close();const before=snapshot(f),commands=await readFile(f.log,'utf8');
 await assert.rejects(oldReader.acquireProviderServiceOwnership(f.root),/schema is unsupported/);
 assert.deepEqual(snapshot(f),before);assert.equal(await readFile(f.log,'utf8'),commands);
});
test('ordinary admission of empty ready roots remains distinct and irreversible',async t=>{
 const f=await enabled(t);await assert.rejects(handoff.admitProviderService(f.owner,providerDockerClient(f.options),'owner-source'),/pre-admission/);f.owner.close();
 const owner=await f.open(),domain=await f.domain(owner);await handoff.admitProviderService(owner,providerDockerClient(f.options),'owner-source');
 await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/pre-admission/);await assert.rejects(handoff.installProviderHandoffProject(owner,domain,'another'),/pre-admission/);
});
test('private bridge capability and its native domain cannot be structurally forged',async t=>{
 const f=await enabled(t),before=snapshot(f);await assert.rejects(handoff.inspectProviderHandoffBridge({...f.bridge}),/genuine private/);assert.deepEqual(snapshot(f),before);f.owner.close();
 const owner=await f.open(),domain=await f.domain(owner);await assert.rejects(handoff.enableProviderHandoffBridge(owner,{...domain},limits),/genuine owner-bound/);assert.deepEqual(snapshot(f),before);
});
test('closed limits are captured before the native domain await and cannot be rebound',async t=>{
 const f=await fixture(t),input={...limits};const pending=handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,input);input.maxProjects=1;input.maxSpoolBytes=1;const bridge=await pending;
 assert.equal(JSON.parse(rows(f.writer,'clank_provider_handoff_bridge_owner')[0].limits_json).maxProjects,10);f.owner.close();
 const owner=await f.open(),domain=await f.domain(owner),before=snapshot(f);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,input),/cannot be rebound/);assert.deepEqual(snapshot(f),before);assert.equal(bridge.mode,'closed');
});
test('legacy permanent barrier bytes are preserved and cannot be enabled or adopted',async t=>{
 const f=await fixture(t),input={identity:{handoffId:'handoff_original',source:{projectId,nodeId:'node_source',releaseId:'release_source',generation:1},targetNodeId:'node_target',targetGeneration:2,artifactSha256:'a'.repeat(64)},stepId:'original_step',sourceCapsuleSha256:'b'.repeat(64),sourceIncarnation:randomUUID()};
 await handoff.insertProviderHandoffBarrier(f.owner,f.nativeDomain,projectId,input);const before=snapshot(f);await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits),/cannot be adopted/);assert.deepEqual(snapshot(f),before);
});
test('fixed roster cannot be expanded by a private legacy operation after enablement',async t=>{
 const f=await enabled(t);f.owner.close();const owner=await f.open(),domain=await f.domain(owner),before=snapshot(f);
 await assert.rejects(handoff.installProviderHandoffProject(owner,domain,'new_project'),/roster is immutable/);assert.deepEqual(snapshot(f),before);
});
test('first enablement refuses a retained roster over its current project ceiling',async t=>{
 const f=await fixture(t);await handoff.installProviderHandoffProject(f.owner,f.nativeDomain,'second_project');const before=snapshot(f);
 await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,{...limits,maxProjects:1}),/capacity/);assert.deepEqual(snapshot(f),before);
});
test('ignored owner marker publication cannot start installation',async t=>{
 const f=await fixture(t),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql);if(sql.startsWith('INSERT INTO clank_provider_handoff_bridge_owner'))s.run=()=>({changes:1});return s;};
 try{await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits));}finally{DatabaseSync.prototype.prepare=prepare;}f.owner.close();
 assert.equal(native(f.writer,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_provider_handoff_bridge_owner'").get().n),0);
 assert.equal(native(f.index,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_provider_handoff_bridge_index'").get().n),0);
});
test('partial native installation remains installing and restart never completes it',async t=>{
 const f=await fixture(t),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql);if(sql.startsWith('INSERT INTO clank_provider_handoff_bridge_state'))s.run=()=>({changes:1});return s;};
 try{await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits));}finally{DatabaseSync.prototype.prepare=prepare;}f.owner.close();
 assert.equal(rows(f.writer,'clank_provider_handoff_bridge_owner')[0].phase,'installing');const before=snapshot(f),owner=await f.open(),domain=await f.domain(owner);
 await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/installation is incomplete/);assert.deepEqual(snapshot(f),before);
});
test('native ignored and altered grant writes roll back rows and the catalog mirror',async t=>{
 for(const mode of ['ignored-trigger','altered-trigger','false-success','ignored-mirror']){
  const f=await enabled(t),before=rows(f.catalog,'clank_provider_handoff_bridge_state'),prepare=DatabaseSync.prototype.prepare;let injected=false;
  DatabaseSync.prototype.prepare=function(sql){
   if(!injected&&sql.startsWith('INSERT INTO clank_provider_handoff_source_grant')&&mode.endsWith('trigger')){injected=true;this.exec(mode==='ignored-trigger'?"CREATE TRIGGER refuse_grant BEFORE INSERT ON clank_provider_handoff_source_grant BEGIN SELECT RAISE(IGNORE); END":"CREATE TRIGGER alter_grant AFTER INSERT ON clank_provider_handoff_source_grant BEGIN UPDATE clank_provider_handoff_source_grant SET grant_secret_sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id=1; END");}
   const s=prepare.call(this,sql);if(mode==='false-success'&&sql.startsWith('INSERT INTO clank_provider_handoff_source_grant')||mode==='ignored-mirror'&&sql.startsWith('UPDATE clank_provider_handoff_bridge_state'))s.run=()=>({changes:1});return s;
  };
  try{await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,{binding:grant(f,f.bridge.enablementId),grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)}));}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(rows(f.catalog,'clank_provider_handoff_source_grant'),[]);assert.deepEqual(rows(f.catalog,'clank_provider_handoff_bridge_state'),before);
  assert.equal(native(f.catalog,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n),0);
 }
});
test('exact issued grant retry preserves version and conflicting identity never recycles it',async t=>{
 const f=await issued(t),before=rows(f.catalog,'clank_provider_handoff_bridge_state');await handoff.issueProviderHandoffGrant(f.bridge,f.input);assert.deepEqual(rows(f.catalog,'clank_provider_handoff_bridge_state'),before);
 const retained=rows(f.catalog,'clank_provider_handoff_source_grant');await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,{...f.input,binding:{...f.binding,grantId:randomUUID()}}),/cannot be recycled/);assert.deepEqual(rows(f.catalog,'clank_provider_handoff_source_grant'),retained);
});
test('grant input is immutable across the domain await',async t=>{
 const f=await enabled(t),binding=grant(f,f.bridge.enablementId),original=binding.releaseId,input={binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)};
 const pending=handoff.issueProviderHandoffGrant(f.bridge,input);binding.releaseId='different_release';input.grantSecretSha256='f'.repeat(64);await pending;
 const retained=rows(f.catalog,'clank_provider_handoff_source_grant')[0];assert.equal(JSON.parse(retained.binding_json).releaseId,original);assert.equal(retained.grant_secret_sha256,'d'.repeat(64));
});
test('native owner loss after grant INSERT rolls back before any acknowledgment',async t=>{
 const f=await enabled(t),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql);if(sql.startsWith('INSERT INTO clank_provider_handoff_source_grant')){const run=s.run.bind(s);s.run=(...args)=>{const result=run(...args);f.owner.close();return result;};}return s;};
 try{await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,{binding:grant(f,f.bridge.enablementId),grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)}),/native provider owner/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.deepEqual(rows(f.catalog,'clank_provider_handoff_source_grant'),[]);assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].version,1);
});
test('grant fsync uncertainty retains the committed intent and restart cleanup-only denial',async t=>{
 const f=await enabled(t),sync=fs.fsyncSync;let failed=false;
 fs.fsyncSync=function(fd){if(!failed&&fs.realpathSync('/proc/self/fd/'+fd)===f.catalog){failed=true;throw Error('native catalog sync fault');}return sync.call(this,fd);};
 syncBuiltinESMExports();try{await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,{binding:grant(f,f.bridge.enablementId),grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)}),/sync fault/);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}assert.equal(failed,true);assert.equal(f.bridge.mode,'cleanup-only');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant').length,1);f.owner.close();
 const owner=await f.open(),domain=await f.domain(owner),next=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(next.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(next)).projects[0].version,2);
});
test('all retained grant states deny ordinary restart including revoked and stopped',async t=>{
 for(const state of ['issued','revoked','stopped']){
  const f=await issued(t);f.owner.close();if(state!=='issued')native(f.catalog,db=>{db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE clank_provider_handoff_source_grant SET state=?').run(state);db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=?').run(hash(mirroredGrant(db)));db.exec('COMMIT');});
  const before=snapshot(f),owner=await f.open();await assert.rejects(handoff.admitProviderService(owner,providerDockerClient(f.options),'owner-source'),/refuses ordinary root startup/);owner.close();assert.deepEqual(snapshot(f),before);
  const cleanup=await f.open(),domain=await f.domain(cleanup),bridge=await handoff.enableProviderHandoffBridge(cleanup,domain,limits);assert.equal(bridge.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(bridge)).projects[0].grant.state,state);
 }
});
test('lost or altered native grant/mirror/roster state refuses without reconstruction',async t=>{
 for(const alter of [f=>native(f.catalog,db=>db.exec('DELETE FROM clank_provider_handoff_source_grant')),f=>native(f.catalog,db=>db.exec('DELETE FROM clank_provider_handoff_bridge_state')),f=>native(f.catalog,db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'")),f=>native(f.index,db=>db.exec("UPDATE clank_provider_handoff_projects SET project_id='changed_project'"))]){
  const f=await issued(t);f.owner.close();alter(f);const before=snapshot(f),owner=await f.open(),domain=await f.domain(owner);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits));owner.close();assert.deepEqual(snapshot(f),before);
 }
});
test('immutable spool reservations retain all capacity and exact retries preserve version',async t=>{
 const f=await issued(t,{maxArchiveBytes:64,maxSpoolBytes:64}),input={reservationId:randomUUID(),kind:'base',maximumBytes:64,inputSha256:'f'.repeat(64)};
 await handoff.reserveProviderHandoffSpool(f.bridge,projectId,input);const before=rows(f.index,'clank_provider_handoff_bridge_index');await handoff.reserveProviderHandoffSpool(f.bridge,projectId,input);assert.deepEqual(rows(f.index,'clank_provider_handoff_bridge_index'),before);
 assert.equal(rows(f.catalog,'clank_provider_handoff_source_spools').length,0);assert.equal((await handoff.inspectProviderHandoffBridge(f.bridge)).reservations[0].maximum_bytes,64);
 await assert.rejects(handoff.reserveProviderHandoffSpool(f.bridge,projectId,{reservationId:randomUUID(),kind:'tail',maximumBytes:1,inputSha256:'f'.repeat(64)}),/capacity/);assert.equal(rows(f.index,'clank_provider_handoff_spool_reservations').length,1);
});
test('ignored reservation and altered mirror writes roll back quota together',async t=>{
 for(const mode of ['reservation','mirror']){
  const f=await issued(t),before=rows(f.index,'clank_provider_handoff_bridge_index'),prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql);if(mode==='reservation'&&sql.startsWith('INSERT INTO clank_provider_handoff_spool_reservations')||mode==='mirror'&&sql.startsWith('UPDATE clank_provider_handoff_bridge_index'))s.run=()=>({changes:1});return s;};
  try{await assert.rejects(handoff.reserveProviderHandoffSpool(f.bridge,projectId,{reservationId:randomUUID(),kind:'base',maximumBytes:64,inputSha256:'f'.repeat(64)}));}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(rows(f.index,'clank_provider_handoff_spool_reservations'),[]);assert.deepEqual(rows(f.index,'clank_provider_handoff_bridge_index'),before);
 }
});
test('missing reservation with surviving mirror refuses and never frees retained capacity',async t=>{
 const f=await issued(t);await handoff.reserveProviderHandoffSpool(f.bridge,projectId,{reservationId:randomUUID(),kind:'base',maximumBytes:64,inputSha256:'f'.repeat(64)});f.owner.close();native(f.index,db=>db.exec('DELETE FROM clank_provider_handoff_spool_reservations'));
 const before=snapshot(f),owner=await f.open(),domain=await f.domain(owner);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/mirror/);assert.deepEqual(snapshot(f),before);
});
test('reservation fsync uncertainty keeps quota charged on cleanup-only restart',async t=>{
 const f=await issued(t),sync=fs.fsyncSync;let failed=false;fs.fsyncSync=function(fd){if(!failed&&fs.realpathSync('/proc/self/fd/'+fd)===f.index){failed=true;throw Error('native reservation sync fault');}return sync.call(this,fd);};syncBuiltinESMExports();
 try{await assert.rejects(handoff.reserveProviderHandoffSpool(f.bridge,projectId,{reservationId:randomUUID(),kind:'base',maximumBytes:128,inputSha256:'f'.repeat(64)}),/sync fault/);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
 assert.equal(failed,true);assert.equal(rows(f.index,'clank_provider_handoff_spool_reservations')[0].maximum_bytes,128);assert.equal(f.bridge.mode,'cleanup-only');f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);
 assert.equal(bridge.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(bridge)).reservations[0].maximum_bytes,128);
});
test('unknown future control rows refuse even with a coherently recomputed mirror',async t=>{
 const f=await issued(t);f.owner.close();native(f.catalog,db=>{db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(1,'future_enroll','enroll','{}',?,'accepted',NULL,NULL)").run(hash('{}'));const records=mirroredGrant(db);records.operations=db.prepare('SELECT * FROM clank_provider_handoff_source_operations').all();db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?,version=version+1').run(hash(records));db.exec('COMMIT');});
 const before=snapshot(f),owner=await f.open(),domain=await f.domain(owner);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/control records are unsupported/);assert.deepEqual(snapshot(f),before);
});
test('catalog corruption after commit is caught by the final asynchronous-domain readback',async t=>{
 const f=await enabled(t),sync=fs.fsyncSync;let altered=false;fs.fsyncSync=function(fd){const result=sync.call(this,fd);if(!altered&&fs.realpathSync('/proc/self/fd/'+fd)===f.catalog){altered=true;native(f.catalog,db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));}return result;};syncBuiltinESMExports();
 try{await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,{binding:grant(f,f.bridge.enablementId),grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)}),/mirror/);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}assert.equal(altered,true);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'revoked');assert.equal(f.bridge.mode,'cleanup-only');
});
test('existing capture bounds and key identifier endpoints are retained',async t=>{
 for(const patch of [{maxOperations:2},{maxOperations:257},{maxCaptureTransactionBytes:1023},{maxCaptureStateBytes:1023},{maxJournalBytes:1023},{maxProjects:101},{maxBatchEntries:1001}]){
  const f=await fixture(t),before=snapshot(f);await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,{...limits,...patch}),/limits are invalid/);assert.deepEqual(snapshot(f),before);
 }
 const f=await enabled(t),binding=grant(f,f.bridge.enablementId);binding.capture.keyId='k'.repeat(100);await handoff.issueProviderHandoffGrant(f.bridge,{binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)});assert.equal(JSON.parse(rows(f.catalog,'clank_provider_handoff_source_grant')[0].binding_json).capture.keyId.length,100);
 const other=await enabled(t),invalid=grant(other,other.bridge.enablementId);invalid.capture.keyId='k'.repeat(101);await assert.rejects(handoff.issueProviderHandoffGrant(other.bridge,{binding:invalid,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)}),/capture limits/);assert.deepEqual(rows(other.catalog,'clank_provider_handoff_source_grant'),[]);
});
test('native version exhaustion cannot allocate another quota reservation',async t=>{
 const f=await issued(t);native(f.index,db=>db.exec('UPDATE clank_provider_handoff_bridge_index SET version=9007199254740991'));const before=rows(f.index,'clank_provider_handoff_bridge_index');await assert.rejects(handoff.reserveProviderHandoffSpool(f.bridge,projectId,{reservationId:randomUUID(),kind:'base',maximumBytes:64,inputSha256:'f'.repeat(64)}),/capacity/);assert.deepEqual(rows(f.index,'clank_provider_handoff_bridge_index'),before);assert.deepEqual(rows(f.index,'clank_provider_handoff_spool_reservations'),[]);
});
test('actual independent writer acquisition in the enrollment commit gap prevents installation effects',async t=>{
 const f=await fixture(t),exec=DatabaseSync.prototype.exec;let contender,intercepted=false;
 DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(!intercepted&&sql==='COMMIT'){intercepted=true;contender=new DatabaseSync(f.writer);exec.call(contender,'PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}return result;};
 try{await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits),/locked|busy/);}finally{DatabaseSync.prototype.exec=exec;contender?.close();f.owner.close();}
 assert.equal(intercepted,true);assert.equal(rows(f.writer,'clank_provider_handoff_bridge_owner')[0].phase,'installing');assert.equal(native(f.index,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_provider_handoff_bridge_index'").get().n),0);
 const before=snapshot(f),owner=await f.open(),domain=await f.domain(owner);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/installation is incomplete/);assert.deepEqual(snapshot(f),before);
});
test('retained source grant refuses the actual ordinary factory before cleanup commands',async t=>{
 const f=await issued(t);f.owner.close();const before=snapshot(f),prior=(await readFile(f.log,'utf8')).trim().split('\n').length;
 await assert.rejects(openDockerDeploymentProviderService({rootDirectory:f.root,owner:'owner-source',image:'node@sha256:'+'b'.repeat(64),docker:{...f.options,user:'1000:1000'}}),/refuses ordinary root startup/);
 const commands=(await readFile(f.log,'utf8')).trim().split('\n').slice(prior).map(JSON.parse);assert.deepEqual(commands.map(args=>args[0]),['info']);assert.deepEqual(snapshot(f),before);
});
test('bridge owner WAL refuses before installation while ordinary protocol1 WAL still admits',async t=>{
 const f=await fixture(t);f.owner.close();native(f.writer,db=>assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal'));
 const owner=await f.open(),domain=await f.domain(owner),before=snapshot(f);await assert.rejects(handoff.enableProviderHandoffBridge(owner,domain,limits),/WAL sidecars|DELETE journal/);assert.deepEqual(snapshot(f),before);owner.close();
 assert.equal(native(f.writer,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_provider_handoff_bridge_owner'").get().n),0);
 const ordinary=await f.open();await handoff.admitProviderService(ordinary,providerDockerClient(f.options),'owner-source');assert.equal(native(f.writer,db=>db.prepare('PRAGMA journal_mode').get().journal_mode),'wal');
});
test('unexpected owner WAL or SHM sidecars refuse bridge installation without deletion',async t=>{
 for(const suffix of ['-wal','-shm']){const f=await fixture(t),file=f.writer+suffix;fs.writeFileSync(file,'retained foreign sidecar',{mode:0o600});const before=snapshot(f);await assert.rejects(handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,limits),/WAL sidecars/);assert.deepEqual(snapshot(f),before);assert.equal(fs.readFileSync(file,'utf8'),'retained foreign sidecar');fs.unlinkSync(file);}
});
