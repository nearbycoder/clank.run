// Opt-in native regression. Root runs this only on the approved Docker host.
// No fallback capabilities are forged: the fault loses a real signed COMMIT response.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createDeploymentBundle} from '../../dist/deploy.js';
import {createDeploymentRuntimeCapsule} from '../../dist/runtime-placement.js';
import {openDockerDeploymentProviderService,providerFallbackServiceContext} from '../../dist/provider-service.js';
import {transferDockerProviderFallback,recoverProviderFallback} from '../../dist/provider-fallback-coordinator.js';
import {runProviderDockerClient} from '../../dist/provider-docker-client.js';
import {serve} from '../../dist/node.js';
import {openNativePlatformAPI} from './provider-platform-api-native.mjs';

assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const image=process.argv[2];assert.match(image,/@sha256:[a-f0-9]{64}$/u);
const directory=fs.mkdtempSync('/var/tmp/clank-fallback-port-'),root=join(directory,'provider'),targetRoot=join(directory,'target'),app=join(directory,'app'),configDirectory=join(directory,'docker-config');
for(const path of [app,join(app,'dist'),join(app,'migrations'),configDirectory])fs.mkdirSync(path,{mode:0o700});
fs.writeFileSync(join(app,'migrations','0001_seed.sql'),'CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT NOT NULL);');
fs.writeFileSync(join(app,'dist','server.js'),`import http from 'node:http';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);const server=http.createServer((req,res)=>{if(req.url==='/write')db.prepare('INSERT INTO entries(value) VALUES(?)').run(process.env.HOSTNAME);res.end(req.url==='/health'?'ok':process.env.HOSTNAME);});server.listen(Number(process.env.PORT),'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));`);
const owner='fallback_port_'+randomUUID(),targetOwner=owner+'_target',operationId='evac_port_'+randomUUID().replaceAll('-','');
const proof={directory,version:process.version,complete:false,qualification:'Authentic stopped-phase recovery retires an already-removed original source record while an unrelated ordinary launch reserves its reused port before real Docker create.'};
const originalExec=DatabaseSync.prototype.exec,originalPrepare=DatabaseSync.prototype.prepare,originalSpawn=childProcess.spawn;
let service,target,sourceServer,targetServer,api,client,failure,holderPromise,contenderPromise;
const gates=new Map(),attempts=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const command=args=>runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:1024*1024});
const inventory=async(project)=>((await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,...(project?['--filter','label=run.clank.project='+project]:[]),'--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean)).sort();
const request=runtime=>({operation:{id:'port_'+runtime.manifest.projectId,projectId:runtime.manifest.projectId,fence:1,attempt:1,maxAttempts:1},desired:{state:'running',generation:1,releaseId:runtime.manifest.releaseId,runtimeProtocol:'clank-runtime/1'},artifact:runtime.artifact,runtime,signal:AbortSignal.timeout(30000)});
const route=async(runtime,path)=>{const response=await service.handle(new Request('http://provider.test'+runtime.manifest.ingress.route+path,{headers:{'x-clank-project-id':runtime.manifest.projectId,'x-clank-runtime-protocol':'clank-runtime/1','x-clank-runtime-generation':'1','x-clank-runtime-ingress':runtime.manifest.ingress.token}}));assert.equal(response.status,200,await response.text());};
const waitAttempt=async project=>{const until=performance.now()+8000;for(;;){const value=attempts.find(row=>row.project===project);if(value)return value;assert.ok(performance.now()<until,'Ordinary launch did not reach its real Docker create boundary.');await pause(5);}};
const releaseGates=()=>{for(const gate of gates.values())fs.writeFileSync(gate,'release');};

try{
 const docker={memory:'384m',cpus:'0.5',pidsLimit:96,dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory}};
 service=await openDockerDeploymentProviderService({rootDirectory:root,owner,image,docker:{...docker,portStart:47860,portEnd:47861}});
 target=await openDockerDeploymentProviderService({rootDirectory:targetRoot,owner:targetOwner,image,docker:{...docker,portStart:47960,portEnd:47961}});
 sourceServer=await serve(request=>service.handle(request),{hostname:'127.0.0.1',port:47231,allowedHosts:['127.0.0.1:47231']});
 targetServer=await serve(request=>target.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
 const sourceContext=providerFallbackServiceContext(service),targetContext=providerFallbackServiceContext(target);client=sourceContext.client;
 const artifact=await createDeploymentBundle(app,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/health',timeoutMs:15000},env:{}},{frameworkVersion:'0.24.0-test',nodeVersion:process.version,frameworkRoot:fileURLToPath(new URL('../../',import.meta.url))});
 api=await openNativePlatformAPI(directory,randomBytes(32));
 const initial=await api.deploy(service,artifact),primary=initial.capsule,projectId=primary.manifest.projectId;
 const sourceIds=await inventory(projectId);assert.equal(sourceIds.length,1);
 const originalRow=JSON.parse((await command(['container','inspect',sourceIds[0]])).stdout)[0],originalPort=Number(Object.values(originalRow.HostConfig.PortBindings).flat()[0].HostPort);
 assert.equal(originalPort,47860,'Fixture requires its first two-port slot to be available.');
 let injected=false;
 DatabaseSync.prototype.exec=function(sql){
  if(!injected&&sql==='COMMIT'&&originalPrepare.call(this,'PRAGMA database_list').get().file===api.controlPath){
   const stored=originalPrepare.call(this,'SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId);
   if(stored&&JSON.parse(stored.journal).phase==='stopped'){const result=originalExec.call(this,sql);injected=true;throw new Error('port regression: stopped journal COMMIT response lost');}
  }
  return originalExec.call(this,sql);
 };
 try{await assert.rejects(transferDockerProviderFallback(api.runtime,service,target,primary.bytes,{projectId,operationId,targetNodeId:'native_target',targetNodeToken:api.targetSession.token,maximumDowntimeMs:30000}),/stopped journal COMMIT response lost/);}
 finally{DatabaseSync.prototype.exec=originalExec;}
 assert.equal(injected,true);assert.deepEqual(await inventory(projectId),[]);
 const stored=api.control.prepare('SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId),journal=JSON.parse(stored.journal);assert.equal(journal.phase,'stopped');assert.equal(journal.source.roles[0].containerId,sourceIds[0]);
 const capsules=await Promise.all(['port_holder','port_contender'].map(projectId=>createDeploymentRuntimeCapsule({projectId,releaseId:'release_'+projectId,generation:1,environment:{},database:{path:'app.sqlite',mode:'initialize'},ingress:{route:'/v1/clank/apps/'+projectId,token:'clanki_'+projectId+'_123456789012345678901234567890',controlToken:'clankc_'+projectId+'_123456789012345678901234567890'},artifact})));
 for(const capsule of capsules)gates.set(capsule.manifest.projectId,join(directory,capsule.manifest.projectId+'.gate'));
 // Delay only these unrelated create calls before invoking the actual Docker CLI.
 // Original launcher port reservation has already happened; no container or socket exists yet.
 const gateProgram=`import fs from 'node:fs';import {spawn} from 'node:child_process';const [gate,executable,encoded]=process.argv.slice(1),until=Date.now()+15000;while(!fs.existsSync(gate)){if(Date.now()>until)process.exit(124);await new Promise(resolve=>setTimeout(resolve,5));}const child=spawn(executable,JSON.parse(encoded),{env:process.env,stdio:['ignore','inherit','inherit']});child.on('error',()=>process.exit(125));child.on('exit',code=>process.exit(code??126));`;
 childProcess.spawn=function(executable,args,options){
  const project=args?.find(value=>typeof value==='string'&&value.startsWith('run.clank.project='))?.slice('run.clank.project='.length);
  if(executable==='docker'&&args[0]==='container'&&args[1]==='create'&&gates.has(project)){
   const published=args[args.indexOf('--publish')+1],match=/^127\.0\.0\.1:(\d+):(\d+)$/u.exec(published);assert.ok(match,published);
   attempts.push({project,port:Number(match[1]),published});
   return originalSpawn.call(this,process.execPath,['--input-type=module','--eval',gateProgram,gates.get(project),executable,JSON.stringify(args)],options);
  }
  return originalSpawn.call(this,executable,args,options);
 };syncBuiltinESMExports();
 holderPromise=service.reconcile(request(capsules[0]));void holderPromise.catch(()=>{});
 const holder=await waitAttempt('port_holder');assert.equal(holder.port,originalPort);assert.deepEqual(await inventory('port_holder'),[]);
 await recoverProviderFallback(api.runtime,stored.journal,stored.authentication,sourceContext.owner,targetContext.owner,client,{sourceService:service,targetService:target});
 assert.equal(fs.existsSync(join(root,'service',projectId+'.evacuation.json')),false);
 const placement=api.control.prepare('SELECT observed_state,assigned_node_id FROM clank_deployment_placements WHERE project_id=?').get(projectId);assert.equal(placement.observed_state,'stopped');assert.equal(placement.assigned_node_id,'native_node');
 contenderPromise=service.reconcile(request(capsules[1]));void contenderPromise.catch(()=>{});
 const contender=await waitAttempt('port_contender');
 assert.equal(contender.port,47861,'Retiring a removed record must retain the unrelated pending launch\'s reused port reservation.');
 assert.notEqual(contender.port,holder.port);assert.deepEqual(await inventory('port_holder'),[]);assert.deepEqual(await inventory('port_contender'),[]);
 childProcess.spawn=originalSpawn;syncBuiltinESMExports();releaseGates();
 await Promise.all([holderPromise,contenderPromise]);
 const live=[];for(const capsule of capsules){const ids=await inventory(capsule.manifest.projectId);assert.equal(ids.length,1);const row=JSON.parse((await command(['container','inspect',ids[0]])).stdout)[0];assert.equal(row.State.Running,true);const port=Number(Object.values(row.HostConfig.PortBindings).flat()[0].HostPort);live.push({project:capsule.manifest.projectId,containerId:row.Id,pid:row.State.Pid,port});await route(capsule,'/write');}
 assert.deepEqual(live.map(row=>row.port),[47860,47861]);assert.deepEqual(await inventory(projectId),[]);
 Object.assign(proof,{originalSourceId:sourceIds[0],originalPort,retirementPhase:journal.phase,createdAfterRetirement:attempts,unrelatedLive:live,complete:true});
}catch(error){failure=error;proof.failure={message:error.message,stack:error.stack};}
finally{
 DatabaseSync.prototype.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports();releaseGates();
 await Promise.allSettled([holderPromise,contenderPromise].filter(Boolean));
 const cleanupFailures=[];for(const close of [()=>api?.close(),()=>sourceServer?.close(),()=>targetServer?.close(),()=>target?.close(),()=>service?.close()])try{await close();}catch(error){cleanupFailures.push(error.message);failure??=error;}
 if(client){proof.remaining=[];for(const selectedOwner of [owner,targetOwner]){const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+selectedOwner,'--format','{{.ID}}'])).stdout.trim();if(ids)proof.remaining.push({owner:selectedOwner,ids});}}
 proof.pins=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root)||path.startsWith(targetRoot)?[fd]:[];}catch{return[];}}).length;
 if(cleanupFailures.length)proof.cleanupFailures=cleanupFailures;if(failure||proof.remaining?.length||proof.pins)proof.complete=false;
 console.log(JSON.stringify(proof));if(!proof.complete)process.exitCode=1;
}
