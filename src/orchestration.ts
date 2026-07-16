import type { DatabaseSchema, SQLiteDatabase } from "./backend.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

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
  enqueue(input: DeploymentOperationInput): Promise<{ operation: DeploymentOperation; existing: boolean }>;
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

  const verifyNode = async (id: string, token: string): Promise<Record<string, unknown>> => {
    const row = internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(nodeId(id));
    const valid = row
      && typeof token === "string"
      && token.startsWith("clnka_")
      && await safeEqual(String(row.token_hash), await digest(token));
    if (!valid) throw new Error("Deployment node authentication failed.");
    return row;
  };

  const chooseNode = (region?: string, excluded?: string): string | null => {
    const now = Date.now();
    const rows = internal.prepare(`SELECT n.*,
        (SELECT count(*) FROM clank_deployment_placements p WHERE p.assigned_node_id = n.id) AS used
      FROM clank_deployment_nodes n
      WHERE n.status = 'active' AND n.expires_at > ?
        ${region ? "AND n.region = ?" : ""}
        ${excluded ? "AND n.id != ?" : ""}
      ORDER BY (CAST(used AS REAL) / n.capacity), used, n.id`)
      .all(...[now, ...(region ? [region] : []), ...(excluded ? [excluded] : [])]);
    const available = rows.find((row) => Number(row.used) < Number(row.capacity));
    return available ? String(available.id) : null;
  };

  const reassignExpired = () => {
    const now = Date.now();
    const placements = internal.prepare(`SELECT p.project_id, p.assigned_node_id, p.region
      FROM clank_deployment_placements p
      LEFT JOIN clank_deployment_nodes n ON n.id = p.assigned_node_id
      WHERE p.assigned_node_id IS NOT NULL
        AND (n.id IS NULL OR n.expires_at <= ? OR n.status = 'offline')`).all(now);
    for (const placement of placements) {
      const next = chooseNode(
        placement.region === null ? undefined : String(placement.region),
        String(placement.assigned_node_id),
      );
      internal.prepare("UPDATE clank_deployment_placements SET assigned_node_id = ?, updated_at = ? WHERE project_id = ?")
        .run(next, now, placement.project_id);
      internal.prepare(`UPDATE clank_deployment_operations SET node_id = ?, updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'retry')`).run(next, now, placement.project_id);
    }
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
      const token = `clnka_${randomToken(32)}`;
      const now = Date.now();
      internal.transaction((changes) => {
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
    async heartbeat(idInput, token, heartbeat = {}) {
      ensureOpen();
      const id = nodeId(idInput);
      const row = await verifyNode(id, token);
      const capacity = heartbeat.capacity === undefined
        ? Number(row.capacity)
        : integerRange(heartbeat.capacity, "capacity", 1, 100_000);
      const labels = heartbeat.labels === undefined
        ? JSON.parse(String(row.labels))
        : normalizedLabels(heartbeat.labels);
      const now = Date.now();
      internal.prepare(`UPDATE clank_deployment_nodes SET capacity = ?, labels = ?, heartbeat_at = ?,
        expires_at = ?, status = CASE WHEN status = 'offline' THEN 'active' ELSE status END, updated_at = ?
        WHERE id = ?`).run(capacity, JSON.stringify(labels), now, now + nodeTtlMs, now, id);
      return nodeFromRow(internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!);
    },
    async drainNode(idInput, token, draining = true) {
      ensureOpen();
      const id = nodeId(idInput);
      await verifyNode(id, token);
      internal.prepare("UPDATE clank_deployment_nodes SET status = ?, updated_at = ? WHERE id = ?")
        .run(draining ? "draining" : "active", Date.now(), id);
      return nodeFromRow(internal.prepare("SELECT * FROM clank_deployment_nodes WHERE id = ?").get(id)!);
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
      reassignExpired();
      const existing = internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id = ?").get(projectId);
      const generation = existing ? Number(existing.generation) + 1 : 1;
      const assignedNodeId = input.state === "running"
        ? chooseNode(region ?? undefined)
        : existing?.assigned_node_id === null || existing?.assigned_node_id === undefined
          ? null
          : String(existing.assigned_node_id);
      if (input.state === "running" && !assignedNodeId) throw new Error("No deployment node has capacity for the desired placement.");
      const now = Date.now();
      internal.transaction((changes) => {
        internal.prepare(`INSERT INTO clank_deployment_placements
          (project_id, desired_release_id, desired_state, assigned_node_id, region, generation,
           observed_release_id, observed_state, observed_generation, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', 0, ?)
          ON CONFLICT(project_id) DO UPDATE SET desired_release_id = excluded.desired_release_id,
            desired_state = excluded.desired_state, assigned_node_id = excluded.assigned_node_id,
            region = excluded.region, generation = excluded.generation, updated_at = excluded.updated_at`)
          .run(projectId, input.releaseId, input.state, assignedNodeId, region, generation, now);
        changes.record("__orchestration", projectId);
      });
      await orchestrator.enqueue({
        projectId,
        action: "reconcile",
        payload: { releaseId: input.releaseId, state: input.state, generation },
        idempotencyKey: `reconcile:${projectId}:${generation}`,
        ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
        ...(region ? { region } : {}),
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
      await verifyNode(id, token);
      const result = internal.prepare(`UPDATE clank_deployment_placements
        SET observed_release_id = ?, observed_state = ?, observed_generation = ?,
            assigned_node_id = CASE WHEN desired_state = 'stopped' AND ? = 'stopped' THEN NULL ELSE assigned_node_id END,
            updated_at = ?
        WHERE project_id = ? AND assigned_node_id = ? AND generation = ? AND observed_generation <= ?`)
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
      const node = await verifyNode(id, token);
      if (Number(node.expires_at) <= Date.now() || String(node.status) === "offline") {
        throw new Error("Deployment node lease is expired.");
      }
      const count = integerRange(limit, "limit", 1, 100);
      reassignExpired();
      const now = Date.now();
      const claimed: ClaimedDeploymentOperation[] = [];
      const candidates = internal.prepare(`SELECT * FROM clank_deployment_operations
        WHERE node_id = ? AND (
          (state IN ('queued', 'retry') AND next_attempt_at <= ?)
          OR (state = 'leased' AND lease_expires_at <= ?)
        )
        ORDER BY created_at LIMIT ?`).all(id, now, now, count);
      for (const candidate of candidates) {
        const leaseToken = `clnko_${randomToken(32)}`;
        const fence = Number(candidate.fence) + 1;
        const expiresAt = now + operationLeaseMs;
        const updated = internal.prepare(`UPDATE clank_deployment_operations
          SET state = 'leased', attempts = attempts + 1, fence = ?, lease_token_hash = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND (
            (state IN ('queued', 'retry') AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_expires_at <= ?)
          )`).run(fence, await digest(leaseToken), expiresAt, now, candidate.id, now, now);
        if (Number(updated.changes) !== 1) continue;
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
    assigned_node_id TEXT REFERENCES clank_deployment_nodes(id) ON DELETE SET NULL,
    region TEXT,
    generation INTEGER NOT NULL CHECK (generation > 0),
    observed_release_id TEXT,
    observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'running', 'stopped', 'failed')),
    observed_generation INTEGER NOT NULL CHECK (observed_generation >= 0),
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_deployment_operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('reconcile', 'deploy', 'rollback', 'restart', 'stop')),
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
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_operations_ready ON clank_deployment_operations (node_id, state, next_attempt_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_deployment_operations_project ON clank_deployment_operations (project_id, created_at)");
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
  const entries = Object.entries(input);
  if (entries.length > 100) throw new TypeError("A deployment node may have at most 100 labels.");
  for (const [name, value] of entries) {
    output[safeName(name, "label name", 100)] = bounded(value, `label ${name}`, 0, 200);
  }
  return output;
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

async function safeEqual(left: string, right: string): Promise<boolean> {
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
