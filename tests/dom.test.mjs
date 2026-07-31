import test from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
    this.insertions = 0;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }
  insertBefore(node, before) {
    if (before !== null && before.parentNode !== this) throw new Error("Reference node has the wrong parent.");
    node.parentNode?.removeChild(node);
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    this.insertions++;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error("Node is not a child.");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
}

class FakeText extends FakeNode {
  constructor(data) { super(); this.data = data; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeComment extends FakeNode {
  constructor(data) { super(); this.data = data; }
  get textContent() { return ""; }
}

class FakeElement extends FakeNode {
  constructor(tagName, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super();
    this.namespaceURI = namespaceURI;
    this.localName = namespaceURI === "http://www.w3.org/2000/svg" ? tagName : tagName.toLowerCase();
    this.tagName = namespaceURI === "http://www.w3.org/2000/svg" ? tagName : tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = createFakeStyle();
    const classTokens = new Set();
    this.classTokens = classTokens;
    const synchronizeClass = () => {
      if (classTokens.size > 0) this.attributes.set("class", [...classTokens].join(" "));
      else this.attributes.delete("class");
    };
    this.classList = {
      add(...tokens) { for (const token of tokens) classTokens.add(token); synchronizeClass(); },
      remove(...tokens) { for (const token of tokens) classTokens.delete(token); synchronizeClass(); },
      toggle(token, force) {
        const enabled = force === undefined ? !classTokens.has(token) : Boolean(force);
        if (enabled) classTokens.add(token);
        else classTokens.delete(token);
        synchronizeClass();
        return enabled;
      },
      contains(token) { return classTokens.has(token); },
    };
  }
  setAttribute(name, value) {
    const next = String(value);
    this.attributes.set(name, next);
    if (name === "class" && this.classTokens) {
      this.classTokens.clear();
      for (const token of next.split(/\s+/).filter(Boolean)) this.classTokens.add(token);
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "class") this.classTokens?.clear();
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  get children() { return this.childNodes.filter((node) => node instanceof FakeElement); }
  set value(value) {
    this.boundValueChildCount = this.childNodes.length;
    this.currentValue = value;
  }
  get value() { return this.currentValue ?? ""; }
}

function createFakeStyle() {
  const target = {
    values: new Map(),
    text: "",
    setProperty(name, value) {
      if (value === "") {
        this.values.delete(name);
        delete this[name];
      } else {
        this.values.set(name, value);
        this[name] = value;
      }
    },
  };
  return new Proxy(target, {
    get(style, property) {
      if (property === "cssText") return style.text;
      return style[property];
    },
    set(style, property, value) {
      if (property === "cssText") {
        for (const name of style.values.keys()) delete style[name];
        style.values.clear();
        style.text = String(value);
        return true;
      }
      if (typeof property === "string" && !["values", "text", "setProperty"].includes(property)) {
        if (value === "") style.values.delete(property);
        else style.values.set(property, value);
      }
      style[property] = value;
      return true;
    },
  });
}

globalThis.Node = FakeNode;
globalThis.Text = FakeText;
globalThis.Comment = FakeComment;
globalThis.Element = FakeElement;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
  createTextNode: (value) => new FakeText(String(value)),
  createComment: (value) => new FakeComment(value),
};

const { For, Portal, expression, h, hydrate, onMount, render, useId } = await import("../dist/dom.js");
const { signal } = await import("../dist/core.js");
const { createApi } = await import("../dist/backend.js");
const { createCheckbox } = await import("../dist/ui-controls.js");
const { mergeProps } = await import("../dist/ui-foundation.js");

function elementById(root, id) {
  return root.childNodes.find((node) => node instanceof FakeElement && node.getAttribute("data-id") === id);
}

test("dynamic primitive updates preserve the exact Text node", () => {
  const value = signal("first");
  const root = new FakeElement("main");
  render(root, h("p", {}, expression(() => value.value)));
  const paragraph = root.children[0];
  const text = paragraph.childNodes.find((node) => node instanceof FakeText);
  value.value = "second";
  assert.equal(paragraph.childNodes.find((node) => node instanceof FakeText), text);
  assert.equal(text.data, "second");
});

test("agent labels give interactive controls the same accessible name", () => {
  const label = signal("Create task");
  const root = new FakeElement("main");
  render(root, h("button", { agentLabel: expression(() => label.value) }, "Create"));
  const button = root.children[0];
  assert.equal(button.getAttribute("data-clank-label"), "Create task");
  assert.equal(button.getAttribute("aria-label"), "Create task");
  label.value = "Create todo";
  assert.equal(button.getAttribute("data-clank-label"), "Create todo");
  assert.equal(button.getAttribute("aria-label"), "Create todo");
});

test("typed backend references remain exact when client action bindings change", () => {
  const api = createApi();
  const selected = signal(api.todos.add);
  const root = new FakeElement("main");
  render(root, h("section", {},
    h("button", { agentAction: api.todos.add }, "Add"),
    h("button", { agentAction: selected }, "Selected"),
  ));
  const [direct, reactive] = root.children[0].children;
  assert.equal(direct.getAttribute("data-clank-action"), "todos.add");
  assert.equal(reactive.getAttribute("data-clank-action"), "todos.add");
  selected.value = api.todos.remove;
  assert.equal(reactive.getAttribute("data-clank-action"), "todos.remove");
});

test("select value bindings attach after their options and remain reactive", () => {
  const selected = signal("normal");
  const root = new FakeElement("main");
  render(root, h("select", { "bind:value": selected },
    h("option", { value: "low" }, "Low"),
    h("option", { value: "normal" }, "Normal"),
  ));
  const select = root.children[0];
  assert.equal(select.boundValueChildCount, 2);
  assert.equal(select.value, "normal");
  selected.value = "low";
  assert.equal(select.value, "low");
});

test("boolean ARIA states remain explicit as they change", () => {
  const expanded = signal(false);
  const root = new FakeElement("main");
  render(root, h("button", { "aria-expanded": expression(() => expanded.value) }, "Menu"));
  const button = root.children[0];
  assert.equal(button.getAttribute("aria-expanded"), "false");
  expanded.value = true;
  assert.equal(button.getAttribute("aria-expanded"), "true");
});

test("reactive merged styles bind properties instead of replacing element.style", () => {
  const x = signal(12);
  const root = new FakeElement("main");
  const props = mergeProps({
    style: {
      position: "fixed",
      left: () => `${x.value}px`,
      "--anchor-width": () => `${x.value * 2}px`,
    },
  });
  const dispose = render(root, h("div", props));
  const element = root.children[0];

  assert.equal(element.style.position, "fixed");
  assert.equal(element.style.left, "12px");
  x.value = 18;
  assert.equal(element.style.left, "18px");

  dispose();
  x.value = 24;
  assert.equal(element.style.left, "18px", "disposing releases every nested style effect");
});

test("reactive mixed style sources update cssText", () => {
  const x = signal(5);
  const root = new FakeElement("main");
  const props = mergeProps(
    { style: "color:red" },
    { style: { left: () => `${x.value}px` } },
  );
  render(root, h("div", props));
  const element = root.children[0];

  assert.equal(element.style.cssText, "color:red;left:5px");
  x.value = 9;
  assert.equal(element.style.cssText, "color:red;left:9px");
});

test("reactive style bindings reconcile object, text, and empty modes", () => {
  const style = signal({ position: "fixed", top: "4px", display: false, "--inactive": false });
  const root = new FakeElement("main");
  const dispose = render(root, h("div", { style }));
  const element = root.children[0];

  assert.equal(element.style.position, "fixed");
  assert.equal(element.style.top, "4px");
  assert.equal(element.style.display, "");
  assert.equal(element.style.values.has("--inactive"), false);
  style.value = "color:blue";
  assert.equal(element.style.cssText, "color:blue");
  assert.equal(element.style.position, undefined);
  style.value = { insetInline: "8px" };
  assert.equal(element.style.cssText, "");
  assert.equal(element.style.insetInline, "8px");
  style.value = null;
  assert.equal(element.style.insetInline, "");

  dispose();
  style.value = { opacity: 0.5 };
  assert.equal(element.style.opacity, undefined);
});

test("reactive classList removes false hydration tokens without touching static classes", () => {
  const active = signal(false);
  const root = new FakeElement("main");
  const element = new FakeElement("div");
  element.setAttribute("class", "stale application-owned");
  element.classList.add("stale", "application-owned");
  root.insertBefore(element, null);

  hydrate(root, h("div", {
    className: ["application-owned", { ready: true }],
    classList: () => ({ stale: active.value, current: !active.value }),
  }));
  assert.equal(element.getAttribute("class"), "application-owned ready current");
  assert.equal(element.classList.contains("stale"), false);
  assert.equal(element.classList.contains("current"), true);
  assert.equal(element.classList.contains("application-owned"), true);

  active.value = true;
  assert.equal(element.getAttribute("class"), "application-owned ready stale");
  assert.equal(element.classList.contains("stale"), true);
  assert.equal(element.classList.contains("current"), false);
});

test("merged class and classList bindings stay composed across reactive updates", () => {
  const tone = signal("tone-a");
  const agent = signal(true);
  const props = mergeProps(
    { class: "base", classList: { internal: true, shared: true } },
    { className: () => tone.value, classList: () => ({ shared: false, agent: agent.value }) },
  );
  const root = new FakeElement("main");
  render(root, h("div", props));
  const element = root.children[0];

  assert.equal(element.getAttribute("class"), "base tone-a internal agent");
  tone.value = "tone-b";
  assert.equal(element.getAttribute("class"), "base tone-b internal agent");
  agent.value = false;
  assert.equal(element.getAttribute("class"), "base tone-b internal");
});

test("DOM bindings reject inline handlers and executable URL/raw iframe attributes", () => {
  const root = new FakeElement("main");
  assert.throws(() => render(root, h("button", { onclick: "alert(1)" }, "Unsafe")), /listener function/);
  assert.throws(() => render(root, h("a", { href: "javascript:alert(1)" }, "Unsafe")), /Unsafe URL scheme/);
  assert.throws(() => render(root, h("iframe", { srcdoc: "<script>alert(1)</script>" })), /srcdoc/);
});

test("optional nullish event props mount as absent listeners", () => {
  const root = new FakeElement("main");
  assert.doesNotThrow(() => render(root, h("input", { onInvalid: undefined, onChange: null })));
  assert.equal(root.children[0].listeners.size, 0);
});

test("hydrate attaches to matching dynamic and keyed DOM without replacing nodes", () => {
  const items = signal([{ id: "a", title: "Alpha" }]);
  const root = new FakeElement("main");
  const view = h("section", {},
    h("h1", {}, expression(() => "Hydrated")),
    h(For, { each: items, by: "id" }, (item) => h("p", { "data-id": expression(() => item.id) }, expression(() => item.title))),
  );
  render(root, view);
  const section = root.children[0];
  const headingText = section.children[0].childNodes.find((node) => node instanceof FakeText);
  const row = section.children[1];
  const rowText = row.childNodes.find((node) => node instanceof FakeText);

  hydrate(root, view);
  assert.equal(root.children[0], section);
  assert.equal(section.children[0].childNodes.find((node) => node instanceof FakeText), headingText);
  assert.equal(section.children[1], row);
  assert.equal(row.childNodes.find((node) => node instanceof FakeText), rowText);
});

test("headless controls hydrate in place and retain reactive interaction", () => {
  const checkbox = createCheckbox({ id: "hydrated-sync", defaultChecked: false });
  const view = h("section", {},
    h("button", checkbox.root(),
      h("span", checkbox.indicator({ keepMounted: true }), "✓"),
      "Keep synchronized",
    ),
  );
  const root = new FakeElement("main");
  render(root, view);
  const section = root.children[0];
  const button = section.children[0];
  const indicator = button.children[0];

  hydrate(root, view);
  assert.equal(root.children[0], section);
  assert.equal(section.children[0], button);
  assert.equal(button.children[0], indicator);
  assert.equal(button.getAttribute("aria-checked"), "false");
  assert.notEqual(indicator.hidden, true);
  assert.equal(indicator.getAttribute("data-state"), "unchecked");

  button.listeners.get("click")({ defaultPrevented: false });
  assert.equal(button.getAttribute("aria-checked"), "true");
  assert.equal(indicator.getAttribute("data-state"), "checked");
});

test("hydrate splits adjacent static text merged by an HTML parser", () => {
  const root = new FakeElement("main");
  const paragraph = new FakeElement("p");
  const merged = new FakeText("helloworld");
  paragraph.insertBefore(merged, null);
  root.insertBefore(paragraph, null);

  hydrate(root, h("p", {}, "hello", "world", ""));

  assert.equal(root.children[0], paragraph);
  assert.equal(paragraph.childNodes[0], merged);
  assert.deepEqual(paragraph.childNodes.map((node) => node.data), ["hello", "world"]);
  assert.equal(root.getAttribute("data-clank-hydration"), "attached");
});

test("hydrate cleans partial listeners and actions before remounting a structural mismatch", () => {
  const root = new FakeElement("main");
  const section = new FakeElement("section");
  const oldButton = new FakeElement("button");
  section.insertBefore(oldButton, null);
  section.insertBefore(new FakeElement("span"), null);
  root.insertBefore(section, null);

  let attached = 0;
  let cleaned = 0;
  const action = () => {
    attached++;
    return () => cleaned++;
  };
  const view = h("section", {}, h("button", { use: action, onClick: () => {} }));
  const previousWarn = console.warn;
  console.warn = () => {};
  let dispose;
  try {
    dispose = hydrate(root, view);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(root.getAttribute("data-clank-hydration"), "remounted");
  assert.notEqual(root.children[0], section);
  assert.equal(oldButton.listeners.size, 0);
  assert.equal(attached, 2, "the action attaches once during hydration and once on the fallback mount");
  assert.equal(cleaned, 1, "the abandoned hydration attachment is cleaned before remounting");

  dispose();
  assert.equal(cleaned, 2);
});

test("hydrate propagates application binding errors without disguising them as mismatches", () => {
  const root = new FakeElement("main");
  const button = new FakeElement("button");
  root.insertBefore(button, null);
  let attached = 0;
  let cleaned = 0;
  let warned = false;
  const previousWarn = console.warn;
  console.warn = () => { warned = true; };
  try {
    assert.throws(
      () => hydrate(root, h("button", {
        use: () => {
          attached++;
          return () => cleaned++;
        },
        onClick: "not a listener",
      })),
      /expects an event listener function/,
    );
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(root.children[0], button);
  assert.equal(root.getAttribute("data-clank-hydration"), null);
  assert.equal(attached, 1);
  assert.equal(cleaned, 1);
  assert.equal(warned, false);
});

test("hydrate disposes attached component output when onMount throws", () => {
  const root = new FakeElement("main");
  const button = new FakeElement("button");
  root.insertBefore(button, null);
  let cleaned = 0;
  function BrokenComponent() {
    onMount(() => {
      throw new Error("mount failed");
    });
    return h("button", { use: () => () => cleaned++ });
  }

  assert.throws(() => hydrate(root, h(BrokenComponent)), /mount failed/);
  assert.equal(root.children[0], button);
  assert.equal(cleaned, 1);
  assert.equal(root.getAttribute("data-clank-hydration"), null);
});

test("hydrate preserves case-sensitive SVG elements and HTML children of foreignObject", () => {
  const root = new FakeElement("main");
  const view = h("svg", {},
    h("linearGradient", { id: "fade" }),
    h("foreignObject", {}, h("div", {}, "HTML")),
  );
  render(root, view);
  const svg = root.children[0];
  const gradient = svg.children[0];
  const foreignObject = svg.children[1];
  const htmlChild = foreignObject.children[0];

  hydrate(root, view);

  assert.equal(root.children[0], svg);
  assert.equal(svg.children[0], gradient);
  assert.equal(svg.children[1], foreignObject);
  assert.equal(foreignObject.children[0], htmlChild);
  assert.equal(gradient.localName, "linearGradient");
  assert.equal(htmlChild.namespaceURI, "http://www.w3.org/1999/xhtml");
  assert.equal(root.getAttribute("data-clank-hydration"), "attached");
});

test("keyed For preserves row and text identity across edits and reorders", () => {
  const items = signal([
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ]);
  const root = new FakeElement("main");
  render(root, h(For, { each: items, by: "id" }, (item) =>
    h("article", { "data-id": expression(() => item.id) }, expression(() => item.name)),
  ));

  const alpha = elementById(root, "a");
  const beta = elementById(root, "b");
  const alphaText = alpha.childNodes.find((node) => node instanceof FakeText);
  const betaText = beta.childNodes.find((node) => node instanceof FakeText);

  root.insertions = 0;
  items.value = [
    { id: "a", name: "Alpha updated in place" },
    { id: "b", name: "Beta" },
  ];
  assert.equal(root.insertions, 0, "same-order record updates must not issue DOM insertions");
  assert.equal(alpha.textContent, "Alpha updated in place");

  root.insertions = 0;
  items.value = [
    { id: "b", name: "Beta updated" },
    { id: "a", name: "Alpha updated" },
    { id: "c", name: "Gamma" },
  ];

  assert.equal(elementById(root, "a"), alpha);
  assert.equal(elementById(root, "b"), beta);
  assert.equal(alpha.childNodes.find((node) => node instanceof FakeText), alphaText);
  assert.equal(beta.childNodes.find((node) => node instanceof FakeText), betaText);
  assert.equal(alpha.textContent, "Alpha updated");
  assert.equal(beta.textContent, "Beta updated");
  assert.deepEqual(root.children.map((node) => node.getAttribute("data-id")), ["b", "a", "c"]);
  assert.equal(root.insertions, 2, "one new row and one moved row are the only insertions");
});

test("Portal mounts into an explicit target and cleans up without disturbing siblings", () => {
  const root = new FakeElement("main");
  const target = new FakeElement("aside");
  const sibling = new FakeElement("p");
  target.insertBefore(sibling, null);
  const dispose = render(root, h("section", {},
    h(Portal, { target }, h("button", { "data-id": "portalled" }, "Open")),
  ));

  assert.equal(root.children[0].children.length, 0);
  assert.equal(target.children.length, 2);
  assert.equal(target.children[0], sibling);
  assert.equal(target.children[1].getAttribute("data-id"), "portalled");
  dispose();
  assert.deepEqual(target.children, [sibling]);
});

test("callback refs receive null exactly once when their element is disposed", () => {
  const root = new FakeElement("main");
  const values = [];
  const dispose = render(root, h("button", { ref: (value) => values.push(value) }, "Save"));
  assert.equal(values.length, 1);
  assert.equal(values[0], root.children[0]);
  dispose();
  assert.deepEqual(values, [values[0], null]);
});

test("client render and hydration reuse deterministic component IDs", () => {
  function Field() {
    const id = useId("field");
    return h("label", { for: id }, h("input", { id }));
  }
  const root = new FakeElement("main");
  const view = h("form", {}, h(Field), h(Field));
  render(root, view);
  const form = root.children[0];
  assert.equal(form.children[0].getAttribute("for"), "clank-field-1");
  assert.equal(form.children[1].getAttribute("for"), "clank-field-2");
  hydrate(root, view);
  assert.equal(root.children[0], form);
  assert.equal(root.getAttribute("data-clank-hydration"), "attached");
});

test("useId normalizes uncontrolled prefixes and still requires a letter", () => {
  function SanitizedField() {
    const id = useId("  --profile ! field--  ");
    return h("input", { id });
  }
  const root = new FakeElement("main");
  render(root, h(SanitizedField));
  assert.equal(root.children[0].getAttribute("id"), "clank-profile-field-1");
  assert.throws(
    () => render(new FakeElement("main"), h(() => h("input", { id: useId("---123---") }))),
    /prefix must contain a letter/,
  );
});
