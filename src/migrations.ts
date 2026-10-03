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
  /** Refuse statements that can access files or databases outside this connection. */
  restrictToDatabase?: boolean;
}

import { runSQLiteTask } from "./sqlite-task.ts";
import { publishSQLiteReplacement } from "./migrations-worker.ts";
export { loadMigrations, assertSafeMigrationSql } from "./migrations-worker.ts";

/** Returns applied and pending migrations in a bounded, terminable process. */
export function planMigrations(path: string, migrations: readonly Migration[]): Promise<MigrationPlan> {
  return runSQLiteTask("migrations", "planMigrations", [path, migrations]);
}

/** Applies pending migrations transactionally in a bounded, terminable process. */
export function applyMigrations(options: ApplyMigrationsOptions): Promise<MigrationPlan> {
  return runSQLiteTask("migrations", "applyMigrations", [options]);
}

/** Creates a transactionally consistent SQLite backup in a bounded process. */
export function backupSQLite(sourcePath: string, destinationPath: string): Promise<void> {
  return runSQLiteReplacement("stageSQLiteBackup", sourcePath, destinationPath);
}

/** Replaces a stopped application's database with a verified prior backup. */
export function restoreSQLiteBackup(sourcePath: string, destinationPath: string): Promise<void> {
  return runSQLiteReplacement("stageSQLiteRestore", sourcePath, destinationPath);
}

async function runSQLiteReplacement(operation: string, sourcePath: string, destinationPath: string): Promise<void> {
  // The parent must know which private files to clean: a SIGKILL or native OOM
  // skips every worker finally block. Only this attempt's unpredictable paths
  // are removed, and runSQLiteTask settles only after the child has closed.
  const temporary = `${destinationPath}.tmp-${globalThis.crypto.randomUUID()}`;
  try {
    await runSQLiteTask("migrations", operation, [sourcePath, destinationPath, temporary]);
    // Publish only after successful worker completion. A forced worker exit can
    // never delete destination sidecars or replace the caller's live database.
    await publishSQLiteReplacement(temporary, destinationPath);
  } finally {
    const moduleName = "node:fs/promises";
    const fs = await import(moduleName);
    await Promise.all([temporary, `${temporary}-journal`, `${temporary}-wal`, `${temporary}-shm`]
      .map((path) => fs.rm(path, { force: true })));
  }
}
