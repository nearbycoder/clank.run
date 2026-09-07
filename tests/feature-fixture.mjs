import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineAuth} from '../dist/auth.js';
/** Real authenticated SQLite transport for optional feature integration tests. */
export async function featureFixture(open,client,prefix,extra={}) {
 const root=await mkdtemp(join(tmpdir(),'clank-feature-')),options={path:join(root,'app.sqlite'),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}}),...extra};let service=await open(options);
 return {get service(){return service},async user(email){const r=await service.handle(new Request(`https://feature.test/__clank/${prefix}/auth/register`,{method:'POST',headers:{'content-type':'application/json',origin:'https://feature.test'},body:JSON.stringify({email,password:'correct horse battery staple'})}));assert.equal(r.status,201);const data=await r.json(),cookie=r.headers.get('set-cookie').split(';',1)[0];return {id:data.user.id,client:client({url:`https://feature.test/__clank/${prefix}`,auth:{csrfHeader:()=>({'x-clank-csrf':data.csrfToken})},fetch:(url,init)=>service.handle(new Request(url,{...init,headers:{...init.headers,cookie,origin:'https://feature.test'}}))})}},async restart(){service.close();service=await open(options)},async close(){service.close();await rm(root,{recursive:true,force:true})}};
}
