import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {defineDatabase,defineJobs,defineWorkflow,defineWorkflows,openSQLite,openJobs,s} from '../dist/index.js';
import {openErrorInbox} from '../dist/error-inbox.js';
import {createTraceTimeline} from '../dist/trace-timeline.js';

const path = f => `/api/projects/${f.development.id}/incidents`;
const create = f => ({title:'Release recovery',severity:'critical',ownerId:f.owner.user.id,operationId:'incident_create_exact_01'});
const change = (version, kind, fields = {}, operationId = `incident_${kind}_exact_01`) => ({expectedVersion:version,operationId,change:{kind,...fields}});

test('project incidents retain ownership, notes and resolution across restart without replaying later changes', async t => {
  const f=await fixture(t), input=create(f), incident=(await f.call(path(f),input,201)).incident;
  assert.equal(incident.state,'open');assert.equal(incident.ownerId,f.owner.user.id);assert.equal(incident.version,1);
  assert.equal((await f.call(path(f))).incidents.length,1);
  const endpoint=path(f)+'/'+incident.id;
  const note=change(1,'note',{text:'Dependency recovered; verify the job timeline.'});
  assert.equal((await f.call(endpoint+'/change',note)).incident.version,2);
  const resolved=change(2,'resolve',{resolution:'Verified a healthy release and completed recovery.'});
  assert.equal((await f.call(endpoint+'/change',resolved)).incident.state,'resolved');
  const reopened=change(3,'reopen');
  assert.equal((await f.call(endpoint+'/change',reopened)).incident.state,'open');
  const unassigned=change(4,'assign',{ownerId:null});
  assert.equal((await f.call(endpoint+'/change',unassigned)).incident.ownerId,null);
  await f.restart();
  assert.equal((await f.call(path(f),input,201)).incident.id,incident.id);
  assert.equal((await f.call(endpoint+'/change',note)).incident.version,2);
  assert.equal((await f.call(endpoint+'/change',resolved)).incident.state,'resolved');
  const detail=(await f.call(endpoint)).detail;
  assert.equal(detail.incident.version,5);assert.equal(detail.incident.state,'open');assert.equal(detail.incident.ownerId,null);
  assert.equal(detail.notes.length,1);assert.equal(detail.notes[0].text,note.change.text);
  assert.equal((await f.call(endpoint+'/change',{...note,change:{kind:'note',text:'Changed retry'}},409)).error.code,'INCIDENT_RETRY_CHANGED');
  assert.equal((await f.call(endpoint+'/change',change(1,'note',{text:'Stale new operation'},'incident_new_stale_01'),409)).error.code,'INCIDENT_VERSION_STALE');
});

test('incident permission and current membership fence reads, assignment and retained receipts', async t => {
  const f=await fixture(t), reader=await f.account('incident-reader@example.test');
  const control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  const now=Date.now();control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
  await f.call(path(f),undefined,403,'GET',reader);
  await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','incidents']},200,'PUT');
  assert.equal((await f.call(path(f),undefined,200,'GET',reader)).incidents.length,0);
  const input={...create(f),ownerId:reader.user.id,operationId:'incident_scoped_create_01'};
  const incident=(await f.call(path(f),input,201,'POST',reader)).incident;
  const another=await f.account('incident-outside@example.test');
  await f.call(path(f)+'/'+incident.id+'/change',change(1,'assign',{ownerId:another.user.id}),403);
  await f.call(path(f)+'/'+incident.id,undefined,404,'GET',another);
  control.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId,reader.user.id);
  await f.call(path(f),undefined,404,'GET',reader);
  await f.call(path(f),input,404,'POST',reader);
  assert.equal((await f.call(path(f))).incidents.length,1);
});

test('incident capacity refuses new work while exact historical retries preserve their original occurrence', async t => {
  const f=await fixture(t,false,{incidents:{maxIncidents:1,maxReceipts:3}}),input=create(f);
  const incident=(await f.call(path(f),input,201)).incident, endpoint=path(f)+'/'+incident.id;
  await f.call(path(f),{...input,operationId:'incident_second_create_01'},409);
  await f.call(endpoint+'/change',change(1,'note',{text:'First note.'}));
  await f.call(endpoint+'/change',change(2,'note',{text:'Second note.'},'incident_second_note_01'));
  const denied=await f.call(endpoint+'/change',change(3,'resolve',{resolution:'Capacity is full.'}),409);
  assert.equal(denied.error.code,'INCIDENT_RECEIPT_CAPACITY');
  await f.restart();assert.equal((await f.call(path(f),input,201)).incident.version,1);
  const detail=(await f.call(endpoint)).detail;assert.equal(detail.incident.version,3);assert.equal(detail.notes.length,2);
});

test('unknown incident protocol fences already-open and restarted controllers', async t => {
  const f=await fixture(t),incident=(await f.call(path(f),create(f),201)).incident;
  const control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  control.prepare('UPDATE clank_platform_incident_state SET protocol=2 WHERE singleton=1').run();
  const response=await f.call(path(f)+'/'+incident.id,undefined,409);
  assert.equal(response.error.code,'INCIDENT_PROTOCOL_UNSUPPORTED');
  await assert.rejects(f.restart(),/incident.*protocol/i);
});

