// Run only on the explicitly owned disposable Docker/XFS guest. This is not a
// default npm test and never substitutes a fake provider or certificate.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, chown, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../../dist/platform.js';
import { serve } from '../../dist/node.js';
import { createDeploymentBundle, deploymentDigest, parseDeploymentConfig } from '../../dist/deploy.js';
import { certifyLinuxHost, inspectLinuxHostCertification } from '../../dist/host-certification.js';
import { createDeploymentCoordinatorClient } from '../../dist/runner.js';
import { createHttpDeploymentProvider, openProviderDeploymentAgent } from '../../dist/provider.js';
import { createLinuxDockerNetworkPlan } from '../../dist/linux-project-isolation.js';

process.umask(0o077);
assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1');
assert.equal(process.getuid(), 0);
await stat('/etc/clank-disposable-test-host');
const arguments_ = process.argv.slice(2);
assert.equal(arguments_[0], '--disposable');
assert.ok(arguments_.length === 1 || (arguments_.length === 2 && arguments_[1] === '--authority-only'));
const authorityOnly = arguments_[1] === '--authority-only';
const command = promisify(execFile), framework = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const interruption=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>interruption.abort(new Error('Owned acceptance interrupted.')));
const image = 'node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';
await command('/usr/bin/docker', ['image','inspect',image]);
const mountDirectory = '/disposable-xfs', certificateQuota = 1210, providerQuota = 1211;
const quota = async (id, kind) => {
  const output=(await command('/usr/sbin/xfs_quota', ['-x','-D','/dev/null','-P','/dev/null','-c',`report -p -n -N -${kind} -L ${id} -U ${id}`,mountDirectory])).stdout;
  const rows=output.split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts[0]);
  assert.ok(rows.every(parts=>[String(id),`#${id}`].includes(parts[0])),'Only the selected numeric quota may be reported.');
  const values=rows[0]?.slice(1,4).map(Number)??[0,0,0];
  assert.ok(values.length===3&&values.every(Number.isFinite),'Quota counters must be numeric.');
  return values;
};
for (const id of [certificateQuota, providerQuota]) for (const kind of ['b','i']) {
  const values = await quota(id, kind); assert.ok(values.every(value => value === 0), 'Reserve unused disposable quota IDs.');
}
const root = await mkdtemp('/root/clank-promotion-acceptance-');
console.error('Owned acceptance directory: '+root);
const providerRoot = await mkdtemp(join(mountDirectory, 'clank-promotion-provider-'));
await chown(providerRoot, 1000, 1000); await chmod(providerRoot, 0o700);
const profile = { mode:'docker-isolated', image, user:'1000:1000', memory:'512m', cpus:'1', pidsLimit:128,
  diskQuota:{mountDirectory, hardBytes:64*1024*1024,hardFiles:128}, outboundNetwork:{allowCidrs:[]}, networkProbe:{deniedAddress:'9.9.9.9'} };
