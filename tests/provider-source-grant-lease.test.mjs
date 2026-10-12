import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import * as handoff from '../dist/provider-handoff.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';

// Native ownership/catalog/pin tests with an explicitly scripted Docker info
// transport. These are not running-container, mount, worker or readiness proof.
const hash=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
async function fixture(t,projects=1){
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
    const key=randomBytes(32),binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:project.projectId,releaseId:'lease_release',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:1000,gid:1000,capture:{keyId:'lease_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
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
    pins:()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root+'/service/')?[{fd:Number(fd),path}]:[];}catch{return [];}}),
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
