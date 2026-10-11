import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fork} from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {openPlatform} from '../dist/platform.js';
import {createS3ObjectStore} from '../dist/object-storage.js';
import {openStrictArtifactS3} from './fixtures/strict-artifact-s3.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

const origin='https://stage.example.test';
const hash=value=>createHash('sha256').update(value).digest('hex');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,ms=10000){const end=performance.now()+ms;while(performance.now()<end){const value=await check();if(value)return value;await pause(10)}throw new Error('Timed out: '+label)}
function artifact(text='export const unusedUpload = true;'){
  return gzipSync(JSON.stringify({protocol:'clank-deploy/1',config:{version:1,entry:'server.mjs',include:['server.mjs','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:2000},env:{}},provenance:{builder:'clank-cli/1',frameworkVersion:'0.24.0',nodeVersion:process.version,sourceRevision:'stage-proof'},files:[{path:'server.mjs',size:Buffer.byteLength(text),sha256:hash(text),mode:420,content:Buffer.from(text).toString('base64')}]}));
}
async function fixture(t,{objects=false,options={},fixedProjectId,adapterKind}={}){
  const root=await mkdtemp(join(tmpdir(),'clank-stage-')),ports=await reservePlatformTestPorts(),errors=[];
  let platform,sql,objectServer;
  try{
    objectServer=objects?await openStrictArtifactS3(join(root,'object-store')):null;
    const nativeStore=objectServer?.nativeStore??null,hooks=objectServer?.hooks??{};
    const genuineStore=objectServer?createS3ObjectStore({endpoint:objectServer.endpoint,region:'test-region',bucket:'stage-bucket',pathStyle:true,accessKeyId:'stage-fixture',secretAccessKey:'stage-fixture-secret',timeoutMs:120000,retries:2,...(adapterKind==='custom-fetch'?{fetch:globalThis.fetch}:{})}):null;
    const store=adapterKind==='wrapper'?{...genuineStore}:adapterKind==='proxy'?new Proxy(genuineStore,{}):genuineStore;
    const settings={dataDirectory:join(root,'platform'),publicUrl:origin,signup:true,backups:{intervalMs:false},appPortStart:ports.start,appPortEnd:ports.end,
      supervisor:{configurationId:'shadow-stage-native',configurationRevision:1,leaseMs:30000,pollIntervalMs:50},onError:error=>errors.push(error.stack ?? String(error)),
      ...(store?{deploymentAgents:{registrationToken:'shadow-stage-native-registration-123456',artifacts:{namespace:'stage-test',store}}}:{}),...options};
    platform=await openPlatform(settings);assert.equal(platform.supervisor().state,'leader');
    sql=new DatabaseSync(join(root,'platform/control.sqlite'));sql.exec('PRAGMA busy_timeout=5000');
    const request=(path,{body,method=body===undefined?'GET':'POST',auth,headers={}}={})=>new Request(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...(auth?{cookie:auth.cookie,'x-clank-csrf':auth.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const json=async(path,input={},expected=200)=>{const response=await platform.handle(request(path,input)),value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value};
    const register=async(email='stage-owner@example.test')=>{const response=await platform.handle(request('/__clank/auth/register',{body:{email,password:'correct horse battery staple',profile:{name:'Stage owner'}}})),result=await response.json();assert.equal(response.status,201,JSON.stringify(result));return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:result.csrfToken,user:result.user,session:result.session}};
    const owner=await register();
    const fresh=async(auth=owner)=>{
      const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id='passkey-'+crypto.randomUUID(),credentialId=Buffer.from(id).toString('base64url');
      sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(id,credentialId,auth.user.id,'Native test key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
      const started=await json('/__clank/auth/reauthenticate/passkey/start',{body:{},auth});
      const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin,crossOrigin:false}));
      const data=Buffer.concat([createHash('sha256').update('stage.example.test').digest(),Buffer.from([5,0,0,0,1])]);
      const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
      await json('/__clank/auth/reauthenticate/passkey/finish',{body:{challengeId:started.challengeId,challenge:started.options.challenge,credential},auth});
    };
    const create=async(name='Upload only')=>(await json('/api/projects',{body:{name},auth:owner},201)).project;
    const project=await create();
    if(fixedProjectId){sql.prepare('UPDATE clank_platform_projects SET id=? WHERE id=?').run(fixedProjectId,project.id);project.id=fixedProjectId;}
    const stage=async(bytes=artifact(),key='shadow-stage-attempt-0001',{auth=owner,projectId=project.id,headers={},body=bytes,operation='releases/stage',signal}={})=>{
      const request=new Request(`${origin}/api/projects/${projectId}/${operation}`,{method:'POST',headers:{origin,cookie:auth.cookie,'x-clank-csrf':auth.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':key,...headers},body,...(body instanceof ReadableStream?{duplex:'half'}:{}),...(signal?{signal}:{})});
      const response=await platform.handle(request);return{status:response.status,body:await response.json()};
    };
    const f={root,sql,owner,project,hooks,errors,store,nativeStore,fresh,create,json,register,stage,requests:objectServer?.requests,get platform(){return platform},
      raw:()=>{sql.prepare('SELECT count(*) FROM clank_platform_releases').get();return sql.prepare('SELECT * FROM clank_platform_releases WHERE project_id=?').all(project.id)},
      async reopen(extra={}){await platform.close();Object.assign(settings,extra);platform=await openPlatform(settings);assert.equal(platform.supervisor().state,'leader')},
      async refusedRestart(){
        await platform.close();const {onError,...serializable}=settings;
        const child=fork(new URL('./fixtures/shadow-staging-reopen.mjs',import.meta.url),[],{env:{...process.env,CLANK_STAGE_REOPEN_OPTIONS:JSON.stringify(serializable)},stdio:['ignore','pipe','pipe','ipc']});
        let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-16384));
        const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let timer;
        try{const result=await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Corrupt startup did not refuse: '+output)),10000))]);assert.equal(output.includes('UNEXPECTED_READY'),false,output);return{...result,output}}
        finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited}
      }};
    t.after(async()=>{if(errors.length)t.diagnostic(JSON.stringify(errors));await platform.close();await objectServer?.close();sql.close();await ports.release();await rm(root,{recursive:true,force:true});});return f;
  }catch(error){await platform?.close();await objectServer?.close();sql?.close();await ports.release();await rm(root,{recursive:true,force:true});throw error}
}
const accepted=result=>{assert.equal(result.status,201,JSON.stringify(result));return result.body.release};

test('staging requires fresh human passkey proof even when general freshness is optional',async t=>{
  const f=await fixture(t);const denied=await f.stage();assert.equal(denied.status,403);assert.equal(denied.body.error.code,'FRESH_AUTH_REQUIRED');assert.equal(f.raw().length,0);
  await f.fresh();assert.equal((await f.stage(undefined,undefined,{headers:{origin:'https://other.example'}})).status,403);
  assert.equal((await f.stage(undefined,undefined,{headers:{'x-clank-csrf':'invalid'}})).status,403);
  const started=await f.json('/api/device/start',{body:{clientName:'Stage CLI'}},201);await f.json('/api/device/approve',{body:{code:started.userCode},auth:f.owner});
  const token=await f.json('/api/device/token',{body:{deviceCode:started.deviceCode}});
  const bearer=await f.stage(undefined,undefined,{headers:{authorization:'Bearer '+token.accessToken}});assert.equal(bearer.status,403);assert.equal(bearer.body.error.code,'HUMAN_AUTH_REQUIRED');
  f.sql.prepare('UPDATE clank_auth_sessions SET authenticated_at=? WHERE id=?').run(Date.now()-300001,f.owner.session.id);
  assert.equal((await f.stage()).status,403);assert.equal(f.raw().length,0);
});

test('local staging durably retains exact original bytes with no runtime, data, generation or traffic activation',async t=>{
  const f=await fixture(t);await f.fresh();const bytes=artifact(),release=accepted(await f.stage(bytes));
  assert.equal(release.purpose,'shadow-upload');assert.equal(release.projectId,f.project.id);assert.equal(release.status,'staged');assert.equal(release.artifactAvailable,true);assert.equal(release.artifactBytes,bytes.length);assert.equal(release.storageBytes,bytes.length);assert.equal(release.digest,hash(bytes));assert.equal(release.activatedAt,null);assert.equal(release.providerGeneration,null);assert.equal('idempotencyKey' in release,false);
  assert.deepEqual(await readFile(join(f.root,'platform/projects',f.project.id,'artifacts',release.id+'.clank.gz')),bytes);
  assert.deepEqual(await readdir(join(f.root,'platform/projects',f.project.id)),['artifacts']);
  const row=f.raw()[0];assert.equal(row.runtime_bytes,0);assert.equal(row.snapshot_bytes,0);assert.equal(row.backup_path,null);assert.match(row.upload_request_digest,/^[a-f0-9]{64}$/);assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,3);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_provider_generations').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_deployment_operations').get().n,0);
  assert.equal(f.sql.prepare('SELECT active_release_id FROM clank_platform_projects WHERE id=?').get(f.project.id).active_release_id,null);
  assert.equal(accepted(await f.stage(bytes)).id,release.id);assert.equal(f.raw().length,1);
  await f.reopen();assert.equal(accepted(await f.stage(bytes)).id,release.id);assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,3);
  const listing=await f.json(`/api/projects/${f.project.id}/releases`,{auth:f.owner});assert.equal(listing.releases[0].purpose,'shadow-upload');assert.deepEqual(f.errors,[]);
});

test('stage keys reject different artifacts, raw attestations and ordinary deployment purpose before activation',async t=>{
  const f=await fixture(t);await f.fresh();const bytes=artifact(),release=accepted(await f.stage(bytes));
  for(const result of [await f.stage(artifact('export const changed = true;')),await f.stage(bytes,undefined,{headers:{'x-clank-release-attestation':'ignored-but-bound'}}),await f.stage(bytes,undefined,{operation:'releases'})]){
    assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'IDEMPOTENCY_ARTIFACT_MISMATCH');
  }
  assert.equal(f.raw().length,1);assert.equal(f.raw()[0].id,release.id);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_deployment_operations').get().n,0);
});

test('lost object publication acknowledgment permanently preserves submitted quota without a replacement write',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();let puts=0;
  f.hooks.put=async(key,bytes,options,publish)=>{puts++;await publish();throw new Error('Actual durable write lost its response')};
  const first=await f.stage();assert.equal(first.status,500,JSON.stringify(first));const row=f.raw()[0];assert.equal(row.status,'uploading');assert.equal(row.artifact_available,0);assert.equal(row.storage_bytes,row.artifact_bytes);
  assert.equal((await f.json(`/api/projects/${f.project.id}/releases/${row.id}`,{method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${row.id}`},auth:f.owner},409)).error.code,'RELEASE_UPLOAD_UNCERTAIN');
  const deletion=await f.json(`/api/projects/${f.project.id}`,{method:'DELETE',body:{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true},auth:f.owner},409);assert.equal(deletion.error.code,'RELEASE_UPLOAD_UNCERTAIN');
  delete f.hooks.put;const result=await f.stage();assert.equal(result.status,409);assert.equal(result.body.error.code,'RELEASE_UPLOAD_UNCERTAIN');assert.equal(puts,1);assert.equal(f.raw().length,1);assert.equal(JSON.parse(f.raw()[0].upload_publication_receipt).phase,'submitted');
});

for(const fault of ['ignore-reservation','alter-publication','lose-project-lease'])test(`native ${fault} rolls back rather than admitting an upload-only artifact`,async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();
  const trigger=fault==='ignore-reservation'?"CREATE TRIGGER stage_fault BEFORE INSERT ON clank_platform_releases WHEN new.purpose='shadow-upload' BEGIN SELECT RAISE(IGNORE); END":fault==='alter-publication'?"CREATE TRIGGER stage_fault AFTER UPDATE OF artifact_available ON clank_platform_releases WHEN new.purpose='shadow-upload' BEGIN UPDATE clank_platform_releases SET digest=printf('%064d',1) WHERE id=new.id; END":"CREATE TRIGGER stage_fault AFTER UPDATE OF artifact_available ON clank_platform_releases WHEN new.purpose='shadow-upload' BEGIN DELETE FROM clank_distributed_leases WHERE resource='project:'||new.project_id; END";
  f.sql.exec(trigger);const result=await f.stage();assert.notEqual(result.status,201,JSON.stringify(result));
  if(fault==='ignore-reservation')assert.equal(f.raw().length,0);else{assert.equal(f.raw()[0].status,'uploading');assert.equal(f.raw()[0].artifact_available,0);assert.equal(f.raw()[0].digest,hash(artifact()))}
  f.sql.exec('DROP TRIGGER stage_fault');accepted(await f.stage());
});

for(const revocation of ['lease','session','permission'])test(`a held native object write cannot publish after current ${revocation} authority is revoked`,async t=>{
  const f=await fixture(t,{objects:true});let auth=f.owner;
  if(revocation==='permission'){
    auth=await f.register('stage-deployer@example.test');const invitation=await f.json(`/api/organizations/${f.project.organizationId}/invitations`,{body:{email:auth.user.email,role:'viewer'},auth:f.owner},201);
    await f.json('/api/invitations/accept',{body:{token:invitation.invitation.token},auth});await f.json(`/api/projects/${f.project.id}/members/${auth.user.id}`,{method:'PUT',body:{permissions:['read','deploy']},auth:f.owner});
  }
  await f.fresh(auth);const entered=gate(),release=gate();
  f.hooks.put=async(key,bytes,options,publish)=>{entered.resolve();await release.promise;return publish()};
  const pending=f.stage(undefined,undefined,{auth});await entered.promise;
  try{
    if(revocation==='lease')f.sql.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:'+f.project.id);
    if(revocation==='session')f.sql.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(auth.session.id);
    if(revocation==='permission')await f.json(`/api/projects/${f.project.id}/members/${auth.user.id}`,{method:'PUT',body:{permissions:['read']},auth:f.owner});
  }finally{release.resolve()}
  const result=await pending;assert.ok([401,403,409].includes(result.status),JSON.stringify(result));assert.equal(f.raw()[0].status,'uploading');assert.equal(f.raw()[0].artifact_available,0);assert.equal(f.raw()[0].storage_bytes,artifact().length);
  assert.ok(await f.nativeStore.get(f.raw()[0].runner_artifact_key),'Already submitted durable publication is not claimed undone.');
  delete f.hooks.put;if(revocation==='lease'){const retry=await f.stage();assert.equal(retry.status,409);assert.equal(retry.body.error.code,'RELEASE_UPLOAD_UNCERTAIN')}
});

test('two occupied intake slots and a busy project reject immediately without queued writes',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const second=await f.create('Second upload'),third=await f.create('Third upload'),release=gate();let calls=0;
  f.hooks.put=async(key,bytes,options,publish)=>{calls++;await release.promise;return publish()};
  const first=f.stage();await until(()=>calls===1,'first submitted write');
  assert.equal((await f.stage()).body.error.code,'PROJECT_BUSY');
  const other=f.stage(undefined,'shadow-stage-attempt-0002',{projectId:second.id});await until(()=>calls===2,'second submitted write');
  const start=performance.now(),rejected=await f.stage(undefined,'shadow-stage-attempt-0003',{projectId:third.id});
  assert.equal(rejected.status,429,JSON.stringify(rejected));assert.ok(performance.now()-start<2000);assert.equal(calls,2);
  release.resolve();for(const result of await Promise.all([first,other]))accepted(result);
});

test('uncertain upload reservations count toward storage quota and remain visible',async t=>{
  const bytes=artifact(),f=await fixture(t,{objects:true,options:{limits:{releaseStorageBytesPerProject:bytes.length}}});await f.fresh();
  f.hooks.put=async()=>{throw new Error('Write outcome is uncertain')};assert.equal((await f.stage(bytes)).status,500);
  const result=await f.stage(bytes,'shadow-stage-another-0002');assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'RELEASE_STORAGE_LIMIT_REACHED');assert.equal(f.raw().length,1);
  const list=await f.json(`/api/projects/${f.project.id}/releases`,{auth:f.owner});assert.equal(list.releases[0].status,'uploading');assert.equal(list.releases[0].artifactAvailable,false);
  delete f.hooks.put;const retry=await f.stage(bytes);assert.equal(retry.status,409);assert.equal(retry.body.error.code,'RELEASE_UPLOAD_UNCERTAIN');
});

test('an available staged artifact is cleaned only after verified absence, while uncertain deletion preserves accounting',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const release=accepted(await f.stage()),request={method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${release.id}`},auth:f.owner};
  f.hooks.delete=async()=>true;
  const refused=await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,request,409);assert.equal(refused.error.code,'RELEASE_UPLOAD_UNCERTAIN');assert.equal(f.raw()[0].artifact_available,1);assert.equal(f.raw()[0].storage_bytes,artifact().length);
  delete f.hooks.delete;const cleaned=await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,request);assert.equal(cleaned.release.artifactAvailable,false);assert.equal(f.raw()[0].storage_bytes,0);
  assert.equal((await f.stage()).status,409);assert.equal(await f.nativeStore.get(f.raw()[0].runner_artifact_key),null);
});

