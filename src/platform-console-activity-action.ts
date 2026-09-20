type ConsoleActivityActionEvent = { action: string };

/** Internal action choices from the already-authorized, loaded audit snapshot. */
export function filterConsoleActivityAction<T extends ConsoleActivityActionEvent>(events: readonly T[], requestedAction: unknown): { actions: string[]; action: string; events: T[] } {
  const actions = [...new Set(events.map(event => event.action).filter(action => typeof action === "string" && action.length > 0 && action.length <= 128 && !/[\u0000-\u001f\u007f]/.test(action)))].sort();
  const action = typeof requestedAction === "string" && requestedAction.length <= 128 && actions.includes(requestedAction) ? requestedAction : "";
  return { actions, action, events: action ? events.filter(event => event.action === action) : [...events] };
}
