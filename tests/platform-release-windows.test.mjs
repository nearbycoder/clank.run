import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures/platform-environment-fixture.mjs';

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t, subprocess=false, intervalMs=100, label='v3') {
  const f=await fixture(t,subprocess,{releaseWindows:{intervalMs}}),v1=await f.artifact('v1');
  const prior=await f.upload(f.staging,v1,'window_target_initial_01');await f.probe(f.staging,'/write/retained-target');
  const artifact=await f.artifact(label,label==='v2'?"UPDATE sample SET value='unaccepted'; CREATE TABLE candidate_only(id INTEGER PRIMARY KEY);":'');
  const source=await f.upload(f.development,artifact,'window_source_initial_01');
  const channel=`/api/projects/${f.development.id}/channels/stable`,path=`/api/projects/${f.development.id}/release-windows`;
  await f.call(channel,{sourceEnvironment:'development',releaseId:source.id,digest:artifact.digest,expectedVersion:0},200,'PUT');
  const input=(delay=1500,lifetime=30_000,key='window_approved_exact_01')=>({channel:'stable',expectedVersion:1,targetEnvironment:'staging',expectedEnvironmentVersion:1,expectedActiveReleaseId:prior.id,expectedDependencyVersion:0,idempotencyKey:key,startsAt:new Date(Date.now()+delay).toISOString(),expiresAt:new Date(Date.now()+delay+lifetime).toISOString(),timeZone:'America/Chicago'});
  const queue=async request=>(await f.call(path,request,201)).schedule;
  const current=async id=>(await f.call(`${path}/${id}`)).schedule;
  const wait=async(id,state,timeout=45_000)=>{
    const deadline=Date.now()+timeout;
    for(;;){const row=await current(id);if(row.state===state)return row;assert.ok(Date.now()<deadline,`Expected ${state}, got ${JSON.stringify(row)}`);await sleep(25)}
  };
  return {...f,prior,source,artifact,channel,path,input,queue,current,wait};
}
async function entered(file) {
  const deadline=Date.now()+10_000;
  for(;;){try{await readFile(file);return}catch(error){if(error.code!=='ENOENT')throw error}assert.ok(Date.now()<deadline,'The actual candidate health request must start.');await sleep(10)}
}

test('a real scheduled promotion waits, preserves exact bytes/data and never executes twice after restart or queue retry',{timeout:45_000},async t=>{
  const f=await setup(t),input=f.input(2000),queued=await f.queue(input);
  assert.equal(queued.state,'pending');assert.equal(queued.version,1);assert.equal(queued.source.digest,f.artifact.digest);
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
  await sleep(300);assert.equal((await f.current(queued.id)).state,'pending');
  const accepted=await f.wait(queued.id,'accepted');assert.equal(accepted.version,3);
  assert.equal((await f.probe(f.staging)).label,'v3');assert.equal((await f.probe(f.staging)).value,'retained-target');
  assert.deepEqual(await readFile(join(f.options.dataDirectory,'projects',f.staging.id,'artifacts',accepted.targetReleaseId+'.clank.gz')),f.artifact.bytes);
  const sequence=(await f.call(`/api/projects/${f.staging.id}/dependencies`)).target.activationSequence;
  await f.restart();await sleep(300);assert.equal((await f.queue(input)).id,queued.id);
  assert.equal((await f.current(queued.id)).targetReleaseId,accepted.targetReleaseId);
  assert.equal((await f.call(`/api/projects/${f.staging.id}/dependencies`)).target.activationSequence,sequence);
  const changed={...input,timeZone:'UTC'};assert.equal((await f.call(f.path,changed,409)).error.code,'RELEASE_WINDOW_RETRY_CHANGED');
  const publicJson=JSON.stringify((await f.call(f.path)).schedules);for(const field of ['credential','sessionId','tokenId','claim_fence','attestation'])assert.ok(!publicJson.includes(field));
});

