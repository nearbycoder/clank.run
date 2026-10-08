import { renderErrorInbox, type ErrorInboxSnapshot } from "./error-inbox.ts";
import { adviseQueries, type DatabaseQueryDiagnostic, type QueryAdvice } from "./query-advisor.ts";
import { renderAgentActivity, type AgentActivitySnapshot } from "./agent-activity.ts";
import { renderTraceTimeline, type TraceTimelineSnapshot } from "./trace-timeline.ts";
import { observeReactivity, type ReactiveDiagnostic, type Cleanup } from "./core.ts";
import type { QueryDiagnostic } from "./backend.ts";
import { observeHydration, type HydrationDiagnostic } from "./hydration-inspection.ts";

export interface DevtoolsSnapshot {
  readonly protocol: "clank-devtools/1";
  readonly errorInbox?: ErrorInboxSnapshot;
  readonly timeline?: TraceTimelineSnapshot;
  readonly agentActivity?: AgentActivitySnapshot;
  readonly events: readonly ReactiveDiagnostic[];
  readonly active: readonly ReactiveDiagnostic[];
  readonly queries: readonly QueryDiagnostic[];
  readonly queryAdvice?: readonly QueryAdvice[];
  readonly hydration?: readonly HydrationDiagnostic[];
  readonly truncated: boolean;
}
export interface ClankDevtools {
  snapshot(): DevtoolsSnapshot;
  clear(): void;
  dispose(): void;
}

/** Metadata-only, bounded inspection. Create before mounting the code being inspected. */
export function createDevtools(options: { maxEvents?: number; hydration?: boolean; errorInbox?: () => ErrorInboxSnapshot; queries?: () => readonly QueryDiagnostic[]; databaseQueries?: () => readonly DatabaseQueryDiagnostic[]; agentActivity?: () => AgentActivitySnapshot; timeline?: () => TraceTimelineSnapshot } = {}): ClankDevtools {
  const maximum = options.maxEvents ?? 500;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5_000) throw new TypeError("DevTools maxEvents must be 1–5000.");
  if (options.hydration !== undefined && typeof options.hydration !== "boolean") throw new TypeError("DevTools hydration inspection must be a boolean.");
  const events: ReactiveDiagnostic[] = [];
  const active = new Map<number, ReactiveDiagnostic>();
  let truncated = false;
  let disposed = false;
  const hydration: HydrationDiagnostic[] = [];
  const stopHydration = options.hydration ? observeHydration(event => {
    hydration.push(event);
    if (hydration.length > maximum) { hydration.shift(); truncated = true; }
    if (event.pathTruncated) truncated = true;
  }) : () => {};
  const stop = observeReactivity((event) => {
    events.push(event);
    if (events.length > maximum) { events.shift(); truncated = true; }
    if (event.type === "dispose") active.delete(event.id);
    else if (event.kind !== "signal") {
      active.set(event.id, event);
      if (active.size > maximum) { active.delete(active.keys().next().value!); truncated = true; }
    }
  });
  return {
    snapshot() {
      // Only declared fields cross the inspection boundary, even with a custom query source.
      const queries = disposed ? [] : (options.queries?.() ?? []).slice(0, 500).map((query) => Object.freeze({
        path: String(query.path).slice(0, 256), runs: count(query.runs), cacheHits: count(query.cacheHits),
        durationMs: count(query.durationMs), lastInvalidation: query.lastInvalidation === null ? null : String(query.lastInvalidation).slice(0, 256),
        cachedEntries: count(query.cachedEntries), subscriptions: count(query.subscriptions),
      }));
      return Object.freeze({ protocol: "clank-devtools/1" as const, events: Object.freeze([...events]),
        active: Object.freeze([...active.values()]), queries: Object.freeze(queries), truncated,
        ...(options.hydration ? { hydration: Object.freeze([...hydration]) } : {}),
        ...(!disposed && options.databaseQueries ? { queryAdvice: adviseQueries(options.databaseQueries()) } : {}),
        ...(!disposed && options.agentActivity ? { agentActivity: options.agentActivity() } : {}),
        ...(!disposed && options.errorInbox ? { errorInbox: options.errorInbox() } : {}),
        ...(!disposed && options.timeline ? { timeline: options.timeline() } : {}) });
    },
    clear() { events.length = hydration.length = 0; truncated = false; },
    dispose() { disposed = true; stop(); stopHydration(); events.length = hydration.length = 0; active.clear(); },
  };
}

