import test from "node:test";
import assert from "node:assert/strict";
import {
  BackendActionError,
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  createMcpServer,
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

function testTool(name, overrides = {}) {
  return {
    name,
    description: `Run ${name}.`,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    requiredScope: "agent:read",
    invoke: ({ value }) => ({ value }),
    ...overrides,
  };
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

test("backend action errors retain their public code through MCP tool calls", async () => {
  const schema = defineDatabase({
    values: defineTable({ value: s.string() }),
  });
  const definition = defineBackend({ schema }).functions(({ mutation }) => ({
    guarded: mutation({
      description: "Run an action with a public application guard.",
      args: {},
      handler: ({ db }) => {
        db.table("values").insert({ value: "must roll back" });
        throw new BackendActionError(409, "ACTION_BLOCKED", "The guarded action is blocked.");
      },
    }),
  }));
  const runtime = await openBackend(definition, { path: ":memory:" });
  try {
    const initialized = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "backend-error-test", version: "1.0.0" },
      },
    }));
    assert.equal(initialized.status, 200);
    const session = initialized.headers.get("mcp-session-id");
    assert.ok(session);
    const called = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "guarded", arguments: {} },
    }, undefined, { "mcp-session-id": session }));
    const result = (await called.json()).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "ACTION_BLOCKED");
    assert.equal(result.structuredContent.error.message, "The guarded action is blocked.");
    assert.equal(runtime.version, 0);
  } finally {
    runtime.close();
  }
});

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
    contentSecurityPolicy: response.headers.get("content-security-policy"),
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
  assert.match(
    consent.contentSecurityPolicy,
    /form-action 'self' http:\/\/127\.0\.0\.1:43123(?:;|$)/u,
  );
  assert.doesNotMatch(consent.contentSecurityPolicy, /form-action[^;]*\*/u);

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

test("OAuth sign-in form returns to consent without a separate application tab", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: {
      name: "private-todo",
      title: "Private Todo",
      version: "1.0.0",
      description: "Manage private todos.",
    },
  });
  await registerUser(runtime);
  const client = await registerClient(runtime);
  const requestParameters = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    state: "inline-login-state",
    code_challenge: await pkce("clank-inline-login-verifier-0123456789012345678901234567"),
    code_challenge_method: "S256",
    scope: "agent:read agent:write",
    resource,
  };
  const authorizeUrl = `/__clank/oauth/authorize?${new URLSearchParams(requestParameters)}`;
  const signIn = await runtime.handle(new Request(`${origin}${authorizeUrl}`));
  assert.equal(signIn.status, 200);
  const signInHtml = await signIn.text();
  assert.match(signInHtml, /Sign in and continue/u);
  assert.match(signInHtml, /action="\/__clank\/auth\/login"/u);
  assert.doesNotMatch(signInHtml, /I’m signed in — continue/u);
  const returnTo = hiddenInput(signInHtml, "return_to");
  assert.equal(returnTo, authorizeUrl.replaceAll("&", "&amp;"));
  const decodedReturnTo = returnTo.replaceAll("&amp;", "&");

  const crossOrigin = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
  }, { origin: "https://attacker.test", "sec-fetch-site": "cross-site" }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("set-cookie"), null);

  const openRedirect = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: "https://attacker.test/callback",
  }, { origin }));
  assert.equal(openRedirect.status, 422);
  assert.equal(openRedirect.headers.get("set-cookie"), null);

  const rejected = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "wrong password",
    return_to: decodedReturnTo,
  }, { origin }));
  assert.equal(rejected.status, 303);
  assert.equal(rejected.headers.get("set-cookie"), null);
  const rejectedLocation = new URL(rejected.headers.get("location"));
  assert.equal(rejectedLocation.origin, origin);
  assert.equal(rejectedLocation.searchParams.get("auth_error"), "invalid_credentials");
  const rejectedPage = await runtime.handle(new Request(rejectedLocation));
  assert.equal(rejectedPage.status, 200);
  assert.match(await rejectedPage.text(), /Email or password is incorrect\./u);

  const accepted = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
  }, { origin }));
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), `${origin}${authorizeUrl}`);
  const cookie = accepted.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const consent = await runtime.handle(new Request(accepted.headers.get("location"), {
    headers: { cookie },
  }));
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /Connect Test MCP client/u);
  runtime.close();
});

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

