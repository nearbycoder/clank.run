import test from "node:test";
import assert from "node:assert/strict";
import { signal } from "../dist/core.js";
import {
  createAccordion,
  createContextMenu,
  createMenu,
  createMenubar,
  createNavigationMenu,
  createTabs,
  createToolbar,
} from "../dist/ui-collections.js";

test("accordion supports controlled single and ordered multiple disclosure without obsolete arrow navigation", () => {
  const external = signal("billing");
  const changes = [];
  const controlled = createAccordion({
    id: "settings",
    items: items("profile", "billing", "security"),
    value: () => external.value,
    collapsible: false,
    onValueChange(value, details) { changes.push([value, details.reason]); external.value = value; },
  });
  assert.equal(controlled.trigger("billing")["aria-expanded"](), true);
  assert.equal(controlled.toggle("billing"), false, "non-collapsible single accordions keep their item open");
  controlled.trigger("security").onClick(event());
  assert.equal(external.value, "security");
  assert.deepEqual(changes, [["security", "trigger-press"]]);
  assert.equal(controlled.panel("security").hidden(), false);
  assert.equal(controlled.panel("billing").hidden(), true);

  const arrow = keyEvent("ArrowDown");
  controlled.trigger("security").onKeyDown(arrow);
  assert.equal(arrow.defaultPrevented, false, "accordion arrows stay available to the page");
  assert.equal(controlled.value.value, "security");

  const multiple = createAccordion({
    id: "faq",
    multiple: true,
    items: items("third", "first", "second"),
    defaultValue: ["second"],
  });
  multiple.toggle("third");
  multiple.toggle("first");
  assert.deepEqual(multiple.value.value, ["third", "first", "second"], "open values follow declaration order");
  multiple.toggle("first");
  assert.deepEqual(multiple.value.value, ["third", "second"]);
  assert.equal(multiple.header("third", 4)["aria-level"], 4);
  assert.equal(multiple.manifest().protocol, "clank-ui/1");

  const presenceChanges = [];
  const presence = createAccordion({
    id: "searchable-faq",
    items: items("answer", "details"),
    onValueChange(value, details) { presenceChanges.push([value, details.reason]); },
  });
  assert.equal(presence.isPanelMounted("answer"), false, "closed panels are removable by default");
  assert.equal(presence.isPanelMounted("answer", { keepMounted: true }), true);
  const searchable = presence.panel("answer", { hiddenUntilFound: true });
  assert.equal(presence.isPanelMounted("answer", { hiddenUntilFound: true }), true);
  assert.equal(searchable.hidden(), "until-found");
  searchable.onBeforeMatch(event());
  assert.equal(presence.value.value, "answer");
  assert.equal(searchable.hidden(), false);
  assert.deepEqual(presenceChanges, [["answer", "beforematch"]]);
});

test("tabs separate roving focus from manual activation, keep disabled tabs focusable, and support automatic RTL", () => {
  const focused = [];
  const tabs = createTabs({
    id: "account-tabs",
    items: [
      { value: "general", textValue: "General" },
      { value: "disabled", textValue: "Disabled", disabled: true },
      { value: "security", textValue: "Security" },
    ],
  });
  attach(tabs.tab("general"), focusable("general", focused));
  attach(tabs.tab("disabled"), focusable("disabled", focused));
  attach(tabs.tab("security"), focusable("security", focused));

  const next = keyEvent("ArrowRight");
  tabs.tab("general").onKeyDown(next);
  assert.equal(next.defaultPrevented, true);
  assert.equal(tabs.focusedValue.value, "disabled", "disabled tabs remain roving-focus destinations");
  assert.equal(tabs.value.value, "general", "manual activation does not select on an arrow");
  assert.equal(tabs.tab("disabled").disabled, undefined);
  assert.equal(tabs.tab("disabled")["aria-disabled"](), true);

  const activate = keyEvent("Enter");
  tabs.tab("security").onKeyDown(activate);
  assert.equal(tabs.value.value, "security");
  assert.equal(tabs.panel("security").hidden(), false);
  assert.equal(tabs.indicator().style["--clank-tabs-active-index"](), 2);
  assert.deepEqual(focused, ["disabled"]);

  const automatic = createTabs({
    id: "rtl-tabs",
    activationMode: "automatic",
    direction: "rtl",
    items: items("one", "two", "three"),
  });
  attach(automatic.tab("one"), focusable("one", []));
  attach(automatic.tab("three"), focusable("three", []));
  automatic.tab("one").onKeyDown(keyEvent("ArrowRight"));
  assert.equal(automatic.value.value, "three", "RTL ArrowRight moves logically backward with looping");
  assert.equal(automatic.manifest().state.activationMode, "automatic");

  const nullable = createTabs({ id: "optional-tabs", items: items("one", "two"), defaultValue: null });
  assert.equal(nullable.value.value, null);
  assert.equal(nullable.panel("one").hidden(), true);
  assert.equal(nullable.indicator().style["--clank-tabs-active-index"](), -1);
  assert.equal(nullable.select("one"), true);
  assert.equal(nullable.select(null), true);
  assert.equal(nullable.tab("one")["aria-selected"](), false);
  tabs.dispose();
  automatic.dispose();
  nullable.dispose();
});

