import type { AuthClient } from "./auth.ts";

export type ProjectIncidentSeverity = "warning" | "critical";
export type ProjectIncidentState = "open" | "resolved";
export type ProjectIncidentReference =
  | { readonly kind: "release"; readonly id: string }
  | { readonly kind: "error"; readonly id: string; readonly releaseId: string }
  | { readonly kind: "trace"; readonly id: string; readonly releaseId: string }
  | { readonly kind: "job" | "workflow"; readonly id: string; readonly releaseId: string }
  | { readonly kind: "alert"; readonly id: string };
export type ProjectIncidentDiagnosticState = "unknown" | "open" | "resolved" | "regressed" | "waiting" | "queued" | "running" | "retry" | "succeeded" | "failed" | "dead" | "cancelled" | "not-needed";
/** Readonly adapters return operational metadata, never raw traces or application payloads. */
export interface ProjectIncidentDiagnostic {
  readonly projectId: string;
  readonly reference: ProjectIncidentReference;
  readonly available: boolean;
  readonly observedAt: number;
  readonly state?: ProjectIncidentDiagnosticState;
  readonly count?: number;
}
export interface ProjectIncidentDiagnostics {
  resolve(projectId: string, reference: Extract<ProjectIncidentReference, { releaseId: string }>, signal: AbortSignal): Promise<ProjectIncidentDiagnostic>;
}
export interface ProjectIncident {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly title: string;
  readonly severity: ProjectIncidentSeverity;
  readonly state: ProjectIncidentState;
  readonly ownerId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt: number | null;
  readonly resolution: string | null;
  readonly noteCount: number;
  readonly linkCount: number;
}
export interface ProjectIncidentNote {
  readonly sequence: number;
  readonly authorId: string;
  readonly createdAt: number;
  readonly text: string;
}
export interface ProjectIncidentLink {
  readonly sequence: number;
  readonly kind: ProjectIncidentReference["kind"];
  readonly reference: ProjectIncidentReference | null;
  readonly available: boolean;
  readonly reason: "available" | "permission-required" | "not-retained" | "adapter-unavailable";
  readonly releaseContext: null | { readonly id: string; readonly digest: string; readonly createdAt: number };
  readonly diagnostic: ProjectIncidentDiagnostic | null;
}
export interface ProjectIncidentDetail {
  readonly incident: ProjectIncident;
  readonly notes: readonly ProjectIncidentNote[];
  readonly nextNotes: number | null;
  readonly links: readonly ProjectIncidentLink[];
  readonly nextLinks: number | null;
}
export interface ProjectIncidentPage { readonly incidents: readonly ProjectIncident[]; readonly next: number | null; }
export interface ProjectIncidentOwner { readonly userId: string; readonly label: string; }
export interface CreateProjectIncidentRequest {
  readonly title: string;
  readonly severity: ProjectIncidentSeverity;
  readonly ownerId: string | null;
  readonly operationId: string;
}
export type ProjectIncidentChange =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "assign"; readonly ownerId: string | null }
  | { readonly kind: "resolve"; readonly resolution: string }
  | { readonly kind: "reopen" }
  | { readonly kind: "link"; readonly reference: ProjectIncidentReference }
  | { readonly kind: "unlink"; readonly sequence: number };
export interface ChangeProjectIncidentRequest {
  readonly expectedVersion: number;
  readonly operationId: string;
  readonly change: ProjectIncidentChange;
}
export interface ProjectIncidentClient {
  list(projectId: string, options?: { state?: ProjectIncidentState; after?: number; limit?: number }): Promise<ProjectIncidentPage>;
  owners(projectId: string): Promise<readonly ProjectIncidentOwner[]>;
  read(projectId: string, incidentId: string, cursors?: {afterNotes?: number; afterLinks?: number}): Promise<ProjectIncidentDetail>;
  create(projectId: string, input: CreateProjectIncidentRequest): Promise<ProjectIncident>;
  change(projectId: string, incidentId: string, input: ChangeProjectIncidentRequest): Promise<ProjectIncident>;
}
export interface ProjectIncidentClientOptions {
  url?: string;
  fetch?: typeof fetch;
  auth?: Pick<AuthClient<any>, "csrfHeader">;
  /** Resolve the current scoped CLI credential for each request; do not persist it in an incident. */
  headers?: () => HeadersInit;
  timeoutMs?: number;
}

