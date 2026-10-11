export interface ManagedCanaryStage {
    trafficPercent: number;
    durationMs: number;
    minimumSamples: number;
}
export interface ManagedCanaryOptions {
    stages: readonly ManagedCanaryStage[];
    maximumErrorRate: number;
    maximumP95Ms: number;
    /** Requires native supervisor leadership and an isolated provider read-only candidate. */
    provider?: { readonly databasePolicy: "isolated-read-only"; readonly readPaths: readonly string[] };
}
export interface ManagedCanaryReport {
    projectId: string;
    releaseId: string;
    state: "running" | "passed" | "failed" | "interrupted";
    stage: number;
    trafficPercent: number;
    samples: number;
    errorRate: number;
    p95Ms: number;
    reason: string | null;
    updatedAt: number;
}
