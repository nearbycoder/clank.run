export type VirtualKey = string | number;
export interface VirtualItem<Value> { readonly key: VirtualKey; readonly index: number; readonly value: Value; readonly offset: number; }
export interface VirtualSnapshot<Value> { readonly items: readonly VirtualItem<Value>[]; readonly count: number; readonly totalHeight: number; readonly scrollTop: number; readonly activeIndex: number; readonly rowHeight: number; }
export interface VirtualCollection<Value> {
  snapshot(): VirtualSnapshot<Value>;
  setItems(items: readonly Value[]): void;
  setViewport(scrollTop: number, height: number): void;
  focus(index: number): void;
  navigate(key: string): boolean;
  subscribe(listener: () => void): () => void;
}

export declare function createVirtualCollection<Value>(options: { items: readonly Value[]; key: (value: Value) => VirtualKey; rowHeight: number; overscan?: number }): VirtualCollection<Value>;
export interface VirtualRow<Value> { readonly element: HTMLElement; update(value: Value, index: number): void; dispose?(): void; }
export interface MountedVirtualCollection<Value> { readonly model: VirtualCollection<Value>; readonly viewport: HTMLElement; dispose(): void; }

export declare function mountVirtualCollection<Value>(container: HTMLElement, options: { items: readonly Value[]; key: (value: Value) => VirtualKey; rowHeight: number; overscan?: number; label: string; role?: "list" | "grid"; render: (value: Value,index: number) => VirtualRow<Value> }): MountedVirtualCollection<Value>;
