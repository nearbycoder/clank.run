import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { featureTables, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export type ViewValue = string | number | boolean | null;
export interface ViewFilter { field: string; operator: "eq" | "neq" | "contains" | "gt" | "lt" | "empty"; value: ViewValue; }
export interface ViewDefinition { filters: readonly ViewFilter[]; sort: readonly { field: string; direction: "asc" | "desc" }[]; columns: readonly string[]; }
export interface SavedView { id: string; name: string; definition: ViewDefinition; revision: number; isDefault: boolean; }
export interface SavedViewsOptions { path: string; auth: AuthDefinition<any>; fields: readonly string[]; prefix?: string; maxViews?: number; }
export interface SavedViewsService { handle(request: Request): Promise<Response>; close(): void; }
export interface SavedViewsClient {
  list(): Promise<readonly SavedView[]>;
  save(input: { id?: string; expectedRevision?: number; name: string; definition: ViewDefinition }): Promise<SavedView>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
  setDefault(id: string | null): Promise<void>;
}

const fieldName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
/** Validate and detach a view before storing or applying it. Field names are literal own-property keys. */
export function validateView(value: unknown, allowedFields?: readonly string[]): ViewDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("A view must be an object.");
  const input = value as ViewDefinition;
  const validField = (field: unknown) => fieldName(field) && (!allowedFields || allowedFields.includes(field));
  if (!Array.isArray(input.filters) || input.filters.length > 30 || !Array.isArray(input.sort) || input.sort.length > 5 || !Array.isArray(input.columns) || input.columns.length > 40) throw new TypeError("View limits: 30 filters, 5 sort fields, and 40 columns.");
  const filters = input.filters.map(filter => {
    if (!filter || !validField(filter.field) || !["eq", "neq", "contains", "gt", "lt", "empty"].includes(filter.operator)) throw new TypeError("Invalid view filter.");
    const value = filter.value;
    if (value !== null && typeof value !== "boolean" && !(typeof value === "string" && value.length <= 2000) && !(typeof value === "number" && Number.isFinite(value))) throw new TypeError("Invalid filter value.");
    if (filter.operator === "contains" && typeof value !== "string") throw new TypeError("Contains requires text.");
    if (["gt", "lt"].includes(filter.operator) && typeof value !== "number") throw new TypeError("Numeric comparisons require a number.");
    return Object.freeze({ field: filter.field, operator: filter.operator, value });
  });
  if (new Set(input.sort.map(item => item?.field)).size !== input.sort.length || new Set(input.columns).size !== input.columns.length) throw new TypeError("View fields must be unique.");
  const sort = input.sort.map(item => { if (!item || !validField(item.field) || !["asc", "desc"].includes(item.direction)) throw new TypeError("Invalid view sort."); return Object.freeze({ field: item.field, direction: item.direction }); });
  if (input.columns.some(field => !validField(field))) throw new TypeError("Invalid view column.");
  return Object.freeze({ filters: Object.freeze(filters), sort: Object.freeze(sort), columns: Object.freeze([...input.columns]) });
}

/** Filter with AND semantics and stable sorting without mutating the source rows. */
export function applySavedView<T extends Record<string, unknown>>(records: readonly T[], definition: ViewDefinition): readonly T[] {
  if (records.length > 100000) throw new RangeError("Apply at most 100,000 rows at once.");
  const view = validateView(definition);
  const own = (row: T, field: string) => Object.hasOwn(row, field) ? row[field] : undefined;
  const rows = records.filter(row => view.filters.every(filter => {
    const actual = own(row, filter.field), expected = filter.value;
    switch (filter.operator) {
      case "eq": return actual === expected;
      case "neq": return actual !== expected;
      case "empty": return actual === null || actual === undefined || actual === "";
      case "contains": return typeof actual === "string" && actual.toLowerCase().includes(String(expected).toLowerCase());
      case "gt": return typeof actual === "number" && actual > Number(expected);
      case "lt": return typeof actual === "number" && actual < Number(expected);
    }
  }));
  return rows.sort((a, b) => {
    for (const sort of view.sort) {
      const left = own(a, sort.field), right = own(b, sort.field);
      // Missing values always sort last, independent of direction.
      if (left == null || right == null) { if (left == null && right != null) return 1; if (right == null && left != null) return -1; continue; }
      const difference = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      if (difference) return sort.direction === "asc" ? difference : -difference;
    }
    return 0;
  });
}

