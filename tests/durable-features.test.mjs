import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineAuth } from "../dist/auth.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../dist/backend.js";
import { s } from "../dist/ai.js";
import { openBulkEditor, createBulkEditClient } from "../dist/bulk-edit.js";
import { openSearch, createSearchClient } from "../dist/search.js";
import { openCollaborativeDocuments, createCollaborativeDocumentsClient, textEdit } from "../dist/collaborative-documents.js";
import { openSharedSavedViews, createSharedViewsClient } from "../dist/saved-views.js";
import { openDurableImport, createDurableImportClient } from "../dist/durable-import.js";
import { featureTables } from "../dist/feature-service.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

test("service metadata cannot replace an application table definition", () => {
  const application = defineTable({ privateValue: s.string() }).owned();
  const schema = defineDatabase({ records: application, sharedSavedViews: application });
  const metadata = defineTable({ workspaceId: s.string() });
  assert.throws(() => featureTables(schema, { sharedSavedViews: metadata }), /sharedSavedViews conflicts with an application table/);
  assert.equal(schema.tables.sharedSavedViews, application);
  assert.equal(schema.tables.sharedSavedViews.ownership, "user");
  const merged = featureTables(schema, { additionalMetadata: metadata });
  assert.equal(merged.records, application);
  assert.equal(merged.additionalMetadata, metadata);
  assert.equal(Object.hasOwn(schema.tables, "additionalMetadata"), false);
});

async function fixture(openService, serviceOptions = {}, authOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-durable-features-"));
  const path = join(directory, "app.sqlite"), auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 }, ...authOptions });
  const schema = defineDatabase({ records: defineTable({ title: s.string({ min: 1, max: 5000 }), score: s.number({ integer: true }), active: s.default(s.boolean(), false) }).owned() });
  const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({ list: query({ args: {}, handler: ({ db }) => db.table("records").collect() }), create: mutation({ args: { title: s.string(), score: s.number() }, handler: ({ db }, input) => db.table("records").insert({ ...input, active: false }) }) }));
  let runtime = await openBackend(backend, { path, agent: false });
  const settings = { path, auth, schema, table: "records", fields: ["title", "score"], ...serviceOptions };
  let service = await openService(settings);
  return {
    get service() { return service; }, get runtime() { return runtime; },
    async user(email) { const response = await runtime.handle(new Request("https://features.test/__clank/auth/register", { method: "POST", headers: { origin: "https://features.test", "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery staple" }) })); assert.equal(response.status, 201); const data = await response.json(); const cookie = response.headers.get("set-cookie").split(";", 1)[0]; return { ...data.user, cookie, csrf: data.csrfToken }; },
    caller(user) { return runtime.caller(new Request("https://features.test/", { headers: { cookie: user.cookie } })); },
    clientOptions(prefix, user) { return { url: `https://features.test/__clank/${prefix}`, auth: { csrfHeader: () => ({ "x-clank-csrf": user.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: "https://features.test" } })) }; },
    async restart() { service.close(); runtime.close(); runtime = await openBackend(backend, { path, agent: false }); service = await openService(settings); },
    async close() { service.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("bulk editing previews typed changes, checks current ACL/versions, and rolls back the entire selected batch", async (t) => {
  const denied = new Set();
  const app = await fixture(openBulkEditor, { authorize: (_context, record) => !denied.has(record._id) });
  try {
    const alice = await app.user("alice@example.invalid"), bob = await app.user("bob@example.invalid"), a = await app.caller(alice), b = await app.caller(bob);
    // Equal creation times sort by ID, which need not match insertion order.
    const now = Date.now(), uuids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"];
    const clock = t.mock.method(Date, "now", () => now);
    const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => uuids.shift());
    let ids;
    try {
      ids = [a.mutation("create", { title: "First", score: 1 }).value, a.mutation("create", { title: "Second", score: 2 }).value];
    } finally { clock.mock.restore(); uuid.mock.restore(); }
    assert.deepEqual(a.query("list").value.map(row => row._id), [ids[1], ids[0]]);
    const other = b.mutation("create", { title: "Other", score: 3 }).value;
    const client = createBulkEditClient(app.clientOptions("bulk", alice));
    const preview = await client.preview(ids, { score: 10 }); assert.equal(preview.records.length, 2); assert.equal(preview.records[0].after.score, 10);
    await assert.rejects(client.preview([...ids, other], { score: 10 }), error => error.status === 404);
    await assert.rejects(client.preview(ids, { score: 1.5 }));
    await assert.rejects(client.preview(ids, { active: true }));
    denied.add(ids[1]);
    await assert.rejects(client.preview(ids, { score: 10 }), error => error.status === 404, "cached preview must recheck current ACL");
    await assert.rejects(client.apply(preview), error => error.status === 404);
    assert.deepEqual(new Map(a.query("list").value.map(row => [row._id, row.score])), new Map([[ids[0], 1], [ids[1], 2]]));
    denied.clear(); assert.deepEqual(await client.apply(preview), { updated: 2 });
    await assert.rejects(client.apply(preview), error => error.code === "BULK_PREVIEW_STALE");
    assert.deepEqual(new Map(a.query("list").value.map(row => [row._id, row.score])), new Map(ids.map(id => [id, 10])));
  } finally { await app.close(); }
});

