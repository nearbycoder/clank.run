import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import * as handoff from '../dist/provider-handoff.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';
import {openDeploymentProviderDataStore} from '../dist/provider-data.js';
import {createDeploymentBundle} from '../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../dist/runtime-placement.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';

// Native ownership/catalog/pin tests with an explicitly scripted Docker info
// transport. These are not running-container, mount, worker or readiness proof.
const hash=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
async function fixture(t,projects=1,overrides={}){
  const directory=await mkdtemp(join(tmpdir(),'clank-grant-lease-')),root=join(directory,'provider'),control=join(directory,'control.json'),log=join(directory,'commands'),executable=join(directory,'docker.mjs');
  await writeFile(control,JSON.stringify({daemon:'scripted_lease_domain'}));
  await writeFile(executable,`#!/usr/bin/env node
import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2);if(JSON.stringify(args)!==JSON.stringify(['info','--format','{{json .ID}}']))throw Error('Unexpected component command');
fs.appendFileSync(process.env.LOG,JSON.stringify(args)+'\\n');
const config=JSON.parse(fs.readFileSync(process.env.CONTROL,'utf8'));
if(config.hold){fs.writeFileSync(config.hold,'held');const end=Date.now()+5000;while(!fs.existsSync(config.release)){if(Date.now()>end)process.exit(75);await delay(10);}}
process.stdout.write(JSON.stringify(config.daemon)+'\\n');
`,{mode:0o700});
  const owner=await handoff.acquireProviderServiceOwnership(root,true),client=providerDockerClient({executable,dockerEnvironment:{CONTROL:control,LOG:log}});
  const domain=await handoff.createProviderHandoffDomain(owner,client,'lease_node','lease_owner'),identity=await handoff.initializeProviderHandoff(owner,domain),installed=[];
  for(let n=0;n<projects;n++)installed.push(await handoff.installProviderHandoffProject(owner,domain,'lease_project_'+n));
  const bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits),sources=[];
  for(const project of installed){
    const key=randomBytes(32),binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:project.projectId,releaseId:'lease_release',generation:1,capsuleSha256:overrides.capsuleSha256??'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:process.getuid(),gid:process.getgid(),capture:{keyId:'lease_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
    await handoff.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:hash(randomBytes(32)),controlSecretSha256:hash(key)});
    const catalog=join(root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite'),input={projectId:project.projectId,grantId:binding.grantId,bindingSha256:hash(binding),containerId:'d'.repeat(64),expectedVersion:4};
    // Explicit component-only row setup, never native container observations.
    mutate(catalog,db=>{db.prepare("UPDATE clank_provider_handoff_source_grant SET state='started',container_id=?").run(input.containerId);db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=3').run();});
    sources.push({binding,key,catalog,input});
  }
  t.after(async()=>{owner.close();await rm(directory,{recursive:true,force:true});});
  const source=sources[0],index=join(root,'service','handoff','index.sqlite'),writer=join(root,'service','.writer.sqlite');
  return {...source,sources,directory,root,owner,bridge,domain,identity,client,control,log,index,writer,
    retain:(item=source)=>handoff.retainProviderSourceGrant(bridge,item.input,item.key),
    snapshot:()=>Object.fromEntries([writer,index,...sources.map(s=>s.catalog)].map(path=>[path,fs.readFileSync(path)])),
    pins:()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root+'/')?[{fd:Number(fd),path}]:[];}catch{return [];}}),
  };
}
function mutate(path,action){
  const db=new DatabaseSync(path);try{
    db.exec('BEGIN IMMEDIATE');action(db);
    const records={grant:db.prepare('SELECT * FROM clank_provider_handoff_source_grant').get()??null,transfer:null,operations:[],spools:[]};
    db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=? WHERE id=1').run(hash(records));db.exec('COMMIT');
  }finally{db.close();}
}
function cloneNative(source,target){
  fs.cpSync(source,target,{recursive:true,preserveTimestamps:true});
  const preserve=(original,copy)=>{
    const stat=fs.lstatSync(original);assert.equal(stat.isSymbolicLink(),false);
    fs.chmodSync(copy,stat.mode&0o777);assert.equal(fs.lstatSync(copy).mode&0o777,stat.mode&0o777);
    if(stat.isDirectory())for(const name of fs.readdirSync(original))preserve(join(original,name),join(copy,name));
    else assert.deepEqual(fs.readFileSync(copy),fs.readFileSync(original));
  };
  // Node24's directory copy creates mode0755 here from mode0700. Make the
  // replacement independently identical in bytes/modes before probing inode
  // refusal; a prior permission refusal would not test that boundary.
  preserve(source,target);
}
async function held(f,action){
  const hold=join(f.directory,'held'),release=join(f.directory,'release');
  fs.writeFileSync(f.control,JSON.stringify({daemon:'scripted_lease_domain',hold,release}));
  const pending=action();pending.catch(()=>{});
  const end=Date.now()+4000;
  while(!fs.existsSync(hold)){if(Date.now()>end){fs.writeFileSync(release,'release');await pending;throw Error('Owned lease checkpoint not reached');}await new Promise(resolve=>setTimeout(resolve,10));}
  return {pending,release:()=>{fs.writeFileSync(f.control,JSON.stringify({daemon:'scripted_lease_domain'}));fs.writeFileSync(release,'release');}};
}

