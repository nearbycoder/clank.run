import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createDeploymentBundle,
  deploymentDigest,
} from "../dist/deploy.js";
import {
  createDeploymentProviderHandler,
  createHttpDeploymentProvider,
  DEPLOYMENT_PROVIDER_DELETE_PATH,
  DEPLOYMENT_PROVIDER_RECONCILE_PATH,
  DEPLOYMENT_PROVIDER_ROLLBACK_PATH,
  DeploymentProviderError,
  executeDeploymentProvider,
  openProviderDeploymentAgent,
  reconcileDeploymentProvider,
} from "../dist/provider.js";
import {
  createDeploymentRuntimeCapsule,
  DEPLOYMENT_RUNTIME_MEDIA_TYPE,
  DEPLOYMENT_RUNTIME_PROTOCOL,
} from "../dist/runtime-placement.js";

const providerToken = "clank-provider-test-token-12345678901234567890";
const execFileAsync = promisify(execFile);

test("portable provider reconciliation verifies releases and strips coordinator credentials", async () => {
  const fixture = await releaseFixture();
  const controller = new AbortController();
  const received = [];
  const observed = [];
  const operation = claimedOperation({
    payload: {
      releaseId: "release_provider_01",
      state: "running",
      generation: 4,
    },
  });
  try {
    const result = await reconcileDeploymentProvider({
      kind: "docker-host",
      async reconcile(request) {
        received.push(request);
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.operation), true);
        assert.equal("leaseToken" in request.operation, false);
        assert.equal("nodeId" in request.operation, false);
        assert.equal(request.operation.id, operation.id);
        assert.equal(request.operation.fence, 7);
        assert.equal(request.operation.attempt, 2);
        assert.equal(request.desired.releaseId, "release_provider_01");
        assert.equal(request.artifact.sha256, fixture.digest);
        assert.equal(request.artifact.bundle.protocol, "clank-deploy/1");
        assert.equal(request.artifact.bundle.config.entry, "dist/server.js");
        assert.notEqual(request.artifact.bytes, fixture.bytes);
      },
    }, operation, {
      operation,
      signal: controller.signal,
      async artifact() {
        return { bytes: fixture.bytes, sha256: fixture.digest };
      },
      async observe(input) {
        observed.push(input);
        return true;
      },
    });

    assert.equal(received.length, 1);
    assert.deepEqual(observed, [{
      generation: 4,
      releaseId: "release_provider_01",
      state: "running",
    }]);
    assert.deepEqual(result, {
      provider: "docker-host",
      generation: 4,
      releaseId: "release_provider_01",
      state: "running",
    });
  } finally {
    await fixture.close();
  }
});

test("portable provider reconciliation verifies and binds sensitive runtime capsules", async () => {
  const fixture = await releaseFixture();
  const runtime = await runtimeFixture(fixture, 6);
  const operation = claimedOperation({
    payload: {
      releaseId: "release_provider_01",
      state: "running",
      generation: 6,
      runtimeProtocol: DEPLOYMENT_RUNTIME_PROTOCOL,
    },
  });
  let received;
  let observed;
  try {
    await reconcileDeploymentProvider({
      kind: "microvm",
      async reconcile(request) {
        received = request;
      },
    }, operation, {
      operation,
      signal: new AbortController().signal,
      async artifact() {
        throw new Error("legacy artifact transport must not be used");
      },
      async runtime() {
        return { bytes: runtime.bytes, sha256: runtime.sha256 };
      },
      async observe(input) {
        observed = input;
        return true;
      },
    });
    assert.equal(received.runtime.manifest.environment.APP_SECRET, "runtime-secret-canary");
    assert.equal(received.runtime.manifest.projectId, operation.projectId);
    assert.equal(received.artifact.sha256, fixture.digest);
    assert.equal(received.artifact, received.runtime.artifact);
    assert.equal("leaseToken" in received.operation, false);
    assert.deepEqual(observed, {
      generation: 6,
      releaseId: "release_provider_01",
      state: "running",
    });

    const mismatched = await runtimeFixture(fixture, 7);
    await assert.rejects(
      reconcileDeploymentProvider({ kind: "microvm", async reconcile() {} }, operation, {
        operation,
        signal: new AbortController().signal,
        async artifact() {
          throw new Error("legacy artifact transport must not be used");
        },
        async runtime() {
          return { bytes: mismatched.bytes, sha256: mismatched.sha256 };
        },
        async observe() {
          return true;
        },
      }),
      (error) => /does not match the desired placement/u.test(error.message)
        && !error.message.includes("runtime-secret-canary"),
    );
  } finally {
    await fixture.close();
  }
});

