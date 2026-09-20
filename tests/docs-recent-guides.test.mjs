import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { browserAssetCopies, browserAssetName, browserModulePaths, versionBrowserImports } from "../docs-site/browser-assets.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-recent-"));
for (const name of ["storage", "recent-guides"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { recentGuideSlugs, recordGuideVisit, installRecentGuides, RECENT_GUIDES_KEY } = await import(pathToFileURL(join(directory, "recent-guides.js")));
const { readLocalValue, writeLocalValue, removeLocalValue } = await import(pathToFileURL(join(directory, "storage.js")));
test.after(() => rm(directory, { recursive: true, force: true }));

const allowed = new Set(Array.from({ length: 12 }, (_, index) => `guide-${index}`));

test("recent guides accepts only bounded, unique slugs from the current documentation", () => {
  assert.deepEqual(recentGuideSlugs(null, allowed), []);
  assert.deepEqual(recentGuideSlugs({ "guide-1": true }, allowed), []);
  assert.deepEqual(recentGuideSlugs(["guide-2", "javascript:alert(1)", "guide-2", {}, "removed-guide", "guide-1"], allowed), ["guide-2", "guide-1"]);
  assert.deepEqual(recentGuideSlugs([...allowed], allowed), [...allowed].slice(0, 8));
  assert.deepEqual(recentGuideSlugs([...Array(64).fill(null), "guide-1"], allowed), []);
});

test("visiting a known guide moves it to the front without duplicates", () => {
  assert.deepEqual(recordGuideVisit(["guide-0", "guide-2"], "guide-2", allowed), ["guide-2", "guide-0"]);
  assert.deepEqual(recordGuideVisit(["guide-0"], "not-a-guide", allowed), ["guide-0"]);
  assert.deepEqual(recordGuideVisit(["guide-0"], undefined, allowed), ["guide-0"]);
  assert.equal(recordGuideVisit([...allowed], "guide-11", allowed).length, 8);
});

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = true; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get childElementCount() { return this.children.length; }
}

function browserFixture(t, initial) {
  const root = new Element();
  const values = new Map(initial === undefined ? [] : [[RECENT_GUIDES_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };
  globalThis.document = { getElementById: () => root, createElement: (name) => new Element(name) };
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  return { root, values, listeners };
}

test("recent guides displays navigable trusted metadata, excludes current guide, and clears browser history", (t) => {
  const { root, values, listeners } = browserFixture(t, ["guide-1", "guide-2", "https://evil.invalid/"]);
  const entries = [...allowed].map((slug) => ({ slug, title: slug === "guide-2" ? "<img onerror=alert(1)>" : `Title ${slug}` }));
  installRecentGuides(entries, "guide-1");
  assert.equal(root.hidden, false);
  const [header, links, note, status] = root.children;
  const clear = header.children[1];
  assert.equal(links.children.length, 1);
  assert.equal(links.children[0].href, "/docs/guide-2");
  assert.equal(links.children[0].textContent, "<img onerror=alert(1)>");
  assert.match(note.textContent, /only in this browser/u);
  assert.deepEqual(JSON.parse(values.get(RECENT_GUIDES_KEY)), ["guide-1", "guide-2"]);
  clear.listeners.click();
  assert.equal(values.has(RECENT_GUIDES_KEY), false);
  assert.equal(clear.disabled, true);
  assert.equal(links.children[0].tagName, "p");
  assert.match(status.textContent, /cleared/u);
  values.set(RECENT_GUIDES_KEY, JSON.stringify([...allowed]));
  listeners.storage({ key: RECENT_GUIDES_KEY });
  assert.equal(links.children.length, 6);
  assert.equal(clear.disabled, false);
  values.clear();
  listeners.storage({ key: null });
  assert.equal(clear.disabled, true);
});

test("unavailable, oversized, and malformed local storage does not interrupt reading", (t) => {
  const { values } = browserFixture(t);
  values.set("bad", "{");
  values.set("large", JSON.stringify("x".repeat(8192)));
  assert.equal(readLocalValue("bad"), undefined);
  assert.equal(readLocalValue("large"), undefined);
  Object.defineProperty(globalThis.window, "localStorage", { get() { throw new Error("Storage blocked"); } });
  assert.equal(readLocalValue(RECENT_GUIDES_KEY), undefined);
  assert.doesNotThrow(() => writeLocalValue(RECENT_GUIDES_KEY, ["guide-0"]));
  assert.doesNotThrow(() => removeLocalValue(RECENT_GUIDES_KEY));
  assert.doesNotThrow(() => installRecentGuides([{ slug: "guide-0", title: "Guide" }], "guide-0"));
});

test("documentation browser assets include nested imports and exclude server-only modules", () => {
  const sources = new Map([
    ["app.js", 'import { search } from "./search.js"; import("./enhancements/recent-guides.js");'],
    ["search.js", 'import { signal } from "../vendor/core.js";'],
    ["enhancements/recent-guides.js", 'import { read } from "./storage.js";'],
    ["enhancements/storage.js", "export const read = () => [];"],
    ["server.js", 'import { readFile } from "node:fs/promises";'],
  ]);
  assert.deepEqual(browserModulePaths(sources), ["app.js", "enhancements/recent-guides.js", "enhancements/storage.js", "search.js"]);
  const version = "0123456789abcdef";
  assert.equal(browserAssetName("app.js", version), `app.${version}.js`);
  assert.equal(browserAssetName("enhancements/storage.js", version), `${version}/enhancements/storage.js`);
  assert.equal(versionBrowserImports(sources.get("app.js"), "app.js", version), `import { search } from "/assets/search.${version}.js"; import("/assets/${version}/enhancements/recent-guides.js");`);
  assert.equal(versionBrowserImports(sources.get("search.js"), "search.js", version), `import { signal } from "/vendor/${version}/core.js";`);
  assert.equal(versionBrowserImports('import { read } from "./storage.js";', "enhancements/recent-guides.js", version), `import { read } from "/assets/${version}/enhancements/storage.js";`);
  assert.throws(() => browserModulePaths(new Map([["app.js", 'import "./missing.js";']])), /Missing documentation browser module/u);
  assert.throws(() => browserModulePaths(new Map([["app.js", 'import "../../private.js";']])), /escapes/u);
});


test("browser asset emission preserves server-importable shared modules", async () => {
  const version = "0123456789abcdef";
  const output = join(directory, "fixture", "dist");
  const sources = new Map([
    ["app.js", 'import { SearchBox } from "./search.js"; import { hydrate } from "../vendor/dom.js";'],
    ["search.js", 'import { signal } from "../vendor/core.js"; export function SearchBox() { return signal("server ready"); }'],
    ["server.js", 'import { SearchBox } from "./search.js"; export default SearchBox();'],
  ]);
  await mkdir(output, { recursive: true });
  await mkdir(join(directory, "fixture", "vendor"), { recursive: true });
  await writeFile(join(directory, "fixture", "vendor", "core.js"), 'export const signal = value => ({ value });');
  for (const [filename, source] of sources) await writeFile(join(output, filename), source);
  for (const copy of browserAssetCopies(sources, version)) {
    const target = join(output, copy.filename);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, copy.source);
    assert.ok(copy.filename.startsWith("browser/"));
  }
  const server = await import(pathToFileURL(join(output, "server.js")));
  assert.deepEqual(server.default, { value: "server ready" });
  assert.equal(await readFile(join(output, "search.js"), "utf8"), sources.get("search.js"));
  const appCopy = await readFile(join(output, "browser/app.js"), "utf8");
  const searchCopy = await readFile(join(output, "browser/search.js"), "utf8");
  assert.match(appCopy, new RegExp(`/vendor/${version}/dom\\.js`, "u"));
  assert.match(searchCopy, new RegExp(`/vendor/${version}/core\\.js`, "u"));
  assert.equal(browserAssetCopies(sources, version).some((copy) => copy.filename.includes("server.js")), false);
});