test("tabs report uncancelable automatic fallbacks, preserve controlled values, and expose panel mounting", async () => {
  const firstDisabled = signal(false);
  const changes = [];
  const tabs = createTabs({
    id: "fallback-tabs",
    items: [
      { value: "first", textValue: "First", disabled: () => firstDisabled.value },
      { value: "second", textValue: "Second" },
    ],
    onValueChange(value, details) {
      details.cancel();
      changes.push([value, details.reason, details.canceled]);
    },
  });
  const first = tabs.tab("first");
  const second = tabs.tab("second");
  attach(first, focusable("first", []));
  attach(second, focusable("second", []));
  await Promise.resolve();
  assert.deepEqual(changes, [["first", "initial", false]], "initial selection is reported and cannot be canceled");
  assert.equal(tabs.isPanelMounted("first"), true);
  assert.equal(tabs.isPanelMounted("second"), false);
  assert.equal(tabs.isPanelMounted("second", { keepMounted: true }), true);
  assert.equal(tabs.panel("second", { keepMounted: true })["data-mounted"](), "");

  firstDisabled.value = true;
  assert.equal(tabs.value.value, "second");
  assert.deepEqual(changes.at(-1), ["second", "disabled", false]);
  second.ref(null);
  await Promise.resolve();
  assert.equal(tabs.value.value, null, "removing the selected tab falls back to null when no enabled mounted tab remains");
  assert.deepEqual(changes.at(-1), [null, "missing", false]);
  tabs.dispose();

  const missingChanges = [];
  const missing = createTabs({
    id: "missing-default-tabs",
    items: items("one", "two"),
    defaultValue: "not-mounted",
    onValueChange(value, details) { missingChanges.push([value, details.reason]); },
  });
  attach(missing.tab("one"), focusable("one", []));
  await Promise.resolve();
  assert.equal(missing.value.value, "one");
  assert.deepEqual(missingChanges, [["one", "missing"]]);
  missing.dispose();

  const external = signal("one");
  const controlledDisabled = signal(false);
  const controlledChanges = [];
  const controlled = createTabs({
    id: "controlled-fallback-tabs",
    value: () => external.value,
    items: [
      { value: "one", textValue: "One", disabled: () => controlledDisabled.value },
      { value: "two", textValue: "Two" },
    ],
    onValueChange(value, details) { controlledChanges.push([value, details.reason]); },
  });
  controlledDisabled.value = true;
  assert.equal(controlled.value.value, "one", "controlled disabled values remain owned by the caller");
  external.value = "temporarily-missing";
  assert.equal(controlled.value.value, "temporarily-missing", "controlled mounting gaps do not throw or auto-fallback");
  assert.deepEqual(controlledChanges, []);
  controlled.dispose();

  const immediateChanges = [];
  const immediate = createTabs({
    id: "immediate-tabs",
    items: items("one", "two"),
    onValueChange(value, details) { immediateChanges.push([value, details.reason]); },
  });
  assert.equal(immediate.select("two"), true);
  await Promise.resolve();
  assert.equal(immediate.value.value, "two", "an explicit transition supersedes pending implicit selection");
  assert.deepEqual(immediateChanges, [["two", "programmatic"]]);
  immediate.dispose();

  const preMountDisabled = signal(false);
  const preMountChanges = [];
  const preMount = createTabs({
    id: "pre-mount-tabs",
    items: [
      { value: "one", textValue: "One", disabled: () => preMountDisabled.value },
      { value: "two", textValue: "Two" },
    ],
    onValueChange(value, details) { preMountChanges.push([value, details.reason]); },
  });
  preMountDisabled.value = true;
  await Promise.resolve();
  assert.equal(preMount.value.value, "two");
  assert.deepEqual(preMountChanges, [["two", "initial"]], "pre-mount implicit fallback remains one initial transition");
  preMount.dispose();

  const onlyChanges = [];
  const only = createTabs({
    id: "removed-only-tab",
    items: items("only"),
    onValueChange(value, details) { onlyChanges.push([value, details.reason]); },
  });
  only.list().ref({});
  const onlyTab = only.tab("only");
  onlyTab.ref(focusable("only", []));
  await Promise.resolve();
  onlyTab.ref(null);
  await Promise.resolve();
  assert.equal(only.value.value, null);
  assert.deepEqual(onlyChanges, [["only", "initial"], [null, "missing"]]);
  only.dispose();
});

