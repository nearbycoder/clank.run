import { defineBackend, defineDatabase, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";
import { collaborativeMetadataTables, featureTables, featureTransport, importMetadataTables, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";
import { createRetentionController } from "./retention-internal.ts";

export type RetentionKind = "import" | "collaboration" | "audit";
export type RetentionOperation = "read" | "purge" | "hold" | "schedule";
export interface RetentionResourceRef { readonly kind: RetentionKind; readonly id: string; }
/** Trusted source identifiers used by the server's scope resolver. */
export interface RetentionResourceIdentity extends RetentionResourceRef {
  readonly ownerId?: string; readonly organizationId?: string | null; readonly projectId?: string | null;
}
export interface RetentionHold { readonly active: boolean; readonly version: number; readonly reason: string; readonly expiresAt: number | null; }
export interface RetentionResource extends RetentionResourceRef {
  readonly state: string; readonly version: number; readonly createdAt: number;
  readonly payloadRows: number; readonly payloadBytes: number; readonly receiptRows: number; readonly receiptBytes: number;
  readonly historyRows: number; readonly historyBytes: number; readonly identityRows: number;
  /** Subset retained by the initial policy: current text/branches, metadata and identities. */
  readonly protectedRows: number; readonly protectedBytes: number;
  readonly hold: RetentionHold | null;
}
export interface RetentionInventory { readonly scope: string; readonly resources: readonly RetentionResource[]; readonly next: string | null; }
export interface RetentionPurgeSelection {
  readonly scope: string; readonly resources: readonly RetentionResourceRef[]; readonly cutoff: number; readonly maxDeletes: number;
}
export interface RetentionPurgePreview extends RetentionPurgeSelection {
  readonly protocol: "clank-retention/1"; readonly policyRevision: string; readonly holdRevision: number;
  readonly items: readonly (RetentionResourceRef & { readonly records: number; readonly bytes: number; readonly blocked: "held" | "active" | "unacknowledged" | null })[];
  readonly records: number; readonly bytes: number; readonly digest: string;
}
export interface RetentionPurgeReceipt { readonly operationId: string; readonly scope: string; readonly records: number; readonly bytes: number; readonly acceptedAt: number; }
export interface RetentionScheduleInput {
  readonly id: string; readonly scope: string; readonly expectedVersion: number; readonly kinds: readonly RetentionKind[];
  readonly olderThanMs: number; readonly everyMs: number; readonly maxDeletes: number; readonly state: "active" | "paused";
}
export interface RetentionSchedule extends Omit<RetentionScheduleInput, "expectedVersion"> {
  readonly version: number; readonly nextAt: number; readonly lastAt: number | null; readonly lastReceipt: RetentionPurgeReceipt | null; readonly error: string | null;
}
export interface RetentionAdministrationOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string;
  sources: { imports?: boolean; collaboration?: { maxCharacters?: number } };
  /** Change this whenever the trusted resolver/operator policy changes. */
  policyRevision: string;
  scope(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, resource: RetentionResourceIdentity): string | null;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, scope: string, operation: RetentionOperation): boolean;
  maxResources?: number; maxReceipts?: number; maxReceiptBytes?: number; maxHolds?: number; maxSchedules?: number;
  /** Background runner is opt-in; runDue can also be called by an existing trusted job. */
  intervalMs?: number | false;
}
export interface RetentionAdministrationService {
  handle(request: Request): Promise<Response>; runDue(): number; start(): void; close(): void;
}
export interface RetentionAdministrationClient {
  inventory(scope: string, options?: { kinds?: readonly RetentionKind[]; after?: string; limit?: number }): Promise<RetentionInventory>;
  preview(selection: RetentionPurgeSelection): Promise<RetentionPurgePreview>;
  accept(preview: RetentionPurgePreview, operationId: string): Promise<RetentionPurgeReceipt>;
  hold(scope: string, resource: RetentionResourceRef, expectedVersion: number, reason: string, expiresAt: number | null, operationId: string): Promise<RetentionHold>;
  release(scope: string, resource: RetentionResourceRef, expectedVersion: number, operationId: string): Promise<null>;
  schedules(scope: string): Promise<readonly RetentionSchedule[]>;
  saveSchedule(input: RetentionScheduleInput, operationId: string): Promise<RetentionSchedule>;
}
const scopeArg = s.string({ min: 1, max: 200 }), operationArg = s.string({ min: 1, max: 100 });
const resourceArg = s.object({ kind: s.enum(["import", "collaboration", "audit"] as const), id: s.string({ min: 1, max: 200 }) });
const kindsArg = s.array(s.enum(["import", "collaboration", "audit"] as const), { min: 1, max: 3 });
const deleteArg = s.number({ integer: true, min: 1, max: 10000 });
const selectionArgs = { scope: scopeArg, resources: s.array(resourceArg, { min: 1, max: 100 }), cutoff: s.number({ integer: true, min: 0 }), maxDeletes: deleteArg };