test("FTS authorization precedes ranking/snippets and current ACL revocation invalidates identical queries", async () => {
  const blocked = new Set(["hidden"]), members = new Set();
  const app = await fixture(openSearch, { authorize: ({ auth }, scope) => scope === "team" && members.has(auth.user.id), authorizeRecord: (_context, record) => !blocked.has(record.id) });
  try {
    const alice = await app.user("alice@example.invalid"), bob = await app.user("bob@example.invalid"); members.add(alice.id);
    const client = createSearchClient(app.clientOptions("search", alice)), outsider = createSearchClient(app.clientOptions("search", bob));
    app.service.upsert({ scope: "team", id: "visible", title: "Launch plan", body: "Discuss the launch checklist." });
    app.service.upsert({ scope: "team", id: "hidden", title: "Launch secret", body: "Highly confidential launch launch launch." });
    app.service.upsert({ scope: "other", id: "other", title: "Launch elsewhere", body: "Private launch." });
    const first = await client.search("team", "launch"); assert.deepEqual(first.hits.map(row => row.id), ["visible"]); assert.doesNotMatch(JSON.stringify(first), /secret|confidential|elsewhere/u);
    await assert.rejects(outsider.search("team", "launch"), error => error.status === 404);
    app.service.upsert({ scope: "team", id: "hidden", title: "launch ".repeat(50), body: "launch ".repeat(1000) });
    assert.equal((await client.search("team", "launch")).hits[0].score, first.hits[0].score, "hidden corpus cannot affect score");
    assert.deepEqual((await client.search("team", "launch OR stolen")).hits, []);
    await app.restart(); assert.equal((await client.search("team", "launch")).hits[0].id, "visible");
    members.delete(alice.id); await assert.rejects(client.search("team", "launch"), error => error.status === 404);
  } finally { await app.close(); }
});

test("durable text editing rebases disjoint concurrent edits, rejects overlaps, and deduplicates after restart", async () => {
  const members = new Set();
  const app = await fixture(openCollaborativeDocuments, { retainedOperations: 2, authorize: ({ auth }, id) => id === "shared" && members.has(auth.user.id) });
  try {
    const alice = await app.user("alice@example.invalid"), bob = await app.user("bob@example.invalid"); members.add(alice.id); members.add(bob.id);
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "abcdef");
    const operation = { documentId: "shared", operationId: "first", baseRevision: 1, start: 0, deleteCount: 0, insert: "X" };
    await a.edit(operation);
    const second = await b.edit({ documentId: "shared", operationId: "second", baseRevision: 1, start: 6, deleteCount: 0, insert: "Y" }); assert.equal(second.text, "XabcdefY");
    await a.edit({ documentId: "shared", operationId: "third", baseRevision: 3, start: 1, deleteCount: 3, insert: "A" });
    await assert.rejects(b.edit({ documentId: "shared", operationId: "overlap", baseRevision: 3, start: 2, deleteCount: 2, insert: "B" }), error => error.code === "COLLAB_EDIT_CONFLICT");
    await app.restart(); const duplicate = await a.edit(operation); assert.equal(duplicate.acceptedRevision, 2); assert.equal(duplicate.text, "XAdefY"); assert.equal(duplicate.revision, 4);
    await assert.rejects(a.edit({ ...operation, insert: "Different" }), error => error.code === "EDIT_KEY_REUSED");
    await assert.rejects(a.edit({ ...operation, operationId: "too-old" }), error => error.code === "COLLAB_EDIT_CONFLICT");
    assert.deepEqual(textEdit("abc", "axc"), { start: 1, deleteCount: 1, insert: "x" });
    await b.read("shared"); members.delete(bob.id); await assert.rejects(b.read("shared"), error => error.status === 404);
    await assert.rejects(b.edit({ documentId: "shared", operationId: "revoked", baseRevision: 4, start: 0, deleteCount: 0, insert: "!" }), error => error.status === 404);
  } finally { await app.close(); }
});

