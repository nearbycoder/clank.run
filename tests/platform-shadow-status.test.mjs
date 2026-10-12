import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {defineDatabase,openSQLite,openDeploymentOrchestrator} from '../dist/index.js';
import {shadowCursorToken} from '../dist/managed-shadow.js';
import {linuxProcessBirth} from '../dist/platform-supervisor.js';
import {spawnSync} from 'node:child_process';
import {shadowPlatformFixture,request,appendShadowHistory,until,isNativePlatformTransportClosure} from './fixtures/platform-shadow-native.mjs';
const endpoint=f=>`/api/projects/${f.project.id}/shadow`;
const observed=f=>({journal:f.raw(),controls:{...f.controlCounts},replays:f.control.prepare('SELECT * FROM clank_platform_shadow_reports').all(),project:f.control.prepare('SELECT provider_canary_epoch,shadow_replay_receipt FROM clank_platform_projects WHERE id=?').get(f.project.id)});
async function status(f,suffix='',auth=f.owner){const response=await f.platform.nativeRequest(request(endpoint(f)+suffix,{cookie:auth.cookie}));return{status:response.status,body:await response.json()};}
test('native fixture operations own fresh connections after the actual prior endpoint closes',()=>{
 const result=spawnSync(process.execPath,['--no-warnings','tests/fixtures/native-platform-connection-reuse.mjs','after'],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
 const proof=JSON.parse(result.stdout);assert.equal(proof.passed,true);assert.equal(proof.connections,2);assert.equal(proof.requests,2);assert.equal(proof.nativeCode,undefined);
});
test('native HTTP empty shadow history is readable without mutation freshness or candidate effects',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=observed(f),result=await status(f);assert.equal(result.status,200,JSON.stringify(result));
 assert.deepEqual(result.body,{ok:true,enabled:true,epoch:0,policy:f.options.shadowTraffic,sessions:[],nextBefore:null});assert.deepEqual(observed(f),before);
 const missing=await status(f,'/shadow_absent');assert.equal(missing.status,404);assert.equal(missing.body.error.code,'SHADOW_SESSION_NOT_FOUND');assert.deepEqual(observed(f),before);
});
test('native HTTP shadow history preserves disabled policy and current read-only membership',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t);const member=await f.invite('shadow-reader@example.test');
 f.control.prepare('UPDATE clank_platform_project_members SET permissions=? WHERE project_id=? AND user_id=?').run('["read"]',f.project.id,member.user.id);
 const result=await status(f,'',member);assert.equal(result.status,200,JSON.stringify(result));
 await f.reopen(true);const before=observed(f),disabled=await status(f,'',member);assert.equal(disabled.status,200,JSON.stringify(disabled));assert.deepEqual(disabled.body,{ok:true,enabled:false,epoch:0,policy:null,sessions:[],nextBefore:null});assert.deepEqual(observed(f),before);
 f.control.prepare("UPDATE clank_platform_project_members SET permissions='[]' WHERE project_id=? AND user_id=?").run(f.project.id,member.user.id);const revoked=await status(f,'',member);assert.equal(revoked.status,403);assert.deepEqual(observed(f),before);
});