test('retains the original native started grant without catalog writes or worker authority',async t=>{
  const f=await fixture(t),before=f.snapshot(),pins=f.pins(),lease=await f.retain();
  assert.deepEqual(lease.binding,f.binding);assert.ok(Object.isFrozen(lease));assert.ok(Object.isFrozen(lease.binding));assert.ok(Object.isFrozen(lease.binding.capture));
  assert.deepEqual(Reflect.ownKeys(lease).sort(),['assertCurrent','binding','close','verifyCurrent']);
  assert.equal(f.pins().length,pins.length+5);lease.assertCurrent();handoff.assertProviderSourceGrantLease(lease);await lease.verifyCurrent();
  // An unrelated inspection releases only its own transient pin stack.
  await handoff.inspectProviderHandoffBridge(f.bridge);assert.equal(f.pins().length,pins.length+5);lease.assertCurrent();
  assert.deepEqual(f.snapshot(),before);lease.close();lease.close();assert.deepEqual(f.pins(),pins);assert.throws(()=>lease.assertCurrent(),/closed/);
  assert.ok(fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).every(args=>args[0]==='info'));
});

test('copied and serialized lease facades cannot pass the genuine lease check',async t=>{
  const f=await fixture(t),lease=await f.retain();let getters=0;
  for(const copy of [{...lease},JSON.parse(JSON.stringify(lease)),{},null,new Proxy({}, {get(){getters++;return lease.assertCurrent;}})])assert.throws(()=>handoff.assertProviderSourceGrantLease(copy),/genuine/);
  assert.equal(getters,0);lease.assertCurrent();lease.close();
});

test('captures input and native key bytes before caller mutation across the first await',async t=>{
  const f=await fixture(t),input={...f.input},key=new Uint8Array(f.key),original=new Uint8Array(key),pending=handoff.retainProviderSourceGrant(f.bridge,input,key);
  input.grantId=randomUUID();input.containerId='e'.repeat(64);input.expectedVersion=99;key.fill(0);
  const lease=await pending;assert.deepEqual(lease.binding,f.binding);assert.notDeepEqual(key,original);lease.close();
});

test('native key getters and iterators are not invoked or retained',async t=>{
  const f=await fixture(t),key=new Uint8Array(f.key),original=new Uint8Array(key);let getters=0;
  for(const name of ['byteLength','buffer',Symbol.iterator])Object.defineProperty(key,name,{get(){getters++;throw Error('caller key hook');}});
  const lease=await handoff.retainProviderSourceGrant(f.bridge,f.input,key);assert.equal(getters,0);assert.deepEqual(new Uint8Array(key),original);lease.close();
});

test('rejects malformed own-data input and keys before native effects',async t=>{
  const f=await fixture(t),before=f.snapshot(),log=fs.readFileSync(f.log,'utf8');let getters=0;
  const accessor={...f.input};Object.defineProperty(accessor,'projectId',{get(){getters++;return f.input.projectId;}});
  for(const input of [null,[],{...f.input,extra:true},{...f.input,[Symbol()]:true},accessor,{...f.input,expectedVersion:3},{...f.input,expectedVersion:4.5},{...f.input,containerId:'bad'}])await assert.rejects(handoff.retainProviderSourceGrant(f.bridge,input,f.key));
  const detached=new Uint8Array(32);structuredClone(detached.buffer,{transfer:[detached.buffer]});
  for(const key of [null,{},new Uint8Array(31),new Uint8Array(33),new Uint8Array(new SharedArrayBuffer(32)),detached])await assert.rejects(handoff.retainProviderSourceGrant(f.bridge,f.input,key));
  await assert.rejects(handoff.retainProviderSourceGrant({...f.bridge},f.input,f.key),/genuine/);
  assert.equal(getters,0);assert.deepEqual(f.snapshot(),before);assert.equal(fs.readFileSync(f.log,'utf8'),log);
});

