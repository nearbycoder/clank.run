import { computed, effect, signal, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";
import { useDirection } from "./ui-composition.ts";
import {
  createControllableState,
  createUiManifest,
  dataState,
  mergeProps,
  type ChangeDetails,
  type ControllableState,
  type UiManifest,
} from "./ui-foundation.ts";
import {
  createFloating,
  createOverlay,
  createPresence,
  type FloatingAlign,
  type FloatingSide,
  type OverlayController,
  type OverlayDismissReason,
  type OverlayModality,
  type PresenceController,
} from "./ui-overlay.ts";

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
  /** Keep a closed panel mounted and hidden. */
  keepMounted?: boolean;
  /** Keep a closed panel searchable with HTML `hidden="until-found"`. */
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
  /** Tells a renderer whether the panel belongs in the tree, including during exit motion. */
  isPanelMounted(options?: CollapsiblePanelOptions): boolean;
  panel(options?: CollapsiblePanelOptions): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/** Controlled or uncontrolled disclosure behavior used by collapsibles and accordion items. */
export function createCollapsible(options: CollapsibleOptions): CollapsibleController {
  const id = requireId(options.id, "Collapsible");
  const state = createControllableState<boolean, OpenChangeReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "open") ? { value: options.open } : {}),
    defaultValue: Boolean(options.defaultOpen),
    onValueChange: options.onOpenChange,
    name: `${id}.open`,
  });
  const disabled = computed(() => readBoolean(options.disabled ?? false), { name: `${id}.disabled` });
  const presence = createPresence({ present: state.value, keepMounted: options.keepMounted });
  let triggerId = `${id}-trigger`;
  let panelId = `${id}-panel`;
  const set = (next: boolean, reason: OpenChangeReason, event?: Event) => {
    if (disabled.peek()) return false;
    return state.set(next, reason, event);
  };
  const controller: CollapsibleController = {
    id,
    open: state.value,
    disabled,
    show: (reason = "programmatic", event) => set(true, reason, event),
    hide: (reason = "programmatic", event) => set(false, reason, event),
    toggle: (reason = "programmatic", event) => set(!state.value.peek(), reason, event),
    trigger(triggerOptions = {}) {
      if (triggerOptions.id !== undefined) triggerId = requireId(triggerOptions.id, "Collapsible trigger");
      return {
        id: triggerId,
        type: "button",
        "aria-controls": () => panelId,
        "aria-expanded": () => state.value.value,
        disabled: () => disabled.value,
        "data-open": () => state.value.value ? "" : undefined,
        "data-closed": () => state.value.value ? undefined : "",
        "data-disabled": () => disabled.value ? "" : undefined,
        "data-clank-part": "trigger",
        ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
        ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
        onClick: (event: Event) => {
          if (!event.defaultPrevented) controller.toggle("trigger-press", event);
        },
      };
    },
    isPanelMounted(panelOptions = {}) {
      return state.value.value
        || panelOptions.hiddenUntilFound === true
        || (panelOptions.keepMounted ?? options.keepMounted) === true
        || presence.mounted.value;
    },
    panel(panelOptions = {}) {
      if (panelOptions.id !== undefined) panelId = requireId(panelOptions.id, "Collapsible panel");
      const mounted = () => controller.isPanelMounted(panelOptions);
      return mergeProps(presence.props(), {
        id: panelId,
        ...(panelOptions.role ? { role: panelOptions.role } : {}),
        "aria-labelledby": () => panelOptions.labelledBy ?? triggerId,
        hidden: () => state.value.value
          ? false
          : panelOptions.hiddenUntilFound
            ? "until-found"
            : presence.state.value === "closed",
        "data-mounted": () => mounted() ? "" : undefined,
        "data-clank-part": "panel",
        ...(panelOptions.hiddenUntilFound ? {
          onBeforeMatch: (event: Event) => {
            if (!event.defaultPrevented && !state.value.peek()) controller.show("beforematch", event);
          },
        } : {}),
      });
    },
    manifest: () => createUiManifest({
      component: "Collapsible",
      id,
      state: { open: state.value.peek(), disabled: disabled.peek() },
      parts: [
        { name: "trigger", role: "button", defaultElement: "button", required: true },
        { name: "panel", defaultElement: "div", required: true },
      ],
      actions: [
        { name: "show", description: "Open the panel.", sideEffects: "write", reasons: ["programmatic", "beforematch"] },
        { name: "hide", description: "Close the panel.", sideEffects: "write", reasons: ["programmatic"] },
        { name: "toggle", description: "Toggle the panel.", sideEffects: "write", reasons: ["trigger-press"] },
      ],
      keyboard: { Enter: "Toggle from the trigger", Space: "Toggle from the trigger" },
    }),
    dispose: () => presence.dispose(),
  };
  return controller;
}