const sha=value=>createHash('sha256').update(value).digest('hex');
async function signed(f,payload,key){const secret=key??await readFile(join(f.root,'platform/master.key'));return shadowCursorToken(payload,canonical=>createHmac('sha256',secret).update('clank-shadow-cursor/1\n').update(canonical).digest())}
test('native HTTP history paginates original epochs across restart, new sessions, legacy and v2 pruning',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();const ids=await appendShadowHistory(f,23);const bytes=f.control.prepare('SELECT receipt_json,report_json FROM clank_platform_shadow_reports ORDER BY session_id').all();await f.successor();
 const before=observed(f),first=await status(f,'?limit=20');assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.sessions.length,20);assert.equal(first.body.enabled,false);assert.equal(first.body.policy,null);assert.ok(first.body.nextBefore.length<=512);assert.deepEqual(first.body.sessions.map(row=>row.controllerEpoch),ids.slice(-20).reverse().map(row=>row.controllerEpoch));assert.deepEqual(observed(f),before);
 const legacy=first.body.sessions.find(row=>row.reportAvailable);assert.equal(Object.hasOwn(legacy.report,'protocol'),false);
 await f.pausePlatform();const newIds=await appendShadowHistory(f,2,{version:2});await f.successor();const secondBefore=observed(f),second=await status(f,'?before='+first.body.nextBefore);assert.equal(second.status,200,JSON.stringify(second));assert.equal(second.body.sessions.length,3);assert.equal(second.body.nextBefore,null);assert.deepEqual(second.body.sessions.map(row=>row.controllerEpoch),ids.slice(0,3).reverse().map(row=>row.controllerEpoch));assert.ok(second.body.sessions.every(row=>!row.reportAvailable&&row.report===null));assert.ok(second.body.epoch>first.body.epoch);assert.deepEqual(observed(f),secondBefore);
 for(const id of[ids[0].sessionId,newIds[1].sessionId]){const detail=await status(f,'/'+id);assert.equal(detail.status,200,JSON.stringify(detail));assert.equal(detail.body.session.sessionId,id);assert.equal(detail.body.session.snapshot,null);assert.equal(detail.body.session.cleanupRequired,false)}
 const latest=await status(f,'?limit=1');assert.equal(latest.body.sessions[0].report.protocol,2);
 const original=new Map(bytes.map(row=>[JSON.parse(row.receipt_json).identity.sessionId,row.receipt_json]));for(const row of f.control.prepare('SELECT session_id,receipt_json FROM clank_platform_shadow_reports').all())if(original.has(row.session_id))assert.equal(row.receipt_json,original.get(row.session_id),'Legacy immutable receipt bytes remain exact');
 assert.deepEqual(observed(f),secondBefore);
});
test('native HTTP cursor refuses tamper, foreign project, key rotation and future native floor',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=observed(f),payload={version:1,projectId:f.project.id,ceilingEpoch:1,beforeEpoch:1},valid=await signed(f,payload);
 for(const token of[valid.slice(0,-1)+(valid.at(-1)==='A'?'B':'A'),await signed(f,{...payload,projectId:'other'}),await signed(f,payload,Buffer.alloc(32,9))]){const response=await status(f,'?before='+token);assert.equal(response.status,400,JSON.stringify(response));assert.equal(response.body.error.code,'SHADOW_CURSOR_INVALID')}
 const future=await status(f,'?before='+valid);assert.equal(future.status,409,JSON.stringify(future));assert.equal(future.body.error.code,'SHADOW_STATE_INVALID');assert.deepEqual(observed(f),before);
 for(const query of['?','?limit=0','?limit=21','?limit=01','?limit=%31','?%6cimit=1','?limit=1&limit=1','?limit=1&','?extra=1','/missing?limit=1']){const response=await status(f,query);assert.equal(response.status,400,JSON.stringify({query,response}));assert.equal(response.body.error.code,'SHADOW_CURSOR_INVALID')}
 assert.deepEqual(observed(f),before);
});
test('unenrolled ordinary native catalog stays unenrolled after empty shadow reads',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t,undefined,undefined,{disabledShadow:true}),before=f.control.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();assert.equal(before.some(row=>row.name==='clank_platform_shadow_state'),false);
 const result=await status(f);assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.body,{ok:true,enabled:false,epoch:0,policy:null,sessions:[],nextBefore:null});assert.deepEqual(f.control.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),before);assert.deepEqual(f.controlCounts,{binding:0,prepare:0,retire:0,'binding-response':0,'prepare-response':0,'retire-response':0});
});
test('native session revocation during project lease release refuses an already-read status body',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=observed(f);f.control.exec(`CREATE TRIGGER status_revoke AFTER DELETE ON clank_distributed_leases WHEN OLD.resource='project:${f.project.id}' BEGIN DELETE FROM clank_auth_sessions WHERE id='${f.owner.session.id}';END`);
 const result=await status(f);assert.equal(result.status,401,JSON.stringify(result));assert.equal(Object.hasOwn(result.body,'sessions'),false);assert.deepEqual(observed(f),before);assert.equal(f.control.prepare('SELECT 1 FROM clank_auth_sessions WHERE id=?').get(f.owner.session.id),undefined);
});

