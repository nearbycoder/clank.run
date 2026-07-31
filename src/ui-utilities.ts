import {
  computed,
  signal,
  type Cleanup,
  type Computed,
  type ReactiveSignal,
} from "./core.ts";
import { useCspNonce, useDirection } from "./ui-composition.ts";
import {
  createUiManifest,
  resolveDirection,
  type Direction,
  type DirectionInput,
  type Orientation,
  type UiManifest,
} from "./ui-foundation.ts";

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
  /** Accessible name override. Defaults to the scrollbar axis. */
  label?: string;
  /** ID reference that takes precedence over label when non-empty. */
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
  scrollTo(position: { left?: number; top?: number; behavior?: ScrollBehavior }): void;
  manifest(): UiManifest;
  dispose(): void;
}

interface ScrollMeasurements {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
  verticalScrollbarWidth: number;
  horizontalScrollbarHeight: number;
}

interface ScrollDrag {
  orientation: Orientation;
  pointerId: number;
  startCoordinate: number;
  startOffset: number;
  trackTravel: number;
  maxOffset: number;
  target: Element & { setPointerCapture?(pointerId: number): void; releasePointerCapture?(pointerId: number): void };
  document: Document | null;
  move(event: PointerEvent): void;
  end(event?: PointerEvent): void;
}

const rtlBehaviorCache = new WeakMap<Document, RtlScrollBehavior>();
const nativeScrollbarStyles = new WeakMap<Document, Map<string, {
  element: HTMLStyleElement;
  parent: ParentNode;
  users: number;
}>>();

/**
 * Native scrolling with optional styled scrollbars. Custom tracks mirror the
 * viewport instead of replacing it, preserving touch, keyboard, and assistive
 * technology behavior.
 */
