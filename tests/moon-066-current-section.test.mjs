import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-current-section-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
const source = await readFile(new URL("../docs-site/src/enhancements/current-section.ts", import.meta.url), "utf8");
await writeFile(join(directory, "current-section.js"), compile(source, { filename: "current-section.ts", sourceMap: false }));
const { installCurrentSection } = await import(pathToFileURL(join(directory, "current-section.js")));

class Link {
  constructor(hash) {
    this.hash = hash;
    this.attributes = { "aria-current": "location" };
    this.classes = new Set(["active"]);
    this.writes = 0;
    this.classList = { toggle: (name, enabled) => {
      this.writes++;
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    } };
  }
  setAttribute(name, value) { this.writes++; this.attributes[name] = value; }
  removeAttribute(name) { this.writes++; delete this.attributes[name]; }
}

function fixture(t, { hash = "", positions = [300, 800, 1500], articleExists = true, linksExist = true, resizeObserver = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
  let reads = 0;
  const headings = positions.map((top, index) => ({
    id: `section-${index}`, top,
    getBoundingClientRect() { reads++; return { top: this.top }; },
  }));
  const desktop = headings.map(({ id }) => new Link(`#${id}`));
  const mobile = headings.map(({ id }) => new Link(`#${id}`));
  const page = {};
  const article = { querySelectorAll: () => headings, closest: () => page };
  const listeners = {};
  const options = {};
  const frames = new Map();
  const observed = [];
  let frameId = 0;
  let onResize;
  globalThis.window = {
    location: { hash },
    addEventListener(name, handler, config) { (listeners[name] ??= []).push(handler); options[name] = config; },
    requestAnimationFrame(handler) { const id = ++frameId; frames.set(id, handler); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    scrollTo() { throw new Error("Section tracking must never move the reader"); },
  };
  if (resizeObserver) {
    globalThis.ResizeObserver = class {
      constructor(handler) { onResize = handler; }
      observe(element) { observed.push(element); }
    };
    window.ResizeObserver = globalThis.ResizeObserver;
  }
  const focus = {};
  globalThis.document = {
    activeElement: focus,
    getElementById: (id) => id === "docs-article-body" && articleExists ? article : null,
    querySelectorAll: (selector) => linksExist ? [
      ...(selector.includes(".toc ") ? [...desktop].reverse() : []),
      ...(selector.includes(".mobile-toc ") ? mobile : []),
    ] : [],
  };
  t.after(() => Object.assign(globalThis, previous));
  const dispatch = (name) => { for (const handler of listeners[name] ?? []) handler(); };
  return {
    headings, desktop, mobile, article, page, focus, frames, listeners, options, observed,
    reads: () => reads,
    dispatch,
    reflow: () => onResize(),
    hash: (value) => { window.location.hash = value; dispatch("hashchange"); },
    flush: () => { const pending = [...frames.values()]; frames.clear(); for (const handler of pending) handler(); },
    assertCurrent: (index) => {
      for (const list of [desktop, mobile]) {
        list.forEach((link, position) => {
          assert.equal(link.classes.has("active"), position === index, `Active class for ${link.hash}`);
          assert.equal(link.attributes["aria-current"], position === index ? "location" : undefined, `Accessible current location for ${link.hash}`);
        });
      }
    },
  };
}

test("installation clears stale section markers above the article and installs one tracker for both TOCs", (t) => {
  const f = fixture(t);
  installCurrentSection();
  installCurrentSection();
  f.assertCurrent(null);
  assert.equal(f.listeners.scroll.length, 1);
  assert.equal(f.listeners.resize.length, 1);
  assert.equal(f.listeners.hashchange.length, 1);
  assert.deepEqual(f.options.scroll, { passive: true });
  assert.deepEqual(f.observed, [f.page]);
  assert.equal(document.activeElement, f.focus);
  assert.equal(window.location.hash, "");
});

test("initial decoded fragments select matching desktop and mobile links before scroll restoration", (t) => {
  const f = fixture(t, { hash: "#section%2D1" });
  f.mobile[1].hash = "#section%2D1";
  installCurrentSection();
  f.assertCurrent(1);
  assert.equal(f.reads(), 0);
  assert.equal(window.location.hash, "#section%2D1");
});

test("scrolling uses document heading order, moves backward, and clears the section above the first heading", (t) => {
  const f = fixture(t, { positions: [-600, 100, 600] });
  installCurrentSection();
  f.assertCurrent(1);
  f.headings.forEach((heading) => { heading.top -= 600; });
  f.dispatch("scroll");
  f.flush();
  f.assertCurrent(2);
  f.headings.forEach((heading) => { heading.top += 1100; });
  f.dispatch("scroll");
  f.flush();
  f.assertCurrent(0);
  f.headings.forEach((heading) => { heading.top += 221; });
  f.dispatch("scroll");
  f.flush();
  f.assertCurrent(null);
});

test("scroll bursts share one frame, bound layout reads on long guides, and avoid unchanged DOM writes", (t) => {
  const f = fixture(t, { positions: Array.from({ length: 1024 }, (_, index) => index * 500 - 250_000) });
  installCurrentSection();
  f.assertCurrent(500);
  const reads = f.reads();
  const writes = f.desktop.reduce((total, link) => total + link.writes, 0);
  for (let index = 0; index < 100; index++) f.dispatch("scroll");
  assert.equal(f.frames.size, 1);
  assert.equal(f.reads(), reads);
  f.flush();
  assert.ok(f.reads() - reads < 20, "A long guide should not measure every heading on each frame");
  assert.equal(f.desktop.reduce((total, link) => total + link.writes, 0), writes);
  f.assertCurrent(500);
});

test("hash navigation updates both TOCs immediately and safely handles empty, unknown, and malformed fragments", (t) => {
  const f = fixture(t, { positions: [90, 590, 1090] });
  installCurrentSection();
  f.assertCurrent(0);
  f.dispatch("scroll");
  assert.equal(f.frames.size, 1);
  f.hash("#section-2");
  f.assertCurrent(2);
  assert.equal(f.frames.size, 0, "An old queued position update cannot immediately replace a new fragment selection");
  f.headings.forEach((heading) => { heading.top += 200; });
  for (const hash of ["", "#not-a-heading", "#%E0%A4%A"]) {
    assert.doesNotThrow(() => f.hash(hash));
    f.assertCurrent(null);
  }
  f.hash("#section-1");
  f.assertCurrent(1);
  f.headings[0].top = 90;
  f.dispatch("scroll");
  f.flush();
  f.assertCurrent(0);
  assert.equal(document.activeElement, f.focus);
  assert.equal(window.location.hash, "#section-1", "Reading position must not rewrite the URL");
});

test("focus reading and disclosure reflow refresh both hidden and visible navigation copies", (t) => {
  const f = fixture(t, { positions: [90, 590, 1090] });
  installCurrentSection();
  f.assertCurrent(0);
  f.headings.forEach((heading) => { heading.top += 200; });
  f.reflow();
  f.flush();
  f.assertCurrent(null);
  f.headings.forEach((heading) => { heading.top -= 750; });
  f.dispatch("resize");
  f.reflow();
  assert.equal(f.frames.size, 1);
  f.flush();
  f.assertCurrent(1);
});

test("scroll and hash tracking work without observer support and ignore broken navigation targets", (t) => {
  const f = fixture(t, { resizeObserver: false });
  f.desktop.push(new Link("#missing"), new Link("#%E0%A4%A"));
  installCurrentSection();
  assert.equal(f.observed.length, 0);
  for (const link of f.desktop.slice(-2)) {
    assert.equal(link.attributes["aria-current"], undefined);
    assert.equal(link.classes.has("active"), false);
  }
  f.hash("#section-2");
  assert.equal(f.mobile[2].attributes["aria-current"], "location");
  f.headings[0].top = 90;
  f.dispatch("scroll");
  f.flush();
  assert.equal(f.mobile[0].attributes["aria-current"], "location");
  assert.equal(f.mobile[2].attributes["aria-current"], undefined);
});

test("pages without article headings or section links install no event listeners", async (t) => {
  for (const options of [{ articleExists: false }, { linksExist: false }, { positions: [] }]) {
    await t.test(JSON.stringify(options), (t) => {
      const f = fixture(t, options);
      installCurrentSection();
      assert.deepEqual(f.listeners, {});
      assert.deepEqual(f.observed, []);
    });
  }
});
