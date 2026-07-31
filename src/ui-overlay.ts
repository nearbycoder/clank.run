import { computed, effect, signal, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";
import {
  containsEventTarget,
  focusableElements as foundationFocusableElements,
  isFocusable as foundationIsFocusable,
} from "./ui-foundation.ts";

export type OverlayDismissReason = "escape-key" | "outside-press" | "focus-out" | "backdrop-press" | "programmatic";
export type OverlayModality = boolean | "trap-focus";
export type FocusTarget = HTMLElement | null | (() => HTMLElement | null);
export type AutoFocusPolicy = boolean | (() => boolean);

export interface OverlayOptions {
  open: boolean | ReactiveSignal<boolean> | Computed<boolean> | (() => boolean);
  onDismiss(reason: OverlayDismissReason, event?: Event): void;
  modal?: OverlayModality;
  closeOnEscape?: boolean;
  closeOnOutsidePress?: boolean;
  closeOnFocusOutside?: boolean;
  restoreFocus?: boolean | ((reason?: OverlayDismissReason) => boolean);
  /** Set to false when the trigger intentionally retains focus (for example, a combobox input). */
  autoFocus?: AutoFocusPolicy;
  initialFocus?: FocusTarget | false;
  finalFocus?: FocusTarget;
  trigger?: FocusTarget;
  lockScroll?: boolean;
}

export interface OverlayController {
  readonly active: Computed<boolean>;
  readonly topmost: ReactiveSignal<boolean>;
  content(options?: { role?: string; tabIndex?: number | false }): Record<string, unknown>;
  backdrop(options?: { dismiss?: boolean }): Record<string, unknown>;
  /**
   * Registers a detached subtree as part of this overlay. Interaction-only branches count for
   * outside-event ownership without joining the modal inert or focus boundary (for example,
   * popup triggers).
   */
  branch(element: Element, options?: { interactionOnly?: boolean }): Cleanup;
  /** Declarative `use` props for a portaled or otherwise detached overlay subtree. */
  branchProps(): Record<string, unknown>;
  dismiss(reason?: OverlayDismissReason, event?: Event): void;
  dispose(): void;
}

interface LayerRecord {
  readonly key: symbol;
  readonly element: HTMLElement;
  readonly branches: Set<Element>;
  readonly modalBranches: Set<Element>;
  readonly options: OverlayOptions;
  readonly controller: OverlayController;
  previousFocus: HTMLElement | null;
  dismissReason?: OverlayDismissReason;
  ancestorBranchCleanups?: Cleanup[];
  inertCleanup?: Cleanup;
  scrollCleanup?: Cleanup;
}

interface DocumentLayers {
  readonly document: Document;
  readonly layers: LayerRecord[];
  cleanup?: Cleanup;
}

const documentLayers = new WeakMap<Document, DocumentLayers>();

/**
 * Shared, document-scoped dismissal and focus behavior for dialogs, menus, popovers, selects,
 * drawers, and tooltips. Only the top layer reacts to Escape or outside interaction.
 */
export function createOverlay(options: OverlayOptions): OverlayController {
  const active = computed(() => readBoolean(options.open), { name: "ui.overlay.active" });
  const topmost = signal(false, { name: "ui.overlay.topmost" });
  const branches = new Set<Element>();
  const modalBranches = new Set<Element>();
  const branchReferences = new Map<Element, number>();
  const modalBranchReferences = new Map<Element, number>();
  const mounts = new Set<Cleanup>();
  let record: LayerRecord | undefined;
  let disposed = false;

  const dismiss = (reason: OverlayDismissReason = "programmatic", event?: Event) => {
    if (!active.peek() || event?.defaultPrevented) return;
    // The close request is cancelable in the controller that owns `open`.
    // Keep the reason available for a synchronous accepted close, but roll it
    // back when the overlay remains active so it cannot poison a later,
    // unrelated focus-restoration decision.
    const dismissalRecord = record;
    const previousReason = dismissalRecord?.dismissReason;
    if (dismissalRecord) dismissalRecord.dismissReason = reason;
    try {
      options.onDismiss(reason, event);
    } finally {
      if (dismissalRecord && active.peek()) dismissalRecord.dismissReason = previousReason;
    }
  };

  const controller: OverlayController = {
    active,
    topmost,
    dismiss,
    content(contentOptions = {}) {
      return {
        ...(contentOptions.role ? { role: contentOptions.role } : {}),
        ...(contentOptions.tabIndex === false ? {} : { tabIndex: contentOptions.tabIndex ?? -1 }),
        "data-open": () => active.value ? "" : undefined,
        "data-closed": () => active.value ? undefined : "",
        "data-top-layer": () => topmost.value ? "" : undefined,
        use: (element: Element): Cleanup => {
          if (disposed) throw new Error("Overlay has been disposed.");
          const HTMLElementClass = element.ownerDocument.defaultView?.HTMLElement ?? globalThis.HTMLElement;
          if (HTMLElementClass && !(element instanceof HTMLElementClass)) {
            throw new TypeError("Overlay content must be an HTMLElement.");
          }
          const html = element as HTMLElement;
          const stop = effect(() => {
            if (active.value) {
              if (!record) {
                record = {
                  key: Symbol("clank.overlay"),
                  element: html,
                  branches,
                  modalBranches,
                  options,
                  controller,
                  previousFocus: deepActiveElement(html.ownerDocument),
                };
                activateLayer(record);
              }
            } else if (record) {
              deactivateLayer(record);
              record = undefined;
            }
          });
          let mounted = true;
          const cleanup = () => {
            if (!mounted) return;
            mounted = false;
            stop();
            if (record) {
              deactivateLayer(record);
              record = undefined;
            }
            mounts.delete(cleanup);
          };
          mounts.add(cleanup);
          return cleanup;
        },
      };
    },
    backdrop(backdropOptions = {}) {
      return {
        "aria-hidden": true,
        "data-open": () => active.value ? "" : undefined,
        "data-closed": () => active.value ? undefined : "",
        use: (element: Element): Cleanup => controller.branch(element),
        onPointerDown: (event: PointerEvent) => {
          if (event.target !== event.currentTarget || backdropOptions.dismiss === false) return;
          dismiss("backdrop-press", event);
        },
      };
    },
    branch(element, branchOptions = {}) {
      if (disposed) throw new Error("Overlay has been disposed.");
      branchReferences.set(element, (branchReferences.get(element) ?? 0) + 1);
      branches.add(element);
      const participatesInModalBoundary = branchOptions.interactionOnly !== true;
      if (participatesInModalBoundary) {
        modalBranchReferences.set(element, (modalBranchReferences.get(element) ?? 0) + 1);
        modalBranches.add(element);
        refreshInertLayer(record);
      }
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const references = (branchReferences.get(element) ?? 1) - 1;
        if (references > 0) branchReferences.set(element, references);
        else {
          branchReferences.delete(element);
          branches.delete(element);
        }
        if (participatesInModalBoundary) {
          const modalReferences = (modalBranchReferences.get(element) ?? 1) - 1;
          if (modalReferences > 0) modalBranchReferences.set(element, modalReferences);
          else {
            modalBranchReferences.delete(element);
            modalBranches.delete(element);
          }
          refreshInertLayer(record);
        }
      };
    },
    branchProps() {
      return {
        "data-clank-overlay-branch": "",
        use: (element: Element): Cleanup => controller.branch(element),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...mounts]) cleanup();
      branchReferences.clear();
      modalBranchReferences.clear();
      branches.clear();
      modalBranches.clear();
    },
  };
  return controller;
}