test('incident references follow actual recurrence, traces, jobs, workflows and native alerts without copying private diagnostics', {timeout:30000}, async t => {
  let diagnostics, releaseId, projectId;
  const f=await fixture(t,false,{platformAdminEmails:['promotion-owner@example.test'],operations:{intervalMs:false},incidents:{diagnostics:{async resolve(project,reference){
    assert.equal(project,projectId);assert.equal(reference.releaseId,releaseId);
    return diagnostics(reference);
  }}}});projectId=f.development.id;
  const artifact=await f.artifact('incident-actual-release'),release=await f.upload(f.development,artifact,'incident_release_exact_01');releaseId=release.id;
  const schema=defineDatabase({}),database=await openSQLite(schema,{path:join(f.root,'incident-app.sqlite')}),inbox=await openErrorInbox(database),timeline=createTraceTimeline();
  const jobs=defineJobs({schema}).jobs(({job})=>({work:job({args:{private:s.string()},returns:s.string(),handler:()=> 'completed'})}));
  const workflow=defineWorkflow({args:{private:s.string()},graph:graph=>({work:graph.step(jobs.jobs.work,{args:({input})=>input})})});
  const runtime=openJobs(defineWorkflows(jobs,{recovery:workflow}),{database});t.after(()=>{runtime.close();database.close();});
  const job=runtime.enqueue(jobs.jobs.work,{private:'private-job-payload'}),run=runtime.startWorkflow(workflow,{private:'private-workflow-payload'});
  while(await runtime.workOnce());assert.equal(runtime.get(job.id).state,'succeeded');assert.equal(runtime.getWorkflow(run.id).state,'succeeded');
  const traceId='a'.repeat(32);
  await timeline.export([{traceId,spanId:'b'.repeat(16),name:'job work',kind:'internal',status:'ok',startTimeUnixNano:'1000000000',endTimeUnixNano:'1010000000',attributes:{'clank.job.id':job.id,'clank.job.attempt':1,private:'private-trace-payload'}}]);
  const error=new Error('private-error-message');error.stack='Error: private-error-message\n at handler (file:///private/source.js:1:1)';
  const fingerprint=inbox.capture(error,{release:releaseId,traceId,code:'RECOVERY_FAILURE'});
  diagnostics = reference => {
    const base={projectId,reference,observedAt:Date.now()};
    if(reference.kind==='error'){const group=inbox.snapshot({release:releaseId}).groups.find(g=>g.fingerprint===reference.id);return {...base,available:Boolean(group),...(group?{state:group.state,count:group.occurrences}:{})};}
    if(reference.kind==='trace'){const spans=timeline.snapshot(reference.id).spans;return {...base,available:spans.length>0,count:spans.length};}
    const record=reference.kind==='job'?runtime.get(reference.id):runtime.getWorkflow(reference.id);
    return {...base,available:Boolean(record),...(record?{state:record.state,count:reference.kind==='job'?runtime.events(reference.id).length:runtime.workflowEvents(reference.id).length}:{})};
  };
  const incident=(await f.call(path(f),create(f),201)).incident,endpoint=path(f)+'/'+incident.id;
  const alerts=(await f.call('/api/admin/operations/run',{})).alerts;
  const alert=alerts.find(row=>row.resourceId===projectId);assert.ok(alert);
  const refs=[{kind:'release',id:releaseId},{kind:'error',id:fingerprint,releaseId},{kind:'trace',id:traceId,releaseId},{kind:'job',id:job.id,releaseId},{kind:'workflow',id:run.id,releaseId},{kind:'alert',id:alert.key}];
  let version=1;for(const [index,reference] of refs.entries())version=(await f.call(endpoint+'/change',change(version,'link',{reference},'incident_link_actual_'+index))).incident.version;
  let detail=(await f.call(endpoint)).detail;assert.equal(detail.links.length,6);assert.ok(detail.links.every(link=>link.available));assert.equal(detail.links.find(link=>link.kind==='alert').diagnostic.state,alert.state);
  inbox.resolve(fingerprint,releaseId);assert.equal((await f.call(endpoint)).detail.links.find(link=>link.kind==='error').diagnostic.state,'resolved');
  inbox.capture(error,{release:releaseId,code:'RECOVERY_FAILURE'});detail=(await f.call(endpoint)).detail;assert.equal(detail.links.find(link=>link.kind==='error').diagnostic.state,'regressed');assert.equal(detail.links.find(link=>link.kind==='error').diagnostic.count,2);
  const reader=await f.account('incident-link-reader@example.test'),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());const now=Date.now();
  control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
  await f.call(`/api/projects/${projectId}/members/${reader.user.id}`,{permissions:['read','incidents']},200,'PUT');
  const restricted=(await f.call(endpoint,undefined,200,'GET',reader)).detail;
  assert.equal(restricted.links.filter(link=>link.reason==='permission-required').length,5);for(const link of restricted.links.filter(link=>link.reason==='permission-required')){assert.equal(link.reference,null);assert.equal(link.releaseContext,null);assert.equal(link.diagnostic,null);}
  await f.call(endpoint+'/change',change(version,'link',{reference:{kind:'release',id:(await f.upload(f.staging,await f.artifact('incident-other-project'),'incident_other_release_01')).id}},'incident_foreign_release_01'),404);
  const other=alerts.find(row=>row.resourceId!==projectId);assert.ok(other);await f.call(endpoint+'/change',change(version,'link',{reference:{kind:'alert',id:other.key}},'incident_foreign_alert_01'),404);
  await f.upload(f.development,await f.artifact('incident-replacement-release'),'incident_replacement_exact_01');
  await f.call(`/api/projects/${projectId}/releases/${releaseId}`,{confirmation:`delete-release development ${releaseId}`,allowRollbackLoss:true},200,'DELETE');
  await f.restart();detail=(await f.call(endpoint)).detail;
  for(const link of detail.links.filter(link=>link.kind!=='alert')){assert.equal(link.available,false);assert.equal(link.reason,'not-retained');assert.equal(link.releaseContext.id,releaseId);assert.equal(link.releaseContext.digest,artifact.digest);assert.equal(link.diagnostic,null);}
  const persisted=control.prepare('SELECT reference,release_context FROM clank_platform_incident_links').all();assert.deepEqual(persisted.map(row=>JSON.parse(row.reference)),refs);for(const row of persisted)if(row.release_context!==null)assert.deepEqual(Object.keys(JSON.parse(row.release_context)).sort(),['createdAt','digest','id']);assert.doesNotMatch(JSON.stringify(persisted),/private-(?:error|job|workflow|trace)|\b(?:payload|frames|spanId|args|leaseOwner)\b/);
});

