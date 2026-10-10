// Native service ownership/SQLite crash fixture. Runtime and ingress components
// are injected; this does not certify Docker or remote command crash recovery.
import { readFile } from "node:fs/promises";
import { openDeploymentProviderDataStore } from "../../dist/provider-data.js";
import { openDeploymentProviderService } from "../../dist/provider-service.js";
import { decodeDeploymentRuntimeCapsule } from "../../dist/runtime-placement.js";

const [rootDirectory, primaryFile, candidateFile] = process.argv.slice(2);
const data = await openDeploymentProviderDataStore({rootDirectory,maxDatabaseBytes:16*1024*1024});
const records = new Map(), routes = new Map();
const runtimes = {
  async launch({prepared,isolatedReadOnly}) {
    const candidate={projectId:prepared.projectId,releaseId:prepared.releaseId,generation:prepared.generation,
      capsuleSha256:prepared.capsuleSha256,upstream:"http://127.0.0.1:46001",...(isolatedReadOnly?{isolatedReadOnly:true}:{})};
    records.set(candidate.projectId,{...candidate,status:"candidate"});return candidate;
  },
  async activate(candidate) {const active={...candidate,status:"active"};records.set(candidate.projectId,active);return active;},
  inspect() {return [...records.values()];},
  async diagnostics() {return null;},
  async stop(projectId) {return records.delete(projectId);},
  async close() {records.clear();},
};
const ingress = {
  async activate(binding) {routes.set(binding.projectId,{...binding,latest:true});},
  inspect() {return [...routes.values()];},
  async handle() {return new Response("fixture");},
  async deactivate(projectId) {return {removed:routes.delete(projectId),drained:true};},
  forget() {return true;},
  async close() {routes.clear();return true;},
};
const service=await openDeploymentProviderService({rootDirectory,data:{...data,snapshot:async projectId=>{
  const snapshot=await data.snapshot(projectId);
  process.send({phase:"checkpoint-held"});
  await new Promise(()=>{});
  return snapshot;
}},runtimes,ingress,canaries:{readPaths:["/healthz"]},maxDatabaseBytes:16*1024*1024});
const primary=await decodeDeploymentRuntimeCapsule(new Uint8Array(await readFile(primaryFile)),{maxDatabaseBytes:16*1024*1024});
await service.reconcile({operation:{id:"operation_process_primary",projectId:primary.manifest.projectId,fence:1,attempt:1,maxAttempts:1},
  desired:{generation:1,state:"running",releaseId:primary.manifest.releaseId,runtimeProtocol:primary.manifest.protocol},artifact:primary.artifact,runtime:primary,signal:new AbortController().signal});
const runtime=await decodeDeploymentRuntimeCapsule(new Uint8Array(await readFile(candidateFile)),{maxDatabaseBytes:16*1024*1024});
// Keep IPC referenced while preparation is deliberately held for parent SIGKILL.
process.on("message",()=>{});
await service.canaries.prepare({primary:await service.canaries.binding(primary.manifest.projectId),controllerEpoch:1,operationId:"canary_process_01",runtime,signal:new AbortController().signal});
