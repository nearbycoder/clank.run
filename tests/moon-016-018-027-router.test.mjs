import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-router-improvements-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}');
for (const name of ["core", "dom"]) await symlink(fileURLToPath(new URL(`../dist/${name}.js`, import.meta.url)), join(directory, `${name}.js`));
const filename = fileURLToPath(new URL("../src/router.ts", import.meta.url));
await writeFile(join(directory, "router.js"), compile(await readFile(filename, "utf8"), { filename, sourceMap: false }));
const { createRouter } = await import(pathToFileURL(join(directory, "router.js")));
const component = () => null;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function browser(t, href = "https://example.test/docs/guide?before=1#old") {
  let current = new URL(href);
  const history = [], assigned = [], windowEvents = new Map(), documentEvents = new Map();
  const globals = {
    location: { get href() { return current.href; }, get origin() { return current.origin; }, assign(url) { assigned.push(url); } },
    history: Object.fromEntries(["pushState", "replaceState"].map((method) => [method, (state, _title, url) => { current = new URL(url, current); history.push({ method, state, href: current.href }); }])),
    window: { addEventListener(type, fn) { windowEvents.set(type, fn); }, removeEventListener(type) { windowEvents.delete(type); } },
    document: { title: "", addEventListener(type, fn) { documentEvents.set(type, fn); }, removeEventListener(type) { documentEvents.delete(type); } },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { history, assigned, windowEvents, documentEvents, get href() { return current.href; }, setUrl(value) { current = new URL(value, current); } };
}

test("016: query, fragment, sibling and parent navigation resolve against the current document", async (t) => {
  const page = browser(t);
  const router = createRouter({ routes: [{ path: "*", component }] });
  await router.navigate("?next=2");
  assert.equal(page.href, "https://example.test/docs/guide?next=2");
  assert.equal(router.state.peek().path, "/docs/guide");
  await router.navigate("#section");
  assert.equal(page.href, "https://example.test/docs/guide?next=2#section");
  await router.navigate("sibling");
  assert.equal(page.href, "https://example.test/docs/sibling");
  await router.navigate("../parent");
  assert.equal(page.href, "https://example.test/parent");
  page.setUrl("/docs/guide/");
  await router.navigate("child");
  assert.equal(page.href, "https://example.test/docs/guide/child");
});

test("017: stale guards cannot change history, state, title, or redirect after newer navigation", async (t) => {
  const page = browser(t);
  for (const staleResult of [true, "/redirected", false]) {
    const gate = deferred();
    let staleLoads = 0;
    const router = createRouter({ routes: [
      { path: "/slow", component, guard: () => gate.promise, load: () => { staleLoads++; }, title: "Old" },
      { path: "/current", component, title: "Current" }, { path: "/redirected", component },
    ] });
    const older = router.navigate("/slow");
    const before = page.history.length;
    assert.equal(await router.navigate("/current"), true);
    gate.resolve(staleResult);
    assert.equal(await older, false);
    assert.equal(page.history.length, before + 1);
    assert.equal(router.state.peek().path, "/current");
    assert.equal(document.title, "Current");
    assert.equal(staleLoads, 0);
  }
});

test("017: explicit resolution, popstate, stop, and external navigation invalidate pending guards", async (t) => {
  const page = browser(t, "https://example.test/initial");
  for (const action of ["resolve", "popstate", "stop", "external"]) {
    const gate = deferred();
    const router = createRouter({ routes: [{ path: "/slow", component, guard: () => gate.promise }, { path: "*", component }] });
    const stop = router.start();
    const older = router.navigate("/slow");
    const count = page.history.length;
    if (action === "resolve") await router.resolve("/resolved");
    if (action === "popstate") { page.setUrl("/popped"); page.windowEvents.get("popstate")(); }
    if (action === "stop") stop();
    if (action === "external") await router.navigate("https://external.example.test/path");
    gate.resolve("/old-redirect");
    assert.equal(await older, false, action);
    assert.equal(page.history.length, count, action);
    assert.notEqual(router.state.peek()?.path, "/old-redirect");
    stop();
  }
  assert.deepEqual(page.assigned, ["https://external.example.test/path"]);
});

test("017: current guard failures reject, stale failures settle harmlessly, and invalid URLs do not cancel valid guards", async (t) => {
  browser(t);
  const gate = deferred();
  const router = createRouter({ routes: [{ path: "/slow", component, guard: () => gate.promise }, { path: "*", component }] });
  const pending = router.navigate("/slow");
  await assert.rejects(router.navigate("javascript:alert(1)"), /Unsafe navigation protocol/u);
  gate.resolve(true);
  assert.equal(await pending, true);
  const failure = new Error("guard failed");
  const failed = createRouter({ routes: [{ path: "/fail", component, guard: () => { throw failure; } }] });
  await assert.rejects(failed.navigate("/fail"), (error) => error === failure);
  const stale = deferred();
  const replaced = createRouter({ routes: [{ path: "/slow", component, guard: () => stale.promise }, { path: "*", component }] });
  const obsolete = replaced.navigate("/slow");
  await replaced.navigate("/new");
  stale.reject(failure);
  assert.equal(await obsolete, false);
});

test("018: cyclic and endlessly unique redirects fail within a bounded chain", async (t) => {
  const page = browser(t);
  let calls = 0;
  const guarded = (next) => () => {
    if (++calls > 100) throw new Error("Test safety stop: unbounded redirects");
    return next;
  };
  const cycle = createRouter({ routes: [
    { path: "/a", component, guard: guarded("/b") },
    { path: "/b", component, guard: guarded("/a") },
  ] });
  await assert.rejects(cycle.navigate("/a"), /redirect cycle/u);
  assert.equal(calls, 2);
  assert.equal(page.history.length, 0);
  calls = 0;
  const endless = createRouter({ routes: [{ path: "*", component, guard: () => {
    if (++calls > 100) throw new Error("Test safety stop: unbounded redirects");
    return `/redirect-${calls}`;
  } }] });
  await assert.rejects(endless.navigate("/start"), /redirect limit/u);
  assert.ok(calls <= 33);
  assert.equal(page.history.length, 0);
});

test("017: a retired start disposer cannot cancel navigation after restarting", async (t) => {
  const page = browser(t);
  const gate = deferred();
  const router = createRouter({ routes: [{ path: "/slow", component, guard: () => gate.promise }, { path: "*", component }] });
  const previousStop = router.start();
  previousStop();
  const stop = router.start();
  try {
    const navigation = router.navigate("/slow");
    previousStop();
    gate.resolve(true);
    assert.equal(await navigation, true);
    assert.equal(page.windowEvents.has("popstate"), true);
    assert.equal(router.state.peek().path, "/slow");
  } finally { stop(); }
});

test("018: a valid redirect chain replaces once and preserves protocol validation", async (t) => {
  const page = browser(t);
  const router = createRouter({ routes: [
    { path: "/a", component, guard: () => "/b" },
    { path: "/b", component, guard: async () => "/final" },
    { path: "/final", component },
    { path: "/unsafe", component, guard: () => "data:text/html,unsafe" },
  ] });
  assert.equal(await router.navigate("/a"), true);
  assert.deepEqual(page.history.map((entry) => [entry.method, entry.href]), [["replaceState", "https://example.test/final"]]);
  await assert.rejects(router.navigate("/unsafe"), /Unsafe navigation protocol/u);
  assert.equal(page.history.length, 1);
});

test("027: empty download attributes preserve native clicks while ordinary links navigate", async (t) => {
  const page = browser(t);
  const router = createRouter({ routes: [{ path: "*", component }] });
  const stop = router.start();
  try {
    const click = page.documentEvents.get("click");
    let prevented = 0;
    const anchor = { target: "", download: "", origin: "https://example.test", href: "https://example.test/file", hasAttribute: (name) => name === "download" };
    const event = { button: 0, target: { closest: () => anchor }, preventDefault() { prevented++; } };
    click(event);
    assert.equal(prevented, 0);
    assert.equal(page.history.length, 0);
    anchor.hasAttribute = () => false;
    click(event);
    await Promise.resolve();
    assert.equal(prevented, 1);
    assert.equal(page.history.length, 1);
  } finally { stop(); }
});
