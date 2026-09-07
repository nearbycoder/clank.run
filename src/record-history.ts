import { createApi, createSyncClient, defineBackend, openBackend, type DatabaseSchema, type DocumentRevisionCursor, type SyncClientOptions, type WriteDatabase } from "./backend.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
export interface RecordChange { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown; }
export interface RecordComparison { changes: readonly RecordChange[]; truncated: boolean; }
export interface HistoryEntry { cursor: DocumentRevisionCursor; operation: string; recordedAt: number; document: Readonly<Record<string, unknown>>; }
export interface HistoryPage { current: Readonly<Record<string, unknown>> | null; entries: readonly HistoryEntry[]; next: DocumentRevisionCursor | null; }
export interface RecordHistoryOptions { path: string; auth: AuthDefinition<any>; schema: DatabaseSchema<any>; tables: readonly string[]; prefix?: string; validateRestore?: (document: Readonly<Record<string, unknown>>, context: { table: string; db: WriteDatabase<any> }) => void; }
export interface RecordHistoryService { handle(request: Request): Promise<Response>; close(): void; }
export interface RecordHistoryClient { list(table: string, id: string, before?: DocumentRevisionCursor): Promise<HistoryPage>; restore(table: string, id: string, cursor: DocumentRevisionCursor, expectedVersion: number | null): Promise<unknown>; }

/** Bounded structural comparison with JSON Pointer paths; arrays remain whole-value changes. */
export function compareRecordVersions(before: unknown, after: unknown, maximum = 100): RecordComparison {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw new RangeError("Compare at most 1–1,000 changed fields.");
  const detach = (value: unknown) => { const text = JSON.stringify(value); if (text === undefined || new TextEncoder().encode(text).length > 65536) throw new TypeError("Compare JSON values up to 64 KiB each."); return JSON.parse(text); };
  const left = detach(before), right = detach(after), changes: RecordChange[] = []; let truncated = false;
  const missing = Symbol("missing"), object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  const visit = (a: any, b: any, path: string, depth: number) => {
    if (a === b || (a !== missing && b !== missing && JSON.stringify(a) === JSON.stringify(b))) return;
    if (object(a) && object(b) && depth < 16) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { visit(Object.hasOwn(a, key) ? a[key] : missing, Object.hasOwn(b, key) ? b[key] : missing, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1); if (truncated) break; }
      return;
    }
    if (changes.length >= maximum) { truncated = true; return; }
    changes.push(Object.freeze({ path, kind: a === missing ? "added" : b === missing ? "removed" : "changed", ...(a === missing ? {} : { before: a }), ...(b === missing ? {} : { after: b }) }));
  };
  visit(left, right, "", 0); return Object.freeze({ changes: Object.freeze(changes), truncated });
}

