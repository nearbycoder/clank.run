import test from "node:test";
import assert from "node:assert/strict";
import { h, renderToString } from "../dist/index.js";
import { createTabs } from "../dist/ui-collections.js";
import { CSPProvider, DirectionProvider, createInteractionState, renderPart, useCspNonce, useDirection } from "../dist/ui-composition.js";

test("UI environment providers flow through SSR component ownership", async () => {
  function Probe() { return h("span", { dir: useDirection(), "data-nonce": useCspNonce() }, "Probe"); }
  const html = await renderToString(h(DirectionProvider, { direction: "rtl" },
    h(CSPProvider, { nonce: "abcdefghijklmnop" }, h(Probe)),
  ));
  assert.equal(html, '<span dir="rtl" data-nonce="abcdefghijklmnop">Probe</span>');
});

test("renderPart composes an existing VNode without losing its props or children", async () => {
  const part = renderPart({
    defaultTag: "button",
    render: h("a", { class: "public", href: "/docs" }, "Docs"),
    props: { class: "internal", "aria-current": "page" },
    state: { current: true },
  });
  const html = await renderToString(part);
  assert.match(html, /<a /);
  assert.match(html, /class="public internal"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, />Docs<\/a>/);
});

test("renderPart functions receive the complete state contract", async () => {
  const part = renderPart({
    defaultTag: "button",
    props: { role: "switch" },
    state: { checked: true },
    render: (props, state) => h("span", { ...props, "data-checked": state.checked }, "Switch"),
  });
  assert.equal(await renderToString(part), '<span role="switch" data-checked>Switch</span>');
});

test("renderPart functions receive explicit children and interaction modality listeners have balanced ownership", async () => {
  const part = renderPart({
    defaultTag: "button",
    props: { role: "button" },
    state: {},
    children: "Create",
    render: (props) => h("span", { role: props.role }, ...props.children),
  });
  assert.equal(await renderToString(part), '<span role="button">Create</span>');

  let added = 0;
  let removed = 0;
  const document = {
    addEventListener() { added++; },
    removeEventListener() { removed++; },
  };
  const interaction = createInteractionState();
  const props = interaction.props();
  const element = { ownerDocument: document };
  props.onFocus({ currentTarget: element });
  const cleanup = props.use(element);
  assert.equal(added, 2, "focus followed by mount acquires one key/pointer listener pair");
  cleanup();
  assert.equal(removed, 2, "unmount releases the same listener pair");
});

test("direction-aware factories inherit DirectionProvider while module-level creation stays LTR", async () => {
  const standalone = createTabs({ id: "standalone-tabs", items: items("one", "two") });
  assert.equal(standalone.manifest().state.direction, "ltr");
  standalone.dispose();

  function Probe() {
    const tabs = createTabs({ id: "provider-tabs", items: items("one", "two") });
    const key = { key: "ArrowRight", defaultPrevented: false, currentTarget: {}, preventDefault() { this.defaultPrevented = true; } };
    tabs.tab("one").onKeyDown(key);
    const focused = tabs.focusedValue.value;
    const direction = tabs.manifest().state.direction;
    tabs.dispose();
    return h("span", { "data-focused": focused, dir: direction }, "Tabs");
  }
  const html = await renderToString(h(DirectionProvider, { direction: "rtl" }, h(Probe)));
  assert.equal(html, '<span data-focused="two" dir="rtl">Tabs</span>');
});

function items(...values) {
  return values.map((value) => ({ value, textValue: value }));
}
