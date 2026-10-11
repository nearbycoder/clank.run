// Frozen a9016df runtime; only its managed-shadow import URLs are rebound to the exact companion fixture.



/** @internal Explicit platform maxima; no implicit widening or enablement. */













/** @internal A review may narrow these limits, never broaden platform policy. */














/** @internal Transport aggregates carry no response body, identity or arbitrary header key. */






/** @internal The status version is separate from the immutable provider retirement identity. */

















































export const shadowLatencyBuckets = Object.freeze([1,5,10,25,50,100,250,500,1000,2500,5000,10000]);
const shadowUnknownReasons = Object.freeze(["not-submitted","candidate-timeout","candidate-oversized","candidate-error",
"primary-incomplete","primary-oversized","cancelled","authority-lost","interrupted","persistence-uncertain","content-type-invalid"]);

function shadowInvalid(code){const error = new TypeError(code === "SHADOW_POLICY_INVALID" ? "Shadow policy may only narrow explicit public reads and bounded limits.":"Retained shadow transport aggregates are invalid.");Object.assign(error,{code});throw error;}
function closedShadowObject(value,keys,code,required = true){
if(!value || typeof value !== "object" || Array.isArray(value)|| Object.keys(value).some(key=>!keys.includes(key))
|| required && keys.some(key=>!Object.hasOwn(value,key)))shadowInvalid(code);
return value;
}
function shadowNumber(value,maximum,code,minimum = 1){
if(typeof value !== "number" || !Number.isSafeInteger(value)|| value < minimum || value > maximum)shadowInvalid(code);
return value;
}
function shadowPercentage(value,maximum){
if(typeof value !== "number" || !Number.isFinite(value)|| value < 0.01 || value > maximum)shadowInvalid("SHADOW_POLICY_INVALID");
return value;
}
function shadowReads(value,methods,allowed){
if(!Array.isArray(value))shadowInvalid("SHADOW_POLICY_INVALID");
const items =[...value];
if(items.length < 1 || items.length >(methods ? 2:32)|| new Set(items).size !== items.length
|| items.some(path=>typeof path !== "string" ||(methods ? !["GET","HEAD"].includes(path)
:path.length > 256 || !/^\/[A-Za-z0-9/_.~-]*$/u.test(path)|| path.includes("//")|| path.split("/").some(segment=>segment === "." || segment === ".."))
|| allowed && !allowed.includes(path)))shadowInvalid("SHADOW_POLICY_INVALID");
return Object.freeze(items.sort());
}

/** @internal Normalize before creating schema, ownership or artifact side effects. */
export function normalizeShadowPolicy(value){
const fields =["revision","readPaths","methods","maxSamplePercent","maxDurationMs","maxAttempts","maxConcurrent","maxResponseBytes","maxRequestMs","maxReports"];
const input = closedShadowObject(value,fields,"SHADOW_POLICY_INVALID");
const result ={revision:shadowNumber(input.revision,Number.MAX_SAFE_INTEGER,"SHADOW_POLICY_INVALID"),readPaths:shadowReads(input.readPaths,false),
methods:shadowReads(input.methods,true),maxSamplePercent:shadowPercentage(input.maxSamplePercent,100),
maxDurationMs:shadowNumber(input.maxDurationMs,1800000,"SHADOW_POLICY_INVALID"),maxAttempts:shadowNumber(input.maxAttempts,10000,"SHADOW_POLICY_INVALID"),
maxConcurrent:shadowNumber(input.maxConcurrent,16,"SHADOW_POLICY_INVALID"),maxResponseBytes:shadowNumber(input.maxResponseBytes,65536,"SHADOW_POLICY_INVALID"),
maxRequestMs:shadowNumber(input.maxRequestMs,10000,"SHADOW_POLICY_INVALID"),maxReports:shadowNumber(input.maxReports,100,"SHADOW_POLICY_INVALID")};
return Object.freeze(result);
}

export function narrowShadowPolicy(policy,value){
const current = normalizeShadowPolicy(policy),input = closedShadowObject(value,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],"SHADOW_POLICY_INVALID",false);
const number =(key,maximum)=> shadowNumber(Object.hasOwn(input,key)?input[key]:maximum,maximum,"SHADOW_POLICY_INVALID");
return Object.freeze({readPaths:shadowReads(Object.hasOwn(input,"readPaths")?input.readPaths:current.readPaths,false,current.readPaths),
methods:shadowReads(Object.hasOwn(input,"methods")?input.methods:current.methods,true,current.methods),samplePercent:shadowPercentage(Object.hasOwn(input,"samplePercent")?input.samplePercent:current.maxSamplePercent,current.maxSamplePercent),
durationMs:number("durationMs",current.maxDurationMs),maxAttempts:number("maxAttempts",current.maxAttempts),maxConcurrent:number("maxConcurrent",current.maxConcurrent),
maxResponseBytes:number("maxResponseBytes",current.maxResponseBytes),requestMs:number("requestMs",current.maxRequestMs)});
}

export function emptyShadowReport(){
const unknown = Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,0]));
const latency =()=>({cumulative:shadowLatencyBuckets.map(()=>0),overflow:0,unknown:0});
return normalizeShadowReport({counters:{reserved:0,settled:0,comparable:0,statusClassEqual:0,statusClassDifferent:0,mediaTypeEqual:0,mediaTypeDifferent:0,bothComplete:0,unknown},latency:{primary:latency(),candidate:latency()}},10000);
}

/** @internal Fail closed before publishing or replaying a retained aggregate. */
export function normalizeShadowReport(value,maxAttempts){
const code = "SHADOW_REPORT_INVALID",maximum = shadowNumber(maxAttempts,10000,code),input = closedShadowObject(value,["counters","latency"],code);
const counterKeys =["reserved","settled","comparable","statusClassEqual","statusClassDifferent","mediaTypeEqual","mediaTypeDifferent","bothComplete","unknown"];
const raw = closedShadowObject(input.counters,counterKeys,code),rawUnknown = closedShadowObject(raw.unknown,shadowUnknownReasons,code);
const count =(number)=> shadowNumber(number,maximum,code,0);
const unknown = Object.freeze(Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,count(rawUnknown[reason])])));
const counters = Object.freeze({reserved:count(raw.reserved),settled:count(raw.settled),comparable:count(raw.comparable),statusClassEqual:count(raw.statusClassEqual),
statusClassDifferent:count(raw.statusClassDifferent),mediaTypeEqual:count(raw.mediaTypeEqual),mediaTypeDifferent:count(raw.mediaTypeDifferent),bothComplete:count(raw.bothComplete),unknown});
// Completion requires actual EOF for both bounded bodies. Invalid media or later authority/persistence loss
// can follow EOF, but a non-submission, timeout, transport error or incomplete/oversized body cannot.
const incomplete = unknown["not-submitted"]+unknown["candidate-timeout"]+unknown["candidate-oversized"]
+unknown["candidate-error"]+unknown["primary-incomplete"]+unknown["primary-oversized"];
if(counters.settled > counters.reserved || counters.bothComplete > counters.settled-incomplete || counters.comparable > counters.bothComplete
|| counters.statusClassEqual+counters.statusClassDifferent !== counters.comparable || counters.mediaTypeEqual+counters.mediaTypeDifferent !== counters.comparable
|| counters.comparable+Object.values(unknown).reduce((sum,value)=>sum+value,0)!== counters.settled)shadowInvalid(code);
const latency = closedShadowObject(input.latency,["primary","candidate"],code);
const histogram =(value)=>{
const raw = closedShadowObject(value,["cumulative","overflow","unknown"],code);
if(!Array.isArray(raw.cumulative)|| raw.cumulative.length !== shadowLatencyBuckets.length)shadowInvalid(code);
const cumulative =[...raw.cumulative].map(count),overflow = count(raw.overflow),unknown = count(raw.unknown);
if(cumulative.some((value,index)=>index > 0 && value < cumulative[index-1])|| cumulative[cumulative.length-1]+overflow+unknown !== counters.settled)shadowInvalid(code);
return Object.freeze({cumulative:Object.freeze(cumulative),overflow,unknown});
};
return Object.freeze({counters,latency:Object.freeze({primary:histogram(latency.primary),candidate:histogram(latency.candidate)})});
}

