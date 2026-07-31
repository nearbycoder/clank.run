import {
  computed,
  isSignal,
  signal,
  type Cleanup,
  type Computed,
} from "./core.ts";

/** Metadata passed to controlled and uncontrolled state change callbacks. */
export interface ChangeDetails<Reason extends string = string> {
  readonly reason: Reason;
  readonly event?: Event;
  readonly canceled: boolean;
  cancel(): void;
}

/** Creates a change record whose cancellation can stop a component's default state transition. */
export function createChangeDetails<Reason extends string>(
  reason: Reason,
  event?: Event,
): ChangeDetails<Reason> {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("A UI change reason must be a non-empty string.");
  }
  let canceled = Boolean(event?.defaultPrevented);
  return Object.freeze({
    reason,
    ...(event === undefined ? {} : { event }),
    get canceled() {
      return canceled || Boolean(event?.defaultPrevented);
    },
    cancel() {
      canceled = true;
    },
  });
}

export interface ControllableStateOptions<Value, Reason extends string = string> {
  /** A value or reactive getter. Its presence makes the state controlled. */
  value?: Value | (() => Value);
  defaultValue: Value;
  onValueChange?: (value: Value, details: ChangeDetails<Reason>) => void;
  equals?: (previous: Value, next: Value) => boolean;
  name?: string;
}

export interface ControllableState<Value, Reason extends string = string> {
  readonly value: Computed<Value>;
  /** Returns true only when an accepted, non-equal transition was requested. */
  set(next: Value, reason: Reason, event?: Event): boolean;
  /** Restores the initial value while preserving the originating event and cancellation. */
  reset(reason?: Reason, event?: Event): boolean;
}

/**
 * Creates state that behaves identically in controlled and uncontrolled modes.
 * A controlled setter emits a change request but never mutates the supplied value.
 */
export function createControllableState<Value, Reason extends string = string>(
  options: ControllableStateOptions<Value, Reason>,
): ControllableState<Value, Reason> {
  const controlled = Object.prototype.hasOwnProperty.call(options, "value");
  const initial = options.defaultValue;
  const internal = signal(initial, {
    name: options.name ? `${options.name}.uncontrolled` : undefined,
    equals: options.equals,
  });
  const readControlled = () => {
    const input = options.value;
    return typeof input === "function" ? (input as () => Value)() : input as Value;
  };
  const value = computed(
    () => controlled ? readControlled() : internal.value,
    { name: options.name },
  );
  const equal = options.equals ?? Object.is;

  const set = (next: Value, reason: Reason, event?: Event): boolean => {
    const previous = value.peek();
    if (equal(previous, next)) return false;
    const details = createChangeDetails(reason, event);
    if (details.canceled) return false;
    options.onValueChange?.(next, details);
    if (details.canceled) return false;
    if (!controlled) internal.value = next;
    return true;
  };

  return {
    value,
    set,
    reset: (reason = "reset" as Reason, event?: Event) => set(initial, reason, event),
  };
}

export type UiEventHandler<EventType extends Event = Event> = (event: EventType) => void | boolean;

/** Returns true for native cancellation and Clank structured cancellation. */
export function isEventCanceled(event: Event | { defaultPrevented?: boolean; canceled?: boolean; detail?: unknown }): boolean {
  const candidate = event as Event & { canceled?: boolean; detail?: { canceled?: boolean } };
  return Boolean(candidate.defaultPrevented || candidate.canceled || candidate.detail?.canceled);
}

/**
 * Composes public and internal handlers in order. Calling preventDefault(),
 * cancel(), or returning false prevents all later handlers from running.
 */
export function composeEventHandlers<EventType extends Event>(
  ...handlers: Array<UiEventHandler<EventType> | null | undefined | false>
): UiEventHandler<EventType> {
  return (event) => {
    for (const handler of handlers) {
      if (!handler || isEventCanceled(event)) break;
      const result = handler(event);
      if (result === false) {
        event.preventDefault();
        break;
      }
    }
  };
}

export type UiProps = Record<string, unknown>;

const TOKEN_LIST_ARIA = new Set([
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
]);

/**
 * Merges headless-part props without losing public handlers, classes, styles,
 * ARIA relationships, class lists, or refs. Sources run from left to right.
 */
