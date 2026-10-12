// Opt-in actual Docker domain/native SQLite ownership proof. No runtime launch,
// readiness, writer admission, provider-wide stop or host certificate is claimed.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as h from '../../dist/provider-handoff.js';
import {providerDockerClient} from '../../dist/provider-docker-client.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const image=process.argv[2];assert.match(image,/^sha256:[a-f0-9]{64}$/);
const directory=fs.mkdtempSync('/var/tmp/clank-source-service-native-'),results=[];
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
try{
 for(const mode of ['normal','copy','duplicate','inode','version','closed','retained']){
  const root=join(directory,mode),config=join(directory,mode+'-docker-config');fs.mkdirSync(config,{mode:0o700});
  let owner,service,reopened;
  try{
   owner=await h.acquireProviderServiceOwnership(root,true);
   const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
   const domain=await h.createProviderHandoffDomain(owner,client,'native_node','native_source_service_'+randomUUID());
   assert.equal(domain.daemonId,'0a2ad0ab-df92-4c7b-a346-3ea757783f52');
   const identity=await h.initializeProviderHandoff(owner,domain),project=await h.installProviderHandoffProject(owner,domain,'native_project'),bridge=await h.enableProviderHandoffBridge(owner,domain,limits);
   const catalog=join(root,'service','handoff','catalogs',project.catalogId,'catalog.sqlite');
   if(mode==='retained'){
    const binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:project.projectId,releaseId:'native_release',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:image,uid:1000,gid:1000,capture:{keyId:'native_key',keySha256:'c'.repeat(64),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
    await h.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)});
    await assert.rejects(h.admitProviderSourceService(bridge),/Retained source state/);owner.close();
    reopened=await h.acquireProviderServiceOwnership(root,true);const nextDomain=await h.createProviderHandoffDomain(reopened,client,'native_node',domain.owner),next=await h.enableProviderHandoffBridge(reopened,nextDomain,limits);
    assert.equal(next.mode,'cleanup-only');await assert.rejects(h.admitProviderSourceService(next),/live provider bridge/);
   }else{
    const pending=h.admitProviderSourceService(bridge);
    if(mode==='duplicate')await assert.rejects(h.admitProviderSourceService(bridge),/already reserved/);
    service=await pending;assert.equal(h.providerSourceServiceOwner(service),owner);assert.equal(service.ownerLabel,domain.owner);
    await service.verifyCurrent();assert.equal('launch'in service,false);assert.equal('ready'in service,false);
    if(mode==='copy'){let reads=0;const fake={get root(){reads++;throw Error('must not inspect copied owner');}};for(const value of [{...service},new Proxy(service,{}),fake])assert.throws(()=>h.providerSourceServiceOwner(value),/genuine/);assert.equal(reads,0);}
    if(mode==='inode'){const backup=join(directory,mode+'-original.sqlite');fs.renameSync(catalog,backup);fs.copyFileSync(backup,catalog);fs.chmodSync(catalog,0o600);assert.throws(()=>service.assertCurrent(),/identity changed/);fs.unlinkSync(catalog);fs.renameSync(backup,catalog);assert.throws(()=>service.assertCurrent(),/closed/);}
    if(mode==='version'){const db=new DatabaseSync(catalog);try{db.prepare('UPDATE clank_provider_handoff_bridge_state SET version=2').run();}finally{db.close();}assert.throws(()=>service.assertCurrent(),/empty catalog observation changed/);const restored=new DatabaseSync(catalog);try{restored.prepare('UPDATE clank_provider_handoff_bridge_state SET version=1').run();}finally{restored.close();}assert.throws(()=>service.assertCurrent(),/closed/);}
    if(mode==='closed'){owner.close();assert.throws(()=>service.assertCurrent(),/native provider owner/);}
    if(['inode','version','closed'].includes(mode))assert.throws(()=>h.providerSourceServiceOwner(service),/closed/);
   }
   results.push({mode,passed:true,daemonId:domain.daemonId});
  }finally{service?.close();owner?.close();reopened?.close();}
  const retained=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===root||path.startsWith(root+'/')?[path]:[];}catch{return [];}});assert.deepEqual(retained,[]);
 }
 console.log(JSON.stringify({version:process.version,passed:true,cases:results,originalPinsReleased:true,containersCreated:0,qualification:'Original Docker domain and native owner/namespace admission only; no captured application, readiness/write/stop/transfer or host certification proof.'}));
}finally{fs.rmSync(directory,{recursive:true,force:true});}
