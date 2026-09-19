import type { AuthDefinition } from "./auth.ts";
import type { SyncClientOptions } from "./backend.ts";
export interface Reminder { id: string; title: string; dueAt: number; completed: boolean; version: number; }
export interface ReminderClient {
  list(): Promise<readonly Reminder[]>;
  save(input: { id?: string; expectedVersion?: number; title: string; dueAt: number; key?: string }): Promise<Reminder>;
  complete(id: string, completed: boolean, expectedVersion: number): Promise<void>;
  snooze(id: string, minutes: number, expectedVersion: number): Promise<void>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export interface ReminderOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend } from "./backend.ts";
import { s } from "./ai.ts";
const dueSchema = s.number({ integer: true, min: 1, max: 4102444800000 });
const schema = defineDatabase({ personalReminders: defineTable({ title: s.string({ min: 1, max: 160 }), dueAt: dueSchema, completed: s.boolean(), key: s.string({ min: 1, max: 128 }) }).owned() });
export function dueReminders(reminders: readonly Reminder[], now = Date.now()): readonly Reminder[] { if (!Number.isFinite(now)) throw new TypeError("Invalid reminder clock."); return reminders.filter(row => !row.completed && row.dueAt <= now).sort((a,b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)); }
/** Converts a local wall-clock minute, rejecting invalid dates and daylight-saving gaps. */
export function parseReminderTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value); if (!match) throw new TypeError("Choose a valid local date and time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number), date = new Date(year!, month! - 1, day!, hour!, minute!);
  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new TypeError("This local date and time does not exist."); return dueSchema.parse(date.getTime());
}
export async function openReminders(options: ReminderOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }> {
  const view = (row: any): Reminder => ({ id: row._id, title: row.title, dueAt: row.dueAt, completed: row.completed, version: row._version });
  const current = (db: any, id: string, version: number) => { const table = db.table("personalReminders"), row = table.get(id); if (!row || row._version !== version) throw new Error("Reminder changed or is unavailable."); return { table, row }; };
  const versionArgs = { id: s.string(), expectedVersion: s.number({ integer: true, min: 1 }) };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: {}, handler: ({ db }) => db.table("personalReminders").collect().sort((a,b) => Number(a.completed) - Number(b.completed) || a.dueAt - b.dueAt || a._id.localeCompare(b._id)).map(view) }),
    save: mutation({ args: { id: s.optional(s.string()), expectedVersion: s.optional(s.number({ integer: true, min: 1 })), title: s.string({ min: 1, max: 160 }), dueAt: dueSchema, key: s.string({ min: 1, max: 128 }) }, handler: ({ db }, input) => {
      const title = input.title.trim(); if (!title) throw new Error("Reminder title is required.");
      if (input.id) { const { table } = current(db, input.id, input.expectedVersion!); return view(table.patch(input.id, { title, dueAt: input.dueAt }, { ifVersion: input.expectedVersion })); }
      if (input.expectedVersion !== undefined) throw new Error("New reminders do not have a version."); const table = db.table("personalReminders"), existing = table.query().where("key", input.key).first(); if (existing) return view(existing);
      if (table.collect().length >= 200) throw new Error("Reminder limit reached."); return view(table.get(table.insert({ title, dueAt: input.dueAt, completed: false, key: input.key })));
    } }),
    complete: mutation({ args: { ...versionArgs, completed: s.boolean() }, handler: ({ db }, { id, completed, expectedVersion }) => { const { table } = current(db,id,expectedVersion); table.patch(id, { completed }, { ifVersion: expectedVersion }); } }),
    snooze: mutation({ args: { ...versionArgs, minutes: s.number({ integer: true, min: 1, max: 10080 }) }, handler: ({ db }, { id, minutes, expectedVersion }) => { const { table, row } = current(db,id,expectedVersion); if (row.completed) throw new Error("Reopen the reminder before snoozing."); table.patch(id, { dueAt: dueSchema.parse(Date.now() + minutes * 60000) }, { ifVersion: expectedVersion }); } }),
    remove: mutation({ args: versionArgs, handler: ({ db }, { id, expectedVersion }) => { const { table } = current(db,id,expectedVersion); table.delete(id, { ifVersion: expectedVersion }); } }),
  })); const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/reminders" }); return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createReminderClient(options: SyncClientOptions = {}): ReminderClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/reminders").replace(/\/$/, ""), transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: () => transport.query(api.list, {}), save: input => transport.mutate(api.save, { ...input, key: input.key ?? crypto.randomUUID() }), complete: (id, completed, expectedVersion) => transport.mutate(api.complete, { id, completed, expectedVersion }), snooze: (id, minutes, expectedVersion) => transport.mutate(api.snooze, { id, minutes, expectedVersion }), remove: (id, expectedVersion) => transport.mutate(api.remove, { id, expectedVersion }) };
}
export function mountReminders(container: HTMLElement, client: ReminderClient): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("section"), status = doc.createElement("p"), due = doc.createElement("p"), title = doc.createElement("input"), when = doc.createElement("input"), filter = doc.createElement("select"), list = doc.createElement("ul");
  panel.setAttribute("aria-label", "Reminders"); status.setAttribute("role", "status"); due.setAttribute("aria-live", "polite"); title.setAttribute("aria-label", "Reminder title"); title.maxLength = 160; when.type = "datetime-local"; when.setAttribute("aria-label", "Reminder local time"); filter.setAttribute("aria-label", "Reminder filter"); for (const value of ["active", "due", "completed", "all"]) { const option = doc.createElement("option"); option.value = option.textContent = value; filter.append(option); }
  let closed = false, busy = false, rows: readonly Reminder[] = [], editing: Reminder | undefined, key = crypto.randomUUID();
  const button = (text: string, action: () => Promise<void>) => { const node = doc.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = () => { void run(action); }; return node; };
  const reset = () => { editing = undefined; title.value = when.value = ""; key = crypto.randomUUID(); };
  const render = () => { const dueIds = new Set(dueReminders(rows).map(row => row.id)); due.textContent = `${dueIds.size} reminders due. Times use this device’s time zone.`; list.replaceChildren();
    for (const row of rows.filter(row => filter.value === "all" || (filter.value === "completed" ? row.completed : filter.value === "due" ? dueIds.has(row.id) : !row.completed))) {
      const item = doc.createElement("li"), text = doc.createElement("p"); text.textContent = `${row.title} · ${new Date(row.dueAt).toLocaleString()} · ${row.completed ? "Completed" : dueIds.has(row.id) ? "Due" : "Upcoming"}`;
      item.append(text, button(row.completed ? "Reopen" : "Complete", async () => { await client.complete(row.id, !row.completed, row.version); await load(); }), button("Edit reminder", async () => { editing = row; title.value = row.title; const date = new Date(row.dueAt), pad = (n: number) => String(n).padStart(2,"0"); when.value = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; title.focus(); }));
      if (!row.completed) for (const [text, minutes] of [["Snooze 10 minutes",10],["Snooze 1 hour",60],["Snooze 1 day",1440]] as const) item.append(button(text, async () => { await client.snooze(row.id, minutes, row.version); await load(); }));
      const details = doc.createElement("details"), summary = doc.createElement("summary"); summary.textContent = "Delete reminder"; details.append(summary, button("Confirm deletion", async () => { await client.remove(row.id,row.version); if (editing?.id === row.id) reset(); await load(); })); item.append(details); list.append(item);
    }
  };
  const load = async () => { const result = await client.list(); if (closed) return; rows = result; render(); status.textContent = "Reminders loaded."; };
  const run = async (action: () => Promise<void>) => { if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = true; try { await action(); } catch { if (!closed) status.textContent = "Could not save. Check the local date and time, or refresh after a conflict. Your draft is preserved."; } finally { busy = false; panel.removeAttribute("aria-busy"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = false; } };
  title.oninput = when.oninput = () => { key = crypto.randomUUID(); }; filter.onchange = render;
  panel.append(title, when, button("Save reminder", async () => { await client.save({ id: editing?.id, expectedVersion: editing?.version, title: title.value, dueAt: parseReminderTime(when.value), key }); reset(); await load(); }), button("Cancel edit", async () => reset()), filter, due, status, list, button("Refresh reminders", load)); container.append(panel); void run(load);
  const timer = setInterval(() => { if (!closed && !busy && doc.visibilityState !== "hidden") render(); }, 60000); return () => { closed = true; clearInterval(timer); panel.remove(); };
}
