import test from "node:test";
import assert from "node:assert/strict";
import {
  BackendActionError,
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  createMcpServer,
  defineMcpApp,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION_ID,
  openBackend,
  portableMcpToolNames,
  s,
} from "../dist/index.js";

const mcpAppsCapabilities = {
  extensions: {
    [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
  },
};

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

function modernMcpRequest(payload, token, headers = {}) {
  const method = payload.method;
  const params = {
    ...(payload.params ?? {}),
    _meta: {
      ...payload.params?._meta,
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "clank-modern-test",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const name = method === "resources/read"
    ? params.uri
    : method === "tools/call" || method === "prompts/get"
      ? params.name
      : undefined;
  return new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ ...payload, params }),
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

async function approveAuthorization(runtime, session, client, scopes = "agent:read agent:write") {
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
  assert.equal(callback.searchParams.get("iss"), origin);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  return { code, verifier };
}

async function authorize(runtime, session, client, scopes = "agent:read agent:write") {
  const approved = await approveAuthorization(runtime, session, client, scopes);
  const token = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: approved.code,
    redirect_uri: client.redirect_uris[0],
    code_verifier: approved.verifier,
    resource,
  }));
  assert.equal(token.status, 200);
  return { ...(await token.json()), ...approved };
}

test("OAuth-protected MCP supports credential-free remote browser clients", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: { name: "browser-private-todo", title: "Browser Private Todo" },
  });
  const browserOrigin = "https://app.mcpjam.com";
  try {
    const mcpPreflight = await runtime.handle(new Request(resource, {
      method: "OPTIONS",
      headers: {
        origin: browserOrigin,
        "sec-fetch-site": "cross-site",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, mcp-protocol-version, mcp-method, mcp-param-region",
      },
    }));
    assert.equal(mcpPreflight.status, 204);
    assert.equal(mcpPreflight.headers.get("access-control-allow-origin"), "*");
    assert.match(mcpPreflight.headers.get("access-control-allow-methods"), /POST/u);
    assert.match(mcpPreflight.headers.get("access-control-allow-headers"), /authorization/u);
    assert.match(mcpPreflight.headers.get("access-control-allow-headers"), /mcp-param-region/u);
    assert.equal(mcpPreflight.headers.get("access-control-allow-credentials"), null);

    const unsafePreflight = await runtime.handle(new Request(resource, {
      method: "OPTIONS",
      headers: {
        origin: browserOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-clank-internal-authority",
      },
    }));
    assert.equal(unsafePreflight.status, 400);
    assert.equal(unsafePreflight.headers.get("access-control-allow-origin"), "*");

    const challenged = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "remote-browser", version: "1.0.0" },
      },
    }, undefined, {
      origin: browserOrigin,
      "sec-fetch-site": "cross-site",
    }));
    assert.equal(challenged.status, 401);
    assert.equal(challenged.headers.get("access-control-allow-origin"), "*");
    assert.match(challenged.headers.get("access-control-expose-headers"), /www-authenticate/u);
    assert.match(challenged.headers.get("www-authenticate"), /resource_metadata=/u);

    for (const path of ["/__clank/oauth/register", "/__clank/oauth/token"]) {
      const oauthPreflight = await runtime.handle(new Request(`${origin}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: browserOrigin,
          "sec-fetch-site": "cross-site",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }));
      assert.equal(oauthPreflight.status, 204);
      assert.equal(oauthPreflight.headers.get("access-control-allow-origin"), "*");
      assert.equal(oauthPreflight.headers.get("access-control-allow-credentials"), null);
    }

    const registered = await runtime.handle(jsonRequest("/__clank/oauth/register", {
      client_name: "Browser hosted client",
      application_type: "web",
      redirect_uris: ["https://app.mcpjam.com/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, {
      origin: browserOrigin,
      "sec-fetch-site": "cross-site",
    }));
    assert.equal(registered.status, 201);
    assert.equal(registered.headers.get("access-control-allow-origin"), "*");
  } finally {
    runtime.close();
  }
});

test("public MCP keeps cross-origin browser mutations opt-in", async () => {
  const definition = defineBackend({
    schema: defineDatabase({ values: defineTable({ value: s.string() }) }),
  }).functions(({ mutation }) => ({
    add: mutation({
      description: "Add a value.",
      args: { value: s.string() },
      handler: ({ db }, { value }) => db.table("values").insert({ value }),
    }),
  }));
  const request = () => mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "remote-public-browser", version: "1.0.0" },
    },
  }, undefined, {
    origin: "https://app.mcpjam.com",
    "sec-fetch-site": "cross-site",
  });

  const protectedRuntime = await openBackend(definition, { path: ":memory:" });
  try {
    assert.equal((await protectedRuntime.handle(request())).status, 403);
  } finally {
    protectedRuntime.close();
  }

  const optedInRuntime = await openBackend(definition, {
    path: ":memory:",
    agent: { browserCors: true },
  });
  try {
    const response = await optedInRuntime.handle(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    optedInRuntime.close();
  }
});

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
  const existingSession = await registerUser(runtime);
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
  const firstEntry = await runtime.handle(new Request(`${origin}${authorizeUrl}`));
  assert.equal(firstEntry.status, 200);
  const firstEntryHtml = await firstEntry.text();
  assert.match(firstEntryHtml, /Checking sign-in/u);
  assert.match(firstEntryHtml, /http-equiv="refresh"/u);
  assert.match(firstEntryHtml, /clank_login_recheck=1/u);

  const recheckUrl = `${authorizeUrl}&clank_login_recheck=1`;
  const recoveredSession = await runtime.handle(new Request(`${origin}${recheckUrl}`, {
    headers: { cookie: existingSession.cookie },
  }));
  assert.equal(recoveredSession.status, 200);
  assert.match(await recoveredSession.text(), /Connect Test MCP client/u);

  const signIn = await runtime.handle(new Request(`${origin}${recheckUrl}`));
  assert.equal(signIn.status, 200);
  const signInHtml = await signIn.text();
  assert.match(signInHtml, /Sign in and continue/u);
  assert.match(signInHtml, /action="\/__clank\/auth\/login"/u);
  assert.doesNotMatch(signInHtml, /I’m signed in — continue/u);
  const returnTo = hiddenInput(signInHtml, "return_to");
  const loginProof = hiddenInput(signInHtml, "login_proof");
  const loginProofCookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  assert.match(loginProof, /^clank_login_[A-Za-z0-9_-]+$/u);
  assert.match(loginProofCookie, /^__Host-clank-login-proof=/u);
  assert.match(signIn.headers.get("set-cookie"), /SameSite=None/u);
  assert.equal(returnTo, authorizeUrl.replaceAll("&", "&amp;"));
  const decodedReturnTo = returnTo.replaceAll("&amp;", "&");

  const crossOrigin = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
  }, { origin: "https://attacker.test", "sec-fetch-site": "cross-site" }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("set-cookie"), null);

  const opaqueNavigation = {
    origin: "null",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  for (const unsafeHeaders of [
    { ...opaqueNavigation, "sec-fetch-site": "cross-site" },
    { ...opaqueNavigation, "sec-fetch-mode": "cors" },
    { ...opaqueNavigation, "sec-fetch-dest": "iframe" },
    { ...opaqueNavigation, "sec-fetch-user": "?0" },
  ]) {
    const unsafe = await runtime.handle(formRequest("/__clank/auth/login", {
      email: "agent@example.com",
      password: "correct horse battery staple",
      return_to: decodedReturnTo,
    }, unsafeHeaders));
    assert.equal(unsafe.status, 403);
    assert.equal(unsafe.headers.get("set-cookie"), null);
  }

  const forgedProof = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
    login_proof: `clank_login_${"A".repeat(32)}`,
  }, { cookie: loginProofCookie, origin: "null" }));
  assert.equal(forgedProof.status, 403);

  const wrongBrowser = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
    login_proof: loginProof,
  }, { cookie: "__Host-clank-login-proof=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", origin: "null" }));
  assert.equal(wrongBrowser.status, 403);

  const changedReturn = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: `${decodedReturnTo}&auth_error=changed`,
    login_proof: loginProof,
  }, { cookie: loginProofCookie, origin: "null" }));
  assert.equal(changedReturn.status, 403);

  const opaqueLogin = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
    login_proof: loginProof,
  }, { cookie: loginProofCookie, origin: "null" }));
  assert.equal(opaqueLogin.status, 303);
  assert.equal(opaqueLogin.headers.get("location"), `${origin}${authorizeUrl}`);
  assert.match(opaqueLogin.headers.get("set-cookie"), /^__Host-clank-id=/);

  const replayedProof = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: decodedReturnTo,
    login_proof: loginProof,
  }, { cookie: loginProofCookie, origin: "null" }));
  assert.equal(replayedProof.status, 403);
  assert.equal(replayedProof.headers.get("set-cookie"), null);

  const opaqueJson = await runtime.handle(jsonRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
  }, opaqueNavigation));
  assert.equal(opaqueJson.status, 403);
  assert.equal(opaqueJson.headers.get("set-cookie"), null);

  const openRedirect = await runtime.handle(formRequest("/__clank/auth/login", {
    email: "agent@example.com",
    password: "correct horse battery staple",
    return_to: "https://attacker.test/callback",
  }, opaqueNavigation));
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
  const workflowMetadata = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    metadata: { workflows: [{ name: "releases.publish", steps: ["build", "publish"] }] },
    tools: [testTool("cards.list"), testTool("cards.move")],
  });
  const equivalentWorkflowMetadata = createMcpServer({
    name: "contract-test",
    version: "2.0.0",
    metadata: { workflows: [{ steps: ["build", "publish"], name: "releases.publish" }] },
    tools: [testTool("cards.move"), testTool("cards.list")],
  });

  assert.match(first.revision, /^mcp-[a-f0-9]{32}$/u);
  assert.equal(first.revision, equivalent.revision);
  assert.notEqual(first.revision, renamed.revision);
  assert.notEqual(first.revision, added.revision);
  assert.notEqual(first.revision, metadataChanged.revision);
  assert.notEqual(first.revision, workflowMetadata.revision);
  assert.equal(workflowMetadata.revision, equivalentWorkflowMetadata.revision);
  assert.deepEqual(workflowMetadata.manifest().metadata, {
    workflows: [{ name: "releases.publish", steps: ["build", "publish"] }],
  });
  assert.ok(Object.isFrozen(workflowMetadata.manifest().metadata.workflows));
  assert.throws(() => createMcpServer({
    name: "contract-test",
    metadata: { oversized: "x".repeat(262_145) },
    tools: [],
  }), /metadata exceeds 262144 bytes/);
  assert.equal(first.manifest().revision, first.revision);
  assert.match(first.manifest().server.version, /^2\.0\.0\+clank\.[a-f0-9]{16}$/u);

  first.close();
  equivalent.close();
  renamed.close();
  added.close();
  metadataChanged.close();
  workflowMetadata.close();
  equivalentWorkflowMetadata.close();
});

test("MCP tool names use portable underscore identifiers with bounded collision suffixes", async () => {
  const logicalNames = [
    "dailyLog.getDailyUpdate",
    "dailyLog-getDailyUpdate",
    "dailyLog_getDailyUpdate",
    `dailyLog.${"readRecentUpdates".repeat(6)}`,
  ];
  const portable = portableMcpToolNames(logicalNames);
  assert.equal(portable.length, logicalNames.length);
  assert.equal(new Set(portable).size, logicalNames.length);
  assert.ok(portable.every((name) => /^[A-Za-z0-9_]{1,64}$/u.test(name)));
  assert.ok(portable.every((name) => !name.includes("-") && !name.includes(".")));

  const ordinary = portableMcpToolNames([
    "dailyLog.getDailyUpdate",
    "dailyLog.getDay",
    "dailyLog.listRecent",
  ]);
  assert.deepEqual(ordinary, [
    "dailyLog_getDailyUpdate",
    "dailyLog_getDay",
    "dailyLog_listRecent",
  ]);

  const server = createMcpServer({
    name: "portable-tools",
    tools: logicalNames.map((name) => testTool(name)),
  });
  const descriptors = server.manifest().tools;
  assert.deepEqual(
    new Set(descriptors.map((tool) => tool.actionPath)),
    new Set(logicalNames),
  );
  assert.ok(descriptors.every((tool) => /^[A-Za-z0-9_]{1,64}$/u.test(tool.name)));
  server.close();
});

test("MCP Apps preserve model-visible ui metadata and expose negotiated app-only tools", async () => {
  const board = defineMcpApp({
    uri: "ui://todos/board",
    name: "todo_board",
    title: "Todo board",
    description: "Interactive todo board.",
    html: "<!doctype html><html><head><title>Todos</title></head><body><main id=app></main></body></html>",
    csp: {
      connectDomains: ["https://api.example.com", "ws://localhost:8787"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: [],
      baseUriDomains: [],
    },
    permissions: { clipboardWrite: {} },
    domain: "todos.claudemcpcontent.com",
    prefersBorder: true,
  });
  const server = createMcpServer({
    name: "mcp-apps-test",
    apps: [board],
    tools: [
      testTool("todos.list", {
        app: { resourceUri: board.uri, visibility: ["model", "app"] },
      }),
      testTool("todos.refresh", {
        app: { resourceUri: board.uri, visibility: ["app"] },
      }),
    ],
  });

  const initialize = async (capabilities) => {
    const response = await server.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities,
        clientInfo: { name: "mcp-apps-test", version: "1.0.0" },
      },
    }));
    assert.equal(response.status, 200);
    return response.headers.get("mcp-session-id");
  };
  const call = async (session, method, params = {}) => {
    const response = await server.handle(mcpRequest({ jsonrpc: "2.0", id: 2, method, params }, undefined, {
      "mcp-session-id": session,
    }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };

  const appSession = await initialize(mcpAppsCapabilities);
  const listed = await call(appSession, "tools/list");
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["todos_list", "todos_refresh"]);
  assert.deepEqual(listed.tools[0]._meta.ui, {
    resourceUri: board.uri,
    visibility: ["model", "app"],
  });
  assert.deepEqual(listed.tools[1]._meta.ui.visibility, ["app"]);

  const resources = await call(appSession, "resources/list");
  const listedApp = resources.resources.find((entry) => entry.uri === board.uri);
  assert.equal(listedApp.mimeType, MCP_APP_MIME_TYPE);
  assert.equal(listedApp._meta.ui.prefersBorder, true);
  assert.deepEqual(listedApp._meta.ui.permissions, { clipboardWrite: {} });
  const resource = await call(appSession, "resources/read", { uri: board.uri });
  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0].mimeType, MCP_APP_MIME_TYPE);
  assert.equal(resource.contents[0].text, board.html);
  assert.deepEqual(resource.contents[0]._meta.ui.csp, board.csp);

  const plainSession = await initialize({});
  const plainTools = await call(plainSession, "tools/list");
  assert.deepEqual(plainTools.tools.map((tool) => tool.name), ["todos_list"]);
  assert.deepEqual(plainTools.tools[0]._meta.ui, {
    resourceUri: board.uri,
    visibility: ["model", "app"],
  });
  const hiddenCall = await call(plainSession, "tools/call", {
    name: "todos_refresh",
    arguments: { value: "hidden" },
  });
  assert.equal(hiddenCall, undefined);

  assert.equal(server.apps.get(board.uri), board);
  assert.equal(server.manifest().apps[0].mimeType, MCP_APP_MIME_TYPE);
  assert.equal(server.manifest().tools[0].app.resourceUri, board.uri);
  server.close();
});

test("MCP App declarations fail closed for unsafe or stale contracts", () => {
  const html = "<!doctype html><html><body>Safe</body></html>";
  assert.throws(() => defineMcpApp(null), /object/u);
  assert.throws(() => defineMcpApp({ uri: "https://bad.test/view", name: "bad", html }), /ui:\/\//u);
  assert.throws(() => defineMcpApp({ uri: "ui://bad/extra", name: "bad", html, unexpected: true }), /unsupported field/u);
  assert.throws(() => defineMcpApp({ uri: "ui://bad/view", name: "bad", html: "<main>fragment</main>" }), /HTML5 document/u);
  assert.throws(() => defineMcpApp({
    uri: "ui://bad/csp",
    name: "bad",
    html,
    csp: { connectDomains: ["https://good.test/path"] },
  }), /invalid origin|secure origins/u);
  for (const origin of [
    "https://user@good.test",
    "https://good.test:99999",
    "http://example.test",
    "wss://*.example.test/path",
  ]) {
    assert.throws(() => defineMcpApp({
      uri: `ui://bad/csp-${encodeURIComponent(origin)}`,
      name: "bad",
      html,
      csp: { connectDomains: [origin] },
    }), /invalid origin|secure origins/u);
  }
  assert.throws(() => defineMcpApp({
    uri: "ui://bad/permissions",
    name: "bad",
    html,
    permissions: { camera: { unexpected: true } },
  }), /empty object/u);
  assert.throws(() => createMcpServer({
    name: "missing-app",
    tools: [testTool("todos.list", { app: { resourceUri: "ui://missing/view" } })],
  }), /unknown app resource/u);
  const app = defineMcpApp({ uri: "ui://safe/view", name: "safe", html });
  assert.throws(() => createMcpServer({
    name: "bad-visibility",
    apps: [app],
    tools: [testTool("todos.list", { app: { resourceUri: app.uri, visibility: [] } })],
  }), /visibility/u);
  assert.throws(() => createMcpServer({
    name: "bad-app-metadata",
    apps: [app],
    tools: [testTool("todos.list", { app: { resourceUri: app.uri, extra: true } })],
  }), /unsupported field/u);

  const first = createMcpServer({ name: "revision-app", apps: [app], tools: [] });
  const changed = createMcpServer({
    name: "revision-app",
    apps: [defineMcpApp({ ...app, html: "<!doctype html><html><body>Changed</body></html>" })],
    tools: [],
  });
  assert.notEqual(first.revision, changed.revision);
  first.close();
  changed.close();
});

