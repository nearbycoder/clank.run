import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";
import { featureInput, featureTransport, requireFeatureAccess, type FeatureQuery } from "./feature-service.ts";

export interface SearchRecord { readonly scope: string; readonly id: string; readonly title: string; readonly body: string; }
export interface SearchHit { readonly id: string; readonly title: string; readonly snippet: string; readonly score: number; }
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly total: number; readonly truncated: boolean; }
export interface SearchOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCandidates?: number; maxScopeRecords?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, scope: string): boolean;
  /** Optional synchronous per-record policy, evaluated before ranking or snippet creation. */
  authorizeRecord?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Pick<SearchRecord, "scope" | "id">): boolean;
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
export async function openSearch<Schema extends DatabaseSchema<any>>(options: SearchOptions<Schema>): Promise<SearchService>;
export async function openSearch(options: SearchOptions): Promise<SearchService> {
  const maximum = options.maxCandidates ?? 5000, scopeMaximum = options.maxScopeRecords ?? 50000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50000 || !Number.isSafeInteger(scopeMaximum) || scopeMaximum < maximum || scopeMaximum > 50000 || typeof options.authorize !== "function") throw new TypeError("Search needs authorization and bounded candidate/scope limits.");
  const schema = options.schema ?? defineDatabase({ searchServiceState: defineTable({ generation: s.number() }) });
  let native: SQLiteInternal;
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query }) => ({
    search: query({ args: { scope: s.string({ min: 1, max: 200 }), text: s.string({ min: 1, max: 500 }), limit: s.default(s.number({ integer: true, min: 1, max: 100 }), 20) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(options.authorize(context as any, input.scope));
      // This bound concerns the entire scope, independent of search terms or
      // match visibility. Never truncate a raw match list before checking ACLs.
      const count = Number(native.prepare("SELECT count(*) AS count FROM clank_search_fts WHERE scope = ?").get(input.scope)?.count ?? 0);
      if (count > scopeMaximum) throw new BackendActionError(503, "SEARCH_SCOPE_CAPACITY", "Search scope exceeds its configured capacity; rebuild or partition the index.");
      // Let unicode61 tokenize the original words. Its diacritic rules differ
      // across scripts; stripping every mark here would miss Greek/Indic terms.
      const words = [...new Set(input.text.normalize("NFC").match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])];
      const terms = [...new Set(words.map(searchFold))];
      if (!terms.length || terms.length > 10) return featureInput("Search requires 1–10 words.");
      const expression = words.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      const rows = native.prepare("SELECT rowid, scope, id FROM clank_search_fts WHERE clank_search_fts MATCH ? AND scope = ? ORDER BY rowid LIMIT ?").all(expression, input.scope, scopeMaximum);
      const authorized: SearchHit[] = [];
      let scannedBytes = 0, byteLimit = false, candidateLimit = false;
      for (const row of rows) {
        if (options.authorizeRecord && options.authorizeRecord(context as any, row as unknown as Pick<SearchRecord, "scope" | "id">) !== true) continue;
        if (authorized.length === maximum) { candidateLimit = true; break; }
        const record = native.prepare("SELECT scope,id,title,body FROM clank_search_fts WHERE rowid = ?").get(row.rowid) as unknown as SearchRecord;
        scannedBytes += record.title.length * 2 + record.body.length * 2;
        if (scannedBytes > 16 * 1024 * 1024) { byteLimit = true; break; }
        // Never use global BM25 statistics: inaccessible documents cannot influence scores.
        const title = searchFold(record.title), body = searchFold(record.body);
        let score = 0;
        for (const term of terms) { score += title.split(term).length * 4 - 4; score += body.split(term).length - 1; }
        const match = Math.min(...terms.map(term => body.indexOf(term)).filter(index => index >= 0));
        const position = Number.isFinite(match) ? Math.max(0, originalOffset(record.body, match) - 60) : 0;
        authorized.push({ id: record.id, title: record.title, snippet: record.body.slice(position, position + 240), score });
      }
      authorized.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      return { hits: authorized.slice(0, input.limit), total: authorized.length, truncated: byteLimit || candidateLimit || authorized.length > input.limit };
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/search", maxCacheEntries: 0, agent: false });
  native = (runtime.database as any)[SQLITE_INTERNAL];
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
export function createSearchClient(options: SyncClientOptions = {}): SearchClient {
  const { client, api } = featureTransport<{ search: FeatureQuery<{ scope: string; text: string; limit: number }, SearchResult> }>(options, "/__clank/search");
  return { search: (scope, text, limit = 20) => client.query(api.search, { scope, text, limit }) };
}
export function mountSearch(container: HTMLElement, client: SearchClient, options: { scope(): string; open(id: string): void }): () => void {
  const document = container.ownerDocument, form = document.createElement("form"), input = document.createElement("input"), submit = document.createElement("button"), status = document.createElement("p"), results = document.createElement("ol");
  form.setAttribute("aria-label", "Search records"); input.type = "search"; input.maxLength = 500; input.setAttribute("aria-label", "Search words"); submit.textContent = "Search"; submit.type = "submit"; status.setAttribute("role", "status");
  let closed = false, generation = 0;
  form.addEventListener("submit", async event => { event.preventDefault(); const expected = ++generation; submit.disabled = true; results.replaceChildren(); try { const result = await client.search(options.scope(), input.value); if (closed || expected !== generation) return; for (const hit of result.hits) { const row = document.createElement("li"), link = document.createElement("button"), snippet = document.createElement("p"); link.type = "button"; link.textContent = hit.title; link.addEventListener("click", () => options.open(hit.id)); snippet.textContent = hit.snippet; row.append(link, snippet); results.append(row); } status.textContent = `${result.hits.length} results${result.truncated ? "; narrow your search for more precise results" : ""}.`; } catch { if (!closed) status.textContent = "Search unavailable or access revoked."; } finally { submit.disabled = false; } });
  form.append(input, submit, status, results); container.append(form); return () => { closed = true; generation++; form.remove(); };
}