test("portable provider reconciliation validates desired state, artifact integrity, and stale observations", async () => {
  const fixture = await releaseFixture();
  const controller = new AbortController();
  const baseContext = {
    signal: controller.signal,
    async artifact() {
      return { bytes: fixture.bytes, sha256: fixture.digest };
    },
    async observe() {
      return true;
    },
  };
  const provider = { kind: "test", async reconcile() {} };
  try {
    const deploy = claimedOperation();
    await assert.rejects(
      reconcileDeploymentProvider(provider, { ...deploy, action: "deploy" }, {
        ...baseContext,
        operation: { ...deploy, action: "deploy" },
      }),
      /only reconcile operations/u,
    );
    const extra = claimedOperation({
      payload: {
        releaseId: "release_provider_01",
        state: "running",
        generation: 1,
        unexpected: true,
      },
    });
    await assert.rejects(
      reconcileDeploymentProvider(provider, extra, { ...baseContext, operation: extra }),
      /Unknown field unexpected/u,
    );
    const invalidStop = claimedOperation({
      payload: {
        releaseId: "release_provider_01",
        state: "stopped",
        generation: 1,
      },
    });
    await assert.rejects(
      reconcileDeploymentProvider(provider, invalidStop, {
        ...baseContext,
        operation: invalidStop,
      }),
      /stopped deployment cannot select/u,
    );
    const corrupted = claimedOperation();
    await assert.rejects(
      reconcileDeploymentProvider(provider, corrupted, {
        ...baseContext,
        operation: corrupted,
        async artifact() {
          return { bytes: fixture.bytes, sha256: "0".repeat(64) };
        },
      }),
      /digest verification/u,
    );
    const stopped = claimedOperation({
      payload: { releaseId: null, state: "stopped", generation: 8 },
    });
    let downloaded = false;
    let stoppedRequest;
    await assert.rejects(
      reconcileDeploymentProvider({
        kind: "test",
        async reconcile(request) {
          stoppedRequest = request;
        },
      }, stopped, {
        operation: stopped,
        signal: controller.signal,
        async artifact() {
          downloaded = true;
          return { bytes: fixture.bytes, sha256: fixture.digest };
        },
        async observe() {
          return false;
        },
      }),
      /rejected as stale/u,
    );
    assert.equal(downloaded, false);
    assert.equal(stoppedRequest.artifact, null);
  } finally {
    await fixture.close();
  }
});