export function mergeProps(...sources: Array<UiProps | null | undefined | false>): UiProps {
  const output: UiProps = {};
  const classes: unknown[] = [];
  const classLists: unknown[] = [];
  const styles: unknown[] = [];
  const ariaTokens = new Map<string, unknown[]>();
  const handlers = new Map<string, UiEventHandler[]>();
  const refs: UiRef<unknown>[] = [];
  const directives: Array<(element: Element) => void | Cleanup> = [];
  let classKey: "class" | "className" = "class";

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (key === "class" || key === "className") {
        classKey = key;
        classes.push(value);
      } else if (key === "style") {
        styles.push(value);
      } else if (key === "classList") {
        classLists.push(value);
      } else if (key === "ref" && isRef(value)) {
        refs.push(value);
      } else if (key === "use") {
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          if (typeof entry === "function") directives.push(entry as (element: Element) => void | Cleanup);
        }
      } else if (isEventProp(key) && typeof value === "function") {
        const list = handlers.get(key) ?? [];
        list.push(value as UiEventHandler);
        handlers.set(key, list);
      } else if (TOKEN_LIST_ARIA.has(key)) {
        const list = ariaTokens.get(key) ?? [];
        list.push(value);
        ariaTokens.set(key, list);
      } else {
        output[key] = value;
      }
    }
  }

  if (classes.length > 0) output[classKey] = mergeClassValues(classes);
  if (classLists.length > 0) output.classList = mergeClassListValues(classLists);
  if (styles.length > 0) output.style = mergeStyleValues(styles);
  for (const [key, values] of ariaTokens) output[key] = mergeTokenValues(values);
  for (const [key, values] of handlers) output[key] = composeEventHandlers(...values);
  if (refs.length > 0) output.ref = mergeRefs(...refs);
  if (directives.length > 0) output.use = (element: Element): Cleanup => {
    const cleanups: Cleanup[] = [];
    try {
      for (const directive of directives) {
        const cleanup = directive(element);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup();
      throw error;
    }
    return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
  };
  return output;
}

export type UiRef<Value> =
  | ((value: Value | null) => void | Cleanup)
  | { current: Value | null }
  | null
  | undefined;

/**
 * Composes callback and object refs. Replacing or clearing a value runs callback
 * cleanups, sends null to callbacks without a cleanup, and clears object refs.
 */
export function mergeRefs<Value>(...refs: Array<UiRef<Value>>): (value: Value | null) => void {
  let assignments: Array<{ ref: UiRef<Value>; cleanup?: Cleanup }> = [];

  const clear = () => {
    const previous = assignments;
    assignments = [];
    for (const assignment of previous.reverse()) {
      const { ref, cleanup } = assignment;
      if (cleanup) cleanup();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    }
  };

  return (value) => {
    const hadAssignments = assignments.length > 0;
    clear();
    if (value === null) {
      // Refs which have never held a value still receive an explicit null.
      if (refs.length > 0 && !hadAssignments) {
        for (const ref of refs) {
          if (typeof ref === "function") ref(null);
          else if (ref) ref.current = null;
        }
      }
      return;
    }
    const next: Array<{ ref: UiRef<Value>; cleanup?: Cleanup }> = [];
    try {
      for (const ref of refs) {
        if (!ref) continue;
        if (typeof ref === "function") {
          const cleanup = ref(value);
          next.push({ ref, ...(typeof cleanup === "function" ? { cleanup } : {}) });
        } else {
          ref.current = value;
          next.push({ ref });
        }
      }
      assignments = next;
    } catch (error) {
      for (const assignment of next.reverse()) {
        if (assignment.cleanup) assignment.cleanup();
        else if (typeof assignment.ref === "function") assignment.ref(null);
        else if (assignment.ref) assignment.ref.current = null;
      }
      throw error;
    }
  };
}

export interface IdScope {
  readonly prefix: string;
  /** Returns a stable named part ID, or the next deterministic anonymous ID. */
  id(part?: string): string;
  /** Creates an independent deterministic scope below this scope. */
  child(part: string): IdScope;
}

/** Creates an explicit, request-local ID scope. It never reads global mutable state. */
export function createIdScope(prefix: string, seed?: string | number): IdScope {
  const root = [idToken(prefix), seed === undefined ? "" : idToken(String(seed))].filter(Boolean).join("-");
  let anonymous = 0;
  const scope: IdScope = Object.freeze({
    prefix: root,
    id(part?: string) {
      // "$" cannot appear in an encoded named token, so anonymous and named IDs cannot collide.
      return part === undefined ? `${root}-$${++anonymous}` : `${root}-${idToken(part)}`;
    },
    child(part: string) {
      return createIdScope(`${root}-${idToken(part)}`);
    },
  });
  return scope;
}

