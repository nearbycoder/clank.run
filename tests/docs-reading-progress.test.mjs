import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-reading-progress-"));
const source = await readFile(new URL("../docs-site/src/enhancements/reading-progress.ts", import.meta.url), "utf8");
await writeFile(join(directory, "reading-progress.js"), compile(source, { filename: "reading-progress.ts", sourceMap: false }));
const { readingPercentage, installReadingProgress } = await import(pathToFileURL(join(directory, "reading-progress.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const entries = [{ slug: "guide", title: "Example guide" }];

test("article progress runs from the article top to its last visible line, with bounded rounded values", () => {
  assert.equal(readingPercentage(400, 3000, 840), 0);
  assert.equal(readingPercentage(120, 3000, 840), 0);
  assert.equal(readingPercentage(-1020, 3000, 840), 50);
  assert.equal(readingPercentage(-2159, 3000, 840), 100);
  assert.equal(readingPercentage(-2160, 3000, 840), 100);
  assert.equal(readingPercentage(-9000, 3000, 840), 100);
  assert.equal(readingPercentage(-1020, 3000, 500), 44);
  assert.equal(readingPercentage(-1020, 5000, 840), 27);
});

test("short articles are complete without scrolling and unavailable geometry stays finite", () => {
  assert.equal(readingPercentage(120, 720, 840), 100);
  assert.equal(readingPercentage(300, 200, 840), 100);
  for (const geometry of [[0, 0, 840], [0, -1, 840], [0, 500, 120], [NaN, 500, 840], [0, Infinity, 840], [0, 500, NaN]]) {
    assert.equal(readingPercentage(...geometry), 0);
  }
});

class Element {
  constructor(tagName = "div") { this.tagName = tagName; this.children = []; this.attributes = {}; this.writes = 0; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  set textContent(value) { this.text = value; this.writes++; }
  get textContent() { return this.text; }
}

function fixture(t, { articleExists = true, rootExists = true, observer = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
  const root = new Element();
  const article = new Element();
  const geometry = { top: 400, height: 3000 };
  const listeners = {};
  const options = {};
  const frames = new Map();
  const observed = [];
  let frameCount = 0;
  let reads = 0;
  let onResize;
  globalThis.window = {
    innerHeight: 840,
    location: { hash: "#existing-heading" },
    addEventListener(name, handler, config) { (listeners[name] ??= []).push(handler); options[name] = config; },
    requestAnimationFrame(handler) { const id = ++frameCount; frames.set(id, handler); return id; },
    scrollTo() { throw new Error("Progress must never move the reader"); },
  };
  if (observer) {
    globalThis.ResizeObserver = class {
      constructor(handler) { onResize = handler; }
      observe(element) { observed.push(element); }
    };
    globalThis.window.ResizeObserver = globalThis.ResizeObserver;
  }
  article.getBoundingClientRect = () => { reads++; return geometry; };
  globalThis.document = {
    getElementById: (id) => ({ "docs-reader-tools": rootExists ? root : null, "docs-article-body": articleExists ? article : null })[id] ?? null,
    createElement: (name) => new Element(name),
  };
  t.after(() => Object.assign(globalThis, previous));
  return {
    root, article, geometry, listeners, options, frames, observed,
    reads: () => reads,
    resizeArticle: () => onResize(),
    dispatch: (name) => { for (const handler of listeners[name] ?? []) handler(); },
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); for (const handler of callbacks) handler(); },
  };
}

test("installation creates a named native progress bar without live announcements, duplicate controls, or navigation changes", (t) => {
  const { root, article, listeners, observed, reads } = fixture(t);
  installReadingProgress(entries, "guide");
  installReadingProgress(entries, "guide");
  assert.equal(root.children.length, 1);
  const [label, progress, percentage] = root.children[0].children;
  assert.equal(label.textContent, "Reading progress");
  assert.equal(label.htmlFor, progress.id);
  assert.equal(progress.tagName, "progress");
  assert.equal(progress.max, 100);
  assert.equal(progress.value, 0);
  assert.equal(percentage.textContent, "0%");
  assert.equal(percentage.attributes["aria-hidden"], "true");
  for (const element of [root.children[0], label, progress, percentage]) {
    assert.equal(element.attributes["aria-live"], undefined);
    assert.equal(element.attributes.role, undefined);
  }
  assert.equal(window.location.hash, "#existing-heading");
  assert.equal(listeners.scroll.length, 1);
  assert.deepEqual(observed, [article]);
  assert.equal(reads(), 1);
});

test("passive scrolls share one animation frame and only changed percentages update content", (t) => {
  const { root, geometry, options, frames, dispatch, flush, reads } = fixture(t);
  installReadingProgress(entries, "guide");
  const [, progress, percentage] = root.children[0].children;
  geometry.top = -1020;
  for (let index = 0; index < 80; index++) dispatch("scroll");
  assert.deepEqual(options.scroll, { passive: true });
  assert.equal(frames.size, 1);
  assert.equal(reads(), 1);
  assert.equal(progress.value, 0);
  flush();
  assert.equal(reads(), 2);
  assert.equal(progress.value, 50);
  assert.equal(progress.textContent, "50%");
  assert.equal(percentage.textContent, "50%");
  const writes = percentage.writes;
  geometry.top--;
  dispatch("scroll");
  flush();
  assert.equal(percentage.writes, writes);
  geometry.top = -10000;
  dispatch("scroll");
  flush();
  assert.equal(progress.value, 100);
});

test("viewport and article reflow recalculate the current percentage using one frame", (t) => {
  const { root, geometry, frames, resizeArticle, dispatch, flush } = fixture(t);
  geometry.top = -1020;
  installReadingProgress(entries, "guide");
  const progress = root.children[0].children[1];
  assert.equal(progress.value, 50);
  window.innerHeight = 500;
  dispatch("resize");
  resizeArticle();
  assert.equal(frames.size, 1);
  flush();
  assert.equal(progress.value, 44);
  geometry.height = 5000;
  resizeArticle();
  flush();
  assert.equal(progress.value, 25);
  geometry.height = 200;
  resizeArticle();
  flush();
  assert.equal(progress.value, 100);
});

test("progress still responds to scrolling and resizing without ResizeObserver", (t) => {
  const { root, geometry, dispatch, flush } = fixture(t, { observer: false });
  installReadingProgress(entries, "guide");
  geometry.top = -1020;
  dispatch("resize");
  flush();
  assert.equal(root.children[0].children[1].value, 50);
});

test("home, search, unknown guides, and missing page elements install no controls or listeners", async (t) => {
  for (const configuration of [{}, { articleExists: false }, { rootExists: false }]) {
    await t.test(JSON.stringify(configuration), (t) => {
      const { root, listeners, observed } = fixture(t, configuration);
      installReadingProgress(entries);
      installReadingProgress(entries, "unknown");
      if (configuration.articleExists === false || configuration.rootExists === false) installReadingProgress(entries, "guide");
      assert.deepEqual(root.children, []);
      assert.deepEqual(listeners, {});
      assert.deepEqual(observed, []);
    });
  }
});
