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
export declare function createUndoHistory<T extends UndoValue>(initial: T, options?: UndoOptions): UndoHistory<T>;
export declare function mountUndoControls<T extends UndoValue>(container: HTMLElement, history: UndoHistory<T>, apply: (value: T) => void): () => void;
