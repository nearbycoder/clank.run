/** Private created-target ownership. A suspension lease never admits an application writer. */
import * as h from "./provider-handoff.ts";
import {runProviderDockerClient,providerDockerTargetConfiguration} from "./provider-docker-client.ts";
import {decodeDeploymentRuntimeCapsule,createDeploymentRuntimeCapsule} from "./runtime-placement.ts";
import {stagePointInTimeTransfer,applyPointInTimeTransfer,type PointInTimeTransferCursor} from "./point-in-time.ts";
import type {DeploymentRuntimeIngressBinding} from "./provider-runtime.ts";
import {SQLITE_INTERNAL} from "./sqlite-internal.ts";

const used=new WeakSet<h.ProviderTargetWorkspace>();
type StartedTarget={pid:number;birth:string;startedAt:string;healthyAt:number};
type TargetRunGuard={check():void;remaining():number};
const leases=new WeakMap<ProviderStoppedTarget,{ingress:DeploymentRuntimeIngressBinding;check():void;verify():Promise<void>;start(guard:TargetRunGuard,verifySource:()=>Promise<void>):Promise<StartedTarget>;verifyActive(original:StartedTarget,guard:TargetRunGuard):Promise<void>;verifyRemoved():Promise<void>;adopt(owner:h.ProviderServiceOwnership):NativeAdoptedTarget;configurationSha256():string;processes():readonly {pid:number;birth:string;cgroup:string}[]}>();
const CAPSULE_MAX=614*1024*1024;
type Held={fd:number;path:string;dev:number;ino:number;size:number;mode:number;uid:number;directory:boolean;sha256?:string;mtimeNs?:bigint;ctimeNs?:bigint};
export interface ProviderStoppedTarget {
 readonly targetId:string;readonly projectId:string;readonly nodeId:string;
 readonly releaseId:string;readonly generation:number;readonly capsuleSha256:string;
 readonly containerId:string;readonly databasePath:string;
 assertCurrent():void;verifySuspended():Promise<void>;close():Promise<void>;
}
export function assertProviderStoppedTarget(value:ProviderStoppedTarget):void{
 const held=leases.get(value);if(!held)throw new Error("A genuine original stopped target is required.");held.check();
}
function refuse(message:string):never{throw new Error(message);}
function captureCapsule(value:Uint8Array):Uint8Array{
 const typed=Object.getPrototypeOf(Uint8Array.prototype),get=(name:string)=>Object.getOwnPropertyDescriptor(typed,name)!.get!;
 try{if(!(value instanceof Uint8Array)||!ArrayBuffer.isView(value)||get("byteLength").call(value)>CAPSULE_MAX)refuse("Invalid target capsule.");Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!.call(get("buffer").call(value));return new Uint8Array(value);}catch{refuse("Target capsule requires bounded non-shared native bytes.");}
}

