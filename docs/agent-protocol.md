# Agent protocol

Every Clank backend is an MCP server. Define normal typed queries and mutations, open the backend,
and an agent can discover and invoke the same server actions without a second API layer, generated
OpenAPI file, SDK, or adapter process.

The MCP endpoint is:

```text
https://your-app.example.com/__clank/mcp
```

Give that URL to any remote MCP client that supports Streamable HTTP and OAuth. Clank implements
the stateless `2026-07-28` protocol revision and remains dual-era compatible with `2025-11-25`,
`2025-06-18`, and `2025-03-26` clients.

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

Clank derives portable MCP tool names from function paths: `todos.list`, `todos.add`, and
`todos.remove` publish as `todos_list`, `todos_add`, and `todos_remove`. Public names contain only
ASCII letters, numbers, and underscores and never exceed 64 characters, satisfying strict model
providers such as Anthropic. Overlong names and paths that would collide after replacing `.` or
`-` receive a stable digest suffix. Each descriptor's `_meta["clank/actionPath"]` and the Clank MCP
manifest retain the exact original function path. The normal runtime schemas become JSON Schema
2020-12 tool contracts. Query results and mutation results include the committed Clank database
revision.

The backend function tree is the single source of truth for both interfaces. Browser code calls
the same typed query and mutation references that MCP exposes. A UI operation that changes server
state must therefore be a backend mutation; do not implement a second UI-only persistence path.
When changing UI behavior, update the backend function name, schema, `description`, and `agent`
metadata in the same change. `GET /__clank/manifest` and authenticated `tools/list` enumerate the
same agent-enabled function paths.

Use the reference itself for semantic UI metadata:

```tsx
const api = createApi<typeof backend>();

<button agentId="todo-add" agentAction={api.todos.add}>
  Add
</button>
```

`agentActionPath()` resolves that reference consistently in SSR and the browser.
`assertAgentActionParity()` checks already-rendered HTML or DOM against a backend manifest, while
`verifyAgentActionParity()` fetches the current no-store manifest and binds its
`X-Clank-Contract-Revision` header. Generated application tests require every server-backed
control to have a stable ID, an agent-visible backend function, a description, and current
revision coverage.

The same stable IDs power [semantic browser journeys](browser-journeys.md). Journeys verify the
human-visible behavior in real Chrome while MCP verifies the server action contract. Using both
surfaces catches a control that is documented but unusable, or a visible flow whose server action
was never exposed to agents, without maintaining CSS-selector tests.

The optional `agent` contract supports:

- `title`: human-readable tool name;
- `description`: agent-specific description override;
- `destructive`: whether a mutation can remove or irreversibly change data;
- `idempotent`: whether repeating the exact call has no additional effect;
- `openWorld`: whether the action can communicate outside this application;
- `app`: an immutable MCP Apps view, or a `{ resource, visibility }` binding for app-only actions;
- `enabled: false`, or `agent: false`, to omit an internal function.

Queries are always marked read-only and idempotent. Mutations default to destructive as a
conservative safety hint; mark additive or reversible writes with `destructive: false`.
Annotations help the MCP client decide when to ask for confirmation, but server authorization
never trusts an annotation.

When `app` is present, model-visible tools retain `_meta.ui` so stateless hosts such as Codex can
attach the matching `ui://` document even if they omit a per-request extension hint.
`resources/read` serves that document with the exact `text/html;profile=mcp-app` MIME type.
Clients without MCP Apps support safely ignore the metadata and receive the same meaningful text
and structured result. Negotiation is still required to discover or call app-only tools. See
[Interactive MCP Apps](mcp-apps.md).

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

The displayed MCP `serverInfo.version` combines this application version with a deterministic
contract revision. Adding, removing, renaming, or changing the schema, description, scope, or
annotations of a tool changes that effective version automatically; application authors do not
manually increment a second MCP version.

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
as the authenticated `clank://actions` MCP resource. Its bounded contract metadata also includes
registered durable workflow schemas and dependency graphs. The public documents do not contain
action arguments, workflow run data, credentials, private routes, or implementation paths.

The Server Card endpoint follows the current MCP Server Card proposal. Stable clients can ignore
it and connect directly to `/__clank/mcp`. Both discovery documents include
`contractRevision`, an `ETag`, and a deployment-sensitive MCP server version; they require
revalidation instead of remaining fresh across an application deployment.

## Authentication

When `defineBackend()` receives `auth`, Clank automatically protects MCP with an OAuth 2.1-style
authorization-code flow:

