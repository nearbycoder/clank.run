import type { SQLiteInternal } from "./sqlite-internal.js";
import type { RehearsalApplication, RehearsalReport } from "./rehearsal.js";
export interface OperationalSignal {
  key: string;
  kind: "deployment_failed" | "application_unhealthy" | "jobs_overdue" | "backup_failed" | "backup_overdue" | "usage_warning" | "restore_drill_failed";
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
  notify?: (alert: OperationalAlert, signal: AbortSignal) => Promise<void>;
  restoreDrills?: {
    intervalMs?: number;
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
export declare function createOperationalMonitor(internal: SQLiteInternal, options: PlatformOperationsOptions, inspect: () => Promise<readonly OperationalSignal[]>, drill?: (projectId: string) => Promise<RehearsalReport>, onError?: (error: unknown) => void): OperationalMonitor;
