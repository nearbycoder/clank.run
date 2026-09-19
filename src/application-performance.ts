export interface ApplicationBudgets { readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationResource { readonly resource: string; readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationPerformanceReport {
  readonly protocol: "clank-application-performance/1";
  readonly ok: boolean;
  readonly measurements: ApplicationBudgets;
  readonly checks: readonly { readonly name: keyof ApplicationBudgets; readonly actual: number; readonly maximum: number; readonly passed: boolean }[];
  readonly resources: readonly ApplicationResource[];
  readonly changes: readonly (ApplicationResource & { readonly previousBytes: number; readonly deltaBytes: number })[];
  readonly issues: readonly string[];
}

/** Evaluate a single cold-navigation HAR capture. No headers, bodies, cookies or URL queries are retained. */
export function assessApplicationPerformance(har: unknown, budgets: ApplicationBudgets, options: { pageId?: string; baseline?: unknown } = {}): ApplicationPerformanceReport {
  const keys = ["requests", "bodyBytes", "javascriptBytes", "cssBytes"] as const;
  for (const key of keys) if (!Number.isSafeInteger(budgets?.[key]) || budgets[key] < 0) throw new TypeError(`Invalid application budget: ${key}`);
  const current = capture(har, options.pageId);
  const previous = options.baseline === undefined ? undefined : capture(options.baseline, options.pageId);
  const issues = [...current.issues, ...(previous?.issues.map((issue) => `Baseline: ${issue}`) ?? [])];
  const checks = keys.map((name) => Object.freeze({ name, actual: current.measurements[name], maximum: budgets[name], passed: !issues.length && current.measurements[name] <= budgets[name] }));
  const before = new Map(previous?.resources.map((item) => [item.resource, item]));
  const after = new Map(current.resources.map((item) => [item.resource, item]));
  const changes = previous ? [...new Set([...before.keys(), ...after.keys()])].map((resource) => {
    const item = after.get(resource) ?? { resource, requests: 0, bodyBytes: 0, javascriptBytes: 0, cssBytes: 0 };
    const previousBytes = before.get(resource)?.bodyBytes ?? 0;
    return Object.freeze({ ...item, previousBytes, deltaBytes: item.bodyBytes - previousBytes });
  }).sort((a, b) => b.deltaBytes - a.deltaBytes || a.resource.localeCompare(b.resource)) : [];
  return Object.freeze({ protocol: "clank-application-performance/1", ok: checks.every((check) => check.passed), measurements: Object.freeze(current.measurements), checks: Object.freeze(checks), resources: Object.freeze(current.resources), changes: Object.freeze(changes), issues: Object.freeze(issues) });
}

function capture(input: unknown, pageId?: string) {
  const log = (input as any)?.log;
  if (!Array.isArray(log?.pages) || !Array.isArray(log?.entries) || log.pages.length > 100 || log.entries.length > 50_000) throw new TypeError("Expected a bounded HAR with pages and entries.");
  const pages = pageId === undefined ? log.pages : log.pages.filter((page: any) => page?.id === pageId);
  if (pages.length !== 1 || typeof pages[0]?.id !== "string") throw new TypeError("Select exactly one HAR page with --page=<id>.");
  const page = pages[0];
  const start = Date.parse(page.startedDateTime);
  const duration = page.pageTimings?.onLoad;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0) throw new TypeError("HAR page needs a completed onLoad measurement.");
  const measurements = { requests: 0, bodyBytes: 0, javascriptBytes: 0, cssBytes: 0 };
  const resources = new Map<string, ApplicationResource>();
  const issues: string[] = [];
  let documents = 0;
  for (const entry of log.entries) {
    if (!entry || entry.pageref === undefined) { issues.push("An entry lacks a page reference; capture completeness is unknown."); continue; }
    if (entry.pageref !== page.id) continue;
    const at = Date.parse(entry.startedDateTime);
    if (!Number.isFinite(at)) { issues.push("An entry has an invalid start time."); continue; }
    if (at > start + duration) continue;
    let url: URL;
    try { url = new URL(entry.request?.url); } catch { issues.push("An entry has an invalid URL."); continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") { issues.push("An entry is not an HTTP resource."); continue; }
    const resource = `${url.origin}${url.pathname}`;
    const response = entry.response;
    const bytes = response?.bodySize;
    const mime = String(response?.content?.mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
    measurements.requests++;
    if (mime === "text/html" && response?.status >= 200 && response.status < 300) documents++;
    if (!Number.isSafeInteger(bytes) || bytes < 0) { issues.push(`${resource}: unknown response body size.`); continue; }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 400) issues.push(`${resource}: unsuccessful response.`);
    if (response?.status === 304 || entry._fromCache || entry._fromServiceWorker || response?._fromCache || response?._fromServiceWorker) issues.push(`${resource}: cached response; use a cold navigation.`);
    if (!mime && bytes > 0) issues.push(`${resource}: unknown content type.`);
    const javascriptBytes = /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(mime) ? bytes : 0;
    const cssBytes = mime === "text/css" ? bytes : 0;
    measurements.bodyBytes += bytes;
    measurements.javascriptBytes += javascriptBytes;
    measurements.cssBytes += cssBytes;
    const old = resources.get(resource);
    resources.set(resource, { resource, requests: (old?.requests ?? 0) + 1, bodyBytes: (old?.bodyBytes ?? 0) + bytes, javascriptBytes: (old?.javascriptBytes ?? 0) + javascriptBytes, cssBytes: (old?.cssBytes ?? 0) + cssBytes });
  }
  if (!documents) issues.push("No successful HTML document was captured.");
  if (Object.values(measurements).some((value) => !Number.isSafeInteger(value))) issues.push("Capture totals exceed safe integer limits.");
  return { measurements, resources: [...resources.values()].sort((a, b) => b.bodyBytes - a.bodyBytes || a.resource.localeCompare(b.resource)).map(Object.freeze), issues: [...new Set(issues)] };
}
