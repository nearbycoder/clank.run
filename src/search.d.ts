import type { DatabaseSchema, ReadDatabase, SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export interface SearchRecord { readonly scope: string; readonly id: string; readonly title: string; readonly body: string; }
export interface SearchHit { readonly id: string; readonly title: string; readonly snippet: string; readonly score: number; }
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly total: number; readonly truncated: boolean; }
export interface SearchOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCandidates?: number; maxScopeRecords?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, scope: string): boolean;
  /** Optional synchronous per-record policy, evaluated before ranking or snippet creation. */
  authorizeRecord?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Pick<SearchRecord, "scope" | "id">): boolean;
}
export interface SearchService {
  handle(request: Request): Promise<Response>;
  /** Trusted server-only indexing; never exposed as an HTTP mutation. */
  upsert(record: SearchRecord): void;
  remove(scope: string, id: string): boolean;
  close(): void;
}
export interface SearchClient { search(scope: string, text: string, limit?: number): Promise<SearchResult>; }

export declare function openSearch<Schema extends DatabaseSchema<any>>(options: SearchOptions<Schema>): Promise<SearchService>;
export declare function createSearchClient(options?: SyncClientOptions): SearchClient;
export declare function mountSearch(container: HTMLElement, client: SearchClient, options: { scope(): string; open(id: string): void }): () => void;
