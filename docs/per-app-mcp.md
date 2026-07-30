# The MCP server built into every app

Every Clank app with a backend is also its own MCP server. The same typed queries and mutations
used by the browser become tools that an authenticated agent can discover and call directly. You
do not maintain a second agent API, generate an OpenAPI client, or run a separate MCP process.

For a deployed project, connect to:

```text
https://<project>.apps.clank.run/__clank/mcp
```

A custom domain uses the same path:

```text
https://app.example.com/__clank/mcp
```

The generated starter mounts this endpoint automatically. During local development it is
`http://127.0.0.1:3000/__clank/mcp` unless the application uses a different port.

## One app, one contract, one data boundary

Each application has its own MCP endpoint, server identity, OAuth clients, application users,
resource-bound tokens, backend contract, and isolated database. There is no global MCP server
that can read every hosted project's data.

```text
src/backend.ts
    ├── browser client ── query / mutation ─┐
    └── MCP client ───── tool call ─────────┤
                                            ▼
                                  same handler, auth,
                                  validation, transaction,
                                  and application database
```

This is the important rule: if a UI operation reads or changes server data, implement it as a
backend query or mutation. The browser and MCP then stay aligned because both invoke the same
function. Do not add a separate UI-only persistence route.

## Queries and mutations become MCP tools

Consider a small authenticated Todo backend:

```ts
import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
} from "@clank.run/framework";

const auth = defineAuth();
const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).owned(),
});

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
        description: "Permanently delete a todo.",
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

Clank derives the agent contract directly from that function tree:

| Backend function | MCP tool | Permission | Behavior |
| --- | --- | --- | --- |
| Query `todos.list` | `todos.list` | `agent:read` | Read-only and idempotent |
| Mutation `todos.add` | `todos.add` | `agent:write` | Validated additive write |
| Mutation `todos.remove` | `todos.remove` | `agent:write` | Validated destructive write |

The `args` validators become JSON Schema tool inputs. `description` explains the operation to
people and agents. The optional `agent` metadata describes whether a mutation is destructive,
idempotent, or able to communicate outside the app. Set `agent: false` or
`agent: { enabled: false }` only when a server function is intentionally internal.

The browser uses the same references:

```ts
const client = createClient<typeof backend>();
const todos = client.live(client.api.todos.list);

await client.mutate(client.api.todos.add, {
  title: "Connect the app to an agent",
});
```

An MCP client sees and invokes `todos.list` and `todos.add`; it does not automate those browser
controls. Both paths reach the same handler and therefore share runtime validation, `.owned()`
user isolation, transaction rollback, optimistic concurrency, and live-update notifications.

## Connect an agent

Give the application MCP URL to any remote MCP client that supports Streamable HTTP and OAuth.
For Codex:

```sh
codex mcp add my-app \
  --url https://my-app.apps.clank.run/__clank/mcp
codex mcp login my-app
```

The browser opens the application's sign-in and consent page. After approval, it redirects to the
MCP client's registered callback. The client receives a short-lived token restricted to this
application and exact MCP resource. Nothing needs to be copied back, and the person connecting
does not need the Clank deployment CLI or access to the deployment account.

The agent never receives the user's password, browser session cookie, or CSRF token. A read grant
can list and call queries. A write grant can also call mutations. Normal application checks still
apply, including required login, verified email, roles, record ownership, argument validation,
and document-version conflicts.

## Keep the UI and MCP contract synchronized

Treat `src/backend.ts` as the single source of truth:

1. Add or change the backend query or mutation.
2. Update its argument schema, `description`, and `agent` safety metadata.
3. Make the UI call that same typed function reference.
4. Build, test both paths, and deploy them together.

Bind server-backed controls to the typed reference rather than copying its name into a string:

```tsx
import { createApi } from "@clank.run/framework";
import type { backend } from "./backend.ts";

const api = createApi<typeof backend>();

<button
  agentId="todo-add"
  agentAction={api.todos.add}
  onClick={() => client.mutate(api.todos.add, { title })}
>
  Add
</button>
```

Clank serializes the reference as `data-clank-action="todos.add"` in both SSR and browser
rendering. `assertAgentActionParity()` compares rendered controls with
`GET /__clank/manifest`; `verifyAgentActionParity()` fetches that no-store manifest and also binds
the deployment-sensitive revision header. Unknown, internal, undocumented, duplicate-ID, and
missing required actions fail with a structured `clank-agent-action-parity/1` report. Generated
apps run this assertion from `npm test`.

Clank fingerprints every agent-visible name, schema, description, scope, and annotation. A
contract change produces a new revision. Discovery responses require revalidation, tool lists
have a zero freshness lifetime, and a deployment invalidates existing MCP sessions so compliant
clients initialize again and rediscover the current tools. An unknown stale tool also returns a
structured refresh hint.

This prevents the MCP action list from silently remaining on an older release while the UI moves
ahead. A client connected before session-aware revisions were introduced may need one manual
reconnect; later deployments refresh automatically.

## Verify an app's MCP surface

Before deployment, check that every server-backed UI operation has one matching backend function
and that internal functions are intentionally hidden. `npm test` performs this check for generated
apps. A custom app can run:

```ts
await verifyAgentActionParity(document, {
  requiredActions: [api.todos.add, api.todos.remove],
});
```

After deployment:

- open `https://<project>.apps.clank.run/.well-known/clank` to confirm the advertised endpoint
  and contract revision;
- compare the agent-enabled entries in `GET /__clank/manifest` with authenticated MCP
  `tools/list`;
- confirm every tool has a precise description, bounded input schema, correct read/write scope,
  and honest destructive/idempotent annotations; and
- call representative queries and mutations as two different users to prove owned data remains
  isolated.

Continue with [Agent protocol](agent-protocol.md) for the full MCP transport, discovery, OAuth,
scope, freshness, and security contract. Read [Full-stack applications](full-stack.md) for backend
implementation details and [Authentication](auth.md) for application identity and authorization.
