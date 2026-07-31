import type { DatabaseSchema, SQLiteDatabase } from "./backend.js";
export interface DistributedLease {
    resource: string;
    owner: string;
    token: string;
    fence: number;
    expiresAt: number;
}
export interface DeploymentNodeInput {
    id: string;
    region: string;
    endpoint?: string;
    capacity?: number;
    labels?: Record<string, string>;
}
export interface DeploymentNode {
    id: string;
    region: string;
    endpoint?: string;
    capacity: number;
    labels: Record<string, string>;
    status: "active" | "draining" | "offline";
    heartbeatAt: number;
    expiresAt: number;
}
export interface DeploymentNodeRequirements {
    /** Require a registered private HTTPS/loopback endpoint. */
    endpoint?: boolean;
    /** Require exact node label values. */
    labels?: Record<string, string>;
}
export interface NodeSession {
    node: DeploymentNode;
    token: string;
}
export interface DeploymentOperationInput {
    projectId: string;
  action: "reconcile" | "deploy" | "rollback" | "restart" | "stop" | "delete";
    payload?: unknown;
    idempotencyKey: string;
    nodeId?: string;
    region?: string;
    maxAttempts?: number;
}
export interface DeploymentOperation {
    id: string;
    projectId: string;
    action: DeploymentOperationInput["action"];
    state: "queued" | "leased" | "retry" | "succeeded" | "failed" | "cancelled";
    payload: unknown;
    nodeId: string | null;
    attempts: number;
    maxAttempts: number;
    fence: number;
    nextAttemptAt: number;
    leaseExpiresAt: number | null;
    createdAt: number;
    updatedAt: number;
    error?: string;
    result?: unknown;
}
export interface ClaimedDeploymentOperation extends DeploymentOperation {
    state: "leased";
    nodeId: string;
    leaseToken: string;
    leaseExpiresAt: number;
}
export type DeploymentOperationLease = Omit<ClaimedDeploymentOperation, "leaseToken">;
/**
 * Portable placements may move after node loss. Stateful placements reserve
 * one node identity so node-local data is never failed over implicitly.
 */
export type DeploymentPlacementMode = "portable" | "stateful";
export declare class DeploymentCapacityError extends Error {
    readonly code = "PINNED_CAPACITY_UNAVAILABLE";
    constructor();
}
export declare class DeploymentRelocationError extends Error {
    readonly code = "STATEFUL_RELOCATION_UNAVAILABLE";
    constructor(message?: string);
}
export interface DesiredDeployment {
    projectId: string;
    desiredReleaseId: string | null;
    desiredState: "running" | "stopped";
    placementMode: DeploymentPlacementMode;
    /** Process slots reserved on the assigned node. */
    capacityUnits: number;
    nodeRequirements: Readonly<{
        endpoint: boolean;
        labels: Readonly<Record<string, string>>;
    }>;
    assignedNodeId: string | null;
    generation: number;
    observedReleaseId: string | null;
    observedState: "unknown" | "running" | "stopped" | "failed";
    observedGeneration: number;
    updatedAt: number;
}
export interface DeploymentOrchestrator {
    acquireLease(resource: string, owner: string, ttlMs?: number): Promise<DistributedLease | null>;
    renewLease(lease: DistributedLease, ttlMs?: number): Promise<DistributedLease | null>;
    releaseLease(lease: DistributedLease): Promise<boolean>;
    registerNode(input: DeploymentNodeInput): Promise<NodeSession>;
    /** Verifies a node credential without extending its heartbeat lease. */
    authenticateNode(nodeId: string, token: string): Promise<DeploymentNode>;
    heartbeat(nodeId: string, token: string, input?: {
        capacity?: number;
        labels?: Record<string, string>;
    }): Promise<DeploymentNode>;
    drainNode(nodeId: string, token: string, draining?: boolean): Promise<DeploymentNode>;
    /** Operator-only lifecycle control; callers must enforce their own authorization boundary. */
    setNodeDraining(nodeId: string, draining: boolean): DeploymentNode;
    /**
     * Invalidates a node credential and marks the node offline. Callers must
     * enforce their own operator authorization boundary.
     */
    revokeNode(nodeId: string): DeploymentNode;
    listNodes(): DeploymentNode[];
    setDesired(input: {
        projectId: string;
        releaseId: string | null;
        state: "running" | "stopped";
        region?: string;
        /**
         * Defaults to "portable" for a new placement and inherits the durable mode
         * on later generations. A placement mode cannot be changed implicitly.
         */
        placementMode?: DeploymentPlacementMode;
        /**
         * Durable capability selection. Later generations inherit omitted
         * requirements; a pinned stateful placement cannot change them.
         */
        nodeRequirements?: DeploymentNodeRequirements;
        /**
         * Process slots required by this deployment. Defaults to one for a new
         * placement and inherits the durable value on later generations.
         */
        capacityUnits?: number;
        /** Selects the sensitive runtime capsule contract for the reconcile operation. */
        runtimeProtocol?: "clank-runtime/1";
    }): Promise<DesiredDeployment>;
    /**
     * Explicitly moves a stateful placement after its exact source node has been
     * revoked or its heartbeat lease has expired. Callers must separately fence
     * the source provider and supply replacement data for the new generation.
     */
    relocateStateful(input: {
        projectId: string;
        sourceNodeId: string;
        runtimeProtocol: "clank-runtime/1";
    }): Promise<DesiredDeployment>;
    desired(projectId: string): DesiredDeployment | null;
    observe(nodeId: string, token: string, input: {
        projectId: string;
        generation: number;
        releaseId: string | null;
        state: "running" | "stopped" | "failed";
    }): Promise<boolean>;
    enqueue(input: DeploymentOperationInput): Promise<{
        operation: DeploymentOperation;
        existing: boolean;
    }>;
    claim(nodeId: string, token: string, limit?: number): Promise<ClaimedDeploymentOperation[]>;
    /** Returns the canonical current lease without extending or settling it. */
    authenticateOperation(operation: ClaimedDeploymentOperation): Promise<DeploymentOperationLease | null>;
    renewOperation(operation: ClaimedDeploymentOperation): Promise<ClaimedDeploymentOperation | null>;
    complete(operation: ClaimedDeploymentOperation, result?: unknown): Promise<boolean>;
    fail(operation: ClaimedDeploymentOperation, error: unknown): Promise<DeploymentOperation>;
    operation(id: string): DeploymentOperation | null;
    close(): void;
}
export interface DeploymentOrchestratorOptions {
    nodeTtlMs?: number;
    operationLeaseMs?: number;
    distributedLeaseMs?: number;
    retryBaseMs?: number;
}
export declare function openDeploymentOrchestrator<DB extends DatabaseSchema<any>>(database: SQLiteDatabase<DB>, options?: DeploymentOrchestratorOptions): DeploymentOrchestrator;
