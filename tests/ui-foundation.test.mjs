import test from "node:test";
import assert from "node:assert/strict";
import {
  composeEventHandlers,
  containsEventTarget,
  createChangeDetails,
  createControllableState,
  createIdScope,
  createTypeahead,
  createUiId,
  createUiManifest,
  dataState,
  findCollectionIndex,
  findTypeaheadMatch,
  focusableElements,
  focusFirst,
  getCollectionNavigationIntent,
  getComposedPath,
  getOwnerDocument,
  isEventCanceled,
  isFocusable,
  mergeProps,
  mergeRefs,
  resolveDirection,
  resolveLogicalSide,
} from "../dist/ui-foundation.js";
import { signal } from "../dist/core.js";

test("change details expose stable reasons and cancel transitions", () => {
  const event = new Event("click", { cancelable: true });
  const details = createChangeDetails("trigger-press", event);
  assert.equal(details.reason, "trigger-press");
  assert.equal(details.event, event);
  assert.equal(details.canceled, false);
  details.cancel();
  assert.equal(details.canceled, true);
  assert.equal(Object.isFrozen(details), true);

  const prevented = new Event("click", { cancelable: true });
  prevented.preventDefault();
  assert.equal(createChangeDetails("trigger-press", prevented).canceled, true);
  assert.throws(() => createChangeDetails(""), /non-empty/);
});

test("controllable state has matching controlled, uncontrolled, equality, and cancellation semantics", () => {
  const changes = [];
  const state = createControllableState({
    defaultValue: 1,
    onValueChange(value, details) {
      changes.push([value, details.reason]);
      if (value === 3) details.cancel();
    },
  });
  assert.equal(state.value.value, 1);
  assert.equal(state.set(2, "increment"), true);
  assert.equal(state.value.value, 2);
  assert.equal(state.set(2, "increment"), false);
  assert.equal(state.set(3, "increment"), false);
  assert.equal(state.value.value, 2);
  assert.equal(state.reset("reset-button"), true);
  assert.equal(state.value.value, 1);
  assert.deepEqual(changes, [[2, "increment"], [3, "increment"], [1, "reset-button"]]);

  const external = signal("before");
  const controlled = createControllableState({
    value: () => external.value,
    defaultValue: "fallback",
    onValueChange(value) { external.value = value; },
  });
  assert.equal(controlled.value.value, "before");
  assert.equal(controlled.set("after", "input"), true);
  assert.equal(controlled.value.value, "after");

  const controlledUndefined = createControllableState({ value: undefined, defaultValue: "default" });
  assert.equal(controlledUndefined.value.value, undefined);
  assert.equal(controlledUndefined.set("ignored", "input"), true);
  assert.equal(controlledUndefined.value.value, undefined);
});

test("controllable reset preserves its native event and honors cancellation", () => {
  const seen = [];
  const state = createControllableState({
    defaultValue: "initial",
    onValueChange(value, details) { seen.push([value, details.reason, details.event]); },
  });
  state.set("edited", "input");
  const resetEvent = new Event("reset", { cancelable: true });
  assert.equal(state.reset("reset", resetEvent), true);
  assert.equal(state.value.value, "initial");
  assert.equal(seen.at(-1)[2], resetEvent);

  state.set("edited-again", "input");
  const canceledReset = new Event("reset", { cancelable: true });
  canceledReset.preventDefault();
  assert.equal(state.reset("reset", canceledReset), false);
  assert.equal(state.value.value, "edited-again");
});

test("composed event handlers stop after native, structured, and return-value cancellation", () => {
  const calls = [];
  const handler = composeEventHandlers(
    (event) => { calls.push("public"); event.preventDefault(); },
    () => { calls.push("internal"); },
  );
  const event = new Event("pointerdown", { cancelable: true });
  handler(event);
  assert.deepEqual(calls, ["public"]);
  assert.equal(isEventCanceled(event), true);

  const returned = new Event("click", { cancelable: true });
  composeEventHandlers(() => false, () => assert.fail("canceled handler ran"))(returned);
  assert.equal(returned.defaultPrevented, true);
  assert.equal(isEventCanceled({ detail: createChangeDetails("open") }), false);
  const detail = createChangeDetails("open");
  detail.cancel();
  assert.equal(isEventCanceled({ detail }), true);
});