1. The MCP endpoint returns `401` with an RFC 9728 `resource_metadata` challenge.
2. The client discovers Clank's authorization and token endpoints.
3. Unknown public clients register through RFC 7591 dynamic client registration. This remains a
   backwards-compatible registration path; Clank does not advertise Client ID Metadata Document
   support or fetch caller-controlled metadata URLs.
4. The client starts authorization with PKCE `S256` and the exact MCP resource indicator.
5. The user signs into the application in the browser and approves the displayed scopes.
6. Clank returns a short-lived, resource-bound bearer token and a rotating refresh token.
7. The client validates the authorization response issuer and sends the bearer token in the
   `Authorization` header on every MCP request.

If the authorization page opens while signed out, applications using ordinary password login show
the same-origin sign-in form directly on the OAuth page and advance to consent automatically.
Applications that require MFA or custom bot protection link to their full sign-in experience and
then recheck the session. In both cases credentials go only to the application's normal auth
endpoint. The agent never receives the password, browser cookie, CSRF token, or application
session. Application sessions default to `SameSite=Lax`, so a top-level authorization navigation
from a hosted client recognizes an existing login; the cookie is still withheld from cross-site
POST requests, and every application mutation retains exact Origin and session-bound CSRF checks.
Session checks reissue existing cookies under the current policy, so sessions minted before the
`Lax` default are upgraded after an authenticated application visit. Authorization also performs
one same-site recheck before rendering login, allowing a legacy Strict cookie suppressed on the
initial hosted-client launch to be recognized without looping or changing OAuth parameters.

### Connect from Codex

The deployed application is a standard remote MCP server. A user needs Codex, but does not need
the Clank CLI, a Clank source checkout, or access to the Clank deployment account:

```sh
codex mcp add my-app --url https://your-app.example.com/__clank/mcp
codex mcp login my-app
```

Codex discovers the OAuth endpoints, registers its exact callback URI, opens the application's
authorization page, and waits for the redirect. The user signs in and selects **Approve access**.
The browser then returns the short-lived code to Codex, which validates `state`, redeems the code
with its private PKCE verifier, and stores the resulting application-scoped token. Nothing is
copied back to the terminal or agent.

Graphical MCP clients can present the same operation as an **Authorize** link or button. The
callback belongs to that MCP client: a desktop client normally uses a loopback listener, while a
hosted client supplies its own HTTPS callback. Clank dynamically registers either exact URI.
The consent page's Content Security Policy permits form navigation only to itself and the exact
validated callback origin. This allows Chromium to follow the successful `303` callback without
opening form submissions to any other origin.
Running the browser on a different machine from a command-line client is a client-hosting concern;
it does not introduce a Clank-specific relay or installation requirement.

OAuth access tokens work only at the exact MCP resource that issued them. They do not authenticate
ordinary `__clank/query`, `__clank/mutation`, browser-auth, or another domain's endpoints.

Every authenticated app also publishes a server-rendered access inbox at
`/__clank/oauth/access`. The signed-in application user can inspect active client grants, reduce
read/write access to read-only, or revoke a complete refresh family. Enforcement happens on the
next MCP request, including stateless requests and legacy requests carrying a session ID. The no-store
`/__clank/oauth/grants` JSON contract supports the same management flow for same-origin
application UI. See [Agent access inbox and scoped grants](agent-access.md).

## Scopes

Clank uses two deliberately small scopes:

- `agent:read`: discover MCP, list and read tool documentation, and call queries;
- `agent:write`: call mutations. A write grant also includes `agent:read`.

A read-only token does not merely fail mutation calls: mutation tools are omitted from
`tools/list` and the action manifest. An attempted mutation still receives `403
insufficient_scope`.

Applications keep their normal authorization rules. Required authentication, verified-email
requirements, roles, owned-table isolation, validation, optimistic concurrency, and transaction
boundaries apply identically to browser and MCP calls.

Scope management is monotonic: the inbox can remove `agent:write` or revoke a family, but cannot
add authority. Restoring write access requires a fresh authorization flow and explicit consent.

## Transport behavior

Clank defaults to stateless MCP `2026-07-28` over Streamable HTTP. Every JSON-RPC request is an
independent POST and carries its protocol version, client identity, and client capabilities in
`params._meta`. There is no initialization handshake, process-local `MCP-Session-Id`, standalone
GET event stream, DELETE termination request, or `Last-Event-ID` recovery. A request can land on
any healthy replica before, during, or after a rolling deployment.

Modern clients may call the required `server/discover` method to retrieve supported revisions,
capabilities, server identity, instructions, and cache policy, or call `tools/list` directly.
Every successful modern result includes `resultType: "complete"` and
`_meta["io.modelcontextprotocol/serverInfo"]`. `Mcp-Method`, `Mcp-Name`, and any schema-declared
`Mcp-Param-*` headers are checked against the body before a tool is selected or executed; a
mismatch returns the standard `HeaderMismatch` error (`-32020`). Unknown protocol revisions return
`UnsupportedProtocolVersionError` (`-32022`) with the supported revision list.

