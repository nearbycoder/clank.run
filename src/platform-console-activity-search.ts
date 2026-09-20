type ConsoleActivitySearchEvent = {
  action: string;
  actor: { id: string; email?: string | null };
  project?: { name: string | null; slug?: string | null; deleted?: boolean } | null;
  organization?: { name: string; slug?: string | null } | null;
};

/** Internal console search over an already-authorized, loaded audit snapshot. */
export function filterConsoleActivitySearch<T extends ConsoleActivitySearchEvent>(events: readonly T[], search: unknown): T[] {
  const query = typeof search === "string" ? search.slice(0, 200).trim().toLowerCase() : "";
  if (!query) return [...events];
  return events.filter(event => {
    const target = event.project ?? event.organization;
    const fields = [
      event.action,
      event.action.replace(/[._]+/g, " "),
      target?.name ?? "Account",
      target?.slug,
      event.actor.email,
      event.actor.id,
    ];
    return fields.some(value => typeof value === "string" && value.toLowerCase().includes(query));
  });
}