test('schedules reject ambiguous calendar/timezone inputs and previews distinguish the repeated DST hour',{timeout:30_000},async t=>{
  const f=await setup(t,false,false),valid=f.input(10_000);
  for(const change of [{startsAt:'2026-11-01T01:30:00'},{startsAt:'2026-02-30T12:00:00Z'},{startsAt:'2026-10-09T12:00:60Z'},{startsAt:new Date(Date.now()-1000).toISOString()},{timeZone:'Mars/Private'},{timeZone:'+05:00'},{expiresAt:valid.startsAt},{expiresAt:new Date(Date.now()+32*24*60*60_000).toISOString()}])await f.call(f.path,{...valid,...change},422);
  const first=await f.queue(valid),second=await f.queue({...valid,idempotencyKey:'window_dst_other_instant_01'});
  const control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  for(const [row,offset] of [[first,'-05:00'],[second,'-06:00']])control.prepare('UPDATE clank_platform_release_windows SET starts_at=?,expires_at=? WHERE id=?').run(Date.parse('2026-11-01T01:30:00'+offset),Date.parse('2026-11-01T01:45:00'+offset),row.id);
  const a=await f.current(first.id),b=await f.current(second.id);
  assert.equal(a.startsAt,'2026-11-01T06:30:00.000Z');assert.equal(b.startsAt,'2026-11-01T07:30:00.000Z');
  assert.match(a.preview.startsAt,/01:30:00 GMT-05:00/);assert.match(b.preview.startsAt,/01:30:00 GMT-06:00/);
});

test('versioned cancellation prevents actual execution and pending pins protect retirement and project deletion',{timeout:30_000},async t=>{
  const f=await setup(t),queued=await f.queue(f.input(1500));
  assert.equal((await f.call(f.channel,{expectedVersion:1,confirmation:'retire-channel development stable'},409,'DELETE')).error.code,'CHANNEL_SCHEDULED');
  await f.call(`/api/projects/${f.development.id}/environments/staging`,{expectedVersion:1},200,'DELETE');
  assert.equal((await f.call(`/api/projects/${f.staging.id}`,{confirmation:'delete-site staging',acknowledgeDataLoss:true},409,'DELETE')).error.code,'PROJECT_RELEASE_SCHEDULED');
  await f.call(f.path+'/'+queued.id+'/cancel',{expectedVersion:1},200);
  assert.equal((await f.call(f.path+'/'+queued.id+'/cancel',{expectedVersion:1},409)).error.code,'RELEASE_WINDOW_VERSION_STALE');
  await sleep(1800);assert.equal((await f.current(queued.id)).state,'cancelled');
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
});

for(const boundary of ['cancel','expire'])test(`${boundary} during real candidate health prevents acceptance and restores the prior database`,{timeout:45_000},async t=>{
  const f=await setup(t,false,100,'v2'),hold=join(f.root,'hold'),barrier=join(f.root,'entered');await writeFile(hold,'hold');
  await f.call(`/api/projects/${f.staging.id}/secrets`,{values:{HEALTH_HOLD:hold,HEALTH_ENTERED:barrier}},200,'PUT');
  const queued=await f.queue(f.input(1000,boundary==='expire'?1800:30_000));
  try{
    await entered(barrier);const running=await f.current(queued.id);assert.equal(running.state,'running');
    if(boundary==='cancel')assert.equal((await f.call(f.path+'/'+queued.id+'/cancel',{expectedVersion:running.version})).schedule.state,'cancelling');
    else await sleep(Math.max(0,Date.parse(running.expiresAt)-Date.now()+100));
    await rm(hold);const terminal=await f.wait(queued.id,boundary==='cancel'?'cancelled':'expired');assert.equal(terminal.targetReleaseId,null);
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
    assert.equal((await f.probe(f.staging)).value,'retained-target');
    const db=new DatabaseSync(join(f.options.dataDirectory,'projects',f.staging.id,'data/app.sqlite'));try{assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(),undefined)}finally{db.close()}
    assert.equal((await f.call(`/api/projects/${f.development.id}/environments/staging/promotions`)).promotions.at(0).state,'failed');
  }finally{await rm(hold,{force:true})}
});

for(const boundary of ['channel','environment','target','dependency'])test(`a queued ${boundary} change rejects the approved schedule without staging`,{timeout:30_000},async t=>{
  const f=await setup(t),queued=await f.queue(f.input(2000));
  if(boundary==='channel')await f.call(f.channel,{sourceEnvironment:'development',releaseId:f.source.id,digest:f.artifact.digest,expectedVersion:1},200,'PUT');
  if(boundary==='environment')await f.bind('staging',f.staging,1);
  if(boundary==='target')await f.upload(f.staging,f.artifact,'window_target_changed_01');
  if(boundary==='dependency')await f.call(`/api/projects/${f.staging.id}/dependencies`,{expectedVersion:0,requirements:[],timeoutMs:5000,overridePolicy:'deny'},200,'PUT');
  const count=(await f.call(`/api/projects/${f.staging.id}/releases`)).releases.length;
  const failed=await f.wait(queued.id,'failed');assert.equal(failed.targetReleaseId,null);
  assert.equal((await f.call(`/api/projects/${f.staging.id}/releases`)).releases.length,count);
});