for(const [name,change] of [
  ['wrong control secret',f=>f.key=randomBytes(32)],
  ['foreign project',f=>f.input.projectId='other_project'],
  ['foreign grant',f=>f.input.grantId=randomUUID()],
  ['foreign binding',f=>f.input.bindingSha256='e'.repeat(64)],
  ['foreign container',f=>f.input.containerId='e'.repeat(64)],
  ['stale version',f=>f.input.expectedVersion=5],
  ['created grant',f=>{mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='created'").run());f.input.expectedVersion=5;}],
  ['revoked grant',f=>{mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run());f.input.expectedVersion=5;}],
  ['unsupported ready grant',f=>{mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='ready'").run());f.input.expectedVersion=5;}],
])test('retention refuses '+name+' without publication or leaked pins',async t=>{
  const f=await fixture(t);change(f);const pins=f.pins(),before=f.snapshot();await assert.rejects(handoff.retainProviderSourceGrant(f.bridge,f.input,f.key));assert.deepEqual(f.pins(),pins);assert.deepEqual(f.snapshot(),before);
});

for(const target of ['catalog','catalog parent','index','handoff directory'])test('identical native '+target+' replacement permanently closes the retained lease',async t=>{
  const f=await fixture(t),before=f.pins(),lease=await f.retain(),path=target==='catalog'?f.catalog:target==='catalog parent'?dirname(f.catalog):target==='index'?f.index:dirname(f.index);
  fs.renameSync(path,path+'.old');cloneNative(path+'.old',path);
  assert.throws(()=>lease.assertCurrent(),/identity changed/);assert.equal(f.pins().length,before.length);
  fs.rmSync(path,{recursive:true});fs.renameSync(path+'.old',path);assert.throws(()=>lease.assertCurrent(),/closed/);
});

for(const [name,change] of [
  ['revocation',f=>mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run())],
  ['version rollback',f=>mutate(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=2').run())],
  ['version advance with identical records',f=>mutate(f.catalog,()=>{})],
  ['catalog mirror corruption',f=>{const db=new DatabaseSync(f.catalog);try{db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?').run('e'.repeat(64));}finally{db.close();}}],
  ['native catalog mode drift',f=>fs.chmodSync(f.catalog,0o644)],
  ['foreign control key digest',f=>mutate(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_source_grant SET control_secret_sha256=?').run('e'.repeat(64)))],
  ['native index version drift',f=>{const db=new DatabaseSync(f.index);try{db.exec('UPDATE clank_provider_handoff_bridge_index SET version=version+1');}finally{db.close();}}],
])test('fresh '+name+' refuses retained grant use and releases owned pins',async t=>{
  const f=await fixture(t),before=f.pins(),lease=await f.retain();change(f);assert.throws(()=>handoff.assertProviderSourceGrantLease(lease));assert.deepEqual(f.pins(),before);assert.throws(()=>lease.assertCurrent(),/closed/);
});

test('owner closure releases lease pins and permanently refuses the original facade',async t=>{
  const f=await fixture(t),lease=await f.retain();f.owner.close();assert.deepEqual(f.pins(),[]);assert.throws(()=>lease.assertCurrent(),/closed|owner/);await assert.rejects(lease.verifyCurrent());lease.close();
});

test('domain drift in the final retention probe closes unpublished retained pins',async t=>{
  const f=await fixture(t),pins=f.pins();let probing=0;
  // The fixed child script records its info command before its output. Hold the
  // second probe by configuring it synchronously at the first native key check.
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql){const result=prepare.call(this,sql);if(sql==='SELECT * FROM clank_provider_handoff_source_grant LIMIT 2'){
    const all=result.all.bind(result);result.all=(...args)=>{const rows=all(...args);if(++probing===2)fs.writeFileSync(f.control,JSON.stringify({daemon:'changed_lease_domain'}));return rows;};
  }return result;};
  try{await assert.rejects(f.retain(),/domain changed/);}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.ok(probing>=2);assert.deepEqual(f.pins(),pins);
});

for(const change of ['revocation','catalog replacement','owner closure'])test('native '+change+' during the final retention await prevents facade publication',async t=>{
  const f=await fixture(t),pins=f.pins(),hold=join(f.directory,'publish-held'),release=join(f.directory,'publish-release'),open=fs.openSync;let catalogs=0,pending;
  fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(path===f.catalog&&++catalogs===3)fs.writeFileSync(f.control,JSON.stringify({daemon:'scripted_lease_domain',hold,release}));return fd;};syncBuiltinESMExports();
  try{
    pending=f.retain();pending.catch(()=>{});const end=Date.now()+4000;
    while(!fs.existsSync(hold)){if(Date.now()>end)throw Error('Final retention checkpoint missing');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(f.pins().length,pins.length+5,'lease pins exist before publication');
    if(change==='revocation')mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run());
    if(change==='catalog replacement'){fs.renameSync(f.catalog,f.catalog+'.old');fs.copyFileSync(f.catalog+'.old',f.catalog);fs.chmodSync(f.catalog,0o600);}
    if(change==='owner closure')f.owner.close();
    fs.writeFileSync(release,'release');await assert.rejects(pending);
  }finally{fs.openSync=open;syncBuiltinESMExports();fs.writeFileSync(release,'release');await pending?.catch(()=>{});}
  assert.ok(catalogs>=3);assert.deepEqual(f.pins(),change==='owner closure'?[]:pins);
});

for(const change of ['revocation','catalog replacement','owner closure','lease closure','daemon drift'])test('native '+change+' during domain wait prevents a verification acknowledgment',async t=>{
  const f=await fixture(t),pins=f.pins(),lease=await f.retain(),pause=await held(f,()=>lease.verifyCurrent());
  if(change==='revocation')mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run());
  if(change==='catalog replacement'){fs.renameSync(f.catalog,f.catalog+'.old');fs.copyFileSync(f.catalog+'.old',f.catalog);fs.chmodSync(f.catalog,0o600);}
  if(change==='owner closure')f.owner.close();if(change==='lease closure')lease.close();
  if(change==='daemon drift')fs.writeFileSync(f.control,JSON.stringify({daemon:'other_lease_domain'}));
  if(change==='daemon drift'){
    // The first response was captured before the change. The second domain
    // probe must refuse this same verification, not merely a subsequent call.
    fs.writeFileSync(join(f.directory,'release'),'release');await assert.rejects(pause.pending,/domain changed/);
  }else{pause.release();await assert.rejects(pause.pending);}
  assert.deepEqual(f.pins(),change==='owner closure'?[]:pins);assert.throws(()=>lease.assertCurrent(),/closed/);
});

test('a read-only MAX version lease performs no update or numeric increment',async t=>{
  const f=await fixture(t);mutate(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=?').run(Number.MAX_SAFE_INTEGER-1));f.input.expectedVersion=Number.MAX_SAFE_INTEGER;
  const before=f.snapshot(),lease=await f.retain();lease.assertCurrent();assert.deepEqual(f.snapshot(),before);lease.close();
});

test('a closed source grant lease cannot be recycled',async t=>{
  const f=await fixture(t),pins=f.pins(),lease=await f.retain();lease.close();assert.deepEqual(f.pins(),pins);await assert.rejects(f.retain(),/duplicated or recycled/);assert.deepEqual(f.pins(),pins);
});

test('duplicate retention cannot replace a live original lease',async t=>{
  const f=await fixture(t),pins=f.pins(),lease=await f.retain();await assert.rejects(f.retain(),/duplicated or recycled/);
  assert.throws(()=>lease.assertCurrent());assert.deepEqual(f.pins(),pins);lease.close();
});

test('a reopened owner cannot adopt an earlier started grant lease',async t=>{
  const f=await fixture(t),lease=await f.retain();f.owner.close();
  const owner=await handoff.acquireProviderServiceOwnership(f.root),domain=await handoff.createProviderHandoffDomain(owner,f.client,'lease_node','lease_owner');
  try{const bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(bridge.mode,'cleanup-only');await assert.rejects(handoff.retainProviderSourceGrant(bridge,f.input,f.key),/live provider bridge/);assert.throws(()=>lease.assertCurrent(),/closed/);}finally{owner.close();}
  assert.deepEqual(f.pins(),[]);
});

test('owner lane capacity refuses bounded concurrent verification and releases all lease pins',async t=>{
  const f=await fixture(t),pins=f.pins(),lease=await f.retain(),pause=await held(f,()=>lease.verifyCurrent());
  const pending=Array.from({length:16},()=>lease.verifyCurrent());const observed=Promise.allSettled(pending);
  pause.release();await assert.rejects(pause.pending);const results=await observed;assert.ok(results.every(result=>result.status==='rejected'));
  assert.ok(results.some(result=>/capacity exceeded/.test(result.reason.message)));assert.deepEqual(f.pins(),pins);assert.throws(()=>lease.assertCurrent(),/closed/);
});

test('two retained sources exhaust the fixed owner limit and owner closure releases both',async t=>{
  const f=await fixture(t,3),one=await f.retain(f.sources[0]),two=await f.retain(f.sources[1]),pins=f.pins();
  await assert.rejects(f.retain(f.sources[2]),/duplicated or recycled/);assert.deepEqual(f.pins(),pins);f.owner.close();assert.deepEqual(f.pins(),[]);assert.throws(()=>one.assertCurrent());assert.throws(()=>two.assertCurrent());
});

test('closing one source retains the other source and its independent descriptor lifetime',async t=>{
  const f=await fixture(t,2),pins=f.pins(),one=await f.retain(f.sources[0]),two=await f.retain(f.sources[1]);
  assert.equal(f.pins().length,pins.length+14);one.close();assert.equal(f.pins().length,pins.length+7);await two.verifyCurrent();two.close();assert.deepEqual(f.pins(),pins);
});

test('a sibling native grant mutation invalidates the complete retained roster observation',async t=>{
  const f=await fixture(t,2),pins=f.pins(),one=await f.retain(f.sources[0]);mutate(f.sources[1].catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run());
  assert.throws(()=>one.assertCurrent(),/consulted state changed/);assert.deepEqual(f.pins(),pins);
});

test('a close fault still attempts every owned pin and owner SQLite cleanup',async t=>{
  const f=await fixture(t),base=f.pins(),one=await f.retain(),held=f.pins().filter(p=>!base.some(b=>b.fd===p.fd)),close=fs.closeSync,attempted=[];
  fs.closeSync=function(fd){if(held.some(p=>p.fd===fd)){attempted.push(fd);const result=close.call(this,fd);if(attempted.length===1)throw Error('owned close uncertainty');return result;}return close.call(this,fd);};syncBuiltinESMExports();
  try{assert.throws(()=>f.owner.close(),/owned close uncertainty/);}finally{fs.closeSync=close;syncBuiltinESMExports();}
  assert.deepEqual(new Set(attempted),new Set(held.map(p=>p.fd)));assert.deepEqual(f.pins(),[]);assert.throws(()=>one.assertCurrent(),/closed/);one.close();
});

test('multiple close faults preserve both lease failures and still close owner storage',async t=>{
  const f=await fixture(t,2),pins=f.pins(),one=await f.retain(f.sources[0]),two=await f.retain(f.sources[1]),held=f.pins().filter(p=>!pins.some(b=>b.fd===p.fd)),close=fs.closeSync,attempted=[],dbClose=DatabaseSync.prototype.close;
  fs.closeSync=function(fd){if(held.some(p=>p.fd===fd)){attempted.push(fd);close.call(this,fd);if(attempted.length===1||attempted.length===8)throw Error('owned pin uncertainty '+attempted.length);return;}return close.call(this,fd);};
  DatabaseSync.prototype.close=function(){const result=dbClose.call(this);throw Error('owned database close uncertainty');};syncBuiltinESMExports();
  let failure;try{f.owner.close();}catch(error){failure=error;}finally{fs.closeSync=close;DatabaseSync.prototype.close=dbClose;syncBuiltinESMExports();}
  assert.ok(failure instanceof AggregateError);assert.ok(failure.errors[0] instanceof AggregateError);
  assert.deepEqual(failure.errors[0].errors.map(error=>error.message),['owned pin uncertainty 1','owned pin uncertainty 8']);assert.equal(failure.errors[1].message,'owned database close uncertainty');
  assert.deepEqual(new Set(attempted),new Set(held.map(p=>p.fd)));assert.deepEqual(f.pins(),[]);assert.throws(()=>one.assertCurrent(),/closed/);assert.throws(()=>two.assertCurrent(),/closed/);
});

for(const cleanupFault of [false,true])test('partial retention pin failure closes every acquired descriptor'+(cleanupFault?' despite a cleanup fault':''),async t=>{
  const f=await fixture(t),pins=f.pins(),open=fs.openSync,close=fs.closeSync;let catalogs=0,failed=false,cleanup=false;
  fs.openSync=function(path,...args){if(path===f.catalog&&++catalogs===3){failed=true;throw Error('owned retention open fault');}return open.call(this,path,...args);};
  fs.closeSync=function(fd){const result=close.call(this,fd);if(failed&&cleanupFault&&!cleanup){cleanup=true;throw Error('owned retention cleanup uncertainty');}return result;};syncBuiltinESMExports();
  let failure;try{await f.retain();}catch(error){failure=error;}finally{fs.openSync=open;fs.closeSync=close;syncBuiltinESMExports();}
  assert.equal(failed,true);assert.equal(cleanup,cleanupFault);assert.ok(failure);
  if(cleanupFault){assert.ok(failure instanceof AggregateError);assert.deepEqual(failure.errors.map(error=>error.message),['owned retention open fault','owned retention cleanup uncertainty']);}
  else assert.equal(failure.message,'owned retention open fault');
  assert.deepEqual(f.pins(),pins);
});

async function dataFixture(t,nested=false){
  const source=await mkdtemp(join(tmpdir(),'clank-source-data-capsule-'));t.after(()=>rm(source,{recursive:true,force:true}));
  fs.mkdirSync(join(source,'dist'));fs.mkdirSync(join(source,'migrations'));
  fs.writeFileSync(join(source,'dist','server.js'),'export const source = true;\n');
  fs.writeFileSync(join(source,'migrations','0001_seed.sql'),"CREATE TABLE seed(value TEXT); INSERT INTO seed VALUES('approved source');\n");
  const path=nested?'nested/source.sqlite':'source.sqlite';
  const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path,migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:15000},env:{}},{frameworkVersion:'0.9.4-test',nodeVersion:'22.16.0'});
  const runtime=await createDeploymentRuntimeCapsule({projectId:'lease_project_0',releaseId:'lease_release',generation:1,environment:{},database:{path,mode:'initialize'},ingress:{route:'/v1/clank/apps/lease_project_0',token:'clanki_lease-data-token-12345678901234567890'},artifact},{maxDatabaseBytes:16*1024*1024});
  const f=await fixture(t,1,{capsuleSha256:runtime.sha256}),store=await openDeploymentProviderDataStore({rootDirectory:f.root,maxDatabaseBytes:16*1024*1024});let prepared;
  const input={operation:{id:'data_operation',projectId:'lease_project_0',fence:1,attempt:1,maxAttempts:3},desired:{generation:1,releaseId:'lease_release',state:'running',runtimeProtocol:'clank-runtime/1'},runtime,signal:new AbortController().signal};
  await store.apply(input,value=>{prepared=value;});const project=join(f.root,'projects','lease_project_0');
  return {...f,store,input,prepared,project,state:join(project,'state.json'),fence:join(project,'fence.json'),journal:join(project,'journal.json')};
}
function writeMetadata(path,value){fs.writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});}

for(const nested of [false,true])test('native committed source data derives '+(nested?'nested':'direct')+' paths without a caller adapter',async t=>{
  const f=await dataFixture(t,nested),grant=await f.retain(),pins=f.pins(),before=[f.state,f.fence,f.prepared.databasePath].map(p=>fs.readFileSync(p)),data=await handoff.retainProviderSourceRuntimeData(grant);
  assert.equal(Object.isFrozen(data),true);assert.equal(data.databasePath,f.prepared.databasePath);assert.equal(data.releaseDirectory,f.prepared.releaseDirectory);assert.equal(data.dataDirectory,join(f.project,'data'));assert.equal(data.fence,1);
  assert.equal(f.pins().length,pins.length+(nested?9:8));data.assertCurrent();handoff.assertProviderSourceRuntimeDataLease(data);await data.verifyCurrent();
  const db=new DatabaseSync(data.databasePath,{readOnly:true});try{assert.deepEqual(db.prepare('SELECT value FROM seed').all().map(row=>row.value),['approved source']);}finally{db.close();}
  assert.deepEqual([f.state,f.fence,f.prepared.databasePath].map(p=>fs.readFileSync(p)),before);data.close();data.close();assert.deepEqual(f.pins(),pins);grant.assertCurrent();grant.close();
});

test('native source data refuses copied grant/data facades and public prepared values',async t=>{
  const f=await dataFixture(t),grant=await f.retain();let getters=0;
  for(const value of [{...grant},f.prepared,JSON.parse(JSON.stringify(grant)),new Proxy({}, {get(){getters++;throw Error('caller adapter');}})])await assert.rejects(handoff.retainProviderSourceRuntimeData(value),/genuine/);
  const data=await handoff.retainProviderSourceRuntimeData(grant);
  for(const value of [{...data},JSON.parse(JSON.stringify(data)),{}])assert.throws(()=>handoff.assertProviderSourceRuntimeDataLease(value),/genuine/);
  assert.equal(getters,0);data.close();grant.close();
});

for(const [name,change] of [
  ['unsettled apply',f=>writeMetadata(f.journal,{kind:'apply'})],
  ['unsettled rollback',f=>writeMetadata(f.journal,{kind:'rollback'})],
  ['foreign capsule',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.capsuleSha256='e'.repeat(64);writeMetadata(f.state,s);} ],
  ['foreign project',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.projectId='other_project';writeMetadata(f.state,s);} ],
  ['different release',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.releaseId='other_release';s.active.releaseDirectory='generations/g1-other_release';writeMetadata(f.state,s);} ],
  ['different generation',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.generation=2;s.active.releaseDirectory='generations/g2-lease_release';writeMetadata(f.state,s);} ],
  ['traversing database path',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.databasePath='data/../foreign.sqlite';writeMetadata(f.state,s);} ],
  ['foreign storage scope',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.active.databasePath='recovery/foreign.sqlite';writeMetadata(f.state,s);} ],
  ['foreign fence',f=>writeMetadata(f.fence,{protocol:'clank-provider-data-fence/1',projectId:'other_project',fence:1})],
  ['advanced fence',f=>writeMetadata(f.fence,{protocol:'clank-provider-data-fence/1',projectId:'lease_project_0',fence:2})],
  ['extra state field',f=>{const s=JSON.parse(fs.readFileSync(f.state));s.extra=true;writeMetadata(f.state,s);} ],
  ['duplicate state key',f=>{const encoded=fs.readFileSync(f.state,'utf8');assert.equal(encoded[0],'{');fs.writeFileSync(f.state,'{"protocol":"clank-provider-data/1",'+encoded.slice(1));}],
  ['noncanonical state whitespace',f=>fs.appendFileSync(f.state,' ')],
  ['invalid UTF8 state',f=>fs.writeFileSync(f.state,Buffer.from([0xff]))],
  ['oversized state',f=>fs.writeFileSync(f.state,' '.repeat(65537))],
  ['world readable state',f=>fs.chmodSync(f.state,0o644)],
  ['symlink database',f=>{fs.renameSync(f.prepared.databasePath,f.prepared.databasePath+'.old');fs.symlinkSync(f.prepared.databasePath+'.old',f.prepared.databasePath);} ],
  ['hardlink database',f=>fs.linkSync(f.prepared.databasePath,f.prepared.databasePath+'.alias')],
  ['symlink generation',f=>{fs.renameSync(f.prepared.releaseDirectory,f.prepared.releaseDirectory+'.old');fs.symlinkSync(f.prepared.releaseDirectory+'.old',f.prepared.releaseDirectory);} ],
])test('native source data refuses '+name+' before publishing a lease',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins();change(f);await assert.rejects(handoff.retainProviderSourceRuntimeData(grant));assert.deepEqual(f.pins(),pins);grant.close();
});

