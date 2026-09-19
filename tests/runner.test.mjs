import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeploymentCoordinatorClient,
  createDeploymentCoordinatorHandler,
  defineDatabase,
  DeploymentCoordinatorError,
  fileDeploymentNodeCredentials,
  memoryDeploymentNodeCredentials,
  openDeploymentAgent,
  openDeploymentOrchestrator,
  openPlatform,
  openSQLite,
} from "../dist/index.js";

const registrationToken = "clank_runner_enrollment_test_token_1234567890";

async function fixture(orchestration = {}, coordinator = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-runner-coordinator-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  const orchestrator = openDeploymentOrchestrator(database, {
    nodeTtlMs: 5_000,
    operationLeaseMs: 5_000,
    retryBaseMs: 10,
    ...orchestration,
  });
  const privateErrors = [];
  const handler = createDeploymentCoordinatorHandler(orchestrator, {
    registrationToken,
    maxRequestBytes: 8 * 1024,
    onError: (error) => privateErrors.push(error),
    ...coordinator,
  });
  const fetcher = (url, init) => handler.handle(new Request(url, init));
  const client = createDeploymentCoordinatorClient({
    baseUrl: "http://127.0.0.1:4200",
    fetch: fetcher,
    timeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
  });
  return {
    root,
    database,
    orchestrator,
    handler,
    client,
    privateErrors,
    async close() {
      orchestrator.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(check, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
}

test("authenticated deployment nodes coordinate placement and fenced operations over HTTP", async () => {
  const test = await fixture();
  try {
    await assert.rejects(
      test.client.register("wrong_runner_enrollment_test_token_1234567890", {
        id: "runner-west-01",
        region: "us-west",
      }),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 401
        && error.code === "REGISTRATION_DENIED",
    );

    const session = await test.client.register(registrationToken, {
      id: "runner-west-01",
      region: "us-west",
      endpoint: "https://runner-west.internal.example",
      capacity: 2,
      labels: { isolation: "docker", architecture: "amd64" },
    });
    assert.match(session.token, /^clnka_/u);
    assert.equal(session.node.status, "active");
    assert.deepEqual(session.node.labels, {
      isolation: "docker",
      architecture: "amd64",
    });

    const authenticated = await test.client.authenticate(session.node.id, session.token);
    assert.equal(authenticated.id, session.node.id);
    await assert.rejects(
      test.client.authenticate(
        session.node.id,
        "clnka_invalid_node_token_that_is_long_enough_123456",
      ),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 401
        && error.code === "NODE_AUTH_FAILED",
    );

    const desired = await test.orchestrator.setDesired({
      projectId: "project_remote_one",
      releaseId: "release-remote-1",
      state: "running",
      region: "us-west",
    });
    assert.equal(desired.assignedNodeId, session.node.id);

    const [claimed] = await test.client.claim(session.node.id, session.token, 1);
    assert.equal(claimed.projectId, "project_remote_one");
    assert.equal(claimed.fence, 1);
    const otherSession = await test.client.register(registrationToken, {
      id: "runner-west-02",
      region: "us-west",
    });
    await assert.rejects(
      test.client.complete(otherSession.node.id, otherSession.token, claimed),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 403
        && error.code === "NODE_SCOPE_DENIED",
    );
    const renewed = await test.client.renew(session.node.id, session.token, claimed);
    assert.equal(renewed.id, claimed.id);
    assert.ok(renewed.leaseExpiresAt >= claimed.leaseExpiresAt);
    assert.equal(await test.client.complete(session.node.id, session.token, renewed, {
      runtime: "container-01",
    }), true);
    assert.equal(await test.client.complete(session.node.id, session.token, renewed), false);

    const deletion = await test.orchestrator.enqueue({
      projectId: "project_remote_one",
      action: "delete",
      payload: { generation: desired.generation },
      idempotencyKey: "remote-provider-delete",
      nodeId: session.node.id,
    });
    const [deleteClaim] = await test.client.claim(session.node.id, session.token, 1);
    assert.equal(deleteClaim.id, deletion.operation.id);
    assert.equal(deleteClaim.action, "delete");
    assert.deepEqual(deleteClaim.payload, { generation: desired.generation });
    assert.equal(deleteClaim.fence, 2);
    assert.equal(
      await test.client.complete(session.node.id, session.token, deleteClaim),
      true,
    );

    assert.equal(await test.client.observe(session.node.id, session.token, {
      projectId: desired.projectId,
      generation: desired.generation,
      releaseId: desired.desiredReleaseId,
      state: "running",
    }), true);
    assert.equal(test.orchestrator.desired(desired.projectId).observedState, "running");

    const draining = await test.client.drain(session.node.id, session.token);
    assert.equal(draining.status, "draining");
    const queuedWhileDraining = await test.orchestrator.enqueue({
      projectId: "project_draining",
      action: "deploy",
      idempotencyKey: "draining-node-must-not-claim",
      nodeId: session.node.id,
    });
    assert.equal((await test.client.claim(session.node.id, session.token, 1)).length, 0);
    assert.equal(test.orchestrator.operation(queuedWhileDraining.operation.id).state, "queued");
    const heartbeat = await test.client.heartbeat(session.node.id, session.token, {
      capacity: 3,
      labels: { isolation: "docker" },
    });
    assert.equal(heartbeat.capacity, 3);
    assert.equal(heartbeat.status, "draining");
    assert.equal(test.privateErrors.length, 0);
  } finally {
    await test.close();
  }
});

test("one-time deployment enrollment authorization commits or rolls back transactionally", async () => {
  const events = [];
  const test = await fixture({}, {
    registrationToken: undefined,
    async authorizeRegistration(request) {
      events.push(["authorize", request.token, request.node.id, Object.isFrozen(request.node)]);
      if (request.token === "clnke_denied_token_12345678901234567890") return null;
      return {
        async commit() {
          events.push(["commit", request.node.id]);
          if (request.token === "clnke_commit_failure_12345678901234567890") {
            throw new Error("commit failed");
          }
        },
        async rollback() {
          events.push(["rollback", request.node.id]);
        },
      };
    },
  });
  try {
    await assert.rejects(
      test.client.register("clnke_denied_token_12345678901234567890", {
        id: "runner-denied",
        region: "local",
      }),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 401
        && error.code === "REGISTRATION_DENIED",
    );

    const session = await test.client.register("clnke_allowed_token_12345678901234567890", {
      id: "runner-managed",
      region: "local",
    });
    assert.match(session.token, /^clnka_/u);
    assert.deepEqual(events.slice(-2), [
      ["authorize", "clnke_allowed_token_12345678901234567890", "runner-managed", true],
      ["commit", "runner-managed"],
    ]);

    await assert.rejects(
      test.client.register("clnke_invalid_node_12345678901234567890", {
        id: "runner-invalid",
        region: "local",
        endpoint: "http://public.example",
      }),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 422
        && error.code === "INVALID_INPUT"
        && !error.message.includes("public.example"),
    );
    assert.deepEqual(events.slice(-2), [
      ["authorize", "clnke_invalid_node_12345678901234567890", "runner-invalid", true],
      ["rollback", "runner-invalid"],
    ]);

    await assert.rejects(
      test.client.register("clnke_commit_failure_12345678901234567890", {
        id: "runner-commit-failure",
        region: "local",
      }),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 500
        && !error.message.includes("commit failed"),
    );
    assert.deepEqual(events.slice(-3), [
      ["authorize", "clnke_commit_failure_12345678901234567890", "runner-commit-failure", true],
      ["commit", "runner-commit-failure"],
      ["rollback", "runner-commit-failure"],
    ]);
    assert.equal(test.privateErrors.length, 1);
  } finally {
    await test.close();
  }
});

test("release artifacts require the exact authenticated operation lease and verify content", async () => {
  const bytes = new TextEncoder().encode("content-addressed-clank-release");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let providerRequest;
  const test = await fixture({}, {
    artifact: {
      async load(request) {
        providerRequest = request;
        return { bytes, sha256: digest };
      },
    },
  });
  try {
    const session = await test.client.register(registrationToken, {
      id: "runner-artifact-01",
      region: "local",
    });
    await test.orchestrator.setDesired({
      projectId: "project_artifact",
      releaseId: "release-artifact-1",
      state: "running",
      region: "local",
    });
    const [operation] = await test.client.claim(session.node.id, session.token, 1);
    const artifact = await test.client.artifact(session.node.id, session.token, {
      ...operation,
      payload: { releaseId: "attacker-selected-release" },
    });
    assert.deepEqual(artifact.bytes, bytes);
    assert.equal(artifact.sha256, digest);
    assert.equal(providerRequest.operation.id, operation.id);
    assert.equal(providerRequest.operation.payload.releaseId, "release-artifact-1");
    assert.equal("leaseToken" in providerRequest.operation, false);
    assert.equal(Object.isFrozen(providerRequest.operation), true);
    assert.equal(providerRequest.signal.aborted, false);

    const other = await test.client.register(registrationToken, {
      id: "runner-artifact-02",
      region: "local",
    });
    await assert.rejects(
      test.client.artifact(other.node.id, other.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 403
        && error.code === "NODE_SCOPE_DENIED",
    );

    assert.equal(await test.client.complete(session.node.id, session.token, operation), true);
    await assert.rejects(
      test.client.artifact(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 409
        && error.code === "STALE_OPERATION",
    );
    assert.equal(test.privateErrors.length, 0);
  } finally {
    await test.close();
  }
});

test("artifact transport fails closed on provider and response integrity errors", async () => {
  const bytes = new TextEncoder().encode("tampered-release");
  const badDigest = "0".repeat(64);
  const providerTest = await fixture({}, {
    artifact: {
      async load() {
        return { bytes, sha256: badDigest };
      },
    },
  });
  try {
    const session = await providerTest.client.register(registrationToken, {
      id: "runner-bad-artifact-01",
      region: "local",
    });
    const queued = await providerTest.orchestrator.enqueue({
      projectId: "project_bad_artifact",
      action: "deploy",
      idempotencyKey: "bad-artifact-provider",
      nodeId: session.node.id,
    });
    const [operation] = await providerTest.client.claim(session.node.id, session.token, 1);
    assert.equal(operation.id, queued.operation.id);
    await assert.rejects(
      providerTest.client.artifact(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 500
        && error.code === "COORDINATOR_FAILED",
    );
    assert.match(String(providerTest.privateErrors[0]), /digest mismatch/u);
  } finally {
    await providerTest.close();
  }

  const operation = {
    id: "op_artifact_client",
    projectId: "project_artifact_client",
    action: "deploy",
    state: "leased",
    payload: null,
    nodeId: "runner-artifact-client",
    attempts: 1,
    maxAttempts: 10,
    fence: 1,
    nextAttemptAt: Date.now(),
    leaseExpiresAt: Date.now() + 10_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseToken: "clnko_artifact_client_123456789012345678901234",
  };
  const integrityClient = createDeploymentCoordinatorClient({
    baseUrl: "http://127.0.0.1:4200",
    maxArtifactBytes: 1_024,
    fetch: async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/vnd.clank.deploy+gzip",
        "x-clank-content-sha256": badDigest,
      },
    }),
  });
  await assert.rejects(
    integrityClient.artifact(
      operation.nodeId,
      "clnka_artifact_client_123456789012345678901234",
      operation,
    ),
    (error) => error instanceof DeploymentCoordinatorError
      && error.status === 502
      && error.code === "ARTIFACT_INTEGRITY_FAILED",
  );

  const oversized = new Uint8Array(1_025);
  const boundedClient = createDeploymentCoordinatorClient({
    baseUrl: "http://127.0.0.1:4200",
    maxArtifactBytes: 1_024,
    fetch: async () => new Response(oversized, {
      status: 200,
      headers: {
        "content-length": "1",
        "content-type": "application/vnd.clank.deploy+gzip",
        "x-clank-content-sha256": createHash("sha256").update(oversized).digest("hex"),
      },
    }),
  });
  await assert.rejects(
    boundedClient.artifact(
      operation.nodeId,
      "clnka_artifact_client_123456789012345678901234",
      operation,
    ),
    (error) => error instanceof DeploymentCoordinatorError
      && error.status === 502
      && error.code === "ARTIFACT_TOO_LARGE",
  );
});

test("artifact providers cannot exceed the coordinator transfer bound", async () => {
  const bytes = new Uint8Array(1_025);
  const test = await fixture({}, {
    maxArtifactBytes: 1_024,
    artifact: {
      async load() {
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
  });
  try {
    const session = await test.client.register(registrationToken, {
      id: "runner-large-artifact-01",
      region: "local",
    });
    await test.orchestrator.enqueue({
      projectId: "project_large_artifact",
      action: "deploy",
      idempotencyKey: "large-artifact-provider",
      nodeId: session.node.id,
    });
    const [operation] = await test.client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      test.client.artifact(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 413
        && error.code === "ARTIFACT_TOO_LARGE",
    );
  } finally {
    await test.close();
  }
});

test("artifact transfer rechecks the operation lease after provider work", async () => {
  const bytes = new TextEncoder().encode("slow-artifact-provider");
  const test = await fixture({ operationLeaseMs: 100 }, {
    artifact: {
      async load() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
  });
  try {
    const session = await test.client.register(registrationToken, {
      id: "runner-expired-artifact-01",
      region: "local",
    });
    await test.orchestrator.enqueue({
      projectId: "project_expired_artifact",
      action: "deploy",
      idempotencyKey: "expired-artifact-provider",
      nodeId: session.node.id,
    });
    const [operation] = await test.client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      test.client.artifact(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 409
        && error.code === "STALE_OPERATION",
    );
  } finally {
    await test.close();
  }
});

test("runtime capsules require the exact authenticated operation lease and are never cacheable", async () => {
  const bytes = new TextEncoder().encode("sensitive-runtime-capsule");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let providerRequest;
  const test = await fixture({}, {
    runtime: {
      async load(request) {
        providerRequest = request;
        return { bytes, sha256: digest };
      },
    },
  });
  try {
    const session = await test.client.register(registrationToken, {
      id: "runner-runtime-01",
      region: "local",
    });
    await test.orchestrator.setDesired({
      projectId: "project_runtime",
      releaseId: "release-runtime-1",
      state: "running",
      region: "local",
      runtimeProtocol: "clank-runtime/1",
    });
    const [operation] = await test.client.claim(session.node.id, session.token, 1);
    const runtime = await test.client.runtime(session.node.id, session.token, {
      ...operation,
      payload: { releaseId: "attacker-selected-release" },
    });
    assert.deepEqual(runtime.bytes, bytes);
    assert.equal(runtime.sha256, digest);
    assert.equal(providerRequest.operation.id, operation.id);
    assert.equal(providerRequest.operation.payload.releaseId, "release-runtime-1");
    assert.equal(providerRequest.operation.payload.runtimeProtocol, "clank-runtime/1");
    assert.equal("leaseToken" in providerRequest.operation, false);
    assert.equal(Object.isFrozen(providerRequest.operation), true);
    assert.equal(providerRequest.signal.aborted, false);

    const direct = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/runtime",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
          "x-clank-node-id": session.node.id,
        },
        body: JSON.stringify({ operation }),
      },
    ));
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("cache-control"), "private, no-store");
    assert.equal(direct.headers.get("content-type"), "application/vnd.clank.runtime");
    assert.equal(direct.headers.get("x-clank-content-sha256"), digest);

    const other = await test.client.register(registrationToken, {
      id: "runner-runtime-02",
      region: "local",
    });
    await assert.rejects(
      test.client.runtime(other.node.id, other.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 403
        && error.code === "NODE_SCOPE_DENIED",
    );

    assert.equal(await test.client.complete(session.node.id, session.token, operation), true);
    await assert.rejects(
      test.client.runtime(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 409
        && error.code === "STALE_OPERATION",
    );
    assert.equal(test.privateErrors.length, 0);
  } finally {
    await test.close();
  }
});

test("runtime transport fails closed on provider, response integrity, and size errors", async () => {
  const bytes = new TextEncoder().encode("tampered-runtime");
  const badDigest = "0".repeat(64);
  const providerTest = await fixture({}, {
    runtime: {
      async load() {
        return { bytes, sha256: badDigest };
      },
    },
  });
  try {
    const session = await providerTest.client.register(registrationToken, {
      id: "runner-bad-runtime-01",
      region: "local",
    });
    await providerTest.orchestrator.enqueue({
      projectId: "project_bad_runtime",
      action: "deploy",
      idempotencyKey: "bad-runtime-provider",
      nodeId: session.node.id,
    });
    const [operation] = await providerTest.client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      providerTest.client.runtime(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 500
        && error.code === "COORDINATOR_FAILED",
    );
    assert.match(String(providerTest.privateErrors[0]), /digest mismatch/u);
  } finally {
    await providerTest.close();
  }

  const operation = {
    id: "op_runtime_client",
    projectId: "project_runtime_client",
    action: "deploy",
    state: "leased",
    payload: null,
    nodeId: "runner-runtime-client",
    attempts: 1,
    maxAttempts: 10,
    fence: 1,
    nextAttemptAt: Date.now(),
    leaseExpiresAt: Date.now() + 10_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseToken: "clnko_runtime_client_123456789012345678901234",
  };
  const integrityClient = createDeploymentCoordinatorClient({
    baseUrl: "http://127.0.0.1:4200",
    maxRuntimeBytes: 1_024,
    fetch: async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/vnd.clank.runtime",
        "x-clank-content-sha256": badDigest,
      },
    }),
  });
  await assert.rejects(
    integrityClient.runtime(
      operation.nodeId,
      "clnka_runtime_client_123456789012345678901234",
      operation,
    ),
    (error) => error instanceof DeploymentCoordinatorError
      && error.status === 502
      && error.code === "RUNTIME_INTEGRITY_FAILED",
  );

  const oversized = new Uint8Array(1_025);
  const boundedClient = createDeploymentCoordinatorClient({
    baseUrl: "http://127.0.0.1:4200",
    maxRuntimeBytes: 1_024,
    fetch: async () => new Response(oversized, {
      status: 200,
      headers: {
        "content-length": "1",
        "content-type": "application/vnd.clank.runtime",
        "x-clank-content-sha256": createHash("sha256").update(oversized).digest("hex"),
      },
    }),
  });
  await assert.rejects(
    boundedClient.runtime(
      operation.nodeId,
      "clnka_runtime_client_123456789012345678901234",
      operation,
    ),
    (error) => error instanceof DeploymentCoordinatorError
      && error.status === 502
      && error.code === "RUNTIME_TOO_LARGE",
  );

  const providerBound = await fixture({}, {
    maxRuntimeBytes: 1_024,
    runtime: {
      async load() {
        return {
          bytes: oversized,
          sha256: createHash("sha256").update(oversized).digest("hex"),
        };
      },
    },
  });
  try {
    const session = await providerBound.client.register(registrationToken, {
      id: "runner-large-runtime-01",
      region: "local",
    });
    await providerBound.orchestrator.enqueue({
      projectId: "project_large_runtime",
      action: "deploy",
      idempotencyKey: "large-runtime-provider",
      nodeId: session.node.id,
    });
    const [claimed] = await providerBound.client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      providerBound.client.runtime(session.node.id, session.token, claimed),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 413
        && error.code === "RUNTIME_TOO_LARGE",
    );
  } finally {
    await providerBound.close();
  }
});