test("menu exposes item/link/checkbox/radio/group/separator parts and cancelable state", () => {
  const actions = [];
  const menu = createMenu({
    id: "document-menu",
    label: "Document",
    closeOnClick: true,
    items: [
      { value: "new", textValue: "New" },
      { value: "blocked", textValue: "Blocked", disabled: true },
      { kind: "link", value: "docs", textValue: "Documentation", href: "/docs" },
      { kind: "checkbox", value: "autosave", textValue: "Autosave", closeOnClick: false },
      { kind: "radio", group: "theme", value: "light", textValue: "Light" },
      { kind: "radio", group: "theme", value: "dark", textValue: "Dark" },
    ],
    onAction(value, details) {
      actions.push([value, details.reason]);
      if (value === "new" && details.reason === "programmatic") details.cancel();
    },
  });
  assert.equal(menu.popup().role, "menu");
  assert.equal(menu.popup()["aria-label"], "Document");
  assert.equal(menu.portal()["data-clank-part"], "portal");
  assert.equal(menu.backdrop()["data-clank-part"], "backdrop");
  assert.equal(menu.viewport()["data-clank-part"], "viewport");
  assert.equal(menu.link("docs").href, "/docs");
  assert.equal(menu.link("docs")["data-clank-part"], "link", "the legacy link part hook remains stable");
  assert.equal(menu.linkItem("docs")["data-clank-part"], "link-item");
  assert.equal(menu.checkboxItem("autosave").role, "menuitemcheckbox");
  assert.equal(menu.radioItem("dark").role, "menuitemradio");
  const checkboxIndicator = menu.checkboxItemIndicator("autosave");
  assert.equal(checkboxIndicator.hidden(), true);
  assert.equal(checkboxIndicator["data-unchecked"](), "");
  assert.equal(menu.radioGroup("theme", { label: "Theme" }).role, "group");
  const radioIndicator = menu.radioItemIndicator("dark", { keepMounted: true });
  assert.equal(radioIndicator.hidden(), false);
  assert.equal(radioIndicator["data-unchecked"](), "");
  assert.equal(menu.group({ label: "Theme" }).role, "group");
  assert.equal(menu.separator().role, "separator");
  assert.equal(menu.activate("new"), false, "actions may cancel activation");

  menu.show("programmatic", undefined, false);
  assert.equal(menu.open.value, true);
  assert.equal(menu.activate("autosave", "item-press"), true);
  assert.deepEqual(menu.checkedValues.value, ["autosave"]);
  assert.equal(checkboxIndicator.hidden(), false);
  assert.equal(checkboxIndicator["data-checked"](), "");
  assert.equal(menu.open.value, true, "per-item closeOnClick can keep a selectable menu open");
  assert.equal(menu.selectRadio("dark"), true);
  assert.equal(menu.radioValues.value.theme, "dark");
  assert.equal(menu.radioGroup("theme")["data-value"](), "dark");
  assert.equal(radioIndicator["data-checked"](), "");
  menu.selectRadio("light");
  assert.equal(menu.radioValues.value.theme, "light");
  assert.throws(() => menu.checkboxItem("new"), /checkbox/);
  assert.throws(() => menu.radioGroup("missing"), /requires a group/);
  assert.throws(() => menu.radioItemIndicator("new"), /radio/);
  assert.throws(() => createMenu({ id: "unsafe", items: [{ kind: "link", value: "x", textValue: "X", href: "javascript:alert(1)" }] }), /safe/);
  assert.doesNotThrow(() => JSON.stringify(menu.manifest()));
  assert.deepEqual(actions.slice(0, 2), [["new", "programmatic"], ["autosave", "item-press"]]);
  menu.dispose();
});

test("menu keyboard navigation skips disabled items, performs typeahead, and closes on Tab", () => {
  const focused = [];
  const changes = [];
  const menu = createMenu({
    id: "commands",
    items: [
      { value: "alpha", textValue: "Alpha" },
      { value: "beta", textValue: "Beta", disabled: true },
      { value: "charlie", textValue: "Charlie" },
      { value: "copy", textValue: "Copy" },
    ],
    onOpenChange(open, details) { changes.push([open, details.reason]); },
  });
  for (const value of ["alpha", "beta", "charlie", "copy"]) attach(menu.item(value), focusable(value, focused));
  menu.show();
  assert.equal(menu.highlightedValue.value, "alpha");
  const down = keyEvent("ArrowDown");
  menu.popup().onKeyDown(down);
  assert.equal(menu.highlightedValue.value, "charlie");
  menu.popup().onKeyDown(keyEvent("c"));
  assert.equal(menu.highlightedValue.value, "copy", "repeated initial letters cycle matches");
  const tab = keyEvent("Tab");
  menu.popup().onKeyDown(tab);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(menu.open.value, false);
  assert.deepEqual(changes.at(-1), [false, "focus-out"], "Tab closes as focus-out so focus restoration stays disabled");
  assert.ok(focused.includes("charlie"));
  menu.dispose();
});

test("canceling menu open leaves highlight and focus untouched", async () => {
  const focused = [];
  const menu = createMenu({
    id: "canceled-menu",
    items: items("one", "two"),
    onOpenChange(open, details) { if (open) details.cancel(); },
  });
  attach(menu.item("one"), focusable("one", focused));
  assert.equal(menu.isMounted(), false);
  assert.equal(menu.isMounted({ keepMounted: true }), true);
  assert.equal(menu.portal({ keepMounted: true })["data-mounted"](), "");
  assert.equal(menu.show(), false);
  await Promise.resolve();
  assert.equal(menu.open.value, false);
  assert.equal(menu.highlightedValue.value, null);
  assert.deepEqual(focused, []);
  menu.dispose();
});

