import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as h from '../dist/provider-handoff.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';
import {openDeploymentProviderDataStore} from '../dist/provider-data.js';
import {createDeploymentBundle} from '../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../dist/runtime-placement.js';
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
async function fixture(t,{nested=false,projects=1,commit=true}={}){
 const directory=await mkdtemp(join(tmpdir(),'clank-source-launch-')),root=join(directory,'provider'),capsule=join(directory,'capsule'),executable=join(directory,'docker.mjs');
 fs.writeFileSync(executable,"#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify('scripted_source_launch_domain')+'\\n');",{mode:0o700});
 const owner=await h.acquireProviderServiceOwnership(root,true),client=providerDockerClient({executable}),domain=await h.createProviderHandoffDomain(owner,client,'source_node','source_owner');
 await h.initializeProviderHandoff(owner,domain);for(let i=0;i<projects;i++)await h.installProviderHandoffProject(owner,domain,'launch_project_'+i);
 const bridge=await h.enableProviderHandoffBridge(owner,domain,limits),service=await h.admitProviderSourceService(bridge);
 t.after(async()=>{service.close();owner.close();await rm(directory,{recursive:true,force:true});});
 fs.mkdirSync(join(capsule,'dist'),{recursive:true});fs.mkdirSync(join(capsule,'migrations'));fs.writeFileSync(join(capsule,'dist','server.js'),'export const source = true;\n');fs.writeFileSync(join(capsule,'migrations','0001_seed.sql'),"CREATE TABLE seed(value TEXT); INSERT INTO seed VALUES('approved source');\n");
 const dbPath=nested?'nested/source.sqlite':'source.sqlite';
 const artifact=await createDeploymentBundle(capsule,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:dbPath,migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:15000},env:{}},{frameworkVersion:'0.24.0',nodeVersion:process.version});
 const store=await openDeploymentProviderDataStore({rootDirectory:root,maxDatabaseBytes:16777216}),runtimes=[],inputs=[],prepared=[];
 for(let i=0;i<projects;i++){
  const id='launch_project_'+i,runtime=await createDeploymentRuntimeCapsule({projectId:id,releaseId:'launch_release',generation:1,environment:{},database:{path:dbPath,mode:'initialize'},ingress:{route:'/v1/clank/apps/'+id,token:'clanki_source-launch-test-token-12345678901234567890'},artifact},{maxDatabaseBytes:16777216});runtimes.push(runtime);
  const input={operation:{id:'launch_operation_'+i,projectId:id,fence:1,attempt:1,maxAttempts:3},desired:{generation:1,releaseId:'launch_release',state:'running',runtimeProtocol:'clank-runtime/1'},runtime,signal:new AbortController().signal};inputs.push(input);
  if(commit)await store.apply(input,async value=>{prepared[i]=value;});
 }
 const binding=(i=0)=>({projectId:'launch_project_'+i,releaseId:'launch_release',generation:1,capsuleSha256:runtimes[i].sha256,fence:1});
 const pins=()=>fs.readdirSync('/proc/self/fd').filter(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===root||path.startsWith(root+'/');}catch{return false;}});
 return {directory,root,service,owner,bridge,store,runtimes,inputs,prepared,binding,pins,project:join(root,'projects','launch_project_0')};
}
for(const nested of [false,true])test('pre-C1 launch data derives original settled '+(nested?'nested':'direct')+' paths without prepared DTO authority',async t=>{
 const f=await fixture(t,{nested}),before=f.pins().length,lease=await h.retainProviderSourceLaunchData(f.service,f.binding());
 assert.ok(Object.isFrozen(lease));assert.equal(lease.databasePath,f.prepared[0].databasePath);assert.equal(lease.releaseDirectory,f.prepared[0].releaseDirectory);assert.equal(lease.dataDirectory,join(f.project,'data'));assert.equal(lease.fence,1);
 h.assertProviderSourceLaunchDataLease(lease);await lease.verifyCurrent();const db=new DatabaseSync(lease.databasePath,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM seed').get().value,'approved source');}finally{db.close();}
 assert.equal('execute'in lease,false);assert.equal('ready'in lease,false);assert.equal('write'in lease,false);lease.close();assert.equal(f.pins().length,before);await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.binding()),/duplicated or recycled/);
});
test('launch data refuses copied services, prepared DTOs and accessor fields without evaluating them',async t=>{
 const f=await fixture(t);let reads=0;const input={...f.binding()};Object.defineProperty(input,'projectId',{enumerable:true,get(){reads++;throw Error('must not evaluate caller data');}});
 await assert.rejects(h.retainProviderSourceLaunchData({...f.service},input),/genuine/);
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,input),/closed own data/);
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.prepared[0]),/closed own data/);assert.equal(reads,0);
 const lease=await h.retainProviderSourceLaunchData(f.service,f.binding());for(const value of [{...lease},new Proxy(lease,{}),{},null])assert.throws(()=>h.assertProviderSourceLaunchDataLease(value),/genuine/);lease.close();
});
for(const key of ['releaseId','generation','capsuleSha256','fence'])test('launch data refuses mismatched native committed '+key,async t=>{
 const f=await fixture(t),input=f.binding(),before=fs.readFileSync(join(f.project,'state.json'));input[key]=key==='releaseId'?'other_release':key==='capsuleSha256'?'a'.repeat(64):2;
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,input),/exact committed generation and fence/);assert.deepEqual(fs.readFileSync(join(f.project,'state.json')),before);
});
test('uncommitted source launch refuses even inside the genuine data validation callback',async t=>{
 const f=await fixture(t,{commit:false});await assert.rejects(f.store.apply(f.inputs[0],async()=>{assert.ok(fs.existsSync(join(f.project,'journal.json')));await h.retainProviderSourceLaunchData(f.service,f.binding());}),/Unsettled/);
 assert.equal(fs.existsSync(join(f.project,'state.json')),false);assert.equal(f.pins().some(fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd).endsWith('/source.sqlite');}catch{return false;}}),false);
});
test('same committed fence preserves launch observation across the actual idempotent apply path',async t=>{
 const f=await fixture(t);let lease;const result=await f.store.apply(f.inputs[0],async prepared=>{assert.equal(prepared.alreadyCommitted,true);lease=await h.retainProviderSourceLaunchData(f.service,f.binding());});assert.equal(result.fence,1);h.assertProviderSourceLaunchDataLease(lease);lease.close();
});
test('higher post-validation fence cannot turn an older data observation into launch authority',async t=>{
 const f=await fixture(t);let lease;const input={...f.inputs[0],operation:{...f.inputs[0].operation,fence:2}};await f.store.apply(input,async()=>{lease=await h.retainProviderSourceLaunchData(f.service,f.binding());});
 assert.throws(()=>lease.assertCurrent(),/private bounded native SQLite files|identity changed|observation changed/);assert.throws(()=>lease.assertCurrent(),/closed/);assert.equal((await f.store.inspect('launch_project_0')).fence,2);
});
for(const kind of ['inode','journal','state','fence'])test('launch native '+kind+' drift permanently refuses after restoration',async t=>{
 const f=await fixture(t),lease=await h.retainProviderSourceLaunchData(f.service,f.binding());const path=kind==='inode'?lease.databasePath:join(f.project,kind==='journal'?'journal.json':kind+'.json');let saved;
 if(kind==='inode'){saved=join(f.directory,'original.sqlite');fs.renameSync(path,saved);fs.copyFileSync(saved,path);fs.chmodSync(path,0o600);}
 else if(kind==='journal')fs.writeFileSync(path,'{}\n',{mode:0o600});else{saved=fs.readFileSync(path);fs.writeFileSync(path,saved.toString().replace('"fence":1','"fence":2'),{mode:0o600});}
 assert.throws(()=>lease.assertCurrent());if(kind==='inode'){fs.unlinkSync(path);fs.renameSync(saved,path);}else if(kind==='journal')fs.unlinkSync(path);else fs.writeFileSync(path,saved,{mode:0o600});assert.throws(()=>lease.assertCurrent(),/closed/);
});
test('owner close releases original launch-data descriptors before any caller can reuse them',async t=>{
 const f=await fixture(t),lease=await h.retainProviderSourceLaunchData(f.service,f.binding());assert.ok(f.pins().length>8);f.owner.close();assert.equal(f.pins().length,0);assert.throws(()=>lease.assertCurrent(),/closed/);
});
test('parallel pre-C1 retention reserves its native admission budget before imports and waits',async t=>{
 const f=await fixture(t,{projects:3}),first=h.retainProviderSourceLaunchData(f.service,f.binding(0)),second=h.retainProviderSourceLaunchData(f.service,f.binding(1));
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.binding(2)),/duplicated or recycled/);const leases=await Promise.all([first,second]);leases.forEach(lease=>lease.close());
});
test('launch publication rechecks native data after the final ownership await',async t=>{
 const f=await fixture(t),before=f.pins().length,freeze=Object.freeze;let injected=false;
 Object.freeze=function(value){const result=freeze(value);if(value?.databasePath===f.prepared[0].databasePath&&typeof value.verifyCurrent==='function'){
  Object.freeze=freeze;queueMicrotask(()=>{fs.writeFileSync(join(f.project,'journal.json'),'{}\n',{mode:0o600});injected=true;});
 }return result;};
 try{await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.binding()),/observation changed/);}finally{Object.freeze=freeze;}
 assert.equal(injected,true);assert.equal(f.pins().length,before);fs.unlinkSync(join(f.project,'journal.json'));
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.binding()),/duplicated or recycled/);
});
test('launch data refuses an intermediate symlink into a sibling project',async t=>{
 const f=await fixture(t,{nested:true}),parent=join(f.project,'data','nested'),saved=join(f.directory,'original-nested');
 fs.renameSync(parent,saved);fs.symlinkSync(saved,parent,'dir');const before=f.pins().length;
 await assert.rejects(h.retainProviderSourceLaunchData(f.service,f.binding()),/parent is not canonical/);
 assert.equal(f.pins().length,before);fs.unlinkSync(parent);fs.renameSync(saved,parent);
});
