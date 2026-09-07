import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfflineQueue, renderOfflineQueue, createSyncClient, createApi, defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "../dist/index.js";

const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ title: s.string() }).owned() }),
  auth: defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }) }).functions(({ query, mutation }) => ({
  list: query({ args: {}, handler: ({ db }) => db.table("items").collect() }),
  add: mutation({ args: { title: s.string() }, handler: ({ db }, args) => db.table("items").insert(args) }),
  rename: mutation({ args: { id: s.id("items"), title: s.string(), version: s.number() },
    handler: ({ db }, { id, title, version }) => db.table("items").patch(id, { title }, { ifVersion: version }) }),
  fail: mutation({ args: {}, handler: ({ db }) => { db.table("items").insert({ title: "rolled back" }); throw new Error("failure"); } }),
}));
const api = createApi();
function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
async function register(runtime, email) {
  const response = await runtime.handle(new Request("https://offline.test/__clank/auth/register", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://offline.test" }, body: JSON.stringify({ email, password: "correct horse battery staple" }),
  }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: payload.csrfToken, userId: payload.user.id };
}

test("offline mutations survive lost responses and restart, enforce account binding, and resolve optimistic conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-offline-"));
  const options = { path: join(root, "app.sqlite"), offlineMutations: {}, agent: false };
  let runtime = await openBackend(definition, options);
  try {
    const alice = await register(runtime, "alice@example.invalid");
    const bob = await register(runtime, "bob@example.invalid");
    let session = alice;
    let loseResponse = true;
    const client = createSyncClient({ url: "https://offline.test", auth: { csrfHeader: () => ({ "x-clank-csrf": session.csrf }) },
      fetch: async (url, init) => {
        const response = await runtime.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: session.cookie, origin: "https://offline.test" } }));
        if (loseResponse && String(url).includes("/mutation/")) { loseResponse = false; throw new TypeError("connection lost after commit"); }
        return response;
      },
    });
    const local = storage();
    const queueOptions = { namespace: "test", userId: alice.userId, currentUser: () => session.userId, storage: local, client };
    let queue = createOfflineQueue(queueOptions);
    const id = await queue.enqueue(api.add, { title: "Once" });
    await queue.flush();
    assert.equal(queue.snapshot()[0].status, "pending");
    assert.equal(queue.snapshot()[0].attempts, 1);
    assert.equal((await client.query(api.list)).length, 1);
    queue.dispose(); runtime.close(); runtime = await openBackend(definition, options);
    queue = createOfflineQueue(queueOptions);
    await queue.retry(id); await queue.flush();
    assert.equal(queue.snapshot().length, 0);
    const items = await client.query(api.list);
    assert.equal(items.length, 1);
    await assert.rejects(client.mutateOnce(api.add, { title: "different" }, { key: id, userId: alice.userId }), error => error.code === "MUTATION_KEY_REUSED");
    const pending = await queue.enqueue(api.add, { title: "Alice only" });
    session = bob;
    await assert.rejects(queue.flush(), /another account/);
    await assert.rejects(client.mutateOnce(api.add, { title: "Alice only" }, { key: pending, userId: alice.userId }), error => error.code === "OFFLINE_ACCOUNT_CHANGED");
    assert.equal((await client.query(api.list)).length, 0);
    session = alice; await queue.flush();
    await client.mutate(api.rename, { id: items[0]._id, title: "Remote edit", version: items[0]._version });
    const conflict = await queue.enqueue(api.rename, { id: items[0]._id, title: "My edit", version: items[0]._version });
    await queue.flush();
    assert.equal(queue.snapshot()[0].status, "conflict");
    const latest = (await client.query(api.list)).find(row => row._id === items[0]._id);
    await queue.retry(conflict, { id: latest._id, title: "Merged edit", version: latest._version });
    await queue.flush();
    assert.equal(queue.snapshot().length, 0);
    assert.equal((await client.query(api.list)).find(row => row._id === latest._id).title, "Merged edit");
    const old = `${Date.now() - 8 * 86400000}.${crypto.randomUUID()}`;
    await assert.rejects(client.mutateOnce(api.add, { title: "expired" }, { key: old, userId: alice.userId }), error => error.code === "MUTATION_KEY_EXPIRED");
    await assert.rejects(client.mutateOnce(api.fail, {}, { key: `${Date.now()}.${crypto.randomUUID()}`, userId: alice.userId }));
    assert.equal((await client.query(api.list)).length, 2);
    queue.dispose();
  } finally { runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("offline queue bounds persistence, serializes shared writers, exposes state, and stops ordered work on permanent failures", async () => {
  const local = storage();
  let online = false;
  let calls = 0;
  const client = { mutateOnce: async () => { calls++; throw { status: 410, code: "MUTATION_KEY_EXPIRED" }; } };
  const options = { namespace: "limits", userId: "alice", currentUser: () => "alice", storage: local, client, online: () => online };
  const first = createOfflineQueue(options), second = createOfflineQueue(options);
  const states = [];
  first.subscribe(rows => states.push(rows.map(row => row.status)));
  await Promise.all([first.enqueue(api.add, { title: "one" }), second.enqueue(api.add, { title: "two" })]);
  assert.equal(first.snapshot().length, 2);
  await first.flush(); assert.equal(calls, 0);
  online = true; await first.flush(); assert.equal(calls, 1);
  assert.equal(first.snapshot()[0].status, "failed");
  await assert.rejects(first.retry(first.snapshot()[0].id), /Reconcile/);
  await first.flush(); assert.equal(calls, 1);
  await first.discard(first.snapshot()[0].id); assert.equal(second.snapshot().length, 1);
  await assert.rejects(first.enqueue(api.add, { title: "x".repeat(1024 * 1024) }), /full/);
  assert.equal(first.snapshot().length, 1);
  assert.ok(states.some(rows => rows[0] === "sending"));
  await first.clear(); assert.equal(second.snapshot().length, 0);
  first.dispose(); second.dispose();
  assert.throws(() => createOfflineQueue({ ...options, storage: { ...local, getItem: () => "{broken" } }));
});


test("offline queue rendering escapes metadata and excludes mutation arguments", () => {
  const html = renderOfflineQueue([{ id: "hidden-key", path: "<script>alert(1)</script>", input: { password: "private-input" }, status: "pending", attempts: 1, nextAttemptAt: 0 }]);
  assert.doesNotMatch(html, /<script>|private-input|hidden-key/i);
  assert.match(html, /&lt;script&gt;/);
});
