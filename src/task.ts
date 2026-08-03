/**
 * Clank Task is an opt-in, dependency-free typed computation runtime.
 *
 * Existing Clank APIs continue to accept ordinary values and promises. Use Task when an operation
 * benefits from typed failures, explicit service requirements, scoped resources, structured
 * cancellation, reusable retry schedules, or deterministic time.
 */

const TASK = Symbol.for("clank.task");
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CONCURRENCY = 1_024;

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

export const Result = Object.freeze({
  ok<A>(value: A): Result<A, never> {
    return Object.freeze({ ok: true, value });
  },
  error<E>(error: E): Result<never, E> {
    return Object.freeze({ ok: false, error });
  },
});

export const Cause = Object.freeze({
  failure<E>(error: E): Cause<E> {
    return Object.freeze({ _tag: "Failure", error });
  },
  defect(defect: unknown): Cause<never> {
    return Object.freeze({ _tag: "Defect", defect });
  },
  interrupted(reason?: unknown): Cause<never> {
    return Object.freeze({ _tag: "Interrupted", reason });
  },
  sequential<E>(causes: readonly Cause<E>[]): Cause<E> {
    return combineCause("Sequential", causes);
  },
  parallel<E>(causes: readonly Cause<E>[]): Cause<E> {
    return combineCause("Parallel", causes);
  },
  pretty<E>(cause: Cause<E>): string {
    switch (cause._tag) {
      case "Failure": return `Failure: ${describeUnknown(cause.error)}`;
      case "Defect": return `Defect: ${describeUnknown(cause.defect)}`;
      case "Interrupted": return `Interrupted${cause.reason === undefined ? "" : `: ${describeUnknown(cause.reason)}`}`;
      case "Sequential": return cause.causes.map((entry) => Cause.pretty(entry)).join(" then ");
      case "Parallel": return cause.causes.map((entry) => Cause.pretty(entry)).join(" and ");
    }
  },
});

export const Exit = Object.freeze({
  succeed<A>(value: A): Exit<A, never> {
    return Object.freeze({ _tag: "Success", value });
  },
  fail<E>(error: E): Exit<never, E> {
    return Object.freeze({ _tag: "Failure", cause: Cause.failure(error) });
  },
  failCause<E>(cause: Cause<E>): Exit<never, E> {
    return Object.freeze({ _tag: "Failure", cause });
  },
  isSuccess<A, E>(exit: Exit<A, E>): exit is { readonly _tag: "Success"; readonly value: A } {
    return exit._tag === "Success";
  },
  isFailure<A, E>(exit: Exit<A, E>): exit is { readonly _tag: "Failure"; readonly cause: Cause<E> } {
    return exit._tag === "Failure";
  },
});

/** Rejection produced by runPromise. Inspect `cause` instead of parsing the message. */
export class TaskExecutionError<E = unknown> extends Error {
  readonly name = "TaskExecutionError";
  constructor(readonly cause: Cause<E>) {
    super(Cause.pretty(cause), { cause: causeValue(cause) });
  }
}

/** A nominal, typed key used to declare a Task service requirement. */
export class Service<Value> {
  readonly key = Symbol();
  readonly _Value!: (_: Value) => Value;
  constructor(readonly name: string) {
    if (!name.trim() || name.length > 128) throw new TypeError("A service name must contain 1 to 128 characters.");
    Object.freeze(this);
  }
}

