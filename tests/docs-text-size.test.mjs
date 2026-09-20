import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-text-size-"));
for (const name of ["storage", "text-size"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { TEXT_SIZE_KEY, textSizePreference, installTextSize } = await import(pathToFileURL(join(directory, "text-size.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const entries = [{ slug: "guide", title: "Example guide" }];

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

function fixture(t, initial, { articleExists = true, rootExists = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const root = new Element();
  const article = new Element();
  article.id = "docs-article-body";
  const values = new Map(initial === undefined ? [] : [[TEXT_SIZE_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  const activeElement = new Element("a");
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener(name, handler) { (listeners[name] ??= []).push(handler); },
  };
  globalThis.document = {
    activeElement,
    getElementById: (id) => ({ "docs-reader-tools": rootExists ? root : null, "docs-article-body": articleExists ? article : null })[id] ?? null,
    createElement: (name) => new Element(name),
  };
  t.after(() => Object.assign(globalThis, previous));
  return {
    root, article, values, listeners, activeElement,
    size: () => article.attributes["data-docs-text-size"],
    storage: (key = TEXT_SIZE_KEY) => { for (const handler of listeners.storage ?? []) handler({ key }); },
  };
}

test("only allowlisted text sizes can become an article preference", () => {
  assert.equal(textSizePreference("large"), "large");
  assert.equal(textSizePreference("extra-large"), "extra-large");
  for (const value of ["normal", "small", "20px", "LARGE", "large ", null, undefined, true, 20, [], { size: "large" }, "large\" style=\"font-size:999px"]) {
    assert.equal(textSizePreference(value), "normal");
  }
});

test("the labeled native select changes prose size, persists it, and resets through Normal without moving focus", (t) => {
  const { root, article, size, values, activeElement } = fixture(t);
  installTextSize(entries, "guide");
  const [label, select] = root.children[0].children;
  assert.equal(label.textContent, "Text size");
  assert.equal(label.htmlFor, select.id);
  assert.equal(select.tagName, "select");
  assert.equal(select.attributes["aria-controls"], article.id);
  assert.deepEqual(select.children.map((option) => [option.value, option.textContent]), [["normal", "Normal"], ["large", "Large"], ["extra-large", "Extra large"]]);
  assert.equal(size(), "normal");
  for (const value of ["large", "extra-large", "normal"]) {
    select.value = value;
    select.listeners.change();
    assert.equal(size(), value);
    assert.equal(select.value, value);
    assert.equal(values.get(TEXT_SIZE_KEY), JSON.stringify(value));
  }
  assert.equal(document.activeElement, activeElement);
});

test("saved sizes apply across guide loads with one control and one storage listener per article", (t) => {
  const { root, size, listeners } = fixture(t, "extra-large");
  installTextSize(entries, "guide");
  installTextSize(entries, "guide");
  assert.equal(size(), "extra-large");
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].children[1].value, "extra-large");
  assert.equal(listeners.storage.length, 1);
});

test("cross-tab changes synchronize the selection, ignore unrelated keys, and recover from cleared or malformed storage", (t) => {
  const { root, size, values, storage } = fixture(t, "large");
  installTextSize(entries, "guide");
  const select = root.children[0].children[1];
  values.set(TEXT_SIZE_KEY, '"extra-large"');
  storage("unrelated");
  assert.equal(size(), "large");
  storage();
  assert.equal(size(), "extra-large");
  assert.equal(select.value, "extra-large");
  values.clear();
  storage(null);
  assert.equal(size(), "normal");
  for (const invalid of ["{", '"small"', '"large"'.padEnd(40), '"20px"', '{"size":"large"}', "20", "null"]) {
    select.value = "large";
    select.listeners.change();
    values.set(TEXT_SIZE_KEY, invalid);
    storage();
    assert.equal(size(), "normal");
    assert.equal(select.value, "normal");
  }
});

test("invalid selected values cannot leak into CSS attributes or persistence", (t) => {
  const { root, size, values } = fixture(t, "large");
  installTextSize(entries, "guide");
  const select = root.children[0].children[1];
  select.value = "500px";
  select.listeners.change();
  assert.equal(size(), "normal");
  assert.equal(select.value, "normal");
  assert.equal(values.get(TEXT_SIZE_KEY), '"normal"');
});

test("blocked browser storage leaves every text size usable", (t) => {
  const { root, size, storage } = fixture(t);
  Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => installTextSize(entries, "guide"));
  const select = root.children[0].children[1];
  select.value = "extra-large";
  assert.doesNotThrow(() => select.listeners.change());
  assert.equal(size(), "extra-large");
  select.value = "normal";
  assert.doesNotThrow(() => select.listeners.change());
  assert.equal(size(), "normal");
  assert.doesNotThrow(storage);
});

test("home, search, unknown guides, and missing article elements never install text controls or listeners", async (t) => {
  for (const [slug, configuration] of [[undefined, {}], ["search", {}], ["unknown", {}], ["guide", { articleExists: false }], ["guide", { rootExists: false }]]) {
    await t.test(`${slug ?? "home"} ${JSON.stringify(configuration)}`, (t) => {
      const { root, size, values, listeners } = fixture(t, "extra-large", configuration);
      installTextSize(entries, slug);
      assert.equal(size(), undefined);
      assert.equal(root.children.length, 0);
      assert.deepEqual(listeners, {});
      assert.equal(values.get(TEXT_SIZE_KEY), '"extra-large"');
    });
  }
});
