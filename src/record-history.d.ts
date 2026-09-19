import type { AuthDefinition } from "./auth.js";
import type { DatabaseSchema, DocumentRevisionCursor, SyncClientOptions, WriteDatabase } from "./backend.js";
export interface RecordChange { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown; }
export interface RecordComparison { changes: readonly RecordChange[]; truncated: boolean; }
export interface HistoryEntry { cursor: DocumentRevisionCursor; operation: string; recordedAt: number; document: Readonly<Record<string, unknown>>; }
export interface HistoryPage { current: Readonly<Record<string, unknown>> | null; entries: readonly HistoryEntry[]; next: DocumentRevisionCursor | null; }
export interface RecordHistoryOptions { path: string; auth: AuthDefinition<any>; schema: DatabaseSchema<any>; tables: readonly string[]; prefix?: string; validateRestore?: (document: Readonly<Record<string, unknown>>, context: { table: string; db: WriteDatabase<any> }) => void; }
export interface RecordHistoryService { handle(request: Request): Promise<Response>; close(): void; }
export interface RecordHistoryClient { list(table: string, id: string, before?: DocumentRevisionCursor): Promise<HistoryPage>; restore(table: string, id: string, cursor: DocumentRevisionCursor, expectedVersion: number | null): Promise<unknown>; }

export declare function compareRecordVersions(before: unknown, after: unknown, maximum?: number): RecordComparison;
export declare function openRecordHistory(options: RecordHistoryOptions): Promise<RecordHistoryService>;
export declare function createRecordHistoryClient(options?: SyncClientOptions): RecordHistoryClient;
export declare function mountRecordHistory(container: HTMLElement, client: RecordHistoryClient, table: string, id: string): () => void;
