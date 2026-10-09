import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { defineAuth } from "../dist/auth.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../dist/backend.js";
import { s } from "../dist/ai.js";
import { openDurableImport, createDurableImportClient } from "../dist/durable-import.js";
import { openSearch, createSearchClient } from "../dist/search.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const table = defineTable({ title: s.string({ min: 1, max: 5000 }), score: s.number({ integer: true }), active: s.default(s.boolean(), false) }).owned().index("by_title", ["title"]);
const schema = defineDatabase({ records: table });
const definition = defineBackend({ schema, auth }).functions(() => ({}));
const columns = [{ source: "name", target: "title", type: "text", required: true }, { source: "points", target: "score", type: "integer", required: true }];
const csv = (text) => new Blob([text], { type: "text/csv" });
const isCode = code => error => error.code === code;
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-reviewed-import-")), path = join(directory, "app.sqlite");
  let runtime = await openBackend(definition, { path, agent: false });
  const settings = { path, auth, schema, table: "records", fields: ["title", "score"], uniqueBy: ["title"], reviewable: { duplicates: "upsert" }, ...overrides };
  let service = await openDurableImport(settings);
  return {
    directory, path, settings, get runtime() { return runtime; }, get service() { return service; },
    get native() { return runtime.database[SQLITE_INTERNAL]; },
    async user(email) { const response = await runtime.handle(new Request("https://imports.test/__clank/auth/register", { method: "POST", headers: { origin: "https://imports.test", "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery staple" }) })); assert.equal(response.status, 201); const data = await response.json(); return { id: data.user.id, cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: data.csrfToken }; },
    fetch(user, url, init) { return service.handle(new Request(url, { ...init, headers: { ...init.headers, origin: "https://imports.test", cookie: user.cookie } })); },
    client(user, overrides = {}) { return createDurableImportClient({ url: "https://imports.test/__clank/imports", currentUser: () => user.id, auth: { csrfHeader: () => ({ "x-clank-csrf": user.csrf }) }, fetch: (url, init) => this.fetch(user, url, init), ...overrides }); },
    async request(user, kind, method, input) { const response = await this.fetch(user, `https://imports.test/__clank/imports/${kind}/${method}`, { method: "POST", headers: { "content-type": "application/json", "x-clank-csrf": user.csrf }, body: JSON.stringify(input) }); return { status: response.status, ...await response.json() }; },
    rows(user) { return runtime.database.read(db => db.table("records").collect(), { userId: user.id }); },
    insert(user, title, score = 1, active = true) { return runtime.database.transaction(db => db.table("records").insert({ title, score, active }), { userId: user.id }); },
    patch(user, id, values) { return runtime.database.transaction(db => db.table("records").patch(id, values), { userId: user.id }); },
    async restart() { service.close(); runtime.close(); runtime = await openBackend(definition, { path, agent: false }); service = await openDurableImport(settings); },
    async close() { service.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
const staged = (f, u, text, settings) => f.client(u).uploadReviewableCsv(csv(text), columns, settings);

test("invalid raw values survive staging, corrections are separate, and acceptance retires payload copies", async () => {
  const f = await fixture();
  try {
    const u = await f.user("invalid@example.invalid"), c = f.client(u), source = csv("name,points\nLaunch,oops\n");
    let job = await c.uploadReviewableCsv(source, columns, { key: "source" });
    const raw = f.native.prepare("SELECT _data FROM clank_durableImportChunks").get()._data;
    assert.equal(job.state, "ready"); assert.deepEqual((await c.sourceWindow(job.id)).rows[0], { row: 2, source: ["Launch", "oops"], corrections: {} });
    let preview = await c.preview(job.id); assert.deepEqual(preview.effects, [{ row: 2, action: "invalid", issue: "INVALID_ROW" }]);
    job = await c.apply(preview, "invalid-batch"); assert.equal(job.state, "failed"); assert.equal(job.processedRows, 0); assert.deepEqual(f.rows(u), []);
    assert.deepEqual(await c.apply(preview, "invalid-batch"), job);
    job = await c.correctRows(job.id, 0, [{ row: 2, values: { score: 5 } }], "fix-score"); assert.equal(job.review.revision, 1);
    assert.equal(f.native.prepare("SELECT _data FROM clank_durableImportChunks").get()._data, raw);
    assert.deepEqual((await c.sourceWindow(job.id)).rows[0].corrections, { score: 5 });
    preview = await c.preview(job.id); assert.equal(preview.effects[0].action, "insert");
    job = await c.apply(preview, "accept"); assert.equal(job.state, "completed"); assert.deepEqual(f.rows(u).map(row => [row.title, row.score, row.active]), [["Launch", 5, false]]);
    for (const name of ["durableImportChunks", "durableImportCorrections"]) { assert.equal(f.native.prepare(`SELECT count(*) AS n FROM clank_${name}`).get().n, 0); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name=?").get(name).n, 0); }
    assert.deepEqual(await c.apply(preview, "accept"), job); await f.restart(); assert.deepEqual(await c.apply(preview, "accept"), job);
    assert.equal(f.rows(u)[0]._version, 1); assert.deepEqual(await c.uploadReviewableCsv(source, columns, { id: job.id }), job);
    await assert.rejects(c.sourceWindow(job.id), isCode("IMPORT_SOURCE_WINDOW"));
    await assert.rejects(c.uploadReviewableCsv(csv("name,points\nChanged,5\n"), columns, { id: job.id }), isCode("IMPORT_SOURCE_CHANGED"));
  } finally { await f.close(); }
});

test("upsert preview binds current owner, versions and correction revision while preserving unmapped fields", async () => {
  const f = await fixture();
  try {
    const a = await f.user("upsert@example.invalid"), b = await f.user("other@example.invalid"), c = f.client(a), id = f.insert(a, "Launch"); f.insert(b, "Launch", 99);
    const job = await staged(f, a, "name,points\nLaunch,7\nNew,8\n"); let p = await c.preview(job.id);
    assert.deepEqual(p.effects.map(e => e.action), ["update", "insert"]); assert.deepEqual(p.effects[0].before, { title: "Launch", score: 1 }); assert.equal(p.effects[0].version, 1); assert.doesNotMatch(JSON.stringify(p), /active/);
    f.patch(a, id, { score: 2 }); await assert.rejects(c.apply(p, "stale-version"), isCode("IMPORT_PREVIEW_STALE")); assert.equal((await c.inspect(job.id)).processedRows, 0); assert.equal(f.rows(a).length, 1);
    p = await c.preview(job.id); await c.correctRows(job.id, 0, [{ row: 3, values: { score: 9 } }], "revision"); await assert.rejects(c.apply(p, "stale-correction"), isCode("IMPORT_PREVIEW_STALE"));
    p = await c.preview(job.id); const done = await c.apply(p, "upsert"); assert.equal(done.review.updatedRows, 1); assert.equal(done.insertedRows, 1); assert.deepEqual(f.rows(a).map(row => [row.title, row.score, row.active]), [["Launch", 7, true], ["New", 9, false]]); assert.equal(f.rows(b)[0].score, 99);
    await assert.rejects(f.client(b).preview(job.id), error => error.status === 404);
    await assert.rejects(c.apply({ ...p, effects: [{ ...p.effects[0], after: { title: "Forged", score: 1 } }] }, "forged"), isCode("IMPORT_PREVIEW_STATE"));
  } finally { await f.close(); }
});

test("mapping and row correction retries survive restart; processed batches remain immutable", async () => {
  const f = await fixture({ batchSize: 1 });
  try {
    const u = await f.user("mapping@example.invalid"), c = f.client(u); let job = await staged(f, u, "name,points,alternate\nFirst,1,10\nSecond,2,20\n");
    const p = await c.preview(job.id); const firstAccepted = await c.apply(p, "first"); job = firstAccepted; assert.equal(job.processedRows, 1);
    await assert.rejects(c.correctRows(job.id, 0, [{ row: 2, values: { score: 100 } }], "applied-row"), error => error.status === 400);
    await assert.rejects(c.sourceWindow(job.id, { startRow: 2 }), isCode("IMPORT_SOURCE_WINDOW"));
    const changed = [columns[0], { ...columns[1], source: "alternate" }]; job = await c.correctMapping(job.id, 0, changed, "mapping");
    await f.restart(); assert.deepEqual(await c.correctMapping(job.id, 0, changed, "mapping"), job);
    await assert.rejects(c.correctMapping(job.id, 0, columns, "mapping"), isCode("IMPORT_OPERATION_REUSED"));
    const second = await c.preview(job.id); assert.equal(second.effects[0].after.score, 20); const done = await c.apply(second, "second");
    assert.deepEqual(f.rows(u).map(row => row.score), [1, 20]); assert.deepEqual(await c.apply(p, "first"), firstAccepted, "old batch replay returns its original accepted progress, not the later job state"); assert.equal((await c.inspect(job.id)).processedRows, 2); assert.equal(done.state, "completed");
  } finally { await f.close(); }
});

test("ambiguous matches and duplicate batch identities fail without target writes", async () => {
  const f = await fixture();
  try {
    const u = await f.user("ambiguity@example.invalid"), c = f.client(u); f.insert(u, "Same"); f.insert(u, "Same");
    const job = await staged(f, u, "name,points\nSame,4\nNew,5\nNew,6\n"); const p = await c.preview(job.id);
    assert.equal(p.effects[0].issue, "AMBIGUOUS"); assert.equal(p.effects[2].issue, "DUPLICATE"); assert.equal((await c.apply(p, "ambiguous")).state, "failed"); assert.equal(f.rows(u).length, 2);
    await assert.rejects(openDurableImport({ ...f.settings, uniqueBy: [] }), /unique upsert fields/);
  } finally { await f.close(); }
});

test("skip policy preserves existing versions and counts only authorized matches", async () => {
  const f = await fixture({ reviewable: { duplicates: "skip" } });
  try { const u = await f.user("skip@example.invalid"), c = f.client(u); f.insert(u, "Same"); const job = await staged(f, u, "name,points\nSame,4\nNew,5\n"); const p = await c.preview(job.id); assert.deepEqual(p.effects.map(e => e.action), ["skip", "insert"]); const done = await c.apply(p, "skip"); assert.equal(done.skippedRows, 1); assert.equal(done.insertedRows, 1); assert.equal(f.rows(u)[0]._version, 1); } finally { await f.close(); }
});

test("current read/write policies hide previews and retained replay cannot bypass revocation", async () => {
  let read = true, write = true;
  const f = await fixture({ authorize: () => write, reviewable: { duplicates: "upsert", authorizeRead: () => read } });
  try {
    const u = await f.user("policies@example.invalid"), c = f.client(u); f.insert(u, "Secret"); const job = await staged(f, u, "name,points\nSecret,2\n"); const p = await c.preview(job.id);
    read = false; const hidden = await c.preview(job.id); assert.deepEqual(hidden.effects, [{ row: 2, action: "invalid", issue: "FORBIDDEN" }]); assert.doesNotMatch(JSON.stringify(hidden), /Secret|before|after/); await assert.rejects(c.apply(p, "revoked"), isCode("IMPORT_PREVIEW_STALE"));
    read = true; const done = await c.apply(p, "allowed"); write = false; await assert.rejects(c.apply(p, "allowed"), error => error.status === 404); assert.equal(f.rows(u)[0]._version, 2); write = true; assert.deepEqual(await c.apply(p, "allowed"), done);
    await f.runtime.handle(new Request("https://imports.test/__clank/auth/logout", { method: "POST", headers: { cookie: u.cookie, origin: "https://imports.test", "x-clank-csrf": u.csrf } })); await assert.rejects(c.inspect(job.id), error => error.status === 401);
  } finally { await f.close(); }
});

test("rejected async policies are contained and fail closed", async () => {
  const f = await fixture({ authorize: () => Promise.reject(new Error("async denied")) });
  try { const u = await f.user("async@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nNew,1\n"); assert.deepEqual((await c.preview(job.id)).effects, [{ row: 2, action: "invalid", issue: "FORBIDDEN" }]); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.rows(u).length, 0); } finally { await f.close(); }
});

test("receipt and correction capacity failures roll back writes, progress and replacement overlays", async () => {
  const f = await fixture({ reviewable: { duplicates: "upsert", maxReceipts: 1, maxCorrectionBytes: 20 } });
  try {
    const u = await f.user("bounded@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nNew,1\n");
    await assert.rejects(c.correctRows(job.id, 0, [{ row: 2, values: { title: "x".repeat(40) } }], "large"), isCode("IMPORT_CORRECTION_CAPACITY")); assert.deepEqual((await c.sourceWindow(job.id)).rows[0].corrections, {}); assert.equal((await c.inspect(job.id)).review.revision, 0);
    await c.correctRows(job.id, 0, [{ row: 2, values: { score: 2 } }], "correction");
    const p = await c.preview(job.id); await assert.rejects(c.apply(p, "capacity"), isCode("IMPORT_RECEIPT_CAPACITY")); assert.equal(f.rows(u).length, 0); assert.equal((await c.inspect(job.id)).processedRows, 0); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportChunks").get().n, 1);
    await assert.rejects(c.correctRows(job.id, 1, [{ row: 2, values: { score: 3 } }], "replace"), isCode("IMPORT_RECEIPT_CAPACITY")); assert.deepEqual((await c.sourceWindow(job.id)).rows[0].corrections, { score: 2 });
  } finally { await f.close(); }
});

test("server verifies canonical source hashes and rejects immutable chunk replacement", async () => {
  const f = await fixture();
  try {
    const u = await f.user("digest@example.invalid"), headers = ["name", "points"], rows = [["A", "1"]], sourceHash = createHash("sha256").update(JSON.stringify(headers) + "\n" + JSON.stringify(rows[0]) + "\n").digest("hex");
    const create = await f.request(u, "mutation", "createReview", { name: "source", key: "digest", expectedOwner: u.id, sourceHash: "0".repeat(64), sourceRows: 1, headers: JSON.stringify(headers), columns: JSON.stringify(columns) }); assert.equal(create.status, 200); const id = create.value.id;
    assert.equal((await f.request(u, "mutation", "appendReview", { id, expectedOwner: u.id, sequence: 0, rows: JSON.stringify(rows) })).status, 200);
    assert.equal((await f.request(u, "mutation", "appendReview", { id, expectedOwner: u.id, sequence: 0, rows: JSON.stringify([["B", "1"]]) })).error.code, "IMPORT_CHUNK_CHANGED");
    assert.equal((await f.request(u, "mutation", "sealReview", { id, expectedOwner: u.id, chunks: 1 })).error.code, "IMPORT_SOURCE_CHANGED"); assert.equal((await f.client(u).inspect(id)).state, "uploading");
    const valid = await f.request(u, "mutation", "createReview", { name: "valid", key: "valid", expectedOwner: u.id, sourceHash, sourceRows: 1, headers: JSON.stringify(headers), columns: JSON.stringify(columns) }); assert.equal(valid.status, 200);
    await assert.rejects(f.client(u).append(id, 1, [{ title: "Forged", score: 1 }]), isCode("IMPORT_REVIEW_REQUIRED")); await assert.rejects(f.client(u).seal(id, 1), isCode("IMPORT_REVIEW_REQUIRED")); await assert.rejects(f.client(u).step(id, 0), isCode("IMPORT_REVIEW_REQUIRED")); await assert.rejects(f.client(u).run(id), /Preview and accept/);
  } finally { await f.close(); }
});

test("a client account switch while reading or requesting cannot create or render another account's source", async () => {
  const f = await fixture();
  try {
    const a = await f.user("account-a@example.invalid"), b = await f.user("account-b@example.invalid"); let current = a.id, release; const c = f.client(a, { currentUser: () => current });
    const source = csv("name,points\nPrivate,1\n"); source.text = () => new Promise(resolve => { release = resolve; }); const pending = c.uploadReviewableCsv(source, columns); current = b.id; release("name,points\nPrivate,1\n"); await assert.rejects(pending, /account changed/); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportJobs").get().n, 0);
    current = a.id; const switchedCookie = f.client(a, { fetch: (url, init) => f.fetch(b, url, { ...init, headers: { ...init.headers, "x-clank-csrf": b.csrf } }) }); await assert.rejects(switchedCookie.uploadReviewableCsv(csv("name,points\nPrivate,1\n"), columns), error => error.status === 404);
    await assert.rejects(f.client(a, { currentUser: undefined }).preview("missing"), /currentUser/);
  } finally { await f.close(); }
});

test("independent connections accept one exact retry and reject changed operation input", async () => {
  const f = await fixture(); let other;
  try {
    const u = await f.user("connections@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nSame,1\n"); const p = await c.preview(job.id); other = await openDurableImport(f.settings);
    const second = f.client(u, { fetch: (url, init) => other.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: u.cookie, origin: "https://imports.test" } })) });
    const [one, two] = await Promise.all([c.apply(p, "one-operation"), second.apply(p, "one-operation")]); assert.deepEqual(one, two); assert.equal(f.rows(u).length, 1); assert.equal(f.rows(u)[0]._version, 1);
    await assert.rejects(second.apply({ ...p, digest: "changed" }, "one-operation"), isCode("IMPORT_OPERATION_REUSED"));
  } finally { other?.close(); await f.close(); }
});