test("nested menus anchor to their trigger, hover with grace, and use RTL-aware return keys", async () => {
  const childFocused = [];
  const parentFocused = [];
  const child = createMenu({ id: "share-menu", direction: "rtl", items: items("email", "copy") });
  attach(child.item("email"), focusable("email", childFocused));
  const parent = createMenu({
    id: "actions-menu",
    direction: "rtl",
    items: [{ kind: "submenu", value: "share", textValue: "Share", menu: child, delay: 0, closeDelay: 5 }],
  });
  const trigger = focusable("share", parentFocused);
  const triggerProps = parent.submenuTrigger("share");
  attach(triggerProps, trigger);
  assert.equal(parent.submenuRoot("share"), child);
  assert.throws(() => parent.submenuRoot("missing"), /does not contain value/);
  assert.equal(child.triggerElement.value, trigger, "the child positioner uses its submenu trigger as anchor");
  const open = keyEvent("ArrowLeft");
  triggerProps.onKeyDown(open);
  assert.equal(open.defaultPrevented, true);
  assert.equal(child.open.value, true);
  assert.equal(child.highlightedValue.value, "email");
  const close = keyEvent("ArrowRight");
  child.popup().onKeyDown(close);
  assert.equal(child.open.value, false);
  assert.deepEqual(parentFocused, ["share"]);

  triggerProps.onPointerMove(pointerEvent({ currentTarget: trigger }));
  assert.equal(child.open.value, true, "submenus open on pointer movement by default");
  triggerProps.onPointerLeave(pointerEvent({ currentTarget: trigger }));
  child.popup().onPointerEnter(pointerEvent());
  await delay(8);
  assert.equal(child.open.value, true, "entering the child popup cancels the pointer grace close");
  child.popup().onPointerLeave(pointerEvent());
  await delay(8);
  assert.equal(child.open.value, false);
  parent.dispose();
  child.dispose();
});

test("a canceled submenu switch preserves its sibling, anchor, and parent bookkeeping", () => {
  const focused = [];
  const accepted = createMenu({ id: "accepted-child", items: items("one") });
  const rejected = createMenu({
    id: "rejected-child",
    items: items("two"),
    onOpenChange(open, details) { if (open) details.cancel(); },
  });
  const parent = createMenu({
    id: "guarded-parent-menu",
    items: [
      { kind: "submenu", value: "accepted", textValue: "Accepted", menu: accepted, delay: 0 },
      { kind: "submenu", value: "rejected", textValue: "Rejected", menu: rejected, delay: 0 },
    ],
  });
  attach(parent.submenuTrigger("accepted"), focusable("accepted", focused));
  const rejectedTrigger = parent.submenuTrigger("rejected");
  attach(rejectedTrigger, focusable("rejected", focused));
  const priorAnchor = rejected.triggerElement.value;

  assert.equal(parent.openSubmenu("accepted", undefined, false), true);
  rejectedTrigger.onPointerMove(pointerEvent({ currentTarget: priorAnchor }));
  assert.equal(accepted.open.value, true, "the accepted sibling remains open");
  assert.equal(rejected.open.value, false);
  assert.equal(rejected.triggerElement.value, priorAnchor, "a rejected open preserves its prior anchor");

  rejected.popup().onKeyDown(keyEvent("ArrowLeft"));
  assert.deepEqual(focused, [], "a rejected child does not retain parent keyboard bookkeeping");
  parent.dispose();
  accepted.dispose();
  rejected.dispose();
});

test("context menu right-click uses pointer coordinates and touch movement cancels long press", async () => {
  const context = createContextMenu({ id: "canvas-menu", longPressDelay: 8, longPressTolerance: 4, items: items("paste") });
  const target = context.target();
  target.ref({ ownerDocument: null });
  const rightClick = pointerEvent({ clientX: 42, clientY: 73 });
  target.onContextMenu(rightClick);
  assert.equal(rightClick.defaultPrevented, true);
  assert.equal(context.open.value, true);
  assert.equal(context.portal()["data-clank-part"], "portal");
  assert.equal(context.backdrop()["data-clank-part"], "backdrop");
  assert.equal(context.viewport()["data-clank-part"], "viewport");
  assert.deepEqual(context.triggerElement.value.getBoundingClientRect().toJSON(), { x: 42, y: 73, width: 0, height: 0 });
  context.hide();

  target.onPointerDown(pointerEvent({ pointerType: "touch", isPrimary: true, pointerId: 2, clientX: 1, clientY: 1 }));
  target.onPointerMove(pointerEvent({ pointerType: "touch", pointerId: 2, clientX: 20, clientY: 1 }));
  await delay(15);
  assert.equal(context.open.value, false, "moving beyond tolerance cancels long press");

  target.onPointerDown(pointerEvent({ pointerType: "touch", isPrimary: true, pointerId: 3, clientX: 5, clientY: 6 }));
  await delay(15);
  assert.equal(context.open.value, true);
  const click = event();
  target.onClick(click);
  assert.equal(click.defaultPrevented, true, "the synthetic post-long-press click is suppressed once");
  assert.equal(context.manifest().component, "ContextMenu");
  assert.equal(context.manifest().parts.some((part) => part.name === "viewport"), false, "ContextMenu advertises its canonical v1.6 anatomy");
  context.dispose();

  const rejected = createContextMenu({
    id: "rejected-canvas-menu",
    longPressDelay: 1,
    items: items("paste"),
    onOpenChange(open, details) { if (open) details.cancel(); },
  });
  const rejectedTarget = rejected.target();
  const rejectedElement = { ownerDocument: null };
  rejectedTarget.ref(rejectedElement);
  rejectedTarget.onPointerDown(pointerEvent({ pointerType: "touch", isPrimary: true, pointerId: 4, clientX: 2, clientY: 3 }));
  await delay(5);
  assert.equal(rejected.open.value, false);
  assert.equal(rejected.triggerElement.value, rejectedElement, "a vetoed long press restores the prior anchor");
  const ordinaryClick = event();
  rejectedTarget.onClick(ordinaryClick);
  assert.equal(ordinaryClick.defaultPrevented, false, "a vetoed long press cannot swallow the following click");
  rejected.dispose();
});

