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
const { signal, effect, createRoot, onCleanup } = await import("../dist/core.js");
const { createApi } = await import("../dist/backend.js");
const { createCheckbox } = await import("../dist/ui-controls.js");
const { mergeProps } = await import("../dist/ui-foundation.js");
const { AccountSecurity } = await import("../dist/account-security.js");

test("account security clears cached inventory and fences in-flight replies across account switches", async () => {
  const alice = { id: "alice", emailVerified: true }, bob = { id: "bob", emailVerified: true };
  const user = signal(alice), session = signal({ id: "alice-session" });
  let resolveSessions, resolvePasskeys, pending = false, passkeyCalls = 0;
  const auth = {
    user, session,
    listSessions: () => pending ? new Promise((resolve) => { resolveSessions = resolve; }) : Promise.resolve([{ id: "private-session", current: true, lastSeenAt: 0, authenticationMethod: "private-method" }]),
    listPasskeys: () => { passkeyCalls++; return pending ? new Promise((resolve) => { resolvePasskeys = resolve; }) : Promise.resolve([{ id: "private-key", name: "Alice private passkey" }]); },
  };
  const root = new FakeElement("main");
  const dispose = render(root, h(AccountSecurity, { auth }));
  const findButton = (node, text) => {
    if (node.localName === "button" && node.textContent === text) return node;
    for (const child of node.childNodes) { const found = findButton(child, text); if (found) return found; }
  };
  const refresh = () => findButton(root, "Refresh account security").listeners.get("click")({});
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    refresh(); await settle();
    assert.match(root.textContent, /Alice private passkey/);
    assert.match(root.textContent, /private-method/);
    user.value = bob; session.value = { id: "bob-session" };
    assert.doesNotMatch(root.textContent, /Alice private passkey|private-method|Security information refreshed/);
    user.value = alice; session.value = { id: "alice-session-2" }; pending = true;
    refresh(); await settle();
    user.value = bob; session.value = { id: "bob-session-2" };
    resolveSessions([{ id: "late-session", current: true, lastSeenAt: 0, authenticationMethod: "late-private-method" }]);
    await settle();
    assert.equal(passkeyCalls, 1, "a stale refresh cannot request the next account's inventory");
    assert.doesNotMatch(root.textContent, /late-private-method/);
    user.value = alice; session.value = { id: "alice-session-3" };
    refresh(); await settle(); resolveSessions([]); await settle();
    assert.equal(passkeyCalls, 2);
    user.value = bob; session.value = { id: "bob-session-3" };
    resolvePasskeys([{ id: "late-key", name: "Late private passkey" }]); await settle();
    assert.doesNotMatch(root.textContent, /Late private passkey|Security information refreshed/);
  } finally { dispose(); }
});

test("late MFA replies cannot alter the next account's controls or survive screen disposal", async () => {
  const user = signal({ id: "alice" }), session = signal({ id: "alice-session" }), replies = [];
  const auth = { user, session, startMfaReauthentication: () => new Promise((resolve) => { replies.push(resolve); }) };
  const root = new FakeElement("main");
  const dispose = render(root, h(AccountSecurity, { auth }));
  const form = () => root.children[0].children.find((node) => node.localName === "form");
  const submit = () => form().listeners.get("submit")({ preventDefault() {} });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    submit();
    user.value = { id: "bob" }; session.value = { id: "bob-session" };
    submit();
    assert.equal(replies.length, 2, "the next account can start its own verification");
    replies[0]({ challengeId: "private-alice-challenge" }); await settle();
    assert.doesNotMatch(root.textContent, /Verification code|Verification code sent/);
    const button = form().children.at(-1);
    assert.ok(button.disabled || button.hasAttribute("disabled"), "the previous reply cannot unlock Bob's pending operation");
    dispose();
    replies[1]({ challengeId: "private-bob-challenge" }); await settle();
    assert.equal(root.textContent, "");
    assert.equal(user.observers.size, 0); assert.equal(session.observers.size, 0);
  } finally { dispose(); }
});

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