test("MCP 2026-07-28 discovers and invokes tools without process-local sessions", async () => {
  const invoked = [];
  const options = {
    name: "stateless-app",
    title: "Stateless app",
    instructions: "Use the typed application actions.",
    tools: [testTool("todos.echo", {
      invoke: ({ value }) => {
        invoked.push(value);
        return { value };
      },
    })],
  };
  const firstInstance = createMcpServer(options);
  const secondInstance = createMcpServer(options);

  const discovered = await firstInstance.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: {},
  }));
  assert.equal(discovered.status, 200);
  assert.equal(discovered.headers.get("mcp-session-id"), null);
  const discovery = (await discovered.json()).result;
  assert.equal(discovery.resultType, "complete");
  assert.equal(discovery.supportedVersions[0], "2026-07-28");
  assert.ok(discovery.supportedVersions.includes("2025-11-25"));
  assert.deepEqual(discovery.capabilities.tools, {});
  assert.equal(discovery.ttlMs, 0);
  assert.equal(discovery.cacheScope, "private");
  assert.equal(discovery._meta["io.modelcontextprotocol/serverInfo"].name, "stateless-app");

  const listed = await firstInstance.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }));
  const listResult = (await listed.json()).result;
  assert.equal(listResult.resultType, "complete");
  assert.deepEqual(listResult.tools.map((tool) => tool.name), ["todos_echo"]);
  assert.equal(listResult.tools[0]._meta["clank/actionPath"], "todos.echo");
  assert.equal(listResult._meta["clank/contractRevision"], firstInstance.revision);
  assert.equal(listResult._meta["io.modelcontextprotocol/serverInfo"].name, "stateless-app");

  const called = await secondInstance.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "todos_echo", arguments: { value: "cross-instance" } },
  }, undefined, {
    "mcp-session-id": "legacy-session-is-ignored",
    "last-event-id": "also-ignored",
  }));
  assert.equal(called.status, 200);
  assert.equal(called.headers.get("mcp-session-id"), null);
  const callResult = (await called.json()).result;
  assert.equal(callResult.resultType, "complete");
  assert.deepEqual(callResult.structuredContent, { value: "cross-instance" });
  assert.deepEqual(invoked, ["cross-instance"]);

  for (const method of ["GET", "DELETE"]) {
    const response = await firstInstance.handle(new Request(resource, {
      method,
      headers: { "mcp-protocol-version": "2026-07-28" },
    }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
  const extensionNotification = await firstInstance.handle(new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/example" }),
  }));
  assert.equal(extensionNotification.status, 202);
  firstInstance.close();
  secondInstance.close();
});