test("source-linked search failure rolls back target writes, receipt and import completion together", async () => {
  const f = await fixture(); let search;
  try {
    search = await openSearch({ path: f.path, auth, schema, source: { name: "imports", table: "records", title: "title", body: "title", scope: "owner", maxRecords: 1 }, authorize: () => true }); search.rebuild();
    const u = await f.user("search@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nFirst,1\nSecond,2\n"); const p = await c.preview(job.id);
    await assert.rejects(c.apply(p, "atomic-search")); assert.equal(f.rows(u).length, 0); assert.equal((await c.inspect(job.id)).processedRows, 0); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations").get().n, 0); assert.equal(search.inspect().indexedRecords, 0);
  } finally { search?.close(); await f.close(); }
});

for (const boundary of ["target", "receipt"]) test(`process death after a real ${boundary} write rolls back the entire uncommitted import`, { timeout: 15000 }, async () => {
  const f = await fixture(); let child;
  try {
    const user = await f.user(`crash-${boundary}@example.invalid`), c = f.client(user), job = await staged(f, user, "name,points\nCrash,1\n"), preview = await c.preview(job.id);
    child = fork(new URL("./fixtures/reviewable-import-worker.mjs", import.meta.url), [f.path, boundary], { execArgv: ["--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] }); let errors = ""; child.stderr.on("data", data => { errors += data; });
    await new Promise((resolve, reject) => { child.on("message", message => { if (message.ready) child.send({ user, preview }); if (message.uncommitted) resolve(); }); child.on("error", reject); child.on("exit", (code, signal) => { if (signal !== "SIGKILL") reject(new Error(errors || `Unexpected worker exit ${code}`)); }); });
    const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exit; await f.restart();
    assert.equal(f.rows(user).length, 0); assert.deepEqual(await c.inspect(job.id), job); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations").get().n, 0); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportChunks").get().n, 1);
    const done = await c.apply(preview, "crash"); assert.equal(done.state, "completed"); assert.equal(f.rows(user).length, 1);
  } finally { child?.kill("SIGKILL"); await f.close(); }
});

test("a committed update whose HTTP response is lost is replayed once after restart", async () => {
  const f = await fixture();
  try {
    const u = await f.user("lost@example.invalid"), c = f.client(u); const id = f.insert(u, "Launch"); const job = await staged(f, u, "name,points\nLaunch,9\n"); const p = await c.preview(job.id);
    const dropped = f.client(u, { fetch: async (url, init) => { const response = await f.fetch(u, url, init); if (String(url).endsWith("/apply") && response.ok) { await response.text(); throw new Error("response lost"); } return response; } });
    await assert.rejects(dropped.apply(p, "lost-update"), /response lost/); assert.equal(f.rows(u)[0]._version, 2); await f.restart(); const done = await c.apply(p, "lost-update"); assert.equal(done.review.updatedRows, 1); assert.equal(f.rows(u)[0]._id, id); assert.equal(f.rows(u)[0]._version, 2); assert.equal((await c.inspect(job.id)).processedRows, 1);
  } finally { await f.close(); }
});

test("route contract changes, forged previews, wrong correction types and initial mappings are rejected", async () => {
  const f = await fixture(); let changed;
  try {
    const u = await f.user("contracts@example.invalid"), c = f.client(u), file = csv("name,points\nLaunch,9\n"), job = await c.uploadReviewableCsv(file, columns), p = await c.preview(job.id);
    await assert.rejects(c.apply({ ...p, effects: [{ ...p.effects[0], after: { title: "Forged", score: 20 } }] }, "forged"), isCode("IMPORT_PREVIEW_STALE"));
    await assert.rejects(c.correctRows(job.id, 0, [{ row: 2, values: { score: "9" } }], "type"), error => error.status === 400);
    await assert.rejects(c.correctRows(job.id, 0, [{ row: 2, values: { active: true } }], "field"), error => error.status === 400);
    await assert.rejects(c.uploadReviewableCsv(file, [{ ...columns[0], source: "points" }, columns[1]], { id: job.id }), isCode("IMPORT_SOURCE_CHANGED"));
    changed = await openDurableImport({ ...f.settings, batchSize: 1 }); const alt = f.client(u, { fetch: (url, init) => changed.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: u.cookie, origin: "https://imports.test" } })) }); await assert.rejects(alt.preview(job.id), isCode("IMPORT_DEFINITION_CHANGED")); assert.equal(f.rows(u).length, 0);
  } finally { changed?.close(); await f.close(); }
});