function count(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }
function escape(value: unknown): string { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }

/** Deterministic structural export, excluding the other DevTools sources and extra fields. */
export function exportHydrationSnapshot(snapshot: DevtoolsSnapshot): string {
  const reasons = new Set(["element-type", "text-node", "text-content", "marker", "trailing-nodes", "client-node", "async-view", "keyed-value"]);
  const kinds = new Set(["missing", "element", "text", "comment", "other"]), markers = new Set(["clank", "clank:start", "clank:end", "clank:for", "clank:/for", "clank:portal", "clank:/portal"]);
  const shape = (value: HydrationDiagnostic["actual"]) => {
    if (!value || !kinds.has(value.kind)) throw new TypeError("Invalid hydration node shape.");
    return { kind: value.kind, ...(value.kind === "element" && typeof value.tag === "string" && /^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(value.tag) ? { tag: value.tag } : {}), ...(value.kind === "comment" && markers.has(value.marker ?? "") ? { marker: value.marker } : {}) };
  };
  const entries = snapshot.hydration ?? [];
  if (!Array.isArray(entries) || entries.length > 5000) throw new TypeError("Hydration snapshot must contain at most 5000 entries.");
  const mismatches = entries.map(event => {
    if (!event || !Number.isSafeInteger(event.hydrationId) || event.hydrationId < 1 || !reasons.has(event.reason) || !["patch", "remount"].includes(event.outcome) || !Array.isArray(event.path) || event.path.length > 32 || event.path.some((index: number) => !Number.isSafeInteger(index) || index < 0 || index > 10000) || typeof event.pathTruncated !== "boolean") throw new TypeError("Invalid hydration snapshot entry.");
    const source = event.source;
    if (source && (!/^[A-Za-z0-9_.-]{1,128}$/u.test(source.file) || !Number.isSafeInteger(source.line) || source.line < 1 || source.line > 10000000 || !Number.isSafeInteger(source.column) || source.column < 1 || source.column > 10000000)) throw new TypeError("Invalid hydration source location.");
    return { hydrationId: event.hydrationId, reason: event.reason, outcome: event.outcome, path: [...event.path], pathTruncated: event.pathTruncated, expected: shape(event.expected), actual: shape(event.actual), ...(typeof event.component === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u.test(event.component) ? { component: event.component } : {}), ...(source ? { source: { file: source.file, line: source.line, column: source.column } } : {}) };
  });
  return JSON.stringify({ protocol: "clank-hydration-snapshot/1", mismatches, truncated: Boolean(snapshot.truncated) }, null, 2);
}

