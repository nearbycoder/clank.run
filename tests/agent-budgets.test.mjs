import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineDatabase, defineTable, openSQLite, s, createMcpServer, McpToolError } from "../dist/index.js";
import { openAgentBudgets, AgentBudgetError } from "../dist/agent-budgets.js";
import { openPointInTimeRecovery, restorePointInTime } from "../dist/point-in-time.js";

const limits = { calls: 10, writes: 10, records: 10, externalOperations: 10 };
const schema = defineDatabase({ items: defineTable({ text: s.string() }).owned(), outbox: defineTable({ key: s.string() }).owned() });
function actions(execute = ({ db }, input) => ({ id: db.table("items").insert(input) }), options = {}) {
  return { add: { revision: "v1", args: s.object({ text: s.string() }), authorize: () => true, execute, ...options } };
}
async function fixture(actionSet = actions(), options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-agent-budget-"));
  const path = join(directory, "app.sqlite"); let database, budgets; let at = 10000;
  const credentials = new Map([["admin", { ownerId: "owner", principalId: "admin" }], ["agent", { ownerId: "owner", principalId: "agent" }], ["other-agent", { ownerId: "owner", principalId: "other-agent" }], ["other-owner", { ownerId: "other-owner", principalId: "other-owner" }]]);
  const config = { actions: actionSet, identity: caller => credentials.get(caller) ?? null, authorizeManage: ({ caller }) => caller === "admin", now: () => at, ...options };
  async function reopen(set = actionSet) { database?.close(); database = await openSQLite(schema, { path }); budgets = await openAgentBudgets(database, { ...config, actions: set }); }
  await reopen();
  return { path, credentials, get database() { return database; }, get budgets() { return budgets; }, setTime(value) { at = value; }, reopen,
    grant(overrides = {}) { return budgets.grant({ principalId: "agent", actions: ["add"], limits, expiresAt: 20000, reason: "controlled test", ...overrides }, "admin"); },
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); } };
}
function run(f, grant, operationId = "one", text = "hello", caller = "agent") {
  return f.budgets.execute({ grantId: grant.id, operationId, action: "add", input: { text } }, caller);
}
function code(expected) { return error => error instanceof AgentBudgetError && error.code === expected; }

test("budgets debit the accepted mutation atomically and replay after restart without spending twice", async () => {
  const f = await fixture();
  try {
    const grant = f.grant(); const receipt = run(f, grant);
    assert.deepEqual(receipt.cost, { calls: 1, writes: 1, records: 1, externalOperations: 0 });
    assert.ok(Object.isFrozen(receipt.cost)); assert.ok(Object.isFrozen(receipt.output));
    assert.deepEqual(run(f, grant), receipt);
    assert.equal(f.database.version, 1);
    await f.reopen(); assert.deepEqual(run(f, grant), receipt);
    assert.deepEqual(f.budgets.preview(grant.id, "agent").remaining, { calls: 9, writes: 9, records: 9, externalOperations: 10 });
    assert.equal(f.database.read(db => db.table("items").collect(), { userId: "owner" }).length, 1);
    assert.throws(() => run(f, grant, "one", "changed"), code("BUDGET_RETRY_CONFLICT"));
    assert.equal(f.database.version, 1);
  } finally { await f.close(); }
});

for (const dimension of ["calls", "writes", "records", "externalOperations"]) {
  test(`exhausting ${dimension} rolls back rows, counters and receipt together`, async () => {
    const f = await fixture(actions(({ db, operationId }, input) => { const id = db.table("items").insert(input); db.table("outbox").insert({ key: operationId }); return { id }; }, { externalOperations: 1 }));
    try {
      const grant = f.grant({ limits: { ...limits, [dimension]: 0 } });
      assert.throws(() => run(f, grant), code("BUDGET_EXCEEDED"));
      assert.deepEqual(f.budgets.preview(grant.id, "agent").used, { calls: 0, writes: 0, records: 0, externalOperations: 0 });
      assert.equal(f.database.version, 0);
      assert.equal(f.database.read(db => db.table("items").collect(), { userId: "owner" }).length, 0);
      assert.equal(Number(f.database[Symbol.for("clank.sqlite.internal")].prepare("SELECT count(*) AS n FROM clank_agent_budget_receipts").get().n), 0);
    } finally { await f.close(); }
  });
}