test('native coherent historical duplicate epoch and above-floor identity refuse even outside selected page',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();await appendShadowHistory(f,3,{maxReports:3});await f.successor();
 const rows=f.control.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),ordered=[...rows].sort((a,b)=>JSON.parse(a.receipt_json).identity.controllerEpoch-JSON.parse(b.receipt_json).identity.controllerEpoch),old=ordered[0],next=ordered[1],mirror=f.control.prepare('SELECT shadow_replay_receipt FROM clank_platform_projects WHERE id=?').get(f.project.id).shadow_replay_receipt;
 for(const change of[{controllerEpoch:JSON.parse(next.receipt_json).identity.controllerEpoch},{epoch:99999}]){
  const receipt=JSON.parse(old.receipt_json);Object.assign(receipt.identity,change);if(old.report_json!==null)receipt.reportDigest=sha(JSON.stringify({identity:receipt.identity,report:JSON.parse(old.report_json)}));const encoded=JSON.stringify(receipt),receipts=rows.map(row=>row.session_id===old.session_id?receipt:JSON.parse(row.receipt_json));
  f.control.exec('BEGIN IMMEDIATE');f.control.prepare('UPDATE clank_platform_shadow_reports SET receipt_json=? WHERE session_id=?').run(encoded,old.session_id);f.control.prepare('UPDATE clank_platform_projects SET shadow_replay_receipt=? WHERE id=?').run(JSON.stringify({protocol:1,count:rows.length,sha256:sha(JSON.stringify(receipts))}),f.project.id);f.control.exec('COMMIT');
  const before=observed(f),refused=await status(f,'?limit=1');assert.equal(refused.status,409,JSON.stringify(refused));assert.equal(refused.body.error.code,'SHADOW_STATE_INVALID');assert.deepEqual(observed(f),before);
  f.control.exec('BEGIN IMMEDIATE');f.control.prepare('UPDATE clank_platform_shadow_reports SET receipt_json=? WHERE session_id=?').run(old.receipt_json,old.session_id);f.control.prepare('UPDATE clank_platform_projects SET shadow_replay_receipt=? WHERE id=?').run(mirror,f.project.id);f.control.exec('COMMIT');
 }
 const repaired=await status(f);assert.equal(repaired.status,200);
});
async function mutate(f,path,body,expected=201){const response=await f.platform.nativeRequest(request(path,{method:'POST',body,cookie:f.owner.cookie,csrf:f.owner.csrf})),value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value}
async function bearerStatus(f,token,path=endpoint(f)){const response=await f.platform.nativeRequest(request(path,{token}));return{status:response.status,body:await response.json()}}
test('actual project-scoped bearer and service-account status require explicit read and current authority',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t,undefined,undefined,{serviceAccounts:true});
 const reader=(await mutate(f,`/api/projects/${f.project.id}/tokens`,{name:'Status reader',permissions:['read']})).token;
 const deployer=(await mutate(f,`/api/projects/${f.project.id}/tokens`,{name:'Deploy only',permissions:['deploy']})).token;
 const preview=(await mutate(f,`/api/projects/${f.project.id}/tokens`,{name:'Preview only',permissions:['previews']})).token;
 const before=observed(f);assert.equal((await bearerStatus(f,reader.accessToken)).status,200);for(const token of[deployer.accessToken,preview.accessToken])assert.equal((await bearerStatus(f,token)).status,403);
 await f.fresh();const path=`/api/organizations/${f.project.organizationId}/service-accounts`,account=(await mutate(f,path,{name:'Shadow status bot',ownerId:f.owner.user.id,operationId:'shadow_status_machine_create_01'})).account;
 const issued=(await mutate(f,path+'/'+account.id+'/credentials',{projectId:f.project.id,permissions:['read'],expiresAt:Date.now()+600000,expectedVersion:account.version,operationId:'shadow_status_machine_issue_01'})).issued;
 const machine=await bearerStatus(f,issued.accessToken);assert.equal(machine.status,200,JSON.stringify(machine));assert.deepEqual(machine.body,(await bearerStatus(f,reader.accessToken)).body);assert.deepEqual(observed(f),before);
 f.control.prepare('UPDATE clank_platform_machine_credentials SET revoked_at=? WHERE id=?').run(Date.now(),issued.credential.id);assert.equal((await bearerStatus(f,issued.accessToken)).status,401);
 f.control.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id=?').run(Date.now(),reader.id);assert.equal((await bearerStatus(f,reader.accessToken)).status,401);
 assert.deepEqual(observed(f),before);
});

