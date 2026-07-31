import { computed, effect, signal, type Cleanup, type Computed } from "./core.ts";
import {
  createChangeDetails,
  createControllableState,
  createUiManifest,
  isEventCanceled,
  resolveDirection,
  type ChangeDetails,
} from "./ui-foundation.ts";
import { useDirection } from "./ui-composition.ts";
import type { FieldController } from "./ui-fields.ts";

/** A static value or an SSR-safe reactive getter. */
export type UiReadable<T> = T | (() => T);

export type UiControlPart = Readonly<{
  name: string;
  element: string;
  defaultElement: string;
  role?: string;
  description: string;
}>;

export type UiControlAction = Readonly<{
  name: string;
  description: string;
  sideEffects: "none" | "read" | "write";
  parameters?: ReadonlyArray<Readonly<{
    name: string;
    type: string;
    required: boolean;
  }>>;
}>;

type UiControlParameter = NonNullable<UiControlAction["parameters"]>[number];

/** A JSON-safe description of a headless control for agents and development tools. */
export interface UiControlManifest {
  protocol: "clank-ui/1";
  kind: string;
  component: string;
  id: string;
  parts: readonly UiControlPart[];
  state: Record<string, unknown>;
  actions: readonly UiControlAction[];
}

export interface ControlIndicatorOptions {
  /** Keep an inactive indicator mounted for CSS transitions. */
  keepMounted?: boolean;
}

export interface ControlRootPartOptions extends AgentPartOptions {
  /** Use native button semantics instead of the wrapping-label-friendly span contract. */
  nativeButton?: boolean;
}

export type ButtonPressReason = "press" | "programmatic";

export interface ButtonOptions {
  id: string;
  disabled?: UiReadable<boolean>;
  focusableWhenDisabled?: boolean;
  type?: "button" | "submit" | "reset";
  form?: string;
  name?: string;
  value?: string;
  onPress?: (details: ChangeDetails<ButtonPressReason>) => void;
}

