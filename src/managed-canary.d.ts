export interface ManagedCanaryStage {
    trafficPercent: number;
    durationMs: number;
    minimumSamples: number;
}
export interface ManagedCanaryOptions {
    stages: readonly ManagedCanaryStage[];
    maximumErrorRate: number;
    maximumP95Ms: number;
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
