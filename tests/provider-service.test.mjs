import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDeploymentBundle } from "../dist/deploy.js";
import { openDeploymentProviderDataStore } from "../dist/provider-data.js";
import {
  DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
  openDeploymentProviderService,
} from "../dist/provider-service.js";
import { createDeploymentRuntimeCapsule } from "../dist/runtime-placement.js";

test("provider service orders durable data, deferred jobs, ingress, stop, and restart recovery", async () => {
  const fixture = await serviceFixture("lifecycle");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_service_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "initial"),
      jobs: true,
    });
    const request = providerInput(runtime, 1);
    const first = await fixture.open();
    await first.service.reconcile(request);
    assert.deepEqual(first.events, [
      "launch-web:1",
      "activate-background:1",
      "ingress-activate:1",
    ]);
    const firstState = await first.service.inspect("project_service_01");
    assert.deepEqual(firstState, {
      protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
      projectId: "project_service_01",
      operationId: "operation_1_1",
      fence: 1,
      generation: 1,
      state: "running",
      releaseId: "release_service_01",
      capsuleSha256: runtime.sha256,
      phase: "running",
      updatedAt: firstState.updatedAt,
    });
    const persisted = await readFile(join(
      fixture.providerRoot,
      "service",
      "project_service_01.json",
    ), "utf8");
    assert.equal(persisted.includes("service-secret-canary"), false);
    assert.equal((await first.service.snapshot("project_service_01")).generation, 1);
    assert.equal(await (await first.service.handle(new Request(
      "https://provider.example/v1/clank/apps/project_service_01",
    ))).text(), "fake ingress");

    const beforeRetry = first.events.length;
    await first.service.reconcile(request);
    assert.deepEqual(first.events.slice(beforeRetry), [
      "launch-retry:1",
      "activate-retry:1",
      "ingress-retry:1",
    ]);
    assert.equal(first.events.includes("runtime-stop:1"), false);
    await first.service.close();

    const restarted = await fixture.open();
    await restarted.service.reconcile(request);
    assert.deepEqual(restarted.events, [
      "launch-web:1",
      "activate-background:1",
      "ingress-activate:1",
    ]);
    const stopped = stoppedInput(2, 2);
    await restarted.service.reconcile(stopped);
    assert.deepEqual(restarted.events.slice(-2), [
      "ingress-deactivate:1",
      "runtime-stop:1",
    ]);
    assert.equal((await restarted.service.inspect("project_service_01")).phase, "stopped");
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 1);
    await assert.rejects(
      restarted.service.reconcile(providerInput(runtime, 3)),
      /generation is stale/u,
    );
    await restarted.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service rejects unsafe roots and verifies capsules before durable intent", async () => {
  const linked = await serviceFixture("linked-state");
  try {
    const outside = join(linked.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(linked.providerRoot, "service"), "dir");
    await assert.rejects(
      linked.open(),
      /owner-controlled real directory|outside its provider root/u,
    );
  } finally {
    await linked.close();
  }

  const fixture = await serviceFixture("capsule-admission");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_admission_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "initial"),
    });
    const opened = await fixture.open();
    const tampered = new Uint8Array(runtime.bytes);
    tampered[tampered.byteLength - 1] ^= 1;
    await assert.rejects(
      opened.service.reconcile({
        ...providerInput(runtime, 5),
        operation: {
          ...providerInput(runtime, 5).operation,
          id: "operation_tampered_5",
          fence: 5,
        },
        runtime: {
          ...runtime,
          bytes: tampered,
        },
      }),
      /requires a running runtime capsule/u,
    );
    assert.equal(await opened.service.inspect("project_service_01"), null);
    await opened.service.reconcile(providerInput(runtime, 1));
    assert.equal((await opened.service.inspect("project_service_01")).generation, 1);
    await opened.service.close();
    await assert.rejects(
      opened.service.reconcile(providerInput(runtime, 2)),
      /service is closed/u,
    );
  } finally {
    await fixture.close();
  }
});

