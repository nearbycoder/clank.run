import type { AuthClient } from "./auth.js";
import type { McpTool } from "./mcp.js";
export type ProjectCostMeter = "storageByteMilliseconds" | "transferBytes" | "runtimeMilliseconds";
export interface ProjectCostRate {
    /** Smallest currency units per declared quantity, both nonnegative integers. */
    readonly amountMinor: number;
    readonly perUnits: number;
}
export interface ProjectCostRateCard {
    readonly id: string;
    readonly revision: number;
    readonly currency: string;
    /** UTC month boundary. Previously accepted periods retain their card. */
    readonly effectiveFrom: number;
    readonly rates: Readonly<Record<ProjectCostMeter, ProjectCostRate>>;
}
export interface ProjectCostMeasurement {
    /** Opaque trusted collector identity; never a path or a credential. */
    readonly source: string;
    readonly sourceRevision: string;
    readonly periodStartedAt: number;
    readonly observedUntil: number;
    readonly meters: Readonly<Record<ProjectCostMeter, {
        /** Exact cumulative integer quantity; null means unavailable. */
        readonly units: string | null;
        /** The collector attests coverage from periodStartedAt through observedUntil. */
        readonly complete: boolean;
    }>>;
}
export interface ProjectCostComponent {
    readonly meter: ProjectCostMeter;
    readonly units: string | null;
    readonly complete: boolean;
    /** Exact numerator before division by the rate's perUnits. */
    readonly numerator: string | null;
    readonly denominator: number;
    /** Rounded upward once per cumulative component, in smallest currency units. */
    readonly amountMinor: string | null;
}
export interface ProjectCostSnapshot {
    readonly protocol: "clank-project-costs/1";
    readonly projectId: string;
    readonly month: string;
    readonly version: number;
    readonly observedUntil: number;
    readonly reconciledAt: number;
    readonly source: string;
    readonly sourceRevision: string;
    readonly rateCard: ProjectCostRateCard;
    readonly components: readonly ProjectCostComponent[];
    readonly knownAmountMinor: string;
    /** Null if any meter lacks complete coverage. This is an estimate, never an invoice. */
    readonly amountMinor: string | null;
    readonly reason: string;
}
export interface ProjectCostPolicy {
    readonly version: number;
    readonly currency: string;
    readonly limitMinor: string;
    readonly warningPercent: number;
    readonly admission: "observe" | "deny-at-observed-limit";
    readonly maxMeasurementAgeMs: number;
    readonly updatedAt: number;
    readonly reason: string;
}
export interface ProjectCostOverride {
    readonly version: number;
    readonly policyVersion: number;
    readonly expiresAt: number;
    readonly createdAt: number;
    readonly reason: string;
    readonly active: boolean;
}
export interface ProjectCostReport {
    readonly protocol: "clank-project-costs/1";
    readonly projectId: string;
    readonly month: string;
    readonly snapshot: ProjectCostSnapshot | null;
    readonly policy: ProjectCostPolicy | null;
    readonly override: ProjectCostOverride | null;
    readonly status: "unconfigured" | "unknown" | "stale" | "within-budget" | "warning" | "exhausted";
    readonly admission: "allowed" | "blocked" | "overridden";
    readonly asOf: number;
}
export interface ProjectCostReconcileInput {
    readonly month: string;
    readonly expectedVersion: number;
    readonly operationId: string;
    readonly reason: string;
}
export interface ProjectCostPolicyInput {
    readonly expectedVersion: number;
    readonly operationId: string;
    readonly currency: string;
    readonly limitMinor: string;
    readonly warningPercent: number;
    readonly admission: "observe" | "deny-at-observed-limit";
    readonly maxMeasurementAgeMs: number;
    readonly reason: string;
}
export interface ProjectCostOverrideInput {
    readonly expectedVersion: number;
    readonly policyVersion: number;
    readonly operationId: string;
    /** Zero revokes the current override. Otherwise a future expiry within one hour. */
    readonly expiresAt: number;
    readonly reason: string;
}
export interface ProjectCostClient {
    read(projectId: string, month?: string): Promise<ProjectCostReport>;
    history(projectId: string, month: string): Promise<readonly ProjectCostSnapshot[]>;
    reconcile(projectId: string, input: ProjectCostReconcileInput): Promise<ProjectCostSnapshot>;
    policy(projectId: string, input: ProjectCostPolicyInput): Promise<ProjectCostPolicy>;
    override(projectId: string, input: ProjectCostOverrideInput): Promise<ProjectCostOverride>;
}
export interface ProjectCostClientOptions {
    readonly url?: string;
    readonly auth?: Pick<AuthClient, "csrfHeader">;
    readonly headers?: () => HeadersInit;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}
export interface ProjectCostViewOptions {
    readonly client: ProjectCostClient;
    readonly projectId: string;
    /** Current local account identity; a change clears the view before accepting any result. */
    readonly getAccountId: () => string | null;
    /** Presentation only. The server independently requires current fresh human administration. */
    readonly canManage?: () => boolean;
    readonly month?: string;
}
export interface ProjectCostView {
    readonly disposed: boolean;
    refresh(): Promise<void>;
    hasPendingChanges(): boolean;
    /** Remove local drafts and private metadata. Already dispatched operations may have committed. */
    dispose(): void;
}
/** Read-only tools. Resolve a native authenticated client for this caller on every invocation. */
export declare function createProjectCostMcpTools<Context>(resolveClient: (context: Context, request: Request) => ProjectCostClient): readonly McpTool<Context>[];
/** Exact operation IDs are retained across ambiguous transport failures. */
export declare function createProjectCostClient(options?: ProjectCostClientOptions): ProjectCostClient;
/** Native controls with version-pinned drafts and unchanged-operation retries. */
export declare function createProjectCostView(root: HTMLElement, options: ProjectCostViewOptions): ProjectCostView;
