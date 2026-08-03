export type Cause<E> =
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Defect"; readonly defect: unknown }
  | { readonly _tag: "Interrupted"; readonly reason: unknown }
  | { readonly _tag: "Sequential"; readonly causes: readonly Cause<E>[] }
  | { readonly _tag: "Parallel"; readonly causes: readonly Cause<E>[] };

export type Exit<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause<E> };

export type Result<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

export declare const Result: Readonly<{
  ok<A>(value: A): Result<A, never>;
  error<E>(error: E): Result<never, E>;
}>;

export declare const Cause: Readonly<{
  failure<E>(error: E): Cause<E>;
  defect(defect: unknown): Cause<never>;
  interrupted(reason?: unknown): Cause<never>;
  sequential<E>(causes: readonly Cause<E>[]): Cause<E>;
  parallel<E>(causes: readonly Cause<E>[]): Cause<E>;
  pretty<E>(cause: Cause<E>): string;
}>;

export declare const Exit: Readonly<{
  succeed<A>(value: A): Exit<A, never>;
  fail<E>(error: E): Exit<never, E>;
  failCause<E>(cause: Cause<E>): Exit<never, E>;
  isSuccess<A, E>(exit: Exit<A, E>): exit is { readonly _tag: "Success"; readonly value: A };
  isFailure<A, E>(exit: Exit<A, E>): exit is { readonly _tag: "Failure"; readonly cause: Cause<E> };
}>;

export declare class TaskExecutionError<E = unknown> extends Error {
  readonly cause: Cause<E>;
  readonly name: "TaskExecutionError";
  constructor(cause: Cause<E>);
}

export declare class Service<Value> {
  readonly name: string;
  readonly key: symbol;
  readonly _Value: (_: Value) => Value;
  constructor(name: string);
}

export declare function service<Value>(name: string): Service<Value>;

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export declare const realClock: Clock;

export declare class TestClock implements Clock {
  constructor(now?: number);
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  advance(milliseconds: number): void;
  set(now: number): void;
  runAll(): void;
  get pending(): number;
}

export interface ScheduleContext<E> {
  readonly attempt: number;
  readonly elapsed: number;
  readonly error: E;
  readonly random: () => number;
}

export declare class Schedule<E = unknown> {
  readonly next: (context: ScheduleContext<E>) => number | null;
  constructor(next: (context: ScheduleContext<E>) => number | null);
  while(predicate: (error: E, attempt: number) => boolean): Schedule<E>;
  mapDelay(mapper: (delay: number, context: ScheduleContext<E>) => number): Schedule<E>;
  intersect<Other>(other: Schedule<Other>): Schedule<E & Other>;
  union<Other>(other: Schedule<Other>): Schedule<E | Other>;
  static recurs(retries: number): Schedule<unknown>;
  static spaced(milliseconds: number): Schedule<unknown>;
  static exponential(
    baseMilliseconds: number,
    options?: { factor?: number; maxDelay?: number; jitter?: number },
  ): Schedule<unknown>;
}

export declare class TaskScope {
  add(finalizer: (exit: Exit<unknown, unknown>) => void | Promise<void>): void;
  close(exit?: Exit<unknown, unknown>): Promise<Cause<never> | undefined>;
  get closed(): boolean;
}

export interface TaskTracer {
  trace<A>(
    name: string,
    operation: () => A | Promise<A>,
    options?: { attributes?: Record<string, unknown> },
  ): Promise<A>;
}

export interface TaskRuntimeOptions<Requirements = never, LayerError = never> {
  readonly layer?: Layer<Requirements, LayerError, never>;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly random?: () => number;
  readonly tracer?: TaskTracer;
}

export declare class Task<A, E = never, R = never> {
  readonly _A: () => A;
  readonly _E: () => E;
  readonly _R: (_: R) => void;
  private constructor();
  map<B>(mapper: (value: A) => B): Task<B, E, R>;
  flatMap<B, E2, R2>(next: (value: A) => Task<B, E2, R2>): Task<B, E | E2, R | R2>;
  tap<B, E2, R2>(next: (value: A) => Task<B, E2, R2>): Task<A, E | E2, R | R2>;
  as<B>(value: B): Task<B, E, R>;
  mapError<E2>(mapper: (error: E) => E2): Task<A, E2, R>;
  catchAll<B, E2, R2>(recover: (error: E) => Task<B, E2, R2>): Task<A | B, E2, R | R2>;
  catchCause<B, E2, R2>(recover: (cause: Cause<E>) => Task<B, E2, R2>): Task<A | B, E2, R | R2>;
  ensuring<R2>(finalizer: Task<unknown, never, R2>): Task<A, E, R | R2>;
  retry(schedule: Schedule<any>): Task<A, E, R>;
  timeout(milliseconds: number): Task<A, E | TimeoutError, R>;
  provide<P, LE, LR>(layer: Layer<P, LE, LR>): Task<A, E | LE, Exclude<R, P> | LR>;
  withSpan(name: string, attributes?: Record<string, unknown>): Task<A, E, R>;
  [Symbol.iterator](): Generator<Task<A, E, R>, A, A>;

