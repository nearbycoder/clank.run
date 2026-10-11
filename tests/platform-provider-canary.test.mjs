import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDeploymentBundle,deploymentDigest,createDeploymentCoordinatorClient,openProviderDeploymentAgent} from '../dist/index.js';
import {openDeploymentProviderDataStore} from '../dist/provider-data.js';
import {openDeploymentProviderService} from '../dist/provider-service.js';
import {createDeploymentRuntimeIngress} from '../dist/provider-runtime.js';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

const origin='http://127.0.0.1:4200';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let done=false,release;const promise=new Promise(value=>release=value);return{promise,get done(){return done},resolve(){done=true;release()}}};
async function until(check,description,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await pause(10)}throw new Error('Timed out: '+description)}
function request(path,{method='GET',body,token,cookie,csrf,url=origin+path}={}){return new Request(url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json',origin}),...(token?{authorization:`Bearer ${token}`} : {}),...(cookie?{cookie}:{}),...(csrf?{'x-clank-csrf':csrf}:{}),'x-clank-client-ip':'127.0.0.1'},...(body===undefined?{}:{body:JSON.stringify(body)})})}
async function json(platform,path,input={},status=200){const response=await platform.handle(request(path,input)),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body}
async function authorize(platform){
  const response=await platform.handle(request('/__clank/auth/register',{method:'POST',body:{email:'canary-native@example.test',password:'correct horse battery staple',profile:{name:'Canary native'}}}));
  assert.equal(response.status,201,await response.clone().text());const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const started=await json(platform,'/api/device/start',{method:'POST',body:{clientName:'native canary'}},201);
  await json(platform,'/api/device/approve',{method:'POST',body:{code:started.userCode},cookie,csrf:session.csrfToken});
  return {...await json(platform,'/api/device/token',{method:'POST',body:{deviceCode:started.deviceCode}}),cookie,csrf:session.csrfToken,user:session.user};
}
async function artifact(root,label,status=200){
  const path=join(root,'artifact-'+label);await mkdir(join(path,'dist'),{recursive:true});await mkdir(join(path,'migrations'),{recursive:true});
  await writeFile(join(path,'dist/server.js'),'export const fixture = true;\n');await writeFile(join(path,'dist/meta.json'),JSON.stringify({label,status}));
  await writeFile(join(path,'migrations/0001_events.sql'),'CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL);\n');
  return createDeploymentBundle(path,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:2000},env:{}},{frameworkVersion:'0.24.0',nodeVersion:process.version});
}
async function deploy(f,bytes,key){const response=await f.platform.handle(new Request(origin+`/api/projects/${f.project.id}/releases`,{method:'POST',headers:{authorization:`Bearer ${f.owner.accessToken}`,'content-type':'application/vnd.clank.deploy+gzip','content-length':String(bytes.byteLength),'x-clank-content-sha256':await deploymentDigest(bytes),'x-clank-idempotency-key':key},body:bytes}));return {status:response.status,body:await response.json()}}

