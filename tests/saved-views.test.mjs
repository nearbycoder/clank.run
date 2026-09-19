import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineAuth} from '../dist/auth.js';
import {openSavedViews,createSavedViewsClient,applySavedView,validateView} from '../dist/saved-views.js';
const definition={filters:[{field:'status',operator:'eq',value:'open'}],sort:[{field:'score',direction:'desc'}],columns:['status','score']};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'clank-views-'));const options={path:join(root,'app.sqlite'),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}}),fields:['status','score'],maxViews:2};let service=await openSavedViews(options);
 return {async user(email){const response=await service.handle(new Request('https://views.test/__clank/views/auth/register',{method:'POST',headers:{'content-type':'application/json',origin:'https://views.test'},body:JSON.stringify({email,password:'correct horse battery staple'})}));assert.equal(response.status,201);const data=await response.json(),cookie=response.headers.get('set-cookie').split(';',1)[0];return createSavedViewsClient({url:'https://views.test/__clank/views',auth:{csrfHeader:()=>({'x-clank-csrf':data.csrfToken})},fetch:(url,init)=>service.handle(new Request(url,{...init,headers:{...init.headers,cookie,origin:'https://views.test'}}))});},async restart(){service.close();service=await openSavedViews(options)},async close(){service.close();await rm(root,{recursive:true,force:true})}};
}
test('views persist, isolate owners, validate columns, fence stale edits, and keep exactly one default',async()=>{
 const app=await fixture();try{
 const alice=await app.user('alice@example.invalid'),bob=await app.user('bob@example.invalid');
 const first=await alice.save({name:'Open',definition});assert.deepEqual(await bob.list(),[]);
 await assert.rejects(bob.save({id:first.id,expectedRevision:first.revision,name:'Stolen',definition}));assert.equal(await bob.remove(first.id,1),false);
 await assert.rejects(alice.save({name:'open',definition}));await assert.rejects(alice.save({name:'Unknown field',definition:{...definition,columns:['secret']}}));
 const second=await alice.save({name:'Other',definition});await assert.rejects(alice.save({name:'Too many',definition}));
 await alice.setDefault(first.id);await alice.setDefault(second.id);let rows=await alice.list();assert.equal(rows.filter(row=>row.isDefault).length,1);assert.equal(rows.find(row=>row.isDefault).id,second.id);
 await assert.rejects(alice.save({id:first.id,expectedRevision:1,name:'Stale',definition}));await assert.rejects(alice.remove(first.id,1));
 await app.restart();rows=await alice.list();assert.equal(rows.length,2);assert.deepEqual(rows[0].definition,definition);
 const current=rows.find(row=>row.id===first.id);const renamed=await alice.save({id:first.id,expectedRevision:current.revision,name:'Renamed',definition});assert.equal(renamed.revision,current.revision+1);
 assert.equal(await alice.remove(first.id,renamed.revision),true);await alice.setDefault(null);assert.equal((await alice.list())[0].isDefault,false);
 }finally{await app.close()}
});
test('view evaluation preserves input, stable ties, missing values, literal own fields, and typed comparisons',()=>{
 const records=[{status:'open',score:2,id:'a'},{status:'closed',score:8},{status:'open',score:2,id:'b'},{status:'open',id:'missing'},{status:'open',score:4,id:'c'}];const original=structuredClone(records);
 assert.deepEqual(applySavedView(records,definition).map(row=>row.id),['c','a','b','missing']);assert.deepEqual(records,original);
 assert.equal(applySavedView([Object.create({status:'open'})],definition).length,0);
 assert.throws(()=>validateView({...definition,filters:[{field:'score',operator:'gt',value:'3'}]}),/number/);
 assert.throws(()=>validateView({...definition,columns:['__proto__']}),/column/);
 assert.throws(()=>validateView({...definition,sort:[{field:'score',direction:'asc'},{field:'score',direction:'desc'}]}),/unique/);
 const detached=validateView(definition);assert.ok(Object.isFrozen(detached.filters));
});