/** Alias that makes the UI-specific ownership of a scope explicit. */
export const createUiIdScope = createIdScope;

/** Derives an ID only from an explicit scope, avoiding server/client global counter drift. */
export function createUiId(scope: IdScope, part?: string): string {
  if (!scope || typeof scope.id !== "function") throw new TypeError("createUiId requires an IdScope.");
  return scope.id(part);
}

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

export type UiManifestInput = Omit<UiManifest, "protocol"> & { protocol?: "clank-ui/1" };

/** Creates a detached, serializable component contract for agents and tooling. */
export function createUiManifest(input: UiManifestInput): UiManifest {
  if (!input || typeof input !== "object") throw new TypeError("A UI manifest input is required.");
  if (input.protocol !== undefined && input.protocol !== "clank-ui/1") throw new TypeError("Unsupported UI manifest protocol.");
  if (!input.component?.trim()) throw new TypeError("A UI manifest component name is required.");
  if (!input.id?.trim()) throw new TypeError("A UI manifest ID is required.");
  if (!Array.isArray(input.parts)) throw new TypeError("UI manifest parts must be an array.");
  if (!Array.isArray(input.actions)) throw new TypeError("UI manifest actions must be an array.");
  const state = cloneSerializableRecord(input.state, "state");
  const parts = input.parts.map((part: UiPartManifest) => Object.freeze({
    name: requireManifestText(part.name, "part name"),
    ...(part.role === undefined ? {} : { role: requireManifestText(part.role, "part role") }),
    ...(part.defaultElement === undefined ? {} : { defaultElement: requireManifestText(part.defaultElement, "part element") }),
    ...(part.required === undefined ? {} : { required: Boolean(part.required) }),
  }));
  const actions = input.actions.map((action: UiActionManifest) => {
    if (!["none", "read", "write"].includes(action.sideEffects)) {
      throw new TypeError(`Invalid UI action sideEffects: ${String(action.sideEffects)}`);
    }
    return Object.freeze({
      name: requireManifestText(action.name, "action name"),
      description: requireManifestText(action.description, "action description"),
      sideEffects: action.sideEffects,
      ...(action.reasons === undefined ? {} : {
        reasons: Object.freeze(action.reasons.map((reason: string) => requireManifestText(reason, "action reason"))),
      }),
    });
  });
  assertUniqueManifestNames(parts, "part");
  assertUniqueManifestNames(actions, "action");
  const keyboard = input.keyboard === undefined ? undefined : cloneKeyboardManifest(input.keyboard);
  const manifest: UiManifest = {
    protocol: "clank-ui/1",
    component: input.component.trim(),
    id: input.id.trim(),
    state: Object.freeze(state),
    parts: Object.freeze(parts),
    actions: Object.freeze(actions),
    ...(keyboard === undefined ? {} : { keyboard }),
  };
  return Object.freeze(manifest);
}

export type Direction = "ltr" | "rtl";
export type DirectionInput = Direction | "auto" | null | undefined;
export type Orientation = "horizontal" | "vertical";
export type PhysicalSide = "top" | "right" | "bottom" | "left";
export type LogicalSide = PhysicalSide | "inline-start" | "inline-end" | "block-start" | "block-end";

/** Resolves explicit, inherited, computed, and document directions in that order. */
export function resolveDirection(direction?: DirectionInput, element?: Element | null): Direction {
  if (direction === "ltr" || direction === "rtl") return direction;
  let current: unknown = element;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const declared = readAttribute(current, "dir");
    if (declared === "ltr" || declared === "rtl") return declared;
    current = parentElementOrHost(current);
  }
  const document = getOwnerDocument(element);
  const view = document?.defaultView;
  if (element && typeof view?.getComputedStyle === "function") {
    try {
      const computedDirection = view.getComputedStyle(element).direction;
      if (computedDirection === "ltr" || computedDirection === "rtl") return computedDirection;
    } catch {
      // Detached and cross-origin nodes can reject style lookup.
    }
  }
  const rootDirection = readAttribute(document?.documentElement, "dir") ?? document?.documentElement?.dir;
  if (rootDirection === "ltr" || rootDirection === "rtl") return rootDirection;
  return "ltr";
}

