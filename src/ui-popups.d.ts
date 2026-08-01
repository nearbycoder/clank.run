import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
import { type ChangeDetails, type UiManifest } from "./ui-foundation.js";
import { type FloatingAlign, type FloatingSide, type OverlayModality } from "./ui-overlay.js";

export type OpenChangeReason =
  | "trigger-press"
  | "close-press"
  | "escape-key"
  | "outside-press"
  | "focus-out"
  | "backdrop-press"
  | "hover"
  | "focus"
  | "beforematch"
  | "swipe"
  | "programmatic";

export interface CollapsiblePanelOptions {
  id?: string;
  role?: string;
  labelledBy?: string;
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
}

export interface CollapsibleOptions {
  id: string;
  open?: boolean | (() => boolean);
  defaultOpen?: boolean;
  disabled?: boolean | (() => boolean);
  keepMounted?: boolean;
  onOpenChange?: (open: boolean, details: ChangeDetails<OpenChangeReason>) => void;
}
export interface CollapsibleController {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly disabled: Computed<boolean>;
  show(reason?: OpenChangeReason, event?: Event): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  toggle(reason?: OpenChangeReason, event?: Event): boolean;
  trigger(options?: { id?: string; agentId?: string; agentLabel?: string }): Record<string, unknown>;
  isPanelMounted(options?: CollapsiblePanelOptions): boolean;
  panel(options?: CollapsiblePanelOptions): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createCollapsible(options: CollapsibleOptions): CollapsibleController;

export interface PopupOptions {
  id: string;
  open?: boolean | (() => boolean);
  defaultOpen?: boolean;
  /** @deprecated Use defaultOpen. */
  initialOpen?: boolean;
  onOpenChange?: (open: boolean, details: ChangeDetails<OpenChangeReason>) => void;
  /** @deprecated Use onOpenChange. */
  onChange?: (open: boolean) => void;
  modal?: OverlayModality;
  closeOnEscape?: boolean;
  closeOnOutsidePress?: boolean;
  /** @deprecated Use closeOnOutsidePress. */
  closeOnBackdrop?: boolean;
  /**
   * Overrides focus-out dismissal. Nonmodal popups infer true while pointer dismissal is enabled;
   * disabling pointer dismissal also disables that inference unless this is explicitly true.
   */
  closeOnFocusOutside?: boolean;
  restoreFocus?: boolean;
  autoFocus?: boolean | (() => boolean);
  initialFocus?: false | HTMLElement | null | (() => HTMLElement | null);
  finalFocus?: HTMLElement | null | (() => HTMLElement | null);
  lockScroll?: boolean;
  keepMounted?: boolean;
  side?: FloatingSide;
  align?: FloatingAlign;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  avoidCollisions?: boolean;
  direction?: "ltr" | "rtl";
}
export interface PopupPortalOptions { keepMounted?: boolean; }
export interface PopupController {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly triggerElement: ReactiveSignal<HTMLElement | null>;
  show(reason?: OpenChangeReason, event?: Event): boolean;
  show(trigger?: HTMLElement | null, event?: Event): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  toggle(reason?: OpenChangeReason, event?: Event): boolean;
  /**
   * Every trigger receives a unique default id and remains inside the overlay boundary. Only the
   * active trigger reports open; interaction transfers ownership without an intermediate close.
   */
  trigger(options?: { id?: string; agentId?: string; agentLabel?: string; hover?: boolean }): Record<string, unknown>;
  isMounted(options?: PopupPortalOptions): boolean;
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  backdrop(options?: { dismiss?: boolean }): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(options?: {
    role?: string | false;
    labelledBy?: string | false;
    describedBy?: string | false;
    tabIndex?: number | false;
  }): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  title(): Record<string, unknown>;
  description(): Record<string, unknown>;
  close(options?: { agentId?: string; agentLabel?: string }): Record<string, unknown>;
  viewport(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

export interface DialogOptions extends PopupOptions { modal?: OverlayModality; }
export interface DialogController extends PopupController {
  dialog(options?: { labelledBy?: string | false; describedBy?: string | false }): Record<string, unknown>;
}
export declare function createDialog(options: DialogOptions): DialogController;
export declare function createAlertDialog(options: DialogOptions): DialogController;

export interface PopoverOptions extends PopupOptions { openOnHover?: boolean; }
export declare function createPopover(options: PopoverOptions): PopupController;

export interface HoverCardOptions extends PopupOptions {
  openDelay?: number;
  delay?: number;
  closeDelay?: number;
}
export declare function createPreviewCard(options: HoverCardOptions): PopupController;

export interface TooltipOptions extends HoverCardOptions {
  closeOnClick?: boolean;
  disabled?: boolean;
  disableHoverablePopup?: boolean;
  provider?: TooltipProviderController;
}
export interface TooltipProviderOptions {
  id?: string;
  delay?: number;
  closeDelay?: number;
  timeout?: number;
}
export interface TooltipProviderController {
  readonly id: string;
  readonly delay: number | undefined;
  readonly closeDelay: number | undefined;
  readonly timeout: number;
  tooltip(options: Omit<TooltipOptions, "provider">): PopupController;
  provider(): Record<string, unknown>;
  openingDelay(fallback: number): number;
  /** Claims provider ownership only after the tooltip has accepted opening. */
  activate(tooltip: PopupController): void;
  /** Releases ownership only when this tooltip is the accepted active owner. */
  deactivate(tooltip: PopupController): void;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createTooltipProvider(options?: TooltipProviderOptions): TooltipProviderController;
export declare function createTooltip(options: TooltipOptions): PopupController;

export type DrawerDirection = "top" | "right" | "bottom" | "left";
export type DrawerSwipeDirection = "up" | "right" | "down" | "left";
export type DrawerSnapPoint = number | string;
export interface DrawerResolvedSnapPoint {
  readonly value: DrawerSnapPoint;
  readonly size: number;
  readonly offset: number;
}
export interface DrawerMeasurements {
  viewportSize?: number;
  popupSize?: number;
  rootFontSize?: number;
}
export interface DrawerSwipeAreaOptions {
  disabled?: boolean | (() => boolean);
  swipeDirection?: DrawerSwipeDirection;
}
export interface DrawerProviderOptions { id?: string; indent?: number; }
export interface DrawerProviderController {
  readonly id: string;
  readonly depth: ReactiveSignal<number>;
  provider(): Record<string, unknown>;
  indentBackground(): Record<string, unknown>;
  indent(): Record<string, unknown>;
  register(drawer: DrawerController): Cleanup;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createDrawerProvider(options?: DrawerProviderOptions): DrawerProviderController;

export interface DrawerVirtualKeyboardProviderOptions { id?: string; }
export interface DrawerVirtualKeyboardProviderController {
  readonly id: string;
  readonly inset: ReactiveSignal<number>;
  provider(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createDrawerVirtualKeyboardProvider(
  options?: DrawerVirtualKeyboardProviderOptions,
): DrawerVirtualKeyboardProviderController;

export interface DrawerOptions extends Omit<DialogOptions, "direction"> {
  direction?: DrawerDirection;
  swipeDirection?: DrawerSwipeDirection;
  snapPoints?: readonly DrawerSnapPoint[];
  snapPoint?: DrawerSnapPoint | null | (() => DrawerSnapPoint | null);
  defaultSnapPoint?: DrawerSnapPoint | null;
  onSnapPointChange?: (
    snapPoint: DrawerSnapPoint | null,
    details: ChangeDetails<OpenChangeReason>,
  ) => void;
  snapToSequentialPoints?: boolean;
  swipeThreshold?: number;
  dismissible?: boolean;
  disablePointerDismissal?: boolean;
  provider?: DrawerProviderController;
}
export interface DrawerController extends DialogController {
  readonly dragOffset: ReactiveSignal<number>;
  readonly dragging: ReactiveSignal<boolean>;
  readonly swipeStrength: Computed<number>;
  readonly swipeProgress: Computed<number>;
  readonly snapPoint: Computed<DrawerSnapPoint | null>;
  readonly resolvedSnapPoints: Computed<readonly DrawerResolvedSnapPoint[]>;
  readonly snapPointOffset: Computed<number>;
  setSnapPoint(
    snapPoint: DrawerSnapPoint | null,
    reason?: OpenChangeReason,
    event?: Event,
  ): boolean;
  measure(measurements?: DrawerMeasurements): void;
  provider(): Record<string, unknown>;
  indentBackground(): Record<string, unknown>;
  indent(): Record<string, unknown>;
  virtualKeyboardProvider(): Record<string, unknown>;
  content(options?: { swipeIgnore?: boolean }): Record<string, unknown>;
  swipeArea(options?: DrawerSwipeAreaOptions): Record<string, unknown>;
}
export declare function createDrawer(options: DrawerOptions): DrawerController;

export interface BottomSheetOptions extends Omit<DrawerOptions, "direction" | "swipeDirection"> {
  snapPoints?: readonly DrawerSnapPoint[];
}
export interface BottomSheetController extends DrawerController {
  handle(): Record<string, unknown>;
}
export declare function createBottomSheet(options: BottomSheetOptions): BottomSheetController;
