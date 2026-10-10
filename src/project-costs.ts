import type { AuthClient } from "./auth.ts";
import type { McpTool } from "./mcp.ts";

export type ProjectCostMeter = "storageByteMilliseconds" | "transferBytes" | "runtimeMilliseconds";
export interface ProjectCostRate {
  /** Smallest currency units per declared quantity, both nonnegative integers. */
  readonly amountMinor: number;
  readonly perUnits: number;
}
export interface ProjectCostRateCard {
  readonly id: string;
  readonly revision: number;
  readonly currency: string;
  /** UTC month boundary. Previously accepted periods retain their card. */
  readonly effectiveFrom: number;
  readonly rates: Readonly<Record<ProjectCostMeter, ProjectCostRate>>;
}
export interface ProjectCostMeasurement {
  /** Opaque trusted collector identity; never a path or a credential. */
  readonly source: string;
  readonly sourceRevision: string;
  readonly periodStartedAt: number;
  readonly observedUntil: number;
  readonly meters: Readonly<Record<ProjectCostMeter, {
    /** Exact cumulative integer quantity; null means unavailable. */
    readonly units: string | null;
    /** The collector attests coverage from periodStartedAt through observedUntil. */
    readonly complete: boolean;
  }>>;
}
export interface ProjectCostComponent {
  readonly meter: ProjectCostMeter;
  readonly units: string | null;
  readonly complete: boolean;
  /** Exact numerator before division by the rate's perUnits. */
  readonly numerator: string | null;
  readonly denominator: number;
  /** Rounded upward once per cumulative component, in smallest currency units. */
  readonly amountMinor: string | null;
}
export interface ProjectCostSnapshot {
  readonly protocol: "clank-project-costs/1";
  readonly projectId: string;
  readonly month: string;
  readonly version: number;
  readonly observedUntil: number;
  readonly reconciledAt: number;
  readonly source: string;
  readonly sourceRevision: string;
  readonly rateCard: ProjectCostRateCard;
  readonly components: readonly ProjectCostComponent[];
  readonly knownAmountMinor: string;
  /** Null if any meter lacks complete coverage. This is an estimate, never an invoice. */
  readonly amountMinor: string | null;
  readonly reason: string;
}
export interface ProjectCostPolicy {
  readonly version: number;
  readonly currency: string;
  readonly limitMinor: string;
  readonly warningPercent: number;
  readonly admission: "observe" | "deny-at-observed-limit";
  readonly maxMeasurementAgeMs: number;
  readonly updatedAt: number;
  readonly reason: string;
}
export interface ProjectCostOverride {
  readonly version: number;
  readonly policyVersion: number;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly reason: string;
  readonly active: boolean;
}
export interface ProjectCostReport {
  readonly protocol: "clank-project-costs/1";
  readonly projectId: string;
  readonly month: string;
  readonly snapshot: ProjectCostSnapshot | null;
  readonly policy: ProjectCostPolicy | null;
  readonly override: ProjectCostOverride | null;
  readonly status: "unconfigured" | "unknown" | "stale" | "within-budget" | "warning" | "exhausted";
  readonly admission: "allowed" | "blocked" | "overridden";
  readonly asOf: number;
}
export interface ProjectCostReconcileInput {
  readonly month: string;
  readonly expectedVersion: number;
  readonly operationId: string;
  readonly reason: string;
}
export interface ProjectCostPolicyInput {
  readonly expectedVersion: number;
  readonly operationId: string;
  readonly currency: string;
  readonly limitMinor: string;
  readonly warningPercent: number;
  readonly admission: "observe" | "deny-at-observed-limit";
  readonly maxMeasurementAgeMs: number;
  readonly reason: string;
}
export interface ProjectCostOverrideInput {
  readonly expectedVersion: number;
  readonly policyVersion: number;
  readonly operationId: string;
  /** Zero revokes the current override. Otherwise a future expiry within one hour. */
  readonly expiresAt: number;
  readonly reason: string;
}
export interface ProjectCostClient {
  read(projectId: string, month?: string): Promise<ProjectCostReport>;
  history(projectId: string, month: string): Promise<readonly ProjectCostSnapshot[]>;
  reconcile(projectId: string, input: ProjectCostReconcileInput): Promise<ProjectCostSnapshot>;
  policy(projectId: string, input: ProjectCostPolicyInput): Promise<ProjectCostPolicy>;
  override(projectId: string, input: ProjectCostOverrideInput): Promise<ProjectCostOverride>;
}
export interface ProjectCostClientOptions {
  readonly url?: string;
  readonly auth?: Pick<AuthClient, "csrfHeader">;
  readonly headers?: () => HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export interface ProjectCostViewOptions {
  readonly client: ProjectCostClient;
  readonly projectId: string;
  /** Current local account identity; a change clears the view before accepting any result. */
  readonly getAccountId: () => string | null;
  /** Presentation only. The server independently requires current fresh human administration. */
  readonly canManage?: () => boolean;
  readonly month?: string;
}
export interface ProjectCostView {
  readonly disposed: boolean;
  refresh(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Remove local drafts and private metadata. Already dispatched operations may have committed. */
  dispose(): void;
}

/** Read-only tools. Resolve a native authenticated client for this caller on every invocation. */
export function createProjectCostMcpTools<Context>(resolveClient: (context: Context, request: Request) => ProjectCostClient): readonly McpTool<Context>[] {
  const parse = (input: unknown, history: boolean) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid cost tool input.");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => key !== "projectId" && key !== "month")
      || typeof value.projectId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.projectId)
      || ((history || value.month !== undefined) && (typeof value.month !== "string" || !/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u.test(value.month)))) throw new TypeError("Invalid cost tool input.");
    return {projectId: value.projectId, month: value.month as string | undefined};
  };
  return [false, true].map(history => ({
    name: history ? "project_costs_history" : "project_costs_read",
    description: history ? "Read up to 25 retained project cost reconciliations; estimates are not invoices." : "Read measured project cost estimates, unknown coverage, budget and admission status; estimates are not invoices.",
    inputSchema: {type: "object", additionalProperties: false, required: history ? ["projectId", "month"] : ["projectId"], properties: {projectId: {type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$"}, month: {type: "string", pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$"}}},
    requiredScope: "agent:read" as const,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    async invoke(input: unknown, context: Context, request: Request) {
      const value = parse(input, history), client = resolveClient(context, request);
      return history ? {snapshots: await client.history(value.projectId, value.month!)} : {report: await client.read(value.projectId, value.month)};
    },
  }));
}

