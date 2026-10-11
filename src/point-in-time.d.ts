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

/** A stopped same-release transfer. This identity does not grant runtime or writer authority. */
export interface PointInTimeTransferIdentity {
  readonly handoffId: string;
  readonly source: PointInTimeProviderBinding;
  readonly targetNodeId: string;
  readonly targetGeneration: number;
  readonly artifactSha256: string;
}
export interface PointInTimeTransferCursor { readonly epoch: string; readonly sequence: number; readonly digest: string; }
export interface PointInTimeTransferBounds { maxBatchBytes?: number; maxEntries?: number; }
export interface PointInTimeTransferExportOptions extends PointInTimeTransferBounds {
  identity: PointInTimeTransferIdentity;
  after: PointInTimeTransferCursor;
  throughSequence: number;
}
export interface PointInTimeTransferBatch {
  readonly protocol: "clank-pitr-transfer/1";
  readonly identity: PointInTimeTransferIdentity;
  readonly keyId: string;
  readonly baseBackupId: string;
  readonly after: PointInTimeTransferCursor;
  readonly through: PointInTimeTransferCursor;
  readonly envelopes: readonly string[];
  readonly authentication: string;
}
export interface PointInTimeTransferAuthority {
  /** Consult actual current native source ownership; an epoch number is not authority. */
  assertSourceCurrent(): void;
  /** The exact destination must remain stopped and exclusively owned through publication. */
  assertTargetCurrent(): void;
  maxDurationMs?: number;
}
export interface PointInTimeTransferStageOptions extends PointInTimeTransferAuthority {
  identity: PointInTimeTransferIdentity;
  encryptionKey: Uint8Array;
  targetPath: string;
  expectedEpoch: string;
  expectedSequence: number;
  expectedDigest: string;
  operationId?: string;
  maxArchiveBytes?: number;
  maxEntries?: number;
}
export interface PointInTimeTransferApplyOptions extends PointInTimeTransferAuthority, PointInTimeTransferBounds {
  identity: PointInTimeTransferIdentity;
  encryptionKey: Uint8Array;
  targetPath: string;
  /** Independently retained predecessor. It cannot be derived from an untrusted batch. */
  expectedCursor: PointInTimeTransferCursor;
}
export interface PointInTimeTransferResult {
  readonly cursor: PointInTimeTransferCursor;
  readonly baseBackupId: string;
  readonly appliedEntries: number;
  readonly replayed: boolean;
}
export declare function exportPointInTimeTransfer(recovery: PointInTimeRecovery, options: PointInTimeTransferExportOptions): Promise<PointInTimeTransferBatch>;
export declare function stagePointInTimeTransfer(archive: PointInTimeArchive, options: PointInTimeTransferStageOptions): Promise<PointInTimeTransferResult>;
export declare function applyPointInTimeTransfer(batch: PointInTimeTransferBatch, options: PointInTimeTransferApplyOptions): Promise<PointInTimeTransferResult>;

export interface PointInTimeTransferSourceBinding {
  identity: PointInTimeTransferIdentity;
  baseOperationId: string;
  baseArchiveSha256: string;
  initialCursor: PointInTimeTransferCursor;
}
export interface PointInTimeTransferSourceOptions extends PointInTimeTransferSourceBinding {
  /** Actual synchronous native ownership, never a generation number or heartbeat. */
  assertSourceCurrent(): undefined;
}
export interface PointInTimeTransferSource {
  export(options: Omit<PointInTimeTransferExportOptions, "identity">): Promise<PointInTimeTransferBatch>;
  seal(after: PointInTimeTransferCursor): PointInTimeTransferSourceSeal;
}
export interface PointInTimeTransferSourceSeal extends Readonly<PointInTimeTransferSourceBinding> {
  readonly protocol: "clank-pitr-source-seal/1";
  readonly baseBackupId: string;
  readonly keyId: string;
  readonly after: PointInTimeTransferCursor;
  readonly through: PointInTimeTransferCursor;
  readonly committedAt: number;
  readonly schemaHash: string;
  readonly stateHash: string;
  readonly inputDigest: string;
  readonly authentication: string;
}
export interface PointInTimeTransferSourceInspectionOptions extends PointInTimeTransferSourceBinding {
  sourcePath: string;
  encryptionKey: Uint8Array;
  after: PointInTimeTransferCursor;
  /** Current ownership of the retained source data/barrier; does not prove process absence. */
  assertCurrent(): undefined;
  maxDurationMs?: number;
  maxDatabaseBytes?: number;
  maxStateBytes?: number;
}
export interface PointInTimeTransferSealedExportOptions extends PointInTimeTransferSourceInspectionOptions, PointInTimeTransferBounds {
  expectedCursor: PointInTimeTransferCursor;
  throughSequence: number;
}
export declare function openPointInTimeTransferSource(recovery: PointInTimeRecovery, options: PointInTimeTransferSourceOptions): PointInTimeTransferSource;
export declare function inspectPointInTimeTransferSourceSeal(options: PointInTimeTransferSourceInspectionOptions): Promise<PointInTimeTransferSourceSeal>;
export declare function exportSealedPointInTimeTransfer(options: PointInTimeTransferSealedExportOptions): Promise<PointInTimeTransferBatch>;
