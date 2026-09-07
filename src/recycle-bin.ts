import { createApi, createSyncClient, defineBackend, openBackend, type DatabaseSchema, type DocumentRevisionCursor, type SyncClientOptions, type WriteDatabase } from "./backend.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
export interface TrashItem { id: string; table: string; label: string; deletedAt: number; expiresAt: number; cursor: DocumentRevisionCursor; }
export interface TrashPage { items: readonly TrashItem[]; next: DocumentRevisionCursor | null; }
export interface RecycleBinOptions { path: string; auth: AuthDefinition<any>; schema: DatabaseSchema<any>; tables: Readonly<Record<string, { labelField: string }>>; retentionMs?: number; prefix?: string; historyRetentionRevisions?: number; validateRestore?: (document: Readonly<Record<string, unknown>>, context: { table: string; db: WriteDatabase<any> }) => void; }
export interface RecycleBinService { handle(request: Request): Promise<Response>; purgeExpired(limit?: number): number; close(): void; }
export interface RecycleBinClient {
  list(table: string, before?: DocumentRevisionCursor): Promise<TrashPage>;
  trash(table: string, id: string, expectedVersion: number): Promise<boolean>;
  restore(table: string, id: string, cursor: DocumentRevisionCursor): Promise<unknown>;
  purge(table: string, id: string, cursor: DocumentRevisionCursor): Promise<boolean>;
}
/** Restore original IDs and ownership through the native revision store, without a second copy of business data. */
export async function openRecycleBin(options: RecycleBinOptions): Promise<RecycleBinService> {
  const names = Object.keys(options.tables), retention = options.retentionMs ?? 30 * 86400000;
  if (!names.length || names.length > 30 || names.some(name => options.schema.tables[name]?.ownership !== "user" || !Object.hasOwn(options.schema.tables[name].fields, options.tables[name]!.labelField)) || !Number.isSafeInteger(retention) || retention < 1000 || retention > 90 * 86400000) throw new TypeError("Select owned tables with valid label fields and a retention window up to 90 days.");
  const tableSchema = s.enum(names as [string, ...string[]]), cursorSchema = s.object({ revision: s.number({ integer: true, min: 1 }), sequence: s.number({ integer: true, min: 0 }) });
  const args = { table: tableSchema, id: s.string({ min: 1, max: 200 }), cursor: cursorSchema };
  const backend = defineBackend({ schema: options.schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: { table: tableSchema, before: s.optional(cursorSchema), clock: s.number({ integer: true }) }, handler: ({ db }, { table, before }) => {
      const source = db.table(table), history = source.history({ before, limit: 100 }), now = Date.now();
      const items = history.filter(entry => entry.operation === "delete" && entry.recordedAt + retention > now && !source.get(entry.document._id) && source.history(entry.document._id, { limit: 1 })[0]?.cursor.revision === entry.cursor.revision && source.history(entry.document._id, { limit: 1 })[0]?.cursor.sequence === entry.cursor.sequence)
        .map(entry => ({ id: entry.document._id, table, label: String(entry.document[options.tables[table]!.labelField] ?? entry.document._id).slice(0, 200), deletedAt: entry.recordedAt, expiresAt: entry.recordedAt + retention, cursor: entry.cursor }));
      return { items, next: history.length === 100 ? history[history.length - 1]!.cursor : null };
    } }),
    trash: mutation({ args: { table: tableSchema, id: s.string({ min: 1, max: 200 }), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db }, { table, id, expectedVersion }) => db.table(table).delete(id, { ifVersion: expectedVersion }) }),
    restore: mutation({ args, handler: ({ db }, { table, id, cursor }) => {
      const source = db.table(table), latest = source.history(id, { limit: 1 })[0];
      if (!latest || latest.operation !== "delete" || latest.cursor.revision !== cursor.revision || latest.cursor.sequence !== cursor.sequence || latest.recordedAt + retention <= Date.now()) throw new Error("This deleted snapshot is expired or no longer available.");
      const validation = options.validateRestore?.(latest.document, { table, db });
      if (validation && typeof (validation as any).then === "function") throw new TypeError("Restore validation must be synchronous inside the transaction.");
      return source.restore(id, cursor, { ifVersion: null });
    } }),
    purge: mutation({ args, handler: ({ db }, { table, id, cursor }) => db.table(table).purgeDeleted(id, cursor) }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/trash", historyRetentionRevisions: options.historyRetentionRevisions });
  return {
    handle: request => runtime.handle(request), close: () => runtime.close(),
    purgeExpired(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Sweep 1–1,000 expired records per call.");
      const rows = runtime.database[SQLITE_INTERNAL].prepare(`SELECT r.table_name,r.document_id,r.owner_id,r.revision,r.sequence FROM clank_document_revisions r WHERE r.operation='delete' AND r.recorded_at<=? AND r.table_name IN (${names.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM clank_document_revisions n WHERE n.table_name=r.table_name AND n.document_id=r.document_id AND (n.revision>r.revision OR (n.revision=r.revision AND n.sequence>r.sequence))) ORDER BY r.recorded_at LIMIT ?`).all(Date.now() - retention, ...names, limit);
      let count = 0;
      for (const row of rows) count += Number(runtime.database.transaction(db => { const source = db.table(String(row.table_name)), id = String(row.document_id), latest = source.history(id, { limit: 1 })[0]; if (source.get(id) || !latest || latest.cursor.revision !== Number(row.revision) || latest.cursor.sequence !== Number(row.sequence)) return false; return source.purgeDeleted(id, { revision: Number(row.revision), sequence: Number(row.sequence) }); }, { userId: String(row.owner_id) }));
      return count;
    },
  };
}
export function createRecycleBinClient(options: SyncClientOptions = {}): RecycleBinClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/trash").replace(/\/$/, "");
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: (table, before) => transport.query(api.list, { table, before, clock: Date.now() }), trash: (table, id, expectedVersion) => transport.mutate(api.trash, { table, id, expectedVersion }), restore: (table, id, cursor) => transport.mutate(api.restore, { table, id, cursor }), purge: (table, id, cursor) => transport.mutate(api.purge, { table, id, cursor }) };
}
/** Paginated deleted records with restore and explicit permanent-deletion acknowledgement. */
export function mountRecycleBin(container: HTMLElement, client: RecycleBinClient, table: string): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), status = document.createElement("p"), list = document.createElement("ul"), more = document.createElement("button");
  panel.setAttribute("aria-label", "Recycle bin"); status.setAttribute("role", "status"); more.type = "button"; more.textContent = "Load older deleted records";
  let closed = false, busy = false, next: DocumentRevisionCursor | null = null;
  const refresh = async (append = false) => {
    const page = await client.list(table, append ? next ?? undefined : undefined); if (closed) return; if (!append) list.replaceChildren();
    next = page.next; more.hidden = next === null;
    for (const item of page.items) {
      const row = document.createElement("li"), title = document.createElement("strong"), expiry = document.createElement("p"), restore = document.createElement("button"), purge = document.createElement("button"), label = document.createElement("label"), confirm = document.createElement("input");
      title.textContent = item.label; expiry.textContent = `Expires ${new Date(item.expiresAt).toISOString()}`; restore.type = purge.type = "button"; restore.textContent = "Restore record"; purge.textContent = "Permanently delete"; purge.disabled = true; confirm.type = "checkbox"; label.append(confirm, document.createTextNode("Delete all retained history for this record")); confirm.addEventListener("change", () => { purge.disabled = !confirm.checked; });
      restore.addEventListener("click", () => { void run(async () => { await client.restore(table, item.id, item.cursor); await refresh(); status.textContent = "Record restored with its original ID."; }); });
      purge.addEventListener("click", () => { if (confirm.checked) void run(async () => { await client.purge(table, item.id, item.cursor); await refresh(); status.textContent = "Retained history deleted."; }); });
      row.append(title, expiry, restore, label, purge); list.append(row);
    }
    if (!list.childElementCount) status.textContent = next ? "No deleted records on this page. Load older records." : "Recycle bin is empty.";
  };
  const run = async (action: () => Promise<void>) => { if (busy || closed) return; busy = true; panel.setAttribute("aria-busy", "true"); try { await action(); } catch { if (!closed) status.textContent = "Record changed or recovery failed. Refresh before retrying."; } finally { busy = false; panel.removeAttribute("aria-busy"); } };
  const reload = document.createElement("button"); reload.type = "button"; reload.textContent = "Refresh recycle bin"; reload.addEventListener("click", () => { void run(() => refresh()); }); more.addEventListener("click", () => { if (next) void run(() => refresh(true)); });
  panel.append(reload, status, list, more); container.append(panel); void run(() => refresh()); return () => { closed = true; panel.remove(); };
}
