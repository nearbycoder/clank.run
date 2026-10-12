import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import sqlite,{DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {openBackend,defineBackend,defineDatabase,defineTable} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';
import {createHash,createHmac,randomUUID,randomBytes} from 'node:crypto';
import * as handoff from '../dist/provider-handoff.js';
import {sealPointInTimeState} from '../dist/point-in-time-state.js';
import {providerDockerClient} from '../dist/provider-docker-client.js';
const hash=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'clank-source-runtime-')),app=join(root,'app');await mkdir(app,{mode:0o700});
 const executable=join(root,'docker.mjs');await writeFile(executable,"#!/usr/bin/env node\nif(process.argv[2]==='info')process.stdout.write(JSON.stringify('scripted_domain_for_component_fixture')+'\\n');",{mode:0o700});
 const owner=await handoff.acquireProviderServiceOwnership(join(root,'provider'),true),domain=await handoff.createProviderHandoffDomain(owner,providerDockerClient({executable}),'source_node','source_owner');
 const identity=await handoff.initializeProviderHandoff(owner,domain),project=await handoff.installProviderHandoffProject(owner,domain,'source_project');
 const bridge=await handoff.enableProviderHandoffBridge(owner,domain,limits),keys=[randomBytes(32),randomBytes(32),randomBytes(32)];
 const binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:'source_project',releaseId:'source_release',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:process.getuid(),gid:process.getgid(),capture:{keyId:'source_key',keySha256:hash(keys[2]),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
 await handoff.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:hash(keys[0]),controlSecretSha256:hash(keys[1])});
 const directory=join(root,'provider','service','handoff','catalogs',project.catalogId),catalog=join(directory,'catalog.sqlite'),containerId='c'.repeat(64);
 const mutate=action=>{const db=new DatabaseSync(catalog);try{db.exec('BEGIN IMMEDIATE');action(db);const records={grant:db.prepare('SELECT * FROM clank_provider_handoff_source_grant').get()??null,transfer:null,operations:[],spools:[]};db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=? WHERE id=1').run(hash(records));db.exec('COMMIT');}finally{db.close();}};
 // Component-only native row setup. This is not the deferred Docker host transition.
 mutate(db=>db.prepare("UPDATE clank_provider_handoff_source_grant SET state='created',container_id=?").run(containerId));
 const bootstrap={protocol:'clank-provider-source-bootstrap/1',binding,bindingSha256:hash(binding),containerId,catalogPath:'/run/clank-source/catalog.sqlite',grantSecret:keys[0].toString('base64url'),controlSecret:keys[1].toString('base64url'),recoveryKey:keys[2].toString('base64url')};
 t.after(async()=>{owner.close();await rm(root,{recursive:true,force:true});});
 return {root,app,catalog,directory,bootstrap,mutate,revoke:input=>handoff.revokeProviderHandoffGrant(bridge,input),database:join(app,'data.sqlite')};
}
async function child(t,f,mode='normal',extra={}){
 const args=['--unshare-user','--unshare-pid','--die-with-parent','--ro-bind','/','/','--bind',f.app,f.app,'--tmpfs','/run','--dir','/run/clank-source','--ro-bind',f.directory,'/run/clank-source','--proc','/proc','--dev','/dev'];
 if(process.env.NODE_V8_COVERAGE)args.push('--bind',process.env.NODE_V8_COVERAGE,process.env.NODE_V8_COVERAGE);
 args.push('--',process.execPath,resolve('tests/fixtures/provider-handoff-runtime.mjs'));
 const p=spawn('/usr/bin/bwrap',args,{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_NO_WARNINGS:'1'}});let stderr='',partial='',ended=false;const queue=[],waiters=[];
 p.stderr.on('data',data=>stderr+=data);p.stdout.on('data',data=>{partial+=data;let end;while((end=partial.indexOf('\n'))>=0){const line=partial.slice(0,end);partial=partial.slice(end+1);const event=JSON.parse(line);if(waiters.length)waiters.shift().resolve(event);else queue.push(event);}});
 const exit=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',(code,signal)=>{ended=true;const result={code,signal,stderr};for(const waiter of waiters.splice(0))waiter.reject(Error(JSON.stringify(result)));resolve(result);});});
 const timer=setTimeout(()=>p.kill('SIGKILL'),20000);t.after(async()=>{if(!ended)p.kill('SIGKILL');await exit;clearTimeout(timer);});
 p.stdin.write(JSON.stringify({...f,bootstrap:f.bootstrap,mode,mutate:undefined,...extra})+'\n');
 return {async kill(){p.kill('SIGKILL');const result=await exit;assert.equal(result.code,null);assert.equal(result.signal,'SIGKILL');clearTimeout(timer);assert.equal(fs.existsSync('/proc/'+p.pid),false);return result;},next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject})),send:value=>p.stdin.write(JSON.stringify(value)+'\n'),async done(){p.stdin.end();const result=await exit;assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);clearTimeout(timer);}};
}
const cases=[['created bootstrap initializes capture but admits no ordinary writes','normal'],['accessor bootstrap refuses without invoking its getter','malformed'],['closing during the first await invalidates the reserved initialization','close'],['revoked catalog refuses before retained source initialization','refuse']];
for(const sourceTask of ['projection','foreign-inspection','foreign-backup','fake-token','operation','accessor','copied-directory','extra-directory','wrong-role','temporary','directory-replacement','queued-argument-mutation','queued-directory-mutation','directory-accessor'])test('native private source task scope '+sourceTask,async t=>{
 const f=await fixture(t),p=await child(t,f,'source-task',{sourceTask});
 if(sourceTask.startsWith('queued-'))assert.deepEqual(await p.next(),{phase:'source-task-mutation-result',case:sourceTask,revision:73});
 assert.deepEqual(await p.next(),{phase:'source-task-checked',case:sourceTask,spawns:sourceTask.startsWith('queued-')?1:0,passed:true});
 assert.equal((await p.next()).phase,'initialized');p.send({});assert.deepEqual(await p.next(),{ok:true,records:0});await p.done();
 const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal(db.prepare('SELECT sequence FROM clank_pitr_state').get().sequence,0);assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_journal').get().n,0);}finally{db.close();}
});
for(const [name,mode] of cases)test(name,async t=>{
 const f=await fixture(t);if(mode==='refuse')f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));
 const p=await child(t,f,mode),first=await p.next();
 if(mode==='normal'){assert.equal(first.phase,'initialized');p.send({});assert.deepEqual(await p.next(),{ok:true,records:0});}
 else assert.equal(first.ok,true);
 // The result is written before the child closes its runtime. Wait for actual
 // exit before opening an independent reader across native close-time writes.
 await p.done();
 if(mode==='normal'){const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal(db.prepare('SELECT sequence FROM clank_pitr_state').get().sequence,0);assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_journal').get().n,0);}finally{db.close();}}
 if(mode!=='normal')assert.deepEqual(fs.readdirSync(f.app).filter(name=>name.startsWith('.clank-source-recovery-')),[]);
});
test('fresh native grant revocation denies the next managed write',async t=>{const f=await fixture(t),p=await child(t,f);assert.equal((await p.next()).phase,'initialized');f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));p.send({revoke:true});assert.deepEqual(await p.next(),{ok:true,records:0});await p.done();});

