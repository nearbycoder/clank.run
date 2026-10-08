import { untrack, type Cleanup } from "./core.ts";
import { VNODE, setHydrationInspectionFactory, type VNode, type HydrationInspection } from "./dom.ts";

export interface HydrationSource { readonly file: string; readonly line: number; readonly column: number; }
export type HydrationReason = "element-type" | "text-node" | "text-content" | "marker" | "trailing-nodes" | "client-node" | "async-view" | "keyed-value";
export interface HydrationNodeShape { readonly kind: "missing" | "element" | "text" | "comment" | "other"; readonly tag?: string; readonly marker?: string; }
export interface HydrationDiagnostic {
  readonly hydrationId: number; readonly reason: HydrationReason; readonly outcome: "patch" | "remount";
  /** Child indices from the hydration root, before abandoned attachments are cleaned up. */
  readonly path: readonly number[]; readonly pathTruncated: boolean;
  readonly expected: HydrationNodeShape; readonly actual: HydrationNodeShape;
  readonly component?: string; readonly source?: HydrationSource;
}

const hydrationListeners = new Set<(event: HydrationDiagnostic) => void>();
let nextHydrationId = 0, reportingHydration = false;
/** Opt-in structural metadata; never retains DOM nodes, props, attributes or rendered text. */
export function observeHydration(listener: (event: HydrationDiagnostic) => void): Cleanup {
  if (typeof listener !== "function" || hydrationListeners.size >= 100) throw new TypeError("Hydration inspection requires a listener and permits at most 100 listeners.");
  hydrationListeners.add(listener);
  if (hydrationListeners.size === 1) setHydrationInspectionFactory(createInspection);
  return () => { hydrationListeners.delete(listener); if (!hydrationListeners.size) setHydrationInspectionFactory(undefined); };
}
/** Annotate a VNode without changing props or rendering. Paths are reduced to a file basename. */
export function withHydrationSource(vnode: VNode, source: HydrationSource): VNode {
  if ((!vnode || vnode[VNODE] !== true) || !source || typeof source.file !== "string" || source.file.length > 4096 || !Number.isSafeInteger(source.line) || source.line < 1 || source.line > 10000000 || !Number.isSafeInteger(source.column) || source.column < 1 || source.column > 10000000) throw new TypeError("Invalid hydration source location.");
  const file = source.file.split(/[\\/]/u).at(-1) ?? "";
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(file)) throw new TypeError("Hydration source requires a bounded file basename.");
  return { ...vnode, source: Object.freeze({ file, line: source.line, column: source.column }) };
}


const hydrationTags = new Set("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption circle clipPath code col colgroup data datalist dd defs del details dfn dialog div dl dt ellipse em embed fieldset figcaption figure footer foreignObject form g h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe image img input ins kbd label legend li line linearGradient link main map mark mask menu meta meter nav noscript object ol optgroup option output p path pattern picture polygon polyline pre progress q radialGradient rect rp rt ruby s samp script section select slot small source span stop strong style sub summary sup svg table tbody td template text textarea tfoot th thead time title tr track tspan u ul use var video wbr".split(" "));
const hydrationMarkers = new Set(["clank", "clank:start", "clank:end", "clank:for", "clank:/for", "clank:portal", "clank:/portal"]);
function nodeShape(parent: Node, node: Node | null): HydrationNodeShape {
  if (!node) return Object.freeze({ kind: "missing" });
  const realm = (parent.nodeType === 9 ? parent as Document : parent.ownerDocument)?.defaultView ?? globalThis;
  if (node.nodeType === 1 || (realm.Element && node instanceof realm.Element)) { const tag = (node as Element).localName; return Object.freeze({ kind: "element", tag: hydrationTags.has(tag) ? tag : "custom" }); }
  if (node.nodeType === 3 || (realm.Text && node instanceof realm.Text)) return Object.freeze({ kind: "text" });
  if (node.nodeType === 8 || (realm.Comment && node instanceof realm.Comment)) { const marker = (node as Comment).data; return Object.freeze({ kind: "comment", ...(hydrationMarkers.has(marker) ? { marker } : {}) }); }
  return Object.freeze({ kind: "other" });
}
function hydrationDiagnostic(parent: Node, node: Node | null, inspection: HydrationInspection & { root: Element; id: number }, reason: HydrationReason, expected: HydrationNodeShape, outcome: "patch" | "remount", source?: HydrationSource, component?: string): void {
  if (!inspection?.active || !hydrationListeners.size || reportingHydration) return;
  const path: number[] = [];
  let current = node, owner: Node | null = parent, truncated = false;
  if (!current) { path.push(Math.min(parent.childNodes.length, 10000)); truncated = parent.childNodes.length > 10000; current = parent; owner = current.parentNode; }
  while (current && current !== inspection.root && path.length < 32) {
    if (!owner) { truncated = true; break; }
    let index = 0;
    while (index < owner.childNodes.length && index < 10000 && owner.childNodes[index] !== current) index++;
    if (owner.childNodes[index] !== current) { truncated = true; break; }
    path.push(index); current = owner; owner = current.parentNode;
  }
  if (current !== inspection.root) truncated = true;
  const event: HydrationDiagnostic = Object.freeze({ hydrationId: inspection.id, reason, outcome, path: Object.freeze(path.reverse()), pathTruncated: truncated, expected: Object.freeze({ ...expected, ...(expected.kind === "element" ? { tag: hydrationTags.has(expected.tag ?? "") ? expected.tag : "custom" } : {}) }), actual: nodeShape(parent, node), ...(component ? { component } : {}), ...(source ? { source } : {}) });
  reportingHydration = true;
  try { untrack(() => { for (const listener of [...hydrationListeners]) { try { listener(event); } catch { /* Inspection cannot break hydration. */ } } }); }
  finally { reportingHydration = false; }
}

function createInspection(root: Element): HydrationInspection {
  const inspection = { root, id: ++nextHydrationId, active: true,
    report(parent: Node, node: Node | null, code: number, detail?: string, source?: HydrationSource, component?: string) {
      // The small DOM hook uses these fixed codes; public reports expose named reasons.
      const reasons: HydrationReason[] = ["element-type", "text-node", "text-content", "marker", "trailing-nodes", "client-node", "async-view", "keyed-value"];
      const expected: HydrationNodeShape = code === 0 ? { kind: "element", tag: detail } : code === 1 || code === 2 ? { kind: "text" } : code === 3 ? { kind: "comment", marker: detail } : code === 4 ? { kind: "missing" } : { kind: "other" };
      hydrationDiagnostic(parent, node, inspection, reasons[code], expected, code === 2 ? "patch" : "remount", source, component);
    },
    source(vnode: VNode): HydrationSource | undefined { try { return untrack(() => vnode.source ? withHydrationSource(vnode, vnode.source).source : undefined); } catch { return undefined; } },
    component(type: Function): string | undefined { try { const name = untrack(() => type.name); return /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u.test(name) ? name : undefined; } catch { return undefined; } },
  };
  return inspection;
}