/** Exact operation IDs are retained across ambiguous transport failures. */
export function createProjectCostClient(options: ProjectCostClientOptions = {}): ProjectCostClient {
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 60_000) throw new TypeError("Invalid cost transport timeout.");
  const id = (value: string) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new TypeError("Invalid cost project identifier.");
    return encodeURIComponent(value);
  };
  const request = async (projectId: string, suffix: string, input?: unknown): Promise<any> => {
    const headers = new Headers(options.headers?.());
    for (const [key, value] of Object.entries(options.auth?.csrfHeader() ?? {})) headers.set(key, value);
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body !== undefined && new TextEncoder().encode(body).byteLength > 8_192) throw new TypeError("Cost input exceeds its envelope.");
    if (body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController(), chunks: Uint8Array[] = [];
    let bytes = 0, timer: ReturnType<typeof setTimeout>, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      const error = new Error("Cost transport timed out. Inspect current state before retrying the exact operation.");
      controller.abort(error); reject(error);
    }, timeout); });
    try {
      const pending = Promise.resolve().then(() => (options.fetch ?? fetch)(`${(options.url ?? "").replace(/\/$/u, "")}/api/projects/${id(projectId)}/costs${suffix}`, {
        method: body === undefined ? "GET" : "POST", headers, body, signal: controller.signal, credentials: "same-origin", redirect: "error",
      })).then(response => {
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw controller.signal.reason; }
        return response;
      });
      const response = await Promise.race([pending, expiration]);
      if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("Cost transport refused a redirect."); }
      reader = response.body?.getReader();
      while (reader) {
        const part = await Promise.race([reader.read(), expiration]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) { void reader.cancel().catch(() => {}); throw new Error("Cost response exceeds its envelope."); }
        chunks.push(part.value);
      }
      const all = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      let result: any;
      try { result = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(all)); }
      catch { throw new Error("Cost transport returned invalid JSON."); }
      if (!response.ok || result?.ok !== true) {
        const error = new Error("Cost access changed or the operation was rejected. Refresh before retrying.") as Error & {status: number};
        error.status = response.status; throw error;
      }
      return result;
    } finally { clearTimeout(timer!); if (controller.signal.aborted) void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  };
  return {
    read: async (projectId, month) => (await request(projectId, month === undefined ? "" : `?month=${encodeURIComponent(month)}`)).report,
    history: async (projectId, month) => (await request(projectId, `/history?month=${encodeURIComponent(month)}`)).snapshots,
    reconcile: async (projectId, input) => (await request(projectId, "/reconcile", input)).snapshot,
    policy: async (projectId, input) => (await request(projectId, "/policy", input)).policy,
    override: async (projectId, input) => (await request(projectId, "/override", input)).override,
  };
}