test("mergeProps composes classes, styles, handlers, relationships, class lists, and refs", () => {
  const active = signal(false);
  const calls = [];
  const objectRef = { current: null };
  const props = mergeProps(
    {
      class: "root",
      style: { color: "red", paddingInline: "4px" },
      classList: { mounted: true },
      "aria-describedby": "help shared",
      onClick: () => { calls.push("root"); },
      ref: objectRef,
      tabIndex: -1,
    },
    {
      className: () => active.value ? "active" : "idle",
      style: { color: "blue", opacity: () => active.value ? 1 : 0.5 },
      classList: { disabled: false },
      "aria-describedby": "shared error",
      onClick: (event) => { calls.push("public"); event.preventDefault(); },
      ref: () => { calls.push("ref"); },
      tabIndex: 0,
    },
  );

  assert.equal("class" in props, false);
  assert.equal(props.className(), "root idle");
  active.value = true;
  assert.equal(props.className(), "root active");
  assert.deepEqual(props.style(), { color: "blue", paddingInline: "4px", opacity: props.style().opacity });
  assert.equal(props.style().opacity(), 1);
  assert.deepEqual(props.classList, { mounted: true, disabled: false });
  assert.equal(props["aria-describedby"], "help shared error");
  assert.equal(props.tabIndex, 0);
  props.ref({ id: "trigger" });
  assert.deepEqual(objectRef.current, { id: "trigger" });
  props.onClick(new Event("click", { cancelable: true }));
  assert.deepEqual(calls, ["ref", "root", "public"]);
  props.ref(null);
  assert.equal(objectRef.current, null);
});

test("mergeProps preserves every directive in declaration order", () => {
  const calls = [];
  const first = (element) => { calls.push(["mount-first", element]); return () => calls.push(["cleanup-first", element]); };
  const second = (element) => { calls.push(["mount-second", element]); return () => calls.push(["cleanup-second", element]); };
  const merged = mergeProps({ use: first }, { use: [second] });
  const element = {};
  const cleanup = merged.use(element);
  cleanup();
  assert.deepEqual(calls.map(([name]) => name), [
    "mount-first",
    "mount-second",
    "cleanup-second",
    "cleanup-first",
  ]);
});

test("mergeProps keeps mixed string/object styles deterministic", () => {
  const props = mergeProps(
    { style: "color:red" },
    { style: { paddingInline: "1rem", "--size": 2 } },
  );
  assert.equal(props.style, "color:red;padding-inline:1rem;--size:2");
});

test("mergeProps composes static and dynamic classList sources in either order", () => {
  const enabled = signal(true);
  const staticThenDynamic = mergeProps(
    { classList: { internal: true, shared: true } },
    { classList: () => ({ shared: false, agent: enabled.value }) },
  );
  assert.deepEqual(staticThenDynamic.classList(), { internal: true, shared: false, agent: true });
  enabled.value = false;
  assert.deepEqual(staticThenDynamic.classList(), { internal: true, shared: false, agent: false });

  const dynamicThenStatic = mergeProps(
    { classList: () => ({ shared: enabled.value, generated: true }) },
    { classList: { shared: true, public: true } },
  );
  assert.deepEqual(dynamicThenStatic.classList(), { shared: true, generated: true, public: true });
});

test("mergeRefs performs cleanup, null notification, object clearing, and reassignment", () => {
  const log = [];
  const object = { current: null };
  const merged = mergeRefs(
    (value) => {
      log.push(["cleanup-ref", value]);
      if (value) return () => log.push(["cleanup", value]);
    },
    (value) => { log.push(["nullable-ref", value]); },
    object,
  );
  const first = { id: 1 };
  const second = { id: 2 };
  merged(first);
  assert.equal(object.current, first);
  merged(second);
  assert.equal(object.current, second);
  merged(null);
  assert.equal(object.current, null);
  assert.deepEqual(log, [
    ["cleanup-ref", first],
    ["nullable-ref", first],
    ["nullable-ref", null],
    ["cleanup", first],
    ["cleanup-ref", second],
    ["nullable-ref", second],
    ["nullable-ref", null],
    ["cleanup", second],
  ]);
});