test("target, byte and cancellation bounds reject admission without losing retained identities", async () => {
  const f = await fixture({ reviewable: { duplicates: "upsert", maxTargetRecords: 1, maxReceiptBytes: 1 } });
  try {
    const u = await f.user("limits@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nNew,1\n");
    const p = await c.preview(job.id); await assert.rejects(c.apply(p, "bytes"), isCode("IMPORT_RECEIPT_CAPACITY")); assert.equal(f.rows(u).length, 0);
    f.insert(u, "Existing"); await assert.rejects(c.preview(job.id), isCode("IMPORT_TARGET_CAPACITY"));
    const cancelled = await c.cancel(job.id); assert.equal(cancelled.state, "cancelled"); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportChunks").get().n, 0); assert.equal((await c.inspect(job.id)).id, job.id); await assert.rejects(c.correctRows(job.id, 0, [{ row: 2, values: { score: 2 } }], "retired"), isCode("IMPORT_CORRECTION_STALE"));
    for (const settings of [{ maxSourceBytes: 0 }, { maxReceipts: 100001 }, { maxCorrectionBytes: 64 * 1024 * 1024 + 1 }, { maxTargetRecords: 50001 }]) await assert.rejects(openDurableImport({ ...f.settings, reviewable: settings }), /bounded limits/);
  } finally { await f.close(); }
});

