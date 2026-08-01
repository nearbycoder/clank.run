import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
import { type UiManifest } from "./ui-foundation.js";
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
    trigger(options?: { id?: string; controls?: string; agentId?: string; agentLabel?: string }): Record<string, unknown>;
    panel(options?: { id?: string; role?: string; labelledBy?: string }): Record<string, unknown>;
}
export declare function createDisclosure(options: DisclosureOptions): DisclosureController;
export interface PaginationOptions {
    id?: string;
    total: number | ReactiveSignal<number> | Computed<number> | (() => number);
    pageSize?: number;
    initialPage?: number;
    siblingCount?: number;
}
export interface PaginationController {
    readonly id: string;
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
    root(options?: { label?: string }): Record<string, unknown>;
    status(): Record<string, unknown>;
    previousButton(): Record<string, unknown>;
    pageButton(page: number): Record<string, unknown>;
    ellipsis(): Record<string, unknown>;
    nextButton(): Record<string, unknown>;
    pageSizeSelect(): Record<string, unknown>;
    manifest(): UiManifest;
    dispose(): void;
}
export declare function createPagination(options: PaginationOptions): PaginationController;
export declare function clickOutside(handler: (event: PointerEvent) => void): (element: Element) => Cleanup;
export declare function autoFocus(element: Element): Cleanup;