test("provider service bootstraps its durable high-water mark from existing provider data", async () => {
  const fixture = await serviceFixture("existing-data");
  try {
    const runtime = await fixture.runtime({
      generation: 3,
      releaseId: "release_existing_03",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "existing"),
    });
    await fixture.data.apply(providerInput(runtime, 4), async () => {});
    const opened = await fixture.open();
    await assert.rejects(
      opened.service.reconcile(stoppedInput(3, 5)),
      /conflicts with provider data/u,
    );
    await assert.rejects(
      opened.service.reconcile({
        ...stoppedInput(4, 4),
        operation: {
          ...stoppedInput(4, 4).operation,
          id: "operation_stop_4_4",
        },
      }),
      /fence is stale against provider data/u,
    );
    assert.equal(await opened.service.inspect("project_service_01"), null);
    await opened.service.reconcile(providerInput(runtime, 4));
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service fails closed after activation failure and retries committed data", async () => {
  const fixture = await serviceFixture("activation");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_activation_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
      jobs: true,
    });
    const opened = await fixture.open();
    await opened.service.reconcile(providerInput(firstRuntime, 1));
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_activation_02",
      mode: "preserve",
      jobs: true,
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
        ["0002_done.sql", "ALTER TABLE todo ADD COLUMN done INTEGER DEFAULT 0;\n"],
      ],
    });
    opened.ingress.failGeneration = 2;
    const secondRequest = providerInput(secondRuntime, 2);
    await assert.rejects(
      opened.service.reconcile(secondRequest),
      /synthetic ingress activation failure/u,
    );
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 2);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "reconciling");
    assert.equal(opened.runtimes.inspect().length, 0);
    assert.equal(opened.ingress.inspect().length, 0);
    assert.deepEqual(opened.events.slice(-5), [
      "ingress-deactivate:1",
      "runtime-stop:1",
      "launch-web:2",
      "activate-background:2",
      "runtime-stop:2",
    ]);

    opened.ingress.failGeneration = null;
    await opened.service.reconcile(secondRequest);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");
    assert.equal(opened.runtimes.inspect()[0].generation, 2);
    assert.equal(opened.ingress.inspect()[0].generation, 2);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service preserves writers when traffic cannot drain and protects durable fences", async () => {
  const fixture = await serviceFixture("fences");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_fence_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
    });
    const opened = await fixture.open();
    await opened.service.reconcile(providerInput(firstRuntime, 1));
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_fence_02",
      mode: "preserve",
    });
    opened.ingress.shouldDrain = false;
    await assert.rejects(
      opened.service.reconcile(providerInput(secondRuntime, 2)),
      /did not drain/u,
    );
    assert.equal(opened.runtimes.inspect()[0].generation, 1);
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 1);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "reconciling");
    assert.equal(opened.events.includes("runtime-stop:1"), false);

    await assert.rejects(
      opened.service.reconcile({
        ...providerInput(secondRuntime, 2),
        operation: {
          ...providerInput(secondRuntime, 2).operation,
          id: "operation_conflicting_fence",
        },
      }),
      /conflicts with its durable fence/u,
    );
    opened.ingress.shouldDrain = true;
    await opened.service.reconcile(providerInput(secondRuntime, 2));
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");

    const statePath = join(
      fixture.providerRoot,
      "service",
      "project_service_01.json",
    );
    await chmod(statePath, 0o644);
    await assert.rejects(
      opened.service.inspect("project_service_01"),
      /private regular file/u,
    );
    await chmod(statePath, 0o600);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service cleans a tracked runtime even when launch returns no candidate", async () => {
  const fixture = await serviceFixture("uncertain-runtime");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_uncertain_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "uncertain"),
    });
    const opened = await fixture.open({ failLaunchAfterRecord: true });
    await assert.rejects(
      opened.service.reconcile(providerInput(runtime, 1)),
      /synthetic runtime launch failure/u,
    );
    assert.deepEqual(opened.events, [
      "launch-web:1",
      "runtime-stop:1",
    ]);
    assert.deepEqual(opened.runtimes.inspect(), []);
    assert.equal(await fixture.data.inspect("project_service_01"), null);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

