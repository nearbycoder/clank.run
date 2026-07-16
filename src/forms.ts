import { batch, computed, signal, type Computed, type ReactiveSignal } from "./core.ts";
import type { Schema, ValidationIssue } from "./ai.ts";

export type FormValues = Record<string, unknown>;
export type FormKey<Values extends FormValues> = Extract<keyof Values, string>;
export type FormStatus = "idle" | "invalid" | "submitting" | "success" | "error";
export type FormErrorValue = string | readonly string[] | undefined;
export type FormErrorMap<Values extends FormValues> = Partial<
  Record<FormKey<Values> | "_form", FormErrorValue>
>;

export interface FormValidationContext {
  reason: "input" | "blur" | "submit" | "manual";
}

export interface FormSubmitContext<Values extends FormValues> {
  signal: AbortSignal;
  setErrors(errors: FormErrorMap<Values>): void;
  reset(values?: Values): void;
}

export interface CreateFormOptions<Values extends FormValues, Result = unknown> {
  id?: string;
  initial: Values;
  schema?: Schema<Values>;
  validate?: (
    values: Values,
    context: FormValidationContext,
  ) => FormErrorMap<Values> | void;
  onSubmit?: (
    values: Values,
    context: FormSubmitContext<Values>,
  ) => Result | Promise<Result>;
  validateOn?: "submit" | "blur" | "input";
  concurrency?: "replace" | "ignore";
  resetOnSuccess?: boolean;
  focusFirstError?: boolean;
}

export interface FormControlOptions<Value> {
  id?: string;
  type?: string;
  agentId?: string;
  agentLabel?: string;
  describedBy?: string;
  parse?: (element: HTMLInputElement) => Value;
  format?: (value: Value) => string | number;
}

export interface FormTextAreaOptions<Value> {
  id?: string;
  agentId?: string;
  agentLabel?: string;
  describedBy?: string;
  parse?: (element: HTMLTextAreaElement) => Value;
  format?: (value: Value) => string;
}

export interface FormSelectOptions<Value> {
  id?: string;
  agentId?: string;
  agentLabel?: string;
  describedBy?: string;
  multiple?: boolean;
  parse?: (element: HTMLSelectElement) => Value;
  format?: (value: Value) => string | readonly string[];
}

export interface FormCheckboxOptions {
  id?: string;
  agentId?: string;
  agentLabel?: string;
  describedBy?: string;
}

export interface FormRadioOptions<Value> extends FormCheckboxOptions {
  value: Value;
  serialize?: (value: Value) => string;
}

export interface FormField<Value> {
  readonly name: string;
  readonly id: string;
  readonly errorId: string;
  readonly value: ReactiveSignal<Value>;
  readonly errors: ReactiveSignal<readonly string[]>;
  readonly touched: ReactiveSignal<boolean>;
  readonly dirty: Computed<boolean>;
  readonly invalid: Computed<boolean>;
  readonly message: Computed<string | undefined>;
  set(value: Value): void;
  touch(): void;
  reset(): void;
  input(options?: FormControlOptions<Value>): Record<string, unknown>;
  textarea(options?: FormTextAreaOptions<Value>): Record<string, unknown>;
  select(options?: FormSelectOptions<Value>): Record<string, unknown>;
  checkbox(this: FormField<boolean>, options?: FormCheckboxOptions): Record<string, unknown>;
  radio(options: FormRadioOptions<Value>): Record<string, unknown>;
  error(options?: { id?: string; live?: "polite" | "assertive" }): Record<string, unknown>;
}

export interface FormFieldManifest {
  readonly name: string;
  readonly required: boolean;
  readonly control: "checkbox" | "number" | "select" | "text";
  readonly schema: Record<string, unknown>;
}

export interface FormManifest {
  readonly protocol: "clank-form/1";
  readonly id: string;
  readonly fields: readonly FormFieldManifest[];
  readonly schema?: Record<string, unknown>;
}

