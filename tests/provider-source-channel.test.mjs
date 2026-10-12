import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as h from '../dist/provider-handoff.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';
const linux={skip:process.platform!=='linux'||!process.getuid?.()};
const hash=v=>createHash('sha256').update(v instanceof Uint8Array?v:typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const cid='f'.repeat(64),zero='0001-01-01T00:00:00Z';
async function fixture(t){
 const dir=fs.mkdtempSync(join(tmpdir(),'clank-issued-channel-')),root=join(dir,'provider'),executable=join(dir,'docker.mjs'),log=join(dir,'commands');
 let owner,secret;const channels=[];t.after(async()=>{try{for(const channel of channels)await channel.close();}finally{owner?.close();secret?.fill(0);fs.rmSync(dir,{recursive:true,force:true});}});
 fs.writeFileSync(log+'.container.json','{}');
 fs.copyFileSync(new URL('./fixtures/provider-handoff-container.mjs',import.meta.url),executable);fs.chmodSync(executable,0o700);
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,providerDockerClient({executable,dockerEnvironment:{LOG:log}}),'node_source','owner-source'),identity=await h.initializeProviderHandoff(owner,domain),project=await h.installProviderHandoffProject(owner,domain,'project_source'),bridge=await h.enableProviderHandoffBridge(owner,domain,limits);secret=randomBytes(32);
 const binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:'project_source',releaseId:'release_source',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:process.getuid(),gid:process.getgid(),capture:{keyId:'source_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
 await h.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:hash(secret)});
 const input={projectId:binding.projectId,grantId:binding.grantId,bindingSha256:hash(binding),expectedVersion:2},catalog=join(root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite');
 const projection=(state='created')=>{
  const labels={'run.clank.managed':'provider-runtime','run.clank.owner':'owner-source','run.clank.project':binding.projectId,'run.clank.release':binding.releaseId,'run.clank.generation':'1','run.clank.role':'web','run.clank.instance':'0','run.clank.handoff.protocol':binding.protocol,'run.clank.handoff.node':'node_source','run.clank.handoff.daemon':'daemon_native_fixture','run.clank.handoff.domain':binding.domainSha256,'run.clank.handoff.enablement':binding.enablementId,'run.clank.handoff.index':binding.indexId,'run.clank.handoff.catalog':binding.catalogId,'run.clank.handoff.grant':binding.grantId,'run.clank.handoff.binding':hash(binding),'run.clank.handoff.capsule':binding.capsuleSha256,'run.clank.handoff.incarnation':binding.sourceIncarnation};
  return[cid,binding.imageId,binding.imageId,binding.uid+':'+binding.gid,labels,'no',0,state,state==='running',false,false,false,state==='running'?123:0,state==='running'?'2026-10-11T12:00:00.123456789Z':zero,zero,0,'2026-10-11T11:59:59Z'];
 };
 const configure=(state='created',changes)=>{const value=projection(state);changes?.(value);fs.writeFileSync(log+'.container.json',JSON.stringify({projection:value}));};configure();
 const mutate=action=>{const db=new DatabaseSync(catalog);try{db.exec('BEGIN IMMEDIATE');action(db);const records={grant:db.prepare('SELECT * FROM clank_provider_handoff_source_grant').get(),transfer:null,operations:[],spools:[]};db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=?').run(hash(records));db.exec('COMMIT');}finally{db.close();}};
 return{dir,root,owner,bridge,binding,secret,input,catalog,configure,mutate,async prepare(value=input,key=secret){const channel=await h.prepareProviderSourceWorkerChannel(bridge,value,key);channels.push(channel);return channel;},created:()=>h.recordProviderHandoffContainerCreated(bridge,{...input,containerId:cid}),started:()=>h.recordProviderHandoffContainerStarted(bridge,{...input,containerId:cid,expectedVersion:3})};
}
function pins(root){return fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root+'/')?[path]:[];}catch{return[];}});}
test('issued channel derives its native private directories and socket from original provider ownership',linux,async t=>{
 const f=await fixture(t),before=pins(f.root).length,key=Buffer.from(f.secret),channel=await f.prepare();h.assertProviderSourceWorkerChannel(channel);await channel.verifyCurrent();assert.deepEqual(f.secret,key);assert.equal(channel.mountSource,join(f.root,'.clank-source-worker-'+f.binding.grantId,'mount'));assert.equal(fs.lstatSync(join(channel.mountSource,'sqlite.sock')).isSocket(),true);assert.equal(fs.lstatSync(join(channel.mountSource,'sqlite.sock')).mode&0o777,0o600);assert.ok(pins(f.root).length>before);assert.throws(()=>h.assertProviderSourceWorkerChannel({...channel}),/original/);await channel.close();assert.equal(pins(f.root).length,before);assert.deepEqual(fs.readdirSync(channel.mountSource),[]);await channel.close();
});
test('one original channel survives exact C1 creation/start without granting SQLite authority',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare();await f.created();const scope=await channel.bindCreated({...f.input,containerId:cid,expectedVersion:3});assert.equal(scope.containerId,cid);assert.equal(scope.bindingSha256,f.input.bindingSha256);assert.equal(scope.sourceIncarnation,f.binding.sourceIncarnation);assert.ok(Object.isFrozen(scope));f.configure('running');await f.started();channel.assertCurrent();await channel.verifyCurrent();await assert.rejects(channel.bindCreated({...f.input,containerId:cid,expectedVersion:3}),/duplicated|recycled/);assert.equal('execute'in channel,false);await assert.rejects(channel.dispatch({}),/original coupled/);await channel.close();
});
for(const kind of ['copy','accessor','extra','version','key','shared-key'])test('issued channel refuses '+kind+' before filesystem acquisition',linux,async t=>{
 const f=await fixture(t);let getters=0;const input={...f.input};let key=f.secret,bridge=f.bridge;
 if(kind==='copy')bridge={...bridge};if(kind==='accessor')Object.defineProperty(input,'grantId',{enumerable:true,get(){getters++;throw Error('getter');}});if(kind==='extra')input.path='/tmp/unapproved';if(kind==='version')input.expectedVersion=3;if(kind==='key')key=randomBytes(32);if(kind==='shared-key')key=new Uint8Array(new SharedArrayBuffer(32));
 await assert.rejects(h.prepareProviderSourceWorkerChannel(bridge,input,key));assert.equal(getters,0);assert.equal(fs.existsSync(join(f.root,'.clank-source-worker-'+f.binding.grantId)),false);
});
test('issued channel refuses an existing native namespace without adopting or removing it',linux,async t=>{
 const f=await fixture(t),base=join(f.root,'.clank-source-worker-'+f.binding.grantId);fs.mkdirSync(base,{mode:0o700});fs.writeFileSync(join(base,'unknown'),'preserved');await assert.rejects(f.prepare(),/exists|EEXIST/);assert.equal(fs.readFileSync(join(base,'unknown'),'utf8'),'preserved');
});
test('closing the original provider owner closes its broker before releasing channel pins',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare();f.owner.close();assert.throws(()=>channel.assertCurrent(),/closed/);await channel.close();assert.equal(fs.existsSync(join(channel.mountSource,'sqlite.sock')),false);assert.deepEqual(pins(f.root),[]);
});
test('durable issued-grant revocation invalidates idle native channel ownership',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare();await h.revokeProviderHandoffGrant(f.bridge,{...f.input,containerId:null});await new Promise(resolve=>setTimeout(resolve,100));assert.throws(()=>channel.assertCurrent(),/closed|grant/);await channel.close();assert.equal(fs.existsSync(join(channel.mountSource,'sqlite.sock')),false);
});
test('replaced public socket bytes are preserved during issued channel cleanup',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare(),path=join(channel.mountSource,'sqlite.sock');fs.unlinkSync(path);fs.writeFileSync(path,'unknown replacement',{mode:0o600});assert.throws(()=>channel.assertCurrent());await channel.close();assert.equal(fs.readFileSync(path,'utf8'),'unknown replacement');
});

