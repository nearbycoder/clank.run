import { type Cleanup, type ReactiveSignal } from "./core.js";
import { type InferSchema, type InferSchemaShape, type DocumentId, type Schema, type SchemaShape } from "./ai.js";
import { type AuthClient, type AuthDefinition, type AuthRequest, type AuthRuntime, type AuthState, type AuthUser, type DefaultAuthProfile } from "./auth.js";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.js";
import { type JobPublisher, type JobRuntime, type JobSystemDefinition, type OpenJobsOptions } from "./jobs.js";
/** A nominal document ID. At runtime this is a compact random string. */
export type Id<Table extends string> = DocumentId<Table>;
export type DocumentFor<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> = TableValue<Schema["tables"][Name]> & {
    _id: Id<Name>;
    _creationTime: number;
    _version: number;
} & (TableOwned<Schema["tables"][Name]> extends true ? {
    _ownerId: string;
} : {});
type IndexMap<Value extends object> = Record<string, readonly (keyof Value & string)[]>;
export interface TableDefinition<Value extends object, Indexes extends IndexMap<Value> = {}, Owned extends boolean = false> {
    readonly fields: SchemaShape;
    readonly schema: Schema<Value>;
    readonly indexes: Readonly<Record<string, readonly string[]>>;
    readonly ownership: Owned extends true ? "user" : "public";
    index<const Name extends string, const Fields extends readonly (keyof Value & string)[]>(name: Name, fields: Fields): TableDefinition<Value, Indexes & Record<Name, Fields>, Owned>;
    owned(): TableDefinition<Value, Indexes, true>;
}
export declare function defineTable<const Fields extends SchemaShape>(fields: Fields): TableDefinition<InferSchemaShape<Fields>>;
export interface DatabaseSchema<Tables extends Record<string, TableDefinition<any, any, any>>> {
    readonly tables: Tables;
}
export declare function defineDatabase<const Tables extends Record<string, TableDefinition<any, any, any>>>(tables: Tables): DatabaseSchema<Tables>;
export type TableName<Schema extends DatabaseSchema<any>> = keyof Schema["tables"] & string;
export type TableValue<Table> = Table extends TableDefinition<infer Value, any, any> ? Value : never;
export type TableIndexes<Table> = Table extends TableDefinition<any, infer Indexes, any> ? Indexes : never;
export type TableOwned<Table> = Table extends TableDefinition<any, any, infer Owned> ? Owned : false;
export type Comparison = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
type QueryField<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> = keyof DocumentFor<Schema, Name> & string;
export interface QueryBuilder<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> {
    where<Field extends QueryField<Schema, Name>>(field: Field, value: DocumentFor<Schema, Name>[Field]): QueryBuilder<Schema, Name>;
    where<Field extends QueryField<Schema, Name>>(field: Field, comparison: Comparison, value: DocumentFor<Schema, Name>[Field]): QueryBuilder<Schema, Name>;
    orderBy<Field extends QueryField<Schema, Name>>(field: Field, direction?: "asc" | "desc"): QueryBuilder<Schema, Name>;
    limit(count: number): QueryBuilder<Schema, Name>;
    collect(): Array<DocumentFor<Schema, Name>>;
    first(): DocumentFor<Schema, Name> | null;
}
export interface ReadTable<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> {
    get(id: Id<Name>): DocumentFor<Schema, Name> | null;
    query(): QueryBuilder<Schema, Name>;
    collect(): Array<DocumentFor<Schema, Name>>;
}
export interface WriteTable<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> extends ReadTable<Schema, Name> {
    insert(value: TableValue<Schema["tables"][Name]>): Id<Name>;
    patch(id: Id<Name>, value: Partial<TableValue<Schema["tables"][Name]>>, options?: DocumentWriteOptions): DocumentFor<Schema, Name> | null;
    replace(id: Id<Name>, value: TableValue<Schema["tables"][Name]>, options?: DocumentWriteOptions): DocumentFor<Schema, Name> | null;
    delete(id: Id<Name>, options?: DocumentWriteOptions): boolean;
}
export interface DocumentWriteOptions {
    /** Reject the write unless the stored document has this exact version. */
    ifVersion?: number;
}
export declare class DatabaseConflictError extends Error {
    readonly table: string;
    readonly id: string;
    readonly expectedVersion: number | null;
    readonly actualVersion: number | null;
    readonly name = "DatabaseConflictError";
    readonly code = "VERSION_CONFLICT";
    readonly status = 409;
    constructor(table: string, id: string, expectedVersion: number | null, actualVersion: number | null);
}
/**
 * A bounded, intentional application failure that is safe to expose through
 * browser RPC and MCP tool responses.
 */
