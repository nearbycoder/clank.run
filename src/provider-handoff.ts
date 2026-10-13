/** Private provider ownership, source observations and first-base workers; no readiness or writer-stop proof. */
import { runProviderDockerClient, type DockerClient } from "./provider-docker-client.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
const OWNER_SQL="CREATE TABLE clank_provider_service_owner (protocol INTEGER NOT NULL CHECK(protocol=1)) STRICT";
const MARKER_SQL=`CREATE TABLE clank_provider_handoff_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  domain_json TEXT NOT NULL CHECK(length(CAST(domain_json AS BLOB)) BETWEEN 1 AND 4096),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64)
) STRICT`;
const INDEX_SQL=`CREATE TABLE clank_provider_handoff_index (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64)
) STRICT`;
const PROJECTS_SQL=`CREATE TABLE clank_provider_handoff_projects (
  project_id TEXT PRIMARY KEY NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  catalog_id TEXT NOT NULL UNIQUE CHECK(length(catalog_id)=36),
  installation TEXT NOT NULL CHECK(installation IN ('reserved','ready'))
) STRICT`;
const CATALOG_SQL=`CREATE TABLE clank_provider_handoff_catalog (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  catalog_id TEXT NOT NULL CHECK(length(catalog_id)=36),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64),
  barrier_sha256 TEXT CHECK(barrier_sha256 IS NULL OR length(barrier_sha256)=64)
) STRICT`;
const BARRIER_SQL=`CREATE TABLE clank_provider_handoff_barrier (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  handoff_id TEXT NOT NULL CHECK(length(handoff_id) BETWEEN 1 AND 128),
  step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
  identity_json TEXT NOT NULL CHECK(length(CAST(identity_json AS BLOB)) BETWEEN 1 AND 2048),
  source_capsule_sha256 TEXT NOT NULL CHECK(length(source_capsule_sha256)=64),
  source_incarnation TEXT NOT NULL CHECK(length(source_incarnation)=36),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  version INTEGER NOT NULL CHECK(version=1)
) STRICT`;
const BRIDGE_OWNER_SQL=`CREATE TABLE clank_provider_handoff_bridge_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=2),
  enablement_id TEXT NOT NULL CHECK(length(enablement_id)=36),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64),
  phase TEXT NOT NULL CHECK(phase IN ('installing','ready')),
  limits_json TEXT NOT NULL CHECK(length(CAST(limits_json AS BLOB)) BETWEEN 1 AND 2048),
  limits_sha256 TEXT NOT NULL CHECK(length(limits_sha256)=64),
  installation_sha256 TEXT NOT NULL CHECK(length(installation_sha256)=64)
) STRICT`;
const BRIDGE_INDEX_SQL=`CREATE TABLE clank_provider_handoff_bridge_index (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=2),
  enablement_id TEXT NOT NULL CHECK(length(enablement_id)=36),
  limits_sha256 TEXT NOT NULL CHECK(length(limits_sha256)=64),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  reservations_sha256 TEXT NOT NULL CHECK(length(reservations_sha256)=64)
) STRICT`;
const RESERVATIONS_SQL=`CREATE TABLE clank_provider_handoff_spool_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL CHECK(length(reservation_id)=36),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  catalog_id TEXT NOT NULL CHECK(length(catalog_id)=36),
  kind TEXT NOT NULL CHECK(kind IN ('base','tail')),
  maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes BETWEEN 1 AND 268435456),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  UNIQUE(catalog_id,kind)
) STRICT`;
const BRIDGE_STATE_SQL=`CREATE TABLE clank_provider_handoff_bridge_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=2),
  enablement_id TEXT NOT NULL CHECK(length(enablement_id)=36),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  records_sha256 TEXT NOT NULL CHECK(length(records_sha256)=64)
) STRICT`;
const GRANT_SQL=`CREATE TABLE clank_provider_handoff_source_grant (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=2),
  grant_id TEXT NOT NULL CHECK(length(grant_id)=36),
  binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 4096),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  grant_secret_sha256 TEXT NOT NULL CHECK(length(grant_secret_sha256)=64),
  control_secret_sha256 TEXT NOT NULL CHECK(length(control_secret_sha256)=64),
  state TEXT NOT NULL CHECK(state IN ('issued','created','started','ready','draining','quiescing','quiesced','sealed','revoked','stopped')),
  container_id TEXT CHECK(container_id IS NULL OR length(container_id)=64),
  readiness_json TEXT CHECK(readiness_json IS NULL OR length(CAST(readiness_json AS BLOB)) BETWEEN 1 AND 8192),
  readiness_sha256 TEXT CHECK(readiness_sha256 IS NULL OR length(readiness_sha256)=64)
) STRICT`;
const TRANSFER_SQL=`CREATE TABLE clank_provider_handoff_source_transfer (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=2),
  handoff_id TEXT NOT NULL CHECK(length(handoff_id) BETWEEN 1 AND 128),
  enrollment_json TEXT NOT NULL CHECK(length(CAST(enrollment_json AS BLOB)) BETWEEN 1 AND 16384),
  enrollment_sha256 TEXT NOT NULL CHECK(length(enrollment_sha256)=64),
  phase TEXT NOT NULL CHECK(phase IN ('enrolling','enrolled','barrier','quiesced','sealed-tail-retained','stopped')),
  stop_input_sha256 TEXT CHECK(stop_input_sha256 IS NULL OR length(stop_input_sha256)=64),
  quiescence_json TEXT CHECK(quiescence_json IS NULL OR length(CAST(quiescence_json AS BLOB)) BETWEEN 1 AND 8192),
  seal_json TEXT CHECK(seal_json IS NULL OR length(CAST(seal_json AS BLOB)) BETWEEN 1 AND 16384),
  stop_receipt_json TEXT CHECK(stop_receipt_json IS NULL OR length(CAST(stop_receipt_json AS BLOB)) BETWEEN 1 AND 32768)
) STRICT`;
const OPERATIONS_SQL=`CREATE TABLE clank_provider_handoff_source_operations (
  sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 256),
  step_id TEXT NOT NULL UNIQUE CHECK(length(step_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('enroll','batch','fence','stop')),
  input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) BETWEEN 1 AND 32768),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  state TEXT NOT NULL CHECK(state IN ('accepted','complete')),
  result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) BETWEEN 1 AND 8192),
  result_sha256 TEXT CHECK(result_sha256 IS NULL OR length(result_sha256)=64)
) STRICT`;
const SPOOLS_SQL=`CREATE TABLE clank_provider_handoff_source_spools (
  kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('base','tail')),
  reservation_id TEXT NOT NULL CHECK(length(reservation_id)=36),
  state TEXT NOT NULL CHECK(state IN ('reserved','ready')),
  manifest_json TEXT NOT NULL CHECK(length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 8192),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64)
) STRICT`;
const BRIDGE_INDEX=[INDEX_SQL,PROJECTS_SQL,BRIDGE_INDEX_SQL,RESERVATIONS_SQL];
const BRIDGE_CATALOG=[CATALOG_SQL,BARRIER_SQL,BRIDGE_STATE_SQL,GRANT_SQL,TRANSFER_SQL,OPERATIONS_SQL,SPOOLS_SQL];
const ID=/^[A-Za-z0-9_-]{1,128}$/u,OWNER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,DAEMON=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,DIGEST=/^[a-f0-9]{64}$/u;
const OWNER_MAX=65536,INDEX_MAX=262144,CATALOG_MAX=65536,BRIDGE_CATALOG_MAX=16777216;
type Row=Record<string,any>;
type Pin={fd:number;path:string;anchor:string;dev:number;ino:number;directory:boolean;maximum:number;normalize:boolean};
export interface ProviderServiceOwnership {readonly fs:any;readonly path:any;readonly root:string;readonly serviceDirectory:string;close():void}
export interface ProviderHandoffDomain {readonly protocol:"clank-provider-handoff-domain/1";readonly nodeId:string;readonly daemonId:string;readonly owner:string}
export interface ProviderHandoffBarrierInput {readonly identity:{readonly handoffId:string;readonly source:{readonly projectId:string;readonly nodeId:string;readonly releaseId:string;readonly generation:number};readonly targetNodeId:string;readonly targetGeneration:number;readonly artifactSha256:string};readonly stepId:string;readonly sourceCapsuleSha256:string;readonly sourceIncarnation:string}
type Context={fs:any;path:any;Database:any;hash:(text:string)=>string;randomUUID:()=>string;root:Pin;service:Pin;file:Pin;database:any;pins:Pin[];closed:boolean;admitted:boolean;mode:ProviderHandoffOwnerMode;marked:boolean;failed:boolean;queued:number;tail:Promise<void>};
const owners=new WeakMap<ProviderServiceOwnership,Context>();
const domains=new WeakMap<ProviderHandoffDomain,{owner:ProviderServiceOwnership;client:DockerClient}>();
const schemaCache=new Map<string,string>();
type ProviderHandoffOwnerMode="pre-admission"|"ordinary-admitted"|"bridge-live"|"cleanup-only"|"closed";
export interface ProviderHandoffBridgeLimits {readonly maxProjects:number;readonly maxOperations:number;readonly maxArchiveBytes:number;readonly maxBatchEntries:number;readonly maxBatchBytes:number;readonly maxCaptureTransactionBytes:number;readonly maxCaptureStateBytes:number;readonly maxJournalEntries:number;readonly maxJournalBytes:number;readonly maxSpoolBytes:number;readonly controlTimeoutMs:number}
export interface ProviderHandoffBridge {readonly enablementId:string;readonly mode:ProviderHandoffOwnerMode}
type BridgeContext={owner:ProviderServiceOwnership;domain:ProviderHandoffDomain;enablementId:string};
const bridges=new WeakMap<ProviderHandoffBridge,BridgeContext>();
/** Private startup admission only; no runtime, writer, readiness or stop proof. */
export interface ProviderSourceServiceOwnership {
  readonly root:string;
  readonly serviceDirectory:string;
  readonly ownerLabel:string;
  readonly nodeId:string;
  assertCurrent():void;
  verifyCurrent():Promise<void>;
  close():void;
}
type SourceServiceContext={owner:ProviderServiceOwnership;bridge:ProviderHandoffBridge;check:()=>void};
const sourceServiceOwners=new WeakMap<ProviderSourceServiceOwnership,SourceServiceContext>();
const sourceServiceReservations=new WeakSet<ProviderServiceOwnership>();
const sourceLaunchDataLeases=new WeakMap<object,{owner:ProviderServiceOwnership;check:()=>void;children:Set<()=>void>}>();
const ownerSourceLaunchData=new WeakMap<ProviderServiceOwnership,Set<()=>void>>();
const usedSourceLaunchProjects=new WeakMap<ProviderServiceOwnership,Set<string>>();
const pendingSourceLaunchData=new WeakMap<ProviderServiceOwnership,number>();
function closeSourceLaunchData(owner:ProviderServiceOwnership):void {
  const errors:unknown[]=[];
  for(const close of [...(ownerSourceLaunchData.get(owner)??[])])try{close();}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,"Provider source launch data failed to close.");
}
// Retained grant observations are deliberately distinct from worker authority.
// No task, path, socket, process or ordinary write is authorized by this lease.
export interface ProviderSourceGrantLease {
  readonly binding: Readonly<Record<string, any>>;
  assertCurrent(): void;
  verifyCurrent(): Promise<void>;
  close(): void;
}
type SourceGrantLeaseContext={check:()=>void;context:Context;registered:BridgeContext;bridge:ProviderHandoffBridge;input:ProviderHandoffContainerInput;children:Set<()=>void>;dataRetained:boolean};
const sourceGrantLeases=new WeakMap<ProviderSourceGrantLease,SourceGrantLeaseContext>();
const ownerSourceLeases=new WeakMap<ProviderServiceOwnership,Set<ProviderSourceGrantLease>>();
const retainedSourceGrants=new WeakMap<ProviderHandoffBridge,Set<string>>();
const MAX_SOURCE_GRANT_LEASES=2;
function closeSourceLeases(owner:ProviderServiceOwnership):void {
  const failures:unknown[]=[];
  for(const lease of [...(ownerSourceLeases.get(owner)??[])])try{lease.close();}catch(error){failures.push(error);}
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,"Provider source grant leases failed to close.");
}
const LIMIT_KEYS=["maxProjects","maxOperations","maxArchiveBytes","maxBatchEntries","maxBatchBytes","maxCaptureTransactionBytes","maxCaptureStateBytes","maxJournalEntries","maxJournalBytes","maxSpoolBytes","controlTimeoutMs"] as const;
const LIMIT_MAX=[100,256,268435456,1000,8388608,8388608,134217728,100000,1073741824,1073741824,60000];
function bridgeLimits(value:unknown):ProviderHandoffBridgeLimits {
  if(!exact(value,LIMIT_KEYS))fail("Provider handoff bridge limits are invalid.");const result:Row={};
  for(let i=0;i<LIMIT_KEYS.length;i++){const key=LIMIT_KEYS[i],n=value[key],minimum=["maxCaptureTransactionBytes","maxCaptureStateBytes","maxJournalBytes"].includes(key)?1024:key==="maxOperations"?3:1;if(!positive(n)||n>LIMIT_MAX[i]||n<minimum)fail("Provider handoff bridge limits are invalid.");result[key]=n;}
  return Object.freeze(result) as unknown as ProviderHandoffBridgeLimits;
}
function bridgeOwner(c:Context,root:Row):Row {
  assertBridgeOwnerStorage(c);
  const row=singleton(c.database,"clank_provider_handoff_bridge_owner");
  if(row.id!==1||row.protocol!==2||!match(row.enablement_id,UUID)||row.index_id!==root.index_id||row.domain_sha256!==root.domain_sha256||!["installing","ready"].includes(row.phase)||!match(row.limits_sha256,DIGEST)||!match(row.installation_sha256,DIGEST))fail();
  let limits;try{limits=bridgeLimits(JSON.parse(row.limits_json));}catch{fail();}
  if(boundedJSON(limits,2048)!==row.limits_json||c.hash(row.limits_json)!==row.limits_sha256)fail();return {...row,limits};
}
function assertBridgeOwnerStorage(c:Context):void {
  sidecars(c,c.service,".writer.sqlite",OWNER_MAX*2);
  if(c.database.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")fail("Provider handoff bridge owner requires existing DELETE journal mode.");
}
function rosterHash(c:Context,projects:Row[]):string{return c.hash(boundedJSON(projects.map(p=>({projectId:p.project_id,catalogId:p.catalog_id})),32768));}
function reservationRows(db:any):Row[]{return db.prepare("SELECT * FROM clank_provider_handoff_spool_reservations ORDER BY reservation_id LIMIT 201").all().map((r:Row)=>({...r}));}
function bridgeIndex(c:Context,db:any,root:Row,projects:Row[]):Row[]{
  const b=root.bridge,row=singleton(db,"clank_provider_handoff_bridge_index"),rows=reservationRows(db);
  if(row.id!==1||row.protocol!==2||row.enablement_id!==b.enablement_id||row.limits_sha256!==b.limits_sha256||!positive(row.version)||row.version<rows.length+1||projects.length>b.limits.maxProjects||rosterHash(c,projects)!==b.installation_sha256||rows.length>200||rows.length>projects.length*2)fail();
  let total=0;const keys=new Set<string>();
  for(const r of rows){const project=projects.find(p=>p.project_id===r.project_id&&p.catalog_id===r.catalog_id),key=r.catalog_id+":"+r.kind;
    if(!project||!match(r.reservation_id,UUID)||!match(r.input_sha256,DIGEST)||!['base','tail'].includes(r.kind)||!positive(r.maximum_bytes)||r.maximum_bytes>(r.kind==='tail'?8388608:b.limits.maxArchiveBytes)||keys.has(key))fail();keys.add(key);total+=r.maximum_bytes;}
  if(total>b.limits.maxSpoolBytes||c.hash(boundedJSON(rows,131072))!==row.reservations_sha256)fail("Provider handoff reservation mirror is invalid.");return rows;
}
function grantBinding(value:unknown,root:Row,project:Row):Row {
  const keys=["protocol","enablementId","indexId","catalogId","domainSha256","projectId","releaseId","generation","capsuleSha256","sourceIncarnation","grantId","role","instance","imageId","uid","gid","capture"];
  if(!exact(value,keys)||value.protocol!=="clank-provider-source-grant/1"||value.enablementId!==root.bridge.enablement_id||value.indexId!==root.index_id||value.catalogId!==project.catalog_id||value.domainSha256!==root.domain_sha256||value.projectId!==project.project_id||!match(value.releaseId,ID)||!positive(value.generation)||!match(value.capsuleSha256,DIGEST)||!match(value.sourceIncarnation,UUID)||!match(value.grantId,UUID)||value.role!=="web"||value.instance!==0||!match(value.imageId,/^sha256:[a-f0-9]{64}$/u)||![value.uid,value.gid].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647)||!exact(value.capture,["keyId","keySha256","maxTransactionBytes","maxStateBytes","maxJournalEntries","maxJournalBytes"]))fail("Provider handoff source binding is invalid.");
  const capture=value.capture,l=root.bridge.limits;if(!match(capture.keyId,/^[A-Za-z0-9_-]{1,100}$/u)||!match(capture.keySha256,DIGEST)||capture.maxTransactionBytes!==l.maxCaptureTransactionBytes||capture.maxStateBytes!==l.maxCaptureStateBytes||capture.maxJournalEntries!==l.maxJournalEntries||capture.maxJournalBytes!==l.maxJournalBytes)fail("Provider handoff capture limits cannot be rebound.");
  return {protocol:value.protocol,enablementId:value.enablementId,indexId:value.indexId,catalogId:value.catalogId,domainSha256:value.domainSha256,projectId:value.projectId,releaseId:value.releaseId,generation:value.generation,capsuleSha256:value.capsuleSha256,sourceIncarnation:value.sourceIncarnation,grantId:value.grantId,role:"web",instance:0,imageId:value.imageId,uid:value.uid,gid:value.gid,capture:{keyId:capture.keyId,keySha256:capture.keySha256,maxTransactionBytes:capture.maxTransactionBytes,maxStateBytes:capture.maxStateBytes,maxJournalEntries:capture.maxJournalEntries,maxJournalBytes:capture.maxJournalBytes}};
}
function bridgeRecords(db:any):{grant:Row|null;transfer:Row|null;operations:Row[];spools:Row[]}{
  const grants=db.prepare("SELECT * FROM clank_provider_handoff_source_grant LIMIT 2").all(),transfers=db.prepare("SELECT * FROM clank_provider_handoff_source_transfer LIMIT 2").all();if(grants.length>1||transfers.length>1)fail();
  return {grant:grants[0]?{...grants[0]}:null,transfer:transfers[0]?{...transfers[0]}:null,operations:db.prepare("SELECT * FROM clank_provider_handoff_source_operations ORDER BY sequence LIMIT 257").all().map((r:Row)=>({...r})),spools:db.prepare("SELECT * FROM clank_provider_handoff_source_spools ORDER BY kind LIMIT 3").all().map((r:Row)=>({...r}))};
}
function bridgeCatalog(c:Context,db:any,root:Row,project:Row,reservations:Row[]):Row {
  const row=singleton(db,"clank_provider_handoff_bridge_state"),records=bridgeRecords(db),grant=records.grant;
  if(row.id!==1||row.protocol!==2||row.enablement_id!==root.bridge.enablement_id||!positive(row.version)||!match(row.records_sha256,DIGEST)||records.operations.length>root.bridge.limits.maxOperations||records.spools.length>2||c.hash(boundedJSON(records,BRIDGE_CATALOG_MAX))!==row.records_sha256)fail("Provider handoff catalog mirror is invalid.");
  // This foundation has no control/readiness/publication transition. Future rows
  // require their owning partition's complete semantic validation, never adoption.
  if(records.transfer||records.operations.length||records.spools.length)fail("Provider handoff source control records are unsupported by this foundation.");
  if(grant){let binding;try{binding=grantBinding(JSON.parse(grant.binding_json),root,project);}catch{fail("Provider handoff source binding is invalid.");}
    const observed=grant.state==="created"||grant.state==="started"||grant.state==="revoked"&&grant.container_id!==null,minimum=grant.state==="started"||grant.state==="revoked"&&observed?4:observed?3:2;
    if(row.version<minimum||grant.id!==1||grant.protocol!==2||grant.grant_id!==binding.grantId||boundedJSON(binding,4096)!==grant.binding_json||c.hash(grant.binding_json)!==grant.binding_sha256||!match(grant.grant_secret_sha256,DIGEST)||!match(grant.control_secret_sha256,DIGEST)||!["issued","created","started","revoked","stopped"].includes(grant.state)||(observed?!match(grant.container_id,DIGEST):grant.container_id!==null)||grant.readiness_json!==null||grant.readiness_sha256!==null)fail("Provider handoff source grant state is unsupported.");
  }else if(reservations.some(r=>r.catalog_id===project.catalog_id))fail("Provider handoff reservation has no retained grant.");
  return {version:row.version,...records};
}
/** Private bootstrap reader. It never admits a request or writes provider state. */
export async function openProviderSourceReader(encoded:string){
  if(typeof encoded!=="string"||new TextEncoder().encode(encoded).length>16384)fail("Invalid source bootstrap.");
  const input=JSON.parse(encoded);if(JSON.stringify(input)!==encoded)fail("Source bootstrap must use canonical JSON.");encoded="";
  const fields=["protocol","binding","bindingSha256","containerId","catalogPath","grantSecret","controlSecret","recoveryKey"],remote=input.protocol==="clank-provider-source-bootstrap/2";
  if(!exact(input,remote?[...fields,"workerChannel"]:fields)||!remote&&input.protocol!=="clank-provider-source-bootstrap/1"||input.catalogPath!=="/run/clank-source/catalog.sqlite"||!match(input.bindingSha256,DIGEST)||!match(input.containerId,DIGEST))fail("Invalid source bootstrap.");
  const fsName="node:fs",pathName="node:path",sqliteName="node:sqlite",cryptoName="node:crypto";
  const [fs,path,{DatabaseSync},crypto]=await Promise.all([import(fsName),import(pathName),import(sqliteName),import(cryptoName)]);
  const process=(globalThis as any).process,Buffer=(globalThis as any).Buffer,secrets:Uint8Array[]=[];
  const hash=(value:string|Uint8Array)=>crypto.createHash("sha256").update(value).digest("hex");
  const c={fs,path,Database:DatabaseSync,hash,pins:[],marked:true} as unknown as Context;
  let closed=false,version=0,recorded="",worker:Awaited<ReturnType<typeof import("./provider-source-worker-wire.ts").openSourceWorkerSocketClient>>|undefined;
  const close=()=>{if(closed)return;closed=true;try{worker?.close();}finally{for(const key of secrets)key.fill(0);releasePins(c,0);}};
  try{
    if(process.platform!=="linux"||!process.getuid?.()||!process.getgid?.())fail("Source bootstrap requires its fixed native non-root user.");
    for(const name of ["grantSecret","controlSecret","recoveryKey"]){const text=input[name];if(!match(text,/^[A-Za-z0-9_-]{43}$/u))fail("Invalid source bootstrap key.");const key=Buffer.from(text,"base64url");secrets.push(key);delete input[name];if(key.length!==32||key.toString("base64url")!==text)fail("Invalid source bootstrap key.");}
    const value=input.binding,capture=value?.capture;
    if(!exact(value,["protocol","enablementId","indexId","catalogId","domainSha256","projectId","releaseId","generation","capsuleSha256","sourceIncarnation","grantId","role","instance","imageId","uid","gid","capture"])||![value.enablementId,value.indexId,value.catalogId].every(v=>match(v,UUID))||!match(value.domainSha256,DIGEST)||!match(value.projectId,ID)||value.uid!==process.getuid()||value.gid!==process.getgid()||!exact(capture,["keyId","keySha256","maxTransactionBytes","maxStateBytes","maxJournalEntries","maxJournalBytes"]))fail("Invalid source bootstrap identity.");
    const maxima=[8388608,134217728,100000,1073741824],names=["maxTransactionBytes","maxStateBytes","maxJournalEntries","maxJournalBytes"];
    for(let i=0;i<names.length;i++){const n=capture[names[i]];if(!positive(n)||n>maxima[i]||n<(i===2?1:1024))fail("Invalid source capture capacity.");}
    const root={index_id:value.indexId,domain_sha256:value.domainSha256,bridge:{enablement_id:value.enablementId,limits:{maxCaptureTransactionBytes:capture.maxTransactionBytes,maxCaptureStateBytes:capture.maxStateBytes,maxJournalEntries:capture.maxJournalEntries,maxJournalBytes:capture.maxJournalBytes}}};
    const binding=freezeValue(grantBinding(value,root,{catalog_id:value.catalogId,project_id:value.projectId})),json=boundedJSON(binding,4096);
    if(json!==JSON.stringify(value)||hash(json)!==input.bindingSha256||hash(secrets[2])!==binding.capture.keySha256)fail("Source bootstrap binding or key mismatch.");
    const parent=pin(c,"/run/clank-source",true),file=pin(c,input.catalogPath,false,BRIDGE_CATALOG_MAX);
    const current=()=>{
      if(closed)fail("Source bootstrap reader is closed.");
      for(const p of c.pins){assertPin(c,p);if(fs.fstatSync(p.fd).gid!==binding.gid||fs.lstatSync(p.path).gid!==binding.gid)fail("Source catalog group changed.");}
      if(fs.realpathSync(parent.path)!==parent.path||fs.realpathSync(file.path)!==file.path||entries(c,parent,2).some(name=>name!=="catalog.sqlite"))fail("Source catalog namespace changed.");
    };
    const checkCurrent=()=>{
      current();let db:any;
      try{
        db=new DatabaseSync(`${parent.anchor}/catalog.sqlite`,{readOnly:true});
        // Before first WAL access, EXCLUSIVE uses no shared-memory sidecar.
        // Unknown or locked WAL still refuses; never checkpoint or retry writable.
        db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");
        if(db.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")fail("Source catalog requires DELETE journal mode.");
        db.exec("BEGIN");strictSchema(c,db,BRIDGE_CATALOG);
        const meta=singleton(db,"clank_provider_handoff_catalog"),state=singleton(db,"clank_provider_handoff_bridge_state"),records=bridgeRecords(db),grant=records.grant;
        if(meta.id!==1||meta.protocol!==1||meta.index_id!==binding.indexId||meta.catalog_id!==binding.catalogId||meta.project_id!==binding.projectId||meta.domain_sha256!==binding.domainSha256||meta.barrier_sha256!==null||db.prepare("SELECT 1 FROM clank_provider_handoff_barrier LIMIT 1").get())fail("Source catalog identity or barrier refuses initialization.");
        const mirror=hash(boundedJSON(records,BRIDGE_CATALOG_MAX));
        if(state.id!==1||state.protocol!==2||state.enablement_id!==binding.enablementId||!positive(state.version)||state.version<3||state.records_sha256!==mirror||state.version<version||state.version===version&&mirror!==recorded)fail("Source catalog mirror or version changed.");
        // Later readiness/control states require their owning transition validator.
        if(records.transfer||records.operations.length||records.spools.length||!grant||grant.id!==1||grant.protocol!==2||grant.grant_id!==binding.grantId||grant.binding_json!==json||grant.binding_sha256!==input.bindingSha256||grant.grant_secret_sha256!==hash(secrets[0])||grant.control_secret_sha256!==hash(secrets[1])||!["created","started"].includes(grant.state)||state.version!==({created:3,started:4} as Row)[grant.state]||grant.container_id!==input.containerId||grant.readiness_json!==null||grant.readiness_sha256!==null)fail("Source grant does not permit bootstrap initialization.");
        db.exec("COMMIT");current();version=state.version;recorded=mirror;
      }finally{db?.close();}
      current();worker?.assertCurrent();
    };
    const assertCurrent=()=>{
      try{checkCurrent();}catch(error){
        // A failed native authority check cannot be revived by restoring rows.
        try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Source bootstrap authority failed and cleanup did not settle.");}
        throw error;
      }
    };
    assertCurrent();
    if(remote){
      const channel=input.workerChannel;
      if(!exact(channel,["bindingSha256","containerId","sourceIncarnation","channelId"])||channel.bindingSha256!==input.bindingSha256||channel.containerId!==input.containerId||channel.sourceIncarnation!==binding.sourceIncarnation)fail("Source worker channel differs from its original bootstrap.");
      const wire=await import("./provider-source-worker-wire.ts");assertCurrent();
      worker=await wire.openSourceWorkerSocketClient(secrets[1],channel as import("./provider-source-worker-wire.ts").SourceWorkerChannelBinding,binding.uid,binding.gid);assertCurrent();
    }
    return Object.freeze({binding,key:secrets[2],assertCurrent,close,worker});
  }catch(error){close();throw error;}
}
function bridgeCurrent(bridge:ProviderHandoffBridge,live=false):BridgeContext&{context:Context}{
  const registered=bridges.get(bridge);if(!registered)fail("A genuine private provider bridge is required.");const c=current(registered.owner);
  if(!["bridge-live","cleanup-only"].includes(c.mode)||live&&c.mode!=="bridge-live")fail("A current live provider bridge is required.");return {...registered,context:c};
}
function freezeValue<Value>(value:Value):Value{if(value&&typeof value==="object"){for(const child of Object.values(value))freezeValue(child);Object.freeze(value);}return value;}
function fail(message="Provider handoff state is unavailable."):never {throw new Error(message);}
function code(error:unknown):unknown{return (error as {code?:unknown})?.code;}
function exact(value:unknown,keys:readonly string[]):value is Row{return !!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function match(value:unknown,pattern:RegExp):value is string{return typeof value==="string"&&pattern.test(value);}
function positive(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>0;}
function boundedJSON(value:unknown,maximum:number):string {const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>maximum)fail();return text;}
function singleton(database:any,table:string):Row {const rows=database.prepare(`SELECT * FROM ${table} LIMIT 2`).all();if(rows.length!==1)fail();return rows[0];}
function current(owner:ProviderServiceOwnership,preAdmission=false):Context {
  const c=owners.get(owner);if(!c||c.closed||c.failed||!c.database.isTransaction||preAdmission&&c.mode!=="pre-admission")fail("A current pre-admission native provider owner is required.");
  for(const pin of c.pins)assertPin(c,pin);return c;
}
function privateStat(c:Context,stat:any,directory:boolean,maximum:number,normalize=false):void {
  if((directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)||stat.isSymbolicLink()||stat.uid!==(globalThis as any).process.getuid?.()||!normalize&&(stat.mode&0o077)!==0||c.marked&&(stat.mode&0o777)!==(directory?0o700:0o600)||!directory&&stat.size>maximum)fail("Provider service ownership must use private bounded native SQLite files.");
}
function assertPin(c:Context,pin:Pin):void {const retained=c.fs.fstatSync(pin.fd),visible=c.fs.lstatSync(pin.path);privateStat(c,retained,pin.directory,pin.maximum,pin.normalize);privateStat(c,visible,pin.directory,pin.maximum,pin.normalize);if(retained.dev!==pin.dev||retained.ino!==pin.ino||visible.dev!==pin.dev||visible.ino!==pin.ino)fail("Provider handoff file identity changed.");}
function pin(c:Context,path:string,directory:boolean,maximum=0,normalize=false):Pin {
  const before=c.fs.lstatSync(path);privateStat(c,before,directory,maximum,normalize);
  const fd=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_NOFOLLOW|(directory?c.fs.constants.O_DIRECTORY:c.fs.constants.O_NONBLOCK));
  const result={fd,path,anchor:(globalThis as any).process.platform==="linux"?`/proc/self/fd/${fd}`:path,dev:before.dev,ino:before.ino,directory,maximum,normalize};
  try {assertPin(c,result);c.pins.push(result);return result;}catch(error){c.fs.closeSync(fd);throw error;}
}
function releasePins(c:Context,from:number):void {
  let failed=false,failure:unknown;
  for(const p of c.pins.splice(from).reverse())try{c.fs.closeSync(p.fd);}catch(error){if(!failed){failed=true;failure=error;}}
  if(failed)throw failure;
}
function absent(c:Context,path:string):boolean {try{c.fs.lstatSync(path);return false;}catch(error){if(code(error)==="ENOENT")return true;throw error;}}
function directory(c:Context,parent:Pin,name:string,create=false):Pin {
  assertPin(c,parent);const path=c.path.join(parent.path,name),anchor=`${parent.anchor}/${name}`;
  if(create)c.fs.mkdirSync(anchor,{mode:0o700});
  // No JavaScript callback/await between exclusive creation and retained inode.
  return pin(c,path,true);
}
function entries(c:Context,parent:Pin,maximum:number):string[]{
  assertPin(c,parent);const dir=c.fs.opendirSync(parent.anchor),names:string[]=[];
  try{let entry;while((entry=dir.readSync())!==null){if(names.length===maximum)fail("Provider handoff directory capacity exceeded.");names.push(entry.name);}}finally{dir.closeSync();}return names.sort();
}
function schemaSignature(database:any,limit:number):string {
  const objects=database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name LIMIT ${limit+1}`).all();if(objects.length>limit)fail("Provider handoff schema is unsupported.");
  if(objects.some((row:Row)=>typeof row.name!=="string"||!/^[A-Za-z0-9_]+$/u.test(row.name)))fail();
  return JSON.stringify(objects.map((row:Row)=>({row,columns:row.type==="table"?database.prepare(`PRAGMA table_xinfo(${JSON.stringify(row.name)})`).all():[],foreign:row.type==="table"?database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(row.name)})`).all():[],indexes:row.type==="table"?database.prepare(`PRAGMA index_list(${JSON.stringify(row.name)})`).all():[],indexed:row.type==="index"?database.prepare(`PRAGMA index_xinfo(${JSON.stringify(row.name)})`).all():[]})));
}
function strictSchema(c:Context,database:any,sqls:readonly string[]):void {
  const key=sqls.join(";");let expected=schemaCache.get(key);
  if(!expected){const sample=new c.Database(":memory:");try{sample.exec(key);expected=schemaSignature(sample,64);schemaCache.set(key,expected);}finally{sample.close();}}
  if(schemaSignature(database,JSON.parse(expected).length)!==expected)fail("Provider handoff schema is unsupported.");
}
function domainValue(value:unknown):ProviderHandoffDomain {
  if(!exact(value,["protocol","nodeId","daemonId","owner"])||value.protocol!=="clank-provider-handoff-domain/1"||!match(value.nodeId,ID)||!match(value.daemonId,DAEMON)||!match(value.owner,OWNER))fail("Provider handoff domain is invalid.");
  return Object.freeze({protocol:"clank-provider-handoff-domain/1",nodeId:value.nodeId,daemonId:value.daemonId,owner:value.owner});
}
function marker(c:Context):Row|null {
  const present=c.database.prepare("SELECT type FROM sqlite_schema WHERE name='clank_provider_handoff_owner'").get();
  if(!present){const objects=c.database.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();if(objects.length!==1||objects[0].name!=="clank_provider_service_owner"||objects[0].type!=="table"||singleton(c.database,"clank_provider_service_owner").protocol!==1)fail("Provider service ownership protocol is unsupported.");return null;}
  const bridgePresent=!!c.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_provider_handoff_bridge_owner'").get();strictSchema(c,c.database,bridgePresent?[OWNER_SQL,MARKER_SQL,BRIDGE_OWNER_SQL]:[OWNER_SQL,MARKER_SQL]);const row=singleton(c.database,"clank_provider_handoff_owner"),legacy=singleton(c.database,"clank_provider_service_owner");
  if(!exact(legacy,["protocol"])||legacy.protocol!==1||row.id!==1||row.protocol!==1||!match(row.index_id,UUID)||!match(row.domain_sha256,DIGEST)||typeof row.domain_json!=="string")fail();
  let domain:ProviderHandoffDomain;try{domain=domainValue(JSON.parse(row.domain_json));}catch{fail();}
  if(boundedJSON(domain,4096)!==row.domain_json||c.hash(row.domain_json)!==row.domain_sha256)fail();c.marked=true;for(const p of c.pins)assertPin(c,p);return {...row,domain,...(bridgePresent?{bridge:bridgeOwner(c,row)}:{})};
}
function sidecars(c:Context,parent:Pin,name:string,maximum:number,allowWAL=false):void {
  for(const suffix of ["-journal","-wal","-shm"]){const path=c.path.join(parent.path,name+suffix);if(absent(c,path))continue;if(suffix!=="-journal"&&!allowWAL)fail("Provider handoff WAL sidecars are unsupported.");const stat=c.fs.lstatSync(path);privateStat(c,stat,false,maximum);}
}
function databaseAt<Value>(c:Context,parent:Pin,name:string,maximum:number,write:boolean,action:(database:any,file:Pin)=>Value):Value {
  const from=c.pins.length;assertPin(c,parent);sidecars(c,parent,name,maximum*2);let database:any;
  try {const file=pin(c,c.path.join(parent.path,name),false,maximum);database=new c.Database(`${parent.anchor}/${name}`,{readOnly:!write});database.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");if(database.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")fail("Provider handoff journal mode is unsupported.");
    if(write){database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");const page=database.prepare("PRAGMA page_size").get()?.page_size;if(!positive(page)||page>maximum)fail();database.exec(`PRAGMA max_page_count=${Math.floor(maximum/page)}`);}
    const result=action(database,file);assertPin(c,file);return result;
  }finally{database?.close();releasePins(c,from);}
}
function sync(c:Context,file:Pin,parent:Pin):void {assertPin(c,file);assertPin(c,parent);c.fs.fsyncSync(file.fd);c.fs.fsyncSync(parent.fd);assertPin(c,file);assertPin(c,parent);}
function createDatabase(c:Context,parent:Pin,name:string,maximum:number,sqls:readonly string[],seed:(database:any)=>void):void {
  assertPin(c,parent);const filename=`${parent.anchor}/${name}`,fd=c.fs.openSync(filename,c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_RDWR|c.fs.constants.O_NOFOLLOW,0o600);c.fs.closeSync(fd);
  databaseAt(c,parent,name,maximum,true,(database,file)=>{database.exec("BEGIN IMMEDIATE");try{database.exec(sqls.join(";"));seed(database);strictSchema(c,database,sqls);database.exec("COMMIT");sync(c,file,parent);}catch(error){if(database.isTransaction)database.exec("ROLLBACK");throw error;}});
}
/** Acquire the same durable owner used by ordinary services; never return its native connection. */
export async function acquireProviderServiceOwnership(rootDirectory:string,createRoot=false):Promise<ProviderServiceOwnership> {
  const fsName="node:fs",promisesName="node:fs/promises",pathName="node:path",sqliteName="node:sqlite",cryptoName="node:crypto";
  const [fs,promises,path,{DatabaseSync},nativeCrypto]=await Promise.all([import(fsName),import(promisesName),import(pathName),import(sqliteName),import(cryptoName)]);
  if(typeof rootDirectory!=="string"||!rootDirectory.trim()||rootDirectory.includes("\0"))throw new TypeError("rootDirectory is required.");
  const c:Context={fs,path,Database:DatabaseSync,hash:text=>nativeCrypto.createHash("sha256").update(text).digest("hex"),randomUUID:nativeCrypto.randomUUID,root:null as any,service:null as any,file:null as any,database:null,pins:[],closed:false,admitted:false,mode:"pre-admission",marked:false,failed:false,queued:0,tail:Promise.resolve()};
  try {
    const requested=path.resolve(rootDirectory);if(createRoot)fs.mkdirSync(requested,{recursive:true,mode:0o700});
    const rootStat=fs.lstatSync(requested);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||rootStat.uid!==(globalThis as any).process.getuid?.())fail("rootDirectory must be a private owner-controlled directory.");
    c.root=pin(c,fs.realpathSync(requested),true,0,createRoot);let service=path.join(c.root.path,"service");if(absent(c,service)){if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.mkdirSync(`${c.root.anchor}/service`,{mode:0o700});}else{const stat=fs.lstatSync(service);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.uid!==(globalThis as any).process.getuid?.())fail("provider service directory must be an owner-controlled real directory.");}
    c.service=pin(c,service,true,0,true);const filename=path.join(service,".writer.sqlite"),missing=absent(c,filename),normalize=(rootStat.mode&0o777)!==0o700||(fs.fstatSync(c.service.fd).mode&0o777)!==0o700;
    if(missing){inspect(c,null);if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.fchmodSync(c.service.fd,0o700);const fd=fs.openSync(`${c.service.anchor}/.writer.sqlite`,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);fs.fsyncSync(c.service.fd);}
    sidecars(c,c.service,".writer.sqlite",OWNER_MAX,true);c.file=pin(c,filename,false,OWNER_MAX);
    if(normalize&&!missing){
      // Plain readOnly can create WAL/SHM. EXCLUSIVE before first access avoids that;
      // native refusal is uncertainty, never permission to retry writable/immutable.
      c.database=new DatabaseSync(`${c.service.anchor}/.writer.sqlite`,{readOnly:true});
      try{c.database.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");if(c.database.prepare("SELECT name FROM sqlite_schema LIMIT 1").all().length!==0)marker(c);inspect(c,null);}finally{c.database.close();c.database=null;}
    }
    c.database=new DatabaseSync(`${c.service.anchor}/.writer.sqlite`);
    c.database.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    if(c.database.prepare("SELECT name FROM sqlite_schema LIMIT 1").all().length===0)c.database.exec(OWNER_SQL+"; INSERT INTO clank_provider_service_owner VALUES(1)");
    marker(c);if(!c.marked){if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.fchmodSync(c.service.fd,0o700);}c.root.normalize=false;c.service.normalize=false;for(const p of c.pins)assertPin(c,p);
    c.database.exec("COMMIT; BEGIN IMMEDIATE");sync(c,c.file,c.service);
    const owner:ProviderServiceOwnership=Object.freeze({fs:promises,path,root:c.root.path,serviceDirectory:service,close(){
      if(c.closed)return;c.closed=true;c.mode="closed";const failures:unknown[]=[];
      try{closeWorkerChannels(owner);}catch(error){failures.push(error);}
      try{closeSourceLeases(owner);}catch(error){failures.push(error);}
      try{closeSourceLaunchData(owner);}catch(error){failures.push(error);}
      try{c.database.close();}catch(error){failures.push(error);}
      try{releasePins(c,0);}catch(error){failures.push(error);}
      if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Provider service ownership failed to close cleanly.");
    }});owners.set(owner,c);return owner;
  }catch(error){try{c.database?.close();}finally{releasePins(c,0);}if(typeof (error as any)?.errcode==="number"&&((error as any).errcode&255)===5)throw new Error("Provider service root already has an active writer.");throw error;}
}
function identity(input:unknown):Row {
  if(!exact(input,["handoffId","source","targetNodeId","targetGeneration","artifactSha256"])||!match(input.handoffId,ID)||!exact(input.source,["projectId","nodeId","releaseId","generation"])||![input.source.projectId,input.source.nodeId,input.source.releaseId,input.targetNodeId].every(value=>match(value,ID))||!positive(input.source.generation)||!positive(input.targetGeneration)||input.targetGeneration<=input.source.generation||input.targetNodeId===input.source.nodeId||!match(input.artifactSha256,DIGEST))fail("Provider handoff identity is invalid.");
  return {handoffId:input.handoffId,source:{projectId:input.source.projectId,nodeId:input.source.nodeId,releaseId:input.source.releaseId,generation:input.source.generation},targetNodeId:input.targetNodeId,targetGeneration:input.targetGeneration,artifactSha256:input.artifactSha256};
}
function catalog(c:Context,db:any,root:Row,project:Row):{metadata:Row;barrier:Row|null} {
  strictSchema(c,db,root.bridge?BRIDGE_CATALOG:[CATALOG_SQL,BARRIER_SQL]);const row=singleton(db,"clank_provider_handoff_catalog");
  if(row.id!==1||row.protocol!==1||row.index_id!==root.index_id||row.catalog_id!==project.catalog_id||row.project_id!==project.project_id||row.domain_sha256!==root.domain_sha256)fail();
  const rows=db.prepare("SELECT * FROM clank_provider_handoff_barrier LIMIT 2").all();if(rows.length===0){if(row.barrier_sha256!==null)fail();return {metadata:row,barrier:null};}if(rows.length!==1)fail();const b=rows[0];let id:Row;try{id=identity(JSON.parse(b.identity_json));}catch{fail();}
  if(b.id!==1||b.protocol!==1||b.version!==1||!match(b.step_id,ID)||!match(b.source_capsule_sha256,DIGEST)||!match(b.source_incarnation,UUID)||!match(b.input_sha256,DIGEST)||b.handoff_id!==id.handoffId||id.source.projectId!==project.project_id||id.source.nodeId!==root.domain.nodeId||boundedJSON(id,2048)!==b.identity_json||row.barrier_sha256!==b.input_sha256)fail();
  const envelope=barrierEnvelope(root,project,{identity:id as any,stepId:b.step_id,sourceCapsuleSha256:b.source_capsule_sha256,sourceIncarnation:b.source_incarnation});if(c.hash(boundedJSON(envelope,8192))!==b.input_sha256)fail();return {metadata:row,barrier:b};
}
function index(c:Context,db:any,root:Row):Row[] {
  strictSchema(c,db,root.bridge?BRIDGE_INDEX:[INDEX_SQL,PROJECTS_SQL]);const row=singleton(db,"clank_provider_handoff_index");if(row.id!==1||row.protocol!==1||row.index_id!==root.index_id||row.domain_sha256!==root.domain_sha256)fail();
  const rows=db.prepare("SELECT * FROM clank_provider_handoff_projects ORDER BY project_id LIMIT 101").all();if(rows.length>100)fail("Provider handoff project capacity exceeded.");const ids=new Set();for(const project of rows){if(!match(project.project_id,ID)||!match(project.catalog_id,UUID)||ids.has(project.catalog_id)||project.installation!=="ready")fail("Provider handoff catalog installation is incomplete.");ids.add(project.catalog_id);}return rows;
}
function inspect(c:Context,root:Row|null):{barriers:number;projects:Row[];grants:number;reservations:Row[];states:Row[]} {
  if(root?.bridge&&root.bridge.phase!=="ready")fail("Provider handoff bridge installation is incomplete.");
  const target=c.path.join(c.service.path,"handoff");if(!root){if(!absent(c,target))fail("Provider handoff namespace exists without its owner marker.");return {barriers:0,projects:[],grants:0,reservations:[],states:[]};}
  const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff"),names=entries(c,handoff,4);if(names.some(name=>!["index.sqlite","index.sqlite-journal","catalogs"].includes(name))||!names.includes("catalogs")||!names.includes("index.sqlite"))fail();const catalogs=directory(c,handoff,"catalogs");
    let reservations:Row[]=[];const projects=databaseAt(c,handoff,"index.sqlite",INDEX_MAX,false,db=>{const rows=index(c,db,root);if(root.bridge)reservations=bridgeIndex(c,db,root,rows);return rows;});const actual=entries(c,catalogs,101);if(JSON.stringify(actual)!==JSON.stringify(projects.map(row=>row.catalog_id).sort()))fail();let barriers=0,grants=0;const states:Row[]=[];
    for(const project of projects){const before=c.pins.length;try{const dir=directory(c,catalogs,project.catalog_id);if(entries(c,dir,3).some(name=>!["catalog.sqlite","catalog.sqlite-journal"].includes(name)))fail();const result=databaseAt(c,dir,"catalog.sqlite",root.bridge?BRIDGE_CATALOG_MAX:CATALOG_MAX,false,db=>{const legacy=catalog(c,db,root,project);if(root.bridge){const state=bridgeCatalog(c,db,root,project,reservations);if(state.grant)grants++;states.push({projectId:project.project_id,catalogId:project.catalog_id,...state});}return legacy;});if(result.barrier)barriers++;}finally{releasePins(c,before);}}
    return {barriers,projects,grants,reservations,states};
  }finally{releasePins(c,from);}
}
async function probe(owner:ProviderServiceOwnership,client:DockerClient,nodeId:string,ownerLabel:string,bridge=false):Promise<ProviderHandoffDomain>{
  current(owner,!bridge);if(!match(nodeId,ID)||!match(ownerLabel,OWNER))fail("Provider handoff domain identity is invalid.");
  const result=await runProviderDockerClient(client,["info","--format","{{json .ID}}"],{timeoutMs:15000,maxOutputBytes:4096});current(owner,!bridge);
  const output=result.stdout.endsWith("\n")?result.stdout.slice(0,-1):result.stdout;let daemonId:unknown;try{daemonId=JSON.parse(output);}catch{fail("Native Docker daemon identity is unavailable.");}
  if(typeof daemonId!=="string"||JSON.stringify(daemonId)!==output||!match(daemonId,DAEMON))fail("Native Docker daemon identity is unavailable.");return domainValue({protocol:"clank-provider-handoff-domain/1",nodeId,daemonId,owner:ownerLabel});
}
export async function createProviderHandoffDomain(owner:ProviderServiceOwnership,client:DockerClient,nodeId:string,ownerLabel:string):Promise<ProviderHandoffDomain>{
  const value=await probe(owner,client,nodeId,ownerLabel);current(owner,true);domains.set(value,{owner,client});return value;
}
async function verifyDomain(owner:ProviderServiceOwnership,value:ProviderHandoffDomain,bridge=false):Promise<void>{const registered=domains.get(value);if(!registered||registered.owner!==owner)fail("A genuine owner-bound Docker domain is required.");const observed=await probe(owner,registered.client,value.nodeId,value.owner,bridge);if(boundedJSON(observed,4096)!==boundedJSON(value,4096))fail("Provider handoff Docker execution domain changed.");}
async function exclusive<Value>(owner:ProviderServiceOwnership,task:()=>Promise<Value>,bridge?:ProviderHandoffBridge):Promise<Value>{const c=current(owner,!bridge);if(bridge)bridgeCurrent(bridge);if(c.queued>=16)fail("Provider handoff private operation capacity exceeded.");c.queued++;const previous=c.tail;let release!:()=>void;c.tail=new Promise(resolve=>{release=resolve;});try{await previous;current(owner,!bridge);if(bridge)bridgeCurrent(bridge);const result=await task();current(owner);const retained=marker(c),state=inspect(c,retained);if(c.admitted&&(state.barriers||state.grants))fail("Provider handoff barrier refuses ordinary root startup.");current(owner);return result;}catch(error){if(c.mode==="bridge-live")c.mode="cleanup-only";c.failed=true;throw error;}finally{c.queued--;release();}}
/** Ordinary startup has no install path. Structural adapters cannot prove a retained domain. */
export async function admitProviderService(owner:ProviderServiceOwnership,client?:DockerClient,ownerLabel?:string):Promise<void>{
  return exclusive(owner,async()=>{const c=current(owner,true),root=marker(c);inspect(c,root);if(root){if(!client||typeof ownerLabel!=="string"||ownerLabel!==root.domain.owner)fail("Provider handoff requires the original native Docker domain.");const observed=await probe(owner,client,root.domain.nodeId,ownerLabel);if(boundedJSON(observed,4096)!==root.domain_json)fail("Provider handoff Docker execution domain changed.");current(owner,true);const fresh=marker(c);if(!fresh||fresh.domain_sha256!==root.domain_sha256||fresh.index_id!==root.index_id||(inspect(c,fresh).barriers!==0||inspect(c,fresh).grants!==0))fail("Provider handoff barrier refuses ordinary root startup.");}current(owner,true);c.admitted=true;c.mode="ordinary-admitted";});
}
export async function initializeProviderHandoff(owner:ProviderServiceOwnership,domain:ProviderHandoffDomain):Promise<Readonly<{indexId:string;domainSha256:string}>>{
  return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true);let root=marker(c);if(root?.bridge)fail("Provider handoff bridge requires its private owner mode.");if(root){if(root.domain_json!==boundedJSON(domain,4096))fail("Provider handoff domain cannot be rebound.");inspect(c,root);}else{
      inspect(c,null);strictSchema(c,c.database,[OWNER_SQL]);const id=c.randomUUID(),json=boundedJSON(domain,4096),hash=c.hash(json);c.database.exec(MARKER_SQL);const result=c.database.prepare("INSERT INTO clank_provider_handoff_owner VALUES(1,1,?,?,?)").run(id,json,hash);if(result.changes!==1)fail();root=marker(c);if(root?.index_id!==id||root.domain_json!==json)fail();current(owner,true);c.database.exec("COMMIT; BEGIN IMMEDIATE");sync(c,c.file,c.service);
      const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff",true),catalogs=directory(c,handoff,"catalogs",true);createDatabase(c,handoff,"index.sqlite",INDEX_MAX,[INDEX_SQL,PROJECTS_SQL],db=>{const result=db.prepare("INSERT INTO clank_provider_handoff_index VALUES(1,1,?,?)").run(id,hash);if(result.changes!==1)fail();});c.fs.fsyncSync(catalogs.fd);c.fs.fsyncSync(handoff.fd);c.fs.fsyncSync(c.service.fd);}finally{releasePins(c,from);}inspect(c,root);
    }
    await verifyDomain(owner,domain);current(owner,true);return Object.freeze({indexId:root!.index_id,domainSha256:root!.domain_sha256});});
}
function barrierEnvelope(root:Row,project:Row,input:ProviderHandoffBarrierInput):Row{return {protocol:"clank-provider-handoff-barrier/1",indexId:root.index_id,catalogId:project.catalog_id,projectId:project.project_id,domainSha256:root.domain_sha256,identity:identity(input.identity),stepId:input.stepId,sourceCapsuleSha256:input.sourceCapsuleSha256,sourceIncarnation:input.sourceIncarnation};}
export async function installProviderHandoffProject(owner:ProviderServiceOwnership,domain:ProviderHandoffDomain,projectId:string):Promise<Readonly<{projectId:string;catalogId:string}>>{
  if(!match(projectId,ID))fail("Provider handoff project identity is invalid.");return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true),root=marker(c);if(!root||root.domain_json!==boundedJSON(domain,4096))fail();if(root.bridge)fail("Provider handoff bridge roster is immutable.");const state=inspect(c,root),existing=state.projects.find(row=>row.project_id===projectId);if(existing)return Object.freeze({projectId,catalogId:existing.catalog_id});if(state.projects.length===100)fail("Provider handoff project capacity exceeded.");
    const from=c.pins.length,id=c.randomUUID();try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{index(c,db,root);if(db.prepare("INSERT INTO clank_provider_handoff_projects VALUES(?,?,'reserved')").run(projectId,id).changes!==1)fail();const row=db.prepare("SELECT * FROM clank_provider_handoff_projects WHERE project_id=?").get(projectId);if(row?.catalog_id!==id||row.installation!=="reserved")fail();current(owner,true);db.exec("COMMIT");sync(c,file,handoff);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
      const target=directory(c,catalogs,id,true);createDatabase(c,target,"catalog.sqlite",CATALOG_MAX,[CATALOG_SQL,BARRIER_SQL],db=>{if(db.prepare("INSERT INTO clank_provider_handoff_catalog VALUES(1,1,?,?,?,?,NULL)").run(root.index_id,id,projectId,root.domain_sha256).changes!==1)fail();catalog(c,db,root,{project_id:projectId,catalog_id:id});});c.fs.fsyncSync(catalogs.fd);
      databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{strictSchema(c,db,[INDEX_SQL,PROJECTS_SQL]);if(db.prepare("UPDATE clank_provider_handoff_projects SET installation='ready' WHERE project_id=? AND catalog_id=? AND installation='reserved'").run(projectId,id).changes!==1)fail();index(c,db,root);current(owner,true);db.exec("COMMIT");sync(c,file,handoff);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    }finally{releasePins(c,from);}inspect(c,root);await verifyDomain(owner,domain);current(owner,true);return Object.freeze({projectId,catalogId:id});});
}
export async function insertProviderHandoffBarrier(owner:ProviderServiceOwnership,domain:ProviderHandoffDomain,projectId:string,input:ProviderHandoffBarrierInput):Promise<Readonly<{inputSha256:string}>>{
  if(!match(projectId,ID)||!exact(input,["identity","stepId","sourceCapsuleSha256","sourceIncarnation"])||!match(input.stepId,ID)||!match(input.sourceCapsuleSha256,DIGEST)||!match(input.sourceIncarnation,UUID))fail("Provider handoff barrier is invalid.");
  const captured=JSON.parse(boundedJSON(input,8192)) as ProviderHandoffBarrierInput;identity(captured.identity);
  return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true),root=marker(c);if(!root||root.domain_json!==boundedJSON(domain,4096))fail();if(root.bridge)fail("Provider handoff bridge barriers require a reviewed control transition.");const project=inspect(c,root).projects.find(row=>row.project_id===projectId);if(!project)fail();const envelope=barrierEnvelope(root,project,captured),hash=c.hash(boundedJSON(envelope,8192));if(envelope.identity.source.projectId!==projectId||envelope.identity.source.nodeId!==domain.nodeId)fail();
    const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);databaseAt(c,target,"catalog.sqlite",CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{const before=catalog(c,db,root,project);if(before.barrier){if(before.barrier.input_sha256!==hash)fail("Provider handoff barrier input conflicts.");}else{if(db.prepare("INSERT INTO clank_provider_handoff_barrier VALUES(1,1,?,?,?,?,?,?,1)").run(captured.identity.handoffId,captured.stepId,boundedJSON(identity(captured.identity),2048),captured.sourceCapsuleSha256,captured.sourceIncarnation,hash).changes!==1||db.prepare("UPDATE clank_provider_handoff_catalog SET barrier_sha256=? WHERE id=1 AND barrier_sha256 IS NULL").run(hash).changes!==1)fail();if(catalog(c,db,root,project).barrier?.input_sha256!==hash)fail();}current(owner,true);db.exec("COMMIT");sync(c,file,target);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});}finally{releasePins(c,from);}await verifyDomain(owner,domain);current(owner,true);return Object.freeze({inputSha256:hash});});
}

