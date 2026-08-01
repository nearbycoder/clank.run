import {
    createAccordion,
    createContextMenu,
    createMenu,
    createMenubar,
    createNavigationMenu,
    createTabs,
    createToolbar,
} from "./ui-collections.js";
import {
    createAvatar,
    createButton,
    createCheckbox,
    createCheckboxGroup,
    createMeter,
    createProgress,
    createRadioGroup,
    createSeparator,
    createSwitch,
    createToggle,
    createToggleGroup,
} from "./ui-controls.js";
import {
    createField,
    createFieldset,
    createFormFacade,
    createInput,
    createNumberField,
    createOtpField,
    createSlider,
} from "./ui-fields.js";
import {
    createAlertDialog,
    createBottomSheet,
    createCollapsible,
    createDialog,
    createDrawer,
    createPopover,
    createPreviewCard,
    createTooltip,
} from "./ui-popups.js";
import { createAutocomplete, createCombobox, createSelect } from "./ui-selection.js";
import { createScrollArea, createToastProvider } from "./ui-utilities.js";
import { createPagination } from "./ui-legacy.js";

/** The upstream release whose component inventory and anatomy Clank tracks. */
export declare const BASE_UI_REFERENCE_VERSION: "1.6.0";
export declare const BASE_UI_REFERENCE_URL: "https://base-ui.com/react/overview/releases/v1-6-0";

/** Canonical relationship between every public family, slug, factory, and module. */
export type UiComponentContractMap = Readonly<{
    readonly Accordion: readonly ["accordion", "createAccordion", "collections"];
    readonly AlertDialog: readonly ["alert-dialog", "createAlertDialog", "popups"];
    readonly Autocomplete: readonly ["autocomplete", "createAutocomplete", "selection"];
    readonly Avatar: readonly ["avatar", "createAvatar", "controls"];
    readonly BottomSheet: readonly ["bottom-sheet", "createBottomSheet", "popups"];
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
    readonly Pagination: readonly ["pagination", "createPagination", "legacy"];
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

export type UiCatalogEntry<Name extends UiComponentName = UiComponentName> = Name extends UiComponentName ? Readonly<{
    name: Name;
    slug: UiComponentContractMap[Name][0];
    factory: UiComponentContractMap[Name][1];
    module: UiComponentContractMap[Name][2];
    parts: readonly string[];
    formAssociated: boolean;
    description: string;
    source: "base-ui" | "clank";
    referenceUrl: string;
    referenceVersion: string;
}> : never;

/** Resolves a canonical family name or slug to its exact catalog entry type. */
export type UiCatalogEntryFor<Key extends string> = Key extends UiComponentName ? UiCatalogEntry<Key> : Key extends UiComponentSlug ? UiCatalogEntry<UiComponentNameForSlug<Key>> : UiCatalogEntry | undefined;

/** Exact controller signature for each named family. */
export type UiComponentFactoryMap = Readonly<{
    readonly Accordion: typeof createAccordion;
    readonly AlertDialog: typeof createAlertDialog;
    readonly Autocomplete: typeof createAutocomplete;
    readonly Avatar: typeof createAvatar;
    readonly BottomSheet: typeof createBottomSheet;
    readonly Button: typeof createButton;
    readonly Checkbox: typeof createCheckbox;
    readonly CheckboxGroup: typeof createCheckboxGroup;
    readonly Collapsible: typeof createCollapsible;
    readonly Combobox: typeof createCombobox;
    readonly ContextMenu: typeof createContextMenu;
    readonly Dialog: typeof createDialog;
    readonly Drawer: typeof createDrawer;
    readonly Field: typeof createField;
    readonly Fieldset: typeof createFieldset;
    readonly Form: typeof createFormFacade;
    readonly Input: typeof createInput;
    readonly Menu: typeof createMenu;
    readonly Menubar: typeof createMenubar;
    readonly Meter: typeof createMeter;
    readonly NavigationMenu: typeof createNavigationMenu;
    readonly NumberField: typeof createNumberField;
    readonly OTPField: typeof createOtpField;
    readonly Pagination: typeof createPagination;
    readonly Popover: typeof createPopover;
    readonly PreviewCard: typeof createPreviewCard;
    readonly Progress: typeof createProgress;
    readonly Radio: typeof createRadioGroup;
    readonly ScrollArea: typeof createScrollArea;
    readonly Select: typeof createSelect;
    readonly Separator: typeof createSeparator;
    readonly Slider: typeof createSlider;
    readonly Switch: typeof createSwitch;
    readonly Tabs: typeof createTabs;
    readonly Toast: typeof createToastProvider;
    readonly Toggle: typeof createToggle;
    readonly ToggleGroup: typeof createToggleGroup;
    readonly Toolbar: typeof createToolbar;
    readonly Tooltip: typeof createTooltip;
}>;

export declare const UI_COMPONENT_FACTORIES: UiComponentFactoryMap;
export declare const UI_COMPONENT_CATALOG: readonly UiCatalogEntry[];
export declare const UI_COMPONENT_COUNT: 39;

export declare function getUiCatalogEntry<Key extends string>(nameOrSlug: Key): UiCatalogEntryFor<Key>;
