// Owned native platform process. IPC requests invoke only its genuine coordinator.
import assert from 'node:assert/strict';
import {reopenNativePlatformHandoff} from './provider-platform-handoff-native.mjs';
import {serve} from '../../dist/node.js';
import {linuxProcessBirth} from '../../dist/platform-supervisor.js';
let fixture,publicServer,controlServer,closing,tail=Promise.resolve();
const close=()=>closing??=(async()=>{try{await publicServer?.close();await controlServer?.close();}finally{await fixture?.close();}})();
process.on('message',message=>{tail=tail.then(async()=>{
 const {id,kind}=message;try{
  if(kind==='open'){
   assert.equal(fixture,undefined);assert.equal(typeof message.directory,'string');assert.match(message.keyHex,/^[a-f0-9]{64}$/);const key=Buffer.from(message.keyHex,'hex');
   try{fixture=await reopenNativePlatformHandoff(message.directory,key,message.identity);}finally{key.fill(0);}
   publicServer=await serve(request=>fixture.runtime.handle(request),{hostname:'127.0.0.1',port:47331,allowedHosts:['native-platform.apps.example.test']});
   controlServer=await serve(request=>fixture.runtime.handle(request),{hostname:'127.0.0.1',port:47451,allowedHosts:['127.0.0.1:47451']});
   process.send({id,result:{pid:process.pid,birth:await linuxProcessBirth(process.pid)}});return;
  }
  assert.ok(fixture);assert.equal(closing,undefined);
  if(kind==='enqueue'){process.send({id,result:await fixture.coordinator.enqueue(message.input)});return;}
  if(kind==='authenticate'){process.send({id,result:Boolean(await fixture.coordinator.authenticateOperation(message.operation))});return;}
  if(kind==='close'){await close();process.send({id,result:true},()=>process.disconnect());return;}
  throw Error('Unknown native controller test operation.');
 }catch(error){process.send?.({id,error:{message:error.message,stack:error.stack}});}
 }).catch(error=>{console.error(error.stack);process.exitCode=1;});});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void tail.then(close).then(()=>{process.disconnect?.();}).catch(error=>{console.error(error.stack);process.exitCode=1;});});
