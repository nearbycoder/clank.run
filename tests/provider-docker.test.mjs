import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL,
  openDockerDeploymentRuntimeLauncher,
} from "../dist/provider-docker.js";
import { parseDeploymentConfig } from "../dist/deploy.js";

const IMAGE = `clank-test@sha256:${"a".repeat(64)}`;
// Keep synthetic runtime listeners below Linux's default ephemeral range so
// parallel test traffic cannot claim a probed port before the fixture binds it.
const TEST_PORT_BASE = 25_100;

test("provider Docker launcher keeps application secrets outside the Docker client boundary", async () => {
  const fixture = await dockerFixture("boundary");
  const priorUnrelated = process.env.CLANK_TEST_UNRELATED_HOST_SECRET;
  process.env.CLANK_TEST_UNRELATED_HOST_SECRET = "must-not-reach-docker";
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE,
      portEnd: TEST_PORT_BASE + 5,
    });
    const controller = new AbortController();
    const prepared = await fixture.prepared({
      environment: {
        APP_SECRET: "docker-runtime-secret-canary",
        DOCKER_HOST: "tcp://attacker.invalid:2375",
        LD_PRELOAD: "/app/attacker.so",
      },
    });
    const candidate = await launcher.launch({
      prepared,
      signal: controller.signal,
    });
    assert.equal(candidate.protocol, DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL);
    assert.equal(candidate.projectId, prepared.projectId);
    assert.equal(candidate.generation, 1);
    assert.match(candidate.upstream, /^http:\/\/127\.0\.0\.1:2510[0-5]$/u);

    const runtime = await fetch(`${candidate.upstream}/environment`).then((response) =>
      response.json());
    assert.deepEqual(runtime, {
      appSecret: "docker-runtime-secret-canary",
      dockerHost: "tcp://attacker.invalid:2375",
      ldPreload: "/app/attacker.so",
      database: "/data/app.sqlite",
      managedIngress: "1",
      trustProxy: "1",
    });

    const audit = await fixture.audit();
    const create = audit.find((entry) => entry.command === "create");
    assert.ok(create);
    assert.equal(create.hostEnvironment.APP_SECRET, null);
    assert.equal(create.hostEnvironment.DOCKER_HOST, null);
    assert.equal(create.hostEnvironment.LD_PRELOAD, null);
    assert.equal(create.hostEnvironment.UNRELATED_HOST_SECRET, null);
    assert.equal(create.arguments.includes("docker-runtime-secret-canary"), false);
    assert.equal(create.arguments.includes("tcp://attacker.invalid:2375"), false);
    assert.equal(create.arguments.includes("/app/attacker.so"), false);
    assert.equal(create.arguments.includes("--read-only"), true);
    assert.equal(create.arguments.includes("ALL"), true);
    assert.equal(create.arguments.includes("no-new-privileges=true"), true);
    assert.equal(create.arguments.includes("--memory-swap"), true);
    assert.equal(create.arguments.includes("--restart"), true);
    assert.equal(create.arguments.includes("no"), true);
    assert.equal(create.arguments.includes("--pull"), true);
    assert.equal(create.arguments.includes("never"), true);
    assert.equal(create.arguments.some((value) =>
      value === "run.clank.managed=provider-runtime"), true);
    assert.equal(create.arguments.some((value) =>
      value === "run.clank.owner=test-boundary"), true);
    assert.equal(create.arguments.some((value) =>
      value.startsWith("CLANK_RUNTIME_ENV")), false);
    assert.equal(create.arguments.includes("--env"), false);
    assert.equal(create.arguments.includes("-e"), false);

    const committed = launcher.commit(candidate);
    assert.equal(committed.status, "active");
    assert.equal(committed.containers, 1);
    assert.deepEqual(launcher.inspect(), [committed]);
    let diagnostics;
    await waitUntil(async () => {
      diagnostics = await launcher.diagnostics(prepared.projectId, 20);
      return diagnostics.logs.some((entry) =>
        entry.message === "web runtime ready");
    });
    assert.equal(
      diagnostics.protocol,
      "clank-provider-docker-diagnostics/2",
    );
    assert.equal(diagnostics.projectId, prepared.projectId);
    assert.equal(diagnostics.releaseId, prepared.releaseId);
    assert.equal(diagnostics.generation, 1);
    assert.equal(diagnostics.statisticsAvailable, true);
    assert.deepEqual(diagnostics.totals, {
      memoryBytes: 64 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      cpuPercent: 1.5,
      networkReceiveBytes: 1_500,
      networkTransmitBytes: 2_500,
      blockReadBytes: 4 * 1024,
      blockWriteBytes: 8 * 1024,
      pids: 7,
    });
    assert.equal(diagnostics.filesystem.available, true);
    assert.equal(diagnostics.filesystem.capacityBytes > 0, true);
    assert.equal(diagnostics.filesystem.usedBytes >= 0, true);
    assert.equal(diagnostics.filesystem.availableBytes >= 0, true);
    assert.equal(
      diagnostics.filesystem.usedBytes
        + diagnostics.filesystem.availableBytes
        <= diagnostics.filesystem.capacityBytes,
      true,
    );
    assert.equal(
      diagnostics.filesystem.utilization,
      diagnostics.filesystem.usedBytes
        / diagnostics.filesystem.capacityBytes,
    );
    assert.deepEqual(diagnostics.containers.map((container) => ({
      role: container.role,
      instance: container.instance,
      running: container.running,
    })), [{ role: "web", instance: 0, running: true }]);
    assert.equal(diagnostics.logs.at(-1).stream, "stdout");
    assert.equal(diagnostics.retainedLogBytes > 0, true);
    assert.equal(await launcher.diagnostics("unknown_project", 20), null);
    await assert.rejects(
      launcher.diagnostics(prepared.projectId, 1_001),
      /logLimit/iu,
    );
    const cancelledDiagnostics = new AbortController();
    cancelledDiagnostics.abort(new Error("diagnostic requester disconnected"));
    await assert.rejects(
      launcher.diagnostics(
        prepared.projectId,
        20,
        cancelledDiagnostics.signal,
      ),
      /diagnostic requester disconnected/iu,
    );
    assert.equal(await launcher.launch({
      prepared,
      signal: controller.signal,
    }), candidate);
    await assert.rejects(
      launcher.launch({
        prepared: await fixture.prepared({
          generation: 2,
          releaseId: "release_docker_02",
        }),
        signal: controller.signal,
      }),
      /stop.+current Docker runtime/iu,
    );

    assert.equal(await launcher.stop(prepared.projectId, 2), false);
    assert.equal(await launcher.stop(prepared.projectId, 1), true);
    assert.deepEqual(launcher.inspect(), []);
    await assert.rejects(
      launcher.launch({
        prepared: await fixture.prepared({
          releaseId: "release_docker_conflict",
          capsuleSha256: "c".repeat(64),
        }),
        signal: controller.signal,
      }),
      /conflicts with committed state/iu,
    );
    const relaunched = await launcher.launch({
      prepared,
      signal: controller.signal,
    });
    assert.equal((await fetch(`${relaunched.upstream}/healthz`)).status, 200);
    launcher.commit(relaunched);
    assert.equal(await launcher.stop(prepared.projectId, 1), true);
    assert.equal(launcher.forget(prepared.projectId, 2), false);
    assert.equal(launcher.forget(prepared.projectId, 1), true);
    await launcher.close();
    await assert.rejects(
      launcher.launch({
        prepared,
        signal: controller.signal,
      }),
      /closed/u,
    );
    assert.deepEqual(await fixture.containerIds(), []);
  } finally {
    if (priorUnrelated === undefined) delete process.env.CLANK_TEST_UNRELATED_HOST_SECRET;
    else process.env.CLANK_TEST_UNRELATED_HOST_SECRET = priorUnrelated;
    await fixture.close();
  }
});

