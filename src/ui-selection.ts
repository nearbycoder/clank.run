import { computed, effect, signal, transaction, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";
import { useDirection } from "./ui-composition.ts";
import { type FieldController } from "./ui-fields.ts";
import {
  createControllableState,
  createTypeahead,
  createUiManifest,
  findCollectionIndex,
  getCollectionNavigationIntent,
  mergeProps,
  type ChangeDetails,
  type Direction,
  type UiManifest,
} from "./ui-foundation.ts";
import {
  createPopover,
  type OpenChangeReason,
  type PopupController,
  type PopupOptions,
  type PopupPortalOptions,
} from "./ui-popups.ts";

export interface SelectionItem<Value> {
  value: Value;
  label: string;
  disabled?: boolean;
  keywords?: readonly string[];
  group?: string;
}

export interface SelectionFilterOptions {
  locale?: string | string[];
  sensitivity?: Intl.CollatorOptions["sensitivity"];
  mode?: "contains" | "starts-with";
}

/** Rendering hint for selection popups. Responsive keeps the anchored desktop popup contract
 * while allowing mobile CSS to present the same modal surface as a bottom sheet. */
export type SelectionPresentation = "popover" | "bottom-sheet" | "responsive";

/** Locale-aware, accent-insensitive filter shared by Select, Combobox, and Autocomplete. */
export function filterSelectionItems<Value>(
  items: readonly SelectionItem<Value>[],
  query: string,
  options: SelectionFilterOptions = {},
): SelectionItem<Value>[] {
  const needle = normalizeText(query);
  if (!needle) return [...items];
  const collator = typeof Intl === "undefined" ? undefined : new Intl.Collator(options.locale, {
    usage: "search",
    sensitivity: options.sensitivity ?? "base",
  });
  const includes = (text: string) => {
    const source = normalizeText(text);
    if (options.mode === "starts-with") return comparePrefix(source, needle, collator);
    const sourceCharacters = [...source];
    const size = [...needle].length;
    for (let index = 0; index <= sourceCharacters.length - size; index++) {
      if (equalText(sourceCharacters.slice(index, index + size).join(""), needle, collator)) return true;
    }
    return false;
  };
  return items.filter((item) => includes(item.label) || item.keywords?.some(includes));
}

export type SelectionReason = OpenChangeReason | "item-press" | "keyboard" | "clear" | "remove" | "input" | "reset" | "programmatic";
export type SelectionValue<Value> = Value | readonly Value[] | null;
export type AutocompleteFieldValue<Value> = string | readonly Value[];

export interface SelectOptions<Value> extends Omit<PopupOptions, "onOpenChange"> {
  items: readonly SelectionItem<Value>[];
  multiple?: boolean;
  value?: SelectionValue<Value> | (() => SelectionValue<Value>);
  defaultValue?: SelectionValue<Value>;
  field?: FieldController<SelectionValue<Value>>;
  onValueChange?: (value: SelectionValue<Value>, details: ChangeDetails<SelectionReason>) => void;
  onOpenChange?: (open: boolean, details: ChangeDetails<OpenChangeReason>) => void;
  equals?: (left: Value, right: Value) => boolean;
  serialize?: (value: Value) => string;
  name?: string;
  form?: string;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean | (() => boolean);
  readOnly?: boolean | (() => boolean);
  loop?: boolean;
  direction?: Direction;
  closeOnSelect?: boolean;
  presentation?: SelectionPresentation;
}

export interface SelectController<Value> {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly value: Computed<SelectionValue<Value>>;
  readonly highlightedIndex: ReactiveSignal<number>;
  readonly selectedItems: Computed<SelectionItem<Value>[]>;
  show(reason?: OpenChangeReason, event?: Event): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  clear(reason?: SelectionReason, event?: Event): boolean;
  select(value: Value, reason?: SelectionReason, event?: Event): boolean;
  label(): Record<string, unknown>;
  trigger(): Record<string, unknown>;
  valuePart(options?: { placeholder?: string }): Record<string, unknown>;
  icon(): Record<string, unknown>;
  isMounted(options?: PopupPortalOptions): boolean;
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  backdrop(): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  list(): Record<string, unknown>;
  item(value: Value): Record<string, unknown>;
  itemText(value: Value): Record<string, unknown>;
  itemIndicator(value: Value): Record<string, unknown>;
  group(name: string): Record<string, unknown>;
  groupLabel(name: string): Record<string, unknown>;
  separator(): Record<string, unknown>;
  scrollUpArrow(): Record<string, unknown>;
  scrollDownArrow(): Record<string, unknown>;
  hiddenInputs(): Record<string, unknown>[];
  manifest(): UiManifest;
  dispose(): void;
}

/** Accessible single or multiple listbox selection with native form projection. */
export function createSelect<Value>(options: SelectOptions<Value>): SelectController<Value> {
  const id = requireId(options.id, "Select");
  if (options.field && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError("Select cannot use both field and value control.");
  }
  const direction = options.direction ?? useDirection();
  const presentation = options.presentation ?? "popover";
  const items = validateItems(options.items, options.equals);
  const equals = options.equals ?? Object.is;
  const multiple = Boolean(options.multiple);
  const normalize = (value: SelectionValue<Value> | undefined, source: string) =>
    normalizeSelection(value, multiple, items, equals, `Select ${source}`);
  const initial = normalize(options.field ? options.field.value.peek() : options.defaultValue, "initial value");
  const state = createControllableState<SelectionValue<Value>, SelectionReason>({
    ...(options.field
      ? { value: () => normalize(options.field!.value.value, "Field value") }
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? { value: () => normalize(readSelectionOption(options.value), "controlled value") }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field) {
        const accepted = options.field.setValue(
          next,
          details.reason === "reset" ? "reset" : "input",
          details.event,
        );
        if (!accepted && !selectionEquals(normalize(options.field.value.peek(), "Field value"), next, multiple, equals)) {
          details.cancel();
        }
      }
    },
    equals: (left, right) => selectionEquals(left, right, multiple, equals),
    name: `${id}.value`,
  });
  const focused = signal(false, { name: `${id}.focused` });
  const touched = signal(false, { name: `${id}.touched` });
  const dirty = computed(() => !selectionEquals(state.value.value, initial, multiple, equals), { name: `${id}.dirty` });
  const filled = computed(() => selectionValues(state.value.value, multiple).length > 0, { name: `${id}.filled` });
  const disabled = computed(() => readBoolean(options.disabled ?? false) || readFieldFlag(options.field, "disabled"));
  const readOnly = computed(() => readBoolean(options.readOnly ?? false) || readFieldFlag(options.field, "readOnly"));
  const required = computed(() => Boolean(options.required) || readFieldFlag(options.field, "required"));
  const name = options.name ?? options.field?.name;
  const controlId = options.field?.controlId ?? `${id}-trigger`;
  const fieldPart = options.field?.control({
    id: controlId,
    format: (value) => selectionValues(value, multiple).length > 0 ? "1" : "",
  });
  const labelPresence = options.field ? undefined : createPartPresence(`${id}.labelPresence`);
  const labelId = (): string | undefined => options.field
    ? readStringPartProp(fieldPart, "aria-labelledby")
    : labelPresence!.present.value ? `${id}-label` : undefined;
  const commonStateProps = () => selectionStateProps({
    field: options.field,
    disabled: () => disabled.value,
    readOnly: () => readOnly.value,
    required: () => required.value,
    dirty: () => dirty.value,
    touched: () => touched.value,
    filled: () => filled.value,
    focused: () => focused.value,
  });
  const listElement = signal<HTMLElement | null>(null, { name: `${id}.list` });
  const positionerElement = signal<HTMLElement | null>(null, { name: `${id}.positioner` });
  const finishInteraction = (event?: Event) => {
    const wasFocused = focused.peek();
    const wasTouched = touched.peek() || options.field?.touched.peek() === true;
    focused.value = false;
    touched.value = true;
    options.field?.setFocused(false);
    options.field?.touch();
    if ((wasFocused || !wasTouched) && shouldValidateSelectionFieldOnBlur(options.field)) {
      void options.field!.validate("blur", event);
    }
  };
  const popup = createPopover({
    ...options,
    id,
    modal: options.modal ?? true,
    initialFocus: options.initialFocus ?? (() => listElement.peek()),
    onOpenChange(open, details) {
      options.onOpenChange?.(open, details);
      if (
        !open
        && !details.canceled
        && (details.reason === "focus-out" || details.reason === "outside-press")
      ) {
        finishInteraction(details.event);
      }
    },
  });
  const selectedIndex = () => items.findIndex((item) => isSelected(state.value.peek(), item.value, multiple, equals));
  const initialHighlighted = () => {
    const selected = selectedIndex();
    return selected >= 0 && !items[selected]!.disabled ? selected : firstEnabled(items);
  };
  const highlightedIndex = signal(initialHighlighted(), { name: `${id}.highlighted` });
  const typeahead = createTypeahead<SelectionItem<Value>>({
    textValue: (item) => item.label,
    disabled: (item) => Boolean(item.disabled),
  });
  const selectedItems = computed(() => items.filter((item) => isSelected(state.value.value, item.value, multiple, equals)));
  const setSelection = (next: Value | readonly Value[] | null, reason: SelectionReason, event?: Event) => {
    if (disabled.peek() || readOnly.peek()) return false;
    return state.set(normalize(next, `${reason} value`), reason, event);
  };
  const choose = (value: Value, reason: SelectionReason = "programmatic", event?: Event) => {
    const item = findItem(items, value, equals);
    if (!item) throw new TypeError("Cannot select an unknown Select item value.");
    if (item.disabled) return false;
    let changed: boolean;
    if (multiple) {
      const current = selectionValues(state.value.peek(), true);
      const present = current.some((entry) => equals(entry, value));
      changed = setSelection(present ? current.filter((entry) => !equals(entry, value)) : [...current, value], reason, event);
    } else {
      changed = setSelection(value, reason, event);
    }
    if (changed && (!multiple || options.closeOnSelect !== false)) popup.hide("programmatic", event);
    return changed;
  };
  const move = (intent: ReturnType<typeof getCollectionNavigationIntent>) => {
    if (!intent) return;
    const next = findCollectionIndex(items, highlightedIndex.peek(), intent, {
      loop: options.loop !== false,
      disabled: (item) => Boolean(item.disabled),
    });
    if (next >= 0) highlightedIndex.value = next;
  };
  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || disabled.peek() || readOnly.peek()) return;
    const intent = getCollectionNavigationIntent(event.key, "vertical", direction);
    if (intent) {
      event.preventDefault();
      move(intent);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const item = items[highlightedIndex.peek()];
      if (item) choose(item.value, "keyboard", event);
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") return;
    const match = typeahead.search(event.key, items, highlightedIndex.peek());
    if (match >= 0) {
      event.preventDefault();
      highlightedIndex.value = match;
    }
  };
  const trigger = popup.trigger;
  const resetBinding = createFormResetBinding(options.form, (event) => {
    if (event.defaultPrevented) return;
    const resetValue = cloneSelection(initial, multiple);
    const alreadyInitial = selectionEquals(state.value.peek(), resetValue, multiple, equals);
    if (!alreadyInitial && !state.set(resetValue, "reset", event)) return;
    highlightedIndex.value = initialHighlighted();
    focused.value = false;
    touched.value = false;
    options.field?.setFocused(false);
    options.field?.touch(false);
    popup.hide("programmatic", event);
  });
  const show = (reason: OpenChangeReason = "programmatic", event?: Event) => {
    const changed = popup.show(reason, event);
    if (changed) highlightedIndex.value = initialHighlighted();
    return changed;
  };
  const controller: SelectController<Value> = {
    id,
    open: popup.open,
    value: state.value,
    highlightedIndex,
    selectedItems,
    show,
    hide: popup.hide,
    clear: (reason = "clear", event) => setSelection(multiple ? [] : null, reason, event),
    select: choose,
    label: () => options.field
      ? mergeProps(options.field.label(), { "data-clank-part": "label", ...commonStateProps() })
      : ({
        id: `${id}-label`,
        "data-clank-part": "label",
        ...commonStateProps(),
        use: labelPresence!.register(),
        onClick: (event: Event) => {
          if (event.defaultPrevented || disabled.peek()) return;
          focusById(event.currentTarget, controlId);
        },
      }),
    trigger() {
      return mergeProps(trigger(), {
        id: controlId,
        role: "combobox",
        "aria-haspopup": "listbox",
        "aria-controls": `${id}-list`,
        "aria-labelledby": () => [labelId(), `${id}-value`].filter(Boolean).join(" ") || undefined,
        "aria-describedby": fieldPart?.["aria-describedby"],
        "aria-errormessage": fieldPart?.["aria-errormessage"],
        "aria-invalid": fieldPart?.["aria-invalid"],
        "aria-disabled": () => disabled.value,
        "aria-readonly": () => readOnly.value,
        "aria-required": () => required.value || undefined,
        "aria-activedescendant": () => highlightedIndex.value < 0 ? undefined : itemId(id, highlightedIndex.value),
        disabled: () => disabled.value,
        form: options.form,
        dir: direction,
        ...commonStateProps(),
        "data-popup-open": () => popup.open.value ? "" : undefined,
        "data-placeholder": () => selectedItems.value.length === 0 ? "" : undefined,
        ref: resetBinding.ref,
        onFocus: () => {
          focused.value = true;
          options.field?.setFocused(true);
        },
        onBlur: (event: FocusEvent) => {
          if (
            containsSelectionFocus(positionerElement.peek(), event.relatedTarget)
            || containsSelectionFocus(listElement.peek(), event.relatedTarget)
          ) return;
          finishInteraction(event);
        },
        onInvalid: fieldPart?.onInvalid,
        onKeyDown: (event: KeyboardEvent) => {
          if (event.defaultPrevented || disabled.peek() || readOnly.peek()) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!popup.open.peek()) show("trigger-press", event);
            else move(event.key === "ArrowDown" ? "next" : "previous");
            if (highlightedIndex.peek() < 0) highlightedIndex.value = event.key === "ArrowUp" ? lastEnabled(items) : firstEnabled(items);
            event.preventDefault();
          } else if (event.key === "Enter" || event.key === " ") {
            if (!popup.open.peek()) show("trigger-press", event);
            else {
              const item = items[highlightedIndex.peek()];
              if (item) choose(item.value, "keyboard", event);
            }
            event.preventDefault();
          } else if (event.key === "Escape" && popup.open.peek()) {
            if (popup.hide("escape-key", event)) event.preventDefault();
          } else {
            if (!popup.open.peek() && multiple) return;
            const match = typeahead.search(
              event.key,
              items,
              popup.open.peek() ? highlightedIndex.peek() : selectedIndex(),
            );
            if (match >= 0) {
              if (popup.open.peek()) highlightedIndex.value = match;
              else if (choose(items[match]!.value, "keyboard", event)) highlightedIndex.value = match;
              event.preventDefault();
            }
          }
        },
      });
    },
    valuePart(valueOptions = {}) {
      return {
        id: `${id}-value`,
        "data-clank-part": "value",
        "data-placeholder": () => selectedItems.value.length === 0 ? "" : undefined,
        ...commonStateProps(),
        children: () => selectedItems.value.length === 0
          ? valueOptions.placeholder ?? ""
          : selectedItems.value.map((item) => item.label).join(", "),
      };
    },
    icon: () => ({
      "aria-hidden": true,
      "data-clank-part": "icon",
      "data-popup-open": () => popup.open.value ? "" : undefined,
    }),
    isMounted: popup.isMounted,
    portal: (portalOptions) => mergeProps(popup.portal(portalOptions), {
      "data-clank-part": "portal",
      "data-selection-presentation": presentation,
    }),
    backdrop: () => mergeProps(popup.backdrop(), { "data-selection-presentation": presentation }),
    positioner: () => mergeProps(popup.positioner(), {
      "data-selection-presentation": presentation,
      ref: (element: HTMLElement | null) => { positionerElement.value = element; },
    }),
    popup: () => mergeProps(
      popup.popup({ role: "presentation", labelledBy: false, describedBy: false }),
      { "data-selection-presentation": presentation, onKeyDown: onListKeyDown },
    ),
    arrow: popup.arrow,
    list: () => ({
      id: `${id}-list`,
      role: "listbox",
      tabIndex: -1,
      dir: direction,
      "aria-labelledby": labelId,
      "aria-multiselectable": multiple || undefined,
      "aria-activedescendant": () => highlightedIndex.value < 0 ? undefined : itemId(id, highlightedIndex.value),
      "data-clank-part": "list",
      ...commonStateProps(),
      ref: (element: HTMLElement | null) => { listElement.value = element; },
      onKeyDown: onListKeyDown,
    }),
    item(value) {
      const index = itemIndex(items, value, equals);
      if (index < 0) throw new TypeError("Unknown Select item value.");
      const item = items[index]!;
      return {
        id: itemId(id, index),
        role: "option",
        tabIndex: -1,
        "aria-selected": () => isSelected(state.value.value, item.value, multiple, equals),
        "aria-disabled": item.disabled || undefined,
        "data-selected": () => isSelected(state.value.value, item.value, multiple, equals) ? "" : undefined,
        "data-highlighted": () => highlightedIndex.value === index ? "" : undefined,
        "data-disabled": item.disabled ? "" : undefined,
        "data-clank-part": "item",
        onPointerMove: (event: PointerEvent) => {
          if (!event.defaultPrevented && !item.disabled && event.pointerType !== "touch") highlightedIndex.value = index;
        },
        onClick: (event: Event) => {
          if (!event.defaultPrevented) choose(value, "item-press", event);
        },
      };
    },
    itemText: (value) => ({ "data-clank-part": "item-text", children: findItem(items, value, equals)?.label ?? "" }),
    itemIndicator: (value) => ({
      "aria-hidden": true,
      hidden: () => !isSelected(state.value.value, value, multiple, equals),
      "data-clank-part": "item-indicator",
    }),
    group: (name) => ({ role: "group", "aria-labelledby": groupId(id, name), "data-clank-part": "group" }),
    groupLabel: (name) => ({ id: groupId(id, name), "data-clank-part": "group-label" }),
    separator: () => ({ role: "separator", "data-clank-part": "separator" }),
    scrollUpArrow: () => ({ "aria-hidden": true, "data-clank-part": "scroll-up-arrow" }),
    scrollDownArrow: () => ({ "aria-hidden": true, "data-clank-part": "scroll-down-arrow" }),
    hiddenInputs: () => {
      const controls = stableSelectionInputs({
        id,
        items,
        value: state.value,
        multiple,
        equals,
        serialize: options.serialize,
        name,
        form: options.form,
        autoComplete: options.autoComplete,
        disabled,
      });
      const submissionControls = [...controls];
      if (options.field || options.required) controls.unshift(requiredProxy({
        id: `${id}-validation`,
        form: options.form,
        disabled: () => disabled.value,
        required: options.field ? () => required.value : Boolean(options.required),
        valid: () => nativeProjectionHasValue(submissionControls),
        focusId: controlId,
        fieldPart,
      }) as typeof controls[number]);
      return controls;
    },
    manifest: () => createSelectionManifest("Select", id, {
      open: popup.open.peek(),
      presentation,
      multiple,
      selected: selectedItems.peek().map((item) => item.label),
      highlightedIndex: highlightedIndex.peek(),
    }),
    dispose() { typeahead.dispose(); resetBinding.dispose(); popup.dispose(); },
  };
  return controller;
}

