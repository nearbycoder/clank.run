export type ShortcutPlatform = "mac" | "other";
export interface ShortcutDefinition { id: string; label: string; keys: string | null; run(): void | Promise<void>; when?(): boolean; allowInInputs?: boolean; }
export interface ShortcutBinding { id: string; label: string; keys: string | null; defaultKeys: string | null; }
export interface ShortcutManager { list(): readonly ShortcutBinding[]; setBinding(id: string, keys: string | null): void; reset(): void; serialize(): string; restore(snapshot: string): void; dispose(): void; }
export interface ShortcutOptions { platform?: ShortcutPlatform; scope?: HTMLElement; storage?: Pick<Storage, "getItem" | "setItem">; storageKey?: string; onError?(error: unknown): void; }
const namedKeys: Record<string,string> = { space: "Space", enter:"Enter", escape:"Escape", arrowup:"ArrowUp", arrowdown:"ArrowDown", arrowleft:"ArrowLeft", arrowright:"ArrowRight", home:"Home", end:"End", pageup:"PageUp", pagedown:"PageDown", delete:"Delete", backspace:"Backspace" };
export function normalizeShortcut(value: string, platform: ShortcutPlatform = "other"): string {
  if (platform !== "mac" && platform !== "other") throw new TypeError("Invalid shortcut platform."); if (typeof value !== "string" || value.length > 80) throw new TypeError("Invalid shortcut."); const tokens = value.split("+").map(token=>token.trim()), raw = tokens.pop()!; if (!raw || !tokens.length) throw new TypeError("Shortcuts require a modifier and key.");
  const modifiers = new Set<string>(); for (const token of tokens) { const key = token.toLowerCase(), modifier = key === "mod" ? platform === "mac" ? "Meta" : "Ctrl" : ({ctrl:"Ctrl",meta:"Meta",alt:"Alt",shift:"Shift"} as Record<string,string>)[key]; if (!modifier || modifiers.has(modifier)) throw new TypeError("Invalid or duplicate shortcut modifier."); modifiers.add(modifier); }
  if (!["Ctrl","Meta","Alt"].some(key=>modifiers.has(key))) throw new TypeError("Use Ctrl, Meta, Alt, or Mod to avoid intercepting typing.");
  const key = /^[a-z0-9,./;[\]\-=`]$/iu.test(raw) ? raw.toLowerCase() : /^f(?:[1-9]|1[0-2])$/iu.test(raw) ? raw.toUpperCase() : namedKeys[raw.toLowerCase()]; if (!key) throw new TypeError("Unsupported shortcut key."); return [...["Ctrl","Meta","Alt","Shift"].filter(key=>modifiers.has(key)),key].join("+");
}
export function matchesShortcut(event: Pick<KeyboardEvent,"key"|"ctrlKey"|"metaKey"|"altKey"|"shiftKey">, shortcut: string, platform: ShortcutPlatform = "other"): boolean {
  const parts = normalizeShortcut(shortcut,platform).split("+"), key = parts.pop()!, actual = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return actual === key && event.ctrlKey === parts.includes("Ctrl") && event.metaKey === parts.includes("Meta") && event.altKey === parts.includes("Alt") && event.shiftKey === parts.includes("Shift");
}
export function createShortcutManager(document: Document, definitions: readonly ShortcutDefinition[], options: ShortcutOptions = {}): ShortcutManager {
  const platform = options.platform ?? (/Mac|iPhone|iPad/u.test(document.defaultView?.navigator.platform ?? "") ? "mac" : "other"), catalog = new Map<string,ShortcutDefinition>();
  if (!Array.isArray(definitions) || definitions.length > 100) throw new TypeError("At most 100 shortcuts are supported.");
  for (const definition of definitions) { if (!definition || !definition.id || definition.id.length > 100 || catalog.has(definition.id) || !definition.label || definition.label.length > 100 || typeof definition.run !== "function" || (definition.when !== undefined && typeof definition.when !== "function")) throw new TypeError("Invalid shortcut definition."); catalog.set(definition.id,{...definition}); }
  const validate = (bindings: Map<string,string|null>) => { const chords = new Set<string>(), result = new Map<string,string|null>(); for (const [id,keys] of bindings) { if (!catalog.has(id)) throw new TypeError("Unknown shortcut."); const normalized = keys === null ? null : normalizeShortcut(keys,platform); if (normalized && chords.has(normalized)) throw new Error("Shortcut conflicts with another action."); if (normalized) chords.add(normalized); result.set(id,normalized); } if (result.size !== catalog.size) throw new TypeError("Missing shortcut binding."); return result; };
  const defaults = validate(new Map([...catalog].map(([id,definition])=>[id,definition.keys]))); let bindings = new Map(defaults), closed = false; const pending = new Set<string>();
  if (options.storage && (!options.storageKey || options.storageKey.length > 200)) throw new TypeError("A bounded storage key is required.");
  const encode = (value: Map<string,string|null>) => JSON.stringify({version:1,bindings:Object.fromEntries(value)});
  const apply = (next: Map<string,string|null>, persist = true) => { const validated = validate(next); if (persist && options.storage) options.storage.setItem(options.storageKey!,encode(validated)); bindings = validated; };
  const decode = (snapshot: string) => { if (typeof snapshot !== "string" || snapshot.length > 30000) throw new TypeError("Shortcut settings are too large."); const data = JSON.parse(snapshot); if (!data || data.version !== 1 || !data.bindings || Array.isArray(data.bindings) || typeof data.bindings !== "object") throw new TypeError("Invalid shortcut settings."); return new Map(Object.entries(data.bindings) as [string,string|null][]); };
  const error = (value: unknown) => { try { options.onError?.(value); } catch {} };
  if (options.storage) { try { const saved = options.storage.getItem(options.storageKey!); if (saved) apply(decode(saved),false); } catch (cause) { error(cause); } }
  const listener = (event: KeyboardEvent) => {
    if (closed || event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState("AltGraph")) return; const path = event.composedPath(), target = path[0] as Element | undefined;
    if (options.scope && !path.includes(options.scope) && (!target || !options.scope.contains(target))) return;
    const editing = path.some(node => node && typeof (node as Element).closest === "function" && (node as Element).closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
    for (const [id,keys] of bindings) { if (!keys || !matchesShortcut(event,keys,platform)) continue; const definition = catalog.get(id)!; if ((editing && !definition.allowInInputs) || pending.has(id)) return;
      try { if (definition.when && !definition.when()) return; event.preventDefault(); pending.add(id); Promise.resolve(definition.run()).catch(error).finally(()=>pending.delete(id)); } catch (cause) { pending.delete(id); error(cause); } return;
    }
  };
  document.addEventListener("keydown",listener);
  return { list: () => [...catalog].map(([id,definition])=>({id,label:definition.label,keys:bindings.get(id)!,defaultKeys:defaults.get(id)!})), setBinding(id,keys) { if (closed) throw new Error("Shortcut manager is closed."); const next = new Map(bindings); next.set(id,keys); apply(next); }, reset() { if (closed) throw new Error("Shortcut manager is closed."); apply(new Map(defaults)); }, serialize:()=>encode(bindings), restore(snapshot) { if (closed) throw new Error("Shortcut manager is closed."); apply(decode(snapshot)); }, dispose() { closed = true; document.removeEventListener("keydown",listener); } };
}
export function mountShortcutSettings(container: HTMLElement, manager: ShortcutManager): () => void {
  const doc = container.ownerDocument, panel = doc.createElement("section"), list = doc.createElement("div"), status = doc.createElement("p"); panel.setAttribute("aria-label","Keyboard shortcuts"); status.setAttribute("role","status");
  const run = (action: () => void) => { try { action(); render(); status.textContent = "Shortcut settings saved."; } catch { status.textContent = "Could not save. Use a supported modifier and key, avoid duplicates, and check device storage."; } };
  const button = (text: string, action: () => void) => { const node = doc.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = () => run(action); return node; };
  const render = () => { list.replaceChildren(); for (const binding of manager.list()) { const row = doc.createElement("div"), label = doc.createElement("label"), input = doc.createElement("input"); input.value = binding.keys ?? ""; input.maxLength = 80; input.setAttribute("aria-label",`${binding.label} shortcut`); label.append(binding.label,input); row.append(label,button("Save binding",()=>manager.setBinding(binding.id,input.value.trim() || null)),button("Disable",()=>manager.setBinding(binding.id,null))); list.append(row); } };
  panel.append(list,status,button("Reset shortcuts",()=>manager.reset())); container.append(panel); render(); return () => panel.remove();
}
