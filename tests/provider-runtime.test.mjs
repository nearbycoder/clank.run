import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeploymentRuntimeIngress,
  DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL,
} from "../dist/provider-runtime.js";
import { createManagedIngress } from "../dist/data-plane.js";

const TOKEN_ONE = "runtime_ingress_token_0123456789abcdef";
const TOKEN_TWO = "runtime_ingress_token_fedcba9876543210";

function binding(overrides = {}) {
  return {
    protocol: "clank-runtime/1",
    projectId: "project_runtime_01",
    releaseId: "release_runtime_01",
    generation: 1,
    path: "/v1/runtimes/project_runtime_01",
    token: TOKEN_ONE,
    upstream: "http://127.0.0.1:4601",
    ...overrides,
  };
}

function privateRequest(path = "/tasks", options = {}) {
  return new Request(`https://provider.example/v1/runtimes/project_runtime_01${path}`, {
    method: options.method,
    headers: {
      "x-clank-project-id": "project_runtime_01",
      "x-clank-runtime-protocol": "clank-runtime/1",
      "x-clank-runtime-generation": "1",
      "x-clank-runtime-ingress": TOKEN_ONE,
      ...options.headers,
    },
    body: options.body,
    duplex: options.body instanceof ReadableStream ? "half" : undefined,
    signal: options.signal,
  });
}

test("provider runtime ingress authenticates an exact generation and strips its private binding", async () => {
  const calls = [];
  const ingress = createDeploymentRuntimeIngress({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("runtime response", {
        headers: {
          connection: "close, x-private-response",
          server: "private-runtime",
          "x-private-response": "remove me",
          "x-clank-project-id": "project_runtime_01",
          "x-clank-runtime-ingress": TOKEN_ONE,
        },
      });
    },
  });
  const activated = await ingress.activate(binding());
  assert.equal(activated.protocol, DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL);
  assert.equal(activated.generation, 1);
  assert.equal(activated.inFlight, 0);
  assert.equal(activated.latest, true);
  assert.equal("token" in activated, false);
  assert.equal("upstream" in activated, false);
  assert.doesNotMatch(JSON.stringify(ingress.inspect()), new RegExp(TOKEN_ONE));

  const response = await ingress.handle(privateRequest("//attacker.example/tasks?done=false", {
    method: "POST",
    headers: {
      authorization: "Bearer application-user",
      connection: "close, x-private-request",
      "x-private-request": "remove me",
      "content-type": "text/plain",
    },
    body: "new task",
  }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "runtime response");
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:4601//attacker.example/tasks?done=false",
    "the public suffix cannot replace the fixed loopback origin",
  );
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer application-user");
  assert.equal(calls[0].init.headers.get("connection"), null);
  assert.equal(calls[0].init.headers.get("x-private-request"), null);
  assert.equal(calls[0].init.headers.get("x-clank-project-id"), null);
  assert.equal(calls[0].init.headers.get("x-clank-runtime-protocol"), null);
  assert.equal(calls[0].init.headers.get("x-clank-runtime-generation"), null);
  assert.equal(calls[0].init.headers.get("x-clank-runtime-ingress"), null);
  assert.equal(new TextDecoder().decode(calls[0].init.body), "new task");
  assert.equal(response.headers.get("server"), null);
  assert.equal(response.headers.get("x-private-response"), null);
  assert.equal(response.headers.get("x-clank-project-id"), null);
  assert.equal(response.headers.get("x-clank-runtime-ingress"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ingress.inspect()[0].inFlight, 0);
  assert.equal(await ingress.close(), true);
});

