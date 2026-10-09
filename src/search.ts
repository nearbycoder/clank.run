import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions, type TableName, type TableValue, type TableOwned } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, SOURCE_SEARCH_FTS, bootstrapSourceSearch, bootstrapSourceSearchFTS, parseSearchBinding, projectSearchRecord, sourceSearchMatches, sourceSearchTable, type SQLiteSearchBinding, type SQLiteInternal } from "./sqlite-internal.ts";
import { featureInput, featureTransport, requireFeatureAccess, type FeatureQuery, type FeatureMutation } from "./feature-service.ts";

export interface SearchRecord { readonly scope: string; readonly id: string; readonly title: string; readonly body: string; }
export interface SearchHit { readonly id: string; readonly title: string; readonly snippet: string; readonly score: number; }
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly total: number; readonly truncated: boolean; }
export interface SearchOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCandidates?: number; maxScopeRecords?: number;
  source?: never; browsing?: never;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, scope: string): boolean;
  /** Optional synchronous per-record policy, evaluated before ranking or snippet creation. */
  authorizeRecord?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Pick<SearchRecord, "scope" | "id">): boolean;
}
type StringField<Value> = { [Key in keyof Value & string]: Value[Key] extends string ? Key : never }[keyof Value & string];
interface RuntimeSearchSource { name: string; table: string; title: string; body: string; scope: "owner" | { field: string }; maxRecords?: number; maxBytes?: number; facets?: readonly string[]; }
export type SearchSource<Schema extends DatabaseSchema<any>> = {
  [Name in TableName<Schema>]: {
    name: string; table: Name; title: StringField<TableValue<Schema["tables"][Name]>>; body: StringField<TableValue<Schema["tables"][Name]>>;
    maxRecords?: number; maxBytes?: number; facets?: readonly ScalarField<TableValue<Schema["tables"][Name]>>[];
  } & (TableOwned<Schema["tables"][Name]> extends true ? { scope: "owner" } : { scope: { field: StringField<TableValue<Schema["tables"][Name]>> } })
}[TableName<Schema>];
export interface SourceSearchOptions<Schema extends DatabaseSchema<any>> extends Omit<SearchOptions<Schema>, "schema" | "source" | "browsing"> { schema: Schema; source: SearchSource<Schema>; browsing?: SearchBrowsingOptions; }
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

