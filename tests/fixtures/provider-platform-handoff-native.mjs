// Native fixture setup: seed an owned platform catalog from its already verified
// ordinary Docker baseline. This does not claim initial platform HTTP deployment.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomBytes,createHmac,createCipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openPlatform,platformProviderHandoffContext} from '../../dist/platform.js';
export function nativePlatformCredentials(key,generation,projectId='native_project'){
 const token=prefix=>'clnk'+(prefix==='ingress'?'i':'c')+'_'+createHmac('sha256',key).update('clank-provider-'+prefix+'\0').update(projectId).update('\0').update(String(generation)).digest('base64url');
 return {route:'/v1/clank/apps/'+projectId,token:token('ingress'),controlToken:token('control')};
}
export async function openNativePlatformHandoff(directory,key,capsule){
 const root=join(directory,'platform'),origin='http://127.0.0.1:47451';
 const runtime=await openPlatform(nativePlatformOptions(directory,key));
 let control;
 try{
  const response=await runtime.handle(new Request(origin+'/__clank/auth/register',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'native-handoff@example.test',password:'correct horse battery staple',profile:{name:'Native handoff'}})}));assert.equal(response.status,201,await response.clone().text());const account=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const call=async(path,body,headers={},status=200)=>{const response=await runtime.handle(new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)}));const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
  const device=await call('/api/device/start',{clientName:'native platform handoff'},{},201);
  await call('/api/device/approve',{code:device.userCode},{cookie,'x-clank-csrf':account.csrfToken});
  const token=await call('/api/device/token',{deviceCode:device.deviceCode});
  const template=await call('/api/projects',{name:'Native workspace setup',slug:'native-workspace-setup',placement:'provider'},{authorization:'Bearer '+token.accessToken},201);
  control=new DatabaseSync(join(root,'control.sqlite'));control.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
  const organization=control.prepare('SELECT organization_id FROM clank_platform_projects WHERE id=?').get(template.project.id).organization_id;assert.ok(organization);
  const now=Date.now(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(JSON.stringify(capsule.manifest.environment),'utf8'),cipher.final()]),environment='v1.'+[iv,encrypted,cipher.getAuthTag()].map(b=>b.toString('base64url')).join('.');
  control.prepare("INSERT INTO clank_platform_projects(id,owner_id,organization_id,name,slug,port,active_release_id,database_path,placement,active_generation,provider_origin,provider_node_id,created_at,updated_at) VALUES('native_project',?,?,'Native platform handoff','native-platform',47452,'native_release','source.sqlite','provider',1,'http://127.0.0.1:47231','native_node',?,?)").run(account.user.id,organization,now,now);
  control.prepare("INSERT INTO clank_platform_releases(id,project_id,status,digest,artifact_bytes,runtime_bytes,runner_artifact_bytes,storage_bytes,framework_version,node_version,config,directory,idempotency_key,created_at,activated_at,provider_generation) VALUES('native_release','native_project','active',?,?,?,?,?,'0.24.0-test',?,?,?,'native-seeded-baseline',?,?,1)").run(capsule.artifact.sha256,capsule.artifact.bytes.length,capsule.bytes.length,capsule.artifact.bytes.length,capsule.artifact.bytes.length,process.version,JSON.stringify(capsule.artifact.bundle.config),directory,now,now);
  control.prepare("INSERT INTO clank_platform_provider_generations(project_id,generation,release_id,encrypted_environment,database_mode,created_at) VALUES('native_project',1,'native_release',?,'initialize',?)").run(environment,now);
  const coordinator=platformProviderHandoffContext(runtime).orchestrator;
  const sourceSession=await coordinator.registerNode({id:'native_node',region:'native',capacity:1,endpoint:'http://127.0.0.1:47231'});
  const desired=await coordinator.setDesired({projectId:'native_project',releaseId:'native_release',state:'running',placementMode:'stateful',region:'native',nodeRequirements:{endpoint:true},runtimeProtocol:'clank-runtime/1'});assert.equal(desired.assignedNodeId,'native_node');assert.equal(desired.generation,1);
  assert.equal(await coordinator.observe('native_node',sourceSession.token,{projectId:'native_project',generation:1,releaseId:'native_release',state:'running'}),true);
  const oldSourceOperation=(await coordinator.claim('native_node',sourceSession.token,1))[0];assert.ok(oldSourceOperation);
  const targetSession=await coordinator.registerNode({id:'native_target',region:'native',capacity:1,endpoint:'http://127.0.0.1:47431'});
  let heartbeatFailure;const heartbeat=setInterval(()=>{void Promise.all([coordinator.heartbeat('native_node',sourceSession.token),coordinator.heartbeat('native_target',targetSession.token)]).catch(error=>heartbeatFailure=error);},1000);heartbeat.unref();
  return {runtime,coordinator,sourceSession,targetSession,oldSourceOperation,control,controlPath:join(root,'control.sqlite'),async close(){clearInterval(heartbeat);control.close();await runtime.close();if(heartbeatFailure)throw heartbeatFailure;}};
 }catch(error){control?.close();await runtime.close();throw error;}
}

