import {
  batch,
  computed,
  effect,
  signal,
  type Cleanup,
  type Computed,
  type ReactiveSignal,
} from "./core.ts";
import { useDirection } from "./ui-composition.ts";
import {
  createChangeDetails,
  createControllableState,
  createUiManifest,
  isEventCanceled,
  resolveDirection,
  type ChangeDetails,
  type Direction,
  type UiManifest,
} from "./ui-foundation.ts";

/** A static option or an SSR-safe reactive getter. */
export type FieldReadable<Value> = Value | (() => Value);

export type ValidationMode = "onSubmit" | "onBlur" | "onChange";
export type FieldChangeReason = "input" | "change" | "reset" | "programmatic";
export type FieldValidationReason = "input" | "blur" | "submit" | "manual";
export type NativeValidityKey =
  | "badInput"
  | "customError"
  | "patternMismatch"
  | "rangeOverflow"
  | "rangeUnderflow"
  | "stepMismatch"
  | "tooLong"
  | "tooShort"
  | "typeMismatch"
  | "valueMissing";

const VALIDITY_KEYS: readonly NativeValidityKey[] = [
  "badInput",
  "customError",
  "patternMismatch",
  "rangeOverflow",
  "rangeUnderflow",
  "stepMismatch",
  "tooLong",
  "tooShort",
  "typeMismatch",
  "valueMissing",
];

export interface FieldValidationContext<Value> {
  readonly reason: FieldValidationReason;
  readonly signal: AbortSignal;
  readonly field: FieldController<Value>;
  readonly element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  readonly validity: Readonly<Record<NativeValidityKey, boolean>>;
}

export type FieldValidationResult =
  | void
  | null
  | boolean
  | string
  | readonly string[]
  | { errors?: string | readonly string[]; validity?: NativeValidityKey };

export interface FieldOptions<Value = string> {
  id: string;
  name?: string;
  value?: FieldReadable<Value>;
  defaultValue?: Value;
  disabled?: FieldReadable<boolean>;
  readOnly?: FieldReadable<boolean>;
  required?: FieldReadable<boolean>;
  invalid?: FieldReadable<boolean>;
  dirty?: FieldReadable<boolean>;
  touched?: FieldReadable<boolean>;
  /** Redacts the value from agent-readable manifests while preserving submission. */
  sensitive?: FieldReadable<boolean>;
  validationMode?: ValidationMode;
  validationDebounce?: number;
  validate?: (
    value: Value,
    context: FieldValidationContext<Value>,
  ) => FieldValidationResult | Promise<FieldValidationResult>;
  isFilled?: (value: Value) => boolean;
  parse?: (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => Value;
  format?: (value: Value) => string | number | readonly string[];
  onValueChange?: (value: Value, details: ChangeDetails<FieldChangeReason>) => void;
  onValidityChange?: (valid: boolean | null, errors: readonly string[]) => void;
}

export interface FieldErrorPartOptions {
  id?: string;
  match?: NativeValidityKey | "custom" | boolean | readonly (NativeValidityKey | "custom")[];
  live?: "off" | "polite" | "assertive";
}

export interface FieldControlPartOptions<Value> {
  id?: string;
  type?: string;
  describedBy?: string;
  parse?: (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => Value;
  format?: (value: Value) => string | number | readonly string[];
}

export interface FieldItemPartOptions {
  /** Disables controls inside this item. Field-level disabled state takes precedence. */
  disabled?: FieldReadable<boolean>;
}

export interface FieldController<Value = string> {
  readonly id: string;
  readonly name: string | undefined;
  readonly controlId: string;
  readonly descriptionId: string;
  readonly errorId: string;
  readonly value: Computed<Value>;
  readonly errors: Computed<readonly string[]>;
  readonly nativeValidity: ReactiveSignal<Readonly<Record<NativeValidityKey, boolean>>>;
  readonly valid: Computed<boolean | null>;
  readonly dirty: Computed<boolean>;
  readonly touched: Computed<boolean>;
  readonly filled: Computed<boolean>;
  readonly focused: Computed<boolean>;
  readonly pending: ReactiveSignal<boolean>;
  readonly sensitive: Computed<boolean>;
  readonly disabled: Computed<boolean>;
  readonly readOnly: Computed<boolean>;
  readonly required: Computed<boolean>;
  readonly validationMode: ValidationMode;
  setValue(value: Value, reason?: FieldChangeReason, event?: Event): boolean;
  setServerErrors(errors: string | readonly string[] | null | undefined): void;
  clearServerErrors(): void;
  touch(value?: boolean): void;
  /** Synchronizes the composed control's focus state. */
  setFocused(value?: boolean): void;
  /** Marks values as sensitive so aggregate manifests cannot expose them. */
  setSensitive(value?: boolean): void;
  validate(reason?: FieldValidationReason, event?: Event): Promise<boolean>;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  label(): Record<string, unknown>;
  control(options?: FieldControlPartOptions<Value>): Record<string, unknown>;
  description(options?: { id?: string }): Record<string, unknown>;
  item(options?: FieldItemPartOptions): Record<string, unknown>;
  error(options?: FieldErrorPartOptions): Record<string, unknown>;
  validity(options?: { live?: "off" | "polite" | "assertive" }): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/**
 * Creates Base-UI-style field labeling and validation without rendering markup.
 * Validation is native-first, supports sync/async validators, and rejects stale
 * async completions whenever the value changes or a newer validation begins.
 */
export function createField<Value = string>(options: FieldOptions<Value>): FieldController<Value> {
  const id = requireId(options.id, "Field");
  const controlId = `${id}-control`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const initial = cloneValue((Object.prototype.hasOwnProperty.call(options, "defaultValue")
    ? options.defaultValue
    : Object.prototype.hasOwnProperty.call(options, "value")
      ? read(options.value as FieldReadable<Value>)
      : "") as Value);
  const state = createControllableState<Value, FieldChangeReason>({
    ...(Object.prototype.hasOwnProperty.call(options, "value")
      ? { value: () => read(options.value as FieldReadable<Value>) }
      : {}),
    defaultValue: initial,
    onValueChange: options.onValueChange,
    name: `${id}.value`,
  });
  const localTouched = signal(false, { name: `${id}.touched` });
  const localFocused = signal(false, { name: `${id}.focused` });
  const pending = signal(false, { name: `${id}.pending` });
  const locallySensitive = signal(false, { name: `${id}.sensitive` });
  const validated = signal(false, { name: `${id}.validated` });
  const validationErrors = signal<readonly string[]>([], { name: `${id}.validationErrors` });
  const serverErrors = signal<readonly string[]>([], { name: `${id}.serverErrors` });
  const nativeValidity = signal<Readonly<Record<NativeValidityKey, boolean>>>(emptyValidity(), {
    name: `${id}.nativeValidity`,
    equals: validityEqual,
  });
  const disabled = () => readBoolean(options.disabled);
  const readOnly = () => readBoolean(options.readOnly);
  const required = () => readBoolean(options.required);
  const disabledState = computed(disabled, { name: `${id}.disabled` });
  const readOnlyState = computed(readOnly, { name: `${id}.readOnly` });
  const requiredState = computed(required, { name: `${id}.required` });
  const touched = computed(
    () => options.touched === undefined ? localTouched.value : readBoolean(options.touched),
    { name: `${id}.isTouched` },
  );
  const dirty = computed(
    () => options.dirty === undefined ? !sameValue(state.value.value, initial) : readBoolean(options.dirty),
    { name: `${id}.dirty` },
  );
  const filled = computed(
    () => options.isFilled ? options.isFilled(state.value.value) : valueIsFilled(state.value.value),
    { name: `${id}.filled` },
  );
  const focused = computed(() => localFocused.value, { name: `${id}.isFocused` });
  const sensitive = computed(
    () => readBoolean(options.sensitive) || locallySensitive.value,
    { name: `${id}.isSensitive` },
  );
  const errors = computed(
    () => uniqueStrings([...serverErrors.value, ...validationErrors.value]),
    { name: `${id}.errors` },
  );
  const valid = computed<boolean | null>(() => {
    if (readBoolean(options.invalid)) return false;
    if (errors.value.length > 0 || hasNativeError(nativeValidity.value)) return false;
    return validated.value ? true : null;
  }, { name: `${id}.valid` });

  let controlElement: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
  let validationRevision = 0;
  let validationController: AbortController | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let lastResetEvent: Event | undefined;
  const registeredLabelIds = new Map<string, number>();
  const registeredDescriptionIds = new Map<string, number>();
  const registeredErrorIds = new Map<string, number>();
  const mode = requireValidationMode(options.validationMode ?? "onSubmit");
  const debounce = nonNegative(options.validationDebounce ?? 0, "Field validationDebounce");

  const invalidateValidation = () => {
    validationRevision++;
    validationController?.abort(abortError("Field value changed."));
    validationController = undefined;
    pending.value = false;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  let controller!: FieldController<Value>;
  const runValidation = async (reason: FieldValidationReason, event?: Event): Promise<boolean> => {
    if (disposed) return false;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    validationController?.abort(abortError("A newer validation replaced this one."));
    const abort = new AbortController();
    validationController = abort;
    const revision = ++validationRevision;
    const snapshot = nativeValiditySnapshot(controlElement, required(), state.value.peek());
    nativeValidity.value = snapshot;
    let result: FieldValidationResult;
    try {
      const returned = options.validate?.(state.value.peek(), {
        reason,
        signal: abort.signal,
        field: controller,
        element: controlElement,
        validity: snapshot,
      });
      if (isPromiseLike(returned)) {
        pending.value = true;
        result = await returned;
      } else {
        result = returned;
      }
    } catch (error) {
      if (abort.signal.aborted || revision !== validationRevision) return false;
      result = error instanceof Error && error.message ? error.message : "Validation failed.";
    }
    if (abort.signal.aborted || revision !== validationRevision || disposed) return false;
    const normalized = normalizeValidationResult(result, snapshot, controlElement?.validationMessage);
    batch(() => {
      pending.value = false;
      validated.value = true;
      validationErrors.value = normalized.errors;
      if (normalized.validity) {
        nativeValidity.value = Object.freeze({ ...snapshot, [normalized.validity]: true });
      }
    });
    options.onValidityChange?.(controller.valid.peek(), controller.errors.peek());
    return controller.valid.peek() === true;
  };

  const scheduleValidation = (reason: FieldValidationReason, event?: Event) => {
    if (debounce === 0) {
      void runValidation(reason, event);
      return;
    }
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runValidation(reason, event);
    }, debounce);
  };

  const setValue = (next: Value, reason: FieldChangeReason = "programmatic", event?: Event): boolean => {
    if ((disabled() || readOnly()) && reason !== "reset" && reason !== "programmatic") return false;
    const changed = state.set(next, reason, event);
    if (!changed) return false;
    invalidateValidation();
    serverErrors.value = [];
    validationErrors.value = [];
    nativeValidity.value = emptyValidity();
    validated.value = false;
    if (mode === "onChange" && reason !== "reset") scheduleValidation("input", event);
    return true;
  };

  const stateProps = () => fieldStateProps({
    disabled,
    readOnly,
    required,
    valid: () => valid.value,
    dirty: () => dirty.value,
    touched: () => touched.value,
    filled: () => filled.value,
    focused: () => focused.value,
    pending: () => pending.value,
  });