test('current initiating role is revalidated after queueing and revocation prevents execution',{timeout:30_000},async t=>{
  const f=await setup(t),developer=await f.account('scheduled-developer@example.test'),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,developer.user.id,'developer',Date.now(),Date.now());
  const queued=(await f.call(f.path,f.input(2000),201,'POST',developer)).schedule;
  control.prepare("UPDATE clank_platform_memberships SET role='viewer' WHERE organization_id=? AND user_id=?").run(f.development.organizationId,developer.user.id);
  const failed=await f.wait(queued.id,'failed');assert.equal(failed.failureCode,'ROLE_DENIED');
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
});

test('a pending schedule survives a real controller restart and accepts once',{timeout:45_000},async t=>{
  const f=await setup(t,true),queued=await f.queue(f.input(2500));await f.restart();
  const accepted=await f.wait(queued.id,'accepted');assert.equal((await f.probe(f.staging)).value,'retained-target');
  const before=(await f.call(`/api/projects/${f.staging.id}/dependencies`)).target.activationSequence;
  await f.restart();await sleep(200);assert.equal((await f.current(queued.id)).targetReleaseId,accepted.targetReleaseId);
  assert.equal((await f.call(`/api/projects/${f.staging.id}/dependencies`)).target.activationSequence,before);
});

test('actual controller SIGKILL during scheduled migration retains fences until reviewed recovery',{timeout:75_000},async t=>{
  const f=await setup(t,true,100,'v2'),hold=join(f.root,'hold'),barrier=join(f.root,'entered');await writeFile(hold,'hold');
  await f.call(`/api/projects/${f.staging.id}/secrets`,{values:{HEALTH_HOLD:hold,HEALTH_ENTERED:barrier}},200,'PUT');
  const queued=await f.queue(f.input(1000,120_000));
  try{
    await entered(barrier);await f.killAndRestart();await rm(hold);
    const interrupted=await f.wait(queued.id,'recovery-required');await f.probe(f.staging,'',503);
    await f.call(f.path+'/'+queued.id+'/recover',{expectedVersion:interrupted.version,confirmation:`recover-release-window development ${queued.id}`});
    assert.equal((await f.current(queued.id)).state,'failed');assert.equal((await f.probe(f.staging)).value,'retained-target');
    const db=new DatabaseSync(join(f.options.dataDirectory,'projects',f.staging.id,'data/app.sqlite'));try{assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(),undefined)}finally{db.close()}
    await sleep(200);assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
  }finally{await rm(hold,{force:true})}
});

test('actual device-token CLI queues, inspects, retries and cancels the exact request without building',{timeout:45_000},async t=>{
  const f=await setup(t),server=await f.serve(),device=await f.call('/api/device/start',{clientName:'Release-window CLI acceptance'},201);
  await f.call('/api/device/approve',{code:device.userCode});const token=await f.call('/api/device/token',{deviceCode:device.deviceCode});
  const home=join(f.root,'cli-home');await mkdir(home);await mkdir(join(f.root,'.clank'));
  await writeFile(join(home,'config.json'),JSON.stringify({version:1,current:server,profiles:{[server]:{token:token.accessToken,expiresAt:token.expiresAt}}}),{mode:0o600});
  await writeFile(join(f.root,'.clank/project.json'),JSON.stringify({version:1,server,projectId:f.development.id}),{mode:0o600});
  const run=async args=>JSON.parse((await promisify(execFile)(process.execPath,['--disable-warning=ExperimentalWarning',new URL('../scripts/clank.mjs',import.meta.url).pathname,'release-window',...args,'--json'],{cwd:f.root,env:{...process.env,CLANK_HOME:home},timeout:30_000,maxBuffer:1024*1024})).stdout);
  assert.equal((await run(['list'])).schedules.length,0);await assert.rejects(run(['list','--request','window.json']),/does not apply/);
  const file=join(f.root,'window.json'),input=f.input(1800);await writeFile(file,JSON.stringify(input));
  const queued=(await run(['queue','--request',file])).schedule;assert.equal((await run(['queue','--request',file])).schedule.id,queued.id);
  const accepted=await f.wait(queued.id,'accepted');assert.equal((await run(['show',queued.id])).schedule.targetReleaseId,accepted.targetReleaseId);
  assert.equal((await run(['queue','--request',file])).schedule.id,queued.id);
  await writeFile(file,JSON.stringify({...f.input(1800),expectedActiveReleaseId:accepted.targetReleaseId,idempotencyKey:'window_cli_cancel_exact_01'}));
  const other=(await run(['queue','--request',file])).schedule;
  assert.equal((await run(['cancel',other.id,'--expected-version',String(other.version)])).schedule.state,'cancelled');
  await assert.rejects(run(['queue','--request',file,'--confirm','unexpected']),/does not apply/);
  await sleep(2100);assert.equal((await f.current(other.id)).state,'cancelled');assert.equal((await f.probe(f.staging)).value,'retained-target');
});

