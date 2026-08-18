import test from "node:test";
import assert from "node:assert/strict";
import {
  applyExternalMigrations,
  createDomainManager,
  createHttpDatabaseProvisioner,
  createHttpPostgresDriver,
  createManagedIngress,
  createMemoryDomainStore,
  defineAuth,
  defineBackend,
  defineDatabase,
  inspectDomainRouting,
  openBackend,
  planExternalMigrations,
  serve,
} from "../dist/index.js";

test("managed ingress preserves the public origin for application auth", async () => {
  const runtime = await openBackend(defineBackend({
    schema: defineDatabase({}),
    auth: defineAuth({
      password: {
        minLength: 8,
        cost: 1024,
        maxMemory: 4 * 1024 * 1024,
      },
    }),
  }).functions(() => ({})), { path: ":memory:", wal: false });
  const server = await serve(({ handle: (request) => runtime.handle(request) }), {
    port: 0,
    trustProxy: true,
    allowedHosts: ["todo.apps.example.test"],
  });
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_auth",
      projectId: "project_auth",
      hosts: ["todo.apps.example.test"],
      upstream: server.url,
      active: true,
    }],
  });

  try {
    const origin = "https://todo.apps.example.test";
    const registration = await ingress.handle(new Request(`${origin}/__clank/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "managed-ingress@example.test",
        password: "correct horse battery staple",
        profile: { name: "Managed ingress" },
      }),
    }));
    assert.equal(registration.status, 201, await registration.clone().text());
    assert.match(registration.headers.get("set-cookie"), /^__Host-clank-id=/);
    assert.equal(registration.headers.get("x-clank-route-id"), "route_auth");

    const rejected = await ingress.handle(new Request(`${origin}/__clank/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        email: "managed-ingress@example.test",
        password: "correct horse battery staple",
      }),
    }));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "ORIGIN_MISMATCH");
  } finally {
    await server.close();
    runtime.close();
  }
});