test('concurrent created binding refuses a second epoch without changing the first key',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare();await f.created();const input={...f.input,containerId:cid,expectedVersion:3},first=channel.bindCreated(input),refused=assert.rejects(channel.bindCreated(input),/duplicated|recycled/);const binding=await first;await refused;assert.equal(binding.containerId,cid);channel.assertCurrent();await channel.close();
});
test('closing the original retained started grant closes its prepared channel',linux,async t=>{
 const f=await fixture(t),channel=await f.prepare();await f.created();await channel.bindCreated({...f.input,containerId:cid,expectedVersion:3});f.configure('running');await f.started();const lease=await h.retainProviderSourceGrant(f.bridge,{...f.input,containerId:cid,expectedVersion:4},f.secret);lease.close();assert.throws(()=>channel.assertCurrent(),/closed/);await channel.close();assert.equal(fs.existsSync(join(channel.mountSource,'sqlite.sock')),false);
});

test('failed opt-in channel acquisition cannot fall back to a started source observer',linux,async t=>{
 const f=await fixture(t),base=join(f.root,'.clank-source-worker-'+f.binding.grantId);fs.mkdirSync(base,{mode:0o700});await assert.rejects(f.prepare(),/exists|EEXIST/);await f.created();f.configure('running');await f.started();await assert.rejects(h.retainProviderSourceGrant(f.bridge,{...f.input,containerId:cid,expectedVersion:4},f.secret),/attempted source channel/);
});
