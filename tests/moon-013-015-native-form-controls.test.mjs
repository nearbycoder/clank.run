import test from "node:test";
import assert from "node:assert/strict";
import { h, expression, render, hydrate, For } from "../dist/dom.js";
import { signal } from "../dist/core.js";
import { createForm } from "../dist/forms.js";
import { renderToString } from "../dist/ssr.js";

test("013 textarea values render escaped content with property precedence and leading-newline preservation", async () => {
  const value = '\n</textarea><script>bad & "quoted"</script>';
  assert.equal(await renderToString(h("textarea", { value }, "ignored")),
    '<textarea>\n\n&lt;/textarea&gt;&lt;script&gt;bad &amp; "quoted"&lt;/script&gt;</textarea>');
  for (const empty of ["", null, undefined, false]) {
    assert.equal(await renderToString(h("textarea", { value: empty }, "fallback")), "<textarea></textarea>");
  }
  const bound = signal("bound & <text>");
  assert.equal(await renderToString(h("textarea", { value: "earlier", "bind:value": bound }, "ignored")),
    "<textarea>bound &amp; &lt;text&gt;</textarea>");
  assert.equal(await renderToString(h("textarea", { "bind:value": bound, value: "later" })), "<textarea>later</textarea>");
  assert.equal(await renderToString(h("textarea", {}, "fallback & text")), "<textarea>fallback &amp; text</textarea>");
});

test("014 select values select matching options and override conflicting selected props", async () => {
  const view = (value, multiple = false) => h("select", { value, multiple },
    h("option", { value: "a", selected: true }, "A"),
    h("optgroup", { label: "More" }, h("option", { value: "b" }, "B"), h("option", { value: "c" }, "C")));
  assert.equal(await renderToString(view("b")), '<select><option value="a">A</option><optgroup label="More"><option value="b" selected>B</option><option value="c">C</option></optgroup></select>');
  assert.equal((await renderToString(view(["a", "c"], true))).match(/ selected/g)?.length, 2);
  assert.doesNotMatch(await renderToString(view([], true)), / selected/);
  assert.doesNotMatch(await renderToString(view("absent")), / selected/);
  const value = signal("b");
  assert.match(await renderToString(h("select", { "bind:value": value }, h("option", { value: "b" }, "B"))), /value="b" selected/);
  assert.equal(await renderToString(h("select", { value: null }, h("option", { value: "" }, "Empty"))), '<select><option value="" selected>Empty</option></select>');
});

test("014 implicit option values use decoded text and HTML whitespace normalization", async () => {
  const label = signal(" A & <B> ");
  const html = await renderToString(h("select", { value: "A & <B>" }, h("option", {}, " \n", label, "\t")));
  assert.match(html, /<option selected>/);
  assert.match(html, /A &amp; &lt;B&gt;/);
  const unicodeSpace = "\u00a0label\u00a0";
  assert.match(await renderToString(h("select", { value: unicodeSpace }, h("option", {}, unicodeSpace))), /<option selected>/);
});

test("014 selection survives components, reactive/keyed children, and out-of-order async text", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const options = signal(["a", "b"]);
  function Options() { return h("optgroup", { label: "Group" }, h(For, { each: options }, (value) => h("option", { value }, value))); }
  const rendered = renderToString(h("select", { multiple: true, value: ["b", "first last"] },
    h(Options),
    Promise.resolve(h("option", {}, delayed, " last"))));
  release("first");
  const html = await rendered;
  assert.match(html, /<option value="b" selected>b<\/option>/);
  assert.match(html, /<option selected>first last<\/option>/);
  assert.doesNotMatch(html, /<option value="a" selected/);
});

test("014 selection does not leak between sibling, nested, or concurrent selects", async () => {
  const option = () => h("option", { value: "x" }, "X");
  const html = await renderToString([
    h("select", { value: "x" }, option(), h("select", {}, option())),
    h("select", {}, option()),
  ]);
  assert.equal((html.match(/ selected/g) ?? []).length, 1);
  const results = await Promise.all(["x", "other"].map((value) => renderToString(h("select", { value }, Promise.resolve(option())))));
  assert.match(results[0], / selected/);
  assert.doesNotMatch(results[1], / selected/);
});