export interface FormController<Values extends FormValues, Result = unknown> {
  readonly id: string;
  readonly values: Computed<Values>;
  readonly dirty: Computed<boolean>;
  readonly valid: Computed<boolean>;
  readonly pending: ReactiveSignal<boolean>;
  readonly submitted: ReactiveSignal<boolean>;
  readonly submitCount: ReactiveSignal<number>;
  readonly status: ReactiveSignal<FormStatus>;
  readonly result: ReactiveSignal<Result | undefined>;
  readonly error: ReactiveSignal<unknown>;
  readonly formErrors: ReactiveSignal<readonly string[]>;
  readonly manifest: FormManifest;
  field<Key extends FormKey<Values>>(name: Key): FormField<Values[Key]>;
  setValue<Key extends FormKey<Values>>(name: Key, value: Values[Key]): void;
  setValues(values: Partial<Values>): void;
  setErrors(errors: FormErrorMap<Values>): void;
  validate(reason?: FormValidationContext["reason"]): boolean;
  submit(event?: Event): Promise<Result | undefined>;
  reset(values?: Values): void;
  focusFirstError(root?: ParentNode): boolean;
  props(): Record<string, unknown>;
}

interface InternalField<Value> extends FormField<Value> {
  setInitial(value: Value): void;
}

const FORBIDDEN_FIELD_NAMES = new Set(["__proto__", "prototype", "constructor", "_form"]);

/**
 * Creates a headless, schema-aware form controller.
 *
 * The controller owns field signals, validation, accessible control props,
 * submission cancellation, server errors, reset behavior, and an agent-readable
 * manifest. It renders no markup, so applications keep full control of HTML and
 * Tailwind classes.
 */
