// A fresh OS process observes cleanup after SIGKILL of the handoff controller.
// This proves writer absence and data retention, not recovery permission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
assert.equal(process.getuid(),1000);
const checkpoint=process.argv[2],directory=join(checkpoint,'..');
assert.match(checkpoint,/^\/var\/tmp\/clank-production-source-[A-Za-z0-9]+\/controller-loss-checkpoint\.json$/);
assert.equal(fs.realpathSync(checkpoint),checkpoint);assert.equal(fs.statSync(checkpoint).uid,1000);
const input=JSON.parse(fs.readFileSync(checkpoint,'utf8')),writer=input.pendingTarget;
assert.equal(input.publicationFault,'owner-kill');assert.equal(input.directory,directory);
const client=providerDockerClient({executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:join(directory,'docker-config')}});
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});
const birth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
const absent=identity=>{try{return birth(identity.pid)!==identity.birth;}catch(error){if(error.code==='ENOENT')return true;throw error;}};
const processesAbsent=()=>input.pendingProcesses.every(identity=>{if(!absent(identity))return false;try{return fs.readFileSync(join(identity.cgroup,'cgroup.procs'),'utf8').trim()==='';}catch(error){if(error.code==='ENOENT')return true;throw error;}});
assert.equal(absent(input.controllerProcess),true);
const began=performance.now(),deadline=began+15000;
const watchers=input.publicationWatchdogs;assert.equal(watchers.length,1);assert.deepEqual(watchers[0].events,[{event:'ready'}]);
let removed;
while(!removed){
 const ids=(await command(['container','ls','--all','--no-trunc','--filter','id='+writer.containerId,'--format','{{.ID}}'])).stdout.trim();
 assert.ok(ids===''||ids===writer.containerId);removed=ids===''&&absent(writer)&&watchers.every(absent)&&processesAbsent();
 if(!removed){assert.ok(performance.now()<deadline,'Independent owner-loss cleanup did not settle');await new Promise(resolve=>setTimeout(resolve,25));}
}
const daemonId=JSON.parse((await command(['info','--format','{{json .ID}}'])).stdout);assert.equal(daemonId,'111ee57b-2dc1-470f-b040-f8022be31206');
const values=['source mutation one','source-mutation-two','terminal-inflight-mutation'];
const readData=()=>{const db=new DatabaseSync(input.pendingTargetDatabase,{readOnly:true});try{assert.deepEqual(db.prepare("SELECT json_extract(_data,'$.value') value FROM clank_records ORDER BY value").all().map(row=>row.value),values);assert.equal(db.prepare('SELECT value FROM seed').get().value,'ordinary-before-capture');}finally{db.close();}};
readData();const control=new DatabaseSync(input.pendingCoordinatorPath,{readOnly:true});try{assert.equal(control.prepare('SELECT state FROM clank_deployment_handoffs').get().state,'reserved');assert.equal(control.prepare('SELECT generation FROM clank_deployment_placements WHERE project_id=?').get(input.pendingProjectId).generation,1);}finally{control.close();}
const service=join(input.pendingTargetRoot,'service'),marker=join(service,'.handoff-target-owner.sqlite'),before=fs.statSync(marker);
assert.equal(fs.existsSync(join(service,'.handoff-target-adoption.sqlite')),false);assert.equal(fs.existsSync(join(service,'.handoff-target-restart.sqlite')),false);
const reference=JSON.parse((await command(['image','inspect',input.image,'--format','{{json .RepoDigests}}'])).stdout)[0];
await assert.rejects(openDockerDeploymentProviderService({rootDirectory:input.pendingTargetRoot,owner:input.pendingTargetOwner,image:reference,docker:{executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:join(directory,'docker-config')}}}),/Retained target admission refuses ordinary root startup/);
const after=fs.statSync(marker);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);readData();
assert.equal((await command(['container','ls','--all','--no-trunc','--filter','id='+writer.containerId,'--format','{{.ID}}'])).stdout.trim(),'');
const pins=fs.readdirSync('/proc/self/fd').filter(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path===directory||path.startsWith(directory+'/');}catch{return false;}});assert.equal(pins.length,0);
process.stdout.write(JSON.stringify({complete:true,mode:'controller-SIGKILL-before-coordinator-commit',daemonId,writer,watchdogs:watchers.map(({pid,birth})=>({pid,birth})),independentCleanupSettledMs:performance.now()-began,nativeWriterAndWatchdogAbsent:true,knownThreeRecordLedgerAndSeedRetained:true,coordinatorRemainsUncommitted:true,noColdPermissionGranted:true,targetOwnerMarkerPreserved:true,fixturePinsAfterCleanup:0})+'\n');
