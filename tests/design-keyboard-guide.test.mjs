import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { createRoot } from "../dist/core.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";
import { UI_COMPONENT_CATALOG, createCheckbox, createSwitch } from "../dist/ui.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-keyboard-guide-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
const sourceRoot = fileURLToPath(new URL("../design-site/src/", import.meta.url));
for (const filename of ["studio.tsx", "stories.tsx", ...(await readdir(join(sourceRoot, "tools"))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(join(sourceRoot, filename), "utf8")).replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const target = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compile(source, { filename, sourceMap: false }));
}
const { getKeyboardGuide, readControllerKeyboard } = await import(pathToFileURL(join(temporary, "tools/keyboard-guide-data.js")).href);
const { KeyboardGuide } = await import(pathToFileURL(join(temporary, "tools/keyboard-guide.js")).href);
const { DesignStudio } = await import(pathToFileURL(join(temporary, "studio.js")).href);

const row = (slug, key) => getKeyboardGuide(slug).rows.find((entry) => entry.key === key);
const markup = (view) => renderToString(view, { markers: false });

test("all 39 catalog entries have complete detached guidance; noninteractive families invent no keys", () => {
  assert.equal(UI_COMPONENT_CATALOG.length, 39);
  for (const entry of UI_COMPONENT_CATALOG) {
    const guide = getKeyboardGuide(entry.slug);
    assert.equal(guide.slug, entry.slug);
    assert.ok(guide.note.length > 35, entry.name);
    assert.ok(Object.isFrozen(guide));
    assert.ok(Object.isFrozen(guide.rows));
    assert.equal(new Set(guide.rows.map((entry) => entry.key)).size, guide.rows.length);
    assert.doesNotThrow(() => JSON.stringify(guide));
    assert.ok(guide.rows.every((entry) => entry.key && entry.action && Object.isFrozen(entry)));
    const contract = readControllerKeyboard(entry);
    for (const [key, action] of Object.entries(contract)) {
      if (key === "Tab" && ["preview-card", "tooltip"].includes(entry.slug)) continue;
      assert.equal(row(entry.slug, key)?.action, action, `${entry.name}: ${key} stays aligned with its controller`);
    }
  }
  for (const slug of ["avatar", "meter", "progress", "separator"]) {
    assert.equal(getKeyboardGuide(slug).source, "noninteractive");
    assert.deepEqual(getKeyboardGuide(slug).rows, []);
    assert.match(getKeyboardGuide(slug).note, /No keyboard interaction/u);
  }
  for (const slug of ["missing", "__proto__", "toString", "<script>"]) assert.equal(getKeyboardGuide(slug), undefined);
});

test("representative contracts state exact keys and distinguish preview configuration", () => {
  assert.deepEqual(getKeyboardGuide("accordion").rows.map(({ key }) => key), ["Tab", "Enter", "Space"]);
  assert.equal(row("context-menu", "Shift+F10").action, "Open the context menu from its keyboard target");
  assert.equal(row("context-menu", "ContextMenu").action, "Open the context menu from its keyboard target");
  assert.match(row("menu", "ArrowRight").when, /no submenus/u);
  assert.equal(row("tabs", "ArrowRight").action, "Move focus horizontally, respecting text direction");
  assert.match(row("tabs", "ArrowDown").when, /Vertical orientation only/u);
  assert.match(row("tabs", "Enter").when, /Manual activation only/u);
  assert.match(row("popover", "Tab").when, /non-modal preview uses normal document Tab order/u);
  for (const slug of ["preview-card", "tooltip"]) {
    assert.equal(row(slug, "Tab"), undefined);
    assert.match(getKeyboardGuide(slug).note, /never trap/u);
    assert.equal(row(slug, "Escape").action, "Close the topmost layer");
  }
  assert.equal(row("number-field", "ArrowUp").action, "Increment by step; Alt uses smallStep and Shift uses largeStep.");
  assert.match(row("number-field", "Home").when, /Requires min; this preview uses 1/u);
  assert.match(row("number-field", "End").when, /Requires max; this preview uses 24/u);
  assert.equal(row("otp-field", "Backspace").action, "Clear the current slot, or the previous slot when empty.");
  assert.equal(row("toast", "F6").action, "Move focus to the newest visible notification.");
  assert.match(row("toast", "F6").when, /visible toast/u);
  assert.equal(row("slider", "PageUp").action, "Increase by largeStep.");
  for (const slug of ["menu", "menubar", "context-menu"]) assert.ok(!getKeyboardGuide(slug).rows.some(({ key }) => /⌘|Control|Ctrl/u.test(key)));
});

