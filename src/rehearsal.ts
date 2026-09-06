import { backupSQLite, applyMigrations } from "./migrations.ts";
import { serve } from "./node.ts";
import { readResponseBytes } from "./security.ts";
import type { BackupManager } from "./recovery.ts";
import type { FetchApplication } from "./node.ts";

export type RehearsalSource = { databasePath: string } | { manager: Pick<BackupManager, "read">; backupId: string };
export interface RehearsalApplication extends FetchApplication { close(): void | Promise<void>; }
export interface RehearsalOptions {
  source: RehearsalSource;
  migrations?: { directory: string; allowUnsafe?: boolean };
  boot?: (context: { databasePath: string; signal: AbortSignal }) => RehearsalApplication | Promise<RehearsalApplication>;
  checks?: readonly { name: string; path: string; status?: number; includes?: string }[];
  timeoutMs?: number;
  maxDatabaseBytes?: number;
  onError?: (error: unknown) => void;
}
export interface RehearsalTableChange {
  readonly table: string;
  readonly beforeRows: number | null;
  readonly afterRows: number | null;
  readonly schemaChanged: boolean;
  readonly dataChanged: boolean;
}
export interface RehearsalReport {
  readonly protocol: "clank-rehearsal/1";
  readonly kind: "restore" | "migration";
  readonly ok: boolean;
  readonly failurePhase: string | null;
  readonly restoredBytes: number;
  readonly appliedMigrations: readonly string[];
  readonly changes: readonly RehearsalTableChange[];
  readonly checks: readonly { name: string; ok: boolean }[];
  readonly timings: Readonly<Record<string, number>>;
}

/** Restore a verified backup or consistent source snapshot and boot an isolated application copy. */
export async function rehearseRecovery(options: RehearsalOptions & { boot: NonNullable<RehearsalOptions["boot"]> }): Promise<RehearsalReport> {
  if (typeof options.boot !== "function") throw new TypeError("A restore rehearsal needs an application boot factory.");
  return rehearse(options, "restore");
}

/** Apply proposed immutable migrations only to a disposable database, optionally verifying the app. */
export async function rehearseMigrations(options: RehearsalOptions & { migrations: NonNullable<RehearsalOptions["migrations"]> }): Promise<RehearsalReport> {
  if (!options.migrations?.directory) throw new TypeError("A migration directory is required.");
  return rehearse(options, "migration");
}