test("managed ingress and provider runtime ingress bind public traffic end to end", async () => {
  let generation = 1;
  let token = TOKEN_ONE;
  const applicationCalls = [];
  const provider = createDeploymentRuntimeIngress({
    fetch: async (url, init) => {
      applicationCalls.push({ url: String(url), init });
      return new Response("application");
    },
  });
  await provider.activate(binding());
  const edge = createManagedIngress({
    routes: () => [{
      id: "route_runtime_e2e",
      projectId: "project_runtime_01",
      hosts: ["runtime.apps.example.com"],
      upstream: "https://provider.internal.example",
      active: true,
      runtime: {
        protocol: "clank-runtime/1",
        generation,
        path: "/v1/runtimes/project_runtime_01",
        token,
      },
    }],
    allowedUpstreamHosts: ["provider.internal.example"],
    fetch: async (url, init) => provider.handle(new Request(url, init)),
  });

  const first = await edge.handle(new Request(
    "https://runtime.apps.example.com/tasks?owner=me",
    { headers: { authorization: "Bearer application-user" } },
  ));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "application");
  assert.equal(applicationCalls[0].url, "http://127.0.0.1:4601/tasks?owner=me");
  assert.equal(
    applicationCalls[0].init.headers.get("x-forwarded-host"),
    "runtime.apps.example.com",
  );
  assert.equal(
    applicationCalls[0].init.headers.get("authorization"),
    "Bearer application-user",
  );
  assert.equal(applicationCalls[0].init.headers.get("x-clank-runtime-ingress"), null);

  await provider.activate(binding({
    releaseId: "release_runtime_02",
    generation: 2,
    token: TOKEN_TWO,
    upstream: "http://127.0.0.1:4602",
  }));
  const overlapping = await edge.handle(new Request("https://runtime.apps.example.com/tasks"));
  assert.equal(overlapping.status, 200);
  assert.equal(await overlapping.text(), "application");
  assert.equal(applicationCalls[1].url, "http://127.0.0.1:4601/tasks");

  generation = 2;
  token = TOKEN_TWO;
  const switched = await edge.handle(new Request("https://runtime.apps.example.com/tasks"));
  assert.equal(switched.status, 200);
  assert.equal(await switched.text(), "application");
  assert.equal(applicationCalls[2].url, "http://127.0.0.1:4602/tasks");
  assert.deepEqual(
    await provider.deactivate("project_runtime_01", 1),
    { removed: true, drained: true },
  );
  await provider.close();
});

test("provider runtime ingress fails closed on missing, forged, and stale binding headers", async () => {
  let calls = 0;
  const ingress = createDeploymentRuntimeIngress({
    fetch: async () => {
      calls++;
      return new Response("must not run");
    },
  });
  await ingress.activate(binding());
  const variants = [
    { "x-clank-project-id": "project_attacker" },
    { "x-clank-runtime-protocol": "clank-runtime/0" },
    { "x-clank-runtime-generation": "2" },
    { "x-clank-runtime-generation": "01" },
    { "x-clank-runtime-ingress": TOKEN_TWO },
    { "x-clank-runtime-ingress": "short" },
  ];
  for (const headers of variants) {
    const response = await ingress.handle(privateRequest("/", { headers }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "RUNTIME_UNAVAILABLE");
  }
  const unknown = await ingress.handle(new Request("https://provider.example/v1/runtimes/unknown"));
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(calls, 0);
  await ingress.close();
});

test("provider runtime ingress activates monotonically, rejects conflicts, and drains replaced generations", async () => {
  let oldBody;
  const calls = [];
  const ingress = createDeploymentRuntimeIngress({
    maxBindings: 3,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("http://127.0.0.1:4602/")) {
        return new Response("generation two");
      }
      return new Response(new ReadableStream({
        start(controller) {
          oldBody = controller;
          controller.enqueue(new TextEncoder().encode("generation one"));
        },
      }));
    },
  });
  const first = await ingress.activate(binding());
  assert.equal(
    (await ingress.activate(binding())).activatedAt,
    first.activatedAt,
    "an exact activation retry is idempotent",
  );
  await assert.rejects(
    ingress.activate(binding({ releaseId: "release_conflict" })),
    /conflicts/u,
  );

  const oldResponse = await ingress.handle(privateRequest("/events"));
  assert.equal(ingress.inspect()[0].inFlight, 1);
  await ingress.activate(binding({
    releaseId: "release_runtime_02",
    generation: 2,
    token: TOKEN_TWO,
    upstream: "http://127.0.0.1:4602",
  }));
  const missingRemoval = await ingress.deactivate("project_runtime_01", 3);
  assert.deepEqual(missingRemoval, { removed: false, drained: true });

  let drained = false;
  const draining = ingress.deactivate("project_runtime_01", 1, 500).then((value) => {
    drained = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false);
  const nextResponse = await ingress.handle(privateRequest("/tasks", {
    headers: {
      "x-clank-runtime-generation": "2",
      "x-clank-runtime-ingress": TOKEN_TWO,
    },
  }));
  assert.equal(nextResponse.status, 200);
  assert.equal(await nextResponse.text(), "generation two");
  oldBody.close();
  assert.equal(await oldResponse.text(), "generation one");
  assert.deepEqual(await draining, { removed: true, drained: true });
  assert.equal(ingress.inspect().length, 1);
  assert.equal(ingress.inspect()[0].generation, 2);
  assert.equal(ingress.inspect()[0].latest, true);
  assert.equal(calls.length, 2);

  await assert.rejects(ingress.activate(binding()), /stale/u);
  const removed = await ingress.deactivate("project_runtime_01", 2);
  assert.deepEqual(removed, { removed: true, drained: true });
  assert.deepEqual(ingress.inspect(), []);
  await ingress.close();
});