test("provider Docker launcher starts bounded workers and scheduler without publishing their ports", async () => {
  const fixture = await dockerFixture("jobs", { jobs: true });
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 10,
      portEnd: TEST_PORT_BASE + 12,
    });
    const candidate = await launcher.launch({
      prepared: await fixture.prepared(),
      signal: new AbortController().signal,
    });
    const state = launcher.commit(candidate);
    assert.equal(state.containers, 4);
    await waitUntil(async () =>
      (await fixture.audit()).filter((entry) => entry.command === "start").length === 4);
    const starts = (await fixture.audit()).filter((entry) => entry.command === "start");
    assert.equal(starts.length, 4);
    assert.deepEqual(
      starts.map((entry) => entry.runtimeEnvironment.CLANK_PROCESS_ROLE ?? "web").sort(),
      ["scheduler", "web", "worker", "worker"],
    );
    assert.equal(
      starts.filter((entry) => entry.runtimeEnvironment.CLANK_PROCESS_ROLE === "worker")
        .every((entry) =>
          entry.runtimeEnvironment.CLANK_WORKER_CONCURRENCY === "3"
          && entry.runtimeEnvironment.CLANK_WORKER_QUEUES === "mail,index"),
      true,
    );
    const creates = (await fixture.audit()).filter((entry) => entry.command === "create");
    assert.equal(creates.length, 4);
    assert.equal(creates.filter((entry) => entry.arguments.includes("--publish")).length, 1);
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider diagnostics bound output and fail a malformed resource sample closed", async () => {
  const fixture = await dockerFixture("diagnostics-failure", {
    malformedStats: true,
  });
  const errors = [];
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 6,
      portEnd: TEST_PORT_BASE + 9,
      onError(error) {
        errors.push(error);
      },
    });
    const prepared = await fixture.prepared({
      environment: { LOG_BURST: "1" },
    });
    const candidate = await launcher.launch({
      prepared,
      signal: new AbortController().signal,
    });
    launcher.commit(candidate);
    let diagnostics;
    await waitUntil(async () => {
      diagnostics = await launcher.diagnostics(prepared.projectId, 1_000);
      return diagnostics.logsTruncated;
    });
    assert.equal(diagnostics.statisticsAvailable, false);
    assert.equal(diagnostics.retainedLogBytes <= 128 * 1024, true);
    assert.equal(diagnostics.logs.length <= 1_000, true);
    assert.equal(
      diagnostics.logs.reduce(
        (bytes, entry) => bytes + Buffer.byteLength(entry.message),
        0,
      ) <= 128 * 1024,
      true,
    );
    assert.deepEqual(diagnostics.totals, {
      memoryBytes: null,
      memoryLimitBytes: null,
      cpuPercent: null,
      networkReceiveBytes: null,
      networkTransmitBytes: null,
      blockReadBytes: null,
      blockWriteBytes: null,
      pids: null,
    });
    assert.equal(
      diagnostics.filesystem.available,
      true,
      "filesystem capacity remains independently available when Docker stats fail",
    );
    assert.equal(
      diagnostics.containers.every((container) =>
        container.memoryBytes === null
        && container.networkTransmitBytes === null
        && container.pids === null),
      true,
    );
    assert.equal(launcher.inspect()[0].status, "active");
    assert.ok(errors.some((error) =>
      error.message.includes("resource diagnostics failed")));
    assert.equal(
      errors.some((error) => error.message.includes("burst-")),
      false,
    );
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher defers background work until durable activation", async () => {
  const fixture = await dockerFixture("deferred-jobs", { jobs: true });
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 15,
      portEnd: TEST_PORT_BASE + 17,
    });
    const signal = new AbortController().signal;
    const candidate = await launcher.launch({
      prepared: await fixture.prepared(),
      signal,
      deferBackground: true,
    });
    assert.equal(launcher.inspect()[0].containers, 1);
    assert.equal(
      (await fixture.audit()).filter((entry) => entry.command === "start").length,
      1,
    );
    assert.throws(
      () => launcher.commit(candidate),
      /background processes must be activated/iu,
    );

    const active = await launcher.activate(candidate, signal);
    assert.equal(active.status, "active");
    assert.equal(active.containers, 4);
    assert.deepEqual(await launcher.activate(candidate, signal), active);
    await waitUntil(async () =>
      (await fixture.audit()).filter((entry) => entry.command === "start").length === 4);
    const starts = (await fixture.audit()).filter((entry) => entry.command === "start");
    assert.equal(starts.length, 4);
    assert.deepEqual(
      starts.map((entry) => entry.runtimeEnvironment.CLANK_PROCESS_ROLE ?? "web").sort(),
      ["scheduler", "web", "worker", "worker"],
    );
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher never starts deferred jobs after the web candidate fails", async () => {
  const fixture = await dockerFixture("deferred-web-failure", { jobs: true });
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 18,
      portEnd: TEST_PORT_BASE + 19,
    });
    const signal = new AbortController().signal;
    const candidate = await launcher.launch({
      prepared: await fixture.prepared(),
      signal,
      deferBackground: true,
    });
    const [id] = await fixture.containerIds();
    const state = JSON.parse(await readFile(
      join(fixture.stateDirectory, `${id}.json`),
      "utf8",
    ));
    process.kill(state.pid, "SIGKILL");
    await waitUntil(() => launcher.inspect()[0]?.status === "failed");
    await assert.rejects(
      launcher.activate(candidate, signal),
      /candidate has failed/u,
    );
    assert.equal(
      (await fixture.audit()).filter((entry) => entry.command === "start").length,
      1,
    );
    assert.deepEqual(launcher.inspect(), []);
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher cleans exact-owner orphans and failed candidates", async () => {
  const fixture = await dockerFixture("recovery");
  try {
    const orphan = "f".repeat(64);
    await writeFile(
      join(fixture.stateDirectory, `${orphan}.json`),
      JSON.stringify({
        id: orphan,
        arguments: [
          "--label", "run.clank.managed=provider-runtime",
          "--label", "run.clank.owner=test-recovery",
        ],
        pid: null,
      }),
    );
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 20,
      portEnd: TEST_PORT_BASE + 22,
      fetch: async () => new Response("unhealthy", { status: 503 }),
    });
    const startupAudit = await fixture.audit();
    const ownedList = startupAudit.find((entry) => entry.command === "ls");
    assert.ok(ownedList.arguments.includes("label=run.clank.managed=provider-runtime"));
    assert.ok(ownedList.arguments.includes("label=run.clank.owner=test-recovery"));
    assert.equal(startupAudit.some((entry) =>
      entry.command === "rm" && entry.arguments.includes(orphan)), true);
    await assert.rejects(
      launcher.launch({
        prepared: await fixture.prepared({
          config: {
            ...fixture.config,
            health: { path: "/healthz", timeoutMs: 1_000 },
          },
        }),
        signal: new AbortController().signal,
      }),
      /health check timed out/iu,
    );
    assert.deepEqual(launcher.inspect(), []);
    assert.deepEqual(await fixture.containerIds(), []);
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher converges an uncertain create by exact deployment labels", async () => {
  const fixture = await dockerFixture("uncertain-create", {
    failCreateAfterSaveOnce: true,
    failRemoveOnce: true,
  });
  try {
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 23,
      portEnd: TEST_PORT_BASE + 24,
    });
    await assert.rejects(
      launcher.launch({
        prepared: await fixture.prepared(),
        signal: new AbortController().signal,
      }),
      /Docker create failed/iu,
    );
    assert.deepEqual(launcher.inspect(), []);
    assert.deepEqual(await fixture.containerIds(), []);
    const audit = await fixture.audit();
    assert.equal(
      audit.filter((entry) =>
        entry.command === "ls"
        && entry.arguments.includes("label=run.clank.project=project_docker_01")
        && entry.arguments.includes("label=run.clank.release=release_docker_01")
        && entry.arguments.includes("label=run.clank.generation=1")).length >= 2,
      true,
    );
    assert.equal(audit.filter((entry) => entry.command === "rm").length >= 2, true);
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher rejects mutable images, unsafe roots, capacity overflow, and abort", async () => {
  const fixture = await dockerFixture("admission");
  try {
    await assert.rejects(
      openDockerDeploymentRuntimeLauncher({
        rootDirectory: fixture.providerRoot,
        owner: "test-admission",
        image: "node:22-bookworm-slim",
        executable: fixture.executable,
      }),
      /immutable @sha256 digest/iu,
    );
    await assert.rejects(
      openDockerDeploymentRuntimeLauncher({
        rootDirectory: fixture.providerRoot,
        owner: "test-admission",
        image: IMAGE,
        executable: fixture.executable,
        dockerEnvironment: { "invalid-name": "value" },
      }),
      /dockerEnvironment contains an invalid entry/iu,
    );
    const containerBounded = await fixture.open({
      portStart: TEST_PORT_BASE + 28,
      portEnd: TEST_PORT_BASE + 29,
      maxRuntimes: 10,
      maxContainers: 2,
    });
    const jobConfig = parseDeploymentConfig({
      ...fixture.config,
      jobs: {
        entry: "dist/jobs.js",
        workers: 2,
        concurrency: 1,
        queues: [],
        scheduler: true,
      },
    });
    await assert.rejects(
      containerBounded.launch({
        prepared: await fixture.prepared({ config: jobConfig }),
        signal: new AbortController().signal,
      }),
      /container capacity reached/iu,
    );
    assert.equal((await fixture.audit()).filter((entry) => entry.command === "create").length, 0);
    await containerBounded.close();
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 30,
      portEnd: TEST_PORT_BASE + 31,
      maxRuntimes: 1,
    });
    const first = await launcher.launch({
      prepared: await fixture.prepared(),
      signal: new AbortController().signal,
    });
    launcher.commit(first);
    const secondProject = await fixture.prepared({
      projectId: "project_docker_02",
      releaseId: "release_docker_02",
    });
    await assert.rejects(
      launcher.launch({
        prepared: secondProject,
        signal: new AbortController().signal,
      }),
      /capacity reached/iu,
    );

    const outside = join(fixture.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "app.sqlite"), "not-used");
    await assert.rejects(
      launcher.launch({
        prepared: {
          ...secondProject,
          databasePath: join(outside, "app.sqlite"),
        },
        signal: new AbortController().signal,
      }),
      /outside its provider-owned root/iu,
    );
    const aborted = new AbortController();
    aborted.abort(new Error("lease-lost"));
    await assert.rejects(
      launcher.launch({
        prepared: secondProject,
        signal: aborted.signal,
      }),
      /lease-lost/u,
    );
    await launcher.close();
  } finally {
    await fixture.close();
  }
});

