import test from "node:test";
import assert from "node:assert/strict";
import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  openBackend,
  s,
} from "../dist/index.js";

const origin = "https://todo.test";
const resource = `${origin}/__clank/mcp`;

function jsonRequest(path, body, headers = {}) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function formRequest(path, body, headers = {}) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(body),
  });
}

function mcpRequest(payload, token, headers = {}) {
  return new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

async function pkce(verifier) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(bytes).toString("base64url");
}

function authenticatedBackend() {
  const schema = defineDatabase({
    todos: defineTable({
      title: s.string({ min: 1, max: 120 }),
      done: s.boolean(),
    }).owned(),
  });
  const auth = defineAuth({
    password: {
      cost: 1024,
      maxMemory: 4 * 1024 * 1024,
    },
  });
  return defineBackend({ schema, auth }).functions(({ query, mutation }) => ({
    todos: {
      list: query({
        description: "List the signed-in user's todos.",
        args: {},
        returns: s.array(s.object({
          title: s.string(),
          done: s.boolean(),
          _id: s.string(),
          _creationTime: s.number(),
          _version: s.number(),
          _ownerId: s.string(),
        })),
        handler: ({ db }) => db.table("todos").collect(),
      }),
      add: mutation({
        description: "Create a todo for the signed-in user.",
        args: {
          title: s.string({ min: 1, max: 120, description: "Todo title" }),
        },
        agent: { destructive: false },
        handler: ({ db }, { title }) => db.table("todos").insert({ title, done: false }),
      }),
      removeAll: mutation({
        description: "Delete all todos for the signed-in user.",
        args: {},
        agent: { destructive: true },
        handler: ({ db }) => {
          const todos = db.table("todos").collect();
          for (const todo of todos) db.table("todos").delete(todo._id);
          return todos.length;
        },
      }),
      internalRepair: mutation({
        args: {},
        agent: false,
        handler: () => true,
      }),
    },
  }));
}

async function registerUser(runtime) {
  const response = await runtime.handle(jsonRequest("/__clank/auth/register", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    profile: { name: "Agent User" },
  }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: payload.csrfToken,
    user: payload.user,
  };
}

async function loginUser(runtime) {
  const response = await runtime.handle(jsonRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: payload.csrfToken,
    user: payload.user,
  };
}

async function registerClient(runtime) {
  const response = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Test MCP client",
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, { origin: undefined }));
  assert.equal(response.status, 201);
  return response.json();
}

function hiddenInput(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matched = new RegExp(`name="${escapedName}" value="([^"]+)"`, "u").exec(html);
  assert.ok(matched, `Expected hidden OAuth field ${name}.`);
  return matched[1];
}

async function requestConsent(runtime, session, requestParameters) {
  const response = await runtime.handle(new Request(
    `${origin}/__clank/oauth/authorize?${new URLSearchParams(requestParameters)}`,
    { headers: { cookie: session.cookie } },
  ));
  assert.equal(response.status, 200);
  const html = await response.text();
  return {
    html,
    consentToken: hiddenInput(html, "consent_token"),
  };
}

async function authorize(runtime, session, client, scopes = "agent:read agent:write") {
  const verifier = "clank-agent-pkce-verifier-012345678901234567890123456789";
  const challenge = await pkce(verifier);
  const requestParameters = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    state: "opaque-client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: scopes,
    resource,
  };
  const consent = await requestConsent(runtime, session, requestParameters);
  assert.match(consent.html, /Connect Test MCP client/);

  const approval = await runtime.handle(formRequest("/__clank/oauth/authorize", {
    ...requestParameters,
    csrf_token: session.csrf,
    consent_token: consent.consentToken,
    decision: "approve",
  }, {
    cookie: session.cookie,
    origin,
  }));
  assert.equal(approval.status, 303);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.origin, "http://127.0.0.1:43123");
  assert.equal(callback.searchParams.get("state"), "opaque-client-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const token = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: client.redirect_uris[0],
    code_verifier: verifier,
    resource,
  }));
  assert.equal(token.status, 200);
  return { ...(await token.json()), code, verifier };
}