test('current Request identity cannot change after status authentication begins',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=observed(f),input=request(endpoint(f),{cookie:f.owner.cookie}),message=await f.platform.rpc({kind:'request',url:input.url,method:'GET',headers:[...input.headers],body:null,mutateHeader:['cookie','changed-after-admission']});
 assert.equal(message.status,403,Buffer.from(message.body,'base64').toString());assert.equal(JSON.parse(Buffer.from(message.body,'base64')).error.code,'SHADOW_REQUEST_CHANGED');assert.deepEqual(observed(f),before);
});
test('ordinary native project occupancy refuses boundedly without borrowing a live lease',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),database=await openSQLite(defineDatabase({}),{path:join(f.root,'platform/control.sqlite')}),orchestrator=openDeploymentOrchestrator(database,{distributedLeaseMs:30000});let held;
 try{held=await orchestrator.acquireLease('project:'+f.project.id,'ordinary-status-owner');assert.ok(held);const before=observed(f),started=performance.now(),result=await status(f);assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'PROJECT_BUSY');assert.ok(performance.now()-started<3000);assert.deepEqual(observed(f),before);await orchestrator.releaseLease(held);held=null;assert.equal((await status(f)).status,200)}finally{if(held)await orchestrator.releaseLease(held);orchestrator.close();database.close()}
});

test('native status preserves maximum-path identity in a complete bounded page',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();await appendShadowHistory(f,21,{version:2,maxReports:20,maximumPolicy:true});await f.successor();const before=observed(f),result=await status(f),bytes=Buffer.byteLength(JSON.stringify(result.body));assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.sessions.length,20);assert.ok(bytes>160000&&bytes<=1048576);
 for(const session of result.body.sessions){assert.equal(session.policy.readPaths.length,32);assert.ok(session.policy.readPaths.every(path=>Buffer.byteLength(path)===256));assert.ok(Buffer.byteLength(JSON.stringify(session))<=32768);assert.equal(session.report.protocol,2);assert.equal(Object.hasOwn(session,'reviewDigest'),false);assert.equal(Object.hasOwn(session,'origin'),false)}assert.ok(!JSON.stringify(result.body).includes(f.endpoint));assert.deepEqual(observed(f),before);t.diagnostic(JSON.stringify({sessionCount:20,pageBytes:bytes,maximumSessionBytes:Math.max(...result.body.sessions.map(session=>Buffer.byteLength(JSON.stringify(session))))}));
});
test('native membership removal during project lease release refuses the captured read snapshot',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),member=await f.invite('status-expiring-reader@example.test'),before=observed(f);f.control.exec(`CREATE TRIGGER status_role AFTER DELETE ON clank_distributed_leases WHEN OLD.resource='project:${f.project.id}' BEGIN UPDATE clank_platform_project_members SET permissions='[]' WHERE project_id='${f.project.id}' AND user_id='${member.user.id}';END`);
 const result=await status(f,'',member);assert.equal(result.status,403,JSON.stringify(result));assert.equal(result.body.error.code,'ROLE_DENIED');assert.equal(Object.hasOwn(result.body,'sessions'),false);assert.deepEqual(observed(f),before);
});
test('native current read authorization refuses impersonation and a disabled user',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),member=await f.invite('status-impersonated-reader@example.test');await f.fresh();
 const response=await f.platform.nativeRequest(request('/api/admin/impersonation',{method:'POST',body:{targetUserId:member.user.id,reason:'Inspect shadow status refusal',confirmation:member.user.email},cookie:f.owner.cookie,csrf:f.owner.csrf}));const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));const impersonation=response.headers.get('set-cookie').split(';')[0],before=observed(f);
 const denied=await status(f,'',{cookie:f.owner.cookie+'; '+impersonation});assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(denied.body.error.code,'IMPERSONATION_FORBIDDEN');
 f.control.prepare('UPDATE clank_auth_users SET disabled=1 WHERE id=?').run(member.user.id);assert.equal((await status(f,'',member)).status,401);assert.deepEqual(observed(f),before);
});

