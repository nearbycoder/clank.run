import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDeploymentBundle } from "../dist/deploy.js";
import {
  DEPLOYMENT_PROVIDER_DATA_PROTOCOL,
  openDeploymentProviderDataStore,
} from "../dist/provider-data.js";
import { backupSQLite, restoreSQLiteBackup } from "../dist/migrations.js";
import { createDeploymentRuntimeCapsule } from "../dist/runtime-placement.js";

test("provider data stages isolated releases, migrates SQLite, snapshots, and rolls back", async () => {
  const fixture = await providerFixture("lifecycle");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_data_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "original"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n"],
      ],
      environment: {
        CLANK_MANAGED_INGRESS: "1",
        PRIVATE_RUNTIME_SECRET: "provider-secret-must-remain-memory-only",
      },
    });
    let firstPrepared;
    const first = await fixture.store.apply(
      providerInput(firstRuntime, 1),
      async (prepared) => {
        firstPrepared = prepared;
        assert.equal(prepared.alreadyCommitted, false);
        assert.equal(prepared.migrationCount, 1);
        assert.equal(prepared.previous, null);
        assert.equal(
          prepared.environment.PRIVATE_RUNTIME_SECRET,
          "provider-secret-must-remain-memory-only",
        );
        assert.equal(prepared.ingress.route, "/v1/clank/apps/project_data_01");
        assert.equal(prepared.config.entry, "dist/server.js");
        assert.equal(prepared.config.database.path, "app.sqlite");
        assert.equal(await exists(join(prepared.releaseDirectory, "dist", "server.js")), true);
        assert.deepEqual(columns(prepared.databasePath, "todo"), ["id", "title"]);
      },
    );
    assert.equal(first.protocol, DEPLOYMENT_PROVIDER_DATA_PROTOCOL);
    assert.equal(first.generation, 1);
    assert.equal(first.rollbackAvailable, true);
    assert.match(first.databasePath, /^data\//u);
    assert.match(first.releaseDirectory, /^generations\//u);
    assert.equal((await stat(firstPrepared.databasePath)).mode & 0o077, 0);
    assert.equal(
      (await allFileText(fixture.providerRoot)).includes(
        "provider-secret-must-remain-memory-only",
      ),
      false,
    );

    const repeated = await fixture.store.apply(
      providerInput(firstRuntime, 2),
      async (prepared) => {
        assert.equal(prepared.alreadyCommitted, true);
        assert.equal(prepared.migrationCount, 0);
      },
    );
    assert.equal(repeated.fence, 2);
    assert.equal(repeated.committedAt, first.committedAt);

    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_data_02",
      mode: "preserve",
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n"],
        [
          "0002_done.sql",
          "ALTER TABLE todo ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\n",
        ],
      ],
    });
    const second = await fixture.store.apply(
      providerInput(secondRuntime, 3),
      async (prepared) => {
        assert.equal(prepared.previous.generation, 1);
        assert.equal(prepared.migrationCount, 1);
        assert.deepEqual(columns(prepared.databasePath, "todo"), ["id", "title", "done"]);
      },
    );
    assert.equal(second.generation, 2);
    assert.equal((await fixture.store.inspect("project_data_01")).releaseId, "release_data_02");

    const exported = await fixture.store.snapshot("project_data_01");
    assert.equal(exported.generation, 2);
    assert.equal(exported.databasePath, "app.sqlite");
    assert.equal(exported.sha256, await sha256(exported.bytes));
    assert.match(new TextDecoder().decode(exported.bytes.subarray(0, 16)), /^SQLite format 3/u);

    const providerProject = join(
      fixture.providerRoot,
      "projects",
      "project_data_01",
    );
    const committedState = JSON.parse(
      await readFile(join(providerProject, "state.json"), "utf8"),
    );
    const rollbackSnapshot = join(
      providerProject,
      committedState.rollback.snapshotPath,
    );
    const rollbackBytes = await readFile(rollbackSnapshot);
    await writeFile(rollbackSnapshot, new Uint8Array(rollbackBytes.length), {
      mode: 0o600,
    });
    await assert.rejects(
      fixture.store.rollback({
        projectId: "project_data_01",
        generation: 2,
        confirmation: "rollback project_data_01 2",
      }),
      /not a database|malformed|quick_check|file is encrypted/u,
    );
    assert.equal((await fixture.store.inspect("project_data_01")).generation, 2);
    assert.deepEqual(columns(firstPrepared.databasePath, "todo"), ["id", "title", "done"]);
    await writeFile(rollbackSnapshot, rollbackBytes, { mode: 0o600 });

    const rolledBack = await fixture.store.rollback({
      projectId: "project_data_01",
      generation: 2,
      confirmation: "rollback project_data_01 2",
    });
    assert.equal(rolledBack.generation, 1);
    assert.equal(rolledBack.fence, 3);
    assert.equal(rolledBack.rollbackAvailable, false);
    assert.deepEqual(columns(firstPrepared.databasePath, "todo"), ["id", "title"]);
    await assert.rejects(
      fixture.store.rollback({
        projectId: "project_data_01",
        generation: 1,
        confirmation: "rollback project_data_01 1",
      }),
      /rollback data is unavailable/u,
    );
    await assert.rejects(
      fixture.store.delete({
        projectId: "project_data_01",
        confirmation: "delete another_project",
      }),
      /confirmation must equal/u,
    );
    assert.equal(await fixture.store.delete({
      projectId: "project_data_01",
      confirmation: "delete project_data_01",
    }), true);
    assert.equal(await fixture.store.inspect("project_data_01"), null);
    assert.equal(await fixture.store.delete({
      projectId: "project_data_01",
      confirmation: "delete project_data_01",
    }), false);
  } finally {
    await fixture.close();
  }
});

