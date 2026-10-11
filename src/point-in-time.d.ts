import type { SQLiteDatabase } from "./backend.js";
export interface PointInTimeRecoveryOptions {
    directory: string;
    encryptionKey: Uint8Array;
    keyId?: string;
    maxTransactionBytes?: number;
    maxStateBytes?: number;
    maxJournalEntries?: number;
    maxJournalBytes?: number;
    maxRemoteExports?: number;
    maxRemoteExportBytes?: number;
    exportIntervalMs?: number | false;
    onError?: (error: unknown) => void;
}
export interface PointInTimeRecoveryStatus {
    epoch: string;
    committedThrough: number;
    exportedThrough: number;
    lastCommittedAt: number;
    baseBackupId: string;
}
export interface PointInTimeRecovery {
    status(): PointInTimeRecoveryStatus;
    flush(): Promise<PointInTimeRecoveryStatus>;
    close(): Promise<void>;
}
export interface PointInTimeRestoreOptions {
    directory: string;
    encryptionKey: Uint8Array;
    targetPath: string;
    confirmation: "restore point in time";
    throughSequence?: number;
    asOf?: number;
    maxDurationMs?: number;
    assertCurrent?: () => void;
}
export interface PointInTimeRestoreResult {
    epoch: string;
    sequence: number;
    committedAt: number;
    databasePath: string;
}
export interface PointInTimeArchive {
    readonly protocol: "clank-pitr-archive/1";
    readonly epoch: string;
    readonly keyId: string;
    readonly sequence: number;
    readonly digest: string;
    readonly committedAt: number;
    readonly operationId: string | null;
    readonly binding: PointInTimeProviderBinding | null;
    readonly files: readonly { readonly name: string; readonly contents: string; readonly bytes: number; readonly sha256: string }[];
    readonly authentication: string;
}
export interface PointInTimeArchiveBounds { maxArchiveBytes?: number; maxEntries?: number; operationId?: string; binding?: PointInTimeProviderBinding; }
export interface PointInTimeProviderBinding { readonly projectId: string; readonly nodeId: string; readonly releaseId: string; readonly generation: number; }
export interface PointInTimeRecoveryProviderOptions extends PointInTimeArchiveBounds { binding: PointInTimeProviderBinding; token: string; assertCurrent(): void; onError?: (error: unknown) => void; }
export interface PointInTimeArchiveRestoreOptions extends PointInTimeArchiveBounds {
    encryptionKey: Uint8Array;
    targetPath: string;
    confirmation: "restore point in time";
    throughSequence: number;
    expectedEpoch: string;
    expectedSequence: number;
    expectedDigest: string;
    expectedBinding?: PointInTimeProviderBinding;
    maxDurationMs?: number;
    assertCurrent?: () => void;
}
export declare function exportPointInTimeRecovery(recovery: PointInTimeRecovery, bounds?: PointInTimeArchiveBounds): Promise<PointInTimeArchive>;
export declare function restorePointInTimeArchive(archive: PointInTimeArchive, options: PointInTimeArchiveRestoreOptions): Promise<PointInTimeRestoreResult>;
export declare function createPointInTimeRecoveryProvider(recovery: PointInTimeRecovery, options: PointInTimeRecoveryProviderOptions): { handle(request: Request): Promise<Response> };
export declare function openPointInTimeRecovery(database: SQLiteDatabase<any>, options: PointInTimeRecoveryOptions): Promise<PointInTimeRecovery>;
export declare function restorePointInTime(options: PointInTimeRestoreOptions): Promise<PointInTimeRestoreResult>;
