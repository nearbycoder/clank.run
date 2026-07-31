import { type Computed } from "./core.js";
import { type ChangeDetails } from "./ui-foundation.js";
import { type FieldController } from "./ui-fields.js";
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
export declare function createButton(options: ButtonOptions): ButtonController;
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
    image(options: {
        alt: string;
        src?: string;
    }): Record<string, unknown>;
    fallback(options?: { delay?: number }): Record<string, unknown>;
    manifest(): UiControlManifest;
}
/** Loading/error state and parts for an accessible image avatar with a fallback. */
export declare function createAvatar(options: AvatarOptions): AvatarController;
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
export declare function createCheckbox(options: CheckboxOptions): CheckboxController;
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
export declare function createCheckboxGroup<Value extends string>(options: CheckboxGroupOptions<Value>): CheckboxGroupController<Value>;
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
export declare function createRadioGroup<Value extends string>(options: RadioGroupOptions<Value>): RadioGroupController<Value>;
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
export declare function createSwitch(options: SwitchOptions): SwitchController;
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
export declare function createToggle(options: ToggleOptions): ToggleController;
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
export declare function createToggleGroup<Value extends string>(options: ToggleGroupSingleOptions<Value>): ToggleGroupSingleController<Value>;
export declare function createToggleGroup<Value extends string>(options: ToggleGroupMultipleOptions<Value>): ToggleGroupMultipleController<Value>;
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
export declare function createMeter(options: MeterOptions): MeterController;
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
export declare function createProgress(options: ProgressOptions): ProgressController;
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
export declare function createSeparator(options: SeparatorOptions): SeparatorController;
export interface AgentPartOptions {
    agentId?: string;
    agentLabel?: string;
    agentDescription?: string;
}
export {};