test("provider data replacement and failed validation are rollback safe", async () => {
  const fixture = await providerFixture("replace");
  try {
    const migrations = [
      ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n"],
    ];
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_replace_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "original"),
      migrations,
    });
    let databasePath;
    await fixture.store.apply(providerInput(firstRuntime, 1), async (prepared) => {
      databasePath = prepared.databasePath;
    });
    assert.equal(seedValue(databasePath), "original");

    const failedRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_replace_02",
      mode: "replace",
      snapshot: await sqliteSnapshot(fixture.root, "replacement"),
      migrations,
    });
    await assert.rejects(
      fixture.store.apply(providerInput(failedRuntime, 2), async (prepared) => {
        assert.equal(seedValue(prepared.databasePath), "replacement");
        await rm(join(
          fixture.providerRoot,
          "projects",
          "project_data_01",
          "journal.json",
        ));
        throw new Error("private-health-check-failure");
      }),
      /private-health-check-failure/u,
    );
    assert.equal((await fixture.store.inspect("project_data_01")).generation, 1);
    assert.equal(seedValue(databasePath), "original");

    const second = await fixture.store.apply(
      providerInput(failedRuntime, 3),
      async (prepared) => {
        assert.equal(seedValue(prepared.databasePath), "replacement");
      },
    );
    assert.equal(second.generation, 2);
    assert.equal(seedValue(databasePath), "replacement");
    await fixture.store.rollback({
      projectId: "project_data_01",
      generation: 2,
      confirmation: "rollback project_data_01 2",
    });
    assert.equal(seedValue(databasePath), "original");
  } finally {
    await fixture.close();
  }
});

