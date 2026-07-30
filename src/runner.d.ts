import type {
    ClaimedDeploymentOperation,
    DeploymentNode,
    DeploymentNodeInput,
    DeploymentOperation,
    DeploymentOperationLease,
    DeploymentOrchestrator,
    NodeSession,
} from "./orchestration.js";
export declare const DEPLOYMENT_COORDINATOR_PREFIX = "/api/runner/v1";
export interface DeploymentRegistrationAuthorization {
    /**
     * Finalizes a reserved one-time enrollment after the node credential has
     * been created. A failure prevents the credential from reaching the node.
     */
    commit(): Promise<void>;
    /** Releases a reservation when node validation or registration fails. */
    rollback(): Promise<void>;
}
export interface DeploymentRegistrationRequest {
    readonly token: string;
    readonly node: Readonly<DeploymentNodeInput>;
    readonly signal: AbortSignal;
}
export interface DeploymentCoordinatorHandlerOptions {
    /** Optional static high-entropy secret used only to enroll or rotate deployment nodes. */
    registrationToken?: string;
    /**
     * Optional transactional authorization for expiring or one-time enrollment
     * credentials. Return null to deny the request.
     */
    authorizeRegistration?: (request: DeploymentRegistrationRequest) => Promise<DeploymentRegistrationAuthorization | null>;
    /** Maximum JSON request body. Defaults to 128 KiB. */
    maxRequestBytes?: number;
    /** Optional content-addressed release source, scoped to a current operation lease. */
    artifact?: DeploymentArtifactProvider;
    /** Maximum artifact returned by the provider. Defaults to 100 MiB. */
    maxArtifactBytes?: number;
    /** Optional sensitive runtime capsule source, scoped to a current operation lease. */
    runtime?: DeploymentRuntimeProvider;
    /** Maximum runtime capsule returned by the provider. Defaults to 768 MiB. */
    maxRuntimeBytes?: number;
    /** Receives private unexpected failures. */
    onError?: (error: unknown) => void;
}
export interface DeploymentCoordinatorHandler {
    readonly prefix: typeof DEPLOYMENT_COORDINATOR_PREFIX;
    handle(request: Request): Promise<Response>;
}
export interface DeploymentCoordinatorClientOptions {
    /** HTTPS control-plane origin. Loopback HTTP is accepted for development. */
    baseUrl: string;
    fetch?: typeof fetch;
    /** Per-request deadline. Defaults to 10 seconds. */
    timeoutMs?: number;
    /** Maximum JSON response body. Defaults to 1 MiB. */
    maxResponseBytes?: number;
    /** Maximum deployment artifact body. Defaults to 100 MiB. */
    maxArtifactBytes?: number;
    /** Artifact-transfer deadline. Defaults to 60 seconds. */
    artifactTimeoutMs?: number;
    /** Maximum runtime capsule body. Defaults to 768 MiB. */
    maxRuntimeBytes?: number;
    /** Runtime-capsule transfer deadline. Defaults to 120 seconds. */
    runtimeTimeoutMs?: number;
}
export interface DeploymentArtifact {
    readonly bytes: Uint8Array;
    readonly sha256: string;
}
export interface DeploymentArtifactRequest {
    readonly operation: DeploymentOperationLease;
    readonly signal: AbortSignal;
}
export interface DeploymentArtifactProvider {
    load(request: DeploymentArtifactRequest): Promise<DeploymentArtifact | null>;
}
export interface DeploymentRuntimeArtifact {
    readonly bytes: Uint8Array;
    readonly sha256: string;
}
export interface DeploymentRuntimeRequest {
    readonly operation: DeploymentOperationLease;
    readonly signal: AbortSignal;
}
export interface DeploymentRuntimeProvider {
    load(request: DeploymentRuntimeRequest): Promise<DeploymentRuntimeArtifact | null>;
}
export interface DeploymentCoordinatorClient {
    register(registrationToken: string, input: DeploymentNodeInput): Promise<NodeSession>;
    authenticate(nodeId: string, token: string): Promise<DeploymentNode>;
    heartbeat(nodeId: string, token: string, input?: {
        capacity?: number;
        labels?: Record<string, string>;
    }): Promise<DeploymentNode>;
    drain(nodeId: string, token: string, draining?: boolean): Promise<DeploymentNode>;
    claim(nodeId: string, token: string, limit?: number): Promise<ClaimedDeploymentOperation[]>;
    artifact(nodeId: string, token: string, operation: ClaimedDeploymentOperation): Promise<DeploymentArtifact>;
    runtime?(nodeId: string, token: string, operation: ClaimedDeploymentOperation): Promise<DeploymentRuntimeArtifact>;
    renew(nodeId: string, token: string, operation: ClaimedDeploymentOperation): Promise<ClaimedDeploymentOperation | null>;
    complete(nodeId: string, token: string, operation: ClaimedDeploymentOperation, result?: unknown): Promise<boolean>;
    fail(nodeId: string, token: string, operation: ClaimedDeploymentOperation, error: unknown): Promise<DeploymentOperation>;
    observe(nodeId: string, token: string, input: {
        projectId: string;
        generation: number;
        releaseId: string | null;
        state: "running" | "stopped" | "failed";
    }): Promise<boolean>;
}
export interface DeploymentNodeCredentialStore {
    load(nodeId: string): Promise<string | null>;
    save(nodeId: string, token: string): Promise<void>;
    clear(nodeId: string): Promise<void>;
}
export interface DeploymentExecutionContext {
    /** The current claim, including its monotonic fence and latest lease expiry. */
    readonly operation: ClaimedDeploymentOperation;
    /** Aborts when shutdown wins or the operation lease is lost. */
    readonly signal: AbortSignal;
    /** Downloads and verifies the content-addressed release for this current lease. */
    artifact(): Promise<DeploymentArtifact>;
    /**
     * Downloads a no-store runtime capsule containing final environment, code,
     * database placement intent, and ingress identity for this current lease.
     */
    runtime(): Promise<DeploymentRuntimeArtifact>;
    /** Reports generation-fenced desired state for this operation's project. */
    observe(input: {
        generation: number;
        releaseId: string | null;
        state: "running" | "stopped" | "failed";
    }): Promise<boolean>;
}
export interface DeploymentAgentOptions {
    client: DeploymentCoordinatorClient;
    node: DeploymentNodeInput;
    /** Needed only when the credential store does not contain a valid node token. */
    registrationToken?: string;
    credentials?: DeploymentNodeCredentialStore;
    execute(operation: ClaimedDeploymentOperation, context: DeploymentExecutionContext): Promise<unknown>;
    concurrency?: number;
    claimLimit?: number;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
    /**
     * Converts an execution failure into the safe remote message. Defaults to a
     * generic value so local exception details cannot become control-plane logs.
     */
    failureMessage?: (error: unknown) => string;
    /** Receives private local execution and transport failures. */
    onError?: (error: unknown) => void;
}
export interface DeploymentAgentRuntime {
    readonly nodeId: string;
    readonly node: DeploymentNode;
    readonly activeOperations: number;
    readonly draining: boolean;
    /** Resolves after both background loops stop. */
    readonly done: Promise<void>;
    /** Drains claims, waits for work, then aborts work beyond the shutdown deadline. */
    close(): Promise<void>;
}
export declare class DeploymentCoordinatorError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/**
 * Adapts durable deployment orchestration to a bounded server-to-server HTTP
 * protocol. Application traffic and browser credentials are never accepted.
 */
export declare function createDeploymentCoordinatorHandler(orchestrator: DeploymentOrchestrator, options: DeploymentCoordinatorHandlerOptions): DeploymentCoordinatorHandler;
/** Creates a redirect-safe, bounded client for a remote deployment node. */
export declare function createDeploymentCoordinatorClient(options: DeploymentCoordinatorClientOptions): DeploymentCoordinatorClient;
/**
 * Runs the provider-neutral deployment-node lifecycle. Runtime adapters only
 * implement `execute`; enrollment, credentials, claims, renewal, fencing,
 * heartbeat, drain, and bounded shutdown stay identical across Docker/VM hosts.
 */
export declare function openDeploymentAgent(options: DeploymentAgentOptions): Promise<DeploymentAgentRuntime>;
/** In-memory credentials are useful for tests and ephemeral enrolled nodes. */
export declare function memoryDeploymentNodeCredentials(initial?: Record<string, string>): DeploymentNodeCredentialStore;
/**
 * Persists one or more node credentials in an owner-only JSON file using an
 * atomic replacement. The path is operator configuration, never remote input.
 */
export declare function fileDeploymentNodeCredentials(pathInput: string): DeploymentNodeCredentialStore;
