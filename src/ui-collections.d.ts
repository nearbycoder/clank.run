import { type Computed, type ReactiveSignal } from "./core.js";
import { type ChangeDetails, type Direction, type Orientation, type UiManifest } from "./ui-foundation.js";
import { type OpenChangeReason, type PopupOptions, type PopupPortalOptions } from "./ui-popups.js";

export type CollectionReadable<Value> = Value | (() => Value);
export interface CollectionAgentPartOptions { agentId?: string; agentLabel?: string; agentDescription?: string; }
export interface CollectionItemDefinition<Value extends string> { value: Value; textValue: string; disabled?: CollectionReadable<boolean>; }

export type AccordionChangeReason = "trigger-press" | "beforematch" | "programmatic" | "reset";
export interface AccordionPanelOptions {
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
}
interface AccordionCommonOptions<Value extends string> {
  id: string;
  items: readonly CollectionItemDefinition<Value>[];
  disabled?: CollectionReadable<boolean>;
  collapsible?: boolean;
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
  isPanelMounted(value: Value, options?: AccordionPanelOptions): boolean;
  panel(value: Value, options?: AccordionPanelOptions): Record<string, unknown>;
  manifest(): UiManifest;
}
export declare function createAccordion<Value extends string>(options: AccordionSingleOptions<Value> | AccordionMultipleOptions<Value>): AccordionController<Value>;

export type TabsChangeReason = "tab-press" | "keyboard" | "programmatic" | "reset" | "initial" | "disabled" | "missing";
export type TabsActivationMode = "manual" | "automatic";
export interface TabsPanelOptions { keepMounted?: boolean; }
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
  isPanelMounted(value: Value, options?: TabsPanelOptions): boolean;
  panel(value: Value, options?: TabsPanelOptions): Record<string, unknown>;
  indicator(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createTabs<Value extends string>(options: TabsOptions<Value>): TabsController<Value>;

export type MenuItemKind = "item" | "link" | "checkbox" | "radio" | "submenu";
interface MenuItemBase<Value extends string> extends CollectionItemDefinition<Value> { closeOnClick?: boolean; }
export interface MenuActionItemDefinition<Value extends string> extends MenuItemBase<Value> { kind?: "item"; }
export interface MenuLinkItemDefinition<Value extends string> extends MenuItemBase<Value> { kind: "link"; href: string; target?: string; rel?: string; }
export interface MenuCheckboxItemDefinition<Value extends string> extends MenuItemBase<Value> { kind: "checkbox"; }
export interface MenuRadioItemDefinition<Value extends string> extends MenuItemBase<Value> { kind: "radio"; group: string; }
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
export type MenuItemDefinition<Value extends string> = MenuActionItemDefinition<Value> | MenuLinkItemDefinition<Value> | MenuCheckboxItemDefinition<Value> | MenuRadioItemDefinition<Value> | MenuSubmenuItemDefinition<Value>;
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
  isMounted(options?: PopupPortalOptions): boolean;
  portal(options?: PopupPortalOptions): Record<string, unknown>;
  backdrop(options?: { dismiss?: boolean }): Record<string, unknown>;
  positioner(): Record<string, unknown>;
  popup(): Record<string, unknown>;
  viewport(): Record<string, unknown>;
  arrow(): Record<string, unknown>;
  item(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  linkItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  link(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  checkboxItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  checkboxItemIndicator(value: Value, options?: { keepMounted?: boolean }): Record<string, unknown>;
  radioGroup(group: string, options?: { id?: string; label?: string; labelledBy?: string }): Record<string, unknown>;
  radioItem(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  radioItemIndicator(value: Value, options?: { keepMounted?: boolean }): Record<string, unknown>;
  submenuRoot(value: Value): MenuController<string>;
  submenuTrigger(value: Value, options?: CollectionAgentPartOptions): Record<string, unknown>;
  group(options?: { id?: string; label?: string; labelledBy?: string }): Record<string, unknown>;
  groupLabel(options?: { id?: string }): Record<string, unknown>;
  separator(): Record<string, unknown>;
  manifest(): UiManifest;
  dispose(): void;
}
export declare function createMenu<Value extends string>(options: MenuOptions<Value>): MenuController<Value>;
export interface ContextMenuOptions<Value extends string> extends Omit<MenuOptions<Value>, "defaultOpen"> { longPressDelay?: number; longPressTolerance?: number; }
export interface ContextMenuController<Value extends string> extends MenuController<Value> { target(options?: CollectionAgentPartOptions): Record<string, unknown>; }
export declare function createContextMenu<Value extends string>(options: ContextMenuOptions<Value>): ContextMenuController<Value>;

interface MenubarItemBase<Value extends string> extends CollectionItemDefinition<Value> {}
export interface MenubarMenuDefinition<Value extends string> extends MenubarItemBase<Value> {
  kind?: "menu";
  items: readonly MenuItemDefinition<string>[];
  menuOptions?: Omit<MenuOptions<string>, "id" | "items" | "onOpenChange" | "open" | "defaultOpen">;
}
export interface MenubarLinkDefinition<Value extends string> extends MenubarItemBase<Value> { kind: "link"; href: string; target?: string; rel?: string; }
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
export declare function createMenubar<Value extends string>(options: MenubarOptions<Value>): MenubarController<Value>;

interface NavigationMenuItemBase<Value extends string> extends CollectionItemDefinition<Value> {}
export interface NavigationMenuTriggerDefinition<Value extends string> extends NavigationMenuItemBase<Value> { kind?: "trigger"; }
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
  isMounted(options?: PopupPortalOptions): boolean;
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
export declare function createNavigationMenu<Value extends string>(options: NavigationMenuOptions<Value>): NavigationMenuController<Value>;

interface ToolbarItemBase<Value extends string> extends CollectionItemDefinition<Value> {}
export interface ToolbarButtonDefinition<Value extends string> extends ToolbarItemBase<Value> { kind?: "button"; type?: "button" | "submit" | "reset"; group?: Value; focusableWhenDisabled?: boolean; onPress?: (details: ChangeDetails<ToolbarPressReason>) => void; }
export interface ToolbarLinkDefinition<Value extends string> extends ToolbarItemBase<Value> { kind: "link"; href: string; target?: string; rel?: string; group?: Value; }
export interface ToolbarInputDefinition<Value extends string> extends ToolbarItemBase<Value> { kind: "input"; type?: "text" | "search" | "url" | "email" | "tel"; name?: string; placeholder?: string; defaultValue?: string; group?: Value; focusableWhenDisabled?: boolean; }
export interface ToolbarGroupDefinition<Value extends string> extends ToolbarItemBase<Value> { kind: "group"; label?: string; labelledBy?: string; }
export interface ToolbarSeparatorDefinition<Value extends string> extends ToolbarItemBase<Value> { kind: "separator"; decorative?: boolean; }
export type ToolbarItemDefinition<Value extends string> = ToolbarButtonDefinition<Value> | ToolbarLinkDefinition<Value> | ToolbarInputDefinition<Value> | ToolbarGroupDefinition<Value> | ToolbarSeparatorDefinition<Value>;
export type ToolbarPressReason = "press" | "programmatic";
export interface ToolbarOptions<Value extends string> {
  id: string;
  items: readonly ToolbarItemDefinition<Value>[];
  disabled?: CollectionReadable<boolean>;
  orientation?: Orientation;
  direction?: Direction | "auto";
  loop?: boolean;
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
export declare function createToolbar<Value extends string>(options: ToolbarOptions<Value>): ToolbarController<Value>;
export {};
