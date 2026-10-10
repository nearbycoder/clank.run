import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { ProjectIncident, ProjectIncidentChange, ProjectIncidentDetail, ProjectIncidentDiagnostic, ProjectIncidentDiagnostics, ProjectIncidentLink, ProjectIncidentOwner, ProjectIncidentPage, ProjectIncidentReference } from "./project-incidents.ts";

export interface PlatformIncidentOptions {
  maxIncidents?: number;
  maxReceipts?: number;
  /** Trusted readonly projection into the application's own diagnostic storage. */
  diagnostics?: ProjectIncidentDiagnostics;
}
type Permission = "read" | "logs" | "jobs";
export interface IncidentAuthority {
  readonly userId: string;
  authorize(permission?: Permission): void;
  mayRead(permission: Permission): boolean;
  ownerAllowed(userId: string): boolean;
  owners(): readonly ProjectIncidentOwner[];
  audit(action: string, metadata: Record<string, unknown>): void;
}
export interface IncidentRelease { readonly id: string; readonly digest: string; readonly createdAt: number; readonly available: boolean; }
export class ProjectIncidentError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new ProjectIncidentError(status, code, message); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(422, "INCIDENT_INPUT_INVALID", "Choose a valid incident operation.");
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, fields: readonly string[]) => {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail(422, "INCIDENT_INPUT_INVALID", "Choose exact incident fields.");
};
const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(422, "INCIDENT_INPUT_INVALID", "Choose a bounded incident number.");
  return Number(value);
};
const text = (value: unknown, maximum: number): string => {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(422, "INCIDENT_INPUT_INVALID", "Choose bounded incident text.");
  return value as string;
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) fail(422, "INCIDENT_INPUT_INVALID", "Choose a valid incident identifier.");
  return value as string;
};
const owner = (value: unknown): string | null => value === null ? null : identifier(value);
const reference = (value: unknown): ProjectIncidentReference => {
  const input = object(value), kind = input.kind;
  if (kind === "release") { exact(input, ["kind", "id"]); return {kind, id: identifier(input.id)}; }
  if (kind !== "error" && kind !== "trace" && kind !== "job" && kind !== "workflow" && kind !== "alert") fail(422, "INCIDENT_INPUT_INVALID", "Choose a supported diagnostic reference.");
  exact(input, kind === "alert" ? ["kind", "id"] : ["kind", "id", "releaseId"]);
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(input.id)) fail(422, "INCIDENT_INPUT_INVALID", "Choose a diagnostic identifier, without a URL or payload.");
  return kind === "alert" ? {kind, id: input.id as string} : {kind: kind as "error" | "trace" | "job" | "workflow", id: input.id as string, releaseId: identifier(input.releaseId)};
};
const permission = (ref: ProjectIncidentReference): Permission => ref.kind === "release" ? "read" : ref.kind === "job" || ref.kind === "workflow" ? "jobs" : "logs";
const states = new Set(["unknown", "open", "resolved", "regressed", "waiting", "queued", "running", "retry", "succeeded", "failed", "dead", "cancelled", "not-needed"]);