test("MCP 2026-07-28 rejects header smuggling and unsupported revisions before tool execution", async () => {
  let calls = 0;
  const server = createMcpServer({
    name: "header-validation",
    tools: [testTool("safe.echo", { invoke: () => { calls++; return { ok: true }; } })],
  });
  const base = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "safe_echo", arguments: { value: "test" } },
  };
  const cases = [
    { headers: { "mcp-method": "tools/list" }, message: /Mcp-Method/u },
    { headers: { "mcp-name": "unsafe_echo" }, message: /Mcp-Name/u },
    { headers: { "mcp-protocol-version": "2025-11-25" }, message: /MCP-Protocol-Version/u },
  ];
  for (const entry of cases) {
    const response = await server.handle(modernMcpRequest(base, undefined, entry.headers));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, -32020);
    assert.match(payload.error.message, entry.message);
  }
  assert.equal(calls, 0);

  const unsupportedBody = JSON.parse(await modernMcpRequest(base).text());
  unsupportedBody.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
  const matchingUnsupported = await server.handle(new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2099-01-01",
      "mcp-method": "tools/call",
      "mcp-name": "safe_echo",
    },
    body: JSON.stringify(unsupportedBody),
  }));
  assert.equal(matchingUnsupported.status, 400);
  const matchingPayload = await matchingUnsupported.json();
  assert.equal(matchingPayload.error.code, -32022);
  assert.equal(matchingPayload.error.data.requested, "2099-01-01");
  assert.ok(matchingPayload.error.data.supported.includes("2026-07-28"));
  assert.equal(calls, 0);

  const missingMeta = await server.handle(new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }));
  assert.equal(missingMeta.status, 400);
  assert.equal((await missingMeta.json()).error.code, -32602);

  const removedPing = await server.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "ping",
    params: {},
  }));
  assert.equal(removedPing.status, 404);
  assert.equal((await removedPing.json()).error.code, -32601);
  server.close();
});