export declare class BackendActionError extends Error {
    readonly status: 400 | 404 | 409;
    readonly code: string;
    readonly name = "BackendActionError";
    constructor(status: 400 | 404 | 409, code: string, message: string);
}
export interface ReadDatabase<Schema extends DatabaseSchema<any>> {
    table<Name extends TableName<Schema>>(name: Name): ReadTable<Schema, Name>;
}
export interface WriteDatabase<Schema extends DatabaseSchema<any>> extends ReadDatabase<Schema> {
    table<Name extends TableName<Schema>>(name: Name): WriteTable<Schema, Name>;
}
export interface DatabaseChangeRecord {
    readonly table: string;
    readonly id: string;
    readonly ownerId?: string | null;
}
export interface DatabaseChange {
    readonly version: number;
    readonly records: readonly DatabaseChangeRecord[];
    readonly tables: ReadonlySet<string>;
    readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
    readonly all?: boolean;
}
interface ReadDependency {
    table: string;
    id?: string;
    ownerId?: string | null;
}
export interface TrackedResult<Value> {
    value: Value;
    dependencies: readonly ReadDependency[];
    version: number;
}
interface StatementLike {
    all(...parameters: any[]): Array<Record<string, unknown>>;
    get(...parameters: any[]): Record<string, unknown> | undefined;
    run(...parameters: any[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
}
interface DatabaseSyncLike {
    exec(sql: string): void;
    prepare(sql: string): StatementLike;
    close(): void;
    enableLoadExtension?(allow: boolean): void;
}
export interface SQLiteOptions {
    path?: string;
    wal?: boolean;
    busyTimeout?: number;
    durability?: "full" | "normal";
    integrityCheck?: "quick" | "full" | false;
    changePollIntervalMs?: number;
    changeRetentionRevisions?: number;
    onError?: (error: unknown) => void;
}
export interface SQLiteDatabase<Schema extends DatabaseSchema<any>> {
    readonly schema: Schema;
    readonly version: number;
    read<Value>(handler: (db: ReadDatabase<Schema>) => Value, scope?: DatabaseScope): Value;
    tracked<Value>(handler: (db: ReadDatabase<Schema>) => Value, scope?: DatabaseScope): TrackedResult<Value>;
    transaction<Value>(handler: (db: WriteDatabase<Schema>) => Value, scope?: DatabaseScope): Value;
    subscribe(listener: (change: DatabaseChange) => void): Cleanup;
    close(): void;
    /** @internal Used by Clank's own zero-dependency services. */
    readonly [SQLITE_INTERNAL]: SQLiteInternal;
}
export interface DatabaseScope {
    /** `undefined` is trusted/unscoped server access; `null` is anonymous access. */
    userId?: string | null;
}
export declare function openSQLite<Schema extends DatabaseSchema<any>>(schema: Schema, options?: SQLiteOptions): Promise<SQLiteDatabase<Schema>>;
/** Accepts a compatible SQLite connection; useful for alternate runtimes and deterministic tests. */
export declare function createSQLiteDatabase<Schema extends DatabaseSchema<any>>(schema: Schema, native: DatabaseSyncLike, options?: SQLiteOptions): SQLiteDatabase<Schema>;
export type FunctionArgs = Schema<any> | SchemaShape;
export type InferFunctionArgs<Args extends FunctionArgs> = Args extends Schema<any> ? InferSchema<Args> : Args extends SchemaShape ? InferSchemaShape<Args> : never;
export interface QueryContext<DB extends DatabaseSchema<any>> {
    db: ReadDatabase<DB>;
}
export interface MutationContext<DB extends DatabaseSchema<any>, Jobs extends JobSystemDefinition<DB, any> | undefined = undefined> {
    db: WriteDatabase<DB>;
}
type MutationJobsContext<DB extends DatabaseSchema<any>, Jobs extends JobSystemDefinition<DB, any> | undefined> = Jobs extends JobSystemDefinition<DB, any> ? {
    jobs: JobPublisher<Jobs>;
} : {};
export type BackendAccess = "public" | "required";
type AuthProfileOf<Auth> = Auth extends AuthDefinition<infer Profile> ? Profile : DefaultAuthProfile;
type DefaultAccessOf<Auth> = Auth extends AuthDefinition<any> ? "required" : "public";
export interface BackendAgentOptions {
    enabled?: boolean;
    title?: string;
    description?: string;
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
}
export type BackendContext<Kind extends "query" | "mutation", DB extends DatabaseSchema<any>, Auth extends AuthDefinition<any> | undefined, Access extends BackendAccess, Jobs extends JobSystemDefinition<DB, any> | undefined = undefined> = (Kind extends "query" ? QueryContext<DB> : MutationContext<DB, Jobs> & MutationJobsContext<DB, Jobs>) & (Auth extends AuthDefinition<any> ? {
    auth: AuthRequest<AuthProfileOf<Auth>>;
    user: Access extends "required" ? AuthUser<AuthProfileOf<Auth>> : AuthUser<AuthProfileOf<Auth>> | null;
} : {});
export interface BackendFunction<Kind extends "query" | "mutation", Input, Output, DB extends DatabaseSchema<any>, Access extends BackendAccess = "public", Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<DB, any> | undefined = undefined> {
    readonly kind: Kind;
    readonly access: Access;
    readonly args: Schema<Input>;
    readonly returns?: Schema<Output>;
    readonly description?: string;
    readonly agent: false | Readonly<BackendAgentOptions>;
    readonly handler: (context: BackendContext<Kind, DB, Auth, Access, Jobs>, args: Input) => Output;
}
export type AnyBackendFunction = BackendFunction<"query" | "mutation", any, any, any, any, any, any>;
export type FunctionTree = {
    readonly [key: string]: AnyBackendFunction | FunctionTree;
};
export interface FunctionBuilders<DB extends DatabaseSchema<any>, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<DB, any> | undefined = undefined> {
    query<const Args extends FunctionArgs, Output>(definition: {
        args: Args;
        description?: string;
        returns?: Schema<Output>;
        agent?: false | BackendAgentOptions;
        handler: (context: BackendContext<"query", DB, Auth, DefaultAccessOf<Auth>, Jobs>, args: InferFunctionArgs<Args>) => Output;
    }): BackendFunction<"query", InferFunctionArgs<Args>, Output, DB, DefaultAccessOf<Auth>, Auth, Jobs>;
    mutation<const Args extends FunctionArgs, Output>(definition: {
        args: Args;
        description?: string;
        returns?: Schema<Output>;
        agent?: false | BackendAgentOptions;
        handler: (context: BackendContext<"mutation", DB, Auth, DefaultAccessOf<Auth>, Jobs>, args: InferFunctionArgs<Args>) => Output;
    }): BackendFunction<"mutation", InferFunctionArgs<Args>, Output, DB, DefaultAccessOf<Auth>, Auth, Jobs>;
    publicQuery<const Args extends FunctionArgs, Output>(definition: {
        args: Args;
        description?: string;
        returns?: Schema<Output>;
        agent?: false | BackendAgentOptions;
        handler: (context: BackendContext<"query", DB, Auth, "public", Jobs>, args: InferFunctionArgs<Args>) => Output;
    }): BackendFunction<"query", InferFunctionArgs<Args>, Output, DB, "public", Auth, Jobs>;
    publicMutation<const Args extends FunctionArgs, Output>(definition: {
        args: Args;
        description?: string;
        returns?: Schema<Output>;
        agent?: false | BackendAgentOptions;
        handler: (context: BackendContext<"mutation", DB, Auth, "public", Jobs>, args: InferFunctionArgs<Args>) => Output;
    }): BackendFunction<"mutation", InferFunctionArgs<Args>, Output, DB, "public", Auth, Jobs>;
}
export interface BackendDefinition<Schema extends DatabaseSchema<any>, Functions extends FunctionTree, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<Schema, any> | undefined = undefined> {
    readonly schema: Schema;
    readonly functions: Functions;
    readonly auth: Auth;
    readonly jobs: Jobs;
}
export interface BackendBuilder<Schema extends DatabaseSchema<any>, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<Schema, any> | undefined = undefined> {
    functions<const Functions extends FunctionTree>(define: (builders: FunctionBuilders<Schema, Auth, Jobs>) => Functions): BackendDefinition<Schema, Functions, Auth, Jobs>;
}
export declare function defineBackend<Schema extends DatabaseSchema<any>, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<Schema, any> | undefined = undefined>(options: {
    schema: Schema;
    auth?: Auth;
    jobs?: Jobs;
}): BackendBuilder<Schema, Auth, Jobs>;
export interface FunctionReference<Kind extends "query" | "mutation", Input, Output> {
    readonly kind: Kind;
    readonly path: string;
    readonly __input?: Input;
    readonly __output?: Output;
}
export type ApiOf<Tree> = {
    readonly [Key in keyof Tree]: Tree[Key] extends BackendFunction<infer Kind, infer Input, infer Output, any, any, any, any> ? FunctionReference<Kind, Input, Output> : Tree[Key] extends object ? ApiOf<Tree[Key]> : never;
};
export declare function functionPath(reference: FunctionReference<any, any, any>): string;
/** Creates a zero-codegen typed API proxy. Pass a server function tree as its type argument. */
type FunctionsFrom<Source> = Source extends {
    readonly functions: infer Functions extends FunctionTree;
} ? Functions : Source;
export declare function createApi<Source extends FunctionTree | BackendDefinition<any, any, any, any>>(): ApiOf<FunctionsFrom<Source>>;
type InputOf<Reference> = Reference extends FunctionReference<any, infer Input, any> ? Input : never;
type OutputOf<Reference> = Reference extends FunctionReference<any, any, infer Output> ? Output : never;
type InputTuple<Input> = {} extends Input ? [args?: Input] : [args: Input];
export interface LiveQuery<Value> {
    readonly data: ReactiveSignal<Value | undefined>;
    readonly error: ReactiveSignal<unknown>;
    readonly loading: ReactiveSignal<boolean>;
    readonly version: ReactiveSignal<number>;
    dispose(): void;
}
export interface SyncClient {
    query<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): Promise<OutputOf<Reference>>;
    mutate<Reference extends FunctionReference<"mutation", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): Promise<OutputOf<Reference>>;
    live<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): LiveQuery<OutputOf<Reference>>;
    seed<Reference extends FunctionReference<"query", any, any>>(reference: Reference, args: InputOf<Reference>, value: OutputOf<Reference>, version?: number): void;
}
interface EventSourceLike {
    onmessage: ((event: {
        data: string;
        lastEventId?: string;
    }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close(): void;
}
export interface SyncClientOptions {
    url?: string;
    fetch?: typeof fetch;
    eventSource?: new (url: string, options?: {
        withCredentials?: boolean;
    }) => EventSourceLike;
    auth?: Pick<AuthClient<any>, "csrfHeader">;
}
export declare class BackendClientError extends Error {
    readonly code: string;
    readonly status: number;
    readonly name = "BackendClientError";
    constructor(code: string, message: string, status: number);
}
export declare function createSyncClient(options?: SyncClientOptions): SyncClient;
type AuthDefinitionOf<Source> = Source extends BackendDefinition<any, any, infer Auth, any> ? Auth : undefined;
export interface ClankClientOptions<Profile extends object = DefaultAuthProfile> extends Omit<SyncClientOptions, "auth"> {
    initialAuth?: AuthState<Profile>;
    authPrefix?: string;
    loadAuth?: boolean;
}
export type ClankClient<Source extends BackendDefinition<any, any, AuthDefinition<any>, any>> = SyncClient & {
    readonly api: ApiOf<FunctionsFrom<Source>>;
    readonly auth: AuthClient<AuthProfileOf<AuthDefinitionOf<Source>>>;
};
/**
 * Creates the complete browser client for a backend definition: typed API
 * references, auth state, CSRF-aware mutations, cache seeding, and live queries.
 */
export declare function createClient<Source extends BackendDefinition<any, any, AuthDefinition<any>, any>>(options?: ClankClientOptions<AuthProfileOf<AuthDefinitionOf<Source>>>): ClankClient<Source>;
export interface BackendCaller<Profile extends object = DefaultAuthProfile> {
    readonly auth: AuthRequest<Profile> | null;
    query<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): {
        value: OutputOf<Reference>;
        version: number;
    };
    query(path: string, input: unknown): {
        value: unknown;
        version: number;
    };
    mutation<Reference extends FunctionReference<"mutation", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): {
        value: OutputOf<Reference>;
        version: number;
    };
    mutation(path: string, input: unknown): {
        value: unknown;
        version: number;
    };
    subscribe<Reference extends FunctionReference<"query", any, any>>(reference: Reference, args: InputOf<Reference>, listener: (value: OutputOf<Reference>, version: number) => void): Cleanup;
    subscribe(path: string, input: unknown, listener: (value: unknown, version: number) => void): Cleanup;
}
export interface BackendRuntime<Schema extends DatabaseSchema<any>, Functions extends FunctionTree, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<Schema, any> | undefined = undefined> {
    readonly definition: BackendDefinition<Schema, Functions, Auth, Jobs>;
    readonly database: SQLiteDatabase<Schema>;
    readonly auth: Auth extends AuthDefinition<infer Profile> ? AuthRuntime<Profile> : undefined;
    readonly jobs: Jobs extends JobSystemDefinition<Schema, any> ? JobRuntime<Jobs> : undefined;
    readonly version: number;
    readonly contractRevision: string | null;
    query<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): {
        value: OutputOf<Reference>;
        version: number;
    };
    query(path: string, input: unknown): {
        value: unknown;
        version: number;
    };
    mutation<Reference extends FunctionReference<"mutation", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): {
        value: OutputOf<Reference>;
        version: number;
    };
    mutation(path: string, input: unknown): {
        value: unknown;
        version: number;
    };
    subscribe<Reference extends FunctionReference<"query", any, any>>(reference: Reference, args: InputOf<Reference>, listener: (value: OutputOf<Reference>, version: number) => void): Cleanup;
    subscribe(path: string, input: unknown, listener: (value: unknown, version: number) => void): Cleanup;
    caller(request: Request): Promise<BackendCaller<AuthProfileOf<Auth>>>;
    handle(request: Request): Promise<Response>;
    close(): void;
}
export interface OpenBackendOptions extends SQLiteOptions {
    database?: SQLiteDatabase<any>;
    prefix?: string;
    verifyOrigin?: boolean;
    allowedOrigins?: readonly string[];
    heartbeat?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    maxLiveArgumentBytes?: number;
    maxLivePayloadBytes?: number;
    maxLiveConnections?: number;
    maxCacheEntries?: number;
    onError?: (error: unknown) => void;
    jobs?: Omit<OpenJobsOptions, "database">;
    agent?: false | {
        name?: string;
        title?: string;
        version?: string;
        description?: string;
        instructions?: string;
        mcpPath?: string;
        oauthPrefix?: string;
        /** Maximum simultaneously active OAuth grants for one application user. Defaults to 100. */
        maxUserGrants?: number;
    };
}
export declare function openBackend<Schema extends DatabaseSchema<any>, Functions extends FunctionTree, Auth extends AuthDefinition<any> | undefined = undefined, Jobs extends JobSystemDefinition<Schema, any> | undefined = undefined>(definition: BackendDefinition<Schema, Functions, Auth, Jobs>, options?: OpenBackendOptions): Promise<BackendRuntime<Schema, Functions, Auth, Jobs>>;
export declare function functionKey(path: string, args: unknown): string;
export declare function stableStringify(value: unknown): string;
export {};
