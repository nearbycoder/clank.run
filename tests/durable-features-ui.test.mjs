import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineQueue, compareOfflineConflict, mountOfflineConflictResolver } from "../dist/offline.js";
import { mountBulkEditor } from "../dist/bulk-edit.js";
import { mountCollaborativeEditor } from "../dist/collaborative-documents.js";
import { mountSearch } from "../dist/search.js";
import { mountSharedSavedViews } from "../dist/saved-views.js";
import { mountDurableImporter, mountReviewableImporter } from "../dist/durable-import.js";

class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.childNodes = []; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.value = ""; this.disabled = false; this.ownText = ""; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.ownText = ""; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
  async fire(name) { for (const listener of this.listeners.get(name) ?? []) await listener({ target: this, preventDefault() {} }); await settle(); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value) { this.ownText = value; this.childNodes = []; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() { const document = { createElement: tag => new Element(tag, document) }; const container = document.createElement("div"); return container; }
function descendants(node, tag) { return node.childNodes.flatMap(child => [...(child.tag === tag ? [child] : []), ...descendants(child, tag)]); }
function button(node, text) { const found = descendants(node, "button").find(item => item.textContent === text); assert.ok(found, `Missing button: ${text}`); return found; }

test("offline conflict UI compares three versions, refuses stale server values, and persists the reviewed replacement", async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const queue = createOfflineQueue({ namespace: "ui", userId: "person", currentUser: () => "person", storage, client: { mutateOnce: async () => { throw { status: 409, code: "VERSION_CONFLICT" }; } } });
  const id = await queue.enqueue({ kind: "mutation", path: "update" }, { title: "Local", version: 1 }, { original: { title: "Original" }, local: { title: "Local" } }); await queue.flush();
  let server = { values: { title: "Server" }, version: 2 };
  const container = fixture(), cleanup = mountOfflineConflictResolver(container, queue, { loadServer: async () => server, buildInput: (fields, current) => ({ ...fields, version: current.version }) });
  await button(container, "Compare changes").fire("click"); assert.match(container.textContent, /Original.*Local.*Server/u);
  descendants(container, "select")[0].value = "local";
  server = { values: { title: "New server" }, version: 3 };
  await button(container, "Queue resolved change").fire("click"); assert.match(container.textContent, /Server data changed/u); assert.equal(queue.snapshot()[0].id, id);
  await button(container, "Refresh comparison").fire("click"); descendants(container, "select")[0].value = "local";
  await button(container, "Queue resolved change").fire("click"); const resolved = queue.snapshot()[0]; assert.equal(resolved.status, "pending"); assert.notEqual(resolved.id, id); assert.deepEqual(resolved.input, { title: "Local", version: 3 }); assert.deepEqual(resolved.reconciliation.original, server.values);
  cleanup(); queue.dispose(); assert.equal(container.childNodes.length, 0);
  assert.deepEqual(compareOfflineConflict({ x: 1 }, { x: 2 }, { x: 1 }).map(field => field.conflict), [false]);
});

test("bulk edit controls apply the displayed preview and report a stale rejection without claiming success", async () => {
  const container = fixture(); let reviewed, attempts = 0;
  const cleanup = mountBulkEditor(container, { preview: async (ids, changes) => ({ changes, records: ids.map(id => ({ id, version: 1, before: { title: "Old" }, after: { title: "New" } })) }), apply: async preview => { reviewed = preview; attempts++; throw new Error("stale"); } }, { selection: () => ["one"], changes: () => ({ title: "New" }) });
  await button(container, "Preview selected changes").fire("click"); assert.match(container.textContent, /Old[\s\S]*New/u);
  await button(container, "Apply reviewed changes").fire("click"); assert.equal(attempts, 1); assert.equal(reviewed.records[0].version, 1); assert.match(container.textContent, /Refresh records and preview again/u); cleanup();
});

test("collaborative editor retains local text during a remote change and clears it on revoked access", async () => {
  const container = fixture(); let listener, operation;
  const cleanup = mountCollaborativeEditor(container, { subscribe: (_id, callback) => { listener = callback; return () => {}; }, edit: async input => { operation = input; return { id: "room", text: "Local", revision: 3 }; } }, "room");
  listener({ id: "room", text: "Original", revision: 1 }); const editor = descendants(container, "textarea")[0]; editor.value = "Local"; await editor.fire("input");
  listener({ id: "room", text: "Remote", revision: 2 }); assert.equal(editor.value, "Local"); assert.match(container.textContent, /Remote/u);
  await button(container, "Keep my text using latest revision").fire("click"); await button(container, "Save shared edit").fire("click"); assert.equal(operation.baseRevision, 2); assert.equal(editor.value, "Local");
  listener(null, new Error("Access denied")); assert.equal(editor.value, ""); assert.equal(editor.disabled, true); assert.doesNotMatch(container.textContent, /Remote/u); cleanup();
});

