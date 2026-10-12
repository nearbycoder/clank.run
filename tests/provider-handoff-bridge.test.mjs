import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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
test('source service admission returns only the original native owner and never ordinary admission',async t=>{
 const f=await enabled(t),before=snapshot(f),service=await handoff.admitProviderSourceService(f.bridge);
 assert.ok(Object.isFrozen(service));assert.equal(service.root,f.root);assert.equal(service.ownerLabel,'owner-source');assert.equal(service.nodeId,'node_source');
 assert.equal(handoff.providerSourceServiceOwner(service),f.owner);handoff.assertProviderSourceServiceOwnership(service);
 await service.verifyCurrent();assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'bridge-live');
 assert.equal('launch'in service,false);assert.equal('ready'in service,false);assert.equal('write'in service,false);
 await assert.rejects(handoff.admitProviderService(f.owner,providerDockerClient(f.options),'owner-source'),/pre-admission/);
 handoff.assertProviderSourceServiceOwnership(service);
 const binding=grant(f,f.bridge.enablementId);await handoff.issueProviderHandoffGrant(f.bridge,{binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)});
 await service.verifyCurrent();assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'issued');
 service.close();assert.throws(()=>handoff.providerSourceServiceOwner(service),/closed/);
});
test('source service copies and accessor claims refuse without reading caller fields',async t=>{
 const f=await enabled(t),service=await handoff.admitProviderSourceService(f.bridge);let reads=0;
 const fake={get root(){reads++;throw Error('must not read copied authority');},assertCurrent(){throw Error('must not delegate authority');}};
 for(const value of [{...service},new Proxy(service,{}),fake,{},null]){
  assert.throws(()=>handoff.assertProviderSourceServiceOwnership(value),/genuine/);
  assert.throws(()=>handoff.providerSourceServiceOwner(value),/genuine/);
 }
 assert.equal(reads,0);handoff.assertProviderSourceServiceOwnership(service);
 const before=fs.readFileSync(f.log);await assert.rejects(handoff.admitProviderSourceService({...f.bridge}),/genuine/);assert.deepEqual(fs.readFileSync(f.log),before);
});
test('source service admission reserves once before its first await and never reopens after close',async t=>{
 const f=await enabled(t),first=handoff.admitProviderSourceService(f.bridge);
 await assert.rejects(handoff.admitProviderSourceService(f.bridge),/already reserved/);
 const service=await first;await assert.rejects(handoff.admitProviderSourceService(f.bridge),/already reserved/);service.close();
 await assert.rejects(handoff.admitProviderSourceService(f.bridge),/native provider owner/);
});
test('source service ownership retains the actual exclusive native writer lease',async t=>{
 const f=await enabled(t),service=await handoff.admitProviderSourceService(f.bridge);
 await assert.rejects(handoff.acquireProviderServiceOwnership(f.root,true),/active writer/);
 handoff.assertProviderSourceServiceOwnership(service);f.owner.close();assert.throws(()=>service.assertCurrent(),/native provider owner/);
});
test('source service admission refuses already-issued state and retained cleanup-only restart',async t=>{
 const f=await issued(t),before=snapshot(f);
 await assert.rejects(handoff.admitProviderSourceService(f.bridge),/Retained source state/);assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
 f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);
 assert.equal(bridge.mode,'cleanup-only');const log=fs.readFileSync(f.log);await assert.rejects(handoff.admitProviderSourceService(bridge),/live provider bridge/);assert.deepEqual(fs.readFileSync(f.log),log);
});
test('source service admission revalidates the initial native catalog after its last startup await',async t=>{
 const f=await enabled(t),freeze=Object.freeze,binding=grant(f,f.bridge.enablementId);let injected=false;
 Object.freeze=function(value){const result=freeze(value);if(value?.root===f.root&&typeof value.verifyCurrent==='function'){
  Object.freeze=freeze;queueMicrotask(()=>{native(f.catalog,db=>{db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO clank_provider_handoff_source_grant VALUES(1,2,?,?,?,?,?,'issued',NULL,NULL,NULL)").run(binding.grantId,JSON.stringify(binding),hash(binding),'d'.repeat(64),'e'.repeat(64));db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=2,records_sha256=?').run(hash(mirroredGrant(db)));db.exec('COMMIT');});injected=true;});
 }return result;};
 try{await assert.rejects(handoff.admitProviderSourceService(f.bridge),/startup observation changed/);}finally{Object.freeze=freeze;}
 assert.equal(injected,true);assert.equal(f.bridge.mode,'cleanup-only');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].grant_id,binding.grantId);
 await assert.rejects(handoff.admitProviderSourceService(f.bridge),/native provider owner/);
});
test('source service refuses owner close across its original native daemon await',async t=>{
 const f=await enabled(t),pending=handoff.admitProviderSourceService(f.bridge);f.owner.close();
 await assert.rejects(pending,/native provider owner/);
});
for(const when of ['startup','verification'])test('source service '+when+' rejects original Docker daemon drift before cleanup commands',async t=>{
 const f=await enabled(t),service=when==='verification'?await handoff.admitProviderSourceService(f.bridge):null,before=snapshot(f);
 fs.writeFileSync(f.options.executable,"#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(process.env.LOG,JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(JSON.stringify('foreign_daemon')+'\\n');",{mode:0o700});
 if(service){await assert.rejects(service.verifyCurrent(),/domain changed/);assert.throws(()=>service.assertCurrent(),/closed/);}
 else await assert.rejects(handoff.admitProviderSourceService(f.bridge),/domain changed/);
 assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
 assert.ok(fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).every(args=>args[0]==='info'));
});
test('source service retains its original namespace descriptors until actual owner close',async t=>{
 const f=await enabled(t),pins=()=>fs.readdirSync('/proc/self/fd').filter(fd=>{try{const target=fs.readlinkSync('/proc/self/fd/'+fd);return target===f.root||target.startsWith(f.root+'/');}catch{return false;}});
 const before=pins().length,service=await handoff.admitProviderSourceService(f.bridge);assert.equal(pins().length,before+5);
 await service.verifyCurrent();assert.equal(pins().length,before+5);service.close();assert.equal(pins().length,0);
});
for(const kind of ['inode','schema','mirror','unsupported'])test('source service native '+kind+' drift permanently invalidates its admission',async t=>{
 const f=await enabled(t),service=await handoff.admitProviderSourceService(f.bridge);
 const originalMirror=rows(f.catalog,'clank_provider_handoff_bridge_state')[0].records_sha256;
 if(kind==='inode'){const file=join(f.dir,'original-catalog.sqlite');fs.renameSync(f.catalog,file);fs.copyFileSync(file,f.catalog);fs.chmodSync(f.catalog,0o600);}
 if(kind==='schema')native(f.catalog,db=>db.exec('CREATE TABLE unreviewed(x)'));
 if(kind==='mirror')native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?').run('a'.repeat(64)));
 if(kind==='unsupported')native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=2').run());
 assert.throws(()=>service.assertCurrent());assert.throws(()=>handoff.providerSourceServiceOwner(service),/closed/);
 if(kind==='inode'){fs.unlinkSync(f.catalog);fs.renameSync(join(f.dir,'original-catalog.sqlite'),f.catalog);}
 if(kind==='schema')native(f.catalog,db=>db.exec('DROP TABLE unreviewed'));
 if(kind==='mirror')native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?').run(originalMirror));
 if(kind==='unsupported')native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=1').run());
 assert.throws(()=>service.assertCurrent(),/closed/);await assert.rejects(service.verifyCurrent(),/closed/);
});
function grant(f,enablementId){return {protocol:'clank-provider-source-grant/1',enablementId,indexId:f.identity.indexId,catalogId:f.project.catalogId,domainSha256:f.identity.domainSha256,projectId,releaseId:'release_source',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:1000,gid:1000,capture:{keyId:'source_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};}
const containerId='f'.repeat(64),zeroTime='0001-01-01T00:00:00Z';
function containerProjection(f,state='created'){
 const b=f.binding,labels={
  'run.clank.managed':'provider-runtime','run.clank.owner':'owner-source','run.clank.project':b.projectId,'run.clank.release':b.releaseId,'run.clank.generation':String(b.generation),'run.clank.role':'web','run.clank.instance':'0',
  'run.clank.handoff.protocol':b.protocol,'run.clank.handoff.node':'node_source','run.clank.handoff.daemon':'daemon_native_fixture','run.clank.handoff.domain':b.domainSha256,'run.clank.handoff.enablement':b.enablementId,'run.clank.handoff.index':b.indexId,'run.clank.handoff.catalog':b.catalogId,'run.clank.handoff.grant':b.grantId,'run.clank.handoff.binding':hash(b),'run.clank.handoff.capsule':b.capsuleSha256,'run.clank.handoff.incarnation':b.sourceIncarnation,
 };
 return [containerId,b.imageId,b.imageId,'1000:1000',labels,'no',0,state,state==='running',false,false,false,state==='running'?123:0,state==='running'?'2026-10-11T12:00:00.123456789Z':zeroTime,zeroTime,0,'2026-10-11T11:59:59Z'];
}
async function containerFixture(t,overrides={},additionalProject=false){
 let f;if(additionalProject){f=await fixture(t);f.other=await handoff.installProviderHandoffProject(f.owner,f.nativeDomain,'project_other');f.bridge=await handoff.enableProviderHandoffBridge(f.owner,f.nativeDomain,{...limits,...overrides});f.binding=grant(f,f.bridge.enablementId);f.input={binding:f.binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)};await handoff.issueProviderHandoffGrant(f.bridge,f.input);}else f=await issued(t,overrides);fs.copyFileSync(new URL('./fixtures/provider-handoff-container.mjs',import.meta.url),f.options.executable);fs.chmodSync(f.options.executable,0o700);
 f.control=f.log+'.container.json';f.config={projection:containerProjection(f)};f.configure=()=>fs.writeFileSync(f.control,JSON.stringify(f.config));f.configure();
 f.containerInput={projectId,grantId:f.binding.grantId,bindingSha256:hash(f.binding),containerId,expectedVersion:2};return f;
}
test('C1 records actual scripted observations with native catalog CAS and exact retries',async t=>{
 const f=await containerFixture(t);assert.equal(typeof handoff.recordProviderHandoffContainerCreated,'function');assert.equal(typeof handoff.recordProviderHandoffContainerStarted,'function');
 const created=await handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput);
 assert.deepEqual(created,{grantId:f.binding.grantId,bindingSha256:hash(f.binding),containerId,state:'created',version:3});assert.equal(Object.isFrozen(created),true);
 const first=snapshot(f);assert.deepEqual(await handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput),created);assert.deepEqual(snapshot(f),first);
 f.config.projection=containerProjection(f,'running');f.configure();const input={...f.containerInput,expectedVersion:3};
 const started=await handoff.recordProviderHandoffContainerStarted(f.bridge,input);assert.equal(started.state,'started');assert.equal(started.version,4);
 const second=snapshot(f);assert.deepEqual(await handoff.recordProviderHandoffContainerStarted(f.bridge,input),started);assert.deepEqual(snapshot(f),second);
 const state=rows(f.catalog,'clank_provider_handoff_bridge_state')[0],records=native(f.catalog,mirroredGrant);assert.equal(state.records_sha256,hash(records));assert.equal(records.grant.container_id,containerId);assert.equal(records.grant.readiness_json,null);
 const commands=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(v=>!Array.isArray(v));assert.equal(commands.filter(v=>v.kind==='inspect').length,8);assert.ok(commands.every(v=>['info','inspect'].includes(v.kind)));assert.ok(commands.filter(v=>v.kind==='inspect').every(v=>v.args[4]===containerId));
 f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(bridge.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(bridge)).projects[0].grant.state,'started');await assert.rejects(handoff.recordProviderHandoffContainerStarted(bridge,input));
});
test('C1 captures closed own-data inputs and rejects structural authority before native effects',async t=>{
 const f=await containerFixture(t),before=snapshot(f),log=fs.readFileSync(f.log,'utf8');let getter=0;
 const accessor={...f.containerInput};Object.defineProperty(accessor,'projectId',{get(){getter++;return projectId;}});
 for(const input of [null,[],{...f.containerInput,extra:true},{...f.containerInput,[Symbol()]:true},accessor,{...f.containerInput,expectedVersion:Number.MAX_SAFE_INTEGER},{...f.containerInput,expectedVersion:1},{...f.containerInput,containerId:'f'},{...f.containerInput,grantId:'bad'}])await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,input));
 await assert.rejects(handoff.recordProviderHandoffContainerCreated({...f.bridge},f.containerInput),/genuine/);assert.equal(getter,0);assert.deepEqual(snapshot(f),before);assert.equal(fs.readFileSync(f.log,'utf8'),log);
 const input={...f.containerInput},pending=handoff.recordProviderHandoffContainerCreated(f.bridge,input);input.containerId='a'.repeat(64);input.expectedVersion=99;assert.equal((await pending).containerId,containerId);
});
test('C1 exact MAX postimage retry does not execute either update',async t=>{
 const f=await containerFixture(t),max=Number.MAX_SAFE_INTEGER;native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=?').run(max-1));
 const input={...f.containerInput,expectedVersion:max-1},first=await handoff.recordProviderHandoffContainerCreated(f.bridge,input);assert.equal(first.version,max);const before=snapshot(f),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE clank_provider_handoff_'))throw Error('retry must not update');return prepare.call(this,sql);};
 try{assert.deepEqual(await handoff.recordProviderHandoffContainerCreated(f.bridge,input),first);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.deepEqual(snapshot(f),before);await assert.rejects(handoff.recordProviderHandoffContainerStarted(f.bridge,{...input,expectedVersion:max}));assert.deepEqual(snapshot(f),before);
});
test('C1 conflicts never change grant identity or permit skipped and backward phases',async t=>{
 for(const mode of ['skip','version','binding','grant','id','backward']){
  const f=await containerFixture(t);let method=handoff.recordProviderHandoffContainerCreated,input={...f.containerInput};
  if(mode==='skip'){method=handoff.recordProviderHandoffContainerStarted;input.expectedVersion=3;}
  if(mode==='version')input.expectedVersion=3;
  if(mode==='binding')input.bindingSha256='a'.repeat(64);
  if(mode==='grant')input.grantId=randomUUID();
  if(['id','backward'].includes(mode)){await method(f.bridge,input);f.config.projection=containerProjection(f,'running');f.configure();await handoff.recordProviderHandoffContainerStarted(f.bridge,{...input,expectedVersion:3});if(mode==='id'){method=handoff.recordProviderHandoffContainerStarted;input={...input,containerId:'a'.repeat(64),expectedVersion:3};}}
  const before=snapshot(f);await assert.rejects(method(f.bridge,input));assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 refuses each malformed identity and phase projection before native catalog writes',async t=>{
 const variants=[
  p=>{p[0]='a'.repeat(64);},p=>{p[1]='sha256:'+'a'.repeat(64);},p=>{p[2]='node:latest';},p=>{p[3]='0:0';},p=>{p[3]='01000:1000';},
  p=>{delete p[4]['run.clank.handoff.grant'];},p=>{p[4]['run.clank.handoff.node']='other';},p=>{p[4]['run.clank.unreviewed']='x';},p=>{p[4]=[];},p=>{p[4].extra='x'.repeat(4097);},p=>{p[4]['x'.repeat(257)]='x';},p=>{p[4].extra='nul\0';},
  p=>{p[5]='always';},p=>{p[6]=1;},p=>{p[7]='running';},p=>{p[8]=true;},p=>{p[9]=true;},p=>{p[10]=true;},p=>{p[11]=true;},p=>{p[12]=1;},p=>{p[13]='2026-10-11T12:00:00Z';},p=>{p[14]='2026-10-11T12:00:00Z';},p=>{p[15]=1;},p=>{p[16]='2026-02-30T12:00:00Z';},p=>{p[16]=zeroTime;},p=>{p[16]='2026-10-11T12:00:00+00:00';},p=>{p.push('extra');},
 ];
 for(const [index,alter] of variants.entries()){
  const f=await containerFixture(t);alter(f.config.projection);f.configure();const before=snapshot(f);
  await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput),undefined,'variant '+index);assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 native output encoding, canonical ordering and transport uncertainty refuse without absence',async t=>{
 for(const mode of ['duplicate','html-escape','numeric-keys','replacement','invalid-utf8','truncated','crlf','extra-line','overflow','exit','domain']){
  const f=await containerFixture(t),p=f.config.projection;let stdout=JSON.stringify(p);
  if(mode==='duplicate')stdout=stdout.replace('"run.clank.managed":"provider-runtime"','"run.clank.managed":"wrong","run.clank.managed":"provider-runtime"');
  if(mode==='html-escape'){p[4].extra='<';stdout=JSON.stringify(p).replace('<','\\u003c');}
  if(mode==='numeric-keys')stdout=stdout.replace('{"run.clank.managed"','{"10":"ten","2":"two","run.clank.managed"');
  if(mode==='replacement'){p[4].extra='\uFFFD';stdout=JSON.stringify(p);}
  if(mode==='truncated')stdout='[';
  if(mode==='crlf')stdout+='\r\n';
  if(mode==='extra-line')stdout+='\n\n';
  if(mode==='overflow')stdout='x'.repeat(33000);
  f.config.inspectReplies=[{stdout,code:mode==='exit'?1:0}];
  if(mode==='invalid-utf8'){const prefix=Buffer.from(stdout.replace('provider-runtime','INVALID'));f.config.inspectReplies=[{base64:Buffer.concat([prefix.subarray(0,prefix.indexOf('INVALID')),Buffer.from([0xc3,0x28]),prefix.subarray(prefix.indexOf('INVALID')+7)]).toString('base64')}];}
  if(mode==='domain')f.config.infoReplies=[{}, {stdout:'"daemon_substitute"\n'}];
  f.configure();const before=snapshot(f);await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 native ignored and altered row and mirror effects roll back the transition',async t=>{
 for(const mode of ['ignored','altered','false-count','mirror-ignored','mirror-altered','commit-ignored']){
  const f=await containerFixture(t),before=snapshot(f),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let injected=false;
  DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
   if(sql.startsWith('UPDATE clank_provider_handoff_source_grant SET state=')){
    if(mode==='ignored')exec.call(this,"CREATE TEMP TRIGGER c1_ignore BEFORE UPDATE ON clank_provider_handoff_source_grant BEGIN SELECT RAISE(IGNORE); END");
    if(mode==='altered')exec.call(this,"CREATE TEMP TRIGGER c1_alter AFTER UPDATE ON clank_provider_handoff_source_grant BEGIN UPDATE clank_provider_handoff_source_grant SET container_id='"+'a'.repeat(64)+"' WHERE id=1; END");
    if(mode==='false-count')statement.run=()=>({changes:1});if(['ignored','altered','false-count'].includes(mode))injected=true;
   }
   if(sql.startsWith('UPDATE clank_provider_handoff_bridge_state SET version=version+1')){
    if(mode==='mirror-ignored'){statement.run=()=>({changes:1});injected=true;}
    if(mode==='mirror-altered'){exec.call(this,"CREATE TEMP TRIGGER c1_mirror AFTER UPDATE ON clank_provider_handoff_bridge_state BEGIN UPDATE clank_provider_handoff_bridge_state SET version=version+1 WHERE id=1; END");injected=true;}
   }
   return statement;
  };
  DatabaseSync.prototype.exec=function(sql){if(mode==='commit-ignored'&&sql==='COMMIT'&&prepare.call(this,'PRAGMA database_list').get().file.endsWith('/catalog.sqlite')){injected=true;return;}return exec.call(this,sql);};
  try{await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
  assert.equal(injected,true,mode);assert.deepEqual(snapshot(f),before,mode);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 file and directory fsync failures preserve uncertain committed observations',async t=>{
 for(const target of ['file','directory']){
  const f=await containerFixture(t),sync=fs.fsyncSync;let injected=false;const expected=target==='file'?f.catalog:f.catalog.slice(0,f.catalog.lastIndexOf('/'));
  fs.fsyncSync=function(fd){if(!injected&&fs.realpathSync('/proc/self/fd/'+fd)===expected){injected=true;throw Error('C1 '+target+' sync failure');}return sync.call(this,fd);};syncBuiltinESMExports();
  try{await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput),/sync failure/);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
  assert.equal(injected,true);assert.equal(f.bridge.mode,'cleanup-only');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'created');assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].records_sha256,hash(native(f.catalog,mirroredGrant)));
  await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(bridge.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(bridge)).projects[0].grant.state,'created');
 }
});
test('C1 native COMMIT response uncertainty retains the exact committed history',async t=>{
 const f=await containerFixture(t),exec=DatabaseSync.prototype.exec;let injected=false;
 DatabaseSync.prototype.exec=function(sql){const selected=sql==='COMMIT'&&this.prepare('PRAGMA database_list').get().file===f.catalog;const result=exec.call(this,sql);if(selected){injected=true;throw Error('C1 lost native commit response');}return result;};
 try{await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput),/lost native commit response/);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(injected,true);assert.equal(f.bridge.mode,'cleanup-only');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'created');assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].version,3);assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].records_sha256,hash(native(f.catalog,mirroredGrant)));
});
test('C1 bounded observation timeout settles the owned child and never infers absence',async t=>{
 const f=await containerFixture(t,{controlTimeoutMs:1000}),hold=join(f.dir,'timeout-held'),release=join(f.dir,'never-released');f.config.inspectReplies=[{hold,release}];f.configure();const before=snapshot(f);
 const pending=assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput),{message:'Docker command deadline exceeded.'}),child=await waitContainerFile(hold),birth=processBirth(child.pid);assert.ok(birth);await pending;
 assert.notEqual(processBirth(child.pid),birth);assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
});
test('C1 changed post-commit observation or final native domain never acknowledges success',async t=>{
 for(const mode of ['observation','domain']){
  const f=await containerFixture(t),changed=containerProjection(f);changed[16]='2026-10-11T11:59:58Z';
  if(mode==='observation')f.config.inspectReplies=[{}, {stdout:JSON.stringify(changed)}];else f.config.infoReplies=[{}, {}, {stdout:'"daemon_substitute"\n'}];f.configure();
  await assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));assert.equal(f.bridge.mode,'cleanup-only');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'created');assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].version,3);
 }
});
async function waitContainerFile(path){const end=Date.now()+10000;while(!fs.existsSync(path)){if(Date.now()>end)throw Error('Timed out waiting for owned container fixture.');await new Promise(resolve=>setTimeout(resolve,10));}return JSON.parse(fs.readFileSync(path,'utf8'));}
function processBirth(pid){try{const value=fs.readFileSync('/proc/'+pid+'/stat','utf8');return value.slice(value.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
test('C1 owner close at either inspect await settles owned subprocess and queued work',async t=>{
 for(const index of [0,1]){
  const f=await containerFixture(t),hold=join(f.dir,'held'),release=join(f.dir,'release');f.config.inspectReplies=Array.from({length:index+1},()=>({}));f.config.inspectReplies[index]={hold,release};f.configure();
  const pending=handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput);const rejected=assert.rejects(pending);const child=await waitContainerFile(hold),birth=processBirth(child.pid);assert.ok(birth);
  const queued=assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));f.owner.close();fs.writeFileSync(release,'go');await rejected;await queued;assert.notEqual(processBirth(child.pid),birth);
  assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,index===0?'issued':'created');assert.equal(f.bridge.mode,'closed');
 }
});
for(const mode of ['grant','mirror','reservation','path'])test('C1 complete preimage checks catch '+mode+' mutation during an awaited observation',async t=>{
  const f=await containerFixture(t),hold=join(f.dir,'held'),release=join(f.dir,'release');f.config.inspectReplies=[{hold,release}];f.configure();
  const pending=assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));await waitContainerFile(hold);
  if(mode==='grant')native(f.catalog,db=>{db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'");db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?').run(hash(mirroredGrant(db)));});
  if(mode==='mirror')native(f.catalog,db=>db.exec('UPDATE clank_provider_handoff_bridge_state SET version=version+1'));
  if(mode==='reservation')native(f.index,db=>db.exec('UPDATE clank_provider_handoff_bridge_index SET version=version+1'));
  if(mode==='path'){fs.renameSync(f.catalog,join(f.dir,'retained-catalog'));fs.copyFileSync(join(f.dir,'retained-catalog'),f.catalog);fs.chmodSync(f.catalog,0o600);}
  fs.writeFileSync(release,'go');await pending;assert.equal(f.bridge.mode,'cleanup-only');assert.notEqual(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'created');
});
test('C1 readonly retries retain catalog and index identity through the final await, including MAX',async t=>{
 for(const saturated of [false,true])for(const awaitPoint of ['first-inspect','final-domain'])for(const mutation of ['path','index']){
  const f=await containerFixture(t),version=saturated?Number.MAX_SAFE_INTEGER-1:2,input={...f.containerInput,expectedVersion:version};
  if(saturated)native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=?').run(version));
  await handoff.recordProviderHandoffContainerCreated(f.bridge,input);for(const kind of ['inspect','info'])fs.writeFileSync(f.log+'.'+kind,'0');
  const hold=join(f.dir,'retry-held'),release=join(f.dir,'retry-release');if(awaitPoint==='first-inspect')f.config.inspectReplies=[{hold,release}];else f.config.infoReplies=[{},{},{hold,release}];f.configure();
  const pending=assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,input));await waitContainerFile(hold);
  if(mutation==='path'){fs.renameSync(f.catalog,join(f.dir,'original-catalog'));fs.copyFileSync(join(f.dir,'original-catalog'),f.catalog);fs.chmodSync(f.catalog,0o600);}else native(f.index,db=>db.exec('UPDATE clank_provider_handoff_bridge_index SET version=version+1'));
  const retained=snapshot(f);fs.writeFileSync(release,'go');await pending;assert.deepEqual(snapshot(f),retained);assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].version,version+1);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 complete consulted catalog checks include other projects and their original inodes',async t=>{
 for(const mutation of ['version','path']){
  const f=await containerFixture(t,{},true),other=join(f.root,'service','handoff','catalogs',f.other.catalogId,'catalog.sqlite'),hold=join(f.dir,'other-held'),release=join(f.dir,'other-release');f.config.inspectReplies=[{hold,release}];f.configure();
  const pending=assert.rejects(handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput));await waitContainerFile(hold);
  if(mutation==='version')native(other,db=>db.exec('UPDATE clank_provider_handoff_bridge_state SET version=version+1'));else{fs.renameSync(other,join(f.dir,'original-other'));fs.copyFileSync(join(f.dir,'original-other'),other);fs.chmodSync(other,0o600);}
  const retained=snapshot(f);fs.writeFileSync(release,'go');await pending;assert.deepEqual(snapshot(f),retained);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'issued');assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 malformed running observations never authorize the started transition',async t=>{
 for(const alter of [p=>{p[7]='created';},p=>{p[8]=false;},p=>{p[12]=0;},p=>{p[12]=1.5;},p=>{p[13]=zeroTime;},p=>{p[13]='2026-02-30T12:00:00Z';},p=>{p[14]='2026-10-11T12:00:00Z';}]){
  const f=await containerFixture(t);await handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput);f.config.projection=containerProjection(f,'running');alter(f.config.projection);f.configure();const retained=snapshot(f);
  await assert.rejects(handoff.recordProviderHandoffContainerStarted(f.bridge,{...f.containerInput,expectedVersion:3}));assert.deepEqual(snapshot(f),retained);assert.equal(f.bridge.mode,'cleanup-only');
 }
});
test('C1 complete created/started validators reject unsupported retained shapes',async t=>{
 for(const mode of ['created-null','created-short-version','started-short-version','bad-id','readiness','ready','revoked-id','control']){
  const f=await containerFixture(t);native(f.catalog,db=>{
   db.prepare("UPDATE clank_provider_handoff_source_grant SET state='created',container_id=?").run(containerId);db.exec('UPDATE clank_provider_handoff_bridge_state SET version=3');
   if(mode==='created-null')db.exec('UPDATE clank_provider_handoff_source_grant SET container_id=NULL');
   if(mode==='created-short-version')db.exec('UPDATE clank_provider_handoff_bridge_state SET version=2');
   if(mode==='started-short-version')db.exec("UPDATE clank_provider_handoff_source_grant SET state='started'");
   if(mode==='bad-id')db.prepare('UPDATE clank_provider_handoff_source_grant SET container_id=?').run('z'.repeat(64));
   if(mode==='readiness')db.prepare('UPDATE clank_provider_handoff_source_grant SET readiness_json=?,readiness_sha256=?').run('{}','a'.repeat(64));
   if(mode==='ready')db.exec("UPDATE clank_provider_handoff_source_grant SET state='ready'");
   if(mode==='revoked-id')db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'");
   if(mode==='control')db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(1,'step','enroll','{}',?,'accepted',NULL,NULL)").run('a'.repeat(64));
   const records=mirroredGrant(db);if(mode==='control')records.operations=db.prepare('SELECT * FROM clank_provider_handoff_source_operations').all().map(v=>({...v}));db.prepare('UPDATE clank_provider_handoff_bridge_state SET records_sha256=?').run(hash(records));
  });const before=snapshot(f);await assert.rejects(handoff.inspectProviderHandoffBridge(f.bridge));assert.deepEqual(snapshot(f),before);
 }
});
test('C1 actual coordinator SIGKILL retains native precommit or committed history without resumption',async t=>{
 for(const phase of ['before-commit','after-commit']){
  const dir=await mkdtemp(join(tmpdir(),'clank-container-catalog-kill-')),root=join(dir,'provider'),log=join(dir,'commands'),checkpoint=join(dir,'checkpoint'),inputFile=join(dir,'input.json');
  await writeFile(inputFile,JSON.stringify({root,log,checkpoint,phase,limits}));
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./fixtures/provider-handoff-container.mjs',import.meta.url)),'coordinator',inputFile],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;await rm(dir,{recursive:true,force:true});});
  const observed=await waitContainerFile(checkpoint);assert.equal(observed.pid,child.pid);assert.equal(observed.phase,phase);child.kill('SIGKILL');assert.deepEqual(await closed,{code:null,signal:'SIGKILL'});assert.equal(stdout,'');assert.equal(stderr,'');
  const catalogDir=observed.catalog.slice(0,observed.catalog.lastIndexOf('/')),retained=()=>Object.fromEntries(fs.readdirSync(catalogDir).sort().map(name=>[name,createHash('sha256').update(fs.readFileSync(join(catalogDir,name))).digest('hex')])),before=retained();
  // Independent recovery of a disposable copy handles an interrupted native
  // journal without granting permission to repair the retained source catalog.
  const copyDir=join(dir,'inspect-copy');fs.mkdirSync(copyDir,{mode:0o700});for(const name of fs.readdirSync(catalogDir))fs.copyFileSync(join(catalogDir,name),join(copyDir,name));
  const state=native(join(copyDir,'catalog.sqlite'),db=>({grant:{...db.prepare('SELECT * FROM clank_provider_handoff_source_grant').get()},version:db.prepare('SELECT version FROM clank_provider_handoff_bridge_state').get().version,mirror:db.prepare('SELECT records_sha256 FROM clank_provider_handoff_bridge_state').get().records_sha256,records:mirroredGrant(db)}));
  assert.equal(state.grant.state,phase==='before-commit'?'issued':'created');assert.equal(state.version,phase==='before-commit'?2:3);assert.equal(state.mirror,hash(state.records));assert.deepEqual(retained(),before);
  const owner=await handoff.acquireProviderServiceOwnership(root),client=providerDockerClient({executable:fileURLToPath(new URL('./fixtures/provider-handoff-container.mjs',import.meta.url)),dockerEnvironment:{LOG:log}});
  try{const domain=await handoff.createProviderHandoffDomain(owner,client,'node_source','owner-source'),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(bridge.mode,'cleanup-only');await assert.rejects(handoff.recordProviderHandoffContainerCreated(bridge,{projectId,grantId:observed.binding.grantId,bindingSha256:hash(observed.binding),containerId,expectedVersion:2}));}finally{owner.close();}
  assert.deepEqual(retained(),before);t.diagnostic(JSON.stringify({phase,exitSignal:'SIGKILL',retainedState:state.grant.state,retainedVersion:state.version}));
 }
});
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

