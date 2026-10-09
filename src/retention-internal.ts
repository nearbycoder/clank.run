import { BackendActionError, type ReadDatabase } from "./backend.ts";
import type { AuthRequest } from "./auth.ts";
import { isRetentionHeld, retentionHistoryUsage, type SQLiteInternal } from "./sqlite-internal.ts";
import { requireFeatureAccess } from "./feature-service.ts";
import type { RetentionAdministrationOptions, RetentionHold, RetentionInventory, RetentionKind, RetentionOperation, RetentionPurgePreview, RetentionPurgeReceipt, RetentionPurgeSelection, RetentionResource, RetentionResourceIdentity, RetentionResourceRef, RetentionSchedule, RetentionScheduleInput } from "./retention-administration.ts";

type Context = { auth: AuthRequest<any>; db: ReadDatabase<any> };
export interface RetentionControllerOptions extends Omit<RetentionAdministrationOptions, "path" | "auth" | "sources" | "schema" | "prefix"> {
  native: SQLiteInternal; kinds: readonly RetentionKind[];
  refresh(userId: string, sessionId: string): AuthRequest<any> | null;
}
type Source = RetentionResourceIdentity & { storedId: string; state: string; version: number; createdAt: number; revision?: number; retiredThrough?: number };
type Entry = { action: "delete" | "expire" | "history" | "audit"; table: string; id: string; owner: string | null; data: any; version: number; bytes: number; records: number; source: Source; cursor?: { revision: number; sequence: number } };
const KINDS = ["import", "collaboration", "audit"] as const;
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const text = (value: unknown, maximum = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const key = (ref: RetentionResourceRef) => `${ref.kind}:${ref.id}`;
const exact = (value: any, names: string[]) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(name => names.includes(name));
const invalid = (message: string): never => { throw new BackendActionError(400, "RETENTION_INPUT", message); };
const conflict = (message: string): never => { throw new BackendActionError(409, "RETENTION_STALE", message); };
const capacity = (message: string): never => { throw new BackendActionError(503, "RETENTION_CAPACITY", message); };

/** Private controller: called inside the host's existing SQLite/auth boundary. */
export async function createRetentionController(options: RetentionControllerOptions) {
  const policyRevision = options.policyRevision, authorizePolicy = options.authorize, resolveScope = options.scope, refresh = options.refresh, interval = options.intervalMs;
  const native = options.native, kinds = [...options.kinds], maximum = options.maxResources ?? 10000, maxReceipts = options.maxReceipts ?? 100000,
    maxReceiptBytes = options.maxReceiptBytes ?? 64 * 1024 * 1024, maxHolds = options.maxHolds ?? 10000, maxSchedules = options.maxSchedules ?? 1000;
  if (!text(policyRevision, 100) || !kinds.length || kinds.some(kind => !KINDS.includes(kind)) || new Set(kinds).size !== kinds.length || !integer(maximum, 1, 50000) || !integer(maxReceipts, 1, 100000) || !integer(maxReceiptBytes, 1, 128 * 1024 * 1024) || !integer(maxHolds, 1, 50000) || !integer(maxSchedules, 1, 10000) || interval !== undefined && interval !== false && !integer(interval, 1000, 3600000)) throw new TypeError("Declare bounded retention capacities, cadence and policy revision.");
  const cryptoName = "node:crypto", crypto = await import(cryptoName);
  const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  native.exec(`CREATE TABLE IF NOT EXISTS clank_retention_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0));
    INSERT OR IGNORE INTO clank_retention_state VALUES(1,1,0);
    CREATE TABLE IF NOT EXISTS clank_retention_holds(kind TEXT NOT NULL,resource_id TEXT NOT NULL,scope TEXT NOT NULL,reason TEXT NOT NULL,expires_at INTEGER,version INTEGER NOT NULL,PRIMARY KEY(kind,resource_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS clank_retention_receipts(principal_id TEXT NOT NULL,operation_id TEXT NOT NULL,scope TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(principal_id,operation_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS clank_retention_schedules(scope TEXT NOT NULL,id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,next_at INTEGER NOT NULL,definition TEXT NOT NULL CHECK(json_valid(definition)),last_at INTEGER,last_receipt TEXT,error TEXT,cursor TEXT NOT NULL,policy_revision TEXT NOT NULL,PRIMARY KEY(scope,id)) WITHOUT ROWID;`);
  if (native.prepare("SELECT protocol FROM clank_retention_state WHERE singleton=1").get()?.protocol !== 1) throw new Error("Unsupported persisted retention protocol.");
  const holdRevision = () => { const revision = native.prepare("SELECT revision FROM clank_retention_state WHERE singleton=1").get()?.revision; if (!integer(revision, 0)) throw new Error("Invalid persisted retention revision."); return revision; };
  const bump = () => { if (holdRevision() >= Number.MAX_SAFE_INTEGER) capacity("Retention revision exhausted."); native.prepare("UPDATE clank_retention_state SET revision=revision+1 WHERE singleton=1").run(); return holdRevision(); };
  const context = (auth: AuthRequest<any>): Context => {
    requireFeatureAccess(Boolean(auth.user && auth.session));
    const fresh = refresh(auth.user!.id, auth.session!.id); requireFeatureAccess(Boolean(fresh?.user && fresh.session));
    return native.readScoped(fresh!.user!.id, db => ({ auth: fresh!, db }));
  };
  const authorize = (ctx: Context, scope: string, operation: RetentionOperation) => { if (!text(scope)) invalid("Invalid retention scope."); requireFeatureAccess(authorizePolicy(ctx, scope, operation)); };
  const scopeOf = (ctx: Context, source: Source) => {
    const result = resolveScope(ctx, { kind: source.kind, id: source.id, ...(source.ownerId ? { ownerId: source.ownerId } : {}), ...(source.kind === "audit" ? { organizationId: source.organizationId, projectId: source.projectId } : {}) });
    if (result !== null && !text(result)) { void Promise.resolve(result).catch(() => undefined); requireFeatureAccess(false); }
    return result;
  };
  const holdFor = (scope: string, source: Source): RetentionHold | null => {
    const active = isRetentionHeld(native, source.kind, source.id);
    const row = native.prepare("SELECT * FROM clank_retention_holds WHERE kind=? AND resource_id=?").get(source.kind, source.id);
    if (!row) return null;
    // Holds survive a trusted scope transfer; reasons belong to the original scope.
    return { active, version: Number(row.version), reason: row.scope === scope ? String(row.reason) : "Held by another authorized scope.", expiresAt: row.expires_at === null ? null : Number(row.expires_at) };
  };
  const exists = (table: string) => Boolean(native.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
  const sources = (requested = kinds, only?: RetentionResourceRef): Source[] => {
    const result: Source[] = [];
    for (const kind of requested) {
      if (!kinds.includes(kind)) continue;
      let rows: any[];
      if (kind === "import") rows = native.prepare(`SELECT _id,_owner_id,_version,_creation_time,json_extract(_data,'$.state') AS state FROM clank_durableImportJobs ${only ? "WHERE _id=?" : ""} ORDER BY _id LIMIT ?`).all(...(only ? [only.id] : []), maximum + 1);
      else if (kind === "collaboration") rows = native.prepare(`SELECT _id,_version,_creation_time,json_extract(_data,'$.key') AS key,json_extract(_data,'$.revision') AS revision,coalesce(json_extract(_data,'$.retiredThrough'),0) AS retired FROM clank_collaborativeDocs ${only ? "WHERE json_extract(_data,'$.key')=?" : ""} ORDER BY _id LIMIT ?`).all(...(only ? [only.id] : []), maximum + 1);
      else rows = exists("clank_platform_audit") ? native.prepare(`SELECT id,actor_user_id,organization_id,project_id,created_at FROM clank_platform_audit ${only ? "WHERE id=?" : ""} ORDER BY id LIMIT ?`).all(...(only ? [only.id] : []), maximum + 1) : [];
      if (rows.length > maximum || result.length + rows.length > maximum) capacity("Source inventory exceeds the declared per-database resource bound.");
      for (const row of rows) {
        if (kind === "audit" ? !integer(row.id, 1) || !integer(row.created_at, 0) || [row.actor_user_id, row.organization_id, row.project_id].some(value => value !== null && !text(value))
          : !text(row._id) || !integer(row._version, 1) || !integer(row._creation_time, 0) || (kind === "import" ? !text(row._owner_id) || !["uploading", "ready", "running", "failed", "completed", "cancelled"].includes(row.state) : !text(row.key) || !integer(row.revision, 0) || !integer(row.retired, 0, row.revision))) throw new Error("Invalid persisted retention source identity.");
        result.push(kind === "audit" ? { kind, id: String(row.id), storedId: String(row.id), ownerId: typeof row.actor_user_id === "string" ? row.actor_user_id : undefined, organizationId: row.organization_id as string | null, projectId: row.project_id as string | null, createdAt: row.created_at, version: 1, state: "audit" }
          : { kind, id: kind === "import" ? row._id : row.key, storedId: row._id, ownerId: kind === "import" ? row._owner_id : undefined, state: kind === "import" ? row.state : "document", version: row._version, createdAt: row._creation_time, ...(kind === "collaboration" ? { revision: row.revision, retiredThrough: row.retired } : {}) });
      }
    }
    return result.sort((a, b) => key(a).localeCompare(key(b), "en"));
  };
  const selected = (ctx: Context, scope: string, ref: RetentionResourceRef): Source => {
    if (!exact(ref, ["kind", "id"]) || !KINDS.includes(ref.kind) || !text(ref.id) || !kinds.includes(ref.kind)) invalid("Unsupported retention resource.");
    const matches = sources([ref.kind], ref).filter(source => source.id === ref.id); const source = matches.length === 1 ? matches[0] : undefined; requireFeatureAccess(Boolean(source) && scopeOf(ctx, source!) === scope); return source!;
  };
  const tableNames = (source: Source) => source.kind === "import" ? ["durableImportChunks", "durableImportCorrections", "durableImportOperations"] : ["collaborativeOperations", "collaborativeReceipts"];
  const totals = (source: Source) => {
    let payloadRows = 0, payloadBytes = 0, receiptRows = 0, receiptBytes = 0, historyRows = 0, historyBytes = 0, identityRows = 1, protectedRows = 0, protectedBytes = 0;
    if (source.kind === "audit") {
      const row = native.prepare("SELECT length(CAST(metadata AS BLOB)) AS bytes FROM clank_platform_audit WHERE id=?").get(Number(source.id))!;
      payloadRows = 1; payloadBytes = Number(row.bytes);
      if (exists("clank_audit_export_outbox")) { const envelope = native.prepare("SELECT length(CAST(envelope AS BLOB)) AS bytes FROM clank_audit_export_outbox WHERE sequence=?").get(Number(source.id)); if (envelope) { receiptRows = 1; receiptBytes = Number(envelope.bytes); } }
    } else for (const table of tableNames(source)) {
      if (!exists(`clank_${table}`)) continue;
      const field = source.kind === "import" ? "jobId" : "documentId", owner = source.kind === "import" ? " AND _owner_id=?" : "", parameters = source.kind === "import" ? [source.id, source.ownerId] : [source.id];
      const receipt = table.endsWith("Operations") && source.kind === "import" || table.endsWith("Receipts");
      const current = native.prepare(`SELECT count(*) AS rows,coalesce(sum(length(CAST(_data AS BLOB))),0) AS bytes FROM clank_${table} WHERE json_extract(_data,'$.${field}')=?${owner}`).get(...parameters)!;
      if (receipt) { receiptRows += Number(current.rows); receiptBytes += Number(current.bytes);
        if (source.kind === "import") { const retired = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(_data AS BLOB))),0) AS bytes FROM clank_durableImportOperations WHERE json_extract(_data,'$.jobId')=? AND _owner_id=? AND json_extract(_data,'$.expired')=1").get(source.id, source.ownerId)!; identityRows += Number(retired.rows); receiptRows -= Number(retired.rows); receiptBytes -= Number(retired.bytes); protectedRows += Number(retired.rows); protectedBytes += Number(retired.bytes); } } else { payloadRows += Number(current.rows); payloadBytes += Number(current.bytes); }
      const history = native.prepare(`SELECT count(*) AS rows,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions WHERE table_name=? AND json_extract(snapshot_data,'$.${field}')=?${source.kind === "import" ? " AND owner_id=?" : ""}`).get(table, ...parameters)!;
      historyRows += Number(history.rows); historyBytes += Number(history.bytes);
      if (source.kind === "import" && table === "durableImportOperations") {
        const identities = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions WHERE table_name=? AND json_extract(snapshot_data,'$.jobId')=? AND owner_id=? AND json_extract(snapshot_data,'$.expired')=1").get(table, ...parameters)!;
        protectedRows += Number(identities.rows); protectedBytes += Number(identities.bytes);
      }
    }
    if (source.kind !== "audit") {
      const sourceTable = source.kind === "import" ? "durableImportJobs" : "collaborativeDocs";
      const sourceBytes = Number(native.prepare(`SELECT length(CAST(_data AS BLOB)) AS bytes FROM clank_${sourceTable} WHERE _id=?`).get(source.storedId)!.bytes);
      protectedRows++; protectedBytes += sourceBytes;
      if (source.kind === "collaboration") { payloadRows++; payloadBytes += sourceBytes; }
      const sourceHistory = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions WHERE table_name=? AND document_id=?").get(sourceTable, source.storedId)!;
      historyRows += Number(sourceHistory.rows); historyBytes += Number(sourceHistory.bytes); protectedRows += Number(sourceHistory.rows); protectedBytes += Number(sourceHistory.bytes);
      if (source.kind === "collaboration" && exists("clank_collaborativeBranches")) {
        const branches = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(_data AS BLOB))),0) AS bytes FROM clank_collaborativeBranches WHERE json_extract(_data,'$.documentId')=?").get(source.id)!;
        const branchHistory = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions WHERE table_name='collaborativeBranches' AND json_extract(snapshot_data,'$.documentId')=?").get(source.id)!;
        payloadRows += Number(branches.rows); payloadBytes += Number(branches.bytes); historyRows += Number(branchHistory.rows); historyBytes += Number(branchHistory.bytes);
        protectedRows += Number(branches.rows) + Number(branchHistory.rows); protectedBytes += Number(branches.bytes) + Number(branchHistory.bytes);
      }
    }
    return { payloadRows, payloadBytes, receiptRows, receiptBytes, historyRows, historyBytes, identityRows, protectedRows, protectedBytes };
  };
  const publicResource = (scope: string, source: Source): RetentionResource => {
    const acknowledged = source.kind === "audit" && exists("clank_audit_export_state") && Number(native.prepare("SELECT exported_sequence FROM clank_audit_export_state WHERE singleton=1").get()?.exported_sequence ?? 0) >= Number(source.id);
    return { kind: source.kind, id: source.id, state: source.kind === "audit" ? acknowledged ? "acknowledged" : "unacknowledged" : source.state, version: source.version, createdAt: source.createdAt, ...totals(source), hold: holdFor(scope, source) };
  };
  const replay = (ctx: Context, scope: string, operation: RetentionOperation, operationId: string, input: unknown, execute: () => unknown): any => {
    if (!text(operationId, 100)) invalid("Operation ID is required."); authorize(ctx, scope, operation);
    const fingerprint = hash([operation, input]), row = native.prepare("SELECT * FROM clank_retention_receipts WHERE principal_id=? AND operation_id=?").get(ctx.auth.user!.id, operationId);
    if (row) { if (row.scope !== scope || row.operation !== operation || row.fingerprint !== fingerprint) conflict("Operation ID belongs to different retention input."); return JSON.parse(String(row.result)); }
    const result = execute(), encoded = JSON.stringify(result);
    const usage = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(result AS BLOB))),0) AS bytes FROM clank_retention_receipts").get()!;
    if (Number(usage.rows) >= maxReceipts || new TextEncoder().encode(encoded).length > 128 * 1024 || Number(usage.bytes) + new TextEncoder().encode(encoded).length > maxReceiptBytes) capacity("Retention receipt capacity reached; accepted identities are not discarded to admit work.");
    native.prepare("INSERT INTO clank_retention_receipts VALUES(?,?,?,?,?,?)").run(ctx.auth.user!.id, operationId, scope, operation, fingerprint, encoded); return result;
  };
  const inventory = (auth: AuthRequest<any>, input: { scope: string; kinds: readonly RetentionKind[]; after?: string; limit: number }): RetentionInventory => {
    const ctx = context(auth); authorize(ctx, input.scope, "read");
    if (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.length > 3 || input.kinds.some(kind => !KINDS.includes(kind)) || new Set(input.kinds).size !== input.kinds.length || !integer(input.limit, 1, 100)) invalid("Invalid inventory bounds.");
    const resources = sources([...input.kinds]).filter(source => scopeOf(ctx, source) === input.scope).map(source => publicResource(input.scope, source));
    const generation = hash([input.scope, input.kinds, policyRevision, resources]);
    let after = "";
    if (input.after !== undefined) { let cursor: any; try { cursor = JSON.parse(input.after); } catch { invalid("Invalid inventory cursor."); } if (!exact(cursor, ["generation", "after"]) || cursor.generation !== generation || !text(cursor.after, 500)) conflict("Inventory or policy changed; refresh from the first page."); after = cursor.after; }
    const remaining = resources.filter(ref => !after || key(ref).localeCompare(after, "en") > 0), page = remaining.slice(0, input.limit);
    return { scope: input.scope, resources: page, next: remaining.length > page.length ? JSON.stringify({ generation, after: key(page.at(-1)!) }) : null };
  };
  const collect = (source: Source, cutoff: number, budget: number, snapshot: { remaining: number }): Entry[] => {
    const entries: Entry[] = [];
    const reserve = (bytes: number) => { if (!integer(bytes, 0, snapshot.remaining)) capacity("Source snapshot exceeds 16 MiB; choose fewer resources or a smaller deletion bound."); snapshot.remaining -= bytes; };
    if (source.kind === "audit") {
      const state = exists("clank_audit_export_state") ? native.prepare("SELECT * FROM clank_audit_export_state WHERE singleton=1").get() : undefined;
      if (!state || Number(state.exported_sequence) < Number(source.id) || source.createdAt > cutoff) return entries;
      reserve(Number(native.prepare("SELECT length(CAST(metadata AS BLOB)) AS bytes FROM clank_platform_audit WHERE id=?").get(Number(source.id))!.bytes));
      reserve(Number(native.prepare("SELECT length(CAST(envelope AS BLOB)) AS bytes FROM clank_audit_export_outbox WHERE sequence=?").get(Number(source.id))?.bytes ?? 0));
      const row = native.prepare("SELECT * FROM clank_platform_audit WHERE id=?").get(Number(source.id))!;
      const envelope = native.prepare("SELECT envelope FROM clank_audit_export_outbox WHERE sequence=?").get(Number(source.id));
      entries.push({ action: "audit", table: "clank_platform_audit", id: source.id, owner: null, data: { row, envelope, checkpoint: { sequence: state.exported_sequence, digest: state.exported_digest, captured: state.captured_sequence } }, version: 1, bytes: new TextEncoder().encode(JSON.stringify(row)).length + (envelope ? new TextEncoder().encode(String(envelope.envelope)).length : 0), records: envelope ? 2 : 1, source }); return entries[0]!.records <= budget ? entries : [];
    }
    for (const table of tableNames(source)) {
      if (!exists(`clank_${table}`)) continue;
      const field = source.kind === "import" ? "jobId" : "documentId", owner = source.kind === "import" ? " AND _owner_id=?" : "", parameters = source.kind === "import" ? [source.id, source.ownerId] : [source.id];
      const expiry = source.kind === "import" && table === "durableImportOperations" ? " AND coalesce(json_extract(_data,'$.expired'),0)=0" : "";
      const rowSql = `SELECT * FROM clank_${table} WHERE json_extract(_data,'$.${field}')=?${owner}${expiry} AND _creation_time<=? ORDER BY _id LIMIT ?`;
      const snapshotBytes = native.prepare(`SELECT coalesce(sum(length(CAST(_data AS BLOB))),0) AS bytes FROM (${rowSql})`).get(...parameters, cutoff, budget + 1)!;
      reserve(Number(snapshotBytes.bytes));
      const rows = native.prepare(rowSql).all(...parameters, cutoff, budget + 1);
      for (const row of rows) {
        const data = JSON.parse(String(row._data));
        if (source.kind === "import" && table === "durableImportOperations" && data.expired === true) continue;
        const historical = native.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM clank_document_revisions WHERE table_name=? AND document_id=?").get(table, row._id)!;
        const records = 1 + Number(historical.rows);
        if (entries.reduce((n, entry) => n + entry.records, 0) + records > budget) continue;
        entries.push({ action: source.kind === "import" && table === "durableImportOperations" ? "expire" : "delete", table, id: String(row._id), owner: source.ownerId ?? null, data, version: Number(row._version), bytes: new TextEncoder().encode(String(row._data)).length + Number(historical.bytes), records, source });
      }
      // Held replacement records may already be deleted, with their history intact.
      const retired = native.prepare(`SELECT document_id,max(revision) AS revision FROM clank_document_revisions h WHERE table_name=? AND json_extract(snapshot_data,'$.${field}')=?${source.kind === "import" ? " AND owner_id=?" : ""} AND NOT EXISTS(SELECT 1 FROM clank_${table} c WHERE c._id=h.document_id) GROUP BY document_id ORDER BY document_id LIMIT ?`).all(table, ...parameters, budget + 1);
      for (const record of retired) {
        const historySql = "SELECT * FROM clank_document_revisions WHERE table_name=? AND document_id=? ORDER BY revision DESC,sequence DESC LIMIT ?";
        reserve(Number(native.prepare(`SELECT coalesce(sum(length(CAST(snapshot_data AS BLOB))),0) AS bytes FROM (${historySql})`).get(table, record.document_id, budget + 1)!.bytes));
        const rows = native.prepare(historySql).all(table, record.document_id, budget + 1);
        const latest = rows[0]; if (!latest || latest.operation !== "delete" || Number(latest.recorded_at) > cutoff || rows.length > budget || entries.reduce((n, entry) => n + entry.records, 0) + rows.length > budget) continue;
        if (rows.some(row => row.owner_id !== (source.ownerId ?? null) || JSON.parse(String(row.snapshot_data))[field] !== source.id)) throw new Error("Retired history source identity changed.");
        entries.push({ action: "history", table, id: String(record.document_id), owner: source.ownerId ?? null, data: rows.map(row => [row.revision, row.sequence, row.snapshot_data]), version: Number(latest.document_version), bytes: rows.reduce((n, row) => n + new TextEncoder().encode(String(row.snapshot_data)).length, 0), records: rows.length, source, cursor: { revision: Number(latest.revision), sequence: Number(latest.sequence) } });
      }
    }
    return entries;
  };
  const plan = (ctx: Context, selection: RetentionPurgeSelection) => {
    authorize(ctx, selection.scope, "purge");
    if (!exact(selection, ["scope", "resources", "cutoff", "maxDeletes"]) || !Array.isArray(selection.resources) || !selection.resources.length || selection.resources.length > 100 || !integer(selection.cutoff, 0, Date.now()) || !integer(selection.maxDeletes, 1, 10000) || new Set(selection.resources.map(key)).size !== selection.resources.length) invalid("Declare distinct bounded purge resources and a past cutoff.");
    const entries: Entry[] = [], items: RetentionPurgePreview["items"][number][] = [], snapshots: unknown[] = [], snapshot = { remaining: 16 * 1024 * 1024 };
    for (const ref of selection.resources) {
      const source = selected(ctx, selection.scope, ref), resource = publicResource(selection.scope, source);
      const blocked = resource.hold?.active ? "held" : source.kind === "import" && !["completed", "cancelled"].includes(source.state) ? "active" : source.kind === "audit" && resource.state !== "acknowledged" ? "unacknowledged" : null;
      const selectedEntries = blocked ? [] : collect(source, selection.cutoff, selection.maxDeletes - entries.reduce((n, entry) => n + entry.records, 0), snapshot);
      entries.push(...selectedEntries); snapshots.push([source, resource, selectedEntries]);
      items.push({ kind: ref.kind, id: ref.id, records: selectedEntries.reduce((n, entry) => n + entry.records, 0), bytes: selectedEntries.reduce((n, entry) => n + entry.bytes, 0), blocked });
    }
    if (entries.reduce((n, entry) => n + entry.bytes, 0) > 16 * 1024 * 1024) capacity("Purge snapshot exceeds 16 MiB; choose fewer resources or a smaller deletion bound.");
    const value = { ...selection, resources: selection.resources.map(ref => ({ kind: ref.kind, id: ref.id })), protocol: "clank-retention/1" as const, policyRevision: policyRevision, holdRevision: holdRevision(), items, records: entries.reduce((n, entry) => n + entry.records, 0), bytes: entries.reduce((n, entry) => n + entry.bytes, 0) };
    return { preview: { ...value, digest: hash([value, snapshots]) }, entries };
  };
  const perform = (entries: Entry[]) => {
    const floors = new Map<string, { source: Source; floor: number }>();
    for (const entry of entries) {
      if (isRetentionHeld(native, entry.source.kind, entry.source.id)) conflict("A hold prevents retirement.");
      if (entry.action === "audit") { native.prepare("DELETE FROM clank_audit_export_outbox WHERE sequence=?").run(Number(entry.id)); native.prepare("DELETE FROM clank_platform_audit WHERE id=?").run(Number(entry.id)); continue; }
      native.writeScoped(entry.owner, db => {
        const table = db.table(entry.table);
        if (entry.action === "history") { if (!table.purgeDeleted(entry.id as any, entry.cursor!)) conflict("Retired history changed."); }
        else {
          const current = table.get(entry.id as any); if (!current || current._version !== entry.version) conflict("Purge metadata changed.");
          table.delete(entry.id as any, { ifVersion: entry.version }); native.purgeDeletedHistory(entry.table, entry.id);
          if (entry.action === "expire") table.insert({ ...entry.data, result: "", targets: "[]", expired: true });
        }
      });
      if (entry.source.kind === "collaboration" && entry.action !== "history") {
        const old = floors.get(entry.source.id); floors.set(entry.source.id, { source: entry.source, floor: Math.max(old?.floor ?? entry.source.retiredThrough ?? 0, Number(entry.data.revision)) });
      }
    }
    for (const { source, floor } of floors.values()) native.writeScoped(null, db => db.table("collaborativeDocs").patch(source.storedId as any, { retiredThrough: floor }, { ifVersion: source.version }));
  };
  const preview = (auth: AuthRequest<any>, selection: RetentionPurgeSelection) => plan(context(auth), selection).preview;
  const accept = (auth: AuthRequest<any>, encoded: string, operationId: string): RetentionPurgeReceipt => {
    const ctx = context(auth); let input: RetentionPurgePreview; try { input = JSON.parse(encoded); } catch { return invalid("Invalid purge preview."); }
    if (!input || input.protocol !== "clank-retention/1") invalid("Invalid purge preview protocol.");
    return replay(ctx, input.scope, "purge", operationId, input, () => {
      const fresh = plan(ctx, { scope: input.scope, resources: input.resources, cutoff: input.cutoff, maxDeletes: input.maxDeletes });
      if (JSON.stringify(fresh.preview) !== JSON.stringify(input)) conflict("Source, hold, policy or payload changed; preview again.");
      perform(fresh.entries); return { operationId, scope: input.scope, records: fresh.preview.records, bytes: fresh.preview.bytes, acceptedAt: Date.now() };
    });
  };
  const hold = (auth: AuthRequest<any>, input: { scope: string; resource: RetentionResourceRef; expectedVersion: number; reason: string; expiresAt: number | null; operationId: string }): RetentionHold => {
    const ctx = context(auth); return replay(ctx, input.scope, "hold", input.operationId, input, () => {
      selected(ctx, input.scope, input.resource);
      if (!integer(input.expectedVersion, 0) || !text(input.reason, 2000) || input.expiresAt !== null && !integer(input.expiresAt, Date.now() + 1)) invalid("Invalid hold version, reason or expiry.");
      const old = native.prepare("SELECT * FROM clank_retention_holds WHERE kind=? AND resource_id=?").get(input.resource.kind, input.resource.id);
      if (old && old.scope !== input.scope || Number(old?.version ?? 0) !== input.expectedVersion) conflict("Hold changed or belongs to another scope.");
      if (!old && Number(native.prepare("SELECT count(*) AS rows FROM clank_retention_holds").get()!.rows) >= maxHolds) capacity("Hold capacity reached.");
      const version = bump(); native.prepare("INSERT INTO clank_retention_holds VALUES(?,?,?,?,?,?) ON CONFLICT(kind,resource_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,version=excluded.version").run(input.resource.kind, input.resource.id, input.scope, input.reason, input.expiresAt, version);
      const history = retentionHistoryUsage(native); if (history.records > 100000 || history.bytes > 128 * 1024 * 1024) capacity("Held source history exceeds 100,000 records or 128 MiB.");
      return { active: true, version, reason: input.reason, expiresAt: input.expiresAt };
    });
  };
  const release = (auth: AuthRequest<any>, input: { scope: string; resource: RetentionResourceRef; expectedVersion: number; operationId: string }): null => {
    const ctx = context(auth); return replay(ctx, input.scope, "hold", input.operationId, input, () => {
      selected(ctx, input.scope, input.resource); const old = native.prepare("SELECT * FROM clank_retention_holds WHERE kind=? AND resource_id=?").get(input.resource.kind, input.resource.id);
      if (!old || old.scope !== input.scope || old.version !== input.expectedVersion) conflict("Hold changed; refresh before releasing it.");
      bump(); native.prepare("DELETE FROM clank_retention_holds WHERE kind=? AND resource_id=?").run(input.resource.kind, input.resource.id); return null;
    });
  };
  const scheduleInput = (input: any): RetentionScheduleInput => {
    if (!exact(input, ["id", "scope", "expectedVersion", "kinds", "olderThanMs", "everyMs", "maxDeletes", "state"]) || !text(input.id, 100) || !text(input.scope) || !integer(input.expectedVersion, 0) || !Array.isArray(input.kinds) || !input.kinds.length || input.kinds.length > 3 || input.kinds.some((kind: RetentionKind) => !kinds.includes(kind)) || new Set(input.kinds).size !== input.kinds.length || !integer(input.olderThanMs, 0, 3650 * 86400000) || !integer(input.everyMs, 1000, 365 * 86400000) || !integer(input.maxDeletes, 1, 10000) || !["active", "paused"].includes(input.state)) invalid("Invalid bounded periodic retention schedule.");
    return input;
  };
  const scheduleOutput = (row: any): RetentionSchedule => {
    if (!text(row.definition, 10000) || row.last_receipt !== null && !text(row.last_receipt, 128 * 1024) || row.error !== null && !text(row.error, 100)) throw new Error("Invalid persisted retention schedule bounds.");
    const { expectedVersion: _expected, ...definition } = scheduleInput(JSON.parse(String(row.definition)));
    if (!integer(row.version, 1) || !integer(row.next_at, 0) || row.last_at !== null && !integer(row.last_at, 0) || definition.id !== row.id || definition.scope !== row.scope) throw new Error("Invalid persisted retention schedule.");
    return { ...definition, version: Number(row.version), nextAt: Number(row.next_at), lastAt: row.last_at === null ? null : Number(row.last_at), lastReceipt: row.last_receipt === null ? null : JSON.parse(String(row.last_receipt)), error: row.error === null ? null : String(row.error) };
  };
  const schedules = (auth: AuthRequest<any>, scope: string): RetentionSchedule[] => {
    const ctx = context(auth); authorize(ctx, scope, "read");
    if (Number(native.prepare("SELECT coalesce(sum(length(CAST(definition AS BLOB))+coalesce(length(CAST(last_receipt AS BLOB)),0)),0) AS bytes FROM clank_retention_schedules WHERE scope=?").get(scope)!.bytes) > 1024 * 1024) capacity("Schedule inventory exceeds 1 MiB; use a narrower scope.");
    const rows = native.prepare("SELECT * FROM clank_retention_schedules WHERE scope=? ORDER BY id LIMIT ?").all(scope, maxSchedules + 1);
    if (rows.length > maxSchedules) capacity("Schedule inventory exceeds its configured capacity."); return rows.map(scheduleOutput);
  };
  const saveSchedule = (auth: AuthRequest<any>, encoded: string, operationId: string): RetentionSchedule => {
    const ctx = context(auth); let raw: any; try { raw = JSON.parse(encoded); } catch { return invalid("Invalid schedule JSON."); }
    const input = scheduleInput(raw);
    return replay(ctx, input.scope, "schedule", operationId, input, () => {
      // A scheduled purge needs both schedule administration and purge authority.
      authorize(ctx, input.scope, "purge");
      const old = native.prepare("SELECT * FROM clank_retention_schedules WHERE scope=? AND id=?").get(input.scope, input.id);
      if (Number(old?.version ?? 0) !== input.expectedVersion) conflict("Schedule changed; refresh its version.");
      if (!old && Number(native.prepare("SELECT count(*) AS rows FROM clank_retention_schedules").get()!.rows) >= maxSchedules) capacity("Schedule capacity reached.");
      const version = Number(old?.version ?? 0) + 1, next = Date.now() + input.everyMs;
      if (!integer(version, 1) || !integer(next, 0)) capacity("Schedule revision or timestamp exhausted.");
      native.prepare("INSERT INTO clank_retention_schedules(scope,id,user_id,session_id,version,next_at,definition,last_at,last_receipt,error,cursor,policy_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,version=excluded.version,next_at=excluded.next_at,definition=excluded.definition,error=NULL,cursor=excluded.cursor,policy_revision=excluded.policy_revision")
        .run(input.scope, input.id, ctx.auth.user!.id, ctx.auth.session!.id, version, next, JSON.stringify(input), old?.last_at ?? null, old?.last_receipt ?? null, null, "", policyRevision);
      return scheduleOutput(native.prepare("SELECT * FROM clank_retention_schedules WHERE scope=? AND id=?").get(input.scope, input.id));
    });
  };
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const runDue = (): number => {
    if (closed) throw new Error("Retention runner is closed.");
    const due = native.prepare("SELECT scope,id,version,next_at FROM clank_retention_schedules WHERE next_at<=? AND json_extract(definition,'$.state')='active' ORDER BY next_at,scope,id LIMIT 8").all(Date.now());
    let accepted = 0;
    for (const candidate of due) {
      try {
        const ran = native.transaction(() => {
          const row = native.prepare("SELECT * FROM clank_retention_schedules WHERE scope=? AND id=?").get(candidate.scope, candidate.id);
          if (!row || row.version !== candidate.version || row.next_at !== candidate.next_at) return false;
          const schedule = scheduleOutput(row); if (row.policy_revision !== policyRevision) throw new BackendActionError(409, "RETENTION_POLICY_CHANGED", "Review and save the schedule under the current policy revision."); if (schedule.state !== "active" || schedule.nextAt > Date.now()) return false;
          const auth = refresh(String(row.user_id), String(row.session_id));
          if (!auth?.user || !auth.session) throw new Error("The schedule principal is no longer authorized.");
          const ctx = context(auth); authorize(ctx, schedule.scope, "schedule"); authorize(ctx, schedule.scope, "purge");
          const cutoff = Math.max(0, Date.now() - schedule.olderThanMs), available = sources([...schedule.kinds]).filter(source => scopeOf(ctx, source) === schedule.scope);
          const ordered = [...available.filter(source => !row.cursor || key(source).localeCompare(String(row.cursor), "en") > 0), ...available.filter(source => row.cursor && key(source).localeCompare(String(row.cursor), "en") <= 0)];
          const refs = ordered.slice(0, 100).map(source => ({ kind: source.kind, id: source.id }));
          let receipt: RetentionPurgeReceipt | null = null;
          if (refs.length) {
            const reviewed = plan(ctx, { scope: schedule.scope, resources: refs, cutoff, maxDeletes: schedule.maxDeletes });
            receipt = replay(ctx, schedule.scope, "purge", `schedule:${hash([schedule.scope, schedule.id, schedule.nextAt])}`, reviewed.preview, () => {
              perform(reviewed.entries); return { operationId: `schedule:${hash([schedule.scope, schedule.id, schedule.nextAt])}`, scope: schedule.scope, records: reviewed.preview.records, bytes: reviewed.preview.bytes, acceptedAt: Date.now() };
            });
          }
          const now = Date.now(), next = schedule.nextAt + (Math.floor((now - schedule.nextAt) / schedule.everyMs) + 1) * schedule.everyMs;
          if (!integer(next, now + 1) || schedule.version >= Number.MAX_SAFE_INTEGER) capacity("Schedule timestamp or version exhausted.");
          native.prepare("UPDATE clank_retention_schedules SET version=version+1,next_at=?,last_at=?,last_receipt=?,error=NULL,cursor=? WHERE scope=? AND id=? AND version=?").run(next, now, receipt ? JSON.stringify(receipt) : null, refs.length ? key(refs.at(-1)!) : "", schedule.scope, schedule.id, schedule.version);
          return true;
        });
        if (ran) accepted++;
      } catch (error) {
        // A failed purge rolls back entirely. Persist a bounded failure and pause
        // the unchanged occurrence; another process may already have accepted it.
        native.transaction(() => {
          native.prepare("UPDATE clank_retention_schedules SET version=version+1,definition=json_set(definition,'$.state','paused'),error=? WHERE scope=? AND id=? AND version=? AND next_at=?")
            .run(error instanceof BackendActionError ? error.code : "RETENTION_RUN_FAILED", candidate.scope, candidate.id, candidate.version, candidate.next_at);
        });
      }
    }
    return accepted;
  };
  const start = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; try { runDue(); } catch { /* Persistent occurrence failures are paused; retry transient runner reads next cadence. */ } finally { if (!closed) start(); } }, interval || 60000);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  return { inventory, preview, accept, hold, release, schedules, saveSchedule, runDue, start, close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; } };
}