test("unowned upserts require read and write policy and cannot expose a denied matching record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-import-public-")), path = join(directory, "app.sqlite");
  const publicSchema = defineDatabase({ records: defineTable({ title: s.string(), score: s.number(), active: s.default(s.boolean(), false) }).index("by_title", ["title"]) });
  const runtime = await openBackend(defineBackend({ schema: publicSchema, auth }).functions(() => ({})), { path, agent: false }); let service;
  try {
    const settings = { path, schema: publicSchema, auth, table: "records", fields: ["title", "score"], uniqueBy: ["title"] };
    await assert.rejects(openDurableImport({ ...settings, reviewable: { duplicates: "upsert", authorizeRead: () => true } }), /explicit record authorization/);
    await assert.rejects(openDurableImport({ ...settings, authorize: () => true, reviewable: { duplicates: "upsert" } }), /explicit unowned read/);
    service = await openDurableImport({ ...settings, authorize: () => true, reviewable: { duplicates: "upsert", authorizeRead: () => false } });
    runtime.database.transaction(db => db.table("records").insert({ title: "Hidden", score: 1, active: false }));
    const response = await runtime.handle(new Request("https://imports.test/__clank/auth/register", { method: "POST", headers: { origin: "https://imports.test", "content-type": "application/json" }, body: JSON.stringify({ email: "public@example.invalid", password: "correct horse battery staple" }) })); const data = await response.json(), cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const c = createDurableImportClient({ url: "https://imports.test/__clank/imports", currentUser: () => data.user.id, auth: { csrfHeader: () => ({ "x-clank-csrf": data.csrfToken }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie, origin: "https://imports.test" } })) });
    const job = await c.uploadReviewableCsv(csv("name,points\nHidden,2\n"), columns), p = await c.preview(job.id); assert.deepEqual(p.effects, [{ row: 2, action: "invalid", issue: "FORBIDDEN" }]); assert.doesNotMatch(JSON.stringify(p), /Hidden|before|after/);
  } finally { service?.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("chunk drift and malformed persisted metadata fail closed rather than supplying a new source", async () => {
  const f = await fixture();
  try {
    const u = await f.user("drift@example.invalid"), c = f.client(u), job = await staged(f, u, "name,points\nNew,1\n"); const raw = f.native.prepare("SELECT _id,_data FROM clank_durableImportChunks").get(), data = JSON.parse(raw._data); data.contents = JSON.stringify([["Changed", "1"]]); f.native.prepare("UPDATE clank_durableImportChunks SET _data=? WHERE _id=?").run(JSON.stringify(data), raw._id); await assert.rejects(c.preview(job.id), isCode("IMPORT_SOURCE_CHANGED")); assert.equal(f.rows(u).length, 0);
    const row = f.native.prepare("SELECT _data FROM clank_durableImportJobs WHERE _id=?").get(job.id), stored = JSON.parse(row._data); stored.review = "null"; f.native.prepare("UPDATE clank_durableImportJobs SET _data=? WHERE _id=?").run(JSON.stringify(stored), job.id); await assert.rejects(c.preview(job.id), isCode("IMPORT_REVIEW_METADATA"));
  } finally { await f.close(); }
});

test("a stable creation key resumes a lost initial response without admitting a second job", async () => {
  const f = await fixture();
  try {
    const u = await f.user("create-lost@example.invalid"), file = csv("name,points\nNew,1\n"); let lost = false;
    const c = f.client(u, { fetch: async (url, init) => { const response = await f.fetch(u, url, init); if (!lost && String(url).endsWith("/createReview") && response.ok) { lost = true; await response.text(); throw new Error("initial response lost"); } return response; } });
    await assert.rejects(c.uploadReviewableCsv(file, columns, { key: "stable-source" }), /initial response lost/); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportJobs").get().n, 1); await f.restart();
    const job = await c.uploadReviewableCsv(file, columns, { key: "stable-source" }); assert.equal(job.state, "ready"); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportJobs").get().n, 1); assert.equal((await c.apply(await c.preview(job.id), "accept")).insertedRows, 1);
  } finally { await f.close(); }
});

test("accepted updates and inserts project current search versions in the same transaction", async () => {
  const f = await fixture(); let search;
  try {
    const u = await f.user("search-success@example.invalid"), c = f.client(u); const id = f.insert(u, "Launch");
    search = await openSearch({ path: f.path, auth, schema, source: { name: "imports", table: "records", title: "title", body: "title", scope: "owner" }, authorize: ({ auth }, scope) => auth.user?.id === scope }); search.rebuild();
    const job = await staged(f, u, "name,points\nLaunch,2\nNew,3\n"), p = await c.preview(job.id); await c.apply(p, "search-success");
    const client = createSearchClient({ url: "https://imports.test/__clank/search", fetch: (url, init) => search.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: u.cookie, origin: "https://imports.test" } })) }); assert.equal((await client.search(u.id, "launch")).hits[0].id, id); assert.equal((await client.search(u.id, "new")).total, 1); const state = search.inspect(); assert.equal(state.indexedRecords, 2); assert.equal(state.missing + state.stale + state.orphan, 0);
    await c.apply(p, "search-success"); assert.equal(search.inspect().indexedRecords, 2); assert.equal(f.rows(u)[0]._version, 2);
  } finally { search?.close(); await f.close(); }
});