/** Install an approved capsule and create its real web container without starting it. */
export async function createStoppedProviderTarget(workspace:h.ProviderTargetWorkspace,capsuleBytes:Uint8Array,imageId:string,port:number):Promise<ProviderStoppedTarget>{
 const context=h.providerTargetWorkspaceContext(workspace);context.check();
 if(used.has(workspace))refuse("Original target creation cannot be duplicated or recycled.");
 if(typeof imageId!=="string"||!/^sha256:[a-f0-9]{64}$/u.test(imageId)||!Number.isSafeInteger(port)||port<1024||port>65535)refuse("Target creation requires an immutable image and bounded port.");
 const captured=captureCapsule(capsuleBytes);used.add(workspace);
 const fs=context.fs,process=(globalThis as any).process,pins:Held[]=[],releaseInventory=new Map<Held,ReadonlyMap<string,Held>>();
 let detached=false,ownershipGuard=context.check,retainedCapsule:Uint8Array|undefined,startedIdentity:StartedTarget|undefined;
 let sealedRelease=false;let closed=false,createdUnacknowledged=false,startIssued=false,cid:string|undefined,labels:Record<string,string>|undefined,signature:string|undefined;
 let expectedEnvironment:Map<string,string>|undefined,imageConfiguration:any;
 let envFile:Held|undefined,unregister:(()=>void)|undefined,closing:Promise<void>|undefined,decoded:any,constructing=true;
 const nativeProcesses=new Map<string,{pid:number;birth:string;cgroup:string}>();
 const operation=(outer?:TargetRunGuard)=>{
  const duration=outer?Math.min(context.operationTimeoutMs,outer.remaining()):context.operationTimeoutMs;
  const deadline:bigint=process.hrtime.bigint()+BigInt(duration)*1000000n,signal=AbortSignal.timeout(duration);
  const current=()=>{outer?.check();if(process.hrtime.bigint()>=deadline)refuse("Original target operation deadline exceeded.");};
  const command=(args:string[])=>{current();const remaining=Number((deadline-(process.hrtime.bigint() as bigint))/1000000n);return runProviderDockerClient(context.client,args,{timeoutMs:Math.max(1,Math.min(15000,remaining)),maxOutputBytes:4194304,signal});};
  return Object.assign(command,{current});
 };
 const command=operation();
 const closePins=()=>{const errors:unknown[]=[];for(const p of pins.splice(0).reverse())try{fs.closeSync(p.fd);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"Original target file pins failed to close.");};
 const invalidate=()=>{closed=true;};
 const checkNative=()=>{
  if(closed)refuse("Original stopped target is closed or fenced.");
  try{if(constructing)command.current();ownershipGuard();for(const pin of pins){const a=fs.fstatSync(pin.fd,{bigint:true}),b=fs.lstatSync(pin.path,{bigint:true}),dev=BigInt(pin.dev),ino=BigInt(pin.ino),uid=BigInt(pin.uid),mode=BigInt(pin.mode);
   if((pin.directory?!a.isDirectory()||!b.isDirectory():!a.isFile()||!b.isFile()||a.nlink!==1n||b.nlink!==1n)||a.dev!==dev||a.ino!==ino||b.dev!==dev||b.ino!==ino||a.uid!==uid||b.uid!==uid||(a.mode&0o777n)!==mode||(b.mode&0o777n)!==mode||!pin.directory&&(a.size!==BigInt(pin.size)||b.size!==BigInt(pin.size)))refuse("Original stopped target release identity changed.");
   if(pin.sha256&&(a.mtimeNs!==pin.mtimeNs||a.ctimeNs!==pin.ctimeNs||b.mtimeNs!==pin.mtimeNs||b.ctimeNs!==pin.ctimeNs))refuse("Original target release bytes or metadata changed.");
  }
   if(sealedRelease)for(const [directory,expected] of releaseInventory){
    const names=fs.readdirSync(`/proc/self/fd/${directory.fd}`,{withFileTypes:true});if(names.length!==expected.size||names.some((entry:any)=>entry.isSymbolicLink()||!expected.has(entry.name)))refuse("Original target release inventory changed.");
   }
  }catch(error){invalidate();throw error;}
 };
 const check=()=>{if(detached)refuse("Original stopped target ownership was transferred.");checkNative();};
 let crypto:typeof import("node:crypto")|undefined;
 const verifyReleaseBytes=async(guard=check)=>{
  guard();const chunk=Buffer.allocUnsafe(1048576);try{let sinceYield=0,filesSinceYield=0;for(const pin of pins){if(!pin.sha256)continue;const hash=crypto!.createHash("sha256");let position=0;
   while(position<pin.size){const n=fs.readSync(pin.fd,chunk,0,Math.min(chunk.length,pin.size-position),position);if(!n)refuse("Original target release ended early.");hash.update(chunk.subarray(0,n));position+=n;sinceYield+=n;if(sinceYield>=4194304){guard();await new Promise<void>(resolve=>setTimeout(resolve,0));guard();sinceYield=0;}}
   if(hash.digest("hex")!==pin.sha256)refuse("Original target release bytes changed.");
   if(++filesSinceYield>=16){guard();await new Promise<void>(resolve=>setTimeout(resolve,0));guard();filesSinceYield=0;}
  }guard();}finally{chunk.fill(0);}
 };
 const normalize=(row:any)=>{
  if(!row||row.Id!==cid||row.Image!==imageId||!row.Config?.Labels||Object.keys(row.Config.Labels).length!==Object.keys(labels!).length||Object.entries(labels!).some(([k,v])=>row.Config.Labels[k]!==v))refuse("Original target container identity changed.");
  const host=row.HostConfig,configuration=row.Config;
  if(configuration.Image!==imageId||configuration.User!==process.getuid()+":"+process.getgid()||configuration.WorkingDir!=="/app"||JSON.stringify(configuration.Cmd)!==JSON.stringify(["node",decoded.artifact.bundle.config.entry])||JSON.stringify(configuration.Entrypoint)!==JSON.stringify(imageConfiguration.Entrypoint)||configuration.Tty!==false||configuration.OpenStdin!==true
    ||!expectedEnvironment||configuration.Env.length!==expectedEnvironment.size||configuration.Env.some((value:string)=>{const at=value.indexOf("=");return expectedEnvironment!.get(value.slice(0,at))!==value.slice(at+1);})
    ||host.Privileged!==false||host.ReadonlyRootfs!==true||host.Init!==true||host.Memory!==536870912||host.MemorySwap!==536870912||host.NanoCpus!==1000000000||host.PidsLimit!==128||JSON.stringify(host.CapDrop)!==JSON.stringify(["ALL"])||host.CapAdd!==null||JSON.stringify(host.SecurityOpt)!==JSON.stringify(["no-new-privileges=true"])||host.NetworkMode!=="bridge"||host.RestartPolicy?.Name!=="no"||host.RestartPolicy.MaximumRetryCount!==0
    ||JSON.stringify(host.Tmpfs)!==JSON.stringify({"/run":"rw,noexec,nosuid,nodev,size=8m,mode=755","/tmp":"rw,noexec,nosuid,nodev,size=64m,mode=1777"})||JSON.stringify(host.PortBindings)!==JSON.stringify({[port+"/tcp"]:[{HostIp:"127.0.0.1",HostPort:String(port)}]})
    ||host.Binds!==null||host.VolumesFrom!==null||host.Devices?.length||host.DeviceRequests!==null||host.ExtraHosts!==null||host.PidMode!==""||host.IpcMode!=="private"||host.UsernsMode!==""||host.CgroupnsMode!=="private"||(host.OomKillDisable!==false&&host.OomKillDisable!==null))refuse("Original target security or runtime configuration differs.");
  const mounts=row.Mounts;
  if(mounts.length!==2||!mounts.some((m:any)=>m.Type==="bind"&&m.Source===workspace.releaseDirectory&&m.Destination==="/app"&&m.RW===false)||!mounts.some((m:any)=>m.Type==="bind"&&m.Source===workspace.dataDirectory&&m.Destination==="/data"&&m.RW===true))refuse("Original target native mounts differ.");
  // Docker assigns the default profile when it starts a created container. That
  // transition fences suspension, but must retain removal authority for this CID.
  const neverStarted=row.State?.Status==="created"&&row.State?.StartedAt==="0001-01-01T00:00:00Z";
  if(row.AppArmorProfile!=="docker-default"&&!(neverStarted&&row.AppArmorProfile===""))refuse("Original target AppArmor profile differs.");
  // The daemon also converts the enabled OOM killer from false to its default
  // null representation at start. Both mean enabled; true is always refused.
  return providerDockerTargetConfiguration(row);
 };
 const verifyDaemon=async(run=command)=>{const actual=JSON.parse((await run(["info","--format","{{json .ID}}"])).stdout);if(actual!==context.domain.daemonId)refuse("Original target Docker daemon changed.");};
 const inspect=async(run=command)=>JSON.parse((await run(["container","inspect",cid!])).stdout)[0];
 const inventory=async(expected?:string,run=command)=>{
  const rows=(await run(["container","ls","--all","--no-trunc","--filter","label=run.clank.managed=provider-runtime","--filter","label=run.clank.owner="+context.domain.owner,"--filter","label=run.clank.project="+workspace.projectId,"--format","{{.ID}}"])).stdout.trim();
  if(rows!==(expected??""))refuse("Original target namespace has an additional or missing runtime role.");
 };
 const competingMounts=async(run=command,guard=check)=>{
  const text=(await run(["container","ls","--all","--no-trunc","--format","{{.ID}}"])).stdout.trim(),ids=text?text.split("\n"):[];
  if(ids.length>1000||ids.some(id=>!/^[a-f0-9]{64}$/u.test(id)))refuse("Target Docker inventory exceeds its bounded observation.");
  for(const id of ids){if(id===cid)continue;run.current();guard();const row=JSON.parse((await run(["container","inspect","--format","[{{json .Id}},{{json .Mounts}}]",id])).stdout);guard();
   if(!Array.isArray(row)||row[0]!==id||!Array.isArray(row[1]))refuse("Target competing runtime observation differs.");
   for(const mount of row[1])if(mount.RW&&typeof mount.Source==="string"&&[workspace.dataDirectory,workspace.releaseDirectory].some(path=>mount.Source===path||mount.Source.startsWith(path+"/")||path.startsWith(mount.Source+"/")))refuse("Target data or release has a competing writable container mount.");
  }
 };
 const verify=async()=>{
  if(startIssued)refuse("Original target suspension was consumed by activation.");
  const run=constructing?command:operation();
  try{run.current();check();await verifyReleaseBytes();run.current();check();await workspace.verifyCurrent();run.current();check();await verifyDaemon(run);check();await inventory(cid,run);check();await competingMounts(run);check();const row=await inspect(run);check();
   if(normalize(row)!==signature||row.State?.Status!=="created"||row.State?.Running!==false||row.State?.Pid!==0||row.State?.Paused||row.State?.Restarting||row.State?.Dead||row.RestartCount!==0||row.State?.StartedAt!=="0001-01-01T00:00:00Z")refuse("Original target is no longer its never-started suspended container.");
   await verifyDaemon(run);check();await verifyReleaseBytes();check();run.current();
  }catch(error){invalidate();throw error;}
 };
 const procText=(path:string,maximum=65536)=>{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const data=Buffer.alloc(maximum+1);let n=0;while(n<data.length){const count=fs.readSync(fd,data,n,data.length-n,n);if(!count)break;n+=count;}if(n>maximum)refuse("Target native process observation exceeds its bound.");return data.subarray(0,n).toString();}finally{fs.closeSync(fd);}};
 const processBirth=(pid:number)=>{if(!Number.isSafeInteger(pid)||pid<1)refuse("Target native process is absent.");const text=procText("/proc/"+pid+"/stat",4096),birth=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u)[19];if(!birth||!/^[1-9][0-9]{0,19}$/u.test(birth))refuse("Target native process birth differs.");return birth;};
 const retainProcess=(pid:number)=>{const birth=processBirth(pid),rows=procText("/proc/"+pid+"/cgroup",4096).trim().split("\n");if(rows.length!==1||!rows[0].startsWith("0::/")||rows[0].includes("/../"))refuse("Original target cgroup cannot be retained.");const cgroup="/sys/fs/cgroup"+rows[0].slice(3),key=pid+":"+birth,previous=nativeProcesses.get(key);if(previous&&previous.cgroup!==cgroup)refuse("Original target cgroup changed.");nativeProcesses.set(key,{pid,birth,cgroup});return birth;};
 const processesAbsent=()=>{for(const original of nativeProcesses.values()){
  try{if(processBirth(original.pid)===original.birth)return false;}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}
  try{if(procText(original.cgroup+"/cgroup.procs",4096).trim())return false;}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}
 }return true;};
 const running=(row:any,original?:StartedTarget)=>{
  if(normalize(row)!==signature||row.State?.Status!=="running"||row.State.Running!==true||row.State.Paused||row.State.Restarting||row.State.Dead||row.RestartCount!==0||row.State.StartedAt==="0001-01-01T00:00:00Z")refuse("Original activated target is not its single running incarnation.");
  const pid=row.State.Pid,birth=retainProcess(pid);if(original&&(pid!==original.pid||birth!==original.birth||row.State.StartedAt!==original.startedAt))refuse("Original activated target process was replaced or restarted.");
  const status=procText("/proc/"+pid+"/status"),field=(name:string)=>status.split("\n").find((line:string)=>line.startsWith(name+":"))?.split(":")[1]?.trim();
  if(field("NoNewPrivs")!=="1"||field("Seccomp")!=="2"||["CapEff","CapPrm","CapBnd"].some(name=>!/^0+$/u.test(field(name)??""))||["Uid","Gid"].some(name=>{const values=field(name)?.split(/\s+/u);return values?.length!==4||values.some((id:string)=>id!==String(name==="Uid"?process.getuid():process.getgid()));})||procText("/proc/"+pid+"/attr/current",4096).trim()!=="docker-default (enforce)")refuse("Original activated target kernel security profile differs.");
  return {pid,birth,startedAt:row.State.StartedAt,healthyAt:0};
 };
 const health=async(guard:TargetRunGuard)=>{
  guard.check();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(decoded.artifact.bundle.config.health.timeoutMs,guard.remaining()));
  try{const response=await fetch("http://127.0.0.1:"+port+decoded.artifact.bundle.config.health.path,{signal:controller.signal,redirect:"error"});guard.check();let bytes=0;const reader=response.body?.getReader();try{if(reader)for(;;){const part=await reader.read();guard.check();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)refuse("Target health response exceeds its bound.");}}finally{await reader?.cancel();}if(!response.ok)refuse("Original activated target failed its approved health check.");guard.check();}finally{clearTimeout(timer);}
 };
 const verifyActive=async(original:StartedTarget,guard:TargetRunGuard)=>{
  const run=operation(guard);try{guard.check();check();await verifyReleaseBytes();guard.check();await workspace.verifyCurrent();guard.check();await verifyDaemon(run);guard.check();await inventory(cid,run);guard.check();await competingMounts(run);guard.check();running(await inspect(run),original);guard.check();await health(guard);running(await inspect(run),original);guard.check();await verifyDaemon(run);guard.check();check();}catch(error){invalidate();throw error;}
 };
 const start=async(guard:TargetRunGuard,verifySource:()=>Promise<void>):Promise<StartedTarget>=>{
  guard.check();await verify();guard.check();await verifySource();guard.check();if(startIssued)refuse("Original target activation cannot be duplicated or recycled.");startIssued=true;
  const run=operation(guard);await run(["container","start",cid!]);guard.check();check();let original:StartedTarget|undefined;
  // The approved process may need a short bounded interval to bind its socket.
  for(;;){guard.check();const row=await inspect(run);guard.check();original=running(row,original);try{await health(guard);break;}catch(error){guard.check();if(guard.remaining()<100)throw error;await new Promise<void>(resolve=>setTimeout(resolve,50));}}
  original.healthyAt=Date.now();await verifyActive(original,guard);startedIdentity=Object.freeze(original);return startedIdentity;
 };
 const closeNative=():Promise<void>=>closing??=(async()=>{
  invalidate();const errors:unknown[]=[];const run=operation();
  if(createdUnacknowledged)errors.push(new Error("Target creation is unacknowledged; no container removal authority is available."));
  if(cid)try{await verifyDaemon(run);const visible=(await run(["container","ls","--all","--no-trunc","--filter","id="+cid,"--format","{{.ID}}"]).then(r=>r.stdout.trim()));if(visible!==""&&visible!==cid)refuse("Original target cleanup identity differs.");if(visible){const row=await inspect(run);const actual=normalize(row);if(signature!==undefined&&actual!==signature)refuse("Target cleanup cannot adopt a changed or replacement container.");if(Number.isSafeInteger(row.State?.Pid)&&row.State.Pid>0)try{retainProcess(row.State.Pid);}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}
   // The independent publication watchdog may remove this exact CID after our
   // inspect. A failed removal is settled only by fresh native absence below.
   try{await run(["container","rm","--force",cid]);}catch(error){if((await run(["container","ls","--all","--no-trunc","--filter","id="+cid,"--format","{{.ID}}"])).stdout.trim())throw error;}
  }await verifyDaemon(run);const remaining=(await run(["container","ls","--all","--no-trunc","--filter","id="+cid,"--format","{{.ID}}"])).stdout.trim();run.current();if(remaining)refuse("Original target removal is unsettled.");while(!processesAbsent()){run.current();await new Promise<void>(resolve=>setTimeout(resolve,25));}run.current();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,"Original stopped target cleanup is uncertain.");
  unregister?.();closePins();retainedCapsule?.fill(0);captured.fill(0);decoded?.bytes?.fill(0);
 })();
 const close=()=>detached?Promise.resolve():closeNative();
 const adopt=(owner:h.ProviderServiceOwnership):NativeAdoptedTarget=>{
  check();h.assertProviderServiceOwnership(owner);if(!context.canonical||!startedIdentity||!retainedCapsule)refuse("Live adoption requires its original canonical running target.");
  const original=startedIdentity,database=retainDatabasePin(fs,workspace.dataDirectory+"/"+decoded.artifact.bundle.config.database.path);
  const guard=()=>{h.assertProviderAdoptedTargetOwnership(owner);database.check();};
  const fast=()=>{try{guard();if(closed||processBirth(original.pid)!==original.birth)refuse("Adopted target process was replaced or stopped.");const retained=nativeProcesses.get(original.pid+":"+original.birth)!;
   if(procText(retained.cgroup+"/cgroup.events",4096).split("\n").includes("frozen 1"))refuse("Adopted target process is frozen.");
   const status=procText("/proc/"+original.pid+"/status"),field=(name:string)=>status.split("\n").find(line=>line.startsWith(name+":"))?.split(":")[1]?.trim();
   if(field("NoNewPrivs")!=="1"||field("Seccomp")!=="2"||["CapEff","CapPrm","CapBnd"].some(name=>!/^0+$/u.test(field(name)??""))||["Uid","Gid"].some(name=>{const ids=field(name)?.split(/\s+/u);return ids?.length!==4||ids.some(id=>id!==String(name==="Uid"?process.getuid():process.getgid()));})||procText("/proc/"+original.pid+"/attr/current",4096).trim()!=="docker-default (enforce)")refuse("Adopted target kernel security profile changed.");
  }catch(error){invalidate();void closeNative().catch(()=>{});throw error;}};
  const verify=async()=>{const deadline:bigint=process.hrtime.bigint()+BigInt(context.operationTimeoutMs)*1000000n,g={check(){fast();if(process.hrtime.bigint()>=deadline)refuse("Adopted target verification deadline expired.");},remaining(){this.check();return Math.max(1,Number((deadline-(process.hrtime.bigint() as bigint))/1000000n));}},run=operation(g);
   try{g.check();checkNative();await verifyReleaseBytes(checkNative);g.check();await verifyDaemon(run);g.check();await inventory(cid,run);g.check();await competingMounts(run,checkNative);g.check();running(await inspect(run),original);await health(g);running(await inspect(run),original);g.check();checkNative();}catch(error){invalidate();try{await closeNative();}catch(cleanup){throw new AggregateError([error,cleanup],"Adopted target verification and cleanup failed.");}throw error;}
  };
  ownershipGuard=guard;detached=true;unregister?.();unregister=undefined;
  return Object.freeze({owner,root:owner.root,client:context.client,domain:context.domain,imageId,port,containerId:cid!,projectId:workspace.projectId,releaseId:decoded.manifest.releaseId,generation:decoded.manifest.generation,capsuleSha256:decoded.sha256,releaseDirectory:workspace.releaseDirectory,dataDirectory:workspace.dataDirectory,launchedAt:original.healthyAt,fast,verify,
   async capsule(){fast();const capsule=await decodeDeploymentRuntimeCapsule(retainedCapsule!.slice());fast();if(capsule.sha256!==decoded.sha256)refuse("Adopted target capsule changed.");return capsule;},
   async close(){try{await closeNative();}finally{database.close();}}});
 };
 try{
  crypto=await import("node:crypto");check();decoded=await decodeDeploymentRuntimeCapsule(captured);check();
  if(context.canonical&&(decoded.manifest.generation!==context.canonical.generation||decoded.manifest.releaseId!==context.canonical.releaseId))refuse("Approved target differs from its original canonical layout.");
  const manifest=decoded.manifest,config=decoded.artifact.bundle.config;
  if(manifest.projectId!==workspace.projectId||config.jobs!==undefined||manifest.database.mode!=="preserve"||decoded.databaseSnapshot!==null)refuse("Stopped target requires its original project, preserved data and separately owned writer roles.");
  const environment:Record<string,string>={...manifest.environment,NODE_ENV:"production",HOST:"0.0.0.0",PORT:String(port),CLANK_DATABASE_PATH:"/data/"+config.database.path,CLANK_DATABASE:"/data/"+config.database.path,CLANK_BUCKET_ROOT:"/data/buckets",CLANK_MANAGED_INGRESS:"1",TRUST_PROXY:"1"};
  delete (environment as any).CLANK_PROCESS_ROLE;delete (environment as any).CLANK_WORKER_CONCURRENCY;delete (environment as any).CLANK_WORKER_QUEUES;
  if(Object.entries(environment).some(([k,v])=>!/^[A-Z_][A-Z0-9_]*$/u.test(k)||typeof v!=="string"||/[\r\n\0]/u.test(v)))refuse("Stopped target environment cannot be represented exactly by its private creation transport.");
  const envBytes=Buffer.from(Object.entries(environment).map(([k,v])=>k+"="+v).join("\n")+"\n");if(envBytes.length>3145728)refuse("Target environment exceeds its bound.");
  const directories=new Map<string,Held>();
  const keepDirectory=(path:string,anchor:string)=>{
   const expected=fs.statSync(anchor),fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd);
   if(!expected.isDirectory()||stat.dev!==expected.dev||stat.ino!==expected.ino){fs.closeSync(fd);refuse("Original target directory differs from its retained parent.");}
   const pin={fd,path,dev:stat.dev,ino:stat.ino,size:0,mode:0o700,uid:process.getuid(),directory:true};pins.push(pin);directories.set(path,pin);check();return pin;
  };
  const release=keepDirectory(workspace.releaseDirectory,context.release.anchor);keepDirectory(workspace.dataDirectory,context.data.anchor);keepDirectory(context.workspace.path,context.workspace.anchor);
  if(fs.readdirSync(release.path).length||fs.readdirSync(workspace.dataDirectory).length)refuse("Original target staging namespace must be empty before installation.");
  let dataParent=directories.get(workspace.dataDirectory)!;
  for(const name of config.database.path.split("/").slice(0,-1)){const path=dataParent.path+"/"+name;fs.mkdirSync(`/proc/self/fd/${dataParent.fd}/`+name,{mode:0o700});dataParent=keepDirectory(path,`/proc/self/fd/${dataParent.fd}/`+name);}
  for(const file of decoded.artifact.bundle.files){
   check();const parts=file.path.split("/");let parent=release;
   for(const name of parts.slice(0,-1)){const path=parent.path+"/"+name;let next=directories.get(path);if(!next){fs.mkdirSync(`/proc/self/fd/${parent.fd}/`+name,{mode:0o700});next=keepDirectory(path,`/proc/self/fd/${parent.fd}/`+name);}parent=next;}
   const path=parent.path+"/"+parts.at(-1),fd=fs.openSync(`/proc/self/fd/${parent.fd}/`+parts.at(-1),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),body=Buffer.from(file.content,"base64");
   let kept=false;try{if(body.length!==file.size||crypto.createHash("sha256").update(body).digest("hex")!==file.sha256)refuse("Approved target artifact bytes differ.");fs.writeFileSync(fd,body);fs.fchmodSync(fd,file.mode);fs.fsyncSync(fd);const stat=fs.fstatSync(fd),stamp=fs.fstatSync(fd,{bigint:true});pins.push({fd,path,dev:stat.dev,ino:stat.ino,size:file.size,mode:file.mode,uid:process.getuid(),directory:false,sha256:file.sha256,mtimeNs:stamp.mtimeNs,ctimeNs:stamp.ctimeNs});kept=true;}finally{body.fill(0);if(!kept)fs.closeSync(fd);}check();
   await new Promise<void>(resolve=>setTimeout(resolve,0));check();
  }
  for(const directory of directories.values())fs.fsyncSync(directory.fd);
  // The release graph is immutable after installation. Retain its expected
  // roster once; every check still reads all native file identities and names.
  for(const directory of pins.filter(p=>p.directory&&p.path.startsWith(workspace.releaseDirectory)))releaseInventory.set(directory,new Map(pins.filter(p=>p.path.startsWith(directory.path+"/")&&!p.path.slice(directory.path.length+1).includes("/")).map(p=>[p.path.slice(directory.path.length+1),p])));
  sealedRelease=true;check();
  const name=".target-create-env-"+crypto.randomUUID(),envPath=context.workspace.path+"/"+name,envFd=fs.openSync(context.workspace.anchor+"/"+name,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(envFd,envBytes);fs.fsyncSync(envFd);const envStat=fs.fstatSync(envFd),envStamp=fs.fstatSync(envFd,{bigint:true});envFile={fd:envFd,path:envPath,dev:envStat.dev,ino:envStat.ino,size:envBytes.length,mode:0o600,uid:process.getuid(),directory:false,sha256:crypto.createHash("sha256").update(envBytes).digest("hex"),mtimeNs:envStamp.mtimeNs,ctimeNs:envStamp.ctimeNs};envBytes.fill(0);pins.push(envFile);check();
  await workspace.verifyCurrent();check();await verifyDaemon();check();await inventory();check();await competingMounts();check();
  imageConfiguration=JSON.parse((await command(["image","inspect",imageId,"--format","{{json .Config}}"])).stdout);check();
  expectedEnvironment=new Map<string,string>();for(const value of imageConfiguration.Env??[]){const at=value.indexOf("=");expectedEnvironment.set(value.slice(0,at),value.slice(at+1));}for(const[k,v]of Object.entries(environment))expectedEnvironment.set(k,v);
  if(imageConfiguration.Volumes&&Object.keys(imageConfiguration.Volumes).length||Object.keys(imageConfiguration.Labels??{}).some(k=>k.startsWith("run.clank.")))refuse("Target image declares an unowned volume or reserved label.");
  labels={...imageConfiguration.Labels,"run.clank.managed":"provider-runtime","run.clank.owner":context.domain.owner,"run.clank.project":workspace.projectId,"run.clank.release":manifest.releaseId,"run.clank.generation":String(manifest.generation),"run.clank.role":"web","run.clank.instance":"0","run.clank.handoff.target":"clank-provider-stopped-target/1","run.clank.handoff.target-id":workspace.targetId,"run.clank.handoff.capsule":decoded.sha256};
  const args=["container","create","--interactive","--pull","never","--restart","no","--read-only","--init","--cap-drop","ALL","--security-opt","no-new-privileges=true","--pids-limit","128","--memory","512m","--memory-swap","512m","--cpus","1","--user",process.getuid()+":"+process.getgid(),"--network","bridge","--stop-timeout","10","--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777","--tmpfs","/run:rw,noexec,nosuid,nodev,size=8m,mode=755","--log-driver","local","--log-opt","max-size=10m","--log-opt","max-file=3","--env-file",envPath];
  for(const[k,v]of Object.entries(labels!))args.push("--label",k+"="+v);
  for(const[source,target,readOnly]of [[workspace.releaseDirectory,"/app",true],[workspace.dataDirectory,"/data",false]]as const){if(/[\r\n,]/u.test(source))refuse("Original target mount cannot be represented exactly.");args.push("--mount","type=bind,source="+source+",target="+target+(readOnly?",readonly":""));}
  args.push("--publish","127.0.0.1:"+port+":"+port,"--workdir","/app",imageId,"node",config.entry);
  createdUnacknowledged=true;const id=(await command(args)).stdout.trim();if(!/^[a-f0-9]{64}$/u.test(id))refuse("Target creation did not return its exact identity.");cid=id;createdUnacknowledged=false;check();
  const actual=await inspect();check();normalize(actual);signature=normalize(actual);
  const mounts=actual.Mounts;if(mounts.length!==2||!mounts.some((m:any)=>m.Type==="bind"&&m.Source===workspace.releaseDirectory&&m.Destination==="/app"&&m.RW===false)||!mounts.some((m:any)=>m.Type==="bind"&&m.Source===workspace.dataDirectory&&m.Destination==="/data"&&m.RW===true))refuse("Original target native mounts differ.");
  await verify();check();
  const originalEnv=fs.lstatSync(envFile.path);if(originalEnv.dev!==envFile.dev||originalEnv.ino!==envFile.ino)refuse("Target environment temporary was replaced.");fs.unlinkSync(envFile.path);pins.splice(pins.indexOf(envFile),1);fs.closeSync(envFile.fd);envFile=undefined;check();
  const verifyRemoved=async()=>{
   context.check();const run=operation();await verifyDaemon(run);context.check();
   if((await run(["container","ls","--all","--no-trunc","--filter","id="+cid!,"--format","{{.ID}}"]).then(r=>r.stdout.trim()))||!processesAbsent())refuse("Original target removal is not current.");
   await inventory(undefined,run);await competingMounts(run,context.check);context.check();
  };
  const value=Object.freeze({targetId:workspace.targetId,projectId:workspace.projectId,nodeId:workspace.nodeId,releaseId:manifest.releaseId,generation:manifest.generation,capsuleSha256:decoded.sha256,containerId:cid,databasePath:workspace.dataDirectory+"/"+config.database.path,assertCurrent:check,verifySuspended:verify,close});
  check();unregister=context.retainCleanup(invalidate);leases.set(value,{ingress:Object.freeze({protocol:"clank-runtime/1",projectId:manifest.projectId,releaseId:manifest.releaseId,generation:manifest.generation,path:manifest.ingress.route,token:manifest.ingress.token,upstream:"http://127.0.0.1:"+port}),check,verify,start,verifyActive,verifyRemoved,adopt,configurationSha256:()=>{check();if(!signature)refuse("Original target configuration is unavailable.");return crypto!.createHash("sha256").update(signature).digest("hex");},processes:()=>Object.freeze([...nativeProcesses.values()].map(p=>Object.freeze({...p})))});if(context.canonical)retainedCapsule=captured.slice();captured.fill(0);decoded.bytes.fill(0);constructing=false;return value;
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original target construction and cleanup failed.");}throw error;}
}