test("provider lifecycle execution derives confirmations and strips coordinator authority", async () => {
  const received = [];
  const provider = {
    kind: "docker",
    async reconcile() {
      throw new Error("lifecycle operations must not reconcile");
    },
    async rollback(request) {
      received.push({ action: "rollback", request });
    },
    async delete(request) {
      received.push({ action: "delete", request });
    },
  };
  const rollback = claimedOperation({
    action: "rollback",
    payload: { generation: 9 },
  });
  const context = (operation) => ({
    operation,
    signal: new AbortController().signal,
    async artifact() {
      throw new Error("lifecycle operations must not fetch artifacts");
    },
    async runtime() {
      throw new Error("lifecycle operations must not fetch runtime capsules");
    },
    async observe() {
      throw new Error("lifecycle operations do not publish desired-state observations");
    },
  });

  assert.deepEqual(
    await executeDeploymentProvider(provider, rollback, context(rollback)),
    { provider: "docker", action: "rollback", generation: 9 },
  );
  assert.equal(received[0].request.confirmation, "rollback project_provider_01 9");
  assert.equal(received[0].request.operation.fence, rollback.fence);
  assert.equal("leaseToken" in received[0].request.operation, false);
  assert.equal("nodeId" in received[0].request.operation, false);

  const deletion = claimedOperation({
    id: "op_provider_delete_01",
    action: "delete",
    payload: { generation: 10 },
    fence: 8,
  });
  assert.deepEqual(
    await executeDeploymentProvider(provider, deletion, context(deletion)),
    { provider: "docker", action: "delete", generation: 10 },
  );
  assert.equal(received[1].request.confirmation, "delete project_provider_01");
  assert.equal(received[1].request.operation.id, deletion.id);

  const injected = claimedOperation({
    action: "rollback",
    payload: {
      generation: 9,
      confirmation: "rollback another_project 1",
    },
  });
  await assert.rejects(
    executeDeploymentProvider(provider, injected, context(injected)),
    /Unknown field confirmation/u,
  );
  await assert.rejects(
    executeDeploymentProvider({
      kind: "limited",
      async reconcile() {},
    }, rollback, context(rollback)),
    /does not support rollback/u,
  );
});

test("provider deployment agent composes enrollment, fixed results, observation, and drain", async () => {
  const fixture = await releaseFixture();
  const operation = claimedOperation({
    payload: {
      releaseId: "release_provider_01",
      state: "running",
      generation: 12,
    },
    leaseExpiresAt: Date.now() + 60_000,
  });
  const node = {
    id: "node_provider_01",
    region: "local",
    capacity: 2,
    labels: {},
    status: "active",
    heartbeatAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  let claimed = false;
  let registered;
  let completedResult;
  let observed;
  let drained = false;
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const client = {
    async register(_token, input) {
      registered = input;
      return { node: { ...node, labels: input.labels }, token: "clnka_agent-token-123456789012345678901234567890" };
    },
    async heartbeat() {
      return node;
    },
    async drain(_nodeId, _token, value) {
      drained = value;
      return { ...node, status: value ? "draining" : "active" };
    },
    async claim() {
      if (claimed) return [];
      claimed = true;
      return [operation];
    },
    async artifact() {
      return { bytes: fixture.bytes, sha256: fixture.digest };
    },
    async renew() {
      return operation;
    },
    async complete(_nodeId, _token, _operation, result) {
      completedResult = result;
      resolveCompleted();
      return true;
    },
    async fail() {
      throw new Error("provider operation unexpectedly failed");
    },
    async observe(_nodeId, _token, input) {
      observed = input;
      return true;
    },
  };
  let agent;
  try {
    agent = await openProviderDeploymentAgent({
      client,
      node: { id: node.id, region: node.region, capacity: node.capacity },
      provider: {
        kind: "microvm",
        async reconcile(request) {
          assert.equal("leaseToken" in request.operation, false);
          assert.equal(request.artifact.bundle.protocol, "clank-deploy/1");
        },
      },
      registrationToken: "clank-registration-token-123456789012345678901234",
      concurrency: 1,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("provider agent did not complete")),
        2_000,
      );
      void completed.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
    assert.equal(registered.labels.provider, "microvm");
    assert.deepEqual(observed, {
      projectId: "project_provider_01",
      generation: 12,
      releaseId: "release_provider_01",
      state: "running",
    });
    assert.deepEqual(completedResult, {
      provider: "microvm",
      generation: 12,
      releaseId: "release_provider_01",
      state: "running",
    });
    await agent.close();
    assert.equal(drained, true);
  } finally {
    await agent?.close();
    await fixture.close();
  }
});

test("HTTP provider bridge carries a verified binary artifact through the portable contract", async () => {
  const fixture = await releaseFixture();
  const received = [];
  const handler = createDeploymentProviderHandler({
    kind: "nomad",
    async reconcile(request) {
      received.push(request);
    },
  }, { token: providerToken });
  const calls = [];
  const provider = createHttpDeploymentProvider({
    baseUrl: "http://127.0.0.1:9876",
    token: providerToken,
    retries: 0,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return handler.handle(new Request(url, init));
    },
  });
  const input = providerInput(fixture);
  try {
    await provider.reconcile(input);
    assert.equal(provider.kind, "http");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:9876${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.headers.get("x-clank-operation-fence"), "11");
    assert.equal(calls[0].init.headers.get("x-clank-content-sha256"), fixture.digest);
    assert.equal(received.length, 1);
    assert.equal(received[0].operation.projectId, "project_provider_01");
    assert.equal(received[0].desired.generation, 3);
    assert.equal(received[0].artifact.sha256, fixture.digest);
    assert.equal(received[0].artifact.bundle.config.database.path, "app.sqlite");

    const stopped = {
      ...input,
      desired: { generation: 4, releaseId: null, state: "stopped" },
      artifact: null,
    };
    await provider.reconcile(stopped);
    assert.equal(received[1].artifact, null);
    assert.equal(received[1].desired.state, "stopped");
    assert.equal(calls[1].init.headers.has("content-type"), false);
    assert.equal(calls[1].init.headers.has("x-clank-content-sha256"), false);
  } finally {
    await fixture.close();
  }
});

