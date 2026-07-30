import type { DeploymentBundle } from "./deploy.js";
import type { ClaimedDeploymentOperation, DeploymentNodeInput } from "./orchestration.js";
import type {
    DeploymentAgentOptions,
    DeploymentAgentRuntime,
    DeploymentExecutionContext,
} from "./runner.js";
export declare const DEPLOYMENT_PROVIDER_RECONCILE_PATH = "/v1/clank/reconcile";
export interface DeploymentProviderOperation {
    readonly id: string;
    readonly projectId: string;
    readonly fence: number;
    readonly attempt: number;
    readonly maxAttempts: number;
}
export interface DeploymentProviderDesiredState {
    readonly generation: number;
    readonly releaseId: string | null;
    readonly state: "running" | "stopped";
}
export interface DeploymentProviderArtifact {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly bundle: DeploymentBundle;
}
export interface DeploymentProviderRequest {
    /** Lease credentials and node credentials are deliberately excluded. */
    readonly operation: DeploymentProviderOperation;
    readonly desired: DeploymentProviderDesiredState;
    /** Present only while reconciling a running release. */
    readonly artifact: DeploymentProviderArtifact | null;
    readonly signal: AbortSignal;
}
/**
 * The portable infrastructure boundary. A provider must converge the project
 * to the requested generation and make repeated operation/fence pairs safe.
 */
export interface DeploymentProvider {
    /** Stable, non-secret adapter name used in bounded operation results. */
    readonly kind: string;
    reconcile(request: DeploymentProviderRequest): Promise<void>;
}
export interface ProviderDeploymentAgentOptions extends Omit<DeploymentAgentOptions, "execute" | "node"> {
    node: DeploymentNodeInput;
    provider: DeploymentProvider;
}
export interface HttpDeploymentProviderOptions {
    /** Provider service origin. HTTPS is required outside loopback. */
    baseUrl: string;
    /** Separate high-entropy bearer token for the provider service. */
    token: string;
    fetch?: typeof fetch;
    /** Per-attempt deadline. Defaults to 60 seconds. */
    timeoutMs?: number;
    /** Retries exact idempotent reconciliation after network/429/5xx failures. Defaults to 2. */
    retries?: number;
    /** Maximum response bytes discarded on failure. Defaults to 16 KiB. */
    maxResponseBytes?: number;
}
export interface DeploymentProviderHandlerOptions {
    /** Separate high-entropy bearer token accepted only by this provider bridge. */
    token: string;
    /** Maximum compressed deployment artifact. Defaults to 100 MiB. */
    maxArtifactBytes?: number;
    /** Receives private adapter failures. */
    onError?: (error: unknown) => void;
}
export interface DeploymentProviderHandler {
    readonly path: typeof DEPLOYMENT_PROVIDER_RECONCILE_PATH;
    handle(request: Request): Promise<Response>;
}
export declare class DeploymentProviderError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/**
 * Runs the standard node lifecycle and gives the selected provider only a
 * verified, credential-free desired-state request.
 */
export declare function openProviderDeploymentAgent(options: ProviderDeploymentAgentOptions): Promise<DeploymentAgentRuntime>;
/**
 * Validates one canonical reconcile operation. This is exported so custom
 * agent loops can use the same contract without reimplementing its checks.
 */
export declare function reconcileDeploymentProvider(provider: DeploymentProvider, operation: ClaimedDeploymentOperation, context: DeploymentExecutionContext): Promise<{
    provider: string;
    generation: number;
    releaseId: string | null;
    state: "running" | "stopped";
}>;
/**
 * Adapts the portable provider contract to a bounded, redirect-safe HTTP
 * service. Request bodies remain the original compressed deployment artifact.
 */
export declare function createHttpDeploymentProvider(options: HttpDeploymentProviderOptions): DeploymentProvider;
/**
 * Exposes a local provider implementation through the same exact wire
 * contract used by createHttpDeploymentProvider().
 */
export declare function createDeploymentProviderHandler(provider: DeploymentProvider, options: DeploymentProviderHandlerOptions): DeploymentProviderHandler;