async function serviceFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `clank-provider-service-${name}-`));
  const providerRoot = join(root, "provider");
  const data = await openDeploymentProviderDataStore({
    rootDirectory: providerRoot,
    maxDatabaseBytes: 16 * 1024 * 1024,
  });
  return {
    root,
    providerRoot,
    data,
    async runtime(options) {
      const source = join(root, `source-${options.generation}-${options.releaseId}`);
      await mkdir(join(source, "dist"), { recursive: true });
      await mkdir(join(source, "migrations"), { recursive: true });
      await writeFile(
        join(source, "dist", "server.js"),
        `export const generation = ${options.generation};\n`,
      );
      await writeFile(
        join(source, "dist", "jobs.js"),
        `export const generation = ${options.generation};\n`,
      );
      const migrations = options.migrations ?? [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ];
      for (const [filename, sql] of migrations) {
        await writeFile(join(source, "migrations", filename), sql);
      }
      const artifact = await createDeploymentBundle(source, {
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
        ...(options.jobs
          ? {
              jobs: {
                entry: "dist/jobs.js",
                workers: 2,
                concurrency: 2,
                queues: [],
                scheduler: true,
              },
            }
          : {}),
      }, {
        frameworkVersion: "0.9.4-test",
        nodeVersion: "22.16.0",
      });
      return createDeploymentRuntimeCapsule({
        projectId: "project_service_01",
        releaseId: options.releaseId,
        generation: options.generation,
        environment: {
          CLANK_MANAGED_INGRESS: "1",
          PRIVATE_SECRET: "service-secret-canary",
        },
        database: {
          path: "app.sqlite",
          mode: options.mode,
          snapshot: options.snapshot,
        },
        ingress: {
          route: "/v1/clank/apps/project_service_01",
          token: "clanki_provider-service-token-12345678901234567890",
        },
        artifact,
      }, {
        maxDatabaseBytes: 16 * 1024 * 1024,
      });
    },
    async open(runtimeOptions = {}) {
      const events = [];
      const runtimes = fakeRuntimes(events, runtimeOptions);
      const ingress = fakeIngress(events);
      const service = await openDeploymentProviderService({
        rootDirectory: providerRoot,
        data,
        runtimes,
        ingress,
        drainTimeoutMs: 100,
      });
      return { service, runtimes, ingress, events };
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fakeRuntimes(events, options = {}) {
  const records = new Map();
  const candidates = new Map();
  let closed = false;
  return {
    async launch({ prepared, deferBackground }) {
      if (closed) throw new Error("fake runtimes closed");
      const existing = records.get(prepared.projectId);
      if (existing) {
        if (
          existing.releaseId === prepared.releaseId
          && existing.generation === prepared.generation
          && existing.capsuleSha256 === prepared.capsuleSha256
        ) {
          events.push(`launch-retry:${prepared.generation}`);
          return existing.candidate;
        }
        throw new Error("fake runtime conflict");
      }
      const candidate = Object.freeze({
        protocol: "clank-provider-docker/1",
        projectId: prepared.projectId,
        releaseId: prepared.releaseId,
        generation: prepared.generation,
        capsuleSha256: prepared.capsuleSha256,
        upstream: `http://127.0.0.1:${46_000 + prepared.generation}`,
      });
      const record = {
        ...candidate,
        candidate,
        status: "candidate",
        port: 46_000 + prepared.generation,
        containers: 1,
        launchedAt: Date.now(),
        deferBackground,
        jobs: prepared.config.jobs
          ? prepared.config.jobs.workers + (prepared.config.jobs.scheduler ? 1 : 0)
          : 0,
      };
      records.set(prepared.projectId, record);
      candidates.set(candidate, record);
      events.push(`launch-web:${prepared.generation}`);
      if (options.failLaunchAfterRecord) {
        throw new Error("synthetic runtime launch failure");
      }
      return candidate;
    },
    async activate(candidate) {
      const record = candidates.get(candidate);
      if (!record) throw new Error("fake candidate unknown");
      if (record.status === "active") {
        events.push(`activate-retry:${record.generation}`);
        return runtimeState(record);
      }
      events.push(`activate-background:${record.generation}`);
      record.containers += record.jobs;
      record.status = "active";
      return runtimeState(record);
    },
    commit(candidate) {
      const record = candidates.get(candidate);
      if (!record) throw new Error("fake candidate unknown");
      record.status = "active";
      return runtimeState(record);
    },
    inspect() {
      return Object.freeze([...records.values()].map(runtimeState));
    },
    async stop(projectId, generation) {
      const record = records.get(projectId);
      if (!record || (generation !== undefined && record.generation !== generation)) return false;
      events.push(`runtime-stop:${record.generation}`);
      records.delete(projectId);
      candidates.delete(record.candidate);
      return true;
    },
    forget() {
      return false;
    },
    async close() {
      closed = true;
      records.clear();
      candidates.clear();
    },
  };
}

function runtimeState(record) {
  return Object.freeze({
    protocol: record.protocol,
    projectId: record.projectId,
    releaseId: record.releaseId,
    generation: record.generation,
    capsuleSha256: record.capsuleSha256,
    upstream: record.upstream,
    status: record.status,
    port: record.port,
    containers: record.containers,
    launchedAt: record.launchedAt,
  });
}

function fakeIngress(events) {
  const bindings = new Map();
  let closed = false;
  const ingress = {
    failGeneration: null,
    shouldDrain: true,
    async activate(binding) {
      if (closed) throw new Error("fake ingress closed");
      if (ingress.failGeneration === binding.generation) {
        throw new Error("synthetic ingress activation failure");
      }
      const key = `${binding.projectId}:${binding.generation}`;
      const existing = bindings.get(key);
      if (existing) {
        events.push(`ingress-retry:${binding.generation}`);
        return ingressState(existing);
      }
      bindings.set(key, { ...binding, activatedAt: Date.now() });
      events.push(`ingress-activate:${binding.generation}`);
      return ingressState(bindings.get(key));
    },
    inspect() {
      return Object.freeze([...bindings.values()].map(ingressState));
    },
    async handle() {
      return new Response("fake ingress");
    },
    async drain() {
      return ingress.shouldDrain;
    },
    async deactivate(projectId, generation) {
      const key = `${projectId}:${generation}`;
      const existing = bindings.get(key);
      if (!existing) return Object.freeze({ removed: false, drained: true });
      bindings.delete(key);
      events.push(`ingress-deactivate:${generation}`);
      return Object.freeze({ removed: true, drained: ingress.shouldDrain });
    },
    forget() {
      return false;
    },
    async close() {
      closed = true;
      bindings.clear();
      return true;
    },
  };
  return ingress;
}

function ingressState(binding) {
  return Object.freeze({
    protocol: "clank-provider-ingress/1",
    projectId: binding.projectId,
    releaseId: binding.releaseId,
    generation: binding.generation,
    path: binding.path,
    activatedAt: binding.activatedAt,
    inFlight: 0,
    latest: true,
  });
}

function providerInput(runtime, fence) {
  return {
    operation: {
      id: `operation_${runtime.manifest.generation}_${fence}`,
      projectId: runtime.manifest.projectId,
      fence,
      attempt: 1,
      maxAttempts: 3,
    },
    desired: {
      generation: runtime.manifest.generation,
      releaseId: runtime.manifest.releaseId,
      state: "running",
      runtimeProtocol: "clank-runtime/1",
    },
    artifact: runtime.artifact,
    runtime,
    signal: new AbortController().signal,
  };
}

function stoppedInput(generation, fence) {
  return {
    operation: {
      id: `operation_stop_${generation}_${fence}`,
      projectId: "project_service_01",
      fence,
      attempt: 1,
      maxAttempts: 3,
    },
    desired: {
      generation,
      releaseId: null,
      state: "stopped",
      runtimeProtocol: null,
    },
    artifact: null,
    runtime: null,
    signal: new AbortController().signal,
  };
}

async function sqliteSnapshot(root, value) {
  const filename = join(root, `snapshot-${value}-${crypto.randomUUID()}.sqlite`);
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE seed (value TEXT NOT NULL)");
  database.prepare("INSERT INTO seed (value) VALUES (?)").run(value);
  database.close();
  return new Uint8Array(await readFile(filename));
}