for(const damage of ['partial','sentinel'])test(`staging refuses ${damage} native schema before protocol enrollment or upload effects`,async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();let puts=0;f.hooks.put=async(...args)=>{puts++;return args.at(-1)()};
  if(damage==='partial')f.sql.exec('CREATE TABLE clank_platform_shadow_state(singleton INTEGER PRIMARY KEY,protocol INTEGER NOT NULL,enrollment_id TEXT NOT NULL,schema_id TEXT NOT NULL) STRICT');
  else{
    f.sql.exec("ALTER TABLE clank_platform_projects ADD COLUMN shadow_replay_receipt TEXT; CREATE TABLE clank_platform_shadow_state(singleton INTEGER PRIMARY KEY,protocol INTEGER NOT NULL,enrollment_id TEXT NOT NULL,schema_id TEXT NOT NULL) STRICT; CREATE TABLE clank_platform_shadow_reports(project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key_digest TEXT NOT NULL,input_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,report_json TEXT,PRIMARY KEY(project_id,session_id),UNIQUE(project_id,idempotency_key_digest)) STRICT; INSERT INTO clank_platform_shadow_state VALUES(1,1,'invalid','clank-platform-shadow/1')");
  }
  const before=f.sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'clank_platform_shadow_%' ORDER BY name").all();
  assert.equal((await f.stage()).status,500);assert.equal(f.raw().length,0);assert.equal(puts,0);assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,1);assert.deepEqual(f.sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'clank_platform_shadow_%' ORDER BY name").all(),before);
});