  controller = {
    id,
    name: options.name,
    controlId,
    descriptionId,
    errorId,
    value: state.value,
    errors,
    nativeValidity,
    valid,
    dirty,
    touched,
    filled,
    focused,
    pending,
    sensitive,
    disabled: disabledState,
    readOnly: readOnlyState,
    required: requiredState,
    validationMode: mode,
    setValue,
    setServerErrors(next) {
      serverErrors.value = errorList(next);
      if (serverErrors.peek().length > 0) validated.value = true;
    },
    clearServerErrors() {
      serverErrors.value = [];
    },
    touch(next = true) {
      localTouched.value = Boolean(next);
    },
    setFocused(next = true) {
      localFocused.value = Boolean(next);
    },
    setSensitive(next = true) {
      locallySensitive.value = Boolean(next);
    },
    validate: runValidation,
    reset(event) {
      if (isDuplicateResetEvent(event, lastResetEvent)) return false;
      if (event) {
        lastResetEvent = event;
        queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
      }
      if (event && isEventCanceled(event)) return false;
      const alreadyInitial = sameValue(state.value.peek(), initial);
      const changed = state.reset("reset", event);
      if (!changed && !alreadyInitial) return false;
      invalidateValidation();
      batch(() => {
        localTouched.value = false;
        localFocused.value = false;
        validated.value = false;
        validationErrors.value = [];
        serverErrors.value = [];
        nativeValidity.value = emptyValidity();
      });
      return changed;
    },
    root: () => ({ id, "data-clank-part": "root", ...(options.name ? { "data-name": options.name } : {}), ...stateProps() }),
    label: () => {
      const partId = `${id}-label`;
      return {
        id: partId,
        htmlFor: controlId,
        "data-clank-part": "label",
        ...stateProps(),
        onClick: (event: Event) => {
          if (event.defaultPrevented) return;
          const document = (event.currentTarget as Element | null)?.ownerDocument;
          (document?.getElementById(controlId) as HTMLElement | null)?.focus?.();
        },
        use: relationshipPartUse(registeredLabelIds, partId),
      };
    },
    control(partOptions = {}) {
      const parse = partOptions.parse ?? options.parse;
      const format = partOptions.format ?? options.format;
      const partId = partOptions.id ?? controlId;
      const describedBy = () => [
        partOptions.describedBy,
        ...registeredDescriptionIds.keys(),
        ...(valid.value === false ? registeredErrorIds.keys() : []),
      ].filter(Boolean).join(" ") || undefined;
      const synchronizeNative = (native: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
        const logical = state.value.value;
        const shown = format ? format(logical) : displayValue(logical);
        if (
          !format
          && "checked" in native
          && (native.type === "checkbox" || native.type === "radio")
          && typeof logical === "boolean"
        ) {
          native.checked = logical;
        } else if (Array.isArray(shown) && "options" in native) {
          const selected = new Set(shown.map(String));
          for (const option of Array.from((native as HTMLSelectElement).options)) option.selected = selected.has(option.value);
        } else if (!Array.isArray(shown) && native.value !== String(shown)) {
          native.value = String(shown);
        }
        native.disabled = disabled();
        if ("readOnly" in native) native.readOnly = readOnly();
        native.required = required();
        native.setCustomValidity?.(validationErrors.value[0] ?? serverErrors.value[0] ?? "");
      };
      const use = (element: Element): Cleanup => {
        const native = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        controlElement = native;
        const synchronize = () => synchronizeNative(native);
        const stop = effect(synchronize);
        const form = native.form;
        const onReset = (resetEvent: Event) => {
          controller.reset(resetEvent);
          queueMicrotask(synchronize);
        };
        form?.addEventListener("reset", onReset);
        return () => {
          stop();
          form?.removeEventListener("reset", onReset);
          if (controlElement === native) controlElement = null;
        };
      };
      const update = (event: Event, reason: FieldChangeReason) => {
        if (event.defaultPrevented) return;
        const element = event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        let next: Value;
        if (parse) next = parse(element);
        else if ("type" in element && ((element as HTMLInputElement).type === "checkbox" || (element as HTMLInputElement).type === "radio")) {
          next = (element as HTMLInputElement).checked as Value;
        } else if ("multiple" in element && (element as HTMLSelectElement).multiple) {
          next = Array.from((element as HTMLSelectElement).selectedOptions).map((entry) => entry.value) as Value;
        } else next = element.value as Value;
        if (!setValue(next, reason, event)) synchronizeNative(element);
      };
      return {
        id: partId,
        "data-clank-part": "control",
        ...(options.name ? { name: options.name } : {}),
        ...(partOptions.type ? { type: partOptions.type } : {}),
        value: () => {
          const shown = format ? format(state.value.value) : displayValue(state.value.value);
          return shown;
        },
        disabled,
        readOnly,
        required,
        "aria-labelledby": () => [...registeredLabelIds.keys()].join(" ") || undefined,
        "aria-describedby": describedBy,
        "aria-invalid": () => valid.value === false || undefined,
        "aria-errormessage": () => valid.value === false
          ? [...registeredErrorIds.keys()].join(" ") || undefined
          : undefined,
        ...stateProps(),
        onInput: (event: Event) => update(event, "input"),
        onChange: (event: Event) => update(event, "change"),
        onFocus: () => { controller.setFocused(true); },
        onBlur: (event: Event) => {
          controller.setFocused(false);
          controller.touch();
          if (shouldValidateOnBlur(controller)) scheduleValidation("blur", event);
        },
        onInvalid: (event: Event) => {
          nativeValidity.value = nativeValiditySnapshot(event.currentTarget as HTMLInputElement, required(), state.value.peek());
          validated.value = true;
          options.onValidityChange?.(controller.valid.peek(), controller.errors.peek());
        },
        use,
      };
    },
    description: (partOptions = {}) => {
      const partId = partOptions.id ?? descriptionId;
      const use = relationshipPartUse(registeredDescriptionIds, partId);
      return { id: partId, "data-clank-part": "description", ...stateProps(), use };
    },
    item(partOptions = {}) {
      const itemDisabled = () => disabled() || readBoolean(partOptions.disabled);
      const itemStateProps = () => fieldStateProps({
        disabled: itemDisabled,
        readOnly,
        required,
        valid: () => valid.value,
        dirty: () => dirty.value,
        touched: () => touched.value,
        filled: () => filled.value,
        focused: () => focused.value,
        pending: () => pending.value,
      });
      const preventInteraction = (event: Event) => {
        if (!itemDisabled() || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
      };
      return {
        role: "group",
        "data-clank-part": "item",
        "aria-disabled": () => itemDisabled() || undefined,
        ...itemStateProps(),
        onClickCapture: preventInteraction,
        onPointerDownCapture: preventInteraction,
        onKeyDownCapture: preventInteraction,
        use: disabledFieldItemUse(itemDisabled),
      };
    },
    error(partOptions = {}) {
      const partId = partOptions.id ?? errorId;
      const use = relationshipPartUse(registeredErrorIds, partId);
      return {
        id: partId,
        "data-clank-part": "error",
        role: partOptions.live === "assertive" ? "alert" : "status",
        "aria-live": partOptions.live ?? "polite",
        hidden: () => !(
          (partOptions.match === undefined || partOptions.match === true) && valid.value === false
        ) && !errorMatches(partOptions.match, nativeValidity.value, validationErrors.value, serverErrors.value),
        "data-match": Array.isArray(partOptions.match) ? partOptions.match.join(" ") : partOptions.match,
        ...stateProps(),
        use,
      };
    },
    validity: (partOptions = {}) => ({
      role: "status",
      "data-clank-part": "validity",
      "aria-live": partOptions.live ?? "polite",
      "data-validity": () => valid.value === null ? "unvalidated" : valid.value ? "valid" : "invalid",
      hidden: () => valid.value === null,
      ...stateProps(),
    }),
    manifest: () => createUiManifest({
      component: "Field",
      id,
      state: {
        name: options.name ?? null,
        value: sensitive.peek()
          ? (filled.peek() ? "[redacted]" : "")
          : serializableValue(state.value.peek()),
        sensitive: sensitive.peek(),
        valid: valid.peek(),
        errors: [...errors.peek()],
        dirty: dirty.peek(),
        touched: touched.peek(),
        filled: filled.peek(),
        focused: focused.peek(),
        pending: pending.peek(),
        disabled: disabled(),
        readOnly: readOnly(),
        required: required(),
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "label", defaultElement: "label" },
        { name: "control", defaultElement: "input", required: true },
        { name: "description", defaultElement: "p" },
        { name: "item", role: "group", defaultElement: "div" },
        { name: "error", role: "status", defaultElement: "div" },
        { name: "validity", role: "status", defaultElement: "div" },
      ],
      actions: [
        { name: "setValue", description: "Change the field value.", sideEffects: "write", reasons: ["input", "change", "programmatic"] },
        { name: "validate", description: "Run native and application validation.", sideEffects: "read", reasons: ["input", "blur", "submit", "manual"] },
        { name: "reset", description: "Restore the initial field value and interaction state.", sideEffects: "write", reasons: ["reset"] },
      ],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidateValidation();
      registeredLabelIds.clear();
      registeredDescriptionIds.clear();
      registeredErrorIds.clear();
    },
  };
  return controller;
}

export interface FieldsetOptions {
  id: string;
  disabled?: FieldReadable<boolean>;
  form?: string;
  name?: string;
}

export interface FieldsetController {
  readonly id: string;
  root(): Record<string, unknown>;
  legend(): Record<string, unknown>;
  manifest(): UiManifest;
}

/** Native fieldset semantics preserve browser disabled propagation automatically. */
export function createFieldset(options: FieldsetOptions): FieldsetController {
  const id = requireId(options.id, "Fieldset");
  const disabled = () => readBoolean(options.disabled);
  return {
    id,
    root: () => ({
      id,
      "data-clank-part": "root",
      ...(options.form ? { form: options.form } : {}),
      ...(options.name ? { name: options.name } : {}),
      disabled,
      "aria-disabled": () => disabled() || undefined,
      "data-disabled": () => disabled() ? "" : undefined,
    }),
    legend: () => ({
      id: `${id}-legend`,
      "data-clank-part": "legend",
      "data-disabled": () => disabled() ? "" : undefined,
    }),
    manifest: () => createUiManifest({
      component: "Fieldset",
      id,
      state: { disabled: disabled(), form: options.form ?? null, name: options.name ?? null },
      parts: [
        { name: "root", role: "group", defaultElement: "fieldset", required: true },
        { name: "legend", defaultElement: "legend", required: true },
      ],
      actions: [],
    }),
  };
}

export interface FormFacadeSubmitDetails {
  readonly event?: Event;
  readonly formData: FormData | null;
  readonly canceled: boolean;
  cancel(): void;
}

export interface FormFacadeOptions<Result = unknown> {
  id: string;
  validationMode?: ValidationMode;
  focusFirstInvalid?: boolean;
  onFormSubmit?: (
    values: Readonly<Record<string, unknown>>,
    details: FormFacadeSubmitDetails,
  ) => Result | Promise<Result>;
}

export interface FormFacadeController<Result = unknown> {
  readonly id: string;
  readonly pending: ReactiveSignal<boolean>;
  readonly submitted: ReactiveSignal<boolean>;
  readonly valid: Computed<boolean>;
  register<Value>(name: string, field: FieldController<Value>): Cleanup;
  field(name: string): FieldController<any> | undefined;
  setErrors(errors: Readonly<Record<string, string | readonly string[] | null | undefined>>): void;
  values(): Readonly<Record<string, unknown>>;
  formData(): FormData | null;
  validate(name?: string): Promise<boolean>;
  focusFirstInvalid(root?: ParentNode): boolean;
  submit(event?: Event): Promise<Result | undefined>;
  reset(event?: Event): void;
  root(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}

/**
 * Coordinates independent Field controllers as a native form. Registered server
 * errors clear when their value changes, and submission focuses the first invalid
 * control before invoking the application callback.
 */
export function createFormFacade<Result = unknown>(options: FormFacadeOptions<Result>): FormFacadeController<Result> {
  const id = requireId(options.id, "Form");
  const validationMode = requireValidationMode(options.validationMode ?? "onSubmit");
  const fields = new Map<string, { field: FieldController<any>; stop: Cleanup }>();
  const pending = signal(false, { name: `${id}.pending` });
  const submitted = signal(false, { name: `${id}.submitted` });
  const valid = computed(() => [...fields.values()].every(({ field }) => field.valid.value !== false), {
    name: `${id}.valid`,
  });
  let formElement: HTMLFormElement | null = null;
  let submission = 0;
  let disposed = false;
  let lastResetEvent: Event | undefined;
  let controller!: FormFacadeController<Result>;

  controller = {
    id,
    pending,
    submitted,
    valid,
    register(name, field) {
      requireFieldName(name);
      if (fields.has(name)) throw new TypeError(`Form field ${JSON.stringify(name)} is already registered.`);
      let initialized = false;
      let previous = field.value.peek();
      const stop = effect(() => {
        const next = field.value.value;
        if (initialized && !sameValue(next, previous)) field.clearServerErrors();
        previous = cloneValue(next);
        initialized = true;
      });
      fields.set(name, { field, stop });
      return () => {
        const registered = fields.get(name);
        if (registered?.field !== field) return;
        registered.stop();
        fields.delete(name);
      };
    },
    field: (name) => fields.get(name)?.field,
    setErrors(errors) {
      for (const name of Object.keys(errors)) {
        if (!fields.has(name)) throw new TypeError(`Unknown form error field: ${name}`);
      }
      for (const [name, entry] of fields) entry.field.setServerErrors(errors[name]);
    },
    values() {
      const output: Record<string, unknown> = {};
      for (const [name, entry] of fields) output[name] = cloneValue(entry.field.value.peek());
      return Object.freeze(output);
    },
    formData() {
      if (!formElement || typeof FormData === "undefined") return null;
      try {
        return new FormData(formElement);
      } catch {
        return null;
      }
    },
    async validate(name) {
      if (name !== undefined) {
        const entry = fields.get(name);
        if (!entry) throw new TypeError(`Unknown form field: ${name}`);
        return entry.field.validate("manual");
      }
      const results = await Promise.all([...fields.values()].map(({ field }) => field.validate("submit")));
      return results.every(Boolean);
    },
    focusFirstInvalid(root = formElement ?? (typeof document === "undefined" ? undefined : document)) {
      if (!root) return false;
      for (const { field } of fields.values()) {
        if (field.valid.peek() !== false) continue;
        const target = root.querySelector<HTMLElement>(`#${cssEscape(field.controlId)}`)
          ?? root.querySelector<HTMLElement>(`[name="${attributeEscape(field.name ?? "")}"]`);
        if (target && typeof target.focus === "function") {
          target.focus();
          return true;
        }
      }
      return false;
    },
    async submit(event) {
      event?.preventDefault();
      if (disposed) return undefined;
      const revision = ++submission;
      batch(() => {
        submitted.value = true;
        pending.value = true;
      });
      try {
        const accepted = await controller.validate();
        if (revision !== submission || disposed) return undefined;
        if (!accepted) {
          if (options.focusFirstInvalid !== false) queueMicrotask(() => controller.focusFirstInvalid());
          return undefined;
        }
        const detail = createFormSubmitDetails(event, controller.formData());
        const result = options.onFormSubmit
          ? await options.onFormSubmit(controller.values(), detail)
          : undefined;
        return detail.canceled ? undefined : result;
      } finally {
        if (revision === submission) pending.value = false;
      }
    },
    reset(event) {
      if (isDuplicateResetEvent(event, lastResetEvent) || (event && isEventCanceled(event))) return;
      if (event) {
        lastResetEvent = event;
        queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
      }
      submission++;
      batch(() => {
        pending.value = false;
        submitted.value = false;
        for (const { field } of fields.values()) field.reset(event);
      });
    },
    root() {
      return {
        id,
        "data-clank-part": "root",
        noValidate: true,
        "aria-busy": () => pending.value || undefined,
        "data-pending": () => pending.value ? "" : undefined,
        "data-submitted": () => submitted.value ? "" : undefined,
        "data-valid": () => valid.value ? "" : undefined,
        "data-invalid": () => !valid.value ? "" : undefined,
        onSubmit: (event: Event) => { void controller.submit(event); },
        onReset: (event: Event) => controller.reset(event),
        onInput: (event: Event) => {
          if (event.defaultPrevented) return;
          const name = (event.target as HTMLInputElement | null)?.name;
          const field = name ? fields.get(name)?.field : undefined;
          if (field && (validationMode === "onChange" || (validationMode === "onSubmit" && submitted.peek()))) {
            void field.validate("input", event);
          }
        },
        onFocusOut: (event: FocusEvent) => {
          if (event.defaultPrevented || validationMode !== "onBlur") return;
          const name = (event.target as HTMLInputElement | null)?.name;
          const field = name ? fields.get(name)?.field : undefined;
          if (field) void field.validate("blur", event);
        },
        use(element: Element): Cleanup {
          formElement = element as HTMLFormElement;
          return () => { if (formElement === element) formElement = null; };
        },
      };
    },
    manifest: () => createUiManifest({
      component: "Form",
      id,
      state: {
        fields: [...fields.keys()],
        values: Object.freeze(Object.fromEntries(
          [...fields].map(([name, entry]) => [name, entry.field.manifest().state.value]),
        )),
        sensitiveFields: [...fields]
          .filter(([, entry]) => entry.field.sensitive.peek())
          .map(([name]) => name),
        pending: pending.peek(),
        submitted: submitted.peek(),
        valid: valid.peek(),
      },
      parts: [{ name: "root", defaultElement: "form", required: true }],
      actions: [
        { name: "validate", description: "Validate one field or the entire form.", sideEffects: "read", reasons: ["manual", "submit"] },
        { name: "submit", description: "Validate and submit the form values.", sideEffects: "write", reasons: ["submit"] },
        { name: "reset", description: "Reset every registered field.", sideEffects: "write", reasons: ["reset"] },
      ],
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      submission++;
      pending.value = false;
      for (const entry of fields.values()) entry.stop();
      fields.clear();
      formElement = null;
    },
  };
  return controller;
}

export type InputChangeReason = "input-change" | "input-clear" | "reset" | "programmatic";
export type InputType = "text" | "search" | "email" | "tel" | "url" | "password";

export interface InputOptions {
  id: string;
  name?: string;
  form?: string;
  type?: InputType;
  value?: FieldReadable<string>;
  defaultValue?: string | number;
  field?: FieldController<string>;
  disabled?: FieldReadable<boolean>;
  readOnly?: FieldReadable<boolean>;
  required?: FieldReadable<boolean>;
  onValueChange?: (value: string, details: ChangeDetails<InputChangeReason>) => void;
}

export interface InputController {
  readonly id: string;
  readonly value: Computed<string>;
  readonly focused: ReactiveSignal<boolean>;
  readonly dirty: Computed<boolean>;
  readonly filled: Computed<boolean>;
  setValue(value: string, reason?: InputChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  manifest(): UiManifest;
}

/** Native text input state with optional explicit Field integration. */
export function createInput(options: InputOptions): InputController {
  const id = requireId(options.id, "Input");
  if (options.field && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError("Input cannot use both field and value control.");
  }
  const inputType = requireInputType(options.type ?? "text");
  if (inputType === "password") options.field?.setSensitive(true);
  const initialSource = options.field
    ? options.field.value.peek()
    : options.defaultValue
      ?? (Object.prototype.hasOwnProperty.call(options, "value") ? read(options.value as FieldReadable<string>) : "");
  const initial = String(initialSource ?? "");
  const state = createControllableState<string, InputChangeReason>({
    ...(options.field
      ? { value: () => String(options.field!.value.value ?? "") }
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? { value: () => String(read(options.value as FieldReadable<string>) ?? "") }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) details.cancel();
    },
    name: `${id}.value`,
  });
  const focused = signal(false, { name: `${id}.focused` });
  const dirty = computed(() => !Object.is(state.value.value, initial), { name: `${id}.dirty` });
  const filled = computed(() => state.value.value.length > 0, { name: `${id}.filled` });
  const disabled = () => readBoolean(options.disabled) || readPartFlag(options.field, "disabled");
  const readOnly = () => readBoolean(options.readOnly) || readPartFlag(options.field, "readOnly");
  const required = () => readBoolean(options.required) || readPartFlag(options.field, "required");
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: options.field.controlId,
    type: inputType,
    format: (value) => String(value ?? ""),
  });
  let lastResetEvent: Event | undefined;
  const setValue = (next: string, reason: InputChangeReason = "programmatic", event?: Event) => {
    if ((disabled() || readOnly()) && reason !== "reset" && reason !== "programmatic") return false;
    return state.set(String(next), reason, event);
  };
  const reset = (event?: Event) => {
    if (isDuplicateResetEvent(event, lastResetEvent) || (event && isEventCanceled(event))) return false;
    if (event) {
      lastResetEvent = event;
      queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
    }
    const alreadyInitial = Object.is(state.value.peek(), initial);
    const changed = state.reset("reset", event);
    if (!changed && !alreadyInitial) return false;
    focused.value = false;
    options.field?.setFocused(false);
    options.field?.touch(false);
    return changed;
  };
  return {
    id,
    value: state.value,
    focused,
    dirty,
    filled,
    setValue,
    reset,
    root() {
      const use = (element: Element): Cleanup => {
        const input = element as HTMLInputElement;
        const synchronize = () => {
          if (input.value !== state.value.value) input.value = state.value.value;
          input.disabled = disabled();
          input.readOnly = readOnly();
          input.required = required();
        };
        const stop = effect(synchronize);
        const stopField = mountPartUse(fieldPart, input);
        const form = input.form;
        const onReset = (resetEvent: Event) => { reset(resetEvent); queueMicrotask(synchronize); };
        form?.addEventListener("reset", onReset);
        return () => { stopField?.(); stop(); form?.removeEventListener("reset", onReset); };
      };
      return {
        id: options.field?.controlId ?? id,
        "data-clank-part": "root",
        type: inputType,
        ...(name ? { name } : {}),
        ...(options.form ? { form: options.form } : {}),
        value: () => state.value.value,
        defaultValue: initial,
        disabled,
        readOnly,
        required,
        "aria-labelledby": fieldPart?.["aria-labelledby"],
        "aria-invalid": fieldPart?.["aria-invalid"],
        "aria-describedby": fieldPart?.["aria-describedby"],
        "aria-errormessage": fieldPart?.["aria-errormessage"],
        "data-disabled": () => disabled() ? "" : undefined,
        "data-readonly": () => readOnly() ? "" : undefined,
        "data-required": () => required() ? "" : undefined,
        "data-dirty": () => (options.field?.dirty.value ?? dirty.value) ? "" : undefined,
        "data-touched": () => options.field?.touched.value ? "" : undefined,
        "data-filled": () => filled.value ? "" : undefined,
        "data-focused": () => focused.value ? "" : undefined,
        "data-valid": () => options.field?.valid.value === true ? "" : undefined,
        "data-invalid": () => options.field?.valid.value === false ? "" : undefined,
        onInput: (event: Event) => {
          if (event.defaultPrevented) return;
          const input = event.currentTarget as HTMLInputElement;
          const next = input.value;
          if (!setValue(next, next.length === 0 ? "input-clear" : "input-change", event)) {
            input.value = state.value.peek();
          }
        },
        onFocus: () => { focused.value = true; options.field?.setFocused(true); },
        onBlur: (event: Event) => {
          focused.value = false;
          options.field?.setFocused(false);
          options.field?.touch();
          if (shouldValidateOnBlur(options.field)) void options.field!.validate("blur", event);
        },
        onInvalid: fieldPart?.onInvalid,
        use,
      };
    },
    manifest: () => createUiManifest({
      component: "Input",
      id,
      state: {
        value: inputType === "password" && state.value.peek() ? "[redacted]" : state.value.peek(),
        focused: focused.peek(),
        dirty: dirty.peek(),
        filled: filled.peek(),
        disabled: disabled(),
        readOnly: readOnly(),
        required: required(),
      },
      parts: [{ name: "root", defaultElement: "input", required: true }],
      actions: [
        { name: "setValue", description: "Change the text value.", sideEffects: "write", reasons: ["input-change", "input-clear", "programmatic"] },
        { name: "reset", description: "Restore the initial text value.", sideEffects: "write", reasons: ["reset"] },
      ],
    }),
  };
}

export type NumberFieldChangeReason =
  | "input-change"
  | "input-clear"
  | "input-blur"
  | "input-paste"
  | "keyboard"
  | "increment-press"
  | "decrement-press"
  | "wheel"
  | "scrub"
  | "reset"
  | "programmatic";

export interface NumberFieldOptions {
  id: string;
  name?: string;
  form?: string;
  value?: FieldReadable<number | null>;
  defaultValue?: number | null;
  field?: FieldController<number | null>;
  min?: number;
  max?: number;
  step?: number | "any";
  smallStep?: number;
  largeStep?: number;
  snapOnStep?: boolean;
  allowOutOfRange?: boolean;
  allowWheelScrub?: boolean;
  locale?: Intl.LocalesArgument;
  format?: Intl.NumberFormatOptions;
  disabled?: FieldReadable<boolean>;
  readOnly?: FieldReadable<boolean>;
  required?: FieldReadable<boolean>;
  scrubDirection?: "horizontal" | "vertical";
  pixelSensitivity?: number;
  /** Delay before a held increment/decrement button starts repeating. */
  stepButtonDelay?: number;
  /** Interval between repeated steps while a button remains held. */
  stepButtonInterval?: number;
  onValueChange?: (value: number | null, details: ChangeDetails<NumberFieldChangeReason>) => void;
  onValueCommitted?: (value: number | null, details: ChangeDetails<NumberFieldChangeReason>) => void;
}

export interface NumberFieldController {
  readonly id: string;
  readonly value: Computed<number | null>;
  readonly inputValue: ReactiveSignal<string>;
  readonly focused: ReactiveSignal<boolean>;
  readonly touched: ReactiveSignal<boolean>;
  readonly scrubbing: ReactiveSignal<boolean>;
  readonly dirty: Computed<boolean>;
  readonly filled: Computed<boolean>;
  setValue(value: number | null, reason?: NumberFieldChangeReason, event?: Event): boolean;
  increment(event?: Event, amount?: number): boolean;
  decrement(event?: Event, amount?: number): boolean;
  commit(reason?: NumberFieldChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  scrubArea(): Record<string, unknown>;
  scrubAreaCursor(): Record<string, unknown>;
  group(): Record<string, unknown>;
  decrementButton(): Record<string, unknown>;
  input(): Record<string, unknown>;
  incrementButton(): Record<string, unknown>;
  manifest(): UiManifest;
}

/** Locale-aware number editing, stepping, press controls, wheel, and pointer scrubbing. */
export function createNumberField(options: NumberFieldOptions): NumberFieldController {
  const id = requireId(options.id, "Number field");
  if (options.field && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError("Number field cannot use both field and value control.");
  }
  const min = optionalFinite(options.min, "Number field min");
  const max = optionalFinite(options.max, "Number field max");
  if (min !== undefined && max !== undefined && max < min) throw new TypeError("Number field max must be greater than or equal to min.");
  const step = options.step === "any" ? "any" : positiveFinite(options.step ?? 1, "Number field step");
  const smallStep = positiveFinite(options.smallStep ?? 0.1, "Number field smallStep");
  const largeStep = positiveFinite(options.largeStep ?? 10, "Number field largeStep");
  const pixelSensitivity = positiveFinite(options.pixelSensitivity ?? 2, "Number field pixelSensitivity");
  const stepButtonDelay = nonNegative(options.stepButtonDelay ?? 400, "Number field stepButtonDelay");
  const stepButtonInterval = positiveFinite(options.stepButtonInterval ?? 60, "Number field stepButtonInterval");
  const initialInput = options.field
    ? options.field.value.peek()
    : Object.prototype.hasOwnProperty.call(options, "defaultValue")
      ? options.defaultValue as number | null
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? read(options.value as FieldReadable<number | null>)
        : null;
  const initial = normalizeNullableNumber(initialInput, min, max, false, "Number field defaultValue");
  const numberFormat = new Intl.NumberFormat(options.locale, options.format);
  const parser = createNumberParser(options.locale, options.format);
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: options.field.controlId,
    type: "text",
    format: (value) => formatNumber(value, numberFormat),
  });
  const state = createControllableState<number | null, NumberFieldChangeReason>({
    ...(options.field
      ? { value: () => normalizeNullableNumber(options.field!.value.value, min, max, true, "Number field value") }
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? { value: () => normalizeNullableNumber(read(options.value as FieldReadable<number | null>), min, max, true, "Number field value") }
        : {}),
    defaultValue: initial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) details.cancel();
    },
    name: `${id}.value`,
  });
  const inputValue = signal(formatNumber(initial, numberFormat), { name: `${id}.inputValue` });
  const focused = signal(false, { name: `${id}.focused` });
  const touched = signal(false, { name: `${id}.touched` });
  const scrubbing = signal(false, { name: `${id}.scrubbing` });
  const dirty = computed(() => !Object.is(state.value.value, initial), { name: `${id}.dirty` });
  const filled = computed(() => state.value.value !== null, { name: `${id}.filled` });
  const disabled = () => readBoolean(options.disabled) || readPartFlag(options.field, "disabled");
  const readOnly = () => readBoolean(options.readOnly) || readPartFlag(options.field, "readOnly");
  const required = () => readBoolean(options.required) || readPartFlag(options.field, "required");
  const blocked = () => disabled() || readOnly();
  const baseStep = step === "any" ? 1 : step;
  let controller!: NumberFieldController;
  let scrub: { pointerId: number; start: number; coordinate: number; target: Element | null } | null = null;
  let lastResetEvent: Event | undefined;