test("HTTP provider bridge carries runtime capsules only in the bounded request body", async () => {
  const fixture = await releaseFixture();
  const runtime = await runtimeFixture(fixture, 3);
  let received;
  let wireHeaders;
  const handler = createDeploymentProviderHandler({
    kind: "microvm",
    async reconcile(request) {
      received = request;
    },
  }, { token: providerToken });
  const provider = createHttpDeploymentProvider({
    baseUrl: "http://127.0.0.1:9876",
    token: providerToken,
    retries: 0,
    async fetch(url, init) {
      wireHeaders = new Headers(init.headers);
      return handler.handle(new Request(url, init));
    },
  });
  try {
    await provider.reconcile({
      ...providerInput(fixture),
      desired: {
        generation: 3,
        releaseId: "release_provider_01",
        state: "running",
        runtimeProtocol: DEPLOYMENT_RUNTIME_PROTOCOL,
      },
      artifact: runtime.artifact,
      runtime,
    });
    assert.equal(wireHeaders.get("content-type"), DEPLOYMENT_RUNTIME_MEDIA_TYPE);
    assert.equal(wireHeaders.get("x-clank-runtime-protocol"), DEPLOYMENT_RUNTIME_PROTOCOL);
    assert.equal(wireHeaders.get("x-clank-content-sha256"), runtime.sha256);
    assert.equal([...wireHeaders].flat().join("\n").includes("runtime-secret-canary"), false);
    assert.equal(received.runtime.sha256, runtime.sha256);
    assert.equal(received.runtime.manifest.environment.APP_SECRET, "runtime-secret-canary");
    assert.equal(received.artifact.sha256, fixture.digest);

    const tampered = new Uint8Array(runtime.bytes);
    tampered[tampered.byteLength - 1] ^= 1;
    const tamperedHeaders = new Headers(wireHeaders);
    tamperedHeaders.set(
      "x-clank-content-sha256",
      createHash("sha256").update(tampered).digest("hex"),
    );
    const rejected = await handler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      {
        method: "POST",
        headers: tamperedHeaders,
        body: tampered,
      },
    ));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "RUNTIME_INVALID");

    const boundedHandler = createDeploymentProviderHandler({
      kind: "microvm",
      async reconcile() {
        throw new Error("oversized runtime must not reach provider");
      },
    }, {
      token: providerToken,
      maxRuntimeBytes: 1_024,
    });
    const oversizedHeaders = new Headers(wireHeaders);
    oversizedHeaders.set("content-length", "2048");
    const oversized = await boundedHandler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      {
        method: "POST",
        headers: oversizedHeaders,
        body: runtime.bytes,
      },
    ));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, "RUNTIME_TOO_LARGE");
  } finally {
    await fixture.close();
  }
});

