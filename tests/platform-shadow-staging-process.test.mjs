import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {linuxProcessBirth} from '../dist/platform-supervisor.js';
import {openStrictArtifactS3} from './fixtures/strict-artifact-s3.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

const origin='https://stage.example.test',pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms))])}finally{clearTimeout(timer)}}
async function until(check,label,ms=10000){const end=performance.now()+ms;while(performance.now()<end){const value=await check();if(value)return value;await pause(20)}throw new Error('Timed out: '+label)}
async function absent(pid,birth){try{return await linuxProcessBirth(pid)!==birth}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return true;throw error}}
async function fences(directory){try{return await readdir(directory)}catch(error){if(error.code==='ENOENT')return[];throw error}}
function artifact(){const text='export const unusedUpload = true;';return gzipSync(JSON.stringify({protocol:'clank-deploy/1',config:{version:1,entry:'server.mjs',include:['server.mjs','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:2000},env:{}},provenance:{builder:'clank-cli/1',frameworkVersion:'0.24.0',nodeVersion:process.version,sourceRevision:'stage-process-proof'},files:[{path:'server.mjs',size:Buffer.byteLength(text),sha256:hash(text),mode:420,content:Buffer.from(text).toString('base64')}]}))}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-stage-process-')),dataDirectory=join(root,'platform'),children=[],guardians=[],held=[],release=gate();
  let ports,server,sql;
  // Cleanup is registered before the first owned child. Uncertain cleanup retains
  // the directory and port lease; never erase live guardian recovery records.
  t.after(async()=>{
    release.resolve();await bounded(Promise.all(held.map(entry=>entry.settled)) ,15000,'owned late native server writes');
    for(const entry of children){
      if(entry.child.exitCode===null&&entry.child.signalCode===null){
        if(await absent(entry.child.pid,entry.birth))throw new Error('Owned coordinator identity changed; preserve '+root);
        entry.rpc({kind:'stop'}).catch(()=>{});
        try{await bounded(entry.exited,10000,'graceful owned coordinator close')}
        catch{if(!await absent(entry.child.pid,entry.birth))entry.child.kill('SIGKILL');await bounded(entry.exited,5000,'owned cleanup SIGKILL')}
      }
      assert.ok(await absent(entry.child.pid,entry.birth),'Captured coordinator must be absent before deleting evidence.');
    }
    await until(async()=>!(await fences(join(dataDirectory,'supervisor-guardians'))).length&&!(await fences(join(dataDirectory,'runtime-guardians'))).length,'all owned guardian fences removed',10000);
    for(const guardian of guardians)await until(async()=>{
      try{const fields=(await readFile('/proc/'+guardian.pid+'/stat','utf8')).split(') ').at(-1).split(' ');return fields[19]!==guardian.birth||['Z','X'].includes(fields[0])}
      catch(error){if(['ENOENT','ESRCH'].includes(error.code))return true;throw error}
    },'captured guardian identity is dead',5000);
    sql?.close();await server?.close();await rm(root,{recursive:true,force:true});await ports?.release();
  });
  ports=await reservePlatformTestPorts();server=await openStrictArtifactS3(join(root,'objects'));
  server.hooks.put=async(key,bytes,metadata,commit)=>{
    const settled=gate(),entry={key,bytes:Buffer.from(bytes),settled:settled.promise};held.push(entry);
    try{await release.promise;entry.metadata=await commit();return entry.metadata}
    finally{settled.resolve()}
  };
  const options={dataDirectory,origin,endpoint:server.endpoint,portStart:ports.start,portEnd:ports.end};
  async function start(){
    const child=fork(new URL('./fixtures/platform-shadow-staging-controller.mjs',import.meta.url),[],{env:{...process.env,CLANK_STAGE_PROCESS_OPTIONS:JSON.stringify(options)},stdio:['ignore','pipe','pipe','ipc']});
    let output='',sequence=0,readyResolve,readyReject;const pending=new Map();
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});ready.catch(()=>{});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{
      const error=new Error('Owned coordinator exited before response: '+JSON.stringify({code,signal}));readyReject(error);
      for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error)}pending.clear();resolve({code,signal});
    }));
    const entry={child,exited,birth:null,rpc:null};children.push(entry);
    for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));
    child.on('error',readyReject);
    child.on('message',message=>{
      if(message?.kind==='ready'){readyResolve(message);return}
      const request=pending.get(message?.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(new Error(message.error));else request.resolve(message);
    });
    entry.rpc=message=>new Promise((resolve,reject)=>{
      if(child.exitCode!==null||child.signalCode!==null)return reject(new Error('Owned coordinator already exited.'));
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Owned IPC response deadline.'))},70000);
      pending.set(id,{resolve,reject,timer});child.send({...message,id},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error)}});
    });
    entry.birth=await linuxProcessBirth(child.pid);
    const initial=await bounded(ready,45000,'actual child readiness: '+output);assert.equal(initial.pid,child.pid);assert.equal(initial.birth,entry.birth);
    return Object.assign(entry,{ready:initial,async status(){return(await entry.rpc({kind:'status'})).status},async handle(request){
      const reply=await entry.rpc({kind:'request',url:request.url,method:request.method,headers:[...request.headers],body:request.body?Buffer.from(await request.arrayBuffer()).toString('base64'):null});
      return new Response(Buffer.from(reply.body,'base64'),{status:reply.status,headers:reply.headers});
    }});
  }
  const captureGuardian=async entry=>{
    const names=await fences(join(dataDirectory,'supervisor-guardians'));let found=false;
    for(const name of names){const record=JSON.parse(await readFile(join(dataDirectory,'supervisor-guardians',name),'utf8'));if(record.controllerPid!==entry.child.pid)continue;assert.equal(record.controllerBirth,entry.birth);assert.equal(record.phase,'armed');assert.ok(Number.isSafeInteger(record.guardianPid));const captured={pid:record.guardianPid,birth:await linuxProcessBirth(record.guardianPid)};guardians.push(captured);found=true;}
    assert.ok(found,'The actual leader must have an armed native guardian.');
  };
  const first=await start();assert.equal(first.ready.status.state,'leader');await captureGuardian(first);
  sql=new DatabaseSync(join(dataDirectory,'control.sqlite'));sql.exec('PRAGMA busy_timeout=5000');
  const rows=()=>{sql.prepare('SELECT count(*) FROM clank_platform_releases').get();return sql.prepare("SELECT * FROM clank_platform_releases WHERE purpose='shadow-upload' ORDER BY project_id").all()};
  return{root,dataDirectory,first,start,sql,rows,server,held,release,captureGuardian,guardians};
}
function request(path,{body,auth,method=body===undefined?'GET':'POST',headers={}}={}){return new Request(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...(auth?{cookie:auth.cookie,'x-clank-csrf':auth.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})}
async function call(controller,path,options={},expected=200){const response=await controller.handle(request(path,options)),body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body}
async function fresh(controller,sql,auth){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id='passkey-'+crypto.randomUUID(),credentialId=Buffer.from(id).toString('base64url');
  // The sole fixture write registers a real signing key. All authority renewal,
  // staging transitions, timestamps and admission are actual platform operations.
  sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(id,credentialId,auth.user.id,'Native process key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const started=await call(controller,'/__clank/auth/reauthenticate/passkey/start',{body:{},auth});
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update('stage.example.test').digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  await call(controller,'/__clank/auth/reauthenticate/passkey/finish',{body:{challengeId:started.challengeId,challenge:started.options.challenge,credential},auth});
}
async function stage(controller,project,auth,bytes,key){const response=await controller.handle(new Request(origin+`/api/projects/${project.id}/releases/stage`,{method:'POST',headers:{origin,cookie:auth.cookie,'x-clank-csrf':auth.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':key},body:bytes}));return{status:response.status,body:await response.json()}}

test('actual coordinator SIGKILL preserves two submitted uploads across native takeover and late HTTP commits',{timeout:100000},async t=>{
  const f=await fixture(t),first=f.first;
  const registration=await first.handle(request('/__clank/auth/register',{body:{email:'stage-crash-owner@example.test',password:'correct horse battery staple',profile:{name:'Stage crash owner'}}}));
  const account=await registration.json();assert.equal(registration.status,201);const auth={cookie:registration.headers.get('set-cookie').split(';')[0],csrf:account.csrfToken,user:account.user};
  const projects=[];for(const name of['Crash one','Crash two','Capacity probe'])projects.push((await call(first,'/api/projects',{body:{name},auth},201)).project);
  await fresh(first,f.sql,auth);const bytes=artifact(),keys=['shadow-crash-attempt-0001','shadow-crash-attempt-0002'];
  const pending=projects.slice(0,2).map((project,index)=>stage(first,project,auth,bytes,keys[index]));const settled=Promise.allSettled(pending);
  await until(()=>f.held.length===2,'two fully received native conditional PUTs');
  const before=f.rows();assert.equal(before.length,2);const receipts=before.map(row=>JSON.parse(row.upload_publication_receipt));
  assert.equal(new Set(receipts.map(receipt=>receipt.attemptId)).size,2);
  for(const row of before){const receipt=JSON.parse(row.upload_publication_receipt);assert.equal(row.status,'uploading');assert.equal(row.artifact_available,0);assert.equal(row.storage_bytes,bytes.length);assert.equal(receipt.phase,'submitted');assert.equal(receipt.projectId,row.project_id);assert.equal(receipt.releaseId,row.id);assert.equal(receipt.artifactSha256,hash(bytes));assert.equal(receipt.artifactBytes,bytes.length);assert.equal(receipt.key,row.runner_artifact_key)}
  const oldLease=f.sql.prepare('SELECT epoch,owner,controller_pid,controller_birth,expires_at,updated_at FROM clank_platform_supervisor_lease WHERE singleton=1').get();
  assert.equal(oldLease.controller_pid,first.child.pid);assert.equal(oldLease.controller_birth,first.birth);
  const noEffects=async()=>{
    assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_provider_generations').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_deployment_operations').get().n,0);
    for(const project of projects){assert.equal(f.sql.prepare('SELECT active_release_id FROM clank_platform_projects WHERE id=?').get(project.id).active_release_id,null);assert.deepEqual(await fences(join(f.dataDirectory,'projects',project.id)),[])}
    assert.deepEqual(await fences(join(f.dataDirectory,'runtime-guardians')),[]);
  };
  await noEffects();for(const row of before)assert.equal(await f.server.nativeStore.get(row.runner_artifact_key),null);
  for(const item of f.server.requests.filter(item=>item.method==='PUT')){assert.equal(item.headers['if-none-match'],'*');assert.match(item.headers.authorization,/^AWS4-HMAC-SHA256 /);assert.equal(item.bytes,bytes.length)}
  assert.equal(await linuxProcessBirth(first.child.pid),first.birth);assert.ok(first.child.kill('SIGKILL'));
  const killed=await bounded(first.exited,5000,'actual owned SIGKILL exit');assert.deepEqual(killed,{code:null,signal:'SIGKILL'});assert.ok(await absent(first.child.pid,first.birth));
  const interrupted=await bounded(settled,5000,'interrupted requests reject');assert.deepEqual(interrupted.map(result=>result.status),['rejected','rejected']);
  const takeoverStarted=performance.now(),second=await f.start();await until(async()=> (await second.status()).state==='leader','normal successor native leader admission',45000);
  await f.captureGuardian(second);
  const newLease=f.sql.prepare('SELECT epoch,owner,controller_pid,controller_birth,expires_at,updated_at FROM clank_platform_supervisor_lease WHERE singleton=1').get();
  assert.equal(newLease.controller_pid,second.child.pid);assert.equal(newLease.controller_birth,second.birth);assert.ok(newLease.epoch>oldLease.epoch);assert.notEqual(newLease.owner,oldLease.owner);
  assert.ok(newLease.updated_at>=oldLease.expires_at,'Takeover must follow actual retained lease expiry.');
  const refused=async()=>{
    for(let index=0;index<2;index++){
      const project=projects[index],row=before.find(row=>row.project_id===project.id),retry=await stage(second,project,auth,bytes,keys[index]);
      assert.equal(retry.status,409,JSON.stringify(retry));assert.equal(retry.body.error.code,'RELEASE_UPLOAD_UNCERTAIN');
      assert.equal((await call(second,`/api/projects/${project.id}/releases/${row.id}`,{method:'DELETE',body:{confirmation:`delete-release ${project.slug} ${row.id}`},auth},409)).error.code,'RELEASE_UPLOAD_UNCERTAIN');
      assert.equal((await call(second,`/api/projects/${project.id}`,{method:'DELETE',body:{confirmation:`delete-site ${project.slug}`,acknowledgeDataLoss:true},auth},409)).error.code,'RELEASE_UPLOAD_UNCERTAIN');
    }
    const capacity=await stage(second,projects[2],auth,bytes,'shadow-crash-attempt-0003');assert.equal(capacity.status,429,JSON.stringify(capacity));assert.equal(capacity.body.error.code,'RELEASE_UPLOAD_BUSY');
    assert.deepEqual(f.rows(),before,'Unknown receipts and original byte accounting survive every refusal.');
    assert.equal(f.rows().reduce((sum,row)=>sum+row.storage_bytes,0),2*bytes.length);assert.equal(f.server.requests.filter(item=>item.method==='PUT').length,2);assert.equal(f.server.requests.filter(item=>item.method==='DELETE').length,0);await noEffects();
  };
  await refused();f.release.resolve();await bounded(Promise.all(f.held.map(entry=>entry.settled)),10000,'late server commits after coordinator death');
  for(const row of before){const actual=await f.server.nativeStore.get(row.runner_artifact_key);assert.ok(actual);assert.deepEqual(Buffer.from(actual.bytes),bytes);assert.equal(actual.metadata.sha256,hash(bytes));assert.ok(f.held.find(entry=>entry.key===row.runner_artifact_key).metadata)}
  await refused();assert.ok(await absent(first.child.pid,first.birth));
  t.diagnostic(JSON.stringify({runtime:process.version,first:{pid:first.child.pid,birth:first.birth,...killed},successor:{pid:second.child.pid,birth:second.birth,epoch:newLease.epoch},oldEpoch:oldLease.epoch,takeoverMs:performance.now()-takeoverStarted,leaseExpiredBeforeAdmission:newLease.updated_at>=oldLease.expires_at,uploads:before.map(row=>({projectId:row.project_id,releaseId:row.id,artifactBytes:row.artifact_bytes,digest:row.digest,receiptHash:hash(row.upload_publication_receipt),phase:JSON.parse(row.upload_publication_receipt).phase})),guardians:f.guardians,nativePuts:2,nativeDeletes:0,retainedBytes:2*bytes.length,lateObjectDigest:hash(bytes)}));
});
