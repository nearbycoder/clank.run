import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRollout,
  createPortableProjectExport,
  createPromotionPlan,
  createReleaseProvenance,
  createRevisionLedger,
  createSanitizedClone,
  estimateCapacity,
  inspectRevision,
  nextPromotion,
  verifyPortableProjectExport,
  verifyReleaseProvenance,
} from "../dist/lifecycle.js";

const digest = "a".repeat(64);

test("revision inspection replays state and links browser, action, and deploy traces", () => {
  const ledger = createRevisionLedger({ todos: {} }, [
    { id: "ui-1", revision: 1, at: "2026-08-01T00:00:00Z", kind: "ui", actor: "user-1", summary: "Submitted todo", correlationId: "request-1" },
    { id: "mutation-1", revision: 2, at: "2026-08-01T00:00:01Z", kind: "mutation", actor: "user-1", summary: "Created todo", correlationId: "request-1", parentId: "ui-1", patches: [{ op: "set", path: "/todos/todo-1", value: { title: "Ship", done: false } }] },
    { id: "agent-1", revision: 3, at: "2026-08-01T00:00:02Z", kind: "agent", actor: "agent-1", summary: "Completed todo", parentId: "mutation-1", patches: [{ op: "set", path: "/todos/todo-1/done", value: true }] },
  ]);
  assert.equal(inspectRevision(ledger, 2).state.todos["todo-1"].done, false);
  const latest = inspectRevision(ledger);
  assert.equal(latest.state.todos["todo-1"].done, true);
  assert.deepEqual(latest.trace.map((event) => event.id), ["ui-1", "mutation-1", "agent-1"]);
  assert.deepEqual(inspectRevision(ledger, 0).state, { todos: {} });
});

test("release provenance, promotions, and progressive delivery are deterministic", async () => {
  const provenance = await createReleaseProvenance({ releaseId: "release-1", artifactSha256: digest, sourceRevision: "git-abc", migrationIds: ["0001_initial"], configurationSha256: "b".repeat(64), frameworkVersion: "0.15.0", builder: "clank-cli", builtAt: "2026-08-01T00:00:00Z" });
  assert.equal(await verifyReleaseProvenance(provenance), true);
  assert.equal(await verifyReleaseProvenance({ ...provenance, sourceRevision: "git-tampered" }), false);
  const plan = createPromotionPlan(provenance, [
    { name: "canary", trafficPercent: 5, requiredChecks: ["health", "journey"] },
    { name: "production", trafficPercent: 100, requiredChecks: ["health"], requiresApproval: true },
  ]);
  assert.deepEqual(nextPromotion(plan, [{ stage: "canary", checks: { health: true, journey: true } }]), { ready: false, stage: "production", blockers: ["Stage has not run."] });
  assert.equal(nextPromotion(plan, [{ stage: "canary", checks: { health: true, journey: true } }, { stage: "production", checks: { health: true }, approved: true }]).ready, true);
  assert.equal(assessRollout({ samples: 500, errorRate: 0.03, p95Ms: 150 }, { maximumErrorRate: 0.01, maximumP95Ms: 500 }).action, "rollback");
  assert.equal(assessRollout({ samples: 10, errorRate: 0, p95Ms: 100 }, { maximumErrorRate: 0.01, maximumP95Ms: 500 }).action, "pause");
});

test("portable exports detect tampering and sanitized clones are deterministic", async () => {
  const bundle = await createPortableProjectExport({
    name: "todo",
    frameworkVersion: "0.15.0",
    exportedAt: "2026-08-01T00:00:00Z",
    files: [
      { path: "clank.deploy.json", bytes: new TextEncoder().encode("{}") },
      { path: "dist/server.js", bytes: new TextEncoder().encode("export default {}") },
    ],
  });
  assert.equal(await verifyPortableProjectExport(bundle), true);
  assert.equal(await verifyPortableProjectExport({ ...bundle, files: bundle.files.map((file, index) => index ? file : { ...file, content: "e31" }) }), false);
  const clone = await createSanitizedClone([
    { id: 1, email: "person@example.com", title: "Private title", count: 4 },
  ], { default: "hash", fields: { id: "keep", email: "email", title: "redact" } }, "sixteen-byte-clone-salt");
  assert.equal(clone.rows[0].id, 1);
  assert.match(clone.rows[0].email, /^preview\+[a-f0-9]+@example\.invalid$/u);
  assert.equal(clone.rows[0].title, "[redacted]");
  assert.match(clone.rows[0].count, /^hash_[a-f0-9]+$/u);
  assert.deepEqual(clone.redactedFields, ["count", "email", "title"]);
});

test("capacity estimates expose assumptions and cost drivers", () => {
  const estimate = estimateCapacity({ requestsPerMonth: 25_000_000, transferBytesPerMonth: 50_000_000_000, databaseBytes: 2_000_000_000, artifactBytes: 500_000_000, peakRealtimeConnections: 5_000 }, { requestMillion: 0.5, transferGb: 0.1, storageGb: 0.2, processUnit: 10 });
  assert.equal(estimate.processUnits, 3);
  assert.equal(estimate.monthlyCost, 48);
  assert.equal(estimate.assumptions.length, 3);
});

test("lifecycle contracts reject unsafe exports and revision ambiguity", async () => {
  assert.throws(() => createRevisionLedger({}, [{ id: "one", revision: 2, at: "2026-08-01", kind: "mutation", actor: "one", summary: "bad" }]), /revision 1/u);
  assert.throws(() => createRevisionLedger({}, [{ id: "one", revision: 1, at: "2026-08-01", kind: "mutation", actor: "one", summary: "bad", patches: [{ op: "set", path: "/__proto__/polluted", value: true }] }]), /dangerous object key/u);
  const arrayLedger = createRevisionLedger({ values: [] }, [{ id: "one", revision: 1, at: "2026-08-01", kind: "mutation", actor: "one", summary: "bad", patches: [{ op: "set", path: "/values/not-an-index", value: true }] }]);
  assert.throws(() => inspectRevision(arrayLedger), /canonical numeric indexes/u);
  assert.equal({}.polluted, undefined);
  await assert.rejects(createSanitizedClone([], { default: "keep", fields: [] }, "sixteen-byte-clone-salt"), /fields must be an object/u);
  await assert.rejects(createPortableProjectExport({ name: "todo", frameworkVersion: "1.0.0", files: [{ path: "../secret", bytes: new Uint8Array() }] }), /path is invalid/u);
});