const certificate = { directory:join(root,'certificate'), profile };
const cases = []; let platform, server, agent, worker, workerClosed, config, originalNftMode;
let rpcSequence=0; const pending=new Map();
const rpc = (method, input) => new Promise((resolve,reject)=>{
  const id=++rpcSequence, timer=setTimeout(()=>{pending.delete(id);reject(new Error('Owned provider IPC timed out.'));},30000);
  pending.set(id,{resolve,reject,timer});worker.send({id,method,input},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error)}});
});
try {
  const report = await certifyLinuxHost({...certificate, disposable:true, quotaId:certificateQuota, ttlMs:3600000,signal:interruption.signal});
  assert.equal(report.status,'passed'); assert.equal((await inspectLinuxHostCertification(certificate)).current,true);
  cases.push({name:'real current Docker/XFS host certificate',status:'passed',reportId:report.id,policyDigest:report.policyDigest});
  console.error('Current host certificate verified.');
  const origin='http://127.0.0.1:57900', registrationToken='clank_promotion_guest_enrollment_1234567890123456789';
  const options={dataDirectory:join(root,'platform'),publicUrl:origin,signup:true,hostingProfile:'trusted',
    appPortStart:57500,appPortEnd:57520,ingress:{baseDomain:'apps.example.test',domainRecheckIntervalMs:false},backups:{intervalMs:false},previews:{cleanupIntervalMs:false},
    providerPromotionHosts:{'promotion-provider':certificate},deploymentAgents:{registrationToken,placement:{activationTimeoutMs:15000,maxDatabaseBytes:1024*1024}}};
  platform=await openPlatform(options);server=await serve(request=>platform.handle(request),{hostname:'127.0.0.1',port:57900,
    allowedHosts:['127.0.0.1','development.apps.example.test','staging.apps.example.test']});
  const registered=await fetch(origin+'/__clank/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'guest-owner@example.test',password:'correct horse battery staple'})});
  assert.equal(registered.status,201);const owner=await registered.json(),cookie=registered.headers.get('set-cookie').split(';')[0];
  const call=async(path,body,expected=200,method=body===undefined?'GET':'POST',actor={cookie,csrfToken:owner.csrfToken})=>{
    const response=await fetch(origin+path,{method,signal:interruption.signal,headers:{origin,cookie:actor.cookie,'x-clank-csrf':actor.csrfToken,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  };
  const create=async(slug,placement)=>(await call('/api/projects',{name:slug,slug,placement},201)).project;
  const sourceProject=await create('development','local'),targetProject=await create('staging','provider');
  const environmentPath=`/api/projects/${sourceProject.id}/environments`;
  await call(environmentPath+'/development',{projectId:sourceProject.id,expectedVersion:0},200,'PUT');
  await call(environmentPath+'/staging',{projectId:targetProject.id,expectedVersion:0,migrationPolicy:'code-only'},200,'PUT');
  const sourceFiles=join(root,'source');await mkdir(join(sourceFiles,'dist'),{recursive:true});await mkdir(join(sourceFiles,'migrations'));
  await writeFile(join(sourceFiles,'migrations/0001_sample.sql'),"CREATE TABLE sample(value TEXT NOT NULL);INSERT INTO sample VALUES('initial');");
  const artifact=async(label,extraMigration='')=>{
    if(extraMigration)await writeFile(join(sourceFiles,'migrations/0002_schema.sql'),extraMigration);
    await writeFile(join(sourceFiles,'dist/server.mjs'),`
      import {createServer} from 'node:http';import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);
      if(${JSON.stringify(label)}==='v2'&&process.env.HEALTH_WRITE==='1')db.prepare('UPDATE sample SET value=?').run('unpublished-health-write');
      createServer((request,response)=>{if(request.url==='/healthz'){response.statusCode=process.env.FAIL_HEALTH==='1'&&${JSON.stringify(label)}==='v2'?503:200;response.end('health');return}
        if(request.url.startsWith('/write/'))db.prepare('UPDATE sample SET value=?').run(decodeURIComponent(request.url.slice(7)));
        response.setHeader('content-type','application/json');response.end(JSON.stringify({label:${JSON.stringify(label)},uid:process.getuid(),value:db.prepare('SELECT value FROM sample').get().value,secret:process.env.ENVIRONMENT_VALUE,bucketPrefix:process.env.CLANK_BUCKET_PREFIX}));
      }).listen(Number(process.env.PORT),process.env.HOST);
    `);
    const bytes=await createDeploymentBundle(sourceFiles,parseDeploymentConfig({version:1,entry:'dist/server.mjs',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations'},health:{path:'/healthz',timeoutMs:5000},env:{}}));
    return{bytes,digest:await deploymentDigest(bytes)};
  };
  const upload=async(project,bundle,key)=>{
    const response=await fetch(origin+`/api/projects/${project.id}/releases`,{method:'POST',headers:{origin,cookie,'x-clank-csrf':owner.csrfToken,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':bundle.digest,'x-clank-idempotency-key':key},body:bundle.bytes});
    const value=await response.json();assert.equal(response.status,201,JSON.stringify(value));return value.release;
  };
  const probe=async(project,path='/')=>{
    return new Promise((resolve,reject)=>{
      const request=httpRequest(origin+path,{headers:{host:project.slug+'.apps.example.test'}},response=>{
        const chunks=[];let bytes=0;
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)request.destroy(new Error('Bounded probe response exceeded.'));else chunks.push(chunk)});
        response.on('error',reject);response.on('end',()=>{
          try{const body=Buffer.concat(chunks).toString();assert.equal(response.statusCode,200,body);resolve(JSON.parse(body))}catch(error){reject(error)}
        });
      });
      request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('Actual ingress probe timed out.')));request.end();
    });
  };
  const providerFile=join(framework,'tests/fixtures/platform-promotion-provider-worker.mjs');
  worker=spawn('/usr/bin/unshare',['--mount','--propagation','private','/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups',
    '--inh-caps=+sys_admin,+net_admin,+dac_override','--ambient-caps=+sys_admin,+net_admin,+dac_override','--bounding-set=-all,+sys_admin,+net_admin,+dac_override','--no-new-privs',process.execPath,providerFile],
    {cwd:framework,stdio:['ignore','ignore','pipe','ipc'],env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',NODE_NO_WARNINGS:'1'}});
  let stderr='';worker.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192)});
  workerClosed=new Promise(resolve=>worker.once('close',code=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error(`Owned provider closed (${code}): ${stderr}`))}pending.clear();resolve(code)}));
  worker.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;clearTimeout(entry.timer);pending.delete(message.id);if(message.error)entry.reject(new Error(message.error));else entry.resolve(message.value)});
  config={root:providerRoot,profile,quotaId:providerQuota,owner:'promotion-acceptance',projectId:targetProject.id,token:'clank_promotion_guest_provider_1234567890123456789'};
  const {port}=await rpc('open',config),providerOrigin=`http://127.0.0.1:${port}`;
  const openAgent=()=>openProviderDeploymentAgent({client:createDeploymentCoordinatorClient({baseUrl:origin}),registrationToken,node:{id:'promotion-provider',region:'local',endpoint:providerOrigin,capacity:5},
    provider:createHttpDeploymentProvider({baseUrl:providerOrigin,token:config.token,timeoutMs:10000,retries:0}),pollIntervalMs:20,heartbeatIntervalMs:100});
  agent=await openAgent();
  await call(`/api/projects/${sourceProject.id}/secrets`,{values:{ENVIRONMENT_VALUE:'development'}},200,'PUT');
  await call(`/api/projects/${targetProject.id}/secrets`,{values:{ENVIRONMENT_VALUE:'staging'}},200,'PUT');
  const v1=await artifact('v1'),source=await upload(sourceProject,v1,'source_provider_initial'),target=await upload(targetProject,v1,'target_provider_initial');
  console.error('Source and real provider target initialized.');
  await probe(sourceProject,'/write/source-only');await probe(targetProject,'/write/target-only');
  const input={sourceEnvironment:'development',releaseId:source.id,digest:v1.digest,expectedVersion:1,expectedActiveReleaseId:target.id,idempotencyKey:'provider_exact_request_01'};
  const staleTarget=await call(environmentPath+'/staging/promotions',{...input,expectedActiveReleaseId:'missing_release_0001',idempotencyKey:'provider_stale_target_01'},409);
  assert.equal(staleTarget.error.code,'PROMOTION_TARGET_STALE');
  const acceptPromotion=async request=>{
    const deadline=Date.now()+90000;
    while(true){
      const response=await fetch(origin+environmentPath+'/staging/promotions',{method:'POST',signal:interruption.signal,headers:{origin,cookie,'x-clank-csrf':owner.csrfToken,'content-type':'application/json'},body:JSON.stringify(request)});
      const value=await response.json();
      if(response.status!==503){assert.equal(response.status,201,JSON.stringify(value));return value}
      assert.equal(value.error.code,'PROVIDER_DEPLOYMENT_PENDING');
      assert.ok(Date.now()<deadline,'The exact healthy provider request must finish within its acceptance budget.');
    }
  };
  let promoted=await acceptPromotion(input);
  assert.equal(promoted.release.digest,v1.digest);assert.equal(promoted.promotion.state,'accepted');
  assert.deepEqual(await readFile(join(options.dataDirectory,'projects',targetProject.id,'artifacts',promoted.release.id+'.clank.gz')),v1.bytes);
  const observed=await probe(targetProject);assert.equal(observed.uid,1000);assert.equal(observed.secret,'staging');assert.equal(observed.bucketPrefix,targetProject.id);assert.equal(observed.value,'target-only');assert.equal((await probe(sourceProject)).value,'source-only');
  cases.push({name:'actual HTTP provider promotion preserves original bytes, non-root runtime and independent data/secrets/buckets',status:'passed',digest:v1.digest});
  const exact=(await call(environmentPath+'/staging/promotions',input,201));assert.equal(exact.release.id,promoted.release.id);
  await agent.close();agent=null;await platform.close();platform=await openPlatform(options);agent=await openAgent();
  assert.equal((await probe(sourceProject)).value,'source-only');
  const replay=await call(environmentPath+'/staging/promotions',input,201);assert.equal(replay.release.id,promoted.release.id);
  cases.push({name:'accepted exact replay across actual controller restart',status:'passed'});
  if (authorityOnly) {
    const response=await fetch(origin+'/__clank/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'guest-developer@example.test',password:'correct horse battery staple'})});
    assert.equal(response.status,201);const developer=await response.json();developer.cookie=response.headers.get('set-cookie').split(';')[0];
    const control=new DatabaseSync(join(options.dataDirectory,'control.sqlite'));
    try {
      control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(sourceProject.organizationId,developer.user.id,'developer',Date.now(),Date.now());
      for (const phase of ['staging','queued']) for (const boundary of ['source','target']) {
        await rpc('pause-ingress');
        const key=`provider_revoke_${phase}_${boundary}_01`, request={...input,expectedActiveReleaseId:promoted.release.id,idempotencyKey:key};
        const flight=call(environmentPath+'/staging/promotions',request,403,'POST',developer);flight.catch(()=>{});
        const deadline=Date.now()+10000;
        while (true) {
          const receipt=(await call(environmentPath+'/staging/promotions')).promotions.find(row=>row.idempotencyKey===key&&row.state==='staging');
          if(receipt&&(phase==='staging'||control.prepare('SELECT provider_generation FROM clank_platform_releases WHERE id=?').get(receipt.targetReleaseId)?.provider_generation!==null))break;
          assert.ok(Date.now()<deadline,'The actual provider candidate must stage before authority is revoked.');
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)')
          .run(boundary==='source'?sourceProject.id:targetProject.id,developer.user.id,JSON.stringify(boundary==='source'?['deploy']:['read']));
        await rpc('resume-ingress');
        const denied=await flight;assert.equal(denied.error.code,'ROLE_DENIED');
        const targetState=await call(`/api/projects/${targetProject.id}`);assert.equal(targetState.project.activeReleaseId,promoted.release.id);
        assert.equal((await probe(targetProject)).value,'target-only');
        assert.equal((await call(environmentPath+'/staging/promotions')).promotions.find(row=>row.idempotencyKey===key).state,'failed');
        control.prepare('DELETE FROM clank_platform_project_members WHERE project_id=? AND user_id=?')
          .run(boundary==='source'?sourceProject.id:targetProject.id,developer.user.id);
        cases.push({name:`actual ${phase} provider ${boundary} authority revocation fences publication and restores the exact prior target`,status:'passed'});
        console.error(`Actual ${phase} provider ${boundary} authority revocation verified.`);
      }
    } finally {control.close()}
    // Let a genuine short-lived report expire during an actual queued request.
    // No clock substitution, report edit or synthetic certificate is accepted.
    const expiring=await certifyLinuxHost({...certificate,disposable:true,quotaId:certificateQuota,ttlMs:60000,signal:interruption.signal});
    assert.equal(expiring.status,'passed');assert.equal((await inspectLinuxHostCertification(certificate)).current,true);
    while(Date.now()<expiring.expiresAt-5000)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,expiring.expiresAt-5000-Date.now())));
    await rpc('pause-ingress');
    const expiryInput={...input,expectedActiveReleaseId:promoted.release.id,idempotencyKey:'provider_actual_expiry_01'};
    const expired=await call(environmentPath+'/staging/promotions',expiryInput,409);assert.equal(expired.error.code,'PROMOTION_RECOVERY_REQUIRED');
    assert.equal((await inspectLinuxHostCertification(certificate)).current,false);
    assert.equal((await call(environmentPath+'/staging/promotions')).promotions.find(row=>row.idempotencyKey===expiryInput.idempotencyKey).state,'recovery-required');
    const bypass=await call(environmentPath+'/staging/promotions',{...expiryInput,idempotencyKey:'provider_expiry_bypass_01'},409);assert.equal(bypass.error.code,'PROMOTION_RECOVERY_REQUIRED');
    const recoveryPath=environmentPath+'/staging/promotions/'+expiryInput.idempotencyKey+'/recover';
    const confirmation=`recover-promotion ${targetProject.slug} ${expiryInput.idempotencyKey}`;
    const uncertified=await call(recoveryPath,{confirmation},409);assert.equal(uncertified.error.code,'PROMOTION_HOST_CERTIFICATION_REQUIRED');
    const renewed=await certifyLinuxHost({...certificate,disposable:true,quotaId:certificateQuota,ttlMs:3600000,signal:interruption.signal});
    assert.equal(renewed.status,'passed');await rpc('resume-ingress');
    const recovered=await call(recoveryPath,{confirmation});assert.equal(recovered.promotion.state,'failed');
    assert.equal((await call(`/api/projects/${targetProject.id}`)).project.activeReleaseId,promoted.release.id);
    assert.equal((await probe(targetProject)).value,'target-only');
    cases.push({name:'actual host certificate expiry fences a queued provider promotion and blocks recovery until real recertification',status:'passed',expiredReportId:expiring.id,renewedReportId:renewed.id});
  } else {
  await rpc('pause-ingress');
  const pendingInput={...input,expectedActiveReleaseId:promoted.release.id,idempotencyKey:'provider_pending_restart_01'};
  const pendingResponse=await call(environmentPath+'/staging/promotions',pendingInput,503);assert.equal(pendingResponse.error.code,'PROVIDER_DEPLOYMENT_PENDING');
  const pendingHistory=await call(environmentPath+'/staging/promotions');
  const pendingReceipt=pendingHistory.promotions.find(row=>row.idempotencyKey===pendingInput.idempotencyKey);
  assert.equal(pendingReceipt.state,'staging');assert.ok(pendingReceipt.targetReleaseId);
  const bypass=await call(environmentPath+'/staging/promotions',{...pendingInput,idempotencyKey:'provider_pending_bypass_01'},409);
  assert.equal(bypass.error.code,'PROMOTION_RECOVERY_REQUIRED');
  await agent.close();agent=null;await platform.close();platform=await openPlatform(options);
  assert.equal((await rpc('resume-ingress')).port,port);agent=await openAgent();
  assert.equal((await probe(sourceProject)).value,'source-only');
  promoted=await acceptPromotion(pendingInput);
  assert.equal(promoted.release.id,pendingReceipt.targetReleaseId);assert.equal(promoted.release.digest,v1.digest);
  assert.equal((await call(environmentPath+'/staging/promotions',pendingInput,201)).release.id,promoted.release.id);
  assert.equal((await probe(targetProject)).value,'target-only');
  cases.push({name:'actual pending provider operation resumes the same generation after controller restart and rejects a new-key bypass',status:'passed'});
  const v2=await artifact('v2'),nextSource=await upload(sourceProject,v2,'source_provider_candidate');
  await call(`/api/projects/${targetProject.id}/secrets`,{values:{ENVIRONMENT_VALUE:'staging',FAIL_HEALTH:'1',HEALTH_WRITE:'1'}},200,'PUT');
  const failedInput={...input,releaseId:nextSource.id,digest:v2.digest,expectedActiveReleaseId:promoted.release.id,idempotencyKey:'provider_health_failure_01'};
  // Real provider health failures use the coordinator's unchanged bounded
  // backoff. Pending responses must resume the same generation, not replace it.
  const failureDeadline=Date.now()+660000;let failed;
  while(true){
    const response=await fetch(origin+environmentPath+'/staging/promotions',{method:'POST',signal:interruption.signal,headers:{origin,cookie,'x-clank-csrf':owner.csrfToken,'content-type':'application/json'},body:JSON.stringify(failedInput)});
    failed=await response.json();
    if(response.status!==503){assert.equal(response.status,422,JSON.stringify(failed));break}
    assert.equal(failed.error.code,'PROVIDER_DEPLOYMENT_PENDING');assert.ok(Date.now()<failureDeadline,'The actual health-failure operation must become terminal.');
    console.error('Actual provider retry remains pending.');
  }
  assert.equal(failed.error.code,'PROVIDER_DEPLOYMENT_FAILED');
  const restored=await probe(targetProject);assert.equal(restored.label,'v1');assert.equal(restored.value,'target-only');
  const history=await call(environmentPath+'/staging/promotions');assert.equal(history.promotions.find(row=>row.idempotencyKey===failedInput.idempotencyKey).state,'failed');
  cases.push({name:'real failed Docker candidate health rolls back journaled writes and restores prior provider runtime',status:'passed'});
  const nft='/usr/sbin/nft';originalNftMode=(await stat(nft)).mode&0o777;await chmod(nft,originalNftMode^1);
  try{const blocked=await call(environmentPath+'/staging/promotions',{...failedInput,idempotencyKey:'provider_changed_host_01'},409);assert.equal(blocked.error.code,'PROMOTION_HOST_CERTIFICATION_REQUIRED');}
  finally{await chmod(nft,originalNftMode);originalNftMode=undefined;}
  assert.equal((await probe(targetProject)).label,'v1');assert.equal((await call(environmentPath+'/staging/promotions')).promotions.length,3);
  cases.push({name:'actual host policy change invalidates the certificate before staging another release',status:'passed'});
  const v3=await artifact('v3','CREATE TABLE forbidden_new_schema(id INTEGER PRIMARY KEY);'),newSchema=await upload(sourceProject,v3,'source_provider_schema_change');
  const rejected=await call(environmentPath+'/staging/promotions',{...failedInput,releaseId:newSchema.id,digest:v3.digest,idempotencyKey:'provider_schema_rejected_01'},409);assert.equal(rejected.error.code,'PROMOTION_MIGRATIONS_BLOCKED');assert.equal((await probe(targetProject)).label,'v1');
  cases.push({name:'provider code-only proof rejects a changed migration manifest before staging',status:'passed'});
  }
} finally {
  if(originalNftMode!==undefined)await chmod('/usr/sbin/nft',originalNftMode);
  await agent?.close();await server?.close();await platform?.close();
  if(worker&&worker.exitCode===null){try{await rpc('close');}finally{await workerClosed}}
  await rm(providerRoot,{recursive:true,force:true});
  const deadline=Date.now()+10000;
  for(const kind of ['b','i']){while((await quota(providerQuota,kind))[0]!==0){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,100))}}
  await command('/usr/sbin/xfs_quota',['-x','-D','/dev/null','-P','/dev/null','-c',`limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${providerQuota}`,mountDirectory]);
  for(const kind of ['b','i'])assert.ok((await quota(providerQuota,kind)).every(value=>value===0));
  if(config){
    const plan=await createLinuxDockerNetworkPlan(config.owner,config.projectId,profile.outboundNetwork);
    const containers=(await command('/usr/bin/docker',['container','ls','--all','--quiet','--filter',`label=run.clank.owner=${config.owner}`])).stdout.trim();
    assert.equal(containers,'');
    const networks=(await command('/usr/bin/docker',['network','ls','--format','{{.Name}}'])).stdout.split('\n');
    assert.ok(!networks.includes(plan.network));
    const tables=JSON.parse((await command('/usr/sbin/nft',['-j','list','tables'])).stdout);
    assert.ok(!tables.nftables.some(entry=>entry.table?.name===plan.table&&entry.table.family==='inet'));
  }
}
cases.push({name:'owned provider stops, Docker containers/network/nft table retire and XFS quota usage/limits clear',status:'passed'});
const result={protocol:'clank-provider-promotion-acceptance/1',status:'passed',mode:authorityOnly?'authority-expiry':'health-restart',realGuest:true,node:process.version,cases};
await writeFile(join(root,'acceptance.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
