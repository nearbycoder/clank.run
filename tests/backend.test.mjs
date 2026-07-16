import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DatabaseConflictError,
  createApi,
  createSyncClient,
  defineBackend,
  defineDatabase,
  defineTable,
  openBackend,
  s,
} from "../dist/index.js";

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for database synchronization.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function todoBackend() {
  const schema = defineDatabase({
    todos: defineTable({
      title: s.string({ min: 1 }),
      done: s.boolean(),
    }).index("by_done", ["done"]),
    notes: defineTable({ body: s.string() }),
  });
  return defineBackend({ schema }).functions(({ query, mutation }) => ({
    todos: {
      list: query({
        args: { done: s.optional(s.boolean()) },
        handler: ({ db }, { done }) => {
          const rows = db.table("todos").query().orderBy("_creationTime", "asc");
          return done === undefined ? rows.collect() : rows.where("done", done).collect();
        },
      }),
      add: mutation({
        args: { title: s.string({ min: 1 }) },
        handler: ({ db }, { title }) => db.table("todos").insert({ title, done: false }),
      }),
      toggle: mutation({
        args: { id: s.id("todos") },
        handler: ({ db }, { id }) => {
          const todo = db.table("todos").get(id);
          return todo ? db.table("todos").patch(id, { done: !todo.done }) : null;
        },
      }),
      rename: mutation({
        args: {
          id: s.id("todos"),
          title: s.string({ min: 1 }),
          version: s.number({ integer: true, min: 1 }),
        },
        handler: ({ db }, { id, title, version }) =>
          db.table("todos").patch(id, { title }, { ifVersion: version }),
      }),
      fail: mutation({
        args: {},
        handler: ({ db }) => {
          db.table("todos").insert({ title: "must roll back", done: false });
          throw new Error("rollback");
        },
      }),
    },
    notes: {
      list: query({ args: {}, handler: ({ db }) => db.table("notes").collect() }),
    },
  }));
}

test("SQLite documents validate, query, index, patch, and roll back atomically", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:" });
  const first = runtime.mutation("todos.add", { title: "First" }).value;
  runtime.mutation("todos.add", { title: "Second" });
  assert.equal(runtime.version, 2);
  assert.deepEqual(runtime.query("todos.list", {}).value.map((todo) => todo.title), ["First", "Second"]);
  assert.deepEqual(runtime.query("todos.list", { done: false }).value.map((todo) => todo.title), ["First", "Second"]);
  runtime.mutation("todos.toggle", { id: first });
  assert.equal(runtime.query("todos.list", { done: true }).value[0].title, "First");
  assert.throws(() => runtime.mutation("todos.fail", {}), /rollback/);
  assert.equal(runtime.query("todos.list", {}).value.length, 2);
  assert.throws(() => runtime.mutation("todos.add", { title: "" }), /at least 1/);
  runtime.close();
});

test("database and backend contracts are immutable after definition", () => {
  const table = defineTable({ value: s.string() });
  const schema = defineDatabase({ values: table });
  assert.throws(() => table.owned(), /cannot change/);
  assert.throws(() => table.index("late", ["value"]), /cannot change/);
  assert.equal(Object.isFrozen(schema.tables), true);
  assert.equal(Object.isFrozen(table.indexes), true);

  const backend = defineBackend({ schema }).functions(({ query }) => ({
    values: {
      list: query({ args: {}, handler: ({ db }) => db.table("values").collect() }),
    },
  }));
  assert.equal(Object.isFrozen(backend.functions), true);
  assert.equal(Object.isFrozen(backend.functions.values), true);
});