test('the real sixty-second response deadline retains both slots until submitted native object writes actually settle',{timeout:80000},async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const second=await f.create('Timed second'),third=await f.create('Timed third'),release=gate();let calls=0;
  f.hooks.put=async(key,bytes,options,publish)=>{calls++;await release.promise;return publish()};
  const started=performance.now(),first=f.stage(),other=f.stage(undefined,'shadow-stage-timeout-0002',{projectId:second.id});
  try{
    await until(()=>calls===2,'both actual submitted object writes');
    const results=await Promise.all([first,other]);const elapsed=performance.now()-started;
    for(const result of results){assert.equal(result.status,408,JSON.stringify(result));assert.equal(result.body.error.code,'RELEASE_UPLOAD_INTERRUPTED')}
    assert.ok(elapsed>=59000&&elapsed<70000,`Actual deadline elapsed ${elapsed}`);
    const rows=f.sql.prepare("SELECT * FROM clank_platform_releases WHERE purpose='shadow-upload'").all();assert.equal(rows.length,2);for(const row of rows){assert.equal(row.status,'uploading');assert.equal(row.artifact_available,0);assert.equal(row.storage_bytes,row.artifact_bytes)}
    const denied=await f.stage(undefined,'shadow-stage-timeout-0003',{projectId:third.id});assert.equal(denied.status,429,JSON.stringify(denied));assert.equal(calls,2);
    release.resolve();await until(async()=>{for(const row of rows)if(!await f.nativeStore.get(row.runner_artifact_key))return false;return true},'submitted writes settle durably');
    assert.equal(f.sql.prepare("SELECT count(*) n FROM clank_platform_releases WHERE purpose='shadow-upload' AND artifact_available=1").get().n,0,'Late settlements have no publication authority.');
    delete f.hooks.put;await until(async()=>{const result=await f.stage();if(result.status===429||result.body.error?.code==='PROJECT_BUSY')return false;assert.equal(result.status,409);assert.equal(result.body.error.code,'RELEASE_UPLOAD_UNCERTAIN');return true},'fresh retry refuses permanent uncertainty after settlement');
    assert.equal(calls,2);t.diagnostic(JSON.stringify({elapsedMs:elapsed,submittedWrites:calls,retainedUploads:rows.length}));
  }finally{release.resolve();await Promise.allSettled([first,other])}
});