test("014 rejected asynchronous option text remains a handled render failure", async () => {
  await assert.rejects(renderToString(h("select", { value: "text" }, h("option", {}, Promise.reject(new Error("option failed"))))), /option failed/);
  await new Promise((resolve) => setImmediate(resolve));
});

// A minimal native-control model: select.value is always scalar, options live
// through optgroups, and textarea.value is distinct from its parsed text nodes.
class TestNode {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
}
class TestText extends TestNode {
  constructor(data) { super(3); this.data = String(data); }
  get textContent() { return this.data; }
}
class TestComment extends TestNode {
  constructor(data) { super(8); this.data = data; }
  get textContent() { return ""; }
}
class TestElement extends TestNode {
  constructor(tag) {
    super(1); this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase();
    this.attributes = new Map(); this.listeners = new Map(); this.selected = false;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  get multiple() { return this.attributes.has("multiple"); }
  set multiple(value) { if (value) this.setAttribute("multiple", ""); else this.removeAttribute("multiple"); }
  get options() {
    return this.childNodes.flatMap((child) => child.localName === "option" ? [child] : child.localName === "optgroup" ? child.options : []);
  }
  get selectedOptions() { return this.options.filter((option) => option.selected); }
  get selectedIndex() { return this.options.findIndex((option) => option.selected); }
  set selectedIndex(value) { this.options.forEach((option, index) => { option.selected = index === Number(value); }); }
  get value() {
    if (this.localName === "select") return this.selectedOptions[0]?.value ?? "";
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
    return this.currentValue ?? this.textContent;
  }
  set value(value) {
    if (this.localName === "select") {
      const index = this.options.findIndex((option) => option.value === String(value));
      this.selectedIndex = index;
    } else if (this.localName === "option") this.setAttribute("value", String(value));
    else this.currentValue = String(value ?? "");
  }
}
const ownerDocument = {
  createElement: (tag) => new TestElement(tag), createTextNode: (value) => new TestText(value), createComment: (value) => new TestComment(value),
};
function withDOM(run) {
  const saved = Object.fromEntries(["Node", "Text", "Comment", "Element", "document", "MutationObserver"].map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { Node: TestNode, Text: TestText, Comment: TestComment, Element: TestElement, document: ownerDocument });
  try { return run(); } finally { Object.assign(globalThis, saved); }
}
const options = () => [h("option", { value: "a" }, "A"), h("optgroup", {}, h("option", { value: "b" }, "B"), h("option", { value: "c" }, "C"))];
const selected = (select) => select.selectedOptions.map((option) => option.value);

test("013 controlled textarea hydration keeps its element and ignores overridden children", () => withDOM(() => {
  const root = new TestElement("main");
  const textarea = new TestElement("textarea");
  textarea.insertBefore(new TestText("\n<& server text"), null);
  root.insertBefore(textarea, null);
  const value = signal("\n<& server text");
  const stop = hydrate(root, h("textarea", { "bind:value": value }, "ignored fallback"));
  try {
    assert.equal(root.firstChild, textarea);
    assert.equal(root.getAttribute("data-clank-hydration"), "attached");
    assert.equal(textarea.value, value.value);
    assert.equal(textarea.textContent, value.value);
    textarea.value = "user edit";
    textarea.listeners.get("input")();
    assert.equal(value.value, "user edit");
    value.value = "restored";
    assert.equal(textarea.value, "restored");
  } finally { stop(); }
}));

test("015 multiple select arrays assign every native option after mount and reactive changes", () => withDOM(() => {
  const form = createForm({ initial: { tags: ["a", "c"] } });
  const root = new TestElement("main");
  const stop = render(root, h("select", form.field("tags").select({ multiple: true }), ...options()));
  const select = root.firstChild;
  try {
    assert.deepEqual(selected(select), ["a", "c"]);
    form.setValue("tags", ["b"]);
    assert.deepEqual(selected(select), ["b"]);
    select.options[0].selected = true;
    select.options[1].selected = false;
    select.listeners.get("change")({ currentTarget: select });
    assert.deepEqual(form.field("tags").value.value, ["a"]);
    form.reset();
    assert.deepEqual(selected(select), ["a", "c"]);
    form.setValue("tags", []);
    assert.deepEqual(selected(select), []);
  } finally { stop(); }
}));

test("015 array bind:value hydrates existing options and reads selected arrays on input", () => withDOM(() => {
  const root = new TestElement("main");
  render(root, h("select", { multiple: true }, ...options()));
  const select = root.firstChild;
  const originalOptions = select.options;
  const value = signal(["b", "c"]);
  const stop = hydrate(root, h("select", { multiple: true, "bind:value": value }, ...options()));
  try {
    assert.equal(root.firstChild, select);
    assert.deepEqual(select.options, originalOptions);
    assert.deepEqual(selected(select), ["b", "c"]);
    select.options[0].selected = true;
    select.options[1].selected = false;
    select.listeners.get("input")();
    assert.deepEqual(value.value, ["a", "c"]);
    value.value = ["b"];
    assert.deepEqual(selected(select), ["b"]);
  } finally { stop(); }
}));

test("015 scalar value and selectedIndex bindings retain native select semantics", () => withDOM(() => {
  for (const property of ["value", "selectedIndex"]) {
    const root = new TestElement("main");
    const value = signal(property === "value" ? "b" : 1);
    const stop = render(root, h("select", { [`bind:${property}`]: value }, ...options()));
    try {
      assert.deepEqual(selected(root.firstChild), ["b"]);
      value.value = property === "value" ? "c" : 2;
      assert.deepEqual(selected(root.firstChild), ["c"]);
    } finally { stop(); }
  }
}));

test("015 multiple selection reapplies to late options and disconnects its observer on disposal", () => withDOM(() => {
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(element, options) { this.element = element; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const root = new TestElement("main");
  const values = signal(["late"]);
  const stop = render(root, h("select", { multiple: true, value: values }));
  const select = root.firstChild;
  const observer = observers[0];
  assert.equal(observer.element, select);
  assert.equal(observer.options.subtree, true);
  const option = new TestElement("option");
  option.value = "late";
  select.insertBefore(option, null);
  observer.callback();
  assert.deepEqual(selected(select), ["late"]);
  option.value = "changed";
  observer.callback();
  assert.deepEqual(selected(select), []);
  stop();
  assert.equal(observer.disconnected, true);
}));

test("014 single selects choose the first duplicate value while multiple selects retain every match", async () => {
  for (const explicit of [false, true]) {
    for (const multiple of [false, true]) {
      const props = explicit ? { value: "same" } : {};
      const html = await renderToString(h("select", { value: multiple ? ["same"] : "same", multiple },
        h("option", { ...props, id: "first" }, "same"),
        h("option", { ...props, id: "second", selected: true }, "same")));
      assert.match(html, /id="first" selected/u);
      assert.equal((html.match(/ selected/g) ?? []).length, multiple ? 2 : 1);
      if (!multiple) assert.doesNotMatch(html, /id="second" selected/u);
    }
  }
});

test("014 duplicate single-select matching follows DOM order across late options and asynchronous labels", async () => {
  for (const kind of ["option", "label", "keyed"]) {
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const first = kind === "option"
      ? delayed.then(() => h("option", { id: "first", value: "same" }, "first"))
      : h("option", { id: "first" }, delayed.then(() => "same"));
    const second = h("option", { id: "second", value: "same" }, "second");
    const children = kind === "keyed" ? h(For, { each: [first, second] }, (value) => value) : [h("optgroup", { label: "Earlier" }, first), second];
    const rendering = renderToString(h("select", { value: "same" }, children));
    await Promise.resolve();
    release();
    const html = await rendering;
    assert.match(html, /<option[^>]*id="first"[^>]* selected/u, kind);
    assert.doesNotMatch(html, /<option[^>]*id="second"[^>]* selected/u, kind);
    assert.equal((html.match(/ selected/g) ?? []).length, 1);
  }
});

test("014 a pending earlier option does not leave later rejected option content unhandled", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const failure = new Error("later option failed");
  const rendering = renderToString(h("select", { value: "same" },
    h("option", {}, delayed),
    h("option", { value: "same" }, Promise.reject(failure)),
    h("option", { value: "same" }, "last")));
  await assert.rejects(rendering, (error) => error === failure);
  release("same");
  await new Promise((resolve) => setImmediate(resolve));
});