test("provider data quiesces an exposed candidate before rollback", async () => {
  const fixture = await providerFixture("discard");
  try {
    const migrations = [
      ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n"],
    ];
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_discard_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "original"),
      migrations,
    });
    let databasePath;
    await fixture.store.apply(providerInput(firstRuntime, 1), async (prepared) => {
      databasePath = prepared.databasePath;
    });
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_discard_02",
      mode: "replace",
      snapshot: await sqliteSnapshot(fixture.root, "replacement"),
      migrations,
    });
    const order = [];
    await assert.rejects(
      fixture.store.apply(
        providerInput(secondRuntime, 2),
        async () => {
          order.push(`validate:${seedValue(databasePath)}`);
          throw new Error("candidate-validation-failed");
        },
        async (_prepared, reason) => {
          order.push(`discard:${seedValue(databasePath)}:${reason.message}`);
        },
      ),
      /candidate-validation-failed/u,
    );
    order.push(`recovered:${seedValue(databasePath)}`);
    assert.deepEqual(order, [
      "validate:replacement",
      "discard:replacement:candidate-validation-failed",
      "recovered:original",
    ]);

    await assert.rejects(
      fixture.store.apply(
        providerInput(secondRuntime, 3),
        async () => {
          throw new Error("candidate-validation-failed-again");
        },
        async () => {
          throw new Error("candidate-cleanup-unproven");
        },
      ),
      /recovery remains journaled/u,
    );
    assert.equal(seedValue(databasePath), "replacement");
    assert.equal(
      await exists(join(
        fixture.providerRoot,
        "projects",
        "project_data_01",
        "journal.json",
      )),
      true,
    );
    assert.equal((await fixture.store.inspect("project_data_01")).generation, 1);
    assert.equal(seedValue(databasePath), "original");
  } finally {
    await fixture.close();
  }
});

test("provider data rejects stale, unbound, aborted, and conflicting requests", async () => {
  const fixture = await providerFixture("bindings");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_bind_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "binding"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    await assert.rejects(
      fixture.store.apply({
        ...providerInput(runtime, 1),
        desired: {
          generation: 2,
          releaseId: "release_bind_01",
          state: "running",
          runtimeProtocol: "clank-runtime/1",
        },
      }, async () => {}),
      /does not match/u,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled-before-provider-data"));
    await assert.rejects(
      fixture.store.apply({
        ...providerInput(runtime, 1),
        signal: controller.signal,
      }, async () => {}),
      /cancelled-before-provider-data/u,
    );
    await fixture.store.apply(providerInput(runtime, 2), async () => {});
    await assert.rejects(
      fixture.store.apply(providerInput(runtime, 1), async () => {}),
      /fence is stale/u,
    );

    const conflict = await fixture.runtime({
      generation: 1,
      releaseId: "release_bind_other",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "other"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    await assert.rejects(
      fixture.store.apply(providerInput(conflict, 3), async () => {}),
      /conflicts with committed state/u,
    );

    const stale = await fixture.runtime({
      generation: 2,
      releaseId: "release_bind_02",
      mode: "preserve",
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    await assert.rejects(
      fixture.store.apply(providerInput(stale, 2), async () => {}),
      /fence is stale/u,
    );
    assert.equal(await fixture.store.rollback({
      projectId: "project_data_01",
      generation: 1,
      confirmation: "rollback project_data_01 1",
    }), null);
    await assert.rejects(
      fixture.store.apply(providerInput(runtime, 2), async () => {}),
      /fence is stale/u,
    );
  } finally {
    await fixture.close();
  }
});

test("provider data recovers an interrupted apply journal before inspection", async () => {
  const fixture = await providerFixture("recovery");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_recovery_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "stable"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    let prepared;
    const state = await fixture.store.apply(providerInput(runtime, 1), async (value) => {
      prepared = value;
    });
    const project = join(fixture.providerRoot, "projects", "project_data_01");
    const transaction =
      "operation_recovery_02-2-11111111-1111-4111-8111-111111111111";
    const recovery = join(project, "recovery", `${transaction}.sqlite`);
    const staging = join(project, ".staging", transaction);
    const release = join(project, "generations", "g2-release_recovery_02");
    await backupSQLite(prepared.databasePath, recovery);
    const database = new DatabaseSync(prepared.databasePath);
    database.exec("CREATE TABLE interrupted_write (id INTEGER)");
    database.close();
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await mkdir(release, { recursive: true, mode: 0o700 });
    const journal = {
      protocol: "clank-provider-data-journal/1",
      kind: "apply",
      operationId: "operation_recovery_02",
      projectId: "project_data_01",
      releaseId: "release_recovery_02",
      generation: 2,
      fence: 2,
      capsuleSha256: "a".repeat(64),
      databasePath: state.databasePath,
      databaseExisted: true,
      safetySnapshotPath: `recovery/${transaction}.sqlite`,
      stagingDirectory: `.staging/${transaction}`,
      releaseDirectory: "generations/g2-release_recovery_02",
      supersededSnapshotPath: null,
      supersededReleaseDirectory: null,
      createdAt: Date.now(),
    };
    await writePrivateJson(join(project, "journal.json"), journal);

    const recovered = await fixture.store.inspect("project_data_01");
    assert.equal(recovered.generation, 1);
    assert.deepEqual(
      tables(prepared.databasePath).includes("interrupted_write"),
      false,
    );
    assert.equal(await exists(recovery), false);
    assert.equal(await exists(staging), false);
    assert.equal(await exists(release), false);
    assert.equal(await exists(join(project, "journal.json")), false);

    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_recovery_02",
      mode: "preserve",
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
        [
          "0002_recovered.sql",
          "ALTER TABLE todo ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;\n",
        ],
      ],
    });
    await fixture.store.apply(providerInput(secondRuntime, 2), async () => {});
    const currentState = JSON.parse(
      await readFile(join(project, "state.json"), "utf8"),
    );
    const rollbackName =
      "rollback-22222222-2222-4222-8222-222222222222.sqlite";
    const currentSnapshot = join(project, "recovery", rollbackName);
    await backupSQLite(prepared.databasePath, currentSnapshot);
    await restoreSQLiteBackup(
      join(project, currentState.rollback.snapshotPath),
      prepared.databasePath,
    );
    assert.deepEqual(columns(prepared.databasePath, "todo"), ["id"]);
    await writePrivateJson(join(project, "journal.json"), {
      protocol: "clank-provider-data-journal/1",
      kind: "rollback",
      operationId: "22222222-2222-4222-8222-222222222222",
      projectId: "project_data_01",
      generation: 2,
      targetGeneration: 1,
      databasePath: currentState.active.databasePath,
      currentSnapshotPath: `recovery/${rollbackName}`,
      activeReleaseDirectory: currentState.active.releaseDirectory,
      targetDatabaseExisted: true,
      targetSnapshotPath: currentState.rollback.snapshotPath,
      createdAt: Date.now(),
    });
    const rollbackRecovered = await fixture.store.inspect("project_data_01");
    assert.equal(rollbackRecovered.generation, 2);
    assert.deepEqual(columns(prepared.databasePath, "todo"), ["id", "recovered"]);
    assert.equal(await exists(currentSnapshot), false);
    assert.equal(await exists(join(project, "journal.json")), false);
  } finally {
    await fixture.close();
  }
});

