import { computed, effect, signal, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";

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
  trigger(options?: { id?: string; agentId?: string; agentLabel?: string }): Record<string, unknown>;
  panel(options?: { id?: string; role?: string; labelledBy?: string }): Record<string, unknown>;
}

/** Headless state and accessible props for accordions, menus, drawers, and expandable regions. */
export function createDisclosure(options: DisclosureOptions): DisclosureController {
  const id = requireId(options.id, "Disclosure");
  const open = signal(Boolean(options.initialOpen), { name: `${id}.open` });
  const disabled = computed(
    () => typeof options.disabled === "function" ? options.disabled() : Boolean(options.disabled),
    { name: `${id}.disabled` },
  );
  const set = (next: boolean) => {
    if (disabled.peek() || open.peek() === next) return;
    open.value = next;
    options.onChange?.(next);
  };
  const controller: DisclosureController = {
    id,
    open,
    disabled,
    show: () => set(true),
    hide: () => set(false),
    toggle: () => set(!open.peek()),
    trigger(triggerOptions = {}) {
      return {
        id: triggerOptions.id ?? `${id}-trigger`,
        type: "button",
        "aria-controls": id,
        "aria-expanded": () => open.value,
        disabled: () => disabled.value,
        ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
        ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
        onClick: () => controller.toggle(),
      };
    },
    panel(panelOptions = {}) {
      return {
        id: panelOptions.id ?? id,
        ...(panelOptions.role ? { role: panelOptions.role } : {}),
        "aria-labelledby": panelOptions.labelledBy ?? `${id}-trigger`,
        hidden: () => !open.value,
      };
    },
  };
  return controller;
}

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
  trigger(options?: { id?: string; agentId?: string; agentLabel?: string }): Record<string, unknown>;
  dialog(options?: { labelledBy?: string; describedBy?: string }): Record<string, unknown>;
  backdrop(): Record<string, unknown>;
  title(): Record<string, unknown>;
  description(): Record<string, unknown>;
}

let scrollLocks = 0;
let originalBodyOverflow = "";

/** Accessible modal-dialog behavior with focus trapping, Escape handling, and focus restoration. */
export function createDialog(options: DialogOptions): DialogController {
  const id = requireId(options.id, "Dialog");
  const disclosure = createDisclosure({
    id,
    initialOpen: options.initialOpen,
    onChange: options.onChange,
  });
  let trigger: HTMLElement | null = null;
  const show = (source?: HTMLElement | null) => {
    if (source) trigger = source;
    disclosure.show();
  };
  const hide = () => disclosure.hide();
  const controller: DialogController = {
    id,
    open: disclosure.open,
    show,
    hide,
    toggle(source) {
      if (disclosure.open.peek()) hide();
      else show(source);
    },
    trigger(triggerOptions = {}) {
      return {
        id: triggerOptions.id ?? `${id}-trigger`,
        type: "button",
        "aria-haspopup": "dialog",
        "aria-controls": id,
        "aria-expanded": () => disclosure.open.value,
        ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
        ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
        onClick: (event: Event) => show(event.currentTarget as HTMLElement),
      };
    },
    dialog(dialogOptions = {}) {
      return {
        id,
        role: "dialog",
        tabIndex: -1,
        "aria-modal": true,
        "aria-labelledby": dialogOptions.labelledBy ?? `${id}-title`,
        "aria-describedby": dialogOptions.describedBy ?? `${id}-description`,
        hidden: () => !disclosure.open.value,
        use: dialogDirective(
          disclosure.open,
          hide,
          () => trigger,
          {
            closeOnEscape: options.closeOnEscape !== false,
            restoreFocus: options.restoreFocus !== false,
            lockScroll: options.lockScroll !== false,
          },
        ),
      };
    },
    backdrop() {
      return {
        hidden: () => !disclosure.open.value,
        "aria-hidden": true,
        onPointerDown: (event: PointerEvent) => {
          if (options.closeOnBackdrop !== false && event.target === event.currentTarget) hide();
        },
      };
    },
    title: () => ({ id: `${id}-title` }),
    description: () => ({ id: `${id}-description` }),
  };
  return controller;
}

