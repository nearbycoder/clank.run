import { renderTraceTimeline, type TraceTimelineSnapshot } from "./trace-timeline.js";
import type { ReactiveDiagnostic, Cleanup } from "./core.js";
import type { QueryDiagnostic } from "./backend.js";
import type { ServerHandle } from "./node.js";
export interface DevtoolsSnapshot {
    readonly protocol: "clank-devtools/1";
  readonly timeline?: TraceTimelineSnapshot;
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
export declare function createDevtools(options?: { maxEvents?: number; queries?: () => readonly QueryDiagnostic[]; timeline?: () => TraceTimelineSnapshot }): ClankDevtools;
export declare function renderDevtools(snapshot: DevtoolsSnapshot): string;
export declare function mountDevtools(container: HTMLElement, inspector: ClankDevtools): Cleanup;
export declare function serveDevtools(inspector: ClankDevtools, options?: { port?: number }): Promise<ServerHandle>;