test("managed ingress routes by verified host, strips hop headers, bounds bodies, and opens circuits", async () => {
  const calls = [];
  const metrics = [];
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_0001",
      projectId: "project_0001",
      hosts: ["todo.example.com"],
      upstream: "http://127.0.0.1:4500",
      active: true,
    }],
    maxBodyBytes: 8,
    circuitFailures: 2,
    circuitResetMs: 10_000,
    onRequest: (metric) => metrics.push(metric),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("proxied", {
        status: 200,
        headers: { connection: "keep-alive", server: "private-runtime" },
      });
    },
  });
  const response = await ingress.handle(new Request(
    "https://todo.example.com/tasks?done=false",
    {
      method: "POST",
      headers: {
        connection: "close, x-private-hop",
        cookie: "clank-id=session",
        "content-type": "text/plain",
        "x-private-hop": "must-not-cross",
      },
      body: "new task",
    },
  ));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxied");
  assert.equal(response.headers.get("connection"), null);
  assert.equal(response.headers.get("server"), null);
  assert.equal(response.headers.get("x-clank-route-id"), "route_0001");
  assert.equal(calls[0].url, "http://127.0.0.1:4500/tasks?done=false");
  assert.equal(calls[0].init.headers.get("connection"), null);
  assert.equal(calls[0].init.headers.get("x-private-hop"), null);
  assert.equal(calls[0].init.headers.get("x-forwarded-host"), "todo.example.com");
  assert.equal(calls[0].init.headers.get("x-clank-project-id"), "project_0001");
  assert.equal(metrics[0].projectId, "project_0001");
  assert.equal(metrics[0].statusCode, 200);
  assert.equal(metrics[0].requestBytes, 8);
  assert.ok(metrics[0].durationMs >= 0);

  const originLocked = await ingress.handle(new Request(
    "https://todo.example.com//attacker.example/collect?source=path",
  ));
  assert.equal(originLocked.status, 200);
  assert.equal(
    calls.at(-1).url,
    "http://127.0.0.1:4500//attacker.example/collect?source=path",
    "request paths cannot replace the configured upstream origin",
  );

  const tooLarge = await ingress.handle(new Request("https://todo.example.com/upload", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("more than"));
        controller.enqueue(new TextEncoder().encode(" eight bytes"));
        controller.close();
      },
    }),
  }));
  assert.equal(tooLarge.status, 413);
  assert.equal(metrics.at(-1).statusCode, 413);
  const unknown = await ingress.handle(new Request("https://other.example.com/"));
  assert.equal(unknown.status, 404);

  let failingUpstream = "http://127.0.0.1:4501";
  const failing = createManagedIngress({
    routes: () => [{
      id: "route_0002",
      projectId: "project_0002",
      hosts: ["down.example.com"],
      upstream: failingUpstream,
      active: true,
    }],
    retries: 0,
    circuitFailures: 2,
    circuitResetMs: 10_000,
    fetch: async (url) => {
      if (String(url).startsWith("http://127.0.0.1:4502/")) return new Response("recovered");
      throw new Error("connection refused");
    },
  });
  assert.equal((await failing.handle(new Request("https://down.example.com/"))).status, 502);
  assert.equal((await failing.handle(new Request("https://down.example.com/"))).status, 502);
  const opened = await failing.handle(new Request("https://down.example.com/"));
  assert.equal(opened.status, 503);
  assert.equal((await opened.json()).error.code, "UPSTREAM_UNAVAILABLE");
  failingUpstream = "http://127.0.0.1:4502";
  const switched = await failing.handle(new Request("https://down.example.com/"));
  assert.equal(switched.status, 200);
  assert.equal(await switched.text(), "recovered");

  let attempts = 0;
  const retrying = createManagedIngress({
    routes: () => [{
      id: "route_0003",
      projectId: "project_0003",
      hosts: ["retry.example.com"],
      upstream: "http://127.0.0.1:4502",
      active: true,
    }],
    retries: 1,
    fetch: async () => {
      attempts++;
      return attempts === 1
        ? new Response("temporary", { status: 503, headers: { connection: "x-upstream-hop", "x-upstream-hop": "private" } })
        : new Response("recovered", { status: 200 });
    },
  });
  const recovered = await retrying.handle(new Request("https://retry.example.com/"));
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "recovered");
  assert.equal(attempts, 2);

  let upstreamSignal;
  const disconnecting = createManagedIngress({
    routes: () => [{
      id: "route_disconnect",
      projectId: "project_disconnect",
      hosts: ["disconnect.example.com"],
      upstream: "http://127.0.0.1:4503",
      active: true,
    }],
    retries: 2,
    fetch: async (_url, init) => {
      upstreamSignal = init.signal;
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const client = new AbortController();
  const disconnected = disconnecting.handle(new Request("https://disconnect.example.com/", {
    signal: client.signal,
  }));
  while (!upstreamSignal) await new Promise((resolve) => setTimeout(resolve, 0));
  client.abort(new Error("client disconnected"));
  assert.equal((await disconnected).status, 502);
  assert.equal(upstreamSignal.aborted, true);
});

test("managed ingress binds remote requests and health to one exact runtime generation", async () => {
  const token = "runtime_ingress_token_0123456789abcdef";
  const calls = [];
  const metrics = [];
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_remote",
      projectId: "project_remote",
      hosts: ["remote.example.com"],
      upstream: "https://provider.example.net",
      active: true,
      runtime: {
        protocol: "clank-runtime/1",
        generation: 42,
        path: "/v1/runtimes/project_remote",
        token,
      },
    }],
    allowedUpstreamHosts: ["provider.example.net"],
    onRequest: (metric) => metrics.push(metric),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/healthz")) throw new Error(`provider leaked ${token}`);
      return new Response("remote generation", {
        headers: {
          "content-length": "17",
          "x-clank-project-id": "project_attacker",
          "x-clank-runtime-generation": "999",
          "x-clank-runtime-ingress": token,
        },
      });
    },
  });

  const response = await ingress.handle(new Request(
    "https://remote.example.com//attacker.example/tasks?done=false",
    {
      headers: {
        "x-clank-project-id": "project_attacker",
        "x-clank-runtime-protocol": "attacker-runtime/9",
        "x-clank-runtime-generation": "999",
        "x-clank-runtime-ingress": "attacker-controlled-token",
      },
    },
  ));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "remote generation");
  assert.equal(response.headers.get("x-clank-project-id"), null);
  assert.equal(response.headers.get("x-clank-runtime-generation"), null);
  assert.equal(response.headers.get("x-clank-runtime-ingress"), null);
  assert.equal(
    calls[0].url,
    "https://provider.example.net/v1/runtimes/project_remote//attacker.example/tasks?done=false",
  );
  assert.equal(calls[0].init.headers.get("x-clank-project-id"), "project_remote");
  assert.equal(calls[0].init.headers.get("x-clank-runtime-protocol"), "clank-runtime/1");
  assert.equal(calls[0].init.headers.get("x-clank-runtime-generation"), "42");
  assert.equal(calls[0].init.headers.get("x-clank-runtime-ingress"), token);
  assert.doesNotMatch(JSON.stringify(metrics), new RegExp(token));

  const health = await ingress.health();
  assert.equal(
    calls[1].url,
    "https://provider.example.net/v1/runtimes/project_remote/healthz",
  );
  assert.equal(calls[1].init.headers.get("x-clank-project-id"), "project_remote");
  assert.equal(calls[1].init.headers.get("x-clank-runtime-generation"), "42");
  assert.equal(calls[1].init.headers.get("x-clank-runtime-ingress"), token);
  assert.deepEqual(health.route_remote, {
    ok: false,
    error: "Runtime health check failed.",
  });
  assert.doesNotMatch(JSON.stringify(health), new RegExp(token));
});

