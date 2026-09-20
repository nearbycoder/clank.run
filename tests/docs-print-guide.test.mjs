import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-print-guide-"));
const source = await readFile(new URL("../docs-site/src/enhancements/print-guide.ts", import.meta.url), "utf8");
await writeFile(join(directory, "print-guide.js"), compile(source, { filename: "print-guide.ts", sourceMap: false }));
const { installPrintGuide } = await import(pathToFileURL(join(directory, "print-guide.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const entries = [{ slug: "guide", title: "Example guide" }];

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  click() { for (const handler of this.listeners.click ?? []) handler(); }
}

function fixture(t, { articleExists = true, rootExists = true, printingSupported = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const root = new Element();
  const article = new Element();
  article.id = "docs-article-body";
  article.innerHTML = '<h2 id="example">Example</h2><pre><code>const value = 1;</code></pre>';
  article.attributes = { "data-docs-text-size": "extra-large", "data-docs-code-wrap": "" };
  const body = new Element("body");
  body.attributes = { "data-docs-focus": "", "data-nav-open": "" };
  const activeElement = new Element("a");
  let calls = 0;
  globalThis.window = printingSupported ? { print() { assert.equal(this, window); calls++; } } : {};
  globalThis.document = {
    body,
    activeElement,
    getElementById: (id) => ({ "docs-reader-tools": rootExists ? root : null, "docs-article-body": articleExists ? article : null })[id] ?? null,
    createElement: (name) => new Element(name),
  };
  t.after(() => Object.assign(globalThis, previous));
  return { root, article, body, activeElement, calls: () => calls };
}

test("known guides offer a labeled native print button without opening the print dialog on load", (t) => {
  const { root, article, calls } = fixture(t);
  installPrintGuide(entries, "guide");
  assert.equal(calls(), 0);
  assert.equal(root.children.length, 1);
  const [button] = root.children;
  assert.equal(button.tagName, "button");
  assert.equal(button.type, "button");
  assert.equal(button.textContent, "Print guide");
  assert.equal(button.attributes["aria-controls"], article.id);
  assert.deepEqual(Object.keys(button.listeners), ["click"]);
  button.click();
  assert.equal(calls(), 1);
  button.click();
  assert.equal(calls(), 2);
});

test("repeated enhancement installs only one control and one print action", (t) => {
  const { root, calls } = fixture(t);
  installPrintGuide(entries, "guide");
  installPrintGuide(entries, "guide");
  assert.equal(root.children.length, 1);
  root.children[0].click();
  assert.equal(calls(), 1);
});

test("printing preserves article semantics, focus, navigation state, and reader preferences", (t) => {
  const { root, article, body, activeElement } = fixture(t);
  const originalMarkup = article.innerHTML;
  const originalArticleAttributes = { ...article.attributes };
  const originalBodyAttributes = { ...body.attributes };
  installPrintGuide(entries, "guide");
  root.children[0].click();
  assert.equal(article.innerHTML, originalMarkup);
  assert.deepEqual(article.attributes, originalArticleAttributes);
  assert.deepEqual(body.attributes, originalBodyAttributes);
  assert.equal(document.activeElement, activeElement);
});

test("home, search, unknown guides, missing hosts, and unsupported browsers get no print action", async (t) => {
  for (const [slug, configuration] of [[undefined, {}], ["search", {}], ["unknown", {}], ["guide", { articleExists: false }], ["guide", { rootExists: false }], ["guide", { printingSupported: false }]]) {
    await t.test(`${slug ?? "home"} ${JSON.stringify(configuration)}`, (t) => {
      const { root, calls } = fixture(t, configuration);
      installPrintGuide(entries, slug);
      assert.equal(root.children.length, 0);
      assert.equal(calls(), 0);
    });
  }
});
