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
  const snapshot = () => { authorize(); return Object.freeze(read().map(row => Object.freeze(row))); };
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
    enqueue(reference, input, reconciliation) { return locked(() => {
      const path = functionPath(reference);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(path)) throw new TypeError("Invalid offline mutation path.");
      const id = freshId();
      write([...read(), { id, path, input: clone(input), ...(reconciliation ? { reconciliation: clone(reconciliation) } : {}), status: "pending", attempts: 0, nextAttemptAt: 0 }]);
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
    retry(id, replacementInput, reconciliation) { return locked(() => {
      const rows = read(); const index = rows.findIndex(row => row.id === id); const row = rows[index];
      if (!row) throw new Error("Queued mutation not found.");
      if (row.status === "failed") throw new Error("Reconcile a failed mutation before discarding it and creating another.");
      if (replacementInput !== undefined && row.status !== "conflict") throw new Error("Only a rolled-back conflict can replace its input.");
      rows[index] = { ...row, ...(replacementInput === undefined ? {} : { id: freshId(), input: clone(replacementInput), attempts: 0 }),
        ...(reconciliation ? { reconciliation: clone(reconciliation) } : {}), status: "pending", nextAttemptAt: 0, errorCode: undefined };
      write(rows);
    }); },
    discard(id) { return locked(() => write(read().filter(row => row.id !== id))); },
    clear() { return locked(() => write([])); },
    subscribe(listener) { authorize(); listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; listeners.clear(); },
  };
  authorize();
  read();
  return queue;
}

/** Accessible metadata-only queue view; application inputs and server exception text are omitted. */
export function renderOfflineQueue(items: readonly OfflineMutation[]): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<section aria-label="Pending changes"><h2>Pending changes</h2><p>${escape(items.length)} queued</p><ol>${items.map(item => `<li><strong>${escape(item.path)}</strong> — ${escape(item.status)}${item.errorCode ? ` (${escape(item.errorCode)})` : ""}</li>`).join("")}</ol></section>`;
}

export interface OfflineConflictField { readonly field: string; readonly original: unknown; readonly local: unknown; readonly server: unknown; readonly conflict: boolean; }
export interface OfflineConflictServer { readonly values: Readonly<Record<string, unknown>>; readonly version: string | number; }
export interface OfflineConflictResolverOptions {
  loadServer(item: OfflineMutation): Promise<OfflineConflictServer>;
  /** Include the supplied server version in the optimistic mutation arguments. */
  buildInput(values: Readonly<Record<string, unknown>>, server: OfflineConflictServer, item: OfflineMutation): unknown;
}
const sameConflictValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function compareOfflineConflict(original: Readonly<Record<string, unknown>>, local: Readonly<Record<string, unknown>>, server: Readonly<Record<string, unknown>>): readonly OfflineConflictField[] {
  const fields = [...new Set([...Object.keys(original), ...Object.keys(local), ...Object.keys(server)])];
  if (fields.length > 100) throw new RangeError("Reconcile at most 100 fields.");
  return fields.map(field => ({ field, original: original[field], local: local[field], server: server[field], conflict: !sameConflictValue(local[field], server[field]) && !sameConflictValue(original[field], local[field]) && !sameConflictValue(original[field], server[field]) }));
}

/** Explicit original/local/server comparison. Apply replaces only a rolled-back conflict's queue entry. */
export function mountOfflineConflictResolver(container: HTMLElement, queue: OfflineQueue, options: OfflineConflictResolverOptions): () => void {
  const document = container.ownerDocument, section = document.createElement("section"), status = document.createElement("p"), list = document.createElement("div");
  section.setAttribute("aria-label", "Resolve offline conflicts"); status.setAttribute("role", "status"); section.append(status, list); container.append(section);
  let closed = false, generation = 0;
  const show = async () => {
    const expected = ++generation;
    list.replaceChildren();
    for (const item of queue.snapshot().filter(row => row.status === "conflict")) {
      const card = document.createElement("section"), title = document.createElement("h3"), open = document.createElement("button"); title.textContent = item.path; open.type = "button"; open.textContent = "Compare changes"; card.append(title, open); list.append(card);
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          if (!item.reconciliation) throw new Error("Original and local snapshots are required for comparison.");
          const server = await options.loadServer(item);
          if (closed || expected !== generation) return;
          const fields = compareOfflineConflict(item.reconciliation.original, item.reconciliation.local, server.values), selections = new Map<string, HTMLSelectElement>();
          const table = document.createElement("table"), head = document.createElement("tr");
          for (const label of ["Field", "Original", "Your change", "Server", "Resolution"]) { const cell = document.createElement("th"); cell.textContent = label; head.append(cell); } table.append(head);
          for (const field of fields) {
            const row = document.createElement("tr");
            for (const value of [field.field, field.original, field.local, field.server]) { const cell = document.createElement("td"); cell.textContent = value === undefined ? "(deleted)" : typeof value === "string" ? value : JSON.stringify(value); row.append(cell); }
            const cell = document.createElement("td"), choice = document.createElement("select"); choice.setAttribute("aria-label", `Resolve ${field.field}`);
            for (const [value, label] of [["", "Choose a value"], ["local", "Use your change"], ["server", "Use server"]]) { const option = document.createElement("option"); option.value = value!; option.textContent = label!; choice.append(option); }
            choice.value = field.conflict ? "" : sameConflictValue(field.original, field.local) ? "server" : "local"; selections.set(field.field, choice); cell.append(choice); row.append(cell); table.append(row);
          }
          const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Queue resolved change";
          apply.addEventListener("click", async () => {
            apply.disabled = true;
            try {
              const latest = await options.loadServer(item);
              if (closed || expected !== generation) return;
              if (latest.version !== server.version || !sameConflictValue(latest.values, server.values)) throw new Error("Server data changed. Compare again before resolving.");
              const values: Record<string, unknown> = Object.create(null);
              for (const field of fields) { const selected = selections.get(field.field)!.value; if (!selected) throw new Error("Choose a resolution for every conflicting field."); const value = selected === "local" ? field.local : field.server; if (value !== undefined) values[field.field] = value; }
              await queue.retry(item.id, options.buildInput(values, latest, item), { original: latest.values, local: values });
              if (!closed) { status.textContent = "Resolved change queued. Synchronize to send it."; void show(); }
            } catch (error) { if (!closed) status.textContent = error instanceof Error ? error.message : "Could not reconcile this change."; }
            finally { apply.disabled = false; }
          });
          open.textContent = "Refresh comparison";
          card.replaceChildren(title, table, apply, open);
        } catch (error) { if (!closed) status.textContent = error instanceof Error ? error.message : "Could not load server data."; }
        finally { open.disabled = false; }
      });
    }
    if (!list.childNodes.length) status.textContent = "No offline conflicts.";
  };
  const unsubscribe = queue.subscribe(() => { void show(); }); void show();
  return () => { closed = true; generation++; unsubscribe(); section.remove(); };
}
