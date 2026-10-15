// A genuinely fresh controller resolves a signed pending publication using the
// original control database and both native roots, then obtains a fresh HTTP lease.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {openPlatform,platformProviderHandoffContext,platformConditionalRecoveryAuthority} from '../../dist/platform.js';
import {recoverProviderHandoffTarget} from '../../dist/orchestration.js';
import {acquireProviderServiceOwnership,providerConditionalRecoveryContext} from '../../dist/provider-handoff.js';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {createDeploymentCoordinatorClient} from '../../dist/runner.js';
import {createHttpDeploymentProvider,createDeploymentProviderHandler} from '../../dist/provider.js';
import {decodeDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {serve} from '../../dist/node.js';
const checkpoint=process.argv[2];assert.match(checkpoint,/^\/var\/tmp\/clank-production-source-[A-Za-z0-9]+\/conditional-recovery-checkpoint\.json$/);assert.equal(fs.realpathSync(checkpoint),checkpoint);assert.equal(fs.statSync(checkpoint).uid,1000);assert.equal(process.getuid(),1000);
const input=JSON.parse(fs.readFileSync(checkpoint,'utf8')),directory=input.directory,root=fs.statSync(directory),projectId=input.pendingProjectId,releaseId=input.pendingReleaseId;
assert.equal(root.uid,1000);assert.equal(fs.realpathSync(directory),directory);assert.ok(['conditional-before','conditional-after','conditional-loss'].includes(input.publicationFault));
const birth=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];const absent=identity=>{try{return birth(identity.pid)!==identity.birth;}catch(error){if(error.code==='ENOENT')return true;throw error;}};assert.equal(absent(input.controllerProcess),true);
const key=Buffer.alloc(32,37),options=dataDirectory=>({dataDirectory,publicUrl:'http://127.0.0.1:47451',masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:47451,appPortEnd:47460,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'native-platform-registration-12345678901234567890',placement:{}}});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.pendingDockerConfig}}),run=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const evidence={mode:input.publicationFault,controllerProcess:{pid:process.pid,birth:birth(process.pid)},oldController:input.controllerProcess};let sourceOwner,targetOwner,platform,copyPlatform,provider,controlServer,publicServer,ingressServer,bridgeServer,heartbeat,heartbeatTail=Promise.resolve(),heartbeatFailure,lease;
const publicRequest=path=>new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:47331,path,headers:{host:'native-platform.apps.example.test'}},incoming=>resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode})));request.once('error',reject);request.end();});
try{
 assert.equal(JSON.parse((await run(['info','--format','{{json .ID}}'])).stdout),input.expectedDaemonId);
 const deadline=performance.now()+15000;while(!input.publicationWatchdogs.every(absent)){assert.ok(performance.now()<deadline,'Independent pending watchdog did not exit');await new Promise(resolve=>setTimeout(resolve,25));}
 const reference=JSON.parse((await run(['image','inspect',input.image,'--format','{{json .RepoDigests}}'])).stdout)[0],providerOptions={rootDirectory:input.pendingTargetRoot,owner:input.pendingTargetOwner,image:reference,data:{maxDatabaseBytes:input.databaseMaximum},docker:{executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:input.pendingDockerConfig},portStart:47131,portEnd:47131}};
 await assert.rejects(openDockerDeploymentProviderService(providerOptions),/Retained target admission refuses ordinary root startup/);evidence.pendingJournalRefusesOrdinaryStartup=true;
 const beforeControl=fs.statSync(input.pendingCoordinatorPath),copied=join(directory,'conditional-copied-platform');fs.cpSync(join(directory,'platform'),copied,{recursive:true,errorOnExist:true,force:false});copyPlatform=await openPlatform(options(copied));
 sourceOwner=await acquireProviderServiceOwnership(input.pendingSourceRoot);targetOwner=await acquireProviderServiceOwnership(input.pendingTargetRoot);
 const pending=providerConditionalRecoveryContext(targetOwner,sourceOwner,client);await assert.rejects(recoverProviderHandoffTarget({},targetOwner,sourceOwner,client),/genuine original platform/);
 await assert.rejects(recoverProviderHandoffTarget(copyPlatform,targetOwner,sourceOwner,client),/native database identity differs/);await copyPlatform.close();copyPlatform=undefined;evidence.copiedControlDatabaseRefused=true;evidence.fakePlatformRefused=true;
 platform=await openPlatform(options(join(directory,'platform')));const context=platformProviderHandoffContext(platform),coordinator=context.orchestrator;
 await coordinator.heartbeat('native_target',input.pendingTargetToken);
 const authority=context.recovery(pending.journal,pending.authentication);await assert.rejects(platformConditionalRecoveryAuthority(authority,pending.journal,pending.authentication).settle({}),/genuine verified native/);evidence.pendingJournalCannotSettleWithoutNativeProof=true;
 const before=coordinator.desired(projectId);assert.equal(before.generation,input.publicationFault==='conditional-before'?1:2);
 const permit=await recoverProviderHandoffTarget(platform,targetOwner,sourceOwner,client);assert.equal(permit.projectId,projectId);assert.equal(coordinator.desired(projectId).observedState,'stopped');assert.equal(coordinator.desired(projectId).generation,2);
 const replay=await recoverProviderHandoffTarget(platform,targetOwner,sourceOwner,client);assert.deepEqual(replay,permit);evidence.recoveryIdempotentObservedStopped=true;
 assert.equal((await run(['container','ls','--all','--no-trunc','--filter','id='+input.pendingTarget.containerId,'--format','{{.ID}}'])).stdout.trim(),'');assert.equal(absent(input.pendingTarget),true);
 const afterControl=fs.statSync(input.pendingCoordinatorPath);assert.equal(afterControl.dev,beforeControl.dev);assert.equal(afterControl.ino,beforeControl.ino);evidence.originalControlIdentityPreserved=true;
 sourceOwner.close();sourceOwner=undefined;targetOwner.close();targetOwner=undefined;
 provider=await openDockerDeploymentProviderService(providerOptions);assert.equal(await provider.inspect(projectId),null);
 controlServer=await serve(request=>platform.handle(request),{hostname:'127.0.0.1',port:47451,allowedHosts:['127.0.0.1:47451']});publicServer=await serve(request=>platform.handle(request),{hostname:'127.0.0.1',port:47331,allowedHosts:['native-platform.apps.example.test']});ingressServer=await serve(request=>provider.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
 const unavailable=await publicRequest('/healthz');assert.equal(unavailable.status,404);await unavailable.text();
 const httpCoordinator=createDeploymentCoordinatorClient({baseUrl:'http://127.0.0.1:47451'}),session=await httpCoordinator.register('native-platform-registration-12345678901234567890',{id:'native_target',region:'native',capacity:1,endpoint:'http://127.0.0.1:47431',labels:{provider:'http'}});assert.notEqual(session.token,input.pendingTargetToken);
 await assert.rejects(httpCoordinator.claim('native_target',input.pendingTargetToken,1),/authentication failed/);
 await coordinator.enqueue({projectId,action:'reconcile',nodeId:'native_target',payload:{releaseId,state:'running',generation:2,runtimeProtocol:'clank-runtime/1'},idempotencyKey:'conditional-native-recovered'});lease=(await httpCoordinator.claim('native_target',session.token,1))[0];assert.ok(lease);assert.equal(lease.fence,3);assert.ok(await coordinator.authenticateOperation(lease));
 heartbeat=setInterval(()=>{heartbeatTail=heartbeatTail.then(async()=>{await httpCoordinator.heartbeat('native_target',session.token);lease=await httpCoordinator.renew('native_target',session.token,lease);assert.ok(lease);}).catch(error=>heartbeatFailure??=error);},1000);heartbeat.unref();
 const [wire,download]=await Promise.all([httpCoordinator.runtime('native_target',session.token,lease),httpCoordinator.artifact('native_target',session.token,lease)]),runtime=await decodeDeploymentRuntimeCapsule(wire.bytes,{maxDatabaseBytes:input.databaseMaximum});assert.equal(runtime.sha256,input.pendingCapsuleSha256);assert.equal(download.sha256,runtime.artifact.sha256);
 const token=randomBytes(32).toString('base64url'),handler=createDeploymentProviderHandler(provider,{token,maxRuntimeBytes:runtime.bytes.byteLength});bridgeServer=await serve(request=>handler.handle(request),{hostname:'127.0.0.1',port:47461,maxBodySize:runtime.bytes.byteLength,allowedHosts:['127.0.0.1:47461']});
 await createHttpDeploymentProvider({baseUrl:'http://127.0.0.1:47461',token,retries:0}).reconcile({operation:{id:lease.id,projectId,fence:lease.fence,attempt:lease.attempts,maxAttempts:lease.maxAttempts},desired:{generation:2,releaseId,state:'running',runtimeProtocol:'clank-runtime/1'},runtime,artifact:runtime.artifact,signal:new AbortController().signal});assert.ok(await coordinator.authenticateOperation(lease));assert.equal(await httpCoordinator.observe('native_target',session.token,{projectId,generation:2,releaseId,state:'running'}),true);
 const response=await publicRequest('/healthz?mutation=conditional-coordinator-recovered');assert.equal(response.status,200);assert.equal((await response.json()).rows,3);
 clearInterval(heartbeat);heartbeat=undefined;await heartbeatTail;if(heartbeatFailure)throw heartbeatFailure;assert.equal(await httpCoordinator.complete('native_target',session.token,lease,{generation:2,releaseId,state:'running'}),true);
 const db=new DatabaseSync(input.pendingTargetDatabase,{readOnly:true});try{assert.deepEqual(db.prepare("SELECT json_extract(_data,'$.value') value FROM clank_records ORDER BY value").all().map(row=>row.value),['conditional-coordinator-recovered','source mutation one','source-mutation-two','terminal-inflight-mutation']);assert.equal(db.prepare('SELECT value FROM seed').get().value,'ordinary-before-capture');}finally{db.close();}
 evidence.freshHTTPLeaseAndArtifact=true;evidence.actualHTTPProviderReconcile=true;evidence.publicRouteAndRecoveredWrite=true;evidence.knownLedgerAndSeedRetained=true;evidence.complete=true;
}catch(error){evidence.complete=false;evidence.failure={message:error.message,stack:error.stack};process.exitCode=1;
}finally{clearInterval(heartbeat);const errors=[];try{await heartbeatTail;}catch(error){errors.push(error);}for(const cleanup of [()=>bridgeServer?.close(),()=>ingressServer?.close(),()=>publicServer?.close(),()=>controlServer?.close(),()=>provider?.close(),()=>targetOwner?.close(),()=>sourceOwner?.close(),()=>copyPlatform?.close(),()=>platform?.close()])try{await cleanup();}catch(error){errors.push(error);}if(errors.length){evidence.cleanupFailures=errors.map(error=>error.message);evidence.complete=false;process.exitCode=1;}key.fill(0);}
evidence.fixturePinsAfterCleanup=fs.readdirSync('/proc/self/fd').filter(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===directory||path.startsWith(directory+'/');}catch{return false;}}).length;if(evidence.fixturePinsAfterCleanup){evidence.complete=false;process.exitCode=1;}process.stdout.write(JSON.stringify(evidence)+'\n');