export type CompletionMode = "none" | "list" | "both" | "inline";
export interface ComboboxOptions<Value> extends Omit<SelectOptions<Value>, "value" | "defaultValue" | "onValueChange" | "closeOnSelect"> {
  value?: SelectionValue<Value> | (() => SelectionValue<Value>);
  defaultValue?: SelectionValue<Value>;
  onValueChange?: (value: SelectionValue<Value>, details: ChangeDetails<SelectionReason>) => void;
  inputValue?: string | (() => string);
  defaultInputValue?: string;
  onInputValueChange?: (value: string, details: ChangeDetails<SelectionReason>) => void;
  filter?: (items: readonly SelectionItem<Value>[], query: string) => readonly SelectionItem<Value>[];
  completionMode?: CompletionMode;
  autoHighlight?: boolean;
  /** Opens on editable input click. Defaults to true for Combobox and false for Autocomplete. */
  openOnInputClick?: boolean;
  loopFocus?: boolean;
  allowCustomValue?: boolean;
}

export interface EditableSelectionInputOptions {
  /** Override the generated input id when rendering more than one responsive presentation. */
  id?: string;
  /** Marks an additional search field rendered inside the popup or mobile bottom sheet. */
  insidePopup?: boolean;
  ariaLabel?: string;
}

export interface EditableSelectionTriggerOptions {
  id?: string;
  /** Render the trigger as the primary combobox control for an input-inside-popup pattern. */
  standalone?: boolean;
  agentId?: string;
  agentLabel?: string;
}