async function fixture(t,policy={stages:[{trafficPercent:50,durationMs:350,minimumSamples:2},{trafficPercent:100,durationMs:250,minimumSamples:2}],maximumErrorRate:0.2,maximumP95Ms:1500}, fixedProjectId){
  const root=await mkdtemp(join(tmpdir(),'clank-platform-provider-canary-')),ports=await reservePlatformTestPorts(),children=[],runtimes=new Map(),events=[],errors=[];
  let service,agent,server,platform,sequence=0,heldPrepare=null,heldRetire=null,heldBinding=null,heldRetireResponse=null;
  t.after(async()=>{heldPrepare?.release.resolve();heldRetire?.release.resolve();heldBinding?.release.resolve();heldRetireResponse?.release.resolve();await agent?.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}await service?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await ports.release();await rm(root,{recursive:true,force:true})});
  const data=await openDeploymentProviderDataStore({rootDirectory:join(root,'provider'),maxDatabaseBytes:4*1024*1024});
  const runtimeState=entry=>{const {candidate,server,database,...state}=entry;return Object.freeze(state)};
  const launcher={
    async launch({prepared,isolatedReadOnly}){
      assert.equal(runtimes.has(prepared.projectId),false);
      const metadata=JSON.parse(await readFile(join(prepared.releaseDirectory,'dist/meta.json'),'utf8'));
      const database=new DatabaseSync(prepared.databasePath,{readOnly:!!isolatedReadOnly});database.exec('PRAGMA busy_timeout=5000');
      const native=createServer((req,res)=>{
        const path=new URL(req.url,'http://localhost').pathname;
        if(path==='/healthz'){res.end('ok');return}
        events.push({kind:'traffic',projectId:prepared.projectId,method:req.method,path,label:metadata.label,headers:req.headers});
        let written=false;if(req.method==='POST'){try{database.prepare('INSERT INTO events(label) VALUES(?)').run(metadata.label);written=true}catch{res.statusCode=500}}
        if(res.statusCode===200)res.statusCode=metadata.status;
        res.setHeader('content-type','application/json');res.setHeader('set-cookie','fixture=candidate-cookie');
        res.end(JSON.stringify({label:metadata.label,written,rows:database.prepare('SELECT label FROM events ORDER BY id').all()}));
      });await new Promise(resolve=>native.listen(0,'127.0.0.1',resolve));
      const candidate=Object.freeze({protocol:'clank-provider-docker/1',projectId:prepared.projectId,releaseId:prepared.releaseId,generation:prepared.generation,capsuleSha256:prepared.capsuleSha256,upstream:'http://127.0.0.1:'+native.address().port,...(isolatedReadOnly?{isolatedReadOnly:true}:{})});
      runtimes.set(prepared.projectId,{...candidate,status:'candidate',port:native.address().port,containers:1,launchedAt:Date.now(),candidate,server:native,database});events.push({kind:'launch',projectId:prepared.projectId,isolatedReadOnly:!!isolatedReadOnly,label:metadata.label});return candidate;
    },
    async activate(candidate){const entry=runtimes.get(candidate.projectId);entry.status='active';return runtimeState(entry)},
    commit(candidate){const entry=runtimes.get(candidate.projectId);entry.status='active';return runtimeState(entry)},
    inspect(){return [...runtimes.values()].map(runtimeState)},
    async stop(projectId,generation){const entry=runtimes.get(projectId);if(!entry||generation!==undefined&&entry.generation!==generation)return false;entry.server.closeAllConnections();await new Promise(resolve=>entry.server.close(resolve));entry.database.close();runtimes.delete(projectId);events.push({kind:'stop',projectId});return true},
    async diagnostics(){return null},
    forget(){return false},async close(){for(const id of [...runtimes.keys()])await launcher.stop(id)},
  };
  const openService=async()=>service=await openDeploymentProviderService({rootDirectory:join(root,'provider'),data,runtimes:launcher,ingress:createDeploymentRuntimeIngress(),canaries:{readPaths:['/','/healthz'],maximumDurationMs:30000,controlTimeoutMs:3000},drainTimeoutMs:500,onError:error=>errors.push(String(error))});
  await openService();
  server=createServer(async(req,res)=>{try{
    const url='http://127.0.0.1:'+server.address().port+req.url;
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    if(req.url.endsWith('/canary/binding')&&heldBinding){const held=heldBinding;held.entered.resolve();await held.release.promise}
    if(req.url.endsWith('/canary/prepare')&&heldPrepare){const held=heldPrepare;held.entered.resolve();await held.release.promise}
    if(req.url.endsWith('/canary/retire')&&heldRetire){const held=heldRetire;held.entered.resolve();await held.release.promise}
    const response=await service.handle(input);if(req.url.endsWith('/canary/retire')&&heldRetireResponse){const held=heldRetireResponse;held.entered.resolve();await held.release.promise}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const options={publicUrl:origin,signup:'bootstrap',appPortStart:ports.start,appPortEnd:ports.end,platformAdminEmails:['canary-native@example.test'],backups:{intervalMs:false},previews:{cleanupIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'provider-native-registration-12345678901234567890',placement:{activationTimeoutMs:2000}},canary:{...policy,provider:{databasePolicy:'isolated-read-only',readPaths:['/','/healthz']}}};
  async function start(disabled=false){
    const child=fork(new URL('./fixtures/supervisor-platform-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:join(root,'platform'),CLANK_SUPERVISOR_FIXTURE_OPTIONS:JSON.stringify({...options,...(disabled?{canary:undefined}:{})})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));
    const pending=new Map();child.on('message',message=>{if(message.id&&pending.has(message.id)){const {resolve,reject,timer}=pending.get(message.id);pending.delete(message.id);clearTimeout(timer);message.kind==='error'?reject(new Error(message.error)):resolve(message)}});
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Platform readiness: '+output)),60000);child.once('message',message=>{clearTimeout(timer);resolve(message)});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Platform exit: '+output))})});assert.equal(ready.kind,'ready');
    const rpc=message=>new Promise((resolve,reject)=>{if(!child.connected){reject(new Error('Platform was terminated'));return}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('Platform request timed out: '+output))},20000);pending.set(id,{resolve,reject,timer});child.send({...message,id})});
    child.once('exit',()=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error('Platform was terminated'))}pending.clear()});
    const handle=async request=>{const message=await rpc({kind:'request',url:request.url,method:request.method,headers:[...request.headers],body:request.body?Buffer.from(await request.arrayBuffer()).toString('base64'):null});return new Response(Buffer.from(message.body,'base64'),{status:message.status,headers:message.headers})};
    return {child,handle,rpc,async close(){child.send({kind:'stop'});await once(child,'exit')}};
  }
  platform=await start();
  const client=createDeploymentCoordinatorClient({baseUrl:origin,fetch:(url,init)=>platform.handle(new Request(url,init))});
  const openAgent=async()=>agent=await openProviderDeploymentAgent({client,registrationToken:options.deploymentAgents.registrationToken,node:{id:'canary-native-provider',region:'local',endpoint,capacity:16},provider:{kind:'http',async reconcile(input){events.push({kind:'reconcile',projectId:input.operation.projectId,generation:input.desired.generation,mode:input.runtime?.manifest.database.mode,candidates:[...runtimes.keys()].filter(id=>id.startsWith('canary_'))});try{return await service.reconcile(input)}catch(error){errors.push(error.stack??String(error));throw error}},rollback:input=>service.rollback(input),delete:input=>service.delete(input)},pollIntervalMs:10,heartbeatIntervalMs:100});
  await openAgent();

  const owner=await authorize(platform),{project}=await json(platform,'/api/projects',{method:'POST',token:owner.accessToken,body:{name:'Native canary',slug:'native-canary',placement:'provider'}},201);
  const control=new DatabaseSync(join(root,'platform/control.sqlite'));control.exec('PRAGMA busy_timeout=5000');t.after(()=>control.close());
  if(fixedProjectId){control.prepare('UPDATE clank_platform_projects SET id=? WHERE id=?').run(fixedProjectId,project.id);project.id=fixedProjectId;}
  const f={root,owner,project,events,errors,control,service,runtimes,data,get platform(){return platform},
    hold(action){const held={entered:gate(),release:gate()};if(action==='prepare')heldPrepare=held;if(action==='retire')heldRetire=held;if(action==='binding')heldBinding=held;if(action==='retire-response')heldRetireResponse=held;return held},
    async traffic(method='GET',path='/',headers={}){return platform.handle(new Request('http://native-canary.apps.example.test'+path,{method,headers,...(method==='POST'?{body:'write'}:{})}))},
    async state(){return json(platform,`/api/projects/${project.id}/canary`,{token:owner.accessToken})},
    async drive(bytes,key){let done=false;const pending=deploy(f,bytes,key).finally(()=>done=true);while(!done){await Promise.all(Array.from({length:8},async()=>{const response=await f.traffic();await response.arrayBuffer()}));await pause(10)}return pending},
    async stopAgent(){await agent.close()},
    raw(){const row=control.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(project.id);return row?{...row,operation:JSON.parse(row.operation)}:null},
    async recover(){const status=await f.state();return json(platform,`/api/projects/${project.id}/canary/recover`,{method:'POST',token:owner.accessToken,body:{operationId:status.provider.operationId,expectedEpoch:status.provider.controllerEpoch}})},
    async restart(disabled=false,{beforeStart,ready=true}={}){await agent.close();platform.child.kill('SIGKILL');await once(platform.child,'exit');await beforeStart?.();await pause(200);platform=await start(disabled);if(!ready)return platform;await until(async()=>{const state=await platform.rpc({kind:'status'});return state.status.state==='leader'},'replacement leader and startup cleanup',60000);await openAgent();return platform},
  };
  const initialBytes=await artifact(root,'primary');let initial=await deploy(f,initialBytes,'provider-canary-primary-0001');if(initial.status===503){await pause(500);initial=await deploy(f,initialBytes,'provider-canary-primary-0001')}assert.equal(initial.status,201,JSON.stringify({initial,events,errors,operations:control.prepare('SELECT action,state,error FROM clank_deployment_operations').all(),platform:await platform.rpc({kind:'status'})}));await until(()=>!control.prepare("SELECT 1 FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased')").get(project.id),'primary operation completion');return f;
}

