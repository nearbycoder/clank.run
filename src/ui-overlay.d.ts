import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
export type OverlayDismissReason = "escape-key" | "outside-press" | "focus-out" | "backdrop-press" | "programmatic";
export type OverlayModality = boolean | "trap-focus";
export type FocusTarget = HTMLElement | null | (() => HTMLElement | null);
export type AutoFocusPolicy = boolean | (() => boolean);
export interface OverlayOptions { open: boolean | ReactiveSignal<boolean> | Computed<boolean> | (() => boolean); onDismiss(reason: OverlayDismissReason, event?: Event): void; modal?: OverlayModality; closeOnEscape?: boolean; closeOnOutsidePress?: boolean; closeOnFocusOutside?: boolean; restoreFocus?: boolean | ((reason?: OverlayDismissReason) => boolean); autoFocus?: AutoFocusPolicy; initialFocus?: FocusTarget | false; finalFocus?: FocusTarget; trigger?: FocusTarget; lockScroll?: boolean; }
export interface OverlayController { readonly active: Computed<boolean>; readonly topmost: ReactiveSignal<boolean>; content(options?: { role?: string; tabIndex?: number | false }): Record<string, unknown>; backdrop(options?: { dismiss?: boolean }): Record<string, unknown>; /** Register a detached subtree; interaction-only branches do not join modal focus or inert boundaries. */ branch(element: Element, options?: { interactionOnly?: boolean }): Cleanup; branchProps(): Record<string, unknown>; dismiss(reason?: OverlayDismissReason, event?: Event): void; dispose(): void; }
export declare function createOverlay(options: OverlayOptions): OverlayController;
export declare function focusableElements(root: HTMLElement): HTMLElement[];
export declare function isFocusable(element: HTMLElement): boolean;
export type FloatingSide = "top" | "right" | "bottom" | "left";
export type FloatingAlign = "start" | "center" | "end";
export type FloatingStrategy = "fixed" | "absolute";
export interface VirtualAnchor { getBoundingClientRect(): DOMRect | DOMRectReadOnly; contextElement?: Element; }
export type FloatingAnchor = Element | VirtualAnchor | null | (() => Element | VirtualAnchor | null);
export interface FloatingOptions { anchor: FloatingAnchor; side?: FloatingSide; align?: FloatingAlign; sideOffset?: number; alignOffset?: number; collisionPadding?: number; arrowPadding?: number; avoidCollisions?: boolean; strategy?: FloatingStrategy; direction?: "ltr" | "rtl"; }
export interface FloatingController { readonly x: ReactiveSignal<number>; readonly y: ReactiveSignal<number>; readonly side: ReactiveSignal<FloatingSide>; readonly align: ReactiveSignal<FloatingAlign>; readonly arrowX: ReactiveSignal<number | null>; readonly arrowY: ReactiveSignal<number | null>; readonly availableWidth: ReactiveSignal<number>; readonly availableHeight: ReactiveSignal<number>; update(): void; positioner(): Record<string, unknown>; arrow(): Record<string, unknown>; dispose(): void; }
export declare function createFloating(options: FloatingOptions): FloatingController;
export type PresenceState = "open" | "closed" | "starting" | "ending";
export interface PresenceOptions { present: boolean | ReactiveSignal<boolean> | Computed<boolean> | (() => boolean); keepMounted?: boolean; onExitComplete?: () => void; }
export interface PresenceController { readonly mounted: ReactiveSignal<boolean>; readonly state: ReactiveSignal<PresenceState>; props(): Record<string, unknown>; finish(): void; dispose(): void; }
export declare function createPresence(options: PresenceOptions): PresenceController;
