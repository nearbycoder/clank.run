import type { AuthDefinition } from "./auth.ts";
import type { SyncClientOptions, FunctionReference } from "./backend.ts";
import { mountSchedulePreview, previewSchedule, validateRecurrenceRule, type RecurrenceRule } from "./schedules.ts";
export interface Reminder { id: string; title: string; dueAt: number; completed: boolean; version: number; recurrence?: Readonly<RecurrenceRule> | null; }
export interface ReminderClient {
  list(): Promise<readonly Reminder[]>;
  save(input: { id?: string; expectedVersion?: number; title: string; dueAt: number; key?: string; recurrence?: RecurrenceRule | null }): Promise<Reminder>;
  complete(id: string, completed: boolean, expectedVersion: number): Promise<void>;
  snooze(id: string, minutes: number, expectedVersion: number): Promise<void>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export interface ReminderOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend } from "./backend.ts";
import { s } from "./ai.ts";
const dueSchema = s.number({ integer: true, min: 1, max: 4102444800000 });
const recurrenceSchema = s.optional(s.nullable(s.string({ max: 16384 })));
const schema = defineDatabase({ personalReminders: defineTable({ title: s.string({ min: 1, max: 160 }), dueAt: dueSchema, completed: s.boolean(), key: s.string({ min: 1, max: 128 }), recurrence: recurrenceSchema }).owned() });
export function dueReminders(reminders: readonly Reminder[], now = Date.now()): readonly Reminder[] { if (!Number.isFinite(now)) throw new TypeError("Invalid reminder clock."); return reminders.filter(row => !row.completed && row.dueAt <= now).sort((a,b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)); }
/** Converts a local wall-clock minute, rejecting invalid dates and daylight-saving gaps. */
export function parseReminderTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value); if (!match) throw new TypeError("Choose a valid local date and time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number), date = new Date(year!, month! - 1, day!, hour!, minute!);
  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new TypeError("This local date and time does not exist."); return dueSchema.parse(date.getTime());
}
export async function openReminders(options: ReminderOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }> {
  const view = (row: any): Reminder => ({ id: row._id, title: row.title, dueAt: row.dueAt, completed: row.completed, version: row._version, ...(row.recurrence ? { recurrence: validateRecurrenceRule(JSON.parse(row.recurrence)) } : {}) });
  const current = (db: any, id: string, version: number) => { const table = db.table("personalReminders"), row = table.get(id); if (!row || row._version !== version) throw new Error("Reminder changed or is unavailable."); return { table, row }; };
  const versionArgs = { id: s.string(), expectedVersion: s.number({ integer: true, min: 1 }) };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: {}, handler: ({ db }) => db.table("personalReminders").collect().sort((a,b) => Number(a.completed) - Number(b.completed) || a.dueAt - b.dueAt || a._id.localeCompare(b._id)).map(view) }),
    save: mutation({ args: { id: s.optional(s.string()), expectedVersion: s.optional(s.number({ integer: true, min: 1 })), title: s.string({ min: 1, max: 160 }), dueAt: dueSchema, key: s.string({ min: 1, max: 128 }), recurrence: recurrenceSchema }, handler: ({ db }, input) => {
      const title = input.title.trim(); if (!title) throw new Error("Reminder title is required.");
      const recurrence = input.recurrence === undefined ? undefined : input.recurrence === null ? null : JSON.stringify(validateRecurrenceRule(JSON.parse(input.recurrence)));
      const prior = input.id ? current(db, input.id, input.expectedVersion!).row : undefined;
      if (recurrence && !(prior?.recurrence === recurrence && prior.dueAt === input.dueAt)) {
        const next = previewSchedule(JSON.parse(recurrence), { after: input.dueAt - 1, limit: 1, horizonDays: 47500 }).occurrences[0];
        if (next?.at !== input.dueAt) throw new Error("The first due time must be an occurrence of the recurrence rule.");
      }
      if (input.id) { const { table } = current(db, input.id, input.expectedVersion!); return view(table.patch(input.id, { title, dueAt: input.dueAt, ...(recurrence === undefined ? {} : { recurrence }) }, { ifVersion: input.expectedVersion })); }
      if (input.expectedVersion !== undefined) throw new Error("New reminders do not have a version."); const table = db.table("personalReminders"), existing = table.query().where("key", input.key).first(); if (existing) return view(existing);
      if (table.collect().length >= 200) throw new Error("Reminder limit reached."); return view(table.get(table.insert({ title, dueAt: input.dueAt, completed: false, key: input.key, ...(recurrence === undefined ? {} : { recurrence }) })));
    } }),
    complete: mutation({ args: { ...versionArgs, completed: s.boolean() }, handler: ({ db }, { id, completed, expectedVersion }) => {
      const { table, row } = current(db,id,expectedVersion);
      const next = completed && row.recurrence ? previewSchedule(JSON.parse(row.recurrence), { after: row.dueAt, limit: 1, horizonDays: 47500 }).occurrences[0] : undefined;
      table.patch(id, next ? { completed: false, dueAt: dueSchema.parse(next.at) } : { completed }, { ifVersion: expectedVersion });
    } }),
    snooze: mutation({ args: { ...versionArgs, minutes: s.number({ integer: true, min: 1, max: 10080 }) }, handler: ({ db }, { id, minutes, expectedVersion }) => { const { table, row } = current(db,id,expectedVersion); if (row.completed) throw new Error("Reopen the reminder before snoozing."); table.patch(id, { dueAt: dueSchema.parse(Date.now() + minutes * 60000) }, { ifVersion: expectedVersion }); } }),
    remove: mutation({ args: versionArgs, handler: ({ db }, { id, expectedVersion }) => { const { table } = current(db,id,expectedVersion); table.delete(id, { ifVersion: expectedVersion }); } }),
  })); const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/reminders" }); return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createReminderClient(options: SyncClientOptions = {}): ReminderClient {
  const api: {
    list: FunctionReference<"query", {}, readonly Reminder[]>;
    save: FunctionReference<"mutation", Omit<Parameters<ReminderClient["save"]>[0], "recurrence" | "key"> & { recurrence?: string | null; key: string }, Reminder>;
    complete: FunctionReference<"mutation", { id: string; completed: boolean; expectedVersion: number }, void>;
    snooze: FunctionReference<"mutation", { id: string; minutes: number; expectedVersion: number }, void>;
    remove: FunctionReference<"mutation", { id: string; expectedVersion: number }, void>;
  } = createApi<any>();
  const prefix = (options.url ?? "/__clank/reminders").replace(/\/$/, ""), transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: () => transport.query(api.list, {}), save: input => { const { recurrence, ...values } = input; return transport.mutate(api.save, { ...values, ...(recurrence === undefined ? {} : { recurrence: recurrence === null ? null : JSON.stringify(validateRecurrenceRule(recurrence)) }), key: input.key ?? crypto.randomUUID() }); }, complete: (id, completed, expectedVersion) => transport.mutate(api.complete, { id, completed, expectedVersion }), snooze: (id, minutes, expectedVersion) => transport.mutate(api.snooze, { id, minutes, expectedVersion }), remove: (id, expectedVersion) => transport.mutate(api.remove, { id, expectedVersion }) };
}
export function mountReminders(container: HTMLElement, client: ReminderClient): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("section"), status = doc.createElement("p"), due = doc.createElement("p"), title = doc.createElement("input"), when = doc.createElement("input"), filter = doc.createElement("select"), list = doc.createElement("ul");
  panel.setAttribute("aria-label", "Reminders"); status.setAttribute("role", "status"); due.setAttribute("aria-live", "polite"); title.setAttribute("aria-label", "Reminder title"); title.maxLength = 160; when.type = "datetime-local"; when.setAttribute("aria-label", "Reminder local time"); filter.setAttribute("aria-label", "Reminder filter"); for (const value of ["active", "due", "completed", "all"]) { const option = doc.createElement("option"); option.value = option.textContent = value; filter.append(option); }
  const frequency = doc.createElement("select"), zone = doc.createElement("input"), exceptions = doc.createElement("input"), preview = doc.createElement("div");
  frequency.setAttribute("aria-label", "Repeat reminder");
  for (const [value, label] of [["", "One time"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]]) { const option = doc.createElement("option"); option.value = value!; option.textContent = label!; frequency.append(option); }
  zone.setAttribute("aria-label", "Recurrence time zone"); zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone; zone.maxLength = 100;
  exceptions.setAttribute("aria-label", "Exception dates, separated by commas"); exceptions.maxLength = 4096;
  let recurrenceDirty = false, dateTimeDirty = false, removePreview: (() => void) | undefined;
  let closed = false, busy = false, rows: readonly Reminder[] = [], editing: Reminder | undefined, key = crypto.randomUUID();
  const button = (text: string, action: () => Promise<void>) => { const node = doc.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = () => { void run(action); }; return node; };
  const reset = () => { editing = undefined; title.value = when.value = frequency.value = exceptions.value = ""; recurrenceDirty = false; dateTimeDirty = false; removePreview?.(); removePreview = undefined; key = crypto.randomUUID(); };
  const selectedRule = (): Readonly<RecurrenceRule> | null => {
    if (!frequency.value) return null;
    if (editing?.recurrence && !recurrenceDirty) return editing.recurrence;
    const [startDate, time] = when.value.split("T");
    const previous = editing?.recurrence?.frequency === frequency.value ? editing.recurrence : undefined;
    return validateRecurrenceRule({ ...(previous ?? {}), frequency: frequency.value as RecurrenceRule["frequency"], startDate: previous && !dateTimeDirty ? previous.startDate : startDate!, time: previous && !dateTimeDirty ? previous.time : time!, timeZone: zone.value, exceptionDates: exceptions.value.split(",").map(value => value.trim()).filter(Boolean), overlap: editing?.recurrence?.overlap ?? "earlier" });
  };
  const firstDue = (rule: Readonly<RecurrenceRule>) => {
    if (editing?.recurrence && !recurrenceDirty) return editing.dueAt;
    const after = editing?.recurrence && !dateTimeDirty && editing.recurrence.frequency === rule.frequency
      ? editing.dueAt - 1 : Math.max(-1, Date.parse(`${rule.startDate}T00:00:00Z`) - 36 * 3600000);
    const next = previewSchedule(rule, { after, limit: 1, horizonDays: 47500 }).occurrences[0];
    if (!next) throw new Error("The recurrence has no remaining occurrences.");
    return next.at;
  };
  const render = () => { const dueIds = new Set(dueReminders(rows).map(row => row.id)); due.textContent = `${dueIds.size} reminders due. Times use this device’s time zone.`; list.replaceChildren();
    for (const row of rows.filter(row => filter.value === "all" || (filter.value === "completed" ? row.completed : filter.value === "due" ? dueIds.has(row.id) : !row.completed))) {
      const item = doc.createElement("li"), text = doc.createElement("p"); text.textContent = `${row.title} · ${new Date(row.dueAt).toLocaleString()} · ${row.completed ? "Completed" : dueIds.has(row.id) ? "Due" : "Upcoming"}`;
      item.append(text, button(row.completed ? "Reopen" : "Complete", async () => { await client.complete(row.id, !row.completed, row.version); await load(); }), button("Edit reminder", async () => { editing = row; title.value = row.title;
        frequency.value = row.recurrence?.frequency ?? ""; zone.value = row.recurrence?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        exceptions.value = (row.recurrence?.exceptionDates ?? []).join(", "); recurrenceDirty = false; dateTimeDirty = false; removePreview?.(); removePreview = undefined;
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone.value, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(row.dueAt).map(part => [part.type, part.value]));
        when.value = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; title.focus(); }));
      if (row.recurrence) {
        const label = doc.createElement("p"); label.textContent = `${row.recurrence.frequency} in ${row.recurrence.timeZone}; completing advances to the next occurrence.`; item.append(label);
      }
      if (!row.completed) for (const [text, minutes] of [["Snooze 10 minutes",10],["Snooze 1 hour",60],["Snooze 1 day",1440]] as const) item.append(button(text, async () => { await client.snooze(row.id, minutes, row.version); await load(); }));
      const details = doc.createElement("details"), summary = doc.createElement("summary"); summary.textContent = "Delete reminder"; details.append(summary, button("Confirm deletion", async () => { await client.remove(row.id,row.version); if (editing?.id === row.id) reset(); await load(); })); item.append(details); list.append(item);
    }
  };
  const load = async () => { const result = await client.list(); if (closed) return; rows = result; render(); status.textContent = "Reminders loaded."; };
  const run = async (action: () => Promise<void>) => { if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = true; try { await action(); } catch { if (!closed) status.textContent = "Could not save. Check the local date and time, or refresh after a conflict. Your draft is preserved."; } finally { busy = false; panel.removeAttribute("aria-busy"); for (const node of panel.querySelectorAll("button,input,select")) (node as HTMLInputElement).disabled = false; } };
  title.oninput = () => { key = crypto.randomUUID(); };
  zone.oninput = exceptions.oninput = frequency.onchange = () => { recurrenceDirty = true; key = crypto.randomUUID(); };
  when.oninput = () => { recurrenceDirty = true; dateTimeDirty = true; key = crypto.randomUUID(); };
  filter.onchange = render;
  panel.append(title, when, frequency, zone, exceptions, button("Preview schedule", async () => { const rule = selectedRule(); removePreview?.(); removePreview = rule ? mountSchedulePreview(preview, rule, { after: firstDue(rule) - 1, limit: 5 }) : undefined; }), preview,
    button("Save reminder", async () => { const recurrence = selectedRule(); await client.save({ id: editing?.id, expectedVersion: editing?.version, title: title.value, dueAt: recurrence ? firstDue(recurrence) : parseReminderTime(when.value), recurrence, key }); reset(); await load(); }), button("Cancel edit", async () => reset()), filter, due, status, list, button("Refresh reminders", load)); container.append(panel); void run(load);
  const timer = setInterval(() => { if (!closed && !busy && doc.visibilityState !== "hidden") render(); }, 60000); return () => { closed = true; clearInterval(timer); removePreview?.(); panel.remove(); };
}