  const setValue = (next: number | null, reason: NumberFieldChangeReason = "programmatic", event?: Event): boolean => {
    if (blocked() && reason !== "reset" && reason !== "programmatic") return false;
    const direct = reason === "input-change"
      || reason === "input-paste"
      || (reason === "input-blur" && options.allowOutOfRange === true);
    let normalized = normalizeNullableNumber(next, min, max, direct && options.allowOutOfRange === true, "Number field value");
    if (normalized !== null && options.snapOnStep && !direct) normalized = snapNumber(normalized, stepForSnap(reason), min, max);
    const changed = state.set(normalized, reason, event);
    if (changed && !direct) inputValue.value = formatNumber(state.value.peek(), numberFormat);
    return changed;
  };
  const setInputValue = (
    raw: string,
    next: number | null,
    reason: Extract<NumberFieldChangeReason, "input-change" | "input-clear" | "input-paste">,
    event: Event,
    input: HTMLInputElement,
  ): boolean => {
    const previous = state.value.peek();
    inputValue.value = raw;
    const changed = setValue(next, reason, event);
    const accepted = changed || Object.is(next, previous);
    if (!accepted) {
      const restored = formatNumber(state.value.peek(), numberFormat);
      inputValue.value = restored;
      input.value = restored;
    }
    return accepted;
  };

