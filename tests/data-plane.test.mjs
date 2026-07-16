import test from "node:test";
import assert from "node:assert/strict";
import {
  applyExternalMigrations,
  createDomainManager,
  createHttpDatabaseProvisioner,
  createHttpPostgresDriver,
  createManagedIngress,
  createMemoryDomainStore,
  planExternalMigrations,
} from "../dist/index.js";

test("managed ingress routes by verified host, strips hop headers, bounds bodies, and opens circuits", async () => {
  const calls = [];
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

  const tooLarge = await ingress.handle(new Request("https://todo.example.com/upload", {
    method: "POST",
    body: "more than eight bytes",
  }));
  assert.equal(tooLarge.status, 413);
  const unknown = await ingress.handle(new Request("https://other.example.com/"));
  assert.equal(unknown.status, 404);

  const failing = createManagedIngress({
    routes: () => [{
      id: "route_0002",
      projectId: "project_0002",
      hosts: ["down.example.com"],
      upstream: "http://127.0.0.1:4501",
      active: true,
    }],
    retries: 0,
    circuitFailures: 2,
    circuitResetMs: 10_000,
    fetch: async () => { throw new Error("connection refused"); },
  });
  assert.equal((await failing.handle(new Request("https://down.example.com/"))).status, 502);
  assert.equal((await failing.handle(new Request("https://down.example.com/"))).status, 502);
  const opened = await failing.handle(new Request("https://down.example.com/"));
  assert.equal(opened.status, 503);
  assert.equal((await opened.json()).error.code, "UPSTREAM_UNAVAILABLE");

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
  await assert.rejects(manager.verify(challenge.id), /DNS TXT verification failed/);
  published = [[challenge.recordValue]];
  const verified = await manager.verify(challenge.id);
  assert.equal(verified.status, "verified");
  assert.ok(verified.verifiedAt);
  const repeated = await manager.verify(challenge.id);
  assert.equal(repeated.verifiedAt, verified.verifiedAt);
  await assert.rejects(
    manager.begin("project_0002", "tasks.example.com"),
    /already assigned/,
  );
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
