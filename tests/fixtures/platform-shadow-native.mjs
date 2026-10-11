import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDeploymentBundle,deploymentDigest,createDeploymentCoordinatorClient,openProviderDeploymentAgent} from '../../dist/index.js';
import {openDeploymentProviderDataStore} from '../../dist/provider-data.js';
import {openDeploymentProviderService} from '../../dist/provider-service.js';
import {createDeploymentRuntimeIngress} from '../../dist/provider-runtime.js';
import {linuxProcessBirth} from '../../dist/platform-supervisor.js';
import {reservePlatformTestPorts} from './platform-test-ports.mjs';

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

export async function shadowPlatformFixture(t,policy={stages:[{trafficPercent:50,durationMs:2000,minimumSamples:2},{trafficPercent:100,durationMs:1000,minimumSamples:2}],maximumErrorRate:0.2,maximumP95Ms:1500}, fixedProjectId){
  const root=await mkdtemp(join(tmpdir(),'clank-platform-provider-canary-')),ports=await reservePlatformTestPorts(),children=[],births=new Map(),runtimes=new Map(),events=[],errors=[];
  let service,agent,server,platform,sequence=0,heldPrepare=null,heldRetire=null,heldBinding=null,heldRetireResponse=null;
  const track=async child=>{if(!children.includes(child))children.push(child);const birth=await linuxProcessBirth(child.pid);births.set(child,birth);return birth;};
  t.after(async()=>{
    heldPrepare?.release.resolve();heldRetire?.release.resolve();heldBinding?.release.resolve();heldRetireResponse?.release.resolve();await agent?.close();
    for(const child of children){if(child.exitCode!==null||child.signalCode!==null)continue;
      assert.equal(await linuxProcessBirth(child.pid),births.get(child),'Only the captured owned child may be stopped.');
      const exited=once(child,'exit');child.send({kind:'stop'});let timer;
      try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Owned graceful shutdown timed out')),10000))]);}
      catch{assert.equal(await linuxProcessBirth(child.pid),births.get(child));child.kill('SIGKILL');await exited;}finally{clearTimeout(timer);}
    }
    const fences=async directory=>{try{return await readdir(directory)}catch(error){if(error.code==='ENOENT')return[];throw error}};
    await until(async()=>!(await fences(join(root,'platform','supervisor-guardians'))).length&&!(await fences(join(root,'platform','runtime-guardians'))).length,'owned guardian cleanup before root removal',60000);
    await service?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await ports.release();await rm(root,{recursive:true,force:true});
  });
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
    const response=await service.handle(input);events.push({kind:'control',path:req.url,status:response.status});if(req.url.endsWith('/canary/retire')&&heldRetireResponse){const held=heldRetireResponse;held.entered.resolve();await held.release.promise}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const options={publicUrl:origin,signup:'bootstrap',appPortStart:ports.start,appPortEnd:ports.end,platformAdminEmails:['canary-native@example.test'],backups:{intervalMs:false},previews:{cleanupIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'provider-native-registration-12345678901234567890',placement:{activationTimeoutMs:2000}},supervisor:{configurationId:'actual-platform-cluster',configurationRevision:1,leaseMs:30000,pollIntervalMs:50},shadowTraffic:{revision:1,readPaths:['/','/healthz'],methods:['GET','HEAD'],maxSamplePercent:10,maxDurationMs:30000,maxAttempts:10,maxConcurrent:2,maxResponseBytes:1024,maxRequestMs:1000,maxReports:2}};
  async function start(disabled=false){
    const child=fork(new URL('./platform-shadow-controller.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:join(root,'platform'),CLANK_SUPERVISOR_FIXTURE_OPTIONS:JSON.stringify({...options,...(disabled?{canary:undefined,shadowTraffic:undefined}:{})})},stdio:['ignore','pipe','pipe','ipc']});await track(child);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));
    const pending=new Map();child.on('message',message=>{if(message.id&&pending.has(message.id)){const {resolve,reject,timer}=pending.get(message.id);pending.delete(message.id);clearTimeout(timer);message.kind==='error'?reject(new Error(message.error)):resolve(message)}});
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Platform readiness: '+output)),60000);child.on('message',message=>{if(message.kind==='ready'){clearTimeout(timer);resolve(message)}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Platform exit: '+output))})});assert.equal(ready.kind,'ready');
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
  const f={root,owner,project,events,errors,control,service,runtimes,data,endpoint,options,children,track,get platform(){return platform},
    async pausePlatform(){await agent.close();await platform.close();},
    async successor(){platform=await start(true);await until(async()=>{const value=await platform.rpc({kind:'status'});return value.status.state==='leader'},'actual successor startup recovery',60000);await openAgent();return platform;},
    hold(action){const held={entered:gate(),release:gate()};if(action==='prepare')heldPrepare=held;if(action==='retire')heldRetire=held;if(action==='binding')heldBinding=held;if(action==='retire-response')heldRetireResponse=held;return held},
    async traffic(method='GET',path='/',headers={}){return platform.handle(new Request('http://native-canary.apps.example.test'+path,{method,headers,...(method==='POST'?{body:'write'}:{})}))},
    async state(){return json(platform,`/api/projects/${project.id}/canary`,{token:owner.accessToken})},
    reports(){return control.prepare('SELECT report FROM clank_platform_canaries WHERE project_id=? ORDER BY updated_at DESC').all(project.id).map(row=>JSON.parse(row.report))},
    async drive(bytes,key,during){
      let done=false;const pending=deploy(f,bytes,key).finally(()=>done=true);pending.catch(()=>{});
      const statuses={},before=events.length;
      // Independent clients keep supplying completed observations when another
      // response crosses a stage boundary. The 100ms pacing stays below the
      // unchanged default request quota, including under coverage contention.
      const clients=Array.from({length:4},async()=>{while(!done){const response=await f.traffic();await response.arrayBuffer();statuses[response.status]=(statuses[response.status]??0)+1;await pause(100)}});
      const settled=Promise.allSettled(clients);
      try{await during?.();return await pending}
      finally{
        done=true;
        const [deployment,traffic]=await Promise.all([Promise.allSettled([pending]),settled]);
        t.diagnostic(JSON.stringify({deployment:deployment[0].status==='fulfilled'?deployment[0].value.status:'rejected',reports:f.reports(),traffic:statuses,candidateRequests:events.slice(before).filter(event=>event.kind==='traffic'&&event.projectId.startsWith('canary_')).length}));
        const failed=traffic.find(client=>client.status==='rejected');if(failed)throw failed.reason;
      }
    },
    async stopAgent(){await agent.close()},
    raw(){const row=control.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(project.id);return row?{...row,operation:JSON.parse(row.operation)}:null},
    async recover(){const status=await f.state();return json(platform,`/api/projects/${project.id}/canary/recover`,{method:'POST',token:owner.accessToken,body:{operationId:status.provider.operationId,expectedEpoch:status.provider.controllerEpoch}})},
    async restart(disabled=false,{beforeStart,ready=true}={}){await agent.close();platform.child.kill('SIGKILL');await once(platform.child,'exit');await beforeStart?.();await pause(200);platform=await start(disabled);if(!ready)return platform;await until(async()=>{const state=await platform.rpc({kind:'status'});return state.status.state==='leader'},'replacement leader and startup cleanup',60000);await openAgent();return platform},
  };
  const initialBytes=await artifact(root,'primary');let initial=await deploy(f,initialBytes,'provider-canary-primary-0001');if(initial.status===503){await pause(500);initial=await deploy(f,initialBytes,'provider-canary-primary-0001')}assert.equal(initial.status,201,JSON.stringify({initial,events,errors,operations:control.prepare('SELECT action,state,error FROM clank_deployment_operations').all(),platform:await platform.rpc({kind:'status'})}));await until(()=>!control.prepare("SELECT 1 FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased')").get(project.id),'primary operation completion');return f;
}


export {origin,artifact,deploy,request,json,until,gate};