test('started bootstrap remains initialization-only after private setup',async t=>{const f=await fixture(t);f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='started'"));const p=await child(t,f);assert.equal((await p.next()).phase,'initialized');p.send({});assert.deepEqual(await p.next(),{ok:true,records:0});await p.done();});

for(const [name,change] of [
 ['wrong grant secret',f=>{f.bootstrap.grantSecret=randomBytes(32).toString('base64url');}],
 ['wrong recovery key',f=>{f.bootstrap.recoveryKey=randomBytes(32).toString('base64url');}],
 ['extra bootstrap key',f=>{f.bootstrap.extra=true;}],
 ['alternate catalog path',f=>{f.bootstrap.catalogPath=f.catalog;}],
 ['wrong container',f=>{f.bootstrap.containerId='f'.repeat(64);} ],
 ['wrong UID',f=>{f.bootstrap.binding.uid++;f.bootstrap.bindingSha256=hash(f.bootstrap.binding);} ],
 ['ready state without its complete validator',f=>f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='ready'"))],
 ['quiesced state without its complete validator',f=>f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='quiesced'"))],
 ['catalog mode drift',f=>fs.chmodSync(f.catalog,0o644)],
 ['unknown schema object',f=>{const db=new DatabaseSync(f.catalog);try{db.exec('CREATE TABLE extra(value TEXT)');}finally{db.close();}}],
 ['WAL header without sidecars',f=>{const db=new DatabaseSync(f.catalog);try{db.exec('PRAGMA journal_mode=WAL');}finally{db.close();}}],
])test('native bootstrap rejects '+name+' without source publication',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.catalog),names=fs.readdirSync(f.directory),p=await child(t,f,'refuse');assert.equal((await p.next()).ok,true);await p.done();assert.deepEqual(fs.readFileSync(f.catalog),before);assert.deepEqual(fs.readdirSync(f.directory),names);assert.deepEqual(fs.readdirSync(f.app).filter(name=>name.startsWith('.clank-source-recovery-')),[]);
});
for(const fault of ['repository-read','worker-admission','worker-close','encryption','manifest','file-sync','rename'])test('native revocation during '+fault+' prevents subsequent initialization acknowledgment',async t=>{
 const f=await fixture(t),p=await child(t,f,'fault',{fault}),held=await p.next();assert.equal(held.phase,'held');f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));p.send({});const result=await p.next();assert.equal(result.ok,true);assert.equal(result.spawns,held.spawns);if(fault==='worker-admission')assert.equal(result.spawns,0);await p.done();
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.existsSync(join(directory,'head.json')),false);
 const db=new DatabaseSync(f.database,{readOnly:true});try{if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_pitr_state'").get()){const state=db.prepare('SELECT base_id,sequence FROM clank_pitr_state').get();assert.equal(state.base_id,'');assert.equal(state.sequence,0);}}finally{db.close();}
 if(fault==='rename')assert.equal(fs.readdirSync(join(directory,'base')).some(name=>name.startsWith('bk_')),true,'uncertain published backup remains retained');
});
for(const nativeFault of ['bootstrap-ignore','base-ignore','base-alter'])test('native '+nativeFault+' refuses false capture acknowledgment',async t=>{
 const f=await fixture(t),p=await child(t,f,'native-fault',{nativeFault});assert.equal((await p.next()).ok,true);await p.done();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);
 const db=new DatabaseSync(f.database,{readOnly:true});try{if(nativeFault==='bootstrap-ignore')assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_pitr_state'").get(),undefined);else assert.equal(db.prepare('SELECT base_id FROM clank_pitr_state').get().base_id,'');assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger'").get(),undefined);}finally{db.close();}
});