test("shared saved views enforce member/editor permissions, optimistic updates, and one workspace default", async () => {
  const roles = new Map();
  const app = await fixture(openSharedSavedViews, { fields: ["title", "score"], authorize: ({ auth }, scope, operation) => { const role = roles.get(auth.user.id); return scope === "team" && Boolean(role) && (operation === "read" || role === "owner" || operation !== "default" && role === "editor"); } });
  try {
    const owner = await app.user("owner@example.invalid"), editor = await app.user("editor@example.invalid"), reader = await app.user("reader@example.invalid"); roles.set(owner.id, "owner"); roles.set(editor.id, "editor"); roles.set(reader.id, "reader");
    const a = createSharedViewsClient({ ...app.clientOptions("shared-views", owner), workspaceId: "team" }), b = createSharedViewsClient({ ...app.clientOptions("shared-views", editor), workspaceId: "team" }), c = createSharedViewsClient({ ...app.clientOptions("shared-views", reader), workspaceId: "team" });
    const definition = { filters: [], sort: [], columns: ["title"] };
    const row = await a.save({ name: "Team", definition, editableBy: "workspace" });
    assert.equal((await c.list())[0].canEdit, false);
    await assert.rejects(c.save({ id: row.id, expectedRevision: 1, name: "Stolen", definition }), error => error.status === 404);
    const updated = await b.save({ id: row.id, expectedRevision: 1, name: "Edited", definition }); assert.equal(updated.revision, 2);
    await assert.rejects(a.save({ id: row.id, expectedRevision: 1, name: "Stale", definition }), error => error.code === "VIEW_CHANGED");
    const privateEditing = await a.save({ name: "Owner editing", definition });
    await assert.rejects(b.remove(privateEditing.id, 1), error => error.status === 404);
    await a.setDefault(row.id); await a.setDefault(privateEditing.id); assert.deepEqual((await c.list()).filter(view => view.isDefault).map(view => view.id), [privateEditing.id]);
    await assert.rejects(c.setDefault(row.id), error => error.status === 404);
    await app.restart(); assert.equal((await a.list()).length, 2);
    roles.delete(owner.id); await assert.rejects(a.list(), error => error.status === 404);
    await assert.rejects(a.remove(privateEditing.id, 2), error => error.status === 404, "authorship cannot bypass membership revocation");
  } finally { await app.close(); }
});

test("imports persist chunks and cursors, reject changed retries, and resume exactly once after restart", async () => {
  const app = await fixture(openDurableImport, { batchSize: 2, uniqueBy: ["score"] });
  try {
    const alice = await app.user("alice@example.invalid"), bob = await app.user("bob@example.invalid"), client = createDurableImportClient(app.clientOptions("imports", alice)), outsider = createDurableImportClient(app.clientOptions("imports", bob));
    const job = await client.create("Rows", "durable-source"); assert.equal((await client.create("Rows", "durable-source")).id, job.id);
    const rows = [1, 2, 3, 4].map(score => ({ title: `Row ${score}`, score }));
    await client.append(job.id, 0, rows.slice(0, 2)); await client.append(job.id, 0, rows.slice(0, 2));
    await assert.rejects(client.append(job.id, 0, [{ title: "Changed", score: 1 }, rows[1]]), error => error.code === "IMPORT_CHUNK_CHANGED");
    await client.append(job.id, 1, rows.slice(2)); await client.seal(job.id, 2);
    await assert.rejects(outsider.inspect(job.id), error => error.status === 404);
    const first = await client.step(job.id, 0); assert.equal(first.processedRows, 2); assert.equal(first.insertedRows, 2);
    const replay = await client.step(job.id, 0); assert.equal(replay.processedRows, 2);
    await app.restart(); const done = await client.run(job.id); assert.equal(done.state, "completed"); assert.equal(done.insertedRows, 4);
    assert.equal((await app.caller(alice)).query("list").value.length, 4);
    assert.equal((await client.step(job.id, 0)).insertedRows, 4);
  } finally { await app.close(); }
});

test("imports preflight every row before a batch commits, expose safe row issues, and honor cancellation", async () => {
  let deny = true;
  const app = await fixture(openDurableImport, { batchSize: 2, uniqueBy: ["score"], authorize: (_context, record, operation) => operation !== "apply" || !deny || record.score !== 2 });
  try {
    const alice = await app.user("alice@example.invalid"), client = createDurableImportClient(app.clientOptions("imports", alice));
    const job = await client.create("Authorization"); await client.append(job.id, 0, [1, 2, 3].map(score => ({ title: `Secret value ${score}`, score }))); await client.seal(job.id, 1);
    const failed = await client.step(job.id, 0); assert.equal(failed.state, "failed"); assert.deepEqual(failed.issues, [{ row: 3, code: "FORBIDDEN" }]); assert.doesNotMatch(JSON.stringify(failed.issues), /Secret value/u);
    assert.equal((await app.caller(alice)).query("list").value.length, 0);
    deny = false; await client.retry(job.id); await client.step(job.id, 0); await client.cancel(job.id); const cancelled = await client.run(job.id); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.processedRows, 2);
    assert.equal((await app.caller(alice)).query("list").value.length, 2);
    const duplicate = await client.create("Duplicate"); await client.append(duplicate.id, 0, [{ title: "New", score: 10 }, { title: "Duplicate existing", score: 1 }]); await client.seal(duplicate.id, 1); const result = await client.run(duplicate.id); assert.equal(result.state, "failed"); assert.equal(result.insertedRows, 0); assert.equal(result.issues[0].code, "DUPLICATE");
    assert.equal((await app.caller(alice)).query("list").value.length, 2);
  } finally { await app.close(); }
});

