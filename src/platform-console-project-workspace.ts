type ConsoleProjectWorkspaceValue = { organizationId: string };
type ConsoleWorkspaceValue = { id: string };

/** Filters only an authorized dashboard snapshot; revoked selections revert to all workspaces. */
export function filterConsoleProjectWorkspace<T extends ConsoleProjectWorkspaceValue>(projects: readonly T[], organizations: readonly ConsoleWorkspaceValue[], requestedWorkspace: unknown): { projects: T[]; workspaceId: string } {
  const workspaceId = typeof requestedWorkspace === "string" && organizations.some(organization => organization.id === requestedWorkspace)
    ? requestedWorkspace
    : "";
  return { workspaceId, projects: workspaceId ? projects.filter(project => project.organizationId === workspaceId) : [...projects] };
}