export function createForm<Values extends FormValues, Result = unknown>(
  options: CreateFormOptions<Values, Result>,
): FormController<Values, Result> {
  if (!options.initial || typeof options.initial !== "object" || Array.isArray(options.initial)) {
    throw new TypeError("createForm initial values must be an object.");
  }
  const id = formId(options.id ?? "form");
  const keys = Object.keys(options.initial) as Array<FormKey<Values>>;
  if (keys.length === 0) throw new TypeError("createForm requires at least one field.");
  for (const key of keys) {
    if (FORBIDDEN_FIELD_NAMES.has(key)) throw new TypeError(`Unsafe form field name: ${key}`);
  }
  assertExactValues(keys, options.initial);

  let baseline = cloneValues(options.initial);
  const fields = new Map<FormKey<Values>, InternalField<Values[FormKey<Values>]>>();
  const pending = signal(false, { name: `${id}.pending` });
  const submitted = signal(false, { name: `${id}.submitted` });
  const submitCount = signal(0, { name: `${id}.submitCount` });
  const status = signal<FormStatus>("idle", { name: `${id}.status` });
  const result = signal<Result | undefined>(undefined, { name: `${id}.result` });
  const error = signal<unknown>(undefined, { name: `${id}.error` });
  const formErrors = signal<readonly string[]>([], { name: `${id}.errors` });
  let submitController: AbortController | undefined;
  let submitRevision = 0;
  let submissionRejected = false;
  let parsedValues: Values = cloneValues(options.initial);

  const validateOn = options.validateOn ?? "submit";
  const clearFieldError = (name: FormKey<Values>) => {
    const field = fields.get(name);
    if (field && field.errors.peek().length > 0) field.errors.value = [];
    if (formErrors.peek().length > 0) formErrors.value = [];
    if (status.peek() === "invalid" || status.peek() === "error") status.value = "idle";
  };
  const validateAfter = (reason: "input" | "blur") => {
    if (validateOn === "input" || (validateOn === "blur" && reason === "blur")) {
      controller.validate(reason);
    }
  };

  for (const name of keys) {
    const field = createField(
      id,
      name,
      baseline[name],
      () => clearFieldError(name),
      validateAfter,
    );
    fields.set(name, field as InternalField<Values[FormKey<Values>]>);
  }

  const values = computed(() => {
    const output = Object.create(null) as Values;
    for (const name of keys) output[name] = fields.get(name)!.value.value;
    return output;
  }, { name: `${id}.values` });
  const dirty = computed(
    () => keys.some((name) => fields.get(name)!.dirty.value),
    { name: `${id}.dirty` },
  );
  const valid = computed(
    () => formErrors.value.length === 0 && keys.every((name) => !fields.get(name)!.invalid.value),
    { name: `${id}.valid` },
  );

  const controller: FormController<Values, Result> = {
    id,
    values,
    dirty,
    valid,
    pending,
    submitted,
    submitCount,
    status,
    result,
    error,
    formErrors,
    manifest: createManifest(id, options.schema, keys),
    field(name) {
      const field = fields.get(name);
      if (!field) throw new TypeError(`Unknown form field: ${String(name)}`);
      return field as unknown as FormField<Values[typeof name]>;
    },
    setValue(name, value) {
      controller.field(name).set(value);
    },
    setValues(next) {
      batch(() => {
        for (const [name, value] of Object.entries(next) as Array<[FormKey<Values>, Values[FormKey<Values>]]>) {
          controller.field(name).set(value);
        }
      });
    },
    setErrors(next) {
      assertErrorKeys(keys, next);
      applyErrors(keys, fields, formErrors, next);
      submissionRejected = hasErrors(next);
      if (submissionRejected) status.value = "invalid";
    },
    validate(reason = "manual") {
      const raw = values.peek();
      const next: FormErrorMap<Values> = {};
      let parsed = raw;
      if (options.schema) {
        const checked = options.schema.safeParse(raw);
        if (checked.success) parsed = checked.data;
        else assignValidationIssues(next, checked.error.issues, keys);
      }
      if (!hasErrors(next) && options.validate) {
        const custom = options.validate(parsed, { reason });
        if (custom) assertErrorKeys(keys, custom);
        mergeErrors(next, custom);
      }
      parsedValues = parsed;
      applyErrors(keys, fields, formErrors, next);
      const accepted = !hasErrors(next);
      if (!accepted) status.value = "invalid";
      else if (!pending.peek() && status.peek() === "invalid") status.value = "idle";
      return accepted;
    },
    async submit(event) {
      event?.preventDefault();
      if (pending.peek() && (options.concurrency ?? "replace") === "ignore") return result.peek();
      submitController?.abort(new DOMException("A newer form submission replaced this one.", "AbortError"));
      submitController = new AbortController();
      const revision = ++submitRevision;
      submissionRejected = false;
      batch(() => {
        pending.value = true;
        submitted.value = true;
        submitCount.update((count) => count + 1);
        status.value = "submitting";
        error.value = undefined;
        formErrors.value = [];
        for (const field of fields.values()) field.touch();
      });
      if (!controller.validate("submit")) {
        pending.value = false;
        if (options.focusFirstError !== false) queueMicrotask(() => controller.focusFirstError());
        return undefined;
      }
      if (!options.onSubmit) {
        batch(() => {
          pending.value = false;
          status.value = "success";
        });
        return undefined;
      }
      try {
        const output = await options.onSubmit(cloneValues(parsedValues), {
          signal: submitController.signal,
          setErrors: controller.setErrors,
          reset: controller.reset,
        });
        if (revision !== submitRevision || submitController.signal.aborted) return result.peek();
        if (submissionRejected) {
          pending.value = false;
          if (options.focusFirstError !== false) queueMicrotask(() => controller.focusFirstError());
          return undefined;
        }
        batch(() => {
          result.value = output;
          pending.value = false;
          status.value = "success";
        });
        if (options.resetOnSuccess) controller.reset();
        return output;
      } catch (reason) {
        if (revision !== submitRevision || submitController.signal.aborted) return result.peek();
        batch(() => {
          error.value = reason;
          pending.value = false;
          status.value = "error";
        });
        return undefined;
      }
    },
    reset(next) {
      submitRevision++;
      submitController?.abort(new DOMException("The form was reset.", "AbortError"));
      if (next) {
        assertExactValues(keys, next);
        baseline = cloneValues(next);
      }
      batch(() => {
        for (const name of keys) {
          const field = fields.get(name)!;
          field.setInitial(baseline[name]);
          field.reset();
        }
        pending.value = false;
        submitted.value = false;
        status.value = "idle";
        result.value = undefined;
        error.value = undefined;
        formErrors.value = [];
      });
    },
    focusFirstError(root = typeof document === "undefined" ? undefined : document) {
      if (!root) return false;
      const invalid = new Set(
        keys.filter((name) => fields.get(name)!.invalid.peek()).map(String),
      );
      if (invalid.size === 0) return false;
      for (const element of root.querySelectorAll<HTMLElement>("[name]")) {
        if (invalid.has(element.getAttribute("name") ?? "")) {
          element.focus();
          return true;
        }
      }
      return false;
    },
    props() {
      return {
        id,
        noValidate: true,
        onSubmit: (event: Event) => void controller.submit(event),
        "aria-busy": () => pending.value,
        "data-clank-form": id,
      };
    },
  };
  return controller;
}