test("menubar coordinates one menu, horizontal RTL roving, links, and nested popup focus", () => {
  const focused = [];
  const menubar = createMenubar({
    id: "app-menubar",
    direction: "rtl",
    items: [
      { value: "file", textValue: "File", items: items("new", "open") },
      { value: "edit", textValue: "Edit", items: items("undo", "redo") },
      { kind: "link", value: "help", textValue: "Help", href: "/help" },
    ],
  });
  for (const value of ["file", "edit", "help"]) attach(menubar.item(value), focusable(value, focused));
  assert.equal(menubar.root().role, "menubar");
  assert.equal(menubar.link("help").href, "/help");
  menubar.openMenu("file", "programmatic", undefined, false);
  assert.equal(menubar.value.value, "file");
  assert.equal(menubar.menu("file").open.value, true);
  const rtlNext = keyEvent("ArrowLeft");
  menubar.trigger("file").onKeyDown(rtlNext);
  assert.equal(menubar.focusedValue.value, "edit");
  assert.equal(menubar.value.value, "edit", "moving while open switches the active menu");
  assert.equal(menubar.menu("file").open.value, false);
  assert.equal(menubar.menu("edit").open.value, true);
  assert.equal(menubar.separator()["aria-orientation"], "vertical");
  assert.equal(menubar.manifest().protocol, "clank-ui/1");
  menubar.dispose();
});

test("menubar keeps its child popup unchanged when a parent transition is canceled", () => {
  let blockedValue;
  const menubar = createMenubar({
    id: "guarded-menubar",
    onValueChange(value, details) { if (value === blockedValue) details.cancel(); },
    items: [
      { value: "file", textValue: "File", items: items("new") },
      { value: "edit", textValue: "Edit", items: items("undo") },
    ],
  });

  assert.equal(menubar.openMenu("file", "programmatic", undefined, false), true);
  assert.equal(menubar.menu("file").open.value, true);

  blockedValue = "edit";
  assert.equal(menubar.openMenu("edit", "programmatic", undefined, false), false);
  assert.equal(menubar.value.value, "file");
  assert.equal(menubar.menu("file").open.value, true, "the accepted child stays open");
  assert.equal(menubar.menu("edit").open.value, false, "the rejected child never opens");

  blockedValue = null;
  assert.equal(menubar.closeMenu(), false);
  assert.equal(menubar.value.value, "file");
  assert.equal(menubar.menu("file").open.value, true, "a rejected close preserves the child popup");
  menubar.dispose();
});

test("navigation menu supports controlled flyouts, current links, content regions, and Tailwind hooks", () => {
  const external = signal(null);
  const navigation = createNavigationMenu({
    id: "primary-nav",
    label: "Primary",
    value: () => external.value,
    onValueChange(value) { external.value = value; },
    items: [
      { value: "products", textValue: "Products" },
      { value: "company", textValue: "Company" },
      { kind: "link", value: "docs", textValue: "Docs", href: "/docs", current: "page" },
    ],
  });
  const productTrigger = navigation.trigger("products");
  const productElement = focusable("products", []);
  attach(productTrigger, productElement);
  productTrigger.onClick(event());
  assert.equal(external.value, "products");
  assert.equal(productTrigger["aria-expanded"](), true);
  assert.equal(navigation.icon("products")["data-open"](), "");
  assert.equal(navigation.icon("products")["data-clank-part"], "icon");
  assert.equal(navigation.portal()["data-clank-part"], "portal");
  assert.equal(navigation.content("products").role, "region");
  assert.equal(navigation.content("company").hidden(), true);
  assert.equal(navigation.link("docs")["aria-current"], "page");
  navigation.link("docs").onClick(event());
  assert.equal(external.value, "products", "navigation links keep an open flyout by default");
  assert.equal(navigation.indicator().style["--clank-navigation-menu-active-index"](), 0);
  assert.equal(navigation.popup().role, "navigation");
  assert.equal(navigation.popup()["aria-label"], "Primary", "popup landmarks do not synthesize an English suffix");
  navigation.popup().onKeyDown(keyEvent("Escape"));
  assert.equal(external.value, null);
  assert.equal(navigation.root().role, "navigation");
  assert.equal(navigation.manifest().state.value, null);
  assert.throws(() => navigation.icon("docs"), /requires a trigger/);
  navigation.dispose();
  assert.throws(() => createNavigationMenu({ id: "bad-delay", openDelay: -1, items: items("one") }), /non-negative/);
});

test("navigation menu link dismissal is opt-in", () => {
  const navigation = createNavigationMenu({
    id: "link-policy-nav",
    items: [
      { value: "products", textValue: "Products" },
      { kind: "link", value: "pricing", textValue: "Pricing", href: "/pricing", closeOnClick: true },
    ],
  });
  navigation.open("products");
  navigation.link("pricing").onClick(event());
  assert.equal(navigation.value.value, null);
  navigation.dispose();
});

