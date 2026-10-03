export declare const SQLITE_INTERNAL: unique symbol;
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
    captureTransactions?(factory: (connection: SQLiteCaptureConnection) => SQLiteTransactionCapture): void;
    readonly inTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
    transaction<Value>(handler: (changes: SQLiteInternalChangeRecorder) => Value): Value;
    readScoped<Value>(userId: string | null, handler: (db: import("./backend.js").ReadDatabase<any>) => Value): Value;
}

export interface SQLiteCaptureConnection {
    readonly path: string;
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
    createSession(options: { table?: string }): { changeset(): Uint8Array; close(): void };
}
export interface SQLiteTransactionCapture {
    before(): void;
    commit(): void;
    after(): void;
    close(): void;
}