test('current membership, permission and session fence a body held after authentication',async t=>{
  const f=await fixture(t),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  for(const boundary of ['permission','membership','session']){
    const reader=await f.account('incident-held-'+boundary+'@example.test'),now=Date.now();
    control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
    await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','incidents']},200,'PUT');
    let controller,entered;const reading=new Promise(resolve=>entered=resolve);
    const body=new ReadableStream({start(value){controller=value;},pull(){entered();}},{highWaterMark:0});
    const pending=f.handle(new Request(f.options.publicUrl+path(f),{method:'POST',headers:{origin:f.options.publicUrl,cookie:reader.cookie,'x-clank-csrf':reader.csrf,'content-type':'application/json'},body,duplex:'half'}));
    await reading;
    if(boundary==='permission')await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read']},200,'PUT');
    else if(boundary==='membership')control.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(f.development.organizationId,reader.user.id);
    else control.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(reader.user.id);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({...create(f),ownerId:null,operationId:'incident_held_body_'+boundary})));controller.close();
    const response=await pending;assert.equal(response.status,boundary==='permission'?403:boundary==='membership'?404:401);
    assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_incidents').get().n,0);assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_incident_receipts').get().n,0);
  }
});

test('role, session, protocol and version changes during held diagnostics cannot authorize late commits', {timeout:30000},async t=>{
  let held;
  const f=await fixture(t,false,{incidents:{diagnostics:{async resolve(projectId,reference){
    held.enter();await held.wait;return {projectId,reference,available:true,observedAt:Date.now(),state:'succeeded'};
  }}}}),control=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>control.close());
  const release=await f.upload(f.development,await f.artifact('incident-held-diagnostic'),'incident_held_diagnostic_01');
  const incident=(await f.call(path(f),create(f),201)).incident,endpoint=path(f)+'/'+incident.id;
  for(const boundary of ['permission','session','version','protocol']){
    const reader=await f.account('incident-diag-'+boundary+'@example.test'),now=Date.now();
    control.prepare('INSERT INTO clank_platform_memberships(organization_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.development.organizationId,reader.user.id,'viewer',now,now);
    await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','incidents','jobs']},200,'PUT');
    let enter,finish;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>finish=resolve);held={enter,wait};
    const version=control.prepare('SELECT version FROM clank_platform_incidents WHERE id=?').get(incident.id).version;
    const input=change(version,'link',{reference:{kind:'job',id:'held_job_'+boundary,releaseId:release.id}},'incident_held_diag_'+boundary);
    const pending=f.call(endpoint+'/change',input,boundary==='permission'?403:boundary==='session'?401:409,'POST',reader);await entered;
    if(boundary==='permission')await f.call(`/api/projects/${f.development.id}/members/${reader.user.id}`,{permissions:['read','incidents']},200,'PUT');
    else if(boundary==='session')control.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(reader.user.id);
    else if(boundary==='version')await f.call(endpoint+'/change',change(version,'note',{text:'A newer verified change.'},'incident_concurrent_note_01'));
    else control.prepare('UPDATE clank_platform_incident_state SET protocol=2').run();
    finish();await pending;
    assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_incident_links').get().n,0);assert.equal(control.prepare('SELECT count(*) AS n FROM clank_platform_incident_receipts WHERE operation_id=?').get(input.operationId).n,0);
    control.prepare('UPDATE clank_platform_incident_state SET protocol=1').run();
  }
});
