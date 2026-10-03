import { runSQLiteTask } from "./sqlite-task.ts";
import type {
  InspectPlatformJobsOptions,
  MutatePlatformJobOptions,
  PlatformJobSnapshot,
  PlatformJobMutation,
} from "./platform-jobs-worker.ts";
export type {
  PlatformJobRecord,
  PlatformJobSchedule,
  PlatformJobStats,
  PlatformJobSnapshot,
  InspectPlatformJobsOptions,
  MutatePlatformJobOptions,
  PlatformJobMutation,
} from "./platform-jobs-worker.ts";
export { parsePlatformJobSnapshot, parsePlatformJobMutation } from "./platform-jobs-worker.ts";

export async function inspectPlatformJobs(options: InspectPlatformJobsOptions): Promise<PlatformJobSnapshot> {
  const { parsePlatformJobSnapshot } = await import("./platform-jobs-worker.ts");
  return parsePlatformJobSnapshot(await runSQLiteTask("jobs", "inspectPlatformJobs", [options]));
}

export async function mutatePlatformJob(options: MutatePlatformJobOptions): Promise<PlatformJobMutation> {
  const { parsePlatformJobMutation } = await import("./platform-jobs-worker.ts");
  return parsePlatformJobMutation(await runSQLiteTask("jobs", "mutatePlatformJob", [options]));
}
