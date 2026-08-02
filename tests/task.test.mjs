import test from "node:test";
import assert from "node:assert/strict";
import {
  Cause,
  Exit,
  Layer,
  MissingServiceError,
  Schedule,
  service,
  Task,
  TaskExecutionError,
  TaskScope,
  TestClock,
  TimeoutError,
} from "../dist/task.js";

test("Task composes lazy success values, generators, and typed recovery", async () => {
  let runs = 0;
  const program = Task.gen(function* () {
    const left = yield* Task.sync(() => { runs++; return 2; });
    const right = yield* Task.succeed(3);
    return left + right;
  }).map((value) => value * 2);

  assert.equal(runs, 0);
  assert.equal(await Task.runPromise(program), 10);
  assert.equal(runs, 1);
  assert.equal(await Task.runPromise(Task.fail("missing").catchAll((error) => Task.succeed(error.length))), 7);
});

test("Task keeps expected failures, defects, and interruption distinct", async () => {
  const expected = await Task.runExit(Task.fail({ code: "not_found" }));
  assert.deepEqual(expected, Exit.fail({ code: "not_found" }));

  const defect = await Task.runExit(Task.sync(() => { throw new Error("bug"); }));
  assert.equal(defect._tag, "Failure");
  assert.equal(defect.cause._tag, "Defect");
  assert.match(Cause.pretty(defect.cause), /bug/);

  const controller = new AbortController();
  controller.abort("stop");
  const interrupted = await Task.runExit(Task.succeed(1), { signal: controller.signal });
  assert.deepEqual(interrupted, Exit.failCause(Cause.interrupted("stop")));
});

test("runPromise rejects with an inspectable TaskExecutionError", async () => {
  await assert.rejects(
    Task.runPromise(Task.fail("invalid")),
    (error) => error instanceof TaskExecutionError
      && error.cause._tag === "Failure"
      && error.cause.error === "invalid",
  );
});

test("services and layers make dependencies explicit and release in reverse order", async () => {
  const Events = service("Events");
  const Prefix = service("Prefix");
  const events = [];
  const eventLayer = Layer.effect(
    Events,
    Task.sync(() => events),
    () => Task.sync(() => { events.push("events:close"); }),
  );
  const prefixLayer = Layer.effect(
    Prefix,
    Task.sync(() => { events.push("prefix:open"); return "clank"; }),
    () => Task.sync(() => { events.push("prefix:close"); }),
  );
  const program = Task.gen(function* () {
    const output = yield* Task.service(Events);
    const prefix = yield* Task.service(Prefix);
    output.push(`${prefix}:run`);
    return output.length;
  });

  assert.equal(await Task.runPromise(program, { layer: eventLayer.merge(prefixLayer) }), 2);
  assert.deepEqual(events, ["prefix:open", "clank:run", "prefix:close", "events:close"]);
});

test("missing services are defects rather than forgeable typed failures", async () => {
  const Database = service("Database");
  const exit = await Task.runExit(Task.service(Database));
  assert.equal(exit._tag, "Failure");
  assert.equal(exit.cause._tag, "Defect");
  assert.ok(exit.cause.defect instanceof MissingServiceError);
});

test("layers are memoized within one scope and duplicate providers fail closed", async () => {
  const Value = service("Value");
  let builds = 0;
  const layer = Layer.effect(Value, Task.sync(() => ++builds));
  const combined = layer.merge(layer);
  const exit = await Task.runExit(Task.service(Value), { layer: combined });
  assert.equal(builds, 1);
  assert.equal(exit._tag, "Failure");
  assert.equal(exit.cause._tag, "Defect");
  assert.match(String(exit.cause.defect), /same service/);
});

test("scoped resources always finalize LIFO and preserve cleanup defects", async () => {
  const events = [];
  const resource = (name) => Task.acquireRelease(
    Task.sync(() => { events.push(`${name}:open`); return name; }),
    () => Task.sync(() => { events.push(`${name}:close`); }),
  );
  const program = Task.scoped(resource("a").flatMap(() => resource("b")).flatMap(() => Task.fail("nope")));
  const exit = await Task.runExit(program);
  assert.equal(exit._tag, "Failure");
  assert.deepEqual(events, ["a:open", "b:open", "b:close", "a:close"]);

  const scope = new TaskScope();
  scope.add(() => { throw new Error("cleanup"); });
  const cause = await scope.close();
  assert.equal(cause._tag, "Defect");
  assert.match(String(cause.defect), /cleanup/);
  assert.equal(await scope.close(), undefined, "a scope closes exactly once");
});