test("multiple writes count separately while one affected record counts once", async () => {
  const f = await fixture(actions(({ db }, input) => {
    const table = db.table("items"), id = table.insert(input); table.patch(id, { text: "second" }); table.replace(id, { text: "third" }); return { id };
  }));
  try {
    const grant = f.grant({ limits: { ...limits, records: 1, writes: 3 } });
    assert.deepEqual(run(f, grant).cost, { calls: 1, writes: 3, records: 1, externalOperations: 0 });
  } finally { await f.close(); }
});

test("finite JSON output may contain a text field named then without becoming a promise", async () => {
  const f = await fixture(actions(({ db }, input) => ({ id: db.table("items").insert(input), then: "follow up" })));
  try { const grant = f.grant(); const receipt = run(f, grant); assert.equal(receipt.output.then, "follow up"); assert.deepEqual(run(f, grant), receipt); }
  finally { await f.close(); }
});

test("caught budget exceptions cannot commit already inserted excess records", async () => {
  const f = await fixture(actions(({ db }, input) => { try { db.table("items").insert(input); } catch {} return { accepted: true }; }));
  try { const grant = f.grant({ limits: { ...limits, records: 0 } }); assert.throws(() => run(f, grant), code("BUDGET_EXCEEDED")); assert.equal(f.database.version, 0); }
  finally { await f.close(); }
});

test("handler, serialization and asynchronous failures never debit or leave local writes", async () => {
  for (const result of [() => { throw new Error("private failure"); }, () => undefined, () => NaN, () => ({ large: "x".repeat(20000) }), () => Promise.reject(new Error("private asynchronous failure"))]) {
    const f = await fixture(actions(({ db }, input) => { db.table("items").insert(input); return result(); }));
    try {
      const grant = f.grant(); assert.throws(() => run(f, grant));
      assert.equal(f.database.version, 0); assert.equal(f.budgets.preview(grant.id, "agent").used.calls, 0);
      await new Promise(resolve => setImmediate(resolve));
    } finally { await f.close(); }
  }
});

test("saved write, read and query contexts close after success and failure", async () => {
  for (const fail of [false, true]) {
    let writer, read, query, descriptor;
    const f = await fixture(actions(({ db }, input) => {
      writer = db.table("items"); query = writer.query().where("text", "hello");
      descriptor = Object.getOwnPropertyDescriptor(writer, "insert").value;
      if (fail) throw new Error("failure"); return { id: writer.insert(input) };
    }, { authorize: context => { read = context.db.table("items"); return true; } }));
    try {
      const grant = f.grant(); if (fail) assert.throws(() => run(f, grant)); else run(f, grant);
      assert.throws(() => writer.insert({ text: "late" }), /no longer active/);
      assert.throws(() => descriptor({ text: "late" }), /no longer active/);
      assert.throws(() => read.collect(), /no longer active/); assert.throws(() => query.collect(), /no longer active/);
      assert.equal(f.database.version, fail ? 0 : 1);
    } finally { await f.close(); }
  }
});

