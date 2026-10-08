import assert from "node:assert/strict";
import { defineBackend, defineDatabase, defineTable, openBackend, s, exportBackendOpenAPI } from "@clank.run/framework";
const definition = defineBackend({ schema: defineDatabase({ records: defineTable({ value: s.number() }) }) }).functions(({ publicQuery }) => ({
  echo: publicQuery({ args: { value: s.number({ integer: true }) }, returns: s.number({ integer: true }), agent: false, handler: (_context, { value }) => value }),
}));
const document = exportBackendOpenAPI(definition, { title: "Packed API", version: "1", serverUrl: "http://localhost" });
assert.equal(document.paths["/__clank/query/echo"].post["x-clank-agent-exposed"], false);
const runtime = await openBackend(definition, { path: ":memory:", agent: false });
try {
  for (const [value, status] of [[42, 200], [1.5, 422]]) {
    const response = await runtime.handle(new Request("http://localhost/__clank/query/echo", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ value }) }));
    assert.equal(response.status, status);
    if (status === 200) assert.equal((await response.json()).value, value);
  }
} finally { runtime.close(); }