export interface ProviderTransferTarget extends ProviderStoppedTarget {}
export interface ProviderTargetTransferReceipt {
 readonly targetId:string;readonly containerId:string;readonly kind:"base"|"tail";
 readonly sourceSpoolSha256:string;readonly cursor:PointInTimeTransferCursor;readonly baseBackupId:string;
 assertCurrent():void;
 verifyCurrent():Promise<void>;
}
type TransferTargetContext={target:ProviderStoppedTarget;native:ReturnType<typeof h.providerTargetWorkspaceContext>;source:h.ProviderSourceTransferLease;sourceContext:ReturnType<typeof h.providerSourceTransferContext>;check():void;verify():Promise<void>;close():Promise<void>;closed:boolean;handoffStarted?:boolean;handoffDeadline?:bigint;handoffExpiryTimer?:ReturnType<typeof setTimeout>;watchdog?:Promise<PublicationWatchdog>;watchdogState?:PublicationWatchdog;activation?:ActivationContext;flight?:Promise<ProviderTargetTransferReceipt>;verification?:Promise<void>;receipts:Map<string,ReceiptContext>;pendingDataProofs:Map<TargetSnapshot,TargetDataProof>;latest?:ReceiptContext;value?:ProviderTransferTarget;workspace:h.ProviderTargetWorkspace;transferred?:boolean;detachCleanup?:()=>void;platform?:import("./platform.ts").PlatformProviderHandoffParticipant};
type TargetSnapshot={cursor:PointInTimeTransferCursor;baseBackupId:string;stateHash:string;schemaHash:string;keyId:string};
type TargetDataProof={check():void;settle():void;close():void};
type ReceiptContext={dataProof?:TargetDataProof;owner:TransferTargetContext;value:ProviderTargetTransferReceipt;fd:number;path:string;dev:number;ino:number;body:string;snapshot:TargetSnapshot;check():void};
const transferTargets=new WeakMap<ProviderTransferTarget,TransferTargetContext>();
const transferReceipts=new WeakMap<ProviderTargetTransferReceipt,ReceiptContext>();
const settlements=new WeakSet<TransferTargetContext>();
function transferTarget(value:ProviderTransferTarget):TransferTargetContext{const held=transferTargets.get(value);if(!held)refuse("A genuine original transfer target is required.");held.check();return held;}
export function assertProviderTargetTransferReceipt(value:ProviderTargetTransferReceipt):void{const held=transferReceipts.get(value);if(!held)refuse("A genuine original target transfer receipt is required.");held.owner.check();if(held.owner.activation?.retired)refuse("Original target receipt was consumed by activation.");held.check();if(held.owner.latest!==held)refuse("Target receipt is no longer the current owned cursor.");}
type PublicationWatchdog={ready:Promise<void>;check():void;commit():Promise<void>;close():Promise<void>};
/** A detached host process owns cleanup if the provider/controller disappears. */
async function openPublicationWatchdog(held:TransferTargetContext):Promise<PublicationWatchdog>{
 held.check();const cpName="node:child_process",cp=await import(cpName),process=(globalThis as any).process,nonce=globalThis.crypto.randomUUID();
 const moduleURL=new URL("./provider-docker-client.js",import.meta.url).href;
 const program=`import fs from 'node:fs';
import {providerDockerClient,runProviderDockerClient} from ${JSON.stringify(moduleURL)};
const protocol='clank-handoff-watchdog/1';let frame,client,ready=false,ending=false,finished=false,input='',timer,cleanupDeadline;
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const now=()=>process.hrtime.bigint(),send=(event,extra={})=>{if(frame)process.stdout.write(JSON.stringify({protocol,event,cid:frame.cid,nonce:frame.nonce,...extra})+'\\n');};
const remaining=()=>{const end=cleanupDeadline??BigInt(frame.deadline);const value=Number((end-now())/1000000n);if(value<1)throw Error('Original publication watchdog deadline expired.');return Math.min(value,15000);};
const command=(args,allowFailure=false)=>runProviderDockerClient(client,args,{timeoutMs:remaining(),maxOutputBytes:65536,allowFailure});
const domain=async()=>{const result=await command(['info','--format','{{json .ID}}']);if(JSON.parse(result.stdout)!==frame.daemonId)throw Error('Original watchdog Docker domain changed.');};
const known=new Map();
const proc=(path)=>{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const buffer=Buffer.alloc(65537),count=fs.readSync(fd,buffer,0,buffer.length,0);if(count>65536)throw Error('Watchdog process observation exceeds its bound.');return buffer.subarray(0,count).toString();}finally{fs.closeSync(fd);}};
const retain=(pid)=>{if(!Number.isSafeInteger(pid)||pid<1)return;const stat=proc('/proc/'+pid+'/stat'),birth=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\\s+/u)[19],rows=proc('/proc/'+pid+'/cgroup').trim().split('\\n');if(!birth||rows.length!==1||!rows[0].startsWith('0::/'))throw Error('Watchdog process identity differs.');known.set(pid+':'+birth,{pid,birth,cgroup:'/sys/fs/cgroup'+rows[0].slice(3)});};
const absent=()=>{for(const row of known.values()){try{const text=proc('/proc/'+row.pid+'/stat');if(text.slice(text.lastIndexOf(') ')+2).trim().split(/\\s+/u)[19]===row.birth)return false;}catch(error){if(error.code!=='ENOENT')throw error;}try{if(proc(row.cgroup+'/cgroup.procs').trim())return false;}catch(error){if(error.code!=='ENOENT')throw error;}}return true;};
const inspect=async()=>{const result=await command(['container','inspect','--format','[{{json .Id}},{{json .Image}},{{json .Config.Labels}},{{json .State.Pid}},{{json .State.Status}}]',frame.cid],true);if(result.code!==0){const ids=(await command(['container','ls','--all','--no-trunc','--filter','id='+frame.cid,'--format','{{.ID}}'])).stdout.trim();if(ids)throw Error('Watchdog target inspection is unavailable.');return undefined;}const row=JSON.parse(result.stdout);if(!Array.isArray(row)||row.length!==5||row[0]!==frame.cid)throw Error('Watchdog target identity differs.');return {Id:row[0],Image:row[1],Config:{Labels:row[2]},State:{Pid:row[3],Status:row[4]}};};
async function cleanup(reason){if(ending||finished)return;ending=true;clearTimeout(timer);try{if(frame&&client){cleanupDeadline=now()+30000000000n;await domain();const row=await inspect();if(row){let observationError;try{retain(row.State.Pid);}catch(error){if(error.code!=='ENOENT')observationError=error;}await command(['container','rm','--force',frame.cid]);if(observationError)throw observationError;}await domain();if(await inspect())throw Error('Watchdog target remains.');while(!absent()){remaining();await new Promise(resolve=>setTimeout(resolve,25));}send('closed',{reason});}process.exit(0);}catch(error){send('failed',{reason,message:String(error.message).slice(0,512)});process.exit(1);}}
async function initialize(value){frame=value;if(!frame||frame.protocol!==protocol||!/^sha256:[a-f0-9]{64}$/.test(frame.imageId)||! /^[a-f0-9]{64}$/.test(frame.cid)||typeof frame.nonce!=='string'||typeof frame.daemonId!=='string'||typeof frame.executable!=='string'||!/^\\d{1,24}$/.test(frame.deadline)||BigInt(frame.deadline)>now()+30000000000n)throw Error('Invalid original watchdog bootstrap.');if(!frame.environment||typeof frame.environment!=='object'||Array.isArray(frame.environment)||Object.keys(frame.environment).length>128||Object.entries(frame.environment).some(([k,v])=>! /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)||typeof v!=='string'||v.length>16384||v.includes(String.fromCharCode(0))))throw Error('Invalid original watchdog environment.');for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,frame.environment);const base=providerDockerClient({executable:frame.executable}).environment,extra=Object.fromEntries(Object.entries(frame.environment).filter(([key])=>!Object.hasOwn(base,key)));client=providerDockerClient({executable:frame.executable,dockerEnvironment:extra});timer=setTimeout(()=>void cleanup('deadline'),Math.max(1,Number((BigInt(frame.deadline)-now())/1000000n)));await domain();const row=await inspect();if(!row||row.Image!==frame.imageId||row.Config.Labels?.['run.clank.owner']!==frame.owner||row.Config.Labels?.['run.clank.handoff.target-id']!==frame.targetId||row.State.Status!=='created'||row.State.Pid!==0)throw Error('Watchdog requires its original never-started target.');if(ending)return;ready=true;send('ready');}
let tail=Promise.resolve();
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>2097152){void cleanup('oversized-input');return;}for(;;){const at=input.indexOf('\\n');if(at<0)break;const line=input.slice(0,at);input=input.slice(at+1);tail=tail.then(async()=>{if(ending||finished)return;if(!frame){await initialize(JSON.parse(line));return;}if(line==='commit'&&ready){if(now()>=BigInt(frame.deadline)){await cleanup('late-commit');return;}finished=true;clearTimeout(timer);process.stdin.pause();process.stdout.write(JSON.stringify({protocol,event:'committed',cid:frame.cid,nonce:frame.nonce})+'\\n',()=>process.exit(0));return;}await cleanup('cancel');}).catch(()=>cleanup('protocol-failure'));}});
process.stdin.on('end',()=>{void cleanup('owner-lost');});process.stdin.on('error',()=>{void cleanup('owner-lost');});
setTimeout(()=>{if(!frame)process.exit(1);},2000).unref();`;
 const child=cp.spawn(process.execPath,["--input-type=module","--eval",program],{env:{PATH:process.env.PATH??"",HOME:process.env.HOME??""},detached:true,stdio:["pipe","pipe","pipe"],shell:false});child.unref();
 let failure:Error|undefined,committed=false,ended=false,text="",stderr="",readyResolve!:()=>void,readyReject!:(error:Error)=>void,commitResolve!:()=>void,commitReject!:(error:Error)=>void;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 const acknowledgement=new Promise<void>((resolve,reject)=>{commitResolve=resolve;commitReject=reject;});void acknowledgement.catch(()=>{});
 const fail=(error:Error)=>{failure??=error;readyReject(failure);commitReject(failure);};
 const closed=new Promise<{code:number|null;signal:string|null}>(resolve=>{child.once("error",(error:Error)=>fail(error));child.once("close",(code:number|null,signal:string|null)=>{ended=true;if(!committed)fail(new Error("Original publication watchdog closed before acknowledgement."));resolve({code,signal});});});
 child.stderr?.setEncoding("utf8");child.stderr?.on("data",(chunk:string)=>{stderr=(stderr+chunk).slice(0,2048);});
 child.stdout?.setEncoding("utf8");child.stdout?.on("data",(chunk:string)=>{text+=chunk;if(text.length>8192){text="";fail(new Error("Original watchdog output exceeds its bound."));return;}for(;;){const at=text.indexOf("\n");if(at<0)break;const line=text.slice(0,at);text=text.slice(at+1);try{const row=JSON.parse(line);if(row.protocol!=="clank-handoff-watchdog/1"||row.cid!==held.target.containerId||row.nonce!==nonce)throw new Error("Original watchdog response differs.");if(row.event==="ready")readyResolve();else if(row.event==="committed"){committed=true;commitResolve();}else fail(new Error("Original publication watchdog fenced its target."));}catch(error){fail(error instanceof Error?error:new Error(String(error)));}}});
 child.stdin?.on("error",(error:Error)=>fail(error));
 child.stdin!.write(JSON.stringify({protocol:"clank-handoff-watchdog/1",cid:held.target.containerId,nonce,deadline:String(held.handoffDeadline),daemonId:held.native.domain.daemonId,owner:held.native.domain.owner,targetId:held.target.targetId,imageId:held.sourceContext.grant.imageId,executable:held.native.client.executable,environment:{...held.native.client.environment}})+"\n");
 return {ready,check(){if(failure||ended&&!committed)throw failure??new Error("Original publication watchdog is unavailable.");},async commit(){await ready;if(failure)throw failure;if(!committed)child.stdin!.write("commit\n");await acknowledgement;const result=await closed;if(result.code!==0)throw new Error("Original watchdog acknowledgement failed: "+stderr);},async close(){if(!ended&&!committed)child.stdin?.end("cancel\n");const result=await closed;if(result.code!==0)throw new Error("Original publication watchdog cleanup failed: "+stderr);}};
}
async function finishTargetHandoffBudget(held:TransferTargetContext,active:ProviderActivatedTarget):Promise<boolean>{
 held.check();if(!held.handoffStarted||activatedTargets.get(active)?.held!==held)refuse("Original handoff budget requires its genuine activated target.");
 const coordinator=await import("./orchestration.ts");held.check();
 const publication=coordinator.providerHandoffPublicationContext(held.value!);
 if(publication&&!publication.committed(active))return false;
 held.check();const watcher=await held.watchdog;await watcher?.commit();held.check();if(held.handoffExpiryTimer!==undefined){clearTimeout(held.handoffExpiryTimer);held.handoffExpiryTimer=undefined;}held.handoffDeadline=undefined;return true;
}
/** Clear a registered publication budget only after its original durable commit. */
export async function completeProviderTargetPublication(active:ProviderActivatedTarget):Promise<void>{
 const original=activatedTargets.get(active);if(!original)refuse("A genuine original activated target is required.");
 if(!await finishTargetHandoffBudget(original.held,active))refuse("Original coordinator publication is not committed.");
}
/** Private source settlement context; only an original receipt supplies this binding. */
export function providerTargetTransferReceiptContext(value:ProviderTargetTransferReceipt){
 assertProviderTargetTransferReceipt(value);const held=transferReceipts.get(value)!;return Object.freeze({source:held.owner.source,body:held.body,value,verify:()=>verifyProviderTargetTransferReceipt(value),check:()=>assertProviderTargetTransferReceipt(value),reserve(){assertProviderTargetTransferReceipt(value);if(held.owner.flight||held.owner.verification||settlements.has(held.owner))refuse("Original target receipt settlement is already pending.");settlements.add(held.owner);let released=false;return ()=>{if(!released){released=true;settlements.delete(held.owner);}};}});
}

