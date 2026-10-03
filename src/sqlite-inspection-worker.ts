import type { DeployPreviewDataConfig, DeployPreviewDataTransform, DeployPreviewJsonTransform } from "./deploy.ts";

export interface ProjectBucketUsageSnapshot {
  readonly available: boolean;
  readonly source: "local_catalog" | "application";
  readonly objects: number | null;
  readonly bytes: number | null;
  readonly reservedObjects: number | null;
  readonly reservedBytes: number | null;
  readonly sampledAt: number | null;
}

export async function inspectProjectBucketUsage(
  projectsRoot: string,
  project: { id: string; placement: string },
): Promise<ProjectBucketUsageSnapshot> {
  const unavailable = Object.freeze({
    available: false,
    source: "application" as const,
    objects: null,
    bytes: null,
    reservedObjects: null,
    reservedBytes: null,
    sampledAt: null,
  });
  // Provider volumes are deliberately outside the control-plane trust boundary.
  // Their users see the same live inventory through the authenticated app URL.
  if (project.placement !== "local") return unavailable;
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const sqliteName = "node:sqlite";
  const [fs, path, sqlite] = await Promise.all([
    import(fsName) as unknown as Promise<{
      lstat(path: string): Promise<{
        mtimeMs: number;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      }>;
    }>,
    import(pathName) as unknown as Promise<{ join(...segments: string[]): string }>,
    import(sqliteName) as unknown as Promise<{
      DatabaseSync: new(path: string, options: { readOnly: boolean }) => {
        exec(sql: string): void;
        prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    }>,
  ]);
  const catalog = path.join(projectsRoot, project.id, "data", "buckets", "catalog.sqlite");
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    const stats = await fs.lstat(catalog);
    if (!stats.isFile() || stats.isSymbolicLink()) return unavailable;
    database = new sqlite.DatabaseSync(catalog, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000;");
    const schema = database.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN ('clank_bucket_objects', 'clank_bucket_reservations')`).get();
    if (Number(schema?.count ?? 0) !== 2) return unavailable;
    const row = database.prepare(`SELECT
      (SELECT count(*) FROM clank_bucket_objects) AS objects,
      (SELECT coalesce(sum(size), 0) FROM clank_bucket_objects) AS bytes,
      (SELECT coalesce(sum(CASE WHEN replaces_size IS NULL THEN 1 ELSE 0 END), 0)
        FROM clank_bucket_reservations) AS reserved_objects,
      (SELECT coalesce(sum(max(0, size - coalesce(replaces_size, 0))), 0)
        FROM clank_bucket_reservations) AS reserved_bytes`).get();
    return Object.freeze({
      available: true,
      source: "local_catalog",
      objects: safeUsageInteger(row?.objects),
      bytes: safeUsageInteger(row?.bytes),
      reservedObjects: safeUsageInteger(row?.reserved_objects),
      reservedBytes: safeUsageInteger(row?.reserved_bytes),
      sampledAt: Math.max(0, Math.trunc(stats.mtimeMs)),
    });
  } catch {
    return unavailable;
  } finally {
    database?.close();
  }
}

function safeUsageInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Bucket catalog usage is invalid.");
  return parsed;
}

export interface PreviewDataSanitizationReport {
  tablesCopied: number;
  tablesEmptied: number;
  rowsRetained: number;
  rowsRemoved: number;
  valuesTransformed: number;
  valuesExplicitlyKept: number;
}

const PREVIEW_DATA_PRESERVED_TABLES = new Set(["clank_meta", "clank_migrations"]);
const PREVIEW_DATA_PURGED_TABLES = new Set([
  "clank_changes",
  // Revision snapshots contain prior application values and must never bypass
  // the active release's explicit per-column preview sanitization policy.
  "clank_document_revisions",
  "clank_job_events",
  "clank_job_schedules",
  "clank_jobs",
  "clank_service_jobs",
  "clank_workflow_events",
  "clank_workflow_steps",
  "clank_workflow_runs",
]);
const PREVIEW_DATA_PURGED_PREFIXES = ["clank_auth_", "clank_oauth_"];

export async function sanitizePreviewDatabase(
  databasePath: string,
  policy: DeployPreviewDataConfig,
  seedBytes: readonly number[],
): Promise<PreviewDataSanitizationReport> {
  const seed = new Uint8Array(seedBytes);
  const sqliteName = "node:sqlite";
  const cryptoName = "node:crypto";
  const [{ DatabaseSync }, cryptoModule] = await Promise.all([
    import(sqliteName) as unknown as Promise<{ DatabaseSync: new(path: string) => any }>,
    import(cryptoName) as unknown as Promise<{
      createHmac(algorithm: string, key: Uint8Array): {
        update(value: string | Uint8Array): { digest(encoding: "hex"): string };
      };
    }>,
  ]);
  const database = new DatabaseSync(databasePath);
  const report: PreviewDataSanitizationReport = {
    tablesCopied: 0,
    tablesEmptied: 0,
    rowsRetained: 0,
    rowsRemoved: 0,
    valuesTransformed: 0,
    valuesExplicitlyKept: 0,
  };
  const digest = (value: unknown): string => {
    const encoded = value instanceof Uint8Array
      ? value
      : `${value === null ? "null" : typeof value}:${String(value)}`;
    return cryptoModule.createHmac("sha256", seed).update(encoded).digest("hex");
  };
  try {
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("PRAGMA secure_delete = ON");
    const tables = database.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
        name: string;
        sql: string | null;
      }>;
    const tableNames = new Set(tables.map((table) => String(table.name)));
    for (const requested of Object.keys(policy.tables)) {
      if (!tableNames.has(requested)) {
        throw new Error(`Preview data policy references missing table ${requested}.`);
      }
      if (previewDataTableIsProtected(requested)) {
        throw new Error(`Preview data policy cannot retain protected table ${requested}.`);
      }
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      let totalRows = 0;
      for (const table of tables) {
        const name = String(table.name);
        if (PREVIEW_DATA_PRESERVED_TABLES.has(name)) continue;
        const tablePolicy = policy.tables[name];
        if (!tablePolicy || previewDataTableIsProtected(name)) {
          const removed = Number(database.prepare(
            `SELECT count(*) AS count FROM ${previewSqlIdentifier(name)}`,
          ).get().count);
          database.prepare(`DELETE FROM ${previewSqlIdentifier(name)}`).run();
          report.tablesEmptied++;
          report.rowsRemoved += removed;
          continue;
        }
        report.tablesCopied++;
        const columns = database.prepare(
          `PRAGMA table_info(${previewSqlIdentifier(name)})`,
        ).all() as Array<{
          name: string;
          type: string;
          pk: number;
        }>;
        const columnNames = new Set(columns.map((column) => String(column.name)));
        for (const configured of Object.keys(tablePolicy.columns ?? {})) {
          if (!columnNames.has(configured)) {
            throw new Error(`Preview data policy references missing column ${name}.${configured}.`);
          }
        }
        const primary = columns
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk));
        const withoutRowId = /\bWITHOUT\s+ROWID\b/iu.test(String(table.sql ?? ""));
        const identity = primary.length > 0
          ? primary.map((column) => String(column.name))
          : withoutRowId
            ? []
            : ["rowid"];
        if (identity.length === 0) {
          throw new Error(`Preview data table ${name} has no deterministic row identity.`);
        }
        const rowLimit = tablePolicy.rows ?? 1_000;
        const ordering = identity.map(previewSqlIdentifier).join(", ");
        const identityTuple = identity.length === 1
          ? previewSqlIdentifier(identity[0]!)
          : `(${identity.map(previewSqlIdentifier).join(", ")})`;
        const before = Number(database.prepare(
          `SELECT count(*) AS count FROM ${previewSqlIdentifier(name)}`,
        ).get().count);
        database.prepare(`DELETE FROM ${previewSqlIdentifier(name)} WHERE ${identityTuple} NOT IN (
          SELECT ${identity.map(previewSqlIdentifier).join(", ")}
          FROM ${previewSqlIdentifier(name)} ORDER BY ${ordering} LIMIT ?
        )`).run(rowLimit);
        const after = Math.min(before, rowLimit);
        report.rowsRemoved += before - after;
        report.rowsRetained += after;
        totalRows += after;
        if (totalRows > 50_000) {
          throw new Error("Sanitized preview data cannot retain more than 50,000 rows.");
        }
        const selectIdentity = identity[0] === "rowid"
          ? `rowid AS ${previewSqlIdentifier("__clank_preview_rowid")}`
          : identity.map(previewSqlIdentifier).join(", ");
        const selectedColumns = columns.map((column) => previewSqlIdentifier(String(column.name))).join(", ");
        const rows = database.prepare(`SELECT ${selectIdentity}, ${selectedColumns}
          FROM ${previewSqlIdentifier(name)} ORDER BY ${ordering}`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const assignments: string[] = [];
          const values: unknown[] = [];
          for (const column of columns) {
            const columnName = String(column.name);
            const configured = tablePolicy.columns?.[columnName];
            const current = row[columnName];
            const transformed = configured && typeof configured === "object"
              ? sanitizePreviewJson(current, configured, digest, report)
              : sanitizePreviewValue(
                  current,
                  configured ?? previewDefaultTransform(String(column.type)),
                  digest,
                  report,
                  configured !== undefined,
                );
            if (!previewValuesEqual(current, transformed)) {
              assignments.push(`${previewSqlIdentifier(columnName)} = ?`);
              values.push(transformed);
            }
          }
          if (assignments.length === 0) continue;
          const predicates = identity.map((column) => `${previewSqlIdentifier(column)} IS ?`).join(" AND ");
          const identityValues = identity.map((column) =>
            row[column === "rowid" ? "__clank_preview_rowid" : column]);
          database.prepare(`UPDATE ${previewSqlIdentifier(name)} SET ${assignments.join(", ")}
            WHERE ${predicates}`).run(...values, ...identityValues);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("PRAGMA foreign_keys = ON");
    const foreignKeyFailure = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyFailure) {
      throw new Error("Sanitized preview data violates a foreign-key relationship; retain or empty the related tables together.");
    }
    const integrity = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!integrity || String(Object.values(integrity)[0]) !== "ok") {
      throw new Error("Sanitized preview database failed SQLite integrity verification.");
    }
    database.exec("VACUUM");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Object.freeze(report);
  } finally {
    database.close();
  }
}

function previewDataTableIsProtected(name: string): boolean {
  return PREVIEW_DATA_PRESERVED_TABLES.has(name)
    || PREVIEW_DATA_PURGED_TABLES.has(name)
    || PREVIEW_DATA_PURGED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function previewSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value) && value !== "rowid") {
    throw new Error("Preview data contains an unsafe SQLite identifier.");
  }
  return `"${value}"`;
}

function previewDefaultTransform(declaredType: string): DeployPreviewDataTransform {
  return /(?:INT|REAL|FLOA|DOUB|NUM|DEC|BOOL|DATE|TIME)/iu.test(declaredType)
    ? "keep"
    : "hash";
}

function sanitizePreviewValue(
  value: unknown,
  transform: DeployPreviewDataTransform,
  digest: (value: unknown) => string,
  report: PreviewDataSanitizationReport,
  countExplicitKeep = true,
): unknown {
  if (value === null) return null;
  if (transform === "keep") {
    if (countExplicitKeep) report.valuesExplicitlyKept++;
    return value;
  }
  report.valuesTransformed++;
  if (transform === "email") return `preview+${digest(value).slice(0, 16)}@example.invalid`;
  if (transform === "redact") {
    if (typeof value === "number" || typeof value === "bigint") return 0;
    if (value instanceof Uint8Array) return new Uint8Array();
    return "[redacted]";
  }
  if (typeof value === "number") return Number.parseInt(digest(value).slice(0, 12), 16);
  if (typeof value === "bigint") return BigInt(`0x${digest(value).slice(0, 15)}`);
  if (value instanceof Uint8Array) {
    return Uint8Array.from(digest(value).match(/.{2}/gu)!.slice(0, Math.min(value.byteLength, 32)), (pair) =>
      Number.parseInt(pair, 16));
  }
  return `pv_${digest(value).slice(0, 16)}`;
}

function sanitizePreviewJson(
  value: unknown,
  configured: DeployPreviewJsonTransform,
  digest: (value: unknown) => string,
  report: PreviewDataSanitizationReport,
): string {
  if (typeof value !== "string") throw new Error("Configured preview JSON columns must contain text.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Configured preview JSON columns must contain valid JSON.");
  }
  const walk = (current: unknown, pointer: string): unknown => {
    if (Array.isArray(current)) {
      return current.map((entry, index) => walk(entry, `${pointer}/${index}`));
    }
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, entry]) => [
        key,
        walk(entry, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
      ]));
    }
    const pathTransform = configured.json.paths?.[pointer];
    const transform = pathTransform ?? configured.json.default ?? "hash";
    return sanitizePreviewValue(
      current,
      transform,
      digest,
      report,
      pathTransform !== undefined || configured.json.default !== undefined,
    );
  };
  return JSON.stringify(walk(parsed, ""));
}

function previewValuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.byteLength === right.byteLength
      && left.every((value, index) => value === right[index]);
  }
  return Object.is(left, right);
}

export async function inspectFixtureManifest(path: string): Promise<Record<string, unknown>> {
  const sqliteName = "node:sqlite";
  const sqlite = await import(sqliteName);
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000");
    const entries = database.prepare("SELECT protocol, users, records FROM clank_preview_fixture LIMIT 2").all();
    if (entries.length !== 1 || entries[0].protocol !== "clank-preview-fixture/1"
      || !Number.isSafeInteger(entries[0].users) || entries[0].users < 0 || entries[0].users > 20
      || !Number.isSafeInteger(entries[0].records) || entries[0].records < 0 || entries[0].records > 10_000) throw new Error("Invalid fixture manifest.");
    return entries[0];
  } finally { database.close(); }
}

export async function inspectSQLite(path: string): Promise<{
  revision: number | null;
  migrationCount: number;
  latestMigration: string | null;
}> {
  const sqlite = await import("node:sqlite") as any;
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const table = (name: string) => Boolean(database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    const revision = table("clank_meta")
      ? Number(database.prepare("SELECT _value FROM clank_meta WHERE _key = 'global_version'").get()?._value ?? 0)
      : null;
    const migration = table("clank_migrations")
      ? database.prepare("SELECT count(*) AS count, max(id) AS latest FROM clank_migrations").get()
      : { count: 0, latest: null };
    return {
      revision,
      migrationCount: Number(migration.count),
      latestMigration: migration.latest === null ? null : String(migration.latest),
    };
  } finally {
    database.close();
  }
}

export async function verifySQLite(path: string): Promise<void> {
  const sqlite = await import("node:sqlite") as any;
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || String(Object.values(rows[0] ?? {})[0]).toLowerCase() !== "ok") {
      throw new Error("SQLite integrity check failed.");
    }
  } finally {
    database.close();
  }
}

export async function inspectRehearsalDatabase(file: string, keyBytes: readonly number[]): Promise<Array<[string, { rows: number; schema: string; digest: string }]>> {
  const key = new Uint8Array(keyBytes);
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
    return [...result];
  } finally { database.close(); }
}