test("MCP contract revisions change for action and metadata changes but remain deterministic", () => {
  const first = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    tools: [testTool("cards.list"), testTool("cards.move")],
  });
  const equivalent = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    tools: [testTool("cards.move"), testTool("cards.list")],
  });
  const renamed = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    tools: [testTool("cards.list"), testTool("cards.reorder")],
  });
  const added = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    tools: [testTool("cards.list"), testTool("cards.move"), testTool("columns.rename")],
  });
  const metadataChanged = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    tools: [
      testTool("cards.list"),
      testTool("cards.move", { description: "Move a card to a user-defined column." }),
    ],
  });

  assert.match(first.revision, /^mcp-[a-f0-9]{32}$/u);
  assert.equal(first.revision, equivalent.revision);
  assert.notEqual(first.revision, renamed.revision);
  assert.notEqual(first.revision, added.revision);
  assert.notEqual(first.revision, metadataChanged.revision);
  assert.equal(first.manifest().revision, first.revision);
  assert.match(first.manifest().server.version, /^2\.0\.0\+clank\.[a-f0-9]{16}$/u);

  first.close();
  equivalent.close();
  renamed.close();
  added.close();
  metadataChanged.close();
});

test("MCP sessions invalidate cached tools across deployments and stream list change notifications", async () => {
  const oldServer = createMcpServer({
    name: "changing-app",
    version: "1.0.0",
    tools: [
      testTool("todos.list"),
      testTool("todos.add"),
      testTool("todos.setDone"),
      testTool("todos.remove"),
    ],
  });
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stale-client-test", version: "1.0.0" },
    },
  };
  const initialized = await oldServer.handle(mcpRequest(initialize));
  assert.equal(initialized.status, 200);
  const oldSession = initialized.headers.get("mcp-session-id");
  assert.ok(oldSession);
  assert.equal(initialized.headers.get("x-clank-contract-revision"), oldServer.revision);
  const initializedPayload = await initialized.json();
  assert.equal(initializedPayload.result.capabilities.tools.listChanged, true);
  assert.match(initializedPayload.result.serverInfo.version, /\+clank\.[a-f0-9]{16}$/u);

  const ready = await oldServer.handle(mcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, undefined, { "mcp-session-id": oldSession }));
  assert.equal(ready.status, 202);

  const stream = await oldServer.handle(new Request(resource, {
    headers: {
      accept: "text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": oldSession,
    },
  }));
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/u);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /clank contract/u);
  oldServer.notifyToolsChanged();
  const changedEvent = decoder.decode((await reader.read()).value);
  assert.match(changedEvent, /notifications\/tools\/list_changed/u);
  assert.match(changedEvent, new RegExp(oldServer.revision, "u"));
  await reader.cancel();

  const oldList = await oldServer.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, undefined, { "mcp-session-id": oldSession }));
  const oldListPayload = await oldList.json();
  assert.equal(oldListPayload.result.ttlMs, 0);
  assert.equal(oldListPayload.result.cacheScope, "private");
  assert.equal(oldListPayload.result._meta["clank/contractRevision"], oldServer.revision);
  assert.deepEqual(oldListPayload.result.tools.map((tool) => tool.name), [
    "todos.add",
    "todos.list",
    "todos.remove",
    "todos.setDone",
  ]);

  const newServer = createMcpServer({
    name: "changing-app",
    version: "1.0.0",
    tools: [
      testTool("cards.list"),
      testTool("cards.add"),
      testTool("cards.move"),
      testTool("cards.remove"),
      testTool("columns.list"),
      testTool("columns.add"),
      testTool("columns.rename"),
    ],
  });
  assert.notEqual(newServer.revision, oldServer.revision);

  const staleRequest = await newServer.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {},
  }, undefined, { "mcp-session-id": oldSession }));
  assert.equal(staleRequest.status, 404);
  assert.equal((await staleRequest.json()).error.message, "MCP session is no longer active.");

  const reinitialized = await newServer.handle(mcpRequest({ ...initialize, id: 4 }));
  assert.equal(reinitialized.status, 200);
  const newSession = reinitialized.headers.get("mcp-session-id");
  assert.ok(newSession);
  assert.notEqual(newSession, oldSession);
  const reinitializedPayload = await reinitialized.json();
  assert.notEqual(
    reinitializedPayload.result.serverInfo.version,
    initializedPayload.result.serverInfo.version,
  );

  const refreshed = await newServer.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  }, undefined, { "mcp-session-id": newSession }));
  assert.deepEqual((await refreshed.json()).result.tools.map((tool) => tool.name), [
    "cards.add",
    "cards.list",
    "cards.move",
    "cards.remove",
    "columns.add",
    "columns.list",
    "columns.rename",
  ]);

  oldServer.close();
  newServer.close();
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
  assert.equal(manifest.contractRevision, runtime.contractRevision);
  assert.equal(discovery.headers.get("x-clank-contract-revision"), runtime.contractRevision);
  assert.equal(JSON.stringify(manifest).includes("todos.add"), false);

  const serverCard = await runtime.handle(new Request(`${origin}/.well-known/mcp/server-card.json`));
  assert.equal(serverCard.status, 200);
  const serverCardPayload = await serverCard.json();
  assert.equal(serverCardPayload.tools[0], "dynamic");
  assert.equal(serverCardPayload.contractRevision, runtime.contractRevision);
  assert.equal(serverCardPayload.capabilities.tools.listChanged, true);
  assert.match(serverCardPayload.serverInfo.version, /\+clank\.[a-f0-9]{16}$/u);

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

