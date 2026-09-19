import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run after building both revisions. This script neither builds nor changes them.
// node scripts/load/performance-ssr.mjs BASELINE_DIST CANDIDATE_DIST [ROWS=100] [ITERATIONS=200] [ROUNDS=6]
const [baselinePath, candidatePath, rowInput = "100", iterationInput = "200", roundInput = "6"] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error("Provide baseline and candidate dist directories.");
const rows = Number(rowInput), iterations = Number(iterationInput), rounds = Number(roundInput);
for (const [name, value, maximum] of [["rows", rows, 10000], ["iterations", iterations, 10000], ["rounds", rounds, 50]]) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}.`);
}

async function load(directory) {
  const base = pathToFileURL(`${resolve(directory)}/`);
  const [dom, core, ssr] = await Promise.all(["dom", "core", "ssr"].map(name => import(new URL(`${name}.js`, base))));
  const { h, For, Portal } = dom;
  let cleaned = 0;
  const items = Array.from({ length: rows }, (_, id) => ({ id, title: `Item ${id} <tag> & "quoted"` }));
  function Row({ item, asynchronous }) {
    core.onCleanup(() => { cleaned++; });
    const title = core.computed(() => item.title);
    const view = h("li", { "data-id": item.id }, title, h("a", { href: `/items/${item.id}` }, "Open"));
    return asynchronous && item.id % 4 === 0 ? Promise.resolve(view) : view;
  }
  const views = {
    static: h("ul", {}, ...items.map(item => h("li", { "data-id": item.id }, item.title))),
    components: h(Portal, {}, h("ul", {}, h(For, { each: items, by: "id" }, item => h(Row, { item, asynchronous: false })))),
    mixed: h(Portal, {}, h("ul", {}, h(For, { each: items, by: "id" }, item => h(Row, { item, asynchronous: true })))),
  };
  return {
    render: name => ssr.renderToString(views[name]),
    cleanupCount: () => cleaned,
  };
}

const implementations = { baseline: await load(baselinePath), candidate: await load(candidatePath) };
const scenarios = [];
for (const name of ["static", "components", "mixed"]) {
  const expected = await implementations.baseline.render(name);
  assert.equal(await implementations.candidate.render(name), expected, `${name}: HTML differs`);
  const allocations = {};
  for (const [label, implementation] of Object.entries(implementations)) {
    let promises = 0;
    const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
    let rendered;
    hook.enable();
    try { rendered = implementation.render(name); } finally { hook.disable(); }
    assert.equal(await rendered, expected);
    allocations[label] = promises;
    for (let warmup = 0; warmup < 20; warmup++) assert.equal(await implementation.render(name), expected);
  }
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const label of order) {
      const implementation = implementations[label];
      const before = implementation.cleanupCount();
      const started = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++) {
        assert.equal(await implementation.render(name), expected, `${name}: unstable output`);
      }
      const elapsedMs = performance.now() - started;
      assert.equal(implementation.cleanupCount() - before, name === "static" ? 0 : rows * iterations);
      samples.push({ round: round + 1, label, elapsedMs, rendersPerSecond: iterations / elapsedMs * 1000 });
    }
  }
  scenarios.push({ name, htmlBytes: Buffer.byteLength(expected), synchronousPromiseAllocations: allocations, samples });
}
console.log(JSON.stringify({ protocol: "clank-ssr-performance/1", node: process.versions.node, rows, iterations, rounds,
  baseline: resolve(baselinePath), candidate: resolve(candidatePath), scenarios }, null, 2));
