/** Private provider ownership, source observations and first-base workers; no readiness or writer-stop proof. */
import { runProviderDockerClient, providerDockerTargetConfiguration, type DockerClient } from "./provider-docker-client.ts";
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
const CAPTURE_KEYS_NAME=".handoff-capture-keys.sqlite",CAPTURE_KEYS_MAX=262144;
const CAPTURE_KEYS_SCHEMA=[`CREATE TABLE clank_provider_capture_key_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),
  enablement_id TEXT NOT NULL,index_id TEXT NOT NULL,domain_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  records_sha256 TEXT NOT NULL CHECK(length(records_sha256)=64)
) STRICT`,`CREATE TABLE clank_provider_capture_keys (
  project_id TEXT PRIMARY KEY NOT NULL,grant_id TEXT NOT NULL UNIQUE,key_id TEXT NOT NULL UNIQUE,
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 4096),
  key_hex TEXT NOT NULL CHECK(length(key_hex)=64)
) STRICT`];
const TARGET_OWNER_NAME=".handoff-target-owner.sqlite",TARGET_OWNER_MAX=65536;
const TARGET_OWNER_SQL=`CREATE TABLE clank_provider_target_owner (
 id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),
 target_id TEXT NOT NULL,enablement_id TEXT NOT NULL,index_id TEXT NOT NULL,domain_sha256 TEXT NOT NULL,
 project_id TEXT NOT NULL,catalog_id TEXT NOT NULL,workspace_name TEXT NOT NULL,
 binding_json TEXT NOT NULL,binding_sha256 TEXT NOT NULL
) STRICT`;
const TARGET_RESTART_NAME=".handoff-target-restart.sqlite",TARGET_RESTART_MAX=262144;
const TARGET_RESTART_SQL=`CREATE TABLE clank_provider_target_restart (
 id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),
 input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) BETWEEN 1 AND 131072),
 input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64)
) STRICT`;
const TARGET_ADOPTION_NAME=".handoff-target-adoption.sqlite",TARGET_ADOPTION_MAX=262144;
const TARGET_ADOPTION_SQL=`CREATE TABLE clank_provider_target_adoption (
 id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),
 input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) BETWEEN 1 AND 131072),
 input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64)
) STRICT`;
const TARGET_CONDITIONAL_NAME=".handoff-target-conditional.sqlite",TARGET_CONDITIONAL_MAX=1048576;
const TARGET_CONDITIONAL_SQL="CREATE TABLE clank_provider_target_conditional (id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) BETWEEN 1 AND 524288),authentication TEXT NOT NULL CHECK(length(authentication)=64)) STRICT";
function recoveryPin(p:Pin):Row{return {path:p.path,dev:p.dev,ino:p.ino,directory:p.directory,maximum:p.maximum};}
function recoveryPathsCurrent(c:Context,paths:Row[]):void{if(!Array.isArray(paths)||paths.length>8)fail("Conditional native path inventory exceeds its bound.");const from=c.pins.length;try{for(const input of paths){if(!input||typeof input.path!=="string"||!c.path.isAbsolute(input.path)||input.path!==c.fs.realpathSync(input.path))fail("Conditional native path differs.");const retained=pin(c,input.path,input.directory,input.maximum);if(retained.dev!==input.dev||retained.ino!==input.ino)fail("Conditional native identity differs.");}}finally{releasePins(c,from);}}
function recoverySourceIndex(c:Context,root:Row):Row{const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff");return databaseAt(c,handoff,"index.sqlite",INDEX_MAX,false,db=>{bridgeIndex(c,db,root,index(c,db,root));return {index:singleton(db,"clank_provider_handoff_index"),bridge:singleton(db,"clank_provider_handoff_bridge_index")};});}finally{releasePins(c,from);}}
const verifiedTargetRestartFiles=new WeakMap<ProviderServiceOwnership,readonly string[]>();
export function providerServiceRestartFiles(owner:ProviderServiceOwnership):readonly string[]{const c=current(owner),files=verifiedTargetRestartFiles.get(owner)??[];return files.length&&!absent(c,c.path.join(c.service.path,TARGET_CONDITIONAL_NAME))?Object.freeze([...new Set([...files,TARGET_CONDITIONAL_NAME])]):files;}
const ID=/^[A-Za-z0-9_-]{1,128}$/u,OWNER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,DAEMON=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,DIGEST=/^[a-f0-9]{64}$/u;
const OWNER_MAX=65536,INDEX_MAX=262144,CATALOG_MAX=65536,BRIDGE_CATALOG_MAX=16777216;
type Row=Record<string,any>;
type Pin={fd:number;path:string;anchor:string;dev:number;ino:number;directory:boolean;maximum:number;normalize:boolean};
export interface ProviderServiceOwnership {readonly fs:any;readonly path:any;readonly root:string;readonly serviceDirectory:string;close():void}
/** Original native owner check; it never changes admission mode. */
export function assertProviderServiceOwnership(value:ProviderServiceOwnership):void{current(value);}
export interface ProviderHandoffDomain {readonly protocol:"clank-provider-handoff-domain/1";readonly nodeId:string;readonly daemonId:string;readonly owner:string}
export interface ProviderHandoffBarrierInput {readonly identity:{readonly handoffId:string;readonly source:{readonly projectId:string;readonly nodeId:string;readonly releaseId:string;readonly generation:number};readonly targetNodeId:string;readonly targetGeneration:number;readonly artifactSha256:string};readonly stepId:string;readonly sourceCapsuleSha256:string;readonly sourceIncarnation:string}
type Context={fs:any;path:any;Database:any;hash:(text:string)=>string;randomUUID:()=>string;root:Pin;service:Pin;file:Pin;keyFile?:Pin;keyFrame?:string;database:any;pins:Pin[];closed:boolean;admitted:boolean;mode:ProviderHandoffOwnerMode;marked:boolean;failed:boolean;queued:number;tail:Promise<void>};
const owners=new WeakMap<ProviderServiceOwnership,Context>();
const domains=new WeakMap<ProviderHandoffDomain,{owner:ProviderServiceOwnership;client:DockerClient}>();
const schemaCache=new Map<string,string>();
type ProviderHandoffOwnerMode="pre-admission"|"ordinary-admitted"|"bridge-live"|"cleanup-only"|"closed";
export interface ProviderHandoffBridgeLimits {readonly maxProjects:number;readonly maxOperations:number;readonly maxArchiveBytes:number;readonly maxBatchEntries:number;readonly maxBatchBytes:number;readonly maxCaptureTransactionBytes:number;readonly maxCaptureStateBytes:number;readonly maxJournalEntries:number;readonly maxJournalBytes:number;readonly maxSpoolBytes:number;readonly controlTimeoutMs:number}
export interface ProviderHandoffBridge {readonly enablementId:string;readonly mode:ProviderHandoffOwnerMode}
type BridgeContext={owner:ProviderServiceOwnership;domain:ProviderHandoffDomain;enablementId:string};
const bridges=new WeakMap<ProviderHandoffBridge,BridgeContext>();
export interface ProviderSourceTransferLease {
 readonly projectId:string;readonly grantId:string;
 assertCurrent():void;verifyCurrent():Promise<void>;close():void;
}
type SourceTransferContext={bridge:ProviderHandoffBridge;binding:Readonly<Record<string,any>>;grant:Readonly<Record<string,any>>;limits:ProviderHandoffBridgeLimits;check():void;verify():Promise<void>;close():void;accept(before:string,after:string):void};
const sourceTransfers=new WeakMap<ProviderSourceTransferLease,SourceTransferContext>();
const ownerSourceTransfers=new WeakMap<ProviderServiceOwnership,Set<SourceTransferContext>>();
function acceptSourceTransferCatalog(owner:ProviderServiceOwnership,before:string,after:string):void{
 for(const held of ownerSourceTransfers.get(owner)??[])held.accept(before,after);
}
function closeSourceTransfers(owner:ProviderServiceOwnership):void{
 for(const held of [...(ownerSourceTransfers.get(owner)??[])])held.close();
}
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
type SourceServiceContext={owner:ProviderServiceOwnership;bridge:ProviderHandoffBridge;check:()=>void;acceptReady(grantId:string,record:string):void;acceptCatalog(grantId:string,before:string,after:string):void};
const ownerSourceServices=new WeakMap<ProviderServiceOwnership,SourceServiceContext>();
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
type SourceGrantLeaseContext={check:()=>void;context:Context;registered:BridgeContext;bridge:ProviderHandoffBridge;input:ProviderHandoffContainerInput;children:Set<()=>void>;dataRetained:boolean;acceptState(before:string,after:string):void};
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
/** Copy bounded policy before a provider yields its ordinary runtime. */
export function captureProviderHandoffLimits(value:unknown):ProviderHandoffBridgeLimits{return bridgeLimits(value);}
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
function sourceReadiness(c:Context,grant:Row,binding:Row):Row {
  let ready:Row,packet:Row;try{ready=JSON.parse(grant.readiness_json);packet=JSON.parse(ready.initialization);}catch{fail("Provider source readiness is invalid.");}
  if(!exact(ready,["protocol","channel","initialization","initializationSha256"])||ready.protocol!=="clank-provider-source-ready/1"
    ||boundedJSON(ready,8192)!==grant.readiness_json||c.hash(grant.readiness_json)!==grant.readiness_sha256
    ||typeof ready.initialization!=="string"||new TextEncoder().encode(ready.initialization).length>4096||c.hash(ready.initialization)!==ready.initializationSha256
    ||!exact(ready.channel,["bindingSha256","containerId","sourceIncarnation","channelId"])||ready.channel.bindingSha256!==grant.binding_sha256
    ||ready.channel.containerId!==grant.container_id||ready.channel.sourceIncarnation!==binding.sourceIncarnation||!match(ready.channel.channelId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u))fail("Provider source readiness binding differs.");
  const identity={bindingSha256:grant.binding_sha256,containerId:grant.container_id,sourceIncarnation:binding.sourceIncarnation},completion=packet.completion;
  if(!exact(packet,["protocol","identity","nonce","completion","mac"])||packet.protocol!=="clank-source-initialization/1"
    ||JSON.stringify(packet.identity)!==JSON.stringify(identity)||!match(packet.nonce,/^[A-Za-z0-9_-]{43}$/u)||Buffer.from(packet.nonce,"base64url").toString("base64url")!==packet.nonce||!match(packet.mac,DIGEST)
    ||JSON.stringify({...packet})!==ready.initialization||!exact(completion,["captureEpoch","keyId","schemaHash","baseBackupId","observedCursor"])
    ||!match(completion.captureEpoch,UUID)||completion.keyId!==binding.capture.keyId||!match(completion.schemaHash,DIGEST)
    ||!match(completion.baseBackupId,/^bk_[1-9][0-9]{0,15}_[A-Za-z0-9_-]{24}$/u)||!Number.isSafeInteger(Number(completion.baseBackupId.split("_")[1]))
    ||!exact(completion.observedCursor,["epoch","sequence","digest"])||completion.observedCursor.epoch!==completion.captureEpoch||completion.observedCursor.sequence!==0||completion.observedCursor.digest!=="0".repeat(64))fail("Provider source readiness initialization differs.");
  return ready;
}
function sourceEnrollment(c:Context,grant:Row,transfer:Row,operations:Row[]):void {
  let enrollment:Row,input:Row;
  try{enrollment=JSON.parse(transfer.enrollment_json);input=JSON.parse(operations[0]?.input_json);}catch{fail("Provider source enrollment encoding is invalid.");}
  const binding=enrollment.binding,identity=binding?.identity,source=identity?.source,original=JSON.parse(grant.binding_json),cursor=binding?.initialCursor;
  if(!exact(enrollment,["protocol","grantId","bindingSha256","containerId","binding"])||enrollment.protocol!=="clank-provider-source-enrollment/1"
    ||enrollment.grantId!==grant.grant_id||enrollment.bindingSha256!==grant.binding_sha256||enrollment.containerId!==grant.container_id
    ||boundedJSON(enrollment,16384)!==transfer.enrollment_json||c.hash(transfer.enrollment_json)!==transfer.enrollment_sha256
    ||!exact(binding,["identity","baseOperationId","baseArchiveSha256","initialCursor"])||!match(binding.baseOperationId,/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)||!match(binding.baseArchiveSha256,DIGEST)
    ||!exact(identity,["handoffId","source","targetNodeId","targetGeneration","artifactSha256"])||!match(identity.handoffId,ID)||!match(identity.targetNodeId,ID)||!positive(identity.targetGeneration)||identity.targetGeneration<=original.generation||identity.artifactSha256!==original.capsuleSha256
    ||!exact(source,["projectId","nodeId","releaseId","generation"])||source.projectId!==original.projectId||!match(source.nodeId,ID)||source.nodeId===identity.targetNodeId||source.releaseId!==original.releaseId||source.generation!==original.generation
    ||!exact(cursor,["epoch","sequence","digest"])||!match(cursor.epoch,UUID)||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||!match(cursor.digest,DIGEST)||cursor.sequence===0&&cursor.digest!=="0".repeat(64))fail("Provider source enrollment binding differs.");
  const canonical={identity:{handoffId:identity.handoffId,source:{projectId:source.projectId,nodeId:source.nodeId,releaseId:source.releaseId,generation:source.generation},targetNodeId:identity.targetNodeId,targetGeneration:identity.targetGeneration,artifactSha256:identity.artifactSha256},baseOperationId:binding.baseOperationId,baseArchiveSha256:binding.baseArchiveSha256,initialCursor:{epoch:cursor.epoch,sequence:cursor.sequence,digest:cursor.digest}};
  if(JSON.stringify(binding)!==JSON.stringify(canonical)||cursor.epoch!==JSON.parse(JSON.parse(grant.readiness_json).initialization).completion.captureEpoch||cursor.sequence>original.capture.maxJournalEntries)fail("Provider source enrollment cursor or canonical encoding differs.");
  const stopped=transfer.phase==="stopped",stopping=["barrier","sealed-tail-retained","stopped"].includes(transfer.phase),fence=stopping?operations.at(stopped?-2:-1):undefined;
  if(transfer.id!==1||transfer.protocol!==2||transfer.handoff_id!==identity.handoffId||!["enrolling","enrolled","barrier","sealed-tail-retained","stopped"].includes(transfer.phase)||operations.length<1||transfer.phase==="enrolling"&&operations.length!==1
    ||!stopping&&[transfer.stop_input_sha256,transfer.quiescence_json,transfer.seal_json,transfer.stop_receipt_json].some(value=>value!==null)||stopping&&(!fence||operations.length<(stopped?3:2)||fence.kind!=="fence"||(!stopped&&transfer.stop_receipt_json!==null)))fail("Provider source enrollment phase is unsupported.");
  const operation=operations[0]!,complete=transfer.phase!=="enrolling",expected={protocol:"clank-source-recovery-operation/1",operation:"enroll",binding};
  if(operation.sequence!==1||operation.step_id!==identity.handoffId||operation.kind!=="enroll"||operation.state!==(complete?"complete":"accepted")
    ||JSON.stringify(input)!==operation.input_json||operation.input_json!==boundedJSON(expected,32768)||operation.input_sha256!==c.hash(operation.input_json))fail("Provider source enrollment operation differs.");
  if(complete){const result=boundedJSON({protocol:"clank-source-enrolled/1",binding},8192);if(operation.result_json!==result||operation.result_sha256!==c.hash(result))fail("Provider source enrollment result differs.");}
  else if(operation.result_json!==null||operation.result_sha256!==null)fail("Provider source enrollment result is premature.");
  let previous=cursor,targetIdentity:string|undefined;
  for(let index=1;index<operations.length-(stopped?2:stopping?1:0);index++){
    const row=operations[index]!,receipt=sourceTargetReceipt(c,row.input_json,grant,binding,previous),hash=c.hash(row.input_json),result=JSON.stringify({protocol:"clank-provider-source-target-acknowledged/1",receiptSha256:hash,cursor:receipt.cursor});
    const target=JSON.stringify({targetId:receipt.targetId,containerId:receipt.containerId,targetCapsuleSha256:receipt.targetCapsuleSha256});if(targetIdentity!==undefined&&targetIdentity!==target)fail("Source target acknowledgment cannot change its original target.");targetIdentity=target;
    if(receipt.kind!=="tail"||row.sequence!==index+1||row.step_id!=="ack_"+hash||row.kind!=="batch"||row.input_sha256!==hash||row.state!=="complete"||row.result_json!==result||row.result_sha256!==c.hash(result))fail("Source target acknowledgment history differs.");previous=receipt.cursor;
  }
  if(stopping){
    const input=sourceStopInput(c,fence!.input_json,grant,binding),hash=c.hash(fence!.input_json),sealed=transfer.phase!=="barrier";
    if(!sourceStopFollowsTarget(input.targetReceipt,operations.slice(0,operations.length-(stopped?2:1)))||fence!.sequence!==operations.length-(stopped?1:0)||fence!.step_id!=="stop_"+hash||fence!.input_sha256!==hash||transfer.stop_input_sha256!==hash||fence!.state!==(sealed?"complete":"accepted"))fail("Source stop intent differs from its acknowledged target.");
    if(sealed){const result=sourceQuiescence(c,fence!.input_json,transfer.seal_json,grant,binding);if(transfer.quiescence_json!==result||fence!.result_json!==result||fence!.result_sha256!==c.hash(result))fail("Source quiescence is not its original seal decision.");}
    else if([transfer.quiescence_json,transfer.seal_json,fence!.result_json,fence!.result_sha256].some(v=>v!==null))fail("Source barrier contains premature quiescence.");
    if(stopped){const receipt=sourceStopReceipt(c,transfer.stop_receipt_json,grant,transfer,binding),row=operations.at(-1)!,hash=c.hash(transfer.stop_receipt_json),result=JSON.stringify({protocol:"clank-provider-source-stopped/1",receiptSha256:hash,cursor:receipt.cursor});
      if(grant.state!=="stopped"||row.sequence!==operations.length||row.step_id!=="stopped_"+transfer.stop_input_sha256||row.kind!=="stop"||row.state!=="complete"||row.input_json!==transfer.stop_receipt_json||row.input_sha256!==hash||row.result_json!==result||row.result_sha256!==c.hash(result))fail("Native source stop decision differs.");}
  }
}
function sourceStopReceipt(c:Pick<Context,"hash">,encoded:string,grant:Row,transfer:Row,binding:Row):Row{
 let receipt:Row;try{receipt=JSON.parse(encoded);}catch{fail("Native source stop receipt encoding differs.");}
 const source=JSON.parse(grant.binding_json),seal=JSON.parse(transfer.seal_json),fields=["protocol","grantId","bindingSha256","sourceIncarnation","containerId","pid","birth","domain","stopInputSha256","sealSha256","identity","cursor","database","dataDirectory","roles"];
 if(!exact(receipt,fields)||receipt.protocol!=="clank-provider-source-stop/1"||JSON.stringify(receipt)!==encoded||Buffer.byteLength(encoded)>32768||receipt.grantId!==grant.grant_id||receipt.bindingSha256!==grant.binding_sha256||receipt.sourceIncarnation!==source.sourceIncarnation||receipt.containerId!==grant.container_id||!positive(receipt.pid)||!match(receipt.birth,/^[1-9][0-9]{0,19}$/u)||!exact(receipt.domain,["protocol","nodeId","daemonId","owner"])||receipt.domain.protocol!=="clank-provider-handoff-domain/1"||c.hash(JSON.stringify(receipt.domain))!==source.domainSha256||receipt.domain.nodeId!==binding.identity.source.nodeId||receipt.stopInputSha256!==transfer.stop_input_sha256||receipt.sealSha256!==c.hash(transfer.seal_json)||JSON.stringify(receipt.identity)!==JSON.stringify(binding.identity)||JSON.stringify(receipt.cursor)!==JSON.stringify(seal.through)||JSON.stringify(receipt.roles)!==JSON.stringify(["web"])||[receipt.database,receipt.dataDirectory].some(v=>!exact(v,["dev","ino"])||!Number.isSafeInteger(v.dev)||v.dev<0||!positive(v.ino)))fail("Native source stop receipt binding differs.");return receipt;
}
function sourceStopInput(c:Pick<Context,"hash">,encoded:string,grant:Row,binding:Row):Row{
 let input:Row;try{input=JSON.parse(encoded);}catch{fail("Source stop input encoding differs.");}
 if(!exact(input,["protocol","targetReceipt"])||input.protocol!=="clank-provider-source-stop-intent/1"||typeof input.targetReceipt!=="string"||JSON.stringify(input)!==encoded||Buffer.byteLength(encoded)>8192)fail("Source stop input differs.");
 sourceTargetReceipt(c,input.targetReceipt,grant,binding);return input;
}
function sourceQuiescence(c:Pick<Context,"hash">,inputJSON:string,sealJSON:string,grant:Row,binding:Row):string{
 const input=sourceStopInput(c,inputJSON,grant,binding),receipt=JSON.parse(input.targetReceipt);let seal:Row;try{seal=JSON.parse(sealJSON);}catch{fail("Source quiescence seal encoding differs.");}
 if(!exact(seal,["protocol","identity","baseOperationId","baseArchiveSha256","initialCursor","baseBackupId","keyId","after","through","committedAt","schemaHash","stateHash","inputDigest","authentication"])||seal.protocol!=="clank-pitr-source-seal/1"||JSON.stringify(seal)!==sealJSON||Buffer.byteLength(sealJSON)>16384||JSON.stringify(seal.identity)!==JSON.stringify(binding.identity)||seal.baseOperationId!==binding.baseOperationId||seal.baseArchiveSha256!==binding.baseArchiveSha256||JSON.stringify(seal.initialCursor)!==JSON.stringify(binding.initialCursor)||JSON.stringify(seal.after)!==JSON.stringify(receipt.cursor)||seal.baseBackupId!==receipt.baseBackupId||seal.keyId!==receipt.keyId||seal.schemaHash!==receipt.schemaHash||seal.inputDigest!==c.hash(JSON.stringify({...binding,after:receipt.cursor}))||!positive(seal.committedAt)||![seal.stateHash,seal.inputDigest,seal.authentication].every(v=>match(v,DIGEST))
   ||!exact(seal.through,["epoch","sequence","digest"])||seal.through.epoch!==receipt.cursor.epoch||!Number.isSafeInteger(seal.through.sequence)||seal.through.sequence<receipt.cursor.sequence||seal.through.sequence>JSON.parse(grant.binding_json).capture.maxJournalEntries||!match(seal.through.digest,DIGEST)||seal.through.sequence===receipt.cursor.sequence&&(JSON.stringify(seal.through)!==JSON.stringify(receipt.cursor)||seal.stateHash!==receipt.stateHash))fail("Source quiescence seal binding differs.");
 return JSON.stringify({protocol:"clank-provider-source-quiescence/1",stopInputSha256:c.hash(inputJSON),targetReceiptSha256:c.hash(input.targetReceipt),sealSha256:c.hash(sealJSON),after:seal.after,cursor:seal.through});
}
function sourceTargetReceipt(c:Pick<Context,"hash">,encoded:string,grant:Row,binding:Row,after?:Row):Row{
 let receipt:Row;try{receipt=JSON.parse(encoded);}catch{fail("Source target receipt encoding differs.");}
 const fields=["protocol","targetId","containerId","targetCapsuleSha256","sourceGrantId","sourceCapsuleSha256","identity","kind","sourceSpoolSha256","after","cursor","baseBackupId","stateHash","schemaHash","keyId"],source=JSON.parse(grant.binding_json),cursor=receipt.cursor;
 if(!exact(receipt,fields)||receipt.protocol!=="clank-provider-target-transfer-receipt/1"||JSON.stringify(receipt)+"\n"!==encoded||Buffer.byteLength(encoded)>8192||!match(receipt.targetId,UUID)||![receipt.containerId,receipt.targetCapsuleSha256,receipt.sourceSpoolSha256,receipt.stateHash,receipt.schemaHash].every(v=>match(v,DIGEST))||receipt.sourceGrantId!==grant.grant_id||receipt.sourceCapsuleSha256!==source.capsuleSha256||JSON.stringify(receipt.identity)!==JSON.stringify(binding.identity)||!["base","tail"].includes(receipt.kind)||receipt.keyId!==source.capture.keyId||typeof receipt.baseBackupId!=="string"
   ||!exact(cursor,["epoch","sequence","digest"])||cursor.epoch!==binding.initialCursor.epoch||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||cursor.sequence>source.capture.maxJournalEntries||!match(cursor.digest,DIGEST)
   ||(receipt.kind==="base"?(receipt.after!==null||receipt.sourceSpoolSha256!==binding.baseArchiveSha256||JSON.stringify(cursor)!==JSON.stringify(binding.initialCursor)||after!==undefined):(!positive(cursor.sequence)||!exact(receipt.after,["epoch","sequence","digest"])||receipt.after.epoch!==cursor.epoch||!Number.isSafeInteger(receipt.after.sequence)||receipt.after.sequence<binding.initialCursor.sequence||receipt.after.sequence>=cursor.sequence||!match(receipt.after.digest,DIGEST)||after&&JSON.stringify(receipt.after)!==JSON.stringify(after))))fail("Source target receipt binding or cursor differs.");
 return receipt;
}
/** A base-only stop binds the enrolled checkpoint directly; tails require the exact durable acknowledgment. */
function sourceStopFollowsTarget(encoded:string,operations:Row[]):boolean{
 const receipt=JSON.parse(encoded);return receipt.kind==="base"?operations.length===1:operations.at(-1)?.input_json===encoded;
}
function sourceSpools(c:Context,grant:Row,spools:Row[],reservations?:Row[],originalCaptureEpoch?:string):void{
  const binding=JSON.parse(grant.binding_json),seen=new Set<string>();
  for(const row of spools){let manifest:Row,request:Row;try{manifest=JSON.parse(row.manifest_json);request=JSON.parse(manifest.input);}catch{fail("Source spool manifest encoding differs.");}
    const output=manifest.output,kind=request.operation==="checkpoint"?"base":request.operation==="batch"?"tail":null;
    if(!kind||seen.has(kind)||row.kind!==kind||row.state!=="ready"||!match(row.reservation_id,UUID)||boundedJSON(manifest,8192)!==row.manifest_json||c.hash(row.manifest_json)!==row.manifest_sha256
      ||!exact(manifest,["protocol","reservationId","grantId","bindingSha256","containerId","input","output"])||manifest.protocol!=="clank-provider-source-spool-file/2"||manifest.reservationId!==row.reservation_id||manifest.grantId!==grant.grant_id||manifest.bindingSha256!==grant.binding_sha256||manifest.containerId!==grant.container_id
      ||typeof manifest.input!=="string"||Buffer.byteLength(manifest.input)>3072||JSON.stringify(request)!==manifest.input||request.protocol!=="clank-source-recovery-operation/1"
      ||!exact(output,["protocol","sourceIncarnation","kind","inputSha256","resultSha256","bytes"])||output.protocol!=="clank-source-recovery-output/1"||output.sourceIncarnation!==binding.sourceIncarnation||output.kind!==kind||output.inputSha256!==c.hash(manifest.input)||!match(output.resultSha256,DIGEST)||!positive(output.bytes))fail("Source spool manifest binding differs.");
    if(reservations){const reservation=reservations.find(value=>value.catalog_id===binding.catalogId&&value.kind===kind);if(!reservation||reservation.reservation_id!==row.reservation_id||output.bytes>reservation.maximum_bytes)fail("Source spool has no exact reserved capacity.");}
    if(kind==="base"){
      if(!exact(request,["protocol","operation","operationId","nodeId"])||!match(request.operationId,/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)||!match(request.nodeId,ID))fail("Source base spool operation differs.");
    }else{
      const after=request.after,epoch=originalCaptureEpoch??JSON.parse(JSON.parse(grant.readiness_json).initialization).completion.captureEpoch;
      if(!exact(request,Object.hasOwn(request,"throughSequence")?["protocol","operation","after","throughSequence"]:["protocol","operation","after"])||!exact(after,["epoch","sequence","digest"])||after.epoch!==epoch||!Number.isSafeInteger(after.sequence)||after.sequence<0||!match(after.digest,DIGEST)||after.sequence===0&&after.digest!=="0".repeat(64)
        ||Object.hasOwn(request,"throughSequence")&&(!Number.isSafeInteger(request.throughSequence)||request.throughSequence<after.sequence))fail("Source tail spool cursor differs.");
    }
    seen.add(kind);
  }
}
function bridgeCatalog(c:Context,db:any,root:Row,project:Row,reservations:Row[]):Row {
  const row=singleton(db,"clank_provider_handoff_bridge_state"),records=bridgeRecords(db),grant=records.grant;
  if(row.id!==1||row.protocol!==2||row.enablement_id!==root.bridge.enablement_id||!positive(row.version)||!match(row.records_sha256,DIGEST)||records.operations.length>root.bridge.limits.maxOperations||records.spools.length>2||c.hash(boundedJSON(records,BRIDGE_CATALOG_MAX))!==row.records_sha256)fail("Provider handoff catalog mirror is invalid.");
  // Semantic validation does not mint ownership. Every live observer retains
  // the exact catalog frame installed by its original owning transition.
  if(!records.transfer&&records.operations.length)fail("Provider handoff source control records are unsupported by this foundation.");
  if(grant){let binding;try{binding=grantBinding(JSON.parse(grant.binding_json),root,project);}catch{fail("Provider handoff source binding is invalid.");}
    const readied=grant.state==="ready"||["revoked","stopped"].includes(grant.state)&&grant.readiness_json!==null,observed=grant.state==="created"||grant.state==="started"||readied||grant.state==="revoked"&&grant.container_id!==null,minimum=readied?(grant.state==="ready"?5:6):grant.state==="started"||grant.state==="revoked"&&observed?4:observed?3:2;
    if(row.version<minimum||grant.id!==1||grant.protocol!==2||grant.grant_id!==binding.grantId||boundedJSON(binding,4096)!==grant.binding_json||c.hash(grant.binding_json)!==grant.binding_sha256||!match(grant.grant_secret_sha256,DIGEST)||!match(grant.control_secret_sha256,DIGEST)||!["issued","created","started","ready","revoked","stopped"].includes(grant.state)||grant.state==="stopped"&&grant.readiness_json!==null&&records.transfer?.phase!=="stopped"||(observed?!match(grant.container_id,DIGEST):grant.container_id!==null)||(!readied&&(grant.readiness_json!==null||grant.readiness_sha256!==null)))fail("Provider handoff source grant state is unsupported.");
    if(readied)sourceReadiness(c,grant,binding);
    if(records.spools.length){if(!readied||!["ready","revoked","stopped"].includes(grant.state))fail("Source spools require original readiness.");sourceSpools(c,grant,records.spools,reservations);}
    if(records.transfer){
      if(!readied||!["ready","revoked","stopped"].includes(grant.state))fail("Provider source transfer requires its original readiness.");sourceEnrollment(c,grant,records.transfer,records.operations);
      const stopped=records.transfer.phase==="stopped",stopping=["barrier","sealed-tail-retained","stopped"].includes(records.transfer.phase),version=(records.transfer.phase==="enrolling"?6:7)+records.spools.length+2*(records.operations.length-1-(stopped?2:stopping?1:0))+(stopping?(records.transfer.phase==="barrier"?1:stopped?3:2):0)+(grant.state==="revoked"?1:0);if(row.version!==version)fail("Provider source enrollment catalog version differs.");
    }
    else if(records.spools.length&&row.version!==5+records.spools.length+(grant.state==="revoked"?1:0))fail("Provider source spool catalog version differs.");
  }else if(records.transfer||reservations.some(r=>r.catalog_id===project.catalog_id))fail("Provider handoff reservation has no retained grant.");
  return {version:row.version,...records};
}
const sourceInitializationReaders=new WeakMap<object,{current():void;failure():string|undefined;attest(nonce:string,completion:Readonly<Record<string,unknown>>):string;initializeControl(token:object):Promise<void>;refreshControl():Promise<void>}>();
/** Private failure evidence from an original reader; never supplies admission. */
export async function providerSourceInitializationFailure(token:object):Promise<string|undefined>{
 const {openBackend}=await import("./backend.ts");return (openBackend as any)[SQLITE_INTERNAL].sourceRuntimeFailure(token);
}
/** Original captured initialization only. This is not host readiness/write admission. */
export async function attestProviderSourceInitialization(token:object,challenge:string):Promise<string>{
const{openBackend}=await import("./backend.ts");
const context=(openBackend as any)[SQLITE_INTERNAL].sourceContext(token);
const completion=context.initialization(),reader=sourceInitializationReaders.get(context.reader);
if(!reader)fail("A genuine original source initialization reader is required.");
reader.current();
const Buffer=(globalThis as any).Buffer;
// The backend captures native bytes before its first await. This immutable
// projection cannot be changed while the private owner lookup is pending.
if(!match(challenge,/^[A-Za-z0-9_-]{43}$/u)||Buffer.from(challenge,"base64url").toString("base64url")!==challenge)fail("Invalid original source initialization nonce.");
await reader.refreshControl();context.initialization();reader.current();
const response=reader.attest(challenge,completion);
await reader.refreshControl();context.initialization();reader.current();return response;
}
/** Renew only the original authenticated channel; an expired owner cannot revive. */
export async function refreshProviderSourceControl(token:object):Promise<void>{
const{openBackend}=await import("./backend.ts"),context=(openBackend as any)[SQLITE_INTERNAL].sourceContext(token),reader=sourceInitializationReaders.get(context.reader);
if(!reader)fail("A genuine original source control reader is required.");reader.current();await reader.refreshControl();reader.current();
}
/** Original source constructor only; authenticated control is still not write admission. */
export async function initializeProviderSourceControl(token:object):Promise<void>{
  const {openBackend}=await import("./backend.ts"),context=(openBackend as any)[SQLITE_INTERNAL].sourceContext(token);
  context.initialization();const reader=sourceInitializationReaders.get(context.reader);if(!reader)fail("A genuine original source initialization reader is required.");
  await reader.initializeControl(token);context.initialization();reader.current();
}
/** Private bootstrap reader. It never admits a request or writes provider state. */
export async function openProviderSourceReader(encoded:string){
  if(typeof encoded!=="string"||new TextEncoder().encode(encoded).length>16384)fail("Invalid source bootstrap.");
  const input=JSON.parse(encoded);if(JSON.stringify(input)!==encoded)fail("Source bootstrap must use canonical JSON.");encoded="";
  const fields=["protocol","binding","bindingSha256","containerId","catalogPath","grantSecret","controlSecret","recoveryKey"],controlled=input.protocol==="clank-provider-source-bootstrap/3",remote=controlled||input.protocol==="clank-provider-source-bootstrap/2";
  if(!exact(input,controlled?[...fields,"workerChannel","controlChannel"]:remote?[...fields,"workerChannel"]:fields)||!remote&&input.protocol!=="clank-provider-source-bootstrap/1"||input.catalogPath!=="/run/clank-source/catalog.sqlite"||!match(input.bindingSha256,DIGEST)||!match(input.containerId,DIGEST))fail("Invalid source bootstrap.");
  const fsName="node:fs",pathName="node:path",sqliteName="node:sqlite",cryptoName="node:crypto";
  const [fs,path,{DatabaseSync},crypto]=await Promise.all([import(fsName),import(pathName),import(sqliteName),import(cryptoName)]);
  const process=(globalThis as any).process,Buffer=(globalThis as any).Buffer,secrets:Uint8Array[]=[];
  const hash=(value:string|Uint8Array)=>crypto.createHash("sha256").update(value).digest("hex");
  const c={fs,path,Database:DatabaseSync,hash,pins:[],marked:true} as unknown as Context;
  let closed=false,version=0,recorded="",worker:Awaited<ReturnType<typeof import("./provider-source-worker-wire.ts").openSourceWorkerSocketClient>>|undefined;
  let control:Awaited<ReturnType<typeof import("./provider-source-worker-wire.ts").openSourceControlSocketClient>>|undefined;
  let controlProtocol:ReturnType<typeof import("./provider-source-worker-wire.ts").createSourceControlClientProtocol>|undefined,controlStarted=false;
  let pulseTimer:ReturnType<typeof setTimeout>|undefined,pulseFlight:Promise<void>|undefined;
  let controlInitialization:string|undefined,controlInitialized=false,controlOperationFailed=false,readyObserved=false,lastAcknowledged=0n,controlFailure:string|undefined;
  let renewControl:(()=>Promise<void>)|undefined;
  type ObservedCatalog={version:number;recordsSha256:string;enrollment:string|null;phase:string|null;spools:string;stopInput?:string;seal?:string};
  let ownedCatalog:ObservedCatalog|undefined,pendingCatalog:ObservedCatalog|undefined;
  let acknowledgedCatalogVersion=0,lastStopSeal:string|undefined;
  const controlNow=()=>((globalThis as any).process.hrtime.bigint() as bigint);

  const close=()=>{
    if(closed)return;closed=true;if(pulseTimer!==undefined)clearTimeout(pulseTimer);const failures:unknown[]=[];
    for(const cleanup of [()=>controlProtocol?.close(),()=>control?.close(),()=>worker?.close()])try{cleanup();}catch(error){failures.push(error);}
    for(const key of secrets)key.fill(0);try{releasePins(c,0);}catch(error){failures.push(error);}
    if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Original source reader cleanup failed.");
  };
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
      if(controlInitialized&&controlNow()-lastAcknowledged>=2000000000n)fail("Original source control acknowledgement expired.");
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
        // Only the next frame proposed on this original authenticated control
        // stream may advance a source catalog. Native semantic validity alone
        // never permits adopting a later version or a restored old frame.
        if(pendingCatalog&&state.version===pendingCatalog.version&&mirror===pendingCatalog.recordsSha256){ownedCatalog=pendingCatalog;pendingCatalog=undefined;}
        const expectedVersion=grant?.state==="ready"&&ownedCatalog?ownedCatalog.version:({created:3,started:4,ready:5} as Row)[grant?.state];
        if(!grant||grant.id!==1||grant.protocol!==2||grant.grant_id!==binding.grantId||grant.binding_json!==json||grant.binding_sha256!==input.bindingSha256||grant.grant_secret_sha256!==hash(secrets[0])||grant.control_secret_sha256!==hash(secrets[1])||!["created","started","ready"].includes(grant.state)||state.version!==expectedVersion||grant.container_id!==input.containerId)fail("Source grant does not permit bootstrap initialization.");
        if(ownedCatalog){if(mirror!==ownedCatalog.recordsSha256||(records.transfer?.enrollment_json??null)!==ownedCatalog.enrollment||(records.transfer?.phase??null)!==ownedCatalog.phase||JSON.stringify(records.spools)!==ownedCatalog.spools)fail("Original source catalog frame differs.");if(records.transfer)sourceEnrollment(c,grant,records.transfer,records.operations);sourceSpools(c,grant,records.spools);if((records.transfer?.stop_input_sha256??null)!==(ownedCatalog.stopInput?hash(ownedCatalog.stopInput):null)||(records.transfer?.seal_json??null)!==(ownedCatalog.seal??null))fail("Original source stop frame differs.");}
        else if(records.transfer||records.operations.length||records.spools.length)fail("Source catalog has no original transfer frame.");
        readyObserved=false;
        if(grant.state==="ready"){
          if(!controlled||!controlInitialization)fail("Source readiness requires its original control initialization.");
          const ready=sourceReadiness(c,grant,binding);
          if(ready.initialization!==controlInitialization||JSON.stringify(ready.channel)!==JSON.stringify(input.controlChannel))fail("Source readiness differs from its original control acknowledgement.");readyObserved=true;
        }else if(grant.readiness_json!==null||grant.readiness_sha256!==null)fail("Source bootstrap readiness is premature.");
        db.exec("COMMIT");current();version=state.version;recorded=mirror;
      }finally{db?.close();}
      current();worker?.assertCurrent();control?.assertCurrent();
    };
    const assertCurrent=()=>{
      try{checkCurrent();}catch(error){
        controlFailure??=error instanceof Error?error.message.slice(0,512):"Original source reader authority failed.";
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
    const assertWrite=()=>{
      assertCurrent();if(!controlled||!controlInitialized||!readyObserved||controlOperationFailed||pendingCatalog||ownedCatalog&&(ownedCatalog.phase!==null&&ownedCatalog.phase!=="enrolled"||acknowledgedCatalogVersion!==ownedCatalog.version))fail("Source bootstrap grants no ordinary write permission.");
    };
    const result=Object.freeze({binding,key:secrets[2],assertCurrent,assertWrite,close,worker,failure:()=>controlFailure});
sourceInitializationReaders.set(result,{current:assertCurrent,failure:()=>controlFailure,async initializeControl(token){
  if(!controlled)return;assertCurrent();if(controlStarted)fail("Original source control cannot be duplicated or recycled.");controlStarted=true;
  const channel=input.controlChannel;
  if(!exact(channel,["bindingSha256","containerId","sourceIncarnation","channelId"])||channel.bindingSha256!==input.bindingSha256||channel.containerId!==input.containerId||channel.sourceIncarnation!==binding.sourceIncarnation)fail("Source control differs from its original bootstrap.");
  try{
    const wire=await import("./provider-source-worker-wire.ts");assertCurrent();
    controlProtocol=wire.createSourceControlClientProtocol(secrets[1],channel as import("./provider-source-worker-wire.ts").SourceWorkerChannelBinding);
    const acquired=await wire.openSourceControlSocketClient(binding.uid,binding.gid);
    try{assertCurrent();control=acquired;}catch(error){acquired.close();throw error;}
    const challenge=controlProtocol.finish(await control.exchange(controlProtocol.begin("hello")));assertCurrent();
    if(typeof challenge!=="string")fail("Original source control has no host challenge.");
    const initialization=await attestProviderSourceInitialization(token,challenge);assertCurrent();controlInitialization=initialization;
    controlProtocol.finish(await control.exchange(controlProtocol.begin("initialized",initialization)));lastAcknowledged=controlNow();controlInitialized=true;assertCurrent();
    let recoveryOperation:Promise<void>|undefined,resultText:string|undefined,resultId:string|undefined,resultHash:string|undefined,resultOffset=0;
    const pulse=()=>{
      if(closed)return;
      pulseFlight=(async()=>{
        assertCurrent();
        const chunk=resultText===undefined?undefined:JSON.stringify({protocol:"clank-source-recovery-result/1",operationId:resultId,sha256:resultHash,total:resultText.length,offset:resultOffset,contents:resultText.slice(resultOffset,resultOffset+1536)});
        const response=await control!.exchange(controlProtocol!.begin("pulse",undefined,chunk));assertCurrent();
        const command=controlProtocol!.finish(response);lastAcknowledged=controlNow();assertCurrent();
        if(chunk!==undefined){resultOffset+=Math.min(1536,resultText!.length-resultOffset);if(resultOffset===resultText!.length){resultText=undefined;resultId=undefined;resultHash=undefined;resultOffset=0;}}
        if(command!==undefined){
          if(recoveryOperation||resultText!==undefined)fail("Original source already owns a control operation result.");
          const value=JSON.parse(command);
          if(!exact(value,["protocol","operationId","input","limits"])||value.protocol!=="clank-source-recovery-command/1"||!match(value.operationId,UUID)||typeof value.input!=="string"||Buffer.byteLength(value.input)>4096||JSON.stringify(value)!==command
            ||!exact(value.limits,["maxArchiveBytes","maxBatchEntries","maxBatchBytes"])||!positive(value.limits.maxArchiveBytes)||value.limits.maxArchiveBytes>268435456||!positive(value.limits.maxBatchEntries)||value.limits.maxBatchEntries>1000||!positive(value.limits.maxBatchBytes)||value.limits.maxBatchBytes>8388608)fail("Invalid original source recovery command.");
          resultId=value.operationId;
          recoveryOperation=(async()=>{
            const operationInput=JSON.parse(value.input);
            if(operationInput.protocol==="clank-source-spool-prepare/1"){
              assertCurrent();if(!exact(operationInput,["protocol","before","after","manifest"])||!exact(operationInput.before,["version","recordsSha256"])||!exact(operationInput.after,["version","recordsSha256"])
                ||operationInput.before.version!==version||operationInput.before.recordsSha256!==recorded||operationInput.after.version!==version+1||!match(operationInput.after.recordsSha256,DIGEST)||typeof operationInput.manifest!=="string"||pendingCatalog)fail("Original source spool proposal differs.");
              const manifest=JSON.parse(operationInput.manifest),row={kind:manifest.output?.kind,reservation_id:manifest.reservationId,state:"ready",manifest_json:operationInput.manifest,manifest_sha256:hash(operationInput.manifest)},spools=JSON.parse(ownedCatalog?.spools??"[]");
              if(spools.some((value:Row)=>value.kind===row.kind))fail("Original source spool cannot be recycled without a target receipt.");spools.push(row);spools.sort((a:Row,b:Row)=>a.kind<b.kind?-1:1);sourceSpools(c,{binding_json:json,grant_id:binding.grantId,binding_sha256:input.bindingSha256,container_id:input.containerId},spools,undefined,JSON.parse(controlInitialization!).completion.captureEpoch);
              const module=await import("./point-in-time.ts");assertCurrent();await (module.openPointInTimeRecovery as any)[SQLITE_INTERNAL].verifySourceOutput(token,manifest.input,JSON.stringify(manifest.output));assertCurrent();
              pendingCatalog={version:operationInput.after.version,recordsSha256:operationInput.after.recordsSha256,enrollment:ownedCatalog?.enrollment??null,phase:ownedCatalog?.phase??null,spools:JSON.stringify(spools)};
              resultText=JSON.stringify({protocol:"clank-source-spool-prepared/1",proposalSha256:hash(value.input)});resultHash=hash(resultText);return;
            }
            if(operationInput.protocol==="clank-source-catalog-prepare/1"){
              assertCurrent();
              if(!exact(operationInput,["protocol","before","after","enrollment","phase"])||!exact(operationInput.before,["version","recordsSha256"])||!exact(operationInput.after,["version","recordsSha256"])
                ||operationInput.before.version!==version||operationInput.before.recordsSha256!==recorded||operationInput.after.version!==version+1||!match(operationInput.after.recordsSha256,DIGEST)
                ||typeof operationInput.enrollment!=="string"||Buffer.byteLength(operationInput.enrollment)>16384||!["enrolling","enrolled"].includes(operationInput.phase)||pendingCatalog
                ||operationInput.phase==="enrolling"&&(ownedCatalog?.phase!==null&&ownedCatalog!==undefined||version!==5+JSON.parse(ownedCatalog?.spools??"[]").length)||operationInput.phase==="enrolled"&&(!ownedCatalog||ownedCatalog.phase!=="enrolling"||ownedCatalog.enrollment!==operationInput.enrollment))fail("Original source catalog proposal differs.");
              pendingCatalog={version:operationInput.after.version,recordsSha256:operationInput.after.recordsSha256,enrollment:operationInput.enrollment,phase:operationInput.phase,spools:ownedCatalog?.spools??"[]"};
              resultText=JSON.stringify({protocol:"clank-source-catalog-prepared/1",proposalSha256:hash(value.input)});resultHash=hash(resultText);return;
            }
            if(operationInput.protocol==="clank-source-catalog-observe/1"){
              assertCurrent();if(!exact(operationInput,["protocol","version","recordsSha256"])||pendingCatalog||operationInput.version!==ownedCatalog?.version||operationInput.recordsSha256!==ownedCatalog?.recordsSha256)fail("Original source catalog observation differs.");
              // This authenticated request is the original host's confirmation
              // after its exact commit/readback and every observer update. A
              // prepared frame or an unacknowledged native COMMIT cannot resume
              // writes merely because the source sees the proposed new rows.
              acknowledgedCatalogVersion=ownedCatalog!.version;
              resultText=JSON.stringify({protocol:"clank-source-catalog-observed/1",version:ownedCatalog!.version,recordsSha256:ownedCatalog!.recordsSha256});resultHash=hash(resultText);return;
            }
            if(operationInput.protocol==="clank-source-target-prepare/1"){
              assertCurrent();if(!exact(operationInput,["protocol","before","after","receipt"])||!ownedCatalog||ownedCatalog.phase!=="enrolled"||pendingCatalog||!exact(operationInput.before,["version","recordsSha256"])||!exact(operationInput.after,["version","recordsSha256"])||operationInput.before.version!==version||operationInput.before.recordsSha256!==recorded||operationInput.after.version!==version+1||!match(operationInput.after.recordsSha256,DIGEST)||typeof operationInput.receipt!=="string")fail("Original source target proposal differs.");
              const enrollment=JSON.parse(ownedCatalog.enrollment!),spools=JSON.parse(ownedCatalog.spools),tail=spools.find((row:Row)=>row.kind==="tail"),receipt=sourceTargetReceipt(c,{...operationInput}.receipt,{grant_id:binding.grantId,binding_json:json},enrollment.binding);
              if(receipt.kind!=="tail"||!tail||JSON.parse(tail.manifest_json).output.resultSha256!==receipt.sourceSpoolSha256||JSON.stringify(JSON.parse(JSON.parse(tail.manifest_json).input).after)!==JSON.stringify(receipt.after))fail("Original target proposal does not settle the source tail.");
              pendingCatalog={version:operationInput.after.version,recordsSha256:operationInput.after.recordsSha256,enrollment:ownedCatalog.enrollment,phase:ownedCatalog.phase,spools:JSON.stringify(spools.filter((row:Row)=>row.kind!=="tail"))};
              resultText=JSON.stringify({protocol:"clank-source-target-prepared/1",proposalSha256:hash(value.input)});resultHash=hash(resultText);return;
            }
            if(operationInput.protocol==="clank-source-stop-prepare/1"){
              assertCurrent();if(!exact(operationInput,["protocol","before","after","phase","input","stopInputSha256","sealSha256"])||!ownedCatalog||pendingCatalog||!exact(operationInput.before,["version","recordsSha256"])||!exact(operationInput.after,["version","recordsSha256"])||operationInput.before.version!==version||operationInput.before.recordsSha256!==recorded||operationInput.after.version!==version+1||!match(operationInput.after.recordsSha256,DIGEST)||!match(operationInput.stopInputSha256,DIGEST)||!["barrier","sealed-tail-retained"].includes(operationInput.phase))fail("Original source stop proposal differs.");
              const enrollment=JSON.parse(ownedCatalog.enrollment!),records=(()=>{const db=new DatabaseSync(parent.anchor+"/catalog.sqlite",{readOnly:true});try{return bridgeRecords(db);}finally{db.close();}})(),originalGrant={grant_id:binding.grantId,binding_json:json},intentJSON=operationInput.phase==="barrier"?operationInput.input:ownedCatalog.stopInput,intent=sourceStopInput(c,intentJSON,originalGrant,enrollment.binding);
              if(hash(intentJSON)!==operationInput.stopInputSha256||(operationInput.phase==="barrier"?(typeof operationInput.input!=="string"||ownedCatalog.phase!=="enrolled"||operationInput.sealSha256!==null||!sourceStopFollowsTarget(intent.targetReceipt,records.operations)||JSON.parse(ownedCatalog.spools).some((r:Row)=>r.kind==="tail")):(ownedCatalog.phase!=="barrier"||operationInput.input!==null||!lastStopSeal||operationInput.sealSha256!==hash(lastStopSeal))))fail("Original source stop phase or receipt differs.");
              if(operationInput.phase==="sealed-tail-retained")sourceQuiescence(c,intentJSON,lastStopSeal!,originalGrant,enrollment.binding);
              pendingCatalog={...ownedCatalog,version:operationInput.after.version,recordsSha256:operationInput.after.recordsSha256,phase:operationInput.phase,stopInput:intentJSON,...(operationInput.phase==="sealed-tail-retained"?{seal:lastStopSeal}:{})};
              resultText=JSON.stringify({protocol:"clank-source-stop-prepared/1",proposalSha256:hash(value.input)});resultHash=hash(resultText);return;
            }
            const module=await import("./point-in-time.ts");assertCurrent();
            if(operationInput.protocol==="clank-source-recovery-output-release/1"){
              if(!exact(operationInput,["protocol","output"]))fail("Invalid original source output receipt.");
              resultText=await (module.openPointInTimeRecovery as any)[SQLITE_INTERNAL].releaseSourceOutput(token,JSON.stringify(operationInput.output));
            }else resultText=await (module.openPointInTimeRecovery as any)[SQLITE_INTERNAL].operateSource(token,value.input,value.limits);
            assertCurrent();if(operationInput.operation==="seal"&&ownedCatalog?.phase==="barrier"){sourceQuiescence(c,ownedCatalog.stopInput!,resultText!,{grant_id:binding.grantId,binding_json:json},JSON.parse(ownedCatalog.enrollment!).binding);lastStopSeal=resultText;}resultHash=crypto.createHash("sha256").update(resultText).digest("hex");
          })().catch(error=>{
            controlOperationFailed=true;resultText=JSON.stringify({protocol:"clank-source-recovery-error/1",message:error instanceof Error?error.message.slice(0,512):"Original source recovery refused."});resultHash=crypto.createHash("sha256").update(resultText).digest("hex");
          }).finally(()=>{recoveryOperation=undefined;});
        }
        pulseTimer=setTimeout(pulse,resultText===undefined?500:25);pulseTimer.unref?.();
      })().catch(error=>{controlFailure??=error instanceof Error?error.message.slice(0,512):"Original source pulse failed.";try{close();}catch{}}).finally(()=>{pulseFlight=undefined;});
    };
    renewControl=async()=>{
      assertCurrent();
      if(pulseFlight)await pulseFlight;
      else{if(pulseTimer)clearTimeout(pulseTimer);pulse();await pulseFlight;}
      assertCurrent();
    };
    pulseTimer=setTimeout(pulse,500);pulseTimer.unref?.();
  }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original source control failed and cleanup did not settle.");}throw error;}
},async refreshControl(){assertCurrent();if(controlInitialized){if(!renewControl)fail("Original source control is not retained.");await renewControl();assertCurrent();}},attest(nonce,completion){
assertCurrent();
const identity={bindingSha256:input.bindingSha256,containerId:input.containerId,sourceIncarnation:binding.sourceIncarnation};
const key=crypto.createHmac("sha256",secrets[1]).update(JSON.stringify({protocol:"clank-source-initialization-key/1",identity})).digest();
try{
const body={protocol:"clank-source-initialization/1",identity,nonce,completion};
const mac=crypto.createHmac("sha256",key).update(JSON.stringify(body)).digest("hex");
const response=JSON.stringify({...body,mac});
if(Buffer.byteLength(response)>4096)fail("Original source initialization response exceeds its bound.");
assertCurrent();return response;
}finally{key.fill(0);}
}});
return result;
  }catch(error){close();throw error;}
}
function bridgeCurrent(bridge:ProviderHandoffBridge,live=false):BridgeContext&{context:Context}{
  const registered=bridges.get(bridge);if(!registered)fail("A genuine private provider bridge is required.");const c=current(registered.owner);
  if(!["bridge-live","cleanup-only"].includes(c.mode)||live&&c.mode!=="bridge-live")fail("A current live provider bridge is required.");return {...registered,context:c};
}
export function assertProviderHandoffBridge(bridge:ProviderHandoffBridge):void{bridgeCurrent(bridge);}
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
  for(const pin of c.pins)assertPin(c,pin);
  if(c.keyFile)try{assertPin(c,c.keyFile);}catch(error){c.failed=true;throw error;}
  return c;
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
    return ownershipFacade(c,promises,path);
  }catch(error){try{c.database?.close();}finally{releasePins(c,0);}if(typeof (error as any)?.errcode==="number"&&((error as any).errcode&255)===5)throw new Error("Provider service root already has an active writer.");throw error;}
}
const adoptedOwnerClosures=new WeakMap<ProviderServiceOwnership,Set<()=>void>>();
function ownershipFacade(c:Context,promises:any,path:any):ProviderServiceOwnership{
 const owner:ProviderServiceOwnership=Object.freeze({fs:promises,path,root:c.root.path,serviceDirectory:c.service.path,close(){
      if(c.closed||owners.get(owner)!==c)return;c.closed=true;c.mode="closed";const failures:unknown[]=[];
      for(const cleanup of adoptedOwnerClosures.get(owner)??[])try{cleanup();}catch(error){failures.push(error);}
      try{closeWorkerChannels(owner);}catch(error){failures.push(error);}
      try{closeSourceLeases(owner);}catch(error){failures.push(error);}
      try{closeSourceLaunchData(owner);}catch(error){failures.push(error);}
      try{closeTargetWorkspaces(owner);}catch(error){failures.push(error);}
      try{closeSourceTransfers(owner);}catch(error){failures.push(error);}
      try{closeSourceStops(owner);}catch(error){failures.push(error);}
      try{c.database.close();}catch(error){failures.push(error);}
      if(c.keyFile)try{c.fs.closeSync(c.keyFile.fd);}catch(error){failures.push(error);}finally{c.keyFile=undefined;c.keyFrame=undefined;}
      try{releasePins(c,0);}catch(error){failures.push(error);}
      if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Provider service ownership failed to close cleanly.");
    }});owners.set(owner,c);return owner;
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
    if(root.bridge)inspectCaptureKeys(c,root,states);
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
  return exclusive(owner,async()=>{const c=current(owner,true),root=marker(c);const retainedTarget=!absent(c,c.path.join(c.service.path,TARGET_OWNER_NAME));if(!retainedTarget&&[TARGET_RESTART_NAME,TARGET_ADOPTION_NAME,TARGET_CONDITIONAL_NAME].some(name=>!absent(c,c.path.join(c.service.path,name))))fail("Retained target admission metadata is incomplete.");if(retainedTarget&&(!root||!client))fail("Retained target admission refuses ordinary root startup.");inspect(c,root);if(root){if(!client||typeof ownerLabel!=="string"||ownerLabel!==root.domain.owner)fail("Provider handoff requires the original native Docker domain.");const observed=await probe(owner,client,root.domain.nodeId,ownerLabel);if(boundedJSON(observed,4096)!==root.domain_json)fail("Provider handoff Docker execution domain changed.");current(owner,true);const fresh=marker(c);if(!fresh||fresh.domain_sha256!==root.domain_sha256||fresh.index_id!==root.index_id||(inspect(c,fresh).barriers!==0||inspect(c,fresh).grants!==0))fail("Provider handoff barrier refuses ordinary root startup.");}if(retainedTarget){let permission=false;if(!absent(c,c.path.join(c.service.path,TARGET_RESTART_NAME))){await verifyTargetRestartAdmission(owner,client!,root!);permission=true;}if(!absent(c,c.path.join(c.service.path,TARGET_ADOPTION_NAME))){await verifyTargetAdoptionAdmission(owner,client!,root!);permission=true;}if(!permission)fail("Retained target admission refuses ordinary root startup.");}current(owner,true);c.admitted=true;c.mode="ordinary-admitted";});
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
  if(targetWorkspaceReservations.has(owner)||!absent(registered.context,registered.context.path.join(registered.context.service.path,TARGET_OWNER_NAME)))fail("Retained target admission refuses source service startup.");
  if(sourceServiceReservations.has(owner))fail("Provider source service ownership is already reserved.");
  sourceServiceReservations.add(owner);
  const readyGrants=new Map<string,string>(),ownedCatalogs=new Map<string,string>();
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
              const owned=ownedCatalogs.get(catalog.grant.grant_id),version=["ready","stopped"].includes(catalog.grant.state)&&owned?JSON.parse(owned).version:({issued:2,created:3,started:4,ready:5} as Row)[catalog.grant.state];
              const ready=readyGrants.get(catalog.grant.grant_id);
              if(ready!==undefined&&(!["ready","stopped"].includes(catalog.grant.state)||catalog.version!==version||catalog.grant.readiness_json!==ready||owned&&JSON.stringify(catalog)!==owned))fail("Original service ready observation regressed or changed.");
              if(["ready","stopped"].includes(catalog.grant.state)&&ready===undefined)fail("Provider source service has no original ready commit.");
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
    const original:SourceServiceContext={owner,bridge,check:result!.assertCurrent,
      acceptReady(grantId,record){if(closed||readyGrants.has(grantId))fail("Original service readiness cannot be adopted or recycled.");readyGrants.set(grantId,record);},
      acceptCatalog(grantId,before,after){
        if(closed||!readyGrants.has(grantId)||ownedCatalogs.has(grantId)&&ownedCatalogs.get(grantId)!==before||!ownedCatalogs.has(grantId)&&JSON.parse(before).version!==5)fail("Original service catalog preimage differs.");
        const value=JSON.parse(after);if(value.version!==JSON.parse(before).version+1||value.grant?.grant_id!==grantId||value.grant.readiness_json!==readyGrants.get(grantId))fail("Original service catalog transition differs.");ownedCatalogs.set(grantId,after);
      },
    };sourceServiceOwners.set(result!,original);ownerSourceServices.set(owner,original);
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
/** Native target staging ownership only; no runtime, suspension, writer or ingress authority. */
export interface ProviderTargetWorkspace {
  readonly targetId:string;readonly projectId:string;readonly nodeId:string;
  readonly dataDirectory:string;readonly releaseDirectory:string;
  assertCurrent():void;verifyCurrent():Promise<void>;close():void;
}
type TargetWorkspaceContext={owner:ProviderServiceOwnership;bridge:ProviderHandoffBridge;domain:ProviderHandoffDomain;context:Context;workspace:Pin;data:Pin;release:Pin;children:Set<()=>void>;canonical?:{project:Pin;generations:Pin;generation:number;releaseId:string;handoffId:string};check():void;close():void};
const targetWorkspaces=new WeakMap<ProviderTargetWorkspace,TargetWorkspaceContext>();
const ownerTargetWorkspaces=new WeakMap<ProviderServiceOwnership,Set<ProviderTargetWorkspace>>();
const targetWorkspaceReservations=new WeakSet<ProviderServiceOwnership>();
function closeTargetWorkspaces(owner:ProviderServiceOwnership):void{
  const errors:unknown[]=[];
  for(const workspace of [...(ownerTargetWorkspaces.get(owner)??[])])try{workspace.close();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,"Original target workspace cleanup is uncertain.");
}
export function assertProviderTargetWorkspace(value:ProviderTargetWorkspace):void{
  const held=targetWorkspaces.get(value);if(!held)fail("A genuine original provider target workspace is required.");held.check();
}
/** Private native context for the target runtime constructor; DTO fields are never authority. */
export function providerTargetWorkspaceContext(value:ProviderTargetWorkspace){
  assertProviderTargetWorkspace(value);const held=targetWorkspaces.get(value)!,nativeDomain=domains.get(held.domain);if(!nativeDomain||nativeDomain.owner!==held.owner)fail("Original target Docker domain is unavailable.");
  return Object.freeze({owner:held.owner,client:nativeDomain.client,domain:held.domain,fs:held.context.fs,
    operationTimeoutMs:containerFrame(held.bridge,bridgeCurrent(held.bridge,true)).root.bridge.limits.controlTimeoutMs,
    workspace:Object.freeze({...held.workspace}),data:Object.freeze({...held.data}),release:Object.freeze({...held.release}),canonical:held.canonical?Object.freeze({...held.canonical,project:Object.freeze({...held.canonical.project}),generations:Object.freeze({...held.canonical.generations})}):undefined,check:held.check,
    retainCleanup(cleanup:()=>void){held.check();held.children.add(cleanup);return ()=>held.children.delete(cleanup);}});
}
/** Reserve a fresh dedicated target owner before native allocation or awaited observation. */
export async function retainProviderTargetWorkspace(bridge:ProviderHandoffBridge,projectId:string,source?:ProviderSourceTransferLease):Promise<ProviderTargetWorkspace>{
  const registered=bridgeCurrent(bridge,true),owner=registered.owner,c=registered.context;
  const selected=source===undefined?undefined:providerSourceTransferContext(source),identity=selected?.binding.identity;
  if(selected&&(identity.source.projectId!==projectId||identity.targetNodeId!==registered.domain.nodeId))fail("Canonical target layout differs from original source enrollment.");
  if(!match(projectId,ID))fail("Original target project identity is invalid.");
  if(sourceServiceReservations.has(owner)||targetWorkspaceReservations.has(owner))fail("Original provider target ownership is already reserved.");
  if(!absent(c,c.path.join(c.service.path,TARGET_OWNER_NAME)))fail("Retained target admission cannot be reconstructed as fresh staging authority.");
  targetWorkspaceReservations.add(owner);
  const kept:Pin[]=[],children=new Set<()=>void>();let workspacePin:Pin|undefined,dataPin:Pin|undefined,releasePin:Pin|undefined;let closed=false,published=false,result:ProviderTargetWorkspace|undefined,expectedFrame="",expectedBinding="";
  let canonical:TargetWorkspaceContext["canonical"];
  const close=()=>{if(closed)return;closed=true;if(result)ownerTargetWorkspaces.get(owner)?.delete(result);const errors:unknown[]=[];for(const child of [...children])try{child();}catch(error){errors.push(error);}children.clear();for(const p of kept.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"Original target pins failed to close.");};
  const check=()=>{
    if(closed)fail("Original target workspace is closed.");
    try{
      const currentContext=bridgeCurrent(bridge,true);if(currentContext.owner!==owner||currentContext.domain!==registered.domain)fail("Original target owner changed.");
      for(const p of kept)assertPin(c,p);
      const frame=containerFrame(bridge,registered);
      if(JSON.stringify({root:frame.root,state:frame.state,index:frame.indexRows})!==expectedFrame)fail("Original target bridge changed after admission.");
      const file=kept[0],db=new c.Database(file.anchor,{readOnly:true});
      try{db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");strictSchema(c,db,[TARGET_OWNER_SQL]);const row=singleton(db,"clank_provider_target_owner");if(boundedJSON(row,4096)!==expectedBinding)fail("Original target native admission changed.");}finally{db.close();}
      for(const p of kept)assertPin(c,p);bridgeCurrent(bridge,true);
    }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original target observation and cleanup failed.");}throw error;}
  };
  try{
    await exclusive(owner,async()=>{
      const process=(globalThis as any).process;
      if(process.platform!=="linux"||!process.getuid?.()||!process.getgid?.())fail("Target staging requires its original non-root Linux owner.");
      selected?.check();bridgeCurrent(bridge,true);await verifyDomain(owner,registered.domain,true);bridgeCurrent(bridge,true);selected?.check();
      if(sourceServiceReservations.has(owner))fail("Original target admission overlaps source ownership.");
      const frame=containerFrame(bridge,registered),project=frame.state.projects.find(row=>row.project_id===projectId);
      if(!project||project.installation!=="ready"||frame.state.barriers||frame.state.grants||frame.state.reservations.length
        ||frame.state.states.some(row=>row.version!==1||row.grant||row.transfer||row.operations.length||row.spools.length))fail("Target staging requires an unused original provider bridge.");
      const id=c.randomUUID(),name=".clank-target-"+id;
      const binding={protocol:"clank-provider-target-workspace/1",targetId:id,projectId,nodeId:registered.domain.nodeId,enablementId:registered.enablementId,indexId:frame.root.index_id,catalogId:project.catalog_id,domainSha256:frame.root.domain_sha256,workspaceName:name,...(selected?{canonical:{generation:identity.targetGeneration,releaseId:identity.source.releaseId,handoffId:identity.handoffId}}:{})};
      const json=boundedJSON(binding,2048),row={id:1,protocol:1,target_id:id,enablement_id:registered.enablementId,index_id:frame.root.index_id,domain_sha256:frame.root.domain_sha256,project_id:projectId,catalog_id:project.catalog_id,workspace_name:name,binding_json:json,binding_sha256:c.hash(json)};
      const from=c.pins.length;
      try{
        createDatabase(c,c.service,TARGET_OWNER_NAME,TARGET_OWNER_MAX,[TARGET_OWNER_SQL],db=>{
          if(db.prepare("INSERT INTO clank_provider_target_owner VALUES(1,1,?,?,?,?,?,?,?,?,?)").run(id,registered.enablementId,frame.root.index_id,frame.root.domain_sha256,projectId,project.catalog_id,name,json,c.hash(json)).changes!==1
            ||boundedJSON(singleton(db,"clank_provider_target_owner"),4096)!==boundedJSON(row,4096))fail("Original target admission was not retained.");
        });
        const admission=pin(c,c.path.join(c.service.path,TARGET_OWNER_NAME),false,TARGET_OWNER_MAX);
        const workspace=directory(c,c.service,name,true);let data:Pin,release:Pin;
        if(selected){
          selected.check();const projects=directory(c,c.root,"projects",absent(c,c.path.join(c.root.path,"projects")));
          if(!absent(c,c.path.join(projects.path,projectId)))fail("Canonical target project must be fresh before staging.");
          const project=directory(c,projects,projectId,true),generations=directory(c,project,"generations",true);
          data=directory(c,project,"data",true);release=directory(c,generations,"g"+identity.targetGeneration+"-"+identity.source.releaseId,true);
          directory(c,project,"recovery",true);directory(c,project,".staging",true);
          canonical={project,generations,generation:identity.targetGeneration,releaseId:identity.source.releaseId,handoffId:identity.handoffId};
          for(const pin of [data,release,generations,project,projects])c.fs.fsyncSync(pin.fd);
        }else{data=directory(c,workspace,"data",true);release=directory(c,workspace,"release",true);}
        workspacePin=workspace;dataPin=data;releasePin=release;c.fs.fsyncSync(workspace.fd);c.fs.fsyncSync(c.service.fd);
        kept.push(...c.pins.splice(from));
        if(kept[0]!==admission)fail("Original target admission pin order differs.");
        expectedFrame=JSON.stringify({root:frame.root,state:frame.state,index:frame.indexRows});expectedBinding=boundedJSON(row,4096);
        result=Object.freeze({targetId:id,projectId,nodeId:registered.domain.nodeId,dataDirectory:data.path,releaseDirectory:release.path,assertCurrent:check,
          async verifyCurrent(){check();await exclusive(owner,async()=>{check();await verifyDomain(owner,registered.domain,true);check();},bridge);check();},close});
        check();await verifyDomain(owner,registered.domain,true);check();
      }finally{releasePins(c,from);}
    },bridge);
    check();const value=result!;targetWorkspaces.set(value,{owner,bridge,domain:registered.domain,context:c,workspace:workspacePin!,data:dataPin!,release:releasePin!,children,canonical,check,close});const active=ownerTargetWorkspaces.get(owner)??new Set<ProviderTargetWorkspace>();active.add(value);ownerTargetWorkspaces.set(owner,active);published=true;return value;
  }finally{if(!published)close();}
}
export async function inspectProviderHandoffBridge(bridge:ProviderHandoffBridge):Promise<Readonly<{projects:readonly Row[];reservations:readonly Row[]}>>{
  return withBridge(bridge,false,(_c,_root,state)=>freezeValue({projects:state.states,reservations:state.reservations}));
}
/** Bind a reader to the original enrolled source, published base and owning catalog commits. */
export async function retainProviderSourceTransfer(bridge:ProviderHandoffBridge,projectId:string):Promise<ProviderSourceTransferLease>{
 const registered=bridgeCurrent(bridge);if(!match(projectId,ID))fail("Original transfer project is invalid.");
 let result:ProviderSourceTransferLease|undefined;
 await withBridge(bridge,false,(c,root,state)=>{
  const original=state.states.find(row=>row.projectId===projectId);
  if(!original?.grant||original.grant.state!=="ready"||original.transfer?.phase!=="enrolled")fail("Original source transfer requires completed native enrollment.");
  const grant=freezeValue(JSON.parse(original.grant.binding_json)),binding=freezeValue(JSON.parse(original.transfer.enrollment_json).binding),base=original.spools.find((row:Row)=>row.kind==="base");
  if(!base||JSON.parse(base.manifest_json).output.resultSha256!==binding.baseArchiveSha256)fail("Original source transfer base differs from its enrollment.");
  let expected=JSON.stringify(original),closed=false;const rootJSON=JSON.stringify(root),indexJSON=JSON.stringify(containerFrame(bridge,registered,undefined,undefined,false).indexRows);
  const close=()=>{closed=true;ownerSourceTransfers.get(registered.owner)?.delete(held);};
  const check=()=>{if(closed)fail("Original source transfer is closed or fenced.");try{
   const current=bridgeCurrent(bridge);if(current.owner!==registered.owner||current.domain!==registered.domain)fail("Original source transfer owner changed.");
   const frame=containerFrame(bridge,current,undefined,undefined,false),actual=frame.state.states.find(row=>row.projectId===projectId);
   if(JSON.stringify(frame.root)!==rootJSON||JSON.stringify(frame.indexRows)!==indexJSON||JSON.stringify(actual)!==expected)fail("Original source transfer catalog changed without its owning commit.");
  }catch(error){close();throw error;}};
  const verify=async()=>{check();await withBridge(bridge,false,()=>{check();});check();};
  const held:SourceTransferContext={bridge,binding,grant,limits:freezeValue({...root.bridge.limits}),check,verify,close,
   accept(before,after){if(closed)return;const previous=JSON.parse(before);if(previous.projectId!==projectId)return;
    if(before!==expected)fail("Original source transfer commit preimage differs.");
    const next=JSON.parse(after);if(next.version!==previous.version+1||next.grant?.binding_json!==original.grant.binding_json||!["ready","stopped"].includes(next.grant?.state)||next.transfer?.enrollment_json!==original.transfer.enrollment_json||next.spools.find((row:Row)=>row.kind==="base")?.manifest_json!==base.manifest_json)fail("Original source transfer commit binding differs.");expected=after;
   }};
  result=Object.freeze({projectId,grantId:original.grant.grant_id,assertCurrent:check,verifyCurrent:verify,close});
  sourceTransfers.set(result,held);const active=ownerSourceTransfers.get(registered.owner)??new Set<SourceTransferContext>();active.add(held);ownerSourceTransfers.set(registered.owner,active);check();
 });result!.assertCurrent();return result!;
}
/** Private original transfer context; neither caller rows nor callbacks admit a source. */
export function providerSourceTransferContext(value:ProviderSourceTransferLease){
 const held=sourceTransfers.get(value);if(!held)fail("A genuine original source transfer lease is required.");held.check();return Object.freeze({bridge:held.bridge,binding:held.binding,grant:held.grant,limits:held.limits,check:held.check,verify:held.verify,close:held.close});
}
/** Read only catalog-published immutable output; grants no target or writer. */
export async function readProviderSourceSpool(bridge:ProviderHandoffBridge,projectId:string,kind:"base"|"tail"):Promise<string>{
  bridgeCurrent(bridge);if(!match(projectId,ID)||!["base","tail"].includes(kind))fail("Invalid retained source spool selector.");
  return withBridge(bridge,false,(c,_root,state)=>{
    const source=state.states.find(value=>value.projectId===projectId),row=source?.spools.find((value:Row)=>value.kind===kind);if(!source?.grant||!row)fail("The original catalog-published source spool is unavailable.");
    sourceSpools(c,source.grant,[row],state.reservations);const manifest=JSON.parse(row.manifest_json),binding=JSON.parse(source.grant.binding_json),from=c.pins.length;
    try{
      const root=directory(c,c.service,".clank-source-spool-"+binding.sourceIncarnation),file=pin(c,c.path.join(root.path,kind+".json"),false,manifest.output.bytes),metadata=pin(c,c.path.join(root.path,kind+".manifest.json"),false,8192);
      if(sourceMetadata(c,metadata)!==row.manifest_json)fail("Retained spool filesystem/catalog manifest differs.");
      const before=c.fs.fstatSync(file.fd,{bigint:true}),bytes=Buffer.alloc(manifest.output.bytes);let offset=0;
      while(offset<bytes.length){const count=c.fs.readSync(file.fd,bytes,offset,bytes.length-offset,offset);if(count<1)fail("Retained source spool ended before its catalog byte count.");offset+=count;}
      const after=c.fs.fstatSync(file.fd,{bigint:true}),visible=c.fs.lstatSync(file.path,{bigint:true});
      if(before.size!==BigInt(bytes.length)||[after,visible].some(stat=>["dev","ino","size","mtimeNs","ctimeNs","mode","uid","gid","nlink"].some(key=>stat[key]!==before[key]))||c.hash(bytes as any)!==manifest.output.resultSha256)fail("Retained source spool identity or bytes changed.");
      const body=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(Buffer.byteLength(body)!==bytes.length||c.hash(body)!==manifest.output.resultSha256)fail("Retained source spool encoding differs.");return body;
    }finally{releasePins(c,from);}
  });
}
// Host-only custody is outside every source mount. A copied binding/key never
// grants runtime ownership, and reopening retained grants remains cleanup-only.
function captureKeyRows(db:any):Row[]{return db.prepare("SELECT * FROM clank_provider_capture_keys ORDER BY grant_id LIMIT 101").all().map((row:Row)=>({...row}));}
function captureKeyCatalog(c:Context,db:any,root:Row,states:Row[]):{metadata:Row;rows:Row[]}{
  strictSchema(c,db,CAPTURE_KEYS_SCHEMA);const metadata=singleton(db,"clank_provider_capture_key_owner"),rows=captureKeyRows(db);
  if(metadata.id!==1||metadata.protocol!==1||metadata.enablement_id!==root.bridge.enablement_id||metadata.index_id!==root.index_id||metadata.domain_sha256!==root.domain_sha256
    ||metadata.version!==rows.length+1||rows.length>root.bridge.limits.maxProjects||c.hash(boundedJSON(rows,CAPTURE_KEYS_MAX))!==metadata.records_sha256)fail("Provider capture key custody metadata differs.");
  for(const row of rows){const grant=states.find(state=>state.projectId===row.project_id)?.grant;
    if(!grant||row.grant_id!==grant.grant_id||row.binding_json!==grant.binding_json||row.binding_sha256!==grant.binding_sha256||!match(row.key_hex,/^[a-f0-9]{64}$/u))fail("Provider capture key custody binding differs.");
    const binding=JSON.parse(grant.binding_json),key=Buffer.from(row.key_hex,"hex");
    try{if(row.key_id!==binding.capture.keyId||c.hash(key as any)!==binding.capture.keySha256)fail("Provider capture key custody digest differs.");}finally{key.fill(0);}
  }
  return {metadata,rows};
}
function pinCaptureKeys(c:Context):void{
  if(c.keyFile){assertPin(c,c.keyFile);return;}
  const file=pin(c,c.path.join(c.service.path,CAPTURE_KEYS_NAME),false,CAPTURE_KEYS_MAX);
  c.pins.splice(c.pins.indexOf(file),1);c.keyFile=file;
}
function captureKeyFrame(metadata:Row):string{return JSON.stringify({version:metadata.version,recordsSha256:metadata.records_sha256});}
function inspectCaptureKeys(c:Context,root:Row,states:Row[]):void{
  // Earlier roots may lack custody. That never manufactures a missing key;
  // new launch publication below requires its exact native custody receipt.
  if(absent(c,c.path.join(c.service.path,CAPTURE_KEYS_NAME))){if(c.keyFile)fail("Provider capture key custody disappeared.");return;}
  try{pinCaptureKeys(c);databaseAt(c,c.service,CAPTURE_KEYS_NAME,CAPTURE_KEYS_MAX,false,db=>{
    const frame=captureKeyFrame(captureKeyCatalog(c,db,root,states).metadata);
    if(c.keyFrame!==undefined&&c.keyFrame!==frame)fail("Original capture key custody frame changed.");c.keyFrame??=frame;
  });}
  catch(error){c.failed=true;throw error;}
}
function copyCaptureKey(value:Uint8Array):Uint8Array{
  const typed=Object.getPrototypeOf(Uint8Array.prototype),get=(name:string)=>Object.getOwnPropertyDescriptor(typed,name)!.get!;
  try{const size=get("byteLength").call(value),buffer=get("buffer").call(value),offset=get("byteOffset").call(value);
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!.call(buffer);
    if(!(value instanceof Uint8Array)||size!==32)fail();const copy=new Uint8Array(32);copy.set(new Uint8Array(buffer,offset,32));return copy;
  }catch{fail("Provider capture key requires 32 native non-shared bytes.");}
}
/** Persist the issued grant's exact capture key before creating its source. */
export async function storeProviderSourceCaptureKey(bridge:ProviderHandoffBridge,projectId:string,grantId:string,value:Uint8Array):Promise<void>{
  bridgeCurrent(bridge,true);const key=copyCaptureKey(value);
  try{await withBridge(bridge,true,(c,root,state,registered)=>{
    const grant=state.states.find(row=>row.projectId===projectId)?.grant;
    if(!grant||grant.grant_id!==grantId||grant.state!=="issued"||grant.container_id!==null)fail("Capture key custody requires the original unstarted grant.");
    const binding=JSON.parse(grant.binding_json);if(c.hash(key as any)!==binding.capture.keySha256)fail("Capture key differs from its original issued binding.");
    const encoded=Buffer.from(key);let keyHex:string;try{keyHex=encoded.toString("hex");}finally{encoded.fill(0);}
    const expected={project_id:projectId,grant_id:grantId,key_id:binding.capture.keyId,binding_sha256:grant.binding_sha256,binding_json:grant.binding_json,key_hex:keyHex};
    if(absent(c,c.path.join(c.service.path,CAPTURE_KEYS_NAME))){
      createDatabase(c,c.service,CAPTURE_KEYS_NAME,CAPTURE_KEYS_MAX,CAPTURE_KEYS_SCHEMA,db=>{
        if(db.prepare("INSERT INTO clank_provider_capture_key_owner VALUES(1,1,?,?,?,1,?)").run(registered.enablementId,root.index_id,root.domain_sha256,c.hash("[]")).changes!==1)fail();
      });pinCaptureKeys(c);c.keyFrame=JSON.stringify({version:1,recordsSha256:c.hash("[]")});
    }
    databaseAt(c,c.service,CAPTURE_KEYS_NAME,CAPTURE_KEYS_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
      const before=captureKeyCatalog(c,db,root,state.states),existing=before.rows.find(row=>row.project_id===projectId||row.grant_id===grantId||row.key_id===binding.capture.keyId);
      if(captureKeyFrame(before.metadata)!==c.keyFrame)fail("Original capture key custody preimage changed.");
      if(existing){if(JSON.stringify(existing)!==JSON.stringify(expected))fail("Capture key custody cannot be rebound.");}
      else{
        if(before.rows.length>=root.bridge.limits.maxProjects)fail("Capture key custody capacity exceeded.");
        if(db.prepare("INSERT INTO clank_provider_capture_keys VALUES(?,?,?,?,?,?)").run(...Object.values(expected)).changes!==1)fail("Capture key custody write was not acknowledged.");
        const after=captureKeyRows(db),digest=c.hash(boundedJSON(after,CAPTURE_KEYS_MAX));
        if(db.prepare("UPDATE clank_provider_capture_key_owner SET version=version+1,records_sha256=? WHERE id=1 AND version=? AND records_sha256=?").run(digest,before.metadata.version,before.metadata.records_sha256).changes!==1)fail("Capture key custody mirror changed.");
      }
      let nextFrame:string|undefined;
      commitBridgeFile(c,registered.owner,db,file,c.service,()=>{
        const next=captureKeyCatalog(c,db,root,state.states),retained=next.rows.find(row=>row.grant_id===grantId);
        if(JSON.stringify(retained)!==JSON.stringify(expected))fail("Capture key custody durable readback differs.");
        nextFrame=captureKeyFrame(next.metadata);
      });
      // Only the original owning commit/fsync/readback advances this frame.
      // No await exposes committed custody to observers of an older preimage.
      c.keyFrame=nextFrame!;
    }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
  });}finally{key.fill(0);}
}
/** Resolve only this native owner's retained grant; this grants no writer. */
export async function resolveProviderSourceCaptureKey(bridge:ProviderHandoffBridge,projectId:string,grantId:string):Promise<Uint8Array>{
  bridgeCurrent(bridge);let key:Uint8Array|undefined;
  try{await withBridge(bridge,false,(c,root,state)=>{
    const grant=state.states.find(row=>row.projectId===projectId)?.grant;if(!grant||grant.grant_id!==grantId)fail("Capture key resolution requires its original retained grant.");
    if(absent(c,c.path.join(c.service.path,CAPTURE_KEYS_NAME)))fail("The retained source capture key is unavailable.");
    pinCaptureKeys(c);databaseAt(c,c.service,CAPTURE_KEYS_NAME,CAPTURE_KEYS_MAX,false,db=>{
      const row=captureKeyCatalog(c,db,root,state.states).rows.find(row=>row.grant_id===grantId);if(!row)fail("The retained source capture key is unavailable.");
      const decoded=Buffer.from(row.key_hex,"hex");try{key=new Uint8Array(decoded);}finally{decoded.fill(0);}
    });
  });return key!;}catch(error){key?.fill(0);throw error;}
}
/** One permanent identity intent. No container, runtime or publication is started. */
export async function issueProviderHandoffGrant(bridge:ProviderHandoffBridge,input:Readonly<{binding:unknown;grantSecretSha256:string;controlSecretSha256:string}>):Promise<Readonly<{grantId:string;bindingSha256:string}>>{
  const targetGuard=bridgeCurrent(bridge,true).context;
  if(targetWorkspaceReservations.has(bridgeCurrent(bridge,true).owner)||!absent(targetGuard,targetGuard.path.join(targetGuard.service.path,TARGET_OWNER_NAME)))fail("Retained target admission refuses a source grant.");
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
const GRANT_REVOKE_CAS="UPDATE clank_provider_handoff_source_grant SET state=?,container_id=? WHERE id=1 AND protocol=2 AND grant_id=? AND binding_json=? AND binding_sha256=? AND grant_secret_sha256=? AND control_secret_sha256=? AND state=? AND container_id IS ? AND readiness_json IS ? AND readiness_sha256 IS ?";
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
      const rootJSON=JSON.stringify(frame.root);let stateJSON=JSON.stringify({state:frame.state,index:frame.indexRows});
      const binding=freezeValue(JSON.parse(grant.binding_json));
      const prepared=bridgeWorkerChannels.get(bridge)?.get(input.grantId);
      const control=bridgeControlChannels.get(bridge)?.get(input.grantId);
      if(usedControlChannels.get(bridge)?.has(input.grantId)&&!control)fail("An attempted source control channel has no completed original preparation.");
      if(control){control.check();if(control.containerId()!==input.containerId||JSON.stringify(control.binding)!==JSON.stringify(binding))fail("Provider source control grant binding differs.");}
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
        let closed=false;const children=new Set<()=>void>();if(prepared)children.add(prepared.invalidate);if(control)children.add(control.invalidate);
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
        check();sourceGrantLeases.set(result,{check,context:c,registered,bridge,input,children,dataRetained:false,
          acceptState(before,after){if(closed||stateJSON!==before)fail("Original source grant transition preimage differs.");for(const p of retained)assertPin(c,p);containerFrame(bridge,registered,rootJSON,after);stateJSON=after;},
        });active.add(result);used.add(input.grantId);
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
/** Original issued control endpoint; initialization evidence is not write admission. */
export interface ProviderSourceControlChannel {
  readonly mountSource:string;
  assertCurrent():void;
  verifyCurrent():Promise<void>;
  bindCreated(input:ProviderHandoffContainerInput):Promise<import("./provider-source-worker-wire.ts").SourceWorkerChannelBinding>;
  initialize(container:ProviderSourceContainerLease):Promise<ProviderSourceInitializationLease>;
  operate(encoded:string):Promise<string>;
  close():Promise<void>;
}
type SourceWorkerChannelContext={check:()=>void;invalidate:()=>void;binding:Row;containerId:()=>string|undefined;mountSource:string;failure?:string;acknowledgeTarget?:(receipt:object)=>Promise<string>;quiesceTarget?:(receipt:object)=>Promise<ProviderSourceQuiescenceLease>;acceptReady?:(value:string)=>void;acceptCatalog?:(before:string,after:string)=>void;sendOperation?:(encoded:string,internal?:boolean)=>Promise<string>};
const sourceWorkerChannels=new WeakMap<ProviderSourceWorkerChannel,SourceWorkerChannelContext>();
const bridgeWorkerChannels=new WeakMap<ProviderHandoffBridge,Map<string,SourceWorkerChannelContext>>();
const ownerWorkerChannels=new WeakMap<ProviderServiceOwnership,Set<SourceWorkerChannelContext>>();
const usedWorkerChannels=new WeakMap<ProviderHandoffBridge,Set<string>>();
const pendingWorkerChannels=new WeakMap<ProviderServiceOwnership,number>();
const sourceControlChannels=new WeakMap<ProviderSourceControlChannel,SourceWorkerChannelContext>();
const bridgeControlChannels=new WeakMap<ProviderHandoffBridge,Map<string,SourceWorkerChannelContext>>();
const ownerControlChannels=new WeakMap<ProviderServiceOwnership,Set<SourceWorkerChannelContext>>();
const usedControlChannels=new WeakMap<ProviderHandoffBridge,Set<string>>();
const pendingControlChannels=new WeakMap<ProviderServiceOwnership,number>();
export function assertProviderSourceControlChannel(value:ProviderSourceControlChannel):void {
  const channel=sourceControlChannels.get(value);if(!channel)fail("An original provider source control channel is required.");channel.check();
}

function closeWorkerChannels(owner:ProviderServiceOwnership):void {
  for(const channel of [...(ownerWorkerChannels.get(owner)??[]),...(ownerControlChannels.get(owner)??[])])channel.invalidate();
}
export function assertProviderSourceWorkerChannel(value:ProviderSourceWorkerChannel):void {
  const channel=sourceWorkerChannels.get(value);if(!channel)fail("An original provider source worker channel is required.");channel.check();
}
export async function prepareProviderSourceWorkerChannel(
  bridge:ProviderHandoffBridge,value:Readonly<{projectId:string;grantId:string;bindingSha256:string;expectedVersion:number}>,controlSecret:Uint8Array,
):Promise<ProviderSourceWorkerChannel> {return await prepareProviderSourceChannel(bridge,value,controlSecret,false) as ProviderSourceWorkerChannel;}
export async function prepareProviderSourceControlChannel(
  bridge:ProviderHandoffBridge,value:Readonly<{projectId:string;grantId:string;bindingSha256:string;expectedVersion:number}>,controlSecret:Uint8Array,
):Promise<ProviderSourceControlChannel> {return await prepareProviderSourceChannel(bridge,value,controlSecret,true) as ProviderSourceControlChannel;}
async function prepareProviderSourceChannel(
  bridge:ProviderHandoffBridge,value:Readonly<{projectId:string;grantId:string;bindingSha256:string;expectedVersion:number}>,controlSecret:Uint8Array,control:boolean,
):Promise<ProviderSourceWorkerChannel|ProviderSourceControlChannel> {
  const owners=control?ownerControlChannels:ownerWorkerChannels,bridges=control?bridgeControlChannels:bridgeWorkerChannels;
  const usedChannels=control?usedControlChannels:usedWorkerChannels,pendingChannels=control?pendingControlChannels:pendingWorkerChannels;
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
  let readyRecord:string|undefined;
  let ownedCatalog:string|undefined;
  let outputRoot:Pin|undefined;
  const outputSlots=new Map<string,{inputSha256:string;resultSha256:string;bytes:number;file:Pin;manifest:Pin;manifestJSON:string}>();
  let controlServer:ReturnType<typeof import("./provider-source-worker-wire.ts").createSourceControlServerProtocol>|undefined;
  let operation: {id:string;command:string;maximumBytes:number;sent:boolean;parts:string[];offset:number;bytes:number;total?:number;hash?:string;resolve(value:string):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}|undefined;
  let controlFlight:Promise<void>|undefined,initializationRequest:ProviderSourceInitializationRequest|undefined,initialized:ProviderSourceInitializationLease|undefined,controlContainer:ProviderSourceContainerLease|undefined;
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
      await dispatchFlight?.then(()=>{},()=>{});await controlFlight?.then(()=>{},()=>{});await worker?.close();
      if(broker){try{await brokerClosing;}catch(error){
        // An expired observation is not settlement. Keep every original pin
        // and wait for this same child; never create/adopt a replacement.
        await broker.closed;await broker.close();
      }}
      const errors:unknown[]=[];
      for(const pin of pins.splice(0).reverse())try{await pin.close();}catch(error){errors.push(error);}
      for(const pin of retained.splice(0).reverse())try{c.fs.closeSync(pin.fd);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,"Source channel pin cleanup is uncertain.");
      if(context)owners.get(registered.owner)?.delete(context);
    })();void cleanupFlight.catch(()=>{});return cleanupFlight;
  };
  const invalidate=()=>{if(closed)return;closed=true;secret.fill(0);server?.close();controlServer?.close();initializationRequest?.close();initialized?.close();if(operation){clearTimeout(operation.timer);operation.reject(new Error("Original source control operation is closed or uncertain."));operation=undefined;}if(watch!==undefined)clearInterval(watch);void worker?.close().catch(()=>{});if(published)void cleanup();};
  const check=()=>{
    try{
      if(closed)fail("Provider source worker channel is closed.");
      for(const p of retained)assertPin(c,p);
      const frame=containerFrame(bridge,registered),source=frame.state.states.find(row=>row.projectId===input.projectId),next=source?.grant;
      const other=JSON.stringify({projects:frame.state.projects,reservations:frame.state.reservations,index:frame.indexRows,states:frame.state.states.filter(row=>row.projectId!==input.projectId)});
      if(JSON.stringify(frame.root)!==rootJSON||other!==otherJSON||!next||!grant
        ||JSON.stringify({...next,state:grant.state,container_id:grant.container_id,readiness_json:null,readiness_sha256:null})!==grantJSON
        ||(readyRecord?next.state!=="ready"||source.version!==(ownedCatalog?JSON.parse(ownedCatalog).version:5)||ownedCatalog&&JSON.stringify(source)!==ownedCatalog||next.readiness_json!==readyRecord||next.readiness_sha256!==c.hash(readyRecord):!["issued","created","started"].includes(next.state)||source.version!==({issued:2,created:3,started:4} as Row)[next.state]||next.readiness_json!==null||next.readiness_sha256!==null)
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
      const used=usedChannels.get(bridge)??new Set<string>(),active=owners.get(registered.owner)?.size??0,pending=pendingChannels.get(registered.owner)??0;
      if(!record||source.version!==2||record.state!=="issued"||record.grant_id!==input.grantId||record.binding_sha256!==input.bindingSha256||!crypto.timingSafeEqual(Buffer.from(record.control_secret_sha256,"hex"),Buffer.from(digest,"hex")))fail("Issued source channel authentication differs.");
      if(active+pending>=2||used.has(input.grantId))fail("Issued source channel cannot be duplicated or recycled.");
      const binding=JSON.parse(record.binding_json),process=(globalThis as any).process;
      if(process.platform!=="linux"||!process.getuid?.()||binding.uid!==process.getuid()||binding.gid!==process.getgid())fail("Issued source channel requires its fixed native owner.");
      used.add(input.grantId);usedChannels.set(bridge,used);pendingChannels.set(registered.owner,pending+1);reserved=true;
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
    const base=await sandbox.createPinnedSQLiteChildDirectory(root,(control?".clank-source-control-":".clank-source-worker-")+input.grantId,check);keep(base);check();
    for(const name of ["listener","disposal","mount"]){const child=await sandbox.createPinnedSQLiteChildDirectory(base,name,check);keep(child);check();}
    const wire=await import("./provider-source-worker-wire.ts");check();
    broker=await (control?wire.openSourceControlSocketBroker:wire.openSourceWorkerSocketBroker)(pins[2]!,pins[3]!,pins[4]!);check();
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
      containerId=inputCreated.containerId;const identity={bindingSha256:input.bindingSha256,containerId,sourceIncarnation:grant!.binding.sourceIncarnation};
      if(control){controlServer=wire.createSourceControlServerProtocol(secret,identity);check();return controlServer.binding;}
      server=wire.createSourceWorkerServerProtocol(secret,identity);secret.fill(0);check();return server.binding;}catch(error){invalidate();throw error;}
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
    const initialize=(container:ProviderSourceContainerLease):Promise<ProviderSourceInitializationLease>=>{
      try{
        check();if(dispatchStarted||!controlServer||!containerId)fail("Source control initialization is absent or already consumed.");
        const actual=sourceContainerLeases.get(container);
        if(!actual||actual.scope.parent.bridge!==bridge||actual.scope.parent.input.grantId!==input.grantId
          ||actual.scope.parent.input.containerId!==containerId||sourceControlChannelFor(actual.scope)!==context)fail("Source control requires its original coupled container.");
        actual.check();dispatchStarted=true;controlContainer=container;
      }catch(error){return Promise.reject(error);}
      let resolve!:(value:ProviderSourceInitializationLease)=>void,reject!:(error:unknown)=>void;
      const acknowledged=new Promise<ProviderSourceInitializationLease>((ok,no)=>{resolve=ok;reject=no;});
      controlFlight=(async()=>{
        initializationRequest=await requestProviderSourceInitialization(container,secret);secret.fill(0);check();
        const hello=controlServer!.accept(await broker!.receive());check();initializationRequest.assertCurrent();
        if(hello.kind!=="hello")fail("Original source control must begin with hello.");
        broker!.reply(controlServer!.reply(hello,initializationRequest.challenge));check();
        const response=controlServer!.accept(await broker!.receive());check();initializationRequest.assertCurrent();
        if(response.kind!=="initialized"||response.initialization===null)fail("Original source control requires native initialization.");
        initialized=await initializationRequest.accept(response.initialization);check();
        await container.verifyCurrent();check();initialized.assertCurrent();
        await commitProviderSourceReady(result as ProviderSourceControlChannel,container,initialized,controlServer!.binding);check();initialized.assertCurrent();
        broker!.reply(controlServer!.reply(response));check();resolve(initialized);
        for(;;){
          const encoded=await broker!.receive();check();
          await container.verifyCurrent();check();initialized.assertCurrent();
          const pulse=controlServer!.accept(encoded);if(pulse.kind!=="pulse")fail("Original source control pulse differs.");
          let completed:string|undefined,held=operation;
          if(pulse.result!==undefined){
            if(!held||!held.sent)fail("Original source result has no owned operation.");
            const part=JSON.parse(pulse.result);
            if(!exact(part,["protocol","operationId","sha256","total","offset","contents"])||part.protocol!=="clank-source-recovery-result/1"||part.operationId!==held.id||!match(part.sha256,DIGEST)
              ||!positive(part.total)||part.total>held.maximumBytes||part.offset!==held.offset||typeof part.contents!=="string"||part.contents.length<1||part.contents.length>1536||part.offset+part.contents.length>part.total||JSON.stringify(part)!==pulse.result
              ||held.total!==undefined&&held.total!==part.total||held.hash!==undefined&&held.hash!==part.sha256)fail("Original source result chunk differs.");
            held.bytes+=Buffer.byteLength(part.contents);if(held.bytes>held.maximumBytes)fail("Original source result exceeds its byte bound.");
            held.total=part.total;held.hash=part.sha256;held.parts.push(part.contents);held.offset+=part.contents.length;
            if(held.offset===held.total){completed=held.parts.join("");if(c.hash(completed)!==held.hash)fail("Original source result hash differs.");}
          }
          let command:string|undefined;
          if(held&&!held.sent){held.sent=true;command=held.command;}
          broker!.reply(controlServer!.reply(pulse,undefined,command));check();
          if(completed!==undefined){
            clearTimeout(held!.timer);operation=undefined;const value=JSON.parse(completed);
            if(value?.protocol==="clank-source-recovery-error/1"){held!.reject(new Error("Original source recovery refused: "+String(value.message).slice(0,512)));invalidate();}else held!.resolve(completed);
          }
        }
      })().catch(error=>{context!.failure??=error instanceof Error?error.message.slice(0,512):"Original source host control failed.";invalidate();reject(error);throw error;});
      void controlFlight.catch(()=>{});return acknowledged;
    };
    const receiveOutput=async(output:Row,encoded:string,maximum:number,deadline:bigint):Promise<string>=>{
      check();const container=controlContainer!,actual=sourceContainerLeases.get(container);if(!actual)fail("Original source output requires its coupled container.");actual.check();
      const request=JSON.parse(encoded),expectedKind=request.operation==="checkpoint"?"base":"tail";
      if(!exact(output,["protocol","sourceIncarnation","kind","inputSha256","resultSha256","bytes"])||output.protocol!=="clank-source-recovery-output/1"||output.sourceIncarnation!==grant!.binding.sourceIncarnation||output.kind!==expectedKind||output.inputSha256!==c.hash(encoded)||!match(output.resultSha256,DIGEST)||!positive(output.bytes)||output.bytes>maximum)fail("Original source output descriptor differs.");
      const frame=containerFrame(bridge,registered),reservation=frame.state.reservations.find(row=>row.catalog_id===grant!.binding.catalogId&&row.kind===expectedKind);
      const slotInput=c.hash(JSON.stringify({protocol:"clank-provider-source-spool-slot/1",grantId:input.grantId,bindingSha256:input.bindingSha256,sourceIncarnation:grant!.binding.sourceIncarnation,kind:expectedKind}));
      if(!reservation||reservation.input_sha256!==slotInput||output.bytes>reservation.maximum_bytes)fail("Original source output has no matching reserved quota.");
      const prior=outputSlots.get(expectedKind);
      if(prior&&(prior.inputSha256!==output.inputSha256||prior.resultSha256!==output.resultSha256||prior.bytes!==output.bytes))fail("Original source spool awaits its owned target receipt.");
      await container.verifyCurrent();check();actual.check();
      const held:Pin[]=[],from=c.pins.length;let ended=false,detached=false,temporary:Pin|undefined;
      const close=()=>{if(ended)return;ended=true;actual.children.delete(close);let error:unknown;for(const p of held.splice(0).reverse())try{c.fs.closeSync(p.fd);}catch(failure){error??=failure;}if(error)throw error;};
      const current=()=>{if(ended||(globalThis as any).process.hrtime.bigint()>=deadline)fail("Original source output delivery is closed or expired.");check();actual.check();for(const p of held)assertPin(c,p);};
      try{
        const archiveId=expectedKind==="base"?c.hash(JSON.stringify({operationId:request.operationId,binding:{projectId:grant!.binding.projectId,nodeId:request.nodeId,releaseId:grant!.binding.releaseId,generation:grant!.binding.generation},maxBytes:maximum,maxEntries:grant!.binding.capture.maxJournalEntries})):output.resultSha256;
        const parent=pin(c,c.path.dirname(actual.data.databasePath),true),root=directory(c,parent,".clank-source-recovery-"+grant!.binding.sourceIncarnation),outbox=directory(c,root,expectedKind==="base"?"exports":"outbox"),source=pin(c,c.path.join(outbox.path,archiveId+".json"),false,maximum);
        if(c.fs.fstatSync(source.fd).size!==output.bytes)fail("Original source output byte count differs.");
        // Retained host output must survive loss of the source data volume and
        // must not be writable through that application's /data mount.
        if(!outputRoot){const created=directory(c,c.service,".clank-source-spool-"+grant!.binding.sourceIncarnation,true);c.pins.splice(c.pins.indexOf(created),1);retained.push(created);outputRoot=created;}
        if(!prior){const name=expectedKind+".json.tmp-"+globalThis.crypto.randomUUID(),path=c.path.join(outputRoot.path,name),fd=c.fs.openSync(outputRoot.anchor+"/"+name,c.fs.constants.O_WRONLY|c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_NOFOLLOW,0o600);c.fs.closeSync(fd);temporary=pin(c,path,false,maximum);}
        held.push(...c.pins.splice(from));detached=true;actual.children.add(close);current();
        const cryptoName="node:crypto",crypto=await import(cryptoName);current();const hash=crypto.createHash("sha256"),chunks:any[]=[];let offset=0;
        const destination=temporary?c.fs.openSync(outputRoot!.anchor+"/"+c.path.basename(temporary.path),c.fs.constants.O_WRONLY|c.fs.constants.O_NOFOLLOW):undefined;
        if(destination!==undefined){const stat=c.fs.fstatSync(destination);if(stat.dev!==temporary!.dev||stat.ino!==temporary!.ino){c.fs.closeSync(destination);fail("Original source spool temporary descriptor differs.");}}
        try{
          while(offset<output.bytes){
            current();const bytes=Buffer.allocUnsafe(Math.min(1024*1024,output.bytes-offset)),count=c.fs.readSync(source.fd,bytes,0,bytes.length,offset);if(count<1)fail("Original source output ended before its declared size.");
            hash.update(bytes.subarray(0,count));chunks.push(bytes.subarray(0,count));
            if(destination!==undefined){let written=0;while(written<count){const n=c.fs.writeSync(destination,bytes,written,count-written,offset+written);if(n<1)fail("Original source spool write did not advance.");written+=n;}}
            offset+=count;current();await new Promise<void>(resolve=>setTimeout(resolve,0));current();
          }
          const extra=Buffer.alloc(1);if(c.fs.readSync(source.fd,extra,0,1,offset)!==0||hash.digest("hex")!==output.resultSha256)fail("Original source output hash or final size differs.");
          if(destination!==undefined)c.fs.fsyncSync(destination);current();
        }finally{if(destination!==undefined)c.fs.closeSync(destination);}
        const body=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));current();if(Buffer.byteLength(body)!==output.bytes||c.hash(body)!==output.resultSha256)fail("Original source output encoding differs.");
        if(prior){assertPin(c,prior.file);assertPin(c,prior.manifest);if(c.fs.fstatSync(prior.file.fd).size!==output.bytes)fail("Original retained source spool size differs.");}
        else{
          const final=c.path.join(outputRoot.path,expectedKind+".json"),manifestJSON=JSON.stringify({protocol:"clank-provider-source-spool-file/2",reservationId:reservation.reservation_id,grantId:input.grantId,bindingSha256:input.bindingSha256,containerId:container.containerId,input:encoded,output});
          current();c.fs.linkSync(outputRoot.anchor+"/"+c.path.basename(temporary!.path),outputRoot.anchor+"/"+expectedKind+".json");
          const linked=c.fs.lstatSync(final),original=c.fs.fstatSync(temporary!.fd);if(linked.dev!==temporary!.dev||linked.ino!==temporary!.ino||original.dev!==temporary!.dev||original.ino!==temporary!.ino||linked.nlink!==2||original.nlink!==2)fail("Original source spool link differs.");
          c.fs.unlinkSync(temporary!.path);held.splice(held.indexOf(temporary!),1);c.fs.closeSync(temporary!.fd);temporary=undefined;c.fs.fsyncSync(outputRoot.fd);current();
          const nextFrom=c.pins.length;let file:Pin,manifest:Pin;
          try{file=pin(c,final,false,maximum);const name=expectedKind+".manifest.json",fd=c.fs.openSync(outputRoot.anchor+"/"+name,c.fs.constants.O_WRONLY|c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_NOFOLLOW,0o600);try{c.fs.writeFileSync(fd,manifestJSON);c.fs.fsyncSync(fd);}finally{c.fs.closeSync(fd);}c.fs.fsyncSync(outputRoot.fd);manifest=pin(c,c.path.join(outputRoot.path,name),false,8192);retained.push(...c.pins.splice(nextFrom));}
          catch(error){releasePins(c,nextFrom);throw error;}
          outputSlots.set(expectedKind,{inputSha256:output.inputSha256,resultSha256:output.resultSha256,bytes:output.bytes,file,manifest,manifestJSON});current();
        }
        const stored=outputSlots.get(expectedKind)!;current();assertPin(c,stored.file);assertPin(c,stored.manifest);
        if(sourceMetadata(c,stored.manifest)!==stored.manifestJSON)fail("Original retained source spool manifest differs.");
        const storedHash=crypto.createHash("sha256"),readback=Buffer.allocUnsafe(1024*1024);let position=0;
        while(position<output.bytes){current();const n=c.fs.readSync(stored.file.fd,readback,0,Math.min(readback.length,output.bytes-position),position);if(n<1)fail("Original retained source spool ended early.");storedHash.update(readback.subarray(0,n));position+=n;await new Promise<void>(resolve=>setTimeout(resolve,0));current();}
        if(c.fs.fstatSync(stored.file.fd).size!==output.bytes||storedHash.digest("hex")!==output.resultSha256)fail("Original retained source spool readback differs.");current();
        current();await container.verifyCurrent();current();await commitProviderSourceSpool(result as ProviderSourceControlChannel,container,stored.manifestJSON);current();return body;
      }finally{try{close();}finally{if(!detached)releasePins(c,from);}}
    };
    const sendOperation=(encoded:string,internal=false):Promise<string>=>{
      try{
        check();if(!controlContainer||!initialized||!readyRecord)fail("Original source control is not initialized and ready.");controlContainer.assertCurrent();initialized.assertCurrent();
        if(operation)fail("Original source already has an owned control operation.");
        if(typeof encoded!=="string"||Buffer.byteLength(encoded)>3072)fail("Original source operation exceeds its command bound.");
        const value=JSON.parse(encoded);if(!value||typeof value!=="object"||Array.isArray(value)||JSON.stringify(value)!==encoded||!(internal?["clank-source-catalog-prepare/1","clank-source-spool-prepare/1","clank-source-target-prepare/1","clank-source-stop-prepare/1","clank-source-catalog-observe/1","clank-source-recovery-output-release/1"].includes(value.protocol):value.protocol==="clank-source-recovery-operation/1"&&["checkpoint","enroll","batch","seal"].includes(value.operation)))fail("Invalid original source operation.");
        if(value.operation==="checkpoint"&&value.nodeId!==registered.domain.nodeId)fail("Original source checkpoint node differs.");
        if(value.operation==="enroll"&&value.binding?.identity?.source?.nodeId!==registered.domain.nodeId)fail("Original source enrollment node differs.");
        const frame=containerFrame(bridge,registered),configured=frame.root.bridge.limits;
        if(value.operation==="batch"){
          const source=frame.state.states.find(row=>row.projectId===input.projectId),pending=source?.spools.find((row:Row)=>row.kind==="tail"),enrollment=source?.transfer&&JSON.parse(source.transfer.enrollment_json).binding;
          const expected=pending?JSON.parse(JSON.parse(pending.manifest_json).input).after:source&&source.operations.length>1?JSON.parse(source.operations.at(-1)!.input_json).cursor:enrollment?.initialCursor;
          if(!expected||JSON.stringify(value.after)!==JSON.stringify(expected))fail("Original source batch must follow its current acknowledged target cursor.");
        }
        const limits={maxArchiveBytes:configured.maxArchiveBytes,maxBatchEntries:configured.maxBatchEntries,maxBatchBytes:configured.maxBatchBytes};
        const maximumBytes=value.operation==="checkpoint"?limits.maxArchiveBytes:value.operation==="batch"?limits.maxBatchBytes:16384;
        const id=globalThis.crypto.randomUUID(),command=JSON.stringify({protocol:"clank-source-recovery-command/1",operationId:id,input:encoded,limits});
        if(Buffer.byteLength(command)>4096)fail("Original source operation exceeds its encoded command bound.");
        const deadline=(globalThis as any).process.hrtime.bigint()+BigInt(configured.controlTimeoutMs)*1000000n;
        return new Promise<string>((resolve,reject)=>{
          const timer=setTimeout(()=>{invalidate();},configured.controlTimeoutMs);
          operation={id,command,maximumBytes,sent:false,parts:[],offset:0,bytes:0,resolve,reject,timer};
        }).then(async completed=>{
          const output=JSON.parse(completed);if(output?.protocol!=="clank-source-recovery-output/1")return completed;
          try{const body=await receiveOutput(output,encoded,maximumBytes,deadline);check();
            const released=await sendOperation(JSON.stringify({protocol:"clank-source-recovery-output-release/1",output}),true);check();
            if(released!==JSON.stringify({protocol:"clank-source-recovery-output-released/1",resultSha256:output.resultSha256})||(globalThis as any).process.hrtime.bigint()>=deadline)fail("Original source output release is uncertain or expired.");return body;
          }catch(error){invalidate();throw error;}
        });
      }catch(error){return Promise.reject(error);}
    };
    let enrollmentFlight=false;
    const operate=(encoded:string):Promise<string>=>{
      try{
        check();if(enrollmentFlight)fail("Original source operation is already owned.");
        if(typeof encoded!=="string"||Buffer.byteLength(encoded)>3072)fail("Original source operation exceeds its command bound.");
        const value=JSON.parse(encoded);
        if(value?.protocol==="clank-source-recovery-operation/1"&&value.operation==="enroll"){
          if(!controlContainer)fail("Original source enrollment has no coupled container.");enrollmentFlight=true;
          return commitProviderSourceEnrollment(result as ProviderSourceControlChannel,controlContainer,encoded).finally(()=>{enrollmentFlight=false;});
        }
        enrollmentFlight=true;return sendOperation(encoded).finally(()=>{enrollmentFlight=false;});
      }catch(error){return Promise.reject(error);}
    };
    context={check,invalidate,binding:grant!.binding,containerId:()=>containerId,mountSource:pins[4]!.path,
      ...(control?{acceptReady(value:string){if(closed||readyRecord!==undefined||!initialized||!controlServer||!controlContainer)fail("Original source readiness cannot be adopted or recycled.");const parsed=JSON.parse(value);if(parsed.initialization!==sourceInitializationLeases.get(initialized)?.encoded||JSON.stringify(parsed.channel)!==JSON.stringify(controlServer.binding))fail("Original source readiness differs.");readyRecord=value;}}:{}),
      ...(control?{sendOperation,async acknowledgeTarget(receipt:object){
        check();if(enrollmentFlight||operation||!controlContainer)fail("Original source settlement is already owned or unavailable.");enrollmentFlight=true;
        let release:(()=>void)|undefined;
        try{const target=await import("./provider-target-stage.ts"),original=target.providerTargetTransferReceiptContext(receipt as import("./provider-target-stage.ts").ProviderTargetTransferReceipt);const source=providerSourceTransferContext(original.source);
          if(source.bridge!==bridge||original.source.grantId!==input.grantId)fail("Target receipt belongs to another original source.");release=original.reserve();await original.verify();original.check();check();
          const acknowledged=await commitProviderSourceTargetReceipt(result as ProviderSourceControlChannel,controlContainer,original.body,original.check);check();original.check();
          const prior=outputSlots.get("tail"),body=JSON.parse(original.body);
          if(prior){if(prior.resultSha256!==body.sourceSpoolSha256)fail("Original source settlement spool differs.");assertPin(c,prior.file);assertPin(c,prior.manifest);if(sourceMetadata(c,prior.manifest)!==prior.manifestJSON)fail("Original settled spool manifest differs.");
            // Remove only these original acknowledged files. No await can
            // expose unlinked pins to another original control observer.
            c.fs.unlinkSync(prior.file.path);c.fs.unlinkSync(prior.manifest.path);outputSlots.delete("tail");
            for(const pin of [prior.file,prior.manifest]){retained.splice(retained.indexOf(pin),1);c.fs.closeSync(pin.fd);}c.fs.fsyncSync(outputRoot!.fd);check();
          }return acknowledged;
        }catch(error){invalidate();throw error;}finally{release?.();enrollmentFlight=false;}
      },async quiesceTarget(receipt:object){
        check();if(enrollmentFlight||operation||!controlContainer)fail("Original source quiescence is already owned or unavailable.");enrollmentFlight=true;let release:(()=>void)|undefined;
        try{const target=await import("./provider-target-stage.ts"),original=target.providerTargetTransferReceiptContext(receipt as import("./provider-target-stage.ts").ProviderTargetTransferReceipt),source=providerSourceTransferContext(original.source);if(source.bridge!==bridge||original.source.grantId!==input.grantId)fail("Target belongs to another original source.");release=original.reserve();await original.verify();original.check();check();return await commitProviderSourceQuiescence(result as ProviderSourceControlChannel,controlContainer,original.source,original.body,original.check);
        }catch(error){invalidate();throw error;}finally{release?.();enrollmentFlight=false;}
      },acceptCatalog(before:string,after:string){
        if(closed||!readyRecord||ownedCatalog!==undefined&&ownedCatalog!==before||ownedCatalog===undefined&&JSON.parse(before).version!==5)fail("Original control catalog preimage differs.");
        const next=JSON.parse(after);if(next.version!==JSON.parse(before).version+1||next.grant?.readiness_json!==readyRecord)fail("Original control catalog transition differs.");ownedCatalog=after;
      }}:{}),
    };
    const common={mountSource:context.mountSource,assertCurrent:check,verifyCurrent,bindCreated,close};
    const result:ProviderSourceWorkerChannel|ProviderSourceControlChannel=control?Object.freeze({...common,initialize,operate}):Object.freeze({...common,dispatch});
    check();const active=owners.get(registered.owner)??new Set<SourceWorkerChannelContext>();active.add(context);owners.set(registered.owner,active);
    const channels=bridges.get(bridge)??new Map<string,SourceWorkerChannelContext>();channels.set(input.grantId,context);bridges.set(bridge,channels);if(control)sourceControlChannels.set(result as ProviderSourceControlChannel,context);else sourceWorkerChannels.set(result as ProviderSourceWorkerChannel,context);published=true;
    watch=setInterval(()=>{try{check();controlContainer?.assertCurrent();if(initializationRequest&&!initialized)initializationRequest.assertCurrent();}catch{invalidate();}},50);watch.unref?.();void broker.closed.then(()=>invalidate());check();return result;
  }catch(error){invalidate();try{await close();}catch(failure){throw new AggregateError([error,failure],"Issued source channel preparation and cleanup failed.");}throw error;}
  finally{if(!published)secret.fill(0);if(reserved)pendingChannels.set(registered.owner,(pendingChannels.get(registered.owner)??1)-1);}
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
type SourceContainerContext={check:()=>void;data:ProviderSourceRuntimeDataLease;scope:SourceRuntimeDataContext;children:Set<()=>void>;workerRetained:boolean;initializationRetained:boolean;initializationRequested:boolean};
const sourceContainerLeases=new WeakMap<ProviderSourceContainerLease,SourceContainerContext>();
function sourceWorkerChannelFor(context:SourceRuntimeDataContext):SourceWorkerChannelContext|undefined {
  const channel=bridgeWorkerChannels.get(context.parent.bridge)?.get(context.parent.input.grantId);
  if(!channel)return undefined;channel.check();
  if(channel.containerId()!==context.parent.input.containerId||JSON.stringify(channel.binding)!==JSON.stringify(context.grant.binding))fail("Provider source channel ownership differs.");
  return channel;
}
function sourceControlChannelFor(context:SourceRuntimeDataContext):SourceWorkerChannelContext|undefined {
  const channel=bridgeControlChannels.get(context.parent.bridge)?.get(context.parent.input.grantId);
  if(!channel)return undefined;channel.check();
  if(channel.containerId()!==context.parent.input.containerId||JSON.stringify(channel.binding)!==JSON.stringify(context.grant.binding))fail("Provider source control ownership differs.");
  return channel;
}
const SOURCE_CONTAINER_PROJECTION=`{"identity":${CONTAINER_PROJECTION},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"apparmor":{{json .AppArmorProfile}},"workingDirectory":{{json .Config.WorkingDir}}}`;
const SOURCE_MASKED_PATHS=["/proc/asound","/proc/acpi","/proc/kcore","/proc/keys","/proc/latency_stats","/proc/timer_list","/proc/timer_stats","/proc/sched_debug","/proc/scsi","/sys/firmware","/sys/devices/virtual/powercap"];
const SOURCE_READONLY_PATHS=["/proc/bus","/proc/fs","/proc/irq","/proc/sys","/proc/sysrq-trigger"];
function sourceContainerObservation(encoded:string,data:ProviderSourceRuntimeDataLease,context:SourceRuntimeDataContext,originalChannel?:SourceWorkerChannelContext|null,originalControl?:SourceWorkerChannelContext|null):{pid:number;encoded:string} {
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
  const control=originalControl===undefined?sourceControlChannelFor(context):originalControl;if(control)expected.push({target:"/run/clank-source-control",source:control.mountSource,rw:false});
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
function sourceProcess(c:Context,pid:number,containerId:string,binding:Row,channel?:SourceWorkerChannelContext,observeChannel?:()=>void,control?:SourceWorkerChannelContext,observeControl?:()=>void):{birth:string;namespaces:Record<string,string>} {
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
  if(control){control.check();observeControl?.();requiredMounts.push(["/run/clank-source-control","ro"]);}
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
export function providerSourceControlFailure(value:ProviderSourceContainerLease):string|undefined{const held=sourceContainerLeases.get(value);if(!held)fail("A genuine original source container is required.");return sourceControlChannelFor(held.scope)?.failure;}
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
      const channel=sourceWorkerChannelFor(scope),control=sourceControlChannelFor(scope),observed=sourceContainerObservation(response.stdout,data,scope),process=sourceProcess(c,observed.pid,parent.input.containerId,grant.binding,channel,undefined,control);
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
      let observeControl:(()=>void)|undefined;
      if(control){
        control.check();const path=control.mountSource,before=c.fs.lstatSync(path),descriptor=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_DIRECTORY|c.fs.constants.O_NOFOLLOW);held.push(descriptor);
        observeControl=()=>{for(const stat of [c.fs.fstatSync(descriptor),c.fs.lstatSync(path)]){
          if(!stat.isDirectory()||stat.dev!==before.dev||stat.ino!==before.ino||stat.uid!==grant.binding.uid||stat.gid!==grant.binding.gid||(stat.mode&0o777)!==0o700)fail("Provider source control mount observation changed.");
        }if(c.fs.realpathSync(path)!==path)fail("Provider source control mount path changed.");};observeControl();
      }
      const namespacePins=Object.entries(process.namespaces).map(([name,link])=>{
        const descriptor=c.fs.openSync(`/proc/${observed.pid}/ns/${name}`,c.fs.constants.O_RDONLY);held.push(descriptor);
        const stat=c.fs.fstatSync(descriptor);if(String(stat.ino)!==link.slice(name.length+2,-1))fail("Provider source namespace pin identity differs.");return {descriptor,dev:stat.dev,ino:stat.ino};
      });
      const mounted=[{target:"/app",source:data.releaseDirectory},{target:"/data",source:data.dataDirectory},{target:"/run/clank-source",source:c.path.join(c.service.path,"handoff","catalogs",grant.binding.catalogId)}];
      if(channel)mounted.push({target:"/run/clank-source-worker",source:channel.mountSource});
      if(control)mounted.push({target:"/run/clank-source-control",source:control.mountSource});
      const identity=mounted.map(m=>{const s=c.fs.lstatSync(m.source);return {...m,dev:s.dev,ino:s.ino};});
      const check=()=>{
        try{if(closed)fail("Provider source container lease is closed.");scope.check();const fresh=sourceProcess(c,observed.pid,parent.input.containerId,grant.binding,channel,observeChannel,control,observeControl);
          if(fresh.birth!==process.birth||JSON.stringify(fresh.namespaces)!==JSON.stringify(process.namespaces))fail("Provider source process identity changed.");
          for(const p of namespacePins){const retained=c.fs.fstatSync(p.descriptor);if(retained.dev!==p.dev||retained.ino!==p.ino)fail("Provider source namespace pin changed.");}
          const retained=c.fs.fstatSync(fd),visible=c.fs.statSync(root);if(retained.dev!==visible.dev||retained.ino!==visible.ino)fail("Provider source process root changed.");
          for(const m of identity){const from=c.fs.lstatSync(m.source),actual=c.fs.statSync(`/proc/self/fd/${fd}`+m.target);
            if(!from.isDirectory()||!actual.isDirectory()||from.dev!==m.dev||from.ino!==m.ino||actual.dev!==m.dev||actual.ino!==m.ino)fail("Provider source native mount identity differs.");}
        }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source process observation and cleanup failed.");}throw error;}
      };
      const verifyCurrent=async()=>{
        try{check();await exclusive(parent.registered.owner,async()=>{check();await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();
          const next=await runProviderDockerClient(client,args,{timeoutMs:15000,maxOutputBytes:65536});check();const confirmed=sourceContainerObservation(next.stdout,data,scope,channel??null,control??null);if(confirmed.encoded!==observed.encoded){const before=JSON.parse(observed.encoded),after=JSON.parse(confirmed.encoded);const field=["identity","host","mounts","apparmor","workingDirectory"].find(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));fail("Provider source container configuration changed ("+field+").");}
          await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();},parent.bridge);check();
        }catch(error){try{close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source container verification and cleanup failed.");}throw error;}
      };
      if(channel)children.add(channel.invalidate);if(control)children.add(control.invalidate);
      lease=Object.freeze({containerId:parent.input.containerId,pid:observed.pid,birth:process.birth,assertCurrent:check,verifyCurrent,close});
      check();sourceContainerLeases.set(lease,{check,data,scope,children,workerRetained:false,initializationRetained:false,initializationRequested:false});scope.children.add(close);scope.containerRetained=true;
      await verifyDomain(parent.registered.owner,parent.registered.domain,true);check();
    },parent.bridge);
    assertProviderSourceContainerLease(lease!);return lease!;
  }catch(error){try{pendingClose?.();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider source container publication failed.");}throw error;}
}
export interface ProviderSourceInitializationLease {
  readonly completion:Readonly<Record<string,unknown>>;
  assertCurrent():void;
  close():void;
}
const sourceInitializationLeases=new WeakMap<object,{current():void;container:ProviderSourceContainerLease;encoded:string}>();
export function assertProviderSourceInitializationLease(value:ProviderSourceInitializationLease):void{
const retained=sourceInitializationLeases.get(value);if(!retained)fail("A genuine provider source initialization lease is required.");retained.current();
}
/** Original host challenge ownership; transport and write admission remain separate. */






export interface ProviderSourceInitializationRequest {
  readonly challenge:string;
  accept(encoded:string):Promise<ProviderSourceInitializationLease>;
  assertCurrent():void;
  close():void;
}
const sourceInitializationRequests=new WeakMap<object,{current():void}>();
export function assertProviderSourceInitializationRequest(value:ProviderSourceInitializationRequest):void{
const retained=sourceInitializationRequests.get(value);if(!retained)fail("A genuine provider source initialization request is required.");retained.current();
}
export async function requestProviderSourceInitialization(
container:ProviderSourceContainerLease,controlSecret:Uint8Array,
):Promise<ProviderSourceInitializationRequest>{
const retained=sourceContainerLeases.get(container);if(!retained)fail("A genuine provider source container lease is required.");retained.check();
if(retained.initializationRequested||retained.initializationRetained)fail("Original source initialization request cannot be duplicated or recycled.");
const typed=Object.getPrototypeOf(Uint8Array.prototype);
try{
if(!(controlSecret instanceof Uint8Array)||!ArrayBuffer.isView(controlSecret)||Object.getOwnPropertyDescriptor(typed,"byteLength")!.get! .call(controlSecret)!==32)fail();
Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get! .call(Object.getOwnPropertyDescriptor(typed,"buffer")!.get! .call(controlSecret));
}catch{fail("Source initialization input requires32native non-shared bytes.");}
const secret=new Uint8Array(controlSecret);retained.initializationRequested=true;
let closed=false,consumed=false,nonce:Uint8Array|undefined,deadline:bigint|undefined,timer:ReturnType<typeof setTimeout>|undefined;
const now=()=>((globalThis as any).process.hrtime.bigint() as bigint);
const close=()=>{if(closed)return;closed=true;if(timer!==undefined)clearTimeout(timer);secret.fill(0);nonce?.fill(0);retained.children.delete(close);};
const current=()=>{try{if(closed||deadline!==undefined&&now()>=deadline)fail("Original source initialization request is closed.");retained.check();}catch(error){close();throw error;}};
retained.children.add(close);
try{
const cryptoName="node:crypto",crypto=await import(cryptoName);current();
const parent=retained.scope.parent,secretHash=crypto.createHash("sha256").update(secret).digest("hex");
await withBridge(parent.bridge,true,()=>{
current();const frame=containerFrame(parent.bridge,parent.registered),state=frame.state.states.find(row=>row.projectId===parent.input.projectId),grant=state?.grant;
if(!grant||state.version!==4||grant.state!=="started"||grant.grant_id!==parent.input.grantId||grant.container_id!==parent.input.containerId||grant.binding_sha256!==parent.input.bindingSha256||!crypto.timingSafeEqual(Buffer.from(grant.control_secret_sha256,"hex"),Buffer.from(secretHash,"hex")))fail("Source initialization request does not match its original started grant.");
const timeoutMs=frame.root.bridge.limits.controlTimeoutMs;
deadline=now()+BigInt(timeoutMs)*1000000n;timer=setTimeout(close,timeoutMs);timer.unref?.();
});current();
await container.verifyCurrent();current();
nonce=crypto.randomBytes(32);
const result:ProviderSourceInitializationRequest=Object.freeze({challenge:Buffer.from(nonce!).toString("base64url"),assertCurrent:current,close,
async accept(encoded:string){
current();if(consumed)fail("Original source initialization response was already consumed.");consumed=true;
let initialized:ProviderSourceInitializationLease|undefined;
try{initialized=await retainProviderSourceInitialization(container,encoded,nonce!,secret);current();return initialized;}
catch(error){initialized?.close();throw error;}
finally{close();}
},
});
current();sourceInitializationRequests.set(result,{current});return result;
}catch(error){close();throw error;}
}
/** Authenticated original initialization evidence only; no ready/write state is changed. */
export async function retainProviderSourceInitialization(
container:ProviderSourceContainerLease,encoded:string,challenge:Uint8Array,controlSecret:Uint8Array,
):Promise<ProviderSourceInitializationLease>{
const retained=sourceContainerLeases.get(container);if(!retained)fail("A genuine provider source container lease is required.");retained.check();
if(retained.initializationRetained)fail("Original source initialization cannot be duplicated or recycled.");
if(typeof encoded!=="string"||new TextEncoder().encode(encoded).length>4096)fail("Source initialization response exceeds its bound.");
const typed=Object.getPrototypeOf(Uint8Array.prototype),length=Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!,backing=Object.getOwnPropertyDescriptor(typed,"buffer")!.get!,arrayLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!;
const copy=(value:Uint8Array)=>{try{if(!(value instanceof Uint8Array)||!ArrayBuffer.isView(value)||length.call(value)!==32)fail();arrayLength.call(backing.call(value));return new Uint8Array(value);}catch{fail("Source initialization input requires32native non-shared bytes.");}};
const nonce=copy(challenge);let secret:Uint8Array|undefined;
try{
secret=copy(controlSecret);
const cryptoName="node:crypto",crypto=await import(cryptoName);retained.check();
const parent=retained.scope.parent,identity={bindingSha256:parent.input.bindingSha256,containerId:parent.input.containerId,sourceIncarnation:retained.scope.grant.binding.sourceIncarnation};
let packet:Row;try{packet=JSON.parse(encoded);}catch{fail("Invalid source initialization response.");}
if(!exact(packet,["protocol","identity","nonce","completion","mac"])||packet.protocol!=="clank-source-initialization/1"||!exact(packet.identity,["bindingSha256","containerId","sourceIncarnation"])||JSON.stringify(packet.identity)!==JSON.stringify(identity)||packet.nonce!==Buffer.from(nonce).toString("base64url")||!match(packet.mac,DIGEST))fail("Source initialization identity or nonce differs.");
const completion=packet.completion;
if(!exact(completion,["captureEpoch","keyId","schemaHash","baseBackupId","observedCursor"])||!match(completion.captureEpoch,UUID)||completion.keyId!==retained.scope.grant.binding.capture.keyId||!match(completion.schemaHash,DIGEST)||!match(completion.baseBackupId,/^bk_[1-9][0-9]{0,15}_[A-Za-z0-9_-]{24}$/u)||!Number.isSafeInteger(Number(completion.baseBackupId.split("_")[1]))||!exact(completion.observedCursor,["epoch","sequence","digest"])||completion.observedCursor.epoch!==completion.captureEpoch||completion.observedCursor.sequence!==0||completion.observedCursor.digest!=="0".repeat(64))fail("Source initialization completion differs from the original first base.");
const body={protocol:packet.protocol,identity,nonce:packet.nonce,completion};
if(JSON.stringify({...body,mac:packet.mac})!==encoded)fail("Source initialization response is not canonical.");
const key=crypto.createHmac("sha256",secret).update(JSON.stringify({protocol:"clank-source-initialization-key/1",identity})).digest();
try{const expected=crypto.createHmac("sha256",key).update(JSON.stringify(body)).digest();if(!crypto.timingSafeEqual(Buffer.from(packet.mac,"hex"),expected))fail("Source initialization authentication differs.");}finally{key.fill(0);}
const secretHash=crypto.createHash("sha256").update(secret).digest("hex");secret.fill(0);
await container.verifyCurrent();retained.check();
await withBridge(parent.bridge,true,()=>{
retained.check();if(retained.initializationRetained)fail("Original source initialization cannot be duplicated or recycled.");
const frame=containerFrame(parent.bridge,parent.registered),state=frame.state.states.find(row=>row.projectId===parent.input.projectId),grant=state?.grant;
if(!grant||state.version!==4||grant.state!=="started"||grant.grant_id!==parent.input.grantId||grant.container_id!==identity.containerId||grant.binding_sha256!==identity.bindingSha256||!crypto.timingSafeEqual(Buffer.from(grant.control_secret_sha256,"hex"),Buffer.from(secretHash,"hex")))fail("Source initialization does not match its original started grant.");
retained.initializationRetained=true;
});retained.check();
await container.verifyCurrent();retained.check();
let closed=false;
const close=()=>{if(closed)return;closed=true;retained.children.delete(close);};
const current=()=>{try{if(closed)fail("Original source initialization lease is closed.");retained.check();}catch(error){close();throw error;}};
const result=Object.freeze({completion:freezeValue(completion),assertCurrent:current,close});
current();sourceInitializationLeases.set(result,{current,container,encoded});retained.children.add(close);return result;
}finally{nonce.fill(0);secret?.fill(0);}
}
/** Owning ready commit; no serialized record can mint this transition. */
async function commitProviderSourceReady(channel:ProviderSourceControlChannel,container:ProviderSourceContainerLease,initialization:ProviderSourceInitializationLease,binding:import("./provider-source-worker-wire.ts").SourceWorkerChannelBinding):Promise<void>{
  const control=sourceControlChannels.get(channel),retained=sourceContainerLeases.get(container),completed=sourceInitializationLeases.get(initialization);
  if(!control||!retained||!completed||completed.container!==container||sourceControlChannelFor(retained.scope)!==control||!control.acceptReady)fail("Original source readiness requires its coupled control and initialization.");
  completed.current();await container.verifyCurrent();completed.current();
  const parent=retained.scope.parent;
  try{
    await withBridge(parent.bridge,true,(c,root,state,registered)=>{
      completed.current();const frame=containerFrame(parent.bridge,registered),source=state.states.find(row=>row.projectId===parent.input.projectId),project=state.projects.find(row=>row.project_id===parent.input.projectId),grant=source?.grant;
      if(!source||!project||!grant||source.version!==4||grant.state!=="started"||grant.grant_id!==parent.input.grantId||grant.container_id!==parent.input.containerId)fail("Original source ready preimage differs.");
      const ready=boundedJSON({protocol:"clank-provider-source-ready/1",channel:binding,initialization:completed.encoded,initializationSha256:c.hash(completed.encoded)},8192);
      const expected={...grant,state:"ready",readiness_json:ready,readiness_sha256:c.hash(ready)},wanted={version:5,grant:expected,transfer:null,operations:[],spools:[]};
      const beforeJSON=JSON.stringify({state:frame.state,index:frame.indexRows}),post={...state,states:state.states.map(row=>row.projectId===parent.input.projectId?{...row,...wanted}:row)},afterJSON=JSON.stringify({state:post,index:frame.indexRows}),from=c.pins.length;
      try{
        const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);
        databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
          catalog(c,db,root,project);const before=bridgeCatalog(c,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
          if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...before})!==JSON.stringify(source))fail("Original source ready catalog preimage changed.");
          const sql="UPDATE clank_provider_handoff_source_grant SET state='ready',readiness_json=?,readiness_sha256=? WHERE id=1 AND protocol=2 AND grant_id=? AND binding_json=? AND binding_sha256=? AND grant_secret_sha256=? AND control_secret_sha256=? AND state='started' AND container_id=? AND readiness_json IS NULL AND readiness_sha256 IS NULL";
          if(db.prepare(sql).run(ready,c.hash(ready),grant.grant_id,grant.binding_json,grant.binding_sha256,grant.grant_secret_sha256,grant.control_secret_sha256,grant.container_id).changes!==1||JSON.stringify(bridgeRecords(db).grant)!==JSON.stringify(expected))fail("Original source ready grant write differs.");
          const mirror=c.hash(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX));if(db.prepare(CONTAINER_MIRROR_CAS).run(mirror,registered.enablementId,4,metadata.records_sha256).changes!==1)fail("Original source ready mirror write differs.");
          commitBridgeFile(c,registered.owner,db,file,target,()=>{catalog(c,db,root,project);if(JSON.stringify(bridgeCatalog(c,db,root,project,state.reservations))!==JSON.stringify(wanted))fail("Original source ready durable readback differs.");});
        }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
        // Both snapshots update synchronously after the exact owning commit.
        // No observer may adopt an arbitrary later row or await between these.
        parent.acceptState(beforeJSON,afterJSON);control.acceptReady!(ready);ownerSourceServices.get(registered.owner)?.acceptReady(grant.grant_id,ready);completed.current();
      }finally{releasePins(c,from);}
    });completed.current();await container.verifyCurrent();completed.current();
  }catch(error){initialization.close();control.invalidate();throw error;}
}
/** Publish only an original source output already held by this host channel. */
async function commitProviderSourceSpool(channel:ProviderSourceControlChannel,container:ProviderSourceContainerLease,manifestJSON:string):Promise<void>{
  const nativeFrame=(value:Row)=>JSON.stringify({root:value.root,state:value.state,indexRows:value.indexRows});
  const control=sourceControlChannels.get(channel),retained=sourceContainerLeases.get(container);
  if(!control||!retained||sourceControlChannelFor(retained.scope)!==control||!control.acceptCatalog||!control.sendOperation)fail("Source spool publication requires its original coupled control.");
  const parent=retained.scope.parent,c=parent.context,manifest=JSON.parse(manifestJSON);
  const row={kind:manifest.output?.kind,reservation_id:manifest.reservationId,state:"ready",manifest_json:manifestJSON,manifest_sha256:c.hash(manifestJSON)};
  const captured=await withBridge(parent.bridge,true,(_c,_root,state,registered)=>{
    control.check();retained.check();const frame=containerFrame(parent.bridge,registered),before=state.states.find(value=>value.projectId===parent.input.projectId);
    if(!before||before.grant?.state!=="ready")fail("Original source spool is not ready.");sourceSpools(c,before.grant,[row],state.reservations);return {frame,before};
  });control.check();retained.check();const before=captured.before,existing=before.spools.find((value:Row)=>value.kind===row.kind);
  if(existing){if(JSON.stringify(existing)!==JSON.stringify(row))fail("Original source spool publication retry differs.");return;}
  if(row.kind==="tail"&&before.transfer?.phase!=="enrolled")fail("Original journal spool requires its enrolled transfer.");
  const after={...before,version:before.version+1,spools:[...before.spools,row].sort((a:Row,b:Row)=>a.kind<b.kind?-1:1)},records=(value:Row)=>({grant:value.grant,transfer:value.transfer,operations:value.operations,spools:value.spools});
  const beforeHash=c.hash(boundedJSON(records(before),BRIDGE_CATALOG_MAX)),afterHash=c.hash(boundedJSON(records(after),BRIDGE_CATALOG_MAX));
  const proposal=boundedJSON({protocol:"clank-source-spool-prepare/1",before:{version:before.version,recordsSha256:beforeHash},after:{version:after.version,recordsSha256:afterHash},manifest:manifestJSON},3072);
  try{
    const prepared=await control.sendOperation(proposal,true);control.check();retained.check();if(prepared!==JSON.stringify({protocol:"clank-source-spool-prepared/1",proposalSha256:c.hash(proposal)}))fail("Original source spool preparation differs.");
    await withBridge(parent.bridge,true,(context,root,state,registered)=>{
      control.check();retained.check();const frame=containerFrame(parent.bridge,registered),project=state.projects.find(value=>value.project_id===parent.input.projectId);
      if(!project||nativeFrame(frame)!==nativeFrame(captured.frame)||JSON.stringify(state.states.find(value=>value.projectId===parent.input.projectId))!==JSON.stringify(before))fail("Source spool native preimage changed after preparation.");
      const post={...frame.state,states:frame.state.states.map(value=>value.projectId===parent.input.projectId?after:value)},beforeJSON=JSON.stringify({state:frame.state,index:frame.indexRows}),afterJSON=JSON.stringify({state:post,index:frame.indexRows}),from=context.pins.length;
      try{
        const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
        databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
          catalog(context,db,root,project);const old=bridgeCatalog(context,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
          if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...old})!==JSON.stringify(before)||metadata.records_sha256!==beforeHash)fail("Source spool catalog preimage differs.");
          if(db.prepare("INSERT INTO clank_provider_handoff_source_spools VALUES(?,?,?,?,?)").run(row.kind,row.reservation_id,row.state,row.manifest_json,row.manifest_sha256).changes!==1
            ||boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(after),BRIDGE_CATALOG_MAX)
            ||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,registered.enablementId,before.version,beforeHash).changes!==1)fail("Source spool catalog write or mirror differs.");
          commitBridgeFile(context,registered.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(after))fail("Source spool durable readback differs.");});
        }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
        // Every original observer moves synchronously with this owning commit.
        parent.acceptState(beforeJSON,afterJSON);control.acceptCatalog!(JSON.stringify(before),JSON.stringify(after));ownerSourceServices.get(registered.owner)?.acceptCatalog(parent.input.grantId,JSON.stringify(before),JSON.stringify(after));acceptSourceTransferCatalog(registered.owner,JSON.stringify(before),JSON.stringify(after));control.check();retained.check();
      }finally{releasePins(context,from);}
    });control.check();retained.check();
    const observation=await control.sendOperation(JSON.stringify({protocol:"clank-source-catalog-observe/1",version:after.version,recordsSha256:afterHash}),true);control.check();retained.check();
    if(observation!==JSON.stringify({protocol:"clank-source-catalog-observed/1",version:after.version,recordsSha256:afterHash}))fail("Original source spool commit observation differs.");
    await container.verifyCurrent();control.check();retained.check();
  }catch(error){control.invalidate();throw error;}
}
/** A source slot is settled only by an original, freshly inspected target receipt. */
export async function acknowledgeProviderSourceTargetReceipt(value:object):Promise<string>{
 const module=await import("./provider-target-stage.ts"),receipt=module.providerTargetTransferReceiptContext(value as import("./provider-target-stage.ts").ProviderTargetTransferReceipt),source=providerSourceTransferContext(receipt.source),control=bridgeControlChannels.get(source.bridge)?.get(receipt.source.grantId);
 if(!control?.acknowledgeTarget)fail("Original source target settlement control is unavailable.");control.check();return control.acknowledgeTarget(value);
}
async function commitProviderSourceTargetReceipt(channel:ProviderSourceControlChannel,container:ProviderSourceContainerLease,encoded:string,targetCurrent:()=>void):Promise<string>{
 const control=sourceControlChannels.get(channel),retained=sourceContainerLeases.get(container);
 if(!control||!retained||sourceControlChannelFor(retained.scope)!==control||!control.acceptCatalog||!control.sendOperation)fail("Original source target settlement requires its coupled control.");
 control.check();retained.check();targetCurrent();const parent=retained.scope.parent,c=parent.context;
 const captured=await withBridge(parent.bridge,true,(_c,_root,state,registered)=>{control.check();retained.check();targetCurrent();const frame=containerFrame(parent.bridge,registered),before=state.states.find(row=>row.projectId===parent.input.projectId);if(!before?.grant||before.grant.state!=="ready"||before.transfer?.phase!=="enrolled")fail("Original source target settlement is not enrolled.");return {frame,before};});
 control.check();retained.check();targetCurrent();const before=captured.before,binding=JSON.parse(before.transfer.enrollment_json).binding,hash=c.hash(encoded),step="ack_"+hash;
 const existing=before.operations.find((row:Row)=>row.step_id===step);
 if(existing){if(existing.input_json!==encoded||existing.state!=="complete")fail("Original source target settlement retry differs.");return existing.result_json;}
 const predecessor=before.operations.length>1?JSON.parse(before.operations.at(-1)!.input_json).cursor:binding.initialCursor,receipt=sourceTargetReceipt(c,encoded,before.grant,binding,predecessor),tail=before.spools.find((row:Row)=>row.kind==="tail");
 if(receipt.kind!=="tail"||!tail||JSON.parse(tail.manifest_json).output.resultSha256!==receipt.sourceSpoolSha256||before.operations.length>=captured.frame.root.bridge.limits.maxOperations)fail("Original target receipt does not settle the pending source tail or exceeds capacity.");
 const key=await resolveProviderSourceCaptureKey(parent.bridge,parent.input.projectId,parent.input.grantId);let batch:Row;
 try{batch=JSON.parse(await readProviderSourceSpool(parent.bridge,parent.input.projectId,"tail"));control.check();retained.check();targetCurrent();const crypto=await import("node:crypto"),{authentication,...content}=batch;
  if(authentication!==crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex")||JSON.stringify(batch.after)!==JSON.stringify(receipt.after)||JSON.stringify(batch.through)!==JSON.stringify(receipt.cursor)||batch.baseBackupId!==receipt.baseBackupId||batch.keyId!==receipt.keyId)fail("Original target cursor differs from its authenticated source tail.");
 }finally{key.fill(0);}
 const result=JSON.stringify({protocol:"clank-provider-source-target-acknowledged/1",receiptSha256:hash,cursor:receipt.cursor}),operation={sequence:before.operations.length+1,step_id:step,kind:"batch",input_json:encoded,input_sha256:hash,state:"complete",result_json:result,result_sha256:c.hash(result)},after:Row={...before,version:before.version+1,operations:[...before.operations,operation],spools:before.spools.filter((row:Row)=>row.kind!=="tail")};
 sourceEnrollment(c,after.grant,after.transfer,after.operations);
 const records=(value:Row)=>({grant:value.grant,transfer:value.transfer,operations:value.operations,spools:value.spools}),beforeHash=c.hash(boundedJSON(records(before),BRIDGE_CATALOG_MAX)),afterHash=c.hash(boundedJSON(records(after),BRIDGE_CATALOG_MAX)),proposal=JSON.stringify({protocol:"clank-source-target-prepare/1",before:{version:before.version,recordsSha256:beforeHash},after:{version:after.version,recordsSha256:afterHash},receipt:encoded});
 try{
  const prepared=await control.sendOperation(proposal,true);control.check();retained.check();targetCurrent();if(prepared!==JSON.stringify({protocol:"clank-source-target-prepared/1",proposalSha256:c.hash(proposal)}))fail("Original source target preparation differs.");
  await withBridge(parent.bridge,true,(context,root,state,registered)=>{
   control.check();retained.check();targetCurrent();const frame=containerFrame(parent.bridge,registered),project=state.projects.find(row=>row.project_id===parent.input.projectId);
   if(!project||JSON.stringify({root:frame.root,state:frame.state,index:frame.indexRows})!==JSON.stringify({root:captured.frame.root,state:captured.frame.state,index:captured.frame.indexRows}))fail("Original source target settlement preimage changed.");
   const beforeJSON=JSON.stringify({state:frame.state,index:frame.indexRows}),post={...frame.state,states:frame.state.states.map(row=>row.projectId===parent.input.projectId?after:row)},afterJSON=JSON.stringify({state:post,index:frame.indexRows}),from=context.pins.length;
   try{const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
    databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
     const actual=bridgeCatalog(context,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...actual})!==JSON.stringify(before)||metadata.records_sha256!==beforeHash)fail("Original source target catalog preimage differs.");
     if(db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(?,?,?,?,?,'complete',?,?)").run(operation.sequence,step,"batch",encoded,hash,result,c.hash(result)).changes!==1||db.prepare("DELETE FROM clank_provider_handoff_source_spools WHERE kind='tail' AND reservation_id=? AND manifest_json=? AND manifest_sha256=?").run(tail.reservation_id,tail.manifest_json,tail.manifest_sha256).changes!==1||boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(after),BRIDGE_CATALOG_MAX)||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,registered.enablementId,before.version,beforeHash).changes!==1)fail("Original source target receipt or mirror was not retained.");
     commitBridgeFile(context,registered.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(after))fail("Original source target receipt durable readback differs.");});
    }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    parent.acceptState(beforeJSON,afterJSON);control.acceptCatalog!(JSON.stringify(before),JSON.stringify(after));ownerSourceServices.get(registered.owner)?.acceptCatalog(parent.input.grantId,JSON.stringify(before),JSON.stringify(after));acceptSourceTransferCatalog(registered.owner,JSON.stringify(before),JSON.stringify(after));control.check();retained.check();targetCurrent();
   }finally{releasePins(context,from);}
  });control.check();retained.check();targetCurrent();
  const observed=await control.sendOperation(JSON.stringify({protocol:"clank-source-catalog-observe/1",version:after.version,recordsSha256:afterHash}),true);control.check();retained.check();targetCurrent();if(observed!==JSON.stringify({protocol:"clank-source-catalog-observed/1",version:after.version,recordsSha256:afterHash}))fail("Original source target settlement observation differs.");await container.verifyCurrent();control.check();retained.check();targetCurrent();return result;
 }catch(error){control.invalidate();throw error;}
}
/** Original live-source quiescence only; it is not process absence or activation. */
export interface ProviderSourceQuiescenceLease {
 readonly grantId:string;readonly projectId:string;readonly seal:Readonly<Row>;
 assertCurrent():void;verifyCurrent():Promise<void>;close():void;
}
const sourceQuiescences=new WeakMap<object,{check():void;container:ProviderSourceContainerLease;source:ProviderSourceTransferLease;parent:SourceGrantLeaseContext;expected:string;input:string;seal:Readonly<Row>}>();
const ownedSourceQuiescences=new WeakMap<ProviderSourceControlChannel,{input:string;lease:ProviderSourceQuiescenceLease}>();
export function assertProviderSourceQuiescenceLease(value:object):void{const held=sourceQuiescences.get(value);if(!held)fail("A genuine original source quiescence lease is required.");held.check();}
/** Requires a genuine current base receipt or an already acknowledged current tail receipt. */
export async function quiesceProviderSourceForTarget(value:object):Promise<ProviderSourceQuiescenceLease>{
 const target=await import("./provider-target-stage.ts"),original=target.providerTargetTransferReceiptContext(value as import("./provider-target-stage.ts").ProviderTargetTransferReceipt),source=providerSourceTransferContext(original.source),control=bridgeControlChannels.get(source.bridge)?.get(original.source.grantId);
 if(!control?.quiesceTarget)fail("Original source quiescence control is unavailable.");control.check();return control.quiesceTarget(value);
}
async function commitProviderSourceQuiescence(channel:ProviderSourceControlChannel,container:ProviderSourceContainerLease,sourceLease:ProviderSourceTransferLease,receipt:string,targetCurrent:()=>void):Promise<ProviderSourceQuiescenceLease>{
 const control=sourceControlChannels.get(channel),retained=sourceContainerLeases.get(container),source=providerSourceTransferContext(sourceLease);
 if(!control||!retained||sourceControlChannelFor(retained.scope)!==control||!control.acceptCatalog||!control.sendOperation)fail("Original source quiescence requires its coupled control.");
 const parent=retained.scope.parent,c=parent.context,input=JSON.stringify({protocol:"clank-provider-source-stop-intent/1",targetReceipt:receipt}),inputHash=c.hash(input),step="stop_"+inputHash;
 const deadline=((globalThis as any).process.hrtime.bigint() as bigint)+BigInt(source.limits.controlTimeoutMs)*1000000n;
 const current=()=>{if((globalThis as any).process.hrtime.bigint()>=deadline)fail("Original source quiescence deadline expired.");control.check();retained.check();source.check();targetCurrent();};current();
 const cached=ownedSourceQuiescences.get(channel);if(cached){if(cached.input!==input)fail("Original source quiescence cannot change its stop input.");await cached.lease.verifyCurrent();current();return cached.lease;}
 const capture=()=>withBridge(parent.bridge,true,(_c,_root,state,registered)=>{current();const frame=containerFrame(parent.bridge,registered),before=state.states.find(row=>row.projectId===parent.input.projectId);if(!before?.grant||before.grant.state!=="ready"||!before.transfer)fail("Original source stop has no live enrolled grant.");return {frame,before};});
 const records=(v:Row)=>({grant:v.grant,transfer:v.transfer,operations:v.operations,spools:v.spools});
 const publish=async(captured:Awaited<ReturnType<typeof capture>>,after:Row,seal:string|null)=>{
  current();const before=captured.before,beforeHash=c.hash(boundedJSON(records(before),BRIDGE_CATALOG_MAX)),afterHash=c.hash(boundedJSON(records(after),BRIDGE_CATALOG_MAX)),proposal=JSON.stringify({protocol:"clank-source-stop-prepare/1",before:{version:before.version,recordsSha256:beforeHash},after:{version:after.version,recordsSha256:afterHash},phase:after.transfer.phase,input:seal===null?input:null,stopInputSha256:inputHash,sealSha256:seal===null?null:c.hash(seal)});
  sourceEnrollment(c,after.grant,after.transfer,after.operations);
  const prepared=await control.sendOperation!(proposal,true);current();if(prepared!==JSON.stringify({protocol:"clank-source-stop-prepared/1",proposalSha256:c.hash(proposal)}))fail("Original source stop preparation differs.");
  await withBridge(parent.bridge,true,(context,root,state,registered)=>{
   current();const frame=containerFrame(parent.bridge,registered),project=state.projects.find(row=>row.project_id===parent.input.projectId);
   if(!project||JSON.stringify({root:frame.root,state:frame.state,index:frame.indexRows})!==JSON.stringify({root:captured.frame.root,state:captured.frame.state,index:captured.frame.indexRows}))fail("Original source stop preimage changed.");
   const beforeJSON=JSON.stringify({state:frame.state,index:frame.indexRows}),post={...frame.state,states:frame.state.states.map(row=>row.projectId===parent.input.projectId?after:row)},afterJSON=JSON.stringify({state:post,index:frame.indexRows}),from=context.pins.length;
   try{const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
    databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
     const actual=bridgeCatalog(context,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...actual})!==JSON.stringify(before)||metadata.records_sha256!==beforeHash)fail("Original source stop catalog preimage differs.");
     const operation=after.operations.at(-1),previous=before.operations.find((row:Row)=>row.step_id===step);
     const changed=previous?db.prepare("UPDATE clank_provider_handoff_source_operations SET state='complete',result_json=?,result_sha256=? WHERE sequence=? AND step_id=? AND input_json=? AND input_sha256=? AND state='accepted' AND result_json IS NULL AND result_sha256 IS NULL").run(operation.result_json,operation.result_sha256,previous.sequence,step,input,inputHash).changes:db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(?,?,?,?,?,'accepted',NULL,NULL)").run(operation.sequence,step,"fence",input,inputHash).changes;
     if(changed!==1||db.prepare("UPDATE clank_provider_handoff_source_transfer SET phase=?,stop_input_sha256=?,quiescence_json=?,seal_json=? WHERE id=1 AND protocol=2 AND enrollment_json=? AND phase=? AND stop_input_sha256 IS ? AND quiescence_json IS ? AND seal_json IS ? AND stop_receipt_json IS NULL").run(after.transfer.phase,inputHash,after.transfer.quiescence_json,after.transfer.seal_json,before.transfer.enrollment_json,before.transfer.phase,before.transfer.stop_input_sha256,before.transfer.quiescence_json,before.transfer.seal_json).changes!==1||boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(after),BRIDGE_CATALOG_MAX)||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,registered.enablementId,before.version,beforeHash).changes!==1)fail("Original source stop intent, decision or mirror was not retained.");
     commitBridgeFile(context,registered.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(after))fail("Original source stop durable readback differs.");});
    }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    parent.acceptState(beforeJSON,afterJSON);control.acceptCatalog!(JSON.stringify(before),JSON.stringify(after));ownerSourceServices.get(registered.owner)?.acceptCatalog(parent.input.grantId,JSON.stringify(before),JSON.stringify(after));acceptSourceTransferCatalog(registered.owner,JSON.stringify(before),JSON.stringify(after));current();
   }finally{releasePins(context,from);}
  });current();
  const observed=await control.sendOperation!(JSON.stringify({protocol:"clank-source-catalog-observe/1",version:after.version,recordsSha256:afterHash}),true);current();if(observed!==JSON.stringify({protocol:"clank-source-catalog-observed/1",version:after.version,recordsSha256:afterHash}))fail("Original source stop observation differs.");await container.verifyCurrent();current();
 };
 try{
  let captured=await capture();current();let before=captured.before;const binding=JSON.parse(before.transfer.enrollment_json).binding;sourceStopInput(c,input,before.grant,binding);
  if(before.transfer.phase==="enrolled"){
   if(before.spools.some((row:Row)=>row.kind==="tail")||!sourceStopFollowsTarget(receipt,before.operations)||before.operations.length>=captured.frame.root.bridge.limits.maxOperations)fail("Original source stop must follow its acknowledged target and available operation slot.");
   const operation={sequence:before.operations.length+1,step_id:step,kind:"fence",input_json:input,input_sha256:inputHash,state:"accepted",result_json:null,result_sha256:null},after={...before,version:before.version+1,transfer:{...before.transfer,phase:"barrier",stop_input_sha256:inputHash},operations:[...before.operations,operation]};await publish(captured,after,null);captured=await capture();current();before=captured.before;
  }
  if(before.transfer.stop_input_sha256!==inputHash||before.operations.at(-1)?.input_json!==input)fail("Original source stop cannot adopt another native intent.");
  if(before.transfer.phase==="barrier"){
   const seal=await control.sendOperation!(JSON.stringify({protocol:"clank-source-recovery-operation/1",operation:"seal",after:JSON.parse(receipt).cursor}));current();const result=sourceQuiescence(c,input,seal,before.grant,binding),key=await resolveProviderSourceCaptureKey(parent.bridge,parent.input.projectId,parent.input.grantId);
   try{const crypto=await import("node:crypto"),{authentication,...content}=JSON.parse(seal);current();if(authentication!==crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex"))fail("Original source quiescence seal authentication differs.");}finally{key.fill(0);}
   captured=await capture();current();before=captured.before;const operation={...before.operations.at(-1),state:"complete",result_json:result,result_sha256:c.hash(result)},after={...before,version:before.version+1,transfer:{...before.transfer,phase:"sealed-tail-retained",quiescence_json:result,seal_json:seal},operations:[...before.operations.slice(0,-1),operation]};await publish(captured,after,seal);captured=await capture();current();before=captured.before;
  }
  if(before.transfer.phase!=="sealed-tail-retained")fail("Original source quiescence is unsettled.");
  let closed=false;const expected=JSON.stringify(before),seal=freezeValue(JSON.parse(before.transfer.seal_json));
  const check=()=>{if(closed)fail("Original source quiescence is closed or fenced.");try{control.check();retained.check();source.check();const frame=containerFrame(parent.bridge,parent.registered),actual=frame.state.states.find(row=>row.projectId===parent.input.projectId);if(JSON.stringify(actual)!==expected)fail("Original source quiescence catalog changed.");}catch(error){closed=true;throw error;}};
  let verifying:Promise<void>|undefined;
  const verify=()=>{check();if(verifying)fail("Original source quiescence verification is already owned.");return verifying=(async()=>{try{await container.verifyCurrent();check();await source.verify();check();const actual=await control.sendOperation!(JSON.stringify({protocol:"clank-source-recovery-operation/1",operation:"seal",after:seal.after}));check();if(actual!==before.transfer.seal_json)fail("Original source quiescence native seal differs.");check();}catch(error){closed=true;control.invalidate();throw error;}finally{verifying=undefined;}})();};
  const lease:ProviderSourceQuiescenceLease=Object.freeze({grantId:parent.input.grantId,projectId:parent.input.projectId,seal,assertCurrent:check,verifyCurrent:verify,close(){closed=true;}});sourceQuiescences.set(lease,{check,container,source:sourceLease,parent,expected,input,seal});ownedSourceQuiescences.set(channel,{input,lease});check();return lease;
 }catch(error){control.invalidate();throw error;}
}

/** Native source absence bound to its original daemon, data and durable seal. */
export interface ProviderSourceStopLease {
 readonly grantId:string;readonly projectId:string;readonly receipt:Readonly<Row>;
 assertCurrent():void;verifyStopped():Promise<void>;close():void;
}
export interface ProviderSourceTerminalTail {readonly sourceSpoolSha256:string;readonly after:Readonly<Row>;readonly cursor:Readonly<Row>}
const sourceStops=new WeakMap<object,{check():void;publish():Promise<ProviderSourceTerminalTail|null>;source:ProviderSourceTransferLease;receipt:Readonly<Row>;seal:Readonly<Row>;input:string;verify():Promise<void>;recovery():Row}>();
const ownerSourceStops=new WeakMap<ProviderServiceOwnership,Set<()=>void>>();
const sourceStopFlights=new WeakMap<object,{launch:object;flight:Promise<ProviderSourceStopLease>}>();
function closeSourceStops(owner:ProviderServiceOwnership):void{for(const close of [...(ownerSourceStops.get(owner)??[])])close();}
export function assertProviderSourceStopLease(value:object):void{const held=sourceStops.get(value);if(!held)fail("A genuine original native source stop lease is required.");held.check();}
/** Private activation input from the original native stop, never caller fields. */
export function providerSourceStopActivationContext(value:object){
 const held=sourceStops.get(value);if(!held)fail("A genuine original native source stop lease is required.");held.check();
 return Object.freeze({source:held.source,receipt:held.receipt,seal:held.seal,input:held.input,check:held.check,verify:held.verify});
}
export function providerSourceStopRecoveryContext(value:object):Readonly<Row>{const held=sourceStops.get(value);if(!held)fail("A genuine original native source stop lease is required.");held.check();return freezeValue(held.recovery());}
/** Publish only the sealed final prefix held by the original native stop. */
export async function publishProviderSourceTerminalTail(value:object):Promise<ProviderSourceTerminalTail|null>{
 const held=sourceStops.get(value);if(!held)fail("A genuine original native source stop lease is required.");held.check();return held.publish();
}
/** Only the original launcher and original quiescence can stop this writer. */
export async function stopQuiescentProviderSource(value:object,launchValue:object):Promise<ProviderSourceStopLease>{
 const q=sourceQuiescences.get(value);if(!q)fail("A genuine original source quiescence lease is required.");
 const launcher=await import("./provider-source-launch.ts"),launch=launcher.providerSourceLaunchStopContext(launchValue);
 if(launch.container!==q.container)fail("Native source stop requires the matching original launch.");
 const previous=sourceStopFlights.get(value);if(previous){if(previous.launch!==launchValue)fail("Native source stop cannot change its original launch.");const lease=await previous.flight;await lease.verifyStopped();return lease;}
 q.check();launch.check();const flight=produceProviderSourceStop(q,value as ProviderSourceQuiescenceLease,launch);sourceStopFlights.set(value,{launch:launchValue,flight});return flight;
}
async function produceProviderSourceStop(q:NonNullable<ReturnType<typeof sourceQuiescences.get>>,quiescence:ProviderSourceQuiescenceLease,launch:ReturnType<typeof import("./provider-source-launch.ts").providerSourceLaunchStopContext>):Promise<ProviderSourceStopLease>{
 const parent=q.parent,c=parent.context,source=providerSourceTransferContext(q.source),registered=bridgeCurrent(source.bridge,true),client=domains.get(registered.domain)!.client,before=JSON.parse(q.expected),data=sourceContainerLeases.get(q.container)!.data,grant=JSON.parse(before.grant.binding_json),pins:Pin[]=[];
 const rootJSON=JSON.stringify(marker(c)),indexJSON=JSON.stringify(containerFrame(source.bridge,registered).indexRows),metadata=new Map<Pin,string>(),immutable=new Map<Pin,string>();let expected=q.expected,closed=false,published=false,key:Uint8Array|undefined,sealedImage:string|undefined;
 const close=()=>{if(closed)return;closed=true;ownerSourceStops.get(registered.owner)?.delete(close);const errors:unknown[]=[];for(const pin of pins.splice(0).reverse())try{c.fs.closeSync(pin.fd);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"Original source stop data pins failed to close.");};
 const fileStamp=(p:Pin)=>{assertPin(c,p);const a=c.fs.fstatSync(p.fd,{bigint:true}),b=c.fs.lstatSync(p.path,{bigint:true}),keys=["dev","ino","size","mode","uid","gid","nlink","mtimeNs","ctimeNs"];if(keys.some(k=>a[k]!==b[k]))fail("Original stopped source terminal spool identity differs.");return keys.map(k=>String(a[k])).join(":");};
 // Once the original writer is natively absent, retain the exact image that
 // passed authenticated SQLite/base-file inspection. Every reuse checks native
 // identities, nanosecond change times and directory membership; changed bytes
 // (including changed-and-restored bytes) permanently fence this stop lease.
 const sealImage=()=>{
  const rows:unknown[]=[];let entries=0;
  const observe=(path:string,relative:string,depth:number)=>{
   if(++entries>32768||depth>8)fail("Stopped source evidence inventory exceeds its bound.");
   const stat=c.fs.lstatSync(path,{bigint:true});
   if(stat.isSymbolicLink()||stat.uid!==BigInt((globalThis as any).process.getuid())||(stat.mode&0o022n)!==0n||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1n||stat.size>BigInt(512*1024*1024+36))))fail("Stopped source evidence is not privately owned native data.");
   rows.push([relative,...["dev","ino","size","mode","uid","gid","nlink","mtimeNs","ctimeNs"].map(k=>String(stat[k]))]);
   if(stat.isDirectory())for(const name of c.fs.readdirSync(path).sort()){if(typeof name!=="string"||name.length>255||name==="."||name===".."||name.includes("/"))fail("Stopped source evidence name differs.");observe(path+"/"+name,relative+"/"+name,depth+1);}
  };
  assertPin(c,databasePin);assertPin(c,repository);observe(databasePin.path,"database",0);
  for(const suffix of ["-wal","-journal"]){const path=databasePin.path+suffix;if(absent(c,path))rows.push([suffix,null]);else observe(path,suffix,0);}
  observe(repository.anchor+"/.","repository",0);return boundedJSON(rows,4*1024*1024);
 };
 const guard=()=>{if(closed)fail("Original native source stop is closed or fenced.");try{const actual=bridgeCurrent(source.bridge,true);if(actual.owner!==registered.owner||actual.domain!==registered.domain)fail("Original source stop owner changed.");source.check();for(const p of pins)assertPin(c,p);if(sealedImage!==undefined&&sealImage()!==sealedImage)fail("Original stopped source sealed evidence changed.");for(const [p,stamp]of immutable)if(fileStamp(p)!==stamp)fail("Original stopped source terminal spool changed.");for(const [p,body]of metadata)if(sourceMetadata(c,p)!==body)fail("Original stopped source generation or fence metadata changed.");const frame=containerFrame(source.bridge,registered);if(JSON.stringify(frame.root)!==rootJSON||JSON.stringify(frame.indexRows)!==indexJSON||JSON.stringify(frame.state.states.find(row=>row.projectId===before.projectId))!==expected)fail("Original source stop native catalog changed.");}catch(error){close();throw error;}};
 const operation=()=>{const deadline=((globalThis as any).process.hrtime.bigint() as bigint)+BigInt(source.limits.controlTimeoutMs)*1000000n;const current=()=>{guard();if((globalThis as any).process.hrtime.bigint()>=deadline)fail("Original source stop operation deadline expired.");};return {current,remaining:()=>Math.max(1,Number((deadline-((globalThis as any).process.hrtime.bigint() as bigint))/1000000n)),command:(args:string[])=>{current();return runProviderDockerClient(client,args,{timeoutMs:Math.max(1,Math.min(15000,Number((deadline-((globalThis as any).process.hrtime.bigint() as bigint))/1000000n))),maxOutputBytes:4194304});}};};
 let cgroup:string|undefined,dataPin:Pin,databasePin:Pin,releasePin:Pin,repository:Pin;
 const absence=()=>{
  const processPath="/proc/"+q.container.pid+"/stat";
  if(!absent(c,processPath)){const text=sourceProcText(c,processPath),fields=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u);if(fields[19]===q.container.birth)fail("Original source process still exists.");}
  if(cgroup&&!absent(c,cgroup+"/cgroup.procs")&&sourceProcText(c,cgroup+"/cgroup.procs",4096).trim())fail("Original source cgroup still contains processes.");
 };
 const inventory=async(run:ReturnType<typeof operation>,allowed?:string)=>{
  run.current();const text=(await run.command(["container","ls","--all","--no-trunc","--format","{{.ID}}"])).stdout.trim(),ids=text?text.split("\n"):[];if(ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!match(id,DIGEST)))fail("Source writer inventory exceeds its bounded observation.");
  for(const id of ids){run.current();const row=JSON.parse((await run.command(["container","inspect","--format","[{{json .Id}},{{json .Config.Labels}},{{json .Mounts}}]",id])).stdout);run.current();if(!Array.isArray(row)||row.length!==3||row[0]!==id||row[1]!==null&&(typeof row[1]!=="object"||Array.isArray(row[1]))||!Array.isArray(row[2])||row[2].length>256)fail("Source writer native observation differs.");
   if(id===allowed)continue;const labels=row[1]??{};
   if(id===launch.containerId||labels["run.clank.owner"]===registered.domain.owner&&labels["run.clank.project"]===before.projectId)fail("Source project has an additional or remaining writer role.");
   for(const mount of row[2]){if(mount.RW!==true)continue;if(typeof mount.Source!=="string"||!c.path.isAbsolute(mount.Source))fail("Source competing mount cannot be verified.");
    const real=c.fs.realpathSync(mount.Source),stat=c.fs.statSync(real);if([dataPin,releasePin,repository,databasePin].some(pin=>real===pin.path||real.startsWith(pin.path+"/")||pin.path.startsWith(real+"/")||stat.dev===pin.dev&&stat.ino===pin.ino))fail("Source data or release has a competing writable container mount.");}
  }run.current();if(!allowed)absence();
 };
 const inspectSeal=async(run:ReturnType<typeof operation>)=>{run.current();const module=await import("./point-in-time.ts");run.current();if(!key)key=await resolveProviderSourceCaptureKey(source.bridge,before.projectId,before.grant.grant_id);run.current();absence();if(sealedImage!==undefined)return q.seal;const image=sealImage();const seal=await module.inspectPointInTimeTransferSourceSeal({identity:source.binding.identity,baseOperationId:source.binding.baseOperationId,baseArchiveSha256:source.binding.baseArchiveSha256,initialCursor:source.binding.initialCursor,sourcePath:data.databasePath,encryptionKey:key,after:q.seal.after,assertCurrent:()=>{run.current();absence();},maxDatabaseBytes:512*1024*1024,maxStateBytes:source.limits.maxCaptureStateBytes,maxDurationMs:Math.min(30000,run.remaining())});run.current();if(JSON.stringify(seal)!==before.transfer.seal_json)fail("Stopped source native seal differs from its original decision.");const afterImage=sealImage();if(afterImage!==image){
 // SQLite may create its empty WAL on the first read-only open. It contains
 // no pages and cannot change the authenticated main database. Bind that new
 // native file for all subsequent checks; no existing WAL may change.
 const initial=JSON.parse(image),observed=JSON.parse(afterImage),wal=observed.find((row:unknown[])=>row[0]==="-wal");
 if(!wal||wal[3]!=="0"||!initial.some((row:unknown[])=>row[0]==="-wal"&&row[1]===null)||JSON.stringify(initial.filter((row:unknown[])=>row[0]!=="-wal"))!==JSON.stringify(observed.filter((row:unknown[])=>row[0]!=="-wal")))fail("Stopped source evidence changed during authenticated inspection.");
 }sealedImage=afterImage;run.current();return seal;};
 try{
  q.check();if(before.operations.length>=source.limits.maxOperations)fail("Source stop receipt operation capacity is exhausted.");await quiescence.verifyCurrent();q.check();launch.check();
  const from=c.pins.length;try{dataPin=pin(c,data.dataDirectory,true);databasePin=pin(c,data.databasePath,false,512*1024*1024);releasePin=pin(c,data.releaseDirectory,true);repository=pin(c,c.path.join(c.path.dirname(data.databasePath),".clank-source-recovery-"+grant.sourceIncarnation),true);for(const name of ["state.json","fence.json"]){const retained=pin(c,c.path.join(c.root.path,"projects",before.projectId,name),false,65536);metadata.set(retained,sourceMetadata(c,retained));}pins.push(...c.pins.splice(from));}catch(error){releasePins(c,from);throw error;}
  const rows=sourceProcText(c,"/proc/"+q.container.pid+"/cgroup").trim().split("\n");if(rows.length!==1||!rows[0].startsWith("0::/"))fail("Original source cgroup cannot be retained.");cgroup="/sys/fs/cgroup"+rows[0].slice(3);
  const run=operation();await verifyDomain(registered.owner,registered.domain,true);run.current();await inventory(run,launch.containerId);run.current();q.check();launch.check();
  await run.command(["container","stop","--time","10",launch.containerId]);run.current();await launch.close();run.current();await inventory(run);await inspectSeal(run);await verifyDomain(registered.owner,registered.domain,true);run.current();
  const receipt={protocol:"clank-provider-source-stop/1",grantId:before.grant.grant_id,bindingSha256:before.grant.binding_sha256,sourceIncarnation:grant.sourceIncarnation,containerId:launch.containerId,pid:q.container.pid,birth:q.container.birth,domain:registered.domain,stopInputSha256:before.transfer.stop_input_sha256,sealSha256:c.hash(before.transfer.seal_json),identity:source.binding.identity,cursor:q.seal.through,database:{dev:databasePin.dev,ino:databasePin.ino},dataDirectory:{dev:dataPin.dev,ino:dataPin.ino},roles:["web"]},encoded=JSON.stringify(receipt),hash=c.hash(encoded),result=JSON.stringify({protocol:"clank-provider-source-stopped/1",receiptSha256:hash,cursor:q.seal.through}),row={sequence:before.operations.length+1,step_id:"stopped_"+before.transfer.stop_input_sha256,kind:"stop",input_json:encoded,input_sha256:hash,state:"complete",result_json:result,result_sha256:c.hash(result)},after:Row={...before,version:before.version+1,grant:{...before.grant,state:"stopped"},transfer:{...before.transfer,phase:"stopped",stop_receipt_json:encoded},operations:[...before.operations,row]};
  if(before.operations.length>=source.limits.maxOperations)fail("Source stop receipt operation capacity is exhausted.");sourceEnrollment(c,after.grant,after.transfer,after.operations);
  await withBridge(source.bridge,true,(context,root,state,owner)=>{run.current();absence();const frame=containerFrame(source.bridge,owner),project=state.projects.find(p=>p.project_id===before.projectId),actual=state.states.find(p=>p.projectId===before.projectId);if(!project||JSON.stringify(actual)!==expected)fail("Native source stop preimage changed.");const records=(v:Row)=>({grant:v.grant,transfer:v.transfer,operations:v.operations,spools:v.spools}),beforeHash=context.hash(boundedJSON(records(before),BRIDGE_CATALOG_MAX)),afterHash=context.hash(boundedJSON(records(after),BRIDGE_CATALOG_MAX)),from=context.pins.length;
   try{const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
    databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
     if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(before))fail("Native source stop catalog preimage differs.");
     if(db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(?,?,?,?,?,'complete',?,?)").run(row.sequence,row.step_id,row.kind,encoded,hash,result,row.result_sha256).changes!==1||db.prepare("UPDATE clank_provider_handoff_source_grant SET state='stopped' WHERE id=1 AND grant_id=? AND binding_json=? AND state='ready' AND container_id=? AND readiness_json=?").run(before.grant.grant_id,before.grant.binding_json,launch.containerId,before.grant.readiness_json).changes!==1||db.prepare("UPDATE clank_provider_handoff_source_transfer SET phase='stopped',stop_receipt_json=? WHERE id=1 AND phase='sealed-tail-retained' AND stop_input_sha256=? AND seal_json=? AND quiescence_json=? AND stop_receipt_json IS NULL").run(encoded,before.transfer.stop_input_sha256,before.transfer.seal_json,before.transfer.quiescence_json).changes!==1||boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(after),BRIDGE_CATALOG_MAX)||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,owner.enablementId,before.version,beforeHash).changes!==1)fail("Native source stop decision or mirror was not retained.");
     commitBridgeFile(context,owner.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(after))fail("Native source stop durable readback differs.");});
    }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
    ownerSourceServices.get(owner.owner)?.acceptCatalog(before.grant.grant_id,JSON.stringify(before),JSON.stringify(after));acceptSourceTransferCatalog(owner.owner,JSON.stringify(before),JSON.stringify(after));expected=JSON.stringify(after);run.current();
   }finally{releasePins(context,from);}
  });run.current();await inventory(run);await inspectSeal(run);run.current();
  const check=()=>{guard();absence();};let verifying:Promise<void>|undefined,publishing=false;
  const verify=()=>{check();if(publishing||verifying)fail("Original source stop verification or terminal publication is already owned.");return verifying=(async()=>{try{const run=operation();await verifyDomain(registered.owner,registered.domain,true);run.current();await inventory(run);await inspectSeal(run);await verifyDomain(registered.owner,registered.domain,true);run.current();}catch(error){close();throw error;}finally{key?.fill(0);key=undefined;verifying=undefined;}})();};
  let terminalFlight:Promise<ProviderSourceTerminalTail|null>|undefined;
  const publish=async():Promise<ProviderSourceTerminalTail|null>=>{
   check();if(verifying)fail("Original source stop verification is already owned.");
   if(terminalFlight){const result=await terminalFlight;await verify();return result;}
   publishing=true;terminalFlight=(async()=>{try{
    const run=operation();await verifyDomain(registered.owner,registered.domain,true);run.current();await inventory(run);await inspectSeal(run);run.current();
    // A caught-up receiver requires no fabricated empty journal batch.
    if(JSON.stringify(q.seal.after)===JSON.stringify(q.seal.through)){await inventory(run);return null;}
    const initial=JSON.parse(expected);if(initial.grant.state!=="stopped"||initial.transfer.phase!=="stopped"||initial.transfer.stop_receipt_json!==encoded||initial.spools.some((v:Row)=>v.kind==="tail"))fail("Original stopped source has no vacant terminal spool slot.");
    const frame=containerFrame(source.bridge,registered),reservation=frame.state.reservations.find(v=>v.catalog_id===initial.catalogId&&v.kind==="tail"),slotInput=c.hash(JSON.stringify({protocol:"clank-provider-source-spool-slot/1",grantId:before.grant.grant_id,bindingSha256:before.grant.binding_sha256,sourceIncarnation:grant.sourceIncarnation,kind:"tail"}));
    if(!reservation||reservation.input_sha256!==slotInput)fail("Original stopped source terminal tail has no reserved quota.");
    const module=await import("./point-in-time.ts");run.current();const batch=await module.exportSealedPointInTimeTransfer({identity:source.binding.identity,baseOperationId:source.binding.baseOperationId,baseArchiveSha256:source.binding.baseArchiveSha256,initialCursor:source.binding.initialCursor,sourcePath:data.databasePath,encryptionKey:key!,after:q.seal.after,expectedCursor:q.seal.after,throughSequence:q.seal.through.sequence,maxBatchBytes:Math.min(source.limits.maxBatchBytes,reservation.maximum_bytes),maxEntries:source.limits.maxBatchEntries,maxDatabaseBytes:512*1024*1024,maxStateBytes:source.limits.maxCaptureStateBytes,maxDurationMs:Math.min(30000,run.remaining()),assertCurrent:()=>{run.current();absence();}});run.current();
    const body=JSON.stringify(batch),bytes=Buffer.byteLength(body),hash=c.hash(body),input=JSON.stringify({protocol:"clank-source-recovery-operation/1",operation:"batch",after:q.seal.after,throughSequence:q.seal.through.sequence});
    if(bytes>reservation.maximum_bytes||JSON.stringify(batch.after)!==JSON.stringify(q.seal.after)||JSON.stringify(batch.through)!==JSON.stringify(q.seal.through))fail("Original stopped source final prefix or byte bound differs.");
    const output={protocol:"clank-source-recovery-output/1",sourceIncarnation:grant.sourceIncarnation,kind:"tail",inputSha256:c.hash(input),resultSha256:hash,bytes},manifestJSON=JSON.stringify({protocol:"clank-provider-source-spool-file/2",reservationId:reservation.reservation_id,grantId:before.grant.grant_id,bindingSha256:before.grant.binding_sha256,containerId:launch.containerId,input,output}),row={kind:"tail",reservation_id:reservation.reservation_id,state:"ready",manifest_json:manifestJSON,manifest_sha256:c.hash(manifestJSON)};
    sourceSpools(c,initial.grant,[row],frame.state.reservations);
    const from=c.pins.length;let spool:Pin;
    try{spool=directory(c,c.service,".clank-source-spool-"+grant.sourceIncarnation);pins.push(...c.pins.splice(from));}catch(error){releasePins(c,from);throw error;}
    const temporary="tail.json.tmp-"+globalThis.crypto.randomUUID(),fd=c.fs.openSync(spool.anchor+"/"+temporary,c.fs.constants.O_WRONLY|c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_NOFOLLOW,0o600);
    try{c.fs.writeFileSync(fd,body);c.fs.fsyncSync(fd);}finally{c.fs.closeSync(fd);}
    run.current();c.fs.linkSync(spool.anchor+"/"+temporary,spool.anchor+"/tail.json");c.fs.unlinkSync(spool.anchor+"/"+temporary);c.fs.fsyncSync(spool.fd);
    const manifestFd=c.fs.openSync(spool.anchor+"/tail.manifest.json",c.fs.constants.O_WRONLY|c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_NOFOLLOW,0o600);
    try{c.fs.writeFileSync(manifestFd,manifestJSON);c.fs.fsyncSync(manifestFd);}finally{c.fs.closeSync(manifestFd);}c.fs.fsyncSync(spool.fd);
    const pinFrom=c.pins.length;try{const file=pin(c,spool.path+"/tail.json",false,reservation.maximum_bytes),manifest=pin(c,spool.path+"/tail.manifest.json",false,8192);immutable.set(file,fileStamp(file));immutable.set(manifest,fileStamp(manifest));metadata.set(manifest,manifestJSON);pins.push(...c.pins.splice(pinFrom));const readback=Buffer.alloc(bytes);if(c.fs.readSync(file.fd,readback,0,bytes,0)!==bytes||c.hash(readback as any)!==hash)fail("Original stopped source terminal spool readback differs.");}catch(error){releasePins(c,pinFrom);throw error;}
    run.current();await inventory(run);await inspectSeal(run);run.current();const next={...initial,version:initial.version+1,spools:[...initial.spools,row].sort((a:Row,b:Row)=>a.kind<b.kind?-1:1)},records=(v:Row)=>({grant:v.grant,transfer:v.transfer,operations:v.operations,spools:v.spools}),beforeHash=c.hash(boundedJSON(records(initial),BRIDGE_CATALOG_MAX)),afterHash=c.hash(boundedJSON(records(next),BRIDGE_CATALOG_MAX));
    await withBridge(source.bridge,true,(context,root,state,owner)=>{run.current();absence();const project=state.projects.find(p=>p.project_id===before.projectId),current=state.states.find(p=>p.projectId===before.projectId);if(!project||JSON.stringify(current)!==expected)fail("Stopped terminal spool native preimage changed.");const from=context.pins.length;
     try{const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
      databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
       const actual=bridgeCatalog(context,db,root,project,state.reservations),mirror=singleton(db,"clank_provider_handoff_bridge_state");if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...actual})!==expected||mirror.records_sha256!==beforeHash)fail("Stopped terminal spool catalog preimage differs.");
       if(db.prepare("INSERT INTO clank_provider_handoff_source_spools VALUES(?,?,?,?,?)").run(row.kind,row.reservation_id,row.state,row.manifest_json,row.manifest_sha256).changes!==1||boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(next),BRIDGE_CATALOG_MAX)||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,owner.enablementId,initial.version,beforeHash).changes!==1)fail("Stopped terminal spool catalog or mirror differs.");
       commitBridgeFile(context,owner.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(next))fail("Stopped terminal spool durable readback differs.");});
      }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
      ownerSourceServices.get(owner.owner)?.acceptCatalog(before.grant.grant_id,JSON.stringify(initial),JSON.stringify(next));acceptSourceTransferCatalog(owner.owner,JSON.stringify(initial),JSON.stringify(next));expected=JSON.stringify(next);run.current();
     }finally{releasePins(context,from);}
    });run.current();if(await readProviderSourceSpool(source.bridge,before.projectId,"tail")!==body)fail("Stopped terminal spool published readback differs.");run.current();await inventory(run);await inspectSeal(run);run.current();return freezeValue({sourceSpoolSha256:hash,after:q.seal.after,cursor:q.seal.through});
   }catch(error){close();throw error;}finally{key?.fill(0);key=undefined;publishing=false;}})();return terminalFlight;
  };
  const lease:ProviderSourceStopLease=Object.freeze({grantId:before.grant.grant_id,projectId:before.projectId,receipt:freezeValue(receipt),assertCurrent:check,verifyStopped:verify,close});sourceStops.set(lease,{check,publish,source:q.source,receipt:lease.receipt,seal:q.seal,input:q.input,verify,recovery(){check();return {root:JSON.parse(rootJSON),rootIdentity:recoveryPin(c.root),serviceIdentity:recoveryPin(c.service),catalog:JSON.parse(expected),index:JSON.parse(indexJSON),processes:[{pid:q.container.pid,birth:q.container.birth,cgroup}],paths:[dataPin,databasePin,releasePin,repository].map(recoveryPin)};}});const children=ownerSourceStops.get(registered.owner)??new Set<()=>void>();children.add(close);ownerSourceStops.set(registered.owner,children);published=true;check();return lease;
 }catch(error){close();throw error;}finally{key?.fill(0);key=undefined;if(!published&&!closed)close();}
}

