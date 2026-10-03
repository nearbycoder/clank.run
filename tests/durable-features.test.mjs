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

async function fixture(openService, serviceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-durable-features-"));
  const path = join(directory, "app.sqlite"), auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
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