export interface PopupOptions {
  id: string;
  open?: boolean | (() => boolean);
  defaultOpen?: boolean;
  /** @deprecated Use defaultOpen. Retained for Clank 0.x application compatibility. */
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
  /** Controls whether opening moves focus into the popup. Input-like triggers retain focus by default. */
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

export interface PopupPortalOptions {
  /** Keep a closed popup mounted after any exit animation completes. */
  keepMounted?: boolean;
}

export interface PopupController {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly triggerElement: ReactiveSignal<HTMLElement | null>;
  show(reason?: OpenChangeReason, event?: Event): boolean;
  /** Passing a trigger element preserves the original Clank dialog API. */
  show(trigger?: HTMLElement | null, event?: Event): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  toggle(reason?: OpenChangeReason, event?: Event): boolean;
  /**
   * Every trigger receives a unique default id and remains inside the overlay boundary. Only the
   * active trigger reports open; interaction transfers ownership without an intermediate close.
   */
  trigger(options?: { id?: string; agentId?: string; agentLabel?: string; hover?: boolean }): Record<string, unknown>;
  /** Tells a renderer whether the portal belongs in the tree, including during exit motion. */
  isMounted(options?: PopupPortalOptions): boolean;
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  backdrop(options?: { dismiss?: boolean }): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(options?: { role?: string | false; labelledBy?: string | false; describedBy?: string | false; tabIndex?: number | false }): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  title(): Record<string, unknown>;
  description(): Record<string, unknown>;
  close(options?: { agentId?: string; agentLabel?: string }): Record<string, unknown>;
  viewport(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

interface PopupFactoryOptions extends PopupOptions {
  component: string;
  role?: string;
  positioned?: boolean;
  outsideDismiss?: boolean;
  backdropDismiss?: boolean;
  triggerPopup?: false | "dialog" | "menu" | "listbox" | "true";
  triggerRelationship?: "controls" | "description" | "none";
  triggerPress?: boolean;
  triggerType?: "button" | false;
}

function createPopup(options: PopupFactoryOptions): PopupController {
  const id = requireId(options.id, options.component);
  const direction = options.direction ?? useDirection();
  const lastOpenReason = signal<OpenChangeReason>("programmatic", { name: `${id}.openReason` });
  const lastCloseReason = signal<OpenChangeReason>("programmatic", { name: `${id}.closeReason` });
  const state = createControllableState<boolean, OpenChangeReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "open") ? { value: options.open } : {}),
    defaultValue: Boolean(options.defaultOpen ?? options.initialOpen),
    onValueChange(open, details) {
      options.onOpenChange?.(open, details);
      if (!details.canceled) options.onChange?.(open);
    },
    name: `${id}.open`,
  });
  const triggerElement = signal<HTMLElement | null>(null, { name: `${id}.trigger` });
  const activeTriggerId = signal<string | null>(null, { name: `${id}.activeTriggerId` });
  interface TriggerRegistration {
    readonly id: string;
    element: HTMLElement | null;
    mountOrder: number;
  }
  const triggerRegistrations = new Map<string, TriggerRegistration>();
  let triggerIdSequence = 0;
  let triggerMountSequence = 0;
  const latestMountedTrigger = () => {
    let latest: TriggerRegistration | undefined;
    for (const registration of triggerRegistrations.values()) {
      if (registration.element && (!latest || registration.mountOrder > latest.mountOrder)) latest = registration;
    }
    return latest;
  };
  const allocateTrigger = (requestedId?: string): TriggerRegistration => {
    if (requestedId !== undefined) {
      const triggerId = requireId(requestedId, `${options.component} trigger`);
      const existing = triggerRegistrations.get(triggerId);
      if (existing) return existing;
      const registration = { id: triggerId, element: null, mountOrder: 0 };
      triggerRegistrations.set(triggerId, registration);
      return registration;
    }
    let triggerId: string;
    do {
      triggerIdSequence += 1;
      triggerId = triggerIdSequence === 1 ? `${id}-trigger` : `${id}-trigger-${triggerIdSequence}`;
    } while (triggerRegistrations.has(triggerId));
    const registration = { id: triggerId, element: null, mountOrder: 0 };
    triggerRegistrations.set(triggerId, registration);
    return registration;
  };
  const activateTrigger = (registration: TriggerRegistration, event?: Event) => {
    const currentTarget = event?.currentTarget;
    const eventElement = currentTarget && typeof currentTarget === "object" ? currentTarget as HTMLElement : null;
    triggerElement.value = registration.element ?? eventElement;
    activeTriggerId.value = registration.id;
  };
  const triggerRef = (registration: TriggerRegistration) => {
    let attachedElement: HTMLElement | null = null;
    let branchCleanup: Cleanup | undefined;
    return (element: HTMLElement | null) => {
      if (element === attachedElement) return;
      if (attachedElement !== null) {
        const previous = attachedElement;
        attachedElement = null;
        branchCleanup?.();
        branchCleanup = undefined;
        if (registration.element === previous) {
          registration.element = null;
          registration.mountOrder = 0;
          if (triggerElement.peek() === previous || activeTriggerId.peek() === registration.id) {
            const fallback = latestMountedTrigger();
            triggerElement.value = fallback?.element ?? null;
            activeTriggerId.value = fallback?.id ?? null;
          }
        }
      }
      if (element === null) return;
      if (registration.element !== null && registration.element !== element) {
        throw new Error(`${options.component} trigger id ${registration.id} is already mounted by another element.`);
      }
      attachedElement = element;
      registration.element = element;
      registration.mountOrder = ++triggerMountSequence;
      // Triggers must remain inside the outside-event boundary so an inactive
      // trigger can transfer popup ownership without an intermediate close.
      // They are background controls, however, and must never join a modal's
      // focus scope or exempt their ancestors from inerting.
      branchCleanup = overlay.branch(element, { interactionOnly: true });
      if (!state.value.peek() || activeTriggerId.peek() === null) {
        triggerElement.value = element;
        activeTriggerId.value = registration.id;
      }
    };
  };
  const titlePresent = signal(false, { name: `${id}.titlePresent` });
  const descriptionPresent = signal(false, { name: `${id}.descriptionPresent` });
  const presence = createPresence({ present: state.value, keepMounted: options.keepMounted });
  const dismiss = (reason: OverlayDismissReason, event?: Event) => {
    state.set(false, mapDismissReason(reason), event);
  };
  const overlay = createOverlay({
    open: state.value,
    onDismiss: dismiss,
    modal: options.modal,
    closeOnEscape: options.closeOnEscape,
    closeOnOutsidePress: options.outsideDismiss === false
      ? false
      : options.closeOnOutsidePress ?? options.closeOnBackdrop,
    closeOnFocusOutside: options.closeOnFocusOutside ?? (
      options.modal === false
      && options.outsideDismiss !== false
      && options.closeOnOutsidePress !== false
      && options.closeOnBackdrop !== false
    ),
    restoreFocus: () => options.restoreFocus !== false
      && !["hover", "focus", "focus-out", "outside-press"].includes(lastCloseReason.peek()),
    autoFocus: () => shouldAutoFocus(options, lastOpenReason.peek(), triggerElement.peek()),
    initialFocus: options.initialFocus,
    finalFocus: options.finalFocus,
    trigger: () => triggerElement.peek(),
    lockScroll: options.lockScroll,
  });
  const floating = options.positioned === false ? undefined : createFloating({
    anchor: () => triggerElement.value,
    side: options.side,
    align: options.align,
    sideOffset: options.sideOffset,
    alignOffset: options.alignOffset,
    collisionPadding: options.collisionPadding,
    avoidCollisions: options.avoidCollisions,
    direction,
  });
  const set = (next: boolean, reason: OpenChangeReason, event?: Event) => {
    if (next) lastOpenReason.value = reason;
    else lastCloseReason.value = reason;
    return state.set(next, reason, event);
  };
  const controller: PopupController = {
    id,
    open: state.value,
    triggerElement,
    show: ((reasonOrTrigger: OpenChangeReason | HTMLElement | null = "programmatic", event?: Event) => {
      if (typeof reasonOrTrigger === "string") return set(true, reasonOrTrigger, event);
      if (reasonOrTrigger) {
        triggerElement.value = reasonOrTrigger;
        const registration = [...triggerRegistrations.values()].find((entry) => entry.element === reasonOrTrigger);
        activeTriggerId.value = registration?.id ?? null;
      }
      return set(true, "programmatic", event);
    }) as PopupController["show"],
    hide: (reason = "programmatic", event) => set(false, reason, event),
    toggle: (reason = "programmatic", event) => set(!state.value.peek(), reason, event),
    trigger(triggerOptions = {}) {
      const relationship = options.triggerRelationship ?? "controls";
      const registration = allocateTrigger(triggerOptions.id);
      const isOpenForTrigger = () => state.value.value && activeTriggerId.value === registration.id;
      let pressedWhileInactive = false;
      let pressedPointerId: number | null = null;
      const clearPointerPress = (event?: PointerEvent) => {
        if (event && pressedPointerId !== null && event.pointerId !== pressedPointerId) return;
        pressedWhileInactive = false;
        pressedPointerId = null;
      };
      return {
        id: registration.id,
        ...(options.triggerType === false ? {} : { type: options.triggerType ?? "button" }),
        ...(options.triggerPopup === false ? {} : { "aria-haspopup": options.triggerPopup ?? "dialog" }),
        ...(relationship === "controls" ? {
          "aria-controls": `${id}-popup`,
          "aria-expanded": isOpenForTrigger,
        } : {}),
        ...(relationship === "description" ? {
          "aria-describedby": () => isOpenForTrigger() ? `${id}-popup` : undefined,
        } : {}),
        "data-open": () => isOpenForTrigger() ? "" : undefined,
        "data-closed": () => isOpenForTrigger() ? undefined : "",
        dir: direction,
        "data-clank-part": "trigger",
        ref: triggerRef(registration),
        ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
        ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
        onPointerDown: (event: PointerEvent) => {
          pressedWhileInactive = state.value.peek() && activeTriggerId.peek() !== registration.id;
          pressedPointerId = event.pointerId;
          activateTrigger(registration, event);
        },
        onPointerCancel: (event: PointerEvent) => { clearPointerPress(event); },
        onLostPointerCapture: (event: PointerEvent) => { clearPointerPress(event); },
        ...(triggerOptions.hover ? {
          onPointerEnter: (event: PointerEvent) => { activateTrigger(registration, event); },
        } : {}),
        onFocus: (event: FocusEvent) => { activateTrigger(registration, event); },
        onBlur: () => { clearPointerPress(); },
        onKeyDown: () => { clearPointerPress(); },
        ...(options.triggerPress === false ? {} : {
          onClick: (event: Event) => {
            // Native keyboard, assistive-technology, and programmatic clicks have
            // detail=0 and must evaluate the trigger's ownership at click time.
            // Only a pointer-generated click may consume the ownership snapshot
            // captured by its preceding pointerdown.
            const clickDetail = (event as MouseEvent).detail;
            const pointerGenerated = typeof clickDetail !== "number" || clickDetail > 0;
            const wasInactive = (pointerGenerated && pressedWhileInactive)
              || (state.value.peek() && activeTriggerId.peek() !== registration.id);
            clearPointerPress();
            activateTrigger(registration, event);
            if (event.defaultPrevented) return;
            if (state.value.peek() && wasInactive) controller.show("trigger-press", event);
            else controller.toggle("trigger-press", event);
          },
        }),
      };
    },
    isMounted: (portalOptions = {}) =>
      (portalOptions.keepMounted ?? options.keepMounted) === true || presence.mounted.value,
    portal: (portalOptions = {}) => ({
      hidden: () => state.value.value ? false : presence.state.value === "closed",
      "data-open": () => state.value.value ? "" : undefined,
      "data-closed": () => state.value.value ? undefined : "",
      "data-mounted": () => controller.isMounted(portalOptions) ? "" : undefined,
      "data-clank-part": "portal",
    }),
    backdrop(backdropOptions = {}) {
      return mergeProps(overlay.backdrop({
        dismiss: options.backdropDismiss !== false
          && options.closeOnBackdrop !== false
          && backdropOptions.dismiss !== false,
      }), presence.props(), {
        hidden: () => presence.state.value === "closed",
        "data-clank-part": "backdrop",
      });
    },
    positioner() {
      return mergeProps(floating?.positioner() ?? {}, {
        hidden: () => presence.state.value === "closed",
        "data-open": () => state.value.value ? "" : undefined,
        "data-closed": () => state.value.value ? undefined : "",
        "data-clank-part": "positioner",
      });
    },
    popup(popupOptions = {}) {
      const role = popupOptions.role === false ? undefined : popupOptions.role ?? options.role;
      const labelledBy = popupOptions.labelledBy === false || options.component === "Tooltip" || options.component === "PreviewCard"
        ? undefined
        : popupOptions.labelledBy ?? (() => titlePresent.value ? `${id}-title` : undefined);
      const describedBy = popupOptions.describedBy === false || options.component === "Tooltip" || options.component === "PreviewCard"
        ? undefined
        : popupOptions.describedBy ?? (() => descriptionPresent.value ? `${id}-description` : undefined);
      const props = mergeProps(
        overlay.content({ ...(role ? { role } : {}), tabIndex: popupOptions.tabIndex }),
        presence.props(),
        {
          id: `${id}-popup`,
          dir: direction,
          "aria-modal": role === "dialog" || role === "alertdialog"
            ? options.modal === true ? true : undefined
            : undefined,
          "aria-labelledby": labelledBy,
          "aria-describedby": describedBy,
          hidden: () => presence.state.value === "closed",
          "data-clank-part": "popup",
        },
      );
      // These relationships are optional and reactive. Preserve `undefined` so the renderer
      // removes the attribute instead of serializing an empty ARIA token list.
      if (labelledBy === undefined) delete props["aria-labelledby"];
      else props["aria-labelledby"] = labelledBy;
      if (describedBy === undefined) delete props["aria-describedby"];
      else props["aria-describedby"] = describedBy;
      return props;
    },
    arrow: () => mergeProps(floating?.arrow() ?? {}, { "data-clank-part": "arrow" }),
    title: () => {
      titlePresent.value = true;
      return {
        id: `${id}-title`,
        "data-clank-part": "title",
        ref: (element: HTMLElement | null) => { titlePresent.value = element !== null; },
      };
    },
    description: () => {
      descriptionPresent.value = true;
      return {
        id: `${id}-description`,
        "data-clank-part": "description",
        ref: (element: HTMLElement | null) => { descriptionPresent.value = element !== null; },
      };
    },
    close(closeOptions = {}) {
      return {
        type: "button",
        "data-clank-part": "close",
        ...(closeOptions.agentId ? { agentId: closeOptions.agentId } : {}),
        ...(closeOptions.agentLabel ? { agentLabel: closeOptions.agentLabel } : {}),
        onClick: (event: Event) => controller.hide("close-press", event),
      };
    },
    viewport: () => ({
      "data-open": () => state.value.value ? "" : undefined,
      "data-closed": () => state.value.value ? undefined : "",
      "data-clank-part": "viewport",
    }),
    manifest: () => popupManifest(options.component, id, state.value.peek(), options.role),
    dispose() {
      overlay.dispose();
      floating?.dispose();
      presence.dispose();
      triggerRegistrations.clear();
      triggerElement.value = null;
      activeTriggerId.value = null;
    },
  };
  return controller;
}