export interface AutocompleteOptions<Value> extends Omit<ComboboxOptions<Value>, "field"> {
  field?: FieldController<AutocompleteFieldValue<Value>>;
  /** Preserve the highlighted suggestion when the pointer leaves its item. Defaults to false. */
  keepHighlight?: boolean;
}

export interface ComboboxController<Value> {
  readonly id: string;
  readonly open: Computed<boolean>;
  readonly value: Computed<SelectionValue<Value>>;
  readonly inputValue: Computed<string>;
  readonly filteredItems: Computed<readonly SelectionItem<Value>[]>;
  readonly highlightedIndex: ReactiveSignal<number>;
  label(): Record<string, unknown>;
  show(reason?: OpenChangeReason, event?: Event): boolean;
  hide(reason?: OpenChangeReason, event?: Event): boolean;
  input(options?: EditableSelectionInputOptions): Record<string, unknown>;
  inputGroup(): Record<string, unknown>;
  trigger(options?: EditableSelectionTriggerOptions): Record<string, unknown>;
  clear(): Record<string, unknown>;
  icon(): Record<string, unknown>;
  valuePart(options?: { placeholder?: string }): Record<string, unknown>;
  isMounted(options?: PopupPortalOptions): boolean;
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  list(): Record<string, unknown>;
  popup(): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  backdrop(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  status(): Record<string, unknown>;
  empty(): Record<string, unknown>;
  collection(): Record<string, unknown>;
  row(): Record<string, unknown>;
  item(value: Value): Record<string, unknown>;
  itemIndicator(value: Value): Record<string, unknown>;
  group(name: string): Record<string, unknown>;
  groupLabel(name: string): Record<string, unknown>;
  separator(): Record<string, unknown>;
  chips(): Record<string, unknown>;
  chip(value: Value): Record<string, unknown>;
  chipRemove(value: Value): Record<string, unknown>;
  hiddenInputs(): Record<string, unknown>[];
  choose(value: Value, reason?: SelectionReason, event?: Event): boolean;
  setInput(value: string, reason?: SelectionReason, event?: Event): boolean;
  manifest(): UiManifest;
  dispose(): void;
}

/** Editable listbox whose committed value is restricted to the supplied item collection. */
export function createCombobox<Value>(options: ComboboxOptions<Value>): ComboboxController<Value> {
  return createEditableSelection(options, false);
}

/** Editable suggestion list that permits free-form input values. */
export function createAutocomplete<Value>(options: AutocompleteOptions<Value>): ComboboxController<Value> {
  return createEditableSelection({ ...options, allowCustomValue: true }, true);
}

function createEditableSelection<Value>(
  options: ComboboxOptions<Value> | AutocompleteOptions<Value>,
  autocomplete: boolean,
): ComboboxController<Value> {
  const id = requireId(options.id, autocomplete ? "Autocomplete" : "Combobox");
  const direction = options.direction ?? useDirection();
  const presentation = options.presentation ?? "popover";
  const items = validateItems(options.items, options.equals);
  const equals = options.equals ?? Object.is;
  const multiple = Boolean(options.multiple);
  const field = options.field as FieldController<any> | undefined;
  const selectionField = (!autocomplete || multiple)
    ? options.field as FieldController<SelectionValue<Value>> | undefined
    : undefined;
  const textField = autocomplete && !multiple
    ? options.field as FieldController<AutocompleteFieldValue<Value>> | undefined
    : undefined;
  if (selectionField && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError(`${autocomplete ? "Autocomplete" : "Combobox"} cannot use both field and value control.`);
  }
  if (textField && Object.prototype.hasOwnProperty.call(options, "inputValue")) {
    throw new TypeError("Autocomplete cannot use both field and inputValue control in single mode.");
  }
  const completionMode = options.completionMode ?? "list";
  if (completionMode !== "none" && completionMode !== "list" && completionMode !== "inline" && completionMode !== "both") {
    throw new TypeError("Completion mode must be none, list, inline, or both.");
  }
  const inlineCompletion = completionMode === "inline" || completionMode === "both";
  const completionCollator = new Intl.Collator(undefined, { usage: "search", sensitivity: "base" });
  const fieldSelectionValue = () => {
    const current = selectionField!.value.value;
    if (autocomplete && multiple && !Array.isArray(current)) {
      throw new TypeError("Multiple Autocomplete field value must be an array.");
    }
    return normalizeSelection(
      current,
      multiple,
      items,
      equals,
      `${autocomplete ? "Autocomplete" : "Combobox"} Field value`,
    );
  };
  const initialSelectionSource = selectionField
    ? fieldSelectionValue()
    : options.defaultValue ?? (multiple ? [] : null);
  const normalize = (value: SelectionValue<Value> | undefined, source: string) => normalizeSelection(
    value,
    multiple,
    items,
    equals,
    `${autocomplete ? "Autocomplete" : "Combobox"} ${source}`,
  );
  const initialValue = cloneSelection(normalize(initialSelectionSource, "initial value"), multiple);
  const valueState = createControllableState<SelectionValue<Value>, SelectionReason>({
    ...(selectionField
      ? { value: fieldSelectionValue }
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? { value: () => normalize(readSelectionOption(options.value), "controlled value") }
        : {}),
    defaultValue: initialValue,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && selectionField) {
        const accepted = selectionField.setValue(
          next,
          details.reason === "reset" ? "reset" : "input",
          details.event,
        );
        if (!accepted && !selectionEquals(fieldSelectionValue(), next, multiple, equals)) details.cancel();
      }
    },
    equals: (left, right) => selectionEquals(left, right, multiple, equals),
    name: `${id}.value`,
  });
  const selectedLabel = () => selectedLabelFor(valueState.value.peek(), items, multiple, equals);
  const fieldInputValue = () => {
    const current = textField!.value.value;
    if (typeof current !== "string") throw new TypeError("Single Autocomplete field value must be a string.");
    return current;
  };
  const initialInputValue = textField
    ? fieldInputValue()
    : options.defaultInputValue ?? selectedLabel();
  const inputState = createControllableState<string, SelectionReason>({
    ...(textField
      ? { value: fieldInputValue }
      : Object.prototype.hasOwnProperty.call(options, "inputValue") ? { value: options.inputValue } : {}),
    defaultValue: initialInputValue,
    onValueChange(next, details) {
      options.onInputValueChange?.(next, details);
      if (!details.canceled && textField) {
        const accepted = textField.setValue(
          next,
          details.reason === "reset" ? "reset" : "input",
          details.event,
        );
        if (!accepted && fieldInputValue() !== next) details.cancel();
      }
    },
    name: `${id}.inputValue`,
  });
  const canceledCompositeTransition = Symbol(`${id}.canceledCompositeTransition`);
  const applyCompositeTransition = (
    nextValue: SelectionValue<Value>,
    nextInput: string,
    reason: SelectionReason,
    event?: Event,
  ): { accepted: boolean; changed: boolean } => {
    const normalizedValue = normalize(nextValue, `${reason} value`);
    const valueChanged = !selectionEquals(valueState.value.peek(), normalizedValue, multiple, equals);
    const inputChanged = inputState.value.peek() !== nextInput;
    if (!valueChanged && !inputChanged) return { accepted: true, changed: false };
    try {
      transaction(() => {
        if (valueChanged && !valueState.set(normalizedValue, reason, event)) throw canceledCompositeTransition;
        if (inputChanged && !inputState.set(nextInput, reason, event)) throw canceledCompositeTransition;
      });
    } catch (error) {
      if (error === canceledCompositeTransition) return { accepted: false, changed: false };
      throw error;
    }
    return { accepted: true, changed: true };
  };
  const focused = signal(false, { name: `${id}.focused` });
  const touched = signal(false, { name: `${id}.touched` });
  const localDirty = computed(
    () => autocomplete && !multiple
      ? inputState.value.value !== initialInputValue
      : !selectionEquals(valueState.value.value, initialValue, multiple, equals),
    { name: `${id}.dirty` },
  );
  const localFilled = computed(
    () => autocomplete && !multiple
      ? inputState.value.value.length > 0
      : selectionValues(valueState.value.value, multiple).length > 0,
    { name: `${id}.filled` },
  );
  const disabled = computed(() => readBoolean(options.disabled ?? false) || readFieldFlag(field, "disabled"));
  const readOnly = computed(() => readBoolean(options.readOnly ?? false) || readFieldFlag(field, "readOnly"));
  const required = computed(() => Boolean(options.required) || readFieldFlag(field, "required"));
  const name = options.name ?? field?.name;
  const controlId = field?.controlId ?? `${id}-input`;
  const fieldPart = field?.control({
    id: controlId,
    format: (value) => autocomplete && !multiple
      ? typeof value === "string" ? value : ""
      : selectionValues(value as SelectionValue<Value>, multiple).length > 0 ? "1" : "",
  });
  const labelPresence = field ? undefined : createPartPresence(`${id}.labelPresence`);
  const labelId = (): string | undefined => field
    ? readStringPartProp(fieldPart, "aria-labelledby")
    : labelPresence!.present.value ? `${id}-label` : undefined;
  const commonStateProps = () => selectionStateProps({
    field,
    disabled: () => disabled.value,
    readOnly: () => readOnly.value,
    required: () => required.value,
    dirty: () => localDirty.value,
    touched: () => touched.value,
    filled: () => localFilled.value,
    focused: () => focused.value,
  });
  const inputElements = new Set<HTMLInputElement>();
  let activeInputElement: HTMLInputElement | null = null;
  let popupInputElement: HTMLInputElement | null = null;
  const popup = createPopover({
    ...options,
    id,
    modal: options.modal ?? (presentation === "popover" ? false : true),
    initialFocus: options.initialFocus ?? (() => popupInputElement),
    onOpenChange: options.onOpenChange,
  });
  const filteredItems = computed<readonly SelectionItem<Value>[]>(() => {
    const query = inputState.value.value;
    if (completionMode === "none") return items;
    return options.filter ? [...options.filter(items, query)] : filterSelectionItems(items, query);
  });
  const highlightedIndex = signal(-1, { name: `${id}.highlighted` });
  let previousFilteredItems = filteredItems.peek();
  let hasHighlightedValue = false;
  let highlightedValue!: Value;
  const stopHighlightReconciliation = effect(() => {
    const nextItems = filteredItems.value;
    const currentIndex = highlightedIndex.value;
    if (nextItems === previousFilteredItems) {
      const current = nextItems[currentIndex];
      if (current && !current.disabled) {
        highlightedValue = current.value;
        hasHighlightedValue = true;
      } else {
        hasHighlightedValue = false;
        if (currentIndex !== -1) highlightedIndex.value = -1;
      }
      return;
    }

    let nextIndex = hasHighlightedValue
      ? nextItems.findIndex((item) => !item.disabled && equals(item.value, highlightedValue))
      : -1;
    if (nextIndex < 0 && options.autoHighlight) nextIndex = firstEnabled(nextItems);
    previousFilteredItems = nextItems;
    const nextItem = nextItems[nextIndex];
    if (nextItem) {
      highlightedValue = nextItem.value;
      hasHighlightedValue = true;
    } else {
      hasHighlightedValue = false;
    }
    if (currentIndex !== nextIndex) highlightedIndex.value = nextIndex;
    renderInlineCompletion();
  });
  const activeDescendantId = () => {
    const item = filteredItems.value[highlightedIndex.value];
    if (!item || item.disabled) return undefined;
    const canonicalIndex = itemIndex(items, item.value, equals);
    return canonicalIndex < 0 ? undefined : itemId(id, canonicalIndex);
  };
  const selected = (value: Value) => isSelected(valueState.value.value, value, multiple, equals);
  const choose = (value: Value, reason: SelectionReason = "item-press", event?: Event) => {
    const item = findItem(items, value, equals);
    if (!item) throw new TypeError(`Cannot choose an unknown ${autocomplete ? "Autocomplete" : "Combobox"} item value.`);
    if (item.disabled || disabled.peek() || readOnly.peek()) return false;
    let next: Value | readonly Value[] | null;
    if (multiple) {
      const current = selectionValues(valueState.value.peek(), true);
      next = current.some((entry) => equals(entry, value)) ? current.filter((entry) => !equals(entry, value)) : [...current, value];
    } else next = value;
    if (selectionEquals(valueState.value.peek(), next, multiple, equals)) return false;
    const transition = applyCompositeTransition(next, multiple ? "" : item.label, reason, event);
    if (!transition.accepted) {
      restoreTypedInput();
      return false;
    }
    if (transition.changed) {
      highlightedIndex.value = multiple && options.autoHighlight ? firstEnabled(items) : -1;
    }
    if (transition.changed && !multiple) popup.hide("programmatic", event);
    return transition.changed;
  };
  const setInput = (value: string, reason: SelectionReason = "input", event?: Event) => {
    if (disabled.peek() || readOnly.peek()) return false;
    const nextSelection = autocomplete && !multiple ? null : valueState.value.peek();
    const transition = applyCompositeTransition(nextSelection, value, reason, event);
    if (transition.changed) {
      if (!popup.open.peek()) popup.show("programmatic", event);
      renderInlineCompletion();
    }
    return transition.accepted && transition.changed;
  };
  const move = (intent: ReturnType<typeof getCollectionNavigationIntent>) => {
    if (!intent) return;
    highlightedIndex.value = findCollectionIndex(filteredItems.peek(), highlightedIndex.peek(), intent, {
      loop: options.loopFocus !== false,
      disabled: (item) => Boolean(item.disabled),
    });
    renderInlineCompletion();
  };
  const inlineCandidate = (): SelectionItem<Value> | undefined => {
    if (!inlineCompletion) return undefined;
    const query = inputState.value.peek();
    if (!query) return undefined;
    const highlighted = filteredItems.peek()[highlightedIndex.peek()];
    const candidate = highlighted && !highlighted.disabled ? highlighted : filteredItems.peek().find((item) => !item.disabled);
    if (!candidate || candidate.label.length <= query.length || !comparePrefix(candidate.label, query, completionCollator)) return undefined;
    return candidate;
  };
  function renderInlineCompletion(): void {
    const query = inputState.value.peek();
    const candidate = inlineCandidate();
    for (const element of inputElements) {
      element.value = candidate?.label ?? query;
      if (element !== activeInputElement) continue;
      try {
        const end = candidate?.label.length ?? query.length;
        element.setSelectionRange?.(query.length, end, candidate ? "forward" : "none");
      } catch { /* Selection APIs can be unavailable in partial DOM adapters. */ }
    }
  }
  const acceptInlineCompletion = (event?: Event): boolean => {
    const candidate = inlineCandidate();
    if (!candidate) return false;
    if (!autocomplete) return choose(candidate.value, "keyboard", event);
    const changed = inputState.set(candidate.label, "input", event);
    if (changed) {
      for (const element of inputElements) element.value = candidate.label;
      if (activeInputElement) {
        try { activeInputElement.setSelectionRange?.(candidate.label.length, candidate.label.length, "none"); } catch { /* Optional API. */ }
      }
    }
    return changed;
  };
  const restoreTypedInput = (): void => {
    const value = inputState.value.peek();
    for (const element of inputElements) element.value = value;
    if (!activeInputElement) return;
    const end = activeInputElement.value.length;
    try { activeInputElement.setSelectionRange?.(end, end, "none"); } catch { /* Optional API. */ }
  };
  const clearEditable = (event: Event): boolean => {
    const emptySelection: SelectionValue<Value> = multiple ? [] : null;
    const transition = applyCompositeTransition(emptySelection, "", "clear", event);
    if (!transition.accepted) {
      restoreTypedInput();
      return false;
    }
    return transition.changed;
  };
  const prepareStandaloneSearch = (event?: Event): void => {
    if (autocomplete || multiple || inputState.value.peek() === "") return;
    if (inputState.set("", "programmatic", event)) renderInlineCompletion();
  };
  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || disabled.peek() || readOnly.peek()) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      if (!popup.open.peek()) popup.show("trigger-press", event);
      move(getCollectionNavigationIntent(event.key, "vertical", direction));
      event.preventDefault();
    } else if (event.key === "Enter" && popup.open.peek()) {
      const item = filteredItems.peek()[highlightedIndex.peek()];
      if (item) {
        choose(item.value, "keyboard", event);
        event.preventDefault();
      } else if (acceptInlineCompletion(event)) {
        popup.hide("programmatic", event);
        event.preventDefault();
      } else if (autocomplete && options.allowCustomValue) {
        popup.hide("programmatic", event);
      }
    } else if (event.key === "Escape") {
      if (popup.hide("escape-key", event)) {
        restoreTypedInput();
        event.preventDefault();
      }
    } else if (event.key === "Tab") {
      acceptInlineCompletion(event);
      popup.hide("focus-out", event);
    }
    else if (multiple && event.key === "Backspace" && inputState.value.peek() === "") {
      const current = selectionValues(valueState.value.peek(), true);
      if (current.length) valueState.set(current.slice(0, -1), "remove", event);
    }
  };
  const resetBinding = createFormResetBinding(options.form, (event) => {
    if (event.defaultPrevented) return;
    const resetSelection = cloneSelection(initialValue, multiple);
    const transition = applyCompositeTransition(resetSelection, initialInputValue, "reset", event);
    if (!transition.accepted) {
      restoreTypedInput();
      return;
    }
    highlightedIndex.value = -1;
    focused.value = false;
    touched.value = false;
    field?.setFocused(false);
    field?.touch(false);
    popup.hide("programmatic", event);
  });
  const controller: ComboboxController<Value> = {
    id,
    open: popup.open,
    value: valueState.value,
    inputValue: inputState.value,
    filteredItems,
    highlightedIndex,
    setInput,
    choose,
    show: popup.show,
    hide: popup.hide,
    label: () => field
      ? mergeProps(field.label(), { "data-clank-part": "label", ...commonStateProps() })
      : ({
        id: `${id}-label`,
        htmlFor: controlId,
        "data-clank-part": "label",
        ...commonStateProps(),
        use: labelPresence!.register(),
      }),
    input: (inputOptions = {}) => {
      const insidePopup = inputOptions.insidePopup === true;
      let mountedElement: HTMLInputElement | null = null;
      return {
        id: inputOptions.id ?? (insidePopup ? `${id}-popup-input` : controlId),
        role: "combobox",
        type: "text",
        value: () => inputState.value.value,
        disabled: () => disabled.value,
        readOnly: () => readOnly.value,
        required: !insidePopup && autocomplete && !multiple
          ? field ? () => required.value : Boolean(options.required)
          : undefined,
        name: !insidePopup && autocomplete && !multiple ? name : undefined,
        form: options.form,
        autoComplete: options.autoComplete ?? "off",
        dir: direction,
        "aria-label": inputOptions.ariaLabel,
        "aria-autocomplete": completionMode,
        "aria-haspopup": "listbox",
        "aria-expanded": () => popup.open.value,
        "aria-controls": `${id}-list`,
        "aria-labelledby": inputOptions.ariaLabel ? undefined : labelId,
        "aria-describedby": insidePopup ? undefined : fieldPart?.["aria-describedby"],
        "aria-errormessage": insidePopup ? undefined : fieldPart?.["aria-errormessage"],
        "aria-invalid": insidePopup ? undefined : fieldPart?.["aria-invalid"],
        "aria-required": () => required.value || undefined,
        "aria-activedescendant": activeDescendantId,
        "data-open": () => popup.open.value ? "" : undefined,
        "data-popup-open": () => popup.open.value ? "" : undefined,
        "data-inside-popup": insidePopup ? "" : undefined,
        "data-selection-presentation": presentation,
        ...commonStateProps(),
        "data-list-empty": () => filteredItems.value.length === 0 ? "" : undefined,
        "data-clank-part": "input",
        ref: (element: HTMLElement | null) => {
          const previousElement = mountedElement;
          if (previousElement) inputElements.delete(previousElement);
          if (activeInputElement === previousElement) activeInputElement = null;
          mountedElement = element as HTMLInputElement | null;
          if (mountedElement) inputElements.add(mountedElement);
          if (!activeInputElement && mountedElement) activeInputElement = mountedElement;
          else if (!activeInputElement && inputElements.size) activeInputElement = inputElements.values().next().value ?? null;
          if (insidePopup) {
            if (mountedElement || popupInputElement === previousElement) popupInputElement = mountedElement;
          }
          else {
            popup.triggerElement.value = element;
            resetBinding.ref(element);
          }
          renderInlineCompletion();
        },
        ...(!insidePopup && textField ? { use: (element: Element): Cleanup | undefined => mountPartUse(fieldPart, element) } : {}),
        onInput: (event: Event) => {
          if (event.defaultPrevented) return;
          if (!setInput((event.currentTarget as HTMLInputElement).value, "input", event)) restoreTypedInput();
        },
        onClick: (event: MouseEvent) => {
          const openOnInputClick = options.openOnInputClick ?? !autocomplete;
          if (!event.defaultPrevented && !disabled.peek() && (insidePopup || openOnInputClick)) {
            popup.show("trigger-press", event);
          }
        },
        onKeyDown: onInputKeyDown,
        onFocus: (event: FocusEvent) => {
          activeInputElement = event.currentTarget as HTMLInputElement;
          focused.value = true;
          field?.setFocused(true);
          if (!insidePopup && !event.defaultPrevented && inputState.value.peek()) {
            popup.show("focus", event);
            renderInlineCompletion();
          }
        },
        onBlur: (event: FocusEvent) => {
          if (!event.defaultPrevented) acceptInlineCompletion(event);
          const related = event.relatedTarget as HTMLInputElement | null;
          if (related && inputElements.has(related)) {
            activeInputElement = related;
            return;
          }
          activeInputElement = null;
          focused.value = false;
          touched.value = true;
          field?.setFocused(false);
          field?.touch();
          if (shouldValidateSelectionFieldOnBlur(field)) void field!.validate("blur", event);
        },
        onInvalid: !insidePopup && textField ? fieldPart?.onInvalid : undefined,
      };
    },
    inputGroup: () => ({
      "data-clank-part": "input-group",
      ...commonStateProps(),
    }),
    trigger: (triggerOptions = {}) => ({
      id: triggerOptions.id ?? (triggerOptions.standalone ? controlId : undefined),
      type: "button",
      role: triggerOptions.standalone ? "combobox" : undefined,
      tabIndex: triggerOptions.standalone ? 0 : -1,
      "aria-label": triggerOptions.standalone ? undefined : () => popup.open.value ? "Close suggestions" : "Open suggestions",
      "aria-labelledby": triggerOptions.standalone
        ? () => [labelId(), `${id}-value`].filter(Boolean).join(" ") || undefined
        : undefined,
      "aria-haspopup": triggerOptions.standalone ? "listbox" : undefined,
      "aria-controls": `${id}-list`,
      "aria-expanded": () => popup.open.value,
      "aria-activedescendant": triggerOptions.standalone ? activeDescendantId : undefined,
      disabled: () => disabled.value,
      form: options.form,
      "data-clank-part": "trigger",
      "data-standalone": triggerOptions.standalone ? "" : undefined,
      "data-selection-presentation": presentation,
      ...commonStateProps(),
      ...(triggerOptions.agentId ? { agentId: triggerOptions.agentId } : {}),
      ...(triggerOptions.agentLabel ? { agentLabel: triggerOptions.agentLabel } : {}),
      ...(triggerOptions.standalone ? {
        ref: (element: HTMLElement | null) => {
          popup.triggerElement.value = element;
          resetBinding.ref(element);
        },
      } : {}),
      onKeyDown: triggerOptions.standalone
        ? (event: KeyboardEvent) => {
          if (event.defaultPrevented || disabled.peek() || readOnly.peek()) return;
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          if (!popup.open.peek()) {
            prepareStandaloneSearch(event);
            popup.show("trigger-press", event);
          }
          queueMicrotask(() => popupInputElement?.focus());
          event.preventDefault();
        }
        : undefined,
      onClick: (event: Event) => {
        if (event.defaultPrevented || disabled.peek()) return;
        const opening = triggerOptions.standalone && !popup.open.peek();
        if (opening) prepareStandaloneSearch(event);
        popup.toggle("trigger-press", event);
        if (triggerOptions.standalone) {
          if (popup.open.peek()) queueMicrotask(() => popupInputElement?.focus());
        } else focusById(event.currentTarget, controlId);
      },
    }),
    clear: () => ({
      type: "button",
      "aria-label": "Clear",
      disabled: () => disabled.value,
      hidden: () => inputState.value.value === "" && selectionValues(valueState.value.value, multiple).length === 0,
      "data-clank-part": "clear",
      "data-disabled": () => disabled.value ? "" : undefined,
      "data-visible": () => inputState.value.value !== "" || selectionValues(valueState.value.value, multiple).length > 0 ? "" : undefined,
      onClick: (event: Event) => {
        if (event.defaultPrevented || disabled.peek() || readOnly.peek()) return;
        if (clearEditable(event)) focusById(event.currentTarget, controlId);
      },
    }),
    icon: () => ({
      "aria-hidden": true,
      "data-clank-part": "icon",
      "data-popup-open": () => popup.open.value ? "" : undefined,
    }),
    valuePart: (valueOptions = {}) => ({
      id: `${id}-value`,
      "data-clank-part": "value",
      "data-placeholder": () => selectionValues(valueState.value.value, multiple).length === 0 && inputState.value.value === "" ? "" : undefined,
      ...commonStateProps(),
      children: () => {
        if (autocomplete) return inputState.value.value || valueOptions.placeholder || "";
        const labels = selectionValues(valueState.value.value, multiple)
          .map((value) => findItem(items, value, equals)?.label)
          .filter((label): label is string => label !== undefined);
        return labels.length ? labels.join(", ") : valueOptions.placeholder ?? "";
      },
    }),
    isMounted: popup.isMounted,
    portal: (portalOptions) => mergeProps(popup.portal(portalOptions), {
      "data-clank-part": "portal",
      "data-selection-presentation": presentation,
    }),
    list: () => ({
      id: `${id}-list`, role: "listbox", tabIndex: -1, dir: direction,
      "aria-labelledby": labelId,
      "aria-multiselectable": multiple || undefined,
      "data-clank-part": "list",
      "data-empty": () => filteredItems.value.length === 0 ? "" : undefined,
      ...commonStateProps(),
      onMouseDown: (event: MouseEvent) => { if (!event.defaultPrevented) event.preventDefault(); },
    }),
    popup: () => mergeProps(
      popup.popup({ role: "presentation", labelledBy: false, describedBy: false }),
      { "data-selection-presentation": presentation },
    ),
    positioner: () => mergeProps(popup.positioner(), { "data-selection-presentation": presentation }),
    backdrop: () => mergeProps(popup.backdrop(), { "data-selection-presentation": presentation }),
    arrow: popup.arrow,
    status: () => ({
      role: "status", "aria-live": "polite", "aria-atomic": true,
      "data-clank-part": "status",
      children: () => `${filteredItems.value.length} result${filteredItems.value.length === 1 ? "" : "s"} available.`,
    }),
    empty: () => ({ hidden: () => filteredItems.value.length !== 0, "data-clank-part": "empty" }),
    collection: () => ({ "data-clank-part": "collection" }),
    row: () => ({ role: "presentation", "data-clank-part": "row" }),
    item(value) {
      const filteredIndex = () => filteredItems.value.findIndex((item) => equals(item.value, value));
      const index = filteredItems.peek().findIndex((item) => equals(item.value, value));
      const item = filteredItems.peek()[index];
      if (!item) throw new TypeError("Unknown filtered item value.");
      const canonicalIndex = itemIndex(items, item.value, equals);
      if (canonicalIndex < 0) throw new TypeError("Filtered items must identify a declared item.");
      return {
        id: itemId(id, canonicalIndex), role: "option", tabIndex: -1,
        "aria-selected": () => selected(value),
        "aria-disabled": item.disabled || undefined,
        "data-highlighted": () => highlightedIndex.value === filteredIndex() ? "" : undefined,
        "data-selected": () => selected(value) ? "" : undefined,
        "data-disabled": item.disabled ? "" : undefined,
        "data-clank-part": "item",
        onPointerMove: (event: PointerEvent) => {
          const current = filteredIndex();
          if (!event.defaultPrevented && !item.disabled && event.pointerType !== "touch" && current >= 0) highlightedIndex.value = current;
        },
        onPointerLeave: (event: PointerEvent) => {
          const current = filteredIndex();
          const keepHighlight = autocomplete && Boolean((options as AutocompleteOptions<Value>).keepHighlight);
          if (!event.defaultPrevented && autocomplete && !keepHighlight && current >= 0 && highlightedIndex.peek() === current) {
            highlightedIndex.value = -1;
          }
        },
        onMouseDown: (event: MouseEvent) => { if (!event.defaultPrevented) event.preventDefault(); },
        onClick: (event: Event) => {
          if (!event.defaultPrevented) choose(value, "item-press", event);
        },
      };
    },
    itemIndicator: (value) => ({ "aria-hidden": true, hidden: () => !selected(value), "data-clank-part": "item-indicator" }),
    group: (name) => ({ role: "group", "aria-labelledby": groupId(id, name), "data-clank-part": "group" }),
    groupLabel: (name) => ({ id: groupId(id, name), "data-clank-part": "group-label" }),
    separator: () => ({ role: "separator", "data-clank-part": "separator" }),
    chips: () => ({ role: "list", "aria-label": "Selected values", "data-clank-part": "chips" }),
    chip(value) {
      const item = findItem(items, value, equals);
      if (!item) throw new TypeError("Unknown selected chip value.");
      return { role: "listitem", "data-clank-part": "chip", "data-value": serializeValue(value, options.serialize) };
    },
    chipRemove(value) {
      const item = findItem(items, value, equals);
      if (!item) throw new TypeError("Unknown selected chip value.");
      return {
        type: "button", "aria-label": `Remove ${item.label}`, "data-clank-part": "chip-remove",
        onClick: (event: Event) => { if (!event.defaultPrevented) choose(value, "remove", event); },
      };
    },
    hiddenInputs: () => {
      if (autocomplete && !multiple) return [];
      const controls = stableSelectionInputs({
        id,
        items,
        value: valueState.value,
        multiple,
        equals,
        serialize: options.serialize,
        name,
        form: options.form,
        autoComplete: options.autoComplete,
        disabled,
      });
      const submissionControls = [...controls];
      if (field || options.required) controls.unshift(requiredProxy({
        id: `${id}-validation`,
        form: options.form,
        disabled: () => disabled.value,
        required: field ? () => required.value : Boolean(options.required),
        valid: () => nativeProjectionHasValue(submissionControls),
        focusId: controlId,
        fieldPart,
      }) as typeof controls[number]);
      return controls;
    },
    manifest: () => createSelectionManifest(autocomplete ? "Autocomplete" : "Combobox", id, {
      open: popup.open.peek(), inputValue: inputState.value.peek(), multiple, presentation,
      selected: selectionValues(valueState.value.peek(), multiple).map((value) => findItem(items, value, equals)?.label ?? "unknown"),
      resultCount: filteredItems.peek().length, highlightedIndex: highlightedIndex.peek(),
    }),
    dispose() {
      inputElements.clear();
      activeInputElement = null;
      popupInputElement = null;
      stopHighlightReconciliation();
      resetBinding.dispose();
      popup.dispose();
    },
  };
  return controller;
}

