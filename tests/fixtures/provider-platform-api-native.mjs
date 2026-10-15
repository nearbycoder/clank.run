// Actual HTTP bootstrap. No project/release/generation rows are seeded here.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openPlatform,platformProviderHandoffContext} from '../../dist/platform.js';
import {serve} from '../../dist/node.js';
import {createDeploymentCoordinatorClient} from '../../dist/runner.js';
import {decodeDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {deploymentDigest} from '../../dist/deploy.js';
const registrationToken='native-platform-registration-12345678901234567890';
// Fixture-only classification of the original plan's terminal source revocation.
// A target failure or any unrelated credential change is never excused here.
export function nativeFallbackSourceRevocationState(control,original){
 if(!original||original.plan.nodeId!=='native_node')return undefined;
 const {plan,node,operation}=original,current=control.prepare('SELECT id,node_id,requested_by,created_at,state,phase,projects FROM clank_platform_evacuations WHERE id=?').get(plan.id);
 if(!current||current.node_id!==plan.nodeId||current.requested_by!==plan.requestedBy||current.created_at!==plan.createdAt)return undefined;
 const phase=current.state==='completed'&&current.phase==='completed'?'completed':current.state==='running'&&['fenced','relocating'].includes(current.phase)?'fenced':undefined;if(!phase)return undefined;
 const active=control.prepare('SELECT id,region,endpoint,capacity,labels,token_hash,status,expires_at FROM clank_deployment_nodes WHERE id=?').get(plan.nodeId);
 if(!active||active.status!=='offline'||active.expires_at!==0||active.token_hash===node.token_hash||typeof active.token_hash!=='string'||['id','region','endpoint','capacity','labels'].some(key=>active[key]!==node[key]))return undefined;
 const op=control.prepare('SELECT id,node_id,project_id,action,payload,fence,state,lease_token_hash,lease_expires_at FROM clank_deployment_operations WHERE id=?').get(operation.id);
 if(!op||op.node_id!==plan.nodeId||op.project_id!==operation.projectId||op.action!==operation.action||op.payload!==JSON.stringify(operation.payload)||op.fence!==operation.fence||op.state!=='cancelled'||op.lease_token_hash!==null||op.lease_expires_at!==null)return undefined;
 let projects;try{projects=JSON.parse(current.projects);}catch{return undefined;}
 if(!Array.isArray(projects)||projects.length!==plan.projects.length||plan.projects.some(expected=>{const found=projects.filter(item=>item.projectId===expected.projectId);return found.length!==1||found[0].releaseId!==expected.releaseId||found[0].generation!==expected.generation||found[0].fallbackState!=='running'||typeof found[0].backupId!=='string'||!found[0].backupId||found[0].targetNodeId!=='native_target'||found[0].targetGeneration!==expected.generation+1;}))return undefined;
 return phase;
}
export async function openNativePlatformAPI(directory,key,{capacity=1,localFallback=false}={}){
 const platformErrors=[];
 const diagnostic=(error,depth=0)=>{const text=value=>typeof value==='string'?value.slice(0,4096):undefined;return {name:text(error?.name),code:text(error?.code),message:text(error?.message)??String(error).slice(0,4096),stack:text(error?.stack),...(depth<2&&Array.isArray(error?.errors)?{causes:error.errors.slice(0,4).map(value=>diagnostic(value,depth+1))}:{})};};
 const onError=error=>{platformErrors.push(diagnostic(error));if(platformErrors.length>16)platformErrors.shift();};
 const origin='http://127.0.0.1:47451',runtime=await openPlatform({onError,dataDirectory:join(directory,'platform'),publicUrl:origin,masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',platformAdminEmails:localFallback?['native-api-handoff@example.test']:[],appPortStart:47451,appPortEnd:47460,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken,localFallback,placement:{}}});
 let server,control,heartbeat,heartbeatTail=Promise.resolve(),heartbeatFailure,closing,sourceLease,sourceSession,targetSession,sourceRevocation,sourceRevocationFailure;const sourceSignal=new AbortController();
 const close=()=>closing??=(async()=>{clearInterval(heartbeat);await heartbeatTail;if(sourceRevocationFailure&&nativeFallbackSourceRevocationState(control,sourceRevocation)!=='completed')heartbeatFailure??=sourceRevocationFailure;try{control?.close();await runtime.close();}finally{await server?.close();}if(heartbeatFailure)throw heartbeatFailure;})();
 try{
  server=await serve(request=>runtime.handle(request),{hostname:'127.0.0.1',port:47451,maxBodySize:100*1024*1024,allowedHosts:['127.0.0.1:47451']});
  const call=async(path,body,headers={},status=200)=>{const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return {response,result};};
  const {response:registered,result:account}=await call('/__clank/auth/register',{email:'native-api-handoff@example.test',password:'correct horse battery staple',profile:{name:'Native API handoff'}},{},201),cookie=registered.headers.get('set-cookie').split(';')[0];
  const {result:device}=await call('/api/device/start',{clientName:'native API handoff'},{},201);await call('/api/device/approve',{code:device.userCode},{cookie,'x-clank-csrf':account.csrfToken});
  const {result:token}=await call('/api/device/token',{deviceCode:device.deviceCode});
  const {result:created}=await call('/api/projects',{name:'Native API handoff',slug:'native-platform',placement:'provider'},{authorization:'Bearer '+token.accessToken},201);assert.match(created.project.id,/^[A-Za-z0-9_-]{1,128}$/);
  const client=createDeploymentCoordinatorClient({baseUrl:origin}),coordinator=platformProviderHandoffContext(runtime).orchestrator;
  sourceSession=await client.register(registrationToken,{id:'native_node',region:'native',capacity,endpoint:'http://127.0.0.1:47231',labels:{provider:'http'}});
  control=new DatabaseSync(join(directory,'platform','control.sqlite'),{readOnly:true});control.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000');
  heartbeat=setInterval(()=>{heartbeatTail=heartbeatTail.then(async()=>{
   const sourceCall=async work=>{try{return await work();}catch(error){if(error?.status!==401||error?.code!=='NODE_AUTH_FAILED'||!nativeFallbackSourceRevocationState(control,sourceRevocation))throw error;sourceRevocationFailure??=error;sourceLease=undefined;return undefined;}};
   const revoked=nativeFallbackSourceRevocationState(control,sourceRevocation);
   if(!revoked)await sourceCall(()=>client.heartbeat('native_node',sourceSession.token));
   if(targetSession)await client.heartbeat('native_target',targetSession.token);
   if(sourceLease){if(revoked){assert.equal(coordinator.operation(sourceLease.id).state,'cancelled');sourceLease=undefined;}else{const renewing=sourceLease,renewed=await sourceCall(()=>client.renew('native_node',sourceSession.token,renewing));if(renewed)sourceLease=renewed;else{assert.equal(coordinator.operation(renewing.id).state,'cancelled');sourceLease=undefined;}}}
  }).catch(error=>{heartbeatFailure??=error;sourceSignal.abort(error);});},1000);heartbeat.unref();
  const result={runtime,coordinator,client,project:created.project,sourceSession,control,controlPath:join(directory,'platform','control.sqlite'),close,
   async planEvacuation(source,target){
    assert.equal(localFallback,true);assert.ok(targetSession);await runtime.bindLocalProvider('native_node',sourceSession.token,source);await runtime.bindLocalProvider('native_target',targetSession.token,target);
    const {result:planned}=await call('/api/admin/runners/native_node/evacuations',{confirmation:'evacuate native_node'},{cookie,'x-clank-csrf':account.csrfToken},201);assert.ok(result.oldSourceOperation);sourceRevocation=Object.freeze({plan:JSON.parse(JSON.stringify(planned.plan)),operation:result.oldSourceOperation,node:control.prepare('SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?').get('native_node')});return planned.plan;
   },
   // Private fixture checkpoint only. The caller must keep credentials out of logs.
   restartState(plan){
    assert.equal(localFallback,true);assert.ok(sourceSession&&targetSession&&sourceRevocation);
    assert.equal(sourceRevocation.plan.id,plan.id);
    return {cookie,csrfToken:account.csrfToken,sourceSession:structuredClone(sourceSession),targetSession:structuredClone(targetSession),
     sourceRevocation:structuredClone(sourceRevocation),nodeImages:['native_node','native_target'].map(id=>control.prepare('SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?').get(id))};
   },
   async runEvacuation(plan){
    const response=await fetch(origin+'/api/admin/runners/native_node/evacuations/'+plan.id+'/run',{method:'POST',headers:{'content-type':'application/json',origin,cookie,'x-clank-csrf':account.csrfToken},body:JSON.stringify({confirmation:plan.id}),signal:AbortSignal.timeout(60000)}),result=await response.json();assert.equal(response.status,200,JSON.stringify({response:result,platformErrors:platformErrors.slice(-8),evacuation:control.prepare('SELECT state,phase,error FROM clank_platform_evacuations WHERE id=?').get(plan.id)}));assert.equal(result.plan.state,'completed');return result.plan;
   },
   async deploy(provider,artifactBytes){
    const artifactSha256=await deploymentDigest(artifactBytes);
    let submissionResult;const submission=fetch(origin+'/api/projects/'+created.project.id+'/releases',{method:'POST',headers:{authorization:'Bearer '+token.accessToken,'content-type':'application/vnd.clank.deploy+gzip','content-length':String(artifactBytes.byteLength),'x-clank-content-sha256':artifactSha256,'x-clank-idempotency-key':'native-initial-api-release'},body:artifactBytes,signal:AbortSignal.timeout(120000)}).then(async response=>({status:response.status,body:await response.json()})).then(value=>(submissionResult=value),error=>(submissionResult={error:String(error)}));
    // Observe the real operation created by the pending deployment request.
    const deadline=Date.now()+30000;let claimed;
    while(!claimed){const rows=await client.claim('native_node',sourceSession.token,1);claimed=rows[0];if(!claimed){if(submissionResult)assert.equal(submissionResult.status,201,JSON.stringify(submissionResult));assert.ok(Date.now()<deadline,'Initial API deployment did not enqueue its source operation.');await new Promise(resolve=>setTimeout(resolve,25));}}
    assert.equal(claimed.projectId,created.project.id);assert.equal(claimed.fence,1);assert.equal(claimed.payload.generation,1);sourceLease=claimed;
    const [runtimeWire,downloadedArtifact]=await Promise.all([client.runtime('native_node',sourceSession.token,claimed),client.artifact('native_node',sourceSession.token,claimed)]);
    assert.equal(downloadedArtifact.sha256,artifactSha256);assert.equal(Buffer.from(downloadedArtifact.bytes).equals(Buffer.from(artifactBytes)),true);
    const capsule=await decodeDeploymentRuntimeCapsule(runtimeWire.bytes);assert.equal(capsule.sha256,runtimeWire.sha256);assert.equal(capsule.manifest.projectId,created.project.id);assert.equal(capsule.manifest.releaseId,claimed.payload.releaseId);assert.match(capsule.manifest.releaseId,/^[A-Za-z0-9_-]{1,128}$/);assert.equal(capsule.artifact.sha256,artifactSha256);
    assert.ok(await coordinator.authenticateOperation(sourceLease));await provider.reconcile({operation:{id:claimed.id,projectId:claimed.projectId,fence:claimed.fence,attempt:claimed.attempts,maxAttempts:claimed.maxAttempts},desired:claimed.payload,runtime:capsule,artifact:capsule.artifact,signal:sourceSignal.signal});assert.ok(await coordinator.authenticateOperation(sourceLease));
    assert.equal(await client.observe('native_node',sourceSession.token,{projectId:created.project.id,generation:1,releaseId:capsule.manifest.releaseId,state:'running'}),true);
    const completed=await submission;assert.equal(completed.status,201,JSON.stringify(completed));assert.equal(completed.body.release.project.id,created.project.id);assert.equal(completed.body.release.id,capsule.manifest.releaseId);assert.equal(completed.body.release.status,'active');
    targetSession=await client.register(registrationToken,{id:'native_target',region:'native',capacity,endpoint:'http://127.0.0.1:47431',labels:{provider:'http'}});result.targetSession=targetSession;result.oldSourceOperation=claimed;return {capsule,operation:claimed,release:completed.body.release};
   },
   async deployNext(provider,artifactBytes){
    assert.ok(targetSession,'Initial real API deployment must complete first.');
    const artifactSha256=await deploymentDigest(artifactBytes),nodeId='native_target';let submissionResult;
    const submission=fetch(origin+'/api/projects/'+created.project.id+'/releases',{method:'POST',headers:{authorization:'Bearer '+token.accessToken,'content-type':'application/vnd.clank.deploy+gzip','content-length':String(artifactBytes.byteLength),'x-clank-content-sha256':artifactSha256,'x-clank-idempotency-key':'native-next-api-release'},body:artifactBytes,signal:AbortSignal.timeout(120000)}).then(async response=>({status:response.status,body:await response.json()})).then(value=>(submissionResult=value),error=>(submissionResult={error:String(error)}));
    const deadline=Date.now()+30000;let claimed;
    while(!claimed){claimed=(await client.claim(nodeId,targetSession.token,1))[0];if(!claimed){if(submissionResult)assert.equal(submissionResult.status,201,JSON.stringify(submissionResult));assert.ok(Date.now()<deadline,'Next API deployment did not enqueue its target operation.');await new Promise(resolve=>setTimeout(resolve,25));}}
    assert.equal(claimed.projectId,created.project.id);assert.equal(claimed.payload.generation,3);
    const wire=await client.runtime(nodeId,targetSession.token,claimed),capsule=await decodeDeploymentRuntimeCapsule(wire.bytes);
    assert.equal(capsule.sha256,wire.sha256);assert.equal(capsule.manifest.generation,3);assert.equal(capsule.artifact.sha256,artifactSha256);assert.ok(await coordinator.authenticateOperation(claimed));
    await provider.reconcile({operation:{id:claimed.id,projectId:claimed.projectId,fence:claimed.fence,attempt:claimed.attempts,maxAttempts:claimed.maxAttempts},desired:claimed.payload,runtime:capsule,artifact:capsule.artifact,signal:AbortSignal.timeout(30000)});
    assert.equal(await client.observe(nodeId,targetSession.token,{projectId:created.project.id,generation:3,releaseId:capsule.manifest.releaseId,state:'running'}),true);
    assert.equal(await client.complete(nodeId,targetSession.token,claimed,{ordinaryNextGeneration:true}),true);
    const completed=await submission;assert.equal(completed.status,201,JSON.stringify(completed));assert.equal(completed.body.release.status,'active');
    return {capsule,operation:claimed,release:completed.body.release};
   }};return result;
 }catch(error){await close();throw error;}
}
