import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {openPlatform,platformProviderFallbackContext,platformProviderHandoffContext,platformColdFallbackResumeSelection,platformColdFallbackNoSweepSelection} from '../dist/platform.js';
import {providerFallbackOrchestrationContext} from '../dist/orchestration.js';
import {openDockerDeploymentRuntimeLauncher,providerColdFallbackLauncherContext} from '../dist/provider-docker.js';
import {providerColdFallbackServiceContext} from '../dist/provider-service.js';
import {rehydrateColdProviderFallback,providerFallbackResumeReady} from '../dist/provider-fallback-coordinator.js';

const digest=value=>createHash('sha256').update(value).digest('base64url');
const sign=(key,domain,value)=>createHmac('sha256',key).update(domain+'\n').update(value).digest('hex');

async function fixture(change=()=>{}){
 const root=await mkdtemp(join(tmpdir(),'clank-cold-resume-')),key=randomBytes(32);let runtime;
 try{
  runtime=await openPlatform({dataDirectory:root,publicUrl:'http://127.0.0.1:48951',masterKey:key,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:48951,appPortEnd:48955,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'cold-resume-test-registration-1234567890',placement:{}}});
  const platform=platformProviderFallbackContext(runtime),orchestrator=platformProviderHandoffContext(runtime).orchestrator,sql=providerFallbackOrchestrationContext(orchestrator).internal;
  const source=(await orchestrator.registerNode({id:'cold-source',region:'test',capacity:10})).node;
  const target=(await orchestrator.registerNode({id:'cold-target',region:'test',capacity:10})).node;
  const projectId='cold-project',releaseId='cold-release',planId='cold-plan',generation=4,createdAt=1700000000000;
  const operationId='evac_'+digest(JSON.stringify([planId,projectId,releaseId,generation]));
  const planIdentity={protocol:'clank-platform-evacuation-fallback/1',planId,sourceNodeId:source.id,projectId,releaseId,generation,requestedBy:'cold-admin',createdAt};
  const projectBase={projectId,releaseId,generation,backupId:null,targetNodeId:null,targetGeneration:null};
  const projectsBefore=JSON.stringify([projectBase]);
  const projectsStopped=JSON.stringify([{...projectBase,fallbackAttemptId:operationId,fallbackState:'stopped'}]);
  const projectsRunning=JSON.stringify([{...projectBase,fallbackAttemptId:operationId,fallbackState:'running'}]);
  const evacuation={identity:planIdentity,projectsBefore,projectsStopped,projectsRunning};
  const plan=sql.prepare('INSERT INTO clank_platform_evacuations(id,node_id,requested_by,was_draining,state,phase,projects,error,created_at,updated_at,lease_id,lease_until) VALUES(?,?,?,0,\'running\',\'quiescing\',?,NULL,?,?,?,?)');
  plan.run(planId,source.id,'cold-admin',projectsStopped,createdAt,createdAt,'cold-lease',Date.now()+60000);
  const placement={project_id:projectId,desired_release_id:releaseId,desired_state:'running',placement_mode:'portable',requires_endpoint:0,required_labels:'{}',capacity_units:1,assigned_node_id:source.id,region:'test',generation,observed_release_id:null,observed_state:'stopped',observed_generation:generation,updated_at:createdAt};
  sql.prepare('INSERT INTO clank_deployment_placements(project_id,desired_release_id,desired_state,placement_mode,requires_endpoint,required_labels,capacity_units,assigned_node_id,region,generation,observed_release_id,observed_state,observed_generation,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(placement));
  sql.prepare('INSERT INTO clank_deployment_project_fences(project_id,fence,updated_at) VALUES(?,?,?)').run(projectId,7,createdAt);
  const placementImage=JSON.stringify(sql.prepare('SELECT * FROM clank_deployment_placements WHERE project_id=?').get(projectId));
  const handoff={handoff_id:operationId,project_id:projectId,source_node_id:source.id,target_node_id:target.id,capacity_units:1,controller_id:'cold-controller',version:1,state:'cancelled',input_json:'{}',input_sha256:digest('{}'),placement_json:placementImage,source_node_json:JSON.stringify(source),target_node_json:JSON.stringify(target),result_json:null,created_at:createdAt,updated_at:createdAt};
  sql.prepare('INSERT INTO clank_deployment_handoffs(handoff_id,project_id,source_node_id,target_node_id,capacity_units,controller_id,version,state,input_json,input_sha256,placement_json,source_node_json,target_node_json,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(handoff));
  const st=await stat(join(root,'control.sqlite')),parent=await stat(root);
  const controlIdentity={canonicalPath:resolve(root,'control.sqlite'),databaseDev:st.dev,databaseIno:st.ino,parentDev:parent.dev,parentIno:parent.ino,uid:process.getuid()};
  const providerRoot=join(root,'provider'),sourceRoot=join(root,'source-provider');
  for(const endpointRoot of [providerRoot,sourceRoot])await mkdir(join(endpointRoot,'service'),{recursive:true,mode:0o700});
  const endpoint=async(owner,endpointRoot,daemonId)=>({protocol:'clank-provider-fallback-endpoint/1',owner,root:endpointRoot,serviceDirectory:join(endpointRoot,'service'),daemonId,paths:await Promise.all([endpointRoot,join(endpointRoot,'service')].map(async path=>{const s=await stat(path);return {path,dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode};}))});
  const identity={protocol:'clank-provider-fallback/1',operationId,projectId,releaseId,sourceGeneration:generation,targetGeneration:generation+1,sourceNodeId:source.id,targetNodeId:target.id,sourceOrigin:'http://source.test',targetOrigin:'http://target.test'};
  const endpointBindings={source:await endpoint('cold-source-owner',sourceRoot,'daemon-source'),target:await endpoint('cold-owner',providerRoot,'daemon-cold')};
  const input={protocol:'clank-provider-fallback/1',controlIdentity,phase:'stopped',identity,endpointBindings,source:{capsuleSha256:'a'.repeat(64)},capsuleSha256:'b'.repeat(64),platform:{identity:{projectId,releaseId,sourceGeneration:generation,targetGeneration:generation+1,sourceNodeId:source.id,targetNodeId:target.id,sourceOrigin:'http://source.test',targetOrigin:'http://target.test'},evacuation}};
  const journal=JSON.stringify(input),authentication=sign(key,'clank-provider-fallback/1',journal);
  sql.prepare('INSERT INTO clank_deployment_fallback_journals(operation_id,journal,authentication) VALUES(?,?,?)').run(operationId,journal,authentication);
  const resumeId='fallback_resume_'+operationId+'_1',desired={releaseId,generation:generation+1,state:'running',runtimeProtocol:'clank-runtime/1'};
  const record={protocol:'clank-provider-fallback-resume-attempt/1',controlIdentity,resumeId,predecessorId:operationId,predecessorJournalSha256:digest(journal),predecessorAuthentication:authentication,projectId,selected:'target',attempt:1,phase:'planned',deadline:'999999999999999999999999',initialPlacement:placementImage,initialFence:7,nodeId:target.id,generation:generation+1,desired,operation:null,placement:placementImage,fence:7,capsuleSha256:input.capsuleSha256,identity,endpointBindings,evacuation,revision:1,previousAuthentication:null};
  const plannedJournal=JSON.stringify(record),plannedAuthentication=sign(key,'clank-provider-fallback-resume-attempt/1',plannedJournal);
  sql.prepare('INSERT INTO clank_platform_fallback_resume_records VALUES(?,?,?,?,?,?,?,?)').run(resumeId,operationId,projectId,1,1,'planned',plannedJournal,plannedAuthentication);
  const stopped={...record,phase:'stopped',revision:2,previousAuthentication:plannedAuthentication,settlement:{placement:placementImage,operation:null}};
  const resumeJournal=JSON.stringify(stopped),resumeAuthentication=sign(key,'clank-provider-fallback-resume-attempt/1',resumeJournal);
  sql.prepare('INSERT INTO clank_platform_fallback_resume_records VALUES(?,?,?,?,?,?,?,?)').run(resumeId,operationId,projectId,1,2,'stopped',resumeJournal,resumeAuthentication);
  sql.prepare('INSERT INTO clank_platform_fallback_resume_heads VALUES(?,?,?,?,?,?,?)').run(resumeId,operationId,projectId,1,2,'stopped',resumeAuthentication);
  await change({sql,journal,authentication,resumeId,resumeJournal,resumeAuthentication,projectId,operationId,platform});
  return {root,key,runtime,platform,sql,journal,authentication,resumeId,resumeJournal,resumeAuthentication,projectId,operationId};
 }catch(error){await runtime?.close();await rm(root,{recursive:true,force:true});throw error;}
}

test('cold STOPPED resume selection authenticates an exact retained chain without writes',async()=>{
 const f=await fixture();
 try{
  const before=f.sql.prepare('SELECT revision,phase,authentication FROM clank_platform_fallback_resume_heads WHERE resume_id=?').get(f.resumeId);
  const token=f.platform.coldStoppedResume(f.journal,f.authentication),selection=platformColdFallbackResumeSelection(token);
  assert.equal(selection.resumeId,f.resumeId);assert.equal(selection.projectId,f.projectId);assert.equal(selection.revision,2);
  assert.deepEqual(f.sql.prepare('SELECT revision,phase,authentication FROM clank_platform_fallback_resume_heads WHERE resume_id=?').get(f.resumeId),before);
  assert.throws(()=>platformColdFallbackResumeSelection({}),/genuine original platform cold STOPPED/);
 }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
});

test('cold rehydration requires genuine native service completion in addition to signed platform selections',async()=>{
 const f=await fixture();try{
  const forged=new Proxy({},{get(){throw new Error('A forged capability getter must not run.');}});
  assert.throws(()=>providerColdFallbackLauncherContext(forged,forged),/genuine completed cold fallback launcher/);
  assert.throws(()=>providerColdFallbackServiceContext(forged,forged),/genuine cold fallback provider service/);
  await assert.rejects(rehydrateColdProviderFallback(f.runtime,forged,forged,forged,{}),/genuine original platform cold STOPPED/);
  const token=f.platform.coldStoppedResume(f.journal,f.authentication),counterpart=f.platform.coldStoppedResumeCounterpart(token,'cold-source-owner',join(f.root,'source-provider'));
  await assert.rejects(rehydrateColdProviderFallback({},token,counterpart,forged,{}),/foreign or already consumed/);
  // This read-only selector fixture deliberately pairs a source-phase
  // predecessor with a target attempt; it must never become writer authority.
  await assert.rejects(rehydrateColdProviderFallback(platformColdFallbackResumeSelection(token).runtime,token,counterpart,forged,{}),/selected and counterpart admissions differ/);
  assert.equal(providerFallbackResumeReady(f.runtime,forged,f.operationId),false);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM clank_deployment_operations WHERE project_id=?').get(f.projectId).count,0);
 }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
});

test('platform-owned lazy provider bindings close idempotently and reject post-close rebinding',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-cold-factory-close-')),runtime=await openPlatform({dataDirectory:root,publicUrl:'http://127.0.0.1:48961',masterKey:randomBytes(32),hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:'bootstrap',appPortStart:48961,appPortEnd:48965,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},scaleToZero:{sweepIntervalMs:false},ingress:{baseDomain:'apps.example.test'},deploymentAgents:{registrationToken:'cold-factory-test-registration-1234567890',localFallback:true,placement:{}}});
 try{
  const orchestrator=platformProviderHandoffContext(runtime).orchestrator,session=await orchestrator.registerNode({id:'factory-node',region:'test',endpoint:'http://127.0.0.1:49999',capacity:4});
  await runtime.bindLocalProviderFactory(session.node.id,session.token,{rootDirectory:join(root,'factory-provider'),owner:'factory-owner',image:'clank-test@sha256:'+'e'.repeat(64)});
  await Promise.all([runtime.close(),runtime.close()]);
  await assert.rejects(runtime.bindLocalProviderFactory(session.node.id,session.token,{rootDirectory:join(root,'factory-provider'),owner:'factory-owner',image:'clank-test@sha256:'+'e'.repeat(64)}),/enabled|closing/u);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});

async function ownerInventoryDocker(root){
 const audit=join(root,'owner-inventory-audit.jsonl'),executable=join(root,'owner-inventory-docker.mjs'),inventory=join(root,'owner-inventory.json');
 await writeFile(inventory,'[]');
 await writeFile(executable,`#!${process.execPath}
import {appendFile,readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),inventory=${JSON.stringify(inventory)};
await appendFile(${JSON.stringify(audit)},JSON.stringify(args)+'\\n');
const rows=JSON.parse(await readFile(inventory,'utf8'));
if(args[0]==='info')process.stdout.write(JSON.stringify('daemon-source'));
else if(args[0]==='container'&&args[1]==='ls'){
 const filters=args.flatMap((arg,index)=>arg==='--filter'?[args[index+1]]:[]);
 const matching=rows.filter(row=>filters.every(filter=>{
  if(!filter.startsWith('label='))throw new Error('Unexpected inventory filter');
  const [name,...value]=filter.slice(6).split('=');return row.Config.Labels[name]===value.join('=');
 }));
 process.stdout.write(matching.map(row=>row.Id+'\\n').join(''));
}else if(args[0]==='container'&&args[1]==='rm'){
 const ids=args.slice(2).filter(arg=>arg!=='--force');
 if(!ids.length||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw new Error('Unexpected removal identity');
 await writeFile(inventory,JSON.stringify(rows.filter(row=>!ids.includes(row.Id))));
}else process.exit(9);
`,{mode:0o700});await chmod(executable,0o700);
 return {audit,executable,inventory};
}

test('counterpart cold admission is exact, authenticated, and preserves unrelated owner containers through close',async t=>{
 await t.test('valid opposite endpoint preserves an unrelated same-owner CID on startup and close',async()=>{
  const f=await fixture();try{
   const token=f.platform.coldStoppedResume(f.journal,f.authentication),root=join(f.root,'source-provider'),owner='cold-source-owner';
   const admission=f.platform.coldStoppedResumeCounterpart(token,owner,root),held=platformColdFallbackNoSweepSelection(admission);
   assert.equal(held.side,'source');assert.equal(held.owner,owner);assert.equal(held.root,root);assert.throws(()=>platformColdFallbackNoSweepSelection({}),/genuine original platform cold fallback counterpart/);
   const {audit,executable,inventory}=await ownerInventoryDocker(f.root);
   const unrelated={Id:'f'.repeat(64),Config:{Labels:{'run.clank.managed':'provider-runtime','run.clank.owner':owner,'run.clank.project':'unrelated-project'}},State:{Status:'running',Running:true,Pid:4242},Mounts:[]};
   await writeFile(inventory,JSON.stringify([unrelated]));
   const launcher=await openDockerDeploymentRuntimeLauncher({rootDirectory:root,owner,image:'clank-test@sha256:'+'d'.repeat(64),executable,commandTimeoutMs:5000,coldFallbackNoSweepSelection:admission});
   assert.equal(providerColdFallbackLauncherContext(launcher,admission).selected,false);
   const mismatchedAdmission=f.platform.coldStoppedResumeCounterpart(token,owner,root);
   assert.throws(()=>providerColdFallbackLauncherContext(launcher,mismatchedAdmission),/genuine completed cold fallback/);
   assert.deepEqual(JSON.parse(await readFile(inventory,'utf8')),[unrelated]);
   await launcher.close();
   assert.throws(()=>providerColdFallbackLauncherContext(launcher,admission),/no longer pristine/);
   const commands=(await readFile(audit,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(commands[0],['info','--format','{{json .ID}}']);assert.ok(!commands.some(args=>args[0]==='container'&&args[1]==='rm'));
   assert.deepEqual(JSON.parse(await readFile(inventory,'utf8')),[unrelated]);
  }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('selected cleanup owner cannot receive counterpart admission and forged admission does not access Docker',async()=>{
  const f=await fixture();try{
   const token=f.platform.coldStoppedResume(f.journal,f.authentication);
   assert.throws(()=>f.platform.coldStoppedResumeCounterpart(token,'cold-owner',join(f.root,'provider')),/exact signed opposite endpoint/);
   const root=join(f.root,'source-provider'),audit=join(f.root,'should-not-run'),executable=join(f.root,'never-run.mjs');
   await writeFile(executable,`#!${process.execPath}\\nprocess.exit(8)`,{mode:0o700});
   await assert.rejects(openDockerDeploymentRuntimeLauncher({rootDirectory:root,owner:'cold-source-owner',image:'clank-test@sha256:'+'d'.repeat(64),executable,coldFallbackNoSweepSelection:{} }),/genuine original platform cold fallback counterpart/);
   await assert.rejects(readFile(audit),{code:'ENOENT'});
  }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('platform close invalidates counterpart admission before Docker access',async()=>{
  const f=await fixture();try{
   const token=f.platform.coldStoppedResume(f.journal,f.authentication),root=join(f.root,'source-provider'),admission=f.platform.coldStoppedResumeCounterpart(token,'cold-source-owner',root),audit=join(f.root,'closed-audit'),executable=join(f.root,'closed-docker.mjs');
   await writeFile(executable,`#!${process.execPath}\\nprocess.exit(8)`,{mode:0o700});await f.runtime.close();
   await assert.rejects(openDockerDeploymentRuntimeLauncher({rootDirectory:root,owner:'cold-source-owner',image:'clank-test@sha256:'+'d'.repeat(64),executable,coldFallbackNoSweepSelection:admission}),/closed|current|changed|genuine/);
   await assert.rejects(readFile(audit),{code:'ENOENT'});
  }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
});

test('ordinary Docker launcher close still sweeps its owner inventory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-ordinary-close-'));let launcher;
 try{
  const {audit,executable,inventory}=await ownerInventoryDocker(root),owner='ordinary-owner';
  await mkdir(join(root,'provider'),{mode:0o700});
  launcher=await openDockerDeploymentRuntimeLauncher({rootDirectory:join(root,'provider'),owner,image:'clank-test@sha256:'+'d'.repeat(64),executable,commandTimeoutMs:5000});
  const owned={Id:'a'.repeat(64),Config:{Labels:{'run.clank.managed':'provider-runtime','run.clank.owner':owner}}};
  const other={Id:'b'.repeat(64),Config:{Labels:{'run.clank.managed':'provider-runtime','run.clank.owner':'another-owner'}}};
  await writeFile(inventory,JSON.stringify([owned,other]));
  await launcher.close();
  const commands=(await readFile(audit,'utf8')).trim().split('\n').map(JSON.parse),removals=commands.filter(args=>args[0]==='container'&&args[1]==='rm');
  assert.deepEqual(removals,[['container','rm','--force',owned.Id]]);
  assert.deepEqual(JSON.parse(await readFile(inventory,'utf8')),[other]);
 }finally{await launcher?.close();await rm(root,{recursive:true,force:true});}
});

async function coldDockerAdmissionFixture(f){
 const root=join(f.root,'provider'),project=join(root,'projects',f.projectId),data=join(project,'data'),release=join(project,'generations','g5-cold-release');
 await mkdir(data,{recursive:true,mode:0o700});await mkdir(release,{recursive:true,mode:0o700});
 const imageId='sha256:'+'d'.repeat(64),containerId='c'.repeat(64),owner='cold-owner';
 const paths=[];for(const path of [data,release]){const s=await stat(path);paths.push({path,dev:s.dev,ino:s.ino,uid:s.uid});}
 const labels={'run.clank.managed':'provider-runtime','run.clank.owner':owner,'run.clank.project':f.projectId,'run.clank.release':'cold-release','run.clank.generation':'5','run.clank.role':'web','run.clank.instance':'0'};
 const config={Labels:labels},host={OomKillDisable:false},mounts=[{Type:'bind',Source:release,Destination:'/app',RW:false},{Type:'bind',Source:data,Destination:'/data',RW:true}];
 const state={Status:'created',Running:false,Pid:0,StartedAt:'0001-01-01T00:00:00Z'};
 const normalized={Image:imageId,Config:config,HostConfig:{...host,OomKillDisable:false},AppArmorProfile:'docker-default',Mounts:[...mounts].sort((a,b)=>a.Destination<b.Destination?-1:a.Destination>b.Destination?1:0)};
 const role={role:'web',instance:0,containerId,configurationSha256:createHash('sha256').update(JSON.stringify(normalized)).digest('hex')};
 const user=String(process.getuid())+':'+String(process.getgid()),policySha256=createHash('sha256').update(JSON.stringify({user,network:'bridge',memory:'512m',cpus:'1',pidsLimit:128})).digest('hex');
 const stopped=JSON.parse(f.resumeJournal);stopped.intent={protocol:'clank-provider-fallback-launch-intent/1',projectId:f.projectId,owner,releaseId:'cold-release',generation:5,capsuleSha256:'b'.repeat(64),daemonId:'daemon-cold',imageId,roles:[role],paths,policySha256};
 const journal=JSON.stringify(stopped),authentication=sign(f.key,'clank-provider-fallback-resume-attempt/1',journal);
 f.sql.prepare('UPDATE clank_platform_fallback_resume_records SET journal=?,authentication=? WHERE resume_id=? AND revision=2').run(journal,authentication,f.resumeId);
 f.sql.prepare('UPDATE clank_platform_fallback_resume_heads SET authentication=? WHERE resume_id=?').run(authentication,f.resumeId);
 const token=f.platform.coldStoppedResume(f.journal,f.authentication);
 const audit=join(f.root,'docker-audit.jsonl'),executable=join(f.root,'fake-docker.mjs'),stateDirectory=join(f.root,'docker-state');await mkdir(stateDirectory,{mode:0o700});
 const selectedPath=join(stateDirectory,containerId+'.json');
 const selectedRow={Id:containerId,Image:imageId,Config:config,HostConfig:host,AppArmorProfile:'docker-default',Mounts:mounts,State:state,RestartCount:0};
 await writeFile(selectedPath,JSON.stringify(selectedRow));
 const unrelatedId='f'.repeat(64),unrelatedPath=join(stateDirectory,unrelatedId+'.json'),unrelatedRow={Id:unrelatedId,Image:imageId,Config:{Labels:{'run.clank.owner':owner}},HostConfig:{},Mounts:[],State:{Status:'created',Running:false,Pid:0},RestartCount:0};
 await writeFile(unrelatedPath,JSON.stringify(unrelatedRow));
 await writeFile(executable,`#!${process.execPath}\nimport {appendFile,readdir,readFile,rm,writeFile} from 'node:fs/promises';import {join} from 'node:path';const args=process.argv.slice(2),audit=${JSON.stringify(audit)},state=${JSON.stringify(stateDirectory)},selected=${JSON.stringify(containerId)};const log=async()=>appendFile(audit,JSON.stringify(args)+'\\n');await log();const file=id=>join(state,id+'.json');if(args[0]==='info')process.stdout.write(JSON.stringify('daemon-cold'));else if(args[0]==='image'&&args[1]==='inspect')process.stdout.write(JSON.stringify(${JSON.stringify(imageId)}));else if(args[0]==='container'&&args[1]==='inspect'){try{process.stdout.write(JSON.stringify([JSON.parse(await readFile(file(args[2]),'utf8'))]));}catch{process.stderr.write('Error: No such object: '+args[2]);process.exitCode=1;}}else if(args[0]==='container'&&args[1]==='ls'){const filters=[];for(let i=0;i<args.length;i++)if(args[i]==='--filter')filters.push(args[i+1]);const ids=[];for(const name of await readdir(state))if(name.endsWith('.json')){const id=name.slice(0,-5),row=JSON.parse(await readFile(file(id),'utf8'));if(filters.every(x=>x.startsWith('id=')?id===x.slice(3):true))ids.push(id);}if(filters.includes('id='+selected)&&!ids.includes(selected))process.stdout.write(selected+'\\n');else process.stdout.write(ids.join('\\n')+(ids.length?'\\n':''));}else if(args[0]==='container'&&args[1]==='stop'){for(const id of args.slice(4)){const row=JSON.parse(await readFile(file(id),'utf8'));row.State={...row.State,Status:'exited',Running:false,Pid:0};await writeFile(file(id),JSON.stringify(row));}}else if(args[0]==='container'&&args[1]==='rm'){for(const id of args.slice(2))await rm(file(id),{force:true});}else process.exit(3);\n`,{mode:0o700});await chmod(executable,0o700);
 return {root,token,owner,executable,audit,stateDirectory,unrelatedPath,unrelated:unrelatedRow,unrelatedId,containerId,open:()=>openDockerDeploymentRuntimeLauncher({rootDirectory:root,owner,image:'clank-test@'+imageId,executable,commandTimeoutMs:5000},undefined,token)};
}

test('cold Docker admission removes only the authenticated role, preserves unrelated owner containers, and fails closed before any later sweep',async()=>{
 const f=await fixture();try{const d=await coldDockerAdmissionFixture(f);
  await assert.rejects(d.open(),/exact role is still in Docker inventory/);
  const audit=(await readFile(d.audit,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(audit.some(args=>args[0]==='container'&&args[1]==='rm'&&args.slice(2).join(' ')===d.containerId));
  assert.ok(!audit.some(args=>args[0]==='container'&&args[1]==='rm'&&args.includes(d.unrelatedId)));
  assert.ok(audit.some(args=>args[0]==='container'&&args[1]==='ls'&&args.includes('id='+d.containerId)));
  assert.ok(!audit.some(args=>args[0]==='container'&&args[1]==='ls'&&args.includes('label=run.clank.owner='+d.owner)));
  assert.deepEqual(JSON.parse(await readFile(d.unrelatedPath,'utf8')).Id,d.unrelatedId);
  assert.deepEqual((await (await import('node:fs/promises')).readdir(d.stateDirectory)).sort(),[d.unrelatedId+'.json']);
 }finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
});

test('cold Docker admission refuses forged and changed selections before Docker access',async t=>{
 await t.test('forged token',async()=>{const f=await fixture();try{const root=join(f.root,'provider');const executable=join(f.root,'never-run.mjs'),audit=join(f.root,'audit');await writeFile(executable,`#!${process.execPath}\\nprocess.exit(7)`,{mode:0o700});await assert.rejects(openDockerDeploymentRuntimeLauncher({rootDirectory:root,owner:'cold-owner',image:'clank-test@sha256:'+'a'.repeat(64),executable},undefined,{}),/genuine original platform cold STOPPED/);await assert.rejects(readFile(audit),{code:'ENOENT'});}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}});
 await t.test('stale platform placement',async()=>{const f=await fixture();try{const d=await coldDockerAdmissionFixture(f);f.sql.prepare("UPDATE clank_deployment_placements SET observed_state='unknown' WHERE project_id=?").run(f.projectId);await assert.rejects(d.open(),/STOPPED placement image changed|selection changed after admission/);await assert.rejects(readFile(d.audit),{code:'ENOENT'});assert.deepEqual(JSON.parse(await readFile(d.unrelatedPath,'utf8')),d.unrelated);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}});
});

test('cold STOPPED resume refuses tampered and missing signed revisions',async t=>{
 await t.test('tampered body',async()=>{
  const f=await fixture(({sql,resumeId,resumeJournal})=>sql.prepare('UPDATE clank_platform_fallback_resume_records SET journal=? WHERE resume_id=? AND revision=2').run(resumeJournal+' ',resumeId));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/authentication or link/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('missing revision',async()=>{
  const f=await fixture(({sql,resumeId})=>sql.prepare('DELETE FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=1').run(resumeId));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/missing revision/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('stale head',async()=>{
  const f=await fixture(({sql,resumeId})=>sql.prepare("UPDATE clank_platform_fallback_resume_heads SET revision=1,phase='planned' WHERE resume_id=?").run(resumeId));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/missing revision/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('stale placement',async()=>{
  const f=await fixture(({sql,projectId})=>sql.prepare("UPDATE clank_deployment_placements SET observed_state='unknown' WHERE project_id=?").run(projectId));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/STOPPED placement image changed/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('stale fence',async()=>{
  const f=await fixture(({sql,projectId})=>sql.prepare('UPDATE clank_deployment_project_fences SET fence=fence+1 WHERE project_id=?').run(projectId));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/STOPPED fence differs/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('stale plan afterimage',async()=>{
  const f=await fixture(({sql})=>sql.prepare("UPDATE clank_platform_evacuations SET projects='[]' WHERE id='cold-plan'").run());
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/progress changed|exact signed STOPPED evacuation/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('unheaded orphan record',async()=>{
  const f=await fixture(({sql,operationId,projectId})=>sql.prepare('INSERT INTO clank_platform_fallback_resume_records VALUES(?,?,?,?,?,?,?,?)').run('orphan-resume',operationId,projectId,2,1,'planned','{}','0'.repeat(64)));
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/unaffiliated journal record/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
 await t.test('oversized aggregate chain is rejected by scalar preflight',async()=>{
  const f=await fixture(({sql,operationId,projectId})=>{
   const insert=sql.prepare('INSERT INTO clank_platform_fallback_resume_records VALUES(?,?,?,?,?,?,?,?)'),body='x'.repeat(128*1024),auth='0'.repeat(64);
   for(let index=0;index<191;index++)insert.run('oversized-resume-'+index,operationId,projectId,index+2,1,'planned',body,auth);
  });
  try{assert.throws(()=>f.platform.coldStoppedResume(f.journal,f.authentication),/aggregate head, record, or byte budget/);}finally{await f.runtime.close();await rm(f.root,{recursive:true,force:true});}
 });
});
