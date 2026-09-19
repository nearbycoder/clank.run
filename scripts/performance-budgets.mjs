import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { computed, createRoot, effect, signal } from "../dist/core.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

// Work and byte budgets are portable across machines. Timing is diagnostic only.
export const performanceBudgets = Object.freeze({
  signalEffectRuns: 1_000,
  retainedSsrEffectRuns: 0,
  coreGzipBytes: 4_500,
  domGzipBytes: 12_000,
  routerGzipBytes: 3_500,
  formsGzipBytes: 5_500,
});

export function evaluatePerformanceBudgets(measurements, budgets = performanceBudgets) {
  return Object.entries(budgets).map(([name, maximum]) => {
    const actual = measurements[name];
    if (!Number.isFinite(maximum) || maximum < 0) throw new TypeError(`Invalid budget: ${name}`);
    return { name, actual: Number.isFinite(actual) ? actual : null, maximum,
      passed: Number.isFinite(actual) && actual >= 0 && actual <= maximum };
  });
}

export async function runPerformanceBudgets() {
  const measurements = {};
  const timings = {};
  let started = performance.now();
  createRoot((dispose) => {
    try {
      const source = signal(0);
      const branches = Array.from({ length: 100 }, (_, index) => computed(() => source.value + index));
      let runs = 0;
      let total = 0;
      effect(() => { total = branches.reduce((sum, branch) => sum + branch.value, 0); runs++; });
      runs = 0;
      for (let value = 1; value <= 1_000; value++) {
        source.value = value;
        if (total !== value * 100 + 4_950) throw new Error("Signal fan-out produced stale values.");
      }
      measurements.signalEffectRuns = runs;
    } finally { dispose(); }
  });
  timings.signalFanoutMs = performance.now() - started;

  started = performance.now();
  const shared = signal(0);
  let runs = 0;
  function Page() {
    effect(() => { shared.value; runs++; });
    return h("p", {}, shared);
  }
  for (let index = 0; index < 100; index++) await renderToString(h(Page));
  const before = runs;
  shared.value++;
  measurements.retainedSsrEffectRuns = runs - before;
  timings.ssr100RequestsMs = performance.now() - started;

  for (const name of ["core", "dom", "router", "forms"]) {
    const bytes = await readFile(new URL(`../dist/${name}.js`, import.meta.url));
    measurements[`${name}GzipBytes`] = gzipSync(bytes, { level: 9 }).byteLength;
  }
  const checks = evaluatePerformanceBudgets(measurements);
  return { protocol: "clank-performance-budgets/1", ok: checks.every((check) => check.passed),
    node: process.versions.node, checks, timings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPerformanceBudgets();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
