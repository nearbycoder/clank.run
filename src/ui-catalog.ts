import { createAccordion, createContextMenu, createMenu, createMenubar, createNavigationMenu, createTabs, createToolbar } from "./ui-collections.ts";
import { createAvatar, createButton, createCheckbox, createCheckboxGroup, createMeter, createProgress, createRadioGroup, createSeparator, createSwitch, createToggle, createToggleGroup } from "./ui-controls.ts";
import { createField, createFieldset, createFormFacade, createInput, createNumberField, createOtpField, createSlider } from "./ui-fields.ts";
import { createAlertDialog, createCollapsible, createDialog, createDrawer, createPopover, createPreviewCard, createTooltip } from "./ui-popups.ts";
import { createAutocomplete, createCombobox, createSelect } from "./ui-selection.ts";
import { createScrollArea, createToastProvider } from "./ui-utilities.ts";

/** The upstream release whose component inventory and anatomy Clank tracks. */
export const BASE_UI_REFERENCE_VERSION = "1.6.0" as const;
export const BASE_UI_REFERENCE_URL = "https://base-ui.com/react/overview/releases/v1-6-0" as const;

/**
 * Compile-time source of truth for canonical names, package slugs, factories,
 * and implementation modules. Keeping these values correlated prevents an
 * agent from generating a valid-looking subpath for the wrong controller.
 */
export type UiComponentContractMap = Readonly<{
  readonly Accordion: readonly ["accordion", "createAccordion", "collections"];
  readonly AlertDialog: readonly ["alert-dialog", "createAlertDialog", "popups"];
  readonly Autocomplete: readonly ["autocomplete", "createAutocomplete", "selection"];
  readonly Avatar: readonly ["avatar", "createAvatar", "controls"];
  readonly Button: readonly ["button", "createButton", "controls"];
  readonly Checkbox: readonly ["checkbox", "createCheckbox", "controls"];
  readonly CheckboxGroup: readonly ["checkbox-group", "createCheckboxGroup", "controls"];
  readonly Collapsible: readonly ["collapsible", "createCollapsible", "popups"];
  readonly Combobox: readonly ["combobox", "createCombobox", "selection"];
  readonly ContextMenu: readonly ["context-menu", "createContextMenu", "collections"];
  readonly Dialog: readonly ["dialog", "createDialog", "popups"];
  readonly Drawer: readonly ["drawer", "createDrawer", "popups"];
  readonly Field: readonly ["field", "createField", "fields"];
  readonly Fieldset: readonly ["fieldset", "createFieldset", "fields"];
  readonly Form: readonly ["form", "createFormFacade", "fields"];
  readonly Input: readonly ["input", "createInput", "fields"];
  readonly Menu: readonly ["menu", "createMenu", "collections"];
  readonly Menubar: readonly ["menubar", "createMenubar", "collections"];
  readonly Meter: readonly ["meter", "createMeter", "controls"];
  readonly NavigationMenu: readonly ["navigation-menu", "createNavigationMenu", "collections"];
  readonly NumberField: readonly ["number-field", "createNumberField", "fields"];
  readonly OTPField: readonly ["otp-field", "createOtpField", "fields"];
  readonly Popover: readonly ["popover", "createPopover", "popups"];
  readonly PreviewCard: readonly ["preview-card", "createPreviewCard", "popups"];
  readonly Progress: readonly ["progress", "createProgress", "controls"];
  readonly Radio: readonly ["radio", "createRadioGroup", "controls"];
  readonly ScrollArea: readonly ["scroll-area", "createScrollArea", "utilities"];
  readonly Select: readonly ["select", "createSelect", "selection"];
  readonly Separator: readonly ["separator", "createSeparator", "controls"];
  readonly Slider: readonly ["slider", "createSlider", "fields"];
  readonly Switch: readonly ["switch", "createSwitch", "controls"];
  readonly Tabs: readonly ["tabs", "createTabs", "collections"];
  readonly Toast: readonly ["toast", "createToastProvider", "utilities"];
  readonly Toggle: readonly ["toggle", "createToggle", "controls"];
  readonly ToggleGroup: readonly ["toggle-group", "createToggleGroup", "controls"];
  readonly Toolbar: readonly ["toolbar", "createToolbar", "collections"];
  readonly Tooltip: readonly ["tooltip", "createTooltip", "popups"];
}>;