for(const id of ['_shadow_project_01','-shadow_project_02'])test(`native object staging accepts supported project identifier ${id}`,async t=>{
  const f=await fixture(t,{objects:true,fixedProjectId:id});await f.fresh();const release=accepted(await f.stage());assert.equal(release.projectId,id);assert.equal((await f.nativeStore.get(f.raw()[0].runner_artifact_key)).metadata.sha256,release.digest);
});

test('ordinary deployment replay remains compatible while upload-only IDs refuse rollback, promotion and channel activation',{timeout:45000},async t=>{
  const f=await fixture(t);await f.fresh();
  const bytes=artifact("import{createServer}from'node:http';const server=createServer((req,res)=>res.end('primary-still-active'));server.listen(Number(process.env.PORT),process.env.HOST);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));");
  const key='ordinary-stage-compat-0001',ordinary=accepted(await f.stage(bytes,key,{operation:'releases'}));assert.equal(ordinary.purpose,'deployment');
  assert.equal(accepted(await f.stage(bytes,key,{operation:'releases'})).id,ordinary.id);
  const changed=await f.stage(bytes,key,{operation:'releases',headers:{'x-clank-release-attestation':'different-captured-input'}});assert.equal(changed.status,409);assert.equal(changed.body.error.code,'IDEMPOTENCY_ARTIFACT_MISMATCH');
  f.sql.prepare('UPDATE clank_platform_releases SET upload_request_digest=NULL WHERE id=?').run(ordinary.id);
  assert.equal(accepted(await f.stage(bytes,key,{operation:'releases',headers:{'x-clank-release-attestation':'legacy-ignored-input'}})).id,ordinary.id);
  assert.equal((await f.stage(bytes,key)).status,409,'A legacy ordinary key still cannot replay across purpose.');
  const staged=accepted(await f.stage()),before=f.sql.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id);
  const rollback=await f.json(`/api/projects/${f.project.id}/rollback`,{body:{releaseId:staged.id,restoreData:false},auth:f.owner},409);assert.equal(rollback.error.code,'SHADOW_UPLOAD_ONLY');
  const target=await f.create('Promotion target');
  for(const [name,projectId] of [['development',f.project.id],['staging',target.id]])await f.json(`/api/projects/${f.project.id}/environments/${name}`,{method:'PUT',body:{projectId,expectedVersion:0},auth:f.owner});
  const pin=await f.json(`/api/projects/${f.project.id}/channels/stable`,{method:'PUT',body:{sourceEnvironment:'development',releaseId:staged.id,digest:staged.digest,expectedVersion:0},auth:f.owner},409);assert.equal(pin.error.code,'PROMOTION_ARTIFACT_UNAVAILABLE');
  const promote=await f.json(`/api/projects/${f.project.id}/environments/staging/promotions`,{body:{sourceEnvironment:'development',releaseId:staged.id,digest:staged.digest,expectedVersion:1,expectedActiveReleaseId:null,idempotencyKey:'stage-forbidden-promotion-01'},auth:f.owner},409);assert.equal(promote.error.code,'PROMOTION_ARTIFACT_UNAVAILABLE');
  assert.deepEqual(f.sql.prepare('SELECT active_release_id,active_generation FROM clank_platform_projects WHERE id=?').get(f.project.id),before);
  assert.equal(await(await fetch(`http://127.0.0.1:${f.project.port}/`)).text(),'primary-still-active');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_provider_generations').get().n,0);
});

