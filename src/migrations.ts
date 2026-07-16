export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export interface MigrationPlan {
  readonly applied: MigrationRecord[];
  readonly pending: Migration[];
}

export interface LoadMigrationsOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface ApplyMigrationsOptions extends LoadMigrationsOptions {
  path: string;
  directory: string;
  allowUnsafe?: boolean;
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): Array<Record<string, unknown>>;
    get(...parameters: unknown[]): Record<string, unknown> | undefined;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
  enableLoadExtension?(allow: boolean): void;
}

interface DatabaseSyncConstructor {
  new(path: string, options?: { readOnly?: boolean }): DatabaseSyncLike;
}

const MIGRATION_NAME = /^([0-9]{4,12})_([a-z0-9][a-z0-9_-]{0,79})\.sql$/;
const FORBIDDEN_STATEMENTS = new Set([
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/** Loads ordered, immutable SQL migrations and calculates their SHA-256 checksums. */
export async function loadMigrations(
  directory: string,
  options: LoadMigrationsOptions = {},
): Promise<Migration[]> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const cryptoName = "node:crypto";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    readdir(path: string, options: { withFileTypes: true }): Promise<Array<{
      name: string;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>>;
  };
  const path = await import(pathName) as unknown as {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
  };
  const { createHash } = await import(cryptoName) as unknown as {
    createHash(name: string): { update(value: string): { digest(encoding: "hex"): string } };
  };
  const root = path.resolve(directory);
  let rootStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStats = await fs.lstat(root);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("The migrations path must be a real directory.");
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  if (entries.length > (options.maxFiles ?? 1_000)) {
    throw new Error(`Migration count exceeds ${options.maxFiles ?? 1_000}.`);
  }
  const output: Migration[] = [];
  let previousId = "";
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Migration symbolic links are not allowed: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Migration directories and special files are not allowed: ${entry.name}`);
    const matched = MIGRATION_NAME.exec(entry.name);
    if (!matched) {
      throw new Error(`Invalid migration name "${entry.name}". Expected 0001_short_name.sql.`);
    }
    const [, id, name] = matched;
    if (id <= previousId) throw new Error(`Migration IDs must be strictly increasing: ${entry.name}`);
    previousId = id;
    const filename = path.join(root, entry.name);
    const stats = await fs.lstat(filename);
    const limit = options.maxFileBytes ?? 1024 * 1024;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) {
      throw new Error(`Migration ${entry.name} is not a regular file or exceeds ${limit} bytes.`);
    }
    const sql = await fs.readFile(filename, "utf8");
    output.push(Object.freeze({
      id,
      name,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    }));
  }
  return output;
}

/** Returns applied and pending migrations while rejecting edited migration history. */
export async function planMigrations(
  path: string,
  migrations: readonly Migration[],
): Promise<MigrationPlan> {
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName) as unknown as { DatabaseSync: DatabaseSyncConstructor };
  const safePath = await prepareDatabasePath(path);
  const database = new DatabaseSync(safePath);
  try {
    configureMigrationDatabase(database);
    assertDatabaseIntegrity(database);
    createLedger(database);
    assertDatabaseIntegrity(database);
    const applied = database.prepare(
      "SELECT id, name, checksum, applied_at FROM clank_migrations ORDER BY id",
    ).all().map(migrationRecord);
    const available = new Map(migrations.map((migration) => [migration.id, migration]));
    for (const record of applied) {
      const migration = available.get(record.id);
      if (!migration) {
        throw new Error(`Applied migration ${record.id}_${record.name} is missing from the release.`);
      }
      if (migration.name !== record.name || migration.checksum !== record.checksum) {
        throw new Error(`Applied migration ${record.id}_${record.name} was modified. Migration history is immutable.`);
      }
    }
    const appliedIds = new Set(applied.map((migration) => migration.id));
    return { applied, pending: migrations.filter((migration) => !appliedIds.has(migration.id)) };
  } finally {
    database.close();
  }
}

/** Applies every pending migration in one immediate SQLite transaction. */
export async function applyMigrations(options: ApplyMigrationsOptions): Promise<MigrationPlan> {
  const migrations = await loadMigrations(options.directory, options);
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName) as unknown as { DatabaseSync: DatabaseSyncConstructor };
  const path = await prepareDatabasePath(options.path);
  const database = new DatabaseSync(path);
  try {
    configureMigrationDatabase(database);
    assertDatabaseIntegrity(database);
    createLedger(database);
    assertDatabaseIntegrity(database);
    const applied = database.prepare(
      "SELECT id, name, checksum, applied_at FROM clank_migrations ORDER BY id",
    ).all().map(migrationRecord);
    const available = new Map(migrations.map((migration) => [migration.id, migration]));
    for (const record of applied) {
      const migration = available.get(record.id);
      if (!migration || migration.name !== record.name || migration.checksum !== record.checksum) {
        throw new Error(`Applied migration ${record.id}_${record.name} is missing or was modified.`);
      }
    }
    const appliedIds = new Set(applied.map((migration) => migration.id));
    const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
    for (const migration of pending) {
      if (!options.allowUnsafe) assertSafeMigrationSql(migration.sql, migration.id);
    }
    if (pending.length === 0) return { applied, pending: [] };
    database.exec("BEGIN IMMEDIATE");
    try {
      const insert = database.prepare(
        "INSERT INTO clank_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      );
      for (const migration of pending) {
        database.exec(migration.sql);
        insert.run(migration.id, migration.name, migration.checksum, Date.now());
      }
      database.exec("COMMIT");
      assertDatabaseIntegrity(database);
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
    return {
      applied: database.prepare(
        "SELECT id, name, checksum, applied_at FROM clank_migrations ORDER BY id",
      ).all().map(migrationRecord),
      pending,
    };
  } finally {
    database.close();
  }
}

/** Creates a transactionally consistent SQLite backup using Node's built-in backup API. */
export async function backupSQLite(sourcePath: string, destinationPath: string): Promise<void> {
  const sqliteName = "node:sqlite";
  const { DatabaseSync, backup } = await import(sqliteName) as unknown as {
    DatabaseSync: DatabaseSyncConstructor;
    backup(source: DatabaseSyncLike, path: string): Promise<void>;
  };
  const sourceName = await requireRegularDatabaseFile(sourcePath, "Backup source");
  const destinationName = await resolveDatabaseDestination(destinationPath);
  const temporary = `${destinationName}.tmp-${globalThis.crypto.randomUUID()}`;
  await createPrivateFile(temporary);
  try {
    const source = new DatabaseSync(sourceName, { readOnly: true });
    try {
      configureReadOnlyDatabase(source);
      assertDatabaseIntegrity(source);
      await backup(source, temporary);
    } finally {
      source.close();
    }
    await hardenDatabaseFile(temporary);
    await verifyDatabaseFile(temporary);
    await replaceDatabaseFile(temporary, destinationName);
  } catch (error) {
    await removeFile(temporary);
    throw error;
  }
}

/** Replaces a stopped application's database with a prior SQLite backup. */
export async function restoreSQLiteBackup(sourcePath: string, destinationPath: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    copyFile(source: string, destination: string): Promise<void>;
  };
  const sourceName = await requireRegularDatabaseFile(sourcePath, "Restore source");
  await verifyDatabaseFile(sourceName);
  const destinationName = await resolveDatabaseDestination(destinationPath);
  const temporary = `${destinationName}.tmp-${globalThis.crypto.randomUUID()}`;
  try {
    await createPrivateFile(temporary);
    await fs.copyFile(sourceName, temporary);
    await hardenDatabaseFile(temporary);
    await verifyDatabaseFile(temporary);
    await replaceDatabaseFile(temporary, destinationName);
  } catch (error) {
    await removeFile(temporary);
    throw error;
  }
}

function createLedger(database: DatabaseSyncLike): void {
  const legacy = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'proact_migrations'",
  ).all().length > 0;
  const current = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'clank_migrations'",
  ).all().length > 0;
  if (legacy && current) {
    throw new Error("Cannot migrate legacy migration ledger: clank_migrations already exists.");
  }
  if (legacy) database.exec("ALTER TABLE proact_migrations RENAME TO clank_migrations");
  database.exec(`CREATE TABLE IF NOT EXISTS clank_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
}

function migrationRecord(row: Record<string, unknown>): MigrationRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: Number(row.applied_at),
  };
}

