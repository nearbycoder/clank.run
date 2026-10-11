#!/usr/bin/env node
// Scripted transport only: this fixture is not native Docker lifecycle evidence.
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2),log=process.env.LOG;
if(args[0]==='coordinator')await coordinator(args[1]);
else {
if(!log)throw Error('An owned fixture log is required.');
const config=JSON.parse(fs.readFileSync(log+'.container.json','utf8'));
const kind=args[0]==='info'?'info':'inspect';
const projectionFormat='[{{json .Id}},{{json .Image}},{{json .Config.Image}},{{json .Config.User}},{{json .Config.Labels}},{{json .HostConfig.RestartPolicy.Name}},{{json .HostConfig.RestartPolicy.MaximumRetryCount}},{{json .State.Status}},{{json .State.Running}},{{json .State.Paused}},{{json .State.Restarting}},{{json .State.Dead}},{{json .State.Pid}},{{json .State.StartedAt}},{{json .State.FinishedAt}},{{json .RestartCount}},{{json .Created}}]';
if(kind==='info'&&JSON.stringify(args)!==JSON.stringify(['info','--format','{{json .ID}}']))throw Error('Unexpected native identity command.');
if(kind==='inspect'&&(args.length!==5||args[0]!=='container'||args[1]!=='inspect'||args[2]!=='--format'||args[3]!==projectionFormat||!/^[a-f0-9]{64}$/.test(args[4])))throw Error('Unexpected native container command.');
const counter=log+'.'+kind;let count=0;try{count=Number(fs.readFileSync(counter,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
fs.writeFileSync(counter,String(count+1));
fs.appendFileSync(log,JSON.stringify({pid:process.pid,kind,count,args})+'\n');
const reply=config[kind+'Replies']?.[count]??{};
if(reply.hold){
 fs.writeFileSync(reply.hold,JSON.stringify({pid:process.pid,kind,count}));
 const deadline=Date.now()+5000;
 while(!fs.existsSync(reply.release)){if(Date.now()>deadline)process.exit(75);await delay(10);}
}
if(reply.stderr)process.stderr.write(reply.stderr);
if(reply.base64)process.stdout.write(Buffer.from(reply.base64,'base64'));
else process.stdout.write(reply.stdout??JSON.stringify(kind==='info'?(config.daemonId??'daemon_native_fixture'):config.projection)+'\n');
process.exitCode=reply.code??0;
}

async function coordinator(inputFile){
 const input=JSON.parse(fs.readFileSync(inputFile,'utf8'));
 const {DatabaseSync}=await import('node:sqlite'),{randomUUID,createHash}=await import('node:crypto'),{fileURLToPath}=await import('node:url');
 const handoff=await import('../../dist/provider-handoff.js'),{providerDockerClient}=await import('../../dist/provider-docker-client.js');
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 fs.writeFileSync(input.log+'.container.json',JSON.stringify({daemonId:'daemon_native_fixture'}));
 const owner=await handoff.acquireProviderServiceOwnership(input.root,true);
 try{
  const client=providerDockerClient({executable:fileURLToPath(import.meta.url),dockerEnvironment:{LOG:input.log}}),domain=await handoff.createProviderHandoffDomain(owner,client,'node_source','owner-source');
  const identity=await handoff.initializeProviderHandoff(owner,domain),project=await handoff.installProviderHandoffProject(owner,domain,'project_source'),bridge=await handoff.enableProviderHandoffBridge(owner,domain,input.limits);
  const binding={protocol:'clank-provider-source-grant/1',enablementId:bridge.enablementId,indexId:identity.indexId,catalogId:project.catalogId,domainSha256:identity.domainSha256,projectId:'project_source',releaseId:'release_source',generation:1,capsuleSha256:'a'.repeat(64),sourceIncarnation:randomUUID(),grantId:randomUUID(),role:'web',instance:0,imageId:'sha256:'+'b'.repeat(64),uid:1000,gid:1000,capture:{keyId:'source_key',keySha256:'c'.repeat(64),maxTransactionBytes:input.limits.maxCaptureTransactionBytes,maxStateBytes:input.limits.maxCaptureStateBytes,maxJournalEntries:input.limits.maxJournalEntries,maxJournalBytes:input.limits.maxJournalBytes}};
  await handoff.issueProviderHandoffGrant(bridge,{binding,grantSecretSha256:'d'.repeat(64),controlSecretSha256:'e'.repeat(64)});
  const containerId='f'.repeat(64),labels={
   'run.clank.managed':'provider-runtime','run.clank.owner':'owner-source','run.clank.project':binding.projectId,'run.clank.release':binding.releaseId,'run.clank.generation':'1','run.clank.role':'web','run.clank.instance':'0',
   'run.clank.handoff.protocol':binding.protocol,'run.clank.handoff.node':'node_source','run.clank.handoff.daemon':'daemon_native_fixture','run.clank.handoff.domain':binding.domainSha256,'run.clank.handoff.enablement':binding.enablementId,'run.clank.handoff.index':binding.indexId,'run.clank.handoff.catalog':binding.catalogId,'run.clank.handoff.grant':binding.grantId,'run.clank.handoff.binding':hash(binding),'run.clank.handoff.capsule':binding.capsuleSha256,'run.clank.handoff.incarnation':binding.sourceIncarnation,
  };
  const zero='0001-01-01T00:00:00Z',projection=[containerId,binding.imageId,binding.imageId,'1000:1000',labels,'no',0,'created',false,false,false,false,0,zero,zero,0,'2026-10-11T11:59:59Z'];
  fs.writeFileSync(input.log+'.container.json',JSON.stringify({projection}));
  const catalog=input.root+'/service/handoff/catalogs/'+project.catalogId+'/catalog.sqlite',exec=DatabaseSync.prototype.exec;
  const pause=()=>{fs.writeFileSync(input.checkpoint,JSON.stringify({pid:process.pid,phase:input.phase,catalog,binding}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000);throw Error('Owned crash fixture was not killed.');};
  DatabaseSync.prototype.exec=function(sql){
   const selected=sql==='COMMIT'&&this.prepare('PRAGMA database_list').get().file.endsWith('/catalog.sqlite');
   if(selected&&input.phase==='before-commit')pause();
   const result=exec.call(this,sql);if(selected&&input.phase==='after-commit')pause();return result;
  };
  try{await handoff.recordProviderHandoffContainerCreated(bridge,{projectId:binding.projectId,grantId:binding.grantId,bindingSha256:hash(binding),containerId,expectedVersion:2});}finally{DatabaseSync.prototype.exec=exec;}
  throw Error('Crash checkpoint was not reached.');
 }finally{owner.close();}
}