for(const [name,encode] of [
 ['duplicate outer key',value=>JSON.stringify(value).replace('{','{"protocol":"clank-provider-source-bootstrap/1",')],
 ['outer whitespace',value=>' '+JSON.stringify(value)],
 ['escaped outer string',value=>JSON.stringify(value).replace('bootstrap/1','bootstrap\\u002f1')],
 ['noncanonical numeric spelling',value=>JSON.stringify(value).replace('"generation":1,','"generation":1.0,')],
])test('noncanonical bootstrap '+name+' refuses before source initialization',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.catalog),names=fs.readdirSync(f.directory),p=await child(t,f,'refuse',{encoded:encode(f.bootstrap)});assert.equal((await p.next()).ok,true);await p.done();assert.deepEqual(fs.readFileSync(f.catalog),before);assert.deepEqual(fs.readdirSync(f.directory),names);assert.deepEqual(fs.readdirSync(f.app).filter(name=>name.startsWith('.clank-source-recovery-')),[]);
});

for(const scenario of ['file','parent','swap-back'])test('actual native descriptor observation refuses '+scenario+' before backend bootstrap',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-native-identity-')),directory=join(root,'app'),path=join(directory,'source.sqlite');await mkdir(directory,{mode:0o700});t.after(()=>rm(root,{recursive:true,force:true}));
 const Native=sqlite.DatabaseSync,seed=new Native(path);seed.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('original')");seed.close();fs.chmodSync(path,0o600);let reads=0,replaced=false,opened,bootstrap=0;
 const swap=()=>{replaced=true;fs.renameSync(scenario==='parent'?directory:path,scenario==='parent'?directory+'.old':path+'.old');if(scenario==='parent')fs.mkdirSync(directory,{mode:0o700});const db=new Native(path);db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('replacement')");db.close();};
 const original=fs.readdirSync,exec=Native.prototype.exec;Native.prototype.exec=function(...args){if(!String(args[0]).startsWith('CREATE TABLE sentinel'))bootstrap++;return exec.apply(this,args);};
 fs.readdirSync=function(file,...args){if(file==='/proc/self/fd'){reads++;if(reads===2){if(scenario==='swap-back'){fs.renameSync(path,path+'.replacement');fs.renameSync(path+'.old',path);}else swap();}const value=original.call(this,file,...args);if(reads===1&&scenario==='swap-back')swap();return value;}return original.call(this,file,...args);};syncBuiltinESMExports();
 try{await assert.rejects(async()=>{opened=await openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0});},/identity|canonical|source|changed/);}finally{opened?.close();fs.readdirSync=original;Native.prototype.exec=exec;syncBuiltinESMExports();assert.equal(replaced,true);}
 assert.equal(bootstrap,0);const db=new Native(path);try{assert.equal(db.prepare('SELECT value FROM sentinel').get().value,scenario==='swap-back'?'original':'replacement');assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_meta'").get(),undefined);}finally{db.close();}
});