test("HTTP provider bridge carries fenced rollback and deletion without bodies or confirmations", async () => {
  const received = [];
  const handler = createDeploymentProviderHandler({
    kind: "docker",
    async reconcile() {},
    async rollback(request) {
      received.push({ action: "rollback", request });
    },
    async delete(request) {
      received.push({ action: "delete", request });
    },
  }, { token: providerToken });
  const calls = [];
  const provider = createHttpDeploymentProvider({
    baseUrl: "http://127.0.0.1:9876",
    token: providerToken,
    retries: 0,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return handler.handle(new Request(url, init));
    },
  });

  await provider.rollback(providerLifecycleInput("rollback", 12));
  await provider.delete(providerLifecycleInput("delete", 13));
  assert.deepEqual(calls.map((call) => call.url), [
    `http://127.0.0.1:9876${DEPLOYMENT_PROVIDER_ROLLBACK_PATH}`,
    `http://127.0.0.1:9876${DEPLOYMENT_PROVIDER_DELETE_PATH}`,
  ]);
  for (const { init } of calls) {
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.has("content-type"), false);
    assert.equal(init.headers.has("x-clank-content-sha256"), false);
    assert.equal([...init.headers].flat().join("\n").includes("confirmation"), false);
  }
  assert.equal(received[0].request.confirmation, "rollback project_provider_01 12");
  assert.equal(received[1].request.confirmation, "delete project_provider_01");
  assert.equal("leaseToken" in received[0].request.operation, false);

  let retryAttempts = 0;
  const retrying = createHttpDeploymentProvider({
    baseUrl: "http://127.0.0.1:9876",
    token: providerToken,
    retries: 1,
    async fetch(url, init) {
      retryAttempts += 1;
      if (retryAttempts === 1) return new Response(null, { status: 503 });
      return handler.handle(new Request(url, init));
    },
  });
  await retrying.rollback(providerLifecycleInput("rollback", 14));
  assert.equal(retryAttempts, 2);
  assert.equal(received[2].request.operation.id, "op_provider_rollback_14");

  const body = await handler.handle(new Request(
    `http://127.0.0.1${DEPLOYMENT_PROVIDER_ROLLBACK_PATH}`,
    {
      method: "POST",
      headers: providerLifecycleWireHeaders("rollback", providerToken, 12),
      body: "caller-controlled-confirmation",
    },
  ));
  assert.equal(body.status, 400);
  assert.equal((await body.json()).error, "UNEXPECTED_BODY");

  const unsupported = createDeploymentProviderHandler({
    kind: "limited",
    async reconcile() {},
  }, { token: providerToken });
  const missingCapability = await unsupported.handle(new Request(
    `http://127.0.0.1${DEPLOYMENT_PROVIDER_DELETE_PATH}`,
    {
      method: "POST",
      headers: providerLifecycleWireHeaders("delete", providerToken, 13),
    },
  ));
  assert.equal(missingCapability.status, 501);
  assert.equal((await missingCapability.json()).error, "ACTION_UNSUPPORTED");
});