test("CSV upload streams files larger than the original 5 MiB parser ceiling and resumes existing chunks", async () => {
  const app = await fixture(openDurableImport);
  try {
    const alice = await app.user("alice@example.invalid"), client = createDurableImportClient(app.clientOptions("imports", alice));
    const file = new Blob(["title,score\r\n", ...Array.from({ length: 2000 }, (_entry, index) => `${"Long title ".repeat(300)},${index}\r\n`)]);
    assert.ok(file.size > 5 * 1024 * 1024);
    const columns = [{ source: "title", target: "title", type: "text", required: true }, { source: "score", target: "score", type: "integer", required: true }];
    const uploaded = await client.uploadCsv(file, columns, { name: "Large CSV" }); assert.equal(uploaded.uploadedRows, 2000); assert.equal(uploaded.chunks, 4); assert.equal(uploaded.state, "ready");
    await app.restart(); assert.equal((await client.uploadCsv(file, columns, { id: uploaded.id })).uploadedRows, 2000);
    await client.cancel(uploaded.id);
    const quoted = await client.uploadCsv(new Blob(['title,score\r\n"Two\nlines and ""quotes""",1\r\n']), columns, { name: "Quoted" }); const done = await client.run(quoted.id); assert.equal(done.insertedRows, 1); assert.equal((await app.caller(alice)).query("list").value[0].title, 'Two\nlines and "quotes"');
  } finally { await app.close(); }
});

test("search budgets ignore denied matches and preserve accent match coordinates", async () => {
  const allowed = new Set(["visible"]);
  const app = await fixture(openSearch, { maxCandidates: 1, maxScopeRecords: 5, authorize: () => true, authorizeRecord: (_context, record) => allowed.has(record.id) });
  try {
    const user = await app.user("search-budget@example.invalid"), client = createSearchClient(app.clientOptions("search", user));
    for (let i = 0; i < 3; i++) app.service.upsert({ scope: "team", id: `hidden-${i}`, title: "Cafe", body: "cafe" });
    assert.deepEqual(await client.search("team", "cafe"), { hits: [], total: 0, truncated: false });
    const body = `${"e\u0301".repeat(180)} A Café for everyone.`;
    app.service.upsert({ scope: "team", id: "visible", title: "Café", body });
    const result = await client.search("team", "cafe");
    assert.deepEqual(result.hits.map(hit => hit.id), ["visible"]);
    assert.equal(result.total, 1); assert.equal(result.truncated, false); assert.equal(result.hits[0].score, 5);
    assert.match(result.hits[0].snippet, /Café for everyone/u);
    app.service.upsert({ scope: "greek", id: "visible", title: "Άλφα", body: "άλφα" });
    assert.equal((await client.search("greek", "άλφα")).hits[0].score, 5, "unicode61 retains non-Latin diacritics");
    app.service.upsert({ scope: "team", id: "also-visible", title: "Cafe", body: "cafe" }); allowed.add("also-visible");
    assert.equal((await client.search("team", "cafe")).truncated, true);
    assert.throws(() => app.service.upsert({ scope: "team", id: "overflow", title: "Cafe", body: "cafe" }), /capacity/u);
    app.service.upsert({ scope: "team", id: "visible", title: "Updated Café", body });
    await app.restart(); allowed.clear(); assert.deepEqual(await client.search("team", "cafe"), { hits: [], total: 0, truncated: false });
  } finally { await app.close(); }
});

test("collaboration accepts the largest declared history window without exceeding query limits", async () => {
  const app = await fixture(openCollaborativeDocuments, { retainedOperations: 10000, authorize: () => true });
  try {
    const user = await app.user("largest-history@example.invalid"), client = createCollaborativeDocumentsClient(app.clientOptions("documents", user));
    await client.create("shared", "");
    assert.equal((await client.edit({ documentId: "shared", operationId: "first", baseRevision: 1, start: 0, deleteCount: 0, insert: "ok" })).text, "ok");
  } finally { await app.close(); }
});

test("collaboration prunes replay receipts only beyond the rebase window and rejects expired retries", async () => {
  const app = await fixture(openCollaborativeDocuments, { retainedOperations: 2, retainedReceipts: 2, maxReceipts: 2, authorize: () => true });
  try {
    const user = await app.user("receipt-window@example.invalid"), client = createCollaborativeDocumentsClient(app.clientOptions("documents", user));
    await client.create("shared", "");
    const first = { documentId: "shared", operationId: "edit-1", baseRevision: 1, start: 0, deleteCount: 0, insert: "x" };
    await client.edit(first);
    for (let revision = 2; revision <= 12; revision++) await client.edit({ ...first, operationId: `edit-${revision}`, baseRevision: revision, start: revision - 1 });
    const native = app.runtime.database[SQLITE_INTERNAL];
    assert.equal(Number(native.prepare("SELECT count(*) AS count FROM clank_collaborativeReceipts").get().count), 2);
    assert.equal(Number(native.prepare("SELECT count(*) AS count FROM clank_document_revisions WHERE table_name IN ('collaborativeReceipts', 'collaborativeOperations')").get().count), 4, "expired operations and receipts do not survive in document history");
    await app.restart();
    await assert.rejects(client.edit(first), error => error.code === "COLLAB_EDIT_CONFLICT");
    const duplicate = await client.edit({ ...first, operationId: "edit-12", baseRevision: 12, start: 11 });
    assert.equal(duplicate.acceptedRevision, 13); assert.equal(duplicate.text, "x".repeat(12));
    await client.create("second", "");
    await assert.rejects(client.edit({ ...first, documentId: "second" }), error => error.code === "COLLAB_RECEIPT_CAPACITY");
    assert.equal((await client.read("second")).revision, 1);
  } finally { await app.close(); }
});

