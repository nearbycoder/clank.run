import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openPlatformStatusPages} from '../dist/platform-status-pages.js';
const internal=Symbol.for('clank.sqlite.internal'),project='project_status_native_01';
const configuration=()=>({slug:'customer-health',title:'Service health',description:'Approved customer information.',components:[{key:'checkout',label:'Checkout',source:{kind:'manual',health:'operational',observedAt:Date.now()-1000,expiresAt:Date.now()+60000}}]});
const copy={title:'Checkout is recovering',message:'Retry the checkout in a few minutes.',state:'monitoring',components:['checkout']};
async function setup(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'clank-status-native-')),schema=defineDatabase({}),db=await openSQLite(schema,{path:join(root,'control.sqlite')}),sql=db[internal];sql.exec('CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY)');sql.prepare('INSERT INTO clank_platform_projects VALUES(?)').run(project);
 let allowed=true,scope='private-owner-and-organization',generation=0,incidentVersion=1,afterAudit=()=>{},sourceReads=0;
 const hooks={hash:value=>createHash('sha256').update(value).digest('hex'),scope:()=>scope,domainReserved:()=>false,incidentVersion(){sourceReads++;return incidentVersion;},slo(){throw new Error('Use native platform SLO tests for this source.');}};
 const authority={userId:'actor_status_native_01',authorize(){if(!allowed)throw new Error('Native authority revoked.');},binding:()=>String(generation),audit(){afterAudit();}};
 const controller=openPlatformStatusPages(sql,options,hooks),controllers=[controller],databases=[db];
 t.after(()=>{controllers.forEach(c=>c.close());databases.forEach(d=>d.close());return rm(root,{recursive:true,force:true});});
 return {controller,authority,sql,configuration:configuration(),hooks,sourceReads:()=>sourceReads,changeIncident:()=>incidentVersion++,changeAuthority:()=>generation++,revoke:()=>allowed=false,scope:value=>scope=value,audit:value=>afterAudit=value,async fresh(){const next=await openSQLite(schema,{path:join(root,'control.sqlite')}),c=openPlatformStatusPages(next[internal],options,hooks);controllers.push(c);databases.push(next);return c;}};
}
const create=f=>f.controller.create(project,f.authority,{configuration:f.configuration,operationId:'status_native_create_01'});
const review=(f,page,publication={kind:'page'})=>f.controller.preview(project,f.authority,{expectedVersion:page.version,publication});
const commit=(f,preview,operationId='status_native_publish_01')=>f.controller.publish(project,f.authority,{expectedVersion:preview.expectedVersion,previewId:preview.id,previewDigest:preview.digest,operationId});
test('native public projections expose only dedicated public labels, copy and independent public update identifiers',async t=>{
 const f=await setup(t),created=create(f);assert.equal(created.published,false);assert.throws(()=>f.controller.publicPage(f.configuration.slug),e=>e.status===404);
 const page=commit(f,review(f,created));assert.equal(page.version,2);
 const subscriber={...f.authority,userId:'subscriber_status_native_01'};f.controller.subscribe(f.configuration.slug,subscriber,{subscribed:true,components:[],expectedVersion:0,operationId:'status_subscribe_01'});
 const publication={kind:'update',copy,incident:{id:'private_incident_native_01',expectedVersion:1}},preview=review(f,page,publication),published=commit(f,preview,'status_native_update_01');
 const snapshot=f.controller.publicPage(f.configuration.slug),serialized=JSON.stringify(snapshot);for(const privateValue of [project,'private_incident_native_01','private-owner-and-organization',subscriber.userId,'actor_status_native_01'])assert.equal(serialized.includes(privateValue),false);
 assert.deepEqual(Object.keys(snapshot).sort(),['components','description','protocol','publishedAt','slug','title','updates']);assert.equal(snapshot.updates.length,1);assert.deepEqual(snapshot.updates[0].message,copy.message);
 const reads=f.sourceReads();f.controller.publicPage(f.configuration.slug);assert.equal(f.sourceReads(),reads,'Public GET must not query or transition a private incident.');
 const inbox=f.controller.notifications(f.configuration.slug,subscriber,0);assert.equal(inbox.notifications.length,1);assert.deepEqual(inbox.notifications[0].update,snapshot.updates[0]);assert.equal(inbox.next,null);
 assert.equal(commit(f,preview,'status_native_update_01').version,published.version);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n,1);
});
test('native versions, exact intents and current private provenance fence publication before writes',async t=>{
 const f=await setup(t),created=create(f),preview=review(f,created);assert.throws(()=>f.controller.publish(project,f.authority,{expectedVersion:1,previewId:preview.id,previewDigest:'f'.repeat(64),operationId:'status_wrong_preview_01'}),e=>e.code==='STATUS_PREVIEW_STALE');
 const page=commit(f,preview),update=review(f,page,{kind:'update',copy,incident:{id:'private_incident_native_01',expectedVersion:1}});f.changeIncident();assert.throws(()=>commit(f,update,'status_stale_incident_01'),e=>e.code==='STATUS_SOURCE_CHANGED');
 const other=review(f,page);f.changeAuthority();assert.throws(()=>commit(f,other,'status_stale_actor_01'),e=>e.code==='STATUS_SOURCE_CHANGED');assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,0);
 assert.throws(()=>f.controller.create(project,f.authority,{configuration:{...f.configuration,title:'Different'},operationId:'status_native_create_01'}),e=>e.code==='STATUS_OPERATION_CONFLICT');
 f.revoke();assert.throws(()=>commit(f,preview),/revoked/);
});
test('restart retires earlier health and previews, preserving public text and exact committed notifications',async t=>{
 const f=await setup(t),created=create(f),page=commit(f,review(f,created)),subscriber={...f.authority,userId:'subscriber_status_native_02'};f.controller.subscribe(f.configuration.slug,subscriber,{subscribed:true,components:[],expectedVersion:0,operationId:'status_subscribe_02'});
 const update=review(f,page,{kind:'update',copy,incident:null}),published=commit(f,update,'status_restart_update_01'),oldPreview=review(f,published),next=await f.fresh();
 assert.throws(()=>f.controller.publicPage(f.configuration.slug),e=>e.code==='STATUS_CONTROLLER_REPLACED');
 const after=next.publicPage(f.configuration.slug);assert.equal(after.components[0].health,'unknown');assert.equal(after.components[0].complete,false);assert.equal(after.updates[0].message,copy.message);
 assert.throws(()=>next.publish(project,f.authority,{expectedVersion:oldPreview.expectedVersion,previewId:oldPreview.id,previewDigest:oldPreview.digest,operationId:'status_retired_preview_01'}),e=>e.code==='STATUS_PREVIEW_STALE');
 assert.equal(next.publish(project,f.authority,{expectedVersion:update.expectedVersion,previewId:update.id,previewDigest:update.digest,operationId:'status_restart_update_01'}).version,published.version);assert.equal(next.notifications(f.configuration.slug,subscriber,0).notifications.length,1);
});
for(const mode of ['ignore','alter'])for(const table of ['pages','previews','updates','notifications','receipts','subscribers'])test(`native ${mode} ${table} acknowledgment rejects the entire status transaction`,async t=>{
 const f=await setup(t),created=create(f),page=commit(f,review(f,created)),subscriber={...f.authority,userId:'subscriber_status_native_03'};f.controller.subscribe(f.configuration.slug,subscriber,{subscribed:true,components:[],expectedVersion:0,operationId:'status_subscribe_03'});
 const before={page:f.controller.page(project,f.authority),updates:f.sql.prepare('SELECT * FROM clank_platform_status_updates').all(),receipts:f.sql.prepare('SELECT * FROM clank_platform_status_receipts').all(),notifications:f.sql.prepare('SELECT * FROM clank_platform_status_notifications').all()};
 const target='clank_platform_status_'+table,event=table==='pages'?'UPDATE':'INSERT',field={pages:'version',previews:'digest',updates:'copy',notifications:'record',receipts:'result',subscribers:'components'}[table],changed=field==='version'?'NEW.version+10':field==='digest'?"'"+'f'.repeat(64)+"'":"'{}'",where=table==='subscribers'?'page_id=NEW.page_id AND actor_id=NEW.actor_id':table==='receipts'?'page_id=NEW.page_id AND actor_id=NEW.actor_id AND operation_id=NEW.operation_id':'id=NEW.id';
 f.sql.exec(mode==='ignore'?`CREATE TRIGGER status_fault BEFORE ${event} ON ${target} BEGIN SELECT RAISE(IGNORE); END;`:`CREATE TRIGGER status_fault AFTER ${event} ON ${target} BEGIN UPDATE ${target} SET ${field}=${changed} WHERE ${where}; END;`);
 const run=()=>table==='previews'?review(f,page):table==='subscribers'?f.controller.subscribe(f.configuration.slug,{...subscriber,userId:'subscriber_status_native_04'},{subscribed:true,components:[],expectedVersion:0,operationId:'status_subscribe_fault_01'}):table==='receipts'?f.controller.configure(project,f.authority,{configuration:f.configuration,expectedVersion:page.version,operationId:'status_receipt_fault_01'}):commit(f,review(f,page,{kind:'update',copy,incident:null}),'status_publish_fault_01');
 assert.throws(run,e=>e.code==='STATUS_ACKNOWLEDGEMENT');assert.deepEqual(f.controller.page(project,f.authority),before.page);for(const key of ['updates','receipts','notifications'])assert.deepEqual(f.sql.prepare('SELECT * FROM clank_platform_status_'+key).all(),before[key]);
});
test('late native audit alteration and capacity denial preserve retained publication history',async t=>{
 const f=await setup(t,{maxUpdates:1}),created=create(f),page=commit(f,review(f,created)),update=review(f,page,{kind:'update',copy,incident:null});
 f.audit(()=>f.sql.prepare("UPDATE clank_platform_status_updates SET copy='{}'").run());assert.throws(()=>commit(f,update,'status_late_alter_01'),e=>e.code==='STATUS_ACKNOWLEDGEMENT');assert.equal(f.sql.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,0);
 f.audit(()=>{});const published=commit(f,update,'status_late_alter_01');assert.throws(()=>commit(f,review(f,published,{kind:'update',copy,incident:null}),'status_capacity_02'),e=>e.code==='STATUS_CAPACITY');assert.equal(f.controller.publicPage(f.configuration.slug).updates.length,1);
});
test('unknown protocol and ownership rebinding never disclose retained data as a current public page',async t=>{
 const f=await setup(t),created=create(f),page=commit(f,review(f,created));f.scope('different-private-owner');assert.throws(()=>f.controller.publicPage(f.configuration.slug),e=>e.status===404);
 const changed=f.controller.configure(project,f.authority,{configuration:f.configuration,expectedVersion:page.version,operationId:'status_rebind_01'});assert.equal(changed.published,false);
 f.sql.prepare('UPDATE clank_platform_status_state SET protocol=99').run();assert.throws(()=>f.controller.page(project,f.authority),e=>e.code==='STATUS_PROTOCOL');await assert.rejects(f.fresh(),e=>e.code==='STATUS_PROTOCOL');assert.equal(f.sql.prepare('SELECT protocol FROM clank_platform_status_state').get().protocol,99);
});
test('native observation expiry stays unknown after a wall-clock reversal and page capacity retains exact old receipts',async t=>{
 const f=await setup(t,{maxPages:1}),created=create(f);commit(f,review(f,created));const original=Date.now,now=original();let wall=now;Date.now=()=>wall;t.after(()=>Date.now=original);
 wall=f.configuration.components[0].source.expiresAt+1;assert.equal(f.controller.publicPage(f.configuration.slug).components[0].health,'unknown');wall=now-60000;assert.equal(f.controller.publicPage(f.configuration.slug).components[0].health,'unknown');assert.equal(create(f).version,1);
 f.sql.prepare('UPDATE clank_platform_status_state SET clock=-1').run();assert.throws(()=>f.controller.publicPage(f.configuration.slug),e=>e.code==='STATUS_STATE_INVALID');
});