test('native platform provider canaries measure public reads, retire before ordinary preserve activation, and keep writes on the primary',{timeout:60000},async t=>{
  const f=await fixture(t),bytes=await artifact(f.root,'candidate');
  let finished=false;const pending=deploy(f,bytes,'provider-canary-candidate-0002').finally(()=>finished=true);
  await until(async()=>{const status=await f.state();return status.provider?.phase==='measuring'},'candidate measurement');
  const write=await f.traffic('POST');assert.equal(write.status,200);assert.equal((await write.json()).label,'primary');
  const privateRead=await f.traffic('GET','/',{authorization:'Bearer private-user'});assert.equal((await privateRead.json()).label,'primary');
  while(!finished){await Promise.all(Array.from({length:8},async()=>{const response=await f.traffic();await response.arrayBuffer()}));await pause(10)}
  const result=await pending;assert.equal(result.status,201,JSON.stringify(result));
  const status=await f.state();assert.equal(status.provider.phase,'complete');assert.equal(status.provider.outcome,'passed');assert.equal(status.canaries[0].state,'passed');
  const ordinary=f.events.filter(event=>event.kind==='reconcile');assert.equal(ordinary.length,2);assert.equal(ordinary[1].mode,'preserve');assert.deepEqual(ordinary[1].candidates,[]);
  const final=await f.traffic();const finalBody=await final.json();assert.equal(finalBody.label,'candidate');assert.deepEqual(finalBody.rows,[{label:'primary'}]);
  assert.ok(f.events.some(event=>event.kind==='traffic'&&event.projectId.startsWith('canary_')));
  assert.ok(f.events.filter(event=>event.kind==='traffic'&&event.projectId.startsWith('canary_')).every(event=>event.method==='GET'&&!event.headers.authorization&&!event.headers.cookie));
  const stored=f.control.prepare('SELECT operation FROM clank_platform_provider_canaries WHERE project_id=?').get(f.project.id).operation;
  assert.doesNotMatch(stored,/clnkc_|clanki_|Bearer|private-user/);assert.deepEqual(f.errors,[]);
});