export function service<Value>(name: string): Service<Value> {
  return new Service<Value>(name);
}

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = Object.freeze({
  now: () => Date.now(),
  sleep(milliseconds, signal) {
    const delay = duration(milliseconds, "sleep duration");
    if (signal.aborted) return Promise.reject(interruption(signal.reason));
    if (delay === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(interruption(signal.reason));
      };
      function done() {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  },
});

/** Manual clock for deterministic retry, timeout, and concurrency tests. */
export class TestClock implements Clock {
  #now: number;
  #sequence = 0;
  #sleepers: Array<{
    at: number;
    sequence: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(now = 0) {
    if (!Number.isFinite(now)) throw new TypeError("TestClock time must be finite.");
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    const delay = duration(milliseconds, "sleep duration");
    if (signal.aborted) return Promise.reject(interruption(signal.reason));
    if (delay === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const sleeper = {
        at: this.#now + delay,
        sequence: this.#sequence++,
        resolve,
        reject,
        signal,
        abort: () => {},
      };
      sleeper.abort = () => {
        this.#sleepers = this.#sleepers.filter((entry) => entry !== sleeper);
        reject(interruption(signal.reason));
      };
      signal.addEventListener("abort", sleeper.abort, { once: true });
      this.#sleepers.push(sleeper);
      this.#sleepers.sort(compareSleeper);
    });
  }

  advance(milliseconds: number): void {
    const next = this.#now + duration(milliseconds, "clock advance");
    this.set(next);
  }

  set(now: number): void {
    if (!Number.isFinite(now) || now < this.#now) throw new TypeError("TestClock cannot move backwards.");
    this.#now = now;
    const ready = this.#sleepers.filter((entry) => entry.at <= now);
    this.#sleepers = this.#sleepers.filter((entry) => entry.at > now);
    for (const sleeper of ready) {
      sleeper.signal.removeEventListener("abort", sleeper.abort);
      sleeper.resolve();
    }
  }

  runAll(): void {
    const last = this.#sleepers.at(-1);
    if (last) this.set(last.at);
  }

  get pending(): number {
    return this.#sleepers.length;
  }
}

export interface ScheduleContext<E> {
  readonly attempt: number;
  readonly elapsed: number;
  readonly error: E;
  readonly random: () => number;
}

/** A reusable retry policy. `next` returns the delay before the next attempt, or null to stop. */
export class Schedule<E = unknown> {
  constructor(readonly next: (context: ScheduleContext<E>) => number | null) {}

  while(predicate: (error: E, attempt: number) => boolean): Schedule<E> {
    return new Schedule((context) => predicate(context.error, context.attempt) ? this.next(context) : null);
  }

  mapDelay(mapper: (delay: number, context: ScheduleContext<E>) => number): Schedule<E> {
    return new Schedule((context) => {
      const delay = this.next(context);
      return delay === null ? null : duration(mapper(delay, context), "scheduled delay");
    });
  }

  intersect<Other>(other: Schedule<Other>): Schedule<E & Other> {
    return new Schedule((context) => {
      const left = this.next(context);
      const right = other.next(context);
      return left === null || right === null ? null : Math.max(left, right);
    });
  }

  union<Other>(other: Schedule<Other>): Schedule<E | Other> {
    return new Schedule((context) => {
      const left = this.next(context as ScheduleContext<E>);
      const right = other.next(context as ScheduleContext<Other>);
      if (left === null) return right;
      if (right === null) return left;
      return Math.min(left, right);
    });
  }

  static recurs(retries: number): Schedule<unknown> {
    const count = integer(retries, "retry count", 0, Number.MAX_SAFE_INTEGER);
    return new Schedule(({ attempt }) => attempt < count ? 0 : null);
  }

  static spaced(milliseconds: number): Schedule<unknown> {
    const delay = duration(milliseconds, "schedule spacing");
    return new Schedule(() => delay);
  }

  static exponential(
    baseMilliseconds: number,
    options: { factor?: number; maxDelay?: number; jitter?: number } = {},
  ): Schedule<unknown> {
    const base = duration(baseMilliseconds, "schedule base");
    const factor = finiteRange(options.factor ?? 2, "schedule factor", 1, 100);
    const maximum = duration(options.maxDelay ?? MAX_TIMER_MS, "maximum schedule delay");
    const jitter = finiteRange(options.jitter ?? 0, "schedule jitter", 0, 1);
    return new Schedule(({ attempt, random }) => {
      const raw = Math.min(maximum, base * factor ** attempt);
      const scale = jitter === 0 ? 1 : 1 - jitter + random() * jitter * 2;
      return Math.min(maximum, Math.max(0, Math.round(raw * scale)));
    });
  }
}

type Environment = Map<symbol, unknown>;
type Finalizer = (exit: Exit<unknown, unknown>) => void | Promise<void>;

/** Runtime resource scope. Finalizers run exactly once in reverse acquisition order. */
export class TaskScope {
  #closed = false;
  #finalizers: Finalizer[] = [];

  add(finalizer: Finalizer): void {
    if (this.#closed) throw new Error("Cannot add a finalizer to a closed Task scope.");
    this.#finalizers.push(finalizer);
  }

  async close(exit: Exit<unknown, unknown> = Exit.succeed(undefined)): Promise<Cause<never> | undefined> {
    if (this.#closed) return undefined;
    this.#closed = true;
    const causes: Cause<never>[] = [];
    for (const finalizer of this.#finalizers.splice(0).reverse()) {
      try { await finalizer(exit); }
      catch (error) { causes.push(Cause.defect(error)); }
    }
    if (causes.length === 0) return undefined;
    return causes.length === 1 ? causes[0] : Cause.sequential(causes);
  }

  get closed(): boolean {
    return this.#closed;
  }
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

interface RuntimeContext {
  environment: Environment;
  scope: TaskScope;
  signal: AbortSignal;
  clock: Clock;
  random: () => number;
  tracer?: TaskTracer;
  layerCache: Map<Layer<any, any, any>, Promise<Exit<Environment, unknown>>>;
}

type Evaluator<A, E> = (context: RuntimeContext) => Promise<Exit<A, E>>;

/**
 * A lazy computation that succeeds with A, fails with typed E, and requires services R.
 * The phantom fields make all three channels visible to TypeScript without runtime overhead.
 */
export class Task<A, E = never, R = never> {
  readonly [TASK] = true;
  readonly _A!: () => A;
  readonly _E!: () => E;
  readonly _R!: (_: R) => void;

  constructor(readonly evaluate: Evaluator<A, E>) {}

  map<B>(mapper: (value: A) => B): Task<B, E, R> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      if (Exit.isFailure(exit)) return exit;
      try { return Exit.succeed(mapper(exit.value)); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  flatMap<B, E2, R2>(next: (value: A) => Task<B, E2, R2>): Task<B, E | E2, R | R2> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      if (Exit.isFailure(exit)) return exit;
      try { return await runEvaluator(next(exit.value), context); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  tap<B, E2, R2>(next: (value: A) => Task<B, E2, R2>): Task<A, E | E2, R | R2> {
    return this.flatMap((value) => next(value).as(value));
  }

  as<B>(value: B): Task<B, E, R> {
    return this.map(() => value);
  }

  mapError<E2>(mapper: (error: E) => E2): Task<A, E2, R> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      if (Exit.isSuccess(exit)) return exit;
      return Exit.failCause(mapFailure(exit.cause, mapper));
    });
  }

  catchAll<B, E2, R2>(recover: (error: E) => Task<B, E2, R2>): Task<A | B, E2, R | R2> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      if (Exit.isSuccess(exit)) return exit;
      if (exit.cause._tag !== "Failure") return exit as Exit<never, E2>;
      try { return await runEvaluator(recover(exit.cause.error), context); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  catchCause<B, E2, R2>(recover: (cause: Cause<E>) => Task<B, E2, R2>): Task<A | B, E2, R | R2> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      if (Exit.isSuccess(exit)) return exit;
      try { return await runEvaluator(recover(exit.cause), context); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  ensuring<R2>(finalizer: Task<unknown, never, R2>): Task<A, E, R | R2> {
    return new Task(async (context) => {
      const exit = await runEvaluator(this, context);
      const finalized = await runEvaluator(finalizer, { ...context, signal: neverAbortedSignal() });
      if (Exit.isFailure(finalized)) {
        const cause = Exit.isFailure(exit)
          ? Cause.sequential([exit.cause, finalized.cause])
          : finalized.cause;
        return Exit.failCause(cause);
      }
      return exit;
    });
  }

  retry(schedule: Schedule<any>): Task<A, E, R> {
    return Task.retry(this, schedule);
  }

  timeout(milliseconds: number): Task<A, E | TimeoutError, R> {
    return Task.timeout(this, milliseconds);
  }

  provide<P, LE, LR>(layer: Layer<P, LE, LR>): Task<A, E | LE, Exclude<R, P> | LR> {
    return provideTask(this, layer);
  }

  withSpan(name: string, attributes?: Record<string, unknown>): Task<A, E, R> {
    const spanName = boundedName(name, "span name");
    const safeAttributes = attributes ? Object.freeze({ ...attributes }) : undefined;
    return new Task(async (context) => {
      if (!context.tracer) return await runEvaluator(this, context);
      try {
        return await context.tracer.trace(spanName, () => runEvaluator(this, context), {
          attributes: safeAttributes,
        });
      } catch (error) {
        return Exit.failCause(Cause.defect(error));
      }
    });
  }

  *[Symbol.iterator](): Generator<Task<A, E, R>, A, A> {
    return yield this;
  }

  static succeed<A>(value: A): Task<A> {
    return new Task(async () => Exit.succeed(value));
  }

  static fail<E>(error: E): Task<never, E> {
    return new Task(async () => Exit.fail(error));
  }

  static failCause<E>(cause: Cause<E>): Task<never, E> {
    return new Task(async () => Exit.failCause(cause));
  }

  static sync<A>(operation: () => A): Task<A> {
    return new Task(async () => {
      try { return Exit.succeed(operation()); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  static suspend<A, E, R>(operation: () => Task<A, E, R>): Task<A, E, R> {
    return new Task(async (context) => {
      try { return await runEvaluator(operation(), context); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  static try<A, E>(operation: () => A, onError: (error: unknown) => E): Task<A, E> {
    return new Task(async () => {
      try { return Exit.succeed(operation()); }
      catch (error) {
        try { return Exit.fail(onError(error)); }
        catch (defect) { return Exit.failCause(Cause.defect(defect)); }
      }
    });
  }

  static tryPromise<A, E>(options: {
    try: (signal: AbortSignal) => Promise<A>;
    catch: (error: unknown) => E;
  }): Task<A, E> {
    return new Task(async (context) => {
      if (context.signal.aborted) return interruptedExit(context.signal.reason);
      try {
        const value = await raceInterruption(options.try(context.signal), context.signal);
        return Exit.succeed(value);
      } catch (error) {
        if (isInterruption(error) || context.signal.aborted) return interruptedExit(context.signal.reason ?? error.reason);
        try { return Exit.fail(options.catch(error)); }
        catch (defect) { return Exit.failCause(Cause.defect(defect)); }
      }
    });
  }

  static fromPromise<A>(operation: (signal: AbortSignal) => Promise<A>): Task<A, unknown> {
    return Task.tryPromise({ try: operation, catch: (error) => error });
  }

  static service<Value>(token: Service<Value>): Task<Value, never, Service<Value>> {
    return new Task(async (context) => context.environment.has(token.key)
      ? Exit.succeed(context.environment.get(token.key) as Value)
      : Exit.failCause(Cause.defect(new MissingServiceError(token.name))));
  }

  static addFinalizer<R>(finalizer: Task<unknown, never, R>): Task<void, never, R> {
    return new Task(async (context) => {
      try {
        context.scope.add(async () => {
          const exit = await runEvaluator(finalizer, { ...context, signal: neverAbortedSignal() });
          if (Exit.isFailure(exit)) throw new TaskExecutionError(exit.cause);
        });
        return Exit.succeed(undefined);
      } catch (error) {
        return Exit.failCause(Cause.defect(error));
      }
    });
  }

  static acquireRelease<A, E, R, R2>(
    acquire: Task<A, E, R>,
    release: (resource: A, exit: Exit<unknown, unknown>) => Task<unknown, never, R2>,
  ): Task<A, E, R | R2> {
    return new Task(async (context) => {
      const acquired = await runEvaluator(acquire, context);
      if (Exit.isFailure(acquired)) return acquired;
      try {
        context.scope.add(async (scopeExit) => {
          const released = await runEvaluator(release(acquired.value, scopeExit), {
            ...context,
            signal: neverAbortedSignal(),
          });
          if (Exit.isFailure(released)) throw new TaskExecutionError(released.cause);
        });
        return acquired;
      } catch (error) {
        return Exit.failCause(Cause.defect(error));
      }
    });
  }

  static scoped<A, E, R>(task: Task<A, E, R>): Task<A, E, R> {
    return new Task((context) => runScoped(task, context));
  }

  static sleep(milliseconds: number): Task<void> {
    const delay = duration(milliseconds, "sleep duration");
    return new Task(async (context) => {
      try {
        await context.clock.sleep(delay, context.signal);
        return Exit.succeed(undefined);
      } catch (error) {
        return interruptedExit(context.signal.reason ?? (isInterruption(error) ? error.reason : error));
      }
    });
  }

  static retry<A, E, R>(task: Task<A, E, R>, schedule: Schedule<any>): Task<A, E, R> {
    return new Task(async (context) => {
      const started = context.clock.now();
      let attempt = 0;
      while (true) {
        const exit = await runEvaluator(task, context);
        if (Exit.isSuccess(exit) || exit.cause._tag !== "Failure") return exit;
        let next: number | null;
        try {
          next = schedule.next({
            attempt,
            elapsed: Math.max(0, context.clock.now() - started),
            error: exit.cause.error,
            random: context.random,
          });
          if (next !== null) next = duration(next, "scheduled delay");
        } catch (error) {
          return Exit.failCause(Cause.defect(error));
        }
        if (next === null) return exit;
        const slept = await runEvaluator(Task.sleep(next), context);
        if (Exit.isFailure(slept)) return slept;
        attempt++;
      }
    });
  }

  static timeout<A, E, R>(task: Task<A, E, R>, milliseconds: number): Task<A, E | TimeoutError, R> {
    const delay = duration(milliseconds, "timeout");
    return new Task(async (context) => {
      const controller = linkedController(context.signal);
      const child = childContext(context, controller.signal);
      const work = runScoped(task, child);
      const timer = context.clock.sleep(delay, controller.signal)
        .then(() => ({ timeout: true as const }))
        .catch(() => ({ timeout: false as const }));
      const winner = await Promise.race([
        work.then((exit) => ({ timeout: false as const, exit })),
        timer,
      ]);
      if (!winner.timeout && "exit" in winner) {
        controller.abort("task completed");
        return winner.exit;
      }
      if (context.signal.aborted) return interruptedExit(context.signal.reason);
      const error = new TimeoutError(delay);
      controller.abort(error);
      await work;
      return Exit.fail(error);
    });
  }

  static all<const Tasks extends readonly Task<any, any, any>[]>(
    tasks: Tasks,
    options: { concurrency?: number } = {},
  ): Task<
    { -readonly [K in keyof Tasks]: Tasks[K] extends Task<infer A, any, any> ? A : never },
    Tasks[number] extends Task<any, infer E, any> ? E : never,
    Tasks[number] extends Task<any, any, infer R> ? R : never
  > {
    const entries = [...tasks];
    const concurrency = integer(
      options.concurrency ?? Math.max(1, entries.length),
      "task concurrency",
      1,
      MAX_CONCURRENCY,
    );
    return new Task(async (context) => {
      if (entries.length === 0) return Exit.succeed([] as any);
      const controller = linkedController(context.signal);
      const output = new Array(entries.length);
      let cursor = 0;
      let failure: Exit<never, unknown> | undefined;
      const worker = async () => {
        while (!failure) {
          const index = cursor++;
          if (index >= entries.length) return;
          const exit = await runScoped(entries[index], childContext(context, controller.signal));
          if (Exit.isFailure(exit)) {
            failure = exit;
            controller.abort("sibling task failed");
            return;
          }
          output[index] = exit.value;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
      return failure ?? Exit.succeed(output as any);
    });
  }

  static race<A, E, R, B, E2, R2>(
    left: Task<A, E, R>,
    right: Task<B, E2, R2>,
  ): Task<A | B, E | E2, R | R2> {
    return new Task(async (context) => {
      const controller = linkedController(context.signal);
      const child = childContext(context, controller.signal);
      const leftRun = runScoped(left, child);
      const rightRun = runScoped(right, child);
      const winner = await Promise.race([leftRun, rightRun]);
      controller.abort("race completed");
      await Promise.allSettled([leftRun, rightRun]);
      return winner;
    });
  }

  static fork<A, E, R>(task: Task<A, E, R>): Task<Fiber<A, E>, never, R> {
    return new Task(async (context) => {
      const controller = linkedController(context.signal);
      const promise = runScoped(task, childContext(context, controller.signal));
      const fiber = new Fiber(promise, controller);
      try { context.scope.add(() => fiber.interrupt("parent scope closed")); }
      catch (error) {
        controller.abort(error);
        return Exit.failCause(Cause.defect(error));
      }
      return Exit.succeed(fiber);
    });
  }

  static gen<A>(
    generator: () => Generator<Task<any, any, any>, A, any>,
  ): Task<A, any, any> {
    return new Task(async (context) => {
      let iterator: Generator<Task<any, any, any>, A, any>;
      try { iterator = generator(); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
      let state: IteratorResult<Task<any, any, any>, A>;
      try { state = iterator.next(); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
      while (!state.done) {
        if (!(state.value instanceof Task)) {
          return Exit.failCause(Cause.defect(new TypeError("Task.gen may only yield Task values.")));
        }
        const exit = await runEvaluator(state.value, context);
        if (Exit.isFailure(exit)) {
          try { iterator.return?.(undefined as A); } catch { /* original cause wins */ }
          return exit;
        }
        try { state = iterator.next(exit.value); }
        catch (error) { return Exit.failCause(Cause.defect(error)); }
      }
      return Exit.succeed(state.value);
    });
  }

  static runExit<A, E, R, LE = never>(task: Task<A, E, R>, ...runtime: TaskRuntimeArguments<R, LE>): Promise<Exit<A, E | LE>> {
    return runTask(task, runtime[0] ?? {});
  }

  static async runPromise<A, E, R, LE = never>(task: Task<A, E, R>, ...runtime: TaskRuntimeArguments<R, LE>): Promise<A> {
    const exit = await runTask(task, runtime[0] ?? {});
    if (Exit.isSuccess(exit)) return exit.value;
    throw new TaskExecutionError(exit.cause);
  }
}

export class Fiber<A, E> {
  #done = false;
  constructor(
    readonly exit: Promise<Exit<A, E>>,
    private readonly controller: AbortController,
  ) {
    void exit.finally(() => { this.#done = true; });
  }

  join(): Task<A, E> {
    return new Task(async (context) => {
      try { return await raceInterruption(this.exit, context.signal); }
      catch (error) { return interruptedExit(isInterruption(error) ? error.reason : context.signal.reason); }
    });
  }

  async interrupt(reason: unknown = "fiber interrupted"): Promise<Exit<A, E>> {
    this.controller.abort(reason);
    return await this.exit;
  }

  get done(): boolean {
    return this.#done;
  }
}

export class TimeoutError extends Error {
  readonly name = "TimeoutError";
  constructor(readonly milliseconds: number) {
    super(`Task timed out after ${milliseconds}ms.`);
  }
}

export class MissingServiceError extends Error {
  readonly name = "MissingServiceError";
  constructor(readonly serviceName: string) {
    super(`Task service is not provided: ${serviceName}`);
  }
}

type LayerBuilder<E> = (context: RuntimeContext) => Promise<Exit<Environment, E>>;

/** A memoized recipe that provides typed services and may own scoped resources. */
export class Layer<Provides, E = never, R = never> {
  readonly _Provides!: () => Provides;
  readonly _E!: () => E;
  readonly _R!: (_: R) => void;
  constructor(readonly buildLayer: LayerBuilder<E>) {}

  merge<P2, E2, R2>(other: Layer<P2, E2, R2>): Layer<Provides | P2, E | E2, R | Exclude<R2, Provides>> {
    return new Layer(async (context) => {
      const left = await buildLayer(this, context);
      if (Exit.isFailure(left)) return left;
      const rightContext = { ...context, environment: mergeEnvironment(context.environment, left.value) };
      const right = await buildLayer(other, rightContext);
      if (Exit.isFailure(right)) return right;
      try { return Exit.succeed(mergeEnvironment(left.value, right.value, true)); }
      catch (error) { return Exit.failCause(Cause.defect(error)); }
    });
  }

  static succeed<Value>(token: Service<Value>, value: Value): Layer<Service<Value>> {
    return new Layer(async () => Exit.succeed(new Map([[token.key, value]])));
  }

  static effect<Value, E, R, R2 = never>(
    token: Service<Value>,
    acquire: Task<Value, E, R>,
    release?: (value: Value) => Task<unknown, never, R2>,
  ): Layer<Service<Value>, E, R | R2> {
    return new Layer(async (context) => {
      const result = await runEvaluator(acquire, context);
      if (Exit.isFailure(result)) return result;
      if (release) {
        try {
          context.scope.add(async () => {
            const released = await runEvaluator(release(result.value), {
              ...context,
              signal: neverAbortedSignal(),
            });
            if (Exit.isFailure(released)) throw new TaskExecutionError(released.cause);
          });
        } catch (error) {
          return Exit.failCause(Cause.defect(error));
        }
      }
      return Exit.succeed(new Map([[token.key, result.value]]));
    });
  }

  static fromValue<Value>(token: Service<Value>, value: Value): Layer<Service<Value>> {
    return Layer.succeed(token, value);
  }
}

export class TaskRuntime<R = never, LE = never> {
  readonly options: TaskRuntimeOptions<R, LE>;
  constructor(...runtime: TaskRuntimeArguments<R, LE>) {
    this.options = runtime[0] ?? {};
  }
  runExit<A, E>(task: Task<A, E, R>): Promise<Exit<A, E | LE>> {
    return Task.runExit(task, this.options);
  }
  runPromise<A, E>(task: Task<A, E, R>): Promise<A> {
    return Task.runPromise(task, this.options);
  }
}

export type TaskRuntimeArguments<R, LE = never> = [R] extends [never]
  ? [options?: TaskRuntimeOptions<R, LE>]
  : [options: TaskRuntimeOptions<R, LE> & { readonly layer: Layer<R, LE, never> }];

export function createTaskRuntime<R = never, LE = never>(...runtime: TaskRuntimeArguments<R, LE>): TaskRuntime<R, LE> {
  return new TaskRuntime(...runtime);
}

async function runTask<A, E, R, LE>(task: Task<A, E, R>, options: TaskRuntimeOptions<R, LE>): Promise<Exit<A, E | LE>> {
  const root = new TaskScope();
  const controller = linkedController(options.signal);
  let random: () => number;
  try { random = checkedRandom(options.random ?? Math.random); }
  catch (error) { return Exit.failCause(Cause.defect(error)); }
  const context: RuntimeContext = {
    environment: new Map(),
    scope: root,
    signal: controller.signal,
    clock: options.clock ?? realClock,
    random,
    tracer: options.tracer,
    layerCache: new Map(),
  };
  let exit: Exit<A, E | LE>;
  try {
    if (options.layer) {
      const provided = await buildLayer(options.layer, context);
      if (Exit.isFailure(provided)) exit = provided;
      else exit = await runEvaluator(task, { ...context, environment: provided.value });
    } else {
      exit = await runEvaluator(task, context);
    }
  } catch (error) {
    exit = Exit.failCause(Cause.defect(error));
  }
  const cleanup = await root.close(exit as Exit<unknown, unknown>);
  controller.abort("task runtime closed");
  return appendCleanup(exit, cleanup);
}

async function runEvaluator<A, E>(task: Task<A, E, any>, context: RuntimeContext): Promise<Exit<A, E>> {
  if (!(task instanceof Task)) return Exit.failCause(Cause.defect(new TypeError("Expected a Clank Task.")));
  if (context.signal.aborted) return interruptedExit(context.signal.reason);
  try { return await task.evaluate(context); }
  catch (error) { return Exit.failCause(Cause.defect(error)); }
}

async function runScoped<A, E>(task: Task<A, E, any>, context: RuntimeContext): Promise<Exit<A, E>> {
  const scope = new TaskScope();
  let exit = await runEvaluator(task, { ...context, scope });
  const cleanup = await scope.close(exit as Exit<unknown, unknown>);
  exit = appendCleanup(exit, cleanup);
  return exit;
}

function provideTask<A, E, R, P, LE, LR>(
  task: Task<A, E, R>,
  layer: Layer<P, LE, LR>,
): Task<A, E | LE, Exclude<R, P> | LR> {
  return new Task(async (context) => {
    const scope = new TaskScope();
    const scoped = { ...context, scope, layerCache: new Map() };
    const built = await buildLayer(layer, scoped);
    let exit: Exit<A, E | LE>;
    if (Exit.isFailure(built)) exit = built as Exit<never, LE>;
    else exit = await runEvaluator(task, {
      ...scoped,
      environment: mergeEnvironment(context.environment, built.value),
    });
    const cleanup = await scope.close(exit as Exit<unknown, unknown>);
    return appendCleanup(exit, cleanup);
  });
}

async function buildLayer<P, E, R>(layer: Layer<P, E, R>, context: RuntimeContext): Promise<Exit<Environment, E>> {
  const cached = context.layerCache.get(layer);
  if (cached) return await cached as Exit<Environment, E>;
  const pending = (async (): Promise<Exit<Environment, E>> => {
    try { return await layer.buildLayer(context); }
    catch (error) { return Exit.failCause(Cause.defect(error)); }
  })();
  context.layerCache.set(layer, pending as Promise<Exit<Environment, unknown>>);
  return await pending;
}

function appendCleanup<A, E>(exit: Exit<A, E>, cleanup?: Cause<never>): Exit<A, E> {
  if (!cleanup) return exit;
  return Exit.failCause(Exit.isFailure(exit)
    ? Cause.sequential([exit.cause, cleanup])
    : cleanup);
}

function mapFailure<E, E2>(cause: Cause<E>, mapper: (error: E) => E2): Cause<E2> {
  switch (cause._tag) {
    case "Failure":
      try { return Cause.failure(mapper(cause.error)); }
      catch (error) { return Cause.defect(error); }
    case "Defect": return cause;
    case "Interrupted": return cause;
    case "Sequential": return Cause.sequential(cause.causes.map((entry) => mapFailure(entry, mapper)));
    case "Parallel": return Cause.parallel(cause.causes.map((entry) => mapFailure(entry, mapper)));
  }
}

function combineCause<E>(tag: "Sequential" | "Parallel", causes: readonly Cause<E>[]): Cause<E> {
  const flattened = causes.flatMap((cause) => cause._tag === tag ? cause.causes : [cause]);
  if (flattened.length === 0) throw new TypeError(`${tag} cause requires at least one cause.`);
  if (flattened.length === 1) return flattened[0];
  return Object.freeze({ _tag: tag, causes: Object.freeze([...flattened]) });
}

function mergeEnvironment(base: Environment, additions: Environment, rejectDuplicates = false): Environment {
  const output = new Map(base);
  for (const [key, value] of additions) {
    if (rejectDuplicates && output.has(key)) throw new Error("Two merged layers provide the same service.");
    output.set(key, value);
  }
  return output;
}

function childContext(context: RuntimeContext, signal: AbortSignal): RuntimeContext {
  return { ...context, signal, layerCache: new Map(context.layerCache) };
}

function linkedController(parent?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!parent) return controller;
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true, signal: controller.signal });
  return controller;
}

let immortalSignal: AbortSignal | undefined;
function neverAbortedSignal(): AbortSignal {
  return immortalSignal ??= new AbortController().signal;
}

class TaskInterruption {
  readonly _tag = "TaskInterruption";
  constructor(readonly reason: unknown) {}
}

function interruption(reason: unknown): TaskInterruption {
  return new TaskInterruption(reason);
}

function isInterruption(value: unknown): value is TaskInterruption {
  return value instanceof TaskInterruption;
}

function interruptedExit(reason: unknown): Exit<never, never> {
  return Exit.failCause(Cause.interrupted(reason));
}

function raceInterruption<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(interruption(signal.reason));
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => finish(() => reject(interruption(signal.reason)));
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function checkedRandom(random: () => number): () => number {
  if (typeof random !== "function") throw new TypeError("Task random source must be a function.");
  return () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("Task random source must return a number from 0 inclusive to 1 exclusive.");
    }
    return value;
  };
}

function duration(value: number, name: string): number {
  return integer(value, name, 0, MAX_TIMER_MS);
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function finiteRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function boundedName(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new TypeError(`${name} must contain 1 to 256 characters.`);
  return normalized;
}

function compareSleeper(left: { at: number; sequence: number }, right: { at: number; sequence: number }): number {
  return left.at - right.at || left.sequence - right.sequence;
}

function causeValue<E>(cause: Cause<E>): unknown {
  if (cause._tag === "Failure") return cause.error;
  if (cause._tag === "Defect") return cause.defect;
  if (cause._tag === "Interrupted") return cause.reason;
  return cause.causes.map(causeValue);
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try { return JSON.stringify(value); }
  catch { return Object.prototype.toString.call(value); }
}
