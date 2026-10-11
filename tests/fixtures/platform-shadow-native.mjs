import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer,request as httpRequest} from 'node:http';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDeploymentBundle,deploymentDigest,createDeploymentCoordinatorClient,openProviderDeploymentAgent} from '../../dist/index.js';
import {openDeploymentProviderDataStore} from '../../dist/provider-data.js';
import {openDeploymentProviderService,deploymentProviderCanaryPath} from '../../dist/provider-service.js';
import {createDeploymentRuntimeIngress} from '../../dist/provider-runtime.js';
import {linuxProcessBirth} from '../../dist/platform-supervisor.js';
import {reservePlatformTestPorts} from './platform-test-ports.mjs';

const origin='http://127.0.0.1:4200';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let done=false,release;const promise=new Promise(value=>release=value);return{promise,get done(){return done},resolve(){done=true;release()}}};
async function until(check,description,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await pause(10)}throw new Error('Timed out: '+description)}
function request(path,{method='GET',body,token,cookie,csrf,url=origin+path}={}){return new Request(url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json',origin}),...(token?{authorization:`Bearer ${token}`} : {}),...(cookie?{cookie}:{}),...(csrf?{'x-clank-csrf':csrf}:{}),'x-clank-client-ip':'127.0.0.1'},...(body===undefined?{}:{body:JSON.stringify(body)})})}
async function json(platform,path,input={},status=200){const response=await platform.handle(request(path,input)),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body}
async function browserSession(platform,action,email,native=false){
  const response=await (native?platform.nativeRequest:platform.handle)(request('/__clank/auth/'+action,{method:'POST',body:{email,password:'correct horse battery staple',...(action==='register'?{profile:{name:'Canary native'}}:{})}}));
  const payload=await response.json();assert.equal(response.status,action==='register'?201:200,JSON.stringify(payload));
  return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:payload.csrfToken,user:payload.user,session:payload.session};
}
async function authorize(platform){
  const auth=await browserSession(platform,'register','canary-native@example.test');
  const started=await json(platform,'/api/device/start',{method:'POST',body:{clientName:'native canary'}},201);
  await json(platform,'/api/device/approve',{method:'POST',body:{code:started.userCode},cookie:auth.cookie,csrf:auth.csrf});
  return {...await json(platform,'/api/device/token',{method:'POST',body:{deviceCode:started.deviceCode}}),...auth};
}
async function fresh(platform,control,auth,native=true){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id='shadow-key-'+crypto.randomUUID(),credentialId=Buffer.from(id).toString('base64url');
  // Register only the test signing key. The platform verifies the signature and
  // updates session freshness through its ordinary browser authentication routes.
  control.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(id,credentialId,auth.user.id,'Native shadow key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const transport=native?{handle:platform.nativeRequest}:platform;
  const started=await json(transport,'/__clank/auth/reauthenticate/passkey/start',{method:'POST',body:{},cookie:auth.cookie,csrf:auth.csrf});
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(origin).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  const credential={id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}};
  return json(transport,'/__clank/auth/reauthenticate/passkey/finish',{method:'POST',body:{challengeId:started.challengeId,challenge:started.options.challenge,credential},cookie:auth.cookie,csrf:auth.csrf});
}
function nativeRequest(url,input,{dropResponse=false,timeoutMs=20000,maxResponseBytes=1024*1024}={}){
  const target=new URL(input.url),destination=new URL(target.pathname+target.search,url);
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0);assert.ok(Number.isSafeInteger(maxResponseBytes)&&maxResponseBytes>0);
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const outgoing=httpRequest(destination,{method:input.method,headers:{...Object.fromEntries(input.headers),host:input.headers.get('host')??target.host},signal:input.signal},incoming=>{
      const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
      const metadata={status:incoming.statusCode,statusText:incoming.statusMessage,headers};
      incoming.on('error',error=>finish(error));
      // Drop only after a genuine HTTP acknowledgment exists; no response body
      // or session identity is consumed. This does not cancel platform ownership.
      if(dropResponse){finish(null,{...metadata,dropped:true});incoming.destroy();outgoing.destroy();return}
      const chunks=[];let bytes=0;
      incoming.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxResponseBytes){const error=new Error('Native fixture response exceeded its byte bound.');finish(error);incoming.destroy(error);outgoing.destroy(error)}else chunks.push(chunk)});
      incoming.on('end',()=>{try{finish(null,new Response(input.method==='HEAD'||[204,205,304].includes(metadata.status)?null:Buffer.concat(chunks),metadata))}catch(error){finish(error)}});
    });
    outgoing.on('error',error=>finish(error));
    timer=setTimeout(()=>{const error=new Error('Native platform request timed out.');finish(error);outgoing.destroy(error)},timeoutMs);
    // Preserve a live request stream so tests can hold a body across another
    // operation. The IPC helper intentionally retains its older buffered path.
    if(input.body)pipeline(Readable.fromWeb(input.body),outgoing).catch(error=>finish(error));else outgoing.end();
  });
}
async function artifact(root,label,status=200){
  const path=join(root,'artifact-'+label);await mkdir(join(path,'dist'),{recursive:true});await mkdir(join(path,'migrations'),{recursive:true});
  await writeFile(join(path,'dist/server.js'),'export const fixture = true;\n');await writeFile(join(path,'dist/meta.json'),JSON.stringify({label,status}));
  await writeFile(join(path,'migrations/0001_events.sql'),'CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL);\n');
  return createDeploymentBundle(path,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:2000},env:{}},{frameworkVersion:'0.24.0',nodeVersion:process.version});
}
async function deploy(f,bytes,key){const response=await f.platform.handle(new Request(origin+`/api/projects/${f.project.id}/releases`,{method:'POST',headers:{authorization:`Bearer ${f.owner.accessToken}`,'content-type':'application/vnd.clank.deploy+gzip','content-length':String(bytes.byteLength),'x-clank-content-sha256':await deploymentDigest(bytes),'x-clank-idempotency-key':key},body:bytes}));return {status:response.status,body:await response.json()}}