test("managed ingress resets a circuit when a remote runtime generation changes", async () => {
  let generation = 1;
  let calls = 0;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_generation",
      projectId: "project_generation",
      hosts: ["generation.example.com"],
      upstream: "https://provider.example.net",
      active: true,
      runtime: {
        protocol: "clank-runtime/1",
        generation,
        path: "/v1/runtimes/project_generation",
        token: "runtime_ingress_token_0123456789abcdef",
      },
    }],
    allowedUpstreamHosts: ["provider.example.net"],
    retries: 0,
    circuitFailures: 1,
    circuitResetMs: 10_000,
    fetch: async () => {
      calls++;
      return generation === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("generation two");
    },
  });

  assert.equal((await ingress.handle(new Request("https://generation.example.com/"))).status, 503);
  assert.equal((await ingress.handle(new Request("https://generation.example.com/"))).status, 503);
  assert.equal(calls, 1, "the open circuit rejects the same generation");
  generation = 2;
  const switched = await ingress.handle(new Request("https://generation.example.com/"));
  assert.equal(switched.status, 200);
  assert.equal(await switched.text(), "generation two");
  assert.equal(calls, 2, "a new generation gets a fresh circuit");
});

test("late remote generation responses cannot mutate the replacement circuit", async () => {
  let generation = 1;
  let oldResolve;
  let generationTwoCalls = 0;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_circuit_race",
      projectId: "project_circuit_race",
      hosts: ["circuit-race.example.com"],
      upstream: "https://provider.example.net",
      active: true,
      runtime: {
        protocol: "clank-runtime/1",
        generation,
        path: "/v1/runtimes/project_circuit_race",
        token: "runtime_ingress_token_0123456789abcdef",
      },
    }],
    allowedUpstreamHosts: ["provider.example.net"],
    retries: 0,
    circuitFailures: 1,
    circuitResetMs: 10_000,
    fetch: async (_url, init) => {
      const requestGeneration = init.headers.get("x-clank-runtime-generation");
      if (requestGeneration === "1") {
        return await new Promise((resolve) => { oldResolve = resolve; });
      }
      generationTwoCalls++;
      return new Response("generation two failed", { status: 503 });
    },
  });

  const oldRequest = ingress.handle(new Request("https://circuit-race.example.com/"));
  while (!oldResolve) await new Promise((resolve) => setTimeout(resolve, 0));
  generation = 2;
  assert.equal(
    (await ingress.handle(new Request("https://circuit-race.example.com/"))).status,
    503,
  );
  oldResolve(new Response("late generation one success"));
  assert.equal((await oldRequest).status, 200);
  assert.equal(
    (await ingress.handle(new Request("https://circuit-race.example.com/"))).status,
    503,
  );
  assert.equal(
    generationTwoCalls,
    1,
    "a late success from generation one cannot clear generation two's open circuit",
  );
});

