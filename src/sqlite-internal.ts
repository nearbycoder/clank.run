export const SQLITE_INTERNAL = Symbol.for("clank.sqlite.internal");

const reviewedExecutions = new WeakMap<SQLiteInternal, { requester: string; approver: string; planId: string }>();
/** Available only during an accepted reviewed action's synchronous transaction. */
export function currentReviewedExecution(connection: SQLiteInternal): { requester: string; approver: string; planId: string } | undefined {
  return connection.inTransaction ? reviewedExecutions.get(connection) : undefined;
}
export function withReviewedExecution<Value>(connection: SQLiteInternal, identity: { requester: string; approver: string; planId: string }, handler: () => Value): Value {
  const previous = reviewedExecutions.get(connection);
  reviewedExecutions.set(connection, Object.freeze({ ...identity }));
  try { return handler(); } finally {
    if (previous) reviewedExecutions.set(connection, previous);
    else reviewedExecutions.delete(connection);
  }
}

export interface SQLiteStatement {
  all(...parameters: any[]): Array<Record<string, unknown>>;
  get(...parameters: any[]): Record<string, unknown> | undefined;
  run(...parameters: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SQLiteInternalChangeRecorder {
  record(table: string, id: string, ownerId?: string | null): void;
}

export interface SQLiteInternal {
  /** Install once, after schema bootstrap and before admitting requests. */
  captureTransactions?(factory: (connection: SQLiteCaptureConnection) => SQLiteTransactionCapture): void;
  /** True only while this database instance owns a write transaction. */
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  transaction<Value>(handler: (changes: SQLiteInternalChangeRecorder) => Value): Value;
  /** Re-scope reads inside an active transaction for independent participant/approval authorization. */
  readScoped<Value>(userId: string | null, handler: (db: import("./backend.ts").ReadDatabase<any>) => Value): Value;
  /** Re-scope generated metadata writes after independent current operator authorization. */
  writeScoped<Value>(userId: string | null, handler: (db: import("./backend.ts").WriteDatabase<any>) => Value): Value;
  /** Capture selective dependencies inside the current write transaction. */
  readTrackedScoped<Value>(userId: string | null, handler: (db: import("./backend.ts").ReadDatabase<any>) => Value): import("./backend.ts").TrackedResult<Value>;
  /** Retire persisted and pending snapshots of a record deleted in this write transaction. */
  purgeDeletedHistory(table: string, id: string): void;
}

/** Every upgraded source writer consults persisted holds, including preopened connections. */
export function isRetentionHeld(connection: Pick<SQLiteInternal, "prepare">, kind: "import" | "collaboration" | "audit", id: string, now = Date.now()): boolean {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_retention_holds'").get()) return false;
  const state = connection.prepare("SELECT protocol FROM clank_retention_state WHERE singleton=1").get();
  if (state?.protocol !== 1) throw new Error("Unsupported persisted retention hold protocol.");
  const rows = connection.prepare("SELECT scope,reason,expires_at,version FROM clank_retention_holds WHERE kind=? AND resource_id=? LIMIT 2").all(kind, id);
  if (rows.length > 1) throw new Error("Conflicting persisted retention holds.");
  const row = rows[0];
  if (!row) return false;
  if (typeof row.scope !== "string" || !row.scope || row.scope.length > 200 || typeof row.reason !== "string" || !row.reason || row.reason.length > 2000 || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || Number(row.expires_at) < 0)) throw new Error("Invalid persisted retention hold.");
  return row.expires_at === null || Number(row.expires_at) > now;
}

/** Fixed history predicate for every upgraded writer's automatic cleanup. */
export function retentionHistoryProtection(connection: Pick<SQLiteInternal, "prepare">): string {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_retention_holds'").get()) return "";
  if (connection.prepare("SELECT protocol FROM clank_retention_state WHERE singleton=1").get()?.protocol !== 1) throw new Error("Unsupported persisted retention hold protocol.");
  if (connection.prepare(`SELECT 1 FROM clank_retention_holds WHERE
    typeof(kind)<>'text' OR kind NOT IN ('import','collaboration','audit') OR typeof(resource_id)<>'text' OR length(resource_id) NOT BETWEEN 1 AND 200
    OR typeof(scope)<>'text' OR length(scope) NOT BETWEEN 1 AND 200 OR typeof(reason)<>'text' OR length(reason) NOT BETWEEN 1 AND 2000
    OR typeof(version)<>'integer' OR version NOT BETWEEN 1 AND 9007199254740991
    OR expires_at IS NOT NULL AND (typeof(expires_at)<>'integer' OR expires_at NOT BETWEEN 0 AND 9007199254740991) LIMIT 1`).get()) throw new Error("Invalid persisted retention hold.");
  if (connection.prepare("SELECT 1 FROM clank_retention_holds GROUP BY kind,resource_id HAVING count(*)>1 LIMIT 1").get()) throw new Error("Conflicting persisted retention holds.");
  return ` AND NOT EXISTS(SELECT 1 FROM clank_retention_holds held WHERE (held.expires_at IS NULL OR held.expires_at>?) AND (
    held.kind='import' AND ((table_name='durableImportJobs' AND held.resource_id=document_id)
      OR table_name IN ('durableImportChunks','durableImportCorrections','durableImportOperations') AND held.resource_id=json_extract(snapshot_data,'$.jobId'))
    OR held.kind='collaboration' AND ((table_name='collaborativeDocs' AND held.resource_id=json_extract(snapshot_data,'$.key'))
      OR table_name IN ('collaborativeOperations','collaborativeReceipts','collaborativeBranches') AND held.resource_id=json_extract(snapshot_data,'$.documentId'))))`;
}

/** Count held source history without materializing payloads; shared admission bound. */
export function retentionHistoryUsage(connection: Pick<SQLiteInternal, "prepare">, protection = retentionHistoryProtection(connection), now = Date.now()): { records: number; bytes: number } {
  if (!protection || !connection.prepare("SELECT 1 FROM clank_retention_holds WHERE expires_at IS NULL OR expires_at>? LIMIT 1").get(now)) return { records: 0, bytes: 0 };
  const row = connection.prepare(`SELECT count(*) AS records,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions
    WHERE table_name IN ('durableImportJobs','durableImportChunks','durableImportCorrections','durableImportOperations','collaborativeDocs','collaborativeOperations','collaborativeReceipts','collaborativeBranches') AND NOT(1${protection})`).get(now)!;
  if (!Number.isSafeInteger(row.records) || !Number.isSafeInteger(row.bytes) || Number(row.records) < 0 || Number(row.bytes) < 0) throw new Error("Invalid held history usage.");
  return { records: Number(row.records), bytes: Number(row.bytes) };
}

/** Internal hook used by the point-in-time journal. All callbacks are synchronous. */
export interface SQLiteCaptureConnection {
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  createSession(options: { table?: string }): { changeset(): Uint8Array; close(): void };
}
export interface SQLiteTransactionCapture {
  before(): void;
  commit(): void;
  after(): void;
  close(): void;
}

/** Persisted, bounded source projection. No callbacks or SQL from a binding. */
export interface SQLiteSearchBinding {
  version: 1;
  name: string; table: string; title: string; body: string;
  scope: "owner" | { field: string }; owned: boolean;
  maxRecords: number; maxBytes: number; maxScopeRecords: number;
}
type SearchConnection = Pick<SQLiteInternal, "exec" | "prepare">;
export const SOURCE_SEARCH_FTS = "clank_source_search_fts";
export function bootstrapSourceSearch(connection: SearchConnection): void {
  connection.exec(`CREATE TABLE IF NOT EXISTS clank_source_search_indexes (
    name TEXT PRIMARY KEY, definition TEXT NOT NULL CHECK(json_valid(definition)),
    generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    cursor TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('building','ready'))
  ) WITHOUT ROWID`);
}
export function bootstrapSourceSearchFTS(connection: SearchConnection): void {
  connection.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${SOURCE_SEARCH_FTS} USING fts5(
    index_name UNINDEXED, scope UNINDEXED, id UNINDEXED, source_version UNINDEXED,
    bytes UNINDEXED, title, body, tokenize='unicode61')`);
}
export function parseSearchBinding(value: string): SQLiteSearchBinding {
  if (typeof value !== "string" || value.length > 4000) throw new Error("Invalid persisted source-search binding.");
  const binding = JSON.parse(value) as SQLiteSearchBinding;
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
  if (!binding || binding.version !== 1 || !identifier(binding.name) || !identifier(binding.table) || !identifier(binding.title) || !identifier(binding.body)
    || typeof binding.owned !== "boolean" || (binding.owned ? binding.scope !== "owner" : !binding.scope || typeof binding.scope !== "object" || !identifier(binding.scope.field))
    || !Number.isSafeInteger(binding.maxRecords) || binding.maxRecords < 1 || binding.maxRecords > 50000
    || !Number.isSafeInteger(binding.maxBytes) || binding.maxBytes < 1 || binding.maxBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(binding.maxScopeRecords) || binding.maxScopeRecords < 1 || binding.maxScopeRecords > 50000) {
    throw new Error("Invalid persisted source-search binding.");
  }
  return binding;
}
export function sourceSearchTable(binding: SQLiteSearchBinding): string { return `"clank_${binding.table}"`; }
export function searchSourceRecord(binding: SQLiteSearchBinding, row: Record<string, unknown>): {
  id: string; scope: string; title: string; body: string; version: number; bytes: number;
} {
  const data = JSON.parse(String(row._data));
  const title = data?.[binding.title], body = data?.[binding.body];
  const scope = binding.scope === "owner" ? row._owner_id : data?.[binding.scope.field];
  const id = row._id, version = row._version;
  if (typeof id !== "string" || !id || id.length > 200 || typeof scope !== "string" || !scope || scope.length > 200
    || typeof title !== "string" || typeof body !== "string" || !Number.isSafeInteger(version) || Number(version) < 1) throw new TypeError("Source-search record has invalid fields.");
  const titleBytes = new TextEncoder().encode(title).length, bodyBytes = new TextEncoder().encode(body).length;
  if (titleBytes > 1000 || bodyBytes > 1024 * 1024) throw new RangeError("Source-search title/body exceed 1 KiB/1 MiB.");
  return { id, scope, title, body, version: Number(version), bytes: titleBytes + bodyBytes };
}
export function sourceSearchMatches(binding: SQLiteSearchBinding, source: Record<string, unknown> | undefined, indexed: Record<string, unknown> | undefined): boolean {
  if (!source || !indexed) return false;
  try {
    const record = searchSourceRecord(binding, source);
    return indexed.id === record.id && indexed.scope === record.scope && indexed.title === record.title
      && indexed.body === record.body && Number(indexed.source_version) === record.version && Number(indexed.bytes) === record.bytes;
  } catch { return false; }
}
export function projectSearchRecord(connection: SearchConnection, binding: SQLiteSearchBinding, id: string): void {
  const row = connection.prepare(`SELECT _id,_owner_id,_version,_data FROM ${sourceSearchTable(binding)} WHERE _id=?`).get(id);
  connection.prepare(`DELETE FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND id=?`).run(binding.name, id);
  if (!row) return;
  const record = searchSourceRecord(binding, row);
  const usage = connection.prepare(`SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM ${SOURCE_SEARCH_FTS} WHERE index_name=?`).get(binding.name)!;
  if (Number(usage.records) >= binding.maxRecords || Number(usage.bytes) + record.bytes > binding.maxBytes
    || Number(connection.prepare(`SELECT count(*) AS records FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND scope=?`).get(binding.name, record.scope)?.records) >= binding.maxScopeRecords) throw new RangeError("Source-search index exceeds its configured capacity.");
  connection.prepare(`INSERT INTO ${SOURCE_SEARCH_FTS}(index_name,scope,id,source_version,bytes,title,body) VALUES(?,?,?,?,?,?,?)`)
    .run(binding.name, record.scope, record.id, record.version, record.bytes, record.title, record.body);
}
/** Called before commit for every upgraded writer, even one opened before registration. */
export function updateSourceSearch(connection: SearchConnection, records: Iterable<{ table: string; id: string }>): void {
  const changed = [...records];
  if (!changed.length) return;
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_source_search_indexes'").get()) return;
  const bindings = connection.prepare("SELECT name,definition FROM clank_source_search_indexes ORDER BY name LIMIT 17").all();
  if (bindings.length > 16) throw new RangeError("Source-search binding capacity exceeded.");
  for (const row of bindings) {
    const binding = parseSearchBinding(String(row.definition));
    if (row.name !== binding.name) throw new Error("Source-search binding identity mismatch.");
    const affected = changed.filter(record => record.table === binding.table);
    if (!affected.length) continue;
    if (Number(connection.prepare(`SELECT count(*) AS records FROM ${sourceSearchTable(binding)}`).get()?.records) > binding.maxRecords) throw new RangeError("Source-search source exceeds its configured record capacity.");
    // Account for the final batch, so a valid byte/scope swap is not rejected
    // because a later affected record has not released its old allocation yet.
    for (const record of affected) connection.prepare(`DELETE FROM ${SOURCE_SEARCH_FTS} WHERE index_name=? AND id=?`).run(binding.name, record.id);
    for (const record of affected) projectSearchRecord(connection, binding, record.id);
    connection.prepare("UPDATE clank_source_search_indexes SET revision=revision+1 WHERE name=?").run(binding.name);
  }
}