for(const mode of ['missing','oversized','nonconfigurable','writable','enumerable','nonstring'])test('bootstrap '+mode+' descriptor leaves a sticky reserved refusal',async t=>{const f=await fixture(t),p=await child(t,f,mode);assert.equal((await p.next()).ok,true);await p.done();assert.deepEqual(fs.readdirSync(f.app).filter(name=>name.startsWith('.clank-source-recovery-')),[]);});
for(const fault of ['worker-admission','worker-close','rename'])test('native close during '+fault+' prevents subsequent initialization acknowledgment',async t=>{const f=await fixture(t),p=await child(t,f,'fault',{fault}),held=await p.next();assert.equal(held.phase,'held');p.send({close:true});const result=await p.next();assert.equal(result.ok,true);assert.equal(result.spawns,held.spawns);await p.done();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.existsSync(join(directory,'head.json')),false);});

for(const mode of ['delete','wal'])test('closing an observed runtime preserves another actual native '+mode+' writer lock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-native-runtime-lock-')),path=join(root,'source.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));const runtime=await openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0});
 runtime.database[SQLITE_INTERNAL].exec('PRAGMA journal_mode='+mode);const owner=new DatabaseSync(path);
 const attempt=()=>{const child=spawnSync(process.execPath,[resolve('tests/fixtures/provider-handoff-runtime.mjs'),'foreign-lock',path],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.equal(child.signal,null);return JSON.parse(child.stdout);};
 try{owner.exec('BEGIN IMMEDIATE');assert.equal(attempt().admitted,false);runtime.close();assert.equal(attempt().admitted,false);owner.exec('ROLLBACK');}finally{runtime.close();owner.close();}assert.equal(attempt().admitted,true);
});