test("managed ingress rejects malformed remote runtime bindings before proxying", async () => {
  const invalidBindings = [
    {
      protocol: "clank-runtime/0",
      generation: 1,
      path: "/v1/runtimes/project_invalid",
      token: "runtime_ingress_token_0123456789abcdef",
    },
    {
      protocol: "clank-runtime/1",
      generation: 0,
      path: "/v1/runtimes/project_invalid",
      token: "runtime_ingress_token_0123456789abcdef",
    },
    {
      protocol: "clank-runtime/1",
      generation: 1,
      path: "//attacker.example/runtime",
      token: "runtime_ingress_token_0123456789abcdef",
    },
    {
      protocol: "clank-runtime/1",
      generation: 1,
      path: "/v1/%2e%2e/runtime",
      token: "runtime_ingress_token_0123456789abcdef",
    },
    {
      protocol: "clank-runtime/1",
      generation: 1,
      path: "/v1/runtimes/project_invalid",
      token: "short",
    },
    {
      protocol: "clank-runtime/1",
      generation: 1,
      path: "/v1/runtimes/project_invalid",
      token: "runtime_ingress_token_0123456789abcdef",
      unexpected: true,
    },
  ];
  for (const runtime of invalidBindings) {
    let calls = 0;
    const ingress = createManagedIngress({
      routes: () => [{
        id: "route_invalid",
        projectId: "project_invalid",
        hosts: ["invalid.example.com"],
        upstream: "https://provider.example.net",
        active: true,
        runtime,
      }],
      allowedUpstreamHosts: ["provider.example.net"],
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    await assert.rejects(
      ingress.handle(new Request("https://invalid.example.com/")),
      /Ingress runtime/u,
    );
    assert.equal(calls, 0);
  }
});

test("managed ingress admission is metadata-minimal, fail-closed, and observable", async () => {
  const admissions = [];
  const metrics = [];
  let mode = "deny";
  let upstreamCalls = 0;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_admission",
      projectId: "project_admission",
      hosts: ["limited.example.com"],
      upstream: "http://127.0.0.1:4505",
      active: true,
    }],
    admitRequest: (request) => {
      admissions.push(request);
      if (mode === "throw") throw new Error("private limiter failure");
      if (mode === "malformed") {
        return {
          allowed: false,
          code: "bad code",
          message: "must stay private",
          retryAfterSeconds: 0,
        };
      }
      if (mode === "malformed-allow") return { allowed: "yes" };
      return mode === "deny"
        ? {
            allowed: false,
            code: "PROJECT_RATE_LIMIT_REACHED",
            message: "This project has reached its request rate limit.",
            retryAfterSeconds: 17,
          }
        : { allowed: true };
    },
    onRequest: (metric) => metrics.push(metric),
    fetch: async () => {
      upstreamCalls++;
      return new Response("accepted", {
        status: 200,
        headers: { "content-length": "8" },
      });
    },
  });

  const denied = await ingress.handle(new Request("https://limited.example.com/private?token=no", {
    method: "POST",
    headers: {
      authorization: "Bearer never-forward-to-policy",
      cookie: "private=session",
    },
    body: "hello",
  }));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "17");
  assert.equal((await denied.json()).error.code, "PROJECT_RATE_LIMIT_REACHED");
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(Object.keys(admissions[0]).sort(), [
    "method",
    "projectId",
    "recordedAt",
    "requestBytes",
    "routeId",
  ]);
  assert.equal(admissions[0].requestBytes, 5);
  assert.equal(metrics[0].admitted, false);

  mode = "allow";
  const accepted = await ingress.handle(new Request("https://limited.example.com/"));
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "accepted");
  assert.equal(upstreamCalls, 1);
  assert.equal(metrics.at(-1).admitted, true);
  assert.equal(metrics.at(-1).responseBytes, 8);

  mode = "throw";
  const unavailable = await ingress.handle(new Request("https://limited.example.com/"));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "ADMISSION_UNAVAILABLE");
  assert.equal(metrics.at(-1).admitted, false);

  mode = "malformed";
  const invalid = await ingress.handle(new Request("https://limited.example.com/"));
  assert.equal(invalid.status, 503);
  const invalidBody = await invalid.text();
  assert.equal(JSON.parse(invalidBody).error.code, "ADMISSION_UNAVAILABLE");
  assert.doesNotMatch(invalidBody, /private limiter failure|must stay private/);

  mode = "malformed-allow";
  const invalidAllow = await ingress.handle(new Request("https://limited.example.com/"));
  assert.equal(invalidAllow.status, 503);
  assert.equal((await invalidAllow.json()).error.code, "ADMISSION_UNAVAILABLE");
  assert.equal(upstreamCalls, 1);

  mode = "allow";
  const head = await ingress.handle(new Request("https://limited.example.com/", {
    method: "HEAD",
  }));
  assert.equal(head.status, 200);
  assert.equal(metrics.at(-1).responseBytes, 0);
});