test("MCP 2026-07-28 validates schema-declared parameter headers", async () => {
  const received = [];
  const server = createMcpServer({
    name: "parameter-headers",
    tools: [{
      name: "search",
      description: "Search in a selected region.",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          enabled: { type: "boolean", "x-mcp-header": "Enabled" },
          limit: { type: "integer", "x-mcp-header": "Limit" },
        },
        required: ["region", "enabled", "limit"],
      },
      invoke: (input) => { received.push(input); return input; },
    }],
  });
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search", arguments: { region: "north", enabled: true, limit: 42 } },
  };
  const missing = await server.handle(modernMcpRequest(request));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, -32020);
  assert.equal(received.length, 0);

  const mismatch = await server.handle(modernMcpRequest(request, undefined, {
    "mcp-param-region": "south",
    "mcp-param-enabled": "true",
    "mcp-param-limit": "42.0",
  }));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, -32020);
  assert.equal(received.length, 0);

  const called = await server.handle(modernMcpRequest(request, undefined, {
    "mcp-param-region": "north",
    "mcp-param-enabled": "true",
    "mcp-param-limit": "42.0",
  }));
  assert.equal(called.status, 200);
  assert.deepEqual(received, [{ region: "north", enabled: true, limit: 42 }]);
  server.close();

  assert.throws(() => createMcpServer({
    name: "invalid-parameter-header",
    tools: [testTool("bad", {
      inputSchema: {
        type: "object",
        properties: { value: { type: "number", "x-mcp-header": "Value" } },
      },
    })],
  }), /invalid x-mcp-header/u);
  assert.throws(() => createMcpServer({
    name: "unreachable-parameter-header",
    tools: [testTool("bad", {
      inputSchema: {
        type: "object",
        properties: {
          value: {
            oneOf: [{ type: "string", "x-mcp-header": "Value" }],
          },
        },
      },
    })],
  }), /invalid x-mcp-header/u);
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
    "todos_add",
    "todos_list",
    "todos_remove",
    "todos_setDone",
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
    "cards_add",
    "cards_list",
    "cards_move",
    "cards_remove",
    "columns_add",
    "columns_list",
    "columns_rename",
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
  assert.equal(manifest.mcp.accessManagement, `${origin}/__clank/oauth/access`);
  assert.equal(manifest.contractRevision, runtime.contractRevision);
  assert.equal(discovery.headers.get("x-clank-contract-revision"), runtime.contractRevision);
  assert.equal(JSON.stringify(manifest).includes("todos.add"), false);

  const serverCard = await runtime.handle(new Request(`${origin}/.well-known/mcp/server-card.json`));
  assert.equal(serverCard.status, 200);
  const serverCardPayload = await serverCard.json();
  assert.equal(serverCardPayload.tools[0], "dynamic");
  assert.equal(serverCardPayload.contractRevision, runtime.contractRevision);
  assert.deepEqual(serverCardPayload.capabilities.tools, {});
  assert.match(serverCardPayload.serverInfo.version, /\+clank\.[a-f0-9]{16}$/u);

  const protectedMetadata = await runtime.handle(new Request(
    `${origin}/.well-known/oauth-protected-resource/__clank/mcp`,
  ));
  const protectedPayload = await protectedMetadata.json();
  assert.deepEqual(protectedPayload.authorization_servers, [origin]);
  assert.equal(protectedPayload.clank_agent_access_url, `${origin}/__clank/oauth/access`);
  const authorizationMetadata = await runtime.handle(new Request(
    `${origin}/.well-known/oauth-authorization-server`,
  ));
  const authorization = await authorizationMetadata.json();
  assert.equal(authorization.code_challenge_methods_supported[0], "S256");
  assert.ok(authorization.grant_types_supported.includes("refresh_token"));
  assert.equal(authorization.authorization_response_iss_parameter_supported, true);

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