test("HTTP provider bridge authenticates, bounds, retries, and keeps provider failures private", async () => {
  const fixture = await releaseFixture();
  const privateErrors = [];
  const handler = createDeploymentProviderHandler({
    kind: "microvm",
    async reconcile() {
      throw new Error("provider-secret-canary");
    },
  }, {
    token: providerToken,
    maxArtifactBytes: 1_024,
    onError(error) {
      privateErrors.push(error);
    },
  });
  try {
    const unauthorized = await handler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      {
        method: "POST",
        headers: providerWireHeaders(fixture, "bad-provider-token-that-is-long-enough-123456789"),
        body: fixture.bytes,
      },
    ));
    assert.equal(unauthorized.status, 401);
    assert.equal(JSON.stringify(await unauthorized.json()).includes("provider-secret-canary"), false);

    const oversized = await handler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      {
        method: "POST",
        headers: {
          ...Object.fromEntries(providerWireHeaders(fixture, providerToken)),
          "content-length": "2048",
        },
        body: fixture.bytes,
      },
    ));
    assert.equal(oversized.status, 413);

    const corruptedHeaders = providerWireHeaders(fixture, providerToken);
    corruptedHeaders.set("x-clank-content-sha256", "0".repeat(64));
    const corrupted = await handler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      { method: "POST", headers: corruptedHeaders, body: fixture.bytes },
    ));
    assert.equal(corrupted.status, 400);
    assert.equal((await corrupted.json()).error, "ARTIFACT_INVALID");

    const failed = await handler.handle(new Request(
      `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
      {
        method: "POST",
        headers: providerWireHeaders(fixture, providerToken),
        body: fixture.bytes,
      },
    ));
    assert.equal(failed.status, 500);
    const failedBody = await failed.text();
    assert.equal(failedBody.includes("provider-secret-canary"), false);
    assert.equal(privateErrors[0].message, "provider-secret-canary");

    let attempts = 0;
    const retrying = createHttpDeploymentProvider({
      baseUrl: "https://provider.example.test/base",
      token: providerToken,
      retries: 1,
      async fetch(url, init) {
        attempts += 1;
        assert.equal(String(url), `https://provider.example.test/base${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`);
        if (attempts === 1) return new Response("temporary", { status: 503 });
        return new Response(null, { status: 204 });
      },
    });
    await retrying.reconcile(providerInput(fixture));
    assert.equal(attempts, 2);

    const denied = createHttpDeploymentProvider({
      baseUrl: "https://provider.example.test",
      token: providerToken,
      retries: 0,
      async fetch() {
        return new Response("secret provider error", { status: 403 });
      },
    });
    await assert.rejects(
      denied.reconcile(providerInput(fixture)),
      (error) => error instanceof DeploymentProviderError
        && error.status === 403
        && error.code === "PROVIDER_REJECTED"
        && !error.message.includes("secret provider error"),
    );
    assert.throws(
      () => createHttpDeploymentProvider({
        baseUrl: "http://provider.example.test",
        token: providerToken,
      }),
      /HTTPS or loopback HTTP/u,
    );
  } finally {
    await fixture.close();
  }
});

test("provider handler closes browser and method surfaces and rejects unexpected stop bodies", async () => {
  const handler = createDeploymentProviderHandler({
    kind: "test",
    async reconcile() {},
  }, { token: providerToken });
  assert.deepEqual(handler.paths, [
    DEPLOYMENT_PROVIDER_RECONCILE_PATH,
    DEPLOYMENT_PROVIDER_ROLLBACK_PATH,
    DEPLOYMENT_PROVIDER_DELETE_PATH,
  ]);
  assert.equal((await handler.handle(new Request("http://127.0.0.1/other"))).status, 404);
  const method = await handler.handle(new Request(
    `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
  ));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  const malformedHeaders = providerWireHeaders(null, providerToken);
  malformedHeaders.delete("x-clank-generation");
  const malformed = await handler.handle(new Request(
    `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
    { method: "POST", headers: malformedHeaders },
  ));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "INVALID_REQUEST");

  const headers = providerWireHeaders(null, providerToken);
  const response = await handler.handle(new Request(
    `http://127.0.0.1${DEPLOYMENT_PROVIDER_RECONCILE_PATH}`,
    {
      method: "POST",
      headers,
      body: new TextEncoder().encode("unexpected"),
    },
  ));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "ARTIFACT_TOO_LARGE");
});

