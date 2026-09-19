export type UndoValue = null | boolean | number | string | readonly UndoValue[] | { readonly [key: string]: UndoValue };
export interface UndoState<T> { value: T; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null; retainedBytes: number; }
export interface UndoHistory<T extends UndoValue> {
  state(): UndoState<T>;
  commit(value: T, label?: string, group?: string): boolean;
  undo(): T; redo(): T; reset(value: T): void;
  transaction(edit: (value: T) => T, label?: string): boolean;
  subscribe(listener: (state: UndoState<T>) => void): () => void;
  serialize(): string; restore(snapshot: string): void;
}
export interface UndoOptions { capacity?: number; maxBytes?: number; onListenerError?(error: unknown): void; }
interface Entry { json: string; bytes: number; label: string; group?: string; }
/** Bounded local editor history with explicit coalescing and atomic synchronous transactions. */
export function createUndoHistory<T extends UndoValue>(initial: T, options: UndoOptions = {}): UndoHistory<T> {
  const capacity = options.capacity ?? 100, maxBytes = options.maxBytes ?? 1048576;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000 || !Number.isInteger(maxBytes) || maxBytes < 128 || maxBytes > 16777216) throw new TypeError("Invalid undo history bounds.");
  const encode = (value: T, label = "Edit", group?: string): Entry => {
    if (typeof label !== "string" || !label.trim() || label.length > 100 || (group !== undefined && (typeof group !== "string" || !group || group.length > 100))) throw new TypeError("Invalid history label or group.");
    let nodes = 0; const seen = new Set<object>(); const inspect = (value: unknown, depth: number) => { if (++nodes > 10000 || depth > 20) throw new TypeError("History value is too complex."); if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
      if (typeof value !== "object" || !value || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("History requires finite plain JSON values."); seen.add(value);
      if (Object.getOwnPropertySymbols(value).length || (Array.isArray(value) && (Object.keys(value).length !== value.length || Array.from({length:value.length},(_,i)=>i).some(i=>!Object.hasOwn(value,i))))) throw new TypeError("History requires dense JSON values.");
      for (const key of Object.keys(value)) { const property = Object.getOwnPropertyDescriptor(value,key)!; if (!Object.hasOwn(property,"value")) throw new TypeError("History cannot contain getters."); inspect(property.value,depth+1); } seen.delete(value);
    }; inspect(value,0); const json = JSON.stringify(value), bytes = new TextEncoder().encode(json + label + (group ?? "")).byteLength; if (bytes > maxBytes) throw new RangeError("History entry exceeds the byte budget."); return { json, bytes, label: label.trim(), group };
  };
  let past: Entry[] = [encode(initial, "Initial")], future: Entry[] = [], activeGroup: string | undefined, mutating = false;
  const listeners = new Set<(state: UndoState<T>) => void>(), total = () => [...past,...future].reduce((sum,entry)=>sum+entry.bytes,0);
  const state = (): UndoState<T> => ({ value: JSON.parse(past[past.length-1]!.json), canUndo: past.length > 1, canRedo: future.length > 0, undoLabel: past.length > 1 ? past[past.length-1]!.label : null, redoLabel: future.at(-1)?.label ?? null, retainedBytes: total() });
  const notify = () => { for (const listener of [...listeners]) { try { listener(state()); } catch (error) { try { options.onListenerError?.(error); } catch {} } } };
  const ensure = () => { if (mutating) throw new Error("Cannot mutate history from inside an edit transaction."); };
  const commit = (value: T, label = "Edit", group?: string) => { ensure(); const entry = encode(value,label,group); if (entry.json === past.at(-1)!.json) return false;
    if (group && activeGroup === group && past.length > 1 && future.length === 0) past[past.length-1] = entry; else past.push(entry); future = []; activeGroup = group;
    while (past.length > capacity + 1 || (total() > maxBytes && past.length > 1)) past.shift(); notify(); return true;
  };
  return {
    state, commit,
    undo() { ensure(); activeGroup = undefined; if (past.length > 1) { future.push(past.pop()!); notify(); } return state().value; },
    redo() { ensure(); activeGroup = undefined; if (future.length) { past.push(future.pop()!); notify(); } return state().value; },
    reset(value) { ensure(); const next = encode(value,"Initial"); past = [next]; future = []; activeGroup = undefined; notify(); },
    transaction(edit, label = "Edit") { ensure(); let next: T; mutating = true; try { next = edit(state().value); if (next && typeof (next as any).then === "function") throw new TypeError("Undo transactions must be synchronous."); } finally { mutating = false; } return commit(next!,label); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    serialize() { return JSON.stringify({ version: 1, past: past.map(({json,label})=>({value:JSON.parse(json),label})), future: future.map(({json,label})=>({value:JSON.parse(json),label})) }); },
    restore(snapshot) { ensure(); if (typeof snapshot !== "string" || new TextEncoder().encode(snapshot).byteLength > maxBytes * 4 + 100000) throw new RangeError("History snapshot exceeds the budget.");
      const data = JSON.parse(snapshot); if (!data || data.version !== 1 || !Array.isArray(data.past) || !data.past.length || !Array.isArray(data.future) || data.past.length + data.future.length > capacity + 1) throw new TypeError("Invalid history snapshot.");
      const parse = (entry: any) => { if (!entry || !Object.hasOwn(entry,"value")) throw new TypeError("Invalid history entry."); return encode(entry.value,entry.label); }, nextPast = data.past.map(parse), nextFuture = data.future.map(parse);
      if ([...nextPast,...nextFuture].reduce((sum,entry)=>sum+entry.bytes,0) > maxBytes) throw new RangeError("History snapshot exceeds the byte budget."); past = nextPast; future = nextFuture; activeGroup = undefined; notify();
    },
  };
}
/** Explicit local undo/redo controls; server mutations require the host's own compensation policy. */
export function mountUndoControls<T extends UndoValue>(container: HTMLElement, history: UndoHistory<T>, apply: (value: T) => void): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("div"), undo = doc.createElement("button"), redo = doc.createElement("button"), status = doc.createElement("span"); undo.type = redo.type = "button"; panel.setAttribute("role","group"); panel.setAttribute("aria-label","Edit history"); status.setAttribute("role","status");
  const render = (state = history.state()) => { undo.disabled = !state.canUndo; redo.disabled = !state.canRedo; undo.textContent = state.undoLabel ? `Undo ${state.undoLabel}` : "Undo"; redo.textContent = state.redoLabel ? `Redo ${state.redoLabel}` : "Redo"; };
  undo.onclick = () => { const value = history.undo(); try { apply(value); status.textContent = "Edit undone."; } catch { status.textContent = "Could not apply the restored editor value."; } };
  redo.onclick = () => { const value = history.redo(); try { apply(value); status.textContent = "Edit redone."; } catch { status.textContent = "Could not apply the restored editor value."; } };
  const unsubscribe = history.subscribe(render); panel.append(undo,redo,status); container.append(panel); render(); return () => { unsubscribe(); panel.remove(); };
}