test("backend actions bind shared MCP Apps views without manual resource plumbing", async () => {
  const dashboard = defineMcpApp({
    uri: "ui://reports/dashboard",
    name: "report_dashboard",
    html: "<!doctype html><html><body><main id=dashboard></main></body></html>",
    prefersBorder: false,
  });
  const schema = defineDatabase({
    reports: defineTable({ title: s.string() }),
  });
  const definition = defineBackend({ schema }).functions(({ query }) => ({
    reports: {
      summary: query({
        args: {},
        returns: s.object({ total: s.number() }),
        agent: { app: dashboard },
        handler: ({ db }) => ({ total: db.table("reports").collect().length }),
      }),
      refresh: query({
        args: {},
        agent: { app: { resource: dashboard, visibility: ["app"] } },
        handler: () => ({ refreshed: true }),
      }),
    },
  }));
  const runtime = await openBackend(definition, { path: ":memory:" });
  try {
    const discovery = await runtime.handle(new Request(`${origin}/.well-known/clank`));
    const discoveryPayload = await discovery.json();
    const extension = discoveryPayload.mcp.extensions[MCP_APPS_EXTENSION_ID];
    assert.equal(extension.protocolVersion, "2026-01-26");
    assert.deepEqual(extension.mimeTypes, [MCP_APP_MIME_TYPE]);
    assert.deepEqual(extension.resources, [dashboard.uri]);

    const initialized = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: mcpAppsCapabilities,
        clientInfo: { name: "backend-app-test", version: "1.0.0" },
      },
    }));
    assert.equal(initialized.status, 200);
    const session = initialized.headers.get("mcp-session-id");
    const listed = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, undefined, { "mcp-session-id": session }));
    const tools = (await listed.json()).result.tools;
    assert.equal(tools.find((tool) => tool.name === "reports_summary")._meta.ui.resourceUri, dashboard.uri);
    assert.deepEqual(tools.find((tool) => tool.name === "reports_refresh")._meta.ui.visibility, ["app"]);

    const read = await runtime.handle(mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: dashboard.uri },
    }, undefined, { "mcp-session-id": session }));
    const content = (await read.json()).result.contents[0];
    assert.equal(content.text, dashboard.html);
    assert.equal(content._meta.ui.prefersBorder, false);

    const statelessPlain = await runtime.handle(modernMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {},
    }));
    assert.equal(statelessPlain.status, 200);
    const statelessTools = (await statelessPlain.json()).result.tools;
    assert.deepEqual(statelessTools.map((tool) => tool.name), ["reports_summary"]);
    assert.equal(statelessTools[0]._meta.ui.resourceUri, dashboard.uri);
  } finally {
    runtime.close();
  }
});

