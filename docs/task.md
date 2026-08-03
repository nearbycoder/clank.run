# Typed tasks, failures, and services

Clank Task is an **opt-in**, dependency-free computation runtime for operations that need stronger
guarantees than an ordinary promise. It makes success, expected failure, and required services
visible in one TypeScript type:

```ts
Task<Success, Failure, Requirements>
```

Nothing else in Clank requires Task. Components, routes, queries, mutations, jobs, and MCP actions
continue to accept ordinary functions and promises. Adopt Task at a risky boundary, in one service,
or across an application without changing the framework's basic programming model.

Import it from the package root or its focused entry point:

```ts
import { Task, Layer, Schedule, service } from "@clank.run/framework/task";
```

## Start with a typed operation

`Task` is lazy: constructing a task does not execute it. `runPromise` executes it and returns its
success value. `runExit` preserves every outcome as data.

```ts
type LoadError =
  | { code: "not-found"; id: string }
  | { code: "unavailable"; message: string };

const loadTodo = (id: string): Task<Todo, LoadError> =>
  Task.tryPromise({
    try: (signal) => fetch(`/api/todos/${id}`, { signal }).then(async (response) => {
      if (response.status === 404) throw { code: "not-found", id };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as Todo;
    }),
    catch: (error): LoadError =>
      typeof error === "object" && error !== null && "code" in error
        ? error as LoadError
        : { code: "unavailable", message: "Todo service is unavailable." },
  });

const title = await Task.runPromise(
  loadTodo("todo_123")
    .map((todo) => todo.title)
    .catchAll((error) => Task.succeed(
      error.code === "not-found" ? "Missing todo" : "Try again",
    )),
);
```

Use `Task.fromPromise(operation)` when `unknown` is an honest failure type. Use
`Task.tryPromise({ try, catch })` when the boundary can translate unknown rejection values into a
stable application error. Both operations receive the runtime `AbortSignal`.

## Outcome model

A Task finishes with an `Exit`:

```ts
type Exit<A, E> =
  | { _tag: "Success"; value: A }
  | { _tag: "Failure"; cause: Cause<E> };
```

`Cause<E>` keeps three important conditions separate:

- `Failure` is an expected, typed business or boundary failure created with `Task.fail()`.
- `Defect` is an unexpected thrown exception or broken runtime invariant.
- `Interrupted` means the task was canceled through structured concurrency or an external signal.

Sequential and parallel causes retain multiple failures when both an operation and cleanup fail.
`catchAll` handles only expected failures. It cannot accidentally swallow a defect or
interruption. Use `catchCause` only at an intentional diagnostic or process boundary.

```ts
const exit = await Task.runExit(loadTodo("todo_123"));

if (Exit.isFailure(exit)) {
  logger.error("Todo task failed", { cause: Cause.pretty(exit.cause) });
}
```

`runPromise` rejects with `TaskExecutionError`, whose `.cause` contains the same structured value.
Do not parse its message or expose raw defects to a client.

## Generator composition

Every Task can be yielded directly, making sequential programs readable without hiding their
failure or requirement channels:

```ts
const program = Task.gen(function* () {
  const account = yield* loadAccount("acct_123");
  const todos = yield* loadTodos(account.id);
  return { account, todos };
});
```

The method forms—`map`, `flatMap`, `tap`, `as`, `mapError`, `catchAll`, `catchCause`, and
`ensuring`—are equally supported. Use whichever form makes data flow easiest for a human or agent
to inspect.

## Typed services and layers

A service token is a nominal runtime key and a TypeScript requirement. Reading it changes the
third channel of the Task type:

```ts
interface Mailer {
  send(input: { to: string; subject: string }, signal: AbortSignal): Promise<void>;
}

const Mailer = service<Mailer>("Mailer");

const sendWelcome = (email: string): Task<void, "delivery-failed", typeof Mailer> =>
  Task.service(Mailer).flatMap((mailer) => Task.tryPromise({
    try: (signal) => mailer.send({ to: email, subject: "Welcome" }, signal),
    catch: () => "delivery-failed" as const,
  }));
```

A `Layer` satisfies one or more requirements. Value layers have no lifecycle:

```ts
const testMailer = Layer.succeed(Mailer, {
  async send() {},
});

await Task.runPromise(sendWelcome("ada@example.com"), { layer: testMailer });
```

Resource layers acquire once per runtime scope, are memoized within that scope, and release in
reverse acquisition order:

```ts
const mailerLayer = Layer.effect(
  Mailer,
  Task.tryPromise({
    try: () => openMailer(),
    catch: () => "mailer-start-failed" as const,
  }),
  (mailer) => Task.fromPromise(() => mailer.close()).catchAll(() => Task.succeed(undefined)),
);
```

Compose independent services with `left.merge(right)`. Duplicate providers fail as defects instead
of silently shadowing each other. A layer can itself require services, and `.provide(layer)` can
scope a layer to one subprogram.

Clank's existing `ServiceRegistry` remains the deployment/service-driver catalog. Task services
solve a different problem: typed, per-program dependency requirements. A Task service may wrap a
registry value when both contracts are useful.

## Resource safety

`Task.acquireRelease()` registers cleanup immediately after successful acquisition. Cleanup runs
exactly once, in LIFO order, on success, typed failure, defect, interruption, or timeout.

