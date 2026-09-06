import { observeReactivity, type ReactiveDiagnostic, type Cleanup } from "./core.ts";
import type { QueryDiagnostic } from "./backend.ts";

export interface DevtoolsSnapshot {
  readonly protocol: "clank-devtools/1";
  readonly events: readonly ReactiveDiagnostic[];
  readonly active: readonly ReactiveDiagnostic[];
  readonly queries: readonly QueryDiagnostic[];
  readonly truncated: boolean;
}
export interface ClankDevtools {
  snapshot(): DevtoolsSnapshot;
  clear(): void;
  dispose(): void;
}

/** Metadata-only, bounded inspection. Create before mounting the code being inspected. */
export function createDevtools(options: { maxEvents?: number; queries?: () => readonly QueryDiagnostic[] } = {}): ClankDevtools {
  const maximum = options.maxEvents ?? 500;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5_000) throw new TypeError("DevTools maxEvents must be 1–5000.");
  const events: ReactiveDiagnostic[] = [];
  const active = new Map<number, ReactiveDiagnostic>();
  let truncated = false;
  let disposed = false;
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
        active: Object.freeze([...active.values()]), queries: Object.freeze(queries), truncated });
    },
    clear() { events.length = 0; truncated = false; },
    dispose() { disposed = true; stop(); events.length = 0; active.clear(); },
  };
}

function count(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }
function escape(value: unknown): string { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }

/** Static HTML can be embedded in an existing, appropriately authorized development workbench. */
export function renderDevtools(snapshot: DevtoolsSnapshot): string {
  const rows = (values: readonly (readonly unknown[])[]) => values.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("");
  return `<section aria-label="Clank DevTools"><h1>Clank DevTools</h1><p>Local metadata · ${snapshot.active.length} observed active computations · ${snapshot.queries.reduce((sum, query) => sum + query.subscriptions, 0)} query subscriptions</p>${snapshot.truncated ? "<p role=\"status\">History or active entries exceeded the inspection limit. This is a partial view.</p>" : ""}
    <h2>Queries</h2><div class="scroll"><table><thead><tr><th>Query</th><th>Runs</th><th>Cache hits</th><th>Last run (ms)</th><th>Subscriptions</th><th>Last invalidation</th></tr></thead><tbody>${rows(snapshot.queries.map((query) => [query.path, query.runs, query.cacheHits, query.durationMs.toFixed(2), query.subscriptions, query.lastInvalidation ?? "None"]))}</tbody></table></div>
    <h2>Reactive activity</h2><p>Observed since inspection started. Signal values and query data are excluded.</p><div class="scroll"><table><thead><tr><th>Event</th><th>Computation</th><th>Source</th><th>Dependencies</th><th>Duration (ms)</th></tr></thead><tbody>${rows([...snapshot.events].reverse().map((event) => [event.type, `${event.name ?? event.kind} #${event.id}`, event.sourceId === undefined ? "—" : `#${event.sourceId}`, event.dependencies ?? "—", event.durationMs?.toFixed(2) ?? "—"]))}</tbody></table></div></section>`;
}

/** Mount a browser-local inspector. The returned cleanup releases its listener and elements. */
export function mountDevtools(container: HTMLElement, inspector: ClankDevtools): Cleanup {
  const panel = container.ownerDocument.createElement("aside");
  panel.setAttribute("aria-label", "Local development inspector");
  const refresh = container.ownerDocument.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh DevTools";
  const content = container.ownerDocument.createElement("div");
  const update = () => { content.innerHTML = renderDevtools(inspector.snapshot()); };
  refresh.addEventListener("click", update);
  panel.append(refresh, content);
  container.append(panel);
  update();
  return () => { refresh.removeEventListener("click", update); panel.remove(); };
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