for(const target of ['state','fence','database','data','release'])test('native '+target+' replacement invalidates retained source data',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),data=await handoff.retainProviderSourceRuntimeData(grant),path=target==='state'?f.state:target==='fence'?f.fence:target==='database'?f.prepared.databasePath:target==='data'?data.dataDirectory:data.releaseDirectory;
  fs.renameSync(path,path+'.old');cloneNative(path+'.old',path);assert.throws(()=>data.assertCurrent(),/identity changed/);assert.deepEqual(f.pins(),pins);
  fs.rmSync(path,{recursive:true});fs.renameSync(path+'.old',path);assert.throws(()=>data.assertCurrent(),/closed/);grant.close();
});

for(const change of ['state','fence','journal','grant','parent close','owner close'])test('native '+change+' change closes retained source data without acknowledgment',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),data=await handoff.retainProviderSourceRuntimeData(grant);
  if(change==='state'){const s=JSON.parse(fs.readFileSync(f.state));s.active.committedAt++;writeMetadata(f.state,s);}
  if(change==='fence')writeMetadata(f.fence,{protocol:'clank-provider-data-fence/1',projectId:'lease_project_0',fence:2});
  if(change==='journal')writeMetadata(f.journal,{kind:'rollback'});
  if(change==='grant')mutate(f.catalog,db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='revoked'").run());
  if(change==='parent close')grant.close();if(change==='owner close')f.owner.close();
  assert.throws(()=>data.assertCurrent());assert.throws(()=>data.assertCurrent(),/closed/);
  assert.equal(f.pins().length,change==='owner close'?0:change==='grant'||change==='parent close'?pins.length-5:pins.length);
  if(change==='journal')assert.equal(fs.existsSync(f.journal),true);grant.close();
});

