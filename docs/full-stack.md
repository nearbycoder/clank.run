# Full-stack SSR, SQLite, and live sync

Clank's full-stack layer follows one rule: write the runtime contract once and let TypeScript infer the rest. There is no generated client, ORM model, RPC interface, or duplicate DTO type to maintain.

The implementation uses only platform modules: Node's built-in SQLite and HTTP APIs, Fetch `Request`/`Response`, Web `ReadableStream`, and browser `EventSource`. Tailwind remains a CSS choice and does not become a framework dependency.

## Define data once

```ts
import { defineDatabase, defineTable, s, type DocumentFor } from "@clank.run/framework";

export const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
    note: s.optional(s.string()),
  }).index("by_done", ["done"]),
});

export type Todo = DocumentFor<typeof schema, "todos">;
```

`Todo` is inferred as the declared fields plus `_id`, `_creationTime`, and `_version`. An optional validator becomes an optional property. `s.id("todos")` produces a branded string compatible only with the `todos` table, which catches cross-table ID mistakes without changing the JSON wire format.

`defineTable().index(name, fields)` creates a SQLite expression index over the stored JSON fields. Table and field names are checked at startup; all existing rows are revalidated when a database opens.

Add `.owned()` when every document belongs to one authenticated user:

```ts
const schema = defineDatabase({
  todos: defineTable({
    title: s.string(),
    done: s.boolean(),
  }).owned(),
});
```

Owned documents also include `_ownerId`. Auth-scoped database views add the owner predicate automatically to reads and writes.

## Define server functions

```ts
import { defineBackend, s } from "@clank.run/framework";
import { schema } from "./schema.ts";

export const backend = defineBackend({ schema }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      args: { done: s.optional(s.boolean()) },
      handler: ({ db }, { done }) => {
        const rows = db.table("todos").query().orderBy("_creationTime");
        return done === undefined ? rows.collect() : rows.where("done", done).collect();
      },
    }),
    add: mutation({
      args: { title: s.string({ min: 1, max: 160 }) },
      handler: ({ db }, { title }) => db.table("todos").insert({ title, done: false }),
    }),
    toggle: mutation({
      args: { id: s.id("todos"), version: s.number({ integer: true, min: 1 }) },
      handler: ({ db }, { id, version }) => {
        const todo = db.table("todos").get(id);
        return todo
          ? db.table("todos").patch(id, { done: !todo.done }, { ifVersion: version })
          : null;
      },
    }),
  },
}));
```

The builders infer handler arguments from `args` and infer results from the handler. Add `returns: someSchema` when the output also needs runtime validation and JSON Schema publication; a separate TypeScript result annotation is not required.

Backend queries and mutations are deliberately synchronous and deterministic:

- A query receives a read-only database view and records its dependencies.
- A mutation receives a writable view inside one `BEGIN IMMEDIATE` transaction.
- Insert, patch, replace, and delete are validated before commit.
- `ifVersion` rejects stale patch, replace, and delete operations with `DatabaseConflictError`.
- A thrown error rolls back every write.
- Invalid, non-JSON, or oversized mutation output also rolls back every write.
- The global live revision increments inside the same transaction and persists across restarts.
- Notifications are emitted only after a successful commit.

External network calls and other asynchronous side effects belong in Clank `Action`s. Keeping database functions synchronous prevents a transaction from remaining open across arbitrary awaits and makes the published snapshot unambiguous.

## Query documents

```ts
const table = db.table("todos");
const todo = table.get(id);
const open = table.query()
  .where("done", false)
  .orderBy("_creationTime", "desc")
  .limit(20)
  .collect();
const first = table.query().where("title", "eq", "Ship it").first();
```

Supported comparisons are `eq`, `neq`, `lt`, `lte`, `gt`, and `gte`. `_id`, `_creationTime`, `_version`, and declared fields are queryable. Query values must be SQLite scalar values: string, number, bigint, boolean, or null.

`get(id)` tracks that exact document. A builder query or `collect()` tracks the table. The latter is intentionally conservative: any committed write to that table reruns the query, preserving correctness even when a predicate's membership changes.

## Open the backend

```ts
import { createApi, openBackend } from "@clank.run/framework";
import { backend } from "./backend.ts";

const api = createApi<typeof backend>();
const runtime = await openBackend(backend, {
  path: "./data.sqlite",
  wal: true,
  busyTimeout: 5_000,
});

const initial = runtime.query(api.todos.list);
const id = runtime.mutation(api.todos.add, { title: "Strongly typed" }).value;
runtime.mutation(api.todos.toggle, { id });
```