/** Derive the target generation, release, artifact and environment from native source enrollment. */
export async function createProviderTransferTarget(workspace:h.ProviderTargetWorkspace,bridge:h.ProviderHandoffBridge,sourceCapsule:Uint8Array,imageId:string,port:number,platformRuntime?:object):Promise<ProviderTransferTarget>{
 const native=h.providerTargetWorkspaceContext(workspace);h.assertProviderHandoffBridge(bridge);
 const captured=captureCapsule(sourceCapsule);
 let platformParticipant:import("./platform.ts").PlatformProviderHandoffParticipant|undefined;
 let source:h.ProviderSourceTransferLease|undefined,target:ProviderStoppedTarget|undefined,derived:Awaited<ReturnType<typeof createDeploymentRuntimeCapsule>>|undefined,decoded:Awaited<ReturnType<typeof decodeDeploymentRuntimeCapsule>>|undefined;
 try{
  const platform=platformRuntime===undefined?undefined:(await import("./platform.ts")).platformProviderHandoffContext(platformRuntime);native.check();
  source=await h.retainProviderSourceTransfer(bridge,workspace.projectId);native.check();const original=h.providerSourceTransferContext(source),identity=original.binding.identity;
  if(identity.targetNodeId!==workspace.nodeId||identity.source.projectId!==workspace.projectId||imageId!==original.grant.imageId||native.canonical&&native.canonical.handoffId!==identity.handoffId)refuse("Target node, project or image differs from native source enrollment.");
  decoded=await decodeDeploymentRuntimeCapsule(captured);source.assertCurrent();native.check();
  if(decoded.sha256!==original.grant.capsuleSha256||decoded.sha256!==identity.artifactSha256||decoded.manifest.projectId!==identity.source.projectId||decoded.manifest.releaseId!==identity.source.releaseId||decoded.manifest.generation!==identity.source.generation)refuse("Target artifact requires the exact original approved source capsule.");
  if(platform){const approved=await platform.prepare(source,captured);derived=approved.capsule;platformParticipant=approved.participant;platformParticipant.check();}
  else derived=await createDeploymentRuntimeCapsule({projectId:workspace.projectId,releaseId:decoded.manifest.releaseId,generation:identity.targetGeneration,environment:{...decoded.manifest.environment},database:{path:decoded.manifest.database.path,mode:"preserve"},ingress:{...decoded.manifest.ingress},artifact:decoded.artifact.bytes});
  source.assertCurrent();native.check();
  target=await createStoppedProviderTarget(workspace,derived.bytes,imageId,port);source.assertCurrent();
  const underlying=target,lease=source;let held:TransferTargetContext;
  const check=()=>{if(held.closed)refuse("Original transfer target is closed or fenced.");try{if(held.handoffDeadline!==undefined&&(globalThis as any).process.hrtime.bigint()>=held.handoffDeadline)refuse("Original provider handoff interruption deadline expired.");underlying.assertCurrent();lease.assertCurrent();platformParticipant?.check();held.watchdogState?.check();for(const receipt of held.receipts.values())receipt.check();}catch(error){held.closed=true;throw error;}};
  const verify=async()=>{if(held.activation?.retired)refuse("Original target suspension was consumed by activation.");check();await lease.verifyCurrent();check();await underlying.verifySuspended();check();};
  let closing:Promise<void>|undefined,unregister:undefined|(()=>void);
  const close=()=>held.transferred?Promise.resolve():closing??=(async()=>{held.closed=true;if(held.handoffExpiryTimer!==undefined){clearTimeout(held.handoffExpiryTimer);held.handoffExpiryTimer=undefined;}await held.flight?.catch(()=>{});await held.verification?.catch(()=>{});await held.activation?.flight?.catch(()=>{});const failures:unknown[]=[];try{const watcher=await held.watchdog;await watcher?.close();}catch(error){failures.push(error);}try{await underlying.close();}catch(error){failures.push(error);}try{disposeTransferResources(held);}catch(error){failures.push(error);}unregister?.();if(failures.length)throw new AggregateError(failures,"Original target publication cleanup failed.");})();
  held={target:underlying,native,source:lease,sourceContext:original,check,verify,close,closed:false,receipts:new Map(),pendingDataProofs:new Map(),workspace,platform:platformParticipant};
  const value=Object.freeze({...underlying,assertCurrent:check,verifySuspended:verify,close});held.value=value;transferTargets.set(value,held);unregister=native.retainCleanup(()=>{void close().catch(()=>{});});held.detachCleanup=()=>unregister?.();await verify();return value;
 }catch(error){try{await target?.close();source?.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original transfer target construction and cleanup failed.");}throw error;
 }finally{captured.fill(0);decoded?.bytes.fill(0);derived?.bytes.fill(0);}
}
/** Native immutable data image around a full trusted SQLite inspection. */
function retainTargetDataProof(held:TransferTargetContext):TargetDataProof{
 const fs=held.native.fs,path=held.target.databasePath,fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),fields=["dev","ino","size","mode","uid","gid","nlink","mtimeNs","ctimeNs"];let closed=false,sealed:string|undefined;
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
 const image=()=>{
  if(closed)refuse("Original target data image is closed.");const native=fs.fstatSync(fd,{bigint:true}),visible=fs.lstatSync(path,{bigint:true});
  if(fields.some(k=>native[k]!==visible[k]))refuse("Original target data descriptor or path changed.");
  const row=(name:string,stat:any)=>{if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.uid!==BigInt((globalThis as any).process.getuid())||(stat.mode&0o777n)!==0o600n||stat.size>BigInt(512*1024*1024))refuse("Original target data image requires private native files.");return[name,...fields.map(k=>String(stat[k]))];};
  const rows:unknown[][]=[row("database",native)];for(const suffix of ["-wal","-journal"]){try{const stat=fs.lstatSync(path+suffix,{bigint:true}),observed=row(suffix,stat);rows.push(stat.size===0n?[suffix,null]:observed);}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;rows.push([suffix,null]);}}return JSON.stringify(rows);
 };
 // Empty SQLite sidecars have no pages or rollback records. Read-only and
 // read-write SQLite readers may create/remove them without changing data.
 try{const before=image();return{close,settle(){if(sealed!==undefined)refuse("Original target data image was already sealed.");const after=image();if(before!==after)refuse("Original target data changed during authenticated inspection.");sealed=after;},check(){if(sealed===undefined||image()!==sealed)refuse("Original target receipt data image changed.");}};}catch(error){close();throw error;}
}
/** Discard proof only before a trusted controlled write that revalidates its prefix. */
function clearTargetDataProofs(held:TransferTargetContext):void{
 const failures:unknown[]=[];for(const receipt of held.receipts.values()){const proof=receipt.dataProof;receipt.dataProof=undefined;try{proof?.close();}catch(error){failures.push(error);}}
 for(const proof of held.pendingDataProofs.values())try{proof.close();}catch(error){failures.push(error);}held.pendingDataProofs.clear();if(failures.length)throw new AggregateError(failures,"Original target data proof pins failed to close.");
}
function acceptTargetDataProof(held:TransferTargetContext,result:TargetSnapshot,receipt:ReceiptContext):void{
 const proof=held.pendingDataProofs.get(result);if(!proof)refuse("A genuine native target data inspection is required.");proof.check();receipt.dataProof?.close();receipt.dataProof=proof;held.pendingDataProofs.delete(result);
}
function retainTransferReceipt(held:TransferTargetContext,kind:"base"|"tail",spoolSha256:string,after:PointInTimeTransferCursor|null,result:TargetSnapshot):ReceiptContext{
 held.check();const fs=held.native.fs,path=held.native.workspace.path+"/."+kind+"-receipt-"+spoolSha256+".json";
 const body=JSON.stringify({protocol:"clank-provider-target-transfer-receipt/1",targetId:held.target.targetId,containerId:held.target.containerId,targetCapsuleSha256:held.target.capsuleSha256,sourceGrantId:held.source.grantId,sourceCapsuleSha256:held.sourceContext.grant.capsuleSha256,identity:held.sourceContext.binding.identity,kind,sourceSpoolSha256:spoolSha256,after,cursor:result.cursor,baseBackupId:result.baseBackupId,stateHash:result.stateHash,schemaHash:result.schemaHash,keyId:result.keyId})+"\n";
 if(Buffer.byteLength(body)>16384)refuse("Original target receipt exceeds its bound.");
 const key=kind+":"+spoolSha256,existing=held.receipts.get(key);if(existing){existing.check();if(existing.body!==body)refuse("Original target receipt replay differs.");acceptTargetDataProof(held,result,existing);return existing;}
 if(held.receipts.size>=held.sourceContext.limits.maxOperations)refuse("Original target receipt capacity is exhausted.");
 const fd=fs.openSync(held.native.workspace.anchor+"/."+kind+"-receipt-"+spoolSha256+".json",fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let retained=false;
 try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.fsyncSync(held.native.workspace.fd);const stat=fs.fstatSync(fd);let receipt:ReceiptContext;
  const check=()=>{const a=fs.fstatSync(fd),b=fs.lstatSync(path);if(!a.isFile()||!b.isFile()||a.nlink!==1||b.nlink!==1||a.dev!==stat.dev||a.ino!==stat.ino||b.dev!==stat.dev||b.ino!==stat.ino||a.uid!==stat.uid||b.uid!==stat.uid||(a.mode&0o777)!==0o600||(b.mode&0o777)!==0o600||a.size!==Buffer.byteLength(body)||b.size!==a.size)refuse("Original target receipt identity changed.");const bytes=Buffer.alloc(a.size);if(fs.readSync(fd,bytes,0,bytes.length,0)!==bytes.length||bytes.toString()!==body)refuse("Original target receipt bytes changed.");receipt.dataProof?.check();};
  const value=Object.freeze({targetId:held.target.targetId,containerId:held.target.containerId,kind,sourceSpoolSha256:spoolSha256,cursor:Object.freeze({...result.cursor}),baseBackupId:result.baseBackupId,assertCurrent(){assertProviderTargetTransferReceipt(value);},verifyCurrent(){return verifyProviderTargetTransferReceipt(value);}});
  receipt={owner:held,value,fd,path,dev:stat.dev,ino:stat.ino,body,snapshot:Object.freeze({cursor:value.cursor,baseBackupId:result.baseBackupId,stateHash:result.stateHash,schemaHash:result.schemaHash,keyId:result.keyId}),check};check();held.receipts.set(key,receipt);transferReceipts.set(value,receipt);retained=true;acceptTargetDataProof(held,result,receipt);return receipt;
 }finally{if(!retained)fs.closeSync(fd);}
}
function transferOperation(held:TransferTargetContext){
 const process=(globalThis as any).process,deadline:bigint=process.hrtime.bigint()+BigInt(Math.min(held.native.operationTimeoutMs,held.sourceContext.limits.controlTimeoutMs))*1000000n;
 const effective=held.handoffDeadline!==undefined&&held.handoffDeadline<deadline?held.handoffDeadline:deadline;
 const check=()=>{held.check();if(process.hrtime.bigint()>=effective)refuse("Original target transfer operation deadline exceeded.");};
 return {check,remaining(){check();return Math.max(1,Number((effective-(process.hrtime.bigint() as bigint))/1000000n));}};
}
async function inspectTargetSnapshot(held:TransferTargetContext,cursor:PointInTimeTransferCursor,key:Uint8Array,operation:ReturnType<typeof transferOperation>):Promise<TargetSnapshot>{
 const source=held.sourceContext,initial=source.binding.initialCursor,proof=retainTargetDataProof(held);let retained=false;
 try{const snapshot=await (stagePointInTimeTransfer as any)[SQLITE_INTERNAL].inspectProviderTarget({identity:source.binding.identity,cursor,keyId:source.grant.capture.keyId,encryptionKey:key,targetPath:held.target.databasePath,expectedEpoch:initial.epoch,expectedSequence:initial.sequence,expectedDigest:initial.digest,maxDurationMs:operation.remaining(),assertSourceCurrent:source.check,assertTargetCurrent:operation.check});operation.check();proof.settle();proof.check();held.pendingDataProofs.set(snapshot,proof);retained=true;return snapshot;}finally{if(!retained)proof.close();}
}
/** Refresh the native data seal and cursor before this receipt can settle a source tail. */
export function verifyProviderTargetTransferReceipt(value:ProviderTargetTransferReceipt):Promise<void>{
 const receipt=transferReceipts.get(value);if(!receipt)refuse("A genuine original target transfer receipt is required.");assertProviderTargetTransferReceipt(value);const held=receipt.owner;if(held.flight)refuse("Original target transfer is pending.");if(held.verification)return held.verification;
 return held.verification=(async()=>{let key:Uint8Array|undefined;try{
  const operation=transferOperation(held);await held.verify();operation.check();key=await h.resolveProviderSourceCaptureKey(held.sourceContext.bridge,held.source.projectId,held.source.grantId);operation.check();if(!receipt.dataProof){const actual=await inspectTargetSnapshot(held,value.cursor,key,operation);
  if(["baseBackupId","stateHash","schemaHash","keyId"].some(field=>(actual as any)[field]!==(receipt.snapshot as any)[field]))refuse("Original target receipt data seal differs.");acceptTargetDataProof(held,actual,receipt);}
  const proof=receipt.dataProof;if(!proof)refuse("Original target receipt data image is unavailable.");proof.check();await held.verify();operation.check();assertProviderTargetTransferReceipt(value);
 }catch(error){held.closed=true;throw error;}finally{key?.fill(0);held.verification=undefined;}})();
}
/** Stage only the original published base/key at the actual never-started target path. */
export function stageProviderTransferBase(value:ProviderTransferTarget):Promise<ProviderTargetTransferReceipt>{
 const held=transferTarget(value);if(held.activation)refuse("Original target transfer was reserved for activation.");if(settlements.has(held))refuse("Original target receipt settlement is pending.");if(held.latest?.value.kind==="tail")refuse("An applied target tail refuses base staging.");if(held.verification)refuse("An original target receipt verification is pending.");if(held.flight)return held.flight;
 return held.flight=(async()=>{let key:Uint8Array|undefined;try{
  const operation=transferOperation(held);await held.verify();operation.check();const source=held.sourceContext,binding=source.binding;key=await h.resolveProviderSourceCaptureKey(source.bridge,held.source.projectId,held.source.grantId);operation.check();const archive=JSON.parse(await h.readProviderSourceSpool(source.bridge,held.source.projectId,"base"));operation.check();
  clearTargetDataProofs(held);const cursor=binding.initialCursor,result=await stagePointInTimeTransfer(archive,{identity:binding.identity,encryptionKey:key,targetPath:held.target.databasePath,expectedEpoch:cursor.epoch,expectedSequence:cursor.sequence,expectedDigest:cursor.digest,operationId:binding.baseOperationId,maxArchiveBytes:source.limits.maxArchiveBytes,maxEntries:source.limits.maxJournalEntries,maxDurationMs:operation.remaining(),assertSourceCurrent:source.check,assertTargetCurrent:operation.check});operation.check();
  const snapshot=await inspectTargetSnapshot(held,result.cursor,key,operation);const receipt=retainTransferReceipt(held,"base",binding.baseArchiveSha256,null,snapshot);await held.verify();operation.check();receipt.check();held.latest=receipt;return receipt.value;
 }catch(error){held.closed=true;throw error;}finally{key?.fill(0);held.flight=undefined;}})();
}
/** Consume an original target cursor and only this source's catalog-published tail. */
export function applyProviderTransferTail(value:ProviderTransferTarget,predecessor:ProviderTargetTransferReceipt):Promise<ProviderTargetTransferReceipt>{
 const held=transferTarget(value),previous=transferReceipts.get(predecessor);if(held.activation)refuse("Original target transfer was reserved for activation.");if(settlements.has(held))refuse("Original target receipt settlement is pending.");if(!previous||previous.owner!==held)refuse("Tail replay requires its genuine original target predecessor receipt.");previous.check();if(held.flight||held.verification)refuse("An original target transfer is already pending.");
 return held.flight=(async()=>{let key:Uint8Array|undefined;try{
  const operation=transferOperation(held);await held.verify();operation.check();const source=held.sourceContext,encoded=await h.readProviderSourceSpool(source.bridge,held.source.projectId,"tail");operation.check();const crypto=await import("node:crypto"),spoolSha256=crypto.createHash("sha256").update(encoded).digest("hex"),batch=JSON.parse(encoded);operation.check();
  key=await h.resolveProviderSourceCaptureKey(source.bridge,held.source.projectId,held.source.grantId);operation.check();
  clearTargetDataProofs(held);const result=await applyPointInTimeTransfer(batch,{identity:source.binding.identity,encryptionKey:key,targetPath:held.target.databasePath,expectedCursor:previous.value.cursor,maxBatchBytes:source.limits.maxBatchBytes,maxEntries:source.limits.maxBatchEntries,maxDurationMs:operation.remaining(),assertSourceCurrent:source.check,assertTargetCurrent:operation.check});operation.check();
  const snapshot=await inspectTargetSnapshot(held,result.cursor,key,operation);const receipt=retainTransferReceipt(held,"tail",spoolSha256,previous.value.cursor,snapshot);await held.verify();operation.check();receipt.check();held.latest=receipt;return receipt.value;
 }catch(error){held.closed=true;throw error;}finally{key?.fill(0);held.flight=undefined;}})();
}

