import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import * as framework from "../dist/index.js";
import * as ui from "../dist/ui.js";
import {
  BASE_UI_REFERENCE_URL,
  BASE_UI_REFERENCE_VERSION,
  UI_COMPONENT_CATALOG,
  UI_COMPONENT_COUNT,
  UI_COMPONENT_FACTORIES,
  getUiCatalogEntry,
} from "../dist/ui-catalog.js";

const expectedContracts = [
  ["Accordion", "accordion", "createAccordion", "collections"],
  ["AlertDialog", "alert-dialog", "createAlertDialog", "popups"],
  ["Autocomplete", "autocomplete", "createAutocomplete", "selection"],
  ["Avatar", "avatar", "createAvatar", "controls"],
  ["Button", "button", "createButton", "controls"],
  ["Checkbox", "checkbox", "createCheckbox", "controls"],
  ["CheckboxGroup", "checkbox-group", "createCheckboxGroup", "controls"],
  ["Collapsible", "collapsible", "createCollapsible", "popups"],
  ["Combobox", "combobox", "createCombobox", "selection"],
  ["ContextMenu", "context-menu", "createContextMenu", "collections"],
  ["Dialog", "dialog", "createDialog", "popups"],
  ["Drawer", "drawer", "createDrawer", "popups"],
  ["Field", "field", "createField", "fields"],
  ["Fieldset", "fieldset", "createFieldset", "fields"],
  ["Form", "form", "createFormFacade", "fields"],
  ["Input", "input", "createInput", "fields"],
  ["Menu", "menu", "createMenu", "collections"],
  ["Menubar", "menubar", "createMenubar", "collections"],
  ["Meter", "meter", "createMeter", "controls"],
  ["NavigationMenu", "navigation-menu", "createNavigationMenu", "collections"],
  ["NumberField", "number-field", "createNumberField", "fields"],
  ["OTPField", "otp-field", "createOtpField", "fields"],
  ["Popover", "popover", "createPopover", "popups"],
  ["PreviewCard", "preview-card", "createPreviewCard", "popups"],
  ["Progress", "progress", "createProgress", "controls"],
  ["Radio", "radio", "createRadioGroup", "controls"],
  ["ScrollArea", "scroll-area", "createScrollArea", "utilities"],
  ["Select", "select", "createSelect", "selection"],
  ["Separator", "separator", "createSeparator", "controls"],
  ["Slider", "slider", "createSlider", "fields"],
  ["Switch", "switch", "createSwitch", "controls"],
  ["Tabs", "tabs", "createTabs", "collections"],
  ["Toast", "toast", "createToastProvider", "utilities"],
  ["Toggle", "toggle", "createToggle", "controls"],
  ["ToggleGroup", "toggle-group", "createToggleGroup", "controls"],
  ["Toolbar", "toolbar", "createToolbar", "collections"],
  ["Tooltip", "tooltip", "createTooltip", "popups"],
];
const expected = expectedContracts.map(([name]) => name);