for(const mode of ['undersampled','failed'])test(`native platform provider canary ${mode} evidence retires the candidate without advancing the primary`,{timeout:60000},async t=>{
  const f=await fixture(t,{stages:[{trafficPercent:100,durationMs:250,minimumSamples:2}],maximumErrorRate:0.2,maximumP95Ms:1500});
  const bytes=await artifact(f.root,mode,mode==='failed'?500:200);
  const result=mode==='failed'?await f.drive(bytes,'provider-canary-failure-0001'):await deploy(f,bytes,'provider-canary-failure-0001');
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'PROVIDER_CANARY_FAILED');
  const row=f.raw();assert.equal(row.operation.phase,'complete');assert.equal(row.operation.outcome,'failed');assert.equal(row.operation.retirement.phase,'retired');
  assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);assert.equal((await (await f.traffic()).json()).label,'primary');
  assert.equal(f.runtimes.size,1);assert.ok(row.epoch>row.operation.controllerEpoch);
});

test('native unfinished primary operation blocks canary binding',{timeout:60000},async t=>{
  const f=await fixture(t);await f.stopAgent();
  const prior=f.control.prepare('SELECT id FROM clank_deployment_operations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(f.project.id);
  f.control.prepare("UPDATE clank_deployment_operations SET state='retry',next_attempt_at=? WHERE id=?").run(Date.now(),prior.id);
  const result=await deploy(f,await artifact(f.root,'pending-primary'),'provider-canary-pending-0001');
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.error.code,'PROVIDER_CANARY_PRIMARY_PENDING');assert.equal(f.raw(),null);
  assert.equal(f.events.filter(event=>event.kind==='launch').length,1);
});

