import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
export interface DisclosureOptions {
    id: string;
    initialOpen?: boolean;
    disabled?: boolean | (() => boolean);
    onChange?: (open: boolean) => void;
}
export interface DisclosureController {
    readonly id: string;
    readonly open: ReactiveSignal<boolean>;
    readonly disabled: Computed<boolean>;
    show(): void;
    hide(): void;
    toggle(): void;
    trigger(options?: {
        id?: string;
        agentId?: string;
        agentLabel?: string;
    }): Record<string, unknown>;
    panel(options?: {
        id?: string;
        role?: string;
        labelledBy?: string;
    }): Record<string, unknown>;
}
/** Headless state and accessible props for accordions, menus, drawers, and expandable regions. */
export declare function createDisclosure(options: DisclosureOptions): DisclosureController;
export interface DialogOptions {
    id: string;
    initialOpen?: boolean;
    closeOnEscape?: boolean;
    closeOnBackdrop?: boolean;
    restoreFocus?: boolean;
    lockScroll?: boolean;
    onChange?: (open: boolean) => void;
}
export interface DialogController {
    readonly id: string;
    readonly open: ReactiveSignal<boolean>;
    show(trigger?: HTMLElement | null): void;
    hide(): void;
    toggle(trigger?: HTMLElement | null): void;
    trigger(options?: {
        id?: string;
        agentId?: string;
        agentLabel?: string;
    }): Record<string, unknown>;
    dialog(options?: {
        labelledBy?: string;
        describedBy?: string;
    }): Record<string, unknown>;
    backdrop(): Record<string, unknown>;
    title(): Record<string, unknown>;
    description(): Record<string, unknown>;
}
/** Accessible modal-dialog behavior with focus trapping, Escape handling, and focus restoration. */
export declare function createDialog(options: DialogOptions): DialogController;
export interface TabDefinition<Value extends string> {
    value: Value;
    disabled?: boolean;
}
export interface TabsOptions<Value extends string> {
    id: string;
    tabs: readonly TabDefinition<Value>[];
    initial?: Value;
    orientation?: "horizontal" | "vertical";
    activation?: "automatic" | "manual";
    onChange?: (value: Value) => void;
}
export interface TabsController<Value extends string> {
    readonly id: string;
    readonly selected: ReactiveSignal<Value>;
    select(value: Value): void;
    list(): Record<string, unknown>;
    tab(value: Value): Record<string, unknown>;
    panel(value: Value): Record<string, unknown>;
}
/** Headless WAI-ARIA tabs with arrow-key, Home, and End navigation. */
export declare function createTabs<Value extends string>(options: TabsOptions<Value>): TabsController<Value>;
export interface PaginationOptions {
    total: number | ReactiveSignal<number> | Computed<number> | (() => number);
    pageSize?: number;
    initialPage?: number;
    siblingCount?: number;
}
export interface PaginationController {
    readonly page: ReactiveSignal<number>;
    readonly pageSize: ReactiveSignal<number>;
    readonly total: Computed<number>;
    readonly pageCount: Computed<number>;
    readonly start: Computed<number>;
    readonly end: Computed<number>;
    readonly canPrevious: Computed<boolean>;
    readonly canNext: Computed<boolean>;
    readonly pages: Computed<Array<number | "ellipsis">>;
    setPage(page: number): void;
    setPageSize(size: number): void;
    previous(): void;
    next(): void;
    dispose(): void;
}
/** Pagination state with clamping and a compact, UI-ready page range. */
export declare function createPagination(options: PaginationOptions): PaginationController;
/** A directive that invokes a handler for pointer activity outside its element. */
export declare function clickOutside(handler: (event: PointerEvent) => void): (element: Element) => Cleanup;
/** A directive that focuses an element after it has been mounted. */
export declare function autoFocus(element: Element): Cleanup;