test("imports retire terminal source/history while preserving replay identity and enforcing global capacity", async () => {
  const app = await fixture(openDurableImport, { maxJobs: 2, maxChunks: 1, maxStagedBytes: 1000 });
  try {
    const user = await app.user("import-retention@example.invalid"), client = createDurableImportClient(app.clientOptions("imports", user));
    const job = await client.create("Completed", "first-key");
    await assert.rejects(client.append(job.id, 0, [{ title: "x".repeat(1500), score: 1 }]), error => error.code === "IMPORT_STAGING_CAPACITY");
    await client.append(job.id, 0, [{ title: "Keep imported target", score: 1 }]);
    await assert.rejects(client.append(job.id, 1, [{ title: "Overflow", score: 2 }]), error => error.code === "IMPORT_STAGING_CAPACITY");
    await client.seal(job.id, 1); assert.equal((await client.run(job.id)).state, "completed");
    await assert.rejects(client.append(job.id, 0, [{ title: "Keep imported target", score: 1 }]), error => error.code === "IMPORT_PAYLOAD_RETIRED");
    const cancelled = await client.create("Cancelled", "second-key"); await client.append(cancelled.id, 0, [{ title: "Discard source", score: 2 }]); await client.cancel(cancelled.id);
    const native = app.runtime.database[SQLITE_INTERNAL];
    assert.equal(Number(native.prepare("SELECT count(*) AS count FROM clank_durableImportChunks").get().count), 0);
    assert.equal(Number(native.prepare("SELECT count(*) AS count FROM clank_document_revisions WHERE table_name = 'durableImportChunks'").get().count), 0);
    await app.restart();
    assert.equal((await client.create("Completed", "first-key")).id, job.id);
    assert.equal((await client.step(job.id, 0)).insertedRows, 1);
    assert.equal((await client.step(cancelled.id, 0)).state, "cancelled");
    await assert.rejects(client.create("Overflow", "third-key"), error => error.code === "IMPORT_JOB_CAPACITY");
    assert.deepEqual((await app.caller(user)).query("list").value.map(row => row.title), ["Keep imported target"]);
  } finally { await app.close(); }
});

test("document cursors rebase through edits, remain session-private, and discard unavailable history", async () => {
  const members = new Set();
  const app = await fixture(openCollaborativeDocuments, { retainedOperations: 2, authorize: ({ auth }) => members.has(auth.user.id) });
  try {
    const alice = await app.user("cursor-alice@example.invalid"), bob = await app.user("cursor-bob@example.invalid"); members.add(alice.id); members.add(bob.id);
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "Hello world");
    const cursor = await a.setCursor("shared", { revision: 1, anchor: 6, head: 11 });
    const auth = await app.runtime.auth.resolve(new Request("https://features.test/", { headers: { cookie: alice.cookie } }));
    assert.doesNotMatch(JSON.stringify(await b.cursors("shared")), new RegExp(auth.session.id));
    await b.clearCursor("shared"); assert.equal((await b.cursors("shared")).length, 1, "another session cannot clear the cursor");
    await b.edit({ documentId: "shared", operationId: "prefix", baseRevision: 1, start: 0, deleteCount: 0, insert: "X " });
    assert.deepEqual((await b.cursors("shared")).map(({ revision, anchor, head }) => ({ revision, anchor, head })), [{ revision: 2, anchor: 8, head: 13 }]);
    assert.equal((await a.setCursor("shared", { revision: 1, anchor: 6, head: 11 })).id, cursor.id, "stale but retained coordinates rebase, without duplicating the participant");
    await b.edit({ documentId: "shared", operationId: "delete", baseRevision: 2, start: 9, deleteCount: 2, insert: "Y" });
    assert.deepEqual(await a.setCursor("shared", { revision: 2, anchor: 9, head: 10 }), { ...cursor, revision: 3, anchor: 10, head: 10, expiresAt: (await b.cursors("shared"))[0].expiresAt });
    await assert.rejects(a.setCursor("shared", { revision: 3, anchor: 100, head: 100 }), error => error.code === "INVALID_INPUT");
    for (let revision = 3; revision <= 5; revision++) await b.edit({ documentId: "shared", operationId: `advance-${revision}`, baseRevision: revision, start: 0, deleteCount: 0, insert: "x" });
    assert.deepEqual(await b.cursors("shared"), [], "a cursor outside retained history disappears instead of inventing its location");
    await a.setCursor("shared", { revision: 6, anchor: 0, head: 0 }); members.delete(alice.id);
    assert.deepEqual(await b.cursors("shared"), [], "participant ACL revocation removes selection before disclosure");
    await assert.rejects(a.cursors("shared"), error => error.status === 404);
    members.add(alice.id); await a.setCursor("shared", { revision: 6, anchor: 0, head: 0 });
    app.runtime.auth.revokeUserSessions(alice.id); assert.deepEqual(await b.cursors("shared"), [], "revoked sessions are not retained as presence");
    await b.setCursor("shared", { revision: 6, anchor: 1, head: 1 }); await app.restart();
    assert.deepEqual(await b.cursors("shared"), [], "restart requires fresh ephemeral presence");
    await b.setCursor("shared", { revision: 6, anchor: 1, head: 1 }); assert.equal((await b.cursors("shared")).length, 1);
  } finally { await app.close(); }
});