/** Per-database reviewed retirement with durable holds and freshly authorized schedules. */
export async function openRetentionAdministration<Schema extends DatabaseSchema<any>>(options: RetentionAdministrationOptions<Schema>): Promise<RetentionAdministrationService>;
export async function openRetentionAdministration(options: RetentionAdministrationOptions): Promise<RetentionAdministrationService> {
  if (!options.sources || typeof options.sources !== "object" || options.sources.imports !== undefined && typeof options.sources.imports !== "boolean" || options.sources.collaboration !== undefined && (!options.sources.collaboration || typeof options.sources.collaboration !== "object" || Array.isArray(options.sources.collaboration)) || !options.sources.imports && !options.sources.collaboration || typeof options.scope !== "function" || typeof options.authorize !== "function") throw new TypeError("Declare retention sources and synchronous scope/operator policies.");
  options = { ...options, sources: { ...options.sources, ...(options.sources.collaboration ? { collaboration: { ...options.sources.collaboration } } : {}) } };
  const maximum = options.sources.collaboration?.maxCharacters ?? 200000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000) throw new TypeError("Invalid collaboration character limit.");
  const schema = defineDatabase(featureTables(options.schema, {
    ...(options.sources.imports ? importMetadataTables(true) : {}),
    ...(options.sources.collaboration ? collaborativeMetadataTables(maximum) : {}),
  }));
  let controller: Awaited<ReturnType<typeof createRetentionController>>;
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    inventory: query({ args: { scope: scopeArg, kinds: kindsArg, after: s.optional(s.string({ max: 1000 })), limit: s.number({ integer: true, min: 1, max: 100 }) }, agent: false, handler: (context, input) => controller.inventory(context.auth, input) }),
    preview: query({ args: selectionArgs, agent: false, handler: (context, input) => controller.preview(context.auth, input) }),
    accept: mutation({ args: { preview: s.string({ max: 1024 * 1024 }), operationId: operationArg }, agent: false, handler: (context, input) => controller.accept(context.auth, input.preview, input.operationId) }),
    hold: mutation({ args: { scope: scopeArg, resource: resourceArg, expectedVersion: s.number({ integer: true, min: 0 }), reason: s.string({ min: 1, max: 2000 }), expiresAt: s.nullable(s.number({ integer: true, min: 0 })), operationId: operationArg }, agent: false, handler: (context, input) => controller.hold(context.auth, input) }),
    release: mutation({ args: { scope: scopeArg, resource: resourceArg, expectedVersion: s.number({ integer: true, min: 1 }), operationId: operationArg }, agent: false, handler: (context, input) => controller.release(context.auth, input) }),
    schedules: query({ args: { scope: scopeArg }, agent: false, handler: (context, input) => controller.schedules(context.auth, input.scope) }),
    saveSchedule: mutation({ args: { input: s.string({ max: 10000 }), operationId: operationArg }, agent: false, handler: (context, input) => controller.saveSchedule(context.auth, input.input, input.operationId) }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/retention", agent: false, maxCacheEntries: 0, maxRequestBytes: 2 * 1024 * 1024 });
  try {
    controller = await createRetentionController({ ...options, native: (runtime.database as any)[SQLITE_INTERNAL] as SQLiteInternal,
      kinds: [...(options.sources.imports ? ["import" as const] : []), ...(options.sources.collaboration ? ["collaboration" as const] : [])],
      refresh: (userId, sessionId) => { const auth = runtime.auth!.refreshSession(sessionId); return auth?.user?.id === userId ? auth : null; } });
  } catch (error) { runtime.close(); throw error; }
  const service = { handle: runtime.handle, runDue: controller.runDue, start: controller.start, close() { controller.close(); runtime.close(); } };
  if (options.intervalMs !== undefined && options.intervalMs !== false) service.start();
  return service;
}
export function createRetentionAdministrationClient(options: SyncClientOptions = {}): RetentionAdministrationClient {
  type Api = { inventory: FeatureQuery<{ scope: string; kinds: readonly RetentionKind[]; after?: string; limit: number }, RetentionInventory>;
    preview: FeatureQuery<RetentionPurgeSelection, RetentionPurgePreview>; accept: FeatureMutation<{ preview: string; operationId: string }, RetentionPurgeReceipt>;
    hold: FeatureMutation<{ scope: string; resource: RetentionResourceRef; expectedVersion: number; reason: string; expiresAt: number | null; operationId: string }, RetentionHold>;
    release: FeatureMutation<{ scope: string; resource: RetentionResourceRef; expectedVersion: number; operationId: string }, null>;
    schedules: FeatureQuery<{ scope: string }, readonly RetentionSchedule[]>; saveSchedule: FeatureMutation<{ input: string; operationId: string }, RetentionSchedule> };
  // Platform browser middleware verifies every POST, including query POSTs.
  // Resolve the current CSRF token once per request for both adapters.
  const { client, api } = featureTransport<Api>({ ...options, auth: undefined, fetch: (url, init) => (options.fetch ?? fetch)(url, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...options.auth?.csrfHeader() },
  }) }, "/__clank/retention");
  return { inventory: (scope, settings = {}) => client.query(api.inventory, { scope, kinds: settings.kinds ?? ["import", "collaboration", "audit"], after: settings.after, limit: settings.limit ?? 50 }),
    preview: selection => client.query(api.preview, selection), accept: (preview, operationId) => client.mutate(api.accept, { preview: JSON.stringify(preview), operationId }),
    hold: (scope, resource, expectedVersion, reason, expiresAt, operationId) => client.mutate(api.hold, { scope, resource, expectedVersion, reason, expiresAt, operationId }),
    release: (scope, resource, expectedVersion, operationId) => client.mutate(api.release, { scope, resource, expectedVersion, operationId }),
    schedules: scope => client.query(api.schedules, { scope }), saveSchedule: (input, operationId) => client.mutate(api.saveSchedule, { input: JSON.stringify(input), operationId }) };
}

