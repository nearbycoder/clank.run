import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { h, hydrate, onCleanup, Portal, render } from "../dist/dom.js";
import { createToastProvider } from "../dist/ui-utilities.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-specimen-reset-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["studio.tsx", "stories.tsx", ...(await readdir(new URL("../design-site/src/tools/", import.meta.url))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(new URL(`../design-site/src/${filename}`, import.meta.url), "utf8"))
    .replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const output = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, compile(source, { filename, sourceMap: false }));
}
const { createSpecimenReset } = await import(pathToFileURL(join(temporary, "tools/specimen-reset.js")).href);
const { ComponentStory } = await import(pathToFileURL(join(temporary, "stories.js")).href);
const { DesignStudio } = await import(pathToFileURL(join(temporary, "studio.js")).href);

// Small browser surface for the real DOM renderer and UI controllers, without third-party DOM code.
class EventTarget {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
  emit(name, details = {}) {
    const event = { target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...details };
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(event);
  }
}
class Node extends EventTarget {
  constructor(document, type) { super(); this.ownerDocument = document; this.nodeType = type; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return this === this.ownerDocument?.documentElement || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  getRootNode() { return this.ownerDocument; }
  contains(node) { return this === node || this.childNodes.some((child) => child.contains(node)); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    assert.ok(index >= 0, "insertion reference belongs to its parent");
    this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  removeChild(node) {
    const index = this.childNodes.indexOf(node); assert.ok(index >= 0);
    this.childNodes.splice(index, 1); node.parentNode = null; return node;
  }
}
class Text extends Node {
  constructor(document, data) { super(document, 3); this.data = String(data); }
  get textContent() { return this.data; }
}
class Comment extends Node {
  constructor(document, data) { super(document, 8); this.data = data; }
  get textContent() { return ""; }
}
class Element extends Node {
  constructor(document, tag, namespace = "http://www.w3.org/1999/xhtml") {
    super(document, 1); this.localName = tag; this.tagName = tag.toUpperCase(); this.namespaceURI = namespace;
    this.attributes = new Map(); this.dataset = {}; this.value = ""; this.hidden = false; this.disabled = false; this.tabIndex = -1;
    this.style = { overflow: "", paddingRight: "", setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] ?? ""; } };
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get id() { return this.getAttribute("id") ?? ""; }
  set id(value) { this.setAttribute("id", value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) {
    if (selector === "[inert]" && this.hasAttribute("inert") || selector === "[hidden]" && this.hasAttribute("hidden")) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  matches(selector) { return selector === ":disabled" ? this.disabled : /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/u.test(this.tagName); }
  querySelectorAll() { return []; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40 }; }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
}
function browser(t) {
  const document = new EventTarget(), view = new EventTarget();
  const disposers = [], restorations = [];
  t.after(() => {
    try { for (const dispose of disposers.reverse()) dispose(); }
    finally { for (const restore of restorations.reverse()) restore(); }
  });
  const frames = new Map(); let frameId = 0;
  Object.assign(view, { HTMLElement: Element, Element, Node, Text, Comment, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    requestAnimationFrame(callback) {
      const id = ++frameId; frames.set(id, callback);
      queueMicrotask(() => { const pending = frames.get(id); frames.delete(id); pending?.(); });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  Object.assign(document, { nodeType: 9, defaultView: view, activeElement: null,
    createElement: (tag) => new Element(document, tag),
    createElementNS: (namespace, tag) => new Element(document, tag, namespace),
    createTextNode: (text) => new Text(document, text), createComment: (text) => new Comment(document, text),
  });
  document.documentElement = document.createElement("html"); document.documentElement.clientWidth = 800;
  document.body = document.createElement("body"); document.documentElement.append(document.body);
  document.getElementById = (id) => descendants(document.body).find((node) => node.id === id) ?? null;
  document.querySelector = () => null;
  const url = "https://design.example/components/input?theme=midnight&width=523&grid=1&outlines=1&panel=code";
  Object.assign(view, { document, location: new URL(url), history: { pushState() { throw new Error("reset must not write history"); }, replaceState() { throw new Error("reset must not write history"); } } });
  for (const [name, value] of Object.entries({ document, window: view, Node, Element, HTMLElement: Element, Text, Comment })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restorations.push(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  return { document, view, url, onDispose: (dispose) => disposers.push(dispose) };
}
function descendants(node) { return node.childNodes.flatMap((child) => [child, ...descendants(child)]); }
function byId(document, id) { const value = document.getElementById(id); assert.ok(value, `missing #${id}`); return value; }
function specimen(t, story) {
  const context = browser(t), { document } = context;
  const root = document.createElement("main"); document.body.append(root);
  const unrelated = document.createElement("aside"); unrelated.setAttribute("id", "unrelated-portal"); document.body.append(unrelated);
  let controls;
  const dispose = render(root, h(() => {
    controls = createSpecimenReset(story);
    return h("section", { "data-theme": "midnight", "data-width": "523", "data-grid": "", "data-outlines": "", "data-panel": "code" },
      h("input", { id: "sidebar-query", value: "existing search" }),
      h("p", { id: "share-status" }, "Preview link copied."),
      h("button", { type: "button", id: "reset", onClick: controls.reset }, "Reset specimen"),
      h("div", { id: "story-root" }, controls.render));
  }));
  context.onDispose(dispose);
  return { ...context, root, unrelated, controls, dispose, reset: byId(document, "reset") };
}

test("reset restores the actual input story while preserving shell, settings, share status, URL and button focus", async (t) => {
  const { document, view, url, root, reset } = specimen(t, () => h(ComponentStory, { slug: "input" }));
  const shell = root.children[0], sidebar = byId(document, "sidebar-query"), status = byId(document, "share-status");
  const original = byId(document, "story-input");
  assert.equal(original.value, "Clank Design Studio");
  original.value = "Edited specimen"; original.emit("input");
  assert.equal(original.value, "Edited specimen");
  reset.emit("click");
  const replacement = byId(document, "story-input");
  assert.notEqual(replacement, original);
  assert.equal(replacement.value, "Clank Design Studio");
  assert.equal(original.isConnected, false); assert.equal(original.listenerCount(), 0);
  assert.equal(root.children[0], shell); assert.equal(byId(document, "sidebar-query"), sidebar); assert.equal(byId(document, "share-status"), status);
  assert.equal(sidebar.value, "existing search"); assert.equal(status.textContent, "Preview link copied.");
  assert.deepEqual([...shell.attributes], [["data-theme", "midnight"], ["data-width", "523"], ["data-grid", ""], ["data-outlines", ""], ["data-panel", "code"]]);
  assert.equal(view.location.href, url); assert.equal(byId(document, "reset"), reset);
  await Promise.resolve(); assert.equal(document.activeElement, reset); assert.deepEqual(reset.focusOptions, { preventScroll: true });
});

for (const slug of ["dialog", "menu"]) test(`reset disposes the actual open ${slug} story and its portal and global handlers`, async (t) => {
  const { document, view, unrelated, reset } = specimen(t, () => h(ComponentStory, { slug }));
  const trigger = descendants(byId(document, "story-root")).find((node) => node.tagName === "BUTTON");
  trigger.focus(); trigger.emit("click");
  await Promise.resolve();
  const popup = descendants(document.body).find((node) => node.getAttribute?.("role") === slug);
  assert.ok(popup, "a real controller opens its portal");
  assert.ok(document.listenerCount() > 0, "open overlay installs document handlers");
  reset.emit("click");
  assert.equal(popup.isConnected, false); assert.equal(trigger.listenerCount(), 0);
  assert.equal(document.listenerCount(), 0); assert.equal(view.listenerCount(), 0);
  assert.equal(document.body.style.overflow, ""); assert.equal(unrelated.hasAttribute("inert"), false); assert.equal(unrelated.isConnected, true);
  assert.equal(descendants(document.body).filter((node) => node.getAttribute?.("role") === slug).length, 0);
  await Promise.resolve(); assert.equal(document.activeElement, reset, "queued overlay focus restoration cannot take focus from reset");
  const nextTrigger = descendants(byId(document, "story-root")).find((node) => node.tagName === "BUTTON");
  assert.notEqual(nextTrigger, trigger); assert.equal(nextTrigger.getAttribute("aria-expanded"), "false");
});

test("reset removes actual toast notifications and clears their duration timer before the new story mounts", async (t) => {
  const timers = new Set(), set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, duration) => { const timer = { callback, duration }; timers.add(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timers.delete(timer); };
  t.after(() => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  const lifecycle = [];
  function Story() {
    lifecycle.push(["mount", timers.size]);
    onCleanup(() => lifecycle.push(["dispose", timers.size]));
    return h(ComponentStory, { slug: "toast" });
  }
  const { document, unrelated, reset } = specimen(t, () => h(Story));
  const trigger = descendants(byId(document, "story-root")).find((node) => node.tagName === "BUTTON");
  trigger.emit("click"); await Promise.resolve();
  const toast = descendants(document.body).find((node) => node.getAttribute?.("role") === "status");
  assert.ok(toast); assert.equal(timers.size, 1); assert.match(toast.textContent, /Deployment complete/u);
  const portal = byId(document, "story-toast-portal");
  reset.emit("click");
  assert.equal(timers.size, 0); assert.equal(toast.isConnected, false); assert.equal(portal.isConnected, false);
  assert.equal(trigger.listenerCount(), 0); assert.equal(unrelated.isConnected, true);
  assert.deepEqual(lifecycle, [["mount", 0], ["dispose", 0], ["mount", 0]], "controller and timers are disposed before replacement creation");
  assert.equal(descendants(document.body).filter((node) => node.getAttribute?.("role") === "status").length, 0);
  assert.notEqual(byId(document, "story-toast-portal"), portal);
});

test("reset releases real toast-provider document handlers and pending focus cannot run after owner disposal", async (t) => {
  const providers = [];
  function Story() {
    const provider = createToastProvider({ id: "test-toast" }); providers.push(provider);
    onCleanup(() => provider.dispose());
    return h("div", provider.provider(), h(Portal, {}, h("div", provider.viewport())));
  }
  const { document, view, root, reset, dispose, controls } = specimen(t, () => h(Story));
  const oldDocumentHandlers = [...document.listeners.values()].flatMap((handlers) => [...handlers]);
  const oldViewHandlers = [...view.listeners.values()].flatMap((handlers) => [...handlers]);
  assert.equal(oldDocumentHandlers.length, 2); assert.equal(oldViewHandlers.length, 2);
  reset.emit("click");
  assert.equal(providers.length, 2);
  for (const callback of oldDocumentHandlers) assert.ok([...document.listeners.values()].every((handlers) => !handlers.has(callback)));
  for (const callback of oldViewHandlers) assert.ok([...view.listeners.values()].every((handlers) => !handlers.has(callback)));
  assert.equal(document.listenerCount(), 2); assert.equal(view.listenerCount(), 2);
  dispose(); document.activeElement = document.body;
  controls.reset({ currentTarget: reset });
  await Promise.resolve();
  assert.equal(document.activeElement, document.body); assert.equal(root.childNodes.length, 0);
  assert.equal(providers.length, 2); assert.equal(document.listenerCount(), 0); assert.equal(view.listenerCount(), 0);
});

test("the integrated Studio resets only its story and keeps the real preview settings, inspector, sidebar and share URL", async (t) => {
  const { document, view, url, onDispose } = browser(t);
  const root = document.createElement("main"); document.body.append(root);
  const settings = { theme: "midnight", width: 523, grid: true, outlines: true, panel: "code" };
  const dispose = render(root, h(DesignStudio, { initialView: "input", initialTheme: "midnight", initialSettings: settings, frameworkVersion: "test" }));
  onDispose(dispose);
  const elements = () => descendants(root).filter((node) => node.nodeType === 1);
  const preview = elements().find((node) => node.getAttribute("class") === "preview-frame");
  const stage = elements().find((node) => node.getAttribute("class") === "preview-stage");
  const sidebar = elements().find((node) => node.getAttribute("class") === "studio-sidebar");
  const share = elements().find((node) => node.getAttribute("class") === "preview-share");
  const panel = elements().find((node) => node.getAttribute("class") === "inspector-panel" && node.hasAttribute("data-active"));
  const reset = elements().find((node) => node.tagName === "BUTTON" && node.textContent === "Reset specimen");
  const before = byId(document, "story-input");
  before.value = "Changed"; before.emit("input");
  reset.focus(); reset.emit("click"); await Promise.resolve();
  assert.notEqual(byId(document, "story-input"), before); assert.equal(byId(document, "story-input").value, "Clank Design Studio");
  for (const node of [preview, stage, sidebar, share, panel, reset]) assert.equal(node.isConnected, true);
  assert.equal(preview.style["--preview-width"], "523px"); assert.equal(preview.getAttribute("data-viewport"), "custom");
  assert.equal(stage.hasAttribute("data-grid"), true); assert.equal(stage.hasAttribute("data-outlines"), true);
  assert.match(panel.textContent, /Focused package import/u); assert.equal(document.documentElement.dataset.clankTheme, "midnight");
  assert.equal(view.location.href, url); assert.equal(document.activeElement, reset);
});

test("direct Studio SSR includes one reset action and the initial story; its browser module is allowlisted", async () => {
  const html = await renderToString(h(DesignStudio, { initialView: "input", initialTheme: "clank", frameworkVersion: "test" }), { markers: false });
  assert.equal((html.match(/>Reset specimen<\/button>/gu) ?? []).length, 1);
  assert.match(html, /<button type="button"[^>]*>Reset specimen<\/button>/u);
  assert.match(html, /value="Clank Design Studio"/u);
  const server = await readFile(new URL("../design-site/src/server.tsx", import.meta.url), "utf8");
  assert.ok(server.includes('["tools/specimen-reset.js", "tools/specimen-reset.js"]'));
});

test("the compiled Studio specimen boundary hydrates its server nodes and retains reset ownership", async (t) => {
  const studioSource = await readFile(new URL("../design-site/src/studio.tsx", import.meta.url), "utf8");
  const boundary = studioSource.match(/<div class="story-root">[^\n]+?<\/div>/u)?.[0];
  assert.ok(boundary, "Use the actual Studio boundary so an extra accessor wrapper cannot regress unnoticed");
  const source = `import { h, onCleanup } from ${JSON.stringify(runtime + "dom.js")};
import { createSpecimenReset } from "./tools/specimen-reset.js";
export let controls, clicks = 0, disposals = 0;
function Story() { onCleanup(() => { disposals++; }); return h("button", { type: "button", onClick: () => { clicks++; } }, "Original"); }
export function Fixture() { const specimen = createSpecimenReset(() => h(Story)); controls = specimen; return ${boundary}; }`;
  const path = join(temporary, "specimen-hydration.js");
  await writeFile(path, compile(source, { filename: "specimen-hydration.tsx", jsxImportSource: runtime + "dom.js", sourceMap: false }));
  const fixture = await import(pathToFileURL(path).href);
  assert.equal(await renderToString(h(fixture.Fixture)), '<div class="story-root"><!--clank:start--><button type="button">Original</button><!--clank:end--></div>');
  const { document, onDispose } = browser(t);
  const root = document.createElement("main"), storyRoot = document.createElement("div"), original = document.createElement("button");
  storyRoot.setAttribute("class", "story-root"); original.setAttribute("type", "button"); original.append(document.createTextNode("Original"));
  storyRoot.append(document.createComment("clank:start"), original, document.createComment("clank:end"));
  root.append(storyRoot); document.body.append(root);
  const before = fixture.disposals;
  const dispose = hydrate(root, h(fixture.Fixture)); onDispose(dispose);
  assert.equal(root.getAttribute("data-clank-hydration"), "attached");
  assert.equal(root.firstChild, storyRoot); assert.equal(storyRoot.children[0], original);
  original.emit("click"); assert.equal(fixture.clicks, 1);
  assert.equal(fixture.disposals, before);
  fixture.controls.reset({ currentTarget: null });
  assert.equal(fixture.disposals, before + 1);
  assert.notEqual(storyRoot.children[0], original);
  dispose(); assert.equal(fixture.disposals, before + 2);
});