export function isRtl(direction?: DirectionInput, element?: Element | null): boolean {
  return resolveDirection(direction, element) === "rtl";
}

export function resolveLogicalSide(side: LogicalSide, direction: Direction = "ltr"): PhysicalSide {
  if (side === "inline-start") return direction === "rtl" ? "right" : "left";
  if (side === "inline-end") return direction === "rtl" ? "left" : "right";
  if (side === "block-start") return "top";
  if (side === "block-end") return "bottom";
  return side;
}

/** Safely resolves a node, window, or document to its owner document during SSR. */
export function getOwnerDocument(target?: unknown): Document | null {
  if (!target) return typeof document === "undefined" ? null : document;
  const candidate = target as {
    nodeType?: number;
    ownerDocument?: Document | null;
    document?: Document;
    defaultView?: unknown;
    documentElement?: Element;
  };
  if (candidate.nodeType === 9) return candidate as unknown as Document;
  if (candidate.ownerDocument) return candidate.ownerDocument;
  if (candidate.document?.nodeType === 9) return candidate.document;
  if (candidate.defaultView && candidate.documentElement) return candidate as unknown as Document;
  return typeof document === "undefined" ? null : document;
}

/** Returns the shadow-DOM-aware propagation path, with a safe DOM fallback. */
export function getComposedPath(event: Event): EventTarget[] {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    if (path.length > 0) return path;
  }
  const output: EventTarget[] = [];
  const seen = new Set<unknown>();
  let current: unknown = event.target;
  while (current && !seen.has(current)) {
    seen.add(current);
    output.push(current as EventTarget);
    current = parentNodeOrHost(current);
  }
  const document = getOwnerDocument(event.target);
  if (document && !output.includes(document)) output.push(document);
  if (document?.defaultView && !output.includes(document.defaultView)) output.push(document.defaultView);
  return output;
}

/** Tests containment using composedPath first so events from open shadow roots work. */
export function containsEventTarget(container: Node | null | undefined, event: Event): boolean {
  if (!container) return false;
  const path = getComposedPath(event);
  if (path.includes(container)) return true;
  const target = path[0] ?? event.target;
  if (!target || typeof container.contains !== "function") return false;
  try {
    return container.contains(target as Node);
  } catch {
    return false;
  }
}

export interface FocusableElementsOptions {
  /** Includes the root itself when it is focusable. */
  includeRoot?: boolean;
  /** Defaults to true. False includes programmatic tabindex=-1 targets. */
  tabbable?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]",
  "[tabindex]",
].join(",");

/** Checks native eligibility, disabled ancestors, inertness, visibility, and tab order. */
export function isFocusable(element: Element, options: FocusableElementsOptions = {}): element is HTMLElement {
  if (!element || typeof (element as HTMLElement).focus !== "function") return false;
  if (!isFocusableKind(element)) return false;
  if (isUnavailable(element)) return false;
  const tabIndex = readTabIndex(element);
  if (options.tabbable !== false && tabIndex < 0) return false;
  return true;
}

/** Returns focus targets in browser tab order, including open shadow roots. */
export function focusableElements(root: ParentNode, options: FocusableElementsOptions = {}): HTMLElement[] {
  if (!root) return [];
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const visit = (scope: ParentNode) => {
    if (options.includeRoot && isElementLike(scope)) add(scope);
    if (typeof scope.querySelectorAll !== "function") return;
    for (const element of Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR))) {
      add(element);
      const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) visit(shadow);
    }
  };
  const add = (element: Element) => {
    if (seen.has(element)) return;
    seen.add(element);
    candidates.push(element);
  };
  visit(root);
  return candidates
    .map((element, order) => ({ element, order, tabIndex: readTabIndex(element) }))
    .filter(({ element }) => isFocusable(element, options))
    .sort((a, b) => {
      const aPositive = a.tabIndex > 0;
      const bPositive = b.tabIndex > 0;
      if (aPositive !== bPositive) return aPositive ? -1 : 1;
      if (aPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
      return a.order - b.order;
    })
    .map(({ element }) => element as HTMLElement);
}

export interface FocusFirstOptions extends FocusableElementsOptions {
  preventScroll?: boolean;
  select?: boolean;
  fallback?: HTMLElement | null;
}

