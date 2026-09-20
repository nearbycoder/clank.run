type ConsoleLogSearchEntry = { message: string };

/** Internal console search over only the messages in an authorized, redacted log snapshot. */
export function filterConsoleLogSearch<T extends ConsoleLogSearchEntry>(logs: readonly T[], search: unknown): T[] {
  const query = typeof search === "string" ? search.slice(0, 200).trim().toLowerCase() : "";
  if (!query) return [...logs];
  return logs.filter(log => log.message.toLowerCase().includes(query));
}
