export interface ApplicationBudgets { readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationResource { readonly resource: string; readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationPolicyCheck { readonly name: string; readonly actual: number; readonly maximum: number; readonly passed: boolean; }
export interface ApplicationPerformanceOptions {
  pageId?: string; baseline?: unknown;
  maxLoadTimeMs?: number;
  resourceBudgets?: readonly { resource: string; maxBytes?: number; maxRequests?: number }[];
  regressionBudgets?: Partial<Record<keyof ApplicationBudgets, { absolute?: number; percent?: number }>>;
}
export interface ApplicationResourceGroup extends ApplicationBudgets { readonly group: string; }
export interface ApplicationPerformanceReport {
  readonly protocol: "clank-application-performance/1";
  readonly ok: boolean;
  readonly measurements: ApplicationBudgets;
  readonly loadTimeMs: number;
  readonly policyChecks: readonly ApplicationPolicyCheck[];
  readonly duplicateResources: readonly ApplicationResource[];
  readonly origins: readonly ApplicationResourceGroup[];
  readonly resourceTypes: readonly ApplicationResourceGroup[];
  readonly checks: readonly { readonly name: keyof ApplicationBudgets; readonly actual: number; readonly maximum: number; readonly passed: boolean }[];
  readonly resources: readonly ApplicationResource[];
  readonly changes: readonly (ApplicationResource & { readonly previousBytes: number; readonly deltaBytes: number })[];
  readonly issues: readonly string[];
}

/** Evaluate a single cold-navigation HAR capture. No headers, bodies, cookies or URL queries are retained. */
export function assessApplicationPerformance(har: unknown, budgets: ApplicationBudgets, options: ApplicationPerformanceOptions = {}): ApplicationPerformanceReport {
  const keys = ["requests", "bodyBytes", "javascriptBytes", "cssBytes"] as const;
  for (const key of keys) if (!Number.isSafeInteger(budgets?.[key]) || budgets[key] < 0) throw new TypeError(`Invalid application budget: ${key}`);
  if (options.maxLoadTimeMs !== undefined && (!Number.isFinite(options.maxLoadTimeMs) || options.maxLoadTimeMs < 0)) throw new TypeError("Invalid load-time budget.");
  if (options.resourceBudgets !== undefined && (!Array.isArray(options.resourceBudgets) || options.resourceBudgets.length > 100)) throw new TypeError("Declare at most 100 resource budgets.");
  const budgetedResources = new Set<string>();
  for (const rule of options.resourceBudgets ?? []) {
    let url: URL;
    try { url = new URL(rule.resource); } catch { throw new TypeError("Invalid resource budget URL."); }
    if (!/^https?:$/.test(url.protocol) || rule.resource.length > 4096 || rule.resource !== `${url.origin}${url.pathname}` || budgetedResources.has(rule.resource)
      || (rule.maxBytes === undefined && rule.maxRequests === undefined)
      || [rule.maxBytes, rule.maxRequests].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new TypeError("Invalid resource budget.");
    budgetedResources.add(rule.resource);
  }
  if (options.regressionBudgets !== undefined) {
    if (!options.regressionBudgets || typeof options.regressionBudgets !== "object" || Array.isArray(options.regressionBudgets) || options.baseline === undefined) throw new TypeError("Regression budgets require a baseline.");
    for (const [name, rule] of Object.entries(options.regressionBudgets)) {
      if (!(keys as readonly string[]).includes(name) || !rule || (rule.absolute === undefined && rule.percent === undefined)
        || (rule.absolute !== undefined && (!Number.isSafeInteger(rule.absolute) || rule.absolute < 0))
        || (rule.percent !== undefined && (!Number.isFinite(rule.percent) || rule.percent < 0 || rule.percent > 10000))) throw new TypeError("Invalid regression budget.");
    }
  }
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
  const policyChecks: ApplicationPolicyCheck[] = [];
  const check = (name: string, actual: number, maximum: number) => policyChecks.push(Object.freeze({ name, actual, maximum, passed: !issues.length && Number.isFinite(actual) && Number.isFinite(maximum) && actual <= maximum }));
  if (options.maxLoadTimeMs !== undefined) check("loadTimeMs", current.loadTimeMs, options.maxLoadTimeMs);
  for (const rule of options.resourceBudgets ?? []) {
    const item = after.get(rule.resource);
    if (rule.maxBytes !== undefined) check(`resourceBytes:${rule.resource}`, item?.bodyBytes ?? 0, rule.maxBytes);
    if (rule.maxRequests !== undefined) check(`resourceRequests:${rule.resource}`, item?.requests ?? 0, rule.maxRequests);
  }
  for (const name of keys) {
    const rule = options.regressionBudgets?.[name]; if (!rule || !previous) continue;
    const delta = current.measurements[name] - previous.measurements[name];
    if (rule.absolute !== undefined) check(`regressionAbsolute:${name}`, delta, rule.absolute);
    // A zero baseline allows no growth under a percentage-only policy.
    if (rule.percent !== undefined) check(`regressionPercent:${name}`, delta, previous.measurements[name] * (rule.percent / 100));
  }
  return Object.freeze({ protocol: "clank-application-performance/1", ok: [...checks, ...policyChecks].every((check) => check.passed), measurements: Object.freeze(current.measurements),
    loadTimeMs: current.loadTimeMs, policyChecks: Object.freeze(policyChecks), duplicateResources: Object.freeze(current.resources.filter(item => item.requests > 1)),
    origins: Object.freeze(current.origins), resourceTypes: Object.freeze(current.resourceTypes), checks: Object.freeze(checks), resources: Object.freeze(current.resources), changes: Object.freeze(changes), issues: Object.freeze(issues) });
}

function capture(input: unknown, pageId?: string) {
  const log = (input as any)?.log;
  if (!Array.isArray(log?.pages) || !Array.isArray(log?.entries) || log.pages.length > 100 || log.entries.length > 50_000) throw new TypeError("Expected a bounded HAR with pages and entries.");
  const pages = pageId === undefined ? log.pages : log.pages.filter((page: any) => page?.id === pageId);
  if (pages.length !== 1 || typeof pages[0]?.id !== "string") throw new TypeError("Select exactly one HAR page with --page=<id>.");
  const page = pages[0];
  if (page.id.length > 256) throw new TypeError("HAR page ID exceeds its limit.");
  const start = Date.parse(page.startedDateTime);
  const duration = page.pageTimings?.onLoad;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0) throw new TypeError("HAR page needs a completed onLoad measurement.");
  const measurements = { requests: 0, bodyBytes: 0, javascriptBytes: 0, cssBytes: 0 };
  const resources = new Map<string, ApplicationResource>();
  const issues: string[] = [], seenIssues = new Set<string>();
  const issue = (message: string) => {
    if (seenIssues.has(message)) return;
    if (issues.length < 100) { seenIssues.add(message); issues.push(message); }
    else if (issues.length === 100) issues.push("Additional capture issues omitted.");
  };
  const origins = new Map<string, ApplicationBudgets>(), resourceTypes = new Map<string, ApplicationBudgets>();
  const addGroup = (groups: Map<string, ApplicationBudgets>, group: string, value: ApplicationBudgets) => {
    const old = groups.get(group);
    groups.set(group, { requests: (old?.requests ?? 0) + value.requests, bodyBytes: (old?.bodyBytes ?? 0) + value.bodyBytes,
      javascriptBytes: (old?.javascriptBytes ?? 0) + value.javascriptBytes, cssBytes: (old?.cssBytes ?? 0) + value.cssBytes });
  };
  let urlBytes = 0;
  let documents = 0;
  for (const entry of log.entries) {
    if (!entry || entry.pageref === undefined) { issue("An entry lacks a page reference; capture completeness is unknown."); continue; }
    if (entry.pageref !== page.id) continue;
    const at = Date.parse(entry.startedDateTime);
    if (!Number.isFinite(at)) { issue("An entry has an invalid start time."); continue; }
    if (at < start) { issue("An entry predates the selected navigation."); continue; }
    if (at > start + duration) continue;
    if (typeof entry.request?.url !== "string" || entry.request.url.length > 4096) { issue("An entry has an oversized or invalid URL."); continue; }
    urlBytes += entry.request.url.length;
    if (urlBytes > 8 * 1024 * 1024) throw new TypeError("HAR resource URLs exceed the capture limit.");
    let url: URL;
    try { url = new URL(entry.request?.url); } catch { issue("An entry has an invalid URL."); continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") { issue("An entry is not an HTTP resource."); continue; }
    const resource = `${url.origin}${url.pathname}`;
    const response = entry.response;
    const bytes = response?.bodySize;
    const rawMime = response?.content?.mimeType;
    if (rawMime !== undefined && (typeof rawMime !== "string" || rawMime.length > 256)) { issue("An entry has an invalid content type."); continue; }
    const mime = (rawMime ?? "").split(";", 1)[0]!.trim().toLowerCase();
    measurements.requests++;
    if (mime === "text/html" && response?.status >= 200 && response.status < 300) documents++;
    if (!Number.isSafeInteger(bytes) || bytes < 0) { issue(`${resource}: unknown response body size.`); continue; }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 400) issue(`${resource}: unsuccessful response.`);
    if (response?.status === 304 || entry._fromCache || entry._fromServiceWorker || response?._fromCache || response?._fromServiceWorker) issue(`${resource}: cached response; use a cold navigation.`);
    if (!mime && bytes > 0) issue(`${resource}: unknown content type.`);
    const javascriptBytes = /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(mime) ? bytes : 0;
    const cssBytes = mime === "text/css" ? bytes : 0;
    measurements.bodyBytes += bytes;
    measurements.javascriptBytes += javascriptBytes;
    measurements.cssBytes += cssBytes;
    const values = { requests: 1, bodyBytes: bytes, javascriptBytes, cssBytes };
    addGroup(origins, url.origin, values);
    const type = javascriptBytes || /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(mime) ? "javascript" : mime === "text/css" ? "css" : mime === "text/html" ? "html" : mime.startsWith("image/") ? "image" : mime.startsWith("font/") || /^(?:application\/(?:font-woff|vnd.ms-fontobject|x-font-ttf|x-font-opentype))$/.test(mime) ? "font" : /^(?:audio|video)\//.test(mime) ? "media" : "other";
    addGroup(resourceTypes, type, values);
    const old = resources.get(resource);
    resources.set(resource, { resource, requests: (old?.requests ?? 0) + 1, bodyBytes: (old?.bodyBytes ?? 0) + bytes, javascriptBytes: (old?.javascriptBytes ?? 0) + javascriptBytes, cssBytes: (old?.cssBytes ?? 0) + cssBytes });
  }
  if (!documents) issue("No successful HTML document was captured.");
  if (Object.values(measurements).some((value) => !Number.isSafeInteger(value))) issue("Capture totals exceed safe integer limits.");
  const groups = (values: Map<string, ApplicationBudgets>) => [...values].map(([group, value]) => Object.freeze({ group, ...value })).sort((a, b) => b.bodyBytes - a.bodyBytes || a.group.localeCompare(b.group));
  return { measurements, loadTimeMs: duration, origins: groups(origins), resourceTypes: groups(resourceTypes), resources: [...resources.values()].sort((a, b) => b.bodyBytes - a.bodyBytes || a.resource.localeCompare(b.resource)).map(resource => Object.freeze(resource)), issues: [...new Set(issues)] };
}
