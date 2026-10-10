import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {step} from './fixtures/customer-status-passkey.mjs';
import {fixture} from './fixtures/platform-environment-fixture.mjs';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';
import {openPlatform} from '../dist/platform.js';

async function setup(t,subprocess=false,extra={}){
 const ports=await reservePlatformTestPorts();t.after(()=>ports.release());
 const f=await fixture(t,subprocess,{publicUrl:'http://127.0.0.1:'+ports.start,freshAuthentication:{required:false},...extra});
 const db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));t.after(()=>db.close());
 await step(f,db,f.owner);
 const configuration={slug:'customer-health',title:'Customer health',description:'Approved service information.',components:[{key:'checkout',label:'Checkout',source:{kind:'manual',health:'operational',observedAt:Date.now()-1000,expiresAt:Date.now()+60000}}]},path=`/api/projects/${f.development.id}/status-page`;
 const create=async()=> (await f.call(path+'/create',{configuration,operationId:'status_http_create_01'},201)).page;
 const review=async(page,publication={kind:'page'})=>(await f.call(path+'/preview',{expectedVersion:page.version,publication})).preview;
 const commit=async(preview,operationId='status_http_publish_01',expected=200)=>(await f.call(path+'/publish',{expectedVersion:preview.expectedVersion,previewId:preview.id,previewDigest:preview.digest,operationId},expected)).page;
 const publicPage=async()=>{const response=await f.handle(new Request(f.options.publicUrl+'/api/status/customer-health'));assert.equal(response.status,200);return response.json();};
 return {...f,db,path,configuration,create,review,commit,publicPage};
}
const copy={title:'Checkout is recovering',message:'Try the checkout again shortly.',state:'monitoring',components:['checkout']};
test('a replaced status controller preserves unrelated routes and current domain reservations without restoring its publication authority',async t=>{
 const f=await setup(t,false,dnsOptions(async()=>[])),created=await f.create();
 const domain=(await f.call(f.path+'/domains/begin',{hostname:'retained.customer.test',expectedVersion:created.version,operationId:'status_replacement_domain_01'},201)).domain;
 const second=await openPlatform(f.options);t.after(()=>second.close());
 assert.equal((await f.handle(new Request(f.options.publicUrl+'/healthz'))).status,200);
 assert.equal((await f.handle(new Request(f.options.publicUrl+'/livez'))).status,200);
 await f.call('/api/dashboard',undefined,200,'GET');
 await f.call(`/api/projects/${f.staging.id}/domains`,{hostname:domain.hostname},409);
 await f.call(f.path,undefined,409,'GET');
 assert.equal((await second.handle(new Request('https://unknown.customer.test/api/status/customer-health'))).status,404);
 assert.equal((await second.handle(new Request('https://'+domain.hostname+'/api/dashboard'))).status,404);
});
test('status routes require the canonical host without changing legacy non-ingress health routing',async t=>{
 const f=await setup(t,false,{ingress:undefined});
 assert.equal((await f.handle(new Request('https://unrelated.customer.test/healthz'))).status,200);
 for(const path of ['/status/customer-health','/status/customer-health/preferences','/api/status/customer-health',f.path,`/projects/${f.development.id}/status`])
  assert.equal((await f.handle(new Request('https://unrelated.customer.test'+path))).status,404,path);
});
test('native status publication requires actual recent assurance and public HTTP never copies a private incident',async t=>{
 const f=await setup(t),password=await f.account('status-password@example.test');
 const member={...f.owner};f.db.prepare("UPDATE clank_auth_sessions SET authentication_method='password',authenticated_at=0 WHERE user_id=?").run(f.owner.user.id);
 await f.call(f.path+'/create',{configuration:f.configuration,operationId:'status_password_create_01'},403);await step(f,f.db,f.owner);
 const page=await f.commit(await f.review(await f.create())),subscriber=await f.account('status-customer@example.test');
 await f.call('/api/status/customer-health/preferences',{subscribed:true,components:['checkout'],expectedVersion:0,operationId:'status_http_subscribe_01'},200,'POST',subscriber);
 const incident=(await f.call(`/api/projects/${f.development.id}/incidents`,{title:'PRIVATE tenant-secret /internal/path trace-SECRET',severity:'critical',ownerId:null,operationId:'status_private_incident_01'},201)).incident;
 const preview=await f.review(page,{kind:'update',copy,incident:{id:incident.id,expectedVersion:incident.version}}),published=await f.commit(preview,'status_http_update_01');
 const publicData=await f.publicPage(),publicText=JSON.stringify(publicData);for(const value of ['PRIVATE','tenant-secret','/internal/path','trace-SECRET',incident.id,f.development.id,f.development.organizationId,f.owner.user.id,subscriber.user.id])assert.equal(publicText.includes(value),false,value);
 assert.deepEqual(publicData.updates[0].message,copy.message);const inbox=(await f.call('/api/status/customer-health/notifications',undefined,200,'GET',subscriber)).page;assert.equal(inbox.notifications.length,1);
 assert.equal((await f.call('/api/status/customer-health/notifications',undefined,200,'GET',password)).page.notifications.length,0);
 await f.commit(preview,'status_http_update_01');assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n,1);
 const token=(await f.call(`/api/projects/${f.development.id}/tokens`,{name:'Status human boundary',permissions:['read'],expiresIn:300},201)).token;
 const denied=await f.handle(new Request(f.options.publicUrl+f.path,{headers:{authorization:'Bearer '+token.accessToken}}));assert.equal(denied.status,403);
 const html=await f.handle(new Request(f.options.publicUrl+'/status/customer-health'));assert.equal(html.status,200);assert.match(await html.text(),/Checkout is recovering/);assert.equal(html.headers.get('cache-control'),'no-store');
 assert.equal(published.published,true);
});
for(const mutation of ['role','membership-incarnation','session','freshness','protocol'])test(`native held publication body cannot commit after ${mutation}`,async t=>{
 const f=await setup(t),created=await f.create(),preview=await f.review(created);let controller,enter;const entered=new Promise(resolve=>enter=resolve),body=new ReadableStream({start(c){controller=c;},pull(){enter();}},{highWaterMark:0});
 const pending=f.handle(new Request(f.options.publicUrl+f.path+'/publish',{method:'POST',headers:{origin:f.options.publicUrl,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body,duplex:'half'}));await entered;
 if(mutation==='role')f.db.prepare("UPDATE clank_platform_memberships SET role='viewer' WHERE organization_id=? AND user_id=?").run(f.development.organizationId,f.owner.user.id);
 if(mutation==='membership-incarnation'){const r=f.db.prepare('SELECT * FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(f.development.organizationId,f.owner.user.id);f.db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(r.organization_id,r.user_id);f.db.prepare('INSERT INTO clank_platform_memberships VALUES(?,?,?,?,?)').run(r.organization_id,r.user_id,r.role,r.created_at,r.updated_at);}
 if(mutation==='session')f.db.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(f.owner.user.id);
 if(mutation==='freshness')f.db.prepare('UPDATE clank_auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now()-300001,f.owner.user.id);
 if(mutation==='protocol')f.db.prepare('UPDATE clank_platform_status_state SET protocol=99').run();
 controller.enqueue(new TextEncoder().encode(JSON.stringify({expectedVersion:created.version,previewId:preview.id,previewDigest:preview.digest,operationId:'status_held_publish_01'})));controller.close();const response=await pending;assert.equal(response.status,mutation==='role'?403:mutation==='session'?401:409,await response.text());
 assert.equal(f.db.prepare('SELECT snapshot FROM clank_platform_status_pages').get().snapshot,null);assert.equal(f.db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE action='status.page.publish'").get().n,0);
 f.db.prepare('UPDATE clank_platform_status_state SET protocol=1').run();
});
for(const mode of ['ignore','alter'])test(`native ${mode} status audit rolls back public effects and the exact receipt`,async t=>{
 const f=await setup(t),created=await f.create(),preview=await f.review(created);f.db.exec(mode==='ignore'?"CREATE TRIGGER status_audit_fault BEFORE INSERT ON clank_platform_audit WHEN NEW.action='status.page.publish' BEGIN SELECT RAISE(IGNORE); END;":"CREATE TRIGGER status_audit_fault AFTER INSERT ON clank_platform_audit WHEN NEW.action='status.page.publish' BEGIN UPDATE clank_platform_audit SET metadata='{}' WHERE id=NEW.id; END;");await f.commit(preview,'status_audit_fault_01',409);
 assert.equal(f.db.prepare('SELECT snapshot FROM clank_platform_status_pages').get().snapshot,null);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_receipts WHERE operation_id=?').get('status_audit_fault_01').n,0);
});
test('actual SIGKILL preserves committed public updates and one subscriber receipt while retiring health and pending reviews',async t=>{
 const f=await setup(t,true),created=await f.create(),page=await f.commit(await f.review(created)),subscriber=await f.account('status-restart-customer@example.test');
 await f.call('/api/status/customer-health/preferences',{subscribed:true,components:[],expectedVersion:0,operationId:'status_restart_subscriber_01'},200,'POST',subscriber);
 const update=await f.review(page,{kind:'update',copy,incident:null}),published=await f.commit(update,'status_restart_update_01'),pending=await f.review(published);await f.killAndRestart();
 const publicData=await f.publicPage();assert.equal(publicData.components[0].health,'unknown');assert.equal(publicData.updates.length,1);await f.commit(pending,'status_restart_stale_01',409);await f.commit(update,'status_restart_update_01');assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n,1);
});
function dnsOptions(resolveTxt){return {ingress:{baseDomain:'apps.example.test',customDomainTarget:'edge.example.test',tlsAskToken:'status-only-test-tls-token',domainRecheckIntervalMs:false,resolveTxt,resolveCname:async()=>['edge.example.test'],resolve4:async()=>[],resolve6:async()=>[]}};}
test('native customer domain TXT, routing, canonical host and reciprocal application collision checks',async t=>{
 const dns=new Map(),f=await setup(t,false,dnsOptions(async name=>dns.get(name)??[])),created=await f.create(),page=await f.commit(await f.review(created));
 const begin={hostname:'status.customer.test',expectedVersion:page.version,operationId:'status_domain_begin_01'},domain=(await f.call(f.path+'/domains/begin',begin,201)).domain;assert.equal(domain.ownership,'pending');
 assert.deepEqual((await f.call(f.path+'/domains/begin',begin,201)).domain,domain);
 await f.call(`/api/projects/${f.staging.id}/domains`,{hostname:domain.hostname},409);
 const version=(await f.call(f.path)).page.version;await f.call(f.path+'/domains/'+domain.id+'/verify',{expectedVersion:version,operationId:'status_domain_missing_txt_01'},422);
 dns.set(domain.recordName,[[domain.recordValue]]);const verify={expectedVersion:version,operationId:'status_domain_verify_01'},verified=(await f.call(f.path+'/domains/'+domain.id+'/verify',verify)).domain;assert.equal(verified.ownership,'verified');assert.equal(verified.routing,'ready');
 assert.deepEqual((await f.call(f.path+'/domains/'+domain.id+'/verify',verify)).domain,verified);
 const publicResponse=await f.handle(new Request('https://'+domain.hostname+'/'));assert.equal(publicResponse.status,200);assert.match(await publicResponse.text(),/Customer health/);
 assert.equal((await f.handle(new Request('https://'+domain.hostname+'/api/projects'))).status,404);
 const spoofed=await f.handle(new Request(f.options.publicUrl+'/api/status/customer-health',{headers:{'x-forwarded-host':'other.customer.test'}}));assert.equal(spoofed.status,200);
 assert.equal((await f.handle(new Request('https://unknown.customer.test/api/status/customer-health'))).status,404);
 const tls=()=>f.handle(new Request('http://127.0.0.1/_clank/tls/ask?token=status-only-test-tls-token&domain='+domain.hostname));assert.equal((await tls()).status,200);
 const latest=(await f.call(f.path)).page;await f.call(f.path+'/unpublish',{expectedVersion:latest.version,operationId:'status_domain_unpublish_01'});assert.equal((await tls()).status,403);assert.equal((await f.handle(new Request('https://'+domain.hostname+'/'))).status,404);
 const app=(await f.call(`/api/projects/${f.staging.id}/domains`,{hostname:'existing.application.test'},201)).domain;
 await f.call(f.path+'/domains/begin',{hostname:app.hostname,expectedVersion:(await f.call(f.path)).page.version,operationId:'status_app_collision_01'},409);
});
for(const mutation of ['membership','version','application-collision'])test(`native domain DNS held after capture rejects ${mutation} before acknowledgment`,async t=>{
 let reached,release;const entered=new Promise(resolve=>reached=resolve),barrier=new Promise(resolve=>release=resolve);let proof;
 const f=await setup(t,false,dnsOptions(async()=>{reached();await barrier;return [[proof]];})),created=await f.create(),page=await f.commit(await f.review(created));
 const domain=(await f.call(f.path+'/domains/begin',{hostname:'held.customer.test',expectedVersion:page.version,operationId:'status_held_domain_begin_01'},201)).domain;proof=domain.recordValue;
 const version=(await f.call(f.path)).page.version;
 const pending=f.handle(new Request(f.options.publicUrl+f.path+'/domains/'+domain.id+'/verify',{method:'POST',headers:{origin:f.options.publicUrl,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify({expectedVersion:version,operationId:'status_held_domain_verify_01'})}));await entered;
 if(mutation==='membership')f.db.prepare("UPDATE clank_platform_memberships SET role='viewer' WHERE organization_id=? AND user_id=?").run(f.development.organizationId,f.owner.user.id);
 if(mutation==='version')await f.call(f.path+'/configure',{configuration:f.configuration,expectedVersion:version,operationId:'status_held_domain_change_01'});
 if(mutation==='application-collision')f.db.prepare("INSERT INTO clank_platform_domains(id,project_id,hostname,record_name,record_value,status,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)").run('dom_owned_collision_01',f.staging.id,domain.hostname,'_clank.'+domain.hostname,'owned-collision',Date.now()+60000,Date.now());
 release();const response=await pending;assert.equal(response.status,mutation==='membership'?403:409,await response.text());assert.equal(f.db.prepare('SELECT routing FROM clank_platform_status_domains WHERE id=?').get(domain.id).routing,'pending');assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_receipts WHERE operation_id=?').get('status_held_domain_verify_01').n,0);
});
test('native HTML forms carry current CSRF and exact versions through draft, preview, publish and unsubscribe',async t=>{
 const f=await setup(t),location='/projects/'+f.development.id+'/status';
 const post=async fields=>f.handle(new Request(f.options.publicUrl+location,{method:'POST',headers:{origin:f.options.publicUrl,cookie:f.owner.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()}));
 let response=await f.handle(new Request(f.options.publicUrl+location,{headers:{cookie:f.owner.cookie}}));assert.equal(response.status,200);assert.match(await response.text(),/Create private draft/);
 response=await post({action:'create',csrf:f.owner.csrf,operationId:'status_form_create_01',configuration:JSON.stringify(f.configuration)});assert.equal(response.status,303);
 response=await post({action:'preview',csrf:f.owner.csrf,expectedVersion:'1',publication:JSON.stringify({kind:'page'})});assert.equal(response.status,200);const html=await response.text();assert.match(html,/Review exactly what customers will see/);
 const hidden=name=>html.match(new RegExp('name="'+name+'" value="([^"]+)"'))?.[1];
 response=await post({action:'publish',csrf:f.owner.csrf,expectedVersion:'1',previewId:hidden('previewId'),previewDigest:hidden('previewDigest'),operationId:'status_form_publish_01'});assert.equal(response.status,303);
 assert.equal((await f.publicPage()).components[0].health,'operational');
 response=await post({action:'unpublish',csrf:'incorrect',expectedVersion:'2',operationId:'status_form_csrf_01'});assert.equal(response.status,403);assert.equal((await f.call(f.path)).page.published,true);
 const subscriber=await f.account('status-form-subscriber@example.test'),subscriberPath='/status/customer-health/preferences';
 const preference=await f.handle(new Request(f.options.publicUrl+subscriberPath,{method:'POST',headers:{origin:f.options.publicUrl,cookie:subscriber.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({action:'preferences',csrf:subscriber.csrf,operationId:'status_form_subscriber_01',expectedVersion:'0',subscribed:'yes'}).toString()}));assert.equal(preference.status,303);
 assert.equal((await f.call('/api/status/customer-health/preferences',undefined,200,'GET',subscriber)).preferences.subscribed,true);
});
test('native SLO health exposes insufficient-data as unknown and selected policy versions fence an approved review',async t=>{
 const f=await setup(t),policy=(await f.call(`/api/projects/${f.development.id}/slo-policies`,{configuration:{name:'Customer checkout',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true},operationId:'status_native_slo_01'},201)).policy;
 const configuration={...f.configuration,components:[{key:'checkout',label:'Checkout',source:{kind:'slo',policyId:policy.id,expectedVersion:1}}]},created=(await f.call(f.path+'/create',{configuration,operationId:'status_slo_create_01'},201)).page,preview=await f.review(created);assert.equal(preview.page.components[0].health,'unknown');assert.equal(preview.page.components[0].complete,false);
 const page=await f.commit(preview),before=f.db.prepare('SELECT * FROM clank_platform_slo_alerts').all();await f.publicPage();assert.deepEqual(f.db.prepare('SELECT * FROM clank_platform_slo_alerts').all(),before);
 const next=await f.review(page);await f.call(`/api/projects/${f.development.id}/slo-policies/${policy.id}/change`,{configuration:{name:policy.name,objective:policy.objective,targetBasisPoints:policy.targetBasisPoints,windowMinutes:policy.windowMinutes,minimumRequests:policy.minimumRequests,burnThreshold:policy.burnThreshold,enabled:false},expectedVersion:1,operationId:'status_native_slo_change_01'});await f.commit(next,'status_slo_stale_source_01',409);
});
test('actual HTTP response loss after native commit and SIGKILL replays one update and one notification',async t=>{
 const f=await setup(t,true),created=await f.create(),page=await f.commit(await f.review(created)),subscriber=await f.account('status-lost-ack@example.test');await f.call('/api/status/customer-health/preferences',{subscribed:true,components:[],expectedVersion:0,operationId:'status_lost_ack_subscriber_01'},200,'POST',subscriber);
 const preview=await f.review(page,{kind:'update',copy,incident:null});let entered,release;const committed=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 await f.serve(async(request,response)=>{if(new URL(request.url).pathname===f.path+'/publish'&&response.status===200){entered();await barrier;}return response;});
 const input={expectedVersion:preview.expectedVersion,previewId:preview.id,previewDigest:preview.digest,operationId:'status_lost_http_ack_01'},controller=new AbortController();
 const request=fetch(f.options.publicUrl+f.path+'/publish',{method:'POST',headers:{origin:f.options.publicUrl,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify(input),signal:controller.signal});request.catch(()=>{});await committed;
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n,1);await f.killAndRestart();controller.abort();release();await assert.rejects(request,error=>error.name==='AbortError');
 const replay=(await f.call(f.path+'/publish',input)).page;assert.equal(replay.version,3);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n,1);assert.equal((await f.publicPage()).components[0].health,'unknown');
});
test('native expired pending domain renewals retire the prior token without accepting a stale challenge',async t=>{
 const f=await setup(t,false,dnsOptions(async()=>[])),created=await f.create(),first=(await f.call(f.path+'/domains/begin',{hostname:'renew.customer.test',expectedVersion:created.version,operationId:'status_domain_first_01'},201)).domain;
 const row=f.db.prepare('SELECT challenge FROM clank_platform_status_domains WHERE id=?').get(first.id),expired={...JSON.parse(row.challenge),expiresAt:Date.now()-1};f.db.prepare('UPDATE clank_platform_status_domains SET challenge=? WHERE id=?').run(JSON.stringify(expired),first.id);
 const version=(await f.call(f.path)).page.version,next=(await f.call(f.path+'/domains/begin',{hostname:first.hostname,expectedVersion:version,operationId:'status_domain_renew_02'},201)).domain;assert.notEqual(next.id,first.id);assert.notEqual(next.recordValue,first.recordValue);assert.equal(f.db.prepare('SELECT count(*) AS n FROM clank_platform_status_domains').get().n,1);
 await f.call(f.path+'/domains/'+first.id+'/verify',{expectedVersion:version+1,operationId:'status_domain_stale_01'},404);
});