Clank retains the initialization, bounded session, GET stream, and list-change behavior for
clients speaking revisions through `2025-11-25`. Those compatibility sessions are never used by
`2026-07-28` requests and do not affect stateless routing.

OAuth-protected application MCP endpoints answer credential-free browser CORS preflights and
expose the transport, challenge, protocol, session, and contract-revision headers needed by hosted
clients such as browser inspectors. CORS never enables cookies: the client must send the explicit,
resource-bound bearer token it received through OAuth. Public applications keep cross-origin
browser access disabled unless `agent.browserCors: true` is explicitly selected, preventing a web
page from silently driving an unauthenticated mutation surface.

Every `tools/list` response is deterministic and carries:

- `ttlMs: 0`, so clients supporting MCP list TTLs treat it as immediately stale;
- `cacheScope: "private"`, because OAuth scope filtering can change the visible list;
- `_meta["clank/contractRevision"]` and the `X-Clank-Contract-Revision` response header.

Unknown tool calls return a structured `TOOLS_CHANGED` hint directing the client to refresh
`tools/list`. Request bytes, response bytes, tool schemas, and authentication remain bounded.
Legacy session counts, streams per session, idle lifetime, and heartbeat frequency are bounded
separately. Stateless clients need no reconnect when a request moves to a new replica.

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

- Ordinary application and public MCP requests check the HTTP `Origin` header to prevent
  DNS-rebinding and browser-origin attacks. OAuth-protected MCP transport may be called
  cross-origin without credentials; authorization depends on an explicit resource-bound bearer
  token rather than ambient browser cookies.
- Modern request headers are compared with the JSON-RPC body before authorization or dispatch,
  preventing a gateway and application from routing and executing different actions.
- Request and response bodies are bounded before execution.
- Tool input and backend output use the same runtime schemas as the application.
- Authorization codes are single-use, expire after five minutes, and require PKCE `S256`.
- Consent forms carry a one-time, five-minute proof bound to the authenticated session and exact
  authorization request. The proof is stored only as a digest and consumed atomically, so opaque
  extension origins cannot break consent and cross-site forgery cannot replay it.
- Signed-out password users can authenticate through a same-origin form that accepts only a
  bounded relative return path. A five-minute, one-time proof binds the exact authorization
  request to a private browser cookie and is consumed atomically, allowing sandboxed hosted
  clients to use opaque origins without trusting proxy-sensitive Fetch Metadata. Missing,
  mismatched, expired, replayed, JSON, or unbounded-return requests fail closed. Credential rate
  limits, secure session cookies, and generic credential failures remain in force.
- Redirect URIs must be exact registered HTTPS URLs or HTTP loopback URLs; fragments and embedded
  credentials are rejected. Dynamic registrations are classified as `native` or `web`, and web
  clients cannot register an HTTP loopback callback.
- Authorization responses include an RFC 9207 `iss` value and advertise issuer-response support,
  allowing clients to reject authorization-server mix-up.
- Consent-page form navigation is restricted to the application and the exact validated callback
  origin; wildcard form destinations are never allowed.
- Access tokens are stored only as SHA-256 digests, expire after one hour, and are bound to the
  exact MCP resource.
- Refresh tokens rotate and expire after 30 days. The encrypted adaptive handoff chain lets lagging
  client replicas converge on one unspent successor without branching or revoking a newer replica.
  It is bounded to 64 links and each link expires with its immediate successor. Applications can
  opt into strict post-window family revocation without multi-generation handoffs.
- OAuth client registration is bounded and never fetches caller-controlled metadata URLs, avoiding
  an authorization-server SSRF surface.
- Disabling an account immediately invalidates its agent tokens.
- Public discovery is cacheable but contains no detailed tools or user-specific information.

Treat agent input as untrusted even after OAuth. Authorization identifies the user; it does not
make model-generated arguments safe.

Realtime collaboration presence is not an MCP tool or durable application record. Agents continue
to use the typed backend queries and mutations as the source of truth; cursors, typing indicators,
and ephemeral signals remain short-lived UI context for currently authorized room participants.

Typed product analytics can publish its immutable `clank-analytics/1` manifest through a normal
agent-readable query and expose only role-appropriate aggregate query or funnel actions. Raw events
and subjects are never an MCP surface, and an MCP grant does not imply analytics access. See
[Privacy-first product analytics](./product-analytics.md).