test('native source metadata parser is private, immutable and independently bounded',async t=>{
  const f=await dataFixture(t),descriptor=Object.getOwnPropertyDescriptor(openDeploymentProviderDataStore,SQLITE_INTERNAL),reader=descriptor.value;
  assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);assert.equal(descriptor.enumerable,false);assert.ok(Object.isFrozen(reader));
  const encoded=fs.readFileSync(f.state,'utf8');assert.equal(reader.decodeSourceState(encoded,'lease_project_0').active.fence,1);let getters=0;
  for(const value of [null,{},new Proxy({}, {get(){getters++;throw Error('getter');}}),' '.repeat(65537)])assert.throws(()=>reader.decodeSourceState(value,'lease_project_0'));
  assert.equal(getters,0);assert.throws(()=>reader.decodeSourceState(encoded,'other_project'),/another project/);
});

test('native source data has one retained identity per original grant lease',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),data=await handoff.retainProviderSourceRuntimeData(grant);data.close();await assert.rejects(handoff.retainProviderSourceRuntimeData(grant),/duplicated or recycled/);grant.close();
});

test('native FIFO reproduction confirms why mutable file opens need nonblocking flags',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clank-source-fifo-'));t.after(()=>rm(root,{recursive:true,force:true}));const fifo=join(root,'owned-fifo');
  const created=spawnSync('mkfifo',[fifo],{encoding:'utf8',timeout:5000});assert.equal(created.status,0,created.stderr);
  // Observe only the vulnerable syscall in a disposable, bounded child. Never
  // stall the provider/test event loop or claim this as a full old-code launch.
  const probe=spawnSync(process.execPath,['--input-type=module','--eval',"import fs from 'node:fs'; fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); process.stdout.write('unexpected open');",fifo],{encoding:'utf8',timeout:500});
  assert.equal(probe.error?.code,'ETIMEDOUT');assert.equal(probe.stdout,'');assert.equal(probe.status,null);assert.equal(probe.signal,'SIGTERM');assert.equal(fs.existsSync('/proc/'+probe.pid),false);
  const fd=fs.openSync(fifo,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{assert.equal(fs.fstatSync(fd).isFIFO(),true);}finally{fs.closeSync(fd);}
});