/** Focuses the first usable candidate and returns it, or null if every focus attempt fails. */
export function focusFirst(
  rootOrElements: ParentNode | Iterable<HTMLElement>,
  options: FocusFirstOptions = {},
): HTMLElement | null {
  const elements = isParentNodeLike(rootOrElements)
    ? focusableElements(rootOrElements, options)
    : Array.from(rootOrElements).filter((element) => isFocusable(element, options));
  if (options.fallback) elements.push(options.fallback);
  for (const element of elements) {
    try {
      element.focus({ preventScroll: options.preventScroll });
      if (options.select && typeof (element as HTMLInputElement).select === "function") {
        (element as HTMLInputElement).select();
      }
      return element;
    } catch {
      try {
        element.focus();
        return element;
      } catch {
        // Continue to the next candidate.
      }
    }
  }
  return null;
}

export type CollectionNavigationIntent =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "page-next"
  | "page-previous";

export interface CollectionNavigationOptions<Item> {
  loop?: boolean;
  pageSize?: number;
  disabled?: (item: Item, index: number) => boolean;
}

/** Maps physical keyboard arrows to a logical collection move. */
export function getCollectionNavigationIntent(
  key: string,
  orientation: Orientation = "vertical",
  direction: Direction = "ltr",
): CollectionNavigationIntent | null {
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "PageDown") return "page-next";
  if (key === "PageUp") return "page-previous";
  if (orientation === "vertical") {
    if (key === "ArrowDown") return "next";
    if (key === "ArrowUp") return "previous";
  } else {
    if (key === "ArrowRight") return direction === "rtl" ? "previous" : "next";
    if (key === "ArrowLeft") return direction === "rtl" ? "next" : "previous";
  }
  return null;
}

/** Finds the next enabled collection index without mutating the collection. */
export function findCollectionIndex<Item>(
  items: readonly Item[],
  currentIndex: number,
  intent: CollectionNavigationIntent,
  options: CollectionNavigationOptions<Item> = {},
): number {
  if (items.length === 0) return -1;
  const disabled = options.disabled ?? defaultDisabled;
  const enabled = (index: number) => index >= 0 && index < items.length && !disabled(items[index]!, index);
  if (intent === "first") return seekEnabled(items, 0, 1, disabled);
  if (intent === "last") return seekEnabled(items, items.length - 1, -1, disabled);

  const direction = intent === "previous" || intent === "page-previous" ? -1 : 1;
  const page = intent === "page-next" || intent === "page-previous"
    ? Math.max(1, Math.trunc(options.pageSize ?? 10))
    : 1;
  let index = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < items.length
    ? currentIndex + direction * page
    : direction > 0 ? 0 : items.length - 1;
  if (!options.loop) {
    index = Math.max(0, Math.min(items.length - 1, index));
    let found = seekEnabled(items, index, direction, disabled);
    if (found === -1 && page > 1) found = seekEnabled(items, index, -direction as -1 | 1, disabled);
    return found === -1 && enabled(currentIndex) ? currentIndex : found;
  }
  for (let visited = 0; visited < items.length; visited++) {
    const wrapped = ((index % items.length) + items.length) % items.length;
    if (enabled(wrapped)) return wrapped;
    index += direction;
  }
  return -1;
}

export interface TypeaheadOptions<Item> {
  timeout?: number;
  textValue?: (item: Item, index: number) => string;
  disabled?: (item: Item, index: number) => boolean;
  locale?: string | string[];
  /** Test and non-browser time source; defaults to Date.now. */
  now?: () => number;
}

export interface TypeaheadController<Item> {
  readonly query: string;
  search(key: string, items: readonly Item[], currentIndex?: number): number;
  reset(): void;
  dispose(): void;
}

/** Finds a prefix match with disabled-item skipping and repeated-key cycling. */
export function findTypeaheadMatch<Item>(
  items: readonly Item[],
  query: string,
  currentIndex = -1,
  options: Omit<TypeaheadOptions<Item>, "timeout" | "now"> = {},
): number {
  if (items.length === 0) return -1;
  const rawNeedle = normalizeSearchText(query);
  if (!rawNeedle) return -1;
  const repeated = [...rawNeedle].every((character) => character === [...rawNeedle][0]);
  const needle = repeated ? [...rawNeedle][0]! : rawNeedle;
  const disabled = options.disabled ?? defaultDisabled;
  const textValue = options.textValue ?? defaultTextValue;
  const collator = typeof Intl === "undefined" ? null : new Intl.Collator(options.locale, {
    usage: "search",
    sensitivity: "base",
  });
  const matches = (item: Item, index: number) => {
    if (disabled(item, index)) return false;
    const text = normalizeSearchText(textValue(item, index));
    const prefix = [...text].slice(0, [...needle].length).join("");
    return collator ? collator.compare(prefix, needle) === 0 : prefix === needle;
  };
  const start = repeated || rawNeedle.length === 1 ? currentIndex + 1 : Math.max(0, currentIndex);
  for (let offset = 0; offset < items.length; offset++) {
    const index = ((start + offset) % items.length + items.length) % items.length;
    if (matches(items[index]!, index)) return index;
  }
  return -1;
}

