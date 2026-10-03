/** Opt-in state recovery across local `clank dev` reloads. Never store credentials here. */
export interface DevelopmentStateAdapter<Value> { snapshot(): Value; restore(value: Value): void; }
/** Register a stable key and return cleanup; JSON state is bounded to 64 KiB per page. */
export function preserveDevelopmentState<Value>(key: string, adapter: DevelopmentStateAdapter<Value>): () => void {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) || !adapter || typeof adapter.snapshot !== "function" || typeof adapter.restore !== "function") throw new TypeError("Use a stable development state key and snapshot/restore callbacks.");
  if (typeof window === "undefined") return () => {};
  const view = window as any, symbol = Symbol.for("clank.dev.state");
  const registry = view[symbol] ??= { entries: new Map(), restored: new Map() };
  if (registry.entries.has(key)) throw new Error(`Development state key already registered: ${key}`);
  if (registry.entries.size >= 100) throw new Error("Development state registration limit reached.");
  registry.entries.set(key, adapter);
  try { if (registry.restored.has(key)) { adapter.restore(registry.restored.get(key)); registry.restored.delete(key); } }
  catch (error) { registry.entries.delete(key); throw error; }
  return () => { if (registry.entries.get(key) === adapter) registry.entries.delete(key); };
}
