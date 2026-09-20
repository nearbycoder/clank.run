import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-copy-"));
const source = await readFile(new URL("../docs-site/src/enhancements/clipboard.ts", import.meta.url), "utf8");
await writeFile(join(directory, "clipboard.js"), compile(source, { filename: "clipboard.ts", sourceMap: false }));
const { installCopyControls } = await import(pathToFileURL(join(directory, "clipboard.js")));
test.after(() => rm(directory, { recursive: true, force: true }));

class Element {
  constructor(tagName, text = "") {
    this.tagName = tagName;
    this.text = text;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.isConnected = true;
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.text = value; this.children = []; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  async click() { await Promise.all((this.listeners.click ?? []).map((handler) => handler())); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === "figure" && node.tagName === "figure") return node;
      if (selector === "pre[tabindex]" && node.tagName === "pre" && node.hasAttribute("tabindex")) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...((selector === "code" && child.tagName === "code") || (selector === "pre code" && child.tagName === "code" && child.parentElement.tagName === "pre") ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { document.activeElement = this; }
}

function fixture(t, clipboard) {
  const previous = Object.fromEntries(["document", "navigator", "setTimeout", "clearTimeout"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const body = new Element("body");
  const figure = new Element("figure");
  const caption = new Element("figcaption", "TypeScript");
  const button = new Element("button", "Copy");
  button.setAttribute("data-copy-code", "");
  button.setAttribute("aria-label", "Copy TypeScript code");
  caption.append(button);
  const pre = new Element("pre");
  pre.setAttribute("tabindex", "0");
  const code = new Element("code", "  ");
  code.append(new Element("span", "const"), new Element("span", ' x = "<safe>";\n\treturn x;\n'));
  pre.append(code);
  figure.append(caption, pre);
  const command = new Element("div");
  const prompt = new Element("span", "$ ");
  const commandCode = new Element("code", "npm install --global @clank.run/framework");
  const commandButton = new Element("button", "Copy");
  commandButton.setAttribute("data-copy-text", commandCode.textContent);
  commandButton.dataset.copyText = commandCode.textContent;
  commandButton.setAttribute("aria-label", "Copy npm install command");
  command.append(prompt, commandCode, commandButton);
  body.append(figure, command);
  const selection = {
    range: null,
    previous: "Existing selection",
    removeAllRanges() { this.range = null; this.previous = ""; },
    addRange(range) { this.range = range; },
    toString() { return this.range?.node.textContent ?? this.previous; },
  };
  const timers = new Map();
  let timerId = 0;
  const doc = {
    body,
    activeElement: button,
    querySelectorAll: () => [button, commandButton],
    getElementById: (id) => body.children.find((element) => element.id === id) ?? null,
    createElement: (tag) => new Element(tag),
    createRange: () => ({ node: null, selectNodeContents(node) { this.node = node; } }),
    getSelection: () => selection,
  };
  Object.defineProperties(globalThis, {
    document: { value: doc, writable: true, configurable: true },
    navigator: { value: { clipboard }, writable: true, configurable: true },
    setTimeout: { value: (handler) => { const id = ++timerId; timers.set(id, handler); return id; }, configurable: true },
    clearTimeout: { value: (id) => timers.delete(id), configurable: true },
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { body, button, pre, code, commandButton, commandCode, selection, timers, doc, status: () => doc.getElementById("docs-copy-status") };
}

test("successful copy writes exact rendered code, announces success, and preserves selection and labels", async (t) => {
  const copied = [];
  const { button, code, selection, timers, status } = fixture(t, { writeText: async (text) => copied.push(text) });
  installCopyControls();
  await button.click();
  assert.deepEqual(copied, ['  const x = "<safe>";\n\treturn x;\n']);
  assert.equal(code.textContent, copied[0]);
  assert.equal(selection.toString(), "Existing selection");
  assert.equal(button.textContent, "Copied");
  assert.equal(button.hasAttribute("aria-busy"), false);
  assert.equal(status().getAttribute("role"), "status");
  assert.equal(status().textContent, "Text copied to clipboard.");
  for (const handler of timers.values()) handler();
  assert.equal(button.textContent, "Copy");
  assert.equal(button.getAttribute("aria-label"), "Copy TypeScript code");
});

test("missing clipboard selects exact highlighted code without caption text or rewriting the code", async (t) => {
  const { button, code, pre, selection, status } = fixture(t);
  const nodes = [...code.children];
  installCopyControls();
  await button.click();
  assert.equal(selection.range.node, code);
  assert.equal(selection.toString(), code.textContent);
  assert.equal(document.activeElement, pre);
  assert.equal(button.textContent, "Selected");
  assert.match(status().textContent, /Text selected.*Copy command/u);
  assert.doesNotMatch(status().textContent, /copied to clipboard/u);
  assert.deepEqual(code.children, nodes);
});

test("denied clipboard selects the install command without its prompt and preserves manual selection", async (t) => {
  const { commandButton, commandCode, selection, timers, status } = fixture(t, { writeText: async () => { throw new Error("permission denied"); } });
  installCopyControls();
  await commandButton.click();
  assert.equal(selection.range.node, commandCode);
  assert.equal(selection.toString(), "npm install --global @clank.run/framework");
  assert.match(commandButton.getAttribute("aria-label"), /selected/u);
  for (const handler of timers.values()) handler();
  assert.equal(selection.toString(), commandCode.textContent);
  assert.equal(commandButton.getAttribute("aria-label"), "Copy npm install command");
  assert.match(status().textContent, /selected/u);
});

test("reinstalling is idempotent and retries restore original labels without old timers overwriting feedback", async (t) => {
  const { button, body, timers, status } = fixture(t);
  installCopyControls();
  installCopyControls();
  assert.equal(button.listeners.click.length, 1);
  assert.equal(body.children.filter((element) => element.id === "docs-copy-status").length, 1);
  await button.click();
  assert.equal(button.textContent, "Selected");
  navigator.clipboard = { writeText: async () => {} };
  await button.click();
  assert.equal(button.textContent, "Copied");
  assert.equal(timers.size, 1);
  assert.equal(status().textContent, "Text copied to clipboard.");
  for (const handler of timers.values()) handler();
  assert.equal(button.textContent, "Copy");
});

test("a stale permission rejection cannot steal selection or replace newer copy feedback", async (t) => {
  let rejectFirst;
  let calls = 0;
  const { button, commandButton, selection, status } = fixture(t, {
    writeText: () => ++calls === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(),
  });
  installCopyControls();
  const first = button.click();
  await button.click();
  assert.equal(calls, 1, "duplicate click while pending is ignored");
  await commandButton.click();
  rejectFirst(new Error("permission denied"));
  await first;
  assert.equal(selection.toString(), "Existing selection");
  assert.equal(button.textContent, "Copy");
  assert.equal(button.hasAttribute("aria-busy"), false);
  assert.equal(commandButton.textContent, "Copied");
  assert.equal(status().textContent, "Text copied to clipboard.");
});

test("unavailable selection and mismatched rendered command report failure without copying unrelated or empty text", async (t) => {
  const copied = [];
  const { button, commandButton, commandCode, doc, status } = fixture(t);
  doc.getSelection = () => null;
  installCopyControls();
  await button.click();
  assert.equal(button.textContent, "Copy unavailable");
  assert.match(status().textContent, /Select it manually/u);
  navigator.clipboard = { writeText: async (text) => copied.push(text) };
  commandCode.textContent = "A different visible command";
  await commandButton.click();
  assert.deepEqual(copied, []);
  assert.equal(commandButton.textContent, "Copy unavailable");
});