/** Creates an isolated typeahead buffer; dispose it when its component is destroyed. */
export function createTypeahead<Item>(options: TypeaheadOptions<Item> = {}): TypeaheadController<Item> {
  const timeout = options.timeout ?? 500;
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("Typeahead timeout must be a non-negative number.");
  const now = options.now ?? Date.now;
  let query = "";
  let updatedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const reset = () => {
    query = "";
    updatedAt = -Infinity;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const controller: TypeaheadController<Item> = {
    get query() {
      return query;
    },
    search(key, items, currentIndex = -1) {
      if (disposed || !isPrintableKey(key)) return -1;
      const timestamp = now();
      if (timestamp - updatedAt > timeout) query = "";
      query += key;
      updatedAt = timestamp;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(reset, timeout);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      return findTypeaheadMatch(items, query, currentIndex, options);
    },
    reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
    },
  };
  return controller;
}

export type DataFlagValue = string | number | boolean | null | undefined;

/**
 * Emits a common data-state plus Base-UI-style data-open/data-checked flags.
 * False and nullish extra flags are represented by an omitted (undefined) value.
 */
export function dataState(
  state: string,
  flags: Record<string, DataFlagValue> = {},
): Record<string, string | number | undefined> {
  const token = dataToken(state);
  const output: Record<string, string | number | undefined> = {
    "data-state": token,
    [`data-${token}`]: "",
  };
  for (const [name, value] of Object.entries(flags)) {
    const attribute = name.startsWith("data-") ? `data-${dataToken(name.slice(5))}` : `data-${dataToken(name)}`;
    if (attribute === `data-${token}` || attribute === "data-state") continue;
    output[attribute] = value === true ? "" : value === false || value == null ? undefined : value;
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRef(value: unknown): value is UiRef<unknown> {
  return typeof value === "function"
    || Boolean(value && typeof value === "object" && "current" in value);
}

function isEventProp(key: string): boolean {
  return /^on(?::|[A-Z])/.test(key);
}

function isDynamic(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === "function" || isSignal(value)) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => isDynamic(entry, seen));
  return Object.values(value as Record<string, unknown>).some((entry) => isDynamic(entry, seen));
}

function resolveDynamic(value: unknown): unknown {
  let current = value;
  const seen = new Set<unknown>();
  while (typeof current === "function" || isSignal(current)) {
    if (seen.has(current)) throw new Error("Circular reactive UI prop.");
    seen.add(current);
    current = typeof current === "function"
      ? (current as () => unknown)()
      : current.value;
  }
  return current;
}

function classString(value: unknown): string {
  const resolved = resolveDynamic(value);
  if (Array.isArray(resolved)) return resolved.map(classString).filter(Boolean).join(" ");
  if (resolved && typeof resolved === "object") {
    return Object.entries(resolved as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(resolveDynamic(enabled)))
      .map(([name]) => name)
      .join(" ");
  }
  return resolved === null || resolved === undefined || resolved === false ? "" : String(resolved);
}

function mergeClassValues(values: unknown[]): string | (() => string) {
  const read = () => values.map(classString).filter(Boolean).join(" ").trim().replace(/\s+/g, " ");
  return values.some((value) => isDynamic(value)) ? read : read();
}

function mergeClassListValues(values: unknown[]): unknown {
  const read = () => {
    const merged: Record<string, unknown> = {};
    for (const value of values) {
      const resolved = resolveDynamic(value);
      if (isPlainRecord(resolved)) Object.assign(merged, resolved);
    }
    return merged;
  };
  return values.some((value) => isDynamic(value)) ? read : read();
}