const shadowOutcomes = Object.freeze(["stopped","expired","attempt-limit","interrupted","authority-revoked","policy-changed","primary-changed","provider-error"]);
const shadowId =(value)=>{
if(typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))shadowInvalid("SHADOW_STATE_INVALID");
return value;
};
const shadowDigest =(value)=>{
if(typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))shadowInvalid("SHADOW_STATE_INVALID");
return value;
};
const shadowInteger =(value,maximum = Number.MAX_SAFE_INTEGER,minimum = 1)=> shadowNumber(value,maximum,"SHADOW_STATE_INVALID",minimum);
const shadowBinding =(value)=>{
const raw = closedShadowObject(value,["projectId","releaseId","generation","fence","incarnation"],"SHADOW_STATE_INVALID");
if(typeof raw.incarnation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(raw.incarnation))shadowInvalid("SHADOW_STATE_INVALID");
return Object.freeze({projectId:shadowId(raw.projectId),releaseId:shadowId(raw.releaseId),generation:shadowInteger(raw.generation),fence:shadowInteger(raw.fence),incarnation:raw.incarnation});
};
const shadowBoundedJson =(value,maximum)=>{
const serialized = JSON.stringify(value);
if(typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength>maximum)shadowInvalid("SHADOW_STATE_INVALID");
return serialized;
};

/** @internal Exact provider identity; the checkpoint digest never substitutes for this source capsule. */
export function shadowCandidateProjectId(operation,hash){
if(!operation.primary || !operation.capsuleSha256)shadowInvalid("SHADOW_STATE_INVALID");
return `canary_${shadowDigest(hash([operation.primary.projectId,operation.primary.incarnation,operation.controllerEpoch,operation.operationId,operation.capsuleSha256].join("\n")))}`;
}

/** @internal Strict retained union member; no reconstruction from damaged or partial state. */
export function normalizeShadowOperation(value,projectId,epoch,hash){
const code="SHADOW_STATE_INVALID",raw=closedShadowObject(value,["kind","sessionId","operationId","idempotencyKeyDigest","inputDigest","reviewDigest","releaseId","artifactSha256","capsuleSha256",
"controllerEpoch","retirementEpoch","primary","primaryReleaseId","primaryFence","nodeId","origin","credentialGeneration","policyRevision","policyDigest","policy","maxReports",
"phase","outcome","stopRequested","snapshot","report","reservations","retirement","createdAt","expiresAt","updatedAt"],code);
shadowBoundedJson(raw,64*1024);shadowId(projectId);shadowInteger(epoch);
for(const key of["sessionId","operationId","releaseId","primaryReleaseId","nodeId"])shadowId(raw[key]);
for(const key of["idempotencyKeyDigest","inputDigest","reviewDigest","artifactSha256","policyDigest"])shadowDigest(raw[key]);
for(const key of["controllerEpoch","retirementEpoch","primaryFence","credentialGeneration","policyRevision","createdAt","expiresAt","updatedAt"])shadowInteger(raw[key]);
if(raw.capsuleSha256!==null)shadowDigest(raw.capsuleSha256);
const policyInput=closedShadowObject(raw.policy,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],code);
const policy=narrowShadowPolicy({revision:1,readPaths:shadowReads(policyInput.readPaths,false),methods:shadowReads(policyInput.methods,true),
maxSamplePercent:100,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100},policyInput);
if(JSON.stringify(policy)!==JSON.stringify(raw.policy))shadowInvalid(code);
const primary=raw.primary===null?null:shadowBinding(raw.primary),report=normalizeShadowReport(raw.report,policy.maxAttempts);
let snapshot =null;
if(raw.snapshot!==null){
const value=closedShadowObject(raw.snapshot,["sha256","bytes","providerStartedAt","providerCompletedAt","platformObservedAt"],code);
snapshot=Object.freeze({sha256:shadowDigest(value.sha256),bytes:shadowInteger(value.bytes,2*1024*1024*1024-2*1024*1024-100*1024*1024-32),
providerStartedAt:shadowInteger(value.providerStartedAt),providerCompletedAt:shadowInteger(value.providerCompletedAt),platformObservedAt:shadowInteger(value.platformObservedAt)});
if(snapshot.providerCompletedAt<snapshot.providerStartedAt || snapshot.platformObservedAt<Number(raw.createdAt)|| snapshot.platformObservedAt>Number(raw.updatedAt))shadowInvalid(code);
}
if(!Array.isArray(raw.reservations)|| raw.reservations.length>policy.maxConcurrent)shadowInvalid(code);
const reservations=Object.freeze(raw.reservations.map(value=>shadowInteger(value,policy.maxAttempts)));
if(reservations.some((value,index)=>value>report.counters.reserved || index>0 && value<=reservations[index-1])
|| report.counters.reserved-report.counters.settled!==reservations.length)shadowInvalid(code);
if(raw.kind!=="shadow" || Number(raw.controllerEpoch)!==Number(raw.retirementEpoch)|| Number(raw.controllerEpoch)>epoch
|| typeof raw.stopRequested!=="boolean" || !["binding","preparing","observing","retiring","retired","complete"].includes(String(raw.phase))
|| raw.outcome!==null && !shadowOutcomes.includes(raw.outcome)|| raw.releaseId===raw.primaryReleaseId
|| Number(raw.createdAt)>Number(raw.updatedAt)|| Number(raw.expiresAt)!==Number(raw.createdAt)+policy.durationMs
|| typeof raw.origin!=="string" || raw.origin.length>2048)shadowInvalid(code);
const origin=new URL(raw.origin);
if(!["http:","https:"].includes(origin.protocol)|| origin.origin!==raw.origin || origin.username || origin.password)shadowInvalid(code);
if(primary &&(primary.projectId!==projectId || primary.releaseId!==raw.primaryReleaseId || primary.generation!==raw.credentialGeneration || primary.fence!==raw.primaryFence))shadowInvalid(code);
const operation={...raw,primary,policy,maxReports:shadowInteger(raw.maxReports,100),snapshot,report,reservations};
let retirement =null;
if(raw.retirement!==null){
const value=closedShadowObject(raw.retirement,["protocol","primary","operationId","controllerEpoch","releaseId","capsuleSha256","candidateProjectId","retirementEpoch","phase"],code);
const bound=shadowBinding(value.primary);
if(!primary || JSON.stringify(bound)!==JSON.stringify(primary)|| value.protocol!=="clank-provider-canary-retirement/1" || value.phase!=="retired"
|| value.operationId!==operation.operationId || value.controllerEpoch!==operation.controllerEpoch || value.releaseId!==operation.releaseId
|| value.capsuleSha256!==operation.capsuleSha256 || value.retirementEpoch!==operation.retirementEpoch || value.candidateProjectId!==shadowCandidateProjectId(operation,hash))shadowInvalid(code);
retirement=Object.freeze({...value,primary:bound});
}
if(!["binding","complete"].includes(operation.phase)&&(!primary || !operation.capsuleSha256)
|| operation.phase==="binding" &&(primary!==null || snapshot!==null || retirement!==null || operation.outcome!==null || report.counters.reserved!==0)
||["preparing","observing"].includes(operation.phase)&&(operation.outcome!==null || retirement!==null)
|| operation.phase==="observing" && snapshot===null
||["retiring","retired","complete"].includes(operation.phase)&& operation.outcome===null
|| operation.phase==="retiring" && retirement!==null
|| operation.phase==="retired" && retirement===null
|| operation.phase==="complete" && primary!==null && retirement===null
||["retired","complete"].includes(operation.phase)&& reservations.length!==0
|| primary===null &&(snapshot!==null || retirement!==null || report.counters.reserved!==0))shadowInvalid(code);
return Object.freeze({...operation,retirement});
}

