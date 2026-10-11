// Native SQLite and HTTP fixture with injected runtime/ingress. Not Docker proof.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDeploymentBundle } from '../../dist/deploy.js';
import { createDeploymentRuntimeCapsule } from '../../dist/runtime-placement.js';
import { openDeploymentProviderDataStore } from '../../dist/provider-data.js';
import { openDeploymentProviderService } from '../../dist/provider-service.js';
const openCurrent=process.env.CLANK_SHADOW_TEST_BASELINE==='1'?(await import('./provider-service-v1-215f594.mjs')).openDeploymentProviderService:openDeploymentProviderService;
export const projectId='project_shadow_01';
export const token='clankc_shadow-provider-control-token-12345678901234567890';
export const shadow={purpose:'shadow',stateProtocol:'clank-provider-canary/2'};
export const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
export const input=runtime=>({operation:{id:`operation_${runtime.manifest.generation}`,projectId,fence:runtime.manifest.generation,attempt:1,maxAttempts:1},desired:{generation:runtime.manifest.generation,state:'running',releaseId:runtime.manifest.releaseId,runtimeProtocol:runtime.manifest.protocol},runtime,artifact:runtime.artifact,signal:new AbortController().signal});
export function controlRequest(operation,body,options={}) {
  const headers={authorization:`Bearer ${options.token??token}`,'x-clank-provider-canary-protocol':'clank-provider-canary-control/1'};
  if(operation==='binding')return new Request(`http://127.0.0.1/v1/clank/control/${projectId}/canary/binding`,{headers});
  if(operation==='prepare') {
    Object.assign(headers,{'content-type':'application/vnd.clank.runtime','content-length':String(body.runtime.bytes.byteLength),'x-clank-canary-input':JSON.stringify({primary:body.primary,operationId:body.operationId,controllerEpoch:body.controllerEpoch,releaseId:body.runtime.manifest.releaseId,capsuleSha256:body.runtime.sha256,...(options.pair??shadow)})});
    return new Request(`http://127.0.0.1/v1/clank/control/${projectId}/canary/prepare`,{method:'POST',headers,body:body.runtime.bytes});
  }
  const json=JSON.stringify(body);Object.assign(headers,{'content-type':'application/json','content-length':String(Buffer.byteLength(json))});
  return new Request(`http://127.0.0.1/v1/clank/control/${projectId}/canary/${operation}`,{method:'POST',headers,body:json});
}
export async function openFixtureService(root,options={}) {
  const data=await openDeploymentProviderDataStore({rootDirectory:root,maxDatabaseBytes:options.maxDatabaseBytes??16*1024*1024});
  const records=new Map(),routes=new Map(),events={snapshots:0,applies:0,deletes:0,launches:0,lastSnapshot:null};
  const wrapped={...data,
    async snapshot(id){events.snapshots++;const snapshot=await data.snapshot(id);events.lastSnapshot=snapshot;return options.snapshot?options.snapshot(snapshot):snapshot;},
    async apply(request,...callbacks){if(request.operation.projectId!==projectId){events.applies++;await options.beforeApply?.(request);}return data.apply(request,...callbacks);},
    async delete(request){events.deletes++;options.onDelete?.(request);return data.delete(request);},
  };
  const runtimes={
    async launch({prepared,isolatedReadOnly}){events.launches++;const candidate={projectId:prepared.projectId,releaseId:prepared.releaseId,generation:prepared.generation,capsuleSha256:prepared.capsuleSha256,upstream:'http://127.0.0.1:46101',...(isolatedReadOnly?{isolatedReadOnly:true}:{})};records.set(candidate.projectId,{...candidate,status:'candidate'});return candidate;},
    async activate(candidate){const value={...candidate,status:'active'};records.set(value.projectId,value);return value;},
    inspect(){return [...records.values()];},async diagnostics(){return null;},async stop(id){return records.delete(id);},async close(){records.clear();},
  };
  const ingress={async activate(value){routes.set(value.projectId,{...value,latest:true});},inspect(){return [...routes.values()];},async handle(){return new Response('fixture');},async deactivate(id){return {removed:routes.delete(id),drained:true};},forget(){return true;},async close(){routes.clear();return true;}};
  const service=await (options.open??openCurrent)({rootDirectory:root,data:wrapped,runtimes,ingress,maxDatabaseBytes:options.maxDatabaseBytes??16*1024*1024,drainTimeoutMs:100,...(options.disabled?{}:{canaries:{readPaths:['/healthz'],maximumDurationMs:30_000,...options.policy}})});
  return {service,data,events,runtimes,ingress};
}
export async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'clank-provider-shadow-')),root=join(directory,'provider');
  const services=[];
  t.after(async()=>{for(const service of services)await service.close();await rm(directory,{recursive:true,force:true});});
  const runtime=async(generation=1,controlToken=token)=>{
    const source=join(directory,`source-${generation}`);await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'migrations'),{recursive:true});
    await writeFile(join(source,'dist/server.js'),`export const generation=${generation};\n`);
    await writeFile(join(source,'migrations/0001_init.sql'),'CREATE TABLE todo(id TEXT PRIMARY KEY);\n');
    const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:1000},env:{}},{frameworkVersion:'0.9.4-test',nodeVersion:'22.16.0'});
    return createDeploymentRuntimeCapsule({projectId,releaseId:`release_shadow_${generation}`,generation,environment:{PRIVATE_SECRET:'must-not-reach-candidate'},database:{path:'app.sqlite',mode:generation===1?'initialize':'preserve'},ingress:{route:`/v1/clank/apps/${projectId}`,token:'clanki_shadow-private-route-12345678901234567890',controlToken},artifact},{maxDatabaseBytes:16*1024*1024});
  };
  const primaryRuntime=await runtime(),candidateRuntime=await runtime(2);
  const open=async(extra={})=>{const opened=await openFixtureService(root,{...options,...extra});services.push(opened.service);return opened;};
  const opened=await open();await opened.service.reconcile(input(primaryRuntime));
  const primary=await opened.service.canaries?.binding(projectId);
  const prepare={primary,operationId:'shadow_operation_01',controllerEpoch:1,runtime:candidateRuntime,signal:new AbortController().signal,...shadow};
  return {...opened,directory,root,open,runtime,primaryRuntime,candidateRuntime,prepare,
    journal:join(root,'service',`${projectId}.canary.json`),owner:join(root,'service','.canary-controller.json'),
    retirement(state,epoch=state.controllerEpoch){return {primary:state.primary,operationId:state.operationId,controllerEpoch:state.controllerEpoch,releaseId:state.releaseId,capsuleSha256:state.capsuleSha256,retirementEpoch:epoch};},
    async primaryValue(value){const state=await opened.data.inspect(projectId);const sql=new DatabaseSync(join(root,'projects',projectId,state.databasePath));try{sql.prepare('INSERT INTO todo(id) VALUES (?)').run(value);}finally{sql.close();}},
  };
}