  const stepForEvent = (event?: Event, explicit?: number): number => {
    if (explicit !== undefined) return positiveFinite(explicit, "Number field increment amount");
    const keyboard = event as KeyboardEvent | undefined;
    if (keyboard?.altKey) return smallStep;
    if (keyboard?.shiftKey) return largeStep;
    return baseStep;
  };
  const stepForSnap = (reason: NumberFieldChangeReason) => reason === "keyboard" ? baseStep : baseStep;
  const changeBy = (direction: -1 | 1, reason: NumberFieldChangeReason, event?: Event, amount?: number) => {
    if (blocked()) return false;
    const current = state.value.peek();
    const delta = stepForEvent(event, amount) * direction;
    // Base UI seeds an empty number field with zero before applying directional
    // stepping. The seed is clamped to the nearest in-range value, but it is not
    // itself a step and therefore must not be shifted or snap-rounded.
    let next = current === null ? 0 : addWithPrecision(current, delta);
    if (current !== null && options.snapOnStep) next = snapNumber(next, Math.abs(delta), min, max);
    const normalized = normalizeNullableNumber(next, min, max, false, "Number field value");
    const changed = state.set(normalized, reason, event);
    if (changed) inputValue.value = formatNumber(state.value.peek(), numberFormat);
    return changed;
  };
  const commit = (reason: NumberFieldChangeReason = "input-blur", event?: Event) => {
    const parsed = parser.parse(inputValue.peek());
    let next = parsed.kind === "number" ? parsed.value : parsed.kind === "empty" ? null : state.value.peek();
    next = normalizeNullableNumber(next, min, max, options.allowOutOfRange === true && reason === "input-blur", "Number field value");
    const previous = state.value.peek();
    const changed = setValue(next, reason, event);
    inputValue.value = formatNumber(state.value.peek(), numberFormat);
    if (!changed && !Object.is(next, previous)) return false;
    const details = createChangeDetails(reason, event);
    options.onValueCommitted?.(state.value.peek(), details);
    options.field?.touch();
    return changed || !details.canceled;
  };
  const reset = (event?: Event) => {
    if (isDuplicateResetEvent(event, lastResetEvent) || (event && isEventCanceled(event))) return false;
    if (event) {
      lastResetEvent = event;
      queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
    }
    const alreadyInitial = Object.is(state.value.peek(), initial);
    const changed = state.reset("reset", event);
    if (!changed && !alreadyInitial) return false;
    batch(() => {
      inputValue.value = formatNumber(initial, numberFormat);
      touched.value = false;
      focused.value = false;
      scrubbing.value = false;
    });
    options.field?.setFocused(false);
    options.field?.touch(false);
    return changed;
  };

  const commonStateProps = () => ({
    "data-disabled": () => disabled() ? "" : undefined,
    "data-readonly": () => readOnly() ? "" : undefined,
    "data-required": () => required() ? "" : undefined,
    "data-valid": () => options.field?.valid.value === true ? "" : undefined,
    "data-invalid": () => options.field?.valid.value === false ? "" : undefined,
    "data-dirty": () => (options.field?.dirty.value ?? dirty.value) ? "" : undefined,
    "data-touched": () => (options.field?.touched.value ?? touched.value) ? "" : undefined,
    "data-filled": () => filled.value ? "" : undefined,
    "data-focused": () => focused.value ? "" : undefined,
    "data-scrubbing": () => scrubbing.value ? "" : undefined,
  });
  const beginScrub = (event: PointerEvent) => {
    if (blocked() || event.defaultPrevented || event.button !== 0) return;
    const target = event.currentTarget as Element | null;
    scrub = {
      pointerId: event.pointerId,
      start: state.value.peek() ?? min ?? 0,
      coordinate: options.scrubDirection === "vertical" ? event.clientY : event.clientX,
      target,
    };
    scrubbing.value = true;
    (target as Element & { setPointerCapture?: (id: number) => void })?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const moveScrub = (event: PointerEvent) => {
    if (!scrub || scrub.pointerId !== event.pointerId || blocked()) return;
    const coordinate = options.scrubDirection === "vertical" ? event.clientY : event.clientX;
    const physical = (coordinate - scrub.coordinate) / pixelSensitivity;
    const signed = options.scrubDirection === "vertical" ? -physical : physical;
    const steps = Math.trunc(signed);
    setValue(addWithPrecision(scrub.start, steps * baseStep), "scrub", event);
    event.preventDefault();
  };
  const endScrub = (event: PointerEvent, canceled = false) => {
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const target = scrub.target as Element & { releasePointerCapture?: (id: number) => void };
    target?.releasePointerCapture?.(event.pointerId);
    scrub = null;
    scrubbing.value = false;
    if (!canceled) commit("scrub", event);
  };
  const stepButton = (direction: -1 | 1): Record<string, unknown> => {
    const reason = direction > 0 ? "increment-press" : "decrement-press";
    let activePointer: number | undefined;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let intervalTimer: ReturnType<typeof setInterval> | undefined;
    let changedDuringPress = false;
    let suppressClick = false;
    const clearTimers = () => {
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      if (intervalTimer !== undefined) clearInterval(intervalTimer);
      delayTimer = undefined;
      intervalTimer = undefined;
    };
    const finish = (event: PointerEvent, canceled: boolean) => {
      if (activePointer !== event.pointerId) return;
      const target = event.currentTarget as Element & { releasePointerCapture?: (id: number) => void };
      target.releasePointerCapture?.(event.pointerId);
      activePointer = undefined;
      clearTimers();
      if (!canceled && changedDuringPress) commit(reason, event);
      changedDuringPress = false;
      suppressClick = true;
      queueMicrotask(() => { suppressClick = false; });
    };
    return {
      id: `${id}-${direction > 0 ? "increment" : "decrement"}`,
      "data-clank-part": direction > 0 ? "increment" : "decrement",
      type: "button",
      tabIndex: -1,
      disabled: () => {
        const current = state.value.value;
        return disabled() || (current !== null && (direction > 0
          ? max !== undefined && current >= max
          : min !== undefined && current <= min));
      },
      "aria-label": direction > 0 ? "Increase value" : "Decrease value",
      style: { touchAction: "manipulation" },
      ...commonStateProps(),
      onPointerDown: (event: PointerEvent) => {
        if (blocked() || event.defaultPrevented || event.button !== 0 || activePointer !== undefined) return;
        activePointer = event.pointerId;
        changedDuringPress = changeBy(direction, reason, event);
        const target = event.currentTarget as Element & { setPointerCapture?: (id: number) => void };
        target.setPointerCapture?.(event.pointerId);
        delayTimer = setTimeout(() => {
          delayTimer = undefined;
          // Repeat as soon as the hold delay elapses, then continue on the
          // interval. Besides matching native stepper behavior, this keeps a
          // delayed event loop from letting pointerup overtake the first
          // repeat when both timers become ready in the same turn.
          if (!changeBy(direction, reason)) {
            clearTimers();
            return;
          }
          changedDuringPress = true;
          intervalTimer = setInterval(() => {
            if (!changeBy(direction, reason)) clearTimers();
            else changedDuringPress = true;
          }, stepButtonInterval);
        }, stepButtonDelay);
        event.preventDefault();
      },
      onPointerUp: (event: PointerEvent) => finish(event, false),
      onPointerCancel: (event: PointerEvent) => finish(event, true),
      onLostPointerCapture: (event: PointerEvent) => finish(event, true),
      onClick: (event: Event) => {
        if (suppressClick) {
          event.preventDefault();
          return;
        }
        if (changeBy(direction, reason, event)) commit(reason, event);
      },
      use: (): Cleanup => clearTimers,
    };
  };

  controller = {
    id,
    value: state.value,
    inputValue,
    focused,
    touched,
    scrubbing,
    dirty,
    filled,
    setValue,
    increment: (event, amount) => changeBy(1, "increment-press", event, amount),
    decrement: (event, amount) => changeBy(-1, "decrement-press", event, amount),
    commit,
    reset,
    root: () => ({ id: `${id}-root`, "data-clank-part": "root", ...commonStateProps() }),
    scrubArea: () => ({
      role: "presentation",
      "data-clank-part": "scrub-area",
      "data-direction": options.scrubDirection ?? "horizontal",
      style: { touchAction: "none", userSelect: "none" },
      ...commonStateProps(),
      onPointerDown: beginScrub,
      onPointerMove: moveScrub,
      onPointerUp: (event: PointerEvent) => endScrub(event),
      onPointerCancel: (event: PointerEvent) => endScrub(event, true),
      onLostPointerCapture: (event: PointerEvent) => endScrub(event, true),
    }),
    scrubAreaCursor: () => ({
      "aria-hidden": true,
      "data-clank-part": "scrub-area-cursor",
      hidden: () => !scrubbing.value,
      ...commonStateProps(),
    }),
    group: () => ({ role: "group", "aria-disabled": () => disabled() || undefined, "data-clank-part": "group", ...commonStateProps() }),
    decrementButton: () => stepButton(-1),
    input() {
      const use = (element: Element): Cleanup => {
        const input = element as HTMLInputElement;
        const synchronize = () => {
          if (!focused.value && input.value !== formatNumber(state.value.value, numberFormat)) {
            inputValue.value = formatNumber(state.value.value, numberFormat);
          }
          if (input.value !== inputValue.value) input.value = inputValue.value;
          input.disabled = disabled();
          input.readOnly = readOnly();
          input.required = required();
        };
        const stop = effect(synchronize);
        const stopField = mountPartUse(fieldPart, input);
        const form = input.form;
        const onReset = (resetEvent: Event) => { reset(resetEvent); queueMicrotask(synchronize); };
        form?.addEventListener("reset", onReset);
        return () => { stopField?.(); stop(); form?.removeEventListener("reset", onReset); };
      };
      return {
        id: options.field?.controlId ?? id,
        "data-clank-part": "input",
        type: "text",
        role: "spinbutton",
        inputMode: "decimal",
        ...(name ? { name } : {}),
        ...(options.form ? { form: options.form } : {}),
        value: () => inputValue.value,
        disabled,
        readOnly,
        required,
        "aria-valuemin": min,
        "aria-valuemax": max,
        "aria-valuenow": () => state.value.value ?? undefined,
        "aria-valuetext": () => state.value.value === null ? undefined : numberFormat.format(state.value.value),
        "aria-labelledby": fieldPart?.["aria-labelledby"],
        "aria-describedby": fieldPart?.["aria-describedby"],
        "aria-errormessage": fieldPart?.["aria-errormessage"],
        "aria-invalid": fieldPart?.["aria-invalid"],
        ...commonStateProps(),
        onFocus: () => { focused.value = true; options.field?.setFocused(true); },
        onInput: (event: Event) => {
          if (blocked() || event.defaultPrevented) return;
          const input = event.currentTarget as HTMLInputElement;
          const raw = input.value;
          const parsed = parser.parse(raw);
          if (parsed.kind === "empty") setInputValue(raw, null, "input-clear", event, input);
          else if (parsed.kind === "number") setInputValue(raw, parsed.value, "input-change", event, input);
          else inputValue.value = raw;
        },
        onPaste: (event: ClipboardEvent) => {
          if (blocked() || event.defaultPrevented) return;
          const text = event.clipboardData?.getData("text");
          if (text === undefined) return;
          const parsed = parser.parse(text);
          if (parsed.kind === "number") {
            setInputValue(text, parsed.value, "input-paste", event, event.currentTarget as HTMLInputElement);
            event.preventDefault();
          }
        },
        onBlur: (event: Event) => {
          focused.value = false;
          options.field?.setFocused(false);
          touched.value = true;
          commit("input-blur", event);
          if (shouldValidateOnBlur(options.field)) void options.field!.validate("blur", event);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (blocked() || event.defaultPrevented) return;
          let changed = false;
          if (event.key === "ArrowUp") changed = changeBy(1, "keyboard", event);
          else if (event.key === "ArrowDown") changed = changeBy(-1, "keyboard", event);
          else if (event.key === "Home" && min !== undefined) changed = setValue(min, "keyboard", event);
          else if (event.key === "End" && max !== undefined) changed = setValue(max, "keyboard", event);
          else if (event.key === "Enter") { commit("keyboard", event); return; }
          else return;
          if (changed) commit("keyboard", event);
          event.preventDefault();
        },
        onWheel: (event: WheelEvent) => {
          if (event.defaultPrevented || !options.allowWheelScrub || blocked() || !focused.peek()) return;
          const changed = changeBy(event.deltaY < 0 ? 1 : -1, "wheel", event);
          if (changed) commit("wheel", event);
          event.preventDefault();
        },
        onInvalid: fieldPart?.onInvalid,
        use,
      };
    },
    incrementButton: () => stepButton(1),
    manifest: () => createUiManifest({
      component: "NumberField",
      id,
      state: {
        value: state.value.peek(),
        inputValue: inputValue.peek(),
        min: min ?? null,
        max: max ?? null,
        step,
        smallStep,
        largeStep,
        disabled: disabled(),
        readOnly: readOnly(),
        required: required(),
        dirty: dirty.peek(),
        touched: touched.peek(),
        focused: focused.peek(),
        filled: filled.peek(),
        scrubbing: scrubbing.peek(),
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "scrub-area", defaultElement: "div" },
        { name: "scrub-area-cursor", defaultElement: "span" },
        { name: "group", role: "group", defaultElement: "div" },
        { name: "decrement", defaultElement: "button" },
        { name: "input", role: "spinbutton", defaultElement: "input", required: true },
        { name: "increment", defaultElement: "button" },
      ],
      actions: [
        { name: "setValue", description: "Set the numeric value.", sideEffects: "write", reasons: ["input-change", "input-clear", "programmatic"] },
        { name: "increment", description: "Increase by a configured step.", sideEffects: "write", reasons: ["keyboard", "increment-press", "wheel", "scrub"] },
        { name: "decrement", description: "Decrease by a configured step.", sideEffects: "write", reasons: ["keyboard", "decrement-press", "wheel", "scrub"] },
        { name: "commit", description: "Commit and format the current value.", sideEffects: "write", reasons: ["input-blur", "keyboard", "wheel", "scrub"] },
        { name: "reset", description: "Restore the initial numeric value.", sideEffects: "write", reasons: ["reset"] },
      ],
      keyboard: {
        ArrowUp: "Increment by step; Alt uses smallStep and Shift uses largeStep.",
        ArrowDown: "Decrement by step; Alt uses smallStep and Shift uses largeStep.",
        Home: "Set min when provided.",
        End: "Set max when provided.",
        Enter: "Commit and format the value.",
      },
    }),
  };
  return controller;
}