test('native FIFO replacement between file check and open refuses without blocking or leaked pins',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),open=fs.openSync;let replaced=false;
  fs.openSync=function(path,flags,...args){
    if(path===f.prepared.databasePath&&!replaced){
      assert.ok(flags&fs.constants.O_NONBLOCK,'mutable file opening must be bounded before the FIFO race');replaced=true;
      fs.renameSync(path,path+'.original');const created=spawnSync('mkfifo',[path],{encoding:'utf8',timeout:5000});assert.equal(created.status,0,created.stderr);
    }
    return open.call(this,path,flags,...args);
  };syncBuiltinESMExports();
  try{await assert.rejects(handoff.retainProviderSourceRuntimeData(grant),/private bounded native SQLite files/);}finally{fs.openSync=open;syncBuiltinESMExports();}
  assert.equal(replaced,true);assert.deepEqual(f.pins(),pins);grant.close();
});

for(const change of ['state','journal','parent close','owner close'])test('native '+change+' during held source-data verification prevents acknowledgment',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),data=await handoff.retainProviderSourceRuntimeData(grant),pause=await held(f,()=>data.verifyCurrent());
  if(change==='state'){const s=JSON.parse(fs.readFileSync(f.state));s.active.committedAt++;writeMetadata(f.state,s);}
  if(change==='journal')writeMetadata(f.journal,{kind:'apply'});
  if(change==='parent close')grant.close();if(change==='owner close')f.owner.close();
  pause.release();await assert.rejects(pause.pending);assert.throws(()=>data.assertCurrent(),/closed/);assert.equal(f.pins().length,change==='owner close'?0:change==='parent close'?pins.length-5:pins.length);grant.close();
});

