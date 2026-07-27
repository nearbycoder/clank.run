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
