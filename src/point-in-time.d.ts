import type { SQLiteDatabase } from "./backend.js";
export interface PointInTimeRecoveryOptions {
    directory: string;
    encryptionKey: Uint8Array;
    keyId?: string;
    maxTransactionBytes?: number;
    maxStateBytes?: number;
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
}
export interface PointInTimeRestoreResult {
    epoch: string;
    sequence: number;
    committedAt: number;
    databasePath: string;
}
export declare function openPointInTimeRecovery(database: SQLiteDatabase<any>, options: PointInTimeRecoveryOptions): Promise<PointInTimeRecovery>;
export declare function restorePointInTime(options: PointInTimeRestoreOptions): Promise<PointInTimeRestoreResult>;
