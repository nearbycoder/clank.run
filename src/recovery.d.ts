export interface BackupManifest {
    protocol: "clank-backup/1";
    id: string;
    source: string;
    createdAt: number;
    reason: string;
    databaseBytes: number;
    databaseSha256: string;
    databaseRevision: number | null;
    migrationCount: number;
    latestMigration: string | null;
    encryption: {
        algorithm: "AES-256-GCM";
        keyId: string;
    };
}
export interface BackupVerification {
    id: string;
    ok: true;
    verifiedAt: number;
    durationMs: number;
    databaseBytes: number;
    databaseSha256: string;
}
export interface BackupManager {
    create(options?: {
        reason?: string;
    }): Promise<BackupManifest>;
    list(): Promise<readonly BackupManifest[]>;
    verify(id: string): Promise<BackupVerification>;
    restore(id: string, options: {
        targetPath?: string;
        confirmation: string;
    }): Promise<BackupVerification>;
    delete(id: string): Promise<boolean>;
    start(intervalMs: number): () => void;
    close(): void;
}
export interface BackupManagerOptions {
    databasePath: string;
    repositoryDirectory: string;
    encryptionKey: string | Uint8Array;
    keyId?: string;
    maxBackups?: number;
    maxAgeMs?: number;
    maxDatabaseBytes?: number;
    verifyAfterCreate?: boolean;
    onEvent?: (event: {
        type: "created" | "verified" | "restored" | "deleted" | "failed";
        backupId?: string;
        durationMs?: number;
        error?: string;
    }) => void;
}
/** Opens an encrypted local backup repository for one SQLite database. */
export declare function openBackupManager(options: BackupManagerOptions): Promise<BackupManager>;