test("document cursors enforce expiry, global admission, origin and CSRF", async t => {
  const app = await fixture(openCollaborativeDocuments, { cursorTtlMs: 1000, maxCursors: 1, authorize: () => true });
  try {
    const alice = await app.user("cursor-limits-a@example.invalid"), bob = await app.user("cursor-limits-b@example.invalid");
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "text");
    await a.setCursor("shared", { revision: 1, anchor: 0, head: 0 });
    await assert.rejects(b.setCursor("shared", { revision: 1, anchor: 0, head: 0 }), error => error.code === "CURSOR_CAPACITY");
    const now = Date.now(), clock = t.mock.method(Date, "now", () => now + 1001);
    try { assert.deepEqual(await b.cursors("shared"), []); await b.setCursor("shared", { revision: 1, anchor: 0, head: 0 }); } finally { clock.mock.restore(); }
    const request = (origin, csrf) => new Request("https://features.test/__clank/documents/mutation/setCursor", { method: "POST", headers: { "content-type": "application/json", cookie: alice.cookie, origin, "x-clank-csrf": csrf }, body: JSON.stringify({ documentId: "shared", revision: 1, anchor: 0, head: 0 }) });
    assert.equal((await app.service.handle(request("https://features.test", ""))).status, 403);
    assert.equal((await app.service.handle(request("https://evil.invalid", alice.csrf))).status, 403);
  } finally { await app.close(); }
});

test("named document branches persist, merge disjoint edits once and preserve reviewed version fences", async () => {
  const app = await fixture(openCollaborativeDocuments, { authorize: () => true });
  try {
    const alice = await app.user("branch-alice@example.invalid"), bob = await app.user("branch-bob@example.invalid");
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "Hello world");
    const draft = await a.createBranch("shared", "proposal-1", "Improve greeting", 1);
    await assert.rejects(b.saveBranch("shared", draft.id, draft.version, "Stolen"), error => error.status === 404);
    const saved = await a.saveBranch("shared", draft.id, draft.version, "Hello earth");
    assert.equal((await a.saveBranch("shared", draft.id, draft.version, "Hello earth")).version, saved.version, "lost save response is replay-safe");
    await assert.rejects(a.saveBranch("shared", draft.id, draft.version, "Changed retry"), error => error.code === "BRANCH_STALE");
    const proposed = await a.proposeBranch("shared", draft.id, saved.version);
    assert.equal((await a.proposeBranch("shared", draft.id, saved.version)).version, proposed.version);
    await b.edit({ documentId: "shared", operationId: "salutation", baseRevision: 1, start: 0, deleteCount: 0, insert: "Dear " });
    const preview = await b.previewBranch("shared", draft.id); assert.equal(preview.after, "Dear Hello earth"); assert.equal(preview.before, "Dear Hello world");
    await b.edit({ documentId: "shared", operationId: "prefix", baseRevision: 2, start: 0, deleteCount: 0, insert: "!" });
    await assert.rejects(b.decideBranch("shared", draft.id, proposed.version, "accept", preview.documentRevision), error => error.code === "BRANCH_STALE");
    assert.equal((await a.readBranch("shared", draft.id)).status, "proposed");
    const current = await b.previewBranch("shared", draft.id);
    const accepted = await b.decideBranch("shared", draft.id, current.branch.version, "accept", current.documentRevision);
    assert.equal(accepted.acceptedRevision, 4); assert.equal((await a.read("shared")).text, "!Dear Hello earth");
    await app.restart();
    assert.equal((await a.readBranch("shared", draft.id)).status, "accepted");
    assert.equal((await b.decideBranch("shared", draft.id, current.branch.version, "accept", current.documentRevision)).acceptedRevision, 4);
    assert.equal((await a.read("shared")).revision, 4, "lost acceptance response never applies twice");
    await assert.rejects(b.decideBranch("shared", draft.id, current.branch.version, "accept", current.documentRevision + 1), error => error.code === "BRANCH_STALE");
    await assert.rejects(a.createBranch("shared", draft.id, "Different name", 1), error => error.code === "BRANCH_ID_REUSED");
    assert.equal((await a.createBranch("shared", draft.id, "Improve greeting", 1)).status, "accepted", "creation identity survives subsequent edits and decisions");
    assert.equal(Object.hasOwn((await a.branches("shared"))[0], "text"), false, "branch listing does not materialize payloads");
  } finally { await app.close(); }
});

