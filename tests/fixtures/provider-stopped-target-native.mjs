// Original Docker target remains created/never-started; no activation or source-stop claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import * as h from '../../dist/provider-handoff.js';
import {createStoppedProviderTarget,assertProviderStoppedTarget} from '../../dist/provider-target-stage.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const image=process.argv[2],mode=process.argv[3]??'normal';assert.match(image,/^sha256:[a-f0-9]{64}$/);assert.ok(['normal','premature-start','release-change','release-restored','release-add','competing-mount','bounded-inventory','owner-close','cleanup-race'].includes(mode));
const directory=fs.mkdtempSync('/var/tmp/clank-stopped-target-'),root=join(directory,'provider'),source=join(directory,'source'),dockerConfig=join(directory,'docker-config');
fs.mkdirSync(source);fs.mkdirSync(join(source,'dist'));fs.mkdirSync(join(source,'migrations'));fs.mkdirSync(dockerConfig,{mode:0o700});
fs.writeFileSync(join(source,'dist','server.js'),"import fs from 'node:fs';import http from 'node:http';fs.writeFileSync('/data/application-started','evaluated');http.createServer((req,res)=>res.end('approved target app')).listen(Number(process.env.PORT),'0.0.0.0');\n");
fs.writeFileSync(join(source,'migrations','0001_seed.sql'),'CREATE TABLE seed(id INTEGER PRIMARY KEY,value TEXT);');
const delayFlag=join(directory,'delay-mount-inspection'),wrapper=join(directory,'docker-client.mjs');
if(mode==='bounded-inventory')fs.writeFileSync(wrapper,'#!'+process.execPath+'\n'+`import fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(fs.existsSync(${JSON.stringify(delayFlag)})&&args[0]==='container'&&args[1]==='inspect'&&args[2]==='--format'&&args[3]==='[{{json .Id}},{{json .Mounts}}]')await new Promise(resolve=>setTimeout(resolve,4000));const result=spawnSync('/usr/bin/docker',args,{stdio:'inherit'});process.exit(result.status??1);\n`,{mode:0o700});
const removalFlag=join(directory,'original-target-removed-before-owner-command');
if(mode==='cleanup-race')fs.writeFileSync(wrapper,'#!'+process.execPath+'\n'+`import fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='container'&&args[1]==='rm'&&!fs.existsSync(${JSON.stringify(removalFlag)})){const removed=spawnSync('/usr/bin/docker',args,{stdio:'pipe'});if(removed.status!==0)process.exit(removed.status??1);fs.writeFileSync(${JSON.stringify(removalFlag)},args.at(-1),{mode:0o600,flag:'wx'});}const result=spawnSync('/usr/bin/docker',args,{stdio:'inherit'});process.exit(result.status??1);\n`,{mode:0o700});
const client=providerDockerClient({executable:['bounded-inventory','cleanup-race'].includes(mode)?wrapper:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:dockerConfig}});
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const label='native_stopped_target_'+randomUUID(),project='target_project',limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const proof={node:process.version,root,mode,image,scope:'Actual approved target artifact, original owner/domain/workspace and Docker created-never-started suspension; no source binding, target restore receipts, activation or all-role handoff'};
let owner,workspace,target,competing;const inventoryContainers=[];let failed;
const removeInventoryContainers=async()=>{
 if(fs.existsSync(delayFlag))fs.unlinkSync(delayFlag);
 while(inventoryContainers.length){const id=inventoryContainers.at(-1),row=JSON.parse((await command(['container','inspect',id])).stdout)[0];assert.equal(row.Id,id);assert.equal(row.Image,image);assert.equal(row.Config.Labels['run.clank.test.owner'],label);assert.equal(row.State.Status,'created');assert.equal(row.State.Pid,0);assert.equal(row.Mounts.length,0);await command(['container','rm',id]);inventoryContainers.pop();}
};
const removeCompeting=async()=>{
 if(!competing)return;
 const row=JSON.parse((await command(['container','inspect',competing])).stdout)[0];
 assert.equal(row.Id,competing);assert.equal(row.Image,image);assert.equal(row.State.Status,'created');assert.equal(row.State.Pid,0);
 assert.equal(row.Config.Labels['run.clank.test.owner'],label);assert.equal(row.Mounts.length,1);assert.equal(row.Mounts[0].Source,workspace.dataDirectory);assert.equal(row.Mounts[0].RW,true);
 await command(['container','rm',competing]);competing=undefined;
};
const pins=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const p=fs.readlinkSync('/proc/self/fd/'+fd);return p===root||p.startsWith(root+'/')?[p]:[];}catch{return [];}});
try{
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,client,'native_target',label);assert.equal(domain.daemonId,'111ee57b-2dc1-470f-b040-f8022be31206');
 await h.initializeProviderHandoff(owner,domain);await h.installProviderHandoffProject(owner,domain,project);const bridge=await h.enableProviderHandoffBridge(owner,domain,limits);workspace=await h.retainProviderTargetWorkspace(bridge,project);
 const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'target.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/health',timeoutMs:15000},env:{}},{frameworkVersion:'0.24.0-test',nodeVersion:process.version,frameworkRoot:fileURLToPath(new URL('../../',import.meta.url))});
 const capsule=await createDeploymentRuntimeCapsule({projectId:project,releaseId:'target_release',generation:2,environment:{TARGET_TEST_VALUE:'approved value'},database:{path:'target.sqlite',mode:'preserve'},ingress:{route:'/v1/clank/apps/'+project,token:'clanki_stopped-target-fixture-1234567890'},artifact});
 target=await createStoppedProviderTarget(workspace,capsule.bytes,image,47131);assertProviderStoppedTarget(target);await target.verifySuspended();assert.throws(()=>assertProviderStoppedTarget({...target}),/genuine original/);
 const row=JSON.parse((await command(['container','inspect',target.containerId])).stdout)[0];assert.equal(row.State.Status,'created');assert.equal(row.State.Running,false);assert.equal(row.State.Pid,0);assert.equal(row.Config.User,'1000:1000');assert.equal(row.HostConfig.Memory,536870912);assert.equal(row.HostConfig.ReadonlyRootfs,true);
 assert.equal(fs.existsSync(join(workspace.dataDirectory,'application-started')),false);assert.equal(fs.readFileSync(join(workspace.releaseDirectory,'dist','server.js'),'utf8'),fs.readFileSync(join(source,'dist','server.js'),'utf8'));
 proof.originalCreatedSuspension=true;proof.approvedReleaseInstalled=true;proof.applicationNotEvaluated=true;proof.copiedTargetRefused=true;proof.targetId=target.containerId;
 if(mode==='premature-start'){
  await command(['container','start',target.containerId]);
  const started=JSON.parse((await command(['container','inspect',target.containerId])).stdout)[0];
  proof.dockerConfigurationChangedFields=['Config','HostConfig','Mounts','AppArmorProfile'].filter(key=>JSON.stringify(row[key])!==JSON.stringify(started[key]));
  proof.dockerHostChanges=Object.fromEntries(Object.keys(row.HostConfig).filter(key=>JSON.stringify(row.HostConfig[key])!==JSON.stringify(started.HostConfig[key])).map(key=>[key,{created:row.HostConfig[key],started:started.HostConfig[key]}]));
  proof.createdMounts=row.Mounts;proof.startedMounts=started.Mounts;
  proof.createdAppArmorProfile=row.AppArmorProfile;proof.startedAppArmorProfile=started.AppArmorProfile;
  await assert.rejects(target.verifySuspended(),/never-started|suspended/);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);proof.prematureStartFenced=true;
 }else if(mode==='release-change'){
  fs.appendFileSync(join(workspace.releaseDirectory,'dist','server.js'),'changed');await assert.rejects(target.verifySuspended(),/release identity|release bytes/);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);proof.changedReleaseFenced=true;
 }else if(mode==='release-restored'){
  const path=join(workspace.releaseDirectory,'dist','server.js'),original=fs.readFileSync(path),before=fs.statSync(path,{bigint:true}),changed=Buffer.from(original);changed[0]^=1;
  const file=fs.openSync(path,'r+');try{fs.writeSync(file,changed,0,changed.length,0);fs.fsyncSync(file);fs.writeSync(file,original,0,original.length,0);fs.fsyncSync(file);}finally{fs.closeSync(file);changed.fill(0);}
  assert.deepEqual(fs.readFileSync(path),original);const after=fs.statSync(path,{bigint:true});assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);assert.notEqual(after.ctimeNs,before.ctimeNs);
  await assert.rejects(target.verifySuspended(),/release bytes or metadata/);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);proof.restoredReleaseBytesRemainFenced=true;proof.originalReleaseIdentityAndBytesRestored=true;
 }else if(mode==='release-add'){
  fs.writeFileSync(join(workspace.releaseDirectory,'unexpected.js'),'unapproved artifact');await assert.rejects(target.verifySuspended(),/release inventory/);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);proof.unapprovedReleaseEntryFenced=true;
 }else if(mode==='competing-mount'){
  competing=(await command(['container','create','--pull','never','--network','none','--label','run.clank.test.owner='+label,'--mount','type=bind,source='+workspace.dataDirectory+',target=/data',image,'node','-e','process.exit(0)'])).stdout.trim();assert.match(competing,/^[a-f0-9]{64}$/);
  await assert.rejects(target.verifySuspended(),/competing writable container mount/);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);proof.unlabeledCompetingWriterMountFenced=true;
  await removeCompeting();proof.exactOwnedCompetingContainerRemoved=true;
 }else if(mode==='bounded-inventory'){
  for(let i=0;i<8;i++){const id=(await command(['container','create','--pull','never','--network','none','--label','run.clank.test.owner='+label,image,'node','-e','process.exit(0)'])).stdout.trim();assert.match(id,/^[a-f0-9]{64}$/);inventoryContainers.push(id);}
  fs.writeFileSync(delayFlag,'fixture delays only mount observations by four seconds each',{mode:0o600});const start=performance.now();
  await assert.rejects(target.verifySuspended(),/deadline|timed out|due to timeout/);proof.inventoryDeadlineElapsedMs=performance.now()-start;assert.ok(proof.inventoryDeadlineElapsedMs>=27000&&proof.inventoryDeadlineElapsedMs<34000);assert.throws(()=>assertProviderStoppedTarget(target),/fenced/);
  proof.originalOperationTimeoutMs=limits.controlTimeoutMs;proof.aggregateInventoryDeadlineFenced=true;await removeInventoryContainers();proof.exactOwnedInventoryContainersRemoved=true;
 }else if(mode==='owner-close'){
  owner.close();owner=undefined;assert.throws(()=>assertProviderStoppedTarget(target),/closed|fenced/);proof.ownerCloseFenced=true;
 }
 await target.close();const remaining=(await command(['container','ls','--all','--no-trunc','--filter','id='+target.containerId,'--format','{{.ID}}'])).stdout.trim();assert.equal(remaining,'');proof.exactOwnedContainerRemoved=true;
 if(mode==='cleanup-race'){assert.equal(fs.readFileSync(removalFlag,'utf8'),target.containerId);proof.failedRemovalAfterActualIndependentRemovalSettled=true;await target.close();}
 workspace.close();owner?.close();owner=undefined;assert.equal(pins().length,0);proof.complete=true;
}catch(error){failed=error;proof.complete=false;proof.failure={message:error.message,stack:error.stack,errors:error.errors?.map(e=>({message:e.message,errors:e.errors?.map(x=>x.message)}))};}
finally{try{await removeInventoryContainers();await removeCompeting();await target?.close();workspace?.close();owner?.close();}catch(error){proof.cleanupFailure={message:error.message,errors:error.errors?.map(x=>x.message)};failed??=error;}proof.pinsAfterCleanup=pins().length;console.log(JSON.stringify(proof));}
if(failed)process.exitCode=1;
