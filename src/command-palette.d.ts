export interface PaletteCommand { id: string; title: string; category?: string; keywords?: readonly string[]; enabled?: () => boolean; run(context: { signal: AbortSignal }): void | Promise<void>; }
export interface CommandPalette { open(): void; close(): void; setCommands(commands: readonly PaletteCommand[]): void; dispose(): void; }
export declare function searchCommands(commands: readonly PaletteCommand[], query: string, limit?: number): readonly PaletteCommand[];
export declare function mountCommandPalette(container: HTMLElement, commands: readonly PaletteCommand[], options?: { title?: string; onError?(error: unknown): void }): CommandPalette;