test('bounded media, digest, body and intake validation refuse before upload intent',async t=>{
  const f=await fixture(t,{options:{maxArtifactBytes:1024}});await f.fresh();
  assert.equal((await f.stage(undefined,undefined,{headers:{'content-type':'application/json'}})).status,415);
  assert.equal((await f.stage(undefined,undefined,{headers:{'x-clank-content-sha256':'0'.repeat(64)}})).status,400);
  assert.equal((await f.stage(undefined,undefined,{headers:{'x-clank-release-attestation':'x'.repeat(12001)}})).status,400);
  assert.equal((await f.stage(Buffer.alloc(1025))).status,413);
  const invalid=await f.stage(Buffer.from('not-a-deployment'));assert.equal(invalid.status,422,JSON.stringify(invalid));assert.equal(f.raw().length,0);
});

test('ignored native cleanup accounting preserves the staged receipt after actual object absence',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const release=accepted(await f.stage()),key=f.raw()[0].runner_artifact_key;
  f.sql.exec("CREATE TRIGGER ignore_cleanup BEFORE UPDATE OF artifact_available ON clank_platform_releases WHEN new.purpose='shadow-upload' AND new.artifact_available=0 BEGIN SELECT RAISE(IGNORE); END");
  const request={method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${release.id}`},auth:f.owner};
  await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,request,500);assert.equal(await f.nativeStore.get(key),null);assert.equal(f.raw()[0].artifact_available,1);assert.equal(f.raw()[0].storage_bytes,artifact().length);
  f.sql.exec('DROP TRIGGER ignore_cleanup');await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,request);assert.equal(f.raw()[0].storage_bytes,0);
});

test('reopening cannot replay and clean an upload while its original native object write remains unsettled',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const entered=gate(),release=gate(),settled=gate();let calls=0;
  f.hooks.put=async(key,bytes,options,publish)=>{calls++;entered.resolve();await release.promise;try{return await publish()}finally{settled.resolve()}};
  const first=f.stage();await entered.promise;
  try{
    const reserved=f.raw()[0];await f.reopen();assert.equal((await first).status,408);
    delete f.hooks.put;
    const retry=await f.stage();
    if(retry.status===201){
      assert.equal(retry.body.release.id,reserved.id);
      await f.json(`/api/projects/${f.project.id}/releases/${reserved.id}`,{method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${reserved.id}`},auth:f.owner});
      assert.equal(await f.nativeStore.get(reserved.runner_artifact_key),null);
      assert.equal(f.raw()[0].storage_bytes,0);
    }
    release.resolve();await settled.promise;
    const retained=f.raw()[0],stored=await f.nativeStore.get(reserved.runner_artifact_key);
    t.diagnostic(JSON.stringify({retryStatus:retry.status,originalWriteCalls:calls,retainedStatus:retained.status,available:retained.artifact_available,reservedBytes:retained.storage_bytes,storedBytes:stored?.bytes.byteLength??0}));
    assert.equal(retry.status,409,'A successor cannot infer settlement or republish the original uncertain identity.');
    assert.equal(retained.status,'uploading');assert.equal(retained.artifact_available,0);assert.equal(retained.storage_bytes,reserved.artifact_bytes);
  }finally{release.resolve();await Promise.allSettled([first,settled.promise])}
});