test("provider runtime ingress drains a request selected before token verification completes", async () => {
  let oldBody;
  let calls = 0;
  const ingress = createDeploymentRuntimeIngress({
    fetch: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) {
          oldBody = controller;
          controller.enqueue(new TextEncoder().encode("old"));
        },
      }));
    },
  });
  await ingress.activate(binding());
  const oldRequest = ingress.handle(privateRequest("/during-activation"));
  await ingress.activate(binding({
    releaseId: "release_runtime_02",
    generation: 2,
    token: TOKEN_TWO,
    upstream: "http://127.0.0.1:4602",
  }));
  let drained = false;
  const draining = ingress.deactivate("project_runtime_01", 1, 500).then((value) => {
    drained = true;
    return value;
  });
  const oldResponse = await oldRequest;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(drained, false);
  oldBody.close();
  assert.equal(await oldResponse.text(), "old");
  assert.deepEqual(await draining, { removed: true, drained: true });
  await ingress.close();
});

test("provider runtime ingress validates bindings and enforces a bounded generation registry", async () => {
  const invalid = [
    binding({ protocol: "clank-runtime/0" }),
    binding({ generation: 0 }),
    binding({ path: "//attacker.example/runtime" }),
    binding({ path: "/v1/%2e%2e/runtime" }),
    binding({ token: "short" }),
    binding({ upstream: "https://127.0.0.1:4601" }),
    binding({ upstream: "http://provider.example:4601" }),
    { ...binding(), unexpected: true },
  ];
  for (const candidate of invalid) {
    const ingress = createDeploymentRuntimeIngress();
    await assert.rejects(ingress.activate(candidate), /Deployment runtime/u);
    assert.deepEqual(ingress.inspect(), []);
    await ingress.close();
  }

  const ingress = createDeploymentRuntimeIngress({ maxBindings: 2 });
  await ingress.activate(binding());
  await assert.rejects(
    ingress.activate(binding({
      projectId: "project_runtime_02",
      releaseId: "release_runtime_02",
    })),
    /path is already assigned/u,
  );
  await ingress.activate(binding({
    projectId: "project_runtime_02",
    releaseId: "release_runtime_02",
    path: "/v1/runtimes/project_runtime_02",
    upstream: "http://[::1]:4602",
  }));
  await assert.rejects(
    ingress.activate(binding({
      projectId: "project_runtime_03",
      releaseId: "release_runtime_03",
      path: "/v1/runtimes/project_runtime_03",
    })),
    /limit reached/u,
  );
  await ingress.close();

  const reusable = createDeploymentRuntimeIngress({ maxBindings: 1 });
  await reusable.activate(binding());
  assert.throws(
    () => reusable.forget("project_runtime_01", 1),
    /still has a live generation/u,
  );
  await reusable.deactivate("project_runtime_01", 1);
  await assert.rejects(
    reusable.activate(binding({
      projectId: "project_runtime_02",
      releaseId: "release_runtime_02",
      path: "/v1/runtimes/project_runtime_02",
    })),
    /project limit/u,
  );
  assert.equal(reusable.forget("project_runtime_01", 2), false);
  assert.equal(reusable.forget("project_runtime_01", 1), true);
  await reusable.activate(binding({
    projectId: "project_runtime_02",
    releaseId: "release_runtime_02",
    path: "/v1/runtimes/project_runtime_02",
  }));
  await reusable.close();
});