```ts
const file = Task.acquireRelease(
  Task.tryPromise({
    try: () => open("report.csv", "r"),
    catch: () => "open-failed" as const,
  }),
  (handle) => Task.fromPromise(() => handle.close())
    .catchAll(() => Task.succeed(undefined)),
);

const read = Task.scoped(
  file.flatMap((handle) => Task.tryPromise({
    try: (signal) => readHandle(handle, signal),
    catch: () => "read-failed" as const,
  })),
);
```

Use `Task.addFinalizer()` for a cleanup action that has no acquired value. Finalizers are
uninterruptible, but they should still be bounded internally: cleanup that never settles prevents
the enclosing scope from closing.

## Retry and schedules

Schedules are reusable values. A schedule receives the typed error, zero-based retry attempt,
elapsed time, and the runtime random source.

```ts
const transient = Schedule.exponential(250, {
  factor: 2,
  maxDelay: 30_000,
  jitter: 0.2,
})
  .intersect(Schedule.recurs(5))
  .while((error: LoadError) => error.code === "unavailable");

const resilientLoad = loadTodo("todo_123")
  .retry(transient)
  .timeout(45_000);
```

- `Schedule.recurs(n)` permits exactly `n` retries after the initial attempt.
- `Schedule.spaced(ms)` uses a fixed delay.
- `Schedule.exponential(base, options)` provides bounded exponential backoff and optional jitter.
- `intersect` requires both schedules to continue and uses the longer delay.
- `union` continues while either schedule continues and uses the shorter available delay.
- `while` retries only matching expected failures.
- `mapDelay` transforms and revalidates each delay.

Retry applies only to typed `Failure`. Defects and interruption are never retried. Durations are
bounded to JavaScript's safe timer range, and injected random sources are validated.

Use durable Clank jobs instead when work must survive a process restart. Task retry is an
in-process execution policy; jobs provide persisted attempts, leases, idempotency, and at-least-once
delivery. The two compose naturally inside a job handler.

## Structured concurrency

`Task.all` runs child scopes concurrently, retains input ordering, limits concurrency, and
interrupts siblings after the first failure:

```ts
const [account, todos, limits] = await Task.runPromise(Task.all(
  [loadAccount(id), loadTodos(id), loadLimits(id)],
  { concurrency: 3 },
));
```

`Task.race(left, right)` returns the first completed `Exit`, interrupts the loser, waits for both
child scopes to close, and then returns. `Task.fork(task)` creates a `Fiber` with `join()`, `exit`,
`interrupt()`, and `done`. A fiber is attached to its parent scope, so returning without joining it
interrupts the child instead of leaking background work.

For long-lived, restart-safe parallel work, prefer workflow graphs. Fibers are intentionally
process-local.

## Cancellation and timeout

Supply an external signal at the runtime boundary:

```ts
const controller = new AbortController();

const running = Task.runExit(program, { signal: controller.signal });
controller.abort("request disconnected");

const exit = await running;
```

Promise integrations must pass the received signal to the underlying API. JavaScript cannot
forcibly stop an arbitrary promise that ignores cancellation. Clank stops awaiting that promise,
closes child scopes, and suppresses late results, but the external operation needs its own signal
support to stop consuming resources.

`task.timeout(milliseconds)` adds `TimeoutError` to the typed failure channel. It interrupts the
child, waits for cleanup, and only then returns the timeout failure.

## Observability

`withSpan(name, attributes?)` delegates to the runtime tracer. Clank's existing observability
tracer implements the compatible shape:

```ts
const observability = createObservability({ serviceName: "todos" });

await Task.runPromise(
  loadTodo(id).withSpan("todo.load", { "todo.source": "sqlite" }),
  { tracer: observability.tracer },
);
```

Use bounded, low-cardinality attributes. Do not attach passwords, tokens, cookies, raw request
bodies, email addresses, or unbounded user-controlled values.

## Deterministic time

`TestClock` makes sleep, retry, race, and timeout deterministic without waiting for wall time:

```ts
const clock = new TestClock(1_000);
const running = Task.runPromise(Task.sleep(5_000).as("done"), { clock });

await Promise.resolve(); // allow the task to register its timer
clock.advance(5_000);

assert.equal(await running, "done");
assert.equal(clock.pending, 0);
```

`set()` cannot move backwards. `runAll()` resolves timers currently registered at the furthest
deadline; advance again after asynchronous continuations schedule more work.

## Use Task at framework boundaries

Routes, mutations, jobs, and MCP actions can run a Task at their existing async boundary:

```ts
const backend = defineBackend({ schema }).functions(({ mutation }) => ({
  todos: {
    remind: mutation({
      args: { id: s.id("todos") },
      handler: async (_context, { id }) => await Task.runPromise(
        remindTodo(id),
        {
          layer: applicationLayer,
          tracer: observability.tracer,
        },
      ),
    }),
  },
}));
```

Translate `TaskExecutionError.cause` into the boundary's stable public error type. Never serialize
an unexpected defect directly to a browser or agent. Existing Clank request limits, authorization,
ownership checks, transactions, and MCP confirmation policies remain authoritative; Task does not
bypass any framework security boundary.

## Choosing the right primitive

Use an ordinary promise when an operation is short, has no managed resources, and `unknown` is an
adequate failure contract. Use Task for typed boundary errors, multi-step resource ownership,
service injection, process-local parallelism, retry, or deterministic timing. Use a durable job,
workflow, or durable object when execution must survive restarts, coordinate across processes, or
retain an auditable history.

This division keeps simple Clank applications simple while giving high-risk paths stronger,
machine-readable semantics.