test('native source data cleanup failure still releases parent grant and owner storage',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),data=await handoff.retainProviderSourceRuntimeData(grant),owned=f.pins().filter(p=>!pins.some(old=>old.fd===p.fd)),close=fs.closeSync;let fault=false;const attempted=[];
  fs.closeSync=function(fd){const result=close.call(this,fd);if(owned.some(p=>p.fd===fd)){attempted.push(fd);if(!fault){fault=true;throw Error('owned data close uncertainty');}}return result;};syncBuiltinESMExports();
  try{assert.throws(()=>f.owner.close(),/owned data close uncertainty/);}finally{fs.closeSync=close;syncBuiltinESMExports();}
  assert.equal(fault,true);assert.deepEqual(new Set(attempted),new Set(owned.map(p=>p.fd)));assert.equal(f.pins().length,0);assert.throws(()=>data.assertCurrent(),/closed/);assert.throws(()=>grant.assertCurrent(),/closed/);
});

test('native nested database parent cannot redirect into a sibling project',async t=>{
  const f=await dataFixture(t,true),grant=await f.retain(),pins=f.pins(),parent=dirname(f.prepared.databasePath),foreign=join(f.root,'projects','foreign_project','data');
  fs.mkdirSync(foreign,{recursive:true,mode:0o700});fs.renameSync(parent,parent+'.original');fs.symlinkSync(foreign,parent);
  await assert.rejects(handoff.retainProviderSourceRuntimeData(grant),/not canonical/);assert.deepEqual(f.pins(),pins);grant.close();
});

