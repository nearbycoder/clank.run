import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defineDatabase,
  defineDurableObject,
  durableObjectManifest,
  durableObjectMcpTools,
  openDurableObjects,
  openSQLite,
  s,
} from "../dist/index.js";

const emptySchema = defineDatabase({});

function counterDefinition(overrides = {}) {
  return defineDurableObject({
    name: overrides.name ?? "counters",
    description: "A strongly serialized counter.",
    state: s.object({ value: s.number(), label: s.string() }),
    initial: ({ id }) => ({ value: 0, label: id }),
    version: overrides.version,
    migrations: overrides.migrations,
    methods: ({ query, mutation }) => ({
      read: query({
        args: {},
        returns: s.object({ value: s.number(), label: s.string() }),
        description: "Read the current counter.",
        agent: { title: "Read counter", idempotent: true },
        handler: ({ storage }) => storage.get(),
      }),
      add: mutation({
        args: { amount: s.number() },
        returns: s.number(),
        description: "Add to the current counter.",
        agent: { title: "Add to counter", idempotent: true },
        async handler({ storage, signal }, { amount }) {
          const before = storage.get();
          if (overrides.delayMs) await delay(overrides.delayMs, signal);
          storage.set({ ...before, value: before.value + amount });
          return before.value + amount;
        },
      }),
      fail: mutation({
        args: {},
        returns: s.number(),
        handler({ storage }) {
          storage.update((state) => ({ ...state, value: state.value + 100 }));
          throw new Error("intentional failure");
        },
      }),
      remove: mutation({
        args: {},
        returns: s.boolean(),
        agent: { destructive: true },
        handler({ storage }) {
          storage.deleteAll();
          return true;
        },
      }),
      alarm: mutation({
        args: { at: s.number() },
        returns: s.number(),
        handler({ storage }, { at }) {
          storage.setAlarm(at);
          return at;
        },
      }),
    }),
    alarm: overrides.alarm,
  });
}

