import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePerformanceBudgets, runPerformanceBudgets } from "../scripts/performance-budgets.mjs";

test("performance budgets reject over-budget, missing, and non-finite measurements", () => {
  for (const actual of [11, undefined, NaN, Infinity, -1]) {
    assert.equal(evaluatePerformanceBudgets({ work: actual }, { work: 10 })[0].passed, false);
  }
  assert.equal(evaluatePerformanceBudgets({ work: 10 }, { work: 10 })[0].passed, true);
  assert.throws(() => evaluatePerformanceBudgets({}, { work: NaN }), /Invalid budget/);
});

test("framework stays within deterministic work and browser module budgets", async (t) => {
  const report = await runPerformanceBudgets();
  t.diagnostic(JSON.stringify(report));
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => !check.passed)));
});