export function createScrollArea(options: ScrollAreaOptions): ScrollAreaController {
  const id = requireId(options.id, "ScrollArea");
  const inheritedDirection = useDirection();
  const cspNonce = useCspNonce();
  const requestedMode = options.scrollbarMode ?? "auto";
  if (requestedMode !== "hide" && requestedMode !== "hidden" && requestedMode !== "auto" && requestedMode !== "always") {
    throw new TypeError("ScrollArea scrollbarMode must be hide, hidden, auto, or always.");
  }
  const mode: Exclude<ScrollAreaScrollbarMode, "hide"> = requestedMode === "hide" ? "hidden" : requestedMode;
  const minThumbSize = finiteNonNegative(options.minThumbSize ?? 18, "ScrollArea minThumbSize");
  const overflowX = signal(false, { name: `${id}.overflowX` });
  const overflowY = signal(false, { name: `${id}.overflowY` });
  const scrollX = signal(0, { name: `${id}.scrollX` });
  const scrollY = signal(0, { name: `${id}.scrollY` });
  const maxScrollX = signal(0, { name: `${id}.maxScrollX` });
  const maxScrollY = signal(0, { name: `${id}.maxScrollY` });
  const measurementVersion = signal(0, { name: `${id}.measurementVersion` });
  const measurements: ScrollMeasurements = {
    viewportWidth: 0,
    viewportHeight: 0,
    contentWidth: 0,
    contentHeight: 0,
    verticalScrollbarWidth: 0,
    horizontalScrollbarHeight: 0,
  };
  let rootElement: HTMLElement | null = null;
  let viewportElement: HTMLElement | null = null;
  let contentElement: HTMLElement | null = null;
  const scrollbarElements: Partial<Record<Orientation, HTMLElement>> = {};
  const thumbElements: Partial<Record<Orientation, HTMLElement>> = {};
  let resizeObserver: ScrollAreaResizeObserver | null = null;
  let fallbackResizeCleanup: Cleanup | undefined;
  let drag: ScrollDrag | null = null;
  let disposed = false;
  let measuredDirection = resolveDirection(options.direction ?? inheritedDirection);

  const direction = (): Direction => resolveDirection(options.direction ?? inheritedDirection, rootElement ?? viewportElement);
  const visible = (orientation: Orientation) => {
    if (mode === "hidden") return false;
    if (mode === "always") return true;
    return orientation === "horizontal" ? overflowX.value : overflowY.value;
  };
  const maximum = (orientation: Orientation) => orientation === "horizontal" ? maxScrollX.value : maxScrollY.value;
  const offset = (orientation: Orientation) => orientation === "horizontal" ? scrollX.value : scrollY.value;
  const viewportSize = (orientation: Orientation) => orientation === "horizontal"
    ? measurements.viewportWidth
    : measurements.viewportHeight;
  const trackSize = (orientation: Orientation) => {
    const track = scrollbarElements[orientation];
    return positiveNumber(orientation === "horizontal" ? track?.clientWidth : track?.clientHeight)
      || viewportSize(orientation);
  };
  const thumbSize = (orientation: Orientation) => {
    const track = trackSize(orientation);
    const view = viewportSize(orientation);
    const total = view + maximum(orientation);
    if (track <= 0 || total <= 0) return track;
    return Math.min(track, Math.max(minThumbSize, track * view / total));
  };
  const thumbOffset = (orientation: Orientation) => {
    const maximumOffset = maximum(orientation);
    if (maximumOffset <= 0) return 0;
    return (trackSize(orientation) - thumbSize(orientation)) * offset(orientation) / maximumOffset;
  };

  const ensureObserver = (element: Element): void => {
    if (resizeObserver || disposed) return;
    const view = element.ownerDocument?.defaultView;
    const Observer = view?.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    try {
      resizeObserver = options.createResizeObserver
        ? options.createResizeObserver(() => measure())
        : Observer ? new Observer(() => measure()) : null;
    } catch {
      resizeObserver = null;
    }
    if (!resizeObserver && view && !fallbackResizeCleanup) {
      const listener = () => measure();
      view.addEventListener?.("resize", listener, { passive: true });
      fallbackResizeCleanup = () => view.removeEventListener?.("resize", listener);
    }
  };

  const observe = (element: HTMLElement): void => {
    ensureObserver(element);
    try { resizeObserver?.observe(element); } catch { /* Detached adapters may reject observation. */ }
  };

  const unobserve = (element: HTMLElement): void => {
    try { resizeObserver?.unobserve?.(element); } catch { /* Already disconnected. */ }
  };

  const bind = (
    element: Element,
    set: (element: HTMLElement | null) => void,
    listenForScroll = false,
  ): Cleanup => {
    if (disposed) return () => {};
    const html = element as HTMLElement;
    set(html);
    observe(html);
    const listener = () => measure();
    if (listenForScroll) html.addEventListener?.("scroll", listener, { passive: true });
    measure();
    return () => {
      if (listenForScroll) html.removeEventListener?.("scroll", listener);
      unobserve(html);
      set(null);
      if (!disposed) measure();
    };
  };

  const measure = (): void => {
    if (disposed) return;
    const viewport = viewportElement;
    if (!viewport) return;
    const viewportWidth = positiveNumber(viewport.clientWidth);
    const viewportHeight = positiveNumber(viewport.clientHeight);
    const contentWidth = Math.max(
      positiveNumber(viewport.scrollWidth),
      positiveNumber(contentElement?.scrollWidth),
      rectSize(contentElement, "width"),
    );
    const contentHeight = Math.max(
      positiveNumber(viewport.scrollHeight),
      positiveNumber(contentElement?.scrollHeight),
      rectSize(contentElement, "height"),
    );
    const verticalScrollbarWidth = positiveNumber(scrollbarElements.vertical?.clientWidth);
    const horizontalScrollbarHeight = positiveNumber(scrollbarElements.horizontal?.clientHeight);
    const currentDirection = direction();
    const dimensionsChanged = measurements.viewportWidth !== viewportWidth
      || measurements.viewportHeight !== viewportHeight
      || measurements.contentWidth !== contentWidth
      || measurements.contentHeight !== contentHeight
      || measurements.verticalScrollbarWidth !== verticalScrollbarWidth
      || measurements.horizontalScrollbarHeight !== horizontalScrollbarHeight
      || measuredDirection !== currentDirection;
    measurements.viewportWidth = viewportWidth;
    measurements.viewportHeight = viewportHeight;
    measurements.contentWidth = contentWidth;
    measurements.contentHeight = contentHeight;
    measurements.verticalScrollbarWidth = verticalScrollbarWidth;
    measurements.horizontalScrollbarHeight = horizontalScrollbarHeight;
    measuredDirection = currentDirection;
    const nextMaxX = Math.max(0, contentWidth - viewportWidth);
    const nextMaxY = Math.max(0, contentHeight - viewportHeight);
    maxScrollX.value = nextMaxX;
    maxScrollY.value = nextMaxY;
    overflowX.value = nextMaxX > 0.5;
    overflowY.value = nextMaxY > 0.5;
    scrollX.value = clamp(readLogicalScrollLeft(viewport, currentDirection, rtlBehavior(viewport, options)), 0, nextMaxX);
    scrollY.value = clamp(positiveNumber(viewport.scrollTop), 0, nextMaxY);
    if (dimensionsChanged) measurementVersion.value++;
  };

  const setOffset = (orientation: Orientation, next: number, behavior: ScrollBehavior = "auto"): void => {
    const viewport = viewportElement;
    if (!viewport) return;
    const value = clamp(Number.isFinite(next) ? next : 0, 0, maximum(orientation));
    if (orientation === "horizontal") {
      const raw = writeLogicalScrollLeft(value, maximum(orientation), direction(), rtlBehavior(viewport, options));
      if (typeof viewport.scrollTo === "function") viewport.scrollTo({ left: raw, behavior });
      else viewport.scrollLeft = raw;
      scrollX.value = value;
    } else {
      if (typeof viewport.scrollTo === "function") viewport.scrollTo({ top: value, behavior });
      else viewport.scrollTop = value;
      scrollY.value = value;
    }
  };

  const pageTrack = (orientation: Orientation, event: PointerEvent): void => {
    if (event.defaultPrevented || !visible(orientation) || maximum(orientation) <= 0 || event.button > 0) return;
    if (event.target !== event.currentTarget) return;
    const track = event.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect?.();
    if (!rect) return;
    const coordinate = orientation === "horizontal" ? event.clientX - rect.left : event.clientY - rect.top;
    const center = thumbOffset(orientation) + thumbSize(orientation) / 2;
    let physicalDirection = coordinate < center ? -1 : 1;
    if (orientation === "horizontal" && direction() === "rtl") physicalDirection *= -1;
    setOffset(orientation, offset(orientation) + physicalDirection * viewportSize(orientation));
    event.preventDefault?.();
  };

  const beginDrag = (orientation: Orientation, event: PointerEvent): void => {
    if (event.defaultPrevented || !visible(orientation) || maximum(orientation) <= 0 || event.button > 0) return;
    clearDrag();
    const target = event.currentTarget as ScrollDrag["target"];
    const document = target.ownerDocument ?? null;
    const state: ScrollDrag = {
      orientation,
      pointerId: event.pointerId,
      startCoordinate: orientation === "horizontal" ? event.clientX : event.clientY,
      startOffset: offset(orientation),
      trackTravel: Math.max(1, trackSize(orientation) - thumbSize(orientation)),
      maxOffset: maximum(orientation),
      target,
      document,
      move(moveEvent) {
        if (moveEvent.pointerId !== state.pointerId) return;
        const coordinate = orientation === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        let delta = coordinate - state.startCoordinate;
        if (orientation === "horizontal" && direction() === "rtl") delta *= -1;
        setOffset(orientation, state.startOffset + delta * state.maxOffset / state.trackTravel);
        moveEvent.preventDefault?.();
      },
      end(endEvent) {
        if (endEvent && endEvent.pointerId !== state.pointerId) return;
        if (drag !== state) return;
        try { state.target.releasePointerCapture?.(state.pointerId); } catch { /* Capture may already be gone. */ }
        state.document?.removeEventListener?.("pointermove", state.move as EventListener, true);
        state.document?.removeEventListener?.("pointerup", state.end as EventListener, true);
        state.document?.removeEventListener?.("pointercancel", state.end as EventListener, true);
        drag = null;
      },
    };
    drag = state;
    try { target.setPointerCapture?.(event.pointerId); } catch { /* Document listeners are the fallback. */ }
    document?.addEventListener?.("pointermove", state.move as EventListener, true);
    document?.addEventListener?.("pointerup", state.end as EventListener, true);
    document?.addEventListener?.("pointercancel", state.end as EventListener, true);
    event.preventDefault?.();
  };

  const clearDrag = (): void => {
    drag?.end();
  };

  const wheel = (orientation: Orientation, event: WheelEvent): void => {
    // Ctrl+wheel is browser zoom (and the event shape used by trackpad pinch
    // zoom in Chromium). A custom scrollbar must never consume it.
    if (event.defaultPrevented || event.ctrlKey) return;
    const primary = orientation === "horizontal"
      ? (Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY)
      : event.deltaY;
    if (!Number.isFinite(primary) || primary === 0) return;
    let logicalDelta = primary;
    if (orientation === "horizontal" && direction() === "rtl" && event.deltaX !== 0) logicalDelta *= -1;
    const current = offset(orientation);
    const next = clamp(current + logicalDelta, 0, maximum(orientation));
    if (next === current) return; // Preserve scroll chaining at the boundary.
    setOffset(orientation, next);
    event.preventDefault?.();
  };

  const keydown = (orientation: Orientation, event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const rtl = orientation === "horizontal" && direction() === "rtl";
    let next: number | undefined;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = maximum(orientation);
    else if (event.key === "PageDown") next = offset(orientation) + viewportSize(orientation);
    else if (event.key === "PageUp") next = offset(orientation) - viewportSize(orientation);
    else if (orientation === "vertical" && event.key === "ArrowDown") next = offset(orientation) + 40;
    else if (orientation === "vertical" && event.key === "ArrowUp") next = offset(orientation) - 40;
    else if (orientation === "horizontal" && event.key === "ArrowRight") next = offset(orientation) + (rtl ? -40 : 40);
    else if (orientation === "horizontal" && event.key === "ArrowLeft") next = offset(orientation) + (rtl ? 40 : -40);
    if (next === undefined) return;
    setOffset(orientation, next);
    event.preventDefault?.();
  };

  const scrollbarHidden = (orientation: Orientation) => !visible(orientation);
  const commonStyle = () => ({
    // Subscribe renderers even when dimensions change without changing overflow.
    "--clank-scroll-area-measurement": measurementVersion.value,
    "--clank-scroll-area-viewport-width": px(measurements.viewportWidth),
    "--clank-scroll-area-viewport-height": px(measurements.viewportHeight),
    "--clank-scroll-area-content-width": px(measurements.contentWidth),
    "--clank-scroll-area-content-height": px(measurements.contentHeight),
    "--clank-scroll-area-scroll-x": px(scrollX.value),
    "--clank-scroll-area-scroll-y": px(scrollY.value),
    "--clank-scroll-area-corner-width": px(measurements.verticalScrollbarWidth),
    "--clank-scroll-area-corner-height": px(measurements.horizontalScrollbarHeight),
  });

  const controller: ScrollAreaController = {
    id,
    overflowX,
    overflowY,
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    root: () => ({
      id,
      "data-clank-part": "root",
      dir: () => {
        measurementVersion.value;
        return direction();
      },
      ...(options.label ? { "aria-label": options.label } : {}),
      ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
      "data-overflow-x": () => overflowX.value ? "" : undefined,
      "data-overflow-y": () => overflowY.value ? "" : undefined,
      "data-scrollbar-mode": mode,
      style: commonStyle,
      use: (element: Element) => bind(element, (next) => { rootElement = next; }),
    }),
    viewport: () => ({
      id: `${id}-viewport`,
      "data-clank-part": "viewport",
      "data-clank-scroll-area-viewport": "",
      tabIndex: options.viewportTabIndex ?? 0,
      "data-overflow-x": () => overflowX.value ? "" : undefined,
      "data-overflow-y": () => overflowY.value ? "" : undefined,
      style: {
        overflowX: "auto",
        overflowY: "auto",
        // Scrolling remains native; only the browser-drawn track is replaced.
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      },
      onScroll: () => measure(),
      use: (element: Element) => {
        const releaseScrollbarStyle = acquireNativeScrollbarStyle(element.ownerDocument, cspNonce);
        const releaseViewport = bind(element, (next) => { viewportElement = next; }, true);
        return () => {
          releaseViewport();
          releaseScrollbarStyle();
        };
      },
    }),
    content: () => ({
      id: `${id}-content`,
      "data-clank-part": "content",
      "data-overflow-x": () => overflowX.value ? "" : undefined,
      "data-overflow-y": () => overflowY.value ? "" : undefined,
      use: (element: Element) => bind(element, (next) => { contentElement = next; }),
    }),
    scrollbar: (orientation, scrollbarOptions = {}) => {
      requireOrientation(orientation);
      const labelledBy = scrollbarOptions.labelledBy?.trim();
      const label = scrollbarOptions.label?.trim()
        || (orientation === "horizontal" ? "Horizontal scrollbar" : "Vertical scrollbar");
      return {
        id: `${id}-scrollbar-${orientation}`,
        role: "scrollbar",
        ...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": label }),
        "data-clank-part": "scrollbar",
        tabIndex: () => scrollbarHidden(orientation) || maximum(orientation) <= 0 ? -1 : 0,
        "aria-controls": `${id}-viewport`,
        "aria-orientation": orientation,
        "aria-valuemin": 0,
        "aria-valuemax": () => maximum(orientation),
        "aria-valuenow": () => offset(orientation),
        "aria-disabled": () => maximum(orientation) <= 0,
        "aria-hidden": () => scrollbarHidden(orientation) ? true : undefined,
        hidden: () => scrollbarHidden(orientation),
        "data-orientation": orientation,
        "data-visible": () => visible(orientation) ? "" : undefined,
        "data-overflowing": () => maximum(orientation) > 0 ? "" : undefined,
        style: () => ({
          "--clank-scroll-area-measurement": measurementVersion.value,
          "--clank-scroll-area-thumb-size": px(thumbSize(orientation)),
          "--clank-scroll-area-thumb-offset": px(thumbOffset(orientation)),
        }),
        onPointerDown: (event: PointerEvent) => pageTrack(orientation, event),
        onWheel: (event: WheelEvent) => wheel(orientation, event),
        onKeyDown: (event: KeyboardEvent) => keydown(orientation, event),
        use: (element: Element) => bind(element, (next) => {
          if (next) scrollbarElements[orientation] = next;
          else delete scrollbarElements[orientation];
        }),
      };
    },
    thumb: (orientation) => {
      requireOrientation(orientation);
      return {
        id: `${id}-thumb-${orientation}`,
        "aria-hidden": true,
        "data-clank-part": "thumb",
        "data-orientation": orientation,
        "data-dragging": () => drag?.orientation === orientation ? "" : undefined,
        style: () => orientation === "horizontal" ? {
          touchAction: "none",
          userSelect: "none",
          "--clank-scroll-area-measurement": measurementVersion.value,
          width: px(thumbSize(orientation)),
          transform: `translate3d(${direction() === "rtl" ? -thumbOffset(orientation) : thumbOffset(orientation)}px, 0, 0)`,
          "--clank-scroll-area-thumb-size": px(thumbSize(orientation)),
          "--clank-scroll-area-thumb-offset": px(thumbOffset(orientation)),
        } : {
          touchAction: "none",
          userSelect: "none",
          "--clank-scroll-area-measurement": measurementVersion.value,
          height: px(thumbSize(orientation)),
          transform: `translate3d(0, ${thumbOffset(orientation)}px, 0)`,
          "--clank-scroll-area-thumb-size": px(thumbSize(orientation)),
          "--clank-scroll-area-thumb-offset": px(thumbOffset(orientation)),
        },
        onPointerDown: (event: PointerEvent) => beginDrag(orientation, event),
        use: (element: Element) => bind(element, (next) => {
          if (next) thumbElements[orientation] = next;
          else delete thumbElements[orientation];
        }),
      };
    },
    corner: () => ({
      id: `${id}-corner`,
      "aria-hidden": true,
      "data-clank-part": "corner",
      hidden: () => mode === "hidden" || !overflowX.value || !overflowY.value,
      "data-visible": () => mode !== "hidden" && overflowX.value && overflowY.value ? "" : undefined,
      style: () => ({
        "--clank-scroll-area-measurement": measurementVersion.value,
        width: px(measurements.verticalScrollbarWidth),
        height: px(measurements.horizontalScrollbarHeight),
      }),
    }),
    measure,
    scrollTo(position) {
      if (position.left !== undefined) setOffset("horizontal", position.left, position.behavior);
      if (position.top !== undefined) setOffset("vertical", position.top, position.behavior);
    },
    manifest: () => createUiManifest({
      component: "ScrollArea",
      id,
      state: {
        direction: direction(),
        scrollbarMode: mode,
        overflowX: overflowX.peek(),
        overflowY: overflowY.peek(),
        scrollX: scrollX.peek(),
        scrollY: scrollY.peek(),
        maxScrollX: maxScrollX.peek(),
        maxScrollY: maxScrollY.peek(),
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "viewport", defaultElement: "div", required: true },
        { name: "content", defaultElement: "div", required: true },
        { name: "scrollbar", role: "scrollbar", defaultElement: "div" },
        { name: "thumb", defaultElement: "div" },
        { name: "corner", defaultElement: "div" },
      ],
      actions: [
        { name: "measure", description: "Recalculate overflow and scrollbar geometry.", sideEffects: "read" },
        { name: "scrollTo", description: "Scroll the viewport to logical coordinates.", sideEffects: "write" },
      ],
      keyboard: {
        "Arrow keys": "Move the focused scrollbar by a small step.",
        "Page Up / Page Down": "Move by one viewport.",
        "Home / End": "Move to the logical start or end.",
      },
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearDrag();
      resizeObserver?.disconnect();
      resizeObserver = null;
      fallbackResizeCleanup?.();
      fallbackResizeCleanup = undefined;
      rootElement = null;
      viewportElement = null;
      contentElement = null;
      delete scrollbarElements.horizontal;
      delete scrollbarElements.vertical;
      delete thumbElements.horizontal;
      delete thumbElements.vertical;
    },
  };
  return controller;
}

