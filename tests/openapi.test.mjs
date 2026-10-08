import test from "node:test";
import assert from "node:assert/strict";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "../dist/index.js";
import { exportBackendOpenAPI } from "../dist/openapi.js";

const settings = { title: "Example API", version: "1", serverUrl: "https://api.test" };
function definition(returns = s.number(), args = s.number()) {
  return defineBackend({ schema: defineDatabase({ records: defineTable({ value: s.number() }) }) }).functions(({ publicQuery }) => ({
    math: { double: publicQuery({ args: { value: args }, returns, agent: false, handler: (_context, input) => input.value * 2 }) },
  }));
}
test("OpenAPI exports the actual RPC paths, schemas, auth and explicit replay configuration", async () => {
  const backend = defineBackend({ auth: defineAuth(), schema: defineDatabase({ records: defineTable({ value: s.number() }).owned() }) }).functions(({ query, mutation, publicQuery }) => ({
    list: query({ args: {}, returns: s.array(s.number()), handler: ({ db }) => db.table("records").collect().map(row => row.value) }),
    add: mutation({ args: { value: s.number({ integer: true, min: 0 }) }, returns: s.id("records"), agent: false, handler: ({ db }, args) => db.table("records").insert(args) }),
    ping: publicQuery({ args: {}, returns: s.literal("pong"), handler: () => "pong" }),
  }));
  const runtime = await openBackend(backend, { path: ":memory:", agent: false, offlineMutations: { retentionMs: 60000 } });
  try {
    const document = exportBackendOpenAPI(backend, { ...settings, offlineMutations: { retentionMs: 60000 } });
    assert.equal(document.openapi, "3.1.1");
    assert.deepEqual(document.paths["/__clank/query/ping"].post.security, []);
    assert.deepEqual(document.paths["/__clank/mutation/add"].post.security, [{ sessionCookie: [] }]);
    assert.equal(document.components.securitySchemes.sessionCookie.name, "__Host-clank-id");
    assert.equal(document.paths["/__clank/mutation/add"].post["x-clank-agent-exposed"], false);
    assert.equal(document.paths["/__clank/mutation/add"].post["x-clank-idempotency"].retentionMs, 60000);
    assert.deepEqual(JSON.parse(JSON.stringify(document.components.schemas["mutation.add.input"])), backend.functions.add.args.toJSONSchema());
    assert.equal(document.paths["/__clank/query/list"].post["x-clank-idempotency"].enabled, false);
    const request = (path, body, headers = {}) => new Request(settings.serverUrl + path, { method: "POST", headers: { origin: settings.serverUrl, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await runtime.handle(request("/__clank/mutation/add", { value: 1 }))).status, 401);
    const registered = await runtime.handle(request("/__clank/auth/register", { email: "api@example.invalid", password: "a long test passphrase" }));
    const account = await registered.json(), cookie = registered.headers.get("set-cookie").split(";", 1)[0];
    const headers = { cookie, "x-clank-csrf": account.csrfToken, "x-clank-offline-user": account.user.id, "x-clank-mutation-key": `${Date.now()}.${crypto.randomUUID()}` };
    const first = await runtime.handle(request("/__clank/mutation/add", { value: 1 }, headers)); assert.equal(first.status, 200);
    const accepted = await first.json(); assert.equal(accepted.ok, true); assert.equal(typeof accepted.value, "string"); assert.equal(typeof accepted.version, "number");
    assert.deepEqual(await (await runtime.handle(request("/__clank/mutation/add", { value: 1 }, headers))).json(), accepted);
    assert.equal((await runtime.handle(request("/__clank/mutation/add", { value: 2 }, headers))).status, 409);
    assert.equal((await runtime.handle(request("/__clank/mutation/add", { value: 1.5 }, { cookie, "x-clank-csrf": account.csrfToken }))).status, 422);
    assert.deepEqual((await (await runtime.handle(request("/__clank/query/list", {}, { cookie }))).json()).value, [1]);
  } finally { runtime.close(); }
});

test("OpenAPI rejects unspecified, coercing, refined, optional and unsupported contracts", async () => {
  for (const [returns, args, message] of [
    [undefined, s.number(), /explicit returns/u],
    [s.optional(s.number()), s.number(), /defined JSON/u],
    [s.array(s.optional(s.number())), s.number(), /optional values/u],
    [s.literal(NaN), s.number(), /JSON cannot represent/u],
    [s.number(), s.default(s.number(), Infinity), /JSON cannot represent/u],
    [s.number(), s.coerce.number(), /coercion/u],
    [s.number(), s.refine(s.number(), n => n % 2 === 0, "Even values only"), /refinement/u],
    [s.number(), s.url(), /unsupported schema/u],
  ]) {
    let backend = definition(returns, args);
    if (returns === undefined) backend = { ...backend, functions: { math: { double: { ...backend.functions.math.double, returns: undefined } } } };
    assert.throws(() => exportBackendOpenAPI(backend, settings), message);
  }
  assert.throws(() => exportBackendOpenAPI(definition(), { ...settings, serverUrl: "https://secret:password@example.test" }), /credentials/u);
  assert.throws(() => exportBackendOpenAPI(definition(), { ...settings, prefix: "/__clank/" }), /prefix/u);
  assert.throws(() => exportBackendOpenAPI({ functions: { self: null } }, settings), /function tree/u);
});

test("OpenAPI namespace operation IDs cannot collide and export never mutates source schemas", async () => {
  const backend = definition(), fn = backend.functions.math.double;
  const original = fn.args.toJSONSchema();
  const document = exportBackendOpenAPI({ ...backend, functions: { a_b: { c: fn }, a: { b_c: fn } } }, settings);
  assert.equal(new Set(Object.values(document.paths).map(path => path.post.operationId)).size, 2);
  document.components.schemas["query.a_b.c.input"].properties.value.minimum = 99;
  assert.deepEqual(fn.args.toJSONSchema(), original);
  const runtime = await openBackend(backend, { path: ":memory:", agent: false });
  try {
    const response = await runtime.handle(new Request("https://api.test/__clank/query/math.double", { method: "POST", headers: { "content-type": "application/json", origin: "https://api.test" }, body: '{"value":3}' }));
    assert.equal(response.status, 200); assert.equal((await response.json()).value, 6);
  } finally { runtime.close(); }
});

test("OpenAPI matches runtime null-body normalization and rejects invalid server/name contracts", async () => {
  const backend = definition(s.number(), s.default(s.number(), 0));
  const document = exportBackendOpenAPI(backend, settings);
  assert.deepEqual(document.components.schemas["query.math.double.input"].anyOf[1], { type: "null" });
  const runtime = await openBackend(backend, { path: ":memory:", agent: false });
  try {
    const response = await runtime.handle(new Request(settings.serverUrl + "/__clank/query/math.double", { method: "POST", headers: { origin: settings.serverUrl, "content-type": "application/json" }, body: "null" }));
    assert.equal(response.status, 200); assert.equal((await response.json()).value, 0);
  } finally { runtime.close(); }
  for (const name of ["$value", "_value", "value$"]) assert.throws(() => exportBackendOpenAPI({ ...backend, functions: { [name]: backend.functions.math.double } }, settings), /function segment/u);
  assert.throws(() => exportBackendOpenAPI(backend, { ...settings, serverUrl: "https://api.test/nested" }), /origin/u);
  assert.throws(() => exportBackendOpenAPI(backend, { ...settings, title: 123 }), /title/u);
});

test("OpenAPI bounds shared function/default graphs before exponential expansion", () => {
  let defaults = "leaf", tree = {};
  for (let index = 0; index < 20; index++) { defaults = { a: defaults, b: defaults }; tree = { a: tree, b: tree }; }
  assert.throws(() => exportBackendOpenAPI(definition(s.number(), s.default(s.unknown(), defaults)), settings), /node or text budget/u);
  assert.throws(() => exportBackendOpenAPI({ ...definition(), functions: tree }, settings), /function tree exceeds/u);
});
