import type { DatabaseSchema, SQLiteDatabase } from "./backend.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

type FallbackSourceClaim = { orchestrator: object; operationId: string; nodeId: string; projectId: string; fence: number; operationImage: string; nodeImage: string; check(): void };
type HandoffCoordinator={sourceClaims:{getStore():FallbackSourceClaim|undefined;run<T>(claim:FallbackSourceClaim,callback:()=>T):T};internal:SQLiteInternal;ensureOpen():void;controller:string;reservations:Map<string,object>;claims:{getStore():string|undefined;run<T>(id:string,callback:()=>T):T}};
const handoffCoordinators=new WeakMap<object,HandoffCoordinator>();

/** Private fallback authority; structural orchestrators never expose a catalog. */
export function providerFallbackOrchestrationContext(orchestrator: object) {
  const scope = handoffCoordinators.get(orchestrator);
  if (!scope) throw new Error("A genuine original deployment orchestrator is required for fallback.");
  scope.ensureOpen();
  return Object.freeze({ internal: scope.internal, check: scope.ensureOpen, controller: scope.controller,
    claimOperation: <T>(id: string, callback: () => T): T => scope.claims.run(id, callback),
    async claimSourceOperation<T>(permit: object, callback: () => Promise<T>): Promise<T> {
      const claim = (await import("./provider-fallback-coordinator.ts")).providerFallbackSourceClaimContext(permit);
      if (claim.orchestrator !== orchestrator) throw new Error("Fallback source claim belongs to another original orchestrator.");
      claim.check();
      return scope.sourceClaims.run(claim, () => scope.claims.run(claim.operationId, callback));
    },
    sourceNode: (id: string) => currentHandoffNode(scope, id, false),
    targetNode(id: string, placement: Record<string, unknown>) {
      const target = currentHandoffNode(scope, id, true);
      if (placement.region !== null && target.region !== placement.region || !nodeMeetsRequirements(target, nodeRequirementsFromRow(placement))
        || assignedCapacity(scope.internal, id, String(placement.project_id)) + Number(placement.capacity_units) > Number(target.capacity)) throw new Error("Fallback target capacity or placement requirements changed.");
      return target;
    },
    nodeImage: handoffNodeImage,
  });
}

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

export class DeploymentCapacityError extends Error {
  readonly code = "PINNED_CAPACITY_UNAVAILABLE";

  constructor() {
    super(
      "The pinned stateful deployment node does not have enough process capacity for this generation.",
    );
    this.name = "DeploymentCapacityError";
  }
}

export class DeploymentRelocationError extends Error {
  readonly code = "STATEFUL_RELOCATION_UNAVAILABLE";

  constructor(message = "No healthy provider node can accept this stateful deployment.") {
    super(message);
    this.name = "DeploymentRelocationError";
  }
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
  enqueue(input: DeploymentOperationInput): Promise<{ operation: DeploymentOperation; existing: boolean }>;
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

/**
 * Durable deployment coordination backed by the control-plane SQLite database.
 * Lease tokens prevent impersonation and monotonically increasing fences reject
 * stale workers after a lease expires.
 */
export function openDeploymentOrchestrator<DB extends DatabaseSchema<any>>(
  database: SQLiteDatabase<DB>,
  options: DeploymentOrchestratorOptions = {},
): DeploymentOrchestrator {
  const internal = (database as SQLiteDatabase<DB> & { [SQLITE_INTERNAL]: SQLiteInternal })[SQLITE_INTERNAL];
  if (!internal) throw new Error("Deployment orchestration requires a Clank SQLite database.");
  createTables(internal);
  const nodeTtlMs = integerRange(options.nodeTtlMs ?? 30_000, "nodeTtlMs", 1_000, 10 * 60_000);
  const operationLeaseMs = integerRange(options.operationLeaseMs ?? 60_000, "operationLeaseMs", 100, 60 * 60_000);
  const distributedLeaseMs = integerRange(options.distributedLeaseMs ?? 30_000, "distributedLeaseMs", 100, 60 * 60_000);
  const retryBaseMs = integerRange(options.retryBaseMs ?? 1_000, "retryBaseMs", 10, 60 * 60_000);
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("Deployment orchestrator is closed.");
  };

  const verifyNode = (id: string, token: string): Record<string, unknown> => {
    const row = internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(nodeId(id));
    const valid = row
      && typeof token === "string"
      && token.startsWith("clnka_")
      && safeEqual(String(row.token_hash), syncDigest(token));
    if (!valid) throw new Error("Deployment node authentication failed.");
    return row;
  };

  const chooseNode = (
    region?: string,
    excluded?: string,
    requirements = normalizedNodeRequirements(),
    capacityUnits = 1,
    projectId?: string,
  ): string | null => {
    const now = Date.now();
    const rows = internal.prepare(`SELECT n.*,
        (SELECT coalesce(sum(p.capacity_units), 0)
          FROM clank_deployment_placements p
          WHERE p.assigned_node_id = n.id
            ${projectId ? "AND p.project_id != ?" : ""})
        + (SELECT coalesce(sum(h.capacity_units),0) FROM clank_deployment_handoffs h
          WHERE h.target_node_id=n.id AND h.state='reserved'
            ${projectId ? "AND h.project_id != ?" : ""}) AS used
      FROM clank_deployment_nodes n
      WHERE n.status = 'active' AND n.expires_at > ?
        ${region ? "AND n.region = ?" : ""}
        ${excluded ? "AND n.id != ?" : ""}
      ORDER BY (CAST(used AS REAL) / n.capacity), used, n.id`)
      .all(...[
        ...(projectId ? [projectId, projectId] : []),
        now,
        ...(region ? [region] : []),
        ...(excluded ? [excluded] : []),
      ]);
    const available = rows.find((row) =>
      Number(row.used) + capacityUnits <= Number(row.capacity)
      && nodeMeetsRequirements(row, requirements));
    return available ? String(available.id) : null;
  };

  const reassignExpired = () => {
    const now = Date.now();
    internal.transaction((changes) => {
      const placements = internal.prepare(`SELECT p.project_id, p.assigned_node_id, p.region,
          p.requires_endpoint, p.required_labels, p.capacity_units
        FROM clank_deployment_placements p
        LEFT JOIN clank_deployment_nodes n ON n.id = p.assigned_node_id
        WHERE p.desired_state = 'running'
          AND (
            p.assigned_node_id IS NULL
            OR (
            p.placement_mode = 'portable'
              AND (n.id IS NULL OR n.expires_at <= ? OR n.status = 'offline')
            )
          )
        ORDER BY p.updated_at, p.project_id`).all(now);
      for (const placement of placements) {
        const next = chooseNode(
          placement.region === null ? undefined : String(placement.region),
          placement.assigned_node_id === null ? undefined : String(placement.assigned_node_id),
          nodeRequirementsFromRow(placement),
          Number(placement.capacity_units),
          String(placement.project_id),
        );
        internal.prepare("UPDATE clank_deployment_placements SET assigned_node_id = ?, updated_at = ? WHERE project_id = ?")
          .run(next, now, placement.project_id);
        internal.prepare(`UPDATE clank_deployment_operations SET node_id = ?, updated_at = ?
          WHERE project_id = ? AND state IN ('queued', 'retry')`).run(next, now, placement.project_id);
        changes.record("__orchestration", String(placement.project_id));
      }
      const expiredOperations = internal.prepare(`SELECT o.id, p.assigned_node_id
        FROM clank_deployment_operations o
        JOIN clank_deployment_placements p ON p.project_id = o.project_id
        WHERE o.state = 'leased' AND o.lease_expires_at <= ?
          AND (o.node_id IS NOT p.assigned_node_id)`).all(now);
      for (const operation of expiredOperations) {
        internal.prepare(`UPDATE clank_deployment_operations
          SET state = 'retry', node_id = ?, lease_token_hash = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, updated_at = ?
          WHERE id = ? AND state = 'leased' AND lease_expires_at <= ?`)
          .run(operation.assigned_node_id, now, now, operation.id, now);
        changes.record("__orchestration", String(operation.id));
      }
    });
  };

