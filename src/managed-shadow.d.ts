import type { SQLiteInternal } from "./sqlite-internal.js";
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

export declare const shadowLatencyBuckets: readonly number[];
export declare function normalizeShadowPolicy(value: unknown): PlatformShadowPolicy;
export declare function narrowShadowPolicy(policy: PlatformShadowPolicy, value: unknown): ShadowSessionPolicy;
export declare function emptyShadowReport(): ShadowReport;
export declare function normalizeShadowReport(value: unknown, maxAttempts: number): ShadowReport;

/** @internal Schema identity is separate from per-session policy and enablement. */
export declare const shadowSchemaIdentity = "clank-platform-shadow/1";
/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export declare function assertProviderShadowSchema(connection: Pick<SQLiteInternal, "prepare">): string;
