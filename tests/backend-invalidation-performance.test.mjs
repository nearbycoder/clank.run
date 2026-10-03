import test from "node:test";
import assert from "node:assert/strict";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, openSQLite, s } from "../dist/index.js";

test("bulk invalidation indexes changed records once for cached and evicted live queries", async () => {
  const schema = defineDatabase({ rows: defineTable({ value: s.number() }), other: defineTable({ value: s.number() }) });
  let runs = 0;
  const definition = defineBackend({ schema }).functions(({ query }) => ({
    read: query({ args: { id: s.id("rows") }, handler: ({ db }, { id }) => { runs++; return db.table("rows").get(id).value; } }),
    all: query({ args: {}, handler: ({ db }) => db.table("rows").collect().length }),
    other: query({ args: {}, handler: ({ db }) => db.table("other").collect().length }),
  }));
  const database = await openSQLite(schema);
  let recordReads = 0;
  const observedDatabase = new Proxy(database, { get(target, key) {
    if (key === "subscribe") return (listener) => target.subscribe((change) => listener({
      ...change,
      records: change.records.map((record) => new Proxy(record, { get(record, property) {
        if (property === "table") recordReads++;
        return Reflect.get(record, property);
      } })),
    }));
    return Reflect.get(target, key, target);
  } });
  const runtime = await openBackend(definition, { database: observedDatabase, maxCacheEntries: 1, diagnostics: true, agent: false });
  const disposers = [];
  try {
    const ids = database.transaction((db) => Array.from({ length: 320 }, () => db.table("rows").insert({ value: 0 })));
    const snapshots = ids.slice(0, 256).map(() => []);
    for (const [index, id] of ids.slice(0, 256).entries()) {
      disposers.push(runtime.subscribe("read", { id }, (value) => snapshots[index].push(value)));
    }
    const all = [], other = [];
    disposers.push(runtime.subscribe("all", {}, (value) => all.push(value)));
    disposers.push(runtime.subscribe("other", {}, (value) => other.push(value)));
    recordReads = 0;
    database.transaction((db) => { for (const id of ids.slice(256)) db.table("rows").patch(id, { value: 1 }); });
    assert.ok(recordReads <= 64 * 4, `Expected linear changed-record reads, observed ${recordReads}`);
    assert.equal(runs, 256, "unrelated record subscriptions stay quiet even after cache eviction");
    assert.ok(snapshots.every((values) => values.length === 1));
    assert.deepEqual(all, [320, 320], "table-wide readers still invalidate");
    assert.deepEqual(other, [0], "a different table stays quiet");

    recordReads = 0;
    database.transaction((db) => {
      db.table("rows").patch(ids[0], { value: 2 });
      db.table("rows").patch(ids[255], { value: 3 });
      db.table("other").insert({ value: 1 });
    });
    assert.ok(recordReads <= 3 * 4);
    assert.equal(runs, 258);
    assert.deepEqual(snapshots[0], [0, 2]);
    assert.deepEqual(snapshots[255], [0, 3]);
    assert.deepEqual(other, [0, 1]);
    assert.equal(runtime.inspectQueries().reduce((sum, query) => sum + query.cachedEntries, 0), 1);
    for (const dispose of disposers.splice(0)) dispose();
    database.transaction((db) => db.table("rows").patch(ids[0], { value: 4 }));
    assert.equal(runs, 258);
  } finally { for (const dispose of disposers) dispose(); runtime.close(); }
});

test("batched invalidation retains owner isolation and dynamic record dependencies", async () => {
  const schema = defineDatabase({ rows: defineTable({ value: s.number() }).owned(), selection: defineTable({ target: s.string() }).owned() });
  const auth = defineAuth({ password: { minLength: 8, cost: 1024, maxMemory: 4 * 1024 * 1024 } });
  const definition = defineBackend({ schema, auth }).functions(({ query }) => ({
    read: query({ args: { id: s.id("rows") }, handler: ({ db }, { id }) => db.table("rows").get(id)?.value ?? null }),
    all: query({ args: {}, handler: ({ db }) => db.table("rows").collect().map((row) => row.value).sort((a, b) => a - b) }),
    dynamic: query({ args: {}, handler: ({ db }) => {
      const selected = db.table("selection").query().first();
      return selected ? db.table("rows").get(selected.target)?.value ?? null : null;
    } }),
  }));
  const runtime = await openBackend(definition, { maxCacheEntries: 0, agent: false });
  const disposers = [];
  try {
    async function account(name) {
      const response = await runtime.handle(new Request("https://invalidation.test/__clank/auth/register", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://invalidation.test", "x-clank-client-ip": "127.0.0.1" },
        body: JSON.stringify({ email: `${name}@example.com`, password: "correct horse battery staple", profile: { name } }),
      }));
      assert.equal(response.status, 201);
      const cookie = response.headers.get("set-cookie").split(";", 1)[0];
      const caller = await runtime.caller(new Request("https://invalidation.test/", { headers: { cookie } }));
      const scope = { userId: caller.auth.user.id };
      const ids = runtime.database.transaction((db) => [db.table("rows").insert({ value: 1 }), db.table("rows").insert({ value: 2 })], scope);
      const selection = runtime.database.transaction((db) => db.table("selection").insert({ target: ids[0] }), scope);
      return { caller, ids, scope, selection };
    }
    const alice = await account("alice"), bob = await account("bob");
    const aliceAll = [], aliceDynamic = [], aliceForeign = [], bobAll = [];
    disposers.push(alice.caller.subscribe("all", {}, (value) => aliceAll.push(value)));
    disposers.push(alice.caller.subscribe("dynamic", {}, (value) => aliceDynamic.push(value)));
    disposers.push(alice.caller.subscribe("read", { id: bob.ids[0] }, (value) => aliceForeign.push(value)));
    disposers.push(bob.caller.subscribe("all", {}, (value) => bobAll.push(value)));
    runtime.database.transaction((db) => {
      db.table("rows").patch(alice.ids[0], { value: 10 });
      db.table("rows").patch(alice.ids[1], { value: 20 });
      db.table("selection").patch(alice.selection, { target: alice.ids[1] });
    }, alice.scope);
    assert.deepEqual(aliceAll, [[1, 2], [10, 20]]);
    assert.deepEqual(aliceDynamic, [1, 20], "dependencies switch to the new selected record atomically");
    assert.deepEqual(bobAll, [[1, 2]]);
    runtime.database.transaction((db) => {
      db.table("rows").patch(alice.ids[0], { value: 11 });
      db.table("rows").patch(bob.ids[0], { value: 99 });
    });
    assert.deepEqual(aliceDynamic, [1, 20], "the old dynamic dependency no longer wakes the query");
    assert.deepEqual(aliceForeign, [null], "same document ID in another owner's scope remains irrelevant");
    assert.deepEqual(bobAll, [[1, 2], [2, 99]]);
    runtime.database.transaction((db) => db.table("rows").patch(alice.ids[1], { value: 21 }), alice.scope);
    assert.deepEqual(aliceDynamic, [1, 20, 21], "single-record commits share the same matching rules");
  } finally { for (const dispose of disposers) dispose(); runtime.close(); }
});