export interface DialogOptions extends PopupOptions {
  /** Full modal is the accessible default; trap-focus omits inerting/scroll lock. */
  modal?: OverlayModality;
}

export interface DialogController extends PopupController {
  dialog(options?: { labelledBy?: string | false; describedBy?: string | false }): Record<string, unknown>;
}

/** Nested-safe accessible dialog with portal-ready props, focus scope, inerting, and scroll lock. */
export function createDialog(options: DialogOptions): DialogController {
  const popup = createPopup({
    ...options,
    component: "Dialog",
    role: "dialog",
    positioned: false,
    modal: options.modal ?? true,
    backdropDismiss: true,
  });
  return Object.assign(popup, { dialog: popup.popup });
}

/** A modal alertdialog. Outside and backdrop presses never dismiss it. */
export function createAlertDialog(options: DialogOptions): DialogController {
  const popup = createPopup({
    ...options,
    component: "AlertDialog",
    role: "alertdialog",
    positioned: false,
    modal: true,
    outsideDismiss: false,
    backdropDismiss: false,
  });
  return Object.assign(popup, { dialog: popup.popup });
}

export interface PopoverOptions extends PopupOptions { openOnHover?: boolean; }

export function createPopover(options: PopoverOptions): PopupController {
  const popup = createPopup({
    ...options,
    component: "Popover",
    role: "dialog",
    modal: options.modal ?? false,
    autoFocus: options.autoFocus,
  });
  return options.openOnHover
    ? withHoverInteractions(popup, {
      openDelay: 100,
      closeDelay: 100,
      closeOnClick: false,
      hoverablePopup: true,
    })
    : popup;
}

export interface HoverCardOptions extends PopupOptions {
  openDelay?: number;
  /** Base UI calls the opening delay `delay`; openDelay is retained for compatibility. */
  delay?: number;
  closeDelay?: number;
}

/** Sighted-user preview enhancement with delayed hover/focus behavior. */
export function createPreviewCard(options: HoverCardOptions): PopupController {
  return withHoverInteractions(createPopup({
    ...options,
    component: "PreviewCard",
    role: undefined,
    modal: false,
    closeOnFocusOutside: true,
    autoFocus: false,
    restoreFocus: false,
    triggerPress: false,
    triggerType: false,
    triggerPopup: false,
    triggerRelationship: "none",
  }), {
    openDelay: options.delay ?? options.openDelay ?? 600,
    closeDelay: options.closeDelay ?? 300,
    closeOnClick: false,
    hoverablePopup: true,
  });
}

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
  /** Adjacent tooltips skip their opening delay within this window. */
  timeout?: number;
}