test("navigation hover keeps document focus and external focus dismisses the flyout", async () => {
  const listeners = new Map();
  const document = {
    activeElement: null,
    defaultView: {},
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, dispatched) { for (const listener of [...(listeners.get(name) ?? [])]) listener(dispatched); },
  };
  const unrelated = { ownerDocument: document, isConnected: true, focus() { document.activeElement = this; } };
  const outside = { ownerDocument: document, isConnected: true, focus() { document.activeElement = this; } };
  const trigger = {
    ownerDocument: document,
    isConnected: true,
    focus() { document.activeElement = this; },
    contains(target) { return target === this; },
  };
  const popupElement = {
    ownerDocument: document,
    isConnected: true,
    children: [],
    querySelectorAll() { return []; },
    contains(target) { return target === this; },
    focus() { document.activeElement = this; },
  };
  unrelated.focus();
  const navigation = createNavigationMenu({ id: "focus-nav", items: items("products"), openDelay: 0 });
  navigation.trigger("products").ref(trigger);
  const cleanupPopup = navigation.popup().use(popupElement);
  navigation.open("products", "hover");
  await Promise.resolve();
  assert.equal(document.activeElement, unrelated, "pointer hover must not autofocus navigation content");

  outside.focus();
  document.dispatch("focusin", event({ target: outside, currentTarget: document, composedPath: () => [outside] }));
  assert.equal(navigation.value.value, null, "focus leaving the navigation tree dismisses its flyout");
  assert.equal(document.activeElement, outside);
  cleanupPopup();
  navigation.dispose();
});

test("canceling navigation keyboard open does not schedule content focus", async () => {
  const focused = [];
  const navigation = createNavigationMenu({
    id: "canceled-navigation",
    items: items("products"),
    onValueChange(value, details) { if (value !== null) details.cancel(); },
  });
  navigation.content("products").ref({
    ownerDocument: null,
    querySelectorAll() { return [focusable("content-link", focused)]; },
  });
  const key = keyEvent("ArrowDown");
  navigation.trigger("products").onKeyDown(key);
  await Promise.resolve();
  assert.equal(key.defaultPrevented, true);
  assert.equal(navigation.value.value, null);
  assert.deepEqual(focused, []);
  navigation.dispose();
});

test("canceling navigation changes preserves the accepted popup anchor", () => {
  const navigation = createNavigationMenu({
    id: "guarded-navigation-anchor",
    onValueChange(value, details) { if (value === "company") details.cancel(); },
    items: items("products", "company"),
  });
  const view = fakeView();
  navigation.trigger("products").ref(geometryElement(view, { left: 10, right: 90, top: 0, bottom: 24, width: 80, height: 24 }));
  navigation.trigger("company").ref(geometryElement(view, { left: 100, right: 220, top: 0, bottom: 24, width: 120, height: 24 }));

  assert.equal(navigation.open("products"), true);
  const positioner = navigation.positioner();
  const anchorWidth = () => positioner.style()["--clank-anchor-width"]();
  assert.equal(anchorWidth(), "80px");
  assert.equal(navigation.open("company"), false);
  assert.equal(navigation.value.value, "products");
  assert.equal(anchorWidth(), "80px", "a rejected item cannot re-anchor the open flyout");
  navigation.dispose();
});

test("navigation and toolbar recover reactive roving focus and navigation geometry follows mounted parts", () => {
  const productDisabled = signal(false);
  const view = fakeView();
  const navigation = createNavigationMenu({
    id: "measured-nav",
    popupLabel: "Product navigation",
    items: [
      { value: "products", textValue: "Products", disabled: () => productDisabled.value },
      { value: "company", textValue: "Company" },
    ],
  });
  const list = geometryElement(view, { left: 10, top: 20, width: 300, height: 40 });
  const product = geometryElement(view, { left: 30, top: 25, width: 80, height: 24 });
  const company = geometryElement(view, { left: 130, top: 25, width: 90, height: 24 });
  const productContent = geometryElement(view, { left: 0, top: 0, width: 320, height: 180 });
  const companyContent = geometryElement(view, { left: 0, top: 0, width: 420, height: 240 });
  navigation.list().ref(list);
  navigation.trigger("products").ref(product);
  navigation.trigger("company").ref(company);
  navigation.content("products").ref(productContent);
  navigation.content("company").ref(companyContent);
  const indicator = geometryElement(view, { left: 0, top: 0, width: 0, height: 0 });
  const viewport = geometryElement(view, { left: 0, top: 0, width: 0, height: 0 });
  const unmountIndicator = navigation.indicator().use(indicator);
  const unmountViewport = navigation.viewport().use(viewport);

  navigation.open("products");
  assert.equal(indicator.style.values.get("--clank-navigation-menu-indicator-left"), "20px");
  assert.equal(indicator.style.values.get("--clank-navigation-menu-indicator-width"), "80px");
  assert.equal(viewport.style.values.get("--clank-navigation-menu-viewport-width"), "320px");
  assert.equal(viewport.style.values.get("--clank-navigation-menu-viewport-height"), "180px");
  assert.equal(navigation.popup()["aria-label"], "Product navigation");
  assert.equal(navigation.trigger("products").tabIndex(), 0);

  productDisabled.value = true;
  assert.equal(navigation.trigger("products").tabIndex(), -1);
  assert.equal(navigation.trigger("company").tabIndex(), 0);
  assert.equal(navigation.focusedValue.value, "company");
  navigation.open("company");
  assert.equal(indicator.style.values.get("--clank-navigation-menu-indicator-left"), "120px");
  assert.equal(viewport.style.values.get("--clank-navigation-menu-viewport-width"), "420px");

  const boldDisabled = signal(false);
  const toolbarDisabled = signal(false);
  const toolbar = createToolbar({
    id: "reactive-toolbar",
    disabled: () => toolbarDisabled.value,
    loopFocus: true,
    items: [
      { value: "bold", textValue: "Bold", disabled: () => boldDisabled.value, focusableWhenDisabled: false },
      { value: "underline", textValue: "Underline" },
    ],
  });
  assert.equal(toolbar.button("bold").tabIndex(), 0);
  boldDisabled.value = true;
  assert.equal(toolbar.button("bold").tabIndex(), -1);
  assert.equal(toolbar.button("underline").tabIndex(), 0);
  assert.equal(toolbar.focusedValue.value, "underline");
  toolbarDisabled.value = true;
  assert.equal(toolbar.button("underline").tabIndex(), 0, "toolbar buttons remain focusable while disabled by default");
  assert.equal(toolbar.button("underline").disabled(), false);
  assert.equal(toolbar.button("underline")["data-focusable"](), "");
  assert.equal(toolbar.root()["aria-disabled"](), true);
  assert.equal(toolbar.root()["data-disabled"](), "");
  assert.equal(toolbar.press("underline"), false);

  const vertical = createNavigationMenu({
    id: "vertical-rtl-nav",
    orientation: "vertical",
    direction: "rtl",
    items: items("account", "billing"),
  });
  const openAcrossAxis = keyEvent("ArrowLeft");
  vertical.trigger("account").onKeyDown(openAcrossAxis);
  assert.equal(openAcrossAxis.defaultPrevented, true);
  assert.equal(vertical.value.value, "account", "vertical RTL navigation opens toward logical inline-end");
  vertical.dispose();

  unmountViewport();
  unmountIndicator();
  navigation.dispose();
});