test("concurrent refresh retries converge on one rotated token pair", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  try {
    const session = await registerUser(runtime);
    const client = await registerClient(runtime);
    const tokens = await authorize(runtime, session, client);
    const refresh = () => runtime.handle(formRequest("/__clank/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }));
    const responses = await Promise.all([refresh(), refresh()]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const pairs = await Promise.all(responses.map((response) => response.json()));
    assert.equal(pairs[0].access_token, pairs[1].access_token);
    assert.equal(pairs[0].refresh_token, pairs[1].refresh_token);
    assert.equal(pairs[0].scope, pairs[1].scope);
    assert.ok(Math.abs(pairs[0].expires_in - pairs[1].expires_in) <= 1);
    assert.notEqual(pairs[0].refresh_token, tokens.refresh_token);

    const authenticated = await runtime.handle(modernMcpRequest({
      jsonrpc: "2.0",
      id: "retry-authenticated",
      method: "tools/list",
      params: {},
    }, pairs[0].access_token));
    assert.equal(authenticated.status, 200);
  } finally {
    runtime.close();
  }
});

test("delayed refresh retries report the successor access token's remaining lifetime", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const originalNow = Date.now;
  try {
    const session = await registerUser(runtime);
    const client = await registerClient(runtime);
    const tokens = await authorize(runtime, session, client);
    let now = originalNow();
    Date.now = () => now;
    const refresh = () => runtime.handle(formRequest("/__clank/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }));
    const first = await refresh();
    assert.equal(first.status, 200);
    const firstPair = await first.json();

    now += 12 * 60 * 1_000;
    const retried = await refresh();
    assert.equal(retried.status, 200);
    const retriedPair = await retried.json();
    assert.equal(retriedPair.access_token, firstPair.access_token);
    assert.equal(retriedPair.refresh_token, firstPair.refresh_token);
    assert.equal(retriedPair.expires_in, firstPair.expires_in - 12 * 60);
  } finally {
    Date.now = originalNow;
    runtime.close();
  }
});

test("adaptive refresh recovery keeps clients connected when they fail to persist rotation", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const originalNow = Date.now;
  try {
    const session = await registerUser(runtime);
    const client = await registerClient(runtime);
    const tokens = await authorize(runtime, session, client);
    let now = originalNow();
    Date.now = () => now;
    const refreshOriginal = () => runtime.handle(formRequest("/__clank/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }));

    const firstResponse = await refreshOriginal();
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();

    now += 61 * 60 * 1_000;
    const concurrentRecovery = await Promise.all([refreshOriginal(), refreshOriginal()]);
    assert.deepEqual(concurrentRecovery.map((response) => response.status), [200, 200]);
    const [recovered, concurrentRetry] = await Promise.all(
      concurrentRecovery.map((response) => response.json()),
    );
    assert.notEqual(recovered.access_token, first.access_token);
    assert.equal(recovered.refresh_token, first.refresh_token);
    assert.equal(recovered.expires_in, 60 * 60);
    assert.equal(concurrentRetry.access_token, recovered.access_token);
    assert.equal(concurrentRetry.refresh_token, recovered.refresh_token);

    const immediateRetryResponse = await refreshOriginal();
    assert.equal(immediateRetryResponse.status, 200);
    const immediateRetry = await immediateRetryResponse.json();
    assert.equal(immediateRetry.access_token, recovered.access_token);
    assert.equal(immediateRetry.refresh_token, recovered.refresh_token);

    now += 61 * 60 * 1_000;
    const recoveredAgainResponse = await refreshOriginal();
    assert.equal(recoveredAgainResponse.status, 200);
    const recoveredAgain = await recoveredAgainResponse.json();
    assert.notEqual(recoveredAgain.access_token, recovered.access_token);
    assert.equal(recoveredAgain.refresh_token, first.refresh_token);

    const authenticated = await runtime.handle(modernMcpRequest({
      jsonrpc: "2.0",
      id: "adaptive-recovery-authenticated",
      method: "tools/list",
      params: {},
    }, recoveredAgain.access_token));
    assert.equal(authenticated.status, 200);

    const adoptedResponse = await runtime.handle(formRequest("/__clank/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: first.refresh_token,
      resource,
    }));
    assert.equal(adoptedResponse.status, 200);
    const adopted = await adoptedResponse.json();

    const staleReplay = await refreshOriginal();
    assert.equal(staleReplay.status, 400);
    assert.equal((await staleReplay.json()).error_description, "Refresh token reuse was detected.");
    const revoked = await runtime.handle(modernMcpRequest({
      jsonrpc: "2.0",
      id: "adaptive-recovery-revoked",
      method: "tools/list",
      params: {},
    }, adopted.access_token));
    assert.equal(revoked.status, 401);
  } finally {
    Date.now = originalNow;
    runtime.close();
  }
});

test("strict refresh rotation revokes predecessors after the retry window", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: { refreshTokenRotationMode: "strict" },
  });
  const originalNow = Date.now;
  try {
    const session = await registerUser(runtime);
    const client = await registerClient(runtime);
    const tokens = await authorize(runtime, session, client);
    let now = originalNow();
    Date.now = () => now;
    const refresh = () => runtime.handle(formRequest("/__clank/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }));
    assert.equal((await refresh()).status, 200);
    now += 61 * 60 * 1_000;
    const stale = await refresh();
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error_description, "Refresh token reuse was detected.");
  } finally {
    Date.now = originalNow;
    runtime.close();
  }
});

test("standard public-client OAuth works without the Clank CLI or control plane", async () => {
  const runtime = await openBackend(authenticatedBackend(), { path: ":memory:" });
  const session = await registerUser(runtime);
  const client = await registerClient(runtime);
  assert.equal(client.application_type, "native");
  const tokens = await authorize(runtime, session, client);

  const statelessDiscovery = await runtime.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: {},
  }, tokens.access_token));
  assert.equal(statelessDiscovery.status, 200);
  assert.equal(statelessDiscovery.headers.get("mcp-session-id"), null);
  assert.equal((await statelessDiscovery.json()).result.supportedVersions[0], "2026-07-28");
  const statelessTools = await runtime.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: "list",
    method: "tools/list",
    params: {},
  }, tokens.access_token));
  assert.deepEqual(
    (await statelessTools.json()).result.tools.map((tool) => tool.name),
    ["todos_add", "todos_list", "todos_removeAll"],
  );

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
  assert.deepEqual(tools.map((tool) => tool.name), ["todos_add", "todos_list", "todos_removeAll"]);
  const backendManifest = await runtime.handle(new Request(`${origin}/__clank/manifest`));
  const backendFunctions = (await backendManifest.json()).functions
    .filter((fn) => fn.agent)
    .map((fn) => fn.name)
    .sort();
  assert.deepEqual(
    tools.map((tool) => tool._meta["clank/actionPath"]),
    backendFunctions,
  );
  assert.equal(tools.find((tool) => tool.name === "todos_add").annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === "todos_removeAll").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "todos_list").annotations.readOnlyHint, true);

  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "todos_add", arguments: { title: "Created by an agent" } },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.equal(added.status, 200);
  assert.equal((await added.json()).result.isError, false);

  const listedTodos = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "todos_list", arguments: {} },
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
  assert.equal(refreshReplay.status, 200);
  const replayedTokens = await refreshReplay.json();
  assert.equal(replayedTokens.access_token, nextTokens.access_token);
  assert.equal(replayedTokens.refresh_token, nextTokens.refresh_token);
  assert.equal(replayedTokens.scope, nextTokens.scope);
  const advanced = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: nextTokens.refresh_token,
    resource,
  }));
  assert.equal(advanced.status, 200);
  const advancedTokens = await advanced.json();
  const staleReplay = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  }));
  assert.equal(staleReplay.status, 400);
  assert.equal((await staleReplay.json()).error_description, "Refresh token reuse was detected.");
  const revokedFamily = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  }, advancedTokens.access_token));
  assert.equal(revokedFamily.status, 401);
  const replacement = await authorize(runtime, session, client);

  const crossOrigin = await runtime.handle(modernMcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
    params: {},
  }, replacement.access_token, {
    origin: "https://hosted-client.test",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(crossOrigin.status, 200);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), "*");

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
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["todos_list"]);
  const write = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "todos_add", arguments: { title: "No" } },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, "insufficient_scope");
  runtime.close();
});