/** Account-owned views sharing the app's existing SQLite authentication database. */
export async function openSavedViews(options: SavedViewsOptions): Promise<SavedViewsService> {
  const fields = [...options.fields], maximum = options.maxViews ?? 50;
  if (!fields.length || fields.length > 100 || fields.some(field => !fieldName(field)) || new Set(fields).size !== fields.length || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200) throw new TypeError("Declare 1–100 unique fields and 1–200 saved views per account.");
  const schema = defineDatabase({ savedViews: defineTable({ name: s.string({ min: 1, max: 100 }), definition: s.string({ max: 65536 }), revision: s.number({ integer: true, min: 1 }), isDefault: s.boolean() }).owned() });
  const output = (row: any): SavedView => ({ id: row._id, name: row.name, definition: JSON.parse(row.definition), revision: row.revision, isDefault: row.isDefault });
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: {}, handler: ({ db }) => db.table("savedViews").query().orderBy("name", "asc").collect().map(output) }),
    save: mutation({ args: { id: s.optional(s.id("savedViews")), expectedRevision: s.optional(s.number({ integer: true, min: 1 })), name: s.string({ min: 1, max: 100 }), definition: s.string({ max: 65536 }) }, handler: ({ db }, input) => {
      const table = db.table("savedViews"), name = input.name.trim();
      if (!name) throw new Error("A saved view needs a name.");
      const definition = JSON.stringify(validateView(JSON.parse(input.definition), fields));
      const rows = table.query().collect();
      if (rows.some(row => row._id !== input.id && row.name.toLowerCase() === name.toLowerCase())) throw new Error("A view with this name already exists.");
      if (input.id) {
        const existing = table.get(input.id);
        if (!existing || existing.revision !== input.expectedRevision) throw new Error("Saved view changed. Refresh before saving.");
        table.patch(input.id, { name, definition, revision: existing.revision + 1 }); return output(table.get(input.id));
      }
      if (input.expectedRevision !== undefined) throw new Error("A new view cannot have an expected revision.");
      if (rows.length >= maximum) throw new Error("Saved view limit reached.");
      const id = table.insert({ name, definition, revision: 1, isDefault: false }); return output(table.get(id));
    } }),
    remove: mutation({ args: { id: s.id("savedViews"), expectedRevision: s.number({ integer: true, min: 1 }) }, handler: ({ db }, { id, expectedRevision }) => {
      const table = db.table("savedViews"), row = table.get(id); if (!row) return false;
      if (row.revision !== expectedRevision) throw new Error("Saved view changed. Refresh before deleting.");
      table.delete(id); return true;
    } }),
    setDefault: mutation({ args: { id: s.nullable(s.id("savedViews")) }, handler: ({ db }, { id }) => {
      const table = db.table("savedViews"); if (id !== null && !table.get(id)) throw new Error("Saved view is unavailable.");
      for (const row of table.query().collect()) if (row.isDefault !== (row._id === id)) table.patch(row._id, { isDefault: row._id === id, revision: row.revision + 1 });
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/views" });
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}

export function createSavedViewsClient(options: SyncClientOptions = {}): SavedViewsClient {
  const api = createApi<{
    list: FeatureQuery<{}, readonly SavedView[]>;
    save: FeatureMutation<Omit<Parameters<SavedViewsClient["save"]>[0], "definition"> & { definition: string }, SavedView>;
    remove: FeatureMutation<{ id: string; expectedRevision: number }, boolean>;
    setDefault: FeatureMutation<{ id: string | null }, void>;
  }>(), prefix = (options.url ?? "/__clank/views").replace(/\/$/, "");
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: () => transport.query(api.list), save: input => transport.mutate(api.save, { ...input, definition: JSON.stringify(validateView(input.definition)) }), remove: (id, expectedRevision) => transport.mutate(api.remove, { id, expectedRevision }), setDefault: id => transport.mutate(api.setDefault, { id }) };
}

/** Accessible save/apply/rename/default/delete controls; the host supplies the current table state. */
export function mountSavedViews(container: HTMLElement, client: SavedViewsClient, options: { current(): ViewDefinition; apply(view: ViewDefinition): void }): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), status = document.createElement("p"), list = document.createElement("ul"), name = document.createElement("input");
  panel.setAttribute("aria-label", "Saved views"); status.setAttribute("role", "status"); name.setAttribute("aria-label", "New view name"); name.maxLength = 100;
  let closed = false, busy = false;
  const button = (label: string, action: () => Promise<void>) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", () => { void run(action); }); return node; };
  const refresh = async () => {
    const rows = await client.list(); if (closed) return;
    list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li"), title = document.createElement("input"); title.value = row.name; title.maxLength = 100; title.setAttribute("aria-label", `Rename ${row.name}`);
      item.append(button(`${row.name}${row.isDefault ? " (default)" : ""}`, async () => { options.apply(row.definition); status.textContent = `Applied ${row.name}.`; }), title,
        button("Rename", async () => { await client.save({ id: row.id, definition: row.definition, name: title.value, expectedRevision: row.revision }); await refresh(); }),
        button(row.isDefault ? "Clear default" : "Set default", async () => { await client.setDefault(row.isDefault ? null : row.id); await refresh(); }),
        button("Delete view", async () => { await client.remove(row.id, row.revision); await refresh(); }));
      list.append(item);
    }
    if (!rows.length) list.textContent = "No saved views yet.";
  };
  const run = async (action: () => Promise<void>) => {
    if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true");
    try { await action(); } catch { if (!closed) status.textContent = "Could not update views. Refresh and try again."; }
    finally { busy = false; panel.removeAttribute("aria-busy"); }
  };
  panel.append(name, button("Save current view", async () => { await client.save({ name: name.value, definition: options.current() }); if (!closed) { name.value = ""; status.textContent = "View saved."; } await refresh(); }), button("Refresh views", refresh), status, list); container.append(panel); void run(refresh);
  return () => { closed = true; panel.remove(); };
}

