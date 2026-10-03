import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  applyMigrations, assertSafeMigrationSql, backupSQLite, defineDatabase, defineJobs,
  defineTable, openJobs, openSQLite, planMigrations, s,
} from "../dist/index.js";
import { mutatePlatformJob } from "../dist/platform-jobs.js";

const endlessQuery = "WITH RECURSIVE counter(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM counter) SELECT sum(x) FROM counter;";

test("tenant migrations and job triggers cannot block the control process and are killed before recovery", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-sqlite-isolation-"));
  const migrations = join(root, "migrations");
  const databasePath = join(root, "migration.sqlite");
  const jobsPath = join(root, "jobs.sqlite");
  await mkdir(migrations);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 25);
  try {
    // Both inputs are valid SQL. The former keyword guard alone accepts the
    // migration; a trigger makes an ordinary authorized job cancellation costly.
    assert.doesNotThrow(() => assertSafeMigrationSql(endlessQuery));
    await writeFile(join(migrations, "0001_bounded.sql"), `CREATE TABLE pending(value TEXT); ${endlessQuery}`);
    const schema = defineDatabase({ records: defineTable({ value: s.string() }) });
    const definition = defineJobs({ schema }).jobs(({ job }) => ({ ping: job({ args: {}, handler: () => null }) }));
    const database = await openSQLite(schema, { path: jobsPath, changePollIntervalMs: 0 });
    const jobs = openJobs(definition, { database });
    const queued = jobs.enqueue(definition.jobs.ping, {});
    jobs.close();
    database.close();
    const native = new DatabaseSync(jobsPath);
    native.exec(`CREATE TRIGGER slow_cancel AFTER UPDATE ON clank_jobs BEGIN ${endlessQuery} END;`);
    native.close();

    const before = ticks;
    await Promise.all([
      assert.rejects(applyMigrations({ path: databasePath, directory: migrations }), /deadline|resource limit/u),
      assert.rejects(mutatePlatformJob({ databasePath: jobsPath, id: queued.id, action: "cancel" }), /deadline|resource limit/u),
    ]);
    assert.ok(ticks - before >= 5, "the shared event loop kept servicing timers during tenant SQLite work");

    const recovered = new DatabaseSync(databasePath);
    assert.equal(recovered.prepare("SELECT count(*) AS n FROM clank_migrations").get().n, 0);
    assert.equal(recovered.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'pending'").get().n, 0);
    recovered.close();
    const recoveredJobs = new DatabaseSync(jobsPath);
    assert.equal(recoveredJobs.prepare("SELECT state FROM clank_jobs WHERE id = ?").get(queued.id).state, "queued");
    recoveredJobs.exec("DROP TRIGGER slow_cancel");
    recoveredJobs.close();
    const result = await mutatePlatformJob({ databasePath: jobsPath, id: queued.id, action: "cancel" });
    assert.equal(result.changed, true);
    assert.equal(result.job.state, "cancelled");
    await writeFile(join(migrations, "0001_bounded.sql"), "CREATE TABLE recovered(value TEXT);");
    assert.equal((await applyMigrations({ path: databasePath, directory: migrations })).applied.length, 1);
  } finally {
    clearInterval(timer);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux tenant SQLite native allocations have a kernel bound and do not exhaust the parent", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-sqlite-memory-"));
  const migrations = join(root, "migrations");
  const databasePath = join(root, "app.sqlite");
  try {
    await mkdir(migrations);
    await writeFile(join(migrations, "0001_large.sql"), "CREATE TABLE payloads(value BLOB); INSERT INTO payloads VALUES(randomblob(268435456));");
    await assert.rejects(applyMigrations({ path: databasePath, directory: migrations }), /memory|resource limit/iu);
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(database.prepare("SELECT count(*) AS n FROM clank_migrations").get().n, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'payloads'").get().n, 0);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite workers do not inherit parent preload options", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-sqlite-environment-"));
  const previous = process.env.NODE_OPTIONS;
  try {
    const directory = join(root, "migrations");
    await mkdir(directory);
    await writeFile(join(directory, "0001_safe.sql"), "CREATE TABLE safe(value TEXT);");
    process.env.NODE_OPTIONS = "--require=/nonexistent-clank-test-preload.cjs";
    const result = await applyMigrations({ path: join(root, "app.sqlite"), directory });
    assert.equal(result.applied.length, 1);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite task pipes preserve Unicode across multi-chunk requests", async () => {
  const migrations = [{ id: "0001", name: "unicode", checksum: "a".repeat(64),
    sql: `-- ${"漢🙂".repeat(100_000)}\nCREATE TABLE unicode(value TEXT);` }];
  const result = await planMigrations(":memory:", migrations);
  assert.deepEqual(result.pending, migrations);
});

test("oversized migration results are rejected before pending SQL or ledger rows commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-sqlite-response-bound-"));
  const directory = join(root, "migrations");
  const path = join(root, "app.sqlite");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_initial.sql"), "CREATE TABLE state(value INTEGER); INSERT INTO state VALUES(0);");
    await applyMigrations({ path, directory });
    // JSON escapes these comment bytes to six characters each. Three files
    // exceed the 16 MiB response limit without first exhausting native memory,
    // so this specifically exercises the precommit response-size guard.
    const sql = `-- ${"\u0001".repeat(1024 * 1024 - 100)}\nUPDATE state SET value = value + 1;`;
    for (let index = 2; index <= 4; index++) {
      await writeFile(join(directory, `${String(index).padStart(4, "0")}_large.sql`), sql);
    }
    await assert.rejects(applyMigrations({ path, directory }), /response exceeds its limit/u);
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("SELECT value FROM state").get().value, 0);
      assert.deepEqual(database.prepare("SELECT id FROM clank_migrations").all().map((row) => row.id), ["0001"]);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("killed backup workers clean their private staging and never publish destination sidecars", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "clank-sqlite-cleanup-"));
  const source = join(root, "source.sqlite");
  const destination = join(root, "destination.sqlite");
  const database = new DatabaseSync(source);
  database.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('source'); BEGIN EXCLUSIVE");
  const original = new DatabaseSync(destination);
  original.exec("CREATE TABLE destination(value TEXT); INSERT INTO destination VALUES('keep');");
  original.close();
  const bytes = await readFile(destination);
  await writeFile(`${destination}-wal`, "existing-wal-canary");
  await writeFile(`${destination}-shm`, "existing-shm-canary");
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  // Inject expiry only once a real worker has created its private staging file.
  // The source lock keeps it inside SQLite until the parent's real kill path runs.
  context.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 10_000) expire = callback;
    return nativeSetTimeout(callback, delay, ...args);
  });
  let observedStaging = false;
  const watcher = setInterval(async () => {
    if (!expire) return;
    if ((await readdir(root)).some((name) => name.startsWith("destination.sqlite.tmp-"))) {
      observedStaging = true;
      const callback = expire;
      expire = undefined;
      callback();
    }
  }, 10);
  try {
    await assert.rejects(backupSQLite(source, destination), /deadline/u);
    assert.equal(observedStaging, true);
    assert.equal((await readdir(root)).some((name) => name.startsWith("destination.sqlite.tmp-")), false);
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(await readFile(`${destination}-wal`, "utf8"), "existing-wal-canary");
    assert.equal(await readFile(`${destination}-shm`, "utf8"), "existing-shm-canary");
  } finally {
    clearInterval(watcher);
    context.mock.restoreAll();
    database.exec("ROLLBACK");
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
