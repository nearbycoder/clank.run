import type { InferSchema, InferSchemaShape, Schema, SchemaShape } from "./ai.js";
import type { SQLiteDatabase } from "./backend.js";
import type { Cleanup } from "./core.js";
import type { McpTool } from "./mcp.js";

export type DurableObjectArgs = Schema<any> | SchemaShape;
export type InferDurableObjectArgs<Args extends DurableObjectArgs> = Args extends Schema<any>
  ? InferSchema<Args>
  : Args extends SchemaShape
    ? InferSchemaShape<Args>
    : never;
export type DurableObjectMethodKind = "query" | "mutation";

export interface DurableObjectAgentOptions {
  title?: string;
  description?: string;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}
export interface DurableObjectInitialContext {
  readonly id: string;
}
export interface DurableObjectMigrationContext extends DurableObjectInitialContext {
  readonly fromVersion: number;
  readonly toVersion: number;
}
export interface DurableObjectStorage<State> {
  get(): Readonly<State>;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  getAlarm(): number | null;
}
export interface DurableObjectMutableStorage<State> extends DurableObjectStorage<State> {
  set(value: State): void;
  update(update: (current: Readonly<State>) => State): void;
  deleteAll(): void;
  setAlarm(at: number | Date | null): void;
}
export interface DurableObjectQueryContext<State> {
  readonly id: string;
  readonly storage: DurableObjectStorage<State>;
  readonly signal: AbortSignal;
}
export interface DurableObjectMutationContext<State> {
  readonly id: string;
  readonly storage: DurableObjectMutableStorage<State>;
  readonly signal: AbortSignal;
}
export type DurableObjectContext<Kind extends DurableObjectMethodKind, State> =
  Kind extends "query" ? DurableObjectQueryContext<State> : DurableObjectMutationContext<State>;
export interface DurableObjectMethod<Kind extends DurableObjectMethodKind, Input, Output, State> {
  readonly kind: Kind;
  readonly args: Schema<Input>;
  readonly returns?: Schema<Output>;
  readonly description?: string;
  readonly timeoutMs: number;
  readonly agent: false | Readonly<DurableObjectAgentOptions>;
  readonly handler: (context: DurableObjectContext<Kind, State>, input: Input) => Output | Promise<Output>;
}
export type AnyDurableObjectMethod = DurableObjectMethod<DurableObjectMethodKind, any, any, any>;
export type DurableObjectMethodTree = {
  readonly [key: string]: AnyDurableObjectMethod | DurableObjectMethodTree;
};
export interface DurableObjectMethodBuilders<State> {
  query<const Args extends DurableObjectArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    description?: string;
    timeoutMs?: number;
    agent?: false | DurableObjectAgentOptions;
    handler: (context: DurableObjectQueryContext<State>, input: InferDurableObjectArgs<Args>) => Output | Promise<Output>;
  }): DurableObjectMethod<"query", InferDurableObjectArgs<Args>, Output, State>;
  mutation<const Args extends DurableObjectArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    description?: string;
    timeoutMs?: number;
    agent?: false | DurableObjectAgentOptions;
    handler: (context: DurableObjectMutationContext<State>, input: InferDurableObjectArgs<Args>) => Output | Promise<Output>;
  }): DurableObjectMethod<"mutation", InferDurableObjectArgs<Args>, Output, State>;
}
export interface DurableObjectAlarmRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
}
export interface DurableObjectAlarmDefinition<State> {
  readonly handler: (context: DurableObjectMutationContext<State>) => void | Promise<void>;
  readonly retry?: DurableObjectAlarmRetryOptions;
  readonly description?: string;
  readonly timeoutMs?: number;
}
export interface DurableObjectDefinition<State, Methods extends DurableObjectMethodTree> {
  readonly kind: "durable-object";
  readonly name: string;
  readonly description?: string;
  readonly state: Schema<State>;
  readonly version: number;
  readonly methods: Methods;
  readonly alarm?: DurableObjectAlarmDefinition<State>;
  readonly initial: (context: DurableObjectInitialContext) => State;
  readonly migrations: Readonly<Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown>>;
}
export declare function defineDurableObject<StateSchema extends Schema<any>, const Methods extends DurableObjectMethodTree>(options: {
  name: string;
  description?: string;
  state: StateSchema;
  initial: InferSchema<StateSchema> | ((context: DurableObjectInitialContext) => InferSchema<StateSchema>);
  version?: number;
  migrations?: Readonly<Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown>>;
  methods: (builders: DurableObjectMethodBuilders<InferSchema<StateSchema>>) => Methods;
  alarm?: DurableObjectAlarmDefinition<InferSchema<StateSchema>>;
}): DurableObjectDefinition<InferSchema<StateSchema>, Methods>;

export type DurableObjectMethodInput<Method> = Method extends DurableObjectMethod<any, infer Input, any, any> ? Input : never;
export type DurableObjectMethodOutput<Method> = Method extends DurableObjectMethod<any, any, infer Output, any> ? Output : never;
type MethodOfTree<Tree> = Tree extends AnyDurableObjectMethod
  ? Tree
  : Tree extends Readonly<Record<string, unknown>>
    ? { [Key in keyof Tree]: MethodOfTree<Tree[Key]> }[keyof Tree]
    : never;
export type DurableObjectMethodOf<Definition> = Definition extends DurableObjectDefinition<any, infer Methods>
  ? MethodOfTree<Methods>
  : never;

