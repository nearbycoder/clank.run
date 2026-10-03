# Agent access inbox and scoped grants

Every authenticated Clank backend includes an application-local agent access inbox:

```text
https://your-app.example/__clank/oauth/access
```

It shows the MCP clients currently authorized to act as the signed-in application user. A user can
reduce a read/write grant to read-only or revoke it completely. The page is server rendered, works
without client JavaScript, and is part of the application—not the Clank deployment control plane.

## What a grant represents

An agent grant is one OAuth refresh-token family created after a user approves an MCP client. It is
bound to all of the following:

- this application and its exact MCP resource URL;
- one application user;
- one dynamically registered OAuth client;
- `agent:read` or `agent:read agent:write` scopes; and
- the configured access and refresh expiration windows.

The inbox never stores or displays raw access tokens, refresh tokens, authorization codes, PKCE
verifiers, session cookies, redirect URIs, or consent proofs. Grant identifiers and client IDs are
opaque management identifiers, not bearer credentials.

An access token is still short lived, and the rotating refresh family is bounded by the existing
OAuth lifetime. By default one user can retain at most 100 active grants in one app. The limit is
admission control: when it is reached, a new authorization code remains unused and can be retried
after the user revokes an old grant.

## Human workflow

The normal OAuth consent screen links to **Review existing agent access**. A signed-in user can also
open the inbox directly. Each grant shows:

- the registered client name and public client ID;
- whether it can read only or read and write;
- when it was created and last used; and
- when the active token family expires.

**Make read-only** removes `agent:write` from every live token in the family. **Revoke** consumes
the complete family. Both operations require the user's browser session and its CSRF proof.

Changes apply on the next MCP HTTP request because Clank authenticates the bearer and reads its
current scopes for every request. That includes stateless `2026-07-28` requests and legacy
requests carrying an MCP session ID. Reducing a grant therefore immediately hides mutation tools
and rejects mutation calls. Revocation rejects existing access tokens and prevents another
refresh.

A grant cannot be expanded from the inbox. To restore write access, the MCP client must start a new
OAuth flow and the user must approve `agent:write` on a fresh consent screen.

## Agent-readable grant API

Same-origin application UI and account tooling can read the no-store JSON contract:

```http
GET /__clank/oauth/grants
Cookie: __Host-clank-id=...
```

```json
{
  "protocol": "clank-agent-grants/1",
  "grants": [
    {
      "id": "clank_grant_AbCdEfGhIjKlMnOpQrStUvWx",
      "clientId": "clank_client_ZyXwVuTsRqPoNmLkJiHgFeDc",
      "clientName": "Codex",
      "scopes": ["agent:read", "agent:write"],
      "createdAt": 1785513600000,
      "lastUsedAt": 1785517200000,
      "expiresAt": 1788105600000
    }
  ],
  "hasMore": false,
  "managementPath": "/__clank/oauth/access",
  "grantsPath": "/__clank/oauth/grants"
}
```

The response contains at most the 100 most recent active grants. `hasMore` explicitly reports a
truncated view. It is partitioned by the current application user; a valid grant ID owned by
another user is indistinguishable from a missing ID.

Reduce a grant by sending the only permitted scope set:

```http
PATCH /__clank/oauth/grants/<grant-id>
Content-Type: application/json
X-Clank-CSRF: <current browser CSRF token>

{"scopes":["agent:read"]}
```

Revoke it with:

```http
DELETE /__clank/oauth/grants/<grant-id>
X-Clank-CSRF: <current browser CSRF token>
```

Mutation responses return the updated `clank-agent-grants/1` list plus an `updated` record. The API
does not enable CORS and does not accept an MCP bearer as browser authority. Missing sessions,
invalid CSRF proofs, malformed JSON, scope expansion, cross-user IDs, and unsupported methods fail
closed with bounded structured errors.

## Discovery

Clank publishes the inbox through its own discovery extensions:

- `/.well-known/clank` → `mcp.accessManagement`;
- OAuth protected-resource metadata → `clank_agent_access_url`; and
- OAuth authorization-server metadata → `clank_agent_access_url` and
  `clank_agent_grants_endpoint`.

Standard OAuth and MCP fields are unchanged. Clients that do not understand these Clank extension
fields can ignore them.

## Configure capacity

The secure default needs no application code. To set a smaller per-user ceiling:

```ts
const runtime = await openBackend(backend, {
  path: "app.sqlite",
  agent: {
    title: "Customer workspace",
    maxUserGrants: 20,
  },
});
```