  static succeed<A>(value: A): Task<A>;
  static fail<E>(error: E): Task<never, E>;
  static failCause<E>(cause: Cause<E>): Task<never, E>;
  static sync<A>(operation: () => A): Task<A>;
  static suspend<A, E, R>(operation: () => Task<A, E, R>): Task<A, E, R>;
  static try<A, E>(operation: () => A, onError: (error: unknown) => E): Task<A, E>;
  static tryPromise<A, E>(options: {
    try: (signal: AbortSignal) => Promise<A>;
    catch: (error: unknown) => E;
  }): Task<A, E>;
  static fromPromise<A>(operation: (signal: AbortSignal) => Promise<A>): Task<A, unknown>;
  static service<Value>(token: Service<Value>): Task<Value, never, Service<Value>>;
  static addFinalizer<R>(finalizer: Task<unknown, never, R>): Task<void, never, R>;
  static acquireRelease<A, E, R, R2>(
    acquire: Task<A, E, R>,
    release: (resource: A, exit: Exit<unknown, unknown>) => Task<unknown, never, R2>,
  ): Task<A, E, R | R2>;
  static scoped<A, E, R>(task: Task<A, E, R>): Task<A, E, R>;
  static sleep(milliseconds: number): Task<void>;
  static retry<A, E, R>(task: Task<A, E, R>, schedule: Schedule<any>): Task<A, E, R>;
  static timeout<A, E, R>(task: Task<A, E, R>, milliseconds: number): Task<A, E | TimeoutError, R>;
  static all<const Tasks extends readonly Task<any, any, any>[]>(
    tasks: Tasks,
    options?: { concurrency?: number },
  ): Task<
    { -readonly [K in keyof Tasks]: Tasks[K] extends Task<infer A, any, any> ? A : never },
    Tasks[number] extends Task<any, infer E, any> ? E : never,
    Tasks[number] extends Task<any, any, infer R> ? R : never
  >;
  static race<A, E, R, B, E2, R2>(
    left: Task<A, E, R>,
    right: Task<B, E2, R2>,
  ): Task<A | B, E | E2, R | R2>;
  static fork<A, E, R>(task: Task<A, E, R>): Task<Fiber<A, E>, never, R>;
  static gen<A>(generator: () => Generator<Task<any, any, any>, A, any>): Task<A, any, any>;
  static runExit<A, E, R, LE = never>(task: Task<A, E, R>, ...runtime: TaskRuntimeArguments<R, LE>): Promise<Exit<A, E | LE>>;
  static runPromise<A, E, R, LE = never>(task: Task<A, E, R>, ...runtime: TaskRuntimeArguments<R, LE>): Promise<A>;
}

export declare class Fiber<A, E> {
  readonly exit: Promise<Exit<A, E>>;
  join(): Task<A, E>;
  interrupt(reason?: unknown): Promise<Exit<A, E>>;
  get done(): boolean;
}

export declare class TimeoutError extends Error {
  readonly milliseconds: number;
  readonly name: "TimeoutError";
  constructor(milliseconds: number);
}

export declare class MissingServiceError extends Error {
  readonly serviceName: string;
  readonly name: "MissingServiceError";
  constructor(serviceName: string);
}

export declare class Layer<Provides, E = never, R = never> {
  readonly _Provides: () => Provides;
  readonly _E: () => E;
  readonly _R: (_: R) => void;
  merge<P2, E2, R2>(other: Layer<P2, E2, R2>): Layer<Provides | P2, E | E2, R | Exclude<R2, Provides>>;
  static succeed<Value>(token: Service<Value>, value: Value): Layer<Service<Value>>;
  static effect<Value, E, R, R2 = never>(
    token: Service<Value>,
    acquire: Task<Value, E, R>,
    release?: (value: Value) => Task<unknown, never, R2>,
  ): Layer<Service<Value>, E, R | R2>;
  static fromValue<Value>(token: Service<Value>, value: Value): Layer<Service<Value>>;
}

export declare class TaskRuntime<R = never, LE = never> {
  readonly options: TaskRuntimeOptions<R, LE>;
  constructor(...runtime: TaskRuntimeArguments<R, LE>);
  runExit<A, E>(task: Task<A, E, R>): Promise<Exit<A, E | LE>>;
  runPromise<A, E>(task: Task<A, E, R>): Promise<A>;
}

export type TaskRuntimeArguments<R, LE = never> = [R] extends [never]
  ? [options?: TaskRuntimeOptions<R, LE>]
  : [options: TaskRuntimeOptions<R, LE> & { readonly layer: Layer<R, LE, never> }];

export declare function createTaskRuntime<R = never, LE = never>(...runtime: TaskRuntimeArguments<R, LE>): TaskRuntime<R, LE>;
