import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { RehearsalApplication, RehearsalReport } from "./rehearsal.ts";
export interface OperationalSignal {
  key: string;
  kind: "deployment_failed" | "application_unhealthy" | "jobs_overdue" | "backup_failed" | "backup_overdue" | "usage_warning" | "restore_drill_failed" | "cost_budget";
  active: boolean;
  severity: "warning" | "critical";
  resourceId: string;
  message: string;
}
export interface OperationalAlert extends Omit<OperationalSignal, "active"> {
  readonly id: string;
  readonly state: "open" | "resolved";
  readonly occurredAt: number;
}
export interface PlatformOperationsOptions {
  intervalMs?: number | false;
  usageWarningPercent?: number;
  /** At-least-once notification delivery. Deduplicate by alert.id and honor its signal. */
  notify?: (alert: OperationalAlert, signal: AbortSignal) => Promise<void>;
  restoreDrills?: {
    intervalMs?: number;
    /** Boot the project's application against the disposable database only. Never start background writers against production. */
    boot(projectId: string, context: { databasePath: string; signal: AbortSignal }): RehearsalApplication | Promise<RehearsalApplication>;
    checks?: readonly { name: string; path: string; status?: number; includes?: string }[];
    timeoutMs?: number;
  };
}
export interface OperationalMonitor {
  runOnce(): Promise<void>;
  start(): void;
  list(): readonly (OperationalSignal & { state: "open" | "resolved"; updatedAt: number })[];
  drills(): readonly { projectId: string; nextRunAt: number; completedAt: number | null; report: RehearsalReport | null }[];
  close(): Promise<void>;
}
/** Durable incident transitions, leased delivery, retries, and restore-drill receipts. */
export function createOperationalMonitor(internal: SQLiteInternal, options: PlatformOperationsOptions, inspect: () => Promise<readonly OperationalSignal[]>,
  drill?: (projectId: string) => Promise<RehearsalReport>, onError?: (error: unknown) => void): OperationalMonitor {
  const interval = options.intervalMs === false ? false : options.intervalMs ?? 60_000;
  const drillInterval = options.restoreDrills?.intervalMs ?? 24 * 60 * 60_000;
  if (interval !== false && (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3_600_000)) throw new TypeError("Invalid operational polling interval.");
  if (!Number.isSafeInteger(drillInterval) || drillInterval < 60_000 || drillInterval > 30 * 24 * 60 * 60_000) throw new TypeError("Invalid restore-drill interval.");
  const warning = options.usageWarningPercent ?? 80;
  if (!Number.isFinite(warning) || warning < 1 || warning > 100) throw new TypeError("Invalid operational usage warning threshold.");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_operational_incidents (key TEXT PRIMARY KEY, signal TEXT NOT NULL CHECK(json_valid(signal)), active INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS clank_operational_deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL CHECK(json_valid(envelope)), next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until INTEGER, delivered_at INTEGER);
    CREATE INDEX IF NOT EXISTS clank_operational_delivery_due ON clank_operational_deliveries(delivered_at,next_at);
    CREATE TABLE IF NOT EXISTS clank_restore_drills (project_id TEXT PRIMARY KEY REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
      next_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, completed_at INTEGER, report TEXT CHECK(report IS NULL OR json_valid(report)));`);
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined;
  const shutdown = new AbortController();
  const reportError = (error: unknown) => { try { onError?.(error); } catch {} };
  const update = (signals: readonly OperationalSignal[]) => internal.transaction(() => {
    if (!Array.isArray(signals) || signals.length > 10_000) throw new TypeError("Too many operational signals.");
    const seen = new Set<string>();
    for (const signal of signals) {
      if (!/^[A-Za-z0-9_.:/-]{1,250}$/.test(signal.key) || seen.has(signal.key) || !/^[A-Za-z0-9_.-]{1,128}$/.test(signal.resourceId)
        || !["deployment_failed", "application_unhealthy", "jobs_overdue", "backup_failed", "backup_overdue", "usage_warning", "restore_drill_failed", "cost_budget"].includes(signal.kind)
        || typeof signal.active !== "boolean" || !["warning", "critical"].includes(signal.severity)
        || typeof signal.message !== "string" || signal.message.length > 500) throw new TypeError("Invalid operational signal.");
      seen.add(signal.key);
      const prior = internal.prepare("SELECT active FROM clank_operational_incidents WHERE key=?").get(signal.key);
      const now = Date.now();
      internal.prepare(`INSERT INTO clank_operational_incidents(key,signal,active,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET signal=excluded.signal,active=excluded.active,updated_at=excluded.updated_at`).run(signal.key, JSON.stringify(signal), Number(signal.active), now);
      if ((!prior && !signal.active) || (prior && Boolean(prior.active) === signal.active)) continue;
      if (options.notify) {
        const { active: _active, ...fields } = signal;
        const alert: OperationalAlert = { ...fields, id: `alert_${crypto.randomUUID()}`, state: signal.active ? "open" : "resolved", occurredAt: now };
        internal.prepare("INSERT INTO clank_operational_deliveries(id,envelope,next_at) VALUES(?,?,?)").run(alert.id, JSON.stringify(alert), now);
      }
    }
    internal.prepare("DELETE FROM clank_operational_deliveries WHERE delivered_at < ?").run(Date.now() - 30 * 24 * 60 * 60_000);
    internal.prepare("DELETE FROM clank_operational_incidents WHERE active=0 AND updated_at<?").run(Date.now() - 30 * 24 * 60 * 60_000);
  });
  const deliver = async () => {
    if (!options.notify) return;
    for (let count = 0; count < 10 && !closed; count++) {
      const now = Date.now(), token = crypto.randomUUID();
      const claimed = internal.transaction(() => {
        const row = internal.prepare(`SELECT current.* FROM clank_operational_deliveries current WHERE current.delivered_at IS NULL AND current.next_at<=?
          AND (current.lease_until IS NULL OR current.lease_until<=?)
          AND NOT EXISTS (SELECT 1 FROM clank_operational_deliveries prior WHERE prior.delivered_at IS NULL
            AND prior.sequence < current.sequence AND json_extract(prior.envelope,'$.key')=json_extract(current.envelope,'$.key'))
          ORDER BY current.sequence LIMIT 1`).get(now, now);
        if (!row) return undefined;
        const changed = internal.prepare("UPDATE clank_operational_deliveries SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (lease_until IS NULL OR lease_until<=?)")
          .run(token, now + 30_000, row.id, now);
        return Number(changed.changes) === 1 ? row : undefined;
      });
      if (!claimed) break;
      const timeout = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { timeout.abort(); reject(new Error("Operational notification deadline exceeded.")); }, 15_000); });
        await Promise.race([options.notify(JSON.parse(String(claimed.envelope)), AbortSignal.any([timeout.signal, shutdown.signal])), deadline]);
        internal.prepare("UPDATE clank_operational_deliveries SET delivered_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(Date.now(), claimed.id, token);
      } catch (error) {
        internal.prepare("UPDATE clank_operational_deliveries SET next_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?")
          .run(Date.now() + Math.min(30 * 60_000, 1000 * 2 ** Math.min(10, Number(claimed.attempts))), claimed.id, token);
        reportError(error);
      } finally { if (timer) clearTimeout(timer); }
    }
  };
  const runDrill = async () => {
    if (!drill || !options.restoreDrills || closed) return;
    const now = Date.now(), token = crypto.randomUUID();
    const projectId = internal.transaction(() => {
      internal.prepare(`INSERT OR IGNORE INTO clank_restore_drills(project_id,next_at)
        SELECT id,? FROM clank_platform_projects WHERE database_path IS NOT NULL AND active_release_id IS NOT NULL`).run(now);
      const candidate = internal.prepare(`SELECT project_id FROM clank_restore_drills WHERE next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,project_id LIMIT 1`).get(now, now);
      if (!candidate) return undefined;
      internal.prepare("UPDATE clank_restore_drills SET lease_token=?,lease_until=? WHERE project_id=?").run(token, now + 10 * 60_000, candidate.project_id);
      return String(candidate.project_id);
    });
    if (!projectId) return;
    try {
      const report = await drill(projectId);
      const result = internal.prepare("UPDATE clank_restore_drills SET next_at=?,lease_token=NULL,lease_until=NULL,completed_at=?,report=? WHERE project_id=? AND lease_token=? AND lease_until>?")
        .run(Date.now() + drillInterval, Date.now(), JSON.stringify(report), projectId, token, Date.now());
      if (Number(result.changes)) update([{ key: `restore-drill:${projectId}`, kind: "restore_drill_failed", resourceId: projectId,
        severity: "critical", active: !report.ok, message: report.ok ? "Restore drill passed application checks." : "Restore drill failed; inspect its receipt before relying on recovery." }]);
    } catch (error) {
      internal.prepare("UPDATE clank_restore_drills SET next_at=?,lease_token=NULL,lease_until=NULL WHERE project_id=? AND lease_token=?").run(Date.now() + Math.min(drillInterval, 5 * 60_000), projectId, token);
      update([{ key: `restore-drill:${projectId}`, kind: "restore_drill_failed", resourceId: projectId, severity: "critical", active: true, message: "Restore drill could not complete." }]);
      reportError(error);
    }
  };
  const runOnce = async () => {
    if (closed) throw new Error("Operational monitor is closed.");
    if (flight) return flight;
    flight = (async () => { update(await inspect()); await runDrill(); await deliver(); })();
    try { await flight; } finally { flight = undefined; }
  };
  const schedule = () => {
    if (closed || timer || interval === false) return;
    timer = setTimeout(() => { timer = undefined; void runOnce().catch(reportError).finally(schedule); }, interval);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  return {
    runOnce, start: schedule,
    list: () => internal.prepare("SELECT * FROM clank_operational_incidents ORDER BY active DESC,updated_at DESC LIMIT 1000").all()
      .map((row) => ({ ...JSON.parse(String(row.signal)), state: row.active ? "open" : "resolved", updatedAt: Number(row.updated_at) })),
    drills: () => internal.prepare("SELECT * FROM clank_restore_drills ORDER BY completed_at DESC LIMIT 1000").all().map((row) => ({
      projectId: String(row.project_id), nextRunAt: Number(row.next_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
      report: row.report === null ? null : JSON.parse(String(row.report)),
    })),
    async close() { if (closed) return; closed = true; if (timer) clearTimeout(timer); shutdown.abort(); await flight?.catch(reportError); },
  };
}