/**
 * Inline styles cannot address WebKit's scrollbar pseudo-element. Install one
 * tiny, document-deduplicated behavioral rule while a viewport is mounted so
 * Chromium/Safari never render a native bar beneath Clank's custom tracks.
 */
function acquireNativeScrollbarStyle(document: Document | null | undefined, nonce?: string): Cleanup {
  if (!document || typeof document.createElement !== "function") return () => {};
  const parent = document.head ?? document.documentElement;
  if (!parent || typeof (parent as Node).appendChild !== "function") return () => {};
  const key = nonce ?? "";
  let byNonce = nativeScrollbarStyles.get(document);
  if (!byNonce) {
    byNonce = new Map();
    nativeScrollbarStyles.set(document, byNonce);
  }
  let state = byNonce.get(key);
  if (!state) {
    const element = document.createElement("style");
    element.setAttribute("data-clank-scroll-area-style", "");
    if (nonce) element.nonce = nonce;
    element.textContent = "[data-clank-scroll-area-viewport]::-webkit-scrollbar{display:none}";
    (parent as Node).appendChild(element);
    state = { element, parent, users: 0 };
    byNonce.set(key, state);
  }
  state.users++;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (!state || --state.users > 0) return;
    if (typeof state.element.remove === "function") state.element.remove();
    else if (state.element.parentNode === state.parent) (state.parent as Node).removeChild(state.element);
    byNonce!.delete(key);
    if (byNonce!.size === 0) nativeScrollbarStyles.delete(document);
  };
}

export type ToastPriority = "polite" | "assertive";
export type ToastState = "queued" | "starting" | "open" | "ending";
export type ToastCloseReason =
  | "timeout"
  | "close-button"
  | "action"
  | "escape-key"
  | "swipe"
  | "programmatic"
  | "dismiss-all";
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

export type ToastMessage<Value = unknown> =
  | string
  | ToastUpdate
  | ((value: Value) => string | ToastUpdate);

export interface ToastPromiseMessages<Value> {
  loading: string | ToastUpdate;
  success: ToastMessage<Value>;
  error: ToastMessage<unknown>;
}

export interface ToastPromiseOptions extends Omit<ToastInput, "title" | "description" | "action"> {}

export type ToastPromise<Value> = Promise<Value> & { readonly toastId: string };

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

interface InternalToast {
  id: string;
  dedupeKey?: string;
  title?: string;
  description?: string;
  priority: ToastPriority;
  duration: number;
  action?: ToastAction;
  anchor?: ToastAnchorMetadata;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  onClose?: (reason: ToastCloseReason) => void;
  state: ToastState;
  createdAt: number;
  updatedAt: number;
  remaining: number;
  timer?: unknown;
  timerStartedAt?: number;
  exitTimer?: unknown;
  swipeX: number;
  swipeY: number;
  swipeDirection?: ToastSwipeDirection;
}

