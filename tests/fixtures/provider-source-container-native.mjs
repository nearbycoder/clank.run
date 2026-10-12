import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import * as h from '../../dist/provider-handoff.js';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {openDeploymentProviderDataStore} from '../../dist/provider-data.js';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
const hash=v=>createHash('sha256').update(typeof v==='string'||v instanceof Uint8Array?v:JSON.stringify(v)).digest('hex');
const limits={maxProjects:10,maxOperations:32,maxArchiveBytes:33554432,maxBatchEntries:256,maxBatchBytes:4194304,maxCaptureTransactionBytes:4194304,maxCaptureStateBytes:33554432,maxJournalEntries:10000,maxJournalBytes:67108864,maxSpoolBytes:268435456,controlTimeoutMs:30000};
const nonce=randomUUID(),directory=fs.mkdtempSync('/tmp/clank-container-native-'),root=join(directory,'provider'),source=join(directory,'capsule'),image=process.argv[2],mode=process.argv[3]??'stop';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.match(image,/^sha256:[a-f0-9]{64}$/);fs.chmodSync(directory,0o755);
const config=join(directory,'docker-config');fs.mkdirSync(config,{mode:0o700});
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:config}});
const command=(args)=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const events={qualification:'Genuine owner/domain/grant, native data-store commit and C1 acknowledgments, running immutable default-profile container. Admission only; no application capture, worker execution, source readiness, stop certificate or feature07 acceptance.',version:process.version,nonce,directory,image,mode};
let owner,grant,data,container,cid,labels,stage='prepare',failed;
const descriptors=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const stat=fs.fstatSync(Number(fd));return [{fd:Number(fd),path:fs.readlinkSync('/proc/self/fd/'+fd),dev:stat.dev,ino:stat.ino}];}catch{return [];}});
const pins=()=>fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root+'/')?[{fd:Number(fd),path}]:[];}catch{return [];}});
try{
 fs.mkdirSync(source);fs.mkdirSync(join(source,'dist'));fs.mkdirSync(join(source,'migrations'));
 fs.writeFileSync(join(source,'dist','server.js'),'setInterval(()=>{},1000);\n');fs.writeFileSync(join(source,'migrations','0001_seed.sql'),"CREATE TABLE seed(value TEXT); INSERT INTO seed VALUES('approved source');\n");
 const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'source.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:15000},env:{}},{frameworkVersion:'0.9.4-test',nodeVersion:process.version.slice(1)});
 const runtime=await createDeploymentRuntimeCapsule({projectId:'native_project',releaseId:'native_release',generation:1,environment:{},database:{path:'source.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/native_project',token:'clanki_native-test-token-12345678901234567890'},artifact},{maxDatabaseBytes:16777216});
 owner=await h.acquireProviderServiceOwnership(root,true);const domain=await h.createProviderHandoffDomain(owner,client,'native_node','native_owner_'+nonce),identity=await h.initializeProviderHandoff(owner,domain),project=await h.installProviderHandoffProject(owner,domain,'native_project'),bridge=await h.enableProviderHandoffBridge(owner,domain,limits);
 const store=await openDeploymentProviderDataStore({rootDirectory:root,maxDatabaseBytes:16777216});let prepared;
 await store.apply({operation:{id:'native_operation',projectId:project.projectId,fence:1,attempt:1,maxAttempts:3},desired:{generation:1,releaseId:'native_release',state:'running',runtimeProtocol:'clank-runtime/1'},runtime,signal:new AbortController().signal},v=>{prepared=v;});
 const key=randomBytes(32),binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:project.projectId,releaseId:'native_release',generation:1,capsuleSha256:runtime.sha256,sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:image,uid:1000,gid:1000,capture:{keyId:'native_key',keySha256:hash(randomBytes(32)),maxTransactionBytes:limits.maxCaptureTransactionBytes,maxStateBytes:limits.maxCaptureStateBytes,maxJournalEntries:limits.maxJournalEntries,maxJournalBytes:limits.maxJournalBytes}};
 const issued=await h.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:hash(randomBytes(32)),controlSecretSha256:hash(key)});
 labels={'run.clank.managed':'provider-runtime','run.clank.owner':domain.owner,'run.clank.project':binding.projectId,'run.clank.release':binding.releaseId,'run.clank.generation':'1','run.clank.role':'web','run.clank.instance':'0','run.clank.handoff.protocol':binding.protocol,'run.clank.handoff.node':domain.nodeId,'run.clank.handoff.daemon':domain.daemonId,'run.clank.handoff.domain':binding.domainSha256,'run.clank.handoff.enablement':binding.enablementId,'run.clank.handoff.index':binding.indexId,'run.clank.handoff.catalog':binding.catalogId,'run.clank.handoff.grant':binding.grantId,'run.clank.handoff.binding':issued.bindingSha256,'run.clank.handoff.capsule':binding.capsuleSha256,'run.clank.handoff.incarnation':binding.sourceIncarnation};
 const args=['container','create','--name','clank-container-native-'+nonce,'--interactive','--pull','never','--restart','no','--read-only','--init','--cap-drop','ALL','--security-opt','no-new-privileges=true','--pids-limit','128','--memory','512m','--memory-swap','512m','--cpus','1','--user','1000:1000','--network','bridge','--stop-timeout','2','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--tmpfs','/run:rw,noexec,nosuid,nodev,size=8m,mode=755','--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=3'];
 for(const [k,v] of Object.entries(labels))args.push('--label',k+'='+v);
 args.push('--mount','type=bind,source='+prepared.releaseDirectory+',target=/app,readonly','--mount','type=bind,source='+join(root,'projects',project.projectId,'data')+',target=/data','--mount','type=bind,source='+join(root,'service','handoff','catalogs',project.catalogId)+',target=/run/clank-source,readonly','--workdir','/app',image,'node','dist/server.js');
 stage='create';cid=(await command(args)).stdout.trim();assert.match(cid,/^[a-f0-9]{64}$/);events.containerId=cid;
 const input={projectId:project.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,containerId:cid,expectedVersion:2};
 stage='created acknowledgment';events.created=await h.recordProviderHandoffContainerCreated(bridge,input);await command(['container','start',cid]);
 stage='started acknowledgment';events.started=await h.recordProviderHandoffContainerStarted(bridge,{...input,expectedVersion:3});
 grant=await h.retainProviderSourceGrant(bridge,{...input,expectedVersion:4},key);key.fill(0);data=await h.retainProviderSourceRuntimeData(grant);events.pinCountBefore=pins().length;events.descriptorsBefore=descriptors();
 events.inspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];events.projectedHost=JSON.parse((await command(['container','inspect','--format','{{json .HostConfig}}',cid])).stdout);stage='container admission';container=await h.retainProviderSourceContainer(data);container.assertCurrent();h.assertProviderSourceContainerLease(container);for(let i=0;i<12;i++)await container.verifyCurrent();events.descriptorsAdmitted=descriptors();const added=events.descriptorsAdmitted.filter(v=>!events.descriptorsBefore.some(w=>JSON.stringify(w)===JSON.stringify(v)));assert.equal(added.length,7);events.admitted={pid:container.pid,birth:container.birth,pinDelta:pins().length-events.pinCountBefore};
 const pid=container.pid;events.independent={stat:fs.readFileSync('/proc/'+pid+'/stat','utf8'),status:fs.readFileSync('/proc/'+pid+'/status','utf8'),cgroup:fs.readFileSync('/proc/'+pid+'/cgroup','utf8'),mountinfo:fs.readFileSync('/proc/'+pid+'/mountinfo','utf8'),apparmor:fs.readFileSync('/proc/'+pid+'/attr/current','utf8'),namespaces:Object.fromEntries(['mnt','pid','net','ipc','cgroup','user'].map(n=>[n,[fs.readlinkSync('/proc/'+pid+'/ns/'+n),fs.readlinkSync('/proc/self/ns/'+n)]]))};
 stage=mode+' refusal';
 if(mode==='stop')await command(['container','stop','--time','2',cid]);
 else if(mode==='pause'){await command(['container','pause',cid]);}
 else if(mode==='data-close')data.close();
 else if(mode==='revocation')events.revoked=await h.revokeProviderHandoffGrant(bridge,{...input,expectedVersion:4});
 else throw Error('Unsupported native test mode');
 assert.throws(()=>container.assertCurrent());assert.throws(()=>h.assertProviderSourceContainerLease(container));events.currentRefused=true;
 if(mode==='pause')await command(['container','unpause',cid]);
 events.descriptorsAfterRefusal=descriptors();for(const fd of added)assert.equal(events.descriptorsAfterRefusal.some(v=>JSON.stringify(v)===JSON.stringify(fd)),false);events.containerPinsReleased=true;
 container.close();data.close();grant.close();owner.close();assert.equal(pins().length,0);events.pinsReleased=true;events.complete=true;
}catch(e){failed=e;events.complete=false;events.failure={stage,name:e.name,message:e.message,stack:e.stack};}
finally{
 if(failed&&cid)try{events.failureInspect=JSON.parse((await command(['container','inspect',cid])).stdout)[0];}catch(e){events.failureInspectError=e.message;}
 try{container?.close();data?.close();grant?.close();owner?.close();}catch(e){events.cleanupError=e.message;failed??=e;}
 if(cid){try{const v=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(v.Id,cid);assert.equal(v.Image,image);assert.deepEqual(v.Config.Labels,labels);if(v.State.Paused)await command(['container','unpause',cid]);if(v.State.Running)await command(['container','stop','--time','2',cid]);const final=JSON.parse((await command(['container','inspect',cid])).stdout)[0];assert.equal(final.Id,cid);assert.deepEqual(final.Config.Labels,labels);assert.equal(final.State.Running,false);events.finalState=final.State;await command(['container','rm',cid]);assert.equal((await command(['container','ls','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}'])).stdout.trim(),'');events.cleanup={removed:true,absence:true};}catch(e){events.cleanupError=e.message;failed??=e;}}
 fs.writeFileSync(join(directory,'evidence.json'),JSON.stringify(events,null,2)+'\n');console.log(JSON.stringify(events));
}
if(failed)process.exitCode=1;
