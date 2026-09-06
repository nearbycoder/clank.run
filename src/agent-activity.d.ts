import type { McpToolActivity } from "./mcp.js";
export interface AgentActivityOptions { maxEntries?: number; maxAgeMs?: number; }
export interface AgentActivity extends McpToolActivity {
  readonly id: number;
  /** Revisions observed around this call; concurrent processes may contribute within the range. */
  readonly beforeRevision: number | null;
  readonly afterRevision: number | null;
}
export interface AgentActivityFilter { tool?: string; outcome?: McpToolActivity["outcome"]; scope?: string; since?: number; }
export interface AgentActivitySnapshot { readonly protocol: "clank-agent-activity/1"; readonly events: readonly AgentActivity[]; readonly retainedLimit: number; }

export declare function renderAgentActivity(snapshot: AgentActivitySnapshot): string;