export type UiComponentName = keyof UiComponentContractMap;
export type UiComponentSlug = UiComponentContractMap[UiComponentName][0];
export type UiComponentFactoryName = UiComponentContractMap[UiComponentName][1];
export type UiCatalogModule = UiComponentContractMap[UiComponentName][2];
export type UiComponentNameForSlug<Slug extends UiComponentSlug> = {
  [Name in UiComponentName]: UiComponentContractMap[Name][0] extends Slug ? Name : never;
}[UiComponentName];

export type UiCatalogEntry<Name extends UiComponentName = UiComponentName> =
  Name extends UiComponentName
    ? Readonly<{
      name: Name;
      slug: UiComponentContractMap[Name][0];
      factory: UiComponentContractMap[Name][1];
      module: UiComponentContractMap[Name][2];
      parts: readonly string[];
      formAssociated: boolean;
      description: string;
      /** Canonical upstream anatomy/API page used for this compatibility surface. */
      referenceUrl: `https://base-ui.com/react/components/${UiComponentContractMap[Name][0]}`;
      /** Upstream release used when this entry was authored and verified. */
      referenceVersion: typeof BASE_UI_REFERENCE_VERSION;
    }>
    : never;

/** Resolves a canonical family name or slug to its exact catalog entry type. */
export type UiCatalogEntryFor<Key extends string> =
  Key extends UiComponentName
    ? UiCatalogEntry<Key>
    : Key extends UiComponentSlug
      ? UiCatalogEntry<UiComponentNameForSlug<Key>>
      : UiCatalogEntry | undefined;

const componentFactories = {
  Accordion: createAccordion,
  AlertDialog: createAlertDialog,
  Autocomplete: createAutocomplete,
  Avatar: createAvatar,
  Button: createButton,
  Checkbox: createCheckbox,
  CheckboxGroup: createCheckboxGroup,
  Collapsible: createCollapsible,
  Combobox: createCombobox,
  ContextMenu: createContextMenu,
  Dialog: createDialog,
  Drawer: createDrawer,
  Field: createField,
  Fieldset: createFieldset,
  Form: createFormFacade,
  Input: createInput,
  Menu: createMenu,
  Menubar: createMenubar,
  Meter: createMeter,
  NavigationMenu: createNavigationMenu,
  NumberField: createNumberField,
  OTPField: createOtpField,
  Popover: createPopover,
  PreviewCard: createPreviewCard,
  Progress: createProgress,
  Radio: createRadioGroup,
  ScrollArea: createScrollArea,
  Select: createSelect,
  Separator: createSeparator,
  Slider: createSlider,
  Switch: createSwitch,
  Tabs: createTabs,
  Toast: createToastProvider,
  Toggle: createToggle,
  ToggleGroup: createToggleGroup,
  Toolbar: createToolbar,
  Tooltip: createTooltip,
};

/** Exact per-family controller signatures, rather than an any-typed lookup. */
export type UiComponentFactoryMap = Readonly<typeof componentFactories>;

/**
 * Runtime factory lookup for agent generators, inspectors, examples, and
 * catalog conformance tests. It deliberately contains the same 37 families as
 * the official Base UI 1.6 catalog while exposing Clank-native controllers.
 */
export const UI_COMPONENT_FACTORIES: UiComponentFactoryMap = Object.freeze(componentFactories);

