import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectLinuxHostCertification} from '../dist/host-certification.js';
import {shadowPlatformFixture,origin,artifact,request,until} from './fixtures/platform-shadow-native.mjs';

const enabled=process.env.CLANK_DOCKER_INTEGRATION==='1'&&process.env.CLANK_DISPOSABLE_TEST_HOST==='1'&&Boolean(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG);
const settings={skip:enabled?false:'requires explicit disposable Docker host opt-in and independently generated CLANK_SHADOW_CERTIFICATE_CONFIG; fixture launcher is not isolation proof',timeout:90000};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function call(f,path,body){const response=await f.platform.nativeRequest(request(`/api/projects/${f.project.id}/shadow/`+path,{method:'POST',body,cookie:f.owner.cookie,csrf:f.owner.csrf}));return{status:response.status,body:await response.json()}}
async function fixture(t){
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);await stat('/etc/clank-disposable-test-host');
  const certificate=JSON.parse(await readFile(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG,'utf8')),inspected=await inspectLinuxHostCertification(certificate);
  assert.equal(inspected.current,true,JSON.stringify(inspected));assert.equal(inspected.report.status,'passed');assert.ok(inspected.report.expiresAt>Date.now()+90000);
  const f=await shadowPlatformFixture(t,undefined,undefined,{providerPromotionHosts:{'canary-native-provider':certificate},shadowTraffic:{maxSamplePercent:100,maxAttempts:20,maxRequestMs:3000}});await f.fresh();
  const written=await f.traffic('POST');assert.equal(written.status,200);assert.equal((await written.json()).written,true);f.primary=await f.primaryObservation();f.coordination=f.primaryCoordination();
  const bytes=await artifact(f.root,'certified-observer'),staged=await f.platform.nativeRequest(new Request(origin+`/api/projects/${f.project.id}/releases/stage`,{method:'POST',headers:{origin,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':hash(bytes),'x-clank-idempotency-key':'certified-observer-stage-01'},body:bytes}));
  const release=await staged.json();assert.equal(staged.status,201,JSON.stringify(release));
  const review=await call(f,'preview',{releaseId:release.release.id,expectedEpoch:0,policy:{}});assert.equal(review.status,200,JSON.stringify(review));
  const started=await call(f,'start',{reviewToken:review.body.reviewToken,idempotencyKey:'certified-observer-start-01'});assert.equal(started.status,202,JSON.stringify(started));f.session=started.body.session;
  await until(()=>f.raw()?.operation.phase==='observing','actual public owner prepares isolated candidate',15000);
  t.diagnostic(JSON.stringify({certificateId:inspected.report.id,certificateExpiresAt:inspected.report.expiresAt,runtimeLauncher:'fixture; not Docker isolation acceptance'}));return f;
}
async function traffic(f,{path='/',method='GET',headers={}}={}){return f.platform.nativeRequest(new Request('http://native-canary.apps.example.test'+path,{method,headers}))}
const samples=f=>f.events.filter(event=>event.kind==='traffic'&&event.projectId.startsWith('canary_'));
async function unchanged(f){assert.deepEqual(await f.primaryObservation(),f.primary);assert.deepEqual(f.primaryCoordination(),f.coordination);assert.equal(f.runtimes.size,1);assert.equal(f.runtimes.get(f.project.id).status,'active')}
async function stop(f){const result=await call(f,f.session.sessionId+'/stop',{operationId:f.session.operationId,controllerEpoch:f.session.controllerEpoch});assert.equal(result.status,202,JSON.stringify(result));await until(()=>f.raw()?.operation.phase==='complete','actual provider exact retirement',15000);return f.raw().operation}

test('certified production observer mirrors only anonymous exact native requests and preserves primary rows',settings,async t=>{
  const f=await fixture(t);let last;
  for(const method of['GET','HEAD']){const response=await traffic(f,{method,headers:{accept:'application/json','user-agent':'primary-only'}});assert.equal(response.status,200);if(method==='GET'){last=await response.json();assert.equal(last.label,'primary');assert.equal(last.written,false);assert.deepEqual(last.rows,f.primary.rows.map(({label})=>({label})))}else assert.equal(await response.text(),'');await until(()=>f.raw().operation.report.counters.settled===(method==='GET'?1:2),'actual '+method+' sample settlement',10000)}
  for(const options of[{path:'/?secret=x'},{path:'/%68ealthz'},{headers:{cookie:'secret=primary'}},{headers:{authorization:'Bearer primary-only'}},{headers:{'x-tenant':'primary-only'}}]){const response=await traffic(f,options);await response.arrayBuffer()}
  const operation=await stop(f);assert.equal(operation.report.counters.reserved,2);assert.equal(operation.report.counters.settled,2);assert.equal(operation.report.counters.comparable,2);assert.equal(operation.report.counters.bothComplete,2);assert.equal(samples(f).length,2);
  for(const event of samples(f)){assert.ok(['GET','HEAD'].includes(event.method));assert.equal(event.path,'/');assert.equal(event.headers.accept,'application/json');assert.equal(event.headers['accept-encoding'],'identity');assert.equal(event.headers['cache-control'],'no-store');for(const name of['cookie','authorization','x-tenant','referer','x-forwarded-for'])assert.equal(event.headers[name],undefined);assert.notEqual(event.headers['user-agent'],'primary-only')}
  await unchanged(f);t.diagnostic(JSON.stringify({sessionId:f.session.sessionId,report:operation.report,candidateRequests:samples(f).length,primaryRows:f.primary.rows.length}));
});
for(const interruption of['session','stop'])test('certified production held candidate '+interruption+' loss cannot settle a successful comparison',settings,async t=>{
  const f=await fixture(t),held=f.holdSample();let stopped;
  try{
    const response=await traffic(f);assert.equal(response.status,200);assert.equal((await response.json()).label,'primary');await until(()=>held.entered.done,'actual candidate response held',10000);assert.equal(f.raw().operation.report.counters.reserved,1);assert.equal(f.raw().operation.report.counters.settled,0);
    if(interruption==='session')f.control.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(f.owner.session.id);else stopped=await stop(f);
    await until(()=>f.raw().operation.phase==='complete','native-only retirement after '+interruption,15000);const complete=f.raw();assert.equal(complete.operation.report.counters.comparable,0);assert.equal(complete.operation.report.counters.settled,1);assert.equal(samples(f).length,1);held.release.resolve();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.raw().epoch,complete.epoch);await unchanged(f);
    t.diagnostic(JSON.stringify({case:interruption,report:complete.operation.report,cleanupRequired:false,candidateRequests:samples(f).length}));
  }finally{held.release.resolve()}
});