export type SearchFacetValue = string | number | boolean | null;
type ScalarField<Value> = { [Key in keyof Value & string]: Exclude<Value[Key], undefined> extends SearchFacetValue ? Key : never }[keyof Value & string];
export interface SearchFilter { readonly field: string; readonly value: SearchFacetValue; }
export interface SearchDefinition { readonly text: string; readonly filters: readonly SearchFilter[]; readonly sort: "relevance" | "title"; }
export interface SearchFacet { readonly field: string; readonly values: readonly { readonly value: SearchFacetValue; readonly count: number }[]; }
export interface SearchPage { readonly hits: readonly SearchHit[]; readonly total: number; readonly facets: readonly SearchFacet[]; readonly nextCursor: string | null; readonly revision: number; }
export interface SavedSearch { readonly key: string; readonly name: string; readonly revision: number; readonly usable: boolean; readonly definition: SearchDefinition | null; }
export interface SearchDeletion { readonly key: string; readonly revision: number; readonly deleted: true; }
export interface SearchBrowsingOptions {
  /** Change when record/scope policy semantics change. */
  policyRevision: string;
  /** Live definitions per account, scope and index, default 50, maximum 200. */
  maxSavedSearches?: number;
  /** Includes compact deleted identities; default 10,000, maximum 50,000. */
  maxSavedIdentities?: number;
  /** Includes definition payloads and retry fingerprints; default 16 MiB, maximum 64 MiB. */
  maxSavedBytes?: number;
}
export interface SearchBrowsingClient extends SearchClient {
  browse(scope: string, definition: SearchDefinition, options?: { limit?: number; cursor?: string }): Promise<SearchPage>;
  saved(scope: string): Promise<readonly SavedSearch[]>;
  save(scope: string, input: { key: string; expectedRevision: number; name: string; definition: SearchDefinition }): Promise<SavedSearch>;
  removeSaved(scope: string, key: string, expectedRevision: number): Promise<SearchDeletion>;
}

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
export async function openSearch(options: Omit<SearchOptions, "source" | "browsing"> & { source?: RuntimeSearchSource; browsing?: SearchBrowsingOptions }): Promise<SearchService | SourceSearchService> {
  if (options.browsing !== undefined && (!options.browsing || typeof options.browsing !== "object" || Array.isArray(options.browsing) || !options.source)) throw new TypeError("Search browsing requires a linked source and a policy configuration.");
  if (options.source?.facets !== undefined && !Array.isArray(options.source.facets)) throw new TypeError("Search facets must be an array.");
  options = { ...options, ...(options.source ? { source: { ...options.source, scope: options.source.scope === "owner" ? "owner" : { ...options.source.scope }, ...(options.source.facets ? { facets: [...options.source.facets] } : {}) } } : {}), ...(options.browsing ? { browsing: { ...options.browsing } } : {}) };
  const maximum = options.maxCandidates ?? 5000, scopeMaximum = options.maxScopeRecords ?? 50000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50000 || !Number.isSafeInteger(scopeMaximum) || scopeMaximum < maximum || scopeMaximum > 50000 || typeof options.authorize !== "function") throw new TypeError("Search needs authorization and bounded candidate/scope limits.");
  const schema = options.schema ?? defineDatabase({ searchServiceState: defineTable({ generation: s.number() }) });
  const binding = options.source ? createSourceBinding(schema, options.source, scopeMaximum) : undefined;
  const browsingConfig = binding && options.browsing ? searchBrowsingConfiguration(schema, options.source!, options.browsing) : undefined;
  let browsing: ReturnType<typeof createSearchBrowsing> | undefined, hash: (value: unknown) => string;
  if (browsingConfig) { const cryptoName = "node:crypto", crypto = await import(cryptoName); hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  const fts = binding ? SOURCE_SEARCH_FTS : "clank_search_fts";
  const indexClause = binding ? "index_name=? AND " : "";
  const indexParameters = binding ? [binding.name] : [];
  let native: SQLiteInternal;
  let generation: string;
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
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
    ...(browsingConfig ? {
      browse: query({ args: { scope: s.string({ min: 1, max: 200 }), definition: s.string({ max: 8000 }), limit: s.number({ integer: true, min: 1, max: 100 }), cursor: s.optional(s.string({ max: 2000 })) }, agent: false, handler: (context, input) => browsing!.browse(context, input) }),
      savedSearches: query({ args: { scope: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, input) => browsing!.saved(context, input.scope) }),
      saveSearch: mutation({ args: { scope: s.string({ min: 1, max: 200 }), key: s.string({ min: 1, max: 120 }), expectedRevision: s.number({ integer: true, min: 0 }), name: s.string({ min: 1, max: 100 }), definition: s.string({ max: 8000 }) }, agent: false, handler: (context, input) => browsing!.save(context, input) }),
      removeSearch: mutation({ args: { scope: s.string({ min: 1, max: 200 }), key: s.string({ min: 1, max: 120 }), expectedRevision: s.number({ integer: true, min: 1 }) }, agent: false, handler: (context, input) => browsing!.remove(context, input) }),
    } : {}),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/search", maxCacheEntries: 0, agent: false });
  native = (runtime.database as any)[SQLITE_INTERNAL];
  if (binding) {
    try {
      generation = native.transaction(changes => {
        bootstrapSourceSearch(native);
        bootstrapSourceSearchFTS(native);
        const enableBrowsing = (id: string) => { if (browsingConfig) { browsing = createSearchBrowsing(native, binding, id, browsingConfig, options, hash); browsing.bootstrap(); changes.record("__search", binding.name); } return id; };
        const definition = JSON.stringify(binding), prior = native.prepare("SELECT definition,generation FROM clank_source_search_indexes WHERE name=?").get(binding.name);
        if (prior) { if (prior.definition !== definition) throw new Error("Source-search binding changed; drain writers and detach before replacing it."); return enableBrowsing(String(prior.generation)); }
        if (Number(native.prepare("SELECT count(*) AS records FROM clank_source_search_indexes").get()?.records) >= 16) throw new RangeError("At most 16 source-search indexes may be registered.");
        if (Number(native.prepare(`SELECT count(*) AS records FROM ${sourceSearchTable(binding)}`).get()?.records) > binding.maxRecords) throw new RangeError("Source-search source exceeds its configured record capacity.");
        const id = crypto.randomUUID();
        native.prepare("INSERT INTO clank_source_search_indexes(name,definition,generation,revision,cursor,status) VALUES(?,?,?,1,'','building')").run(binding.name, definition, id);
        changes.record("__search", binding.name); return enableBrowsing(id);
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
type BrowsingContext = { auth: AuthRequest<any>; db: ReadDatabase<any> };
type BrowsingConfiguration = Required<SearchBrowsingOptions> & { fields: readonly string[] };
const searchOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const searchConflict = (message: string): never => { throw new BackendActionError(409, "SEARCH_CURSOR_STALE", message); };
const searchCapacity = (): never => { throw new BackendActionError(503, "SEARCH_BROWSING_CAPACITY", "Search browsing exceeds a configured capacity; partition the scope or narrow the source."); };
function validateSearchDefinition(value: unknown, fields?: readonly string[]): SearchDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return featureInput("Invalid search definition.");
  const input = value as SearchDefinition;
  if (Object.keys(input).some(key => !["text", "filters", "sort"].includes(key)) || typeof input.text !== "string" || input.text.length > 500 || !["relevance", "title"].includes(input.sort) || !Array.isArray(input.filters) || input.filters.length > 8) return featureInput("Invalid search definition.");
  const filters = input.filters.map(filter => {
    if (!filter || typeof filter !== "object" || Object.keys(filter).some(key => !["field", "value"].includes(key)) || typeof filter.field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(filter.field) || fields && !fields.includes(filter.field)) return featureInput("Unknown search facet.");
    const value = filter.value;
    if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value)) && !(typeof value === "string" && value.length <= 200)) return featureInput("Invalid search facet value.");
    return { field: filter.field, value };
  });
  if (new Set(filters.map(filter => filter.field)).size !== filters.length) return featureInput("Search facet filters must be unique.");
  return { text: input.text.trim().normalize("NFC"), sort: input.sort, filters: filters.sort((left, right) => searchOrder(left.field, right.field)) };
}
function searchBrowsingConfiguration(schema: DatabaseSchema<any>, source: RuntimeSearchSource, input: SearchBrowsingOptions): BrowsingConfiguration {
  const config = { policyRevision: input.policyRevision, fields: [...(source.facets ?? [])], maxSavedSearches: input.maxSavedSearches ?? 50, maxSavedIdentities: input.maxSavedIdentities ?? 10000, maxSavedBytes: input.maxSavedBytes ?? 16 * 1024 * 1024 };
  const integer = (value: number, maximum: number) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;
  if (typeof config.policyRevision !== "string" || !config.policyRevision || config.policyRevision.length > 100 || !integer(config.maxSavedSearches, 200) || !integer(config.maxSavedIdentities, 50000) || !integer(config.maxSavedBytes, 64 * 1024 * 1024) || config.fields.length > 8 || new Set(config.fields).size !== config.fields.length) throw new TypeError("Invalid bounded search browsing configuration.");
  const scalar = (shape: any): boolean => shape && typeof shape === "object" && (Array.isArray(shape.anyOf) ? shape.anyOf.length <= 8 && shape.anyOf.every(scalar) : ["string", "number", "integer", "boolean", "null"].includes(shape.type) || Object.hasOwn(shape, "const") && (shape.const === null || ["string", "number", "boolean"].includes(typeof shape.const)));
  for (const field of config.fields) {
    if (typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field) || !Object.hasOwn(schema.tables[source.table].fields, field) || !scalar(schema.tables[source.table].fields[field].toJSONSchema())) throw new TypeError("Search facets must be declared scalar source fields.");
  }
  return config;
}
function createSearchBrowsing(native: SQLiteInternal, binding: SQLiteSearchBinding, generation: string, config: BrowsingConfiguration, options: Pick<SearchOptions, "authorize" | "authorizeRecord" | "maxCandidates" | "maxScopeRecords">, hash: (value: unknown) => string) {
  const declaration = hash([binding.name, generation, config.policyRevision, config.fields]), maximum = options.maxCandidates ?? 5000, scopeMaximum = options.maxScopeRecords ?? 50000;
  const access = (context: BrowsingContext, scope: string) => {
    requireFeatureAccess(Boolean(context.auth.user && context.auth.session));
    requireFeatureAccess(options.authorize(context, scope));
    requireFeatureAccess(binding.scope !== "owner" || context.auth.user!.id === scope);
    if (native.prepare("SELECT version FROM clank_search_definitions_protocol WHERE id=1").get()?.version !== 1) throw new BackendActionError(503, "SEARCH_DEFINITION_UNAVAILABLE", "Saved-search metadata protocol is unsupported.");
    return context.auth.user!.id;
  };
  const index = () => {
    const row = native.prepare("SELECT generation,revision,status,definition FROM clank_source_search_indexes WHERE name=?").get(binding.name);
    if (!row || row.generation !== generation || row.status !== "ready" || row.definition !== JSON.stringify(binding) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw new BackendActionError(503, "SEARCH_SOURCE_UNAVAILABLE", "Source-search index is detached or rebuilding.");
    return Number(row.revision);
  };
  const rowOutput = (row: Record<string, unknown>): SavedSearch => {
    if (typeof row.key !== "string" || typeof row.name !== "string" || row.name.length > 100 || typeof row.definition !== "string" || row.definition.length > 8000 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || ![0, 1].includes(Number(row.deleted))) throw new BackendActionError(503, "SEARCH_DEFINITION_UNAVAILABLE", "Saved search metadata is invalid.");
    const usable = row.declaration === declaration;
    return { key: row.key, name: row.name, revision: Number(row.revision), usable, definition: usable ? validateSearchDefinition(JSON.parse(row.definition), config.fields) : null };
  };
  const usage = () => native.prepare("SELECT count(*) AS records,coalesce(sum(length(CAST(owner AS BLOB))+length(CAST(index_name AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(key AS BLOB))+length(CAST(name AS BLOB))+length(CAST(definition AS BLOB))+length(CAST(declaration AS BLOB))+length(CAST(fingerprint AS BLOB))+32),0) AS bytes FROM clank_search_definitions").get()!;
  const capacity = () => { const value = usage(); if (!Number.isSafeInteger(value.records) || !Number.isSafeInteger(value.bytes) || Number(value.records) < 0 || Number(value.bytes) < 0 || Number(value.records) > config.maxSavedIdentities || Number(value.bytes) > config.maxSavedBytes) searchCapacity(); };
  return {
    bootstrap() {
      if (!native.inTransaction) throw new Error("Saved-search bootstrap requires the registration transaction.");
        native.exec("CREATE TABLE IF NOT EXISTS clank_search_definitions_protocol(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)");
        native.exec("INSERT OR IGNORE INTO clank_search_definitions_protocol(id,version) VALUES(1,1)");
        if (native.prepare("SELECT version FROM clank_search_definitions_protocol WHERE id=1").get()?.version !== 1) throw new Error("Unsupported saved-search metadata protocol.");
        native.exec("CREATE TABLE IF NOT EXISTS clank_search_definitions(owner TEXT NOT NULL,index_name TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,name TEXT NOT NULL,definition TEXT NOT NULL,declaration TEXT NOT NULL,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),PRIMARY KEY(owner,index_name,scope,key)) WITHOUT ROWID");
        capacity();
    },
    browse(context: BrowsingContext, input: { scope: string; definition: string; limit: number; cursor?: string }): SearchPage {
        const owner = access(context, input.scope), revision = index(), definition = validateSearchDefinition(JSON.parse(input.definition), config.fields);
        const count = Number(native.prepare(`SELECT count(*) AS n FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND scope=?`).get(binding.name, input.scope)?.n ?? 0);
        if (count > scopeMaximum) searchCapacity();
        const words = [...new Set(definition.text.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])], terms = [...new Set(words.map(searchFold))];
        if (definition.text && (!terms.length || terms.length > 10)) return featureInput("Search requires 1–10 words, or empty text to browse.");
        const expression = words.map(word => `"${word.replaceAll('"', '""')}"`).join(" AND ");
        const matches = native.prepare(`SELECT rowid,id,source_version FROM ${SOURCE_SEARCH_FTS} WHERE ${expression ? `${SOURCE_SEARCH_FTS} MATCH ? AND ` : ""}index_name=? AND scope=? ORDER BY rowid LIMIT ?`).all(...(expression ? [expression] : []), binding.name, input.scope, scopeMaximum);
        const hits: SearchHit[] = [], versions: unknown[] = [], maps = config.fields.map(() => new Map<string, { value: SearchFacetValue; count: number }>()), ids = new Set<string>();
        let examined = 0, bytes = 0;
        for (const match of matches) {
          const id = String(match.id);
          if (options.authorizeRecord) { const allowed = options.authorizeRecord(context, { scope: input.scope, id }); if (allowed !== true) { void Promise.resolve(allowed).catch(() => undefined); continue; } }
          if (ids.has(id)) continue;
          const size = native.prepare(`SELECT length(CAST(_data AS BLOB)) AS bytes,_version FROM ${sourceSearchTable(binding)} WHERE _id=? AND ${binding.scope === "owner" ? "_owner_id=?" : "json_extract(_data,?)=?"}`).get(id, ...(binding.scope === "owner" ? [input.scope] : [`$.${binding.scope.field}`, input.scope]));
          if (!size || size._version !== Number(match.source_version)) continue;
          if (!Number.isSafeInteger(size.bytes) || Number(size.bytes) < 0 || ++examined > maximum || (bytes += Number(size.bytes)) > 16 * 1024 * 1024) searchCapacity();
          const source = context.db.table(binding.table).get(id as any) as Record<string, unknown> | null;
          if (!source || source._version !== Number(match.source_version) || (binding.scope === "owner" ? source._ownerId : source[binding.scope.field]) !== input.scope) continue;
          const projected = native.prepare(`SELECT title,body FROM ${SOURCE_SEARCH_FTS} WHERE rowid=?`).get(match.rowid)!;
          if (source[binding.title] !== projected.title || source[binding.body] !== projected.body) continue;
          ids.add(id); versions.push([id, source._version]);
          const values = config.fields.map(field => {
            const value = !Object.hasOwn(source, field) || source[field] === undefined ? null : source[field];
            if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value)) && !(typeof value === "string" && value.length <= 200)) throw new BackendActionError(503, "SEARCH_FACET_UNAVAILABLE", "Source facet exceeds its declared scalar value bounds.");
            return value as SearchFacetValue;
          });
          if (!definition.filters.every(filter => values[config.fields.indexOf(filter.field)] === filter.value)) continue;
          const title = searchFold(String(projected.title)), body = searchFold(String(projected.body)); let score = 0;
          for (const term of terms) { score += title.split(term).length * 4 - 4; score += body.split(term).length - 1; }
          const matchOffset = Math.min(...terms.map(term => body.indexOf(term)).filter(offset => offset >= 0)), position = Number.isFinite(matchOffset) ? Math.max(0, originalOffset(String(projected.body), matchOffset) - 60) : 0;
          hits.push({ id, title: String(projected.title), snippet: String(projected.body).slice(position, position + 240), score });
          values.forEach((value, offset) => { const key = JSON.stringify(value), map = maps[offset]!, prior = map.get(key); if (prior) prior.count++; else { if (map.size >= 100) searchCapacity(); map.set(key, { value, count: 1 }); } });
        }
        hits.sort((left, right) => (definition.sort === "title" ? searchOrder(left.title.normalize("NFC").toLowerCase(), right.title.normalize("NFC").toLowerCase()) : right.score - left.score) || searchOrder(left.id, right.id));
        const facets = config.fields.map((field, offset) => ({ field, values: [...maps[offset]!.entries()].sort(([left], [right]) => searchOrder(left, right)).map(([, value]) => value) }));
        const stamp = hash([owner, input.scope, declaration, revision, definition, versions, facets]);
        let start = 0;
        if (input.cursor) {
          let cursor: any; try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { return featureInput("Invalid search cursor."); }
          if (!cursor || cursor.protocol !== 1 || typeof cursor.after !== "string" || cursor.after.length > 200 || typeof cursor.stamp !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.stamp) || Object.keys(cursor).some(key => !["protocol", "stamp", "after"].includes(key))) return featureInput("Invalid search cursor.");
          if (cursor.stamp !== stamp) searchConflict("Search index, policy, definition or visible records changed; start again.");
          const offset = hits.findIndex(hit => hit.id === cursor.after); if (offset < 0) searchConflict("Search page anchor is no longer available."); start = offset + 1;
        }
        const page = hits.slice(start, start + input.limit), nextCursor = start + page.length < hits.length ? encodeURIComponent(JSON.stringify({ protocol: 1, stamp, after: page.at(-1)!.id })) : null;
        return { hits: page, total: hits.length, facets, nextCursor, revision };
    },
    saved(context: BrowsingContext, scope: string): readonly SavedSearch[] {
        const owner = access(context, scope); capacity();
        const size = native.prepare("SELECT count(*) AS records,coalesce(sum(length(CAST(definition AS BLOB))),0) AS bytes FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND deleted=0").get(owner, binding.name, scope)!;
        if (Number(size.records) > config.maxSavedSearches || Number(size.bytes) > 2 * 1024 * 1024) searchCapacity();
        return native.prepare("SELECT * FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND deleted=0 ORDER BY key").all(owner, binding.name, scope).map(rowOutput);
    },
    save(context: BrowsingContext, input: { scope: string; key: string; expectedRevision: number; name: string; definition: string }): SavedSearch {
      if (!native.inTransaction) throw new Error("Saved-search writes require the host mutation transaction.");
      const owner = access(context, input.scope); index();
      const definition = JSON.stringify(validateSearchDefinition(JSON.parse(input.definition), config.fields)), name = input.name.trim(); if (!name) return featureInput("A saved search needs a name.");
      const fingerprint = hash(["save", input.key, input.expectedRevision, name, definition, declaration]);
      const row = native.prepare("SELECT * FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND key=?").get(owner, binding.name, input.scope, input.key);
      if (row?.fingerprint === fingerprint && row.deleted === 0) return rowOutput(row);
      if (row?.deleted || (row ? Number(row.revision) !== input.expectedRevision : input.expectedRevision !== 0)) throw new BackendActionError(409, "SEARCH_DEFINITION_STALE", "Saved search changed or its key was retired; refresh before saving.");
      if (!row && Number(native.prepare("SELECT count(*) AS records FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND deleted=0").get(owner, binding.name, input.scope)?.records) >= config.maxSavedSearches) searchCapacity();
      const revision = (row ? Number(row.revision) : 0) + 1; if (!Number.isSafeInteger(revision)) searchCapacity();
      native.prepare("INSERT INTO clank_search_definitions(owner,index_name,scope,key,name,definition,declaration,fingerprint,revision,deleted) VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(owner,index_name,scope,key) DO UPDATE SET name=excluded.name,definition=excluded.definition,declaration=excluded.declaration,fingerprint=excluded.fingerprint,revision=excluded.revision").run(owner, binding.name, input.scope, input.key, name, definition, declaration, fingerprint, revision);
      capacity();
      return rowOutput(native.prepare("SELECT * FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND key=?").get(owner, binding.name, input.scope, input.key)!);
    },
    remove(context: BrowsingContext, input: { scope: string; key: string; expectedRevision: number }): SearchDeletion {
      if (!native.inTransaction) throw new Error("Saved-search writes require the host mutation transaction.");
      const owner = access(context, input.scope), fingerprint = hash(["delete", input.key, input.expectedRevision]);
      const row = native.prepare("SELECT revision,deleted,fingerprint FROM clank_search_definitions WHERE owner=? AND index_name=? AND scope=? AND key=?").get(owner, binding.name, input.scope, input.key);
      if (row?.deleted === 1 && row.fingerprint === fingerprint) return { key: input.key, revision: Number(row.revision), deleted: true };
      if (!row || row.deleted || Number(row.revision) !== input.expectedRevision) throw new BackendActionError(409, "SEARCH_DEFINITION_STALE", "Saved search changed; refresh before deleting.");
      const revision = Number(row.revision) + 1; if (!Number.isSafeInteger(revision)) searchCapacity();
      native.prepare("UPDATE clank_search_definitions SET name='',definition='',declaration='',fingerprint=?,revision=?,deleted=1 WHERE owner=? AND index_name=? AND scope=? AND key=?").run(fingerprint, revision, owner, binding.name, input.scope, input.key);
      capacity(); return { key: input.key, revision, deleted: true };
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

export function createSearchBrowsingClient(options: SyncClientOptions = {}): SearchBrowsingClient {
  options = { ...options };
  const transportOptions = { ...options, fetch: (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.method?.toUpperCase() === "POST") for (const [name, value] of Object.entries(options.auth?.csrfHeader?.() ?? {})) headers.set(name, String(value));
    return (options.fetch ?? fetch)(url, { ...init, headers });
  } };
  const { client, api } = featureTransport<{
    browse: FeatureQuery<{ scope: string; definition: string; limit: number; cursor?: string }, SearchPage>;
    savedSearches: FeatureQuery<{ scope: string }, readonly SavedSearch[]>;
    saveSearch: FeatureMutation<{ scope: string; key: string; expectedRevision: number; name: string; definition: string }, SavedSearch>;
    removeSearch: FeatureMutation<{ scope: string; key: string; expectedRevision: number }, SearchDeletion>;
  }>(transportOptions, "/__clank/search");
  return {
    ...createSearchClient(transportOptions),
    browse: async (scope, definition, paging = {}) => client.query(api.browse, { scope, definition: JSON.stringify(validateSearchDefinition(definition)), limit: paging.limit ?? 20, ...(paging.cursor ? { cursor: paging.cursor } : {}) }),
    saved: scope => client.query(api.savedSearches, { scope }),
    save: async (scope, input) => client.mutate(api.saveSearch, { scope, key: input.key, expectedRevision: input.expectedRevision, name: input.name, definition: JSON.stringify(validateSearchDefinition(input.definition)) }),
    removeSaved: (scope, key, expectedRevision) => client.mutate(api.removeSearch, { scope, key, expectedRevision }),
  };
}

