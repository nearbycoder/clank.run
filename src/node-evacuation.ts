import type { SQLiteInternal } from "./sqlite-internal.ts";

export interface EvacuationProject {
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly backupId: string | null;
  readonly targetNodeId: string | null;
  readonly targetGeneration: number | null;
}
export interface NodeEvacuationPlan {
  readonly id: string;
  readonly nodeId: string;
  readonly requestedBy: string;
  readonly wasDraining: boolean;
  readonly state: "planned" | "running" | "paused" | "completed" | "cancelled";
  readonly phase: "planned" | "quiescing" | "fenced" | "relocating" | "completed";
  readonly projects: readonly EvacuationProject[];
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface NodeEvacuationHooks {
  /** Recheck current administrator authority and the exact source project set. */
  verify(plan: NodeEvacuationPlan): void;
  drain(plan: NodeEvacuationPlan): void;
  /** Must stop all source writers durably before taking and verifying the final backup. */
  snapshot(project: EvacuationProject, plan: NodeEvacuationPlan, assertCurrent: () => void): Promise<string>;
  fence(plan: NodeEvacuationPlan): void;
  relocate(project: EvacuationProject, plan: NodeEvacuationPlan, assertCurrent: () => void): Promise<{ nodeId: string; generation: number }>;
  /** Only called before any source writer-stop operation has begun. */
  cancel(plan: NodeEvacuationPlan): void;
}
export interface NodeEvacuations {
  create(nodeId: string, requestedBy: string, wasDraining: boolean, projects: readonly Pick<EvacuationProject, "projectId" | "releaseId" | "generation">[]): NodeEvacuationPlan;
  get(id: string): NodeEvacuationPlan;
  activeForProject(projectId: string): boolean;
  run(id: string, hooks: NodeEvacuationHooks): Promise<NodeEvacuationPlan>;
  cancel(id: string, hooks: NodeEvacuationHooks): NodeEvacuationPlan;
}
/** Durable stop/snapshot/fence/relocate progression. Provider operations must be idempotent for the plan ID. */
export function openNodeEvacuations(sql: SQLiteInternal): NodeEvacuations {
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_evacuations (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, requested_by TEXT NOT NULL, was_draining INTEGER NOT NULL,
    state TEXT NOT NULL, phase TEXT NOT NULL, projects TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`);
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_platform_evacuations_active ON clank_platform_evacuations(node_id) WHERE state NOT IN ('completed', 'cancelled')");
  const view = (row: Record<string, unknown>): NodeEvacuationPlan => Object.freeze({
    id: String(row.id), nodeId: String(row.node_id), requestedBy: String(row.requested_by), wasDraining: row.was_draining === 1,
    state: row.state as NodeEvacuationPlan["state"], phase: row.phase as NodeEvacuationPlan["phase"],
    projects: Object.freeze((JSON.parse(String(row.projects)) as EvacuationProject[]).map(project => Object.freeze(project))),
    error: row.error === null ? null : String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  });
  const get = (id: string): NodeEvacuationPlan => { identifier(id); const row = sql.prepare("SELECT * FROM clank_platform_evacuations WHERE id = ?").get(id); if (!row) throw new Error("Evacuation plan not found."); return view(row); };
  const update = (id: string, lease: string, change: { state?: NodeEvacuationPlan["state"]; phase?: NodeEvacuationPlan["phase"]; projects?: readonly EvacuationProject[]; error?: string | null }) => {
    const result = sql.prepare(`UPDATE clank_platform_evacuations SET state = COALESCE(?, state), phase = COALESCE(?, phase), projects = COALESCE(?, projects),
      error = ?, updated_at = ? WHERE id = ? AND lease_id = ? AND lease_until > ?`).run(change.state ?? null, change.phase ?? null, change.projects ? JSON.stringify(change.projects) : null, change.error ?? null, Date.now(), id, lease, Date.now());
    if (Number(result.changes) !== 1) throw new Error("Evacuation execution lease was lost.");
  };
  return {
    create(nodeId, requestedBy, wasDraining, projects) {
      identifier(nodeId); identifier(requestedBy);
      if (!Array.isArray(projects) || !projects.length || projects.length > 100 || new Set(projects.map(project => project.projectId)).size !== projects.length) throw new TypeError("Evacuate 1–100 distinct deployed projects.");
      for (const project of projects) { identifier(project.projectId); identifier(project.releaseId); if (!Number.isSafeInteger(project.generation) || project.generation < 1) throw new TypeError("Invalid source generation."); }
      return sql.transaction(() => {
        if (sql.prepare("SELECT 1 FROM clank_platform_evacuations WHERE node_id = ? AND state NOT IN ('completed', 'cancelled')").get(nodeId)) throw new Error("This node already has an unfinished evacuation.");
        const id = `evac_${crypto.randomUUID()}`, now = Date.now();
        sql.prepare("INSERT INTO clank_platform_evacuations(id,node_id,requested_by,was_draining,state,phase,projects,created_at,updated_at) VALUES (?,?,?,?,'planned','planned',?,?,?)")
          .run(id, nodeId, requestedBy, Number(wasDraining), JSON.stringify(projects.map(project => ({ ...project, backupId: null, targetNodeId: null, targetGeneration: null }))), now, now);
        return get(id);
      });
    },
    get,
    activeForProject(projectId) {
      identifier(projectId);
      return Boolean(sql.prepare(`SELECT 1 FROM clank_platform_evacuations p, json_each(p.projects) item
        WHERE p.state NOT IN ('completed','cancelled') AND json_extract(item.value, '$.projectId') = ? LIMIT 1`).get(projectId));
    },
    async run(id, hooks) {
      let plan = get(id); hooks.verify(plan);
      if (plan.state === "completed") return plan;
      if (plan.state === "cancelled") throw new Error("Evacuation was cancelled.");
      const lease = crypto.randomUUID();
      const claimed = sql.prepare("UPDATE clank_platform_evacuations SET lease_id = ?, lease_until = ?, state = 'running', error = NULL WHERE id = ? AND lease_until <= ? AND state NOT IN ('completed','cancelled')")
        .run(lease, Date.now() + 30_000, id, Date.now());
      if (Number(claimed.changes) !== 1) throw new Error("Evacuation is already running.");
      let lost = false;
      const timer = setInterval(() => {
        try { if (Number(sql.prepare("UPDATE clank_platform_evacuations SET lease_until = ? WHERE id = ? AND lease_id = ? AND lease_until > ?").run(Date.now() + 30_000, id, lease, Date.now()).changes) !== 1) lost = true; }
        catch { lost = true; }
      }, 5000);
      const assertCurrent = () => { if (lost) throw new Error("Evacuation execution lease was lost."); plan = get(id); hooks.verify(plan); if (!sql.prepare("SELECT 1 FROM clank_platform_evacuations WHERE id=? AND lease_id=? AND lease_until>?").get(id, lease, Date.now())) throw new Error("Evacuation execution lease was lost."); };
      try {
        assertCurrent();
        if (plan.phase === "planned") { hooks.drain(plan); update(id, lease, { phase: "quiescing" }); }
        assertCurrent();
        if (plan.phase === "quiescing") {
          for (const project of plan.projects) if (!project.backupId) {
            assertCurrent(); const backupId = await hooks.snapshot(project, plan, assertCurrent); identifier(backupId); assertCurrent();
            update(id, lease, { projects: plan.projects.map(item => item.projectId === project.projectId ? { ...item, backupId } : item) });
          }
          assertCurrent();
          // Persist the fence intent first. A crash after revocation resumes
          // forward without ever issuing a request to restart source writers.
          update(id, lease, { phase: "fenced" });
        }
        assertCurrent();
        if (plan.phase === "fenced") { hooks.fence(plan); update(id, lease, { phase: "relocating" }); }
        assertCurrent();
        for (const project of plan.projects) if (!project.targetNodeId) {
          assertCurrent(); const result = await hooks.relocate(project, plan, assertCurrent); identifier(result.nodeId);
          if (result.nodeId === plan.nodeId || !Number.isSafeInteger(result.generation) || result.generation <= project.generation) throw new Error("Evacuation target identity is invalid.");
          assertCurrent(); update(id, lease, { projects: plan.projects.map(item => item.projectId === project.projectId ? { ...item, targetNodeId: result.nodeId, targetGeneration: result.generation } : item) });
        }
        assertCurrent(); update(id, lease, { state: "completed", phase: "completed" }); return get(id);
      } catch (error) {
        try { update(id, lease, { state: "paused", error: "Evacuation paused. Inspect provider and recovery status, then resume this exact plan." }); } catch { /* A successor owns recovery. */ }
        throw error;
      } finally {
        clearInterval(timer); sql.prepare("UPDATE clank_platform_evacuations SET lease_id=NULL, lease_until=0 WHERE id=? AND lease_id=?").run(id, lease);
      }
    },
    cancel(id, hooks) {
      return sql.transaction(() => {
        const plan = get(id); hooks.verify(plan);
        if (plan.state === "cancelled") return plan;
        if (plan.phase !== "planned" || sql.prepare("SELECT 1 FROM clank_platform_evacuations WHERE id=? AND lease_until>?").get(id, Date.now())) throw new Error("Evacuation already started stopping writers; resume forward recovery instead.");
        // The injected cancellation must join this transaction, never open one.
        hooks.cancel(plan);
        sql.prepare("UPDATE clank_platform_evacuations SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(), id); return get(id);
      });
    },
  };
}
function identifier(value: string): void { if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u.test(value)) throw new TypeError("Invalid evacuation identifier."); }
