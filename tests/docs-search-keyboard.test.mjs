import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

// Reuse the renderer's existing DOM fixture without importing its test cases.
const domTests = await readFile(new URL("./dom.test.mjs", import.meta.url), "utf8");
const fixtureStart = domTests.indexOf("class FakeNode {");
const fixtureEnd = domTests.indexOf("const { For, Portal,");
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
const { FakeNode, FakeElement } = new Function(`${domTests.slice(fixtureStart, fixtureEnd)}\nreturn { FakeNode, FakeElement };`)();
globalThis.HTMLElement = FakeElement;

function descendants(node) {
  return node.childNodes.flatMap((child) => [child, ...descendants(child)]);
}
function matches(element, selector) {
  const parts = selector.split(/\s+/u);
  function simple(node, part) {
    if (!(node instanceof FakeElement)) return false;
    const tag = part.match(/^[a-z]+/u)?.[0];
    const className = part.match(/\.([\w-]+)/u)?.[1];
    const attribute = part.match(/\[([\w-]+)(?:="([^"]*)")?\]/u);
    return (!tag || node.localName === tag)
      && (!className || node.classList.contains(className))
      && (!attribute || (node.hasAttribute(attribute[1]) && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2])));
  }
  if (!simple(element, parts.pop())) return false;
  let ancestor = element.parentNode;
  while (parts.length) {
    const part = parts.pop();
    while (ancestor && !simple(ancestor, part)) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}
FakeNode.prototype.contains = function (node) { return this === node || descendants(this).includes(node); };
FakeElement.prototype.querySelectorAll = function (selector) { return descendants(this).filter((node) => matches(node, selector)); };
FakeElement.prototype.querySelector = function (selector) { return this.querySelectorAll(selector)[0] ?? null; };
FakeElement.prototype.closest = function (selector) {
  for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node;
  return null;
};
Object.defineProperty(FakeElement.prototype, "isContentEditable", {
  get() {
    for (let node = this; node instanceof FakeElement; node = node.parentNode) {
      const value = node.getAttribute("contenteditable");
      if (value === "false") return false;
      if (value === "" || value === "true" || value === "plaintext-only") return true;
    }
    return false;
  },
});
function dispatch(target, type, properties = {}) {
  const event = {
    target, type, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...properties,
  };
  for (let node = target; node; node = node.parentNode) {
    event.currentTarget = node;
    node.listeners?.get(type)?.(event);
    if (event.stopped || type === "focus" || type === "blur") break;
  }
  return event;
}
FakeElement.prototype.focus = function () {
  assert.equal(this.closest("[hidden]"), null, "Cannot focus a hidden result");
  const previous = document.activeElement;
  if (previous === this) return;
  document.activeElement = this;
  if (previous) {
    dispatch(previous, "blur", { relatedTarget: this });
    dispatch(previous, "focusout", { relatedTarget: this });
  }
  dispatch(this, "focus", { relatedTarget: previous });
  dispatch(this, "focusin", { relatedTarget: previous });
};
FakeElement.prototype.blur = function () { document.body.focus(); };

