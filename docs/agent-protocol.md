# Agent protocol

Every Clank backend is an MCP server. Define normal typed queries and mutations, open the backend,
and an agent can discover and invoke the same server actions without a second API layer, generated
OpenAPI file, SDK, or adapter process.

The MCP endpoint is:

```text
https://your-app.example.com/__clank/mcp
```

Give that URL to any remote MCP client that supports Streamable HTTP and OAuth. Clank implements
the stable `2025-11-25` protocol revision and accepts compatible `2025-06-18` and `2025-03-26`
clients.

## Why MCP

MCP tools are the closest match for application actions: each tool has a programmatic name,
human description, JSON Schema input and output, authorization scope, and side-effect annotations.
MCP also specifies Streamable HTTP and how a protected server discovers its OAuth authorization
server.

Agent2Agent (A2A) solves a different problem. It lets autonomous agents exchange messages and
long-running tasks through Agent Cards. A Clank application may add A2A later when the application
itself behaves as an autonomous agent, but A2A is not a replacement for its typed query and
mutation API.

## Clank documentation MCP

The canonical documentation site is itself an MCP server:

```text
https://docs.clank.run/__clank/mcp
```

It exposes three public, read-only tools:

- `docs.list` lists the canonical guide catalog, optionally by documentation group;
- `docs.search` searches guide titles, headings, and text with a bounded result count;
- `docs.read` returns one canonical guide as Markdown with its navigation metadata.

Start at `https://docs.clank.run/.well-known/clank` when a client supports discovery. Documentation
is public, so this particular server does not require OAuth. Its tools are annotated read-only,
non-destructive, idempotent, and closed-world. Authenticated application backends still use the
OAuth flow described below.

## Define agent-ready actions

Backend functions are exposed by default:

```ts
export const backend = defineBackend({ schema, auth }).functions(
  ({ query, mutation }) => ({
    todos: {
      list: query({
        description: "List the signed-in user's todos.",
        args: {},
        handler: ({ db }) => db.table("todos").collect(),
      }),

      add: mutation({
        description: "Create a todo for the signed-in user.",
        args: {
          title: s.string({
            min: 1,
            max: 160,
            description: "Todo title",
          }),
        },
        agent: { destructive: false },
        handler: ({ db }, { title }) =>
          db.table("todos").insert({ title, done: false }),
      }),

      remove: mutation({
        description: "Permanently remove one todo.",
        args: {
          id: s.id("todos"),
          version: s.number({ integer: true, min: 1 }),
        },
        agent: { destructive: true },
        handler: ({ db }, { id, version }) =>
          db.table("todos").delete(id, { ifVersion: version }),
      }),
    },
  }),
);
```

Clank derives MCP tool names from function paths: `todos.list`, `todos.add`, and `todos.remove`.
The normal runtime schemas become JSON Schema 2020-12 tool contracts. Query results and mutation
results include the committed Clank database revision.

The optional `agent` contract supports:

- `title`: human-readable tool name;
- `description`: agent-specific description override;
- `destructive`: whether a mutation can remove or irreversibly change data;
- `idempotent`: whether repeating the exact call has no additional effect;
- `openWorld`: whether the action can communicate outside this application;
- `enabled: false`, or `agent: false`, to omit an internal function.

Queries are always marked read-only and idempotent. Mutations default to destructive as a
conservative safety hint; mark additive or reversible writes with `destructive: false`.
Annotations help the MCP client decide when to ask for confirmation, but server authorization
never trusts an annotation.

## Application identity

Customize the generated server card and OAuth consent screen when opening the backend:

```ts
const runtime = await openBackend(backend, {
  path: databasePath,
  agent: {
    name: "private-todo",
    title: "Private Todo",
    version: "1.0.0",
    description: "Manage private todos.",
    instructions: "Read the current revision before changing an existing todo.",
  },
});
```

Set `agent: false` on `openBackend()` only when the entire application must not expose an agent
protocol. Endpoint paths can be changed with `mcpPath` and `oauthPrefix`.

## Discovery

Clank publishes only non-sensitive connection metadata before authentication:

| URL | Purpose |
|---|---|
| `/.well-known/clank` | Stable Clank discovery document with the absolute MCP URL |
| `/.well-known/mcp/server-card.json` | Forward-compatible MCP Server Card; tools stay dynamic |
| `/.well-known/oauth-protected-resource/__clank/mcp` | RFC 9728 protected-resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |

Detailed action descriptions and schemas are returned after connection through `tools/list`, or
as the authenticated `clank://actions` MCP resource. The public documents do not contain action
arguments, user data, credentials, private routes, or implementation paths.

The Server Card endpoint follows the current MCP Server Card proposal. Stable clients can ignore
it and connect directly to `/__clank/mcp`.

## Authentication

