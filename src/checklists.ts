import type { AuthDefinition } from "./auth.ts";
import type { SyncClientOptions } from "./backend.ts";
export interface ChecklistItem { id: string; text: string; done: boolean; }
export interface Checklist { id: string; title: string; items: readonly ChecklistItem[]; version: number; }
export interface ChecklistClient {
  list(): Promise<readonly Checklist[]>;
  save(input: { id?: string; expectedVersion?: number; title: string; items: readonly ChecklistItem[]; key?: string }): Promise<Checklist>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export interface ChecklistOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend } from "./backend.ts";
import { s } from "./ai.ts";
const itemSchema = s.object({ id: s.string({ min: 1, max: 128 }), text: s.string({ min: 1, max: 200 }), done: s.boolean() });
const schema = defineDatabase({ personalChecklists: defineTable({ title: s.string({ min: 1, max: 100 }), items: s.array(itemSchema, { max: 100 }), key: s.string({ min: 1, max: 128 }) }).owned() });
/** Whole-list revisions make completion, edits, and reordering atomic under concurrent clients. */
export async function openChecklists(options: ChecklistOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }> {
  const view = (row: any): Checklist => ({ id: row._id, title: row.title, items: row.items, version: row._version });
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: {}, handler: ({ db }) => db.table("personalChecklists").collect().sort((a,b) => a.title.localeCompare(b.title) || a._id.localeCompare(b._id)).map(view) }),
    save: mutation({ args: { id: s.optional(s.string()), expectedVersion: s.optional(s.number({ integer: true, min: 1 })), title: s.string({ min: 1, max: 100 }), items: s.array(itemSchema, { max: 100 }), key: s.string({ min: 1, max: 128 }) }, handler: ({ db }, input) => {
      const title = input.title.trim(), items = input.items.map(item => ({ ...item, text: item.text.trim() })), table = db.table("personalChecklists");
      if (!title || items.some(item => !item.text) || new Set(items.map(item => item.id)).size !== items.length) throw new Error("Checklist title and unique nonempty items are required.");
      if (input.id) { const current = table.get(input.id); if (!current || current._version !== input.expectedVersion) throw new Error("Checklist changed. Refresh before editing."); return view(table.patch(input.id, { title, items }, { ifVersion: input.expectedVersion })); }
      if (input.expectedVersion !== undefined) throw new Error("New checklists do not have a version.");
      const existing = table.query().where("key", input.key).first(); if (existing) return view(existing);
      if (table.collect().length >= 100) throw new Error("Checklist limit reached."); return view(table.get(table.insert({ title, items, key: input.key })));
    } }),
    remove: mutation({ args: { id: s.string(), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db }, { id, expectedVersion }) => { const table = db.table("personalChecklists"), row = table.get(id); if (!row || row._version !== expectedVersion) throw new Error("Checklist changed or is unavailable."); table.delete(id, { ifVersion: expectedVersion }); } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/checklists" }); return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createChecklistClient(options: SyncClientOptions = {}): ChecklistClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/checklists").replace(/\/$/, ""), transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: () => transport.query(api.list, {}), save: input => transport.mutate(api.save, { ...input, key: input.key ?? crypto.randomUUID() }), remove: (id, expectedVersion) => transport.mutate(api.remove, { id, expectedVersion }) };
}
export function mountChecklists(container: HTMLElement, client: ChecklistClient): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("section"), status = doc.createElement("p"), choose = doc.createElement("select"), title = doc.createElement("input"), itemText = doc.createElement("input"), list = doc.createElement("ol"), progress = doc.createElement("progress");
  panel.setAttribute("aria-label", "Checklists"); status.setAttribute("role", "status"); choose.setAttribute("aria-label", "Choose checklist"); title.setAttribute("aria-label", "Checklist title"); title.maxLength = 100; itemText.setAttribute("aria-label", "New checklist item"); itemText.maxLength = 200; progress.setAttribute("aria-label", "Checklist completion");
  let closed = false, busy = false, rows: readonly Checklist[] = [], current: Checklist | undefined, createKey = crypto.randomUUID();
  const button = (text: string, action: () => Promise<void>) => { const node = doc.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = () => { void run(action); }; return node; };
  const update = async (items: readonly ChecklistItem[], nextTitle = current?.title) => { if (!current || !nextTitle) return; current = await client.save({ id: current.id, expectedVersion: current.version, title: nextTitle, items }); await load(current.id); };
  const render = () => { list.replaceChildren(); title.value = current?.title ?? ""; const items = current?.items ?? []; progress.max = Math.max(1, items.length); progress.value = items.filter(item => item.done).length; status.textContent = `${progress.value} of ${items.length} completed.`;
    items.forEach((item, index) => { const row = doc.createElement("li"), label = doc.createElement("label"), toggle = doc.createElement("input"); toggle.type = "checkbox"; toggle.checked = item.done; label.append(toggle, item.text); toggle.onchange = () => { void run(() => update(items.map(entry => entry.id === item.id ? { ...entry, done: toggle.checked } : entry))); }; row.append(label);
      const move = (offset: number) => async () => { const next = [...items]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; await update(next); }; const up = button("Move up", move(-1)), down = button("Move down", move(1)); up.dataset.boundary = String(index === 0); down.dataset.boundary = String(index === items.length - 1); up.disabled = index === 0; down.disabled = index === items.length - 1;
      const details = doc.createElement("details"), summary = doc.createElement("summary"), edit = doc.createElement("input"); summary.textContent = "Edit item"; edit.value = item.text; edit.maxLength = 200; edit.setAttribute("aria-label", "Item text"); details.append(summary, edit, button("Save item", () => update(items.map(entry => entry.id === item.id ? { ...entry, text: edit.value } : entry))));
      row.append(up, down, details, button("Remove item", () => update(items.filter(entry => entry.id !== item.id)))); list.append(row); });
  };
  const load = async (selected = current?.id) => { const result = await client.list(); if (closed) return; rows = result; choose.replaceChildren(); const empty = doc.createElement("option"); empty.value = ""; empty.textContent = "New checklist"; choose.append(empty); for (const row of rows) { const option = doc.createElement("option"); option.value = row.id; option.textContent = row.title; choose.append(option); } current = rows.find(row => row.id === selected); choose.value = current?.id ?? ""; render(); };
  const run = async (action: () => Promise<void>) => { if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = true; try { await action(); } catch { if (!closed) status.textContent = "Could not save this checklist. Your draft remains; refresh after a conflict."; } finally { busy = false; panel.removeAttribute("aria-busy"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = (node as HTMLElement).dataset.boundary === "true"; } };
  choose.onchange = () => { current = rows.find(row => row.id === choose.value); createKey = crypto.randomUUID(); render(); }; title.oninput = () => { createKey = crypto.randomUUID(); };
  const deleteDetails = doc.createElement("details"), summary = doc.createElement("summary"); summary.textContent = "Delete checklist"; deleteDetails.append(summary, button("Confirm checklist deletion", async () => { if (current) { await client.remove(current.id, current.version); current = undefined; await load(); } }));
  panel.append(choose, title, button("Save checklist title", async () => { if (current) await update(current.items, title.value); else { const row = await client.save({ title: title.value, items: [], key: createKey }); createKey = crypto.randomUUID(); await load(row.id); } }), progress, status, list, itemText, button("Add item", async () => { if (!current) throw new Error("Choose a checklist."); await update([...current.items, { id: crypto.randomUUID(), text: itemText.value, done: false }]); itemText.value = ""; }), button("Reset completion", async () => { if (current) await update(current.items.map(item => ({ ...item, done: false }))); }), button("Refresh checklists", () => load()), deleteDetails);
  container.append(panel); void run(() => load()); return () => { closed = true; panel.remove(); };
}