function commitOwner(c:Context,owner:ProviderServiceOwnership):void {
  current(owner);c.database.exec("COMMIT");if(c.database.isTransaction)fail();c.database.exec("BEGIN IMMEDIATE");current(owner);sync(c,c.file,c.service);
}
function commitBridgeFile(c:Context,owner:ProviderServiceOwnership,db:any,file:Pin,parent:Pin,readback:()=>void):void {
  current(owner);readback();db.exec("COMMIT");if(db.isTransaction)fail();current(owner);readback();sync(c,file,parent);current(owner);
}
/** Explicit private enablement; a retained partial installation is never resumed. */
export async function enableProviderHandoffBridge(owner:ProviderServiceOwnership,domain:ProviderHandoffDomain,input:ProviderHandoffBridgeLimits):Promise<ProviderHandoffBridge>{
  const limits=bridgeLimits(input),limitsJSON=boundedJSON(limits,2048);
  return exclusive(owner,async()=>{
    await verifyDomain(owner,domain);const c=current(owner,true);assertBridgeOwnerStorage(c);let root=marker(c);if(!root||root.domain_json!==boundedJSON(domain,4096))fail("A complete existing provider handoff foundation is required.");
    let state=inspect(c,root);
    if(root.bridge){if(root.bridge.limits_json!==limitsJSON)fail("Provider handoff bridge limits cannot be rebound.");}
    else{
      if(state.barriers)fail("Legacy provider handoff barriers cannot be adopted.");if(state.projects.length>limits.maxProjects)fail("Provider handoff project capacity exceeded.");
      const enablement=c.randomUUID(),limitsHash=c.hash(limitsJSON),installation=rosterHash(c,state.projects),legacy=root;
      c.database.exec(BRIDGE_OWNER_SQL);
      if(c.database.prepare("INSERT INTO clank_provider_handoff_bridge_owner VALUES(1,2,?,?,?,'installing',?,?,?)").run(enablement,root.index_id,root.domain_sha256,limitsJSON,limitsHash,installation).changes!==1)fail();
      const installed=marker(c);if(!installed?.bridge||installed.bridge.enablement_id!==enablement||installed.bridge.phase!=="installing"||installed.bridge.limits_json!==limitsJSON||installed.bridge.installation_sha256!==installation)fail();
      commitOwner(c,owner);const retained=marker(c);if(JSON.stringify(retained)!==JSON.stringify(installed))fail();
      const from=c.pins.length;
      try{
        const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");
        databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
          const previous=index(c,db,legacy);if(rosterHash(c,previous)!==installation)fail();db.exec(BRIDGE_INDEX_SQL+";"+RESERVATIONS_SQL);
          if(db.prepare("INSERT INTO clank_provider_handoff_bridge_index VALUES(1,2,?,?,1,?)").run(enablement,limitsHash,c.hash("[]")).changes!==1)fail();
          commitBridgeFile(c,owner,db,file,handoff,()=>{const projects=index(c,db,installed);bridgeIndex(c,db,installed,projects);if(singleton(db,"clank_provider_handoff_bridge_index").version!==1)fail();});
        }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
        for(const project of state.projects){const before=c.pins.length;try{
          const target=directory(c,catalogs,project.catalog_id);databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
            if(catalog(c,db,legacy,project).barrier)fail();db.exec([BRIDGE_STATE_SQL,GRANT_SQL,TRANSFER_SQL,OPERATIONS_SQL,SPOOLS_SQL].join(";"));
            if(db.prepare("INSERT INTO clank_provider_handoff_bridge_state VALUES(1,2,?,1,?)").run(enablement,c.hash(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX))).changes!==1)fail();
            commitBridgeFile(c,owner,db,file,target,()=>{catalog(c,db,installed,project);if(bridgeCatalog(c,db,installed,project,[]).version!==1)fail();});
          }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
        }finally{releasePins(c,before);}}
      }finally{releasePins(c,from);}
      current(owner,true);if(c.database.prepare("UPDATE clank_provider_handoff_bridge_owner SET phase='ready' WHERE id=1 AND enablement_id=? AND phase='installing' AND limits_sha256=? AND installation_sha256=?").run(enablement,limitsHash,installation).changes!==1)fail();
      root=marker(c);if(!root?.bridge||root.bridge.phase!=="ready"||root.bridge.enablement_id!==enablement||root.bridge.installation_sha256!==installation||root.bridge.limits_json!==limitsJSON)fail();state=inspect(c,root);commitOwner(c,owner);if(JSON.stringify(marker(c))!==JSON.stringify(root))fail();
    }
    await verifyDomain(owner,domain);current(owner,true);const fresh=marker(c);if(JSON.stringify(fresh)!==JSON.stringify(root))fail();state=inspect(c,fresh);
    c.mode=state.grants||state.barriers?"cleanup-only":"bridge-live";
    const bridge:ProviderHandoffBridge=Object.freeze({enablementId:root.bridge.enablement_id,get mode(){return c.mode;}});bridges.set(bridge,{owner,domain,enablementId:root.bridge.enablement_id});return bridge;
  });
}
/**
 * Reserve the original live bridge owner before any source service startup
 * cleanup. A reopened root with retained grants is cleanup-only, never adopted.
 * Startup admission remains distinct from grant/container/runtime authority.
 */
