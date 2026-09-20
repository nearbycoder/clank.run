import test from "node:test";
import assert from "node:assert/strict";
import { focusableElements, focusFirst, isFocusable } from "../dist/ui-foundation.js";
import { createSelect, createCombobox, createAutocomplete } from "../dist/ui-selection.js";
import { createOtpField, createNumberField } from "../dist/ui-fields.js";

function focusDocument() {
  return { nodeType: 9, activeElement: null, defaultView: { getComputedStyle: (element) => element.style ?? {} } };
}
function focusNode(document, tag = "button", attributes = {}) {
  return {
    localName: tag, ownerDocument: document, parentNode: null, style: {}, children: [], shadowRoot: null,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    matches(selector) { return selector === "*" || tag === "button" || Object.hasOwn(attributes, "tabindex"); },
    querySelectorAll(selector) { return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) => child.matches(selector)); },
    getRootNode() { return this.root ?? document; },
    focus() { document.activeElement = this; },
  };
}
function event(key, overrides = {}) {
  return { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

test("019 open shadow roots on nonfocusable hosts and the search root are traversed", () => {
  const document = focusDocument();
  const root = focusNode(document, "main");
  const host = focusNode(document, "section");
  const inner = focusNode(document);
  const nestedHost = focusNode(document, "div");
  const nested = focusNode(document);
  nestedHost.shadowRoot = { querySelectorAll: () => [nested] };
  host.shadowRoot = { querySelectorAll: () => [inner, nestedHost] };
  root.children = [host];
  assert.deepEqual(focusableElements(root), [inner, nested]);
  assert.deepEqual(focusableElements(host), [inner, nested]);
  assert.deepEqual(focusableElements(host, { includeRoot: true }), [inner, nested]);
});

test("020 hidden rendering ancestors exclude descendants across light and shadow DOM", () => {
  for (const style of [{ display: "none" }, { contentVisibility: "hidden" }]) {
    const document = focusDocument();
    const parent = focusNode(document, "section");
    parent.style = style;
    const child = focusNode(document);
    child.parentNode = parent;
    assert.equal(isFocusable(child), false);
    const shadow = { host: parent };
    child.parentNode = shadow;
    assert.equal(isFocusable(child), false);
    parent.style = {};
    assert.equal(isFocusable(child), true);
  }
  const document = focusDocument();
  const parent = focusNode(document, "div");
  parent.style = { visibility: "hidden" };
  const visibleOverride = focusNode(document);
  visibleOverride.parentNode = parent;
  visibleOverride.style = { visibility: "visible" };
  assert.equal(isFocusable(visibleOverride), true, "a visible child may override inherited visibility");
});

test("021 focusFirst verifies actual focus, continues after silent failure, and selects only the focused target", () => {
  const document = focusDocument();
  const silent = focusNode(document);
  silent.focus = () => {};
  silent.select = () => assert.fail("a failed focus must not select text");
  const working = focusNode(document);
  let selections = 0;
  working.select = () => { selections++; };
  assert.equal(focusFirst([silent, working], { select: true }), working);
  assert.equal(document.activeElement, working);
  assert.equal(selections, 1);
  assert.equal(focusFirst([silent]), null);
  const shadow = { activeElement: null };
  const leaf = focusNode(document);
  leaf.root = shadow;
  leaf.focus = () => { shadow.activeElement = leaf; };
  assert.equal(focusFirst([silent], { fallback: leaf }), leaf);
  const legacy = focusNode(document);
  legacy.focus = (options) => { if (options) throw new Error("options unsupported"); document.activeElement = legacy; };
  assert.equal(focusFirst([legacy]), legacy);
});

const items = [{ value: "a", label: "Apple" }, { value: "b", label: "Banana" }];
const composing = [{ isComposing: true }, { isComposing: false, keyCode: 229 }];

test("022 combobox and autocomplete leave composing navigation, selection, and deletion to the IME", () => {
  for (const create of [createCombobox, createAutocomplete]) {
    for (const mode of composing) {
      const control = create({ id: `ime-${create.name}`, items, multiple: true, defaultValue: ["a"] });
      try {
        control.show();
        control.highlightedIndex.value = 1;
        for (const key of ["Enter", "ArrowUp", "ArrowDown", "Home", "End", "Backspace"]) {
          const before = [control.value.peek(), control.highlightedIndex.peek(), control.open.peek(), control.inputValue.peek()];
          const input = event(key, mode);
          control.input().onKeyDown(input);
          assert.deepEqual([control.value.peek(), control.highlightedIndex.peek(), control.open.peek(), control.inputValue.peek()], before, key);
          assert.equal(input.defaultPrevented, false);
        }
        const normal = event("Backspace");
        control.input().onKeyDown(normal);
        assert.deepEqual(control.value.value, []);
        control.hide();
        const arrow = event("ArrowDown", mode);
        control.trigger({ standalone: true }).onKeyDown(arrow);
        assert.equal(control.open.value, false);
        assert.equal(arrow.defaultPrevented, false);
      } finally { control.dispose(); }
    }
  }
});

test("023 Select does not feed composing keys into typeahead on its trigger or list", () => {
  for (const mode of composing) {
    const control = createSelect({ id: "ime-select", items, defaultValue: "a" });
    try {
      const closed = event("b", mode);
      control.trigger().onKeyDown(closed);
      assert.equal(control.value.value, "a");
      assert.equal(closed.defaultPrevented, false);
      control.show();
      const before = control.highlightedIndex.peek();
      for (const part of [control.trigger(), control.list()]) {
        const input = event("b", mode);
        part.onKeyDown(input);
        assert.equal(control.highlightedIndex.value, before);
        assert.equal(input.defaultPrevented, false);
      }
      control.list().onKeyDown(event("b"));
      assert.equal(control.highlightedIndex.value, 1);
    } finally { control.dispose(); }
  }
});

test("024 PIN navigation and deletion ignore both standard and legacy composition events", () => {
  for (const mode of composing) {
    const focused = [];
    const source = { ownerDocument: { getElementById: (id) => ({ focus: () => focused.push(id), select() {} }) } };
    const pin = createOtpField({ id: "ime-pin", length: 4, defaultValue: "1234" });
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"]) {
      const input = event(key, { ...mode, currentTarget: source });
      pin.input(1).onKeyDown(input);
      assert.equal(pin.value.value, "1234");
      assert.equal(input.defaultPrevented, false);
      assert.deepEqual(focused, []);
    }
    pin.input(1).onKeyDown(event("Backspace", { currentTarget: source }));
    assert.equal(pin.value.value, "134");
  }
});

test("026 NumberField leaves zoom and horizontal-only wheel events untouched", () => {
  const commits = [];
  const field = createNumberField({ id: "wheel-number", defaultValue: 4, step: 2, allowWheelScrub: true,
    onValueCommitted: (value) => commits.push(value) });
  const input = field.input();
  input.onFocus(event());
  for (const overrides of [{ ctrlKey: true, deltaY: -1 }, { deltaY: 0, deltaX: 10 }]) {
    const wheel = event(undefined, overrides);
    input.onWheel(wheel);
    assert.equal(field.value.value, 4);
    assert.equal(wheel.defaultPrevented, false);
    assert.deepEqual(commits, []);
  }
  const up = event(undefined, { deltaY: -1 });
  input.onWheel(up);
  assert.equal(field.value.value, 6);
  assert.equal(up.defaultPrevented, true);
  const down = event(undefined, { deltaY: 1 });
  input.onWheel(down);
  assert.equal(field.value.value, 4);
  assert.deepEqual(commits, [6, 4]);
});