test('revoking the actual initiating device token prevents a queued promotion',{timeout:30_000},async t=>{
  const f=await setup(t),server=await f.serve(),device=await f.call('/api/device/start',{clientName:'Scheduled token revocation acceptance'},201);
  await f.call('/api/device/approve',{code:device.userCode});const token=await f.call('/api/device/token',{deviceCode:device.deviceCode});
  const response=await fetch(server+f.path,{method:'POST',headers:{authorization:'Bearer '+token.accessToken,'content-type':'application/json'},body:JSON.stringify(f.input(1500))});
  const queued=await response.json();assert.equal(response.status,201,JSON.stringify(queued));
  const revoked=await fetch(server+'/api/tokens/current',{method:'DELETE',headers:{authorization:'Bearer '+token.accessToken}});assert.equal(revoked.status,200);
  const failed=await f.wait(queued.schedule.id,'failed');assert.equal(failed.failureCode,'INVALID_TOKEN');
  assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
  const control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));try{assert.ok(!control.prepare('SELECT credential FROM clank_platform_release_windows WHERE id=?').get(queued.schedule.id).credential.includes(token.accessToken))}finally{control.close()}
});

test('actual sign-out revokes the initiating session before execution',{timeout:30_000},async t=>{
  const f=await setup(t),inspector=await f.account('scheduled-inspector@example.test'),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,inspector.user.id,'admin',Date.now(),Date.now());
  const queued=await f.queue(f.input(1500));await f.call('/__clank/auth/logout',{});
  const deadline=Date.now()+10_000;let failed;
  for(;;){failed=(await f.call(f.path+'/'+queued.id,undefined,200,'GET',inspector)).schedule;if(failed.state==='failed')break;assert.ok(Date.now()<deadline);await sleep(25)}
  assert.equal(failed.failureCode,'UNAUTHENTICATED');assert.equal((await f.call(`/api/projects/${f.staging.id}`,undefined,200,'GET',inspector)).project.activeReleaseId,f.prior.id);
});

for(const boundary of ['source','target'])test(`revoked ${boundary} authority during actual scheduled candidate health restores prior data`,{timeout:45_000},async t=>{
  const f=await setup(t,false,100,'v2'),developer=await f.account(`scheduled-${boundary}@example.test`),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,developer.user.id,'developer',Date.now(),Date.now());
  const hold=join(f.root,'hold'),barrier=join(f.root,'entered');await writeFile(hold,'hold');await f.call(`/api/projects/${f.staging.id}/secrets`,{values:{HEALTH_HOLD:hold,HEALTH_ENTERED:barrier}},200,'PUT');
  const queued=(await f.call(f.path,f.input(1000),201,'POST',developer)).schedule;
  try{
    await entered(barrier);control.prepare('INSERT INTO clank_platform_project_members(project_id,user_id,permissions) VALUES(?,?,?)').run(boundary==='source'?f.development.id:f.staging.id,developer.user.id,boundary==='source'?'["deploy"]':'["read"]');await rm(hold);
    const failed=await f.wait(queued.id,'failed');assert.equal(failed.failureCode,'ROLE_DENIED');assert.equal((await f.probe(f.staging)).value,'retained-target');
    assert.equal((await f.call(`/api/projects/${f.staging.id}`)).project.activeReleaseId,f.prior.id);
    const db=new DatabaseSync(join(f.options.dataDirectory,'projects',f.staging.id,'data/app.sqlite'));try{assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_only'").get(),undefined)}finally{db.close()}
    if(boundary==='source')assert.equal((await f.call(f.path,undefined,403,'GET',developer)).error.code,'ROLE_DENIED');
    else assert.equal((await f.call(f.path,undefined,200,'GET',developer)).schedules.length,1);
    assert.equal((await f.call(f.channel+'/actions')).actions.filter(row=>['pending','staging','recovery-required'].includes(row.state)).length,0);
  }finally{await rm(hold,{force:true})}
});