export async function admitProviderSourceService(bridge:ProviderHandoffBridge):Promise<ProviderSourceServiceOwnership>{
  const registered=bridgeCurrent(bridge,true),owner=registered.owner;
  if(sourceServiceReservations.has(owner))fail("Provider source service ownership is already reserved.");
  sourceServiceReservations.add(owner);
  let closed=false,result:ProviderSourceServiceOwnership|undefined,publicationCheck:(()=>void)|undefined,retainedFrom:number|undefined;
  try{
    await exclusive(owner,async()=>{
      bridgeCurrent(bridge,true);
      await verifyDomain(owner,registered.domain,true);
      const c=bridgeCurrent(bridge,true).context,root=marker(c);
      const process=(globalThis as any).process;
      if(process.platform!=="linux"||!process.getuid?.()||!process.getgid?.())fail("Provider source service requires its native non-root Linux owner.");
      if(c.admitted||!root?.bridge||root.bridge.enablement_id!==registered.enablementId||root.domain_json!==boundedJSON(registered.domain,4096))fail("Provider source service requires its original bridge owner.");
      const initial=inspect(c,root);
      if(initial.barriers||initial.grants||initial.reservations.length||initial.states.some(state=>state.version!==1||state.grant||state.transfer||state.operations.length||state.spools.length))fail("Retained source state refuses fresh source service startup.");
      // Keep the exact index/catalog inodes through every startup await and
      // through the original owner lifetime, rather than adopting equal copies.
      retainedFrom=c.pins.length;
      const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");
      pin(c,c.path.join(handoff.path,"index.sqlite"),false,INDEX_MAX);
      for(const project of initial.projects){
        const directoryPin=directory(c,catalogs,project.catalog_id);
        pin(c,c.path.join(directoryPin.path,"catalog.sqlite"),false,BRIDGE_CATALOG_MAX);
      }
      const rootJSON=JSON.stringify(root),stateJSON=JSON.stringify(initial);
      publicationCheck=()=>{
        const current=bridgeCurrent(bridge,true).context;
        if(closed||current!==c||JSON.stringify(marker(current))!==rootJSON||JSON.stringify(inspect(current,marker(current)))!==stateJSON)fail("Provider source service startup observation changed.");
      };
      await verifyDomain(owner,registered.domain,true);
      const fresh=bridgeCurrent(bridge,true).context;
      if(fresh!==c||JSON.stringify(marker(fresh))!==rootJSON||JSON.stringify(inspect(fresh,marker(fresh)))!==stateJSON)fail("Provider source service startup observation changed.");
      const check=()=>{
        if(closed)fail("Provider source service ownership is closed.");
        try{
          const current=bridgeCurrent(bridge,true).context;
          if(current!==c||current.admitted||JSON.stringify(marker(current))!==rootJSON)fail("Provider source service ownership changed.");
          // Future grants still need their original owning leases. This scan
          // validates storage semantics; it does not adopt rows as authority.
          const state=inspect(current,marker(current));
          for(const catalog of state.states){
            if(catalog.grant){
              const version=({issued:2,created:3,started:4} as Row)[catalog.grant.state];
              if(version===undefined||catalog.version!==version)fail("Provider source service grant observation changed.");
            }else if(catalog.version!==1)fail("Provider source service empty catalog observation changed.");
          }
        }catch(error){closed=true;throw error;}
      };
      const verifyCurrent=async()=>{
        check();
        try{await exclusive(owner,async()=>{check();await verifyDomain(owner,registered.domain,true);check();},bridge);check();}
        catch(error){closed=true;throw error;}
      };
      result=Object.freeze({root:owner.root,serviceDirectory:owner.serviceDirectory,ownerLabel:registered.domain.owner,nodeId:registered.domain.nodeId,assertCurrent:check,verifyCurrent,
        close(){closed=true;owner.close();}});
      check();
    },bridge);
    publicationCheck!();
    sourceServiceOwners.set(result!,{owner,bridge,check:result!.assertCurrent});
    assertProviderSourceServiceOwnership(result!);
    return result!;
  }catch(error){
    closed=true;if(registered.context.mode==="bridge-live")registered.context.mode="cleanup-only";registered.context.failed=true;
    try{if(retainedFrom!==undefined)releasePins(registered.context,retainedFrom);}
    catch(cleanup){throw new AggregateError([error,cleanup],"Provider source service admission and pin cleanup failed.");}
    throw error;
  }
}
export function assertProviderSourceServiceOwnership(value:ProviderSourceServiceOwnership):void {
  const registered=sourceServiceOwners.get(value);
  if(!registered)fail("A genuine provider source service ownership is required.");
  registered.check();
}
/** Resolve only the original native owner, before reading any caller options. */
export function providerSourceServiceOwner(value:ProviderSourceServiceOwnership):ProviderServiceOwnership {
  assertProviderSourceServiceOwnership(value);
  return sourceServiceOwners.get(value)!.owner;
}
export interface ProviderSourceLaunchDataLease {
  readonly projectId:string;readonly releaseId:string;readonly generation:number;
  readonly capsuleSha256:string;readonly fence:number;
  readonly databasePath:string;readonly dataDirectory:string;readonly releaseDirectory:string;
  assertCurrent():void;verifyCurrent():Promise<void>;close():void;
}
/** Original settled data observation before C1; no container/task/write authority. */
export async function retainProviderSourceLaunchData(service:ProviderSourceServiceOwnership,input:unknown):Promise<ProviderSourceLaunchDataLease>{
  const owner=providerSourceServiceOwner(service),registered=sourceServiceOwners.get(service)!;
  const keys=["projectId","releaseId","generation","capsuleSha256","fence"];
  if(!input||typeof input!=="object"||Array.isArray(input))fail("Provider source launch binding is invalid.");
  const descriptors=Object.getOwnPropertyDescriptors(input);
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!Object.hasOwn(descriptors[key],"value")||!descriptors[key].enumerable))fail("Provider source launch binding requires closed own data.");
  const binding=Object.freeze(Object.fromEntries(keys.map(key=>[key,descriptors[key].value]))) as Row;
  if(!match(binding.projectId,ID)||!match(binding.releaseId,ID)||!positive(binding.generation)||!match(binding.capsuleSha256,DIGEST)||!positive(binding.fence))fail("Provider source launch binding is invalid.");
  const used=usedSourceLaunchProjects.get(owner)??new Set<string>();
  if(used.has(binding.projectId)||(ownerSourceLaunchData.get(owner)?.size??0)+(pendingSourceLaunchData.get(owner)??0)>=2)fail("Provider source launch data cannot be duplicated or recycled.");
  used.add(binding.projectId);usedSourceLaunchProjects.set(owner,used);
  pendingSourceLaunchData.set(owner,(pendingSourceLaunchData.get(owner)??0)+1);
  let result:ProviderSourceLaunchDataLease|undefined;
  try{
    const module=await import("./provider-data.ts");service.assertCurrent();
    const decode=(module.openDeploymentProviderDataStore as any)[SQLITE_INTERNAL].decodeSourceState;
    await withBridge(registered.bridge,true,(c,root,state)=>{
      service.assertCurrent();
      if(!state.projects.some(project=>project.project_id===binding.projectId))fail("Provider source launch project is not installed.");
      const from=c.pins.length,held:Pin[]=[];
      try{
        const projects=directory(c,c.root,"projects"),project=directory(c,projects,binding.projectId),journal=c.path.join(project.path,"journal.json");
        if(!absent(c,journal))fail("Unsettled provider source data refuses launch.");
        const stateFile=pin(c,c.path.join(project.path,"state.json"),false,65536),fenceFile=pin(c,c.path.join(project.path,"fence.json"),false,65536);
        const stateJSON=sourceMetadata(c,stateFile),fenceJSON=sourceMetadata(c,fenceFile),active=decode(stateJSON,binding.projectId).active;
        if(active.releaseId!==binding.releaseId||active.generation!==binding.generation||active.capsuleSha256!==binding.capsuleSha256||active.fence!==binding.fence)fail("Provider source launch requires its exact committed generation and fence.");
        let fence:Row;try{fence=JSON.parse(fenceJSON);}catch{fail("Provider source launch fence is invalid.");}
        if(!exact(fence,["protocol","projectId","fence"])||fence.protocol!=="clank-provider-data-fence/1"||fence.projectId!==binding.projectId||fence.fence!==binding.fence||JSON.stringify(fence)+"\n"!==fenceJSON)fail("Provider source launch committed fence differs.");
        const data=directory(c,project,"data"),generations=directory(c,project,"generations"),release=directory(c,generations,active.releaseDirectory.slice("generations/".length));
        const databasePath=c.path.join(project.path,...active.databasePath.split("/")),parent=c.path.dirname(databasePath);
        if(c.fs.realpathSync(parent)!==parent)fail("Provider source launch database parent is not canonical.");
        const leaf=parent===data.path?data:pin(c,parent,true),database=pin(c,databasePath,false,2*1024*1024*1024);
        held.push(...c.pins.splice(from));let closed=false;
        const closes=ownerSourceLaunchData.get(owner)??new Set<()=>void>(),children=new Set<()=>void>();
        const close=()=>{if(closed)return;closed=true;closes.delete(close);const errors:unknown[]=[];for(const child of [...children])try{child();}catch(error){errors.push(error);}children.clear();for(const p of held.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(error){errors.push(error);}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,"Provider source launch pins failed to close.");};
        const check=()=>{
          try{
            if(closed)fail("Provider source launch data is closed.");service.assertCurrent();
            for(const p of held)assertPin(c,p);
            if(c.fs.realpathSync(leaf.path)!==leaf.path||c.fs.realpathSync(database.path)!==database.path||c.fs.realpathSync(release.path)!==release.path||!absent(c,journal)||sourceMetadata(c,stateFile)!==stateJSON||sourceMetadata(c,fenceFile)!==fenceJSON)fail("Provider source launch data observation changed.");
          }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source launch observation and cleanup failed.");}throw error;}
        };
        const verifyCurrent=async()=>{try{check();await service.verifyCurrent();check();}catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source launch verification and cleanup failed.");}throw error;}};
        result=Object.freeze({...binding,databasePath:database.path,dataDirectory:data.path,releaseDirectory:release.path,assertCurrent:check,verifyCurrent,close}) as ProviderSourceLaunchDataLease;
        check();closes.add(close);ownerSourceLaunchData.set(owner,closes);sourceLaunchDataLeases.set(result,{owner,check,children});
      }catch(error){const errors:unknown[]=[error];for(const p of held.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(cleanup){errors.push(cleanup);}try{releasePins(c,from);}catch(cleanup){errors.push(cleanup);}if(errors.length>1)throw new AggregateError(errors,"Provider source launch retention failed.");throw error;}
    });
    assertProviderSourceLaunchDataLease(result!);return result!;
  }catch(error){try{result?.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source launch publication failed.");}throw error;}
  finally{pendingSourceLaunchData.set(owner,(pendingSourceLaunchData.get(owner)??1)-1);}
}
export function assertProviderSourceLaunchDataLease(value:ProviderSourceLaunchDataLease):void {
  const registered=sourceLaunchDataLeases.get(value);
  if(!registered)fail("A genuine provider source launch data lease is required.");
  registered.check();
}
export function assertProviderSourceLaunchOwner(service:ProviderSourceServiceOwnership,data:ProviderSourceLaunchDataLease):void {
  const owner=providerSourceServiceOwner(service),retained=sourceLaunchDataLeases.get(data);
  if(!retained||retained.owner!==owner)fail("Source launch requires data retained by its original service owner.");
  retained.check();
}
/** Private original launch context only; callers cannot rebind another owner's data. */
export async function providerSourceLaunchContext(service:ProviderSourceServiceOwnership,data:ProviderSourceLaunchDataLease){
  assertProviderSourceLaunchOwner(service,data);
  const retained=sourceLaunchDataLeases.get(data)!,registered=sourceServiceOwners.get(service)!;
  const result=await withBridge(registered.bridge,true,(c,root,state)=>{
    service.assertCurrent();retained.check();
    const project=state.projects.find(p=>p.project_id===data.projectId),source=state.states.find(p=>p.projectId===data.projectId);
    if(!project||!source||source.grant||source.version!==1)fail("Source launch requires its original empty project catalog.");
    const domain=bridges.get(registered.bridge)!.domain,client=domains.get(domain)?.client;if(!client)fail();
    const check=()=>{service.assertCurrent();retained.check();};
    const initial=JSON.stringify(source);
    const assertInitial=()=>{check();const next=inspect(c,marker(c)).states.find(p=>p.projectId===data.projectId);
      if(JSON.stringify(next)!==initial)fail("Source launch catalog changed before context publication.");};
    const retainCleanup=(close:()=>void)=>{check();if(typeof close!=="function"||retained.children.size)fail("Source launch cleanup is already owned.");retained.children.add(close);return ()=>retained.children.delete(close);};
    return Object.freeze({bridge:registered.bridge,domain,client,check,assertInitial,retainCleanup,indexId:root.index_id,catalogId:project.catalog_id,
      domainSha256:root.domain_sha256,limits:root.bridge.limits,
      catalogDirectory:c.path.join(c.service.path,"handoff","catalogs",project.catalog_id)});
  });
  // Publication is outside the owner lane's final await. Do not convert a
  // cached pre-await observation into permission to create an application.
  result.assertInitial();return result;
}
async function withBridge<Value>(bridge:ProviderHandoffBridge,live:boolean,action:(c:Context,root:Row,state:ReturnType<typeof inspect>,registered:BridgeContext)=>Value):Promise<Value>{
  const registered=bridgeCurrent(bridge,live);
  return exclusive(registered.owner,async()=>{
    bridgeCurrent(bridge,live);await verifyDomain(registered.owner,registered.domain,true);const {context:c}=bridgeCurrent(bridge,live),root=marker(c);
    if(!root?.bridge||root.bridge.enablement_id!==registered.enablementId||root.domain_json!==boundedJSON(registered.domain,4096))fail();const state=inspect(c,root),result=action(c,root,state,registered);
    await verifyDomain(registered.owner,registered.domain,true);bridgeCurrent(bridge,live);return result;
  },bridge);
}
/** Native catalog observation only; this does not provide process or stop proof. */
export async function inspectProviderHandoffBridge(bridge:ProviderHandoffBridge):Promise<Readonly<{projects:readonly Row[];reservations:readonly Row[]}>>{
  return withBridge(bridge,false,(_c,_root,state)=>freezeValue({projects:state.states,reservations:state.reservations}));
}
/** One permanent identity intent. No container, runtime or publication is started. */
export async function issueProviderHandoffGrant(bridge:ProviderHandoffBridge,input:Readonly<{binding:unknown;grantSecretSha256:string;controlSecretSha256:string}>):Promise<Readonly<{grantId:string;bindingSha256:string}>>{
  if(!exact(input,["binding","grantSecretSha256","controlSecretSha256"]))fail();const captured=JSON.parse(boundedJSON(input,6144));
  return withBridge(bridge,true,(c,root,state,registered)=>{
    const project=state.projects.find(p=>p.project_id===captured.binding?.projectId);if(!project||!match(captured.grantSecretSha256,DIGEST)||!match(captured.controlSecretSha256,DIGEST))fail();
    const binding=grantBinding(captured.binding,root,project),json=boundedJSON(binding,4096),digest=c.hash(json),from=c.pins.length;
    try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);
      databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
        if(catalog(c,db,root,project).barrier)fail("A permanent provider handoff barrier refuses new grants.");const before=bridgeCatalog(c,db,root,project,state.reservations),existing=before.grant;
        const expected={id:1,protocol:2,grant_id:binding.grantId,binding_json:json,binding_sha256:digest,grant_secret_sha256:captured.grantSecretSha256,control_secret_sha256:captured.controlSecretSha256,state:"issued",container_id:null,readiness_json:null,readiness_sha256:null};
        if(existing){if(JSON.stringify(existing)!==JSON.stringify(expected))fail("Provider handoff grant identity cannot be recycled or rebound.");}
        else{
          if(before.version===Number.MAX_SAFE_INTEGER)fail();
          if(db.prepare("INSERT INTO clank_provider_handoff_source_grant VALUES(1,2,?,?,?,?,?,'issued',NULL,NULL,NULL)").run(binding.grantId,json,digest,captured.grantSecretSha256,captured.controlSecretSha256).changes!==1)fail();
          if(JSON.stringify(bridgeRecords(db).grant)!==JSON.stringify(expected))fail("Provider handoff grant readback differs.");
          const mirror=c.hash(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX));if(db.prepare("UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=? WHERE id=1 AND version=? AND records_sha256=?").run(mirror,before.version,c.hash(boundedJSON({grant:before.grant,transfer:before.transfer,operations:before.operations,spools:before.spools},BRIDGE_CATALOG_MAX))).changes!==1)fail();
        }
        const expectedVersion=before.version+(existing?0:1);commitBridgeFile(c,registered.owner,db,file,target,()=>{catalog(c,db,root,project);const after=bridgeCatalog(c,db,root,project,state.reservations);if(after.version!==expectedVersion||JSON.stringify(after.grant)!==JSON.stringify(expected))fail();});
      }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    }finally{releasePins(c,from);}return Object.freeze({grantId:binding.grantId,bindingSha256:digest});
  });
}
type ProviderHandoffContainerInput=Readonly<{projectId:string;grantId:string;bindingSha256:string;containerId:string;expectedVersion:number}>;
type ProviderHandoffContainerAcknowledgment=Readonly<{grantId:string;bindingSha256:string;containerId:string;state:"created"|"started";version:number}>;
const CONTAINER_PROJECTION="[{{json .Id}},{{json .Image}},{{json .Config.Image}},{{json .Config.User}},{{json .Config.Labels}},{{json .HostConfig.RestartPolicy.Name}},{{json .HostConfig.RestartPolicy.MaximumRetryCount}},{{json .State.Status}},{{json .State.Running}},{{json .State.Paused}},{{json .State.Restarting}},{{json .State.Dead}},{{json .State.Pid}},{{json .State.StartedAt}},{{json .State.FinishedAt}},{{json .RestartCount}},{{json .Created}}]";
const GRANT_CONTAINER_CAS="UPDATE clank_provider_handoff_source_grant SET state=?,container_id=? WHERE id=1 AND protocol=2 AND grant_id=? AND binding_json=? AND binding_sha256=? AND grant_secret_sha256=? AND control_secret_sha256=? AND state=? AND container_id IS ? AND readiness_json IS NULL AND readiness_sha256 IS NULL";
const CONTAINER_MIRROR_CAS="UPDATE clank_provider_handoff_bridge_state SET version=version+1,records_sha256=? WHERE id=1 AND protocol=2 AND enablement_id=? AND version=? AND records_sha256=?";
function containerInput(value:ProviderHandoffContainerInput,state:"created"|"started",observationOnly=false):ProviderHandoffContainerInput {
  const keys=["projectId","grantId","bindingSha256","containerId","expectedVersion"],copy:Row={};
  if(!value||typeof value!=="object"||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length)fail("Provider handoff container input is invalid.");
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!("value" in descriptor))fail("Provider handoff container input requires own data fields.");copy[key]=descriptor.value;}
  if(!match(copy.projectId,ID)||!match(copy.grantId,UUID)||!match(copy.bindingSha256,DIGEST)||!match(copy.containerId,DIGEST)||!positive(copy.expectedVersion)||copy.expectedVersion>Number.MAX_SAFE_INTEGER-(observationOnly?0:1)||copy.expectedVersion<(state==="created"?2:3))fail("Provider handoff container input is invalid.");
  return Object.freeze(copy) as unknown as ProviderHandoffContainerInput;
}
/** Require an original retained lease; copied methods/serialized rows are not authority. */
export function assertProviderSourceGrantLease(lease:ProviderSourceGrantLease):void {
  const retained=sourceGrantLeases.get(lease);if(!retained)fail("A genuine provider source grant lease is required.");retained.check();
}
/**
 * Retain the exact started catalog observation and authenticate its control key.
 * This proves catalog ownership only. Native container/mount/worker admission,
 * source readiness and provider-wide writer exclusion still require their own
 * checks. In particular, C1's started row is not current process/security proof.
 */
