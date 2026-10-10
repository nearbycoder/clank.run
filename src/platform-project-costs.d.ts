import type { SQLiteInternal } from "./sqlite-internal.js";
import type { ProjectCostRateCard, ProjectCostMeasurement, ProjectCostSnapshot, ProjectCostPolicy, ProjectCostOverride, ProjectCostReport } from "./project-costs.js";
export interface PlatformProjectCostOptions {
    readonly rateCards: readonly ProjectCostRateCard[];
    /** Read-only trusted host collector. Browser input never supplies measurements. */
    readonly measure: (input: {
        readonly projectId: string;
        readonly periodStartedAt: number;
        readonly periodEndsAt: number;
        readonly asOf: number;
        readonly signal: AbortSignal;
    }) => Promise<ProjectCostMeasurement>;
    readonly timeoutMs?: number;
    readonly maxObservations?: number;
    readonly maxReceipts?: number;
    readonly maxPolicies?: number;
}
export interface ProjectCostAuthority {
    readonly actorId: string;
    /** Synchronous current project scope; admin also requires a fresh human session. */
    authorize(admin: boolean): void;
    audit(action: string, metadata: Record<string, unknown>): void;
}
export declare class ProjectCostError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** Retained admission policies remain active even when the collector is disabled. */
export declare function openPlatformProjectCosts(sql: SQLiteInternal, options?: PlatformProjectCostOptions, clock?: () => number): {
    read(projectId: string, authority: ProjectCostAuthority, key?: string): ProjectCostReport;
    history(projectId: string, authority: ProjectCostAuthority, key: string): ProjectCostSnapshot[];
    reconcile(projectId: string, authority: ProjectCostAuthority, value: unknown): Promise<ProjectCostSnapshot>;
    changePolicy(projectId: string, authority: ProjectCostAuthority, value: unknown): ProjectCostPolicy;
    changeOverride(projectId: string, authority: ProjectCostAuthority, value: unknown): ProjectCostOverride;
    admission(projectId: string): {
        allowed: boolean;
        code?: string;
        message?: string;
        retryAfterSeconds?: number;
    };
    signals(): {
        key: string;
        kind: "cost_budget";
        resourceId: string;
        severity: "critical" | "warning";
        active: boolean;
        message: string;
    }[];
    close(): void;
} | undefined;