test("document proposals reject overlap, enforce current permissions and never evict terminal replay identities", async () => {
  const members = new Set();
  const app = await fixture(openCollaborativeDocuments, { maxBranches: 1, authorize: ({ auth }) => members.has(auth.user.id) });
  try {
    const alice = await app.user("branch-conflict-a@example.invalid"), bob = await app.user("branch-conflict-b@example.invalid"); members.add(alice.id); members.add(bob.id);
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "hello world");
    await assert.rejects(a.createBranch("shared", "old", "Old base", 2), error => error.code === "BRANCH_BASE_STALE");
    const draft = await a.createBranch("shared", "proposal", "Replace hello", 1);
    const saved = await a.saveBranch("shared", draft.id, draft.version, "hi world"), proposal = await a.proposeBranch("shared", draft.id, saved.version);
    await b.edit({ documentId: "shared", operationId: "overlap", baseRevision: 1, start: 1, deleteCount: 2, insert: "XX" });
    await assert.rejects(b.previewBranch("shared", draft.id), error => error.code === "BRANCH_MERGE_CONFLICT");
    await assert.rejects(b.decideBranch("shared", draft.id, proposal.version, "accept", 2), error => error.code === "BRANCH_MERGE_CONFLICT");
    assert.equal((await a.read("shared")).text, "hXXlo world");
    members.delete(bob.id); await assert.rejects(b.readBranch("shared", draft.id), error => error.status === 404);
    await assert.rejects(b.decideBranch("shared", draft.id, proposal.version, "reject", 2), error => error.status === 404); members.add(bob.id);
    const rejected = await b.decideBranch("shared", draft.id, proposal.version, "reject", 2); assert.equal(rejected.status, "rejected");
    await app.restart(); assert.equal((await b.decideBranch("shared", draft.id, proposal.version, "reject", 2)).version, rejected.version);
    await assert.rejects(a.createBranch("shared", "new", "Another", 2), error => error.code === "BRANCH_CAPACITY");
  } finally { await app.close(); }
});

test("cursor participant authorization reads that participant's owned rows rather than the reader's", async () => {
  const app = await fixture(openCollaborativeDocuments, { authorize: ({ db }) => db.table("records").query().where("title", "Member").first() !== null });
  try {
    const alice = await app.user("owned-cursor-a@example.invalid"), bob = await app.user("owned-cursor-b@example.invalid");
    const ac = await app.caller(alice), bc = await app.caller(bob);
    const member = ac.mutation("create", { title: "Member", score: 1 }).value; bc.mutation("create", { title: "Member", score: 1 });
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "safe"); await a.setCursor("shared", { revision: 1, anchor: 1, head: 2 });
    assert.equal((await b.cursors("shared")).length, 1);
    app.runtime.database.transaction(db => db.table("records").patch(member, { title: "Revoked" }), { userId: alice.id });
    assert.deepEqual(await b.cursors("shared"), [], "Bob's remaining Member record must not authorize Alice's presence");
  } finally { await app.close(); }
});

test("branch payload byte admission is atomic and obsolete source history never merges", async () => {
  const app = await fixture(openCollaborativeDocuments, { maxBranchBytes: 6, retainedOperations: 2, authorize: () => true });
  try {
    const user = await app.user("branch-capacity@example.invalid"), client = createCollaborativeDocumentsClient(app.clientOptions("documents", user));
    await client.create("shared", "é"); const draft = await client.createBranch("shared", "one", "Tiny", 1);
    await assert.rejects(client.createBranch("shared", "two", "Overflow", 1), error => error.code === "BRANCH_CAPACITY");
    await assert.rejects(client.saveBranch("shared", draft.id, draft.version, "été"), error => error.code === "BRANCH_CAPACITY");
    assert.equal((await client.readBranch("shared", draft.id)).version, draft.version, "failed byte admission leaves draft untouched");
    const saved = await client.saveBranch("shared", draft.id, draft.version, "ok"), proposed = await client.proposeBranch("shared", draft.id, saved.version);
    for (let revision = 1; revision <= 3; revision++) await client.edit({ documentId: "shared", operationId: `edit-${revision}`, baseRevision: revision, start: 0, deleteCount: 0, insert: "x" });
    await assert.rejects(client.previewBranch("shared", draft.id), error => error.code === "COLLAB_EDIT_CONFLICT");
    await assert.rejects(client.decideBranch("shared", draft.id, proposed.version, "accept", 4), error => error.code === "COLLAB_EDIT_CONFLICT");
    assert.equal((await client.read("shared")).text, "xxxé");
    assert.equal((await client.decideBranch("shared", draft.id, proposed.version, "reject", 4)).status, "rejected");
  } finally { await app.close(); }
});

