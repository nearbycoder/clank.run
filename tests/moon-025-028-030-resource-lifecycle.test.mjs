import test from "node:test";
import assert from "node:assert/strict";
import { For, h, render, hydrate } from "../dist/dom.js";
import { batch, effect, signal } from "../dist/core.js";
import { mergeProps } from "../dist/ui-foundation.js";

class TestNode {
  constructor(type = 1) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
}
class TestElement extends TestNode {
  constructor(tag) {
    super(); this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase();
    this.attributes = new Map(); this.listeners = new Map(); this.live = {}; this.dirty = new Set();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  get checked() { return this.dirty.has("checked") ? this.live.checked : this.hasAttribute("checked"); }
  set checked(value) { this.dirty.add("checked"); this.live.checked = Boolean(value); }
  get selected() { return this.dirty.has("selected") ? this.live.selected : this.hasAttribute("selected"); }
  set selected(value) { this.dirty.add("selected"); this.live.selected = Boolean(value); }
}
function withDOM(run) {
  const names = ["Node", "Element", "document"];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { Node: TestNode, Element: TestElement, document: {
    createElement: (tag) => new TestElement(tag),
    createComment: (data) => Object.assign(new TestNode(8), { data }),
  } });
  try { return run(); } finally { Object.assign(globalThis, previous); }
}
function failures(error) {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

test("025 reactive checked and selected true restore live native state after user edits", () => withDOM(() => {
  for (const [tag, property] of [["input", "checked"], ["option", "selected"]]) {
    for (const attach of [render, hydrate]) {
      const root = new TestElement("main");
      if (attach === hydrate) root.insertBefore(new TestElement(tag), null);
      const value = signal(true);
      const stop = attach(root, h(tag, { [property]: value }));
      const element = root.firstChild;
      try {
        assert.equal(element[property], true);
        element[property] = false;
        assert.equal(element.hasAttribute(property), true, "native live state may differ from its default attribute");
        value.value = false;
        value.value = true;
        assert.equal(element[property], true);
        assert.equal(element.hasAttribute(property), true);
      } finally { stop(); }
    }
  }
}));

test("028 failed directive installation unwinds prior directives and earlier native listeners", () => withDOM(() => {
  for (const attach of [render, hydrate]) {
    const root = new TestElement("main");
    if (attach === hydrate) root.insertBefore(new TestElement("button"), null);
    const failure = new Error("installation failed");
    const cleaned = [];
    let element;
    const view = h("button", { onClick() {}, use: [
      (node) => { element = node; return () => cleaned.push("first"); },
      () => { throw failure; },
      () => assert.fail("later directive must not install"),
    ] });
    assert.throws(() => attach(root, view), (error) => error === failure);
    assert.deepEqual(cleaned, ["first"]);
    assert.equal(element.listeners.size, 0);
    if (attach === render) assert.equal(root.firstChild, null);
  }
}));

test("028–029 directive rollback attempts every cleanup and preserves the installation error", () => withDOM(() => {
  for (const merged of [false, true]) {
    const failure = new Error("installation failed");
    const cleanupFailure = new Error("cleanup failed");
    const cleaned = [];
    const directives = [
      () => () => { cleaned.push("first"); },
      () => () => { cleaned.push("second"); throw cleanupFailure; },
      () => { throw failure; },
    ];
    const props = merged ? mergeProps(...directives.map((use) => ({ use }))) : { use: directives };
    assert.throws(() => render(new TestElement("main"), h("button", props)), (error) => {
      assert.deepEqual(failures(error), [failure, cleanupFailure]);
      return true;
    });
    assert.deepEqual(cleaned, ["second", "first"]);
  }
}));

test("029 disposal continues all directives, listeners, refs, and siblings after cleanup failures", () => withDOM(() => {
  for (const merged of [false, true]) {
    const root = new TestElement("main");
    const firstFailure = new Error("first cleanup failed");
    const secondFailure = new Error("second cleanup failed");
    const cleaned = [];
    const ref = signal(null);
    const directives = [
      () => () => { cleaned.push("first"); throw firstFailure; },
      () => () => { cleaned.push("second"); throw secondFailure; },
    ];
    const props = merged ? mergeProps(...directives.map((use) => ({ use }))) : { use: directives };
    const stop = render(root, [h("aside", { use: () => () => cleaned.push("sibling") }), h("button", { onClick() {}, ...props, ref })]);
    const element = ref.value;
    assert.throws(stop, (error) => {
      assert.deepEqual(failures(error), [secondFailure, firstFailure]);
      return true;
    });
    assert.deepEqual(cleaned, ["second", "first", "sibling"]);
    assert.equal(element.listeners.size, 0);
    assert.equal(ref.value, null);
    assert.equal(root.firstChild, null);
    stop();
    assert.deepEqual(cleaned, ["second", "first", "sibling"], "cleanup remains idempotent after throwing");
  }
}));

test("029 merged directives also dispose once when used independently of the renderer", () => {
  const cleaned = [];
  const failure = new Error("cleanup failed");
  const cleanup = mergeProps(
    { use: () => () => cleaned.push("first") },
    { use: () => () => { cleaned.push("second"); throw failure; } },
  ).use({});
  assert.throws(cleanup, (error) => error === failure);
  cleanup();
  assert.deepEqual(cleaned, ["second", "first"]);
});

test("029 a failing keyed row cleanup does not skip the remaining rows", () => withDOM(() => {
  const root = new TestElement("main");
  const cleaned = [];
  const failure = new Error("row cleanup failed");
  const stop = render(root, h(For, { each: ["first", "second"] }, (item) => h("button", { use: () => () => {
    cleaned.push(item);
    if (item === "second") throw failure;
  } })));
  assert.throws(stop, (error) => error === failure);
  assert.deepEqual(cleaned, ["second", "first"]);
  assert.equal(root.firstChild, null);
}));

test("028–029 throwing callback refs roll back once during mount and hydration without losing either error", () => withDOM(() => {
  for (const attach of [render, hydrate]) {
    for (const throwOnClear of [false, true]) {
      const root = new TestElement("main");
      if (attach === hydrate) root.insertBefore(new TestElement("button"), null);
      const failure = new Error("ref attachment failed");
      const cleanupFailure = new Error("ref cleanup failed");
      const refs = [], cleaned = [];
      const title = signal("before");
      const view = h("button", {
        title, onClick() {}, use: () => () => cleaned.push("directive"),
        ref(node) {
          refs.push(node);
          if (node) throw failure;
          if (throwOnClear) throw cleanupFailure;
        },
      });
      assert.throws(() => attach(root, view), (error) => {
        assert.deepEqual(failures(error), throwOnClear ? [failure, cleanupFailure] : [failure]);
        return true;
      });
      assert.equal(refs.length, 2);
      assert.ok(refs[0] instanceof TestElement);
      assert.equal(refs[1], null);
      assert.deepEqual(cleaned, ["directive"]);
      assert.equal(refs[0].listeners.size, 0);
      assert.equal(title.observers.size, 0);
      title.value = "after";
      assert.equal(refs[0].getAttribute("title"), "before");
      assert.equal(root.firstChild, attach === hydrate ? refs[0] : null);
    }
  }
}));

test("028 hydration does not clear a callback ref whose assignment was never reached", () => withDOM(() => {
  const root = new TestElement("main");
  root.insertBefore(new TestElement("button"), null);
  const refs = [], failure = new Error("directive failed before ref");
  assert.throws(() => hydrate(root, h("button", {
    use() { throw failure; }, ref(node) { refs.push(node); },
  })), (error) => error === failure);
  assert.deepEqual(refs, []);
}));

function keyedServerRoot(items) {
  const root = new TestElement("main");
  root.insertBefore(document.createComment("clank:for"), null);
  for (const item of items) root.insertBefore(new TestElement("button"), null);
  root.insertBefore(document.createComment("clank:/for"), null);
  return root;
}

test("029 keyed reconciliation removes every discarded row despite cleanup errors and retains live rows", () => withDOM(() => {
  for (const attach of [render, hydrate]) {
    for (const multipleFailures of [false, true]) {
      const items = signal(["first", "second", "kept"]);
      const root = attach === hydrate ? keyedServerRoot(items.peek()) : new TestElement("main");
      const cleaned = [], refs = new Map(), nodes = new Map();
      const firstFailure = new Error("first row failed"), secondFailure = new Error("second row failed");
      const stop = attach(root, h(For, { each: items, by: (item) => item }, (item) => h("button", {
        onClick() {},
        ref(node) { refs.set(item, node); if (node) nodes.set(item, node); },
        use: () => () => {
          cleaned.push(item);
          if (item === "first") throw firstFailure;
          if (item === "second" && multipleFailures) throw secondFailure;
        },
      })));
      const kept = nodes.get("kept");
      assert.throws(() => { items.value = ["kept"]; }, (error) => {
        assert.deepEqual(failures(error), multipleFailures ? [firstFailure, secondFailure] : [firstFailure]);
        return true;
      });
      assert.deepEqual(cleaned, ["first", "second"]);
      for (const item of ["first", "second"]) {
        assert.equal(nodes.get(item).parentNode, null);
        assert.equal(nodes.get(item).listeners.size, 0);
        assert.equal(refs.get(item), null);
      }
      assert.equal(kept.parentNode, root);
      assert.equal(kept.listeners.size, 1);
      items.value = ["new", "kept"];
      assert.equal(nodes.get("kept"), kept);
      assert.deepEqual(root.childNodes.filter((node) => node.nodeType === 1), [nodes.get("new"), kept]);
      stop(); stop();
      assert.deepEqual(cleaned, ["first", "second", "kept", "new"]);
      assert.equal(root.firstChild, null);
      assert.equal(items.observers.size, 0);
    }
  }
}));

test("029 keyed reconciliation reaches its empty fallback after a removed row throws and stays disposable", () => withDOM(() => {
  for (const attach of [render, hydrate]) {
    const items = signal(["first", "second"]);
    const root = attach === hydrate ? keyedServerRoot(items.peek()) : new TestElement("main");
    const cleaned = [], nodes = [];
    const failure = new Error("first row failed");
    const stop = attach(root, h(For, {
      each: items, by: (item) => item,
      fallback: h("aside", { use: () => () => cleaned.push("fallback") }),
    }, (item) => h("button", {
      onClick() {}, ref(node) { if (node) nodes.push(node); },
      use: () => () => { cleaned.push(item); if (item === "first") throw failure; },
    })));
    assert.throws(() => { items.value = []; }, (error) => error === failure);
    assert.deepEqual(cleaned, ["first", "second"]);
    assert.equal(nodes.every((node) => node.parentNode === null && node.listeners.size === 0), true);
    assert.deepEqual(root.childNodes.filter((node) => node.nodeType === 1).map((node) => node.localName), ["aside"]);
    stop(); stop();
    assert.deepEqual(cleaned, ["first", "second", "fallback"]);
    assert.equal(root.firstChild, null);
  }
}));

test("030 an initially throwing unowned effect detaches dependencies and runs its registered cleanup", () => {
  for (const defer of [false, true]) {
    const source = signal(0);
    const failure = new Error("effect failed");
    let runs = 0;
    let cleanups = 0;
    assert.throws(() => effect((cleanup) => {
      source.value;
      runs++;
      cleanup(() => { cleanups++; });
      throw failure;
    }, { defer }), (error) => error === failure);
    assert.equal(source.observers.size, 0);
    source.value = 1;
    assert.equal(runs, 1);
    assert.equal(cleanups, 1);
  }
});

test("030 initial effect and cleanup errors are both reported without leaving an active observer", () => {
  const source = signal(0);
  const failure = new Error("effect failed");
  const cleanupFailure = new Error("cleanup failed");
  assert.throws(() => effect((cleanup) => {
    source.value;
    cleanup(() => { throw cleanupFailure; });
    throw failure;
  }), (error) => {
    assert.deepEqual(failures(error), [failure, cleanupFailure]);
    return true;
  });
  assert.equal(source.observers.size, 0);
  source.value = 1;
  const seen = [];
  const stop = effect(() => { seen.push(source.value); });
  source.value = 2;
  stop();
  assert.deepEqual(seen, [1, 2]);
});

test("030 a deferred first run failing at batch exit also releases its observer", () => {
  const source = signal(0);
  const failure = new Error("deferred effect failed");
  let cleaned = 0;
  assert.throws(() => batch(() => {
    effect((cleanup) => {
      source.value;
      cleanup(() => { source.value; cleaned++; });
      throw failure;
    }, { defer: true });
  }), (error) => error === failure);
  assert.equal(source.observers.size, 0);
  assert.equal(cleaned, 1);
  source.value = 1;
});