function layersFor(document: Document): DocumentLayers {
  let manager = documentLayers.get(document);
  if (manager) return manager;
  manager = { document, layers: [] };
  documentLayers.set(document, manager);
  return manager;
}

function activateLayer(record: LayerRecord): void {
  const manager = layersFor(record.element.ownerDocument);
  // A newly opened top layer is a logical child of every layer already in the
  // document stack even when its DOM is mounted through a portal. Registering
  // it as a branch keeps parent modal inerting and outside-press detection from
  // treating the child as unrelated content. The child's own modal boundary
  // can still inert its parents, so nested dialogs retain normal stack order.
  record.ancestorBranchCleanups = manager.layers.map((ancestor) =>
    ancestor.controller.branch(record.element)
  );
  manager.layers.push(record);
  if (!manager.cleanup) manager.cleanup = listenForLayerEvents(manager);
  if (record.options.modal === true) record.inertCleanup = inertOutside(record);
  if (record.options.lockScroll !== false && record.options.modal === true) {
    record.scrollCleanup = lockDocumentScroll(manager.document);
  }
  updateTopLayers(manager);
  queueMicrotask(() => {
    if (!manager.layers.includes(record)) return;
    if (!readAutoFocus(record.options.autoFocus)) return;
    const target = resolveFocusTarget(record.options.initialFocus)
      ?? focusableElements(record.element)[0]
      ?? record.element;
    focusElement(target);
  });
}

function deactivateLayer(record: LayerRecord): void {
  const manager = layersFor(record.element.ownerDocument);
  const index = manager.layers.indexOf(record);
  if (index === -1) return;
  const wasTopmost = index === manager.layers.length - 1;
  manager.layers.splice(index, 1);
  record.inertCleanup?.();
  record.scrollCleanup?.();
  for (const cleanup of record.ancestorBranchCleanups?.reverse() ?? []) cleanup();
  record.ancestorBranchCleanups = undefined;
  record.inertCleanup = undefined;
  record.scrollCleanup = undefined;
  record.controller.topmost.value = false;
  updateTopLayers(manager);
  if (manager.layers.length === 0) {
    manager.cleanup?.();
    manager.cleanup = undefined;
    documentLayers.delete(manager.document);
  }
  const shouldRestoreFocus = readRestoreFocus(record.options.restoreFocus, record.dismissReason)
    && record.dismissReason !== "outside-press"
    && record.dismissReason !== "focus-out";
  if (wasTopmost && shouldRestoreFocus) queueMicrotask(() => {
    const target = resolveFocusTarget(record.options.finalFocus)
      ?? resolveFocusTarget(record.options.trigger)
      ?? record.previousFocus;
    if (target?.isConnected && !isDisabled(target)) focusElement(target);
  });
}

function updateTopLayers(manager: DocumentLayers): void {
  const top = manager.layers.at(-1);
  for (const layer of manager.layers) layer.controller.topmost.value = layer === top;
}

function refreshInertLayer(record?: LayerRecord): void {
  if (!record || record.options.modal !== true) return;
  record.inertCleanup?.();
  record.inertCleanup = inertOutside(record);
}

