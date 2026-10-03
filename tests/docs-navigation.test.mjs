import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-navigation-"));
const source = await readFile(new URL("../docs-site/src/enhancements/navigation.ts", import.meta.url), "utf8");
await writeFile(join(directory, "navigation.mjs"), compile(source, { filename: "navigation.ts", sourceMap: false }));
const { installNavigation } = await import(pathToFileURL(join(directory, "navigation.mjs")));
test.after(() => rm(directory, { recursive: true, force: true }));

class Element {
  constructor(tag = "div") { this.tag = tag; this.attributes = {}; this.listeners = {}; this.inert = false; this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { document.activeElement = this; }
  contains(element) { return this === element || this.children.includes(element); }
  querySelectorAll() { return this.children; }
  querySelector() { return this.children.find((element) => element.attributes["aria-current"] === "page") ?? null; }
  getClientRects() { return this.visible === false ? [] : [{}]; }
  closest(selector) {
    if (selector === "a") return this.tag === "a" ? this : null;
    if (selector === "[hidden]") return this.hidden ? this : null;
    if (selector === "details:not([open])") return this.inClosedDetails ? this : null;
    return null;
  }
  matches() { return this.tag === "summary"; }
}

function fixture(t, mobile = true) {
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element };
  const body = new Element();
  const toggle = new Element("button");
  const dismiss = new Element("button");
  const scrim = new Element("button");
  const sidebar = new Element("aside");
  const current = new Element("a");
  current.setAttribute("aria-current", "page");
  const summary = new Element("summary");
  summary.inClosedDetails = true;
  const last = new Element("a");
  const collapsedLink = new Element("a");
  collapsedLink.inClosedDetails = true;
  sidebar.children = [dismiss, current, summary, last, collapsedLink];
  const background = [new Element("header"), new Element("main"), new Element("footer")];
  background[2].inert = true;
  const media = { matches: mobile, addEventListener(name, handler) { this.change = handler; } };
  const listeners = {};
  globalThis.Element = Element;
  globalThis.window = { matchMedia: () => media };
  globalThis.document = {
    body, activeElement: body,
    getElementById: (id) => ({ "nav-toggle": toggle, "nav-close": dismiss, "nav-scrim": scrim, "docs-sidebar": sidebar })[id],
    querySelectorAll: () => background,
    addEventListener(name, handler) { listeners[name] = handler; },
  };
  t.after(() => Object.assign(globalThis, previous));
  const controller = installNavigation();
  const key = (key, shiftKey = false) => {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    listeners.keydown(event);
    return event;
  };
  return { ...controller, body, toggle, dismiss, scrim, sidebar, background, media, current, summary, last, key };
}

test("mobile docs drawer isolates content and Escape restores the previous inert state and trigger focus", (t) => {
  const f = fixture(t);
  f.toggle.listeners.click();
  assert.equal(f.isOpen(), true);
  assert.equal(f.sidebar.attributes.role, "dialog");
  assert.equal(f.sidebar.attributes["aria-modal"], "true");
  assert.equal(f.toggle.attributes["aria-expanded"], "true");
  assert.equal(document.activeElement, f.dismiss);
  assert.ok(f.background.every((element) => element.inert));
  assert.ok(Object.hasOwn(f.body.attributes, "data-nav-open"));
  assert.equal(f.key("Escape").defaultPrevented, true);
  assert.equal(f.isOpen(), false);
  assert.equal(document.activeElement, f.toggle);
  assert.deepEqual(f.background.map((element) => element.inert), [false, false, true]);
  assert.equal(f.sidebar.attributes.role, undefined);
  assert.equal(f.scrim.hidden, true);
  assert.equal(Object.hasOwn(f.body.attributes, "data-nav-open"), false);
});

test("drawer Tab wraps visible controls and skips links inside a collapsed library", (t) => {
  const f = fixture(t);
  f.toggle.listeners.click();
  assert.equal(f.key("Tab", true).defaultPrevented, true);
  assert.equal(document.activeElement, f.last);
  assert.equal(f.key("Tab").defaultPrevented, true);
  assert.equal(document.activeElement, f.dismiss);
  f.current.focus();
  assert.equal(f.key("Tab").defaultPrevented, false);
  f.background[0].focus();
  f.key("Tab");
  assert.equal(document.activeElement, f.dismiss);
});

test("drawer close, backdrop, guide navigation and desktop resize all release the modal", (t) => {
  const f = fixture(t);
  for (const trigger of [() => f.dismiss.listeners.click(), () => f.scrim.listeners.click()]) {
    f.toggle.listeners.click();
    trigger();
    assert.equal(f.isOpen(), false);
    assert.equal(document.activeElement, f.toggle);
  }
  f.toggle.listeners.click();
  f.current.focus();
  f.sidebar.listeners.click({ target: f.current });
  assert.equal(f.isOpen(), false);
  assert.equal(document.activeElement, f.current, "Following a guide does not steal focus back to the trigger");
  f.toggle.listeners.click();
  f.media.matches = false;
  f.media.change();
  assert.equal(f.isOpen(), false);
  assert.equal(document.activeElement, f.current, "Resize does not leave focus on the hidden mobile close control");
  assert.deepEqual(f.background.map((element) => element.inert), [false, false, true]);
  f.toggle.listeners.click();
  assert.equal(f.isOpen(), false, "Desktop navigation stays a nonmodal landmark");
});