export async function retainProviderSourceGrant(
  bridge:ProviderHandoffBridge,value:ProviderHandoffContainerInput,controlSecret:Uint8Array,
):Promise<ProviderSourceGrantLease> {
  const input=containerInput(value,"started",true);
  if(input.expectedVersion<4)fail("A started provider source grant version is required.");
  // Copy only native slots before the first await. Never call a caller getter,
  // iterator or conversion, and never retain/mutate its key or shared memory.
  const typed=Object.getPrototypeOf(Uint8Array.prototype);
  const length=Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!;
  const buffer=Object.getOwnPropertyDescriptor(typed,"buffer")!.get!;
  const arrayLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!;
  try {
    if(!(controlSecret instanceof Uint8Array)||!ArrayBuffer.isView(controlSecret)||length.call(controlSecret)!==32)fail();
    arrayLength.call(buffer.call(controlSecret));
  }catch{fail("Provider source control key requires 32 native non-shared bytes.");}
  const secret=new Uint8Array(controlSecret);
  let lease:ProviderSourceGrantLease|undefined;
  try {
    const registered=bridgeCurrent(bridge,true),cryptoName="node:crypto";
    const crypto=await import(cryptoName);bridgeCurrent(bridge,true);
    const secretHash=crypto.createHash("sha256").update(secret).digest("hex");secret.fill(0);
    lease=await withBridge(bridge,true,(c,_root,_state)=>{
      const active=ownerSourceLeases.get(registered.owner)??new Set<ProviderSourceGrantLease>();
      const used=retainedSourceGrants.get(bridge)??new Set<string>();
      if(active.size>=MAX_SOURCE_GRANT_LEASES||used.has(input.grantId))fail("Provider source grant lease cannot be duplicated or recycled.");
      const frame=containerFrame(bridge,registered),source=frame.state.states.find(row=>row.projectId===input.projectId),grant=source?.grant;
      if(!grant||source.version!==input.expectedVersion||grant.state!=="started"||grant.grant_id!==input.grantId
        ||grant.binding_sha256!==input.bindingSha256||grant.container_id!==input.containerId
        ||!crypto.timingSafeEqual(Buffer.from(grant.control_secret_sha256,"hex"),Buffer.from(secretHash,"hex"))) {
        fail("Provider source retained grant differs.");
      }
      const rootJSON=JSON.stringify(frame.root),stateJSON=JSON.stringify({state:frame.state,index:frame.indexRows});
      const binding=freezeValue(JSON.parse(grant.binding_json));
      const prepared=bridgeWorkerChannels.get(bridge)?.get(input.grantId);
      if(usedWorkerChannels.get(bridge)?.has(input.grantId)&&!prepared)fail("An attempted source channel has no completed original preparation.");
      if(prepared){prepared.check();if(prepared.containerId()!==input.containerId||JSON.stringify(prepared.binding)!==JSON.stringify(binding))fail("Provider source channel grant binding differs.");}
      const retained:Pin[]=[],from=c.pins.length;
      try {
        const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");
        pin(c,c.path.join(handoff.path,"index.sqlite"),false,INDEX_MAX);
        for(const project of frame.state.projects){const target=directory(c,catalogs,project.catalog_id);pin(c,c.path.join(target.path,"catalog.sqlite"),false,BRIDGE_CATALOG_MAX);}
        // Lease pins have their own lifetime. Never leave them in the transient
        // owner-operation stack that another operation releases in finally.
        retained.push(...c.pins.splice(from));
        let closed=false;const children=new Set<()=>void>();if(prepared)children.add(prepared.invalidate);
        const close=()=>{
          if(closed)return;closed=true;active.delete(result);
          const failures:unknown[]=[];
          for(const child of [...children])try{child();}catch(error){failures.push(error);}
          for(const p of retained.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(error){failures.push(error);}
          if(failures.length===1)throw failures[0];
          if(failures.length)throw new AggregateError(failures,"Provider source grant retained pins failed to close.");
        };
        const check=()=>{
          try {
            if(closed)fail("Provider source grant lease is closed.");
            for(const p of retained)assertPin(c,p);
            containerFrame(bridge,registered,rootJSON,stateJSON);
          }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source grant observation and cleanup failed.");}throw error;}
        };
        const verifyCurrent=async()=>{
          try {
            // Probe the retained domain on both sides of the fresh native read.
            // A response captured before a daemon change cannot acknowledge a
            // verification after that change while the owner lane is held.
            check();await withBridge(bridge,true,()=>check());check();
          }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source grant verification and cleanup failed.");}throw error;}
        };
        const result:ProviderSourceGrantLease=Object.freeze({binding,assertCurrent:check,verifyCurrent,close});
        check();sourceGrantLeases.set(result,{check,context:c,registered,bridge,input,children,dataRetained:false});active.add(result);used.add(input.grantId);
        ownerSourceLeases.set(registered.owner,active);retainedSourceGrants.set(bridge,used);lease=result;
        return result;
      }catch(error){
        // Includes failure before a facade exists; every owned descriptor gets
        // one close attempt even if an earlier close reports uncertainty.
        const failures:unknown[]=[error];
        for(const p of retained.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(cleanup){failures.push(cleanup);}
        try{releasePins(c,from);}catch(cleanup){failures.push(cleanup);}
        if(failures.length>1)throw new AggregateError(failures,"Provider source grant retention failed.");throw error;
      }
    });
    // withBridge's final domain probe and exclusive lane completion both await.
    // Check retained inode/state again before publishing the original facade.
    assertProviderSourceGrantLease(lease);return lease;
  }catch(error){
    try{lease?.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source grant publication failed.");}throw error;
  }finally{secret.fill(0);}
}

/** Original issued-grant channel preparation. This does not authorize workers. */
export interface ProviderSourceWorkerChannel {
  readonly mountSource:string;
  assertCurrent():void;
  verifyCurrent():Promise<void>;
  bindCreated(input:ProviderHandoffContainerInput):Promise<import("./provider-source-worker-wire.ts").SourceWorkerChannelBinding>;
  dispatch(container:ProviderSourceContainerLease):Promise<void>;
  close():Promise<void>;
}
type SourceWorkerChannelContext={check:()=>void;invalidate:()=>void;binding:Row;containerId:()=>string|undefined;mountSource:string};
const sourceWorkerChannels=new WeakMap<ProviderSourceWorkerChannel,SourceWorkerChannelContext>();
const bridgeWorkerChannels=new WeakMap<ProviderHandoffBridge,Map<string,SourceWorkerChannelContext>>();
const ownerWorkerChannels=new WeakMap<ProviderServiceOwnership,Set<SourceWorkerChannelContext>>();
const usedWorkerChannels=new WeakMap<ProviderHandoffBridge,Set<string>>();
const pendingWorkerChannels=new WeakMap<ProviderServiceOwnership,number>();
function closeWorkerChannels(owner:ProviderServiceOwnership):void {
  for(const channel of [...(ownerWorkerChannels.get(owner)??[])])channel.invalidate();
}
export function assertProviderSourceWorkerChannel(value:ProviderSourceWorkerChannel):void {
  const channel=sourceWorkerChannels.get(value);if(!channel)fail("An original provider source worker channel is required.");channel.check();
}
export async function prepareProviderSourceWorkerChannel(
  bridge:ProviderHandoffBridge,value:Readonly<{projectId:string;grantId:string;bindingSha256:string;expectedVersion:number}>,controlSecret:Uint8Array,
):Promise<ProviderSourceWorkerChannel> {
  const names=["projectId","grantId","bindingSha256","expectedVersion"],input:Row={};
  if(!value||typeof value!=="object"||Array.isArray(value)||Reflect.ownKeys(value).length!==names.length)fail("Invalid issued source channel input.");
  for(const name of names){const own=Object.getOwnPropertyDescriptor(value,name);if(!own||!("value"in own))fail("Issued source channel requires own data fields.");input[name]=own.value;}
  if(!match(input.projectId,ID)||!match(input.grantId,UUID)||!match(input.bindingSha256,DIGEST)||input.expectedVersion!==2)fail("Issued source channel requires its first issued version.");
  const typed=Object.getPrototypeOf(Uint8Array.prototype),length=Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!,buffer=Object.getOwnPropertyDescriptor(typed,"buffer")!.get!,arrayLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!;
  try{if(!(controlSecret instanceof Uint8Array)||!ArrayBuffer.isView(controlSecret)||length.call(controlSecret)!==32)fail();arrayLength.call(buffer.call(controlSecret));}catch{fail("Source channel requires 32 native non-shared control bytes.");}
  const secret=new Uint8Array(controlSecret),retained:Pin[]=[],pins:Array<import("./sqlite-sandbox.ts").PinnedSQLiteDirectory>=[];
  const registered=(()=>{try{return bridgeCurrent(bridge,true);}catch(error){secret.fill(0);throw error;}})(),c=registered.context;
  const directoryIdentities=new Map<import("./sqlite-sandbox.ts").PinnedSQLiteDirectory,{dev:number;ino:number}>();
  let sandbox:typeof import("./sqlite-sandbox.ts")|undefined;
  const keep=(p:import("./sqlite-sandbox.ts").PinnedSQLiteDirectory)=>{pins.push(p);const stat=c.fs.fstatSync(p.fd);directoryIdentities.set(p,{dev:stat.dev,ino:stat.ino});};
  let broker:import("./provider-source-worker-wire.ts").SourceWorkerSocketBroker|undefined,server:ReturnType<typeof import("./provider-source-worker-wire.ts").createSourceWorkerServerProtocol>|undefined;
  let closed=false,published=false,reserved=false,bindingStarted=false,containerId:string|undefined,version=2,rootJSON="",otherJSON="",grantJSON="",grant:Row|undefined;
  let watch:ReturnType<typeof setInterval>|undefined,cleanupFlight:Promise<void>|undefined;
  let worker:ProviderSourceWorkerLease|undefined,dispatchFlight:Promise<void>|undefined,dispatchStarted=false;
  let context:SourceWorkerChannelContext|undefined;
  const cleanup=():Promise<void>=>{
    if(cleanupFlight)return cleanupFlight;
    cleanupFlight=(async()=>{
      // Stop transport and worker admission immediately, then keep all channel
      // pins until the original dispatch has settled its native work/cleanup.
      const brokerClosing=broker?.close();void brokerClosing?.catch(()=>{});
      void worker?.close().catch(()=>{});
      await dispatchFlight?.then(()=>{},()=>{});await worker?.close();
      if(broker){try{await brokerClosing;}catch(error){
        // An expired observation is not settlement. Keep every original pin
        // and wait for this same child; never create/adopt a replacement.
        await broker.closed;await broker.close();
      }}
      const errors:unknown[]=[];
      for(const pin of pins.splice(0).reverse())try{await pin.close();}catch(error){errors.push(error);}
      for(const pin of retained.splice(0).reverse())try{c.fs.closeSync(pin.fd);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,"Source channel pin cleanup is uncertain.");
      if(context)ownerWorkerChannels.get(registered.owner)?.delete(context);
    })();void cleanupFlight.catch(()=>{});return cleanupFlight;
  };
  const invalidate=()=>{if(closed)return;closed=true;secret.fill(0);server?.close();if(watch!==undefined)clearInterval(watch);void worker?.close().catch(()=>{});if(published)void cleanup();};
  const check=()=>{
    try{
      if(closed)fail("Provider source worker channel is closed.");
      for(const p of retained)assertPin(c,p);
      const frame=containerFrame(bridge,registered),source=frame.state.states.find(row=>row.projectId===input.projectId),next=source?.grant;
      const other=JSON.stringify({projects:frame.state.projects,reservations:frame.state.reservations,index:frame.indexRows,states:frame.state.states.filter(row=>row.projectId!==input.projectId)});
      if(JSON.stringify(frame.root)!==rootJSON||other!==otherJSON||!next||!grant
        ||JSON.stringify({...next,state:grant.state,container_id:grant.container_id})!==grantJSON
        ||!["issued","created","started"].includes(next.state)||source.version!==({issued:2,created:3,started:4} as Row)[next.state]
        ||source.version<version||containerId!==undefined&&next.container_id!==containerId)fail("Issued source channel grant changed.");
      version=source.version;
      for(const p of pins){sandbox!.assertPinnedSQLiteDirectory(p);const held=c.fs.fstatSync(p.fd),visible=c.fs.lstatSync(p.path),identity=directoryIdentities.get(p)!,mode=p===pins[3]&&broker?0o500:0o700;if(!held.isDirectory()||!visible.isDirectory()||held.dev!==identity.dev||held.ino!==identity.ino||visible.dev!==identity.dev||visible.ino!==identity.ino||held.uid!==grant.binding.uid||held.gid!==grant.binding.gid||(held.mode&0o777)!==mode||c.fs.realpathSync(p.path)!==p.path)fail("Issued source channel directory changed.");}
      broker?.assertCurrent();
    }catch(error){invalidate();throw error;}
  };
  const close=async()=>{
    invalidate();let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([cleanup(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Provider source channel close is unsettled after 10000ms.")),10000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  try{
    const cryptoName="node:crypto",crypto=await import(cryptoName);bridgeCurrent(bridge,true);
    const digest=crypto.createHash("sha256").update(secret).digest("hex");
    await withBridge(bridge,true,()=>{
      const frame=containerFrame(bridge,registered),source=frame.state.states.find(row=>row.projectId===input.projectId),record=source?.grant;
      const used=usedWorkerChannels.get(bridge)??new Set<string>(),active=ownerWorkerChannels.get(registered.owner)?.size??0,pending=pendingWorkerChannels.get(registered.owner)??0;
      if(!record||source.version!==2||record.state!=="issued"||record.grant_id!==input.grantId||record.binding_sha256!==input.bindingSha256||!crypto.timingSafeEqual(Buffer.from(record.control_secret_sha256,"hex"),Buffer.from(digest,"hex")))fail("Issued source channel authentication differs.");
      if(active+pending>=2||used.has(input.grantId))fail("Issued source channel cannot be duplicated or recycled.");
      const binding=JSON.parse(record.binding_json),process=(globalThis as any).process;
      if(process.platform!=="linux"||!process.getuid?.()||binding.uid!==process.getuid()||binding.gid!==process.getgid())fail("Issued source channel requires its fixed native owner.");
      used.add(input.grantId);usedWorkerChannels.set(bridge,used);pendingWorkerChannels.set(registered.owner,pending+1);reserved=true;
      grantJSON=JSON.stringify(record);grant=Object.freeze({...record,binding:freezeValue(binding)});
      rootJSON=JSON.stringify(frame.root);otherJSON=JSON.stringify({projects:frame.state.projects,reservations:frame.state.reservations,index:frame.indexRows,states:frame.state.states.filter(row=>row.projectId!==input.projectId)});
      const from=c.pins.length;
      try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");pin(c,c.path.join(handoff.path,"index.sqlite"),false,INDEX_MAX);
        for(const project of frame.state.projects){const dir=directory(c,catalogs,project.catalog_id);pin(c,c.path.join(dir.path,"catalog.sqlite"),false,BRIDGE_CATALOG_MAX);}retained.push(...c.pins.splice(from));
      }catch(error){releasePins(c,from);throw error;}
    });
    check();sandbox=await import("./sqlite-sandbox.ts");check();
    const root=await sandbox.pinSQLiteDirectory(c.root.path);keep(root);check();
    const original=c.fs.fstatSync(root.fd);if(original.dev!==c.root.dev||original.ino!==c.root.ino)fail("Issued source channel root changed.");
    const base=await sandbox.createPinnedSQLiteChildDirectory(root,".clank-source-worker-"+input.grantId,check);keep(base);check();
    for(const name of ["listener","disposal","mount"]){const child=await sandbox.createPinnedSQLiteChildDirectory(base,name,check);keep(child);check();}
    const wire=await import("./provider-source-worker-wire.ts");check();
    broker=await wire.openSourceWorkerSocketBroker(pins[2]!,pins[3]!,pins[4]!);check();
    const verifyCurrent=async()=>{check();await withBridge(bridge,true,()=>check());check();};
    const bindCreated=async(value:ProviderHandoffContainerInput)=>{
      check();if(bindingStarted)fail("Source channel binding cannot be duplicated or recycled.");
      const inputCreated=containerInput(value,"created",true);
      if(inputCreated.projectId!==input.projectId||inputCreated.grantId!==input.grantId||inputCreated.bindingSha256!==input.bindingSha256||inputCreated.expectedVersion!==3)fail("Source channel created binding differs.");
      bindingStarted=true;try{await verifyCurrent();check();const frame=containerFrame(bridge,registered),source=frame.state.states.find(row=>row.projectId===input.projectId);
      if(source?.version!==3||source.grant?.state!=="created"||source.grant.container_id!==inputCreated.containerId)fail("Source channel requires its exact created catalog transition.");
      const client=domains.get(registered.domain)?.client;if(!client)fail();
      const response=await runProviderDockerClient(client,["container","inspect","--format",CONTAINER_PROJECTION,inputCreated.containerId],{timeoutMs:15000,maxOutputBytes:65536});check();
      containerObservation(response.stdout,inputCreated,grant!.binding,registered.domain,"created");await verifyCurrent();check();
      // No await after the final checks and before consuming the original key.
      containerId=inputCreated.containerId;server=wire.createSourceWorkerServerProtocol(secret,{bindingSha256:input.bindingSha256,containerId,sourceIncarnation:grant!.binding.sourceIncarnation});secret.fill(0);check();return server.binding;}catch(error){invalidate();throw error;}
    };
    const dispatch=(container:ProviderSourceContainerLease):Promise<void>=>{
      try{
        check();if(dispatchStarted||!server||!containerId)fail("Source channel dispatch is absent or already consumed.");
        const actual=sourceContainerLeases.get(container);
        if(!actual||actual.scope.parent.bridge!==bridge||actual.scope.parent.input.grantId!==input.grantId
          ||actual.scope.parent.input.containerId!==containerId||sourceWorkerChannelFor(actual.scope)!==context)fail("Source channel requires its original coupled container.");
        actual.check();dispatchStarted=true;
      }catch(error){return Promise.reject(error);}
      const pending=(async()=>{
        worker=await retainProviderSourceWorker(container);check();
        for(let sequence=0;sequence<3;sequence++){
          const encoded=await broker!.receive();check();
          const accepted=server!.accept(encoded);
          const result=await worker.execute(accepted.task);check();
          broker!.reply(server!.reply(accepted,result));check();
        }
        // IPC reply is not a source completion/readiness receipt. Keep the
        // channel until its client disconnects or its original owner closes it.
      })().catch(error=>{invalidate();throw error;});
      dispatchFlight=pending;void pending.catch(()=>{});return pending;
    };
    context={check,invalidate,binding:grant!.binding,containerId:()=>containerId,mountSource:pins[4]!.path};
    const result:ProviderSourceWorkerChannel=Object.freeze({mountSource:context.mountSource,assertCurrent:check,verifyCurrent,bindCreated,dispatch,close});
    check();const active=ownerWorkerChannels.get(registered.owner)??new Set<SourceWorkerChannelContext>();active.add(context);ownerWorkerChannels.set(registered.owner,active);
    const channels=bridgeWorkerChannels.get(bridge)??new Map<string,SourceWorkerChannelContext>();channels.set(input.grantId,context);bridgeWorkerChannels.set(bridge,channels);sourceWorkerChannels.set(result,context);published=true;
    watch=setInterval(()=>{try{check();}catch{}},50);watch.unref?.();void broker.closed.then(()=>invalidate());check();return result;
  }catch(error){invalidate();try{await close();}catch(failure){throw new AggregateError([error,failure],"Issued source channel preparation and cleanup failed.");}throw error;}
  finally{if(!published)secret.fill(0);if(reserved)pendingWorkerChannels.set(registered.owner,(pendingWorkerChannels.get(registered.owner)??1)-1);}
}

export interface ProviderSourceRuntimeDataLease {
  readonly databasePath:string;
  readonly dataDirectory:string;
  readonly releaseDirectory:string;
  readonly fence:number;
  assertCurrent():void;
  verifyCurrent():Promise<void>;
  close():void;
}
type SourceRuntimeDataContext={check:()=>void;parent:SourceGrantLeaseContext;grant:ProviderSourceGrantLease;children:Set<()=>void>;containerRetained:boolean};
const sourceRuntimeDataLeases=new WeakMap<ProviderSourceRuntimeDataLease,SourceRuntimeDataContext>();
export function assertProviderSourceRuntimeDataLease(value:ProviderSourceRuntimeDataLease):void {
  const retained=sourceRuntimeDataLeases.get(value);if(!retained)fail("A genuine provider source runtime data lease is required.");retained.check();
}
function sourceMetadata(c:Context,file:Pin):string {
  assertPin(c,file);
  // The fixed read allocation also bounds growth between fstat and read. Do not
  // use readFileSync's unbounded allocation on a mutable metadata descriptor.
  const bytes=new Uint8Array(65537);let length=0;
  while(length<bytes.length){const n=c.fs.readSync(file.fd,bytes,length,bytes.length-length,length);if(n===0)break;length+=n;}
  assertPin(c,file);if(length>65536)fail("Provider source metadata exceeds its fixed bound.");
  return new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length));
}
/**
 * Derive source data only from an original grant lease and settled committed
 * provider metadata. Public PreparedDeploymentRuntimeData, caller paths and
 * callbacks cannot mint this observation. Container/worker admission remains a
 * separate requirement; no SQLite connection or task is opened here.
 */
export async function retainProviderSourceRuntimeData(lease:ProviderSourceGrantLease):Promise<ProviderSourceRuntimeDataLease> {
  const parent=sourceGrantLeases.get(lease);if(!parent)fail("A genuine provider source grant lease is required.");parent.check();
  const dataModule=await import("./provider-data.ts");parent.check();
  const decode=(dataModule.openDeploymentProviderDataStore as any)[SQLITE_INTERNAL].decodeSourceState;
  let result:ProviderSourceRuntimeDataLease|undefined;
  try {
    await withBridge(parent.bridge,true,(c)=>{
      parent.check();if(parent.dataRetained)fail("Provider source runtime data cannot be duplicated or recycled.");
      const process=(globalThis as any).process,binding=lease.binding;
      if(process.platform!=="linux"||binding.uid!==process.getuid?.()||binding.gid!==process.getgid?.())fail("Provider source runtime data requires its native non-root owner identity.");
      const from=c.pins.length,held:Pin[]=[];
      try {
        const projects=directory(c,c.root,"projects"),project=directory(c,projects,binding.projectId);
        const journalPath=c.path.join(project.path,"journal.json");
        if(!absent(c,journalPath))fail("Unsettled provider source data refuses admission.");
        const stateFile=pin(c,c.path.join(project.path,"state.json"),false,65536),fenceFile=pin(c,c.path.join(project.path,"fence.json"),false,65536);
        const stateJSON=sourceMetadata(c,stateFile),fenceJSON=sourceMetadata(c,fenceFile),state=decode(stateJSON,binding.projectId),active=state.active;
        if(active.releaseId!==binding.releaseId||active.generation!==binding.generation||active.capsuleSha256!==binding.capsuleSha256)fail("Provider source runtime data binding differs.");
        let fence:Row;try{fence=JSON.parse(fenceJSON);}catch{fail("Provider source fence is invalid.");}
        if(!exact(fence,["protocol","projectId","fence"])||fence.protocol!=="clank-provider-data-fence/1"||fence.projectId!==binding.projectId||fence.fence!==active.fence||JSON.stringify(fence)+"\n"!==fenceJSON)fail("Provider source committed fence differs.");
        const data=directory(c,project,"data"),generations=directory(c,project,"generations");
        const release=directory(c,generations,active.releaseDirectory.slice("generations/".length));
        const databasePath=c.path.join(project.path,...active.databasePath.split("/")),databaseParent=c.path.dirname(databasePath);
        // Retain the leaf plus data/project/root identities, and require a
        // canonical path on each check. Intermediate symlinks cannot redirect
        // a descriptor into another project or system directory.
        if(c.fs.realpathSync(databaseParent)!==databaseParent)fail("Provider source database parent is not canonical.");
        const leaf=databaseParent===data.path?data:pin(c,databaseParent,true);
        const database=pin(c,databasePath,false,2*1024*1024*1024);
        held.push(...c.pins.splice(from));let closed=false;const children=new Set<()=>void>();
        const close=()=>{
          if(closed)return;closed=true;parent.children.delete(close);
          const errors:unknown[]=[];for(const child of [...children])try{child();}catch(error){errors.push(error);}
          for(const p of held.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(error){errors.push(error);}
          if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,"Provider source data pins failed to close.");
        };
        const check=()=>{
          try {
            if(closed)fail("Provider source runtime data lease is closed.");parent.check();
            for(const p of held)assertPin(c,p);
            if(c.fs.realpathSync(leaf.path)!==leaf.path||c.fs.realpathSync(database.path)!==database.path
              ||c.fs.realpathSync(release.path)!==release.path||!absent(c,journalPath)
              ||sourceMetadata(c,stateFile)!==stateJSON||sourceMetadata(c,fenceFile)!==fenceJSON)fail("Provider source runtime data observation changed.");
          }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source data observation and cleanup failed.");}throw error;}
        };
        const verifyCurrent=async()=>{
          try{check();await lease.verifyCurrent();check();}catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source data verification and cleanup failed.");}throw error;}
        };
        result=Object.freeze({databasePath:database.path,dataDirectory:data.path,releaseDirectory:release.path,fence:active.fence,assertCurrent:check,verifyCurrent,close});
        check();sourceRuntimeDataLeases.set(result,{check,parent,grant:lease,children,containerRetained:false});parent.children.add(close);parent.dataRetained=true;
      }catch(error){
        const errors:unknown[]=[error];for(const p of held.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(cleanup){errors.push(cleanup);}
        try{releasePins(c,from);}catch(cleanup){errors.push(cleanup);}
        if(errors.length>1)throw new AggregateError(errors,"Provider source data retention failed.");throw error;
      }
    });
    assertProviderSourceRuntimeDataLease(result!);return result!;
  }catch(error){try{result?.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source data publication failed.");}throw error;}
}

export interface ProviderSourceContainerLease {
  readonly containerId:string;
  readonly pid:number;
  readonly birth:string;
  assertCurrent():void;
  verifyCurrent():Promise<void>;
  close():void;
}
type SourceContainerContext={check:()=>void;data:ProviderSourceRuntimeDataLease;scope:SourceRuntimeDataContext;children:Set<()=>void>;workerRetained:boolean};
const sourceContainerLeases=new WeakMap<ProviderSourceContainerLease,SourceContainerContext>();
function sourceWorkerChannelFor(context:SourceRuntimeDataContext):SourceWorkerChannelContext|undefined {
  const channel=bridgeWorkerChannels.get(context.parent.bridge)?.get(context.parent.input.grantId);
  if(!channel)return undefined;channel.check();
  if(channel.containerId()!==context.parent.input.containerId||JSON.stringify(channel.binding)!==JSON.stringify(context.grant.binding))fail("Provider source channel ownership differs.");
  return channel;
}
const SOURCE_CONTAINER_PROJECTION=`{"identity":${CONTAINER_PROJECTION},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"apparmor":{{json .AppArmorProfile}},"workingDirectory":{{json .Config.WorkingDir}}}`;
const SOURCE_MASKED_PATHS=["/proc/asound","/proc/acpi","/proc/kcore","/proc/keys","/proc/latency_stats","/proc/timer_list","/proc/timer_stats","/proc/sched_debug","/proc/scsi","/sys/firmware","/sys/devices/virtual/powercap"];
const SOURCE_READONLY_PATHS=["/proc/bus","/proc/fs","/proc/irq","/proc/sys","/proc/sysrq-trigger"];
function sourceContainerObservation(encoded:string,data:ProviderSourceRuntimeDataLease,context:SourceRuntimeDataContext,originalChannel?:SourceWorkerChannelContext|null):{pid:number;encoded:string} {
  const {parent,grant}=context,c=parent.context,binding=grant.binding;
  const text=encoded.endsWith("\n")?encoded.slice(0,-1):encoded;let value:Row;
  try{value=JSON.parse(text);}catch{fail("Provider source container profile is invalid.");}
  if(text.includes("\uFFFD")||JSON.stringify(value)!==text||!exact(value,["identity","host","mounts","apparmor","workingDirectory"]))fail("Provider source container profile is invalid.");
  containerObservation(JSON.stringify(value.identity),parent.input,binding,parent.registered.domain,"started");
  const h=value.host,empty=(v:unknown)=>v===null||Array.isArray(v)&&v.length===0;
  if(!h||typeof h!=="object"||Array.isArray(h)||h.ReadonlyRootfs!==true||h.Privileged!==false||h.Init!==true||h.AutoRemove!==false||h.OomKillDisable!==false&&h.OomKillDisable!==null
    ||JSON.stringify(h.CapDrop)!=='["ALL"]'||!empty(h.CapAdd)
    ||![ '["no-new-privileges=true"]','["no-new-privileges"]' ].includes(JSON.stringify(h.SecurityOpt))
    ||h.PidMode!==""||h.IpcMode!=="private"||h.UsernsMode!==""||h.CgroupnsMode!=="private"||h.NetworkMode!=="bridge"||h.Runtime!=="runc"||h.CgroupParent!==""
    ||h.Memory!==536870912||h.MemorySwap!==536870912||h.NanoCpus!==1000000000||h.PidsLimit!==128
    ||["Binds","VolumesFrom","Devices","DeviceRequests","Ulimits","Dns","DnsOptions","DnsSearch","ExtraHosts","Links","GroupAdd","DeviceCgroupRules","BlkioWeightDevice","BlkioDeviceReadBps","BlkioDeviceWriteBps","BlkioDeviceReadIOps","BlkioDeviceWriteIOps"].some(key=>!empty(h[key]))
    ||["CpuShares","CpuPeriod","CpuQuota","CpuRealtimePeriod","CpuRealtimeRuntime","BlkioWeight","CpuCount","CpuPercent"].some(key=>h[key]!==undefined&&h[key]!==0)
    ||h.CpusetCpus!==""||h.CpusetMems!==""||h.Sysctls!==undefined&&h.Sysctls!==null&&JSON.stringify(h.Sysctls)!=="{}"
    ||h.UTSMode!==""||h.Isolation!==""||h.VolumeDriver!==""||h.ContainerIDFile!==""||h.Cgroup!==""||h.ShmSize!==67108864||h.MemoryReservation!==0||h.MemorySwappiness!==null||h.OomScoreAdj!==0||h.PublishAllPorts!==false||h.IOMaximumIOps!==0||h.IOMaximumBandwidth!==0
    ||JSON.stringify(h.MaskedPaths)!==JSON.stringify(SOURCE_MASKED_PATHS)||JSON.stringify(h.ReadonlyPaths)!==JSON.stringify(SOURCE_READONLY_PATHS)
    ||!exact(h.Tmpfs,["/tmp","/run"])||h.Tmpfs["/tmp"]!=="rw,noexec,nosuid,nodev,size=64m,mode=1777"||h.Tmpfs["/run"]!=="rw,noexec,nosuid,nodev,size=8m,mode=755"
    ||!exact(h.LogConfig,["Type","Config"])||h.LogConfig.Type!=="local"||!exact(h.LogConfig.Config,["max-size","max-file"])||h.LogConfig.Config["max-size"]!=="10m"||h.LogConfig.Config["max-file"]!=="3"
    ||value.apparmor!=="docker-default"||value.workingDirectory!=="/app")fail("Provider source container differs from the supported default security/resource profile.");
  const ports=h.PortBindings;
  if(!ports||typeof ports!=="object"||Array.isArray(ports)||Object.keys(ports).length>1)fail("Provider source container port topology differs.");
  for(const [port,bindings] of Object.entries(ports))if(!/^[1-9][0-9]{0,4}\/tcp$/u.test(port)||Number(port.slice(0,-4))>65535||!Array.isArray(bindings)||bindings.length!==1
    ||!exact(bindings[0],["HostIp","HostPort"])||bindings[0].HostIp!=="127.0.0.1"||!match(bindings[0].HostPort,/^[1-9][0-9]{0,4}$/u)||Number(bindings[0].HostPort)>65535)fail("Provider source container port topology differs.");
  const expected=[{target:"/app",source:data.releaseDirectory,rw:false},{target:"/data",source:data.dataDirectory,rw:true},{target:"/run/clank-source",source:c.path.join(c.service.path,"handoff","catalogs",binding.catalogId),rw:false}];
  const channel=originalChannel===undefined?sourceWorkerChannelFor(context):originalChannel;if(channel)expected.push({target:"/run/clank-source-worker",source:channel.mountSource,rw:false});
  if(!Array.isArray(value.mounts)||value.mounts.length!==expected.length)fail("Provider source container mount topology differs.");
  for(const wanted of expected){const mounts=value.mounts.filter((m:Row)=>m.Destination===wanted.target);
    if(mounts.length!==1||!exact(mounts[0],["Type","Source","Destination","Mode","RW","Propagation"])||mounts[0].Type!=="bind"||mounts[0].Source!==wanted.source||mounts[0].Mode!==""||mounts[0].RW!==wanted.rw||mounts[0].Propagation!=="rprivate")fail("Provider source container mount topology differs.");}
  // Docker builds the observed Mounts array from a map, so its order can
  // vary across identical inspections. Validate the exact unique topology
  // first, then compare that already-approved set in destination order.
  return {pid:value.identity[12],encoded:JSON.stringify({...value,mounts:expected.map(w=>value.mounts.find((m:Row)=>m.Destination===w.target))})};
}
function sourceProcText(c:Context,path:string,maximum=65536):string {
  const before=c.fs.lstatSync(path);if(!before.isFile()||before.isSymbolicLink())fail("Provider source process metadata is unavailable.");
  const fd=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_NOFOLLOW|c.fs.constants.O_NONBLOCK);
  try{const held=c.fs.fstatSync(fd);if(!held.isFile()||held.dev!==before.dev||held.ino!==before.ino)fail("Provider source process metadata changed.");
    const bytes=new Uint8Array(maximum+1);let length=0;while(length<bytes.length){const n=c.fs.readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
    const visible=c.fs.lstatSync(path);if(visible.dev!==held.dev||visible.ino!==held.ino||length>maximum)fail("Provider source process metadata changed.");return new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length));
  }finally{c.fs.closeSync(fd);}
}
function sourceProcess(c:Context,pid:number,containerId:string,binding:Row,channel?:SourceWorkerChannelContext,observeChannel?:()=>void):{birth:string;namespaces:Record<string,string>} {
  const root=`/proc/${pid}`,stat=sourceProcText(c,root+"/stat"),end=stat.lastIndexOf(") "),fields=stat.slice(end+2).trim().split(/\s+/u);
  if(end<1||stat.slice(0,stat.indexOf(" "))!==String(pid)||fields.length<20||!["R","S","D","I"].includes(fields[0])||!match(fields[19],/^[1-9][0-9]{0,19}$/u))fail("Provider source process identity is unavailable.");
  const rows=new Map<string,string>();for(const line of sourceProcText(c,root+"/status").split("\n")){const colon=line.indexOf(":");if(colon!==-1){const key=line.slice(0,colon);if(rows.has(key))fail();rows.set(key,line.slice(colon+1).trim());}}
  if(rows.get("Uid")?.split(/\s+/u).some(v=>v!==String(binding.uid))||rows.get("Uid")?.split(/\s+/u).length!==4
    ||rows.get("Gid")?.split(/\s+/u).some(v=>v!==String(binding.gid))||rows.get("Gid")?.split(/\s+/u).length!==4
    ||rows.get("Groups")!==String(binding.gid)
    ||["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].some(key=>rows.get(key)!=="0000000000000000")||rows.get("NoNewPrivs")!=="1"||rows.get("Seccomp")!=="2"
    ||sourceProcText(c,root+"/attr/current").trim()!=="docker-default (enforce)")fail("Provider source process security profile differs.");
  const cgroup=sourceProcText(c,root+"/cgroup"),groups=cgroup.trim().split("\n");
  if(groups.length!==1||!groups[0].startsWith("0::/")||!(groups[0].endsWith("/docker/"+containerId)||groups[0].endsWith("/docker-"+containerId+".scope")))fail("Provider source process is outside its supported container cgroup.");
  const groupPath=groups[0].slice(3);if(groupPath.includes("\\")||groupPath.split("/").slice(1).some(v=>!v||v==="."||v===".."))fail("Provider source process cgroup is invalid.");
  const base="/sys/fs/cgroup"+groupPath;
  for(const [file,expected] of [["memory.max","536870912"],["memory.swap.max","0"],["memory.high","max"],["memory.oom.group","0"],["pids.max","128"],["cpu.max","100000 100000"],["cpu.weight","100"],["cgroup.freeze","0"]]){
    if(sourceProcText(c,base+"/"+file,4096).trim()!==expected)fail("Provider source process kernel resource limits differ.");
  }
  const mounts=sourceProcText(c,root+"/mountinfo").trim().split("\n").map(line=>line.split(" "));
  const requiredMounts=[["/","ro"],["/app","ro"],["/data","rw"],["/run/clank-source","ro"]];
  if(channel){if(observeChannel)observeChannel();else channel.check();requiredMounts.push(["/run/clank-source-worker","ro"]);}
  for(const [target,option] of requiredMounts){
    const entries=mounts.filter(row=>row[4]===target);if(entries.length!==1||entries[0].length<10||!entries[0][5].split(",").includes(option))fail("Provider source process kernel mount permissions differ.");
  }
  const namespaces:Record<string,string>={};for(const name of ["mnt","pid","net","ipc","cgroup","user"]){const link=c.fs.readlinkSync(root+"/ns/"+name),local=c.fs.readlinkSync("/proc/self/ns/"+name);
    if(!match(link,new RegExp("^"+name+":\\[[0-9]+\\]$","u"))||(name==="user"?link!==local:link===local))fail("Provider source process namespaces differ.");namespaces[name]=link;}
  return {birth:fields[19],namespaces};
}
/** Original native proof only; serialized observations cannot mint this lease. */
export function assertProviderSourceContainerLease(value:ProviderSourceContainerLease):void {
  const retained=sourceContainerLeases.get(value);if(!retained)fail("A genuine provider source container lease is required.");retained.check();
}
/** Retain a running local default-profile source. This does not establish readiness or writer stop. */
export async function retainProviderSourceContainer(data:ProviderSourceRuntimeDataLease):Promise<ProviderSourceContainerLease> {
  const scope=sourceRuntimeDataLeases.get(data);if(!scope)fail("A genuine provider source runtime data lease is required.");scope.check();
  const {parent,grant}=scope,c=parent.context,client=domains.get(parent.registered.domain)?.client;if(!client)fail();let lease:ProviderSourceContainerLease|undefined,pendingClose:(()=>void)|undefined;
  try {
    // This dedicated lane retains data/catalog proof around native process and
    // Docker awaits without releasing any other operation's descriptor stack.
    await exclusive(parent.registered.owner,async()=>{
      scope.check();if(scope.containerRetained)fail("Provider source container cannot be duplicated or recycled.");
      await verifyDomain(parent.registered.owner,parent.registered.domain,true);scope.check();
      const args=["container","inspect","--format",SOURCE_CONTAINER_PROJECTION,parent.input.containerId];
      const response=await runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});scope.check();
      const channel=sourceWorkerChannelFor(scope),observed=sourceContainerObservation(response.stdout,data,scope),process=sourceProcess(c,observed.pid,parent.input.containerId,grant.binding,channel);
      const root=`/proc/${observed.pid}/root`,held:number[]=[],children=new Set<()=>void>();let closed=false;
      const close=()=>{if(closed)return;closed=true;scope.children.delete(close);const errors:unknown[]=[];
        for(const child of [...children])try{child();}catch(error){errors.push(error);}
        for(const fd of held.splice(0).reverse())try{c.fs.closeSync(fd);}catch(error){errors.push(error);}
        if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,"Provider source process pins failed to close.");};
      pendingClose=close;
      // Numeric /proc magic links intentionally follow the already-observed
      // process. Retain namespaces as well as its root so inode numbers cannot
      // be recycled while this capability lives; recheck birth after opening.
      const fd=c.fs.openSync(root,c.fs.constants.O_RDONLY|c.fs.constants.O_DIRECTORY);held.push(fd);
      // Process/mount observation must survive retirement of the three-task
      // initializer. Retain its original directory independently; this grants
      // no new channel task, readiness, write or stop authority.
      let observeChannel:(()=>void)|undefined;
      if(channel){
        channel.check();const path=channel.mountSource,before=c.fs.lstatSync(path),descriptor=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_DIRECTORY|c.fs.constants.O_NOFOLLOW);held.push(descriptor);
        observeChannel=()=>{for(const stat of [c.fs.fstatSync(descriptor),c.fs.lstatSync(path)]){
          if(!stat.isDirectory()||stat.dev!==before.dev||stat.ino!==before.ino||stat.uid!==grant.binding.uid||stat.gid!==grant.binding.gid||(stat.mode&0o777)!==0o700)fail("Provider source channel mount observation changed.");
        }if(c.fs.realpathSync(path)!==path)fail("Provider source channel mount path changed.");};observeChannel();
      }
      const namespacePins=Object.entries(process.namespaces).map(([name,link])=>{
        const descriptor=c.fs.openSync(`/proc/${observed.pid}/ns/${name}`,c.fs.constants.O_RDONLY);held.push(descriptor);
        const stat=c.fs.fstatSync(descriptor);if(String(stat.ino)!==link.slice(name.length+2,-1))fail("Provider source namespace pin identity differs.");return {descriptor,dev:stat.dev,ino:stat.ino};
      });
      const mounted=[{target:"/app",source:data.releaseDirectory},{target:"/data",source:data.dataDirectory},{target:"/run/clank-source",source:c.path.join(c.service.path,"handoff","catalogs",grant.binding.catalogId)}];
      if(channel)mounted.push({target:"/run/clank-source-worker",source:channel.mountSource});
      const identity=mounted.map(m=>{const s=c.fs.lstatSync(m.source);return {...m,dev:s.dev,ino:s.ino};});
      const check=()=>{
        try{if(closed)fail("Provider source container lease is closed.");scope.check();const fresh=sourceProcess(c,observed.pid,parent.input.containerId,grant.binding,channel,observeChannel);
          if(fresh.birth!==process.birth||JSON.stringify(fresh.namespaces)!==JSON.stringify(process.namespaces))fail("Provider source process identity changed.");
          for(const p of namespacePins){const retained=c.fs.fstatSync(p.descriptor);if(retained.dev!==p.dev||retained.ino!==p.ino)fail("Provider source namespace pin changed.");}
          const retained=c.fs.fstatSync(fd),visible=c.fs.statSync(root);if(retained.dev!==visible.dev||retained.ino!==visible.ino)fail("Provider source process root changed.");
          for(const m of identity){const from=c.fs.lstatSync(m.source),actual=c.fs.statSync(`/proc/self/fd/${fd}`+m.target);
            if(!from.isDirectory()||!actual.isDirectory()||from.dev!==m.dev||from.ino!==m.ino||actual.dev!==m.dev||actual.ino!==m.ino)fail("Provider source native mount identity differs.");}
        }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source process observation and cleanup failed.");}throw error;}
      };
      const verifyCurrent=async()=>{
        try{check();await exclusive(parent.registered.owner,async()=>{check();await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();
          const next=await runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});check();const confirmed=sourceContainerObservation(next.stdout,data,scope,channel??null);if(confirmed.encoded!==observed.encoded){const before=JSON.parse(observed.encoded),after=JSON.parse(confirmed.encoded);const field=["identity","host","mounts","apparmor","workingDirectory"].find(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));fail("Provider source container configuration changed ("+field+").");}
          await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();},parent.bridge);check();
        }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source container verification and cleanup failed.");}throw error;}
      };
      if(channel)children.add(channel.invalidate);
      lease=Object.freeze({containerId:parent.input.containerId,pid:observed.pid,birth:process.birth,assertCurrent:check,verifyCurrent,close});
      check();sourceContainerLeases.set(lease,{check,data,scope,children,workerRetained:false});scope.children.add(close);scope.containerRetained=true;
      await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();
    },parent.bridge);
    assertProviderSourceContainerLease(lease!);return lease!;
  }catch(error){try{pendingClose?.();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source container publication failed.");}throw error;}
}
/** Private host worker authority. Observation facades and caller paths cannot mint it. */
export interface ProviderSourceWorkerLease {
  execute(request:unknown):Promise<unknown>;
  assertCurrent():void;
  close():Promise<void>;
}
const sourceWorkerLeases=new WeakMap<object,{current:()=>void;path:string;binding:Readonly<Record<string,any>>;provider:true}>();
export function assertProviderSourceWorkerLease(value:ProviderSourceWorkerLease):void {
  const retained=sourceWorkerLeases.get(value);if(!retained)fail("A genuine provider source worker lease is required.");retained.current();
}
export async function retainProviderSourceWorker(container:ProviderSourceContainerLease):Promise<ProviderSourceWorkerLease> {
  const retained=sourceContainerLeases.get(container);if(!retained)fail("A genuine provider source container lease is required.");retained.check();
  const channel=sourceWorkerChannelFor(retained.scope);channel?.check();
  const wire=await import("./provider-source-worker-wire.ts");retained.check();
  const sandbox=await import("./sqlite-sandbox.ts");retained.check();
  const task=await import("./sqlite-task.ts");retained.check();
  await container.verifyCurrent();retained.check();
  channel?.check();
  if(retained.workerRetained)fail("Provider source worker authority cannot be duplicated or recycled.");
  const {data,scope}=retained,binding=scope.grant.binding,path=scope.parent.context.path;
  let closed=false,reason:unknown,sequence=0,backupId:string|undefined,flight:Promise<unknown>|undefined;
  let workspacePins:Array<import("./sqlite-sandbox.ts").PinnedSQLiteDirectory>=[],cleanupFlight:Promise<void>|undefined;
  const cleanup=():Promise<void>=>{
    if(cleanupFlight)return cleanupFlight;
    const pins=workspacePins;workspacePins=[];
    cleanupFlight=(async()=>{const errors:unknown[]=[];for(const pin of pins.reverse())try{await pin.close();}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,"Provider source worker directory cleanup is uncertain.");})();
    // Parent observation close is synchronous. Retain asynchronous cleanup's
    // outcome for close(), without turning its rejection into an unhandled one.
    void cleanupFlight.catch(()=>{});return cleanupFlight;
  };
  const invalidate=(error:unknown=new Error("Provider source worker lease is closed."))=>{
    if(closed)return;closed=true;reason=error;retained.children.delete(invalidate);if(!flight)void cleanup();
  };
  const current=()=>{
    if(closed)throw reason;
    try{retained.check();channel?.check();
      const fs=scope.parent.context.fs;
      for(const pin of workspacePins){sandbox.assertPinnedSQLiteDirectory(pin);const held=fs.fstatSync(pin.fd),visible=fs.lstatSync(pin.path);
        if(!held.isDirectory()||!visible.isDirectory()||held.dev!==visible.dev||held.ino!==visible.ino
          ||held.uid!==binding.uid||visible.uid!==binding.uid||held.gid!==binding.gid||visible.gid!==binding.gid
          ||(held.mode&0o777)!==0o700||(visible.mode&0o777)!==0o700||fs.realpathSync(pin.path)!==pin.path)fail("Provider source worker workspace changed.");
      }
    }catch(error){invalidate(error);throw error;}
  };
  const execute=(value:unknown):Promise<unknown>=>{
    try{current();if(flight)fail("Provider source worker already has an owned operation.");}catch(error){return Promise.reject(error);}
    let request:ReturnType<typeof wire.sourceSQLiteTaskRequest>;
    try{request=wire.sourceSQLiteTaskRequest(value);
      if(request.operation!==["backup","inspect","verify"][sequence]||backupId!==undefined&&request.backupId!==backupId)fail("Provider source worker sequence differs.");
    }catch(error){invalidate(error);return Promise.reject(error);}
    sequence++;backupId??=request.backupId;
    const pending=(async()=>{
            try{
        await container.verifyCurrent();current();
        const parent=path.dirname(data.databasePath),root=path.join(parent,".clank-source-recovery-"+binding.sourceIncarnation),base=path.join(root,"base");
        // The original source owns creation. Never adopt/create a replacement
        // workspace or interpret client descriptors as host capabilities.
        if(workspacePins.length===0)for(const name of [parent,root,base,path.join(base,".stage-"+request.backupId)]){
          const pin=await sandbox.pinSQLiteDirectory(name,false,lease);workspacePins.push(pin);current();
        }
        const file=path.join(base,(request.operation==="verify"?".verified-":".snapshot-")+request.backupId+".sqlite");
        const module=request.operation==="backup"?"migrations":"inspection";
        const operation=request.operation==="backup"?"stageSQLiteBackup":request.operation==="inspect"?"inspectSQLite":"verifySQLite";
        const args=request.operation==="backup"?[data.databasePath,file,file+".tmp-"+request.temporaryId]:[file];
        const result=await task.runSQLiteTask(module,operation,args,workspacePins,lease);current();
        await container.verifyCurrent();current();
        if(sequence===3){await cleanup();current();}return result;
      }catch(error){
        invalidate(error);try{await cleanup();}catch(failure){throw new AggregateError([error,failure],"Provider source worker operation and cleanup failed.");}throw error;
      }
    })();
    flight=pending.catch(error=>{invalidate(error);throw error;}).finally(()=>{flight=undefined;if(sequence===3)invalidate();});
    return flight;
  };
  const close=async()=>{
    invalidate();const owned=flight??cleanupFlight;if(!owned)return;let timer:ReturnType<typeof setTimeout>|undefined;
    // An expired wait is uncertainty, never an owned-close receipt. The original
    // flight stays owned; each native task retains its slot until its own close.
    try{await Promise.race([owned,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Provider source worker close is unsettled after its 10000ms deadline.")),10000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  const lease:ProviderSourceWorkerLease=Object.freeze({execute,assertCurrent:current,close});
  current();sourceWorkerLeases.set(lease,Object.freeze({current,path:data.databasePath,binding,provider:true}));retained.children.add(invalidate);retained.workerRetained=true;
  return lease;
}
Object.defineProperty(retainProviderSourceWorker,SQLITE_INTERNAL,{value:Object.freeze({sourceContext(token:object){return sourceWorkerLeases.get(token);}})});

function containerTimestamp(value:unknown):boolean {
  if(typeof value!=="string"||value==="0001-01-01T00:00:00Z")return false;
  const parts=/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]{1,9})?Z$/u.exec(value);
  if(!parts||value.startsWith("0000"))return false;const date=new Date(parts[1]+"Z");
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,19)===parts[1];
}
function containerObservation(output:string,input:ProviderHandoffContainerInput,binding:Row,domain:ProviderHandoffDomain,state:"created"|"started"):string {
  const text=output.endsWith("\n")?output.slice(0,-1):output;let row:any;
  try{row=JSON.parse(text);}catch{fail("Provider handoff container observation is invalid.");}
  // Deliberately conservative: Go escaping or integer-like label-key ordering
  // that differs from JSON.stringify refuses. No normalization of native data.
  if(text.includes("\uFFFD")||JSON.stringify(row)!==text||!Array.isArray(row)||row.length!==17)fail("Provider handoff container observation is invalid.");
  const labels=row[4],expected:Record<string,string>={
    "run.clank.managed":"provider-runtime","run.clank.owner":domain.owner,"run.clank.project":binding.projectId,"run.clank.release":binding.releaseId,"run.clank.generation":String(binding.generation),"run.clank.role":"web","run.clank.instance":"0",
    "run.clank.handoff.protocol":binding.protocol,"run.clank.handoff.node":domain.nodeId,"run.clank.handoff.daemon":domain.daemonId,"run.clank.handoff.domain":binding.domainSha256,"run.clank.handoff.enablement":binding.enablementId,"run.clank.handoff.index":binding.indexId,"run.clank.handoff.catalog":binding.catalogId,"run.clank.handoff.grant":binding.grantId,"run.clank.handoff.binding":input.bindingSha256,"run.clank.handoff.capsule":binding.capsuleSha256,"run.clank.handoff.incarnation":binding.sourceIncarnation,
  };
  if(!labels||typeof labels!=="object"||Array.isArray(labels)||Object.keys(labels).length>128)fail("Provider handoff container labels are invalid.");
  const encoder=new TextEncoder();
  for(const [key,value] of Object.entries(labels)){if(key.includes("\0")||encoder.encode(key).length>256||typeof value!=="string"||value.includes("\0")||encoder.encode(value).length>4096||key.startsWith("run.clank.")&&!Object.hasOwn(expected,key))fail("Provider handoff container labels are invalid.");}
  if(Object.entries(expected).some(([key,value])=>!Object.hasOwn(labels,key)||labels[key]!==value)||row[0]!==input.containerId||row[1]!==binding.imageId||row[2]!==binding.imageId||row[3]!==`${binding.uid}:${binding.gid}`||row[5]!=="no"||row[6]!==0||row[15]!==0||!containerTimestamp(row[16]))fail("Provider handoff container identity differs.");
  const running=state==="started",zero="0001-01-01T00:00:00Z";
  if(row[7]!== (running?"running":"created")||row[8]!==running||row[9]!==false||row[10]!==false||row[11]!==false||(running?!positive(row[12]):row[12]!==0)||(running?!containerTimestamp(row[13]):row[13]!==zero)||row[14]!==zero)fail("Provider handoff container phase differs.");
  return text;
}
function containerFrame(bridge:ProviderHandoffBridge,registered:BridgeContext,rootJSON?:string,stateJSON?:string,live=true){
  const {context:c}=bridgeCurrent(bridge,live),root=marker(c);
  if(!root?.bridge||root.bridge.enablement_id!==registered.enablementId||root.domain_json!==boundedJSON(registered.domain,4096)||rootJSON!==undefined&&JSON.stringify(root)!==rootJSON)fail("Provider handoff container root changed.");
  const state=inspect(c,root),from=c.pins.length;let indexRows:Row;
  try{const handoff=directory(c,c.service,"handoff");indexRows=databaseAt(c,handoff,"index.sqlite",INDEX_MAX,false,db=>{
    bridgeIndex(c,db,root,index(c,db,root));return {index:singleton(db,"clank_provider_handoff_index"),bridge:singleton(db,"clank_provider_handoff_bridge_index")};
  });}finally{releasePins(c,from);}
  if(live&&state.barriers||stateJSON!==undefined&&JSON.stringify({state,index:indexRows})!==stateJSON)fail("Provider handoff container consulted state changed.");
  current(registered.owner);return {c,root,state,indexRows};
}
async function recordContainer(bridge:ProviderHandoffBridge,value:ProviderHandoffContainerInput,next:"created"|"started"):Promise<ProviderHandoffContainerAcknowledgment>{
  const input=containerInput(value,next),registered=bridgeCurrent(bridge,true),c=registered.context;
  // The existing owner lane stays held until retained pins close and publication.
  // Keeping cleanup inside this dedicated operation avoids releasing/re-adopting
  // paths across exclusive()'s final await, or closing the next operation's pins.
  if(c.queued>=16)fail("Provider handoff private operation capacity exceeded.");c.queued++;
  const previousTask=c.tail;let release!:()=>void;c.tail=new Promise(resolve=>{release=resolve;});let retained:number|undefined;
  try{
    await previousTask;bridgeCurrent(bridge,true);retained=c.pins.length;
    const initial=containerFrame(bridge,registered),handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");
    pin(c,c.path.join(handoff.path,"index.sqlite"),false,INDEX_MAX);
    for(const project of initial.state.projects){const target=directory(c,catalogs,project.catalog_id);pin(c,c.path.join(target.path,"catalog.sqlite"),false,BRIDGE_CATALOG_MAX);}
    const {root,state,indexRows}=containerFrame(bridge,registered),rootJSON=JSON.stringify(root),stateJSON=JSON.stringify({state,index:indexRows});
    await verifyDomain(registered.owner,registered.domain,true);
    containerFrame(bridge,registered,rootJSON,stateJSON);
    const project=state.projects.find(row=>row.project_id===input.projectId),source=state.states.find(row=>row.projectId===input.projectId),grant=source?.grant;
    if(!project||!source||!grant||grant.grant_id!==input.grantId||grant.binding_sha256!==input.bindingSha256)fail("Provider handoff container grant differs.");
    const retry=source.version===input.expectedVersion+1&&grant.state===next&&grant.container_id===input.containerId;
    const previous=next==="created"?"issued":"created";
    if(!retry&&(source.version!==input.expectedVersion||grant.state!==previous||grant.container_id!==(next==="created"?null:input.containerId)))fail("Provider handoff container transition conflicts.");
    const binding=grantBinding(JSON.parse(grant.binding_json),root,project),client=domains.get(registered.domain)?.client;
    if(!client)fail("A genuine owner-bound Docker client is required.");
    const options={timeoutMs:root.bridge.limits.controlTimeoutMs,maxOutputBytes:32768},args=["container","inspect","--format",CONTAINER_PROJECTION,input.containerId];
    const observed=await runProviderDockerClient(client,args,options);
    containerFrame(bridge,registered,rootJSON,stateJSON);
    const observation=containerObservation(observed.stdout,input,binding,registered.domain,next);
    await verifyDomain(registered.owner,registered.domain,true);
    containerFrame(bridge,registered,rootJSON,stateJSON);
    const expected={...grant,state:next,container_id:input.containerId},version=input.expectedVersion+1;
    const wanted={version,grant:expected,transfer:null,operations:[],spools:[]},post={...state,states:state.states.map(row=>row.projectId===input.projectId?{...row,...wanted}:row)},postJSON=JSON.stringify({state:post,index:indexRows}),from=c.pins.length;
    try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);
      databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,!retry,(db,file)=>{db.exec(retry?"BEGIN":"BEGIN IMMEDIATE");try{
        if(catalog(c,db,root,project).barrier)fail();const before=bridgeCatalog(c,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
        if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...before})!==JSON.stringify(source))fail("Provider handoff container preimage changed.");
        if(!retry){
          if(db.prepare(GRANT_CONTAINER_CAS).run(next,input.containerId,grant.grant_id,grant.binding_json,grant.binding_sha256,grant.grant_secret_sha256,grant.control_secret_sha256,grant.state,grant.container_id).changes!==1||JSON.stringify(bridgeRecords(db).grant)!==JSON.stringify(expected))fail("Provider handoff container grant readback differs.");
          const mirror=c.hash(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX));
          if(db.prepare(CONTAINER_MIRROR_CAS).run(mirror,registered.enablementId,before.version,metadata.records_sha256).changes!==1)fail("Provider handoff container mirror write differs.");
        }
        commitBridgeFile(c,registered.owner,db,file,target,()=>{if(catalog(c,db,root,project).barrier||JSON.stringify(bridgeCatalog(c,db,root,project,state.reservations))!==JSON.stringify(wanted))fail("Provider handoff container durable readback differs.");});
      }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    }finally{releasePins(c,from);}
    containerFrame(bridge,registered,rootJSON,postJSON);
    const confirmed=await runProviderDockerClient(client,args,options);
    containerFrame(bridge,registered,rootJSON,postJSON);
    if(containerObservation(confirmed.stdout,input,binding,registered.domain,next)!==observation)fail("Provider handoff container observation changed.");
    await verifyDomain(registered.owner,registered.domain,true);
    containerFrame(bridge,registered,rootJSON,postJSON);
    return Object.freeze({grantId:input.grantId,bindingSha256:input.bindingSha256,containerId:input.containerId,state:next,version});
  }catch(error){if(c.mode==="bridge-live")c.mode="cleanup-only";c.failed=true;throw error;}
  finally{
    // Close every retained descriptor even if a close fails; never publish
    // success after cleanup uncertainty, and always release this lane's waiter.
    try{let failure:unknown;if(retained!==undefined)for(const p of c.pins.splice(retained).reverse()){try{c.fs.closeSync(p.fd);}catch(error){failure??=error;}}
      if(failure){if(c.mode==="bridge-live")c.mode="cleanup-only";c.failed=true;throw failure;}
    }finally{c.queued--;release();}
  }
}

