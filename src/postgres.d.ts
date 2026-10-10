import { type ApplicationDatabase, type DatabaseSchema } from "./backend.js";
export interface PostgresOptions {
    host: string;
    port?: number;
    database: string;
    user: string;
    /** Printable ASCII SCRAM password; Unicode SASLprep is not supported. */
    password: string;
    /** Verified TLS is the default. Plaintext requires the literal 127.0.0.1 or ::1. */
    tls?: {
        ca?: string;
        serverName?: string;
    } | "loopback";
    /** Separate application data from other applications. Never a SQL identifier. */
    namespace?: string;
    /** Per-operation deadline, 100–30000 ms. Default 5000. */
    timeoutMs?: number;
    /** 1–10000 returned rows, default 1000. */
    maxRows?: number;
    /** 64 KiB–16 MiB, default 4 MiB. Includes the worker response. */
    maxResponseBytes?: number;
    /** 1–1000 changed documents per transaction, default 100. */
    maxWrites?: number;
    /** Retained global change revisions, 1–100000. Default 10000. */
    changeRetentionRevisions?: number;
    /** External revision polling, 0 disables; otherwise 100–60000 ms. */
    changePollIntervalMs?: number;
    onError?: (error: unknown) => void;
}
export declare class PostgresError extends Error {
    readonly name = "PostgresError";
    readonly code: string;
    readonly sqlState?: string;
    constructor(code: string, sqlState?: string);
}
export interface PostgresDatabase<Schema extends DatabaseSchema<any>> extends ApplicationDatabase<Schema> {
    readonly dialect: "postgres";
    /** History, aggregates and SQLite-native services are explicitly unsupported. */
    readonly unsupported: readonly ["history", "aggregate", "sqlite-services"];
    /** Reopen a poisoned session without replaying an earlier transaction. */
    reconnect(): Promise<void>;
}
/** Open the proposed PostgreSQL application subset; SQLite services stay separate. */
export declare function openPostgres<Schema extends DatabaseSchema<any>>(schema: Schema, options: PostgresOptions): Promise<PostgresDatabase<Schema>>;
