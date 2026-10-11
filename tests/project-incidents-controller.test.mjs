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

const incidentTables=['clank_platform_incident_state','clank_platform_incidents','clank_platform_incident_notes','clank_platform_incident_links','clank_platform_incident_receipts'];
function retained(sql){
  const schema=sql.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const rows=Object.fromEntries(schema.filter(row=>row.type==='table').map(row=>[row.name,sql.prepare('SELECT * FROM '+row.name).all()]));
  return JSON.stringify({schema,rows});
}
for(const table of incidentTables)for(const damage of ['missing','extra-column'])test('retained incident '+table+' '+damage+' refuses live access and reopening without repairs',async t=>{
  const f=await setup(t),incident=f.controller.create(project,f.authority,input);
  await f.controller.change(project,incident.id,f.authority,{expectedVersion:1,operationId:'incident_retained_note_01',change:{kind:'note',text:'Retained note bytes.'}});
  await f.controller.change(project,incident.id,f.authority,request(2,1));
  f.sql.exec(damage==='missing'?'DROP TABLE '+table:'ALTER TABLE '+table+' ADD COLUMN unexpected TEXT');
  const before=retained(f.sql);
  assert.throws(()=>f.controller.create(project,f.authority,{...input,title:'Changed historical request'}),error=>error.code==='INCIDENT_STORAGE_INVALID');
  assert.equal(retained(f.sql),before);
  await assert.rejects(openProjectIncidents(f.sql,f.options,f.hooks),error=>error.code==='INCIDENT_STORAGE_INVALID');
  assert.equal(retained(f.sql),before,'No catalog bootstrap, history rebinding, or surviving row mutation');
});
for(const corruption of ['missing-singleton','extra-singleton'])test('incident '+corruption+' refuses without resetting retained state',async t=>{
  const f=await setup(t);f.controller.create(project,f.authority,input);
  if(corruption==='missing-singleton')f.sql.exec('DELETE FROM clank_platform_incident_state');
  else f.sql.exec('DROP TABLE clank_platform_incident_state;CREATE TABLE clank_platform_incident_state(singleton INTEGER PRIMARY KEY,protocol INTEGER NOT NULL);INSERT INTO clank_platform_incident_state VALUES(1,1),(2,1)');
  const before=retained(f.sql);await assert.rejects(openProjectIncidents(f.sql,f.options,f.hooks),error=>error.code==='INCIDENT_STORAGE_INVALID');assert.equal(retained(f.sql),before);
});