test("search, shared-view and durable-import controls call their clients and render data as text", async () => {
  const search = fixture(); let opened;
  const closeSearch = mountSearch(search, { search: async () => ({ hits: [{ id: "one", title: "<script>Title", snippet: "<b>Snippet", score: 1 }], total: 1, truncated: false }) }, { scope: () => "team", open: id => { opened = id; } }); descendants(search, "input")[0].value = "term"; await descendants(search, "form")[0].fire("submit"); assert.match(search.textContent, /<script>Title/u); await button(search, "<script>Title").fire("click"); assert.equal(opened, "one"); closeSearch();
  const views = fixture(); let applied;
  const closeViews = mountSharedSavedViews(views, { list: async () => [{ id: "view", name: "Read only", definition: { filters: [], sort: [], columns: [] }, isDefault: true, canEdit: false, canSetDefault: false }] }, { current: () => ({ filters: [], sort: [], columns: [] }), apply: view => { applied = view; } }); await settle(); await button(views, "Read only (workspace default)").fire("click"); assert.ok(applied); assert.equal(descendants(views, "button").some(item => item.textContent === "Delete shared view"), false); closeViews();
  const imports = fixture(); let resumed;
  const closeImports = mountDurableImporter(imports, { run: async id => { resumed = id; return { id, state: "completed", uploadedRows: 8, processedRows: 8, insertedRows: 8, skippedRows: 0, issues: [] }; } }, { columns: [] }); descendants(imports, "input")[1].value = "saved-import"; await button(imports, "Run or resume import").fire("click"); assert.equal(resumed, "saved-import"); assert.match(imports.textContent, /8\/8 processed/u); closeImports();
});

test("search responses and record buttons cannot cross scope changes or cleanup", async () => {
  const container = fixture(), pending = []; let scope = "one", opened = 0;
  const dispose = mountSearch(container, { search: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }, { scope: () => scope, open: () => { opened++; } });
  const form = descendants(container, "form")[0], result = { hits: [{ id: "private", title: "Private title", snippet: "Private snippet", score: 1 }], total: 1, truncated: false };
  const first = form.fire("submit"); await settle(); scope = "two"; pending[0].resolve(result); await first;
  assert.doesNotMatch(container.textContent, /Private/); assert.match(container.textContent, /scope changed/); assert.equal(button(container, "Search").disabled, false);
  const second = form.fire("submit"); await settle(); pending[1].resolve(result); await second;
  const oldButton = button(container, "Private title"); scope = "three"; await oldButton.fire("click"); assert.equal(opened, 0); assert.doesNotMatch(container.textContent, /Private/);
  const third = form.fire("submit"); await settle(); dispose(); pending[2].resolve(result); await third; await oldButton.fire("click"); assert.equal(opened, 0); assert.equal(container.childNodes.length, 0);
});

test("late search failures cannot overwrite a later response or enable its pending submit", async () => {
  const container = fixture(), pending = [];
  const dispose = mountSearch(container, { search: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }, { scope: () => "same", open: () => {} });
  const form = descendants(container, "form")[0], first = form.fire("submit"); await settle(); const second = form.fire("submit"); await settle();
  pending[0].reject(new Error("old request")); await first; assert.equal(button(container, "Search").disabled, true); assert.doesNotMatch(container.textContent, /unavailable/);
  pending[1].resolve({ hits: [], total: 0, truncated: false }); await second; assert.match(container.textContent, /0 results/); assert.equal(button(container, "Search").disabled, false); dispose();
});

const reviewColumns = [{ source: "name", target: "title", type: "text" }, { source: "points", target: "score", type: "integer" }];
const reviewJob = () => ({ id: "job", state: "ready", uploadedRows: 1, processedRows: 0, insertedRows: 0, skippedRows: 0, issues: [], review: { sourceHash: "hash", headers: ["name", "points"], columns: reviewColumns, revision: 0, updatedRows: 0, duplicates: "upsert" } });
const reviewWindow = job => ({ job, rows: [{ row: 2, source: ["<script>Private", "oops"], corrections: {} }], nextRow: null });