test("retry schedules use deterministic time and stop after the declared retries", async () => {
  const clock = new TestClock(100);
  let attempts = 0;
  const operation = Task.suspend(() => {
    attempts++;
    return attempts < 3 ? Task.fail("temporary") : Task.succeed("ready");
  });
  const result = Task.runPromise(operation.retry(
    Schedule.recurs(4).intersect(Schedule.exponential(10, { jitter: 0 })),
  ), { clock });

  await settle();
  assert.equal(clock.pending, 1);
  clock.advance(10);
  await settle();
  assert.equal(clock.pending, 1);
  clock.advance(20);
  assert.equal(await result, "ready");
  assert.equal(attempts, 3);

  attempts = 0;
  const failed = await Task.runExit(operation.retry(Schedule.recurs(0)), { clock });
  assert.equal(attempts, 1);
  assert.deepEqual(failed, Exit.fail("temporary"));
});

test("timeouts interrupt work and are typed failures", async () => {
  const clock = new TestClock();
  let finalized = false;
  const operation = Task.scoped(
    Task.addFinalizer(Task.sync(() => { finalized = true; }))
      .flatMap(() => Task.sleep(1_000))
      .as("late"),
  );
  const result = Task.runExit(operation.timeout(50), { clock });
  await settle();
  clock.advance(50);
  const exit = await result;
  assert.equal(exit._tag, "Failure");
  assert.equal(exit.cause._tag, "Failure");
  assert.ok(exit.cause.error instanceof TimeoutError);
  assert.equal(finalized, true);
  assert.equal(clock.pending, 0);
});

test("Task.all bounds concurrency, preserves order, and interrupts siblings", async () => {
  let active = 0;
  let maximum = 0;
  let launched = 0;
  const gates = [];
  const work = Array.from({ length: 5 }, (_, index) => Task.tryPromise({
    try: async () => {
      active++;
      launched++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => gates.push(resolve));
      active--;
      return index;
    },
    catch: String,
  }));
  const result = Task.runPromise(Task.all(work, { concurrency: 2 }));
  await settle();
  while (launched < 5) {
    gates.shift()();
    await settle();
  }
  while (gates.length) gates.shift()();
  assert.deepEqual(await result, [0, 1, 2, 3, 4]);
  assert.equal(maximum, 2);

  let siblingInterrupted = false;
  const sibling = Task.tryPromise({
    try: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      siblingInterrupted = true;
      reject(signal.reason);
    }, { once: true })),
    catch: String,
  });
  const delayedFailure = Task.fromPromise(() => new Promise((resolve) => setImmediate(resolve)))
    .flatMap(() => Task.fail("failed"));
  const failed = await Task.runExit(Task.all([delayedFailure, sibling]));
  assert.equal(failed._tag, "Failure");
  assert.equal(siblingInterrupted, true);
});

test("race and fibers use child scopes and structured cancellation", async () => {
  const clock = new TestClock();
  const raced = Task.runPromise(Task.race(Task.sleep(10).as("fast"), Task.sleep(100).as("slow")), { clock });
  await settle();
  clock.advance(10);
  assert.equal(await raced, "fast");
  assert.equal(clock.pending, 0);

  const controller = new AbortController();
  const fiberResult = Task.runPromise(Task.fork(Task.sleep(1_000)), { clock, signal: controller.signal });
  const fiber = await fiberResult;
  const exit = await fiber.exit;
  assert.equal(exit._tag, "Failure", "the root scope interrupts unjoined child fibers");
  assert.equal(exit.cause._tag, "Interrupted");
});

test("withSpan delegates to a compatible Clank tracer", async () => {
  const calls = [];
  const tracer = {
    async trace(name, operation, options) {
      calls.push([name, options]);
      return await operation();
    },
  };
  assert.equal(await Task.runPromise(Task.succeed(42).withSpan("answer", { stable: true }), { tracer }), 42);
  assert.deepEqual(calls, [["answer", { attributes: { stable: true } }]]);
});

test("public limits reject invalid timers, concurrency, schedules, and clocks", () => {
  assert.throws(() => Task.sleep(-1), /sleep duration/);
  assert.throws(() => Task.all([], { concurrency: 0 }), /task concurrency/);
  assert.throws(() => Schedule.exponential(10, { jitter: 2 }), /schedule jitter/);
  const clock = new TestClock(10);
  assert.throws(() => clock.set(9), /backwards/);
});

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