test('project deletion preserves an available staged reservation when object deletion has no verified absence',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();accepted(await f.stage());const row=f.raw()[0];f.hooks.delete=async()=>true;
  const response=await f.platform.handle(new Request(`${origin}/api/projects/${f.project.id}`,{method:'DELETE',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify({confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true})}));
  const body=await response.json(),stored=await f.nativeStore.get(row.runner_artifact_key);
  t.diagnostic(JSON.stringify({status:response.status,storedBytes:stored?.bytes.byteLength??0,retainedReleases:f.raw().length}));
  assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.error.code,'PROJECT_STORAGE_UNSAFE');assert.equal(f.raw()[0].storage_bytes,row.artifact_bytes);assert.ok(stored);
});

for(const phase of ['submitted','acknowledged'])for(const mutation of ['ignore','alter','lease'])test(`native ${phase} ${mutation} cannot bypass the exact publication receipt`,async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();
  const timing=mutation==='ignore'?'BEFORE':'AFTER',body=mutation==='ignore'?'SELECT RAISE(IGNORE);':mutation==='alter'?"UPDATE clank_platform_releases SET upload_publication_receipt=json_set(upload_publication_receipt,'$.attemptId',printf('%064d',9)) WHERE id=new.id;":"DELETE FROM clank_distributed_leases WHERE resource='project:'||new.project_id;";
  f.sql.exec(`CREATE TRIGGER publication_fault ${timing} UPDATE OF upload_publication_receipt ON clank_platform_releases WHEN json_extract(new.upload_publication_receipt,'$.phase')='${phase}' BEGIN ${body} END`);
  const result=await f.stage();assert.notEqual(result.status,201,JSON.stringify(result));
  const row=f.raw()[0],receipt=JSON.parse(row.upload_publication_receipt);
  assert.equal(receipt.phase,phase==='submitted'?'reserved':'submitted');assert.equal(row.artifact_available,0);assert.equal(row.storage_bytes,artifact().length);
  assert.equal(f.requests.filter(request=>request.method==='PUT').length,phase==='submitted'?0:1);
  f.sql.exec('DROP TRIGGER publication_fault');
  if(phase==='submitted')accepted(await f.stage());else{const retry=await f.stage();assert.equal(retry.status,409);assert.equal(retry.body.error.code,'RELEASE_UPLOAD_UNCERTAIN');assert.equal(f.requests.filter(request=>request.method==='PUT').length,1)}
});

test('two permanently uncertain native uploads retain global capacity across reopen',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const second=await f.create('Unknown second'),third=await f.create('Blocked third');
  f.hooks.after=({response})=>response.destroy();
  for(const [project,key]of[[f.project,'unknown-global-first01'],[second,'unknown-global-second02']])assert.equal((await f.stage(undefined,key,{projectId:project.id})).status,500);
  assert.equal(JSON.parse(f.raw()[0].upload_publication_receipt).phase,'submitted');
  const rows=f.sql.prepare("SELECT * FROM clank_platform_releases WHERE purpose='shadow-upload'").all();assert.equal(rows.length,2);for(const row of rows)assert.equal(JSON.parse(row.upload_publication_receipt).phase,'submitted');
  await f.reopen();delete f.hooks.after;
  const result=await f.stage(undefined,'unknown-global-third03',{projectId:third.id});assert.equal(result.status,429,JSON.stringify(result));assert.equal(result.body.error.code,'RELEASE_UPLOAD_BUSY');assert.equal(f.requests.filter(request=>request.method==='PUT').length,2);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM clank_platform_releases WHERE purpose='shadow-upload'").get().n,2);
});

test('an acknowledged artifact recovers final publication failure without a second native PUT',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();
  f.sql.exec("CREATE TRIGGER publication_final BEFORE UPDATE OF artifact_available ON clank_platform_releases WHEN new.purpose='shadow-upload' AND new.artifact_available=1 BEGIN SELECT RAISE(IGNORE); END");
  assert.equal((await f.stage()).status,500);const row=f.raw()[0];assert.equal(JSON.parse(row.upload_publication_receipt).phase,'acknowledged');assert.equal(row.artifact_available,0);
  f.sql.exec('DROP TRIGGER publication_final');await f.reopen();const release=accepted(await f.stage());assert.equal(release.id,row.id);assert.equal(f.requests.filter(request=>request.method==='PUT').length,1);
});

