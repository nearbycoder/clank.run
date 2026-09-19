import type { AuthDefinition } from "./auth.js";
import type { DatabaseSchema, DocumentRevisionCursor, SyncClientOptions, WriteDatabase } from "./backend.js";
export interface TrashItem { id: string; table: string; label: string; deletedAt: number; expiresAt: number; cursor: DocumentRevisionCursor; }
export interface TrashPage { items: readonly TrashItem[]; next: DocumentRevisionCursor | null; }
export interface RecycleBinOptions { path: string; auth: AuthDefinition<any>; schema: DatabaseSchema<any>; tables: Readonly<Record<string, { labelField: string }>>; retentionMs?: number; prefix?: string; historyRetentionRevisions?: number; validateRestore?: (document: Readonly<Record<string, unknown>>, context: { table: string; db: WriteDatabase<any> }) => void; }
export interface RecycleBinService { handle(request: Request): Promise<Response>; purgeExpired(limit?: number): number; close(): void; }
export interface RecycleBinClient {
  list(table: string, before?: DocumentRevisionCursor): Promise<TrashPage>;
  trash(table: string, id: string, expectedVersion: number): Promise<boolean>;
  restore(table: string, id: string, cursor: DocumentRevisionCursor): Promise<unknown>;
  purge(table: string, id: string, cursor: DocumentRevisionCursor): Promise<boolean>;
}
export declare function openRecycleBin(options: RecycleBinOptions): Promise<RecycleBinService>;
export declare function createRecycleBinClient(options?: SyncClientOptions): RecycleBinClient;
export declare function mountRecycleBin(container: HTMLElement, client: RecycleBinClient, table: string): () => void;
