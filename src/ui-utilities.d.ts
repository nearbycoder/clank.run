import { type Computed, type ReactiveSignal } from "./core.js";
import { type DirectionInput, type Orientation, type UiManifest } from "./ui-foundation.js";
export type ScrollAreaScrollbarMode = "hide" | "hidden" | "auto" | "always";
export type RtlScrollBehavior = "negative" | "positive-ascending" | "positive-descending";
export interface ScrollAreaResizeObserver {
    observe(target: Element): void;
    unobserve?(target: Element): void;
    disconnect(): void;
}
export interface ScrollAreaOptions {
    id: string;
    direction?: DirectionInput;
    scrollbarMode?: ScrollAreaScrollbarMode;
    minThumbSize?: number;
    viewportTabIndex?: number;
    label?: string;
    labelledBy?: string;
    /** Override used by tests or non-window DOM adapters. */
    createResizeObserver?: (callback: ResizeObserverCallback) => ScrollAreaResizeObserver;
    /** Override browser RTL behavior when adapting a non-browser DOM. */
    rtlScrollBehavior?: RtlScrollBehavior;
}
export interface ScrollAreaScrollbarOptions {
    label?: string;
    labelledBy?: string;
}
export interface ScrollAreaController {
    readonly id: string;
    readonly overflowX: ReactiveSignal<boolean>;
    readonly overflowY: ReactiveSignal<boolean>;
    /** Logical inline offset: zero is inline-start in both LTR and RTL. */
    readonly scrollX: ReactiveSignal<number>;
    readonly scrollY: ReactiveSignal<number>;
    readonly maxScrollX: ReactiveSignal<number>;
    readonly maxScrollY: ReactiveSignal<number>;
    root(): Record<string, unknown>;
    viewport(): Record<string, unknown>;
    content(): Record<string, unknown>;
    scrollbar(orientation: Orientation, options?: ScrollAreaScrollbarOptions): Record<string, unknown>;
    thumb(orientation: Orientation): Record<string, unknown>;
    corner(): Record<string, unknown>;
    measure(): void;
    scrollTo(position: {
        left?: number;
        top?: number;
        behavior?: ScrollBehavior;
    }): void;
    manifest(): UiManifest;
    dispose(): void;
}
/**
 * Native scrolling with optional styled scrollbars. Custom tracks mirror the
 * viewport instead of replacing it, preserving touch, keyboard, and assistive
 * technology behavior.
 */
export declare function createScrollArea(options: ScrollAreaOptions): ScrollAreaController;
export type ToastPriority = "polite" | "assertive";
export type ToastState = "queued" | "starting" | "open" | "ending";
export type ToastCloseReason = "timeout" | "close-button" | "action" | "escape-key" | "swipe" | "programmatic" | "dismiss-all";
export type ToastSwipeDirection = "left" | "right" | "up" | "down";
export interface ToastAction {
    label: string;
    altText?: string;
    dismiss?: boolean;
    onPress?: (event?: Event) => void;
}
export interface ToastAnchorMetadata {
    id?: string;
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    x?: number;
    y?: number;
}
export interface ToastInput {
    id?: string;
    dedupeKey?: string;
    title?: string;
    description?: string;
    priority?: ToastPriority;
    duration?: number;
    action?: ToastAction;
    anchor?: ToastAnchorMetadata;
    metadata?: Readonly<Record<string, string | number | boolean | null>>;
    onClose?: (reason: ToastCloseReason) => void;
}
export interface ToastUpdate {
    dedupeKey?: string | null;
    title?: string | null;
    description?: string | null;
    priority?: ToastPriority;
    duration?: number;
    action?: ToastAction | null;
    anchor?: ToastAnchorMetadata | null;
    metadata?: Readonly<Record<string, string | number | boolean | null>> | null;
    onClose?: ((reason: ToastCloseReason) => void) | null;
}
export interface ToastRecord {
    readonly id: string;
    readonly dedupeKey?: string;
    readonly title?: string;
    readonly description?: string;
    readonly priority: ToastPriority;
    readonly duration: number;
    readonly action?: Readonly<ToastAction>;
    readonly anchor?: Readonly<ToastAnchorMetadata>;
    readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
    readonly state: ToastState;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly visibleIndex: number;
    readonly queuedIndex: number;
    readonly paused: boolean;
    readonly swipeX: number;
    readonly swipeY: number;
    readonly swipeDirection?: ToastSwipeDirection;
}
export interface ToastClock {
    now(): number;
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(handle: unknown): void;
    queueMicrotask?(callback: () => void): void;
}
export interface ToastManagerOptions {
    id?: string;
    limit?: number;
    duration?: number;
    exitDuration?: number;
    clock?: ToastClock;
    onChange?: (toasts: readonly ToastRecord[]) => void;
}
export type ToastMessage<Value = unknown> = string | ToastUpdate | ((value: Value) => string | ToastUpdate);
export interface ToastPromiseMessages<Value> {
    loading: string | ToastUpdate;
    success: ToastMessage<Value>;
    error: ToastMessage<unknown>;
}
export interface ToastPromiseOptions extends Omit<ToastInput, "title" | "description" | "action"> {
}
export type ToastPromise<Value> = Promise<Value> & {
    readonly toastId: string;
};
export interface ToastManager {
    readonly id: string;
    readonly toasts: ReactiveSignal<readonly ToastRecord[]>;
    readonly visible: Computed<readonly ToastRecord[]>;
    readonly queued: Computed<readonly ToastRecord[]>;
    readonly paused: Computed<boolean>;
    add(input: string | ToastInput): string;
    update(id: string, update: string | ToastUpdate): boolean;
    close(id: string, reason?: ToastCloseReason): boolean;
    dismissAll(reason?: ToastCloseReason): number;
    get(id: string): ToastRecord | undefined;
    pause(reason?: string): void;
    resume(reason?: string): void;
    promise<Value>(promise: PromiseLike<Value> | (() => PromiseLike<Value>), messages: ToastPromiseMessages<Value>, options?: ToastPromiseOptions): ToastPromise<Value>;
    manifest(): UiManifest;
    dispose(): void;
}
/** A renderer-independent toast store with deterministic queue and timer behavior. */
export declare function createToastManager(options?: ToastManagerOptions): ToastManager;
export interface ToastProviderOptions {
    id?: string;
    manager?: ToastManager;
    limit?: number;
    duration?: number;
    exitDuration?: number;
    label?: string;
    swipeDirection?: ToastSwipeDirection;
    swipeThreshold?: number;
    swipeVelocity?: number;
    gap?: number;
}
export interface ToastProviderController {
    readonly id: string;
    readonly manager: ToastManager;
    provider(): Record<string, unknown>;
    portal(): Record<string, unknown>;
    viewport(): Record<string, unknown>;
    positioner(id: string): Record<string, unknown>;
    root(id: string): Record<string, unknown>;
    content(id: string): Record<string, unknown>;
    title(id: string): Record<string, unknown>;
    description(id: string): Record<string, unknown>;
    action(id: string): Record<string, unknown>;
    close(id: string): Record<string, unknown>;
    arrow(id: string): Record<string, unknown>;
    manifest(id?: string): UiManifest;
    dispose(): void;
}
/** DOM part props and keyboard/focus coordination for a ToastManager. */
export declare function createToastProvider(options?: ToastProviderOptions): ToastProviderController;