export type OtpValidationType =
  | "numeric"
  | "alpha"
  | "alphanumeric"
  | RegExp
  | ((character: string) => boolean);
export type OtpFieldChangeReason = "input-change" | "input-clear" | "input-paste" | "keyboard" | "reset" | "programmatic";

export interface OtpFieldOptions {
  id: string;
  length: number;
  name?: string;
  form?: string;
  value?: FieldReadable<string>;
  defaultValue?: string;
  field?: FieldController<string>;
  validationType?: OtpValidationType;
  normalizeValue?: (value: string) => string;
  mask?: boolean;
  maskCharacter?: string;
  autoComplete?: string;
  autoSubmit?: boolean;
  inputMode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  disabled?: FieldReadable<boolean>;
  readOnly?: FieldReadable<boolean>;
  required?: FieldReadable<boolean>;
  direction?: Direction | "auto";
  onValueChange?: (value: string, details: ChangeDetails<OtpFieldChangeReason>) => void;
  onValueInvalid?: (rejected: string, details: ChangeDetails<OtpFieldChangeReason>) => void;
  onValueComplete?: (value: string, details: ChangeDetails<OtpFieldChangeReason>) => void;
  /** @deprecated Use onValueComplete. */
  onComplete?: (value: string, details: ChangeDetails<OtpFieldChangeReason>) => void;
}

export interface OtpFieldController {
  readonly id: string;
  readonly length: number;
  readonly value: Computed<string>;
  readonly complete: Computed<boolean>;
  readonly focused: ReactiveSignal<boolean>;
  readonly activeIndex: ReactiveSignal<number>;
  readonly touched: ReactiveSignal<boolean>;
  readonly dirty: Computed<boolean>;
  setValue(value: string, reason?: OtpFieldChangeReason, event?: Event): boolean;
  clear(index?: number, event?: Event): boolean;
  reset(event?: Event): boolean;
  focus(index: number, source?: Element | null): boolean;
  root(): Record<string, unknown>;
  input(index: number, options?: OtpFieldInputPartOptions): Record<string, unknown>;
  separator(orientation?: "horizontal" | "vertical"): Record<string, unknown>;
  hiddenInput(): Record<string, unknown>;
  manifest(): UiManifest;
}

export interface OtpFieldInputPartOptions {
  /** Accessible name for the individual slot. Later slots receive a synthetic name by default. */
  ariaLabel?: string;
}

/** Logical one-time-code state projected into individually focusable native slots. */
export function createOtpField(options: OtpFieldOptions): OtpFieldController {
  const id = requireId(options.id, "OTP field");
  const direction = options.direction ?? useDirection();
  const length = positiveInteger(options.length, "OTP field length", 128);
  if (options.field && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError("OTP field cannot use both field and value control.");
  }
  options.field?.setSensitive(true);
  const validationType = options.validationType ?? "numeric";
  const normalizedInitial = normalizeOtp(
    options.field
      ? options.field.value.peek()
      : options.defaultValue
        ?? (Object.prototype.hasOwnProperty.call(options, "value") ? read(options.value as FieldReadable<string>) : ""),
    length,
    validationType,
    options.normalizeValue,
  ).value;
  const state = createControllableState<string, OtpFieldChangeReason>({
    ...(options.field
      ? { value: () => normalizeOtp(options.field!.value.value, length, validationType, options.normalizeValue).value }
      : Object.prototype.hasOwnProperty.call(options, "value")
        ? { value: () => normalizeOtp(read(options.value as FieldReadable<string>), length, validationType, options.normalizeValue).value }
        : {}),
    defaultValue: normalizedInitial,
    onValueChange(next, details) {
      options.onValueChange?.(next, details);
      if (!details.canceled && options.field && !options.field.setValue(
        next,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) details.cancel();
    },
    name: `${id}.value`,
  });
  const complete = computed(() => otpCharacters(state.value.value).length === length, { name: `${id}.complete` });
  const focused = signal(false, { name: `${id}.focused` });
  const activeIndex = signal(-1, { name: `${id}.activeIndex` });
  const touched = signal(false, { name: `${id}.touched` });
  const dirty = computed(() => state.value.value !== normalizedInitial, { name: `${id}.dirty` });
  const disabled = () => readBoolean(options.disabled) || readPartFlag(options.field, "disabled");
  const readOnly = () => readBoolean(options.readOnly) || readPartFlag(options.field, "readOnly");
  const required = () => readBoolean(options.required) || readPartFlag(options.field, "required");
  const blocked = () => disabled() || readOnly();
  const autoComplete = options.autoComplete ?? "one-time-code";
  const inputMode = options.inputMode ?? (validationType === "numeric" ? "numeric" : "text");
  const maskCharacter = options.maskCharacter ?? "•";
  if ([...maskCharacter].length !== 1) throw new TypeError("OTP field maskCharacter must contain exactly one character.");
  let owningForm: HTMLFormElement | null = null;
  let controller!: OtpFieldController;
  let lastResetEvent: Event | undefined;
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: options.field.controlId,
    type: "password",
    format: (value) => String(value ?? ""),
  });

  const applyValue = (
    raw: string,
    reason: OtpFieldChangeReason = "programmatic",
    event?: Event,
    completePaste = false,
  ): boolean => {
    if (blocked() && reason !== "reset" && reason !== "programmatic") return false;
    const normalized = normalizeOtp(raw, length, validationType, options.normalizeValue);
    if (normalized.rejected) options.onValueInvalid?.(normalized.rejected, createChangeDetails(reason, event));
    const wasComplete = complete.peek();
    const previous = state.value.peek();
    const changed = state.set(normalized.value, reason, event);
    const accepted = changed || Object.is(normalized.value, previous);
    const isComplete = otpCharacters(normalized.value).length === length;
    if (accepted && isComplete && ((changed && !wasComplete) || (reason === "input-paste" && completePaste))) {
      const details = createChangeDetails(reason, event);
      options.onValueComplete?.(normalized.value, details);
      if (options.onComplete !== options.onValueComplete) options.onComplete?.(normalized.value, details);
      if (options.autoSubmit && !details.canceled) {
        queueMicrotask(() => owningForm?.requestSubmit?.());
      }
    }
    return changed;
  };
  const setValue = (raw: string, reason: OtpFieldChangeReason = "programmatic", event?: Event): boolean =>
    applyValue(raw, reason, event);
  const slotId = (index: number) => index === 0
    ? options.field?.controlId ?? id
    : `${id}-slot-${index}`;
  const focus = (index: number, source?: Element | null): boolean => {
    const safe = Math.max(0, Math.min(length - 1, Math.trunc(index)));
    const document = source?.ownerDocument ?? (typeof globalThis.document === "undefined" ? null : globalThis.document);
    const element = document?.getElementById(slotId(safe)) as HTMLInputElement | null;
    if (!element || typeof element.focus !== "function") return false;
    element.focus();
    element.select?.();
    return true;
  };
  const clear = (index?: number, event?: Event): boolean => {
    if (blocked()) return false;
    if (index === undefined) return setValue("", "keyboard", event);
    requireIndex(index, length, "OTP slot");
    const current = otpCharacters(state.value.peek());
    if (index >= current.length) return false;
    current.splice(index, 1);
    return setValue(current.join(""), "keyboard", event);
  };
  const reset = (event?: Event) => {
    if (isDuplicateResetEvent(event, lastResetEvent) || (event && isEventCanceled(event))) return false;
    if (event) {
      lastResetEvent = event;
      queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
    }
    const alreadyInitial = Object.is(state.value.peek(), normalizedInitial);
    const changed = state.reset("reset", event);
    if (!changed && !alreadyInitial) return false;
    batch(() => {
      focused.value = false;
      activeIndex.value = -1;
      touched.value = false;
    });
    options.field?.setFocused(false);
    options.field?.touch(false);
    return changed;
  };
  const rootStateProps = () => ({
    "data-disabled": () => disabled() ? "" : undefined,
    "data-readonly": () => readOnly() ? "" : undefined,
    "data-required": () => required() ? "" : undefined,
    "data-complete": () => complete.value ? "" : undefined,
    "data-filled": () => state.value.value.length > 0 ? "" : undefined,
    "data-focused": () => focused.value ? "" : undefined,
    "data-dirty": () => (options.field?.dirty.value ?? dirty.value) ? "" : undefined,
    "data-touched": () => (options.field?.touched.value ?? touched.value) ? "" : undefined,
    "data-valid": () => options.field?.valid.value === true ? "" : undefined,
    "data-invalid": () => options.field?.valid.value === false ? "" : undefined,
  });

  controller = {
    id,
    length,
    value: state.value,
    complete,
    focused,
    activeIndex,
    touched,
    dirty,
    setValue,
    clear,
    reset,
    focus,
    root: () => ({
      id: `${id}-root`,
      role: "group",
      dir: direction,
      "aria-disabled": () => disabled() || undefined,
      "aria-labelledby": fieldPart?.["aria-labelledby"],
      "aria-describedby": fieldPart?.["aria-describedby"],
      "aria-errormessage": fieldPart?.["aria-errormessage"],
      "aria-invalid": fieldPart?.["aria-invalid"],
      "data-clank-part": "root",
      ...rootStateProps(),
    }),
    input(index, partOptions = {}) {
      requireIndex(index, length, "OTP slot");
      const slotValue = () => otpCharacters(state.value.value)[index] ?? "";
      const shownValue = () => options.mask && slotValue() ? maskCharacter : slotValue();
      const updateFromText = (text: string, reason: OtpFieldChangeReason, event?: Event) => {
        if (blocked()) return false;
        const current = otpCharacters(state.value.peek());
        const normalized = normalizeOtp(text, length, validationType, options.normalizeValue);
        if (normalized.rejected) options.onValueInvalid?.(normalized.rejected, createChangeDetails(reason, event));
        if (normalized.value.length === 0) return clear(index, event);
        let next: string;
        if (text.length > 1 || normalized.value.length > 1) {
          const inserted = otpCharacters(normalized.value);
          next = [...current.slice(0, index), ...inserted, ...current.slice(index + inserted.length)].join("");
        } else {
          next = [...current.slice(0, index), normalized.value, ...current.slice(index + 1)].join("");
        }
        const completePaste = reason === "input-paste" && otpCharacters(normalized.value).length === length;
        const changed = applyValue(next, reason, event, completePaste);
        const nextIndex = Math.min(length - 1, index + Math.max(1, normalized.value.length));
        if (changed && nextIndex !== index) focus(nextIndex, event?.currentTarget as Element | null);
        return changed;
      };
      const use = (element: Element): Cleanup => {
        const input = element as HTMLInputElement;
        const synchronize = () => {
          if (input.value !== shownValue()) input.value = shownValue();
          input.disabled = disabled();
          input.readOnly = readOnly();
        };
        const stop = effect(synchronize);
        const form = input.form;
        if (form) owningForm = form;
        const onReset = (resetEvent: Event) => { reset(resetEvent); queueMicrotask(synchronize); };
        form?.addEventListener("reset", onReset);
        return () => {
          stop();
          form?.removeEventListener("reset", onReset);
          if (owningForm === form) owningForm = null;
        };
      };
      return {
        id: slotId(index),
        "data-clank-part": "input",
        type: options.mask ? "password" : "text",
        inputMode,
        autoComplete: index === 0 ? autoComplete : "off",
        maxLength: index === 0 ? length : 1,
        value: shownValue,
        disabled,
        readOnly,
        ...(partOptions.ariaLabel !== undefined
          ? { "aria-label": partOptions.ariaLabel }
          : index === 0
            ? {}
            : { "aria-label": `Character ${index + 1} of ${length}` }),
        "aria-describedby": fieldPart?.["aria-describedby"],
        "aria-errormessage": fieldPart?.["aria-errormessage"],
        "aria-invalid": fieldPart?.["aria-invalid"],
        "data-index": index,
        "data-active": () => activeIndex.value === index ? "" : undefined,
        ...rootStateProps(),
        "data-filled": () => slotValue() ? "" : undefined,
        onFocus: (event: Event) => {
          focused.value = true;
          options.field?.setFocused(true);
          activeIndex.value = index;
          (event.currentTarget as HTMLInputElement).select?.();
        },
        onBlur: (event: FocusEvent) => {
          const root = (event.currentTarget as Element)?.ownerDocument?.getElementById(`${id}-root`);
          if (!root || !event.relatedTarget || !root.contains(event.relatedTarget as Node)) {
            focused.value = false;
            options.field?.setFocused(false);
            activeIndex.value = -1;
            touched.value = true;
            options.field?.touch();
            if (shouldValidateOnBlur(options.field)) void options.field!.validate("blur", event);
          }
        },
        onInput: (event: Event) => {
          if (event.defaultPrevented) return;
          const input = event.currentTarget as HTMLInputElement;
          const text = input.value;
          updateFromText(text, text ? "input-change" : "input-clear", event);
          input.value = shownValue();
        },
        onPaste: (event: ClipboardEvent) => {
          const text = event.clipboardData?.getData("text");
          if (text === undefined || blocked() || event.defaultPrevented) return;
          updateFromText(text, "input-paste", event);
          (event.currentTarget as HTMLInputElement).value = shownValue();
          event.preventDefault();
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (blocked() || event.defaultPrevented) return;
          const resolvedDirection = resolveDirection(direction, event.currentTarget as Element);
          const previousKey = resolvedDirection === "rtl" ? "ArrowRight" : "ArrowLeft";
          const nextKey = resolvedDirection === "rtl" ? "ArrowLeft" : "ArrowRight";
          if (event.key === previousKey) focus(index - 1, event.currentTarget as Element);
          else if (event.key === nextKey) focus(index + 1, event.currentTarget as Element);
          else if (event.key === "Home") focus(0, event.currentTarget as Element);
          else if (event.key === "End") focus(length - 1, event.currentTarget as Element);
          else if (event.key === "Backspace") {
            if (slotValue()) clear(index, event);
            else if (index > 0) {
              clear(index - 1, event);
              focus(index - 1, event.currentTarget as Element);
            }
          } else if (event.key === "Delete") clear(index, event);
          else return;
          event.preventDefault();
        },
        use,
      };
    },
    separator: (orientation = "horizontal") => ({
      role: "separator",
      "data-clank-part": "separator",
      "aria-orientation": orientation,
      "data-orientation": orientation,
      ...rootStateProps(),
    }),
    hiddenInput() {
      const use = (element: Element): Cleanup => {
        const input = element as HTMLInputElement;
        const synchronize = () => {
          input.value = state.value.value;
          input.disabled = disabled();
          input.required = required();
        };
        const stop = effect(synchronize);
        const stopField = mountPartUse(fieldPart, input);
        const form = input.form;
        if (form) owningForm = form;
        const onReset = (resetEvent: Event) => { reset(resetEvent); queueMicrotask(synchronize); };
        form?.addEventListener("reset", onReset);
        return () => { stopField?.(); stop(); form?.removeEventListener("reset", onReset); if (owningForm === form) owningForm = null; };
      };
      return {
        id: `${id}-hidden-input`,
        "data-clank-part": "hidden-input",
        type: "password",
        ...(name ? { name } : {}),
        ...(options.form ? { form: options.form } : {}),
        value: () => state.value.value,
        defaultValue: normalizedInitial,
        disabled,
        required,
        minLength: length,
        maxLength: length,
        pattern: `.{${length}}`,
        autoComplete,
        tabIndex: -1,
        "aria-hidden": true,
        onInvalid: fieldPart?.onInvalid,
        onFocus: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          (input.ownerDocument?.getElementById(slotId(0)) as HTMLElement | null)?.focus?.();
        },
        style: {
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        },
        "data-clank-native-control": "otp-field",
        use,
      };
    },
    manifest: () => createUiManifest({
      component: "OTPField",
      id,
      state: {
        value: maskCharacter.repeat(otpCharacters(state.value.peek()).length),
        valueLength: otpCharacters(state.value.peek()).length,
        length,
        complete: complete.peek(),
        filled: state.value.peek().length > 0,
        focused: focused.peek(),
        activeIndex: activeIndex.peek(),
        touched: touched.peek(),
        dirty: dirty.peek(),
        masked: Boolean(options.mask),
        disabled: disabled(),
        readOnly: readOnly(),
        required: required(),
      },
      parts: [
        { name: "root", role: "group", defaultElement: "div", required: true },
        { name: "input", defaultElement: "input", required: true },
        { name: "separator", role: "separator", defaultElement: "div" },
        { name: "hidden-input", defaultElement: "input", required: Boolean(name) },
      ],
      actions: [
        { name: "setValue", description: "Set and normalize the logical one-time code.", sideEffects: "write", reasons: ["input-change", "input-paste", "programmatic"] },
        { name: "clear", description: "Clear one slot or the whole code.", sideEffects: "write", reasons: ["input-clear", "keyboard"] },
        { name: "focus", description: "Focus a one-time-code slot.", sideEffects: "none", reasons: ["keyboard", "programmatic"] },
        { name: "reset", description: "Restore the initial one-time code.", sideEffects: "write", reasons: ["reset"] },
      ],
      keyboard: {
        ArrowLeft: "Move one logical slot according to text direction.",
        ArrowRight: "Move one logical slot according to text direction.",
        Home: "Focus the first slot.",
        End: "Focus the last slot.",
        Backspace: "Clear the current slot, or the previous slot when empty.",
        Delete: "Clear the current slot.",
      },
    }),
  };
  return controller;
}

