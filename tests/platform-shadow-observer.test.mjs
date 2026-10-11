import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {setImmediate as immediate} from 'node:timers/promises';
import {openSupervisorLease} from '../dist/platform-supervisor.js';
import {createShadowCandidateRequest} from '../dist/managed-shadow.js';

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
const settings={timeout:10000};
test('production candidate request tracks actual native response cancellation after post-header lease loss',settings,async t=>{
 const root=await mkdtemp(join(tmpdir(),'clank-shadow-cancel-')),path=join(root,'control.sqlite');
 const lease=await openSupervisorLease(path,{configurationId:'shadow-cancel',configurationRevision:1,leaseMs:30000,pollIntervalMs:50});assert.equal(lease.acquire(),true);const sql=new DatabaseSync(path);
 const entered=gate(),release=gate(),requests=[];const server=createServer((req,res)=>{requests.push({method:req.method,path:req.url});res.setHeader('content-type','application/json');res.write('native-response-prefix')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const nativeFetch=globalThis.fetch;let settled=false,cancelCompleted=false,pending;
 t.after(async()=>{release.resolve();await pending;globalThis.fetch=nativeFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));sql.close();lease.close();await rm(root,{recursive:true,force:true})});
 // Instrument only cancellation of the genuine Response obtained from native
 // localhost HTTP; preserve the native body and cancellation implementation.
 globalThis.fetch=async(...args)=>{const response=await nativeFetch(...args);assert.ok(response.body);const cancel=response.body.cancel.bind(response.body);response.body.cancel=async(...values)=>{entered.resolve();await release.promise;try{return await cancel(...values)}finally{cancelCompleted=true}};sql.exec('DELETE FROM clank_platform_supervisor_lease');return response};
 const request=createShadowCandidateRequest({origin:'http://127.0.0.1:'+server.address().port,projectId:'candidate_project',path:'/candidate',token:'private-fixture-token',protocol:'clank-runtime/1',generation:1,readPaths:['/catalog'],methods:['GET']});
 const abort=new AbortController();t.after(()=>abort.abort());
 pending=request({method:'GET',path:'/catalog',accept:'application/json'},abort.signal,()=>lease.assertCurrent()).then(()=>({accepted:true}),error=>({error})).finally(()=>{settled=true});
 await entered.promise;await immediate();assert.equal(cancelCompleted,false);assert.equal(settled,false,'A refused post-header request must remain tracked until its native body cancellation settles.');assert.deepEqual(requests,[{method:'GET',path:'/candidate/catalog'}]);
 release.resolve();const result=await pending;assert.ok(result.error);assert.equal(cancelCompleted,true);assert.equal(settled,true);assert.deepEqual(requests,[{method:'GET',path:'/candidate/catalog'}]);
});