type ProviderHandoffRevocationInput=Readonly<{projectId:string;grantId:string;bindingSha256:string;containerId:string|null;expectedVersion:number}>;
type ProviderHandoffRevocationAcknowledgment=Readonly<{grantId:string;bindingSha256:string;containerId:string|null;state:"revoked";version:number}>;
function revocationInput(value:ProviderHandoffRevocationInput):ProviderHandoffRevocationInput {
  const keys=["projectId","grantId","bindingSha256","containerId","expectedVersion"],copy:Row={};
  if(!value||typeof value!=="object"||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length)fail("Provider handoff revocation input is invalid.");
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!("value" in descriptor))fail("Provider handoff revocation requires own data fields.");copy[key]=descriptor.value;}
  if(!match(copy.projectId,ID)||!match(copy.grantId,UUID)||!match(copy.bindingSha256,DIGEST)||copy.containerId!==null&&!match(copy.containerId,DIGEST)||!positive(copy.expectedVersion)||copy.expectedVersion<2||copy.expectedVersion>Number.MAX_SAFE_INTEGER-1)fail("Provider handoff revocation input is invalid.");
  return Object.freeze(copy) as unknown as ProviderHandoffRevocationInput;
}
/** Durable authority revocation only. Retains observed container identity; does not stop a process. */
export async function revokeProviderHandoffGrant(bridge:ProviderHandoffBridge,value:ProviderHandoffRevocationInput):Promise<ProviderHandoffRevocationAcknowledgment>{
  const input=revocationInput(value),registered=bridgeCurrent(bridge),c=registered.context;
  if(c.queued>=16)fail("Provider handoff private operation capacity exceeded.");c.queued++;
  const previousTask=c.tail;let release!:()=>void;c.tail=new Promise(resolve=>{release=resolve;});let retained:number|undefined;
  try{
    await previousTask;bridgeCurrent(bridge);retained=c.pins.length;
    const initial=containerFrame(bridge,registered,undefined,undefined,false),handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");
    pin(c,c.path.join(handoff.path,"index.sqlite"),false,INDEX_MAX);
    for(const project of initial.state.projects){const target=directory(c,catalogs,project.catalog_id);pin(c,c.path.join(target.path,"catalog.sqlite"),false,BRIDGE_CATALOG_MAX);}
    const {root,state,indexRows}=containerFrame(bridge,registered,undefined,undefined,false),rootJSON=JSON.stringify(root),stateJSON=JSON.stringify({state,index:indexRows});
    await verifyDomain(registered.owner,registered.domain,true);
    containerFrame(bridge,registered,rootJSON,stateJSON,false);
    const project=state.projects.find(row=>row.project_id===input.projectId),source=state.states.find(row=>row.projectId===input.projectId),grant=source?.grant;
    if(!project||!source||!grant||grant.grant_id!==input.grantId||grant.binding_sha256!==input.bindingSha256||grant.container_id!==input.containerId)fail("Provider handoff revocation grant differs.");
    const retry=source.version===input.expectedVersion+1&&grant.state==="revoked";
    if(!retry&&(source.version!==input.expectedVersion||!["issued","created","started"].includes(grant.state)))fail("Provider handoff revocation transition conflicts.");
    const expected={...grant,state:"revoked"},version=input.expectedVersion+1;
    const wanted={version,grant:expected,transfer:null,operations:[],spools:[]},post={...state,states:state.states.map(row=>row.projectId===input.projectId?{...row,...wanted}:row)},postJSON=JSON.stringify({state:post,index:indexRows}),from=c.pins.length;
    c.mode="cleanup-only";
    try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);
      databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,!retry,(db,file)=>{db.exec(retry?"BEGIN":"BEGIN IMMEDIATE");try{
        catalog(c,db,root,project);const before=bridgeCatalog(c,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
        if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...before})!==JSON.stringify(source))fail("Provider handoff revocation preimage changed.");
        if(!retry){
          if(db.prepare(GRANT_CONTAINER_CAS).run("revoked",input.containerId,grant.grant_id,grant.binding_json,grant.binding_sha256,grant.grant_secret_sha256,grant.control_secret_sha256,grant.state,grant.container_id).changes!==1||JSON.stringify(bridgeRecords(db).grant)!==JSON.stringify(expected))fail("Provider handoff revocation grant readback differs.");
          const mirror=c.hash(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX));
          if(db.prepare(CONTAINER_MIRROR_CAS).run(mirror,registered.enablementId,before.version,metadata.records_sha256).changes!==1)fail("Provider handoff revocation mirror write differs.");
        }
        commitBridgeFile(c,registered.owner,db,file,target,()=>{catalog(c,db,root,project);if(JSON.stringify(bridgeCatalog(c,db,root,project,state.reservations))!==JSON.stringify(wanted))fail("Provider handoff revocation durable readback differs.");});
      }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    }finally{releasePins(c,from);}
    containerFrame(bridge,registered,rootJSON,postJSON,false);
    await verifyDomain(registered.owner,registered.domain,true);
    containerFrame(bridge,registered,rootJSON,postJSON,false);
    return Object.freeze({grantId:input.grantId,bindingSha256:input.bindingSha256,containerId:input.containerId,state:"revoked",version});
  }catch(error){if(c.mode==="bridge-live")c.mode="cleanup-only";c.failed=true;throw error;}
  finally{
    try{let failure:unknown;if(retained!==undefined)for(const p of c.pins.splice(retained).reverse()){try{c.fs.closeSync(p.fd);}catch(error){failure??=error;}}
      if(failure){if(c.mode==="bridge-live")c.mode="cleanup-only";c.failed=true;throw failure;}
    }finally{c.queued--;release();}
  }
}

