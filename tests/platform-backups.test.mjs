import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openPlatform } from "../dist/index.js";
import { createPlatformBackupScheduler } from "../dist/platform-backups.js";

function jsonRequest(path, { method = "GET", body, token } = {}) {
  return new Request(`http://127.0.0.1:4200${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4200",
      }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    body: { clientName: "backup test CLI" },
  }), 201);
  await payload(platform, new Request("http://127.0.0.1:4200/api/device/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:4200",
      "x-clank-csrf": session.csrfToken,
      "x-clank-client-ip": "127.0.0.1",
    },
    body: JSON.stringify({ code: started.userCode }),
  }));
  const token = await payload(platform, jsonRequest("/api/device/token", {
    method: "POST",
    body: { deviceCode: started.deviceCode },
  }));
  return token.accessToken;
}

async function seedDatabaseProject(root, email) {
  const dataDirectory = join(root, "platform");
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const accessToken = await authorizeCli(platform, email);
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { token: accessToken }));
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: accessToken,
      body: {
        name: "Backup Test",
        slug: `backup-${crypto.randomUUID().slice(0, 8)}`,
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const projectId = created.project.id;
    const databaseDirectory = join(dataDirectory, "projects", projectId, "data");
    const databasePath = join(databaseDirectory, "app.sqlite");
    await mkdir(databaseDirectory, { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
    database.prepare("INSERT INTO todos (title) VALUES (?)").run("private backup plaintext");
    database.close();
    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare(
      "UPDATE clank_platform_projects SET database_path = ?, updated_at = ? WHERE id = ?",
    ).run("app.sqlite", Date.now(), projectId);
    control.close();
    return { accessToken, dataDirectory, projectId };
  } finally {
    await platform.close();
  }
}

test("scheduled platform backups are encrypted, private, observable, and retention bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-scheduled-backup-"));
  const seed = await seedDatabaseProject(root, "scheduled-backup@example.com");
  const platform = await openPlatform({
    dataDirectory: seed.dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: {
      intervalMs: 60_000,
      batchSize: 1,
      maxBackups: 2,
      maxAgeMs: 60_000,
    },
  });
  try {
    const scheduled = await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${seed.projectId}/backups`,
        { token: seed.accessToken },
      ));
      return result.backups.length === 1 ? result : undefined;
    });
    assert.equal(scheduled.backups[0].reason, "automatic scheduled backup");
    assert.equal("source" in scheduled.backups[0], false, "host database paths must remain private");
    assert.equal(scheduled.automation.enabled, true);
    assert.equal(scheduled.automation.lastBackupId, scheduled.backups[0].id);
    assert.equal(scheduled.automation.lastError, null);
    assert.ok(scheduled.automation.nextBackupAt > Date.now());

    const envelope = await readFile(join(
      seed.dataDirectory,
      "projects",
      seed.projectId,
      "recovery",
      scheduled.backups[0].id,
      "database.enc",
    ));
    assert.equal(envelope.includes(Buffer.from("private backup plaintext")), false);

    for (const reason of ["manual one", "manual two", "manual three"]) {
      const created = await payload(platform, jsonRequest(
        `/api/projects/${seed.projectId}/backups`,
        { method: "POST", token: seed.accessToken, body: { reason } },
      ), 201);
      assert.equal("source" in created.backup, false);
    }
    const retained = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/backups`,
      { token: seed.accessToken },
    ));
    assert.equal(retained.backups.length, 2);
    assert.deepEqual(
      new Set(retained.backups.map((backup) => backup.reason)),
      new Set(["manual two", "manual three"]),
    );
    assert.equal(retained.automation.lastBackupId, retained.backups[0].id);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled backup failures are reported privately and retried without exposing internals", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-backup-failure-"));
  const seed = await seedDatabaseProject(root, "backup-failure@example.com");
  const observed = [];
  const platform = await openPlatform({
    dataDirectory: seed.dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: {
      intervalMs: 60_000,
      maxDatabaseBytes: 1,
    },
    onError(error) {
      observed.push(error);
    },
  });
  try {
    const failed = await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${seed.projectId}/backups`,
        { token: seed.accessToken },
      ));
      return result.automation.lastError ? result : undefined;
    });
    assert.equal(failed.backups.length, 0);
    assert.equal(
      failed.automation.lastError,
      "Scheduled backup failed. See private operator logs.",
    );
    assert.ok(failed.automation.nextBackupAt > Date.now());
    assert.equal(observed.length, 1);
    assert.match(observed[0].message, /Database exceeds backup limit of 1 bytes/u);
    assert.doesNotMatch(JSON.stringify(failed), /1 bytes|app\.sqlite|clank-platform-backup-failure/u);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable backup claims prevent duplicate work and graceful close drains an active backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-backup-scheduler-"));
  const databasePath = join(root, "control.sqlite");
  const setup = new DatabaseSync(databasePath);
  setup.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE clank_platform_projects (
      id TEXT PRIMARY KEY,
      database_path TEXT
    );
    INSERT INTO clank_platform_projects (id, database_path) VALUES ('project_1', 'app.sqlite');
  `);
  setup.close();
  const firstDatabase = new DatabaseSync(databasePath);
  const secondDatabase = new DatabaseSync(databasePath);
  const policy = {
    enabled: true,
    intervalMs: 60_000,
    batchSize: 1,
    concurrency: 1,
    maxBackups: 30,
    maxAgeMs: 90 * 24 * 60 * 60_000,
    maxDatabaseBytes: 1024,
  };
  let calls = 0;
  let releaseBackup;
  const backupGate = new Promise((resolve) => { releaseBackup = resolve; });
  const createBackup = async () => {
    calls++;
    await backupGate;
    return {
      protocol: "clank-backup/1",
      id: "bk_0000000000000_scheduler_test",
      source: "/private/app.sqlite",
      createdAt: Date.now(),
      reason: "automatic scheduled backup",
      databaseBytes: 512,
      databaseSha256: "0".repeat(64),
      databaseRevision: 1,
      migrationCount: 1,
      latestMigration: "0001",
      encryption: { algorithm: "AES-256-GCM", keyId: "test" },
    };
  };
  const first = createPlatformBackupScheduler({
    internal: sqliteInternal(firstDatabase),
    policy,
    createBackup,
  });
  const second = createPlatformBackupScheduler({
    internal: sqliteInternal(secondDatabase),
    policy,
    createBackup,
  });
  try {
    first.start();
    second.start();
    await waitFor(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 1, "only one control plane may claim a due project");

    let closed = false;
    const closing = Promise.all([first.close(), second.close()]).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, false, "close must wait for the active encrypted backup");
    releaseBackup();
    await closing;
    const row = firstDatabase.prepare(
      "SELECT lease_token, lease_until, last_backup_id, last_error FROM clank_platform_backup_schedules",
    ).get();
    assert.equal(row.lease_token, null);
    assert.equal(row.lease_until, null);
    assert.equal(row.last_backup_id, "bk_0000000000000_scheduler_test");
    assert.equal(row.last_error, null);
  } finally {
    releaseBackup();
    await first.close();
    await second.close();
    firstDatabase.close();
    secondDatabase.close();
    await rm(root, { recursive: true, force: true });
  }
});

function sqliteInternal(database) {
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
    transaction(handler) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = handler({ record() {} });
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for condition.");
}