test("DOM bindings validate coercible URL values and object data", () => {
  const root = new FakeElement("main");
  assert.throws(() => render(root, h("a", { href: ["javascript:alert(1)"] })), /Unsafe URL scheme/);
  assert.throws(() => render(root, h("object", { data: "data:text/html,<script>alert(1)</script>" })), /Unsafe data URL/);
  const href = signal("/safe");
  render(root, h("a", { href }));
  assert.throws(() => { href.value = ["java\nscript:alert(1)"]; }, /Unsafe URL scheme/);
  assert.equal(root.children[0].getAttribute("href"), "/safe");
});

test("DOM render, reactive bindings, and hydration reject implicit raw HTML", () => {
  for (const name of ["innerHTML", "outerHTML"]) {
    const root = new FakeElement("main");
    assert.throws(() => render(root, h("div", { [name]: "<strong>untrusted</strong>" })), /raw HTML/);
    const value = signal("<strong>untrusted</strong>");
    assert.throws(() => render(root, h("div", { [name]: value })), /raw HTML/);
    root.insertBefore(new FakeElement("div"), null);
    assert.throws(() => hydrate(root, h("div", { [name]: "<strong>untrusted</strong>" })), /raw HTML/);
  }
  const root = new FakeElement("main");
  render(root, h("div", { dangerouslySetInnerHTML: { __html: "<strong>trusted</strong>" } }));
  assert.equal(root.children[0].innerHTML, "<strong>trusted</strong>");
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

for (const mode of ["render", "hydrate"]) {
  test(`keyed ${mode} moves only the changed row in large rotations and prepends`, () => {
    const initial = Array.from({ length: 1_000 }, (_, id) => ({ id, label: `Row ${id}` }));
    const items = signal(initial);
    const root = new FakeElement("main");
    const mounted = new Map();
    const removed = [];
    const view = h(For, { each: items, by: "id", fallback: h("p", {}, "Empty") }, (item, index) =>
      h("p", { "data-id": String(item.id), ref: (node) => {
        if (node) mounted.set(item.id, node);
        else removed.push(item.id);
      } }, expression(() => `${item.label}:${index()}`)),
    );
    if (mode === "hydrate") {
      root.insertBefore(new FakeComment("clank:for"), null);
      for (const item of initial) {
        const paragraph = new FakeElement("p");
        paragraph.setAttribute("data-id", String(item.id));
        paragraph.insertBefore(new FakeComment("clank:start"), null);
        paragraph.insertBefore(new FakeText(`${item.label}:${item.id}`), null);
        paragraph.insertBefore(new FakeComment("clank:end"), null);
        root.insertBefore(paragraph, null);
      }
      root.insertBefore(new FakeComment("clank:/for"), null);
    }
    const dispose = mode === "hydrate" ? hydrate(root, view) : render(root, view);
    if (mode === "hydrate") assert.equal(root.getAttribute("data-clank-hydration"), "attached");
    const retained = root.children.slice();
    const textNodes = retained.map((node) => node.childNodes.find((child) => child instanceof FakeText));
    root.insertions = 0;
    items.value = [initial.at(-1), ...initial.slice(0, -1)];
    assert.equal(root.insertions, 1, "moving the last row to the front needs one DOM move");
    assert.deepEqual(root.children, [retained.at(-1), ...retained.slice(0, -1)]);
    assert.equal(root.children[0].textContent, "Row 999:0");
    assert.equal(root.children[1].textContent, "Row 0:1");
    for (let index = 0; index < retained.length; index++) {
      assert.equal(retained[index].childNodes.find((child) => child instanceof FakeText), textNodes[index]);
    }
    assert.deepEqual(removed, []);

    root.insertions = 0;
    items.value = [{ id: 1_000, label: "New" }, ...items.peek()];
    assert.equal(root.insertions, 2, "only mount and place the new row; retained rows stay in place");
    assert.equal(mounted.size, 1_001);
    assert.equal(root.children[0].textContent, "New:0");
    assert.equal(root.children[1], retained.at(-1));

    root.insertions = 0;
    items.value = items.peek().filter((item) => item.id !== 500);
    assert.equal(root.insertions, 0, "deletion does not move retained rows");
    assert.deepEqual(removed, [500]);
    items.value = [];
    assert.equal(root.textContent, "Empty");
    assert.equal(removed.length, 1_001);
    dispose();
    assert.equal(root.childNodes.length, 0);
  });
}

test("keyed permutations preserve minimal retained ranges, including fragments and empty rows", () => {
  const initial = Array.from({ length: 5 }, (_, id) => ({ id }));
  const permutations = (values) => values.length === 0 ? [[]] : values.flatMap((value, index) =>
    permutations(values.filter((_, offset) => offset !== index)).map((tail) => [value, ...tail]));
  // A small independent quadratic oracle keeps the move budget independent of
  // the renderer's binary-search algorithm.
  const increasingLength = (values) => {
    const lengths = values.map(() => 1);
    for (let index = 0; index < values.length; index++) {
      for (let before = 0; before < index; before++) {
        if (values[before] < values[index]) lengths[index] = Math.max(lengths[index], lengths[before] + 1);
      }
    }
    return Math.max(...lengths);
  };
  const items = signal(initial);
  const root = new FakeElement("main");
  const dispose = render(root, h(For, { each: items, by: "id" }, (item) => [
    h("span", { "data-id": String(item.id) }, String(item.id)),
    h("b", {}, "!"),
  ]));
  const identities = new Map(initial.map((item, index) => [item.id, root.children.slice(index * 2, index * 2 + 2)]));
  let previous = initial;
  for (const next of permutations(initial)) {
    root.insertions = 0;
    items.value = next;
    assert.deepEqual(root.children, next.flatMap((item) => identities.get(item.id)));
    const positions = next.map((item) => previous.indexOf(item));
    assert.equal(root.insertions, 2 * (initial.length - increasingLength(positions)));
    previous = next;
  }
  dispose();

  const emptyItems = signal(initial);
  const emptyRoot = new FakeElement("main");
  const stop = render(emptyRoot, h(For, { each: emptyItems, by: "id" }, (item) =>
    item.id === 1 ? [] : item.id === 3 ? null : h("span", {}, String(item.id))));
  for (const next of permutations(initial)) {
    emptyItems.value = next;
    assert.equal(emptyRoot.textContent, next.filter((item) => item.id !== 1 && item.id !== 3).map((item) => item.id).join(""));
  }
  stop();
});

test("keyed For resolves array accessors and tracks their reactive dependencies", () => {
  const items = signal([
    { id: "navigation-menu", name: "NavigationMenu" },
  ]);
  const root = new FakeElement("main");
  render(root, h(For, { each: () => items.value, by: "id" }, (item) =>
    h("article", { "data-id": expression(() => item.id) }, expression(() => item.name)),
  ));

  assert.equal(root.textContent, "NavigationMenu");
  items.value = [{ id: "toolbar", name: "Toolbar" }];
  assert.equal(root.textContent, "Toolbar");
  assert.deepEqual(root.children.map((node) => node.getAttribute("data-id")), ["toolbar"]);
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

test("removing reflected properties does not recreate false-valued attributes", () => {
  const root = new FakeElement("main");
  const attributes = signal({ id: "example", role: "combobox", title: "Example", disabled: true });
  render(root, h("button", Object.fromEntries(["id", "role", "title", "disabled"].map((name) => [name, expression(() => attributes.value[name])]))));
  const button = root.children[0];
  for (const name of ["id", "role", "title"]) {
    Object.defineProperty(button, name, {
      configurable: true,
      get() { return this.getAttribute(name); },
      set(value) { this.setAttribute(name, String(value)); },
    });
  }
  assert.equal(button.getAttribute("role"), "combobox");
  button.disabled = true;
  attributes.value = { id: undefined, role: null, title: false, disabled: false };
  for (const name of ["id", "role", "title", "disabled"]) assert.equal(button.hasAttribute(name), false, name);
  assert.equal(button.disabled, false);
});

const { observeHydration, withHydrationSource } = await import('../dist/hydration-inspection.js');
const { createDevtools, exportHydrationSnapshot } = await import('../dist/devtools.js');
function inspectHydration(run) {
  const inspector = createDevtools({ hydration: true }), warn = console.warn;
  const warnings = []; console.warn = (...args) => warnings.push(args);
  try { return run(inspector, warnings); } finally { inspector.dispose(); console.warn = warn; }
}

test('hydration inspection locates the original nested mismatch and component source before cleanup', () => inspectHydration(inspector => {
  const root = new FakeElement('main'), section = new FakeElement('section'), old = new FakeElement('span');
  old.setAttribute('data-private', 'private tenant attribute'); old.insertBefore(new FakeText('private SSR text'), null); section.insertBefore(old, null); root.insertBefore(section, null);
  function Greeting() { return h('section', {}, withHydrationSource(h('button', {}, 'private client text'), { file: '/private/workspace/Greeting.tsx', line: 13, column: 7 })); }
  const dispose = hydrate(root, h(Greeting));
  const [event] = inspector.snapshot().hydration;
  assert.equal(event.reason, 'element-type'); assert.equal(event.outcome, 'remount'); assert.deepEqual(event.path, [0, 0]); assert.equal(event.pathTruncated, false);
  assert.equal(event.component, 'Greeting'); assert.deepEqual(event.source, { file: 'Greeting.tsx', line: 13, column: 7 });
  assert.deepEqual(event.expected, { kind: 'element', tag: 'button' }); assert.deepEqual(event.actual, { kind: 'element', tag: 'span' });
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.path) && Object.isFrozen(event.source));
  const exported = exportHydrationSnapshot(inspector.snapshot()); assert.doesNotMatch(exported, /private|tenant|SSR text|client text|workspace|data-private/);
  assert.equal(JSON.parse(exported).protocol, 'clank-hydration-snapshot/1'); assert.equal(root.getAttribute('data-clank-hydration'), 'remounted'); dispose();
}));

test('text patch inspection preserves node identity and throwing listeners cannot track application signals', () => inspectHydration(inspector => {
  const unrelated = signal('private listener value'); const stop = observeHydration(() => { unrelated.value; throw new Error('private observer failure'); });
  let runs = 0;
  try {
    createRoot(dispose => {
      effect(() => {
        runs++; const root = new FakeElement('main'), p = new FakeElement('p'), text = new FakeText('private server value'); p.insertBefore(text, null); root.insertBefore(p, null);
        const cleanup = hydrate(root, h('p', {}, 'private client value'));
        assert.equal(root.children[0], p); assert.equal(p.childNodes[0], text); assert.equal(text.data, 'private client value'); assert.equal(root.getAttribute('data-clank-hydration'), 'attached'); onCleanup(cleanup);
      });
      unrelated.value = 'changed'; assert.equal(runs, 1); dispose();
    });
    const [event] = inspector.snapshot().hydration; assert.equal(event.reason, 'text-content'); assert.equal(event.outcome, 'patch'); assert.deepEqual(event.path, [0, 0]); assert.doesNotMatch(exportHydrationSnapshot(inspector.snapshot()), /private/);
  } finally { stop(); }
}));

test('marker and trailing-node diagnostics never expose private comment or markup contents', () => inspectHydration((inspector, warnings) => {
  const root = new FakeElement('main'), p = new FakeElement('p'); p.insertBefore(new FakeComment('private SSR marker contents'), null); root.insertBefore(p, null);
  let dispose = hydrate(root, h('p', {}, expression(() => 'private text')));
  let event = inspector.snapshot().hydration.at(-1); assert.equal(event.reason, 'marker'); assert.deepEqual(event.path, [0, 0]); assert.deepEqual(event.actual, { kind: 'comment' }); dispose();
  root.insertBefore(new FakeElement('p'), null); root.insertBefore(new FakeElement('private-customer'), null);
  dispose = hydrate(root, h('p')); event = inspector.snapshot().hydration.at(-1); assert.equal(event.reason, 'trailing-nodes'); assert.deepEqual(event.path, [1]); assert.deepEqual(event.actual, { kind: 'element', tag: 'custom' }); dispose();
  assert.doesNotMatch(JSON.stringify(warnings), /private/); assert.doesNotMatch(exportHydrationSnapshot(inspector.snapshot()), /private/);
}));

test('hydration history and deeply nested paths are bounded, clearable, and disposable', () => {
  const inspector = createDevtools({ hydration: true, maxEvents: 2 }), warn = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 4; i++) { const root = new FakeElement('main'); root.insertBefore(new FakeElement('span'), null); hydrate(root, h('button'))(); }
    assert.equal(inspector.snapshot().hydration.length, 2); assert.equal(inspector.snapshot().truncated, true); inspector.clear(); assert.equal(inspector.snapshot().hydration.length, 0); assert.equal(inspector.snapshot().truncated, false);
    const root = new FakeElement('main'); let parent = root, view = h('button');
    for (let i = 0; i < 40; i++) { const div = new FakeElement('div'); parent.insertBefore(div, null); parent = div; view = h('div', {}, view); }
    parent.insertBefore(new FakeElement('span'), null); hydrate(root, view)();
    assert.equal(inspector.snapshot().hydration[0].path.length, 32); assert.equal(inspector.snapshot().hydration[0].pathTruncated, true); assert.equal(inspector.snapshot().truncated, true);
    inspector.dispose(); const other = new FakeElement('main'); other.insertBefore(new FakeElement('span'), null); hydrate(other, h('button'))(); assert.equal(inspector.snapshot().hydration.length, 0);
    assert.equal(createDevtools().snapshot().hydration, undefined); assert.throws(() => createDevtools({ hydration: 'yes' }), /boolean/);
  } finally { inspector.dispose(); console.warn = warn; }
});