test("OAuth consent proofs tolerate opaque browser headers and reject forgery, mutation, and replay", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: {
      name: "private-todo",
      title: "Private Todo",
      version: "1.0.0",
      description: "Manage private todos.",
    },
  });
  const session = await registerUser(runtime);
  const client = await registerClient(runtime);
  const verifier = "clank-fetch-metadata-pkce-verifier-012345678901234567890";
  const baseParameters = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    state: "fetch-metadata-state",
    code_challenge: await pkce(verifier),
    code_challenge_method: "S256",
    scope: "agent:read agent:write",
    resource,
  };
  const post = (requestParameters, consentToken, headers = {}) => runtime.handle(formRequest(
    "/__clank/oauth/authorize",
    {
      ...requestParameters,
      csrf_token: session.csrf,
      consent_token: consentToken,
      decision: "approve",
    },
    {
      cookie: session.cookie,
      ...headers,
    },
  ));

  const opaqueConsent = await requestConsent(runtime, session, baseParameters);
  const opaqueOrigin = await post(baseParameters, opaqueConsent.consentToken, {
    origin: "null",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(opaqueOrigin.status, 303);
  assert.ok(new URL(opaqueOrigin.headers.get("location")).searchParams.get("code"));

  const missingOriginConsent = await requestConsent(runtime, session, baseParameters);
  const missingOrigin = await post(baseParameters, missingOriginConsent.consentToken, {
    "sec-fetch-site": "cross-site",
  });
  assert.equal(missingOrigin.status, 303);

  const replay = await post(baseParameters, opaqueConsent.consentToken, {
    origin: "null",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error, "invalid_request");

  const forged = await post(baseParameters, `clank_consent_${"A".repeat(32)}`, {
    origin: "https://evil.test",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error, "invalid_request");

  const changedConsent = await requestConsent(runtime, session, baseParameters);
  const changedParameters = {
    ...baseParameters,
    scope: "agent:read",
  };
  const changed = await post(changedParameters, changedConsent.consentToken, {
    origin: "https://evil.test",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(changed.status, 403);
  assert.equal((await changed.json()).error, "invalid_request");

  const otherSession = await loginUser(runtime);
  const sessionBoundConsent = await requestConsent(runtime, session, baseParameters);
  const crossSession = await runtime.handle(formRequest("/__clank/oauth/authorize", {
    ...baseParameters,
    csrf_token: otherSession.csrf,
    consent_token: sessionBoundConsent.consentToken,
    decision: "approve",
  }, {
    cookie: otherSession.cookie,
    origin: "null",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(crossSession.status, 403);
  assert.equal((await crossSession.json()).error, "invalid_request");

  const invalidCsrfConsent = await requestConsent(runtime, session, baseParameters);
  const invalidCsrf = await runtime.handle(formRequest("/__clank/oauth/authorize", {
    ...baseParameters,
    csrf_token: "invalid-csrf-token",
    consent_token: invalidCsrfConsent.consentToken,
    decision: "approve",
  }, {
    cookie: session.cookie,
    origin: "null",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(invalidCsrf.status, 403);
  assert.equal((await invalidCsrf.json()).error, "invalid_request");

  const noProof = await runtime.handle(formRequest("/__clank/oauth/authorize", {
    ...baseParameters,
    csrf_token: session.csrf,
    decision: "approve",
  }, {
    cookie: session.cookie,
    origin: "https://evil.test",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(noProof.status, 403);
  assert.equal((await noProof.json()).error, "invalid_request");
  runtime.close();
});

test("backend functions become deterministic MCP tools with public discovery", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: {
      name: "private-todo",
      title: "Private Todo",
      description: "Manage private todos through authenticated actions.",
    },
  });
  const discovery = await runtime.handle(new Request(`${origin}/.well-known/clank`));
  assert.equal(discovery.status, 200);
  const manifest = await discovery.json();
  assert.equal(manifest.mcp.endpoint, resource);
  assert.equal(manifest.mcp.authentication, "oauth2");
  assert.equal(JSON.stringify(manifest).includes("todos.add"), false);

  const serverCard = await runtime.handle(new Request(`${origin}/.well-known/mcp/server-card.json`));
  assert.equal(serverCard.status, 200);
  assert.equal((await serverCard.json()).tools[0], "dynamic");

  const protectedMetadata = await runtime.handle(new Request(
    `${origin}/.well-known/oauth-protected-resource/__clank/mcp`,
  ));
  assert.deepEqual((await protectedMetadata.json()).authorization_servers, [origin]);
  const authorizationMetadata = await runtime.handle(new Request(
    `${origin}/.well-known/oauth-authorization-server`,
  ));
  const authorization = await authorizationMetadata.json();
  assert.equal(authorization.code_challenge_methods_supported[0], "S256");
  assert.ok(authorization.grant_types_supported.includes("refresh_token"));

  const unauthorized = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }));
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /resource_metadata=/);
  const unauthorizedNotification = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }));
  assert.equal(unauthorizedNotification.status, 401);
  runtime.close();
});

test("OAuth PKCE authenticates MCP tools, scopes writes, rotates refresh tokens, and isolates normal RPC", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const session = await registerUser(runtime);
  const client = await registerClient(runtime);
  const tokens = await authorize(runtime, session, client);

  const initialized = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, tokens.access_token));
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, "clank-app");

  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, tokens.access_token));
  const tools = (await listed.json()).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["todos.add", "todos.list", "todos.removeAll"]);
  assert.equal(tools.find((tool) => tool.name === "todos.add").annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === "todos.removeAll").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "todos.list").annotations.readOnlyHint, true);

  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "todos.add", arguments: { title: "Created by an agent" } },
  }, tokens.access_token));
  assert.equal(added.status, 200);
  assert.equal((await added.json()).result.isError, false);

  const listedTodos = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "todos.list", arguments: {} },
  }, tokens.access_token));
  const listPayload = await listedTodos.json();
  assert.equal(listPayload.result.structuredContent.value[0].title, "Created by an agent");

  const ordinaryRpc = await runtime.handle(jsonRequest("/__clank/mutation/todos.add", {
    title: "Bearer tokens do not authenticate ordinary RPC",
  }, {
    authorization: `Bearer ${tokens.access_token}`,
  }));
  assert.equal(ordinaryRpc.status, 401);

  const replay = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: tokens.code,
    redirect_uri: client.redirect_uris[0],
    code_verifier: tokens.verifier,
    resource,
  }));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");

  const refreshed = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  }));
  assert.equal(refreshed.status, 200);
  const nextTokens = await refreshed.json();
  assert.notEqual(nextTokens.refresh_token, tokens.refresh_token);
  const refreshReplay = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  }));
  assert.equal(refreshReplay.status, 400);
  const revokedFamily = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  }, nextTokens.access_token));
  assert.equal(revokedFamily.status, 401);
  const replacement = await authorize(runtime, session, client);

  const crossOrigin = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
    params: {},
  }, replacement.access_token, { origin: "https://evil.test" }));
  assert.equal(crossOrigin.status, 403);

  runtime.auth.disableUser(session.user.id);
  const disabled = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    params: {},
  }, replacement.access_token));
  assert.equal(disabled.status, 401);
  const disabledRefresh = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: replacement.refresh_token,
    resource,
  }));
  assert.equal(disabledRefresh.status, 400);
  assert.equal((await disabledRefresh.json()).error, "invalid_grant");
  runtime.close();
});

