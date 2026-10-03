import type { DatabaseSchema, ReadDatabase, SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export interface BulkEditRecord { readonly id: string; readonly version: number; readonly before: Readonly<Record<string, unknown>>; readonly after: Readonly<Record<string, unknown>>; }
export interface BulkEditPreview { readonly changes: Readonly<Record<string, unknown>>; readonly records: readonly BulkEditRecord[]; }
export interface BulkEditOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema: Schema; table: string; fields: readonly string[]; prefix?: string; maxRecords?: number;
  /** Synchronous current ACL check inside the same transaction as reads/writes. */
  authorize?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Readonly<Record<string, unknown>>, operation: "preview" | "apply"): boolean;
}
export interface BulkEditService { handle(request: Request): Promise<Response>; close(): void; }
export interface BulkEditClient { preview(ids: readonly string[], changes: Readonly<Record<string, unknown>>): Promise<BulkEditPreview>; apply(preview: BulkEditPreview): Promise<{ updated: number }>; }

export declare function openBulkEditor<Schema extends DatabaseSchema<any>>(options: BulkEditOptions<Schema>): Promise<BulkEditService>;
export declare function createBulkEditClient(options?: SyncClientOptions): BulkEditClient;
export declare function mountBulkEditor(container: HTMLElement, client: BulkEditClient, options: { selection(): readonly string[]; changes(): Readonly<Record<string, unknown>>; applied?(count: number): void }): () => void;
