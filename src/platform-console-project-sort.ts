type ConsoleProjectSortValue = {
  id: string;
  name: string;
  slug: string;
  metrics?: { requests?: number; p95LatencyMs?: number };
};

/** Internal console ordering. Never mutates the authorized dashboard snapshot. */
export function sortConsoleProjects<T extends ConsoleProjectSortValue>(projects: readonly T[], order: string): T[] {
  const result = [...projects];
  if (!["name-asc", "name-desc", "requests", "latency"].includes(order)) return result;
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const metric = (value: number | undefined): number => Number.isFinite(value) ? Number(value) : 0;
  return result.sort((left, right) => {
    const name = compareText(left.name.toLowerCase(), right.name.toLowerCase());
    const tie = name || compareText(left.slug, right.slug) || compareText(left.id, right.id);
    if (order === "name-asc") return tie;
    if (order === "name-desc") return -name || compareText(left.slug, right.slug) || compareText(left.id, right.id);
    const key = order === "requests" ? "requests" : "p95LatencyMs";
    return metric(right.metrics?.[key]) - metric(left.metrics?.[key]) || tie;
  });
}