for(const alteration of ['delete','replace'])test(`native project lease ${alteration} during held binding cannot publish prepare or allocate a writer`,{timeout:60000},async t=>{
  const f=await fixture(t),held=f.hold('binding'),before=f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id);
  const pending=deploy(f,await artifact(f.root,'lease-'+alteration),'provider-canary-lease-0001');await held.entered.promise;
  const row=f.raw();assert.equal(row.operation.phase,'binding');
  if(alteration==='delete')f.control.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:'+f.project.id);
  else f.control.prepare('UPDATE clank_distributed_leases SET token_hash=?,fence=fence+1 WHERE resource=?').run('replaced-native-token','project:'+f.project.id);
  held.release.resolve();const result=await pending;assert.equal(result.status,503,JSON.stringify(result));
  assert.equal(f.raw().operation.phase,'binding');assert.equal(f.raw().operation.primary,null);assert.equal(f.raw().operation.retirement,null);
  assert.deepEqual(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),before);
  assert.equal(f.events.filter(event=>event.kind==='launch').length,1);
});

test('native timed-out prepare remains blocked until exact retirement and rejects its delayed request',{timeout:60000},async t=>{
  const f=await fixture(t),prepare=f.hold('prepare'),retire=f.hold('retire');
  const pending=deploy(f,await artifact(f.root,'delayed-prepare'),'provider-canary-delayed-0001');await prepare.entered.promise;await retire.entered.promise;
  const result=await pending;assert.equal(result.status,503,JSON.stringify(result));assert.equal(f.raw().operation.phase,'retiring');
  const newer=await deploy(f,await artifact(f.root,'blocked-next'),'provider-canary-blocked-0001');assert.equal(newer.status,409);assert.equal(newer.body.error.code,'PROVIDER_CANARY_RECOVERY_REQUIRED');
  const backupId='bk_0123456789abcdef',before=f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),candidate=f.raw().operation.releaseId;
  for(const [path,method,body] of [
    [`/api/projects/${f.project.id}/rollback`,'POST',{releaseId:candidate,restoreData:false}],
    [`/api/projects/${f.project.id}/backups/${backupId}/restore`,'POST',{confirmation:`restore-backup ${f.project.slug} ${backupId}`}],
    [`/api/admin/projects/${f.project.id}/provider-failover`,'POST',{backupId,sourceNodeId:'canary-native-provider',confirmation:`failover ${f.project.slug} from canary-native-provider using ${backupId}`,acknowledgeDataLoss:true,acknowledgeSourceFenced:true}],
    [`/api/projects/${f.project.id}/releases/${candidate}`,'DELETE',{confirmation:`delete-release ${f.project.slug} ${candidate}`,allowRollbackLoss:true}],
    [`/api/projects/${f.project.id}`,'DELETE',{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true}],
  ]){
    const response=await f.platform.handle(request(path,{method,body,cookie:f.owner.cookie,csrf:f.owner.csrf})),result=await response.json();
    assert.equal(response.status,409,JSON.stringify({path,result}));assert.equal(result.error.code,'PROVIDER_CANARY_RECOVERY_REQUIRED',path);
  }
  assert.deepEqual(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),before);assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);
  retire.release.resolve();await f.recover();assert.equal(f.raw().operation.retirement.phase,'retired');prepare.release.resolve();await pause(100);
  assert.equal(f.events.filter(event=>event.kind==='launch').length,1);assert.equal(f.runtimes.size,1);
});

