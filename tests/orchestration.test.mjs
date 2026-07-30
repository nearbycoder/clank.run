import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineDatabase,
  openDeploymentOrchestrator,
  openSQLite,
} from "../dist/index.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-orchestration-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  const orchestrator = openDeploymentOrchestrator(database, {
    distributedLeaseMs: 5_000,
    retryBaseMs: 10,
    ...options,
  });
  return {
    root,
    database,
    orchestrator,
    async close() {
      orchestrator.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("distributed leases use authenticated tokens and monotonic fences", async () => {
  const test = await fixture();
  try {
    const first = await test.orchestrator.acquireLease("project:one", "control-a");
    assert.equal(first.fence, 1);
    assert.equal(await test.orchestrator.acquireLease("project:one", "control-b"), null);
    const replaced = await test.orchestrator.acquireLease("project:one", "control-a");
    assert.equal(replaced.fence, 2);
    assert.equal(await test.orchestrator.releaseLease(first), false);
    const renewed = await test.orchestrator.renewLease(replaced);
    assert.equal(renewed.fence, 2);
    assert.ok(renewed.expiresAt > replaced.expiresAt);
    assert.equal(await test.orchestrator.releaseLease(renewed), true);
  } finally {
    await test.close();
  }
});

test("operator drain and revoke controls fence credentials and recover running placements", async () => {
  const test = await fixture();
  try {
    const nodeA = await test.orchestrator.registerNode({
      id: "node-a",
      region: "us-central",
      capacity: 2,
    });
    const nodeB = await test.orchestrator.registerNode({
      id: "node-b",
      region: "us-central",
      capacity: 2,
    });
    assert.equal(test.orchestrator.setNodeDraining("node-a", true).status, "draining");
    assert.equal(test.orchestrator.setNodeDraining("node-a", false).status, "active");

    const desired = await test.orchestrator.setDesired({
      projectId: "project_failover",
      releaseId: "release-failover-1",
      state: "running",
      region: "us-central",
    });
    assert.equal(desired.assignedNodeId, "node-a");
    const [staleLease] = await test.orchestrator.claim("node-a", nodeA.token, 1);
    assert.equal(staleLease.nodeId, "node-a");

    const revoked = test.orchestrator.revokeNode("node-a");
    assert.equal(revoked.status, "offline");
    assert.equal(test.orchestrator.desired("project_failover").assignedNodeId, "node-b");
    await assert.rejects(
      test.orchestrator.authenticateNode("node-a", nodeA.token),
      /authentication failed/,
    );
    assert.equal((await test.orchestrator.claim("node-b", nodeB.token, 1)).length, 0);
    const internal = test.database[SQLITE_INTERNAL];
    internal.prepare(`UPDATE clank_deployment_operations
      SET lease_expires_at = 0 WHERE id = ? AND fence = ?`)
      .run(staleLease.id, staleLease.fence);
    const [recovered] = await test.orchestrator.claim("node-b", nodeB.token, 1);
    assert.equal(recovered.id, staleLease.id);
    assert.equal(recovered.nodeId, "node-b");
    assert.equal(recovered.fence, staleLease.fence + 1);
    assert.equal(await test.orchestrator.complete(staleLease), false);

    test.orchestrator.revokeNode("node-b");
    const unassigned = await test.orchestrator.setDesired({
      projectId: "project_waiting_for_capacity",
      releaseId: "release-waiting-1",
      state: "running",
      region: "us-central",
    });
    assert.equal(unassigned.assignedNodeId, null);
    const nodeC = await test.orchestrator.registerNode({
      id: "node-c",
      region: "us-central",
      capacity: 2,
    });
    const claimed = await test.orchestrator.claim("node-c", nodeC.token, 10);
    assert.equal(
      claimed.some((operation) => operation.projectId === "project_waiting_for_capacity"),
      true,
    );
    assert.equal(
      test.orchestrator.desired("project_waiting_for_capacity").assignedNodeId,
      "node-c",
    );
  } finally {
    await test.close();
  }
});

test("stateful placements pin one node identity across generations, stops, and node loss", async () => {
  const test = await fixture();
  try {
    const nodeA = await test.orchestrator.registerNode({
      id: "node-stateful-a",
      region: "us-central",
      capacity: 2,
    });
    const nodeB = await test.orchestrator.registerNode({
      id: "node-stateful-b",
      region: "us-central",
      capacity: 2,
    });
    const first = await test.orchestrator.setDesired({
      projectId: "project_stateful",
      releaseId: "release-stateful-1",
      state: "running",
      region: "us-central",
      placementMode: "stateful",
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(first.placementMode, "stateful");
    assert.equal(first.assignedNodeId, "node-stateful-a");

    const second = await test.orchestrator.setDesired({
      projectId: "project_stateful",
      releaseId: "release-stateful-2",
      state: "running",
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(second.assignedNodeId, first.assignedNodeId);
    assert.equal(second.placementMode, "stateful");

    test.orchestrator.revokeNode("node-stateful-a");
    assert.equal(test.orchestrator.desired("project_stateful").assignedNodeId, "node-stateful-a");
    assert.equal((await test.orchestrator.claim("node-stateful-b", nodeB.token)).length, 0);

    const recoveredNodeA = await test.orchestrator.registerNode({
      id: "node-stateful-a",
      region: "us-central",
      capacity: 2,
    });
    const claims = await test.orchestrator.claim("node-stateful-a", recoveredNodeA.token);
    assert.equal(claims.length, 2);
    assert.equal(claims.every((operation) => operation.projectId === "project_stateful"), true);

    const stopped = await test.orchestrator.setDesired({
      projectId: "project_stateful",
      releaseId: null,
      state: "stopped",
    });
    assert.equal(stopped.assignedNodeId, "node-stateful-a");
    assert.equal(await test.orchestrator.observe("node-stateful-a", recoveredNodeA.token, {
      projectId: "project_stateful",
      generation: stopped.generation,
      releaseId: null,
      state: "stopped",
    }), true);
    assert.equal(test.orchestrator.desired("project_stateful").assignedNodeId, "node-stateful-a");

    const restarted = await test.orchestrator.setDesired({
      projectId: "project_stateful",
      releaseId: "release-stateful-3",
      state: "running",
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(restarted.assignedNodeId, "node-stateful-a");
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_stateful",
        releaseId: "release-stateful-4",
        state: "running",
        placementMode: "portable",
      }),
      /placementMode cannot change/u,
    );
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_stateful",
        releaseId: "release-stateful-4",
        state: "running",
        region: "us-east",
      }),
      /region cannot change/u,
    );
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_stateful",
        releaseId: "release-stateful-4",
        state: "running",
        capacityUnits: 3,
      }),
      /does not have enough process capacity/u,
    );
    assert.equal(test.orchestrator.desired("project_stateful").capacityUnits, 1);
    assert.equal((await test.orchestrator.authenticateNode("node-stateful-a", recoveredNodeA.token)).id, "node-stateful-a");
    await assert.rejects(
      test.orchestrator.authenticateNode("node-stateful-a", nodeA.token),
      /authentication failed/u,
    );
    await assert.rejects(
      test.orchestrator.registerNode({
        id: "node-stateful-a",
        region: "us-east",
        capacity: 2,
      }),
      /cannot re-register in another region/u,
    );
  } finally {
    await test.close();
  }
});

