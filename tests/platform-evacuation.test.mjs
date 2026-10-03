import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createServer}from'node:http';import{DatabaseSync}from'node:sqlite';
import{openPlatform}from'../dist/platform.js';import{createDeploymentBundle,deploymentDigest}from'../dist/deploy.js';import{createDeploymentCoordinatorClient}from'../dist/runner.js';import{openProviderDeploymentAgent}from'../dist/provider.js';
const origin='http://127.0.0.1:4200';
function req(path,body,session,method=body===undefined?'GET':'POST'){return new Request(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-clank-csrf':session.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})}
async function payload(platform,path,body,session,status=200,method){const response=await platform.handle(req(path,body,session,method));const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value}
async function register(platform,email){const response=await platform.handle(req('/__clank/auth/register',{email,password:'correct horse battery staple'}));assert.equal(response.status,201);const value=await response.json();return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:value.csrfToken}}

for (const boundary of ['normal', 'revoked-session', 'evacuation-lease', 'project-lease']) test(`platform evacuation preserves final data and fences publication at ${boundary}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-platform-evac-'));let platform,sourceAgent,targetAgent,sourceRuntime;let badProof=true,stopped=false,snapshotCalls=0;const recovered=[];
 const file=join(root,'final.sqlite'),database=new DatabaseSync(file);database.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES('last committed source write')");database.close();const finalSnapshot=new Uint8Array(await readFile(file)),digest=await deploymentDigest(finalSnapshot);
 const server=createServer((request,response)=>{
  if(request.url?.endsWith('/evacuate')){if(request.method!=='POST'||request.headers.authorization!=='Bearer '+sourceRuntime?.manifest.ingress.controlToken){response.writeHead(404);response.end();return}stopped=true;snapshotCalls++;response.writeHead(200,{'content-type':'application/vnd.clank.provider-snapshot','content-length':String(finalSnapshot.byteLength),'x-clank-content-sha256':digest,'x-clank-release-id':sourceRuntime.manifest.releaseId,'x-clank-runtime-generation':String(sourceRuntime.manifest.generation),'x-clank-evacuation-id':badProof?'evac_wrong_plan':request.headers['x-clank-evacuation-id'],'x-clank-writers-stopped':'true'});response.end(finalSnapshot);return}
  response.writeHead(200,{'content-type':'text/plain'});response.end('healthy');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port,registrationToken='evacuation-registration-token-'+ 'r'.repeat(32);
 const options={dataDirectory:join(root,'platform'),publicUrl:origin,signup:true,platformAdminEmails:['admin@example.test'],ingress:{baseDomain:'apps.example.test'},backups:{intervalMs:false},deploymentAgents:{registrationToken,placement:{default:'provider',activationTimeoutMs:3000}}};
 try{
  platform=await openPlatform(options);const client=createDeploymentCoordinatorClient({baseUrl:origin,fetch:(url,init)=>platform.handle(new Request(url,init))});
  sourceAgent=await openProviderDeploymentAgent({client,registrationToken,node:{id:'evac-source',region:'local',endpoint,capacity:5},provider:{kind:'http',async reconcile(request){assert.equal(stopped,false,'source must not be restarted after quiescing');sourceRuntime=request.runtime}},pollIntervalMs:10,heartbeatIntervalMs:100});
  let admin=await register(platform,'admin@example.test');const other=await register(platform,'other@example.test');const{project}=await payload(platform,'/api/projects',{name:'Evacuation project',placement:'provider'},admin,201);
  const source=join(root,'source');await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'migrations'));await writeFile(join(source,'dist/server.js'),'export const app = true;\n');await writeFile(join(source,'migrations/001.sql'),'CREATE TABLE state(value TEXT);\n');const artifact=await createDeploymentBundle(source,{version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations',allowUnsafeMigrations:false},health:{path:'/healthz',timeoutMs:1000},env:{}},{frameworkVersion:'0.9.4-test',nodeVersion:process.versions.node});
  const deploy=await platform.handle(new Request(origin+`/api/projects/${project.id}/releases`,{method:'POST',headers:{origin,cookie:admin.cookie,'x-clank-csrf':admin.csrf,'content-type':'application/vnd.clank.deploy+gzip','content-length':String(artifact.byteLength),'x-clank-content-sha256':await deploymentDigest(artifact),'x-clank-idempotency-key':'evacuation-deploy-0001'},body:artifact}));assert.equal(deploy.status,201,await deploy.clone().text());
  targetAgent=await openProviderDeploymentAgent({client,registrationToken,node:{id:'evac-target',region:'local',endpoint,capacity:5},provider:{kind:'http',async reconcile(request){assert.equal(stopped,true);recovered.push(request);
    if(boundary==='revoked-session'){const logout=await platform.handle(req('/__clank/auth/logout',{},admin));assert.equal(logout.status,200)}
    if(boundary==='evacuation-lease'||boundary==='project-lease'){const control=new DatabaseSync(join(root,'platform','control.sqlite'));try{
      if(boundary==='evacuation-lease')control.prepare("UPDATE clank_platform_evacuations SET lease_id='successor' WHERE node_id='evac-source' AND state='running'").run();
      else control.prepare("UPDATE clank_distributed_leases SET fence=fence+1 WHERE resource=?").run('project:'+project.id);
    }finally{control.close()}}
    assert.equal(request.runtime.manifest.database.mode,'replace');assert.deepEqual(request.runtime.databaseSnapshot,finalSnapshot)}},pollIntervalMs:10,heartbeatIntervalMs:100});
  const path='/api/admin/runners/evac-source/evacuations';await payload(platform,path,{confirmation:'evacuate evac-source'},other,403);await payload(platform,path,{confirmation:'evacuate evac-source'},{...admin,csrf:'forged'},403);
  const cancelled=(await payload(platform,path,{confirmation:'evacuate evac-source'},admin,201)).plan;assert.equal(cancelled.projects.length,1);assert.equal((await payload(platform,`${path}/${cancelled.id}/cancel`,{confirmation:cancelled.id},admin)).plan.state,'cancelled');assert.equal(stopped,false);
  const plan=(await payload(platform,path,{confirmation:'evacuate evac-source'},admin,201)).plan;await payload(platform,`/api/projects/${project.id}/secrets`,{values:{KEY:'blocked'}},admin,409,'PUT');
  await payload(platform,`${path}/${plan.id}/run`,{confirmation:plan.id},admin,503);let state=(await payload(platform,`${path}/${plan.id}`,undefined,admin)).plan;assert.equal(state.state,'paused');assert.equal(state.phase,'quiescing');assert.equal(recovered.length,0);assert.equal(state.projects[0].backupId,null);
  badProof=false;
  if(boundary!=='normal'){
    await payload(platform,`${path}/${plan.id}/run`,{confirmation:plan.id},admin,boundary==='revoked-session'?403:boundary==='project-lease'?409:500);
    const control=new DatabaseSync(join(root,'platform','control.sqlite'));try{
      const active=control.prepare('SELECT active_generation,provider_node_id,provider_origin FROM clank_platform_projects WHERE id=?').get(project.id);
      assert.equal(active.active_generation,1);assert.equal(active.provider_node_id,'evac-source');assert.equal(active.provider_origin,null,'old authority must not publish target ingress');
      control.prepare('UPDATE clank_platform_evacuations SET lease_until=0 WHERE id=?').run(plan.id);
      control.prepare('UPDATE clank_distributed_leases SET expires_at=0 WHERE resource=?').run('project:'+project.id);
    }finally{control.close()}
    if(boundary==='revoked-session'){
      const login=await platform.handle(req('/__clank/auth/login',{email:'admin@example.test',password:'correct horse battery staple'}));assert.equal(login.status,200);const value=await login.json();admin={cookie:login.headers.get('set-cookie').split(';')[0],csrf:value.csrfToken};
    }
  }
  const completed=(await payload(platform,`${path}/${plan.id}/run`,{confirmation:plan.id},admin)).plan;assert.equal(completed.state,'completed');assert.equal(completed.projects[0].targetNodeId,'evac-target');assert.equal(snapshotCalls,2);assert.equal(recovered.length,1);
  const current=(await payload(platform,`/api/projects/${project.id}`,undefined,admin)).project;assert.equal(current.providerNodeId,'evac-target');assert.equal(current.activeGeneration,2);await payload(platform,`${path}/${plan.id}/run`,{confirmation:plan.id},admin);assert.equal(recovered.length,1);
  await sourceAgent.close();sourceAgent=null;await targetAgent.close();targetAgent=null;await platform.close();platform=await openPlatform(options);assert.equal((await payload(platform,`${path}/${plan.id}`,undefined,admin)).plan.state,'completed');
 }finally{await sourceAgent?.close();await targetAgent?.close();await platform?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
});