/** Account-aware controls for authorized facets, pinned paging and saved searches. */
export function mountSearchBrowsing(container: HTMLElement, options: { client: SearchBrowsingClient; currentUser(): string | null; scope(): string; fields: readonly string[]; open(id: string): void; pageSize?: number }): () => void {
  const fields = [...options.fields], pageSize = options.pageSize ?? 20;
  if (fields.length > 8 || new Set(fields).size !== fields.length || fields.some(field => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field)) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("Invalid search browsing controls.");
  const document = container.ownerDocument, panel = document.createElement("section"), form = document.createElement("form"), words = document.createElement("input"), sort = document.createElement("select"), status = document.createElement("p"), results = document.createElement("ol"), facets = document.createElement("div"), name = document.createElement("input"), saved = document.createElement("ul");
  panel.setAttribute("aria-label", "Browse and save searches"); form.setAttribute("aria-label", "Browse search records"); words.type = "search"; words.maxLength = 500; words.setAttribute("aria-label", "Search words"); sort.setAttribute("aria-label", "Result order"); name.maxLength = 100; name.setAttribute("aria-label", "Saved search name"); status.setAttribute("role", "status");
  panel.style.maxWidth = "100%"; panel.style.overflowWrap = "anywhere"; words.style.maxWidth = "100%"; words.style.boxSizing = "border-box";
  for (const [value, label] of [["relevance", "Relevance"], ["title", "Title"]]) { const item = document.createElement("option"); item.value = value!; item.textContent = label!; sort.append(item); }
  sort.value = "relevance";
  const selects = new Map<string, HTMLSelectElement>();
  for (const field of fields) { const label = document.createElement("label"), select = document.createElement("select"); label.append(document.createTextNode(field + " "), select); select.setAttribute("aria-label", "Filter " + field); selects.set(field, select); facets.append(label); }
  let closed = false, busy = false, generation = 0, cursor: string | null = null, selected: SavedSearch | null = null, focusAfter: HTMLElement | null = null;
  const actor = () => JSON.stringify([options.currentUser(), options.scope()]); let identity = actor();
  const creations = new Map<string, string>();
  const definition = (): SearchDefinition => ({ text: words.value, sort: sort.value as SearchDefinition["sort"], filters: [...selects].filter(([, select]) => select.value !== "").map(([field, select]) => ({ field, value: JSON.parse(select.value) })) });
  const setChoices = (field: string, values: SearchFacet["values"], desired = "") => {
    const select = selects.get(field)!; select.replaceChildren(); const all = document.createElement("option"); all.value = ""; all.textContent = "All"; select.append(all);
    const choices = [...values]; if (desired && !choices.some(choice => JSON.stringify(choice.value) === desired)) choices.push({ value: JSON.parse(desired), count: 0 });
    for (const choice of choices) { const item = document.createElement("option"); item.value = JSON.stringify(choice.value); item.textContent = `${choice.value === null ? "Empty" : String(choice.value)} (${choice.count})`; select.append(item); } select.value = desired;
  };
  const clear = () => { results.replaceChildren(); saved.replaceChildren(); words.value = ""; name.value = ""; sort.value = "relevance"; selected = null; cursor = null; next.disabled = true; creations.clear(); for (const field of fields) setChoices(field, []); };
  const sync = () => { const current = actor(); if (current !== identity) { generation++; identity = current; clear(); status.textContent = "Account or scope changed. Search again."; } return Boolean(options.currentUser()); };
  const button = (label: string, action: () => Promise<void>) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", () => { void run(action); }); return node; };
  const current = (expected: number, snapshot: string) => !closed && generation === expected && actor() === snapshot;
  const run = async (action: () => Promise<void>) => {
    if (closed || busy) return; if (!sync()) { clear(); status.textContent = "Sign in to browse searches."; return; }
    busy = true; focusAfter = null; const focused = document.activeElement as HTMLElement | null, expected = ++generation, snapshot = identity; panel.setAttribute("aria-busy", "true");
    const controls = [...panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")], disabled = controls.map(node => node.disabled); controls.forEach(node => { node.disabled = true; });
    try { await action(); }
    catch (error) {
      if (current(expected, snapshot)) { const code = (error as { status?: number }).status; if ([401, 403, 404].includes(code ?? 0)) { clear(); status.textContent = "Search access revoked."; } else { cursor = null; results.replaceChildren(); status.textContent = "Search changed or unavailable. Search again, or retry the same saved change."; } }
    } finally {
      busy = false; if (!closed) { const changed = actor() !== snapshot; if (changed) sync(); panel.removeAttribute("aria-busy"); controls.forEach((node, index) => { node.disabled = disabled[index]!; }); next.disabled = !cursor; if (document.activeElement === document.body && focused && controls.includes(focused as HTMLInputElement)) { const target = focusAfter ?? (focused.isConnected && !(focused as HTMLInputElement).disabled ? focused : submit); target.focus(); } }
    }
  };
  const showPage = async (nextPage = false) => {
    const expected = generation, snapshot = identity, scope = options.scope(), requested = definition();
    const page = await options.client.browse(scope, requested, { limit: pageSize, ...(nextPage && cursor ? { cursor } : {}) }); if (!current(expected, snapshot)) return;
    results.replaceChildren(); cursor = page.nextCursor;
    for (const hit of page.hits) { const item = document.createElement("li"), open = document.createElement("button"), snippet = document.createElement("p"); open.type = "button"; open.textContent = hit.title; snippet.textContent = hit.snippet; open.addEventListener("click", () => { if (closed || !sync() || !current(expected, snapshot)) return; options.open(hit.id); }); item.append(open, snippet); results.append(item); }
    for (const field of fields) setChoices(field, page.facets.find(facet => facet.field === field)?.values ?? [], requested.filters.find(filter => filter.field === field) ? JSON.stringify(requested.filters.find(filter => filter.field === field)!.value) : "");
    status.textContent = `${page.total} authorized results; showing ${page.hits.length}.`; next.disabled = !cursor;
  };
  const refreshSaved = async () => {
    const expected = generation, snapshot = identity, rows = await options.client.saved(options.scope()); if (!current(expected, snapshot)) return; saved.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li"); item.append(document.createTextNode(row.name + (row.usable ? " " : " (policy or index changed) ")));
      if (row.usable && row.definition) item.append(button("Load " + row.name, async () => { if (!sync() || actor() !== snapshot) return; selected = row; name.value = row.name; words.value = row.definition!.text; sort.value = row.definition!.sort; for (const field of fields) { const filter = row.definition!.filters.find(value => value.field === field); setChoices(field, [], filter ? JSON.stringify(filter.value) : ""); } cursor = null; await showPage(); focusAfter = name; }));
      item.append(button("Delete " + row.name, async () => { if (!sync() || actor() !== snapshot) return; await options.client.removeSaved(options.scope(), row.key, row.revision); if (!current(generation, snapshot)) return; if (selected?.key === row.key) { selected = null; name.value = ""; } await refreshSaved(); })); saved.append(item);
    }
    if (!rows.length) saved.textContent = "No saved searches.";
  };
  const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "Search";
  const next = button("Next results", async () => { if (cursor) await showPage(true); }); next.disabled = true;
  const invalidate = () => { if (closed || !sync()) return; generation++; cursor = null; next.disabled = true; results.replaceChildren(); status.textContent = "Search changed. Search again."; };
  words.addEventListener("input", invalidate); sort.addEventListener("change", invalidate); for (const select of selects.values()) select.addEventListener("change", invalidate);
  form.addEventListener("submit", event => { event.preventDefault(); void run(async () => { cursor = null; await showPage(); }); });
  const save = button("Save search", async () => {
    const snapshot = identity, scope = options.scope(), value = definition(), fingerprint = JSON.stringify([name.value, value]); let key = selected?.key ?? creations.get(fingerprint);
    if (!key) { if (creations.size >= 20) { status.textContent = "Too many uncertain saves. Refresh saved searches."; return; } key = crypto.randomUUID(); creations.set(fingerprint, key); }
    const accepted = await options.client.save(scope, { key, expectedRevision: selected?.revision ?? 0, name: name.value, definition: value }); if (closed || actor() !== snapshot) return; selected = accepted; creations.delete(fingerprint); status.textContent = "Search saved."; await refreshSaved();
  });
  const fresh = button("New saved search", async () => { selected = null; name.value = ""; focusAfter = name; });
  form.append(words, sort, facets, submit, next); panel.append(form, status, results, name, save, fresh, button("Refresh saved searches", refreshSaved), saved); container.append(panel); for (const field of fields) setChoices(field, []); void run(refreshSaved);
  return () => { closed = true; generation++; creations.clear(); panel.remove(); };
}