test("provider data fails closed on storage links and out-of-scope metadata", async () => {
  const fixture = await providerFixture("storage");
  try {
    const outside = join(fixture.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(
      outside,
      join(fixture.providerRoot, "projects", "linked_project"),
      "dir",
    );
    await assert.rejects(
      fixture.store.inspect("linked_project"),
      /symbolic links are not allowed/u,
    );

    const projectRoot = join(
      fixture.providerRoot,
      "projects",
      "project_data_01",
    );
    for (const directory of [
      projectRoot,
      join(projectRoot, "data"),
      join(projectRoot, "generations"),
      join(projectRoot, "recovery"),
      join(projectRoot, ".staging"),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    await symlink(outside, join(projectRoot, "data", "nested"), "dir");
    const nestedRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_nested_01",
      mode: "initialize",
      databasePath: "nested/app.sqlite",
      snapshot: await sqliteSnapshot(fixture.root, "nested"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    await assert.rejects(
      fixture.store.apply(providerInput(nestedRuntime, 1), async () => {}),
      /storage paths must be real directories/u,
    );
    await rm(join(projectRoot, "data", "nested"));

    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_scope_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "scope"),
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ],
    });
    const orphanDatabase = join(projectRoot, "data", "app.sqlite");
    await writeFile(orphanDatabase, runtime.databaseSnapshot, { mode: 0o600 });
    await assert.rejects(
      fixture.store.apply(providerInput(runtime, 1), async () => {}),
      /exists without a committed generation/u,
    );
    await rm(orphanDatabase);
    let databasePath;
    await fixture.store.apply(providerInput(runtime, 1), async (prepared) => {
      databasePath = prepared.databasePath;
    });
    const stateBeforeCorruption = JSON.parse(
      await readFile(join(
        fixture.providerRoot,
        "projects",
        "project_data_01",
        "state.json",
      ), "utf8"),
    );
    const serverPath = join(
      fixture.providerRoot,
      "projects",
      "project_data_01",
      stateBeforeCorruption.active.releaseDirectory,
      "dist",
      "server.js",
    );
    await writeFile(serverPath, "export const generation = 'tampered';\n");
    await assert.rejects(
      fixture.store.apply(providerInput(runtime, 2), async () => {}),
      /release contents do not match/u,
    );
    await writeFile(serverPath, "export const generation = 1;\n");
    await chmod(databasePath, 0o644);
    await assert.rejects(
      fixture.store.snapshot("project_data_01"),
      /permissions are unsafe|not a regular file/u,
    );
    await chmod(databasePath, 0o600);
    await writeFile(`${databasePath}-wal`, "unsafe-sidecar", { mode: 0o644 });
    await assert.rejects(
      fixture.store.snapshot("project_data_01"),
      /sidecar is unsafe/u,
    );
    await rm(`${databasePath}-wal`);
    const statePath = join(
      fixture.providerRoot,
      "projects",
      "project_data_01",
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.active.databasePath = "recovery/not-a-database.sqlite";
    await writePrivateJson(statePath, state);
    await assert.rejects(
      fixture.store.inspect("project_data_01"),
      /outside its provider storage scope/u,
    );
  } finally {
    await fixture.close();
  }
});

async function providerFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `clank-provider-data-${name}-`));
  const providerRoot = join(root, "provider");
  const store = await openDeploymentProviderDataStore({
    rootDirectory: providerRoot,
    maxDatabaseBytes: 16 * 1024 * 1024,
  });
  return {
    root,
    providerRoot,
    store,
    async runtime(options) {
      const source = join(root, `source-${options.generation}-${options.releaseId}`);
      await mkdir(join(source, "dist"), { recursive: true });
      await mkdir(join(source, "migrations"), { recursive: true });
      await writeFile(
        join(source, "dist", "server.js"),
        `export const generation = ${options.generation};\n`,
      );
      for (const [filename, sql] of options.migrations) {
        await writeFile(join(source, "migrations", filename), sql);
      }
      const artifact = await createDeploymentBundle(source, {
        version: 1,
        entry: "dist/server.js",
        include: ["dist", "migrations"],
        database: {
          path: options.databasePath ?? "app.sqlite",
          migrations: "migrations",
          allowUnsafeMigrations: false,
        },
        health: { path: "/healthz", timeoutMs: 15_000 },
        env: {},
      }, {
        frameworkVersion: "0.9.4-test",
        nodeVersion: "22.16.0",
      });
      return createDeploymentRuntimeCapsule({
        projectId: "project_data_01",
        releaseId: options.releaseId,
        generation: options.generation,
        environment: options.environment ?? {
          CLANK_MANAGED_INGRESS: "1",
        },
        database: {
          path: options.databasePath ?? "app.sqlite",
          mode: options.mode,
          snapshot: options.snapshot,
        },
        ingress: {
          route: "/v1/clank/apps/project_data_01",
          token: "clanki_provider-data-ingress-token-12345678901234567890",
        },
        artifact,
      }, {
        maxDatabaseBytes: 16 * 1024 * 1024,
      });
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
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
    runtime,
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

function seedValue(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM seed").get().value;
  } finally {
    database.close();
  }
}

function columns(filename, table) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  } finally {
    database.close();
  }
}

function tables(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name);
  } finally {
    database.close();
  }
}

async function allFileText(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) output.push(await allFileText(filename));
    else if (entry.isFile()) output.push(await readFile(filename, "utf8"));
  }
  return output.join("\n");
}

async function writePrivateJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(filename, 0o600);
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}