function mergeTokenValues(values: unknown[]): string | (() => string) {
  const read = () => {
    const tokens = new Set<string>();
    for (const value of values) {
      const resolved = resolveDynamic(value);
      if (resolved === null || resolved === undefined || resolved === false) continue;
      for (const token of String(resolved).split(/\s+/).filter(Boolean)) tokens.add(token);
    }
    return [...tokens].join(" ");
  };
  return values.some((value) => isDynamic(value)) ? read : read();
}

function mergeStyleValues(values: unknown[]): unknown {
  const dynamic = values.some((value) => isDynamic(value));
  const read = () => {
    const resolved = values.map(resolveDynamic).filter((value) => value !== null && value !== undefined && value !== false);
    const objectsOnly = resolved.every(isPlainRecord);
    if (objectsOnly) return Object.assign({}, ...resolved as Record<string, unknown>[]);
    return resolved.map((value) => typeof value === "string" ? value : styleString(value)).filter(Boolean).join(";");
  };
  return dynamic ? read : read();
}

function styleString(value: unknown): string {
  if (!isPlainRecord(value)) return String(value ?? "");
  return Object.entries(value).flatMap(([name, entry]) => {
    const resolved = resolveDynamic(entry);
    if (resolved === null || resolved === undefined || resolved === false) return [];
    const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (!/^(?:--[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]*)$/.test(property)) {
      throw new TypeError(`Unsafe CSS property: ${name}`);
    }
    return `${property}:${String(resolved)}`;
  }).join(";");
}

function idToken(value: string): string {
  const trimmed = value.trim().normalize("NFKC");
  if (!trimmed) throw new TypeError("An ID scope token cannot be empty.");
  return [...trimmed].map((character) => /[A-Za-z0-9_-]/.test(character)
    ? character
    : `_${character.codePointAt(0)!.toString(16)}_`).join("");
}

function dataToken(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new TypeError(`Invalid data-state token: ${String(value)}`);
  }
  return value;
}

function requireManifestText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`A UI manifest ${label} is required.`);
  return value.trim();
}

function assertUniqueManifestNames(entries: readonly { name: string }[], label: string): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new TypeError(`Duplicate UI manifest ${label}: ${entry.name}`);
    names.add(entry.name);
  }
}

function cloneKeyboardManifest(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) throw new TypeError("UI manifest keyboard must be a plain object.");
  const output: Record<string, string> = {};
  for (const [key, description] of Object.entries(value)) {
    output[requireManifestText(key, "keyboard key")] = requireManifestText(description, "keyboard description");
  }
  return Object.freeze(output);
}

function cloneSerializableRecord(value: Readonly<Record<string, unknown>>, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`UI manifest ${label} must be a plain object.`);
  const seen = new Set<unknown>();
  const clone = (entry: unknown, path: string): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError(`UI manifest ${path} must contain finite numbers.`);
      return entry;
    }
    if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new TypeError(`UI manifest ${path} cannot be circular.`);
      seen.add(entry);
      const output = Object.freeze(entry.map((item, index) => clone(item, `${path}[${index}]`)));
      seen.delete(entry);
      return output;
    }
    if (isPlainRecord(entry)) {
      if (seen.has(entry)) throw new TypeError(`UI manifest ${path} cannot be circular.`);
      seen.add(entry);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(entry)) output[key] = clone(item, `${path}.${key}`);
      seen.delete(entry);
      return Object.freeze(output);
    }
    throw new TypeError(`UI manifest ${path} is not serializable.`);
  };
  return clone(value, label) as Record<string, unknown>;
}

function readAttribute(target: unknown, name: string): string | null {
  if (!target || typeof (target as { getAttribute?: unknown }).getAttribute !== "function") return null;
  return (target as { getAttribute(name: string): string | null }).getAttribute(name);
}

function parentElementOrHost(target: unknown): unknown {
  const candidate = target as { parentElement?: unknown; parentNode?: unknown; host?: unknown; getRootNode?: () => unknown };
  if (candidate?.parentElement) return candidate.parentElement;
  if (candidate?.parentNode) return candidate.parentNode;
  if (candidate?.host) return candidate.host;
  const root = candidate?.getRootNode?.() as { host?: unknown } | undefined;
  return root?.host ?? null;
}

function parentNodeOrHost(target: unknown): unknown {
  const candidate = target as { assignedSlot?: unknown; parentNode?: unknown; host?: unknown; getRootNode?: () => unknown };
  if (candidate?.assignedSlot) return candidate.assignedSlot;
  if (candidate?.parentNode) return candidate.parentNode;
  if (candidate?.host) return candidate.host;
  const root = candidate?.getRootNode?.() as { host?: unknown } | undefined;
  return root?.host ?? null;
}

