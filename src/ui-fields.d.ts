import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
import { type ChangeDetails, type Direction, type UiManifest } from "./ui-foundation.js";
export type FieldReadable<Value> = Value | (() => Value);
export type ValidationMode = "onSubmit" | "onBlur" | "onChange";
export type FieldChangeReason = "input" | "change" | "reset" | "programmatic";
export type FieldValidationReason = "input" | "blur" | "submit" | "manual";
export type NativeValidityKey = "badInput" | "customError" | "patternMismatch" | "rangeOverflow" | "rangeUnderflow" | "stepMismatch" | "tooLong" | "tooShort" | "typeMismatch" | "valueMissing";
export interface FieldValidationContext<Value> {
    readonly reason: FieldValidationReason;
    readonly signal: AbortSignal;
    readonly field: FieldController<Value>;
    readonly element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    readonly validity: Readonly<Record<NativeValidityKey, boolean>>;
}
export type FieldValidationResult = void | null | boolean | string | readonly string[] | {
    errors?: string | readonly string[];
    validity?: NativeValidityKey;
};
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
    validate?: (value: Value, context: FieldValidationContext<Value>) => FieldValidationResult | Promise<FieldValidationResult>;
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
export declare function createField<Value = string>(options: FieldOptions<Value>): FieldController<Value>;
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
export declare function createFieldset(options: FieldsetOptions): FieldsetController;
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
    onFormSubmit?: (values: Readonly<Record<string, unknown>>, details: FormFacadeSubmitDetails) => Result | Promise<Result>;
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
export declare function createFormFacade<Result = unknown>(options: FormFacadeOptions<Result>): FormFacadeController<Result>;
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
export declare function createInput(options: InputOptions): InputController;
export type NumberFieldChangeReason = "input-change" | "input-clear" | "input-blur" | "input-paste" | "keyboard" | "increment-press" | "decrement-press" | "wheel" | "scrub" | "reset" | "programmatic";
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
    stepButtonDelay?: number;
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
export declare function createNumberField(options: NumberFieldOptions): NumberFieldController;
export type OtpValidationType = "numeric" | "alpha" | "alphanumeric" | RegExp | ((character: string) => boolean);
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
    ariaLabel?: string;
}
export declare function createOtpField(options: OtpFieldOptions): OtpFieldController;
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
export declare function createSlider(options: SliderOptions): SliderController;