export interface TooltipProviderController {
  readonly id: string;
  readonly delay: number | undefined;
  readonly closeDelay: number | undefined;
  readonly timeout: number;
  /** Creates a tooltip attached to this delay group. */
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

/** Shared Base UI-style delay group: adjacent tooltips open immediately for a short window. */
export function createTooltipProvider(options: TooltipProviderOptions = {}): TooltipProviderController {
  const id = requireId(options.id ?? "tooltip-provider", "TooltipProvider");
  const delay = options.delay === undefined ? undefined : nonNegativeDuration(options.delay, "TooltipProvider delay");
  const closeDelay = options.closeDelay === undefined
    ? undefined
    : nonNegativeDuration(options.closeDelay, "TooltipProvider closeDelay");
  const timeout = nonNegativeDuration(options.timeout ?? 400, "TooltipProvider timeout");
  const owned = new Set<PopupController>();
  let active: PopupController | null = null;
  let instantUntil = 0;
  let disposed = false;
  let provider!: TooltipProviderController;
  provider = {
    id,
    delay,
    closeDelay,
    timeout,
    tooltip(tooltipOptions) {
      if (disposed) throw new Error("TooltipProvider has been disposed.");
      const tooltip = createTooltip({
        ...tooltipOptions,
        ...(tooltipOptions.delay === undefined && tooltipOptions.openDelay === undefined && delay !== undefined ? { delay } : {}),
        ...(tooltipOptions.closeDelay === undefined && closeDelay !== undefined ? { closeDelay } : {}),
        provider,
      });
      owned.add(tooltip);
      const disposeTooltip = tooltip.dispose;
      let tooltipDisposed = false;
      tooltip.dispose = () => {
        if (tooltipDisposed) return;
        tooltipDisposed = true;
        owned.delete(tooltip);
        disposeTooltip();
      };
      return tooltip;
    },
    provider: () => ({ "data-clank-part": "provider", "data-clank-provider": id }),
    openingDelay(fallback) {
      if (disposed) return fallback;
      return active !== null || Date.now() < instantUntil ? 0 : delay ?? fallback;
    },
    activate(tooltip) {
      if (disposed || active === tooltip || !tooltip.open.peek()) return;
      const previous = active;
      if (previous && (!previous.hide("programmatic") || previous.open.peek())) {
        if (tooltip.open.peek()) tooltip.hide("programmatic");
        return;
      }
      active = tooltip;
      instantUntil = 0;
    },
    deactivate(tooltip) {
      if (active !== tooltip) return;
      active = null;
      instantUntil = Date.now() + timeout;
    },
    manifest: () => createUiManifest({
      component: "TooltipProvider",
      id,
      state: { active: active?.id ?? null, instant: active !== null || Date.now() < instantUntil },
      parts: [{ name: "provider", required: true }],
      actions: [],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      active = null;
      instantUntil = 0;
      for (const tooltip of owned) tooltip.dispose();
      owned.clear();
    },
  };
  return provider;
}

/** Visual hint behavior; the trigger must still carry an accessible name. */
export function createTooltip(options: TooltipOptions): PopupController {
  const popup = createPopup({
    ...options,
    component: "Tooltip",
    role: "tooltip",
    modal: false,
    closeOnFocusOutside: true,
    autoFocus: false,
    restoreFocus: false,
    triggerPress: false,
    triggerPopup: false,
    triggerRelationship: "description",
  });
  return withHoverInteractions(popup, {
    openDelay: options.delay ?? options.openDelay ?? 600,
    closeDelay: options.closeDelay ?? 0,
    closeOnClick: options.closeOnClick !== false,
    hoverablePopup: options.disableHoverablePopup !== true,
    disabled: options.disabled,
    provider: options.provider,
  });
}

interface HoverInteractionOptions {
  openDelay: number;
  closeDelay: number;
  closeOnClick: boolean;
  hoverablePopup: boolean;
  disabled?: boolean;
  provider?: TooltipProviderController;
}

function withHoverInteractions(controller: PopupController, options: HoverInteractionOptions): PopupController {
  const openDelay = nonNegativeDuration(options.openDelay, "open delay");
  const closeDelay = nonNegativeDuration(options.closeDelay, "close delay");
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const hoveredTriggers = new Set<object>();
  const focusedTriggers = new Set<object>();
  let popupHovered = false;
  let popupFocused = false;
  const clearOpen = () => {
    if (openTimer !== undefined) clearTimeout(openTimer);
    openTimer = undefined;
  };
  const clearClose = () => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const clear = () => { clearOpen(); clearClose(); };
  const hasHover = () => hoveredTriggers.size > 0 || popupHovered;
  const hasFocus = () => focusedTriggers.size > 0 || popupFocused;
  const scheduleOpen = (event: Event, reason: "hover" | "focus", ownsInteraction: () => boolean) => {
    if (options.disabled) return;
    clearClose();
    clearOpen();
    const delay = options.provider?.openingDelay(openDelay) ?? openDelay;
    const open = () => {
      openTimer = undefined;
      if (options.disabled || !ownsInteraction()) return;
      if (controller.show(reason, event) && controller.open.peek()) options.provider?.activate(controller);
    };
    if (delay === 0) open();
    else openTimer = setTimeout(open, delay);
  };
  const scheduleClose = (event: Event, reason: "hover" | "focus") => {
    if (hasHover() || hasFocus()) {
      clearClose();
      return;
    }
    clearOpen();
    clearClose();
    const close = () => {
      closeTimer = undefined;
      if (hasHover() || hasFocus()) return;
      controller.hide(reason, event);
    };
    if (closeDelay === 0) closeTimer = setTimeout(close, 0);
    else closeTimer = setTimeout(close, closeDelay);
  };
  const originalTrigger = controller.trigger;
  const originalPopup = controller.popup;
  const originalHide = controller.hide;
  const originalDispose = controller.dispose;
  return Object.assign(controller, {
    trigger(triggerOptions = {}) {
      const owner = {};
      const props = originalTrigger({ ...triggerOptions, hover: !options.disabled });
      const merged = mergeProps(props, {
        "data-trigger-disabled": options.disabled ? "" : undefined,
        onPointerEnter: (event: PointerEvent) => {
          if (event.pointerType === "touch" || options.disabled) return;
          hoveredTriggers.add(owner);
          scheduleOpen(event, "hover", () => hoveredTriggers.has(owner) || popupHovered);
        },
        onPointerLeave: (event: PointerEvent) => {
          if (event.pointerType === "touch") return;
          hoveredTriggers.delete(owner);
          scheduleClose(event, "hover");
        },
        onFocus: (event: FocusEvent) => {
          if (options.disabled) return;
          focusedTriggers.add(owner);
          scheduleOpen(event, "focus", () => focusedTriggers.has(owner) || popupFocused);
        },
        onBlur: (event: FocusEvent) => {
          focusedTriggers.delete(owner);
          scheduleClose(event, "focus");
        },
        ref: (element: HTMLElement | null) => {
          if (element !== null) return;
          hoveredTriggers.delete(owner);
          focusedTriggers.delete(owner);
        },
        ...(options.closeOnClick ? {
          onPointerDown: () => clearOpen(),
          onClick: (event: Event) => {
            clear();
            controller.hide("trigger-press", event);
          },
        } : {}),
      });
      if (props["aria-describedby"] !== undefined) merged["aria-describedby"] = props["aria-describedby"];
      return merged;
    },
    popup(popupOptions = {}) {
      return mergeProps(originalPopup(popupOptions), {
        onPointerEnter: (event: PointerEvent) => {
          if (!options.hoverablePopup || event.pointerType === "touch") return;
          popupHovered = true;
          clearClose();
        },
        onPointerLeave: (event: PointerEvent) => {
          if (!options.hoverablePopup || event.pointerType === "touch") return;
          popupHovered = false;
          scheduleClose(event, "hover");
        },
        onFocusIn: () => { popupFocused = true; clearClose(); },
        onFocusOut: (event: FocusEvent) => {
          if (focusRemainsWithin(event)) return;
          popupFocused = false;
          scheduleClose(event, "focus");
        },
      });
    },
    hide(reason: OpenChangeReason = "programmatic", event?: Event) {
      clear();
      const changed = originalHide(reason, event);
      if (changed && !controller.open.peek()) options.provider?.deactivate(controller);
      return changed;
    },
    dispose() {
      clear();
      hoveredTriggers.clear();
      focusedTriggers.clear();
      options.provider?.deactivate(controller);
      originalDispose();
    },
  });
}

export type DrawerDirection = "top" | "right" | "bottom" | "left";
export type DrawerSwipeDirection = "up" | "right" | "down" | "left";
export type DrawerSnapPoint = number | string;

export interface DrawerResolvedSnapPoint {
  /** The original configured value. */
  readonly value: DrawerSnapPoint;
  /** Visible drawer size, in CSS pixels, after viewport and popup clamping. */
  readonly size: number;
  /** Distance from the fully expanded position, in CSS pixels. */
  readonly offset: number;
}

export interface DrawerMeasurements {
  /** Viewport size on the swipe axis. */
  viewportSize?: number;
  /** Popup size on the swipe axis. */
  popupSize?: number;
  /** Root font size used to resolve rem snap points. */
  rootFontSize?: number;
}

export interface DrawerSwipeAreaOptions {
  disabled?: boolean | (() => boolean);
  /** Physical direction that opens the drawer. Defaults to the opposite of its dismiss direction. */
  swipeDirection?: DrawerSwipeDirection;
}

export interface DrawerProviderOptions {
  id?: string;
  indent?: number;
}

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

/** Coordinates nested drawers and exposes styling state for indented application shells. */
export function createDrawerProvider(options: DrawerProviderOptions = {}): DrawerProviderController {
  const id = requireId(options.id ?? "drawer-provider", "DrawerProvider");
  const indentSize = nonNegativeDuration(options.indent ?? 16, "DrawerProvider indent");
  const depth = signal(0, { name: `${id}.depth` });
  const registrations = new Map<DrawerController, Cleanup>();
  let disposed = false;
  const sync = () => {
    depth.value = [...registrations].reduce((count, [drawer]) => count + Number(drawer.open.peek()), 0);
  };
  return {
    id,
    depth,
    provider: () => ({
      "data-clank-part": "provider",
      "data-active": () => depth.value > 0 ? "" : undefined,
      "data-drawer-open": () => depth.value > 0 ? "" : undefined,
      "data-drawer-depth": () => depth.value,
    }),
    indentBackground: () => ({
      "aria-hidden": true,
      "data-clank-part": "indent-background",
      "data-active": () => depth.value > 0 ? "" : undefined,
      "data-drawer-open": () => depth.value > 0 ? "" : undefined,
      style: { "--clank-drawer-depth": () => depth.value, "--clank-drawer-indent": `${indentSize}px` },
    }),
    indent: () => ({
      "data-clank-part": "indent",
      "data-active": () => depth.value > 0 ? "" : undefined,
      "data-drawer-open": () => depth.value > 0 ? "" : undefined,
      "data-drawer-depth": () => depth.value,
      style: { "--clank-drawer-depth": () => depth.value, "--clank-drawer-indent": `${indentSize}px` },
    }),
    register(drawer) {
      if (disposed) throw new Error("DrawerProvider has been disposed.");
      registrations.get(drawer)?.();
      const stop = effect(() => { drawer.open.value; sync(); });
      registrations.set(drawer, stop);
      sync();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        registrations.get(drawer)?.();
        registrations.delete(drawer);
        sync();
      };
    },
    manifest: () => createUiManifest({
      component: "DrawerProvider",
      id,
      state: { depth: depth.peek() },
      parts: [
        { name: "provider", required: true },
        { name: "indent-background", defaultElement: "div" },
        { name: "indent", defaultElement: "div" },
      ],
      actions: [],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of registrations.values()) stop();
      registrations.clear();
      depth.value = 0;
    },
  };
}

export interface DrawerVirtualKeyboardProviderOptions { id?: string; }
export interface DrawerVirtualKeyboardProviderController {
  readonly id: string;
  readonly inset: ReactiveSignal<number>;
  provider(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/** Exposes the current Visual Viewport keyboard inset without reading browser globals during SSR. */
export function createDrawerVirtualKeyboardProvider(
  options: DrawerVirtualKeyboardProviderOptions = {},
): DrawerVirtualKeyboardProviderController {
  const id = requireId(options.id ?? "drawer-keyboard", "DrawerVirtualKeyboardProvider");
  const inset = signal(0, { name: `${id}.inset` });
  const mounts = new Set<Cleanup>();
  let disposed = false;
  const controller: DrawerVirtualKeyboardProviderController = {
    id,
    inset,
    provider: () => ({
      "data-clank-part": "virtual-keyboard-provider",
      "data-keyboard-open": () => inset.value > 0 ? "" : undefined,
      style: { "--clank-drawer-keyboard-inset": () => `${inset.value}px` },
      use(element: Element): Cleanup {
        if (disposed) throw new Error("DrawerVirtualKeyboardProvider has been disposed.");
        const window = element.ownerDocument.defaultView;
        const viewport = window?.visualViewport;
        const update = () => {
          inset.value = window && viewport
            ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
            : 0;
        };
        viewport?.addEventListener("resize", update, { passive: true });
        viewport?.addEventListener("scroll", update, { passive: true });
        window?.addEventListener("resize", update, { passive: true });
        update();
        let mounted = true;
        const cleanup = () => {
          if (!mounted) return;
          mounted = false;
          viewport?.removeEventListener("resize", update);
          viewport?.removeEventListener("scroll", update);
          window?.removeEventListener("resize", update);
          mounts.delete(cleanup);
          if (mounts.size === 0) inset.value = 0;
        };
        mounts.add(cleanup);
        return cleanup;
      },
    }),
    manifest: () => createUiManifest({
      component: "DrawerVirtualKeyboardProvider",
      id,
      state: { inset: inset.peek() },
      parts: [{ name: "virtual-keyboard-provider", required: true }],
      actions: [],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...mounts]) cleanup();
      inset.value = 0;
    },
  };
  return controller;
}

export interface DrawerOptions extends Omit<DialogOptions, "direction"> {
  /** Edge from which the drawer is presented. Retained from the original Clank API. */
  direction?: DrawerDirection;
  /** Base UI-compatible physical swipe direction. */
  swipeDirection?: DrawerSwipeDirection;
  /**
   * Visible drawer sizes. Values from 0 through 1 are viewport fractions, values above 1 are
   * pixels, and strings must use px or rem units.
   */
  snapPoints?: readonly DrawerSnapPoint[];
  /** Controlled active snap point. Null represents the fully expanded, unsnapped position. */
  snapPoint?: DrawerSnapPoint | null | (() => DrawerSnapPoint | null);
  /** Initial snap point for uncontrolled drawers. Defaults to the first configured point. */
  defaultSnapPoint?: DrawerSnapPoint | null;
  onSnapPointChange?: (
    snapPoint: DrawerSnapPoint | null,
    details: ChangeDetails<OpenChangeReason>,
  ) => void;
  /** Prevent velocity projection from skipping over intermediate snap points. */
  snapToSequentialPoints?: boolean;
  /** Legacy fixed distance threshold used when no snap point wins the release. */
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
  /** Explicit measurement hook for non-DOM renderers and deterministic tests. DOM parts measure automatically. */
  measure(measurements?: DrawerMeasurements): void;
  provider(): Record<string, unknown>;
  indentBackground(): Record<string, unknown>;
  indent(): Record<string, unknown>;
  virtualKeyboardProvider(): Record<string, unknown>;
  content(options?: { swipeIgnore?: boolean }): Record<string, unknown>;
  swipeArea(options?: DrawerSwipeAreaOptions): Record<string, unknown>;
}

const DRAWER_MIN_SWIPE_THRESHOLD = 16;
const DRAWER_AXIS_LOCK_SLOP = 6;
const DRAWER_AXIS_LOCK_BIAS = 2;
const DRAWER_FAST_SWIPE_VELOCITY = 0.5;
const DRAWER_SNAP_VELOCITY_THRESHOLD = 0.5;
const DRAWER_SNAP_VELOCITY_MULTIPLIER = 300;
const DRAWER_MAX_SNAP_VELOCITY = 4;
const DRAWER_MIN_RELEASE_VELOCITY = 0.2;
const DRAWER_MAX_RELEASE_VELOCITY = 4;
const DRAWER_MIN_RELEASE_DURATION = 80;
const DRAWER_MAX_RELEASE_DURATION = 360;
const DRAWER_MIN_RELEASE_STRENGTH = 0.1;
const DRAWER_MAX_RELEASE_STRENGTH = 1;

/**
 * Dialog semantics plus measured snap points, velocity-aware swipe release, edge opening, and
 * nested-drawer coordination. The implementation is DOM-optional and dependency-free.
 */
export function createDrawer(options: DrawerOptions): DrawerController {
  const id = requireId(options.id, "Drawer");
  const {
    direction: drawerDirection,
    swipeDirection: requestedSwipeDirection,
    snapPoints: requestedSnapPoints,
    snapPoint: requestedSnapPoint,
    defaultSnapPoint: requestedDefaultSnapPoint,
    onSnapPointChange,
    snapToSequentialPoints = false,
    provider: providedProvider,
    onOpenChange,
    ...popupOptions
  } = options;
  const configuredSnapPoints = Object.freeze(
    (requestedSnapPoints ?? []).map((point, index) => validateDrawerSnapPoint(point, `Drawer snapPoints[${index}]`)),
  );
  const defaultSnapPoint = requestedDefaultSnapPoint === undefined
    ? configuredSnapPoints[0] ?? null
    : validateDrawerSnapPointSelection(requestedDefaultSnapPoint, configuredSnapPoints, "Drawer defaultSnapPoint");
  const controlledSnapPoint = requestedSnapPoint === undefined
    ? undefined
    : typeof requestedSnapPoint === "function"
      ? () => validateDrawerSnapPointSelection(requestedSnapPoint(), configuredSnapPoints, "Drawer snapPoint")
      : validateDrawerSnapPointSelection(requestedSnapPoint, configuredSnapPoints, "Drawer snapPoint");
  const snapState = createControllableState<DrawerSnapPoint | null, OpenChangeReason>({
    ...(controlledSnapPoint === undefined ? {} : { value: controlledSnapPoint }),
    defaultValue: defaultSnapPoint,
    onValueChange: onSnapPointChange,
    name: `${id}.snapPoint`,
  });

  const swipeDismissed = signal(false, { name: `${id}.swipeDismissed` });
  const releaseMovement = signal(0, { name: `${id}.releaseMovement` });
  const releaseSnapOffset = signal(0, { name: `${id}.releaseSnapOffset` });
  const releaseStrength = signal(1, { name: `${id}.releaseStrength` });
  let pendingSwipeClose = false;
  let pendingCloseBaseOffset = 0;
  let pendingCloseSize = 0;
  let pendingCloseFrame = 0;

  const drawer = createPopup({
    ...popupOptions,
    id,
    component: "Drawer",
    role: "dialog",
    positioned: false,
    modal: options.modal ?? true,
    closeOnOutsidePress: options.disablePointerDismissal ? false : options.closeOnOutsidePress,
    backdropDismiss: options.disablePointerDismissal !== true,
    onOpenChange(open, details) {
      onOpenChange?.(open, details);
      if (details.canceled) return;
      if (!open) {
        snapState.set(defaultSnapPoint, details.reason, details.event);
        if (details.reason !== "swipe") clearReleaseState();
      } else {
        clearReleaseState();
      }
    },
  }) as DrawerController;
  const provider = providedProvider ?? createDrawerProvider({ id: `${drawer.id}-provider` });
  const ownsProvider = providedProvider === undefined;
  const keyboardProvider = createDrawerVirtualKeyboardProvider({ id: `${drawer.id}-keyboard` });
  const dragOffset = signal(0, { name: `${drawer.id}.dragOffset` });
  const dragging = signal(false, { name: `${drawer.id}.dragging` });
  const directionalMovement = signal(0, { name: `${drawer.id}.directionalMovement` });
  const directionalVelocity = signal(0, { name: `${drawer.id}.directionalVelocity` });
  const viewportSize = signal(0, { name: `${drawer.id}.viewportSize` });
  const popupSize = signal(0, { name: `${drawer.id}.popupSize` });
  const rootFontSize = signal(16, { name: `${drawer.id}.rootFontSize` });
  const direction = drawerDirection ?? "bottom";
  const swipeDirection = requestedSwipeDirection ?? drawerDirectionToSwipe(direction);
  const axis: "clientX" | "clientY" = swipeDirection === "up" || swipeDirection === "down" ? "clientY" : "clientX";
  const crossAxis: "clientX" | "clientY" = axis === "clientX" ? "clientY" : "clientX";
  const sign = swipeDirection === "up" || swipeDirection === "left" ? -1 : 1;
  const threshold = Math.max(
    DRAWER_MIN_SWIPE_THRESHOLD,
    nonNegativeDuration(options.swipeThreshold ?? 80, "Drawer swipeThreshold"),
  );
  const resolvedSnapPoints = computed<readonly DrawerResolvedSnapPoint[]>(() => {
    const view = viewportSize.value;
    const popup = popupSize.value;
    if (configuredSnapPoints.length === 0 || view <= 0 || popup <= 0) return Object.freeze([]);
    const maximum = Math.min(view, popup);
    const resolved = configuredSnapPoints.map((value) => {
      const size = clampDrawerNumber(resolveDrawerSnapPoint(value, view, rootFontSize.value), 0, maximum);
      return Object.freeze({ value, size, offset: Math.max(0, popup - size) });
    });
    const deduped: DrawerResolvedSnapPoint[] = [];
    const seenSizes: number[] = [];
    for (let index = resolved.length - 1; index >= 0; index -= 1) {
      const point = resolved[index]!;
      if (seenSizes.some((size) => Math.abs(size - point.size) <= 1)) continue;
      seenSizes.push(point.size);
      deduped.push(point);
    }
    deduped.reverse();
    return Object.freeze(deduped);
  }, { name: `${drawer.id}.resolvedSnapPoints` });
  const activeResolvedSnapPoint = computed<DrawerResolvedSnapPoint | null>(() => {
    const active = snapState.value.value;
    if (active === null) return null;
    const points = resolvedSnapPoints.value;
    const exact = points.find((point) => Object.is(point.value, active));
    if (exact) return exact;
    if (points.length === 0) return null;
    const targetSize = clampDrawerNumber(
      resolveDrawerSnapPoint(active, viewportSize.value, rootFontSize.value),
      0,
      Math.min(viewportSize.value, popupSize.value),
    );
    return points[closestDrawerSnapPointIndex(points.map((point) => point.size), targetSize)] ?? null;
  }, { name: `${drawer.id}.activeResolvedSnapPoint` });
  const snapPointOffset = computed(
    () => activeResolvedSnapPoint.value?.offset ?? 0,
    { name: `${drawer.id}.snapPointOffset` },
  );
  const renderedSnapPointOffset = computed(
    () => swipeDismissed.value ? releaseSnapOffset.value : snapPointOffset.value,
    { name: `${drawer.id}.renderedSnapPointOffset` },
  );
  const visualMovement = computed(() => {
    const movement = dragging.value ? directionalMovement.value : releaseMovement.value;
    if (!dragging.value || configuredSnapPoints.length === 0) return movement;
    const nextOffset = snapPointOffset.value + movement;
    return nextOffset >= 0 ? movement : -Math.sqrt(-nextOffset) - snapPointOffset.value;
  }, { name: `${drawer.id}.visualMovement` });
  const swipeProgress = computed(() => {
    const size = popupSize.value || threshold;
    const base = configuredSnapPoints.length > 0 ? renderedSnapPointOffset.value : 0;
    return clampDrawerNumber((base + visualMovement.value) / size, 0, 1);
  }, { name: `${drawer.id}.swipeProgress` });
  // Preserve Clank 0.x's public drag-distance signal while the Base UI CSS variable below uses
  // the separately calculated velocity-aware release strength.
  const swipeStrength = computed(
    () => Math.min(1, dragOffset.value / threshold),
    { name: `${drawer.id}.swipeStrength` },
  );

  let start = 0;
  let crossStart = 0;
  let lastPosition = 0;
  let lastTime: number | null = null;
  let gestureAxis = axis;
  let gestureCrossAxis = crossAxis;
  let gestureSign = sign;
  let pointer = -1;
  let opening = false;
  let axisLocked = false;
  let captureTarget: Element | null = null;
  let popupElement: Element | null = null;
  let viewportElement: Element | null = null;
  let disposed = false;
  const measurementMounts = new Set<Cleanup>();

  const releasePointer = () => {
    const capturedPointer = pointer;
    pointer = -1;
    if (captureTarget && capturedPointer >= 0) {
      try { captureTarget.releasePointerCapture?.(capturedPointer); } catch { /* Pointer capture can already be gone. */ }
    }
    captureTarget = null;
  };
  const resetDrag = () => {
    releasePointer();
    axisLocked = false;
    dragging.value = false;
    dragOffset.value = 0;
    directionalMovement.value = 0;
    directionalVelocity.value = 0;
  };
  const clearPendingFrame = () => {
    if (!pendingCloseFrame) return;
    const window = (popupElement ?? viewportElement)?.ownerDocument?.defaultView;
    window?.cancelAnimationFrame?.(pendingCloseFrame);
    pendingCloseFrame = 0;
  };
  function clearReleaseState(): void {
    clearPendingFrame();
    pendingSwipeClose = false;
    pendingCloseBaseOffset = 0;
    pendingCloseSize = 0;
    swipeDismissed.value = false;
    releaseMovement.value = 0;
    releaseSnapOffset.value = 0;
    releaseStrength.value = 1;
  }
  const beginRelease = (distance: number, velocity: number) => {
    const speed = clampDrawerNumber(Math.abs(velocity), DRAWER_MIN_RELEASE_VELOCITY, DRAWER_MAX_RELEASE_VELOCITY);
    const duration = velocity === 0
      ? DRAWER_MAX_RELEASE_DURATION
      : clampDrawerNumber(distance / speed, DRAWER_MIN_RELEASE_DURATION, DRAWER_MAX_RELEASE_DURATION);
    const normalized = (duration - DRAWER_MIN_RELEASE_DURATION)
      / (DRAWER_MAX_RELEASE_DURATION - DRAWER_MIN_RELEASE_DURATION);
    releaseStrength.value = DRAWER_MIN_RELEASE_STRENGTH
      + normalized * (DRAWER_MAX_RELEASE_STRENGTH - DRAWER_MIN_RELEASE_STRENGTH);
  };
  const commitSwipeDismissal = (baseOffset: number, size: number) => {
    clearPendingFrame();
    pendingSwipeClose = false;
    swipeDismissed.value = true;
    releaseSnapOffset.value = baseOffset;
    releaseMovement.value = Math.max(0, size - baseOffset);
  };
  const scheduleControlledCloseCheck = () => {
    const window = (popupElement ?? viewportElement)?.ownerDocument?.defaultView;
    const verify = () => {
      pendingCloseFrame = 0;
      if (!pendingSwipeClose) return;
      if (drawer.open.peek()) clearReleaseState();
      else commitSwipeDismissal(pendingCloseBaseOffset, pendingCloseSize);
    };
    if (window?.requestAnimationFrame) pendingCloseFrame = window.requestAnimationFrame(verify);
    else queueMicrotask(verify);
  };
  const begin = (
    event: PointerEvent,
    allowOpening: boolean,
    interactionDirection: DrawerSwipeDirection = swipeDirection,
  ) => {
    if (pointer >= 0 || event.defaultPrevented || event.button !== 0 || event.isPrimary === false || isSwipeIgnored(event)) return;
    if (event.pointerType === "mouse" && eventPathHas(event, "data-clank-drawer-content")) return;
    opening = !drawer.open.peek();
    if (opening && !allowOpening) return;
    if (!opening && allowOpening) return;
    gestureAxis = opening
      ? interactionDirection === "up" || interactionDirection === "down" ? "clientY" : "clientX"
      : axis;
    gestureCrossAxis = gestureAxis === "clientX" ? "clientY" : "clientX";
    gestureSign = opening
      ? interactionDirection === "up" || interactionDirection === "left" ? -1 : 1
      : sign;
    if (!Number.isFinite(event[gestureAxis])) return;
    clearReleaseState();
    pointer = event.pointerId;
    start = event[gestureAxis];
    crossStart = Number.isFinite(event[gestureCrossAxis]) ? event[gestureCrossAxis] : 0;
    lastPosition = start;
    lastTime = drawerEventTime(event);
    dragging.value = true;
    captureTarget = event.currentTarget && typeof event.currentTarget === "object"
      ? event.currentTarget as Element
      : null;
    try { captureTarget?.setPointerCapture?.(pointer); } catch { /* Detached targets cannot capture. */ }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const position = event[gestureAxis];
    const crossPosition = Number.isFinite(event[gestureCrossAxis]) ? event[gestureCrossAxis] : crossStart;
    if (!Number.isFinite(position)) return;
    const primaryDistance = Math.abs(position - start);
    const crossDistance = Math.abs(crossPosition - crossStart);
    if (!axisLocked && (primaryDistance >= DRAWER_AXIS_LOCK_SLOP || crossDistance >= DRAWER_AXIS_LOCK_SLOP)) {
      if (crossDistance > primaryDistance + DRAWER_AXIS_LOCK_BIAS) {
        resetDrag();
        return;
      }
      axisLocked = true;
    }
    const multiplier = gestureSign;
    const rawMovement = (position - start) * multiplier;
    const movement = opening || configuredSnapPoints.length > 0 ? rawMovement : Math.max(0, rawMovement);
    directionalMovement.value = movement;
    dragOffset.value = Math.max(0, movement);
    const time = drawerEventTime(event);
    if (time !== null && lastTime !== null && time > lastTime) {
      directionalVelocity.value = ((position - lastPosition) * multiplier) / (time - lastTime);
    }
    lastPosition = position;
    lastTime = time;
    if (axisLocked && event.cancelable && event.pointerType !== "mouse") event.preventDefault();
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    if (Number.isFinite(event[gestureAxis]) && event[gestureAxis] !== lastPosition) move(event);
    const movement = directionalMovement.peek();
    const velocity = directionalVelocity.peek();
    const wasOpening = opening;
    if (wasOpening) {
      const reached = movement >= threshold
        || movement > 0 && velocity >= DRAWER_FAST_SWIPE_VELOCITY;
      resetDrag();
      if (reached) drawer.show("swipe", event);
      return;
    }

    if (configuredSnapPoints.length > 0 && resolvedSnapPoints.peek().length > 0) {
      releaseToSnapPoint(movement, velocity, event);
      resetDrag();
      return;
    }

    const reached = movement >= threshold
      || movement > 0 && velocity >= DRAWER_FAST_SWIPE_VELOCITY;
    if (reached && options.dismissible !== false) requestSwipeClose(movement, velocity, event);
    resetDrag();
  };
  const cancel = (event?: PointerEvent) => {
    if (event && event.pointerId !== pointer) return;
    resetDrag();
  };
  const popupSwipeHandlers = {
    onPointerDown: (event: PointerEvent) => begin(event, false, swipeDirection),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  };
  const originalShow = drawer.show;
  const originalHide = drawer.hide;
  const originalPopup = drawer.popup;
  const originalViewport = drawer.viewport;
  const originalBackdrop = drawer.backdrop;
  const originalManifest = drawer.manifest;
  const originalDispose = drawer.dispose;
  const controller = Object.assign(drawer, {
    dragOffset,
    dragging,
    swipeStrength,
    swipeProgress,
    snapPoint: snapState.value,
    resolvedSnapPoints,
    snapPointOffset,
    setSnapPoint(next: DrawerSnapPoint | null, reason: OpenChangeReason = "programmatic", event?: Event) {
      return snapState.set(
        validateDrawerSnapPointSelection(next, configuredSnapPoints, "Drawer snap point"),
        reason,
        event,
      );
    },
    measure(measurements: DrawerMeasurements = {}) {
      if (disposed) throw new Error("Drawer has been disposed.");
      if (measurements.viewportSize !== undefined) {
        viewportSize.value = finiteDrawerMeasurement(measurements.viewportSize, "Drawer viewportSize", true);
      }
      if (measurements.popupSize !== undefined) {
        popupSize.value = finiteDrawerMeasurement(measurements.popupSize, "Drawer popupSize", true);
      }
      if (measurements.rootFontSize !== undefined) {
        rootFontSize.value = finiteDrawerMeasurement(measurements.rootFontSize, "Drawer rootFontSize", false);
      }
      if (Object.keys(measurements).length === 0) updateMountedMeasurements();
    },
    show: ((reasonOrTrigger: OpenChangeReason | HTMLElement | null = "programmatic", event?: Event) => {
      clearReleaseState();
      return originalShow(reasonOrTrigger as OpenChangeReason, event);
    }) as DrawerController["show"],
    hide: (reason: OpenChangeReason = "programmatic", event?: Event) => {
      if (reason !== "swipe") clearReleaseState();
      return originalHide(reason, event);
    },
    toggle: (reason: OpenChangeReason = "programmatic", event?: Event) => drawer.open.peek()
      ? controller.hide(reason, event)
      : controller.show(reason, event),
    dialog: (popupPartOptions = {}) => controllerPopup(popupPartOptions),
    popup: controllerPopup,
    viewport: () => mergeProps(originalViewport(), {
      "data-swipe-direction": swipeDirection,
      "data-drawer-direction": direction,
      use: (element: Element) => mountMeasurement("viewport", element),
    }),
    backdrop: (backdropOptions: { dismiss?: boolean } = {}) => mergeProps(originalBackdrop(backdropOptions), {
      "data-swipe-direction": swipeDirection,
      "data-swiping": () => dragging.value ? "" : undefined,
      "data-swipe-dismiss": () => swipeDismissed.value ? "" : undefined,
      style: {
        "--drawer-swipe-progress": () => swipeProgress.value,
        "--drawer-swipe-strength": () => releaseStrength.value,
        "--drawer-height": () => popupSize.value > 0 ? `${popupSize.value}px` : undefined,
      },
    }),
    provider: provider.provider,
    indentBackground: provider.indentBackground,
    indent: provider.indent,
    virtualKeyboardProvider: keyboardProvider.provider,
    content: (contentOptions: { swipeIgnore?: boolean } = {}) => ({
      "data-clank-part": "content",
      "data-clank-drawer-content": "",
      ...(contentOptions.swipeIgnore ? { "data-clank-swipe-ignore": "", "data-base-ui-swipe-ignore": "" } : {}),
    }),
    swipeArea: (swipeAreaOptions: DrawerSwipeAreaOptions = {}) => {
      const openDirection = swipeAreaOptions.swipeDirection ?? oppositeDrawerSwipeDirection(swipeDirection);
      const disabled = () => readBoolean(swipeAreaOptions.disabled ?? false);
      const handlers = {
        onPointerDown: (event: PointerEvent) => {
          if (!disabled()) begin(event, true, openDirection);
        },
        onPointerMove: (event: PointerEvent) => {
          if (disabled()) cancel(event);
          else move(event);
        },
        onPointerUp: (event: PointerEvent) => {
          if (disabled()) cancel(event);
          else end(event);
        },
        onPointerCancel: cancel,
        onLostPointerCapture: cancel,
      };
      return mergeProps(handlers, {
        "data-clank-part": "swipe-area",
        "data-open": () => drawer.open.value ? "" : undefined,
        "data-closed": () => drawer.open.value ? undefined : "",
        "data-disabled": () => disabled() ? "" : undefined,
        "data-swiping": () => dragging.value ? "" : undefined,
        "data-swipe-direction": openDirection,
        "data-drawer-direction": direction,
        "aria-hidden": true,
        style: { touchAction: "none", userSelect: "none" },
      });
    },
    manifest: () => {
      const base = originalManifest();
      return createUiManifest({
        component: base.component,
        id: base.id,
        state: {
          ...base.state,
          direction,
          swipeDirection,
          dragging: dragging.peek(),
          snapPoint: snapState.value.peek(),
          snapPointOffset: snapPointOffset.peek(),
          snapPoints: configuredSnapPoints,
        },
        parts: [...base.parts],
        actions: [
          ...base.actions,
          {
            name: "setSnapPoint",
            description: "Move the drawer to a configured snap point.",
            sideEffects: "write",
            reasons: ["programmatic", "swipe"],
          },
        ],
        ...(base.keyboard ? { keyboard: base.keyboard } : {}),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPendingFrame();
      resetDrag();
      stopOpenState();
      unregister();
      for (const cleanup of [...measurementMounts]) cleanup();
      keyboardProvider.dispose();
      if (ownsProvider) provider.dispose();
      originalDispose();
    },
  });
  let unregister: Cleanup = () => {};
  unregister = provider.register(controller);
  let previousOpen = drawer.open.peek();
  const stopOpenState = effect(() => {
    const open = drawer.open.value;
    if (open && !previousOpen) clearReleaseState();
    if (!open && previousOpen) {
      if (pendingSwipeClose) commitSwipeDismissal(pendingCloseBaseOffset, pendingCloseSize);
    }
    previousOpen = open;
  });
  return controller;

  function controllerPopup(partOptions: Parameters<PopupController["popup"]>[0] = {}): Record<string, unknown> {
    return mergeProps(originalPopup(partOptions), popupSwipeHandlers, {
      "data-dragging": () => dragging.value ? "" : undefined,
      "data-swiping": () => dragging.value ? "" : undefined,
      "data-swipe-direction": swipeDirection,
      "data-drawer-direction": direction,
      "data-swipe-dismiss": () => swipeDismissed.value ? "" : undefined,
      "data-expanded": () => configuredSnapPoints.length > 0
        && Object.is(snapState.value.value, 1)
        ? ""
        : undefined,
      "data-snap-point": () => snapState.value.value === null ? undefined : String(snapState.value.value),
      "data-nested-drawer-open": () => provider.depth.value > 1 ? "" : undefined,
      style: {
        "--clank-drawer-drag-offset": () => `${dragOffset.value}px`,
        "--drawer-swipe-movement-x": () => axis === "clientX" ? `${visualMovement.value * sign}px` : "0px",
        "--drawer-swipe-movement-y": () => axis === "clientY" ? `${visualMovement.value * sign}px` : "0px",
        "--drawer-snap-point-offset": () => `${renderedSnapPointOffset.value * sign}px`,
        "--drawer-swipe-progress": () => swipeProgress.value,
        "--drawer-swipe-strength": () => releaseStrength.value,
        "--drawer-height": () => popupSize.value > 0 ? `${popupSize.value}px` : undefined,
        "--drawer-frontmost-height": () => popupSize.value > 0 ? `${popupSize.value}px` : undefined,
        "--nested-drawers": () => Math.max(0, provider.depth.value - 1),
      },
      use: (element: Element) => mountMeasurement("popup", element),
    });
  }

  function requestSwipeClose(movement: number, velocity: number, event: PointerEvent): boolean {
    if (options.dismissible === false) return false;
    const size = popupSize.peek() || threshold;
    const baseOffset = snapPointOffset.peek();
    const travelled = baseOffset + Math.max(0, movement);
    beginRelease(Math.max(0, size - travelled), velocity);
    pendingSwipeClose = true;
    pendingCloseBaseOffset = baseOffset;
    pendingCloseSize = size;
    const accepted = originalHide("swipe", event);
    if (!accepted) {
      clearReleaseState();
      return false;
    }
    if (!drawer.open.peek()) commitSwipeDismissal(pendingCloseBaseOffset, pendingCloseSize);
    else scheduleControlledCloseCheck();
    return true;
  }

  function releaseToSnapPoint(movement: number, velocity: number, event: PointerEvent): void {
    const points = [...resolvedSnapPoints.peek()].sort((first, second) => first.offset - second.offset);
    const size = popupSize.peek();
    if (points.length === 0 || size <= 0) return;
    const currentOffset = snapPointOffset.peek();
    const dragTarget = clampDrawerNumber(currentOffset + movement, 0, size);
    const velocityProjection = snapToSequentialPoints || Math.abs(velocity) < DRAWER_SNAP_VELOCITY_THRESHOLD
      ? 0
      : clampDrawerNumber(velocity, -DRAWER_MAX_SNAP_VELOCITY, DRAWER_MAX_SNAP_VELOCITY)
        * DRAWER_SNAP_VELOCITY_MULTIPLIER;
    const targetOffset = clampDrawerNumber(dragTarget + velocityProjection, 0, size);
    let target = points[closestDrawerSnapPointIndex(points.map((point) => point.offset), targetOffset)]!;
    let effectiveTargetOffset = targetOffset;

    if (snapToSequentialPoints) {
      const currentIndex = closestDrawerSnapPointIndex(points.map((point) => point.offset), currentOffset);
      const movementDirection = Math.sign(movement);
      const velocityDirection = Math.sign(velocity);
      const shouldAdvance = movementDirection !== 0
        && movementDirection === velocityDirection
        && Math.abs(velocity) >= DRAWER_SNAP_VELOCITY_THRESHOLD;
      if (shouldAdvance) {
        const adjacentIndex = clampDrawerNumber(currentIndex + movementDirection, 0, points.length - 1);
        if (adjacentIndex !== currentIndex) {
          const adjacent = points[adjacentIndex]!;
          const wouldStayBehind = movementDirection > 0
            ? targetOffset < adjacent.offset
            : targetOffset > adjacent.offset;
          if (wouldStayBehind) {
            target = adjacent;
            effectiveTargetOffset = adjacent.offset;
          }
        } else if (movementDirection > 0 && options.dismissible !== false) {
          requestSwipeClose(movement, velocity, event);
          return;
        }
      }
    }

    const atMostCollapsedPoint = currentOffset >= points.at(-1)!.offset - 1;
    const thresholdDismissal = atMostCollapsedPoint && movement >= threshold;
    const fastDismissal = !snapToSequentialPoints
      && movement > 0
      && velocity >= DRAWER_FAST_SWIPE_VELOCITY;
    const closeDistance = Math.abs(effectiveTargetOffset - size);
    const snapDistance = Math.abs(effectiveTargetOffset - target.offset);
    if (options.dismissible !== false && (thresholdDismissal || fastDismissal || closeDistance < snapDistance)) {
      requestSwipeClose(movement, velocity, event);
      return;
    }

    clearReleaseState();
    beginRelease(Math.abs(target.offset - dragTarget), velocity);
    if (!snapState.set(target.value, "swipe", event)) clearReleaseState();
  }

  function mountMeasurement(part: "popup" | "viewport", element: Element): Cleanup {
    if (disposed) throw new Error("Drawer has been disposed.");
    if (part === "popup") popupElement = element;
    else viewportElement = element;
    const update = () => updateMountedMeasurements();
    const window = element.ownerDocument?.defaultView;
    const Resize = window?.ResizeObserver
      ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    const observer = Resize ? new Resize(update) : undefined;
    observer?.observe(element);
    window?.addEventListener?.("resize", update, { passive: true });
    update();
    let mounted = true;
    const cleanup = () => {
      if (!mounted) return;
      mounted = false;
      observer?.disconnect();
      window?.removeEventListener?.("resize", update);
      if (part === "popup" && popupElement === element) popupElement = null;
      if (part === "viewport" && viewportElement === element) viewportElement = null;
      measurementMounts.delete(cleanup);
    };
    measurementMounts.add(cleanup);
    return cleanup;
  }

  function updateMountedMeasurements(): void {
    const popup = popupElement;
    const viewport = viewportElement;
    if (popup) popupSize.value = drawerElementSize(popup, axis);
    const ownerDocument = (viewport ?? popup)?.ownerDocument;
    if (viewport) viewportSize.value = drawerElementSize(viewport, axis);
    else if (ownerDocument) {
      const documentSize = axis === "clientX"
        ? ownerDocument.documentElement?.clientWidth
        : ownerDocument.documentElement?.clientHeight;
      const windowSize = axis === "clientX"
        ? ownerDocument.defaultView?.innerWidth
        : ownerDocument.defaultView?.innerHeight;
      viewportSize.value = finiteDrawerLayoutNumber(documentSize) || finiteDrawerLayoutNumber(windowSize);
    }
    const html = ownerDocument?.documentElement;
    const getStyle = ownerDocument?.defaultView?.getComputedStyle;
    if (html && getStyle) {
      try {
        const size = Number.parseFloat(getStyle.call(ownerDocument.defaultView, html).fontSize);
        if (Number.isFinite(size) && size > 0) rootFontSize.value = size;
      } catch {
        // Detached and cross-origin documents can reject computed style reads.
      }
    }
  }
}

function popupManifest(component: string, id: string, open: boolean, role?: string): UiManifest {
  const parts = popupParts(component, role);
  return createUiManifest({
    component,
    id,
    state: { open },
    parts,
    actions: [
      { name: "show", description: `Open the ${component}.`, sideEffects: "write" },
      { name: "hide", description: `Close the ${component}.`, sideEffects: "write" },
      { name: "toggle", description: `Toggle the ${component}.`, sideEffects: "write" },
    ],
    keyboard: { Escape: "Close the topmost layer", Tab: "Move within a trapped focus scope" },
  });
}

function popupParts(component: string, role?: string): Array<{ name: string; role?: string; defaultElement?: string; required?: boolean }> {
  const trigger = { name: "trigger", defaultElement: component === "PreviewCard" ? "a" : "button" };
  const portal = { name: "portal" };
  const backdrop = { name: "backdrop", defaultElement: "div" };
  const positioner = { name: "positioner", defaultElement: "div" };
  const popup = { name: "popup", ...(role ? { role } : {}), defaultElement: "div", required: true };
  const viewport = { name: "viewport", defaultElement: "div" };
  const arrow = { name: "arrow", defaultElement: "div" };
  const title = { name: "title", defaultElement: "h2" };
  const description = { name: "description", defaultElement: "p" };
  const close = { name: "close", role: "button", defaultElement: "button" };
  if (component === "Dialog" || component === "AlertDialog") {
    return [trigger, portal, backdrop, viewport, popup, title, description, close];
  }
  if (component === "Popover") {
    return [trigger, portal, backdrop, positioner, popup, arrow, viewport, title, description, close];
  }
  if (component === "PreviewCard") {
    return [trigger, portal, backdrop, positioner, popup, arrow, viewport];
  }
  if (component === "Tooltip") {
    return [{ name: "provider" }, trigger, portal, positioner, popup, arrow, viewport];
  }
  if (component === "Drawer") {
    return [
      { name: "provider" },
      { name: "indent-background", defaultElement: "div" },
      { name: "indent", defaultElement: "div" },
      trigger,
      { name: "swipe-area", defaultElement: "div" },
      portal,
      backdrop,
      viewport,
      popup,
      { name: "content", defaultElement: "div" },
      title,
      description,
      close,
      { name: "virtual-keyboard-provider" },
    ];
  }
  return [trigger, portal, backdrop, positioner, popup, arrow, viewport, title, description, close];
}

function mapDismissReason(reason: OverlayDismissReason): OpenChangeReason {
  return reason;
}

function requireId(value: string, component: string): string {
  const id = value?.trim();
  if (!id || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new TypeError(`${component} id must start with a letter and contain only letters, numbers, _, ., :, or -.`);
  }
  return id;
}

function readBoolean(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? Boolean(value()) : Boolean(value);
}

function shouldAutoFocus(options: PopupFactoryOptions, reason: OpenChangeReason, trigger: HTMLElement | null): boolean {
  if (options.initialFocus === false) return false;
  if (options.autoFocus !== undefined) {
    return typeof options.autoFocus === "function" ? Boolean(options.autoFocus()) : options.autoFocus;
  }
  if (options.initialFocus) return true;
  if (reason === "hover" || reason === "focus") return false;
  return !retainsInteractionFocus(trigger);
}

function retainsInteractionFocus(element: HTMLElement | null): boolean {
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (element.getAttribute?.("role") === "combobox") return true;
  return element.getAttribute?.("contenteditable") === "true";
}

function focusRemainsWithin(event: FocusEvent): boolean {
  const current = event.currentTarget;
  const related = event.relatedTarget;
  if (!current || !related) return false;
  const ElementClass = (current as Element).ownerDocument?.defaultView?.Node;
  return Boolean(ElementClass && related instanceof ElementClass && (current as Element).contains(related as Node));
}

function nonNegativeDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number.`);
  return value;
}

function drawerDirectionToSwipe(direction: DrawerDirection): DrawerSwipeDirection {
  if (direction === "top") return "up";
  if (direction === "bottom") return "down";
  return direction;
}

function oppositeDrawerSwipeDirection(direction: DrawerSwipeDirection): DrawerSwipeDirection {
  if (direction === "up") return "down";
  if (direction === "down") return "up";
  if (direction === "left") return "right";
  return "left";
}

function validateDrawerSnapPoint(value: DrawerSnapPoint, name: string): DrawerSnapPoint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative finite number or a px/rem length.`);
    }
    return value;
  }
  if (typeof value !== "string" || value.trim() !== value || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)$/.test(value)) {
    throw new TypeError(`${name} must be a non-negative finite number or a px/rem length.`);
  }
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new TypeError(`${name} must be a non-negative finite number or a px/rem length.`);
  }
  return value;
}

