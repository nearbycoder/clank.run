import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineDatabase, defineTable, defineBackend, openBackend, openSQLite } from "../dist/backend.js";
import { defineAuth } from "../dist/auth.js";
import { s } from "../dist/ai.js";
import { openSearch, createSearchClient } from "../dist/search.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";
import { openPointInTimeRecovery } from "../dist/point-in-time.js";

const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), score: s.number() }).owned(), articles: defineTable({ title: s.string(), body: s.string(), scope: s.string() }) });
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const definition = defineBackend({ schema, auth }).functions(() => ({}));
const source = { name: "notes", table: "notes", title: "title", body: "body", scope: "owner" };
async function fixture(overrides = {}, policies = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-source-search-")), path = join(directory, "app.sqlite");
  let runtime = await openBackend(definition, { path, agent: false });
  const settings = { path, auth, schema, source: { ...source, ...overrides }, authorize: ({ auth }, scope) => auth.user?.id === scope, ...policies };
  let service = await openSearch(settings);
  return {
    path, directory, settings, get runtime() { return runtime; }, get database() { return runtime.database; }, get service() { return service; },
    async user(email) { const response = await runtime.handle(new Request("https://search.test/__clank/auth/register", { method: "POST", headers: { origin: "https://search.test", "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery staple" }) })); assert.equal(response.status, 201); const data = await response.json(); return { id: data.user.id, cookie: response.headers.get("set-cookie").split(";", 1)[0] }; },
    client(user) { return createSearchClient({ url: "https://search.test/__clank/search", fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: "https://search.test" } })) }); },
    async restart() { service.close(); runtime.close(); runtime = await openBackend(definition, { path, agent: false }); service = await openSearch(settings); },
    async close() { service.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
const note = (title = "Launch", body = "launch checklist") => ({ title, body, score: 1 });
const insert = (f, owner, value = note()) => f.database.transaction(db => db.table("notes").insert(value), { userId: owner });
const hits = async (f, user, word = "launch") => (await f.client(user).search(user.id, word)).hits.map(hit => hit.id);

test("unlinked application writes preserve the existing schema and recovery epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-search-opt-in-")); let recovery, database;
  try {
    database = await openSQLite(schema, { path: join(directory, "app.sqlite") });
    const shape = () => database[SQLITE_INTERNAL].prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
    const before = shape(); recovery = await openPointInTimeRecovery(database, { directory: join(directory, "archive"), encryptionKey: new Uint8Array(32).fill(9), exportIntervalMs: false });
    const sealed = shape(); database.transaction(db => db.table("notes").insert(note()), { userId: "owner" }); assert.deepEqual(shape(), sealed); assert.equal(recovery.status().committedThrough, 1);
    assert.equal(before.some(table => table.name.startsWith("clank_source_search_")), false);
    await assert.rejects(openSearch({ path: join(directory, "app.sqlite"), schema, auth, source, authorize: () => true }), /requires point-in-time recovery capture/);
    database.transaction(db => db.table("notes").insert(note()), { userId: "owner" }); assert.equal(recovery.status().committedThrough, 2);
  } finally { await recovery?.close(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed first registration rolls back the entire derived schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-search-registration-")), path = join(directory, "app.sqlite");
  const runtime = await openBackend(definition, { path, agent: false });
  try {
    runtime.database.transaction(db => { db.table("notes").insert(note()); db.table("notes").insert(note()); }, { userId: "owner" });
    await assert.rejects(openSearch({ path, schema, auth, source: { ...source, maxRecords: 1 }, authorize: () => true }), /record capacity/);
    assert.equal(Number(runtime.database[SQLITE_INTERNAL].prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'clank_source_search_*'").get().n), 0);
    const linked = await openSearch({ path, schema, auth, source, authorize: () => true });
    try { assert.equal(linked.rebuild().processed, 2); } finally { linked.close(); }
  } finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("linked writes, deletes and history restores commit together on a previously opened writer", async () => {
  const f = await fixture();
  try {
    const alice = await f.user("linked@example.invalid"), bob = await f.user("hidden@example.invalid");
    const id = insert(f, alice.id); insert(f, bob.id, note("Hidden launch", "private launch"));
    await assert.rejects(f.client(alice).search(alice.id, "launch"), error => error.code === "SEARCH_SOURCE_UNAVAILABLE");
    assert.equal(f.service.rebuild().status, "ready"); assert.deepEqual(await hits(f, alice), [id]);
    const original = f.database.read(db => db.table("notes").history(id)[0].cursor, { userId: alice.id });
    f.database.transaction(db => db.table("notes").patch(id, { title: "Revised", body: "revised text" }), { userId: alice.id });
    assert.deepEqual(await hits(f, alice), []); assert.deepEqual(await hits(f, alice, "revised"), [id]);
    const revision = f.service.inspect().revision;
    assert.throws(() => f.database.transaction(db => { db.table("notes").patch(id, { body: "launch rollback" }); throw new Error("abort"); }, { userId: alice.id }), /abort/);
    assert.equal(f.service.inspect().revision, revision); assert.deepEqual(await hits(f, alice, "revised"), [id]);
    f.database.transaction(db => db.table("notes").delete(id), { userId: alice.id }); assert.deepEqual(await hits(f, alice, "revised"), []);
    f.database.transaction(db => db.table("notes").restore(id, original, { ifVersion: null }), { userId: alice.id }); assert.deepEqual(await hits(f, alice), [id]);
    assert.deepEqual({ missing: f.service.inspect().missing, stale: f.service.inspect().stale, orphan: f.service.inspect().orphan }, { missing: 0, stale: 0, orphan: 0 });
    await f.restart(); assert.deepEqual(await hits(f, alice), [id]);
    await assert.rejects(f.client(alice).search(bob.id, "launch"), error => error.status === 404);
  } finally { await f.close(); }
});

test("rebuild resumes after restart and handles edits/inserts/deletes on both sides of its cursor", async () => {
  const f = await fixture();
  try {
    const user = await f.user("rebuild@example.invalid"), ids = Array.from({ length: 5 }, () => insert(f, user.id)).sort();
    const first = f.service.rebuild({ batchSize: 1 }); assert.equal(first.status, "building"); assert.equal(first.cursor, ids[0]);
    f.database.transaction(db => { db.table("notes").patch(ids[0], { body: "launch edited" }); db.table("notes").delete(ids.at(-1)); }, { userId: user.id });
    const added = insert(f, user.id, note("New launch"));
    await f.restart(); assert.equal(f.service.inspect().cursor, first.cursor);
    while (f.service.rebuild({ batchSize: 1 }).status !== "ready") {}
    assert.deepEqual((await hits(f, user)).sort(), [...ids.slice(0, -1), added].sort());
    const complete = f.service.rebuild(); assert.equal(complete.processed, 0);
    const ready = f.service.inspect(), repair = f.service.rebuild({ batchSize: 1, ifRevision: ready.revision }); assert.equal(repair.status, "building");
    assert.throws(() => f.service.rebuild({ batchSize: 1, ifRevision: ready.revision }), /revision changed/);
    assert.equal(f.service.inspect().cursor, repair.cursor, "lost-response retry must not restart accepted progress");
    while (f.service.rebuild({ batchSize: 1 }).status !== "ready") {}
    assert.equal(f.service.inspect().missing + f.service.inspect().stale + f.service.inspect().orphan, 0);
  } finally { await f.close(); }
});

test("current source validation hides orphan/stale rows and diagnosis/repair remains bounded", async () => {
  const f = await fixture();
  try {
    const user = await f.user("drift@example.invalid"), ids = Array.from({ length: 3 }, () => insert(f, user.id)).sort(); f.service.rebuild();
    const raw = new DatabaseSync(f.path);
    raw.prepare("DELETE FROM clank_notes WHERE _id=?").run(ids[0]);
    raw.prepare("UPDATE clank_notes SET _data=? WHERE _id=?").run(JSON.stringify(note("Changed", "changed")), ids[1]);
    raw.prepare("DELETE FROM clank_source_search_fts WHERE id=?").run(ids[2]); raw.close();
    assert.deepEqual(await hits(f, user), []);
    const first = f.service.inspect({ limit: 1 }); assert.equal(first.scanned, 1); assert.equal(first.orphan, 1); assert.equal(first.nextCursor, ids[0]);
    const second = f.service.inspect({ cursor: first.nextCursor, limit: 1 }); assert.equal(second.stale, 1);
    const third = f.service.inspect({ cursor: second.nextCursor, limit: 1 }); assert.equal(third.missing, 1); assert.equal(third.nextCursor, null);
    f.service.rebuild({ ifRevision: first.revision }); assert.deepEqual(await hits(f, user), [ids[2]]); assert.deepEqual(await hits(f, user, "changed"), [ids[1]]);
  } finally { await f.close(); }
});

test("current record policy and owner scope precede ranking, budgets and snippets", async () => {
  const denied = new Set(), f = await fixture({}, { maxCandidates: 1, maxScopeRecords: 5, authorizeRecord: (_context, record) => !denied.has(record.id) });
  try {
    const alice = await f.user("allowed@example.invalid"), bob = await f.user("other@example.invalid");
    const hidden = insert(f, alice.id, note("Secret launch", "launch ".repeat(100))), visible = insert(f, alice.id); insert(f, bob.id, note("Tenant secret launch")); denied.add(hidden); f.service.rebuild();
    const result = await f.client(alice).search(alice.id, "launch"); assert.deepEqual(result.hits.map(hit => hit.id), [visible]); assert.equal(result.truncated, false); assert.doesNotMatch(JSON.stringify(result), /secret/i);
    denied.add(visible); assert.deepEqual(await f.client(alice).search(alice.id, "launch"), { hits: [], total: 0, truncated: false });
    await assert.rejects(f.client(alice).search(bob.id, "launch"), error => error.status === 404);
  } finally { await f.close(); }
});

test("record/byte/scope limits roll back source, history, index and revision; final-state swaps work", async () => {
  const f = await fixture({ maxRecords: 2, maxBytes: 20 }, { maxCandidates: 1, maxScopeRecords: 2 });
  try {
    const user = await f.user("capacity@example.invalid"), a = insert(f, user.id, note("a", "123456789")), b = insert(f, user.id, note("b", "123456789")); f.service.rebuild();
    const revision = f.service.inspect().revision, version = f.database.version;
    assert.throws(() => insert(f, user.id, note("c", "")), /record capacity/);
    assert.throws(() => f.database.transaction(db => db.table("notes").patch(a, { body: "x".repeat(20) }), { userId: user.id }), /capacity/);
    assert.equal(f.database.version, version); assert.equal(f.service.inspect().revision, revision); assert.equal(f.service.inspect().indexedBytes, 20);
    f.database.transaction(db => { db.table("notes").patch(a, { body: "1234567890" }); db.table("notes").patch(b, { body: "12345678" }); }, { userId: user.id }); assert.equal(f.service.inspect().indexedBytes, 20);
    assert.throws(() => f.database.transaction(db => db.table("notes").patch(a, { title: "🧪".repeat(251) }), { userId: user.id }), /1 KiB/);
  } finally { await f.close(); }
});

test("binding registration, field contracts, replacement and detach fail closed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, body: "score" } }), /required strings/);
    for (const body of [s.optional(s.string()), s.default(s.string(), "default body")]) {
      const optionalSchema = defineDatabase({ notes: defineTable({ title: s.string(), body, score: s.number() }).owned(), articles: schema.tables.articles });
      await assert.rejects(openSearch({ ...f.settings, schema: optionalSchema }), /required strings/);
    }
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, scope: { field: "title" } } }), /binding/);
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, name: 'bad"name' } }), /binding/);
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, maxBytes: 100 } }), /binding changed/);
    const generation = f.service.inspect().generation; assert.throws(() => f.service.detach("wrong"), /fence/); f.service.detach(generation);
    const replacement = await openSearch(f.settings);
    try { assert.notEqual(replacement.inspect().generation, generation); assert.throws(() => f.service.rebuild(), /replaced/); assert.throws(() => f.service.detach(generation), /replaced/); } finally { replacement.close(); }
    for (const name of ["source_search_indexes", "source_search_fts", "source_search_fts_data"]) assert.throws(() => defineDatabase({ [name]: defineTable({ text: s.string() }) }), /reserved/);
  } finally { await f.close(); }
});

