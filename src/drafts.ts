export type DraftValue = null | boolean | number | string | readonly DraftValue[] | { readonly [key: string]: DraftValue };
export interface Draft { key: string; value: DraftValue; revision: string; savedAt: number; expiresAt: number; }
export interface DraftStore { load(key: string): Promise<Draft | null>; save(key: string, value: DraftValue, expectedRevision: string | null, ttlMs?: number): Promise<Draft>; remove(key: string, expectedRevision: string): Promise<void>; prune(): Promise<number>; close(): void; }
export type DraftStatus = "idle" | "available" | "saving" | "saved" | "conflict" | "error";
export interface DraftSession { changed(): void; flush(): Promise<void>; recover(): Promise<boolean>; discard(): Promise<void>; status(): DraftStatus; dispose(): void; }
export interface DraftSessionOptions { store: DraftStore; key: string; read(): DraftValue; write(value: DraftValue): void; onStatus?(status: DraftStatus): void; debounceMs?: number; ttlMs?: number; }
/** Bounded JSON snapshots; reject data that JSON would silently alter. */
export function validateDraft(value: unknown): DraftValue {
  const seen = new Set<object>(); let nodes = 0;
  const walk = (input: unknown, depth: number): void => { if (++nodes > 10000 || depth > 20) throw new TypeError("Draft is too complex."); if (input === null || typeof input === "string" || typeof input === "boolean") return; if (typeof input === "number" && Number.isFinite(input)) return;
    if (typeof input !== "object" || !input || seen.has(input)) throw new TypeError("Draft must contain finite JSON values.");
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError("Draft must contain plain objects."); seen.add(input);
    if (Object.getOwnPropertySymbols(input).length) throw new TypeError("Draft cannot contain symbol keys.");
    if (Array.isArray(input) && (Object.keys(input).length !== input.length || Array.from({ length: input.length }, (_, index) => index).some(index => !Object.hasOwn(input, index)))) throw new TypeError("Draft arrays must be dense.");
    for (const key of Object.keys(input)) { const property = Object.getOwnPropertyDescriptor(input, key)!; if (!Object.hasOwn(property, "value")) throw new TypeError("Draft cannot contain getters."); walk(property.value, depth + 1); } seen.delete(input);
  }; walk(value, 0); const text = JSON.stringify(value); if (new TextEncoder().encode(text).byteLength > 65536) throw new RangeError("Draft exceeds 64 KiB."); return JSON.parse(text) as DraftValue;
}
function keyValue(key: string): string { if (typeof key !== "string" || !key.trim() || key.length > 200) throw new TypeError("Draft key must be 1–200 characters."); return key; }
/** IndexedDB read/write transactions fence concurrent tabs; no network storage is used. */
export async function openDraftStore(name = "clank-drafts"): Promise<DraftStore> {
  if (!name || name.length > 100) throw new TypeError("Invalid draft database name.");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => { request.result.createObjectStore("drafts", { keyPath: "key" }); }; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Close older draft connections and retry.")); request.onsuccess = () => resolve(request.result); });
  let closed = false; db.onversionchange = () => { closed = true; db.close(); };
  const transaction = <T>(action: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Draft store is closed.")); return; } const tx = db.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"); let value: T, failure: Error | undefined;
    tx.oncomplete = () => resolve(value); tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error("Draft transaction failed."));
    const fail = (error: Error) => { failure = error; tx.abort(); }; try { action(store, result => { value = result; }, fail); } catch (error) { fail(error as Error); }
  });
  return {
    load(key) { keyValue(key); return transaction((store, finish) => { const request = store.get(key); request.onsuccess = () => { const row = request.result as Draft | undefined; if (row && row.expiresAt <= Date.now()) { store.delete(key); finish(null); } else finish(row ?? null); }; }); },
    save(key, value, expectedRevision, ttlMs = 7 * 86400000) {
      keyValue(key); const snapshot = validateDraft(value); if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000 || (expectedRevision !== null && (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision.length > 128))) return Promise.reject(new TypeError("Invalid draft expiry or revision."));
      return transaction((store, finish, fail) => { const get = store.get(key); get.onsuccess = () => { const existing = get.result as Draft | undefined, now = Date.now(), current = existing && existing.expiresAt > now ? existing : undefined;
        if ((current?.revision ?? null) !== expectedRevision) { fail(new Error("Draft conflict: another session changed this draft.")); return; }
        const count = store.count(); count.onsuccess = () => { if (!existing && count.result >= 200) { fail(new Error("Draft limit reached. Prune expired drafts first.")); return; } const row = { key, value: snapshot, revision: crypto.randomUUID(), savedAt: now, expiresAt: now + ttlMs }; store.put(row); finish(row); };
      }; });
    },
    remove(key, expectedRevision) { keyValue(key); return transaction((store, finish, fail) => { const get = store.get(key); get.onsuccess = () => { const row = get.result as Draft | undefined; if (row && row.revision !== expectedRevision) { fail(new Error("Draft conflict: refresh before discarding.")); return; } if (row) store.delete(key); finish(undefined); }; }); },
    prune() { return transaction((store, finish) => { let count = 0; const request = store.openCursor(), now = Date.now(); request.onsuccess = () => { const cursor = request.result; if (!cursor) { finish(count); return; } if ((cursor.value as Draft).expiresAt <= now) { cursor.delete(); count++; } cursor.continue(); }; }); },
    close() { closed = true; db.close(); },
  };
}
/** Existing drafts require explicit recovery or discard before autosaving this session. */
export async function createDraftSession(options: DraftSessionOptions): Promise<DraftSession> {
  keyValue(options.key); const delay = options.debounceMs ?? 500; if (!Number.isInteger(delay) || delay < 0 || delay > 10000) throw new TypeError("Invalid autosave delay.");
  let pending = await options.store.load(options.key), revision = pending?.revision ?? null, state: DraftStatus = pending ? "available" : "idle", closed = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined, queue = Promise.resolve();
  const status = (next: DraftStatus) => { state = next; if (!closed) options.onStatus?.(next); }; status(state);
  const enqueue = (action: () => Promise<void>) => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const flush = () => enqueue(async () => { if (closed || pending || !dirty || state === "conflict") return; dirty = false; status("saving"); try { const saved = await options.store.save(options.key, validateDraft(options.read()), revision, options.ttlMs); revision = saved.revision; status("saved"); } catch (error) { dirty = true; status(error instanceof Error && error.message.includes("conflict") ? "conflict" : "error"); throw error; } });
  return {
    changed() { if (closed) return; dirty = true; clearTimeout(timer); if (!pending && state !== "conflict") timer = setTimeout(() => { void flush().catch(() => {}); }, delay); },
    flush,
    recover() { let recovered = false; return enqueue(async () => { if (closed) return; const latest = await options.store.load(options.key); if (!latest) { pending = null; revision = null; dirty = false; status("idle"); return; } options.write(validateDraft(latest.value)); revision = latest.revision; pending = null; dirty = false; status("saved"); recovered = true; }).then(() => recovered); },
    discard() { return enqueue(async () => { if (closed) return; clearTimeout(timer); if (revision !== null) await options.store.remove(options.key, revision); pending = null; revision = null; dirty = false; status("idle"); }); },
    status: () => state,
    dispose() { closed = true; clearTimeout(timer); },
  };
}
/** Recovery actions and save status for a host editor wired through read/write callbacks. */
export async function mountDraftRecovery(container: HTMLElement, options: DraftSessionOptions): Promise<DraftSession> {
  const doc = container.ownerDocument, panel = doc.createElement("section"), message = doc.createElement("p"), recover = doc.createElement("button"), discard = doc.createElement("button"); panel.setAttribute("aria-label", "Draft recovery"); message.setAttribute("role", "status"); recover.type = discard.type = "button"; recover.textContent = "Recover saved draft"; discard.textContent = "Discard saved draft"; panel.append(message,recover,discard); container.append(panel);
  let session: DraftSession; try { session = await createDraftSession({ ...options, onStatus(state) { message.textContent = ({ idle: "No saved draft.", available: "A saved draft is available. Recover or discard it before autosaving.", saving: "Saving draft on this device…", saved: "Draft saved on this device.", conflict: "Another tab changed the draft. Recover its latest version before saving.", error: "Draft could not be saved. Check device storage and retry." })[state]; recover.hidden = state !== "available" && state !== "conflict"; options.onStatus?.(state); } }); } catch (error) { panel.remove(); throw error; }
  const action = async (run: () => Promise<unknown>) => { recover.disabled = discard.disabled = true; try { await run(); } catch { message.textContent = "Draft changed or storage is unavailable. Your editor content was preserved."; } finally { recover.disabled = discard.disabled = false; } };
  recover.onclick = () => { void action(() => session.recover()); }; discard.onclick = () => { void action(() => session.discard()); }; return { ...session, dispose() { session.dispose(); panel.remove(); } };
}
