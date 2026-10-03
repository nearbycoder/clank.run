import type { SQLiteInternal } from "./sqlite-internal.js";

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
export declare function openNodeEvacuations(sql: SQLiteInternal): NodeEvacuations;
