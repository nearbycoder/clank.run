import type { DatabaseSchema, ReadDatabase, SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
import type { CsvColumn } from "./csv-import.js";
export type DurableImportState = "uploading" | "ready" | "running" | "failed" | "cancelled" | "completed";
export interface DurableImportIssue { readonly row: number; readonly code: "INVALID_ROW" | "FORBIDDEN" | "DUPLICATE"; }
export interface DurableImportJob { readonly id: string; readonly name: string; readonly state: DurableImportState; readonly uploadedRows: number; readonly processedRows: number; readonly insertedRows: number; readonly skippedRows: number; readonly chunks: number; readonly issues: readonly DurableImportIssue[]; }
export interface DurableImportOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema: Schema; table: string; fields: readonly string[]; uniqueBy?: readonly string[]; duplicates?: "error" | "skip"; prefix?: string; maxRows?: number; batchSize?: number;
  authorize?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Readonly<Record<string, unknown>>, operation: "upload" | "apply"): boolean;
}
export interface DurableImportService { handle(request: Request): Promise<Response>; close(): void; }
export interface DurableImportClient {
  create(name: string, key?: string): Promise<DurableImportJob>;
  inspect(id: string): Promise<DurableImportJob>;
  append(id: string, sequence: number, records: readonly Readonly<Record<string, unknown>>[]): Promise<DurableImportJob>;
  seal(id: string, chunks: number): Promise<DurableImportJob>;
  step(id: string, expectedProcessed: number): Promise<DurableImportJob>;
  retry(id: string): Promise<DurableImportJob>;
  cancel(id: string): Promise<DurableImportJob>;
  run(id: string, options?: { signal?: AbortSignal; progress?(job: DurableImportJob): void }): Promise<DurableImportJob>;
  uploadCsv(file: Blob, columns: readonly CsvColumn[], options?: { id?: string; name?: string; signal?: AbortSignal; progress?(job: DurableImportJob): void }): Promise<DurableImportJob>;
}

export declare function openDurableImport<Schema extends DatabaseSchema<any>>(options: DurableImportOptions<Schema>): Promise<DurableImportService>;
export declare function createDurableImportClient(options?: SyncClientOptions): DurableImportClient;
export declare function mountDurableImporter(container: HTMLElement, client: DurableImportClient, options: { columns: readonly CsvColumn[] }): () => void;
