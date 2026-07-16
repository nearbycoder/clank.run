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
export interface NodeSession {
    node: DeploymentNode;
    token: string;
}
export interface DeploymentOperationInput {
    projectId: string;
    action: "reconcile" | "deploy" | "rollback" | "restart" | "stop";
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
export interface DesiredDeployment {
    projectId: string;
    desiredReleaseId: string | null;
    desiredState: "running" | "stopped";
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
    heartbeat(nodeId: string, token: string, input?: {
        capacity?: number;
        labels?: Record<string, string>;
    }): Promise<DeploymentNode>;
    drainNode(nodeId: string, token: string, draining?: boolean): Promise<DeploymentNode>;
    listNodes(): DeploymentNode[];
    setDesired(input: {
        projectId: string;
        releaseId: string | null;
        state: "running" | "stopped";
        region?: string;
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