function revocationIntent(f,state='issued'){return {projectId,grantId:f.binding.grantId,bindingSha256:hash(f.binding),containerId:state==='issued'?null:containerId,expectedVersion:state==='issued'?2:state==='created'?3:4};}
async function revocationFixture(t,state='issued'){
 const f=await containerFixture(t);if(state!=='issued')await handoff.recordProviderHandoffContainerCreated(f.bridge,f.containerInput);
 if(state==='started'){f.config.projection=containerProjection(f,'running');f.configure();await handoff.recordProviderHandoffContainerStarted(f.bridge,{...f.containerInput,expectedVersion:3});}return f;
}
for(const state of ['issued','created','started'])test('R1 durable '+state+' revocation retains identity and supports exact cleanup-only retry/reopen',async t=>{
 const f=await revocationFixture(t,state),input=revocationIntent(f,state),before=rows(f.catalog,'clank_provider_handoff_source_grant')[0];
 const result=await handoff.revokeProviderHandoffGrant(f.bridge,input);assert.deepEqual(result,{grantId:input.grantId,bindingSha256:input.bindingSha256,containerId:input.containerId,state:'revoked',version:input.expectedVersion+1});assert.equal(Object.isFrozen(result),true);assert.equal(f.bridge.mode,'cleanup-only');
 const row=rows(f.catalog,'clank_provider_handoff_source_grant')[0];assert.deepEqual(row,{...before,state:'revoked'});assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].records_sha256,hash(native(f.catalog,mirroredGrant)));const retained=snapshot(f);
 await assert.rejects(handoff.issueProviderHandoffGrant(f.bridge,f.input),/live/);assert.deepEqual(await handoff.revokeProviderHandoffGrant(f.bridge,input),result);assert.deepEqual(snapshot(f),retained);
 f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal(bridge.mode,'cleanup-only');assert.equal((await handoff.inspectProviderHandoffBridge(bridge)).projects[0].grant.container_id,input.containerId);assert.deepEqual(await handoff.revokeProviderHandoffGrant(bridge,input),result);assert.deepEqual(snapshot(f),retained);
});
test('R1 own-data revocation intent refuses accessors and forged authority without effects',async t=>{
 const f=await revocationFixture(t),input=revocationIntent(f),before=snapshot(f),log=fs.readFileSync(f.log,'utf8');let called=0;const accessor={...input};Object.defineProperty(accessor,'containerId',{get(){called++;return null;}});
 for(const value of [null,[],accessor,{...input,extra:true},{...input,[Symbol()]:1},{...input,expectedVersion:1},{...input,expectedVersion:Number.MAX_SAFE_INTEGER},{...input,containerId:'bad'}])await assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,value));
 await assert.rejects(handoff.revokeProviderHandoffGrant({...f.bridge},input),/genuine/);assert.equal(called,0);assert.deepEqual(snapshot(f),before);assert.equal(fs.readFileSync(f.log,'utf8'),log);
 const pending=handoff.revokeProviderHandoffGrant(f.bridge,input);input.containerId=containerId;input.expectedVersion=99;assert.equal((await pending).containerId,null);
});
for(const fault of ['grant','binding','container','version','retry-version'])test('R1 '+fault+' conflicts preserve durable grant and mirror',async t=>{
 const f=await revocationFixture(t,'created'),input=revocationIntent(f,'created');if(fault==='retry-version')await handoff.revokeProviderHandoffGrant(f.bridge,input);
 const before=snapshot(f);if(fault==='grant')input.grantId=randomUUID();if(fault==='binding')input.bindingSha256='a'.repeat(64);if(fault==='container')input.containerId='a'.repeat(64);if(fault==='version'||fault==='retry-version')input.expectedVersion++;
 await assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,input));assert.deepEqual(snapshot(f),before);
});
for(const mode of ['ignored','altered','false-count','mirror-ignored','mirror-altered','commit-ignored'])test('R1 '+mode+' native writes refuse false revocation acknowledgment',async t=>{
 const f=await revocationFixture(t,'created'),before=snapshot(f),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
  if(sql.startsWith('UPDATE clank_provider_handoff_source_grant SET state=')){
   if(mode==='ignored')exec.call(this,"CREATE TEMP TRIGGER r1_ignore BEFORE UPDATE ON clank_provider_handoff_source_grant BEGIN SELECT RAISE(IGNORE); END");
   if(mode==='altered')exec.call(this,"CREATE TEMP TRIGGER r1_alter AFTER UPDATE ON clank_provider_handoff_source_grant BEGIN UPDATE clank_provider_handoff_source_grant SET container_id='"+'a'.repeat(64)+"' WHERE id=1; END");
   if(mode==='false-count')statement.run=()=>({changes:1});if(['ignored','altered','false-count'].includes(mode))injected=true;
  }
  if(sql.startsWith('UPDATE clank_provider_handoff_bridge_state SET version=version+1')){if(mode==='mirror-ignored'){statement.run=()=>({changes:1});injected=true;}if(mode==='mirror-altered'){exec.call(this,"CREATE TEMP TRIGGER r1_mirror AFTER UPDATE ON clank_provider_handoff_bridge_state BEGIN UPDATE clank_provider_handoff_bridge_state SET version=version+1 WHERE id=1; END");injected=true;}}
  return statement;
 };
 DatabaseSync.prototype.exec=function(sql){if(mode==='commit-ignored'&&sql==='COMMIT'&&prepare.call(this,'PRAGMA database_list').get().file===f.catalog){injected=true;return;}return exec.call(this,sql);};
 try{await assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,revocationIntent(f,'created')));}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
 assert.equal(injected,true);assert.deepEqual(snapshot(f),before);assert.equal(f.bridge.mode,'cleanup-only');
});
for(const target of ['file','directory'])test('R1 '+target+' sync uncertainty retains revoked identity and exact restart retry',async t=>{
 const f=await revocationFixture(t,'started'),input=revocationIntent(f,'started'),sync=fs.fsyncSync;let injected=false;const expected=target==='file'?f.catalog:f.catalog.slice(0,f.catalog.lastIndexOf('/'));
 fs.fsyncSync=function(fd){if(!injected&&fs.realpathSync('/proc/self/fd/'+fd)===expected){injected=true;throw Error('R1 sync uncertainty');}return sync.call(this,fd);};syncBuiltinESMExports();
 try{await assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,input),/sync uncertainty/);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}assert.equal(injected,true);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].container_id,containerId);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'revoked');
 f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal((await handoff.revokeProviderHandoffGrant(bridge,input)).version,5);
});
for(const boundary of [0,1])for(const mutation of ['close','domain','catalog-path','index-version'])test('R1 '+mutation+' at domain await '+boundary+' never acknowledges revocation',async t=>{
 const f=await revocationFixture(t,'created'),input=revocationIntent(f,'created'),hold=join(f.dir,'r1-held'),release=join(f.dir,'r1-release');fs.writeFileSync(f.log+'.info','0');f.config.infoReplies=Array.from({length:boundary+1},()=>({}));f.config.infoReplies[boundary]={hold,release,...(mutation==='domain'?{stdout:'"substitute_daemon"\n'}:{})};f.configure();
 const pending=assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,input));await waitContainerFile(hold);
 if(mutation==='close')f.owner.close();if(mutation==='catalog-path'){fs.renameSync(f.catalog,join(f.dir,'r1-original'));fs.copyFileSync(join(f.dir,'r1-original'),f.catalog);fs.chmodSync(f.catalog,0o600);}if(mutation==='index-version')native(f.index,db=>db.exec('UPDATE clank_provider_handoff_bridge_index SET version=version+1'));
 const before=snapshot(f);fs.writeFileSync(release,'go');await pending;assert.deepEqual(snapshot(f),before);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,boundary===0?'created':'revoked');
});

