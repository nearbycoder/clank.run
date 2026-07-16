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
/** Loads ordered, immutable SQL migrations and calculates their SHA-256 checksums. */
export declare function loadMigrations(directory: string, options?: LoadMigrationsOptions): Promise<Migration[]>;
/** Returns applied and pending migrations while rejecting edited migration history. */
export declare function planMigrations(path: string, migrations: readonly Migration[]): Promise<MigrationPlan>;
/** Applies every pending migration in one immediate SQLite transaction. */
export declare function applyMigrations(options: ApplyMigrationsOptions): Promise<MigrationPlan>;
/** Creates a transactionally consistent SQLite backup using Node's built-in backup API. */
export declare function backupSQLite(sourcePath: string, destinationPath: string): Promise<void>;
/** Replaces a stopped application's database with a prior SQLite backup. */
export declare function restoreSQLiteBackup(sourcePath: string, destinationPath: string): Promise<void>;
/** Rejects SQL that can escape the application database or break the outer transaction. */
export declare function assertSafeMigrationSql(sql: string, id?: string): void;