test("provider Docker launcher cannot publish a candidate across close", async () => {
  const fixture = await dockerFixture("close-race");
  try {
    let healthStarted;
    const enteredHealth = new Promise((resolve) => {
      healthStarted = resolve;
    });
    const launcher = await fixture.open({
      portStart: TEST_PORT_BASE + 40,
      portEnd: TEST_PORT_BASE + 41,
      fetch: async (_url, options) => {
        healthStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(options.signal.reason ?? new Error("health-aborted"));
          }, { once: true });
        });
      },
    });
    const launching = launcher.launch({
      prepared: await fixture.prepared(),
      signal: new AbortController().signal,
    });
    const rejected = assert.rejects(launching, /closing|closed|stopped/iu);
    await enteredHealth;
    await launcher.close();
    await rejected;
    assert.deepEqual(launcher.inspect(), []);
    assert.deepEqual(await fixture.containerIds(), []);
  } finally {
    await fixture.close();
  }
});

async function dockerFixture(name, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `clank-provider-docker-${name}-`));
  const providerRoot = join(root, "provider");
  const stateDirectory = join(root, "docker-state");
  const executable = join(root, "fake-docker.mjs");
  const auditPath = join(root, "docker-audit.jsonl");
  await mkdir(providerRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(executable, FAKE_DOCKER, { mode: 0o700 });
  await chmod(executable, 0o700);
  const priorState = process.env.CLANK_TEST_DOCKER_STATE;
  const priorAudit = process.env.CLANK_TEST_DOCKER_AUDIT;
  process.env.CLANK_TEST_DOCKER_STATE = stateDirectory;
  process.env.CLANK_TEST_DOCKER_AUDIT = auditPath;
  const launchers = [];
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
    ...(options.jobs
      ? {
          jobs: {
            entry: "dist/jobs.js",
            workers: 2,
            concurrency: 3,
            queues: ["mail", "index"],
            scheduler: true,
          },
        }
      : {}),
  });

  async function prepared(overrides = {}) {
    const projectId = overrides.projectId ?? "project_docker_01";
    const releaseId = overrides.releaseId ?? "release_docker_01";
    const generation = overrides.generation ?? 1;
    const project = join(providerRoot, "projects", projectId);
    const releaseDirectory = join(project, "generations", `g${generation}-${releaseId}`);
    const data = join(project, "data");
    await mkdir(join(releaseDirectory, "dist"), { recursive: true, mode: 0o700 });
    await mkdir(join(releaseDirectory, "migrations"), { recursive: true, mode: 0o700 });
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, "app.sqlite"), "test-database", { mode: 0o600 });
    await writeFile(join(releaseDirectory, "dist", "server.js"), TEST_SERVER, {
      mode: 0o600,
    });
    await writeFile(join(releaseDirectory, "dist", "jobs.js"), TEST_JOB, {
      mode: 0o600,
    });
    return Object.freeze({
      projectId,
      releaseId,
      generation,
      fence: generation,
      capsuleSha256: overrides.capsuleSha256 ?? "b".repeat(64),
      releaseDirectory,
      databasePath: join(data, "app.sqlite"),
      config: overrides.config ?? config,
      environment: Object.freeze({
        APP_SECRET: "default-secret",
        ...(overrides.environment ?? {}),
      }),
      ingress: Object.freeze({
        route: `/v1/clank/apps/${projectId}`,
        token: "runtime-route-token-that-is-long-enough-for-tests",
      }),
      migrationCount: 0,
      previous: null,
      alreadyCommitted: false,
    });
  }

  return {
    root,
    providerRoot,
    stateDirectory,
    executable,
    config,
    prepared,
    async open(overrides = {}) {
      const launcher = await openDockerDeploymentRuntimeLauncher({
        rootDirectory: providerRoot,
        owner: `test-${name}`,
        image: IMAGE,
        executable,
        dockerEnvironment: {
          CLANK_TEST_DOCKER_STATE: stateDirectory,
          CLANK_TEST_DOCKER_AUDIT: auditPath,
          ...(options.failCreateAfterSaveOnce
            ? { CLANK_TEST_DOCKER_FAIL_CREATE_AFTER_SAVE_ONCE: "1" }
            : {}),
          ...(options.failRemoveOnce
            ? { CLANK_TEST_DOCKER_FAIL_REMOVE_ONCE: "1" }
            : {}),
          ...(options.malformedStats
            ? { CLANK_TEST_DOCKER_MALFORMED_STATS: "1" }
            : {}),
        },
        commandTimeoutMs: 5_000,
        stopTimeoutMs: 1_000,
        ...overrides,
      });
      launchers.push(launcher);
      return launcher;
    },
    async audit() {
      try {
        return (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },
    async containerIds() {
      return (await readdir(stateDirectory))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -5))
        .sort();
    },
    async close() {
      await Promise.allSettled(launchers.map((launcher) => launcher.close()));
      if (priorState === undefined) delete process.env.CLANK_TEST_DOCKER_STATE;
      else process.env.CLANK_TEST_DOCKER_STATE = priorState;
      if (priorAudit === undefined) delete process.env.CLANK_TEST_DOCKER_AUDIT;
      else process.env.CLANK_TEST_DOCKER_AUDIT = priorAudit;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitUntil(check) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TEST_SERVER = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.url === "/environment") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      appSecret: process.env.APP_SECRET,
      dockerHost: process.env.DOCKER_HOST,
      ldPreload: process.env.LD_PRELOAD,
      database: process.env.CLANK_DATABASE_PATH,
      managedIngress: process.env.CLANK_MANAGED_INGRESS,
      trustProxy: process.env.TRUST_PROXY,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.env.PORT), process.env.HOST);
