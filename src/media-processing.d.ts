import type { AuthRequest, AuthRuntime } from "./auth.js";
import type { SQLiteDatabase } from "./backend.js";
import type { BucketManager, BucketObject, BucketStoredObject } from "./buckets.js";
import type { JobProcessHandle, JobWorkerOptions } from "./jobs.js";
export interface MediaTransform {
  readonly name: string;
  /** Change whenever the adapter, configuration or provider behavior changes. */
  readonly revision: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly handler: (input: { readonly source: BucketStoredObject; readonly signal: AbortSignal;
    /** Providers must deduplicate this exact key across attempts and process death. */
    readonly operationKey: string; readonly progress: (percent: number) => void }) =>
      { readonly bytes: Uint8Array | ArrayBuffer; readonly contentType: string } | Promise<{ readonly bytes: Uint8Array | ArrayBuffer; readonly contentType: string }>;
}
export interface MediaProcessingInput {
  readonly operationId: string;
  readonly transform: string;
  readonly sourceKey: string;
  readonly destinationKey: string;
}
export interface MediaProcessingStatus {
  readonly id: string;
  readonly jobId: string;
  readonly transform: string;
  readonly state: "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled" | "published";
  readonly progress: number;
  readonly attempt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** False after either the source or accepted destination is replaced. */
  readonly outputCurrent: boolean;
  readonly object: BucketObject | null;
}
export interface OpenMediaProcessingOptions {
  /** A persistent native catalog shared by this AuthRuntime and bucket manager. */
  readonly database: SQLiteDatabase<any>;
  readonly buckets: BucketManager;
  readonly auth: AuthRuntime<any>;
  readonly transforms: readonly MediaTransform[];
  /** Increasing revision shared by every compatible controller and worker. */
  readonly policyRevision: number;
  /** Synchronous current ownership/role/policy check; success returns undefined. */
  readonly authorize: (auth: AuthRequest<any>, transform: MediaTransform, operation: "enqueue" | "read" | "cancel" | "process") => undefined;
  readonly maxOperations?: number;
  readonly receiptLifetimeMs?: number;
  readonly maxProgressUpdates?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
export interface MediaProcessing {
  enqueue(auth: AuthRequest<any>, input: MediaProcessingInput): MediaProcessingStatus;
  get(auth: AuthRequest<any>, id: string): MediaProcessingStatus | null;
  cancel(auth: AuthRequest<any>, id: string): boolean;
  workOnce(options?: Omit<JobWorkerOptions, "queues" | "concurrency" | "pollIntervalMs">): Promise<boolean>;
  startWorker(options?: Omit<JobWorkerOptions, "queues">): JobProcessHandle;
  /** Stops this controller's workers; does not close shared auth, buckets or database. */
  close(): void;
}
export declare class MediaProcessingError extends Error {
 readonly name: "MediaProcessingError"; readonly code: string; readonly status: number; constructor(code: string, message: string, status?: number);
}
/** Durable native jobs with generation-fenced, receipt-backed bucket publication. */
export declare function openMediaProcessing(options: OpenMediaProcessingOptions): Promise<MediaProcessing>;