/** Native controls with version-pinned drafts and unchanged-operation retries. */
export function createProjectCostView(root: HTMLElement, options: ProjectCostViewOptions): ProjectCostView {
  const account = options.getAccountId(), projectId = options.projectId, client = options.client;
  if (!account || !/^[A-Za-z0-9_-]{8,128}$/u.test(projectId)) throw new TypeError("A signed-in cost view needs its current project.");
  const month = options.month ?? new Date().toISOString().slice(0, 7);
  let disposed = false, busy = false, generation = 0, current: ProjectCostReport | null = null, dirty = false;
  let policyVersion = 0, overrideVersion = 0, overridePolicyVersion = 0;
  let pending: {kind: "reconcile" | "policy" | "override"; input: ProjectCostReconcileInput | ProjectCostPolicyInput | ProjectCostOverrideInput} | undefined;
  const node = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string): HTMLElementTagNameMap[Tag] => {
    const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
  };
  const title = node("h2", "Project costs and budget"), notice = node("p", "Measured cost estimates use the operator’s rate card. Missing coverage stays unknown. These estimates are not invoices."), status = node("p", "Loading cost measurements…");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.tabIndex = -1;
  const summary = node("div"), components = node("dl"), history = node("div"), manager = node("div"), refresh = node("button", "Refresh costs"), retry = node("button", "Retry unchanged operation"), discard = node("button", "Discard draft and refresh");
  refresh.type = retry.type = discard.type = "button"; retry.hidden = true; discard.hidden = true;
  root.style.overflowWrap = "anywhere"; root.replaceChildren(title, notice, status, refresh, retry, discard, summary, components, history, manager);
  const field = (parent: HTMLElement, label: string, type = "text") => {
    const wrapper = node("label", label), input = node("input"); input.type = type; input.maxLength = 1_024;
    input.name = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"); input.autocomplete = "off";
    input.style.width = "100%"; input.style.boxSizing = "border-box"; wrapper.style.display = "block"; wrapper.style.marginBlock = "12px"; wrapper.append(input); parent.append(wrapper); return input;
  };
  const submit = (form: HTMLFormElement, text: string) => { const button = node("button", text); button.type = "submit"; form.append(button); return button; };
  const reconcileForm = node("form"), policyForm = node("form"), overrideForm = node("form");
  reconcileForm.append(node("h3", "Reconcile measured usage"));
  const reconcileReason = field(reconcileForm, "Reconciliation reason"); reconcileReason.required = true; submit(reconcileForm, "Reconcile usage");
  policyForm.append(node("h3", "Budget policy"));
  const policyCurrency = field(policyForm, "Currency code"), limit = field(policyForm, "Budget in smallest currency units"), warning = field(policyForm, "Warning threshold, percent", "number"), age = field(policyForm, "Maximum measurement age, milliseconds", "number"), policyReason = field(policyForm, "Budget change reason");
  policyCurrency.maxLength = 3; policyCurrency.required = limit.required = warning.required = age.required = policyReason.required = true;
  policyCurrency.spellcheck = false;
  warning.min = "1"; warning.max = "100"; age.min = "1000"; age.max = "86400000"; warning.value = "80"; age.value = "60000"; limit.inputMode = "numeric";
  const admissionLabel = node("label", "Admission policy"), admission = node("select");
  admission.name = "admission-policy"; admission.autocomplete = "off";
  for (const [value, label] of [["observe", "Observe costs"], ["deny-at-observed-limit", "Block when observed budget is exhausted or unknown"]]) { const choice = node("option", label); choice.value = value; admission.append(choice); }
  admission.style.maxWidth = "100%"; admissionLabel.append(admission); policyForm.append(admissionLabel); submit(policyForm, "Save reviewed budget");
  overrideForm.append(node("h3", "Temporary admission override"));
  const expiry = field(overrideForm, "Override duration, minutes; zero revokes", "number"), overrideReason = field(overrideForm, "Override reason"); expiry.min = "0"; expiry.max = "60"; expiry.value = "10"; expiry.required = overrideReason.required = true; submit(overrideForm, "Review and apply override");
  manager.append(reconcileForm, policyForm, overrideForm); manager.hidden = true;
  const currentAccount = () => {
    if (disposed || options.getAccountId() !== account) { dispose(); throw new Error("Cost account changed. Reload this view."); }
  };
  const format = (value: string | null) => value === null ? "Unknown" : /^(?:0|[1-9][0-9]{0,49})$/u.test(value) ? new Intl.NumberFormat().format(BigInt(value)) : "Unavailable";
  const manage = () => !disposed && options.canManage?.() === true;
  const disable = () => {
    for (const control of manager.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")) control.disabled = busy || !!pending;
    refresh.disabled = busy; retry.disabled = busy; retry.hidden = !pending; manager.hidden = !manage();
    discard.hidden = !dirty || !manage(); discard.disabled = busy || !!pending;
  };
  const render = (report: ProjectCostReport) => {
    currentAccount();
    if (report.protocol !== "clank-project-costs/1" || report.projectId !== projectId || report.month !== month) throw new Error("Cost response identity changed.");
    current = report;
    const snapshot = report.snapshot;
    status.textContent = `${report.status.replaceAll("-", " ")} · admission ${report.admission}`;
    summary.replaceChildren(node("p", snapshot ? `${snapshot.rateCard.currency} ${format(snapshot.amountMinor)} smallest currency units · known subtotal ${format(snapshot.knownAmountMinor)}` : "No reconciled cost measurements for this period."));
    components.replaceChildren();
    for (const component of snapshot?.components ?? []) {
      const labels = {storageByteMilliseconds: "Storage byte-milliseconds", transferBytes: "Measured transfer bytes", runtimeMilliseconds: "Measured runtime milliseconds"};
      components.append(node("dt", labels[component.meter]), node("dd", `${format(component.units)} units · ${format(component.amountMinor)} smallest currency units · ${component.complete ? "complete observed coverage" : "incomplete coverage"}`));
    }
    if (snapshot) summary.append(node("p", `Rate card ${snapshot.rateCard.id}, revision ${snapshot.rateCard.revision} · observed through ${new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(snapshot.observedUntil)} · ${snapshot.reason}`));
    if (report.override) summary.append(node("p", `Override ${report.override.active ? "active" : "inactive"}: ${report.override.reason}`));
    if (!dirty && !pending && !manager.contains(document.activeElement)) {
      policyVersion = report.policy?.version ?? 0; overrideVersion = report.override?.version ?? 0; overridePolicyVersion = report.policy?.version ?? 0;
      policyCurrency.value = report.policy?.currency ?? snapshot?.rateCard.currency ?? ""; limit.value = report.policy?.limitMinor ?? "";
      warning.value = String(report.policy?.warningPercent ?? 80); age.value = String(report.policy?.maxMeasurementAgeMs ?? 60_000); admission.value = report.policy?.admission ?? "observe";
    }
    disable();
  };
  const errorMessage = (error: unknown, mutation = false) => {
    const statusCode = error && typeof error === "object" ? Reflect.get(error, "status") : undefined;
    if ([401, 403, 404].includes(Number(statusCode))) { dispose(); return; }
    if (mutation && Number.isInteger(statusCode) && Number(statusCode) >= 400 && Number(statusCode) < 500) pending = undefined;
    status.textContent = pending ? "The acknowledgment is uncertain. Retry the unchanged operation before editing another intent." : "Costs could not be updated. Refresh current state and review the draft.";
    status.focus({preventScroll: true}); disable();
  };
  async function refreshView() {
    const token = ++generation;
    try {
      currentAccount();
      const report = await client.read(projectId, month); currentAccount(); if (token !== generation) return; render(report);
      const snapshots = await client.history(projectId, month); currentAccount(); if (token !== generation) return;
      history.replaceChildren(node("h3", "Retained reconciliations"));
      for (const snapshot of snapshots) history.append(node("p", `Revision ${snapshot.version}: ${snapshot.rateCard.currency} ${format(snapshot.amountMinor)} smallest currency units · ${snapshot.reason}`));
    } catch (error) { if (!disposed && token === generation) errorMessage(error); }
  }
  async function dispatch() {
    if (disposed || busy || !pending || !manage()) return;
    try {
      currentAccount(); busy = true; disable();
      const request = pending;
      if (request.kind === "reconcile") await client.reconcile(projectId, request.input as ProjectCostReconcileInput);
      else if (request.kind === "policy") await client.policy(projectId, request.input as ProjectCostPolicyInput);
      else await client.override(projectId, request.input as ProjectCostOverrideInput);
      currentAccount(); pending = undefined; dirty = false; await refreshView(); currentAccount();
      status.focus({preventScroll: true});
    } catch (error) { if (!disposed) errorMessage(error, true); }
    finally { busy = false; if (!disposed) disable(); }
  }
  policyForm.addEventListener("input", () => { dirty = true; disable(); }); overrideForm.addEventListener("input", () => { dirty = true; disable(); });
  reconcileForm.addEventListener("submit", event => {
    event.preventDefault(); if (disposed || options.getAccountId() !== account) { dispose(); return; } if (busy || pending || !current || !manage()) return;
    pending = {kind: "reconcile", input: {month, expectedVersion: current.snapshot?.version ?? 0, operationId: crypto.randomUUID(), reason: reconcileReason.value}}; void dispatch();
  });
  policyForm.addEventListener("submit", event => {
    event.preventDefault(); if (disposed || options.getAccountId() !== account) { dispose(); return; } if (busy || pending || !current || !manage()) return;
    if (!confirm("Apply this reviewed cost budget and admission policy?")) return;
    pending = {kind: "policy", input: {expectedVersion: policyVersion, operationId: crypto.randomUUID(), currency: policyCurrency.value, limitMinor: limit.value, warningPercent: Number(warning.value), admission: admission.value as ProjectCostPolicy["admission"], maxMeasurementAgeMs: Number(age.value), reason: policyReason.value}}; void dispatch();
  });
  overrideForm.addEventListener("submit", event => {
    event.preventDefault(); if (disposed || options.getAccountId() !== account) { dispose(); return; } if (busy || pending || !current || !manage()) return;
    if (!confirm("Apply this temporary admission override, or revoke it when duration is zero?")) return;
    const minutes = Number(expiry.value);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) { status.textContent = "Choose an override duration from zero through 60 minutes."; status.focus(); return; }
    pending = {kind: "override", input: {expectedVersion: overrideVersion, policyVersion: overridePolicyVersion, operationId: crypto.randomUUID(), expiresAt: minutes === 0 ? 0 : Date.now() + minutes * 60_000, reason: overrideReason.value}}; void dispatch();
  });
  refresh.addEventListener("click", () => { void refreshView(); }); retry.addEventListener("click", () => { void dispatch(); });
  discard.addEventListener("click", () => {
    if (disposed || options.getAccountId() !== account) { dispose(); return; }
    if (busy || pending || !manage() || !confirm("Discard this draft and load the current budget policy?")) return;
    dirty = false; policyReason.value = ""; overrideReason.value = "";
    // Move focus before loading so the refreshed version can replace this draft.
    status.focus({preventScroll: true}); disable(); void refreshView();
  });
  const timer = setInterval(() => { if (!disposed && !busy) void refreshView(); }, 5_000);
  const beforeLeave = (event: BeforeUnloadEvent) => {
    if (!disposed && (dirty || pending)) { event.preventDefault(); event.returnValue = ""; }
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeLeave);
  function dispose() {
    if (disposed) return; disposed = true; generation++; clearInterval(timer); pending = undefined; current = null;
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeLeave);
    for (const control of manager.querySelectorAll<HTMLInputElement>("input")) control.value = "";
    summary.replaceChildren(); components.replaceChildren(); history.replaceChildren(); status.textContent = ""; root.replaceChildren();
  }
  void refreshView();
  return {get disposed() { return disposed; }, refresh: refreshView, hasPendingChanges: () => !disposed && (dirty || !!pending), dispose};
}
