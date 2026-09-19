import assert from "node:assert/strict";
import test from "node:test";
import { runDeploymentProviderConformance } from "../dist/provider.js";

test("provider conformance kit verifies portable lifecycle behavior", async () => {
  const calls = [];
  const provider = {
    kind: "example",
    async reconcile(request) {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(request.artifact, null);
      assert.equal(request.desired.state, "stopped");
      assert.equal("token" in request.operation, false);
      calls.push(`reconcile:${request.operation.fence}`);
    },
    async rollback(request) { calls.push(request.confirmation); },
    async delete(request) { calls.push(request.confirmation); },
  };
  const report = await runDeploymentProviderConformance(provider, { projectId: "todo-prod", destructive: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.status), ["passed", "passed", "passed", "passed", "passed"]);
  assert.deepEqual(calls, ["reconcile:1", "reconcile:1", "rollback todo-prod 1", "delete todo-prod"]);
});

test("provider conformance skips destructive capabilities unless explicitly enabled", async () => {
  const provider = { kind: "safe", async reconcile() {}, async rollback() { throw new Error("must not run"); }, async delete() { throw new Error("must not run"); } };
  const report = await runDeploymentProviderConformance(provider);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.slice(-2).map((check) => check.status), ["skipped", "skipped"]);
  assert.match(report.checks.at(-1).message, /explicit destructive/u);
});

test("provider conformance kit reports adapter failure without leaking internals", async () => {
  const report = await runDeploymentProviderConformance({ kind: "broken", async reconcile() { throw new Error("adapter failed\nwith details"); } });
  assert.equal(report.ok, false);
  assert.equal(report.checks[1].status, "failed");
  assert.doesNotMatch(report.checks[1].message, /\n/u);
  assert.equal(report.checks.at(-1).status, "skipped");
});
