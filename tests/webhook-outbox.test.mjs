import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {defineAuth} from '../dist/auth.js';
import {verifyWebhook} from '../dist/services.js';
import {openWebhookOutbox,createWebhookClient,renderWebhookConsole} from '../dist/webhook-outbox.js';
async function fixture(options={}){
 const root=await mkdtemp(join(tmpdir(),'clank-webhooks-')),path=join(root,'app.sqlite');
 const config={path,auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}}),endpoints:{partner:{url:'https://partner.example.invalid/webhook',secret:()=>({version:'one',value:'a-long-private-signing-secret-12345'})}},...options};
 let outbox=await openWebhookOutbox(config);
 async function register(email){const response=await outbox.handle(new Request('https://outbox.test/__clank/webhooks/auth/register',{method:'POST',headers:{'content-type':'application/json',origin:'https://outbox.test'},body:JSON.stringify({email,password:'correct horse battery staple'})}));assert.equal(response.status,201);const data=await response.json(),cookie=response.headers.get('set-cookie').split(';',1)[0];const client=createWebhookClient({url:'https://outbox.test/__clank/webhooks',auth:{csrfHeader:()=>({'x-clank-csrf':data.csrfToken})},fetch:(url,init)=>outbox.handle(new Request(url,{...init,headers:{...init.headers,cookie,origin:'https://outbox.test'}}))});return{userId:data.user.id,client};}
 return{path,register,get outbox(){return outbox},restart:async()=>{outbox.close();outbox=await openWebhookOutbox(config)},close:async()=>{outbox.close();await rm(root,{recursive:true,force:true})}};
}
const input=userId=>({userId,key:'event-1',endpoint:'partner',event:'ticket.created',payload:{private:'payload'}});
test('outbox persists across restart, verifies signatures, isolates users and deduplicates dispatch',async()=>{
 const sent=[];const app=await fixture({fetch:async(url,request)=>{sent.push(request);assert.equal(url,'https://partner.example.invalid/webhook');assert.equal(request.redirect,'error');assert.equal(await verifyWebhook({body:request.body,secret:'a-long-private-signing-secret-12345',timestamp:request.headers['x-clank-webhook-timestamp'],signature:request.headers['x-clank-webhook-signature']}),true);return new Response('',{status:200})}});
 try{const alice=await app.register('alice@example.invalid'),bob=await app.register('bob@example.invalid');const id=app.outbox.publish(input(alice.userId));assert.equal(app.outbox.publish(input(alice.userId)),id);assert.deepEqual(await bob.client.list(),[]);await app.restart();await app.outbox.workOnce();const [record]=await alice.client.list();assert.equal(record.state,'delivered');assert.equal(sent.length,1);assert.equal(sent[0].headers['x-clank-delivery'],id);assert.deepEqual(await bob.client.inspect(id),[]);assert.equal(await bob.client.replay(id,record.jobId),false);assert.equal(await alice.client.replay(id,record.jobId),false);assert.doesNotMatch(JSON.stringify(record),/private|payload|signing|https:/);}
 finally{await app.close()}
});
test('failed deliveries can be replayed once with current signing key and stable delivery identity',async()=>{
 let version='one',status=400;const keys=[];const app=await fixture({endpoints:{partner:{url:'https://partner.example.invalid/webhook',secret:()=>({version,value:'a-long-private-signing-secret-12345'})}},fetch:async(_url,request)=>{keys.push([request.headers['x-clank-delivery'],request.headers['x-clank-webhook-key-version']]);return new Response('',{status})}});
 try{const alice=await app.register('alice@example.invalid');const id=app.outbox.publish(input(alice.userId));await app.outbox.workOnce();const [failed]=await alice.client.list();assert.equal(failed.state,'failed');version='two';status=200;assert.equal(await alice.client.replay(id,failed.jobId),true);assert.equal(await alice.client.replay(id,failed.jobId),false);await app.restart();await app.outbox.workOnce();assert.equal((await alice.client.list())[0].state,'delivered');assert.deepEqual(keys,[[id,'one'],[id,'two']]);const history=await alice.client.inspect(id);assert.equal(history.length,2);assert.deepEqual(history.map(item=>item.status),[200,400]);assert.deepEqual(history.map(item=>item.secretVersion),['two','one']);}
 finally{await app.close()}
});
test('transient retries survive restart and pending work cannot be evicted or replayed',async()=>{
 let status=503;const app=await fixture({maxPerUser:1,fetch:async()=>new Response('',{status})});
 try{const alice=await app.register('alice@example.invalid');const id=app.outbox.publish(input(alice.userId));await app.outbox.workOnce();const [retry]=await alice.client.list();assert.equal(retry.state,'retry');assert.equal(await alice.client.replay(id,retry.jobId),false);assert.throws(()=>app.outbox.publish({...input(alice.userId),key:'two'}),/full/);const db=new DatabaseSync(app.path);db.exec("UPDATE clank_jobs SET run_at=0 WHERE state='retry'");db.close();status=200;await app.restart();await app.outbox.workOnce();assert.equal((await alice.client.list())[0].state,'delivered');app.outbox.publish({...input(alice.userId),key:'two'});assert.equal((await alice.client.list()).length,1);assert.throws(()=>app.outbox.publish({...input(alice.userId),endpoint:'unknown'}));}
 finally{await app.close()}
});
test('webhook console escapes event and destination metadata',()=>{
 const html=renderWebhookConsole([{id:'x',endpoint:'<img>',event:'<SCRIPT>',state:'failed',attempts:2,status:400,jobId:'job',secretVersion:'one'}]);assert.doesNotMatch(html,/<script\b|<img\b/iu);assert.match(html,/Retry failed delivery/);
});
