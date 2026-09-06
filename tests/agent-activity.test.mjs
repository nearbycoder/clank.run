import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, defineBackend, defineDatabase, defineTable, openBackend, renderAgentActivity, createDevtools, renderDevtools, s } from "../dist/index.js";
function call(name, args = {}, headers = {}) {
  return new Request("https://activity.test/__clank/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name, ...headers,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
}
test("MCP activity records scopes and outcomes without arguments or credentials; hook failures do not change calls", async () => {
  const events = [];
  const server = createMcpServer({ name: "activity-test", sessions: false,
    authenticate: async request => request.headers.has("authorization") ? { context: { secret: "private-context" }, scopes: new Set(["agent:read"]) } : null,
    tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, invoke: () => ({ secret: "private-result" }) },
      { name: "write", description: "Write", inputSchema: { type: "object" }, requiredScope: "agent:write", invoke: () => true },
      { name: "fail", description: "Fail", inputSchema: { type: "object" }, invoke: () => { throw new Error("private-error"); } }],
    onToolActivity(event) { events.push(event); throw new Error("ignored observer"); },
  });
  try {
    assert.equal((await server.handle(call("write"))).status, 401);
    assert.equal((await server.handle(call("write", {}, { authorization: "Bearer private-token" }))).status, 403);
    assert.equal((await (await server.handle(call("read", { password: "private-input" }, { authorization: "Bearer private-token" }))).json()).result.isError, false);
    assert.equal((await (await server.handle(call("fail", {}, { authorization: "Bearer private-token" }))).json()).result.isError, true);
    await server.handle(call("unknown-private-name", {}, { authorization: "Bearer private-token" }));
    assert.deepEqual(events.map(event => event.outcome), ["denied", "denied", "ok", "error"]);
    assert.deepEqual(events[1].scopes, ["agent:read"]);
    assert.equal(events[1].requiredScope, "agent:write");
    assert.doesNotMatch(JSON.stringify(events), /private-/);
  } finally { server.close(); }
});

test("backend explorer persists bounded tool history, filters outcomes, and shows observed revisions in DevTools", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-agent-activity-"));
  const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ text: s.string() }) }) }).functions(({ mutation, query }) => ({
    add: mutation({ args: { text: s.string() }, handler: ({ db }, input) => db.table("items").insert(input) }),
    list: query({ args: {}, handler: ({ db }) => db.table("items").collect() }),
    fail: mutation({ args: {}, handler: () => { throw new Error("private-error"); } }),
  }));
  const options = { path: join(root, "app.sqlite"), agentActivity: { maxEntries: 2 } };
  let backend = await openBackend(definition, options);
  try {
    await backend.handle(call("add", { text: "private-input" }));
    let event = backend.inspectAgentActivity().events[0];
    assert.equal(event.tool, "add"); assert.equal(event.outcome, "ok");
    assert.equal(event.beforeRevision, 0); assert.equal(event.afterRevision, 1);
    await backend.handle(call("list")); await backend.handle(call("fail"));
    assert.equal(backend.inspectAgentActivity().events.length, 2);
    assert.equal(backend.inspectAgentActivity({ outcome: "error" }).events[0].tool, "fail");
    assert.equal(backend.inspectAgentActivity({ tool: "add" }).events.length, 0);
    backend.close(); backend = await openBackend(definition, options);
    assert.equal(backend.inspectAgentActivity().events.length, 2);
    const inspector = createDevtools({ agentActivity: () => backend.inspectAgentActivity() });
    const html = renderDevtools(inspector.snapshot());
    assert.match(html, /Agent activity/); assert.match(html, /Observed revisions/);
    assert.doesNotMatch(html, /private-input|private-error/);
    inspector.dispose();
    const escaped = renderAgentActivity({ retainedLimit: 1, events: [{ tool: "<script>alert(1)</script>", requiredScope: "agent:read", scopes: ["<img>"], outcome: "error", startedAt: 0, durationMs: 0, beforeRevision: null, afterRevision: null }] });
    assert.doesNotMatch(escaped, /<script>|<img>/i);
  } finally { backend.close(); await rm(root, { recursive: true, force: true }); }
});