`createApi<typeof backend>()` is a type-only proxy: property access creates lightweight references such as `todos.list`. It performs no code generation, file watching, or network discovery. TypeScript knows whether each reference is a query or mutation, whether arguments are optional, and its exact result.

`openBackend()` defaults to an in-memory database. A file path enables persistent storage; WAL, `synchronous=FULL`, startup integrity checks, private file permissions, cross-process change polling, and a five-second busy timeout are enabled by default. Call `runtime.close()` during shutdown.

The lower-level `openSQLite(schema, options)` and `createSQLiteDatabase(schema, compatibleConnection)` APIs are available for direct storage integrations.

## Mount RPC and live streams

`runtime.handle(request)` is a complete Fetch-standard backend endpoint. Mount it after application and asset routes:

```ts
const app = createApp()
  .get("/", renderPage)
  .route("*", "*", ({ request }) => runtime.handle(request));
```

The default protocol endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `GET /__clank/manifest` | Function names, kinds, argument schemas, and optional result schemas |
| `POST /__clank/query/{path}` | Validated one-shot query |
| `POST /__clank/mutation/{path}` | Validated atomic mutation |
| `GET /__clank/live/{path}?args=...` | Server-sent query snapshots and heartbeats |

Change the prefix with `openBackend(backend, { prefix: "api" })`. Requests reject cross-site origins by default, JSON bodies and live arguments are bounded, cache size and live connections are capped, and internal failures are redacted.

For private applications, pass `auth: defineAuth()` to `defineBackend`. Clank then mounts `/__clank/auth`, makes normal queries/mutations auth-required, verifies CSRF on mutations, partitions query caches by session, scopes `.owned()` tables, and revalidates live sessions. See [Authentication](auth.md).

Every backend function is also exposed as a typed MCP tool at `/__clank/mcp`. Authenticated
backends automatically add OAuth discovery, PKCE consent, resource-bound bearer tokens, and
read/write scopes; public backends expose the same already-public functions without OAuth. Add
`description` and `agent` metadata to each query or mutation so agents receive precise behavior
and side-effect guidance. Browser interactions that persist or read server state must call these
shared function references rather than creating a separate UI-only action path. Clank fingerprints
the complete agent-visible contract, exposes the revision in discovery and manifests, and
invalidates MCP sessions after deployment so connected clients rediscover changed tools. See
[Agent protocol](agent-protocol.md).

The live transport uses standard SSE framing, sends the persisted revision as the event ID, disables buffering, bounds payloads, and emits a configurable heartbeat. Slow consumers are disconnected and EventSource reconnects with a complete current snapshot.

## Use the inferred browser client

```tsx
import { createApi, createSyncClient } from "@clank.run/framework";
import type { backend } from "./backend.ts";

const api = createApi<typeof backend>();
const client = createSyncClient();
const todos = client.live(api.todos.list);

await client.mutate(api.todos.add, { title: "Streams everywhere" });
console.log(todos.data.value, todos.loading.value, todos.error.value);

// When the component or application scope ends:
todos.dispose();
```

`live()` exposes four signals: `data`, `loading`, `error`, and `version`. Every committed write is compared with cached query dependencies. Only affected queries rerun; all subscribers to the same function and canonicalized arguments receive the resulting snapshot.

`version` is the internal persisted database synchronization cursor. A value such as `36` means 36 change-producing transactions have committed; it is not a record count or connection count. See [Database revisions and correctness](database.md).

`createSyncClient({ url, fetch, eventSource })` accepts a base URL and injectable platform implementations for non-browser runtimes and tests.

For an authenticated backend, use the combined client:

```ts
const client = createClient<typeof backend>();
const todos = client.live(client.api.todos.list);

await client.auth.login({ email, password });
await client.mutate(client.api.todos.add, { title: "Private and live" });
```

This client keeps session credentials in `HttpOnly` cookies and adds the in-memory CSRF token to mutations.

## SSR and cache seeding

Use one shared component for the server and browser. On the server:

```tsx
const initial = runtime.query(api.todos.list);
const page = await renderDocument(<TodoApp todos={initial.value} />, {
  title: "Todos",
  state: { todos: initial.value, version: initial.version },
  scripts: ["/app.js"],
});
```

In the browser, seed the exact live query before it opens and hydrate the same view:

```tsx
const initial = readState<{ todos: Todo[]; version: number }>()!;
const client = createSyncClient();

client.seed(api.todos.list, {}, initial.todos, initial.version);
const todos = client.live(api.todos.list);

hydrate(document.querySelector("#app")!, (
  <TodoApp todos={todos.data.value ?? initial.todos} />
));
```