export type SliderValue = number | readonly number[];
export type SliderCollisionBehavior = "push" | "swap" | "none";
export type SliderChangeReason = "pointer" | "keyboard" | "input" | "reset" | "programmatic";

export interface SliderOptions {
  id: string;
  name?: string;
  form?: string;
  value?: FieldReadable<SliderValue>;
  defaultValue?: SliderValue;
  field?: FieldController<SliderValue>;
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  minGap?: number;
  thumbCollisionBehavior?: SliderCollisionBehavior;
  orientation?: "horizontal" | "vertical";
  direction?: Direction | "auto";
  locale?: Intl.LocalesArgument;
  format?: Intl.NumberFormatOptions;
  disabled?: FieldReadable<boolean>;
  readOnly?: FieldReadable<boolean>;
  required?: FieldReadable<boolean>;
  onValueChange?: (value: SliderValue, details: ChangeDetails<SliderChangeReason>) => void;
  onValueCommitted?: (value: SliderValue, details: ChangeDetails<SliderChangeReason>) => void;
}

export interface SliderThumbPartOptions {
  /** An explicit accessible name for this thumb, especially useful for ranges. */
  ariaLabel?: string;
  /** An explicit label relationship; takes precedence over the shared Slider.Label. */
  ariaLabelledBy?: string;
  /** A static human-readable value exposed to assistive technology. */
  ariaValueText?: string;
  /** Produces an accessible name from the stable SSR thumb index. */
  getAriaLabel?: (index: number) => string;
  /** Produces human-readable value text from the formatted and numeric values. */
  getAriaValueText?: (formattedValue: string, value: number, index: number) => string;
}

export interface SliderController {
  readonly id: string;
  readonly range: boolean;
  readonly value: Computed<SliderValue>;
  readonly values: Computed<readonly number[]>;
  readonly activeThumb: ReactiveSignal<number>;
  readonly dragging: ReactiveSignal<boolean>;
  readonly focused: ReactiveSignal<boolean>;
  readonly touched: ReactiveSignal<boolean>;
  readonly dirty: Computed<boolean>;
  setValue(value: SliderValue, reason?: SliderChangeReason, event?: Event): boolean;
  setThumb(index: number, value: number, reason?: SliderChangeReason, event?: Event): boolean;
  commit(reason?: SliderChangeReason, event?: Event): boolean;
  reset(event?: Event): boolean;
  root(): Record<string, unknown>;
  label(): Record<string, unknown>;
  valueText(): Record<string, unknown>;
  control(): Record<string, unknown>;
  track(): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  thumb(index: number, options?: SliderThumbPartOptions): Record<string, unknown>;
  input(index: number): Record<string, unknown>;
  manifest(): UiManifest;
}