/** Static HTML can be embedded in an existing, appropriately authorized development workbench. */
export function renderDevtools(snapshot: DevtoolsSnapshot): string {
  const rows = (values: readonly (readonly unknown[])[]) => values.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("");
  return `<section aria-label="Clank DevTools"><h1>Clank DevTools</h1><p>Local metadata · ${escape(snapshot.active.length)} observed active computations · ${escape(snapshot.queries.reduce((sum, query) => sum + count(query.subscriptions), 0))} query subscriptions</p>${snapshot.truncated ? "<p role=\"status\">History or active entries exceeded the inspection limit. This is a partial view.</p>" : ""}
    <h2>Queries</h2><div class="scroll"><table><thead><tr><th>Query</th><th>Runs</th><th>Cache hits</th><th>Last run (ms)</th><th>Subscriptions</th><th>Last invalidation</th></tr></thead><tbody>${rows(snapshot.queries.map((query) => [query.path, query.runs, query.cacheHits, query.durationMs.toFixed(2), query.subscriptions, query.lastInvalidation ?? "None"]))}</tbody></table></div>
    ${snapshot.queryAdvice ? `<h2>Database query advisor</h2><p>Bound values and returned data are excluded. Index suggestions require review.</p>${snapshot.queryAdvice.map(({ query, findings }) => `<article aria-label="${escape(query.table)} query" style="border-top:1px solid #444;padding:16px 0;overflow-wrap:anywhere"><h3>${escape(query.table)}</h3><p>${escape(query.runs)} runs · ${escape(query.rows)} returned rows · ${escape(query.totalMs.toFixed(2))} ms total · ${escape(query.maximumMs.toFixed(2))} ms maximum</p><p>${escape(query.plan.join("; "))}</p><ul>${findings.map((finding) => `<li>${escape(finding)}</li>`).join("")}</ul><details><summary>SQL shape and candidate index</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(query.sql)}</pre>${query.suggestedIndex ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(query.suggestedIndex)}</pre>` : "<p>No candidate index suggested.</p>"}</details></article>`).join("")}` : ""}
    ${snapshot.hydration ? `<h2>Hydration mismatches</h2><p>Structural metadata only. Paths are child indices before hydration cleanup; rendered values and attributes are excluded.</p><div class="scroll"><table><thead><tr><th>Reason</th><th>Outcome</th><th>Path</th><th>Expected / actual</th><th>Component</th><th>Source</th></tr></thead><tbody>${rows(snapshot.hydration.map(event => [event.reason, event.outcome, event.path.join(".") || "root", `${event.expected.kind}${event.expected.tag ? ` ${event.expected.tag}` : ""} / ${event.actual.kind}${event.actual.tag ? ` ${event.actual.tag}` : ""}`, event.component ?? "—", event.source ? `${event.source.file}:${event.source.line}:${event.source.column}` : "Unannotated"]))}</tbody></table></div>` : ""}
    <h2>Reactive activity</h2><p>Observed since inspection started. Signal values and query data are excluded.</p><div class="scroll"><table><thead><tr><th>Event</th><th>Computation</th><th>Source</th><th>Dependencies</th><th>Duration (ms)</th></tr></thead><tbody>${rows([...snapshot.events].reverse().map((event) => [event.type, `${event.name ?? event.kind} #${event.id}`, event.sourceId === undefined ? "—" : `#${event.sourceId}`, event.dependencies ?? "—", event.durationMs?.toFixed(2) ?? "—"]))}</tbody></table></div>${snapshot.errorInbox ? renderErrorInbox(snapshot.errorInbox) : ""}${snapshot.timeline ? renderTraceTimeline(snapshot.timeline) : ""}${snapshot.agentActivity ? renderAgentActivity(snapshot.agentActivity) : ""}</section>`;
}

/** Mount a browser-local inspector. The returned cleanup releases its listener and elements. */
export function mountDevtools(container: HTMLElement, inspector: ClankDevtools): Cleanup {
  const panel = container.ownerDocument.createElement("aside");
  panel.setAttribute("aria-label", "Local development inspector");
  const refresh = container.ownerDocument.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh DevTools";
  const content = container.ownerDocument.createElement("div");
  let stopExport = () => {};
  const update = () => { content.innerHTML = renderDevtools(inspector.snapshot()); };
  refresh.addEventListener("click", update);
  panel.append(refresh, content);
  if (inspector.snapshot().hydration) {
    const exportButton = container.ownerDocument.createElement("button"), output = container.ownerDocument.createElement("textarea");
    exportButton.type = "button"; exportButton.textContent = "Export hydration snapshot"; output.readOnly = true; output.hidden = true; output.setAttribute("aria-label", "Hydration snapshot JSON");
    output.style.width = "100%"; output.style.boxSizing = "border-box";
    const exportSnapshot = () => { output.value = exportHydrationSnapshot(inspector.snapshot()); output.hidden = false; output.focus(); output.select(); };
    exportButton.addEventListener("click", exportSnapshot); panel.append(exportButton, output);
    stopExport = () => { exportButton.removeEventListener("click", exportSnapshot); output.value = ""; };
  }
  container.append(panel);
  update();
  return () => { refresh.removeEventListener("click", update); stopExport(); panel.remove(); };
}

/** Serves only on IPv4 loopback. Never attach this handler to a public application route. */
export async function serveDevtools(inspector: ClankDevtools, options: { port?: number } = {}) {
  const { serve } = await import("./node.ts");
  let origin = "";
  const server = await serve((request) => {
    const url = new URL(request.url);
    if (url.origin !== origin || (request.headers.has("origin") && request.headers.get("origin") !== origin)
      || request.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    const content = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clank DevTools</title><style>html{color-scheme:light dark}body{font:14px system-ui;max-width:1100px;margin:32px auto;padding:0 20px}h1{font-size:28px}h2{margin-top:32px}p{color:light-dark(#555,#aaa)}.scroll{overflow:auto}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #8885;white-space:nowrap}a{color:inherit}</style><body><a href="/">Refresh snapshot</a>${renderDevtools(inspector.snapshot())}</body></html>`;
    return new Response(request.method === "HEAD" ? null : content, { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    } });
  }, { hostname: "127.0.0.1", port: options.port ?? 0 });
  origin = server.url;
  return server;
}
