// A fresh native provider receives only ordinary factory options and a bridge secret.
import assert from 'node:assert/strict';
import {openDockerDeploymentProviderService} from '../../dist/provider-service.js';
import {createDeploymentProviderHandler} from '../../dist/provider.js';
import {serve} from '../../dist/node.js';
import {linuxProcessBirth} from '../../dist/platform-supervisor.js';
let provider,bridgeServer,ingressServer,closing,tail=Promise.resolve();
const close=()=>closing??=(async()=>{try{await bridgeServer?.close();await ingressServer?.close();}finally{await provider?.close();}})();
process.on('message',message=>{tail=tail.then(async()=>{
 const {id,kind}=message;try{
  if(kind==='open'){
   assert.equal(provider,undefined);assert.ok(Number.isSafeInteger(message.maximumBody)&&message.maximumBody>=1024&&message.maximumBody<=768*1024*1024);provider=await openDockerDeploymentProviderService(message.options);
   const bridge=createDeploymentProviderHandler(provider,{token:message.token,maxRuntimeBytes:message.maximumBody,onError:error=>console.error(JSON.stringify({observation:'provider-error',message:error.message,stack:error.stack}))});
   bridgeServer=await serve(async request=>{const response=await bridge.handle(request);if(response.status!==204)console.error(JSON.stringify({observation:'provider-http-refusal',status:response.status,body:await response.clone().text()}));return response;},{hostname:'127.0.0.1',port:47461,maxBodySize:message.maximumBody,allowedHosts:['127.0.0.1:47461']});
   ingressServer=await serve(request=>provider.handle(request),{hostname:'127.0.0.1',port:47431,allowedHosts:['127.0.0.1:47431']});
   process.send({id,result:{pid:process.pid,birth:await linuxProcessBirth(process.pid)}});return;
  }
  assert.ok(provider);assert.equal(closing,undefined);
  if(kind==='close'){await close();process.send({id,result:true},()=>process.disconnect());return;}
  throw Error('Unknown native provider test operation.');
 }catch(error){process.send?.({id,error:{message:error.message,stack:error.stack}});}
 }).catch(error=>{console.error(error.stack);process.exitCode=1;});});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void tail.then(close).then(()=>process.disconnect?.()).catch(error=>{console.error(error.stack);process.exitCode=1;});});