export interface RetentionAdministrationWidgetOptions {
  client: RetentionAdministrationClient; scope(): string | null; currentUser(): string | null;
  kinds?: readonly RetentionKind[]; maxDeletes?: number;
}
/** Operator inventory, explicit batch review, holds and periodic cleanup rules. */
export function mountRetentionAdministration(root: HTMLElement, options: RetentionAdministrationWidgetOptions): () => void {
  if (typeof options.scope !== "function" || typeof options.currentUser !== "function" || !options.client) throw new TypeError("Retention controls need current account/scope getters and a client.");
  const document = root.ownerDocument, controls: Array<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement> = [], selected = new Map<string, RetentionResource>(), operationIds = new Map<string, string>();
  let disposed = false, busy = false, generation = 0, bound = JSON.stringify([options.currentUser(), options.scope()]), page: RetentionInventory | undefined, reviewed: RetentionPurgePreview | undefined, ruleVersion = 0;
  const panel = document.createElement("section"), title = document.createElement("h2"), status = document.createElement("p"), inventoryPanel = document.createElement("div"), previewPanel = document.createElement("div"), schedulePanel = document.createElement("div");
  panel.style.maxWidth = "100%"; panel.style.overflowWrap = "anywhere"; title.textContent = "Retention"; status.setAttribute("role", "status"); panel.append(title, status);
  const input = (parent: HTMLElement, label: string, type = "text", value = "") => {
    const wrap = document.createElement("label"), element = document.createElement("input"); wrap.textContent = `${label} `; element.type = type; element.value = value; element.style.maxWidth = "100%"; element.style.boxSizing = "border-box"; wrap.append(element); parent.append(wrap); controls.push(element); return element;
  };
  const button = (parent: HTMLElement, label: string, action: () => void) => { const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.addEventListener("click", action); parent.append(element); controls.push(element); return element; };
  const localTime = (date: Date) => { const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return shifted.toISOString().slice(0, 23); };
  const cutoff = input(panel, "Retire data created before", "datetime-local", localTime(new Date())), maximum = input(panel, "Maximum records per batch", "number", String(options.maxDeletes ?? 1000)); maximum.min = "1"; maximum.max = "10000"; cutoff.step = "0.001";
  const clear = () => {
    selected.clear(); operationIds.clear(); page = undefined; reviewed = undefined; ruleVersion = 0;
    inventoryPanel.replaceChildren(); previewPanel.replaceChildren(); schedulePanel.replaceChildren();
    reason.value = ""; expires.value = ""; ruleId.value = ""; age.value = "30"; every.value = "1440"; paused.checked = false;
    for (const { element } of kindInputs) element.checked = true;
    cutoff.value = localTime(new Date()); maximum.value = String(options.maxDeletes ?? 1000);
  };
  const currentActor = () => !disposed && JSON.stringify([options.currentUser(), options.scope()]) === bound;
  const refs = () => [...selected.values()].map(resource => ({ kind: resource.kind, id: resource.id }));
  const chosenHold = () => selected.size === 1 ? [...selected.values()][0] : undefined;
  const setControls = () => {
    for (let index = controls.length - 1; index >= 0; index--) if (!controls[index]!.isConnected) controls.splice(index, 1);
    for (const control of controls) control.disabled = busy || disposed;
    acceptButton.disabled = busy || !reviewed || reviewed.records === 0;
    nextButton.disabled = busy || !page?.next;
    holdButton.disabled = busy || selected.size !== 1;
    releaseButton.disabled = busy || !chosenHold()?.hold;
  };
  const operationId = (kind: string, value: unknown) => { const key = JSON.stringify([kind, value]); let id = operationIds.get(key); if (!id) { if (operationIds.size >= 100) throw new Error("Reopen the retention console before starting more actions."); id = crypto.randomUUID(); operationIds.set(key, id); } return id; };
  const run = async <Value>(work: (scope: string) => Promise<Value>, commit: (value: Value) => void, refresh = false) => {
    if (disposed || busy) return;
    const user = options.currentUser(), scope = options.scope(), actor = JSON.stringify([user, scope]);
    if (!user || !scope) { clear(); status.textContent = "Sign in and choose a workspace."; setControls(); return; }
    if (actor !== bound) { clear(); bound = actor; if (!refresh) { status.textContent = "Account or workspace changed. Refresh the inventory."; setControls(); return; } }
    const current = ++generation, focus = document.activeElement as HTMLElement | null; busy = true; setControls(); status.textContent = "Working…";
    try {
      const value = await work(scope);
      if (disposed || current !== generation) return;
      if (JSON.stringify([options.currentUser(), options.scope()]) !== actor) { clear(); status.textContent = "Account or workspace changed. Refresh the inventory."; return; }
      commit(value);
    } catch (error) {
      if (disposed || current !== generation) return;
      if (JSON.stringify([options.currentUser(), options.scope()]) !== actor) { clear(); status.textContent = "Account or workspace changed. Refresh the inventory."; return; }
      if ([401, 403, 404].includes(Number((error as any)?.status))) clear();
      status.textContent = error instanceof Error ? error.message : "The retention action failed.";
    } finally {
      if (!disposed && current === generation) { busy = false; setControls(); if (focus?.isConnected && document.activeElement === document.body) ((focus as HTMLButtonElement).disabled ? refreshButton : focus).focus(); }
    }
  };
  const renderInventory = (value: RetentionInventory) => {
    page = value; selected.clear(); reviewed = undefined; previewPanel.replaceChildren(); inventoryPanel.replaceChildren();
    const table = document.createElement("table"), head = document.createElement("thead"), header = document.createElement("tr"), body = document.createElement("tbody"); table.style.width = "100%"; table.style.tableLayout = "fixed";
    for (const label of ["Resource", "Retained data", "Hold"]) { const cell = document.createElement("th"); cell.setAttribute("scope", "col"); cell.textContent = label; header.append(cell); } head.append(header);
    for (const resource of value.resources) {
      const row = document.createElement("tr"), identity = document.createElement("td"), data = document.createElement("td"), held = document.createElement("td"), label = document.createElement("label"), select = document.createElement("input");
      select.type = "checkbox"; select.addEventListener("change", () => { if (!currentActor()) { clear(); setControls(); return; } const key = JSON.stringify([resource.kind, resource.id]); if (select.checked) selected.set(key, resource); else selected.delete(key); reviewed = undefined; previewPanel.replaceChildren(); setControls(); });
      label.append(select, document.createTextNode(`${resource.kind}: ${resource.id}`)); identity.append(label); controls.push(select);
      data.textContent = `${resource.state}; ${resource.payloadRows} payload (${resource.payloadBytes} bytes), ${resource.receiptRows} receipts (${resource.receiptBytes} bytes), ${resource.historyRows} history records (${resource.historyBytes} bytes), ${resource.identityRows} identities. ${resource.protectedRows} protected records (${resource.protectedBytes} bytes) remain.`;
      held.textContent = resource.hold ? `${resource.hold.active ? "Active" : "Expired"}: ${resource.hold.reason}` : "No hold"; row.append(identity, data, held); body.append(row);
    }
    table.append(head, body); inventoryPanel.append(table); if (!value.resources.length) { const empty = document.createElement("p"); empty.textContent = "No resources in this scope."; inventoryPanel.append(empty); }
    status.textContent = `Showing ${value.resources.length} resources.`;
  };
  const refreshButton = button(panel, "Refresh inventory", () => { void run(scope => options.client.inventory(scope, { kinds: options.kinds }), renderInventory, true); });
  const nextButton = button(panel, "Next page", () => { const next = page?.next; if (next) void run(scope => options.client.inventory(scope, { kinds: options.kinds, after: next }), renderInventory); });
  button(panel, "Review purge", () => { void run(async scope => {
    const resources = refs(), date = new Date(cutoff.value).getTime(), limit = Number(maximum.value); if (!resources.length) throw new Error("Select resources to review."); if (!Number.isSafeInteger(date) || date > Date.now()) throw new Error("Choose a cutoff in the past.");
    return options.client.preview({ scope, resources, cutoff: date, maxDeletes: limit });
  }, value => {
    reviewed = value; previewPanel.replaceChildren(); const description = document.createElement("p"); description.textContent = `Review retirement of ${value.records} records (${value.bytes} bytes of stored data). Protected identities and current document text remain.`; previewPanel.append(description);
    for (const item of value.items) { const row = document.createElement("p"); row.textContent = `${item.kind}: ${item.id} — ${item.blocked ? `blocked: ${item.blocked}` : `${item.records} records`}`; previewPanel.append(row); } status.textContent = "Review the selected batch before accepting.";
  }); });
  const acceptButton = button(panel, "Accept reviewed purge", () => { const preview = reviewed; if (preview) void run(scope => options.client.accept(preview, operationId("purge", preview)), value => { reviewed = undefined; previewPanel.replaceChildren(); inventoryPanel.replaceChildren(); selected.clear(); page = undefined; status.textContent = `Retired ${value.records} records. Refresh to inspect the remaining data.`; }); });
  panel.append(inventoryPanel, previewPanel);
  const holdPanel = document.createElement("fieldset"), holdLegend = document.createElement("legend"); holdLegend.textContent = "Hold a selected resource"; holdPanel.append(holdLegend);
  const reason = input(holdPanel, "Reason"), expires = input(holdPanel, "Expires at (blank keeps the hold)", "datetime-local"); reason.maxLength = 2000;
  const holdButton = button(holdPanel, "Save hold", () => { void run(scope => { const resource = chosenHold(); if (!resource) throw new Error("Select one resource."); const ref = { kind: resource.kind, id: resource.id }, until = expires.value ? new Date(expires.value).getTime() : null, values = [scope, ref, resource.hold?.version ?? 0, reason.value, until]; return options.client.hold(scope, ref, resource.hold?.version ?? 0, reason.value, until, operationId("hold", values)); }, value => { reviewed = undefined; previewPanel.replaceChildren(); selected.clear(); status.textContent = "Hold saved. Refresh to inspect its current state."; }); });
  const releaseButton = button(holdPanel, "Release hold", () => { void run(scope => { const resource = chosenHold(); if (!resource?.hold) throw new Error("Select a resource with a hold."); const ref = { kind: resource.kind, id: resource.id }; return options.client.release(scope, ref, resource.hold.version, operationId("release", [scope, ref, resource.hold.version])); }, () => { reviewed = undefined; previewPanel.replaceChildren(); selected.clear(); status.textContent = "Hold released. Refresh and review any purge again."; }); }); panel.append(holdPanel);
  const rules = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = "Periodic cleanup"; rules.append(legend);
  const ruleId = input(rules, "Rule name"), age = input(rules, "Minimum age in days", "number", "30"), every = input(rules, "Run every minutes", "number", "1440"); age.min = "0"; every.min = "1"; ruleId.maxLength = 100;
  const kindInputs = (options.kinds ?? ["import", "collaboration", "audit"] as const).map(kind => { const element = input(rules, kind, "checkbox"); element.checked = true; return { kind, element }; });
  const paused = input(rules, "Paused", "checkbox");
  button(rules, "Load rules", () => { void run(scope => options.client.schedules(scope), values => {
    schedulePanel.replaceChildren(); for (const rule of values) { const row = document.createElement("p"); row.textContent = `${rule.id}: ${rule.state}${rule.error ? " — review permissions and the rule before resuming" : ""}. `;
      button(row, "Edit rule", () => { if (!currentActor()) { clear(); setControls(); return; } ruleId.value = rule.id; ruleVersion = rule.version; age.value = String(rule.olderThanMs / 86400000); every.value = String(rule.everyMs / 60000); paused.checked = rule.state === "paused"; for (const { kind, element } of kindInputs) element.checked = rule.kinds.includes(kind); ruleId.focus(); }); schedulePanel.append(row); } status.textContent = `Loaded ${values.length} rules.`;
  }); });
  ruleId.addEventListener("input", () => { ruleVersion = 0; });
  button(rules, "Save rule", () => { void run(scope => { const input: RetentionScheduleInput = { id: ruleId.value, scope, expectedVersion: ruleVersion, kinds: kindInputs.filter(({ element }) => element.checked).map(({ kind }) => kind), olderThanMs: Number(age.value) * 86400000, everyMs: Number(every.value) * 60000, maxDeletes: Number(maximum.value), state: paused.checked ? "paused" : "active" }; return options.client.saveSchedule(input, operationId("schedule", input)); }, value => { ruleVersion = value.version; status.textContent = "Cleanup rule saved."; }); }); panel.append(rules, schedulePanel); root.append(panel);
  for (const field of [cutoff, maximum]) field.addEventListener("input", () => { reviewed = undefined; previewPanel.replaceChildren(); setControls(); });
  setControls(); void run(scope => options.client.inventory(scope, { kinds: options.kinds }), renderInventory, true);
  return () => { disposed = true; generation++; clear(); panel.remove(); };
}