console.log("web runtime ready");
if (process.env.LOG_BURST === "1") {
  for (let index = 0; index < 256; index++) {
    console.log("burst-" + index + "-" + "x".repeat(1024));
  }
}
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`.trim();

const TEST_JOB = `
const keepAlive = setInterval(() => {}, 60_000);
process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
`.trim();

const FAKE_DOCKER = `#!/usr/bin/env node
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const stateDirectory = process.env.CLANK_TEST_DOCKER_STATE;
const auditPath = process.env.CLANK_TEST_DOCKER_AUDIT;
if (!stateDirectory || !auditPath) process.exit(91);
const args = process.argv.slice(2);
const operation = args[0] === "container" ? args[1] : "";

const append = async (value) => {
  await appendFile(auditPath, JSON.stringify(value) + "\\n");
};
const statePath = (id) => join(stateDirectory, id + ".json");
const load = async (id) => JSON.parse(await readFile(statePath(id), "utf8"));
const save = async (state) => writeFile(statePath(state.id), JSON.stringify(state));
const markerExists = async (name) => {
  try {
    await readFile(join(stateDirectory, name));
    return true;
  } catch {
    return false;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (operation === "ls") {
  const entries = await readdir(stateDirectory);
  const filters = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--filter") filters.push(args[index + 1]);
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const state = JSON.parse(await readFile(join(stateDirectory, entry), "utf8"));
    const labels = new Set();
    for (let index = 0; index < state.arguments.length; index++) {
      if (state.arguments[index] === "--label") labels.add(state.arguments[index + 1]);
    }
    if (filters.every((filter) =>
      filter.startsWith("label=") && labels.has(filter.slice("label=".length)))) {
      process.stdout.write(entry.slice(0, -5) + "\\n");
    }
  }
  await append({ command: "ls", arguments: args });
  process.exit(0);
}

if (operation === "create") {
  const entries = await readdir(stateDirectory);
  const id = (entries.length + 1).toString(16).padStart(64, "0");
  await save({ id, arguments: args.slice(2), pid: null });
  await append({
    command: "create",
    arguments: args.slice(2),
    hostEnvironment: {
      APP_SECRET: process.env.APP_SECRET ?? null,
      DOCKER_HOST: process.env.DOCKER_HOST ?? null,
      LD_PRELOAD: process.env.LD_PRELOAD ?? null,
      UNRELATED_HOST_SECRET: process.env.CLANK_TEST_UNRELATED_HOST_SECRET ?? null,
    },
  });
  if (
    process.env.CLANK_TEST_DOCKER_FAIL_CREATE_AFTER_SAVE_ONCE === "1"
    && !(await markerExists(".create-failed-once"))
  ) {
    await writeFile(join(stateDirectory, ".create-failed-once"), "1");
    process.stderr.write("synthetic uncertain create failure");
    process.exit(42);
  }
  process.stdout.write(id + "\\n");
  process.exit(0);
}

if (operation === "stats") {
  if (process.env.CLANK_TEST_DOCKER_MALFORMED_STATS === "1") {
    process.stdout.write('{"ID":"wrong","MemUsage":"unbounded"}\\n');
    await append({ command: "stats", arguments: args, malformed: true });
    process.exit(0);
  }
  const formatIndex = args.indexOf("--format");
  const ids = args.slice(formatIndex + 2);
  for (const id of ids) {
    process.stdout.write(JSON.stringify({
      ID: id.slice(0, 12),
      MemUsage: "64MiB / 512MiB",
      CPUPerc: "1.50%",
      NetIO: "1.5kB / 2.5kB",
      BlockIO: "4KiB / 8KiB",
      PIDs: "7",
    }) + "\\n");
  }
  await append({ command: "stats", arguments: args });
  process.exit(0);
}

if (operation === "start") {
  const id = args.at(-1);
  const state = await load(id);
  const input = await new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => value += chunk);
    process.stdin.on("end", () => resolve(value));
  });
  const encoded = input.trim();
  const runtimeEnvironment = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const imageIndex = state.arguments.findIndex((value) => value.startsWith("clank-test@sha256:"));
  const command = state.arguments.slice(imageIndex + 1);
  const mount = state.arguments.find((value) =>
    value.startsWith("type=bind,source=") && value.endsWith(",target=/app,readonly"));
  const cwd = mount.slice("type=bind,source=".length, -",target=/app,readonly".length);
  const child = spawn(process.execPath, command.slice(1), {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    },
    stdio: ["pipe", "inherit", "inherit"],
  });
  state.pid = child.pid;
  await save(state);
  child.stdin.end(input);
  await append({ command: "start", arguments: args, runtimeEnvironment });
  const result = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.exit(typeof result.code === "number" ? result.code : 1);
}

