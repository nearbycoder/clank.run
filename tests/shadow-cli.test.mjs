import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {payload,session,nativeOperatorHistory,versionedPayload,malformedStatuses} from './fixtures/shadow-operator-payload.mjs';
const cli=fileURLToPath(new URL('../scripts/clank.mjs',import.meta.url));
async function fixture(t,native){
 const root=await mkdtemp(join(tmpdir(),'clank-shadow-cli-')),config=join(root,'config'),project=join(root,'project'),calls=[];await mkdir(config);await mkdir(join(project,'.clank'),{recursive:true});let failure=null,responseBody;
 const server=createServer(async(req,res)=>{let bytes='';for await(const part of req)bytes+=part;calls.push({url:req.url,method:req.method,authorization:req.headers.authorization,body:bytes});res.setHeader('content-type','application/json');if(failure){res.statusCode=failure;res.end(JSON.stringify({error:{code:'SHADOW_UNAVAILABLE',message:'Status is unavailable'}}));return}res.end(responseBody===undefined?JSON.stringify(req.url.endsWith('/'+session.sessionId)?{ok:true,enabled:false,epoch:31,session}:{...payload,enabled:false,policy:null}):responseBody);});
 if(!native)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=native?.platform.url??`http://127.0.0.1:${server.address().port}`;
 await writeFile(join(config,'config.json'),JSON.stringify({version:1,current:origin,profiles:{[origin]:{token:native?.owner.accessToken??'clnk_private_shadow_fixture',expiresAt:Date.now()+60000}}}));await writeFile(join(project,'.clank/project.json'),JSON.stringify({version:1,server:origin,projectId:native?.project.id??'project_a'}));
 t.after(async()=>{if(!native){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await rm(root,{recursive:true,force:true})});
 const run=(args,{closeOutput=false}={})=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{cwd:project,env:{...process.env,CLANK_HOME:config},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',b=>stdout+=b);if(closeOutput)child.stdout.destroy();child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr})})});return{run,calls,project,fail(code){failure=code},reply(value){responseBody=JSON.stringify(value)},replyRaw(value){responseBody=value}};
}
test('shadow CLI list/detail use only linked-project GET and preserve the shared safe DTO',async t=>{const f=await fixture(t);const list=await f.run(['shadow','status','--json']);assert.equal(list.code,0,list.stderr);assert.deepEqual(JSON.parse(list.stdout),{...payload,enabled:false,policy:null});const detail=await f.run(['shadow','status',f.project,'--session',session.sessionId,'--json']);assert.equal(detail.code,0,detail.stderr);assert.deepEqual(JSON.parse(detail.stdout).session,session);assert.deepEqual(f.calls.map(c=>[c.method,c.url,c.body]),[['GET','/api/projects/project_a/shadow',''],['GET','/api/projects/project_a/shadow/'+session.sessionId,'']]);assert.ok(f.calls.every(c=>c.authorization==='Bearer clnk_private_shadow_fixture'));assert.doesNotMatch(list.stdout+detail.stdout+list.stderr+detail.stderr,/clnk_private/)});
test('shadow CLI rejects every mutation/unknown option and malformed identity before network',async t=>{const f=await fixture(t);for(const args of [['start'],['stop',session.sessionId],['preview'],['recover',session.sessionId],['status','--force'],['status','--session','../x'],['status','--session','a'.repeat(129)],['status','--session'],['status','--session','a','--session=b'],['status','--json=false'],['status',f.project,'extra']]){const r=await f.run(['shadow',...args]);assert.equal(r.code,1,JSON.stringify({args,r}))}assert.equal(f.calls.length,0)});
test('shadow CLI human output keeps original epoch, uncertain cleanup and honest comparison denominators',async t=>{const f=await fixture(t),r=await f.run(['shadow','status']);assert.equal(r.code,0,r.stderr);for(const value of [/policy: disabled/,/original controller epoch: 7/,/status version: 31/,/2 comparable/,/candidate-timeout/,/Cross-host freshness is unknown/,/semantic correctness/,/read-only/,/population 3 settled/,/Full report/].slice(0,-1))assert.match(r.stdout,value);assert.equal(f.calls.length,1);assert.doesNotMatch(r.stdout,/passed|p95|clnk_private/)});
test('shadow CLI refusal makes one read and never retries or mutates',async t=>{const f=await fixture(t);f.fail(403);const r=await f.run(['shadow','status','--json']);assert.equal(r.code,1);assert.match(r.stderr,/SHADOW_UNAVAILABLE/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');assert.doesNotMatch(r.stdout+r.stderr,/clnk_private/)});

for(const json of [false,true])test(`shadow CLI rejects malformed list status before ${json?'JSON':'human'} output`,async t=>{
 const f=await fixture(t),invalid=[{},null,[],{...payload,ok:false},{...payload,enabled:'false'},{...payload,epoch:-1},{...payload,policy:undefined},{...payload,policy:{...payload.policy,maxReports:101}},{...payload,policy:{...payload.policy,maxSamplePercent:0.001}},{...payload,sessions:{}},{...payload,nextBefore:3},{...payload,privateToken:'must-not-print'},{...payload,sessions:[{...session,operationId:'../other'}]},{...payload,sessions:[{...session,controllerEpoch:32}]},{...payload,sessions:[{...session,releaseId:''}]},{...payload,sessions:[{...session,primary:{releaseId:'release_primary',generation:0}}]},{...payload,sessions:[{...session,report:{}}]}];
 for(const value of invalid){f.reply(value);const before=f.calls.length,r=await f.run(['shadow','status',...(json?['--json']:[])]);assert.equal(r.code,1,JSON.stringify({value,r}));assert.match(r.stderr,/Shadow status is unavailable/);assert.equal(r.stdout,'');assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).method,'GET');assert.doesNotMatch(r.stderr,/must-not-print|clnk_private/)}
});
for(const json of [false,true])test(`shadow CLI rejects malformed or mismatched detail before ${json?'JSON':'human'} output`,async t=>{
 const f=await fixture(t),detail={ok:true,enabled:false,epoch:31,session},invalid=[{},null,{...payload},{...detail,session:null},{...detail,epoch:30},{...detail,session:{...session,sessionId:'another_session'}},{...detail,session:{...session,controllerEpoch:0}},{...detail,session:{...session,cleanupRequired:'false'}},{...detail,session:{...session,phase:undefined}},{...detail,session:{...session,policy:{...session.policy,samplePercent:0.001}}},{...detail,session:{...session,artifactSha256:'not-a-digest'}}];
 for(const value of invalid){f.reply(value);const before=f.calls.length,r=await f.run(['shadow','status','--session',session.sessionId,...(json?['--json']:[])]);assert.equal(r.code,1,JSON.stringify({value,r}));assert.match(r.stderr,/Shadow status is unavailable/);assert.equal(r.stdout,'');assert.equal(f.calls.length,before+1);assert.deepEqual([f.calls.at(-1).method,f.calls.at(-1).url,f.calls.at(-1).body],['GET','/api/projects/project_a/shadow/'+session.sessionId,''])}
});
test('shadow CLI preserves valid empty and compact statuses and refuses truncated native HTTP JSON once',async t=>{
 const f=await fixture(t),empty={ok:true,enabled:false,epoch:0,policy:null,sessions:[],nextBefore:null};f.reply(empty);
 const human=await f.run(['shadow','status']);assert.equal(human.code,0,human.stderr);assert.match(human.stdout,/policy: disabled/);assert.match(human.stdout,/No shadow sessions retained/);
 const json=await f.run(['shadow','status','--json']);assert.equal(json.code,0,json.stderr);assert.deepEqual(JSON.parse(json.stdout),empty);
 const boundary={...payload,policy:{...payload.policy,maxSamplePercent:0.01,maxReports:100},sessions:[{...session,policy:{...session.policy,samplePercent:0.01}}]};f.reply(boundary);
 for(const args of [[],['--json']]){const accepted=await f.run(['shadow','status',...args]);assert.equal(accepted.code,0,accepted.stderr);if(args.length)assert.deepEqual(JSON.parse(accepted.stdout),boundary);else assert.match(accepted.stdout,/0.01/)}
 const compact={ok:true,enabled:false,epoch:31,session:{...session,phase:'complete',outcome:'interrupted',cleanupRequired:false,reportAvailable:false,report:null,snapshot:null,nextAction:'none'}};f.reply(compact);
 const retained=await f.run(['shadow','status','--session',session.sessionId,'--json']);assert.equal(retained.code,0,retained.stderr);assert.deepEqual(JSON.parse(retained.stdout),compact);
 f.replyRaw('{"ok":');const malformed=await f.run(['shadow','status','--json']);assert.equal(malformed.code,1);assert.match(malformed.stderr,/non-JSON/);assert.equal(malformed.stdout,'');assert.equal(f.calls.length,6);assert.ok(f.calls.every(call=>call.method==='GET'&&call.body===''));
});

const definiteIncomplete=['candidate-timeout','not-submitted','candidate-oversized','candidate-error','primary-incomplete','primary-oversized'];
function oneUnknownReport(reason,bothComplete=1){
 const complete=()=>({cumulative:Array(12).fill(1),overflow:0,unknown:0});
 return{counters:{reserved:1,settled:1,comparable:0,statusClassEqual:0,statusClassDifferent:0,mediaTypeEqual:0,mediaTypeDifferent:0,bothComplete,unknown:Object.fromEntries(Object.keys(session.report.counters.unknown).map(key=>[key,key===reason?1:0]))},latency:{primary:complete(),candidate:complete()}};
}
for(const json of [false,true])test(`shadow CLI enforces reviewed incomplete report counts before ${json?'JSON':'human'} output`,async t=>{
 const f=await fixture(t);
 for(const reason of definiteIncomplete)for(const detail of [false,true]){
  const row={...session,report:oneUnknownReport(reason)},value=detail?{ok:true,enabled:false,epoch:31,session:row}:{...payload,sessions:[row]};f.reply(value);
  const before=f.calls.length,r=await f.run(['shadow','status',...(detail?['--session',session.sessionId]:[]),...(json?['--json']:[])]);
  assert.equal(r.code,1,JSON.stringify({reason,detail,r}));assert.match(r.stderr,/Shadow status is unavailable/);assert.equal(r.stdout,'');assert.equal(f.calls.length,before+1);
  assert.deepEqual([f.calls.at(-1).method,f.calls.at(-1).url,f.calls.at(-1).body],['GET','/api/projects/project_a/shadow'+(detail?'/'+session.sessionId:''),'']);
 }
});
for(const json of [false,true])test(`shadow CLI enforces reviewed canonical unique read policies before ${json?'JSON':'human'} output`,async t=>{
 const f=await fixture(t),invalid=[{readPaths:['/a//b']},{readPaths:['/a/./b']},{readPaths:['/a/../b']},{readPaths:['/%61']},{readPaths:['/a?b']},{readPaths:['/a#b']},{readPaths:['/a b']},{readPaths:['/é']},{readPaths:['/a\\b']},{readPaths:['/healthz','/healthz']},{methods:['GET','GET']},{methods:['HEAD','HEAD']},{methods:['get']}];
 for(const changed of invalid)for(const detail of [false,true]){
  const value=detail?{ok:true,enabled:false,epoch:31,session:{...session,policy:{...session.policy,...changed}}}:{...payload,policy:{...payload.policy,...changed}};f.reply(value);
  const before=f.calls.length,r=await f.run(['shadow','status',...(detail?['--session',session.sessionId]:[]),...(json?['--json']:[])]);
  assert.equal(r.code,1,JSON.stringify({changed,detail,r}));assert.match(r.stderr,/Shadow status is unavailable/);assert.equal(r.stdout,'');assert.equal(f.calls.length,before+1);
  assert.deepEqual([f.calls.at(-1).method,f.calls.at(-1).url,f.calls.at(-1).body],['GET','/api/projects/project_a/shadow'+(detail?'/'+session.sessionId:''),'']);
 }
});
test('shadow CLI preserves bounded EOF observations with later unknown outcomes and canonical read policies',async t=>{
 const f=await fixture(t),reads={readPaths:['/','/.well-known/ready','/_ready/~ping','/v1.0/A_1-b','/'+'a'.repeat(255)].sort(),methods:['GET','HEAD']};
 for(const reason of ['content-type-invalid','authority-lost'])for(const detail of [false,true])for(const json of [false,true]){
  const row={...session,policy:{...session.policy,...reads},report:oneUnknownReport(reason)},value=detail?{ok:true,enabled:false,epoch:31,session:row}:{...payload,policy:{...payload.policy,...reads},sessions:[row]};f.reply(value);
  const before=f.calls.length,r=await f.run(['shadow','status',...(detail?['--session',session.sessionId]:[]),...(json?['--json']:[])]);
  assert.equal(r.code,0,r.stderr);if(json)assert.deepEqual(JSON.parse(r.stdout),value);else{assert.match(r.stdout,/1 both complete/);assert.ok(r.stdout.includes(reason))}assert.equal(f.calls.length,before+1);
  assert.deepEqual([f.calls.at(-1).method,f.calls.at(-1).url,f.calls.at(-1).body],['GET','/api/projects/project_a/shadow'+(detail?'/'+session.sessionId:''),'']);
 }
});


for(const version of[1,2])test('linked CLI consumes actual native v'+version+' retained pages and exact leading-ID detail',{timeout:60000},async t=>{
 const native=await nativeOperatorHistory(t,{version,maximumPolicy:version===2}),before=native.retained(),first=await native.status(),f=await fixture(t,native.f);
 const list=await f.run(['shadow','status','--json']);assert.equal(list.code,0,list.stderr);assert.deepEqual(JSON.parse(list.stdout),first);t.diagnostic(JSON.stringify({version,nativeBodyBytes:Buffer.byteLength(JSON.stringify(first)),stdoutBytes:Buffer.byteLength(list.stdout),sessions:first.sessions.length}));assert.equal(first.sessions.length,20);assert.ok(first.nextBefore.length<=512);
 const row=first.sessions[0];assert.match(row.sessionId,/^[-_]/);assert.equal(row.reportAvailable,true);assert.equal(row.report.protocol,version===2?2:undefined);
 const detail=await f.run(['shadow','status','--session',row.sessionId,'--json']);assert.equal(detail.code,0,detail.stderr);assert.deepEqual(JSON.parse(detail.stdout),await native.status('/'+row.sessionId));
 const compact=await f.run(['shadow','status','--session',native.ids[0].sessionId,'--json']);assert.equal(compact.code,0,compact.stderr);assert.equal(JSON.parse(compact.stdout).session.reportAvailable,false);assert.equal(JSON.parse(compact.stdout).session.report,null);
 if(version===2){const closed=await f.run(['shadow','status','--json'],{closeOutput:true});assert.equal(closed.code,1);assert.match(closed.stderr,/EPIPE|broken pipe/i)}
 assert.equal(native.retained(),before,'Actual operator GETs cannot mutate native retained history or provider controls.');
});

test('shadow CLI closed v2 DTO validation preserves lower bounds and refuses malformed status before publication',async t=>{
 const f=await fixture(t),good=versionedPayload();f.reply(good);const accepted=await f.run(['shadow','status','--json']);assert.equal(accepted.code,0,accepted.stderr);assert.deepEqual(JSON.parse(accepted.stdout),good);
 const human=await f.run(['shadow','status']);assert.equal(human.code,0,human.stderr);assert.match(human.stdout,/lower bounds/);assert.match(human.stdout,/2147483647/);
 for(const[name,value]of malformedStatuses()){f.reply(value);const before=f.calls.length,result=await f.run(['shadow','status','--json']);assert.equal(result.code,1,name);assert.equal(result.stdout,'',name);assert.equal(f.calls.length,before+1,name);assert.match(result.stderr,/unavailable/,name)}
});
