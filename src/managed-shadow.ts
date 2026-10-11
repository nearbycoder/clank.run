import type { IngressRoute, IngressShadowMetadata, IngressShadowTap, IngressShadowObserver } from "./data-plane.ts";
import { exactRequest, registerRequestHandoff, type ExactRequest } from "./security.ts";
import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { DeploymentProviderCanaryBinding, DeploymentProviderCanaryRetirement } from "./provider-service.ts";

/** @internal Explicit platform maxima; no implicit widening or enablement. */
export interface PlatformShadowPolicy {
  readonly revision: number;
  readonly readPaths: readonly string[];
  readonly methods: readonly ("GET" | "HEAD")[];
  readonly maxSamplePercent: number;
  readonly maxDurationMs: number;
  readonly maxAttempts: number;
  readonly maxConcurrent: number;
  readonly maxResponseBytes: number;
  readonly maxRequestMs: number;
  readonly maxReports: number;
}

/** @internal A review may narrow these limits, never broaden platform policy. */
export interface ShadowSessionPolicy {
  readonly readPaths: readonly string[];
  readonly methods: readonly ("GET" | "HEAD")[];
  readonly samplePercent: number;
  readonly durationMs: number;
  readonly maxAttempts: number;
  readonly maxConcurrent: number;
  readonly maxResponseBytes: number;
  readonly requestMs: number;
}

export type ShadowUnknownReason = "not-submitted" | "candidate-timeout" | "candidate-oversized" | "candidate-error"
  | "primary-incomplete" | "primary-oversized" | "cancelled" | "authority-lost" | "interrupted" | "persistence-uncertain" | "content-type-invalid";
interface ShadowLatency { readonly cumulative: readonly number[]; readonly overflow: number; readonly unknown: number; }
/** @internal Transport aggregates carry no response body, identity or arbitrary header key. */
interface ShadowReportBody {
  readonly counters: Readonly<{ reserved: number; settled: number; comparable: number; statusClassEqual: number; statusClassDifferent: number;
    mediaTypeEqual: number; mediaTypeDifferent: number; bothComplete: number; unknown: Readonly<Record<ShadowUnknownReason, number>> }>;
  readonly latency: Readonly<{ primary: ShadowLatency; candidate: ShadowLatency }>;
}

export type ShadowSkipReason = "ineligible" | "sampled-out" | "capacity" | "attempt-limit" | "handoff-timeout" | "withdrawn";
export type ShadowSkips = Readonly<Record<ShadowSkipReason,number>>;
export interface ShadowLegacyReport extends ShadowReportBody { readonly protocol?: never; readonly skips?: never; }
export interface ShadowReportV2 extends ShadowReportBody { readonly protocol: 2; readonly skips: ShadowSkips; }
export type ShadowReport = ShadowLegacyReport | ShadowReportV2;
const shadowSkipReasons: readonly ShadowSkipReason[] = Object.freeze(["ineligible","sampled-out","capacity","attempt-limit","handoff-timeout","withdrawn"]);
const shadowSkipMaximum = 2147483647;

/** @internal The status version is separate from the immutable provider retirement identity. */
export type ShadowPhase = "binding" | "preparing" | "observing" | "retiring" | "retired" | "complete";
export type ShadowOutcome = "stopped" | "expired" | "attempt-limit" | "interrupted" | "authority-revoked" | "policy-changed" | "primary-changed" | "provider-error";
export interface ShadowCheckpoint {
  readonly sha256: string;
  readonly bytes: number;
  readonly providerStartedAt: number;
  readonly providerCompletedAt: number;
  readonly platformObservedAt: number;
}
export interface ShadowOperation {
  readonly kind: "shadow";
  readonly sessionId: string;
  readonly operationId: string;
  readonly idempotencyKeyDigest: string;
  readonly inputDigest: string;
  readonly reviewDigest: string;
  readonly releaseId: string;
  readonly artifactSha256: string;
  readonly capsuleSha256: string | null;
  readonly controllerEpoch: number;
  readonly retirementEpoch: number;
  readonly primary: DeploymentProviderCanaryBinding | null;
  readonly primaryReleaseId: string;
  readonly primaryFence: number;
  readonly nodeId: string;
  readonly origin: string;
  readonly credentialGeneration: number;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly policy: ShadowSessionPolicy;
  readonly maxReports: number;
  readonly phase: ShadowPhase;
  readonly outcome: ShadowOutcome | null;
  readonly stopRequested: boolean;
  readonly snapshot: ShadowCheckpoint | null;
  readonly report: ShadowReport;
  readonly reservations: readonly number[];
  readonly retirement: DeploymentProviderCanaryRetirement | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}
export interface ShadowRecord {
  readonly protocol: 2;
  readonly epoch: number;
  readonly operation: ShadowOperation;
  readonly serialized: string;
}

export const shadowLatencyBuckets: readonly number[] = Object.freeze([1,5,10,25,50,100,250,500,1000,2500,5000,10000]);
const shadowUnknownReasons: readonly ShadowUnknownReason[] = Object.freeze(["not-submitted","candidate-timeout","candidate-oversized","candidate-error",
  "primary-incomplete","primary-oversized","cancelled","authority-lost","interrupted","persistence-uncertain","content-type-invalid"]);

function shadowInvalid(code: string): never { const error = new TypeError(code === "SHADOW_POLICY_INVALID" ? "Shadow policy may only narrow explicit public reads and bounded limits." : "Retained shadow transport aggregates are invalid."); Object.assign(error,{code}); throw error; }
function closedShadowObject(value: unknown, keys: readonly string[], code: string, required = true): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))
    || required && keys.some(key=>!Object.hasOwn(value,key))) shadowInvalid(code);
  return value as Record<string,unknown>;
}
function shadowNumber(value: unknown, maximum: number, code: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) shadowInvalid(code);
  return value;
}
function shadowPercentage(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > maximum) shadowInvalid("SHADOW_POLICY_INVALID");
  return value;
}
function shadowReads(value: unknown, methods: boolean, allowed?: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) shadowInvalid("SHADOW_POLICY_INVALID");
  const items = [...value];
  if (items.length < 1 || items.length > (methods ? 2 : 32) || new Set(items).size !== items.length
    || items.some(path=>typeof path !== "string" || (methods ? !["GET","HEAD"].includes(path)
      : path.length > 256 || !/^\/[A-Za-z0-9/_.~-]*$/u.test(path) || path.includes("//") || path.split("/").some(segment=>segment === "." || segment === ".."))
      || allowed && !allowed.includes(path))) shadowInvalid("SHADOW_POLICY_INVALID");
  return Object.freeze(items.sort());
}

/** @internal Normalize before creating schema, ownership or artifact side effects. */
export function normalizeShadowPolicy(value: unknown): PlatformShadowPolicy {
  const fields = ["revision","readPaths","methods","maxSamplePercent","maxDurationMs","maxAttempts","maxConcurrent","maxResponseBytes","maxRequestMs","maxReports"];
  const input = closedShadowObject(value,fields,"SHADOW_POLICY_INVALID");
  const result = {revision:shadowNumber(input.revision,Number.MAX_SAFE_INTEGER,"SHADOW_POLICY_INVALID"),readPaths:shadowReads(input.readPaths,false),
    methods:shadowReads(input.methods,true) as readonly ("GET"|"HEAD")[],maxSamplePercent:shadowPercentage(input.maxSamplePercent,100),
    maxDurationMs:shadowNumber(input.maxDurationMs,1800000,"SHADOW_POLICY_INVALID"),maxAttempts:shadowNumber(input.maxAttempts,10000,"SHADOW_POLICY_INVALID"),
    maxConcurrent:shadowNumber(input.maxConcurrent,16,"SHADOW_POLICY_INVALID"),maxResponseBytes:shadowNumber(input.maxResponseBytes,65536,"SHADOW_POLICY_INVALID"),
    maxRequestMs:shadowNumber(input.maxRequestMs,10000,"SHADOW_POLICY_INVALID"),maxReports:shadowNumber(input.maxReports,100,"SHADOW_POLICY_INVALID")};
  return Object.freeze(result);
}

export function narrowShadowPolicy(policy: PlatformShadowPolicy, value: unknown): ShadowSessionPolicy {
  const current = normalizeShadowPolicy(policy),input = closedShadowObject(value,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],"SHADOW_POLICY_INVALID",false);
  const number = (key: string, maximum: number) => shadowNumber(Object.hasOwn(input,key)?input[key]:maximum,maximum,"SHADOW_POLICY_INVALID");
  return Object.freeze({readPaths:shadowReads(Object.hasOwn(input,"readPaths")?input.readPaths:current.readPaths,false,current.readPaths),
    methods:shadowReads(Object.hasOwn(input,"methods")?input.methods:current.methods,true,current.methods) as readonly ("GET"|"HEAD")[],samplePercent:shadowPercentage(Object.hasOwn(input,"samplePercent")?input.samplePercent:current.maxSamplePercent,current.maxSamplePercent),
    durationMs:number("durationMs",current.maxDurationMs),maxAttempts:number("maxAttempts",current.maxAttempts),maxConcurrent:number("maxConcurrent",current.maxConcurrent),
    maxResponseBytes:number("maxResponseBytes",current.maxResponseBytes),requestMs:number("requestMs",current.maxRequestMs)});
}

export function emptyShadowReport(version?: 1): ShadowLegacyReport;
export function emptyShadowReport(version: 2): ShadowReportV2;
export function emptyShadowReport(version: 1 | 2 = 1): ShadowReport {
  if(version!==1 && version!==2)shadowInvalid("SHADOW_REPORT_INVALID");
  const unknown = Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,0])) as Record<ShadowUnknownReason,number>;
  const latency = () => ({cumulative:shadowLatencyBuckets.map(()=>0),overflow:0,unknown:0});
  const body={counters:{reserved:0,settled:0,comparable:0,statusClassEqual:0,statusClassDifferent:0,mediaTypeEqual:0,mediaTypeDifferent:0,bothComplete:0,unknown},latency:{primary:latency(),candidate:latency()}};
  return normalizeShadowReport(version===2?{protocol:2,...body,skips:Object.fromEntries(shadowSkipReasons.map(reason=>[reason,0]))}:body,10000);
}

