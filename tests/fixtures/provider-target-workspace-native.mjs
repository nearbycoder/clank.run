// Actual original Docker domain and native target admission; no stopped runtime claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import * as h from '../../dist/provider-handoff.js';
import {providerDockerClient} from '../../dist/provider-docker-client.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const daemon=process.env.CLANK_SOURCE_EXPECTED_DAEMON_ID;assert.equal(daemon,'111ee57b-2dc1-470f-b040-f8022be31206');
const directory=fs.mkdtempSync('/var/tmp/clank-target-workspace-'),root=join(directory,'provider'),config=join(directory,'docker-config');
fs.mkdirSync(config,{mode:0o700});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
const label='native_target_'+randomUUID(),project='target_project';
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const proof={node:process.version,root,scope:'Original non-root provider ownership, actual retained Docker domain and pinned native target workspace; no runtime suspension, restored data, target receipt or writer admission'};
const pins=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const p=fs.readlinkSync('/proc/self/fd/'+fd);return p===root||p.startsWith(root+'/')?[p]:[];}catch{return [];}});
let owner,workspace,reopened;let failure;
try{
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,client,'native_target',label);assert.equal(domain.daemonId,daemon);
 await h.initializeProviderHandoff(owner,domain);await h.installProviderHandoffProject(owner,domain,project);const bridge=await h.enableProviderHandoffBridge(owner,domain,limits);
 const opening=h.retainProviderTargetWorkspace(bridge,project);await assert.rejects(h.admitProviderSourceService(bridge),/target admission/);workspace=await opening;h.assertProviderTargetWorkspace(workspace);await workspace.verifyCurrent();proof.reservationExcludesConcurrentSource=true;
 assert.equal(workspace.nodeId,'native_target');assert.deepEqual(fs.readdirSync(workspace.dataDirectory),[]);assert.deepEqual(fs.readdirSync(workspace.releaseDirectory),[]);
 assert.throws(()=>h.assertProviderTargetWorkspace({...workspace}),/genuine original/);proof.originalNativeAdmission=true;proof.copiedWorkspaceRefused=true;
 await assert.rejects(h.admitProviderSourceService(bridge),/target admission/);h.assertProviderTargetWorkspace(workspace);proof.sourceStartupRefused=true;
 const marker=join(root,'service','.handoff-target-owner.sqlite'),digest=createHash('sha256').update(fs.readFileSync(marker)).digest('hex');
 const held=workspace.dataDirectory+'-original';fs.renameSync(workspace.dataDirectory,held);fs.mkdirSync(workspace.dataDirectory,{mode:0o700});fs.writeFileSync(join(workspace.dataDirectory,'foreign'),'preserved');
 assert.throws(()=>workspace.assertCurrent(),/identity changed/);assert.equal(fs.readFileSync(join(workspace.dataDirectory,'foreign'),'utf8'),'preserved');proof.replacementFencedWithoutAdoption=true;
 owner.close();owner=undefined;assert.equal(pins().length,0);proof.originalPinsReleased=true;
 reopened=await h.acquireProviderServiceOwnership(root);await assert.rejects(h.admitProviderService(reopened,client,label),/target admission/);reopened.close();reopened=undefined;
 assert.equal(createHash('sha256').update(fs.readFileSync(marker)).digest('hex'),digest);assert.equal(fs.readFileSync(join(workspace.dataDirectory,'foreign'),'utf8'),'preserved');proof.restartCannotAdmitOrdinaryWriter=true;proof.retainedAdmissionUnchanged=true;proof.complete=true;
}catch(error){failure=error;proof.complete=false;proof.failure={message:error.message,stack:error.stack};}
finally{
 try{workspace?.close();reopened?.close();owner?.close();}catch(error){proof.cleanupFailure=error.message;failure??=error;}
 proof.pinsAfterCleanup=pins().length;console.log(JSON.stringify(proof));
}
if(failure)process.exitCode=1;