export interface ProviderActivatedTarget {
 readonly targetId:string;readonly projectId:string;readonly nodeId:string;readonly containerId:string;
 readonly releaseId:string;readonly generation:number;readonly capsuleSha256:string;
 readonly pid:number;readonly birth:string;readonly healthyAt:number;
 assertCurrent():void;verifyHealthy():Promise<void>;close():Promise<void>;
}
type ActivationJournal={check():void;advance(phase:"retired"|"starting"|"healthy",result:unknown):void;close():void};
type ActivationContext={stop:object;receipt:ProviderTargetTransferReceipt;retired:boolean;flight?:Promise<ProviderActivatedTarget>;journal?:ActivationJournal;database?:{check():void;close():void};canonical?:{check():void;close():void;sha256:string;fence:number;stateJSON:string;fenceJSON:string}};
const activatedTargets=new WeakMap<ProviderActivatedTarget,{check():void;binding:DeploymentRuntimeIngressBinding;held:TransferTargetContext}>();
/** Original private routes are derived from the approved capsule, never a caller URL/token. */
export function providerActivatedTargetIngressContext(value:ProviderActivatedTarget){const held=activatedTargets.get(value);if(!held)refuse("A genuine original activated target is required.");held.check();return Object.freeze({binding:held.binding,check:held.check,verify:value.verifyHealthy,close:value.close});}
/** Refuse unrelated targets before a source route can be drained. */
export function providerTargetHandoffContext(value:ProviderTransferTarget,receipt:ProviderTargetTransferReceipt){const held=transferTargets.get(value),original=transferReceipts.get(receipt);if(!held||!original||original.owner!==held||held.latest!==original)refuse("A genuine original target and its current receipt are required.");assertProviderTargetTransferReceipt(receipt);held.check();return Object.freeze({source:held.source,platform:held.platform,canonical:Boolean(held.native.canonical),check:held.check,verify:()=>verifyProviderTargetTransferReceipt(receipt),begin(){held.check();if(held.handoffStarted)refuse("Original handoff interruption budget was already reserved.");held.handoffStarted=true;const duration=Math.min(held.native.operationTimeoutMs,held.sourceContext.limits.controlTimeoutMs);held.handoffDeadline=(globalThis as any).process.hrtime.bigint()+BigInt(duration)*1000000n;held.watchdog=openPublicationWatchdog(held).then(watcher=>{held.watchdogState=watcher;return watcher;});void held.watchdog.catch(()=>{});held.handoffExpiryTimer=setTimeout(()=>{held.handoffExpiryTimer=undefined;if(held.handoffDeadline!==undefined)void held.close().catch(()=>{});},duration);(held.handoffExpiryTimer as any).unref?.();return duration;},async ready(){const watcher=await held.watchdog;await watcher?.ready;held.check();},finish(active:ProviderActivatedTarget){return finishTargetHandoffBudget(held,active);}});}

