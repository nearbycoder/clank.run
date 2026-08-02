import assert from "node:assert/strict";
import test from "node:test";
import { defineAction, s } from "../dist/ai.js";
import { defineApp } from "../dist/blueprint.js";
import {
  checkProductionParity,
  compareVisuals,
  createAgentPlayground,
  createStudioReview,
  diffSchemas,
  planFrameworkUpgrade,
  testActionContract,
} from "../dist/tooling.js";

test("App Studio produces the same approval-bound plan used by generation", async () => {
  const blueprint = defineApp({
    name: "Agent Todo",
    description: "A shared todo application.",
    auth: { required: true },
    entities: { todos: { description: "Todo", ownership: "user", realtime: true, displayField: "title", fields: { title: { type: "string", required: true }, done: { type: "boolean", default: false } } } },
    routes: [{ path: "/", view: "todos", access: "authenticated", entity: "todos" }],
  });
  const review = await createStudioReview({ intent: "Build a private live todo app", blueprint });
  assert.equal(review.protocol, "clank-studio-review/1");
  assert.equal(review.approvalDigest, review.plan.digest);
  assert.equal(review.plan.summary.entities, 1);
});

test("visual regression comparison supports tolerance and deterministic ignore regions", () => {
  const baseline = { width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 10, 10, 10, 255]) };
  const current = { width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 80, 10, 10, 255]) };
  assert.equal(compareVisuals(baseline, current).matches, false);
  assert.equal(compareVisuals(baseline, current, { ignoreRegions: [{ x: 1, y: 0, width: 1, height: 1 }] }).matches, true);
});

test("production parity compares capabilities and secret names, never values", () => {
  const report = checkProductionParity(
    { nodeMajor: 22, database: "sqlite", isolation: "process", environmentNames: ["EMAIL_KEY"], migrations: ["0001"], services: ["email"] },
    { nodeMajor: 24, database: "sqlite", isolation: "container", environmentNames: ["EMAIL_KEY", "SEARCH_KEY"], migrations: ["0001"], services: ["email"] },
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => finding.field), ["nodeMajor", "isolation", "environmentNames"]);
  assert.doesNotMatch(JSON.stringify(report), /secret-value/u);
});

test("schema workbench produces classified, reviewable migration SQL", () => {
  const report = diffSchemas(
    { tables: { todos: { columns: { title: { type: "text" }, legacy: { type: "text", nullable: true } } } } },
    { tables: { todos: { columns: { title: { type: "text" }, done: { type: "boolean", default: false } }, indexes: { todos_done: ["done"] } } } },
  );
  assert.equal(report.safe, false);
  assert.deepEqual(report.changes.map((change) => change.kind), ["add-column", "drop-column", "create-index"]);
  assert.match(report.migrationSql, /DESTRUCTIVE/u);
  assert.match(report.migrationSql, /ALTER TABLE "todos"/u);
  assert.throws(() => diffSchemas({ tables: {} }, { tables: { empty: { columns: {} } } }), /1-1,000 columns/u);
  assert.throws(() => diffSchemas({ tables: {} }, { tables: { unsafe: { columns: { id: { type: "integer", default: null } } } } }), /column unsafe\.id is invalid/u);
  assert.throws(() => diffSchemas({ tables: {} }, { tables: { unsafe: { columns: { id: { type: "integer" } }, indexes: { empty: [] } } } }), /index fields is invalid/u);
});

test("contracts generate validation tests and the playground uses real actions", async () => {
  const action = defineAction({
    name: "todos.add",
    description: "Create a todo.",
    input: s.object({ title: s.string({ min: 1 }), token: s.optional(s.string()) }),
    output: s.object({ title: s.string(), created: s.boolean() }),
    handler: ({ title }) => ({ title, created: true }),
  });
  const report = await testActionContract(action);
  assert.equal(report.ok, true);
  assert.equal(report.cases.length, 3);
  let tick = 0;
  const playground = createAgentPlayground([action], { authorize: (call) => call.scopes?.includes("agent:write") === true, now: () => ++tick });
  assert.equal((await playground.call({ action: "todos.add", input: { title: "Ship", token: "hidden" }, scopes: [] })).status, "denied");
  const result = await playground.call({ action: "todos.add", input: { title: "Ship", token: "hidden" }, scopes: ["agent:write"] });
  assert.equal(result.status, "succeeded");
  assert.equal(result.input.token, "[redacted]");
});

test("upgrade assistant distinguishes codemods from hard blockers", () => {
  const plan = planFrameworkUpgrade({ from: "0.14.0", to: "1.0.0", minimumNodeMajor: 24, removedExports: ["legacyApi"], renamedExports: { oldRouter: "createRouter" }, configChanges: ["Set deployment.isolation explicitly."] }, { nodeMajor: 22, usedExports: ["legacyApi", "oldRouter"] });
  assert.equal(plan.ready, false);
  assert.equal(plan.blockers.length, 2);
  assert.deepEqual(plan.edits.map((edit) => edit.kind), ["rename-export", "config"]);
});