test('actual deferred SQLite descriptor reuse preserves ordinary backend but refuses source eligibility',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-native-reuse-')),path=join(root,'source.sqlite'),definition=defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({}));t.after(()=>rm(root,{recursive:true,force:true}));const initial=await openBackend(definition,{path,agent:false,changePollIntervalMs:0});initial.close();const owner=new DatabaseSync(path);owner.exec('BEGIN');owner.prepare('SELECT count(*) FROM clank_meta').get();const closed=new DatabaseSync(path);closed.prepare('PRAGMA database_list').all();closed.close();let runtime;
 try{runtime=await openBackend(definition,{path,agent:false,changePollIntervalMs:0});assert.throws(()=>openBackend[SQLITE_INTERNAL].assertSourceRuntime(runtime),/unambiguous/);runtime.database.transaction(db=>db.table('records').insert({value:'ordinary'}));assert.equal(runtime.database.read(db=>db.table('records').collect()).length,1);}finally{runtime?.close();owner.exec('ROLLBACK');owner.close();}
});
test('missing native descriptor observation cannot mint source authority and ordinary close releases its directory pin',async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-native-missing-')),path=join(root,'source.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));const original=fs.readdirSync;let before,reads=0,runtime;fs.readdirSync=function(file,...args){const value=original.call(this,file,...args);if(file==='/proc/self/fd'){reads++;if(reads===1)before=value.filter(fd=>{try{fs.fstatSync(Number(fd));return true;}catch{return false;}});if(reads===2)return before;}return value;};syncBuiltinESMExports();
 try{runtime=await openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0});assert.throws(()=>openBackend[SQLITE_INTERNAL].assertSourceRuntime(runtime),/unambiguous/);runtime.database.transaction(db=>db.table('records').insert({value:'ordinary'}));}finally{fs.readdirSync=original;syncBuiltinESMExports();runtime?.close();}
 const retained=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const value=fs.readlinkSync('/proc/self/fd/'+fd);return value===root||value.startsWith(root+'/')?[value]:[];}catch{return [];}});assert.deepEqual(retained,[]);
});
test('native bootstrap failure releases observed native descriptor and directory pin',async t=>{const root=await mkdtemp(join(tmpdir(),'clank-native-invalid-')),path=join(root,'source.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path,'not a SQLite database',{mode:0o600});await assert.rejects(openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0}));const retained=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const value=fs.readlinkSync('/proc/self/fd/'+fd);return value===root||value.startsWith(root+'/')?[value]:[];}catch{return [];}});assert.deepEqual(retained,[]);});

function readonlyNativeSnapshot(path){
 const identity=fs.statSync(path),db=new DatabaseSync(path,{readOnly:true});
 const encode=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{integer:item.toString()}:item instanceof Uint8Array?{blob:Buffer.from(item).toString('base64')}:item);
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name,sql').all();
  const tables=schema.filter(row=>row.type==='table').map(row=>{
   const statement=db.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'"');statement.setReadBigInts(true);
   const rows=statement.all().map(value=>encode(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0))).sort();
   return {name:row.name,rows};
  });
  return {device:identity.dev,inode:identity.ino,sha256:hash(encode({schema,tables}))};
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}

test('actual SIGKILL after base rename retains uncertain evidence and restart cannot reinitialize capture',async t=>{
 const f=await fixture(t),p=await child(t,f,'fault',{fault:'rename'});assert.equal((await p.next()).phase,'held');await p.kill();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);
 const snapshot=()=>{const result={};for(const path of fs.readdirSync(directory,{recursive:true})){const full=join(directory,path),stat=fs.lstatSync(full);result[path]=stat.isDirectory()?{directory:true,mode:stat.mode}:{sha256:hash(fs.readFileSync(full)),mode:stat.mode};}return result;};const before=snapshot();assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.readdirSync(join(directory,'base')).some(name=>name.startsWith('bk_')),true);
 const nativeBefore={source:readonlyNativeSnapshot(f.database),catalog:readonlyNativeSnapshot(f.catalog)};
 const retry=await child(t,f,'restart-refuse'),refusal=await retry.next();assert.equal(refusal.ok,true);assert.ok(['backend-open','source-initialize'].includes(refusal.refusal));await retry.done();assert.deepEqual(snapshot(),before);
 assert.deepEqual({source:readonlyNativeSnapshot(f.database),catalog:readonlyNativeSnapshot(f.catalog)},nativeBefore);
 t.diagnostic(JSON.stringify({refusal:refusal.refusal,sourceAndCatalogUnchanged:true,retainedRepositoryUnchanged:true}));
});

test('revocation while native worker admission is queued releases ownership without submitting source work',async t=>{const f=await fixture(t),p=await child(t,f,'fault',{fault:'worker-queue'}),held=await p.next();assert.equal(held.phase,'held');assert.equal(held.spawns,2);f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));p.send({});const result=await p.next();assert.equal(result.ok,true);assert.equal(result.spawns,3,'only the independent post-refusal ordinary worker was added');await p.done();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.existsSync(join(directory,'head.json')),false);});