Seeding prevents a blank loading render and ensures the first client tree matches the server tree. The EventSource still opens immediately and replaces the seed with the authoritative current snapshot.

`renderToString(view)` escapes text and attributes and awaits promised renderables. `renderDocument(view, options)` creates the doctype, metadata, root, optional stylesheets, serialized state, and module scripts. Dynamic expressions and keyed lists receive hydration markers by default. `serializeState()` escapes `<`, `>`, `&`, and Unicode line separators so serialized data cannot close its script element.

Pass a fresh `nonce` to apply a CSP nonce to the generated state and module-script tags.

Hydration attaches bindings, listeners, refs, directives, lifecycle callbacks, and keyed reconciliation to the existing DOM. A mismatch warns and remounts safely. Inspect `root.dataset.clankHydration` for `attached` or `remounted` during diagnostics.

When browser code imports the package name, the document import map must use that exact specifier:

```tsx
<script
  type="importmap"
  dangerouslySetInnerHTML={{
    __html: JSON.stringify({ imports: { "@clank.run/framework": "/dist/index.js" } }),
  }}
/>
```

An import-map key such as `clank` does not resolve `import ... from "@clank.run/framework"`; if it is mismatched, the browser never loads the client entry and hydration cannot begin.

## Run on Node

```ts
import { serve, staticFiles } from "@clank.run/framework/node";

const assets = staticFiles("./public", { cacheControl: "public, max-age=3600" });
const server = await serve(app, { hostname: "127.0.0.1", port: 3000 });
console.log(server.url);

// Later:
await server.close();
```

The adapter translates Node's built-in HTTP request and streaming response objects to Fetch. It supports streaming SSE responses, multiple `Set-Cookie` values, abort propagation, proxy-aware protocol handling, port `0`, and an error hook. `staticFiles()` handles GET/HEAD, MIME types, index files, cache control, URL decoding, and traversal rejection.

## Tailwind

Clank preserves ordinary `class`, reactive `class`, `classList`, style objects, and CSS variables in both SSR and client rendering. Use a compiled Tailwind stylesheet in production. For a zero-install prototype, the full-stack example loads Tailwind's browser build in the document head; that network script is application content, not a Clank runtime dependency.

## Complete example

The working implementation is split by responsibility:

- [`examples/fullstack/backend.ts`](../examples/fullstack/backend.ts): inferred schema and function tree.
- [`examples/fullstack/view.tsx`](../examples/fullstack/view.tsx): shared Tailwind component.
- [`examples/fullstack/server.tsx`](../examples/fullstack/server.tsx): SQLite runtime, SSR template, routes, and Node server.
- [`examples/fullstack/app.tsx`](../examples/fullstack/app.tsx): state read, live-query seed, hydration, and typed mutations.

Run it with `npm run dev:fullstack`, then open `http://127.0.0.1:4180` in two tabs. Changes committed in one tab stream to the other while keyed todo rows retain DOM identity.

The auth-first version is under [`examples/auth-todo`](../examples/auth-todo):

- [`backend.ts`](../examples/auth-todo/backend.ts): auth definition, owned table, required functions.
- [`server.tsx`](../examples/auth-todo/server.tsx): request auth, private SSR, CSP nonce, secure headers, Tailscale-ready proxy settings.
- [`app.tsx`](../examples/auth-todo/app.tsx): one combined auth/RPC/live client and cleanup.
- [`view.tsx`](../examples/auth-todo/view.tsx): shared Tailwind and agent-semantic UI.

Run it with `npm run dev:auth`.

For durable browser edits, see [Offline mutations](offline.md): account-bound queues, transactional
receipts, pending/retry state, and explicit optimistic-conflict reconciliation.
## Persistent notification center

`openNotificationCenter` provides user-owned notifications, read/unread state, per-category
in-app/email preferences, ordinary authenticated RPC/MCP operations, and optional durable email.
It shares the application's SQLite auth database through a separate connection:

```ts
import { openNotificationCenter } from "@clank.run/framework/notifications";
const notifications = await openNotificationCenter({
  path: "app.sqlite", auth: authDefinition, categories: ["updates", "billing"],
  sendEmail: async ({ to, subject, text, idempotencyKey, signal }) => {
    await emailProvider.send({ to, subject, text, idempotencyKey, signal });
  },
});
// Route /__clank/notifications/* to notifications.handle(request).
// Other application routes continue through the main backend/server.
const emailWorker = notifications.startEmailWorker();
notifications.publish({ userId, key: "export:123:ready", category: "updates",
  title: "Export ready", body: "Your report is available.", url: "/exports/123" });
```