// Reopens the existing native catalog. No seeding, timestamp editing or receipt adoption.
function nativePlatformOptions(directory,key,identity={}){return {dataDirectory:join(directory,'platform'),publicUrl:'http://127.0.0.1:47451',masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:47451,appPortEnd:47460,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'native-platform-registration-12345678901234567890',placement:identity.api?{}:{activationTimeoutMs:2000}}};}
export async function reopenNativePlatformHandoff(directory,key,identity={projectId:'native_project',releaseId:'native_release'}){
 const runtime=await openPlatform(nativePlatformOptions(directory,key,identity));let control,closing;
 try{
  control=new DatabaseSync(join(directory,'platform','control.sqlite'),{readOnly:true});control.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000');
  const coordinator=platformProviderHandoffContext(runtime).orchestrator,placement=coordinator.desired(identity.projectId);assert.equal(placement.assignedNodeId,'native_target');assert.equal(placement.generation,2);assert.equal(placement.desiredReleaseId,identity.releaseId);assert.equal(placement.desiredState,'running');if(!identity.adoption)assert.notEqual(placement.observedState,'running');
  return {runtime,coordinator,control,controlPath:join(directory,'platform','control.sqlite'),close(){return closing??=(async()=>{try{control.close();}finally{await runtime.close();}})();}};
 }catch(error){control?.close();await runtime.close();throw error;}
}

/** A new OS process receives only the existing root and its original master key. */
export async function reopenNativePlatformHandoffProcess(directory,key,identity={projectId:'native_project',releaseId:'native_release'}){
 const [{spawn},fs,{fileURLToPath}]=await Promise.all([import('node:child_process'),import('node:fs'),import('node:url')]);
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./provider-platform-reopen-process-native.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
 let sequence=0,closed=false,closing,stderr='',stdout='',control;const pending=new Map();
 child.stdout.on('data',part=>{stdout=(stdout+part).slice(-65536);});child.stderr.on('data',part=>{stderr=(stderr+part).slice(-65536);});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('Native controller process exited: '+JSON.stringify({code,signal,stderr,stdout})));}pending.clear();});child.once('close',(code,signal)=>resolve({code,signal}));});
 child.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Object.assign(Error(message.error.message),{stack:message.error.stack}));else entry.resolve(message.result);});
 const call=(kind,input={})=>new Promise((resolve,reject)=>{if(closed||!child.connected){reject(Error('Native controller process is closed.'));return;}const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Native controller observation exceeded its bound: '+kind));},15000);pending.set(id,{resolve,reject,timer});child.send({id,kind,...input},error=>{if(error){pending.delete(id);clearTimeout(timer);reject(error);}});});
 const close=()=>closing??=(async()=>{try{if(!closed)await call('close');const result=await exited;assert.equal(result.code,0,stderr);assert.equal(result.signal,null);}finally{control?.close();}})();
 try{
  const started=await call('open',{directory,keyHex:Buffer.from(key).toString('hex'),identity});assert.equal(started.pid,child.pid);const birth=fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(') ')[1].split(' ')[19];assert.equal(started.birth,birth);assert.notEqual(child.pid,process.pid);
  control=new DatabaseSync(join(directory,'platform','control.sqlite'),{readOnly:true});control.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000');
  return {control,controlPath:join(directory,'platform','control.sqlite'),pid:child.pid,birth,enqueue:input=>call('enqueue',{input}),authenticateOperation:operation=>call('authenticate',{operation}),close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native controller startup and cleanup failed.');}throw error;}
}

/** Spawn an independent ordinary provider; no transfer/coordinator capabilities cross IPC. */
export async function reopenNativeDockerProviderProcess(options,token,maximumBody){
 const [{spawn},fs,{fileURLToPath}]=await Promise.all([import('node:child_process'),import('node:fs'),import('node:url')]);
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./provider-service-reopen-process-native.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
 let sequence=0,closed=false,closing,stderr='',stdout='',started,termination='graceful';const pending=new Map();
 child.stdout.on('data',part=>{stdout=(stdout+part).slice(-65536);});child.stderr.on('data',part=>{stderr=(stderr+part).slice(-65536);process.stderr.write(part);});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('Native provider process exited: '+JSON.stringify({code,signal,stderr,stdout})));}pending.clear();});child.once('close',(code,signal)=>resolve({code,signal}));});
 child.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Object.assign(Error(message.error.message),{stack:message.error.stack}));else entry.resolve(message.result);});
 const call=(kind,input={})=>new Promise((resolve,reject)=>{if(closed||!child.connected){reject(Error('Native provider process is closed.'));return;}const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Native provider observation exceeded its bound: '+kind));},30000);pending.set(id,{resolve,reject,timer});child.send({id,kind,...input},error=>{if(error){pending.delete(id);clearTimeout(timer);reject(error);}});});
 const current=()=>{assert.ok(started);assert.equal(fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(') ')[1].split(' ')[19],started.birth);};
 const ended=async()=>{const result=await exited;if(termination==='SIGKILL'){assert.equal(result.code,null);assert.equal(result.signal,'SIGKILL');}else{assert.equal(result.code,0,stderr);assert.equal(result.signal,null);}return result;};
 const close=()=>closing??=(async()=>{if(!closed)await call('close');await ended();})();
 try{
  started=await call('open',{options,token,maximumBody});assert.equal(started.pid,child.pid);assert.notEqual(child.pid,process.pid);current();
  return {pid:child.pid,birth:started.birth,async kill(){assert.equal(closing,undefined);assert.equal(closed,false);current();termination='SIGKILL';assert.equal(child.kill('SIGKILL'),true);await ended();},close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native provider startup and cleanup failed.');}throw error;}
}