function createSelectionManifest(component: string, id: string, state: Record<string, unknown>): UiManifest {
  const selectParts = [
    { name: "label", defaultElement: "div" },
    { name: "trigger", role: "combobox", defaultElement: "button", required: true },
    { name: "value", defaultElement: "span" },
    { name: "icon", defaultElement: "span" },
    { name: "portal", defaultElement: "div" },
    { name: "backdrop", defaultElement: "div" },
    { name: "positioner", defaultElement: "div" },
    { name: "popup", role: "presentation", defaultElement: "div" },
    { name: "scroll-up-arrow", defaultElement: "div" },
    { name: "arrow", defaultElement: "div" },
    { name: "list", role: "listbox", defaultElement: "div", required: true },
    { name: "item", role: "option", defaultElement: "div", required: true },
    { name: "item-text", defaultElement: "div" },
    { name: "item-indicator", defaultElement: "span" },
    { name: "separator", role: "separator", defaultElement: "div" },
    { name: "group", role: "group", defaultElement: "div" },
    { name: "group-label", defaultElement: "div" },
    { name: "scroll-down-arrow", defaultElement: "div" },
    { name: "form-control", defaultElement: "input" },
    { name: "hidden-input", defaultElement: "input" },
  ];
  const editableParts = [
    { name: "label", defaultElement: "label" },
    { name: "input-group", defaultElement: "div" },
    { name: "input", role: "combobox", defaultElement: "input", required: true },
    { name: "trigger", defaultElement: "button" },
    { name: "icon", defaultElement: "span" },
    { name: "clear", defaultElement: "button" },
    { name: "value", defaultElement: "span" },
    ...(component === "Combobox" ? [
      { name: "chips", role: "list", defaultElement: "div" },
      { name: "chip", role: "listitem", defaultElement: "div" },
      { name: "chip-remove", defaultElement: "button" },
    ] : []),
    { name: "portal", defaultElement: "div" },
    { name: "backdrop", defaultElement: "div" },
    { name: "positioner", defaultElement: "div" },
    { name: "popup", role: "presentation", defaultElement: "div" },
    { name: "arrow", defaultElement: "div" },
    { name: "status", role: "status", defaultElement: "div" },
    { name: "empty", defaultElement: "div" },
    { name: "list", role: "listbox", defaultElement: "div", required: true },
    { name: "row", role: "presentation", defaultElement: "div" },
    { name: "item", role: "option", defaultElement: "div", required: true },
    ...(component === "Combobox" ? [{ name: "item-indicator", defaultElement: "span" }] : []),
    { name: "separator", role: "separator", defaultElement: "div" },
    { name: "group", role: "group", defaultElement: "div" },
    { name: "group-label", defaultElement: "div" },
    { name: "collection", defaultElement: "div" },
    ...(component === "Combobox" ? [
      { name: "form-control", defaultElement: "input" },
      { name: "hidden-input", defaultElement: "input" },
    ] : []),
  ];
  return createUiManifest({
    component, id, state,
    parts: component === "Select" ? selectParts : editableParts,
    actions: [
      { name: "select", description: "Select or unselect one item.", sideEffects: "write", reasons: ["item-press", "keyboard"] },
      { name: "clear", description: "Clear the current value.", sideEffects: "write", reasons: ["clear"] },
      { name: "show", description: "Open the suggestion list.", sideEffects: "write" },
      { name: "hide", description: "Close the suggestion list.", sideEffects: "write" },
    ],
    keyboard: { ArrowDown: "Open or move to the next option", ArrowUp: "Open or move to the previous option", Enter: "Select the highlighted option", Escape: "Close the list", Home: "Move to the first option", End: "Move to the last option" },
  });
}

