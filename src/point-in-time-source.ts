import { sealPointInTimeState } from "./point-in-time-state.ts";
import type { SQLiteCaptureConnection } from "./sqlite-internal.ts";
import type { PointInTimeTransferSourceBinding, PointInTimeTransferCursor, PointInTimeTransferSourceSeal, PointInTimeTransferBatch } from "./point-in-time.ts";

type Connection = Pick<SQLiteCaptureConnection,"prepare">;
export const SOURCE_SEAL_SQL = "CREATE TABLE clank_pitr_source_seal(id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL CHECK(protocol=1),receipt TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 16384)) STRICT";
const encode = JSON.stringify;
const buffer = () => (globalThis as any).Buffer;
const hash = (crypto:any,value:any) => crypto.createHash("sha256").update(value).digest("hex");
const mac = (crypto:any,key:Uint8Array,value:any) => crypto.createHmac("sha256",key).update(encode(value)).digest("hex");
function fail():never {throw new Error("Retained source seal, base or journal evidence is missing, changed or unsupported.");}
export function sourceCursor(state:any):PointInTimeTransferCursor {return Object.freeze({epoch:state.epoch,sequence:state.sequence,digest:state.digest});}
export function sourceInput(binding:PointInTimeTransferSourceBinding,after:PointInTimeTransferCursor){return {...binding,after};}
/** Shared native validation for the retained live connection and read-only restart worker. */
export function validateSourceState(db:Connection,crypto:any,key:Uint8Array,maximum:number){
  const rows=db.prepare("SELECT * FROM clank_pitr_state LIMIT 2").all(),state=rows[0];
  if(rows.length!==1||state?.id!==1||![1,2].includes(Number(state.remote_exports_protocol))||state.key_hash!==hash(crypto,key)
    ||typeof state.epoch!=="string"||!/^[0-9a-f-]{36}$/u.test(state.epoch)||!Number.isSafeInteger(state.sequence)||Number(state.sequence)<0
    ||!Number.isSafeInteger(state.committed_at)||Number(state.committed_at)<1||!Number.isSafeInteger(state.exported)||Number(state.exported)<0||Number(state.exported)>Number(state.sequence)
    ||typeof state.digest!=="string"||!/^[0-9a-f]{64}$/u.test(state.digest)||!state.base_id)fail();
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE (type='trigger' OR type='index' AND sql IS NOT NULL) AND tbl_name IN ('clank_pitr_state','clank_pitr_journal','clank_pitr_remote_exports','clank_pitr_source_seal') LIMIT 1").get())fail();
  const shape=encode(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY type,name").all());
  if(hash(crypto,shape)!==state.schema_hash||sealPointInTimeState(db,crypto.createHash,maximum)!==state.state_hash)fail();
  const seal=db.prepare("SELECT sql FROM sqlite_schema WHERE name='clank_pitr_source_seal'").get();
  if(state.remote_exports_protocol===1&&seal||state.remote_exports_protocol===2&&seal?.sql!==SOURCE_SEAL_SQL)fail();
  return state;
}
/** Validate a real retained receipt, not merely caller-supplied base identity. */
export function validateSourceBase(db:Connection,crypto:any,key:Uint8Array,state:any,binding:PointInTimeTransferSourceBinding){
  const rows=db.prepare("SELECT * FROM clank_pitr_remote_exports WHERE operation=? LIMIT 2").all(binding.baseOperationId),row=rows[0];
  if(rows.length!==1)fail();
  if(!row||typeof row.archive!=="string"||!Number.isSafeInteger(row.bytes)||Number(row.bytes)<1||Number(row.bytes)>256*1024*1024
    ||buffer().byteLength(row.archive)!==row.bytes||hash(crypto,row.archive)!==binding.baseArchiveSha256)fail();
  const archive=JSON.parse(row.archive),{authentication,...content}=archive;
  if(encode(archive)!==row.archive||authentication!==mac(crypto,key,content)||archive.protocol!=="clank-pitr-archive/1"||archive.operationId!==binding.baseOperationId
    ||encode(archive.binding)!==encode(binding.identity.source)||archive.epoch!==state.epoch||archive.keyId!==state.key_id
    ||archive.sequence===state.sequence&&(archive.committedAt!==state.committed_at||archive.digest!==state.digest)
    ||encode({epoch:archive.epoch,sequence:archive.sequence,digest:archive.digest})!==encode(binding.initialCursor)||!Array.isArray(archive.files))fail();
  const files=archive.files.filter((file:any)=>file.name==='epoch.json');if(files.length!==1)fail();
  const encoded=buffer().from(files[0].contents,"base64");
  if(encoded.length!==files[0].bytes||hash(crypto,encoded)!==files[0].sha256)fail();
  const epoch=JSON.parse(encoded.toString("utf8"));
  if(epoch.mac!==mac(crypto,key,epoch.manifest)||epoch.manifest.epoch!==state.epoch||epoch.manifest.keyId!==state.key_id||epoch.manifest.baseBackupId!==state.base_id)fail();
  validateSourceCursor(db,crypto,key,state,binding.initialCursor);
  return archive;
}
function sourceEntry(db:Connection,crypto:any,key:Uint8Array,state:any,sequence:number){
  const rows=db.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=? LIMIT 2").all(sequence);if(rows.length!==1)fail();
  const encoded=rows[0]?.envelope;
  if(typeof encoded!=="string"||buffer().byteLength(encoded)>12*1024*1024)fail();
  const entry=JSON.parse(encoded),{digest,...content}=entry;
  if(encode(entry)!==encoded||entry.protocol!=="clank-pitr/1"||entry.epoch!==state.epoch||entry.keyId!==state.key_id||entry.schemaHash!==state.schema_hash
    ||entry.sequence!==sequence||!Number.isSafeInteger(entry.committedAt)||entry.committedAt<1||hash(crypto,encode(content))!==digest)fail();
  const {iv,body,tag,...header}=content,decipher=crypto.createDecipheriv("aes-256-gcm",key,buffer().from(iv,"base64"));
  decipher.setAAD(buffer().from(encode(header)));decipher.setAuthTag(buffer().from(tag,"base64"));
  const plaintext=buffer().concat([decipher.update(buffer().from(body,"base64")),decipher.final()]);
  try {const parsed=JSON.parse(plaintext.toString("utf8"));if(typeof parsed.stateHash!=="string"||!/^[0-9a-f]{64}$/u.test(parsed.stateHash))fail();return {encoded,entry,stateHash:parsed.stateHash};}finally{plaintext.fill(0);}
}
export function validateSourceCursor(db:Connection,crypto:any,key:Uint8Array,state:any,cursor:PointInTimeTransferCursor){
  if(cursor.epoch!==state.epoch||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||cursor.sequence>state.sequence)fail();
  if(cursor.sequence===0){if(cursor.digest!=="0".repeat(64))fail();return;}
  const found=sourceEntry(db,crypto,key,state,cursor.sequence);
  if(found.entry.digest!==cursor.digest||cursor.sequence===state.sequence&&(found.stateHash!==state.state_hash||found.entry.committedAt!==state.committed_at))fail();
}
/** Authenticate the bounded pending chain and final logical state. */
export function sourceBatch(db:Connection,crypto:any,key:Uint8Array,state:any,binding:PointInTimeTransferSourceBinding,after:PointInTimeTransferCursor,through:number,limits:{bytes:number;entries:number}):PointInTimeTransferBatch {
  validateSourceCursor(db,crypto,key,state,after);
  if(after.sequence<binding.initialCursor.sequence||!Number.isSafeInteger(through)||through<=after.sequence||through>state.sequence||through-after.sequence>limits.entries)fail();
  let previous=after.digest,committedAt=after.sequence?sourceEntry(db,crypto,key,state,after.sequence).entry.committedAt:0,bytes=1024;
  const envelopes:string[]=[];
  for(let sequence=after.sequence+1;sequence<=through;sequence++){
    const {encoded,entry,stateHash}=sourceEntry(db,crypto,key,state,sequence);
    if(entry.previousDigest!==previous||entry.committedAt<=committedAt||sequence===state.sequence&&(stateHash!==state.state_hash||entry.digest!==state.digest||entry.committedAt!==state.committed_at))fail();
    bytes+=buffer().byteLength(encode(encoded))+1;if(bytes>limits.bytes)throw new Error("Source terminal tail exceeds the bounded transfer window; catch up the target first.");
    envelopes.push(encoded);previous=entry.digest;committedAt=entry.committedAt;
  }
  const content={protocol:"clank-pitr-transfer/1" as const,identity:binding.identity,keyId:String(state.key_id),baseBackupId:String(state.base_id),after,through:Object.freeze({epoch:after.epoch,sequence:through,digest:previous}),envelopes:Object.freeze(envelopes)};
  const batch=Object.freeze({...content,authentication:mac(crypto,key,content)});
  if(buffer().byteLength(encode(batch))>limits.bytes)throw new Error("Source transfer batch exceeds its byte bound.");return batch;
}
export function validateSourceTail(db:Connection,crypto:any,key:Uint8Array,state:any,binding:PointInTimeTransferSourceBinding,after:PointInTimeTransferCursor){
  validateSourceCursor(db,crypto,key,state,after);
  if(after.sequence<binding.initialCursor.sequence)fail();
  if(after.sequence<state.sequence)sourceBatch(db,crypto,key,state,binding,after,state.sequence,{bytes:8*1024*1024,entries:1000});
  else if(after.digest!==state.digest)fail();
}
export function newSourceSeal(crypto:any,key:Uint8Array,state:any,binding:PointInTimeTransferSourceBinding,after:PointInTimeTransferCursor):PointInTimeTransferSourceSeal {
  const content={protocol:"clank-pitr-source-seal/1" as const,...binding,baseBackupId:String(state.base_id),keyId:String(state.key_id),after,through:sourceCursor(state),committedAt:Number(state.committed_at),schemaHash:String(state.schema_hash),stateHash:String(state.state_hash),inputDigest:hash(crypto,encode(sourceInput(binding,after)))};
  return Object.freeze({...content,authentication:mac(crypto,key,content)});
}
export function validateSourceSeal(db:Connection,crypto:any,key:Uint8Array,state:any,binding:PointInTimeTransferSourceBinding,after:PointInTimeTransferCursor):PointInTimeTransferSourceSeal {
  if(state.remote_exports_protocol!==2)fail();
  validateSourceBase(db,crypto,key,state,binding);validateSourceTail(db,crypto,key,state,binding,after);
  const rows=db.prepare("SELECT * FROM clank_pitr_source_seal LIMIT 2").all(),row=rows[0],expected=newSourceSeal(crypto,key,state,binding,after),encoded=encode(expected);
  if(rows.length!==1||row?.id!==1||row.protocol!==1||row.receipt!==encoded||row.bytes!==buffer().byteLength(encoded)||Number(row.bytes)>16384)fail();
  return expected;
}