test("reviewable importer saves typed corrections, previews explicit effects, and reconciles a lost response", async () => {
  const container = fixture(); let job = reviewJob(), corrections, accepted, complete = false;
  const client = {
    sourceWindow: async () => reviewWindow(job),
    correctRows: async (id, revision, rows, key) => { corrections = { id, revision, rows, key }; job = { ...job, review: { ...job.review, revision: 1 } }; return job; },
    preview: async () => ({ id: "job", digest: "review", effects: [{ row: 2, action: "update", before: { score: 1 }, after: { score: 5 } }] }),
    apply: async (preview, key) => { accepted = { preview, key }; complete = true; throw new Error("response lost"); },
    inspect: async () => complete ? { ...job, state: "completed", processedRows: 1, review: { ...job.review, updatedRows: 1 } } : job,
  };
  const dispose = mountReviewableImporter(container, client, { columns: reviewColumns, currentUser: () => "owner" });
  descendants(container, "input")[1].value = "job"; await button(container, "Inspect remaining source rows").fire("click"); assert.match(container.textContent, /<script>Private/);
  const score = descendants(container, "input").find(node => node.attributes.get("aria-label") === "Correction for row 2 score"); score.value = "5"; await score.fire("input");
  await button(container, "Preview next batch").fire("click"); assert.match(container.textContent, /Save row corrections/);
  await button(container, "Save row corrections").fire("click"); assert.deepEqual(corrections.rows, [{ row: 2, values: { score: 5 } }]); assert.equal(corrections.revision, 0); assert.ok(corrections.key);
  await button(container, "Preview next batch").fire("click"); assert.match(container.textContent, /Before:.*1[\s\S]*After:.*5/);
  await button(container, "Accept reviewed batch").fire("click"); assert.equal(accepted.preview.digest, "review"); assert.ok(accepted.key); assert.match(container.textContent, /response lost/);
  await button(container, "Refresh import progress").fire("click"); assert.match(container.textContent, /completed: 1\/1/); assert.match(container.textContent, /1 updated/); assert.doesNotMatch(container.textContent, /Private/); dispose();
});

test("reviewable importer discards late source and preview responses after an account switch or disposal", async () => {
  const container = fixture(); let current = "owner", resolve;
  const dispose = mountReviewableImporter(container, { sourceWindow: () => new Promise(done => { resolve = done; }) }, { columns: reviewColumns, currentUser: () => current });
  descendants(container, "input")[1].value = "job"; const pending = button(container, "Inspect remaining source rows").fire("click"); await settle(); current = "other"; resolve(reviewWindow(reviewJob())); await pending;
  assert.doesNotMatch(container.textContent, /Private/); assert.match(container.textContent, /account changed/); assert.equal(button(container, "Accept reviewed batch").disabled, true); dispose();
  const other = fixture(); let preview;
  const cleanup = mountReviewableImporter(other, { preview: () => new Promise(done => { preview = done; }) }, { columns: reviewColumns, currentUser: () => "owner" });
  const request = button(other, "Preview next batch").fire("click"); await settle(); cleanup(); preview({ effects: [{ row: 2, action: "insert", after: { title: "Private" } }] }); await request; assert.equal(other.childNodes.length, 0);
});


test("reviewable importer clears displayed source when a subsequent request detects session revocation", async () => {
  const container = fixture(); let revoked = false;
  const dispose = mountReviewableImporter(container, { sourceWindow: async () => { if (revoked) throw Object.assign(new Error("Authentication is required."), { status: 401 }); return reviewWindow(reviewJob()); } }, { columns: reviewColumns, currentUser: () => "owner" });
  descendants(container, "input")[1].value = "job"; await button(container, "Inspect remaining source rows").fire("click"); assert.match(container.textContent, /Private/); revoked = true;
  await button(container, "Inspect remaining source rows").fire("click"); assert.doesNotMatch(container.textContent, /Private/); assert.equal(descendants(container, "fieldset").length, 0); assert.match(container.textContent, /Authentication is required/); dispose();
});

test("reviewable upload control retries a lost creation response with the same source key", async () => {
  const container = fixture(), keys = []; let attempts = 0;
  const dispose = mountReviewableImporter(container, { uploadReviewableCsv: async (_file, _columns, settings) => { keys.push(settings.key); if (!attempts++) throw new Error("initial response lost"); return reviewJob(); }, sourceWindow: async () => reviewWindow(reviewJob()) }, { columns: reviewColumns, currentUser: () => "owner" });
  descendants(container, "input")[0].files = [{ name: "source.csv", size: 40, lastModified: 1 }]; await button(container, "Stage or resume CSV").fire("click"); assert.match(container.textContent, /initial response lost/); await button(container, "Stage or resume CSV").fire("click"); assert.ok(keys[0]); assert.equal(keys[0], keys[1]); assert.match(container.textContent, /ready: 0\/1/); dispose();
});
