import type { Action } from "./ai.js";
import type { AppBlueprint, AppPlan } from "./blueprint.js";
export interface StudioReview { readonly protocol: "clank-studio-review/1"; readonly intent: string; readonly plan: AppPlan; readonly approvalDigest: string; readonly questions: readonly string[]; }
export interface VisualImage { readonly width: number; readonly height: number; readonly rgba: Uint8Array; }
export interface VisualRegressionOptions { readonly channelTolerance?: number; readonly maximumChangedRatio?: number; readonly ignoreRegions?: readonly { x: number; y: number; width: number; height: number }[]; }
export interface VisualRegressionReport { readonly protocol: "clank-visual-regression/1"; readonly matches: boolean; readonly changedPixels: number; readonly changedRatio: number; readonly maximumDelta: number; readonly width: number; readonly height: number; readonly reason: string; }
export interface RuntimeContract { readonly nodeMajor: number; readonly database: "sqlite" | "postgres"; readonly isolation: "process" | "container" | "microvm"; readonly region?: string; readonly environmentNames: readonly string[]; readonly migrations: readonly string[]; readonly services?: readonly string[]; }
export interface ParityFinding { readonly severity: "error" | "warning"; readonly field: string; readonly local: unknown; readonly production: unknown; readonly message: string; }
export interface ProductionParityReport { readonly protocol: "clank-production-parity/1"; readonly ok: boolean; readonly findings: readonly ParityFinding[]; }
export type SchemaColumnType = "text" | "integer" | "real" | "blob" | "json" | "boolean";
export interface SchemaColumn { readonly type: SchemaColumnType; readonly nullable?: boolean; readonly default?: string | number | boolean | null; }
export interface SchemaSnapshot { readonly tables: Readonly<Record<string, { readonly columns: Readonly<Record<string, SchemaColumn>>; readonly indexes?: Readonly<Record<string, readonly string[]>>; }>>; }
export interface SchemaChange { readonly safety: "safe" | "review" | "destructive"; readonly kind: "create-table" | "drop-table" | "add-column" | "drop-column" | "alter-column" | "create-index" | "drop-index"; readonly table: string; readonly name?: string; readonly sql: string; readonly message: string; }
export interface SchemaWorkbenchReport { readonly protocol: "clank-schema-workbench/1"; readonly safe: boolean; readonly changes: readonly SchemaChange[]; readonly migrationSql: string; }
export interface ContractTestCase { readonly name: string; readonly input: unknown; readonly expected: "success" | "validation-error"; }
export interface ContractTestReport { readonly protocol: "clank-contract-test/1"; readonly action: string; readonly ok: boolean; readonly cases: readonly { readonly name: string; readonly passed: boolean; readonly message?: string }[]; }
export interface UpgradeManifest { readonly from: string; readonly to: string; readonly minimumNodeMajor: number; readonly removedExports?: readonly string[]; readonly renamedExports?: Readonly<Record<string, string>>; readonly configChanges?: readonly string[]; readonly migrationNotes?: readonly string[]; }
export interface UpgradePlan { readonly protocol: "clank-upgrade-plan/1"; readonly from: string; readonly to: string; readonly ready: boolean; readonly blockers: readonly string[]; readonly edits: readonly { readonly kind: "rename-export" | "config" | "migration"; readonly message: string }[]; }
export interface PlaygroundCall { readonly action: string; readonly input: unknown; readonly principal?: string; readonly scopes?: readonly string[]; }
export interface PlaygroundTranscript { readonly protocol: "clank-agent-playground/1"; readonly action: string; readonly status: "succeeded" | "denied" | "failed"; readonly input: unknown; readonly output?: unknown; readonly error?: string; readonly durationMs: number; }
export interface AgentPlayground { readonly actions: readonly Action["manifest"][]; call(request: PlaygroundCall): Promise<PlaygroundTranscript>; }
export declare function createStudioReview(input: { intent: string; blueprint: AppBlueprint; questions?: readonly string[] }): Promise<StudioReview>;
export declare function compareVisuals(baseline: VisualImage, current: VisualImage, options?: VisualRegressionOptions): VisualRegressionReport;
export declare function checkProductionParity(localInput: RuntimeContract, productionInput: RuntimeContract): ProductionParityReport;
export declare function diffSchemas(currentInput: SchemaSnapshot, targetInput: SchemaSnapshot): SchemaWorkbenchReport;
export declare function testActionContract(action: Action<any, any>, context?: Record<string, unknown>): Promise<ContractTestReport>;
export declare function generateContractCases(schemaInput: Record<string, unknown>): readonly ContractTestCase[];
export declare function planFrameworkUpgrade(manifest: UpgradeManifest, environment: { nodeMajor: number; usedExports?: readonly string[] }): UpgradePlan;
export declare function createAgentPlayground(actionsInput: readonly Action<any, any>[], options?: { authorize?: (call: PlaygroundCall, action: Action<any, any>) => boolean | Promise<boolean>; redactKeys?: readonly string[]; now?: () => number; }): AgentPlayground;
