export type ShortcutPlatform = "mac" | "other";
export interface ShortcutDefinition { id: string; label: string; keys: string | null; run(): void | Promise<void>; when?(): boolean; allowInInputs?: boolean; }
export interface ShortcutBinding { id: string; label: string; keys: string | null; defaultKeys: string | null; }
export interface ShortcutManager { list(): readonly ShortcutBinding[]; setBinding(id: string, keys: string | null): void; reset(): void; serialize(): string; restore(snapshot: string): void; dispose(): void; }
export interface ShortcutOptions { platform?: ShortcutPlatform; scope?: HTMLElement; storage?: Pick<Storage, "getItem" | "setItem">; storageKey?: string; onError?(error: unknown): void; }
export declare function normalizeShortcut(value: string, platform?: ShortcutPlatform): string;
export declare function matchesShortcut(event: Pick<KeyboardEvent,"key"|"ctrlKey"|"metaKey"|"altKey"|"shiftKey">, shortcut: string, platform?: ShortcutPlatform): boolean;
export declare function createShortcutManager(document: Document, definitions: readonly ShortcutDefinition[], options?: ShortcutOptions): ShortcutManager;
export declare function mountShortcutSettings(container: HTMLElement, manager: ShortcutManager): () => void;