for(const code of ['EACCES','ENOENT'])for(const when of [1,2])test('unavailable proc enumeration '+code+' at observation '+when+' preserves ordinary writes without source authority',async t=>{const root=await mkdtemp(join(tmpdir(),'clank-native-proc-denied-')),path=join(root,'source.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));const original=fs.readdirSync;let reads=0,runtime;fs.readdirSync=function(file,...args){if(file==='/proc/self/fd'&&++reads===when)throw Object.assign(new Error('native observation unavailable'),{code});return original.call(this,file,...args);};syncBuiltinESMExports();try{runtime=await openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0});runtime.database.transaction(db=>db.table('records').insert({value:'ordinary'}));assert.equal(runtime.database.read(db=>db.table('records').collect()).length,1);assert.throws(()=>openBackend[SQLITE_INTERNAL].assertSourceRuntime(runtime),/unambiguous/);}finally{fs.readdirSync=original;syncBuiltinESMExports();runtime?.close();}assert.equal(fs.readdirSync('/proc/self/fd').some(fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)===root;}catch{return false;}}),false);});

for(const grant of ['created','started'])test('private completion data matches the actual '+grant+' native capture and retained base',async t=>{
 const f=await fixture(t);if(grant==='started')f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='started'"));
 const p=await child(t,f,'completion'),message=await p.next();assert.equal(message.phase,'initialized');const result=message.completion;
 const db=new DatabaseSync(f.database,{readOnly:true});try{
  const rows=db.prepare('SELECT * FROM clank_pitr_state').all();assert.equal(rows.length,1);const state=rows[0];
  assert.deepEqual(result,{captureEpoch:state.epoch,keyId:state.key_id,schemaHash:state.schema_hash,baseBackupId:state.base_id,observedCursor:{epoch:state.epoch,sequence:0,digest:'0'.repeat(64)}});
  assert.equal(state.sequence,0);assert.equal(state.exported,0);assert.equal(state.remote_exports_protocol,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_journal').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_remote_exports').get().n,0);
  assert.equal(state.state_hash,sealPointInTimeState(db,createHash,limits.maxCaptureStateBytes));
  assert.equal(state.schema_hash,hash(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY type,name").all())));
  const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation),key=Buffer.from(f.bootstrap.recoveryKey,'base64url');
  for(const file of ['epoch.json','head.json','base/'+state.base_id+'/manifest.json']){
   const retained=JSON.parse(fs.readFileSync(join(directory,file),'utf8')),content=retained.manifest??retained.checkpoint;
   assert.equal(retained.mac,createHmac('sha256',file.startsWith('base/')?createHash('sha256').update(key).digest():key).update(JSON.stringify(content)).digest(file.startsWith('base/')?'base64url':'hex'));
   if(file==='epoch.json')assert.deepEqual(content,{protocol:'clank-pitr-repository/1',epoch:state.epoch,keyId:state.key_id,baseBackupId:state.base_id});
   else if(file==='head.json')assert.deepEqual(content,{epoch:state.epoch,sequence:0,digest:state.digest,committedAt:state.committed_at});
   else{assert.equal(content.id,state.base_id);assert.equal(content.encryption.keyId,state.key_id);assert.ok(content.databaseBytes>0);assert.equal(fs.existsSync(join(directory,'base',state.base_id,'database.enc')),true);}
  }
 }finally{db.close();}
 p.send({});assert.deepEqual(await p.next(),{ok:true,records:0});await p.done();
});

const completionCorruption=[
 ['epoch',"UPDATE clank_pitr_state SET epoch='00000000-0000-4000-8000-000000000000'"],
 ['key',"UPDATE clank_pitr_state SET key_id='another_key'"],
 ['key hash',"UPDATE clank_pitr_state SET key_hash='"+'1'.repeat(64)+"'"],
 ['schema hash',"UPDATE clank_pitr_state SET schema_hash='"+'1'.repeat(64)+"'"],
 ['logical hash',"UPDATE clank_pitr_state SET state_hash='"+'1'.repeat(64)+"'"],
 ['base identity',"UPDATE clank_pitr_state SET base_id='bk_1234567890123_abcdefghijkl'"],
 ['committed timestamp','UPDATE clank_pitr_state SET committed_at=committed_at+1'],
 ['sequence','UPDATE clank_pitr_state SET sequence=1'],
 ['exported horizon','UPDATE clank_pitr_state SET exported=1'],
 ['digest',"UPDATE clank_pitr_state SET digest='"+'1'.repeat(64)+"'"],
 ['protocol','UPDATE clank_pitr_state SET remote_exports_protocol=2'],
 ['missing singleton','DELETE FROM clank_pitr_state'],
 ['duplicate singleton','CREATE TABLE clank_pitr_duplicate AS SELECT * FROM clank_pitr_state; DROP TABLE clank_pitr_state; ALTER TABLE clank_pitr_duplicate RENAME TO clank_pitr_state; INSERT INTO clank_pitr_state SELECT * FROM clank_pitr_state'],
 ['journal',"INSERT INTO clank_pitr_journal VALUES(1,'{}')"],
 ['remote export',"INSERT INTO clank_pitr_remote_exports VALUES('op',4096,1,'{}',2)"],
 ['terminal seal','CREATE TABLE clank_pitr_source_seal(value TEXT)'],
 ['unexpected PITR object','CREATE TABLE clank_pitr_unknown(value TEXT)'],
 ['native logical state',"INSERT INTO clank_meta(_key,_value) VALUES('completion_corruption',1)"],
 ['foreign commit',null],
];
for(const [name,completionSQL] of completionCorruption)test('private completion refuses changed '+name+' after actual head publication',async t=>{
 const f=await fixture(t),catalog=fs.readFileSync(f.catalog),p=await child(t,f,'completion-fault',{completionFault:completionSQL?'native':'foreign',completionSQL});
 assert.equal((await p.next()).ok,true);await p.done();assert.deepEqual(fs.readFileSync(f.catalog),catalog);
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'head.json')),true);assert.equal(fs.existsSync(join(directory,'epoch.json')),true);
 const backups=fs.readdirSync(join(directory,'base')).filter(name=>name.startsWith('bk_'));assert.equal(backups.length,1,'published native base remains available for operator recovery');
});