When `defineBackend()` receives `auth`, Clank automatically protects MCP with an OAuth 2.1-style
authorization-code flow:

1. The MCP endpoint returns `401` with an RFC 9728 `resource_metadata` challenge.
2. The client discovers Clank's authorization and token endpoints.
3. Unknown public clients register through RFC 7591 dynamic client registration.
4. The client starts authorization with PKCE `S256` and the exact MCP resource indicator.
5. The user signs into the application in the browser and approves the displayed scopes.
6. Clank returns a short-lived, resource-bound bearer token and a rotating refresh token.
7. The client sends the bearer token in the `Authorization` header on every MCP request.

If the authorization page opens while signed out, applications using ordinary password login show
the same-origin sign-in form directly on the OAuth page and advance to consent automatically.
Applications that require MFA or custom bot protection link to their full sign-in experience and
then recheck the session. In both cases credentials go only to the application's normal auth
endpoint. The agent never receives the password, browser cookie, CSRF token, or application
session.

### Remote Codex callback

Codex normally listens on a random loopback port while OAuth redirects the browser back to the
client. When Codex runs on a remote devbox, `127.0.0.1` in the user's browser is not that devbox.
Configure a reachable HTTPS callback and a fixed private listener port in Codex's top-level
`config.toml`:

```toml
mcp_oauth_callback_port = 18641
mcp_oauth_callback_url = "https://devbox.example.com/mcp-oauth"
```

Codex appends a random server-specific callback path. Route the public HTTPS URL, including all
descendant paths, to `127.0.0.1:18641` on the devbox, restart Codex, and run:

```sh
codex mcp login my-clank-app
```

A private Tailscale Serve URL works when the approving browser belongs to the same tailnet. Use a
single-purpose public ingress or Tailscale Funnel when it does not. Do not expose an unrelated
development service on the callback listener. Clank dynamically registers the exact derived
redirect URI; OAuth `state`, PKCE, the random callback path, and single-use authorization codes
still protect the handoff.

OAuth access tokens work only at the exact MCP resource that issued them. They do not authenticate
ordinary `__clank/query`, `__clank/mutation`, browser-auth, or another domain's endpoints.

## Scopes

Clank uses two deliberately small scopes:

- `agent:read`: initialize MCP, list and read tool documentation, and call queries;
- `agent:write`: call mutations. A write grant also includes `agent:read`.

A read-only token does not merely fail mutation calls: mutation tools are omitted from
`tools/list` and the action manifest. An attempted mutation still receives `403
insufficient_scope`.

Applications keep their normal authorization rules. Required authentication, verified-email
requirements, roles, owned-table isolation, validation, optimistic concurrency, and transaction
boundaries apply identically to browser and MCP calls.

## Transport behavior

Clank uses stateless JSON responses over MCP Streamable HTTP. It supports `initialize`, `ping`,
`tools/list`, `tools/call`, `resources/list`, `resources/read`, and standard notifications. It
does not open a server-initiated SSE stream, so `GET` on the MCP endpoint returns `405` as permitted
by the protocol.

Tool results include both MCP text content and structured content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"value\":[],\"version\":12}"
    }
  ],
  "structuredContent": {
    "value": [],
    "version": 12
  },
  "isError": false
}
```

Application-level validation and conflict errors are returned as `isError: true` tool results.
Unexpected exceptions are reported privately and become a generic `TOOL_FAILED` or
`BACKEND_ERROR`; stack traces and exception text are never sent to the agent.

## Security properties

- The HTTP `Origin` header is checked when present to prevent DNS-rebinding and browser-origin
  attacks.
- Request and response bodies are bounded before execution.
- Tool input and backend output use the same runtime schemas as the application.
- Authorization codes are single-use, expire after five minutes, and require PKCE `S256`.
- Consent forms carry a one-time, five-minute proof bound to the authenticated session and exact
  authorization request. The proof is stored only as a digest and consumed atomically, so opaque
  extension origins cannot break consent and cross-site forgery cannot replay it.
- Signed-out password users can authenticate through a same-origin form that accepts only a
  bounded relative return path. The existing Origin and Fetch Metadata checks, credential rate
  limits, secure session cookie, and generic credential failures remain in force.
- Redirect URIs must be exact registered HTTPS URLs or HTTP loopback URLs; fragments and embedded
  credentials are rejected.
- Access tokens are stored only as SHA-256 digests, expire after one hour, and are bound to the
  exact MCP resource.
- Refresh tokens rotate, expire after 30 days, and reuse revokes the entire token family.
- OAuth client registration is bounded and never fetches caller-controlled metadata URLs, avoiding
  an authorization-server SSRF surface.
- Disabling an account immediately invalidates its agent tokens.
- Public discovery is cacheable but contains no detailed tools or user-specific information.

Treat agent input as untrusted even after OAuth. Authorization identifies the user; it does not
make model-generated arguments safe.
