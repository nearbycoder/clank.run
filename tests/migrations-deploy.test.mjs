import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import {
  applyMigrations,
  assertSafeMigrationSql,
  backupSQLite,
  createDeploymentBundle,
  decodeDeploymentBundle,
  deploymentDigest,
  loadMigrations,
  parseDeploymentConfig,
  planMigrations,
  restoreSQLiteBackup,
} from "../dist/index.js";

const config = parseDeploymentConfig({
  version: 1,
  entry: "dist/server.js",
  include: ["dist", "migrations"],
  database: { path: "app.sqlite", migrations: "migrations", allowUnsafeMigrations: false },
  health: { path: "/healthz", timeoutMs: 5_000 },
  env: { FEATURE: "on" },
});

test("deployment bundles are deterministic, checksummed, bounded, and traversal-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-bundle-"));
  try {
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "migrations"));
    await writeFile(join(root, "dist", "server.js"), "console.log('safe');\n");
    await writeFile(join(root, "migrations", "0001_init.sql"), "CREATE TABLE example (id TEXT PRIMARY KEY);\n");
    const first = await createDeploymentBundle(root, config, {
      frameworkVersion: "0.5.0",
      nodeVersion: "v22.22.2",
    });
    const second = await createDeploymentBundle(root, config, {
      frameworkVersion: "0.5.0",
      nodeVersion: "v22.22.2",
    });
    assert.deepEqual(first, second);
    assert.equal(await deploymentDigest(first), await deploymentDigest(second));
    const decoded = await decodeDeploymentBundle(first);
    assert.equal(decoded.config.entry, "dist/server.js");
    assert.deepEqual(decoded.files.map((file) => file.path), [
      "dist/server.js",
      "migrations/0001_init.sql",
    ]);

    const raw = JSON.parse(new TextDecoder().decode(
      await import("node:zlib").then(({ gunzipSync }) => gunzipSync(first)),
    ));
    raw.files[0].path = "../escape.js";
    const malicious = gzipSync(JSON.stringify(raw));
    await assert.rejects(() => decodeDeploymentBundle(malicious), /parent segments|safe relative POSIX path/);

    const legacyRaw = JSON.parse(new TextDecoder().decode(
      await import("node:zlib").then(({ gunzipSync }) => gunzipSync(first)),
    ));
    legacyRaw.protocol = "proact-deploy/1";
    legacyRaw.provenance.builder = "proact-cli/1";
    const upgraded = await decodeDeploymentBundle(gzipSync(JSON.stringify(legacyRaw)));
    assert.equal(upgraded.protocol, "clank-deploy/1");
    assert.equal(upgraded.provenance.builder, "clank-cli/1");

    await writeFile(join(root, ".env"), "TOKEN=do-not-package\n");
    const unsafe = parseDeploymentConfig({
      ...config,
      include: ["dist", "migrations", ".env"],
    });
    await assert.rejects(() => createDeploymentBundle(root, unsafe), /Sensitive path/);
    assert.throws(() => parseDeploymentConfig({
      version: 1,
      entry: "dist/server.js",
      include: ["dist"],
      database: { path: "app.sqlite", migrations: "migrations" },
    }), /database\.migrations must be contained/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration planning upgrades the legacy Proact ledger without replaying history", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-legacy-ledger-"));
  const directory = join(root, "migrations");
  const databasePath = join(root, "app.sqlite");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_existing.sql"), "CREATE TABLE existing (id INTEGER PRIMARY KEY);\n");
    const [migration] = await loadMigrations(directory);
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE proact_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    database.prepare(
      "INSERT INTO proact_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(migration.id, migration.name, migration.checksum, Date.now());
    database.close();

    const plan = await planMigrations(databasePath, [migration]);
    assert.equal(plan.applied.length, 1);
    assert.equal(plan.pending.length, 0);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      migrated.prepare("SELECT count(*) AS count FROM clank_migrations").get().count,
      1,
    );
    assert.throws(() => migrated.prepare("SELECT * FROM proact_migrations").all(), /no such table/);
    migrated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite migrations are immutable, transactional, backed up, and reject database-control SQL", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-migrate-"));
  const directory = join(root, "migrations");
  const databasePath = join(root, "app.sqlite");
  const backupPath = join(root, "backup.sqlite");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_create_notes.sql"), `
      CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO notes (body) VALUES ('before');
    `);
    const result = await applyMigrations({ path: databasePath, directory });
    assert.equal(result.pending.length, 1);
    const migrations = await loadMigrations(directory);
    const plan = await planMigrations(databasePath, migrations);
    assert.equal(plan.applied.length, 1);
    assert.equal(plan.pending.length, 0);

    await backupSQLite(databasePath, backupPath);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO notes (body) VALUES (?)").run("after");
    database.close();
    await restoreSQLiteBackup(backupPath, databasePath);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      restored.prepare("SELECT body FROM notes ORDER BY id").all().map((row) => row.body),
      ["before"],
    );
    restored.close();

    await writeFile(join(directory, "0001_create_notes.sql"), "CREATE TABLE changed (id INTEGER);\n");
    await assert.rejects(
      () => applyMigrations({ path: databasePath, directory }),
      /missing or was modified/,
    );
    assert.throws(
      () => assertSafeMigrationSql("ATTACH DATABASE '/tmp/escape' AS stolen;", "0002"),
      /forbidden/,
    );
    assert.throws(
      () => assertSafeMigrationSql("PRAGMA writable_schema = 1;", "0002"),
      /PRAGMA/,
    );
    assert.throws(
      () => assertSafeMigrationSql('DROP TABLE "clank_meta";', "0002"),
      /reserved Clank table/,
    );
    assert.throws(
      () => assertSafeMigrationSql("DELETE FROM [clank_auth_sessions];", "0002"),
      /reserved Clank table/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration and restore paths reject symlinks and corrupt databases without replacing good data", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-migrate-integrity-"));
  const directory = join(root, "migrations");
  const databasePath = join(root, "app.sqlite");
  const corruptPath = join(root, "corrupt.sqlite");
  const symlinkPath = join(root, "linked.sqlite");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_init.sql"), "CREATE TABLE durable (value TEXT NOT NULL);\nINSERT INTO durable VALUES ('good');\n");
    await applyMigrations({ path: databasePath, directory });
    await writeFile(corruptPath, "this is not a SQLite database");
    await assert.rejects(
      () => restoreSQLiteBackup(corruptPath, databasePath),
      /database|SQLite|file is not a database/i,
    );
    const intact = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(intact.prepare("SELECT value FROM durable").get().value, "good");
    intact.close();

    await symlink(databasePath, symlinkPath);
    const migrations = await loadMigrations(directory);
    await assert.rejects(
      () => planMigrations(symlinkPath, migrations),
      /symbolic link/,
    );
    await assert.rejects(
      () => backupSQLite(symlinkPath, join(root, "backup.sqlite")),
      /symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