async function rehearse(options: RehearsalOptions, kind: RehearsalReport["kind"]): Promise<RehearsalReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maximum = options.maxDatabaseBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError("Rehearsal timeout must be 100–300000 ms.");
  if (!Number.isSafeInteger(maximum) || maximum < 4096 || maximum > 512 * 1024 * 1024) throw new TypeError("Invalid rehearsal database limit.");
  const checks = options.checks ?? [{ name: "health", path: "/healthz", status: 200 }];
  if (checks.length > 20 || checks.some(check => typeof check.name !== "string" || !/^[A-Za-z0-9 ._-]{1,100}$/.test(check.name)
    || typeof check.path !== "string" || !check.path.startsWith("/") || check.path.startsWith("//") || check.path.length > 2048
    || (check.status !== undefined && (!Number.isInteger(check.status) || check.status < 100 || check.status > 599))
    || (check.includes !== undefined && (typeof check.includes !== "string" || check.includes.length > 4096)))) throw new TypeError("Invalid rehearsal checks.");
  if (options.boot && !checks.length) throw new TypeError("An application rehearsal needs at least one HTTP check.");
  const fsName = "node:fs/promises", osName = "node:os", pathName = "node:path", cryptoName = "node:crypto";
  const [fs, os, path, crypto] = await Promise.all([import(fsName), import(osName), import(pathName), import(cryptoName)]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-rehearsal-"));
  await fs.chmod(root, 0o700);
  const target = path.join(root, "application.sqlite");
  const controller = new AbortController();
  const started = performance.now();
  const timings: Record<string, number> = {};
  const results: { name: string; ok: boolean }[] = [];
  let changes: RehearsalTableChange[] = [];
  let migrations: string[] = [];
  let application: RehearsalApplication | undefined;
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let phase = "restore";
  let failure: string | null = null;
  let restoredBytes = 0;
  const privateError = (error: unknown) => { try { options.onError?.(error); } catch { /* Reporting cannot change cleanup. */ } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error("Rehearsal deadline exceeded."));
  }, timeoutMs); });
  const withinDeadline = <Value>(operation: Promise<Value>) => Promise.race([operation, deadline]);
  try {
    const restoreStarted = performance.now();
    if ("databasePath" in options.source) {
      const stats = await fs.lstat(options.source.databasePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximum) throw new Error("Invalid rehearsal source.");
      await withinDeadline(backupSQLite(options.source.databasePath, target));
    } else {
      const backup = await withinDeadline(options.source.manager.read(options.source.backupId));
      if (backup.bytes.byteLength > maximum) throw new Error("Backup exceeds rehearsal limit.");
      const incoming = path.join(root, "verified-backup.sqlite");
      await fs.writeFile(incoming, backup.bytes, { flag: "wx", mode: 0o600 });
      await withinDeadline(backupSQLite(incoming, target));
    }
    restoredBytes = (await fs.stat(target)).size;
    if (restoredBytes > maximum) throw new Error("Restored database exceeds rehearsal limit.");
    timings.restoreMs = performance.now() - restoreStarted;
    const key = crypto.randomBytes(32);
    const before = await inspectDatabase(target, key);
    if (options.migrations) {
      phase = "migrations";
      const started = performance.now();
      const stats = await fs.lstat(options.migrations.directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Invalid migration directory.");
      const plan = await withinDeadline(applyMigrations({ path: target, directory: options.migrations.directory, allowUnsafe: options.migrations.allowUnsafe, restrictToDatabase: true }));
      migrations = plan.pending.map(migration => migration.id);
      timings.migrationsMs = performance.now() - started;
    }
    const after = await inspectDatabase(target, key);
    changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(table => {
      const left = before.get(table), right = after.get(table);
      if (left?.schema === right?.schema && left?.digest === right?.digest) return [];
      return [{ table, beforeRows: left?.rows ?? null, afterRows: right?.rows ?? null,
        schemaChanged: left?.schema !== right?.schema, dataChanged: left?.digest !== right?.digest }];
    });
    if (options.boot) {
      phase = "boot";
      const bootStarted = performance.now();
      const pending = Promise.resolve().then(() => options.boot!({ databasePath: target, signal: controller.signal }));
      void pending.then(async app => { if (controller.signal.aborted) await app.close(); }).catch(privateError);
      application = await withinDeadline(pending);
      server = await serve(application, { hostname: "127.0.0.1", port: 0 });
      timings.bootMs = performance.now() - bootStarted;
      phase = "checks";
      const checksStarted = performance.now();
      for (const check of checks) {
        const url = new URL(check.path, server.url);
        if (url.origin !== server.url) throw new Error("Rehearsal checks must stay on the isolated application.");
        const response = await withinDeadline(fetch(url, { redirect: "error", signal: controller.signal }));
        const bytes = await withinDeadline(readResponseBytes(response, 64 * 1024));
        const ok = response.status === (check.status ?? 200) && (check.includes === undefined || new TextDecoder().decode(bytes).includes(check.includes));
        results.push({ name: check.name, ok });
        if (!ok) failure = "checks";
      }
      timings.checksMs = performance.now() - checksStarted;
    }
  } catch (error) { failure = phase; privateError(error); }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    try { await server?.close(); } catch (error) { failure ??= "cleanup"; privateError(error); }
    try { await application?.close(); } catch (error) { failure ??= "cleanup"; privateError(error); }
    try { await fs.rm(root, { recursive: true, force: true }); } catch (error) { failure ??= "cleanup"; privateError(error); }
  }
  timings.totalMs = performance.now() - started;
  return Object.freeze({ protocol: "clank-rehearsal/1", kind, ok: failure === null, failurePhase: failure,
    restoredBytes, appliedMigrations: Object.freeze(migrations), changes: Object.freeze(changes.map(Object.freeze)),
    checks: Object.freeze(results.map(Object.freeze)), timings: Object.freeze(timings) });
}

async function inspectDatabase(file: string, key: Uint8Array): Promise<Map<string, { rows: number; schema: string; digest: string }>> {
  const sqliteName = "node:sqlite", cryptoName = "node:crypto";
  const [sqlite, crypto] = await Promise.all([import(sqliteName), import(cryptoName)]);
  const database = new sqlite.DatabaseSync(file, { readOnly: true });
  const result = new Map<string, { rows: number; schema: string; digest: string }>();
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  try {
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 501").all();
    if (tables.length > 500) throw new Error("Rehearsal supports at most 500 tables.");
    let totalRows = 0;
    for (const table of tables) {
      const columns = database.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
      if (columns.length > 200) throw new Error("Rehearsal supports at most 200 columns per table.");
      const hash = crypto.createHmac("sha256", key);
      let rows = 0;
      const statement = database.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${columns.map((column: { name: string }) => (quote(column.name) + " COLLATE BINARY")).join(", ")}`);
      statement.setReadBigInts(true);
      for (const row of statement.iterate()) {
        if (++totalRows > 100_000) throw new Error("Rehearsal supports at most 100000 rows.");
        hash.update(JSON.stringify(row, (_name, value) => typeof value === "bigint" ? { integer: String(value) } : value));
        hash.update("\n"); rows++;
      }
      result.set(table.name, { rows, schema: table.sql, digest: hash.digest("hex") });
    }
    return result;
  } finally { database.close(); }
}