function listenForLayerEvents(manager: DocumentLayers): Cleanup {
  const onKeyDown = (event: KeyboardEvent) => {
    const layer = manager.layers.at(-1);
    if (!layer) return;
    if (event.key === "Escape" && layer.options.closeOnEscape !== false) {
      layer.controller.dismiss("escape-key", event);
      event.preventDefault();
      return;
    }
    if (event.key === "Tab" && (layer.options.modal === true || layer.options.modal === "trap-focus")) {
      trapTab(layer, event);
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    const layer = manager.layers.at(-1);
    if (!layer || layer.options.closeOnOutsidePress === false) return;
    if (eventInsideLayer(event, layer, true)) return;
    layer.controller.dismiss("outside-press", event);
  };
  const onFocusIn = (event: FocusEvent) => {
    const layer = manager.layers.at(-1);
    if (!layer || eventInsideLayer(event, layer, layer.options.modal === false || layer.options.modal === undefined)) return;
    if (layer.options.modal === true || layer.options.modal === "trap-focus") {
      const target = focusableElements(layer.element)[0] ?? layer.element;
      focusElement(target);
      return;
    }
    if (layer.options.closeOnFocusOutside) layer.controller.dismiss("focus-out", event);
  };
  manager.document.addEventListener("keydown", onKeyDown, true);
  manager.document.addEventListener("pointerdown", onPointerDown, true);
  manager.document.addEventListener("focusin", onFocusIn, true);
  return () => {
    manager.document.removeEventListener("keydown", onKeyDown, true);
    manager.document.removeEventListener("pointerdown", onPointerDown, true);
    manager.document.removeEventListener("focusin", onFocusIn, true);
  };
}

function eventInsideLayer(event: Event, layer: LayerRecord, includeTrigger: boolean): boolean {
  const trigger = includeTrigger ? resolveFocusTarget(layer.options.trigger) : null;
  const branches = includeTrigger ? layer.branches : layer.modalBranches;
  return containsEventTarget(layer.element, event)
    || containsEventTarget(trigger, event)
    || [...branches].some((branch) => containsEventTarget(branch, event));
}

function trapTab(layer: LayerRecord, event: KeyboardEvent): void {
  const roots = [layer.element, ...layer.modalBranches].filter(isHTMLElement);
  const items = uniqueElements(roots.flatMap((root) => [
    ...(isFocusable(root) ? [root] : []),
    ...focusableElements(root),
  ]));
  if (items.length === 0) {
    event.preventDefault();
    focusElement(layer.element);
    return;
  }
  const current = deepActiveElement(layer.element.ownerDocument);
  const first = items[0]!;
  const last = items.at(-1)!;
  const currentInside = current ? roots.some((root) => composedContains(root, current)) : false;
  if (event.shiftKey && (current === first || current === layer.element || !currentInside)) {
    event.preventDefault();
    focusElement(last);
  } else if (!event.shiftKey && (current === last || !currentInside)) {
    event.preventDefault();
    focusElement(first);
  }
}

function isHTMLElement(element: Element): element is HTMLElement {
  const HTMLElementClass = element.ownerDocument.defaultView?.HTMLElement ?? globalThis.HTMLElement;
  return !HTMLElementClass || element instanceof HTMLElementClass;
}

function uniqueElements(elements: readonly HTMLElement[]): HTMLElement[] {
  return [...new Set(elements)];
}

/** Follows open shadow roots so focus traps and restoration operate on the actual focus target. */
function deepActiveElement(document: Document): HTMLElement | null {
  let active: Element | null = document.activeElement;
  const seen = new Set<Element>();
  while (active && !seen.has(active)) {
    seen.add(active);
    const shadow = (active as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    const nested = shadow?.activeElement ?? null;
    if (!nested) break;
    active = nested;
  }
  return active && isHTMLElement(active) ? active : null;
}

function composedContains(container: Element, target: Element): boolean {
  if (container === target) return true;
  try {
    if (container.contains(target)) return true;
  } catch {
    // Cross-realm test doubles can reject contains(); the composed walk below remains safe.
  }
  let current: Element | null = target;
  const seen = new Set<Element>();
  while (current && !seen.has(current)) {
    if (current === container) return true;
    seen.add(current);
    current = composedParentElement(current);
  }
  return false;
}

export function focusableElements(root: HTMLElement): HTMLElement[] {
  const composed: Array<{ element: HTMLElement; order: number; tabIndex: number }> = [];
  const seen = new Set<Element>();
  let order = 0;
  const visit = (parent: Element | ShadowRoot) => {
    for (const child of Array.from(parent.children ?? [])) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (foundationIsFocusable(child)) {
        const html = child as HTMLElement;
        composed.push({ element: html, order: order++, tabIndex: elementTabIndex(html) });
      } else {
        order++;
      }
      const assigned = typeof (child as HTMLSlotElement).assignedElements === "function"
        ? (child as HTMLSlotElement).assignedElements({ flatten: true })
        : [];
      if (assigned.length > 0) {
        const assignedRoot = { children: assigned } as unknown as ShadowRoot;
        visit(assignedRoot);
        continue;
      }
      const shadow = (child as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) visit(shadow);
      else visit(child);
    }
  };
  visit(root);
  if (composed.length > 0) {
    return composed
      .sort((a, b) => {
        const aPositive = a.tabIndex > 0;
        const bPositive = b.tabIndex > 0;
        if (aPositive !== bPositive) return aPositive ? -1 : 1;
        if (aPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
        return a.order - b.order;
      })
      .map(({ element }) => element);
  }
  const standard = foundationFocusableElements(root);
  if (standard.length > 0) return standard;
  // Retain support for DOM-compatible realms/test doubles that do not expose tagName while the
  // foundation implementation remains the authoritative path for real DOM and shadow roots.
  const candidates = typeof root.querySelectorAll === "function"
    ? [...root.querySelectorAll<HTMLElement>(OVERLAY_FOCUSABLE_SELECTOR)]
    : [];
  return candidates.filter((element) => !element.tagName && legacyFocusable(element));
}

function elementTabIndex(element: HTMLElement): number {
  const raw = element.getAttribute?.("tabindex");
  if (raw !== null && raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof element.tabIndex === "number" ? element.tabIndex : 0;
}

export function isFocusable(element: HTMLElement): boolean {
  const structuralFallback = !element.tagName && legacyFocusable(element);
  return foundationIsFocusable(element) || structuralFallback;
}

const OVERLAY_FOCUSABLE_SELECTOR = [
  "a[href]", "area[href]", "button", "input:not([type=hidden])", "select", "textarea",
  "iframe", "object", "embed", "[contenteditable=true]", "[tabindex]",
].join(",");

function legacyFocusable(element: HTMLElement): boolean {
  if (isDisabled(element) || element.hidden || element.closest("[inert]") || element.closest("[hidden]")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && Number(tabIndex) < 0) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  return element.getClientRects().length > 0 || style === undefined;
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
}

function focusElement(element: HTMLElement): void {
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
}

function resolveFocusTarget(target?: FocusTarget | false): HTMLElement | null {
  if (target === false) return null;
  return typeof target === "function" ? target() : target ?? null;
}

function readAutoFocus(value?: AutoFocusPolicy): boolean {
  return typeof value === "function" ? Boolean(value()) : value !== false;
}

function readRestoreFocus(
  value: OverlayOptions["restoreFocus"],
  reason?: OverlayDismissReason,
): boolean {
  return typeof value === "function" ? Boolean(value(reason)) : value !== false;
}

function inertOutside(record: LayerRecord): Cleanup {
  const document = record.element.ownerDocument;
  const body = document.body;
  if (!body) return () => {};
  const restores = new Map<HTMLElement, Cleanup>();
  const observedRoots = new WeakSet<Node>();
  let stopped = false;

  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => reconcile()) : undefined;
  const observe = (root: Element | ShadowRoot) => {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
  };

  const reconcile = () => {
    if (stopped) return;
    const allowed = new Set<Element>([record.element, ...record.modalBranches]);
    const allowedAncestors = new Set<Element>();
    for (const element of allowed) {
      let current: Element | null = element;
      const seen = new Set<Element>();
      while (current && !seen.has(current)) {
        seen.add(current);
        allowedAncestors.add(current);
        if (current === body) break;
        current = composedParentElement(current);
      }
    }

    const shouldBeInert = new Set<HTMLElement>();
    const visit = (parent: Element | ShadowRoot) => {
      observe(parent);
      for (const child of Array.from(parent.children)) {
        if (allowed.has(child)) continue;
        if (allowedAncestors.has(child)) {
          visit(child);
          const shadow = (child as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
          if (shadow) visit(shadow);
        } else if (isHTMLElement(child)) {
          shouldBeInert.add(child);
        }
      }
    };
    visit(body);

    for (const [element, restore] of [...restores]) {
      if (shouldBeInert.has(element)) continue;
      restores.delete(element);
      restore();
    }
    for (const element of shouldBeInert) {
      if (!restores.has(element)) restores.set(element, inertElement(element));
    }
  };

  reconcile();
  return () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    for (const restore of [...restores.values()].reverse()) restore();
    restores.clear();
  };
}

function composedParentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode?.();
  const host = root && "host" in root ? (root as ShadowRoot).host : null;
  return host && typeof host === "object" && "ownerDocument" in host ? host : null;
}

interface InertState { count: number; hadInert: boolean; ariaHidden: string | null; }
const inertStates = new WeakMap<HTMLElement, InertState>();

function inertElement(element: HTMLElement): Cleanup {
  let state = inertStates.get(element);
  if (!state) {
    state = {
      count: 0,
      hadInert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    };
    inertStates.set(element, state);
  }
  state.count++;
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = inertStates.get(element);
    if (!current || --current.count > 0) return;
    if (!current.hadInert) element.removeAttribute("inert");
    if (current.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", current.ariaHidden);
    inertStates.delete(element);
  };
}

interface ScrollLockState { count: number; overflow: string; paddingRight: string; }
const scrollLocks = new WeakMap<Document, ScrollLockState>();

function lockDocumentScroll(document: Document): Cleanup {
  const body = document.body;
  if (!body) return () => {};
  let state = scrollLocks.get(document);
  if (!state) {
    state = { count: 0, overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    scrollLocks.set(document, state);
  }
  state.count++;
  if (state.count === 1) {
    const viewport = document.defaultView;
    const width = viewport ? Math.max(0, viewport.innerWidth - document.documentElement.clientWidth) : 0;
    body.style.overflow = "hidden";
    if (width > 0) body.style.paddingRight = `${width}px`;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = scrollLocks.get(document);
    if (!current || --current.count > 0) return;
    body.style.overflow = current.overflow;
    body.style.paddingRight = current.paddingRight;
    scrollLocks.delete(document);
  };
}

export type FloatingSide = "top" | "right" | "bottom" | "left";
export type FloatingAlign = "start" | "center" | "end";
export type FloatingStrategy = "fixed" | "absolute";
export interface VirtualAnchor { getBoundingClientRect(): DOMRect | DOMRectReadOnly; contextElement?: Element; }
export type FloatingAnchor = Element | VirtualAnchor | null | (() => Element | VirtualAnchor | null);

export interface FloatingOptions {
  anchor: FloatingAnchor;
  side?: FloatingSide;
  align?: FloatingAlign;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  arrowPadding?: number;
  avoidCollisions?: boolean;
  strategy?: FloatingStrategy;
  direction?: "ltr" | "rtl";
}

export interface FloatingController {
  readonly x: ReactiveSignal<number>;
  readonly y: ReactiveSignal<number>;
  readonly side: ReactiveSignal<FloatingSide>;
  readonly align: ReactiveSignal<FloatingAlign>;
  readonly arrowX: ReactiveSignal<number | null>;
  readonly arrowY: ReactiveSignal<number | null>;
  readonly availableWidth: ReactiveSignal<number>;
  readonly availableHeight: ReactiveSignal<number>;
  update(): void;
  positioner(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  dispose(): void;
}

/** Dependency-free anchored positioning with logical alignment, flip, shift, arrow, and auto-update. */
export function createFloating(options: FloatingOptions): FloatingController {
  const x = signal(0, { name: "ui.floating.x" });
  const y = signal(0, { name: "ui.floating.y" });
  const side = signal<FloatingSide>(options.side ?? "bottom", { name: "ui.floating.side" });
  const align = signal<FloatingAlign>(options.align ?? "center", { name: "ui.floating.align" });
  const arrowX = signal<number | null>(null);
  const arrowY = signal<number | null>(null);
  const availableWidth = signal(0);
  const availableHeight = signal(0);
  let floating: HTMLElement | null = null;
  let arrowElement: HTMLElement | null = null;
  const mounts = new Set<Cleanup>();
  const anchorBindings = new Set<(anchor: Element | VirtualAnchor | null, scheduleUpdate: boolean) => void>();
  let disposed = false;

  const update = () => {
    if (disposed) return;
    const anchor = resolveAnchor(options.anchor);
    for (const bindAnchor of anchorBindings) bindAnchor(anchor, false);
    if (!anchor || !floating) return;
    const document = floating.ownerDocument;
    const viewport = document.defaultView;
    if (!viewport) return;
    const anchorRect = anchor.getBoundingClientRect();
    const floatingRect = floating.getBoundingClientRect();
    const padding = finite(options.collisionPadding ?? 8, "collisionPadding");
    const offset = finite(options.sideOffset ?? 0, "sideOffset");
    const alignmentOffset = finite(options.alignOffset ?? 0, "alignOffset");
    const arrowPadding = finite(options.arrowPadding ?? 0, "arrowPadding");
    if (padding < 0) throw new RangeError("collisionPadding must not be negative.");
    if (arrowPadding < 0) throw new RangeError("arrowPadding must not be negative.");
    const bounds = collisionBounds(floating, anchor, padding);
    let placedSide = options.side ?? "bottom";
    if (options.avoidCollisions !== false) {
      const needed = placedSide === "top" || placedSide === "bottom" ? floatingRect.height + offset : floatingRect.width + offset;
      const primary = spaceFor(placedSide, anchorRect, bounds);
      const opposite = oppositeSide(placedSide);
      if (primary < needed && spaceFor(opposite, anchorRect, bounds) > primary) placedSide = opposite;
    }
    const viewportPoint = coordinates(placedSide, options.align ?? "center", anchorRect, floatingRect, offset, alignmentOffset, options.direction ?? "ltr");
    if (options.avoidCollisions !== false) {
      viewportPoint.x = clamp(viewportPoint.x, bounds.left, Math.max(bounds.left, bounds.right - floatingRect.width));
      viewportPoint.y = clamp(viewportPoint.y, bounds.top, Math.max(bounds.top, bounds.bottom - floatingRect.height));
    }
    const point = (options.strategy ?? "fixed") === "absolute"
      ? toOffsetParentCoordinates(viewportPoint, floating, viewport)
      : viewportPoint;
    x.value = point.x;
    y.value = point.y;
    side.value = placedSide;
    align.value = options.align ?? "center";
    const available = availableSize(placedSide, anchorRect, bounds, offset);
    availableWidth.value = available.width;
    availableHeight.value = available.height;
    const arrowRect = arrowElement?.getBoundingClientRect();
    if (placedSide === "top" || placedSide === "bottom") {
      arrowX.value = clampArrow(
        anchorRect.left + anchorRect.width / 2 - viewportPoint.x,
        floatingRect.width,
        arrowRect?.width ?? 0,
        arrowPadding,
      );
      arrowY.value = null;
    } else {
      arrowX.value = null;
      arrowY.value = clampArrow(
        anchorRect.top + anchorRect.height / 2 - viewportPoint.y,
        floatingRect.height,
        arrowRect?.height ?? 0,
        arrowPadding,
      );
    }
  };

  return {
    x, y, side, align, arrowX, arrowY, availableWidth, availableHeight, update,
    positioner: () => ({
      "data-side": () => side.value,
      "data-align": () => align.value,
      style: {
        position: options.strategy ?? "fixed",
        left: () => `${x.value}px`,
        top: () => `${y.value}px`,
        "--clank-anchor-width": () => {
          const anchor = resolveAnchor(options.anchor);
          return `${anchor?.getBoundingClientRect().width ?? 0}px`;
        },
        "--clank-anchor-height": () => {
          const anchor = resolveAnchor(options.anchor);
          return `${anchor?.getBoundingClientRect().height ?? 0}px`;
        },
        "--clank-available-width": () => `${availableWidth.value}px`,
        "--clank-available-height": () => `${availableHeight.value}px`,
        "--clank-transform-origin": () => transformOrigin(side.value, align.value, options.direction ?? "ltr"),
      },
      use: (element: Element): Cleanup => {
        if (disposed) throw new Error("Floating controller has been disposed.");
        floating = element as HTMLElement;
        const document = element.ownerDocument;
        const window = document.defaultView;
        let frame: number | undefined;
        const schedule = () => {
          if (!window || frame !== undefined) return;
          let completedSynchronously = false;
          const requested = window.requestAnimationFrame(() => {
            completedSynchronously = true;
            frame = undefined;
            update();
          });
          if (!completedSynchronously) frame = requested;
        };
        const Resize = window?.ResizeObserver;
        const observer = Resize ? new Resize(schedule) : undefined;
        const observedTargets = new Set<Element>();
        let initializedAnchor = false;
        let boundAnchor: Element | VirtualAnchor | null = null;
        let boundAnchorElement: Element | undefined;
        const targetsFor = (anchor: Element | VirtualAnchor | null) => {
          const targets = new Set<Element>([element]);
          const anchorElement = anchor ? isElementNode(anchor) ? anchor : anchor.contextElement : undefined;
          if (anchorElement) targets.add(anchorElement);
          if (isHTMLElement(element)) {
            const offsetParent = (element as HTMLElement).offsetParent;
            if (offsetParent && isElementNode(offsetParent)) targets.add(offsetParent);
          }
          if (anchor) for (const ancestor of clippingAncestors(element, anchor)) targets.add(ancestor);
          return { anchorElement, targets };
        };
        const bindAnchor = (anchor: Element | VirtualAnchor | null, scheduleUpdate: boolean) => {
          const { anchorElement, targets } = targetsFor(anchor);
          const identityChanged = !initializedAnchor || anchor !== boundAnchor || anchorElement !== boundAnchorElement;
          const targetsChanged = targets.size !== observedTargets.size
            || [...targets].some((target) => !observedTargets.has(target));
          if (targetsChanged) {
            observer?.disconnect();
            observedTargets.clear();
            for (const target of targets) {
              observedTargets.add(target);
              observer?.observe(target);
            }
          }
          initializedAnchor = true;
          boundAnchor = anchor;
          boundAnchorElement = anchorElement;
          if (scheduleUpdate && (identityChanged || targetsChanged)) schedule();
        };
        anchorBindings.add(bindAnchor);
        const stopAnchor = effect(() => {
          bindAnchor(resolveAnchor(options.anchor), true);
        });
        window?.addEventListener("resize", schedule, { passive: true });
        window?.visualViewport?.addEventListener("resize", schedule, { passive: true });
        window?.visualViewport?.addEventListener("scroll", schedule, { passive: true });
        document.addEventListener("scroll", schedule, { capture: true, passive: true });
        let mounted = true;
        const cleanup = () => {
          if (!mounted) return;
          mounted = false;
          stopAnchor();
          anchorBindings.delete(bindAnchor);
          if (frame !== undefined) window?.cancelAnimationFrame(frame);
          observer?.disconnect();
          window?.removeEventListener("resize", schedule);
          window?.visualViewport?.removeEventListener("resize", schedule);
          window?.visualViewport?.removeEventListener("scroll", schedule);
          document.removeEventListener("scroll", schedule, true);
          if (floating === element) floating = null;
          mounts.delete(cleanup);
        };
        mounts.add(cleanup);
        return cleanup;
      },
    }),
    arrow: () => ({
      "aria-hidden": true,
      "data-side": () => side.value,
      style: {
        position: "absolute",
        left: () => arrowX.value === null ? undefined : `${arrowX.value}px`,
        top: () => arrowY.value === null ? undefined : `${arrowY.value}px`,
      },
      use: (element: Element): Cleanup => {
        if (disposed) throw new Error("Floating controller has been disposed.");
        if (!isHTMLElement(element)) throw new TypeError("Floating arrow must be an HTMLElement.");
        arrowElement = element;
        const Resize = element.ownerDocument.defaultView?.ResizeObserver;
        const observer = Resize ? new Resize(() => update()) : undefined;
        observer?.observe(element);
        update();
        let mounted = true;
        const cleanup = () => {
          if (!mounted) return;
          mounted = false;
          observer?.disconnect();
          if (arrowElement === element) arrowElement = null;
          mounts.delete(cleanup);
        };
        mounts.add(cleanup);
        return cleanup;
      },
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...mounts]) cleanup();
      floating = null;
      arrowElement = null;
    },
  };
}

function resolveAnchor(anchor: FloatingAnchor): Element | VirtualAnchor | null {
  return typeof anchor === "function" ? anchor() : anchor;
}

interface FloatingBounds { left: number; top: number; right: number; bottom: number; }

function collisionBounds(
  floating: HTMLElement,
  anchor: Element | VirtualAnchor,
  padding: number,
): FloatingBounds {
  const window = floating.ownerDocument.defaultView;
  if (!window) return { left: padding, top: padding, right: padding, bottom: padding };
  const visual = window.visualViewport;
  const visualLeft = visual?.offsetLeft ?? 0;
  const visualTop = visual?.offsetTop ?? 0;
  let bounds: FloatingBounds = {
    left: visualLeft,
    top: visualTop,
    right: visualLeft + (visual?.width ?? window.innerWidth),
    bottom: visualTop + (visual?.height ?? window.innerHeight),
  };
  for (const ancestor of clippingAncestors(floating, anchor)) {
    const clip = clippingRect(ancestor);
    if (clip.x) {
      bounds.left = Math.max(bounds.left, clip.rect.left);
      bounds.right = Math.min(bounds.right, clip.rect.right);
    }
    if (clip.y) {
      bounds.top = Math.max(bounds.top, clip.rect.top);
      bounds.bottom = Math.min(bounds.bottom, clip.rect.bottom);
    }
  }
  bounds = {
    left: bounds.left + padding,
    top: bounds.top + padding,
    right: bounds.right - padding,
    bottom: bounds.bottom - padding,
  };
  if (bounds.right < bounds.left) bounds.right = bounds.left;
  if (bounds.bottom < bounds.top) bounds.bottom = bounds.top;
  return bounds;
}

function clippingAncestors(floating: Element, anchor: Element | VirtualAnchor): Element[] {
  const output = new Set<Element>();
  const anchorElement = isElementNode(anchor) ? anchor : anchor.contextElement;
  for (const element of [floating, anchorElement]) {
    let current = element ? composedParentElement(element) : null;
    const seen = new Set<Element>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (clipsOverflow(current)) output.add(current);
      current = composedParentElement(current);
    }
  }
  return [...output];
}

function isElementNode(value: Element | VirtualAnchor): value is Element {
  return "nodeType" in value && value.nodeType === 1;
}

function clipsOverflow(element: Element): boolean {
  const style = computedStyle(element);
  if (!style) return false;
  const overflow = style.overflow || "visible";
  return clipsOverflowValue(style.overflowX || overflow) || clipsOverflowValue(style.overflowY || overflow);
}

function clippingRect(element: Element): { rect: FloatingBounds; x: boolean; y: boolean } {
  const rect = element.getBoundingClientRect();
  const box = element as Element & {
    clientLeft?: number;
    clientTop?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
  const left = rect.left + finiteOr(box.clientLeft, 0);
  const top = rect.top + finiteOr(box.clientTop, 0);
  const clientWidth = finiteOr(box.clientWidth, rect.width);
  const clientHeight = finiteOr(box.clientHeight, rect.height);
  const style = computedStyle(element);
  const overflow = style?.overflow || "visible";
  return {
    rect: {
      left,
      top,
      right: clientWidth > 0 ? left + clientWidth : rect.right,
      bottom: clientHeight > 0 ? top + clientHeight : rect.bottom,
    },
    x: clipsOverflowValue(style?.overflowX || overflow),
    y: clipsOverflowValue(style?.overflowY || overflow),
  };
}

function computedStyle(element: Element): CSSStyleDeclaration | null {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle?.(element) ?? null;
  } catch {
    return null;
  }
}

function clipsOverflowValue(value: string): boolean {
  return /^(auto|clip|hidden|overlay|scroll)$/.test(value.trim().toLowerCase());
}

function toOffsetParentCoordinates(
  point: { x: number; y: number },
  floating: HTMLElement,
  window: Window,
): { x: number; y: number } {
  const offsetParent = floating.offsetParent;
  if (!offsetParent || !isElementNode(offsetParent)) {
    return { x: point.x + window.scrollX, y: point.y + window.scrollY };
  }
  const rect = offsetParent.getBoundingClientRect();
  const parent = offsetParent as Element & {
    clientLeft?: number;
    clientTop?: number;
    offsetWidth?: number;
    offsetHeight?: number;
    scrollLeft?: number;
    scrollTop?: number;
  };
  const scaleX = finiteScale(rect.width, parent.offsetWidth);
  const scaleY = finiteScale(rect.height, parent.offsetHeight);
  return {
    x: (point.x - rect.left) / scaleX - finiteOr(parent.clientLeft, 0) + finiteOr(parent.scrollLeft, 0),
    y: (point.y - rect.top) / scaleY - finiteOr(parent.clientTop, 0) + finiteOr(parent.scrollTop, 0),
  };
}

function finiteScale(rendered: number, layout?: number): number {
  if (!Number.isFinite(rendered) || !Number.isFinite(layout) || !layout || rendered <= 0) return 1;
  const scale = rendered / layout;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function availableSize(
  side: FloatingSide,
  anchor: DOMRect | DOMRectReadOnly,
  bounds: FloatingBounds,
  offset: number,
): { width: number; height: number } {
  if (side === "top") {
    return { width: Math.max(0, bounds.right - bounds.left), height: Math.max(0, anchor.top - offset - bounds.top) };
  }
  if (side === "bottom") {
    return { width: Math.max(0, bounds.right - bounds.left), height: Math.max(0, bounds.bottom - anchor.bottom - offset) };
  }
  if (side === "left") {
    return { width: Math.max(0, anchor.left - offset - bounds.left), height: Math.max(0, bounds.bottom - bounds.top) };
  }
  return { width: Math.max(0, bounds.right - anchor.right - offset), height: Math.max(0, bounds.bottom - bounds.top) };
}

function clampArrow(center: number, size: number, arrowSize: number, padding: number): number {
  const minimum = padding;
  const maximum = size - padding - arrowSize;
  if (maximum < minimum) return Math.max(0, (size - arrowSize) / 2);
  return clamp(center - arrowSize / 2, minimum, maximum);
}

function coordinates(side: FloatingSide, align: FloatingAlign, anchor: DOMRect | DOMRectReadOnly, floating: DOMRect | DOMRectReadOnly, offset: number, alignOffset: number, direction: "ltr" | "rtl"): { x: number; y: number } {
  let x = anchor.left + (anchor.width - floating.width) / 2;
  let y = anchor.top + (anchor.height - floating.height) / 2;
  if (side === "top") y = anchor.top - floating.height - offset;
  else if (side === "bottom") y = anchor.bottom + offset;
  else if (side === "left") x = anchor.left - floating.width - offset;
  else x = anchor.right + offset;
  if (side === "top" || side === "bottom") {
    const logical = direction === "rtl" ? (align === "start" ? "end" : align === "end" ? "start" : align) : align;
    if (logical === "start") x = anchor.left + alignOffset;
    else if (logical === "end") x = anchor.right - floating.width + alignOffset;
    else x += alignOffset;
  } else {
    if (align === "start") y = anchor.top + alignOffset;
    else if (align === "end") y = anchor.bottom - floating.height + alignOffset;
    else y += alignOffset;
  }
  return { x, y };
}

function spaceFor(side: FloatingSide, anchor: DOMRect | DOMRectReadOnly, bounds: { left: number; top: number; right: number; bottom: number }): number {
  if (side === "top") return anchor.top - bounds.top;
  if (side === "bottom") return bounds.bottom - anchor.bottom;
  if (side === "left") return anchor.left - bounds.left;
  return bounds.right - anchor.right;
}

function oppositeSide(side: FloatingSide): FloatingSide {
  return side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
}

function transformOrigin(side: FloatingSide, align: FloatingAlign, direction: "ltr" | "rtl"): string {
  const logicalAlign = (side === "top" || side === "bottom") && direction === "rtl"
    ? align === "start" ? "end" : align === "end" ? "start" : align
    : align;
  const cross = logicalAlign === "start" ? "0%" : logicalAlign === "end" ? "100%" : "50%";
  if (side === "top") return `${cross} 100%`;
  if (side === "bottom") return `${cross} 0%`;
  if (side === "left") return `100% ${cross}`;
  return `0% ${cross}`;
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function finite(value: number, name: string): number { if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`); return value; }
function readBoolean(value: boolean | ReactiveSignal<boolean> | Computed<boolean> | (() => boolean)): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "function") return Boolean(value());
  return Boolean(value.value);
}

export type PresenceState = "open" | "closed" | "starting" | "ending";
export interface PresenceOptions {
  present: boolean | ReactiveSignal<boolean> | Computed<boolean> | (() => boolean);
  keepMounted?: boolean;
  onExitComplete?: () => void;
}
export interface PresenceController {
  readonly mounted: ReactiveSignal<boolean>;
  readonly state: ReactiveSignal<PresenceState>;
  props(): Record<string, unknown>;
  finish(): void;
  dispose(): void;
}

/** Keeps exit content mounted until its CSS transition/animation completes. */
export function createPresence(options: PresenceOptions): PresenceController {
  const initial = readBoolean(options.present);
  const mounted = signal(initial || Boolean(options.keepMounted), { name: "ui.presence.mounted" });
  const state = signal<PresenceState>(initial ? "open" : "closed", { name: "ui.presence.state" });
  let element: HTMLElement | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let frameWindow: Window | null = null;
  let frames: number[] = [];
  let enterToken = 0;
  let exitToken = 0;
  let exiting = false;
  let disposed = false;
  let tracker: MotionTracker = emptyMotionTracker();

  const clearTimeoutFallback = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const cancelEnter = () => {
    enterToken++;
    if (frameWindow) for (const frame of frames) frameWindow.cancelAnimationFrame(frame);
    frames = [];
    frameWindow = null;
  };
  const completeEnter = () => {
    cancelEnter();
    if (!disposed && readBoolean(options.present)) state.value = "open";
  };
  const scheduleEnter = () => {
    cancelEnter();
    const token = enterToken;
    const scheduleWithWindow = (window: Window) => {
      frameWindow = window;
      requestFrame(window, frames, () => {
        if (disposed || token !== enterToken || !readBoolean(options.present)) return;
        // The first frame commits data-starting-style. Crossing on the next frame guarantees
        // that CSS can observe a painted starting state instead of coalescing both mutations.
        requestFrame(window, frames, () => {
          if (disposed || token !== enterToken || !readBoolean(options.present)) return;
          frames = [];
          frameWindow = null;
          state.value = "open";
        });
      });
    };
    const window = element?.ownerDocument.defaultView;
    if (window?.requestAnimationFrame) {
      scheduleWithWindow(window);
      return;
    }
    queueMicrotask(() => {
      if (disposed || token !== enterToken || !readBoolean(options.present)) return;
      const mountedWindow = element?.ownerDocument.defaultView;
      if (mountedWindow?.requestAnimationFrame) scheduleWithWindow(mountedWindow);
      else state.value = "open";
    });
  };
  const completeExit = () => {
    if (!exiting || readBoolean(options.present)) return;
    exiting = false;
    exitToken++;
    clearTimeoutFallback();
    tracker = emptyMotionTracker();
    state.value = "closed";
    if (!options.keepMounted) mounted.value = false;
    options.onExitComplete?.();
  };
  const beginExit = () => {
    cancelEnter();
    clearTimeoutFallback();
    exiting = true;
    const token = ++exitToken;
    state.value = "ending";
    tracker = element ? motionTracker(element) : emptyMotionTracker();
    if (tracker.maximum <= 0) {
      queueMicrotask(() => { if (!disposed && token === exitToken) completeExit(); });
      return;
    }
    timeout = setTimeout(() => {
      if (!disposed && token === exitToken) completeExit();
    }, tracker.maximum + 50);
  };
  const finish = () => {
    if (state.peek() === "starting") completeEnter();
    else if (state.peek() === "ending") completeExit();
  };
  let lastPresent = false;
  const stop = effect(() => {
    const present = readBoolean(options.present);
    if (present) {
      clearTimeoutFallback();
      exiting = false;
      exitToken++;
      tracker = emptyMotionTracker();
      mounted.value = true;
      state.value = "starting";
      scheduleEnter();
    } else if (lastPresent && mounted.peek()) {
      beginExit();
    }
    lastPresent = present;
  });
  return {
    mounted,
    state,
    finish,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      cancelEnter();
      clearTimeoutFallback();
      tracker = emptyMotionTracker();
      element = null;
    },
    props: () => ({
      "data-open": () => state.value === "open" || state.value === "starting" ? "" : undefined,
      "data-closed": () => state.value === "closed" || state.value === "ending" ? "" : undefined,
      "data-starting-style": () => state.value === "starting" ? "" : undefined,
      "data-ending-style": () => state.value === "ending" ? "" : undefined,
      hidden: () => state.value === "closed" && Boolean(options.keepMounted),
      use: (node: Element): Cleanup => {
        if (disposed) throw new Error("Presence controller has been disposed.");
        if (!isHTMLElement(node)) throw new TypeError("Presence must be mounted on an HTMLElement.");
        element = node as HTMLElement;
        if (state.peek() === "starting") scheduleEnter();
        else if (state.peek() === "ending") beginExit();
        const transitionEnd = (event: Event) => motionEnded("transition", event, node, tracker, completeExit);
        const animationEnd = (event: Event) => motionEnded("animation", event, node, tracker, completeExit);
        node.addEventListener?.("transitionend", transitionEnd);
        node.addEventListener?.("transitioncancel", transitionEnd);
        node.addEventListener?.("animationend", animationEnd);
        node.addEventListener?.("animationcancel", animationEnd);
        return () => {
          node.removeEventListener?.("transitionend", transitionEnd);
          node.removeEventListener?.("transitioncancel", transitionEnd);
          node.removeEventListener?.("animationend", animationEnd);
          node.removeEventListener?.("animationcancel", animationEnd);
          if (element === node) {
            element = null;
            if (state.peek() === "starting") scheduleEnter();
          }
        };
      },
    }),
  };
}

interface MotionTracker {
  maximum: number;
  wildcardTransition: boolean;
  transitions: Map<string, number>;
  animations: Map<string, number>;
}

function emptyMotionTracker(): MotionTracker {
  return { maximum: 0, wildcardTransition: false, transitions: new Map(), animations: new Map() };
}

function motionTracker(element: HTMLElement): MotionTracker {
  const style = computedStyle(element);
  if (!style) return emptyMotionTracker();
  const tracker = emptyMotionTracker();
  const transitionProperties = cssList(style.transitionProperty || "all");
  const transitionDurations = cssList(style.transitionDuration || "0s").map(cssTime);
  const transitionDelays = cssList(style.transitionDelay || "0s").map(cssTime);
  for (let index = 0; index < transitionProperties.length; index++) {
    const property = transitionProperties[index]!.trim();
    if (!property || property === "none") continue;
    const duration = cycle(transitionDurations, index);
    const delay = cycle(transitionDelays, index);
    const total = Math.max(0, duration + delay);
    if (duration <= 0 || total <= 0) continue;
    tracker.maximum = Math.max(tracker.maximum, total);
    if (property === "all") tracker.wildcardTransition = true;
    else increment(tracker.transitions, property);
  }

  const animationNames = cssList(style.animationName || "none");
  const animationDurations = cssList(style.animationDuration || "0s").map(cssTime);
  const animationDelays = cssList(style.animationDelay || "0s").map(cssTime);
  const animationIterations = cssList(style.animationIterationCount || "1").map((value) => {
    const count = value.trim().toLowerCase() === "infinite" ? Infinity : Number.parseFloat(value);
    return Number.isFinite(count) && count > 0 ? count : count === Infinity ? Infinity : 0;
  });
  for (let index = 0; index < animationNames.length; index++) {
    const name = animationNames[index]!.trim();
    if (!name || name === "none") continue;
    const duration = cycle(animationDurations, index);
    const iterations = cycle(animationIterations, index);
    // Infinite animations are ongoing decoration, not an exit boundary: waiting for them would
    // keep a closed overlay mounted forever because animationend is never dispatched.
    if (duration <= 0 || !Number.isFinite(iterations) || iterations <= 0) continue;
    const total = Math.max(0, duration * iterations + cycle(animationDelays, index));
    if (total <= 0) continue;
    tracker.maximum = Math.max(tracker.maximum, total);
    increment(tracker.animations, name);
  }
  return tracker;
}

function motionEnded(
  kind: "transition" | "animation",
  event: Event,
  node: Element,
  tracker: MotionTracker,
  finish: () => void,
): void {
  if (event.target !== node) return;
  const details = event as Event & { propertyName?: string; animationName?: string };
  const name = kind === "transition" ? details.propertyName : details.animationName;
  if (!name) return;
  const pending = kind === "transition" ? tracker.transitions : tracker.animations;
  decrement(pending, name);
  if (!tracker.wildcardTransition && tracker.transitions.size === 0 && tracker.animations.size === 0) finish();
}

function cssList(value: string): string[] {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : [""];
}

function cssTime(value: string): number {
  const normalized = value.trim().toLowerCase();
  const number = Number.parseFloat(normalized);
  if (!Number.isFinite(number)) return 0;
  return normalized.endsWith("ms") ? number : number * 1000;
}

function cycle(values: readonly number[], index: number): number {
  return values.length > 0 ? values[index % values.length]! : 0;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const count = map.get(key);
  if (!count) return;
  if (count === 1) map.delete(key);
  else map.set(key, count - 1);
}

function requestFrame(window: Window, frames: number[], callback: () => void): void {
  let completedSynchronously = false;
  let frame = 0;
  frame = window.requestAnimationFrame(() => {
    completedSynchronously = true;
    if (frame) {
      const index = frames.indexOf(frame);
      if (index >= 0) frames.splice(index, 1);
    }
    callback();
  });
  if (!completedSynchronously) frames.push(frame);
}