test("explicit ID scopes are deterministic across independent server and client renders", () => {
  const server = createIdScope("dialog", "account 42");
  const client = createIdScope("dialog", "account 42");
  assert.equal(server.prefix, "dialog-account_20_42");
  assert.equal(createUiId(server, "title"), createUiId(client, "title"));
  assert.equal(createUiId(server), createUiId(client));
  assert.equal(createUiId(server), createUiId(client));
  assert.equal(server.child("menu").id("item"), "dialog-account_20_42-menu-item");
  assert.equal(server.id("title"), server.id("title"));
  assert.throws(() => createIdScope("   "), /cannot be empty/);
  assert.throws(() => createUiId(null), /requires an IdScope/);
});

test("UI manifests are detached, serializable, validated, and deeply frozen", () => {
  const input = {
    component: "Dialog",
    id: "delete-dialog",
    state: { open: false, nested: { count: 1 } },
    parts: [{ name: "popup", role: "dialog", defaultElement: "div", required: true }],
    actions: [{ name: "open", description: "Open the dialog", sideEffects: "none", reasons: ["trigger"] }],
    keyboard: { Escape: "Close" },
  };
  const manifest = createUiManifest(input);
  input.state.nested.count = 9;
  input.parts[0].name = "changed";
  assert.equal(manifest.protocol, "clank-ui/1");
  assert.deepEqual(manifest.state, { open: false, nested: { count: 1 } });
  assert.equal(manifest.parts[0].name, "popup");
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.state.nested), true);
  assert.equal(JSON.parse(JSON.stringify(manifest)).protocol, "clank-ui/1");
  assert.throws(() => createUiManifest({ ...input, state: { callback() {} } }), /not serializable/);
  assert.throws(() => createUiManifest({ ...input, actions: [{ ...input.actions[0], sideEffects: "network" }] }), /sideEffects/);
});

test("direction and logical-side helpers honor inherited RTL without browser globals", () => {
  const document = { nodeType: 9, documentElement: attributeNode({ dir: "ltr" }), defaultView: null };
  const rtlParent = attributeNode({ dir: "rtl" });
  const child = attributeNode({}, { parentElement: rtlParent, ownerDocument: document });
  assert.equal(resolveDirection("auto", child), "rtl");
  assert.equal(resolveDirection(undefined, attributeNode({}, { ownerDocument: document })), "ltr");
  assert.equal(resolveLogicalSide("inline-start", "rtl"), "right");
  assert.equal(resolveLogicalSide("inline-end", "rtl"), "left");
  assert.equal(resolveLogicalSide("block-start", "rtl"), "top");
  assert.equal(getOwnerDocument(child), document);
  assert.equal(getOwnerDocument(document), document);
});

test("composed event paths and containment cross shadow boundaries", () => {
  const host = { id: "host" };
  const leaf = { id: "leaf" };
  const event = { target: leaf, composedPath: () => [leaf, host] };
  assert.deepEqual(getComposedPath(event), [leaf, host]);
  assert.equal(containsEventTarget(host, event), true);
  assert.equal(containsEventTarget({ contains: () => false }, event), false);

  const document = { nodeType: 9, documentElement: {}, defaultView: null };
  const fallbackHost = { ownerDocument: document };
  const shadow = { host: fallbackHost };
  const fallbackLeaf = { parentNode: shadow, ownerDocument: document };
  const fallbackEvent = { target: fallbackLeaf };
  assert.deepEqual(getComposedPath(fallbackEvent).slice(0, 3), [fallbackLeaf, shadow, fallbackHost]);
});

test("focus helpers filter unavailable nodes, sort tab order, cross open shadows, and fall back", () => {
  const focused = [];
  const document = { nodeType: 9, documentElement: {}, defaultView: null, activeElement: null };
  const normal = focusNode("button", {}, { ownerDocument: document, focus: () => focused.push("normal") });
  const priorityTwo = focusNode("button", { tabindex: "2" }, { ownerDocument: document, focus: () => focused.push("two") });
  const priorityThree = focusNode("button", { tabindex: "3" }, { ownerDocument: document, focus: () => focused.push("three") });
  const disabled = focusNode("button", { disabled: "" }, { ownerDocument: document });
  const programmatic = focusNode("div", { tabindex: "-1" }, { ownerDocument: document });
  const hiddenParent = attributeNode({ "aria-hidden": "true" });
  const hiddenChild = focusNode("button", {}, { ownerDocument: document, parentElement: hiddenParent });
  const shadowButton = focusNode("button", {}, { ownerDocument: document });
  const shadowHost = focusNode("div", { tabindex: "0" }, {
    ownerDocument: document,
    shadowRoot: { querySelectorAll: () => [shadowButton] },
  });
  const root = { querySelectorAll: () => [normal, priorityThree, disabled, programmatic, hiddenChild, priorityTwo, shadowHost] };

  assert.deepEqual(focusableElements(root), [priorityTwo, priorityThree, normal, shadowHost, shadowButton]);
  assert.equal(isFocusable(programmatic), false);
  assert.equal(isFocusable(programmatic, { tabbable: false }), true);
  assert.equal(isFocusable(hiddenChild), false);
  assert.equal(focusFirst(root), priorityTwo);
  assert.deepEqual(focused, ["two"]);

  const broken = focusNode("button", {}, { ownerDocument: document, focus: () => { throw new Error("detached"); } });
  const fallback = focusNode("button", {}, { ownerDocument: document, focus: () => focused.push("fallback") });
  assert.equal(focusFirst([broken], { fallback }), fallback);
  assert.equal(focused.at(-1), "fallback");
});

