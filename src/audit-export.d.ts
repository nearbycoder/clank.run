import type { SQLiteInternal } from "./sqlite-internal.js";
export interface SignedAuditEntry {
  readonly protocol: "clank-signed-audit/1";
  readonly sequence: number;
  readonly previousSequence: number;
  readonly previousDigest: string;
  readonly keyId: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly signature: string;
}
export interface AuditExportCheckpoint { readonly sequence: number; readonly digest: string; }
export interface AuditExportOptions {
  keyId: string;
  privateKey: string;
  destination(entries: readonly SignedAuditEntry[], signal: AbortSignal): Promise<void>;
  intervalMs?: number;
  batchSize?: number;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}
export interface AuditExporter {
  flush(): Promise<number>;
  start(): void;
  status(): { exportedThrough: AuditExportCheckpoint; pending: number };
  close(): Promise<void>;
}
export declare function openAuditExporter(internal: SQLiteInternal, options: AuditExportOptions): Promise<AuditExporter>;
export declare function verifyAuditExport(entries: readonly SignedAuditEntry[], publicKeys: Readonly<Record<string, string>>, checkpoint?: AuditExportCheckpoint): Promise<AuditExportCheckpoint>;