/** A renderer-independent toast store with deterministic queue and timer behavior. */
export function createToastManager(options: ToastManagerOptions = {}): ToastManager {
  const id = requireId(options.id ?? "toasts", "ToastManager");
  const limit = positiveInteger(options.limit ?? 3, "ToastManager limit");
  const defaultDuration = durationValue(options.duration ?? 5_000, "ToastManager duration");
  const exitDuration = finiteNonNegative(options.exitDuration ?? 200, "ToastManager exitDuration");
  const clock = options.clock ?? systemToastClock;
  const toasts = signal<readonly ToastRecord[]>([], { name: `${id}.toasts`, equals: false });
  const pauseReasons = new Set<string>();
  const pauseVersion = signal(0, { name: `${id}.pauseVersion` });
  const records = new Map<string, InternalToast>();
  const order: string[] = [];
  let serial = 0;
  let disposed = false;

  const visible = computed(() => toasts.value.filter((toast) => toast.state !== "queued"), { name: `${id}.visible` });
  const queued = computed(() => toasts.value.filter((toast) => toast.state === "queued"), { name: `${id}.queued` });
  const paused = computed(() => {
    pauseVersion.value;
    return pauseReasons.size > 0;
  }, { name: `${id}.paused` });

  const publish = (): void => {
    const active = order.map((toastId) => records.get(toastId)).filter((toast): toast is InternalToast => Boolean(toast));
    const visibleRecords = active.filter((toast) => toast.state !== "queued");
    const queuedRecords = active.filter((toast) => toast.state === "queued");
    const snapshots = active.map((toast): ToastRecord => Object.freeze({
      id: toast.id,
      ...(toast.dedupeKey ? { dedupeKey: toast.dedupeKey } : {}),
      ...(toast.title !== undefined ? { title: toast.title } : {}),
      ...(toast.description !== undefined ? { description: toast.description } : {}),
      priority: toast.priority,
      duration: toast.duration,
      ...(toast.action ? { action: Object.freeze({ ...toast.action }) } : {}),
      ...(toast.anchor ? { anchor: Object.freeze({ ...toast.anchor }) } : {}),
      ...(toast.metadata ? { metadata: Object.freeze({ ...toast.metadata }) } : {}),
      state: toast.state,
      createdAt: toast.createdAt,
      updatedAt: toast.updatedAt,
      visibleIndex: visibleRecords.indexOf(toast),
      queuedIndex: queuedRecords.indexOf(toast),
      paused: pauseReasons.size > 0,
      swipeX: toast.swipeX,
      swipeY: toast.swipeY,
      ...(toast.swipeDirection ? { swipeDirection: toast.swipeDirection } : {}),
    }));
    toasts.value = Object.freeze(snapshots);
    options.onChange?.(toasts.peek());
  };

  const clearTimer = (toast: InternalToast, preserveRemaining: boolean): void => {
    if (toast.timer === undefined) return;
    clock.clearTimeout(toast.timer);
    toast.timer = undefined;
    if (preserveRemaining && toast.timerStartedAt !== undefined && Number.isFinite(toast.remaining)) {
      toast.remaining = Math.max(0, toast.remaining - Math.max(0, clock.now() - toast.timerStartedAt));
    }
    toast.timerStartedAt = undefined;
  };

  const scheduleTimer = (toast: InternalToast): void => {
    clearTimer(toast, false);
    if (disposed || toast.state !== "open" || pauseReasons.size > 0 || !Number.isFinite(toast.remaining)) return;
    if (toast.remaining <= 0) {
      close(toast.id, "timeout");
      return;
    }
    toast.timerStartedAt = clock.now();
    toast.timer = clock.setTimeout(() => {
      toast.timer = undefined;
      toast.timerStartedAt = undefined;
      toast.remaining = 0;
      close(toast.id, "timeout");
    }, toast.remaining);
  };

  const openStarting = (toast: InternalToast): void => {
    scheduleMicrotask(clock, () => {
      if (disposed || records.get(toast.id) !== toast || toast.state !== "starting") return;
      toast.state = "open";
      toast.updatedAt = clock.now();
      publish();
      scheduleTimer(toast);
    });
  };

  const promote = (): void => {
    const occupying = order.reduce((count, toastId) => {
      const state = records.get(toastId)?.state;
      return state && state !== "queued" ? count + 1 : count;
    }, 0);
    let available = Math.max(0, limit - occupying);
    if (available === 0) return;
    for (const toastId of order) {
      const toast = records.get(toastId);
      if (!toast || toast.state !== "queued") continue;
      toast.state = "starting";
      toast.updatedAt = clock.now();
      available--;
      openStarting(toast);
      if (available === 0) break;
    }
    publish();
  };

  const remove = (toast: InternalToast): void => {
    clearTimer(toast, false);
    if (toast.exitTimer !== undefined) clock.clearTimeout(toast.exitTimer);
    toast.exitTimer = undefined;
    records.delete(toast.id);
    const index = order.indexOf(toast.id);
    if (index >= 0) order.splice(index, 1);
    publish();
    promote();
  };

  const close = (toastId: string, reason: ToastCloseReason = "programmatic"): boolean => {
    const toast = records.get(toastId);
    if (!toast || toast.state === "ending") return false;
    clearTimer(toast, false);
    const onClose = toast.onClose;
    if (toast.state === "queued" || exitDuration === 0) {
      remove(toast);
      onClose?.(reason);
      return true;
    }
    toast.state = "ending";
    toast.updatedAt = clock.now();
    publish();
    toast.exitTimer = clock.setTimeout(() => remove(toast), exitDuration);
    onClose?.(reason);
    return true;
  };

  const normalizeInput = (input: string | ToastInput): ToastInput => typeof input === "string" ? { title: input } : input;

  const add = (raw: string | ToastInput): string => {
    if (disposed) throw new Error("Cannot add a toast to a disposed manager.");
    const input = normalizeInput(raw);
    validateToastContent(input);
    if (input.id !== undefined) requireId(input.id, "Toast");
    const duplicate = input.id ? records.get(input.id) : input.dedupeKey
      ? [...records.values()].find((toast) => toast.dedupeKey === input.dedupeKey && toast.state !== "ending")
      : undefined;
    if (duplicate && duplicate.state === "ending") remove(duplicate);
    else if (duplicate) {
      update(duplicate.id, input);
      return duplicate.id;
    }
    const toastId = input.id ?? `${id}-${++serial}`;
    if (records.has(toastId)) {
      update(toastId, input);
      return toastId;
    }
    const now = clock.now();
    const duration = durationValue(input.duration ?? defaultDuration, "Toast duration");
    const visibleCount = order.filter((entry) => records.get(entry)?.state !== "queued").length;
    const toast: InternalToast = {
      id: toastId,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      ...(input.title !== undefined ? { title: textValue(input.title, "Toast title") } : {}),
      ...(input.description !== undefined ? { description: textValue(input.description, "Toast description") } : {}),
      priority: priorityValue(input.priority),
      duration,
      ...(input.action ? { action: actionValue(input.action) } : {}),
      ...(input.anchor ? { anchor: anchorValue(input.anchor) } : {}),
      ...(input.metadata ? { metadata: metadataValue(input.metadata) } : {}),
      ...(input.onClose ? { onClose: input.onClose } : {}),
      state: visibleCount < limit ? "starting" : "queued",
      createdAt: now,
      updatedAt: now,
      remaining: duration,
      swipeX: 0,
      swipeY: 0,
    };
    records.set(toastId, toast);
    order.push(toastId);
    publish();
    if (toast.state === "starting") openStarting(toast);
    return toastId;
  };

  const update = (toastId: string, raw: string | ToastUpdate): boolean => {
    const toast = records.get(toastId);
    if (!toast || toast.state === "ending") return false;
    const input: ToastUpdate = typeof raw === "string" ? { title: raw } : raw;
    validateToastContent(input, true);
    const nextTitle = input.title === undefined
      ? toast.title
      : input.title === null ? undefined : textValue(input.title, "Toast title");
    const nextDescription = input.description === undefined
      ? toast.description
      : input.description === null ? undefined : textValue(input.description, "Toast description");
    if (nextTitle === undefined && nextDescription === undefined) {
      throw new TypeError("A toast update cannot remove both title and description.");
    }
    const nextDedupeKey = input.dedupeKey === undefined ? toast.dedupeKey : input.dedupeKey || undefined;
    const nextPriority = input.priority === undefined ? toast.priority : priorityValue(input.priority);
    const nextDuration = input.duration === undefined ? toast.duration : durationValue(input.duration, "Toast duration");
    const nextAction = input.action === undefined ? toast.action : input.action === null ? undefined : actionValue(input.action);
    const nextAnchor = input.anchor === undefined ? toast.anchor : input.anchor === null ? undefined : anchorValue(input.anchor);
    const nextMetadata = input.metadata === undefined ? toast.metadata : input.metadata === null ? undefined : metadataValue(input.metadata);
    const nextOnClose = input.onClose === undefined ? toast.onClose : input.onClose ?? undefined;
    clearTimer(toast, true);
    toast.title = nextTitle;
    toast.description = nextDescription;
    toast.dedupeKey = nextDedupeKey;
    toast.priority = nextPriority;
    toast.action = nextAction;
    toast.anchor = nextAnchor;
    toast.metadata = nextMetadata;
    toast.onClose = nextOnClose;
    if (input.duration !== undefined) {
      toast.duration = nextDuration;
      toast.remaining = toast.duration;
    } else if (toast.remaining <= 0) {
      toast.remaining = toast.duration;
    }
    toast.updatedAt = clock.now();
    publish();
    scheduleTimer(toast);
    return true;
  };

  const manager: ToastManager = {
    id,
    toasts,
    visible,
    queued,
    paused,
    add,
    update,
    close,
    dismissAll(reason = "dismiss-all") {
      let count = 0;
      for (const toastId of [...order]) if (close(toastId, reason)) count++;
      return count;
    },
    get(toastId) {
      return toasts.peek().find((toast) => toast.id === toastId);
    },
    pause(reason = "programmatic") {
      if (disposed || pauseReasons.has(reason)) return;
      pauseReasons.add(reason);
      pauseVersion.value++;
      for (const toast of records.values()) clearTimer(toast, true);
      publish();
    },
    resume(reason = "programmatic") {
      if (disposed || !pauseReasons.delete(reason)) return;
      pauseVersion.value++;
      publish();
      if (pauseReasons.size === 0) for (const toast of records.values()) scheduleTimer(toast);
    },
    promise<Value>(promiseInput: PromiseLike<Value> | (() => PromiseLike<Value>), messages: ToastPromiseMessages<Value>, promiseOptions: ToastPromiseOptions = {}) {
      const loading = toastMessage(messages.loading, undefined);
      const initial = { ...promiseOptions, ...loading };
      const toastId = add({
        ...(initial.id === undefined ? {} : { id: initial.id }),
        ...(initial.dedupeKey == null ? {} : { dedupeKey: initial.dedupeKey }),
        ...(initial.title == null ? {} : { title: initial.title }),
        ...(initial.description == null ? {} : { description: initial.description }),
        ...(initial.priority === undefined ? {} : { priority: initial.priority }),
        ...(initial.action == null ? {} : { action: initial.action }),
        ...(initial.anchor == null ? {} : { anchor: initial.anchor }),
        ...(initial.metadata == null ? {} : { metadata: initial.metadata }),
        ...(initial.onClose == null ? {} : { onClose: initial.onClose }),
        duration: Number.POSITIVE_INFINITY,
      });
      let source: PromiseLike<Value>;
      try {
        source = typeof promiseInput === "function" ? promiseInput() : promiseInput;
      } catch (error) {
        const failure = toastMessage(messages.error, error);
        update(toastId, { ...failure, duration: promiseOptions.duration ?? defaultDuration });
        const rejected = Promise.reject(error) as ToastPromise<Value>;
        Object.defineProperty(rejected, "toastId", { value: toastId, enumerable: true });
        return rejected;
      }
      const tracked = Promise.resolve(source).then(
        (value) => {
          const success = toastMessage(messages.success, value);
          update(toastId, { ...success, duration: promiseOptions.duration ?? defaultDuration });
          return value;
        },
        (error) => {
          const failure = toastMessage(messages.error, error);
          update(toastId, { ...failure, duration: promiseOptions.duration ?? defaultDuration });
          throw error;
        },
      ) as ToastPromise<Value>;
      Object.defineProperty(tracked, "toastId", { value: toastId, enumerable: true });
      return tracked;
    },
    manifest: () => createUiManifest({
      component: "ToastManager",
      id,
      state: {
        total: toasts.peek().length,
        visible: visible.peek().length,
        queued: queued.peek().length,
        paused: paused.peek(),
        limit,
      },
      parts: [],
      actions: [
        { name: "add", description: "Add or deduplicate a notification.", sideEffects: "write" },
        { name: "update", description: "Update an existing notification.", sideEffects: "write" },
        { name: "close", description: "Dismiss one notification.", sideEffects: "write", reasons: ["programmatic", "timeout", "action", "escape-key", "swipe"] },
        { name: "dismissAll", description: "Dismiss every notification.", sideEffects: "write" },
        { name: "promise", description: "Track asynchronous work in one stable notification.", sideEffects: "write" },
      ],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const toast of records.values()) {
        clearTimer(toast, false);
        if (toast.exitTimer !== undefined) clock.clearTimeout(toast.exitTimer);
      }
      records.clear();
      order.length = 0;
      pauseReasons.clear();
      pauseVersion.value++;
      publish();
      visible.dispose();
      queued.dispose();
      paused.dispose();
    },
  };
  Object.defineProperty(manager, "__setSwipe", {
    enumerable: false,
    value(toastId: string, x: number, y: number, direction?: ToastSwipeDirection) {
      const toast = records.get(toastId);
      if (!toast || toast.state === "ending") return;
      toast.swipeX = x;
      toast.swipeY = y;
      toast.swipeDirection = direction;
      publish();
    },
  });
  return manager;
}

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

