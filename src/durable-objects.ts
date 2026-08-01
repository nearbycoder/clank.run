import {
  s,
  type InferSchema,
  type InferSchemaShape,
  type Schema,
  type SchemaShape,
} from "./ai.ts";
import {
  stableStringify,
  type SQLiteDatabase,
} from "./backend.ts";
import type { Cleanup } from "./core.ts";
import { McpToolError, type McpTool } from "./mcp.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

export type DurableObjectArgs = Schema<any> | SchemaShape;
export type InferDurableObjectArgs<Args extends DurableObjectArgs> = Args extends Schema<any>
  ? InferSchema<Args>
  : Args extends SchemaShape
    ? InferSchemaShape<Args>
    : never;

export type DurableObjectMethodKind = "query" | "mutation";

export interface DurableObjectAgentOptions {
  /** Human-readable title for agent manifests. */
  title?: string;
  /** Exact behavior and side-effect description. */
  description?: string;
  /** Whether the method can destroy or permanently remove data. */
  destructive?: boolean;
  /** Whether retries with the same idempotency key safely converge. */
  idempotent?: boolean;
  /** Whether the method communicates outside this application. */
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
  /** Immutable current state snapshot. */
  get(): Readonly<State>;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  getAlarm(): number | null;
}

export interface DurableObjectMutableStorage<State> extends DurableObjectStorage<State> {
  /** Replace the complete state after schema validation. */
  set(value: State): void;
  /** Derive and replace the complete state synchronously. */
  update(update: (current: Readonly<State>) => State): void;
  /** Delete durable state after the current method returns successfully. */
  deleteAll(): void;
  /** Schedule one durable alarm, or clear it with null. */
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

export interface DurableObjectMethod<
  Kind extends DurableObjectMethodKind,
  Input,
  Output,
  State,
> {
  readonly kind: Kind;
  readonly args: Schema<Input>;
  readonly returns?: Schema<Output>;
  readonly description?: string;
  readonly timeoutMs: number;
  readonly agent: false | Readonly<DurableObjectAgentOptions>;
  readonly handler: (
    context: DurableObjectContext<Kind, State>,
    input: Input,
  ) => Output | Promise<Output>;
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
    handler: (
      context: DurableObjectQueryContext<State>,
      input: InferDurableObjectArgs<Args>,
    ) => Output | Promise<Output>;
  }): DurableObjectMethod<"query", InferDurableObjectArgs<Args>, Output, State>;
  mutation<const Args extends DurableObjectArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    description?: string;
    timeoutMs?: number;
    agent?: false | DurableObjectAgentOptions;
    handler: (
      context: DurableObjectMutationContext<State>,
      input: InferDurableObjectArgs<Args>,
    ) => Output | Promise<Output>;
  }): DurableObjectMethod<"mutation", InferDurableObjectArgs<Args>, Output, State>;
}

export interface DurableObjectAlarmRetryOptions {
  /** Total attempts before the alarm is parked. Defaults to 5. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 1 second. */
  initialDelayMs?: number;
  /** Exponential multiplier. Defaults to 2. */
  factor?: number;
  /** Maximum retry delay. Defaults to 15 minutes. */
  maxDelayMs?: number;
}

