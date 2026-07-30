import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeploymentCoordinatorClient,
  createDeploymentCoordinatorHandler,
  defineDatabase,
  DeploymentCoordinatorError,
  openDeploymentOrchestrator,
  openPlatform,
  openSQLite,
} from "../dist/index.js";

const registrationToken = "clank_runner_enrollment_test_token_1234567890";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clank-runner-coordinator-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  const orchestrator = openDeploymentOrchestrator(database, {
    nodeTtlMs: 5_000,
    operationLeaseMs: 5_000,
    retryBaseMs: 10,
  });
  const privateErrors = [];
  const handler = createDeploymentCoordinatorHandler(orchestrator, {
    registrationToken,
    maxRequestBytes: 8 * 1024,
    onError: (error) => privateErrors.push(error),
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

    assert.equal(await test.client.observe(session.node.id, session.token, {
      projectId: desired.projectId,
      generation: desired.generation,
      releaseId: desired.desiredReleaseId,
      state: "running",
    }), true);
    assert.equal(test.orchestrator.desired(desired.projectId).observedState, "running");

    const draining = await test.client.drain(session.node.id, session.token);
    assert.equal(draining.status, "draining");
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
