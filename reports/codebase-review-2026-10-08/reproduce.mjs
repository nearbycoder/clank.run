import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAuth } from "../../dist/auth.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../../dist/backend.js";
import { s } from "../../dist/ai.js";
import { SQLITE_INTERNAL } from "../../dist/sqlite-internal.js";
import { openSearch, createSearchClient } from "../../dist/search.js";
import { openCollaborativeDocuments, createCollaborativeDocumentsClient } from "../../dist/collaborative-documents.js";
import { openDurableImport, createDurableImportClient } from "../../dist/durable-import.js";

// Disposable verification of the fixes against the current branch.
// reproduction.json preserves the original main-revision failures.
async function fixture(open, prefix, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-codebase-review-"));
  const path = join(root, "app.sqlite");
  const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
  const schema = defineDatabase({ records: defineTable({ title: s.string(), score: s.number() }).owned() });
  const definition = defineBackend({ schema, auth }).functions(() => ({}));
  const runtime = await openBackend(definition, { path, agent: false });
  let service;
  try {
    service = await open({ path, auth, schema, table: "records", fields: ["title", "score"], ...extra });
    const response = await runtime.handle(new Request("https://review.test/__clank/auth/register", {
      method: "POST",
      headers: { origin: "https://review.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "review@example.invalid", password: "correct horse battery staple" }),
    }));
    assert.equal(response.status, 201);
    const data = await response.json();
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];
    return {
      service,
      sql: runtime.database[SQLITE_INTERNAL],
      options: {
        url: `https://review.test/__clank/${prefix}`,
        auth: { csrfHeader: () => ({ "x-clank-csrf": data.csrfToken }) },
        fetch: (url, init) => service.handle(new Request(url, {
          ...init, headers: { ...init.headers, cookie, origin: "https://review.test" },
        })),
      },
      async close() { service.close(); runtime.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    service?.close(); runtime.close(); await rm(root, { recursive: true, force: true }); throw error;
  }
}

const evidence = {};
const search = await fixture(openSearch, "search", {
  maxCandidates: 1, authorize: () => true, authorizeRecord: (_context, record) => record.id !== "hidden",
});
try {
  const client = createSearchClient(search.options);
  const absent = await client.search("team", "classified");
  search.service.upsert({ scope: "team", id: "hidden", title: "classified launch", body: "hidden launch" });
  const hiddenOnly = await client.search("team", "classified");
  search.service.upsert({ scope: "team", id: "visible", title: "classified launch", body: "visible launch" });
  const hiddenThenVisible = await client.search("team", "launch");
  assert.equal(absent.truncated, false);
  assert.equal(hiddenOnly.truncated, false);
  assert.deepEqual(hiddenThenVisible.hits.map(hit => hit.id), ["visible"]);
  assert.equal(hiddenThenVisible.truncated, false);
  search.service.remove("team", "hidden");
  const visibleOnly = await client.search("team", "launch");
  assert.deepEqual(visibleOnly.hits.map(hit => hit.id), ["visible"]);
  // Denied corpus growth must not change the returned truncation flag.
  search.service.remove("team", "visible");
  search.service.upsert({ scope: "team", id: "hidden", title: "classified", body: "classified" });
  const anotherDenied = await fixture(openSearch, "search", { maxCandidates: 1, authorize: () => true, authorizeRecord: () => false });
  try {
    const deniedClient = createSearchClient(anotherDenied.options);
    anotherDenied.service.upsert({ scope: "team", id: "a", title: "classified", body: "classified" });
    const oneDenied = await deniedClient.search("team", "classified");
    anotherDenied.service.upsert({ scope: "team", id: "b", title: "classified", body: "classified" });
    const twoDenied = await deniedClient.search("team", "classified");
    assert.equal(oneDenied.truncated, false);
    assert.equal(twoDenied.truncated, false);
    evidence.searchCandidateCap = { maximum: 1, hiddenThenVisible, visibleOnly, oneDenied, twoDenied };
  } finally { await anotherDenied.close(); }
} finally { await search.close(); }

const accents = await fixture(openSearch, "search", { authorize: () => true });
try {
  accents.service.upsert({ scope: "team", id: "accent", title: "Café", body: `${"padding ".repeat(50)}café` });
  const result = await createSearchClient(accents.options).search("team", "cafe");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].score, 5);
  assert.equal(result.hits[0].snippet.includes("café"), true);
  evidence.searchDiacritics = result;
} finally { await accents.close(); }

const documents = await fixture(openCollaborativeDocuments, "documents", { retainedOperations: 2, retainedReceipts: 2, authorize: () => true });
try {
  const client = createCollaborativeDocumentsClient(documents.options);
  await client.create("shared", "");
  for (let index = 0; index < 8; index++) {
    await client.edit({ documentId: "shared", operationId: `edit-${index}`, baseRevision: index + 1, start: index, deleteCount: 0, insert: "x" });
  }
  const operations = Number(documents.sql.prepare('SELECT COUNT(*) AS count FROM "clank_collaborativeOperations"').get().count);
  const receipts = Number(documents.sql.prepare('SELECT COUNT(*) AS count FROM "clank_collaborativeReceipts"').get().count);
  assert.equal(operations, 2);
  assert.equal(receipts, 2);
  evidence.collaborativeReceiptRetention = { retainedOperations: 2, edits: 8, operations, receipts };
} finally { await documents.close(); }

const imports = await fixture(openDurableImport, "imports", { maxRows: 1 });
try {
  const client = createDurableImportClient(imports.options);
  for (let index = 0; index < 22; index++) {
    const job = await client.create(`Cancelled ${index}`, `source-${index}`);
    await client.append(job.id, 0, [{ title: "Retained payload", score: index }]);
    await client.cancel(job.id);
  }
  const jobs = Number(imports.sql.prepare('SELECT COUNT(*) AS count FROM "clank_durableImportJobs"').get().count);
  const chunks = Number(imports.sql.prepare('SELECT COUNT(*) AS count FROM "clank_durableImportChunks"').get().count);
  assert.equal(jobs, 22);
  assert.equal(chunks, 0);
  evidence.terminalImportRetention = { maxRows: 1, activeJobLimit: 20, retainedJobLimit: 10000, jobs, chunks };
} finally { await imports.close(); }

console.log(JSON.stringify(evidence, null, 2));
