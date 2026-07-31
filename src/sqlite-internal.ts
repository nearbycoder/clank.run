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
  /** True only while this database instance owns a write transaction. */
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  transaction<Value>(handler: (changes: SQLiteInternalChangeRecorder) => Value): Value;
}