export interface DurableObjectAlarmDefinition<State> {
  readonly handler: (context: DurableObjectMutationContext<State>) => void | Promise<void>;
  readonly retry?: DurableObjectAlarmRetryOptions;
  readonly description?: string;
  /** Maximum handler duration. Defaults to 15 minutes. */
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

const METHOD_PATH = Symbol.for("clank.durable-object.method.path");

/** Defines one stable, typed durable-object namespace. */
export function defineDurableObject<
  StateSchema extends Schema<any>,
  const Methods extends DurableObjectMethodTree,
>(options: {
  name: string;
  description?: string;
  state: StateSchema;
  initial: InferSchema<StateSchema> | ((context: DurableObjectInitialContext) => InferSchema<StateSchema>);
  version?: number;
  migrations?: Readonly<Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown>>;
  methods: (builders: DurableObjectMethodBuilders<InferSchema<StateSchema>>) => Methods;
  alarm?: DurableObjectAlarmDefinition<InferSchema<StateSchema>>;
}): DurableObjectDefinition<InferSchema<StateSchema>, Methods> {
  if (!options || typeof options !== "object") throw new TypeError("Durable object options are required.");
  const name = namespaceName(options.name);
  if (!options.state || typeof options.state.parse !== "function" || typeof options.state.toJSONSchema !== "function") {
    throw new TypeError("Durable object state must be a schema.");
  }
  const version = integer(options.version ?? 1, "durable object version", 1, 1_000_000);
  const migrations = normalizeMigrations(version, options.migrations);
  const description = optionalText(options.description, "durable object description", 16 * 1024);
  const initialSource = options.initial;
  if (typeof initialSource !== "function") options.state.parse(initialSource);
  const initial = (context: DurableObjectInitialContext): InferSchema<StateSchema> => {
    const candidate = typeof initialSource === "function"
      ? (initialSource as (context: DurableObjectInitialContext) => InferSchema<StateSchema>)(context)
      : cloneJson(initialSource);
    assertSynchronous(candidate, "durable object initial state");
    return options.state.parse(candidate);
  };
  const builders: DurableObjectMethodBuilders<InferSchema<StateSchema>> = {
    query: (definition) => createMethod("query", definition) as any,
    mutation: (definition) => createMethod("mutation", definition) as any,
  };
  if (typeof options.methods !== "function") throw new TypeError("Durable object methods() is required.");
  const methods = options.methods(builders);
  const registry = flattenMethods(methods);
  if (registry.size === 0) throw new TypeError("A durable object must define at least one method.");
  if (registry.size > 1_000) throw new TypeError("A durable object cannot contain more than 1,000 methods.");
  const definitions = new Set<AnyDurableObjectMethod>();
  for (const [path, method] of registry) {
    if (path.length > 512) throw new TypeError(`Durable object method path exceeds 512 characters: ${path}`);
    if (definitions.has(method)) throw new TypeError(`A durable object method cannot be reused at more than one path: ${path}`);
    definitions.add(method);
    Object.defineProperty(method, METHOD_PATH, { value: path, enumerable: false });
    Object.freeze(method);
  }
  if (options.alarm) {
    if (typeof options.alarm !== "object" || typeof options.alarm.handler !== "function") {
      throw new TypeError("Durable object alarm requires a handler.");
    }
    normalizeAlarmRetry(options.alarm.retry);
    optionalText(options.alarm.description, "durable object alarm description", 16 * 1024);
    integer(options.alarm.timeoutMs ?? 15 * 60_000, "durable object alarm timeoutMs", 100, 24 * 60 * 60_000);
  }
  return Object.freeze({
    kind: "durable-object" as const,
    name,
    ...(description ? { description } : {}),
    state: options.state,
    version,
    methods: freezeMethodTree(methods) as Methods,
    ...(options.alarm ? { alarm: Object.freeze({
      ...options.alarm,
      retry: Object.freeze(normalizeAlarmRetry(options.alarm.retry)),
      timeoutMs: integer(options.alarm.timeoutMs ?? 15 * 60_000, "durable object alarm timeoutMs", 100, 24 * 60 * 60_000),
    }) } : {}),
    initial,
    migrations,
  });
}

function createMethod(kind: DurableObjectMethodKind, definition: {
  args: DurableObjectArgs;
  returns?: Schema<any>;
  description?: string;
  timeoutMs?: number;
  agent?: false | DurableObjectAgentOptions;
  handler: (context: any, input: any) => unknown;
}): AnyDurableObjectMethod {
  if (!definition || typeof definition !== "object") throw new TypeError(`Durable object ${kind} definition is required.`);
  if (typeof definition.handler !== "function") throw new TypeError(`Durable object ${kind} requires a handler.`);
  const args = toSchema(definition.args);
  const description = optionalText(definition.description, `durable object ${kind} description`, 16 * 1024);
  const timeoutMs = integer(definition.timeoutMs ?? 30_000, `durable object ${kind} timeoutMs`, 100, 24 * 60 * 60_000);
  const agent = normalizeAgent(definition.agent);
  return {
    kind,
    args,
    ...(definition.returns ? { returns: definition.returns } : {}),
    ...(description ? { description } : {}),
    timeoutMs,
    agent,
    handler: definition.handler,
  } as AnyDurableObjectMethod;
}

export type DurableObjectMethodInput<Method> = Method extends DurableObjectMethod<any, infer Input, any, any> ? Input : never;
export type DurableObjectMethodOutput<Method> = Method extends DurableObjectMethod<any, any, infer Output, any> ? Output : never;
export type DurableObjectMethodOf<Definition> = Definition extends DurableObjectDefinition<any, infer Methods>
  ? MethodOfTree<Methods>
  : never;

type MethodOfTree<Tree> = Tree extends AnyDurableObjectMethod
  ? Tree
  : Tree extends Readonly<Record<string, unknown>>
    ? { [Key in keyof Tree]: MethodOfTree<Tree[Key]> }[keyof Tree]
    : never;

export interface DurableObjectCallOptions {
  /** Deduplicates a successful mutation for this object. */
  idempotencyKey?: string;
  /** Cancels waiting or execution; successful state is never committed after cancellation. */
  signal?: AbortSignal;
  /** Overrides the method timeout with a smaller bound. */
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

export interface DurableObjectNamespace<Definition extends DurableObjectDefinition<any, any>> {
  readonly definition: Definition;
  get(id: string): DurableObjectStub<Definition>;
  inspect(id: string): DurableObjectSnapshot<StateOf<Definition>> | null;
  list(options?: DurableObjectListOptions): readonly DurableObjectSnapshot<StateOf<Definition>>[];
}

type StateOf<Definition> = Definition extends DurableObjectDefinition<infer State, any> ? State : never;

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
  idempotencyRetentionMs?: number;
}

export class DurableObjectError extends Error {
  readonly name = "DurableObjectError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface ObjectRow extends Record<string, unknown> {
  namespace: string;
  object_id: string;
  schema_version: number;
  object_version: number;
  state_json: string | null;
  deleted: number;
  alarm_at: number | null;
  alarm_attempts: number;
  alarm_error: string | null;
  created_at: number;
  updated_at: number;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: number | null;
}

interface CallRow extends Record<string, unknown> {
  method: string;
  arguments_json: string;
  result_json: string;
  object_version: number;
}

interface AcquiredObject {
  row: ObjectRow;
  token: string;
}

interface MutableState<State> {
  state: State;
  encodedState: string;
  deleted: boolean;
  alarmAt: number | null;
  alarmAttempts: number;
  alarmError: string | null;
  changed: boolean;
  active: boolean;
}

const CHANGE_TABLE = "clank_durable_objects";

/** Opens a first-party durable-object runtime over an application's Clank SQLite database. */
export function openDurableObjects<
  const Objects extends Readonly<Record<string, DurableObjectDefinition<any, any>>>,
>(objects: Objects, options: OpenDurableObjectsOptions): DurableObjectRuntime<Objects> {
  if (!objects || typeof objects !== "object" || Array.isArray(objects)) {
    throw new TypeError("Durable object definitions must be a named object.");
  }
  if (!options?.database) throw new TypeError("Durable objects require a Clank SQLite database.");
  const entries = Object.entries(objects);
  if (entries.length === 0) throw new TypeError("At least one durable object definition is required.");
  if (entries.length > 1_000) throw new TypeError("A runtime cannot register more than 1,000 durable object namespaces.");
  const definitions = new Map<string, DurableObjectDefinition<any, any>>();
  const identities = new Set<DurableObjectDefinition<any, any>>();
  for (const [key, definition] of entries) {
    identifier(key, "durable object registry key", 128);
    if (!definition || definition.kind !== "durable-object") throw new TypeError(`Invalid durable object definition: ${key}`);
    if (definitions.has(definition.name)) throw new TypeError(`Duplicate durable object namespace: ${definition.name}`);
    if (identities.has(definition)) throw new TypeError(`A durable object definition cannot be registered twice: ${definition.name}`);
    definitions.set(definition.name, definition);
    identities.add(definition);
  }
  const database = options.database;
  const internal = database[SQLITE_INTERNAL];
  if (!internal) throw new TypeError("Durable objects require a Clank SQLite database capability.");
  ensureSchema(internal);
  const now = options.now ?? Date.now;
  const leaseMs = integer(options.leaseMs ?? 30_000, "durable object leaseMs", 1_000, 60 * 60_000);
  const acquireTimeoutMs = integer(options.acquireTimeoutMs ?? 30_000, "durable object acquireTimeoutMs", 100, 10 * 60_000);
  const acquirePollIntervalMs = integer(options.acquirePollIntervalMs ?? 25, "durable object acquirePollIntervalMs", 5, 5_000);
  const maxStateBytes = integer(options.maxStateBytes ?? 1024 * 1024, "durable object maxStateBytes", 1_024, 16 * 1024 * 1024);
  const maxArgumentsBytes = integer(options.maxArgumentsBytes ?? 256 * 1024, "durable object maxArgumentsBytes", 1_024, 4 * 1024 * 1024);
  const maxResultBytes = integer(options.maxResultBytes ?? 256 * 1024, "durable object maxResultBytes", 1_024, 4 * 1024 * 1024);
  const maxErrorBytes = integer(options.maxErrorBytes ?? 16 * 1024, "durable object maxErrorBytes", 256, 256 * 1024);
  const idempotencyRetentionMs = integer(options.idempotencyRetentionMs ?? 24 * 60 * 60_000, "durable object idempotencyRetentionMs", 60_000, 365 * 24 * 60 * 60_000);
  const runtimeId = `durable-${processId()}-${secureId()}`;
  const lanes = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();
  const schedulers = new Set<{ controller: AbortController; done: Promise<void> }>();
  const subscriptions = new Map<string, Set<(snapshot: DurableObjectSnapshot<any> | null) => void>>();
  let lastCleanupAt = now();
  let closed = false;

  const ensureOpen = () => {
    if (closed) throw new DurableObjectError("RUNTIME_CLOSED", "Durable object runtime is closed.");
    if (internal.inTransaction) {
      throw new DurableObjectError(
        "NESTED_TRANSACTION",
        "Durable object calls cannot start inside a database transaction; call the object before or after the transaction.",
      );
    }
  };

  const report = (error: unknown, context?: { namespace: string; id: string; method?: string; alarm?: boolean }) => {
    try { options.onError?.(error, context); } catch { /* Diagnostics cannot change object state. */ }
  };

  const registered = <Definition extends DurableObjectDefinition<any, any>>(definition: Definition): Definition => {
    if (!identities.has(definition)) throw new TypeError(`Durable object ${definition?.name ?? "<unknown>"} is not registered with this runtime.`);
    return definition;
  };

  const serialize = async <Value>(key: string, task: () => Promise<Value>): Promise<Value> => {
    const previous = lanes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    lanes.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (lanes.get(key) === tail) lanes.delete(key);
    }
  };