test("grant management, ownership and current principal are enforced including receipt replay", async () => {
  let permitted = true;
  const f = await fixture(actions(undefined, { authorize: () => permitted }));
  try {
    assert.throws(() => f.budgets.grant({ principalId: "agent", actions: ["add"], limits, expiresAt: 20000, reason: "wrong operator" }, "agent"), code("BUDGET_FORBIDDEN"));
    const grant = f.grant(); run(f, grant);
    assert.throws(() => f.budgets.preview(grant.id, "other-owner"), code("BUDGET_NOT_FOUND"));
    assert.throws(() => run(f, grant, "two", "hello", "other-agent"), code("BUDGET_FORBIDDEN"));
    permitted = false; assert.throws(() => run(f, grant), code("BUDGET_FORBIDDEN")); permitted = true;
    f.credentials.delete("agent"); assert.throws(() => run(f, grant), code("BUDGET_UNAUTHENTICATED"));
    f.credentials.set("agent", { ownerId: "owner", principalId: "agent" });
    f.budgets.revoke(grant.id, "admin"); assert.throws(() => run(f, grant), code("BUDGET_CLOSED"));
    await f.reopen(); assert.throws(() => run(f, grant, "two"), code("BUDGET_CLOSED"));
    assert.deepEqual(f.budgets.preview(grant.id, "admin").remaining, { calls: 0, writes: 0, records: 0, externalOperations: 0 });
  } finally { await f.close(); }
});

test("expired grants and changed action revisions reject new calls and exact old receipts", async () => {
  const f = await fixture();
  try {
    const grant = f.grant(); run(f, grant); f.setTime(20000);
    assert.throws(() => run(f, grant), code("BUDGET_CLOSED")); assert.throws(() => run(f, grant, "two"), code("BUDGET_CLOSED"));
    f.setTime(10000); await f.reopen(actions(undefined, { revision: "v2" }));
    assert.throws(() => run(f, grant), code("BUDGET_ACTION_CHANGED"));
    assert.throws(() => run(f, grant, "two"), code("BUDGET_ACTION_CHANGED"));
  } finally { await f.close(); }
});

test("capacity refuses admission, preserves live receipts and retires only the authorized owner", async () => {
  const f = await fixture(actions(), { maxGrants: 1, maxReceipts: 1, retentionMs: 1000 });
  try {
    const grant = f.grant(); run(f, grant);
    assert.throws(() => f.grant(), code("BUDGET_CAPACITY")); assert.throws(() => run(f, grant, "two"), code("BUDGET_CAPACITY"));
    assert.deepEqual(run(f, grant).cost, { calls: 1, writes: 1, records: 1, externalOperations: 0 });
    f.setTime(20999); assert.equal(f.budgets.prune("admin"), 0);
    assert.throws(() => f.budgets.prune("other-owner"), code("BUDGET_FORBIDDEN"));
    f.setTime(21000); assert.equal(f.budgets.prune("admin"), 1);
    assert.throws(() => run(f, grant), code("BUDGET_NOT_FOUND"));
    const replacement = f.grant({ expiresAt: 30000 }); assert.notEqual(replacement.id, grant.id);
    run(f, replacement);
  } finally { await f.close(); }
});

test("two independent connections share grant balances and replay identities", async () => {
  const f = await fixture(); let second;
  try {
    const grant = f.grant({ limits: { ...limits, calls: 1 } }); run(f, grant);
    second = await openSQLite(schema, { path: f.path });
    const budgets = await openAgentBudgets(second, { actions: actions(), identity: () => ({ ownerId: "owner", principalId: "agent" }), authorizeManage: () => false, now: () => 10000 });
    assert.deepEqual(budgets.execute({ grantId: grant.id, operationId: "one", action: "add", input: { text: "hello" } }, null), run(f, grant));
    assert.throws(() => budgets.execute({ grantId: grant.id, operationId: "two", action: "add", input: { text: "hello" } }, null), code("BUDGET_EXCEEDED"));
  } finally { second?.close(); await f.close(); }
});

