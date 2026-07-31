import { computed, effect, signal, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";
import {
  createChangeDetails,
  createControllableState,
  createTypeahead,
  createUiManifest,
  findCollectionIndex,
  focusFirst,
  getCollectionNavigationIntent,
  mergeProps,
  resolveDirection,
  type ChangeDetails,
  type Direction,
  type Orientation,
  type UiManifest,
} from "./ui-foundation.ts";
import {
  createPopover,
  type OpenChangeReason,
  type PopupOptions,
  type PopupPortalOptions,
} from "./ui-popups.ts";
import { useDirection } from "./ui-composition.ts";

/** A static value or an SSR-safe reactive getter. */
export type CollectionReadable<Value> = Value | (() => Value);

export interface CollectionAgentPartOptions {
  agentId?: string;
  agentLabel?: string;
  agentDescription?: string;
}

export interface CollectionItemDefinition<Value extends string> {
  value: Value;
  textValue: string;
  disabled?: CollectionReadable<boolean>;
}

export type AccordionChangeReason = "trigger-press" | "beforematch" | "programmatic" | "reset";

export interface AccordionPanelOptions {
  /** Keep a closed panel mounted and hidden. */
  keepMounted?: boolean;
  /** Keep a closed panel searchable with HTML `hidden="until-found"`. */
  hiddenUntilFound?: boolean;
}

interface AccordionCommonOptions<Value extends string> {
  id: string;
  items: readonly CollectionItemDefinition<Value>[];
  disabled?: CollectionReadable<boolean>;
  /** Whether the only open item may be closed. Defaults to true. */
  collapsible?: boolean;
  /** @deprecated Prefer the per-panel `keepMounted` option. */
  keepMounted?: boolean;
}

export interface AccordionSingleOptions<Value extends string> extends AccordionCommonOptions<Value> {
  multiple?: false;
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  onValueChange?: (value: Value | null, details: ChangeDetails<AccordionChangeReason>) => void;
}

export interface AccordionMultipleOptions<Value extends string> extends AccordionCommonOptions<Value> {
  multiple: true;
  value?: readonly Value[] | (() => readonly Value[]);
  defaultValue?: readonly Value[];
  onValueChange?: (value: readonly Value[], details: ChangeDetails<AccordionChangeReason>) => void;
}

export interface AccordionController<Value extends string> {
  readonly id: string;
  readonly multiple: boolean;
  readonly value: Computed<Value | null | readonly Value[]>;
  setValue(value: Value | null | readonly Value[], reason?: AccordionChangeReason, event?: Event): boolean;
  toggle(value: Value, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  item(value: Value): Record<string, unknown>;
  header(value: Value, level?: number): Record<string, unknown>;
  trigger(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  /** Tells a renderer whether a panel belongs in the tree. Closed panels mount only when requested. */
  isPanelMounted(value: Value, options?: AccordionPanelOptions): boolean;
  panel(value: Value, options?: AccordionPanelOptions): Record<string, unknown>;
  manifest(): UiManifest;
}

/**
 * A native-disclosure accordion. Triggers remain in the document's normal Tab
 * sequence; arrow-key trigger navigation is intentionally not added because it
 * is no longer part of the current accordion APG pattern.
 */
export function createAccordion<Value extends string>(
  options: AccordionSingleOptions<Value> | AccordionMultipleOptions<Value>,
): AccordionController<Value> {
  const id = requireId(options.id, "Accordion");
  const items = normalizeCollection(options.items, "Accordion");
  const multiple = options.multiple === true;
  const initial = multiple
    ? normalizeValues((options as AccordionMultipleOptions<Value>).defaultValue ?? [], items, "Accordion defaultValue")
    : normalizeNullableValue((options as AccordionSingleOptions<Value>).defaultValue ?? null, items, "Accordion defaultValue");
  const hasControlledValue = Object.prototype.hasOwnProperty.call(options, "value");
  const state = createControllableState<Value | null | readonly Value[], AccordionChangeReason>({
    ...(hasControlledValue ? {
      value: () => multiple
        ? normalizeValues(readValue((options as AccordionMultipleOptions<Value>).value as CollectionReadable<readonly Value[]>), items, "Accordion value")
        : normalizeNullableValue(readValue((options as AccordionSingleOptions<Value>).value as CollectionReadable<Value | null>), items, "Accordion value"),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange as ((value: Value | null | readonly Value[], details: ChangeDetails<AccordionChangeReason>) => void) | undefined,
    equals: accordionValuesEqual,
    name: `${id}.value`,
  });
  const definition = (value: Value) => requireDefinition(items, value, "Accordion");
  const disabled = () => readBoolean(options.disabled);
  const itemDisabled = (value: Value) => disabled() || readBoolean(definition(value).disabled);
  const open = (value: Value) => multiple
    ? (state.value.value as readonly Value[]).includes(value)
    : state.value.value === value;
  const normalize = (value: Value | null | readonly Value[]) => multiple
    ? normalizeValues(Array.isArray(value) ? value : value === null ? [] : [value], items, "Accordion value")
    : normalizeNullableValue(Array.isArray(value) ? value[0] ?? null : value, items, "Accordion value");
  const setValue = (value: Value | null | readonly Value[], reason: AccordionChangeReason = "programmatic", event?: Event) =>
    disabled() ? false : state.set(normalize(value), reason, event);
  const toggle = (value: Value, event?: Event) => {
    definition(value);
    if (itemDisabled(value)) return false;
    if (multiple) {
      const current = state.value.peek() as readonly Value[];
      return state.set(
        current.includes(value) ? current.filter((entry) => entry !== value) : collectionOrder([...current, value], items),
        "trigger-press",
        event,
      );
    }
    if (state.value.peek() === value) {
      return options.collapsible === false ? false : state.set(null, "trigger-press", event);
    }
    return state.set(value, "trigger-press", event);
  };
  const panelMounted = (value: Value, panelOptions: AccordionPanelOptions = {}) => {
    definition(value);
    return open(value) || panelOptions.hiddenUntilFound === true || (panelOptions.keepMounted ?? options.keepMounted) === true;
  };
  const revealFromFind = (value: Value, event: Event) => {
    if (event.defaultPrevented || open(value) || itemDisabled(value)) return false;
    if (multiple) {
      const current = state.value.peek() as readonly Value[];
      return state.set(collectionOrder([...current, value], items), "beforematch", event);
    }
    return state.set(value, "beforematch", event);
  };
  return {
    id,
    multiple,
    value: state.value,
    setValue,
    toggle,
    reset: (event) => disabled() ? false : state.set(initial, "reset", event),
    root: () => ({
      id,
      "data-orientation": "vertical",
      "data-disabled": () => disabled() ? "" : undefined,
      "data-clank-part": "root",
    }),
    item(value) {
      definition(value);
      return {
        id: itemId(id, items, value),
        "data-open": () => open(value) ? "" : undefined,
        "data-closed": () => open(value) ? undefined : "",
        "data-disabled": () => itemDisabled(value) ? "" : undefined,
        "data-clank-part": "item",
      };
    },
    header(value, level) {
      definition(value);
      return {
        ...(level === undefined ? {} : { role: "heading", "aria-level": requireHeadingLevel(level) }),
        "data-open": () => open(value) ? "" : undefined,
        "data-closed": () => open(value) ? undefined : "",
        "data-clank-part": "header",
      };
    },
    trigger(value, partOptions = {}) {
      definition(value);
      return {
        id: `${itemId(id, items, value)}-trigger`,
        type: "button",
        "aria-controls": `${itemId(id, items, value)}-panel`,
        "aria-expanded": () => open(value),
        disabled: () => itemDisabled(value),
        "data-open": () => open(value) ? "" : undefined,
        "data-closed": () => open(value) ? undefined : "",
        "data-disabled": () => itemDisabled(value) ? "" : undefined,
        "data-clank-part": "trigger",
        ...agentProps(partOptions),
        onClick: (event: Event) => {
          if (!event.defaultPrevented) toggle(value, event);
        },
        onKeyDown: (event: KeyboardEvent) => activateCustomButton(event, () => itemDisabled(value), () => toggle(value, event)),
      };
    },
    isPanelMounted: panelMounted,
    panel(value, panelOptions = {}) {
      definition(value);
      const hiddenUntilFound = panelOptions.hiddenUntilFound === true;
      return {
        id: `${itemId(id, items, value)}-panel`,
        role: "region",
        "aria-labelledby": `${itemId(id, items, value)}-trigger`,
        hidden: () => open(value) ? false : hiddenUntilFound ? "until-found" : true,
        "data-open": () => open(value) ? "" : undefined,
        "data-closed": () => open(value) ? undefined : "",
        "data-mounted": () => panelMounted(value, panelOptions) ? "" : undefined,
        "data-clank-part": "panel",
        ...(hiddenUntilFound ? { onBeforeMatch: (event: Event) => { revealFromFind(value, event); } } : {}),
      };
    },
    manifest: () => createUiManifest({
      component: "Accordion",
      id,
      state: {
        multiple,
        value: Array.isArray(state.value.peek()) ? [...state.value.peek() as readonly Value[]] : state.value.peek(),
        disabled: disabled(),
        collapsible: options.collapsible !== false,
        keepMounted: options.keepMounted === true,
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "item", defaultElement: "div", required: true },
        { name: "header", defaultElement: "h3", required: true },
        { name: "trigger", role: "button", defaultElement: "button", required: true },
        { name: "panel", role: "region", defaultElement: "div", required: true },
      ],
      actions: [
        { name: "setValue", description: "Replace the open accordion value or values.", sideEffects: "write", reasons: ["programmatic"] },
        { name: "toggle", description: "Toggle one accordion item.", sideEffects: "write", reasons: ["trigger-press", "beforematch"] },
        { name: "reset", description: "Restore the default open items.", sideEffects: "write", reasons: ["reset"] },
      ],
      keyboard: { Tab: "Move through triggers in normal document order", Enter: "Toggle the focused trigger", Space: "Toggle the focused trigger" },
    }),
  };
}

export type TabsChangeReason = "tab-press" | "keyboard" | "programmatic" | "reset" | "initial" | "disabled" | "missing";
export type TabsActivationMode = "manual" | "automatic";

export interface TabsPanelOptions {
  /** Keep an inactive panel mounted and hidden. */
  keepMounted?: boolean;
}

export interface TabsOptions<Value extends string> {
  id: string;
  items?: readonly CollectionItemDefinition<Value>[];
  /** @deprecated Use items with an explicit textValue. */
  tabs?: readonly (Omit<CollectionItemDefinition<Value>, "textValue"> & { textValue?: string })[];
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  /** @deprecated Use defaultValue. */
  initial?: Value;
  orientation?: Orientation;
  direction?: Direction | "auto";
  activationMode?: TabsActivationMode;
  /** @deprecated Use activationMode. */
  activation?: TabsActivationMode;
  loop?: boolean;
  onValueChange?: (value: Value | null, details: ChangeDetails<TabsChangeReason>) => void;
  /** @deprecated Use onValueChange. */
  onChange?: (value: Value | null) => void;
}

export interface TabsController<Value extends string> {
  readonly id: string;
  readonly value: Computed<Value | null>;
  /** @deprecated Use value. */
  readonly selected: Computed<Value | null>;
  readonly focusedValue: Computed<Value>;
  select(value: Value | null, reason?: TabsChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  list(options?: { label?: string; labelledBy?: string }): Record<string, unknown>;
  tab(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  /** Tells a renderer whether the panel belongs in the tree. */
  isPanelMounted(value: Value, options?: TabsPanelOptions): boolean;
  panel(value: Value, options?: TabsPanelOptions): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/** Roving, controlled/uncontrolled tabs with manual activation by default. */
export function createTabs<Value extends string>(options: TabsOptions<Value>): TabsController<Value> {
  const id = requireId(options.id, "Tabs");
  const direction = options.direction ?? useDirection();
  const legacy = options.items === undefined && options.tabs !== undefined;
  const definitions = options.items ?? options.tabs?.map((item) => ({
    ...item,
    textValue: item.textValue ?? String(item.value),
  })) ?? [];
  const items = normalizeCollection(definitions, "Tabs");
  const controlled = Object.prototype.hasOwnProperty.call(options, "value");
  const firstEnabledValue = (candidates: readonly CollectionItemDefinition<Value>[] = items): Value | null =>
    candidates.find((item) => !readBoolean(item.disabled))?.value ?? null;
  const hasExplicitDefault = options.defaultValue !== undefined || options.initial !== undefined;
  const requestedInitial = options.defaultValue !== undefined
    ? options.defaultValue
    : options.initial !== undefined
      ? options.initial
      : firstEnabledValue();
  const requestedDefinition = requestedInitial === null
    ? undefined
    : items.find((item) => item.value === requestedInitial);
  let initialReason: Extract<TabsChangeReason, "initial" | "disabled" | "missing"> | undefined;
  let initial: Value | null;
  if (!hasExplicitDefault) {
    initial = firstEnabledValue();
    initialReason = "initial";
  } else if (requestedInitial === null) {
    initial = null;
  } else if (!requestedDefinition) {
    initial = firstEnabledValue();
    initialReason = "missing";
  } else if (readBoolean(requestedDefinition.disabled)) {
    initial = firstEnabledValue();
    initialReason = "disabled";
  } else {
    initial = requestedInitial;
  }
  const internalValue = signal<Value | null>(initial, { name: `${id}.value.uncontrolled` });
  const value = computed<Value | null>(() => {
    if (!controlled) return internalValue.value;
    const controlledValue = readValue(options.value as CollectionReadable<Value | null>);
    return controlledValue === undefined ? null : controlledValue;
  }, { name: `${id}.value` });
  const notifyAutomatic = (
    next: Value | null,
    reason: Extract<TabsChangeReason, "initial" | "disabled" | "missing">,
    force = false,
  ) => {
    if (controlled || (!force && Object.is(value.peek(), next))) return false;
    const details = Object.freeze({
      reason,
      canceled: false,
      cancel() { /* Automatic Tabs fallbacks are intentionally not cancelable. */ },
    }) satisfies ChangeDetails<TabsChangeReason>;
    options.onValueChange?.(next, details);
    options.onChange?.(next);
    const changed = !Object.is(internalValue.peek(), next);
    internalValue.value = next;
    return changed || force;
  };
  const requestValue = (next: Value | null, reason: TabsChangeReason, event?: Event) => {
    if (Object.is(value.peek(), next)) return false;
    const details = createChangeDetails(reason, event);
    if (details.canceled) return false;
    options.onValueChange?.(next, details);
    if (details.canceled) return false;
    options.onChange?.(next);
    if (!controlled) internalValue.value = next;
    return true;
  };
  const state = { value, set: requestValue };
  const orientation = options.orientation ?? "horizontal";
  const activationMode = options.activationMode ?? options.activation ?? (legacy ? "automatic" : "manual");
  const firstFocusableIndex = Math.max(0, items.findIndex((item) => !readBoolean(item.disabled)));
  const requestedInitialIndex = state.value.peek() === null ? -1 : indexOfValue(items, state.value.peek()!);
  const initialIndex = requestedInitialIndex >= 0 ? requestedInitialIndex : firstFocusableIndex;
  const focusedIndex = signal(initialIndex, { name: `${id}.focusedIndex` });
  const focusedValue = computed(() => items[focusedIndex.value]?.value ?? items[0]!.value, { name: `${id}.focusedValue` });
  const elements = new Map<Value, HTMLElement>();
  const mountedValues = new Set<Value>();
  let listElement: HTMLElement | null = null;
  let indicatorElement: HTMLElement | null = null;
  let indicatorCleanup: Cleanup | undefined;
  let disposed = false;
  let missingCheckQueued = false;
  const definition = (value: Value) => requireDefinition(items, value, "Tabs");
  const itemDisabled = (value: Value) => readBoolean(definition(value).disabled);
  const selectedElement = () => {
    const value = state.value.peek();
    return value === null ? null : elements.get(value) ?? null;
  };
  const selectedIndex = () => {
    const value = state.value.peek();
    return value === null ? -1 : indexOfValue(items, value);
  };
  const automaticFallback = (
    reason: Extract<TabsChangeReason, "initial" | "disabled" | "missing">,
    force = false,
    mountedOnly = false,
  ) => {
    const mountedItems = mountedOnly || mountedValues.size > 0
      ? items.filter((item) => mountedValues.has(item.value))
      : items;
    const next = firstEnabledValue(mountedItems);
    const accepted = notifyAutomatic(next, reason, force);
    if (next !== null) focusedIndex.value = indexOfValue(items, next);
    syncTabsIndicator(listElement, indicatorElement, next === null ? null : elements.get(next) ?? null, items.length, next === null ? -1 : indexOfValue(items, next));
    return accepted;
  };
  const flushInitialSelection = () => {
    if (disposed || controlled || initialReason === undefined) return;
    const reason = initialReason;
    initialReason = undefined;
    automaticFallback(reason, true, listElement !== null);
  };
  const scheduleMissingCheck = () => {
    if (missingCheckQueued || controlled || disposed) return;
    missingCheckQueued = true;
    queueMicrotask(() => {
      missingCheckQueued = false;
      if (disposed || controlled) return;
      if (initialReason !== undefined) {
        flushInitialSelection();
        return;
      }
      const selected = internalValue.peek();
      if (selected !== null && (mountedValues.size > 0 || listElement !== null) && !mountedValues.has(selected)) {
        automaticFallback("missing", false, true);
      }
    });
  };
  const focus = (index: number, event?: Event) => {
    if (index < 0 || index >= items.length) return false;
    focusedIndex.value = index;
    focusValue(items[index]!.value, elements, event, tabPartId(id, items, items[index]!.value, legacy));
    if (activationMode === "automatic" && !readBoolean(items[index]!.disabled)) {
      if (state.set(items[index]!.value, "keyboard", event)) {
        initialReason = undefined;
        scheduleMissingCheck();
      }
    }
    syncTabsIndicator(listElement, indicatorElement, selectedElement(), items.length, selectedIndex());
    return true;
  };
  const select = (value: Value | null, reason: TabsChangeReason = "programmatic", event?: Event) => {
    if (value !== null) {
      definition(value);
      if (itemDisabled(value)) return false;
    }
    const changed = state.set(value, reason, event);
    if (changed) {
      initialReason = undefined;
      scheduleMissingCheck();
    }
    if (value !== null && (changed || state.value.peek() === value)) {
      focusedIndex.value = indexOfValue(items, value);
      syncTabsIndicator(listElement, indicatorElement, elements.get(value) ?? null, items.length, focusedIndex.peek());
    } else if (value === null && (changed || state.value.peek() === null)) {
      syncTabsIndicator(listElement, indicatorElement, null, items.length, -1);
    }
    return changed;
  };
  const stopDisabledFallback = controlled ? () => {} : effect(() => {
    const selected = internalValue.value;
    for (const item of items) readBoolean(item.disabled);
    if (selected !== null && itemDisabled(selected)) {
      const reason = initialReason ?? "disabled";
      initialReason = undefined;
      automaticFallback(reason, reason === "initial");
    }
  });
  if (!controlled && initialReason !== undefined) queueMicrotask(flushInitialSelection);
  return {
    id,
    value: state.value,
    selected: state.value,
    focusedValue,
    select,
    reset: (event) => select(initial, "reset", event),
    root: () => ({
      id,
      "data-orientation": orientation,
      "data-activation-mode": activationMode,
      "data-clank-part": "root",
    }),
    list(listOptions = {}) {
      return {
        id: `${id}-list`,
        role: "tablist",
        "aria-orientation": orientation,
        ...(listOptions.label ? { "aria-label": listOptions.label } : {}),
        ...(listOptions.labelledBy ? { "aria-labelledby": listOptions.labelledBy } : {}),
        "data-orientation": orientation,
        "data-clank-part": "list",
        ref: (element: HTMLElement | null) => {
          listElement = element;
          syncTabsIndicator(listElement, indicatorElement, selectedElement(), items.length, selectedIndex());
          scheduleMissingCheck();
        },
      };
    },
    tab(value, partOptions = {}) {
      definition(value);
      const index = indexOfValue(items, value);
      return {
        id: tabPartId(id, items, value, legacy),
        type: "button",
        role: "tab",
        "aria-controls": tabPanelId(id, items, value, legacy),
        "aria-selected": () => state.value.value === value,
        "aria-disabled": () => itemDisabled(value) || undefined,
        tabIndex: () => focusedIndex.value === index ? 0 : -1,
        "data-selected": () => state.value.value === value ? "" : undefined,
        "data-disabled": () => itemDisabled(value) ? "" : undefined,
        "data-orientation": orientation,
        "data-clank-part": "tab",
        ...agentProps(partOptions),
        ref: (element: HTMLElement | null) => {
          if (element) {
            elements.set(value, element);
            mountedValues.add(value);
          } else {
            elements.delete(value);
            mountedValues.delete(value);
          }
          if (state.value.peek() === value) syncTabsIndicator(listElement, indicatorElement, element, items.length, index);
          scheduleMissingCheck();
        },
        onFocus: () => { focusedIndex.value = index; },
        onClick: (event: Event) => {
          if (event.defaultPrevented) return;
          if (itemDisabled(value)) {
            event.preventDefault();
            return;
          }
          select(value, "tab-press", event);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.defaultPrevented) return;
          if ((event.key === "Enter" || event.key === " ") && activationMode === "manual") {
            activateCustomButton(event, () => itemDisabled(value), () => select(value, "keyboard", event));
            return;
          }
          const textDirection = resolveDirection(direction, event.currentTarget as Element);
          const intent = getCollectionNavigationIntent(event.key, orientation, textDirection);
          if (!intent || intent === "page-next" || intent === "page-previous") return;
          const next = findCollectionIndex(items, index, intent, { loop: options.loop !== false, disabled: () => false });
          focus(next, event);
          event.preventDefault();
        },
      };
    },
    isPanelMounted(value, panelOptions = {}) {
      definition(value);
      return state.value.value === value || panelOptions.keepMounted === true;
    },
    panel(value, panelOptions = {}) {
      definition(value);
      return {
        id: tabPanelId(id, items, value, legacy),
        role: "tabpanel",
        "aria-labelledby": tabPartId(id, items, value, legacy),
        tabIndex: 0,
        hidden: () => state.value.value !== value,
        "data-mounted": () => state.value.value === value || panelOptions.keepMounted === true ? "" : undefined,
        "data-active": () => state.value.value === value ? "" : undefined,
        "data-selected": () => state.value.value === value ? "" : undefined,
        "data-orientation": orientation,
        "data-clank-part": "panel",
      };
    },
    indicator() {
      return {
        "aria-hidden": true,
        "data-value": () => state.value.value,
        "data-orientation": orientation,
        "data-clank-part": "indicator",
        style: {
          "--clank-tabs-active-index": () => state.value.value === null ? -1 : indexOfValue(items, state.value.value),
          "--clank-tabs-count": items.length,
        },
        use(element: Element): Cleanup {
          indicatorCleanup?.();
          indicatorElement = element as HTMLElement;
          const view = element.ownerDocument?.defaultView;
          const sync = () => syncTabsIndicator(listElement, indicatorElement, selectedElement(), items.length, selectedIndex());
          sync();
          const Resize = view?.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
          const observer = Resize ? new Resize(sync) : undefined;
          if (observer) {
            if (listElement) observer.observe(listElement);
            for (const tab of elements.values()) observer.observe(tab);
          }
          view?.addEventListener?.("resize", sync);
          const cleanup = () => {
            observer?.disconnect();
            view?.removeEventListener?.("resize", sync);
            if (indicatorElement === element) indicatorElement = null;
          };
          indicatorCleanup = cleanup;
          return cleanup;
        },
      };
    },
    manifest: () => createUiManifest({
      component: "Tabs",
      id,
      state: {
        value: state.value.peek(),
        focusedValue: focusedValue.peek(),
        orientation,
        direction,
        activationMode,
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "list", role: "tablist", defaultElement: "div", required: true },
        { name: "tab", role: "tab", defaultElement: "button", required: true },
        { name: "panel", role: "tabpanel", defaultElement: "div", required: true },
        { name: "indicator", defaultElement: "span" },
      ],
      actions: [
        { name: "select", description: "Select an enabled tab.", sideEffects: "write", reasons: ["tab-press", "keyboard", "programmatic", "initial", "disabled", "missing"] },
        { name: "reset", description: "Restore the default selected tab.", sideEffects: "write", reasons: ["reset"] },
      ],
      keyboard: {
        ArrowLeft: "Move focus horizontally, respecting text direction",
        ArrowRight: "Move focus horizontally, respecting text direction",
        ArrowUp: "Move focus in a vertical tab list",
        ArrowDown: "Move focus in a vertical tab list",
        Home: "Focus the first tab",
        End: "Focus the last tab",
        Enter: "Activate a focused tab in manual mode",
        Space: "Activate a focused tab in manual mode",
      },
    }),
    dispose() {
      disposed = true;
      stopDisabledFallback();
      indicatorCleanup?.();
      elements.clear();
      mountedValues.clear();
    },
  };
}

export type MenuItemKind = "item" | "link" | "checkbox" | "radio" | "submenu";

interface MenuItemBase<Value extends string> extends CollectionItemDefinition<Value> {
  closeOnClick?: boolean;
}

export interface MenuActionItemDefinition<Value extends string> extends MenuItemBase<Value> {
  kind?: "item";
}

export interface MenuLinkItemDefinition<Value extends string> extends MenuItemBase<Value> {
  kind: "link";
  href: string;
  target?: string;
  rel?: string;
}

export interface MenuCheckboxItemDefinition<Value extends string> extends MenuItemBase<Value> {
  kind: "checkbox";
}

export interface MenuRadioItemDefinition<Value extends string> extends MenuItemBase<Value> {
  kind: "radio";
  group: string;
}

export interface MenuSubmenuItemDefinition<Value extends string> extends MenuItemBase<Value> {
  kind: "submenu";
  menu: MenuController<string>;
  /** Whether pointer movement opens this submenu. Defaults to true. */
  openOnHover?: boolean;
  /** Delay before pointer-open, in milliseconds. Defaults to 100. */
  delay?: number;
  /** Delay before pointer-leave closes the submenu, in milliseconds. Defaults to 100. */
  closeDelay?: number;
}

export type MenuItemDefinition<Value extends string> =
  | MenuActionItemDefinition<Value>
  | MenuLinkItemDefinition<Value>
  | MenuCheckboxItemDefinition<Value>
  | MenuRadioItemDefinition<Value>
  | MenuSubmenuItemDefinition<Value>;

export type MenuActionReason = "item-press" | "keyboard" | "programmatic";
export type MenuSelectionReason = "item-press" | "keyboard" | "programmatic" | "reset";
export type MenuHighlightReason = "keyboard" | "pointer" | "focus" | "programmatic";

export type MenuOptions<Value extends string> = Omit<PopupOptions, "id" | "modal" | "initialFocus" | "onOpenChange"> & {
  id: string;
  items: readonly MenuItemDefinition<Value>[];
  label?: string;
  labelledBy?: string;
  highlightedValue?: Value | null;
  loop?: boolean;
  closeOnClick?: boolean;
  checkedValues?: readonly Value[] | (() => readonly Value[]);
  defaultCheckedValues?: readonly Value[];
  radioValues?: Readonly<Record<string, Value | null>> | (() => Readonly<Record<string, Value | null>>);
  defaultRadioValues?: Readonly<Record<string, Value | null>>;
  onOpenChange?: (open: boolean, details: ChangeDetails<OpenChangeReason>) => void;
  onAction?: (value: Value, details: ChangeDetails<MenuActionReason>) => void;
  onHighlightChange?: (value: Value | null, details: ChangeDetails<MenuHighlightReason>) => void;
  onCheckedValuesChange?: (value: readonly Value[], details: ChangeDetails<MenuSelectionReason>) => void;
  onRadioValuesChange?: (value: Readonly<Record<string, Value | null>>, details: ChangeDetails<MenuSelectionReason>) => void;
};

export interface MenuController<Value extends string> {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly highlightedValue: Computed<Value | null>;
  readonly checkedValues: Computed<readonly Value[]>;
  readonly radioValues: Computed<Readonly<Record<string, Value | null>>>;
  readonly triggerElement: ReactiveSignal<HTMLElement | null>;
  show(reason?: OpenChangeReason, event?: Event, focus?: "first" | "last" | "current" | false): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  toggle(reason?: OpenChangeReason, event?: Event): boolean;
  highlight(value: Value | null, reason?: MenuHighlightReason, event?: Event): boolean;
  focusValue(value: Value, event?: Event): boolean;
  focusFirst(event?: Event): boolean;
  focusLast(event?: Event): boolean;
  activate(value: Value, reason?: MenuActionReason, event?: Event): boolean;
  setChecked(value: Value, checked: boolean, reason?: MenuSelectionReason, event?: Event): boolean;
  selectRadio(value: Value, reason?: MenuSelectionReason, event?: Event): boolean;
  openSubmenu(value: Value, event?: Event, focus?: "first" | "last" | false): boolean;
  trigger(options?: CollectionAgentPartOptions & { id?: string }): Record<string, unknown>;
  /** Tells a renderer whether the popup portal belongs in the tree, including during exit motion. */
  isMounted(options?: PopupPortalOptions): boolean;
  /** Props for the optional DOM host passed to a renderer's Portal primitive. */
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  backdrop(options?: { dismiss?: boolean }): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(): Record<string, unknown>;
  /** Optional clipping/animation viewport inside the popup. */
  viewport(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  item(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  /** Base UI-compatible name for a link menu item. `link` remains an alias. */
  linkItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  link(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  checkboxItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  checkboxItemIndicator(value: Value, options?: { keepMounted?: boolean }): Record<string, unknown>;
  radioGroup(group: string, options?: { id?: string; label?: string; labelledBy?: string }): Record<string, unknown>;
  radioItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  radioItemIndicator(value: Value, options?: { keepMounted?: boolean }): Record<string, unknown>;
  /** Return the nested menu controller represented by SubmenuRoot. */
  submenuRoot(value: Value): MenuController<string>;
  submenuTrigger(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  group(options?: { id?: string; label?: string; labelledBy?: string }): Record<string, unknown>;
  groupLabel(options?: { id?: string }): Record<string, unknown>;
  separator(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

const menuParents = new WeakMap<object, {
  menu: MenuController<string>;
  value: string;
  cancelClose(): void;
  scheduleClose(event?: Event): void;
}>();

/**
 * A floating ARIA menu with roving focus, typeahead, selectable items, links,
 * checkbox/radio state, and direction-aware nested menus.
 */
export function createMenu<Value extends string>(options: MenuOptions<Value>): MenuController<Value> {
  const id = requireId(options.id, "Menu");
  const direction = options.direction ?? useDirection();
  const items = normalizeMenuItems(options.items, "Menu");
  const initialChecked = normalizeMenuChecked(options.defaultCheckedValues ?? [], items, "Menu defaultCheckedValues");
  const initialRadio = normalizeMenuRadios(options.defaultRadioValues ?? {}, items, "Menu defaultRadioValues");
  const checked = createControllableState<readonly Value[], MenuSelectionReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "checkedValues") ? {
      value: () => normalizeMenuChecked(readValue(options.checkedValues as CollectionReadable<readonly Value[]>), items, "Menu checkedValues"),
    } : {}),
    defaultValue: initialChecked,
    onValueChange: options.onCheckedValuesChange,
    equals: shallowArrayEqual,
    name: `${id}.checkedValues`,
  });
  const radios = createControllableState<Readonly<Record<string, Value | null>>, MenuSelectionReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "radioValues") ? {
      value: () => normalizeMenuRadios(readValue(options.radioValues as CollectionReadable<Readonly<Record<string, Value | null>>>), items, "Menu radioValues"),
    } : {}),
    defaultValue: initialRadio,
    onValueChange: options.onRadioValuesChange,
    equals: shallowRecordEqual,
    name: `${id}.radioValues`,
  });
  const startIndex = options.highlightedValue === undefined || options.highlightedValue === null
    ? -1
    : indexOfValue(items, options.highlightedValue);
  if (options.highlightedValue !== undefined && options.highlightedValue !== null && startIndex < 0) {
    throw new TypeError("Menu highlightedValue must identify an item.");
  }
  const highlightedIndex = signal(startIndex, { name: `${id}.highlightedIndex` });
  const highlightedValue = computed(() => items[highlightedIndex.value]?.value ?? null, { name: `${id}.highlightedValue` });
  const elements = new Map<Value, HTMLElement>();
  const submenuTimers = new Map<Value, ReturnType<typeof setTimeout>>();
  const typeahead = createTypeahead<MenuItemDefinition<Value>>({
    textValue: (item) => item.textValue,
    disabled: (item) => readBoolean(item.disabled),
  });
  const clearSubmenuTimer = (value?: Value) => {
    if (value !== undefined) {
      const timer = submenuTimers.get(value);
      if (timer !== undefined) clearTimeout(timer);
      submenuTimers.delete(value);
      return;
    }
    for (const timer of submenuTimers.values()) clearTimeout(timer);
    submenuTimers.clear();
  };
  const closeSiblingSubmenus = (except: Value, event?: Event) => {
    for (const entry of items) {
      if (entry.kind !== "submenu" || entry.value === except) continue;
      const submenu = (entry as MenuSubmenuItemDefinition<Value>).menu;
      if (submenu.open.peek()) submenu.hide("programmatic", event);
    }
  };
  const closeSubmenu = (value: Value, event?: Event) => {
    clearSubmenuTimer(value);
    const item = requireKind(requireDefinition(items, value, "Menu"), "submenu", "Menu submenuTrigger") as MenuSubmenuItemDefinition<Value>;
    return item.menu.hide("programmatic", event);
  };
  const scheduleSubmenuClose = (value: Value, event?: Event) => {
    clearSubmenuTimer(value);
    const item = requireKind(requireDefinition(items, value, "Menu"), "submenu", "Menu submenuTrigger") as MenuSubmenuItemDefinition<Value>;
    const delay = finiteNonNegative(item.closeDelay ?? 100, "Menu submenu closeDelay");
    if (delay === 0) return void closeSubmenu(value, event);
    const timer = setTimeout(() => {
      submenuTimers.delete(value);
      closeSubmenu(value, event);
    }, delay);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    submenuTimers.set(value, timer);
  };
  const scheduleSubmenuOpen = (value: Value, event?: Event) => {
    const item = requireKind(requireDefinition(items, value, "Menu"), "submenu", "Menu submenuTrigger") as MenuSubmenuItemDefinition<Value>;
    if (item.openOnHover === false || readBoolean(item.disabled)) return;
    clearSubmenuTimer(value);
    if (item.menu.open.peek()) return;
    const delay = finiteNonNegative(item.delay ?? 100, "Menu submenu delay");
    if (delay === 0) {
      controller.openSubmenu(value, event, false);
      return;
    }
    const timer = setTimeout(() => {
      submenuTimers.delete(value);
      controller.openSubmenu(value, event, false);
    }, delay);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    submenuTimers.set(value, timer);
  };
  let controller!: MenuController<Value>;
  const popup = createPopover({
    ...options,
    direction,
    id,
    modal: false,
    initialFocus: () => elements.get(highlightedValue.peek() ?? items[0]!.value) ?? null,
    onOpenChange(open, details) {
      options.onOpenChange?.(open, details);
      if (!details.canceled && !open) highlightedIndex.value = -1;
    },
  });
  const definition = (value: Value) => requireDefinition(items, value, "Menu");
  const itemDisabled = (value: Value) => readBoolean(definition(value).disabled);
  const indexEnabled = (item: MenuItemDefinition<Value>) => readBoolean(item.disabled);
  const setHighlightIndex = (index: number, reason: MenuHighlightReason, event?: Event, moveFocus = true) => {
    if (index < 0 || index >= items.length) return false;
    const item = items[index]!;
    if (readBoolean(item.disabled)) return false;
    const previous = highlightedValue.peek();
    const details = createChangeDetails(reason, event);
    options.onHighlightChange?.(item.value, details);
    if (details.canceled) return false;
    highlightedIndex.value = index;
    if (moveFocus) focusValue(item.value, elements, event, `${itemId(id, items, item.value)}-item`);
    return previous !== item.value;
  };
  const focusBoundary = (boundary: "first" | "last", event?: Event) => {
    const index = findCollectionIndex(items, -1, boundary, { disabled: indexEnabled });
    return index >= 0 && setHighlightIndex(index, "keyboard", event);
  };
  const show = (reason: OpenChangeReason = "programmatic", event?: Event, focus: "first" | "last" | "current" | false = "first") => {
    const wasOpen = popup.open.peek();
    const changed = popup.show(reason, event);
    if (!wasOpen && (!changed || !popup.open.peek())) return changed;
    if (focus === "first") focusBoundary("first", event);
    else if (focus === "last") focusBoundary("last", event);
    else if (focus === "current" && highlightedIndex.peek() < 0) focusBoundary("first", event);
    if (focus !== false) deferFocus(() => {
      const value = highlightedValue.peek();
      if (value !== null) focusValue(value, elements, event, `${itemId(id, items, value)}-item`);
    });
    return changed;
  };
  const hide = (reason: OpenChangeReason = "programmatic", event?: Event) => popup.hide(reason, event);
  const highlight = (value: Value | null, reason: MenuHighlightReason = "programmatic", event?: Event) => {
    if (value === null) {
      const previous = highlightedValue.peek();
      if (previous === null) return false;
      const details = createChangeDetails(reason, event);
      options.onHighlightChange?.(null, details);
      if (details.canceled) return false;
      highlightedIndex.value = -1;
      return true;
    }
    definition(value);
    return setHighlightIndex(indexOfValue(items, value), reason, event, false);
  };
  const setChecked = (value: Value, next: boolean, reason: MenuSelectionReason = "programmatic", event?: Event) => {
    const item = requireKind(definition(value), "checkbox", "Menu checkboxItem");
    if (readBoolean(item.disabled)) return false;
    const current = checked.value.peek();
    return checked.set(
      next ? collectionOrder([...current.filter((entry) => entry !== value), value], items) : current.filter((entry) => entry !== value),
      reason,
      event,
    );
  };
  const selectRadio = (value: Value, reason: MenuSelectionReason = "programmatic", event?: Event) => {
    const item = requireKind(definition(value), "radio", "Menu radioItem") as MenuRadioItemDefinition<Value>;
    if (readBoolean(item.disabled)) return false;
    return radios.set(Object.freeze({ ...radios.value.peek(), [item.group]: value }), reason, event);
  };
  const requireRadioGroup = (group: string) => {
    const normalized = group?.trim();
    if (!normalized || !items.some((item) => item.kind === "radio" && item.group === normalized)) {
      throw new TypeError("Menu radioGroup requires a group used by at least one radio item.");
    }
    return normalized;
  };
  const closeAfterAction = (item: MenuItemDefinition<Value>, event?: Event) => {
    if (item.closeOnClick ?? options.closeOnClick ?? true) hide("programmatic", event);
  };
  const activate = (value: Value, reason: MenuActionReason = "programmatic", event?: Event) => {
    const item = definition(value);
    if (readBoolean(item.disabled)) return false;
    if (item.kind === "submenu") return controller.openSubmenu(value, event);
    const details = createChangeDetails(reason, event);
    options.onAction?.(value, details);
    if (details.canceled) {
      event?.preventDefault();
      return false;
    }
    let changed = true;
    const selectionReason: MenuSelectionReason = reason === "keyboard" ? "keyboard" : reason === "item-press" ? "item-press" : "programmatic";
    if (item.kind === "checkbox") changed = setChecked(value, !checked.value.peek().includes(value), selectionReason, event);
    else if (item.kind === "radio") changed = selectRadio(value, selectionReason, event);
    if (changed) closeAfterAction(item, event);
    return changed;
  };
  const openSubmenu = (value: Value, event?: Event, focus: "first" | "last" | false = "first") => {
    const item = requireKind(definition(value), "submenu", "Menu submenuTrigger") as MenuSubmenuItemDefinition<Value>;
    if (readBoolean(item.disabled)) return false;
    clearSubmenuTimer(value);
    const wasOpen = item.menu.open.peek();
    const changed = item.menu.show("programmatic", event, false);
    if (!changed && !wasOpen) return false;
    closeSiblingSubmenus(value, event);
    item.menu.triggerElement.value = elements.get(value) ?? null;
    menuParents.set(item.menu, {
      menu: controller as unknown as MenuController<string>,
      value,
      cancelClose: () => clearSubmenuTimer(value),
      scheduleClose: (closeEvent) => scheduleSubmenuClose(value, closeEvent),
    });
    if (focus !== false) item.menu.show("programmatic", event, focus);
    return changed;
  };
  const itemProps = (value: Value, expected?: MenuItemKind, partOptions: CollectionAgentPartOptions = {}) => {
    const item = definition(value);
    if (expected) requireKind(item, expected, `Menu ${expected}`);
    const index = indexOfValue(items, value);
    const kind = item.kind ?? "item";
    const role = kind === "checkbox" ? "menuitemcheckbox" : kind === "radio" ? "menuitemradio" : "menuitem";
    return {
      id: `${itemId(id, items, value)}-item`,
      role,
      tabIndex: () => highlightedIndex.value === index ? 0 : -1,
      "aria-disabled": () => itemDisabled(value) || undefined,
      ...(kind === "checkbox" ? { "aria-checked": () => checked.value.value.includes(value) } : {}),
      ...(kind === "radio" ? { "aria-checked": () => radios.value.value[(item as MenuRadioItemDefinition<Value>).group] === value } : {}),
      ...(kind === "submenu" ? {
        "aria-haspopup": "menu",
        "aria-controls": `${(item as MenuSubmenuItemDefinition<Value>).menu.id}-popup`,
        "aria-expanded": () => (item as MenuSubmenuItemDefinition<Value>).menu.open.value,
      } : {}),
      "data-highlighted": () => highlightedIndex.value === index ? "" : undefined,
      ...(kind === "submenu" ? {
        "data-popup-open": () => (item as MenuSubmenuItemDefinition<Value>).menu.open.value ? "" : undefined,
      } : {}),
      "data-disabled": () => itemDisabled(value) ? "" : undefined,
      "data-checked": () => kind === "checkbox"
        ? checked.value.value.includes(value) ? "" : undefined
        : kind === "radio"
          ? radios.value.value[(item as MenuRadioItemDefinition<Value>).group] === value ? "" : undefined
          : undefined,
      "data-clank-part": kind === "submenu" ? "submenu-trigger" : kind === "checkbox" ? "checkbox-item" : kind === "radio" ? "radio-item" : kind,
      ...agentProps(partOptions),
      ref: (element: HTMLElement | null) => {
        const previous = elements.get(value);
        if (element) elements.set(value, element);
        else elements.delete(value);
        if (kind === "submenu") {
          const submenu = (item as MenuSubmenuItemDefinition<Value>).menu;
          if (element || submenu.triggerElement.peek() === previous) submenu.triggerElement.value = element;
        }
      },
      onFocus: (event: FocusEvent) => setHighlightIndex(index, "focus", event, false),
      onPointerMove: (event: PointerEvent) => {
        if (event.pointerType === "touch" || itemDisabled(value)) return;
        setHighlightIndex(index, "pointer", event, false);
        if (kind === "submenu") scheduleSubmenuOpen(value, event);
        else closeSiblingSubmenus(value, event);
      },
      onPointerLeave: (event: PointerEvent) => {
        if (event.pointerType === "touch") return;
        if (kind === "submenu") scheduleSubmenuClose(value, event);
        else if (highlightedValue.peek() === value) highlight(null, "pointer", event);
      },
      onClick: (event: Event) => {
        if (event.defaultPrevented) return;
        if (itemDisabled(value)) {
          event.preventDefault();
          return;
        }
        activate(value, "item-press", event);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        if ((event.key === "Enter" || event.key === " ") && !itemDisabled(value)) {
          activate(value, "keyboard", event);
          event.preventDefault();
          return;
        }
        if (kind === "submenu") {
          const textDirection = resolveDirection(direction, event.currentTarget as Element);
          const openKey = textDirection === "rtl" ? "ArrowLeft" : "ArrowRight";
          if (event.key === openKey) {
            openSubmenu(value, event, "first");
            event.preventDefault();
          }
        }
      },
    };
  };
  controller = {
    id,
    open: popup.open,
    highlightedValue,
    checkedValues: checked.value,
    radioValues: radios.value,
    triggerElement: popup.triggerElement,
    show,
    hide,
    toggle(reason = "programmatic", event) {
      return popup.open.peek() ? hide(reason, event) : show(reason, event, "first");
    },
    highlight,
    focusValue(value, event) {
      definition(value);
      if (itemDisabled(value)) return false;
      setHighlightIndex(indexOfValue(items, value), "programmatic", event, false);
      return focusValue(value, elements, event, `${itemId(id, items, value)}-item`);
    },
    focusFirst: (event) => focusBoundary("first", event),
    focusLast: (event) => focusBoundary("last", event),
    activate,
    setChecked,
    selectRadio,
    openSubmenu,
    trigger(triggerOptions = {}) {
      const base = popup.trigger({ id: triggerOptions.id, agentId: triggerOptions.agentId, agentLabel: triggerOptions.agentLabel });
      const activateTrigger = (event: Event) => {
        if (event.currentTarget && typeof event.currentTarget === "object") popup.triggerElement.value = event.currentTarget as HTMLElement;
      };
      return {
        ...base,
        "aria-haspopup": "menu",
        "data-clank-part": "trigger",
        ...agentProps(triggerOptions),
        onClick: (event: Event) => {
          if (event.defaultPrevented) return;
          activateTrigger(event);
          controller.toggle("trigger-press", event);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.defaultPrevented) return;
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            activateTrigger(event);
            show("trigger-press", event, "first");
            event.preventDefault();
          } else if (event.key === "ArrowUp") {
            activateTrigger(event);
            show("trigger-press", event, "last");
            event.preventDefault();
          }
        },
      };
    },
    isMounted: (portalOptions = {}) => popup.isMounted(portalOptions),
    portal: (portalOptions = {}) => popup.portal(portalOptions),
    backdrop: (backdropOptions = {}) => popup.backdrop(backdropOptions),
    positioner: () => popup.positioner(),
    popup() {
      return mergeProps(popup.popup({ role: "menu", labelledBy: options.labelledBy ?? false, describedBy: false }), {
        ...(options.label ? { "aria-label": options.label } : {}),
        ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
        tabIndex: -1,
        "data-clank-part": "popup",
        onPointerEnter() {
          menuParents.get(controller)?.cancelClose();
        },
        onPointerLeave(event: PointerEvent) {
          if (event.pointerType !== "touch") menuParents.get(controller)?.scheduleClose(event);
        },
        onKeyDown(event: KeyboardEvent) {
          if (event.defaultPrevented) return;
          const current = highlightedIndex.peek();
          const intent = getCollectionNavigationIntent(event.key, "vertical", "ltr");
          if (intent && intent !== "page-next" && intent !== "page-previous") {
            const next = findCollectionIndex(items, current, intent, { loop: options.loop !== false, disabled: indexEnabled });
            if (next >= 0) setHighlightIndex(next, "keyboard", event);
            event.preventDefault();
            return;
          }
          if (event.key === "Tab") {
            // Tabbing is a focus-out dismissal. Suppressing trigger restoration
            // lets the browser continue to the next or previous document stop.
            hide("focus-out", event);
            return;
          }
          const parent = menuParents.get(controller);
          if (parent) {
            const textDirection = resolveDirection(direction, event.currentTarget as Element);
            const closeKey = textDirection === "rtl" ? "ArrowRight" : "ArrowLeft";
            if (event.key === closeKey) {
              hide("programmatic", event);
              parent.menu.focusValue(parent.value, event);
              event.preventDefault();
              return;
            }
          }
          if (event.key === "Escape") {
            popup.triggerElement.peek()?.focus?.();
            return;
          }
          const match = typeahead.search(event.key, items, current);
          if (match >= 0) {
            setHighlightIndex(match, "keyboard", event);
            event.preventDefault();
          }
        },
      });
    },
    viewport: () => popup.viewport(),
    arrow: () => popup.arrow(),
    item: (value, partOptions = {}) => itemProps(value, "item", partOptions),
    linkItem(value, partOptions = {}) {
      const item = requireKind(definition(value), "link", "Menu link") as MenuLinkItemDefinition<Value>;
      return mergeProps(
        { href: item.href, ...(item.target ? { target: item.target } : {}), ...(item.rel ? { rel: item.rel } : {}) },
        itemProps(value, "link", partOptions),
        { "data-clank-part": "link-item" },
      );
    },
    link(value, partOptions = {}) {
      const item = requireKind(definition(value), "link", "Menu link") as MenuLinkItemDefinition<Value>;
      return mergeProps(
        { href: item.href, ...(item.target ? { target: item.target } : {}), ...(item.rel ? { rel: item.rel } : {}) },
        itemProps(value, "link", partOptions),
      );
    },
    checkboxItem: (value, partOptions = {}) => itemProps(value, "checkbox", partOptions),
    checkboxItemIndicator(value, indicatorOptions = {}) {
      requireKind(definition(value), "checkbox", "Menu checkboxItemIndicator");
      const isChecked = () => checked.value.value.includes(value);
      return {
        "aria-hidden": true,
        hidden: () => indicatorOptions.keepMounted === true ? false : !isChecked(),
        "data-checked": () => isChecked() ? "" : undefined,
        "data-unchecked": () => isChecked() ? undefined : "",
        "data-clank-part": "checkbox-item-indicator",
      };
    },
    radioGroup(group, groupOptions = {}) {
      const normalized = requireRadioGroup(group);
      return {
        ...(groupOptions.id ? { id: groupOptions.id } : {}),
        role: "group",
        ...(groupOptions.label ? { "aria-label": groupOptions.label } : {}),
        ...(groupOptions.labelledBy ? { "aria-labelledby": groupOptions.labelledBy } : {}),
        "data-value": () => radios.value.value[normalized] ?? undefined,
        "data-clank-part": "radio-group",
      };
    },
    radioItem: (value, partOptions = {}) => itemProps(value, "radio", partOptions),
    radioItemIndicator(value, indicatorOptions = {}) {
      const item = requireKind(definition(value), "radio", "Menu radioItemIndicator") as MenuRadioItemDefinition<Value>;
      const isChecked = () => radios.value.value[item.group] === value;
      return {
        "aria-hidden": true,
        hidden: () => indicatorOptions.keepMounted === true ? false : !isChecked(),
        "data-checked": () => isChecked() ? "" : undefined,
        "data-unchecked": () => isChecked() ? undefined : "",
        "data-clank-part": "radio-item-indicator",
      };
    },
    submenuRoot(value) {
      const item = requireKind(definition(value), "submenu", "Menu submenuRoot") as MenuSubmenuItemDefinition<Value>;
      return item.menu;
    },
    submenuTrigger: (value, partOptions = {}) => itemProps(value, "submenu", partOptions),
    group(groupOptions = {}) {
      return {
        ...(groupOptions.id ? { id: groupOptions.id } : {}),
        role: "group",
        ...(groupOptions.label ? { "aria-label": groupOptions.label } : {}),
        ...(groupOptions.labelledBy ? { "aria-labelledby": groupOptions.labelledBy } : {}),
        "data-clank-part": "group",
      };
    },
    groupLabel: (labelOptions = {}) => ({ ...(labelOptions.id ? { id: labelOptions.id } : {}), "data-clank-part": "group-label" }),
    separator: () => ({ role: "separator", "aria-orientation": "horizontal", "data-clank-part": "separator" }),
    manifest: () => menuManifest("Menu", id, popup.open.peek(), highlightedValue.peek(), checked.value.peek(), radios.value.peek(), items),
    dispose() {
      clearSubmenuTimer();
      typeahead.dispose();
      popup.dispose();
      menuParents.delete(controller);
    },
  };
  return controller;
}

export interface ContextMenuOptions<Value extends string> extends Omit<MenuOptions<Value>, "defaultOpen"> {
  longPressDelay?: number;
  longPressTolerance?: number;
}

export interface ContextMenuController<Value extends string> extends MenuController<Value> {
  target(options?: CollectionAgentPartOptions): Record<string, unknown>;
}

/** Right-click and touch-long-press activation, positioned at the pointer coordinate. */
export function createContextMenu<Value extends string>(options: ContextMenuOptions<Value>): ContextMenuController<Value> {
  let targetElement: HTMLElement | null = null;
  const menu = createMenu({
    ...options,
    defaultOpen: false,
    finalFocus: options.finalFocus ?? (() => targetElement),
  });
  const delay = finiteNonNegative(options.longPressDelay ?? 500, "ContextMenu longPressDelay");
  const tolerance = finiteNonNegative(options.longPressTolerance ?? 10, "ContextMenu longPressTolerance");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let suppressClick = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pointerId = -1;
  };
  const setVirtualAnchor = (event: { clientX?: number; clientY?: number; currentTarget?: EventTarget | null }) => {
    const x = finiteCoordinate(event.clientX ?? lastX);
    const y = finiteCoordinate(event.clientY ?? lastY);
    const ownerDocument = (event.currentTarget as HTMLElement | null)?.ownerDocument ?? targetElement?.ownerDocument;
    const rect = Object.freeze({ x, y, left: x, right: x, top: y, bottom: y, width: 0, height: 0, toJSON: () => ({ x, y, width: 0, height: 0 }) });
    menu.triggerElement.value = { ownerDocument, getBoundingClientRect: () => rect } as unknown as HTMLElement;
  };
  const baseDispose = menu.dispose;
  const context = Object.assign(menu, {
    target(partOptions: CollectionAgentPartOptions = {}) {
      return {
        "data-clank-part": "trigger",
        ...agentProps(partOptions),
        ref(element: HTMLElement | null) {
          targetElement = element;
          if (!menu.open.peek()) menu.triggerElement.value = element;
        },
        onContextMenu(event: MouseEvent) {
          if (event.defaultPrevented) return;
          clear();
          setVirtualAnchor(event);
          menu.show("trigger-press", event, "first");
          event.preventDefault();
        },
        onKeyDown(event: KeyboardEvent) {
          if (event.defaultPrevented || (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))) return;
          clear();
          const target = event.currentTarget as HTMLElement | null;
          const rect = target?.getBoundingClientRect?.();
          setVirtualAnchor({
            clientX: rect?.left ?? 0,
            clientY: rect?.bottom ?? 0,
            currentTarget: target,
          });
          menu.show("trigger-press", event, "first");
          event.preventDefault();
        },
        onPointerDown(event: PointerEvent) {
          if (event.pointerType !== "touch" || !event.isPrimary) return;
          clear();
          pointerId = event.pointerId;
          startX = lastX = event.clientX;
          startY = lastY = event.clientY;
          timer = setTimeout(() => {
            timer = undefined;
            const previousAnchor = menu.triggerElement.peek();
            setVirtualAnchor(event);
            const wasOpen = menu.open.peek();
            const changed = menu.show("trigger-press", event, "first");
            if (wasOpen || changed || menu.open.peek()) suppressClick = true;
            else menu.triggerElement.value = previousAnchor;
          }, delay);
          (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
        },
        onPointerMove(event: PointerEvent) {
          if (event.pointerId !== pointerId) return;
          lastX = event.clientX;
          lastY = event.clientY;
          if (Math.hypot(lastX - startX, lastY - startY) > tolerance) clear();
        },
        onPointerUp(event: PointerEvent) { if (event.pointerId === pointerId) clear(); },
        onPointerCancel(event: PointerEvent) { if (event.pointerId === pointerId) clear(); },
        onClick(event: Event) {
          if (!suppressClick) return;
          suppressClick = false;
          event.preventDefault();
        },
      };
    },
    manifest: () => menuManifest("ContextMenu", menu.id, menu.open.peek(), menu.highlightedValue.peek(), menu.checkedValues.peek(), menu.radioValues.peek(), normalizeMenuItems(options.items, "ContextMenu")),
    dispose() { clear(); baseDispose(); },
  }) as ContextMenuController<Value>;
  return context;
}