for(const finalFault of ['native','close','revoke','repository-replace','catalog-replace'])test('private completion final await refuses '+finalFault+' and settles owned pins',async t=>{
 const f=await fixture(t),p=await child(t,f,'final-fault',{finalFault});
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);
 if(!['native','close'].includes(finalFault)){
  assert.deepEqual(await p.next(),{phase:'final-held'});
  if(finalFault==='revoke')f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));
  else if(finalFault==='repository-replace'){fs.renameSync(directory,directory+'.retained');fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(join(directory,'foreign-sentinel'),'preserve',{mode:0o600});}
  else{fs.copyFileSync(f.catalog,f.catalog+'.replacement');fs.chmodSync(f.catalog+'.replacement',0o600);fs.renameSync(f.catalog+'.replacement',f.catalog);}
  fs.writeFileSync(join(f.app,'completion-command.json'),JSON.stringify({resume:true}),{mode:0o600});
 }
 assert.equal((await p.next()).ok,true);await p.done();
 const original=finalFault==='repository-replace'?directory+'.retained':directory;
 assert.equal(fs.existsSync(join(original,'head.json')),true);assert.equal(fs.existsSync(join(original,'epoch.json')),true);
 assert.equal(fs.readdirSync(join(original,'base')).filter(name=>name.startsWith('bk_')).length,1);
 if(finalFault==='repository-replace')assert.equal(fs.readFileSync(join(directory,'foreign-sentinel'),'utf8'),'preserve');
});

test('private completion retains the original inserted timestamp across the real base acknowledgment',async t=>{
 const f=await fixture(t),p=await child(t,f,'completion-fault',{completionFault:'before-base'});assert.equal((await p.next()).ok,true);await p.done();
 const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal(db.prepare('SELECT base_id FROM clank_pitr_state').get().base_id,'');}finally{db.close();}
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.existsSync(join(directory,'head.json')),false);assert.equal(fs.readdirSync(join(directory,'base')).filter(name=>name.startsWith('bk_')).length,1);
});

