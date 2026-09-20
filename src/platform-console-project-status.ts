type ConsoleProjectRuntimeValue = { runtimeStatus: string };

/** Filters only the already authorized snapshot, without mutating it. */
export function filterConsoleProjectStatus<T extends ConsoleProjectRuntimeValue>(projects: readonly T[], requestedStatus: unknown): { projects: T[]; status: string } {
  const status = typeof requestedStatus === "string" && ["online", "sleeping", "suspended", "degraded", "not_deployed"].includes(requestedStatus)
    ? requestedStatus
    : "all";
  return { status, projects: status === "all" ? [...projects] : projects.filter(project => project.runtimeStatus === status) };
}
