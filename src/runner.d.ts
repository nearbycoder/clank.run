import type {
    ClaimedDeploymentOperation,
    DeploymentNode,
    DeploymentNodeInput,
    DeploymentOperation,
    DeploymentOrchestrator,
    NodeSession,
} from "./orchestration.js";
export declare const DEPLOYMENT_COORDINATOR_PREFIX = "/api/runner/v1";
export interface DeploymentCoordinatorHandlerOptions {
    /** Separate high-entropy secret used only to enroll or rotate deployment nodes. */
    registrationToken: string;
    /** Maximum JSON request body. Defaults to 128 KiB. */
    maxRequestBytes?: number;
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