test("runtime transfer rechecks the operation lease after provider work", async () => {
  const bytes = new TextEncoder().encode("slow-runtime-provider");
  const test = await fixture({ operationLeaseMs: 100 }, {
    runtime: {
      async load() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
  });
  try {
    const session = await test.client.register(registrationToken, {
      id: "runner-expired-runtime-01",
      region: "local",
    });
    await test.orchestrator.enqueue({
      projectId: "project_expired_runtime",
      action: "deploy",
      idempotencyKey: "expired-runtime-provider",
      nodeId: session.node.id,
    });
    const [operation] = await test.client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      test.client.runtime(session.node.id, session.token, operation),
      (error) => error instanceof DeploymentCoordinatorError
        && error.status === 409
        && error.code === "STALE_OPERATION",
    );
  } finally {
    await test.close();
  }
});

test("coordinator transport is bounded, JSON-only, and fail-closed", async () => {
  const test = await fixture();
  try {
    const get = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/register",
    ));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");

    const wrongType = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/register",
      {
        method: "POST",
        headers: { authorization: `Bearer ${registrationToken}`, "content-type": "text/plain" },
        body: "{}",
      },
    ));
    assert.equal(wrongType.status, 415);

    const oversized = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/register",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registrationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "runner", region: "west", padding: "x".repeat(9 * 1024) }),
      },
    ));
    assert.equal(oversized.status, 413);

    const reservedLabel = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/register",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registrationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "runner",
          region: "west",
          labels: { constructor: "unsafe" },
        }),
      },
    ));
    assert.equal(reservedLabel.status, 422);

    const unknown = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/unknown",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registrationToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ));
    assert.equal(unknown.status, 404);
    const closedRuntime = await test.handler.handle(new Request(
      "http://127.0.0.1:4200/api/runner/v1/runtime",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registrationToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ));
    assert.equal(closedRuntime.status, 404);
    assert.equal(test.privateErrors.length, 0);
  } finally {
    await test.close();
  }
});