async function fixture(definition, databaseOptions = {}, runtimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-durable-objects-"));
  const path = join(root, "app.sqlite");
  const database = await openSQLite(emptySchema, { path, changePollIntervalMs: 10, ...databaseOptions });
  const runtime = openDurableObjects({ counter: definition }, { database, ...runtimeOptions });
  return {
    root,
    path,
    database,
    runtime,
    async close() {
      await runtime.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("durable objects persist typed state behind stable namespace IDs", async () => {
  const counter = counterDefinition();
  const app = await fixture(counter);
  try {
    const alpha = app.runtime.get(counter, "alpha");
    assert.equal(alpha.id, "alpha");
    assert.deepEqual(await alpha.call(counter.methods.read, {}), { value: 0, label: "alpha" });
    const changed = await alpha.invoke(counter.methods.add, { amount: 3 });
    assert.deepEqual(changed, { value: 3, revision: 2, deduplicated: false });
    assert.deepEqual(await alpha.call(counter.methods.read, {}), { value: 3, label: "alpha" });

    const snapshot = alpha.inspect();
    assert.equal(snapshot.namespace, "counters");
    assert.equal(snapshot.id, "alpha");
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.schemaVersion, 1);
    assert.deepEqual(snapshot.state, { value: 3, label: "alpha" });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.state), true);
    assert.deepEqual(app.runtime.namespace(counter).list(), [snapshot]);
    assert.deepEqual(app.runtime.diagnostics(), {
      protocol: "clank-durable-objects-diagnostics/1",
      namespaces: 1,
      objects: 1,
      scheduledAlarms: 0,
      dueAlarms: 0,
      leasedObjects: 0,
      activeCalls: 0,
      subscriptions: 0,
    });

    await app.runtime.close();
    app.database.close();
    const reopenedDatabase = await openSQLite(emptySchema, { path: app.path, changePollIntervalMs: 0 });
    const reopened = openDurableObjects({ counter }, { database: reopenedDatabase });
    try {
      assert.deepEqual(await reopened.get(counter, "alpha").call(counter.methods.read, {}), {
        value: 3,
        label: "alpha",
      });
    } finally {
      await reopened.close();
      reopenedDatabase.close();
    }
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test("calls are serialized for each ID locally and across SQLite runtimes", async () => {
  const counter = counterDefinition({ delayMs: 12 });
  const app = await fixture(counter, { changePollIntervalMs: 5 }, { leaseMs: 1_000, acquirePollIntervalMs: 5 });
  let secondDatabase;
  let secondRuntime;
  try {
    const stub = app.runtime.get(counter, "shared");
    await Promise.all(Array.from({ length: 12 }, () => stub.call(counter.methods.add, { amount: 1 })));
    assert.equal((await stub.call(counter.methods.read, {})).value, 12);

    secondDatabase = await openSQLite(emptySchema, { path: app.path, changePollIntervalMs: 5 });
    secondRuntime = openDurableObjects({ counter }, {
      database: secondDatabase,
      leaseMs: 1_000,
      acquirePollIntervalMs: 5,
    });
    await Promise.all([
      app.runtime.get(counter, "shared").call(counter.methods.add, { amount: 5 }),
      secondRuntime.get(counter, "shared").call(counter.methods.add, { amount: 7 }),
    ]);
    assert.equal((await secondRuntime.get(counter, "shared").call(counter.methods.read, {})).value, 24);
  } finally {
    if (secondRuntime) await secondRuntime.close();
    secondDatabase?.close();
    await app.close();
  }
});

test("timeouts and stolen leases fence stale state while leaving the object usable", async () => {
  const counter = counterDefinition({ delayMs: 220 });
  const app = await fixture(counter, {}, { leaseMs: 1_000, acquirePollIntervalMs: 5 });
  try {
    const stub = app.runtime.get(counter, "fenced");
    await assert.rejects(
      stub.call(counter.methods.add, { amount: 1 }, { timeoutMs: 100 }),
      (error) => error.code === "TIMEOUT",
    );
    assert.equal((await stub.call(counter.methods.read, {})).value, 0);

    const pending = stub.call(counter.methods.add, { amount: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const internal = app.database[Symbol.for("clank.sqlite.internal")];
    internal.transaction(() => internal.prepare(`UPDATE clank_durable_objects
      SET lease_token = 'stolen', lease_owner = 'other-runtime', lease_until = 0
      WHERE namespace = ? AND object_id = ?`).run("counters", "fenced"));
    await assert.rejects(pending, (error) => error.code === "LEASE_LOST");
    assert.equal((await stub.call(counter.methods.read, {})).value, 0);
  } finally {
    await app.close();
  }
});

test("mutations roll back on failure and deduplicate exact successful calls", async () => {
  const counter = counterDefinition();
  const app = await fixture(counter);
  try {
    const stub = app.runtime.get(counter, "billing-account");
    await assert.rejects(stub.call(counter.methods.fail, {}), /intentional failure/u);
    assert.equal((await stub.call(counter.methods.read, {})).value, 0);

    const first = await stub.invoke(counter.methods.add, { amount: 9 }, { idempotencyKey: "invoice-42" });
    const duplicate = await stub.invoke(counter.methods.add, { amount: 9 }, { idempotencyKey: "invoice-42" });
    assert.deepEqual(first, { value: 9, revision: 2, deduplicated: false });
    assert.deepEqual(duplicate, { value: 9, revision: 2, deduplicated: true });
    assert.equal((await stub.call(counter.methods.read, {})).value, 9);
    await assert.rejects(
      stub.call(counter.methods.add, { amount: 10 }, { idempotencyKey: "invoice-42" }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      stub.call(counter.methods.read, {}, { idempotencyKey: "invalid" }),
      /only to durable object mutations/u,
    );
  } finally {
    await app.close();
  }
});

test("durable object identity and idempotency ceilings fail closed without committing state", async () => {
  let current = 1_000;
  const counter = counterDefinition({ name: "bounded_counters" });
  const app = await fixture(counter, {}, {
    now: () => current,
    maxObjectsPerNamespace: 2,
    maxIdempotencyRecordsPerObject: 2,
    idempotencyRetentionMs: 60_000,
  });
  try {
    const first = app.runtime.get(counter, "first");
    await first.call(counter.methods.add, { amount: 1 }, { idempotencyKey: "request-1" });
    await first.call(counter.methods.add, { amount: 1 }, { idempotencyKey: "request-2" });
    await assert.rejects(
      first.call(counter.methods.add, { amount: 1 }, { idempotencyKey: "request-3" }),
      (error) => error.code === "IDEMPOTENCY_LIMIT",
    );
    assert.equal((await first.call(counter.methods.read, {})).value, 2);

    current = 61_001;
    const expiredRetry = await first.invoke(
      counter.methods.add,
      { amount: 1 },
      { idempotencyKey: "request-1" },
    );
    assert.equal(expiredRetry.deduplicated, false, "expired keys stop deduplicating even after an idle period");
    assert.equal(expiredRetry.value, 3);

    await app.runtime.get(counter, "second").call(counter.methods.read, {});
    await assert.rejects(
      app.runtime.get(counter, "third").call(counter.methods.read, {}),
      (error) => error.code === "OBJECT_LIMIT",
    );
    await first.call(counter.methods.remove, {});
    await assert.rejects(
      app.runtime.get(counter, "third").call(counter.methods.read, {}),
      (error) => error.code === "OBJECT_LIMIT",
      "tombstones remain capacity-accounted so ID churn cannot bypass the ceiling",
    );

    const resumed = await first.invoke(
      counter.methods.add,
      { amount: 1 },
      { idempotencyKey: "request-3" },
    );
    assert.equal(resumed.deduplicated, false);
    assert.equal(resumed.value, 1, "the known ID reinitializes after deletion without consuming capacity");
  } finally {
    await app.close();
  }
});

test("idempotency cleanup is namespace-scoped and cannot turn a committed call into an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-durable-cleanup-"));
  const path = join(root, "app.sqlite");
  const database = await openSQLite(emptySchema, { path, changePollIntervalMs: 0 });
  const short = counterDefinition({ name: "short_retention" });
  const long = counterDefinition({ name: "long_retention" });
  let current = 1_000;
  const reported = [];
  const shortRuntime = openDurableObjects({ short }, {
    database,
    now: () => current,
    idempotencyRetentionMs: 60_000,
    onError: (error) => reported.push(error),
  });
  const longRuntime = openDurableObjects({ long }, {
    database,
    now: () => current,
    idempotencyRetentionMs: 120_000,
  });
  try {
    const shortStub = shortRuntime.get(short, "shared");
    const longStub = longRuntime.get(long, "shared");
    await shortStub.invoke(short.methods.add, { amount: 1 }, { idempotencyKey: "same-request" });
    await longStub.invoke(long.methods.add, { amount: 1 }, { idempotencyKey: "same-request" });

    current = 61_001;
    assert.equal(await shortStub.call(short.methods.add, { amount: 1 }), 2);
    const retained = await longStub.invoke(long.methods.add, { amount: 1 }, { idempotencyKey: "same-request" });
    assert.equal(retained.deduplicated, true, "short retention must not delete another namespace's ledger");
    const expired = await shortStub.invoke(short.methods.add, { amount: 1 }, { idempotencyKey: "same-request" });
    assert.equal(expired.deduplicated, false);

    const internal = database[Symbol.for("clank.sqlite.internal")];
    internal.exec(`CREATE TRIGGER deny_durable_cleanup BEFORE DELETE ON clank_durable_object_calls
      BEGIN SELECT RAISE(FAIL, 'cleanup denied'); END`);
    current = 181_002;
    const committed = await shortStub.call(short.methods.add, { amount: 1 });
    assert.equal(committed, 4, "maintenance failure cannot hide a committed mutation result");
    assert.equal((await shortStub.call(short.methods.read, {})).value, 4);
    assert.ok(reported.some((error) => String(error).includes("cleanup denied")));
  } finally {
    await shortRuntime.close();
    await longRuntime.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deletion publishes a tombstone and the next call reinitializes the stable ID", async () => {
  const counter = counterDefinition();
  const app = await fixture(counter);
  try {
    const stub = app.runtime.get(counter, "temporary");
    await stub.call(counter.methods.add, { amount: 4 });
    assert.equal(await stub.call(counter.methods.remove, {}), true);
    assert.equal(stub.inspect(), null);
    assert.equal(app.runtime.namespace(counter).list().length, 0);
    const reinitialized = await stub.invoke(
      counter.methods.add,
      { amount: 1 },
      { idempotencyKey: "prior-incarnation" },
    );
    assert.equal(reinitialized.deduplicated, false);
    assert.equal(await stub.call(counter.methods.remove, {}), true);
    const nextIncarnation = await stub.invoke(
      counter.methods.add,
      { amount: 1 },
      { idempotencyKey: "prior-incarnation" },
    );
    assert.equal(nextIncarnation.deduplicated, false, "reinitialization cannot replay a prior incarnation's result");
    assert.deepEqual(await stub.call(counter.methods.read, {}), { value: 1, label: "temporary" });
    assert.ok(stub.inspect().revision > 2);
  } finally {
    await app.close();
  }
});

test("subscriptions use the shared database revision journal", async () => {
  const counter = counterDefinition();
  const app = await fixture(counter, { changePollIntervalMs: 5 });
  let secondDatabase;
  let secondRuntime;
  try {
    secondDatabase = await openSQLite(emptySchema, { path: app.path, changePollIntervalMs: 5 });
    secondRuntime = openDurableObjects({ counter }, { database: secondDatabase });
    const values = [];
    const unsubscribe = app.runtime.get(counter, "live").subscribe((snapshot) => {
      values.push(snapshot?.state.value ?? null);
    });
    assert.deepEqual(values, [null]);
    await secondRuntime.get(counter, "live").call(counter.methods.add, { amount: 6 });
    await waitFor(() => values.includes(6));
    unsubscribe();
    assert.equal(app.runtime.diagnostics().subscriptions, 0);
  } finally {
    if (secondRuntime) await secondRuntime.close();
    secondDatabase?.close();
    await app.close();
  }
});

test("alarms commit state, reschedule failures, and retain terminal diagnostics", async () => {
  let current = 1_000;
  let attempts = 0;
  const counter = counterDefinition({
    alarm: {
      description: "Increment from a durable alarm.",
      retry: { maxAttempts: 2, initialDelayMs: 50, factor: 1, maxDelayMs: 50 },
      handler({ storage }) {
        attempts++;
        if (attempts === 1) throw new Error("transient alarm failure");
        storage.update((state) => ({ ...state, value: state.value + 1 }));
      },
    },
  });
  const app = await fixture(counter, {}, { now: () => current });
  try {
    const stub = app.runtime.get(counter, "clock");
    await stub.call(counter.methods.alarm, { at: current });
    assert.equal(await app.runtime.runAlarmsOnce(), 0, "failed alarms are not counted as completed");
    let snapshot = stub.inspect();
    assert.equal(snapshot.alarm.attempts, 1);
    assert.equal(snapshot.alarm.scheduledAt, 1_050);
    assert.match(snapshot.alarm.lastError, /transient alarm failure/u);
    current = 1_050;
    assert.equal(await app.runtime.runAlarmsOnce(), 1);
    snapshot = stub.inspect();
    assert.equal(snapshot.state.value, 1);
    assert.equal(snapshot.alarm, null);
  } finally {
    await app.close();
  }
});

test("exhausted alarms park with bounded diagnostics instead of looping", async () => {
  let current = 2_000;
  const counter = counterDefinition({
    name: "parked_alarms",
    alarm: {
      retry: { maxAttempts: 2, initialDelayMs: 10, factor: 1, maxDelayMs: 10 },
      handler() { throw new Error(`permanent\nalarm\u0000failure ${"🔥".repeat(200)}`); },
    },
  });
  const app = await fixture(counter, {}, { now: () => current, maxErrorBytes: 256 });
  try {
    const stub = app.runtime.get(counter, "clock");
    await stub.call(counter.methods.alarm, { at: current });
    assert.equal(await app.runtime.runAlarmsOnce(), 0);
    current += 10;
    assert.equal(await app.runtime.runAlarmsOnce(), 0);
    const snapshot = stub.inspect();
    assert.equal(snapshot.alarm.scheduledAt, null);
    assert.equal(snapshot.alarm.attempts, 2);
    assert.match(snapshot.alarm.lastError, /permanent alarm failure/u);
    assert.ok(new TextEncoder().encode(snapshot.alarm.lastError).byteLength <= 256);
    assert.doesNotMatch(snapshot.alarm.lastError, /[\u0000-\u001f\u007f]/u);
    assert.equal(app.runtime.diagnostics().dueAlarms, 0);
  } finally {
    await app.close();
  }
});

test("versioned state migrations are deterministic and persisted before inspection", async () => {
  const v1 = counterDefinition({ name: "migration_counter" });
  const app = await fixture(v1);
  try {
    await app.runtime.get(v1, "legacy").call(v1.methods.add, { amount: 2 });
    await app.runtime.close();
    app.database.close();

    const v2 = defineDurableObject({
      name: "migration_counter",
      state: s.object({ value: s.number(), label: s.string(), migrated: s.boolean() }),
      initial: ({ id }) => ({ value: 0, label: id, migrated: true }),
      version: 2,
      migrations: {
        2: (state) => ({ ...state, migrated: true }),
      },
      methods: ({ query }) => ({
        read: query({
          args: {},
          returns: s.object({ value: s.number(), label: s.string(), migrated: s.boolean() }),
          handler: ({ storage }) => storage.get(),
        }),
      }),
    });
    const database = await openSQLite(emptySchema, { path: app.path, changePollIntervalMs: 0 });
    const runtime = openDurableObjects({ counter: v2 }, { database });
    try {
      assert.throws(() => runtime.get(v2, "legacy").inspect(), /must be activated/u);
      assert.deepEqual(await runtime.get(v2, "legacy").call(v2.methods.read, {}), {
        value: 2,
        label: "legacy",
        migrated: true,
      });
      assert.equal(runtime.get(v2, "legacy").inspect().schemaVersion, 2);
    } finally {
      await runtime.close();
      database.close();
    }
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test("definitions validate boundaries and expose an agent-readable contract", async () => {
  const counter = counterDefinition();
  const manifest = durableObjectManifest({ counter });
  assert.equal(manifest[0].name, "counters");
  assert.equal(manifest[0].state.type, "object");
  assert.equal(manifest[0].methods.find((method) => method.name === "add").kind, "mutation");
  assert.equal(manifest[0].methods.find((method) => method.name === "add").agent.idempotent, true);
  assert.equal(Object.isFrozen(manifest), true);

  const root = await mkdtemp(join(tmpdir(), "clank-durable-mcp-"));
  const database = await openSQLite(emptySchema, { path: join(root, "app.sqlite"), changePollIntervalMs: 0 });
  const runtime = openDurableObjects({ counter }, { database });
  try {
    const attempts = [];
    const tools = durableObjectMcpTools(runtime, counter, {
      authorize(context, attempt) {
        attempts.push(attempt);
        return context.user === "alice" && attempt.id === "allowed";
      },
    });
    assert.deepEqual(tools.map((tool) => tool.name), ["durable_counters_add", "durable_counters_read", "durable_counters_remove"]);
    const addTool = tools.find((tool) => tool.name === "durable_counters_add");
    const readTool = tools.find((tool) => tool.name === "durable_counters_read");
    const removeTool = tools.find((tool) => tool.name === "durable_counters_remove");
    assert.equal(addTool.requiredScope, "agent:write");
    assert.equal(readTool.requiredScope, "agent:read");
    assert.equal(removeTool.annotations.destructiveHint, true);
    const result = await addTool.invoke(
      { id: "allowed", input: { amount: 2 }, idempotencyKey: "agent-call-1" },
      { user: "alice" },
      new Request("https://app.test/__clank/mcp"),
    );
    assert.deepEqual(result, { value: 2, revision: 2, deduplicated: false });
    await assert.rejects(
      readTool.invoke({ id: "denied", input: {} }, { user: "alice" }, new Request("https://app.test/__clank/mcp")),
      (error) => error.code === "FORBIDDEN",
    );
    assert.deepEqual(attempts.map((attempt) => attempt.id), ["allowed", "denied"]);
  } finally {
    await runtime.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }

  assert.throws(() => counterDefinition({ name: "invalid/name" }), /namespace/u);
  assert.throws(() => defineDurableObject({
    name: "missing_migrations",
    state: s.object({ value: s.number() }),
    initial: { value: 0 },
    version: 2,
    methods: ({ query }) => ({ read: query({ args: {}, handler: ({ storage }) => storage.get() }) }),
  }), /requires migration 2/u);

  const app = await fixture(counter);
  try {
    assert.throws(() => app.runtime.get(counter, "spaces are unsafe"), /Durable object ID/u);
    assert.throws(() => openDurableObjects({ first: counter, second: counter }, { database: app.database }), /Duplicate durable object namespace/u);
  } finally {
    await app.close();
  }
});

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for durable object observation.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