interface ToastSwipe {
  id: string;
  pointerId: number;
  startedAt: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastAt: number;
  target: Element & { setPointerCapture?(pointerId: number): void; releasePointerCapture?(pointerId: number): void };
}

/** DOM part props and keyboard/focus coordination for a ToastManager. */
export function createToastProvider(options: ToastProviderOptions = {}): ToastProviderController {
  const id = requireId(options.id ?? options.manager?.id ?? "toast-provider", "ToastProvider");
  const ownsManager = !options.manager;
  const manager = options.manager ?? createToastManager({
    id: `${id}-manager`,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.duration === undefined ? {} : { duration: options.duration }),
    ...(options.exitDuration === undefined ? {} : { exitDuration: options.exitDuration }),
  });
  const label = options.label?.trim() || "Notifications";
  const swipeDirection = swipeDirectionValue(options.swipeDirection ?? "right");
  const swipeThreshold = finiteNonNegative(options.swipeThreshold ?? 50, "ToastProvider swipeThreshold");
  const swipeVelocity = finiteNonNegative(options.swipeVelocity ?? 0.5, "ToastProvider swipeVelocity");
  const gap = finiteNonNegative(options.gap ?? 8, "ToastProvider gap");
  const roots = new Map<string, HTMLElement>();
  const titlePresences = new Map<string, ReturnType<typeof createToastPartPresence>>();
  const descriptionPresences = new Map<string, ReturnType<typeof createToastPartPresence>>();
  const heights = new Map<string, number>();
  const layoutVersion = signal(0, { name: `${id}.layoutVersion` });
  let viewportElement: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let providerCleanup: Cleanup | undefined;
  let swipe: ToastSwipe | null = null;
  let disposed = false;

  const record = (toastId: string): ToastRecord | undefined => manager.toasts.value.find((toast) => toast.id === toastId);
  const requireToast = (toastId: string): ToastRecord => {
    const toast = record(toastId);
    if (!toast) throw new RangeError(`Unknown toast: ${toastId}`);
    return toast;
  };
  const visibleIndex = (toastId: string) => record(toastId)?.visibleIndex ?? -1;
  const stackOffset = (toastId: string) => {
    const index = visibleIndex(toastId);
    if (index < 0) return 0;
    const list = manager.visible.peek();
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor++) offset += (heights.get(list[cursor]!.id) ?? 0) + gap;
    return offset;
  };

  const focusedToast = (document: Document): string | undefined => {
    const active = document.activeElement;
    if (!active) return undefined;
    for (const [toastId, root] of roots) {
      if (active === root || root.contains?.(active)) return toastId;
    }
    return undefined;
  };

  const focusNotifications = (event: KeyboardEvent, document: Document): void => {
    const candidates = manager.visible.peek().filter((toast) => toast.state !== "ending");
    const target = [...candidates].reverse().map((toast) => roots.get(toast.id)).find(Boolean);
    // F6 is a global browser/application shortcut. Leave it untouched when
    // there is no rendered notification to receive focus.
    if (!target) return;
    const current = document.activeElement as HTMLElement | null;
    const currentToast = focusedToast(document);
    if (!currentToast && current && typeof current.focus === "function") previousFocus = current;
    event.preventDefault?.();
    target.focus?.({ preventScroll: true });
  };

  const focusAfterDismissal = (toastId: string, document: Document): void => {
    const next = [...manager.visible.peek()]
      .reverse()
      .find((toast) => toast.id !== toastId && toast.state !== "ending" && roots.has(toast.id));
    const nextRoot = next ? roots.get(next.id) : undefined;
    if (nextRoot && nextRoot.isConnected !== false) {
      nextRoot.focus?.({ preventScroll: true });
      return;
    }
    const target = previousFocus;
    previousFocus = null;
    if (target && target.isConnected !== false && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  };

  const dismissFromKeyboard = (toastId: string, event: KeyboardEvent, document: Document): void => {
    event.preventDefault?.();
    manager.close(toastId, "escape-key");
    focusAfterDismissal(toastId, document);
  };

  const restorePreviousFocus = (event: KeyboardEvent): boolean => {
    if (!event.shiftKey || event.key !== "Tab" || !previousFocus) return false;
    const target = previousFocus;
    previousFocus = null;
    if (target.isConnected === false || typeof target.focus !== "function") return false;
    event.preventDefault?.();
    target.focus({ preventScroll: true });
    return true;
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const document = event.currentTarget as Document;
    if (event.key === "F6" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      focusNotifications(event, document);
      return;
    }
    const toastId = focusedToast(document);
    if (!toastId) return;
    if (event.key === "Escape") {
      dismissFromKeyboard(toastId, event, document);
      return;
    }
    restorePreviousFocus(event);
  };

  const bindProvider = (element: Element): Cleanup => {
    if (disposed) return () => {};
    providerCleanup?.();
    const document = element.ownerDocument;
    const view = document?.defaultView;
    const onBlur = () => manager.pause("window-blur");
    const onFocus = () => manager.resume("window-blur");
    const onVisibility = () => document.hidden ? manager.pause("document-hidden") : manager.resume("document-hidden");
    document?.addEventListener?.("keydown", onDocumentKeyDown, true);
    document?.addEventListener?.("visibilitychange", onVisibility);
    view?.addEventListener?.("blur", onBlur);
    view?.addEventListener?.("focus", onFocus);
    providerCleanup = () => {
      document?.removeEventListener?.("keydown", onDocumentKeyDown, true);
      document?.removeEventListener?.("visibilitychange", onVisibility);
      view?.removeEventListener?.("blur", onBlur);
      view?.removeEventListener?.("focus", onFocus);
      manager.resume("window-blur");
      manager.resume("document-hidden");
      providerCleanup = undefined;
    };
    return providerCleanup;
  };

  const updateSwipe = (toastId: string, x: number, y: number, direction?: ToastSwipeDirection): void => {
    const internal = manager.get(toastId);
    if (!internal) return;
    // The manager owns immutable snapshots, so the swipe values are updated through metadata-free patches below.
    const source = manager as ToastManager & { __setSwipe?: (id: string, x: number, y: number, direction?: ToastSwipeDirection) => void };
    source.__setSwipe?.(toastId, x, y, direction);
  };

  // Keep swipe state private to the provider while exposing it through root props.
  const swipeOffsets = new Map<string, { x: number; y: number; direction?: ToastSwipeDirection }>();
  const setSwipeOffset = (toastId: string, x: number, y: number, direction?: ToastSwipeDirection) => {
    swipeOffsets.set(toastId, { x, y, ...(direction ? { direction } : {}) });
    updateSwipe(toastId, x, y, direction);
  };

  const beginSwipe = (toastId: string, event: PointerEvent): void => {
    if (event.defaultPrevented || event.button > 0 || !record(toastId) || toastSwipeIgnored(event)) return;
    clearSwipe();
    const target = event.currentTarget as ToastSwipe["target"];
    const now = performanceNow(target.ownerDocument);
    swipe = {
      id: toastId,
      pointerId: event.pointerId,
      startedAt: now,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: now,
      target,
    };
    try { target.setPointerCapture?.(event.pointerId); } catch { /* Pointer handlers remain usable without capture. */ }
    manager.pause(`swipe:${toastId}`);
  };

  const moveSwipe = (toastId: string, event: PointerEvent): void => {
    if (event.defaultPrevented || !swipe || swipe.id !== toastId || swipe.pointerId !== event.pointerId) return;
    const primary = swipeDirection === "left" || swipeDirection === "right"
      ? event.clientX - swipe.startX
      : event.clientY - swipe.startY;
    const allowed = swipeDirection === "left" || swipeDirection === "up" ? Math.min(0, primary) : Math.max(0, primary);
    const x = swipeDirection === "left" || swipeDirection === "right" ? allowed : 0;
    const y = swipeDirection === "up" || swipeDirection === "down" ? allowed : 0;
    swipe.lastX = event.clientX;
    swipe.lastY = event.clientY;
    swipe.lastAt = performanceNow(swipe.target.ownerDocument);
    setSwipeOffset(toastId, x, y, swipeDirection);
    if (allowed !== 0) event.preventDefault?.();
  };

  const endSwipe = (toastId: string, event: PointerEvent): void => {
    if (!swipe || swipe.id !== toastId || swipe.pointerId !== event.pointerId) return;
    if (event.defaultPrevented) {
      cancelSwipe(toastId);
      return;
    }
    const state = swipe;
    const offsets = swipeOffsets.get(toastId) ?? { x: 0, y: 0 };
    const distance = swipeDirection === "left" || swipeDirection === "right" ? Math.abs(offsets.x) : Math.abs(offsets.y);
    const elapsed = Math.max(1, state.lastAt - state.startedAt);
    const velocity = distance / elapsed;
    try { state.target.releasePointerCapture?.(state.pointerId); } catch { /* Capture may already have ended. */ }
    swipe = null;
    manager.resume(`swipe:${toastId}`);
    if (distance >= swipeThreshold || velocity >= swipeVelocity) {
      manager.close(toastId, "swipe");
    } else {
      setSwipeOffset(toastId, 0, 0);
    }
  };

  const clearSwipe = (): void => {
    if (!swipe) return;
    const toastId = swipe.id;
    try { swipe.target.releasePointerCapture?.(swipe.pointerId); } catch { /* Capture may already have ended. */ }
    swipe = null;
    manager.resume(`swipe:${toastId}`);
    setSwipeOffset(toastId, 0, 0);
  };

  const cancelSwipe = (toastId: string): void => {
    if (!swipe || swipe.id !== toastId) return;
    const state = swipe;
    swipe = null;
    try { state.target.releasePointerCapture?.(state.pointerId); } catch { /* Capture may already have ended. */ }
    manager.resume(`swipe:${toastId}`);
    setSwipeOffset(toastId, 0, 0);
  };

  const bindRoot = (toastId: string, element: Element): Cleanup => {
    const html = element as HTMLElement;
    roots.set(toastId, html);
    const measure = () => {
      const next = positiveNumber(html.offsetHeight) || rectSize(html, "height");
      if (heights.get(toastId) !== next) {
        heights.set(toastId, next);
        layoutVersion.value++;
      }
    };
    measure();
    const view = html.ownerDocument?.defaultView;
    const Observer = view?.ResizeObserver;
    let observer: ResizeObserver | undefined;
    try {
      if (Observer) {
        observer = new Observer(measure);
        observer.observe(html);
      }
    } catch { observer = undefined; }
    return () => {
      const document = html.ownerDocument;
      const active = document?.activeElement;
      if (active && (active === html || html.contains?.(active))) focusAfterDismissal(toastId, document);
      if (swipe?.id === toastId && swipe.target === html) cancelSwipe(toastId);
      observer?.disconnect();
      if (roots.get(toastId) === html) roots.delete(toastId);
      if (heights.delete(toastId)) layoutVersion.value++;
      swipeOffsets.delete(toastId);
      titlePresences.delete(toastId);
      descriptionPresences.delete(toastId);
    };
  };

  const controller: ToastProviderController = {
    id,
    manager,
    provider: () => ({
      id,
      "data-clank-part": "provider",
      "data-toast-provider": "",
      "data-paused": () => manager.paused.value ? "" : undefined,
      use: bindProvider,
    }),
    portal: () => ({
      id: `${id}-portal`,
      "data-clank-part": "portal",
      "data-toast-portal": "",
    }),
    viewport: () => ({
      id: `${id}-viewport`,
      role: "region",
      "data-clank-part": "viewport",
      "aria-label": label,
      tabIndex: -1,
      "data-paused": () => manager.paused.value ? "" : undefined,
      "data-count": () => manager.visible.value.length,
      onPointerEnter: () => manager.pause("hover"),
      onPointerLeave: () => manager.resume("hover"),
      onFocusIn: () => manager.pause("focus"),
      onFocusOut: (event: FocusEvent) => {
        const current = event.currentTarget as Node & { contains?(target: Node | null): boolean };
        if (event.relatedTarget && current.contains?.(event.relatedTarget as Node)) return;
        manager.resume("focus");
      },
      onKeyDown: (event: KeyboardEvent) => restorePreviousFocus(event),
      use: (element: Element): Cleanup => {
        viewportElement = element as HTMLElement;
        return () => { if (viewportElement === element) viewportElement = null; };
      },
    }),
    positioner: (toastId) => {
      requireToast(toastId);
      return {
        id: `${id}-${toastId}-positioner`,
        "data-clank-part": "positioner",
        "data-state": () => record(toastId)?.state,
        "data-anchor": () => record(toastId)?.anchor?.id,
        "data-side": () => record(toastId)?.anchor?.side,
        "data-align": () => record(toastId)?.anchor?.align,
        style: () => {
          layoutVersion.value;
          const current = record(toastId);
          const index = current?.visibleIndex ?? -1;
          const height = heights.get(toastId) ?? 0;
          const offset = stackOffset(toastId);
          return {
            "--clank-toast-index": index,
            "--clank-toast-height": px(height),
            "--clank-toast-offset": px(offset),
            "--toast-index": index,
            "--toast-height": px(height),
            "--toast-offset-y": px(offset),
            ...(current?.anchor?.x === undefined ? {} : { "--clank-toast-anchor-x": px(current.anchor.x) }),
            ...(current?.anchor?.y === undefined ? {} : { "--clank-toast-anchor-y": px(current.anchor.y) }),
          };
        },
      };
    },
    root: (toastId) => {
      requireToast(toastId);
      return {
        id: `${id}-${toastId}-root`,
        "data-clank-part": "root",
        role: () => record(toastId)?.priority === "assertive" ? "alert" : "status",
        "aria-live": () => record(toastId)?.priority ?? "polite",
        "aria-atomic": true,
        "aria-labelledby": () => record(toastId)?.title !== undefined && titlePresences.get(toastId)?.present.value
          ? `${id}-${toastId}-title`
          : undefined,
        "aria-describedby": () => record(toastId)?.description !== undefined && descriptionPresences.get(toastId)?.present.value
          ? `${id}-${toastId}-description`
          : undefined,
        tabIndex: -1,
        "data-state": () => record(toastId)?.state,
        "data-starting-style": () => record(toastId)?.state === "starting" ? "" : undefined,
        "data-ending-style": () => record(toastId)?.state === "ending" ? "" : undefined,
        "data-paused": () => manager.paused.value ? "" : undefined,
        "data-swiping": () => swipe?.id === toastId ? "" : undefined,
        "data-swipe-direction": () => swipeOffsets.get(toastId)?.direction,
        style: () => {
          const offset = swipeOffsets.get(toastId) ?? { x: 0, y: 0 };
          return {
            touchAction: swipeDirection === "left" || swipeDirection === "right" ? "pan-y" : "pan-x",
            userSelect: "none",
            "--clank-toast-swipe-x": px(offset.x),
            "--clank-toast-swipe-y": px(offset.y),
            "--toast-swipe-movement-x": px(offset.x),
            "--toast-swipe-movement-y": px(offset.y),
          };
        },
        onPointerDown: (event: PointerEvent) => beginSwipe(toastId, event),
        onPointerMove: (event: PointerEvent) => moveSwipe(toastId, event),
        onPointerUp: (event: PointerEvent) => endSwipe(toastId, event),
        onPointerCancel: (event: PointerEvent) => {
          if (swipe?.id === toastId && swipe.pointerId === event.pointerId) cancelSwipe(toastId);
        },
        onLostPointerCapture: (event: PointerEvent) => {
          if (swipe?.id === toastId && swipe.pointerId === event.pointerId) cancelSwipe(toastId);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.defaultPrevented) return;
          if (event.key === "Escape") {
            const document = (event.currentTarget as Element | null)?.ownerDocument ?? roots.get(toastId)?.ownerDocument;
            if (document) dismissFromKeyboard(toastId, event, document);
            else manager.close(toastId, "escape-key");
          } else restorePreviousFocus(event);
        },
        use: (element: Element) => bindRoot(toastId, element),
      };
    },
    content: (toastId) => {
      requireToast(toastId);
      return { id: `${id}-${toastId}-content`, "data-clank-part": "content", "data-toast-content": "" };
    },
    title: (toastId) => {
      requireToast(toastId);
      const presence = toastPartPresence(titlePresences, toastId, `${id}.${toastId}.titlePresence`);
      return {
        id: `${id}-${toastId}-title`,
        "data-clank-part": "title",
        hidden: () => record(toastId)?.title === undefined,
        "data-toast-title": "",
        use: presence.register(),
      };
    },
    description: (toastId) => {
      requireToast(toastId);
      const presence = toastPartPresence(descriptionPresences, toastId, `${id}.${toastId}.descriptionPresence`);
      return {
        id: `${id}-${toastId}-description`,
        "data-clank-part": "description",
        hidden: () => record(toastId)?.description === undefined,
        "data-toast-description": "",
        use: presence.register(),
      };
    },
    action: (toastId) => {
      requireToast(toastId);
      return {
        type: "button",
        "data-clank-part": "action",
        hidden: () => record(toastId)?.action === undefined,
        "aria-label": () => record(toastId)?.action?.altText,
        "data-toast-action": "",
        onClick: (event: Event) => {
          const current = record(toastId);
          if (!current?.action || event.defaultPrevented) return;
          current.action.onPress?.(event);
          if (!event.defaultPrevented && current.action.dismiss !== false) manager.close(toastId, "action");
        },
      };
    },
    close: (toastId) => {
      requireToast(toastId);
      return {
        type: "button",
        "data-clank-part": "close",
        "aria-label": "Close notification",
        "data-toast-close": "",
        onClick: (event: Event) => {
          if (!event.defaultPrevented) manager.close(toastId, "close-button");
        },
      };
    },
    arrow: (toastId) => {
      requireToast(toastId);
      return {
        "aria-hidden": true,
        "data-clank-part": "arrow",
        hidden: () => record(toastId)?.anchor === undefined,
        "data-side": () => record(toastId)?.anchor?.side,
        "data-align": () => record(toastId)?.anchor?.align,
        "data-toast-arrow": "",
      };
    },
    manifest: (toastId) => {
      const toast = toastId === undefined ? undefined : requireToast(toastId);
      return createUiManifest({
        component: toast ? "Toast" : "ToastProvider",
        id: toast?.id ?? id,
        state: toast ? {
          state: toast.state,
          priority: toast.priority,
          paused: toast.paused,
          visibleIndex: toast.visibleIndex,
          queuedIndex: toast.queuedIndex,
          hasAction: Boolean(toast.action),
          anchor: toast.anchor ?? null,
        } : {
          visible: manager.visible.peek().length,
          queued: manager.queued.peek().length,
          paused: manager.paused.peek(),
        },
        parts: toast ? [
          { name: "positioner", defaultElement: "div", required: true },
          { name: "root", role: toast.priority === "assertive" ? "alert" : "status", defaultElement: "div", required: true },
          { name: "content", defaultElement: "div" },
          { name: "title", defaultElement: "div" },
          { name: "description", defaultElement: "div" },
          { name: "action", role: "button", defaultElement: "button" },
          { name: "close", role: "button", defaultElement: "button" },
          { name: "arrow", defaultElement: "div" },
        ] : [
          { name: "provider", defaultElement: "div", required: true },
          { name: "portal", defaultElement: "div" },
          { name: "viewport", role: "region", defaultElement: "div", required: true },
        ],
        actions: toast ? [
          { name: "close", description: "Dismiss this notification.", sideEffects: "write", reasons: ["close-button", "action", "escape-key", "swipe", "programmatic"] },
          ...(toast.action ? [{ name: "action", description: "Run the notification action.", sideEffects: "write" as const }] : []),
        ] : [
          { name: "focus", description: "Move focus into the notification viewport.", sideEffects: "none" },
        ],
        keyboard: toast ? {
          Escape: "Dismiss the focused notification.",
          "Shift + Tab": "Return focus to the element active before F6.",
        } : {
          F6: "Move focus to the newest visible notification.",
        },
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSwipe();
      providerCleanup?.();
      roots.clear();
      heights.clear();
      titlePresences.clear();
      descriptionPresences.clear();
      viewportElement = null;
      previousFocus = null;
      if (ownsManager) manager.dispose();
    },
  };
  return controller;
}

function createToastPartPresence(name: string): {
  present: Computed<boolean>;
  register(): (element?: Element) => Cleanup;
} {
  const registrations = signal(0, { name });
  const present = computed(() => registrations.value > 0, { name: `${name}.present` });
  return {
    present,
    register() {
      registrations.value = registrations.peek() + 1;
      let reservationAvailable = true;
      return () => {
        if (reservationAvailable) reservationAvailable = false;
        else registrations.value = registrations.peek() + 1;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          registrations.value = Math.max(0, registrations.peek() - 1);
        };
      };
    },
  };
}

