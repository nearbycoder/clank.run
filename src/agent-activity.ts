import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
import type { SQLiteDatabase } from "./backend.ts";
import type { McpToolActivity } from "./mcp.ts";

export interface AgentActivityOptions { maxEntries?: number; maxAgeMs?: number; }
export interface AgentActivity extends McpToolActivity {
  readonly id: number;
  /** Revisions observed around this call; concurrent processes may contribute within the range. */
  readonly beforeRevision: number | null;
  readonly afterRevision: number | null;
}
export interface AgentActivityFilter { tool?: string; outcome?: McpToolActivity["outcome"]; scope?: string; since?: number; }
export interface AgentActivitySnapshot { readonly protocol: "clank-agent-activity/1"; readonly events: readonly AgentActivity[]; readonly retainedLimit: number; }

export function openAgentActivity(database: SQLiteDatabase<any>, options: AgentActivityOptions) {
  const maximum = options.maxEntries ?? 1000;
  const age = options.maxAgeMs ?? 7 * 86_400_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000 || !Number.isSafeInteger(age) || age < 1000 || age > 30 * 86_400_000) throw new TypeError("Invalid agent activity retention.");
  const sql = database[SQLITE_INTERNAL];
  sql.exec("CREATE TABLE IF NOT EXISTS clank_agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS clank_agent_activity_time ON clank_agent_activity(at)");
  const prune = () => {
    sql.prepare("DELETE FROM clank_agent_activity WHERE at < ?").run(Date.now() - age);
    sql.prepare("DELETE FROM clank_agent_activity WHERE id NOT IN (SELECT id FROM clank_agent_activity ORDER BY id DESC LIMIT ?)").run(maximum);
  };
  return {
    record(event: McpToolActivity, revisions?: { beforeRevision: number; afterRevision: number }) {
      // Copy only the public event schema; never serialize request/context/arguments by accident.
      const record = { tool: event.tool, requiredScope: event.requiredScope, scopes: [...event.scopes],
        outcome: event.outcome, startedAt: event.startedAt, durationMs: event.durationMs,
        beforeRevision: revisions?.beforeRevision ?? null, afterRevision: revisions?.afterRevision ?? null };
      sql.transaction(() => { sql.prepare("INSERT INTO clank_agent_activity(at, event) VALUES (?, ?)").run(event.startedAt, JSON.stringify(record)); prune(); });
    },
    snapshot(filter: AgentActivityFilter = {}): AgentActivitySnapshot {
      if (filter.since !== undefined && (!Number.isSafeInteger(filter.since) || filter.since < 0)) throw new TypeError("Invalid activity timestamp.");
      sql.transaction(prune);
      const rows = sql.prepare("SELECT id, event FROM clank_agent_activity ORDER BY id DESC LIMIT ?").all(maximum);
      const events = rows.map(row => ({ ...JSON.parse(String(row.event)), id: Number(row.id) }) as AgentActivity)
        .filter(event => (filter.tool === undefined || event.tool === filter.tool) && (filter.outcome === undefined || event.outcome === filter.outcome)
          && (filter.scope === undefined || event.scopes.includes(filter.scope)) && (filter.since === undefined || event.startedAt >= filter.since))
        .map(event => Object.freeze({ ...event, scopes: Object.freeze(event.scopes) }));
      return Object.freeze({ protocol: "clank-agent-activity/1", retainedLimit: maximum, events: Object.freeze(events) });
    },
  };
}

export function renderAgentActivity(snapshot: AgentActivitySnapshot): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<section aria-label="Agent activity"><h2>Agent activity</h2><p>${escape(snapshot.events.length)} retained calls · newest first · limit ${escape(snapshot.retainedLimit)}</p><p>Revision ranges show changes observed around a call and may include concurrent writers. Arguments, results, identities, and error messages are excluded.</p><div class="scroll"><table><thead><tr><th>Tool</th><th>Required scope</th><th>Granted scopes</th><th>Outcome</th><th>Started</th><th>Duration (ms)</th><th>Observed revisions</th></tr></thead><tbody>${snapshot.events.map(event => `<tr>${[event.tool, event.requiredScope, event.scopes.join(", ") || "None", event.outcome, new Date(event.startedAt).toISOString(), event.durationMs.toFixed(2), event.beforeRevision === null ? "—" : `${event.beforeRevision} → ${event.afterRevision}`].map(value => `<td>${escape(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}
