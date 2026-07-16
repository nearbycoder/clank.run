import { type Computed, type ReactiveSignal } from "./core.js";
import type { Schema } from "./ai.js";
export type FormValues = Record<string, unknown>;
export type FormKey<Values extends FormValues> = Extract<keyof Values, string>;
export type FormStatus = "idle" | "invalid" | "submitting" | "success" | "error";
export type FormErrorValue = string | readonly string[] | undefined;
export type FormErrorMap<Values extends FormValues> = Partial<Record<FormKey<Values> | "_form", FormErrorValue>>;
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
    validate?: (values: Values, context: FormValidationContext) => FormErrorMap<Values> | void;
    onSubmit?: (values: Values, context: FormSubmitContext<Values>) => Result | Promise<Result>;
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
    error(options?: {
        id?: string;
        live?: "polite" | "assertive";
    }): Record<string, unknown>;
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
/**
 * Creates a headless, schema-aware form controller.
 *
 * The controller owns field signals, validation, accessible control props,
 * submission cancellation, server errors, reset behavior, and an agent-readable
 * manifest. It renders no markup, so applications keep full control of HTML and
 * Tailwind classes.
 */
export declare function createForm<Values extends FormValues, Result = unknown>(options: CreateFormOptions<Values, Result>): FormController<Values, Result>;
