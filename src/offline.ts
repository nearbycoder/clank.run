import { functionPath, type FunctionReference, type SyncClient } from "./backend.ts";

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

const localLocks = new Map<string, Promise<unknown>>();
const limit = 1024 * 1024;
/** Durable, ordered mutations with explicit conflict handling and account-bound server receipts. */
export function createOfflineQueue(options: OfflineQueueOptions): OfflineQueue {
  if (!options.namespace || options.namespace.length > 200 || !options.userId || options.userId.length > 200) throw new TypeError("A bounded application namespace and user ID are required.");
  const key = `clank.offline.v1:${encodeURIComponent(options.namespace)}:${encodeURIComponent(options.userId)}`;
  const listeners = new Set<(items: readonly OfflineMutation[]) => void>();
  let disposed = false;
  const read = (): OfflineMutation[] => {
    const serialized = options.storage.getItem(key);
    if (serialized === null) return [];
    if (new TextEncoder().encode(serialized).length > limit) throw new Error("Offline queue exceeds its storage limit.");
    const rows = JSON.parse(serialized);
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row || typeof row.id !== "string" || !/^\d{13}\.[0-9a-f-]{36}$/i.test(row.id)
      || typeof row.path !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(row.path)
      || !["pending", "sending", "conflict", "failed"].includes(row.status)
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !Number.isSafeInteger(row.nextAttemptAt) || row.nextAttemptAt < 0
      || (row.errorCode !== undefined && (typeof row.errorCode !== "string" || row.errorCode.length > 100)))
      || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Offline queue storage is invalid.");
    return rows;
  };
  const snapshot = () => Object.freeze(read().map(row => Object.freeze(row)));
  const write = (rows: readonly OfflineMutation[]) => {
    const serialized = JSON.stringify(rows);
    if (rows.length > 100 || new TextEncoder().encode(serialized).length > limit) throw new Error("Offline queue is full.");
    options.storage.setItem(key, serialized);
    for (const listener of listeners) { try { listener(snapshot()); } catch { /* Views do not alter durable work. */ } }
  };
  const authorize = () => {
    if (disposed) throw new Error("Offline queue is disposed.");
    if (options.currentUser() !== options.userId) throw new Error("Offline queue belongs to another account.");
  };
  const locked = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const operation = async () => { authorize(); return work(); };
    // All writes and sends share a cross-tab lock when the browser supplies Web Locks.
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(key, operation);
    const previous = localLocks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    localLocks.set(key, pending);
    try { return await pending; } finally { if (localLocks.get(key) === pending) localLocks.delete(key); }
  };
  const freshId = () => `${Date.now()}.${crypto.randomUUID()}`;
  const clone = (input: unknown) => JSON.parse(JSON.stringify(input ?? {}));
  const queue: OfflineQueue = {
    snapshot,
    enqueue(reference, input) { return locked(() => {
      const path = functionPath(reference);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(path)) throw new TypeError("Invalid offline mutation path.");
      const id = freshId();
      write([...read(), { id, path, input: clone(input), status: "pending", attempts: 0, nextAttemptAt: 0 }]);
      return id;
    }); },
    flush() { return locked(async () => {
      while (!disposed && options.currentUser() === options.userId && (options.online?.() ?? globalThis.navigator?.onLine ?? true)) {
        const rows = read();
        const first = rows[0];
        if (!first || first.status === "conflict" || first.status === "failed" || first.nextAttemptAt > Date.now()) return;
        rows[0] = { ...first, status: "sending", attempts: first.attempts + 1 };
        write(rows);
        try {
          await options.client.mutateOnce({ kind: "mutation", path: first.path }, first.input, { key: first.id, userId: options.userId });
        } catch (error) {
          const failure = error as { status?: number; code?: string };
          const retryable = failure.status === undefined || failure.status >= 500 || failure.status === 408 || failure.status === 429;
          const code = typeof failure.code === "string" && /^[A-Z0-9_]{1,100}$/.test(failure.code) ? failure.code : "NETWORK_FAILED";
          rows[0] = { ...rows[0]!, status: retryable ? "pending" : failure.status === 409 && code !== "MUTATION_KEY_REUSED" ? "conflict" : "failed",
            errorCode: code, nextAttemptAt: retryable ? Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(first.attempts, 6)) : 0 };
          write(rows); return;
        }
        write(rows.slice(1));
      }
    }); },
    retry(id, replacementInput) { return locked(() => {
      const rows = read(); const index = rows.findIndex(row => row.id === id); const row = rows[index];
      if (!row) throw new Error("Queued mutation not found.");
      if (row.status === "failed") throw new Error("Reconcile a failed mutation before discarding it and creating another.");
      if (replacementInput !== undefined && row.status !== "conflict") throw new Error("Only a rolled-back conflict can replace its input.");
      rows[index] = { ...row, ...(replacementInput === undefined ? {} : { id: freshId(), input: clone(replacementInput), attempts: 0 }),
        status: "pending", nextAttemptAt: 0, errorCode: undefined };
      write(rows);
    }); },
    discard(id) { return locked(() => write(read().filter(row => row.id !== id))); },
    clear() { return locked(() => write([])); },
    subscribe(listener) { authorize(); listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; listeners.clear(); },
  };
  read();
  return queue;
}

/** Accessible metadata-only queue view; application inputs and server exception text are omitted. */
export function renderOfflineQueue(items: readonly OfflineMutation[]): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<section aria-label="Pending changes"><h2>Pending changes</h2><p>${escape(items.length)} queued</p><ol>${items.map(item => `<li><strong>${escape(item.path)}</strong> — ${escape(item.status)}${item.errorCode ? ` (${escape(item.errorCode)})` : ""}</li>`).join("")}</ol></section>`;
}