test('R1 saturated exact retry performs no update and retains reserved quota',async t=>{
 const f=await revocationFixture(t),reservation={reservationId:randomUUID(),kind:'base',maximumBytes:128,inputSha256:'a'.repeat(64)};await handoff.reserveProviderHandoffSpool(f.bridge,projectId,reservation);
 native(f.catalog,db=>db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=?').run(Number.MAX_SAFE_INTEGER-1));const input={...revocationIntent(f),expectedVersion:Number.MAX_SAFE_INTEGER-1};const first=await handoff.revokeProviderHandoffGrant(f.bridge,input),before=snapshot(f),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE clank_provider_handoff_'))throw Error('R1 retry must not update');return prepare.call(this,sql);};try{assert.deepEqual(await handoff.revokeProviderHandoffGrant(f.bridge,input),first);}finally{DatabaseSync.prototype.prepare=prepare;}assert.equal(first.version,Number.MAX_SAFE_INTEGER);assert.deepEqual(snapshot(f),before);assert.equal(rows(f.index,'clank_provider_handoff_spool_reservations')[0].maximum_bytes,128);
});
for(const boundary of [0,1])for(const mutation of ['catalog-path','other-catalog','index-version'])test('R1 readonly exact retry retains consulted '+mutation+' through domain await '+boundary,async t=>{
 const f=await containerFixture(t,{},true),input=revocationIntent(f);await handoff.revokeProviderHandoffGrant(f.bridge,input);fs.writeFileSync(f.log+'.info','0');const hold=join(f.dir,'r1-retry-held'),release=join(f.dir,'r1-retry-release');f.config.infoReplies=Array.from({length:boundary+1},()=>({}));f.config.infoReplies[boundary]={hold,release};f.configure();
 const pending=assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,input));await waitContainerFile(hold);
 if(mutation==='catalog-path'){fs.renameSync(f.catalog,join(f.dir,'r1-original'));fs.copyFileSync(join(f.dir,'r1-original'),f.catalog);fs.chmodSync(f.catalog,0o600);}if(mutation==='other-catalog')native(join(f.root,'service','handoff','catalogs',f.other.catalogId,'catalog.sqlite'),db=>db.exec('UPDATE clank_provider_handoff_bridge_state SET version=version+1'));if(mutation==='index-version')native(f.index,db=>db.exec('UPDATE clank_provider_handoff_bridge_index SET version=version+1'));
 const retained=snapshot(f);fs.writeFileSync(release,'go');await pending;assert.deepEqual(snapshot(f),retained);assert.equal(rows(f.catalog,'clank_provider_handoff_bridge_state')[0].version,3);
});
test('R1 lost COMMIT response retains revocation and allows exact cleanup restart retry',async t=>{
 const f=await revocationFixture(t,'created'),input=revocationIntent(f,'created'),exec=DatabaseSync.prototype.exec;let injected=false;
 DatabaseSync.prototype.exec=function(sql){const selected=sql==='COMMIT'&&this.prepare('PRAGMA database_list').get().file===f.catalog;const value=exec.call(this,sql);if(selected){injected=true;throw Error('R1 lost commit response');}return value;};try{await assert.rejects(handoff.revokeProviderHandoffGrant(f.bridge,input),/lost commit response/);}finally{DatabaseSync.prototype.exec=exec;}assert.equal(injected,true);assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].state,'revoked');assert.equal(rows(f.catalog,'clank_provider_handoff_source_grant')[0].container_id,containerId);
 f.owner.close();const owner=await f.open(),domain=await f.domain(owner),bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits);assert.equal((await handoff.revokeProviderHandoffGrant(bridge,input)).version,4);
});