test('native credential revocation during prepare permits exact cleanup but never candidate acceptance',{timeout:60000},async t=>{
  const f=await fixture(t),prepare=f.hold('prepare');
  const pending=deploy(f,await artifact(f.root,'revoked'),'provider-canary-revoked-0001');await prepare.entered.promise;
  f.control.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE user_id=?').run(Date.now(),f.owner.user.id);prepare.release.resolve();
  const result=await pending;assert.ok(result.status>=400,JSON.stringify(result));const row=f.raw();assert.equal(row.operation.phase,'complete');assert.equal(row.operation.retirement.phase,'retired');
  assert.equal(row.operation.generation,null);assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);assert.equal(f.runtimes.size,1);
});

test('actual platform SIGKILL before provider prepare admission recovers with policy disabled and retires the delayed request',{timeout:100000},async t=>{
  const f=await fixture(t),prepare=f.hold('prepare');
  const pending=deploy(f,await artifact(f.root,'killed'),'provider-canary-killed-0001').catch(error=>({killed:String(error)}));await prepare.entered.promise;
  const prior=f.raw();assert.equal(prior.operation.phase,'preparing');assert.equal(f.events.filter(event=>event.kind==='launch').length,1);
  await f.restart(true);await pending;
  const recovered=f.raw();assert.equal(recovered.operation.operationId,prior.operation.operationId);assert.equal(recovered.operation.phase,'complete');assert.equal(recovered.operation.outcome,'interrupted');assert.equal(recovered.operation.retirement.phase,'retired');
  assert.ok(recovered.epoch>prior.epoch);const state=await f.state();assert.equal(state.enabled,false);assert.equal(state.provider.cleanupRequired,false);
  prepare.release.resolve();await pause(100);assert.equal(f.events.filter(event=>event.kind==='launch').length,1);assert.equal(f.runtimes.size,1);
});

for(const alteration of ['delete','replace'])test(`native lease ${alteration} after provider retirement prevents generation allocation and does not fence unrelated projects`,{timeout:60000},async t=>{
  const f=await fixture(t),held=f.hold('retire-response');
  const pending=f.drive(await artifact(f.root,'retired-'+alteration),'provider-canary-retired-0001');await Promise.race([held.entered.promise,pending.then(result=>{throw new Error('Deployment ended before held retirement: '+JSON.stringify({result,row:f.raw(),events:f.events,errors:f.errors}))})]);
  const before=f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id);
  if(alteration==='delete')f.control.prepare('DELETE FROM clank_distributed_leases WHERE resource=?').run('project:'+f.project.id);
  else f.control.prepare('UPDATE clank_distributed_leases SET token_hash=?,fence=fence+1 WHERE resource=?').run('independent-connection-replacement','project:'+f.project.id);
  held.release.resolve();const result=await pending;assert.equal(result.status,503,JSON.stringify(result));
  assert.deepEqual(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),before);assert.equal(f.raw().operation.generation,null);assert.equal(f.raw().operation.retirement,null);
  const {project}=await json(f.platform,'/api/projects',{method:'POST',token:f.owner.accessToken,body:{name:'Unrelated',slug:'unrelated-canary',placement:'provider'}},201);
  const unrelated=await deploy({...f,project},await artifact(f.root,'unrelated'),'provider-canary-unrelated-0001');assert.equal(unrelated.status,201,JSON.stringify(unrelated));
});

test('an enrolled catalog with its native canary journal removed refuses restart and provider writer admission',{timeout:30000},async t=>{
  const f=await fixture(t),before=f.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(f.project.id);
  assert.equal(f.control.prepare('SELECT protocol FROM clank_platform_supervisor_state').get().protocol,2);
  await f.restart(true,{ready:false,beforeStart:()=>f.control.exec('DROP TABLE clank_platform_provider_canaries')});
  await until(()=>f.platform.child.signalCode==='SIGKILL','guardian refuses missing enrolled journal');
  await assert.rejects(deploy(f,await artifact(f.root,'missing-journal'),'provider-canary-missing-0001'),/Platform was terminated/u);
  assert.equal(f.control.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_provider_canaries'").get(),undefined);
  assert.deepEqual(f.control.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(f.project.id),before);assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);
});

