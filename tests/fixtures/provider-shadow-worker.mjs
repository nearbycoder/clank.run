// Native ownership/HTTP/crash fixture. Runtime and ingress are injected doubles.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { decodeDeploymentRuntimeCapsule } from '../../dist/runtime-placement.js';
import { openFixtureService,input } from './provider-shadow-service.mjs';
const [root,primaryFile,mode]=process.argv.slice(2);
try {
 const options={disabled:mode==='recover'||mode==='old',...(mode==='old'?{open:(await import('./provider-service-v1-215f594.mjs')).openDeploymentProviderService}:{})};
 if(mode==='checkpoint')options.beforeApply=async()=>{process.send({phase:'checkpoint-held'});await new Promise(()=>{});};
 const {service}=await openFixtureService(root,options);
 if(mode==='checkpoint'||mode==='body')await service.reconcile(input(await decodeDeploymentRuntimeCapsule(new Uint8Array(await readFile(primaryFile)))));
 const server=createServer(async(req,res)=>{try{
  const request=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers:req.headers,...(req.method==='GET'?{}:{body:Readable.toWeb(req),duplex:'half'})});
  if(mode==='body'&&req.url.endsWith('/prepare')){const original=request.body.getReader.bind(request.body);request.body.getReader=(...args)=>{process.send({phase:'body-held'});return original(...args);};}
  const response=await service.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.send({phase:'ready',url:`http://127.0.0.1:${server.address().port}`});
 process.on('message',async message=>{if(message==='close'){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await service.close();process.disconnect();}});
}catch(error){process.send({phase:'rejected',message:error.message});process.disconnect();}
