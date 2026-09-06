import { type FunctionReference, type SyncClient } from "./backend.js";

export type OfflineMutationStatus = "pending" | "sending" | "conflict" | "failed";
export interface OfflineMutation {
  readonly id: string;
  readonly path: string;
  readonly input: unknown;
  readonly status: OfflineMutationStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly errorCode?: string;
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
  enqueue<Input>(reference: FunctionReference<"mutation", Input, any>, input: Input): Promise<string>;
  flush(): Promise<void>;
  retry(id: string, replacementInput?: unknown): Promise<void>;
  discard(id: string): Promise<void>;
  clear(): Promise<void>;
  subscribe(listener: (items: readonly OfflineMutation[]) => void): () => void;
  dispose(): void;
}

export declare function createOfflineQueue(options: OfflineQueueOptions): OfflineQueue;
export declare function renderOfflineQueue(items: readonly OfflineMutation[]): string;