for(const corruption of ['deleted-row','replayed-phase'])test(`native ${corruption} cannot erase a persisted prepare obligation or reset its epoch`,{timeout:40000},async t=>{
  const f=await fixture(t),binding=f.hold('binding'),prepare=f.hold('prepare');
  const pending=deploy(f,await artifact(f.root,corruption),'provider-canary-corrupt-0001');await binding.entered.promise;
  const earlier=f.control.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(f.project.id);binding.release.resolve();await prepare.entered.promise;
  const floor=f.control.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(f.project.id).provider_canary_epoch;
  assert.ok(floor>earlier.epoch,'each native transition advances the retained floor');
  if(corruption==='deleted-row')f.control.prepare('DELETE FROM clank_platform_provider_canaries WHERE project_id=?').run(f.project.id);
  else f.control.prepare('UPDATE clank_platform_provider_canaries SET epoch=?,operation=?,updated_at=? WHERE project_id=?').run(earlier.epoch,earlier.operation,earlier.updated_at,f.project.id);
  prepare.release.resolve();const result=await pending;assert.ok(result.status>=400,JSON.stringify(result));
  assert.equal(f.control.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(f.project.id).provider_canary_epoch,floor);
  assert.equal(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id).generation,1);
  await f.restart(true,{ready:false});await until(()=>f.platform.child.signalCode==='SIGKILL','guardian refuses corrupt native receipt');
  await assert.rejects(deploy(f,await artifact(f.root,'corrupt-restart'),'provider-canary-restart-0001'),/Platform was terminated/u);
  assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);
});

for(const failure of ['journal','receipt','lease'])test(`native ${failure} transition failure rolls back both receipts and leaves unrelated scope usable`,{timeout:60000},async t=>{
  const f=await fixture(t);
  const trigger=failure==='journal'?"CREATE TRIGGER fail_canary BEFORE INSERT ON clank_platform_provider_canaries BEGIN SELECT RAISE(IGNORE); END;":failure==='receipt'?"CREATE TRIGGER fail_canary BEFORE UPDATE OF provider_canary_epoch ON clank_platform_projects BEGIN SELECT RAISE(IGNORE); END;":`CREATE TRIGGER fail_canary AFTER INSERT ON clank_platform_provider_canaries BEGIN DELETE FROM clank_distributed_leases WHERE resource='project:' || NEW.project_id; END;`;
  f.control.exec(trigger);const failed=await deploy(f,await artifact(f.root,'transition-'+failure),'provider-canary-transition-0001');assert.ok(failed.status>=400,JSON.stringify(failed));
  assert.equal(f.raw(),null);assert.equal(f.control.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(f.project.id).provider_canary_epoch,0);assert.equal(f.runtimes.size,1);
  f.control.exec('DROP TRIGGER fail_canary');
  const repaired=await f.drive(await artifact(f.root,'transition-repaired'),'provider-canary-transition-0002');assert.equal(repaired.status,201,JSON.stringify(repaired));
  assert.equal(f.raw().operation.phase,'complete');assert.equal(f.control.prepare('SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?').get(f.project.id).provider_canary_epoch,f.raw().epoch);
});

test('legitimate acknowledged project deletion atomically removes its private canary receipt',{timeout:40000},async t=>{
  const f=await fixture(t);const failed=await deploy(f,await artifact(f.root,'retire-delete'),'provider-canary-delete-0001');assert.equal(failed.status,409);assert.equal(f.raw().operation.retirement.phase,'retired');
  await json(f.platform,`/api/projects/${f.project.id}`,{method:'DELETE',cookie:f.owner.cookie,csrf:f.owner.csrf,body:{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true}});
  assert.equal(f.raw(),null);assert.equal(f.control.prepare('SELECT id FROM clank_platform_projects WHERE id=?').get(f.project.id),undefined);assert.equal(f.runtimes.size,0);
  await f.restart(true);assert.equal((await f.platform.rpc({kind:'status'})).status.state,'leader');
});

