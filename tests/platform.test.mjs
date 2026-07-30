import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createDeploymentCoordinatorClient,
  createDeploymentBundle,
  defineDatabase,
  deploymentDigest,
  openDeploymentOrchestrator,
  openPlatform,
  openSQLite,
  parseDeploymentConfig,
} from "../dist/index.js";

const IMPERSONATION_RECENT_AUTH_MS_FOR_TEST = 30 * 60_000;

function jsonRequest(path, { method = "GET", body, token, cookie, csrf, origin = "http://127.0.0.1:4200" } = {}) {
  return new Request(`http://127.0.0.1:4200${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
      "x-clank-client-ip": "127.0.0.1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(platform, request, expected = 200) {
  const response = await platform.handle(request);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function authorizeCli(platform, email) {
  const registered = await platform.handle(jsonRequest("/__clank/auth/register", {
    method: "POST",
    body: {
      email,
      password: "correct horse battery staple",
      profile: { name: email.split("@")[0] },
    },
  }));
  assert.equal(registered.status, 201);
  const session = await registered.json();
  const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
  const started = await payload(platform, jsonRequest("/api/device/start", {
    method: "POST",
    body: { clientName: "test CLI" },
  }), 201);
  await payload(platform, jsonRequest("/api/device/approve", {
    method: "POST",
    body: { code: started.userCode },
    cookie,
    csrf: session.csrfToken,
  }));
  const token = await payload(platform, jsonRequest("/api/device/token", {
    method: "POST",
    body: { deviceCode: started.deviceCode },
  }));
  return { accessToken: token.accessToken, user: session.user, cookie, csrfToken: session.csrfToken };
}

async function appArtifact(root, label, migrations, allowUnsafeMigrations = false, options = {}) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), `
    import { createServer } from "node:http";
    await new Promise((resolve) => setTimeout(resolve, ${Number(options.startupDelayMs ?? 0)}));
    const server = createServer(async (request, response) => {
      if (request.url === "/_clank-rollout-slow") {
        await new Promise((resolve) => setTimeout(resolve, ${Number(options.responseDelayMs ?? 0)}));
      }
      if (request.url === "/_runtime-environment") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          trustProxy: process.env.TRUST_PROXY,
          allowedHosts: process.env.ALLOWED_HOSTS,
          managedIngress: process.env.CLANK_MANAGED_INGRESS,
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.url === "/healthz" ? "ok" : ${JSON.stringify(label)});
      if (request.url === "/crash") setImmediate(() => process.exit(17));
    });
    if (process.env.AUDIT_SHORT_SECRET) console.log("secret=" + process.env.AUDIT_SHORT_SECRET);
    server.listen(Number(process.env.PORT), process.env.HOST);
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  if (options.jobs) {
    await writeFile(join(root, "dist", "jobs.js"), `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.env.CLANK_DATABASE_PATH, { timeout: 5_000 });
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec(\`CREATE TABLE IF NOT EXISTS background_processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        concurrency TEXT,
        queues TEXT,
        release TEXT NOT NULL,
        stopped_at INTEGER
      )\`);
      const inserted = database.prepare(
        "INSERT INTO background_processes (role, concurrency, queues, release) VALUES (?, ?, ?, ?)",
      ).run(
        process.env.CLANK_PROCESS_ROLE,
        process.env.CLANK_WORKER_CONCURRENCY ?? null,
        process.env.CLANK_WORKER_QUEUES ?? null,
        ${JSON.stringify(label)},
      );
      console.log("background-ready:" + process.env.CLANK_PROCESS_ROLE);
      const keepAlive = setInterval(() => {}, 60_000);
      await new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
      clearInterval(keepAlive);
      database.prepare("UPDATE background_processes SET stopped_at = ? WHERE id = ?")
        .run(Date.now(), inserted.lastInsertRowid);
      database.close();
    `);
  }
  for (const [name, sql] of migrations) await writeFile(join(root, "migrations", name), sql);
  const config = parseDeploymentConfig({
    version: 1,
    entry: "dist/server.js",
    include: ["dist", "migrations"],
    database: { path: "app.sqlite", migrations: "migrations", allowUnsafeMigrations },
    health: { path: "/healthz", timeoutMs: 5_000 },
    env: {},
    ...(options.jobs
      ? {
          jobs: {
            entry: "dist/jobs.js",
            workers: options.jobs.workers ?? 1,
            concurrency: options.jobs.concurrency ?? 1,
            queues: options.jobs.queues ?? [],
            scheduler: options.jobs.scheduler ?? true,
          },
        }
      : {}),
  });
  return createDeploymentBundle(root, config, {
    frameworkVersion: "0.5.0",
    nodeVersion: process.version,
  });
}

async function authenticatedAppArtifact(root) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), `
    import {
      createApp,
      defineAuth,
      defineBackend,
      defineDatabase,
      openBackend,
      serve,
    } from "@clank.run/framework";

    const backend = defineBackend({
      schema: defineDatabase({}),
      auth: defineAuth({
        password: {
          minLength: 8,
          cost: 1024,
          maxMemory: 4 * 1024 * 1024,
        },
      }),
    }).functions(() => ({}));
    const runtime = await openBackend(backend, {
      path: process.env.CLANK_DATABASE_PATH,
      wal: false,
    });
    const app = createApp()
      .get("/healthz", () => new Response("ok"))
      .route("*", "*", ({ request }) => runtime.handle(request));
    const allowedHosts = process.env.ALLOWED_HOSTS
      ?.split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    const server = await serve(app, {
      hostname: "127.0.0.1",
      port: Number(process.env.PORT),
      trustProxy: process.env.TRUST_PROXY === "1",
      ...(allowedHosts?.length ? { allowedHosts } : {}),
    });
    process.on("SIGTERM", () => {
      void server.close().then(() => {
        runtime.close();
        process.exit(0);
      });
    });
  `);
  await writeFile(
    join(root, "migrations", "0001_app_metadata.sql"),
    "CREATE TABLE app_metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);\n",
  );
  const config = parseDeploymentConfig({
    version: 1,
    entry: "dist/server.js",
    include: ["dist", "migrations"],
    database: {
      path: "app.sqlite",
      migrations: "migrations",
      allowUnsafeMigrations: false,
    },
    health: { path: "/healthz", timeoutMs: 5_000 },
    env: {},
  });
  return createDeploymentBundle(root, config, {
    frameworkRoot: fileURLToPath(new URL("..", import.meta.url)),
    frameworkVersion: "0.7.0",
    nodeVersion: process.version,
  });
}

async function deploy(platform, projectId, token, artifact, key) {
  const digest = await deploymentDigest(artifact);
  const response = await platform.handle(new Request(
    `http://127.0.0.1:4200/api/projects/${projectId}/releases`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/vnd.clank.deploy+gzip",
        "content-length": String(artifact.byteLength),
        "x-clank-content-sha256": digest,
        "x-clank-idempotency-key": key,
      },
      body: artifact,
    },
  ));
  return { response, body: await response.json() };
}

function memoryObjectStore() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    store: Object.freeze({
      kind: "memory",
      async put(key, input, options = {}) {
        const bytes = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
        const now = Date.now();
        const current = values.get(key);
        const metadata = Object.freeze({
          key,
          size: bytes.byteLength,
          sha256: await deploymentDigest(bytes),
          contentType: options.contentType ?? "application/octet-stream",
          createdAt: current?.metadata.createdAt ?? now,
          updatedAt: now,
        });
        values.set(key, { metadata, bytes });
        calls.push({ operation: "put", key });
        return metadata;
      },
      async get(key) {
        calls.push({ operation: "get", key });
        const value = values.get(key);
        return value
          ? { metadata: value.metadata, bytes: new Uint8Array(value.bytes) }
          : null;
      },
      async stat(key) {
        calls.push({ operation: "stat", key });
        return values.get(key)?.metadata ?? null;
      },
      async delete(key) {
        calls.push({ operation: "delete", key });
        return values.delete(key);
      },
    }),
  };
}