  const orchestrator: DeploymentOrchestrator = {
    async acquireLease(resourceInput, ownerInput, ttlMs = distributedLeaseMs) {
      ensureOpen();
      const resource = bounded(resourceInput, "lease resource", 1, 300);
      const owner = bounded(ownerInput, "lease owner", 1, 200);
      const ttl = integerRange(ttlMs, "lease ttlMs", 100, 60 * 60_000);
      const token = `clnkl_${randomToken(32)}`;
      const tokenHash = await digest(token);
      const now = Date.now();
      let acquired: DistributedLease | null = null;
      internal.transaction((changes) => {
        const current = internal.prepare("SELECT * FROM clank_distributed_leases WHERE resource = ?").get(resource);
        if (current && Number(current.expires_at) > now && String(current.owner) !== owner) return;
        const fence = current ? Number(current.fence) + 1 : 1;
        internal.prepare(`INSERT INTO clank_distributed_leases
          (resource, owner, token_hash, fence, expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, token_hash = excluded.token_hash,
            fence = excluded.fence, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
          .run(resource, owner, tokenHash, fence, now + ttl, now);
        changes.record("__orchestration", resource);
        acquired = { resource, owner, token, fence, expiresAt: now + ttl };
      });
      return acquired;
    },
    async renewLease(lease, ttlMs = distributedLeaseMs) {
      ensureOpen();
      const ttl = integerRange(ttlMs, "lease ttlMs", 100, 60 * 60_000);
      const now = Date.now();
      const expiresAt = Math.max(now + ttl, lease.expiresAt + 1);
      const result = internal.prepare(`UPDATE clank_distributed_leases SET expires_at = ?, updated_at = ?
        WHERE resource = ? AND owner = ? AND fence = ? AND token_hash = ? AND expires_at > ?`)
        .run(expiresAt, now, lease.resource, lease.owner, lease.fence, await digest(lease.token), now);
      return Number(result.changes) === 1 ? { ...lease, expiresAt } : null;
    },
    async releaseLease(lease) {
      ensureOpen();
      const result = internal.prepare(`DELETE FROM clank_distributed_leases
        WHERE resource = ? AND owner = ? AND fence = ? AND token_hash = ?`)
        .run(lease.resource, lease.owner, lease.fence, await digest(lease.token));
      return Number(result.changes) === 1;
    },
    async registerNode(input) {
      ensureOpen();
      const id = nodeId(input.id);
      const region = safeName(input.region, "region", 100);
      const endpoint = input.endpoint ? secureEndpoint(input.endpoint) : null;
      const capacity = integerRange(input.capacity ?? 100, "capacity", 1, 100_000);
      const labels = normalizedLabels(input.labels ?? {});
      const proposed = {
        endpoint,
        labels: JSON.stringify(labels),
      };
      const token = `clnka_${randomToken(32)}`;
      const now = Date.now();
      internal.transaction((changes) => {
        assertAssignedNodeRequirements(internal, id, region, proposed);
        assertAssignedNodeCapacity(internal, id, capacity);
        internal.prepare(`INSERT INTO clank_deployment_nodes
          (id, token_hash, region, endpoint, capacity, labels, status, heartbeat_at, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, region = excluded.region,
            endpoint = excluded.endpoint, capacity = excluded.capacity, labels = excluded.labels,
            status = 'active', heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`)
          .run(id, syncDigest(token), region, endpoint, capacity, JSON.stringify(labels), now, now + nodeTtlMs, now, now);
        changes.record("__orchestration", id);
      });
      return {
        node: nodeFromRow(internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!),
        token,
      };
    },
    async authenticateNode(idInput, token) {
      ensureOpen();
      const row = verifyNode(nodeId(idInput), token);
      if (Number(row.expires_at) <= Date.now() || String(row.status) === "offline") {
        throw new Error("Deployment node lease is expired.");
      }
      return nodeFromRow(row);
    },
    async heartbeat(idInput, token, heartbeat = {}) {
      ensureOpen();
      const id = nodeId(idInput);
      verifyNode(id, token);
      const tokenHash = await digest(token);
      const now = Date.now();
      return internal.transaction((changes) => {
        const row = internal.prepare(
          "SELECT * FROM clank_deployment_nodes WHERE id = ? AND token_hash = ?",
        ).get(id, tokenHash);
        if (!row) throw new Error("Deployment node authentication failed.");
        const capacity = heartbeat.capacity === undefined
          ? Number(row.capacity)
          : integerRange(heartbeat.capacity, "capacity", 1, 100_000);
        const labels = heartbeat.labels === undefined
          ? JSON.parse(String(row.labels))
          : normalizedLabels(heartbeat.labels);
        if (heartbeat.labels !== undefined) {
          assertAssignedNodeRequirements(internal, id, String(row.region), {
            endpoint: row.endpoint === null ? null : String(row.endpoint),
            labels: JSON.stringify(labels),
          });
        }
        assertAssignedNodeCapacity(internal, id, capacity);
        internal.prepare(`UPDATE clank_deployment_nodes SET capacity = ?, labels = ?, heartbeat_at = ?,
          expires_at = ?, status = CASE WHEN status = 'offline' THEN 'active' ELSE status END, updated_at = ?
          WHERE id = ? AND token_hash = ?`).run(
          capacity,
          JSON.stringify(labels),
          now,
          now + nodeTtlMs,
          now,
          id,
          tokenHash,
        );
        changes.record("__orchestration", id);
        return nodeFromRow(
          internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!,
        );
      });
    },
    async drainNode(idInput, token, draining = true) {
      ensureOpen();
      const id = nodeId(idInput);
      return internal.transaction((changes) => {
        verifyNode(id, token);
        internal.prepare("UPDATE clank_deployment_nodes SET status = ?, updated_at = ? WHERE id = ?")
          .run(draining ? "draining" : "active", Date.now(), id);
        changes.record("__orchestration", id);
        return nodeFromRow(internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!);
      });
    },
    setNodeDraining(idInput, draining) {
      ensureOpen();
      const id = nodeId(idInput);
      const row = internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id);
      if (!row) throw new Error("Deployment node not found.");
      if (Number(row.expires_at) <= Date.now() || String(row.status) === "offline") {
        throw new Error("Deployment node lease is expired.");
      }
      internal.transaction((changes) => {
        internal.prepare("UPDATE clank_deployment_nodes SET status = ?, updated_at = ? WHERE id = ?")
          .run(draining ? "draining" : "active", Date.now(), id);
        changes.record("__orchestration", id);
      });
      return nodeFromRow(
        internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!,
      );
    },
    revokeNode(idInput) {
      ensureOpen();
      const id = nodeId(idInput);
      const row = internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id);
      if (!row) throw new Error("Deployment node not found.");
      const now = Date.now();
      internal.transaction((changes) => {
        internal.prepare(`UPDATE clank_deployment_nodes
          SET token_hash = ?, status = 'offline', expires_at = 0, updated_at = ?
          WHERE id = ?`)
          .run(syncDigest(`revoked:${randomToken(32)}`), now, id);
        changes.record("__orchestration", id);
      });
      reassignExpired();
      return nodeFromRow(
        internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!,
        now,
      );
    },
    listNodes() {
      ensureOpen();
      const now = Date.now();
      return internal.prepare("SELECT * FROM clank_deployment_nodes ORDER BY id").all()
        .map((row) => nodeFromRow(row, now));
    },
    async setDesired(input) {
      ensureOpen();
      const projectId = safeName(input.projectId, "projectId", 128);
      const region = input.region ? safeName(input.region, "region", 100) : null;
      const state = input.state;
      if (state !== "running" && state !== "stopped") {
        throw new TypeError("state must be running or stopped.");
      }
      const releaseId = input.releaseId === null
        ? null
        : safeName(input.releaseId, "releaseId", 128);
      if (state === "running" && releaseId === null) {
        throw new TypeError("A running deployment requires a releaseId.");
      }
      if (state === "stopped" && releaseId !== null) {
        throw new TypeError("A stopped deployment cannot select a releaseId.");
      }
      const runtimeProtocol = input.runtimeProtocol;
      if (runtimeProtocol !== undefined && runtimeProtocol !== "clank-runtime/1") {
        throw new TypeError("runtimeProtocol is unsupported.");
      }
      if (state === "stopped" && runtimeProtocol !== undefined) {
        throw new TypeError("A stopped deployment cannot select a runtimeProtocol.");
      }
      reassignExpired();
      const now = Date.now();
      const allocation = internal.transaction((changes) => {
        requireNoProviderHandoff(internal, projectId);
        const existing = internal.prepare(
          "SELECT * FROM clank_deployment_placements WHERE project_id = ?",
        ).get(projectId);
        const capacityUnits = integerRange(
          input.capacityUnits === undefined
            ? Number(existing?.capacity_units ?? 1)
            : input.capacityUnits,
          "capacityUnits",
          1,
          100_000,
        );
        const storedPlacementMode = existing
          ? String(existing.placement_mode) as DeploymentPlacementMode
          : null;
        const placementMode = input.placementMode ?? storedPlacementMode ?? "portable";
        if (placementMode !== "portable" && placementMode !== "stateful") {
          throw new TypeError("placementMode must be portable or stateful.");
        }
        if (storedPlacementMode && input.placementMode && input.placementMode !== storedPlacementMode) {
          throw new TypeError("A deployment placementMode cannot change after it is created.");
        }
        const storedNodeRequirements = existing
          ? nodeRequirementsFromRow(existing)
          : null;
        const nodeRequirements = input.nodeRequirements === undefined
          ? storedNodeRequirements ?? normalizedNodeRequirements()
          : normalizedNodeRequirements(input.nodeRequirements);
        if (
          placementMode === "stateful"
          && existing?.assigned_node_id !== null
          && existing?.assigned_node_id !== undefined
          && storedNodeRequirements
          && !sameNodeRequirements(nodeRequirements, storedNodeRequirements)
        ) {
          throw new TypeError("Pinned stateful deployment nodeRequirements cannot change.");
        }
        const storedRegion = existing?.region === null || existing?.region === undefined
          ? null
          : String(existing.region);
        const desiredRegion = input.region === undefined ? storedRegion : region;
        if (
          placementMode === "stateful"
          && existing?.assigned_node_id !== null
          && existing?.assigned_node_id !== undefined
          && input.region !== undefined
          && desiredRegion !== storedRegion
        ) {
          throw new TypeError("A pinned stateful deployment region cannot change.");
        }
        const generation = existing ? Number(existing.generation) + 1 : 1;
        const assignedNodeId = state === "running"
          ? placementMode === "stateful"
            && existing?.assigned_node_id !== null
            && existing?.assigned_node_id !== undefined
            ? assignedStatefulNode(
                internal,
                String(existing.assigned_node_id),
                projectId,
                capacityUnits,
              )
            : chooseNode(
                desiredRegion ?? undefined,
                undefined,
                nodeRequirements,
                capacityUnits,
                projectId,
              )
          : existing?.assigned_node_id === null || existing?.assigned_node_id === undefined
            ? null
            : String(existing.assigned_node_id);
        internal.prepare(`INSERT INTO clank_deployment_placements
          (project_id, desired_release_id, desired_state, placement_mode, requires_endpoint,
           required_labels, capacity_units, assigned_node_id, region, generation,
           observed_release_id, observed_state, observed_generation, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'unknown', 0, ?)
          ON CONFLICT(project_id) DO UPDATE SET desired_release_id = excluded.desired_release_id,
            desired_state = excluded.desired_state, placement_mode = excluded.placement_mode,
            requires_endpoint = excluded.requires_endpoint,
            required_labels = excluded.required_labels,
            capacity_units = excluded.capacity_units,
            assigned_node_id = excluded.assigned_node_id,
            region = excluded.region, generation = excluded.generation, updated_at = excluded.updated_at`)
          .run(
            projectId,
            releaseId,
            state,
            placementMode,
            nodeRequirements.endpoint ? 1 : 0,
            JSON.stringify(nodeRequirements.labels),
            capacityUnits,
            assignedNodeId,
            desiredRegion,
            generation,
            now,
          );
        changes.record("__orchestration", projectId);
        return { assignedNodeId, desiredRegion, generation };
      });
      const { assignedNodeId, desiredRegion, generation } = allocation;
      await orchestrator.enqueue({
        projectId,
        action: "reconcile",
        payload: {
          releaseId,
          state,
          generation,
          ...(runtimeProtocol ? { runtimeProtocol } : {}),
        },
        idempotencyKey: `reconcile:${projectId}:${generation}`,
        ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
        ...(desiredRegion ? { region: desiredRegion } : {}),
      });
      return orchestrator.desired(projectId)!;
    },
    async relocateStateful(input) {
      ensureOpen();
      const projectId = safeName(input.projectId, "projectId", 128);
      const sourceNodeId = nodeId(input.sourceNodeId);
      if (input.runtimeProtocol !== "clank-runtime/1") {
        throw new TypeError("runtimeProtocol is unsupported.");
      }
      reassignExpired();
      const now = Date.now();
      const allocation = internal.transaction((changes) => {
        requireNoProviderHandoff(internal, projectId);
        const existing = internal.prepare(
          "SELECT * FROM clank_deployment_placements WHERE project_id = ?",
        ).get(projectId);
        if (
          !existing
          || existing.placement_mode !== "stateful"
          || existing.desired_state !== "running"
          || existing.desired_release_id === null
          || existing.assigned_node_id !== sourceNodeId
        ) {
          throw new TypeError(
            "The stateful deployment source does not match its current placement.",
          );
        }
        const source = internal.prepare(
          "SELECT status, expires_at FROM clank_deployment_nodes WHERE id = ?",
        ).get(sourceNodeId);
        if (
          !source
          || (
            source.status !== "offline"
            && Number(source.expires_at) > now
          )
        ) {
          throw new TypeError(
            "The stateful deployment source must be offline before relocation.",
          );
        }
        const region = existing.region === null
          ? undefined
          : String(existing.region);
        const targetNodeId = chooseNode(
          region,
          sourceNodeId,
          nodeRequirementsFromRow(existing),
          Number(existing.capacity_units),
          projectId,
        );
        if (!targetNodeId) throw new DeploymentRelocationError();
        const generation = Number(existing.generation) + 1;
        internal.prepare(`UPDATE clank_deployment_operations
          SET state = 'cancelled', lease_token_hash = NULL,
            lease_expires_at = NULL, updated_at = ?
          WHERE project_id = ? AND state IN ('queued', 'retry', 'leased')`)
          .run(now, projectId);
        internal.prepare(`UPDATE clank_deployment_placements
          SET assigned_node_id = ?, generation = ?, observed_release_id = NULL,
            observed_state = 'unknown', observed_generation = 0, updated_at = ?
          WHERE project_id = ? AND assigned_node_id = ? AND generation = ?`)
          .run(
            targetNodeId,
            generation,
            now,
            projectId,
            sourceNodeId,
            existing.generation,
          );
        changes.record("__orchestration", projectId);
        return {
          generation,
          releaseId: String(existing.desired_release_id),
          targetNodeId,
          region,
        };
      });
      await orchestrator.enqueue({
        projectId,
        action: "reconcile",
        payload: {
          releaseId: allocation.releaseId,
          state: "running",
          generation: allocation.generation,
          runtimeProtocol: input.runtimeProtocol,
        },
        idempotencyKey: `reconcile:${projectId}:${allocation.generation}`,
        nodeId: allocation.targetNodeId,
        ...(allocation.region ? { region: allocation.region } : {}),
      });
      return orchestrator.desired(projectId)!;
    },
    desired(projectIdInput) {
      ensureOpen();
      const row = internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id = ?")
        .get(safeName(projectIdInput, "projectId", 128));
      return row ? desiredFromRow(row) : null;
    },
    async observe(nodeIdInput, token, input) {
      ensureOpen();
      const id = nodeId(nodeIdInput);
      const node = verifyNode(id, token);
      const result = internal.prepare(`UPDATE clank_deployment_placements
        SET observed_release_id = ?, observed_state = ?, observed_generation = ?,
            assigned_node_id = CASE
              WHEN placement_mode = 'portable' AND desired_state = 'stopped' AND ? = 'stopped'
                THEN NULL
              ELSE assigned_node_id
            END,
            updated_at = ?
        WHERE project_id = ? AND assigned_node_id = ? AND generation = ? AND observed_generation <= ?
          AND EXISTS (SELECT 1 FROM clank_deployment_nodes WHERE id = ? AND token_hash = ?)`)
        .run(
          input.releaseId,
          input.state,
          input.generation,
          input.state,
          Date.now(),
          safeName(input.projectId, "projectId", 128),
          id,
          input.generation,
          input.generation,
          id,
          node.token_hash,
        );
      return Number(result.changes) === 1;
    },
    async enqueue(input) {
      ensureOpen();
      assertJson(input.payload ?? null, "operation payload");
      const projectId = safeName(input.projectId, "projectId", 128);
      const idempotencyKey = bounded(input.idempotencyKey, "idempotencyKey", 8, 300);
      const existing = internal.prepare("SELECT * FROM clank_deployment_operations WHERE idempotency_key = ?")
        .get(idempotencyKey);
      if (existing) return { operation: operationFromRow(existing), existing: true };
      reassignExpired();
      const node = input.nodeId
        ? nodeId(input.nodeId)
        : chooseNode(input.region);
      const id = `op_${randomToken(18)}`;
      const now = Date.now();
      const maxAttempts = integerRange(input.maxAttempts ?? 10, "maxAttempts", 1, 100);
      internal.transaction((changes) => {
        requireNoProviderHandoff(internal,projectId);
        internal.prepare(`INSERT INTO clank_deployment_operations
          (id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
           lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, 0, NULL, NULL, ?, ?, NULL, NULL, ?, ?)`)
          .run(
            id,
            projectId,
            input.action,
            JSON.stringify(input.payload ?? null),
            node,
            maxAttempts,
            now,
            idempotencyKey,
            now,
            now,
          );
        changes.record("__orchestration", id);
      });
      return {
        operation: operationFromRow(internal.prepare("SELECT * FROM clank_deployment_operations WHERE id = ?").get(id)!),
        existing: false,
      };
    },
    async claim(nodeIdInput, token, limit = 10) {
      ensureOpen();
      const id = nodeId(nodeIdInput);
      const node = verifyNode(id, token);
      const sourceClaim = handoffCoordinators.get(orchestrator)?.sourceClaims.getStore();
      const sourceAdmission = (current: Record<string, unknown>, operation?: Record<string, unknown>) => {
        if (!sourceClaim || String(current.status) !== "draining") return false;
        sourceClaim.check();
        if (sourceClaim.nodeId !== id || Number(current.expires_at) <= Date.now() || handoffNodeImage(current) !== sourceClaim.nodeImage
          || handoffCoordinators.get(orchestrator)?.claims.getStore() !== sourceClaim.operationId
          || Number(internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(sourceClaim.projectId)?.fence) !== sourceClaim.fence
          || JSON.stringify(internal.prepare("SELECT * FROM clank_deployment_operations WHERE id=?").get(sourceClaim.operationId)) !== sourceClaim.operationImage
          || operation && (operation.id !== sourceClaim.operationId || operation.project_id !== sourceClaim.projectId || operation.node_id !== id)
          || internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(sourceClaim.projectId)) throw new Error("Fallback source claim original admission changed.");
        return true;
      };
      if (sourceClaim && !sourceAdmission(node)) throw new Error("Fallback source claim requires its original draining node.");
      if (Number(node.expires_at) <= Date.now() || String(node.status) !== "active") {
        if (String(node.status) === "draining" && !sourceClaim) return [];
        if (Number(node.expires_at) <= Date.now() || String(node.status) !== "draining") throw new Error("Deployment node lease is expired.");
      }
      const count = integerRange(limit, "limit", 1, 100);
      reassignExpired();
      const now = Date.now();
      const claimed: ClaimedDeploymentOperation[] = [];
      const selectedOperation = handoffCoordinators.get(orchestrator)?.claims.getStore() ?? null;
      const candidates = internal.prepare(`SELECT * FROM clank_deployment_operations
        WHERE node_id = ? AND (? IS NULL OR id = ?) AND NOT EXISTS(SELECT 1 FROM clank_deployment_handoffs h WHERE h.project_id=clank_deployment_operations.project_id AND h.state='reserved') AND (
          (state IN ('queued', 'retry') AND next_attempt_at <= ?)
          OR (state = 'leased' AND lease_expires_at <= ?)
        )
        ORDER BY created_at LIMIT ?`).all(id, selectedOperation, selectedOperation, now, now, count);
      for (const candidate of candidates) {
        const leaseToken = `clnko_${randomToken(32)}`;
        const leaseTokenHash = await digest(leaseToken);
        const expiresAt = now + operationLeaseMs;
        const fence = internal.transaction(() => {
          const currentNode = verifyNode(id, token);
          if (Number(currentNode.expires_at) <= Date.now() || String(currentNode.status) === "offline") {
            throw new Error("Deployment node lease is expired.");
          }
          if (sourceClaim) { if (!sourceAdmission(currentNode, candidate)) throw new Error("Fallback source claim draining admission changed."); }
          else if (String(currentNode.status) !== "active") return null;
          const current = internal.prepare(`SELECT project_id
            FROM clank_deployment_operations
            WHERE id = ? AND node_id = ? AND (
              (state IN ('queued', 'retry') AND next_attempt_at <= ?)
              OR (state = 'leased' AND lease_expires_at <= ?)
            )`).get(candidate.id, id, now, now);
          if (!current) return null;
          const projectId = String(current.project_id);
          if(internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(projectId))return null;
          internal.prepare(`INSERT INTO clank_deployment_project_fences
            (project_id, fence, updated_at) VALUES (?, 1, ?)
            ON CONFLICT(project_id) DO UPDATE
              SET fence = fence + 1,
                updated_at = MAX(clank_deployment_project_fences.updated_at, excluded.updated_at)`)
            .run(projectId, now);
          const allocated = Number(internal.prepare(`SELECT fence
            FROM clank_deployment_project_fences WHERE project_id = ?`)
            .get(projectId)!.fence);
          const updated = internal.prepare(`UPDATE clank_deployment_operations
            SET state = 'leased', attempts = attempts + 1, fence = ?, lease_token_hash = ?,
                lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND node_id = ? AND (
              (state IN ('queued', 'retry') AND next_attempt_at <= ?)
              OR (state = 'leased' AND lease_expires_at <= ?)
            )`).run(
              allocated,
              leaseTokenHash,
              expiresAt,
              now,
              candidate.id,
              id,
              now,
              now,
            );
          if (Number(updated.changes) !== 1) {
            throw new Error("Deployment operation changed during fence allocation.");
          }
          return allocated;
        });
        if (fence === null) continue;
        claimed.push({
          ...operationFromRow(internal.prepare("SELECT * FROM clank_deployment_operations WHERE id = ?").get(candidate.id)!),
          state: "leased",
          nodeId: id,
          leaseToken,
          leaseExpiresAt: expiresAt,
        });
      }
      return claimed;
    },
    async authenticateOperation(operation) {
      ensureOpen();
      const row = internal.prepare(`SELECT * FROM clank_deployment_operations
        WHERE id = ? AND state = 'leased' AND node_id = ? AND fence = ?
          AND lease_token_hash = ? AND lease_expires_at > ?`).get(
        safeName(operation.id, "operation ID", 128),
        nodeId(operation.nodeId),
        integerRange(operation.fence, "operation fence", 1, Number.MAX_SAFE_INTEGER),
        await digest(bounded(operation.leaseToken, "operation lease token", 8, 512)),
        Date.now(),
      );
      if (!row) return null;
      const stored = operationFromRow(row);
      return {
        ...stored,
        state: "leased",
        nodeId: String(row.node_id),
        leaseExpiresAt: Number(row.lease_expires_at),
      };
    },
    async renewOperation(operation) {
      ensureOpen();
      const expiresAt = Date.now() + operationLeaseMs;
      const result = internal.prepare(`UPDATE clank_deployment_operations
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND node_id = ? AND fence = ?
          AND lease_token_hash = ? AND lease_expires_at > ?`)
        .run(
          expiresAt,
          Date.now(),
          operation.id,
          operation.nodeId,
          operation.fence,
          await digest(operation.leaseToken),
          Date.now(),
        );
      return Number(result.changes) === 1 ? { ...operation, leaseExpiresAt: expiresAt } : null;
    },
    async complete(operation, resultValue = null) {
      ensureOpen();
      assertJson(resultValue, "operation result");
      const result = internal.prepare(`UPDATE clank_deployment_operations
        SET state = 'succeeded', result = ?, error = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'leased' AND node_id = ? AND fence = ?
          AND lease_token_hash = ? AND lease_expires_at > ?`)
        .run(
          JSON.stringify(resultValue),
          Date.now(),
          operation.id,
          operation.nodeId,
          operation.fence,
          await digest(operation.leaseToken),
          Date.now(),
        );
      return Number(result.changes) === 1;
    },
    async fail(operation, error) {
      ensureOpen();
      const current = internal.prepare("SELECT * FROM clank_deployment_operations WHERE id = ?").get(operation.id);
      if (!current) throw new Error("Deployment operation not found.");
      const attempts = Number(current.attempts);
      const dead = attempts >= Number(current.max_attempts);
      const nextAttempt = Date.now() + Math.min(60 * 60_000, retryBaseMs * 2 ** Math.max(0, attempts - 1));
      const updated = internal.prepare(`UPDATE clank_deployment_operations
        SET state = ?, error = ?, lease_token_hash = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND node_id = ? AND fence = ?
          AND lease_token_hash = ?`)
        .run(
          dead ? "failed" : "retry",
          safeError(error).slice(0, 4_096),
          nextAttempt,
          Date.now(),
          operation.id,
          operation.nodeId,
          operation.fence,
          await digest(operation.leaseToken),
        );
      if (Number(updated.changes) !== 1) throw new Error("Deployment operation lease is stale.");
      return operationFromRow(internal.prepare("SELECT * FROM clank_deployment_operations WHERE id = ?").get(operation.id)!);
    },
    operation(id) {
      ensureOpen();
      const row = internal.prepare("SELECT * FROM clank_deployment_operations WHERE id = ?")
        .get(safeName(id, "operation ID", 128));
      return row ? operationFromRow(row) : null;
    },
    close() {
      closed = true;
    },
  };
  handoffCoordinators.set(orchestrator,{internal,ensureOpen,controller:crypto.randomUUID(),reservations:new Map(),claims:new ((globalThis as any).process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)(),sourceClaims:new ((globalThis as any).process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)()});
  return orchestrator;
}

function createTables(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_distributed_leases (
    resource TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK (fence > 0),
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_nodes (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    region TEXT NOT NULL,
    endpoint TEXT,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    labels TEXT NOT NULL CHECK (json_valid(labels)),
    status TEXT NOT NULL CHECK (status IN ('active', 'draining', 'offline')),
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_nodes_ready ON clank_deployment_nodes (status, region, expires_at)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_placements (
    project_id TEXT PRIMARY KEY,
    desired_release_id TEXT,
    desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
    placement_mode TEXT NOT NULL DEFAULT 'portable' CHECK (placement_mode IN ('portable', 'stateful')),
    requires_endpoint INTEGER NOT NULL DEFAULT 0 CHECK (requires_endpoint IN (0, 1)),
    required_labels TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(required_labels)),
    capacity_units INTEGER NOT NULL DEFAULT 1 CHECK (capacity_units > 0),
    assigned_node_id TEXT REFERENCES clank_deployment_nodes(id) ON DELETE SET NULL,
    region TEXT,
    generation INTEGER NOT NULL CHECK (generation > 0),
    observed_release_id TEXT,
    observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'running', 'stopped', 'failed')),
    observed_generation INTEGER NOT NULL CHECK (observed_generation >= 0),
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_handoffs (
    handoff_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
    capacity_units INTEGER NOT NULL CHECK(capacity_units>0),
    controller_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
    state TEXT NOT NULL CHECK(state IN ('reserved','committed','cancelled')),
    input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(input_json)<=32768),
    input_sha256 TEXT NOT NULL, placement_json TEXT NOT NULL CHECK(json_valid(placement_json)),
    source_node_json TEXT NOT NULL CHECK(json_valid(source_node_json)),
    target_node_json TEXT NOT NULL CHECK(json_valid(target_node_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT`);
  internal.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_deployment_handoffs_active ON clank_deployment_handoffs(project_id) WHERE state='reserved'");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_handoffs_capacity ON clank_deployment_handoffs(target_node_id,state)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_fallback_journals (
    operation_id TEXT PRIMARY KEY REFERENCES clank_deployment_handoffs(handoff_id),
    journal TEXT NOT NULL CHECK(json_valid(journal) AND length(journal)<=524288),
    authentication TEXT NOT NULL CHECK(length(authentication)=64)
  ) STRICT`);
  const placementColumns = internal.prepare("PRAGMA table_info(clank_deployment_placements)").all();
  if (!placementColumns.some((column) => String(column.name) === "placement_mode")) {
    internal.exec(`ALTER TABLE clank_deployment_placements
      ADD COLUMN placement_mode TEXT NOT NULL DEFAULT 'portable'
      CHECK (placement_mode IN ('portable', 'stateful'))`);
  }
  if (!placementColumns.some((column) => String(column.name) === "requires_endpoint")) {
    internal.exec(`ALTER TABLE clank_deployment_placements
      ADD COLUMN requires_endpoint INTEGER NOT NULL DEFAULT 0 CHECK (requires_endpoint IN (0, 1))`);
  }
  if (!placementColumns.some((column) => String(column.name) === "required_labels")) {
    internal.exec(`ALTER TABLE clank_deployment_placements
      ADD COLUMN required_labels TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(required_labels))`);
  }
  if (!placementColumns.some((column) => String(column.name) === "capacity_units")) {
    internal.exec(`ALTER TABLE clank_deployment_placements
      ADD COLUMN capacity_units INTEGER NOT NULL DEFAULT 1 CHECK (capacity_units > 0)`);
  }
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_deployment_placements_node
    ON clank_deployment_placements (assigned_node_id)`);
  const operationsTable = internal.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'clank_deployment_operations'`).get();
  if (!operationsTable) {
    createDeploymentOperationsTable(internal);
  } else if (!String(operationsTable.sql).includes("'delete'")) {
    internal.transaction(() => {
      internal.exec(`ALTER TABLE clank_deployment_operations
        RENAME TO clank_deployment_operations_legacy`);
      createDeploymentOperationsTable(internal);
      internal.exec(`INSERT INTO clank_deployment_operations
        (id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
         lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
         created_at, updated_at)
        SELECT id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
          lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
          created_at, updated_at
        FROM clank_deployment_operations_legacy`);
      internal.exec("DROP TABLE clank_deployment_operations_legacy");
    });
  }
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_project_fences (
    project_id TEXT PRIMARY KEY,
    fence INTEGER NOT NULL CHECK (fence > 0),
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  internal.exec(`INSERT INTO clank_deployment_project_fences (project_id, fence, updated_at)
    SELECT project_id, MAX(fence), MAX(updated_at)
    FROM clank_deployment_operations
    WHERE fence > 0
    GROUP BY project_id
    ON CONFLICT(project_id) DO UPDATE SET
      fence = MAX(clank_deployment_project_fences.fence, excluded.fence),
      updated_at = MAX(clank_deployment_project_fences.updated_at, excluded.updated_at)`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_operations_ready ON clank_deployment_operations (node_id, state, next_attempt_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_operations_project ON clank_deployment_operations (project_id, created_at)");
}

function createDeploymentOperationsTable(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE clank_deployment_operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (
      action IN ('reconcile', 'deploy', 'rollback', 'restart', 'stop', 'delete')
    ),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'retry', 'succeeded', 'failed', 'cancelled')),
    node_id TEXT REFERENCES clank_deployment_nodes(id) ON DELETE SET NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    fence INTEGER NOT NULL CHECK (fence >= 0),
    lease_token_hash TEXT,
    lease_expires_at INTEGER,
    next_attempt_at INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function nodeFromRow(row: Record<string, unknown>, now = Date.now()): DeploymentNode {
  const storedStatus = String(row.status) as DeploymentNode["status"];
  return {
    id: String(row.id),
    region: String(row.region),
    ...(row.endpoint === null ? {} : { endpoint: String(row.endpoint) }),
    capacity: Number(row.capacity),
    labels: JSON.parse(String(row.labels)),
    status: Number(row.expires_at) <= now ? "offline" : storedStatus,
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
  };
}

function operationFromRow(row: Record<string, unknown>): DeploymentOperation {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    action: String(row.action) as DeploymentOperation["action"],
    state: String(row.state) as DeploymentOperation["state"],
    payload: JSON.parse(String(row.payload)),
    nodeId: row.node_id === null ? null : String(row.node_id),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    fence: Number(row.fence),
    nextAttemptAt: Number(row.next_attempt_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.error === null ? {} : { error: String(row.error) }),
    ...(row.result === null ? {} : { result: JSON.parse(String(row.result)) }),
  };
}

function desiredFromRow(row: Record<string, unknown>): DesiredDeployment {
  return {
    projectId: String(row.project_id),
    desiredReleaseId: row.desired_release_id === null ? null : String(row.desired_release_id),
    desiredState: String(row.desired_state) as DesiredDeployment["desiredState"],
    placementMode: String(row.placement_mode) as DeploymentPlacementMode,
    capacityUnits: Number(row.capacity_units),
    nodeRequirements: nodeRequirementsFromRow(row),
    assignedNodeId: row.assigned_node_id === null ? null : String(row.assigned_node_id),
    generation: Number(row.generation),
    observedReleaseId: row.observed_release_id === null ? null : String(row.observed_release_id),
    observedState: String(row.observed_state) as DesiredDeployment["observedState"],
    observedGeneration: Number(row.observed_generation),
    updatedAt: Number(row.updated_at),
  };
}

function normalizedLabels(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 100) throw new TypeError("A deployment node may have at most 100 labels.");
  for (const [name, value] of entries) {
    const normalizedName = safeName(name, "label name", 100);
    if (["__proto__", "constructor", "prototype"].includes(normalizedName)) {
      throw new TypeError("Deployment node label name is reserved.");
    }
    output[normalizedName] = bounded(value, `label ${name}`, 0, 200);
  }
  return output;
}

function normalizedNodeRequirements(
  input: DeploymentNodeRequirements = {},
): Readonly<{ endpoint: boolean; labels: Readonly<Record<string, string>> }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("nodeRequirements must be an object.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("nodeRequirements must be a plain object.");
  }
  if (Object.keys(input).some((key) => key !== "endpoint" && key !== "labels")) {
    throw new TypeError("nodeRequirements contains an unknown field.");
  }
  if (input.endpoint !== undefined && typeof input.endpoint !== "boolean") {
    throw new TypeError("nodeRequirements.endpoint must be a boolean.");
  }
  const labels = normalizedLabels(input.labels ?? {});
  return Object.freeze({
    endpoint: input.endpoint === true,
    labels: Object.freeze(labels),
  });
}

function nodeRequirementsFromRow(
  row: Record<string, unknown>,
): Readonly<{ endpoint: boolean; labels: Readonly<Record<string, string>> }> {
  const raw = JSON.parse(String(row.required_labels ?? "{}"));
  return normalizedNodeRequirements({
    endpoint: Number(row.requires_endpoint ?? 0) === 1,
    labels: raw,
  });
}

function sameNodeRequirements(
  left: Readonly<{ endpoint: boolean; labels: Readonly<Record<string, string>> }>,
  right: Readonly<{ endpoint: boolean; labels: Readonly<Record<string, string>> }>,
): boolean {
  return left.endpoint === right.endpoint
    && JSON.stringify(left.labels) === JSON.stringify(right.labels);
}

function nodeMeetsRequirements(
  row: Record<string, unknown>,
  requirements: Readonly<{ endpoint: boolean; labels: Readonly<Record<string, string>> }>,
): boolean {
  if (requirements.endpoint && row.endpoint === null) return false;
  const labels = JSON.parse(String(row.labels)) as Record<string, unknown>;
  return Object.entries(requirements.labels).every(([name, value]) => labels[name] === value);
}

function assertAssignedNodeRequirements(
  internal: SQLiteInternal,
  id: string,
  region: string,
  proposed: { endpoint: string | null; labels: string },
): void {
  const placements = [
    ...internal.prepare(`SELECT placement_mode, region, requires_endpoint, required_labels
      FROM clank_deployment_placements WHERE assigned_node_id = ?`).all(id),
    ...internal.prepare("SELECT placement_json FROM clank_deployment_handoffs WHERE target_node_id=? AND state='reserved'").all(id).map(row=>JSON.parse(String(row.placement_json))),
  ];
  const row = { endpoint: proposed.endpoint, labels: proposed.labels };
  for (const placement of placements) {
    if (
      placement.placement_mode === "stateful"
      && placement.region !== null
      && String(placement.region) !== region
    ) {
      throw new TypeError("A node with stateful placements cannot re-register in another region.");
    }
    if (!nodeMeetsRequirements(row, nodeRequirementsFromRow(placement))) {
      throw new TypeError("A node cannot remove a capability required by an assigned placement.");
    }
  }
}

function assignedCapacity(
  internal: SQLiteInternal,
  nodeId: string,
  excludedProjectId?: string,
): number {
  const row = internal.prepare(`SELECT
    (SELECT coalesce(sum(capacity_units),0) FROM clank_deployment_placements
      WHERE assigned_node_id=? ${excludedProjectId?"AND project_id!=?":""})
    + (SELECT coalesce(sum(capacity_units),0) FROM clank_deployment_handoffs
      WHERE target_node_id=? AND state='reserved' ${excludedProjectId?"AND project_id!=?":""}) AS used`).get(
    nodeId,...(excludedProjectId?[excludedProjectId]:[]),nodeId,...(excludedProjectId?[excludedProjectId]:[]),
  );
  return Number(row?.used ?? 0);
}

function assertAssignedNodeCapacity(
  internal: SQLiteInternal,
  id: string,
  capacity: number,
): void {
  if (assignedCapacity(internal, id) > capacity) {
    throw new TypeError(
      "A node cannot reduce capacity below the process slots reserved by assigned placements.",
    );
  }
}

function assignedStatefulNode(
  internal: SQLiteInternal,
  nodeId: string,
  projectId: string,
  capacityUnits: number,
): string {
  const node = internal.prepare(
    "SELECT capacity FROM clank_deployment_nodes WHERE id = ?",
  ).get(nodeId);
  if (!node) {
    throw new TypeError("A pinned stateful deployment node no longer exists.");
  }
  if (assignedCapacity(internal, nodeId, projectId) + capacityUnits > Number(node.capacity)) {
    throw new DeploymentCapacityError();
  }
  return nodeId;
}

function secureEndpoint(input: string): string {
  const url = new URL(input);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
  ) throw new TypeError("Node endpoint must use HTTPS, except for loopback development.");
  return url.href.replace(/\/$/u, "");
}

function nodeId(value: string): string {
  return safeName(value, "node ID", 128);
}

function safeName(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/u.test(value) || value.length > maximum) {
    throw new TypeError(`Invalid ${name}.`);
  }
  return value;
}

function bounded(value: string, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} must contain ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function integerRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function assertJson(value: unknown, name: string): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined");
    JSON.parse(encoded);
  } catch {
    throw new TypeError(`${name} must be JSON serializable.`);
  }
}

function randomToken(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return base64Url(bytes);
}

function syncDigest(value: string): string {
  const module = (globalThis as any).process?.getBuiltinModule?.("node:crypto");
  if (!module) throw new Error("Node crypto module is unavailable.");
  return module.createHash("sha256").update(value, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireNoProviderHandoff(internal: SQLiteInternal, projectId: string): void {
  if (internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(projectId)) {
    throw new Error("PROJECT_HANDOFF_PENDING: settle the original provider handoff before changing placement.");
  }
}

export interface ProviderHandoffPlacementReservation { readonly handoffId: string; readonly projectId: string; readonly targetNodeId: string; }
type NativeHandoffIngress = ReturnType<typeof import("./provider-service.ts").providerSourceHandoffIngressContext>;
type NativeHandoffTarget = import("./provider-target-stage.ts").ProviderTransferTarget;
type NativeHandoffReceipt = import("./provider-target-stage.ts").ProviderTargetTransferReceipt;
type HandoffPlacementContext = {scope:HandoffCoordinator;ingress:NativeHandoffIngress;service:object;target:NativeHandoffTarget;receipt:NativeHandoffReceipt;identity:Record<string,any>;expected:string;failed:boolean;publicationComplete:boolean;platform?:import("./platform.ts").PlatformProviderHandoffParticipant};
const handoffPlacements = new WeakMap<object,HandoffPlacementContext>();
const handoffTargetReservations=new WeakMap<object,ProviderHandoffPlacementReservation>();
const handoffPublicationReservations=new WeakMap<object,ProviderHandoffPlacementReservation>();
/** Original durable coordinator publication; serialized rows never supply this binding. */
export function providerHandoffPublicationContext(target:object){
 const reservation=handoffPublicationReservations.get(target);if(!reservation)return undefined;
 const held=handoffReservation(reservation);if(held.target!==target)throw new Error("Original coordinator publication target differs.");
 return Object.freeze({committed(active:import("./provider-target-stage.ts").ProviderActivatedTarget){
  const current=handoffReservation(reservation),row=JSON.parse(current.expected);
  if(row.state!=="committed")return false;
  const result=JSON.parse(row.result_json);
  if(current.target!==target||current.ingress.active()!==active||result.targetId!==active.targetId||result.containerId!==active.containerId||result.capsuleSha256!==active.capsuleSha256||result.nodeId!==active.nodeId||result.releaseId!==active.releaseId||result.generation!==active.generation||result.pid!==active.pid||result.birth!==active.birth)throw new Error("Original committed coordinator publication differs from its native target.");
  return true;
 }});
}
/** Private target-data fence; no caller number or serialized reservation is accepted. */
export function providerHandoffTargetDataContext(target:object){
 const reservation=handoffTargetReservations.get(target);if(!reservation)throw new Error("Canonical target requires its genuine original coordinator reservation.");
 const held=handoffReservation(reservation),input=JSON.parse(JSON.parse(held.expected).input_json),fence=input.targetFence;
 if(!Number.isSafeInteger(fence)||fence<1)throw new Error("Original canonical target fence is unavailable.");
 const check=()=>{const current=handoffReservation(reservation),row=current.scope.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(current.identity.source.projectId);if(current.target!==target||Number(row?.fence)!==fence)throw new Error("Original canonical target lifecycle fence changed.");};
 check();return Object.freeze({fence,check});
}
const HANDOFF_PLACEMENT_KEYS = ["project_id","desired_release_id","desired_state","placement_mode","requires_endpoint","required_labels","capacity_units","assigned_node_id","region","generation"];
function handoffPlacementImage(row:Record<string,unknown>):string{return JSON.stringify(Object.fromEntries(HANDOFF_PLACEMENT_KEYS.map(key=>[key,row[key]])));}
function handoffNodeImage(row:Record<string,unknown>):string{return JSON.stringify(Object.fromEntries(["id","region","endpoint","capacity","labels","token_hash"].map(key=>[key,row[key]])));}
function currentHandoffNode(scope:HandoffCoordinator,id:string,target:boolean):Record<string,unknown>{
  const row=scope.internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id=?").get(id);
  if(!row||Number(row.expires_at)<=Date.now()||!(target?row.status==="active":["active","draining"].includes(String(row.status))))throw new Error("Original provider handoff node is no longer available.");
  return row;
}
function handoffReservation(value:object):HandoffPlacementContext{
  const held=handoffPlacements.get(value);if(!held)throw new Error("A genuine original handoff placement reservation is required.");
  held.scope.ensureOpen();if(held.failed)throw new Error("Original provider handoff reservation is fenced.");
  const id=JSON.parse(held.expected).handoff_id,row=held.scope.internal.prepare("SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?").get(id);
  if(JSON.stringify(row)!==held.expected){held.failed=true;throw new Error("Original provider handoff reservation changed without its owning commit.");}
  return held;
}

/** Private coordinator reservation. Native source/target identity supplies all placement selectors. */
export async function reserveProviderHandoffPlacement(orchestrator:DeploymentOrchestrator,service:object,target:NativeHandoffTarget,receipt:NativeHandoffReceipt):Promise<ProviderHandoffPlacementReservation>{
  const scope=handoffCoordinators.get(orchestrator);if(!scope)throw new Error("A genuine original deployment orchestrator is required.");scope.ensureOpen();
  const [{providerSourceHandoffIngressContext},{providerTargetHandoffContext},sourceModule]=await Promise.all([import("./provider-service.ts"),import("./provider-target-stage.ts"),import("./provider-handoff.ts")]);scope.ensureOpen();
  const ingress=providerSourceHandoffIngressContext(service),selected=providerTargetHandoffContext(target,receipt),transfer=sourceModule.providerSourceTransferContext(selected.source),identity=transfer.binding.identity;
  if(transfer.bridge!==ingress.source.bridge||selected.source.grantId!==ingress.source.grantId||ingress.phase()!=="source")throw new Error("Provider handoff reservation requires its original live source and staged target.");
  const existing=scope.reservations.get(identity.handoffId);
  if(existing){const held=handoffReservation(existing);if(held.service!==service||held.target!==target||held.receipt!==receipt)throw new Error("Original provider handoff reservation inputs differ.");return existing as ProviderHandoffPlacementReservation;}
  if(selected.platform&&selected.platform.orchestrator!==orchestrator)throw new Error("Original platform and handoff coordinator must own the same native database.");
  selected.platform?.check();
  ingress.source.check();await selected.verify();scope.ensureOpen();ingress.source.check();selected.check();
  if(ingress.phase()!=="source")throw new Error("Original provider source changed during reservation.");
  const input=JSON.stringify({protocol:"clank-provider-handoff-placement/1",identity,sourceGrantId:selected.source.grantId,targetId:target.targetId,targetContainerId:target.containerId,targetCapsuleSha256:target.capsuleSha256,...(selected.platform?{platform:selected.platform.identity}:{})});
  if(Buffer.byteLength(input)>32768)throw new Error("Original provider handoff placement exceeds its bound.");
  const expected=scope.internal.transaction(changes=>{
    scope.ensureOpen();ingress.source.check();selected.check();selected.platform?.check();requireNoProviderHandoff(scope.internal,identity.source.projectId);
    const placement=scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(identity.source.projectId);
    if(!placement||placement.placement_mode!=="stateful"||placement.desired_state!=="running"||placement.assigned_node_id!==identity.source.nodeId||placement.desired_release_id!==identity.source.releaseId||Number(placement.generation)!==identity.source.generation||placement.observed_state!=="running"||placement.observed_release_id!==identity.source.releaseId||Number(placement.observed_generation)!==identity.source.generation||identity.targetGeneration!==identity.source.generation+1)throw new Error("Original provider source does not match its current observed placement.");
    const source=currentHandoffNode(scope,identity.source.nodeId,false),destination=currentHandoffNode(scope,identity.targetNodeId,true);
    if(identity.source.nodeId===identity.targetNodeId||placement.region!==null&&destination.region!==placement.region||!nodeMeetsRequirements(destination,nodeRequirementsFromRow(placement))||assignedCapacity(scope.internal,identity.targetNodeId,identity.source.projectId)+Number(placement.capacity_units)>Number(destination.capacity))throw new Error("Original provider handoff target cannot accept this placement.");
    const counts=scope.internal.prepare("SELECT count(*) total,sum(project_id=?) project FROM clank_deployment_handoffs").get(identity.source.projectId)!;
    if(Number(counts.total)>=1000||Number(counts.project)>=32)throw new Error("Provider handoff placement history capacity is exhausted.");
    const now=Date.now();let approvedInput=input;
    if(selected.canonical){
      const before=scope.internal.prepare("SELECT fence,updated_at FROM clank_deployment_project_fences WHERE project_id=?").get(identity.source.projectId);
      const fence=Number(before?.fence??0)+1;
      if(!Number.isSafeInteger(fence)||fence<1)throw new Error("Canonical target lifecycle fence is exhausted.");
      if(scope.internal.prepare("INSERT INTO clank_deployment_project_fences(project_id,fence,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET fence=excluded.fence,updated_at=excluded.updated_at WHERE clank_deployment_project_fences.fence=excluded.fence-1").run(identity.source.projectId,fence,Math.max(now,Number(before?.updated_at??0))).changes!==1||Number(scope.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(identity.source.projectId)?.fence)!==fence)throw new Error("Canonical target lifecycle fence allocation failed.");
      approvedInput=JSON.stringify({...JSON.parse(input),targetFence:fence});if(Buffer.byteLength(approvedInput)>32768)throw new Error("Original canonical handoff placement exceeds its bound.");
    }
    if(scope.internal.prepare("INSERT INTO clank_deployment_handoffs VALUES(?,?,?,?,?,?,1,'reserved',?,?,?,?,?,NULL,?,?)").run(identity.handoffId,identity.source.projectId,identity.source.nodeId,identity.targetNodeId,placement.capacity_units,scope.controller,approvedInput,syncDigest(approvedInput),JSON.stringify(placement),handoffNodeImage(source),handoffNodeImage(destination),now,now).changes!==1)throw new Error("Original provider handoff reservation was not retained.");
    changes.record("__orchestration",identity.source.projectId);
    return JSON.stringify(scope.internal.prepare("SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?").get(identity.handoffId));
  });
  const result=Object.freeze({handoffId:identity.handoffId,projectId:identity.source.projectId,targetNodeId:identity.targetNodeId});
  handoffPlacements.set(result,{scope,ingress,service,target,receipt,identity,expected,failed:false,publicationComplete:false,platform:selected.platform});scope.reservations.set(identity.handoffId,result);handoffPublicationReservations.set(target,result);if(selected.canonical)handoffTargetReservations.set(target,result);handoffReservation(result);return result;
}

/** Atomically promotes only the original provider's currently published healthy target. */
export async function commitProviderHandoffPlacement(value:ProviderHandoffPlacementReservation):Promise<DesiredDeployment>{
  const held=handoffReservation(value),{scope,ingress,identity}=held;
  // An early commit is a non-mutating refusal; it does not consume a valid reservation.
  if(ingress.phase()!=="target")throw new Error("Original provider target is not published.");
  try{
    const active=ingress.active();
    if(active.targetId!==held.target.targetId||active.containerId!==held.target.containerId||active.nodeId!==identity.targetNodeId||active.projectId!==identity.source.projectId||active.releaseId!==identity.source.releaseId||active.generation!==identity.targetGeneration)throw new Error("Published provider target differs from its original reservation.");
    await active.verifyHealthy();handoffReservation(value);if(ingress.active()!==active)throw new Error("Original provider target changed before coordinator commit.");
    const result=JSON.stringify({protocol:"clank-provider-handoff-placement-committed/1",handoffId:identity.handoffId,targetId:active.targetId,containerId:active.containerId,capsuleSha256:active.capsuleSha256,nodeId:active.nodeId,releaseId:active.releaseId,generation:active.generation,pid:active.pid,birth:active.birth});
    const publicationTime=Date.now();
    if(held.platform&&handoffTargetReservations.has(held.target)&&JSON.parse(held.expected).state==="reserved"){const conditional=await held.platform.prepareConditional(active,publicationTime),handoff=await import("./provider-handoff.ts");await handoff.persistProviderConditionalTarget(active,conditional.journal,conditional.authentication);handoffReservation(value);if(ingress.active()!==active)throw new Error("Original conditional publication target changed.");}
    const committed=scope.internal.transaction(changes=>{
      handoffReservation(value);if(ingress.active()!==active)throw new Error("Original provider target is no longer published.");
      const before=JSON.parse(held.expected),placement=scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(identity.source.projectId);
      if(!placement)throw new Error("Original provider placement is missing.");
      if(before.state==="committed"){
        if(before.result_json!==result||placement.assigned_node_id!==identity.targetNodeId||Number(placement.generation)!==identity.targetGeneration||placement.desired_release_id!==identity.source.releaseId||placement.desired_state!=="running"||placement.observed_state!=="running"||Number(placement.observed_generation)!==identity.targetGeneration)throw new Error("Original committed provider handoff no longer owns this placement.");
        return {expected:held.expected,desired:desiredFromRow(placement)};
      }
      if(before.state!=="reserved"||before.controller_id!==scope.controller||before.input_sha256!==syncDigest(before.input_json)||handoffPlacementImage(placement)!==handoffPlacementImage(JSON.parse(before.placement_json)))throw new Error("Original provider handoff placement preimage changed.");
      const source=currentHandoffNode(scope,identity.source.nodeId,false),destination=currentHandoffNode(scope,identity.targetNodeId,true);
      if(handoffNodeImage(source)!==before.source_node_json||handoffNodeImage(destination)!==before.target_node_json||!nodeMeetsRequirements(destination,nodeRequirementsFromRow(placement))||assignedCapacity(scope.internal,identity.targetNodeId,identity.source.projectId)+Number(placement.capacity_units)>Number(destination.capacity))throw new Error("Original provider handoff node or capacity changed.");
      held.platform?.commit(active);
      if(held.platform)changes.record("__platform",identity.source.projectId);
      const now=publicationTime;
      if(scope.internal.prepare("UPDATE clank_deployment_placements SET assigned_node_id=?,generation=?,observed_release_id=?,observed_state='running',observed_generation=?,updated_at=? WHERE project_id=? AND assigned_node_id=? AND generation=? AND desired_release_id=? AND desired_state='running'").run(identity.targetNodeId,identity.targetGeneration,identity.source.releaseId,identity.targetGeneration,now,identity.source.projectId,identity.source.nodeId,identity.source.generation,identity.source.releaseId).changes!==1)throw new Error("Original provider handoff placement compare-and-set failed.");
      scope.internal.prepare("UPDATE clank_deployment_operations SET state='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE project_id=? AND state IN ('queued','retry','leased')").run(now,identity.source.projectId);
      if(scope.internal.prepare("UPDATE clank_deployment_handoffs SET state='committed',version=version+1,result_json=?,updated_at=? WHERE handoff_id=? AND version=? AND state='reserved' AND controller_id=? AND input_sha256=?").run(result,now,identity.handoffId,before.version,scope.controller,before.input_sha256).changes!==1)throw new Error("Original provider handoff receipt compare-and-set failed.");
      const after=scope.internal.prepare("SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?").get(identity.handoffId)!;
      const wantedHandoff={...before,state:"committed",version:Number(before.version)+1,result_json:result,updated_at:now};
      const published=scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(identity.source.projectId)!;
      const wantedPlacement={...placement,assigned_node_id:identity.targetNodeId,generation:identity.targetGeneration,observed_release_id:identity.source.releaseId,observed_state:"running",observed_generation:identity.targetGeneration,updated_at:now};
      if(JSON.stringify(after)!==JSON.stringify(wantedHandoff)||JSON.stringify(published)!==JSON.stringify(wantedPlacement)||scope.internal.prepare("SELECT id FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased') LIMIT 1").get(identity.source.projectId))throw new Error("Original provider handoff commit readback differs.");
      changes.record("__orchestration",identity.source.projectId);
      return {expected:JSON.stringify(after),desired:desiredFromRow(published)};
    });
    held.expected=committed.expected;held.platform?.accept();const targetModule=await import("./provider-target-stage.ts");await targetModule.completeProviderTargetPublication(active);handoffReservation(value);if(ingress.active()!==active)throw new Error("Original coordinator publication changed before acknowledgement.");held.publicationComplete=true;return committed.desired;
  }catch(error){held.failed=true;try{await ingress.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Provider handoff coordinator uncertainty and native cleanup failed.");}throw error;}
}

/** Capacity is released only after the exact staged or active target has been closed. */
export async function cancelProviderHandoffPlacement(value:ProviderHandoffPlacementReservation):Promise<void>{
  const held=handoffReservation(value),before=JSON.parse(held.expected);if(before.state==="cancelled")return;if(before.state!=="reserved")throw new Error("A committed provider handoff cannot be cancelled.");
  try{
    if(held.ingress.phase()==="source")await held.target.close();else await held.ingress.close();
    handoffReservation(value);const expected=held.scope.internal.transaction(changes=>{
      handoffReservation(value);if(held.scope.internal.prepare("UPDATE clank_deployment_handoffs SET state='cancelled',version=version+1,updated_at=? WHERE handoff_id=? AND version=? AND state='reserved' AND controller_id=?").run(Date.now(),before.handoff_id,before.version,held.scope.controller).changes!==1)throw new Error("Original provider handoff cancellation was not retained.");
      changes.record("__orchestration",before.project_id);return JSON.stringify(held.scope.internal.prepare("SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?").get(before.handoff_id));
    });held.expected=expected;
  }catch(error){held.failed=true;throw error;}
}

export interface ProviderHandoffTargetRestartPermit {readonly handoffId:string;readonly projectId:string;}
type RestartPermitContext={check():void;begin():void;native:ReturnType<typeof import("./provider-target-stage.ts").providerActivatedTargetRestartContext>;proof:Readonly<Record<string,unknown>>};
const targetRestartPermits=new WeakMap<object,RestartPermitContext>();
export function providerHandoffTargetRestartContext(value:object){const held=targetRestartPermits.get(value);if(!held)throw new Error("A genuine original target restart permit is required.");held.check();return held;}
export async function prepareProviderHandoffTargetRestart(value:ProviderHandoffPlacementReservation):Promise<ProviderHandoffTargetRestartPermit>{
 const held=handoffReservation(value),committed=held.expected,before=JSON.parse(committed);if(before.state!=="committed"||!held.publicationComplete)throw new Error("Target restart requires its original committed and acknowledged handoff.");
 const active=held.ingress.active();await active.verifyHealthy();handoffReservation(value);
 const module=await import("./provider-target-stage.ts"),native=module.providerActivatedTargetRestartContext(active),input=JSON.parse(before.input_json);
 if(native.target.containerId!==held.target.containerId||!Number.isSafeInteger(input.targetFence))throw new Error("Target restart differs from its canonical handoff.");
 await held.ingress.close();await native.verifyRemoved();
 let expectedStopped="";const check=()=>{const current=handoffReservation(value),row=current.scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(value.projectId),fence=current.scope.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(value.projectId);if(JSON.parse(current.expected).state!=="committed"||current.expected!==committed||expectedStopped&&JSON.stringify(row)!==expectedStopped||!row||row.assigned_node_id!==held.identity.targetNodeId||Number(row.generation)!==held.identity.targetGeneration||row.desired_release_id!==held.identity.source.releaseId||row.desired_state!=="running"||Number(fence?.fence)!==input.targetFence)throw new Error("Original target restart placement or lifecycle fence changed.");};
 check();held.scope.internal.transaction(changes=>{check();const prior=held.scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(value.projectId)!,now=Date.now();const stopped=held.scope.internal.prepare("UPDATE clank_deployment_placements SET observed_state='stopped',observed_release_id=NULL,updated_at=? WHERE project_id=? AND assigned_node_id=? AND generation=? AND desired_release_id=?").run(now,value.projectId,held.identity.targetNodeId,held.identity.targetGeneration,held.identity.source.releaseId);expectedStopped=JSON.stringify({...prior,observed_state:"stopped",observed_release_id:null,updated_at:now});if(stopped.changes!==1||JSON.stringify(held.scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(value.projectId))!==expectedStopped)throw new Error("Target restart stopped observation was not retained.");changes.record("__orchestration",value.projectId);});check();if(JSON.stringify(held.scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(value.projectId))!==expectedStopped)throw new Error("Target restart stopped observation commit differs.");
 const proof=Object.freeze({protocol:"clank-provider-target-restart/1",handoffId:value.handoffId,...native.target,lifecycleFence:input.targetFence,coordinatorReceipt:before.result_json,stateJSON:native.stateJSON,fenceJSON:native.fenceJSON,processes:native.processes});let begun=false;
 const permit=Object.freeze({handoffId:value.handoffId,projectId:value.projectId});targetRestartPermits.set(permit,Object.freeze({native,proof,check,begin(){check();if(begun)throw new Error("Original target restart publication is already consumed.");begun=true;}}));return permit;
}

/** A committed handoff can publish one receipt for its still-running original writer. */
export interface ProviderHandoffTargetAdoptionPermit {readonly handoffId:string;readonly projectId:string;}
type AdoptionPermitContext={check():void;begin():void;native:ReturnType<typeof import("./provider-target-stage.ts").providerActivatedTargetAdoptionContext>;proof:Readonly<Record<string,unknown>>};
const targetAdoptionPermits=new WeakMap<object,AdoptionPermitContext>();
const targetAdoptionReservations=new WeakSet<ProviderHandoffPlacementReservation>();
export function providerHandoffTargetAdoptionContext(value:object){const held=targetAdoptionPermits.get(value);if(!held)throw new Error("A genuine original target adoption permit is required.");held.check();return held;}
export async function prepareProviderHandoffTargetAdoption(value:ProviderHandoffPlacementReservation):Promise<ProviderHandoffTargetAdoptionPermit>{
 const held=handoffReservation(value),committed=held.expected,before=JSON.parse(committed);
 if(before.state!=="committed"||!held.publicationComplete)throw new Error("Live target adoption requires its original committed and acknowledged handoff.");
 if(targetAdoptionReservations.has(value))throw new Error("Original target live adoption is already reserved.");targetAdoptionReservations.add(value);
 const active=held.ingress.active();await active.verifyHealthy();handoffReservation(value);
 const module=await import("./provider-target-stage.ts"),native=module.providerActivatedTargetAdoptionContext(active),input=JSON.parse(before.input_json);
 if(native.target.containerId!==held.target.containerId||!Number.isSafeInteger(input.targetFence))throw new Error("Live target adoption differs from its canonical handoff.");
 const check=()=>{
  const current=handoffReservation(value),row=current.scope.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(value.projectId),fence=current.scope.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(value.projectId);
  if(current.expected!==committed||!row||row.assigned_node_id!==held.identity.targetNodeId||Number(row.generation)!==held.identity.targetGeneration||row.desired_release_id!==held.identity.source.releaseId||row.desired_state!=="running"||row.observed_state!=="running"||Number(row.observed_generation)!==held.identity.targetGeneration||row.observed_release_id!==held.identity.source.releaseId||Number(fence?.fence)!==input.targetFence)throw new Error("Original live target adoption placement or lifecycle fence changed.");
  native.check();if(held.ingress.active()!==active)throw new Error("Original live target adoption publication changed.");
 };
 check();const proof=Object.freeze({protocol:"clank-provider-target-adoption/1",handoffId:value.handoffId,...native.target,lifecycleFence:input.targetFence,coordinatorReceipt:before.result_json,stateJSON:native.stateJSON,fenceJSON:native.fenceJSON,configurationSha256:native.configurationSha256,processes:native.processes});let begun=false;
 const permit=Object.freeze({handoffId:value.handoffId,projectId:value.projectId});targetAdoptionPermits.set(permit,Object.freeze({native,proof,check,begin(){check();if(begun)throw new Error("Original target adoption publication is already consumed.");begun=true;}}));return permit;
}


export interface ProviderConditionalRestartPermit {readonly handoffId:string;readonly projectId:string;}
type ConditionalRestartPermitContext={native:ReturnType<typeof import("./provider-handoff.ts").providerConditionalRecoveryContext>;proof:Readonly<Record<string,unknown>>;check():void};
const conditionalRestartPermits=new WeakMap<object,ConditionalRestartPermitContext>();
export function providerConditionalRestartPermitContext(value:object):ConditionalRestartPermitContext{const held=conditionalRestartPermits.get(value);if(!held)throw new Error("A genuine recovered coordinator restart permit is required.");held.check();return held;}
/** Fresh platform authority settles uncertainty to STOPPED; it never reports a running writer. */
export async function recoverProviderHandoffTarget(runtime:object,targetOwner:import("./provider-handoff.ts").ProviderServiceOwnership,sourceOwner:import("./provider-handoff.ts").ProviderServiceOwnership,client:import("./provider-docker-client.ts").DockerClient):Promise<ProviderConditionalRestartPermit>{
 const [platform,handoff]=await Promise.all([import("./platform.ts"),import("./provider-handoff.ts")]),context=platform.platformProviderHandoffContext(runtime),native=handoff.providerConditionalRecoveryContext(targetOwner,sourceOwner,client),authority=context.recovery(native.journal,native.authentication),approved=platform.platformConditionalRecoveryAuthority(authority,native.journal,native.authentication);
 await native.verify(authority);native.check();approved.check();await approved.settle(native);await native.verify(authority);native.check();approved.check();
 const input=JSON.parse(native.journal),target=input.native,proof=Object.freeze({protocol:"clank-provider-target-restart/1",handoffId:input.reservation.handoff_id,...target.target,lifecycleFence:input.fence,coordinatorReceipt:input.committedHandoff.result_json,stateJSON:target.stateJSON,fenceJSON:target.fenceJSON,processes:target.processes});
 const check=()=>{native.check();approved.check();};check();const permit=Object.freeze({handoffId:input.reservation.handoff_id,projectId:input.reservation.project_id});conditionalRestartPermits.set(permit,{native,proof,check});await native.publish(permit);check();return permit;
}