  const initialState = (definition: DurableObjectDefinition<any, any>, id: string): { state: unknown; encoded: string } => {
    const state = definition.state.parse(definition.initial(Object.freeze({ id })));
    const encoded = encodeJson(state, "durable object state", maxStateBytes);
    return { state, encoded };
  };

  const acquire = async (
    definition: DurableObjectDefinition<any, any>,
    id: string,
    signal: AbortSignal,
  ): Promise<AcquiredObject> => {
    const token = secureId();
    const deadline = Date.now() + acquireTimeoutMs;
    let seed: { state: unknown; encoded: string } | undefined;
    while (true) {
      throwIfAborted(signal);
      const current = now();
      const acquired = internal.transaction((changes) => {
        let row = internal.prepare(`SELECT * FROM clank_durable_objects
          WHERE namespace = ? AND object_id = ?`).get(definition.name, id) as ObjectRow | undefined;
        if (!row || Number(row.deleted) === 1) {
          seed ??= initialState(definition, id);
          if (!row) {
            const inserted = internal.prepare(`INSERT OR IGNORE INTO clank_durable_objects
              (namespace, object_id, schema_version, object_version, state_json, deleted,
                alarm_at, alarm_attempts, alarm_error, created_at, updated_at,
                lease_token, lease_owner, lease_until)
              VALUES (?, ?, ?, 1, ?, 0, NULL, 0, NULL, ?, ?, ?, ?, ?)`)
              .run(definition.name, id, definition.version, seed.encoded, current, current, token, runtimeId, current + leaseMs);
            if (Number(inserted.changes) === 1) changes.record(CHANGE_TABLE, changeId(definition.name, id));
          } else if (leaseAvailable(row, current)) {
            const restored = internal.prepare(`UPDATE clank_durable_objects
              SET schema_version = ?, object_version = object_version + 1, state_json = ?, deleted = 0,
                alarm_at = NULL, alarm_attempts = 0, alarm_error = NULL,
                created_at = ?, updated_at = ?, lease_token = ?, lease_owner = ?, lease_until = ?
              WHERE namespace = ? AND object_id = ? AND deleted = 1
                AND (lease_until IS NULL OR lease_until <= ?)`)
              .run(definition.version, seed.encoded, current, current, token, runtimeId, current + leaseMs,
                definition.name, id, current);
            if (Number(restored.changes) === 1) changes.record(CHANGE_TABLE, changeId(definition.name, id));
          }
        } else if (leaseAvailable(row, current)) {
          internal.prepare(`UPDATE clank_durable_objects SET lease_token = ?, lease_owner = ?, lease_until = ?
            WHERE namespace = ? AND object_id = ? AND deleted = 0
              AND (lease_until IS NULL OR lease_until <= ?)`)
            .run(token, runtimeId, current + leaseMs, definition.name, id, current);
        }
        row = internal.prepare(`SELECT * FROM clank_durable_objects
          WHERE namespace = ? AND object_id = ?`).get(definition.name, id) as ObjectRow | undefined;
        return row && row.lease_token === token && row.lease_owner === runtimeId ? row : null;
      });
      if (acquired) return { row: acquired, token };
      if (Date.now() >= deadline) {
        throw new DurableObjectError("LEASE_TIMEOUT", `Timed out waiting for durable object ${definition.name}/${id}.`);
      }
      await delay(Math.min(acquirePollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
  };

  const releaseLease = (definition: DurableObjectDefinition<any, any>, id: string, token: string): boolean => {
    const result = internal.transaction(() => internal.prepare(`UPDATE clank_durable_objects
      SET lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE namespace = ? AND object_id = ? AND lease_token = ? AND lease_owner = ?`)
      .run(definition.name, id, token, runtimeId));
    return Number(result.changes) === 1;
  };

  const startHeartbeat = (
    definition: DurableObjectDefinition<any, any>,
    id: string,
    token: string,
    controller: AbortController,
  ): (() => void) => {
    const interval = setInterval(() => {
      if (controller.signal.aborted || closed) return;
      try {
        const renewedAt = now();
        const result = internal.transaction(() => internal.prepare(`UPDATE clank_durable_objects
          SET lease_until = ? WHERE namespace = ? AND object_id = ?
            AND lease_token = ? AND lease_owner = ? AND deleted = 0`)
          .run(renewedAt + leaseMs, definition.name, id, token, runtimeId));
        if (Number(result.changes) !== 1) {
          controller.abort(new DurableObjectError("LEASE_LOST", "Durable object lease was lost during execution."));
        }
      } catch (error) {
        controller.abort(new DurableObjectError("LEASE_LOST", safeError(error, maxErrorBytes)));
      }
    }, Math.max(250, Math.floor(leaseMs / 3)));
    (interval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    return () => clearInterval(interval);
  };

  const prepareState = (
    definition: DurableObjectDefinition<any, any>,
    row: ObjectRow,
    id: string,
  ): MutableState<any> => {
    if (Number(row.deleted) === 1 || typeof row.state_json !== "string") {
      throw new DurableObjectError("STATE_MISSING", `Durable object ${definition.name}/${id} has no state.`);
    }
    const storedVersion = positiveInteger(Number(row.schema_version), "stored durable object schema version");
    if (storedVersion > definition.version) {
      throw new DurableObjectError(
        "SCHEMA_TOO_NEW",
        `Durable object ${definition.name}/${id} uses schema version ${storedVersion}, newer than this release's version ${definition.version}.`,
      );
    }
    let state: unknown = parseJson(row.state_json, "durable object state");
    let changed = false;
    for (let target = storedVersion + 1; target <= definition.version; target++) {
      const migration = definition.migrations[target];
      if (!migration) throw new DurableObjectError("MIGRATION_MISSING", `Missing durable object migration to version ${target}.`);
      state = migration(state, Object.freeze({ id, fromVersion: target - 1, toVersion: target }));
      assertSynchronous(state, `durable object migration ${target}`);
      changed = true;
    }
    state = definition.state.parse(state);
    const encodedState = encodeJson(state, "durable object state", maxStateBytes);
    return {
      state: immutableJson(state),
      encodedState,
      deleted: false,
      alarmAt: nullableNonNegativeInteger(row.alarm_at, "durable object alarm"),
      alarmAttempts: nonNegativeInteger(Number(row.alarm_attempts), "durable object alarm attempts"),
      alarmError: row.alarm_error === null || row.alarm_error === undefined ? null : String(row.alarm_error),
      changed,
      active: true,
    };
  };

  const storageFor = <State>(
    definition: DurableObjectDefinition<State, any>,
    row: ObjectRow,
    mutable: MutableState<State>,
    writable: boolean,
  ): DurableObjectStorage<State> | DurableObjectMutableStorage<State> => {
    const ensureActive = () => {
      if (!mutable.active) throw new DurableObjectError("CALL_FINISHED", "Durable object storage is no longer active.");
      if (mutable.deleted) throw new DurableObjectError("STATE_DELETED", "Durable object state was deleted during this call.");
    };
    const reader: DurableObjectStorage<State> = {
      get() { ensureActive(); return mutable.state as Readonly<State>; },
      revision: Number(row.object_version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      getAlarm() { ensureActive(); return mutable.alarmAt; },
    };
    if (!writable) return Object.freeze(reader);
    const writer: DurableObjectMutableStorage<State> = {
      ...reader,
      set(value) {
        if (!mutable.active) throw new DurableObjectError("CALL_FINISHED", "Durable object storage is no longer active.");
        const state = definition.state.parse(value);
        const encoded = encodeJson(state, "durable object state", maxStateBytes);
        if (mutable.deleted || mutable.encodedState !== encoded) {
          mutable.state = immutableJson(state);
          mutable.encodedState = encoded;
          mutable.deleted = false;
          mutable.changed = true;
        }
      },
      update(update) {
        ensureActive();
        if (typeof update !== "function") throw new TypeError("Durable object update must be a function.");
        const value = update(mutable.state as Readonly<State>);
        assertSynchronous(value, "durable object state update");
        writer.set(value);
      },
      deleteAll() {
        if (!mutable.active) throw new DurableObjectError("CALL_FINISHED", "Durable object storage is no longer active.");
        mutable.deleted = true;
        mutable.alarmAt = null;
        mutable.alarmAttempts = 0;
        mutable.alarmError = null;
        mutable.changed = true;
      },
      setAlarm(at) {
        ensureActive();
        const value = at === null ? null : at instanceof Date ? at.getTime() : at;
        const normalized = value === null ? null : nonNegativeInteger(value, "durable object alarm timestamp");
        if (mutable.alarmAt !== normalized || mutable.alarmAttempts !== 0 || mutable.alarmError !== null) {
          mutable.alarmAt = normalized;
          mutable.alarmAttempts = 0;
          mutable.alarmError = null;
          mutable.changed = true;
        }
      },
    };
    return Object.freeze(writer);
  };

  const commit = (
    definition: DurableObjectDefinition<any, any>,
    id: string,
    acquired: AcquiredObject,
    mutable: MutableState<any>,
    resultJson?: string,
    idempotency?: { key: string; method: string; argumentsJson: string },
  ): number => {
    const currentVersion = positiveInteger(Number(acquired.row.object_version), "durable object revision");
    const nextVersion = mutable.changed ? currentVersion + 1 : currentVersion;
    const committedAt = now();
    const nextUpdatedAt = mutable.changed ? committedAt : Number(acquired.row.updated_at);
    return internal.transaction((changes) => {
      const updated = internal.prepare(`UPDATE clank_durable_objects SET
          schema_version = ?, object_version = ?, state_json = ?, deleted = ?,
          alarm_at = ?, alarm_attempts = ?, alarm_error = ?, updated_at = ?,
          lease_token = NULL, lease_owner = NULL, lease_until = NULL
        WHERE namespace = ? AND object_id = ? AND object_version = ?
          AND lease_token = ? AND lease_owner = ?`)
        .run(
          definition.version,
          nextVersion,
          mutable.deleted ? null : mutable.encodedState,
          mutable.deleted ? 1 : 0,
          mutable.deleted ? null : mutable.alarmAt,
          mutable.deleted ? 0 : mutable.alarmAttempts,
          mutable.deleted ? null : mutable.alarmError,
          nextUpdatedAt,
          definition.name,
          id,
          currentVersion,
          acquired.token,
          runtimeId,
        );
      if (Number(updated.changes) !== 1) {
        throw new DurableObjectError("LEASE_LOST", "Durable object lease or revision was lost before commit.");
      }
      if (idempotency) {
        internal.prepare(`INSERT INTO clank_durable_object_calls
          (namespace, object_id, idempotency_key, method, arguments_json, result_json, object_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(definition.name, id, idempotency.key, idempotency.method, idempotency.argumentsJson,
            resultJson!, nextVersion, committedAt);
      }
      if (mutable.changed) changes.record(CHANGE_TABLE, changeId(definition.name, id));
      return nextVersion;
    });
  };

  const cleanupCalls = () => {
    const current = now();
    if (current - lastCleanupAt < Math.min(60 * 60_000, idempotencyRetentionMs)) return;
    lastCleanupAt = current;
    internal.transaction(() => internal.prepare(`DELETE FROM clank_durable_object_calls WHERE rowid IN (
      SELECT rowid FROM clank_durable_object_calls WHERE created_at < ? ORDER BY created_at LIMIT 1000
    )`).run(current - idempotencyRetentionMs));
  };

  const executeMethod = async <Method extends AnyDurableObjectMethod>(
    definition: DurableObjectDefinition<any, any>,
    id: string,
    method: Method,
    input: unknown,
    callOptions: DurableObjectCallOptions,
  ): Promise<DurableObjectCallResult<any>> => {
    ensureOpen();
    const path = methodPath(definition, method);
    if (method.kind === "query" && callOptions.idempotencyKey !== undefined) {
      throw new TypeError("Idempotency keys apply only to durable object mutations.");
    }
    const idempotencyKey = callOptions.idempotencyKey === undefined
      ? undefined
      : boundedText(callOptions.idempotencyKey, "durable object idempotency key", 1, 256);
    const parsedInput = immutableJson(method.args.parse(input));
    const argumentsJson = encodeJson(parsedInput, "durable object arguments", maxArgumentsBytes);
    const timeoutMs = integer(
      callOptions.timeoutMs ?? method.timeoutMs,
      "durable object call timeoutMs",
      100,
      method.timeoutMs,
    );
    return await serialize(changeId(definition.name, id), async () => {
      const controller = linkedController(callOptions.signal, timeoutMs, "Durable object call timed out.");
      controllers.add(controller);
      let acquired: AcquiredObject | undefined;
      let stopHeartbeat: (() => void) | undefined;
      let mutable: MutableState<any> | undefined;
      try {
        acquired = await acquire(definition, id, controller.signal);
        stopHeartbeat = startHeartbeat(definition, id, acquired.token, controller);
        if (idempotencyKey) {
          const prior = internal.prepare(`SELECT method, arguments_json, result_json, object_version
            FROM clank_durable_object_calls
            WHERE namespace = ? AND object_id = ? AND idempotency_key = ?`)
            .get(definition.name, id, idempotencyKey) as CallRow | undefined;
          if (prior) {
            if (prior.method !== path || prior.arguments_json !== argumentsJson) {
              throw new DurableObjectError(
                "IDEMPOTENCY_CONFLICT",
                "The durable object idempotency key was already used with a different method or arguments.",
              );
            }
            releaseLease(definition, id, acquired.token);
            acquired = undefined;
            const value = parseMethodResult(method, String(prior.result_json));
            return Object.freeze({ value, revision: Number(prior.object_version), deduplicated: true });
          }
        }
        mutable = prepareState(definition, acquired.row, id);
        const storage = storageFor(definition, acquired.row, mutable, method.kind === "mutation");
        const handlerPromise = Promise.resolve(method.handler(Object.freeze({
          id,
          storage,
          signal: controller.signal,
        }) as any, parsedInput));
        const rawResult = await raceAbort(handlerPromise, controller.signal);
        throwIfAborted(controller.signal);
        const result = method.returns ? method.returns.parse(rawResult) : rawResult;
        const resultJson = encodeJson(result, "durable object result", maxResultBytes);
        const parsedResult = immutableJson(JSON.parse(resultJson));
        const revision = commit(
          definition,
          id,
          acquired,
          mutable,
          resultJson,
          idempotencyKey ? { key: idempotencyKey, method: path, argumentsJson } : undefined,
        );
        acquired = undefined;
        cleanupCalls();
        return Object.freeze({ value: parsedResult, revision, deduplicated: false });
      } catch (error) {
        report(error, { namespace: definition.name, id, method: path });
        throw normalizeCallError(error, controller.signal);
      } finally {
        if (mutable) mutable.active = false;
        stopHeartbeat?.();
        if (acquired) {
          try { releaseLease(definition, id, acquired.token); } catch (error) { report(error, { namespace: definition.name, id, method: path }); }
        }
        controller.abort();
        controllers.delete(controller);
      }
    });
  };

  const failAlarm = (
    definition: DurableObjectDefinition<any, any>,
    id: string,
    acquired: AcquiredObject,
    error: unknown,
  ) => {
    const retry = normalizeAlarmRetry(definition.alarm?.retry);
    const attempt = nonNegativeInteger(Number(acquired.row.alarm_attempts), "durable object alarm attempts") + 1;
    const exhausted = attempt >= retry.maxAttempts;
    const errorText = safeError(error, maxErrorBytes);
    const nextAt = exhausted ? null : now() + retryDelay(retry, attempt);
    const currentVersion = Number(acquired.row.object_version);
    internal.transaction((changes) => {
      const result = internal.prepare(`UPDATE clank_durable_objects SET
          object_version = object_version + 1, alarm_at = ?, alarm_attempts = ?, alarm_error = ?,
          updated_at = ?, lease_token = NULL, lease_owner = NULL, lease_until = NULL
        WHERE namespace = ? AND object_id = ? AND object_version = ?
          AND lease_token = ? AND lease_owner = ? AND deleted = 0`)
        .run(nextAt, attempt, errorText, now(), definition.name, id, currentVersion, acquired.token, runtimeId);
      if (Number(result.changes) !== 1) throw new DurableObjectError("LEASE_LOST", "Durable object alarm lease was lost.");
      changes.record(CHANGE_TABLE, changeId(definition.name, id));
    });
  };

  const executeAlarm = async (definition: DurableObjectDefinition<any, any>, id: string): Promise<boolean> => {
    if (!definition.alarm) return false;
    return await serialize(changeId(definition.name, id), async () => {
      const controller = linkedController(undefined, definition.alarm!.timeoutMs ?? 15 * 60_000, "Durable object alarm timed out.");
      controllers.add(controller);
      let acquired: AcquiredObject | undefined;
      let stopHeartbeat: (() => void) | undefined;
      let mutable: MutableState<any> | undefined;
      try {
        acquired = await acquire(definition, id, controller.signal);
        if (acquired.row.alarm_at === null || Number(acquired.row.alarm_at) > now()) {
          releaseLease(definition, id, acquired.token);
          acquired = undefined;
          return false;
        }
        stopHeartbeat = startHeartbeat(definition, id, acquired.token, controller);
        mutable = prepareState(definition, acquired.row, id);
        mutable.alarmAt = null;
        mutable.alarmAttempts = 0;
        mutable.alarmError = null;
        mutable.changed = true;
        const storage = storageFor(definition, acquired.row, mutable, true) as DurableObjectMutableStorage<any>;
        await raceAbort(Promise.resolve(definition.alarm!.handler(Object.freeze({
          id,
          storage,
          signal: controller.signal,
        }))), controller.signal);
        throwIfAborted(controller.signal);
        commit(definition, id, acquired, mutable);
        acquired = undefined;
        return true;
      } catch (error) {
        report(error, { namespace: definition.name, id, alarm: true });
        if (acquired && !closed && controller.signal.reason !== RUNTIME_CLOSED) {
          failAlarm(definition, id, acquired, error);
          acquired = undefined;
        }
        if (!closed && !(controller.signal.aborted && controller.signal.reason === RUNTIME_CLOSED)) throw normalizeCallError(error, controller.signal);
        return false;
      } finally {
        if (mutable) mutable.active = false;
        stopHeartbeat?.();
        if (acquired) {
          try { releaseLease(definition, id, acquired.token); } catch (error) { report(error, { namespace: definition.name, id, alarm: true }); }
        }
        controller.abort();
        controllers.delete(controller);
      }
    });
  };

  const inspect = <State>(definition: DurableObjectDefinition<State, any>, idInput: string): DurableObjectSnapshot<State> | null => {
    const id = objectId(idInput);
    const row = internal.prepare(`SELECT * FROM clank_durable_objects
      WHERE namespace = ? AND object_id = ? AND deleted = 0`).get(definition.name, id) as ObjectRow | undefined;
    return row ? snapshot(definition, row, maxStateBytes) : null;
  };

  const namespace = <Definition extends DurableObjectDefinition<any, any>>(definitionInput: Definition): DurableObjectNamespace<Definition> => {
    const definition = registered(definitionInput);
    const get = (idInput: string): DurableObjectStub<Definition> => {
      const id = objectId(idInput);
      return Object.freeze({
        id,
        definition,
        async call(method: any, input: unknown, callOptions: DurableObjectCallOptions = {}) {
          return (await executeMethod(definition, id, method, input, callOptions)).value;
        },
        async invoke(method: any, input: unknown, callOptions: DurableObjectCallOptions = {}) {
          return await executeMethod(definition, id, method, input, callOptions);
        },
        inspect() { ensureOpen(); return inspect(definition, id); },
        subscribe(listener: (value: DurableObjectSnapshot<any> | null) => void): Cleanup {
          ensureOpen();
          if (typeof listener !== "function") throw new TypeError("Durable object subscriber must be a function.");
          const key = changeId(definition.name, id);
          let listeners = subscriptions.get(key);
          if (!listeners) subscriptions.set(key, listeners = new Set());
          listeners.add(listener);
          notify(listener, inspect(definition, id), report, { namespace: definition.name, id });
          return () => {
            const current = subscriptions.get(key);
            current?.delete(listener);
            if (current?.size === 0) subscriptions.delete(key);
          };
        },
      }) as DurableObjectStub<Definition>;
    };
    return Object.freeze({
      definition,
      get,
      inspect(id: string) { ensureOpen(); return inspect(definition, id); },
      list(listOptions: DurableObjectListOptions = {}) {
        ensureOpen();
        const prefix = listOptions.prefix === undefined ? undefined : boundedText(listOptions.prefix, "durable object prefix", 0, 256);
        const limit = integer(listOptions.limit ?? 100, "durable object list limit", 1, 1_000);
        const rows = prefix === undefined
          ? internal.prepare(`SELECT * FROM clank_durable_objects
              WHERE namespace = ? AND deleted = 0 ORDER BY object_id LIMIT ?`).all(definition.name, limit)
          : internal.prepare(`SELECT * FROM clank_durable_objects
              WHERE namespace = ? AND deleted = 0 AND object_id >= ? AND object_id < ?
              ORDER BY object_id LIMIT ?`).all(definition.name, prefix, `${prefix}\uffff`, limit);
        return Object.freeze(rows.map((row) => snapshot(definition, row as ObjectRow, maxStateBytes)));
      },
    });
  };

  const unsubscribeDatabase = database.subscribe((change) => {
    if (subscriptions.size === 0) return;
    const ids = change.ids.get(CHANGE_TABLE);
    const keys = change.all ? [...subscriptions.keys()] : ids ? [...ids] : [];
    for (const key of keys) {
      const listeners = subscriptions.get(key);
      if (!listeners?.size) continue;
      const parsed = parseChangeId(key);
      if (!parsed) continue;
      const definition = definitions.get(parsed.namespace);
      if (!definition) continue;
      let value: DurableObjectSnapshot<any> | null;
      try { value = inspect(definition, parsed.id); }
      catch (error) { report(error, parsed); continue; }
      for (const listener of [...listeners]) notify(listener, value, report, parsed);
    }
  });

  const runtime: DurableObjectRuntime<Objects> = {
    objects,
    namespace,
    get(definition, id) { return namespace(definition).get(id); },
    async runAlarmsOnce(alarmOptions = {}) {
      ensureOpen();
      const limit = integer(alarmOptions.limit ?? 100, "durable object alarm limit", 1, 1_000);
      const rows = internal.prepare(`SELECT namespace, object_id FROM clank_durable_objects
        WHERE deleted = 0 AND alarm_at IS NOT NULL AND alarm_at <= ?
        ORDER BY alarm_at, namespace, object_id LIMIT ?`).all(now(), limit);
      let completed = 0;
      for (const row of rows) {
        if (closed) break;
        const definition = definitions.get(String(row.namespace));
        if (!definition?.alarm) continue;
        try {
          if (await executeAlarm(definition, String(row.object_id))) completed++;
        } catch { /* executeAlarm reports and persists retry state. */ }
      }
      return completed;
    },
    startAlarmScheduler(schedulerOptions = {}) {
      ensureOpen();
      const pollIntervalMs = integer(schedulerOptions.pollIntervalMs ?? 1_000, "durable object alarm pollIntervalMs", 50, 60_000);
      const batchSize = integer(schedulerOptions.batchSize ?? 100, "durable object alarm batchSize", 1, 1_000);
      const controller = new AbortController();
      const handle = {
        controller,
        done: (async () => {
          while (!closed && !controller.signal.aborted) {
            try { await runtime.runAlarmsOnce({ limit: batchSize }); }
            catch (error) { if (!closed && !controller.signal.aborted) report(error); }
            try { await delay(pollIntervalMs, controller.signal); } catch { break; }
          }
        })(),
      };
      schedulers.add(handle);
      void handle.done.finally(() => schedulers.delete(handle));
      return Object.freeze({
        async close() {
          controller.abort();
          await handle.done;
        },
      });
    },
    diagnostics() {
      ensureOpen();
      const current = now();
      const values = internal.prepare(`SELECT
        count(*) AS objects,
        coalesce(sum(CASE WHEN alarm_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS scheduled_alarms,
        coalesce(sum(CASE WHEN alarm_at IS NOT NULL AND alarm_at <= ? THEN 1 ELSE 0 END), 0) AS due_alarms,
        coalesce(sum(CASE WHEN lease_until IS NOT NULL AND lease_until > ? THEN 1 ELSE 0 END), 0) AS leased_objects
        FROM clank_durable_objects WHERE deleted = 0`).get(current, current)!;
      return Object.freeze({
        protocol: "clank-durable-objects-diagnostics/1" as const,
        namespaces: definitions.size,
        objects: Number(values.objects),
        scheduledAlarms: Number(values.scheduled_alarms),
        dueAlarms: Number(values.due_alarms),
        leasedObjects: Number(values.leased_objects),
        activeCalls: controllers.size,
        subscriptions: [...subscriptions.values()].reduce((total, listeners) => total + listeners.size, 0),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribeDatabase();
      subscriptions.clear();
      for (const controller of controllers) controller.abort(RUNTIME_CLOSED);
      for (const scheduler of schedulers) scheduler.controller.abort();
      await Promise.allSettled([...schedulers].map((scheduler) => scheduler.done));
      schedulers.clear();
      await Promise.allSettled([...lanes.values()]);
    },
  };
  return Object.freeze(runtime);
}

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

/** Returns the stable operator- and agent-readable object contract. */
export function durableObjectManifest(
  objects: Readonly<Record<string, DurableObjectDefinition<any, any>>>,
): readonly DurableObjectManifestEntry[] {
  const definitions = [...new Set(Object.values(objects))].sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(definitions.map((definition) => Object.freeze({
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    version: definition.version,
    state: definition.state.toJSONSchema(),
    methods: Object.freeze([...flattenMethods(definition.methods)].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, method]) => Object.freeze({
        name,
        kind: method.kind,
        ...(method.description ? { description: method.description } : {}),
        timeoutMs: method.timeoutMs,
        args: method.args.toJSONSchema(),
        ...(method.returns ? { returns: method.returns.toJSONSchema() } : {}),
        agent: method.agent,
      }))),
    alarm: definition.alarm ? Object.freeze({
      ...(definition.alarm.description ? { description: definition.alarm.description } : {}),
      timeoutMs: definition.alarm.timeoutMs ?? 15 * 60_000,
      retry: Object.freeze(normalizeAlarmRetry(definition.alarm.retry)),
    }) : null,
  })));
}

export interface DurableObjectMcpAuthorizationAttempt {
  readonly namespace: string;
  readonly id: string;
  readonly method: string;
  readonly kind: DurableObjectMethodKind;
}

export interface DurableObjectMcpToolsOptions<Context> {
  /** Required application authorization for the exact identity, object ID, and method. */
  authorize(
    context: Context,
    attempt: DurableObjectMcpAuthorizationAttempt,
    request: Request,
  ): boolean | Promise<boolean>;
  /** Tool-name prefix. Defaults to durable_. */
  prefix?: string;
}

/**
 * Converts explicitly agent-enabled methods into MCP tools. The application
 * must authorize every exact object ID; registration never grants data access.
 */
export function durableObjectMcpTools<
  Context,
  Definition extends DurableObjectDefinition<any, any>,
>(
  runtime: DurableObjectRuntime<any>,
  definition: Definition,
  options: DurableObjectMcpToolsOptions<Context>,
): readonly McpTool<Context>[] {
  if (!runtime || typeof runtime.get !== "function") throw new TypeError("Durable object MCP tools require a runtime.");
  if (!definition || definition.kind !== "durable-object") throw new TypeError("Durable object MCP tools require a definition.");
  if (!options || typeof options.authorize !== "function") {
    throw new TypeError("Durable object MCP tools require exact-object authorize().");
  }
  const prefix = options.prefix === undefined
    ? "durable_"
    : boundedText(options.prefix, "durable object MCP prefix", 0, 64);
  if (!/^[A-Za-z0-9._-]*$/u.test(prefix)) throw new TypeError("Durable object MCP prefix contains invalid characters.");
  const names = new Set<string>();
  const tools: McpTool<Context>[] = [];
  for (const [path, method] of [...flattenMethods(definition.methods)].sort(([left], [right]) => left.localeCompare(right))) {
    if (method.agent === false) continue;
    const name = `${prefix}${definition.name}_${path}`.replace(/[^A-Za-z0-9._-]/gu, "_");
    if (name.length === 0 || name.length > 128) throw new TypeError(`Durable object MCP tool name is too long: ${name}`);
    if (names.has(name)) throw new TypeError(`Duplicate durable object MCP tool name: ${name}`);
    names.add(name);
    const inputProperties: Record<string, unknown> = {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$",
        description: `Stable ${definition.name} object ID.`,
      },
      input: method.args.toJSONSchema(),
      ...(method.kind === "mutation" ? {
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable retry key for this mutation.",
        },
      } : {}),
    };
    const outputValue = method.returns?.toJSONSchema() ?? {};
    tools.push(Object.freeze({
      name,
      ...(method.agent.title ? { title: method.agent.title } : {}),
      description: method.agent.description ?? method.description ?? `Invoke ${path} on one ${definition.name} durable object.`,
      inputSchema: {
        type: "object",
        properties: inputProperties,
        required: ["id", "input"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          value: outputValue,
          revision: { type: "integer", minimum: 1 },
          deduplicated: { type: "boolean" },
        },
        required: ["value", "revision", "deduplicated"],
        additionalProperties: false,
      },
      annotations: {
        ...(method.agent.title ? { title: method.agent.title } : {}),
        readOnlyHint: method.kind === "query",
        destructiveHint: method.agent.destructive === true,
        idempotentHint: method.kind === "query" || method.agent.idempotent === true,
        openWorldHint: method.agent.openWorld === true,
      },
      requiredScope: method.kind === "query" ? "agent:read" : "agent:write",
      async invoke(raw: unknown, context: Context, request: Request) {
        const input = exactMcpInput(raw, method.kind === "mutation");
        const id = objectId(input.id);
        const attempt = Object.freeze({ namespace: definition.name, id, method: path, kind: method.kind });
        if (!await options.authorize(context, attempt, request)) {
          throw new McpToolError("FORBIDDEN", "The agent is not authorized for this durable object.");
        }
        const args = method.args.parse(input.input);
        const idempotencyKey = input.idempotencyKey === undefined
          ? undefined
          : boundedText(input.idempotencyKey, "durable object idempotency key", 1, 256);
        return await runtime.get(definition, id).invoke(method as any, args, { idempotencyKey });
      },
    }));
  }
  return Object.freeze(tools);
}

function ensureSchema(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_durable_objects (
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
    object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 256),
    schema_version INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 1000000),
    object_version INTEGER NOT NULL CHECK (object_version >= 1),
    state_json TEXT CHECK (state_json IS NULL OR json_valid(state_json)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    alarm_at INTEGER,
    alarm_attempts INTEGER NOT NULL DEFAULT 0 CHECK (alarm_attempts >= 0),
    alarm_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    PRIMARY KEY (namespace, object_id),
    CHECK ((deleted = 1 AND state_json IS NULL AND alarm_at IS NULL) OR (deleted = 0 AND state_json IS NOT NULL))
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_durable_objects_alarms
    ON clank_durable_objects (alarm_at, namespace, object_id) WHERE alarm_at IS NOT NULL AND deleted = 0`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_durable_objects_leases
    ON clank_durable_objects (lease_until) WHERE lease_until IS NOT NULL`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_durable_object_calls (
    namespace TEXT NOT NULL,
    object_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    method TEXT NOT NULL CHECK (length(method) BETWEEN 1 AND 512),
    arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    object_version INTEGER NOT NULL CHECK (object_version >= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, object_id, idempotency_key)
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_durable_object_calls_retention
    ON clank_durable_object_calls (created_at)`);
}

function snapshot<State>(
  definition: DurableObjectDefinition<State, any>,
  row: ObjectRow,
  maxStateBytes: number,
): DurableObjectSnapshot<State> {
  if (typeof row.state_json !== "string" || byteLength(row.state_json) > maxStateBytes) {
    throw new DurableObjectError("STATE_CORRUPT", `Durable object ${definition.name}/${row.object_id} contains invalid state.`);
  }
  const schemaVersion = positiveInteger(Number(row.schema_version), "durable object schema version");
  if (schemaVersion !== definition.version) {
    throw new DurableObjectError(
      "MIGRATION_REQUIRED",
      `Durable object ${definition.name}/${row.object_id} must be activated before its version ${schemaVersion} state can be inspected as version ${definition.version}.`,
    );
  }
  const state = immutableJson(definition.state.parse(parseJson(row.state_json, "durable object state")));
  const alarmAt = nullableNonNegativeInteger(row.alarm_at, "durable object alarm");
  const attempts = nonNegativeInteger(Number(row.alarm_attempts), "durable object alarm attempts");
  const error = row.alarm_error === null || row.alarm_error === undefined ? undefined : String(row.alarm_error);
  return Object.freeze({
    namespace: definition.name,
    id: String(row.object_id),
    state,
    revision: positiveInteger(Number(row.object_version), "durable object revision"),
    schemaVersion,
    createdAt: nonNegativeInteger(Number(row.created_at), "durable object creation time"),
    updatedAt: nonNegativeInteger(Number(row.updated_at), "durable object update time"),
    alarm: alarmAt === null && attempts === 0 && !error ? null : Object.freeze({
      scheduledAt: alarmAt,
      attempts,
      ...(error ? { lastError: error } : {}),
    }),
  });
}

function methodPath(definition: DurableObjectDefinition<any, any>, method: AnyDurableObjectMethod): string {
  if (!method || typeof method !== "object") throw new TypeError("Expected a durable object method.");
  const path = (method as unknown as Record<PropertyKey, unknown>)[METHOD_PATH];
  if (typeof path !== "string" || flattenMethods(definition.methods).get(path) !== method) {
    throw new TypeError(`Method does not belong to durable object ${definition.name}.`);
  }
  return path;
}

function flattenMethods(
  tree: DurableObjectMethodTree,
  prefix: string[] = [],
  output = new Map<string, AnyDurableObjectMethod>(),
  stack = new Set<object>(),
): Map<string, AnyDurableObjectMethod> {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError(`Durable object method namespace ${prefix.join(".") || "<root>"} must be an object.`);
  }
  if (stack.has(tree)) throw new TypeError("Durable object method trees cannot contain cycles.");
  if (prefix.length > 16) throw new TypeError("Durable object methods cannot be deeper than 16 segments.");
  stack.add(tree);
  try {
    for (const [key, value] of Object.entries(tree)) {
      identifier(key, "durable object method segment", 128);
      const path = [...prefix, key];
      if (isMethod(value)) {
        const name = path.join(".");
        if (output.has(name)) throw new TypeError(`Duplicate durable object method: ${name}`);
        output.set(name, value);
      } else {
        flattenMethods(value, path, output, stack);
      }
    }
  } finally {
    stack.delete(tree);
  }
  return output;
}

function isMethod(value: AnyDurableObjectMethod | DurableObjectMethodTree): value is AnyDurableObjectMethod {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ((value as AnyDurableObjectMethod).kind === "query" || (value as AnyDurableObjectMethod).kind === "mutation")
    && typeof (value as AnyDurableObjectMethod).args?.parse === "function"
    && typeof (value as AnyDurableObjectMethod).handler === "function");
}

function freezeMethodTree(tree: DurableObjectMethodTree): DurableObjectMethodTree {
  return Object.freeze(Object.fromEntries(Object.entries(tree).map(([key, value]) => [
    key,
    isMethod(value) ? value : freezeMethodTree(value),
  ])));
}

function toSchema(args: DurableObjectArgs): Schema<any> {
  if (args && typeof (args as Schema<any>).parse === "function") return args as Schema<any>;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Durable object arguments must be a schema or schema shape.");
  return s.object(args as SchemaShape);
}

function normalizeMigrations(
  version: number,
  input: Readonly<Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown>> | undefined,
): Readonly<Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown>> {
  const source = input ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Durable object migrations must be an object.");
  const output: Record<number, (state: unknown, context: DurableObjectMigrationContext) => unknown> = {};
  for (const [key, migration] of Object.entries(source)) {
    const target = integer(Number(key), "durable object migration version", 2, version);
    if (String(target) !== key) throw new TypeError(`Invalid durable object migration key: ${key}`);
    if (typeof migration !== "function") throw new TypeError(`Durable object migration ${target} must be a function.`);
    output[target] = migration;
  }
  for (let target = 2; target <= version; target++) {
    if (!output[target]) throw new TypeError(`Durable object version ${version} requires migration ${target}.`);
  }
  return Object.freeze(output);
}

function normalizeAgent(input: false | DurableObjectAgentOptions | undefined): false | Readonly<DurableObjectAgentOptions> {
  if (input === false || input === undefined) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Durable object agent metadata must be an object or false.");
  for (const key of ["destructive", "idempotent", "openWorld"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new TypeError(`Durable object agent ${key} must be boolean.`);
  }
  const title = optionalText(input.title, "durable object agent title", 256);
  const description = optionalText(input.description, "durable object agent description", 16 * 1024);
  return Object.freeze({
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    destructive: input.destructive === true,
    idempotent: input.idempotent === true,
    openWorld: input.openWorld === true,
  });
}

function normalizeAlarmRetry(input: DurableObjectAlarmRetryOptions | undefined): Required<DurableObjectAlarmRetryOptions> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new TypeError("Durable object alarm retry options must be an object.");
  }
  return {
    maxAttempts: integer(input?.maxAttempts ?? 5, "durable object alarm maxAttempts", 1, 100),
    initialDelayMs: integer(input?.initialDelayMs ?? 1_000, "durable object alarm initialDelayMs", 0, 24 * 60 * 60_000),
    factor: finiteNumber(input?.factor ?? 2, "durable object alarm factor", 1, 100),
    maxDelayMs: integer(input?.maxDelayMs ?? 15 * 60_000, "durable object alarm maxDelayMs", 0, 30 * 24 * 60 * 60_000),
  };
}

function retryDelay(options: Required<DurableObjectAlarmRetryOptions>, attempt: number): number {
  return Math.min(options.maxDelayMs, Math.floor(options.initialDelayMs * options.factor ** Math.max(0, attempt - 1)));
}

function leaseAvailable(row: ObjectRow, current: number): boolean {
  return row.lease_until === null || row.lease_until === undefined || Number(row.lease_until) <= current;
}

function parseMethodResult(method: AnyDurableObjectMethod, encoded: string): unknown {
  const value = parseJson(encoded, "durable object idempotent result");
  return immutableJson(method.returns ? method.returns.parse(value) : value);
}

function exactMcpInput(value: unknown, mutation: boolean): { id: string; input: unknown; idempotencyKey?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpToolError("INVALID_INPUT", "Durable object tool input must be an object.");
  const source = value as Record<string, unknown>;
  const allowed = new Set(mutation ? ["id", "input", "idempotencyKey"] : ["id", "input"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new McpToolError("INVALID_INPUT", `Unknown durable object tool field: ${key}`);
  }
  if (typeof source.id !== "string" || !("input" in source)) {
    throw new McpToolError("INVALID_INPUT", "Durable object tool input requires id and input.");
  }
  if (source.idempotencyKey !== undefined && typeof source.idempotencyKey !== "string") {
    throw new McpToolError("INVALID_INPUT", "Durable object idempotencyKey must be a string.");
  }
  return {
    id: source.id,
    input: source.input,
    ...(source.idempotencyKey === undefined ? {} : { idempotencyKey: source.idempotencyKey }),
  };
}

function linkedController(external: AbortSignal | undefined, timeoutMs: number, message: string): AbortController {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(external?.reason ?? new DurableObjectError("ABORTED", "Durable object call was aborted."));
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => controller.abort(new DurableObjectError("TIMEOUT", message)), timeoutMs);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  controller.signal.addEventListener("abort", () => {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }, { once: true });
  return controller;
}

function raceAbort<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DurableObjectError("ABORTED", "Durable object call was aborted.");
}

function normalizeCallError(error: unknown, signal: AbortSignal): Error {
  if (error instanceof Error) return error;
  if (signal.aborted && signal.reason instanceof Error) return signal.reason;
  return new DurableObjectError("CALL_FAILED", String(error));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function notify(
  listener: (snapshot: any) => void,
  value: any,
  report: (error: unknown, context?: any) => void,
  context: { namespace: string; id: string },
): void {
  try { listener(value); } catch (error) { report(error, context); }
}

function objectId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value)) {
    throw new TypeError("Durable object ID must be 1-256 characters using letters, numbers, '.', '_', ':', '@', or '-'.");
  }
  return value;
}

function namespaceName(value: string): string {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value)) {
    throw new TypeError("Durable object namespace must start with a letter and contain at most 128 letters, numbers, '.', '_', or '-'.");
  }
  return value;
}

function identifier(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(value)) {
    throw new TypeError(`${name} must start with a letter and contain only letters, numbers, and underscores.`);
  }
  return value;
}

function changeId(namespace: string, id: string): string {
  return `${namespace}/${id}`;
}

function parseChangeId(value: string): { namespace: string; id: string } | null {
  const split = value.indexOf("/");
  if (split <= 0) return null;
  return { namespace: value.slice(0, split), id: value.slice(split + 1) };
}

function encodeJson(value: unknown, name: string, maximum: number): string {
  const encoded = stableStringify(value);
  if (encoded === undefined) throw new TypeError(`${name} must be JSON serializable.`);
  if (byteLength(encoded) > maximum) throw new TypeError(`${name} exceeds ${maximum} bytes.`);
  return encoded;
}

function parseJson(value: string, name: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new DurableObjectError("STATE_CORRUPT", `${name} is not valid JSON.`); }
}

function immutableJson<Value>(value: Value): Value {
  return deepFreeze(JSON.parse(stableStringify(value) ?? "null")) as Value;
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(stableStringify(value) ?? "null") as Value;
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertSynchronous(value: unknown, name: string): void {
  if (value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
    throw new TypeError(`${name} must be synchronous.`);
  }
}

function boundedText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must contain ${minimum}-${maximum} characters without control characters.`);
  }
  return value;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, name, 1, maximum);
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, name: string): number {
  return integer(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, name: string): number {
  return integer(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function nullableNonNegativeInteger(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : nonNegativeInteger(Number(value), name);
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeError(error: unknown, maximum: number): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function secureId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure random UUID support is required for durable objects.");
  return crypto.randomUUID();
}

function processId(): number {
  return Number((globalThis as any).process?.pid ?? 0);
}

const RUNTIME_CLOSED = new DurableObjectError("RUNTIME_CLOSED", "Durable object runtime closed during execution.");