/** @internal Fail closed before publishing or replaying a retained aggregate. */
export function normalizeShadowReport(value: unknown, maxAttempts: number): ShadowReport {
  const code = "SHADOW_REPORT_INVALID",maximum = shadowNumber(maxAttempts,10000,code);
  const versioned=Boolean(value && typeof value==="object" && Object.hasOwn(value,"protocol"));
  const input=closedShadowObject(value,versioned?["protocol","counters","latency","skips"]:["counters","latency"],code);
  if(versioned && input.protocol!==2)shadowInvalid(code);
  const skips=versioned?normalizeShadowSkips(input.skips):undefined;
  const counterKeys = ["reserved","settled","comparable","statusClassEqual","statusClassDifferent","mediaTypeEqual","mediaTypeDifferent","bothComplete","unknown"];
  const raw = closedShadowObject(input.counters,counterKeys,code),rawUnknown = closedShadowObject(raw.unknown,shadowUnknownReasons,code);
  const count = (number: unknown) => shadowNumber(number,maximum,code,0);
  const unknown = Object.freeze(Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,count(rawUnknown[reason])])) as Record<ShadowUnknownReason,number>);
  const counters = Object.freeze({reserved:count(raw.reserved),settled:count(raw.settled),comparable:count(raw.comparable),statusClassEqual:count(raw.statusClassEqual),
    statusClassDifferent:count(raw.statusClassDifferent),mediaTypeEqual:count(raw.mediaTypeEqual),mediaTypeDifferent:count(raw.mediaTypeDifferent),bothComplete:count(raw.bothComplete),unknown});
  // Completion requires actual EOF for both bounded bodies. Invalid media or later authority/persistence loss
  // can follow EOF, but a non-submission, timeout, transport error or incomplete/oversized body cannot.
  const incomplete = unknown["not-submitted"]+unknown["candidate-timeout"]+unknown["candidate-oversized"]
    +unknown["candidate-error"]+unknown["primary-incomplete"]+unknown["primary-oversized"];
  if (counters.settled > counters.reserved || counters.bothComplete > counters.settled-incomplete || counters.comparable > counters.bothComplete
    || counters.statusClassEqual+counters.statusClassDifferent !== counters.comparable || counters.mediaTypeEqual+counters.mediaTypeDifferent !== counters.comparable
    || counters.comparable+Object.values(unknown).reduce((sum,value)=>sum+value,0) !== counters.settled) shadowInvalid(code);
  const latency = closedShadowObject(input.latency,["primary","candidate"],code);
  const histogram = (value: unknown): ShadowLatency => {
    const raw = closedShadowObject(value,["cumulative","overflow","unknown"],code);
    if (!Array.isArray(raw.cumulative) || raw.cumulative.length !== shadowLatencyBuckets.length) shadowInvalid(code);
    const cumulative = [...raw.cumulative].map(count),overflow = count(raw.overflow),unknown = count(raw.unknown);
    if (cumulative.some((value,index)=>index > 0 && value < cumulative[index-1]) || cumulative[cumulative.length-1]+overflow+unknown !== counters.settled) shadowInvalid(code);
    return Object.freeze({cumulative:Object.freeze(cumulative),overflow,unknown});
  };
  const body={counters,latency:Object.freeze({primary:histogram(latency.primary),candidate:histogram(latency.candidate)})};
  return skips?Object.freeze({protocol:2 as const,...body,skips}):Object.freeze(body);
}

function normalizeShadowSkips(value: unknown): ShadowSkips {
  const code="SHADOW_REPORT_INVALID",raw=closedShadowObject(value,shadowSkipReasons,code);
  return Object.freeze(Object.fromEntries(shadowSkipReasons.map(reason=>[reason,shadowNumber(raw[reason],shadowSkipMaximum,code,0)])) as Record<ShadowSkipReason,number>);
}
/** @internal Fixed best-effort skip totals never affect sample denominators. */
export function addShadowSkips(report: ShadowReportV2, increments: ShadowSkips, maxAttempts: number): ShadowReportV2 {
  const before=normalizeShadowReport(report,maxAttempts),added=normalizeShadowSkips(increments);
  if(before.protocol!==2)shadowInvalid("SHADOW_REPORT_INVALID");
  const skips=Object.fromEntries(shadowSkipReasons.map(reason=>[reason,Math.min(shadowSkipMaximum,before.skips[reason]+added[reason])]));
  return normalizeShadowReport({...before,skips},maxAttempts) as ShadowReportV2;
}
function assertShadowReportSchema(connection: ShadowRead, report: ShadowReport): void {
  if(report.protocol===2 && assertProviderShadowSchema(shadowSchemaRead(connection)).version!==3)shadowInvalid("SHADOW_STATE_INVALID");
}

const shadowOutcomes: readonly ShadowOutcome[] = Object.freeze(["stopped","expired","attempt-limit","interrupted","authority-revoked","policy-changed","primary-changed","provider-error"]);
const shadowId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) shadowInvalid("SHADOW_STATE_INVALID");
  return value;
};
const shadowDigest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) shadowInvalid("SHADOW_STATE_INVALID");
  return value;
};
const shadowInteger = (value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 1): number => shadowNumber(value,maximum,"SHADOW_STATE_INVALID",minimum);
const shadowBinding = (value: unknown): DeploymentProviderCanaryBinding => {
  const raw = closedShadowObject(value,["projectId","releaseId","generation","fence","incarnation"],"SHADOW_STATE_INVALID");
  if (typeof raw.incarnation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(raw.incarnation)) shadowInvalid("SHADOW_STATE_INVALID");
  return Object.freeze({projectId:shadowId(raw.projectId),releaseId:shadowId(raw.releaseId),generation:shadowInteger(raw.generation),fence:shadowInteger(raw.fence),incarnation:raw.incarnation});
};
const shadowBoundedJson = (value: unknown, maximum: number): string => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength>maximum) shadowInvalid("SHADOW_STATE_INVALID");
  return serialized;
};

/** @internal Exact provider identity; the checkpoint digest never substitutes for this source capsule. */
export function shadowCandidateProjectId(operation: Pick<ShadowOperation,"primary"|"controllerEpoch"|"operationId"|"capsuleSha256">, hash: (value:string)=>string): string {
  if (!operation.primary || !operation.capsuleSha256) shadowInvalid("SHADOW_STATE_INVALID");
  return `canary_${shadowDigest(hash([operation.primary.projectId,operation.primary.incarnation,operation.controllerEpoch,operation.operationId,operation.capsuleSha256].join("\n")))}`;
}

/** @internal Strict retained union member; no reconstruction from damaged or partial state. */
export function normalizeShadowOperation(value: unknown, projectId: string, epoch: number, hash: (value:string)=>string): ShadowOperation {
  const code="SHADOW_STATE_INVALID",raw=closedShadowObject(value,["kind","sessionId","operationId","idempotencyKeyDigest","inputDigest","reviewDigest","releaseId","artifactSha256","capsuleSha256",
    "controllerEpoch","retirementEpoch","primary","primaryReleaseId","primaryFence","nodeId","origin","credentialGeneration","policyRevision","policyDigest","policy","maxReports",
    "phase","outcome","stopRequested","snapshot","report","reservations","retirement","createdAt","expiresAt","updatedAt"],code);
  shadowBoundedJson(raw,64*1024);shadowId(projectId);shadowInteger(epoch);
  for(const key of ["sessionId","operationId","releaseId","primaryReleaseId","nodeId"])shadowId(raw[key]);
  for(const key of ["idempotencyKeyDigest","inputDigest","reviewDigest","artifactSha256","policyDigest"])shadowDigest(raw[key]);
  for(const key of ["controllerEpoch","retirementEpoch","primaryFence","credentialGeneration","policyRevision","createdAt","expiresAt","updatedAt"])shadowInteger(raw[key]);
  if(raw.capsuleSha256!==null)shadowDigest(raw.capsuleSha256);
  const policyInput=closedShadowObject(raw.policy,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],code);
  const policy=narrowShadowPolicy({revision:1,readPaths:shadowReads(policyInput.readPaths,false),methods:shadowReads(policyInput.methods,true) as readonly ("GET"|"HEAD")[],
    maxSamplePercent:100,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100},policyInput);
  if(JSON.stringify(policy)!==JSON.stringify(raw.policy))shadowInvalid(code);
  const primary=raw.primary===null?null:shadowBinding(raw.primary),report=normalizeShadowReport(raw.report,policy.maxAttempts);
  let snapshot:ShadowCheckpoint|null=null;
  if(raw.snapshot!==null){
    const value=closedShadowObject(raw.snapshot,["sha256","bytes","providerStartedAt","providerCompletedAt","platformObservedAt"],code);
    snapshot=Object.freeze({sha256:shadowDigest(value.sha256),bytes:shadowInteger(value.bytes,2*1024*1024*1024-2*1024*1024-100*1024*1024-32),
      providerStartedAt:shadowInteger(value.providerStartedAt),providerCompletedAt:shadowInteger(value.providerCompletedAt),platformObservedAt:shadowInteger(value.platformObservedAt)});
    if(snapshot.providerCompletedAt<snapshot.providerStartedAt || snapshot.platformObservedAt<Number(raw.createdAt) || snapshot.platformObservedAt>Number(raw.updatedAt))shadowInvalid(code);
  }
  if(!Array.isArray(raw.reservations) || raw.reservations.length>policy.maxConcurrent)shadowInvalid(code);
  const reservations=Object.freeze(raw.reservations.map(value=>shadowInteger(value,policy.maxAttempts)));
  if(reservations.some((value,index)=>value>report.counters.reserved || index>0 && value<=reservations[index-1])
    || report.counters.reserved-report.counters.settled!==reservations.length)shadowInvalid(code);
  if(raw.kind!=="shadow" || Number(raw.controllerEpoch)!==Number(raw.retirementEpoch) || Number(raw.controllerEpoch)>epoch
    || typeof raw.stopRequested!=="boolean" || !["binding","preparing","observing","retiring","retired","complete"].includes(String(raw.phase))
    || raw.outcome!==null && !shadowOutcomes.includes(raw.outcome as ShadowOutcome) || raw.releaseId===raw.primaryReleaseId
    || Number(raw.createdAt)>Number(raw.updatedAt) || Number(raw.expiresAt)!==Number(raw.createdAt)+policy.durationMs
    || typeof raw.origin!=="string" || raw.origin.length>2048)shadowInvalid(code);
  const origin=new URL(raw.origin);
  if(!["http:","https:"].includes(origin.protocol) || origin.origin!==raw.origin || origin.username || origin.password)shadowInvalid(code);
  if(primary && (primary.projectId!==projectId || primary.releaseId!==raw.primaryReleaseId || primary.generation!==raw.credentialGeneration || primary.fence!==raw.primaryFence))shadowInvalid(code);
  const operation={...raw,primary,policy,maxReports:shadowInteger(raw.maxReports,100),snapshot,report,reservations} as unknown as ShadowOperation;
  let retirement:DeploymentProviderCanaryRetirement|null=null;
  if(raw.retirement!==null){
    const value=closedShadowObject(raw.retirement,["protocol","primary","operationId","controllerEpoch","releaseId","capsuleSha256","candidateProjectId","retirementEpoch","phase"],code);
    const bound=shadowBinding(value.primary);
    if(!primary || JSON.stringify(bound)!==JSON.stringify(primary) || value.protocol!=="clank-provider-canary-retirement/1" || value.phase!=="retired"
      || value.operationId!==operation.operationId || value.controllerEpoch!==operation.controllerEpoch || value.releaseId!==operation.releaseId
      || value.capsuleSha256!==operation.capsuleSha256 || value.retirementEpoch!==operation.retirementEpoch || value.candidateProjectId!==shadowCandidateProjectId(operation,hash))shadowInvalid(code);
    retirement=Object.freeze({...value,primary:bound}) as unknown as DeploymentProviderCanaryRetirement;
  }
  if(!["binding","complete"].includes(operation.phase) && (!primary || !operation.capsuleSha256)
    || operation.phase==="binding" && (primary!==null || snapshot!==null || retirement!==null || operation.outcome!==null || report.counters.reserved!==0 || report.protocol===2 && Object.values(report.skips).some(value=>value!==0))
    || ["preparing","observing"].includes(operation.phase) && (operation.outcome!==null || retirement!==null)
    || operation.phase==="observing" && snapshot===null
    || ["retiring","retired","complete"].includes(operation.phase) && operation.outcome===null
    || operation.phase==="retiring" && retirement!==null
    || operation.phase==="retired" && retirement===null
    || operation.phase==="complete" && primary!==null && retirement===null
    || ["retired","complete"].includes(operation.phase) && reservations.length!==0
    || primary===null && (snapshot!==null || retirement!==null || report.counters.reserved!==0))shadowInvalid(code);
  return Object.freeze({...operation,retirement});
}