function validateDrawerSnapPointSelection(
  value: DrawerSnapPoint | null,
  snapPoints: readonly DrawerSnapPoint[],
  name: string,
): DrawerSnapPoint | null {
  if (value === null) return null;
  const validated = validateDrawerSnapPoint(value, name);
  if (!snapPoints.some((point) => Object.is(point, validated))) {
    throw new TypeError(`${name} must be null or one of the configured snapPoints.`);
  }
  return validated;
}

function resolveDrawerSnapPoint(value: DrawerSnapPoint, viewportSize: number, rootFontSize: number): number {
  if (typeof value === "number") return value <= 1 ? value * viewportSize : value;
  const numeric = Number.parseFloat(value);
  return value.endsWith("rem") ? numeric * rootFontSize : numeric;
}

function closestDrawerSnapPointIndex(values: readonly number[], target: number): number {
  let closestIndex = -1;
  let closestDistance = Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const distance = Math.abs(values[index]! - target);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
}

function finiteDrawerMeasurement(value: number, name: string, allowZero: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} finite number.`);
  }
  return value;
}

function finiteDrawerLayoutNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function drawerElementSize(element: Element, axis: "clientX" | "clientY"): number {
  const candidate = element as Element & {
    clientWidth?: number;
    clientHeight?: number;
    offsetWidth?: number;
    offsetHeight?: number;
  };
  const layout = axis === "clientX"
    ? finiteDrawerLayoutNumber(candidate.clientWidth) || finiteDrawerLayoutNumber(candidate.offsetWidth)
    : finiteDrawerLayoutNumber(candidate.clientHeight) || finiteDrawerLayoutNumber(candidate.offsetHeight);
  if (layout > 0) return layout;
  const rect = element.getBoundingClientRect?.();
  return finiteDrawerLayoutNumber(axis === "clientX" ? rect?.width : rect?.height);
}

function drawerEventTime(event: Event): number | null {
  const time = event.timeStamp;
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function clampDrawerNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function eventPathHas(event: Event, attribute: string): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const entry of path) {
    if (isElementLike(entry) && entry.hasAttribute(attribute)) return true;
  }
  const target = event.target;
  return isElementLike(target) && Boolean(target.closest?.(`[${attribute}]`));
}

function isSwipeIgnored(event: Event): boolean {
  return eventPathHas(event, "data-clank-swipe-ignore") || eventPathHas(event, "data-base-ui-swipe-ignore");
}

function isElementLike(value: unknown): value is Element {
  return Boolean(value && typeof value === "object" && "hasAttribute" in value && typeof (value as Element).hasAttribute === "function");
}
