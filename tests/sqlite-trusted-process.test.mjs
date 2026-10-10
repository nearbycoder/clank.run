import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createSQLiteTaskScope, runSQLiteTask } from "../dist/sqlite-task.js";
import { applyMigrations, planMigrations, backupSQLite, restoreSQLiteBackup } from "../dist/migrations.js";

const linux = { skip: process.platform !== "linux" };

test("trusted SQLite processes retain limits and do not change concurrent or standalone namespace policy", linux, async t => {
  const scope = await createSQLiteTaskScope("trusted-process");
  const isolated = await createSQLiteTaskScope("namespace");
  const spawn = childProcess.spawn;
  let namespaced = 0, trusted = 0;
  t.mock.method(childProcess, "spawn", (executable, args, options) => {
    if (args.includes("/usr/bin/bwrap")) {
      namespaced++;
      throw new Error("test host denies namespaces");
    }
    trusted++;
    assert.equal(executable, "/usr/bin/setpriv");
    for (const flag of ["--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "/usr/bin/prlimit",
      "--data=268435456:268435456", "--as=1073741824:1073741824", "--cpu=10:10", "--core=0:0"]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.CLANK_PLATFORM_MASTER_KEY, undefined);
    return spawn(executable, args, options);
  });
  syncBuiltinESMExports();
  try {
    const work = () => planMigrations(":memory:", []);
    await Promise.all([
      scope.run(async () => {
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual((await work()).pending, []);
        await assert.rejects(isolated.run(work), /test host denies namespaces/);
        assert.deepEqual((await work()).pending, []);
      }),
      assert.rejects(work(), /test host denies namespaces/),
    ]);
    await assert.rejects(work(), /test host denies namespaces/);
    assert.equal(namespaced, 3);
    assert.equal(trusted, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("trusted SQLite migrations, backups, and restores use bounded workers without parent preloads", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-trusted-sqlite-"));
  const scope = await createSQLiteTaskScope("trusted-process");
  const directory = join(root, "migrations"), path = join(root, "app.sqlite"), backup = join(root, "backup.sqlite");
  const previous = process.env.NODE_OPTIONS;
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_init.sql"), "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('saved');");
    process.env.NODE_OPTIONS = "--require=/nonexistent-clank-trusted-preload.cjs";
    await scope.run(async () => {
      assert.equal((await applyMigrations({ path, directory })).applied.length, 1);
      await backupSQLite(path, backup);
      const db = new DatabaseSync(path); db.exec("DELETE FROM records"); db.close();
      await restoreSQLiteBackup(backup, path);
      const restored = new DatabaseSync(path);
      try { assert.equal(restored.prepare("SELECT value FROM records").get().value, "saved"); }
      finally { restored.close(); }
      assert.deepEqual(await runSQLiteTask("inspection", "inspectSQLite", [path]), {
        revision: null, migrationCount: 1, latestMigration: "0001",
      });
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted SQLite workers enforce native memory and execution bounds before rollback", { ...linux, timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-trusted-sqlite-limits-"));
  const scope = await createSQLiteTaskScope("trusted-process");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 25);
  try {
    await scope.run(async () => {
      for (const [name, sql, expected] of [
        ["memory", "INSERT INTO pending VALUES(randomblob(268435456));", /memory|resource limit/iu],
        ["timeout", "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n;", /deadline|resource limit/u],
      ]) {
        const directory = join(root, name); await mkdir(directory);
        const path = join(directory, "app.sqlite");
        await writeFile(join(directory, "0001_limits.sql"), `CREATE TABLE pending(value BLOB); ${sql}`);
        await assert.rejects(applyMigrations({ path, directory }), expected);
        const db = new DatabaseSync(path);
        try {
          assert.equal(db.prepare("SELECT count(*) AS n FROM clank_migrations").get().n, 0);
          assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='pending'").get().n, 0);
        } finally { db.close(); }
      }
    });
    assert.ok(ticks >= 5, "the parent event loop stayed responsive");
  } finally { clearInterval(timer); await rm(root, { recursive: true, force: true }); }
});