test("public-table scope moves remove the previous scope atomically", async () => {
  const f = await fixture({ name: "articles", table: "articles", scope: { field: "scope" } }, { authorize: () => true });
  try {
    const user = await f.user("public@example.invalid"), id = f.database.transaction(db => db.table("articles").insert({ title: "Launch", body: "launch", scope: "team" })); f.service.rebuild();
    assert.equal((await f.client(user).search("team", "launch")).total, 1);
    const second = await openSQLite(schema, { path: f.path });
    try { second.transaction(db => db.table("articles").patch(id, { scope: "other" })); } finally { second.close(); }
    assert.equal((await f.client(user).search("team", "launch")).total, 0); assert.equal((await f.client(user).search("other", "launch")).hits[0].id, id);
  } finally { await f.close(); }
});

for (const mode of ["write", "rebuild"]) test(`a real process crash during ${mode} preserves the last committed source/index boundary`, { timeout: 15000 }, async () => {
  const f = await fixture(); let child;
  try {
    const user = await f.user(`crash-${mode}@example.invalid`), id = insert(f, user.id); if (mode === "write") f.service.rebuild();
    const before = f.service.inspect();
    child = fork(new URL("./fixtures/source-search-worker.mjs", import.meta.url), [f.path, user.id, mode], { execArgv: ["--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = ""; child.stderr.on("data", data => { errors += data; });
    const stopped = new Promise((resolve, reject) => { child.on("message", message => { if (message.ready) child.send("go"); if (message.uncommitted) resolve(); }); child.on("error", reject); child.on("exit", (code, signal) => { if (signal !== "SIGKILL") reject(new Error(errors || `Unexpected worker exit ${code}`)); }); });
    await stopped; const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exit;
    await f.restart(); const after = f.service.inspect();
    assert.deepEqual({ revision: after.revision, cursor: after.cursor, indexedRecords: after.indexedRecords, status: after.status }, { revision: before.revision, cursor: before.cursor, indexedRecords: before.indexedRecords, status: before.status });
    assert.equal(f.database.read(db => db.table("notes").collect(), { userId: user.id }).length, 1);
    f.service.rebuild(); assert.deepEqual(await hits(f, user), [id]);
  } finally { child?.kill("SIGKILL"); await f.close(); }
});

test("virtual-table recovery is explicitly rejected without weakening the existing recovery seal", async () => {
  const f = await fixture();
  try {
    await assert.rejects(openPointInTimeRecovery(f.database, { directory: join(f.directory, "archive"), encryptionKey: new Uint8Array(32).fill(9), exportIntervalMs: false }), /does not support virtual tables/);
    const native = f.database[SQLITE_INTERNAL];
    assert.equal(Number(native.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'clank_pitr_*'").get().n), 0, "failed setup rolls back the recovery epoch");
    assert.equal(f.service.rebuild().status, "ready");
  } finally { await f.close(); }
});

test("duplicate drift is diagnosed and does not duplicate authorized results", async () => {
  const f = await fixture();
  try {
    const user = await f.user("duplicates@example.invalid"), id = insert(f, user.id); f.service.rebuild();
    const native = f.database[SQLITE_INTERNAL]; native.prepare("INSERT INTO clank_source_search_fts SELECT index_name,scope,id,source_version,bytes,title,body FROM clank_source_search_fts WHERE id=?").run(id);
    assert.equal(f.service.inspect().duplicate, 1); assert.deepEqual(await hits(f, user), [id]);
    f.service.rebuild({ ifRevision: f.service.inspect().revision }); assert.equal(f.service.inspect().duplicate, 0);
  } finally { await f.close(); }
});

test("binding admission and unsupported persisted definitions remain bounded and rollback writes", async () => {
  const f = await fixture(), additional = [];
  try {
    for (let index = 1; index < 16; index++) additional.push(await openSearch({ ...f.settings, source: { ...source, name: `notes${index}` } }));
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, name: "overflow" } }), /16 source-search/);
    const native = f.database[SQLITE_INTERNAL], stored = native.prepare("SELECT definition FROM clank_source_search_indexes WHERE name='notes'").get().definition;
    native.prepare("UPDATE clank_source_search_indexes SET definition=? WHERE name='notes'").run(JSON.stringify({ ...JSON.parse(stored), version: 2 }));
    assert.throws(() => insert(f, "owner"), /Invalid persisted/); assert.equal(f.database.read(db => db.table("notes").collect(), { userId: "owner" }).length, 0);
    native.prepare("UPDATE clank_source_search_indexes SET definition=? WHERE name='notes'").run(stored);
    assert.ok(insert(f, "owner"));
  } finally { additional.forEach(service => service.close()); await f.close(); }
});

test("rebuild capacity failure preserves cursor, and asynchronous policies fail closed", async () => {
  const denied = await fixture({}, { authorize: () => Promise.resolve(true) });
  try { const user = await denied.user("async-scope@example.invalid"); insert(denied, user.id); denied.service.rebuild(); await assert.rejects(denied.client(user).search(user.id, "launch"), error => error.status === 404); }
  finally { await denied.close(); }
  const f = await fixture({ maxBytes: 5 });
  try {
    const user = await f.user("repair-capacity@example.invalid");
    // A row predating registration need not fit its derived text budget.
    const native = f.database[SQLITE_INTERNAL]; native.prepare("INSERT INTO clank_notes(_id,_owner_id,_creation_time,_version,_data) VALUES(?,?,0,1,?)").run("old", user.id, JSON.stringify(note()));
    const before = f.service.inspect(); assert.throws(() => f.service.rebuild({ batchSize: 1 }), /capacity/); const after = f.service.inspect(); assert.equal(after.cursor, before.cursor); assert.equal(after.revision, before.revision); assert.equal(after.indexedRecords, 0);
    f.database.transaction(db => db.table("notes").delete("old"), { userId: user.id }); assert.equal(f.service.rebuild().status, "ready");
  } finally { await f.close(); }
});

test("revoked sessions and rejected asynchronous policies cannot return source rows or escape as rejections", async () => {
  for (const policy of [{}, { authorize: () => Promise.reject(new Error("private policy error")) }, { authorizeRecord: () => Promise.reject(new Error("private record policy error")) }]) {
    const f = await fixture({}, policy);
    try {
      const user = await f.user("revoked-search@example.invalid"); insert(f, user.id); f.service.rebuild();
      if (policy.authorize) await assert.rejects(f.client(user).search(user.id, "launch"), error => error.status === 404);
      else if (policy.authorizeRecord) assert.deepEqual(await hits(f, user), []);
      else { f.runtime.auth.revokeUserSessions(user.id); await assert.rejects(f.client(user).search(user.id, "launch"), error => error.status === 401); }
      await new Promise(resolve => setImmediate(resolve));
    } finally { await f.close(); }
  }
});
