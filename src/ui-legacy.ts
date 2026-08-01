import {
  computed,
  effect,
  signal,
  type Cleanup,
  type Computed,
  type ReactiveSignal,
} from "./core.ts";
import { createUiManifest, type UiManifest } from "./ui-foundation.ts";

/** Compatibility options for Clank's original disclosure controller. */
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

/**
 * Clank's original disclosure API. New applications can use createCollapsible;
 * this adapter remains intentionally stable for existing applications.
 */
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
        "aria-controls": triggerOptions.controls ?? `${id}-panel`,
        "aria-expanded": () => open.value,
        disabled: () => disabled.value,
        "data-clank-part": "trigger",
        "data-open": () => open.value ? "" : undefined,
        "data-closed": () => open.value ? undefined : "",
        ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
        ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
        onClick: (event?: Event) => {
          if (!event?.defaultPrevented) controller.toggle();
        },
      };
    },
    panel(panelOptions = {}) {
      return {
        id: panelOptions.id ?? `${id}-panel`,
        ...(panelOptions.role ? { role: panelOptions.role } : {}),
        "aria-labelledby": panelOptions.labelledBy ?? `${id}-trigger`,
        hidden: () => !open.value,
        "data-clank-part": "panel",
        "data-open": () => open.value ? "" : undefined,
        "data-closed": () => open.value ? undefined : "",
      };
    },
  };
  return controller;
}

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

/** Pagination state with clamping and a compact, UI-ready page range. */
export function createPagination(options: PaginationOptions): PaginationController {
  const id = requireId(options.id ?? "pagination", "Pagination");
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
    id,
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
    root: (rootOptions = {}) => ({
      id,
      role: "navigation",
      "aria-label": rootOptions.label ?? "Pagination",
      "data-clank-part": "root",
    }),
    status: () => ({
      id: `${id}-status`,
      role: "status",
      "aria-live": "polite",
      "aria-atomic": true,
      "data-clank-part": "status",
      children: () => total.value === 0
        ? "No results"
        : `${start.value}–${end.value} of ${total.value}`,
    }),
    previousButton: () => ({
      type: "button",
      disabled: () => !canPrevious.value,
      "aria-label": "Previous page",
      "aria-controls": `${id}-status`,
      "data-clank-part": "previous",
      onClick: (event: Event) => { if (!event.defaultPrevented) setPage(page.peek() - 1); },
    }),
    pageButton: (value: number) => {
      if (!Number.isInteger(value) || value < 1) throw new TypeError("Pagination page button requires a positive integer.");
      return {
        type: "button",
        "aria-label": `Page ${value}`,
        "aria-current": () => page.value === value ? "page" : undefined,
        "aria-controls": `${id}-status`,
        "data-clank-part": "page",
        "data-selected": () => page.value === value ? "" : undefined,
        onClick: (event: Event) => { if (!event.defaultPrevented) setPage(value); },
      };
    },
    ellipsis: () => ({
      "aria-hidden": true,
      "data-clank-part": "ellipsis",
    }),
    nextButton: () => ({
      type: "button",
      disabled: () => !canNext.value,
      "aria-label": "Next page",
      "aria-controls": `${id}-status`,
      "data-clank-part": "next",
      onClick: (event: Event) => { if (!event.defaultPrevented) setPage(page.peek() + 1); },
    }),
    pageSizeSelect: () => ({
      id: `${id}-page-size`,
      "aria-label": "Results per page",
      value: () => String(pageSize.value),
      "data-clank-part": "page-size",
      onChange: (event: Event) => {
        const value = Number((event.currentTarget as HTMLSelectElement).value);
        pageSize.value = positiveInteger(value, "pageSize");
        setPage(1);
      },
    }),
    manifest: () => createUiManifest({
      component: "Pagination",
      id,
      state: {
        page: page.peek(),
        pageSize: pageSize.peek(),
        total: total.peek(),
        pageCount: pageCount.peek(),
      },
      parts: [
        { name: "root", role: "navigation", defaultElement: "nav", required: true },
        { name: "status", role: "status", defaultElement: "span" },
        { name: "previous", role: "button", defaultElement: "button", required: true },
        { name: "page", role: "button", defaultElement: "button", required: true },
        { name: "ellipsis", defaultElement: "span" },
        { name: "next", role: "button", defaultElement: "button", required: true },
        { name: "page-size", defaultElement: "select" },
      ],
      actions: [
        { name: "setPage", description: "Move to a specific result page.", sideEffects: "write", reasons: ["press", "programmatic"] },
        { name: "setPageSize", description: "Change the result count per page and return to page one.", sideEffects: "write", reasons: ["input", "programmatic"] },
        { name: "previous", description: "Move to the previous result page.", sideEffects: "write", reasons: ["press"] },
        { name: "next", description: "Move to the next result page.", sideEffects: "write", reasons: ["press"] },
      ],
      keyboard: { Enter: "Activate the focused page control", Space: "Activate the focused page control" },
    }),
    dispose: stop,
  };
}

/** A directive that invokes a handler for primary pointer activity outside its element. */
export function clickOutside(
  handler: (event: PointerEvent) => void,
): (element: Element) => Cleanup {
  return (element) => {
    const document = element.ownerDocument;
    const listener = (event: PointerEvent) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(element)) return;
      const target = event.target;
      const NodeType = document.defaultView?.Node;
      if (!NodeType || !(target instanceof NodeType) || !element.contains(target)) handler(event);
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  };
}

/** A directive that focuses an element after it has been mounted. */
export function autoFocus(element: Element): Cleanup {
  let active = true;
  queueMicrotask(() => {
    if (active && element.isConnected && "focus" in element) (element as HTMLElement).focus();
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