function toastPartPresence(
  collection: Map<string, ReturnType<typeof createToastPartPresence>>,
  toastId: string,
  name: string,
): ReturnType<typeof createToastPartPresence> {
  let presence = collection.get(toastId);
  if (!presence) {
    presence = createToastPartPresence(name);
    collection.set(toastId, presence);
  }
  return presence;
}

function readLogicalScrollLeft(
  viewport: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number },
  direction: Direction,
  behavior: RtlScrollBehavior,
): number {
  const raw = Number(viewport.scrollLeft) || 0;
  if (direction === "ltr") return raw;
  const max = Math.max(0, positiveNumber(viewport.scrollWidth) - positiveNumber(viewport.clientWidth));
  if (behavior === "negative") return -raw;
  if (behavior === "positive-descending") return max - raw;
  return raw;
}

function writeLogicalScrollLeft(
  logical: number,
  max: number,
  direction: Direction,
  behavior: RtlScrollBehavior,
): number {
  if (direction === "ltr") return logical;
  if (behavior === "negative") return -logical;
  if (behavior === "positive-descending") return max - logical;
  return logical;
}

function rtlBehavior(viewport: HTMLElement, options: ScrollAreaOptions): RtlScrollBehavior {
  if (options.rtlScrollBehavior) return options.rtlScrollBehavior;
  const document = viewport.ownerDocument;
  if (!document) return "negative";
  const cached = rtlBehaviorCache.get(document);
  if (cached) return cached;
  const detected = detectRtlScrollBehavior(document);
  rtlBehaviorCache.set(document, detected);
  return detected;
}