test("toolbar roves enabled controls in RTL, preserves input editing keys, and exposes semantic groups", () => {
  const focused = [];
  const presses = [];
  const toolbar = createToolbar({
    id: "editor-toolbar",
    direction: "rtl",
    label: "Editor",
    items: [
      { value: "bold", textValue: "Bold", onPress(details) { presses.push(details.reason); } },
      { value: "italic", textValue: "Italic", disabled: true, focusableWhenDisabled: false },
      { kind: "input", value: "search", textValue: "Search", type: "search", placeholder: "Find" },
      { kind: "link", value: "help", textValue: "Help", href: "/help" },
      { kind: "group", value: "format", textValue: "Format", label: "Formatting" },
      { kind: "separator", value: "rule", textValue: "Rule" },
    ],
  });
  for (const value of ["bold", "italic", "search", "help"]) {
    const props = value === "search" ? toolbar.input(value) : value === "help" ? toolbar.link(value) : toolbar.button(value);
    attach(props, focusable(value, focused));
  }
  const rtlNext = keyEvent("ArrowLeft");
  toolbar.button("bold").onKeyDown(rtlNext);
  assert.equal(toolbar.focusedValue.value, "search", "disabled controls are skipped");
  const editing = keyEvent("ArrowLeft");
  toolbar.input("search").onKeyDown(editing);
  assert.equal(editing.defaultPrevented, false, "text editing arrows are not intercepted");
  assert.equal(toolbar.input("search").placeholder, "Find");
  assert.equal(toolbar.link("help").href, "/help");
  assert.equal(toolbar.group("format").role, "group");
  assert.equal(toolbar.separator("rule")["aria-orientation"], "vertical");
  toolbar.button("bold").onClick(event());
  assert.deepEqual(presses, ["press"]);
  assert.equal(toolbar.root()["aria-orientation"], "horizontal");
  assert.doesNotThrow(() => JSON.stringify(toolbar.manifest()));
  assert.deepEqual(focused, ["search"]);
});

test("toolbar disabled groups propagate while buttons and inputs opt into focusability", () => {
  const groupDisabled = signal(true);
  const presses = [];
  const toolbar = createToolbar({
    id: "grouped-toolbar",
    items: [
      { value: "currency", textValue: "Currency", group: "numbers", onPress() { presses.push("currency"); } },
      { kind: "input", value: "amount", textValue: "Amount", group: "numbers", focusableWhenDisabled: false },
      { kind: "link", value: "help", textValue: "Help", href: "/help", group: "numbers" },
      { kind: "group", value: "numbers", textValue: "Numbers", label: "Number formatting", disabled: () => groupDisabled.value },
    ],
  });
  const button = toolbar.button("currency");
  assert.equal(toolbar.group("numbers")["aria-disabled"](), true);
  assert.equal(button["aria-disabled"](), true);
  assert.equal(button.disabled(), false, "focusable disabled buttons avoid the native disabled attribute");
  assert.equal(button["data-focusable"](), "");
  assert.equal(button.tabIndex(), 0);
  assert.equal(toolbar.input("amount").disabled(), true);
  assert.equal(toolbar.input("amount").tabIndex(), -1);
  assert.equal(toolbar.link("help").tabIndex(), -1);
  assert.equal(toolbar.press("currency"), false);

  groupDisabled.value = false;
  assert.equal(toolbar.group("numbers")["aria-disabled"](), undefined);
  assert.equal(button["aria-disabled"](), undefined);
  assert.equal(toolbar.press("currency"), true);
  assert.deepEqual(presses, ["currency"]);
  assert.throws(() => createToolbar({
    id: "invalid-group-toolbar",
    items: [{ value: "orphan", textValue: "Orphan", group: "missing" }],
  }), /control group/);
});