test("provider runtime ingress bounds URLs and bodies and keeps upstream failures private", async () => {
  const observed = [];
  let calls = 0;
  const ingress = createDeploymentRuntimeIngress({
    maxUrlLength: 256,
    maxBodyBytes: 8,
    timeoutMs: 100,
    onError: (error) => observed.push(error),
    fetch: async (_url, init) => {
      calls++;
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("private runtime hung")), {
          once: true,
        });
      });
    },
  });
  await ingress.activate(binding());

  const longUrl = await ingress.handle(privateRequest(`/${"a".repeat(300)}`));
  assert.equal(longUrl.status, 414);
  const declared = await ingress.handle(privateRequest("/upload", {
    method: "POST",
    headers: { "content-length": "9" },
    body: "too large",
  }));
  assert.equal(declared.status, 413);
  const malformedLength = await ingress.handle(privateRequest("/upload", {
    method: "POST",
    headers: { "content-length": "01" },
    body: "x",
  }));
  assert.equal(malformedLength.status, 400);
  assert.equal((await malformedLength.json()).error.code, "INVALID_REQUEST");
  const streamed = await ingress.handle(privateRequest("/upload", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("five!"));
        controller.enqueue(new TextEncoder().encode("more!"));
        controller.close();
      },
    }),
  }));
  assert.equal(streamed.status, 413);
  const timedOut = await ingress.handle(privateRequest("/slow"));
  assert.equal(timedOut.status, 504);
  const timeoutBody = await timedOut.text();
  assert.match(timeoutBody, /RUNTIME_TIMEOUT/u);
  assert.doesNotMatch(timeoutBody, /private runtime hung|runtime_ingress_token/u);
  assert.equal(calls, 1);
  assert.equal(observed.length, 1);
  await ingress.close();
});

test("provider runtime ingress revokes before drain and closes fail-closed", async () => {
  let body;
  const ingress = createDeploymentRuntimeIngress({
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode("open"));
      },
    })),
  });
  await ingress.activate(binding());
  const response = await ingress.handle(privateRequest("/stream"));
  const removing = ingress.deactivate("project_runtime_01", 1, 100);
  assert.equal((await ingress.handle(privateRequest("/new"))).status, 503);
  assert.deepEqual(await removing, { removed: true, drained: false });
  assert.throws(
    () => ingress.forget("project_runtime_01", 1),
    /still has a live generation/u,
    "a timed-out drain must retain the generation until its stream ends",
  );
  assert.equal(await ingress.drain("project_runtime_01", 1, 100), false);
  const retriedRemoval = ingress.deactivate("project_runtime_01", 1, 500);
  body.close();
  assert.equal(await response.text(), "open");
  assert.deepEqual(await retriedRemoval, { removed: false, drained: true });
  assert.equal(ingress.forget("project_runtime_01", 1), true);
  assert.equal(await ingress.close(), true);
  const closed = await ingress.handle(privateRequest("/"));
  assert.equal(closed.status, 503);
  assert.equal((await closed.json()).error.code, "RUNTIME_UNAVAILABLE");
  await assert.rejects(ingress.activate(binding()), /closed/u);
});

test("provider runtime ingress cannot reactivate a revoked generation or publish across close", async () => {
  const ingress = createDeploymentRuntimeIngress();
  await ingress.activate(binding());
  await ingress.deactivate("project_runtime_01", 1);
  await assert.rejects(ingress.activate(binding()), /deactivated/u);

  await ingress.activate(binding({
    releaseId: "release_runtime_02",
    generation: 2,
    token: TOKEN_TWO,
    upstream: "http://127.0.0.1:4602",
  }));
  await ingress.close();
  assert.deepEqual(ingress.inspect(), []);

  const closing = createDeploymentRuntimeIngress();
  const activation = closing.activate(binding());
  const closed = closing.close();
  await assert.rejects(activation, /closed/u);
  assert.equal(await closed, true);
  assert.deepEqual(closing.inspect(), []);
});
