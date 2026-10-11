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
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import * as handoff from '../dist/provider-handoff.js';
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
 return {root,app,catalog,directory,bootstrap,mutate,database:join(app,'data.sqlite')};
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
for(const [name,mode] of cases)test(name,async t=>{
 const f=await fixture(t);if(mode==='refuse')f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));
 const p=await child(t,f,mode),first=await p.next();
 if(mode==='normal'){assert.equal(first.phase,'initialized');p.send({});assert.deepEqual(await p.next(),{ok:true,records:0});const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal(db.prepare('SELECT sequence FROM clank_pitr_state').get().sequence,0);assert.equal(db.prepare('SELECT count(*) AS n FROM clank_pitr_journal').get().n,0);}finally{db.close();}}
 else assert.equal(first.ok,true);
 await p.done();
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

test('actual SIGKILL after base rename retains uncertain evidence and restart cannot reinitialize capture',async t=>{
 const f=await fixture(t),p=await child(t,f,'fault',{fault:'rename'});assert.equal((await p.next()).phase,'held');await p.kill();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);
 const snapshot=()=>{const result={};for(const path of fs.readdirSync(directory,{recursive:true})){const full=join(directory,path),stat=fs.lstatSync(full);result[path]=stat.isDirectory()?{directory:true,mode:stat.mode}:{sha256:hash(fs.readFileSync(full)),mode:stat.mode};}return result;};const before=snapshot();assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.readdirSync(join(directory,'base')).some(name=>name.startsWith('bk_')),true);
 const retry=await child(t,f,'restart-refuse');assert.equal((await retry.next()).ok,true);await retry.done();assert.deepEqual(snapshot(),before);
});

test('revocation while native worker admission is queued releases ownership without submitting source work',async t=>{const f=await fixture(t),p=await child(t,f,'fault',{fault:'worker-queue'}),held=await p.next();assert.equal(held.phase,'held');assert.equal(held.spawns,2);f.mutate(db=>db.exec("UPDATE clank_provider_handoff_source_grant SET state='revoked'"));p.send({});const result=await p.next();assert.equal(result.ok,true);assert.equal(result.spawns,3,'only the independent post-refusal ordinary worker was added');await p.done();const directory=join(f.app,'.clank-source-recovery-'+f.bootstrap.binding.sourceIncarnation);assert.equal(fs.existsSync(join(directory,'epoch.json')),false);assert.equal(fs.existsSync(join(directory,'head.json')),false);});

for(const code of ['EACCES','ENOENT'])for(const when of [1,2])test('unavailable proc enumeration '+code+' at observation '+when+' preserves ordinary writes without source authority',async t=>{const root=await mkdtemp(join(tmpdir(),'clank-native-proc-denied-')),path=join(root,'source.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));const original=fs.readdirSync;let reads=0,runtime;fs.readdirSync=function(file,...args){if(file==='/proc/self/fd'&&++reads===when)throw Object.assign(new Error('native observation unavailable'),{code});return original.call(this,file,...args);};syncBuiltinESMExports();try{runtime=await openBackend(defineBackend({schema:defineDatabase({records:defineTable({value:s.string()})})}).functions(()=>({})),{path,agent:false,changePollIntervalMs:0});runtime.database.transaction(db=>db.table('records').insert({value:'ordinary'}));assert.equal(runtime.database.read(db=>db.table('records').collect()).length,1);assert.throws(()=>openBackend[SQLITE_INTERNAL].assertSourceRuntime(runtime),/unambiguous/);}finally{fs.readdirSync=original;syncBuiltinESMExports();runtime?.close();}assert.equal(fs.readdirSync('/proc/self/fd').some(fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)===root;}catch{return false;}}),false);});