test("an initially unassigned stateful placement binds once when capacity appears", async () => {
  const test = await fixture();
  try {
    const desired = await test.orchestrator.setDesired({
      projectId: "project_stateful_waiting",
      releaseId: "release-stateful-waiting",
      state: "running",
      region: "us-central",
      placementMode: "stateful",
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(desired.assignedNodeId, null);

    const node = await test.orchestrator.registerNode({
      id: "node-stateful-first",
      region: "us-central",
      capacity: 1,
    });
    const [claim] = await test.orchestrator.claim(node.node.id, node.token);
    assert.equal(claim.projectId, "project_stateful_waiting");
    assert.equal(
      test.orchestrator.desired("project_stateful_waiting").assignedNodeId,
      "node-stateful-first",
    );
  } finally {
    await test.close();
  }
});

test("placement uses process capacity units and portable failover waits for sufficient capacity", async () => {
  const test = await fixture();
  try {
    const nodeA = await test.orchestrator.registerNode({
      id: "node-capacity-a",
      region: "us-central",
      capacity: 4,
    });
    const nodeB = await test.orchestrator.registerNode({
      id: "node-capacity-b",
      region: "us-central",
      capacity: 2,
    });
    const desired = await test.orchestrator.setDesired({
      projectId: "project_capacity",
      releaseId: "release-capacity-1",
      state: "running",
      capacityUnits: 3,
    });
    assert.equal(desired.assignedNodeId, "node-capacity-a");
    assert.equal(desired.capacityUnits, 3);

    const second = await test.orchestrator.setDesired({
      projectId: "project_capacity_second",
      releaseId: "release-capacity-2",
      state: "running",
      capacityUnits: 2,
    });
    assert.equal(second.assignedNodeId, "node-capacity-b");
    await assert.rejects(
      test.orchestrator.heartbeat(nodeB.node.id, nodeB.token, { capacity: 1 }),
      /cannot reduce capacity below the process slots reserved/u,
    );
    await assert.rejects(
      test.orchestrator.registerNode({
        id: nodeA.node.id,
        region: "us-central",
        capacity: 2,
      }),
      /cannot reduce capacity below the process slots reserved/u,
    );

    test.orchestrator.revokeNode(nodeA.node.id);
    assert.equal(test.orchestrator.desired("project_capacity").assignedNodeId, null);
    assert.equal((await test.orchestrator.claim(nodeB.node.id, nodeB.token)).some(
      (operation) => operation.projectId === "project_capacity",
    ), false);

    const nodeC = await test.orchestrator.registerNode({
      id: "node-capacity-c",
      region: "us-central",
      capacity: 3,
    });
    const claims = await test.orchestrator.claim(nodeC.node.id, nodeC.token, 10);
    assert.equal(claims.some((operation) => operation.projectId === "project_capacity"), true);
    assert.equal(
      test.orchestrator.desired("project_capacity").assignedNodeId,
      "node-capacity-c",
    );
  } finally {
    await test.close();
  }
});

test("durable node requirements select capable nodes and cannot be shed while assigned", async () => {
  const test = await fixture();
  try {
    const artifactNode = await test.orchestrator.registerNode({
      id: "node-artifact-only",
      region: "us-central",
      capacity: 2,
      labels: { provider: "artifact" },
    });
    const providerNode = await test.orchestrator.registerNode({
      id: "node-provider",
      region: "us-central",
      endpoint: "https://provider.internal.example",
      capacity: 2,
      labels: { isolation: "docker", provider: "http" },
    });
    const desired = await test.orchestrator.setDesired({
      projectId: "project_capabilities",
      releaseId: "release-capabilities-1",
      state: "running",
      region: "us-central",
      placementMode: "stateful",
      nodeRequirements: {
        endpoint: true,
        labels: { provider: "http", isolation: "docker" },
      },
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(desired.assignedNodeId, "node-provider");
    assert.deepEqual(desired.nodeRequirements, {
      endpoint: true,
      labels: { isolation: "docker", provider: "http" },
    });
    assert.equal((await test.orchestrator.claim(artifactNode.node.id, artifactNode.token)).length, 0);

    await assert.rejects(
      test.orchestrator.heartbeat(providerNode.node.id, providerNode.token, {
        labels: { isolation: "docker" },
      }),
      /cannot remove a capability/u,
    );
    await assert.rejects(
      test.orchestrator.registerNode({
        id: "node-provider",
        region: "us-central",
        capacity: 2,
        labels: { isolation: "docker", provider: "http" },
      }),
      /cannot remove a capability/u,
    );
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_capabilities",
        releaseId: "release-capabilities-2",
        state: "running",
        nodeRequirements: { endpoint: true, labels: { provider: "http" } },
      }),
      /nodeRequirements cannot change/u,
    );

    const [claim] = await test.orchestrator.claim(providerNode.node.id, providerNode.token);
    assert.equal(claim.projectId, "project_capabilities");
  } finally {
    await test.close();
  }
});

test("queued placement requirements remain enforced when matching capacity appears", async () => {
  const test = await fixture();
  try {
    const desired = await test.orchestrator.setDesired({
      projectId: "project_waiting_for_provider",
      releaseId: "release-waiting-for-provider",
      state: "running",
      placementMode: "stateful",
      nodeRequirements: { endpoint: true, labels: { provider: "http" } },
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(desired.assignedNodeId, null);

    const wrong = await test.orchestrator.registerNode({
      id: "node-wrong-capability",
      region: "us-central",
      endpoint: "https://wrong.internal.example",
      labels: { provider: "artifact" },
    });
    assert.equal((await test.orchestrator.claim(wrong.node.id, wrong.token)).length, 0);
    assert.equal(test.orchestrator.desired("project_waiting_for_provider").assignedNodeId, null);

    const right = await test.orchestrator.registerNode({
      id: "node-right-capability",
      region: "us-central",
      endpoint: "https://right.internal.example",
      labels: { provider: "http" },
    });
    const [claim] = await test.orchestrator.claim(right.node.id, right.token);
    assert.equal(claim.projectId, "project_waiting_for_provider");
    assert.equal(
      test.orchestrator.desired("project_waiting_for_provider").assignedNodeId,
      "node-right-capability",
    );
  } finally {
    await test.close();
  }
});

test("node placement, desired generations, operation retries, and stale-worker fencing are durable", async () => {
  const test = await fixture();
  try {
    const nodeA = await test.orchestrator.registerNode({
      id: "node-a",
      region: "us-central",
      capacity: 2,
      labels: { runtime: "node24" },
    });
    const nodeB = await test.orchestrator.registerNode({
      id: "node-b",
      region: "us-central",
      capacity: 2,
    });
    await test.orchestrator.drainNode(nodeA.node.id, nodeA.token);
    const desired = await test.orchestrator.setDesired({
      projectId: "project_one",
      releaseId: "release-1",
      state: "running",
      region: "us-central",
      runtimeProtocol: "clank-runtime/1",
    });
    assert.equal(desired.assignedNodeId, "node-b");
    assert.equal(desired.placementMode, "portable");
    assert.deepEqual(desired.nodeRequirements, { endpoint: false, labels: {} });
    assert.equal(desired.generation, 1);
    assert.equal((await test.orchestrator.claim("node-a", nodeA.token)).length, 0);

    const [firstClaim] = await test.orchestrator.claim("node-b", nodeB.token);
    assert.equal(firstClaim.action, "reconcile");
    assert.equal(firstClaim.payload.runtimeProtocol, "clank-runtime/1");
    assert.equal(firstClaim.fence, 1);
    assert.equal((await test.orchestrator.authenticateOperation(firstClaim)).id, firstClaim.id);
    const retry = await test.orchestrator.fail(firstClaim, new Error("runtime temporarily unavailable"));
    assert.equal(retry.state, "retry");
    assert.equal(await test.orchestrator.authenticateOperation(firstClaim), null);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const [secondClaim] = await test.orchestrator.claim("node-b", nodeB.token);
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.fence, 2);
    assert.equal(await test.orchestrator.authenticateOperation(firstClaim), null);
    assert.equal((await test.orchestrator.authenticateOperation(secondClaim)).fence, 2);
    assert.equal(await test.orchestrator.complete(firstClaim, { stale: true }), false);
    assert.equal(await test.orchestrator.complete(secondClaim, { pid: 42 }), true);
    assert.equal(await test.orchestrator.authenticateOperation(secondClaim), null);
    assert.equal(test.orchestrator.operation(secondClaim.id).state, "succeeded");

    assert.equal(await test.orchestrator.observe("node-b", nodeB.token, {
      projectId: "project_one",
      generation: desired.generation,
      releaseId: "release-1",
      state: "running",
    }), true);
    assert.equal(test.orchestrator.desired("project_one").observedState, "running");
    assert.equal(await test.orchestrator.observe("node-b", nodeB.token, {
      projectId: "project_one",
      generation: 0,
      releaseId: "older",
      state: "failed",
    }), false);

    const direct = await test.orchestrator.enqueue({
      projectId: "project_one",
      action: "restart",
      idempotencyKey: "restart-project-one-0001",
      nodeId: "node-b",
    });
    const duplicate = await test.orchestrator.enqueue({
      projectId: "project_one",
      action: "restart",
      idempotencyKey: "restart-project-one-0001",
      nodeId: "node-b",
    });
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.operation.id, direct.operation.id);

    test.orchestrator.close();
    const reopened = openDeploymentOrchestrator(test.database, {
      distributedLeaseMs: 5_000,
      retryBaseMs: 10,
    });
    assert.equal(reopened.operation(direct.operation.id).state, "queued");
    reopened.close();
    await assert.rejects(
      test.orchestrator.heartbeat("node-b", "clnka_invalid"),
      /closed/,
    );
  } finally {
    test.database.close();
    await rm(test.root, { recursive: true, force: true });
  }
});

test("operation fences increase across every operation for the same project", async () => {
  const test = await fixture();
  try {
    const node = await test.orchestrator.registerNode({
      id: "node-project-fences",
      region: "us-central",
      capacity: 4,
    });
    const first = await test.orchestrator.enqueue({
      projectId: "project_fenced",
      action: "deploy",
      idempotencyKey: "project-fenced-deploy-0001",
      nodeId: node.node.id,
    });
    const second = await test.orchestrator.enqueue({
      projectId: "project_fenced",
      action: "restart",
      idempotencyKey: "project-fenced-restart-0002",
      nodeId: node.node.id,
    });
    const other = await test.orchestrator.enqueue({
      projectId: "project_other",
      action: "deploy",
      idempotencyKey: "project-other-deploy-0001",
      nodeId: node.node.id,
    });

    const claims = await test.orchestrator.claim(node.node.id, node.token, 3);
    const firstClaim = claims.find((operation) => operation.id === first.operation.id);
    const secondClaim = claims.find((operation) => operation.id === second.operation.id);
    const otherClaim = claims.find((operation) => operation.id === other.operation.id);
    assert.equal(firstClaim.fence, 1);
    assert.equal(secondClaim.fence, 2);
    assert.equal(otherClaim.fence, 1);

    const internal = test.database[SQLITE_INTERNAL];
    internal.prepare(`UPDATE clank_deployment_operations
      SET lease_expires_at = 0 WHERE id = ? AND fence = ?`)
      .run(firstClaim.id, firstClaim.fence);
    const [reclaimed] = await test.orchestrator.claim(node.node.id, node.token, 1);
    assert.equal(reclaimed.id, firstClaim.id);
    assert.equal(reclaimed.fence, 3);
    assert.equal(await test.orchestrator.complete(firstClaim), false);
    assert.equal(await test.orchestrator.complete(reclaimed), true);

    test.orchestrator.close();
    const reopened = openDeploymentOrchestrator(test.database, {
      distributedLeaseMs: 5_000,
      retryBaseMs: 10,
    });
    const third = await reopened.enqueue({
      projectId: "project_fenced",
      action: "stop",
      idempotencyKey: "project-fenced-stop-0003",
      nodeId: node.node.id,
    });
    const [thirdClaim] = await reopened.claim(node.node.id, node.token, 1);
    assert.equal(thirdClaim.id, third.operation.id);
    assert.equal(thirdClaim.fence, 4);
    reopened.close();
  } finally {
    test.database.close();
    await rm(test.root, { recursive: true, force: true });
  }
});

test("existing operation fences seed the durable per-project sequence", async () => {
  const test = await fixture();
  try {
    const node = await test.orchestrator.registerNode({
      id: "node-fence-migration",
      region: "us-central",
    });
    const existing = await test.orchestrator.enqueue({
      projectId: "project_fence_migration",
      action: "deploy",
      idempotencyKey: "project-fence-migration-existing",
      nodeId: node.node.id,
    });
    const internal = test.database[SQLITE_INTERNAL];
    internal.prepare(`UPDATE clank_deployment_operations
      SET state = 'succeeded', fence = 9, result = '{}'
      WHERE id = ?`).run(existing.operation.id);
    test.orchestrator.close();
    internal.exec("DROP TABLE clank_deployment_project_fences");

    const reopened = openDeploymentOrchestrator(test.database);
    const next = await reopened.enqueue({
      projectId: "project_fence_migration",
      action: "restart",
      idempotencyKey: "project-fence-migration-next",
      nodeId: node.node.id,
    });
    const [claim] = await reopened.claim(node.node.id, node.token, 1);
    assert.equal(claim.id, next.operation.id);
    assert.equal(claim.fence, 10);
    reopened.close();
  } finally {
    test.database.close();
    await rm(test.root, { recursive: true, force: true });
  }
});

test("operation action migration preserves history and enables provider deletion", async () => {
  const test = await fixture();
  try {
    const node = await test.orchestrator.registerNode({
      id: "node-operation-migration",
      region: "us-central",
    });
    test.orchestrator.close();
    const internal = test.database[SQLITE_INTERNAL];
    internal.exec("DROP TABLE clank_deployment_operations");
    internal.exec(`CREATE TABLE clank_deployment_operations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (
        action IN ('reconcile', 'deploy', 'rollback', 'restart', 'stop')
      ),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      state TEXT NOT NULL CHECK (
        state IN ('queued', 'leased', 'retry', 'succeeded', 'failed', 'cancelled')
      ),
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
    internal.prepare(`INSERT INTO clank_deployment_operations
      (id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
       lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
       created_at, updated_at)
      VALUES ('op_legacy_stop', 'project_operation_migration', 'stop', '{}', 'succeeded',
        NULL, 1, 3, 6, NULL, NULL, 1, 'legacy-stop-operation', '{}', NULL, 1, 1)`)
      .run();

    const reopened = openDeploymentOrchestrator(test.database);
    assert.equal(reopened.operation("op_legacy_stop").action, "stop");
    const deletion = await reopened.enqueue({
      projectId: "project_operation_migration",
      action: "delete",
      payload: { generation: 4 },
      idempotencyKey: "provider-delete-operation",
      nodeId: node.node.id,
    });
    const [claim] = await reopened.claim(node.node.id, node.token, 1);
    assert.equal(claim.id, deletion.operation.id);
    assert.equal(claim.action, "delete");
    assert.deepEqual(claim.payload, { generation: 4 });
    assert.equal(claim.fence, 7);
    reopened.close();
  } finally {
    test.database.close();
    await rm(test.root, { recursive: true, force: true });
  }
});

test("desired deployment validation rejects inconsistent release and runtime state before persistence", async () => {
  const test = await fixture();
  try {
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_invalid_running",
        releaseId: null,
        state: "running",
      }),
      /requires a releaseId/u,
    );
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_invalid_stopped",
        releaseId: "release_not_allowed",
        state: "stopped",
      }),
      /cannot select a releaseId/u,
    );
    await assert.rejects(
      test.orchestrator.setDesired({
        projectId: "project_invalid_runtime",
        releaseId: "release_invalid_runtime",
        state: "running",
        runtimeProtocol: "clank-runtime/2",
      }),
      /runtimeProtocol is unsupported/u,
    );
    assert.equal(test.orchestrator.desired("project_invalid_running"), null);
    assert.equal(test.orchestrator.desired("project_invalid_stopped"), null);
    assert.equal(test.orchestrator.desired("project_invalid_runtime"), null);
  } finally {
    await test.close();
  }
});

test("legacy placement rows migrate to portable mode without losing desired state", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-orchestration-migration-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  try {
    const internal = database[SQLITE_INTERNAL];
    internal.exec(`CREATE TABLE clank_deployment_placements (
      project_id TEXT PRIMARY KEY,
      desired_release_id TEXT,
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
      assigned_node_id TEXT,
      region TEXT,
      generation INTEGER NOT NULL CHECK (generation > 0),
      observed_release_id TEXT,
      observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'running', 'stopped', 'failed')),
      observed_generation INTEGER NOT NULL CHECK (observed_generation >= 0),
      updated_at INTEGER NOT NULL
    )`);
    internal.prepare(`INSERT INTO clank_deployment_placements
      (project_id, desired_release_id, desired_state, assigned_node_id, region, generation,
       observed_release_id, observed_state, observed_generation, updated_at)
      VALUES ('legacy_project', 'legacy_release', 'running', NULL, 'us-central', 7,
        NULL, 'unknown', 0, 1)`).run();

    const orchestrator = openDeploymentOrchestrator(database);
    assert.deepEqual(orchestrator.desired("legacy_project"), {
      projectId: "legacy_project",
      desiredReleaseId: "legacy_release",
      desiredState: "running",
      placementMode: "portable",
      capacityUnits: 1,
      nodeRequirements: { endpoint: false, labels: {} },
      assignedNodeId: null,
      generation: 7,
      observedReleaseId: null,
      observedState: "unknown",
      observedGeneration: 0,
      updatedAt: 1,
    });
    orchestrator.close();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