`maxUserGrants` must be an integer from 1 through 1,000. Lowering the configured ceiling never
silently revokes existing grants; it prevents additional token families until usage falls below
the ceiling. An authorization code rejected at capacity can be retried after revocation only while
that short-lived code remains valid.

## Storage and isolation

Grant state lives in the same private SQLite database as that app's users and OAuth tables. Every
deployed app therefore has a separate inbox and grant namespace. Deleting a user cascades their
codes and token families; disabling a user invalidates authentication; deleting the app removes
the database under the normal deployment retention and deletion contract.

The grant API changes authorization state but not application documents, so it does not increment
the app's live data revision. Connected MCP requests still observe the changed scope immediately
because token authentication does not use the application query cache.

Continue with [Agent protocol](agent-protocol.md) for OAuth transport details and [The MCP server
built into every app](per-app-mcp.md) for UI-to-tool parity and contract freshness.

## Exact action, workspace, resource, and operation limits

The access page also offers **Narrow action limits** for each grant. Its JSON
counterpart accepts a `constraints` object, optionally combined with the existing
read-only scope reduction:

```http
PATCH /__clank/oauth/grants/<grant-id>
Content-Type: application/json
X-Clank-Csrf: <current-session-csrf>
Cookie: <current-session-cookie>

{
  "constraints": {
    "actions": ["tasks.finish", "tasks.get"],
    "workspaceIds": ["workspace-1"],
    "resourceIds": ["task-42"],
    "maxOperations": 20
  }
}
```

Action paths are exact original backend paths, such as `tasks.finish`, even when
MCP exposes a portable name such as `tasks_finish`. No wildcards are accepted.
Lists contain at most 100 identifiers. An empty list denies every value for that
dimension. Omitted fields preserve their existing restriction. Every later change
must be a subset, and an operation budget can only decrease; reducing it below
already admitted usage blocks further calls immediately. The page uses comma
separated IDs; blank form fields preserve existing limits.

For workspace and resource restrictions, configure a synchronous resolver that
uses validated arguments and scoped database reads to derive the actual affected
identities. All affected resources must be returned; do not trust a supplied
workspace identifier without checking its association with the affected records.
Missing mappings fail closed when the grant has that restriction.

```ts
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "@clank.run/framework";

const schema = defineDatabase({ tasks: defineTable({ workspaceId: s.string(), done: s.boolean() }).owned() });
const taskArgs = s.object({ id: s.id("tasks") });
const definition = defineBackend({ schema, auth: defineAuth() }).functions(({ query, mutation }) => ({
  tasks: {
    get: query({ args: taskArgs, handler: ({ db }, { id }) => db.table("tasks").get(id) }),
    finish: mutation({ args: taskArgs, handler: ({ db }, { id }) => db.table("tasks").patch(id, { done: true }) }),
  },
}));
await openBackend(definition, {
  path: "app.sqlite",
  agent: {
    actionContext(action, input, auth, db) {
      if (action === "tasks.finish" || action === "tasks.get") {
        const { id } = taskArgs.parse(input);
        const task = db.table("tasks").get(id);
        return task
          ? { workspaceId: task.workspaceId, resourceIds: [task._id] }
          : {};
      }
      return {};
    },
  },
});
```

The resolver runs inside the current grant-admission transaction. Use the supplied
read-only `db`, rather than starting another database transaction. Normal backend
arguments are schema-validated before reaching it. Custom bucket/review tool
arguments still require resolver validation and authoritative identity lookup;
return no mapping for an unsupported tool. These restrictions supplement existing
application ownership and authorization, so handlers must continue checking their
business permissions.

Each constrained invocation checks the current token, scope, user state, action,
workspace, resources, and remaining operation count immediately before execution.
Tool discovery omits disallowed action paths and hides all tools after budget
exhaustion. Every admitted call counts, including attempts whose handler later
fails; retries do not reset usage. The counter starts when constraints are first
attached to that family. Rejected calls do not consume budget. `operationsUsed`
and `constraints` appear in the grant API response and access page.

Limits live in `clank_oauth_grant_constraints`, keyed by the existing refresh-token
family, and survive token refresh, retries, process restarts, and multiple backend
processes. The checks cover normal backend actions, bucket tools, and reviewed
business-action tools. Existing grants retain their original permissions until
narrowed. Before rolling back to an older release that does not enforce these
constraints, revoke every constrained grant; older code cannot interpret this new
authorization boundary.