const componentCatalog = [
  entry("Accordion", "accordion", "createAccordion", "collections", ["root", "item", "header", "trigger", "panel"], false, "Single or multiple expandable sections."),
  entry("AlertDialog", "alert-dialog", "createAlertDialog", "popups", ["trigger", "portal", "backdrop", "viewport", "popup", "title", "description", "close"], false, "A modal decision that cannot be dismissed accidentally."),
  entry("Autocomplete", "autocomplete", "createAutocomplete", "selection", ["label", "input-group", "input", "trigger", "icon", "clear", "value", "portal", "backdrop", "positioner", "popup", "arrow", "status", "empty", "list", "row", "item", "separator", "group", "group-label", "collection"], true, "Editable free-form input with filtered suggestions."),
  entry("Avatar", "avatar", "createAvatar", "controls", ["root", "image", "fallback"], false, "Image loading state with an accessible fallback."),
  entry("Button", "button", "createButton", "controls", ["root"], true, "Native-first press behavior and agent metadata."),
  entry("Checkbox", "checkbox", "createCheckbox", "controls", ["root", "indicator", "input", "unchecked-input"], true, "Binary or indeterminate choice with checked and unchecked native form projection."),
  entry("CheckboxGroup", "checkbox-group", "createCheckboxGroup", "controls", ["root", "parent", "parent-indicator", "item", "indicator", "input"], true, "An ordered group with independently checked values and an optional mixed-state parent."),
  entry("Collapsible", "collapsible", "createCollapsible", "popups", ["trigger", "panel"], false, "A controlled or uncontrolled expandable panel."),
  entry("Combobox", "combobox", "createCombobox", "selection", ["label", "input-group", "input", "trigger", "icon", "clear", "value", "chips", "chip", "chip-remove", "portal", "backdrop", "positioner", "popup", "arrow", "status", "empty", "list", "row", "item", "item-indicator", "separator", "group", "group-label", "collection", "form-control", "hidden-input"], true, "Editable input restricted to supplied values."),
  entry("ContextMenu", "context-menu", "createContextMenu", "collections", ["trigger", "portal", "backdrop", "positioner", "popup", "arrow", "item", "link-item", "submenu-root", "submenu-trigger", "group", "group-label", "radio-group", "radio-item", "radio-item-indicator", "checkbox-item", "checkbox-item-indicator", "separator"], false, "Pointer, touch, and keyboard context actions."),
  entry("Dialog", "dialog", "createDialog", "popups", ["trigger", "portal", "backdrop", "viewport", "popup", "title", "description", "close"], false, "Nested-safe modal or non-modal dialog behavior."),
  entry("Drawer", "drawer", "createDrawer", "popups", ["provider", "indent-background", "indent", "trigger", "swipe-area", "portal", "backdrop", "viewport", "popup", "content", "title", "description", "close", "virtual-keyboard-provider"], false, "Dialog semantics with direction-aware swipe dismissal."),
  entry("Field", "field", "createField", "fields", ["root", "label", "control", "description", "item", "error", "validity"], true, "Validation and accessibility state shared by form parts."),
  entry("Fieldset", "fieldset", "createFieldset", "fields", ["root", "legend"], true, "Native grouping and disabled propagation for fields."),
  entry("Form", "form", "createFormFacade", "fields", ["root"], true, "Multi-field validation, submission, reset, and error focus."),
  entry("Input", "input", "createInput", "fields", ["root"], true, "Composable native text input state."),
  entry("Menu", "menu", "createMenu", "collections", ["trigger", "portal", "backdrop", "positioner", "popup", "viewport", "arrow", "item", "link-item", "submenu-root", "submenu-trigger", "group", "group-label", "radio-group", "radio-item", "radio-item-indicator", "checkbox-item", "checkbox-item-indicator", "separator"], false, "Actions, links, choices, groups, and nested submenus."),
  entry("Menubar", "menubar", "createMenubar", "collections", ["root", "item", "trigger", "link", "menu", "separator"], false, "Coordinated horizontal menus with roving focus."),
  entry("Meter", "meter", "createMeter", "controls", ["root", "label", "track", "indicator", "value"], false, "Accessible scalar measurement over a bounded range."),
  entry("NavigationMenu", "navigation-menu", "createNavigationMenu", "collections", ["root", "list", "item", "trigger", "icon", "content", "link", "portal", "backdrop", "positioner", "popup", "arrow", "viewport", "indicator"], false, "Focus-safe site navigation with current links and flyout content."),
  entry("NumberField", "number-field", "createNumberField", "fields", ["root", "scrub-area", "scrub-area-cursor", "group", "decrement", "input", "increment"], true, "Locale-aware nullable numeric entry with zero-seeded stepping."),
  entry("OTPField", "otp-field", "createOtpField", "fields", ["root", "input", "separator", "hidden-input"], true, "One-time-code entry with paste, masking, and autofill projection."),
  entry("Popover", "popover", "createPopover", "popups", ["trigger", "portal", "backdrop", "positioner", "popup", "arrow", "viewport", "title", "description", "close"], false, "Anchored interactive popup content."),
  entry("PreviewCard", "preview-card", "createPreviewCard", "popups", ["trigger", "portal", "backdrop", "positioner", "popup", "arrow", "viewport"], false, "Delayed pointer and focus preview enhancement."),
  entry("Progress", "progress", "createProgress", "controls", ["root", "label", "track", "indicator", "value"], false, "Determinate or indeterminate progress status."),
  entry("Radio", "radio", "createRadioGroup", "controls", ["root", "item", "indicator", "input"], true, "One-of-many radio selection with roving focus."),
  entry("ScrollArea", "scroll-area", "createScrollArea", "utilities", ["root", "viewport", "content", "scrollbar", "thumb", "corner"], false, "Native scrolling with accessible custom controls, zoom preservation, and RTL normalization."),
  entry("Select", "select", "createSelect", "selection", ["label", "trigger", "value", "icon", "portal", "backdrop", "positioner", "popup", "scroll-up-arrow", "arrow", "list", "item", "item-text", "item-indicator", "separator", "group", "group-label", "scroll-down-arrow", "form-control", "hidden-input"], true, "Single or multiple listbox selection."),
  entry("Separator", "separator", "createSeparator", "controls", ["root"], false, "Semantic or decorative horizontal and vertical separation."),
  entry("Slider", "slider", "createSlider", "fields", ["root", "label", "value", "control", "track", "indicator", "thumb", "input"], true, "Single or range values with pointer, keyboard, and collision policies."),
  entry("Switch", "switch", "createSwitch", "controls", ["root", "thumb", "input", "unchecked-input"], true, "Binary on/off setting with checked and unchecked native form projection."),
  entry("Tabs", "tabs", "createTabs", "collections", ["root", "list", "tab", "panel", "indicator"], false, "Manual or automatic tab activation with roving focus."),
  entry("Toast", "toast", "createToastProvider", "utilities", ["provider", "portal", "viewport", "positioner", "root", "content", "title", "description", "action", "close", "arrow"], false, "Queued live notifications with mounted-part ARIA, focus recovery, timers, promises, and swipe."),
  entry("Toggle", "toggle", "createToggle", "controls", ["root"], false, "A two-state pressed button."),
  entry("ToggleGroup", "toggle-group", "createToggleGroup", "controls", ["root", "item"], false, "Single or multiple pressed-button selection."),
  entry("Toolbar", "toolbar", "createToolbar", "collections", ["root", "button", "link", "input", "group", "separator"], false, "A direction-aware collection of common controls."),
  entry("Tooltip", "tooltip", "createTooltip", "popups", ["provider", "trigger", "portal", "positioner", "popup", "arrow", "viewport"], false, "Delayed visual description for an already named trigger."),
] as const;

