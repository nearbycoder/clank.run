export type RevisionEventKind = "query" | "mutation" | "ui" | "migration" | "deploy" | "flag" | "policy" | "agent";
export interface RevisionPatch { readonly op: "set" | "delete"; readonly path: string; readonly value?: unknown; }
export interface RevisionEventInput { readonly id: string; readonly revision: number; readonly at: string; readonly kind: RevisionEventKind; readonly actor: string; readonly summary: string; readonly correlationId?: string; readonly parentId?: string; readonly patches?: readonly RevisionPatch[]; readonly metadata?: unknown; }
export interface RevisionEvent extends RevisionEventInput { readonly patches: readonly RevisionPatch[]; }
export interface RevisionLedger { readonly protocol: "clank-revision-ledger/1"; readonly initialState: unknown; readonly events: readonly RevisionEvent[]; }
export interface RevisionInspection { readonly protocol: "clank-revision-inspection/1"; readonly revision: number; readonly state: unknown; readonly event: RevisionEvent | null; readonly trace: readonly RevisionEvent[]; }
export interface ReleaseMaterial { readonly releaseId: string; readonly artifactSha256: string; readonly sourceRevision: string; readonly migrationIds: readonly string[]; readonly configurationSha256: string; readonly frameworkVersion: string; readonly builder: string; readonly builtAt: string; }
export interface ReleaseProvenance extends ReleaseMaterial { readonly protocol: "clank-provenance/1"; readonly digest: string; }
export interface PromotionStageInput { readonly name: string; readonly trafficPercent: number; readonly requiredChecks?: readonly string[]; readonly requiresApproval?: boolean; }
export interface PromotionPlan { readonly protocol: "clank-promotion/1"; readonly release: ReleaseProvenance; readonly stages: readonly { readonly name: string; readonly trafficPercent: number; readonly requiredChecks: readonly string[]; readonly requiresApproval: boolean; }[]; }
export interface PromotionEvidence { readonly stage: string; readonly checks: Readonly<Record<string, boolean>>; readonly approved?: boolean; }
export interface PromotionDecision { readonly ready: boolean; readonly stage: string | null; readonly blockers: readonly string[]; }
export interface RolloutMetrics { readonly samples: number; readonly errorRate: number; readonly p95Ms: number; readonly saturation?: number; }
export interface RolloutGuardrails { readonly minimumSamples?: number; readonly maximumErrorRate: number; readonly maximumP95Ms: number; readonly maximumSaturation?: number; }
export interface RolloutDecision { readonly action: "continue" | "pause" | "rollback"; readonly reasons: readonly string[]; }
export interface PortableProjectFileInput { readonly path: string; readonly bytes: Uint8Array; readonly mode?: 0o600 | 0o644 | 0o700 | 0o755; }
export interface PortableProjectFile { readonly path: string; readonly size: number; readonly sha256: string; readonly mode: 0o600 | 0o644 | 0o700 | 0o755; readonly content: string; }
export interface PortableProjectExport { readonly protocol: "clank-project-export/1"; readonly project: { readonly name: string; readonly frameworkVersion: string; readonly exportedAt: string; }; readonly files: readonly PortableProjectFile[]; readonly digest: string; }
export type CloneTransform = "keep" | "hash" | "redact" | "email" | "drop";
export interface ClonePolicy { readonly default: CloneTransform; readonly fields?: Readonly<Record<string, CloneTransform>>; }
export interface SanitizedClone<T extends Record<string, unknown>> { readonly protocol: "clank-sanitized-clone/1"; readonly rows: readonly T[]; readonly redactedFields: readonly string[]; }
export interface CapacityWorkload { readonly requestsPerMonth: number; readonly transferBytesPerMonth: number; readonly databaseBytes: number; readonly artifactBytes: number; readonly peakRealtimeConnections?: number; readonly jobCpuMsPerMonth?: number; readonly minimumReplicas?: number; }
export interface CapacityRateCard { readonly requestMillion: number; readonly transferGb: number; readonly storageGb: number; readonly processUnit: number; }
export interface CapacityEstimate { readonly protocol: "clank-capacity-estimate/1"; readonly processUnits: number; readonly storageBytes: number; readonly requestMillions: number; readonly transferGb: number; readonly monthlyCost: number; readonly assumptions: readonly string[]; }
export declare function createRevisionLedger(initialState: unknown, eventsInput: readonly RevisionEventInput[]): RevisionLedger;
export declare function inspectRevision(ledgerInput: RevisionLedger, revision?: number): RevisionInspection;
export declare function createReleaseProvenance(input: ReleaseMaterial): Promise<ReleaseProvenance>;
export declare function verifyReleaseProvenance(input: ReleaseProvenance): Promise<boolean>;
export declare function createPromotionPlan(release: ReleaseProvenance, stagesInput: readonly PromotionStageInput[]): PromotionPlan;
export declare function nextPromotion(plan: PromotionPlan, evidenceInput: readonly PromotionEvidence[]): PromotionDecision;
export declare function assessRollout(metrics: RolloutMetrics, guardrails: RolloutGuardrails): RolloutDecision;
export declare function createPortableProjectExport(input: { name: string; frameworkVersion: string; files: readonly PortableProjectFileInput[]; exportedAt?: string | number | Date; maxBytes?: number; }): Promise<PortableProjectExport>;
export declare function verifyPortableProjectExport(bundle: PortableProjectExport, maxBytes?: number): Promise<boolean>;
export declare function createSanitizedClone<T extends Record<string, unknown>>(rowsInput: readonly T[], policyInput: ClonePolicy, saltInput: string | Uint8Array): Promise<SanitizedClone<T>>;
export declare function estimateCapacity(workload: CapacityWorkload, rateCard: CapacityRateCard): CapacityEstimate;