/** Private control-plane state; never stores application diagnostic payloads. */
export async function openProjectIncidents(sql: SQLiteInternal, options: PlatformIncidentOptions, hooks: {
  release(projectId: string, releaseId: string): IncidentRelease | null;
  alert(projectId: string, id: string): {readonly state: "open" | "resolved"; readonly observedAt: number} | null;
}) {
  const {randomUUID} = await import("node:crypto");
  const maxIncidents = integer(options.maxIncidents ?? 1000, 1, 100000), maxReceipts = integer(options.maxReceipts ?? 10000, 1, 100000);
  const protocol = () => {
    if (sql.prepare("SELECT protocol FROM clank_platform_incident_state WHERE singleton=1").get()?.protocol !== 1) fail(409, "INCIDENT_PROTOCOL_UNSUPPORTED", "Unsupported incident state protocol.");
  };
  if (sql.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_platform_incident_state'").get()) protocol();
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_incident_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL);
    INSERT OR IGNORE INTO clank_platform_incident_state VALUES(1,1);
    CREATE TABLE IF NOT EXISTS clank_platform_incidents(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,title TEXT NOT NULL,severity TEXT NOT NULL,state TEXT NOT NULL,owner_id TEXT,version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,resolved_at INTEGER,resolution TEXT);
    CREATE INDEX IF NOT EXISTS clank_platform_incidents_project ON clank_platform_incidents(project_id,sequence);
    CREATE TABLE IF NOT EXISTS clank_platform_incident_notes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT NOT NULL REFERENCES clank_platform_incidents(id) ON DELETE CASCADE,author_id TEXT NOT NULL,created_at INTEGER NOT NULL,text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS clank_platform_incident_notes_parent ON clank_platform_incident_notes(incident_id,sequence);
    CREATE TABLE IF NOT EXISTS clank_platform_incident_links(sequence INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT NOT NULL REFERENCES clank_platform_incidents(id) ON DELETE CASCADE,reference TEXT NOT NULL,release_context TEXT,UNIQUE(incident_id,reference));
    CREATE INDEX IF NOT EXISTS clank_platform_incident_links_parent ON clank_platform_incident_links(incident_id,sequence);
    CREATE TABLE IF NOT EXISTS clank_platform_incident_receipts(project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,operation_id));`);
  protocol();
  let closed = false;
  const pending = new Set<AbortController>();
  const check = (authority: IncidentAuthority, extra?: Permission) => {
    if (closed) fail(503, "INCIDENT_CLOSED", "Incident workspace is closed.");
    authority.authorize(extra); protocol();
  };
  const summary = (row: Record<string, unknown>): ProjectIncident => ({
    id: String(row.id), projectId: String(row.project_id), sequence: Number(row.sequence), title: String(row.title), severity: row.severity as ProjectIncident["severity"], state: row.state as ProjectIncident["state"], ownerId: row.owner_id === null ? null : String(row.owner_id), version: Number(row.version), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at), resolution: row.resolution === null ? null : String(row.resolution),
    noteCount: Number(sql.prepare("SELECT count(*) AS n FROM clank_platform_incident_notes WHERE incident_id=?").get(row.id)?.n), linkCount: Number(sql.prepare("SELECT count(*) AS n FROM clank_platform_incident_links WHERE incident_id=?").get(row.id)?.n),
  });
  const current = (projectId: string, id: string): ProjectIncident => {
    const row = sql.prepare("SELECT * FROM clank_platform_incidents WHERE project_id=? AND id=?").get(projectId, id);
    if (!row) return fail(404, "INCIDENT_NOT_FOUND", "Incident not found.");
    return summary(row);
  };
  const receipt = (projectId: string, authority: IncidentAuthority, operationId: string, request: string): ProjectIncident | null => {
    const row = sql.prepare("SELECT request,result FROM clank_platform_incident_receipts WHERE project_id=? AND actor_id=? AND operation_id=?").get(projectId, authority.userId, operationId);
    if (!row) return null;
    if (row.request !== request) fail(409, "INCIDENT_RETRY_CHANGED", "The operation ID belongs to a different request.");
    return JSON.parse(String(row.result)) as ProjectIncident;
  };
  const capacity = () => {
    if (Number(sql.prepare("SELECT count(*) AS n FROM clank_platform_incident_receipts").get()?.n) >= maxReceipts) fail(409, "INCIDENT_RECEIPT_CAPACITY", "Incident receipt capacity is full.");
  };
  const save = (projectId: string, authority: IncidentAuthority, operationId: string, request: string, result: ProjectIncident, kind: string) => {
    sql.prepare("INSERT INTO clank_platform_incident_receipts VALUES(?,?,?,?,?)").run(projectId, authority.userId, operationId, request, JSON.stringify(result));
    authority.audit("incident." + kind, {incidentId: result.id, version: result.version});
    return result;
  };
  const requireOwner = (authority: IncidentAuthority, ownerId: string | null) => {
    if (ownerId !== null && !authority.ownerAllowed(ownerId)) fail(403, "INCIDENT_OWNER_DENIED", "Assign a current project incident operator.");
  };
  const validateDiagnostic = (value: unknown, projectId: string, ref: ProjectIncidentReference): ProjectIncidentDiagnostic => {
    const input = object(value), fields = Object.keys(input);
    if (fields.some(key => !["projectId", "reference", "available", "observedAt", "state", "count"].includes(key)) || input.projectId !== projectId || JSON.stringify(reference(input.reference)) !== JSON.stringify(ref) || typeof input.available !== "boolean" || !Number.isSafeInteger(input.observedAt) || Number(input.observedAt) < 0 || Number(input.observedAt) > Date.now() + 60000 || input.state !== undefined && !states.has(String(input.state)) || input.count !== undefined && (!Number.isSafeInteger(input.count) || Number(input.count) < 0)) fail(422, "INCIDENT_DIAGNOSTIC_INVALID", "Diagnostic adapter returned an invalid scoped projection.");
    return {projectId, reference: ref, available: input.available as boolean, observedAt: Number(input.observedAt), ...(input.state === undefined ? {} : {state: input.state as ProjectIncidentDiagnostic["state"]}), ...(input.count === undefined ? {} : {count: Number(input.count)})};
  };
  const diagnostic = async (projectId: string, ref: Extract<ProjectIncidentReference, {releaseId: string}>, timeoutMs = 2000) => {
    if (!options.diagnostics) fail(409, "INCIDENT_ADAPTER_UNAVAILABLE", "Configure the scoped readonly diagnostic adapter first.");
    if (pending.size >= 4 || closed || timeoutMs <= 0) fail(503, "INCIDENT_DIAGNOSTIC_BUSY", "Diagnostic capacity is unavailable. Refresh later.");
    const controller = new AbortController(); pending.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProjectIncidentError(504, "INCIDENT_DIAGNOSTIC_TIMEOUT", "Diagnostic read timed out.")); }, Math.min(2000, timeoutMs)); });
    // Keep a capacity credit until the actual callback settles, even if it ignores abort.
    const work = Promise.resolve().then(() => options.diagnostics!.resolve(projectId, structuredClone(ref), controller.signal)).then(value => validateDiagnostic(value, projectId, ref)).finally(() => { pending.delete(controller); });
    try { return await Promise.race([work, expiration]); } finally { clearTimeout(timer!); }
  };
  const releaseContext = (projectId: string, ref: ProjectIncidentReference) => {
    const releaseId = ref.kind === "release" ? ref.id : "releaseId" in ref ? ref.releaseId : null;
    if (releaseId === null) return null;
    const release = hooks.release(projectId, releaseId);
    if (!release) fail(404, "INCIDENT_REFERENCE_NOT_FOUND", "Diagnostic release not found in this project.");
    return {id: release!.id, digest: release!.digest, createdAt: release!.createdAt};
  };
  return {
    close() { closed = true; for (const controller of pending) controller.abort(); },
    owners(authority: IncidentAuthority) { check(authority); return authority.owners(); },
    list(projectId: string, authority: IncidentAuthority, query: URLSearchParams): ProjectIncidentPage {
      check(authority);
      if ([...query.keys()].some(key => !["state", "after", "limit"].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) fail(422, "INCIDENT_INPUT_INVALID", "Choose exact incident filters.");
      const state = query.get("state");
      if (state !== null && state !== "open" && state !== "resolved") fail(422, "INCIDENT_INPUT_INVALID", "Choose an incident state.");
      const after = integer(query.has("after") ? Number(query.get("after")) : 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.has("limit") ? Number(query.get("limit")) : 25, 1, 50);
      const rows = sql.prepare("SELECT * FROM clank_platform_incidents WHERE project_id=? AND sequence>? AND (? IS NULL OR state=?) ORDER BY sequence LIMIT ?").all(projectId, after, state, state, limit + 1);
      const incidents = rows.slice(0, limit).map(summary);
      return {incidents, next: rows.length > limit ? incidents.at(-1)!.sequence : null};
    },
    create(projectId: string, authority: IncidentAuthority, value: unknown): ProjectIncident {
      check(authority); const input = object(value); exact(input, ["title", "severity", "ownerId", "operationId"]);
      const title = text(input.title, 160), severity = input.severity, ownerId = owner(input.ownerId), operationId = identifier(input.operationId);
      if (severity !== "warning" && severity !== "critical") fail(422, "INCIDENT_INPUT_INVALID", "Choose an incident severity.");
      const canonical = JSON.stringify({kind: "create", title, severity, ownerId});
      return sql.transaction(() => {
        check(authority); const retained = receipt(projectId, authority, operationId, canonical); if (retained) return retained;
        capacity(); requireOwner(authority, ownerId);
        if (Number(sql.prepare("SELECT count(*) AS n FROM clank_platform_incidents").get()?.n) >= maxIncidents || Number(sql.prepare("SELECT count(*) AS n FROM clank_platform_incidents WHERE project_id=?").get(projectId)?.n) >= 100) fail(409, "INCIDENT_CAPACITY", "Incident workspace capacity is full.");
        const id = randomUUID(), now = Date.now();
        sql.prepare("INSERT INTO clank_platform_incidents(id,project_id,title,severity,state,owner_id,version,created_at,updated_at) VALUES(?,?,?,?,'open',?,1,?,?)").run(id, projectId, title, severity, ownerId, now, now);
        return save(projectId, authority, operationId, canonical, current(projectId, id), "create");
      });
    },
    async change(projectId: string, id: string, authority: IncidentAuthority, value: unknown): Promise<ProjectIncident> {
      check(authority); identifier(id); const input = object(value); exact(input, ["expectedVersion", "operationId", "change"]);
      const expectedVersion = integer(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1), operationId = identifier(input.operationId), raw = object(input.change);
      let change: ProjectIncidentChange;
      switch (raw.kind) {
        case "note": exact(raw, ["kind", "text"]); change = {kind: "note", text: text(raw.text, 2000)}; break;
        case "assign": exact(raw, ["kind", "ownerId"]); change = {kind: "assign", ownerId: owner(raw.ownerId)}; break;
        case "resolve": exact(raw, ["kind", "resolution"]); change = {kind: "resolve", resolution: text(raw.resolution, 2000)}; break;
        case "reopen": exact(raw, ["kind"]); change = {kind: "reopen"}; break;
        case "link": exact(raw, ["kind", "reference"]); change = {kind: "link", reference: reference(raw.reference)}; check(authority, permission(change.reference)); break;
        case "unlink": exact(raw, ["kind", "sequence"]); change = {kind: "unlink", sequence: integer(raw.sequence, 1, Number.MAX_SAFE_INTEGER)}; break;
        default: return fail(422, "INCIDENT_INPUT_INVALID", "Choose a supported incident change.");
      }
      current(projectId, id);
      const canonical = JSON.stringify({id, expectedVersion, change});
      const retained = receipt(projectId, authority, operationId, canonical); if (retained) return retained;
      let context: ReturnType<typeof releaseContext> = null;
      if (change.kind === "link") {
        context = releaseContext(projectId, change.reference);
        if (change.reference.kind === "alert") { if (!hooks.alert(projectId, change.reference.id)) fail(404, "INCIDENT_REFERENCE_NOT_FOUND", "Project alert not found."); }
        else if ("releaseId" in change.reference) {
          const observed = await diagnostic(projectId, change.reference);
          check(authority, permission(change.reference));
          if (!observed.available) fail(404, "INCIDENT_REFERENCE_NOT_FOUND", "Diagnostic reference is not retained.");
        }
      }
      return sql.transaction(() => {
        check(authority, change.kind === "link" ? permission(change.reference) : undefined);
        const replay = receipt(projectId, authority, operationId, canonical); if (replay) return replay;
        const incident = current(projectId, id); if (incident.version !== expectedVersion) fail(409, "INCIDENT_VERSION_STALE", "Refresh the current incident before changing it.");
        capacity(); const now = Date.now();
        switch (change.kind) {
          case "note":
            if (incident.noteCount >= 100) fail(409, "INCIDENT_NOTE_CAPACITY", "Incident note capacity is full.");
            sql.prepare("INSERT INTO clank_platform_incident_notes(incident_id,author_id,created_at,text) VALUES(?,?,?,?)").run(id, authority.userId, now, change.text); break;
          case "assign": requireOwner(authority, change.ownerId); sql.prepare("UPDATE clank_platform_incidents SET owner_id=? WHERE id=?").run(change.ownerId, id); break;
          case "resolve":
            if (incident.state !== "open") fail(409, "INCIDENT_STATE_STALE", "The incident is already resolved.");
            sql.prepare("UPDATE clank_platform_incidents SET state='resolved',resolution=?,resolved_at=? WHERE id=?").run(change.resolution, now, id); break;
          case "reopen":
            if (incident.state !== "resolved") fail(409, "INCIDENT_STATE_STALE", "The incident is already open.");
            sql.prepare("UPDATE clank_platform_incidents SET state='open',resolution=NULL,resolved_at=NULL WHERE id=?").run(id); break;
          case "link": {
            const fresh = releaseContext(projectId, change.reference);
            if (JSON.stringify(fresh) !== JSON.stringify(context) || change.reference.kind === "alert" && !hooks.alert(projectId, change.reference.id)) fail(409, "INCIDENT_REFERENCE_CHANGED", "Refresh the changed diagnostic reference.");
            if (incident.linkCount >= 50) fail(409, "INCIDENT_LINK_CAPACITY", "Incident link capacity is full.");
            const serialized = JSON.stringify(change.reference);
            if (sql.prepare("SELECT 1 FROM clank_platform_incident_links WHERE incident_id=? AND reference=?").get(id, serialized)) fail(409, "INCIDENT_LINK_EXISTS", "The incident already links this diagnostic.");
            sql.prepare("INSERT INTO clank_platform_incident_links(incident_id,reference,release_context) VALUES(?,?,?)").run(id, serialized, context === null ? null : JSON.stringify(context)); break;
          }
          case "unlink": {
            const linked = sql.prepare("SELECT reference FROM clank_platform_incident_links WHERE incident_id=? AND sequence=?").get(id, change.sequence);
            if (!linked) fail(404, "INCIDENT_REFERENCE_NOT_FOUND", "Incident link not found.");
            check(authority, permission(reference(JSON.parse(String(linked!.reference)))));
            sql.prepare("DELETE FROM clank_platform_incident_links WHERE incident_id=? AND sequence=?").run(id, change.sequence); break;
          }
        }
        sql.prepare("UPDATE clank_platform_incidents SET version=version+1,updated_at=? WHERE id=?").run(now, id);
        return save(projectId, authority, operationId, canonical, current(projectId, id), change.kind);
      });
    },
    async read(projectId: string, id: string, authority: IncidentAuthority, query: URLSearchParams): Promise<ProjectIncidentDetail> {
      check(authority); identifier(id);
      if ([...query.keys()].some(key => !["afterNotes", "afterLinks"].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) fail(422, "INCIDENT_INPUT_INVALID", "Choose exact incident cursors.");
      const afterNotes = integer(query.has("afterNotes") ? Number(query.get("afterNotes")) : 0, 0, Number.MAX_SAFE_INTEGER), afterLinks = integer(query.has("afterLinks") ? Number(query.get("afterLinks")) : 0, 0, Number.MAX_SAFE_INTEGER);
      const incident = current(projectId, id);
      const noteRows = sql.prepare("SELECT * FROM clank_platform_incident_notes WHERE incident_id=? AND sequence>? ORDER BY sequence LIMIT 26").all(id, afterNotes);
      const notes = noteRows.slice(0, 25).map(row => ({sequence: Number(row.sequence), authorId: String(row.author_id), createdAt: Number(row.created_at), text: String(row.text)}));
      const linkRows = sql.prepare("SELECT * FROM clank_platform_incident_links WHERE incident_id=? AND sequence>? ORDER BY sequence LIMIT 9").all(id, afterLinks), links: ProjectIncidentLink[] = [];
      const deadline = Date.now() + 4000;
      const readLink = async (row: Record<string, unknown>): Promise<ProjectIncidentLink> => {
        const ref = reference(JSON.parse(String(row.reference))), allowed = authority.mayRead(permission(ref));
        if (!allowed) return {sequence: Number(row.sequence), kind: ref.kind, reference: null, available: false, reason: "permission-required", releaseContext: null, diagnostic: null};
        const stored = row.release_context === null ? null : JSON.parse(String(row.release_context));
        const releaseId = ref.kind === "release" ? ref.id : "releaseId" in ref ? ref.releaseId : null;
        const available = ref.kind === "alert" ? hooks.alert(projectId, ref.id) : releaseId !== null && Boolean(hooks.release(projectId, releaseId)?.available);
        const alert = ref.kind === "alert" ? hooks.alert(projectId, ref.id) : null;
        let projection: ProjectIncidentDiagnostic | null = alert ? {projectId, reference: ref, available: true, ...alert} : null, reason: ProjectIncidentLink["reason"] = available ? "available" : "not-retained";
        if (available && "releaseId" in ref) {
          try { projection = await diagnostic(projectId, ref, deadline - Date.now()); reason = projection.available ? "available" : "not-retained"; }
          catch { reason = "adapter-unavailable"; }
        }
        check(authority); if (!authority.mayRead(permission(ref))) fail(403, "INCIDENT_ACCESS_CHANGED", "Diagnostic access changed. Refresh the workspace.");
        if (ref.kind === "alert" ? !hooks.alert(projectId, ref.id) : releaseId !== null && !hooks.release(projectId, releaseId)?.available) { reason = "not-retained"; projection = null; }
        return {sequence: Number(row.sequence), kind: ref.kind, reference: ref, available: reason === "available", reason, releaseContext: stored, diagnostic: projection};
      };
      // Two reads per group keep the four global adapter credits shared. The
      // request-wide deadline stays below the browser transport timeout.
      for (let index = 0; index < Math.min(linkRows.length, 8); index += 2) {
        links.push(...await Promise.all(linkRows.slice(index, Math.min(index + 2, 8)).map(readLink)));
      }
      check(authority);
      if (current(projectId, id).version !== incident.version) fail(409, "INCIDENT_VERSION_STALE", "The incident changed during the diagnostic read. Refresh it.");
      return {incident, notes, nextNotes: noteRows.length > 25 ? notes.at(-1)!.sequence : null, links, nextLinks: linkRows.length > 8 ? links.at(-1)!.sequence : null};
    },
  };
}