test("managed ingress drains requests already assigned to a replaced upstream", async () => {
  let upstream = "http://127.0.0.1:4510";
  let oldBody;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_drain",
      projectId: "project_drain",
      hosts: ["drain.example.com"],
      upstream,
      active: true,
    }],
    fetch: async (url) => {
      if (String(url).startsWith("http://127.0.0.1:4511/")) return new Response("new");
      return new Response(new ReadableStream({
        start(controller) {
          oldBody = controller;
          controller.enqueue(new TextEncoder().encode("old"));
        },
      }));
    },
  });
  const oldResponse = await ingress.handle(new Request("https://drain.example.com/"));
  upstream = "http://127.0.0.1:4511";
  let drained = false;
  const draining = ingress.drain("http://127.0.0.1:4510", 500).then((result) => {
    drained = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false);
  oldBody.close();
  assert.equal(await oldResponse.text(), "old");
  assert.equal(await draining, true);
  const newResponse = await ingress.handle(new Request("https://drain.example.com/"));
  assert.equal(newResponse.status, 200);
  assert.equal(await newResponse.text(), "new");
});

test("managed ingress prepares one inactive route for concurrent requests and revalidates it", async () => {
  let active = false;
  let preparations = 0;
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_sleeping",
      projectId: "project_sleeping",
      hosts: ["sleeping.example.com"],
      upstream: "http://127.0.0.1:4520",
      active,
    }],
    prepareRoute: async (route) => {
      preparations++;
      assert.equal(route.id, "route_sleeping");
      await preparationGate;
      active = true;
    },
    fetch: async () => new Response("awake"),
  });

  const first = ingress.handle(new Request("https://sleeping.example.com/one"));
  const second = ingress.handle(new Request("https://sleeping.example.com/two"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(preparations, 1);
  releasePreparation();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(await Promise.all(responses.map((response) => response.text())), ["awake", "awake"]);
});

