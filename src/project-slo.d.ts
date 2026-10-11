import type {AuthClient} from "./auth.js";
export type ProjectSloWindowMinutes = 5 | 60 | 1440 | 10080;
export type ProjectSloLatencyMs = 50 | 100 | 250 | 500 | 1000 | 2500 | 5000;
export type ProjectSloObjective = { readonly kind: "request-success" } | { readonly kind: "latency"; readonly maximumMs: ProjectSloLatencyMs };
export interface ProjectSloConfiguration {
  readonly name: string;
  readonly objective: ProjectSloObjective;
  readonly targetBasisPoints: number;
  readonly windowMinutes: ProjectSloWindowMinutes;
  readonly minimumRequests: number;
  readonly burnThreshold: number;
  readonly enabled: boolean;
}
/** Counts of native ingress terminal outcomes, grouped by completion minute. */
export interface ProjectSloBucket {
  readonly startedAt: number;
  readonly complete: boolean;
  readonly requests: number;
  readonly successful: number;
  readonly completed: number;
  readonly latency: readonly [number, number, number, number, number, number, number];
}
export interface ProjectSloEvaluation {
  readonly status: "insufficient-data" | "within-budget" | "budget-exhausted";
  readonly reason: "missing-measurements" | "not-enough-requests" | null;
  readonly from: number;
  readonly until: number;
  readonly coverage: { readonly complete: boolean; readonly expectedMinutes: number; readonly coveredMinutes: number; readonly missingMinutes: number };
  readonly requests: number;
  readonly good: number;
  readonly bad: number;
  readonly observedGoodFraction: number | null;
  readonly allowedBadRequests: number | null;
  readonly remainingBudgetRequests: number | null;
  readonly burnRate: number | null;
  readonly burning: boolean | null;
}
export interface ProjectSloPolicy extends ProjectSloConfiguration { readonly id: string; readonly projectId: string; readonly version: number; readonly createdAt: number; readonly updatedAt: number; }
export interface ProjectSloAlert { readonly id: string; readonly policyId: string; readonly projectId: string; readonly policyVersion: number; readonly state: "open" | "resolved" | "unknown" | "disabled"; readonly version: number; readonly observedAt: number; }
export interface ProjectSloAssessment { readonly policy: ProjectSloPolicy; readonly evaluation: ProjectSloEvaluation; readonly alert: ProjectSloAlert | null; }
export interface CreateProjectSloRequest { readonly configuration: ProjectSloConfiguration; readonly operationId: string; }
export interface ChangeProjectSloRequest extends CreateProjectSloRequest { readonly expectedVersion: number; }
export interface ProjectSloClient {
  list(projectId: string): Promise<readonly ProjectSloAssessment[]>;
  read(projectId: string, policyId: string): Promise<ProjectSloAssessment>;
  create(projectId: string, input: CreateProjectSloRequest): Promise<ProjectSloPolicy>;
  change(projectId: string, policyId: string, input: ChangeProjectSloRequest): Promise<ProjectSloPolicy>;
}
export interface ProjectSloClientOptions {
  url?: string; fetch?: typeof fetch; auth?: Pick<AuthClient<any>,"csrfHeader">; headers?:()=>HeadersInit; timeoutMs?:number;
}
export declare function validateProjectSloConfiguration(value: unknown): ProjectSloConfiguration;
export declare function evaluateProjectSlo(configuration: ProjectSloConfiguration, buckets: readonly ProjectSloBucket[], until: number): ProjectSloEvaluation;
export declare function createProjectSloClient(options?: ProjectSloClientOptions): ProjectSloClient;
