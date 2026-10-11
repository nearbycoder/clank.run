// Real native HTTP + SQLite service ownership fixture. Runtime/ingress are
// injected; this fixture does not certify Docker or remote orchestration.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { openDeploymentProviderDataStore } from "../../dist/provider-data.js";
import { openDeploymentProviderService } from "../../dist/provider-service.js";
import { decodeDeploymentRuntimeCapsule } from "../../dist/runtime-placement.js";
const [rootDirectory,primaryFile,mode]=process.argv.slice(2);
const data=await openDeploymentProviderDataStore({rootDirectory,maxDatabaseBytes:16*1024*1024});
const records=new Map(),routes=new Map();
const runtimes={
  async launch({prepared,isolatedReadOnly}) {const candidate={projectId:prepared.projectId,releaseId:prepared.releaseId,generation:prepared.generation,capsuleSha256:prepared.capsuleSha256,upstream:"http://127.0.0.1:46001",...(isolatedReadOnly?{isolatedReadOnly:true}:{})};records.set(candidate.projectId,{...candidate,status:"candidate"});return candidate;},
  async activate(candidate) {const active={...candidate,status:"active"};records.set(candidate.projectId,active);return active;},
  inspect(){return [...records.values()];},async diagnostics(){return null;},async stop(projectId){return records.delete(projectId);},async close(){records.clear();},
};
const ingress={async activate(binding){routes.set(binding.projectId,{...binding,latest:true});},inspect(){return [...routes.values()];},async handle(){return new Response("fixture");},async deactivate(projectId){return {removed:routes.delete(projectId),drained:true};},forget(){return true;},async close(){routes.clear();return true;}};
const service=await openDeploymentProviderService({rootDirectory,data,runtimes,ingress,...(mode==="first"?{canaries:{readPaths:["/healthz"]}}:{}),maxDatabaseBytes:16*1024*1024});
if(mode==="first") {
  const runtime=await decodeDeploymentRuntimeCapsule(new Uint8Array(await readFile(primaryFile)),{maxDatabaseBytes:16*1024*1024});
  await service.reconcile({operation:{id:"http_process_primary",projectId:runtime.manifest.projectId,fence:1,attempt:1,maxAttempts:1},desired:{generation:1,state:"running",releaseId:runtime.manifest.releaseId,runtimeProtocol:runtime.manifest.protocol},artifact:runtime.artifact,runtime,signal:new AbortController().signal});
}
const server=createServer(async(incoming,outgoing)=>{
  try {
    const request=new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(["GET","HEAD"].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:"half"})});
    if(request.body&&incoming.url.endsWith("/prepare")){const original=request.body.getReader.bind(request.body);request.body.getReader=(...args)=>{process.send({phase:"body-held"});return original(...args);};}
    const response=await service.handle(request);outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {outgoing.writeHead(500);outgoing.end();}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
process.send({phase:"ready",url:`http://127.0.0.1:${server.address().port}`});
process.on("message",async message=>{if(message==="close"){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await service.close();process.disconnect();}});