test("toolbar canceled presses prevent native submit and reset without stopping propagation", () => {
  const toolbar = createToolbar({
    id: "form-toolbar",
    items: [
      { value: "save", textValue: "Save", type: "submit", onPress(details) { details.cancel(); } },
      { value: "clear", textValue: "Clear", type: "reset", onPress(details) { details.cancel(); } },
      { value: "continue", textValue: "Continue", type: "submit" },
    ],
  });

  for (const value of ["save", "clear"]) {
    let propagationStops = 0;
    const click = event({ stopPropagation() { propagationStops += 1; } });
    toolbar.button(value).onClick(click);
    assert.equal(click.defaultPrevented, true, `${value} native form default is canceled`);
    assert.equal(propagationStops, 0, `${value} click continues to bubble`);
  }

  const accepted = event();
  toolbar.button("continue").onClick(accepted);
  assert.equal(accepted.defaultPrevented, false, "an accepted submit keeps its native default");
});

test("collection manifests expose complete part anatomy and conservatively classify mutations", () => {
  const child = createMenu({ id: "manifest-child", items: items("nested") });
  const menu = createMenu({
    id: "manifest-menu",
    items: [
      { kind: "link", value: "link", textValue: "Link", href: "/" },
      { kind: "checkbox", value: "check", textValue: "Check" },
      { kind: "radio", group: "choice", value: "radio", textValue: "Radio" },
      { kind: "submenu", value: "more", textValue: "More", menu: child },
    ],
  });
  const menuManifest = menu.manifest();
  const menuParts = new Set(menuManifest.parts.map((part) => part.name));
  for (const part of [
    "portal", "backdrop", "positioner", "popup", "viewport", "arrow", "link-item",
    "checkbox-item-indicator", "radio-group", "radio-item-indicator", "submenu-root", "submenu-trigger",
  ]) assert.equal(menuParts.has(part), true, `Menu manifest includes ${part}`);
  assert.equal(menuParts.has("link"), false, "the compatibility link alias is not duplicated in canonical anatomy");
  for (const action of menuManifest.actions) {
    assert.equal(action.sideEffects, "write", `Menu ${action.name} is conservatively classified as a mutation`);
  }

  const accordion = createAccordion({ id: "manifest-accordion", items: items("one") });
  const tabs = createTabs({ id: "manifest-tabs", items: items("one") });
  const menubar = createMenubar({ id: "manifest-menubar", items: [{ value: "file", textValue: "File", items: items("new") }] });
  const navigation = createNavigationMenu({ id: "manifest-navigation", items: items("products") });
  const toolbar = createToolbar({ id: "manifest-toolbar", items: items("bold") });
  for (const controller of [accordion, tabs]) {
    for (const action of controller.manifest().actions) assert.equal(action.sideEffects, "write");
  }
  for (const controller of [menubar, navigation, toolbar]) {
    for (const action of controller.manifest().actions) {
      assert.equal(action.sideEffects, action.name === "focusValue" ? "none" : "write");
    }
  }
  const navigationParts = new Set(navigation.manifest().parts.map((part) => part.name));
  assert.equal(navigationParts.has("icon"), true);
  assert.equal(navigationParts.has("portal"), true);

  menu.dispose();
  child.dispose();
  tabs.dispose();
  menubar.dispose();
  navigation.dispose();
});

test("all collection factories reject duplicate/unknown definitions and remain SSR-safe", () => {
  assert.throws(() => createAccordion({ id: "bad id", items: items("one") }), /id must start/);
  assert.throws(() => createTabs({ id: "tabs", items: [{ value: "same", textValue: "One" }, { value: "same", textValue: "Two" }] }), /unique/);
  assert.throws(() => createToolbar({ id: "toolbar", items: [{ kind: "group", value: "g", textValue: "Group" }] }), /require label/);
  const toolbar = createToolbar({ id: "empty-focus", items: [{ kind: "separator", value: "s", textValue: "Separator" }] });
  assert.equal(toolbar.focusedValue.value, null);
  assert.throws(() => toolbar.button("s"), /focus requires/);
});

function items(...values) {
  return values.map((value) => ({ value, textValue: value[0].toUpperCase() + value.slice(1) }));
}

function event(overrides = {}) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...overrides,
  };
}

function keyEvent(key, overrides = {}) {
  return event({ key, currentTarget: {}, ...overrides });
}

function pointerEvent(overrides = {}) {
  return event({ pointerType: "mouse", isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, currentTarget: null, ...overrides });
}

function focusable(id, log) {
  return {
    id,
    localName: "div",
    ownerDocument: null,
    focus() { log.push(id); },
  };
}

function attach(props, element) {
  props.ref?.(element);
  return element;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fakeView() {
  return {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function geometryElement(view, rect) {
  const values = new Map();
  return {
    ownerDocument: { defaultView: view },
    style: { values, setProperty(name, value) { values.set(name, value); } },
    getBoundingClientRect() { return rect; },
    focus() {},
  };
}