test('hydration inspection preserves application exceptions and ignores invalid optional VNode metadata', () => inspectHydration(inspector => {
  const root = new FakeElement('main'); root.insertBefore(new FakeElement('button'), null);
  assert.throws(() => hydrate(root, h('button', { onClick: 'invalid' })), /expects an event listener/); assert.equal(inspector.snapshot().hydration.length, 0);
  const view = h('button'); Object.defineProperty(view, 'source', { get() { throw new Error('optional metadata'); } });
  const dispose = hydrate(root, view); assert.equal(root.getAttribute('data-clank-hydration'), 'attached'); dispose();
  assert.throws(() => withHydrationSource(h('button'), { file: 'x.tsx', line: 0, column: 1 }), /source location/);
}));

test('hydration export selects explicit fields and rejects oversized or invalid snapshots', () => inspectHydration(inspector => {
  const root = new FakeElement('main'); root.insertBefore(new FakeElement('span'), null); hydrate(root, h('button'))();
  const snapshot = inspector.snapshot(), event = snapshot.hydration[0];
  const encoded = exportHydrationSnapshot({ ...snapshot, secret: 'private query', hydration: [{ ...event, secret: 'private state', expected: { ...event.expected, secret: 'private markup' } }] });
  assert.doesNotMatch(encoded, /private|secret|queries|events/); assert.equal(encoded, exportHydrationSnapshot(snapshot));
  assert.throws(() => exportHydrationSnapshot({ ...snapshot, hydration: Array(5001).fill(event) }), /at most 5000/);
  assert.throws(() => exportHydrationSnapshot({ ...snapshot, hydration: [{ ...event, path: [-1] }] }), /snapshot entry/);
  assert.throws(() => exportHydrationSnapshot({ ...snapshot, hydration: [{ ...event, source: { file: '/private/x.tsx', line: 1, column: 1 } }] }), /source location/);
}));