function dialogDirective(
  open: ReactiveSignal<boolean>,
  hide: () => void,
  trigger: () => HTMLElement | null,
  options: { closeOnEscape: boolean; restoreFocus: boolean; lockScroll: boolean },
): (element: Element) => Cleanup {
  return (node) => {
    const element = node as HTMLElement;
    let active = false;
    let previousFocus: HTMLElement | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && options.closeOnEscape) {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(element);
      if (focusable.length === 0) {
        event.preventDefault();
        element.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const current = element.ownerDocument.activeElement;
      if (event.shiftKey && (current === first || current === element)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const deactivate = () => {
      if (!active) return;
      active = false;
      element.ownerDocument.removeEventListener("keydown", onKeyDown, true);
      if (options.lockScroll) unlockBodyScroll(element.ownerDocument);
      if (options.restoreFocus) queueMicrotask(() => {
        const target = trigger() ?? previousFocus;
        if (target?.isConnected && !target.hasAttribute("disabled")) target.focus();
      });
    };
    const stop = effect(() => {
      if (!open.value) {
        deactivate();
        return;
      }
      if (active) return;
      active = true;
      previousFocus = element.ownerDocument.activeElement as HTMLElement | null;
      element.ownerDocument.addEventListener("keydown", onKeyDown, true);
      if (options.lockScroll) lockBodyScroll(element.ownerDocument);
      queueMicrotask(() => {
        if (!open.peek()) return;
        (focusableElements(element)[0] ?? element).focus();
      });
    });
    return () => {
      stop();
      deactivate();
    };
  };
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
    "[contenteditable=true]",
  ].join(",");
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) =>
    !element.hasAttribute("hidden")
    && element.getAttribute("aria-hidden") !== "true"
    && element.getAttribute("aria-disabled") !== "true"
  );
}

function lockBodyScroll(document: Document): void {
  if (scrollLocks++ === 0) {
    originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockBodyScroll(document: Document): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = originalBodyOverflow;
}

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
export function createTabs<Value extends string>(options: TabsOptions<Value>): TabsController<Value> {
  const id = requireId(options.id, "Tabs");
  const tabs = [...options.tabs];
  if (tabs.length === 0) throw new TypeError("createTabs requires at least one tab.");
  if (new Set(tabs.map((tab) => tab.value)).size !== tabs.length) throw new TypeError("Tab values must be unique.");
  if (new Set(tabs.map((tab) => safeToken(tab.value))).size !== tabs.length) {
    throw new TypeError("Tab values must produce unique DOM-safe IDs.");
  }
  const enabled = tabs.filter((tab) => !tab.disabled);
  if (enabled.length === 0) throw new TypeError("createTabs requires at least one enabled tab.");
  const initial = options.initial && enabled.some((tab) => tab.value === options.initial)
    ? options.initial
    : enabled[0]!.value;
  const selected = signal<Value>(initial, { name: `${id}.selected` });
  const select = (value: Value) => {
    const tab = tabs.find((entry) => entry.value === value);
    if (!tab || tab.disabled || selected.peek() === value) return;
    selected.value = value;
    options.onChange?.(value);
  };
  const focus = (element: HTMLElement, value: Value) => {
    const target = element.ownerDocument.getElementById(tabId(id, value));
    target?.focus();
  };
  const move = (element: HTMLElement, current: Value, direction: -1 | 1) => {
    const index = enabled.findIndex((tab) => tab.value === current);
    const next = enabled[(index + direction + enabled.length) % enabled.length]!.value;
    focus(element, next);
    if ((options.activation ?? "automatic") === "automatic") select(next);
  };
  return {
    id,
    selected,
    select,
    list: () => ({
      role: "tablist",
      "aria-orientation": options.orientation ?? "horizontal",
    }),
    tab(value) {
      const definition = tabs.find((tab) => tab.value === value);
      if (!definition) throw new TypeError(`Unknown tab: ${value}`);
      return {
        id: tabId(id, value),
        type: "button",
        role: "tab",
        disabled: Boolean(definition.disabled),
        "aria-selected": () => selected.value === value,
        "aria-controls": panelId(id, value),
        tabIndex: () => selected.value === value ? 0 : -1,
        onClick: () => select(value),
        onKeyDown: (event: KeyboardEvent) => {
          const horizontal = (options.orientation ?? "horizontal") === "horizontal";
          if ((horizontal && event.key === "ArrowRight") || (!horizontal && event.key === "ArrowDown")) {
            event.preventDefault();
            move(event.currentTarget as HTMLElement, value, 1);
          } else if ((horizontal && event.key === "ArrowLeft") || (!horizontal && event.key === "ArrowUp")) {
            event.preventDefault();
            move(event.currentTarget as HTMLElement, value, -1);
          } else if (event.key === "Home") {
            event.preventDefault();
            focus(event.currentTarget as HTMLElement, enabled[0]!.value);
            if ((options.activation ?? "automatic") === "automatic") select(enabled[0]!.value);
          } else if (event.key === "End") {
            event.preventDefault();
            focus(event.currentTarget as HTMLElement, enabled.at(-1)!.value);
            if ((options.activation ?? "automatic") === "automatic") select(enabled.at(-1)!.value);
          } else if ((event.key === "Enter" || event.key === " ") && options.activation === "manual") {
            event.preventDefault();
            select(value);
          }
        },
      };
    },
    panel(value) {
      if (!tabs.some((tab) => tab.value === value)) throw new TypeError(`Unknown tab: ${value}`);
      return {
        id: panelId(id, value),
        role: "tabpanel",
        tabIndex: 0,
        "aria-labelledby": tabId(id, value),
        hidden: () => selected.value !== value,
      };
    },
  };
}

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
export function createPagination(options: PaginationOptions): PaginationController {
  const pageSize = signal(positiveInteger(options.pageSize ?? 20, "pageSize"));
  const page = signal(positiveInteger(options.initialPage ?? 1, "initialPage"));
  const total = computed(() => {
    const value = readReactiveNumber(options.total);
    if (!Number.isFinite(value)) throw new TypeError("Pagination total must be a finite number.");
    return Math.max(0, Math.floor(value));
  }, { name: "pagination.total" });
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)), { name: "pagination.pageCount" });
  const start = computed(() => total.value === 0 ? 0 : (page.value - 1) * pageSize.value + 1);
  const end = computed(() => Math.min(total.value, page.value * pageSize.value));
  const canPrevious = computed(() => page.value > 1);
  const canNext = computed(() => page.value < pageCount.value);
  const siblingCount = Math.max(0, Math.floor(options.siblingCount ?? 1));
  const pages = computed(() => pageItems(page.value, pageCount.value, siblingCount));
  const setPage = (next: number) => {
    if (!Number.isFinite(next)) throw new TypeError("Page must be a finite number.");
    page.value = Math.min(pageCount.peek(), Math.max(1, Math.floor(next)));
  };
  const stop = effect(() => {
    const maximum = pageCount.value;
    if (page.peek() > maximum) page.value = maximum;
  });
  return {
    page,
    pageSize,
    total,
    pageCount,
    start,
    end,
    canPrevious,
    canNext,
    pages,
    setPage,
    setPageSize(size) {
      pageSize.value = positiveInteger(size, "pageSize");
      setPage(1);
    },
    previous: () => setPage(page.peek() - 1),
    next: () => setPage(page.peek() + 1),
    dispose: stop,
  };
}

