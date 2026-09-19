export type DraftValue = null | boolean | number | string | readonly DraftValue[] | { readonly [key: string]: DraftValue };
export interface Draft { key: string; value: DraftValue; revision: string; savedAt: number; expiresAt: number; }
export interface DraftStore { load(key: string): Promise<Draft | null>; save(key: string, value: DraftValue, expectedRevision: string | null, ttlMs?: number): Promise<Draft>; remove(key: string, expectedRevision: string): Promise<void>; prune(): Promise<number>; close(): void; }
export type DraftStatus = "idle" | "available" | "saving" | "saved" | "conflict" | "error";
export interface DraftSession { changed(): void; flush(): Promise<void>; recover(): Promise<boolean>; discard(): Promise<void>; status(): DraftStatus; dispose(): void; }
export interface DraftSessionOptions { store: DraftStore; key: string; read(): DraftValue; write(value: DraftValue): void; onStatus?(status: DraftStatus): void; debounceMs?: number; ttlMs?: number; }
export declare function validateDraft(value: unknown): DraftValue;
export declare function openDraftStore(name?: string): Promise<DraftStore>;
export declare function createDraftSession(options: DraftSessionOptions): Promise<DraftSession>;
export declare function mountDraftRecovery(container: HTMLElement, options: DraftSessionOptions): Promise<DraftSession>;