/** Complete, deeply immutable machine-readable inventory of Clank's headless families. */
export const UI_COMPONENT_CATALOG: readonly UiCatalogEntry[] = deepFreeze(componentCatalog);
/** Derived from the canonical tuple so the runtime count cannot drift. */
export const UI_COMPONENT_COUNT = componentCatalog.length;

/** Looks up a family by canonical name or kebab-case slug. */
export function getUiCatalogEntry<Key extends string>(nameOrSlug: Key): UiCatalogEntryFor<Key> {
  const normalized = nameOrSlug.trim().toLowerCase();
  return UI_COMPONENT_CATALOG.find((candidate) =>
    candidate.name.toLowerCase() === normalized || candidate.slug === normalized
  ) as UiCatalogEntryFor<Key>;
}

function entry<Name extends UiComponentName>(
  name: Name,
  slug: UiComponentContractMap[Name][0],
  factory: UiComponentContractMap[Name][1],
  module: UiComponentContractMap[Name][2],
  parts: readonly string[],
  formAssociated: boolean,
  description: string,
): UiCatalogEntry<Name> {
  return {
    name,
    slug,
    factory,
    module,
    parts,
    formAssociated,
    description,
    referenceUrl: `https://base-ui.com/react/components/${slug}`,
    referenceVersion: BASE_UI_REFERENCE_VERSION,
  } as UiCatalogEntry<Name>;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
