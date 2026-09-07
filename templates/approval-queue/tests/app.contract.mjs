import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertAgentActionParity, inspectAgentActions, openBackend, renderToString, applyMigrations, backupSQLite } from "@clank.run/framework";
import { backend } from "../dist/backend.js";
import { RecipeView } from "../dist/view.js";
const kind = "approval-queue";
const fixture = JSON.parse(await readFile(new URL("../fixtures/default.json", import.meta.url), "utf8"));
const origin = "https://recipe.test", resource = `${origin}/__clank/mcp`;
const future = offset => new Date(Math.ceil(Date.now() / 1800000) * 1800000 + (offset + 1) * 1800000).toISOString().slice(0, 16);
const input = offset => ({ title: "Verify the generated app", detail: kind === "booking" ? future(offset) : "Synthetic request details" });
function request(path, session, body) {
  return new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...(session ? { cookie: session.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json", origin }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function register(runtime, user) {
  const response = await runtime.handle(request("/__clank/auth/register", null, { email: user.email, profile: user.profile, password: "fixture-password-123" }));
  const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data));
  return { user: data.user, csrf: data.csrfToken, cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}
async function token(runtime, session, scopes) {
  const registration = await runtime.handle(request("/__clank/oauth/register", null, { client_name: "Recipe contract", redirect_uris: ["http://127.0.0.1:43123/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }));
  assert.equal(registration.status, 201); const client = await registration.json();
  const verifier = "recipe-pkce-verifier-012345678901234567890123456789";
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const params = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", state: "recipe-state", code_challenge: challenge, code_challenge_method: "S256", scope: scopes, resource };
  const consent = await runtime.handle(request("/__clank/oauth/authorize?" + new URLSearchParams(params), session));
  assert.equal(consent.status, 200); const html = await consent.text();
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(html)?.[1]; assert.ok(consentToken);
  const form = (path, body, session) => new Request(origin + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(session ? { origin, cookie: session.cookie } : {}) }, body: new URLSearchParams(body) });
  const approved = await runtime.handle(form("/__clank/oauth/authorize", { ...params, csrf_token: session.csrf, consent_token: consentToken, decision: "approve" }, session));
  assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const response = await runtime.handle(form("/__clank/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier, resource }));
  assert.equal(response.status, 200); return (await response.json()).access_token;
}
async function mcp(runtime, token, method, params = {}) {
  return runtime.handle(new Request(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(params.name ? { "mcp-name": params.name } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "recipe-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
}

test("recipe validates ownership, transitions, UI contracts, and least-privilege MCP access", async () => {
  const runtime = await openBackend(backend, { path: ":memory:", wal: false });
  try {
    const primary = await register(runtime, fixture.users.primary), reviewer = await register(runtime, fixture.users.reviewer);
    const caller = await runtime.caller(request("/", primary));
    let other = await runtime.caller(request("/", reviewer));
    const createdInput = input(0);
    const id = caller.mutation("records.create", createdInput).value;
    const row = caller.query("records.list", {}).value[0];
    assert.equal(row.ownerId, primary.user.id);
    assert.deepEqual(other.query("records.list", {}).value, []);
    assert.throws(() => caller.mutation("records.create", { title: " ", detail: " " }));
    assert.throws(() => other.mutation("records.update", { id, version: row._version, status: kind === "approval-queue" ? "approved" : kind === "booking" ? "cancelled" : "closed" }));
    let renderingUser = primary.user;
    if (kind === "approval-queue") {
      runtime.auth.setRole(reviewer.user.id, "reviewer");
      other = await runtime.caller(request("/", reviewer)); renderingUser = other.auth.user;
      assert.equal(other.query("records.list", {}).value.length, 1);
      other.mutation("records.update", { id, version: row._version, status: "approved", note: "Reviewed" });
      assert.throws(() => other.mutation("records.update", { id, version: row._version + 1, status: "rejected" }));
      const ownId = other.mutation("records.create", input(1)).value;
      const own = other.query("records.list", {}).value.find(item => item._id === ownId);
      assert.throws(() => other.mutation("records.update", { id: ownId, version: own._version, status: "approved" }), error => error.code === "SELF_APPROVAL");
    } else if (kind === "customer-portal") {
      assert.throws(() => caller.mutation("records.update", { id, version: row._version, status: "open", note: "Forged response" }));
      runtime.auth.setRole(reviewer.user.id, "staff"); other = await runtime.caller(request("/", reviewer)); renderingUser = other.auth.user;
      other.mutation("records.update", { id, version: row._version, status: "open", note: "We can help" });
      assert.throws(() => caller.mutation("records.update", { id, version: row._version, status: "closed" }), error => error.code === "VERSION_CONFLICT");
      const latest = caller.query("records.list", {}).value[0]; caller.mutation("records.update", { id, version: latest._version, status: "closed" });
    } else {
      assert.throws(() => other.mutation("records.create", createdInput), error => error.code === "SLOT_TAKEN");
      assert.throws(() => caller.mutation("records.create", { title: "Past", detail: "2000-01-01T12:00" }), error => error.code === "INVALID_TIME");
      caller.mutation("records.update", { id, version: row._version, status: "cancelled" });
      other.mutation("records.create", createdInput);
    }
    const manifestResponse = await runtime.handle(request("/__clank/manifest")); const manifest = await manifestResponse.json();
    const html = await renderToString(RecipeView({ user: renderingUser, records: [row], create: async () => true, update: async () => true, logout() {} }));
    assert.match(html, /Verify the generated app/);
    assertAgentActionParity(inspectAgentActions(html), manifest, { requiredActions: ["records.create", "records.update"] });
    const readToken = await token(runtime, primary, "agent:read");
    const readList = await (await mcp(runtime, readToken, "tools/list")).json();
    const readTool = readList.result.tools.find(tool => tool.name.endsWith("list")); assert.ok(readTool);
    assert.equal(readList.result.tools.length, 1);
    assert.equal((await (await mcp(runtime, readToken, "tools/call", { name: readTool.name, arguments: {} })).json()).result.isError, false);
    const writeToken = await token(runtime, primary, "agent:read agent:write");
    const writeList = await (await mcp(runtime, writeToken, "tools/list")).json();
    const createTool = writeList.result.tools.find(tool => tool.name.endsWith("create")); assert.ok(createTool);
    assert.equal((await mcp(runtime, readToken, "tools/call", { name: createTool.name, arguments: input(3) })).status, 403);
    const written = await (await mcp(runtime, writeToken, "tools/call", { name: createTool.name, arguments: input(3) })).json();
    assert.equal(written.result.isError, false, JSON.stringify(written));
  } finally { runtime.close(); }
});

test("recipe survives migrations and reopen while another runtime enforces the same ownership and booking rules", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "recipe-migration-")); const path = join(root, "app.sqlite");
  let first, second;
  try {
    const directory = new URL("../migrations", import.meta.url).pathname;
    await applyMigrations({ path, directory });
    first = await openBackend(backend, { path });
    const primary = await register(first, fixture.users.primary), outsider = await register(first, fixture.users.reviewer);
    second = await openBackend(backend, { path });
    const other = await second.caller(request("/", outsider));
    assert.deepEqual(other.query("records.list", {}).value, []);
    const caller = await first.caller(request("/", primary));
    const args = input(5); caller.mutation("records.create", args);
    assert.deepEqual(other.query("records.list", {}).value, []);
    if (kind === "booking") assert.throws(() => other.mutation("records.create", args), error => error.code === "SLOT_TAKEN");
    second.close(); second = undefined; first.close(); first = undefined;
    const copy = join(root, "copy.sqlite"); await backupSQLite(path, copy);
    assert.equal((await applyMigrations({ path: copy, directory })).pending.length, 0);
    first = await openBackend(backend, { path: copy });
    const restored = await first.caller(request("/", primary));
    assert.equal(restored.query("records.list", {}).value[0].title, args.title);
  } finally { second?.close(); first?.close(); await rm(root, { recursive: true, force: true }); }
});