test("collection navigation skips disabled items, supports pages and loop, and mirrors horizontal RTL", () => {
  const items = [{ value: "a" }, { value: "b", disabled: true }, { value: "c" }, { value: "d" }];
  assert.equal(findCollectionIndex(items, 0, "next"), 2);
  assert.equal(findCollectionIndex(items, 2, "previous"), 0);
  assert.equal(findCollectionIndex(items, 3, "next"), 3);
  assert.equal(findCollectionIndex(items, 3, "next", { loop: true }), 0);
  assert.equal(findCollectionIndex(items, 0, "last"), 3);
  assert.equal(findCollectionIndex(items, 0, "page-next", { pageSize: 2 }), 2);
  assert.equal(findCollectionIndex([{ disabled: true }], 0, "next", { loop: true }), -1);
  assert.equal(getCollectionNavigationIntent("ArrowRight", "horizontal", "ltr"), "next");
  assert.equal(getCollectionNavigationIntent("ArrowRight", "horizontal", "rtl"), "previous");
  assert.equal(getCollectionNavigationIntent("ArrowDown", "vertical", "rtl"), "next");
  assert.equal(getCollectionNavigationIntent("ArrowRight", "vertical", "ltr"), null);
});

test("stateless and buffered typeahead normalize accents, skip disabled items, and cycle repeated keys", () => {
  const items = [
    { textValue: "Álpha" },
    { textValue: "Apricot" },
    { textValue: "Banana" },
    { textValue: "Blueberry", disabled: true },
  ];
  assert.equal(findTypeaheadMatch(items, "a"), 0);
  assert.equal(findTypeaheadMatch(items, "aa", 0), 1);
  assert.equal(findTypeaheadMatch(items, "bl", 2), -1);

  let time = 0;
  const typeahead = createTypeahead({ timeout: 500, now: () => time });
  assert.equal(typeahead.search("a", items), 0);
  time = 100;
  assert.equal(typeahead.search("a", items, 0), 1);
  assert.equal(typeahead.query, "aa");
  time = 700;
  assert.equal(typeahead.search("b", items, 1), 2);
  assert.equal(typeahead.query, "b");
  typeahead.reset();
  assert.equal(typeahead.query, "");
  typeahead.dispose();
  assert.equal(typeahead.search("a", items), -1);
  assert.throws(() => createTypeahead({ timeout: -1 }), /non-negative/);
});

test("dataState emits uniform and Base-UI-style selectors with validated flags", () => {
  assert.deepEqual(dataState("open", {
    disabled: true,
    highlighted: false,
    "data-side": "bottom",
    index: 2,
  }), {
    "data-state": "open",
    "data-open": "",
    "data-disabled": "",
    "data-highlighted": undefined,
    "data-side": "bottom",
    "data-index": 2,
  });
  assert.throws(() => dataState("Open now"), /Invalid data-state token/);
  assert.throws(() => dataState("open", { "bad flag": true }), /Invalid data-state token/);
});

function attributeNode(attributes = {}, extra = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    ...extra,
    getAttribute(name) { return values.has(name) ? String(values.get(name)) : null; },
    hasAttribute(name) { return values.has(name); },
    matches() { return true; },
  };
}

function focusNode(localName, attributes = {}, extra = {}) {
  return attributeNode(attributes, {
    localName,
    parentElement: null,
    focus() {},
    ...extra,
  });
}