`publish` is trusted server code, never an exposed mutation. The recipient must be an active
application account. The notification and optional email job commit together. Per-account keys
deduplicate while the notification is retained; default retention keeps the latest 1,000 per
account, configurable to 10,000. The list returns the newest 100, with a separate total unread
count and mark-all-read operation. Old retained keys may be reused after their notification is
pruned; use your event source's own idempotency policy when a longer guarantee is needed.

```ts
import { createNotificationClient, mountNotificationCenter } from "@clank.run/framework/notifications";
const client = createNotificationClient({ auth: authClient });
const unmount = mountNotificationCenter(document.querySelector("#notifications"), client);
```

The mounted center has explicit refresh, accessible read/unread controls, category preferences,
and visible loading/save failures. The client also exposes `list`, `unreadCount`, `markRead`,
`markAllRead`, `preferences`, and `setPreference` for custom interfaces. Only safe local paths are
accepted as notification links. Custom prefixes use the same full prefix in the server's `prefix`
and client's `url`. Auth cookies/CSRF and user ownership enforce account isolation.

In-app delivery defaults on; email defaults off. Delivery rechecks category preferences, account
status, and the auth system's verified-email state immediately before sending. Opt-outs and
unverified/disabled recipients are skipped. Your mail provider receives a stable notification
idempotency key: use it to deduplicate if a worker loses its lease or crashes after delivery.
Worker retries are durable and may invoke the callback again. A missing provider sends no email.
For tests or an external scheduler, `workEmailOnce()` handles one queued attempt. The email
worker is opt-in and must be stopped with `await emailWorker.close()` before `notifications.close()`.
Unmount the browser center on logout so another account does not see its previous DOM contents.

## Shared threaded comments

`@clank.run/framework/comments` provides persistent resource discussions using the app's existing
SQLite/auth database. Access is explicit: resources have reader, commenter, and moderator members.

```ts
import { openComments, createCommentClient, mountComments } from "@clank.run/framework/comments";
const comments = await openComments({ path, auth });
// Trusted server code grants access after checking the application's sharing policy.
comments.setAccess("project:123", memberId, "commenter");
// Route /__clank/comments/* to comments.handle(request).
const dispose = mountComments(panel, createCommentClient({ auth: authClient }), "project:123");
```

Readers can list/open threads. Commenters can post and manage their own comments; moderators can
edit/remove text and resolve any thread. Membership changes are persisted and invalidate cached
queries. `setAccess(resource, userId, null)` revokes access. Keep comment membership synchronized
with the host resource's sharing rules; knowledge of a resource ID never grants access by itself.
Only trusted server code can change membership, and disabled/nonexistent accounts cannot be added.

The controls support root threads, nested replies, inline editing, removed-text placeholders,
resolution/reopening, older pages, and a draft that survives failed posting. Use a stable `key` with
`client.add` when retrying outside the panel; reusing it with different text or a different parent
fails. Edits, removal, and resolution require the observed comment version. Text is rendered with
DOM text nodes, and author identifiers are displayed without exposing account email addresses.

Each body is limited to 2,000 characters, threads to four reply levels and 50 comments, resources
to 1,000 total comments, and an account to 2,000 resource memberships. Resolved threads reject new
replies until reopened. Root threads paginate in pages of 20; a thread loads its bounded replies
in one request. Removing text preserves reply structure and is not an erasure of historical
revisions or backup copies. The service requires no mail, notification, or collaboration provider.
Close the service and dispose its panel when finished.


## Personal labels

`@clank.run/framework/labels` adds private labels to any app resource without another service. Open `openLabels({ path, auth })` against your SQLite file and route `/__clank/labels/*` to its `handle`. Create `createLabelClient({ auth })` with the same CSRF provider as other Clank clients, then call `mountLabels(element, client, "notes:123")`. Its disposer removes the controls.

The panel creates, renames, recolors, assigns, unassigns, and explicitly confirms deletion of a label and all of its assignments. Names remain visible beside color swatches. Assignments are personal metadata, not permission to read the referenced resource; the host still authorizes the record itself. Resource IDs should be stable and include their type. Labels are private to their creator even when the record is shared.

Programmatic clients expose `list(resource?)`, `save({ name, color, id?, expectedVersion? })`, `assign(resource, labelId, selected)`, and `remove(id, expectedVersion)`. Edits and deletes require the observed version, assignments are idempotent, and deletions remove links in the same transaction. Names are normalized and unique ignoring case; colors must be six-digit hex. Limits are 100 labels, 20 per resource, and 5,000 links per account. No automatic record-deletion hook is implied: unassign labels when a host resource is removed. Existing database backup and history retention policies apply.
