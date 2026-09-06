import test from "node:test";
import assert from "node:assert/strict";
import { createDevtools, renderDevtools, serveDevtools } from "../dist/devtools.js";
import { signal, computed, effect, createRoot, observeReactivity } from "../dist/core.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../dist/backend.js";
import { s } from "../dist/ai.js";

test("reactive inspection is bounded, value-free, isolated from tracking, and disposable", () => {
  const inspector = createDevtools({ maxEvents: 20 });
  const unrelated = signal("never record this value");
  const stopBad = observeReactivity(() => { unrelated.value; throw new Error("diagnostic failed"); });
  let runs = 0;
  createRoot((dispose) => {
    const source = signal("secret source", { name: "source" });
    const derived = computed(() => source.value.length, { name: "length" });
    effect(() => { derived.value; runs++; });
    unrelated.value = "changed";
    assert.equal(runs, 1, "diagnostic callbacks do not become application dependencies");
    source.value = "new secret value";
    assert.equal(runs, 2);
    const snapshot = inspector.snapshot();
    assert.equal(snapshot.active.length, 2);
    assert.ok(snapshot.events.some(event => event.type === "dependency" && event.sourceId));
    assert.ok(snapshot.events.some(event => event.type === "run" && event.durationMs >= 0));
    assert.ok(snapshot.events.some(event => event.type === "invalidate"));
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|never record/);
    for (let index = 0; index < 100; index++) source.value = String(index);
    assert.equal(inspector.snapshot().events.length, 20);
    assert.equal(inspector.snapshot().truncated, true);
    dispose();
    assert.equal(inspector.snapshot().active.length, 0);
  });
  stopBad();
  inspector.clear();
  assert.equal(inspector.snapshot().events.length, 0);
  inspector.dispose();
  unrelated.value = "after dispose";
  assert.equal(inspector.snapshot().events.length, 0);
  assert.throws(() => createDevtools({ maxEvents: 0 }), /maxEvents/);
});

function definition() {
  return defineBackend({ schema: defineDatabase({ rows: defineTable({ value: s.string() }), other: defineTable({ value: s.string() }) }) })
    .functions(({ query, mutation }) => ({
      list: query({ args: {}, handler: ({ db }) => db.table("rows").collect() }),
      add: mutation({ args: { value: s.string() }, handler: ({ db }, args) => db.table("rows").insert(args) }),
      unrelated: mutation({ args: {}, handler: ({ db }) => db.table("other").insert({ value: "hidden" }) }),
    }));
}

test("query diagnostics explain cache hits, subscriptions, and relevant invalidation without query data", async () => {
  const backend = await openBackend(definition(), { path: ":memory:", diagnostics: true });
  try {
    backend.query("list", {});
    const stop = backend.subscribe("list", {}, () => {});
    assert.equal(backend.inspectQueries()[0].cacheHits, 1);
    assert.equal(backend.inspectQueries()[0].subscriptions, 1);
    backend.mutation("unrelated", {});
    assert.equal(backend.inspectQueries()[0].lastInvalidation, null);
    backend.mutation("add", { value: "private document contents" });
    const report = backend.inspectQueries()[0];
    assert.equal(report.runs, 2);
    assert.equal(report.lastInvalidation, "rows");
    assert.equal(report.cachedEntries, 1);
    assert.ok(report.durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(report), /private|contents|owner|args/);
    const inspector = createDevtools({ queries: () => backend.inspectQueries() });
    assert.equal(inspector.snapshot().queries.length, 1);
    inspector.dispose();
    assert.equal(inspector.snapshot().queries.length, 0);
    stop();
    assert.equal(backend.inspectQueries()[0].subscriptions, 0);
  } finally { backend.close(); }
  assert.deepEqual(backend.inspectQueries(), []);
  const disabled = await openBackend(definition(), { path: ":memory:" });
  try { disabled.query("list", {}); assert.deepEqual(disabled.inspectQueries(), []); }
  finally { disabled.close(); }
});

test("local DevTools serves escaped metadata on loopback and denies cross-origin inspection", async () => {
  const inspector = createDevtools({ queries: () => [{ path: '<script>alert("x")</script>', runs: 1, cacheHits: 0,
    durationMs: 1, subscriptions: 0, cachedEntries: 1, lastInvalidation: null, secret: "not exported" }] });
  const server = await serveDevtools(inspector);
  try {
    assert.equal(server.hostname, "127.0.0.1");
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /Clank DevTools/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|not exported/);
    assert.equal((await fetch(server.url, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(server.url, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
    assert.equal((await fetch(server.url + "/unknown")).status, 404);
    assert.equal(await fetch(server.url, { method: "HEAD" }).then(response => response.text()), "");
    assert.match(renderDevtools({ ...inspector.snapshot(), truncated: true }), /partial view/);
  } finally { await server.close(); inspector.dispose(); }
});
