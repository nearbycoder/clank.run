import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-focus-"));
for (const name of ["storage", "focus-mode"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { FOCUS_MODE_KEY, focusPreference, installFocusMode } = await import(pathToFileURL(join(directory, "focus-mode.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const entries = [{ slug: "guide", title: "Example guide" }];

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, force) { if (force) this.attributes[name] = ""; else delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus(options) { document.activeElement = this; this.focusOptions = options; }
}

function fixture(t, initial, { articleExists = true, rootExists = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const body = new Element("body");
  const root = new Element();
  const article = new Element();
  const sidebar = new Element("aside");
  const toc = new Element("aside");
  const sidebarLink = new Element("a");
  const tocLink = new Element("a");
  sidebar.append(sidebarLink);
  toc.append(tocLink);
  const values = new Map(initial === undefined ? [] : [[FOCUS_MODE_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  let closes = 0;
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener(name, handler) { (listeners[name] ??= []).push(handler); },
  };
  globalThis.document = {
    body, activeElement: body,
    getElementById: (id) => ({ "docs-reader-tools": rootExists ? root : null, "docs-article-body": articleExists ? article : null, "docs-sidebar": sidebar })[id] ?? null,
    querySelector: (selector) => selector === ".toc" ? toc : null,
    createElement: (name) => new Element(name),
  };
  t.after(() => Object.assign(globalThis, previous));
  return {
    root, body, article, sidebarLink, tocLink, values, listeners,
    enabled: () => Object.hasOwn(body.attributes, "data-docs-focus"),
    closeNavigation: () => { closes++; },
    closes: () => closes,
    storage: (key = FOCUS_MODE_KEY) => { for (const handler of listeners.storage ?? []) handler({ key }); },
  };
}

test("focus preference accepts only the boolean true", () => {
  assert.equal(focusPreference(true), true);
  for (const value of [false, "true", 1, null, undefined, [], {}, { enabled: true }]) assert.equal(focusPreference(value), false);
});

test("a native toolbar toggle enters and exits focus mode, persists the preference, and retains keyboard focus", (t) => {
  const { root, values, enabled, closeNavigation, closes } = fixture(t);
  installFocusMode(entries, "guide", closeNavigation);
  const [toggle] = root.children;
  assert.equal(toggle.tagName, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.textContent, "Focus reading");
  assert.equal(toggle.attributes["aria-pressed"], "false");
  assert.equal(enabled(), false);
  toggle.focus();
  toggle.listeners.click();
  assert.equal(toggle.textContent, "Exit focus");
  assert.equal(toggle.attributes["aria-pressed"], "true");
  assert.equal(enabled(), true);
  assert.equal(values.get(FOCUS_MODE_KEY), "true");
  assert.equal(closes(), 1);
  assert.equal(document.activeElement, toggle);
  toggle.listeners.click();
  assert.equal(enabled(), false);
  assert.equal(values.get(FOCUS_MODE_KEY), "false");
  assert.equal(document.activeElement, toggle);
  assert.equal(closes(), 1);
});

test("a saved preference applies on known guides without duplicate controls or stealing article focus", (t) => {
  const { root, article, enabled, listeners } = fixture(t, true);
  article.focus();
  installFocusMode(entries, "guide");
  installFocusMode(entries, "guide");
  assert.equal(enabled(), true);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].textContent, "Exit focus");
  assert.equal(listeners.storage.length, 1);
  assert.equal(document.activeElement, article);
});

test("cross-tab activation restores focus before hiding side rails and closes an open mobile drawer once", (t) => {
  const { root, body, sidebarLink, tocLink, values, storage, enabled, closeNavigation, closes } = fixture(t);
  installFocusMode(entries, "guide", closeNavigation);
  const toggle = root.children[0];
  body.toggleAttribute = (name, force) => {
    if (force) {
      assert.equal(document.activeElement, toggle);
      body.attributes[name] = "";
    } else delete body.attributes[name];
  };
  for (const link of [sidebarLink, tocLink]) {
    link.focus();
    values.set(FOCUS_MODE_KEY, "true");
    storage();
    assert.equal(document.activeElement, toggle);
    assert.deepEqual(toggle.focusOptions, { preventScroll: true });
    assert.equal(enabled(), true);
    storage();
    values.set(FOCUS_MODE_KEY, "false");
    storage();
    assert.equal(enabled(), false);
  }
  assert.equal(closes(), 2);
});

test("storage synchronization ignores unrelated keys and resets when preferences are cleared or corrupted", (t) => {
  const { root, values, storage, enabled } = fixture(t, true);
  installFocusMode(entries, "guide");
  values.set(FOCUS_MODE_KEY, "false");
  storage("another-feature");
  assert.equal(enabled(), true);
  storage();
  assert.equal(enabled(), false);
  root.children[0].listeners.click();
  values.clear();
  storage(null);
  assert.equal(enabled(), false);
  for (const invalid of ["{", '"true"', "1", "true".padEnd(20), '{"enabled":true}']) {
    root.children[0].listeners.click();
    values.set(FOCUS_MODE_KEY, invalid);
    storage();
    assert.equal(enabled(), false);
  }
});

test("blocked storage leaves focus and exit controls usable", (t) => {
  const { root, enabled, storage } = fixture(t);
  Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => installFocusMode(entries, "guide"));
  assert.doesNotThrow(() => root.children[0].listeners.click());
  assert.equal(enabled(), true);
  assert.doesNotThrow(() => root.children[0].listeners.click());
  assert.equal(enabled(), false);
  assert.doesNotThrow(storage);
});

test("home, search, unknown guides, and missing article elements never apply the saved focus layout", async (t) => {
  for (const [slug, configuration] of [[undefined, {}], ["search", {}], ["unknown", {}], ["guide", { articleExists: false }], ["guide", { rootExists: false }]]) {
    await t.test(`${slug ?? "home"} ${JSON.stringify(configuration)}`, (t) => {
      const { root, body, values, listeners, enabled } = fixture(t, true, configuration);
      body.toggleAttribute("data-docs-focus", true);
      installFocusMode(entries, slug);
      assert.equal(enabled(), false);
      assert.equal(root.children.length, 0);
      assert.deepEqual(listeners, {});
      assert.equal(values.get(FOCUS_MODE_KEY), "true");
    });
  }
});