/** Historical native observation only. No create/start, readiness or admission. */
export function recordProviderHandoffContainerCreated(bridge:ProviderHandoffBridge,input:ProviderHandoffContainerInput):Promise<ProviderHandoffContainerAcknowledgment>{return recordContainer(bridge,input,"created");}
/** The same immutable container was observed running; this is not liveness proof. */
export function recordProviderHandoffContainerStarted(bridge:ProviderHandoffBridge,input:ProviderHandoffContainerInput):Promise<ProviderHandoffContainerAcknowledgment>{return recordContainer(bridge,input,"started");}

/** Reserve durable bounded quota only. No spool file or publication is created. */
export async function reserveProviderHandoffSpool(bridge:ProviderHandoffBridge,projectId:string,input:Readonly<{reservationId:string;kind:"base"|"tail";maximumBytes:number;inputSha256:string}>):Promise<Readonly<{reservationId:string}>>{
  if(!match(projectId,ID)||!exact(input,["reservationId","kind","maximumBytes","inputSha256"]))fail();const captured=JSON.parse(boundedJSON(input,1024));
  return withBridge(bridge,true,(c,root,state,registered)=>{
    const project=state.projects.find(p=>p.project_id===projectId),source=state.states.find(p=>p.projectId===projectId);
    if(!project||!source?.grant||source.grant.state!=="issued"||!match(captured.reservationId,UUID)||!match(captured.inputSha256,DIGEST)||!["base","tail"].includes(captured.kind)||!positive(captured.maximumBytes)||captured.maximumBytes>(captured.kind==="tail"?8388608:root.bridge.limits.maxArchiveBytes))fail("Provider handoff spool reservation is invalid.");
    const expected={reservation_id:captured.reservationId,project_id:projectId,catalog_id:project.catalog_id,kind:captured.kind,maximum_bytes:captured.maximumBytes,input_sha256:captured.inputSha256},from=c.pins.length;
    try{const handoff=directory(c,c.service,"handoff");databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
      const projects=index(c,db,root),before=bridgeIndex(c,db,root,projects),metadata=singleton(db,"clank_provider_handoff_bridge_index"),existing=before.find(r=>r.reservation_id===captured.reservationId||r.catalog_id===project.catalog_id&&r.kind===captured.kind);
      if(existing){if(JSON.stringify(existing)!==JSON.stringify(expected))fail("Provider handoff spool reservation cannot be rebound.");}
      else{if(metadata.version===Number.MAX_SAFE_INTEGER||before.length>=200||before.reduce((n,r)=>n+r.maximum_bytes,0)+captured.maximumBytes>root.bridge.limits.maxSpoolBytes)fail("Provider handoff spool capacity exceeded.");
        if(db.prepare("INSERT INTO clank_provider_handoff_spool_reservations VALUES(?,?,?,?,?,?)").run(captured.reservationId,projectId,project.catalog_id,captured.kind,captured.maximumBytes,captured.inputSha256).changes!==1)fail();
        const after=reservationRows(db);if(JSON.stringify(after.find(r=>r.reservation_id===captured.reservationId))!==JSON.stringify(expected))fail();const mirror=c.hash(boundedJSON(after,131072));
        if(db.prepare("UPDATE clank_provider_handoff_bridge_index SET version=version+1,reservations_sha256=? WHERE id=1 AND version=? AND reservations_sha256=?").run(mirror,metadata.version,metadata.reservations_sha256).changes!==1)fail();
      }
      commitBridgeFile(c,registered.owner,db,file,handoff,()=>{const after=bridgeIndex(c,db,root,index(c,db,root));if(singleton(db,"clank_provider_handoff_bridge_index").version!==metadata.version+(existing?0:1)||JSON.stringify(after.find(r=>r.reservation_id===captured.reservationId))!==JSON.stringify(expected))fail();});
    }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});}finally{releasePins(c,from);}return Object.freeze({reservationId:captured.reservationId});
  });
}