test("preopened upgraded streaming writers read defaulted metadata and cannot bypass review-enabled jobs", async () => {
  const f = await fixture(); let legacy;
  try {
    const u = await f.user("mixed-writers@example.invalid"); legacy = await openDurableImport({ ...f.settings, reviewable: undefined });
    const c = f.client(u), streaming = f.client(u, { fetch: (url, init) => legacy.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: u.cookie, origin: "https://imports.test" } })) });
    let old = await streaming.create("Legacy", "legacy"); await streaming.append(old.id, 0, [{ title: "Existing", score: 1 }]); old = await streaming.seal(old.id, 1); assert.equal(old.review, undefined);
    const reviewed = await staged(f, u, "name,points\nReviewed,2\n"); assert.deepEqual(await streaming.inspect(reviewed.id), reviewed);
    await assert.rejects(streaming.step(reviewed.id, 0), isCode("IMPORT_REVIEW_REQUIRED")); await assert.rejects(streaming.cancel(reviewed.id), isCode("IMPORT_REVIEW_REQUIRED")); await assert.rejects(streaming.retry(reviewed.id), isCode("IMPORT_REVIEW_REQUIRED"));
    assert.equal((await streaming.run(old.id)).state, "completed"); assert.equal((await c.inspect(old.id)).review, undefined); assert.equal((await c.apply(await c.preview(reviewed.id), "reviewed")).state, "completed"); assert.equal(f.rows(u).length, 2);
  } finally { legacy?.close(); await f.close(); }
});