function createField<Value>(
  form: string,
  name: string,
  initial: Value,
  onChange: () => void,
  validateAfter: (reason: "input" | "blur") => void,
): InternalField<Value> {
  let baseline = cloneValue(initial);
  const value = signal(cloneValue(initial), { name: `${form}.${name}` });
  const errors = signal<readonly string[]>([], { name: `${form}.${name}.errors` });
  const touched = signal(false, { name: `${form}.${name}.touched` });
  const dirty = computed(() => !Object.is(value.value, baseline), { name: `${form}.${name}.dirty` });
  const invalid = computed(() => errors.value.length > 0, { name: `${form}.${name}.invalid` });
  const message = computed(() => errors.value[0], { name: `${form}.${name}.message` });
  const id = `${form}-${safeId(name)}`;
  const errorId = `${id}-error`;
  const set = (next: Value) => {
    value.value = next;
    onChange();
  };
  const describedBy = (description?: string) => () => {
    const ids = [description, invalid.value ? errorId : undefined].filter(Boolean);
    return ids.length ? ids.join(" ") : undefined;
  };
  const semantics = (
    options: { id?: string; agentId?: string; agentLabel?: string; describedBy?: string },
  ) => ({
    id: options.id ?? id,
    name,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.agentLabel ? { agentLabel: options.agentLabel } : {}),
    "aria-invalid": () => invalid.value,
    "aria-describedby": describedBy(options.describedBy),
    onBlur: () => {
      touched.value = true;
      validateAfter("blur");
    },
  });

  const field: InternalField<Value> = {
    name,
    id,
    errorId,
    value,
    errors,
    touched,
    dirty,
    invalid,
    message,
    set,
    touch() { touched.value = true; },
    reset() {
      batch(() => {
        value.value = cloneValue(baseline);
        errors.value = [];
        touched.value = false;
      });
    },
    setInitial(next) {
      baseline = cloneValue(next);
    },
    input(options = {}) {
      const type = options.type ?? "text";
      return {
        ...semantics(options),
        type,
        value: () => options.format ? options.format(value.value) : displayValue(value.value),
        onInput: (event: Event) => {
          const element = event.currentTarget as HTMLInputElement;
          let next: Value;
          if (options.parse) next = options.parse(element);
          else if (type === "number" || type === "range") {
            next = (element.value === "" ? undefined : element.valueAsNumber) as Value;
          } else {
            next = element.value as Value;
          }
          set(next);
          validateAfter("input");
        },
      };
    },
    textarea(options = {}) {
      return {
        ...semantics(options),
        value: () => options.format ? options.format(value.value) : displayValue(value.value),
        onInput: (event: Event) => {
          const element = event.currentTarget as HTMLTextAreaElement;
          set(options.parse ? options.parse(element) : element.value as Value);
          validateAfter("input");
        },
      };
    },
    select(options = {}) {
      return {
        ...semantics(options),
        multiple: options.multiple,
        value: () => {
          if (options.format) return options.format(value.value);
          return Array.isArray(value.value) ? value.value.map(String) : displayValue(value.value);
        },
        onChange: (event: Event) => {
          const element = event.currentTarget as HTMLSelectElement;
          const next = options.parse
            ? options.parse(element)
            : options.multiple
              ? [...element.selectedOptions].map((option) => option.value) as Value
              : element.value as Value;
          set(next);
          validateAfter("input");
        },
      };
    },
    checkbox(this: FormField<boolean>, options = {}) {
      return {
        ...semantics(options),
        type: "checkbox",
        checked: () => this.value.value,
        onChange: (event: Event) => {
          set((event.currentTarget as HTMLInputElement).checked as Value);
          validateAfter("input");
        },
      };
    },
    radio(options) {
      const serialize = options.serialize ?? String;
      return {
        ...semantics(options),
        type: "radio",
        value: serialize(options.value),
        checked: () => Object.is(value.value, options.value),
        onChange: (event: Event) => {
          if ((event.currentTarget as HTMLInputElement).checked) set(options.value);
          validateAfter("input");
        },
      };
    },
    error(options = {}) {
      return {
        id: options.id ?? errorId,
        role: "status",
        "aria-live": options.live ?? "polite",
        hidden: () => !invalid.value,
      };
    },
  };
  return field;
}