test("the public headless catalog covers the exact 37 Base UI families", () => {
  assert.equal(BASE_UI_REFERENCE_VERSION, "1.6.0");
  assert.equal(BASE_UI_REFERENCE_URL, "https://base-ui.com/react/overview/releases/v1-6-0");
  assert.equal(UI_COMPONENT_COUNT, 37);
  assert.equal(UI_COMPONENT_CATALOG.length, 37);
  assert.deepEqual(UI_COMPONENT_CATALOG.map((entry) => entry.name), expected);
  assert.deepEqual(
    UI_COMPONENT_CATALOG.map(({ name, slug, factory, module }) => [name, slug, factory, module]),
    expectedContracts,
  );
  assert.deepEqual(Object.keys(UI_COMPONENT_FACTORIES), expected);
  assert.equal(new Set(UI_COMPONENT_CATALOG.map((entry) => entry.slug)).size, 37);
  assert.equal(new Set(UI_COMPONENT_CATALOG.map((entry) => entry.factory)).size, 37);
  assert.ok(Object.isFrozen(UI_COMPONENT_CATALOG));
  assert.ok(Object.isFrozen(UI_COMPONENT_FACTORIES));
  assert.ok(UI_COMPONENT_CATALOG.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.parts)));
  assert.doesNotThrow(() => JSON.stringify(UI_COMPONENT_CATALOG));

  for (const entry of UI_COMPONENT_CATALOG) {
    assert.equal(typeof UI_COMPONENT_FACTORIES[entry.name], "function", entry.name);
    assert.equal(framework[entry.factory], UI_COMPONENT_FACTORIES[entry.name], entry.name);
    assert.equal(ui[entry.factory], UI_COMPONENT_FACTORIES[entry.name], entry.name);
    assert.equal(getUiCatalogEntry(entry.name), entry);
    assert.equal(getUiCatalogEntry(entry.slug), entry);
    assert.ok(entry.parts.length > 0, entry.name);
    assert.ok(entry.description.endsWith("."), entry.name);
    assert.equal(entry.referenceUrl, `https://base-ui.com/react/components/${entry.slug}`);
    assert.equal(entry.referenceVersion, BASE_UI_REFERENCE_VERSION);
  }
  assert.equal(getUiCatalogEntry("  button  "), getUiCatalogEntry("Button"));
  assert.equal(getUiCatalogEntry("not-a-component"), undefined);

  const button = getUiCatalogEntry("Button");
  assert.throws(() => { UI_COMPONENT_FACTORIES.Button = () => null; }, TypeError);
  assert.throws(() => { button.description = "mutated"; }, TypeError);
  assert.throws(() => { button.parts.push("mutated"); }, TypeError);
  assert.equal(button.description, "Native-first press behavior and agent metadata.");
});

test("every catalog family has a stable package subpath and importable implementation", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const infrastructureSubpaths = [
    "./ui/foundation", "./ui/composition", "./ui/overlay", "./ui/popups",
    "./ui/controls", "./ui/selection", "./ui/collections", "./ui/fields",
    "./ui/utilities", "./ui/catalog", "./ui/legacy",
    "./ui/theme",
  ];
  const expectedUiSubpaths = [
    ...infrastructureSubpaths,
    ...UI_COMPONENT_CATALOG.map((entry) => `./ui/${entry.slug}`),
  ].sort();
  assert.deepEqual(
    Object.keys(packageJson.exports).filter((subpath) => subpath.startsWith("./ui/")).sort(),
    expectedUiSubpaths,
  );
  assert.deepEqual(packageJson.exports["./ui"], {
    types: "./dist/ui.d.ts",
    import: "./dist/ui.js",
  });
  for (const subpath of ["./ui", ...expectedUiSubpaths]) {
    const target = packageJson.exports[subpath];
    assert.deepEqual(Object.keys(target), ["types", "import"], `${subpath} exposes types before import`);
    await access(new URL(`../${target.import}`, import.meta.url));
    await access(new URL(`../${target.types}`, import.meta.url));
  }

  const packageUi = await import("@clank.run/framework/ui");
  const packageCatalog = await import("@clank.run/framework/ui/catalog");
  assert.equal(packageUi.createButton, ui.createButton);
  assert.equal(packageCatalog.UI_COMPONENT_CATALOG, UI_COMPONENT_CATALOG);

  const runtimeModules = new Map();
  for (const subpath of infrastructureSubpaths) {
    if (subpath.endsWith("/catalog")) continue;
    runtimeModules.set(subpath, await import(`@clank.run/framework/${subpath.slice(2)}`));
  }
  const runtimeExports = new Map();
  for (const [subpath, module] of runtimeModules) {
    for (const [name, value] of Object.entries(module)) {
      const occurrences = runtimeExports.get(name) ?? [];
      occurrences.push({ subpath, value });
      runtimeExports.set(name, occurrences);
    }
  }
  for (const [name, occurrences] of runtimeExports) {
    assert.ok(name in packageUi, `${name} is reachable from the UI umbrella`);
    const distinctValues = new Set(occurrences.map(({ value }) => value));
    if (distinctValues.size === 1) assert.equal(packageUi[name], occurrences[0].value, name);
    else {
      assert.ok(["focusableElements", "isFocusable"].includes(name), `unexpected ambiguous export: ${name}`);
      assert.equal(packageUi[name], runtimeModules.get("./ui/foundation")[name], name);
    }
  }

  for (const entry of UI_COMPONENT_CATALOG) {
    const subpath = `./ui/${entry.slug}`;
    assert.ok(packageJson.exports[subpath], `${subpath} is exported`);
    assert.equal(packageJson.exports[subpath].import.startsWith("./dist/ui-"), true, subpath);
    assert.equal(packageJson.exports[subpath].types.endsWith(".d.ts"), true, subpath);
    await access(new URL(`../${packageJson.exports[subpath].import}`, import.meta.url));
    await access(new URL(`../${packageJson.exports[subpath].types}`, import.meta.url));
    const module = await import(`@clank.run/framework/ui/${entry.slug}`);
    assert.equal(module[entry.factory], UI_COMPONENT_FACTORIES[entry.name], subpath);
  }
});

