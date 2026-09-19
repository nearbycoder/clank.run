import type { AuthDefinition } from "./auth.ts";
import type { SyncClientOptions } from "./backend.ts";
export interface Label { id: string; name: string; color: string; version: number; uses: number; }
export interface LabelState { labels: readonly Label[]; selected: readonly string[]; }
export interface LabelClient {
  list(resource?: string): Promise<LabelState>;
  save(input: { id?: string; expectedVersion?: number; name: string; color: string }): Promise<Label>;
  remove(id: string, expectedVersion: number): Promise<void>;
  assign(resource: string, id: string, selected: boolean): Promise<void>;
}
export interface LabelOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend } from "./backend.ts";
import { s } from "./ai.ts";
const schema = defineDatabase({
  personalLabels: defineTable({ name: s.string({ min: 1, max: 40 }), color: s.string({ max: 7 }) }).owned(),
  personalLabelLinks: defineTable({ resource: s.string({ min: 1, max: 200 }), label: s.string() }).owned().index("by_resource", ["resource"]).index("by_label", ["label"]),
});
/** Personal labels and resource assignments, atomically maintained in the existing SQLite file. */
export async function openLabels(options: LabelOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }> {
  const view = (row: any, links: any[]): Label => ({ id: row._id, name: row.name, color: row.color, version: row._version, uses: links.filter(link => link.label === row._id).length });
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: { resource: s.optional(s.string({ min: 1, max: 200 })) }, handler: ({ db }, { resource }) => { const links = db.table("personalLabelLinks").collect(); return { labels: db.table("personalLabels").collect().sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id)).map(row => view(row, links)), selected: resource ? links.filter(link => link.resource === resource).map(link => link.label) : [] }; } }),
    save: mutation({ args: { id: s.optional(s.string()), expectedVersion: s.optional(s.number({ integer: true, min: 1 })), name: s.string({ min: 1, max: 40 }), color: s.string({ max: 7 }) }, handler: ({ db }, input) => {
      const table = db.table("personalLabels"), rows = table.collect(), name = input.name.trim().normalize("NFC");
      if (!name || !/^#[a-f0-9]{6}$/iu.test(input.color)) throw new Error("Choose a name and six-digit color.");
      if (rows.some(row => row._id !== input.id && row.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) throw new Error("That label name already exists.");
      let row;
      if (input.id) { const current = table.get(input.id); if (!current || input.expectedVersion !== current._version) throw new Error("Label changed or is unavailable."); row = table.patch(input.id, { name, color: input.color.toLowerCase() }, { ifVersion: input.expectedVersion }); }
      else { if (input.expectedVersion !== undefined || rows.length >= 100) throw new Error("Label limit reached or invalid revision."); row = table.get(table.insert({ name, color: input.color.toLowerCase() })); }
      return view(row, db.table("personalLabelLinks").collect());
    } }),
    remove: mutation({ args: { id: s.string(), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db }, { id, expectedVersion }) => { const table = db.table("personalLabels"), row = table.get(id); if (!row || row._version !== expectedVersion) throw new Error("Label changed or is unavailable."); for (const link of db.table("personalLabelLinks").query().where("label", id).collect()) db.table("personalLabelLinks").delete(link._id); table.delete(id, { ifVersion: expectedVersion }); } }),
    assign: mutation({ args: { resource: s.string({ min: 1, max: 200 }), id: s.string(), selected: s.boolean() }, handler: ({ db }, { resource, id, selected }) => {
      if (!db.table("personalLabels").get(id)) throw new Error("Label is unavailable."); const table = db.table("personalLabelLinks"), links = table.query().where("resource", resource).collect(), existing = links.find(link => link.label === id);
      if (!selected) { if (existing) table.delete(existing._id); return; }
      if (existing) return; if (links.length >= 20 || table.collect().length >= 5000) throw new Error("Label assignment limit reached."); table.insert({ resource, label: id });
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/labels" }); return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createLabelClient(options: SyncClientOptions = {}): LabelClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/labels").replace(/\/$/, ""), transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: resource => transport.query(api.list, { resource }), save: input => transport.mutate(api.save, input), remove: (id, expectedVersion) => transport.mutate(api.remove, { id, expectedVersion }), assign: (resource, id, selected) => transport.mutate(api.assign, { resource, id, selected }) };
}
/** Create, rename, recolor, assign, and remove labels without using color as the only label. */
export function mountLabels(container: HTMLElement, client: LabelClient, resource: string): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("section"), status = doc.createElement("p"), list = doc.createElement("ul"), name = doc.createElement("input"), color = doc.createElement("input"), save = doc.createElement("button");
  panel.setAttribute("aria-label", "Labels"); status.setAttribute("role", "status"); name.setAttribute("aria-label", "Label name"); name.maxLength = 40; color.type = "color"; color.value = "#3867d6"; color.setAttribute("aria-label", "Label color"); save.type = "button"; save.textContent = "Create label";
  let closed = false, busy = false, editing: Label | undefined;
  const button = (text: string, action: () => Promise<void>) => { const node = doc.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = () => { void run(action); }; return node; };
  const load = async () => { const state = await client.list(resource); if (closed) return; list.replaceChildren();
    for (const label of state.labels) { const row = doc.createElement("li"), toggle = doc.createElement("input"), text = doc.createElement("label"), swatch = doc.createElement("span"); toggle.type = "checkbox"; toggle.checked = state.selected.includes(label.id); swatch.textContent = "● "; swatch.style.color = label.color; swatch.setAttribute("aria-hidden", "true"); text.append(toggle, swatch, `${label.name} (${label.uses})`); toggle.onchange = () => { void run(async () => { await client.assign(resource, label.id, toggle.checked); await load(); }); }; row.append(text, button("Edit", async () => { editing = label; name.value = label.name; color.value = label.color; save.textContent = "Save label"; name.focus(); }));
      const confirm = doc.createElement("details"), summary = doc.createElement("summary"); summary.textContent = "Delete label"; confirm.append(summary, "Remove this label from all your records?", button("Confirm delete", async () => { await client.remove(label.id, label.version); if (editing?.id === label.id) reset(); await load(); })); row.append(confirm); list.append(row); }
    status.textContent = `${state.labels.length} labels. ${state.selected.length} assigned to this record.`;
  };
  const reset = () => { editing = undefined; name.value = ""; save.textContent = "Create label"; };
  const run = async (action: () => Promise<void>) => { if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); for (const input of panel.querySelectorAll("button,input")) (input as HTMLInputElement).disabled = true; try { await action(); } catch { if (!closed) status.textContent = "Could not save labels. Refresh and retry; your name is preserved."; } finally { busy = false; panel.removeAttribute("aria-busy"); for (const input of panel.querySelectorAll("button,input")) (input as HTMLInputElement).disabled = false; } };
  save.onclick = () => { void run(async () => { await client.save({ id: editing?.id, expectedVersion: editing?.version, name: name.value, color: color.value }); reset(); await load(); }); };
  panel.append(status, list, name, color, save, button("Cancel edit", async () => reset()), button("Refresh labels", load)); container.append(panel); void run(load); return () => { closed = true; panel.remove(); };
}
