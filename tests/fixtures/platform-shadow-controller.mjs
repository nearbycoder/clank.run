import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {openPlatform} from '../../dist/platform.js';
import {serve} from '../../dist/node.js';
import {defineDatabase,openSQLite,openDeploymentOrchestrator} from '../../dist/index.js';
import {SQLITE_INTERNAL} from '../../dist/sqlite-internal.js';
import {openSupervisorLease,armSupervisorGuardian,linuxProcessBirth} from '../../dist/platform-supervisor.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {deploymentProviderCanaryPath} from '../../dist/provider-service.js';
import * as shadow from '../../dist/managed-shadow.js';

const root=process.env.CLANK_SUPERVISOR_FIXTURE_ROOT,options=JSON.parse(process.env.CLANK_SUPERVISOR_FIXTURE_OPTIONS??'{}');
if(!root || !process.send)throw new Error('Owned shadow controller root and IPC required.');
const send=value=>{if(process.connected)process.send(value)};
const hash=value=>createHash('sha256').update(value).digest('hex');
let platform,server,owner,lease,guardian,database,orchestrator,leaseTimer,projectLease,projectTimer;
const close=async()=>{
  if(platform){await server.close();await platform.close();return;}
  await owner?.close();clearInterval(projectTimer);if(projectLease)await orchestrator.releaseLease(projectLease);
  await guardian?.stop();clearInterval(leaseTimer);orchestrator?.close();database?.close();lease?.release();lease?.close();
};
if(process.env.CLANK_SHADOW_NATIVE_OWNER==='1'){
  // This private lifecycle proof consumes actual platform-created artifacts and
  // rows, with genuine native supervisor/project capabilities. It does not
  // exercise the unexposed human start or Linux host-certification admission.
  const input=JSON.parse(process.env.CLANK_SHADOW_NATIVE_INPUT),projectId=input.projectId;
  lease=await openSupervisorLease(join(root,'control.sqlite'),options.supervisor);if(!lease.acquire())throw new Error('Owned source could not acquire actual leadership.');
  leaseTimer=setInterval(()=>lease.renew(),1000);leaseTimer.unref();guardian=await armSupervisorGuardian(root,lease);
  database=await openSQLite(defineDatabase({}),{path:join(root,'control.sqlite')});const internal=database[SQLITE_INTERNAL];
  const schema={prepare:sql=>internal.prepare(sql==='PRAGMA table_list'?'SELECT * FROM pragma_table_list':sql)};
  internal.guardWrites(()=>lease.assertCurrent(schema));orchestrator=openDeploymentOrchestrator(database,{distributedLeaseMs:30000});
  const key=await readFile(join(root,'master.key')),project=internal.prepare('SELECT * FROM clank_platform_projects WHERE id=?').get(projectId),candidate=internal.prepare('SELECT * FROM clank_platform_releases WHERE id=?').get(input.releaseId);
  if(!project?.active_release_id || project.placement!=='provider' || !candidate || candidate.project_id!==projectId || candidate.purpose!=='shadow-upload' || candidate.status!=='staged' || candidate.artifact_available!==1)throw new Error('Real staged candidate and active provider primary required.');
  const generation=project.active_generation,controlToken='clnkc_'+createHmac('sha256',key).update('clank-provider-control\0'+projectId+'\0'+generation).digest('base64url'),ingressToken='clnki_'+createHmac('sha256',key).update('clank-provider-ingress\0'+projectId+'\0'+generation).digest('base64url');
  const current=()=>{lease.assertCurrent(schema);if(!projectLease || !internal.prepare('SELECT 1 FROM clank_distributed_leases WHERE resource=? AND owner=? AND token_hash=? AND fence=? AND expires_at>?').get(projectLease.resource,projectLease.owner,createHash('sha256').update(projectLease.token).digest('base64url'),projectLease.fence,Date.now()))throw new Error('Actual shadow project lease lost.');};
  const read=()=>{const row=internal.prepare('SELECT * FROM clank_platform_provider_canaries WHERE project_id=?').get(projectId);if(!row)return null;const record=shadow.readShadowRecord(row,projectId,hash);shadow.assertShadowReplay(internal,projectId,record,hash);return record};
  const control=async(action,value,guard,signal,bytes)=>{guard();const response=await fetch(new URL(deploymentProviderCanaryPath(projectId,action),input.endpoint),{method:action==='binding'?'GET':'POST',headers:{authorization:'Bearer '+controlToken,...(action==='binding'?{}:{'content-type':bytes?'application/vnd.clank.runtime':'application/json',...(bytes?{'x-clank-canary-input':JSON.stringify(value)}:{})})},...(action==='binding'?{}:{body:bytes??JSON.stringify(value)}),signal,redirect:'error'});guard();const body=await response.json();guard();if(response.status!==200)throw new Error('Exact native provider control refused: '+response.status);return body[action==='binding'?'binding':action==='retire'?'retirement':'state'];};
  const adapter={read,save:(id,prior,op,guard)=>shadow.saveShadowRecord(internal,id,prior,op,guard,hash),
    retire:async(id,record,guard)=>{const op=record.operation;return control('retire',{primary:op.primary,operationId:op.operationId,controllerEpoch:op.controllerEpoch,releaseId:op.releaseId,capsuleSha256:op.capsuleSha256,retirementEpoch:op.retirementEpoch},guard)},
    lock:async(id,work)=>{projectLease=await orchestrator.acquireLease('project:'+id,'shadow-source-'+lease.owner);if(!projectLease)throw new Error('Actual project lock unavailable.');projectTimer=setInterval(async()=>{projectLease=await orchestrator.renewLease(projectLease)},10000);try{return await work()}finally{clearInterval(projectTimer);await orchestrator.releaseLease(projectLease);projectLease=null}},
    authority:()=>current,scope:async(guard,work)=>{guard();return work()},admit:()=>current(),begin:(id,op,guard)=>shadow.saveShadowRecord(internal,id,null,op,guard,hash),
    prepare:async(id,record,change,guard,signal)=>{
      const bytes=await readFile(join(root,'projects',projectId,'artifacts',candidate.id+'.clank.gz'));guard();if(hash(bytes)!==candidate.digest)throw new Error('Staged artifact digest differs.');
      const config=JSON.parse(candidate.config),capsule=await createDeploymentRuntimeCapsule({projectId,releaseId:candidate.id,generation:1,artifact:bytes,environment:{},database:{path:config.database.path,mode:'preserve'},ingress:{route:'/v1/clank/apps/'+projectId,token:ingressToken}});guard();
      change(op=>({...op,capsuleSha256:capsule.sha256,updatedAt:Math.max(Date.now(),op.updatedAt)}));const binding=await control('binding',null,guard,signal);
      change(op=>({...op,primary:binding,phase:'preparing',updatedAt:Math.max(Date.now(),op.updatedAt)}));send({kind:'preparing',pid:process.pid,birth:lease.processBirth,record:read()});
      const op=record().operation,state=await control('prepare',{primary:binding,operationId:op.operationId,controllerEpoch:op.controllerEpoch,releaseId:op.releaseId,capsuleSha256:op.capsuleSha256,purpose:'shadow',stateProtocol:'clank-provider-canary/2'},guard,signal,capsule.bytes);
      return{sha256:state.snapshot.sha256,bytes:state.snapshot.bytes,providerStartedAt:state.snapshot.startedAt,providerCompletedAt:state.snapshot.completedAt,platformObservedAt:Date.now()};
    },onError:error=>send({kind:'owner-error',error:String(error)})};
  owner=shadow.createShadowController(adapter);const configured=shadow.normalizeShadowPolicy(options.shadowTraffic),epoch=Number(project.provider_canary_epoch)+1,now=Date.now(),sessionId='shadow_'+randomUUID();
  const record=await owner.start(projectId,{kind:'shadow',sessionId,operationId:'shadowop_'+randomUUID(),idempotencyKeyDigest:hash(sessionId),inputDigest:hash('input:'+sessionId),reviewDigest:hash('review:'+sessionId),releaseId:candidate.id,artifactSha256:candidate.digest,capsuleSha256:null,controllerEpoch:epoch,retirementEpoch:epoch,primary:null,primaryReleaseId:project.active_release_id,primaryFence:Number(internal.prepare('SELECT fence FROM clank_deployment_project_fences WHERE project_id=?').get(projectId).fence),nodeId:project.provider_node_id,origin:input.endpoint,credentialGeneration:generation,policyRevision:configured.revision,policyDigest:hash(JSON.stringify(configured)),policy:shadow.narrowShadowPolicy(configured,{}),maxReports:configured.maxReports,phase:'binding',outcome:null,stopRequested:false,snapshot:null,report:shadow.emptyShadowReport(),reservations:[],retirement:null,createdAt:now,expiresAt:now+configured.maxDurationMs,updatedAt:now},current);
  send({kind:'ready',pid:process.pid,birth:lease.processBirth,record});
}else{
  platform=await openPlatform({dataDirectory:root,publicUrl:'http://127.0.0.1:42431',hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:false,...options,onError:error=>send({kind:'platform-error',error:String(error)})});
  server=await serve(platform.handle,{hostname:'127.0.0.1',port:0});send({kind:'ready',pid:process.pid,birth:await linuxProcessBirth(process.pid),url:server.url,status:platform.supervisor()});
}
process.on('message',message=>void(async()=>{
  if(message?.kind==='stop'){await close();send({kind:'stopped',id:message.id});process.disconnect();return}
  if(message?.kind==='status'){send({kind:'status',id:message.id,status:platform?.supervisor()});return}
  if(message?.kind==='request'&&platform){const response=await platform.handle(new Request(message.url,{method:message.method,headers:message.headers,...(message.body===null?{}:{body:Buffer.from(message.body,'base64')})}));send({kind:'response',id:message.id,status:response.status,headers:[...response.headers],body:Buffer.from(await response.arrayBuffer()).toString('base64')});}
})().catch(error=>send({kind:'error',id:message?.id,error:String(error)})));