/** Single and multi-thumb slider state with native range-input form projection. */
export function createSlider(options: SliderOptions): SliderController {
  const id = requireId(options.id, "Slider");
  const labelPresence = createPartPresence(`${id}.labelPresence`);
  const direction = options.direction ?? useDirection();
  if (options.field && Object.prototype.hasOwnProperty.call(options, "value")) {
    throw new TypeError("Slider cannot use both field and value control.");
  }
  const min = optionalFinite(options.min, "Slider min") ?? 0;
  const max = optionalFinite(options.max, "Slider max") ?? 100;
  if (max <= min) throw new TypeError("Slider max must be greater than min.");
  const step = positiveFinite(options.step ?? 1, "Slider step");
  const largeStep = positiveFinite(options.largeStep ?? step * 10, "Slider largeStep");
  const minGap = nonNegative(options.minGap ?? 0, "Slider minGap");
  const collision = options.thumbCollisionBehavior ?? "push";
  if (!(["push", "swap", "none"] as const).includes(collision)) throw new TypeError(`Invalid slider collision behavior: ${collision}`);
  const orientation = options.orientation ?? "horizontal";
  const sourceInitial = options.field
    ? options.field.value.peek()
    : options.defaultValue
      ?? (Object.prototype.hasOwnProperty.call(options, "value") ? read(options.value as FieldReadable<SliderValue>) : min);
  const range = Array.isArray(sourceInitial);
  const initial = normalizeSliderValues(sourceInitial, min, max, step, minGap, undefined);
  if (minGap * Math.max(0, initial.length - 1) > max - min) {
    throw new TypeError("Slider minGap is too large for the value count and range.");
  }
  const numberFormat = new Intl.NumberFormat(options.locale, options.format);
  const name = options.name ?? options.field?.name;
  const fieldPart = options.field?.control({
    id: options.field.controlId,
    format: (fieldValue) => Array.isArray(fieldValue)
      ? String(fieldValue[0] ?? "")
      : String(fieldValue),
  });
  const external = (): readonly number[] => {
    const value = options.field
      ? options.field.value.value
      : read(options.value as FieldReadable<SliderValue>);
    if (Array.isArray(value) !== range) throw new TypeError("Controlled slider value must preserve its single or range shape.");
    return normalizeSliderValues(value, min, max, step, minGap, initial.length);
  };
  const state = createControllableState<readonly number[], SliderChangeReason>({
    ...(options.field || Object.prototype.hasOwnProperty.call(options, "value") ? { value: external } : {}),
    defaultValue: initial,
    equals: numberArrayEqual,
    onValueChange(next, details) {
      const shaped = shapeSliderValue(next, range);
      options.onValueChange?.(shaped, details);
      if (!details.canceled && options.field && !options.field.setValue(
        shaped,
        details.reason === "reset" ? "reset" : "input",
        details.event,
      )) details.cancel();
    },
    name: `${id}.values`,
  });
  const value = computed(() => shapeSliderValue(state.value.value, range), { name: `${id}.value` });
  const activeThumb = signal(0, { name: `${id}.activeThumb` });
  const dragging = signal(false, { name: `${id}.dragging` });
  const focused = signal(false, { name: `${id}.focused` });
  const touched = signal(false, { name: `${id}.touched` });
  const dirty = computed(() => !numberArrayEqual(state.value.value, initial), { name: `${id}.dirty` });
  const disabled = () => readBoolean(options.disabled) || readPartFlag(options.field, "disabled");
  const readOnly = () => readBoolean(options.readOnly) || readPartFlag(options.field, "readOnly");
  const required = () => readBoolean(options.required) || readPartFlag(options.field, "required");
  const blocked = () => disabled() || readOnly();
  const thumbId = (index: number) => index === 0 && options.field
    ? options.field.controlId
    : `${id}-thumb-${index}`;
  let pointer: { id: number; target: Element | null; changed: boolean } | null = null;
  let controller!: SliderController;
  let lastResetEvent: Event | undefined;

  const setValue = (next: SliderValue, reason: SliderChangeReason = "programmatic", event?: Event): boolean => {
    if (blocked() && reason !== "reset" && reason !== "programmatic") return false;
    if (Array.isArray(next) !== range) throw new TypeError("Slider value must preserve its single or range shape.");
    const normalized = normalizeSliderValues(next, min, max, step, minGap, initial.length);
    return state.set(normalized, reason, event);
  };
  const setThumb = (index: number, next: number, reason: SliderChangeReason = "programmatic", event?: Event): boolean => {
    requireIndex(index, initial.length, "Slider thumb");
    if (blocked() && reason !== "programmatic") return false;
    if (!Number.isFinite(next)) throw new TypeError("Slider thumb value must be a finite number.");
    const moved = moveSliderThumb(state.value.peek(), index, snapNumber(next, step, min, max), collision, minGap, min, max);
    const changed = state.set(Object.freeze(moved.values), reason, event);
    // A swap changes which stable thumb index owns the interaction. Keep that
    // ownership transition atomic with the cancellable value request so a
    // rejected change cannot redirect the next keyboard or pointer update.
    if (changed) activeThumb.value = moved.index;
    return changed;
  };
  const commit = (reason: SliderChangeReason = "programmatic", event?: Event) => {
    const details = createChangeDetails(reason, event);
    options.onValueCommitted?.(value.peek(), details);
    options.field?.touch();
    return !details.canceled;
  };
  const reset = (event?: Event) => {
    if (isDuplicateResetEvent(event, lastResetEvent) || (event && isEventCanceled(event))) return false;
    if (event) {
      lastResetEvent = event;
      queueMicrotask(() => { if (lastResetEvent === event) lastResetEvent = undefined; });
    }
    const alreadyInitial = numberArrayEqual(state.value.peek(), initial);
    const changed = state.reset("reset", event);
    if (!changed && !alreadyInitial) return false;
    batch(() => {
      activeThumb.value = 0;
      dragging.value = false;
      focused.value = false;
      touched.value = false;
    });
    options.field?.setFocused(false);
    options.field?.touch(false);
    return changed;
  };
  const percentage = (entry: number) => (entry - min) / (max - min) * 100;
  const sharedState = () => ({
    "data-orientation": orientation,
    "data-disabled": () => disabled() ? "" : undefined,
    "data-readonly": () => readOnly() ? "" : undefined,
    "data-required": () => required() ? "" : undefined,
    "data-dragging": () => dragging.value ? "" : undefined,
    "data-focused": () => focused.value ? "" : undefined,
    "data-dirty": () => (options.field?.dirty.value ?? dirty.value) ? "" : undefined,
    "data-touched": () => (options.field?.touched.value ?? touched.value) ? "" : undefined,
    "data-valid": () => options.field?.valid.value === true ? "" : undefined,
    "data-invalid": () => options.field?.valid.value === false ? "" : undefined,
  });
  const eventValue = (event: PointerEvent): number => {
    const element = event.currentTarget as Element & { getBoundingClientRect(): DOMRect };
    const rect = element.getBoundingClientRect();
    let ratio: number;
    if (orientation === "vertical") ratio = rect.height <= 0 ? 0 : (rect.bottom - event.clientY) / rect.height;
    else {
      ratio = rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width;
      if (resolveDirection(direction, element) === "rtl") ratio = 1 - ratio;
    }
    return snapNumber(min + Math.max(0, Math.min(1, ratio)) * (max - min), step, min, max);
  };
  const beginPointer = (event: PointerEvent) => {
    if (blocked() || event.defaultPrevented || event.button !== 0) return;
    const next = eventValue(event);
    const index = closestThumb(state.value.peek(), next, activeThumb.peek());
    activeThumb.value = index;
    pointer = { id: event.pointerId, target: event.currentTarget as Element, changed: false };
    dragging.value = true;
    (pointer.target as Element & { setPointerCapture?: (pointerId: number) => void }).setPointerCapture?.(event.pointerId);
    pointer.changed = setThumb(index, next, "pointer", event);
    const selected = (event.currentTarget as Element | null)?.ownerDocument?.getElementById(thumbId(activeThumb.peek())) as HTMLElement | null;
    selected?.focus?.();
    event.preventDefault();
  };
  const movePointer = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId || blocked()) return;
    if (setThumb(activeThumb.peek(), eventValue(event), "pointer", event)) pointer.changed = true;
    event.preventDefault();
  };
  const endPointer = (event: PointerEvent, canceled = false) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const changed = pointer.changed;
    (pointer.target as Element & { releasePointerCapture?: (pointerId: number) => void }).releasePointerCapture?.(event.pointerId);
    pointer = null;
    dragging.value = false;
    if (!canceled && changed) {
      touched.value = true;
      commit("pointer", event);
    }
  };

  controller = {
    id,
    range,
    value,
    values: state.value,
    activeThumb,
    dragging,
    focused,
    touched,
    dirty,
    setValue,
    setThumb,
    commit,
    reset,
    root: () => ({ id: `${id}-root`, dir: direction, "data-clank-part": "root", ...sharedState() }),
    label: () => ({
      id: `${id}-label`,
      htmlFor: thumbId(0),
      "data-clank-part": "label",
      ...sharedState(),
      use: labelPresence.register(),
    }),
    valueText: () => ({
      "aria-live": "off",
      "data-clank-part": "value",
      "data-value": () => state.value.value.join(" "),
      ...sharedState(),
    }),
    control: () => ({
      id: `${id}-control`,
      role: "group",
      "data-clank-part": "control",
      "aria-labelledby": () => readPartProperty(fieldPart, "aria-labelledby")
        ?? (labelPresence.present.value ? `${id}-label` : undefined),
      "aria-describedby": fieldPart?.["aria-describedby"],
      "aria-errormessage": fieldPart?.["aria-errormessage"],
      "aria-invalid": fieldPart?.["aria-invalid"],
      style: {
        "--clank-slider-min": min,
        "--clank-slider-max": max,
        touchAction: "none",
        userSelect: "none",
      },
      ...sharedState(),
      onPointerDown: beginPointer,
      onPointerMove: movePointer,
      onPointerUp: (event: PointerEvent) => endPointer(event),
      onPointerCancel: (event: PointerEvent) => endPointer(event, true),
      onLostPointerCapture: (event: PointerEvent) => endPointer(event, true),
    }),
    track: () => ({ id: `${id}-track`, "data-clank-part": "track", ...sharedState() }),
    indicator: () => ({
      "aria-hidden": true,
      "data-clank-part": "indicator",
      style: {
        "--clank-slider-start": () => `${range ? percentage(state.value.value[0]!) : 0}%`,
        "--clank-slider-end": () => `${percentage(state.value.value.at(-1)!)}%`,
      },
      ...sharedState(),
    }),
    thumb(index, thumbOptions = {}) {
      requireIndex(index, initial.length, "Slider thumb");
      const current = () => state.value.value[index]!;
      const formatted = () => numberFormat.format(current());
      const explicitLabel = thumbOptions.ariaLabel ?? thumbOptions.getAriaLabel?.(index);
      return {
        id: thumbId(index),
        role: "slider",
        "data-clank-part": "thumb",
        tabIndex: () => disabled() ? -1 : 0,
        ...(explicitLabel ? { "aria-label": explicitLabel } : {}),
        "aria-labelledby": () => thumbOptions.ariaLabelledBy
          ?? (explicitLabel
            ? undefined
            : readPartProperty(fieldPart, "aria-labelledby") ?? (labelPresence.present.value ? `${id}-label` : undefined)),
        "aria-describedby": fieldPart?.["aria-describedby"],
        "aria-errormessage": fieldPart?.["aria-errormessage"],
        "aria-invalid": fieldPart?.["aria-invalid"],
        "aria-orientation": orientation,
        "aria-valuemin": min,
        "aria-valuemax": max,
        "aria-valuenow": current,
        "aria-valuetext": () => thumbOptions.getAriaValueText?.(formatted(), current(), index)
          ?? thumbOptions.ariaValueText
          ?? formatted(),
        "aria-disabled": () => disabled() || undefined,
        "aria-readonly": () => readOnly() || undefined,
        "data-index": index,
        "data-active": () => activeThumb.value === index ? "" : undefined,
        style: {
          "--clank-slider-value": current,
          "--clank-slider-percentage": () => `${percentage(current())}%`,
        },
        ...sharedState(),
        onFocus: () => { activeThumb.value = index; focused.value = true; options.field?.setFocused(true); },
        onBlur: (event: FocusEvent) => {
          const root = (event.currentTarget as Element)?.ownerDocument?.getElementById(`${id}-root`);
          if (!root || !event.relatedTarget || !root.contains(event.relatedTarget as Node)) {
            focused.value = false;
            options.field?.setFocused(false);
            touched.value = true;
            options.field?.touch();
            if (shouldValidateOnBlur(options.field)) void options.field!.validate("blur", event);
          }
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (blocked() || event.defaultPrevented) return;
          const rtl = orientation === "horizontal" && resolveDirection(direction, event.currentTarget as Element) === "rtl";
          let next: number | undefined;
          const amount = event.shiftKey || event.key === "PageUp" || event.key === "PageDown" ? largeStep : step;
          if (event.key === "ArrowRight") next = current() + (rtl ? -amount : amount);
          else if (event.key === "ArrowLeft") next = current() + (rtl ? amount : -amount);
          else if (event.key === "ArrowUp" || event.key === "PageUp") next = current() + amount;
          else if (event.key === "ArrowDown" || event.key === "PageDown") next = current() - amount;
          else if (event.key === "Home") next = min;
          else if (event.key === "End") next = max;
          else return;
          const changed = setThumb(index, next, "keyboard", event);
          if (changed) commit("keyboard", event);
          event.preventDefault();
        },
      };
    },
    input(index) {
      requireIndex(index, initial.length, "Slider input");
      const current = () => state.value.value[index]!;
      const use = (element: Element): Cleanup => {
        const input = element as HTMLInputElement;
        const synchronize = () => {
          input.value = String(current());
          input.disabled = disabled();
          input.required = required();
        };
        const stop = effect(synchronize);
        const stopField = index === 0 ? mountPartUse(fieldPart, input) : undefined;
        const form = input.form;
        const onReset = (resetEvent: Event) => { reset(resetEvent); queueMicrotask(synchronize); };
        form?.addEventListener("reset", onReset);
        return () => { stopField?.(); stop(); form?.removeEventListener("reset", onReset); };
      };
      return {
        id: `${id}-input-${index}`,
        type: "range",
        "data-clank-part": "input",
        ...(name ? { name } : {}),
        ...(options.form ? { form: options.form } : {}),
        min,
        max,
        step,
        value: current,
        defaultValue: initial[index],
        disabled,
        required,
        hidden: true,
        tabIndex: -1,
        "aria-hidden": true,
        onInvalid: index === 0 ? fieldPart?.onInvalid : undefined,
        "data-clank-native-control": "slider",
        onInput: (event: Event) => {
          if (event.defaultPrevented) return;
          const input = event.currentTarget as HTMLInputElement;
          if (setThumb(index, input.valueAsNumber, "input", event)) commit("input", event);
          else input.value = String(current());
        },
        use,
      };
    },
    manifest: () => createUiManifest({
      component: "Slider",
      id,
      state: {
        value: serializableValue(value.peek()),
        values: [...state.value.peek()],
        range,
        min,
        max,
        step,
        largeStep,
        minGap,
        collision,
        orientation,
        activeThumb: activeThumb.peek(),
        dragging: dragging.peek(),
        focused: focused.peek(),
        touched: touched.peek(),
        dirty: dirty.peek(),
        disabled: disabled(),
        readOnly: readOnly(),
      },
      parts: [
        { name: "root", defaultElement: "div", required: true },
        { name: "label", defaultElement: "label" },
        { name: "value", defaultElement: "span" },
        { name: "control", role: "group", defaultElement: "div", required: true },
        { name: "track", defaultElement: "div", required: true },
        { name: "indicator", defaultElement: "div" },
        { name: "thumb", role: "slider", defaultElement: "div", required: true },
        { name: "input", defaultElement: "input", required: Boolean(name) },
      ],
      actions: [
        { name: "setValue", description: "Replace the slider value or range.", sideEffects: "write", reasons: ["programmatic", "input", "reset"] },
        { name: "setThumb", description: "Move a thumb using the configured collision policy.", sideEffects: "write", reasons: ["pointer", "keyboard", "input", "programmatic"] },
        { name: "commit", description: "Commit the current slider value.", sideEffects: "write", reasons: ["pointer", "keyboard", "input"] },
        { name: "reset", description: "Restore the initial slider value.", sideEffects: "write", reasons: ["reset"] },
      ],
      keyboard: {
        ArrowLeft: "Move by step, respecting RTL.",
        ArrowRight: "Move by step, respecting RTL.",
        ArrowUp: "Increase by step.",
        ArrowDown: "Decrease by step.",
        PageUp: "Increase by largeStep.",
        PageDown: "Decrease by largeStep.",
        Home: "Move to minimum.",
        End: "Move to maximum.",
      },
    }),
  };
  return controller;
}

function requireId(value: string, kind: string): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new TypeError(`${kind} id must start with a letter and contain only letters, numbers, _, ., :, or -.`);
  }
  return id;
}

function requireFieldName(value: string): string {
  const name = String(value ?? "").trim();
  if (!name || ["__proto__", "prototype", "constructor"].includes(name)) {
    throw new TypeError("Form field names must be non-empty and safe object keys.");
  }
  return name;
}

const SUPPORTED_INPUT_TYPES = new Set<InputType>([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
]);

function requireInputType(value: string): InputType {
  const normalized = String(value ?? "").toLowerCase() as InputType;
  if (!SUPPORTED_INPUT_TYPES.has(normalized)) {
    throw new TypeError(
      `Input type ${JSON.stringify(value)} is not supported. Use a text-like type (text, search, email, tel, url, or password) or its dedicated Clank control.`,
    );
  }
  return normalized;
}

function requireValidationMode(value: string): ValidationMode {
  if (value !== "onSubmit" && value !== "onBlur" && value !== "onChange") {
    throw new TypeError(`Invalid validationMode: ${JSON.stringify(value)}.`);
  }
  return value;
}

function shouldValidateOnBlur(field: FieldController<any> | undefined): boolean {
  return field?.validationMode === "onBlur" || field?.validationMode === "onChange";
}

