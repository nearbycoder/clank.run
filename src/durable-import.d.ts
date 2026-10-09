import { type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
import { type CsvColumn } from "./csv-import.js";
export type DurableImportState = "uploading" | "ready" | "running" | "failed" | "cancelled" | "completed";
export interface DurableImportIssue {
    readonly row: number;
    readonly code: "INVALID_ROW" | "FORBIDDEN" | "DUPLICATE";
}
export type DurableImportColumn<Values> = Omit<CsvColumn, "target"> & {
    target: Extract<keyof Values, string>;
};
export interface DurableImportReview {
    readonly sourceHash: string;
    readonly headers: readonly string[];
    readonly columns: readonly CsvColumn[];
    readonly revision: number;
    readonly updatedRows: number;
    readonly duplicates: "error" | "skip" | "upsert";
}
export interface DurableImportEffect<Values = Record<string, unknown>> {
    readonly row: number;
    readonly action: "insert" | "update" | "skip" | "invalid";
    readonly id?: string;
    readonly version?: number;
    readonly before?: Readonly<Partial<Values>>;
    readonly after?: Readonly<Partial<Values>>;
    readonly issue?: DurableImportIssue["code"] | "AMBIGUOUS";
}
export interface DurableImportPreview<Values = Record<string, unknown>> {
    readonly id: string;
    readonly sourceHash: string;
    readonly processedRows: number;
    readonly revision: number;
    readonly jobVersion: number;
    readonly sourceBatchHash: string;
    readonly definitionHash: string;
    readonly digest: string;
    readonly effects: readonly DurableImportEffect<Values>[];
}
export interface DurableImportSourceWindow<Values = Record<string, unknown>> {
    readonly job: DurableImportJob;
    readonly rows: readonly {
        readonly row: number;
        readonly source: readonly string[];
        readonly corrections: Readonly<Partial<Values>>;
    }[];
    readonly nextRow: number | null;
}
export interface ReviewableImportLimits {
    duplicates?: "error" | "skip" | "upsert";
    maxSourceBytes?: number;
    maxCorrections?: number;
    maxCorrectionBytes?: number;
    maxReceipts?: number;
    maxReceiptBytes?: number;
    maxTargetRecords?: number;
    /** Mandatory for unowned targets; checked before returning existing values. */
    authorizeRead?(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<any>;
    }, record: Readonly<Record<string, unknown>>): boolean;
}
export interface DurableImportJob {
    readonly id: string;
    readonly name: string;
    readonly state: DurableImportState;
    readonly uploadedRows: number;
    readonly processedRows: number;
    readonly insertedRows: number;
    readonly skippedRows: number;
    readonly chunks: number;
    readonly issues: readonly DurableImportIssue[];
    readonly review?: DurableImportReview;
}
export interface DurableImportOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
    path: string;
    auth: AuthDefinition<any>;
    schema: Schema;
    table: string;
    fields: readonly string[];
    uniqueBy?: readonly string[];
    duplicates?: "error" | "skip";
    prefix?: string;
    maxRows?: number;
    batchSize?: number;
    maxJobs?: number;
    maxChunks?: number;
    maxStagedBytes?: number;
    reviewable?: ReviewableImportLimits;
    authorize?(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<Schema>;
    }, record: Readonly<Record<string, unknown>>, operation: "upload" | "apply"): boolean;
}
export interface DurableImportService {
    handle(request: Request): Promise<Response>;
    close(): void;
}
export interface DurableImportClient {
    create(name: string, key?: string): Promise<DurableImportJob>;
    inspect(id: string): Promise<DurableImportJob>;
    append(id: string, sequence: number, records: readonly Readonly<Record<string, unknown>>[]): Promise<DurableImportJob>;
    seal(id: string, chunks: number): Promise<DurableImportJob>;
    step(id: string, expectedProcessed: number): Promise<DurableImportJob>;
    retry(id: string): Promise<DurableImportJob>;
    cancel(id: string): Promise<DurableImportJob>;
    run(id: string, options?: {
        signal?: AbortSignal;
        progress?(job: DurableImportJob): void;
    }): Promise<DurableImportJob>;
    uploadCsv(file: Blob, columns: readonly CsvColumn[], options?: {
        id?: string;
        name?: string;
        signal?: AbortSignal;
        progress?(job: DurableImportJob): void;
    }): Promise<DurableImportJob>;
}
export interface ReviewableImportClient<Values = Record<string, unknown>> extends DurableImportClient {
    /** Stage immutable raw CSV; invalid values remain available for correction. Requires a currentUser getter. */
    uploadReviewableCsv(file: Blob, columns: readonly DurableImportColumn<Values>[], options?: {
        id?: string;
        key?: string;
        name?: string;
        signal?: AbortSignal;
        progress?(job: DurableImportJob): void;
    }): Promise<DurableImportJob>;
    sourceWindow(id: string, options?: {
        startRow?: number;
        limit?: number;
    }): Promise<DurableImportSourceWindow<Values>>;
    correctMapping(id: string, revision: number, columns: readonly DurableImportColumn<Values>[], operationId: string): Promise<DurableImportJob>;
    correctRows(id: string, revision: number, rows: readonly {
        row: number;
        values: Partial<Values>;
    }[], operationId: string): Promise<DurableImportJob>;
    preview(id: string): Promise<DurableImportPreview<Values>>;
    apply(preview: DurableImportPreview<Values>, operationId: string): Promise<DurableImportJob>;
}
/** Persist upload chunks and execution cursors beside target records; each bounded apply batch commits atomically. */
export declare function openDurableImport<Schema extends DatabaseSchema<any>>(options: DurableImportOptions<Schema>): Promise<DurableImportService>;
export interface DurableImportClientOptions extends SyncClientOptions {
    currentUser?(): string | null;
}
export declare function createDurableImportClient<Values = Record<string, unknown>>(options?: DurableImportClientOptions): ReviewableImportClient<Values>;
export declare function mountDurableImporter(container: HTMLElement, client: DurableImportClient, options: {
    columns: readonly CsvColumn[];
}): () => void;
/** Review immutable source rows, save mapping/value corrections, and explicitly accept each fenced batch. */
export declare function mountReviewableImporter<Values = Record<string, unknown>>(container: HTMLElement, client: ReviewableImportClient<Values>, options: {
    columns: readonly DurableImportColumn<Values>[];
    currentUser(): string | null;
}): () => void;