test("managed ingress rejects untrusted requests before waking an inactive route", async () => {
  let preparations = 0;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_guarded_sleeping",
      projectId: "project_guarded_sleeping",
      hosts: ["guarded-sleeping.example.com"],
      upstream: "http://127.0.0.1:4521",
      active: false,
    }],
    maxBodyBytes: 4,
    admitRequest: () => ({
      allowed: false,
      code: "PROJECT_RATE_LIMIT_REACHED",
      message: "Request capacity is exhausted.",
      retryAfterSeconds: 10,
    }),
    prepareRoute: async () => { preparations++; },
    fetch: async () => new Response("must not run"),
  });

  const oversized = await ingress.handle(new Request("https://guarded-sleeping.example.com/", {
    method: "POST",
    body: "12345",
  }));
  assert.equal(oversized.status, 413);
  const denied = await ingress.handle(new Request("https://guarded-sleeping.example.com/"));
  assert.equal(denied.status, 429);
  assert.equal(preparations, 0);
});

test("managed ingress returns a fixed error when route preparation fails or stays inactive", async () => {
  let failure = true;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_failed_wake",
      projectId: "project_failed_wake",
      hosts: ["failed-wake.example.com"],
      upstream: "http://127.0.0.1:4522",
      active: false,
    }],
    prepareRoute: async () => {
      if (failure) throw new Error("private process launch details");
    },
    fetch: async () => new Response("must not run"),
  });

  const failed = await ingress.handle(new Request("https://failed-wake.example.com/"));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "1");
  const failedBody = await failed.text();
  assert.equal(JSON.parse(failedBody).error.code, "APPLICATION_UNAVAILABLE");
  assert.doesNotMatch(failedBody, /private process launch details/);

  failure = false;
  const inactive = await ingress.handle(new Request("https://failed-wake.example.com/"));
  assert.equal(inactive.status, 503);
  assert.equal((await inactive.json()).error.code, "APPLICATION_UNAVAILABLE");
});

test("managed ingress reports active response streams", async () => {
  let bodyController;
  const upstream = "http://127.0.0.1:4523";
  const ingress = createManagedIngress({
    routes: () => [{
      id: "route_activity",
      projectId: "project_activity",
      hosts: ["activity.example.com"],
      upstream,
      active: true,
    }],
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode("active"));
      },
    })),
  });

  const response = await ingress.handle(new Request("https://activity.example.com/"));
  assert.equal(ingress.activeRequests(upstream), 1);
  bodyController.close();
  assert.equal(await response.text(), "active");
  assert.equal(ingress.activeRequests(upstream), 0);
});

test("custom-domain routing accepts the configured CNAME or edge addresses and reports mismatches", async () => {
  const records = new Map([
    ["tasks.customer.test:CNAME", ["edge.clank.test."]],
    ["edge.clank.test:A", ["192.0.2.44"]],
  ]);
  const resolver = {
    resolveCname: async (hostname) => records.get(`${hostname}:CNAME`) ?? [],
    resolve4: async (hostname) => records.get(`${hostname}:A`) ?? [],
    resolve6: async () => [],
  };
  const ready = await inspectDomainRouting("Tasks.Customer.Test.", {
    cname: "edge.clank.test",
  }, resolver);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.observed.cnames, ["edge.clank.test"]);

  records.set("tasks.customer.test:CNAME", ["other.example.test"]);
  const mismatched = await inspectDomainRouting("tasks.customer.test", {
    cname: "edge.clank.test",
  }, resolver);
  assert.equal(mismatched.status, "misconfigured");

  records.delete("tasks.customer.test:CNAME");
  records.set("tasks.customer.test:A", ["192.0.2.44"]);
  const flattened = await inspectDomainRouting("tasks.customer.test", {
    cname: "edge.clank.test",
  }, resolver);
  assert.equal(flattened.status, "ready");
});