/** Shared wire allowlist; platform keeps its browser auth and CSRF middleware. */
export function dispatchRetention(controller: Awaited<ReturnType<typeof createRetentionController>>, auth: AuthRequest<any>, operation: string, method: string, input: any): unknown {
  const methods: Record<string, { operation: string; fields: string[]; run: () => unknown }> = {
    inventory: { operation: "query", fields: ["scope", "kinds", "after", "limit"], run: () => controller.inventory(auth, input) },
    preview: { operation: "query", fields: ["scope", "resources", "cutoff", "maxDeletes"], run: () => controller.preview(auth, input) },
    accept: { operation: "mutation", fields: ["preview", "operationId"], run: () => controller.accept(auth, input.preview, input.operationId) },
    hold: { operation: "mutation", fields: ["scope", "resource", "expectedVersion", "reason", "expiresAt", "operationId"], run: () => controller.hold(auth, input) },
    release: { operation: "mutation", fields: ["scope", "resource", "expectedVersion", "operationId"], run: () => controller.release(auth, input) },
    schedules: { operation: "query", fields: ["scope"], run: () => controller.schedules(auth, input.scope) },
    saveSchedule: { operation: "mutation", fields: ["input", "operationId"], run: () => controller.saveSchedule(auth, input.input, input.operationId) },
  };
  const entry = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!entry) return invalid("Unknown retention operation or input fields.");
  if (operation !== entry.operation || !exact(input, entry.fields)) invalid("Unknown retention operation or input fields.");
  if (method === "accept" && !text(input.preview, 1024 * 1024) || method === "saveSchedule" && !text(input.input, 10000) || method === "inventory" && input.after !== undefined && !text(input.after, 1000)) invalid("Retention wire input exceeds its bound.");
  return entry.run();
}