/** Capture only an original healthy canonical target; removal is independently verified after close. */
export function providerActivatedTargetRestartContext(value:ProviderActivatedTarget){
 const original=activatedTargets.get(value);if(!original)refuse("A genuine original activated target is required.");original.check();const held=original.held,data=held.activation?.canonical,native=leases.get(held.target)!;
 if(!data||!held.native.canonical)refuse("Restart permission requires its original canonical target data.");
 return Object.freeze({workspace:held.workspace,stateJSON:data.stateJSON,fenceJSON:data.fenceJSON,verifyRemoved:native.verifyRemoved,processes:native.processes(),target:Object.freeze({targetId:value.targetId,projectId:value.projectId,releaseId:value.releaseId,generation:value.generation,capsuleSha256:value.capsuleSha256,containerId:value.containerId,pid:value.pid,birth:value.birth})});
}
/** Evidence is derived only from a branded active target and original stopped source. */
export function providerActivatedTargetConditionalContext(value:ProviderActivatedTarget){
 const original=activatedTargets.get(value);if(!original)refuse("A genuine original activated target is required.");original.check();
 const held=original.held,native=providerActivatedTargetAdoptionContext(value);
 if(!held.activation)refuse("Original target activation is unavailable.");
 return Object.freeze({workspace:held.workspace,target:native.target,stateJSON:native.stateJSON,fenceJSON:native.fenceJSON,configurationSha256:native.configurationSha256,processes:native.processes,source:h.providerSourceStopRecoveryContext(held.activation.stop)});
}
/** Snapshot of the healthy original writer, used only by committed live-adoption publication. */
export function providerActivatedTargetAdoptionContext(value:ProviderActivatedTarget){
 const original=activatedTargets.get(value);if(!original)refuse("A genuine original activated target is required.");original.check();
 const held=original.held,data=held.activation?.canonical,native=leases.get(held.target)!;
 if(!data||!held.native.canonical)refuse("Live adoption requires its original canonical target data.");
 return Object.freeze({active:value,workspace:held.workspace,stateJSON:data.stateJSON,fenceJSON:data.fenceJSON,check:original.check,verify:value.verifyHealthy,close:value.close,
  configurationSha256:native.configurationSha256(),processes:native.processes(),
  target:Object.freeze({targetId:value.targetId,projectId:value.projectId,releaseId:value.releaseId,generation:value.generation,capsuleSha256:value.capsuleSha256,containerId:value.containerId,pid:value.pid,birth:value.birth})});
}
export function assertProviderActivatedTarget(value:ProviderActivatedTarget):void{const original=activatedTargets.get(value);if(!original)refuse("A genuine original activated target is required.");original.check();}
function disposeTransferResources(held:TransferTargetContext):void{
 const failures:unknown[]=[];try{clearTargetDataProofs(held);}catch(error){failures.push(error);}for(const receipt of held.receipts.values())try{held.native.fs.closeSync(receipt.fd);}catch(error){failures.push(error);}held.receipts.clear();
 for(const resource of [held.activation?.journal,held.activation?.database,held.activation?.canonical])try{resource?.close();}catch(error){failures.push(error);}held.source.close();if(failures.length)throw new AggregateError(failures,"Original transfer/activation pins failed to close.");
}
const ACTIVATION_SQL=`CREATE TABLE clank_provider_target_activation (id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),version INTEGER NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('prepared','retired','starting','healthy')),input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,result_json TEXT,result_sha256 TEXT) STRICT`;
async function createActivationJournal(held:TransferTargetContext,input:string,current:()=>void):Promise<ActivationJournal>{
 current();if(Buffer.byteLength(input)>65536)refuse("Original target activation input exceeds its bound.");
 const sqliteName="node:sqlite",cryptoName="node:crypto",[{DatabaseSync},crypto]=await Promise.all([import(sqliteName),import(cryptoName)]);current();const fs=held.native.fs,path=held.native.workspace.path+"/.activation.sqlite",anchor=held.native.workspace.anchor+"/.activation.sqlite";
 const fd=fs.openSync(anchor,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),stat=fs.fstatSync(fd);let closed=false,published=false;
 const hash=(value:string)=>crypto.createHash("sha256").update(value).digest("hex");let expected:any={id:1,protocol:1,version:1,phase:"prepared",input_json:input,input_sha256:hash(input),result_json:null,result_sha256:null};
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
 const identity=()=>{if(closed)refuse("Original target activation journal is closed.");held.native.check();const a=fs.fstatSync(fd),b=fs.lstatSync(path);if([a,b].some(value=>!value.isFile()||value.isSymbolicLink()||value.nlink!==1||value.dev!==stat.dev||value.ino!==stat.ino||value.uid!==stat.uid||(value.mode&0o777)!==0o600||value.size>262144))refuse("Original target activation journal identity differs.");};
 const schema=(db:any)=>{const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();if(JSON.stringify(rows)!==JSON.stringify([{type:"table",name:"clank_provider_target_activation",tbl_name:"clank_provider_target_activation",sql:ACTIVATION_SQL}])||db.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")refuse("Original target activation journal schema differs.");};
 const read=(db:any)=>{schema(db);const rows=db.prepare("SELECT * FROM clank_provider_target_activation LIMIT 2").all();if(rows.length!==1)refuse("Original target activation journal row differs.");return rows[0];};
 const readback=(wanted:any)=>{identity();const db=new DatabaseSync(anchor,{readOnly:true});try{db.exec("PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=0");if(JSON.stringify(read(db))!==JSON.stringify(wanted))refuse("Original target activation journal changed without its owning commit.");}finally{db.close();}identity();};
 const sync=()=>{identity();fs.fsyncSync(fd);fs.fsyncSync(held.native.workspace.fd);};
 try{const db=new DatabaseSync(anchor);try{db.enableLoadExtension(false);db.exec("PRAGMA journal_mode=DELETE;PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE");try{db.exec(ACTIVATION_SQL);if(db.prepare("INSERT INTO clank_provider_target_activation VALUES(1,1,1,'prepared',?,?,NULL,NULL)").run(input,hash(input)).changes!==1||JSON.stringify(read(db))!==JSON.stringify(expected))refuse("Original target activation preparation was not retained.");db.exec("COMMIT");}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}}finally{db.close();}sync();readback(expected);current();
  const result:ActivationJournal={check(){current();readback(expected);},advance(phase,result){current();readback(expected);if(({prepared:"retired",retired:"starting",starting:"healthy"} as Record<string,string>)[expected.phase]!==phase)refuse("Original target activation phase cannot be adopted or repeated.");const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>16384)refuse("Original target activation result exceeds its bound.");const next={...expected,version:expected.version+1,phase,result_json:encoded,result_sha256:hash(encoded)},db=new DatabaseSync(anchor);try{db.enableLoadExtension(false);db.exec("PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=0;BEGIN IMMEDIATE");try{if(JSON.stringify(read(db))!==JSON.stringify(expected)||db.prepare("UPDATE clank_provider_target_activation SET version=?,phase=?,result_json=?,result_sha256=? WHERE id=1 AND version=? AND phase=? AND input_json=? AND input_sha256=? AND result_json IS ? AND result_sha256 IS ?").run(next.version,phase,encoded,hash(encoded),expected.version,expected.phase,input,expected.input_sha256,expected.result_json,expected.result_sha256).changes!==1||JSON.stringify(read(db))!==JSON.stringify(next))refuse("Original target activation transition was not retained.");db.exec("COMMIT");}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}}finally{db.close();}sync();readback(next);expected=next;current();},close};published=true;return result;
 }finally{if(!published)close();}
}
function retainActivatedDatabase(held:TransferTargetContext){
 const fs=held.native.fs,path=held.target.databasePath,fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),original=fs.fstatSync(fd);let closed=false;
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};const check=()=>{if(closed)refuse("Original activated database pin is closed.");const a=fs.fstatSync(fd),b=fs.lstatSync(path);if([a,b].some(v=>!v.isFile()||v.isSymbolicLink()||v.nlink!==1||v.dev!==original.dev||v.ino!==original.ino||v.uid!==original.uid||(v.mode&0o777)!==0o600||v.size>512*1024*1024))refuse("Original activated database identity changed.");};try{check();return {check,close};}catch(error){close();throw error;}
}
/** Publish standard data metadata only for this original, retired, still-unstarted target. */
async function commitCanonicalTargetData(held:TransferTargetContext,current:()=>void){
 const layout=held.native.canonical;if(!layout)return undefined;
 const coordinator=await import("./orchestration.ts"),ticket=coordinator.providerHandoffTargetDataContext(held.value!);current();ticket.check();
 const fs=held.native.fs,process=(globalThis as any).process,pins:Array<{fd:number;path:string;dev:number;ino:number;body:string}>=[];let closed=false,published=false;
 const check=()=>{
  if(closed)refuse("Original canonical target metadata is closed.");ticket.check();
  for(const pin of pins){const a=fs.fstatSync(pin.fd),b=fs.lstatSync(pin.path);if(!a.isFile()||!b.isFile()||a.nlink!==1||b.nlink!==1||a.dev!==pin.dev||b.dev!==pin.dev||a.ino!==pin.ino||b.ino!==pin.ino||a.uid!==process.getuid()||b.uid!==process.getuid()||(a.mode&0o777)!==0o600||(b.mode&0o777)!==0o600||a.size!==Buffer.byteLength(pin.body)||b.size!==a.size)refuse("Original canonical target metadata identity differs.");const bytes=Buffer.alloc(a.size);if(fs.readSync(pin.fd,bytes,0,bytes.length,0)!==bytes.length||bytes.toString()!==pin.body)refuse("Original canonical target metadata bytes differ.");}
 };
 const guard=()=>{current();check();};
 const close=()=>{if(closed)return;closed=true;const errors:unknown[]=[];for(const pin of pins.splice(0).reverse())try{fs.closeSync(pin.fd);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"Original canonical target metadata pins failed to close.");};
 const relative=held.target.databasePath.slice(held.native.data.path.length+1);
 if(!relative||held.target.databasePath!==held.native.data.path+"/"+relative||held.native.data.path!==layout.project.path+"/data"||held.native.release.path!==layout.generations.path+"/g"+held.target.generation+"-"+held.target.releaseId)refuse("Original canonical target paths differ.");
 const active={projectId:held.target.projectId,releaseId:held.target.releaseId,generation:held.target.generation,fence:ticket.fence,capsuleSha256:held.target.capsuleSha256,databasePath:"data/"+relative,releaseDirectory:"generations/g"+held.target.generation+"-"+held.target.releaseId,committedAt:Date.now()};
 const state=JSON.stringify({protocol:"clank-provider-data/1",active,previous:null,rollback:null})+"\n",fence=JSON.stringify({protocol:"clank-provider-data-fence/1",projectId:held.target.projectId,fence:ticket.fence})+"\n";
 try{
  for(const[name,body]of [["state.json",state],["fence.json",fence]]){
   guard();const path=layout.project.path+"/"+name,fd=fs.openSync(layout.project.anchor+"/"+name,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),stat=fs.fstatSync(fd);pins.push({fd,path,dev:stat.dev,ino:stat.ino,body});
   fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.fsyncSync(layout.project.fd);guard();
  }
  const cryptoName="node:crypto",crypto=await import(cryptoName);guard();const value=Object.freeze({check,close,sha256:crypto.createHash("sha256").update(state).digest("hex"),fence:ticket.fence,stateJSON:state,fenceJSON:fence});published=true;return value;
 }finally{if(!published)close();}
}