export function readShadowRecord(row: Record<string,unknown>, projectId:string, hash:(value:string)=>string): ShadowRecord {
  if(row.project_id!==projectId || row.protocol!==2 || typeof row.operation!=="string" || new TextEncoder().encode(row.operation).byteLength>64*1024)shadowInvalid("SHADOW_STATE_INVALID");
  const epoch=shadowInteger(row.epoch),operation=normalizeShadowOperation(JSON.parse(row.operation),projectId,epoch,hash);
  if(operation.updatedAt!==row.updated_at || JSON.stringify(operation)!==row.operation)shadowInvalid("SHADOW_STATE_INVALID");
  return Object.freeze({protocol:2,epoch,operation,serialized:row.operation});
}

/** @internal Compact replay identity survives aggregate pruning; no live credential or observation is retained. */
export interface ShadowReplayIdentity {
  readonly projectId: string; readonly sessionId: string; readonly operationId: string; readonly controllerEpoch: number; readonly epoch: number;
  readonly idempotencyKeyDigest: string; readonly inputDigest: string; readonly reviewDigest: string;
  readonly releaseId: string; readonly artifactSha256: string; readonly capsuleSha256: string | null;
  readonly primary: DeploymentProviderCanaryBinding | null; readonly primaryReleaseId: string; readonly primaryGeneration: number;
  readonly policyRevision: number; readonly policyDigest: string; readonly policy: ShadowSessionPolicy;
  readonly phase: "binding" | "complete"; readonly outcome: ShadowOutcome | null; readonly stopRequested: boolean;
  readonly snapshot: ShadowCheckpoint | null; readonly createdAt: number; readonly expiresAt: number; readonly updatedAt: number;
}
export interface ShadowReplayReceipt {
  readonly protocol: 1; readonly identity: ShadowReplayIdentity; readonly reportDigest: string;
}
export interface ShadowReplay { readonly receipt: ShadowReplayReceipt; readonly report: ShadowReport | null; }
type ShadowHash = (value: string) => string;
type ShadowRead = Pick<SQLiteInternal,"prepare">;
const replayFields = ["projectId","sessionId","operationId","controllerEpoch","epoch","idempotencyKeyDigest","inputDigest","reviewDigest","releaseId","artifactSha256","capsuleSha256",
  "primary","primaryReleaseId","primaryGeneration","policyRevision","policyDigest","policy","phase","outcome","stopRequested","snapshot","createdAt","expiresAt","updatedAt"];