export interface SharedSavedView extends SavedView { readonly workspaceId: string; readonly ownerId: string; readonly editableBy: "owner" | "workspace"; readonly canEdit: boolean; readonly canSetDefault: boolean; }
export interface SharedViewsOptions<Schema extends import("./backend.ts").DatabaseSchema<any> = import("./backend.ts").DatabaseSchema<any>> extends SavedViewsOptions {
  schema?: Schema;
  authorize(context: { auth: import("./auth.ts").AuthRequest<any>; db: import("./backend.ts").ReadDatabase<Schema> }, workspaceId: string, operation: "read" | "publish" | "edit" | "default"): boolean;
}
export interface SharedViewsClient {
  list(): Promise<readonly SharedSavedView[]>;
  save(input: { id?: string; expectedRevision?: number; name: string; definition: ViewDefinition; editableBy?: "owner" | "workspace" }): Promise<SharedSavedView>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
  setDefault(id: string | null): Promise<void>;
}
/** Workspace views use live server membership policy; a shared filter never grants underlying record access. */
export async function openSharedSavedViews<Schema extends import("./backend.ts").DatabaseSchema<any>>(options: SharedViewsOptions<Schema>): Promise<SavedViewsService>;
export async function openSharedSavedViews(options: SharedViewsOptions): Promise<SavedViewsService> {
  const { BackendActionError } = await import("./backend.ts");
  const fields = [...options.fields], maximum = options.maxViews ?? 50;
  if (!fields.length || fields.length > 100 || fields.some(field => !fieldName(field)) || new Set(fields).size !== fields.length || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200 || typeof options.authorize !== "function") throw new TypeError("Shared views need bounded fields/counts and a workspace authorization policy.");
  if (options.schema?.tables.sharedSavedViews) throw new TypeError("sharedSavedViews is reserved.");
  const schema = defineDatabase(featureTables(options.schema, { sharedSavedViews: defineTable({ workspaceId: s.string(), ownerId: s.string(), name: s.string({ min: 1, max: 100 }), definition: s.string({ max: 65536 }), revision: s.number({ integer: true, min: 1 }), isDefault: s.boolean(), editableBy: s.enum(["owner", "workspace"] as const) }).index("by_workspace", ["workspaceId"]) }));
  const allowed = (context: any, workspaceId: string, operation: "read" | "publish" | "edit" | "default") => options.authorize(context, workspaceId, operation) === true;
  const edit = (context: any, row: any) => row.ownerId === context.auth.user.id || row.editableBy === "workspace" && allowed(context, row.workspaceId, "edit");
  const output = (context: any, row: any): SharedSavedView => ({ id: row._id, name: row.name, definition: JSON.parse(row.definition), revision: row.revision, isDefault: row.isDefault, workspaceId: row.workspaceId, ownerId: row.ownerId, editableBy: row.editableBy, canEdit: edit(context, row), canSetDefault: allowed(context, row.workspaceId, "default") });
  const scope = s.string({ min: 1, max: 200 });
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: { workspaceId: scope }, agent: false, handler: (context, { workspaceId }) => { requireFeatureAccess(allowed(context, workspaceId, "read")); return context.db.table("sharedSavedViews").query().where("workspaceId", workspaceId).orderBy("name", "asc").collect().map(row => output(context, row)); } }),
    save: mutation({ args: { workspaceId: scope, id: s.optional(s.id("sharedSavedViews")), expectedRevision: s.optional(s.number({ integer: true, min: 1 })), name: s.string({ min: 1, max: 100 }), definition: s.string({ max: 65536 }), editableBy: s.optional(s.enum(["owner", "workspace"] as const)) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(allowed(context, input.workspaceId, "read"));
      const table = context.db.table("sharedSavedViews"), name = input.name.trim(), definition = JSON.stringify(validateView(JSON.parse(input.definition), fields));
      if (!name) throw new BackendActionError(400, "INVALID_VIEW", "A view needs a name.");
      const rows = table.query().where("workspaceId", input.workspaceId).collect();
      if (rows.some(row => row._id !== input.id && row.name.toLowerCase() === name.toLowerCase())) throw new BackendActionError(409, "VIEW_NAME_EXISTS", "A view with this name already exists.");
      if (input.id) {
        const row = table.get(input.id); requireFeatureAccess(Boolean(row && row.workspaceId === input.workspaceId && edit(context, row)));
        if (row!.revision !== input.expectedRevision) throw new BackendActionError(409, "VIEW_CHANGED", "View changed. Refresh before saving.");
        const editableBy = input.editableBy ?? row!.editableBy;
        if (editableBy !== row!.editableBy) requireFeatureAccess(row!.ownerId === context.auth.user!.id);
        table.patch(input.id, { name, definition, editableBy, revision: row!.revision + 1 }); return output(context, table.get(input.id));
      }
      requireFeatureAccess(allowed(context, input.workspaceId, "publish"));
      if (input.expectedRevision !== undefined || rows.length >= maximum) throw new BackendActionError(409, "VIEW_LIMIT", "Cannot create this view with the supplied revision or workspace limit.");
      const id = table.insert({ workspaceId: input.workspaceId, ownerId: context.auth.user!.id, name, definition, editableBy: input.editableBy ?? "owner", revision: 1, isDefault: false }); return output(context, table.get(id));
    } }),
    remove: mutation({ args: { workspaceId: scope, id: s.id("sharedSavedViews"), expectedRevision: s.number({ integer: true, min: 1 }) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(allowed(context, input.workspaceId, "read")); const table = context.db.table("sharedSavedViews"), row = table.get(input.id); requireFeatureAccess(Boolean(row && row.workspaceId === input.workspaceId && edit(context, row)));
      if (row!.revision !== input.expectedRevision) throw new BackendActionError(409, "VIEW_CHANGED", "View changed. Refresh before deleting."); return table.delete(input.id);
    } }),
    setDefault: mutation({ args: { workspaceId: scope, id: s.nullable(s.id("sharedSavedViews")) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(allowed(context, input.workspaceId, "read") && allowed(context, input.workspaceId, "default")); const table = context.db.table("sharedSavedViews");
      if (input.id !== null) requireFeatureAccess(table.get(input.id)?.workspaceId === input.workspaceId);
      for (const row of table.query().where("workspaceId", input.workspaceId).collect()) if (row.isDefault !== (row._id === input.id)) table.patch(row._id, { isDefault: row._id === input.id, revision: row.revision + 1 });
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/shared-views", maxCacheEntries: 0, agent: false });
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createSharedViewsClient(options: SyncClientOptions & { workspaceId: string }): SharedViewsClient {
  const api = createApi<{
    list: FeatureQuery<{ workspaceId: string }, readonly SharedSavedView[]>;
    save: FeatureMutation<Omit<Parameters<SharedViewsClient["save"]>[0], "definition"> & { definition: string; workspaceId: string }, SharedSavedView>;
    remove: FeatureMutation<{ workspaceId: string; id: string; expectedRevision: number }, boolean>;
    setDefault: FeatureMutation<{ workspaceId: string; id: string | null }, void>;
  }>(), prefix = (options.url ?? "/__clank/shared-views").replace(/\/$/u, ""), workspaceId = options.workspaceId;
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/u, "")}`, init) });
  return { list: () => transport.query(api.list, { workspaceId }), save: input => transport.mutate(api.save, { ...input, workspaceId, definition: JSON.stringify(validateView(input.definition)) }), remove: (id, expectedRevision) => transport.mutate(api.remove, { workspaceId, id, expectedRevision }), setDefault: id => transport.mutate(api.setDefault, { workspaceId, id }) };
}
export function mountSharedSavedViews(container: HTMLElement, client: SharedViewsClient, options: { current(): ViewDefinition; apply(view: ViewDefinition): void }): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), status = document.createElement("p"), list = document.createElement("ul"), name = document.createElement("input"), editable = document.createElement("select");
  panel.setAttribute("aria-label", "Workspace saved views"); status.setAttribute("role", "status"); name.setAttribute("aria-label", "Shared view name"); name.maxLength = 100; editable.setAttribute("aria-label", "Who may edit this view");
  for (const [value, title] of [["owner", "Only me"], ["workspace", "Authorized workspace editors"]]) { const item = document.createElement("option"); item.value = value!; item.textContent = title!; editable.append(item); }
  let closed = false, busy = false;
  const run = async (action: () => Promise<void>) => { if (busy || closed) return; busy = true; try { await action(); } catch { if (!closed) { list.replaceChildren(); status.textContent = "View unavailable, changed, or permission denied. Refresh before retrying."; } } finally { busy = false; } };
  const button = (label: string, action: () => Promise<void>) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", () => { void run(action); }); return node; };
  const refresh = async () => { const views = await client.list(); if (closed) return; list.replaceChildren(); for (const view of views) { const row = document.createElement("li"); row.append(button(`${view.name}${view.isDefault ? " (workspace default)" : ""}`, async () => { options.apply(view.definition); })); if (view.canEdit) row.append(button("Update from current view", async () => { await client.save({ id: view.id, expectedRevision: view.revision, name: view.name, definition: options.current() }); await refresh(); }), button("Delete shared view", async () => { await client.remove(view.id, view.revision); await refresh(); })); if (view.canSetDefault) row.append(button(view.isDefault ? "Clear workspace default" : "Set workspace default", async () => { await client.setDefault(view.isDefault ? null : view.id); await refresh(); })); list.append(row); } };
  panel.append(name, editable, button("Publish current view", async () => { await client.save({ name: name.value, definition: options.current(), editableBy: editable.value as "owner" | "workspace" }); await refresh(); }), button("Refresh shared views", refresh), status, list); container.append(panel); void run(refresh); return () => { closed = true; panel.remove(); };
}
