/** Private original source launch. First-base completion is not readiness/write authority. */
import * as h from "./provider-handoff.ts";
import { runProviderDockerClient } from "./provider-docker-client.ts";
import { decodeDeploymentRuntimeCapsule } from "./runtime-placement.ts";

const launches=new WeakSet<h.ProviderSourceLaunchDataLease>();
const ENTRY="node_modules/@clank.run/framework/dist/provider-source-entry.js";
const FRAME_MAX=3*1024*1024+16384+128;
const CAPSULE_MAX=32+2*1024*1024+100*1024*1024+512*1024*1024;
function refuse(message:string):never{throw new Error(message);}

/** Launch only a settled original generation; no ordinary activation is exposed. */
export async function launchProviderSourceContainer(
  service:h.ProviderSourceServiceOwnership,data:h.ProviderSourceLaunchDataLease,
  capsuleBytes:Uint8Array,imageId:string,port:number,
){
  // Resolve original ownership before touching any untrusted capsule input.
  h.assertProviderSourceServiceOwnership(service);h.assertProviderSourceLaunchDataLease(data);
  h.assertProviderSourceLaunchOwner(service,data);
  if(launches.has(data))refuse("Source launch cannot be duplicated or recycled.");
  if(typeof imageId!=="string"||!/^sha256:[a-f0-9]{64}$/u.test(imageId)||!Number.isSafeInteger(port)||port<1024||port>65535)refuse("Source launch requires an immutable image and bounded port.");
  const typed=Object.getPrototypeOf(Uint8Array.prototype),length=Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!,buffer=Object.getOwnPropertyDescriptor(typed,"buffer")!.get!;
  try{if(!(capsuleBytes instanceof Uint8Array)||!ArrayBuffer.isView(capsuleBytes)||length.call(capsuleBytes)>CAPSULE_MAX)refuse("Invalid source capsule.");Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!.call(buffer.call(capsuleBytes));}catch{refuse("Source capsule requires bounded native non-shared bytes.");}
  const bytes=new Uint8Array(capsuleBytes);launches.add(data);
  let decodedBytes:Uint8Array|undefined,releasePins:(()=>void)|undefined,published=false,retainOnFailure=false;
  try{
  const context=await h.providerSourceLaunchContext(service,data);
  const capsule=await decodeDeploymentRuntimeCapsule(bytes);decodedBytes=capsule.bytes;context.assertInitial();
  const manifest=capsule.manifest,config=capsule.artifact.bundle.config;
  if(capsule.sha256!==data.capsuleSha256||manifest.projectId!==data.projectId||manifest.releaseId!==data.releaseId||manifest.generation!==data.generation)refuse("Source capsule differs from its original committed data.");
  if(config.jobs!==undefined)refuse("Source launch cannot admit undeclared writer ownership for jobs.");
  if(!capsule.artifact.bundle.files.some(file=>file.path===ENTRY))refuse("Source capsule must include the approved private framework entry.");
  const environment:Record<string,string>={...manifest.environment,NODE_ENV:"production",HOST:"0.0.0.0",PORT:String(port),CLANK_DATABASE_PATH:"/data/"+config.database.path,CLANK_DATABASE:"/data/"+config.database.path,CLANK_BUCKET_ROOT:"/data/buckets",PROACT_DATABASE_PATH:"/data/"+config.database.path,PROACT_DATABASE:"/data/"+config.database.path,ALLOWED_HOSTS:"",CLANK_MANAGED_INGRESS:"1",TRUST_PROXY:"1"};
  delete environment.CLANK_PROCESS_ROLE;delete environment.CLANK_WORKER_CONCURRENCY;delete environment.CLANK_WORKER_QUEUES;
  if(Object.keys(environment).length>512||Buffer.byteLength(JSON.stringify(environment))>3*1024*1024)refuse("Source environment exceeds its original stdin bound.");
  const fsName="node:fs",cryptoName="node:crypto",childName="node:child_process";
  const fs=await import(fsName),crypto=await import(cryptoName),cp=await import(childName);context.assertInitial();
  // Authenticate actual released bytes before any grant/container side effect.
  // The owning source data descriptors continue to bind the canonical release.
  const verified=new Map<string,{fd:number;dev:number;ino:number;size:number;hash:string;mode:number;uid:number}>();
  let unregister:(()=>unknown)|undefined;
  releasePins=()=>{const errors:unknown[]=[];unregister?.();for(const entry of [...verified.values()].reverse())try{fs.closeSync(entry.fd);}catch(error){errors.push(error);}verified.clear();if(errors.length)throw new AggregateError(errors,"Original source release pins failed to close.");};
  unregister=context.retainCleanup(releasePins);
  const assertInventory=()=>{
    const expected=new Set(capsule.artifact.bundle.files.map(file=>file.path)),seen=new Set<string>();
    const visit=(directory:string)=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const path=directory+"/"+entry.name;if(fs.realpathSync(path)!==path||entry.isSymbolicLink())refuse("Source release namespace changed.");
      if(entry.isDirectory())visit(path);else{const name=path.slice(data.releaseDirectory.length+1);
        if(!entry.isFile()||!expected.has(name))refuse("Source release contains an unapproved entry.");seen.add(name);}
    }};
    visit(data.releaseDirectory);if(seen.size!==expected.size)refuse("Source release is incomplete.");
  };
  assertInventory();
  for(const file of capsule.artifact.bundle.files){
    const path=data.releaseDirectory+"/"+file.path;
    const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let kept=false;
    try{
      const s=fs.fstatSync(fd),visible=fs.lstatSync(path);
      if(!s.isFile()||s.nlink!==1||s.size!==file.size||s.uid!==(globalThis as any).process.getuid()||(s.mode&0o777)!==file.mode||visible.isSymbolicLink()||s.dev!==visible.dev||s.ino!==visible.ino||fs.realpathSync(path)!==path)refuse("Source release identity differs from its approved artifact.");
      const body=new Uint8Array(file.size+1);let n=0;
      while(n<body.length){const count=fs.readSync(fd,body,n,body.length-n,n);if(count===0)break;n+=count;}
      const hash=crypto.createHash("sha256").update(body.subarray(0,n)).digest("hex");
      if(n!==file.size||hash!==file.sha256)refuse("Source release bytes differ from its approved artifact.");
      verified.set(path,{fd,dev:s.dev,ino:s.ino,size:s.size,hash,mode:file.mode,uid:s.uid});kept=true;
    }finally{if(!kept)fs.closeSync(fd);}
  }
  const assertRelease=()=>{
    context.check();assertInventory();
    for(const [path,expected]of verified){
      const fd=expected.fd;
      {const s=fs.fstatSync(fd),visible=fs.lstatSync(path);
        if(!s.isFile()||s.nlink!==1||s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size||s.uid!==expected.uid||(s.mode&0o777)!==expected.mode||visible.dev!==s.dev||visible.ino!==s.ino||fs.realpathSync(path)!==path)refuse("Original source release changed during launch.");
        const body=new Uint8Array(expected.size+1);let n=0;
        while(n<body.length){const count=fs.readSync(fd,body,n,body.length-n,n);if(count===0)break;n+=count;}
        if(n!==expected.size||crypto.createHash("sha256").update(body.subarray(0,n)).digest("hex")!==expected.hash)refuse("Original source release bytes changed during launch.");
      }
    }
  };
  const control=crypto.randomBytes(32),grantSecret=crypto.randomBytes(32),recovery=crypto.randomBytes(32);
  const hash=(value:Uint8Array)=>crypto.createHash("sha256").update(value).digest("hex");
  const process=(globalThis as any).process;
  const binding=Object.freeze({protocol:"clank-provider-source-grant/1",enablementId:context.bridge.enablementId,indexId:context.indexId,catalogId:context.catalogId,domainSha256:context.domainSha256,
    projectId:data.projectId,releaseId:data.releaseId,generation:data.generation,capsuleSha256:data.capsuleSha256,sourceIncarnation:crypto.randomUUID(),grantId:crypto.randomUUID(),role:"web",instance:0,imageId,uid:process.getuid(),gid:process.getgid(),
    capture:{keyId:"source_"+crypto.randomUUID(),keySha256:hash(recovery),maxTransactionBytes:context.limits.maxCaptureTransactionBytes,maxStateBytes:context.limits.maxCaptureStateBytes,maxJournalEntries:context.limits.maxJournalEntries,maxJournalBytes:context.limits.maxJournalBytes}});
  const command=(args:string[],allowFailure=false)=>runProviderDockerClient(context.client,args,{timeoutMs:15000,maxOutputBytes:65536,allowFailure});
  const assertProjectContainers=async(expected?:string)=>{
    const result=await command(["container","ls","--all","--no-trunc","--filter","label=run.clank.managed=provider-runtime","--filter","label=run.clank.owner="+context.domain.owner,"--filter","label=run.clank.project="+data.projectId,"--format","{{.ID}}"]);
    context.check();const ids=result.stdout.trim()===""?[]:result.stdout.trim().split("\n");
    if(ids.some(id=>!/^[a-f0-9]{64}$/u.test(id))||ids.length!==(expected?1:0)||expected&&ids[0]!==expected)refuse("Source launch refuses an existing or additional managed project writer.");
  };
  let channel:h.ProviderSourceWorkerChannel|undefined,grant:h.ProviderSourceGrantLease|undefined,runtimeData:h.ProviderSourceRuntimeDataLease|undefined,container:h.ProviderSourceContainerLease|undefined;
  let child:any,childClosed:Promise<void>|undefined,cid:string|undefined,labels:Record<string,string>|undefined,closeFlight:Promise<void>|undefined,createUnacknowledged=false;
  const close=():Promise<void>=>closeFlight??=(async()=>{
    child?.stdin?.destroy();const errors:unknown[]=[];
    try{await channel?.close();}catch(error){errors.push(error);}
    if(createUnacknowledged)errors.push(new Error("Original source creation is unacknowledged; no container removal authority is available."));
    if(cid)try{
      const before=JSON.parse((await command(["container","inspect",cid])).stdout)[0];
      const observed=before?.Config?.Labels;
      if(before?.Id!==cid||before.Image!==imageId||!observed||!labels||Object.entries(labels).some(([key,value])=>observed[key]!==value)||Object.keys(observed).some(key=>key.startsWith("run.clank.")&&!Object.hasOwn(labels!,key)))refuse("Source cleanup cannot adopt a replacement container.");
      await command(["container","rm","--force",cid]);
      const remaining=await command(["container","ls","--all","--no-trunc","--filter","id="+cid,"--format","{{.ID}}"]);
      if(remaining.stdout.trim()!=="")refuse("Original source removal is not settled.");
      if(childClosed){let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([childClosed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Original source attachment close is unacknowledged after 10000ms.")),10000);})]);}
        finally{if(timer!==undefined)clearTimeout(timer);}
      }
    }catch(error){errors.push(error);}
    try{container?.close();}catch(error){errors.push(error);}try{runtimeData?.close();}catch(error){errors.push(error);}try{grant?.close();}catch(error){errors.push(error);}
    control.fill(0);grantSecret.fill(0);recovery.fill(0);bytes.fill(0);
    if(errors.length)throw new AggregateError(errors,"Original source launch cleanup is uncertain.");
    releasePins?.();
  })();
  try{
    assertRelease();context.assertInitial();
    await assertProjectContainers();assertRelease();context.assertInitial();
    const issued=await h.issueProviderHandoffGrant(context.bridge,{binding,grantSecretSha256:hash(grantSecret),controlSecretSha256:hash(control)});assertRelease();
    channel=await h.prepareProviderSourceWorkerChannel(context.bridge,{projectId:data.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,expectedVersion:2},control);assertRelease();
    labels={"run.clank.managed":"provider-runtime","run.clank.owner":context.domain.owner,"run.clank.project":data.projectId,"run.clank.release":data.releaseId,"run.clank.generation":String(data.generation),"run.clank.role":"web","run.clank.instance":"0",
      "run.clank.handoff.protocol":binding.protocol,"run.clank.handoff.node":context.domain.nodeId,"run.clank.handoff.daemon":context.domain.daemonId,"run.clank.handoff.domain":binding.domainSha256,"run.clank.handoff.enablement":binding.enablementId,"run.clank.handoff.index":binding.indexId,"run.clank.handoff.catalog":binding.catalogId,"run.clank.handoff.grant":binding.grantId,"run.clank.handoff.binding":issued.bindingSha256,"run.clank.handoff.capsule":data.capsuleSha256,"run.clank.handoff.incarnation":binding.sourceIncarnation};
    const args=["container","create","--interactive","--pull","never","--restart","no","--read-only","--init","--cap-drop","ALL","--security-opt","no-new-privileges=true","--pids-limit","128","--memory","512m","--memory-swap","512m","--cpus","1","--user",binding.uid+":"+binding.gid,"--network","bridge","--stop-timeout","10","--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777","--tmpfs","/run:rw,noexec,nosuid,nodev,size=8m,mode=755","--log-driver","local","--log-opt","max-size=10m","--log-opt","max-file=3"];
    for(const [name,value]of Object.entries(labels))args.push("--label",name+"="+value);
    for(const [source,target,readOnly]of [[data.releaseDirectory,"/app",true],[data.dataDirectory,"/data",false],[context.catalogDirectory,"/run/clank-source",true],[channel.mountSource,"/run/clank-source-worker",true]] as const){
      if(/[\r\n,]/u.test(source))refuse("Source mount cannot be represented exactly.");args.push("--mount","type=bind,source="+source+",target="+target+(readOnly?",readonly":""));
    }
    args.push("--publish","127.0.0.1:"+port+":"+port,"--workdir","/app",imageId,"node",ENTRY,config.entry);
    createUnacknowledged=true;const created=(await command(args)).stdout.trim();
    if(!/^[a-f0-9]{64}$/u.test(created))refuse("Source create did not return its exact container identity.");
    cid=created;createUnacknowledged=false;assertRelease();
    const input={projectId:data.projectId,grantId:binding.grantId,bindingSha256:issued.bindingSha256,containerId:cid,expectedVersion:2};
    await h.recordProviderHandoffContainerCreated(context.bridge,input);assertRelease();
    const workerChannel=await channel.bindCreated({...input,expectedVersion:3});assertRelease();
    child=cp.spawn(context.client.executable,["container","start","--attach","--interactive",cid],{env:context.client.environment,stdio:["pipe","pipe","pipe"]});
    childClosed=new Promise<void>(resolve=>{child.once("close",()=>resolve());});
    let attachmentFailure:unknown;child.once("error",(error:unknown)=>{attachmentFailure=error;});
    child.stdout.resume();child.stderr.resume();child.stdin.on("error",()=>{});
    const deadline=Date.now()+15000;
    for(;;){assertRelease();if(attachmentFailure)throw attachmentFailure;const state=JSON.parse((await command(["container","inspect",cid])).stdout)[0]?.State;if(state?.Running)break;if(Date.now()>deadline||child.exitCode!==null)refuse("Original source process did not start.");await new Promise(resolve=>setTimeout(resolve,25));}
    await h.recordProviderHandoffContainerStarted(context.bridge,{...input,expectedVersion:3});assertRelease();
    grant=await h.retainProviderSourceGrant(context.bridge,{...input,expectedVersion:4},control);runtimeData=await h.retainProviderSourceRuntimeData(grant);container=await h.retainProviderSourceContainer(runtimeData);assertRelease();
    await assertProjectContainers(cid);assertRelease();
    const firstBase=channel.dispatch(container);void firstBase.catch(()=>{});
    const bootstrap={protocol:"clank-provider-source-bootstrap/2",binding,bindingSha256:issued.bindingSha256,containerId:cid,catalogPath:"/run/clank-source/catalog.sqlite",grantSecret:grantSecret.toString("base64url"),controlSecret:control.toString("base64url"),recoveryKey:recovery.toString("base64url"),workerChannel};
    const frame=Buffer.from(JSON.stringify({environment,bootstrap})+"\n");if(frame.length>FRAME_MAX)refuse("Source stdin envelope exceeds its original bound.");
    await new Promise<void>((resolve,reject)=>child.stdin.end(frame,(error:unknown)=>error?reject(error):resolve()));frame.fill(0);control.fill(0);grantSecret.fill(0);recovery.fill(0);bytes.fill(0);
    await firstBase;assertRelease();container.assertCurrent();
    const healthDeadline=Date.now()+config.health.timeoutMs;
    for(;;){
      assertRelease();container.assertCurrent();
      if(child.exitCode!==null||attachmentFailure)refuse("Original source exited before application health.");
      let healthy=false;
      try{const response=await fetch("http://127.0.0.1:"+port+config.health.path,{redirect:"error",signal:AbortSignal.timeout(Math.max(1,Math.min(1000,healthDeadline-Date.now())))});
        healthy=response.ok;await response.body?.cancel();}catch{}
      assertRelease();container.assertCurrent();if(healthy)break;
      if(Date.now()>=healthDeadline)refuse("Original source application health did not settle before its deadline.");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await assertProjectContainers(cid);assertRelease();container.assertCurrent();
    const result=Object.freeze({container,assertCurrent(){assertRelease();container!.assertCurrent();},close});published=true;return result;
  }catch(error){try{await close();}catch(cleanup){retainOnFailure=true;throw new AggregateError([error,cleanup],"Original source launch and cleanup failed.");}throw error;}
  }finally{bytes.fill(0);decodedBytes?.fill(0);if(!published&&!retainOnFailure)releasePins?.();}
}