function replayIdentity(projectId: string, record: ShadowRecord): ShadowReplayIdentity {
  const op=record.operation;
  if(op.phase!=="binding" && op.phase!=="complete")shadowInvalid("SHADOW_STATE_INVALID");
  return Object.freeze({projectId,sessionId:op.sessionId,operationId:op.operationId,controllerEpoch:op.controllerEpoch,epoch:record.epoch,
    idempotencyKeyDigest:op.idempotencyKeyDigest,inputDigest:op.inputDigest,reviewDigest:op.reviewDigest,releaseId:op.releaseId,artifactSha256:op.artifactSha256,capsuleSha256:op.capsuleSha256,
    primary:op.primary,primaryReleaseId:op.primaryReleaseId,primaryGeneration:op.credentialGeneration,policyRevision:op.policyRevision,policyDigest:op.policyDigest,policy:op.policy,
    phase:op.phase,outcome:op.outcome,stopRequested:op.stopRequested,snapshot:op.snapshot,createdAt:op.createdAt,expiresAt:op.expiresAt,updatedAt:op.updatedAt});
}
function normalizeReplayIdentity(value: unknown, projectId: string): ShadowReplayIdentity {
  const code="SHADOW_STATE_INVALID",raw=closedShadowObject(value,replayFields,code);
  if(raw.projectId!==projectId)shadowInvalid(code);
  for(const key of ["projectId","sessionId","operationId","releaseId","primaryReleaseId"])shadowId(raw[key]);
  for(const key of ["idempotencyKeyDigest","inputDigest","reviewDigest","artifactSha256","policyDigest"])shadowDigest(raw[key]);
  if(raw.capsuleSha256!==null)shadowDigest(raw.capsuleSha256);
  for(const key of ["controllerEpoch","epoch","primaryGeneration","policyRevision","createdAt","expiresAt","updatedAt"])shadowInteger(raw[key]);
  const policyInput=closedShadowObject(raw.policy,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],code);
  const policy=narrowShadowPolicy({revision:1,readPaths:shadowReads(policyInput.readPaths,false),methods:shadowReads(policyInput.methods,true) as readonly ("GET"|"HEAD")[],
    maxSamplePercent:100,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100},policyInput);
  const primary=raw.primary===null?null:shadowBinding(raw.primary);
  let snapshot:ShadowCheckpoint|null=null;
  if(raw.snapshot!==null){const input=closedShadowObject(raw.snapshot,["sha256","bytes","providerStartedAt","providerCompletedAt","platformObservedAt"],code);
    snapshot=Object.freeze({sha256:shadowDigest(input.sha256),bytes:shadowInteger(input.bytes,2*1024*1024*1024-2*1024*1024-100*1024*1024-32),
      providerStartedAt:shadowInteger(input.providerStartedAt),providerCompletedAt:shadowInteger(input.providerCompletedAt),platformObservedAt:shadowInteger(input.platformObservedAt)});
    if(snapshot.providerCompletedAt<snapshot.providerStartedAt || snapshot.platformObservedAt<Number(raw.createdAt) || snapshot.platformObservedAt>Number(raw.updatedAt))shadowInvalid(code);}
  if(Number(raw.controllerEpoch)>Number(raw.epoch) || raw.releaseId===raw.primaryReleaseId || Number(raw.createdAt)>Number(raw.updatedAt)
    || Number(raw.expiresAt)!==Number(raw.createdAt)+policy.durationMs || JSON.stringify(policy)!==JSON.stringify(raw.policy)
    || typeof raw.stopRequested!=="boolean" || !["binding","complete"].includes(String(raw.phase))
    || raw.phase==="binding" && (raw.outcome!==null || primary!==null || snapshot!==null || raw.capsuleSha256!==null || raw.controllerEpoch!==raw.epoch || raw.createdAt!==raw.updatedAt || raw.stopRequested!==false)
    || raw.phase==="complete" && !shadowOutcomes.includes(raw.outcome as ShadowOutcome)
    || primary===null && snapshot!==null || primary!==null && (raw.capsuleSha256===null || primary.projectId!==projectId || primary.releaseId!==raw.primaryReleaseId || primary.generation!==raw.primaryGeneration))shadowInvalid(code);
  return Object.freeze({...raw,policy,primary,snapshot}) as unknown as ShadowReplayIdentity;
}
function reportDigest(identity: ShadowReplayIdentity, report: ShadowReport, hash: ShadowHash): string {
  return shadowDigest(hash(shadowBoundedJson({identity,report},32*1024)));
}
function decodeReplay(row: Record<string,unknown>, projectId: string, hash: ShadowHash): ShadowReplay {
  const code="SHADOW_STATE_INVALID";
  if(typeof row.receipt_json!=="string" || new TextEncoder().encode(row.receipt_json).byteLength>16*1024)shadowInvalid(code);
  const raw=closedShadowObject(JSON.parse(row.receipt_json),["protocol","identity","reportDigest"],code),identity=normalizeReplayIdentity(raw.identity,projectId);
  const receipt=Object.freeze({protocol:1 as const,identity,reportDigest:shadowDigest(raw.reportDigest)});
  if(raw.protocol!==1 || JSON.stringify(receipt)!==row.receipt_json || row.project_id!==projectId || row.session_id!==identity.sessionId
    || row.idempotency_key_digest!==identity.idempotencyKeyDigest || row.input_digest!==identity.inputDigest)shadowInvalid(code);
  let report:ShadowReport|null=null;
  if(row.report_json!==null){
    if(typeof row.report_json!=="string" || new TextEncoder().encode(row.report_json).byteLength>32*1024)shadowInvalid(code);
    report=normalizeShadowReport(JSON.parse(row.report_json),identity.policy.maxAttempts);
    if(JSON.stringify(report)!==row.report_json || reportDigest(identity,report,hash)!==receipt.reportDigest)shadowInvalid(code);
  } else if(identity.phase!=="complete")shadowInvalid(code);
  if(report && (identity.phase==="binding" ? report.counters.reserved!==0 || report.protocol===2 && Object.values(report.skips).some(value=>value!==0) : report.counters.reserved!==report.counters.settled))shadowInvalid(code);
  return Object.freeze({receipt,report});
}
function replayMirror(rows: readonly ShadowReplay[], hash: ShadowHash): string {
  return JSON.stringify({protocol:1,count:rows.length,sha256:shadowDigest(hash(JSON.stringify(rows.map(row=>row.receipt))))});
}
/** @internal Bounded full-history check at admission, completion and recovery, not per observed response. */
export function readShadowReplays(connection: ShadowRead, projectId: string, hash: ShadowHash): readonly ShadowReplay[] {
  shadowId(projectId);
  const raw=connection.prepare("SELECT * FROM clank_platform_shadow_reports WHERE project_id=? ORDER BY session_id LIMIT 1025").all(projectId);
  if(raw.length>1024)shadowInvalid("SHADOW_STATE_INVALID");
  const rows=Object.freeze(raw.map(row=>decodeReplay(row,projectId,hash)));
  const versioned=rows.find(row=>row.report?.protocol===2);if(versioned?.report)assertShadowReportSchema(connection,versioned.report);
  const project=connection.prepare("SELECT shadow_replay_receipt FROM clank_platform_projects WHERE id=?").get(projectId);
  if(rows.filter(row=>row.receipt.identity.phase==="binding").length>1 || rows.filter(row=>row.receipt.identity.phase==="complete" && row.report!==null).length>100)shadowInvalid("SHADOW_STATE_INVALID");
  if(!project || project.shadow_replay_receipt!==replayMirror(rows,hash) && !(rows.length===0 && project.shadow_replay_receipt===null))shadowInvalid("SHADOW_STATE_INVALID");
  return rows;
}
/** @internal Invoke only inside the platform's guarded native transaction, alongside its shared journal CAS. */
export function writeShadowReplay(connection: SQLiteInternal, projectId: string, record: ShadowRecord, previous: readonly ShadowReplay[], hash: ShadowHash): void {
  if(!connection.inTransaction)shadowInvalid("SHADOW_STATE_INVALID");
  const identity=replayIdentity(projectId,record),report=record.operation.report;assertShadowReportSchema(connection,report);
  const receipt=Object.freeze({protocol:1 as const,identity,reportDigest:reportDigest(identity,report,hash)}),serialized=shadowBoundedJson(receipt,16*1024);
  const existing=previous.find(row=>row.receipt.identity.sessionId===identity.sessionId);
  if(existing){
    const prior=existing.receipt.identity;
    if(prior.phase!=="binding" || identity.phase!=="complete" || prior.idempotencyKeyDigest!==identity.idempotencyKeyDigest || prior.inputDigest!==identity.inputDigest
      || prior.reviewDigest!==identity.reviewDigest || prior.controllerEpoch!==identity.controllerEpoch || prior.operationId!==identity.operationId
      || prior.releaseId!==identity.releaseId || prior.artifactSha256!==identity.artifactSha256 || prior.primaryReleaseId!==identity.primaryReleaseId
      || prior.primaryGeneration!==identity.primaryGeneration || prior.policyRevision!==identity.policyRevision || prior.policyDigest!==identity.policyDigest
      || JSON.stringify(prior.policy)!==JSON.stringify(identity.policy) || prior.createdAt!==identity.createdAt || prior.expiresAt!==identity.expiresAt)shadowInvalid("SHADOW_STATE_INVALID");
  } else if(previous.length>=1024 || identity.phase!=="binding" || previous.some(row=>row.receipt.identity.idempotencyKeyDigest===identity.idempotencyKeyDigest))shadowInvalid("SHADOW_STATE_INVALID");
  const changed=existing
    ? connection.prepare("UPDATE clank_platform_shadow_reports SET receipt_json=?,report_json=? WHERE project_id=? AND session_id=? AND receipt_json=?").run(serialized,JSON.stringify(report),projectId,identity.sessionId,JSON.stringify(existing.receipt))
    : connection.prepare("INSERT INTO clank_platform_shadow_reports VALUES(?,?,?,?,?,?)").run(projectId,identity.sessionId,identity.idempotencyKeyDigest,identity.inputDigest,serialized,JSON.stringify(report));
  if(Number(changed.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
  const expected=[...previous.filter(row=>row!==existing),Object.freeze({receipt,report})];
  // SQLite BINARY order is code-point order, independent of the host locale.
  expected.sort((a,b)=>a.receipt.identity.sessionId<b.receipt.identity.sessionId?-1:a.receipt.identity.sessionId>b.receipt.identity.sessionId?1:0);
  const old=previous.length?replayMirror(previous,hash):connection.prepare("SELECT shadow_replay_receipt FROM clank_platform_projects WHERE id=?").get(projectId)?.shadow_replay_receipt;
  const mirror=replayMirror(expected,hash),marked=connection.prepare("UPDATE clank_platform_projects SET shadow_replay_receipt=? WHERE id=? AND shadow_replay_receipt IS ?").run(mirror,projectId,old);
  if(Number(marked.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
  const prunedSessions=new Set<string>();
  if(identity.phase==="complete"){
    const resolved=expected.filter(row=>row.receipt.identity.phase==="complete" && row.report!==null && row.receipt.identity.sessionId!==identity.sessionId).sort((a,b)=>a.receipt.identity.updatedAt-b.receipt.identity.updatedAt || (a.receipt.identity.sessionId<b.receipt.identity.sessionId?-1:1));
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

export interface ShadowPriorRecord { readonly epoch: number; readonly serialized: string; }
function sameReplayAdmission(identity: ShadowReplayIdentity, operation: ShadowOperation): boolean {
  return identity.sessionId===operation.sessionId && identity.operationId===operation.operationId && identity.controllerEpoch===operation.controllerEpoch
    && identity.idempotencyKeyDigest===operation.idempotencyKeyDigest && identity.inputDigest===operation.inputDigest && identity.reviewDigest===operation.reviewDigest
    && identity.releaseId===operation.releaseId && identity.artifactSha256===operation.artifactSha256 && identity.primaryReleaseId===operation.primaryReleaseId
    && identity.primaryGeneration===operation.credentialGeneration && identity.policyRevision===operation.policyRevision && identity.policyDigest===operation.policyDigest
    && JSON.stringify(identity.policy)===JSON.stringify(operation.policy) && identity.createdAt===operation.createdAt && identity.expiresAt===operation.expiresAt;
}
/** @internal A selected current operation must retain its admission fence even between report writes. */
export function assertShadowReplay(connection: ShadowRead, projectId: string, record: ShadowRecord, hash: ShadowHash): void {
  const row=connection.prepare("SELECT * FROM clank_platform_shadow_reports WHERE project_id=? AND session_id=?").get(projectId,record.operation.sessionId);
  if(!row)shadowInvalid("SHADOW_STATE_INVALID");
  const replay=decodeReplay(row,projectId,hash);assertShadowReportSchema(connection,record.operation.report);if(replay.report)assertShadowReportSchema(connection,replay.report);
  if(replay.report && replay.report.protocol!==record.operation.report.protocol || !sameReplayAdmission(replay.receipt.identity,record.operation)
    || record.operation.phase==="complete" && JSON.stringify(replay.receipt.identity)!==JSON.stringify(replayIdentity(projectId,record))
    || record.operation.phase!=="complete" && replay.receipt.identity.phase!=="binding")shadowInvalid("SHADOW_STATE_INVALID");
}
/** @internal The platform supplies its actual guarded connection and lease; no secondary catalog or lease is opened. */
export function saveShadowRecord(connection: SQLiteInternal, projectId: string, prior: ShadowPriorRecord|null, operation: ShadowOperation, current:()=>void, hash:ShadowHash): ShadowRecord {
  const epoch=shadowInteger((prior?.epoch??0)+1),serialized=JSON.stringify(operation);
  const record=readShadowRecord({project_id:projectId,protocol:2,epoch,operation:serialized,updated_at:operation.updatedAt},projectId,hash);
  const write=()=>{
    current();assertShadowReportSchema(connection,record.operation.report);
    const before=connection.prepare("SELECT * FROM clank_platform_provider_canaries WHERE project_id=?").get(projectId);
    const project=connection.prepare("SELECT provider_canary_epoch FROM clank_platform_projects WHERE id=?").get(projectId);
    if(!project || project.provider_canary_epoch!==(prior?.epoch??0) || (prior ? !before || before.epoch!==prior.epoch || before.operation!==prior.serialized : Boolean(before)))shadowInvalid("SHADOW_STATE_INVALID");
    const admission=operation.phase==="binding" && (!before || before.protocol!==2 || JSON.parse(String(before.operation)).sessionId!==operation.sessionId);
    const previous=admission || operation.phase==="complete" ? readShadowReplays(connection,projectId,hash) : null;
    if(admission && (operation.controllerEpoch!==epoch || operation.capsuleSha256!==null || operation.stopRequested || operation.createdAt!==operation.updatedAt))shadowInvalid("SHADOW_STATE_INVALID");
    if(admission && Number(connection.prepare("SELECT count(*) AS total FROM clank_platform_provider_canaries WHERE protocol=2 AND json_extract(operation,'$.phase')<>'complete'").get()?.total)>=16)shadowInvalid("SHADOW_CAPACITY");
    if(before?.protocol===2){const old=readShadowRecord(before,projectId,hash);assertShadowReplay(connection,projectId,old,hash);
      if(old.operation.phase!=="complete"){
        const op=old.operation,beforeSkips=op.report.skips,afterSkips=operation.report.skips,allowed:Record<ShadowPhase,readonly ShadowPhase[]>={binding:["binding","preparing","complete"],preparing:["preparing","observing","retiring"],observing:["observing","retiring"],retiring:["retiring","retired"],retired:["complete"],complete:[]};
        if(op.sessionId!==operation.sessionId || op.controllerEpoch!==operation.controllerEpoch || !allowed[op.phase].includes(operation.phase)
          || op.report.protocol!==operation.report.protocol || beforeSkips && afterSkips && shadowSkipReasons.some(reason=>afterSkips[reason]<beforeSkips[reason])
          || operation.updatedAt<op.updatedAt || op.stopRequested && !operation.stopRequested || operation.report.counters.reserved<op.report.counters.reserved || operation.report.counters.settled<op.report.counters.settled
          || op.capsuleSha256!==null && operation.capsuleSha256!==op.capsuleSha256 || op.primary!==null && JSON.stringify(op.primary)!==JSON.stringify(operation.primary)
          || op.snapshot!==null && JSON.stringify(op.snapshot)!==JSON.stringify(operation.snapshot) || op.retirement!==null && JSON.stringify(op.retirement)!==JSON.stringify(operation.retirement)
          || op.outcome!==null && operation.outcome!==op.outcome)shadowInvalid("SHADOW_STATE_INVALID");
      } else if(!admission)shadowInvalid("SHADOW_STATE_INVALID");
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

export interface ShadowLifecycleAdapter {
  read(projectId:string):ShadowRecord|null;
  save(projectId:string,prior:ShadowRecord,operation:ShadowOperation,current:()=>void):ShadowRecord;
  retire(projectId:string,record:ShadowRecord,current:()=>void):Promise<DeploymentProviderCanaryRetirement>;
}
function shadowCurrent(adapter:ShadowLifecycleAdapter,projectId:string,record:ShadowRecord,current:()=>void):void {
  current();const actual=adapter.read(projectId);
  if(!actual || actual.epoch!==record.epoch || actual.serialized!==record.serialized)shadowInvalid("SHADOW_SUPERSEDED");
}
function interruptedShadowReport(operation:ShadowOperation):ShadowReport {
  const count=operation.reservations.length,report=operation.report;
  return normalizeShadowReport({...report,counters:{...report.counters,settled:report.counters.settled+count,unknown:{...report.counters.unknown,interrupted:report.counters.unknown.interrupted+count}},
    latency:{primary:{...report.latency.primary,unknown:report.latency.primary.unknown+count},candidate:{...report.latency.candidate,unknown:report.latency.candidate.unknown+count}}},operation.policy.maxAttempts);
}
/** @internal Shared by the live owner and real platform startup, including policy-disabled recovery. */
export async function retireShadow(adapter:ShadowLifecycleAdapter,projectId:string,input:ShadowRecord,current:()=>void,outcome:ShadowOutcome):Promise<ShadowRecord> {
  let record=input;
  const guard=()=>shadowCurrent(adapter,projectId,record,current),save=(operation:ShadowOperation)=>{guard();record=adapter.save(projectId,record,operation,current);guard();};
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

/** @internal Ephemeral provider capability; never serialize this object or its credential-bearing closure. */
export interface ShadowObservationCapability {
  readonly primary: Readonly<IngressRoute>;
  request(exact: Readonly<ExactRequest>, signal: AbortSignal, current:()=>void): Promise<Response>;
}
export interface ShadowCandidateTarget {
  readonly origin:string; readonly projectId:string; readonly path:string; readonly token:string;
  readonly protocol:string; readonly generation:1; readonly readPaths:readonly string[]; readonly methods:readonly ("GET"|"HEAD")[];
}
/** @internal Only the verified provider prepare result constructs this private target. */
export function createShadowCandidateRequest(input:Readonly<ShadowCandidateTarget>):ShadowObservationCapability["request"] {
  const target=Object.freeze({...input,readPaths:Object.freeze([...input.readPaths]),methods:Object.freeze([...input.methods])});
  return async (exact,signal,guard)=>{
    guard();
    if(!target.methods.includes(exact.method)||!target.readPaths.includes(exact.path)||exact.accept!==null&&(exact.accept.length>512||/[^\x20-\x7e]/u.test(exact.accept)))throw new Error("The exact shadow request is ineligible.");
    const url=new URL(target.origin);url.pathname=target.path+exact.path;
    const headers=new Headers({"accept-encoding":"identity","cache-control":"no-store","x-clank-project-id":target.projectId,"x-clank-runtime-protocol":target.protocol,
      "x-clank-runtime-generation":String(target.generation),"x-clank-runtime-ingress":target.token});
    if(exact.accept!==null)headers.set("accept",exact.accept);
    guard();const response=await fetch(url.href,{method:exact.method,headers,signal,redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});
    try{guard();if(response.redirected||response.url!==url.href)throw new Error("The shadow candidate response changed origin or path.");return response;}
    catch(error){await response.body?.cancel().catch(()=>undefined);throw error;}
  };
}
export interface ShadowPreparedObservation { readonly snapshot: ShadowCheckpoint; readonly observation?: ShadowObservationCapability; }
interface ShadowObservationFacts { complete: boolean; bytes: number; elapsed: number|null; statusClass: number|null; mediaType: string|null; }
function shadowObservationMedia(value:string|null):string|null {
  if(!value || value.length>1024)return null;
  const type=value.split(';',1)[0]!.trim().toLowerCase();
  return type.length<=255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type)?type:null;
}
function settleShadowObservation(report:ShadowReport,reason:ShadowUnknownReason|null,primary:ShadowObservationFacts,candidate:ShadowObservationFacts,maximum:number):ShadowReport {
  const comparable=reason===null,both=primary.complete&&candidate.complete;
  const latency=(before:ShadowLatency,facts:ShadowObservationFacts):ShadowLatency=>({cumulative:before.cumulative.map((count,index)=>count+(facts.complete&&facts.elapsed!==null&&facts.elapsed<=shadowLatencyBuckets[index]! ?1:0)),
    overflow:before.overflow+(facts.complete&&facts.elapsed!==null&&facts.elapsed>10000?1:0),unknown:before.unknown+(!facts.complete||facts.elapsed===null?1:0)});
  return normalizeShadowReport({...report,counters:{...report.counters,settled:report.counters.settled+1,comparable:report.counters.comparable+(comparable?1:0),bothComplete:report.counters.bothComplete+(both?1:0),
    statusClassEqual:report.counters.statusClassEqual+(comparable&&primary.statusClass===candidate.statusClass?1:0),statusClassDifferent:report.counters.statusClassDifferent+(comparable&&primary.statusClass!==candidate.statusClass?1:0),
    mediaTypeEqual:report.counters.mediaTypeEqual+(comparable&&primary.mediaType===candidate.mediaType?1:0),mediaTypeDifferent:report.counters.mediaTypeDifferent+(comparable&&primary.mediaType!==candidate.mediaType?1:0),
    unknown:{...report.counters.unknown,...(reason?{[reason]:report.counters.unknown[reason]+1}:{})}},latency:{primary:latency(report.latency.primary,primary),candidate:latency(report.latency.candidate,candidate)}},maximum);
}
/** state() reads the owned memory snapshot; native guards, mutations and scopes run only in detached tasks. */
function shadowObservationOwner(options:{
  capability:ShadowObservationCapability; global:Set<object>; initial:ShadowRecord; deadline:number;
  state:()=>ShadowRecord; live:()=>void; verify:()=>void; current:()=>void;
  change:(update:(operation:ShadowOperation)=>ShadowOperation,current:()=>void)=>void;
  scope:<Value>(current:()=>void,work:()=>Promise<Value>)=>Promise<Value>;
  stop:(reason:ShadowOutcome)=>void; error:(error:unknown)=>void;
}) {
  const policy=options.initial.operation.policy,identity=options.initial.operation,capability=options.capability;
  const primaryRoute=capability.primary,submit=capability.request;
  const schedule=process.getBuiltinModule('node:timers').setImmediate;
  const pairs=new Set<{deadline:number;cancel:()=>void;flight:Promise<void>}>();
  let accepting=true,ended=false,flushTimer:ReturnType<typeof setTimeout>|undefined,flushing=false;
  let pending=Object.fromEntries(shadowSkipReasons.map(key=>[key,0])) as Record<ShadowSkipReason,number>;
  const native=()=>{if(ended)throw new Error('Shadow observation owner ended.');options.current();const record=options.state();if(record.operation.sessionId!==identity.sessionId||record.operation.operationId!==identity.operationId||record.operation.controllerEpoch!==identity.controllerEpoch||record.operation.phase!=='observing')shadowInvalid('SHADOW_SUPERSEDED');};
  const live=()=>{native();options.live();options.verify();};
  const flush=()=>{
    native();if(!Object.values(pending).some(Boolean))return;
    const captured=pending;
    options.change(op=>({...op,report:addShadowSkips(op.report as ShadowReportV2,captured,policy.maxAttempts),updatedAt:Math.max(Date.now(),op.updatedAt)}),native);
    pending=Object.fromEntries(shadowSkipReasons.map(key=>[key,pending[key]-captured[key]])) as Record<ShadowSkipReason,number>;
  };
  const queueFlush=()=>{
    if(ended||flushTimer||flushing)return;
    flushTimer=setTimeout(()=>{flushTimer=undefined;if(ended)return;flushing=true;schedule(()=>{void options.scope(options.current,async()=>{if(!ended)flush();}).catch(error=>{options.error(error);options.stop('provider-error');}).finally(()=>{flushing=false;if(!ended&&Object.values(pending).some(Boolean))queueFlush();});});},100);
  };
  const skip=(reason:ShadowSkipReason)=>{if(ended)return;pending[reason]=Math.min(shadowSkipMaximum,pending[reason]+1);queueFlush();};
  const sameRoute=(route:Readonly<IngressRoute>)=>route.active && route.id===primaryRoute.id && route.projectId===primaryRoute.projectId && route.releaseId===primaryRoute.releaseId && route.upstream===primaryRoute.upstream
    && route.runtime?.protocol===primaryRoute.runtime?.protocol && route.runtime?.generation===primaryRoute.runtime?.generation && route.runtime?.path===primaryRoute.runtime?.path && route.runtime?.token===primaryRoute.runtime?.token;
  return {
    observe(request:Request,route:Readonly<IngressRoute>,metadata:Readonly<IngressShadowMetadata>):IngressShadowTap|undefined {
      if(!accepting||ended)return undefined;
      const exact=exactRequest(request);if(!exact)return undefined;
      if(!sameRoute(route)||!policy.methods.includes(exact.method)||!policy.readPaths.includes(exact.path)){skip('ineligible');return undefined;}
      // The controller owns and updates this in-memory snapshot, without a native read.
      if(options.state().operation.report.counters.reserved>=policy.maxAttempts){skip('attempt-limit');return undefined;}
      if(Math.random()*100>=policy.samplePercent){skip('sampled-out');return undefined;}
      if(pairs.size>=policy.maxConcurrent||options.global.size>=16){skip('capacity');return undefined;}
      const admitted=performance.now(),deadline=Math.min(admitted+policy.requestMs,options.deadline,admitted+Math.max(0,identity.expiresAt-Date.now()));
      if(deadline<=admitted){skip('withdrawn');return undefined;}
      const primary:ShadowObservationFacts={complete:false,bytes:0,elapsed:null,statusClass:metadata.statusClass,mediaType:metadata.mediaType};
      const candidate:ShadowObservationFacts={complete:false,bytes:0,elapsed:null,statusClass:null,mediaType:null};
      const abort=new AbortController();let ordinal:number|null=null,handed=false,submitted=false,finished=false,timedOut=false,reason:ShadowUnknownReason|null|undefined,wake:(()=>void)|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,received:Response|undefined;
      let cancelHandoff:(()=>void)|undefined,resolveFlight!:()=>void;
      const pair={deadline,cancel:()=>terminal('cancelled'),flight:new Promise<void>(resolve=>{resolveFlight=resolve;})};pairs.add(pair);options.global.add(pair);
      const notify=()=>{const ready=wake;wake=undefined;ready?.();};
      const terminal=(value:ShadowUnknownReason|null)=>{if(reason!==undefined||finished)return;reason=value;if(value!==null)abort.abort();notify();if(!handed)start();};
      const completed=()=>{if(primary.complete&&candidate.complete)terminal(primary.mediaType&&candidate.mediaType&&primary.statusClass&&candidate.statusClass?null:'content-type-invalid');};
      const timeout=()=>{const remaining=deadline-performance.now();if(remaining>0){timer=setTimeout(timeout,Math.ceil(remaining));return;}timedOut=true;terminal(ordinal===null?'not-submitted':!submitted?'not-submitted':candidate.complete?'primary-incomplete':'candidate-timeout');};
      let timer=setTimeout(timeout,Math.max(0,Math.ceil(deadline-performance.now())));
      const onAbort=()=>{if(!primary.complete)terminal('primary-incomplete');};request.signal.addEventListener('abort',onAbort,{once:true});
      const cleanup=()=>{finished=true;clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);cancelHandoff?.();pairs.delete(pair);options.global.delete(pair);resolveFlight();};
      const guard=()=>{native();options.live();if(exactRequest(request)!==exact){terminal('cancelled');throw new Error('The native request proof changed.');}if(performance.now()>=deadline||Date.now()>=identity.expiresAt){timeout();throw new Error('Shadow pair deadline expired.');}if(reason!==undefined&&reason!==null)throw new Error('Shadow pair was cancelled.');};
      const check=()=>{guard();options.verify();};
      let started=false;
      const start=()=>{if(started||finished)return;started=true;schedule(()=>{void options.scope(options.current,async()=>{
        try{
          if(!handed||reason!==undefined){skip(!handed&&timedOut?'handoff-timeout':'withdrawn');return;}
          check();const current=options.state();
          if(current.operation.report.counters.reserved>=policy.maxAttempts){skip('attempt-limit');options.stop('attempt-limit');return;}
          const allocated=current.operation.report.counters.reserved+1;
          options.change(op=>({...op,reservations:[...op.reservations,allocated],report:normalizeShadowReport({...op.report,counters:{...op.report.counters,reserved:allocated}},policy.maxAttempts),updatedAt:Math.max(Date.now(),op.updatedAt)}),guard);ordinal=allocated;
          check();submitted=true;const submittedAt=performance.now();
          const response=received=await submit.call(capability,exact,abort.signal,check);check();
          candidate.statusClass=Math.floor(response.status/100);candidate.mediaType=shadowObservationMedia(response.headers.get('content-type'));
          if(response.redirected||response.headers.has('content-encoding'))throw new Error('Shadow candidate transport differs.');
          if(!response.body||exact.method==='HEAD'||response.status===204||response.status===304){candidate.complete=true;candidate.elapsed=Math.max(0,performance.now()-submittedAt);if(response.body)await response.body.cancel();check();}
          else{reader=response.body.getReader();while(true){check();const next=await reader.read();check();if(next.done){candidate.complete=true;candidate.elapsed=Math.max(0,performance.now()-submittedAt);break;}candidate.bytes+=next.value.byteLength;if(candidate.bytes>policy.maxResponseBytes){terminal('candidate-oversized');break;}}}
          completed();while(reason===undefined){await new Promise<void>(resolve=>{wake=resolve;});check();completed();}
        }catch(error){
          if(ordinal===null){skip('withdrawn');try{live();}catch{options.stop('authority-revoked');}}
          else if(reason===undefined){try{live();terminal(submitted?'candidate-error':'not-submitted');}catch{terminal('authority-lost');options.stop('authority-revoked');}}
        }finally{
          abort.abort();cancelHandoff?.();
          // Actual completion remains tracked; a nonsettling native cancellation keeps the slot/barrier.
          if(reader){try{await reader.cancel();}catch{}finally{reader.releaseLock();}}
          else if(received?.body){try{await received.body.cancel();}catch{}}
          if(ordinal!==null){
            native();if(reason===undefined)reason=submitted?'candidate-error':'not-submitted';
            try{options.live();}catch{if(reason===null||reason===undefined)reason='authority-lost';}
            const finalReason=reason;
            const settlementCurrent=()=>{native();if(finalReason===null||finalReason==='content-type-invalid')options.live();};
            options.change(op=>{if(!op.reservations.includes(ordinal!))shadowInvalid('SHADOW_SUPERSEDED');return{...op,reservations:op.reservations.filter(value=>value!==ordinal),report:settleShadowObservation(op.report,finalReason!,primary,candidate,policy.maxAttempts),updatedAt:Math.max(Date.now(),op.updatedAt)};},settlementCurrent);
          }
        }
      }).catch(error=>{options.error(error);options.stop('provider-error');}).finally(cleanup);});};
      cancelHandoff=registerRequestHandoff(request,()=>{handed=true;start();return undefined;});
      if(!cancelHandoff){skip('withdrawn');cleanup();return undefined;}
      if(request.signal.aborted)onAbort();
      return Object.freeze({chunk(length:number):undefined{if(!finished&&reason===undefined){primary.bytes+=length;if(primary.bytes>policy.maxResponseBytes)terminal('primary-oversized');}return undefined;},
        finish(kind:'complete'|'cancelled'|'error',elapsed:number):undefined{if(!finished&&reason===undefined){if(kind==='complete'){primary.complete=true;primary.elapsed=elapsed;completed();}else terminal('primary-incomplete');}return undefined;}});
    },
    get size(){return pairs.size;},
    drained(){return Promise.all([...pairs].map(pair=>pair.flight));},
    disable(){accepting=false;for(const pair of pairs)pair.cancel();},
    async close(){accepting=false;for(const pair of pairs)pair.cancel();clearTimeout(flushTimer);flushTimer=undefined;
      const all=Promise.all([...pairs].map(pair=>pair.flight)),remaining=Math.max(0,...[...pairs].map(pair=>pair.deadline-performance.now()));let timer:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([all,new Promise<void>(resolve=>{timer=setTimeout(resolve,remaining);})]);clearTimeout(timer);
      try{if(pairs.size)throw new Error('Shadow task cleanup remains uncertain.');await options.scope(options.current,async()=>flush());}finally{ended=true;clearTimeout(flushTimer);}
    },
  };
}

export interface ShadowOwnerAdapter extends ShadowLifecycleAdapter {
  lock<Value>(projectId:string,work:()=>Promise<Value>,wait?:boolean):Promise<Value>;
  authority(projectId:string):()=>void;
  scope<Value>(current:()=>void,work:()=>Promise<Value>):Promise<Value>;
  admit(projectId:string,operation:ShadowOperation):void;
  begin(projectId:string,operation:ShadowOperation,current:()=>void):ShadowRecord;
  prepare(projectId:string,record:()=>ShadowRecord,change:(update:(operation:ShadowOperation)=>ShadowOperation)=>void,current:()=>void,signal:AbortSignal,reviewedPrimary?:DeploymentProviderCanaryBinding):Promise<ShadowCheckpoint|ShadowPreparedObservation>;
  replay?(projectId:string,keyDigest:string,current:()=>void,bySession?:boolean):ShadowReplayView|null;
  history?(projectId:string,current:()=>void):ShadowHistoryView;
  onError?(error:unknown):void;
}
export interface ShadowHistoryView { readonly replays:readonly ShadowReplay[]; readonly current:ShadowRecord|null; readonly epoch:number; }
export interface ShadowHistoryRead { readonly view:ShadowHistoryView; readonly assertCurrent:()=>void; }
export interface ShadowCursor { readonly version:1; readonly projectId:string; readonly ceilingEpoch:number; readonly beforeEpoch:number; }
export interface ShadowReplayView { readonly replay:ShadowReplay; readonly current:ShadowRecord|null; readonly epoch:number; }
export interface ShadowController {
  readonly observer: IngressShadowObserver;
  start(projectId:string,operation:ShadowOperation,admission:()=>void,reviewedPrimary?:DeploymentProviderCanaryBinding,authorizeBegin?:()=>void):Promise<ShadowRecord>;
  replay(projectId:string,keyDigest:string,bySession?:boolean):ShadowReplayView|null|undefined;
  history(projectId:string):ShadowHistoryRead|undefined;
  requestStop(projectId:string,sessionId:string,operationId:string,controllerEpoch:number,authorized:()=>void):Promise<ShadowRecord|undefined>;
  elapsed(projectId:string,sessionId:string):number|null;
  stop(projectId:string,sessionId:string,epoch:number,authorized:()=>void):Promise<ShadowRecord>;
  recover(projectId:string):Promise<ShadowRecord|null>;
  close():Promise<void>;
}
/** @internal One tracked task owns the native project lease; exact stop never queues behind that task. */
export function createShadowController(adapter:ShadowOwnerAdapter):ShadowController {
  type Owner={abort:AbortController;record:ShadowRecord|null;current:(()=>void)|null;flight:Promise<void>;observed:number|null;observation?:ReturnType<typeof shadowObservationOwner>};
  const owners=new Map<string,Owner>(),observations=new Set<object>();let closed=false;
  const report=(error:unknown)=>{try{adapter.onError?.(error);}catch{/* Reporting must not detach the retained cleanup barrier. */}};
  return {
    observer:Object.freeze({observe(request:Request,primary:Readonly<IngressRoute>,metadata:Readonly<IngressShadowMetadata>){if(closed)return undefined;return owners.get(primary.projectId)?.observation?.observe(request,primary,metadata);}}),
    start(projectId,input,admission,reviewedPrimary,authorizeBegin=admission){
      // Serialize caller-owned values synchronously before lock() can suspend.
      const operation=JSON.parse(shadowBoundedJson(input,64*1024)) as ShadowOperation;
      const freeze=(value:unknown):void=>{if(value && typeof value==="object"){for(const item of Object.values(value))freeze(item);Object.freeze(value);}};freeze(operation);
      const expected=reviewedPrimary===undefined?undefined:shadowBinding(reviewedPrimary);
      if(closed || owners.has(projectId))return Promise.reject(Object.assign(new Error("A shadow owner is already active or closed."),{code:"SHADOW_BUSY"}));
      let accepted!:(record:ShadowRecord)=>void,rejected!:(error:unknown)=>void;
      const ready=new Promise<ShadowRecord>((resolve,reject)=>{accepted=resolve;rejected=reject;});
      const owner:Owner={abort:new AbortController(),record:null,current:null,flight:Promise.resolve(),observed:null};owners.set(projectId,owner);
      owner.flight=adapter.lock(projectId,async()=>{
        const current=adapter.authority(projectId);owner.current=current;
        await adapter.scope(current,async()=>{
          current();authorizeBegin();admission();if(closed || owner.abort.signal.aborted)throw new Error("Shadow owner closed before admission.");
          owner.record=adapter.begin(projectId,operation,()=>{current();authorizeBegin();admission();});accepted(owner.record);
          let outcome:ShadowOutcome="interrupted",wall=Date.now(),started=performance.now();
          const admitCurrent=()=>{
            current();admission();adapter.admit(projectId,owner.record!.operation);if(closed || owner.abort.signal.aborted || owner.record!.operation.stopRequested)throw new Error("Shadow observation was stopped.");
            if(Date.now()<wall || Date.now()>=operation.expiresAt || performance.now()-started>=operation.policy.durationMs){outcome="expired";throw new Error("Shadow observation expired.");}
            wall=Date.now();
          };
          const live=()=>{admitCurrent();shadowCurrent(adapter,projectId,owner.record!,current);};
          const change=(update:(operation:ShadowOperation)=>ShadowOperation)=>{live();owner.record=adapter.save(projectId,owner.record!,update(owner.record!.operation),current);live();};
          try{
            live();const prepared=await adapter.prepare(projectId,()=>owner.record!,change,live,owner.abort.signal,expected);live();
            const snapshot="snapshot" in prepared?prepared.snapshot:prepared;
            owner.observed=performance.now();
            change(op=>({...op,snapshot,phase:"observing",updatedAt:Math.max(Date.now(),op.updatedAt)}));
            if("snapshot" in prepared && prepared.observation && owner.record!.operation.report.protocol===2){
              owner.observation=shadowObservationOwner({capability:prepared.observation,global:observations,initial:owner.record!,deadline:started+operation.policy.durationMs,
                state:()=>owner.record!,current,live:admitCurrent,verify:()=>shadowCurrent(adapter,projectId,owner.record!,current),scope:adapter.scope,
                change:(update,guard)=>{shadowCurrent(adapter,projectId,owner.record!,current);owner.record=adapter.save(projectId,owner.record!,update(owner.record!.operation),guard);shadowCurrent(adapter,projectId,owner.record!,current);},
                stop:reason=>{outcome=reason;if(reason!=="attempt-limit"){owner.observation?.disable();owner.abort.abort();}},error:report});
            }
            while(true){
              live();if(owner.record!.operation.report.counters.reserved>=operation.policy.maxAttempts && !owner.observation?.size){outcome="attempt-limit";throw new Error("Shadow attempt budget exhausted.");}
              await new Promise<void>(resolve=>{
                const done=()=>{clearTimeout(timer);owner.abort.signal.removeEventListener("abort",done);resolve();};
                const timer=setTimeout(done,Math.max(1,Math.min(1000,operation.expiresAt-Date.now())));owner.abort.signal.addEventListener("abort",done,{once:true});
              });
            }
          }catch(error){
            if(owner.record!.operation.stopRequested)outcome="stopped";
            else if(!["expired","attempt-limit","authority-revoked","primary-changed","policy-changed"].includes(outcome as ShadowOutcome)){
              const code=String((error as {code?:string})?.code??"");
              outcome=closed?"interrupted":code==="SHADOW_AUTHORITY_REVOKED"?"authority-revoked":code==="SHADOW_PRIMARY_CHANGED"?"primary-changed":"provider-error";
            }
            try{await owner.observation?.close();owner.record=await retireShadow(adapter,projectId,owner.record!,current,outcome);}
            catch(cleanup){report(cleanup);throw cleanup;}
          }
        });
      }).catch(error=>{rejected(error);report(error);}).finally(()=>{
        const release=()=>{if(owners.get(projectId)===owner && !owner.observation?.size)owners.delete(projectId);};
        // Bounded shutdown can release the native lease while real cancellation remains pending.
        // Keep this exact, now-stale owner as a refusal tombstone until its tracked pairs drain.
        if(owner.observation?.size)void owner.observation.drained().then(release,report);else release();
      });
      return ready;
    },
    replay(projectId,keyDigest,bySession=false){
      const owner=owners.get(projectId);
      if(closed || !owner?.record || !owner.current)return undefined;
      if(!adapter.replay)throw new Error("The native replay reader is unavailable.");
      owner.current();const result=adapter.replay(projectId,keyDigest,owner.current,bySession);owner.current();return result;
    },
    history(projectId){
      const owner=owners.get(projectId);if(!owner)return undefined;
      if(!owner.record || !owner.current || !adapter.history)shadowInvalid("SHADOW_BUSY");
      const current=owner.current;
      const assertCurrent=()=>{if(closed || owners.get(projectId)!==owner || owner.current!==current)shadowInvalid("SHADOW_SUPERSEDED");current();shadowCurrent(adapter,projectId,owner.record!,current);};
      assertCurrent();const view=adapter.history(projectId,assertCurrent);assertCurrent();
      return Object.freeze({view,assertCurrent});
    },
    elapsed(projectId,sessionId){const owner=owners.get(projectId);return owner?.record?.operation.sessionId===sessionId && owner.observed!==null?Math.max(0,Math.floor(performance.now()-owner.observed)):null;},
    async requestStop(projectId,sessionId,operationId,controllerEpoch,authorized){
      const owner=owners.get(projectId);
      if(closed || !owner?.record || !owner.current)return undefined;
      const current=owner.current;
      return adapter.scope(current,async()=>{
        current();authorized();const record=adapter.read(projectId);
        if(!record || record.operation.sessionId!==sessionId || record.operation.operationId!==operationId || record.operation.controllerEpoch!==controllerEpoch
          || record.serialized!==owner.record!.serialized)shadowInvalid("SHADOW_SUPERSEDED");
        if(record.operation.phase==="complete")return record;
        if(!record.operation.stopRequested)owner.record=adapter.save(projectId,record,{...record.operation,stopRequested:true,updatedAt:Math.max(Date.now(),record.operation.updatedAt)},()=>{current();authorized();});
        current();authorized();owner.observation?.disable();owner.abort.abort();return owner.record!;
      });
    },
    async stop(projectId,sessionId,epoch,authorized){
      const owner=owners.get(projectId);
      if(!owner?.record || !owner.current)throw Object.assign(new Error("The exact live shadow owner is unavailable; recover its retained session."),{code:"SHADOW_OWNER_UNAVAILABLE"});
      const current=owner.current;
      await adapter.scope(current,async()=>{
        current();authorized();const record=adapter.read(projectId);
        if(!record || record.operation.sessionId!==sessionId || record.epoch!==epoch || record.serialized!==owner.record!.serialized)shadowInvalid("SHADOW_SUPERSEDED");
        owner.record=adapter.save(projectId,record,{...record.operation,stopRequested:true,updatedAt:Math.max(Date.now(),record.operation.updatedAt)},()=>{current();authorized();});
        owner.observation?.disable();owner.abort.abort();
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
    async close(){closed=true;for(const owner of owners.values()){owner.observation?.disable();owner.abort.abort();}await Promise.all([...owners.values()].map(owner=>owner.flight));},
  };
}

/** @internal Canonical, bounded review identity; this value never grants native authority. */
export interface ShadowReviewSelection {
  readonly pathIndices: readonly number[]; readonly methodMask: number; readonly samplePercent: number; readonly durationMs: number;
  readonly maxAttempts: number; readonly maxConcurrent: number; readonly maxResponseBytes: number; readonly requestMs: number;
}
export interface ShadowReviewPayload {
  readonly version: 1; readonly projectId: string; readonly releaseId: string; readonly artifactSha256: string;
  readonly primaryReleaseId: string; readonly primaryGeneration: number; readonly primaryFence: number; readonly primaryIncarnation: string;
  readonly primaryArtifactSha256: string; readonly nodeId: string; readonly providerBindingDigest: string; readonly credentialGeneration: number;
  readonly principalBindingDigest: string; readonly policyRevision: number; readonly policyDigest: string; readonly selection: ShadowReviewSelection;
  readonly expectedEpoch: number; readonly issuedAt: number; readonly expiresAt: number; readonly nonce: string; readonly reviewDigest: string;
}
const reviewFields=["version","projectId","releaseId","artifactSha256","primaryReleaseId","primaryGeneration","primaryFence","primaryIncarnation","primaryArtifactSha256",
  "nodeId","providerBindingDigest","credentialGeneration","principalBindingDigest","policyRevision","policyDigest","selection","expectedEpoch","issuedAt","expiresAt","nonce","reviewDigest"];
const selectionFields=["pathIndices","methodMask","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"];
/** @internal Captures every scalar and array before the first admission await. */
export function normalizeShadowReview(value:unknown):ShadowReviewPayload {
  const code="SHADOW_REVIEW_INVALID",raw=closedShadowObject(value,reviewFields,code),selection=closedShadowObject(raw.selection,selectionFields,code);
  if(raw.version!==1)shadowInvalid(code);
  const indices=selection.pathIndices;
  if(!Array.isArray(indices) || indices.length<1 || indices.length>32 || indices.some((value,index)=>!Number.isSafeInteger(value) || value<0 || value>31 || index>0 && value<=indices[index-1]))shadowInvalid(code);
  const captured:ShadowReviewSelection=Object.freeze({pathIndices:Object.freeze([...indices]),methodMask:shadowNumber(selection.methodMask,3,code),
    samplePercent:shadowPercentage(selection.samplePercent,100),durationMs:shadowNumber(selection.durationMs,1800000,code),maxAttempts:shadowNumber(selection.maxAttempts,10000,code),
    maxConcurrent:shadowNumber(selection.maxConcurrent,16,code),maxResponseBytes:shadowNumber(selection.maxResponseBytes,65536,code),requestMs:shadowNumber(selection.requestMs,10000,code)});
  const binding=shadowBinding({projectId:raw.projectId,releaseId:raw.primaryReleaseId,generation:raw.primaryGeneration,fence:raw.primaryFence,incarnation:raw.primaryIncarnation});
  const result:ShadowReviewPayload=Object.freeze({version:1,projectId:binding.projectId,releaseId:shadowId(raw.releaseId),artifactSha256:shadowDigest(raw.artifactSha256),primaryReleaseId:binding.releaseId,
    primaryGeneration:binding.generation,primaryFence:binding.fence,primaryIncarnation:binding.incarnation,primaryArtifactSha256:shadowDigest(raw.primaryArtifactSha256),nodeId:shadowId(raw.nodeId),
    providerBindingDigest:shadowDigest(raw.providerBindingDigest),credentialGeneration:shadowInteger(raw.credentialGeneration),principalBindingDigest:shadowDigest(raw.principalBindingDigest),
    policyRevision:shadowInteger(raw.policyRevision),policyDigest:shadowDigest(raw.policyDigest),selection:captured,expectedEpoch:shadowInteger(raw.expectedEpoch,Number.MAX_SAFE_INTEGER,0),
    issuedAt:shadowInteger(raw.issuedAt),expiresAt:shadowInteger(raw.expiresAt),nonce:typeof raw.nonce==="string"?raw.nonce:"",reviewDigest:shadowDigest(raw.reviewDigest)});
  if(result.releaseId===result.primaryReleaseId || result.credentialGeneration!==result.primaryGeneration || result.expiresAt!==result.issuedAt+120000
    || !/^[A-Za-z0-9_-]{22}$/u.test(result.nonce) || reviewBase64(reviewBytes(result.nonce)).length!==22 || reviewBase64(reviewBytes(result.nonce))!==result.nonce)shadowInvalid(code);
  shadowBoundedJson(result,3072);return result;
}
function reviewBase64(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes)).replace(/=/gu,"").replace(/\+/gu,"-").replace(/\//gu,"_");}
function reviewBytes(value:string):Uint8Array {
  if(!/^[A-Za-z0-9_-]+$/u.test(value))shadowInvalid("SHADOW_REVIEW_INVALID");
  try{return Uint8Array.from(atob(value.replace(/-/gu,"+").replace(/_/gu,"/")),char=>char.charCodeAt(0));}catch{shadowInvalid("SHADOW_REVIEW_INVALID");}
}
export function shadowReviewToken(payload:ShadowReviewPayload,sign:(canonical:string)=>Uint8Array):string {
  const canonical=JSON.stringify(normalizeShadowReview(payload)),signature=sign(canonical);
  if(!(signature instanceof Uint8Array) || signature.byteLength!==32)shadowInvalid("SHADOW_REVIEW_INVALID");
  return "clankshr1."+reviewBase64(new TextEncoder().encode(canonical))+"."+reviewBase64(signature);
}
export function parseShadowReviewToken(token:unknown):Readonly<{payload:ShadowReviewPayload;canonical:string;signature:Uint8Array}> {
  if(typeof token!=="string" || token.length>4150 || !/^clankshr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token))shadowInvalid("SHADOW_REVIEW_INVALID");
  const parts=token.split("."),bytes=reviewBytes(parts[1]!),signature=reviewBytes(parts[2]!);
  if(bytes.byteLength>3072 || signature.byteLength!==32 || reviewBase64(bytes)!==parts[1] || reviewBase64(signature)!==parts[2])shadowInvalid("SHADOW_REVIEW_INVALID");
  let canonical:string,payload:ShadowReviewPayload;
  try{canonical=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);payload=normalizeShadowReview(JSON.parse(canonical));}catch{shadowInvalid("SHADOW_REVIEW_INVALID");}
  if(JSON.stringify(payload)!==canonical)shadowInvalid("SHADOW_REVIEW_INVALID");
  return Object.freeze({payload,canonical,signature});
}
export function shadowReviewSelection(policy:PlatformShadowPolicy,effective:ShadowSessionPolicy):ShadowReviewSelection {
  const selected=narrowShadowPolicy(policy,effective);
  return Object.freeze({pathIndices:Object.freeze(selected.readPaths.map(path=>policy.readPaths.indexOf(path))),methodMask:(selected.methods.includes("GET")?1:0)|(selected.methods.includes("HEAD")?2:0),
    samplePercent:selected.samplePercent,durationMs:selected.durationMs,maxAttempts:selected.maxAttempts,maxConcurrent:selected.maxConcurrent,maxResponseBytes:selected.maxResponseBytes,requestMs:selected.requestMs});
}
export function expandShadowReviewSelection(policy:PlatformShadowPolicy,selection:ShadowReviewSelection):ShadowSessionPolicy {
  const paths=selection.pathIndices.map(index=>policy.readPaths[index]);
  if(paths.some(path=>path===undefined))shadowInvalid("SHADOW_REVIEW_INVALID");
  return narrowShadowPolicy(policy,{readPaths:paths,methods:[...(selection.methodMask&1?["GET"]:[]),...(selection.methodMask&2?["HEAD"]:[])],samplePercent:selection.samplePercent,durationMs:selection.durationMs,
    maxAttempts:selection.maxAttempts,maxConcurrent:selection.maxConcurrent,maxResponseBytes:selection.maxResponseBytes,requestMs:selection.requestMs});
}
export function shadowReviewDigest(payload:ShadowReviewPayload,principalBindingDigest:string,policy:ShadowSessionPolicy,hash:ShadowHash):string {
  return hash(JSON.stringify({version:1,action:"shadow-start",principalBindingDigest,projectId:payload.projectId,releaseId:payload.releaseId,artifactSha256:payload.artifactSha256,
    primary:{releaseId:payload.primaryReleaseId,generation:payload.primaryGeneration,fence:payload.primaryFence,incarnation:payload.primaryIncarnation,artifactSha256:payload.primaryArtifactSha256},
    nodeId:payload.nodeId,providerBindingDigest:payload.providerBindingDigest,credentialGeneration:payload.credentialGeneration,policyRevision:payload.policyRevision,policyDigest:payload.policyDigest,
    effectivePolicyDigest:hash(JSON.stringify(policy)),expectedEpoch:payload.expectedEpoch,issuedAt:payload.issuedAt,expiresAt:payload.expiresAt,nonce:payload.nonce}));
}
/** @internal Call only after the native replay mirror and exact opaque input digest have matched. */
export function assertShadowReviewReplay(payload:ShadowReviewPayload,identity:ShadowReplayIdentity,principalDigest:string,hash:ShadowHash):void {
  if(payload.projectId!==identity.projectId || payload.releaseId!==identity.releaseId || payload.artifactSha256!==identity.artifactSha256
    || payload.primaryReleaseId!==identity.primaryReleaseId || payload.primaryGeneration!==identity.primaryGeneration || payload.policyRevision!==identity.policyRevision || payload.policyDigest!==identity.policyDigest
    || payload.expectedEpoch+1!==identity.controllerEpoch || payload.principalBindingDigest!==principalDigest
    || identity.primary && (payload.primaryFence!==identity.primary.fence || payload.primaryIncarnation!==identity.primary.incarnation)
    || shadowReviewDigest(payload,principalDigest,identity.policy,hash)!==identity.reviewDigest || payload.reviewDigest!==identity.reviewDigest)shadowInvalid("SHADOW_REPLAY_CONFLICT");
}

/** @internal Schema identity is separate from per-session policy and enablement. */
export const shadowSchemaIdentity = "clank-platform-shadow/2";
export const shadowReportSchemaIdentity = "clank-platform-shadow/3";
export interface ShadowSchemaIdentity { readonly enrollmentId: string; readonly version: 1 | 2 | 3; }
function shadowSchemaRead(connection: ShadowRead): ShadowRead {
  return {prepare:sql=>connection.prepare(sql==="PRAGMA table_list"?"SELECT * FROM pragma_table_list":sql)};
}
/** @internal Commit the compatibility barrier before separate supervisor enrollment or v2 intent. */
export function upgradeShadowReportSchema(connection: SQLiteInternal, current:()=>void): ShadowSchemaIdentity {
  if(connection.inTransaction)shadowInvalid("SHADOW_STATE_INVALID");
  let retained:ShadowSchemaIdentity|undefined;
  connection.transaction(()=>{
    current();const schema=shadowSchemaRead(connection),before=assertProviderShadowSchema(schema);
    if(before.version!==2 && before.version!==3)shadowInvalid("SHADOW_STATE_INVALID");
    if(before.version===2){
      const changed=connection.prepare("UPDATE clank_platform_shadow_state SET schema_id=? WHERE singleton=1 AND protocol=1 AND enrollment_id=? AND schema_id=?")
        .run(shadowReportSchemaIdentity,before.enrollmentId,shadowSchemaIdentity);
      if(Number(changed.changes)!==1)shadowInvalid("SHADOW_STATE_INVALID");
    }
    retained=assertProviderShadowSchema(schema);
    if(retained.version!==3 || retained.enrollmentId!==before.enrollmentId)shadowInvalid("SHADOW_STATE_INVALID");
    current();
  });
  current();return retained!;
}

/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export function assertProviderShadowSchema(connection: Pick<SQLiteInternal, "prepare">): ShadowSchemaIdentity {
  const invalid = (): never => { const error = new Error("Retained shadow schema is missing or invalid; preserve it for recovery."); Object.assign(error, { code: "SUPERVISOR_SHADOW_SCHEMA" }); throw error; };
  const schemas = {
    clank_platform_shadow_state: ["singleton:INTEGER:0:1", "protocol:INTEGER:1:0", "enrollment_id:TEXT:1:0", "schema_id:TEXT:1:0"],
    clank_platform_shadow_reports: ["project_id:TEXT:1:1", "session_id:TEXT:1:2", "idempotency_key_digest:TEXT:1:0", "input_digest:TEXT:1:0", "receipt_json:TEXT:1:0", "report_json:TEXT:0:0"],
  };
  const tables = connection.prepare("PRAGMA table_list").all();
  for (const [name, expected] of Object.entries(schemas)) {
    if (!tables.some(table => table.schema === "main" && table.name === name && table.type === "table" && table.strict === 1)) invalid();
    const columns = connection.prepare(`PRAGMA main.table_info(${name})`).all();
    if (columns.length !== expected.length || columns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expected[index])) invalid();
  }
  if (!tables.some(table => table.schema === "main" && table.name === "clank_platform_provider_canaries" && table.type === "table")) invalid();
  const candidateColumns = connection.prepare("PRAGMA main.table_info(clank_platform_provider_canaries)").all();
  const expectedCandidateColumns = ["project_id:TEXT:0:1", "protocol:INTEGER:1:0", "epoch:INTEGER:1:0", "operation:TEXT:1:0", "updated_at:INTEGER:1:0"];
  if (candidateColumns.length !== expectedCandidateColumns.length || candidateColumns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expectedCandidateColumns[index])) invalid();
  const indices = connection.prepare("PRAGMA main.index_list(clank_platform_shadow_reports)").all();
  if (!indices.some(index => {
    if (index.unique !== 1 || index.partial !== 0 || typeof index.name !== "string") return false;
    const columns = connection.prepare(`PRAGMA main.index_info("${index.name.replaceAll('"', '""')}")`).all();
    return columns.length === 2 && columns[0].name === "project_id" && columns[1].name === "idempotency_key_digest";
  })) invalid();
  const projects = connection.prepare("PRAGMA main.table_info(clank_platform_projects)").all();
  const releases = connection.prepare("PRAGMA main.table_info(clank_platform_releases)").all();
  if (!projects.some(column => column.name === "provider_canary_epoch" && column.type === "INTEGER" && column.notnull === 1 && column.dflt_value === "0")
    || !projects.some(column => column.name === "shadow_replay_receipt" && column.type === "TEXT" && column.notnull === 0)
    || !releases.some(column => column.name === "purpose" && column.type === "TEXT" && column.notnull === 1 && column.dflt_value === "'deployment'")
    || !releases.some(column => column.name === "upload_request_digest" && column.type === "TEXT" && column.notnull === 0)) invalid();
  const rows = connection.prepare("SELECT * FROM clank_platform_shadow_state LIMIT 2").all();
  const row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || row.protocol !== 1 || !["clank-platform-shadow/1", shadowSchemaIdentity, shadowReportSchemaIdentity].includes(String(row.schema_id))
    || typeof row.enrollment_id !== "string" || !/^[a-f0-9]{64}$/u.test(row.enrollment_id)) invalid();
  const version = row.schema_id === shadowReportSchemaIdentity ? 3 : row.schema_id === shadowSchemaIdentity ? 2 : 1;
  const publication = releases.find(column => column.name === "upload_publication_receipt");
  if (version === 1) {
    if (publication || connection.prepare("SELECT 1 FROM clank_platform_releases WHERE purpose='shadow-upload' LIMIT 1").get()) invalid();
  } else if (!publication || publication.type !== "TEXT" || publication.notnull !== 0 || publication.dflt_value !== null) invalid();
  return Object.freeze({enrollmentId:row.enrollment_id as string,version});
}

/** @internal Exact selected cursor; no authentication or native state is implied by decoded fields. */
export function normalizeShadowCursor(value:unknown):ShadowCursor {
  const code="SHADOW_CURSOR_INVALID",raw=closedShadowObject(value,["version","projectId","ceilingEpoch","beforeEpoch"],code);
  if(raw.version!==1 || typeof raw.projectId!=="string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(raw.projectId)
    || !Number.isSafeInteger(raw.ceilingEpoch) || Number(raw.ceilingEpoch)<1 || !Number.isSafeInteger(raw.beforeEpoch) || Number(raw.beforeEpoch)<1 || Number(raw.beforeEpoch)>Number(raw.ceilingEpoch))shadowInvalid(code);
  return Object.freeze({version:1,projectId:raw.projectId,ceilingEpoch:Number(raw.ceilingEpoch),beforeEpoch:Number(raw.beforeEpoch)});
}
export function shadowCursorToken(value:ShadowCursor,sign:(canonical:string)=>Uint8Array):string {
  const canonical=JSON.stringify(normalizeShadowCursor(value)),bytes=new TextEncoder().encode(canonical),signature=sign(canonical);
  if(bytes.byteLength>256 || !(signature instanceof Uint8Array) || signature.byteLength!==32)shadowInvalid("SHADOW_CURSOR_INVALID");
  return "clankshc1."+reviewBase64(bytes)+"."+reviewBase64(signature);
}
export function parseShadowCursorToken(value:unknown):Readonly<{payload:ShadowCursor;canonical:string;signature:Uint8Array}> {
  const code="SHADOW_CURSOR_INVALID";
  try{
    if(typeof value!=="string" || value.length>512 || !/^clankshc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value))shadowInvalid(code);
    const parts=value.split("."),bytes=reviewBytes(parts[1]!),signature=reviewBytes(parts[2]!);
    if(bytes.byteLength>256 || signature.byteLength!==32 || reviewBase64(bytes)!==parts[1] || reviewBase64(signature)!==parts[2])shadowInvalid(code);
    const canonical=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes),payload=normalizeShadowCursor(JSON.parse(canonical));
    if(JSON.stringify(payload)!==canonical)shadowInvalid(code);
    return Object.freeze({payload,canonical,signature});
  }catch{shadowInvalid(code);}
}
/** @internal Validate the literal query before URLSearchParams can erase spellings. */
export function shadowStatusQuery(search:string):Readonly<{limit:number;before?:string}> {
  const code="SHADOW_CURSOR_INVALID";if(search==="")return Object.freeze({limit:20});
  if(typeof search!=="string" || search.length>540 || !search.startsWith("?"))shadowInvalid(code);
  let limit=20,before:string|undefined;const seen=new Set<string>();
  for(const field of search.slice(1).split("&")){
    const pair=field.split("=");if(pair.length!==2 || seen.has(pair[0]!) || !pair[1])shadowInvalid(code);seen.add(pair[0]!);
    if(pair[0]==="limit"){if(!/^(?:[1-9]|1[0-9]|20)$/u.test(pair[1]!))shadowInvalid(code);limit=Number(pair[1]);}
    else if(pair[0]==="before"){parseShadowCursorToken(pair[1]);before=pair[1];}
    else shadowInvalid(code);
  }
  return Object.freeze({limit,...(before===undefined?{}:{before})});
}
/** @internal Full validated native history is required; selection never replaces mirror verification. */
export function selectShadowHistory(view:ShadowHistoryView,limit:number,cursor?:ShadowCursor):Readonly<{views:readonly ShadowReplayView[];nextEpoch:number|null;ceilingEpoch:number}> {
  const code="SHADOW_STATE_INVALID";
  if(!Number.isSafeInteger(view.epoch) || view.epoch<0 || view.replays.length>1024 || !Number.isSafeInteger(limit) || limit<1 || limit>20)shadowInvalid(code);
  const epochs=new Set<number>();
  for(const replay of view.replays){const epoch=replay.receipt.identity.controllerEpoch;if(!Number.isSafeInteger(epoch) || epoch<1 || epoch>view.epoch || replay.receipt.identity.epoch>view.epoch || epochs.has(epoch))shadowInvalid(code);epochs.add(epoch);}
  const ceilingEpoch=cursor?.ceilingEpoch??view.epoch;if(ceilingEpoch>view.epoch)shadowInvalid(code);
  const rows=view.replays.filter(row=>row.receipt.identity.controllerEpoch<=ceilingEpoch && (!cursor || row.receipt.identity.controllerEpoch<cursor.beforeEpoch))
    .sort((a,b)=>b.receipt.identity.controllerEpoch-a.receipt.identity.controllerEpoch).slice(0,limit+1);
  const selected=rows.slice(0,limit),views=selected.map(replay=>Object.freeze({replay,current:view.current?.operation.sessionId===replay.receipt.identity.sessionId?view.current:null,epoch:view.epoch}));
  return Object.freeze({views:Object.freeze(views),nextEpoch:rows.length>limit?selected[selected.length-1]!.receipt.identity.controllerEpoch:null,ceilingEpoch});
}
