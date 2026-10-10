import type { AuthClient } from "./auth.js";

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

export declare function createProjectIncidentClient(options?: ProjectIncidentClientOptions): ProjectIncidentClient;