export interface DurableObjectCallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface DurableObjectCallResult<Value> {
  readonly value: Value;
  readonly revision: number;
  readonly deduplicated: boolean;
}
export interface DurableObjectSnapshot<State> {
  readonly namespace: string;
  readonly id: string;
  readonly state: Readonly<State>;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly alarm: null | Readonly<{
    scheduledAt: number | null;
    attempts: number;
    lastError?: string;
  }>;
}
export interface DurableObjectListOptions {
  prefix?: string;
  limit?: number;
}
type StateOf<Definition> = Definition extends DurableObjectDefinition<infer State, any> ? State : never;
export interface DurableObjectNamespace<Definition extends DurableObjectDefinition<any, any>> {
  readonly definition: Definition;
  get(id: string): DurableObjectStub<Definition>;
  inspect(id: string): DurableObjectSnapshot<StateOf<Definition>> | null;
  list(options?: DurableObjectListOptions): readonly DurableObjectSnapshot<StateOf<Definition>>[];
}
export interface DurableObjectStub<Definition extends DurableObjectDefinition<any, any>> {
  readonly id: string;
  readonly definition: Definition;
  call<Method extends DurableObjectMethodOf<Definition>>(
    method: Method,
    input: DurableObjectMethodInput<Method>,
    options?: DurableObjectCallOptions,
  ): Promise<DurableObjectMethodOutput<Method>>;
  invoke<Method extends DurableObjectMethodOf<Definition>>(
    method: Method,
    input: DurableObjectMethodInput<Method>,
    options?: DurableObjectCallOptions,
  ): Promise<DurableObjectCallResult<DurableObjectMethodOutput<Method>>>;
  inspect(): DurableObjectSnapshot<StateOf<Definition>> | null;
  subscribe(listener: (snapshot: DurableObjectSnapshot<StateOf<Definition>> | null) => void): Cleanup;
}
export interface DurableObjectAlarmSchedulerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}
export interface DurableObjectAlarmScheduler {
  close(): Promise<void>;
}
export interface DurableObjectRuntimeDiagnostics {
  readonly protocol: "clank-durable-objects-diagnostics/1";
  readonly namespaces: number;
  readonly objects: number;
  readonly scheduledAlarms: number;
  readonly dueAlarms: number;
  readonly leasedObjects: number;
  readonly activeCalls: number;
  readonly subscriptions: number;
}
export interface DurableObjectRuntime<Objects extends Readonly<Record<string, DurableObjectDefinition<any, any>>>> {
  readonly objects: Objects;
  namespace<Definition extends Objects[keyof Objects]>(definition: Definition): DurableObjectNamespace<Definition>;
  get<Definition extends Objects[keyof Objects]>(definition: Definition, id: string): DurableObjectStub<Definition>;
  runAlarmsOnce(options?: { limit?: number }): Promise<number>;
  startAlarmScheduler(options?: DurableObjectAlarmSchedulerOptions): DurableObjectAlarmScheduler;
  diagnostics(): DurableObjectRuntimeDiagnostics;
  close(): Promise<void>;
}
export interface OpenDurableObjectsOptions {
  database: SQLiteDatabase<any>;
  now?: () => number;
  onError?: (error: unknown, context?: { namespace: string; id: string; method?: string; alarm?: boolean }) => void;
  leaseMs?: number;
  acquireTimeoutMs?: number;
  acquirePollIntervalMs?: number;
  maxStateBytes?: number;
  maxArgumentsBytes?: number;
  maxResultBytes?: number;
  maxErrorBytes?: number;
  /** Maximum retained object identities, including tombstones, in each namespace. Defaults to 100,000. */
  maxObjectsPerNamespace?: number;
  /** Maximum live idempotency records retained for one object. Defaults to 10,000. */
  maxIdempotencyRecordsPerObject?: number;
  idempotencyRetentionMs?: number;
}
export declare class DurableObjectError extends Error {
  readonly code: string;
  readonly name: "DurableObjectError";
  constructor(code: string, message: string);
}
export declare function openDurableObjects<const Objects extends Readonly<Record<string, DurableObjectDefinition<any, any>>>>(
  objects: Objects,
  options: OpenDurableObjectsOptions,
): DurableObjectRuntime<Objects>;

export interface DurableObjectManifestMethod {
  readonly name: string;
  readonly kind: DurableObjectMethodKind;
  readonly description?: string;
  readonly timeoutMs: number;
  readonly args: Record<string, unknown>;
  readonly returns?: Record<string, unknown>;
  readonly agent: false | Readonly<DurableObjectAgentOptions>;
}
export interface DurableObjectManifestEntry {
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly state: Record<string, unknown>;
  readonly methods: readonly DurableObjectManifestMethod[];
  readonly alarm: null | Readonly<{
    description?: string;
    timeoutMs: number;
    retry: Required<DurableObjectAlarmRetryOptions>;
  }>;
}
export declare function durableObjectManifest(
  objects: Readonly<Record<string, DurableObjectDefinition<any, any>>>,
): readonly DurableObjectManifestEntry[];

export interface DurableObjectMcpAuthorizationAttempt {
  readonly namespace: string;
  readonly id: string;
  readonly method: string;
  readonly kind: DurableObjectMethodKind;
}
export interface DurableObjectMcpToolsOptions<Context> {
  authorize(
    context: Context,
    attempt: DurableObjectMcpAuthorizationAttempt,
    request: Request,
  ): boolean | Promise<boolean>;
  prefix?: string;
}
export declare function durableObjectMcpTools<Context, Definition extends DurableObjectDefinition<any, any>>(
  runtime: DurableObjectRuntime<any>,
  definition: Definition,
  options: DurableObjectMcpToolsOptions<Context>,
): readonly McpTool<Context>[];