/** Bounded platform REST transport; retries remain the caller's exact operation ID. */
export function createProjectIncidentClient(options: ProjectIncidentClientOptions = {}): ProjectIncidentClient {
  const base = (options.url ?? "").replace(/\/$/u, "");
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 30000) throw new TypeError("Incident timeout must be 500–30000ms.");
  const identifier = (value: string) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new TypeError("Invalid project or incident identifier.");
    return encodeURIComponent(value);
  };
  const acknowledgment = (payload: any, projectId: string, incidentId: string | null, sent: any): ProjectIncident => {
    const invalid = () => { throw new Error("Incident acknowledgment is unavailable. Keep the exact operation for an explicit retry."); };
    const plain = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
    const fields = ["id", "projectId", "sequence", "title", "severity", "state", "ownerId", "version", "createdAt", "updatedAt", "resolvedAt", "resolution", "noteCount", "linkCount"];
    const id = (value: any) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
    const integer = (value: any, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    const text = (value: any, maximum: number) => typeof value === "string" && Boolean(value.trim()) && new TextEncoder().encode(value).byteLength <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
    if (!plain(payload) || Object.keys(payload).length !== 2 || payload.ok !== true || !Object.hasOwn(payload, "incident")) invalid();
    const value = payload.incident;
    if (!plain(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || !id(value.id) || value.projectId !== projectId || !integer(value.sequence, 1) || !text(value.title, 160) || !["warning", "critical"].includes(value.severity) || !["open", "resolved"].includes(value.state) || value.ownerId !== null && !id(value.ownerId) || !integer(value.version, 1) || !integer(value.createdAt) || !integer(value.updatedAt) || !integer(value.noteCount, 0, 100) || !integer(value.linkCount, 0, 50)) invalid();
    if (value.state === "open" ? value.resolvedAt !== null || value.resolution !== null : !integer(value.resolvedAt) || !text(value.resolution, 2000)) invalid();
    if (incidentId === null) {
      if (value.version !== 1 || value.state !== "open" || value.title !== sent.title || value.severity !== sent.severity || value.ownerId !== sent.ownerId || value.noteCount !== 0 || value.linkCount !== 0) invalid();
    } else {
      if (value.id !== incidentId || value.version !== sent.expectedVersion + 1) invalid();
      const change = sent.change;
      if (change.kind === "assign" && value.ownerId !== change.ownerId || change.kind === "resolve" && (value.state !== "resolved" || value.resolution !== change.resolution) || change.kind === "reopen" && value.state !== "open") invalid();
    }
    return value;
  };
  const request = async (projectId: string, suffix: string, method = "GET", body?: unknown) => {
    const headers = new Headers(options.headers?.());
    for (const [name, value] of Object.entries(options.auth?.csrfHeader() ?? {})) headers.set(name, value);
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > 16384) throw new Error("Incident request exceeds its bounded envelope.");
    if (text !== undefined) headers.set("content-type", "application/json");
    const maximum = 1024 * 1024, chunks: Uint8Array[] = [];
    let bytes = 0;
    const controller = new AbortController(), signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>, response: Response, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      const error = new Error("Incident transport timed out. Inspect current state before retrying the same operation.");
      controller.abort(error); reject(error);
    }, timeout); });
    try {
      const fetching = Promise.resolve().then(() => (options.fetch ?? fetch)(`${base}/api/projects/${identifier(projectId)}/incidents${suffix}`, {
        method, headers, signal, credentials: "same-origin", redirect: "error", ...(text === undefined ? {} : {body: text}),
      })).then(value => {
        if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw signal.reason; }
        return value;
      });
      response = await Promise.race([fetching, expiration]);
      if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("Incident transport refused a redirected response."); }
      reader = response.body?.getReader();
      while (reader) {
        const value = await Promise.race([reader.read(), expiration]);
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > maximum) { void reader.cancel().catch(() => {}); throw new Error("Incident response exceeds its bounded envelope."); }
        chunks.push(value.value);
      }
    } finally { clearTimeout(timer!); if (signal.aborted) void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error("Incident transport returned invalid JSON."); }
    if (!response.ok || payload?.ok !== true) {
      const error = new Error("Incident access changed or the operation was rejected. Refresh before retrying.") as Error & {status: number};
      error.status = response.status;
      throw error;
    }
    return method === "POST" ? acknowledgment(payload, projectId, suffix === "" ? null : decodeURIComponent(suffix.split("/")[1]), JSON.parse(text!)) : payload;
  };
  return {
    list: async (projectId, settings = {}) => {
      const query = new URLSearchParams();
      if (settings.state !== undefined) query.set("state", settings.state);
      if (settings.after !== undefined) query.set("after", String(settings.after));
      if (settings.limit !== undefined) query.set("limit", String(settings.limit));
      const result = await request(projectId, query.size ? `?${query}` : "");
      return {incidents: result.incidents, next: result.next};
    },
    owners: async projectId => (await request(projectId, "/owners")).owners,
    read: async (projectId, incidentId, cursors = {}) => {
      const query = new URLSearchParams();
      if (cursors.afterNotes !== undefined) query.set("afterNotes", String(cursors.afterNotes));
      if (cursors.afterLinks !== undefined) query.set("afterLinks", String(cursors.afterLinks));
      return (await request(projectId, `/${identifier(incidentId)}${query.size ? `?${query}` : ""}`)).detail;
    },
    create: async (projectId, input) => await request(projectId, "", "POST", input),
    change: async (projectId, incidentId, input) => await request(projectId, `/${identifier(incidentId)}/change`, "POST", input),
  };
}