export function readShadowRecord(row,projectId,hash){
if(row.project_id!==projectId || row.protocol!==2 || typeof row.operation!=="string" || new TextEncoder().encode(row.operation).byteLength>64*1024)shadowInvalid("SHADOW_STATE_INVALID");
const epoch=shadowInteger(row.epoch),operation=normalizeShadowOperation(JSON.parse(row.operation),projectId,epoch,hash);
if(operation.updatedAt!==row.updated_at || JSON.stringify(operation)!==row.operation)shadowInvalid("SHADOW_STATE_INVALID");
return Object.freeze({protocol:2,epoch,operation,serialized:row.operation});
}

/** @internal Compact replay identity survives aggregate pruning; no live credential or observation is retained. */















const replayFields =["projectId","sessionId","operationId","controllerEpoch","epoch","idempotencyKeyDigest","inputDigest","reviewDigest","releaseId","artifactSha256","capsuleSha256",
"primary","primaryReleaseId","primaryGeneration","policyRevision","policyDigest","policy","phase","outcome","stopRequested","snapshot","createdAt","expiresAt","updatedAt"];

function replayIdentity(projectId,record){
const op=record.operation;
if(op.phase!=="binding" && op.phase!=="complete")shadowInvalid("SHADOW_STATE_INVALID");
return Object.freeze({projectId,sessionId:op.sessionId,operationId:op.operationId,controllerEpoch:op.controllerEpoch,epoch:record.epoch,
idempotencyKeyDigest:op.idempotencyKeyDigest,inputDigest:op.inputDigest,reviewDigest:op.reviewDigest,releaseId:op.releaseId,artifactSha256:op.artifactSha256,capsuleSha256:op.capsuleSha256,
primary:op.primary,primaryReleaseId:op.primaryReleaseId,primaryGeneration:op.credentialGeneration,policyRevision:op.policyRevision,policyDigest:op.policyDigest,policy:op.policy,
phase:op.phase,outcome:op.outcome,stopRequested:op.stopRequested,snapshot:op.snapshot,createdAt:op.createdAt,expiresAt:op.expiresAt,updatedAt:op.updatedAt});
}
function normalizeReplayIdentity(value,projectId){
const code="SHADOW_STATE_INVALID",raw=closedShadowObject(value,replayFields,code);
if(raw.projectId!==projectId)shadowInvalid(code);
for(const key of["projectId","sessionId","operationId","releaseId","primaryReleaseId"])shadowId(raw[key]);
for(const key of["idempotencyKeyDigest","inputDigest","reviewDigest","artifactSha256","policyDigest"])shadowDigest(raw[key]);
if(raw.capsuleSha256!==null)shadowDigest(raw.capsuleSha256);
for(const key of["controllerEpoch","epoch","primaryGeneration","policyRevision","createdAt","expiresAt","updatedAt"])shadowInteger(raw[key]);
const policyInput=closedShadowObject(raw.policy,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],code);
const policy=narrowShadowPolicy({revision:1,readPaths:shadowReads(policyInput.readPaths,false),methods:shadowReads(policyInput.methods,true),
maxSamplePercent:100,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100},policyInput);
const primary=raw.primary===null?null:shadowBinding(raw.primary);
let snapshot =null;
if(raw.snapshot!==null){const input=closedShadowObject(raw.snapshot,["sha256","bytes","providerStartedAt","providerCompletedAt","platformObservedAt"],code);
snapshot=Object.freeze({sha256:shadowDigest(input.sha256),bytes:shadowInteger(input.bytes,2*1024*1024*1024-2*1024*1024-100*1024*1024-32),
providerStartedAt:shadowInteger(input.providerStartedAt),providerCompletedAt:shadowInteger(input.providerCompletedAt),platformObservedAt:shadowInteger(input.platformObservedAt)});
if(snapshot.providerCompletedAt<snapshot.providerStartedAt || snapshot.platformObservedAt<Number(raw.createdAt)|| snapshot.platformObservedAt>Number(raw.updatedAt))shadowInvalid(code);}
if(Number(raw.controllerEpoch)>Number(raw.epoch)|| raw.releaseId===raw.primaryReleaseId || Number(raw.createdAt)>Number(raw.updatedAt)
|| Number(raw.expiresAt)!==Number(raw.createdAt)+policy.durationMs || JSON.stringify(policy)!==JSON.stringify(raw.policy)
|| typeof raw.stopRequested!=="boolean" || !["binding","complete"].includes(String(raw.phase))
|| raw.phase==="binding" &&(raw.outcome!==null || primary!==null || snapshot!==null || raw.capsuleSha256!==null || raw.controllerEpoch!==raw.epoch || raw.createdAt!==raw.updatedAt || raw.stopRequested!==false)
|| raw.phase==="complete" && !shadowOutcomes.includes(raw.outcome)
|| primary===null && snapshot!==null || primary!==null &&(raw.capsuleSha256===null || primary.projectId!==projectId || primary.releaseId!==raw.primaryReleaseId || primary.generation!==raw.primaryGeneration))shadowInvalid(code);
return Object.freeze({...raw,policy,primary,snapshot});
}
function reportDigest(identity,report,hash){
return shadowDigest(hash(shadowBoundedJson({identity,report},32*1024)));
}
function decodeReplay(row,projectId,hash){
const code="SHADOW_STATE_INVALID";
if(typeof row.receipt_json!=="string" || new TextEncoder().encode(row.receipt_json).byteLength>16*1024)shadowInvalid(code);
const raw=closedShadowObject(JSON.parse(row.receipt_json),["protocol","identity","reportDigest"],code),identity=normalizeReplayIdentity(raw.identity,projectId);
const receipt=Object.freeze({protocol:1,identity,reportDigest:shadowDigest(raw.reportDigest)});
if(raw.protocol!==1 || JSON.stringify(receipt)!==row.receipt_json || row.project_id!==projectId || row.session_id!==identity.sessionId
|| row.idempotency_key_digest!==identity.idempotencyKeyDigest || row.input_digest!==identity.inputDigest)shadowInvalid(code);
let report =null;
if(row.report_json!==null){
if(typeof row.report_json!=="string" || new TextEncoder().encode(row.report_json).byteLength>32*1024)shadowInvalid(code);
report=normalizeShadowReport(JSON.parse(row.report_json),identity.policy.maxAttempts);
if(JSON.stringify(report)!==row.report_json || reportDigest(identity,report,hash)!==receipt.reportDigest)shadowInvalid(code);
}else if(identity.phase!=="complete")shadowInvalid(code);
if(report &&(identity.phase==="binding" ? report.counters.reserved!==0:report.counters.reserved!==report.counters.settled))shadowInvalid(code);
return Object.freeze({receipt,report});
}
function replayMirror(rows,hash){
return JSON.stringify({protocol:1,count:rows.length,sha256:shadowDigest(hash(JSON.stringify(rows.map(row=>row.receipt))))});
}
/** @internal Bounded full-history check at admission, completion and recovery, not per observed response. */
export function readShadowReplays(connection,projectId,hash){
shadowId(projectId);
const raw=connection.prepare("SELECT * FROM clank_platform_shadow_reports WHERE project_id=? ORDER BY session_id LIMIT 1025").all(projectId);
if(raw.length>1024)shadowInvalid("SHADOW_STATE_INVALID");
const rows=Object.freeze(raw.map(row=>decodeReplay(row,projectId,hash))),project=connection.prepare("SELECT shadow_replay_receipt FROM clank_platform_projects WHERE id=?").get(projectId);
if(rows.filter(row=>row.receipt.identity.phase==="binding").length>1 || rows.filter(row=>row.receipt.identity.phase==="complete" && row.report!==null).length>100)shadowInvalid("SHADOW_STATE_INVALID");
if(!project || project.shadow_replay_receipt!==replayMirror(rows,hash)&& !(rows.length===0 && project.shadow_replay_receipt===null))shadowInvalid("SHADOW_STATE_INVALID");
return rows;
}
/** @internal Invoke only inside the platform's guarded native transaction, alongside its shared journal CAS. */
export function writeShadowReplay(connection,projectId,record,previous,hash){
if(!connection.inTransaction)shadowInvalid("SHADOW_STATE_INVALID");
const identity=replayIdentity(projectId,record),report=record.operation.report;
const receipt=Object.freeze({protocol:1,identity,reportDigest:reportDigest(identity,report,hash)}),serialized=shadowBoundedJson(receipt,16*1024);
const existing=previous.find(row=>row.receipt.identity.sessionId===identity.sessionId);
if(existing){
const prior=existing.receipt.identity;
if(prior.phase!=="binding" || identity.phase!=="complete" || prior.idempotencyKeyDigest!==identity.idempotencyKeyDigest || prior.inputDigest!==identity.inputDigest
|| prior.reviewDigest!==identity.reviewDigest || prior.controllerEpoch!==identity.controllerEpoch || prior.operationId!==identity.operationId
|| prior.releaseId!==identity.releaseId || prior.artifactSha256!==identity.artifactSha256 || prior.primaryReleaseId!==identity.primaryReleaseId
|| prior.primaryGeneration!==identity.primaryGeneration || prior.policyRevision!==identity.policyRevision || prior.policyDigest!==identity.policyDigest
|| JSON.stringify(prior.policy)!==JSON.stringify(identity.policy)|| prior.createdAt!==identity.createdAt || prior.expiresAt!==identity.expiresAt)shadowInvalid("SHADOW_STATE_INVALID");
}else if(previous.length>=1024 || identity.phase!=="binding" || previous.some(row=>row.receipt.identity.idempotencyKeyDigest===identity.idempotencyKeyDigest))shadowInvalid("SHADOW_STATE_INVALID");
const changed=existing
? connection.prepare("UPDATE clank_platform_shadow_reports SET receipt_json=?,report_json=? WHERE project_id=? AND session_id=? AND receipt_json=?").run(serialized,JSON.stringify(report),projectId,identity.sessionId,JSON.stringify(existing.receipt))
:connection.prepare("INSERT INTO clank_platform_shadow_reports VALUES(?,?,?,?,?,?)").run(projectId,identity.sessionId,identity.idempotencyKeyDigest,identity.inputDigest,serialized,JSON.stringify(report));
if(Number(changed.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
const expected=[...previous.filter(row=>row!==existing),Object.freeze({receipt,report})];
// SQLite BINARY order is code-point order, independent of the host locale.
expected.sort((a,b)=>a.receipt.identity.sessionId<b.receipt.identity.sessionId?-1:a.receipt.identity.sessionId>b.receipt.identity.sessionId?1:0);
const old=previous.length?replayMirror(previous,hash):connection.prepare("SELECT shadow_replay_receipt FROM clank_platform_projects WHERE id=?").get(projectId)?.shadow_replay_receipt;
const mirror=replayMirror(expected,hash),marked=connection.prepare("UPDATE clank_platform_projects SET shadow_replay_receipt=? WHERE id=? AND shadow_replay_receipt IS ?").run(mirror,projectId,old);
if(Number(marked.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
const prunedSessions=new Set();
if(identity.phase==="complete"){
const resolved=expected.filter(row=>row.receipt.identity.phase==="complete" && row.report!==null && row.receipt.identity.sessionId!==identity.sessionId).sort((a,b)=>a.receipt.identity.updatedAt-b.receipt.identity.updatedAt ||(a.receipt.identity.sessionId<b.receipt.identity.sessionId?-1:1));
for(const row of resolved.slice(0,Math.max(0,resolved.length+1-record.operation.maxReports))){
const pruned=connection.prepare("UPDATE clank_platform_shadow_reports SET report_json=NULL WHERE project_id=? AND session_id=? AND receipt_json=? AND report_json=?").run(projectId,row.receipt.identity.sessionId,JSON.stringify(row.receipt),JSON.stringify(row.report));
const after=connection.prepare("SELECT receipt_json,report_json FROM clank_platform_shadow_reports WHERE project_id=? AND session_id=?").get(projectId,row.receipt.identity.sessionId);
if(Number(pruned.changes)!==1 || after?.report_json!==null || after.receipt_json!==JSON.stringify(row.receipt))shadowInvalid("SHADOW_STATE_INVALID");
prunedSessions.add(row.receipt.identity.sessionId);
}
}
const confirmed=readShadowReplays(connection,projectId,hash),retained=confirmed.find(row=>row.receipt.identity.sessionId===identity.sessionId);
if(!retained || JSON.stringify(retained.receipt)!==serialized || JSON.stringify(retained.report)!==JSON.stringify(report)
|| confirmed.length!==expected.length || confirmed.some((row,index)=>JSON.stringify(row.receipt)!==JSON.stringify(expected[index].receipt)
|| JSON.stringify(row.report)!==JSON.stringify(prunedSessions.has(row.receipt.identity.sessionId)?null:expected[index].report))
|| identity.phase==="complete" && confirmed.filter(row=>row.receipt.identity.phase==="complete" && row.report!==null).length>record.operation.maxReports)shadowInvalid("SHADOW_STATE_INVALID");
}


function sameReplayAdmission(identity,operation){
return identity.sessionId===operation.sessionId && identity.operationId===operation.operationId && identity.controllerEpoch===operation.controllerEpoch
&& identity.idempotencyKeyDigest===operation.idempotencyKeyDigest && identity.inputDigest===operation.inputDigest && identity.reviewDigest===operation.reviewDigest
&& identity.releaseId===operation.releaseId && identity.artifactSha256===operation.artifactSha256 && identity.primaryReleaseId===operation.primaryReleaseId
&& identity.primaryGeneration===operation.credentialGeneration && identity.policyRevision===operation.policyRevision && identity.policyDigest===operation.policyDigest
&& JSON.stringify(identity.policy)===JSON.stringify(operation.policy)&& identity.createdAt===operation.createdAt && identity.expiresAt===operation.expiresAt;
}
/** @internal A selected current operation must retain its admission fence even between report writes. */
export function assertShadowReplay(connection,projectId,record,hash){
const row=connection.prepare("SELECT * FROM clank_platform_shadow_reports WHERE project_id=? AND session_id=?").get(projectId,record.operation.sessionId);
if(!row)shadowInvalid("SHADOW_STATE_INVALID");
const replay=decodeReplay(row,projectId,hash);
if(!sameReplayAdmission(replay.receipt.identity,record.operation)
|| record.operation.phase==="complete" && JSON.stringify(replay.receipt.identity)!==JSON.stringify(replayIdentity(projectId,record))
|| record.operation.phase!=="complete" && replay.receipt.identity.phase!=="binding")shadowInvalid("SHADOW_STATE_INVALID");
}
/** @internal The platform supplies its actual guarded connection and lease; no secondary catalog or lease is opened. */
export function saveShadowRecord(connection,projectId,prior,operation,current,hash){
const epoch=shadowInteger((prior?.epoch??0)+1),serialized=JSON.stringify(operation);
const record=readShadowRecord({project_id:projectId,protocol:2,epoch,operation:serialized,updated_at:operation.updatedAt},projectId,hash);
const write=()=>{
current();
const before=connection.prepare("SELECT * FROM clank_platform_provider_canaries WHERE project_id=?").get(projectId);
const project=connection.prepare("SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?").get(projectId);
if(!project || project.provider_canary_epoch!==(prior?.epoch??0)||(prior ? !before || before.epoch!==prior.epoch || before.operation!==prior.serialized:Boolean(before)))shadowInvalid("SHADOW_STATE_INVALID");
const admission=operation.phase==="binding" &&(!before || before.protocol!==2 || JSON.parse(String(before.operation)).sessionId!==operation.sessionId);
const previous=admission || operation.phase==="complete" ? readShadowReplays(connection,projectId,hash):null;
if(admission &&(operation.controllerEpoch!==epoch || operation.capsuleSha256!==null || operation.stopRequested || operation.createdAt!==operation.updatedAt))shadowInvalid("SHADOW_STATE_INVALID");
if(admission && Number(connection.prepare("SELECT count(*) AS total FROM clank_platform_provider_canaries WHERE protocol=2 AND json_extract(operation,'$.phase')<>'complete'").get()?.total)>=16)shadowInvalid("SHADOW_CAPACITY");
if(before?.protocol===2){const old=readShadowRecord(before,projectId,hash);assertShadowReplay(connection,projectId,old,hash);
if(old.operation.phase!=="complete"){
const op=old.operation,allowed ={binding:["binding","preparing","complete"],preparing:["preparing","observing","retiring"],observing:["observing","retiring"],retiring:["retiring","retired"],retired:["complete"],complete:[]};
if(op.sessionId!==operation.sessionId || op.controllerEpoch!==operation.controllerEpoch || !allowed[op.phase].includes(operation.phase)
|| operation.updatedAt<op.updatedAt || op.stopRequested && !operation.stopRequested || operation.report.counters.reserved<op.report.counters.reserved || operation.report.counters.settled<op.report.counters.settled
|| op.capsuleSha256!==null && operation.capsuleSha256!==op.capsuleSha256 || op.primary!==null && JSON.stringify(op.primary)!==JSON.stringify(operation.primary)
|| op.snapshot!==null && JSON.stringify(op.snapshot)!==JSON.stringify(operation.snapshot)|| op.retirement!==null && JSON.stringify(op.retirement)!==JSON.stringify(operation.retirement)
|| op.outcome!==null && operation.outcome!==op.outcome)shadowInvalid("SHADOW_STATE_INVALID");
}else if(!admission)shadowInvalid("SHADOW_STATE_INVALID");
}else if(before){const old=JSON.parse(String(before.operation));if(before.protocol!==1 || old.phase!=="complete")shadowInvalid("SHADOW_STATE_INVALID");}
const changed=connection.prepare(`INSERT INTO clank_platform_provider_canaries(project_id,protocol,epoch,operation,updated_at) VALUES(?,2,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET protocol=2,epoch=excluded.epoch,operation=excluded.operation,updated_at=excluded.updated_at`).run(projectId,epoch,serialized,operation.updatedAt);
const marked=connection.prepare("UPDATE clank_platform_projects SET provider_canary_epoch=? WHERE id=? AND provider_canary_epoch=?").run(epoch,projectId,prior?.epoch??0);
if(Number(changed.changes)!==1 || Number(marked.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
if(previous)writeShadowReplay(connection,projectId,record,previous,hash);
const retained=connection.prepare("SELECT * FROM clank_platform_provider_canaries WHERE project_id=?").get(projectId);
if(!retained || readShadowRecord(retained,projectId,hash).serialized!==serialized || retained.epoch!==epoch
|| connection.prepare("SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?").get(projectId)?.provider_canary_epoch!==epoch)shadowInvalid("SHADOW_STATE_INVALID");
assertShadowReplay(connection,projectId,record,hash);current();
};
if(connection.inTransaction)write();else connection.transaction(write);
return record;
}






function shadowCurrent(adapter,projectId,record,current){
current();const actual=adapter.read(projectId);
if(!actual || actual.epoch!==record.epoch || actual.serialized!==record.serialized)shadowInvalid("SHADOW_SUPERSEDED");
}
function interruptedShadowReport(operation){
const count=operation.reservations.length,report=operation.report;
return normalizeShadowReport({counters:{...report.counters,settled:report.counters.settled+count,unknown:{...report.counters.unknown,interrupted:report.counters.unknown.interrupted+count}},
latency:{primary:{...report.latency.primary,unknown:report.latency.primary.unknown+count},candidate:{...report.latency.candidate,unknown:report.latency.candidate.unknown+count}}},operation.policy.maxAttempts);
}
/** @internal Shared by the live owner and real platform startup, including policy-disabled recovery. */
export async function retireShadow(adapter,projectId,input,current,outcome){
let record=input;
const guard=()=>shadowCurrent(adapter,projectId,record,current),save=(operation)=>{guard();record=adapter.save(projectId,record,operation,current);guard();};
guard();if(record.operation.phase==="complete")return record;
const update=()=>Math.max(Date.now(),record.operation.updatedAt);
if(record.operation.phase==="binding"){
save({...record.operation,phase:"complete",outcome,report:interruptedShadowReport(record.operation),reservations:[],updatedAt:update()});return record;
}
if(record.operation.phase!=="retired"){
if(record.operation.phase!=="retiring")save({...record.operation,phase:"retiring",outcome,report:interruptedShadowReport(record.operation),reservations:[],updatedAt:update()});
const retirement=await adapter.retire(projectId,record,guard);guard();
save({...record.operation,phase:"retired",retirement,updatedAt:update()});
}
save({...record.operation,phase:"complete",updatedAt:update()});return record;
}





















/** @internal One tracked task owns the native project lease; exact stop never queues behind that task. */
export function createShadowController(adapter){

const owners=new Map();let closed=false;
const report=(error)=>{try{adapter.onError?.(error);}catch{/* Reporting must not detach the retained cleanup barrier. */}};
return{
start(projectId,input,admission,reviewedPrimary,authorizeBegin=admission){
// Serialize caller-owned values synchronously before lock() can suspend.
const operation=JSON.parse(shadowBoundedJson(input,64*1024));
const freeze=(value)=>{if(value && typeof value==="object"){for(const item of Object.values(value))freeze(item);Object.freeze(value);}};freeze(operation);
const expected=reviewedPrimary===undefined?undefined:shadowBinding(reviewedPrimary);
if(closed || owners.has(projectId))return Promise.reject(Object.assign(new Error("A shadow owner is already active or closed."),{code:"SHADOW_BUSY"}));
let accepted,rejected;
const ready=new Promise((resolve,reject)=>{accepted=resolve;rejected=reject;});
const owner ={abort:new AbortController(),record:null,current:null,flight:Promise.resolve(),observed:null};owners.set(projectId,owner);
owner.flight=adapter.lock(projectId,async()=>{
const current=adapter.authority(projectId);owner.current=current;
await adapter.scope(current,async()=>{
current();authorizeBegin();admission();if(closed || owner.abort.signal.aborted)throw new Error("Shadow owner closed before admission.");
owner.record=adapter.begin(projectId,operation,()=>{current();authorizeBegin();admission();});accepted(owner.record);
let outcome ="interrupted",wall=Date.now(),started=performance.now();
const live=()=>{
current();admission();adapter.admit(projectId,owner.record .operation);if(closed || owner.abort.signal.aborted || owner.record .operation.stopRequested)throw new Error("Shadow observation was stopped.");
const actual=adapter.read(projectId);
if(!actual || actual.operation.sessionId!==operation.sessionId || actual.operation.controllerEpoch!==operation.controllerEpoch
|| actual.epoch!==owner.record .epoch || actual.serialized!==owner.record .serialized)shadowInvalid("SHADOW_SUPERSEDED");
if(Date.now()<wall || Date.now()>=operation.expiresAt || performance.now()-started>=operation.policy.durationMs){outcome="expired";throw new Error("Shadow observation expired.");}
wall=Date.now();
};
const change=(update)=>{live();owner.record=adapter.save(projectId,owner.record,update(owner.record .operation),current);live();};
try{
live();const snapshot=await adapter.prepare(projectId,()=>owner.record,change,live,owner.abort.signal,expected);live();
owner.observed=performance.now();
change(op=>({...op,snapshot,phase:"observing",updatedAt:Math.max(Date.now(),op.updatedAt)}));
while(true){
live();await new Promise(resolve=>{
const done=()=>{clearTimeout(timer);owner.abort.signal.removeEventListener("abort",done);resolve();};
const timer=setTimeout(done,Math.max(1,Math.min(1000,operation.expiresAt-Date.now())));owner.abort.signal.addEventListener("abort",done,{once:true});
});
}
}catch(error){
if(owner.record .operation.stopRequested)outcome="stopped";
else if((outcome)!=="expired"){
const code=String((error)?.code??"");
outcome=closed?"interrupted":code==="SHADOW_AUTHORITY_REVOKED"?"authority-revoked":code==="SHADOW_PRIMARY_CHANGED"?"primary-changed":"provider-error";
}
try{owner.record=await retireShadow(adapter,projectId,owner.record,current,outcome);}
catch(cleanup){report(cleanup);throw cleanup;}
}
});
}).catch(error=>{rejected(error);report(error);}).finally(()=>{if(owners.get(projectId)===owner)owners.delete(projectId);});
return ready;
},
replay(projectId,keyDigest,bySession=false){
const owner=owners.get(projectId);
if(closed || !owner?.record || !owner.current)return undefined;
if(!adapter.replay)throw new Error("The native replay reader is unavailable.");
owner.current();const result=adapter.replay(projectId,keyDigest,owner.current,bySession);owner.current();return result;
},
elapsed(projectId,sessionId){const owner=owners.get(projectId);return owner?.record?.operation.sessionId===sessionId && owner.observed!==null?Math.max(0,Math.floor(performance.now()-owner.observed)):null;},
async requestStop(projectId,sessionId,operationId,controllerEpoch,authorized){
const owner=owners.get(projectId);
if(closed || !owner?.record || !owner.current)return undefined;
const current=owner.current;
return adapter.scope(current,async()=>{
current();authorized();const record=adapter.read(projectId);
if(!record || record.operation.sessionId!==sessionId || record.operation.operationId!==operationId || record.operation.controllerEpoch!==controllerEpoch
|| record.serialized!==owner.record .serialized)shadowInvalid("SHADOW_SUPERSEDED");
if(record.operation.phase==="complete")return record;
if(!record.operation.stopRequested)owner.record=adapter.save(projectId,record,{...record.operation,stopRequested:true,updatedAt:Math.max(Date.now(),record.operation.updatedAt)},()=>{current();authorized();});
current();authorized();owner.abort.abort();return owner.record;
});
},
async stop(projectId,sessionId,epoch,authorized){
const owner=owners.get(projectId);
if(!owner?.record || !owner.current)throw Object.assign(new Error("The exact live shadow owner is unavailable; recover its retained session."),{code:"SHADOW_OWNER_UNAVAILABLE"});
const current=owner.current;
await adapter.scope(current,async()=>{
current();authorized();const record=adapter.read(projectId);
if(!record || record.operation.sessionId!==sessionId || record.epoch!==epoch || record.serialized!==owner.record .serialized)shadowInvalid("SHADOW_SUPERSEDED");
owner.record=adapter.save(projectId,record,{...record.operation,stopRequested:true,updatedAt:Math.max(Date.now(),record.operation.updatedAt)},()=>{current();authorized();});
owner.abort.abort();
});
await owner.flight;
return adapter.lock(projectId,async()=>{const fresh=adapter.authority(projectId);return adapter.scope(fresh,async()=>{
fresh();authorized();const record=adapter.read(projectId);
if(!record || record.operation.sessionId!==sessionId || record.operation.phase!=="complete")throw new Error("Exact shadow cleanup remains uncertain.");return record;
});});
},
async recover(projectId){
if(closed || owners.has(projectId))throw Object.assign(new Error("A shadow owner is still active."),{code:"SHADOW_BUSY"});
return adapter.lock(projectId,async()=>{
const current=adapter.authority(projectId);
return adapter.scope(current,async()=>{current();const record=adapter.read(projectId);return record?retireShadow(adapter,projectId,record,current,"interrupted"):null;});
},true);
},
async close(){closed=true;for(const owner of owners.values())owner.abort.abort();await Promise.all([...owners.values()].map(owner=>owner.flight));},
};
}

/** @internal Canonical, bounded review identity; this value never grants native authority. */











const reviewFields=["version","projectId","releaseId","artifactSha256","primaryReleaseId","primaryGeneration","primaryFence","primaryIncarnation","primaryArtifactSha256",
"nodeId","providerBindingDigest","credentialGeneration","principalBindingDigest","policyRevision","policyDigest","selection","expectedEpoch","issuedAt","expiresAt","nonce","reviewDigest"];
const selectionFields=["pathIndices","methodMask","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"];
/** @internal Captures every scalar and array before the first admission await. */
export function normalizeShadowReview(value){
const code="SHADOW_REVIEW_INVALID",raw=closedShadowObject(value,reviewFields,code),selection=closedShadowObject(raw.selection,selectionFields,code);
if(raw.version!==1)shadowInvalid(code);
const indices=selection.pathIndices;
if(!Array.isArray(indices)|| indices.length<1 || indices.length>32 || indices.some((value,index)=>!Number.isSafeInteger(value)|| value<0 || value>31 || index>0 && value<=indices[index-1]))shadowInvalid(code);
const captured =Object.freeze({pathIndices:Object.freeze([...indices]),methodMask:shadowNumber(selection.methodMask,3,code),
samplePercent:shadowPercentage(selection.samplePercent,100),durationMs:shadowNumber(selection.durationMs,1800000,code),maxAttempts:shadowNumber(selection.maxAttempts,10000,code),
maxConcurrent:shadowNumber(selection.maxConcurrent,16,code),maxResponseBytes:shadowNumber(selection.maxResponseBytes,65536,code),requestMs:shadowNumber(selection.requestMs,10000,code)});
const binding=shadowBinding({projectId:raw.projectId,releaseId:raw.primaryReleaseId,generation:raw.primaryGeneration,fence:raw.primaryFence,incarnation:raw.primaryIncarnation});
const result =Object.freeze({version:1,projectId:binding.projectId,releaseId:shadowId(raw.releaseId),artifactSha256:shadowDigest(raw.artifactSha256),primaryReleaseId:binding.releaseId,
primaryGeneration:binding.generation,primaryFence:binding.fence,primaryIncarnation:binding.incarnation,primaryArtifactSha256:shadowDigest(raw.primaryArtifactSha256),nodeId:shadowId(raw.nodeId),
providerBindingDigest:shadowDigest(raw.providerBindingDigest),credentialGeneration:shadowInteger(raw.credentialGeneration),principalBindingDigest:shadowDigest(raw.principalBindingDigest),
policyRevision:shadowInteger(raw.policyRevision),policyDigest:shadowDigest(raw.policyDigest),selection:captured,expectedEpoch:shadowInteger(raw.expectedEpoch,Number.MAX_SAFE_INTEGER,0),
issuedAt:shadowInteger(raw.issuedAt),expiresAt:shadowInteger(raw.expiresAt),nonce:typeof raw.nonce==="string"?raw.nonce:"",reviewDigest:shadowDigest(raw.reviewDigest)});
if(result.releaseId===result.primaryReleaseId || result.credentialGeneration!==result.primaryGeneration || result.expiresAt!==result.issuedAt+120000
|| !/^[A-Za-z0-9_-]{22}$/u.test(result.nonce)|| reviewBase64(reviewBytes(result.nonce)).length!==22 || reviewBase64(reviewBytes(result.nonce))!==result.nonce)shadowInvalid(code);
shadowBoundedJson(result,3072);return result;
}
function reviewBase64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/=/gu,"").replace(/\+/gu,"-").replace(/\//gu,"_");}
function reviewBytes(value){
if(!/^[A-Za-z0-9_-]+$/u.test(value))shadowInvalid("SHADOW_REVIEW_INVALID");
try{return Uint8Array.from(atob(value.replace(/-/gu,"+").replace(/_/gu,"/")),char=>char.charCodeAt(0));}catch{shadowInvalid("SHADOW_REVIEW_INVALID");}
}
export function shadowReviewToken(payload,sign){
const canonical=JSON.stringify(normalizeShadowReview(payload)),signature=sign(canonical);
if(!(signature instanceof Uint8Array)|| signature.byteLength!==32)shadowInvalid("SHADOW_REVIEW_INVALID");
return "clankshr1."+reviewBase64(new TextEncoder().encode(canonical))+"."+reviewBase64(signature);
}
export function parseShadowReviewToken(token){
if(typeof token!=="string" || token.length>4150 || !/^clankshr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token))shadowInvalid("SHADOW_REVIEW_INVALID");
const parts=token.split("."),bytes=reviewBytes(parts[1]),signature=reviewBytes(parts[2]);
if(bytes.byteLength>3072 || signature.byteLength!==32 || reviewBase64(bytes)!==parts[1]|| reviewBase64(signature)!==parts[2])shadowInvalid("SHADOW_REVIEW_INVALID");
let canonical,payload;
try{canonical=new TextDecoder("utf-8",{fatal:true}).decode(bytes);payload=normalizeShadowReview(JSON.parse(canonical));}catch{shadowInvalid("SHADOW_REVIEW_INVALID");}
if(JSON.stringify(payload)!==canonical)shadowInvalid("SHADOW_REVIEW_INVALID");
return Object.freeze({payload,canonical,signature});
}
export function shadowReviewSelection(policy,effective){
const selected=narrowShadowPolicy(policy,effective);
return Object.freeze({pathIndices:Object.freeze(selected.readPaths.map(path=>policy.readPaths.indexOf(path))),methodMask:(selected.methods.includes("GET")?1:0)|(selected.methods.includes("HEAD")?2:0),
samplePercent:selected.samplePercent,durationMs:selected.durationMs,maxAttempts:selected.maxAttempts,maxConcurrent:selected.maxConcurrent,maxResponseBytes:selected.maxResponseBytes,requestMs:selected.requestMs});
}
export function expandShadowReviewSelection(policy,selection){
const paths=selection.pathIndices.map(index=>policy.readPaths[index]);
if(paths.some(path=>path===undefined))shadowInvalid("SHADOW_REVIEW_INVALID");
return narrowShadowPolicy(policy,{readPaths:paths,methods:[...(selection.methodMask&1?["GET"]:[]),...(selection.methodMask&2?["HEAD"]:[])],samplePercent:selection.samplePercent,durationMs:selection.durationMs,
maxAttempts:selection.maxAttempts,maxConcurrent:selection.maxConcurrent,maxResponseBytes:selection.maxResponseBytes,requestMs:selection.requestMs});
}
export function shadowReviewDigest(payload,principalBindingDigest,policy,hash){
return hash(JSON.stringify({version:1,action:"shadow-start",principalBindingDigest,projectId:payload.projectId,releaseId:payload.releaseId,artifactSha256:payload.artifactSha256,
primary:{releaseId:payload.primaryReleaseId,generation:payload.primaryGeneration,fence:payload.primaryFence,incarnation:payload.primaryIncarnation,artifactSha256:payload.primaryArtifactSha256},
nodeId:payload.nodeId,providerBindingDigest:payload.providerBindingDigest,credentialGeneration:payload.credentialGeneration,policyRevision:payload.policyRevision,policyDigest:payload.policyDigest,
effectivePolicyDigest:hash(JSON.stringify(policy)),expectedEpoch:payload.expectedEpoch,issuedAt:payload.issuedAt,expiresAt:payload.expiresAt,nonce:payload.nonce}));
}
/** @internal Call only after the native replay mirror and exact opaque input digest have matched. */
export function assertShadowReviewReplay(payload,identity,principalDigest,hash){
if(payload.projectId!==identity.projectId || payload.releaseId!==identity.releaseId || payload.artifactSha256!==identity.artifactSha256
|| payload.primaryReleaseId!==identity.primaryReleaseId || payload.primaryGeneration!==identity.primaryGeneration || payload.policyRevision!==identity.policyRevision || payload.policyDigest!==identity.policyDigest
|| payload.expectedEpoch+1!==identity.controllerEpoch || payload.principalBindingDigest!==principalDigest
|| identity.primary &&(payload.primaryFence!==identity.primary.fence || payload.primaryIncarnation!==identity.primary.incarnation)
|| shadowReviewDigest(payload,principalDigest,identity.policy,hash)!==identity.reviewDigest || payload.reviewDigest!==identity.reviewDigest)shadowInvalid("SHADOW_REPLAY_CONFLICT");
}

/** @internal Schema identity is separate from per-session policy and enablement. */
export const shadowSchemaIdentity = "clank-platform-shadow/2";


/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export function assertProviderShadowSchema(connection){
const invalid =()=>{const error = new Error("Retained shadow schema is missing or invalid; preserve it for recovery.");Object.assign(error,{code:"SUPERVISOR_SHADOW_SCHEMA"});throw error;};
const schemas ={
clank_platform_shadow_state:["singleton:INTEGER:0:1","protocol:INTEGER:1:0","enrollment_id:TEXT:1:0","schema_id:TEXT:1:0"],
clank_platform_shadow_reports:["project_id:TEXT:1:1","session_id:TEXT:1:2","idempotency_key_digest:TEXT:1:0","input_digest:TEXT:1:0","receipt_json:TEXT:1:0","report_json:TEXT:0:0"],
};
const tables = connection.prepare("PRAGMA table_list").all();
for(const[name,expected]of Object.entries(schemas)){
if(!tables.some(table => table.schema === "main" && table.name === name && table.type === "table" && table.strict === 1))invalid();
const columns = connection.prepare(`PRAGMA main.table_info(${name})`).all();
if(columns.length !== expected.length || columns.some((column,index)=> `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expected[index]))invalid();
}
if(!tables.some(table => table.schema === "main" && table.name === "clank_platform_provider_canaries" && table.type === "table"))invalid();
const candidateColumns = connection.prepare("PRAGMA main.table_info(clank_platform_provider_canaries)").all();
const expectedCandidateColumns =["project_id:TEXT:0:1","protocol:INTEGER:1:0","epoch:INTEGER:1:0","operation:TEXT:1:0","updated_at:INTEGER:1:0"];
if(candidateColumns.length !== expectedCandidateColumns.length || candidateColumns.some((column,index)=> `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expectedCandidateColumns[index]))invalid();
const indices = connection.prepare("PRAGMA main.index_list(clank_platform_shadow_reports)").all();
if(!indices.some(index =>{
if(index.unique !== 1 || index.partial !== 0 || typeof index.name !== "string")return false;
const columns = connection.prepare(`PRAGMA main.index_info("${index.name.replaceAll('"','""')}")`).all();
return columns.length === 2 && columns[0].name === "project_id" && columns[1].name === "idempotency_key_digest";
}))invalid();
const projects = connection.prepare("PRAGMA main.table_info(clank_platform_projects)").all();
const releases = connection.prepare("PRAGMA main.table_info(clank_platform_releases)").all();
if(!projects.some(column => column.name === "provider_canary_epoch" && column.type === "INTEGER" && column.notnull === 1 && column.dflt_value === "0")
|| !projects.some(column => column.name === "shadow_replay_receipt" && column.type === "TEXT" && column.notnull === 0)
|| !releases.some(column => column.name === "purpose" && column.type === "TEXT" && column.notnull === 1 && column.dflt_value === "'deployment'")
|| !releases.some(column => column.name === "upload_request_digest" && column.type === "TEXT" && column.notnull === 0))invalid();
const rows = connection.prepare("SELECT * FROM clank_platform_shadow_state LIMIT 2").all();
const row = rows[0];
if(rows.length !== 1 || row.singleton !== 1 || row.protocol !== 1 || !["clank-platform-shadow/1",shadowSchemaIdentity].includes(String(row.schema_id))
|| typeof row.enrollment_id !== "string" || !/^[a-f0-9]{64}$/u.test(row.enrollment_id))invalid();
const version = row.schema_id === shadowSchemaIdentity ? 2:1;
const publication = releases.find(column => column.name === "upload_publication_receipt");
if(version === 1){
if(publication || connection.prepare("SELECT 1 FROM clank_platform_releases WHERE purpose='shadow-upload' LIMIT 1").get())invalid();
}else if(!publication || publication.type !== "TEXT" || publication.notnull !== 0 || publication.dflt_value !== null)invalid();
return Object.freeze({enrollmentId:row.enrollment_id,version});
}
