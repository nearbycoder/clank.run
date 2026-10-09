import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions, type TableName, type TableValue, type TableOwned } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, SOURCE_SEARCH_FTS, bootstrapSourceSearch, bootstrapSourceSearchFTS, parseSearchBinding, projectSearchRecord, sourceSearchMatches, sourceSearchTable, type SQLiteSearchBinding, type SQLiteInternal } from "./sqlite-internal.ts";
import { featureInput, featureTransport, requireFeatureAccess, type FeatureQuery } from "./feature-service.ts";

export interface SearchRecord { readonly scope: string; readonly id: string; readonly title: string; readonly body: string; }
export interface SearchHit { readonly id: string; readonly title: string; readonly snippet: string; readonly score: number; }
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly total: number; readonly truncated: boolean; }
export interface SearchOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCandidates?: number; maxScopeRecords?: number;
  source?: never;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, scope: string): boolean;
  /** Optional synchronous per-record policy, evaluated before ranking or snippet creation. */
  authorizeRecord?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Pick<SearchRecord, "scope" | "id">): boolean;
}
type StringField<Value> = { [Key in keyof Value & string]: Value[Key] extends string ? Key : never }[keyof Value & string];
interface RuntimeSearchSource { name: string; table: string; title: string; body: string; scope: "owner" | { field: string }; maxRecords?: number; maxBytes?: number; }
export type SearchSource<Schema extends DatabaseSchema<any>> = {
  [Name in TableName<Schema>]: {
    name: string; table: Name; title: StringField<TableValue<Schema["tables"][Name]>>; body: StringField<TableValue<Schema["tables"][Name]>>;
    maxRecords?: number; maxBytes?: number;
  } & (TableOwned<Schema["tables"][Name]> extends true ? { scope: "owner" } : { scope: { field: StringField<TableValue<Schema["tables"][Name]>> } })
}[TableName<Schema>];
export interface SourceSearchOptions<Schema extends DatabaseSchema<any>> extends Omit<SearchOptions<Schema>, "schema" | "source"> { schema: Schema; source: SearchSource<Schema>; }
export interface SearchRebuildProgress { readonly generation: string; readonly revision: number; readonly status: "building" | "ready"; readonly cursor: string; readonly processed: number; }
export interface SearchIndexDiagnostic extends SearchRebuildProgress {
  readonly indexedRecords: number; readonly indexedBytes: number; readonly scanned: number;
  readonly missing: number; readonly stale: number; readonly orphan: number; readonly duplicate: number; readonly nextCursor: string | null;
}
export interface SourceSearchService {
  handle(request: Request): Promise<Response>;
  /** Trusted server-only. Omit ifRevision to resume; supply a current ready revision to start repair. */
  rebuild(options?: { batchSize?: number; ifRevision?: number }): SearchRebuildProgress;
  /** Trusted server-only, bounded diagnosis; no source values are returned. */
  inspect(options?: { cursor?: string; limit?: number }): SearchIndexDiagnostic;
  /** Drain writers first. A generation fence prevents detaching a replacement binding. */
  detach(ifGeneration: string): void;
  close(): void;
}
export interface SearchService {
  handle(request: Request): Promise<Response>;
  /** Trusted server-only indexing; never exposed as an HTTP mutation. */
  upsert(record: SearchRecord): void;
  remove(scope: string, id: string): boolean;
  close(): void;
}
export interface SearchClient { search(scope: string, text: string, limit?: number): Promise<SearchResult>; }

// unicode61 folds Latin accents. Keep original text for display and convert the
// normalized match offset back to the original UTF-16 coordinate for snippets.
function searchFold(value: string): string { return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(); }
function originalOffset(value: string, offset: number): number {
  let folded = 0, original = 0;
  for (const character of value) {
    const length = searchFold(character).length;
    if (length && folded + length > offset) return original;
    folded += length; original += character.length;
  }
  return original;
}

