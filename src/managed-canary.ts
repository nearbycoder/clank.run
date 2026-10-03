import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { IngressRequestMetric } from "./data-plane.ts";
import { assessRollout } from "./lifecycle.ts";
export interface ManagedCanaryStage { trafficPercent: number; durationMs: number; minimumSamples: number; }
export interface ManagedCanaryOptions {
  stages: readonly ManagedCanaryStage[];
  maximumErrorRate: number;
  maximumP95Ms: number;
}
export interface ManagedCanaryReport {
  projectId: string;
  releaseId: string;
  state: "running" | "passed" | "failed" | "interrupted";
  stage: number;
  trafficPercent: number;
  samples: number;
  errorRate: number;
  p95Ms: number;
  reason: string | null;
  updatedAt: number;
}
export function validateManagedCanary(options: ManagedCanaryOptions): ManagedCanaryOptions {
  if (!options || !Array.isArray(options.stages) || !options.stages.length || options.stages.length > 8) throw new TypeError("Canary requires 1–8 traffic stages.");
  let previous = 0;
  const stages = options.stages.map((stage) => {
    if (!Number.isSafeInteger(stage.trafficPercent) || stage.trafficPercent <= previous || stage.trafficPercent > 100
      || !Number.isSafeInteger(stage.durationMs) || stage.durationMs < 100 || stage.durationMs > 30 * 60_000
      || !Number.isSafeInteger(stage.minimumSamples) || stage.minimumSamples < 1 || stage.minimumSamples > 10_000) throw new TypeError("Invalid canary traffic, duration or sample requirement.");
    previous = stage.trafficPercent; return Object.freeze({ ...stage });
  });
  if (previous !== 100) throw new TypeError("Canary final stage must receive 100% of traffic.");
  assessRollout({ samples: 0, errorRate: 0, p95Ms: 0 }, { ...options, minimumSamples: 1 });
  return Object.freeze({ stages: Object.freeze(stages), maximumErrorRate: options.maximumErrorRate, maximumP95Ms: options.maximumP95Ms });
}
/** Internal control-plane coordinator. Routing is admitted only while its deployment owns the project lock. */
export function createManagedCanary(internal: SQLiteInternal, input: ManagedCanaryOptions) {
  const options = validateManagedCanary(input);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_canaries(release_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,report TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  for (const row of internal.prepare("SELECT release_id,report FROM clank_platform_canaries").all()) {
    const report = JSON.parse(String(row.report)) as ManagedCanaryReport;
    if (report.state === "running") {
      report.state = "interrupted"; report.trafficPercent = 0; report.reason = "Platform restarted before canary promotion; the prior release remains authoritative."; report.updatedAt = Date.now();
      internal.prepare("UPDATE clank_platform_canaries SET report=?,updated_at=? WHERE release_id=?").run(JSON.stringify(report), report.updatedAt, row.release_id);
    }
  }
  const running = new Map<string, { upstream: string; report: ManagedCanaryReport; samples: Array<{ duration: number; error: boolean }>; total: number; startedAt: number; failure: string | null }>();
  const shutdown = new AbortController();
  const persist = (report: ManagedCanaryReport) => internal.prepare("INSERT INTO clank_platform_canaries(release_id,project_id,report,updated_at) VALUES(?,?,?,?) ON CONFLICT(release_id) DO UPDATE SET report=excluded.report,updated_at=excluded.updated_at")
    .run(report.releaseId, report.projectId, JSON.stringify(report), report.updatedAt);
  const summarize = (entry: ReturnType<typeof running.get> & {}) => {
    const durations = entry.samples.map((sample) => sample.duration).sort((a, b) => a - b);
    entry.report.samples = durations.length;
    entry.report.errorRate = durations.length ? entry.samples.filter((sample) => sample.error).length / durations.length : 0;
    entry.report.p95Ms = durations.length ? durations[Math.ceil(durations.length * 0.95) - 1]! : 0;
  };
  return {
    route(projectId: string) { const current = running.get(projectId); return current && !current.failure ? { upstream: current.upstream, releaseId: current.report.releaseId, trafficPercent: current.report.trafficPercent } : undefined; },
    record(metric: IngressRequestMetric) {
      const current = running.get(metric.projectId);
      if (!current || !metric.admitted || metric.upstream !== current.upstream || metric.releaseId !== current.report.releaseId || metric.responseOutcome === "cancelled" || metric.recordedAt < current.startedAt) return;
      current.samples[current.total++ % 10000] = { duration: metric.durationMs, error: metric.statusCode >= 500 || metric.responseOutcome === "error" };
    },
    reports(projectId?: string): ManagedCanaryReport[] {
      return (projectId ? internal.prepare("SELECT report FROM clank_platform_canaries WHERE project_id=? ORDER BY updated_at DESC LIMIT 100").all(projectId)
        : internal.prepare("SELECT report FROM clank_platform_canaries ORDER BY updated_at DESC LIMIT 100").all()).map((row) => JSON.parse(String(row.report)));
    },
    async run(projectId: string, releaseId: string, upstream: string, check: () => Promise<void>) {
      if (shutdown.signal.aborted || running.has(projectId)) throw new Error("Canary admission is unavailable for this project.");
      const report: ManagedCanaryReport = { projectId, releaseId, state: "running", stage: 0, trafficPercent: 0, samples: 0, errorRate: 0, p95Ms: 0, reason: null, updatedAt: Date.now() };
      const entry = { upstream, report, samples: [] as Array<{ duration: number; error: boolean }>, total: 0, startedAt: Date.now(), failure: null as string | null };
      running.set(projectId, entry);
      try {
        for (let index = 0; index < options.stages.length; index++) {
          await check();
          const stage = options.stages[index]!;
          entry.samples = []; entry.total = 0; entry.startedAt = Date.now();
          Object.assign(report, { stage: index, trafficPercent: stage.trafficPercent, samples: 0, errorRate: 0, p95Ms: 0, updatedAt: Date.now() }); persist(report);
          const deadline = Date.now() + stage.durationMs; let lastHealth = Date.now(), lastPersist = Date.now();
          do {
            if (shutdown.signal.aborted) throw new Error("Platform closed during canary evaluation.");
            summarize(entry);
            const decision = assessRollout(report, { ...options, minimumSamples: stage.minimumSamples });
            if (decision.action === "rollback") throw new Error(`Canary guardrail failed: ${decision.reasons.join(" ")}`);
            if (Date.now() - lastHealth >= 1000) { await check(); lastHealth = Date.now(); }
            if (Date.now() - lastPersist >= 1000) { report.updatedAt = Date.now(); persist(report); lastPersist = report.updatedAt; }
            if (Date.now() >= deadline) {
              if (decision.action !== "continue") throw new Error(`Canary stage lacked required evidence: ${decision.reasons.join(" ")}`);
              break;
            }
            await new Promise<void>((resolve) => { setTimeout(resolve, Math.max(1, Math.min(100, deadline - Date.now()))); });
          } while (true);
          await check();
        }
        report.state = "passed"; report.updatedAt = Date.now(); persist(report);
        return Object.freeze({ ...report });
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : "Canary failed.";
        report.state = "failed"; report.reason = entry.failure.slice(0, 1000); report.trafficPercent = 0; report.updatedAt = Date.now(); persist(report); throw error;
      } finally { running.delete(projectId); }
    },
    close() { shutdown.abort(); },
  };
}
