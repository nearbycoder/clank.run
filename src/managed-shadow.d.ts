import type { SQLiteInternal } from "./sqlite-internal.js";
import type { DeploymentProviderCanaryBinding, DeploymentProviderCanaryRetirement } from "./provider-service.js";

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
export interface ShadowReport {
  readonly counters: Readonly<{ reserved: number; settled: number; comparable: number; statusClassEqual: number; statusClassDifferent: number;
    mediaTypeEqual: number; mediaTypeDifferent: number; bothComplete: number; unknown: Readonly<Record<ShadowUnknownReason, number>> }>;
  readonly latency: Readonly<{ primary: ShadowLatency; candidate: ShadowLatency }>;
}

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

export declare const shadowLatencyBuckets: readonly number[];
export declare function normalizeShadowPolicy(value: unknown): PlatformShadowPolicy;
export declare function narrowShadowPolicy(policy: PlatformShadowPolicy, value: unknown): ShadowSessionPolicy;
export declare function emptyShadowReport(): ShadowReport;
export declare function normalizeShadowReport(value: unknown, maxAttempts: number): ShadowReport;

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
export interface ShadowPriorRecord { readonly epoch: number; readonly serialized: string; }
export declare function shadowCandidateProjectId(operation: Pick<ShadowOperation,"primary"|"controllerEpoch"|"operationId"|"capsuleSha256">, hash: (value:string)=>string): string;
export declare function normalizeShadowOperation(value: unknown, projectId: string, epoch: number, hash: (value:string)=>string): ShadowOperation;
export declare function readShadowRecord(row: Record<string,unknown>, projectId:string, hash:(value:string)=>string): ShadowRecord;
export declare function readShadowReplays(connection: Pick<SQLiteInternal,"prepare">, projectId: string, hash: (value:string)=>string): readonly ShadowReplay[];
export declare function writeShadowReplay(connection: SQLiteInternal, projectId: string, record: ShadowRecord, previous: readonly ShadowReplay[], hash: (value:string)=>string): void;
export declare function assertShadowReplay(connection: Pick<SQLiteInternal,"prepare">, projectId: string, record: ShadowRecord, hash: (value:string)=>string): void;
export declare function saveShadowRecord(connection: SQLiteInternal, projectId: string, prior: ShadowPriorRecord|null, operation: ShadowOperation, current:()=>void, hash:(value:string)=>string): ShadowRecord;
export interface ShadowLifecycleAdapter {
  read(projectId:string):ShadowRecord|null;
  save(projectId:string,prior:ShadowRecord,operation:ShadowOperation,current:()=>void):ShadowRecord;
  retire(projectId:string,record:ShadowRecord,current:()=>void):Promise<DeploymentProviderCanaryRetirement>;
}
export declare function retireShadow(adapter:ShadowLifecycleAdapter,projectId:string,input:ShadowRecord,current:()=>void,outcome:ShadowOutcome):Promise<ShadowRecord>;

export interface ShadowOwnerAdapter extends ShadowLifecycleAdapter {
  lock<Value>(projectId:string,work:()=>Promise<Value>,wait?:boolean):Promise<Value>;
  authority(projectId:string):()=>void;
  scope<Value>(current:()=>void,work:()=>Promise<Value>):Promise<Value>;
  admit(projectId:string,operation:ShadowOperation):void;
  begin(projectId:string,operation:ShadowOperation,current:()=>void):ShadowRecord;
  prepare(projectId:string,record:()=>ShadowRecord,change:(update:(operation:ShadowOperation)=>ShadowOperation)=>void,current:()=>void,signal:AbortSignal):Promise<ShadowCheckpoint>;
  onError?(error:unknown):void;
}
export interface ShadowController {
  start(projectId:string,operation:ShadowOperation,admission:()=>void):Promise<ShadowRecord>;
  stop(projectId:string,sessionId:string,epoch:number,authorized:()=>void):Promise<ShadowRecord>;
  recover(projectId:string):Promise<ShadowRecord|null>;
  close():Promise<void>;
}
export declare function createShadowController(adapter:ShadowOwnerAdapter):ShadowController;

/** @internal Schema identity is separate from per-session policy and enablement. */
export declare const shadowSchemaIdentity = "clank-platform-shadow/2";
export interface ShadowSchemaIdentity { readonly enrollmentId: string; readonly version: 1 | 2; }
/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export declare function assertProviderShadowSchema(connection: Pick<SQLiteInternal, "prepare">): ShadowSchemaIdentity;