function detectRtlScrollBehavior(document: Document): RtlScrollBehavior {
  const body = document.body;
  if (!body || typeof document.createElement !== "function") return "negative";
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  outer.dir = "rtl";
  outer.style.width = "4px";
  outer.style.height = "1px";
  outer.style.overflow = "scroll";
  outer.style.position = "absolute";
  outer.style.top = "-9999px";
  inner.style.width = "8px";
  inner.style.height = "1px";
  outer.append(inner);
  body.append(outer);
  let behavior: RtlScrollBehavior;
  if (outer.scrollLeft > 0) behavior = "positive-descending";
  else {
    outer.scrollLeft = 1;
    behavior = outer.scrollLeft === 0 ? "negative" : "positive-ascending";
  }
  outer.remove();
  return behavior;
}

const systemToastClock: ToastClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  queueMicrotask: (callback) => queueMicrotask(callback),
};

function scheduleMicrotask(clock: ToastClock, callback: () => void): void {
  if (clock.queueMicrotask) clock.queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function toastMessage<Value>(message: ToastMessage<Value> | string | ToastUpdate, value: Value): ToastUpdate {
  const resolved = typeof message === "function" ? message(value) : message;
  return typeof resolved === "string" ? { title: resolved } : resolved;
}

function validateToastContent(input: ToastInput | ToastUpdate, partial = false): void {
  if (!input || typeof input !== "object") throw new TypeError("A toast input is required.");
  if (!partial && input.title === undefined && input.description === undefined) {
    throw new TypeError("A toast requires a title or description.");
  }
}

function priorityValue(value: ToastPriority | undefined): ToastPriority {
  if (value === undefined) return "polite";
  if (value !== "polite" && value !== "assertive") throw new TypeError("Toast priority must be polite or assertive.");
  return value;
}

function actionValue(value: ToastAction): ToastAction {
  if (!value || typeof value !== "object") throw new TypeError("Toast action must be an object.");
  const label = textValue(value.label, "Toast action label");
  return {
    label,
    ...(value.altText === undefined ? {} : { altText: textValue(value.altText, "Toast action altText") }),
    ...(value.dismiss === undefined ? {} : { dismiss: Boolean(value.dismiss) }),
    ...(value.onPress === undefined ? {} : { onPress: value.onPress }),
  };
}

function anchorValue(value: ToastAnchorMetadata): ToastAnchorMetadata {
  if (!value || typeof value !== "object") throw new TypeError("Toast anchor must be an object.");
  if (value.side !== undefined && !["top", "right", "bottom", "left"].includes(value.side)) {
    throw new TypeError("Invalid toast anchor side.");
  }
  if (value.align !== undefined && !["start", "center", "end"].includes(value.align)) {
    throw new TypeError("Invalid toast anchor alignment.");
  }
  return Object.freeze({
    ...(value.id === undefined ? {} : { id: textValue(value.id, "Toast anchor id") }),
    ...(value.side === undefined ? {} : { side: value.side }),
    ...(value.align === undefined ? {} : { align: value.align }),
    ...(value.x === undefined ? {} : { x: finiteNumber(value.x, "Toast anchor x") }),
    ...(value.y === undefined ? {} : { y: finiteNumber(value.y, "Toast anchor y") }),
  });
}

function metadataValue(value: Readonly<Record<string, string | number | boolean | null>>): Readonly<Record<string, string | number | boolean | null>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Toast metadata must be an object.");
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new TypeError(`Toast metadata ${key} must be JSON scalar data.`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new TypeError(`Toast metadata ${key} must be a finite number.`);
    }
    output[key] = entry;
  }
  return Object.freeze(output);
}

