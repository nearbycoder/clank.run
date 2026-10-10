import type {SQLiteInternal} from "./sqlite-internal.ts";
import {restorePointInTimeArchive, type PointInTimeArchive, type PointInTimeProviderBinding} from "./point-in-time.ts";

export interface PlatformPointInTimeSource {
  readonly binding: PointInTimeProviderBinding;
  readonly origin: string;
  readonly token: string;
  readonly encryptionKey: Uint8Array;
  /** Consult current provider generation and native project ownership. */
  assertCurrent(): void;
}
export interface PlatformPointInTimeOptions {
  /** Resolve only operator-registered provider endpoints, credentials and per-project keys. */
  source(projectId: string): Promise<PlatformPointInTimeSource>;
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxArchivesPerProject?: number;
  maxTotalArchiveBytes?: number;
}
export interface PlatformPointInTimePolicy {
  readonly projectId: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly nextExportAt: number | null;
  readonly pendingOperationId: string | null;
  readonly epoch: string | null;
  readonly sequence: number | null;
  readonly digest: string | null;
  readonly lastError: string | null;
}
export interface PlatformPointInTimeCheckpoint {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly binding: PointInTimeProviderBinding;
  readonly epoch: string;
  readonly sequence: number;
  readonly digest: string;
  readonly committedAt: number;
  readonly bytes: number;
  readonly sha256: string;
}
const identifier=(value:string)=>{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/u.test(value))throw new TypeError("Invalid recovery identifier.");return value;};
const operationIdentifier=(value:string)=>{if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))throw new TypeError("Invalid recovery operation identifier.");return value;};
const number=(value:number,min:number,max:number)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError("Invalid bounded recovery number.");return value;};
const synchronous=(callback:()=>void)=>{const result:unknown=callback();if(result!==undefined){
  if(result&&(typeof result==="object"||typeof result==="function")&&typeof Reflect.get(result,"then")==="function")void Promise.resolve(result).catch(()=>undefined);
  throw new TypeError("Recovery ownership assertions must complete synchronously.");
}};
const providerBinding=(value:PointInTimeProviderBinding)=>Object.freeze({projectId:identifier(value.projectId),nodeId:identifier(value.nodeId),releaseId:identifier(value.releaseId),generation:number(value.generation,1,Number.MAX_SAFE_INTEGER)});