function applyErrors<Values extends FormValues>(
  keys: Array<FormKey<Values>>,
  fields: Map<FormKey<Values>, InternalField<Values[FormKey<Values>]>>,
  formErrors: ReactiveSignal<readonly string[]>,
  errors: FormErrorMap<Values> | void,
): void {
  const source: FormErrorMap<Values> = errors ?? {};
  batch(() => {
    for (const key of keys) fields.get(key)!.errors.value = errorList(source[key]);
    formErrors.value = errorList(source._form);
  });
}

function assignValidationIssues<Values extends FormValues>(
  errors: FormErrorMap<Values>,
  issues: readonly ValidationIssue[],
  keys: Array<FormKey<Values>>,
): void {
  const known = new Set<string>(keys);
  for (const issue of issues) {
    const first = typeof issue.path[0] === "string" && known.has(issue.path[0])
      ? issue.path[0] as FormKey<Values>
      : "_form";
    const current = errorList(errors[first]);
    errors[first] = [...current, issue.message];
  }
}

function mergeErrors<Values extends FormValues>(
  target: FormErrorMap<Values>,
  source: FormErrorMap<Values> | void,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    const name = key as FormKey<Values> | "_form";
    target[name] = [...errorList(target[name]), ...errorList(value)];
  }
}

function assertErrorKeys<Values extends FormValues>(
  keys: Array<FormKey<Values>>,
  errors: FormErrorMap<Values>,
): void {
  const known = new Set<string>(["_form", ...keys]);
  for (const key of Object.keys(errors)) {
    if (!known.has(key)) throw new TypeError(`Unknown form error field: ${key}`);
  }
}

function assertExactValues<Values extends FormValues>(
  keys: Array<FormKey<Values>>,
  values: Values,
): void {
  const actual = Object.keys(values);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key as FormKey<Values>))) {
    throw new TypeError("Form reset values must contain exactly the original fields.");
  }
}

function hasErrors<Values extends FormValues>(errors: FormErrorMap<Values> | void): boolean {
  return Boolean(errors && Object.values(errors).some((value) => errorList(value).length > 0));
}

function errorList(value: FormErrorValue): readonly string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : [...value];
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

function createManifest<Values extends FormValues>(
  id: string,
  schema: Schema<Values> | undefined,
  keys: Array<FormKey<Values>>,
): FormManifest {
  const json = schema?.toJSONSchema();
  const properties = json?.properties && typeof json.properties === "object"
    ? json.properties as Record<string, Record<string, unknown>>
    : {};
  const required = new Set(Array.isArray(json?.required) ? json.required.map(String) : keys);
  return Object.freeze({
    protocol: "clank-form/1" as const,
    id,
    fields: Object.freeze(keys.map((name) => {
      const fieldSchema = structuredClone(properties[name] ?? {});
      return Object.freeze({
        name,
        required: required.has(name),
        control: suggestedControl(fieldSchema),
        schema: fieldSchema,
      });
    })),
    ...(json ? { schema: structuredClone(json) } : {}),
  });
}

function suggestedControl(schema: Record<string, unknown>): FormFieldManifest["control"] {
  if (schema.type === "boolean" || typeof schema.const === "boolean") return "checkbox";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (Array.isArray(schema.enum)) return "select";
  return "text";
}

function formId(value: string): string {
  const normalized = safeId(value);
  if (!normalized) throw new TypeError("Form id must contain a letter or number.");
  return normalized;
}

function safeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function displayValue(value: unknown): string | number {
  return typeof value === "number" ? value : value === null || value === undefined ? "" : String(value);
}

function cloneValues<Values extends FormValues>(values: Values): Values {
  return cloneValue(values);
}

function cloneValue<Value>(value: Value): Value {
  return typeof structuredClone === "function" ? structuredClone(value) : value;
}