test('receipt identity corruption rolls back cleanup even after genuine native deletion',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const release=accepted(await f.stage()),before=f.raw()[0];
  f.sql.exec("CREATE TRIGGER cleanup_receipt AFTER UPDATE OF artifact_available ON clank_platform_releases WHEN new.purpose='shadow-upload' AND new.artifact_available=0 BEGIN UPDATE clank_platform_releases SET upload_publication_receipt=json_set(upload_publication_receipt,'$.attemptId',printf('%064d',9)) WHERE id=new.id; END");
  await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,{method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${release.id}`},auth:f.owner},500);
  assert.equal(await f.nativeStore.get(before.runner_artifact_key),null);assert.deepEqual(f.raw()[0],before);
});

test('missing version-two publication schema is refused on native startup without bootstrap repair',async t=>{
  const f=await fixture(t);await f.fresh();accepted(await f.stage());assert.equal(JSON.parse(f.raw()[0].upload_publication_receipt).phase,'acknowledged');await f.platform.close();f.sql.exec('ALTER TABLE clank_platform_releases DROP COLUMN upload_publication_receipt');
  const before=f.sql.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();await assert.rejects(f.reopen(),{code:'SUPERVISOR_SHADOW_SCHEMA'});assert.deepEqual(f.sql.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),before);
});

for(const mutation of ['missing','duplicate','phase','bytes'])test(`malformed ${mutation} receipt refuses native startup without rewriting retained evidence`,async t=>{
  const f=await fixture(t);await f.fresh();accepted(await f.stage());await f.platform.close();const original=f.raw()[0],receipt=JSON.parse(original.upload_publication_receipt);
  assert.ok(original.upload_publication_receipt.startsWith('{'));
  const corrupt=mutation==='missing'?null:mutation==='duplicate'?'{"phase":"submitted",'+original.upload_publication_receipt.slice(1):JSON.stringify({...receipt,...(mutation==='phase'?{phase:'submitted'}:{artifactBytes:receipt.artifactBytes+1})});
  f.sql.prepare('UPDATE clank_platform_releases SET upload_publication_receipt=? WHERE id=?').run(corrupt,original.id);
  const before=f.raw()[0],result=await f.refusedRestart();assert.equal(result.signal,'SIGKILL',result.output);assert.match(result.output,/publication receipt|upload-only/);assert.deepEqual(f.raw()[0],before);assert.equal(f.sql.prepare('SELECT count(*) n FROM clank_platform_provider_generations').get().n,0);
});

test('lower intake limits preserve acknowledged receipts and actual artifact cleanup',async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();const release=accepted(await f.stage());
  await f.reopen({maxArtifactBytes:1});
  const list=await f.json(`/api/projects/${f.project.id}/releases`,{auth:f.owner});assert.equal(list.releases[0].artifactBytes,artifact().length);
  await f.json(`/api/projects/${f.project.id}/releases/${release.id}`,{method:'DELETE',body:{confirmation:`delete-release ${f.project.slug} ${release.id}`},auth:f.owner});assert.equal(f.raw()[0].storage_bytes,0);assert.equal(JSON.parse(f.raw()[0].upload_publication_receipt).artifactBytes,artifact().length);
});

for(const adapterKind of ['wrapper','proxy','custom-fetch'])test(`staging refuses ${adapterKind} storage before native enrollment or reservations`,async t=>{
  const f=await fixture(t,{objects:true,adapterKind});await f.fresh();const result=await f.stage();
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'RELEASE_STORAGE_INELIGIBLE');assert.equal(f.raw().length,0);assert.equal(f.requests.length,0);assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,1);assert.equal(f.sql.prepare("SELECT name FROM sqlite_schema WHERE name='clank_platform_shadow_state'").get(),undefined);
});

for(const objects of [false,true])test(`${objects?'S3':'local'} reserved publication never adopts or overwrites matching existing bytes`,async t=>{
  const f=await fixture(t,{objects});await f.fresh();f.sql.exec("CREATE TRIGGER reserve_only BEFORE UPDATE OF upload_publication_receipt ON clank_platform_releases BEGIN SELECT RAISE(IGNORE); END");
  assert.notEqual((await f.stage()).status,201);const row=f.raw()[0];assert.equal(JSON.parse(row.upload_publication_receipt).phase,'reserved');
  let target;if(objects)await f.nativeStore.put(row.runner_artifact_key,artifact(),{contentType:'application/vnd.clank.deploy+gzip'});else{target=join(f.root,'platform/projects',f.project.id,'artifacts',row.id+'.clank.gz');await mkdir(join(target,'..'),{recursive:true,mode:0o700});await writeFile(target,artifact(),{flag:'wx',mode:0o600})}
  f.sql.exec('DROP TRIGGER reserve_only');const result=await f.stage();assert.notEqual(result.status,201);assert.equal(JSON.parse(f.raw()[0].upload_publication_receipt).phase,'submitted');assert.equal(f.raw()[0].artifact_available,0);assert.equal(f.raw()[0].storage_bytes,artifact().length);
  if(objects){assert.equal(f.requests.filter(request=>request.method==='PUT').length,1);assert.equal(f.requests.find(request=>request.method==='PUT').status,412);assert.deepEqual(Buffer.from((await f.nativeStore.get(row.runner_artifact_key)).bytes),artifact())}else assert.deepEqual(await readFile(target),artifact());
});

test('ignored legacy schema upgrade rolls back column creation and permits a fresh exact native retry',async t=>{
  const f=await fixture(t);await f.fresh();
  f.sql.exec(`ALTER TABLE clank_platform_projects ADD COLUMN shadow_replay_receipt TEXT;
    CREATE TABLE clank_platform_shadow_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,enrollment_id TEXT NOT NULL,schema_id TEXT NOT NULL) STRICT;
    CREATE TABLE clank_platform_shadow_reports(project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key_digest TEXT NOT NULL,input_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,report_json TEXT,PRIMARY KEY(project_id,session_id),UNIQUE(project_id,idempotency_key_digest)) STRICT;`);
  f.sql.prepare('INSERT INTO clank_platform_shadow_state VALUES(1,1,?,?)').run(hash('legacy-enrollment'),'clank-platform-shadow/1');
  f.sql.exec('CREATE TRIGGER ignore_upgrade BEFORE UPDATE OF schema_id ON clank_platform_shadow_state BEGIN SELECT RAISE(IGNORE); END');
  assert.notEqual((await f.stage()).status,201);assert.equal(f.raw().length,0);assert.equal(f.sql.prepare('SELECT schema_id FROM clank_platform_shadow_state').get().schema_id,'clank-platform-shadow/1');assert.equal(f.sql.prepare("SELECT name FROM pragma_table_info('clank_platform_releases') WHERE name='upload_publication_receipt'").get(),undefined);assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,1);
  f.sql.exec('DROP TRIGGER ignore_upgrade');accepted(await f.stage());assert.equal(f.sql.prepare('SELECT enrollment_id FROM clank_platform_shadow_state').get().enrollment_id,hash('legacy-enrollment'));
});

test('local project deletion retains accounting until parent directory durability succeeds including absent retry',async t=>{
  const f=await fixture(t);await f.fresh();accepted(await f.stage());const before=f.raw()[0],parent=join(f.root,'platform/projects'),original=fs.promises.open;let syncs=0,fail=true;
  fs.promises.open=async function(path,...args){const handle=await original.call(this,path,...args);if(String(path)===parent){const sync=handle.sync.bind(handle);handle.sync=async()=>{syncs++;if(fail)throw new Error('Injected actual parent directory sync failure');return sync()}}return handle};syncBuiltinESMExports();
  const remove=()=>f.platform.handle(new Request(`${origin}/api/projects/${f.project.id}`,{method:'DELETE',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify({confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true})}));
  try{
    for(let n=1;n<=2;n++){const response=await remove();assert.equal(response.status,409,JSON.stringify(await response.json()));assert.equal(syncs,n);assert.deepEqual(f.raw()[0],before);assert.equal(fs.existsSync(join(parent,f.project.id)),false)}
    fail=false;const response=await remove();assert.equal(response.status,200,JSON.stringify(await response.json()));assert.equal(syncs,3);assert.equal(f.raw().length,0);
  }finally{fs.promises.open=original;syncBuiltinESMExports()}
});

for(const revoked of ['lease','session','administration'])test(`shadow-only project deletion cannot submit native DELETE after captured ${revoked} authority is lost`,async t=>{
  const f=await fixture(t,{objects:true});await f.fresh();accepted(await f.stage());const before=f.raw()[0],entered=gate(),hold=gate(),start=f.requests.length;
  f.hooks.before=async({record})=>{if(record.method==='HEAD'){entered.resolve();await hold.promise}};
  const pending=f.platform.handle(new Request(`${origin}/api/projects/${f.project.id}`,{method:'DELETE',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify({confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true})}));
  try{await entered.promise;if(revoked==='lease')f.sql.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:'+f.project.id);else if(revoked==='session')f.sql.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(f.owner.session.id);else f.sql.prepare("UPDATE clank_platform_memberships SET role='viewer' WHERE organization_id=? AND user_id=?").run(f.project.organizationId,f.owner.user.id);hold.resolve();const response=await pending;const body=await response.json();assert.equal(f.requests.slice(start).filter(request=>request.method==='DELETE').length,0,JSON.stringify({status:response.status,body}));assert.ok(await f.nativeStore.get(before.runner_artifact_key));assert.deepEqual(f.raw()[0],before);assert.ok([401,403,409].includes(response.status),JSON.stringify(body))}
  finally{hold.resolve();await Promise.allSettled([pending])}
});

for(const revoked of ['lease','session','administration'])test(`shadow project DELETE trigger cannot revoke ${revoked} authority and commit receipt removal`,async t=>{
  const f=await fixture(t);await f.fresh();accepted(await f.stage());const before=f.raw()[0];
  const effect=revoked==='lease'?"DELETE FROM clank_distributed_leases WHERE resource='project:'||old.id;":revoked==='session'?"DELETE FROM clank_auth_sessions WHERE user_id=old.owner_id;":"UPDATE clank_platform_memberships SET role='viewer' WHERE organization_id=old.organization_id AND user_id=old.owner_id;";
  f.sql.exec(`CREATE TRIGGER revoke_delete AFTER DELETE ON clank_platform_projects BEGIN ${effect} END`);
  await f.json(`/api/projects/${f.project.id}`,{method:'DELETE',body:{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true},auth:f.owner},500);
  assert.deepEqual(f.raw()[0],before);assert.ok(f.sql.prepare('SELECT id FROM clank_platform_projects WHERE id=?').get(f.project.id));assert.equal(fs.existsSync(join(f.root,'platform/projects',f.project.id)),false);
  f.sql.exec('DROP TRIGGER revoke_delete');await f.json(`/api/projects/${f.project.id}`,{method:'DELETE',body:{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true},auth:f.owner});assert.equal(f.raw().length,0);
});