test('missing text, absent elements, client nodes and asynchronous views retain accurate fallback reasons', async () => {
  const inspector = createDevtools({ hydration: true }), warn = console.warn; console.warn = () => {};
  try {
    const root = new FakeElement('main'); root.insertBefore(new FakeElement('span'), null); hydrate(root, 'private expected text')();
    let event = inspector.snapshot().hydration.at(-1); assert.equal(event.reason, 'text-node'); assert.deepEqual(event.path, [0]);
    hydrate(root, h('button'))(); event = inspector.snapshot().hydration.at(-1); assert.equal(event.reason, 'element-type'); assert.deepEqual(event.actual, { kind: 'missing' }); assert.deepEqual(event.path, [0]);
    root.insertBefore(new FakeElement('span'), null); hydrate(root, new FakeElement('button'))(); assert.equal(inspector.snapshot().hydration.at(-1).reason, 'client-node');
    const cleanup = hydrate(root, Promise.resolve(h('button'))); assert.equal(inspector.snapshot().hydration.at(-1).reason, 'async-view'); await Promise.resolve(); cleanup();
    root.insertBefore(new FakeComment('clank:for'), null);
    assert.throws(() => hydrate(root, For({ each: 'invalid', children: () => h('p') })));
    assert.equal(inspector.snapshot().hydration.at(-1).reason, 'keyed-value');
    assert.doesNotMatch(exportHydrationSnapshot(inspector.snapshot()), /private expected text/);
  } finally { inspector.dispose(); console.warn = warn; }
});