export async function shadowPlatformFixture(t,policy={stages:[{trafficPercent:50,durationMs:2000,minimumSamples:2},{trafficPercent:100,durationMs:1000,minimumSamples:2}],maximumErrorRate:0.2,maximumP95Ms:1500}, fixedProjectId,fixtureOptions={}){
  const root=await mkdtemp(join(tmpdir(),'clank-platform-provider-canary-')),ports=await reservePlatformTestPorts(),children=[],births=new Map(),runtimes=new Map(),events=[],errors=[];
  let service,agent,server,platform,sequence=0,retainedPrimary;
  const heldControls=new Map(),ownedGates=new Set(),controlCounts={binding:0,prepare:0,retire:0,'binding-response':0,'prepare-response':0,'retire-response':0};
  const holdControl=async action=>{
    controlCounts[action]++;const held=heldControls.get(action);if(!held||controlCounts[action]<held.at)return;
    held.hits++;held.enteredAt??=performance.now();if(held.once)heldControls.delete(action);held.entered.resolve();await held.release.promise;
  };
  const track=async child=>{if(!children.includes(child))children.push(child);const birth=await linuxProcessBirth(child.pid);births.set(child,birth);return birth;};
  t.after(async()=>{
    for(const held of ownedGates)held.release.resolve();await agent?.close();
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
    const action=/\/canary\/(binding|prepare|retire)$/.exec(req.url)?.[1];if(action)await holdControl(action);
    const response=await service.handle(input),body=action?Buffer.from(await response.arrayBuffer()):null;
    events.push({kind:'control',path:req.url,status:response.status,...(action==='binding'&&response.status===200?{binding:JSON.parse(body.toString('utf8')).binding}:{})});
    if(action)await holdControl(action+'-response');res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body??Buffer.from(await response.arrayBuffer()));
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const options={publicUrl:origin,signup:'bootstrap',appPortStart:ports.start,appPortEnd:ports.end,platformAdminEmails:['canary-native@example.test'],backups:{intervalMs:false},previews:{cleanupIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'provider-native-registration-12345678901234567890',placement:{activationTimeoutMs:fixtureOptions.activationTimeoutMs??2000}},supervisor:{configurationId:'actual-platform-cluster',configurationRevision:1,leaseMs:30000,pollIntervalMs:50},shadowTraffic:{revision:1,readPaths:['/','/healthz'],methods:['GET','HEAD'],maxSamplePercent:10,maxDurationMs:30000,maxAttempts:10,maxConcurrent:2,maxResponseBytes:1024,maxRequestMs:1000,maxReports:2},...(fixtureOptions.providerPromotionHosts===undefined?{}:{providerPromotionHosts:fixtureOptions.providerPromotionHosts})};
  async function start(disabled=false){
    const child=fork(new URL('./platform-shadow-controller.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:join(root,'platform'),CLANK_SUPERVISOR_FIXTURE_OPTIONS:JSON.stringify({...options,...(disabled?{canary:undefined,shadowTraffic:undefined}:{})})},stdio:['ignore','pipe','pipe','ipc']});await track(child);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8192));
    const pending=new Map();child.on('message',message=>{if(message.id&&pending.has(message.id)){const {resolve,reject,timer}=pending.get(message.id);pending.delete(message.id);clearTimeout(timer);message.kind==='error'?reject(new Error(message.error)):resolve(message)}});
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Platform readiness: '+output)),60000);child.on('message',message=>{if(message.kind==='ready'){clearTimeout(timer);resolve(message)}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Platform exit: '+output))})});assert.equal(ready.kind,'ready');
    const rpc=message=>new Promise((resolve,reject)=>{if(!child.connected){reject(new Error('Platform was terminated'));return}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('Platform request timed out: '+output))},20000);pending.set(id,{resolve,reject,timer});child.send({...message,id})});
    child.once('exit',()=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error('Platform was terminated'))}pending.clear()});
    const handle=async request=>{const message=await rpc({kind:'request',url:request.url,method:request.method,headers:[...request.headers],body:request.body?Buffer.from(await request.arrayBuffer()).toString('base64'):null});return new Response(Buffer.from(message.body,'base64'),{status:message.status,headers:message.headers})};
    return {child,handle,rpc,url:ready.url,nativeRequest:(input,settings)=>nativeRequest(ready.url,input,settings),async close(){child.send({kind:'stop'});await once(child,'exit')}};
  }
  platform=await start();
  const client=createDeploymentCoordinatorClient({baseUrl:origin,fetch:(url,init)=>platform.handle(new Request(url,init))});
  const openAgent=async()=>agent=await openProviderDeploymentAgent({client,registrationToken:options.deploymentAgents.registrationToken,node:{id:'canary-native-provider',region:'local',endpoint,capacity:16},provider:{kind:'http',async reconcile(input){events.push({kind:'reconcile',projectId:input.operation.projectId,generation:input.desired.generation,mode:input.runtime?.manifest.database.mode,candidates:[...runtimes.keys()].filter(id=>id.startsWith('canary_'))});try{
      // Capture only the exact genuine reconciliation request, without its spent
      // signal. These bounded private bytes never enter events or diagnostics.
      if(input.runtime)assert.ok(input.runtime.bytes.byteLength<=8*1024*1024);
      const captured=input.runtime?{operation:structuredClone(input.operation),desired:structuredClone(input.desired),artifact:{sha256:input.artifact.sha256},runtime:{bytes:new Uint8Array(input.runtime.bytes),sha256:input.runtime.sha256},controlToken:input.runtime.manifest.ingress.controlToken}:null;
      const result=await service.reconcile(input);if(captured)retainedPrimary=captured;return result;
    }catch(error){errors.push(error.stack??String(error));throw error}},rollback:input=>service.rollback(input),delete:input=>service.delete(input)},pollIntervalMs:10,heartbeatIntervalMs:100});
  await openAgent();

  const owner=await authorize(platform),{project}=await json(platform,'/api/projects',{method:'POST',token:owner.accessToken,body:{name:'Native canary',slug:'native-canary',placement:'provider'}},201);
  const control=new DatabaseSync(join(root,'platform/control.sqlite'));control.exec('PRAGMA busy_timeout=5000');t.after(()=>control.close());
  if(fixedProjectId){control.prepare('UPDATE clank_platform_projects SET id=? WHERE id=?').run(fixedProjectId,project.id);project.id=fixedProjectId;}
  const f={root,owner,project,events,errors,control,get service(){return service},runtimes,data,endpoint,options,children,track,get platform(){return platform},
    register:(email,{native=true}={})=>browserSession(platform,'register',email,native),
    async invite(email){
      const transport={handle:platform.nativeRequest};
      const invitation=await json(transport,`/api/organizations/${project.organizationId}/invitations`,{method:'POST',body:{email,role:'viewer'},cookie:owner.cookie,csrf:owner.csrf},201);
      const response=await platform.nativeRequest(request('/__clank/auth/invited-register',{method:'POST',body:{token:invitation.invitation.token,email,password:'correct horse battery staple',profile:{name:'Invited shadow deployer'}}}));
      const payload=await response.json();assert.equal(response.status,201,JSON.stringify(payload));assert.equal(payload.organizationId,project.organizationId);assert.equal(payload.role,'viewer');
      const auth={cookie:response.headers.get('set-cookie').split(';')[0],csrf:payload.csrfToken,user:payload.user,session:payload.session};
      await json(transport,`/api/projects/${project.id}/members/${auth.user.id}`,{method:'PUT',body:{permissions:['read','deploy']},cookie:owner.cookie,csrf:owner.csrf});
      return auth;
    },
    login:(email=owner.user.email,{native=true}={})=>browserSession(platform,'login',email,native),
    fresh:(auth=owner,{native=true}={})=>fresh(platform,control,auth,native),
    get controlCounts(){return {...controlCounts}},
    primaryCoordination(){
      const operations=control.prepare('SELECT * FROM clank_deployment_operations WHERE project_id=? ORDER BY id').all(project.id);
      const node=control.prepare('SELECT id,status,endpoint FROM clank_deployment_nodes WHERE id=?').get('canary-native-provider');assert.equal(node?.status,'active');
      return {activeOperations:agent.activeOperations,pending:operations.filter(row=>['queued','retry','leased'].includes(row.state)).length,node,
        project:control.prepare('SELECT active_release_id,active_generation,provider_node_id FROM clank_platform_projects WHERE id=?').get(project.id),
        placement:control.prepare('SELECT desired_release_id,desired_state,generation,observed_release_id,observed_state,observed_generation FROM clank_deployment_placements WHERE project_id=?').get(project.id),
        operationCount:operations.length,operationDigest:createHash('sha256').update(JSON.stringify(operations)).digest('hex')};
    },
    async primaryObservation(){
      const state=await data.inspect(project.id);assert.ok(state);
      const observer=new DatabaseSync(join(root,'provider/projects',project.id,state.databasePath),{readOnly:true});
      try{return {projectId:state.projectId,releaseId:state.releaseId,generation:state.generation,fence:state.fence,capsuleSha256:state.capsuleSha256,
        rows:observer.prepare('SELECT id,label FROM events ORDER BY id').all()};}finally{observer.close();}
    },
    async issuePrimaryBinding(){
      assert.ok(retainedPrimary?.controlToken);
      const response=await fetch(endpoint+deploymentProviderCanaryPath(project.id,'binding'),{headers:{authorization:'Bearer '+retainedPrimary.controlToken},signal:AbortSignal.timeout(15000)});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.binding;
    },
    async replacePrimaryIncarnation(){
      const coordination=f.primaryCoordination();assert.equal(coordination.activeOperations,0);assert.equal(coordination.pending,0);
      assert.equal(retainedPrimary?.operation.projectId,project.id);
      const captured=retainedPrimary,before=await service.canaries.binding(project.id),observation=await f.primaryObservation();assert.ok(before);
      const digest=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(digest(captured.runtime.bytes),captured.runtime.sha256);
      await service.close();assert.equal(runtimes.size,0,'The old owned provider runtimes are absent before reopening.');
      await openService();await service.reconcile({operation:structuredClone(captured.operation),desired:structuredClone(captured.desired),artifact:{...captured.artifact},
        runtime:{bytes:new Uint8Array(captured.runtime.bytes),sha256:captured.runtime.sha256},signal:AbortSignal.timeout(15000)});
      // This native read does NOT issue a new HTTP binding receipt: the stale
      // response case must retain the old receipt's exact cleanup authority.
      const after=await service.canaries.binding(project.id);assert.ok(after);assert.notEqual(after.incarnation,before.incarnation);
      assert.deepEqual({...after,incarnation:before.incarnation},before);assert.deepEqual(await f.primaryObservation(),observation);
      assert.deepEqual(f.primaryCoordination(),coordination);assert.equal(retainedPrimary,captured,'No different reconciliation raced the exact retained replay.');
      assert.equal(runtimes.size,1);assert.equal(runtimes.get(project.id).status,'active');
      const response=await f.traffic();assert.equal(response.status,200);assert.deepEqual((await response.json()).rows,observation.rows.map(({label})=>({label})));
      return {before,after,observation,coordination,operation:{...captured.operation},desired:{...captured.desired},capsuleSha256:captured.runtime.sha256};
    },
    async retirementLedger(){
      try{return JSON.parse(await readFile(join(root,'provider/service',project.id+'.canary-retirements.json'),'utf8'));}
      catch(error){if(error.code==='ENOENT')return null;throw error;}
    },
    async pausePlatform(){await agent.close();await platform.close();},
    async reopen(disabled=false,{agent:reopenAgent=true}={}){await agent.close();await platform.close();platform=await start(disabled);await until(async()=>{const value=await platform.rpc({kind:'status'});return value.status.state==='leader'},'gracefully reopened platform leadership',60000);if(reopenAgent)await openAgent();return platform;},
    async successor(){platform=await start(true);await until(async()=>{const value=await platform.rpc({kind:'status'});return value.status.state==='leader'},'actual successor startup recovery',60000);await openAgent();return platform;},
    hold(action,{once=action==='binding-response',at=controlCounts[action]+1}={}){assert.ok(Object.hasOwn(controlCounts,action),'Known native control gate required.');assert.ok(Number.isSafeInteger(at)&&at>controlCounts[action],'Gate count must be in the future.');const held={entered:gate(),release:gate(),once,at,hits:0};heldControls.set(action,held);ownedGates.add(held);return held},
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