test('native signed status cursor refuses UTF8 BOM alias of its original valid payload',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();const ids=await appendShadowHistory(f,2);await f.successor();const good=await signed(f,{version:1,projectId:f.project.id,ceilingEpoch:ids[1].epoch,beforeEpoch:ids[1].controllerEpoch});assert.equal((await status(f,'?before='+good)).status,200);
 const parts=good.split('.');parts[1]=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(parts[1],'base64url')]).toString('base64url');const before=observed(f),result=await status(f,'?before='+parts.join('.'));assert.equal(result.status,400,JSON.stringify(result));assert.equal(result.body.error.code,'SHADOW_CURSOR_INVALID');assert.deepEqual(observed(f),before);
});
test('native unenrolled read refuses a retained replay mirror whose history tables are absent',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t,undefined,undefined,{disabledShadow:true});f.control.exec('ALTER TABLE clank_platform_projects ADD COLUMN shadow_replay_receipt TEXT');f.control.prepare('UPDATE clank_platform_projects SET shadow_replay_receipt=? WHERE id=?').run(JSON.stringify({protocol:1,count:1,sha256:sha('missing receipt')}),f.project.id);const before=f.control.prepare('SELECT provider_canary_epoch,shadow_replay_receipt FROM clank_platform_projects WHERE id=?').get(f.project.id),result=await status(f);assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'SHADOW_STATE_INVALID');assert.deepEqual(f.control.prepare('SELECT provider_canary_epoch,shadow_replay_receipt FROM clank_platform_projects WHERE id=?').get(f.project.id),before);assert.equal(f.control.prepare("SELECT name FROM sqlite_schema WHERE name='clank_platform_shadow_reports'").get(),undefined);
});
for(const retained of[false,true])for(const table of['clank_platform_shadow_reports','clank_platform_shadow_state'])test('native enrolled '+(retained?'retained':'empty')+' history refuses runtime loss of '+table,{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t);if(retained){await f.pausePlatform();await appendShadowHistory(f,2);await f.successor();}
 const child=f.platform.child,birth=await linuxProcessBirth(child.pid),directory=join(f.root,'platform/supervisor-guardians'),names=await readdir(directory);
 assert.equal(names.length,1);const fence=JSON.parse(await readFile(join(directory,names[0]),'utf8'));
 assert.equal(fence.phase,'armed');assert.equal(fence.controllerPid,child.pid);assert.equal(fence.controllerBirth,birth);assert.ok(Number.isSafeInteger(fence.guardianPid));
 const guardianBirth=await linuxProcessBirth(fence.guardianPid),lease=f.control.prepare('SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1').get();assert.equal(f.control.prepare('SELECT protocol FROM clank_platform_supervisor_state WHERE singleton=1').get().protocol,3);assert.ok(lease.expires_at-Date.now()>5000);
 f.control.exec('DROP TABLE '+table);let response;
 try{response=await status(f)}catch(error){if(!isNativePlatformTransportClosure(error))throw error;response={transportRefused:true,nativeCode:error.nativeCode}}
 if(!response.transportRefused){assert.ok([409,500,503].includes(response.status),JSON.stringify(response));assert.equal(typeof response.body.error?.code,'string',JSON.stringify(response.body));assert.equal(Object.hasOwn(response.body,'sessions'),false)}
 // A socket error alone is insufficient. Establish the exact enrolled child's
 // native SIGKILL and guardian fence cleanup while its real lease is still live.
 await until(()=>child.signalCode!==null||child.exitCode!==null,'enrolled guardian schema refusal',4000);assert.equal(child.signalCode,'SIGKILL');assert.equal(child.exitCode,null);
 await until(async()=>!(await readdir(directory)).length,'enrolled guardian fence removal',4000);
 await assert.rejects(linuxProcessBirth(child.pid),error=>['ENOENT','ESRCH'].includes(error.code));
 const after=f.control.prepare('SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1').get();for(const key of['epoch','owner','token_hash','controller_pid','controller_birth'])assert.equal(after[key],lease[key]);assert.ok(after.expires_at>Date.now());
 assert.equal(f.control.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(table),undefined);assert.equal(f.controlCounts.prepare,0);assert.equal(f.controlCounts.retire,0);
 t.diagnostic(JSON.stringify({table,retained,status:response.status??null,httpCode:response.body?.error.code??null,transportRefused:response.transportRefused??false,nativeCode:response.nativeCode??null,controllerPid:child.pid,controllerBirth:birth,guardianPid:fence.guardianPid,guardianBirth,signal:child.signalCode,leaseStillLive:true}));
});
