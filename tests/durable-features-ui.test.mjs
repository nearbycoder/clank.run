import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineQueue, compareOfflineConflict, mountOfflineConflictResolver } from "../dist/offline.js";
import { mountBulkEditor } from "../dist/bulk-edit.js";
import { mountCollaborativeEditor } from "../dist/collaborative-documents.js";
import { mountSearch } from "../dist/search.js";
import { mountSharedSavedViews } from "../dist/saved-views.js";
import { mountDurableImporter } from "../dist/durable-import.js";

class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.childNodes = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ""; this.disabled = false; this.ownText = ""; }
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