function swipeDirectionValue(value: ToastSwipeDirection): ToastSwipeDirection {
  if (value !== "left" && value !== "right" && value !== "up" && value !== "down") {
    throw new TypeError("Toast swipeDirection must be left, right, up, or down.");
  }
  return value;
}

const toastSwipeIgnoreSelector = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "details",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='textbox']",
  "[data-base-ui-swipe-ignore]",
  "[data-swipe-ignore]",
].join(",");

function toastSwipeIgnored(event: PointerEvent): boolean {
  const root = event.currentTarget as EventTarget | null;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.length > 0) {
    for (const node of path) {
      if (node === root) break;
      if (matchesSelector(node, toastSwipeIgnoreSelector)) return true;
    }
    return false;
  }
  const target = event.target as Element | null;
  const closest = target && typeof target.closest === "function"
    ? target.closest(toastSwipeIgnoreSelector)
    : null;
  if (!closest || closest === root) return false;
  return typeof (root as Element | null)?.contains !== "function"
    || (root as Element).contains(closest);
}

function matchesSelector(value: unknown, selector: string): boolean {
  return Boolean(value && typeof (value as Element).matches === "function" && (value as Element).matches(selector));
}

function performanceNow(document: Document | null | undefined): number {
  return document?.defaultView?.performance?.now?.() ?? Date.now();
}

function textValue(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function durationValue(value: number, name: string): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  return finiteNonNegative(value, name);
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number.`);
  return value;
}

function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function requireId(value: string, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${kind} id must be a non-empty string.`);
  return value.trim();
}

function requireOrientation(value: Orientation): void {
  if (value !== "horizontal" && value !== "vertical") throw new TypeError("Orientation must be horizontal or vertical.");
}

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function rectSize(element: Element | null | undefined, dimension: "width" | "height"): number {
  try { return positiveNumber(element?.getBoundingClientRect?.()[dimension]); } catch { return 0; }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function px(value: number): string {
  return `${Number.isFinite(value) ? value : 0}px`;
}