function isDuplicateResetEvent(event: Event | undefined, previous: Event | undefined): boolean {
  return event !== undefined && event === previous;
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

function readPartProperty(part: Record<string, unknown> | undefined, key: string): unknown {
  const value = part?.[key];
  return typeof value === "function" ? (value as () => unknown)() : value;
}

function relationshipPartUse(registry: Map<string, number>, id: string): (element: Element) => Cleanup {
  const register = () => registry.set(id, (registry.get(id) ?? 0) + 1);
  const unregister = () => {
    const count = registry.get(id) ?? 0;
    if (count <= 1) registry.delete(id);
    else registry.set(id, count - 1);
  };
  // Register during part creation so SSR can emit relationships before mount.
  register();
  let registered = true;
  let mounts = 0;
  return () => {
    mounts++;
    if (!registered) {
      register();
      registered = true;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      mounts = Math.max(0, mounts - 1);
      if (mounts === 0 && registered) {
        unregister();
        registered = false;
      }
    };
  };
}

function disabledFieldItemUse(disabled: () => boolean): (element: Element) => Cleanup {
  return (element) => {
    type Disableable = Element & { disabled: boolean };
    const managed = new Map<Disableable, boolean>();
    const descendants = (): Disableable[] => Array.from(
      element.querySelectorAll("button, fieldset, input, optgroup, option, select, textarea"),
    ).filter((candidate): candidate is Disableable => "disabled" in candidate);
    const restore = () => {
      for (const [candidate, original] of managed) candidate.disabled = original;
      managed.clear();
    };
    const synchronize = () => {
      if (!disabled()) {
        restore();
        return;
      }
      for (const candidate of descendants()) {
        if (candidate.disabled || managed.has(candidate)) continue;
        managed.set(candidate, candidate.disabled);
        candidate.disabled = true;
      }
    };
    const stop = effect(synchronize);
    const Observer = element.ownerDocument?.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(synchronize) : undefined;
    observer?.observe(element, { childList: true, subtree: true });
    return () => {
      stop();
      observer?.disconnect();
      restore();
    };
  };
}

function read<Value>(value: FieldReadable<Value>): Value {
  return typeof value === "function" ? (value as () => Value)() : value;
}

function readBoolean(value: FieldReadable<boolean> | undefined): boolean {
  return value === undefined ? false : Boolean(read(value));
}

function readPartFlag(field: FieldController<any> | undefined, key: string): boolean {
  if (!field) return false;
  if (key === "disabled") return field.disabled.value;
  if (key === "readOnly") return field.readOnly.value;
  if (key === "required") return field.required.value;
  return false;
}

function cloneValue<Value>(value: Value): Value {
  if (typeof structuredClone !== "function") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameValue(entry, right[index]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function valueIsFilled(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

interface FieldStateReaders {
  disabled(): boolean;
  readOnly(): boolean;
  required(): boolean;
  valid(): boolean | null;
  dirty(): boolean;
  touched(): boolean;
  filled(): boolean;
  focused(): boolean;
  pending(): boolean;
}

function fieldStateProps(state: FieldStateReaders): Record<string, unknown> {
  return {
    "data-disabled": () => state.disabled() ? "" : undefined,
    "data-readonly": () => state.readOnly() ? "" : undefined,
    "data-required": () => state.required() ? "" : undefined,
    "data-valid": () => state.valid() === true ? "" : undefined,
    "data-invalid": () => state.valid() === false ? "" : undefined,
    "data-dirty": () => state.dirty() ? "" : undefined,
    "data-touched": () => state.touched() ? "" : undefined,
    "data-filled": () => state.filled() ? "" : undefined,
    "data-focused": () => state.focused() ? "" : undefined,
    "data-pending": () => state.pending() ? "" : undefined,
  };
}

function emptyValidity(): Readonly<Record<NativeValidityKey, boolean>> {
  return Object.freeze({
    badInput: false,
    customError: false,
    patternMismatch: false,
    rangeOverflow: false,
    rangeUnderflow: false,
    stepMismatch: false,
    tooLong: false,
    tooShort: false,
    typeMismatch: false,
    valueMissing: false,
  });
}

function validityEqual(
  left: Readonly<Record<NativeValidityKey, boolean>>,
  right: Readonly<Record<NativeValidityKey, boolean>>,
): boolean {
  return VALIDITY_KEYS.every((key) => left[key] === right[key]);
}

function hasNativeError(validity: Readonly<Record<NativeValidityKey, boolean>>): boolean {
  return VALIDITY_KEYS.some((key) => validity[key]);
}

function nativeValiditySnapshot(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  required: boolean,
  value: unknown,
): Readonly<Record<NativeValidityKey, boolean>> {
  const output = { ...emptyValidity() } as Record<NativeValidityKey, boolean>;
  const validity = element?.validity;
  if (validity) {
    for (const key of VALIDITY_KEYS) output[key] = Boolean(validity[key]);
  } else if (required && !valueIsFilled(value)) output.valueMissing = true;
  return Object.freeze({ ...output });
}

function isPromiseLike(value: unknown): value is PromiseLike<FieldValidationResult> {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function");
}

function normalizeValidationResult(
  result: FieldValidationResult,
  nativeValidity: Readonly<Record<NativeValidityKey, boolean>>,
  nativeMessage?: string,
): { errors: readonly string[]; validity?: NativeValidityKey } {
  let errors: readonly string[] = [];
  let validity: NativeValidityKey | undefined;
  if (result === false) errors = ["This field is invalid."];
  else if (typeof result === "string" || Array.isArray(result)) errors = errorList(result);
  else if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as { errors?: string | readonly string[]; validity?: NativeValidityKey };
    errors = errorList(record.errors);
    validity = record.validity;
  }
  if (errors.length === 0 && hasNativeError(nativeValidity)) {
    errors = [nativeMessage?.trim() || "This field is invalid."];
  }
  return { errors, ...(validity ? { validity } : {}) };
}

function errorList(value: string | readonly string[] | null | undefined): readonly string[] {
  if (value === null || value === undefined) return [];
  return uniqueStrings((typeof value === "string" ? [value] : value).map(String));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((entry) => entry.trim()).filter(Boolean))]);
}

function errorMatches(
  match: FieldErrorPartOptions["match"],
  validity: Readonly<Record<NativeValidityKey, boolean>>,
  validationErrors: readonly string[],
  serverErrors: readonly string[],
): boolean {
  if (match === false) return false;
  if (match === true || match === undefined) return hasNativeError(validity) || validationErrors.length > 0 || serverErrors.length > 0;
  const entries = (Array.isArray(match) ? match : [match]) as readonly (NativeValidityKey | "custom")[];
  return entries.some((entry) => entry === "custom"
    ? validationErrors.length > 0 || serverErrors.length > 0
    : validity[entry]);
}

function displayValue(value: unknown): string | number | readonly string[] {
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (Array.isArray(value)) return value.map(String);
  return value === null || value === undefined ? "" : String(value);
}

function serializableValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function abortError(message: string): Error {
  if (typeof DOMException !== "undefined") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number.`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number.`);
  return value;
}

function optionalFinite(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  return value;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function requireIndex(index: number, length: number, label: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${label} index must be an integer from 0 through ${length - 1}.`);
  }
  return index;
}

function createFormSubmitDetails(event: Event | undefined, formData: FormData | null): FormFacadeSubmitDetails {
  let canceled = false;
  return Object.freeze({
    ...(event ? { event } : {}),
    formData,
    get canceled() { return canceled; },
    cancel() { canceled = true; },
  });
}

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (typeof css?.escape === "function") return css.escape(value);
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `);
}

function attributeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type NumberParseResult = { kind: "empty" } | { kind: "invalid" } | { kind: "number"; value: number };

function createNumberParser(locale?: Intl.LocalesArgument, format?: Intl.NumberFormatOptions): { parse(value: string): NumberParseResult } {
  const parts = new Intl.NumberFormat(locale, { ...format, useGrouping: true }).formatToParts(-12345.6);
  const group = parts.find((entry) => entry.type === "group")?.value ?? ",";
  const decimal = parts.find((entry) => entry.type === "decimal")?.value ?? ".";
  const minus = parts.find((entry) => entry.type === "minusSign")?.value ?? "-";
  const plusParts = new Intl.NumberFormat(locale, { ...format, signDisplay: "always" }).formatToParts(1);
  const plus = plusParts.find((entry) => entry.type === "plusSign")?.value ?? "+";
  const digits = new Map<string, string>();
  const digitFormatter = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  for (let index = 0; index < 10; index++) digits.set(digitFormatter.format(index), String(index));
  const percent = format?.style === "percent";
  return {
    parse(input) {
      let value = String(input).trim();
      if (!value) return { kind: "empty" };
      for (const [localized, ascii] of digits) value = value.split(localized).join(ascii);
      value = value.split(group).join("");
      value = value.split(decimal).join(".");
      value = value.split(minus).join("-");
      value = value.split(plus).join("+");
      value = value.replace(/[\s\u00a0\u202f]/g, "");
      value = value.replace(/[^0-9eE+\-.]/g, "");
      if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return { kind: "invalid" };
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { kind: "invalid" };
      return { kind: "number", value: percent ? parsed / 100 : parsed };
    },
  };
}

function normalizeNullableNumber(
  value: number | null,
  min: number | undefined,
  max: number | undefined,
  allowOutOfRange: boolean,
  label: string,
): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number or null.`);
  if (allowOutOfRange) return value;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

function formatNumber(value: number | null, formatter: Intl.NumberFormat): string {
  return value === null ? "" : formatter.format(value);
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes("e")) {
    const [coefficient, exponentText] = text.split("e");
    return Math.max(0, (coefficient!.split(".")[1]?.length ?? 0) - Number(exponentText));
  }
  return text.split(".")[1]?.length ?? 0;
}

function addWithPrecision(left: number, right: number): number {
  const precision = Math.min(14, Math.max(decimalPlaces(left), decimalPlaces(right)));
  return Number((left + right).toFixed(precision));
}

function snapNumber(
  value: number,
  step: number | "any",
  min?: number,
  max?: number,
): number {
  let next = value;
  if (step !== "any") {
    const origin = min ?? 0;
    const precision = Math.min(14, Math.max(decimalPlaces(step), decimalPlaces(origin)) + 2);
    next = Number((origin + Math.round((value - origin) / step) * step).toFixed(precision));
  }
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
}

function normalizeOtp(
  raw: string,
  length: number,
  validation: OtpValidationType,
  normalize?: (value: string) => string,
): { value: string; rejected: string } {
  const source = String(raw ?? "").replace(/\s/g, "");
  let first = "";
  let rejected = "";
  for (const character of [...source]) {
    if (otpCharacterValid(character, validation)) first += character;
    else rejected += character;
  }
  const transformed = normalize ? String(normalize(first)) : first;
  let output = "";
  for (const character of [...transformed.replace(/\s/g, "")]) {
    if (otpCharacterValid(character, validation)) output += character;
    else rejected += character;
    if ([...output].length >= length) break;
  }
  return { value: [...output].slice(0, length).join(""), rejected };
}

function otpCharacters(value: string): string[] {
  return [...value];
}

function otpCharacterValid(character: string, validation: OtpValidationType): boolean {
  if (validation === "numeric") return /^[0-9]$/.test(character);
  if (validation === "alpha") return /^[A-Za-z]$/.test(character);
  if (validation === "alphanumeric") return /^[A-Za-z0-9]$/.test(character);
  if (typeof validation === "function") return Boolean(validation(character));
  validation.lastIndex = 0;
  const accepted = validation.test(character);
  validation.lastIndex = 0;
  return accepted;
}

function numberArrayEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((entry, index) => Object.is(entry, right[index]));
}

function normalizeSliderValues(
  value: SliderValue,
  min: number,
  max: number,
  step: number,
  minGap: number,
  expectedLength: number | undefined,
): readonly number[] {
  const source = Array.isArray(value) ? [...value] : [value as number];
  if (source.length === 0) throw new TypeError("Slider range values cannot be empty.");
  if (expectedLength !== undefined && source.length !== expectedLength) {
    throw new TypeError(`Slider value must contain exactly ${expectedLength} value${expectedLength === 1 ? "" : "s"}.`);
  }
  if (minGap * Math.max(0, source.length - 1) > max - min) throw new TypeError("Slider minGap cannot fit all values in the range.");
  const output = source.map((entry) => {
    if (!Number.isFinite(entry)) throw new TypeError("Slider values must be finite numbers.");
    return snapNumber(entry, step, min, max);
  }).sort((left, right) => left - right);
  for (let index = 1; index < output.length; index++) {
    output[index] = Math.max(output[index]!, addWithPrecision(output[index - 1]!, minGap));
  }
  if (output.at(-1)! > max) {
    output[output.length - 1] = max;
    for (let index = output.length - 2; index >= 0; index--) {
      output[index] = Math.min(output[index]!, addWithPrecision(output[index + 1]!, -minGap));
    }
  }
  return Object.freeze(output);
}

function shapeSliderValue(values: readonly number[], range: boolean): SliderValue {
  return range ? Object.freeze([...values]) : values[0]!;
}

function moveSliderThumb(
  current: readonly number[],
  index: number,
  value: number,
  collision: SliderCollisionBehavior,
  gap: number,
  min: number,
  max: number,
): { values: number[]; index: number } {
  const output = [...current];
  if (collision === "swap") {
    output[index] = Math.min(max, Math.max(min, value));
    const token = output[index]!;
    output.sort((left, right) => left - right);
    let nextIndex = output.indexOf(token);
    if (nextIndex < 0) nextIndex = index;
    for (let next = 1; next < output.length; next++) {
      output[next] = Math.max(output[next]!, addWithPrecision(output[next - 1]!, gap));
    }
    if (output.at(-1)! > max) {
      output[output.length - 1] = max;
      for (let previous = output.length - 2; previous >= 0; previous--) {
        output[previous] = Math.min(output[previous]!, addWithPrecision(output[previous + 1]!, -gap));
      }
      nextIndex = Math.max(0, Math.min(output.length - 1, nextIndex));
    }
    return { values: output, index: nextIndex };
  }
  if (collision === "none") {
    const lower = index === 0 ? min : addWithPrecision(output[index - 1]!, gap);
    const upper = index === output.length - 1 ? max : addWithPrecision(output[index + 1]!, -gap);
    output[index] = Math.min(upper, Math.max(lower, value));
    return { values: output, index };
  }
  const lowerLimit = min + gap * index;
  const upperLimit = max - gap * (output.length - 1 - index);
  const target = Math.min(upperLimit, Math.max(lowerLimit, value));
  const movingForward = target >= output[index]!;
  output[index] = target;
  if (movingForward) {
    for (let next = index + 1; next < output.length; next++) {
      output[next] = Math.max(output[next]!, addWithPrecision(output[next - 1]!, gap));
    }
  } else {
    for (let previous = index - 1; previous >= 0; previous--) {
      output[previous] = Math.min(output[previous]!, addWithPrecision(output[previous + 1]!, -gap));
    }
  }
  return { values: output, index };
}

function closestThumb(values: readonly number[], value: number, preferred: number): number {
  let index = 0;
  let distance = Infinity;
  for (let candidate = 0; candidate < values.length; candidate++) {
    const nextDistance = Math.abs(values[candidate]! - value);
    if (nextDistance < distance || (nextDistance === distance && candidate === preferred)) {
      index = candidate;
      distance = nextDistance;
    }
  }
  return index;
}