/** Rejects SQL that can escape the application database or break the outer transaction. */
export function assertSafeMigrationSql(sql: string, id = "unknown"): void {
  const keywords = tokenizeSql(sql);
  for (let index = 0; index < keywords.length; index++) {
    const keyword = keywords[index]!;
    if (keyword === "ATTACH" || keyword === "DETACH" || keyword === "VACUUM") {
      throw new Error(`Migration ${id} uses forbidden database-control statement ${keyword}.`);
    }
    if (keyword === "PRAGMA") {
      throw new Error(`Migration ${id} cannot execute PRAGMA statements without operator approval.`);
    }
    if (keyword === "LOAD_EXTENSION") {
      throw new Error(`Migration ${id} cannot load SQLite extensions.`);
    }
    if (keyword.startsWith("CLANK_") || keyword.startsWith("PROACT_")) {
      throw new Error(`Migration ${id} cannot modify reserved Clank table ${keyword.toLowerCase()}.`);
    }
  }
  for (const statement of splitSqlStatements(sql)) {
    const first = tokenizeSql(statement)[0];
    if (first && FORBIDDEN_STATEMENTS.has(first)) {
      throw new Error(`Migration ${id} uses forbidden transaction statement ${first}.`);
    }
  }
}

function splitSqlStatements(sql: string): string[] {
  const output: string[] = [];
  let start = 0;
  let index = 0;
  let quote = "";
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (!quote && character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index += 2;
      continue;
    }
    if (!quote && (character === "'" || character === "\"" || character === "`" || character === "[")) {
      quote = character === "[" ? "]" : character;
      index++;
      continue;
    }
    if (quote && character === quote) {
      if (sql[index + 1] === quote && quote !== "]") {
        index += 2;
        continue;
      }
      quote = "";
      index++;
      continue;
    }
    if (!quote && character === ";") {
      output.push(sql.slice(start, index));
      start = index + 1;
    }
    index++;
  }
  output.push(sql.slice(start));
  return output;
}