interface StableSelectionInputsOptions<Value> {
  id: string;
  items: readonly SelectionItem<Value>[];
  value: Computed<Value | readonly Value[] | null>;
  multiple: boolean;
  equals: (left: Value, right: Value) => boolean;
  serialize?: (value: Value) => string;
  name?: string;
  form?: string;
  autoComplete?: string;
  disabled: Computed<boolean>;
}

/**
 * Returns a mount-stable native projection. Clank updates function-valued DOM
 * props reactively, but it intentionally does not rerender a component merely
 * because a signal was read. Multiple selection therefore mounts one hidden
 * input per declared item and reactively disables unselected entries.
 */
function stableSelectionInputs<Value>(options: StableSelectionInputsOptions<Value>): Record<string, unknown>[] {
  if (options.name === undefined) return [];
  const serializedItems = options.items.map((item) => serializeValue(item.value, options.serialize));
  const shared = (index: number) => ({
    id: `${options.id}-hidden-${index}`,
    type: "hidden",
    name: options.name,
    form: options.form,
    autoComplete: options.autoComplete,
    "data-clank-part": "hidden-input",
  });
  if (options.multiple) {
    return options.items.map((item, index) => ({
      ...shared(index),
      value: serializedItems[index],
      disabled: () => options.disabled.value
        || !isSelected(options.value.value, item.value, true, options.equals),
    }));
  }
  return [{
    ...shared(0),
    value: () => {
      const current = options.value.value;
      if (current === null) return "";
      const index = itemIndex(options.items, current as Value, options.equals);
      if (index < 0) throw new TypeError("A form-associated selection value must identify a declared item.");
      return serializedItems[index]!;
    },
    disabled: () => options.disabled.value || options.value.value === null,
  }];
}