for(const kind of ['receipt','note','link','assign','resolve','version','unlink'])for(const mode of ['ignored','altered'])test('native '+mode+' incident '+kind+' write rolls back effect, version, receipt and audit',async t=>{
 const f=await setup(t);f.sql.exec('CREATE TABLE native_incident_audit(sequence INTEGER PRIMARY KEY,action TEXT,metadata TEXT)');f.authority.audit=(action,metadata)=>f.sql.prepare('INSERT INTO native_incident_audit(action,metadata) VALUES(?,?)').run(action,JSON.stringify(metadata));
 const incident=kind==='receipt'?null:f.controller.create(project,f.authority,input);let version=1,change={kind:'note',text:'Exactly retained note.'};
 if(kind==='link')change={kind:'link',reference:{kind:'release',id:release}};
 if(kind==='assign')change={kind:'assign',ownerId:null};
 if(kind==='resolve')change={kind:'resolve',resolution:'Exact resolution.'};
 if(kind==='unlink'){await f.controller.change(project,incident.id,f.authority,{expectedVersion:1,operationId:'incident_native_link_seed',change:{kind:'link',reference:{kind:'release',id:release}}});version=2;change={kind:'unlink',sequence:Number(f.sql.prepare('SELECT sequence FROM clank_platform_incident_links').get().sequence)};}
 const event=kind==='receipt'?'INSERT ON clank_platform_incident_receipts':kind==='note'?'INSERT ON clank_platform_incident_notes':kind==='link'?'INSERT ON clank_platform_incident_links':kind==='unlink'?'DELETE ON clank_platform_incident_links':kind==='assign'?'UPDATE OF owner_id ON clank_platform_incidents':kind==='resolve'?'UPDATE OF state ON clank_platform_incidents':'UPDATE OF version ON clank_platform_incidents';
 const alter=kind==='receipt'?"UPDATE clank_platform_incident_receipts SET result='{}' WHERE operation_id=NEW.operation_id;":kind==='note'?"UPDATE clank_platform_incident_notes SET text='Changed native note' WHERE sequence=NEW.sequence;":kind==='link'?"UPDATE clank_platform_incident_links SET release_context=NULL WHERE sequence=NEW.sequence;":kind==='unlink'?'INSERT INTO clank_platform_incident_links(sequence,incident_id,reference,release_context) VALUES(OLD.sequence,OLD.incident_id,OLD.reference,OLD.release_context);':kind==='assign'?"UPDATE clank_platform_incidents SET owner_id='foreign_actor_01' WHERE id=NEW.id;":kind==='resolve'?"UPDATE clank_platform_incidents SET resolution='Changed resolution' WHERE id=NEW.id;":'UPDATE clank_platform_incidents SET version=NEW.version+1 WHERE id=NEW.id;';
 f.sql.exec('CREATE TRIGGER native_incident_fault '+(mode==='ignored'?'BEFORE ':'AFTER ')+event+' BEGIN '+(mode==='ignored'?'SELECT RAISE(IGNORE);':alter)+' END');const before=retained(f.sql);
 if(kind==='receipt')assert.throws(()=>f.controller.create(project,f.authority,input),error=>error.code==='INCIDENT_STORAGE_INVALID');else await assert.rejects(f.controller.change(project,incident.id,f.authority,{expectedVersion:version,operationId:'incident_native_fault_operation',change}),error=>error.code==='INCIDENT_STORAGE_INVALID');
 assert.equal(retained(f.sql),before,'No mutation or audit survives failed effect/receipt verification');
 f.sql.exec('DROP TRIGGER native_incident_fault');if(kind==='receipt')assert.equal(f.controller.create(project,f.authority,input).version,1);else assert.equal((await f.controller.change(project,incident.id,f.authority,{expectedVersion:version,operationId:'incident_native_fault_operation',change})).version,version+1);
});
for(const target of ['receipt','note','authority'])test('native audit-side '+target+' alteration is revalidated before incident commit',async t=>{
 const f=await setup(t);f.sql.exec('CREATE TABLE native_incident_audit(sequence INTEGER PRIMARY KEY,action TEXT,metadata TEXT);CREATE TABLE native_incident_authority(allowed INTEGER);INSERT INTO native_incident_authority VALUES(1)');
 f.authority.authorize=()=>{if(f.sql.prepare('SELECT allowed FROM native_incident_authority').get().allowed!==1)throw new Error('Current native authority was revoked')};f.authority.audit=(action,metadata)=>f.sql.prepare('INSERT INTO native_incident_audit(action,metadata) VALUES(?,?)').run(action,JSON.stringify(metadata));
 const incident=f.controller.create(project,f.authority,input),body=target==='receipt'?"UPDATE clank_platform_incident_receipts SET result='{}' WHERE operation_id='incident_native_final_note';":target==='note'?"UPDATE clank_platform_incident_notes SET text='Native audit changed note';":'UPDATE native_incident_authority SET allowed=0;';
 f.sql.exec('CREATE TRIGGER native_audit_fault AFTER INSERT ON native_incident_audit BEGIN '+body+' END');const before=retained(f.sql);
 await assert.rejects(f.controller.change(project,incident.id,f.authority,{expectedVersion:1,operationId:'incident_native_final_note',change:{kind:'note',text:'Final exact note'}}),error=>target==='authority'?/authority was revoked/.test(error.message):error.code==='INCIDENT_STORAGE_INVALID');assert.equal(retained(f.sql),before);
});
