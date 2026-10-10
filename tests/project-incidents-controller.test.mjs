import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as immediate} from 'node:timers/promises';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openProjectIncidents} from '../dist/platform-incidents.js';

const internal=Symbol.for('clank.sqlite.internal'),project='project_exact_01',release='release_exact_01',actor='actor_exact_01';
const input={title:'Dependency recovery',severity:'warning',ownerId:actor,operationId:'incident_create_exact_01'};
const request=(version,index)=>({expectedVersion:version,operationId:'incident_link_exact_'+index,change:{kind:'link',reference:{kind:'job',id:'job_exact_'+index,releaseId:release}}});
async function setup(t,resolve=async(projectId,reference)=>({projectId,reference,available:true,observedAt:Date.now(),state:'succeeded'})){
  const root=await mkdtemp(join(tmpdir(),'clank-incident-controller-')),schema=defineDatabase({}),database=await openSQLite(schema,{path:join(root,'control.sqlite')}),sql=database[internal];
  sql.exec('CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY)');sql.prepare('INSERT INTO clank_platform_projects VALUES(?)').run(project);
  const hooks={release:(id,key)=>id===project&&key===release?{id:release,digest:'a'.repeat(64),createdAt:1000,available:true}:null,alert:()=>null};
  let auditFailure=false;const authority={userId:actor,authorize(){},mayRead(){return true;},ownerAllowed(){return true;},owners(){return [{userId:actor,label:'Operator'}];},audit(){if(auditFailure)throw new Error('Owned audit failure');}};
  const options={diagnostics:{resolve}},controller=await openProjectIncidents(sql,options,hooks);
  t.after(()=>{controller.close();database.close();return rm(root,{recursive:true,force:true});});
  return {root,schema,database,sql,hooks,options,controller,authority,failAudit(value){auditFailure=value;}};
}

test('incident mutation and audit are atomic, including failed creation and failed notes',async t=>{
  const f=await setup(t);f.failAudit(true);assert.throws(()=>f.controller.create(project,f.authority,input),/audit failure/);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incidents').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_receipts').get().n,0);
  f.failAudit(false);const incident=f.controller.create(project,f.authority,input);f.failAudit(true);
  await assert.rejects(f.controller.change(project,incident.id,f.authority,{expectedVersion:1,operationId:'incident_atomic_note_01',change:{kind:'note',text:'Retain only after audit.'}}),/audit failure/);
  assert.equal(f.sql.prepare('SELECT version FROM clank_platform_incidents').get().version,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_notes').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_receipts').get().n,1);
});

test('eight diagnostic references have a request-wide deadline and uncooperative callbacks retain bounded capacity', {timeout:12000},async t=>{
  let hang=false;const pending=[];
  const f=await setup(t,(projectId,reference,signal)=>hang?new Promise(resolve=>pending.push({resolve,signal,projectId,reference})):Promise.resolve({projectId,reference,available:true,observedAt:Date.now(),state:'succeeded'}));
  const incident=f.controller.create(project,f.authority,input);for(let i=0;i<8;i++)await f.controller.change(project,incident.id,f.authority,request(i+1,i));
  hang=true;const start=Date.now(),detail=await f.controller.read(project,incident.id,f.authority,new URLSearchParams());
  assert.ok(Date.now()-start<5000,'All eight links must settle below the client timeout');assert.equal(detail.links.length,8);assert.ok(detail.links.every(link=>link.reason==='adapter-unavailable'));assert.equal(pending.length,4);assert.ok(pending.every(entry=>entry.signal.aborted));
  await assert.rejects(f.controller.change(project,incident.id,f.authority,request(9,8)),error=>error.code==='INCIDENT_DIAGNOSTIC_BUSY');assert.equal(pending.length,4);
  for(const entry of pending)entry.resolve({projectId:entry.projectId,reference:entry.reference,available:true,observedAt:Date.now()});await immediate();
  assert.equal(f.sql.prepare('SELECT version FROM clank_platform_incidents').get().version,9);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_links').get().n,8);
  hang=false;assert.equal((await f.controller.change(project,incident.id,f.authority,request(9,8))).version,10);
});

test('two actual SQLite controllers converge exact retries and reject competing stale changes',async t=>{
  const entries=[];let held=true;
  const f=await setup(t,(projectId,reference)=>held?new Promise(resolve=>entries.push(()=>resolve({projectId,reference,available:true,observedAt:Date.now()}))):Promise.resolve({projectId,reference,available:true,observedAt:Date.now()}));
  const otherDb=await openSQLite(f.schema,{path:join(f.root,'control.sqlite')}),other=await openProjectIncidents(otherDb[internal],f.options,f.hooks);t.after(()=>{other.close();otherDb.close();});
  const incident=f.controller.create(project,f.authority,input),same=request(1,1);
  const left=f.controller.change(project,incident.id,f.authority,same),right=other.change(project,incident.id,f.authority,same);await immediate();assert.equal(entries.length,2);entries.splice(0).forEach(finish=>finish());
  const accepted=await Promise.all([left,right]);assert.deepEqual(accepted[0],accepted[1]);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_links').get().n,1);
  const a=f.controller.change(project,incident.id,f.authority,request(2,2)),b=other.change(project,incident.id,f.authority,request(2,3));await immediate();entries.splice(0).forEach(finish=>finish());const results=await Promise.allSettled([a,b]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'INCIDENT_VERSION_STALE');assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_links').get().n,2);
  held=false;
});

test('adapter projections reject copied payloads and wrong scopes without persisting links or receipts',async t=>{
  let invalid;
  const f=await setup(t,async(projectId,reference)=>({...{projectId,reference,available:true,observedAt:Date.now()},...invalid}));const incident=f.controller.create(project,f.authority,input);
  for(const value of [{projectId:'foreign_project_01'},{reference:{kind:'job',id:'other_job_01',releaseId:release}},{payload:'private payload'},{count:-1},{observedAt:Date.now()+120000}]){
    invalid=value;await assert.rejects(f.controller.change(project,incident.id,f.authority,request(1,1)),error=>error.code==='INCIDENT_DIAGNOSTIC_INVALID');
  }
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_links').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_incident_receipts').get().n,1);
});
