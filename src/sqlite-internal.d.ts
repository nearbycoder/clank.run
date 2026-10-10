export declare const SQLITE_INTERNAL: unique symbol;
/** Available only during an accepted reviewed action's synchronous transaction. */
export declare function currentReviewedExecution(connection: SQLiteInternal): { requester: string; approver: string; planId: string } | undefined;
export declare function withReviewedExecution<Value>(connection: SQLiteInternal, identity: { requester: string; approver: string; planId: string }, handler: () => Value): Value;
/** Fixed history predicate for every upgraded writer's automatic cleanup. */
export declare function retentionHistoryProtection(connection: Pick<SQLiteInternal, "prepare">): string;
/** Count held source history without materializing payloads; shared admission bound. */
export declare function retentionHistoryUsage(connection: Pick<SQLiteInternal, "prepare">, protection?: string, now?: number): { records: number; bytes: number };
export interface SQLiteStatement {
    all(...parameters: any[]): Array<Record<string, unknown>>;
    get(...parameters: any[]): Record<string, unknown> | undefined;
    run(...parameters: any[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
}
export interface SQLiteInternalChangeRecorder {
    record(table: string, id: string, ownerId?: string | null): void;
}
export interface SQLiteInternal {
    /** Install once, after schema bootstrap and before admitting requests. */
    captureTransactions?(factory: (connection: SQLiteCaptureConnection) => SQLiteTransactionCapture): void;
    /** True only while this database instance owns a write transaction. */
    readonly inTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
    transaction<Value>(handler: (changes: SQLiteInternalChangeRecorder) => Value): Value;
    /** Re-scope reads inside an active transaction for independent participant/approval authorization. */
    readScoped<Value>(userId: string | null, handler: (db: import("./backend.js").ReadDatabase<any>) => Value): Value;
    /** Re-scope generated metadata writes after independent current operator authorization. */
    writeScoped<Value>(userId: string | null, handler: (db: import("./backend.js").WriteDatabase<any>) => Value): Value;
    /** Capture selective dependencies inside the current write transaction. */
    readTrackedScoped<Value>(userId: string | null, handler: (db: import("./backend.js").ReadDatabase<any>) => Value): import("./backend.js").TrackedResult<Value>;
    /** Retire persisted and pending snapshots of a record deleted in this write transaction. */
    purgeDeletedHistory(table: string, id: string): void;
}
/** Every upgraded source writer consults persisted holds, including preopened connections. */
export declare function isRetentionHeld(connection: Pick<SQLiteInternal, "prepare">, kind: "import" | "collaboration" | "audit", id: string, now?: number): boolean;
/** Internal hook used by the point-in-time journal. All callbacks are synchronous. */
export interface SQLiteCaptureConnection {
    readonly path: string;
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
    createSession(options: {
        table?: string;
    }): {
        changeset(): Uint8Array;
        close(): void;
    };
}
export interface SQLiteTransactionCapture {
    before(): void;
    commit(): void;
    after(): void;
    close(): void;
}
/** Persisted, bounded source projection. No callbacks or SQL from a binding. */
export interface SQLiteSearchBinding {
    version: 1;
    name: string;
    table: string;
    title: string;
    body: string;
    scope: "owner" | {
        field: string;
    };
    owned: boolean;
    maxRecords: number;
    maxBytes: number;
    maxScopeRecords: number;
}
type SearchConnection = Pick<SQLiteInternal, "exec" | "prepare">;
export declare const SOURCE_SEARCH_FTS = "clank_source_search_fts";
export declare function bootstrapSourceSearch(connection: SearchConnection): void;
export declare function bootstrapSourceSearchFTS(connection: SearchConnection): void;
export declare function parseSearchBinding(value: string): SQLiteSearchBinding;
export declare function sourceSearchTable(binding: SQLiteSearchBinding): string;
export declare function searchSourceRecord(binding: SQLiteSearchBinding, row: Record<string, unknown>): {
    id: string;
    scope: string;
    title: string;
    body: string;
    version: number;
    bytes: number;
};
export declare function sourceSearchMatches(binding: SQLiteSearchBinding, source: Record<string, unknown> | undefined, indexed: Record<string, unknown> | undefined): boolean;
export declare function projectSearchRecord(connection: SearchConnection, binding: SQLiteSearchBinding, id: string): void;
/** Called before commit for every upgraded writer, even one opened before registration. */
export declare function updateSourceSearch(connection: SearchConnection, records: Iterable<{
    table: string;
    id: string;
}>): void;
export {};
