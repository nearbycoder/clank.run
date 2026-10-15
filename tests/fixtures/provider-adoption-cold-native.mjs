// Independent cold recovery uses ordinary options and native persisted receipts only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {createDeploymentCoordinatorClient} from '../../dist/runner.js';
import {createHttpDeploymentProvider,createDeploymentProviderHandler} from '../../dist/provider.js';
import {decodeDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {serve} from '../../dist/node.js';
import {reopenNativePlatformHandoffProcess} from './provider-platform-handoff-native.mjs';
const processBirth=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];
const absent=({pid,birth})=>{try{assert.notEqual(processBirth(pid),birth);}catch(error){if(error.code!=='ENOENT')throw error;}};
const expected=['activated-target-only','ordinary-adopted-after-all-originals-close','ordinary-adopted-public','source mutation one','source-mutation-two','terminal-inflight-mutation'];
function publicRequest(path){return new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:47331,path,headers:{host:'native-platform.apps.example.test'}},incoming=>resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode})));request.once('error',reject);request.end();});}
export async function recoverNativeAdoptedTarget(input,{crashed=false}={}){
 assert.equal(process.getuid(),1000);assert.ok(input.directory.startsWith('/var/tmp/clank-production-source-'));assert.equal(fs.realpathSync(input.directory),input.directory);const root=fs.statSync(input.directory);assert.equal(root.uid,1000);assert.equal(root.dev,input.directoryIdentity.dev);assert.equal(root.ino,input.directoryIdentity.ino);
 const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.config}}),run=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
 const evidence={mode:crashed?'SIGKILL':'graceful',oldWriter:input.writer};let provider,controller,ingressServer,bridgeServer,complete=false;
 try{
  const daemon=JSON.parse((await run(['info','--format','{{json .ID}}'])).stdout);assert.equal(daemon,'111ee57b-2dc1-470f-b040-f8022be31206');
  const marker=fs.statSync(join(input.targetRoot,'service','.writer.sqlite'));
  if(crashed){
   absent(input.providerProcess);const row=JSON.parse((await run(['container','inspect',input.writer.containerId])).stdout)[0];assert.equal(row.State.Running,true);assert.equal(row.State.Pid,input.writer.pid);assert.equal(processBirth(input.writer.pid),input.writer.birth);
   const response=await fetch('http://127.0.0.1:47131/healthz?mutation=adopted-orphan-final-write',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);await response.json();evidence.orphanCommittedFinalWrite=true;
  }
  const reference=JSON.parse((await run(['image','inspect',input.image,'--format','{{json .RepoDigests}}'])).stdout)[0];
  const options={rootDirectory:input.targetRoot,owner:input.owner,image:reference,data:{maxDatabaseBytes:input.databaseMaximum},docker:{executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.config},portStart:47131,portEnd:47131}};
  const permissionPath=join(input.targetRoot,'service','.handoff-target-adoption.sqlite'),permission=new DatabaseSync(permissionPath),originalHash=permission.prepare('SELECT input_sha256 FROM clank_provider_target_adoption').get().input_sha256;
  try{permission.prepare('UPDATE clank_provider_target_adoption SET input_sha256=?').run('0'.repeat(64));await assert.rejects(openDockerDeploymentProviderService(options),/adoption record differs/);}finally{permission.prepare('UPDATE clank_provider_target_adoption SET input_sha256=?').run(originalHash);permission.close();}evidence.corruptReceiptRefusesAdmission=true;
  if(crashed){
   assert.equal(processBirth(input.writer.pid),input.writer.birth);await run(['container','update','--cpus','2',input.writer.containerId]);
   try{await assert.rejects(openDockerDeploymentProviderService(options),/native configuration differs/);assert.equal(processBirth(input.writer.pid),input.writer.birth);}finally{await run(['container','update','--cpus','1',input.writer.containerId]);}evidence.changedNativeConfigurationRefusesAdmission=true;
  }
  provider=await openDockerDeploymentProviderService(options);
  assert.equal((await run(['container','ls','--all','--no-trunc','--filter','id='+input.writer.containerId,'--format','{{.ID}}'])).stdout.trim(),'');absent(input.writer);
  const after=fs.statSync(join(input.targetRoot,'service','.writer.sqlite'));assert.equal(after.dev,marker.dev);assert.equal(after.ino,marker.ino);
  const progress=await provider.inspect(input.projectId);assert.equal(progress.fence,3);assert.equal(progress.phase,'reconciling');evidence.noRunningStatusBeforeReconcile=true;evidence.originalWriterAbsentBeforeReconcile=true;evidence.writerLockFilePreserved=true;
  const observerDeadline=performance.now()+5000;for(const observer of input.outputObservers??[]){for(;;){try{absent(observer);break;}catch(error){if(performance.now()>=observerDeadline)throw error;await new Promise(resolve=>setTimeout(resolve,25));}}}evidence.oldOutputObserversAbsent=true;
  ingressServer=await serve(request=>provider.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
  const credentials=(await import('./provider-platform-handoff-native.mjs')).nativePlatformCredentials(Buffer.alloc(32,37),2,input.projectId);
  const unavailable=await fetch('http://127.0.0.1:47431'+credentials.route+'/healthz',{headers:{'x-clank-project-id':input.projectId,'x-clank-runtime-protocol':'clank-runtime/1','x-clank-runtime-generation':'2','x-clank-runtime-ingress':credentials.token},signal:AbortSignal.timeout(15000)});assert.equal(unavailable.status,503);await unavailable.text();
  controller=await reopenNativePlatformHandoffProcess(input.directory,Buffer.alloc(32,37),{projectId:input.projectId,releaseId:input.releaseId,api:true,adoption:true});evidence.controllerProcess={pid:controller.pid,birth:controller.birth};
  const coordinator=createDeploymentCoordinatorClient({baseUrl:'http://127.0.0.1:47451'}),session=await coordinator.register('native-platform-registration-12345678901234567890',{id:'native_target',region:'native',capacity:1,endpoint:'http://127.0.0.1:47431',labels:{provider:'http'}});
  await controller.enqueue({projectId:input.projectId,action:'reconcile',nodeId:'native_target',payload:{releaseId:input.releaseId,state:'running',generation:2,runtimeProtocol:'clank-runtime/1'},idempotencyKey:'native-adoption-cold-reconcile'});
  const operation=(await coordinator.claim('native_target',session.token,1))[0];assert.ok(operation);assert.equal(operation.fence,4);assert.equal(await controller.authenticateOperation(operation),true);
  const [wire,artifact]=await Promise.all([coordinator.runtime('native_target',session.token,operation),coordinator.artifact('native_target',session.token,operation)]),runtime=await decodeDeploymentRuntimeCapsule(wire.bytes,{maxDatabaseBytes:input.databaseMaximum});assert.equal(runtime.sha256,input.capsuleSha256);assert.equal(artifact.sha256,runtime.artifact.sha256);
  const token=randomBytes(32).toString('base64url'),handler=createDeploymentProviderHandler(provider,{token,maxRuntimeBytes:runtime.bytes.byteLength});bridgeServer=await serve(request=>handler.handle(request),{hostname:'127.0.0.1',port:47461,maxBodySize:runtime.bytes.byteLength,allowedHosts:['127.0.0.1:47461']});
  const httpProvider=createHttpDeploymentProvider({baseUrl:'http://127.0.0.1:47461',token,retries:0});
  await httpProvider.reconcile({operation:{id:operation.id,projectId:operation.projectId,fence:operation.fence,attempt:operation.attempts,maxAttempts:operation.maxAttempts},desired:{generation:2,releaseId:input.releaseId,state:'running',runtimeProtocol:'clank-runtime/1'},runtime,artifact:runtime.artifact,signal:new AbortController().signal});
  assert.equal(await controller.authenticateOperation(operation),true);assert.equal(await coordinator.observe('native_target',session.token,{projectId:input.projectId,generation:2,releaseId:input.releaseId,state:'running'}),true);
  const response=await publicRequest('/healthz?mutation=ordinary-adoption-cold-recovered');assert.equal(response.status,200);assert.equal((await response.json()).rows,crashed?7:6);
  assert.equal(await coordinator.complete('native_target',session.token,operation,{generation:2,releaseId:input.releaseId,state:'running'}),true);assert.equal((await provider.inspect(input.projectId)).phase,'running');assert.equal((await provider.inspect(input.projectId)).fence,4);
  const db=new DatabaseSync(input.databasePath,{readOnly:true});try{const values=db.prepare("SELECT json_extract(_data,'$.value') value FROM clank_records ORDER BY value").all().map(row=>row.value);assert.deepEqual(values,[...expected,...(crashed?['adopted-orphan-final-write']:[]),'ordinary-adoption-cold-recovered'].sort());assert.equal(db.prepare('SELECT value FROM seed').get().value,'ordinary-before-capture');evidence.rows=values.length;}finally{db.close();}
  assert.ok(fs.existsSync(join(input.targetRoot,'service','.handoff-target-owner.sqlite')));assert.ok(fs.existsSync(join(input.targetRoot,'service','.handoff-target-adoption.sqlite')));assert.equal(fs.existsSync(join(input.targetRoot,'service','.handoff-target-restart.sqlite')),false);
  evidence.freshHTTPLeaseAndRuntimeDownload=true;evidence.realHTTPProviderReconcile=true;evidence.publicRouteAndWriteRecovered=true;evidence.adoptionMarkersRetained=true;complete=true;
 }finally{const errors=[];for(const cleanup of [()=>bridgeServer?.close(),()=>ingressServer?.close(),()=>provider?.close(),()=>controller?.close()])try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Native adoption cold recovery cleanup failed.');}
 assert.equal(complete,true);assert.equal((await run(['container','ls','--all','--no-trunc','--filter','label=run.clank.managed=provider-runtime','--filter','label=run.clank.owner='+input.owner,'--format','{{.ID}}'])).stdout.trim(),'');
 evidence.complete=true;return evidence;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const checkpoint=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));try{const result=await recoverNativeAdoptedTarget(checkpoint,{crashed:true});process.stdout.write(JSON.stringify(result)+'\n');}catch(error){process.stdout.write(JSON.stringify({complete:false,failure:{message:error.message,stack:error.stack}})+'\n');process.exitCode=1;}
}
