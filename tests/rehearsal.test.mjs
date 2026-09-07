import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { rehearseRecovery, rehearseMigrations, openBackupManager } from "../dist/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clank-rehearsal-test-"));
  const databasePath = join(root, "source.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO items VALUES (1, 'private-value-one'), (2, 'private-value-two')");
  db.close();
  const directory = join(root, "migrations");
  await mkdir(directory);
  return { root, databasePath, directory };
}

test("restore rehearsal verifies an encrypted backup through a loopback app and removes its disposable data", async () => {
  const { root, databasePath } = await fixture();
  const original = await readFile(databasePath);
  const manager = await openBackupManager({ databasePath, repositoryDirectory: join(root, "backups"),
    encryptionKey: "a sufficiently long rehearsal backup encryption key" });
  let temporary;
  let closed = false;
  try {
    const backup = await manager.create();
    const report = await rehearseRecovery({ source: { manager, backupId: backup.id },
      boot({ databasePath: restored }) {
        temporary = restored;
        assert.notEqual(restored, databasePath);
        const db = new DatabaseSync(restored);
        return { handle(request) {
          assert.equal(new URL(request.url).hostname, "127.0.0.1");
          return new Response(JSON.stringify({ count: db.prepare("SELECT count(*) AS n FROM items").get().n }));
        }, close() { closed = true; db.close(); } };
      }, checks: [{ name: "restored records", path: "/healthz", status: 200, includes: '"count":2' }],
    });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.checks[0].ok, true);
    assert.ok(report.timings.restoreMs >= 0 && report.timings.bootMs >= 0);
    assert.ok(report.restoredBytes > 0);
    assert.equal(closed, true);
    await assert.rejects(stat(dirname(temporary)), { code: "ENOENT" });
    assert.deepEqual(await readFile(databasePath), original);
    assert.doesNotMatch(JSON.stringify(report), /private-value|encryption key/);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("migration rehearsal reports schema and data changes without modifying source rows or migration history", async () => {
  const { root, databasePath, directory } = await fixture();
  const original = await readFile(databasePath);
  try {
    await writeFile(join(directory, "0001_change.sql"), "ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0; DELETE FROM items WHERE id = 2;");
    const report = await rehearseMigrations({ source: { databasePath }, migrations: { directory } });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.appliedMigrations, ["0001"]);
    assert.deepEqual(report.changes.find(change => change.table === "items"), {
      table: "items", beforeRows: 2, afterRows: 1, schemaChanged: true, dataChanged: true,
    });
    assert.deepEqual(await readFile(databasePath), original);
    assert.doesNotMatch(JSON.stringify(report), /private-value/);
    await writeFile(join(directory, "0002_invalid.sql"), "INSERT INTO missing_table VALUES ('private failure');");
    const failed = await rehearseMigrations({ source: { databasePath }, migrations: { directory } });
    assert.equal(failed.ok, false);
    assert.equal(failed.failurePhase, "migrations");
    assert.doesNotMatch(JSON.stringify(failed), /private failure|missing_table/);
    assert.deepEqual(await readFile(databasePath), original);
    await writeFile(join(directory, "0002_invalid.sql"), `ATTACH DATABASE '${databasePath}' AS outside; DELETE FROM outside.items;`);
    const escaped = await rehearseMigrations({ source: { databasePath }, migrations: { directory, allowUnsafe: true } });
    assert.equal(escaped.ok, false, "even explicitly unsafe migrations cannot attach the original database");
    assert.deepEqual(await readFile(databasePath), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rehearsals fail health checks and deadlines, clean up late boot, and reject escaping check URLs", async (context) => {
  const { root, databasePath } = await fixture();
  let closed = 0;
  const boot = () => ({ handle: () => new Response("unhealthy", { status: 500 }), close() { closed++; } });
  try {
    const failed = await rehearseRecovery({ source: { databasePath }, boot });
    assert.equal(failed.failurePhase, "checks");
    assert.equal(closed, 1);
    // Advance the deadline only after boot starts: shared CI load must not make
    // the real SQLite restore accidentally consume this test's boot budget.
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let releaseBoot, startedBoot, finishClose;
    const bootStarted = new Promise(resolve => { startedBoot = resolve; });
    const lateClosed = new Promise(resolve => { finishClose = resolve; });
    const pendingBoot = new Promise(resolve => { releaseBoot = resolve; });
    const rehearsal = rehearseRecovery({ source: { databasePath }, timeoutMs: 100,
      boot() { startedBoot(); return pendingBoot; } });
    await bootStarted;
    context.mock.timers.tick(101);
    const timeout = await rehearsal;
    assert.equal(timeout.ok, false);
    assert.equal(timeout.failurePhase, "boot");
    releaseBoot({ ...boot(), close() { closed++; finishClose(); } });
    await lateClosed;
    context.mock.timers.reset();
    assert.equal(closed, 2);
    await assert.rejects(rehearseRecovery({ source: { databasePath }, boot, checks: [{ name: "escape", path: "//outside.test" }] }), /Invalid rehearsal checks/);
    const escaped = await rehearseRecovery({ source: { databasePath }, boot, checks: [{ name: "escape", path: "/\\outside.test" }] });
    assert.equal(escaped.failurePhase, "checks");
    assert.equal(closed, 3);
    await assert.rejects(rehearseRecovery({ source: { databasePath } }), /boot factory/);
    await assert.rejects(rehearseMigrations({ source: { databasePath } }), /directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
