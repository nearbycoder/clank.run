// A real TCP close at an idle-client reuse boundary; no synthetic errors/retry.
import assert from 'node:assert/strict';
import {createServer,globalAgent} from 'node:http';
import {nativeRequest,isNativePlatformTransportClosure} from './platform-shadow-native.mjs';
const mode=process.argv[2]??'before';let connections=0,requests=0,peer;
const server=createServer((request,response)=>{requests++;response.setHeader('content-type','application/json');response.end(JSON.stringify({request:requests}));});
server.on('connection',socket=>{connections++;peer??=socket;});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
try{
 const first=await nativeRequest(url,new Request(url+'/history'));assert.deepEqual(await first.json(),{request:1});
 // Retire the actual server endpoint before the client observes its close. A
 // pooled client can assign its apparently idle socket to the next request.
 peer.destroy();let failure,result;
 try{result=await nativeRequest(url,new Request(url+'/history'));}catch(error){failure=error;}
 if(mode==='before'){
  assert.ok(isNativePlatformTransportClosure(failure),String(failure));assert.equal(failure.nativeCode,'ECONNRESET');assert.equal(requests,1);assert.equal(connections,1);
 }else{
  assert.equal(failure,undefined,String(failure));assert.deepEqual(await result.json(),{request:2});assert.equal(connections,2);
 }
 console.log(JSON.stringify({mode,version:process.version,keepAliveDefault:globalAgent.keepAlive,connections,requests,nativeCode:failure?.nativeCode,passed:true,qualification:'Real native fixture transport reuse reproduction; it does not identify the unknown hosted reset cause or prove application/readiness authority.'}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