test("HTTP provider client honors caller aborts, deadlines, and failure response bounds", async () => {
  const fixture = await releaseFixture();
  try {
    const timed = createHttpDeploymentProvider({
      baseUrl: "https://provider.example.test",
      token: providerToken,
      timeoutMs: 100,
      retries: 0,
      async fetch(_url, init) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      },
    });
    await assert.rejects(
      timed.reconcile(providerInput(fixture)),
      (error) => error instanceof DeploymentProviderError
        && error.code === "PROVIDER_TIMEOUT",
    );

    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    const aborted = createHttpDeploymentProvider({
      baseUrl: "https://provider.example.test",
      token: providerToken,
      retries: 10,
      async fetch() {
        throw new Error("fetch must not run");
      },
    });
    await assert.rejects(
      aborted.reconcile({ ...providerInput(fixture), signal: controller.signal }),
      (error) => error === reason,
    );

    const bounded = createHttpDeploymentProvider({
      baseUrl: "https://provider.example.test",
      token: providerToken,
      maxResponseBytes: 1,
      retries: 0,
      async fetch() {
        return new Response("provider-private-error", { status: 500 });
      },
    });
    await assert.rejects(
      bounded.reconcile(providerInput(fixture)),
      (error) => error instanceof DeploymentProviderError
        && error.code === "PROVIDER_RESPONSE_TOO_LARGE"
        && !error.message.includes("provider-private-error"),
    );
  } finally {
    await fixture.close();
  }
});

test("packaged runner has useful non-secret help and rejects arguments before network access", async () => {
  const script = new URL("../scripts/clank-runner.mjs", import.meta.url);
  const help = await execFileAsync(process.execPath, [script.pathname, "--help"], {
    env: {},
  });
  assert.match(help.stdout, /Usage: clank-runner/u);
  assert.match(help.stdout, /CLANK_PROVIDER_URL/u);
  assert.match(help.stdout, /CLANK_RUNNER_MAX_RUNTIME_BYTES/u);
  assert.match(help.stdout, /--check/u);
  assert.match(help.stdout, /remove CLANK_RUNNER_REGISTRATION_TOKEN/u);
  assert.equal(help.stdout.includes(providerToken), false);

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname, "unexpected"], {
      env: {},
    }),
    (error) => error.code === 1
      && /accepts only --check/u.test(error.stderr),
  );

  const enrollmentToken = "clnke_runner_check_token_12345678901234567890";
  const checked = await execFileAsync(
    process.execPath,
    [script.pathname, "--check", "--json"],
    {
      env: {
        CLANK_CONTROL_URL: "https://control.example.test",
        CLANK_RUNNER_NODE_ID: "runner-check-01",
        CLANK_RUNNER_REGION: "us-central",
        CLANK_RUNNER_REGISTRATION_TOKEN: enrollmentToken,
        CLANK_PROVIDER_URL: "https://provider.example.test",
        CLANK_PROVIDER_TOKEN: providerToken,
      },
    },
  );
  const diagnostic = JSON.parse(checked.stdout);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.nodeId, "runner-check-01");
  assert.equal(diagnostic.control.status, "not_contacted");
  assert.equal(diagnostic.provider.status, "configured_not_contacted");
  assert.equal(diagnostic.credentials.status, "ready_for_one_time_enrollment");
  assert.equal(checked.stdout.includes(enrollmentToken), false);
  assert.equal(checked.stdout.includes(providerToken), false);
});