test('native metadata growth between fstat and read stays within the fixed allocation',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),read=fs.readSync;let grew=false;const allocations=[];
  fs.readSync=function(fd,buffer,...args){
    if(fs.readlinkSync('/proc/self/fd/'+fd)===f.state){allocations.push(buffer.byteLength);if(!grew){grew=true;fs.appendFileSync(f.state,' '.repeat(65537));}}
    return read.call(this,fd,buffer,...args);
  };syncBuiltinESMExports();
  try{await assert.rejects(handoff.retainProviderSourceRuntimeData(grant),/private bounded native SQLite files/);}finally{fs.readSync=read;syncBuiltinESMExports();}
  assert.equal(grew,true);assert.ok(allocations.length>0);assert.ok(allocations.every(n=>n===65537));assert.deepEqual(f.pins(),pins);grant.close();
});

for(const change of ['state','owner close'])test('native '+change+' during final source-data retention prevents publication',async t=>{
  const f=await dataFixture(t),grant=await f.retain(),pins=f.pins(),open=fs.openSync,hold=join(f.directory,'data-held'),release=join(f.directory,'data-release');let pending,armed=false;
  fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(path===f.prepared.databasePath&&!armed){armed=true;fs.writeFileSync(f.control,JSON.stringify({daemon:'scripted_lease_domain',hold,release}));}return fd;};syncBuiltinESMExports();
  try{
    pending=handoff.retainProviderSourceRuntimeData(grant);pending.catch(()=>{});const end=Date.now()+4000;
    while(!fs.existsSync(hold)){if(Date.now()>end)throw Error('Native final data checkpoint missing');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(f.pins().length,pins.length+8);
    if(change==='state'){const s=JSON.parse(fs.readFileSync(f.state));s.active.committedAt++;writeMetadata(f.state,s);}else f.owner.close();
    fs.writeFileSync(release,'release');await assert.rejects(pending);
  }finally{fs.openSync=open;syncBuiltinESMExports();fs.writeFileSync(release,'release');await pending?.catch(()=>{});}
  assert.equal(armed,true);assert.equal(f.pins().length,change==='owner close'?0:pins.length);grant.close();
});
