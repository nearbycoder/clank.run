import type { Cleanup } from "./core.js";
import type { VNode } from "./dom.js";
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


export declare function observeHydration(listener: (event: HydrationDiagnostic) => void): Cleanup;
export declare function withHydrationSource(vnode: VNode, source: HydrationSource): VNode;