test("catalog anatomy is generated from the live controller manifests", () => {
  for (const entry of UI_COMPONENT_CATALOG) {
    const controller = createCatalogFixture(entry.name);
    try {
      const manifestParts = entry.name === "Toast"
        ? toastManifestParts(controller)
        : controller.manifest().parts.map((part) => part.name);
      assert.deepEqual(manifestParts, entry.parts, `${entry.name} catalog anatomy matches its live manifest`);
    } finally {
      controller.dispose?.();
    }
  }
});

test("the headless library remains dependency-free at source and package boundaries", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(packageJson.devDependencies ?? {}, {});
  assert.deepEqual(packageJson.peerDependencies ?? {}, {});
  assert.deepEqual(packageJson.peerDependenciesMeta ?? {}, {});
  assert.deepEqual(packageJson.optionalDependencies ?? {}, {});
  assert.deepEqual(packageJson.bundleDependencies ?? [], []);
  assert.deepEqual(packageJson.bundledDependencies ?? [], []);
  assert.equal(packageJson.sideEffects, false);

  const modules = [
    "ui.ts", "ui-catalog.ts", "ui-composition.ts", "ui-controls.ts", "ui-fields.ts",
    "ui-foundation.ts", "ui-legacy.ts", "ui-overlay.ts", "ui-popups.ts", "ui-selection.ts",
    "ui-collections.ts", "ui-utilities.ts",
    "ui-theme.ts",
  ];
  for (const filename of modules) {
    for (const extension of [".ts", ".d.ts"]) {
      const sourceFilename = filename.replace(/\.ts$/, extension);
      const source = await readFile(new URL(`../src/${sourceFilename}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
        assert.equal(match[1].startsWith("./"), true, `${filename} imports only Clank-local modules: ${match[1]}`);
      }
    }
  }

  const runtimeQueue = [new URL("../dist/ui.js", import.meta.url)];
  const visitedRuntimeModules = new Set();
  while (runtimeQueue.length > 0) {
    const url = runtimeQueue.pop();
    if (visitedRuntimeModules.has(url.href)) continue;
    visitedRuntimeModules.add(url.href);
    const source = await readFile(url, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.equal(specifier.startsWith("./"), true, `${url.pathname} has no external runtime import: ${specifier}`);
      const dependency = new URL(specifier, url);
      assert.match(dependency.pathname, /\/dist\/[^/]+\.js$/u);
      await access(dependency);
      runtimeQueue.push(dependency);
    }
  }
  assert.ok(visitedRuntimeModules.size >= 16, "the dependency audit traversed the complete UI runtime graph");
});

function createCatalogFixture(name) {
  const item = { value: "one", textValue: "One" };
  const option = { value: "one", label: "One" };
  switch (name) {
    case "Accordion": return framework.createAccordion({ id: "catalog-accordion", items: [item] });
    case "AlertDialog": return framework.createAlertDialog({ id: "catalog-alert-dialog" });
    case "Autocomplete": return framework.createAutocomplete({ id: "catalog-autocomplete", items: [option] });
    case "Avatar": return framework.createAvatar({ id: "catalog-avatar" });
    case "Button": return framework.createButton({ id: "catalog-button" });
    case "Checkbox": return framework.createCheckbox({ id: "catalog-checkbox" });
    case "CheckboxGroup": return framework.createCheckboxGroup({ id: "catalog-checkbox-group", items: [item] });
    case "Collapsible": return framework.createCollapsible({ id: "catalog-collapsible" });
    case "Combobox": return framework.createCombobox({ id: "catalog-combobox", items: [option] });
    case "ContextMenu": return framework.createContextMenu({ id: "catalog-context-menu", items: [item] });
    case "Dialog": return framework.createDialog({ id: "catalog-dialog" });
    case "Drawer": return framework.createDrawer({ id: "catalog-drawer" });
    case "Field": return framework.createField({ id: "catalog-field", defaultValue: "" });
    case "Fieldset": return framework.createFieldset({ id: "catalog-fieldset" });
    case "Form": return framework.createFormFacade({ id: "catalog-form" });
    case "Input": return framework.createInput({ id: "catalog-input" });
    case "Menu": return framework.createMenu({ id: "catalog-menu", items: [item] });
    case "Menubar": return framework.createMenubar({ id: "catalog-menubar", items: [{ ...item, kind: "link", href: "/" }] });
    case "Meter": return framework.createMeter({ id: "catalog-meter" });
    case "NavigationMenu": return framework.createNavigationMenu({ id: "catalog-navigation-menu", items: [{ ...item, kind: "link", href: "/" }] });
    case "NumberField": return framework.createNumberField({ id: "catalog-number-field" });
    case "OTPField": return framework.createOtpField({ id: "catalog-otp-field", length: 6 });
    case "Popover": return framework.createPopover({ id: "catalog-popover" });
    case "PreviewCard": return framework.createPreviewCard({ id: "catalog-preview-card" });
    case "Progress": return framework.createProgress({ id: "catalog-progress" });
    case "Radio": return framework.createRadioGroup({ id: "catalog-radio", items: [item] });
    case "ScrollArea": return framework.createScrollArea({ id: "catalog-scroll-area" });
    case "Select": return framework.createSelect({ id: "catalog-select", items: [option] });
    case "Separator": return framework.createSeparator({ id: "catalog-separator" });
    case "Slider": return framework.createSlider({ id: "catalog-slider" });
    case "Switch": return framework.createSwitch({ id: "catalog-switch" });
    case "Tabs": return framework.createTabs({ id: "catalog-tabs", items: [item] });
    case "Toast": return framework.createToastProvider({ id: "catalog-toast" });
    case "Toggle": return framework.createToggle({ id: "catalog-toggle" });
    case "ToggleGroup": return framework.createToggleGroup({ id: "catalog-toggle-group", items: [item] });
    case "Toolbar": return framework.createToolbar({ id: "catalog-toolbar", items: [{ ...item, kind: "button" }] });
    case "Tooltip": return framework.createTooltip({ id: "catalog-tooltip" });
    default: throw new TypeError(`Missing catalog fixture for ${name}`);
  }
}

function toastManifestParts(provider) {
  const id = provider.manager.add({ title: "Catalog toast" });
  return [
    ...provider.manifest().parts.map((part) => part.name),
    ...provider.manifest(id).parts.map((part) => part.name),
  ];
}
