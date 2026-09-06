import type { BackupManager } from "./recovery.js";
import type { FetchApplication } from "./node.js";
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
export declare function rehearseRecovery(options: RehearsalOptions & { boot: NonNullable<RehearsalOptions["boot"]> }): Promise<RehearsalReport>;
export declare function rehearseMigrations(options: RehearsalOptions & { migrations: NonNullable<RehearsalOptions["migrations"]> }): Promise<RehearsalReport>;
