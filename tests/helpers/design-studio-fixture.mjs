import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../scripts/compiler.mjs";
export { h, render, signal } from "../../dist/dom.js";
export { renderToString } from "../../dist/ssr.js";
export { UI_COMPONENT_CATALOG, CLANK_THEME_PRESETS } from "../../dist/ui.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-studio-improvements-"));
test.after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../../dist/", import.meta.url).href;
for (const filename of ["studio.tsx", "stories.tsx", ...(await readdir(new URL("../../design-site/src/tools/", import.meta.url))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(new URL(`../../design-site/src/${filename}`, import.meta.url), "utf8")).replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const target = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compile(source, { filename, sourceMap: false }));
}
export const load = (name) => import(pathToFileURL(join(temporary, `${name}.js`)).href);
export const { DesignStudio } = await load("studio");
// Reuse the established real-renderer fixture without registering its tests.
const fixture = await readFile(new URL("../design-specimen-reset.test.mjs", import.meta.url), "utf8");
const start = fixture.indexOf("class EventTarget {");
const end = fixture.indexOf("function specimen(");
assert.ok(start >= 0 && end > start);
const shared = new Function("assert", `${fixture.slice(start, end)}\nreturn { browser, descendants, Element };`)(assert);
export const descendants = shared.descendants;
const closest = shared.Element.prototype.closest;
shared.Element.prototype.closest = function (selector) {
  if (selector === "pre[tabindex]" && this.tagName === "PRE" && this.hasAttribute("tabindex")) return this;
  return closest.call(this, selector);
};
export function browser(t, { url = "https://design.example/components/input?theme=midnight&width=523&grid=1&outlines=1&panel=code", stored = new Map() } = {}) {
  const f = shared.browser(t);
  f.view.location = new URL(url);
  const history = [];
  f.view.history.pushState = (_state, _title, path) => { history.push(path); f.view.location = new URL(path, f.view.location); };
  f.view.scrollTo = () => {};
  f.view.matchMedia = () => ({ matches: false });
  const localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  t.after(() => prior ? Object.defineProperty(globalThis, "localStorage", prior) : delete globalThis.localStorage);
  const selection = { node: null, removeAllRanges() { this.node = null; }, addRange(range) { this.node = range.node; } };
  f.document.getSelection = () => selection;
  f.document.createRange = () => ({ node: null, selectNodeContents(node) { this.node = node; } });
  return { ...f, history, stored, localStorage, selection };
}
export function setClipboard(t, clipboard) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard } });
  t.after(() => prior ? Object.defineProperty(globalThis, "navigator", prior) : delete globalThis.navigator);
}
export const elements = (root) => descendants(root).filter((node) => node.nodeType === 1);
export function button(root, label) {
  const result = elements(root).find((node) => node.tagName === "BUTTON" && node.textContent === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
export const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