export interface ButtonController {
  readonly id: string;
  readonly disabled: Computed<boolean>;
  press(event?: Event, reason?: ButtonPressReason): boolean;
  root(options?: AgentPartOptions): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Native-first button behavior that also remains operable when its props are put on a custom element. */
export function createButton(options: ButtonOptions): ButtonController {
  const id = requireId(options.id, "Button");
  const disabled = booleanState(options.disabled, `${id}.disabled`);
  const press = (event?: Event, reason: ButtonPressReason = "programmatic") => {
    if (disabled.peek()) return false;
    const details = createChangeDetails(reason, event);
    options.onPress?.(details);
    return !details.canceled;
  };
  return {
    id,
    disabled,
    press,
    root(partOptions = {}) {
      const nativeDisabled = () => disabled.value && options.focusableWhenDisabled !== true;
      let spaceArmed = false;
      return {
        id,
        "data-clank-part": "root",
        role: "button",
        tabIndex: () => nativeDisabled() ? -1 : 0,
        type: options.type ?? "button",
        ...(options.form ? { form: options.form } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.value !== undefined ? { value: options.value } : {}),
        disabled: nativeDisabled,
        "aria-disabled": () => disabled.value,
        "data-disabled": () => disabled.value ? "" : undefined,
        ...agentProps(partOptions),
        onClick: (event: Event) => {
          if (event.defaultPrevented) return;
          if (disabled.peek()) {
            event.preventDefault();
            event.stopPropagation?.();
            return;
          }
          if (!press(event, "press")) event.preventDefault();
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (isNativeButton(event.currentTarget) || event.defaultPrevented) return;
          if (event.key === "Enter") {
            if (!event.repeat && !disabled.peek()) press(event, "press");
            event.preventDefault();
            return;
          }
          if (event.key === " ") {
            if (!event.repeat) spaceArmed = true;
            event.preventDefault();
          }
        },
        onKeyUp: (event: KeyboardEvent) => {
          if (isNativeButton(event.currentTarget) || event.key !== " " || event.defaultPrevented) return;
          const activate = spaceArmed;
          spaceArmed = false;
          if (activate && !disabled.peek()) press(event, "press");
          event.preventDefault();
        },
        onBlur: () => { spaceArmed = false; },
      };
    },
    manifest: () => controlManifest("button", id, [
      part("root", "button", "button", "The interactive button."),
    ], {
      disabled: disabled.peek(),
      type: options.type ?? "button",
    }, [action("press", "Activate the button.")]),
  };
}

export type AvatarStatus = "idle" | "loading" | "loaded" | "error";
export type AvatarChangeReason = "loading" | "load" | "error" | "reset" | "programmatic";

export interface AvatarOptions {
  id: string;
  src?: string;
  status?: AvatarStatus | (() => AvatarStatus);
  defaultStatus?: AvatarStatus;
  onStatusChange?: (status: AvatarStatus, details: ChangeDetails<AvatarChangeReason>) => void;
}

export interface AvatarController {
  readonly id: string;
  readonly status: Computed<AvatarStatus>;
  setStatus(status: AvatarStatus, reason?: AvatarChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  image(options: { alt: string; src?: string }): Record<string, unknown>;
  fallback(options?: { delay?: number }): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Loading/error state and parts for an accessible image avatar with a fallback. */
export function createAvatar(options: AvatarOptions): AvatarController {
  const id = requireId(options.id, "Avatar");
  const initial = avatarStatus(options.defaultStatus ?? (options.src ? "loading" : "idle"));
  const state = createControllableState<AvatarStatus, AvatarChangeReason>({
    ...(options.status !== undefined ? {
      value: () => avatarStatus(readValue(options.status as UiReadable<AvatarStatus>)),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onStatusChange,
    name: `${id}.status`,
  });
  const setStatus = (next: AvatarStatus, reason: AvatarChangeReason = "programmatic", event?: Event) =>
    state.set(avatarStatus(next), reason, event);
  return {
    id,
    status: state.value,
    setStatus,
    reset: (event) => state.set(initial, "reset", event),
    root: () => ({
      id,
      "data-clank-part": "root",
      "data-state": () => state.value.value,
    }),
    image(imageOptions) {
      const source = imageOptions.src ?? options.src;
      return {
        ...(source !== undefined ? { src: source } : {}),
        alt: imageOptions.alt,
        "data-clank-part": "image",
        "data-state": () => state.value.value,
        hidden: () => state.value.value !== "loaded",
        onLoad: (event: Event) => setStatus("loaded", "load", event),
        onError: (event: Event) => setStatus("error", "error", event),
        use: (element: Element): Cleanup | void => {
          const image = element as HTMLImageElement;
          if (source === undefined) return;
          if (!image.complete) {
            setStatus("loading", "loading");
            return;
          }
          setStatus(image.naturalWidth > 0 ? "loaded" : "error", image.naturalWidth > 0 ? "load" : "error");
        },
      };
    },
    fallback(fallbackOptions = {}) {
      const delay = nonNegativeNumber(fallbackOptions.delay ?? 0, "Avatar fallback delay");
      const ready = signal(state.value.peek() !== "loading" || delay === 0, { name: `${id}.fallbackReady` });
      return {
        "data-clank-part": "fallback",
        "data-state": () => state.value.value,
        "data-delayed": () => state.value.value === "loading" && !ready.value ? "" : undefined,
        hidden: () => state.value.value === "loaded" || (state.value.value === "loading" && !ready.value),
        use: (): Cleanup => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = effect(() => {
            const status = state.value.value;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            if (status !== "loading" || delay === 0) {
              ready.value = true;
              return;
            }
            ready.value = false;
            timer = setTimeout(() => {
              timer = undefined;
              if (state.value.peek() === "loading") ready.value = true;
            }, delay);
          });
          return () => {
            stop();
            if (timer !== undefined) clearTimeout(timer);
          };
        },
      };
    },
    manifest: () => controlManifest("avatar", id, [
      part("root", "span", undefined, "The avatar container."),
      part("image", "img", undefined, "The avatar image."),
      part("fallback", "span", undefined, "Fallback content while the image is unavailable."),
    ], { status: state.value.peek() }, [
      action("setStatus", "Report the avatar image loading status.", parameter("status", "idle | loading | loaded | error")),
      action("reset", "Restore the initial avatar status."),
    ]),
  };
}

export type CheckboxState = boolean | "indeterminate";
export type CheckboxChangeReason = "toggle" | "check" | "uncheck" | "input" | "reset" | "programmatic";

export interface CheckboxOptions {
  id: string;
  checked?: CheckboxState | (() => CheckboxState);
  defaultChecked?: CheckboxState;
  /** Forces mixed-state presentation without discarding the underlying checked value. */
  indeterminate?: UiReadable<boolean>;
  field?: FieldController<CheckboxState>;
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  required?: UiReadable<boolean>;
  name?: string;
  value?: string;
  /** Submitted through `uncheckedInput()` when the checkbox is not checked. */
  uncheckedValue?: string;
  form?: string;
  onCheckedChange?: (checked: CheckboxState, details: ChangeDetails<CheckboxChangeReason>) => void;
}

export interface CheckboxController {
  readonly id: string;
  readonly checked: Computed<CheckboxState>;
  readonly indeterminate: Computed<boolean>;
  readonly disabled: Computed<boolean>;
  readonly readOnly: Computed<boolean>;
  setChecked(checked: CheckboxState, reason?: CheckboxChangeReason, event?: Event): boolean;
  toggle(event?: Event): boolean;
  reset(event?: Event): boolean;
  root(options?: ControlRootPartOptions): Record<string, unknown>;
  indicator(options?: ControlIndicatorOptions): Record<string, unknown>;
  input(): Record<string, unknown>;
  /** Optional hidden projection for explicit unchecked form values. */
  uncheckedInput(): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Tri-state checkbox behavior with a synchronized native input for forms and reset events. */
export function createCheckbox(options: CheckboxOptions): CheckboxController {
  const id = requireId(options.id, "Checkbox");
  if (options.field && options.checked !== undefined) {
    throw new TypeError("Checkbox cannot use both field and checked control.");
  }
  const initial = checkboxState(options.field ? options.field.value.peek() : options.defaultChecked ?? false);
  const checked = createControllableState<CheckboxState, CheckboxChangeReason>({
    ...(options.field
      ? { value: () => checkboxState(options.field!.value.value) }
      : options.checked !== undefined
        ? { value: () => checkboxState(readValue(options.checked as UiReadable<CheckboxState>)) }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onCheckedChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) {
        details.cancel();
      }
    },
    name: `${id}.checked`,
  });
  const disabled = booleanState(() => readBoolean(options.disabled) || fieldFlag(options.field, "disabled"), `${id}.disabled`);
  const readOnly = booleanState(() => readBoolean(options.readOnly) || fieldFlag(options.field, "readOnly"), `${id}.readOnly`);
  const required = booleanState(() => readBoolean(options.required) || fieldFlag(options.field, "required"), `${id}.required`);
  const indeterminate = computed(
    () => checked.value.value === "indeterminate" || readBoolean(options.indeterminate),
    { name: `${id}.indeterminate` },
  );
  const visualState = (): CheckboxState => indeterminate.value ? "indeterminate" : checked.value.value === true;
  const rootId = options.field?.controlId ?? id;
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: rootId,
    type: "checkbox",
    parse: (element) => (element as HTMLInputElement).indeterminate ? "indeterminate" : (element as HTMLInputElement).checked,
    format: () => options.value ?? "on",
  });
  const blocked = () => disabled.peek() || readOnly.peek();
  const setChecked = (next: CheckboxState, reason: CheckboxChangeReason = "programmatic", event?: Event) =>
    blocked() ? false : checked.set(checkboxState(next), reason, event);
  const toggle = (event?: Event) => setChecked(checked.value.peek() === true ? false : true, "toggle", event);
  const reset = (event?: Event) => {
    if (event && isEventCanceled(event)) return false;
    const alreadyInitial = Object.is(checked.value.peek(), initial);
    const changed = checked.set(initial, "reset", event);
    if (!changed && !alreadyInitial) return false;
    resetField(options.field);
    return changed;
  };
  const native = nativeBooleanInputDirective({
    value: () => checked.value.value === true,
    indeterminate: () => indeterminate.value,
    disabled: () => disabled.value,
    readOnly: () => readOnly.value,
    focusId: rootId,
    update: (input, event) => setChecked(input.indeterminate ? "indeterminate" : input.checked, "input", event),
    reset,
  });
  return {
    id,
    checked: checked.value,
    indeterminate,
    disabled,
    readOnly,
    setChecked,
    toggle,
    reset,
    root(partOptions = {}) {
      const nativeButton = partOptions.nativeButton === true;
      return {
        id: rootId,
        "data-clank-part": "root",
        role: "checkbox",
        ...nativeChoiceRootProps(nativeButton, () => disabled.value),
        "aria-checked": () => indeterminate.value ? "mixed" : checked.value.value === true,
        "aria-readonly": () => readOnly.value || undefined,
        "aria-required": () => required.value || undefined,
        ...fieldRelationshipProps(fieldPart),
        "data-state": () => checkboxDataState(visualState()),
        "data-checked": () => checked.value.value === true ? "" : undefined,
        "data-unchecked": () => checked.value.value === false ? "" : undefined,
        "data-indeterminate": () => indeterminate.value ? "" : undefined,
        "data-disabled": () => disabled.value ? "" : undefined,
        "data-readonly": () => readOnly.value ? "" : undefined,
        "data-required": () => required.value ? "" : undefined,
        ...fieldStateProps(options.field),
        ...agentProps(partOptions),
        ...fieldFocusProps(options.field),
        onClick: (event: Event) => {
          if (event.defaultPrevented || blocked()) return;
          toggle(event);
          if (!nativeButton) event.preventDefault?.();
        },
        onKeyDown: (event: KeyboardEvent) => activateSpaceOnly(event, blocked, () => toggle(event)),
      };
    },
    indicator: (indicatorOptions = {}) => ({
      "aria-hidden": true,
      "data-clank-part": "indicator",
      "data-state": () => checkboxDataState(visualState()),
      "data-checked": () => checked.value.value === true ? "" : undefined,
      "data-unchecked": () => checked.value.value === false ? "" : undefined,
      "data-indeterminate": () => indeterminate.value ? "" : undefined,
      ...fieldStateProps(options.field),
      hidden: () => indicatorOptions.keepMounted === true ? false : visualState() === false,
    }),
    input: () => ({
      id: `${rootId}-input`,
      "data-clank-part": "input",
      type: "checkbox",
      ...(name ? { name } : {}),
      value: options.value ?? "on",
      ...(options.form ? { form: options.form } : {}),
      checked: () => checked.value.value === true,
      defaultChecked: initial === true,
      disabled: () => disabled.value,
      required: () => required.value,
      tabIndex: -1,
      "aria-hidden": true,
      style: nativeProjectionStyle(),
      "data-clank-native-control": "checkbox",
      onInvalid: fieldPart?.onInvalid,
      use: composeDirectives(native, fieldPart?.use),
    }),
    uncheckedInput: () => ({
      id: `${rootId}-unchecked-input`,
      "data-clank-part": "unchecked-input",
      type: "hidden",
      ...(name ? { name } : {}),
      ...(options.form ? { form: options.form } : {}),
      value: options.uncheckedValue ?? "",
      disabled: () => !name || options.uncheckedValue === undefined || disabled.value || checked.value.value === true,
      "aria-hidden": true,
    }),
    manifest: () => controlManifest("checkbox", id, checkboxParts(), {
      checked: checked.value.peek(),
      indeterminate: indeterminate.peek(),
      disabled: disabled.peek(),
      readOnly: readOnly.peek(),
      required: required.peek(),
      name: name ?? null,
      value: options.value ?? "on",
      uncheckedValue: options.uncheckedValue ?? null,
    }, [
      action("setChecked", "Set the checkbox state.", parameter("checked", "boolean | indeterminate")),
      action("toggle", "Toggle the checkbox."),
      action("reset", "Restore the default checkbox state."),
    ]),
  };
}

export interface ChoiceItemDefinition<Value extends string> {
  value: Value;
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
}

export type ChoiceItem<Value extends string> = Value | ChoiceItemDefinition<Value>;
export type CheckboxGroupChangeReason = "toggle" | "parent-toggle" | "input" | "reset" | "programmatic";

export interface CheckboxGroupOptions<Value extends string> {
  id: string;
  items: readonly ChoiceItem<Value>[];
  value?: readonly Value[] | (() => readonly Value[]);
  defaultValue?: readonly Value[];
  field?: FieldController<readonly Value[]>;
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  required?: UiReadable<boolean>;
  name?: string;
  form?: string;
  onValueChange?: (value: readonly Value[], details: ChangeDetails<CheckboxGroupChangeReason>) => void;
}

export interface CheckboxGroupParentOptions extends ControlRootPartOptions {
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  /** Adds an application-owned mixed state, useful when this parent also represents a nested group. */
  indeterminate?: UiReadable<boolean>;
}

export interface CheckboxGroupParentIndicatorOptions extends ControlIndicatorOptions {
  indeterminate?: UiReadable<boolean>;
}

export interface CheckboxGroupController<Value extends string> {
  readonly id: string;
  readonly value: Computed<readonly Value[]>;
  readonly parentState: Computed<CheckboxState>;
  setValue(value: readonly Value[], reason?: CheckboxGroupChangeReason, event?: Event): boolean;
  toggle(value: Value, event?: Event): boolean;
  toggleAll(event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  parent(options?: CheckboxGroupParentOptions): Record<string, unknown>;
  parentIndicator(options?: CheckboxGroupParentIndicatorOptions): Record<string, unknown>;
  item(value: Value, options?: ControlRootPartOptions): Record<string, unknown>;
  indicator(value: Value, options?: ControlIndicatorOptions): Record<string, unknown>;
  input(value: Value): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** A named checkbox collection with shared state, at-least-one validation, and native form values. */
export function createCheckboxGroup<Value extends string>(
  options: CheckboxGroupOptions<Value>,
): CheckboxGroupController<Value> {
  const id = requireId(options.id, "Checkbox group");
  if (options.field && options.value !== undefined) {
    throw new TypeError("Checkbox group cannot use both field and value control.");
  }
  const items = normalizeItems(options.items, "Checkbox group");
  const initial = normalizeSelection(
    options.field ? options.field.value.peek() : options.defaultValue ?? [],
    items,
    "Checkbox group defaultValue",
  );
  const state = createControllableState<readonly Value[], CheckboxGroupChangeReason>({
    ...(options.field
      ? { value: () => normalizeSelection(options.field!.value.value, items, "Checkbox group field value") }
      : options.value !== undefined
        ? {
            value: () => normalizeSelection(
              readValue(options.value as UiReadable<readonly Value[]>),
              items,
              "Checkbox group value",
            ),
          }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) {
        details.cancel();
      }
    },
    equals: shallowEqual,
    name: `${id}.value`,
  });
  const disabled = booleanState(() => readBoolean(options.disabled) || fieldFlag(options.field, "disabled"), `${id}.disabled`);
  const readOnly = booleanState(() => readBoolean(options.readOnly) || fieldFlag(options.field, "readOnly"), `${id}.readOnly`);
  const required = booleanState(() => readBoolean(options.required) || fieldFlag(options.field, "required"), `${id}.required`);
  const rootId = options.field?.controlId ?? id;
  const name = options.name ?? options.field?.name;
  const rootFieldPart = options.field?.control({ id: rootId });
  const definition = (value: Value) => requireItem(items, value, "Checkbox group");
  const itemDisabled = (value: Value) => disabled.peek() || readBoolean(definition(value).disabled);
  const itemReadOnly = (value: Value) => readOnly.peek() || readBoolean(definition(value).readOnly);
  const parentState = computed<CheckboxState>(() => {
    const selected = state.value.value.length;
    if (selected === 0) return false;
    return selected === items.length ? true : "indeterminate";
  }, { name: `${id}.parentState` });
  let parentCycle: "mixed" | "on" | "off" = "mixed";
  const setValue = (next: readonly Value[], reason: CheckboxGroupChangeReason = "programmatic", event?: Event) => {
    if (disabled.peek() || readOnly.peek()) return false;
    const changed = state.set(normalizeSelection(next, items, "Checkbox group value"), reason, event);
    if (changed && reason !== "parent-toggle") parentCycle = "mixed";
    return changed;
  };
  const toggle = (value: Value, event?: Event) => {
    definition(value);
    if (itemDisabled(value) || itemReadOnly(value)) return false;
    const current = state.value.peek();
    const changed = state.set(current.includes(value) ? current.filter((entry) => entry !== value) : orderedSelection([...current, value], items), "toggle", event);
    if (changed) parentCycle = "mixed";
    return changed;
  };
  const toggleAll = (event?: Event) => {
    if (disabled.peek() || readOnly.peek()) return false;
    const current = state.value.peek();
    const locked = items
      .filter((item) => (readBoolean(item.disabled) || readBoolean(item.readOnly)) && current.includes(item.value))
      .map((item) => item.value);
    const all = items
      .filter((item) => (!readBoolean(item.disabled) && !readBoolean(item.readOnly)) || current.includes(item.value))
      .map((item) => item.value);
    const allSelected = shallowEqual(current, all);
    const next = allSelected || (parentCycle === "on" && current.length > 0) ? locked : all;
    const changed = state.set(next, "parent-toggle", event);
    if (changed) parentCycle = shallowEqual(next, all) ? "on" : "off";
    return changed;
  };
  const reset = (event?: Event) => {
    if (event && isEventCanceled(event)) return false;
    const alreadyInitial = shallowEqual(state.value.peek(), initial);
    const changed = state.set(initial, "reset", event);
    if (!changed && !alreadyInitial) return false;
    parentCycle = "mixed";
    resetField(options.field);
    return changed;
  };
  let resetEvent: Event | undefined;
  const resetOnce = (event?: Event) => {
    if (event && resetEvent === event) return false;
    resetEvent = event;
    if (event) queueMicrotask(() => { if (resetEvent === event) resetEvent = undefined; });
    return reset(event);
  };
  return {
    id,
    value: state.value,
    parentState,
    setValue,
    toggle,
    toggleAll,
    reset,
    root: () => ({
      id: rootId,
      "data-clank-part": "root",
      role: "group",
      tabIndex: -1,
      "aria-disabled": () => disabled.value || undefined,
      "aria-readonly": () => readOnly.value || undefined,
      "aria-required": () => required.value || undefined,
      ...fieldRelationshipProps(rootFieldPart),
      "data-state": () => groupDataState(state.value.value.length, items.length),
      "data-disabled": () => disabled.value ? "" : undefined,
      "data-readonly": () => readOnly.value ? "" : undefined,
      "data-required": () => required.value ? "" : undefined,
      ...fieldStateProps(options.field),
    }),
    parent(partOptions = {}) {
      const nativeButton = partOptions.nativeButton === true;
      const isDisabled = () => disabled.value || readBoolean(partOptions.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(partOptions.readOnly);
      const stateValue = (): CheckboxState => readBoolean(partOptions.indeterminate) ? "indeterminate" : parentState.value;
      return {
        id: `${id}-parent`,
        "data-clank-part": "parent",
        "data-parent": "",
        role: "checkbox",
        ...nativeChoiceRootProps(nativeButton, isDisabled),
        "aria-checked": () => stateValue() === "indeterminate" ? "mixed" : stateValue(),
        "aria-readonly": () => isReadOnly() || undefined,
        "aria-controls": items.map((item) => choiceId(id, item.value)).join(" "),
        "data-state": () => checkboxDataState(stateValue()),
        "data-checked": () => stateValue() === true ? "" : undefined,
        "data-unchecked": () => stateValue() === false ? "" : undefined,
        "data-indeterminate": () => stateValue() === "indeterminate" ? "" : undefined,
        "data-disabled": () => isDisabled() ? "" : undefined,
        "data-readonly": () => isReadOnly() ? "" : undefined,
        ...fieldStateProps(options.field),
        ...agentProps(partOptions),
        ...fieldFocusProps(options.field),
        onClick: (event: Event) => {
          if (event.defaultPrevented || isDisabled() || isReadOnly()) return;
          toggleAll(event);
          if (!nativeButton) event.preventDefault?.();
        },
        onKeyDown: (event: KeyboardEvent) => activateSpaceOnly(event, () => isDisabled() || isReadOnly(), () => toggleAll(event)),
      };
    },
    parentIndicator(indicatorOptions = {}) {
      const stateValue = (): CheckboxState => readBoolean(indicatorOptions.indeterminate) ? "indeterminate" : parentState.value;
      return {
        "aria-hidden": true,
        "data-clank-part": "parent-indicator",
        "data-state": () => checkboxDataState(stateValue()),
        "data-checked": () => stateValue() === true ? "" : undefined,
        "data-unchecked": () => stateValue() === false ? "" : undefined,
        "data-indeterminate": () => stateValue() === "indeterminate" ? "" : undefined,
        ...fieldStateProps(options.field),
        hidden: () => indicatorOptions.keepMounted === true ? false : stateValue() === false,
      };
    },
    item(value, partOptions = {}) {
      const item = definition(value);
      const isChecked = () => state.value.value.includes(value);
      const isDisabled = () => disabled.value || readBoolean(item.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(item.readOnly);
      const nativeButton = partOptions.nativeButton === true;
      return {
        id: choiceId(id, value),
        "data-clank-part": "item",
        role: "checkbox",
        ...nativeChoiceRootProps(nativeButton, isDisabled),
        "aria-checked": isChecked,
        "aria-readonly": () => isReadOnly() || undefined,
        "aria-required": () => required.value || undefined,
        "data-state": () => isChecked() ? "checked" : "unchecked",
        "data-checked": () => isChecked() ? "" : undefined,
        "data-unchecked": () => !isChecked() ? "" : undefined,
        "data-disabled": () => isDisabled() ? "" : undefined,
        "data-readonly": () => isReadOnly() ? "" : undefined,
        "data-required": () => required.value ? "" : undefined,
        ...fieldStateProps(options.field),
        ...agentProps(partOptions),
        ...fieldFocusProps(options.field),
        onClick: (event: Event) => {
          if (!event.defaultPrevented && !isDisabled() && !isReadOnly()) {
            toggle(value, event);
            if (!nativeButton) event.preventDefault?.();
          }
        },
        onKeyDown: (event: KeyboardEvent) => activateSpaceOnly(event, () => isDisabled() || isReadOnly(), () => toggle(value, event)),
      };
    },
    indicator(value, indicatorOptions = {}) {
      definition(value);
      return {
        "aria-hidden": true,
        "data-clank-part": "indicator",
        "data-state": () => state.value.value.includes(value) ? "checked" : "unchecked",
        "data-checked": () => state.value.value.includes(value) ? "" : undefined,
        "data-unchecked": () => state.value.value.includes(value) ? undefined : "",
        ...fieldStateProps(options.field),
        hidden: () => indicatorOptions.keepMounted === true ? false : !state.value.value.includes(value),
      };
    },
    input(value) {
      const item = definition(value);
      const isDisabled = () => disabled.value || readBoolean(item.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(item.readOnly);
      const directive = nativeBooleanInputDirective({
        value: () => state.value.value.includes(value),
        disabled: isDisabled,
        readOnly: isReadOnly,
        focusId: choiceId(id, value),
        update: (input, event) => {
          if (input.checked !== state.value.peek().includes(value)) toggle(value, event);
        },
        reset: resetOnce,
      });
      const fieldPart = options.field?.control({
        id: rootId,
        type: "checkbox",
        parse: () => state.value.peek(),
        format: () => value,
      });
      return {
        id: `${choiceId(id, value)}-input`,
        "data-clank-part": "input",
        type: "checkbox",
        ...(name ? { name } : {}),
        value,
        ...(options.form ? { form: options.form } : {}),
        checked: () => state.value.value.includes(value),
        defaultChecked: initial.includes(value),
        disabled: isDisabled,
        required: () => required.value && state.value.value.length === 0,
        tabIndex: -1,
        "aria-hidden": true,
        style: nativeProjectionStyle(),
        "data-clank-native-control": "checkbox-group-item",
        onInvalid: fieldPart?.onInvalid,
        use: composeDirectives(directive, fieldPart?.use),
      };
    },
    manifest: () => controlManifest("checkbox-group", id, [
      part("root", "div", "group", "The checkbox group container."),
      part("parent", "span", "checkbox", "The optional select-all parent checkbox."),
      part("parent-indicator", "span", undefined, "The parent's checked or mixed indicator."),
      part("item", "span", "checkbox", "A wrapping-label-friendly checkbox item."),
      part("indicator", "span", undefined, "An item's checked indicator."),
      part("input", "input", undefined, "The native form participant for an item."),
    ], {
      value: [...state.value.peek()],
      items: items.map((item) => item.value),
      disabled: disabled.peek(),
      readOnly: readOnly.peek(),
      required: required.peek(),
      name: name ?? null,
      parentState: parentState.peek(),
    }, [
      action("setValue", "Replace the selected checkbox values.", parameter("value", "string[]")),
      action("toggle", "Toggle one checkbox value.", parameter("value", "string")),
      action("toggleAll", "Toggle every mutable checkbox value through the parent control."),
      action("reset", "Restore the default checkbox values."),
    ]),
  };
}

export type RadioGroupChangeReason = "select" | "input" | "keyboard" | "reset" | "programmatic";

export interface RadioGroupOptions<Value extends string> {
  id: string;
  items: readonly ChoiceItem<Value>[];
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  field?: FieldController<Value | null>;
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  required?: UiReadable<boolean>;
  name?: string;
  form?: string;
  orientation?: "horizontal" | "vertical";
  direction?: "ltr" | "rtl" | "auto";
  loop?: boolean;
  onValueChange?: (value: Value | null, details: ChangeDetails<RadioGroupChangeReason>) => void;
}

export interface RadioGroupController<Value extends string> {
  readonly id: string;
  readonly value: Computed<Value | null>;
  select(value: Value, reason?: RadioGroupChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  item(value: Value, options?: ControlRootPartOptions): Record<string, unknown>;
  indicator(value: Value, options?: ControlIndicatorOptions): Record<string, unknown>;
  input(value: Value): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** WAI-ARIA radio-group behavior with roving focus, arrow navigation, and native form radios. */
export function createRadioGroup<Value extends string>(options: RadioGroupOptions<Value>): RadioGroupController<Value> {
  const id = requireId(options.id, "Radio group");
  if (options.field && options.value !== undefined) {
    throw new TypeError("Radio group cannot use both field and value control.");
  }
  const direction = options.direction ?? useDirection();
  const items = normalizeItems(options.items, "Radio group");
  const normalize = (value: Value | null, label: string) => value === null ? null : requireItem(items, value, label).value;
  const initial = normalize(options.field ? options.field.value.peek() : options.defaultValue ?? null, "Radio group defaultValue");
  const state = createControllableState<Value | null, RadioGroupChangeReason>({
    ...(options.field
      ? { value: () => normalize(options.field!.value.value, "Radio group field value") }
      : options.value !== undefined
        ? { value: () => normalize(readValue(options.value as UiReadable<Value | null>), "Radio group value") }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) {
        details.cancel();
      }
    },
    name: `${id}.value`,
  });
  const disabled = booleanState(() => readBoolean(options.disabled) || fieldFlag(options.field, "disabled"), `${id}.disabled`);
  const readOnly = booleanState(() => readBoolean(options.readOnly) || fieldFlag(options.field, "readOnly"), `${id}.readOnly`);
  const required = booleanState(() => readBoolean(options.required) || fieldFlag(options.field, "required"), `${id}.required`);
  const rootId = options.field?.controlId ?? id;
  const name = options.name ?? options.field?.name;
  const rootFieldPart = options.field?.control({ id: rootId });
  const definition = (value: Value) => requireItem(items, value, "Radio group");
  const itemDisabled = (item: ChoiceItemDefinition<Value>) => disabled.value || readBoolean(item.disabled);
  const itemReadOnly = (item: ChoiceItemDefinition<Value>) => readOnly.value || readBoolean(item.readOnly);
  const focusedCandidate = signal<Value | null>(initial, { name: `${id}.focusedValue` });
  const enabledItems = () => items.filter((item) => !itemDisabled(item));
  const rovingValue = (): Value | null => {
    const selected = state.value.value;
    if (selected !== null && !itemDisabled(definition(selected))) return selected;
    const candidate = focusedCandidate.value;
    if (candidate !== null && !itemDisabled(definition(candidate))) return candidate;
    return enabledItems()[0]?.value ?? null;
  };
  const select = (value: Value, reason: RadioGroupChangeReason = "programmatic", event?: Event) => {
    const item = definition(value);
    if (itemDisabled(item) || itemReadOnly(item)) return false;
    const changed = state.set(value, reason, event);
    if (changed || state.value.peek() === value) focusedCandidate.value = value;
    return changed;
  };
  const reset = (event?: Event) => {
    if (event && isEventCanceled(event)) return false;
    const alreadyInitial = Object.is(state.value.peek(), initial);
    const changed = state.set(initial, "reset", event);
    if (!changed && !alreadyInitial) return false;
    focusedCandidate.value = initial;
    resetField(options.field);
    return changed;
  };
  let resetEvent: Event | undefined;
  const resetOnce = (event?: Event) => {
    if (event && resetEvent === event) return false;
    resetEvent = event;
    if (event) queueMicrotask(() => { if (resetEvent === event) resetEvent = undefined; });
    return reset(event);
  };
  const move = (value: Value, direction: -1 | 1, event: KeyboardEvent) => {
    if (readOnly.peek()) return;
    const enabled = enabledItems();
    if (enabled.length === 0) return;
    let index = enabled.findIndex((item) => item.value === value);
    if (index < 0) index = direction > 0 ? -1 : 0;
    let nextIndex = index + direction;
    if (options.loop !== false) nextIndex = (nextIndex + enabled.length) % enabled.length;
    else nextIndex = Math.max(0, Math.min(enabled.length - 1, nextIndex));
    const next = enabled[nextIndex]!;
    if (event.defaultPrevented) return;
    if (!select(next.value, "keyboard", event) && state.value.peek() !== next.value) return;
    event.preventDefault();
    focusChoice(event.currentTarget as HTMLElement, choiceId(id, next.value));
  };
  return {
    id,
    value: state.value,
    select,
    reset,
    root: () => ({
      id: rootId,
      "data-clank-part": "root",
      role: "radiogroup",
      "aria-orientation": options.orientation ?? "horizontal",
      "aria-disabled": () => disabled.value || undefined,
      "aria-readonly": () => readOnly.value || undefined,
      "aria-required": () => required.value || undefined,
      ...fieldRelationshipProps(rootFieldPart),
      "data-orientation": options.orientation ?? "horizontal",
      "data-state": () => state.value.value === null ? "empty" : "selected",
      "data-disabled": () => disabled.value ? "" : undefined,
      "data-readonly": () => readOnly.value ? "" : undefined,
      "data-required": () => required.value ? "" : undefined,
      ...fieldStateProps(options.field),
    }),
    item(value, partOptions = {}) {
      const item = definition(value);
      const isChecked = () => state.value.value === value;
      const isDisabled = () => disabled.value || readBoolean(item.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(item.readOnly);
      const nativeButton = partOptions.nativeButton === true;
      const fieldFocus = fieldFocusProps(options.field);
      return {
        id: choiceId(id, value),
        "data-clank-part": "item",
        role: "radio",
        ...(nativeButton
          ? { type: "button", disabled: isDisabled }
          : { "aria-disabled": () => isDisabled() || undefined }),
        "aria-checked": isChecked,
        "aria-readonly": () => isReadOnly() || undefined,
        "aria-required": () => required.value || undefined,
        tabIndex: () => rovingValue() === value ? 0 : -1,
        "data-state": () => isChecked() ? "checked" : "unchecked",
        "data-checked": () => isChecked() ? "" : undefined,
        "data-unchecked": () => !isChecked() ? "" : undefined,
        "data-disabled": () => isDisabled() ? "" : undefined,
        "data-readonly": () => isReadOnly() ? "" : undefined,
        "data-required": () => required.value ? "" : undefined,
        ...fieldStateProps(options.field),
        ...agentProps(partOptions),
        onFocus: () => {
          if (!isDisabled()) focusedCandidate.value = value;
          (fieldFocus.onFocus as (() => void) | undefined)?.();
        },
        onBlur: (event: FocusEvent) => {
          const current = event.currentTarget as Element | null;
          const related = event.relatedTarget as Node | null;
          const root = current?.ownerDocument?.getElementById(rootId);
          if (root && related && root.contains(related)) return;
          (fieldFocus.onBlur as ((event: FocusEvent) => void) | undefined)?.(event);
        },
        onClick: (event: Event) => {
          if (!event.defaultPrevented) select(value, "select", event);
        },
        onKeyDown: (event: KeyboardEvent) => {
          const horizontal = (options.orientation ?? "horizontal") === "horizontal";
          const textDirection = resolveDirection(direction, event.currentTarget as Element);
          const nextKey = horizontal ? textDirection === "rtl" ? "ArrowLeft" : "ArrowRight" : "ArrowDown";
          const previousKey = horizontal ? textDirection === "rtl" ? "ArrowRight" : "ArrowLeft" : "ArrowUp";
          if (event.key === nextKey) move(value, 1, event);
          else if (event.key === previousKey) move(value, -1, event);
          else if (event.key === "Home" || event.key === "End") {
            const enabled = enabledItems();
            const next = event.key === "Home" ? enabled[0] : enabled.at(-1);
            if (!next || readOnly.peek()) return;
            if (event.defaultPrevented) return;
            if (!select(next.value, "keyboard", event) && state.value.peek() !== next.value) return;
            event.preventDefault();
            focusChoice(event.currentTarget as HTMLElement, choiceId(id, next.value));
          } else if (event.key === " " || event.key === "Enter") {
            activateSpaceOnly(event, () => isDisabled() || isReadOnly(), () => select(value, "keyboard", event));
          }
        },
      };
    },
    indicator(value, indicatorOptions = {}) {
      definition(value);
      return {
        "aria-hidden": true,
        "data-clank-part": "indicator",
        "data-state": () => state.value.value === value ? "checked" : "unchecked",
        "data-checked": () => state.value.value === value ? "" : undefined,
        "data-unchecked": () => state.value.value === value ? undefined : "",
        ...fieldStateProps(options.field),
        hidden: () => indicatorOptions.keepMounted === true ? false : state.value.value !== value,
      };
    },
    input(value) {
      const item = definition(value);
      const isDisabled = () => disabled.value || readBoolean(item.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(item.readOnly);
      const fieldPart = options.field?.control({
        id: rootId,
        type: "radio",
        parse: () => state.value.peek(),
        format: () => value,
      });
      return {
        id: `${choiceId(id, value)}-input`,
        "data-clank-part": "input",
        type: "radio",
        ...(name ? { name } : {}),
        value,
        ...(options.form ? { form: options.form } : {}),
        checked: () => state.value.value === value,
        defaultChecked: initial === value,
        disabled: isDisabled,
        required: () => required.value,
        tabIndex: -1,
        "aria-hidden": true,
        style: nativeProjectionStyle(),
        "data-clank-native-control": "radio",
        onInvalid: fieldPart?.onInvalid,
        use: composeDirectives(nativeBooleanInputDirective({
          value: () => state.value.value === value,
          disabled: isDisabled,
          readOnly: isReadOnly,
          focusId: choiceId(id, value),
          update: (input, event) => { if (input.checked) select(value, "input", event); },
          reset: resetOnce,
        }), fieldPart?.use),
      };
    },
    manifest: () => controlManifest("radio-group", id, [
      part("root", "div", "radiogroup", "The radio group container."),
      part("item", "span", "radio", "A wrapping-label-friendly radio option."),
      part("indicator", "span", undefined, "The selected indicator."),
      part("input", "input", undefined, "The native form radio."),
    ], {
      value: state.value.peek(),
      items: items.map((item) => item.value),
      orientation: options.orientation ?? "horizontal",
      direction,
      disabled: disabled.peek(),
      readOnly: readOnly.peek(),
      required: required.peek(),
      name: name ?? null,
    }, [
      action("select", "Select a radio value.", parameter("value", "string")),
      action("reset", "Restore the default radio value."),
    ]),
  };
}

export type SwitchChangeReason = "toggle" | "input" | "reset" | "programmatic";

export interface SwitchOptions {
  id: string;
  checked?: boolean | (() => boolean);
  defaultChecked?: boolean;
  field?: FieldController<boolean>;
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  required?: UiReadable<boolean>;
  name?: string;
  value?: string;
  /** Submitted through `uncheckedInput()` when the switch is off. */
  uncheckedValue?: string;
  form?: string;
  onCheckedChange?: (checked: boolean, details: ChangeDetails<SwitchChangeReason>) => void;
}

export interface SwitchController {
  readonly id: string;
  readonly checked: Computed<boolean>;
  setChecked(checked: boolean, reason?: SwitchChangeReason, event?: Event): boolean;
  toggle(event?: Event): boolean;
  reset(event?: Event): boolean;
  root(options?: ControlRootPartOptions): Record<string, unknown>;
  thumb(): Record<string, unknown>;
  input(): Record<string, unknown>;
  /** Optional hidden projection for explicit off-state form values. */
  uncheckedInput(): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Binary switch behavior backed by a native checkbox for submission, validation, and form reset. */
export function createSwitch(options: SwitchOptions): SwitchController {
  const id = requireId(options.id, "Switch");
  if (options.field && options.checked !== undefined) {
    throw new TypeError("Switch cannot use both field and checked control.");
  }
  const initial = Boolean(options.field ? options.field.value.peek() : options.defaultChecked);
  const state = createControllableState<boolean, SwitchChangeReason>({
    ...(options.field
      ? { value: () => Boolean(options.field!.value.value) }
      : options.checked !== undefined
        ? { value: () => Boolean(readValue(options.checked as UiReadable<boolean>)) }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onCheckedChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) {
        details.cancel();
      }
    },
    name: `${id}.checked`,
  });
  const disabled = booleanState(() => readBoolean(options.disabled) || fieldFlag(options.field, "disabled"), `${id}.disabled`);
  const readOnly = booleanState(() => readBoolean(options.readOnly) || fieldFlag(options.field, "readOnly"), `${id}.readOnly`);
  const required = booleanState(() => readBoolean(options.required) || fieldFlag(options.field, "required"), `${id}.required`);
  const rootId = options.field?.controlId ?? id;
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: rootId,
    type: "checkbox",
    parse: (element) => (element as HTMLInputElement).checked,
    format: () => options.value ?? "on",
  });
  const blocked = () => disabled.peek() || readOnly.peek();
  const setChecked = (next: boolean, reason: SwitchChangeReason = "programmatic", event?: Event) =>
    blocked() ? false : state.set(Boolean(next), reason, event);
  const toggle = (event?: Event) => setChecked(!state.value.peek(), "toggle", event);
  const reset = (event?: Event) => {
    if (event && isEventCanceled(event)) return false;
    const alreadyInitial = Object.is(state.value.peek(), initial);
    const changed = state.set(initial, "reset", event);
    if (!changed && !alreadyInitial) return false;
    resetField(options.field);
    return changed;
  };
  const stateProps = () => ({
    "data-state": () => state.value.value ? "checked" : "unchecked",
    "data-checked": () => state.value.value ? "" : undefined,
    "data-unchecked": () => !state.value.value ? "" : undefined,
    "data-disabled": () => disabled.value ? "" : undefined,
    "data-readonly": () => readOnly.value ? "" : undefined,
    "data-required": () => required.value ? "" : undefined,
    ...fieldStateProps(options.field),
  });
  return {
    id,
    checked: state.value,
    setChecked,
    toggle,
    reset,
    root(partOptions = {}) {
      const nativeButton = partOptions.nativeButton === true;
      return {
        id: rootId,
        "data-clank-part": "root",
        role: "switch",
        ...nativeChoiceRootProps(nativeButton, () => disabled.value),
        "aria-checked": () => state.value.value,
        "aria-readonly": () => readOnly.value || undefined,
        "aria-required": () => required.value || undefined,
        ...fieldRelationshipProps(fieldPart),
        ...stateProps(),
        ...agentProps(partOptions),
        ...fieldFocusProps(options.field),
        onClick: (event: Event) => {
          if (!event.defaultPrevented && !blocked()) {
            toggle(event);
            if (!nativeButton) event.preventDefault?.();
          }
        },
        onKeyDown: (event: KeyboardEvent) => activateCustomButton(event, blocked, () => toggle(event)),
      };
    },
    thumb: () => ({ "aria-hidden": true, "data-clank-part": "thumb", ...stateProps() }),
    input: () => ({
      id: `${rootId}-input`,
      "data-clank-part": "input",
      type: "checkbox",
      role: "switch",
      ...(name ? { name } : {}),
      value: options.value ?? "on",
      ...(options.form ? { form: options.form } : {}),
      checked: () => state.value.value,
      defaultChecked: initial,
      disabled: () => disabled.value,
      required: () => required.value,
      tabIndex: -1,
      "aria-hidden": true,
      style: nativeProjectionStyle(),
      "data-clank-native-control": "switch",
      onInvalid: fieldPart?.onInvalid,
      use: composeDirectives(nativeBooleanInputDirective({
        value: () => state.value.value,
        disabled: () => disabled.value,
        readOnly: () => readOnly.value,
        focusId: rootId,
        update: (input, event) => setChecked(input.checked, "input", event),
        reset,
      }), fieldPart?.use),
    }),
    uncheckedInput: () => ({
      id: `${rootId}-unchecked-input`,
      "data-clank-part": "unchecked-input",
      type: "hidden",
      ...(name ? { name } : {}),
      ...(options.form ? { form: options.form } : {}),
      value: options.uncheckedValue ?? "",
      disabled: () => !name || options.uncheckedValue === undefined || disabled.value || state.value.value,
      "aria-hidden": true,
    }),
    manifest: () => controlManifest("switch", id, [
      part("root", "span", "switch", "The wrapping-label-friendly interactive switch."),
      part("thumb", "span", undefined, "The visual switch thumb."),
      part("input", "input", "switch", "The native form participant."),
      part("unchecked-input", "input", undefined, "The optional hidden off-state form participant."),
    ], {
      checked: state.value.peek(),
      disabled: disabled.peek(),
      readOnly: readOnly.peek(),
      required: required.peek(),
      name: name ?? null,
      value: options.value ?? "on",
      uncheckedValue: options.uncheckedValue ?? null,
    }, [
      action("setChecked", "Set the switch state.", parameter("checked", "boolean")),
      action("toggle", "Toggle the switch."),
      action("reset", "Restore the default switch state."),
    ]),
  };
}

export type ToggleChangeReason = "toggle" | "reset" | "programmatic";

export interface ToggleOptions {
  id: string;
  pressed?: boolean | (() => boolean);
  defaultPressed?: boolean;
  disabled?: UiReadable<boolean>;
  onPressedChange?: (pressed: boolean, details: ChangeDetails<ToggleChangeReason>) => void;
}

export interface ToggleController {
  readonly id: string;
  readonly pressed: Computed<boolean>;
  setPressed(pressed: boolean, reason?: ToggleChangeReason, event?: Event): boolean;
  toggle(event?: Event): boolean;
  reset(event?: Event): boolean;
  root(options?: AgentPartOptions): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** A controlled or uncontrolled two-state pressed button. */
export function createToggle(options: ToggleOptions): ToggleController {
  const id = requireId(options.id, "Toggle");
  const initial = Boolean(options.defaultPressed);
  const state = createControllableState<boolean, ToggleChangeReason>({
    ...(options.pressed !== undefined ? {
      value: () => Boolean(readValue(options.pressed as UiReadable<boolean>)),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onPressedChange,
    name: `${id}.pressed`,
  });
  const disabled = booleanState(options.disabled, `${id}.disabled`);
  const setPressed = (next: boolean, reason: ToggleChangeReason = "programmatic", event?: Event) =>
    disabled.peek() ? false : state.set(Boolean(next), reason, event);
  const toggle = (event?: Event) => setPressed(!state.value.peek(), "toggle", event);
  const reset = (event?: Event) => state.set(initial, "reset", event);
  return {
    id,
    pressed: state.value,
    setPressed,
    toggle,
    reset,
    root(partOptions = {}) {
      return {
        id,
        "data-clank-part": "root",
        type: "button",
        disabled: () => disabled.value,
        "aria-pressed": () => state.value.value,
        "data-state": () => state.value.value ? "on" : "off",
        "data-pressed": () => state.value.value ? "" : undefined,
        "data-unpressed": () => !state.value.value ? "" : undefined,
        "data-disabled": () => disabled.value ? "" : undefined,
        ...agentProps(partOptions),
        onClick: (event: Event) => {
          if (!event.defaultPrevented && !disabled.peek()) toggle(event);
        },
        onKeyDown: (event: KeyboardEvent) => activateCustomButton(event, () => disabled.peek(), () => toggle(event)),
      };
    },
    manifest: () => controlManifest("toggle", id, [
      part("root", "button", "button", "The pressed/unpressed toggle button."),
    ], { pressed: state.value.peek(), disabled: disabled.peek() }, [
      action("setPressed", "Set the pressed state.", parameter("pressed", "boolean")),
      action("toggle", "Toggle the pressed state."),
      action("reset", "Restore the default pressed state."),
    ]),
  };
}

interface ToggleGroupCommonOptions<Value extends string> {
  id: string;
  items: readonly ChoiceItem<Value>[];
  disabled?: UiReadable<boolean>;
  readOnly?: UiReadable<boolean>;
  orientation?: "horizontal" | "vertical";
  direction?: "ltr" | "rtl" | "auto";
  loop?: boolean;
}

export interface ToggleGroupSingleOptions<Value extends string> extends ToggleGroupCommonOptions<Value> {
  multiple?: false;
  value?: Value | null | (() => Value | null);
  defaultValue?: Value | null;
  onValueChange?: (value: Value | null, details: ChangeDetails<ToggleGroupChangeReason>) => void;
}

export interface ToggleGroupMultipleOptions<Value extends string> extends ToggleGroupCommonOptions<Value> {
  multiple: true;
  value?: readonly Value[] | (() => readonly Value[]);
  defaultValue?: readonly Value[];
  onValueChange?: (value: readonly Value[], details: ChangeDetails<ToggleGroupChangeReason>) => void;
}

export type ToggleGroupChangeReason = "toggle" | "reset" | "programmatic";

export interface ToggleGroupSingleController<Value extends string> {
  readonly id: string;
  readonly multiple: false;
  readonly value: Computed<Value | null>;
  setValue(value: Value | null, reason?: ToggleGroupChangeReason, event?: Event): boolean;
  toggle(value: Value, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  item(value: Value, options?: AgentPartOptions): Record<string, unknown>;
  manifest(): UiControlManifest;
}

export interface ToggleGroupMultipleController<Value extends string> {
  readonly id: string;
  readonly multiple: true;
  readonly value: Computed<readonly Value[]>;
  setValue(value: readonly Value[], reason?: ToggleGroupChangeReason, event?: Event): boolean;
  toggle(value: Value, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  item(value: Value, options?: AgentPartOptions): Record<string, unknown>;
  manifest(): UiControlManifest;
}

export function createToggleGroup<Value extends string>(
  options: ToggleGroupSingleOptions<Value>,
): ToggleGroupSingleController<Value>;
export function createToggleGroup<Value extends string>(
  options: ToggleGroupMultipleOptions<Value>,
): ToggleGroupMultipleController<Value>;
/** Single- or multiple-selection toggle buttons with roving keyboard focus. */
export function createToggleGroup<Value extends string>(
  options: ToggleGroupSingleOptions<Value> | ToggleGroupMultipleOptions<Value>,
): ToggleGroupSingleController<Value> | ToggleGroupMultipleController<Value> {
  const id = requireId(options.id, "Toggle group");
  const direction = options.direction ?? useDirection();
  const items = normalizeItems(options.items, "Toggle group");
  const multiple = options.multiple === true;
  const normalize = (input: Value | null | readonly Value[], label: string): Value | null | readonly Value[] => {
    if (multiple) {
      if (!Array.isArray(input)) throw new TypeError(`${label} must be an array in multiple mode.`);
      return normalizeSelection(input as readonly Value[], items, label);
    }
    if (Array.isArray(input)) throw new TypeError(`${label} must be one value or null in single mode.`);
    return input === null ? null : requireItem(items, input as Value, label).value;
  };
  const defaultInput = options.defaultValue ?? (multiple ? [] : null);
  const initial = normalize(defaultInput, "Toggle group defaultValue");
  const controlled = options.value;
  const state = createControllableState<Value | null | readonly Value[], ToggleGroupChangeReason>({
    ...(controlled !== undefined ? {
      value: typeof controlled === "function"
        ? () => normalize(controlled(), "Toggle group value")
        : normalize(controlled, "Toggle group value"),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange as ((value: Value | null | readonly Value[], details: ChangeDetails<ToggleGroupChangeReason>) => void) | undefined,
    equals: (left, right) => Array.isArray(left) && Array.isArray(right) ? shallowEqual(left, right) : Object.is(left, right),
    name: `${id}.value`,
  });
  const disabled = booleanState(options.disabled, `${id}.disabled`);
  const readOnly = booleanState(options.readOnly, `${id}.readOnly`);
  const definition = (value: Value) => requireItem(items, value, "Toggle group");
  const itemDisabled = (item: ChoiceItemDefinition<Value>) => disabled.peek() || readBoolean(item.disabled);
  const itemReadOnly = (item: ChoiceItemDefinition<Value>) => readOnly.peek() || readBoolean(item.readOnly);
  const setValue = (next: Value | null | readonly Value[], reason: ToggleGroupChangeReason = "programmatic", event?: Event) => {
    if (disabled.peek() || readOnly.peek()) return false;
    return state.set(normalize(next, "Toggle group value"), reason, event);
  };
  const toggle = (value: Value, event?: Event) => {
    const item = definition(value);
    if (itemDisabled(item) || itemReadOnly(item)) return false;
    const current = state.value.peek();
    if (multiple) {
      const values = current as readonly Value[];
      return state.set(values.includes(value) ? values.filter((entry) => entry !== value) : orderedSelection([...values, value], items), "toggle", event);
    }
    return state.set(current === value ? null : value, "toggle", event);
  };
  const reset = (event?: Event) => state.set(initial, "reset", event);
  const enabledItems = () => items.filter((item) => !itemDisabled(item));
  const initialFocused = (() => {
    const selected = multiple
      ? (state.value.peek() as readonly Value[])[0]
      : state.value.peek() as Value | null;
    return selected && !itemDisabled(definition(selected)) ? selected : enabledItems()[0]?.value ?? null;
  })();
  const focusedValue = signal<Value | null>(initialFocused, { name: `${id}.focusedValue` });
  const rovingValue = (): Value | null => {
    const current = focusedValue.value;
    if (current !== null && !itemDisabled(definition(current))) return current;
    const selected = multiple
      ? (state.value.value as readonly Value[]).find((value) => !itemDisabled(definition(value)))
      : state.value.value !== null && !itemDisabled(definition(state.value.value as Value))
        ? state.value.value as Value
        : undefined;
    return selected ?? enabledItems()[0]?.value ?? null;
  };
  const moveFocus = (value: Value, direction: -1 | 1, event: KeyboardEvent) => {
    const enabled = enabledItems();
    if (enabled.length === 0) return;
    let index = enabled.findIndex((item) => item.value === value);
    if (index < 0) index = direction > 0 ? -1 : 0;
    let nextIndex = index + direction;
    if (options.loop !== false) nextIndex = (nextIndex + enabled.length) % enabled.length;
    else nextIndex = Math.max(0, Math.min(enabled.length - 1, nextIndex));
    event.preventDefault();
    focusedValue.value = enabled[nextIndex]!.value;
    focusChoice(event.currentTarget as HTMLElement, choiceId(id, focusedValue.peek()!));
  };
  const controller = {
    id,
    multiple,
    value: state.value,
    setValue,
    toggle,
    reset,
    root: () => ({
      id,
      "data-clank-part": "root",
      role: "group",
      "aria-orientation": options.orientation ?? "horizontal",
      "aria-disabled": () => disabled.value || undefined,
      "aria-readonly": () => readOnly.value || undefined,
      "data-orientation": options.orientation ?? "horizontal",
      "data-state": () => multiple
        ? groupDataState((state.value.value as readonly Value[]).length, items.length)
        : state.value.value === null ? "empty" : "selected",
      "data-disabled": () => disabled.value ? "" : undefined,
    }),
    item(value: Value, partOptions: AgentPartOptions = {}) {
      const item = definition(value);
      const isPressed = () => multiple
        ? (state.value.value as readonly Value[]).includes(value)
        : state.value.value === value;
      const isDisabled = () => disabled.value || readBoolean(item.disabled);
      const isReadOnly = () => readOnly.value || readBoolean(item.readOnly);
      return {
        id: choiceId(id, value),
        "data-clank-part": "item",
        type: "button",
        disabled: isDisabled,
        "aria-pressed": isPressed,
        tabIndex: () => rovingValue() === value ? 0 : -1,
        "data-state": () => isPressed() ? "on" : "off",
        "data-pressed": () => isPressed() ? "" : undefined,
        "data-unpressed": () => !isPressed() ? "" : undefined,
        "data-disabled": () => isDisabled() ? "" : undefined,
        ...agentProps(partOptions),
        onFocus: () => {
          if (!isDisabled()) focusedValue.value = value;
        },
        onClick: (event: Event) => {
          if (!event.defaultPrevented && !isDisabled() && !isReadOnly()) toggle(value, event);
        },
        onKeyDown: (event: KeyboardEvent) => {
          const horizontal = (options.orientation ?? "horizontal") === "horizontal";
          const textDirection = resolveDirection(direction, event.currentTarget as Element);
          const nextKey = horizontal ? textDirection === "rtl" ? "ArrowLeft" : "ArrowRight" : "ArrowDown";
          const previousKey = horizontal ? textDirection === "rtl" ? "ArrowRight" : "ArrowLeft" : "ArrowUp";
          if (event.key === nextKey) moveFocus(value, 1, event);
          else if (event.key === previousKey) moveFocus(value, -1, event);
          else if (event.key === "Home" || event.key === "End") {
            const enabled = enabledItems();
            const next = event.key === "Home" ? enabled[0] : enabled.at(-1);
            if (!next) return;
            event.preventDefault();
            focusedValue.value = next.value;
            focusChoice(event.currentTarget as HTMLElement, choiceId(id, next.value));
          } else if (event.key === " " || event.key === "Enter") {
            activateCustomButton(event, () => isDisabled() || isReadOnly(), () => toggle(value, event));
          }
        },
      };
    },
    manifest: () => controlManifest("toggle-group", id, [
      part("root", "div", "group", "The toggle group container."),
      part("item", "button", "button", "A pressed/unpressed group item."),
    ], {
      multiple,
      value: Array.isArray(state.value.peek()) ? [...state.value.peek() as readonly Value[]] : state.value.peek(),
      items: items.map((item) => item.value),
      orientation: options.orientation ?? "horizontal",
      direction,
      disabled: disabled.peek(),
      readOnly: readOnly.peek(),
    }, [
      action("setValue", "Set the selected toggle value or values.", parameter("value", multiple ? "string[]" : "string | null")),
      action("toggle", "Toggle one group item.", parameter("value", "string")),
      action("reset", "Restore the default toggle-group value."),
    ]),
  };
  return controller as unknown as ToggleGroupSingleController<Value> | ToggleGroupMultipleController<Value>;
}

export type RangeChangeReason = "reset" | "programmatic";

export interface MeterOptions {
  id: string;
  value?: number | (() => number);
  defaultValue?: number;
  min?: number;
  max?: number;
  locale?: Intl.LocalesArgument;
  format?: Intl.NumberFormatOptions;
  ariaValueText?: string;
  getAriaValueText?: (formattedValue: string, value: number) => string;
  /** @deprecated Use ariaValueText or getAriaValueText. */
  valueText?: string | ((value: number, percentage: number) => string);
  onValueChange?: (value: number, details: ChangeDetails<RangeChangeReason>) => void;
}

export interface MeterController {
  readonly id: string;
  readonly current: Computed<number>;
  readonly percentage: Computed<number>;
  setValue(value: number, reason?: RangeChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  label(): Record<string, unknown>;
  track(): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  value(): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Accessible scalar measurement parts, with CSS custom properties but no visual styling. */
export function createMeter(options: MeterOptions): MeterController {
  const id = requireId(options.id, "Meter");
  const labelPresence = createPartPresence(`${id}.labelPresence`);
  const range = numberRange(options.min ?? 0, options.max ?? 100, "Meter");
  const normalize = (value: number) => clampNumber(value, range.min, range.max, "Meter value");
  const initial = normalize(options.defaultValue ?? range.min);
  const state = createControllableState<number, RangeChangeReason>({
    ...(options.value !== undefined ? {
      value: () => normalize(readValue(options.value as UiReadable<number>)),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange,
    name: `${id}.value`,
  });
  const percentage = computed(() => (state.value.value - range.min) / (range.max - range.min) * 100, { name: `${id}.percentage` });
  const formatter = new Intl.NumberFormat(options.locale, options.format ?? { style: "percent" });
  const formattedValue = () => formatter.format((options.format?.style ?? "percent") === "percent"
    ? percentage.value / 100
    : state.value.value);
  const valueText = () => options.ariaValueText
    ?? options.getAriaValueText?.(formattedValue(), state.value.value)
    ?? (typeof options.valueText === "function"
      ? options.valueText(state.value.value, percentage.value)
      : options.valueText)
    ?? formattedValue();
  const setValue = (value: number, reason: RangeChangeReason = "programmatic", event?: Event) => state.set(normalize(value), reason, event);
  const reset = (event?: Event) => state.set(initial, "reset", event);
  const data = () => ({
    "data-state": () => percentage.value >= 100 ? "complete" : "progressing",
    "data-value": () => state.value.value,
    "data-percentage": () => percentage.value,
  });
  return {
    id,
    current: state.value,
    percentage,
    setValue,
    reset,
    root: () => ({
      id,
      "data-clank-part": "root",
      role: "meter",
      "aria-valuemin": range.min,
      "aria-valuemax": range.max,
      "aria-valuenow": () => state.value.value,
      "aria-valuetext": () => valueText(),
      "aria-labelledby": () => labelPresence.present.value ? `${id}-label` : undefined,
      ...data(),
    }),
    label: () => ({ id: `${id}-label`, "data-clank-part": "label", ...data(), use: labelPresence.register() }),
    track: () => ({ "aria-hidden": true, "data-clank-part": "track", ...data() }),
    indicator: () => ({
      "aria-hidden": true,
      "data-clank-part": "indicator",
      ...data(),
      style: { "--clank-meter-percentage": () => `${percentage.value}%` },
    }),
    value: () => ({ "aria-hidden": true, "data-clank-part": "value", children: () => formattedValue(), ...data() }),
    manifest: () => controlManifest("meter", id, [
      part("root", "div", "meter", "The accessible meter container."),
      part("label", "span", undefined, "The accessible meter label."),
      part("track", "div", undefined, "The meter track."),
      part("indicator", "div", undefined, "The filled meter indicator."),
      part("value", "span", undefined, "A human-readable value display."),
    ], {
      value: state.value.peek(),
      min: range.min,
      max: range.max,
      percentage: percentage.peek(),
      formattedValue: formattedValue(),
    }, [
      action("setValue", "Set the meter value.", parameter("value", "number")),
      action("reset", "Restore the default meter value."),
    ]),
  };
}

export interface ProgressOptions {
  id: string;
  value?: number | null | (() => number | null);
  defaultValue?: number | null;
  min?: number;
  max?: number;
  locale?: Intl.LocalesArgument;
  format?: Intl.NumberFormatOptions;
  ariaValueText?: string;
  getAriaValueText?: (formattedValue: string | null, value: number | null) => string;
  /** @deprecated Use ariaValueText or getAriaValueText. */
  valueText?: string | ((value: number, percentage: number) => string);
  onValueChange?: (value: number | null, details: ChangeDetails<RangeChangeReason>) => void;
}

export interface ProgressController {
  readonly id: string;
  readonly current: Computed<number | null>;
  readonly percentage: Computed<number | null>;
  setValue(value: number | null, reason?: RangeChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  label(): Record<string, unknown>;
  track(): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  value(): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** Determinate or indeterminate progress state with accessible parts and Tailwind-friendly data hooks. */
export function createProgress(options: ProgressOptions): ProgressController {
  const id = requireId(options.id, "Progress");
  const labelPresence = createPartPresence(`${id}.labelPresence`);
  const range = numberRange(options.min ?? 0, options.max ?? 100, "Progress");
  const normalize = (value: number | null) => value === null ? null : clampNumber(value, range.min, range.max, "Progress value");
  const initial = normalize(options.defaultValue ?? null);
  const state = createControllableState<number | null, RangeChangeReason>({
    ...(options.value !== undefined ? {
      value: () => normalize(readValue(options.value as UiReadable<number | null>)),
    } : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange,
    name: `${id}.value`,
  });
  const percentage = computed(() => state.value.value === null
    ? null
    : (state.value.value - range.min) / (range.max - range.min) * 100, { name: `${id}.percentage` });
  const formatter = new Intl.NumberFormat(options.locale, options.format ?? { style: "percent" });
  const formattedValue = () => {
    const current = state.value.value;
    const percent = percentage.value;
    if (current === null || percent === null) return null;
    return formatter.format((options.format?.style ?? "percent") === "percent" ? percent / 100 : current);
  };
  const valueText = () => {
    const current = state.value.value;
    const percent = percentage.value;
    const formatted = formattedValue();
    if (options.ariaValueText !== undefined) return options.ariaValueText;
    if (options.getAriaValueText) return options.getAriaValueText(formatted, current);
    if (current === null || percent === null) return "indeterminate progress";
    return (typeof options.valueText === "function" ? options.valueText(current, percent) : options.valueText) ?? formatted ?? undefined;
  };
  const setValue = (value: number | null, reason: RangeChangeReason = "programmatic", event?: Event) => state.set(normalize(value), reason, event);
  const reset = (event?: Event) => state.set(initial, "reset", event);
  const status = () => state.value.value === null ? "indeterminate" : state.value.value >= range.max ? "complete" : "progressing";
  const data = () => ({
    "data-state": status,
    "data-complete": () => status() === "complete" ? "" : undefined,
    "data-progressing": () => status() === "progressing" ? "" : undefined,
    "data-value": () => state.value.value ?? undefined,
    "data-percentage": () => percentage.value ?? undefined,
    "data-indeterminate": () => state.value.value === null ? "" : undefined,
  });
  return {
    id,
    current: state.value,
    percentage,
    setValue,
    reset,
    root: () => ({
      id,
      "data-clank-part": "root",
      role: "progressbar",
      "aria-valuemin": range.min,
      "aria-valuemax": range.max,
      "aria-valuenow": () => state.value.value ?? undefined,
      "aria-valuetext": () => valueText(),
      "aria-labelledby": () => labelPresence.present.value ? `${id}-label` : undefined,
      ...data(),
    }),
    label: () => ({ id: `${id}-label`, "data-clank-part": "label", ...data(), use: labelPresence.register() }),
    track: () => ({ "aria-hidden": true, "data-clank-part": "track", ...data() }),
    indicator: () => ({
      "aria-hidden": true,
      "data-clank-part": "indicator",
      ...data(),
      style: { "--clank-progress-percentage": () => percentage.value === null ? "0%" : `${percentage.value}%` },
    }),
    value: () => ({ "aria-hidden": true, "data-clank-part": "value", children: () => formattedValue() ?? "", ...data() }),
    manifest: () => controlManifest("progress", id, [
      part("root", "div", "progressbar", "The accessible progress container."),
      part("label", "span", undefined, "The accessible progress label."),
      part("track", "div", undefined, "The progress track."),
      part("indicator", "div", undefined, "The filled or animated progress indicator."),
      part("value", "span", undefined, "A human-readable progress display."),
    ], {
      value: state.value.peek(),
      min: range.min,
      max: range.max,
      percentage: percentage.peek(),
      formattedValue: formattedValue(),
      status: status(),
    }, [
      action("setValue", "Set a progress value, or null for indeterminate.", parameter("value", "number | null")),
      action("reset", "Restore the default progress value."),
    ]),
  };
}

export interface SeparatorOptions {
  id: string;
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

export interface SeparatorController {
  readonly id: string;
  root(): Record<string, unknown>;
  manifest(): UiControlManifest;
}

/** A semantic or decorative separator with orientation hooks and no imposed styles. */
export function createSeparator(options: SeparatorOptions): SeparatorController {
  const id = requireId(options.id, "Separator");
  const orientation = options.orientation ?? "horizontal";
  const decorative = options.decorative === true;
  return {
    id,
    root: () => ({
      id,
      "data-clank-part": "root",
      role: decorative ? "presentation" : "separator",
      ...(decorative ? { "aria-hidden": true } : orientation === "vertical" ? { "aria-orientation": "vertical" } : {}),
      "data-orientation": orientation,
    }),
    manifest: () => controlManifest("separator", id, [
      part("root", "div", decorative ? "presentation" : "separator", "The visual or semantic separator."),
    ], { orientation, decorative }, []),
  };
}

export interface AgentPartOptions {
  agentId?: string;
  agentLabel?: string;
  agentDescription?: string;
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

function fieldFlag(field: FieldController<any> | undefined, key: "disabled" | "readOnly" | "required"): boolean {
  return field?.[key].value ?? false;
}

function fieldStateProps(field: FieldController<any> | undefined): Record<string, unknown> {
  if (!field) return {};
  return {
    "data-valid": () => field.valid.value === true ? "" : undefined,
    "data-invalid": () => field.valid.value === false ? "" : undefined,
    "data-dirty": () => field.dirty.value ? "" : undefined,
    "data-touched": () => field.touched.value ? "" : undefined,
    "data-filled": () => field.filled.value ? "" : undefined,
    "data-focused": () => field.focused.value ? "" : undefined,
    "data-pending": () => field.pending.value ? "" : undefined,
  };
}

function fieldRelationshipProps(part: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!part) return {};
  return {
    "aria-labelledby": part["aria-labelledby"],
    "aria-describedby": part["aria-describedby"],
    "aria-invalid": part["aria-invalid"],
    "aria-errormessage": part["aria-errormessage"],
  };
}

function fieldFocusProps(field: FieldController<any> | undefined): Record<string, unknown> {
  if (!field) return {};
  return {
    onFocus: () => { field.setFocused(true); },
    onBlur: (event: Event) => {
      field.setFocused(false);
      field.touch();
      if (field.validationMode === "onBlur" || field.validationMode === "onChange") {
        void field.validate("blur", event);
      }
    },
  };
}

function resetField(field: FieldController<any> | undefined): void {
  field?.setFocused(false);
  field?.touch(false);
}

function nativeChoiceRootProps(nativeButton: boolean, disabled: () => boolean): Record<string, unknown> {
  return nativeButton
    ? { type: "button", disabled }
    : {
        tabIndex: () => disabled() ? -1 : 0,
        "aria-disabled": () => disabled() || undefined,
      };
}

function nativeProjectionStyle(): Record<string, string | number> {
  return {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
    pointerEvents: "none",
  };
}

function composeDirectives(
  ...directives: Array<unknown>
): (element: Element) => Cleanup {
  return (element) => {
    const cleanups: Cleanup[] = [];
    try {
      for (const directive of directives) {
        if (typeof directive !== "function") continue;
        const cleanup = (directive as (element: Element) => void | Cleanup)(element);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup();
      throw error;
    }
    return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
  };
}

function booleanState(input: UiReadable<boolean> | undefined, name: string): Computed<boolean> {
  return computed(() => readBoolean(input), { name });
}

function readBoolean(input: UiReadable<boolean> | undefined): boolean {
  return typeof input === "function" ? Boolean(input()) : Boolean(input);
}

function readValue<T>(input: UiReadable<T>): T {
  return typeof input === "function" ? (input as () => T)() : input;
}

function requireId(value: string, kind: string): string {
  const id = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new TypeError(`${kind} id must start with a letter and contain only letters, numbers, _, ., :, or -.`);
  }
  return id;
}

function checkboxState(value: CheckboxState): CheckboxState {
  if (value !== true && value !== false && value !== "indeterminate") {
    throw new TypeError("Checkbox state must be true, false, or indeterminate.");
  }
  return value;
}

function avatarStatus(value: AvatarStatus): AvatarStatus {
  if (!["idle", "loading", "loaded", "error"].includes(value)) throw new TypeError(`Invalid avatar status: ${value}`);
  return value;
}

function checkboxDataState(value: CheckboxState): "checked" | "unchecked" | "indeterminate" {
  return value === "indeterminate" ? "indeterminate" : value ? "checked" : "unchecked";
}

function groupDataState(selected: number, count: number): "empty" | "partial" | "complete" {
  return selected === 0 ? "empty" : selected === count ? "complete" : "partial";
}

function normalizeItems<Value extends string>(
  input: readonly ChoiceItem<Value>[],
  kind: string,
): readonly ChoiceItemDefinition<Value>[] {
  if (input.length === 0) throw new TypeError(`${kind} requires at least one item.`);
  const items = input.map((entry) => typeof entry === "string" ? { value: entry } : { ...entry });
  const values = new Set<string>();
  const tokens = new Set<string>();
  for (const item of items) {
    if (typeof item.value !== "string" || item.value.length === 0) throw new TypeError(`${kind} item values must be non-empty strings.`);
    if (values.has(item.value)) throw new TypeError(`${kind} item values must be unique.`);
    values.add(item.value);
    const token = safeToken(item.value);
    if (tokens.has(token)) throw new TypeError(`${kind} item values must produce unique DOM-safe IDs.`);
    tokens.add(token);
  }
  return items;
}

function requireItem<Value extends string>(
  items: readonly ChoiceItemDefinition<Value>[],
  value: Value,
  kind: string,
): ChoiceItemDefinition<Value> {
  const item = items.find((entry) => entry.value === value);
  if (!item) throw new TypeError(`${kind} contains no item with value ${JSON.stringify(value)}.`);
  return item;
}

function normalizeSelection<Value extends string>(
  values: readonly Value[],
  items: readonly ChoiceItemDefinition<Value>[],
  label: string,
): readonly Value[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const unique = new Set<Value>();
  for (const value of values) {
    requireItem(items, value, label);
    if (unique.has(value)) throw new TypeError(`${label} must not contain duplicate values.`);
    unique.add(value);
  }
  return orderedSelection([...unique], items);
}

function orderedSelection<Value extends string>(
  values: readonly Value[],
  items: readonly ChoiceItemDefinition<Value>[],
): readonly Value[] {
  const selected = new Set(values);
  return items.filter((item) => selected.has(item.value)).map((item) => item.value);
}

function shallowEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function safeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]+/g, "-");
  if (!token || !/[A-Za-z0-9]/.test(token)) throw new TypeError("Control values must contain a letter or number.");
  return token;
}

function choiceId(id: string, value: string): string {
  return `${id}-item-${safeToken(value)}`;
}

function activateCustomButton(
  event: KeyboardEvent,
  blocked: (() => boolean),
  activate: () => unknown,
): void {
  if (event.key !== " " && event.key !== "Enter") return;
  if (isNativeButton(event.currentTarget)) return;
  if (event.defaultPrevented) return;
  if (!blocked()) activate();
  event.preventDefault();
}

function activateSpaceOnly(
  event: KeyboardEvent,
  blocked: (() => boolean),
  activate: () => unknown,
): void {
  if (event.key === "Enter") {
    event.preventDefault();
    return;
  }
  if (event.key !== " ") return;
  activateCustomButton(event, blocked, activate);
}

function isNativeButton(target: EventTarget | null): boolean {
  const element = target as { localName?: string; tagName?: string; type?: string } | null;
  const name = element?.localName?.toLowerCase() ?? element?.tagName?.toLowerCase();
  if (name === "button") return true;
  if (name !== "input") return false;
  return ["button", "submit", "reset", "checkbox", "radio"].includes(element?.type?.toLowerCase() ?? "");
}

function focusChoice(source: HTMLElement, id: string): void {
  source?.ownerDocument?.getElementById(id)?.focus();
}

interface NativeBooleanInputOptions {
  value: () => boolean;
  indeterminate?: () => boolean;
  disabled: () => boolean;
  readOnly: () => boolean;
  /** Visual control that receives focus when the hidden input is focused by native validation. */
  focusId?: string;
  update(input: HTMLInputElement, event: Event): void;
  reset(event?: Event): boolean;
}

function nativeBooleanInputDirective(options: NativeBooleanInputOptions): (element: Element) => Cleanup {
  return (element) => {
    const input = element as HTMLInputElement;
    const synchronize = () => {
      input.checked = options.value();
      if (options.indeterminate) input.indeterminate = options.indeterminate();
      input.disabled = options.disabled();
    };
    const stop = effect(synchronize);
    const onChange = (event: Event) => {
      if (options.disabled() || options.readOnly()) {
        event.preventDefault();
        synchronize();
        return;
      }
      options.update(input, event);
      synchronize();
    };
    const onClick = (event: Event) => {
      if (!options.disabled() && !options.readOnly()) return;
      event.preventDefault();
      synchronize();
    };
    const onReset = (event: Event) => {
      options.reset(event);
      queueMicrotask(synchronize);
    };
    const onFocus = () => {
      if (options.focusId) input.ownerDocument?.getElementById(options.focusId)?.focus();
    };
    input.addEventListener("change", onChange);
    input.addEventListener("click", onClick);
    input.addEventListener("focus", onFocus);
    const form = input.form;
    form?.addEventListener("reset", onReset);
    return () => {
      stop();
      input.removeEventListener("change", onChange);
      input.removeEventListener("click", onClick);
      input.removeEventListener("focus", onFocus);
      form?.removeEventListener("reset", onReset);
    };
  };
}

function numberRange(min: number, max: number, kind: string): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new TypeError(`${kind} max must be a finite number greater than min.`);
  }
  return { min, max };
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number.`);
  return value;
}

function clampNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  return Math.min(max, Math.max(min, value));
}

function agentProps(options: AgentPartOptions): Record<string, unknown> {
  return {
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.agentLabel ? { agentLabel: options.agentLabel } : {}),
    ...(options.agentDescription ? { agentDescription: options.agentDescription } : {}),
  };
}

function controlManifest(
  kind: string,
  id: string,
  parts: readonly UiControlPart[],
  state: Record<string, unknown>,
  actions: readonly UiControlAction[],
): UiControlManifest {
  const component = kind.split("-").map((token) => token[0]!.toUpperCase() + token.slice(1)).join("");
  const validated = createUiManifest({
    component,
    id,
    state,
    parts: parts.map(({ name, role, defaultElement }) => ({
      name,
      defaultElement,
      ...(role === undefined ? {} : { role }),
    })),
    actions: actions.map(({ name, description, sideEffects }) => ({ name, description, sideEffects })),
  });
  const frozenParts = Object.freeze(parts.map((entry) => Object.freeze({ ...entry })));
  const frozenActions = Object.freeze(actions.map((entry) => Object.freeze({
    ...entry,
    ...(entry.parameters ? {
      parameters: Object.freeze(entry.parameters.map((parameter) => Object.freeze({ ...parameter }))),
    } : {}),
  })));
  return Object.freeze({
    protocol: validated.protocol,
    kind,
    component: validated.component,
    id: validated.id,
    parts: frozenParts,
    state: validated.state,
    actions: frozenActions,
  });
}

function part(name: string, element: string, role: string | undefined, description: string): UiControlPart {
  return { name, element, defaultElement: element, ...(role ? { role } : {}), description };
}

function action(name: string, description: string, ...parameters: UiControlParameter[]): UiControlAction {
  // Control actions either mutate controller state or invoke an application
  // callback. Mark them conservatively as writes so agents never treat an
  // activation as a safe speculative read.
  return { name, description, sideEffects: "write", ...(parameters.length > 0 ? { parameters } : {}) };
}

function parameter(name: string, type: string, required = true): { name: string; type: string; required: boolean } {
  return { name, type, required };
}

function checkboxParts(): readonly UiControlPart[] {
  return [
    part("root", "span", "checkbox", "The wrapping-label-friendly interactive checkbox."),
    part("indicator", "span", undefined, "The checked or indeterminate indicator."),
    part("input", "input", undefined, "The native form participant."),
    part("unchecked-input", "input", undefined, "The optional hidden unchecked form participant."),
  ];
}