interface MenubarItemBase<Value extends string> extends CollectionItemDefinition<Value> {}

export interface MenubarMenuDefinition<Value extends string> extends MenubarItemBase<Value> {
  kind?: "menu";
  items: readonly MenuItemDefinition<string>[];
  menuOptions?: Omit<MenuOptions<string>, "id" | "items" | "onOpenChange" | "open" | "defaultOpen">;
}

export interface MenubarLinkDefinition<Value extends string> extends MenubarItemBase<Value> {
  kind: "link";
  href: string;
  target?: string;
  rel?: string;
}

export type MenubarItemDefinition<Value extends string> = MenubarMenuDefinition<Value> | MenubarLinkDefinition<Value>;
export type MenubarChangeReason = "trigger-press" | "keyboard" | "pointer" | "dismiss" | "programmatic";

export interface MenubarOptions<Value extends string> {
  id: string;
  items: readonly MenubarItemDefinition<Value>[];
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  direction?: Direction | "auto";
  loop?: boolean;
  label?: string;
  labelledBy?: string;
  onValueChange?: (value: Value | null, details: ChangeDetails<MenubarChangeReason>) => void;
}

export interface MenubarController<Value extends string> {
  readonly id: string;
  readonly value: Computed<Value | null>;
  readonly focusedValue: Computed<Value>;
  openMenu(value: Value, reason?: MenubarChangeReason, event?: Event, focus?: "first" | "last" | false): boolean;
  closeMenu(reason?: MenubarChangeReason, event?: Event): boolean;
  focusValue(value: Value, event?: Event): boolean;
  root(): Record<string, unknown>;
  item(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  trigger(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  link(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  menu(value: Value): MenuController<string>;
  separator(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/** A horizontal, direction-aware menubar whose menus share one open value. */
export function createMenubar<Value extends string>(options: MenubarOptions<Value>): MenubarController<Value> {
  const id = requireId(options.id, "Menubar");
  const inheritedDirection = useDirection();
  const direction = options.direction ?? inheritedDirection;
  const items = normalizeMenubarItems(options.items);
  const initial = normalizeNullableValue(options.defaultValue ?? null, items, "Menubar defaultValue");
  if (initial !== null && requireDefinition(items, initial, "Menubar").kind === "link") {
    throw new TypeError("Menubar defaultValue must identify a menu trigger, not a link.");
  }
  const state = createControllableState<Value | null, MenubarChangeReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "value") ? {
      value: () => normalizeNullableValue(readValue(options.value as CollectionReadable<Value | null>), items, "Menubar value"),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange,
    name: `${id}.value`,
  });
  const focusedIndex = signal(Math.max(0, initial === null ? 0 : indexOfValue(items, initial)), { name: `${id}.focusedIndex` });
  const focusedValue = computed(() => items[focusedIndex.value]?.value ?? items[0]!.value, { name: `${id}.focusedValue` });
  const elements = new Map<Value, HTMLElement>();
  const menus = new Map<Value, MenuController<string>>();
  const typeahead = createTypeahead<MenubarItemDefinition<Value>>({ textValue: (item) => item.textValue, disabled: () => false });
  let synchronizing = false;
  let controller!: MenubarController<Value>;
  const definition = (value: Value) => requireDefinition(items, value, "Menubar");
  const itemDisabled = (value: Value) => readBoolean(definition(value).disabled);
  for (const [index, item] of items.entries()) {
    if (item.kind === "link") continue;
    const menuItem = item as MenubarMenuDefinition<Value>;
    const menu = createMenu({
      ...menuItem.menuOptions,
      direction: menuItem.menuOptions?.direction ?? (direction === "auto" ? inheritedDirection : direction),
      id: `${id}-menu-${index + 1}`,
      items: menuItem.items,
      onOpenChange(open, details) {
        if (details.canceled || synchronizing) return;
        const accepted = open
          ? state.set(menuItem.value, "trigger-press", details.event)
          : state.value.peek() === menuItem.value
            ? state.set(null, details.reason === "escape-key" || details.reason === "outside-press" ? "dismiss" : "programmatic", details.event)
            : true;
        if (!accepted && state.value.peek() !== (open ? menuItem.value : null)) details.cancel();
      },
    });
    menus.set(menuItem.value, menu);
  }
  const focusAt = (index: number, event?: Event) => {
    if (index < 0 || index >= items.length) return false;
    focusedIndex.value = index;
    return focusValue(items[index]!.value, elements, event, `${itemId(id, items, items[index]!.value)}-item`);
  };
  const closeMenu = (reason: MenubarChangeReason = "programmatic", event?: Event) => {
    const current = state.value.peek();
    if (current === null) return false;
    const changed = state.set(null, reason, event);
    if (!changed) return false;
    synchronizing = true;
    try { menus.get(current)?.hide(reason === "dismiss" ? "outside-press" : "programmatic", event); }
    finally { synchronizing = false; }
    return true;
  };
  const openMenu = (value: Value, reason: MenubarChangeReason = "programmatic", event?: Event, focus: "first" | "last" | false = "first") => {
    const item = definition(value);
    if (item.kind === "link" || itemDisabled(value)) return false;
    const previous = state.value.peek();
    const changed = state.set(value, reason, event);
    if (!changed && previous !== value) return false;
    if (previous !== null && previous !== value) {
      synchronizing = true;
      try { menus.get(previous)?.hide("programmatic", event); }
      finally { synchronizing = false; }
    }
    synchronizing = true;
    try { menus.get(value)!.show(reason === "trigger-press" ? "trigger-press" : "programmatic", event, focus); }
    finally { synchronizing = false; }
    return changed || previous !== value;
  };
  const move = (from: number, key: string, event: KeyboardEvent) => {
    const textDirection = resolveDirection(direction, event.currentTarget as Element);
    const intent = getCollectionNavigationIntent(key, "horizontal", textDirection);
    if (!intent || intent === "page-next" || intent === "page-previous") return false;
    const next = findCollectionIndex(items, from, intent, { loop: options.loop !== false, disabled: () => false });
    if (next < 0) return false;
    const wasOpen = state.value.peek() !== null;
    const nextItem = items[next]!;
    if (wasOpen) {
      if (nextItem.kind === "link" || readBoolean(nextItem.disabled)) closeMenu("keyboard", event);
      else openMenu(nextItem.value, "keyboard", event, "first");
    }
    focusAt(next, event);
    return true;
  };
  const itemProps = (value: Value, expected?: "menu" | "link", partOptions: CollectionAgentPartOptions = {}) => {
    const item = definition(value);
    const kind = item.kind ?? "menu";
    if (expected && expected !== kind) throw new TypeError(`Menubar ${expected} requires a ${expected} definition.`);
    const index = indexOfValue(items, value);
    const menu = menus.get(value);
    const base = menu?.trigger({ id: `${itemId(id, items, value)}-item` }) ?? {};
    return {
      ...base,
      id: `${itemId(id, items, value)}-item`,
      role: "menuitem",
      ...(kind === "link" ? {
        href: (item as MenubarLinkDefinition<Value>).href,
        ...((item as MenubarLinkDefinition<Value>).target ? { target: (item as MenubarLinkDefinition<Value>).target } : {}),
        ...((item as MenubarLinkDefinition<Value>).rel ? { rel: (item as MenubarLinkDefinition<Value>).rel } : {}),
      } : {
        type: "button",
        "aria-haspopup": "menu",
        "aria-controls": `${menu!.id}-popup`,
        "aria-expanded": () => menu!.open.value,
      }),
      tabIndex: () => focusedIndex.value === index ? 0 : -1,
      "aria-disabled": () => itemDisabled(value) || undefined,
      "data-highlighted": () => focusedIndex.value === index ? "" : undefined,
      "data-open": () => state.value.value === value ? "" : undefined,
      "data-disabled": () => itemDisabled(value) ? "" : undefined,
      "data-clank-part": kind === "link" ? "link" : "trigger",
      ...agentProps(partOptions),
      ref: mergeElementRef(base.ref, (element) => {
        if (element) elements.set(value, element);
        else elements.delete(value);
      }),
      onFocus: () => { focusedIndex.value = index; },
      onPointerEnter: (event: PointerEvent) => {
        focusedIndex.value = index;
        if (state.value.peek() !== null && kind === "menu" && !itemDisabled(value)) openMenu(value, "pointer", event, false);
      },
      onClick: (event: Event) => {
        if (event.defaultPrevented) return;
        if (itemDisabled(value)) {
          event.preventDefault();
          return;
        }
        if (kind === "menu") {
          if (event.currentTarget && typeof event.currentTarget === "object") menu!.triggerElement.value = event.currentTarget as HTMLElement;
          state.value.peek() === value ? closeMenu("trigger-press", event) : openMenu(value, "trigger-press", event, "first");
          event.preventDefault();
        } else {
          closeMenu("trigger-press", event);
        }
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        if (move(index, event.key, event)) {
          event.preventDefault();
          return;
        }
        if (kind === "menu" && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) && !itemDisabled(value)) {
          if (event.currentTarget && typeof event.currentTarget === "object") menu!.triggerElement.value = event.currentTarget as HTMLElement;
          openMenu(value, "keyboard", event, event.key === "ArrowUp" ? "last" : "first");
          event.preventDefault();
          return;
        }
        if (event.key === "Escape" && state.value.peek() !== null) {
          closeMenu("dismiss", event);
          focusAt(index, event);
          event.preventDefault();
          return;
        }
        const match = typeahead.search(event.key, items, index);
        if (match >= 0) {
          event.preventDefault();
          focusAt(match, event);
        }
      },
    };
  };
  controller = {
    id,
    value: state.value,
    focusedValue,
    openMenu,
    closeMenu,
    focusValue(value, event) {
      definition(value);
      return focusAt(indexOfValue(items, value), event);
    },
    root: () => ({
      id,
      role: "menubar",
      "aria-orientation": "horizontal",
      ...(options.label ? { "aria-label": options.label } : {}),
      ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
      "data-orientation": "horizontal",
      "data-clank-part": "root",
    }),
    item(value, partOptions = {}) {
      const item = definition(value);
      return {
        id: itemId(id, items, value),
        "data-open": () => state.value.value === value ? "" : undefined,
        "data-disabled": () => itemDisabled(value) ? "" : undefined,
        "data-item-kind": item.kind ?? "menu",
        "data-clank-part": "item",
        ...agentProps(partOptions),
      };
    },
    trigger: (value, partOptions = {}) => itemProps(value, "menu", partOptions),
    link: (value, partOptions = {}) => itemProps(value, "link", partOptions),
    menu(value) {
      const item = definition(value);
      if (item.kind === "link") throw new TypeError("Menubar menu requires a menu definition.");
      return menus.get(value)!;
    },
    separator: () => ({ role: "separator", "aria-orientation": "vertical", "data-clank-part": "separator" }),
    manifest: () => createUiManifest({
      component: "Menubar",
      id,
      state: { value: state.value.peek(), focusedValue: focusedValue.peek(), direction },
      parts: [
        { name: "root", role: "menubar", defaultElement: "div", required: true },
        { name: "item", defaultElement: "div" },
        { name: "trigger", role: "menuitem", defaultElement: "button" },
        { name: "link", role: "menuitem", defaultElement: "a" },
        { name: "menu", role: "menu", defaultElement: "div" },
        { name: "separator", role: "separator", defaultElement: "div" },
      ],
      actions: [
        { name: "openMenu", description: "Open one top-level menu.", sideEffects: "write", reasons: ["trigger-press", "keyboard", "pointer", "programmatic"] },
        { name: "closeMenu", description: "Close the active top-level menu.", sideEffects: "write", reasons: ["dismiss", "programmatic"] },
        { name: "focusValue", description: "Move roving focus to one menubar item.", sideEffects: "none" },
      ],
      keyboard: {
        ArrowLeft: "Move to the previous item, respecting text direction",
        ArrowRight: "Move to the next item, respecting text direction",
        ArrowDown: "Open a menu and focus its first item",
        ArrowUp: "Open a menu and focus its last item",
        Home: "Focus the first menubar item",
        End: "Focus the last menubar item",
        Escape: "Close the active menu and return focus",
      },
    }),
    dispose() {
      typeahead.dispose();
      for (const menu of menus.values()) menu.dispose();
    },
  };
  return controller;
}

interface NavigationMenuItemBase<Value extends string> extends CollectionItemDefinition<Value> {}

export interface NavigationMenuTriggerDefinition<Value extends string> extends NavigationMenuItemBase<Value> {
  kind?: "trigger";
}

export interface NavigationMenuLinkDefinition<Value extends string> extends NavigationMenuItemBase<Value> {
  kind: "link";
  href: string;
  target?: string;
  rel?: string;
  current?: boolean | "page" | "step" | "location" | "date" | "time";
  /** Whether activating the link closes an open flyout. Defaults to false. */
  closeOnClick?: boolean;
}

export type NavigationMenuItemDefinition<Value extends string> = NavigationMenuTriggerDefinition<Value> | NavigationMenuLinkDefinition<Value>;
export type NavigationMenuChangeReason = "trigger-press" | "keyboard" | "hover" | "focus" | "dismiss" | "programmatic";

export interface NavigationMenuOptions<Value extends string> {
  id: string;
  items: readonly NavigationMenuItemDefinition<Value>[];
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  orientation?: Orientation;
  direction?: Direction | "auto";
  loop?: boolean;
  label?: string;
  labelledBy?: string;
  /** Accessible name for the popup landmark. Defaults to `label` without adding English text. */
  popupLabel?: string;
  openOnHover?: boolean;
  openDelay?: number;
  closeDelay?: number;
  side?: PopupOptions["side"];
  align?: PopupOptions["align"];
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  avoidCollisions?: boolean;
  onValueChange?: (value: Value | null, details: ChangeDetails<NavigationMenuChangeReason>) => void;
}

export interface NavigationMenuController<Value extends string> {
  readonly id: string;
  readonly value: Computed<Value | null>;
  readonly focusedValue: Computed<Value>;
  open(value: Value, reason?: NavigationMenuChangeReason, event?: Event): boolean;
  close(reason?: NavigationMenuChangeReason, event?: Event): boolean;
  toggle(value: Value, event?: Event): boolean;
  focusValue(value: Value, event?: Event): boolean;
  root(): Record<string, unknown>;
  list(): Record<string, unknown>;
  item(value: Value): Record<string, unknown>;
  trigger(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  icon(value: Value): Record<string, unknown>;
  link(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  /** Tells a renderer whether the popup portal belongs in the tree, including during exit motion. */
  isMounted(options?: PopupPortalOptions): boolean;
  /** Props for the optional DOM host passed to a renderer's Portal primitive. */
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(): Record<string, unknown>;
  viewport(): Record<string, unknown>;
  content(value: Value): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  backdrop(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/** Shared navigation flyout with roving trigger/link focus and responsive pointer intent. */
export function createNavigationMenu<Value extends string>(options: NavigationMenuOptions<Value>): NavigationMenuController<Value> {
  const id = requireId(options.id, "NavigationMenu");
  const direction = options.direction ?? useDirection();
  const popupLabel = options.popupLabel === undefined ? options.label?.trim() : options.popupLabel.trim();
  if (options.popupLabel !== undefined && !popupLabel) {
    throw new TypeError("NavigationMenu popupLabel must be non-empty when provided.");
  }
  const items = normalizeNavigationItems(options.items);
  const initial = normalizeNavigationValue(options.defaultValue ?? null, items, "NavigationMenu defaultValue");
  const state = createControllableState<Value | null, NavigationMenuChangeReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "value") ? {
      value: () => normalizeNavigationValue(readValue(options.value as CollectionReadable<Value | null>), items, "NavigationMenu value"),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange,
    name: `${id}.value`,
  });
  const orientation = options.orientation ?? "horizontal";
  const focusedIndex = signal(Math.max(0, initial === null ? firstEnabledIndex(items) : indexOfValue(items, initial)), { name: `${id}.focusedIndex` });
  const rovingIndex = computed(
    () => recoverEnabledIndex(items, focusedIndex.value, (item) => readBoolean(item.disabled)),
    { name: `${id}.rovingIndex` },
  );
  const focusedValue = computed(() => items[rovingIndex.value]?.value ?? items[0]!.value, { name: `${id}.focusedValue` });
  const triggerElements = new Map<Value, HTMLElement>();
  const contentElements = new Map<Value, HTMLElement>();
  let listElement: HTMLElement | null = null;
  let indicatorElement: HTMLElement | null = null;
  let viewportElement: HTMLElement | null = null;
  let indicatorCleanup: Cleanup | undefined;
  let viewportCleanup: Cleanup | undefined;
  const geometryObservers = new Set<ElementResizeObserver>();
  const typeahead = createTypeahead<NavigationMenuItemDefinition<Value>>({ textValue: (item) => item.textValue, disabled: (item) => readBoolean(item.disabled) });
  const openDelay = finiteNonNegative(options.openDelay ?? 100, "NavigationMenu openDelay");
  const closeDelay = finiteNonNegative(options.closeDelay ?? 150, "NavigationMenu closeDelay");
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearOpen = () => { if (openTimer !== undefined) clearTimeout(openTimer); openTimer = undefined; };
  const clearClose = () => { if (closeTimer !== undefined) clearTimeout(closeTimer); closeTimer = undefined; };
  const definition = (value: Value) => requireDefinition(items, value, "NavigationMenu");
  const itemDisabled = (value: Value) => readBoolean(definition(value).disabled);
  const syncGeometry = () => {
    const value = state.value.peek();
    syncNavigationMenuGeometry(
      listElement,
      indicatorElement,
      value === null ? null : triggerElements.get(value) ?? null,
      viewportElement,
      value === null ? null : contentElements.get(value) ?? null,
      items.length,
      value === null ? -1 : indexOfValue(items, value),
    );
  };
  const observeGeometryElement = (element: Element | null) => {
    if (!element) return;
    for (const observer of geometryObservers) observer.observe(element);
  };
  const unobserveGeometryElement = (element: Element | null) => {
    if (!element) return;
    for (const observer of geometryObservers) observer.unobserve?.(element);
  };
  const observeGeometryTargets = (observer: ElementResizeObserver) => {
    if (listElement) observer.observe(listElement);
    for (const element of triggerElements.values()) observer.observe(element);
    for (const element of contentElements.values()) observer.observe(element);
  };
  const mountGeometryPart = (kind: "indicator" | "viewport", element: Element): Cleanup => {
    if (kind === "indicator") indicatorCleanup?.();
    else viewportCleanup?.();
    const htmlElement = element as HTMLElement;
    if (kind === "indicator") indicatorElement = htmlElement;
    else viewportElement = htmlElement;
    const view = element.ownerDocument?.defaultView;
    const Resize = view?.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    const observer = Resize ? new Resize(syncGeometry) as ElementResizeObserver : undefined;
    if (observer) {
      geometryObservers.add(observer);
      observeGeometryTargets(observer);
    }
    view?.addEventListener?.("resize", syncGeometry);
    syncGeometry();
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      observer?.disconnect();
      if (observer) geometryObservers.delete(observer);
      view?.removeEventListener?.("resize", syncGeometry);
      if (kind === "indicator" && indicatorElement === htmlElement) indicatorElement = null;
      if (kind === "viewport" && viewportElement === htmlElement) viewportElement = null;
      if (kind === "indicator" && indicatorCleanup === cleanup) indicatorCleanup = undefined;
      if (kind === "viewport" && viewportCleanup === cleanup) viewportCleanup = undefined;
    };
    if (kind === "indicator") indicatorCleanup = cleanup;
    else viewportCleanup = cleanup;
    return cleanup;
  };
  const stopGeometryState = effect(() => {
    state.value.value;
    deferFocus(syncGeometry);
  });
  let pendingPopupReason: NavigationMenuChangeReason | undefined;
  const popup = createPopover({
    id: `${id}-flyout`,
    open: () => state.value.value !== null,
    onOpenChange(open, details) {
      if (!open && state.value.peek() !== null) {
        const reason: NavigationMenuChangeReason = pendingPopupReason
          ?? (details.reason === "outside-press" || details.reason === "escape-key" || details.reason === "focus-out" || details.reason === "backdrop-press"
            ? "dismiss"
            : details.reason === "hover" || details.reason === "focus" || details.reason === "trigger-press"
              ? details.reason
              : "programmatic");
        if (!state.set(null, reason, details.event)) details.cancel();
      }
    },
    modal: false,
    closeOnFocusOutside: true,
    side: options.side,
    align: options.align,
    sideOffset: options.sideOffset,
    alignOffset: options.alignOffset,
    collisionPadding: options.collisionPadding,
    avoidCollisions: options.avoidCollisions,
    direction: direction === "auto" ? undefined : direction,
  });
  const stopAnchorState = effect(() => {
    const value = state.value.value;
    if (value !== null) popup.triggerElement.value = triggerElements.get(value) ?? popup.triggerElement.peek();
  });
  const focusAt = (index: number, event?: Event) => {
    if (index < 0 || index >= items.length || readBoolean(items[index]!.disabled)) return false;
    focusedIndex.value = index;
    return focusValue(items[index]!.value, triggerElements, event, `${itemId(id, items, items[index]!.value)}-control`);
  };
  const open = (value: Value, reason: NavigationMenuChangeReason = "programmatic", event?: Event) => {
    const item = definition(value);
    if (item.kind === "link" || readBoolean(item.disabled)) return false;
    clearOpen();
    clearClose();
    const previous = state.value.peek();
    // Prime the controlled popup before its `open` getter changes. Overlay
    // autofocus/restoration policy is selected at activation time, so writing
    // the navigation value first would make hover/focus opens look programmatic.
    popup.show(reason === "hover" || reason === "focus" || reason === "trigger-press" ? reason : "programmatic", event);
    const changed = state.set(value, reason, event);
    if (changed || previous === value) {
      popup.triggerElement.value = triggerElements.get(value) ?? popup.triggerElement.peek();
      syncGeometry();
      deferFocus(syncGeometry);
    }
    return changed;
  };
  const close = (reason: NavigationMenuChangeReason = "programmatic", event?: Event) => {
    clearOpen();
    clearClose();
    pendingPopupReason = reason;
    try {
      const changed = popup.hide(reason === "hover" || reason === "focus" || reason === "trigger-press" ? reason : reason === "dismiss" ? "focus-out" : "programmatic", event);
      syncGeometry();
      return changed;
    } finally {
      pendingPopupReason = undefined;
    }
  };
  const scheduleOpen = (value: Value, event: Event) => {
    clearClose();
    clearOpen();
    openTimer = setTimeout(() => open(value, "hover", event), openDelay);
    (openTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  const scheduleClose = (event: Event) => {
    clearOpen();
    clearClose();
    closeTimer = setTimeout(() => close("hover", event), closeDelay);
    (closeTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  const move = (index: number, event: KeyboardEvent) => {
    const textDirection = resolveDirection(direction, event.currentTarget as Element);
    const intent = getCollectionNavigationIntent(event.key, orientation, textDirection);
    if (!intent || intent === "page-next" || intent === "page-previous") return false;
    const next = findCollectionIndex(items, index, intent, { loop: options.loop !== false, disabled: (item) => readBoolean(item.disabled) });
    return next >= 0 && focusAt(next, event);
  };
  const controlProps = (value: Value, expected: "trigger" | "link", partOptions: CollectionAgentPartOptions = {}) => {
    const item = definition(value);
    const kind = item.kind ?? "trigger";
    if (kind !== expected) throw new TypeError(`NavigationMenu ${expected} requires a ${expected} definition.`);
    const index = indexOfValue(items, value);
    const isTrigger = kind === "trigger";
    return {
      id: `${itemId(id, items, value)}-control`,
      ...(isTrigger ? {
        type: "button",
        "aria-expanded": () => state.value.value === value,
        "aria-controls": `${itemId(id, items, value)}-content`,
        "aria-haspopup": true,
      } : {
        href: (item as NavigationMenuLinkDefinition<Value>).href,
        ...((item as NavigationMenuLinkDefinition<Value>).target ? { target: (item as NavigationMenuLinkDefinition<Value>).target } : {}),
        ...((item as NavigationMenuLinkDefinition<Value>).rel ? { rel: (item as NavigationMenuLinkDefinition<Value>).rel } : {}),
        ...((item as NavigationMenuLinkDefinition<Value>).current ? { "aria-current": (item as NavigationMenuLinkDefinition<Value>).current === true ? "page" : (item as NavigationMenuLinkDefinition<Value>).current } : {}),
      }),
      tabIndex: () => rovingIndex.value === index ? 0 : -1,
      "aria-disabled": () => itemDisabled(value) || undefined,
      "data-open": () => state.value.value === value ? "" : undefined,
      ...(isTrigger ? { "data-popup-open": () => state.value.value === value ? "" : undefined } : {}),
      "data-active": () => kind === "link" && Boolean((item as NavigationMenuLinkDefinition<Value>).current) ? "" : undefined,
      "data-disabled": () => itemDisabled(value) ? "" : undefined,
      "data-orientation": orientation,
      "data-clank-part": kind,
      ...agentProps(partOptions),
      ref: (element: HTMLElement | null) => {
        const previous = triggerElements.get(value) ?? null;
        unobserveGeometryElement(previous);
        if (element) {
          triggerElements.set(value, element);
          observeGeometryElement(element);
        } else triggerElements.delete(value);
        if (state.value.peek() === value) popup.triggerElement.value = element;
        syncGeometry();
      },
      onFocus: () => { if (!itemDisabled(value)) focusedIndex.value = index; },
      onPointerEnter: (event: PointerEvent) => {
        if (event.pointerType === "touch" || itemDisabled(value)) return;
        focusedIndex.value = index;
        if (isTrigger && options.openOnHover !== false) scheduleOpen(value, event);
      },
      onPointerLeave: (event: PointerEvent) => {
        if (event.pointerType !== "touch" && isTrigger && options.openOnHover !== false) scheduleClose(event);
      },
      onClick: (event: Event) => {
        if (event.defaultPrevented) return;
        if (itemDisabled(value)) {
          event.preventDefault();
          return;
        }
        if (isTrigger) {
          state.value.peek() === value ? close("trigger-press", event) : open(value, "trigger-press", event);
          event.preventDefault();
        } else if ((item as NavigationMenuLinkDefinition<Value>).closeOnClick === true) {
          close("trigger-press", event);
        }
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        if (move(index, event)) {
          event.preventDefault();
          return;
        }
        const textDirection = resolveDirection(direction, event.currentTarget as Element);
        const openFirstKey = orientation === "horizontal" ? "ArrowDown" : textDirection === "rtl" ? "ArrowLeft" : "ArrowRight";
        const openLastKey = orientation === "horizontal" ? "ArrowUp" : undefined;
        if (isTrigger && (event.key === openFirstKey || event.key === openLastKey)) {
          const wasOpen = state.value.peek() === value;
          const changed = open(value, "keyboard", event);
          if (wasOpen || (changed && state.value.peek() === value)) {
            deferFocus(() => focusContent(contentElements.get(value), event.key === openLastKey ? "last" : "first"));
          }
          event.preventDefault();
          return;
        }
        if (event.key === "Escape" && state.value.peek() !== null) {
          close("dismiss", event);
          focusAt(index, event);
          event.preventDefault();
          return;
        }
        const match = typeahead.search(event.key, items, index);
        if (match >= 0) {
          event.preventDefault();
          focusAt(match, event);
        }
      },
    };
  };
  return {
    id,
    value: state.value,
    focusedValue,
    open,
    close,
    toggle(value, event) { return state.value.peek() === value ? close("trigger-press", event) : open(value, "trigger-press", event); },
    focusValue(value, event) {
      definition(value);
      return focusAt(indexOfValue(items, value), event);
    },
    root: () => ({
      id,
      role: "navigation",
      ...(options.label ? { "aria-label": options.label } : {}),
      ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
      "data-orientation": orientation,
      "data-clank-part": "root",
    }),
    list: () => ({
      "data-orientation": orientation,
      "data-clank-part": "list",
      ref: (element: HTMLElement | null) => {
        unobserveGeometryElement(listElement);
        listElement = element;
        observeGeometryElement(element);
        syncGeometry();
      },
    }),
    item(value) {
      definition(value);
      return {
        id: itemId(id, items, value),
        "data-open": () => state.value.value === value ? "" : undefined,
        "data-clank-part": "item",
      };
    },
    trigger: (value, partOptions = {}) => controlProps(value, "trigger", partOptions),
    icon(value) {
      const item = definition(value);
      if (item.kind === "link") throw new TypeError("NavigationMenu icon requires a trigger definition.");
      return {
        "aria-hidden": true,
        "data-open": () => state.value.value === value ? "" : undefined,
        "data-popup-open": () => state.value.value === value ? "" : undefined,
        "data-closed": () => state.value.value === value ? undefined : "",
        "data-disabled": () => itemDisabled(value) ? "" : undefined,
        "data-orientation": orientation,
        "data-clank-part": "icon",
      };
    },
    link: (value, partOptions = {}) => controlProps(value, "link", partOptions),
    isMounted: (portalOptions = {}) => popup.isMounted(portalOptions),
    portal: (portalOptions = {}) => popup.portal(portalOptions),
    positioner: () => popup.positioner(),
    popup: () => mergeProps(popup.popup({ role: "navigation", labelledBy: false, describedBy: false }), {
      ...(popupLabel ? { "aria-label": popupLabel } : {}),
      ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
      "data-orientation": orientation,
      "data-clank-part": "popup",
      onPointerEnter: clearClose,
      onPointerLeave: (event: PointerEvent) => { if (event.pointerType !== "touch" && options.openOnHover !== false) scheduleClose(event); },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const value = state.value.peek();
        close("dismiss", event);
        if (value !== null) focusValue(value, triggerElements, event, `${itemId(id, items, value)}-control`);
        event.preventDefault();
      },
    }),
    viewport: () => mergeProps(popup.viewport(), {
      "data-value": () => state.value.value ?? undefined,
      "data-orientation": orientation,
      "data-clank-part": "viewport",
      use: (element: Element) => mountGeometryPart("viewport", element),
    }),
    content(value) {
      const item = definition(value);
      if (item.kind === "link") throw new TypeError("NavigationMenu content requires a trigger definition.");
      return {
        id: `${itemId(id, items, value)}-content`,
        role: "region",
        "aria-labelledby": `${itemId(id, items, value)}-control`,
        hidden: () => state.value.value !== value,
        "data-open": () => state.value.value === value ? "" : undefined,
        "data-closed": () => state.value.value === value ? undefined : "",
        "data-orientation": orientation,
        "data-clank-part": "content",
        ref: (element: HTMLElement | null) => {
          const previous = contentElements.get(value) ?? null;
          unobserveGeometryElement(previous);
          if (element) {
            contentElements.set(value, element);
            observeGeometryElement(element);
          } else contentElements.delete(value);
          syncGeometry();
        },
        onPointerEnter: clearClose,
        onPointerLeave: (event: PointerEvent) => { if (event.pointerType !== "touch" && options.openOnHover !== false) scheduleClose(event); },
      };
    },
    indicator: () => ({
      "aria-hidden": true,
      hidden: () => state.value.value === null,
      "data-value": () => state.value.value ?? undefined,
      "data-orientation": orientation,
      "data-clank-part": "indicator",
      style: {
        "--clank-navigation-menu-active-index": () => state.value.value === null ? -1 : indexOfValue(items, state.value.value),
        "--clank-navigation-menu-count": items.length,
      },
      use: (element: Element) => mountGeometryPart("indicator", element),
    }),
    arrow: () => popup.arrow(),
    backdrop: () => popup.backdrop(),
    manifest: () => createUiManifest({
      component: "NavigationMenu",
      id,
      state: { value: state.value.peek(), focusedValue: focusedValue.peek(), orientation, direction },
      parts: [
        { name: "root", role: "navigation", defaultElement: "nav", required: true },
        { name: "list", defaultElement: "ul", required: true },
        { name: "item", defaultElement: "li", required: true },
        { name: "trigger", role: "button", defaultElement: "button" },
        { name: "icon", defaultElement: "span" },
        { name: "content", role: "region", defaultElement: "div" },
        { name: "link", defaultElement: "a" },
        { name: "portal", defaultElement: "div" },
        { name: "backdrop", defaultElement: "div" },
        { name: "positioner", defaultElement: "div" },
        { name: "popup", role: "navigation", defaultElement: "nav" },
        { name: "arrow", defaultElement: "div" },
        { name: "viewport", defaultElement: "div" },
        { name: "indicator", defaultElement: "span" },
      ],
      actions: [
        { name: "open", description: "Open one navigation content panel.", sideEffects: "write", reasons: ["trigger-press", "keyboard", "hover", "focus", "programmatic"] },
        { name: "close", description: "Close the navigation content panel.", sideEffects: "write", reasons: ["dismiss", "programmatic"] },
        { name: "toggle", description: "Toggle one navigation content panel.", sideEffects: "write", reasons: ["trigger-press"] },
        { name: "focusValue", description: "Move roving focus to one navigation control.", sideEffects: "none" },
      ],
      keyboard: {
        ArrowLeft: "Move across a horizontal list, respecting text direction",
        ArrowRight: "Move across a horizontal list, respecting text direction",
        ArrowUp: "Move vertically or open a trigger and focus the last content control",
        ArrowDown: "Move vertically or open a trigger and focus the first content control",
        Home: "Focus the first enabled control",
        End: "Focus the last enabled control",
        Escape: "Close content and restore trigger focus",
      },
    }),
    dispose() {
      clearOpen();
      clearClose();
      indicatorCleanup?.();
      viewportCleanup?.();
      for (const observer of geometryObservers) observer.disconnect();
      geometryObservers.clear();
      stopGeometryState();
      stopAnchorState();
      typeahead.dispose();
      popup.dispose();
    },
  };
}

interface ToolbarItemBase<Value extends string> extends CollectionItemDefinition<Value> {}

export interface ToolbarButtonDefinition<Value extends string> extends ToolbarItemBase<Value> {
  kind?: "button";
  type?: "button" | "submit" | "reset";
  /** Group whose disabled state applies to this control. */
  group?: Value;
  /** Whether the control remains in the roving focus order while disabled. Defaults to true. */
  focusableWhenDisabled?: boolean;
  onPress?: (details: ChangeDetails<ToolbarPressReason>) => void;
}

export interface ToolbarLinkDefinition<Value extends string> extends ToolbarItemBase<Value> {
  kind: "link";
  href: string;
  target?: string;
  rel?: string;
  /** Group whose disabled state applies to this control. */
  group?: Value;
}

export interface ToolbarInputDefinition<Value extends string> extends ToolbarItemBase<Value> {
  kind: "input";
  type?: "text" | "search" | "url" | "email" | "tel";
  name?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Group whose disabled state applies to this control. */
  group?: Value;
  /** Whether the control remains in the roving focus order while disabled. Defaults to true. */
  focusableWhenDisabled?: boolean;
}

export interface ToolbarGroupDefinition<Value extends string> extends ToolbarItemBase<Value> {
  kind: "group";
  label?: string;
  labelledBy?: string;
}

export interface ToolbarSeparatorDefinition<Value extends string> extends ToolbarItemBase<Value> {
  kind: "separator";
  decorative?: boolean;
}

export type ToolbarItemDefinition<Value extends string> =
  | ToolbarButtonDefinition<Value>
  | ToolbarLinkDefinition<Value>
  | ToolbarInputDefinition<Value>
  | ToolbarGroupDefinition<Value>
  | ToolbarSeparatorDefinition<Value>;

export type ToolbarPressReason = "press" | "programmatic";

export interface ToolbarOptions<Value extends string> {
  id: string;
  items: readonly ToolbarItemDefinition<Value>[];
  disabled?: CollectionReadable<boolean>;
  orientation?: Orientation;
  direction?: Direction | "auto";
  loop?: boolean;
  /** Base UI-compatible alias for `loop`. */
  loopFocus?: boolean;
  label?: string;
  labelledBy?: string;
  defaultFocusedValue?: Value;
}

export interface ToolbarController<Value extends string> {
  readonly id: string;
  readonly focusedValue: Computed<Value | null>;
  focusValue(value: Value, event?: Event): boolean;
  press(value: Value, event?: Event, reason?: ToolbarPressReason): boolean;
  root(): Record<string, unknown>;
  item(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  button(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  link(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  input(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  group(value: Value): Record<string, unknown>;
  separator(value: Value): Record<string, unknown>;
  manifest(): UiManifest;
}

/** A single-Tab-stop toolbar with logical-direction roving and editable inputs. */
export function createToolbar<Value extends string>(options: ToolbarOptions<Value>): ToolbarController<Value> {
  const id = requireId(options.id, "Toolbar");
  const direction = options.direction ?? useDirection();
  const items = normalizeToolbarItems(options.items);
  const interactive = items.filter(isToolbarInteractive);
  const disabled = () => readBoolean(options.disabled);
  const groupFor = (item: ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value>) => {
    if (item.group === undefined) return undefined;
    return requireKind(requireDefinition(items, item.group, "Toolbar"), "group", "Toolbar control group") as ToolbarGroupDefinition<Value>;
  };
  const effectiveDisabled = (item: ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value>) =>
    disabled() || readBoolean(item.disabled) || readBoolean(groupFor(item)?.disabled);
  const remainsFocusable = (item: ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value>) => {
    const kind = item.kind ?? "button";
    return effectiveDisabled(item)
      && (kind === "button" || kind === "input")
      && (item as ToolbarButtonDefinition<Value> | ToolbarInputDefinition<Value>).focusableWhenDisabled !== false;
  };
  const isFocusable = (item: ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value>) =>
    !effectiveDisabled(item) || remainsFocusable(item);
  const firstEnabled = interactive.find(isFocusable);
  const initial = options.defaultFocusedValue === undefined
    ? firstEnabled?.value ?? null
    : (() => {
      const item = interactive.find((candidate) => candidate.value === options.defaultFocusedValue);
      if (!item || !isFocusable(item)) throw new TypeError("Toolbar defaultFocusedValue must identify a focusable interactive item.");
      return item.value;
    })();
  const focusedIndex = signal(initial === null ? -1 : indexOfValue(interactive, initial), { name: `${id}.focusedIndex` });
  const rovingIndex = computed(
    () => recoverEnabledIndex(interactive, focusedIndex.value, (item) => !isFocusable(item)),
    { name: `${id}.rovingIndex` },
  );
  const focusedValue = computed(() => interactive[rovingIndex.value]?.value ?? null, { name: `${id}.focusedValue` });
  const elements = new Map<Value, HTMLElement>();
  const orientation = options.orientation ?? "horizontal";
  const definition = (value: Value) => requireDefinition(items, value, "Toolbar");
  const interactiveDefinition = (value: Value) => {
    const item = definition(value);
    if (!isToolbarInteractive(item)) throw new TypeError("Toolbar focus requires a button, link, or input definition.");
    return item;
  };
  const interactiveIndex = (value: Value) => indexOfValue(interactive, value);
  const itemDisabled = (value: Value) => effectiveDisabled(interactiveDefinition(value));
  const focusAt = (index: number, event?: Event) => {
    if (index < 0 || index >= interactive.length || !isFocusable(interactive[index]!)) return false;
    focusedIndex.value = index;
    return focusValue(interactive[index]!.value, elements, event, `${itemId(id, items, interactive[index]!.value)}-control`);
  };
  const move = (value: Value, event: KeyboardEvent) => {
    const textDirection = resolveDirection(direction, event.currentTarget as Element);
    const intent = getCollectionNavigationIntent(event.key, orientation, textDirection);
    if (!intent || intent === "page-next" || intent === "page-previous") return false;
    const index = interactiveIndex(value);
    const next = findCollectionIndex(interactive, index, intent, {
      loop: options.loopFocus ?? options.loop ?? true,
      disabled: (item) => !isFocusable(item),
    });
    return next >= 0 && focusAt(next, event);
  };
  const press = (value: Value, event?: Event, reason: ToolbarPressReason = "programmatic") => {
    const item = requireKind(interactiveDefinition(value), "button", "Toolbar button") as ToolbarButtonDefinition<Value>;
    if (effectiveDisabled(item)) return false;
    const details = createChangeDetails(reason, event);
    item.onPress?.(details);
    return !details.canceled;
  };
  const controlProps = (value: Value, expected: "button" | "link" | "input", partOptions: CollectionAgentPartOptions = {}) => {
    const item = requireKind(interactiveDefinition(value), expected, `Toolbar ${expected}`);
    const index = interactiveIndex(value);
    const disabled = () => itemDisabled(value);
    const focusable = () => remainsFocusable(item);
    const nativeDisabled = () => disabled() && !focusable();
    return {
      id: `${itemId(id, items, value)}-control`,
      ...(expected === "button" ? { type: (item as ToolbarButtonDefinition<Value>).type ?? "button", disabled: nativeDisabled } : {}),
      ...(expected === "link" ? {
        href: (item as ToolbarLinkDefinition<Value>).href,
        ...((item as ToolbarLinkDefinition<Value>).target ? { target: (item as ToolbarLinkDefinition<Value>).target } : {}),
        ...((item as ToolbarLinkDefinition<Value>).rel ? { rel: (item as ToolbarLinkDefinition<Value>).rel } : {}),
      } : {}),
      ...(expected === "input" ? {
        type: (item as ToolbarInputDefinition<Value>).type ?? "text",
        ...((item as ToolbarInputDefinition<Value>).name ? { name: (item as ToolbarInputDefinition<Value>).name } : {}),
        ...((item as ToolbarInputDefinition<Value>).placeholder ? { placeholder: (item as ToolbarInputDefinition<Value>).placeholder } : {}),
        ...((item as ToolbarInputDefinition<Value>).defaultValue !== undefined ? { defaultValue: (item as ToolbarInputDefinition<Value>).defaultValue } : {}),
        disabled: nativeDisabled,
        readOnly: () => disabled() && focusable() || undefined,
      } : {}),
      tabIndex: () => rovingIndex.value === index ? 0 : -1,
      "aria-disabled": () => disabled() || undefined,
      "data-focusable": () => focusable() ? "" : undefined,
      "data-highlighted": () => rovingIndex.value === index ? "" : undefined,
      "data-disabled": () => disabled() ? "" : undefined,
      "data-orientation": orientation,
      "data-clank-part": expected,
      ...agentProps(partOptions),
      ref: (element: HTMLElement | null) => {
        if (element) elements.set(value, element);
        else elements.delete(value);
      },
      onFocus: () => { if (isFocusable(item)) focusedIndex.value = index; },
      ...(expected === "button" ? {
        onClick: (event: Event) => {
          if (event.defaultPrevented) return;
          if (disabled()) {
            event.preventDefault();
            return;
          }
          if (!press(value, event, "press")) {
            // Canceling the structured press cancels the control's native
            // activation (notably submit/reset) without swallowing the DOM
            // event from ancestor listeners.
            event.preventDefault();
          }
        },
      } : expected === "link" ? {
        onClick: (event: Event) => { if (disabled()) event.preventDefault(); },
      } : {}),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        if (expected === "input" && isTextEditingKey(event.key, orientation)) return;
        if (move(value, event)) {
          event.preventDefault();
          return;
        }
        if (expected === "button") activateCustomButton(event, disabled, () => press(value, event, "press"));
      },
    };
  };
  return {
    id,
    focusedValue,
    focusValue(value, event) {
      interactiveDefinition(value);
      return focusAt(interactiveIndex(value), event);
    },
    press,
    root: () => ({
      id,
      role: "toolbar",
      "aria-orientation": orientation,
      "aria-disabled": () => disabled() || undefined,
      ...(options.label ? { "aria-label": options.label } : {}),
      ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
      "data-orientation": orientation,
      "data-disabled": () => disabled() ? "" : undefined,
      "data-clank-part": "root",
    }),
    item(value, partOptions = {}) {
      const item = definition(value);
      const kind = item.kind ?? "button";
      if (kind === "button" || kind === "link" || kind === "input") return controlProps(value, kind, partOptions);
      if (kind === "group") {
        const group = item as ToolbarGroupDefinition<Value>;
        const groupDisabled = () => disabled() || readBoolean(group.disabled);
        return {
          id: itemId(id, items, value),
          role: "group",
          ...(group.label ? { "aria-label": group.label } : {}),
          ...(group.labelledBy ? { "aria-labelledby": group.labelledBy } : {}),
          "aria-disabled": () => groupDisabled() || undefined,
          "data-disabled": () => groupDisabled() ? "" : undefined,
          "data-orientation": orientation,
          "data-clank-part": "group",
        };
      }
      const separator = item as ToolbarSeparatorDefinition<Value>;
      return {
        id: itemId(id, items, value),
        role: separator.decorative ? "presentation" : "separator",
        ...(separator.decorative ? { "aria-hidden": true } : { "aria-orientation": orientation === "horizontal" ? "vertical" : "horizontal" }),
        "data-orientation": orientation === "horizontal" ? "vertical" : "horizontal",
        "data-clank-part": "separator",
      };
    },
    button: (value, partOptions = {}) => controlProps(value, "button", partOptions),
    link: (value, partOptions = {}) => controlProps(value, "link", partOptions),
    input: (value, partOptions = {}) => controlProps(value, "input", partOptions),
    group(value) {
      const item = requireKind(definition(value), "group", "Toolbar group") as ToolbarGroupDefinition<Value>;
      const groupDisabled = () => disabled() || readBoolean(item.disabled);
      return {
        id: itemId(id, items, value),
        role: "group",
        ...(item.label ? { "aria-label": item.label } : {}),
        ...(item.labelledBy ? { "aria-labelledby": item.labelledBy } : {}),
        "aria-disabled": () => groupDisabled() || undefined,
        "data-disabled": () => groupDisabled() ? "" : undefined,
        "data-orientation": orientation,
        "data-clank-part": "group",
      };
    },
    separator(value) {
      const item = requireKind(definition(value), "separator", "Toolbar separator") as ToolbarSeparatorDefinition<Value>;
      const separatorOrientation = orientation === "horizontal" ? "vertical" : "horizontal";
      return {
        id: itemId(id, items, value),
        role: item.decorative ? "presentation" : "separator",
        ...(item.decorative ? { "aria-hidden": true } : { "aria-orientation": separatorOrientation }),
        "data-orientation": separatorOrientation,
        "data-clank-part": "separator",
      };
    },
    manifest: () => createUiManifest({
      component: "Toolbar",
      id,
      state: { focusedValue: focusedValue.peek(), orientation, direction, disabled: disabled() },
      parts: [
        { name: "root", role: "toolbar", defaultElement: "div", required: true },
        { name: "button", role: "button", defaultElement: "button" },
        { name: "link", defaultElement: "a" },
        { name: "input", defaultElement: "input" },
        { name: "group", role: "group", defaultElement: "div" },
        { name: "separator", role: "separator", defaultElement: "div" },
      ],
      actions: [
        { name: "focusValue", description: "Move the toolbar's roving focus target.", sideEffects: "none" },
        { name: "press", description: "Activate an enabled toolbar button.", sideEffects: "write", reasons: ["press", "programmatic"] },
      ],
      keyboard: {
        ArrowLeft: "Move horizontally, respecting text direction",
        ArrowRight: "Move horizontally, respecting text direction",
        ArrowUp: "Move through a vertical toolbar",
        ArrowDown: "Move through a vertical toolbar",
        Home: "Focus the first enabled control",
        End: "Focus the last enabled control",
        Tab: "Enter or leave the toolbar as one document Tab stop",
      },
    }),
  };
}

function requireId(value: string, component: string): string {
  const id = value?.trim();
  if (!id || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new TypeError(`${component} id must start with a letter and contain only letters, numbers, _, ., :, or -.`);
  }
  return id;
}

function readValue<Value>(value: CollectionReadable<Value>): Value {
  return typeof value === "function" ? (value as () => Value)() : value;
}

function readBoolean(value: CollectionReadable<boolean> | undefined): boolean {
  return value === undefined ? false : Boolean(readValue(value));
}

function normalizeCollection<Value extends string, Item extends CollectionItemDefinition<Value>>(
  source: readonly Item[],
  component: string,
): readonly Item[] {
  if (!Array.isArray(source) || source.length === 0) throw new TypeError(`${component} requires at least one item.`);
  const values = new Set<string>();
  return Object.freeze(source.map((item, index) => {
    if (!item || typeof item !== "object") throw new TypeError(`${component} item ${index + 1} must be an object.`);
    if (typeof item.value !== "string" || item.value.length === 0) throw new TypeError(`${component} item values must be non-empty strings.`);
    if (values.has(item.value)) throw new TypeError(`${component} item values must be unique.`);
    values.add(item.value);
    if (typeof item.textValue !== "string" || item.textValue.trim().length === 0) throw new TypeError(`${component} item textValue must be a non-empty string.`);
    return Object.freeze({ ...item, textValue: item.textValue.trim() }) as Item;
  }));
}

function requireDefinition<Value extends string, Item extends CollectionItemDefinition<Value>>(
  items: readonly Item[],
  value: Value,
  component: string,
): Item {
  const item = items.find((candidate) => candidate.value === value);
  if (!item) throw new RangeError(`${component} does not contain value ${String(value)}.`);
  return item;
}

function indexOfValue<Value extends string>(items: readonly CollectionItemDefinition<Value>[], value: Value): number {
  return items.findIndex((item) => item.value === value);
}

function itemId<Value extends string>(id: string, items: readonly CollectionItemDefinition<Value>[], value: Value): string {
  const index = indexOfValue(items, value);
  if (index < 0) throw new RangeError(`Unknown collection value ${String(value)}.`);
  return `${id}-item-${index + 1}`;
}

function tabPartId<Value extends string>(
  id: string,
  items: readonly CollectionItemDefinition<Value>[],
  value: Value,
  legacy: boolean,
): string {
  return legacy ? `${id}-tab-${legacyDomToken(value, items)}` : `${itemId(id, items, value)}-tab`;
}

function tabPanelId<Value extends string>(
  id: string,
  items: readonly CollectionItemDefinition<Value>[],
  value: Value,
  legacy: boolean,
): string {
  return legacy ? `${id}-panel-${legacyDomToken(value, items)}` : `${itemId(id, items, value)}-panel`;
}

function legacyDomToken<Value extends string>(
  value: Value,
  items: readonly CollectionItemDefinition<Value>[],
): string {
  const token = sanitizeLegacyDomToken(value);
  if (!token || !/[A-Za-z0-9]/.test(token)) throw new TypeError("Tab values must contain a letter or number.");
  const index = indexOfValue(items, value);
  const collisions = items.filter((item) => sanitizeLegacyDomToken(item.value) === token);
  return collisions.length > 1 ? `${token}-${index + 1}` : token;
}

function sanitizeLegacyDomToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function normalizeNullableValue<Value extends string>(
  value: Value | null,
  items: readonly CollectionItemDefinition<Value>[],
  label: string,
): Value | null {
  if (value === null) return null;
  if (indexOfValue(items, value) < 0) throw new TypeError(`${label} must identify an item.`);
  return value;
}

function normalizeValues<Value extends string>(
  values: readonly Value[],
  items: readonly CollectionItemDefinition<Value>[],
  label: string,
): readonly Value[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const unique = new Set<Value>();
  for (const value of values) {
    if (indexOfValue(items, value) < 0) throw new TypeError(`${label} contains an unknown item.`);
    unique.add(value);
  }
  return Object.freeze(collectionOrder([...unique], items));
}

function collectionOrder<Value extends string>(values: readonly Value[], items: readonly CollectionItemDefinition<Value>[]): Value[] {
  const selected = new Set(values);
  return items.flatMap((item) => selected.has(item.value) ? [item.value] : []);
}

function accordionValuesEqual(previous: string | null | readonly string[], next: string | null | readonly string[]): boolean {
  return Array.isArray(previous) && Array.isArray(next) ? shallowArrayEqual(previous, next) : previous === next;
}

function shallowArrayEqual(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((entry, index) => Object.is(entry, next[index]));
}

function shallowRecordEqual(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  return previousKeys.length === nextKeys.length && previousKeys.every((key) => Object.is(previous[key], next[key]));
}

function requireHeadingLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new RangeError("Accordion heading level must be an integer from 1 through 6.");
  return level;
}

function agentProps(options: CollectionAgentPartOptions): Record<string, string> {
  return {
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.agentLabel ? { agentLabel: options.agentLabel } : {}),
    ...(options.agentDescription ? { agentDescription: options.agentDescription } : {}),
  };
}

function activateCustomButton(event: KeyboardEvent, blocked: () => boolean, activate: () => void): void {
  if (event.defaultPrevented || blocked() || (event.key !== "Enter" && event.key !== " ")) return;
  const element = event.currentTarget as Element | null;
  const name = String(element?.localName ?? "").toLowerCase();
  if (name === "button" || (name === "input" && ["button", "submit", "reset"].includes(String((element as HTMLInputElement).type).toLowerCase()))) return;
  activate();
  event.preventDefault();
}

function focusValue<Value extends string>(
  value: Value,
  elements: ReadonlyMap<Value, HTMLElement>,
  event: Event | undefined,
  fallbackId: string,
): boolean {
  const element = elements.get(value) ?? (event?.currentTarget as HTMLElement | null)?.ownerDocument?.getElementById?.(fallbackId) as HTMLElement | null;
  if (!element || typeof element.focus !== "function") return false;
  try { element.focus({ preventScroll: true }); }
  catch { try { element.focus(); } catch { return false; } }
  return true;
}

function deferFocus(callback: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function syncTabsIndicator(
  list: HTMLElement | null,
  indicator: HTMLElement | null,
  tab: HTMLElement | null,
  count: number,
  index: number,
): void {
  if (!indicator?.style?.setProperty) return;
  indicator.style.setProperty("--clank-tabs-active-index", String(index));
  indicator.style.setProperty("--clank-tabs-count", String(count));
  if (!list || !tab || typeof list.getBoundingClientRect !== "function" || typeof tab.getBoundingClientRect !== "function") return;
  const parent = list.getBoundingClientRect();
  const active = tab.getBoundingClientRect();
  indicator.style.setProperty("--clank-tabs-indicator-left", `${active.left - parent.left}px`);
  indicator.style.setProperty("--clank-tabs-indicator-top", `${active.top - parent.top}px`);
  indicator.style.setProperty("--clank-tabs-indicator-width", `${active.width}px`);
  indicator.style.setProperty("--clank-tabs-indicator-height", `${active.height}px`);
}

interface ElementResizeObserver {
  observe(target: Element): void;
  unobserve?(target: Element): void;
  disconnect(): void;
}

/** Synchronizes optional navigation indicator and clipping viewport geometry without styling them. */
function syncNavigationMenuGeometry(
  list: HTMLElement | null,
  indicator: HTMLElement | null,
  trigger: HTMLElement | null,
  viewport: HTMLElement | null,
  content: HTMLElement | null,
  count: number,
  index: number,
): void {
  if (indicator?.style?.setProperty) {
    indicator.style.setProperty("--clank-navigation-menu-active-index", String(index));
    indicator.style.setProperty("--clank-navigation-menu-count", String(count));
    if (list && trigger && typeof list.getBoundingClientRect === "function" && typeof trigger.getBoundingClientRect === "function") {
      const parent = list.getBoundingClientRect();
      const active = trigger.getBoundingClientRect();
      indicator.style.setProperty("--clank-navigation-menu-indicator-left", `${active.left - parent.left}px`);
      indicator.style.setProperty("--clank-navigation-menu-indicator-top", `${active.top - parent.top}px`);
      indicator.style.setProperty("--clank-navigation-menu-indicator-width", `${active.width}px`);
      indicator.style.setProperty("--clank-navigation-menu-indicator-height", `${active.height}px`);
    }
  }
  if (viewport?.style?.setProperty && content && typeof content.getBoundingClientRect === "function") {
    const active = content.getBoundingClientRect();
    viewport.style.setProperty("--clank-navigation-menu-viewport-width", `${active.width}px`);
    viewport.style.setProperty("--clank-navigation-menu-viewport-height", `${active.height}px`);
  }
}

function normalizeMenuItems<Value extends string>(items: readonly MenuItemDefinition<Value>[], component: string): readonly MenuItemDefinition<Value>[] {
  const normalized = normalizeCollection(items, component);
  for (const item of normalized) {
    const kind = item.kind ?? "item";
    if (!["item", "link", "checkbox", "radio", "submenu"].includes(kind)) throw new TypeError(`${component} contains an invalid item kind.`);
    if (kind === "link" && !safeHref((item as MenuLinkItemDefinition<Value>).href)) throw new TypeError(`${component} link href must be a safe non-empty URL.`);
    if (kind === "radio" && !(item as MenuRadioItemDefinition<Value>).group?.trim()) throw new TypeError(`${component} radio items require a group.`);
    if (kind === "submenu") {
      const submenu = item as MenuSubmenuItemDefinition<Value>;
      if (!submenu.menu?.id) throw new TypeError(`${component} submenu items require a menu controller.`);
      finiteNonNegative(submenu.delay ?? 100, `${component} submenu delay`);
      finiteNonNegative(submenu.closeDelay ?? 100, `${component} submenu closeDelay`);
    }
  }
  return normalized;
}

function normalizeMenuChecked<Value extends string>(
  values: readonly Value[],
  items: readonly MenuItemDefinition<Value>[],
  label: string,
): readonly Value[] {
  const normalized = normalizeValues(values, items, label);
  for (const value of normalized) requireKind(requireDefinition(items, value, "Menu"), "checkbox", label);
  return normalized;
}

function normalizeMenuRadios<Value extends string>(
  values: Readonly<Record<string, Value | null>>,
  items: readonly MenuItemDefinition<Value>[],
  label: string,
): Readonly<Record<string, Value | null>> {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError(`${label} must be a record.`);
  const output: Record<string, Value | null> = {};
  for (const [group, value] of Object.entries(values) as Array<[string, Value | null]>) {
    if (!group.trim()) throw new TypeError(`${label} group names must not be empty.`);
    if (value !== null) {
      const item = requireKind(requireDefinition(items, value, "Menu"), "radio", label) as MenuRadioItemDefinition<Value>;
      if (item.group !== group) throw new TypeError(`${label} contains a value from the wrong radio group.`);
    }
    output[group] = value;
  }
  return Object.freeze(output);
}

function requireKind<Item extends { kind?: string }>(item: Item, expected: string, label: string): Item & { kind: typeof expected } {
  const actual = item.kind ?? (expected === "menu" ? "menu" : expected === "trigger" ? "trigger" : expected === "button" ? "button" : "item");
  if (actual !== expected) throw new TypeError(`${label} requires a ${expected} definition.`);
  return item as Item & { kind: typeof expected };
}

function menuManifest<Value extends string>(
  component: "Menu" | "ContextMenu",
  id: string,
  open: boolean,
  highlightedValue: Value | null,
  checked: readonly Value[],
  radios: Readonly<Record<string, Value | null>>,
  items: readonly MenuItemDefinition<Value>[],
): UiManifest {
  return createUiManifest({
    component,
    id,
    state: { open, highlightedValue, checkedValues: [...checked], radioValues: { ...radios }, items: items.map((item) => ({ value: item.value, kind: item.kind ?? "item", disabled: readBoolean(item.disabled) })) },
    parts: [
      component === "Menu"
        ? { name: "trigger", role: "button", defaultElement: "button" }
        : { name: "trigger", defaultElement: "div" },
      { name: "portal", defaultElement: "div" },
      { name: "backdrop", defaultElement: "div" },
      { name: "positioner", defaultElement: "div" },
      { name: "popup", role: "menu", defaultElement: "div", required: true },
      ...(component === "Menu" ? [{ name: "viewport", defaultElement: "div" }] : []),
      { name: "arrow", defaultElement: "div" },
      { name: "item", role: "menuitem", defaultElement: "div" },
      { name: "link-item", role: "menuitem", defaultElement: "a" },
      { name: "submenu-root" },
      { name: "submenu-trigger", role: "menuitem", defaultElement: "div" },
      { name: "group", role: "group", defaultElement: "div" },
      { name: "group-label", defaultElement: "div" },
      { name: "radio-group", role: "group", defaultElement: "div" },
      { name: "radio-item", role: "menuitemradio", defaultElement: "div" },
      { name: "radio-item-indicator", defaultElement: "span" },
      { name: "checkbox-item", role: "menuitemcheckbox", defaultElement: "div" },
      { name: "checkbox-item-indicator", defaultElement: "span" },
      { name: "separator", role: "separator", defaultElement: "div" },
    ],
    actions: [
      { name: "show", description: "Open the menu and optionally focus a boundary item.", sideEffects: "write" },
      { name: "hide", description: "Close the menu.", sideEffects: "write" },
      { name: "toggle", description: "Toggle the menu's open state.", sideEffects: "write" },
      { name: "highlight", description: "Change the active descendant for roving focus.", sideEffects: "write" },
      { name: "activate", description: "Activate an enabled menu item.", sideEffects: "write", reasons: ["item-press", "keyboard", "programmatic"] },
      { name: "setChecked", description: "Set a checkbox menu item's state.", sideEffects: "write" },
      { name: "selectRadio", description: "Select a radio item within its group.", sideEffects: "write" },
      { name: "openSubmenu", description: "Open a nested menu with direction-aware focus.", sideEffects: "write" },
    ],
    keyboard: {
      ...(component === "ContextMenu" ? {
        "Shift+F10": "Open the context menu from its keyboard target",
        ContextMenu: "Open the context menu from its keyboard target",
      } : {}),
      ArrowDown: "Focus the next enabled item",
      ArrowUp: "Focus the previous enabled item",
      Home: "Focus the first enabled item",
      End: "Focus the last enabled item",
      ArrowRight: "Open a submenu in left-to-right layouts or close it in right-to-left layouts",
      ArrowLeft: "Close a submenu in left-to-right layouts or open it in right-to-left layouts",
      Enter: "Activate the focused item",
      Space: "Activate the focused item",
      Escape: "Close and restore trigger focus",
      Tab: "Close without trapping document focus",
    },
  });
}

function normalizeMenubarItems<Value extends string>(items: readonly MenubarItemDefinition<Value>[]): readonly MenubarItemDefinition<Value>[] {
  const normalized = normalizeCollection(items, "Menubar");
  for (const item of normalized) {
    const kind = item.kind ?? "menu";
    if (kind === "link") {
      if (!safeHref((item as MenubarLinkDefinition<Value>).href)) throw new TypeError("Menubar link href must be a safe non-empty URL.");
    } else if (kind === "menu") {
      normalizeMenuItems((item as MenubarMenuDefinition<Value>).items, "Menubar menu");
    } else throw new TypeError("Menubar contains an invalid item kind.");
  }
  return normalized;
}

function normalizeNavigationItems<Value extends string>(items: readonly NavigationMenuItemDefinition<Value>[]): readonly NavigationMenuItemDefinition<Value>[] {
  const normalized = normalizeCollection(items, "NavigationMenu");
  for (const item of normalized) {
    const kind = item.kind ?? "trigger";
    if (kind !== "trigger" && kind !== "link") throw new TypeError("NavigationMenu contains an invalid item kind.");
    if (kind === "link" && !safeHref((item as NavigationMenuLinkDefinition<Value>).href)) throw new TypeError("NavigationMenu link href must be a safe non-empty URL.");
  }
  return normalized;
}

function normalizeNavigationValue<Value extends string>(
  value: Value | null,
  items: readonly NavigationMenuItemDefinition<Value>[],
  label: string,
): Value | null {
  const normalized = normalizeNullableValue(value, items, label);
  if (normalized !== null && requireDefinition(items, normalized, "NavigationMenu").kind === "link") throw new TypeError(`${label} must identify a trigger.`);
  return normalized;
}

function firstEnabledIndex<Value extends string>(items: readonly CollectionItemDefinition<Value>[]): number {
  return items.findIndex((item) => !readBoolean(item.disabled));
}

/**
 * Keeps a roving tab stop valid when an item's reactive disabled state changes.
 * Prefer the following enabled item, wrapping once, so disabling the current
 * target does not unexpectedly jump back to the beginning of the collection.
 */
function recoverEnabledIndex<Item>(
  items: readonly Item[],
  requestedIndex: number,
  disabled: (item: Item) => boolean,
): number {
  if (items.length === 0) return -1;
  if (requestedIndex >= 0 && requestedIndex < items.length && !disabled(items[requestedIndex]!)) return requestedIndex;
  const start = requestedIndex >= 0 && requestedIndex < items.length ? requestedIndex : -1;
  for (let offset = 1; offset <= items.length; offset++) {
    const index = (start + offset + items.length) % items.length;
    if (!disabled(items[index]!)) return index;
  }
  return -1;
}

function normalizeToolbarItems<Value extends string>(items: readonly ToolbarItemDefinition<Value>[]): readonly ToolbarItemDefinition<Value>[] {
  const normalized = normalizeCollection(items, "Toolbar");
  for (const item of normalized) {
    const kind = item.kind ?? "button";
    if (!["button", "link", "input", "group", "separator"].includes(kind)) throw new TypeError("Toolbar contains an invalid item kind.");
    if (kind === "link" && !safeHref((item as ToolbarLinkDefinition<Value>).href)) throw new TypeError("Toolbar link href must be a safe non-empty URL.");
    if (kind === "group" && !(item as ToolbarGroupDefinition<Value>).label && !(item as ToolbarGroupDefinition<Value>).labelledBy) {
      throw new TypeError("Toolbar groups require label or labelledBy.");
    }
  }
  for (const item of normalized) {
    if (!isToolbarInteractive(item) || item.group === undefined) continue;
    const group = normalized.find((candidate) => candidate.value === item.group);
    if (!group || group.kind !== "group") throw new TypeError("Toolbar control group must identify a group definition.");
  }
  return normalized;
}

function isToolbarInteractive<Value extends string>(item: ToolbarItemDefinition<Value>): item is ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value> {
  const kind = item.kind ?? "button";
  return kind === "button" || kind === "link" || kind === "input";
}

function safeHref(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^\s*(?:javascript|vbscript|data):/i.test(value);
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a non-negative finite number.`);
  return value;
}

function finiteCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function mergeElementRef(
  first: unknown,
  second: (element: HTMLElement | null) => void,
): (element: HTMLElement | null) => void {
  return (element) => {
    if (typeof first === "function") (first as (element: HTMLElement | null) => void)(element);
    else if (first && typeof first === "object" && "current" in first) (first as { current: HTMLElement | null }).current = element;
    second(element);
  };
}

function focusContent(element: HTMLElement | null | undefined, boundary: "first" | "last"): boolean {
  if (!element) return false;
  if (boundary === "first") return focusFirst(element, { preventScroll: true }) !== null;
  const candidates = Array.from(element.querySelectorAll?.("a[href],button,input,select,textarea,[tabindex]") ?? []) as HTMLElement[];
  for (const candidate of candidates.reverse()) {
    if (candidate.hidden || candidate.getAttribute?.("aria-disabled") === "true" || candidate.hasAttribute?.("disabled")) continue;
    try { candidate.focus({ preventScroll: true }); return true; }
    catch { try { candidate.focus(); return true; } catch {} }
  }
  return false;
}

function isTextEditingKey(key: string, orientation: Orientation): boolean {
  return key === "Home" || key === "End" || key === "PageUp" || key === "PageDown"
    || (orientation === "horizontal" ? key === "ArrowLeft" || key === "ArrowRight" : key === "ArrowUp" || key === "ArrowDown");
}