test("agent access inbox isolates, reduces, and revokes active OAuth grants immediately", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: { title: "Private Todo" },
  });
  const owner = await registerUser(runtime);
  const client = await registerClient(runtime);
  const tokens = await authorize(runtime, owner, client);

  const metadata = await runtime.handle(new Request(`${origin}/.well-known/oauth-authorization-server`));
  const metadataPayload = await metadata.json();
  assert.equal(metadataPayload.clank_agent_access_url, `${origin}/__clank/oauth/access`);
  assert.equal(metadataPayload.clank_agent_grants_endpoint, `${origin}/__clank/oauth/grants`);

  const anonymous = await runtime.handle(new Request(`${origin}/__clank/oauth/grants`));
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, "UNAUTHENTICATED");

  const listed = await runtime.handle(new Request(`${origin}/__clank/oauth/grants`, {
    headers: { cookie: owner.cookie },
  }));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const grantList = await listed.json();
  assert.equal(grantList.protocol, "clank-agent-grants/1");
  assert.equal(grantList.hasMore, false);
  assert.equal(grantList.managementPath, "/__clank/oauth/access");
  assert.equal(grantList.grantsPath, "/__clank/oauth/grants");
  assert.equal(grantList.grants.length, 1);
  const grant = grantList.grants[0];
  assert.match(grant.id, /^clank_grant_[A-Za-z0-9_-]{24}$/u);
  assert.equal(grant.clientId, client.client_id);
  assert.equal(grant.clientName, "Test MCP client");
  assert.deepEqual(grant.scopes, ["agent:read", "agent:write"]);
  assert.equal(grant.lastUsedAt, null);
  assert.ok(grant.expiresAt > grant.createdAt);

  const inbox = await runtime.handle(new Request(`${origin}/__clank/oauth/access`, {
    headers: { cookie: owner.cookie },
  }));
  assert.equal(inbox.status, 200);
  assert.match(inbox.headers.get("content-security-policy"), /default-src 'none'/u);
  const inboxHtml = await inbox.text();
  assert.match(inboxHtml, /Agent access · Private Todo/u);
  assert.match(inboxHtml, /Test MCP client/u);
  assert.match(inboxHtml, /Read and write/u);
  assert.match(inboxHtml, /Make read-only/u);
  assert.match(inboxHtml, /Revoke/u);
  assert.doesNotMatch(inboxHtml, new RegExp(tokens.access_token, "u"));
  assert.doesNotMatch(inboxHtml, new RegExp(tokens.refresh_token, "u"));

  const noCsrf = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "PATCH",
    headers: {
      cookie: owner.cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopes: ["agent:read"] }),
  }));
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "INVALID_CSRF");

  const expansion = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "PATCH",
    headers: {
      cookie: owner.cookie,
      origin,
      "content-type": "application/json",
      "x-clank-csrf": owner.csrf,
    },
    body: JSON.stringify({ scopes: ["agent:read", "agent:write"] }),
  }));
  assert.equal(expansion.status, 422);
  assert.equal((await expansion.json()).error.code, "INVALID_GRANT_REQUEST");

  const reduced = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "PATCH",
    headers: {
      cookie: owner.cookie,
      origin,
      "content-type": "application/json",
      "x-clank-csrf": owner.csrf,
    },
    body: JSON.stringify({ scopes: ["agent:read"] }),
  }));
  assert.equal(reduced.status, 200);
  const reducedPayload = await reduced.json();
  assert.equal(reducedPayload.updated.action, "reduced_to_read_only");
  assert.deepEqual(reducedPayload.grants[0].scopes, ["agent:read"]);

  const initialized = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "grant-test", version: "1.0.0" },
    },
  }, tokens.access_token));
  assert.equal(initialized.status, 200);
  const mcpSession = initialized.headers.get("mcp-session-id");
  const tools = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.deepEqual((await tools.json()).result.tools.map((tool) => tool.name), ["todos_list"]);
  const write = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "todos_add", arguments: { title: "Must remain blocked" } },
  }, tokens.access_token, { "mcp-session-id": mcpSession }));
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, "insufficient_scope");

  const refreshed = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  }));
  assert.equal(refreshed.status, 200);
  const refreshedTokens = await refreshed.json();
  assert.equal(refreshedTokens.scope, "agent:read");

  const otherRegistration = await runtime.handle(jsonRequest("/__clank/auth/register", {
    email: "other-agent-user@example.com",
    password: "correct horse battery staple",
    profile: { name: "Other Agent User" },
  }));
  assert.equal(otherRegistration.status, 201);
  const otherPayload = await otherRegistration.json();
  const other = {
    cookie: otherRegistration.headers.get("set-cookie").split(";", 1)[0],
    csrf: otherPayload.csrfToken,
  };
  const crossUser = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "DELETE",
    headers: {
      cookie: other.cookie,
      origin,
      "x-clank-csrf": other.csrf,
    },
  }));
  assert.equal(crossUser.status, 404);
  assert.equal((await crossUser.json()).error.code, "GRANT_NOT_FOUND");

  const formGrantTokens = await authorize(runtime, owner, client, "agent:read");
  const withFormGrant = await runtime.handle(new Request(`${origin}/__clank/oauth/grants`, {
    headers: { cookie: owner.cookie },
  }));
  const formGrant = (await withFormGrant.json()).grants.find((entry) => entry.id !== grant.id);
  assert.ok(formGrant);
  const formRevoked = await runtime.handle(formRequest("/__clank/oauth/access", {
    grant_id: formGrant.id,
    csrf_token: owner.csrf,
    decision: "revoke",
  }, {
    cookie: owner.cookie,
    origin,
  }));
  assert.equal(formRevoked.status, 303);
  assert.equal(
    formRevoked.headers.get("location"),
    "/__clank/oauth/access?updated=revoked",
  );
  const formGrantDenied = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/list",
    params: {},
  }, formGrantTokens.access_token));
  assert.equal(formGrantDenied.status, 401);

  const revoked = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "DELETE",
    headers: {
      cookie: owner.cookie,
      origin,
      "x-clank-csrf": owner.csrf,
    },
  }));
  assert.equal(revoked.status, 200);
  const revokedPayload = await revoked.json();
  assert.equal(revokedPayload.updated.action, "revoked");
  assert.deepEqual(revokedPayload.grants, []);

  const denied = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  }, refreshedTokens.access_token, { "mcp-session-id": mcpSession }));
  assert.equal(denied.status, 401);
  const deniedRefresh = await runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: refreshedTokens.refresh_token,
    resource,
  }));
  assert.equal(deniedRefresh.status, 400);
  assert.equal((await deniedRefresh.json()).error, "invalid_grant");
  runtime.close();
});