test("fallback guidance distinguishes checkbox Space-only behavior from switch Enter and Space", () => {
  for (const [slug, factory] of [["checkbox", createCheckbox], ["switch", createSwitch]]) {
    createRoot((dispose) => {
      try {
        const controller = factory({ id: `guide-test-${slug}` });
        const target = { localName: "div" };
        const press = (key) => controller.root().onKeyDown({ key, currentTarget: target, defaultPrevented: false, preventDefault() {} });
        press("Enter");
        assert.equal(controller.checked.peek(), slug === "switch");
        press(" ");
        assert.equal(controller.checked.peek(), slug === "checkbox");
        assert.ok(row(slug, slug === "checkbox" ? "Space" : "Enter / Space"));
        assert.equal(getKeyboardGuide(slug).rows.some(({ key }) => key.includes("Enter")), slug === "switch");
      } finally { dispose(); }
    });
  }
});

test("reading every controller contract leaves no browser listeners or timers alive", (t) => {
  const activeTimers = new Set();
  let nextTimer = 0;
  for (const [schedule, cancel] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
    t.mock.method(globalThis, schedule, () => { const handle = ++nextTimer; activeTimers.add(handle); return handle; });
    t.mock.method(globalThis, cancel, (handle) => { activeTimers.delete(handle); });
  }
  class ObservedTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, listener, options) { const entries = this.listeners.get(type) ?? new Set(); entries.add(listener); this.listeners.set(type, entries); super.addEventListener(type, listener, options); }
    removeEventListener(type, listener, options) { this.listeners.get(type)?.delete(listener); super.removeEventListener(type, listener, options); }
  }
  const document = new ObservedTarget();
  const window = new ObservedTarget();
  document.defaultView = window;
  document.getElementById = () => null;
  window.document = document;
  for (const [name, value] of [["document", document], ["window", window]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const entry of UI_COMPONENT_CATALOG) {
      assert.doesNotThrow(() => readControllerKeyboard(entry), entry.name);
      assert.equal(activeTimers.size, 0, `${entry.name} retained a timer`);
      for (const target of [document, window]) assert.equal([...target.listeners.values()].reduce((count, entries) => count + entries.size, 0), 0, `${entry.name} retained a global listener`);
    }
  }
});

test("every direct component SSR page includes a named keyboard section and accessible preview controls", async () => {
  for (const entry of UI_COMPONENT_CATALOG) {
    const html = await markup(h(DesignStudio, { initialView: entry.slug, initialTheme: "clank", frameworkVersion: "test" }));
    assert.match(html, new RegExp(`<section[^>]*aria-labelledby="keyboard-guide-${entry.slug}"`, "u"));
    assert.match(html, new RegExp(`<h2 id="keyboard-guide-${entry.slug}">Keyboard guidance</h2>`, "u"));
    assert.match(html, /<div(?=[^>]*role="group")(?=[^>]*aria-label="Preview controls")(?=[^>]*class="preview-toolbar")[^>]*>/u);
    assert.equal((html.match(/>Keyboard guidance<\/h2>/gu) ?? []).length, 1);
    const guideHtml = await markup(h(KeyboardGuide, { slug: entry.slug }));
    assert.equal((guideHtml.match(/<dt>/gu) ?? []).length, getKeyboardGuide(entry.slug).rows.length);
    assert.equal((guideHtml.match(/<dd>/gu) ?? []).length, getKeyboardGuide(entry.slug).rows.length);
    assert.doesNotMatch(guideHtml, /tabindex=|onclick=/iu);
  }
  assert.equal(await markup(h(KeyboardGuide, { slug: "missing" })), "");
});

test("keyboard modules are served by the explicit browser asset allowlist", async () => {
  const server = await readFile(join(sourceRoot, "server.tsx"), "utf8");
  for (const file of ["keyboard-guide.js", "keyboard-guide-data.js"]) assert.ok(server.includes(`["tools/${file}", "tools/${file}"]`), file);
});
