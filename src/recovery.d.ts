import type { ObjectStore } from "./object-storage.js";
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
export interface BackupSnapshotInput {
    /** Consistent SQLite snapshot bytes obtained from a trusted source. */
    bytes: Uint8Array;
    /** Optional precomputed checksum, verified before encryption. */
    sha256?: string;
    /** Basename recorded in the manifest. */
    source: string;
    reason?: string;
    databaseRevision?: number | null;
    migrationCount?: number;
    latestMigration?: string | null;
    protectedBackupIds?: readonly string[];
}
export interface BackupReadResult {
    bytes: Uint8Array;
    verification: BackupVerification;
}
export interface BackupManager {
    create(options?: {
        reason?: string;
        /** Backup IDs that this create/prune cycle must preserve temporarily. */
        protectedBackupIds?: readonly string[];
    }): Promise<BackupManifest>;
    /** Encrypts an already-consistent snapshot without writing plaintext staging data. */
    createFromSnapshot(options: BackupSnapshotInput): Promise<BackupManifest>;
    list(): Promise<readonly BackupManifest[]>;
    verify(id: string): Promise<BackupVerification>;
    /** Authenticates and decrypts a backup into bounded memory without a plaintext staging file. */
    read(id: string): Promise<BackupReadResult>;
    restore(id: string, options: {
        targetPath?: string;
        confirmation: string;
    }): Promise<BackupVerification>;
    delete(id: string): Promise<boolean>;
    /** Permanently removes every local and object-backed recovery point. */
    purge(options: {
        confirmation: "delete all backups";
    }): Promise<number>;
    start(intervalMs: number): () => void;
    close(): void;
}
export interface BackupManagerOptions {
    /** Local live database. Optional for snapshot-import-only repositories. */
    databasePath?: string;
    repositoryDirectory: string;
    encryptionKey: string | Uint8Array;
    keyId?: string;
    maxBackups?: number;
    maxAgeMs?: number;
    maxDatabaseBytes?: number;
    verifyAfterCreate?: boolean;
    /**
     * Stores encrypted backup envelopes outside the application volume.
     *
     * The local repository remains as a private staging area and compatibility
     * source. Existing local backups are promoted on the next create. A stable
     * namespace and repositoryId prevent a configuration change from silently
     * pointing at a different backup history.
     */
    objects?: BackupObjectRepositoryOptions;
    onEvent?: (event: {
        type: "created" | "verified" | "restored" | "deleted" | "failed";
        backupId?: string;
        durationMs?: number;
        error?: string;
    }) => void;
}
export interface BackupObjectRepositoryOptions {
    store: ObjectStore;
    /** Stable operator-selected identity for the physical repository. */
    namespace: string;
    /** Stable identity for this database within the shared object repository. */
    repositoryId: string;
    /** Logical key prefix. Defaults to "backups". */
    prefix?: string;
    /** Encrypted bytes uploaded per immutable object. Defaults to 8 MiB. */
    chunkBytes?: number;
}
/** Opens an encrypted local or object-backed backup repository for one SQLite database. */
export declare function openBackupManager(options: BackupManagerOptions): Promise<BackupManager>;
