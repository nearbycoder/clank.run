import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-bookmarks-"));
for (const name of ["storage", "bookmarks"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { BOOKMARKS_KEY, BOOKMARK_LIMIT, bookmarkSlugs, toggleBookmark, installBookmarks } = await import(pathToFileURL(join(directory, "bookmarks.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const allowed = new Set(Array.from({ length: 36 }, (_, index) => `guide-${index}`));
const entries = [...allowed].map((slug) => ({ slug, title: slug === "guide-2" ? "<img onerror=alert(1)>" : `Title ${slug}` }));

test("bookmarks accept only bounded, unique slugs from the current corpus", () => {
  assert.deepEqual(bookmarkSlugs(null, allowed), []);
  assert.deepEqual(bookmarkSlugs({ slug: "guide-1" }, allowed), []);
  assert.deepEqual(bookmarkSlugs(["guide-2", "javascript:alert(1)", "guide-2", {}, "missing-guide", "guide-1"], allowed), ["guide-2", "guide-1"]);
  assert.deepEqual(bookmarkSlugs([...allowed], allowed), [...allowed].slice(0, BOOKMARK_LIMIT));
  assert.deepEqual(bookmarkSlugs([...Array(128).fill(null), "guide-1"], allowed), []);
});

test("saving is newest first, toggling removes, and capacity never silently drops an existing bookmark", () => {
  assert.deepEqual(toggleBookmark(["guide-0", "guide-2"], "guide-2", allowed), ["guide-0"]);
  assert.deepEqual(toggleBookmark(["guide-0"], "guide-1", allowed), ["guide-1", "guide-0"]);
  assert.deepEqual(toggleBookmark(["guide-0"], "missing-guide", allowed), ["guide-0"]);
  const full = [...allowed].slice(0, BOOKMARK_LIMIT);
  assert.deepEqual(toggleBookmark(full, "guide-35", allowed), full);
  assert.deepEqual(toggleBookmark(full, "guide-0", allowed), full.slice(1));
});

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = true; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { globalThis.document.activeElement = this; }
}
function browserFixture(t, initial, article = true) {
  const root = new Element();
  const save = article ? new Element("button") : null;
  const status = article ? new Element("span") : null;
  const values = new Map(initial === undefined ? [] : [[BOOKMARKS_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };
  globalThis.document = { getElementById: (id) => ({ "docs-bookmarks": root, "docs-bookmark-toggle": save, "docs-bookmark-status": status })[id] ?? null, createElement: (name) => new Element(name) };
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  return { root, save, status, values, listeners };
}

test("article saving, unsaving, sidebar removal and clear all update persistent and accessible state", (t) => {
  const { root, save, status, values } = browserFixture(t, ["guide-1", "guide-2", "https://evil.invalid/"]);
  installBookmarks(entries, "guide-0");
  assert.equal(root.hidden, false);
  assert.equal(save.hidden, false);
  assert.equal(save.attributes["aria-pressed"], "false");
  const [header, list, note] = root.children;
  assert.equal(list.children.length, 2);
  assert.equal(list.children[1].children[0].textContent, "<img onerror=alert(1)>");
  assert.equal(list.children[1].children[0].href, "/docs/guide-2");
  assert.equal(list.children[1].children[1].attributes["aria-label"], "Remove <img onerror=alert(1)> from saved guides");
  assert.match(note.textContent, /only in this browser/u);
  save.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), ["guide-0", "guide-1", "guide-2"]);
  assert.equal(save.attributes["aria-pressed"], "true");
  assert.equal(save.textContent, "Unsave guide");
  assert.equal(list.children[0].children[0].attributes["aria-current"], "page");
  save.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), ["guide-1", "guide-2"]);
  assert.equal(save.attributes["aria-pressed"], "false");
  const remove = list.children[0].children[1];
  remove.focus();
  remove.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), ["guide-2"]);
  assert.equal(globalThis.document.activeElement, list.children[0].children[1]);
  assert.match(status.textContent, /removed/u);
  header.children[1].listeners.click();
  assert.equal(values.has(BOOKMARKS_KEY), false);
  assert.equal(header.children[1].disabled, true);
  assert.equal(list.children[0].tagName, "p");
  assert.match(status.textContent, /cleared/u);
});

test("full bookmarks report capacity and remain removable before adding another guide", (t) => {
  const full = [...allowed].slice(0, BOOKMARK_LIMIT);
  const { root, save, status, values } = browserFixture(t, full);
  installBookmarks(entries, "guide-35");
  save.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), full);
  assert.equal(save.attributes["aria-pressed"], "false");
  assert.match(status.textContent, /Remove a saved guide/u);
  root.children[1].children[0].children[1].listeners.click();
  save.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), ["guide-35", ...full.slice(1)]);
  assert.equal(save.attributes["aria-pressed"], "true");
});

test("storage events refresh the saved list and article state without accepting unknown destinations", (t) => {
  const { root, save, values, listeners } = browserFixture(t);
  installBookmarks(entries, "guide-0");
  values.set(BOOKMARKS_KEY, JSON.stringify(["guide-0", "bad-url", "guide-3"]));
  listeners.storage({ key: "some-other-key" });
  assert.equal(save.attributes["aria-pressed"], "false");
  listeners.storage({ key: BOOKMARKS_KEY });
  assert.equal(save.attributes["aria-pressed"], "true");
  assert.equal(root.children[1].children.length, 2);
  values.clear();
  listeners.storage({ key: null });
  assert.equal(save.attributes["aria-pressed"], "false");
  assert.equal(root.children[0].children[1].disabled, true);
});

test("blocked and malformed storage still allow saving, removing and clearing in the current page", (t) => {
  const { root, save, values } = browserFixture(t);
  values.set(BOOKMARKS_KEY, "{");
  Object.defineProperty(globalThis.window, "localStorage", { get() { throw new Error("Storage blocked"); } });
  assert.doesNotThrow(() => installBookmarks(entries, "guide-0"));
  save.listeners.click();
  assert.equal(save.attributes["aria-pressed"], "true");
  assert.equal(root.children[1].children[0].children[0].href, "/docs/guide-0");
  root.children[0].children[1].listeners.click();
  assert.equal(save.attributes["aria-pressed"], "false");
});

test("malformed or oversized saved values recover to an empty usable bookmark list", (t) => {
  const { root, save, values } = browserFixture(t);
  values.set(BOOKMARKS_KEY, "{");
  installBookmarks(entries, "guide-0");
  assert.equal(root.children[0].children[1].disabled, true);
  save.listeners.click();
  assert.deepEqual(JSON.parse(values.get(BOOKMARKS_KEY)), ["guide-0"]);
  values.set(BOOKMARKS_KEY, JSON.stringify(["x".repeat(8192)]));
  installBookmarks(entries, "guide-0");
  assert.equal(save.attributes["aria-pressed"], "false");
  assert.equal(root.children[0].children[1].disabled, true);
});

test("home-page bookmarks work without an article button and preserve focus after the final removal", (t) => {
  const { root, values } = browserFixture(t, ["guide-0"], false);
  installBookmarks(entries);
  const remove = root.children[1].children[0].children[1];
  remove.focus();
  remove.listeners.click();
  assert.equal(globalThis.document.activeElement, root.children[0].children[0]);
  assert.equal(values.has(BOOKMARKS_KEY), false);
  assert.match(root.children[3].textContent, /removed/u);
});
