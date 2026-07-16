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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clank-orchestration-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  const orchestrator = openDeploymentOrchestrator(database, {
    distributedLeaseMs: 200,
    operationLeaseMs: 200,
    retryBaseMs: 10,
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
    });
    assert.equal(desired.assignedNodeId, "node-b");
    assert.equal(desired.generation, 1);
    assert.equal((await test.orchestrator.claim("node-a", nodeA.token)).length, 0);

    const [firstClaim] = await test.orchestrator.claim("node-b", nodeB.token);
    assert.equal(firstClaim.action, "reconcile");
    assert.equal(firstClaim.fence, 1);
    const retry = await test.orchestrator.fail(firstClaim, new Error("runtime temporarily unavailable"));
    assert.equal(retry.state, "retry");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const [secondClaim] = await test.orchestrator.claim("node-b", nodeB.token);
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.fence, 2);
    assert.equal(await test.orchestrator.complete(firstClaim, { stale: true }), false);
    assert.equal(await test.orchestrator.complete(secondClaim, { pid: 42 }), true);
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
      distributedLeaseMs: 200,
      operationLeaseMs: 200,
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