/** Only the original stopped source and final native target receipt admit startup. */
export async function activateProviderTransferTarget(value:ProviderTransferTarget,stopValue:object,receiptValue:ProviderTargetTransferReceipt):Promise<ProviderActivatedTarget>{
 const held=transferTargets.get(value);if(!held)refuse("A genuine original transfer target is required.");held.check();
 const stopped=h.providerSourceStopActivationContext(stopValue),receipt=transferReceipts.get(receiptValue);if(!receipt||receipt.owner!==held||held.latest!==receipt)refuse("Activation requires its genuine current original target receipt.");
 if(stopped.source!==held.source)refuse("Activation requires the target's matching original native source stop.");
 const previous=JSON.parse(JSON.parse(stopped.input).targetReceipt),body=JSON.parse(receipt.body),seal=stopped.seal;
 if(["targetId","containerId","targetCapsuleSha256"].some(field=>previous[field]!==body[field])||JSON.stringify(body.identity)!==JSON.stringify(seal.identity)||JSON.stringify(receipt.snapshot.cursor)!==JSON.stringify(seal.through)||["baseBackupId","schemaHash","stateHash","keyId"].some(field=>(receipt.snapshot as any)[field]!==seal[field]))refuse("Target final data does not match its original stopped source seal.");
 if(held.activation){if(held.activation.stop!==stopValue||held.activation.receipt!==receiptValue)refuse("Original target activation cannot change its native inputs.");const active=await held.activation.flight!;await active.verifyHealthy();return active;}
 if(held.closed||held.flight||held.verification||settlements.has(held))refuse("Original target activation is already pending or unavailable.");
 const activation:ActivationContext={stop:stopValue,receipt:receiptValue,retired:false};held.activation=activation;settlements.add(held);
 const checkBase=()=>{held.check();stopped.check();receipt.check();activation.database?.check();activation.canonical?.check();};
 const check=()=>{try{checkBase();activation.journal?.check();}catch(error){held.closed=true;void held.close().catch(()=>{});throw error;}};
 const operation=()=>{const localDeadline:bigint=(globalThis as any).process.hrtime.bigint()+BigInt(Math.min(held.native.operationTimeoutMs,held.sourceContext.limits.controlTimeoutMs))*1000000n,deadline=held.handoffDeadline!==undefined&&held.handoffDeadline<localDeadline?held.handoffDeadline:localDeadline;const current=()=>{check();if((globalThis as any).process.hrtime.bigint()>=deadline)refuse("Original target activation deadline expired.");};return {check:current,remaining(){current();return Math.max(1,Number((deadline-((globalThis as any).process.hrtime.bigint() as bigint))/1000000n));}};};
 activation.flight=(async()=>{let key:Uint8Array|undefined;try{
  const run=operation();if(held.native.canonical){const coordinator=await import("./orchestration.ts");coordinator.providerHandoffTargetDataContext(value).check();run.check();}const validations=await Promise.allSettled([stopped.verify,()=>verifyProviderTargetTransferReceipt(receiptValue),held.verify].map(verify=>Promise.resolve().then(verify)));for(const result of validations)if(result.status==="rejected")throw result.reason;run.check();
  const input=JSON.stringify({protocol:"clank-provider-target-activation/1",targetId:held.target.targetId,containerId:held.target.containerId,capsuleSha256:held.target.capsuleSha256,domain:held.native.domain,sourceStop:JSON.stringify(stopped.receipt),sourceSeal:JSON.stringify(seal),targetReceipt:receipt.body});
  activation.journal=await createActivationJournal(held,input,checkBase);run.check();activation.database=retainActivatedDatabase(held);run.check();
  key=await h.resolveProviderSourceCaptureKey(held.sourceContext.bridge,held.source.projectId,held.source.grantId);run.check();const initial=held.sourceContext.binding.initialCursor;
  clearTargetDataProofs(held);const retired=await (stagePointInTimeTransfer as any)[SQLITE_INTERNAL].prepareProviderTargetActivation({identity:held.sourceContext.binding.identity,cursor:receiptValue.cursor,keyId:receipt.snapshot.keyId,snapshot:receipt.snapshot,encryptionKey:key,targetPath:held.target.databasePath,expectedEpoch:initial.epoch,expectedSequence:initial.sequence,expectedDigest:initial.digest,maxDurationMs:run.remaining(),assertSourceCurrent:stopped.check,assertTargetCurrent:run.check});run.check();
  if(JSON.stringify(retired)!==JSON.stringify(receipt.snapshot))refuse("Original target retirement result differs.");activation.journal.advance("retired",retired);activation.retired=true;run.check();await stopped.verify();run.check();
  if(held.native.canonical){
   activation.canonical=await commitCanonicalTargetData(held,()=>{held.check();stopped.check();receipt.check();activation.database?.check();});run.check();
  }
  activation.journal.advance("starting",{protocol:"clank-provider-target-starting/1",targetId:held.target.targetId,containerId:held.target.containerId,...(activation.canonical?{canonicalStateSha256:activation.canonical.sha256,lifecycleFence:activation.canonical.fence}:{})});run.check();
  const native=leases.get(held.target)!;const started=await native.start(run,stopped.verify);run.check();await stopped.verify();run.check();
  activation.journal.advance("healthy",{protocol:"clank-provider-target-healthy/1",targetId:held.target.targetId,containerId:held.target.containerId,...started});run.check();
  let verifying:Promise<void>|undefined;const verifyHealthy=()=>{check();if(verifying)refuse("Original activated target verification is already owned.");return verifying=(async()=>{try{const run=operation();await stopped.verify();run.check();await native.verifyActive(started,run);run.check();}catch(error){held.closed=true;try{await held.target.close();disposeTransferResources(held);}catch(cleanup){throw new AggregateError([error,cleanup],"Original activated target verification and cleanup failed.");}throw error;}finally{verifying=undefined;}})();};
  const active:ProviderActivatedTarget=Object.freeze({targetId:held.target.targetId,projectId:held.target.projectId,nodeId:held.target.nodeId,containerId:held.target.containerId,releaseId:held.target.releaseId,generation:held.target.generation,capsuleSha256:held.target.capsuleSha256,pid:started.pid,birth:started.birth,healthyAt:started.healthyAt,assertCurrent:check,verifyHealthy,close:held.close});activatedTargets.set(active,{check,binding:native.ingress,held});check();return active;
 }catch(error){held.closed=true;try{await held.target.close();disposeTransferResources(held);}catch(cleanup){throw new AggregateError([error,cleanup],"Original target activation and cleanup failed.");}throw error;}finally{key?.fill(0);settlements.delete(held);}})();return activation.flight;
}