test("read-only OAuth grants hide and reject mutation tools", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const session = await registerUser(runtime);
  const client = await registerClient(runtime);
  const tokens = await authorize(runtime, session, client, "agent:read");
  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }, tokens.access_token));
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["todos.list"]);
  const write = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "todos.add", arguments: { title: "No" } },
  }, tokens.access_token));
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, "insufficient_scope");
  runtime.close();
});

test("OAuth client registration rejects redirects that could exfiltrate authorization codes", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const insecure = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Unsafe client",
    redirect_uris: ["http://attacker.test/callback"],
  }, { origin: undefined }));
  assert.equal(insecure.status, 400);
  assert.equal((await insecure.json()).error, "invalid_request");
  const fragment = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Unsafe client",
    redirect_uris: ["https://client.test/callback#steal"],
  }, { origin: undefined }));
  assert.equal(fragment.status, 400);
  const inconsistent = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Inconsistent client",
    redirect_uris: ["https://client.test/callback"],
    grant_types: ["refresh_token"],
    response_types: ["code"],
  }, { origin: undefined }));
  assert.equal(inconsistent.status, 400);
  assert.equal((await inconsistent.json()).error, "invalid_client_metadata");

  let chunksRead = 0;
  const oversizedBody = new ReadableStream({
    pull(controller) {
      chunksRead++;
      if (chunksRead > 100) return controller.close();
      controller.enqueue(new Uint8Array(1_024).fill(65));
    },
  });
  const oversized = await runtime.handle(new Request(`${origin}/__clank/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBody,
    duplex: "half",
  }));
  assert.equal(oversized.status, 413);
  assert.ok(chunksRead < 100, "OAuth parsing must cancel streaming bodies at its byte limit");
  runtime.close();
});

test("agent endpoint configuration fails closed before opening project resources", async () => {
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { mcpPath: "https://attacker.test/mcp" },
    }),
    /safe absolute URL path/,
  );
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { mcpPath: "/agent", oauthPrefix: "/agent" },
    }),
    /must be different paths/,
  );
});

test("projects without browser auth expose the same typed actions as a public MCP server", async () => {
  const schema = defineDatabase({
    notes: defineTable({ title: s.string({ min: 1, max: 120 }) }),
  });
  const backend = defineBackend({ schema }).functions(({ query, mutation }) => ({
    notes: {
      list: query({
        description: "List public notes.",
        args: {},
        handler: ({ db }) => db.table("notes").collect(),
      }),
      add: mutation({
        description: "Add a public note.",
        args: { title: s.string({ min: 1, max: 120 }) },
        agent: { destructive: false },
        handler: ({ db }, input) => db.table("notes").insert(input),
      }),
    },
  }));
  const runtime = await openBackend(backend, { path: ":memory:" });
  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["notes.add", "notes.list"]);
  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "notes.add", arguments: { title: "Public MCP" } },
  }));
  assert.equal((await added.json()).result.isError, false);
  assert.equal(runtime.query("notes.list", {}).value[0].title, "Public MCP");
  runtime.close();
});