test("agent grant capacity is bounded per user and a rejected code remains retryable", async () => {
  const runtime = await openBackend(authenticatedBackend(), {
    path: ":memory:",
    agent: { maxUserGrants: 1 },
  });
  const session = await registerUser(runtime);
  const client = await registerClient(runtime);
  const first = await authorize(runtime, session, client);
  const second = await approveAuthorization(runtime, session, client);
  const exchange = () => runtime.handle(formRequest("/__clank/oauth/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: second.code,
    redirect_uri: client.redirect_uris[0],
    code_verifier: second.verifier,
    resource,
  }));
  const atCapacity = await exchange();
  assert.equal(atCapacity.status, 503);
  assert.equal((await atCapacity.json()).error, "temporarily_unavailable");

  const listed = await runtime.handle(new Request(`${origin}/__clank/oauth/grants`, {
    headers: { cookie: session.cookie },
  }));
  const grant = (await listed.json()).grants[0];
  const revoked = await runtime.handle(new Request(`${origin}/__clank/oauth/grants/${grant.id}`, {
    method: "DELETE",
    headers: {
      cookie: session.cookie,
      origin,
      "x-clank-csrf": session.csrf,
    },
  }));
  assert.equal(revoked.status, 200);
  const retried = await exchange();
  assert.equal(retried.status, 200);
  assert.notEqual((await retried.json()).access_token, first.access_token);
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
  const webLoopback = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Misclassified web client",
    application_type: "web",
    redirect_uris: ["http://127.0.0.1:43123/callback"],
  }, { origin: undefined }));
  assert.equal(webLoopback.status, 400);
  assert.equal((await webLoopback.json()).error, "invalid_client_metadata");
  const remoteWeb = await runtime.handle(jsonRequest("/__clank/oauth/register", {
    client_name: "Web client",
    application_type: "web",
    redirect_uris: ["https://client.test/callback"],
  }, { origin: undefined }));
  assert.equal(remoteWeb.status, 201);
  assert.equal((await remoteWeb.json()).application_type, "web");

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
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { maxUserGrants: 1_001 },
    }),
    /must not exceed 1000/,
  );
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { refreshTokenRetryLifetimeMs: 999 },
    }),
    /refreshTokenRetryLifetimeMs must be from 1000 through 3600000 milliseconds/,
  );
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { refreshTokenRetryLifetimeMs: 60 * 60 * 1_000 + 1 },
    }),
    /refreshTokenRetryLifetimeMs must be from 1000 through 3600000 milliseconds/,
  );
  await assert.rejects(
    openBackend(authenticatedBackend(), {
      path: ":memory:",
      agent: { refreshTokenRotationMode: "forever" },
    }),
    /refreshTokenRotationMode must be "adaptive" or "strict"/,
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
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["notes_add", "notes_list"]);
  const added = await runtime.handle(mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "notes_add", arguments: { title: "Public MCP" } },
  }, undefined, { "mcp-session-id": mcpSession }));
  assert.equal((await added.json()).result.isError, false);
  assert.equal(runtime.query("notes.list", {}).value[0].title, "Public MCP");
  runtime.close();
});
