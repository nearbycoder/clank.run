import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-docs-reading-resume-"));
for (const name of ["storage", "reading-resume"]) {
  const source = await readFile(new URL(`../docs-site/src/enhancements/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { READING_POSITIONS_KEY, READING_POSITION_LIMIT, readingPositions, articleProgress, installReadingResume } = await import(pathToFileURL(join(directory, "reading-resume.js")));
test.after(() => rm(directory, { recursive: true, force: true }));
const allowed = new Set(Array.from({ length: 40 }, (_, index) => `guide-${index}`));
const entries = [...allowed].map((slug) => ({ slug, title: `Title ${slug}` }));

test("saved positions only accept bounded known guide fractions, with finite input and a fixed capacity", () => {
  assert.deepEqual(readingPositions(null, allowed), []);
  assert.deepEqual(readingPositions([{ slug: "guide-0", fraction: 0.4 }, { slug: "guide-0", fraction: 0.6 }, { slug: "missing", fraction: 0.3 },
    { slug: "guide-1", fraction: -0.1 }, { slug: "guide-2", fraction: 1.2 }, { slug: "guide-3", fraction: NaN },
    { slug: "guide-4", fraction: Infinity }, { slug: "guide-5", fraction: "0.4" }, null], allowed), [{ slug: "guide-0", fraction: 0.4 }]);
  assert.equal(readingPositions([...allowed].map((slug) => ({ slug, fraction: 0.4 })), allowed).length, READING_POSITION_LIMIT);
  assert.deepEqual(readingPositions([...Array(128).fill(null), { slug: "guide-0", fraction: 0.4 }], allowed), []);
  assert.equal(articleProgress(1420, 400, 3000, 840), 0.5);
  assert.equal(articleProgress(-1000, 400, 3000, 840), 0);
  assert.equal(articleProgress(6000, 400, 3000, 840), 1);
  assert.equal(articleProgress(100, 400, 200, 840), undefined);
  assert.equal(articleProgress(NaN, 400, 3000, 840), undefined);
});

class Element {
  constructor(name = "div") { this.tagName = name; this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus(options) { globalThis.document.activeElement = this; this.focusOptions = options; }
}
function fixture(t, initial, hash = "", sharedValues) {
  const previous = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const root = new Element();
  const article = new Element();
  const bookmark = new Element("button");
  const values = sharedValues ?? new Map(initial === undefined ? [] : [[READING_POSITIONS_KEY, JSON.stringify(initial)]]);
  const listeners = {};
  const options = {};
  const timers = new Map();
  let nextTimer = 0;
  let rectReads = 0;
  const scrolls = [];
  globalThis.setTimeout = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.window = {
    scrollY: 0, innerHeight: 840, location: { hash },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    addEventListener: (name, handler, config) => { listeners[name] = handler; options[name] = config; },
    scrollTo: (value) => { scrolls.push(value); globalThis.window.scrollY = value.top; },
  };
  article.getBoundingClientRect = () => { rectReads++; return { top: 400 - globalThis.window.scrollY, height: 3000 }; };
  globalThis.document = {
    documentElement: { scrollHeight: 4000 },
    getElementById: (id) => ({ "docs-reader-tools": root, "docs-article-body": article, "docs-bookmark-toggle": bookmark })[id] ?? null,
    createElement: (name) => new Element(name),
  };
  const environment = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const activate = () => Object.assign(globalThis, environment);
  t.after(() => Object.assign(globalThis, previous));
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); };
  return { root, article, bookmark, values, listeners, options, timers, scrolls, flush, activate, rectReads: () => rectReads };
}

test("returning to a guide offers an explicit resume and moves to the saved article fraction only when activated", (t) => {
  const { root, article, scrolls, listeners, values } = fixture(t, [{ slug: "guide-0", fraction: 0.5 }]);
  installReadingResume(entries, "guide-0");
  const [controls, status] = root.children;
  const [resume, clear] = controls.children;
  assert.equal(resume.hidden, false);
  assert.equal(clear.hidden, false);
  assert.equal(resume.textContent, "Resume reading (50%)");
  assert.equal(scrolls.length, 0);
  listeners.pagehide();
  assert.deepEqual(JSON.parse(values.get(READING_POSITIONS_KEY)), [{ slug: "guide-0", fraction: 0.5 }]);
  resume.listeners.click();
  assert.deepEqual(scrolls, [{ top: 1420, behavior: "instant" }]);
  assert.equal(globalThis.document.activeElement, article);
  assert.deepEqual(article.focusOptions, { preventScroll: true });
  assert.equal(resume.hidden, true);
  assert.match(status.textContent, /Resumed/u);
});

test("incoming and newly selected hash anchors always take precedence over resume", (t) => {
  const { root, scrolls, listeners } = fixture(t, [{ slug: "guide-0", fraction: 0.5 }], "#deep-link");
  installReadingResume(entries, "guide-0");
  const [resume] = root.children[0].children;
  assert.equal(resume.hidden, true);
  resume.listeners.click();
  assert.equal(scrolls.length, 0);
  globalThis.window.location.hash = "";
  listeners.hashchange();
  assert.equal(resume.hidden, false);
  globalThis.window.location.hash = "#another-heading";
  resume.listeners.click();
  assert.equal(scrolls.length, 0);
  listeners.hashchange();
  assert.equal(resume.hidden, true);
});

test("scroll saving is passive and debounced, keeps only recent valid guides, and flushes on departure", (t) => {
  const { values, listeners, options, timers, flush, rectReads } = fixture(t, [...allowed].map((slug) => ({ slug, fraction: 0.2 })));
  installReadingResume(entries, "guide-39");
  globalThis.window.scrollY = 1420;
  for (let index = 0; index < 50; index++) listeners.scroll();
  assert.equal(rectReads(), 0);
  assert.equal(timers.size, 1);
  assert.deepEqual(options.scroll, { passive: true });
  flush();
  const stored = JSON.parse(values.get(READING_POSITIONS_KEY));
  assert.deepEqual(stored[0], { slug: "guide-39", fraction: 0.5 });
  assert.equal(stored.length, READING_POSITION_LIMIT);
  assert.equal(rectReads(), 1);
  globalThis.window.scrollY = 2000;
  listeners.scroll();
  listeners.pagehide();
  assert.equal(timers.size, 0);
  assert.deepEqual(JSON.parse(values.get(READING_POSITIONS_KEY))[0], { slug: "guide-39", fraction: 0.754 });
});

test("clear cancels pending saving and preserves other guide positions, restoring focus to a visible control", (t) => {
  const { root, bookmark, values, listeners, timers } = fixture(t, [{ slug: "guide-0", fraction: 0.5 }, { slug: "guide-1", fraction: 0.3 }]);
  installReadingResume(entries, "guide-0");
  globalThis.window.scrollY = 1420;
  listeners.scroll();
  root.children[0].children[1].listeners.click();
  listeners.pagehide();
  assert.equal(timers.size, 0);
  assert.equal(root.children[0].hidden, true);
  assert.deepEqual(JSON.parse(values.get(READING_POSITIONS_KEY)), [{ slug: "guide-1", fraction: 0.3 }]);
  assert.equal(globalThis.document.activeElement, bookmark);
  assert.match(root.children[1].textContent, /cleared/u);
});

test("reaching the guide end removes its completed position while a shallow visit retains earlier progress", (t) => {
  const { root, values, listeners, flush } = fixture(t, [{ slug: "guide-0", fraction: 0.5 }]);
  installReadingResume(entries, "guide-0");
  listeners.scroll();
  flush();
  assert.deepEqual(JSON.parse(values.get(READING_POSITIONS_KEY)), [{ slug: "guide-0", fraction: 0.5 }]);
  globalThis.window.scrollY = 2800;
  listeners.scroll();
  flush();
  assert.equal(values.has(READING_POSITIONS_KEY), false);
  assert.equal(root.children[0].hidden, true);
});

test("home, search, and unknown guides do not install position controls or listeners", (t) => {
  const { root, listeners, values } = fixture(t);
  installReadingResume(entries);
  installReadingResume(entries, "unknown");
  assert.deepEqual(root.children, []);
  assert.deepEqual(listeners, {});
  assert.equal(values.size, 0);
});

test("malformed, oversized, and unavailable local storage leave article reading and local controls usable", (t) => {
  const { root, values, listeners, flush } = fixture(t);
  values.set(READING_POSITIONS_KEY, "{");
  assert.doesNotThrow(() => installReadingResume(entries, "guide-0"));
  assert.equal(root.children[0].hidden, true);
  values.set(READING_POSITIONS_KEY, JSON.stringify([{ slug: "x".repeat(8192), fraction: 0.5 }]));
  installReadingResume(entries, "guide-0");
  assert.equal(root.children[2].hidden, true);
  Object.defineProperty(globalThis.window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => installReadingResume(entries, "guide-0"));
  globalThis.window.scrollY = 1420;
  listeners.scroll();
  assert.doesNotThrow(flush);
  const clear = root.children[4].children[1];
  assert.equal(clear.hidden, false);
  assert.doesNotThrow(() => clear.listeners.click());
  assert.equal(root.children[4].hidden, true);
});


function twoTabs(t, initial = []) {
  const previous = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.after(() => Object.assign(globalThis, previous));
  const values = new Map([[READING_POSITIONS_KEY, JSON.stringify(initial)]]);
  const first = fixture({ after() {} }, undefined, "", values);
  installReadingResume(entries, "guide-0");
  const second = fixture({ after() {} }, undefined, "", values);
  installReadingResume(entries, "guide-1");
  const save = (tab, top) => {
    tab.activate();
    globalThis.window.scrollY = top;
    tab.listeners.scroll();
    tab.flush();
  };
  return { first, second, values, save, positions: () => JSON.parse(values.get(READING_POSITIONS_KEY) ?? "[]") };
}

test("two open guide tabs merge saves even before cross-tab storage events arrive", (t) => {
  const { first, second, save, positions } = twoTabs(t);
  save(first, 1420);
  save(second, 2000);
  assert.deepEqual(positions(), [{ slug: "guide-1", fraction: 0.754 }, { slug: "guide-0", fraction: 0.5 }]);
  save(first, 1600);
  assert.deepEqual(positions(), [{ slug: "guide-0", fraction: 0.579 }, { slug: "guide-1", fraction: 0.754 }]);
});

test("clearing one tab preserves newly saved guides and later saves do not resurrect cleared positions", (t) => {
  const { first, second, save, positions } = twoTabs(t, [{ slug: "guide-0", fraction: 0.4 }, { slug: "guide-1", fraction: 0.2 }]);
  save(second, 2000);
  first.activate();
  first.root.children[0].children[1].listeners.click();
  assert.deepEqual(positions(), [{ slug: "guide-1", fraction: 0.754 }]);
  save(second, 1420);
  assert.deepEqual(positions(), [{ slug: "guide-1", fraction: 0.5 }]);
  // Completing a guide must also retain newer progress written by another tab.
  save(first, 1600);
  save(second, 2800);
  assert.deepEqual(positions(), [{ slug: "guide-0", fraction: 0.579 }]);
});

test("storage events reconcile resume controls without scrolling or overriding hash targets", (t) => {
  const { root, values, listeners, scrolls } = fixture(t);
  installReadingResume(entries, "guide-0");
  const [resume, clear] = root.children[0].children;
  values.set(READING_POSITIONS_KEY, JSON.stringify([{ slug: "guide-0", fraction: 0.4 }]));
  listeners.storage({ key: "other-key" });
  assert.equal(resume.hidden, true);
  listeners.storage({ key: READING_POSITIONS_KEY });
  assert.equal(resume.hidden, false);
  assert.equal(resume.textContent, "Resume reading (40%)");
  assert.equal(clear.hidden, false);
  assert.deepEqual(scrolls, []);
  globalThis.window.location.hash = "#selected-heading";
  values.set(READING_POSITIONS_KEY, JSON.stringify([{ slug: "guide-0", fraction: 0.6 }]));
  listeners.storage({ key: READING_POSITIONS_KEY });
  assert.equal(resume.hidden, true);
  resume.listeners.click();
  assert.deepEqual(scrolls, []);
  globalThis.window.location.hash = "";
  listeners.hashchange();
  assert.equal(resume.textContent, "Resume reading (60%)");
  values.clear();
  listeners.storage({ key: null });
  assert.equal(root.children[0].hidden, true);
  assert.deepEqual(scrolls, []);
});

test("an external clear received before its storage event prevents stale resume and stale collection writes", (t) => {
  const { root, values, listeners, scrolls, flush } = fixture(t, [{ slug: "guide-0", fraction: 0.4 }, { slug: "guide-1", fraction: 0.5 }]);
  installReadingResume(entries, "guide-0");
  values.clear();
  root.children[0].children[0].listeners.click();
  assert.deepEqual(scrolls, []);
  assert.equal(root.children[0].hidden, true);
  globalThis.window.scrollY = 1420;
  listeners.scroll();
  flush();
  assert.deepEqual(JSON.parse(values.get(READING_POSITIONS_KEY)), [{ slug: "guide-0", fraction: 0.5 }]);
  values.set(READING_POSITIONS_KEY, JSON.stringify([{ slug: "guide-0", fraction: 0.7 }]));
  listeners.storage({ key: READING_POSITIONS_KEY });
  assert.equal(root.children[0].children[0].hidden, true, "Active reading does not receive a new resume offer");
});

test("storage becoming unavailable preserves in-memory resume and clear behavior", (t) => {
  const { root, listeners, scrolls } = fixture(t, [{ slug: "guide-0", fraction: 0.5 }]);
  installReadingResume(entries, "guide-0");
  Object.defineProperty(globalThis.window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => listeners.storage({ key: READING_POSITIONS_KEY }));
  const [resume, clear] = root.children[0].children;
  assert.equal(resume.hidden, false);
  assert.doesNotThrow(() => resume.listeners.click());
  assert.deepEqual(scrolls, [{ top: 1420, behavior: "instant" }]);
  assert.doesNotThrow(() => clear.listeners.click());
  assert.equal(root.children[0].hidden, true);
});
