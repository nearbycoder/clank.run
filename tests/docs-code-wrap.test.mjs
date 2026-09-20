import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-code-wrap-"));
for (const name of ["storage", "code-wrap"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { CODE_WRAP_KEY, codeWrapPreference, installCodeWrap } = await import(pathToFileURL(join(directory, "code-wrap.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const entries = [{ slug: "guide", title: "Example guide" }];

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  toggleAttribute(name, enabled) { if (enabled) this.attributes[name] = ""; else delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

function fixture(t, initial, { articleExists = true, rootExists = true, blockExists = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const root = new Element();
  const article = new Element();
  article.id = "docs-article-body";
  const pre = new Element("pre");
  pre.setAttribute("tabindex", "0");
  const code = new Element("code");
  code.textContent = '  const longValue = "a very long original line";\n\treturn longValue;\n';
  pre.append(code);
  const copy = new Element("button");
  copy.addEventListener("click", () => code.textContent);
  const inline = new Element("code");
  inline.textContent = "inline code";
  const table = new Element("table");
  table.textContent = "Table contents";
  article.append(pre, copy, inline, table);
  article.querySelector = (selector) => selector === ".code-block pre > code" && blockExists ? code : null;
  const values = new Map(initial === undefined ? [] : [[CODE_WRAP_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener(name, handler) { (listeners[name] ??= []).push(handler); },
  };
  globalThis.document = {
    activeElement: pre,
    getElementById: (id) => ({ "docs-reader-tools": rootExists ? root : null, "docs-article-body": articleExists ? article : null })[id] ?? null,
    createElement: (name) => new Element(name),
  };
  t.after(() => Object.assign(globalThis, previous));
  return {
    root, article, pre, code, copy, inline, table, values, listeners,
    enabled: () => Object.hasOwn(article.attributes, "data-docs-code-wrap"),
    storage: (key = CODE_WRAP_KEY) => { for (const handler of listeners.storage ?? []) handler({ key }); },
  };
}

test("code wrapping is enabled only by an explicit boolean preference", () => {
  assert.equal(codeWrapPreference(true), true);
  for (const value of [false, "true", 1, null, undefined, [], {}, { enabled: true }]) assert.equal(codeWrapPreference(value), false);
});

test("a labeled native button toggles wrapping and persists it while preserving code, copying, and keyboard scrolling", (t) => {
  const { root, article, pre, code, copy, inline, table, enabled, values } = fixture(t);
  const originalText = code.textContent;
  const originalChildren = [...article.children];
  const originalCopy = copy.listeners.click;
  installCodeWrap(entries, "guide");
  const [toggle] = root.children;
  assert.equal(toggle.tagName, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.textContent, "Wrap code");
  assert.equal(toggle.attributes["aria-controls"], article.id);
  assert.equal(toggle.attributes["aria-pressed"], "false");
  assert.equal(enabled(), false);
  assert.equal(values.has(CODE_WRAP_KEY), false, "default reading does not create storage");
  for (const expected of [true, false]) {
    toggle.listeners.click();
    assert.equal(enabled(), expected);
    assert.equal(toggle.attributes["aria-pressed"], String(expected));
    assert.equal(values.get(CODE_WRAP_KEY), String(expected));
    assert.deepEqual(article.children, originalChildren);
    assert.equal(code.textContent, originalText);
    assert.equal(copy.listeners.click, originalCopy);
    assert.equal(copy.listeners.click(), originalText);
    assert.equal(pre.attributes.tabindex, "0");
    assert.equal(document.activeElement, pre);
    assert.equal(inline.textContent, "inline code");
    assert.deepEqual(inline.attributes, {});
    assert.equal(table.textContent, "Table contents");
    assert.deepEqual(table.attributes, {});
  }
});

test("saved wrapping installs only one control and listener per article without changing focused content", (t) => {
  const { root, pre, enabled, listeners } = fixture(t, true);
  installCodeWrap(entries, "guide");
  installCodeWrap(entries, "guide");
  assert.equal(enabled(), true);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].attributes["aria-pressed"], "true");
  assert.equal(listeners.storage.length, 1);
  assert.equal(document.activeElement, pre);
});

test("cross-tab changes apply, unrelated keys are ignored, and missing or malformed preferences restore horizontal scrolling", (t) => {
  const { root, values, enabled, storage } = fixture(t);
  installCodeWrap(entries, "guide");
  const [toggle] = root.children;
  values.set(CODE_WRAP_KEY, "true");
  storage("unrelated");
  assert.equal(enabled(), false);
  storage();
  assert.equal(enabled(), true);
  assert.equal(toggle.attributes["aria-pressed"], "true");
  values.clear();
  storage(null);
  assert.equal(enabled(), false);
  for (const malformed of ["{", '"true"', "1", "null", "[]", '{"enabled":true}', "true".padEnd(9)]) {
    toggle.listeners.click();
    assert.equal(enabled(), true);
    values.set(CODE_WRAP_KEY, malformed);
    storage();
    assert.equal(enabled(), false);
    assert.equal(toggle.attributes["aria-pressed"], "false");
  }
});

test("blocked storage never prevents wrapping or returning to horizontal scrolling", (t) => {
  const { root, enabled, storage } = fixture(t);
  Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => installCodeWrap(entries, "guide"));
  assert.equal(enabled(), false);
  const [toggle] = root.children;
  assert.doesNotThrow(() => toggle.listeners.click());
  assert.equal(enabled(), true);
  assert.doesNotThrow(() => toggle.listeners.click());
  assert.equal(enabled(), false);
  assert.doesNotThrow(storage);
});

test("home, search, unknown guides, missing hosts, and guides without fenced code have no wrapping control", async (t) => {
  for (const [slug, configuration] of [[undefined, {}], ["search", {}], ["unknown", {}], ["guide", { articleExists: false }], ["guide", { rootExists: false }], ["guide", { blockExists: false }]]) {
    await t.test(`${slug ?? "home"} ${JSON.stringify(configuration)}`, (t) => {
      const { root, values, enabled, listeners } = fixture(t, true, configuration);
      installCodeWrap(entries, slug);
      assert.equal(enabled(), false);
      assert.equal(root.children.length, 0);
      assert.deepEqual(listeners, {});
      assert.equal(values.get(CODE_WRAP_KEY), "true");
    });
  }
});