/** Internal native platform controller; transport permissions are checked by its caller. */
export async function openPlatformPointInTime(options:{
  internal:SQLiteInternal;
  directory:string;
  configuration:PlatformPointInTimeOptions;
  assertOwner(projectId:string,ownerId:string):void;
  onError?:(error:unknown)=>void;
}){
  const {internal}=options,source=options.configuration.source,ownerAssertion=options.assertOwner,onError=options.onError;
  const assertOwner=(project:string,owner:string)=>synchronous(()=>ownerAssertion(project,owner));
  const maxBytes=number(options.configuration.maxArchiveBytes??32*1024*1024,4096,256*1024*1024),maxEntries=number(options.configuration.maxEntries??10000,1,100000),maxArchives=number(options.configuration.maxArchivesPerProject??30,1,1000),maxTotalBytes=number(options.configuration.maxTotalArchiveBytes??2*1024*1024*1024,maxBytes,128*1024*1024*1024),configuredDirectory=options.directory;
  if(typeof source!=="function"||typeof ownerAssertion!=="function")throw new TypeError("Registered recovery sources and current owner authorization are required.");
  const fsName="node:fs/promises",pathName="node:path",cryptoName="node:crypto";
  const [fs,path,crypto]=await Promise.all([import(fsName),import(pathName),import(cryptoName)]);
  await fs.mkdir(configuredDirectory,{recursive:true,mode:0o700});
  if((await fs.lstat(configuredDirectory)).isSymbolicLink())throw new Error("Recovery archive directory cannot be a symbolic link.");
  await fs.chmod(configuredDirectory,0o700);const directory=await fs.realpath(configuredDirectory);
  internal.transaction(()=>{
  const names=internal.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('clank_platform_pitr_state','clank_platform_pitr_policies','clank_platform_pitr_operations','clank_platform_pitr_checkpoints','clank_platform_pitr_archives')").all();
  if(names.length!==0&&names.length!==5)throw new Error("Partial platform recovery protocol; preserve its retained evidence.");
  if(names.length===5&&internal.prepare("SELECT protocol FROM clank_platform_pitr_state WHERE id=1").get()?.protocol!==1)throw new Error("Unsupported retained platform recovery protocol.");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_pitr_state(id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1)) STRICT;
    CREATE TABLE IF NOT EXISTS clank_platform_pitr_policies(project TEXT PRIMARY KEY,version INTEGER NOT NULL,owner TEXT NOT NULL,enabled INTEGER NOT NULL,interval INTEGER NOT NULL,next_at INTEGER,pending TEXT,lease TEXT,lease_until INTEGER,epoch TEXT,sequence INTEGER,digest TEXT,error TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS clank_platform_pitr_operations(project TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,reserved_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project,id)) STRICT;
    CREATE TABLE IF NOT EXISTS clank_platform_pitr_checkpoints(id TEXT PRIMARY KEY,project TEXT NOT NULL,operation TEXT NOT NULL,policy_version INTEGER NOT NULL,binding TEXT NOT NULL,epoch TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,committed_at INTEGER NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(project,operation)) STRICT;
    CREATE TABLE IF NOT EXISTS clank_platform_pitr_archives(id TEXT PRIMARY KEY,contents BLOB NOT NULL) STRICT;`);
  if(names.length===0)internal.prepare("INSERT INTO clank_platform_pitr_state VALUES(1,1)").run();
  });
  const protocol=()=>{if(internal.prepare("SELECT protocol FROM clank_platform_pitr_state WHERE id=1").get()?.protocol!==1)throw new Error("Unsupported retained platform recovery protocol.");};
  const report=(error:unknown)=>{try{void Promise.resolve(onError?.(error)).catch(()=>undefined);}catch{}};
  const row=(project:string)=>{
    protocol();const r=internal.prepare("SELECT * FROM clank_platform_pitr_policies WHERE project=?").get(identifier(project));
    if(r){
      number(Number(r.version),1,Number.MAX_SAFE_INTEGER);number(Number(r.interval),1000,86400000);identifier(String(r.owner));
      if(r.enabled!==0&&r.enabled!==1||r.pending!==null&&typeof r.pending!=="string"||r.lease!==null&&typeof r.lease!=="string"||r.lease===null&&r.lease_until!==null||r.lease!==null&&r.lease_until===null
        ||r.epoch===null&&(r.sequence!==null||r.digest!==null)||r.epoch!==null&&(!/^[0-9a-f-]{36}$/u.test(String(r.epoch))||!/^[0-9a-f]{64}$/u.test(String(r.digest))))throw new Error("Invalid retained recovery policy.");
      if(r.pending!==null)identifier(String(r.pending));if(r.next_at!==null)number(Number(r.next_at),0,Number.MAX_SAFE_INTEGER);if(r.lease_until!==null)number(Number(r.lease_until),0,Number.MAX_SAFE_INTEGER);if(r.sequence!==null)number(Number(r.sequence),0,Number.MAX_SAFE_INTEGER);
    }
    return r;
  };
  const policy=(project:string):PlatformPointInTimePolicy|null=>{const r=row(project);return r?Object.freeze({projectId:project,version:Number(r.version),enabled:r.enabled===1,intervalMs:Number(r.interval),nextExportAt:r.next_at===null?null:Number(r.next_at),pendingOperationId:r.pending===null?null:String(r.pending),epoch:r.epoch===null?null:String(r.epoch),sequence:r.sequence===null?null:Number(r.sequence),digest:r.digest===null?null:String(r.digest),lastError:r.error===null?null:String(r.error)}):null;};
  const checkpoint=(r:Record<string,unknown>):PlatformPointInTimeCheckpoint=>{
    const binding=providerBinding(JSON.parse(String(r.binding)));
    if(binding.projectId!==r.project||typeof r.id!=="string"||!/^pitr_[0-9a-f]{64}$/u.test(r.id)||typeof r.epoch!=="string"||!/^[0-9a-f-]{36}$/u.test(r.epoch)||typeof r.digest!=="string"||!/^[0-9a-f]{64}$/u.test(r.digest)||typeof r.sha256!=="string"||!/^[0-9a-f]{64}$/u.test(r.sha256))throw new Error("Invalid retained recovery checkpoint.");
    return Object.freeze({id:r.id,projectId:identifier(String(r.project)),operationId:identifier(String(r.operation)),binding,epoch:r.epoch,sequence:number(Number(r.sequence),0,Number.MAX_SAFE_INTEGER),digest:r.digest,committedAt:number(Number(r.committed_at),0,Number.MAX_SAFE_INTEGER),bytes:number(Number(r.bytes),1,maxBytes),sha256:r.sha256});
  };
  const archive=(project:string,id:string,assertCurrent:()=>void):Uint8Array=>{
    protocol();synchronous(assertCurrent);identifier(project);const owner=row(project)?.owner;if(typeof owner!=="string")throw new Error("Retained recovery policy is unavailable.");assertOwner(project,owner);
    const r=internal.prepare("SELECT * FROM clank_platform_pitr_checkpoints WHERE project=? AND id=?").get(project,id);if(!r)throw new Error("Recovery checkpoint is unavailable.");const retained=checkpoint(r);
    const stored=internal.prepare("SELECT contents FROM clank_platform_pitr_archives WHERE id=?").get(retained.id)?.contents;
    if(!(stored instanceof Uint8Array)||stored.byteLength!==retained.bytes||crypto.createHash("sha256").update(stored).digest("hex")!==retained.sha256)throw new Error("Retained encrypted recovery archive is missing or corrupt.");
    synchronous(assertCurrent);assertOwner(project,owner);return new Uint8Array(stored);
  };
  const capacity=()=>{if(Number(internal.prepare("SELECT count(*) AS n FROM clank_platform_pitr_operations").get()!.n)>=10000)throw new Error("Retained recovery operation capacity is full.");};
  let closed=false,timer:ReturnType<typeof setTimeout>|undefined,flight:Promise<void>|undefined;
  const captures=new Set<Promise<PlatformPointInTimeCheckpoint>>(),cancellations=new Set<AbortController>();
  const configure=(project:string,owner:string,input:{operationId:string;expectedVersion:number;enabled:boolean;intervalMs:number},assertCurrent:()=>void)=>internal.transaction(()=>{
    protocol();synchronous(assertCurrent);if(closed)throw new Error("Recovery controller is closed.");identifier(project);identifier(owner);operationIdentifier(input.operationId);number(input.expectedVersion,0,Number.MAX_SAFE_INTEGER);number(input.intervalMs,1000,24*60*60*1000);if(typeof input.enabled!=="boolean")throw new TypeError("Recovery policy enabled must be boolean.");
    assertOwner(project,owner);
    const fingerprint=JSON.stringify({owner,...input}),old=internal.prepare("SELECT kind,state,fingerprint,receipt FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(project,input.operationId);
    if(old){if(old.kind!=="configure"||old.state!=="accepted"||old.fingerprint!==fingerprint)throw new Error("Recovery policy retry conflict.");return JSON.parse(String(old.receipt));}
    const prior=row(project);if(Number(prior?.version??0)!==input.expectedVersion)throw new Error("Recovery policy version changed.");
    if(input.enabled&&prior?.pending)throw new Error("A retained recovery export requires resolution before enabling a changed policy.");
    capacity();assertOwner(project,owner);const version=input.expectedVersion+1;number(version,1,Number.MAX_SAFE_INTEGER);
    internal.prepare(`INSERT INTO clank_platform_pitr_policies VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
      ON CONFLICT(project) DO UPDATE SET version=excluded.version,owner=excluded.owner,enabled=excluded.enabled,interval=excluded.interval,next_at=excluded.next_at,error=NULL`).run(project,version,owner,input.enabled?1:0,input.intervalMs,input.enabled?Date.now()+input.intervalMs:null);
    const receipt=policy(project)!;internal.prepare("INSERT INTO clank_platform_pitr_operations VALUES(?,?, 'configure',?,'accepted',?,0,?)").run(project,input.operationId,fingerprint,JSON.stringify(receipt),Date.now());return receipt;
  });
  const performCapture=async(project:string,operationId:string,assertCurrent:()=>void):Promise<PlatformPointInTimeCheckpoint>=>{
    identifier(project);operationIdentifier(operationId);protocol();synchronous(assertCurrent);if(closed)throw new Error("Recovery controller is closed.");
    const configured=row(project);if(!configured)throw new Error("Recovery exports require a retained policy.");
    const version=Number(configured.version),owner=String(configured.owner),lease=crypto.randomUUID();assertOwner(project,owner);
    const existing=internal.prepare("SELECT * FROM clank_platform_pitr_checkpoints WHERE project=? AND operation=?").get(project,operationId);
    if(existing){archive(project,String(existing.id),assertCurrent);return checkpoint(existing);}
    if(configured.enabled!==1)throw new Error("Recovery exports require an enabled retained policy.");
    internal.transaction(()=>{
      protocol();synchronous(assertCurrent);assertOwner(project,owner);const current=row(project);if(current?.enabled!==1||current.version!==version||current.owner!==owner)throw new Error("Recovery policy changed.");
      if(current.pending&&current.pending!==operationId || current.lease_until!==null&&Number(current.lease_until)>Date.now())throw new Error("Recovery export already has an active owner or retained operation.");
      if(Number(internal.prepare("SELECT count(*) AS n FROM clank_platform_pitr_checkpoints WHERE project=?").get(project)!.n)>=maxArchives)throw new Error("Recovery checkpoint capacity is full; retained archives are preserved.");
      if(!internal.prepare("SELECT 1 FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(project,operationId)){
        capacity();if(Number(internal.prepare("SELECT coalesce(sum(reserved_bytes),0) AS n FROM clank_platform_pitr_operations").get()!.n)+maxBytes>maxTotalBytes)throw new Error("Recovery archive byte capacity is full.");
        internal.prepare("INSERT INTO clank_platform_pitr_operations VALUES(?,?,'export',?,'pending',NULL,?,?)").run(project,operationId,JSON.stringify({version,owner}),maxBytes,Date.now());
      }else{
        const operation=internal.prepare("SELECT kind,fingerprint,state FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(project,operationId)!;
        if(operation.kind!=="export"||operation.state!=="pending"||operation.fingerprint!==JSON.stringify({version,owner}))throw new Error("Recovery export retry conflict.");
      }
      internal.prepare("UPDATE clank_platform_pitr_policies SET pending=?,lease=?,lease_until=?,error=NULL WHERE project=? AND version=?").run(operationId,lease,Date.now()+120000,project,version);
    });
    let key:Uint8Array|undefined;const cancellation=new AbortController();cancellations.add(cancellation);
    const deadline=setTimeout(()=>cancellation.abort(new Error("Recovery export deadline exceeded.")),30000);deadline.unref?.();
    const current=()=>{protocol();synchronous(assertCurrent);assertOwner(project,owner);const r=row(project);if(closed||cancellation.signal.aborted||r?.enabled!==1||r.version!==version||r.owner!==owner||r.pending!==operationId||r.lease!==lease||Number(r.lease_until)<=Date.now())throw new Error("Recovery export lost its current policy or ownership.");};
    try{
      const connection=await new Promise<PlatformPointInTimeSource>((resolve,reject)=>{
        const aborted=()=>{cleanup();reject(cancellation.signal.reason);},cleanup=()=>cancellation.signal.removeEventListener("abort",aborted);
        if(cancellation.signal.aborted){aborted();return;}cancellation.signal.addEventListener("abort",aborted,{once:true});
        void Promise.resolve().then(()=>source(project)).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
      });current();
      const binding=providerBinding(connection.binding),origin=new URL(connection.origin),token=connection.token,sourceAssertion=connection.assertCurrent;
      const sourceCurrent=()=>synchronous(sourceAssertion);
      if(binding.projectId!==project||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash||!(origin.protocol==="https:"||origin.protocol==="http:"&&["127.0.0.1","[::1]","localhost"].includes(origin.hostname))||typeof token!=="string"||!/^[A-Za-z0-9_-]{32,512}$/u.test(token)||typeof sourceAssertion!=="function")throw new Error("Recovery source is not a registered private provider origin.");
      identifier(binding.projectId);identifier(binding.nodeId);identifier(binding.releaseId);number(binding.generation,1,Number.MAX_SAFE_INTEGER);
      if(!(connection.encryptionKey instanceof Uint8Array)||connection.encryptionKey.byteLength!==32)throw new Error("Recovery source key is unavailable.");key=new Uint8Array(connection.encryptionKey);
      sourceCurrent();current();
      internal.transaction(()=>{
        current();sourceCurrent();const intent=internal.prepare("SELECT kind,state,receipt FROM clank_platform_pitr_operations WHERE project=? AND id=?").get(project,operationId);
        if(!intent||intent.kind!=="export"||intent.state!=="pending")throw new Error("Retained recovery export intent changed.");
        const receipt=JSON.stringify({binding});
        if(intent.receipt===null)internal.prepare("UPDATE clank_platform_pitr_operations SET receipt=? WHERE project=? AND id=? AND state='pending' AND receipt IS NULL").run(receipt,project,operationId);
        else if(intent.receipt!==receipt)throw new Error("Recovery export retry changed its original provider binding.");
      });
      const response=await fetch(new URL("/__clank/pitr/checkpoint",origin),{redirect:"error",signal:cancellation.signal,headers:{authorization:"Bearer "+token,"x-clank-project-id":binding.projectId,"x-clank-node-id":binding.nodeId,"x-clank-release-id":binding.releaseId,"x-clank-runtime-generation":String(binding.generation),"x-clank-recovery-operation-id":operationId}});
      current();sourceCurrent();if(!response.ok||response.headers.get("x-clank-recovery-protocol")!=="clank-pitr-archive/1"||!response.body)throw new Error("Recovery provider did not return an authenticated checkpoint.");
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const part=await reader.read();current();sourceCurrent();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes)throw new Error("Recovery provider archive exceeds its byte bound.");chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
      const encoded=(globalThis as any).Buffer.concat(chunks),archive=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(encoded)) as PointInTimeArchive;
      if(archive.operationId!==operationId||archive.epoch!==configured.epoch&&configured.epoch!==null||configured.sequence!==null&&(archive.sequence<Number(configured.sequence)||archive.sequence===configured.sequence&&archive.digest!==configured.digest))throw new Error("Recovery checkpoint replays or changes its retained epoch/horizon.");
      const verificationDirectory=await fs.mkdtemp(path.join(directory,".verify-"));
      try{await restorePointInTimeArchive(archive,{encryptionKey:key,targetPath:path.join(verificationDirectory,"verified.sqlite"),confirmation:"restore point in time",throughSequence:archive.sequence,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest,expectedBinding:binding,operationId,maxArchiveBytes:maxBytes,maxEntries});}finally{await fs.rm(verificationDirectory,{recursive:true,force:true});}
      current();sourceCurrent();const id="pitr_"+crypto.createHash("sha256").update(project+"\0"+operationId).digest("hex"),digest=crypto.createHash("sha256").update(encoded).digest("hex");
      return internal.transaction(()=>{
        current();sourceCurrent();internal.prepare("INSERT INTO clank_platform_pitr_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,project,operationId,version,JSON.stringify(binding),archive.epoch,archive.sequence,archive.digest,archive.committedAt,bytes,digest,Date.now());
        internal.prepare("INSERT INTO clank_platform_pitr_archives VALUES(?,?)").run(id,new Uint8Array(encoded));
        const receipt=checkpoint(internal.prepare("SELECT * FROM clank_platform_pitr_checkpoints WHERE id=?").get(id)!);
        internal.prepare("UPDATE clank_platform_pitr_operations SET state='accepted',receipt=?,reserved_bytes=? WHERE project=? AND id=? AND state='pending'").run(JSON.stringify(receipt),bytes,project,operationId);
        internal.prepare("UPDATE clank_platform_pitr_policies SET next_at=?,pending=NULL,lease=NULL,lease_until=NULL,epoch=?,sequence=?,digest=?,error=NULL WHERE project=? AND version=? AND lease=?").run(Date.now()+Number(configured.interval),archive.epoch,archive.sequence,archive.digest,project,version,lease);return receipt;
      });
    }catch(error){internal.transaction(()=>{protocol();internal.prepare("UPDATE clank_platform_pitr_policies SET lease=NULL,lease_until=NULL,next_at=?,error=? WHERE project=? AND lease=?").run(Date.now()+30000,"Recovery export failed; exact retry or operator recovery is required.",project,lease);});report(error);throw error;}finally{clearTimeout(deadline);cancellations.delete(cancellation);key?.fill(0);}
  };
  const capture=(project:string,operationId:string,assertCurrent:()=>void)=>{
    const pending=performCapture(project,operationId,assertCurrent);captures.add(pending);void pending.then(()=>captures.delete(pending),()=>captures.delete(pending));return pending;
  };
  const run=async()=>{
    if(closed)return;protocol();const rows=internal.prepare("SELECT project,pending FROM clank_platform_pitr_policies WHERE enabled=1 AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,project LIMIT 5").all(Date.now(),Date.now());
    for(const r of rows){if(closed)return;const project=String(r.project),operation=r.pending===null?"scheduled_"+crypto.randomUUID().replaceAll("-",""):String(r.pending);try{await capture(project,operation,()=>{if(closed)throw new Error("Recovery scheduler closed.");});}catch(error){report(error);}}
  };
  const schedule=()=>{if(closed||timer)return;timer=setTimeout(()=>{timer=undefined;flight=run().catch(report).finally(()=>{flight=undefined;schedule();});},1000);timer.unref?.();};
  return Object.freeze({policy,configure,capture,archive,checkpoints(project:string){protocol();return internal.prepare("SELECT * FROM clank_platform_pitr_checkpoints WHERE project=? ORDER BY created_at DESC,id DESC LIMIT ?").all(identifier(project),maxArchives).map(checkpoint);},start(){schedule();},async close(){closed=true;if(timer)clearTimeout(timer);for(const cancellation of cancellations)cancellation.abort(new Error("Recovery controller closed."));await Promise.allSettled([...captures]);await flight;}});
}