function retainDatabasePin(fs:any,path:string){
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),original=fs.fstatSync(fd);let closed=false;
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
 const check=()=>{if(closed)refuse("Adopted target database pin is closed.");for(const row of [fs.fstatSync(fd),fs.lstatSync(path)])if(!row.isFile()||row.isSymbolicLink()||row.nlink!==1||row.dev!==original.dev||row.ino!==original.ino||row.uid!==original.uid||(row.mode&0o777)!==0o600||row.size>512*1024*1024)refuse("Adopted target database identity changed.");};
 try{check();return {check,close};}catch(error){close();throw error;}
}
type NativeAdoptedTarget={owner:h.ProviderServiceOwnership;root:string;client:ReturnType<typeof h.providerTargetWorkspaceContext>["client"];domain:h.ProviderHandoffDomain;imageId:string;port:number;containerId:string;projectId:string;releaseId:string;generation:number;capsuleSha256:string;releaseDirectory:string;dataDirectory:string;launchedAt:number;fast():void;verify():Promise<void>;capsule():Promise<Awaited<ReturnType<typeof decodeDeploymentRuntimeCapsule>>>;close():Promise<void>};
export interface ProviderAdoptedTargetRuntime {readonly projectId:string;}
const adoptedTargetRuntimes=new WeakMap<object,NativeAdoptedTarget>();
const adoptedLauncherClaims=new WeakSet<object>();
const failedTargetTransfers=new WeakMap<object,Promise<void>>();
export function settleFailedProviderTargetRuntime(value:object):Promise<void>|undefined{return failedTargetTransfers.get(value);}
export function providerAdoptedTargetRuntimeContext(value:object){const held=adoptedTargetRuntimes.get(value);if(!held)refuse("A genuine original adopted target runtime is required.");held.fast();return held;}
export function claimProviderAdoptedTargetLauncher(value:object){const held=providerAdoptedTargetRuntimeContext(value);if(adoptedLauncherClaims.has(value))refuse("Original adopted target launcher is already claimed.");adoptedLauncherClaims.add(value);return held;}
/** Only the in-progress durable owner transition may detach these native leases. */
export function transferProviderTargetRuntime(receipt:h.ProviderTargetAdoptionReceipt):ProviderAdoptedTargetRuntime{
 const move=h.providerTargetAdoptionMoveContext(receipt),active=activatedTargets.get(move.native.active);
 if(!active||active.held.workspace!==move.native.workspace)refuse("Original adopted target differs from its native owner transition.");active.check();
 const held=active.held,native=leases.get(held.target)!,runtime=native.adopt(move.owner);
 held.transferred=true;held.closed=true;held.detachCleanup?.();
 try{disposeTransferResources(held);held.workspace.close();const ticket=Object.freeze({projectId:runtime.projectId});adoptedTargetRuntimes.set(ticket,runtime);return ticket;}
 catch(error){const closing=runtime.close();failedTargetTransfers.set(receipt,closing);void closing.catch(()=>{});throw error;}
}

export async function closeProviderAdoptedTargetRuntime(value:object):Promise<void>{const held=adoptedTargetRuntimes.get(value);if(!held)refuse("A genuine original adopted target runtime is required.");await held.close();}