test("encrypted recovery restores the grant debit, mutation and replay receipt at one boundary", async () => {
  const f = await fixture(); let recovery, restored;
  try {
    const directory = join(dirname(f.path), "archive"), targetPath = join(dirname(f.path), "restored.sqlite"), encryptionKey = new Uint8Array(32).fill(7);
    // Services bootstrap before the recovery epoch seals the table layout.
    recovery = await openPointInTimeRecovery(f.database, { directory, encryptionKey, exportIntervalMs: false });
    const grant = f.grant(), receipt = run(f, grant), boundary = recovery.status().committedThrough;
    assert.equal(boundary, 2); f.budgets.revoke(grant.id, "admin");
    await recovery.close();
    await restorePointInTime({ directory, encryptionKey, targetPath, throughSequence: boundary, confirmation: "restore point in time" });
    restored = await openSQLite(schema, { path: targetPath });
    const budgets = await openAgentBudgets(restored, { actions: actions(), identity: () => ({ ownerId: "owner", principalId: "agent" }), authorizeManage: () => false, now: () => 10000 });
    assert.deepEqual(budgets.execute({ grantId: grant.id, action: "add", operationId: "one", input: { text: "hello" } }, null), receipt);
    assert.equal(budgets.preview(grant.id, null).used.calls, 1);
    assert.equal(restored.version, 1);
    assert.equal(restored.read(db => db.table("items").collect(), { userId: "owner" }).length, 1);
  } finally { await recovery?.close(); restored?.close(); await f.close(); }
});

test("identity is resolved under the transaction and changed authority cannot commit a grant", async () => {
  let resolves = 0;
  const f = await fixture(actions(), { identity: () => ++resolves % 2 ? { ownerId: "owner", principalId: "admin" } : null });
  try {
    assert.throws(() => f.grant(), code("BUDGET_UNAUTHENTICATED"));
    assert.equal(Number(f.database[Symbol.for("clank.sqlite.internal")].prepare("SELECT count(*) AS n FROM clank_agent_budget_grants").get().n), 0);
    assert.equal(resolves, 2);
  } finally { await f.close(); }
});

test("grant validation and JSON bounds reject unsupported values before accepted work", async () => {
  const f = await fixture();
  try {
    for (const changed of [{ limits: { ...limits, writes: -1 } }, { limits: { ...limits, records: 1.5 } }, { limits: { calls: 1 } }, { actions: ["unknown"] }, { actions: ["add", "add"] }, { reason: "" }, { expiresAt: 10000 }, { expiresAt: 10000 + 31 * 86_400_000 }]) assert.throws(() => f.grant(changed), TypeError);
    const grant = f.grant();
    for (const input of [undefined, { text: undefined }, { text: NaN }, { text: new Date() }, { text: "x".repeat(20000) }, { text: "hello", cycle: null }]) {
      if (input?.cycle === null) input.cycle = input;
      assert.throws(() => f.budgets.execute({ grantId: grant.id, operationId: "one", action: "add", input }, "agent"));
    }
    assert.equal(f.budgets.preview(grant.id, "agent").used.calls, 0); assert.equal(f.database.version, 0);
  } finally { await f.close(); }
});

test("owned rows cannot be read or written through another tenant's budget", async () => {
  const f = await fixture(actions(({ db }, input) => { const rows = db.table("items").collect(); return { rows, inserted: db.table("items").insert(input) }; }));
  try {
    const hidden = f.database.transaction(db => db.table("items").insert({ text: "hidden-other-tenant" }), { userId: "other-owner" });
    const grant = f.grant(); const receipt = run(f, grant);
    assert.deepEqual(receipt.output.rows, []); assert.notEqual(receipt.output.inserted, hidden);
    assert.equal(f.database.read(db => db.table("items").collect(), { userId: "other-owner" }).length, 1);
    assert.doesNotMatch(JSON.stringify(receipt), /hidden-other-tenant/);
  } finally { await f.close(); }
});

test("a missing-record write counts as a write without inventing affected records", async () => {
  const f = await fixture(actions(({ db }) => ({ deleted: db.table("items").delete("missing") })));
  try { const grant = f.grant({ limits: { ...limits, records: 0 } }); assert.deepEqual(run(f, grant).cost, { calls: 1, writes: 1, records: 0, externalOperations: 0 }); }
  finally { await f.close(); }
});