function tokenizeSql(sql: string): string[] {
  const output: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index += 2;
      continue;
    }
    if (character === "'") {
      index++;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === "\"" || character === "`" || character === "[") {
      const close = character === "[" ? "]" : character;
      index++;
      let identifier = "";
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && close !== "]") {
            identifier += close;
            index += 2;
            continue;
          }
          index++;
          break;
        }
        identifier += sql[index]!;
        index++;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) output.push(identifier.toUpperCase());
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index]!)) index++;
      output.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index++;
  }
  return output;
}

function configureMigrationDatabase(database: DatabaseSyncLike): void {
  database.enableLoadExtension?.(false);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA recursive_triggers = OFF");
  database.exec("PRAGMA secure_delete = FAST");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = FULL");
}

function configureReadOnlyDatabase(database: DatabaseSyncLike): void {
  database.enableLoadExtension?.(false);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA recursive_triggers = OFF");
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
}

function assertDatabaseIntegrity(database: DatabaseSyncLike): void {
  const quick = database.prepare("PRAGMA quick_check").all();
  const failures = quick
    .flatMap((row) => Object.values(row).map(String))
    .filter((value) => value !== "ok");
  if (failures.length > 0) {
    throw new Error(`SQLite quick_check failed: ${failures.slice(0, 5).join("; ")}`);
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign-key check failed for ${foreignKeys.length} row(s).`);
  }
}

async function prepareDatabasePath(input: string): Promise<string> {
  if (input === ":memory:") return input;
  const resolved = await resolveDatabaseDestination(input);
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    open(path: string, flags: string, mode: number): Promise<{
      chmod(mode: number): Promise<void>;
      close(): Promise<void>;
    }>;
  };
  const handle = await fs.open(resolved, "a", 0o600);
  try { await handle.chmod(0o600); } finally { await handle.close(); }
  return resolved;
}

async function resolveDatabaseDestination(input: string): Promise<string> {
  if (!input || input.includes("\0") || input === ":memory:") {
    throw new TypeError("SQLite file path is invalid.");
  }
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
    mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as {
    resolve(path: string): string;
    dirname(path: string): string;
  };
  const resolved = path.resolve(input);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    const stats = await fs.lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("SQLite destination must be a regular file and cannot be a symbolic link.");
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return resolved;
}

async function requireRegularDatabaseFile(input: string, label: string): Promise<string> {
  if (!input || input.includes("\0") || input === ":memory:") {
    throw new TypeError(`${label} must be a SQLite file.`);
  }
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  };
  const path = await import(pathName) as unknown as { resolve(path: string): string };
  const resolved = path.resolve(input);
  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
  }
  return resolved;
}

async function hardenDatabaseFile(path: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    chmod(path: string, mode: number): Promise<void>;
  };
  await fs.chmod(path, 0o600);
}

async function createPrivateFile(path: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    open(path: string, flags: string, mode: number): Promise<{ close(): Promise<void> }>;
  };
  const handle = await fs.open(path, "wx", 0o600);
  await handle.close();
}

async function verifyDatabaseFile(path: string): Promise<void> {
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName) as unknown as { DatabaseSync: DatabaseSyncConstructor };
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    configureReadOnlyDatabase(database);
    assertDatabaseIntegrity(database);
  } finally {
    database.close();
  }
}

async function replaceDatabaseFile(temporary: string, destination: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    rename(source: string, destination: string): Promise<void>;
    rm(path: string, options: { force: true }): Promise<void>;
  };
  await Promise.all([
    fs.rm(`${destination}-wal`, { force: true }),
    fs.rm(`${destination}-shm`, { force: true }),
  ]);
  await fs.rename(temporary, destination);
  await hardenDatabaseFile(destination);
}

async function removeFile(path: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    rm(path: string, options: { force: true }): Promise<void>;
  };
  await fs.rm(path, { force: true });
}
