import type { FunctionReference, SyncClient } from "./backend.js";
import type { BucketAttachmentReference, BucketClient } from "./buckets.js";
type InputOf<R> = R extends FunctionReference<any, infer Input, any> ? Input : never;
export type OfflineAttachmentStatus = "pending" | "uploading" | "attaching" | "failed";
export interface OfflineAttachment {
  readonly id: string;
  readonly path: string;
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly status: OfflineAttachmentStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly errorCode?: string;
}
export interface OfflineAttachmentQueueOptions {
  namespace: string;
  userId: string;
  bucketName: string;
  bucket: Pick<BucketClient, "stat" | "upload">;
  client: Pick<SyncClient, "mutateOnce">;
  currentUser(): string | null;
  online?(): boolean;
  maxItems?: number;
  maxBlobBytes?: number;
  maxTotalBytes?: number;
  indexedDB?: IDBFactory;
  locks?: Pick<LockManager, "request">;
}
export interface OfflineAttachmentQueue {
  snapshot(): Promise<readonly OfflineAttachment[]>;
  enqueue<R extends FunctionReference<"mutation", any, any>>(reference: R,
    input: InputOf<R> extends {attachment: BucketAttachmentReference} ? Omit<InputOf<R>, "attachment"> : never, blob: Blob): Promise<string>;
  flush(): Promise<void>;
  retry(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  subscribe(listener: (items: readonly OfflineAttachment[]) => void): () => void;
  dispose(): void;
}
/** Native IndexedDB binary queue; requires Web Locks and the current account. */
export declare function openOfflineAttachmentQueue(options: OfflineAttachmentQueueOptions): Promise<OfflineAttachmentQueue>;
/** Metadata-only view; dispose on logout. */
export declare function mountOfflineAttachmentQueue(container: HTMLElement, queue: OfflineAttachmentQueue): () => void;
