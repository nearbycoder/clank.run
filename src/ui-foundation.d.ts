import { type Cleanup, type Computed } from "./core.js";

/** Metadata passed to controlled and uncontrolled state change callbacks. */
export interface ChangeDetails<Reason extends string = string> {
    readonly reason: Reason;
    readonly event?: Event;
    readonly canceled: boolean;
    cancel(): void;
}
export declare function createChangeDetails<Reason extends string>(reason: Reason, event?: Event): ChangeDetails<Reason>;

export interface ControllableStateOptions<Value, Reason extends string = string> {
    value?: Value | (() => Value);
    defaultValue: Value;
    onValueChange?: (value: Value, details: ChangeDetails<Reason>) => void;
    equals?: (previous: Value, next: Value) => boolean;
    name?: string;
}
export interface ControllableState<Value, Reason extends string = string> {
    readonly value: Computed<Value>;
    set(next: Value, reason: Reason, event?: Event): boolean;
    reset(reason?: Reason, event?: Event): boolean;
}
export declare function createControllableState<Value, Reason extends string = string>(options: ControllableStateOptions<Value, Reason>): ControllableState<Value, Reason>;

export type UiEventHandler<EventType extends Event = Event> = (event: EventType) => void | boolean;
export declare function isEventCanceled(event: Event | {
    defaultPrevented?: boolean;
    canceled?: boolean;
    detail?: unknown;
}): boolean;
export declare function composeEventHandlers<EventType extends Event>(...handlers: Array<UiEventHandler<EventType> | null | undefined | false>): UiEventHandler<EventType>;

export type UiProps = Record<string, unknown>;
export declare function mergeProps(...sources: Array<UiProps | null | undefined | false>): UiProps;

export type UiRef<Value> = ((value: Value | null) => void | Cleanup) | {
    current: Value | null;
} | null | undefined;
export declare function mergeRefs<Value>(...refs: Array<UiRef<Value>>): (value: Value | null) => void;

export interface IdScope {
    readonly prefix: string;
    id(part?: string): string;
    child(part: string): IdScope;
}
export declare function createIdScope(prefix: string, seed?: string | number): IdScope;
export declare const createUiIdScope: typeof createIdScope;
export declare function createUiId(scope: IdScope, part?: string): string;

export interface UiPartManifest {
    name: string;
    role?: string;
    defaultElement?: string;
    required?: boolean;
}
export interface UiActionManifest {
    name: string;
    description: string;
    sideEffects: "none" | "read" | "write";
    reasons?: readonly string[];
}
export interface UiManifest {
    protocol: "clank-ui/1";
    component: string;
    id: string;
    state: Readonly<Record<string, unknown>>;
    parts: readonly Readonly<UiPartManifest>[];
    actions: readonly Readonly<UiActionManifest>[];
    keyboard?: Readonly<Record<string, string>>;
}
export type UiManifestInput = Omit<UiManifest, "protocol"> & {
    protocol?: "clank-ui/1";
};
export declare function createUiManifest(input: UiManifestInput): UiManifest;

export type Direction = "ltr" | "rtl";
export type DirectionInput = Direction | "auto" | null | undefined;
export type Orientation = "horizontal" | "vertical";
export type PhysicalSide = "top" | "right" | "bottom" | "left";
export type LogicalSide = PhysicalSide | "inline-start" | "inline-end" | "block-start" | "block-end";
export declare function resolveDirection(direction?: DirectionInput, element?: Element | null): Direction;
export declare function isRtl(direction?: DirectionInput, element?: Element | null): boolean;
export declare function resolveLogicalSide(side: LogicalSide, direction?: Direction): PhysicalSide;

export declare function getOwnerDocument(target?: unknown): Document | null;
export declare function getComposedPath(event: Event): EventTarget[];
export declare function containsEventTarget(container: Node | null | undefined, event: Event): boolean;

export interface FocusableElementsOptions {
    includeRoot?: boolean;
    tabbable?: boolean;
}
export declare function isFocusable(element: Element, options?: FocusableElementsOptions): element is HTMLElement;
export declare function focusableElements(root: ParentNode, options?: FocusableElementsOptions): HTMLElement[];
export interface FocusFirstOptions extends FocusableElementsOptions {
    preventScroll?: boolean;
    select?: boolean;
    fallback?: HTMLElement | null;
}
export declare function focusFirst(rootOrElements: ParentNode | Iterable<HTMLElement>, options?: FocusFirstOptions): HTMLElement | null;

export type CollectionNavigationIntent = "next" | "previous" | "first" | "last" | "page-next" | "page-previous";
export interface CollectionNavigationOptions<Item> {
    loop?: boolean;
    pageSize?: number;
    disabled?: (item: Item, index: number) => boolean;
}
export declare function getCollectionNavigationIntent(key: string, orientation?: Orientation, direction?: Direction): CollectionNavigationIntent | null;
export declare function findCollectionIndex<Item>(items: readonly Item[], currentIndex: number, intent: CollectionNavigationIntent, options?: CollectionNavigationOptions<Item>): number;

export interface TypeaheadOptions<Item> {
    timeout?: number;
    textValue?: (item: Item, index: number) => string;
    disabled?: (item: Item, index: number) => boolean;
    locale?: string | string[];
    now?: () => number;
}
export interface TypeaheadController<Item> {
    readonly query: string;
    search(key: string, items: readonly Item[], currentIndex?: number): number;
    reset(): void;
    dispose(): void;
}
export declare function findTypeaheadMatch<Item>(items: readonly Item[], query: string, currentIndex?: number, options?: Omit<TypeaheadOptions<Item>, "timeout" | "now">): number;
export declare function createTypeahead<Item>(options?: TypeaheadOptions<Item>): TypeaheadController<Item>;

export type DataFlagValue = string | number | boolean | null | undefined;
export declare function dataState(state: string, flags?: Record<string, DataFlagValue>): Record<string, string | number | undefined>;