function validateItems<Value>(items: readonly SelectionItem<Value>[], equals: ((left: Value, right: Value) => boolean) | undefined): SelectionItem<Value>[] {
  if (!Array.isArray(items)) throw new TypeError("Selection items must be an array.");
  const compare = equals ?? Object.is;
  const output = items.map((item, index) => {
    if (!item || typeof item !== "object" || !String(item.label).trim()) throw new TypeError(`Selection item ${index} requires a label.`);
    return { ...item, label: String(item.label) };
  });
  for (let index = 0; index < output.length; index++) {
    if (output.slice(0, index).some((item) => compare(item.value, output[index]!.value))) throw new TypeError("Selection item values must be unique.");
  }
  return output;
}

function normalizeSelection<Value>(
  value: Value | readonly Value[] | null | undefined,
  multiple: boolean,
  items: readonly SelectionItem<Value>[],
  equals: (left: Value, right: Value) => boolean,
  source: string,
): Value | readonly Value[] | null {
  if (value == null) return multiple ? [] : null;
  if (multiple) {
    if (!Array.isArray(value)) throw new TypeError(`${source} must be an array in multiple mode.`);
    const entries = [...value] as Value[];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (!findItem(items, entry, equals)) throw new TypeError(`${source} contains an unknown item value.`);
      if (entries.slice(0, index).some((previous) => equals(previous, entry))) {
        throw new TypeError(`${source} cannot contain duplicate item values.`);
      }
    }
    return entries;
  }
  if (Array.isArray(value)) throw new TypeError(`${source} cannot be an array in single mode.`);
  const entry = value as Value;
  if (!findItem(items, entry, equals)) throw new TypeError(`${source} contains an unknown item value.`);
  return entry;
}
function cloneSelection<Value>(value: Value | readonly Value[] | null, multiple: boolean): Value | readonly Value[] | null {
  return multiple ? selectionValues(value, true) : value;
}
function selectionValues<Value>(value: Value | readonly Value[] | null | undefined, multiple: boolean): Value[] {
  if (value == null) return [];
  if (multiple) {
    if (!Array.isArray(value)) throw new TypeError("A multiple selection value must be an array.");
    return [...value] as Value[];
  }
  if (Array.isArray(value)) throw new TypeError("A single selection value cannot be an array.");
  return [value as Value];
}
function selectionEquals<Value>(
  left: Value | readonly Value[] | null,
  right: Value | readonly Value[] | null,
  multiple: boolean,
  equals: (a: Value, b: Value) => boolean,
): boolean {
  if (!multiple) return left === null || right === null ? left === right : equals(left as Value, right as Value);
  const a = selectionValues(left, true);
  const b = selectionValues(right, true);
  return a.length === b.length && a.every((value, index) => equals(value, b[index]!));
}
function isSelected<Value>(selection: Value | readonly Value[] | null, value: Value, multiple: boolean, equals: (a: Value, b: Value) => boolean): boolean {
  if (selection === null) return false;
  return multiple
    ? selectionValues(selection, true).some((entry) => equals(entry, value))
    : equals(selection as Value, value);
}
function selectedLabelFor<Value>(
  selection: Value | readonly Value[] | null,
  items: readonly SelectionItem<Value>[],
  multiple: boolean,
  equals: (a: Value, b: Value) => boolean,
): string {
  if (multiple || selection === null) return "";
  return findItem(items, selection as Value, equals)?.label ?? "";
}
function findItem<Value>(items: readonly SelectionItem<Value>[], value: Value, equals: (a: Value, b: Value) => boolean): SelectionItem<Value> | undefined { return items.find((item) => equals(item.value, value)); }
function itemIndex<Value>(items: readonly SelectionItem<Value>[], value: Value, equals: (a: Value, b: Value) => boolean): number { return items.findIndex((item) => equals(item.value, value)); }
function firstEnabled<Value>(items: readonly SelectionItem<Value>[]): number { return items.findIndex((item) => !item.disabled); }
function lastEnabled<Value>(items: readonly SelectionItem<Value>[]): number { for (let index = items.length - 1; index >= 0; index--) if (!items[index]!.disabled) return index; return -1; }
function itemId(id: string, index: number): string { return `${id}-item-${index}`; }
function groupId(id: string, name: string): string { return `${id}-group-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`; }
function requireId(value: string, component: string): string { const id = value?.trim(); if (!id || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new TypeError(`${component} requires a valid id.`); return id; }
function readBoolean(value: boolean | (() => boolean)): boolean { return typeof value === "function" ? Boolean(value()) : Boolean(value); }
function serializeValue<Value>(value: Value, serialize?: (value: Value) => string): string {
  let serialized: unknown;
  if (serialize) serialized = serialize(value);
  else if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") serialized = String(value);
  else if (typeof value === "number" && Number.isFinite(value)) serialized = String(value);
  else throw new TypeError("Non-primitive selection values require a serialize option for form submission.");
  if (typeof serialized !== "string") throw new TypeError("A selection serializer must return a string.");
  if (serialized.includes("\0")) throw new TypeError("Serialized selection values cannot contain null bytes.");
  return serialized;
}

function readSelectionOption<Value>(
  value: SelectionValue<Value> | (() => SelectionValue<Value>) | undefined,
): SelectionValue<Value> | undefined {
  return typeof value === "function" ? (value as () => SelectionValue<Value>)() : value;
}

function nativeProjectionHasValue(controls: readonly Record<string, unknown>[]): boolean {
  return controls.some((control) => {
    const disabled = typeof control.disabled === "function"
      ? Boolean((control.disabled as () => unknown)())
      : Boolean(control.disabled);
    if (disabled) return false;
    const value = typeof control.value === "function"
      ? (control.value as () => unknown)()
      : control.value;
    return value !== undefined;
  });
}

interface FormResetBinding {
  ref(element: HTMLElement | null): void;
  dispose(): void;
}

function createFormResetBinding(formId: string | undefined, reset: (event: Event) => void): FormResetBinding {
  let remove: (() => void) | undefined;
  const dispose = () => {
    const cleanup = remove;
    remove = undefined;
    cleanup?.();
  };
  return {
    ref(element) {
      dispose();
      if (!element) return;
      const associated = (element as HTMLElement & { form?: HTMLFormElement | null }).form;
      const explicit = formId ? element.ownerDocument?.getElementById(formId) : null;
      const closest = typeof element.closest === "function" ? element.closest("form") : null;
      const form = associated ?? explicit ?? closest;
      if (!form || typeof form.addEventListener !== "function" || typeof form.removeEventListener !== "function") return;
      const onReset = (event: Event) => reset(event);
      form.addEventListener("reset", onReset);
      remove = () => form.removeEventListener("reset", onReset);
    },
    dispose,
  };
}

interface RequiredProxyOptions {
  id: string;
  form?: string;
  disabled(): boolean;
  required: boolean | (() => boolean);
  valid(): boolean;
  focusId: string;
  fieldPart?: Record<string, unknown>;
}

function requiredProxy(options: RequiredProxyOptions): Record<string, unknown> {
  return {
    id: options.id,
    type: "text",
    tabIndex: -1,
    required: options.required,
    form: options.form,
    value: () => options.valid() ? "1" : "",
    disabled: () => options.disabled(),
    "aria-hidden": true,
    "data-clank-part": "form-control",
    "data-clank-native-control": "selection",
    style: {
      position: "fixed",
      insetInlineStart: "0",
      insetBlockEnd: "0",
      width: "1px",
      height: "1px",
      padding: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    },
    onInvalid: (event: Event) => {
      const fieldInvalid = options.fieldPart?.onInvalid;
      if (typeof fieldInvalid === "function") (fieldInvalid as (event: Event) => void)(event);
      focusById(event.currentTarget, options.focusId);
    },
    ...(options.fieldPart ? {
      use: (element: Element): Cleanup | undefined => mountPartUse(options.fieldPart, element),
    } : {}),
  };
}

interface SelectionStateOptions {
  field?: FieldController<any>;
  disabled(): boolean;
  readOnly(): boolean;
  required(): boolean;
  dirty(): boolean;
  touched(): boolean;
  filled(): boolean;
  focused(): boolean;
}

function selectionStateProps(options: SelectionStateOptions): Record<string, unknown> {
  return {
    "data-disabled": () => options.disabled() ? "" : undefined,
    "data-readonly": () => options.readOnly() ? "" : undefined,
    "data-required": () => options.required() ? "" : undefined,
    "data-dirty": () => (options.field?.dirty.value ?? options.dirty()) ? "" : undefined,
    "data-touched": () => (options.field?.touched.value ?? options.touched()) ? "" : undefined,
    "data-filled": () => (options.field?.filled.value ?? options.filled()) ? "" : undefined,
    "data-focused": () => (options.field?.focused.value ?? options.focused()) ? "" : undefined,
    "data-pending": () => options.field?.pending.value ? "" : undefined,
    "data-valid": () => options.field?.valid.value === true ? "" : undefined,
    "data-invalid": () => options.field?.valid.value === false ? "" : undefined,
  };
}

function readFieldFlag(field: FieldController<any> | undefined, key: "disabled" | "readOnly" | "required"): boolean {
  if (!field) return false;
  return field[key].value;
}

function shouldValidateSelectionFieldOnBlur(field: FieldController<any> | undefined): boolean {
  return field?.validationMode === "onBlur" || field?.validationMode === "onChange";
}

function containsSelectionFocus(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (!container || !target || typeof target !== "object") return false;
  if (container === target) return true;
  try {
    return typeof container.contains === "function" && container.contains(target as Node);
  } catch {
    return false;
  }
}

function createPartPresence(name: string): {
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

function mountPartUse(part: Record<string, unknown> | undefined, element: Element): Cleanup | undefined {
  const use = part?.use;
  if (typeof use !== "function") return undefined;
  const cleanup = (use as (element: Element) => void | Cleanup)(element);
  return typeof cleanup === "function" ? cleanup : undefined;
}

function readStringPartProp(part: Record<string, unknown> | undefined, key: string): string | undefined {
  return readStringProp(part?.[key]);
}

function readStringProp(value: unknown): string | undefined {
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
}

function focusById(source: EventTarget | null, id: string): void {
  const ownerDocument = (source as { ownerDocument?: Document } | null)?.ownerDocument;
  ownerDocument?.getElementById(id)?.focus();
}
function normalizeText(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase(); }
function equalText(left: string, right: string, collator?: Intl.Collator): boolean { return collator ? collator.compare(left, right) === 0 : left === right; }
function comparePrefix(source: string, needle: string, collator?: Intl.Collator): boolean { return equalText([...source].slice(0, [...needle].length).join(""), needle, collator); }