const directory = await mkdtemp(join(tmpdir(), "clank-docs-search-keyboard-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await mkdir(join(directory, "dist"));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
await symlink(fileURLToPath(new URL("../docs-site/vendor/", import.meta.url)), join(directory, "vendor"));
const searchSource = await readFile(new URL("../docs-site/src/search.tsx", import.meta.url), "utf8");
await writeFile(join(directory, "dist/search.js"), compile(searchSource, { filename: "search.tsx", jsxImportSource: "../vendor/dom.js", sourceMap: false }));
const { SearchBox, handleSearchShortcut } = await import(pathToFileURL(join(directory, "dist/search.js")));
const { h, render, hydrate } = await import("../docs-site/vendor/dom.js");
const { renderToString } = await import("../docs-site/vendor/ssr.js");

const entries = [
  { slug: "alpha", title: "Guide Alpha", groupId: "framework", groupTitle: "Framework", description: "Alpha", headings: [] },
  { slug: "beta", title: "Guide Beta", groupId: "framework", groupTitle: "Framework", description: "Beta", headings: [] },
  { slug: "gamma", title: "Guide Gamma", groupId: "framework", groupTitle: "Framework", description: "Gamma", headings: [] },
  { slug: "other", title: "Guide Other", groupId: "start", groupTitle: "Start", description: "Other", headings: [] },
];
function searchFixture(t, { initialQuery = "guide", searchGroup = "framework", hydrated = false } = {}) {
  document.body = new FakeElement("body");
  document.activeElement = document.body;
  document.querySelector = (selector) => document.body.querySelector(selector);
  const root = new FakeElement("main");
  document.body.insertBefore(root, null);
  const view = h(SearchBox, { entries, initialQuery, searchGroup });
  const dispose = render(root, view);
  const initialInput = root.querySelector('input[type="search"]');
  if (hydrated) {
    const cleanup = hydrate(root, view);
    t.after(cleanup);
    assert.equal(root.getAttribute("data-clank-hydration"), "attached");
    assert.equal(root.querySelector('input[type="search"]'), initialInput, "Hydration retains the native input");
  }
  t.after(dispose);
  const form = root.querySelector("form");
  const input = form.querySelector('input[type="search"]');
  const popup = form.querySelector(".search-popover");
  const submit = form.querySelector("button");
  const outside = new FakeElement("a");
  outside.setAttribute("href", "/outside");
  document.body.insertBefore(outside, null);
  const key = (value, properties = {}) => dispatch(document.activeElement, "keydown", { key: value, ...properties });
  const type = (value) => { input.value = value; dispatch(input, "input"); };
  const links = () => popup.querySelectorAll("a[href]");
  return { root, form, input, popup, submit, outside, key, type, links };
}

test("quick search arrows move actual focus between the input and current category links", (t) => {
  const { input, popup, links, key } = searchFixture(t);
  assert.equal(popup.hasAttribute("hidden"), true);
  input.focus();
  assert.equal(popup.hasAttribute("hidden"), false);
  assert.equal(input.hasAttribute("aria-expanded"), false, "A native searchbox does not support aria-expanded");
  assert.equal(input.getAttribute("aria-controls"), popup.getAttribute("id"));
  assert.deepEqual(links().map((link) => link.getAttribute("href")), ["/docs/alpha", "/docs/beta", "/docs/gamma"]);
  for (const expected of [...links(), input]) {
    assert.equal(key("ArrowDown").defaultPrevented, true);
    assert.equal(document.activeElement, expected);
    assert.equal(popup.hasAttribute("hidden"), false);
  }
  for (const expected of [...links()].reverse().concat(input)) {
    assert.equal(key("ArrowUp").defaultPrevented, true);
    assert.equal(document.activeElement, expected);
  }
  assert.equal(popup.getAttribute("role"), "region");
  assert.ok(links().every((link) => !link.hasAttribute("role") && !link.hasAttribute("tabindex")), "Results remain native links in the tab order");
});

test("quick search Escape closes without clearing and restores input focus after hydration", (t) => {
  const { input, popup, key, links } = searchFixture(t, { hydrated: true });
  input.focus();
  key("ArrowDown");
  assert.equal(document.activeElement, links()[0]);
  const escape = key("Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true, "Only the active popup consumes Escape before page-level handlers");
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "guide");
  assert.equal(popup.hasAttribute("hidden"), true);
  assert.equal(input.hasAttribute("aria-expanded"), false);
  assert.equal(key("Escape").defaultPrevented, false);
  key("ArrowUp");
  assert.equal(document.activeElement, links().at(-1));
  assert.equal(popup.hasAttribute("hidden"), false);
});

test("quick search retains native Enter, mouse and Tab behavior and closes only when focus leaves", async (t) => {
  const { form, input, popup, submit, outside, key, links } = searchFixture(t);
  input.focus();
  assert.equal(key("Enter").defaultPrevented, false, "Input Enter submits full search");
  assert.equal(form.getAttribute("action"), "/search");
  assert.equal(form.getAttribute("method"), "get");
  assert.equal(form.querySelector('input[type="hidden"]').value, "framework");
  assert.equal(key("Tab").defaultPrevented, false);
  links()[0].focus(); // Browser default Tab or pointer focus.
  assert.equal(key("Enter").defaultPrevented, false, "Link Enter follows its native href");
  assert.equal(dispatch(links()[0], "click").defaultPrevented, false);
  assert.equal(dispatch(links()[0], "click", { ctrlKey: true }).defaultPrevented, false);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(popup.hasAttribute("hidden"), false, "The former blur timer must not hide focused links");
  assert.equal(key("Tab", { shiftKey: true }).defaultPrevented, false);
  submit.focus();
  assert.equal(popup.hasAttribute("hidden"), false);
  assert.equal(key("Enter").defaultPrevented, false);
  assert.equal(key("ArrowUp").defaultPrevented, false, "Submit keeps its native keyboard behavior");
  outside.focus();
  assert.equal(popup.hasAttribute("hidden"), true);
  assert.equal(document.activeElement, outside);
  input.focus();
  input.blur();
  assert.equal(popup.hasAttribute("hidden"), true);
});

test("quick search navigation follows changed results and leaves zero results, modifiers and composition alone", (t) => {
  const { input, popup, key, type, links } = searchFixture(t);
  input.focus();
  key("ArrowUp");
  input.focus();
  type("beta");
  assert.equal(links().length, 1);
  key("ArrowDown");
  assert.equal(document.activeElement.getAttribute("href"), "/docs/beta");
  input.focus();
  for (const properties of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    for (const value of ["ArrowDown", "ArrowUp", "Escape"]) {
      assert.equal(key(value, properties).defaultPrevented, Boolean(properties.defaultPrevented));
      assert.equal(document.activeElement, input);
      assert.equal(popup.hasAttribute("hidden"), false);
    }
  }
  type("no-such-guide");
  assert.equal(links().length, 0);
  assert.match(popup.textContent, /No matching guide/u);
  assert.equal(key("ArrowDown").defaultPrevented, false);
  assert.equal(key("ArrowUp").defaultPrevented, false);
  assert.equal(key("Enter").defaultPrevented, false);
  assert.equal(document.activeElement, input);
  type("   ");
  assert.equal(popup.hasAttribute("hidden"), true);
  assert.equal(key("ArrowDown").defaultPrevented, false);
  type("alpha");
  key("ArrowDown");
  assert.equal(document.activeElement.getAttribute("href"), "/docs/alpha");
});

test("slash shortcut respects editable descendants, native fields, modifiers and composition", (t) => {
  const { input, outside } = searchFixture(t);
  function shortcut(target, properties = {}) {
    const event = { target, key: "/", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    handleSearchShortcut(event);
    return event;
  }
  for (const tag of ["input", "textarea", "select"]) {
    const field = new FakeElement(tag);
    document.body.insertBefore(field, null);
    field.focus();
    assert.equal(shortcut(field).defaultPrevented, false);
    assert.equal(document.activeElement, field);
  }
  for (const value of ["", "true", "plaintext-only"]) {
    const editor = new FakeElement("div");
    editor.setAttribute("contenteditable", value);
    const child = new FakeElement("span");
    editor.insertBefore(child, null);
    document.body.insertBefore(editor, null);
    child.focus();
    assert.equal(shortcut(child).defaultPrevented, false);
    assert.equal(document.activeElement, child);
  }
  outside.focus();
  for (const properties of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: "x" }]) {
    assert.equal(shortcut(outside, properties).defaultPrevented, Boolean(properties.defaultPrevented));
    assert.equal(document.activeElement, outside);
  }
  assert.equal(shortcut(outside).defaultPrevented, true);
  assert.equal(document.activeElement, input);
});

test("quick search SSR retains native links, GET submission, category and hidden initial popup", async () => {
  const html = await renderToString(h(SearchBox, { entries, initialQuery: "guide", searchGroup: "framework" }));
  assert.match(html, /action="\/search" method="get" role="search"/u);
  assert.match(html, /name="q" value="guide"/u);
  assert.match(html, /type="hidden" name="group" value="framework"/u);
  assert.doesNotMatch(html, /aria-expanded/u);
  assert.match(html, /aria-controls="quick-search-results"/u);
  assert.match(html, /role="region" aria-label="Matching guides" hidden/u);
  assert.match(html, /href="\/docs\/alpha"/u);
  assert.doesNotMatch(html, /href="\/docs\/other"|role="(?:listbox|option)"/u);
  assert.match(html, /type="submit"/u);
});
