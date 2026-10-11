import { type FunctionReference, type SyncClient } from "./backend.js";
export * from "./offline-attachments.js";

export type OfflineMutationStatus = "pending" | "sending" | "conflict" | "failed";
export interface OfflineMutation {
  readonly id: string;
  readonly path: string;
  readonly input: unknown;
  readonly status: OfflineMutationStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly errorCode?: string;
  readonly reconciliation?: { readonly original: Readonly<Record<string, unknown>>; readonly local: Readonly<Record<string, unknown>> };
}
export interface OfflineQueueOptions {
  /** Unique application storage namespace. */
  namespace: string;
  userId: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  client: Pick<SyncClient, "mutateOnce">;
  /** Read the current authenticated user each time; never persist credentials in this queue. */
  currentUser: () => string | null;
  online?: () => boolean;
}
export interface OfflineQueue {
  snapshot(): readonly OfflineMutation[];
  enqueue<Input>(reference: FunctionReference<"mutation", Input, any>, input: Input, reconciliation?: OfflineMutation["reconciliation"]): Promise<string>;
  flush(): Promise<void>;
  retry(id: string, replacementInput?: unknown, reconciliation?: OfflineMutation["reconciliation"]): Promise<void>;
  discard(id: string): Promise<void>;
  clear(): Promise<void>;
  subscribe(listener: (items: readonly OfflineMutation[]) => void): () => void;
  dispose(): void;
}

export declare function createOfflineQueue(options: OfflineQueueOptions): OfflineQueue;
export declare function renderOfflineQueue(items: readonly OfflineMutation[]): string;
export interface OfflineConflictField { readonly field: string; readonly original: unknown; readonly local: unknown; readonly server: unknown; readonly conflict: boolean; }
export interface OfflineConflictServer { readonly values: Readonly<Record<string, unknown>>; readonly version: string | number; }
export interface OfflineConflictResolverOptions { loadServer(item: OfflineMutation): Promise<OfflineConflictServer>; buildInput(values: Readonly<Record<string, unknown>>, server: OfflineConflictServer, item: OfflineMutation): unknown; }
export declare function compareOfflineConflict(original: Readonly<Record<string, unknown>>, local: Readonly<Record<string, unknown>>, server: Readonly<Record<string, unknown>>): readonly OfflineConflictField[];
export declare function mountOfflineConflictResolver(container: HTMLElement, queue: OfflineQueue, options: OfflineConflictResolverOptions): () => void;
