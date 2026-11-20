import type { ErrorInboxSnapshot } from "./error-inbox.js";
import type { DatabaseQueryDiagnostic, QueryAdvice } from "./query-advisor.js";
import type { AgentActivitySnapshot } from "./agent-activity.js";
import type { TraceTimelineSnapshot } from "./trace-timeline.js";
import type { ReactiveDiagnostic, Cleanup } from "./core.js";
import type { QueryDiagnostic } from "./backend.js";
import type { HydrationDiagnostic } from "./hydration-inspection.js";
import type { ServerHandle } from "./node.js";
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
export declare function createDevtools(options?: { maxEvents?: number; hydration?: boolean; errorInbox?: () => ErrorInboxSnapshot; queries?: () => readonly QueryDiagnostic[]; databaseQueries?: () => readonly DatabaseQueryDiagnostic[]; agentActivity?: () => AgentActivitySnapshot; timeline?: () => TraceTimelineSnapshot }): ClankDevtools;
/** Deterministic structural export, excluding the other DevTools sources and extra fields. */
export declare function exportHydrationSnapshot(snapshot: DevtoolsSnapshot): string;
export declare function renderDevtools(snapshot: DevtoolsSnapshot): string;
export declare function mountDevtools(container: HTMLElement, inspector: ClankDevtools): Cleanup;
export declare function serveDevtools(inspector: ClankDevtools, options?: { port?: number }): Promise<ServerHandle>;