/** Authorized record-history RPC/MCP controls backed by the existing SQLite revision journal. */
export async function openRecordHistory(options: RecordHistoryOptions): Promise<RecordHistoryService> {
  const tables = [...options.tables];
  if (!tables.length || tables.length > 30 || new Set(tables).size !== tables.length || tables.some(table => options.schema.tables[table]?.ownership !== "user")) throw new TypeError("Choose 1–30 unique owned tables for history access.");
  const tableSchema = s.enum(tables as [string, ...string[]]), cursor = s.object({ revision: s.number({ integer: true, min: 1, max: Number.MAX_SAFE_INTEGER }), sequence: s.number({ integer: true, min: 0, max: Number.MAX_SAFE_INTEGER - 1 }) });
  const backend = defineBackend({ schema: options.schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: { table: tableSchema, id: s.string({ min: 1, max: 200 }), before: s.optional(cursor) }, handler: ({ db }, { table, id, before }) => {
      const source = db.table(table), entries = source.history(id, { before, limit: 25 });
      return { current: source.get(id), entries, next: entries.length === 25 ? entries[24]!.cursor : null };
    } }),
    restore: mutation({ args: { table: tableSchema, id: s.string({ min: 1, max: 200 }), cursor, expectedVersion: s.nullable(s.number({ integer: true, min: 1 })) }, handler: ({ db }, { table, id, cursor, expectedVersion }) => {
      const source = db.table(table), selected = source.history(id, { before: { revision: cursor.revision, sequence: cursor.sequence + 1 }, limit: 1 })[0];
      if (!selected || selected.cursor.revision !== cursor.revision || selected.cursor.sequence !== cursor.sequence) throw new Error("Selected revision is no longer retained in the recovery window.");
      const validated = options.validateRestore?.(selected.document, { table, db });
      if (validated && typeof (validated as any).then === "function") throw new TypeError("Restore validation must be synchronous inside the transaction.");
      return source.restore(id, cursor, { ifVersion: expectedVersion });
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/history" });
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createRecordHistoryClient(options: SyncClientOptions = {}): RecordHistoryClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/history").replace(/\/$/, "");
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: (table, id, before) => transport.query(api.list, { table, id, before }), restore: (table, id, cursor, expectedVersion) => transport.mutate(api.restore, { table, id, cursor, expectedVersion }) };
}
/** Select a prior version, compare it with current data, then explicitly restore with revision fencing. */
export function mountRecordHistory(container: HTMLElement, client: RecordHistoryClient, table: string, id: string): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), select = document.createElement("select"), status = document.createElement("p"), comparison = document.createElement("pre"), restore = document.createElement("button"), more = document.createElement("button"), refresh = document.createElement("button");
  panel.setAttribute("aria-label", "Record history"); select.setAttribute("aria-label", "Historical version"); status.setAttribute("role", "status"); comparison.style.overflowX = "auto";
  restore.type = more.type = refresh.type = "button"; restore.textContent = "Restore selected version"; more.textContent = "Load older versions"; refresh.textContent = "Refresh history";
  let entries: HistoryEntry[] = [], current: HistoryPage["current"] = null, next: DocumentRevisionCursor | null = null, closed = false, busy = false;
  const render = () => {
    const selected = entries[Number(select.value)]; restore.disabled = !selected;
    if (!selected) { comparison.textContent = "No retained versions."; return; }
    const business = (value: Readonly<Record<string, unknown>> | null) => value === null ? null : Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")));
    try { const diff = compareRecordVersions(business(current), business(selected.document)); comparison.textContent = diff.changes.length ? JSON.stringify(diff, null, 2) : "No content changes."; }
    catch { comparison.textContent = "This record is too large for an inline comparison."; }
  };
  const load = async (append = false) => {
    const page = await client.list(table, id, append ? next ?? undefined : undefined); if (closed) return;
    current = page.current; entries = append ? [...entries, ...page.entries] : [...page.entries]; next = page.next; more.hidden = !next; select.replaceChildren();
    entries.forEach((entry, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `${entry.operation} · ${new Date(entry.recordedAt).toISOString()} · v${entry.document._version}`; select.append(option); });
    render(); status.textContent = `${entries.length} retained versions. Current record ${current ? `v${current._version}` : "deleted"}.`;
  };
  const run = async (action: () => Promise<void>) => { if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); try { await action(); } catch { if (!closed) status.textContent = "Record changed or restore was rejected. Refresh before trying again."; } finally { busy = false; panel.removeAttribute("aria-busy"); } };
  select.addEventListener("change", render); refresh.addEventListener("click", () => { void run(() => load()); }); more.addEventListener("click", () => { if (next) void run(() => load(true)); });
  restore.addEventListener("click", () => { const selected = entries[Number(select.value)]; if (selected) void run(async () => { await client.restore(table, id, selected.cursor, current ? Number(current._version) : null); await load(); if (!closed) status.textContent = "Selected content restored as a new version."; }); });
  panel.append(refresh, status, select, comparison, restore, more); container.append(panel); void run(() => load()); return () => { closed = true; panel.remove(); };
}