test('nested native lifecycle scope rolls back a stale delete enqueue and restores unrelated authority',{timeout:60000},async t=>{
  const f=await fixture(t);assert.equal((await deploy(f,await artifact(f.root,'nested-retired'),'provider-canary-nested-0001')).status,409);
  f.control.exec("CREATE TRIGGER lose_nested_lease AFTER INSERT ON clank_deployment_operations WHEN NEW.action='delete' BEGIN DELETE FROM clank_distributed_leases WHERE resource='project:' || NEW.project_id; END;");
  const input={method:'DELETE',cookie:f.owner.cookie,csrf:f.owner.csrf,body:{confirmation:`delete-site ${f.project.slug}`,acknowledgeDataLoss:true}};
  const denied=await f.platform.handle(request(`/api/projects/${f.project.id}`,input));assert.ok(denied.status>=400,await denied.text());
  assert.equal(f.control.prepare("SELECT count(*) AS n FROM clank_deployment_operations WHERE project_id=? AND action='delete'").get(f.project.id).n,0);
  assert.ok(f.control.prepare('SELECT id FROM clank_platform_projects WHERE id=?').get(f.project.id));assert.equal(f.runtimes.size,1);assert.equal(f.raw().operation.phase,'complete');
  f.control.exec('DROP TRIGGER lose_nested_lease');
  const {project}=await json(f.platform,'/api/projects',{method:'POST',token:f.owner.accessToken,body:{name:'After nested rejection',slug:'after-nested-rejection',placement:'provider'}},201);
  assert.equal((await deploy({...f,project},await artifact(f.root,'after-nested'),'provider-canary-after-nested-0001')).status,201);
  await json(f.platform,`/api/projects/${f.project.id}`,input);assert.equal(f.raw(),null);
});

// Both prefixes are emitted by the platform's base64url identifier generator.
test('native provider canaries accept existing underscore and hyphen project identities',{timeout:60000},async t=>{
  for(const id of ['_native_provider_primary','-native_provider_primary']){
    const f=await fixture(t,undefined,id);
    const result=await f.drive(await artifact(f.root,'identifier-valid'),'provider-canary-identifiers-0001');
    assert.equal(result.status,201,JSON.stringify(result));assert.equal(f.raw().operation.primary.projectId,id);
  }
});

test('native ordinary deployment after disabling canaries keeps captured authority through generation allocation',{timeout:60000},async t=>{
  const f=await fixture(t);assert.equal((await deploy(f,await artifact(f.root,'disable-retired'),'provider-canary-disable-0001')).status,409);
  await f.restart(true);
  f.control.exec("CREATE TABLE native_lease_violation_evidence(generation INTEGER); CREATE TRIGGER lose_ordinary_lease AFTER INSERT ON clank_platform_provider_generations WHEN NEW.generation>1 BEGIN DELETE FROM clank_distributed_leases WHERE resource='project:' || NEW.project_id; INSERT INTO native_lease_violation_evidence VALUES(NEW.generation); END;");
  const denied=await deploy(f,await artifact(f.root,'disable-denied'),'provider-canary-disable-0002');assert.ok(denied.status>=400,JSON.stringify(denied));
  assert.equal(f.control.prepare('SELECT count(*) AS n FROM native_lease_violation_evidence').get().n,0,'a committed stale allocation cannot be hidden by later compensation');
  assert.equal(f.control.prepare('SELECT count(*) AS n FROM clank_platform_provider_generations WHERE project_id=? AND generation>1').get(f.project.id).n,0,'native allocation must roll back with its lost authority');
  assert.equal(f.control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(f.project.id).generation,1);assert.equal(f.events.filter(event=>event.kind==='reconcile').length,1);
  f.control.exec('DROP TRIGGER lose_ordinary_lease');
  const {project}=await json(f.platform,'/api/projects',{method:'POST',token:f.owner.accessToken,body:{name:'After ordinary rejection',slug:'after-ordinary-rejection',placement:'provider'}},201);
  assert.equal((await deploy({...f,project},await artifact(f.root,'ordinary-unrelated'),'provider-canary-ordinary-unrelated-0001')).status,201);
  const accepted=await deploy(f,await artifact(f.root,'disable-accepted'),'provider-canary-disable-0003');assert.equal(accepted.status,201,JSON.stringify(accepted));
});
