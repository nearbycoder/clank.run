import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defineDatabase,
  defineBackend,
  defineJobs,
  defineTable,
  nextCronOccurrence,
  normalizeCron,
  openJobs,
  openBackend,
  openSQLite,
  s,
} from "../dist/index.js";

async function fixture(define, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-jobs-"));
  const path = join(root, "app.sqlite");
  const schema = defineDatabase({
    events: defineTable({
      value: s.string(),
    }),
  });
  const definition = defineJobs({ schema }).jobs(({ job }) => define(job, schema));
  const database = await openSQLite(schema, { path, changePollIntervalMs: 0 });
  const runtime = openJobs(definition, { database, ...options });
  return {
    root,
    path,
    schema,
    definition,
    database,
    runtime,
    async close() {
      runtime.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("cron parser supports standard fields, macros, names, steps, and IANA time zones", () => {
  assert.equal(normalizeCron("@daily"), "0 0 * * *");
  assert.equal(normalizeCron("*/15 8-10 * jan,mar mon-fri"), "*/15 8-10 * jan,mar mon-fri");
  assert.throws(() => normalizeCron("* * * *"), /five fields/);
  assert.throws(() => normalizeCron("60 * * * *"), /between 0 and 59/);
  assert.throws(() => nextCronOccurrence("* * * * *", Date.now(), "Not/AZone"), /Unknown IANA time zone/);

  assert.equal(
    new Date(nextCronOccurrence("0 3 * * 1", Date.UTC(2026, 6, 27, 4))).toISOString(),
    "2026-08-03T03:00:00.000Z",
  );
  assert.equal(
    new Date(nextCronOccurrence("0 9 * * *", Date.UTC(2026, 6, 28, 12), "America/Chicago")).toISOString(),
    "2026-07-28T14:00:00.000Z",
  );
});

test("enqueue is durable, validated, idempotent, and atomic with application writes", async () => {
  const app = await fixture((job) => ({
    record: job({
      args: { value: s.string({ min: 1 }) },
      handler: ({ db }, { value }) => db.transaction((tx) => tx.table("events").insert({ value })),
    }),
  }));
  try {
    const first = app.runtime.enqueue(app.definition.jobs.record, { value: "one" }, {
      idempotencyKey: "request-1",
      group: "account-1",
    });
    const duplicate = app.runtime.enqueue(app.definition.jobs.record, { value: "one" }, {
      idempotencyKey: "request-1",
      group: "account-1",
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(app.runtime.stats().queued, 1);
    assert.throws(
      () => app.runtime.enqueue(app.definition.jobs.record, { value: "" }),
      /at least 1/,
    );

    assert.throws(() => app.database.transaction((db) => {
      db.table("events").insert({ value: "rolled back" });
      app.runtime.enqueue(app.definition.jobs.record, { value: "two" });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(app.database.read((db) => db.table("events").collect()).length, 0);
    assert.equal(app.runtime.stats().queued, 1, "the queue insert must share the outer SQLite transaction");

    assert.equal(await app.runtime.workOnce({ workerId: "worker-a" }), true);
    assert.equal(app.runtime.get(first.id).state, "succeeded");
    assert.deepEqual(
      app.database.read((db) => db.table("events").collect()).map((row) => row.value),
      ["one"],
    );
  } finally {
    await app.close();
  }
});

test("backend mutations enqueue through their transaction-scoped jobs context", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-backend-jobs-"));
  const path = join(root, "app.sqlite");
  const schema = defineDatabase({
    events: defineTable({ value: s.string() }),
  });
  const jobs = defineJobs({ schema }).jobs(({ job }) => ({
    deliver: job({
      args: { value: s.string() },
      description: "Deliver one committed application event.",
      agent: { idempotent: true },
      handler: ({ db }, { value }) => db.transaction((tx) => tx.table("events").insert({ value })),
    }),
  }));
  const backend = defineBackend({ schema, jobs }).functions(({ mutation }) => ({
    create: mutation({
      args: { value: s.string(), fail: s.boolean() },
      handler: ({ db, jobs: publisher }, { value, fail }) => {
        db.table("events").insert({ value: `request:${value}` });
        const handle = publisher.enqueue(jobs.jobs.deliver, { value: `job:${value}` });
        if (fail) throw new Error("rollback all");
        return handle.id;
      },
    }),
  }));
  const runtime = await openBackend(backend, { path, changePollIntervalMs: 0 });
  try {
    assert.ok(runtime.jobs);
    assert.throws(() => runtime.mutation("create", { value: "bad", fail: true }), /rollback all/);
    assert.equal(runtime.jobs.stats().queued, 0);
    assert.equal(runtime.database.read((db) => db.table("events").collect()).length, 0);

    const created = runtime.mutation("create", { value: "ok", fail: false }).value;
    assert.equal(runtime.jobs.get(created).state, "queued");
    const manifest = await runtime.handle(new Request("http://app.test/__clank/manifest"));
    assert.equal(manifest.status, 200);
    const payload = await manifest.json();
    assert.equal(payload.jobs[0].name, "deliver");
    assert.equal(payload.jobs[0].description, "Deliver one committed application event.");

    await runtime.jobs.workOnce({ workerId: "backend-worker" });
    assert.deepEqual(
      runtime.database.read((db) => db.table("events").collect()).map((row) => row.value),
      ["request:ok", "job:ok"],
    );
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed jobs retry with bounded backoff and enter dead-letter state", async () => {
  let current = 1_000;
  const attempts = [];
  const app = await fixture((job) => ({
    fail: job({
      args: {},
      retry: {
        maxAttempts: 3,
        initialDelayMs: 100,
        factor: 2,
        maxDelayMs: 500,
        jitter: 0,
      },
      handler: ({ job: metadata }) => {
        attempts.push(metadata.attempt);
        throw new Error("expected failure");
      },
    }),
  }), {
    now: () => current,
    random: () => 0.5,
  });
  try {
    const handle = app.runtime.enqueue(app.definition.jobs.fail, {});
    await app.runtime.workOnce({ workerId: "retry-worker" });
    assert.equal(app.runtime.get(handle.id).state, "retry");
    assert.equal(app.runtime.get(handle.id).runAt, 1_100);
    assert.equal(await app.runtime.workOnce({ workerId: "retry-worker" }), false);

    current = 1_100;
    await app.runtime.workOnce({ workerId: "retry-worker" });
    assert.equal(app.runtime.get(handle.id).state, "retry");
    assert.equal(app.runtime.get(handle.id).runAt, 1_300);

    current = 1_300;
    await app.runtime.workOnce({ workerId: "retry-worker" });
    const dead = app.runtime.get(handle.id);
    assert.equal(dead.state, "dead");
    assert.equal(dead.attempt, 3);
    assert.match(dead.error, /expected failure/);
    assert.deepEqual(attempts, [1, 2, 3]);

    assert.equal(app.runtime.retry(handle.id, { runAt: 2_000 }), true);
    assert.equal(app.runtime.get(handle.id).state, "queued");
    assert.equal(app.runtime.get(handle.id).attempt, 0);
  } finally {
    await app.close();
  }
});

test("expired visibility leases are reclaimed and stale workers cannot settle", async () => {
  let current = 10_000;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let executions = 0;
  const app = await fixture((job) => ({
    slow: job({
      args: {},
      retry: { maxAttempts: 3, initialDelayMs: 0, jitter: 0 },
      handler: async () => {
        executions++;
        if (executions === 1) await firstGate;
        return executions;
      },
    }),
  }), {
    now: () => current,
    random: () => 0.5,
  });
  const secondDatabase = await openSQLite(app.schema, { path: app.path, changePollIntervalMs: 0 });
  const second = openJobs(app.definition, {
    database: secondDatabase,
    now: () => current,
    random: () => 0.5,
  });
  try {
    const handle = app.runtime.enqueue(app.definition.jobs.slow, {});
    const firstWork = app.runtime.workOnce({ workerId: "crashed-worker", leaseMs: 1_000 });
    while (app.runtime.get(handle.id).state !== "running") {
      await new Promise((resolve) => setImmediate(resolve));
    }

    current = 11_001;
    assert.equal(await second.workOnce({ workerId: "replacement-worker", leaseMs: 1_000 }), true);
    assert.equal(second.get(handle.id).state, "succeeded");
    assert.equal(second.get(handle.id).attempt, 2);

    releaseFirst();
    await firstWork;
    assert.equal(second.get(handle.id).state, "succeeded");
    assert.equal(second.get(handle.id).result, 2);
  } finally {
    releaseFirst();
    second.close();
    secondDatabase.close();
    await app.close();
  }
});

test("scheduler creates deterministic occurrences once across competing schedulers", async () => {
  let current = Date.UTC(2026, 6, 28, 8, 59);
  const app = await fixture((job) => ({
    report: job({
      args: { kind: s.literal("daily") },
      schedules: [{
        name: "morning",
        cron: "0 9 * * *",
        timezone: "Etc/UTC",
        args: { kind: "daily" },
        concurrency: "forbid",
        startingDeadlineMs: 60 * 60_000,
        maxCatchUp: 5,
      }],
      handler: () => "ok",
    }),
  }), {
    now: () => current,
  });
  const secondDatabase = await openSQLite(app.schema, { path: app.path, changePollIntervalMs: 0 });
  const second = openJobs(app.definition, { database: secondDatabase, now: () => current });
  try {
    assert.equal(await app.runtime.scheduleOnce({ schedulerId: "scheduler-a" }), 0);
    current = Date.UTC(2026, 6, 28, 9, 0);
    const counts = await Promise.all([
      app.runtime.scheduleOnce({ schedulerId: "scheduler-a" }),
      second.scheduleOnce({ schedulerId: "scheduler-b" }),
    ]);
    assert.equal(counts.reduce((sum, value) => sum + value, 0), 1);
    const [scheduled] = app.runtime.list({ name: "report" });
    assert.equal(scheduled.state, "queued");
    assert.equal(scheduled.scheduledAt, current);
    assert.equal(scheduled.cron, "report:morning");
    assert.equal(await second.scheduleOnce({ schedulerId: "scheduler-b" }), 0);
  } finally {
    second.close();
    secondDatabase.close();
    await app.close();
  }
});

test("cron catch-up, deadlines, and concurrency policies remain bounded", async () => {
  let current = Date.UTC(2026, 6, 28, 8, 59);
  const failures = [];
  const app = await fixture((job) => ({
    catchUp: job({
      args: {},
      schedules: [{
        name: "hourly",
        cron: "0 * * * *",
        args: {},
        startingDeadlineMs: 24 * 60 * 60_000,
        maxCatchUp: 2,
      }],
      handler: () => undefined,
    }),
    deadline: job({
      args: {},
      schedules: [{
        name: "hourly",
        cron: "0 * * * *",
        args: {},
        startingDeadlineMs: 30 * 60_000,
        maxCatchUp: 10,
      }],
      handler: () => undefined,
    }),
    forbid: job({
      args: {},
      schedules: [{
        name: "hourly",
        cron: "0 * * * *",
        args: {},
        concurrency: "forbid",
        startingDeadlineMs: 24 * 60 * 60_000,
        maxCatchUp: 1,
      }],
      handler: () => undefined,
    }),
    replace: job({
      args: {},
      schedules: [{
        name: "hourly",
        cron: "0 * * * *",
        args: {},
        concurrency: "replace",
        startingDeadlineMs: 24 * 60 * 60_000,
        maxCatchUp: 1,
      }],
      handler: () => undefined,
    }),
  }), { now: () => current, onError: (error) => failures.push(String(error)) });
  try {
    current = Date.UTC(2026, 6, 28, 9, 0);
    assert.equal(await app.runtime.scheduleOnce({ schedulerId: "policies" }), 4);
    current = Date.UTC(2026, 6, 28, 12, 0);
    const created = await app.runtime.scheduleOnce({ schedulerId: "policies" });
    assert.equal(created, 4, JSON.stringify({ failures, jobs: app.runtime.list({ limit: 100 }) }));

    assert.equal(app.runtime.list({ name: "catchUp" }).length, 3);
    assert.deepEqual(
      app.runtime.list({ name: "deadline" }).map((entry) => entry.scheduledAt).sort(),
      [
        Date.UTC(2026, 6, 28, 9, 0),
        Date.UTC(2026, 6, 28, 12, 0),
      ],
    );
    assert.equal(app.runtime.list({ name: "forbid" }).length, 1);
    const replacement = app.runtime.list({ name: "replace" });
    assert.equal(replacement.length, 2);
    assert.deepEqual(
      replacement.map((entry) => entry.state).sort(),
      ["cancelled", "queued"],
    );
  } finally {
    await app.close();
  }
});

test("group leases serialize related work while allowing other groups", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executions = [];
  const app = await fixture((job) => ({
    work: job({
      args: { value: s.string() },
      handler: async (_context, { value }) => {
        executions.push(value);
        if (value === "first") await gate;
      },
    }),
  }));
  try {
    app.runtime.enqueue(app.definition.jobs.work, { value: "first" }, { group: "same", priority: 10 });
    app.runtime.enqueue(app.definition.jobs.work, { value: "second" }, { group: "same", priority: 5 });
    app.runtime.enqueue(app.definition.jobs.work, { value: "other" }, { group: "other", priority: 0 });
    const first = app.runtime.workOnce({ workerId: "group-a" });
    while (app.runtime.stats().running !== 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await app.runtime.workOnce({ workerId: "group-b" }), true);
    assert.deepEqual(executions, ["first", "other"]);
    release();
    await first;
    assert.equal(await app.runtime.workOnce({ workerId: "group-b" }), true);
    assert.deepEqual(executions, ["first", "other", "second"]);
  } finally {
    release();
    await app.close();
  }
});

test("queued cancellation and dead-letter retry are explicit operator actions", async () => {
  const app = await fixture((job) => ({
    work: job({
      args: {},
      handler: () => "done",
    }),
  }));
  try {
    const handle = app.runtime.enqueue(app.definition.jobs.work, {}, { delayMs: 10_000 });
    assert.equal(app.runtime.cancel(handle.id), true);
    assert.equal(app.runtime.get(handle.id).state, "cancelled");
    assert.equal(await app.runtime.workOnce({ workerId: "worker" }), false);
    assert.equal(app.runtime.retry(handle.id), true);
    assert.equal(await app.runtime.workOnce({ workerId: "worker" }), true);
    assert.equal(app.runtime.get(handle.id).state, "succeeded");
  } finally {
    await app.close();
  }
});

test("a running job cannot commit success after cancellation is requested", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = await fixture((job) => ({
    work: job({
      args: {},
      handler: async () => {
        await gate;
        return "too late";
      },
    }),
  }));
  try {
    const handle = app.runtime.enqueue(app.definition.jobs.work, {});
    const working = app.runtime.workOnce({ workerId: "cancel-worker" });
    while (app.runtime.get(handle.id).state !== "running") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(app.runtime.cancel(handle.id), true);
    release();
    await working;
    assert.equal(app.runtime.get(handle.id).state, "cancelled");
    assert.equal(app.runtime.get(handle.id).result, undefined);
  } finally {
    release();
    await app.close();
  }
});

test("job history is inspectable and terminal retention is bounded without deleting dead letters", async () => {
  let current = 10_000;
  const app = await fixture((job) => ({
    work: job({
      args: {},
      handler: () => "done",
    }),
    fail: job({
      args: {},
      retry: { maxAttempts: 1 },
      handler: () => {
        throw new Error("keep for an operator");
      },
    }),
  }), {
    now: () => current,
    retention: {
      succeededMs: 1_000,
      cancelledMs: 1_000,
      cleanupIntervalMs: 10_000,
    },
  });
  try {
    const succeeded = app.runtime.enqueue(app.definition.jobs.work, {});
    await app.runtime.workOnce({ workerId: "history-worker" });
    assert.deepEqual(
      app.runtime.events(succeeded.id).map((entry) => entry.event),
      ["succeeded", "claimed", "enqueued"],
    );

    const cancelled = app.runtime.enqueue(app.definition.jobs.work, {}, { delayMs: 10_000 });
    app.runtime.cancel(cancelled.id);
    const dead = app.runtime.enqueue(app.definition.jobs.fail, {});
    await app.runtime.workOnce({ workerId: "history-worker" });
    assert.equal(app.runtime.get(dead.id).state, "dead");
    current += 11_000;
    assert.equal(await app.runtime.workOnce({ workerId: "history-worker" }), false);
    assert.equal(app.runtime.get(succeeded.id), null);
    assert.equal(app.runtime.get(cancelled.id), null);
    assert.deepEqual(app.runtime.events(succeeded.id), []);
    assert.equal(app.runtime.get(dead.id).state, "dead");

    const manual = app.runtime.enqueue(app.definition.jobs.work, {});
    await app.runtime.workOnce({ workerId: "history-worker" });
    assert.equal(app.runtime.purge({
      states: ["succeeded", "cancelled"],
      before: current + 1,
    }), 1);
    assert.equal(app.runtime.get(manual.id), null);
  } finally {
    await app.close();
  }
});

test("application schemas cannot shadow durable job tables", () => {
  for (const name of ["jobs", "job_events", "job_schedules"]) {
    assert.throws(
      () => defineDatabase({ [name]: defineTable({ value: s.string() }) }),
      /reserved for Clank internals/,
    );
  }
});