function isElementLike(value: unknown): value is Element {
  return Boolean(value && typeof value === "object" && typeof (value as Element).matches === "function");
}

function isParentNodeLike(value: unknown): value is ParentNode {
  return Boolean(value && typeof value === "object" && typeof (value as ParentNode).querySelectorAll === "function");
}

function hasAttribute(element: Element, name: string): boolean {
  return typeof element.hasAttribute === "function" && element.hasAttribute(name);
}

function elementName(element: Element): string {
  return String(element.localName ?? element.tagName ?? "").toLowerCase();
}

function readTabIndex(element: Element): number {
  const raw = readAttribute(element, "tabindex");
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : -1;
  }
  const native = (element as HTMLElement).tabIndex;
  if (typeof native === "number") return native;
  return isNaturallyTabbable(element) ? 0 : -1;
}

function isNaturallyTabbable(element: Element): boolean {
  const name = elementName(element);
  if (name === "a" || name === "area") return hasAttribute(element, "href");
  if (["button", "select", "textarea", "iframe", "object", "embed", "summary"].includes(name)) return true;
  if (name === "input") return String((element as HTMLInputElement).type ?? readAttribute(element, "type") ?? "").toLowerCase() !== "hidden";
  if (name === "audio" || name === "video") return hasAttribute(element, "controls");
  const editable = readAttribute(element, "contenteditable");
  return editable !== null && editable !== "false";
}

function isFocusableKind(element: Element): boolean {
  return hasAttribute(element, "tabindex") || isNaturallyTabbable(element);
}

function isUnavailable(element: Element): boolean {
  const name = elementName(element);
  if ((element as HTMLButtonElement).disabled || hasAttribute(element, "disabled")) return true;
  if (readAttribute(element, "aria-disabled") === "true") return true;
  if (name === "input" && String((element as HTMLInputElement).type ?? readAttribute(element, "type") ?? "").toLowerCase() === "hidden") return true;
  if (isInsideDisabledFieldset(element)) return true;

  let current: unknown = element;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (hasAttribute(current as Element, "hidden") || hasAttribute(current as Element, "inert")) return true;
    if (readAttribute(current, "aria-hidden") === "true") return true;
    if (elementName(current as Element) === "details" && !hasAttribute(current as Element, "open")) {
      const summary = typeof (current as Element).querySelector === "function"
        ? (current as Element).querySelector(":scope > summary")
        : null;
      if (summary !== element && !(typeof summary?.contains === "function" && summary.contains(element))) return true;
    }
    current = parentElementOrHost(current);
  }

  const document = getOwnerDocument(element);
  const view = document?.defaultView;
  if (typeof view?.getComputedStyle === "function") {
    try {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden") {
        return true;
      }
    } catch {
      // Cross-document style access is allowed to fail closed over native checks.
    }
  }
  return false;
}

function isInsideDisabledFieldset(element: Element): boolean {
  let current = element.parentElement;
  while (current) {
    if (elementName(current) === "fieldset" && ((current as HTMLFieldSetElement).disabled || hasAttribute(current, "disabled"))) {
      const firstLegend = typeof current.querySelector === "function" ? current.querySelector(":scope > legend") : null;
      if (!firstLegend || !(firstLegend === element || firstLegend.contains(element))) return true;
    }
    current = current.parentElement;
  }
  return false;
}

function seekEnabled<Item>(
  items: readonly Item[],
  start: number,
  direction: -1 | 1,
  disabled: (item: Item, index: number) => boolean,
): number {
  for (let index = start; index >= 0 && index < items.length; index += direction) {
    if (!disabled(items[index]!, index)) return index;
  }
  return -1;
}

function defaultDisabled<Item>(item: Item): boolean {
  return Boolean(item && typeof item === "object" && (item as { disabled?: boolean }).disabled);
}

function defaultTextValue<Item>(item: Item): string {
  if (item && typeof item === "object" && "textValue" in item) return String((item as { textValue?: unknown }).textValue ?? "");
  return String(item ?? "");
}

function normalizeSearchText(value: string): string {
  return String(value).trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function isPrintableKey(key: string): boolean {
  return typeof key === "string" && [...key].length === 1 && key >= " ";
}
