import { type DatabaseSchema, type ReadDatabase, type SyncClientOptions, type TableName, type TableValue, type TableOwned } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export interface SearchRecord {
    readonly scope: string;
    readonly id: string;
    readonly title: string;
    readonly body: string;
}
export interface SearchHit {
    readonly id: string;
    readonly title: string;
    readonly snippet: string;
    readonly score: number;
}
export interface SearchResult {
    readonly hits: readonly SearchHit[];
    readonly total: number;
    readonly truncated: boolean;
}
export interface SearchOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
    path: string;
    auth: AuthDefinition<any>;
    schema?: Schema;
    prefix?: string;
    maxCandidates?: number;
    maxScopeRecords?: number;
    source?: never;
    browsing?: never;
    authorize(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<Schema>;
    }, scope: string): boolean;
    /** Optional synchronous per-record policy, evaluated before ranking or snippet creation. */
    authorizeRecord?(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<Schema>;
    }, record: Pick<SearchRecord, "scope" | "id">): boolean;
}
type StringField<Value> = {
    [Key in keyof Value & string]: Value[Key] extends string ? Key : never;
}[keyof Value & string];
export type SearchSource<Schema extends DatabaseSchema<any>> = {
    [Name in TableName<Schema>]: {
        name: string;
        table: Name;
        title: StringField<TableValue<Schema["tables"][Name]>>;
        body: StringField<TableValue<Schema["tables"][Name]>>;
        maxRecords?: number;
        maxBytes?: number;
        facets?: readonly ScalarField<TableValue<Schema["tables"][Name]>>[];
    } & (TableOwned<Schema["tables"][Name]> extends true ? {
        scope: "owner";
    } : {
        scope: {
            field: StringField<TableValue<Schema["tables"][Name]>>;
        };
    });
}[TableName<Schema>];
export interface SourceSearchOptions<Schema extends DatabaseSchema<any>> extends Omit<SearchOptions<Schema>, "schema" | "source" | "browsing"> {
    schema: Schema;
    source: SearchSource<Schema>;
    browsing?: SearchBrowsingOptions;
}
export interface SearchRebuildProgress {
    readonly generation: string;
    readonly revision: number;
    readonly status: "building" | "ready";
    readonly cursor: string;
    readonly processed: number;
}
export interface SearchIndexDiagnostic extends SearchRebuildProgress {
    readonly indexedRecords: number;
    readonly indexedBytes: number;
    readonly scanned: number;
    readonly missing: number;
    readonly stale: number;
    readonly orphan: number;
    readonly duplicate: number;
    readonly nextCursor: string | null;
}
export interface SourceSearchService {
    handle(request: Request): Promise<Response>;
    /** Trusted server-only. Omit ifRevision to resume; supply a current ready revision to start repair. */
    rebuild(options?: {
        batchSize?: number;
        ifRevision?: number;
    }): SearchRebuildProgress;
    /** Trusted server-only, bounded diagnosis; no source values are returned. */
    inspect(options?: {
        cursor?: string;
        limit?: number;
    }): SearchIndexDiagnostic;
    /** Drain writers first. A generation fence prevents detaching a replacement binding. */
    detach(ifGeneration: string): void;
    close(): void;
}
export interface SearchService {
    handle(request: Request): Promise<Response>;
    /** Trusted server-only indexing; never exposed as an HTTP mutation. */
    upsert(record: SearchRecord): void;
    remove(scope: string, id: string): boolean;
    close(): void;
}
export interface SearchClient {
    search(scope: string, text: string, limit?: number): Promise<SearchResult>;
}
export type SearchFacetValue = string | number | boolean | null;
type ScalarField<Value> = {
    [Key in keyof Value & string]: Exclude<Value[Key], undefined> extends SearchFacetValue ? Key : never;
}[keyof Value & string];
export interface SearchFilter {
    readonly field: string;
    readonly value: SearchFacetValue;
}
export interface SearchDefinition {
    readonly text: string;
    readonly filters: readonly SearchFilter[];
    readonly sort: "relevance" | "title";
}
export interface SearchFacet {
    readonly field: string;
    readonly values: readonly {
        readonly value: SearchFacetValue;
        readonly count: number;
    }[];
}
export interface SearchPage {
    readonly hits: readonly SearchHit[];
    readonly total: number;
    readonly facets: readonly SearchFacet[];
    readonly nextCursor: string | null;
    readonly revision: number;
}
export interface SavedSearch {
    readonly key: string;
    readonly name: string;
    readonly revision: number;
    readonly usable: boolean;
    readonly definition: SearchDefinition | null;
}
export interface SearchDeletion {
    readonly key: string;
    readonly revision: number;
    readonly deleted: true;
}
export interface SearchBrowsingOptions {
    /** Change when record/scope policy semantics change. */
    policyRevision: string;
    /** Live definitions per account, scope and index, default 50, maximum 200. */
    maxSavedSearches?: number;
    /** Includes compact deleted identities; default 10,000, maximum 50,000. */
    maxSavedIdentities?: number;
    /** Includes definition payloads and retry fingerprints; default 16 MiB, maximum 64 MiB. */
    maxSavedBytes?: number;
}
export interface SearchBrowsingClient extends SearchClient {
    browse(scope: string, definition: SearchDefinition, options?: {
        limit?: number;
        cursor?: string;
    }): Promise<SearchPage>;
    saved(scope: string): Promise<readonly SavedSearch[]>;
    save(scope: string, input: {
        key: string;
        expectedRevision: number;
        name: string;
        definition: SearchDefinition;
    }): Promise<SavedSearch>;
    removeSaved(scope: string, key: string, expectedRevision: number): Promise<SearchDeletion>;
}
/** Durable SQLite FTS candidates, current scope/record authorization, then authorized-only ranking. */
export declare function openSearch<Schema extends DatabaseSchema<any>>(options: SourceSearchOptions<Schema>): Promise<SourceSearchService>;
export declare function openSearch<Schema extends DatabaseSchema<any>>(options: SearchOptions<Schema>): Promise<SearchService>;
export declare function createSearchClient(options?: SyncClientOptions): SearchClient;
export declare function mountSearch(container: HTMLElement, client: SearchClient, options: {
    scope(): string;
    open(id: string): void;
}): () => void;
export declare function createSearchBrowsingClient(options?: SyncClientOptions): SearchBrowsingClient;
/** Account-aware controls for authorized facets, pinned paging and saved searches. */
export declare function mountSearchBrowsing(container: HTMLElement, options: {
    client: SearchBrowsingClient;
    currentUser(): string | null;
    scope(): string;
    fields: readonly string[];
    open(id: string): void;
    pageSize?: number;
}): () => void;
export {};
