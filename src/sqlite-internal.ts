export const SQLITE_INTERNAL = Symbol.for("clank.sqlite.internal");

export interface SQLiteStatement {
  all(...parameters: any[]): Array<Record<string, unknown>>;
  get(...parameters: any[]): Record<string, unknown> | undefined;
  run(...parameters: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
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
  /** Re-scope reads inside an existing write transaction for independent approval authorization. */
  readScoped<Value>(userId: string | null, handler: (db: import("./backend.ts").ReadDatabase<any>) => Value): Value;
  /** Capture selective dependencies inside the current write transaction. */
  readTrackedScoped<Value>(userId: string | null, handler: (db: import("./backend.ts").ReadDatabase<any>) => Value): import("./backend.ts").TrackedResult<Value>;
  /** Retire persisted and pending snapshots of a record deleted in this write transaction. */
  purgeDeletedHistory(table: string, id: string): void;
}

/** Internal hook used by the point-in-time journal. All callbacks are synchronous. */
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
