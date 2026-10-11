import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { IngressRequestMetric, IngressCanaryRoute, IngressRoute } from "./data-plane.ts";
import { assessRollout } from "./lifecycle.ts";
export interface ManagedCanaryStage { trafficPercent: number; durationMs: number; minimumSamples: number; }
export interface ManagedCanaryOptions {
  stages: readonly ManagedCanaryStage[];
  maximumErrorRate: number;
  maximumP95Ms: number;
  /** Requires native supervisor leadership and an isolated provider read-only candidate. */
  provider?: { readonly databasePolicy: "isolated-read-only"; readonly readPaths: readonly string[] };
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
  let provider: ManagedCanaryOptions["provider"];
  if (options.provider !== undefined) {
    const input = options.provider;
    if (!input || Object.keys(input).some(key => !["databasePolicy", "readPaths"].includes(key)) || input.databasePolicy !== "isolated-read-only"
      || !Array.isArray(input.readPaths) || !input.readPaths.length || input.readPaths.length > 128 || new Set(input.readPaths).size !== input.readPaths.length
      || input.readPaths.some(value => typeof value !== "string" || value.length > 512 || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u.test(value) || value.split("/").some(part => part === "." || part === ".."))
      || new TextEncoder().encode(JSON.stringify(input)).byteLength > 16 * 1024
      || stages.reduce((total, stage) => total + stage.durationMs, 0) > 30 * 60_000) throw new TypeError("Invalid isolated provider canary policy.");
    provider = Object.freeze({ databasePolicy: "isolated-read-only", readPaths: Object.freeze([...input.readPaths]) });
  }
  return Object.freeze({ stages: Object.freeze(stages), maximumErrorRate: options.maximumErrorRate, maximumP95Ms: options.maximumP95Ms, ...(provider ? { provider } : {}) });
}
/** Internal control-plane coordinator. Routing is admitted only while its deployment owns the project lock. */
export function createManagedCanary(internal: SQLiteInternal, input: ManagedCanaryOptions) {
  const options = validateManagedCanary(input);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_canaries(release_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,report TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  const running = new Map<string, { upstream: string; route?: Omit<IngressCanaryRoute, "trafficPercent">; primary?: Pick<IngressRoute, "projectId" | "releaseId" | "upstream" | "runtime">; assertCurrent: () => void; report: ManagedCanaryReport; samples: Array<{ duration: number; error: boolean }>; total: number; startedAt: number; lastWall: number; failure: string | null }>();
  // Managed ingress creates a fresh frozen selection inside each handle(), even
  // when its route store reuses a prior selection. Only that already admitted
  // local request may keep its native authority through the bounded runtime
  // drain. Provider candidates remain tied to their current measuring phase.
  const admittedLocal = new WeakMap<Readonly<IngressRoute>, NonNullable<ReturnType<typeof running.get>>>();
  const shutdown = new AbortController();
  const persist = (report: ManagedCanaryReport, assertCurrent: () => void) => internal.transaction(() => {
    assertCurrent();
    internal.prepare("INSERT INTO clank_platform_canaries(release_id,project_id,report,updated_at) VALUES(?,?,?,?) ON CONFLICT(release_id) DO UPDATE SET report=excluded.report,updated_at=excluded.updated_at")
      .run(report.releaseId, report.projectId, JSON.stringify(report), report.updatedAt);
    assertCurrent();
  });
  const summarize = (entry: ReturnType<typeof running.get> & {}) => {
    const durations = entry.samples.map((sample) => sample.duration).sort((a, b) => a - b);
    entry.report.samples = durations.length;
    entry.report.errorRate = durations.length ? entry.samples.filter((sample) => sample.error).length / durations.length : 0;
    entry.report.p95Ms = durations.length ? durations[Math.ceil(durations.length * 0.95) - 1]! : 0;
  };
  return {
    route(projectId: string): IngressCanaryRoute | undefined {
      const current = running.get(projectId);
      if (!current || current.failure) return undefined;
      try { current.assertCurrent(); } catch { return undefined; }
      return { ...(current.route ?? { upstream: current.upstream, releaseId: current.report.releaseId }), trafficPercent: current.report.trafficPercent } as IngressCanaryRoute;
    },
    assertCurrent(route: Readonly<IngressRoute>): undefined {
      const admitted = admittedLocal.get(route), current = admitted ?? running.get(route.projectId), selected = route.canary;
      if (shutdown.signal.aborted || !current || !admitted && current.failure || !selected || current.report.releaseId !== selected.releaseId || current.upstream !== selected.upstream
        || JSON.stringify(current.route?.runtime ?? null) !== JSON.stringify(selected.runtime ?? null)
        || current.route?.projectId !== selected.projectId
        || JSON.stringify(current.route?.readPaths ?? null) !== JSON.stringify(selected.readPaths ?? null)
        || current.primary && (current.primary.projectId !== route.projectId || current.primary.releaseId !== route.releaseId || current.primary.upstream !== route.upstream
          || JSON.stringify(current.primary.runtime ?? null) !== JSON.stringify(route.runtime ?? null))) throw new Error("Canary routing authority changed.");
      current.assertCurrent();
      if (!selected.runtime && Object.isFrozen(route)) admittedLocal.set(route, current);
      return undefined;
    },
    pendingProjects(): string[] { return [...new Set(internal.prepare("SELECT project_id,report FROM clank_platform_canaries").all().filter(row => JSON.parse(String(row.report)).state === "running").map(row => String(row.project_id)))]; },
    interrupt(projectId: string, assertCurrent: () => void) {
      assertCurrent();
      for (const row of internal.prepare("SELECT report FROM clank_platform_canaries WHERE project_id=?").all(projectId)) {
        const report = JSON.parse(String(row.report)) as ManagedCanaryReport;
        if (report.state !== "running") continue;
        assertCurrent();
        report.state = "interrupted"; report.trafficPercent = 0; report.reason = "Platform restarted before canary promotion; the prior release remains authoritative."; report.updatedAt = Date.now(); persist(report, assertCurrent);
      }
    },
    record(metric: IngressRequestMetric) {
      const current = running.get(metric.projectId);
      if (!current || !metric.admitted || metric.upstream !== current.upstream || metric.releaseId !== current.report.releaseId || metric.responseOutcome === "cancelled" || metric.recordedAt <= current.startedAt) return;
      current.assertCurrent();
      current.samples[current.total++ % 10000] = { duration: metric.durationMs, error: metric.statusCode >= 500 || metric.responseOutcome === "error" };
    },
    reports(projectId?: string): ManagedCanaryReport[] {
      return (projectId ? internal.prepare("SELECT report FROM clank_platform_canaries WHERE project_id=? ORDER BY updated_at DESC LIMIT 100").all(projectId)
        : internal.prepare("SELECT report FROM clank_platform_canaries ORDER BY updated_at DESC LIMIT 100").all()).map((row) => JSON.parse(String(row.report)));
    },
    async run(projectId: string, releaseId: string, upstream: string, check: () => Promise<void>, control?: {
      assertCurrent: () => void;
      route?: Omit<IngressCanaryRoute, "trafficPercent">;
      policy?: ManagedCanaryOptions;
      primary?: Pick<IngressRoute, "projectId" | "releaseId" | "upstream" | "runtime">;
    }) {
      if (shutdown.signal.aborted || running.has(projectId)) throw new Error("Canary admission is unavailable for this project.");
      const report: ManagedCanaryReport = { projectId, releaseId, state: "running", stage: 0, trafficPercent: 0, samples: 0, errorRate: 0, p95Ms: 0, reason: null, updatedAt: Date.now() };
      const policy = control?.policy ? validateManagedCanary(control.policy) : options;
      const authority = () => { control?.assertCurrent(); };
      authority();
      const entry = { upstream, route: control?.route, primary: control?.primary, assertCurrent: authority, report, lastWall: Date.now(), samples: [] as Array<{ duration: number; error: boolean }>, total: 0, startedAt: Date.now(), failure: null as string | null };
      const assertCurrent = () => {
        authority();
        const now = Date.now();
        if (now < entry.lastWall) throw new Error("Canary measurement clock regressed.");
        entry.lastWall = now;
      };
      entry.assertCurrent = assertCurrent;
      running.set(projectId, entry);
      try {
        for (let index = 0; index < policy.stages.length; index++) {
          assertCurrent(); await check(); assertCurrent();
          const stage = policy.stages[index]!;
          entry.samples = []; entry.total = 0; entry.startedAt = Date.now();
          Object.assign(report, { stage: index, trafficPercent: stage.trafficPercent, samples: 0, errorRate: 0, p95Ms: 0, updatedAt: Date.now() }); assertCurrent(); persist(report, assertCurrent);
          const deadline = performance.now() + stage.durationMs; let lastHealth = performance.now(), lastPersist = performance.now();
          do {
            if (shutdown.signal.aborted) throw new Error("Platform closed during canary evaluation.");
            assertCurrent(); summarize(entry);
            const decision = assessRollout(report, { ...policy, minimumSamples: stage.minimumSamples });
            if (decision.action === "rollback") throw new Error(`Canary guardrail failed: ${decision.reasons.join(" ")}`);
            if (performance.now() - lastHealth >= 1000) { await check(); assertCurrent(); lastHealth = performance.now(); }
            if (performance.now() - lastPersist >= 1000) { report.updatedAt = Date.now(); assertCurrent(); persist(report, assertCurrent); lastPersist = performance.now(); }
            if (performance.now() >= deadline) {
              if (decision.action !== "continue") throw new Error(`Canary stage lacked required evidence: ${decision.reasons.join(" ")}`);
              break;
            }
            await new Promise<void>((resolve) => { setTimeout(resolve, Math.max(1, Math.min(100, deadline - performance.now()))); });
          } while (true);
          assertCurrent(); await check(); assertCurrent();
        }
        assertCurrent(); report.state = "passed"; report.updatedAt = Date.now(); persist(report, assertCurrent);
        return Object.freeze({ ...report });
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : "Canary failed.";
        report.state = "failed"; report.reason = entry.failure.slice(0, 1000); report.trafficPercent = 0; report.updatedAt = Date.now();
        // A superseded process leaves the durable report for the current project owner.
        try { authority(); persist(report, authority); } catch { /* Native ownership was lost. */ }
        throw error;
      } finally { running.delete(projectId); }
    },
    close() { shutdown.abort(); },
  };
}