/** Durable enrollment belongs only to the original coupled source control. */
async function commitProviderSourceEnrollment(channel:ProviderSourceControlChannel,container:ProviderSourceContainerLease,encoded:string):Promise<string>{
  const control=sourceControlChannels.get(channel),retained=sourceContainerLeases.get(container);
  if(!control||!retained||sourceControlChannelFor(retained.scope)!==control||!control.acceptCatalog||!control.sendOperation)fail("Original source enrollment requires its coupled control.");
  control.check();retained.check();
  const parent=retained.scope.parent;
  const input=JSON.parse(encoded);
  if(!exact(input,["protocol","operation","binding"])||input.protocol!=="clank-source-recovery-operation/1"||input.operation!=="enroll"||JSON.stringify(input)!==encoded)fail("Invalid original source enrollment input.");
  const enrollment=boundedJSON({protocol:"clank-provider-source-enrollment/1",grantId:parent.input.grantId,bindingSha256:parent.input.bindingSha256,containerId:parent.input.containerId,binding:input.binding},16384);
  const expectedResult=boundedJSON({protocol:"clank-source-enrolled/1",binding:input.binding},8192);
  const capture=async()=>withBridge(parent.bridge,true,(_c,_root,_state,registered)=>{control.check();retained.check();const frame=containerFrame(parent.bridge,registered),source=frame.state.states.find(row=>row.projectId===parent.input.projectId);if(!source||source.grant?.state!=="ready")fail("Original source enrollment is not ready.");return {frame,source};});
  const initial=await capture();control.check();retained.check();
  if(input.binding?.identity?.source?.nodeId!==parent.registered.domain.nodeId)fail("Original source enrollment node differs.");
  const acceptedOperation={sequence:1,step_id:input.binding?.identity?.handoffId,kind:"enroll",input_json:encoded,input_sha256:parent.context.hash(encoded),state:"accepted",result_json:null,result_sha256:null};
  const acceptedTransfer={id:1,protocol:2,handoff_id:input.binding?.identity?.handoffId,enrollment_json:enrollment,enrollment_sha256:parent.context.hash(enrollment),phase:"enrolling",stop_input_sha256:null,quiescence_json:null,seal_json:null,stop_receipt_json:null};
  // Validate complete semantics before proposing a frame or touching storage.
  sourceEnrollment(parent.context,initial.source.grant,acceptedTransfer,[acceptedOperation]);
  if(initial.source.transfer){
    if(initial.source.transfer.enrollment_json!==enrollment||initial.source.operations[0]?.input_json!==encoded)fail("Original source enrollment retry conflict.");
    if(initial.source.transfer.phase==="enrolled"){
      const result=await control.sendOperation(encoded);control.check();retained.check();
      if(result!==initial.source.operations[0].result_json||result!==expectedResult)fail("Original source enrollment replay differs.");return result;
    }
    if(initial.source.transfer.phase!=="enrolling")fail("Original source enrollment phase is unsupported.");
  }else if(initial.source.version!==5+initial.source.spools.length||initial.source.operations.length)fail("Original source enrollment preimage differs.");
  const transition=async(complete:boolean)=>{
    const captured=await capture(),before=captured.source,c=parent.context;
    if(complete?(before.version!==6+before.spools.length||before.transfer?.enrollment_json!==enrollment||before.transfer.phase!=="enrolling"):(before.version!==5+before.spools.length||before.transfer||before.operations.length))fail("Original source enrollment transition preimage differs.");
    const transfer=complete?{...before.transfer,phase:"enrolled"}:acceptedTransfer;
    const operation=complete?{...before.operations[0],state:"complete",result_json:expectedResult,result_sha256:c.hash(expectedResult)}:acceptedOperation;
    const after={...before,version:before.version+1,transfer,operations:[operation]},records=(value:Row)=>({grant:value.grant,transfer:value.transfer,operations:value.operations,spools:value.spools});
    const beforeHash=c.hash(boundedJSON(records(before),BRIDGE_CATALOG_MAX)),afterHash=c.hash(boundedJSON(records(after),BRIDGE_CATALOG_MAX));
    const proposal=boundedJSON({protocol:"clank-source-catalog-prepare/1",before:{version:before.version,recordsSha256:beforeHash},after:{version:after.version,recordsSha256:afterHash},enrollment,phase:transfer.phase},3072);
    const prepared=await control.sendOperation!(proposal,true);control.check();retained.check();
    if(prepared!==JSON.stringify({protocol:"clank-source-catalog-prepared/1",proposalSha256:c.hash(proposal)}))fail("Original source catalog preparation differs.");
    await withBridge(parent.bridge,true,(context,root,state,registered)=>{
      control.check();retained.check();const frame=containerFrame(parent.bridge,registered),actual=state.states.find(row=>row.projectId===parent.input.projectId),project=state.projects.find(row=>row.project_id===parent.input.projectId);
      const nativeFrame=(value:typeof frame)=>JSON.stringify({root:value.root,state:value.state,indexRows:value.indexRows});
      if(!project||nativeFrame(frame)!==nativeFrame(captured.frame)||JSON.stringify(actual)!==JSON.stringify(before))fail("Original source enrollment catalog changed after preparation.");
      const beforeJSON=JSON.stringify({state:frame.state,index:frame.indexRows}),post={...state,states:state.states.map(row=>row.projectId===parent.input.projectId?after:row)},afterJSON=JSON.stringify({state:post,index:frame.indexRows}),from=context.pins.length;
      try{
        const handoff=directory(context,context.service,"handoff"),catalogs=directory(context,handoff,"catalogs"),target=directory(context,catalogs,project.catalog_id);
        databaseAt(context,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{
          catalog(context,db,root,project);const old=bridgeCatalog(context,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
          if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...old})!==JSON.stringify(before)||metadata.records_sha256!==beforeHash)fail("Original source enrollment native preimage differs.");
          if(complete){
            if(db.prepare("UPDATE clank_provider_handoff_source_transfer SET phase='enrolled' WHERE id=1 AND protocol=2 AND enrollment_json=? AND enrollment_sha256=? AND phase='enrolling'").run(enrollment,c.hash(enrollment)).changes!==1
              ||db.prepare("UPDATE clank_provider_handoff_source_operations SET state='complete',result_json=?,result_sha256=? WHERE sequence=1 AND step_id=? AND kind='enroll' AND input_json=? AND input_sha256=? AND state='accepted' AND result_json IS NULL AND result_sha256 IS NULL").run(expectedResult,c.hash(expectedResult),operation.step_id,encoded,c.hash(encoded)).changes!==1)fail("Original source enrollment completion write differs.");
          }else{
            if(db.prepare("INSERT INTO clank_provider_handoff_source_transfer VALUES(1,2,?,?,?,'enrolling',NULL,NULL,NULL,NULL)").run(transfer.handoff_id,enrollment,c.hash(enrollment)).changes!==1
              ||db.prepare("INSERT INTO clank_provider_handoff_source_operations VALUES(1,?,'enroll',?,?,'accepted',NULL,NULL)").run(operation.step_id,encoded,c.hash(encoded)).changes!==1)fail("Original source enrollment intent write differs.");
          }
          if(boundedJSON(bridgeRecords(db),BRIDGE_CATALOG_MAX)!==boundedJSON(records(after),BRIDGE_CATALOG_MAX)||db.prepare(CONTAINER_MIRROR_CAS).run(afterHash,registered.enablementId,before.version,beforeHash).changes!==1)fail("Original source enrollment mirror write differs.");
          commitBridgeFile(context,registered.owner,db,file,target,()=>{catalog(context,db,root,project);if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...bridgeCatalog(context,db,root,project,state.reservations)})!==JSON.stringify(after))fail("Original source enrollment durable readback differs.");});
        }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
        // No await may expose a committed frame with stale original observers.
        parent.acceptState(beforeJSON,afterJSON);control.acceptCatalog!(JSON.stringify(before),JSON.stringify(after));ownerSourceServices.get(registered.owner)?.acceptCatalog(parent.input.grantId,JSON.stringify(before),JSON.stringify(after));acceptSourceTransferCatalog(registered.owner,JSON.stringify(before),JSON.stringify(after));control.check();retained.check();
      }finally{releasePins(context,from);}
    });control.check();retained.check();
    const observation=await control.sendOperation!(JSON.stringify({protocol:"clank-source-catalog-observe/1",version:after.version,recordsSha256:afterHash}),true);control.check();retained.check();
    if(observation!==JSON.stringify({protocol:"clank-source-catalog-observed/1",version:after.version,recordsSha256:afterHash}))fail("Original source catalog observation differs.");
    await container.verifyCurrent();control.check();retained.check();
  };
  try{
    if(!initial.source.transfer)await transition(false);
    const result=await control.sendOperation(encoded);control.check();retained.check();if(result!==expectedResult)fail("Original source native enrollment differs.");
    await transition(true);return result;
  }catch(error){control.invalidate();throw error;}
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
    if(!retry&&(source.version!==input.expectedVersion||!["issued","created","started","ready"].includes(grant.state)))fail("Provider handoff revocation transition conflicts.");
    const expected={...grant,state:"revoked"},version=input.expectedVersion+1;
    const wanted={version,grant:expected,transfer:source.transfer,operations:source.operations,spools:source.spools},post={...state,states:state.states.map(row=>row.projectId===input.projectId?{...row,...wanted}:row)},postJSON=JSON.stringify({state:post,index:indexRows}),from=c.pins.length;
    c.mode="cleanup-only";
    try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);
      databaseAt(c,target,"catalog.sqlite",BRIDGE_CATALOG_MAX,!retry,(db,file)=>{db.exec(retry?"BEGIN":"BEGIN IMMEDIATE");try{
        catalog(c,db,root,project);const before=bridgeCatalog(c,db,root,project,state.reservations),metadata=singleton(db,"clank_provider_handoff_bridge_state");
        if(JSON.stringify({projectId:project.project_id,catalogId:project.catalog_id,...before})!==JSON.stringify(source))fail("Provider handoff revocation preimage changed.");
        if(!retry){
          if(db.prepare(GRANT_REVOKE_CAS).run("revoked",input.containerId,grant.grant_id,grant.binding_json,grant.binding_sha256,grant.grant_secret_sha256,grant.control_secret_sha256,grant.state,grant.container_id,grant.readiness_json,grant.readiness_sha256).changes!==1||JSON.stringify(bridgeRecords(db).grant)!==JSON.stringify(expected))fail("Provider handoff revocation grant readback differs.");
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

/** The original committed coordinator capability is the sole publication path. */
export async function persistProviderTargetRestart(permit:import("./orchestration.ts").ProviderHandoffTargetRestartPermit):Promise<void>{
 const module=await import("./orchestration.ts"),held=module.providerHandoffTargetRestartContext(permit);
 held.begin();const workspace=targetWorkspaces.get(held.native.workspace);if(!workspace)fail("Original restart target workspace is unavailable.");
 const c=workspace.context,owner=workspace.owner;
 // Bridge ownership remains live until durable permission is fully read back.
 workspace.check();held.check();await held.native.verifyRemoved();workspace.check();held.check();
 const target=targetRestartOwner(c),root=marker(c);if(!root||target.index_id!==root.index_id||target.domain_sha256!==root.domain_sha256||target.target_id!==held.proof.targetId)fail("Original restart target owner differs.");
 const input=boundedJSON({protocol:"clank-provider-target-restart-record/1",indexId:root.index_id,domainSha256:root.domain_sha256,target,proof:held.proof},131072),expected={id:1,protocol:1,input_json:input,input_sha256:c.hash(input)};
 createDatabase(c,c.service,TARGET_RESTART_NAME,TARGET_RESTART_MAX,[TARGET_RESTART_SQL],db=>{
  workspace.check();held.check();if(db.prepare("INSERT INTO clank_provider_target_restart VALUES(1,1,?,?)").run(input,c.hash(input)).changes!==1||JSON.stringify(singleton(db,"clank_provider_target_restart"))!==JSON.stringify(expected))fail("Original target restart publication was not retained.");
 });
 if(JSON.stringify(targetRestartRecord(c))!==JSON.stringify(expected))fail("Original target restart commit readback differs.");
 await held.native.verifyRemoved();workspace.check();held.check();
 if(JSON.stringify(targetRestartRecord(c))!==JSON.stringify(expected))fail("Original target restart publication changed.");
}
function targetRestartOwner(c:Context):Row{return databaseAt(c,c.service,TARGET_OWNER_NAME,TARGET_OWNER_MAX,false,db=>{strictSchema(c,db,[TARGET_OWNER_SQL]);return singleton(db,"clank_provider_target_owner");});}
function targetRestartRecord(c:Context):Row{return databaseAt(c,c.service,TARGET_RESTART_NAME,TARGET_RESTART_MAX,false,db=>{strictSchema(c,db,[TARGET_RESTART_SQL]);const row=singleton(db,"clank_provider_target_restart");if(row.protocol!==1||typeof row.input_json!=="string"||c.hash(row.input_json)!==row.input_sha256)fail("Retained target restart record differs.");return row;});}
function restartProcText(c:Context,path:string):string{
 const fd=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_NOFOLLOW|c.fs.constants.O_NONBLOCK);try{const buffer=Buffer.alloc(4097);let n=0;while(n<buffer.length){const count=c.fs.readSync(fd,buffer,n,buffer.length-n,n);if(!count)break;n+=count;}if(n>4096)fail("Target restart process observation exceeds its bound.");return buffer.subarray(0,n).toString();}finally{c.fs.closeSync(fd);}
}
function restartProcessesAbsent(c:Context,processes:unknown):void{
 if(!Array.isArray(processes)||!processes.length||processes.length>8)fail("Retained target process proof is invalid.");
 for(const process of processes){
  if(!exact(process,["pid","birth","cgroup"])||!positive(process.pid)||typeof process.birth!=="string"||!/^[1-9][0-9]{0,19}$/u.test(process.birth)||typeof process.cgroup!=="string"||!process.cgroup.startsWith("/sys/fs/cgroup/")||process.cgroup.length>4096||process.cgroup.split("/").some((v:string)=>v===".."||v===".")||process.cgroup.includes("\0"))fail("Retained target process identity differs.");
  try{const text=restartProcText(c,"/proc/"+process.pid+"/stat"),birth=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u)[19];if(!birth||!/^[1-9][0-9]{0,19}$/u.test(birth)||birth===process.birth)fail("Original target process is not absent.");}catch(error){if(code(error)!=="ENOENT")throw error;}
  try{if(restartProcText(c,process.cgroup+"/cgroup.procs").trim())fail("Original target cgroup is not empty.");}catch(error){if(code(error)!=="ENOENT")throw error;}
 }
}
async function verifyTargetRestartAdmission(owner:ProviderServiceOwnership,client:DockerClient,root:Row):Promise<void>{
 const c=current(owner,true);if(absent(c,c.path.join(c.service.path,TARGET_RESTART_NAME)))fail("Retained target admission refuses ordinary root startup.");
 const target=targetRestartOwner(c),record=targetRestartRecord(c),input=JSON.parse(record.input_json),proof=input.proof,binding=JSON.parse(target.binding_json);
 if(!exact(input,["protocol","indexId","domainSha256","target","proof"])||input.protocol!=="clank-provider-target-restart-record/1"||input.indexId!==root.index_id||input.domainSha256!==root.domain_sha256||JSON.stringify(input.target)!==JSON.stringify(target)||target.protocol!==1||target.id!==1||target.index_id!==root.index_id||target.domain_sha256!==root.domain_sha256||c.hash(target.binding_json)!==target.binding_sha256||!match(target.target_id,UUID)||!match(target.project_id,ID)||target.workspace_name!==".clank-target-"+target.target_id)fail("Retained target restart owner binding differs.");
 if(!exact(proof,["protocol","handoffId","targetId","projectId","releaseId","generation","capsuleSha256","containerId","pid","birth","lifecycleFence","coordinatorReceipt","stateJSON","fenceJSON","processes"])||proof.protocol!=="clank-provider-target-restart/1"||proof.targetId!==target.target_id||proof.projectId!==target.project_id||!match(proof.handoffId,ID)||!match(proof.releaseId,ID)||!positive(proof.generation)||!positive(proof.lifecycleFence)||!match(proof.capsuleSha256,DIGEST)||!match(proof.containerId,DIGEST)||typeof proof.coordinatorReceipt!=="string")fail("Retained target restart proof differs.");
 if(binding.targetId!==target.target_id||binding.projectId!==target.project_id||binding.indexId!==root.index_id||binding.domainSha256!==root.domain_sha256||binding.canonical?.generation!==proof.generation||binding.canonical?.releaseId!==proof.releaseId||binding.canonical?.handoffId!==proof.handoffId)fail("Retained target canonical lineage differs.");
 const committed=JSON.parse(proof.coordinatorReceipt);
 if(!exact(committed,["protocol","handoffId","targetId","containerId","capsuleSha256","nodeId","releaseId","generation","pid","birth"])||committed.protocol!=="clank-provider-handoff-placement-committed/1"||committed.handoffId!==proof.handoffId||committed.targetId!==proof.targetId||committed.containerId!==proof.containerId||committed.capsuleSha256!==proof.capsuleSha256||committed.nodeId!==root.domain.nodeId||committed.releaseId!==proof.releaseId||committed.generation!==proof.generation||committed.pid!==proof.pid||committed.birth!==proof.birth||!Array.isArray(proof.processes)||!proof.processes.some((p:any)=>p?.pid===proof.pid&&p?.birth===proof.birth))fail("Retained target committed coordinator receipt differs.");
 const module=await import("./provider-data.ts");current(owner,true);
 const initial=module.providerDataRestartBinding(proof.stateJSON,proof.fenceJSON,target.project_id);
 if(initial.active.generation!==proof.generation||initial.active.releaseId!==proof.releaseId||initial.active.capsuleSha256!==proof.capsuleSha256||initial.active.fence!==proof.lifecycleFence||initial.fence!==proof.lifecycleFence)fail("Retained target original data differs.");
 const from=c.pins.length;try{
  const projects=directory(c,c.root,"projects"),project=directory(c,projects,target.project_id);
  const read=(name:string)=>{const file=pin(c,c.path.join(project.path,name),false,65536),body=c.fs.readFileSync(file.anchor,"utf8");assertPin(c,file);return body;};
  const observed=module.providerDataRestartBinding(read("state.json"),read("fence.json"),target.project_id);
  if(observed.active.generation<initial.active.generation||observed.active.fence<initial.active.fence||observed.fence<initial.fence||observed.active.databasePath!==initial.active.databasePath||observed.active.generation===initial.active.generation&&(observed.active.releaseId!==initial.active.releaseId||observed.active.capsuleSha256!==initial.active.capsuleSha256))fail("Retained target data moved outside its committed lineage.");
  directory(c,c.service,target.workspace_name);restartProcessesAbsent(c,proof.processes);
  const remaining=await runProviderDockerClient(client,["container","ls","--all","--no-trunc","--filter","id="+proof.containerId,"--format","{{.ID}}"],{timeoutMs:15000,maxOutputBytes:4096});current(owner,true);
  if(remaining.stdout.trim())fail("Original target container is not absent.");restartProcessesAbsent(c,proof.processes);
  for(const file of c.pins.slice(from))assertPin(c,file);
  if(JSON.stringify(targetRestartOwner(c))!==JSON.stringify(target)||JSON.stringify(targetRestartRecord(c))!==JSON.stringify(record)||marker(c)?.index_id!==root.index_id)fail("Retained target restart changed during admission.");
  verifiedTargetRestartFiles.set(owner,Object.freeze([TARGET_OWNER_NAME,TARGET_RESTART_NAME,target.workspace_name]));
 }finally{releasePins(c,from);}
}

/** Durable evidence authorizes strict cold cleanup, but publication never starts a writer. */
export async function persistProviderTargetAdoption(permit:import("./orchestration.ts").ProviderHandoffTargetAdoptionPermit):Promise<ProviderTargetAdoptionReceipt>{
 const module=await import("./orchestration.ts"),held=module.providerHandoffTargetAdoptionContext(permit);
 held.begin();
 try{
  const workspace=targetWorkspaces.get(held.native.workspace);if(!workspace)fail("Original adoption target workspace is unavailable.");
  const c=workspace.context;
  workspace.check();held.check();await held.native.verify();workspace.check();held.check();
  const target=targetRestartOwner(c),root=marker(c);
  if(!root||target.index_id!==root.index_id||target.domain_sha256!==root.domain_sha256||target.target_id!==held.proof.targetId)fail("Original adoption target owner differs.");
  const input=boundedJSON({protocol:"clank-provider-target-adoption-record/1",indexId:root.index_id,domainSha256:root.domain_sha256,target,proof:held.proof},131072),expected={id:1,protocol:1,input_json:input,input_sha256:c.hash(input)};
  createDatabase(c,c.service,TARGET_ADOPTION_NAME,TARGET_ADOPTION_MAX,[TARGET_ADOPTION_SQL],db=>{
   workspace.check();held.check();if(db.prepare("INSERT INTO clank_provider_target_adoption VALUES(1,1,?,?)").run(input,c.hash(input)).changes!==1||JSON.stringify(singleton(db,"clank_provider_target_adoption"))!==JSON.stringify(expected))fail("Original target adoption publication was not retained.");
  });
  if(JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(expected))fail("Original target adoption commit readback differs.");
  await held.native.verify();workspace.check();held.check();
  if(JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(expected)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(target)||JSON.stringify(marker(c))!==JSON.stringify(root))fail("Original target adoption publication changed.");
  const receipt=Object.freeze({handoffId:String(held.proof.handoffId),projectId:String(held.proof.projectId),targetId:String(held.proof.targetId)});
  const check=()=>{workspace.check();held.check();if(JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(expected)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(target)||JSON.stringify(marker(c))!==JSON.stringify(root))fail("Original live adoption receipt changed.");};
  targetAdoptionReceipts.set(receipt,Object.freeze({workspace,held,expected,target,root,check}));return receipt;
 }catch(error){try{await held.native.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original target adoption publication and cleanup failed.");}throw error;}
}
function targetAdoptionRecord(c:Context):Row{return databaseAt(c,c.service,TARGET_ADOPTION_NAME,TARGET_ADOPTION_MAX,false,db=>{strictSchema(c,db,[TARGET_ADOPTION_SQL]);const row=singleton(db,"clank_provider_target_adoption");if(row.protocol!==1||typeof row.input_json!=="string"||c.hash(row.input_json)!==row.input_sha256)fail("Retained target adoption record differs.");return row;});}

export interface ProviderTargetAdoptionReceipt {readonly handoffId:string;readonly projectId:string;readonly targetId:string;}
type AdoptionReceiptContext={workspace:TargetWorkspaceContext;held:ReturnType<typeof import("./orchestration.ts").providerHandoffTargetAdoptionContext>;expected:Row;target:Row;root:Row;check():void};
const targetAdoptionReceipts=new WeakMap<object,AdoptionReceiptContext>();
const adoptedReceiptClaims=new WeakSet<object>();
const adoptedOwnerReceipts=new WeakMap<ProviderServiceOwnership,AdoptionReceiptContext>();
export function assertProviderAdoptedTargetOwnership(owner:ProviderServiceOwnership):void{const record=adoptedOwnerReceipts.get(owner);if(!record)fail("A genuine adopted target owner is required.");const c=current(owner);if(JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(record.expected)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(record.target)||JSON.stringify(marker(c))!==JSON.stringify(record.root))fail("Original adopted target ownership receipt changed.");}
const adoptionMoves=new WeakMap<object,{owner:ProviderServiceOwnership;native:AdoptionReceiptContext["held"]["native"]}>();
export function providerTargetAdoptionMoveContext(value:object){const held=adoptionMoves.get(value);if(!held)fail("A genuine in-progress target adoption move is required.");current(held.owner);return held;}
export async function moveProviderTargetOwnership(receipt:ProviderTargetAdoptionReceipt):Promise<Readonly<{owner:ProviderServiceOwnership;runtime:import("./provider-target-stage.ts").ProviderAdoptedTargetRuntime;handoffId:string;lifecycleFence:number}>>{
 const original=targetAdoptionReceipts.get(receipt);if(!original)fail("A genuine original target adoption receipt is required.");
 if(adoptedReceiptClaims.has(receipt))fail("Original target adoption ownership is already consumed.");original.check();adoptedReceiptClaims.add(receipt);
 let owner:ProviderServiceOwnership|undefined,runtime:import("./provider-target-stage.ts").ProviderAdoptedTargetRuntime|undefined;
 const stage=await import("./provider-target-stage.ts");
 try{
  await original.held.native.verify();original.check();const prior=original.workspace.owner,c=current(prior);
  if(c.queued!==0)fail("Original target ownership still has an unsettled private operation.");
  owner=ownershipFacade(c,prior.fs,prior.path);adoptedOwnerReceipts.set(owner,original);adoptionMoves.set(receipt,Object.freeze({owner,native:original.held.native}));
  runtime=stage.transferProviderTargetRuntime(receipt);const native=stage.providerAdoptedTargetRuntimeContext(runtime);
  c.mode="ordinary-admitted";c.admitted=true;owners.delete(prior);
  verifiedTargetRestartFiles.set(owner,Object.freeze([TARGET_OWNER_NAME,TARGET_ADOPTION_NAME,original.target.workspace_name]));
  adoptedOwnerClosures.set(owner,new Set([()=>{void native.close().catch(()=>{});} ]));
  current(owner);if(JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(original.expected)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(original.target)||JSON.stringify(marker(c))!==JSON.stringify(original.root))fail("Original live adoption receipt changed during ownership move.");
  await native.verify();current(owner);
  return Object.freeze({owner,runtime,handoffId:receipt.handoffId,lifecycleFence:Number(original.held.proof.lifecycleFence)});
 }catch(error){const errors:unknown[]=[error];try{if(runtime)await stage.closeProviderAdoptedTargetRuntime(runtime);else{const pending=stage.settleFailedProviderTargetRuntime(receipt);if(pending)await pending;else await original.held.native.close();}}catch(cleanup){errors.push(cleanup);}try{owner?.close();}catch(cleanup){errors.push(cleanup);}if(errors.length>1)throw new AggregateError(errors,"Original live target ownership move and cleanup failed.");throw error;}
 finally{adoptionMoves.delete(receipt);}
}

const coldAdoptionProjects=new WeakMap<ProviderServiceOwnership,string>();
export function providerServiceAdoptionRecoveryProject(owner:ProviderServiceOwnership):string|undefined{current(owner);return coldAdoptionProjects.get(owner);}
function adoptionProcessIdentities(value:unknown):Row[]{
 if(!Array.isArray(value)||!value.length||value.length>8)fail("Retained adoption process proof is invalid.");
 return value.map(p=>{if(!exact(p,["pid","birth","cgroup"])||!positive(p.pid)||typeof p.birth!=="string"||!/^[1-9][0-9]{0,19}$/u.test(p.birth)||typeof p.cgroup!=="string"||!p.cgroup.startsWith("/sys/fs/cgroup/")||p.cgroup.length>4096||p.cgroup.split("/").some((part:string)=>part===".."||part===".")||p.cgroup.includes("\0"))fail("Retained adoption process identity differs.");return {...p};});
}
function adoptionProcessesAbsent(c:Context,processes:Row[]):boolean{
 for(const p of processes){
  try{const text=restartProcText(c,"/proc/"+p.pid+"/stat"),birth=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u)[19];if(!birth||!/^[1-9][0-9]{0,19}$/u.test(birth))fail("Retained adoption process birth differs.");if(birth===p.birth)return false;}catch(error){if(code(error)!=="ENOENT")throw error;}
  try{if(restartProcText(c,p.cgroup+"/cgroup.procs").trim())return false;}catch(error){if(code(error)!=="ENOENT")throw error;}
 }return true;
}
async function verifyTargetAdoptionAdmission(owner:ProviderServiceOwnership,client:DockerClient,root:Row):Promise<void>{
 const c=current(owner,true);if(absent(c,c.path.join(c.service.path,TARGET_ADOPTION_NAME)))fail("Retained target admission refuses ordinary root startup.");
 const target=targetRestartOwner(c),record=targetAdoptionRecord(c),input=JSON.parse(record.input_json),proof=input.proof,binding=JSON.parse(target.binding_json);
 if(!exact(input,["protocol","indexId","domainSha256","target","proof"])||input.protocol!=="clank-provider-target-adoption-record/1"||input.indexId!==root.index_id||input.domainSha256!==root.domain_sha256||JSON.stringify(input.target)!==JSON.stringify(target)||target.protocol!==1||target.id!==1||target.index_id!==root.index_id||target.domain_sha256!==root.domain_sha256||c.hash(target.binding_json)!==target.binding_sha256||!match(target.target_id,UUID)||!match(target.project_id,ID)||target.workspace_name!==".clank-target-"+target.target_id)fail("Retained target adoption owner binding differs.");
 if(!exact(proof,["protocol","handoffId","targetId","projectId","releaseId","generation","capsuleSha256","containerId","pid","birth","lifecycleFence","coordinatorReceipt","stateJSON","fenceJSON","configurationSha256","processes"])||proof.protocol!=="clank-provider-target-adoption/1"||proof.targetId!==target.target_id||proof.projectId!==target.project_id||!match(proof.handoffId,ID)||!match(proof.releaseId,ID)||!positive(proof.generation)||!positive(proof.lifecycleFence)||!match(proof.capsuleSha256,DIGEST)||!match(proof.containerId,DIGEST)||typeof proof.coordinatorReceipt!=="string"||!match(proof.configurationSha256,DIGEST))fail("Retained target adoption proof differs.");
 if(binding.targetId!==target.target_id||binding.projectId!==target.project_id||binding.indexId!==root.index_id||binding.domainSha256!==root.domain_sha256||binding.canonical?.generation!==proof.generation||binding.canonical?.releaseId!==proof.releaseId||binding.canonical?.handoffId!==proof.handoffId)fail("Retained target canonical lineage differs.");
 const committed=JSON.parse(proof.coordinatorReceipt);
 if(!exact(committed,["protocol","handoffId","targetId","containerId","capsuleSha256","nodeId","releaseId","generation","pid","birth"])||committed.protocol!=="clank-provider-handoff-placement-committed/1"||committed.handoffId!==proof.handoffId||committed.targetId!==proof.targetId||committed.containerId!==proof.containerId||committed.capsuleSha256!==proof.capsuleSha256||committed.nodeId!==root.domain.nodeId||committed.releaseId!==proof.releaseId||committed.generation!==proof.generation||committed.pid!==proof.pid||committed.birth!==proof.birth||!Array.isArray(proof.processes)||!proof.processes.some((p:any)=>p?.pid===proof.pid&&p?.birth===proof.birth))fail("Retained target committed coordinator receipt differs.");
 const module=await import("./provider-data.ts");current(owner,true);
 const initial=module.providerDataRestartBinding(proof.stateJSON,proof.fenceJSON,target.project_id);
 if(initial.active.generation!==proof.generation||initial.active.releaseId!==proof.releaseId||initial.active.capsuleSha256!==proof.capsuleSha256||initial.active.fence!==proof.lifecycleFence||initial.fence!==proof.lifecycleFence)fail("Retained target original data differs.");
 const from=c.pins.length;try{
  const projects=directory(c,c.root,"projects"),project=directory(c,projects,target.project_id);
  const read=(name:string)=>{const file=pin(c,c.path.join(project.path,name),false,65536),body=c.fs.readFileSync(file.anchor,"utf8");assertPin(c,file);return body;};
  const stateBody=read("state.json"),fenceBody=read("fence.json"),observed=module.providerDataRestartBinding(stateBody,fenceBody,target.project_id);
  if(observed.active.generation<initial.active.generation||observed.active.fence<initial.active.fence||observed.fence<initial.fence||observed.active.databasePath!==initial.active.databasePath||observed.active.generation===initial.active.generation&&(observed.active.releaseId!==initial.active.releaseId||observed.active.capsuleSha256!==initial.active.capsuleSha256))fail("Retained target data moved outside its committed lineage.");
  directory(c,c.service,target.workspace_name);
  const processes=adoptionProcessIdentities(proof.processes),process=(globalThis as any).process,deadline:bigint=process.hrtime.bigint()+30000000000n,signal=AbortSignal.timeout(30000);
  const check=()=>{current(owner,true);if(process.hrtime.bigint()>=deadline)fail("Retained target adoption cleanup deadline exceeded.");};
  const run=(args:string[],maximum=4194304)=>{check();return runProviderDockerClient(client,args,{timeoutMs:Math.max(1,Math.min(15000,Number((deadline-(process.hrtime.bigint() as bigint))/1000000n))),maxOutputBytes:maximum,signal});};
  const inventory=async()=>{const result=(await run(["container","ls","--all","--no-trunc","--filter","id="+proof.containerId,"--format","{{.ID}}"],4096)).stdout.trim();check();if(result!==""&&result!==proof.containerId)fail("Retained target adoption container identity differs.");return result;};
  if(await inventory()){
   const rows=JSON.parse((await run(["container","inspect",proof.containerId])).stdout);check();
   if(!Array.isArray(rows)||rows.length!==1)fail("Retained target adoption native inspection differs.");const row=rows[0];
   if(row.Id!==proof.containerId||row.AppArmorProfile!=="docker-default"||!row.HostConfig||row.HostConfig.OomKillDisable!==false&&row.HostConfig.OomKillDisable!==null||c.hash(providerDockerTargetConfiguration(row))!==proof.configurationSha256)fail("Retained target adoption native configuration differs.");
   if(positive(row.State?.Pid))try{
    const pid=row.State.Pid,text=restartProcText(c,"/proc/"+pid+"/stat"),birth=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u)[19],groups=restartProcText(c,"/proc/"+pid+"/cgroup").trim().split("\n");
    if(!birth||!/^[1-9][0-9]{0,19}$/u.test(birth)||groups.length!==1||!groups[0].startsWith("0::/")||groups[0].includes("/../"))fail("Retained target adoption process observation differs.");
    const actual={pid,birth,cgroup:"/sys/fs/cgroup"+groups[0].slice(3)};adoptionProcessIdentities([actual]);if(!processes.some(p=>p.pid===pid&&p.birth===birth))processes.push(actual);
   }catch(error){if(code(error)!=="ENOENT")throw error;}
   // Durable and physical authority must still match before removing this exact CID.
   for(const file of c.pins.slice(from))assertPin(c,file);
   if(JSON.stringify(targetRestartOwner(c))!==JSON.stringify(target)||JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(record)||JSON.stringify(marker(c))!==JSON.stringify(root))fail("Retained target adoption changed before cleanup.");
   await run(["container","rm","--force",proof.containerId]);check();
  }
  if(await inventory())fail("Retained target adoption orphan cleanup is unsettled.");
  while(!adoptionProcessesAbsent(c,processes)){check();await new Promise<void>(resolve=>setTimeout(resolve,25));}check();
  for(const file of c.pins.slice(from))assertPin(c,file);
  if(JSON.stringify(targetRestartOwner(c))!==JSON.stringify(target)||JSON.stringify(targetAdoptionRecord(c))!==JSON.stringify(record)||JSON.stringify(marker(c))!==JSON.stringify(root)||read("state.json")!==stateBody||read("fence.json")!==fenceBody)fail("Retained target adoption changed during admission.");
  verifiedTargetRestartFiles.set(owner,Object.freeze([...new Set([...(verifiedTargetRestartFiles.get(owner)??[]),TARGET_OWNER_NAME,TARGET_ADOPTION_NAME,target.workspace_name])]));coldAdoptionProjects.set(owner,target.project_id);
 }finally{releasePins(c,from);}
}

/** Bounded native evidence for a conditional publication; this is not admission. */
export function providerConditionalTargetEvidence(active:import("./provider-target-stage.ts").ProviderActivatedTarget,native:ReturnType<typeof import("./provider-target-stage.ts").providerActivatedTargetConditionalContext>):Readonly<Row>{
 const workspace=targetWorkspaces.get(native.workspace);if(!workspace)fail("Original conditional target workspace is unavailable.");workspace.check();
 const c=workspace.context,root=marker(c),target=targetRestartOwner(c),from=c.pins.length;
 try{const initial=JSON.parse(native.stateJSON),database=pin(c,c.path.join(workspace.canonical!.project.path,initial.active.databasePath),false,512*1024*1024);
  return freezeValue({target:native.target,stateJSON:native.stateJSON,fenceJSON:native.fenceJSON,configurationSha256:native.configurationSha256,processes:native.processes,source:native.source,root,targetOwner:target,rootIdentity:recoveryPin(c.root),serviceIdentity:recoveryPin(c.service),paths:[workspace.data,workspace.release,database].map(recoveryPin)});
 }finally{releasePins(c,from);}
}
export async function persistProviderConditionalTarget(active:import("./provider-target-stage.ts").ProviderActivatedTarget,journal:string,authentication:string):Promise<void>{
 const stage=await import("./provider-target-stage.ts"),native=stage.providerActivatedTargetConditionalContext(active),workspace=targetWorkspaces.get(native.workspace);if(!workspace)fail("Original conditional target workspace is unavailable.");
 const c=workspace.context;workspace.check();if(typeof journal!=="string"||Buffer.byteLength(journal)>524288||!match(authentication,DIGEST))fail("Conditional target journal exceeds its bound.");
 const expected={id:1,protocol:1,input_json:journal,authentication};
 if(absent(c,c.path.join(c.service.path,TARGET_CONDITIONAL_NAME)))createDatabase(c,c.service,TARGET_CONDITIONAL_NAME,TARGET_CONDITIONAL_MAX,[TARGET_CONDITIONAL_SQL],db=>{workspace.check();if(db.prepare("INSERT INTO clank_provider_target_conditional VALUES(1,1,?,?)").run(journal,authentication).changes!==1)fail("Conditional target journal was not retained.");});
 if(JSON.stringify(conditionalTargetRecord(c))!==JSON.stringify(expected))fail("Conditional target journal readback differs.");workspace.check();
}
function conditionalTargetRecord(c:Context):Row{return databaseAt(c,c.service,TARGET_CONDITIONAL_NAME,TARGET_CONDITIONAL_MAX,false,db=>{strictSchema(c,db,[TARGET_CONDITIONAL_SQL]);const row=singleton(db,"clank_provider_target_conditional");if(row.protocol!==1||typeof row.input_json!=="string"||Buffer.byteLength(row.input_json)>524288||!match(row.authentication,DIGEST))fail("Conditional target journal differs.");return row;});}

const conditionalNativeAuthorities=new WeakMap<object,{journal:string;authentication:string;authority:object;check():void}>();
export function assertProviderConditionalNativeRecovery(value:object,authority:object,journal:string,authentication:string):void{const held=conditionalNativeAuthorities.get(value);if(!held||held.authority!==authority||held.journal!==journal||held.authentication!==authentication)fail("A genuine verified native conditional recovery capability is required.");held.check();}
/** Fresh ownership can inspect a pending journal, but cannot turn it into permission. */
export function providerConditionalRecoveryContext(targetOwner:ProviderServiceOwnership,sourceOwner:ProviderServiceOwnership,client:DockerClient){
 const c=current(targetOwner,true),source=current(sourceOwner,true),record=conditionalTargetRecord(c),journal=JSON.parse(record.input_json),evidence=journal.native;
 let verified=false;
 const unchanged=()=>{current(targetOwner,true);current(sourceOwner,true);if(JSON.stringify(conditionalTargetRecord(c))!==JSON.stringify(record))fail("Conditional target journal changed during recovery.");};
 const verify=async(authority:object)=>{
  const platform=await import("./platform.ts"),approved=platform.platformConditionalRecoveryAuthority(authority,record.input_json,record.authentication);approved.check();
  unchanged();verified=false;const from=c.pins.length,sourceFrom=source.pins.length;
  try{
   const matchPin=(context:Context,input:Row)=>{if(!input||typeof input.path!=="string"||!context.path.isAbsolute(input.path)||input.path!==context.fs.realpathSync(input.path))fail("Conditional native path differs.");const retained=pin(context,input.path,input.directory,input.maximum);if(retained.dev!==input.dev||retained.ino!==input.ino)fail("Conditional native identity differs.");return retained;};
   if(!evidence||JSON.stringify(marker(c))!==JSON.stringify(evidence.root)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(evidence.targetOwner)||JSON.stringify(marker(source))!==JSON.stringify(evidence.source.root))fail("Conditional native owner differs.");
   for(const [context,expected]of [[c,evidence],[source,evidence.source]] as const){if(JSON.stringify(recoveryPin(context.root))!==JSON.stringify(expected.rootIdentity)||JSON.stringify(recoveryPin(context.service))!==JSON.stringify(expected.serviceIdentity))fail("Conditional native root identity differs.");for(const path of expected.paths)matchPin(context,path);}
   const stopped=evidence.source,sourceState=inspect(source,marker(source)).states.find(row=>row.projectId===evidence.target.projectId);
   if(JSON.stringify(sourceState)!==JSON.stringify(stopped.catalog)||sourceState?.grant?.state!=="stopped"||sourceState?.transfer?.phase!=="stopped"||JSON.stringify(recoverySourceIndex(source,stopped.root))!==JSON.stringify(stopped.index))fail("Conditional stopped source catalog or index differs.");
   const project=directory(c,directory(c,c.root,"projects"),evidence.target.projectId),read=(name:string)=>{const p=pin(c,c.path.join(project.path,name),false,65536);return c.fs.readFileSync(p.anchor,"utf8");};
   if(read("state.json")!==evidence.stateJSON||read("fence.json")!==evidence.fenceJSON)fail("Conditional target canonical state differs.");
   const processes=adoptionProcessIdentities(evidence.processes),sourceProcesses=adoptionProcessIdentities(stopped.processes),deadline=((globalThis as any).process.hrtime.bigint() as bigint)+30000000000n;
   const check=()=>{approved.check();unchanged();if((globalThis as any).process.hrtime.bigint()>=deadline)fail("Conditional native recovery deadline exceeded.");for(const p of c.pins.slice(from))assertPin(c,p);for(const p of source.pins.slice(sourceFrom))assertPin(source,p);};
   const run=async(args:string[],maximum=4194304)=>{check();const result=await runProviderDockerClient(client,args,{timeoutMs:Math.max(1,Math.min(15000,Number((deadline-((globalThis as any).process.hrtime.bigint() as bigint))/1000000n))),maxOutputBytes:maximum});check();return result;};
   const daemon=JSON.parse((await run(["info","--format","{{json .ID}}"],4096)).stdout);if(daemon!==evidence.root.domain.daemonId||daemon!==stopped.root.domain.daemonId)fail("Conditional native Docker daemon differs.");
   restartProcessesAbsent(source,sourceProcesses);
   const inventory=async(allowTarget:boolean)=>{
    const text=(await run(["container","ls","--all","--no-trunc","--format","{{.ID}}"])).stdout.trim(),ids=text?text.split("\n"):[];
    if(ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!match(id,DIGEST)))fail("Conditional writer inventory exceeds its bound.");let present=false;
    for(const id of ids){
     const rows=JSON.parse((await run(["container","inspect",id])).stdout);if(!Array.isArray(rows)||rows.length!==1||rows[0].Id!==id)fail("Conditional native container observation differs.");const row=rows[0];
     if(id===evidence.target.containerId){if(!allowTarget)fail("Conditional uncertain target removal is unsettled.");if(row.AppArmorProfile!=="docker-default"||!row.HostConfig||row.HostConfig.OomKillDisable!==false&&row.HostConfig.OomKillDisable!==null||c.hash(providerDockerTargetConfiguration(row))!==evidence.configurationSha256)fail("Conditional uncertain target configuration differs.");if(positive(row.State?.Pid)){const pid=row.State.Pid,text=restartProcText(c,"/proc/"+pid+"/stat"),birth=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/u)[19],groups=restartProcText(c,"/proc/"+pid+"/cgroup").trim().split("\n");if(!processes.some(p=>p.pid===pid&&p.birth===birth&&groups.length===1&&"0::"+p.cgroup.slice("/sys/fs/cgroup".length)===groups[0]))fail("Conditional uncertain target process differs.");}present=true;continue;}
     const labels=row.Config?.Labels??{};if(id===stopped.catalog.grant.container_id||[evidence.root.domain.owner,stopped.root.domain.owner].includes(labels["run.clank.owner"])&&labels["run.clank.project"]===evidence.target.projectId)fail("Conditional recovery has another project writer.");
     if(!Array.isArray(row.Mounts)||row.Mounts.length>256)fail("Conditional competing mount observation differs.");for(const mount of row.Mounts){if(mount.RW!==true)continue;if(typeof mount.Source!=="string"||!c.path.isAbsolute(mount.Source))fail("Conditional writable mount cannot be verified.");const path=c.fs.realpathSync(mount.Source),stat=c.fs.statSync(path);if([...evidence.paths,...stopped.paths].some((p:Row)=>path===p.path||path.startsWith(p.path+"/")||p.path.startsWith(path+"/")||stat.dev===p.dev&&stat.ino===p.ino))fail("Conditional data has a competing writable mount.");}
    }return present;
   };
   const present=await inventory(true);restartProcessesAbsent(source,sourceProcesses);check();
   if(present)await run(["container","rm","--force",evidence.target.containerId]);
   await inventory(false);while(!adoptionProcessesAbsent(c,processes)){check();await new Promise<void>(resolve=>setTimeout(resolve,25));}restartProcessesAbsent(source,sourceProcesses);check();
   if(read("state.json")!==evidence.stateJSON||read("fence.json")!==evidence.fenceJSON||JSON.stringify(inspect(source,marker(source)).states.find(row=>row.projectId===evidence.target.projectId))!==JSON.stringify(stopped.catalog))fail("Conditional source or target changed during cleanup.");verified=true;conditionalNativeAuthorities.set(result,{journal:record.input_json,authentication:record.authentication,authority,check:()=>result.check()});
  }finally{releasePins(c,from);releasePins(source,sourceFrom);}
 };
 const result=Object.freeze({journal:record.input_json,authentication:record.authentication,verify,check(){unchanged();if(!verified)fail("Conditional native absence has not been verified.");restartProcessesAbsent(c,evidence.processes);restartProcessesAbsent(source,evidence.source.processes);recoveryPathsCurrent(c,evidence.paths);recoveryPathsCurrent(source,evidence.source.paths);if(JSON.stringify(marker(c))!==JSON.stringify(evidence.root)||JSON.stringify(targetRestartOwner(c))!==JSON.stringify(evidence.targetOwner)||JSON.stringify(marker(source))!==JSON.stringify(evidence.source.root)||JSON.stringify(inspect(source,marker(source)).states.find(row=>row.projectId===evidence.target.projectId))!==JSON.stringify(evidence.source.catalog)||JSON.stringify(recoverySourceIndex(source,evidence.source.root))!==JSON.stringify(evidence.source.index))fail("Conditional verified native evidence changed.");const from=c.pins.length;try{const project=directory(c,directory(c,c.root,"projects"),evidence.target.projectId);for(const [name,body]of [["state.json",evidence.stateJSON],["fence.json",evidence.fenceJSON]]){const file=pin(c,c.path.join(project.path,name),false,65536);if(c.fs.readFileSync(file.anchor,"utf8")!==body)fail("Conditional verified canonical metadata changed.");}}finally{releasePins(c,from);}},async publish(permit:object){const module=await import("./orchestration.ts"),approved=module.providerConditionalRestartPermitContext(permit);approved.check();if(approved.native!==result)fail("Conditional restart permit native owner differs.");const proof=approved.proof;unchanged();if(!verified)fail("Conditional native absence has not been verified.");const input=boundedJSON({protocol:"clank-provider-target-restart-record/1",indexId:evidence.root.index_id,domainSha256:evidence.root.domain_sha256,target:evidence.targetOwner,proof},131072),expected={id:1,protocol:1,input_json:input,input_sha256:c.hash(input)};if(absent(c,c.path.join(c.service.path,TARGET_RESTART_NAME)))createDatabase(c,c.service,TARGET_RESTART_NAME,TARGET_RESTART_MAX,[TARGET_RESTART_SQL],db=>{if(db.prepare("INSERT INTO clank_provider_target_restart VALUES(1,1,?,?)").run(input,c.hash(input)).changes!==1)fail("Conditional restart permission was not retained.");});if(JSON.stringify(targetRestartRecord(c))!==JSON.stringify(expected))fail("Conditional restart permission readback differs.");approved.check();}});return result;
}