test("history purge is rejected and revocation retirement cannot revive a retry", async () => {
  const f = await fixture(actions(({ db }) => db.table("items").purgeDeleted("missing", { revision: 1, sequence: 0 })), { retentionMs: 1000 });
  try {
    const grant = f.grant(); assert.throws(() => run(f, grant), /cannot purge/);
    f.budgets.revoke(grant.id, "admin"); f.setTime(11000); assert.equal(f.budgets.prune("admin"), 1);
    assert.throws(() => run(f, grant), code("BUDGET_NOT_FOUND"));
  } finally { await f.close(); }
});

test("independent processes contend for a single call with exactly one accepted write", { timeout: 20000 }, async () => {
  const f = await fixture(); const children = [];
  try {
    const grant = f.grant({ limits: { ...limits, calls: 1 } });
    const workers = Array.from({ length: 4 }, (_, index) => {
      const child = fork(fileURLToPath(new URL("./fixtures/budget-contender.mjs", import.meta.url)), [f.path, grant.id, String(index)], { execArgv: ["--disable-warning=ExperimentalWarning"], stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
      let errors = ""; child.stderr.on("data", value => { errors += value; });
      const ready = new Promise((resolve, reject) => { child.on("message", value => { if (value.ready) resolve(); }); child.on("error", reject); child.on("exit", status => { if (status !== 0) reject(new Error(errors || `Worker exit ${status}`)); }); });
      const result = new Promise((resolve, reject) => { child.on("message", value => { if (value.result) resolve(value.result); }); child.on("error", reject); child.on("exit", status => { if (status !== 0) reject(new Error(errors || `Worker exit ${status}`)); }); });
      return { child, ready, result };
    });
    await Promise.all(workers.map(worker => worker.ready)); for (const worker of workers) worker.child.send("go");
    const results = await Promise.all(workers.map(worker => worker.result));
    assert.equal(results.filter(result => result.accepted).length, 1);
    assert.deepEqual(results.filter(result => !result.accepted).map(result => result.code), Array(3).fill("BUDGET_EXCEEDED"));
    assert.equal(f.budgets.preview(grant.id, "agent").used.calls, 1);
    assert.equal(f.database.read(db => db.table("items").collect(), { userId: "owner" }).length, 1);
  } finally { for (const child of children) child.kill(); await f.close(); }
});

test("a real MCP adapter retries accepted budget actions and reports exhaustion without private input", async () => {
  const f = await fixture(); let server;
  try {
    const grant = f.grant({ limits: { ...limits, calls: 1 } });
    server = createMcpServer({ name: "budget-adapter", sessions: false,
      authenticate: request => request.headers.get("authorization") === "Bearer agent" ? { context: "agent", scopes: new Set(["agent:write"]) } : null,
      tools: [{ name: "add", description: "Accept a budgeted item insertion.", inputSchema: { type: "object" }, requiredScope: "agent:write", invoke(input, caller) {
        try { return f.budgets.execute({ grantId: grant.id, action: "add", operationId: input.operationId, input: { text: input.text } }, caller); }
        catch (error) { if (error instanceof AgentBudgetError) throw new McpToolError(error.code, error.message); throw error; }
      } }] });
    const call = async operationId => {
      const request = new Request("https://budget.test/mcp", { method: "POST", headers: { authorization: "Bearer agent", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "add" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { operationId, text: "private-input" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
      return (await (await server.handle(request)).json()).result;
    };
    const first = await call("one"); assert.equal(first.isError, false); assert.deepEqual(await call("one"), first);
    const exhausted = await call("two"); assert.equal(exhausted.isError, true); assert.doesNotMatch(JSON.stringify(exhausted), /private-input/);
    assert.equal(f.budgets.preview(grant.id, "agent").used.calls, 1);
  } finally { server?.close(); await f.close(); }
});