test("packaged provider documents its private trust boundary before requiring configuration", async () => {
  const script = new URL("../scripts/clank-provider.mjs", import.meta.url);
  const help = await execFileAsync(process.execPath, [script.pathname, "--help"], {
    env: {},
  });
  assert.match(help.stdout, /Usage: clank-provider/u);
  assert.match(help.stdout, /CLANK_PROVIDER_TOKEN/u);
  assert.match(help.stdout, /CLANK_PROVIDER_IMAGE/u);
  assert.match(help.stdout, /CLANK_PROVIDER_MAX_ARTIFACT_BYTES/u);
  assert.match(help.stdout, /CLANK_PROVIDER_HTTP_REQUEST_TIMEOUT_MS/u);
  assert.match(help.stdout, /private network/u);

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname, "unexpected"], {
      env: {},
    }),
    (error) => error.code === 1
      && /accepts only --help/u.test(error.stderr),
  );
});

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "clank-provider-release-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), "export default {};\n");
  await writeFile(join(root, "migrations", "001-init.sql"), "CREATE TABLE task (id TEXT PRIMARY KEY);\n");
  const config = {
    version: 1,
    entry: "dist/server.js",
    include: ["dist", "migrations"],
    database: {
      path: "app.sqlite",
      migrations: "migrations",
      allowUnsafeMigrations: false,
    },
    health: { path: "/healthz", timeoutMs: 15_000 },
    env: {},
  };
  const bytes = await createDeploymentBundle(root, config, {
    frameworkVersion: "0.9.4-test",
    nodeVersion: "22.16.0",
  });
  return {
    bytes,
    digest: await deploymentDigest(bytes),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runtimeFixture(fixture, generation) {
  return createDeploymentRuntimeCapsule({
    projectId: "project_provider_01",
    releaseId: "release_provider_01",
    generation,
    environment: {
      APP_SECRET: "runtime-secret-canary",
      NODE_ENV: "production",
    },
    database: {
      path: "app.sqlite",
      mode: "preserve",
    },
    ingress: {
      route: "/projects/project_provider_01",
      token: "clanki_provider_ingress_123456789012345678901234",
    },
    artifact: fixture.bytes,
  });
}

function claimedOperation(overrides = {}) {
  return {
    id: "op_provider_01",
    projectId: "project_provider_01",
    action: "reconcile",
    state: "leased",
    payload: {
      releaseId: "release_provider_01",
      state: "running",
      generation: 1,
    },
    nodeId: "node_provider_01",
    attempts: 2,
    maxAttempts: 10,
    fence: 7,
    nextAttemptAt: Date.now(),
    leaseToken: "clnko_provider-secret-lease-token-12345678901234567890",
    leaseExpiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function providerInput(fixture) {
  return {
    operation: {
      id: "op_provider_01",
      projectId: "project_provider_01",
      fence: 11,
      attempt: 2,
      maxAttempts: 10,
    },
    desired: {
      generation: 3,
      releaseId: "release_provider_01",
      state: "running",
    },
    artifact: {
      bytes: fixture.bytes,
      sha256: fixture.digest,
      bundle: { protocol: "clank-deploy/1" },
    },
    signal: new AbortController().signal,
  };
}

function providerWireHeaders(fixture, token) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "x-clank-operation-id": "op_provider_01",
    "x-clank-operation-fence": "11",
    "x-clank-operation-attempt": "2",
    "x-clank-operation-max-attempts": "10",
    "x-clank-project-id": "project_provider_01",
    "x-clank-generation": "3",
    "x-clank-desired-state": fixture ? "running" : "stopped",
  });
  if (fixture) {
    headers.set("content-type", "application/vnd.clank.deploy+gzip");
    headers.set("x-clank-content-sha256", fixture.digest);
    headers.set("x-clank-release-id", "release_provider_01");
  }
  return headers;
}

function providerLifecycleInput(action, generation) {
  return {
    operation: {
      id: `op_provider_${action}_${generation}`,
      projectId: "project_provider_01",
      fence: generation,
      attempt: 2,
      maxAttempts: 10,
    },
    generation,
    confirmation: action === "rollback"
      ? `rollback project_provider_01 ${generation}`
      : "delete project_provider_01",
    signal: new AbortController().signal,
  };
}

function providerLifecycleWireHeaders(action, token, generation) {
  return new Headers({
    authorization: `Bearer ${token}`,
    "x-clank-operation-id": `op_provider_${action}_${generation}`,
    "x-clank-operation-fence": String(generation),
    "x-clank-operation-attempt": "2",
    "x-clank-operation-max-attempts": "10",
    "x-clank-project-id": "project_provider_01",
    "x-clank-generation": String(generation),
  });
}