/** Durable SQLite FTS candidates, current scope/record authorization, then authorized-only ranking. */
export async function openSearch<Schema extends DatabaseSchema<any>>(options: SourceSearchOptions<Schema>): Promise<SourceSearchService>;
export async function openSearch<Schema extends DatabaseSchema<any>>(options: SearchOptions<Schema>): Promise<SearchService>;
export async function openSearch(options: Omit<SearchOptions, "source"> & { source?: RuntimeSearchSource }): Promise<SearchService | SourceSearchService> {
  const maximum = options.maxCandidates ?? 5000, scopeMaximum = options.maxScopeRecords ?? 50000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50000 || !Number.isSafeInteger(scopeMaximum) || scopeMaximum < maximum || scopeMaximum > 50000 || typeof options.authorize !== "function") throw new TypeError("Search needs authorization and bounded candidate/scope limits.");
  const schema = options.schema ?? defineDatabase({ searchServiceState: defineTable({ generation: s.number() }) });
  const binding = options.source ? createSourceBinding(schema, options.source, scopeMaximum) : undefined;
  const fts = binding ? SOURCE_SEARCH_FTS : "clank_search_fts";
  const indexClause = binding ? "index_name=? AND " : "";
  const indexParameters = binding ? [binding.name] : [];
  let native: SQLiteInternal;
  let generation: string;
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query }) => ({
    search: query({ args: { scope: s.string({ min: 1, max: 200 }), text: s.string({ min: 1, max: 500 }), limit: s.default(s.number({ integer: true, min: 1, max: 100 }), 20) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(options.authorize(context as any, input.scope));
      if (binding) {
        requireFeatureAccess(binding.scope !== "owner" || context.auth.user?.id === input.scope);
        const current = native.prepare("SELECT generation,status,definition FROM clank_source_search_indexes WHERE name=?").get(binding.name);
        if (current?.generation !== generation || current.status !== "ready" || current.definition !== JSON.stringify(binding)) throw new BackendActionError(503, "SEARCH_SOURCE_UNAVAILABLE", "Source-search index is detached or rebuilding.");
      }
      // This bound concerns the entire scope, independent of search terms or
      // match visibility. Never truncate a raw match list before checking ACLs.
      const count = Number(native.prepare(`SELECT count(*) AS count FROM ${fts} WHERE ${indexClause}scope = ?`).get(...indexParameters, input.scope)?.count ?? 0);
      if (count > scopeMaximum) throw new BackendActionError(503, "SEARCH_SCOPE_CAPACITY", "Search scope exceeds its configured capacity; rebuild or partition the index.");
      // Let unicode61 tokenize the original words. Its diacritic rules differ
      // across scripts; stripping every mark here would miss Greek/Indic terms.
      const words = [...new Set(input.text.normalize("NFC").match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])];
      const terms = [...new Set(words.map(searchFold))];
      if (!terms.length || terms.length > 10) return featureInput("Search requires 1–10 words.");
      const expression = words.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      const rows = native.prepare(`SELECT rowid, scope, id FROM ${fts} WHERE ${fts} MATCH ? AND ${indexClause}scope = ? ORDER BY rowid LIMIT ?`).all(expression, ...indexParameters, input.scope, scopeMaximum);
      const authorized: SearchHit[] = [];
      const acceptedIds = new Set<string>();
      let scannedBytes = 0, byteLimit = false, candidateLimit = false;
      for (const row of rows) {
        if (options.authorizeRecord) {
          const allowed = options.authorizeRecord(context as any, row as unknown as Pick<SearchRecord, "scope" | "id">);
          if (allowed !== true) { void Promise.resolve(allowed).catch(() => undefined); continue; }
        }
        const record = native.prepare(`SELECT scope,id,title,body${binding ? ",source_version" : ""} FROM ${fts} WHERE rowid = ?`).get(row.rowid) as unknown as SearchRecord & { source_version?: number };
        if (binding) {
          const source = context.db.table(binding.table).get(record.id as any) as Record<string, unknown> | null;
          if (!source || source._version !== Number(record.source_version) || source[binding.title] !== record.title || source[binding.body] !== record.body
            || (binding.scope === "owner" ? source._ownerId : source[binding.scope.field]) !== record.scope) continue;
          if (acceptedIds.has(record.id)) continue;
        }
        if (authorized.length === maximum) { candidateLimit = true; break; }
        scannedBytes += record.title.length * 2 + record.body.length * 2;
        if (scannedBytes > 16 * 1024 * 1024) { byteLimit = true; break; }
        // Never use global BM25 statistics: inaccessible documents cannot influence scores.
        const title = searchFold(record.title), body = searchFold(record.body);
        let score = 0;
        for (const term of terms) { score += title.split(term).length * 4 - 4; score += body.split(term).length - 1; }
        const match = Math.min(...terms.map(term => body.indexOf(term)).filter(index => index >= 0));
        const position = Number.isFinite(match) ? Math.max(0, originalOffset(record.body, match) - 60) : 0;
        authorized.push({ id: record.id, title: record.title, snippet: record.body.slice(position, position + 240), score });
        acceptedIds.add(record.id);
      }
      authorized.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      return { hits: authorized.slice(0, input.limit), total: authorized.length, truncated: byteLimit || candidateLimit || authorized.length > input.limit };
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/search", maxCacheEntries: 0, agent: false });
  native = (runtime.database as any)[SQLITE_INTERNAL];
  if (binding) {
    try {
      generation = native.transaction(changes => {
        bootstrapSourceSearch(native);
        bootstrapSourceSearchFTS(native);
        const definition = JSON.stringify(binding), prior = native.prepare("SELECT definition,generation FROM clank_source_search_indexes WHERE name=?").get(binding.name);
        if (prior) { if (prior.definition !== definition) throw new Error("Source-search binding changed; drain writers and detach before replacing it."); return String(prior.generation); }
        if (Number(native.prepare("SELECT count(*) AS records FROM clank_source_search_indexes").get()?.records) >= 16) throw new RangeError("At most 16 source-search indexes may be registered.");
        if (Number(native.prepare(`SELECT count(*) AS records FROM ${sourceSearchTable(binding)}`).get()?.records) > binding.maxRecords) throw new RangeError("Source-search source exceeds its configured record capacity.");
        const id = crypto.randomUUID();
        native.prepare("INSERT INTO clank_source_search_indexes(name,definition,generation,revision,cursor,status) VALUES(?,?,?,1,'','building')").run(binding.name, definition, id);
        changes.record("__search", binding.name); return id;
      });
      return linkedSearchService(native, binding, generation, request => runtime.handle(request), () => runtime.close());
    } catch (error) { runtime.close(); throw error; }
  }
  try { native.exec("CREATE VIRTUAL TABLE IF NOT EXISTS clank_search_fts USING fts5(scope UNINDEXED, id UNINDEXED, title, body, tokenize = 'unicode61')"); }
  catch (error) { runtime.close(); throw error; }
  const validate = (scope: string, id: string) => { if (typeof scope !== "string" || !scope || scope.length > 200 || typeof id !== "string" || !id || id.length > 200) throw new TypeError("Search scope and ID must contain 1–200 characters."); };
  return {
    handle: request => runtime.handle(request),
    upsert(record) {
      validate(record.scope, record.id);
      if (typeof record.title !== "string" || typeof record.body !== "string" || new TextEncoder().encode(record.title).length > 1000 || new TextEncoder().encode(record.body).length > 1024 * 1024) throw new RangeError("Search title/body exceed 1 KiB/1 MiB limits.");
      native.transaction(changes => {
        const existing = native.prepare("SELECT rowid FROM clank_search_fts WHERE scope = ? AND id = ? LIMIT 1").get(record.scope, record.id);
        if (!existing && Number(native.prepare("SELECT count(*) AS count FROM clank_search_fts WHERE scope = ?").get(record.scope)?.count ?? 0) >= scopeMaximum) throw new RangeError("Search scope exceeds its configured record capacity.");
        native.prepare("DELETE FROM clank_search_fts WHERE scope = ? AND id = ?").run(record.scope, record.id); native.prepare("INSERT INTO clank_search_fts(scope,id,title,body) VALUES(?,?,?,?)").run(record.scope, record.id, record.title, record.body); changes.record("__search", record.id);
      });
    },
    remove(scope, id) { validate(scope, id); return native.transaction(changes => { const result = native.prepare("DELETE FROM clank_search_fts WHERE scope = ? AND id = ?").run(scope, id); if (Number(result.changes)) changes.record("__search", id); return Number(result.changes) > 0; }); },
    close: () => runtime.close(),
  };
}
function createSourceBinding(schema: DatabaseSchema<any>, source: RuntimeSearchSource, maxScopeRecords: number): SQLiteSearchBinding {
  if (!source || typeof source !== "object" || !Object.hasOwn(schema.tables, source.table)) throw new TypeError("Source-search requires a declared application table.");
  const table = schema.tables[source.table];
  const scope = source.scope === "owner" ? "owner" : { field: source.scope?.field };
  const binding = parseSearchBinding(JSON.stringify({ version: 1, name: source.name, table: source.table, title: source.title, body: source.body, scope, owned: table.ownership === "user", maxRecords: source.maxRecords ?? 50000, maxBytes: source.maxBytes ?? 16 * 1024 * 1024, maxScopeRecords }));
  for (const field of [binding.title, binding.body, ...(scope === "owner" ? [] : [scope.field])]) {
    const json = Object.hasOwn(table.fields, field) ? table.fields[field].toJSONSchema() : undefined;
    if (!json || json.optional === true || Object.hasOwn(json, "default") || !(json.type === "string" || typeof json.const === "string")) throw new TypeError("Source-search fields must be declared required strings.");
  }
  return binding;
}
function linkedSearchService(native: SQLiteInternal, binding: SQLiteSearchBinding, generation: string, handle: SourceSearchService["handle"], close: () => void): SourceSearchService {
  const current = () => {
    const row = native.prepare("SELECT * FROM clank_source_search_indexes WHERE name=?").get(binding.name);
    if (!row || row.generation !== generation || row.definition !== JSON.stringify(binding)) throw new Error("Source-search binding is detached or replaced.");
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !["building", "ready"].includes(String(row.status)) || typeof row.cursor !== "string" || row.cursor.length > 200) throw new Error("Invalid source-search progress.");
    return row;
  };
  const progress = (row: Record<string, unknown>, processed = 0): SearchRebuildProgress => ({ generation, revision: Number(row.revision), status: row.status as "building" | "ready", cursor: String(row.cursor), processed });
  const bound = (value: number, maximum: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid source-search batch limit."); return value; };
  return {
    handle, close,
    rebuild(options = {}) {
      const batchSize = bound(options.batchSize ?? 250, 1000), expected = options.ifRevision;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) throw new TypeError("Invalid source-search revision fence.");
      return native.transaction(changes => {
        let row = current();
        if (expected !== undefined) {
          if (row.status !== "ready" || row.revision !== expected) throw new Error("Source-search revision changed; inspect before starting repair.");
          native.prepare(`DELETE FROM ${SOURCE_SEARCH_FTS} WHERE index_name=?`).run(binding.name);
          native.prepare("UPDATE clank_source_search_indexes SET cursor='',status='building' WHERE name=?").run(binding.name);
          row = current();
        } else if (row.status === "ready") return progress(row);
        const records = native.prepare(`SELECT _id FROM ${sourceSearchTable(binding)} WHERE _id>? ORDER BY _id LIMIT ?`).all(row.cursor, batchSize + 1);
        const selected = records.slice(0, batchSize);
        for (const source of selected) projectSearchRecord(native, binding, String(source._id));
        native.prepare("UPDATE clank_source_search_indexes SET cursor=?,status=?,revision=revision+1 WHERE name=?")
          .run(selected.length ? String(selected.at(-1)!._id) : row.cursor, records.length > batchSize ? "building" : "ready", binding.name);
        changes.record("__search", binding.name); return progress(current(), selected.length);
      });
    },
    inspect(options = {}) {
      const limit = bound(options.limit ?? 250, 1000), cursor = options.cursor ?? "";
      if (typeof cursor !== "string" || cursor.length > 200) throw new TypeError("Invalid source-search diagnostic cursor.");
      return native.transaction(() => {
        const row = current();
        const usage = native.prepare(`SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM ${SOURCE_SEARCH_FTS} WHERE index_name=?`).get(binding.name)!;
        const ids = native.prepare(`SELECT _id AS id FROM ${sourceSearchTable(binding)} WHERE _id>? UNION SELECT id FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND id>? ORDER BY id LIMIT ?`).all(cursor, binding.name, cursor, limit + 1);
        let missing = 0, stale = 0, orphan = 0, duplicate = 0;
        for (const id of ids.slice(0, limit)) {
          const source = native.prepare(`SELECT _id,_owner_id,_version,_data FROM ${sourceSearchTable(binding)} WHERE _id=?`).get(id.id);
          const entries = native.prepare(`SELECT * FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND id=? LIMIT 2`).all(binding.name, id.id), indexed = entries[0];
          if (entries.length > 1) duplicate++;
          if (!source) orphan++; else if (!indexed) missing++; else if (!sourceSearchMatches(binding, source, indexed)) stale++;
        }
        return { ...progress(row), indexedRecords: Number(usage.records), indexedBytes: Number(usage.bytes), scanned: Math.min(ids.length, limit), missing, stale, orphan, duplicate, nextCursor: ids.length > limit ? String(ids[limit - 1].id) : null };
      });
    },
    detach(ifGeneration) {
      if (ifGeneration !== generation) throw new Error("Source-search generation fence changed.");
      native.transaction(changes => { current(); native.prepare(`DELETE FROM ${SOURCE_SEARCH_FTS} WHERE index_name=?`).run(binding.name); native.prepare("DELETE FROM clank_source_search_indexes WHERE name=? AND generation=?").run(binding.name, generation); changes.record("__search", binding.name); });
    },
  };
}
export function createSearchClient(options: SyncClientOptions = {}): SearchClient {
  const { client, api } = featureTransport<{ search: FeatureQuery<{ scope: string; text: string; limit: number }, SearchResult> }>(options, "/__clank/search");
  return { search: (scope, text, limit = 20) => client.query(api.search, { scope, text, limit }) };
}
export function mountSearch(container: HTMLElement, client: SearchClient, options: { scope(): string; open(id: string): void }): () => void {
  const document = container.ownerDocument, form = document.createElement("form"), input = document.createElement("input"), submit = document.createElement("button"), status = document.createElement("p"), results = document.createElement("ol");
  form.setAttribute("aria-label", "Search records"); input.type = "search"; input.maxLength = 500; input.setAttribute("aria-label", "Search words"); submit.textContent = "Search"; submit.type = "submit"; status.setAttribute("role", "status");
  form.style.maxWidth = "100%"; input.style.maxWidth = "100%"; input.style.boxSizing = "border-box"; results.style.overflowWrap = "anywhere";
  let closed = false, generation = 0;
  form.addEventListener("submit", async event => {
    event.preventDefault(); const expected = ++generation, scope = options.scope(); submit.disabled = true; results.replaceChildren(); status.textContent = "Searching…";
    const current = () => !closed && expected === generation;
    try {
      const result = await client.search(scope, input.value);
      if (!current()) return;
      if (options.scope() !== scope) { status.textContent = "Search scope changed; search again."; return; }
      for (const hit of result.hits) {
        const row = document.createElement("li"), link = document.createElement("button"), snippet = document.createElement("p"); link.type = "button"; link.textContent = hit.title; link.style.overflowWrap = "anywhere";
        link.addEventListener("click", () => { if (!current()) return; if (options.scope() !== scope) { results.replaceChildren(); status.textContent = "Search scope changed; search again."; return; } options.open(hit.id); });
        snippet.textContent = hit.snippet; row.append(link, snippet); results.append(row);
      }
      status.textContent = `${result.hits.length} results${result.truncated ? "; narrow your search for more precise results" : ""}.`;
    } catch { if (current()) status.textContent = "Search unavailable or access revoked."; }
    finally { if (current()) submit.disabled = false; }
  });
  form.append(input, submit, status, results); container.append(form); return () => { closed = true; generation++; form.remove(); };
}