for(const cleanupFault of ['root','reader','both','reader-runtime-close'])test('private initialization attempts all owned cleanup after '+cleanupFault+' native close acknowledgment failure',async t=>{
 const f=await fixture(t),catalog=fs.readFileSync(f.catalog),p=await child(t,f,'cleanup-fault',{finalFault:cleanupFault==='reader-runtime-close'?'close':'native',cleanupFault});
 assert.equal((await p.next()).ok,true);await p.done();assert.deepEqual(fs.readFileSync(f.catalog),catalog);
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),true);assert.equal(fs.existsSync(join(directory,'head.json')),true);assert.equal(fs.readdirSync(join(directory,'base')).filter(name=>name.startsWith('bk_')).length,1);
});
for(const multiple of [false,true])test('native provider owner settles every pin and preserves its first close acknowledgment error '+multiple,async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-owner-close-')),owner=await handoff.acquireProviderServiceOwnership(root,true),close=fs.closeSync,first=new Error('injected owner close acknowledgment'),attempts=[];let injected=false;
 const remaining=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===root||path.startsWith(root+'/')?[{fd:Number(fd),path}]:[];}catch{return [];}});
 fs.closeSync=function(fd){const path=fs.readlinkSync('/proc/self/fd/'+fd),value=close(fd);if(path===root||path.startsWith(root+'/')){attempts.push(path);if(!injected){injected=true;throw first;}if(multiple)throw Error('later close acknowledgment');}return value;};syncBuiltinESMExports();
 try{assert.throws(()=>owner.close(),error=>error===first);assert.equal(injected,true);assert.deepEqual(remaining(),[],'all owned native descriptors must settle');assert.deepEqual(attempts,[join(root,'service','.writer.sqlite'),join(root,'service'),root]);owner.close();assert.equal(attempts.length,3);}finally{fs.closeSync=close;syncBuiltinESMExports();for(const {fd}of remaining())close(fd);await rm(root,{recursive:true,force:true});}
});

for(const initialized of [false,true])test('R1 durable API revocation denies actual managed child '+(initialized?'next write':'bootstrap'),async t=>{
 const f=await fixture(t),input={projectId:f.bootstrap.binding.projectId,grantId:f.bootstrap.binding.grantId,bindingSha256:f.bootstrap.bindingSha256,containerId:f.bootstrap.containerId,expectedVersion:3};let p;
 if(initialized){p=await child(t,f);assert.equal((await p.next()).phase,'initialized');}
 const result=await f.revoke(input);assert.equal(result.state,'revoked');assert.equal(result.containerId,f.bootstrap.containerId);assert.equal(result.version,4);
 if(initialized){p.send({revoke:true});assert.deepEqual(await p.next(),{ok:true,records:0});}else {p=await child(t,f,'refuse');assert.equal((await p.next()).ok,true);}await p.done();
 const db=new DatabaseSync(f.catalog,{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM clank_provider_handoff_source_grant').get().state,'revoked');}finally{db.close();}
});


for(const loss of ['revocation','backend closure','catalog replacement'])test('native source '+loss+' promptly stops an active owned worker before rejecting initialization',async t=>{
 const f=await fixture(t),p=await child(t,f,'fault',{fault:'worker-active'}),held=await p.next();assert.equal(held.phase,'held');assert.equal(held.label,'worker-active');assert.equal(held.spawns,1);assert.ok(held.pid>0);assert.match(held.birth,/^[0-9]+$/);
 const before=performance.now();
 if(loss==='revocation')f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));
 else if(loss==='backend closure')fs.writeFileSync(join(f.app,'cancel-source.json'),'close',{mode:0o600});
 else {fs.copyFileSync(f.catalog,f.catalog+'.replacement');fs.chmodSync(f.catalog+'.replacement',0o600);fs.renameSync(f.catalog+'.replacement',f.catalog);}
 let timer;const result=await Promise.race([p.next(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Revoked source worker is still active after the cancellation bound.')),2000))]).finally(()=>clearTimeout(timer));
 assert.equal(result.ok,true);assert.equal(result.spawns,1);assert.ok(performance.now()-before<2000);await p.done();
 const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'head.json')),false);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);
});

test('native queued source revocation cancels promptly without terminating independent ordinary workers',async t=>{
 const f=await fixture(t),p=await child(t,f,'fault',{fault:'worker-queued-cancel'}),held=await p.next();assert.equal(held.phase,'held');assert.equal(held.label,'worker-queued-cancel');assert.equal(held.spawns,2);
 f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));let timer;
 const result=await Promise.race([p.next(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Revoked source is still queued after the cancellation bound.')),2000))]).finally(()=>clearTimeout(timer));
 assert.equal(result.ok,true);assert.equal(result.spawns,3,'only a later independent ordinary inspection was added');await p.done();
});