test("standard public-client OAuth works without the Clank CLI or control plane", async () => {
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
  const mcpSession = initialized.headers.get("mcp-session-id");
  assert.match(mcpSession, /^clank_session_[a-f0-9]{48}$/u);
  assert.equal((await initialized.json()).result.serverInfo.name, "clank-app");

  const staleStatelessList = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, tokens.access_token));
  assert.equal(staleStatelessList.status, 400);
  assert.equal((await staleStatelessList.json()).error.data.reason, "SESSION_REQUIRED");

  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {},
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  const tools = (await listed.json()).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["todos.add", "todos.list", "todos.removeAll"]);
  const backendManifest = await runtime.handle(new Request(`${origin}/__clank/manifest`));
  const backendFunctions = (await backendManifest.json()).functions
    .filter((fn) => fn.agent)
    .map((fn) => fn.name)
    .sort();
  assert.deepEqual(tools.map((tool) => tool.name), backendFunctions);
  assert.equal(tools.find((tool) => tool.name === "todos.add").annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === "todos.removeAll").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "todos.list").annotations.readOnlyHint, true);

  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "todos.add", arguments: { title: "Created by an agent" } },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.equal(added.status, 200);
  assert.equal((await added.json()).result.isError, false);

  const listedTodos = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "todos.list", arguments: {} },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
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
  const initialized = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "read-only-test-client", version: "1.0.0" },
    },
  }, tokens.access_token));
  const mcpSession = initialized.headers.get("mcp-session-id");
  assert.match(mcpSession, /^clank_session_[a-f0-9]{48}$/u);
  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["todos.list"]);
  const write = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "todos.add", arguments: { title: "No" } },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
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
  const initialized = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "public-test-client", version: "1.0.0" },
    },
  }));
  const mcpSession = initialized.headers.get("mcp-session-id");
  assert.match(mcpSession, /^clank_session_[a-f0-9]{48}$/u);
  const listed = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, undefined, { "mcp-session-id": mcpSession }));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["notes.add", "notes.list"]);
  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "notes.add", arguments: { title: "Public MCP" } },
  }, undefined, { "mcp-session-id": mcpSession }));
  assert.equal((await added.json()).result.isError, false);
  assert.equal(runtime.query("notes.list", {}).value[0].title, "Public MCP");
  runtime.close();
});
