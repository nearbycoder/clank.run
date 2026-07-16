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
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get localName() { return this.tagName.toLowerCase(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  get children() { return this.childNodes.filter((node) => node instanceof FakeElement); }
}

globalThis.Node = FakeNode;
globalThis.Text = FakeText;
globalThis.Comment = FakeComment;
globalThis.Element = FakeElement;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(String(value)),
  createComment: (value) => new FakeComment(value),
};

const { For, expression, h, hydrate, render } = await import("../dist/dom.js");
const { signal } = await import("../dist/core.js");

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

test("boolean ARIA states remain explicit as they change", () => {
  const expanded = signal(false);
  const root = new FakeElement("main");
  render(root, h("button", { "aria-expanded": expression(() => expanded.value) }, "Menu"));
  const button = root.children[0];
  assert.equal(button.getAttribute("aria-expanded"), "false");
  expanded.value = true;
  assert.equal(button.getAttribute("aria-expanded"), "true");
});

test("DOM bindings reject inline handlers and executable URL/raw iframe attributes", () => {
  const root = new FakeElement("main");
  assert.throws(() => render(root, h("button", { onclick: "alert(1)" }, "Unsafe")), /listener function/);
  assert.throws(() => render(root, h("a", { href: "javascript:alert(1)" }, "Unsafe")), /Unsafe URL scheme/);
  assert.throws(() => render(root, h("iframe", { srcdoc: "<script>alert(1)</script>" })), /srcdoc/);
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