test("custom domains require exact DNS TXT ownership before activation", async () => {
  const store = createMemoryDomainStore();
  let published = [];
  const manager = createDomainManager({
    store,
    resolveTxt: async () => published,
  });
  const challenge = await manager.begin("project_0001", "Tasks.Example.COM.");
  assert.equal(challenge.hostname, "tasks.example.com");
  assert.equal(challenge.recordName, "_clank.tasks.example.com");
  await assert.rejects(
    manager.begin("project_0002", "tasks.example.com"),
    /already assigned/,
  );
  await assert.rejects(manager.verify(challenge.id), /DNS TXT verification failed/);
  published = [[challenge.recordValue]];
  const verified = await manager.verify(challenge.id);
  assert.equal(verified.status, "verified");
  assert.ok(verified.verifiedAt);
  const repeated = await manager.verify(challenge.id);
  assert.equal(repeated.verifiedAt, verified.verifiedAt);
  await assert.rejects(manager.begin("project_0002", "tasks.example.com"), /already assigned/);
});

test("HTTP Postgres driver applies immutable migrations in one remote transaction", async () => {
  const ledger = [];
  const requests = [];
  const driver = createHttpPostgresDriver({
    url: "https://sql.example.test/query",
    token: "database-access-token",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const results = body.statements.map((statement) => {
        if (statement.text.startsWith("SELECT id, name")) {
          return { rows: ledger, rowCount: ledger.length };
        }
        if (statement.text.startsWith("INSERT INTO clank_migrations")) {
          const [id, name, checksum, applied_at] = statement.parameters;
          ledger.push({ id, name, checksum, applied_at });
        }
        if (statement.text.startsWith("SELECT 1")) {
          return { rows: [{ ok: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      return Response.json({ results });
    },
  });
  const migrations = [
    { id: "0001", name: "create_tasks", checksum: "a".repeat(64), sql: "CREATE TABLE tasks (id TEXT PRIMARY KEY)" },
    { id: "0002", name: "add_done", checksum: "b".repeat(64), sql: "ALTER TABLE tasks ADD COLUMN done BOOLEAN NOT NULL DEFAULT FALSE" },
  ];
  const applied = await applyExternalMigrations(driver, migrations);
  assert.equal(applied.pending.length, 2);
  assert.equal(requests.at(-1).transaction, true);
  assert.equal(requests.at(-1).statements.length, 4);
  assert.equal((await planExternalMigrations(driver, migrations)).pending.length, 0);
  await assert.rejects(
    planExternalMigrations(driver, [{ ...migrations[0], checksum: "c".repeat(64) }, migrations[1]]),
    /immutable migration history/,
  );
  assert.equal(await driver.health(), true);
});

test("HTTP Postgres responses stop streaming at the configured byte limit", async () => {
  let cancelled = false;
  const driver = createHttpPostgresDriver({
    url: "https://sql.example.test/query",
    token: "database-access-token",
    maxResponseBytes: 1_024,
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(700)); },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  });
  await assert.rejects(
    driver.query({ text: "SELECT 1", parameters: [] }),
    /Postgres response is too large/,
  );
  assert.equal(cancelled, true);
});

test("external database provisioner is idempotency-oriented and destruction is confirmed", async () => {
  const calls = [];
  const provisioner = createHttpDatabaseProvisioner({
    url: "https://data.example.test/api/",
    token: "provisioner-token",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/destroy")) return Response.json({ ok: true });
      return Response.json({
        id: "database_0001",
        region: "us-central",
        connectionUrl: "postgresql://app:secret@db.example.test:5432/app?sslmode=require",
        createdAt: 1_700_000_000_000,
      });
    },
  });
  const binding = await provisioner.provision({
    projectId: "project_0001",
    region: "us-central",
    idempotencyKey: "provision-project-0001",
  });
  assert.equal(binding.engine, "postgres");
  assert.equal(new URL(binding.connectionUrl).hostname, "db.example.test");
  assert.equal(calls[0].body.idempotencyKey, "provision-project-0001");
  await assert.rejects(provisioner.destroy(binding.id, "yes"), /Confirmation/);
  await provisioner.destroy(binding.id, `destroy ${binding.id}`);
  assert.match(calls[1].url, /database_0001\/destroy$/);
});