if (operation === "inspect") {
  const id = args.at(-1);
  const state = await load(id);
  process.stdout.write(alive(state.pid) ? "true\\n" : "false\\n");
  await append({ command: "inspect", arguments: args });
  process.exit(0);
}

if (operation === "stop") {
  const timeIndex = args.indexOf("--time");
  const ids = args.slice(timeIndex + 2);
  for (const id of ids) {
    try {
      const state = await load(id);
      if (alive(state.pid)) process.kill(state.pid, "SIGTERM");
    } catch {}
  }
  await append({ command: "stop", arguments: args });
  process.exit(0);
}

if (operation === "rm") {
  const ids = args.slice(args.indexOf("--force") + 1);
  if (
    process.env.CLANK_TEST_DOCKER_FAIL_REMOVE_ONCE === "1"
    && !(await markerExists(".remove-failed-once"))
  ) {
    await writeFile(join(stateDirectory, ".remove-failed-once"), "1");
    await append({ command: "rm", arguments: args, failed: true });
    process.stderr.write("synthetic remove failure");
    process.exit(43);
  }
  for (const id of ids) {
    try {
      const state = await load(id);
      if (alive(state.pid)) process.kill(state.pid, "SIGKILL");
    } catch {}
    await rm(statePath(id), { force: true });
  }
  await append({ command: "rm", arguments: args });
  process.exit(0);
}

process.stderr.write("unsupported fake Docker command: " + args.join(" "));
process.exit(92);
`;