test("document branch decisions enforce a separate current reviewer policy, including receipt replay", async () => {
  const reviewers = new Set();
  const app = await fixture(openCollaborativeDocuments, { authorize: () => true, authorizeBranchDecision: ({ auth }, branch) => reviewers.has(auth.user.id) && auth.user.id !== branch.authorId });
  try {
    const alice = await app.user("separate-review-a@example.invalid"), bob = await app.user("separate-review-b@example.invalid"); reviewers.add(bob.id);
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "Original"); let branch = await a.createBranch("shared", "proposal", "Change", 1);
    branch = await a.saveBranch("shared", branch.id, branch.version, "Reviewed"); branch = await a.proposeBranch("shared", branch.id, branch.version);
    await assert.rejects(a.decideBranch("shared", branch.id, branch.version, "accept", 1), error => error.status === 404);
    reviewers.clear(); await assert.rejects(b.decideBranch("shared", branch.id, branch.version, "accept", 1), error => error.status === 404);
    assert.equal((await a.read("shared")).text, "Original"); reviewers.add(bob.id);
    assert.equal((await b.decideBranch("shared", branch.id, branch.version, "accept", 1)).acceptedRevision, 2);
    await app.restart(); reviewers.clear();
    await assert.rejects(b.decideBranch("shared", branch.id, branch.version, "accept", 1), error => error.status === 404);
    assert.equal((await a.read("shared")).revision, 2);
  } finally { await app.close(); }
});

test("large retained operation payloads cannot make cursor or branch rebasing materialize unbounded text", async () => {
  const app = await fixture(openCollaborativeDocuments, { maxCharacters: 1000000, authorize: () => true });
  try {
    const user = await app.user("bounded-rebase@example.invalid"), client = createCollaborativeDocumentsClient(app.clientOptions("documents", user));
    await client.create("shared", ""); await client.setCursor("shared", { revision: 1, anchor: 0, head: 0 });
    let branch = await client.createBranch("shared", "small-proposal", "Insert one character", 1);
    branch = await client.saveBranch("shared", branch.id, branch.version, "y"); branch = await client.proposeBranch("shared", branch.id, branch.version);
    const text = "x".repeat(1000000);
    for (let revision = 1; revision <= 17; revision++) await client.edit({ documentId: "shared", operationId: `large-${revision}`, baseRevision: revision, start: 0, deleteCount: revision === 1 ? 0 : text.length, insert: text });
    assert.deepEqual(await client.cursors("shared"), [], "oversized old history discards obsolete presence");
    await assert.rejects(client.edit({ documentId: "shared", operationId: "old-edit", baseRevision: 1, start: 0, deleteCount: 0, insert: "z" }), error => error.code === "COLLAB_EDIT_CONFLICT");
    await assert.rejects(client.previewBranch("shared", branch.id), error => error.code === "COLLAB_EDIT_CONFLICT");
    assert.equal((await client.read("shared")).revision, 18);
    assert.equal((await client.setCursor("shared", { revision: 18, anchor: 10, head: 11 })).revision, 18, "current coordinates do not require old payloads");
  } finally { await app.close(); }
});

test("cursor participants must retain required email verification even while their membership remains", async () => {
  const app = await fixture(openCollaborativeDocuments, { authorize: () => true }, { emailVerification: { required: true, send() {} } });
  try {
    const alice = await app.user("verified-cursor-a@example.invalid"), bob = await app.user("verified-cursor-b@example.invalid"), native = app.runtime.database[SQLITE_INTERNAL];
    const verification = (id, value) => native.transaction(changes => { native.prepare("UPDATE clank_auth_users SET email_verified_at = ? WHERE id = ?").run(value, id); changes.record("__auth", id, id); });
    verification(alice.id, Date.now()); verification(bob.id, Date.now());
    const a = createCollaborativeDocumentsClient(app.clientOptions("documents", alice)), b = createCollaborativeDocumentsClient(app.clientOptions("documents", bob));
    await a.create("shared", "safe"); await a.setCursor("shared", { revision: 1, anchor: 1, head: 2 }); assert.equal((await b.cursors("shared")).length, 1);
    verification(alice.id, null); assert.deepEqual(await b.cursors("shared"), []);
    await assert.rejects(a.setCursor("shared", { revision: 1, anchor: 1, head: 2 }), error => error.status === 403);
  } finally { await app.close(); }
});

test("invalid optional reviewer policy cannot silently fall back to document edit authorization", async () => {
  await assert.rejects(openCollaborativeDocuments({ path: ":memory:", auth: defineAuth(), authorize: () => true, authorizeBranchDecision: false }), /synchronous policy function/u);
});