test("SQLite persists the global live revision across runtime restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-revision-"));
  const path = join(directory, "data.sqlite");
  try {
    const first = await openBackend(todoBackend(), { path });
    first.mutation("todos.add", { title: "Persistent" });
    const version = first.version;
    first.close();

    const second = await openBackend(todoBackend(), { path });
    assert.equal(second.version, version);
    assert.equal(second.query("todos.list", {}).version, version);
    second.mutation("todos.add", { title: "Next revision" });
    assert.equal(second.version, version + 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite upgrades legacy Proact metadata, document tables, and indexes in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-legacy-database-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE proact_meta (_key TEXT PRIMARY KEY, _value INTEGER NOT NULL);
    INSERT INTO proact_meta (_key, _value) VALUES ('global_version', 7);
    CREATE TABLE proact_todos (
      _id TEXT PRIMARY KEY,
      _owner_id TEXT,
      _creation_time INTEGER NOT NULL,
      _version INTEGER NOT NULL,
      _data TEXT NOT NULL CHECK (json_valid(_data))
    );
    CREATE INDEX proact_todos_by_done ON proact_todos (json_extract(_data, '$.done'));
  `);
  legacy.prepare(`INSERT INTO proact_todos
    (_id, _owner_id, _creation_time, _version, _data) VALUES (?, NULL, ?, 1, ?)`)
    .run("legacy-todo", Date.now(), JSON.stringify({ title: "Preserved", done: false }));
  legacy.close();
  try {
    const runtime = await openBackend(todoBackend(), { path, wal: false });
    assert.equal(runtime.version, 7);
    assert.deepEqual(runtime.query("todos.list", {}).value.map((todo) => todo.title), ["Preserved"]);
    runtime.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    const objects = migrated.prepare(
      "SELECT type, name FROM sqlite_master WHERE name LIKE 'clank_%' OR name LIKE 'proact_%' ORDER BY name",
    ).all();
    migrated.close();
    assert.ok(objects.some((entry) => entry.name === "clank_meta"));
    assert.ok(objects.some((entry) => entry.name === "clank_todos"));
    assert.ok(objects.some((entry) => entry.name === "clank_todos_by_done"));
    assert.equal(objects.some((entry) => entry.name.startsWith("proact_")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live queries rerun only for tables they read and publish committed snapshots", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:" });
  const snapshots = [];
  const stop = runtime.subscribe("todos.list", {}, (value, version) => {
    snapshots.push({ titles: value.map((todo) => todo.title), version });
  });
  runtime.mutation("todos.add", { title: "Live" });
  runtime.database.transaction((db) => db.table("notes").insert({ body: "unrelated" }));
  assert.deepEqual(snapshots, [
    { titles: [], version: 0 },
    { titles: ["Live"], version: 1 },
  ]);
  stop();
  runtime.close();
});

test("Fetch RPC validates calls and exposes an SSE initial snapshot", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:", heartbeat: 60_000 });
  const mutation = await runtime.handle(new Request("https://app.test/__clank/mutation/todos.add", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify({ title: "From RPC" }),
  }));
  assert.equal(mutation.status, 200);
  const query = await runtime.handle(new Request("https://app.test/__clank/query/todos.list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal((await query.json()).value[0].title, "From RPC");
  const rejected = await runtime.handle(new Request("https://app.test/__clank/mutation/todos.add", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify({ title: "Nope" }),
  }));
  assert.equal(rejected.status, 403);
  const malformedPath = await runtime.handle(new Request("https://app.test/__clank/query/%E0%A4%A", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(malformedPath.status, 400);
  assert.equal((await malformedPath.json()).error.code, "INVALID_PATH");
  const malformedLive = await runtime.handle(new Request("https://app.test/__clank/live/todos.list?args=%7B"));
  assert.equal(malformedLive.status, 400);
  assert.equal((await malformedLive.json()).error.code, "INVALID_ARGUMENTS");

  const controller = new AbortController();
  const live = await runtime.handle(new Request("https://app.test/__clank/live/todos.list?args=%7B%7D", { signal: controller.signal }));
  assert.equal(live.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = live.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /data: .*From RPC/);
  controller.abort();
  await reader.cancel();
  const shutdownLive = await runtime.handle(new Request(
    "https://app.test/__clank/live/todos.list?args=%7B%7D",
  ));
  const shutdownReader = shutdownLive.body.getReader();
  assert.equal((await shutdownReader.read()).done, false);
  runtime.close();
  assert.equal((await shutdownReader.read()).done, true);
});

test("zero-codegen client references preserve paths and RPC behavior", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:" });
  const api = createApi();
  const client = createSyncClient({
    url: "https://app.test",
    fetch: (url, init) => runtime.handle(new Request(url, init)),
  });
  const id = await client.mutate(api.todos.add, { title: "Typed path" });
  assert.equal(typeof id, "string");
  assert.equal((await client.query(api.todos.list, {}))[0].title, "Typed path");
  runtime.close();
});

test("invalid backend output is redacted as an internal failure", async () => {
  const schema = defineDatabase({
    values: defineTable({ value: s.string() }),
  });
  const definition = defineBackend({ schema }).functions(({ query }) => ({
    broken: query({
      args: {},
      returns: s.number(),
      handler: () => "secret internal output",
    }),
  }));
  const seen = [];
  const runtime = await openBackend(definition, {
    path: ":memory:",
    onError: (error) => seen.push(error),
  });
  const response = await runtime.handle(new Request("https://app.test/__clank/query/broken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.match(body, /BACKEND_ERROR/);
  assert.doesNotMatch(body, /secret internal output/);
  assert.doesNotMatch(body, /INVALID_INPUT/);
  assert.equal(seen.length, 1);
  runtime.close();
});

test("invalid mutation output, failed handlers, and listener faults cannot escape commit atomicity", async () => {
  const schema = defineDatabase({
    values: defineTable({ value: s.string() }),
  });
  const definition = defineBackend({ schema }).functions(({ query, mutation }) => ({
    list: query({
      args: {},
      handler: ({ db }) => db.table("values").collect(),
    }),
    broken: mutation({
      args: {},
      returns: s.number(),
      handler: ({ db }) => {
        db.table("values").insert({ value: "must roll back" });
        return "private invalid output";
      },
    }),
    unserializable: mutation({
      args: {},
      handler: ({ db }) => {
        db.table("values").insert({ value: "must also roll back" });
        return 1n;
      },
    }),
    add: mutation({
      args: { value: s.string() },
      handler: ({ db }, input) => db.table("values").insert(input),
    }),
  }));
  const reported = [];
  const runtime = await openBackend(definition, {
    path: ":memory:",
    onError: (error) => reported.push(error),
  });
  const response = await runtime.handle(new Request("https://app.test/__clank/mutation/broken", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: "{}",
  }));
  assert.equal(response.status, 500);
  assert.equal(runtime.version, 0);
  assert.deepEqual(runtime.query("list", {}).value, []);
  const serializationResponse = await runtime.handle(new Request(
    "https://app.test/__clank/mutation/unserializable",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.test" },
      body: "{}",
    },
  ));
  assert.equal(serializationResponse.status, 500);
  assert.equal(runtime.version, 0);
  assert.deepEqual(runtime.query("list", {}).value, []);

  let healthyListenerCalls = 0;
  let observedChange;
  const stopFault = runtime.database.subscribe(() => {
    throw new Error("observer failed after commit");
  });
  const stopHealthy = runtime.database.subscribe((change) => {
    healthyListenerCalls++;
    observedChange = change;
  });
  assert.doesNotThrow(() => runtime.mutation("add", { value: "committed" }));
  assert.equal(runtime.version, 1);
  assert.equal(runtime.query("list", {}).value[0].value, "committed");
  assert.equal(healthyListenerCalls, 1);
  assert.equal(Object.isFrozen(observedChange), true);
  assert.equal(Object.isFrozen(observedChange.records), true);
  assert.equal(observedChange.tables.has("values"), true);
  assert.equal(observedChange.tables.clear, undefined);
  assert.equal(observedChange.ids.delete, undefined);
  assert.ok(reported.some((error) => String(error).includes("observer failed after commit")));
  stopFault();
  stopHealthy();
  runtime.close();
});

test("document versions reject lost updates and no-op writes do not create revisions", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:" });
  const id = runtime.mutation("todos.add", { title: "Original" }).value;
  const original = runtime.query("todos.list", {}).value[0];
  const originalSnapshot = runtime.query("todos.list", {}).value;
  assert.equal(Object.isFrozen(originalSnapshot), true);
  assert.equal(Object.isFrozen(originalSnapshot[0]), true);
  assert.throws(() => {
    originalSnapshot[0].title = "mutated outside the database";
  }, /read only|extensible|Cannot assign/i);
  assert.equal(original._version, 1);
  assert.equal(runtime.version, 1);

  const noOpPatch = runtime.mutation("todos.rename", {
    id,
    title: "Original",
    version: original._version,
  }).value;
  assert.equal(noOpPatch._version, 1);
  assert.equal(runtime.version, 1);
  const noOpReplace = runtime.database.transaction((db) =>
    db.table("todos").replace(id, { title: "Original", done: false }, { ifVersion: 1 })
  );
  assert.equal(noOpReplace._version, 1);
  assert.equal(runtime.version, 1);

  const changed = runtime.mutation("todos.rename", {
    id,
    title: "Current",
    version: 1,
  }).value;
  assert.equal(changed._version, 2);
  assert.equal(runtime.version, 2);
  assert.throws(
    () => runtime.mutation("todos.rename", { id, title: "Stale", version: 1 }),
    (error) => error instanceof DatabaseConflictError
      && error.expectedVersion === 1
      && error.actualVersion === 2,
  );
  assert.equal(runtime.version, 2);
  assert.equal(runtime.query("todos.list", {}).value[0].title, "Current");

  const staleResponse = await runtime.handle(new Request("https://app.test/__clank/mutation/todos.rename", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify({ id, title: "Still stale", version: 1 }),
  }));
  const staleProblem = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(staleProblem.error.code, "VERSION_CONFLICT");
  assert.deepEqual(staleProblem.error.details, {
    table: "todos",
    id,
    expectedVersion: 1,
    actualVersion: 2,
  });

  const beforeBatch = runtime.version;
  runtime.database.transaction((db) => {
    db.table("notes").insert({ body: "one" });
    db.table("notes").insert({ body: "two" });
  });
  assert.equal(runtime.version, beforeBatch + 1);
  runtime.close();
});

test("subscriber setup failures clean themselves up", async () => {
  const runtime = await openBackend(todoBackend(), { path: ":memory:" });
  let calls = 0;
  assert.throws(
    () => runtime.subscribe("todos.list", {}, () => {
      calls++;
      throw new Error("initial listener failure");
    }),
    /initial listener failure/,
  );
  runtime.mutation("todos.add", { title: "No leaked listener" });
  assert.equal(calls, 1);
  runtime.close();
});

test("multiple runtimes publish one current snapshot and recover safely after journal retention gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-multi-runtime-"));
  const path = join(directory, "app.sqlite");
  const reported = [];
  const first = await openBackend(todoBackend(), {
    path,
    changePollIntervalMs: 0,
    changeRetentionRevisions: 2,
    onError: (error) => reported.push(error),
  });
  const second = await openBackend(todoBackend(), {
    path,
    changePollIntervalMs: 0,
    changeRetentionRevisions: 2,
  });
  try {
    const snapshots = [];
    const stop = first.subscribe("todos.list", {}, (value, version) => {
      snapshots.push({ count: value.length, version });
    });
    for (let index = 0; index < 5; index++) {
      second.mutation("todos.add", { title: `Todo ${index + 1}` });
    }
    assert.deepEqual(snapshots, [{ count: 0, version: 0 }]);
    assert.equal(first.query("todos.list", {}).value.length, 5);
    assert.equal(first.version, 5);
    assert.deepEqual(snapshots.at(-1), { count: 5, version: 5 });
    assert.deepEqual(reported, []);
    stop();
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple runtimes propagate committed changes automatically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-poll-runtime-"));
  const path = join(directory, "app.sqlite");
  const first = await openBackend(todoBackend(), { path, changePollIntervalMs: 10 });
  const second = await openBackend(todoBackend(), { path, changePollIntervalMs: 10 });
  try {
    const snapshots = [];
    const stop = first.subscribe("todos.list", {}, (value, version) => {
      snapshots.push({ titles: value.map((todo) => todo.title), version });
    });
    second.mutation("todos.add", { title: "From another runtime" });
    await waitFor(() => snapshots.at(-1)?.titles[0] === "From another runtime");
    assert.deepEqual(snapshots.at(-1), {
      titles: ["From another runtime"],
      version: 1,
    });
    stop();
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser live queries ignore stale revisions and reject malformed revision metadata", () => {
  let source;
  class FakeEventSource {
    onmessage = null;
    onerror = null;
    closed = false;
    constructor() {
      source = this;
    }
    close() {
      this.closed = true;
    }
  }
  const api = createApi();
  const client = createSyncClient({ eventSource: FakeEventSource });
  client.seed(api.todos.list, {}, [{ title: "seed" }], 5);
  const live = client.live(api.todos.list, {});
  source.onmessage({ data: JSON.stringify({ value: [{ title: "stale" }], version: 4 }) });
  assert.equal(live.data.value[0].title, "seed");
  assert.equal(live.version.value, 5);
  source.onmessage({ data: JSON.stringify({ value: [], version: -1 }) });
  assert.match(String(live.error.value), /invalid revision/);
  assert.equal(live.data.value[0].title, "seed");
  live.dispose();
  assert.equal(source.closed, true);
});

test("SQLite paths are private, reject symlinks, detect corruption, and reserve framework tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-database-security-"));
  const path = join(directory, "app.sqlite");
  const link = join(directory, "linked.sqlite");
  const corrupt = join(directory, "corrupt.sqlite");
  try {
    const runtime = await openBackend(todoBackend(), { path });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    runtime.mutation("todos.add", { title: "journal integrity" });
    runtime.close();
    const tampered = new DatabaseSync(path);
    tampered.prepare("UPDATE clank_meta SET _value = 0 WHERE _key = 'global_version'").run();
    tampered.close();
    await assert.rejects(
      () => openBackend(todoBackend(), { path }),
      /change journal revision .* exceeds global revision/,
    );

    await symlink(path, link);
    await assert.rejects(
      () => openBackend(todoBackend(), { path: link }),
      /symbolic link/,
    );
    await writeFile(corrupt, "not a SQLite database");
    await assert.rejects(
      () => openBackend(todoBackend(), { path: corrupt }),
      /database|SQLite|file is not a database/i,
    );
    for (const name of ["meta", "changes", "migrations", "auth_users", "auth_sessions", "platform_secrets"]) {
      assert.throws(
        () => defineDatabase({ [name]: defineTable({ value: s.string() }) }),
        /reserved/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backend resource limits reject invalid configuration before opening storage", async () => {
  for (const options of [
    { heartbeat: 0 },
    { maxRequestBytes: -1 },
    { maxResponseBytes: 0 },
    { maxLiveArgumentBytes: 0 },
    { maxLivePayloadBytes: 0 },
    { maxLiveConnections: 0 },
    { maxCacheEntries: 0 },
  ]) {
    await assert.rejects(
      () => openBackend(todoBackend(), { path: ":memory:", ...options }),
      /positive integer/,
    );
  }
});