/** A directive that invokes a handler for pointer activity outside its element. */
export function clickOutside(
  handler: (event: PointerEvent) => void,
): (element: Element) => Cleanup {
  return (element) => {
    const document = element.ownerDocument;
    const listener = (event: PointerEvent) => {
      const target = event.target;
      const NodeType = document.defaultView?.Node;
      if (NodeType && target instanceof NodeType && !element.contains(target)) handler(event);
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  };
}

/** A directive that focuses an element after it has been mounted. */
export function autoFocus(element: Element): Cleanup {
  let active = true;
  queueMicrotask(() => {
    if (active && element.isConnected) (element as HTMLElement).focus();
  });
  return () => { active = false; };
}

function pageItems(current: number, count: number, siblings: number): Array<number | "ellipsis"> {
  if (count <= 2 * siblings + 5) return Array.from({ length: count }, (_, index) => index + 1);
  const values = new Set([1, count]);
  for (let value = current - siblings; value <= current + siblings; value++) {
    if (value > 1 && value < count) values.add(value);
  }
  const ordered = [...values].sort((left, right) => left - right);
  const output: Array<number | "ellipsis"> = [];
  for (const value of ordered) {
    const previous = output.at(-1);
    if (typeof previous === "number" && value - previous > 1) output.push("ellipsis");
    output.push(value);
  }
  return output;
}

function readReactiveNumber(
  input: number | ReactiveSignal<number> | Computed<number> | (() => number),
): number {
  if (typeof input === "function") return input();
  if (typeof input === "number") return input;
  return input.value;
}

function requireId(value: string, kind: string): string {
  const id = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new TypeError(`${kind} id must start with a letter and contain only letters, numbers, _, ., :, or -.`);
  }
  return id;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function tabId(id: string, value: string): string {
  return `${id}-tab-${safeToken(value)}`;
}

function panelId(id: string, value: string): string {
  return `${id}-panel-${safeToken(value)}`;
}

function safeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]+/g, "-");
  if (!token) throw new TypeError("UI control values must contain a letter or number.");
  return token;
}