test("coordinator client requires HTTPS away from loopback", () => {
  assert.throws(
    () => createDeploymentCoordinatorClient({ baseUrl: "http://runner.example.com" }),
    /must use HTTPS or loopback HTTP/u,
  );
  assert.throws(
    () => createDeploymentCoordinatorClient({ baseUrl: "https://user@runner.example.com" }),
    /cannot contain credentials/u,
  );
});

test("platform runner endpoints remain closed unless enrollment is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-runner-platform-"));
  const closed = await openPlatform({
    dataDirectory: join(root, "closed"),
    publicUrl: "http://127.0.0.1:4200",
    signup: false,
    backups: { intervalMs: false },
  });
  const enabled = await openPlatform({
    dataDirectory: join(root, "enabled"),
    publicUrl: "http://127.0.0.1:4200",
    signup: false,
    backups: { intervalMs: false },
    deploymentAgents: { registrationToken },
  });
  try {
    const request = () => new Request("http://127.0.0.1:4200/api/runner/v1/register", {
      method: "POST",
      headers: {
        authorization: `Bearer ${registrationToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "platform-runner-1", region: "local" }),
    });
    assert.equal((await closed.handle(request())).status, 404);
    const response = await enabled.handle(request());
    assert.equal(response.status, 201);
    assert.match((await response.json()).token, /^clnka_/u);
  } finally {
    await Promise.all([closed.close(), enabled.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment agent enrolls, executes, observes, persists credentials, and drains", async () => {
  const artifactBytes = new TextEncoder().encode("deployment-agent-release");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const runtimeBytes = new TextEncoder().encode("deployment-agent-runtime");
  const runtimeSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  const test = await fixture({ operationLeaseMs: 500 }, {
    artifact: {
      async load() {
        return { bytes: artifactBytes, sha256: artifactSha256 };
      },
    },
    runtime: {
      async load() {
        return { bytes: runtimeBytes, sha256: runtimeSha256 };
      },
    },
  });
  const credentials = memoryDeploymentNodeCredentials();
  const executed = [];
  let agent;
  try {
    agent = await openDeploymentAgent({
      client: test.client,
      node: {
        id: "runner-agent-01",
        region: "us-central",
        capacity: 2,
        labels: { isolation: "docker" },
      },
      registrationToken,
      credentials,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute(operation, context) {
        executed.push(operation.id);
        const payload = operation.payload;
        assert.equal(context.operation.id, operation.id);
        const artifact = await context.artifact();
        assert.deepEqual(artifact.bytes, artifactBytes);
        assert.equal(artifact.sha256, artifactSha256);
        const runtime = await context.runtime();
        assert.deepEqual(runtime.bytes, runtimeBytes);
        assert.equal(runtime.sha256, runtimeSha256);
        assert.equal(await context.observe({
          generation: payload.generation,
          releaseId: payload.releaseId,
          state: payload.state,
        }), true);
        return { runtimeId: "container-agent-01" };
      },
    });

    const desired = await test.orchestrator.setDesired({
      projectId: "project_agent_one",
      releaseId: "release-agent-1",
      state: "running",
      region: "us-central",
    });
    const operation = await waitFor(
      () => {
        const candidate = executed[0]
          ? test.orchestrator.operation(executed[0])
          : null;
        return candidate?.state === "succeeded" ? candidate : null;
      },
      "the deployment agent did not complete its operation",
    );
    assert.deepEqual(operation.result, { runtimeId: "container-agent-01" });
    assert.equal(test.orchestrator.desired(desired.projectId).observedState, "running");
    assert.match(await credentials.load(agent.nodeId), /^clnka_/u);

    await agent.close();
    assert.equal(agent.draining, true);
    assert.equal(agent.activeOperations, 0);
    assert.equal(test.orchestrator.listNodes()[0].status, "draining");
    assert.equal(test.privateErrors.length, 0);
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent restarts from stored node credentials without enrollment access", async () => {
  const test = await fixture({ operationLeaseMs: 500 });
  const credentials = memoryDeploymentNodeCredentials();
  let first;
  let second;
  try {
    first = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-restart-01", region: "local" },
      registrationToken,
      credentials,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute() {
        return null;
      },
    });
    await first.close();
    assert.equal(test.orchestrator.listNodes()[0].status, "draining");

    second = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-restart-01", region: "local" },
      credentials,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute() {
        return { restarted: true };
      },
    });
    assert.equal(second.node.status, "active");
    const queued = await test.orchestrator.enqueue({
      projectId: "project_restart",
      action: "deploy",
      payload: {},
      idempotencyKey: "runner-restart-operation",
      nodeId: second.nodeId,
    });
    const completed = await waitFor(
      () => test.orchestrator.operation(queued.operation.id)?.state === "succeeded",
      "the restarted deployment agent did not claim work",
    );
    assert.equal(completed, true);
  } finally {
    await second?.close();
    await first?.close();
    await test.close();
  }
});

test("deployment agent rotates an invalid stored credential only with enrollment access", async () => {
  const test = await fixture();
  const invalidToken = "clnka_invalid_stored_token_123456789012345678901";
  const credentials = memoryDeploymentNodeCredentials({
    "runner-rotation-01": invalidToken,
  });
  let agent;
  try {
    await assert.rejects(
      openDeploymentAgent({
        client: test.client,
        node: { id: "runner-rotation-01", region: "local" },
        credentials,
        async execute() {
          return null;
        },
      }),
      (error) => error instanceof DeploymentCoordinatorError
        && error.code === "NODE_AUTH_FAILED",
    );
    assert.equal(await credentials.load("runner-rotation-01"), invalidToken);

    agent = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-rotation-01", region: "local" },
      credentials,
      registrationToken,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute() {
        return null;
      },
    });
    assert.notEqual(await credentials.load(agent.nodeId), invalidToken);
    assert.equal(agent.node.status, "active");
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent stops safely when its active node credential is rotated", async () => {
  const test = await fixture();
  const localErrors = [];
  let agent;
  try {
    agent = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-revoked-01", region: "local" },
      registrationToken,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      onError: (error) => localErrors.push(error),
      async execute() {
        return null;
      },
    });
    await test.client.register(registrationToken, {
      id: agent.nodeId,
      region: "local",
    });
    await waitFor(() => agent.draining, "the revoked deployment agent did not stop");
    await agent.done;
    assert.ok(localErrors.some(
      (error) => error instanceof DeploymentCoordinatorError
        && error.code === "NODE_AUTH_FAILED",
    ));
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent renews short leases while execution is still active", async () => {
  // Keep the lease short enough to require renewal, but long enough that a
  // heavily loaded CI event loop cannot expire it before the first timer runs.
  const test = await fixture({ operationLeaseMs: 2_000 });
  let renewals = 0;
  let agent;
  const client = {
    ...test.client,
    async renew(...arguments_) {
      const renewed = await test.client.renew(...arguments_);
      if (renewed) renewals += 1;
      return renewed;
    },
  };
  try {
    agent = await openDeploymentAgent({
      client,
      node: { id: "runner-renew-01", region: "local" },
      registrationToken,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute() {
        await waitFor(
          () => renewals >= 3,
          "the active deployment execution was not renewed three times",
          10_000,
        );
        return { renewed: true };
      },
    });
    const queued = await test.orchestrator.enqueue({
      projectId: "project_renew",
      action: "deploy",
      idempotencyKey: "runner-renew-operation",
      nodeId: agent.nodeId,
    });
    await waitFor(
      () => test.orchestrator.operation(queued.operation.id)?.state === "succeeded",
      "the renewed deployment operation did not complete",
      12_000,
    );
    assert.ok(renewals >= 3, `expected at least 3 lease renewals, received ${renewals}`);
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent abandons a lost lease without completing or failing stale work", async () => {
  const test = await fixture({ operationLeaseMs: 100 });
  let completes = 0;
  let failures = 0;
  let aborted = false;
  let agent;
  const client = {
    ...test.client,
    async renew() {
      return null;
    },
    async complete(...arguments_) {
      completes += 1;
      return test.client.complete(...arguments_);
    },
    async fail(...arguments_) {
      failures += 1;
      return test.client.fail(...arguments_);
    },
  };
  try {
    agent = await openDeploymentAgent({
      client,
      node: { id: "runner-lost-lease-01", region: "local" },
      registrationToken,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute(_operation, context) {
        await waitForAbort(context.signal);
        aborted = true;
        throw context.signal.reason;
      },
    });
    const queued = await test.orchestrator.enqueue({
      projectId: "project_lost_lease",
      action: "deploy",
      idempotencyKey: "runner-lost-lease-operation",
      nodeId: agent.nodeId,
    });
    await waitFor(() => aborted, "the executor was not aborted after losing its lease");
    await waitFor(() => agent.activeOperations === 0, "the abandoned operation remained active");
    assert.equal(completes, 0);
    assert.equal(failures, 0);
    assert.equal(test.orchestrator.operation(queued.operation.id).state, "leased");
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent keeps private execution errors out of coordinator state", async () => {
  const test = await fixture({ operationLeaseMs: 500, retryBaseMs: 1_000 });
  const localErrors = [];
  let agent;
  try {
    agent = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-error-01", region: "local" },
      registrationToken,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      onError: (error) => localErrors.push(error),
      async execute() {
        throw new Error("private-provider-token-should-not-leak");
      },
    });
    const queued = await test.orchestrator.enqueue({
      projectId: "project_error",
      action: "deploy",
      idempotencyKey: "runner-error-operation",
      nodeId: agent.nodeId,
    });
    const failed = await waitFor(
      () => {
        const operation = test.orchestrator.operation(queued.operation.id);
        return operation?.state === "retry" ? operation : null;
      },
      "the failed deployment operation did not enter retry",
    );
    assert.equal(failed.error, "Deployment execution failed.");
    assert.equal(JSON.stringify(failed).includes("private-provider-token"), false);
    assert.match(String(localErrors[0]), /private-provider-token-should-not-leak/u);
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent never retries an uncertain successful completion", async () => {
  const test = await fixture({ operationLeaseMs: 500 });
  let failures = 0;
  let executions = 0;
  let releaseExecution;
  let agent;
  const client = {
    ...test.client,
    async complete() {
      throw new DeploymentCoordinatorError(
        504,
        "COORDINATOR_TIMEOUT",
        "The completion response was lost.",
      );
    },
    async fail(...arguments_) {
      failures += 1;
      return test.client.fail(...arguments_);
    },
  };
  try {
    agent = await openDeploymentAgent({
      client,
      node: { id: "runner-uncertain-01", region: "local" },
      registrationToken,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      async execute() {
        executions += 1;
        await new Promise((resolve) => {
          releaseExecution = resolve;
        });
        return { maybeCommitted: true };
      },
    });
    const queued = await test.orchestrator.enqueue({
      projectId: "project_uncertain",
      action: "deploy",
      idempotencyKey: "runner-uncertain-operation",
      nodeId: agent.nodeId,
    });
    await waitFor(() => releaseExecution, "the uncertain operation did not start");
    releaseExecution();
    await waitFor(() => agent.activeOperations === 0, "the uncertain operation did not settle locally");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(executions, 1);
    assert.equal(agent.activeOperations, 0);
    assert.equal(failures, 0);
    assert.equal(test.orchestrator.operation(queued.operation.id).state, "leased");
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("deployment agent shutdown drains, renews during grace, and aborts at its deadline", async () => {
  const test = await fixture({ operationLeaseMs: 500 });
  let started = false;
  let aborted = false;
  let agent;
  try {
    agent = await openDeploymentAgent({
      client: test.client,
      node: { id: "runner-shutdown-01", region: "local" },
      registrationToken,
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      shutdownTimeoutMs: 100,
      async execute(_operation, context) {
        started = true;
        await waitForAbort(context.signal);
        aborted = true;
        return null;
      },
    });
    await test.orchestrator.enqueue({
      projectId: "project_shutdown",
      action: "deploy",
      idempotencyKey: "runner-shutdown-operation",
      nodeId: agent.nodeId,
    });
    await waitFor(() => started, "the shutdown test operation did not start");
    const before = Date.now();
    await agent.close();
    assert.equal(aborted, true);
    assert.ok(Date.now() - before < 1_000);
    assert.equal(agent.draining, true);
    assert.equal(test.orchestrator.listNodes()[0].status, "draining");
  } finally {
    await agent?.close();
    await test.close();
  }
});

test("file deployment node credentials are serialized, owner-only, atomic, and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-runner-credentials-"));
  const path = join(root, "nested", "credentials.json");
  const tokenOne = "clnka_file_token_one_123456789012345678901234";
  const tokenTwo = "clnka_file_token_two_123456789012345678901234";
  try {
    const credentials = fileDeploymentNodeCredentials(path);
    await Promise.all([
      credentials.save("runner-file-01", tokenOne),
      credentials.save("constructor", tokenTwo),
    ]);
    assert.equal(await credentials.load("runner-file-01"), tokenOne);
    assert.equal(await credentials.load("constructor"), tokenTwo);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.credentials["runner-file-01"], tokenOne);
    await credentials.clear("runner-file-01");
    assert.equal(await credentials.load("runner-file-01"), null);

    await rm(path);
    await writeFile(join(root, "target"), "{}");
    await symlink(join(root, "target"), path);
    await assert.rejects(credentials.load("constructor"), /unsafe or too large/u);
    await rm(path);
    await writeFile(path, "x".repeat(64 * 1024 + 1));
    await chmod(path, 0o600);
    await assert.rejects(credentials.load("constructor"), /unsafe or too large/u);
    await writeFile(path, "{not-json");
    await chmod(path, 0o600);
    await assert.rejects(credentials.load("constructor"), SyntaxError);
    await writeFile(path, JSON.stringify({
      version: 1,
      credentials: { constructor: tokenTwo },
    }));
    await chmod(path, 0o644);
    await assert.rejects(credentials.load("constructor"), /unsafe or too large/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