test("platform retains and serves exact release artifacts only to their leased deployment node", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-runner-artifacts-"));
  const dataDirectory = join(root, "platform");
  const runnerRegistrationToken = "clank_platform_runner_artifact_registration_1234567890";
  const errors = [];
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4890,
    appPortEnd: 4891,
    deploymentAgents: {
      registrationToken: runnerRegistrationToken,
      maxArtifactBytes: 4 * 1024 * 1024,
    },
    backups: { intervalMs: false },
    onError: (error) => errors.push(error),
  });
  let control;
  let orchestrator;
  try {
    const owner = await authorizeCli(platform, "runner-artifact-platform@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Runner artifact", slug: "runner-artifact" },
    }), 201);
    const artifact = await appArtifact(
      join(root, "app"),
      "runner-artifact-release",
      [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]],
    );
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "runner-artifact-release-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    assert.ok(deployed.body.release.storageBytes > artifact.byteLength);

    control = await openSQLite(defineDatabase({}), {
      path: join(dataDirectory, "control.sqlite"),
    });
    orchestrator = openDeploymentOrchestrator(control);
    const client = createDeploymentCoordinatorClient({
      baseUrl: "http://127.0.0.1:4200",
      fetch: (url, init) => platform.handle(new Request(url, init)),
      maxArtifactBytes: 4 * 1024 * 1024,
    });
    const session = await client.register(runnerRegistrationToken, {
      id: "runner-platform-artifact-01",
      region: "local",
    });
    const queued = await orchestrator.enqueue({
      projectId: created.project.id,
      action: "deploy",
      payload: { releaseId: deployed.body.release.id },
      idempotencyKey: "platform-runner-artifact-operation",
      nodeId: session.node.id,
    });
    const [operation] = await client.claim(session.node.id, session.token, 1);
    assert.equal(operation.id, queued.operation.id);
    const downloaded = await client.artifact(session.node.id, session.token, operation);
    assert.equal(Buffer.from(downloaded.bytes).equals(artifact), true);
    assert.equal(downloaded.sha256, await deploymentDigest(artifact));
    assert.equal(errors.length, 0);

    const artifactPath = join(
      dataDirectory,
      "projects",
      created.project.id,
      "artifacts",
      `${deployed.body.release.id}.clank.gz`,
    );
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    await chmod(artifactPath, 0o644);
    await assert.rejects(
      client.artifact(session.node.id, session.token, operation),
      (error) => error?.status === 500 && error?.code === "COORDINATOR_FAILED",
    );
    assert.match(String(errors.at(-1)), /unsafe or inconsistent/u);
  } finally {
    orchestrator?.close();
    control?.close();
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform can retain, verify, clean, and delete runner artifacts through an object store", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-object-artifacts-"));
  const dataDirectory = join(root, "platform");
  const repository = memoryObjectStore();
  const runnerRegistrationToken = "clank_platform_object_artifact_registration_123456";
  const errors = [];
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4892,
    appPortEnd: 4893,
    deploymentAgents: {
      registrationToken: runnerRegistrationToken,
      maxArtifactBytes: 4 * 1024 * 1024,
      artifacts: {
        namespace: "test-release-objects-v1",
        store: repository.store,
      },
    },
    backups: { intervalMs: false },
    onError: (error) => errors.push(error),
  });
  let control;
  let orchestrator;
  try {
    const owner = await authorizeCli(platform, "object-artifact-platform@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Object artifacts", slug: "object-artifacts" },
    }), 201);
    const migrations = [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]];
    const firstArtifact = await appArtifact(join(root, "app"), "object-release-one", migrations);
    const first = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      firstArtifact,
      "object-artifact-release-0001",
    );
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.release.runnerArtifact, {
      bytes: firstArtifact.byteLength,
      storage: "object",
    });
    const secondArtifact = await appArtifact(join(root, "app"), "object-release-two", migrations);
    const second = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      secondArtifact,
      "object-artifact-release-0002",
    );
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    assert.equal(repository.values.size, 2);
    await assert.rejects(
      stat(join(dataDirectory, "projects", created.project.id, "artifacts")),
      (error) => error.code === "ENOENT",
    );

    const rows = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    const retained = rows.prepare(`SELECT id, runner_artifact_store, runner_artifact_key
      FROM clank_platform_releases WHERE project_id = ? ORDER BY created_at`).all(created.project.id);
    rows.close();
    assert.equal(retained.length, 2);
    assert.ok(retained.every((row) => row.runner_artifact_store === "test-release-objects-v1"));
    assert.ok(retained.every((row) => (
      typeof row.runner_artifact_key === "string"
      && row.runner_artifact_key.startsWith(`runner-artifacts/${created.project.id}/`)
    )));

    control = await openSQLite(defineDatabase({}), {
      path: join(dataDirectory, "control.sqlite"),
    });
    orchestrator = openDeploymentOrchestrator(control);
    const client = createDeploymentCoordinatorClient({
      baseUrl: "http://127.0.0.1:4200",
      fetch: (url, init) => platform.handle(new Request(url, init)),
      maxArtifactBytes: 4 * 1024 * 1024,
    });
    const session = await client.register(runnerRegistrationToken, {
      id: "runner-object-artifact-01",
      region: "local",
    });
    await orchestrator.enqueue({
      projectId: created.project.id,
      action: "deploy",
      payload: { releaseId: second.body.release.id },
      idempotencyKey: "object-artifact-operation",
      nodeId: session.node.id,
    });
    const [operation] = await client.claim(session.node.id, session.token, 1);
    const downloaded = await client.artifact(session.node.id, session.token, operation);
    assert.equal(Buffer.from(downloaded.bytes).equals(secondArtifact), true);

    const activeKey = retained.find((row) => row.id === second.body.release.id).runner_artifact_key;
    repository.values.get(activeKey).bytes[0] ^= 0xff;
    await assert.rejects(
      client.artifact(session.node.id, session.token, operation),
      (error) => error?.status === 500 && error?.code === "COORDINATOR_FAILED",
    );
    assert.match(String(errors.at(-1)), /integrity verification/u);

    await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release object-artifacts ${first.body.release.id}`,
          allowRollbackLoss: true,
        },
      },
    ));
    assert.equal(repository.values.size, 1);

    orchestrator.close();
    orchestrator = undefined;
    control.close();
    control = undefined;
    await payload(platform, jsonRequest(`/api/projects/${created.project.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site object-artifacts",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(repository.values.size, 0);
    assert.equal(
      repository.calls.filter((call) => call.operation === "delete").length,
      2,
    );
  } finally {
    orchestrator?.close();
    control?.close();
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform cleans an inconsistent object write without leaking provider details or quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-object-write-failure-"));
  const repository = memoryObjectStore();
  const errors = [];
  const inconsistentStore = Object.freeze({
    ...repository.store,
    async put(key, bytes, options) {
      const metadata = await repository.store.put(key, bytes, options);
      return { ...metadata, sha256: "0".repeat(64) };
    },
  });
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4894,
    appPortEnd: 4895,
    deploymentAgents: {
      registrationToken: "clank_platform_object_failure_registration_123456",
      maxArtifactBytes: 4 * 1024 * 1024,
      artifacts: {
        namespace: "inconsistent-release-objects-v1",
        store: inconsistentStore,
      },
    },
    backups: { intervalMs: false },
    onError: (error) => errors.push(error),
  });
  try {
    const owner = await authorizeCli(platform, "object-write-failure@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Object failure", slug: "object-failure" },
    }), 201);
    const artifact = await appArtifact(
      join(root, "app"),
      "object-write-failure",
      [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]],
    );
    const failed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "object-artifact-failure-0001",
    );
    assert.equal(failed.response.status, 422);
    assert.equal(failed.body.error.code, "DEPLOYMENT_FAILED");
    assert.equal(
      failed.body.error.message,
      "The original release could not be retained safely.",
    );
    assert.equal(repository.values.size, 0);
    assert.ok(repository.calls.some((call) => call.operation === "delete"));
    assert.match(String(errors[0]), /inconsistent metadata/u);

    const releases = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(releases.usage, { releases: 0, storageBytes: 0 });
    assert.equal(releases.releases.length, 1);
    assert.equal(releases.releases[0].status, "failed");
    assert.equal(releases.releases[0].artifactAvailable, false);
    assert.equal(releases.releases[0].storageBytes, 0);
    assert.deepEqual(releases.releases[0].runnerArtifact, {
      bytes: 0,
      storage: "none",
    });
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed object repository namespace cannot reinterpret an existing release", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-object-namespace-"));
  const dataDirectory = join(root, "platform");
  const repository = memoryObjectStore();
  const registrationToken = "clank_platform_object_namespace_registration_123456";
  const baseOptions = {
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4896,
    appPortEnd: 4897,
    backups: { intervalMs: false },
  };
  let platform = await openPlatform({
    ...baseOptions,
    deploymentAgents: {
      registrationToken,
      artifacts: {
        namespace: "original-release-objects-v1",
        store: repository.store,
      },
    },
  });
  let control;
  let orchestrator;
  try {
    const owner = await authorizeCli(platform, "object-namespace@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Object namespace", slug: "object-namespace" },
    }), 201);
    const artifact = await appArtifact(
      join(root, "app"),
      "object-namespace",
      [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]],
    );
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "object-namespace-release-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    await platform.close();
    const state = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    state.prepare(
      "UPDATE clank_platform_projects SET active_release_id = NULL WHERE id = ?",
    ).run(created.project.id);
    state.close();

    repository.calls.length = 0;
    platform = await openPlatform({
      ...baseOptions,
      deploymentAgents: {
        registrationToken,
        artifacts: {
          namespace: "different-release-objects-v1",
          store: repository.store,
        },
      },
    });
    control = await openSQLite(defineDatabase({}), {
      path: join(dataDirectory, "control.sqlite"),
    });
    orchestrator = openDeploymentOrchestrator(control);
    const client = createDeploymentCoordinatorClient({
      baseUrl: "http://127.0.0.1:4200",
      fetch: (url, init) => platform.handle(new Request(url, init)),
    });
    const session = await client.register(registrationToken, {
      id: "runner-object-namespace-01",
      region: "local",
    });
    await orchestrator.enqueue({
      projectId: created.project.id,
      action: "deploy",
      payload: { releaseId: deployed.body.release.id },
      idempotencyKey: "object-namespace-operation",
      nodeId: session.node.id,
    });
    const [operation] = await client.claim(session.node.id, session.token, 1);
    await assert.rejects(
      client.artifact(session.node.id, session.token, operation),
      (error) => error?.status === 404 && error?.code === "ARTIFACT_NOT_FOUND",
    );
    assert.equal(
      repository.calls.filter((call) => call.operation === "get").length,
      0,
      "a mismatched namespace must be rejected before contacting the configured store",
    );
    const cleanup = await platform.handle(jsonRequest(
      `/api/projects/${created.project.id}/releases/${deployed.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release object-namespace ${deployed.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(cleanup.status, 500);
    assert.equal((await cleanup.json()).error.code, "PLATFORM_ERROR");
    assert.equal(
      repository.calls.filter((call) => call.operation === "delete").length,
      0,
      "cleanup must preserve an object whose repository identity is unavailable",
    );
    const releases = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.equal(releases.releases[0].artifactAvailable, true);
    assert.ok(releases.releases[0].storageBytes > 0);
  } finally {
    orchestrator?.close();
    control?.close();
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reserved listener ports are never assigned and existing conflicts reconcile at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-reserved-ports-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4630,
    appPortEnd: 4632,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "reserved-port@example.com");
    const first = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "First project", slug: "first-reserved-port" },
    }), 201);
    assert.equal(first.project.port, 4630);
    await platform.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      appPortStart: 4630,
      appPortEnd: 4632,
      reservedAppPorts: [4630],
      backups: { intervalMs: false },
    });
    const projects = await payload(platform, jsonRequest("/api/projects", {
      token: owner.accessToken,
    }));
    assert.equal(projects.projects.find((project) => project.id === first.project.id).port, 4631);
    const second = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Second project", slug: "second-reserved-port" },
    }), 201);
    assert.equal(second.project.port, 4632);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deployed framework auth receives its exact managed public origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-managed-auth-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4600,
    appPortEnd: 4601,
    ingress: {
      enabled: true,
      baseDomain: "apps.example.test",
      domainRecheckIntervalMs: false,
    },
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "managed-auth@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Managed auth",
        slug: "managed-auth",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const artifact = await authenticatedAppArtifact(join(root, "app"));
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "managed-auth-release-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    await assert.rejects(
      stat(join(root, "platform", "projects", created.project.id, "artifacts")),
      (error) => error?.code === "ENOENT",
    );

    const origin = "https://managed-auth.apps.example.test";
    const registration = await platform.handle(new Request(`${origin}/__clank/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "app-user@example.com",
        password: "correct horse battery staple",
        profile: { name: "App user" },
      }),
    }));
    assert.equal(registration.status, 201, await registration.clone().text());
    assert.match(registration.headers.get("set-cookie"), /^__Host-clank-id=/);

    const rejected = await platform.handle(new Request(`${origin}/__clank/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        email: "app-user@example.com",
        password: "correct horse battery staple",
      }),
    }));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "ORIGIN_MISMATCH");

    const metrics = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/metrics?range=15m`,
      { token: owner.accessToken },
    ));
    assert.equal(metrics.range, "15m");
    assert.ok(metrics.points.length >= 15 && metrics.points.length <= 17);
    assert.equal(metrics.summary.requests, 2);
    assert.equal(metrics.summary.methods.POST, 2);
    assert.equal(metrics.summary.status.success, 1);
    assert.equal(metrics.summary.status.clientError, 1);
    assert.equal(
      metrics.summary.latencyDistribution.reduce((total, bucket) => total + bucket.requests, 0),
      metrics.summary.requests,
    );
    assert.equal(metrics.comparison.previous.requests, 0);
    assert.equal(metrics.comparison.change.requestsPercent, null);
    assert.ok(metrics.summary.peakRequestsPerMinute >= 2);
    assert.equal(metrics.summary.lastRequestAt % 60_000, 0);
    assert.equal(Object.hasOwn(metrics.summary, "paths"), false);

    const previousAt = Math.floor((Date.now() - 16 * 60_000) / 60_000) * 60_000;
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"));
    control.prepare(`INSERT INTO clank_platform_metrics
      (project_id, bucket_started_at, request_count, error_count,
       status_2xx, duration_sum_ms, duration_max_ms,
       latency_le_50, latency_le_100, latency_le_250, latency_le_500,
       latency_le_1000, latency_le_2500, latency_le_5000, latency_inf,
       request_bytes, response_bytes, method_post)
      VALUES (?, ?, 1, 0, 1, 10, 10, 1, 1, 1, 1, 1, 1, 1, 1, 50, 200, 1)`)
      .run(created.project.id, previousAt);
    control.close();
    const compared = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/metrics?range=15m`,
      { token: owner.accessToken },
    ));
    assert.equal(compared.comparison.previous.requests, 1);
    assert.equal(compared.comparison.previous.methods.POST, 1);
    assert.equal(compared.comparison.previous.lastRequestAt, previousAt);
    assert.equal(compared.comparison.change.requestsPercent, 1);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace usage is durable, transparent, deletion-safe, and admission-enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-usage-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4640,
    appPortEnd: 4641,
    ingress: {
      enabled: true,
      baseDomain: "apps.example.test",
      domainRecheckIntervalMs: false,
    },
    limits: {
      requestsPerMonthPerOrganization: 2,
      transferBytesPerMonthPerOrganization: 1_000_000,
      requestsPerMinutePerProject: 10,
      usageRetentionMonths: 12,
    },
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "usage-owner@example.com");
    const outsider = await authorizeCli(platform, "usage-outsider@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Usage app",
        slug: "usage-app",
        organizationId,
      },
    }), 201);
    const artifact = await appArtifact(join(root, "source"), "usage-app", []);
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "usage-release-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));

    const requests = await Promise.all(Array.from({ length: 3 }, () =>
      platform.handle(new Request("https://usage-app.apps.example.test/"))));
    assert.deepEqual(requests.map((response) => response.status).sort(), [200, 200, 429]);
    const monthlyDenied = requests.find((response) => response.status === 429);
    assert(monthlyDenied);
    await Promise.all(requests.filter((response) => response.status === 200)
      .map((response) => response.text()));
    assert.equal(monthlyDenied.headers.get("retry-after") !== null, true);
    assert.equal((await monthlyDenied.json()).error.code, "WORKSPACE_REQUEST_LIMIT_REACHED");

    const month = new Date().toISOString().slice(0, 7);
    const usagePath = `/api/usage?organizationId=${organizationId}&month=${month}`;
    const usage = await payload(platform, jsonRequest(usagePath, {
      token: owner.accessToken,
    }));
    assert.equal(usage.protocol, "clank-usage/1");
    assert.equal(usage.period.key, month);
    assert.equal(usage.period.timezone, "UTC");
    assert.equal(usage.period.complete, false);
    assert.deepEqual(usage.usage, {
      requests: 2,
      requestBytes: 0,
      responseBytes: usage.usage.responseBytes,
      knownTransferBytes: usage.usage.responseBytes,
      rejectedRequests: 1,
    });
    assert.equal(usage.limits.requests, 2);
    assert.equal(usage.remaining.requests, 0);
    assert.equal(usage.projects[0].id, created.project.id);
    assert.equal(usage.projects[0].deleted, false);
    assert.equal(usage.projects[0].requests, 2);
    assert.equal(usage.metering.streamedResponseBytesKnown, false);
    assert.equal(usage.metering.pricingIncluded, false);
    assert.equal(usage.retentionMonths, 12);
    assert.equal(Object.hasOwn(usage.workspace, "ownerId"), false);

    const invalidMonth = await platform.handle(jsonRequest(
      `/api/usage?organizationId=${organizationId}&month=2026-13`,
      { token: owner.accessToken },
    ));
    assert.equal(invalidMonth.status, 422);
    assert.equal((await invalidMonth.json()).error.code, "INVALID_USAGE_MONTH");
    const nextMonthDate = new Date();
    nextMonthDate.setUTCDate(1);
    nextMonthDate.setUTCHours(0, 0, 0, 0);
    nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    const futureMonth = nextMonthDate.toISOString().slice(0, 7);
    const future = await platform.handle(jsonRequest(
      `/api/usage?organizationId=${organizationId}&month=${futureMonth}`,
      { token: owner.accessToken },
    ));
    assert.equal(future.status, 422);
    assert.equal((await future.json()).error.code, "USAGE_MONTH_UNAVAILABLE");
    const previousMonthDate = new Date();
    previousMonthDate.setUTCDate(1);
    previousMonthDate.setUTCHours(0, 0, 0, 0);
    previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
    const previousMonth = previousMonthDate.toISOString().slice(0, 7);
    const historical = await payload(platform, jsonRequest(
      `/api/usage?organizationId=${organizationId}&month=${previousMonth}`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(historical.projects, []);
    assert.equal(historical.period.closed, true);
    assert.equal(historical.period.complete, false);

    const outsiderDenied = await platform.handle(jsonRequest(usagePath, {
      token: outsider.accessToken,
    }));
    assert.equal(outsiderDenied.status, 404);
    const projectToken = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/tokens`,
      {
        method: "POST",
        token: owner.accessToken,
        body: { name: "Usage scope", permissions: ["read"] },
      },
    ), 201);
    const scopedDenied = await platform.handle(jsonRequest(usagePath, {
      token: projectToken.token.accessToken,
    }));
    assert.equal(scopedDenied.status, 403);

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    const now = Date.now();
    const setQuota = control.prepare(`INSERT INTO clank_platform_quota_overrides
        (scope_type, scope_id, quota_key, quota_value, updated_by, updated_at)
      VALUES ('workspace', ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, quota_key) DO UPDATE SET
        quota_value = excluded.quota_value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`);
    setQuota.run(organizationId, "requestsPerMonthPerOrganization", 10, owner.user.id, now);
    setQuota.run(organizationId, "requestsPerMinutePerProject", 10, owner.user.id, now);
    setQuota.run(organizationId, "transferBytesPerMonthPerOrganization", 1, owner.user.id, now);
    control.close();

    const transferDenied = await platform.handle(new Request("https://usage-app.apps.example.test/", {
      method: "POST",
      body: "xx",
    }));
    assert.equal(transferDenied.status, 429);
    assert.equal((await transferDenied.json()).error.code, "WORKSPACE_TRANSFER_LIMIT_REACHED");

    const rateControl = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    rateControl.prepare(`UPDATE clank_platform_quota_overrides
      SET quota_value = 1000000, updated_at = ?
      WHERE scope_type = 'workspace' AND scope_id = ?
        AND quota_key = 'transferBytesPerMonthPerOrganization'`).run(Date.now(), organizationId);
    rateControl.prepare(`UPDATE clank_platform_quota_overrides
      SET quota_value = 1, updated_at = ?
      WHERE scope_type = 'workspace' AND scope_id = ?
        AND quota_key = 'requestsPerMinutePerProject'`).run(Date.now(), organizationId);
    rateControl.close();
    const rateDenied = await platform.handle(new Request("https://usage-app.apps.example.test/"));
    assert.equal(rateDenied.status, 429);
    assert.equal((await rateDenied.json()).error.code, "PROJECT_RATE_LIMIT_REACHED");

    await payload(platform, jsonRequest(`/api/projects/${created.project.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site usage-app",
        acknowledgeDataLoss: true,
      },
    }));
    const retained = await payload(platform, jsonRequest(usagePath, {
      token: owner.accessToken,
    }));
    assert.equal(retained.projects[0].deleted, true);
    assert.equal(retained.projects[0].requests, 2);
    assert.equal(retained.projects[0].rejectedRequests, 3);
    assert.equal(retained.resources.projects, 0);

    const raw = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    const stored = raw.prepare("SELECT * FROM clank_platform_usage_monthly").all();
    assert.equal(stored.length, 1);
    assert.doesNotMatch(JSON.stringify(stored), /usage-owner|authorization|cookie|https?:/iu);
    raw.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform upgrades legacy quota storage and prunes usage at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-usage-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4645,
    appPortEnd: 4646,
    backups: { intervalMs: false },
    limits: { usageRetentionMonths: 2 },
  });
  try {
    const owner = await authorizeCli(platform, "usage-upgrade@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    await platform.close();

    const controlPath = join(dataDirectory, "control.sqlite");
    const legacy = new DatabaseSync(controlPath);
    legacy.exec("DROP TRIGGER IF EXISTS clank_platform_quota_overrides_account_cleanup");
    legacy.exec("DROP TRIGGER IF EXISTS clank_platform_quota_overrides_workspace_cleanup");
    legacy.exec("DROP INDEX IF EXISTS clank_platform_quota_overrides_scope");
    legacy.exec("ALTER TABLE clank_platform_quota_overrides RENAME TO clank_platform_quota_overrides_current");
    legacy.exec(`CREATE TABLE clank_platform_quota_overrides (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'workspace')),
      scope_id TEXT NOT NULL,
      quota_key TEXT NOT NULL CHECK (quota_key IN (
        'organizationsPerAccount',
        'projectsPerAccount',
        'projectsPerOrganization',
        'domainsPerProject',
        'releasesPerProject',
        'releaseStorageBytesPerProject',
        'backupsPerProject'
      )),
      quota_value INTEGER NOT NULL CHECK (quota_value > 0),
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, quota_key)
    )`);
    legacy.prepare(`INSERT INTO clank_platform_quota_overrides
      (scope_type, scope_id, quota_key, quota_value, updated_by, updated_at)
      VALUES ('workspace', ?, 'projectsPerOrganization', 7, ?, ?)`)
      .run(organizationId, owner.user.id, Date.now());
    legacy.exec("DROP TABLE clank_platform_quota_overrides_current");
    const staleMonth = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth() - 3,
      1,
    );
    legacy.prepare(`INSERT INTO clank_platform_usage_monthly (
        organization_id, project_id, project_name, project_slug, project_kind,
        month_started_at, request_count, request_bytes, response_bytes, rejected_count, updated_at
      ) VALUES (?, 'project_deleted', 'Deleted', 'deleted', 'production', ?, 9, 1, 2, 3, ?)`)
      .run(organizationId, staleMonth, Date.now());
    legacy.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      appPortStart: 4645,
      appPortEnd: 4646,
      backups: { intervalMs: false },
      limits: { usageRetentionMonths: 2 },
    });
    const upgraded = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    assert.equal(upgraded.organizations[0].usage.limit, 7);

    const verified = new DatabaseSync(controlPath);
    const schema = String(verified.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'clank_platform_quota_overrides'`).get().sql);
    assert.match(schema, /requestsPerMonthPerOrganization/u);
    verified.prepare(`INSERT INTO clank_platform_quota_overrides
      (scope_type, scope_id, quota_key, quota_value, updated_by, updated_at)
      VALUES ('workspace', ?, 'requestsPerMonthPerOrganization', 1234, ?, ?)`)
      .run(organizationId, owner.user.id, Date.now());
    assert.equal(
      verified.prepare("SELECT count(*) AS count FROM clank_platform_usage_monthly WHERE project_id = 'project_deleted'")
        .get().count,
      0,
    );
    verified.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("code-only deployments keep serving until a healthy candidate takes traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-rolling-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4610,
    appPortEnd: 4611,
    ingress: {
      enabled: true,
      baseDomain: "apps.example.test",
      domainRecheckIntervalMs: false,
    },
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "rolling@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Rolling app", slug: "rolling-app" },
    }), 201);
    const projectId = created.project.id;
    const migrations = [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ];
    const firstArtifact = await appArtifact(
      join(root, "first"),
      "release-one",
      migrations,
      false,
      { responseDelayMs: 2_000 },
    );
    const first = await deploy(platform, projectId, owner.accessToken, firstArtifact, "rolling-release-0001");
    assert.equal(first.response.status, 201, JSON.stringify(first.body));

    const secondArtifact = await appArtifact(
      join(root, "second"),
      "release-two",
      migrations,
      false,
      { startupDelayMs: 400 },
    );
    const inFlightOldRequest = platform.handle(
      new Request("https://rolling-app.apps.example.test/_clank-rollout-slow"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    let completed = false;
    const deploying = deploy(
      platform,
      projectId,
      owner.accessToken,
      secondArtifact,
      "rolling-release-0002",
    );
    void deploying.then(
      () => { completed = true; },
      () => { completed = true; },
    );
    const observations = [];
    while (!completed) {
      const response = await platform.handle(new Request("https://rolling-app.apps.example.test/"));
      observations.push({ status: response.status, body: await response.text() });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await deploying;
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    const inFlightOldResponse = await inFlightOldRequest;
    assert.equal(inFlightOldResponse.status, 200);
    assert.equal(await inFlightOldResponse.text(), "release-one");
    assert.ok(observations.length >= 10, `expected rollout observations, received ${observations.length}`);
    assert.equal(observations.every((entry) => entry.status === 200), true);
    assert.equal(observations.every((entry) => ["release-one", "release-two"].includes(entry.body)), true);
    assert.equal(
      await platform.handle(new Request("https://rolling-app.apps.example.test/")).then((response) => response.text()),
      "release-two",
    );
    assert.equal(await fetch(second.body.release.directUrl).then((response) => response.text()), "release-two");

    const logs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, {
      token: owner.accessToken,
    }));
    assert.equal(logs.logs.some((entry) => entry.message.includes("switched managed ingress")), true);
    assert.equal(logs.logs.some((entry) => entry.message.includes("Drained the prior release")), true);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deployments supervise independent worker and scheduler processes beside the responsive web process", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-jobs-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    platformAdminEmails: ["background-jobs@example.com"],
    appPortStart: 4590,
    appPortEnd: 4593,
    ingress: {
      enabled: true,
      baseDomain: "apps.example.test",
      domainRecheckIntervalMs: false,
    },
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "background-jobs@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Background jobs", slug: "background-jobs" },
    }), 201);
    const projectId = created.project.id;
    const artifact = await appArtifact(
      join(root, "source"),
      "jobs-release",
      [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]],
      false,
      {
        jobs: {
          workers: 2,
          concurrency: 3,
          queues: ["email", "reports"],
          scheduler: true,
        },
      },
    );
    const deployed = await deploy(
      platform,
      projectId,
      owner.accessToken,
      artifact,
      "background-jobs-release-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    assert.equal(
      await fetch(deployed.body.release.directUrl).then((response) => response.text()),
      "jobs-release",
    );

    const databasePath = join(root, "platform", "projects", projectId, "data", "app.sqlite");
    await waitFor(() => {
      try {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        const count = Number(database.prepare(
          "SELECT count(*) AS count FROM background_processes",
        ).get().count);
        database.close();
        return count === 3;
      } catch {
        return false;
      }
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const roles = database.prepare(
      "SELECT role, concurrency, queues FROM background_processes ORDER BY id",
    ).all();
    database.close();
    assert.deepEqual(roles.map((row) => row.role).sort(), ["scheduler", "worker", "worker"]);
    assert.deepEqual(
      roles.filter((row) => row.role === "worker").map((row) => ({
        concurrency: row.concurrency,
        queues: row.queues,
      })),
      [
        { concurrency: "3", queues: "email,reports" },
        { concurrency: "3", queues: "email,reports" },
      ],
    );
    const logs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, {
      token: owner.accessToken,
    }));
    assert.equal(logs.logs.some((entry) => entry.stream === "worker[1]:stdout"), true);
    assert.equal(logs.logs.some((entry) => entry.stream === "worker[2]:stdout"), true);
    assert.equal(logs.logs.some((entry) => entry.stream === "scheduler:stdout"), true);
    const memory = await payload(platform, jsonRequest("/api/admin/diagnostics/memory", {
      cookie: owner.cookie,
    }));
    assert.equal(memory.totals.trackedApplicationProcesses, 4);
    assert.deepEqual(
      memory.projects.filter((entry) => entry.id === projectId).map((entry) => entry.role).sort(),
      ["scheduler", "web", "worker", "worker"],
    );

    const replacementArtifact = await appArtifact(
      join(root, "replacement"),
      "jobs-release-two",
      [["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"]],
      false,
      {
        jobs: {
          workers: 1,
          concurrency: 2,
          queues: ["email"],
          scheduler: true,
        },
      },
    );
    const replacement = await deploy(
      platform,
      projectId,
      owner.accessToken,
      replacementArtifact,
      "background-jobs-release-0002",
    );
    assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
    await waitFor(() => {
      const current = new DatabaseSync(databasePath, { readOnly: true });
      const oldActive = Number(current.prepare(
        "SELECT count(*) AS count FROM background_processes WHERE release = 'jobs-release' AND stopped_at IS NULL",
      ).get().count);
      const newActive = Number(current.prepare(
        "SELECT count(*) AS count FROM background_processes WHERE release = 'jobs-release-two' AND stopped_at IS NULL",
      ).get().count);
      current.close();
      return oldActive === 0 && newActive === 2;
    });
    const replacementLogs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, {
      token: owner.accessToken,
    }));
    assert.equal(
      replacementLogs.logs.some((entry) =>
        entry.message.includes("Quiesced prior worker and scheduler processes")),
      true,
    );
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background startup recovery exposes the control plane before slow applications finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-background-recovery-"));
  const dataDirectory = join(root, "platform");
  const errors = [];
  const options = {
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    appPortStart: 4620,
    appPortEnd: 4621,
    ingress: {
      enabled: true,
      baseDomain: "apps.example.test",
      domainRecheckIntervalMs: false,
    },
    backups: { intervalMs: false },
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  };
  let platform = await openPlatform(options);
  try {
    const owner = await authorizeCli(platform, "background-recovery@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Slow recovery", slug: "slow-recovery" },
    }), 201);
    const artifact = await appArtifact(
      join(root, "source"),
      "recovered",
      [["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"]],
      false,
      { startupDelayMs: 500 },
    );
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "background-recovery-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    await platform.close();

    const startedAt = performance.now();
    platform = await openPlatform({ ...options, startupRecovery: "background" });
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < 400, `background recovery blocked openPlatform for ${elapsed.toFixed(1)}ms`);
    assert.equal((await platform.handle(new Request(
      "https://healthcheck.railway.app/_clank/readyz",
    ))).status, 200);
    let lastRecoveryResponse = "none";
    try {
      await waitFor(async () => {
        const response = await platform.handle(new Request("https://slow-recovery.apps.example.test/"));
        const body = await response.text();
        lastRecoveryResponse = `${response.status} ${body}`;
        return body === "recovered";
      });
    } catch (error) {
      assert.fail(
        `${error.message} Last response: ${lastRecoveryResponse}. Recovery errors: ${errors.join(" | ") || "none"}`,
      );
    }
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy metric buckets gain bounded method counters without losing traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-metric-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
  });
  await platform.close();
  const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
  control.exec(`
    DROP TABLE clank_platform_metrics;
    CREATE TABLE clank_platform_metrics (
      project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
      bucket_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      status_2xx INTEGER NOT NULL DEFAULT 0,
      status_3xx INTEGER NOT NULL DEFAULT 0,
      status_4xx INTEGER NOT NULL DEFAULT 0,
      status_5xx INTEGER NOT NULL DEFAULT 0,
      duration_sum_ms REAL NOT NULL DEFAULT 0,
      duration_max_ms REAL NOT NULL DEFAULT 0,
      latency_le_50 INTEGER NOT NULL DEFAULT 0,
      latency_le_100 INTEGER NOT NULL DEFAULT 0,
      latency_le_250 INTEGER NOT NULL DEFAULT 0,
      latency_le_500 INTEGER NOT NULL DEFAULT 0,
      latency_le_1000 INTEGER NOT NULL DEFAULT 0,
      latency_le_2500 INTEGER NOT NULL DEFAULT 0,
      latency_le_5000 INTEGER NOT NULL DEFAULT 0,
      latency_inf INTEGER NOT NULL DEFAULT 0,
      request_bytes INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, bucket_started_at)
    );
  `);
  control.close();

  try {
    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      backups: { intervalMs: false },
    });
    const upgraded = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    const columns = upgraded.prepare("PRAGMA table_info(clank_platform_metrics)").all()
      .map((column) => column.name);
    upgraded.close();
    for (const method of [
      "method_get",
      "method_head",
      "method_post",
      "method_put",
      "method_patch",
      "method_delete",
      "method_options",
      "method_other",
    ]) {
      assert.ok(columns.includes(method), `missing upgraded metric column ${method}`);
    }
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operator allowlist grants browser-only global administration and revokes it on removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-admin-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    platformAdminEmails: ["ADMIN@example.com"],
    backups: { intervalMs: false },
  });
  try {
    const admin = await authorizeCli(platform, "admin@example.com");
    const user = await authorizeCli(platform, "user@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: admin.cookie,
    }));
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: {
        name: "Admin analytics",
        slug: "admin-analytics",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const artifact = await appArtifact(
      join(root, "admin-app"),
      "admin-memory",
      [["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"]],
    );
    const deployed = await deploy(
      platform,
      project.project.id,
      admin.accessToken,
      artifact,
      "admin-memory-0001",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    const recoveryDirectory = join(
      dataDirectory,
      "projects",
      project.project.id,
      "recovery",
      "bk_manual_storage_diagnostic",
    );
    await mkdir(recoveryDirectory, { recursive: true });
    await writeFile(join(recoveryDirectory, "database.enc"), new Uint8Array(8192));
    const outsideStorage = join(root, "outside-storage");
    await mkdir(outsideStorage);
    await writeFile(join(outsideStorage, "must-not-be-followed"), new Uint8Array(1024 * 1024));
    await symlink(outsideStorage, join(recoveryDirectory, "outside-link"));
    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare(`INSERT INTO clank_platform_metrics
      (project_id, bucket_started_at, request_count, error_count, status_2xx, status_5xx,
       duration_sum_ms, duration_max_ms, latency_le_50, latency_le_100, latency_le_250,
       latency_le_500, latency_le_1000, latency_le_2500, latency_le_5000, latency_inf,
       request_bytes, response_bytes)
      VALUES (?, ?, 3, 1, 2, 1, 375, 250, 1, 2, 3, 3, 3, 3, 3, 3, 120, 480)`)
      .run(project.project.id, Date.now() - 60_000);
    control.close();

    const directory = await payload(platform, jsonRequest("/api/admin/users?limit=1", {
      cookie: admin.cookie,
    }));
    assert.equal(directory.users.length, 1);
    assert.ok(directory.nextBefore);
    const remaining = await payload(platform, jsonRequest(
      `/api/admin/users?before=${directory.nextBefore}&query=admin`,
      { cookie: admin.cookie },
    ));
    const users = [...directory.users, ...remaining.users];
    assert.equal(users.some((entry) => entry.email === "admin@example.com"), true);
    const listedAdmin = users.find((entry) => entry.email === "admin@example.com");
    assert.equal(listedAdmin.platformRole, "platform_admin");
    assert.deepEqual(
      Object.keys(listedAdmin).sort(),
      [
        "accessibleStorageBytes",
        "activeSessions",
        "activeTokens",
        "createdAt",
        "disabled",
        "email",
        "emailVerified",
        "id",
        "lastSeenAt",
        "name",
        "organizations",
        "platformRole",
        "projects",
        "updatedAt",
      ],
    );

    const analytics = await payload(platform, jsonRequest("/api/admin/analytics?range=7d", {
      cookie: admin.cookie,
    }));
    assert.equal(analytics.range, "7d");
    assert.equal(analytics.totals.users, 2);
    assert.equal(analytics.totals.enabledUsers, 2);
    assert.equal(analytics.totals.platformAdmins, 1);
    assert.equal(analytics.totals.projects, 1);
    assert.equal(analytics.traffic.summary.requests, 3);
    assert.equal(analytics.traffic.summary.errors, 1);
    assert.equal(analytics.traffic.summary.methods.OTHER, 3);
    assert.equal(
      analytics.traffic.summary.latencyDistribution.reduce(
        (total, bucket) => total + bucket.requests,
        0,
      ),
      3,
    );
    assert.equal(analytics.traffic.points.length, 1);
    assert.equal(analytics.topProjects[0].id, project.project.id);
    assert.equal(analytics.topProjects[0].requests, 3);

    const memory = await payload(platform, jsonRequest("/api/admin/diagnostics/memory", {
      cookie: admin.cookie,
    }));
    assert.equal(memory.sampledAt > 0, true);
    assert.equal(memory.controlPlane.available, true);
    assert.equal(memory.controlPlane.rssBytes > 0, true);
    assert.equal(memory.controlPlane.heapUsedBytes > 0, true);
    assert.equal(memory.controlPlane.v8HeapLimitBytes > 0, true);
    assert.equal(memory.totals.onlineProjects, 1);
    assert.equal(
      ["proportional_set_size", "resident_set_size_fallback"].includes(memory.totals.attribution),
      true,
    );
    const projectMemory = memory.projects.find((entry) => entry.id === project.project.id);
    assert.ok(projectMemory);
    assert.equal(projectMemory.scope, "application");
    assert.equal(projectMemory.available, true);
    assert.equal(projectMemory.rssBytes > 0, true);
    assert.equal(projectMemory.releaseId, deployed.body.release.id);
    assert.equal(Object.hasOwn(projectMemory, "directory"), false);
    assert.equal(Object.hasOwn(projectMemory, "environment"), false);
    if (memory.container.available) {
      assert.equal(memory.container.source, "cgroup_v2");
      assert.equal(memory.container.currentBytes > 0, true);
      assert.equal(memory.container.events.oomKill >= 0, true);
    }

    const storage = await payload(platform, jsonRequest("/api/admin/diagnostics/storage", {
      cookie: admin.cookie,
    }));
    assert.equal(storage.sampledAt > 0, true);
    assert.equal(storage.scan.complete, true);
    assert.equal(storage.scan.truncated, false);
    assert.equal(storage.scan.entries > 0, true);
    assert.equal(storage.controlDatabase.allocatedBytes > 0, true);
    assert.equal(storage.controlDatabase.sqlite.mainBytes > 0, true);
    assert.equal(storage.totals.accountedAllocatedBytes > 0, true);
    assert.equal(storage.retention.backupEnabled, false);
    const projectStorage = storage.projects.find((entry) => entry.id === project.project.id);
    assert.ok(projectStorage);
    assert.equal(projectStorage.registered, true);
    assert.equal(projectStorage.database.sqlite.mainBytes > 0, true);
    assert.equal(projectStorage.releases.allocatedBytes > 0, true);
    assert.equal(projectStorage.recoveryBackups.allocatedBytes >= 8192, true);
    assert.equal(projectStorage.recoveryBackups.allocatedBytes < 1024 * 1024, true);
    assert.equal(projectStorage.recoveryBackups.symlinks, 1);
    assert.equal(JSON.stringify(storage).includes(dataDirectory), false);
    assert.equal(JSON.stringify(storage).includes("must-not-be-followed"), false);

    const ordinaryDenied = await platform.handle(jsonRequest("/api/admin/users", {
      cookie: user.cookie,
    }));
    assert.equal(ordinaryDenied.status, 403);
    assert.equal((await ordinaryDenied.json()).error.code, "PLATFORM_ADMIN_REQUIRED");
    const ordinaryMemoryDenied = await platform.handle(jsonRequest("/api/admin/diagnostics/memory", {
      cookie: user.cookie,
    }));
    assert.equal(ordinaryMemoryDenied.status, 403);
    assert.equal((await ordinaryMemoryDenied.json()).error.code, "PLATFORM_ADMIN_REQUIRED");
    const ordinaryStorageDenied = await platform.handle(jsonRequest("/api/admin/diagnostics/storage", {
      cookie: user.cookie,
    }));
    assert.equal(ordinaryStorageDenied.status, 403);
    assert.equal((await ordinaryStorageDenied.json()).error.code, "PLATFORM_ADMIN_REQUIRED");

    const tokenDenied = await platform.handle(jsonRequest("/api/admin/analytics", {
      token: admin.accessToken,
    }));
    assert.equal(tokenDenied.status, 403);
    assert.equal((await tokenDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");
    const tokenMemoryDenied = await platform.handle(jsonRequest("/api/admin/diagnostics/memory", {
      token: admin.accessToken,
    }));
    assert.equal(tokenMemoryDenied.status, 403);
    assert.equal((await tokenMemoryDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");
    const tokenStorageDenied = await platform.handle(jsonRequest("/api/admin/diagnostics/storage", {
      token: admin.accessToken,
    }));
    assert.equal(tokenStorageDenied.status, 403);
    assert.equal((await tokenStorageDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");

    const account = await payload(platform, jsonRequest("/api/account", { cookie: admin.cookie }));
    assert.equal(account.account.platformRole, "platform_admin");
    assert.equal(dashboard.account.platformRole, "platform_admin");
    const operatorConsole = await platform.handle(jsonRequest("/admin", { cookie: admin.cookie }));
    assert.equal(operatorConsole.status, 200);
    const operatorHtml = await operatorConsole.text();
    assert.match(operatorHtml, /"platformAdmin":true/);
    assert.match(operatorHtml, /id="operator-navigation"/);
    assert.match(operatorHtml, /id="admin-page"/);
    assert.match(operatorHtml, /\/api\/admin\/analytics/);
    assert.match(operatorHtml, /\/api\/admin\/diagnostics\/memory/);
    assert.match(operatorHtml, /\/api\/admin\/diagnostics\/storage/);
    assert.match(operatorHtml, /\/api\/admin\/invitations/);
    assert.match(operatorHtml, /id="invite-personal-option" value="personal">Personal workspace only<\/option>/);
    assert.match(operatorHtml, /id="invite-scope"/);
    assert.match(operatorHtml, /id="admin-memory-projects"/);
    assert.match(operatorHtml, /id="admin-storage-projects"/);
    assert.match(operatorHtml, />Storage attribution</);
    assert.match(operatorHtml, /Provider dashboards can include block-device metadata/);
    assert.match(operatorHtml, />Unattributed</);
    assert.match(operatorHtml, /reads are close but not atomic/);
    assert.match(operatorHtml, /id="impersonation-dialog"/);

    await platform.close();
    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      platformAdminEmails: [],
      backups: { intervalMs: false },
    });
    const revoked = await platform.handle(jsonRequest("/api/admin/users", { cookie: admin.cookie }));
    assert.equal(revoked.status, 403);
    assert.equal((await revoked.json()).error.code, "PLATFORM_ADMIN_REQUIRED");
    const demoted = await payload(platform, jsonRequest("/api/account", { cookie: admin.cookie }));
    assert.equal(demoted.account.platformRole, "user");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform impersonation is recent-auth, session-bound, read-only, expiring, and audited", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-impersonation-"));
  const dataDirectory = join(root, "platform");
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    platformAdminEmails: ["admin@example.com", "other-admin@example.com"],
    backups: { intervalMs: false },
  });
  const origin = "https://console.example.test";
  const browserRequest = (path, { method = "GET", body, cookie, csrf, requestOrigin = origin } = {}) =>
    new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          origin: requestOrigin,
        }),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-clank-csrf": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const admin = await authorizeCli(platform, "admin@example.com");
    const target = await authorizeCli(platform, "target@example.com");
    const otherAdmin = await authorizeCli(platform, "other-admin@example.com");
    const adminBrowserCookie = admin.cookie.replace(/^clank-id=/, "__Host-clank-id=");
    const targetBrowserCookie = target.cookie.replace(/^clank-id=/, "__Host-clank-id=");
    const targetDashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: target.cookie,
    }));
    const targetProject = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      cookie: target.cookie,
      csrf: target.csrfToken,
      body: {
        name: "Target project",
        slug: "target-project",
        organizationId: targetDashboard.organizations[0].id,
      },
    }), 201);

    const crossOrigin = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      requestOrigin: "https://attacker.example",
      body: {
        targetUserId: target.user.id,
        reason: "Investigate customer report",
        confirmation: target.user.email,
      },
    }));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, "ORIGIN_MISMATCH");

    const selfDenied = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: admin.user.id,
        reason: "Investigate administrator report",
        confirmation: admin.user.email,
      },
    }));
    assert.equal(selfDenied.status, 422);
    assert.equal((await selfDenied.json()).error.code, "INVALID_TARGET");

    const adminTargetDenied = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: otherAdmin.user.id,
        reason: "Investigate administrator report",
        confirmation: otherAdmin.user.email,
      },
    }));
    assert.equal(adminTargetDenied.status, 403);
    assert.equal((await adminTargetDenied.json()).error.code, "ADMIN_TARGET_DENIED");

    const mismatched = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: target.user.id,
        reason: "Investigate customer report",
        confirmation: "someone-else@example.com",
      },
    }));
    assert.equal(mismatched.status, 422);
    assert.equal((await mismatched.json()).error.code, "CONFIRMATION_MISMATCH");

    const controlReason = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: target.user.id,
        reason: "Investigate\ncustomer report",
        confirmation: target.user.email,
      },
    }));
    assert.equal(controlReason.status, 422);
    assert.equal((await controlReason.json()).error.code, "INVALID_INPUT");

    const startedResponse = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: target.user.id,
        reason: "Investigate customer report",
        confirmation: target.user.email,
      },
    }));
    assert.equal(startedResponse.status, 200);
    const started = await startedResponse.json();
    const setCookie = startedResponse.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-clank-impersonation=/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Strict/);
    assert.match(setCookie, /; Secure/);
    assert.equal(started.impersonation.readOnly, true);
    assert.equal(started.impersonation.target.id, target.user.id);
    const impersonationCookie = setCookie.split(";", 1)[0];
    const impersonationToken = impersonationCookie.split("=", 2)[1];
    const combinedCookie = `${adminBrowserCookie}; ${impersonationCookie}`;

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    const stored = control.prepare(
      "SELECT token_hash, actor_user_id, actor_session_id, target_user_id FROM clank_platform_impersonations WHERE id = ?",
    ).get(started.impersonation.id);
    assert.notEqual(stored.token_hash, impersonationToken);
    assert.equal(stored.actor_user_id, admin.user.id);
    assert.equal(stored.target_user_id, target.user.id);

    const viewed = await payload(platform, browserRequest("/api/dashboard", {
      cookie: combinedCookie,
    }));
    assert.equal(viewed.account.email, target.user.email);
    assert.equal(viewed.account.impersonation.actor.email, admin.user.email);
    assert.equal(viewed.account.impersonation.readOnly, true);
    assert.deepEqual(viewed.projects.map((project) => project.id), [targetProject.project.id]);
    const cookieTossingResistant = await payload(platform, browserRequest("/api/dashboard", {
      cookie: `clank-impersonation=${"a".repeat(43)}; ${combinedCookie}`,
    }));
    assert.equal(cookieTossingResistant.account.email, target.user.email);

    const account = await payload(platform, browserRequest("/api/account", {
      cookie: combinedCookie,
    }));
    assert.equal(account.account.id, target.user.id);
    assert.equal(account.actor.id, admin.user.id);
    assert.equal(account.impersonation.id, started.impersonation.id);
    const impersonatedConsole = await platform.handle(browserRequest("/overview", {
      cookie: combinedCookie,
    }));
    assert.equal(impersonatedConsole.status, 200);
    const impersonatedHtml = await impersonatedConsole.text();
    assert.match(impersonatedHtml, /"platformAdmin":false/);
    assert.match(impersonatedHtml, /"readOnly":true/);
    assert.match(impersonatedHtml, /id="impersonation-banner"/);
    assert.match(impersonatedHtml, /data-mutation/);

    const adminControlsDenied = await platform.handle(browserRequest("/api/admin/users", {
      cookie: combinedCookie,
    }));
    assert.equal(adminControlsDenied.status, 403);
    assert.equal((await adminControlsDenied.json()).error.code, "IMPERSONATION_ACTIVE");

    const mutationDenied = await platform.handle(browserRequest("/api/projects", {
      method: "POST",
      cookie: combinedCookie,
      csrf: admin.csrfToken,
      body: {
        name: "Must not exist",
        slug: "must-not-exist",
        organizationId: targetDashboard.organizations[0].id,
      },
    }));
    assert.equal(mutationDenied.status, 403);
    assert.equal((await mutationDenied.json()).error.code, "IMPERSONATION_READ_ONLY");

    const authDenied = await platform.handle(browserRequest("/__clank/auth/change-password", {
      method: "POST",
      cookie: combinedCookie,
      csrf: admin.csrfToken,
      body: {
        currentPassword: "correct horse battery staple",
        newPassword: "another correct horse battery staple",
      },
    }));
    assert.equal(authDenied.status, 403);
    assert.equal((await authDenied.json()).error.code, "IMPERSONATION_READ_ONLY");
    const authReadDenied = await platform.handle(browserRequest("/__clank/auth/session", {
      cookie: combinedCookie,
    }));
    assert.equal(authReadDenied.status, 403);
    assert.equal((await authReadDenied.json()).error.code, "IMPERSONATION_READ_ONLY");

    const stolenCookie = await payload(platform, browserRequest("/api/account", {
      cookie: `${targetBrowserCookie}; ${impersonationCookie}`,
    }));
    assert.equal(stolenCookie.account.id, target.user.id);
    assert.equal(stolenCookie.actor, null);
    assert.equal(stolenCookie.impersonation, null);

    control.prepare("UPDATE clank_platform_impersonations SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, started.impersonation.id);
    const expired = await payload(platform, browserRequest("/api/account", {
      cookie: combinedCookie,
    }));
    assert.equal(expired.account.id, admin.user.id);
    assert.equal(expired.actor, null);
    assert.equal(expired.impersonation, null);

    const stoppedResponse = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "DELETE",
      cookie: combinedCookie,
      csrf: admin.csrfToken,
      body: {},
    }));
    assert.equal(stoppedResponse.status, 200);
    assert.equal((await stoppedResponse.json()).stopped, true);
    assert.match(stoppedResponse.headers.get("set-cookie"), /^__Host-clank-impersonation=;/);
    assert.match(stoppedResponse.headers.get("set-cookie"), /Max-Age=0/);

    const auditRows = control.prepare(`SELECT actor_user_id, action, metadata
      FROM clank_platform_audit
      WHERE action IN ('impersonation.start', 'impersonation.stop')
      ORDER BY id`).all();
    assert.deepEqual(auditRows.map((row) => row.actor_user_id), [admin.user.id, admin.user.id]);
    assert.deepEqual(auditRows.map((row) => row.action), ["impersonation.start", "impersonation.stop"]);
    assert.equal(JSON.parse(auditRows[0].metadata).targetUserId, target.user.id);
    assert.equal(JSON.parse(auditRows[0].metadata).reason, "Investigate customer report");
    const supportAnalytics = await payload(platform, browserRequest("/api/admin/analytics", {
      cookie: adminBrowserCookie,
    }));
    assert.deepEqual(
      supportAnalytics.supportAccess.map((event) => event.action),
      ["impersonation.stop", "impersonation.start"],
    );
    assert.equal(supportAnalytics.supportAccess[0].actor.id, admin.user.id);
    assert.equal(supportAnalytics.supportAccess[0].target.id, target.user.id);
    assert.equal(supportAnalytics.supportAccess[0].reason, "Investigate customer report");
    assert.equal(supportAnalytics.supportAccess[0].stoppedAt > 0, true);

    control.prepare("UPDATE clank_auth_sessions SET created_at = ? WHERE user_id = ?")
      .run(Date.now() - IMPERSONATION_RECENT_AUTH_MS_FOR_TEST - 1, admin.user.id);
    control.close();
    const staleAuth = await platform.handle(browserRequest("/api/admin/impersonation", {
      method: "POST",
      cookie: adminBrowserCookie,
      csrf: admin.csrfToken,
      body: {
        targetUserId: target.user.id,
        reason: "Investigate another report",
        confirmation: target.user.email,
      },
    }));
    assert.equal(staleAuth.status, 403);
    assert.equal((await staleAuth.json()).error.code, "RECENT_AUTH_REQUIRED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser project management enforces organization and custom-domain quotas transactionally", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-quota-"));
  const dns = new Map();
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4590,
    appPortEnd: 4595,
    signup: true,
    maxArtifactBytes: 64,
    limits: {
      organizationsPerAccount: 2,
      projectsPerAccount: 2,
      projectsPerOrganization: 1,
      domainsPerProject: 1,
      metricRetentionDays: 7,
    },
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      tlsAskToken: "quota-test-tls-token",
      resolveTxt: async (hostname) => dns.get(hostname) ?? [],
      resolveCname: async () => ["edge.example.test"],
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "quota@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { cookie: owner.cookie }));
    assert.equal(dashboard.limits.organizationsPerAccount, 2);
    assert.equal(dashboard.limits.projectsPerAccount, 2);
    assert.deepEqual(dashboard.account.usage, { organizations: 1, projects: 0 });
    const organizationId = dashboard.organizations[0].id;
    const refreshedPage = await platform.handle(new Request("http://127.0.0.1:4200/", {
      headers: { cookie: owner.cookie },
    }));
    const refreshedHtml = await refreshedPage.text();
    assert.match(refreshedHtml, /const initial=\{"authenticated":true,/);
    assert.match(refreshedHtml, /"email":"quota@example\.com"/);

    const missingCsrf = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "No CSRF", slug: "no-csrf", organizationId },
    }));
    assert.equal(missingCsrf.status, 403);

    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { name: "Only Site", slug: "only-site", organizationId },
    }), 201);
    const overLimit = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Second Site", slug: "second-site", organizationId },
    }));
    assert.equal(overLimit.status, 409);
    assert.equal((await overLimit.json()).error.code, "PROJECT_LIMIT_REACHED");

    let artifactCancelled = false;
    const oversizedArtifact = await platform.handle(new Request(
      `http://127.0.0.1:4200/api/projects/${created.project.id}/releases`,
      {
        method: "POST",
        duplex: "half",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/vnd.clank.deploy+gzip",
          "x-clank-content-sha256": "0".repeat(64),
          "x-clank-idempotency-key": "bounded-artifact-test",
        },
        body: new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(40)); },
          cancel() { artifactCancelled = true; },
        }),
      },
    ));
    assert.equal(oversizedArtifact.status, 413);
    assert.equal((await oversizedArtifact.json()).error.code, "ARTIFACT_TOO_LARGE");
    assert.equal(artifactCancelled, true);

    const reservedDomain = await platform.handle(jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { hostname: "edge.example.test" },
    }));
    assert.equal(reservedDomain.status, 409);
    assert.equal((await reservedDomain.json()).error.code, "DOMAIN_RESERVED");

    const firstDomain = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { hostname: "one.customer.test" },
    }), 201);
    dns.set(firstDomain.domain.recordName, [[firstDomain.domain.recordValue]]);
    const verified = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/domains/${firstDomain.domain.id}/verify`,
      { method: "POST", cookie: owner.cookie, csrf: owner.csrfToken, body: {} },
    ));
    assert.equal(verified.domain.ownership.status, "verified");
    assert.equal(verified.domain.routing.status, "ready");
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=quota-test-tls-token&domain=one.customer.test",
    ))).status, 403, "sites without a deployed release cannot allocate a certificate");
    const domainOverLimit = await platform.handle(jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "two.customer.test" },
    }));
    assert.equal(domainOverLimit.status, 409);
    assert.equal((await domainOverLimit.json()).error.code, "DOMAIN_LIMIT_REACHED");
    const domains = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      token: owner.accessToken,
    }));
    assert.equal(domains.domains.length, 1, "a rejected domain must never survive rollback");
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_platform_domains WHERE project_id = ?",
    ).get(created.project.id).count, 1);
    control.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("administrator quota overrides are durable, scoped, inherited, and audited", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-admin-quotas-"));
  const dataDirectory = join(root, "platform");
  const options = {
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    platformAdminEmails: ["admin-quotas@example.com"],
    backups: { intervalMs: false, maxBackups: 9 },
    limits: {
      organizationsPerAccount: 4,
      projectsPerAccount: 5,
      projectsPerOrganization: 3,
      domainsPerProject: 4,
      releasesPerProject: 6,
      releaseStorageBytesPerProject: 8 * 1024 * 1024,
      requestsPerMonthPerOrganization: 10_000,
      transferBytesPerMonthPerOrganization: 16 * 1024 * 1024,
      requestsPerMinutePerProject: 100,
    },
  };
  let platform = await openPlatform(options);
  try {
    const admin = await authorizeCli(platform, "admin-quotas@example.com");
    const customer = await authorizeCli(platform, "customer-quotas@example.com");
    const customerDashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: customer.cookie,
    }));
    const workspaceId = customerDashboard.organizations[0].id;

    const ordinaryDenied = await platform.handle(jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      { cookie: customer.cookie },
    ));
    assert.equal(ordinaryDenied.status, 403);
    assert.equal((await ordinaryDenied.json()).error.code, "PLATFORM_ADMIN_REQUIRED");
    const tokenDenied = await platform.handle(jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      { token: admin.accessToken },
    ));
    assert.equal(tokenDenied.status, 403);
    assert.equal((await tokenDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");

    const initial = await payload(platform, jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      { cookie: admin.cookie },
    ));
    assert.equal(initial.defaults.projectsPerAccount, 5);
    assert.equal(initial.defaults.backupsPerProject, 9);
    assert.equal(initial.defaults.requestsPerMonthPerOrganization, 10_000);
    assert.deepEqual(
      initial.definitions.find((definition) =>
        definition.key === "requestsPerMonthPerOrganization").scopes,
      ["account", "workspace"],
    );
    assert.deepEqual(initial.overrides, {});
    assert.equal(initial.workspaces[0].id, workspaceId);
    assert.equal(initial.workspaces[0].effective.projectsPerOrganization, 3);

    const missingCsrf = await platform.handle(jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      {
        method: "PUT",
        cookie: admin.cookie,
        body: { overrides: { projectsPerAccount: 2 } },
      },
    ));
    assert.equal(missingCsrf.status, 403);

    const account = await payload(platform, jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      {
        method: "PUT",
        cookie: admin.cookie,
        csrf: admin.csrfToken,
        body: {
          overrides: {
            organizationsPerAccount: 2,
            projectsPerAccount: 2,
            backupsPerProject: 4,
            requestsPerMonthPerOrganization: 5000,
          },
        },
      },
    ));
    assert.equal(account.effective.projectsPerAccount, 2);
    assert.equal(account.effective.backupsPerProject, 4);
    assert.equal(account.effective.requestsPerMonthPerOrganization, 5000);
    assert.equal(account.workspaces[0].effective.backupsPerProject, 4);

    const invalidWorkspaceKey = await platform.handle(jsonRequest(
      `/api/admin/quotas/workspace/${workspaceId}`,
      {
        method: "PUT",
        cookie: admin.cookie,
        csrf: admin.csrfToken,
        body: { overrides: { projectsPerAccount: 20 } },
      },
    ));
    assert.equal(invalidWorkspaceKey.status, 422);
    assert.equal((await invalidWorkspaceKey.json()).error.code, "INVALID_INPUT");

    const workspace = await payload(platform, jsonRequest(
      `/api/admin/quotas/workspace/${workspaceId}`,
      {
        method: "PUT",
        cookie: admin.cookie,
        csrf: admin.csrfToken,
        body: {
          overrides: {
            projectsPerOrganization: 1,
            domainsPerProject: 2,
            releasesPerProject: 2,
            releaseStorageBytesPerProject: 4 * 1024 * 1024,
            transferBytesPerMonthPerOrganization: 8 * 1024 * 1024,
            requestsPerMinutePerProject: 25,
          },
        },
      },
    ));
    assert.equal(workspace.inherited.backupsPerProject, 4);
    assert.equal(workspace.effective.projectsPerOrganization, 1);
    assert.equal(workspace.effective.domainsPerProject, 2);
    assert.equal(workspace.effective.requestsPerMonthPerOrganization, 5000);
    assert.equal(workspace.effective.transferBytesPerMonthPerOrganization, 8 * 1024 * 1024);
    assert.equal(workspace.effective.requestsPerMinutePerProject, 25);

    const effectiveDashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: customer.cookie,
    }));
    assert.equal(effectiveDashboard.limits.organizationsPerAccount, 2);
    assert.equal(effectiveDashboard.limits.projectsPerAccount, 2);
    assert.equal(effectiveDashboard.limits.backupsPerProject, 4);
    assert.equal(effectiveDashboard.organizations[0].usage.limit, 1);
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      cookie: customer.cookie,
      csrf: customer.csrfToken,
      body: {
        name: "Quota customer",
        slug: "quota-customer",
        organizationId: workspaceId,
      },
    }), 201);
    const overWorkspace = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      cookie: customer.cookie,
      csrf: customer.csrfToken,
      body: {
        name: "Quota overflow",
        slug: "quota-overflow",
        organizationId: workspaceId,
      },
    }));
    assert.equal(overWorkspace.status, 409);
    assert.equal((await overWorkspace.json()).error.code, "PROJECT_LIMIT_REACHED");
    const detail = await payload(platform, jsonRequest(`/api/projects/${project.project.id}`, {
      cookie: customer.cookie,
    }));
    assert.equal(detail.limits.domainsPerProject, 2);
    assert.equal(detail.limits.releasesPerProject, 2);
    assert.equal(detail.limits.backupsPerProject, 4);
    assert.equal(detail.limits.requestsPerMonthPerOrganization, 5000);
    assert.equal(detail.limits.transferBytesPerMonthPerOrganization, 8 * 1024 * 1024);
    assert.equal(detail.limits.requestsPerMinutePerProject, 25);
    const backups = await payload(platform, jsonRequest(`/api/projects/${project.project.id}/backups`, {
      cookie: customer.cookie,
    }));
    assert.equal(backups.automation.maxBackups, 4);

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_platform_quota_overrides WHERE scope_id IN (?, ?)",
    ).get(customer.user.id, workspaceId).count, 10);
    const audits = control.prepare(
      "SELECT metadata FROM clank_platform_audit WHERE action = 'quota.update' ORDER BY id",
    ).all();
    assert.equal(audits.length, 2);
    assert.equal(JSON.parse(audits[0].metadata).scopeType, "account");
    assert.equal(JSON.parse(audits[1].metadata).scopeType, "workspace");
    control.close();

    await platform.close();
    platform = await openPlatform(options);
    const persisted = await payload(platform, jsonRequest(
      `/api/admin/quotas/account/${customer.user.id}`,
      { cookie: admin.cookie },
    ));
    assert.equal(persisted.effective.projectsPerAccount, 2);
    assert.equal(persisted.workspaces[0].effective.projectsPerOrganization, 1);
    assert.equal(persisted.workspaces[0].effective.backupsPerProject, 4);
    assert.equal(persisted.workspaces[0].effective.requestsPerMonthPerOrganization, 5000);
    assert.equal(persisted.workspaces[0].effective.transferBytesPerMonthPerOrganization, 8 * 1024 * 1024);
    assert.equal(persisted.workspaces[0].effective.requestsPerMinutePerProject, 25);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("custom-domain routing is reconciled automatically with durable bounded claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-domain-recheck-"));
  let routeReady = false;
  let hangRouting = false;
  let routingLookups = 0;
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4560,
    appPortEnd: 4565,
    signup: true,
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      domainRecheckIntervalMs: 1_000,
      domainRecheckBatchSize: 1,
      domainRecheckTimeoutMs: 500,
      resolveTxt: async () => [],
      resolveCname: async () => {
        routingLookups++;
        if (hangRouting) return new Promise(() => {});
        return routeReady ? ["edge.example.test"] : ["elsewhere.example.test"];
      },
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "domain-recheck@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { token: owner.accessToken }));
    assert.equal(dashboard.domains.automation.enabled, true);
    assert.equal(dashboard.domains.automation.intervalMs, 1_000);
    assert.equal(dashboard.domains.automation.batchSize, 1);
    assert.equal(dashboard.domains.automation.timeoutMs, 500);
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Automatic DNS",
        slug: "automatic-dns",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const domain = await payload(platform, jsonRequest(`/api/projects/${project.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "automatic.customer.test" },
    }), 201);
    assert.equal(domain.domain.routing.status, "misconfigured");
    const initialLookups = routingLookups;
    routeReady = true;

    let reconciled;
    await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${project.project.id}/domains`,
        { token: owner.accessToken },
      ));
      reconciled = result;
      return result.domains[0].routing.status === "ready";
    });
    assert.ok(routingLookups > initialLookups);
    assert.equal(reconciled.automation.lastChecked, 1);
    assert.equal(reconciled.automation.lastFailed, 0);
    assert.equal(reconciled.automation.pending, 0);
    assert.ok(reconciled.automation.lastCompletedAt >= reconciled.automation.lastStartedAt);

    const control = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    const row = control.prepare(`SELECT next_check_at, check_lease_token, check_lease_until
      FROM clank_platform_domains WHERE id = ?`).get(domain.domain.id);
    assert.ok(row.next_check_at > reconciled.domains[0].routing.checkedAt);
    assert.equal(row.check_lease_token, null);
    assert.equal(row.check_lease_until, null);
    control.close();

    const writable = new DatabaseSync(join(root, "platform", "control.sqlite"));
    writable.exec("UPDATE clank_platform_domains SET next_check_at = 0");
    writable.close();
    hangRouting = true;
    await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${project.project.id}/domains`,
        { token: owner.accessToken },
      ));
      return result.domains[0].routing.status === "error"
        && result.automation.lastFailed === 1;
    }, 4_000);
    const manualStartedAt = Date.now();
    const manual = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/domains/${domain.domain.id}/check`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    assert.equal(manual.domain.routing.status, "error");
    assert.ok(Date.now() - manualStartedAt < 1_500, "manual DNS checks must use the same finite deadline");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple control planes do not reconcile the same domain lease concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-domain-lease-"));
  let background = false;
  let backgroundLookups = 0;
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const ingress = {
    enabled: true,
    customDomainTarget: "edge.example.test",
    domainRecheckIntervalMs: 1_000,
    domainRecheckBatchSize: 1,
    domainRecheckTimeoutMs: 5_000,
    resolveTxt: async () => [],
    resolveCname: async () => {
      if (background) {
        backgroundLookups++;
        await lookupGate;
      }
      return ["edge.example.test"];
    },
    resolve4: async () => [],
    resolve6: async () => [],
  };
  const options = {
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4550,
    appPortEnd: 4555,
    signup: true,
    ingress,
  };
  const first = await openPlatform(options);
  const second = await openPlatform(options);
  try {
    const owner = await authorizeCli(first, "domain-lease@example.com");
    const dashboard = await payload(first, jsonRequest("/api/dashboard", { token: owner.accessToken }));
    const project = await payload(first, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Leased DNS",
        slug: "leased-dns",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    await payload(first, jsonRequest(`/api/projects/${project.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "leased.customer.test" },
    }), 201);
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"));
    control.exec("UPDATE clank_platform_domains SET next_check_at = 0");
    control.close();
    background = true;

    await waitFor(() => backgroundLookups === 1, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(backgroundLookups, 1, "a second control plane must respect the durable DNS lease");
    releaseLookup();
    await waitFor(() => {
      const database = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
      const row = database.prepare("SELECT check_lease_token FROM clank_platform_domains").get();
      database.close();
      return row.check_lease_token === null;
    });
  } finally {
    releaseLookup();
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("account quotas prevent multiplying organizations to bypass hosted site limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-account-quota-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4570,
    appPortEnd: 4575,
    signup: true,
    limits: {
      organizationsPerAccount: 2,
      projectsPerAccount: 1,
      projectsPerOrganization: 1,
      domainsPerProject: 1,
    },
  });
  try {
    const owner = await authorizeCli(platform, "account-quota@example.com");
    const missingCsrf = await platform.handle(jsonRequest("/api/organizations", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "No CSRF workspace", slug: "no-csrf-workspace" },
    }));
    assert.equal(missingCsrf.status, 403);
    const firstOrganization = await payload(platform, jsonRequest("/api/organizations", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { name: "First workspace", slug: "first-workspace" },
    }), 201);
    const firstProject = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "First site", slug: "first-account-site", organizationId: firstOrganization.organization.id },
    }), 201);
    assert.ok(firstProject.project.id);
    const secondOrganization = await payload(platform, jsonRequest("/api/organizations", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Second workspace", slug: "second-workspace" },
    }), 201);
    const secondProject = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Bypass site", slug: "bypass-site", organizationId: secondOrganization.organization.id },
    }));
    assert.equal(secondProject.status, 409);
    assert.equal((await secondProject.json()).error.code, "ACCOUNT_PROJECT_LIMIT_REACHED");
    const thirdOrganization = await platform.handle(jsonRequest("/api/organizations", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Third workspace", slug: "third-workspace" },
    }));
    assert.equal(thirdOrganization.status, 409);
    assert.equal((await thirdOrganization.json()).error.code, "ORGANIZATION_LIMIT_REACHED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker runner passes secret names in arguments and secret values only through its environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-docker-argv-"));
  const source = join(root, "source");
  const runnerPath = join(root, "fake-docker.mjs");
  const invocationPath = join(root, "docker-invocation.json");
  await writeFile(runnerPath, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const arguments_ = process.argv.slice(2);
    await writeFile(${JSON.stringify(invocationPath)}, JSON.stringify({
      arguments_,
      secretPresent: process.env.DOCKER_TEST_SECRET === "abc",
    }));
    const mount = arguments_.find((value) => value.endsWith(":/app:ro"));
    if (!mount) throw new Error("Missing application mount.");
    const applicationRoot = mount.slice(0, -":/app:ro".length);
    const child = spawn(process.execPath, [join(applicationRoot, arguments_.at(-1))], {
      env: { ...process.env, HOST: "127.0.0.1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.once("SIGTERM", () => child.kill("SIGTERM"));
    process.once("SIGINT", () => child.kill("SIGINT"));
    child.once("exit", (code) => process.exit(code ?? 1));
  `, { mode: 0o700 });
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4580,
    appPortEnd: 4585,
    signup: true,
    runner: { kind: "docker", executable: runnerPath, image: "fake-image" },
  });
  try {
    const owner = await authorizeCli(platform, "docker-argv@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Docker arguments", slug: "docker-arguments" },
    }), 201);
    await payload(platform, jsonRequest(`/api/projects/${created.project.id}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { DOCKER_TEST_SECRET: "abc" } },
    }));
    const artifact = await appArtifact(source, "docker-release", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"],
    ]);
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "docker-argument-release-key",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    const invocation = JSON.parse(await readFile(invocationPath, "utf8"));
    assert.equal(invocation.secretPresent, true);
    assert.equal(invocation.arguments_.includes("DOCKER_TEST_SECRET"), true);
    assert.equal(invocation.arguments_.some((argument) => argument.includes("abc")), false);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform device auth, ownership, encrypted secrets, atomic deploy, migrations, and rollback work end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-"));
  const source = join(root, "source");
  const dns = new Map();
  const cnames = new Map();
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4510,
    appPortEnd: 4520,
    signup: true,
    ingress: {
      baseDomain: "apps.example.test",
      customDomainTarget: "edge.example.test",
      tlsAskToken: "test-only-tls-ask-token",
      resolveTxt: async (hostname) => dns.get(hostname) ?? [],
      resolveCname: async (hostname) => cnames.get(hostname) ?? [],
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    assert.deepEqual(await payload(platform, new Request(
      "https://healthcheck.railway.app/_clank/readyz",
    )), {
      ok: true,
      status: "ready",
      checks: {
        database: "ok",
      },
    });
    const applicationReadiness = await platform.handle(new Request(
      "https://missing.apps.example.test/readyz",
    ));
    assert.equal(applicationReadiness.status, 404);
    assert.equal((await applicationReadiness.json()).error.code, "ROUTE_NOT_FOUND");
    const owner = await authorizeCli(platform, "owner@example.com");
    const other = await authorizeCli(platform, "other@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Atomic Todo", slug: "atomic-todo" },
    }), 201);
    const projectId = created.project.id;
    const isolated = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: other.accessToken,
    }));
    assert.equal(isolated.status, 404);

    const unsafeArtifact = await appArtifact(source, "unsafe", [
      ["0001_unsafe.sql", "PRAGMA journal_mode = OFF;\n"],
    ], true);
    const unsafe = await deploy(platform, projectId, owner.accessToken, unsafeArtifact, "unsafe-release-key");
    assert.equal(unsafe.response.status, 403);
    assert.equal(unsafe.body.error.code, "UNSAFE_MIGRATIONS_DISABLED");

    const secretValue = "high-entropy-platform-secret";
    await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { API_SECRET: secretValue, AUDIT_SHORT_SECRET: "abc" } },
    }));
    const listed = await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(listed.secrets.map((secret) => secret.name), ["API_SECRET", "AUDIT_SHORT_SECRET"]);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(secretValue));
    const controlBytes = await readFile(join(root, "platform", "control.sqlite"));
    assert.equal(controlBytes.includes(Buffer.from(secretValue)), false);

    const firstArtifact = await appArtifact(source, "release-one", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const projectDirectory = join(root, "platform", "projects", projectId);
    const dataDirectory = join(projectDirectory, "data");
    await mkdir(dataDirectory, { recursive: true });
    await symlink(join(root, "platform", "control.sqlite"), join(dataDirectory, "app.sqlite"));
    const linkedDatabase = await deploy(platform, projectId, owner.accessToken, firstArtifact, "symlink-release-key");
    assert.equal(linkedDatabase.response.status, 422);
    assert.match(linkedDatabase.body.error.message, /symbolic link|regular file/);
    await unlink(join(dataDirectory, "app.sqlite"));

    const first = await deploy(platform, projectId, owner.accessToken, firstArtifact, "first-release-key-0001");
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");
    await waitFor(async () => {
      const logs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, { token: owner.accessToken }));
      return logs.logs.some((entry) => entry.message.includes("secret=[REDACTED]"));
    });
    const redactedLogs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, { token: owner.accessToken }));
    assert.equal(redactedLogs.logs.some((entry) => entry.message.includes("abc")), false);
    const managed = await platform.handle(new Request("https://atomic-todo.apps.example.test/"));
    assert.equal(managed.status, 200);
    assert.equal(await managed.text(), "release-one");
    assert.deepEqual(await platform.handle(new Request(
      "https://atomic-todo.apps.example.test/_runtime-environment",
    )).then((response) => response.json()), {
      trustProxy: "1",
      allowedHosts: "",
      managedIngress: "1",
    });
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=atomic-todo.apps.example.test",
    ))).status, 200, "deployed built-in site hostnames are eligible for edge certificates");
    const customDomain = await payload(platform, jsonRequest(`/api/projects/${projectId}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "tasks.customer.test" },
    }), 201);
    dns.set(customDomain.domain.recordName, [[customDomain.domain.recordValue]]);
    cnames.set(customDomain.domain.hostname, ["edge.example.test"]);
    await payload(platform, jsonRequest(
      `/api/projects/${projectId}/domains/${customDomain.domain.id}/verify`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    const customIngress = await platform.handle(new Request("https://tasks.customer.test/"));
    assert.equal(customIngress.status, 200);
    assert.equal(await customIngress.text(), "release-one");
    const tlsAllowed = await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=tasks.customer.test",
    ));
    assert.equal(tlsAllowed.status, 200);
    assert.equal((await platform.handle(new Request(
      "http://localhost:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=tasks.customer.test",
    ))).status, 200, "the private TLS endpoint is reachable through a loopback Host before ingress dispatch");
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=wrong-token-value&domain=tasks.customer.test",
    ))).status, 404);
    const metrics = await payload(platform, jsonRequest(`/api/projects/${projectId}/metrics?range=24h`, {
      token: owner.accessToken,
    }));
    assert.ok(metrics.summary.requests >= 2);
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: owner.cookie,
    }));
    assert.equal(dashboard.projects[0].id, projectId);
    assert.equal(dashboard.projects[0].runtimeStatus, "online");
    assert.ok(dashboard.projects[0].metrics.requests >= 2);
    await fetch(`${first.body.release.directUrl}/crash`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await waitFor(async () =>
      await fetch(first.body.release.directUrl).then((response) => response.text()).catch(() => "") === "release-one");

    const databasePath = join(projectDirectory, "data", "app.sqlite");
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "platform", "master.key"))).mode & 0o777, 0o600);
    let database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 1);
    database.prepare("INSERT INTO items (value) VALUES (?)").run("preserve me");
    database.close();

    const secondArtifact = await appArtifact(source, "release-two", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ["0002_add_labels.sql", "CREATE TABLE labels (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const second = await deploy(platform, projectId, owner.accessToken, secondArtifact, "second-release-key-0002");
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    assert.equal(await fetch(second.body.release.directUrl).then((response) => response.text()), "release-two");
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 2);
    database.close();

    const backup = await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      method: "POST",
      token: owner.accessToken,
      body: { reason: "before bulk import" },
    }), 201);
    const listedBackups = await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      token: owner.accessToken,
    }));
    assert.equal(listedBackups.backups[0].id, backup.backup.id);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups/${backup.backup.id}/verify`, {
      method: "POST",
      token: owner.accessToken,
      body: {},
    }));
    database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO items (value) VALUES (?)").run("remove on restore");
    database.close();
    const wrongBackupConfirmation = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/backups/${backup.backup.id}/restore`,
      {
        method: "POST",
        token: owner.accessToken,
        body: { confirmation: "restore it" },
      },
    ));
    assert.equal(wrongBackupConfirmation.status, 400);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups/${backup.backup.id}/restore`, {
      method: "POST",
      token: owner.accessToken,
      body: { confirmation: `restore-backup atomic-todo ${backup.backup.id}` },
    }));
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(database.prepare("SELECT value FROM items ORDER BY id").all().map((row) => row.value), ["preserve me"]);
    database.close();

    const rolledBack = await payload(platform, jsonRequest(`/api/projects/${projectId}/rollback`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        releaseId: first.body.release.id,
        restoreData: true,
        confirmation: "restore atomic-todo",
      },
    }));
    assert.equal(rolledBack.release.id, first.body.release.id);
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 1);
    assert.deepEqual(database.prepare("SELECT value FROM items").all().map((row) => row.value), ["preserve me"]);
    assert.throws(() => database.prepare("SELECT * FROM labels").all(), /no such table/);
    database.close();

    const tampered = await appArtifact(source, "tampered", [
      ["0001_create_items.sql", "CREATE TABLE changed_history (id INTEGER PRIMARY KEY);\n"],
    ]);
    const rejected = await deploy(platform, projectId, owner.accessToken, tampered, "tampered-release-key");
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.body.error.code, "DEPLOYMENT_FAILED");
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");

    const audit = await payload(platform, jsonRequest(`/api/projects/${projectId}/audit`, {
      token: owner.accessToken,
    }));
    assert.ok(audit.events.some((event) => event.action === "release.activate"));
    assert.ok(audit.events.some((event) => event.action === "release.rollback"));
    assert.ok(audit.events.some((event) => event.action === "release.fail"));

    await payload(platform, jsonRequest("/api/tokens/current", {
      method: "DELETE",
      token: other.accessToken,
    }));
    const revoked = await platform.handle(jsonRequest("/api/account", { token: other.accessToken }));
    assert.equal(revoked.status, 401);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("organizations enforce RBAC, invitations, membership revocation, and project-scoped CLI credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-orgs-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4540,
    appPortEnd: 4550,
    signup: true,
  });
  try {
    const owner = await authorizeCli(platform, "org-owner@example.com");
    const admin = await authorizeCli(platform, "org-admin@example.com");
    const outsider = await authorizeCli(platform, "outsider@example.com");
    const first = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Organization Todo", slug: "organization-todo" },
    }), 201);
    const second = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Other Project", slug: "other-project" },
    }), 201);
    const projectId = first.project.id;
    const organizationId = first.project.organizationId;
    assert.equal(second.project.organizationId, organizationId);

    const invitationWithoutCsrf = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { email: "org-admin@example.com", role: "admin" },
      },
    ));
    assert.equal(invitationWithoutCsrf.status, 403);
    const supersededInvitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { email: "org-admin@example.com", role: "admin" },
    }), 201);
    const invitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "org-admin@example.com", role: "admin" },
    }), 201);
    const organizationBeforeAcceptance = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(organizationBeforeAcceptance.organization.access, {
      canManageMembers: true,
      canGrantOwner: true,
      canLeave: false,
    });
    assert.equal(organizationBeforeAcceptance.limits.pendingInvitations, 100);
    assert.equal(organizationBeforeAcceptance.invitations.length, 1);
    assert.deepEqual(
      Object.keys(organizationBeforeAcceptance.invitations[0]).sort(),
      ["createdAt", "email", "expiresAt", "id", "invitedBy", "role"],
    );
    assert.equal(organizationBeforeAcceptance.invitations[0].id, invitation.invitation.id);
    assert.equal(organizationBeforeAcceptance.invitations[0].invitedBy.email, "org-owner@example.com");
    const superseded = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: supersededInvitation.invitation.token },
    }));
    assert.equal(superseded.status, 400);
    const wrongAccount = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: outsider.accessToken,
      body: { token: invitation.invitation.token },
    }));
    assert.equal(wrongAccount.status, 400);
    assert.equal((await wrongAccount.json()).error.code, "INVALID_INVITATION");
    await payload(platform, jsonRequest("/api/invitations/accept", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { token: invitation.invitation.token },
    }));
    const replay = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: invitation.invitation.token },
    }));
    assert.equal(replay.status, 400);
    const organizationAfterAcceptance = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: admin.accessToken },
    ));
    assert.deepEqual(organizationAfterAcceptance.organization.access, {
      canManageMembers: true,
      canGrantOwner: false,
      canLeave: true,
    });
    assert.equal(organizationAfterAcceptance.invitations.length, 0);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "owner" },
    }));
    const sharedOwnership = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: owner.accessToken },
    ));
    assert.equal(sharedOwnership.organization.access.canLeave, true);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "admin" },
    }));

    const alreadyMember = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: admin.accessToken,
        body: { email: "org-owner@example.com", role: "viewer" },
      },
    ));
    assert.equal(alreadyMember.status, 409);
    assert.equal((await alreadyMember.json()).error.code, "ALREADY_MEMBER");
    const revocableInvitation = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: admin.accessToken,
        body: { email: "outsider@example.com", role: "viewer" },
      },
    ), 201);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations/${revocableInvitation.invitation.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    const revokedInvitation = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: outsider.accessToken,
      body: { token: revocableInvitation.invitation.token },
    }));
    assert.equal(revokedInvitation.status, 400);
    const revokeReplay = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations/${revocableInvitation.invitation.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    assert.equal(revokeReplay.status, 404);

    const visible = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: admin.accessToken,
    }));
    assert.equal(visible.project.id, projectId);
    const hidden = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: outsider.accessToken,
    }));
    assert.equal(hidden.status, 404);

    const scoped = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: admin.accessToken,
      body: {
        name: "Project deploy bot",
        permissions: ["read", "deploy"],
        expiresIn: 3600,
      },
    }), 201);
    const projectToken = scoped.token.accessToken;
    const scopedAccount = await payload(platform, jsonRequest("/api/account", { token: projectToken }));
    assert.equal(scopedAccount.token.projectId, projectId);
    assert.deepEqual(scopedAccount.token.permissions, ["read", "deploy"]);
    const scopedDashboard = await payload(platform, jsonRequest("/api/dashboard", { token: projectToken }));
    assert.deepEqual(scopedDashboard.projects.map((project) => project.id), [projectId]);
    assert.deepEqual(scopedDashboard.organizations.map((organization) => organization.id), [organizationId]);
    await payload(platform, jsonRequest(`/api/projects/${projectId}`, { token: projectToken }));
    const otherProject = await platform.handle(jsonRequest(`/api/projects/${second.project.id}`, {
      token: projectToken,
    }));
    assert.equal(otherProject.status, 404);
    const scopedSecrets = await platform.handle(jsonRequest(`/api/projects/${projectId}/secrets`, {
      token: projectToken,
    }));
    assert.equal(scopedSecrets.status, 403);
    assert.equal((await scopedSecrets.json()).error.code, "TOKEN_SCOPE_DENIED");

    for (let index = 0; index < 100; index++) {
      await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
        method: "POST",
        token: owner.accessToken,
        body: { email: `pending-${index}@example.com`, role: "developer" },
      }), 201);
    }
    const invitationLimit = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: owner.accessToken,
        body: { email: "pending-overflow@example.com", role: "viewer" },
      },
    ));
    assert.equal(invitationLimit.status, 409);
    assert.equal((await invitationLimit.json()).error.code, "INVITATION_LIMIT_REACHED");
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "pending-0@example.com", role: "viewer" },
    }), 201);
    const ownerAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=200`,
      { token: owner.accessToken },
    ));
    assert.ok(ownerAudit.events.some(
      (event) => event.action === "invitation.create"
        && event.metadata.email === "pending-0@example.com",
    ));
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "viewer" },
    }));
    const viewerOrganization = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: admin.accessToken },
    ));
    assert.deepEqual(viewerOrganization.organization.access, {
      canManageMembers: false,
      canGrantOwner: false,
      canLeave: true,
    });
    assert.deepEqual(viewerOrganization.invitations, []);

    const adminCannotRemoveOwner = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/members/${owner.user.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    assert.equal(adminCannotRemoveOwner.status, 403);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "DELETE",
      token: admin.accessToken,
      body: {},
    }));
    const revokedScoped = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: projectToken,
    }));
    assert.equal(revokedScoped.status, 401);
    const revokedMembership = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: admin.accessToken,
    }));
    assert.equal(revokedMembership.status, 404);
    const adminAccountStillWorks = await platform.handle(jsonRequest("/api/account", {
      token: admin.accessToken,
    }));
    assert.equal(adminAccountStillWorks.status, 200);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preview environments are isolated, quota-bound, refreshable, removable, and expired on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-previews-"));
  const dataDirectory = join(root, "platform");
  const platformOptions = {
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4761,
    appPortEnd: 4765,
    signup: true,
    backups: { intervalMs: false },
    previews: { cleanupIntervalMs: false },
    limits: {
      projectsPerAccount: 4,
      projectsPerOrganization: 4,
    },
  };
  let platform = await openPlatform(platformOptions);
  let closed = false;
  try {
    const owner = await authorizeCli(platform, "previews@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Preview Parent",
        slug: "preview-parent",
        organizationId,
      },
    }), 201);
    const projectId = created.project.id;
    await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { PRODUCTION_ONLY: "never-copy-this" } },
    }));
    const artifact = await appArtifact(join(root, "artifact"), "preview-test", [
      ["0001_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);"],
    ]);
    const productionDeploy = await deploy(
      platform,
      projectId,
      owner.accessToken,
      artifact,
      "preview_production_0001",
    );
    assert.equal(productionDeploy.response.status, 201, JSON.stringify(productionDeploy.body));

    const previewCreated = await payload(platform, jsonRequest(`/api/projects/${projectId}/previews`, {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Feature Accounts", ttlHours: 48 },
    }), 201);
    assert.equal(previewCreated.created, true);
    assert.equal(previewCreated.preview.kind, "preview");
    assert.equal(previewCreated.preview.parentProjectId, projectId);
    assert.equal(previewCreated.preview.previewName, "feature-accounts");
    const previewId = previewCreated.preview.id;
    const firstExpiry = previewCreated.preview.previewExpiresAt;

    const refreshed = await payload(platform, jsonRequest(`/api/projects/${projectId}/previews`, {
      method: "POST",
      token: owner.accessToken,
      body: { name: "feature-accounts", ttlHours: 72 },
    }));
    assert.equal(refreshed.created, false);
    assert.equal(refreshed.preview.id, previewId);
    assert.ok(refreshed.preview.previewExpiresAt > firstExpiry);

    const nested = await platform.handle(jsonRequest(`/api/projects/${previewId}/previews`, {
      method: "POST",
      token: owner.accessToken,
      body: { name: "nested" },
    }));
    assert.equal(nested.status, 409);
    assert.equal((await nested.json()).error.code, "PREVIEW_PARENT_REQUIRED");

    const previewSecrets = await payload(platform, jsonRequest(`/api/projects/${previewId}/secrets`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(previewSecrets.secrets, []);
    const previewDeploy = await deploy(
      platform,
      previewId,
      owner.accessToken,
      artifact,
      "preview_feature_accounts_0001",
    );
    assert.equal(previewDeploy.response.status, 201, JSON.stringify(previewDeploy.body));

    const productionDatabase = new DatabaseSync(
      join(dataDirectory, "projects", projectId, "data", "app.sqlite"),
    );
    const previewDatabase = new DatabaseSync(
      join(dataDirectory, "projects", previewId, "data", "app.sqlite"),
    );
    productionDatabase.prepare("INSERT INTO items (value) VALUES (?)").run("production");
    assert.equal(productionDatabase.prepare("SELECT count(*) AS count FROM items").get().count, 1);
    assert.equal(previewDatabase.prepare("SELECT count(*) AS count FROM items").get().count, 0);
    productionDatabase.close();
    previewDatabase.close();

    const projects = await payload(platform, jsonRequest("/api/projects", {
      token: owner.accessToken,
    }));
    assert.deepEqual(projects.projects.map((project) => project.id), [projectId]);
    assert.equal(projects.usage[organizationId], 2);
    const listed = await payload(platform, jsonRequest(`/api/projects/${projectId}/previews`, {
      token: owner.accessToken,
    }));
    assert.equal(listed.previews.length, 1);
    assert.equal(listed.policy.copiesProductionData, false);
    assert.equal(listed.policy.countsTowardProjectQuota, true);

    const parentDelete = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site preview-parent",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(parentDelete.status, 409);
    assert.equal((await parentDelete.json()).error.code, "PREVIEWS_EXIST");

    const manual = await payload(platform, jsonRequest(`/api/projects/${projectId}/previews`, {
      method: "POST",
      token: owner.accessToken,
      body: { name: "manual" },
    }), 201);
    const wrongConfirmation = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/previews/${manual.preview.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: "delete-preview wrong",
          acknowledgeDataLoss: true,
        },
      },
    ));
    assert.equal(wrongConfirmation.status, 400);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/previews/${manual.preview.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-preview manual",
        acknowledgeDataLoss: true,
      },
    }));

    await platform.close();
    closed = true;
    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare("UPDATE clank_platform_projects SET preview_expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, previewId);
    control.close();

    platform = await openPlatform({
      ...platformOptions,
      previews: { cleanupIntervalMs: 1_000 },
    });
    closed = false;
    const afterExpiry = await payload(platform, jsonRequest(`/api/projects/${projectId}/previews`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(afterExpiry.previews, []);
    await assert.rejects(stat(join(dataDirectory, "projects", previewId)), { code: "ENOENT" });
    const audit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=100`,
      { token: owner.accessToken },
    ));
    assert.ok(audit.events.some((event) => event.action === "preview.create"));
    assert.ok(audit.events.some((event) => event.action === "preview.refresh"));
    assert.ok(audit.events.some((event) => event.action === "preview.delete"));
    assert.ok(audit.events.some((event) => event.action === "preview.expire"));
  } finally {
    if (!closed) await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("site deletion is admin-only, path-safe, auditable, and releases every managed resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-site-delete-"));
  const dataDirectory = join(root, "platform");
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4551,
    appPortEnd: 4553,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      projectsPerAccount: 2,
      projectsPerOrganization: 2,
      domainsPerProject: 2,
    },
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      tlsAskToken: "site-delete-tls-token",
      resolveTxt: async () => [],
      resolveCname: async () => [],
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "site-delete-owner@example.com");
    const developer = await authorizeCli(platform, "site-delete-developer@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Disposable Tasks",
        slug: "disposable-tasks",
        organizationId,
      },
    }), 201);
    const projectId = created.project.id;
    const unsafe = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Path Safety",
        slug: "path-safety",
        organizationId,
      },
    }), 201);

    const invitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "site-delete-developer@example.com", role: "developer" },
    }), 201);
    await payload(platform, jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: developer.accessToken,
      body: { token: invitation.invitation.token },
    }));
    const ownerDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    const developerDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: developer.accessToken,
    }));
    assert.deepEqual(ownerDetail.access, { role: "owner", canDelete: true, canOperateJobs: true });
    assert.deepEqual(developerDetail.access, { role: "developer", canDelete: false, canOperateJobs: true });

    const developerDenied = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(developerDenied.status, 403);
    assert.equal((await developerDenied.json()).error.code, "ROLE_DENIED");
    const developerAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=5`,
      { token: developer.accessToken },
    ));
    assert.ok(developerAudit.events.length > 0);
    assert.ok(developerAudit.events.every((event) => event.organization.id === organizationId));
    const developerInvitationEvent = developerAudit.events.find(
      (event) => event.action === "invitation.create",
    );
    assert.ok(developerInvitationEvent);
    assert.equal("email" in developerInvitationEvent.metadata, false);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/members/${developer.user.id}`,
      {
        method: "PATCH",
        token: owner.accessToken,
        body: { role: "admin" },
      },
    ));
    const adminDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: developer.accessToken,
    }));
    assert.deepEqual(adminDetail.access, { role: "admin", canDelete: true, canOperateJobs: true });
    const missingCsrf = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "INVALID_CSRF");
    const wrongConfirmation = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site another-project",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(wrongConfirmation.status, 400);
    assert.equal((await wrongConfirmation.json()).error.code, "CONFIRMATION_REQUIRED");
    const missingAcknowledgement = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: false,
      },
    }));
    assert.equal(missingAcknowledgement.status, 400);
    assert.equal((await missingAcknowledgement.json()).error.code, "DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED");

    const scoped = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Deletion must reject this token",
        permissions: ["read", "tokens", "audit"],
        expiresIn: 3600,
      },
    }), 201);
    const scopedAudit = await payload(platform, jsonRequest("/api/audit?limit=2", {
      token: scoped.token.accessToken,
    }));
    assert.ok(scopedAudit.events.length > 0);
    assert.ok(scopedAudit.events.every((event) => event.project.id === projectId));
    const scopedOrganizationAudit = await platform.handle(jsonRequest(
      `/api/audit?organizationId=${organizationId}`,
      { token: scoped.token.accessToken },
    ));
    assert.equal(scopedOrganizationAudit.status, 403);
    assert.equal((await scopedOrganizationAudit.json()).error.code, "TOKEN_SCOPE_DENIED");
    const scopedDenied = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: scoped.token.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(scopedDenied.status, 403);
    assert.equal((await scopedDenied.json()).error.code, "TOKEN_SCOPE_DENIED");

    const sentinelDirectory = join(root, "outside-project-storage");
    const sentinelFile = join(sentinelDirectory, "keep.txt");
    await mkdir(sentinelDirectory);
    await writeFile(sentinelFile, "do not remove");
    const unsafeProjectRoot = join(dataDirectory, "projects", unsafe.project.id);
    await symlink(sentinelDirectory, unsafeProjectRoot, "dir");
    const unsafeDeletion = await platform.handle(jsonRequest(`/api/projects/${unsafe.project.id}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site path-safety",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(unsafeDeletion.status, 409);
    assert.equal((await unsafeDeletion.json()).error.code, "PROJECT_STORAGE_UNSAFE");
    assert.equal(await readFile(sentinelFile, "utf8"), "do not remove");
    await payload(platform, jsonRequest(`/api/projects/${unsafe.project.id}`, {
      token: owner.accessToken,
    }));
    await unlink(unsafeProjectRoot);
    await payload(platform, jsonRequest(`/api/projects/${unsafe.project.id}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site path-safety",
        acknowledgeDataLoss: true,
      },
    }));
    const capacityReplacement = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Capacity Reclaimed",
        slug: "capacity-reclaimed",
        organizationId,
      },
    }), 201);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/members/${developer.user.id}`,
      {
        method: "PATCH",
        token: owner.accessToken,
        body: { role: "viewer" },
      },
    ));
    const viewerAudit = await platform.handle(jsonRequest(`/api/audit?organizationId=${organizationId}`, {
      token: developer.accessToken,
    }));
    assert.equal(viewerAudit.status, 403);
    assert.equal((await viewerAudit.json()).error.code, "ROLE_DENIED");
    const viewerUnfilteredAudit = await payload(platform, jsonRequest("/api/audit", {
      token: developer.accessToken,
    }));
    assert.deepEqual(viewerUnfilteredAudit.events, []);

    await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { AUDIT_SHORT_SECRET: "abc" } },
    }));
    const deployed = await deploy(
      platform,
      projectId,
      owner.accessToken,
      await appArtifact(join(root, "source"), "before-deletion", [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ]),
      "site-delete-release-key",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    assert.equal(await fetch(deployed.body.release.directUrl).then((response) => response.text()), "before-deletion");
    await payload(platform, jsonRequest(`/api/projects/${projectId}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "reusable.customer.test" },
    }), 201);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      method: "POST",
      token: owner.accessToken,
      body: { reason: "pre-deletion evidence" },
    }), 201);

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare(`INSERT INTO clank_platform_metrics
      (project_id, bucket_started_at, request_count, status_2xx)
      VALUES (?, ?, 1, 1)`).run(projectId, Date.now());
    control.prepare(`INSERT INTO clank_platform_logs
      (project_id, release_id, stream, message, created_at)
      VALUES (?, ?, 'stdout', 'deletion evidence', ?)`)
      .run(projectId, deployed.body.release.id, Date.now());
    control.prepare(`INSERT INTO clank_deployment_placements
      (project_id, desired_release_id, desired_state, assigned_node_id, region, generation,
       observed_release_id, observed_state, observed_generation, updated_at)
      VALUES (?, ?, 'running', NULL, NULL, 1, ?, 'running', 1, ?)`)
      .run(projectId, deployed.body.release.id, deployed.body.release.id, Date.now());
    control.prepare(`INSERT INTO clank_deployment_operations
      (id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
       lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
       created_at, updated_at)
      VALUES (?, ?, 'deploy', '{}', 'succeeded', NULL, 1, 3, 0,
       NULL, NULL, ?, ?, '{}', NULL, ?, ?)`)
      .run(
        "operation_site_delete_test",
        projectId,
        Date.now(),
        "operation-site-delete-test",
        Date.now(),
        Date.now(),
      );
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_deployment_placements WHERE project_id = ?",
    ).get(projectId).count, 1);
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_platform_backup_schedules WHERE project_id = ?",
    ).get(projectId).count, 1);
    control.close();

    const deleted = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(deleted.project.id, projectId);
    assert.equal(deleted.project.revokedTokens, 1);
    assert.equal(deleted.project.domains, 1);
    assert.equal(deleted.project.releases, 1);
    assert.equal(deleted.project.secrets, 1);
    assert.ok(deleted.project.logs >= 1);
    assert.equal(deleted.project.metrics, 1);
    assert.equal(deleted.project.backupSchedules, 1);
    await assert.rejects(
      stat(join(dataDirectory, "projects", projectId)),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      fetch(deployed.body.release.directUrl, { signal: AbortSignal.timeout(1_000) }),
    );
    const scopedRevoked = await platform.handle(jsonRequest("/api/account", {
      token: scoped.token.accessToken,
    }));
    assert.equal(scopedRevoked.status, 401);
    const deletedProject = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    assert.equal(deletedProject.status, 404);
    const workspaceAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=2`,
      { token: owner.accessToken },
    ));
    assert.equal(workspaceAudit.events.length, 2);
    assert.ok(workspaceAudit.nextBefore);
    const deletionEvent = workspaceAudit.events.find((event) => event.action === "project.delete");
    assert.ok(deletionEvent, "workspace activity must expose deletion after the project row is gone");
    assert.equal(deletionEvent.organization.id, organizationId);
    assert.deepEqual(deletionEvent.project, {
      id: projectId,
      name: "Disposable Tasks",
      slug: "disposable-tasks",
      deleted: true,
    });
    assert.equal(deletionEvent.actor.email, "site-delete-owner@example.com");
    const completeWorkspaceAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=200`,
      { token: owner.accessToken },
    ));
    const deletedReleaseEvent = completeWorkspaceAudit.events.find((event) => (
      event.action === "release.activate" && event.project?.id === projectId
    ));
    assert.ok(deletedReleaseEvent);
    assert.equal(deletedReleaseEvent.project.name, "Disposable Tasks");
    assert.equal(deletedReleaseEvent.project.slug, "disposable-tasks");
    assert.equal(deletedReleaseEvent.project.deleted, true);
    const olderAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=2&before=${workspaceAudit.nextBefore}`,
      { token: owner.accessToken },
    ));
    assert.ok(olderAudit.events.length > 0);
    assert.equal(
      olderAudit.events.some((event) => workspaceAudit.events.some((current) => current.id === event.id)),
      false,
    );
    const invalidAuditCursor = await platform.handle(jsonRequest("/api/audit?before=1e2", {
      token: owner.accessToken,
    }));
    assert.equal(invalidAuditCursor.status, 422);

    const finalControl = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    for (const [table, column] of [
      ["clank_platform_projects", "id"],
      ["clank_platform_domains", "project_id"],
      ["clank_platform_releases", "project_id"],
      ["clank_platform_secrets", "project_id"],
      ["clank_platform_logs", "project_id"],
      ["clank_platform_metrics", "project_id"],
      ["clank_platform_backup_schedules", "project_id"],
      ["clank_deployment_placements", "project_id"],
      ["clank_deployment_operations", "project_id"],
    ]) {
      assert.equal(
        finalControl.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`).get(projectId).count,
        0,
        `${table} must not retain project state`,
      );
    }
    assert.ok(finalControl.prepare(
      "SELECT revoked_at FROM clank_platform_tokens WHERE id = ?",
    ).get(scoped.token.id).revoked_at);
    const deletionAudit = finalControl.prepare(`SELECT metadata
      FROM clank_platform_audit WHERE project_id = ? AND action = 'project.delete'
      ORDER BY id DESC LIMIT 1`).get(projectId);
    assert.ok(deletionAudit, "deletion audit history must outlive project metadata");
    assert.equal(JSON.parse(deletionAudit.metadata).slug, "disposable-tasks");
    finalControl.close();

    const recreated = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Disposable Tasks Recreated",
        slug: "disposable-tasks",
        organizationId,
      },
    }), 201);
    assert.equal(recreated.project.port, created.project.port, "deletion must release the application port");
    await payload(platform, jsonRequest(`/api/projects/${recreated.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "reusable.customer.test" },
    }), 201);
    const redeployed = await deploy(
      platform,
      recreated.project.id,
      owner.accessToken,
      await appArtifact(join(root, "recreated-source"), "after-deletion", [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"],
      ]),
      "site-delete-recreated-release-key",
    );
    assert.equal(redeployed.response.status, 201, JSON.stringify(redeployed.body));
    assert.equal(await fetch(redeployed.body.release.directUrl).then((response) => response.text()), "after-deletion");
    assert.notEqual(capacityReplacement.project.id, recreated.project.id);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy audit rows gain workspace attribution without losing their history", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-audit-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4554,
    appPortEnd: 4556,
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "audit-upgrade@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Audit Upgrade",
        slug: "audit-upgrade",
        organizationId,
      },
    }), 201);
    await platform.close();

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare("DELETE FROM clank_platform_projects WHERE id = ?").run(project.project.id);
    control.exec(`
      ALTER TABLE clank_platform_audit RENAME TO clank_platform_audit_with_organization;
      CREATE TABLE clank_platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT NOT NULL,
        actor_token_id TEXT,
        project_id TEXT,
        action TEXT NOT NULL,
        metadata TEXT NOT NULL CHECK (json_valid(metadata)),
        created_at INTEGER NOT NULL
      );
      INSERT INTO clank_platform_audit
        (id, actor_user_id, actor_token_id, project_id, action, metadata, created_at)
      SELECT id, actor_user_id, actor_token_id, project_id, action, metadata, created_at
      FROM clank_platform_audit_with_organization;
      DROP TABLE clank_platform_audit_with_organization;
    `);
    control.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      appPortStart: 4554,
      appPortEnd: 4556,
      signup: true,
      backups: { intervalMs: false },
    });
    const upgraded = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}`,
      { token: owner.accessToken },
    ));
    const projectEvent = upgraded.events.find((event) => event.action === "project.create");
    assert.ok(projectEvent);
    assert.equal(projectEvent.organization.id, organizationId);
    assert.equal(projectEvent.project.id, project.project.id);
    assert.equal(projectEvent.project.deleted, true);
    const upgradedControl = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    assert.ok(upgradedControl.prepare(
      "PRAGMA table_info(clank_platform_audit)",
    ).all().some((column) => column.name === "organization_id"));
    assert.equal(upgradedControl.prepare(
      "SELECT organization_id FROM clank_platform_audit WHERE action = 'project.create'",
    ).get().organization_id, organizationId);
    upgradedControl.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("release storage quotas are enforced and cleanup preserves authorization and rollback safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-storage-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4570,
    appPortEnd: 4575,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      releasesPerProject: 3,
      releaseStorageBytesPerProject: 1024 * 1024 * 1024,
    },
  });
  try {
    const owner = await authorizeCli(platform, "release-storage@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    assert.equal(dashboard.limits.releasesPerProject, 3);
    assert.equal(dashboard.limits.releaseStorageBytesPerProject, 1024 * 1024 * 1024);
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Bounded Releases",
        slug: "bounded-releases",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const projectId = project.project.id;
    const source = join(root, "source");
    const artifacts = [];
    for (const label of ["one", "two", "three", "four"]) {
      artifacts.push(await appArtifact(source, `release-${label}`, [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ]));
    }
    const first = await deploy(platform, projectId, owner.accessToken, artifacts[0], "storage-release-key-0001");
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const second = await deploy(platform, projectId, owner.accessToken, artifacts[1], "storage-release-key-0002");
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    const third = await deploy(platform, projectId, owner.accessToken, artifacts[2], "storage-release-key-0003");
    assert.equal(third.response.status, 201, JSON.stringify(third.body));

    let releases = await payload(platform, jsonRequest(`/api/projects/${projectId}/releases`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(releases.usage, {
      releases: 3,
      storageBytes: releases.releases.reduce((total, release) => total + release.storageBytes, 0),
    });
    assert.deepEqual(releases.limits, {
      releases: 3,
      storageBytes: 1024 * 1024 * 1024,
    });
    const storedSecond = releases.releases.find((release) => release.id === second.body.release.id);
    assert.ok(
      storedSecond.storageBytes > storedSecond.artifactBytes,
      "release storage must include the pre-deploy SQLite snapshot, not only the upload",
    );
    assert.equal(releases.releases.find((release) => release.id === third.body.release.id).cleanup.allowed, false);
    assert.equal(storedSecond.cleanup.rollbackProtected, true);

    const overCount = await deploy(platform, projectId, owner.accessToken, artifacts[3], "storage-release-key-0004");
    assert.equal(overCount.response.status, 409);
    assert.equal(overCount.body.error.code, "RELEASE_LIMIT_REACHED");

    const deployToken = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Deploy-only automation",
        permissions: ["read", "deploy"],
        expiresIn: 3600,
      },
    }), 201);
    const deniedCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: deployToken.token.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(deniedCleanup.status, 403);
    assert.equal((await deniedCleanup.json()).error.code, "TOKEN_SCOPE_DENIED");

    const wrongConfirmation = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: { confirmation: "delete it", allowRollbackLoss: false },
      },
    ));
    assert.equal(wrongConfirmation.status, 400);

    const sentinelDirectory = join(root, "outside-release-storage");
    const sentinelFile = join(sentinelDirectory, "keep.txt");
    await mkdir(sentinelDirectory);
    await writeFile(sentinelFile, "do not remove");
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"));
    control.prepare(`UPDATE clank_platform_releases
      SET directory = ?, backup_path = ? WHERE id = ?`)
      .run(sentinelDirectory, sentinelFile, first.body.release.id);
    control.close();

    const backupDirectory = join(root, "platform", "projects", projectId, "backups");
    const realBackupDirectory = `${backupDirectory}-real`;
    await rename(backupDirectory, realBackupDirectory);
    await symlink(sentinelDirectory, backupDirectory, "dir");
    const symlinkedParentCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(symlinkedParentCleanup.status, 500);
    assert.equal((await symlinkedParentCleanup.json()).error.code, "PLATFORM_ERROR");
    assert.equal(await readFile(sentinelFile, "utf8"), "do not remove");
    assert.ok((await stat(
      join(root, "platform", "projects", projectId, "releases", first.body.release.id),
    )).isDirectory());
    await unlink(backupDirectory);
    await rename(realBackupDirectory, backupDirectory);

    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${first.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${first.body.release.id}`,
        allowRollbackLoss: false,
      },
    }));
    await assert.rejects(
      stat(join(root, "platform", "projects", projectId, "releases", first.body.release.id)),
      (error) => error.code === "ENOENT",
    );
    assert.equal(
      await readFile(sentinelFile, "utf8"),
      "do not remove",
      "cleanup must derive paths instead of trusting mutable database path columns",
    );
    const repeatedCleanup = await payload(
      platform,
      jsonRequest(`/api/projects/${projectId}/releases/${first.body.release.id}`, {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      }),
    );
    assert.equal(repeatedCleanup.release.artifactAvailable, false);

    const fourth = await deploy(platform, projectId, owner.accessToken, artifacts[3], "storage-release-key-0004");
    assert.equal(fourth.response.status, 201, JSON.stringify(fourth.body));
    const activeCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${fourth.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${fourth.body.release.id}`,
          allowRollbackLoss: true,
        },
      },
    ));
    assert.equal(activeCleanup.status, 409);
    assert.equal((await activeCleanup.json()).error.code, "ACTIVE_RELEASE_PROTECTED");

    const secondBackup = join(
      root,
      "platform",
      "projects",
      projectId,
      "backups",
      `${second.body.release.id}.sqlite`,
    );
    assert.ok((await stat(secondBackup)).size > 0);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${second.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${second.body.release.id}`,
        allowRollbackLoss: false,
      },
    }));
    await assert.rejects(stat(secondBackup), (error) => error.code === "ENOENT");

    const protectedCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${third.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${third.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(protectedCleanup.status, 409);
    assert.equal((await protectedCleanup.json()).error.code, "RELEASE_ROLLBACK_PROTECTED");
    const fourthBackup = join(
      root,
      "platform",
      "projects",
      projectId,
      "backups",
      `${fourth.body.release.id}.sqlite`,
    );
    assert.ok((await stat(fourthBackup)).size > 0);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${third.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${third.body.release.id}`,
        allowRollbackLoss: true,
      },
    }));
    await assert.rejects(
      stat(fourthBackup),
      (error) => error.code === "ENOENT",
      "accepting rollback loss must remove the active release's now-unusable matching snapshot",
    );
    const removedRollback = await platform.handle(jsonRequest(`/api/projects/${projectId}/rollback`, {
      method: "POST",
      token: owner.accessToken,
      body: { releaseId: third.body.release.id, restoreData: false },
    }));
    assert.equal(removedRollback.status, 409);
    assert.equal((await removedRollback.json()).error.code, "RELEASE_ARTIFACT_UNAVAILABLE");

    releases = await payload(platform, jsonRequest(`/api/projects/${projectId}/releases`, {
      token: owner.accessToken,
    }));
    assert.equal(releases.releases.length, 4, "cleanup must preserve release history");
    assert.equal(releases.usage.releases, 1);
    assert.equal(releases.releases.find((release) => release.id === second.body.release.id).artifactAvailable, false);
    assert.equal(releases.releases.find((release) => release.id === second.body.release.id).storageBytes, 0);
    const detail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    assert.equal(detail.usage.releases, 1);
    assert.equal(detail.usage.storageBytes, releases.usage.storageBytes);
    const finalControl = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    const activeStorage = finalControl.prepare(`SELECT runtime_bytes, snapshot_bytes, storage_bytes, backup_path
      FROM clank_platform_releases WHERE id = ?`).get(fourth.body.release.id);
    finalControl.close();
    assert.equal(activeStorage.snapshot_bytes, 0);
    assert.equal(activeStorage.storage_bytes, activeStorage.runtime_bytes);
    assert.equal(activeStorage.backup_path, null);
    const audit = await payload(platform, jsonRequest(`/api/projects/${projectId}/audit`, {
      token: owner.accessToken,
    }));
    const cleanupEvents = audit.events.filter((event) => event.action === "release.cleanup");
    assert.equal(cleanupEvents.length, 3);
    assert.ok(cleanupEvents.some((event) => (
      event.metadata.releaseId === third.body.release.id
      && event.metadata.rollbackProtected === true
      && event.metadata.activeSnapshotBytes > 0
    )));
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("release byte quotas reject storage before creating a release directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-byte-limit-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4580,
    appPortEnd: 4582,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      releasesPerProject: 3,
      releaseStorageBytesPerProject: 1,
    },
  });
  try {
    const owner = await authorizeCli(platform, "release-byte-limit@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Tiny Release Storage",
        slug: "tiny-release-storage",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const artifact = await appArtifact(join(root, "source"), "too-large", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const rejected = await deploy(
      platform,
      project.project.id,
      owner.accessToken,
      artifact,
      "release-byte-limit-key",
    );
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "RELEASE_STORAGE_LIMIT_REACHED");
    const releases = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(releases.usage, { releases: 0, storageBytes: 0 });
    await assert.rejects(
      stat(join(root, "platform", "projects", project.project.id, "releases")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy release rows upgrade to conservative storage accounting in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4583,
    appPortEnd: 4584,
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "release-upgrade@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Legacy Releases",
        slug: "legacy-releases",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    await platform.close();

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.exec("DROP TABLE clank_platform_releases");
    control.exec(`CREATE TABLE clank_platform_releases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
      previous_release_id TEXT,
      status TEXT NOT NULL,
      digest TEXT NOT NULL,
      artifact_bytes INTEGER NOT NULL,
      framework_version TEXT NOT NULL,
      node_version TEXT NOT NULL,
      config TEXT NOT NULL CHECK (json_valid(config)),
      directory TEXT NOT NULL,
      backup_path TEXT,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      failure TEXT,
      UNIQUE(project_id, idempotency_key)
    )`);
    const legacyReleaseId = "legacy_release_001";
    control.prepare(`INSERT INTO clank_platform_releases
      (id, project_id, previous_release_id, status, digest, artifact_bytes,
       framework_version, node_version, config, directory, backup_path,
       idempotency_key, created_at)
      VALUES (?, ?, NULL, 'inactive', ?, 321, '0.6.0', ?, ?, ?, NULL, ?, ?)`)
      .run(
        legacyReleaseId,
        project.project.id,
        "b".repeat(64),
        process.version,
        JSON.stringify({
          version: 1,
          entry: "server.js",
          include: ["server.js"],
          database: { path: "app.sqlite", migrations: "migrations", allowUnsafeMigrations: false },
          health: { path: "/healthz", timeoutMs: 5000 },
          env: {},
        }),
        join(dataDirectory, "projects", project.project.id, "releases", legacyReleaseId),
        "legacy-release-key-001",
        Date.now(),
      );
    control.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      appPortStart: 4583,
      appPortEnd: 4584,
      signup: true,
      backups: { intervalMs: false },
    });
    const releases = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(releases.usage, { releases: 1, storageBytes: 321 });
    assert.equal(releases.releases[0].id, legacyReleaseId);
    assert.equal(releases.releases[0].artifactAvailable, true);
    assert.equal(releases.releases[0].artifactBytes, 321);
    assert.equal(releases.releases[0].storageBytes, 321);

    const upgraded = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    const row = upgraded.prepare(`SELECT runtime_bytes, runner_artifact_bytes, runner_artifact_store,
        runner_artifact_key, snapshot_bytes, storage_bytes, artifact_available
      FROM clank_platform_releases WHERE id = ?`).get(legacyReleaseId);
    upgraded.close();
    assert.deepEqual({ ...row }, {
      runtime_bytes: 321,
      runner_artifact_bytes: 0,
      runner_artifact_store: "local",
      runner_artifact_key: null,
      snapshot_bytes: 0,
      storage_bytes: 321,
      artifact_available: 1,
    });
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform signup defaults to one-time first-account bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-bootstrap-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4530,
    appPortEnd: 4531,
  });
  try {
    assert.deepEqual(await payload(platform, jsonRequest("/livez")), {
      ok: true,
      status: "alive",
    });
    const favicon = await platform.handle(jsonRequest("/favicon.ico"));
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/x-icon");
    assert.ok((await favicon.arrayBuffer()).byteLength > 1_000);
    const mark = await platform.handle(jsonRequest("/brand/clank-mark-64.png"));
    assert.equal(mark.status, 200);
    assert.equal(mark.headers.get("content-type"), "image/png");
    assert.ok((await mark.arrayBuffer()).byteLength > 1_000);
    const faviconHead = await platform.handle(jsonRequest("/favicon.ico", { method: "HEAD" }));
    assert.equal(faviconHead.status, 200);
    assert.equal(faviconHead.headers.get("content-type"), "image/x-icon");
    assert.equal((await faviconHead.arrayBuffer()).byteLength, 0);
    const ready = await payload(platform, jsonRequest("/healthz"));
    assert.deepEqual(ready, {
      ok: true,
      status: "ready",
      checks: {
        database: "ok",
      },
    });
    assert.deepEqual(await payload(platform, jsonRequest("/readyz")), ready);
    const signedOutConsole = await platform.handle(jsonRequest("/"));
    assert.equal(signedOutConsole.status, 200);
    const signedOutHtml = await signedOutConsole.text();
    assert.match(signedOutHtml, /<title>Sign in · Clank<\/title>/);
    assert.match(signedOutHtml, /<section class="auth-layout" id="auth-view">/);
    assert.match(signedOutHtml, /<section class="app-shell" id="app-view" hidden>/);
    const signupConsole = await platform.handle(jsonRequest("/signup"));
    const signupHtml = await signupConsole.text();
    assert.match(signupHtml, /<title>Create your account · Clank<\/title>/);
    assert.match(signupHtml, /<h2 id="auth-title">Create your account<\/h2>/);
    assert.match(signupHtml, /<div class="field" id="name-field">/);
    assert.match(signupHtml, /autocomplete="new-password"/);
    const invitationConsole = await platform.handle(jsonRequest("/invite"));
    const invitationHtml = await invitationConsole.text();
    assert.match(invitationHtml, /<title>Accept your invitation · Clank<\/title>/);
    assert.match(invitationHtml, /<h2 id="auth-title">Accept your invitation<\/h2>/);
    assert.match(invitationHtml, /id="registration-invitation-field">/);
    assert.match(invitationHtml, /id="registration-invitation"[^>]+ required>/);
    const first = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "first@example.com",
        password: "Clank8!x",
        profile: { name: "first" },
      },
    }));
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    const firstCookie = first.headers.get("set-cookie").split(";", 1)[0];
    const signedInCookie = firstCookie.replace("clank-id", "proact-id");
    const signedInConsole = await platform.handle(jsonRequest("/", { cookie: signedInCookie }));
    assert.equal(signedInConsole.status, 200);
    const signedInHtml = await signedInConsole.text();
    assert.match(signedInHtml, /"authenticated":true/);
    assert.match(signedInHtml, /id="password"[^>]+minlength="8"/);
    assert.match(signedInHtml, /id="invite-personal-option" value="personal" hidden disabled/);
    assert.match(signedInHtml, /<title>Overview · Clank<\/title>/);
    assert.match(signedInHtml, /<section class="auth-layout" id="auth-view" hidden>/);
    assert.match(signedInHtml, /<section class="app-shell" id="app-view">/);
    assert.match(signedInHtml, /<strong id="account-name">first<\/strong><span id="account-email">first@example\.com<\/span>/);
    assert.match(signedInHtml, /class="brand-lockup"><img class="brand-mark"[^>]*><span>Clank<\/span><\/span>/);
    assert.match(signedInHtml, /\.brand-lockup\{display:inline-flex;align-items:center;gap:9px;/);
    assert.match(signedInHtml, /class="icon-sprite"[^>]*><defs>\s*<symbol id="nav-icon-overview"/);
    assert.match(signedInHtml, /\.nav-icon\{width:18px;height:18px;display:flex;align-items:center;justify-content:center;flex:0 0 18px;/);
    assert.equal((signedInHtml.match(/<span class="nav-icon"><svg aria-hidden="true"><use href="#nav-icon-[^"]+"><\/use><\/svg><\/span>/g) ?? []).length, 14);
    assert.doesNotMatch(signedInHtml, /<span class="nav-icon">[^<]/);
    assert.match(signedInHtml, /id="nav-usage" href="\/usage"/);
    assert.match(signedInHtml, /class="table mobile-card-table usage-table"/);
    assert.match(signedInHtml, /Transparent metering boundary/);
    const consoleScript = signedInHtml.match(
      /<script nonce="[^"]+">([\s\S]+)<\/script><\/body><\/html>/,
    );
    assert(consoleScript);
    assert.doesNotThrow(() => new Function(consoleScript[1]));
    assert.match(signedInHtml, /Build it\./);
    assert.match(signedInHtml, /aria-label="Project navigation"/);
    assert.match(signedInHtml, /data-project-tab="deployments"/);
    assert.match(signedInHtml, /data-project-tab="previews"/);
    assert.match(signedInHtml, /data-project-tab="jobs"/);
    assert.match(signedInHtml, /aria-controls="sidebar"/);
    assert.match(signedInHtml, /id="sidebar-scrim"[^>]+aria-label="Close navigation"/);
    assert.match(signedInHtml, /class="table mobile-card-table release-table"/);
    assert.match(signedInHtml, /class="table mobile-card-table preview-table"/);
    assert.match(signedInHtml, /class="table mobile-card-table backup-table"/);
    assert.match(signedInHtml, /class="table mobile-card-table job-table"/);
    assert.match(signedInHtml, /class="table admin-user-table mobile-card-table"/);
    assert.match(signedInHtml, /class="button-label">Refresh<\/span><span class="button-icon" aria-hidden="true">↻<\/span>/);
    assert.match(signedInHtml, /\.topbar \.button\{min-width:44px;height:44px;padding:0 12px;line-height:1\}/);
    assert.match(signedInHtml, /\.quota-number\{display:flex;align-items:baseline;gap:9px;/);
    assert.match(signedInHtml, /class="quota-used">—<\/strong><span class="quota-total">projects<\/span>/);
    assert.match(signedInHtml, /q\("#quota-number \.quota-total"\)\.textContent=total\+" projects"/);
    assert.match(signedInHtml, /@media\(max-width:900px\)/);
    assert.match(signedInHtml, /\.button,\.input,\.nav-button\{min-height:44px\}/);
    assert.match(signedInHtml, /\.breadcrumbs\{flex:1;min-width:0;overflow:hidden;white-space:nowrap\}/);
    assert.match(signedInHtml, /\.sidebar-account \.button\{flex:0 0 44px;min-width:44px\}/);
    assert.match(signedInHtml, /\.activity-details summary\{display:inline-flex;align-items:center;min-height:44px\}/);
    assert.match(signedInHtml, /grid-template-columns:repeat\(5,minmax\(44px,1fr\)\)/);
    assert.match(signedInHtml, /link\.title=project\.name;link\.append\(el\("span","nav-text",project\.name\)\)/);
    assert.match(signedInHtml, /aria-labelledby="site-dialog-title"/);
    for (const path of [
      "/login",
      "/overview",
      "/usage",
      "/projects",
      "/workspaces",
      "/workspaces/personal/people",
      "/activity",
      "/admin",
      "/projects/my-todo",
      "/projects/my-todo/performance",
      "/projects/my-todo/domains",
      "/projects/my-todo/deployments",
      "/projects/my-todo/previews",
      "/projects/my-todo/backups",
      "/projects/my-todo/logs",
      "/projects/my-todo/jobs",
      "/projects/my-todo/settings",
    ]) {
      const routed = await platform.handle(jsonRequest(path, { cookie: signedInCookie }));
      assert.equal(routed.status, 200, `${path} serves the refresh-safe console shell`);
      assert.match(await routed.text(), /"authenticated":true/);
    }
    const signedOutDeepLink = await platform.handle(jsonRequest("/projects/private-site/domains"));
    assert.equal(signedOutDeepLink.status, 200);
    const signedOutDeepLinkHtml = await signedOutDeepLink.text();
    assert.match(signedOutDeepLinkHtml, /"authenticated":false/);
    assert.match(signedOutDeepLinkHtml, /<section class="auth-layout" id="auth-view">/);
    assert.match(signedOutDeepLinkHtml, /<section class="app-shell" id="app-view" hidden>/);
    const signedInActivity = await platform.handle(jsonRequest("/activity", { cookie: signedInCookie }));
    const signedInActivityHtml = await signedInActivity.text();
    assert.match(signedInActivityHtml, /<title>Activity · Clank<\/title>/);
    assert.match(signedInActivityHtml, /<section id="overview-page" hidden>/);
    assert.match(signedInActivityHtml, /<section id="activity-page">/);
    assert.match(signedInActivityHtml, /id="nav-activity"[^>]+aria-current="page"/);
    const signedInUsage = await platform.handle(jsonRequest("/usage", { cookie: signedInCookie }));
    const signedInUsageHtml = await signedInUsage.text();
    assert.match(signedInUsageHtml, /<title>Usage · Clank<\/title>/);
    assert.match(signedInUsageHtml, /<section id="overview-page" hidden>/);
    assert.match(signedInUsageHtml, /<section id="usage-page">/);
    assert.match(signedInUsageHtml, /id="nav-usage"[^>]+aria-current="page"/);
    const signedInProject = await platform.handle(jsonRequest(
      "/projects/my-todo/domains",
      { cookie: signedInCookie },
    ));
    const signedInProjectHtml = await signedInProject.text();
    assert.match(signedInProjectHtml, /<title>Project · Clank<\/title>/);
    assert.match(signedInProjectHtml, /id="project-navigation">/);
    assert.match(signedInProjectHtml, /<section id="overview-page" hidden>/);
    assert.match(signedInProjectHtml, /<section id="project-page" aria-busy="true">/);
    assert.match(signedInProjectHtml, /<div class="project-loading" id="project-loading"><\/div>/);
    assert.match(signedInProjectHtml, /<div class="project-resolved">/);
    assert.match(
      signedInProjectHtml,
      /#project-page\[aria-busy="true"\] \.project-resolved\{visibility:hidden;pointer-events:none\}/,
    );
    assert.match(signedInProjectHtml, /prepareRoute\(route\);if\(!state\.dashboard\)\{await loadDashboard/);
    assert.match(signedInProjectHtml, /const generation=\+\+state\.routeGeneration/);
    assert.match(signedInProjectHtml, /generation!==state\.routeGeneration\|\|!state\.dashboard/);
    const canonical = await platform.handle(jsonRequest(
      "/projects/my-todo/domains/?range=7d",
      { cookie: signedInCookie },
    ));
    assert.equal(canonical.status, 308);
    assert.equal(canonical.headers.get("location"), "/projects/my-todo/domains?range=7d");
    const unknownConsoleRoute = await platform.handle(jsonRequest(
      "/projects/my-todo/not-a-section",
      { cookie: signedInCookie },
    ));
    assert.equal(unknownConsoleRoute.status, 404);
    assert.equal((await unknownConsoleRoute.json()).error.code, "NOT_FOUND");
    const signedOutUnknownConsoleRoute = await platform.handle(jsonRequest(
      "/projects/private-site/not-a-section",
    ));
    assert.equal(signedOutUnknownConsoleRoute.status, 404);
    assert.equal((await signedOutUnknownConsoleRoute.json()).error.code, "NOT_FOUND");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { cookie: firstCookie }));
    const organizationId = dashboard.organizations[0].id;
    const invitation = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        cookie: firstCookie,
        csrf: firstBody.csrfToken,
        body: { email: "second@example.com", role: "developer" },
      },
    ), 201);
    const second = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "second@example.com",
        password: "correct horse battery staple",
        profile: { name: "second" },
      },
    }));
    assert.equal(second.status, 403);
    assert.equal((await second.json()).error.code, "SIGNUP_DISABLED");
    for (const [path, email] of [
      ["/__clank/auth//register", "slash-bypass@example.com"],
      ["/__proact/auth///register", "legacy-slash-bypass@example.com"],
    ]) {
      const bypass = await platform.handle(jsonRequest(path, {
        method: "POST",
        body: {
          email,
          password: "correct horse battery staple",
          profile: { name: "bypass" },
        },
      }));
      assert.equal(bypass.status, 403);
      assert.equal((await bypass.json()).error.code, "SIGNUP_DISABLED");
    }
    const crossOrigin = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      origin: "https://evil.example",
      body: {
        token: invitation.invitation.token,
        email: "second@example.com",
        password: "correct horse battery staple",
        profile: { name: "second" },
      },
    }));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, "ORIGIN_MISMATCH");
    const invalidInvitation = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: "clnki_invalid_invitation_token_value",
        email: "second@example.com",
        password: "correct horse battery staple",
        profile: { name: "second" },
      },
    }));
    assert.equal(invalidInvitation.status, 400);
    assert.equal((await invalidInvitation.json()).error.code, "INVALID_INVITATION");
    const wrongEmail = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "wrong@example.com",
        password: "correct horse battery staple",
        profile: { name: "wrong" },
      },
    }));
    assert.equal(wrongEmail.status, 400);
    assert.equal((await wrongEmail.json()).error.code, "INVALID_INVITATION");
    const invited = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "second@example.com",
        password: "correct horse battery staple",
        profile: { name: "second" },
      },
    }));
    assert.equal(invited.status, 201);
    const invitedBody = await invited.json();
    assert.equal(invitedBody.organizationId, organizationId);
    assert.equal(invitedBody.role, "developer");
    assert.equal(invitedBody.user.email, "second@example.com");
    const invitedCookie = invited.headers.get("set-cookie").split(";", 1)[0];
    const invitedDashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: invitedCookie,
    }));
    assert.equal(
      invitedDashboard.organizations.find((organization) => organization.id === organizationId).role,
      "developer",
    );
    const replay = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "second@example.com",
        password: "another correct horse battery staple",
        profile: { name: "second replay" },
      },
    }));
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, "INVALID_INVITATION");
    await platform.close();
    const closed = await platform.handle(jsonRequest("/healthz"));
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error.code, "PLATFORM_CLOSED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTPS control plane emits HSTS only on its configured hostname", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-hsts-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "https://deploy.example.test",
    appPortStart: 4540,
    appPortEnd: 4541,
    backups: { intervalMs: false },
  });
  try {
    const controlPlane = await platform.handle(new Request("https://deploy.example.test/healthz"));
    assert.equal(controlPlane.status, 200);
    assert.equal(controlPlane.headers.get("strict-transport-security"), "max-age=31536000");

    const unrelatedHost = await platform.handle(new Request("https://other.example.test/healthz"));
    assert.equal(unrelatedHost.status, 200);
    assert.equal(unrelatedHost.headers.get("strict-transport-security"), null);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closed platform signup still permits an unexpired invitation to create its bound account", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-invited-signup-"));
  let platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4532,
    appPortEnd: 4533,
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "closed-owner@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: owner.cookie,
    }));
    const organizationId = dashboard.organizations[0].id;
    const expiredInvitation = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrfToken,
        body: { email: "expired@example.com", role: "viewer" },
      },
    ), 201);
    const invitation = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrfToken,
        body: { email: "closed-member@example.com", role: "admin" },
      },
    ), 201);
    await platform.close();

    const control = new DatabaseSync(join(root, "control.sqlite"));
    control.prepare(
      "UPDATE clank_platform_invitations SET expires_at = ? WHERE id = ?",
    ).run(Date.now() - 1, expiredInvitation.invitation.id);
    control.close();

    platform = await openPlatform({
      dataDirectory: root,
      publicUrl: "http://127.0.0.1:4200",
      appPortStart: 4532,
      appPortEnd: 4533,
      signup: false,
      backups: { intervalMs: false },
    });
    const direct = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "closed-member@example.com",
        password: "correct horse battery staple",
        profile: { name: "closed member" },
      },
    }));
    assert.equal(direct.status, 403);
    assert.equal((await direct.json()).error.code, "SIGNUP_DISABLED");
    const normalizedBypass = await platform.handle(jsonRequest("/__clank/auth//register", {
      method: "POST",
      body: {
        email: "disabled-slash-bypass@example.com",
        password: "correct horse battery staple",
        profile: { name: "disabled bypass" },
      },
    }));
    assert.equal(normalizedBypass.status, 403);
    assert.equal((await normalizedBypass.json()).error.code, "SIGNUP_DISABLED");

    const expired = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: expiredInvitation.invitation.token,
        email: "expired@example.com",
        password: "correct horse battery staple",
        profile: { name: "expired" },
      },
    }));
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error.code, "INVALID_INVITATION");

    const invited = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "closed-member@example.com",
        password: "correct horse battery staple",
        profile: { name: "closed member" },
      },
    }));
    assert.equal(invited.status, 201);
    const result = await invited.json();
    assert.equal(result.organizationId, organizationId);
    assert.equal(result.role, "admin");
    assert.equal(result.user.email, "closed-member@example.com");

    const database = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
    const users = database.prepare(
      "SELECT email FROM clank_auth_users WHERE email IN (?, ?) ORDER BY email",
    ).all("closed-member@example.com", "expired@example.com");
    database.close();
    assert.deepEqual(users.map((row) => row.email), ["closed-member@example.com"]);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform administrators can invite a personal-only account without granting workspace access", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-personal-invitation-"));
  const dataDirectory = join(root, "platform");
  const baseOptions = {
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    platformAdminEmails: ["personal-admin@example.com"],
    backups: { intervalMs: false },
  };
  let platform = await openPlatform({ ...baseOptions, signup: true });
  try {
    const admin = await authorizeCli(platform, "personal-admin@example.com");
    const ordinary = await authorizeCli(platform, "existing-person@example.com");
    const adminDashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: admin.cookie,
    }));
    const adminWorkspaceId = adminDashboard.organizations[0].id;

    const ordinaryDenied = await platform.handle(jsonRequest("/api/admin/invitations", {
      cookie: ordinary.cookie,
    }));
    assert.equal(ordinaryDenied.status, 403);
    assert.equal((await ordinaryDenied.json()).error.code, "PLATFORM_ADMIN_REQUIRED");
    const bearerDenied = await platform.handle(jsonRequest("/api/admin/invitations", {
      token: admin.accessToken,
    }));
    assert.equal(bearerDenied.status, 403);
    assert.equal((await bearerDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");
    const missingCsrf = await platform.handle(jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      body: { email: "personal-only@example.com" },
    }));
    assert.equal(missingCsrf.status, 403);
    const crossOrigin = await platform.handle(jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      origin: "https://evil.example",
      body: { email: "personal-only@example.com" },
    }));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, "ORIGIN_MISMATCH");
    const existingAccount = await platform.handle(jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { email: ordinary.user.email },
    }));
    assert.equal(existingAccount.status, 409);
    assert.equal((await existingAccount.json()).error.code, "ACCOUNT_EXISTS");

    const superseded = await payload(platform, jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { email: "personal-only@example.com" },
    }), 201);
    assert.match(superseded.invitation.token, /^clnkp_/);
    const invitation = await payload(platform, jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { email: "personal-only@example.com" },
    }), 201);
    assert.equal(invitation.invitation.scope, "personal");
    const active = await payload(platform, jsonRequest("/api/admin/invitations", {
      cookie: admin.cookie,
    }));
    assert.equal(active.limit, 100);
    assert.equal(active.invitations.length, 1);
    assert.equal(active.invitations[0].id, invitation.invitation.id);
    assert.equal(active.invitations[0].scope, "personal");
    assert.equal(Object.hasOwn(active.invitations[0], "token"), false);
    assert.equal(JSON.stringify(active).includes("token_hash"), false);

    const supersededUse = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: superseded.invitation.token,
        email: "personal-only@example.com",
        password: "correct horse battery staple",
        profile: { name: "personal only" },
      },
    }));
    assert.equal(supersededUse.status, 400);
    assert.equal((await supersededUse.json()).error.code, "INVALID_INVITATION");
    const wrongEmail = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "wrong-person@example.com",
        password: "correct horse battery staple",
        profile: { name: "wrong person" },
      },
    }));
    assert.equal(wrongEmail.status, 400);
    assert.equal((await wrongEmail.json()).error.code, "INVALID_INVITATION");

    await platform.close();
    platform = await openPlatform({ ...baseOptions, signup: false });
    const persisted = await payload(platform, jsonRequest("/api/admin/invitations", {
      cookie: admin.cookie,
    }));
    assert.equal(persisted.invitations.length, 1);
    assert.equal(persisted.invitations[0].id, invitation.invitation.id);
    const direct = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "personal-only@example.com",
        password: "correct horse battery staple",
        profile: { name: "personal only" },
      },
    }));
    assert.equal(direct.status, 403);
    assert.equal((await direct.json()).error.code, "SIGNUP_DISABLED");

    const invited = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "personal-only@example.com",
        password: "correct horse battery staple",
        profile: { name: "personal only" },
      },
    }));
    assert.equal(invited.status, 201);
    const invitedBody = await invited.json();
    assert.equal(invitedBody.invitationScope, "personal");
    assert.equal(invitedBody.organizationId, null);
    assert.equal(invitedBody.role, null);
    const invitedCookie = invited.headers.get("set-cookie").split(";", 1)[0];
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: invitedCookie,
    }));
    assert.equal(dashboard.organizations.length, 1);
    assert.equal(dashboard.organizations[0].role, "owner");
    assert.notEqual(dashboard.organizations[0].id, adminWorkspaceId);
    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    const memberships = control.prepare(`SELECT m.organization_id, m.role, o.created_by
      FROM clank_platform_memberships m
      JOIN clank_platform_organizations o ON o.id = m.organization_id
      WHERE m.user_id = ?`).all(invitedBody.user.id).map((row) => ({ ...row }));
    assert.deepEqual(memberships, [{
      organization_id: dashboard.organizations[0].id,
      role: "owner",
      created_by: invitedBody.user.id,
    }]);
    assert.equal(control.prepare(`SELECT count(*) AS count FROM clank_platform_memberships
      WHERE user_id = ? AND organization_id = ?`).get(invitedBody.user.id, adminWorkspaceId).count, 0);
    const auditActions = control.prepare(`SELECT action FROM clank_platform_audit
      WHERE action LIKE 'personal_invitation.%' ORDER BY id`).all().map((row) => row.action);
    control.close();
    assert.deepEqual(auditActions, [
      "personal_invitation.create",
      "personal_invitation.create",
      "personal_invitation.accept",
    ]);
    const replay = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: invitation.invitation.token,
        email: "personal-only@example.com",
        password: "another correct horse battery staple",
        profile: { name: "replay" },
      },
    }));
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, "INVALID_INVITATION");

    const revocable = await payload(platform, jsonRequest("/api/admin/invitations", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { email: "revoked-personal@example.com" },
    }), 201);
    await payload(platform, jsonRequest(
      `/api/admin/invitations/${revocable.invitation.id}`,
      {
        method: "DELETE",
        cookie: admin.cookie,
        csrf: admin.csrfToken,
      },
    ));
    const revoked = await platform.handle(jsonRequest("/__clank/auth/invited-register", {
      method: "POST",
      body: {
        token: revocable.invitation.token,
        email: "revoked-personal@example.com",
        password: "correct horse battery staple",
        profile: { name: "revoked" },
      },
    }));
    assert.equal(revoked.status, 400);
    assert.equal((await revoked.json()).error.code, "INVALID_INVITATION");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap registration is claimed transactionally across control-plane runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-bootstrap-claim-"));
  const options = {
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4534,
    appPortEnd: 4535,
    backups: { intervalMs: false },
  };
  const firstPlatform = await openPlatform(options);
  const secondPlatform = await openPlatform(options);
  try {
    const registrations = await Promise.all([
      firstPlatform.handle(jsonRequest("/__clank/auth/register", {
        method: "POST",
        body: {
          email: "bootstrap-a@example.com",
          password: "correct horse battery staple",
          profile: { name: "bootstrap a" },
        },
      })),
      secondPlatform.handle(jsonRequest("/__clank/auth/register", {
        method: "POST",
        body: {
          email: "bootstrap-b@example.com",
          password: "correct horse battery staple",
          profile: { name: "bootstrap b" },
        },
      })),
    ]);
    assert.deepEqual(registrations.map((response) => response.status).sort(), [201, 409]);
    const rejected = registrations.find((response) => response.status === 409);
    assert.equal((await rejected.json()).error.code, "SIGNUP_IN_PROGRESS");

    const database = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
    const userCount = database.prepare("SELECT count(*) AS count FROM clank_auth_users").get().count;
    const claimCount = database.prepare(
      "SELECT count(*) AS count FROM clank_platform_bootstrap_claim",
    ).get().count;
    database.close();
    assert.equal(userCount, 1);
    assert.equal(claimCount, 0);
  } finally {
    await Promise.all([firstPlatform.close(), secondPlatform.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("platform auth and device rate limits survive control-plane changes without storing raw identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-rate-limits-"));
  const options = {
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4536,
    appPortEnd: 4537,
    signup: true,
    backups: { intervalMs: false },
  };
  let firstPlatform = await openPlatform(options);
  let secondPlatform = await openPlatform(options);
  let thirdPlatform;
  try {
    const registered = await firstPlatform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "durable-limit@example.com",
        password: "correct horse battery staple",
        profile: { name: "durable limit" },
      },
    }));
    assert.equal(registered.status, 201);

    for (const platform of [firstPlatform, secondPlatform]) {
      const rejected = await platform.handle(jsonRequest("/__clank/auth/login", {
        method: "POST",
        body: {
          email: "durable-limit@example.com",
          password: "wrong password value",
        },
      }));
      assert.equal(rejected.status, 401);
      assert.equal((await rejected.json()).error.code, "INVALID_CREDENTIALS");
    }

    let control = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
    let rateLimits = control.prepare(
      "SELECT key_hash, attempts FROM clank_platform_rate_limits ORDER BY expires_at",
    ).all();
    control.close();
    assert.deepEqual(
      rateLimits.map((row) => JSON.parse(row.attempts).length).sort((left, right) => left - right),
      [1, 2],
    );
    assert.ok(rateLimits.every((row) => /^[A-Za-z0-9_-]{43}$/u.test(row.key_hash)));
    assert.doesNotMatch(JSON.stringify(rateLimits), /durable-limit|example\\.com|unknown/iu);

    const loggedIn = await secondPlatform.handle(jsonRequest("/__clank/auth/login", {
      method: "POST",
      body: {
        email: "durable-limit@example.com",
        password: "correct horse battery staple",
      },
    }));
    assert.equal(loggedIn.status, 200);
    control = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
    rateLimits = control.prepare("SELECT attempts FROM clank_platform_rate_limits").all();
    control.close();
    assert.deepEqual(rateLimits.map((row) => JSON.parse(row.attempts).length), [1]);

    for (let index = 0; index < 10; index++) {
      const platform = index % 2 === 0 ? firstPlatform : secondPlatform;
      const started = await platform.handle(jsonRequest("/api/device/start", {
        method: "POST",
        body: { clientName: `durable device ${index}` },
      }));
      assert.equal(started.status, 201);
    }
    control = new DatabaseSync(join(root, "control.sqlite"));
    const future = Date.now() + 30_000;
    control.prepare(`UPDATE clank_platform_rate_limits SET attempts = ?, expires_at = ?
      WHERE json_array_length(attempts) = 10`)
      .run(JSON.stringify(Array.from({ length: 10 }, () => future)), future + 60_000);
    control.close();
    await Promise.all([firstPlatform.close(), secondPlatform.close()]);
    thirdPlatform = await openPlatform(options);
    const limited = await thirdPlatform.handle(jsonRequest("/api/device/start", {
      method: "POST",
      body: { clientName: "one too many" },
    }));
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json();
    assert.equal(limitedBody.error.code, "RATE_LIMITED");
    assert.ok(limitedBody.error.retryAfter > 0);
    assert.ok(limitedBody.error.retryAfter <= 60);

    await thirdPlatform.close();
    thirdPlatform = undefined;
    control = new DatabaseSync(join(root, "control.sqlite"));
    control.exec("DELETE FROM clank_platform_rate_limits");
    const insert = control.prepare(`INSERT INTO clank_platform_rate_limits
      (key_hash, attempts, expires_at) VALUES (?, ?, ?)`);
    control.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 20_000; index++) {
        insert.run(`seed-${String(index).padStart(5, "0")}`, JSON.stringify([Date.now()]), Date.now() + 60_000);
      }
      control.exec("COMMIT");
    } catch (error) {
      control.exec("ROLLBACK");
      throw error;
    }
    control.close();

    thirdPlatform = await openPlatform(options);
    const bounded = await thirdPlatform.handle(jsonRequest("/api/device/start", {
      method: "POST",
      body: { clientName: "bounded state" },
    }));
    assert.equal(bounded.status, 201);
    control = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
    const retained = control.prepare(
      "SELECT count(*) AS count FROM clank_platform_rate_limits",
    ).get().count;
    control.close();
    assert.equal(retained, 18_000);
  } finally {
    await Promise.all([
      firstPlatform.close(),
      secondPlatform.close(),
      thirdPlatform?.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("platform reports unexpected failures privately without exposing exception text", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-errors-"));
  const privateMessage = "internal resolver credential: operator-secret";
  const observed = [];
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4560,
    appPortEnd: 4561,
    signup: true,
    ingress: {
      baseDomain: "apps.example.test",
      resolveTxt: async () => {
        throw new Error(privateMessage);
      },
    },
    onError(error) {
      observed.push(error);
    },
  });
  try {
    const owner = await authorizeCli(platform, "error-owner@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Error Boundary", slug: "error-boundary" },
    }), 201);
    const domain = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "errors.example.test" },
    }), 201);
    const response = await platform.handle(jsonRequest(
      `/api/projects/${created.project.id}/domains/${domain.domain.id}/verify`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    const result = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "PLATFORM_ERROR",
        message: "The platform operation failed.",
      },
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].message, privateMessage);
    assert.doesNotMatch(JSON.stringify(result), /operator-secret/);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Timed out waiting for condition.");
}
