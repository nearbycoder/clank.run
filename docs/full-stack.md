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


## Ordered checklists

`@clank.run/framework/checklists` provides private reusable checklists in the existing SQLite database. Route `/__clank/checklists/*` to `openChecklists({ path, auth }).handle`. Pass your CSRF provider to `createChecklistClient({ auth })`, then mount `mountChecklists(element, client)` and call its disposer on navigation.

The panel creates and renames lists, adds/edits/removes items, moves them with keyboard-accessible up/down buttons, toggles completion, displays progress, resets completion for reuse, and confirms whole-list deletion. Each list stores its ordered items as one atomic document: concurrent completion, text changes, and reorders cannot silently overwrite one another. Refresh after a conflict to review the current list.

Clients expose `list()`, `save({ title, items, id?, expectedVersion?, key? })`, and `remove(id, expectedVersion)`. Each item has a stable `id`, nonempty `text`, and boolean `done`; duplicate IDs are rejected. An update or delete requires the observed list version. For creation retries, retain the same key until the result is known; a previously used key returns the existing list. A default random key is generated per call. Limits are 100 lists per account and 100 items per list, with 100-character titles and 200-character item text. Data survives restarts and remains isolated by the existing account ownership rules. This module creates no reminder or external notification service.


## Personal reminders

`@clank.run/framework/reminders` stores private reminders in your existing database. Route `/__clank/reminders/*` to `openReminders({ path, auth }).handle`, create `createReminderClient({ auth })` with your CSRF provider, and mount `mountReminders(element, client)`. Dispose the panel to clear its minute timer.

The panel schedules and edits a title and local date/time, shows active/due/completed/all filters, snoozes by 10 minutes, one hour, or one day, completes/reopens reminders, and confirms deletion. Due counts update every minute while the page is visible. This is an in-app reminder list: it does not promise delivery while the app is closed, background alarms, email, or push notifications.

Clients expose `list`, `save({ title, dueAt, id?, expectedVersion?, key? })`, `complete(id, completed, version)`, `snooze(id, minutes, version)`, and `remove(id, version)`. Store `dueAt` as an epoch millisecond; `parseReminderTime` converts a local `YYYY-MM-DDTHH:mm` minute and rejects impossible dates and daylight-saving gaps. For repeated fall-back minutes the browser's native earlier occurrence is used. The displayed time follows the current device zone. Snooze uses server time, accepts 1–10,080 minutes, and requires reopening completed reminders first. Edits require the observed version. Creation retries can reuse an explicit key; otherwise each call receives a new key.

Each account can retain 200 reminders. Titles are limited to 160 characters and supported timestamps end at 2100-01-01 UTC. `dueReminders(rows, now?)` computes an ordered due subset locally without mutation. Refresh retrieves changes from other devices; the panel does not silently overwrite an in-progress edit with a live subscription.

## Bookmarks and folders

`@clank.run/framework/bookmarks` adds private saved links without fetching external metadata. Route `/__clank/bookmarks/*` to `openBookmarks({ path, auth }).handle`, create `createBookmarkClient({ auth })` with the host CSRF provider, and mount `mountBookmarks(element, client)`. The panel supports titles, notes, folders, favorites, search, edits, confirmed deletion, and folder renaming. Deleting a folder moves its bookmarks to Unfiled in the same transaction.

`list()` returns the account's bounded folder/link catalog. `save` accepts title, URL, notes, folder ID, favorite, and optional ID/expected version; edits replace the supplied fields and require the observed version. `saveFolder`, `remove`, and `removeFolder` follow the same version checks. A repeated new URL returns the existing bookmark; a repeated folder name returns the existing folder, making creation retries safe. Normalized URLs and case-insensitive normalized folder names are unique per account. Foreign folder IDs are rejected.

Only HTTP(S) URLs without credentials or root-relative app paths are accepted. `normalizeBookmarkUrl` rejects script/data schemes, protocol-relative URLs, control characters, and backslashes. Links never grant access to the target resource; host route authorization still applies. No external URL is fetched by the service. Limits are 500 bookmarks and 50 folders per account, 160-character titles, 500-character notes, and 2,048-character URLs. Dispose the panel and close the service when finished; database retention and backup policy remain the host's responsibility.

## Personal activity timeline

`@clank.run/framework/activity` turns host events into a private, persistent timeline. Open `openActivity({ path, auth, maxEntries? })`, route `/__clank/activity/*` to its handler, and call `activity.record(accountId, { key, title, detail?, kind?, href? })` from trusted server code. The HTTP client cannot forge activity records. Recording verifies that the account exists and is enabled. A retained event key is idempotent; no email, queue, or analytics service is required.

Create `createActivityClient({ auth })` with the host CSRF provider and mount `mountActivity(element, client)`. The panel filters by kind/unread state, loads older pages, marks individual entries read, marks all entries through the newest displayed cursor read, and confirms clearing through that cursor. The latter two actions include other kinds but leave later entries intact. Counts reflect the retained account history. App links must be root-relative and still require host authorization.

Pages contain 25 entries with deterministic timestamp/ID cursors, including events sharing a timestamp. Default retention is the newest 1,000 entries per account, configurable from 25 to 5,000. Titles are limited to 160 characters, details to 1,000, keys to 128, and lowercase dotted/hyphenated kinds to 40. Call `record` after the host operation commits; it is a separate transaction, so this personal timeline is not an atomic audit log or guaranteed event delivery channel. For reliable retries use the same event key; deduplication lasts while that event remains retained. Clearing does not erase independent database history or backups. Close the service and dispose its panel on shutdown/navigation.

## Feedback board and voting

`@clank.run/framework/feedback` provides an authenticated suggestion board on the app's existing SQLite database. Open `openFeedback({ path, auth })`, grant members with trusted `setAccess(boardId, userId, "reader" | "voter" | "moderator")`, and route `/__clank/feedback/*` to `handle`. Revoke with a null role and keep membership synchronized with the host's sharing rules. Persisted membership changes invalidate cached reads. Unknown or disabled accounts cannot be granted access.

Create `createFeedbackClient({ auth })` with the existing CSRF provider and mount `mountFeedback(element, client, boardId)`. Readers browse/search/filter. Voters post ideas, edit their own proposed ideas, withdraw them, and vote once per idea. Moderators can edit all ideas and set proposed/planned/doing/done/declined/withdrawn status. Closed ideas reject new votes but existing voters can remove theirs. Vote operations atomically maintain counts and are idempotent; content/status revisions are separate so a new vote does not spuriously invalidate a moderator's content edit.

The client exposes `list`, `add(board, title, body, key?)`, `edit`, `vote`, and `setStatus`. Preserve the creation key across retries; the panel does so until its draft changes. Content/status changes require the observed version. Boards retain at most 200 ideas, each with a 160-character title and 2,000-character description. The bounded catalog is sorted by votes and filtered locally, avoiding pagination gaps when rankings change. Each account can hold 2,000 board memberships. Text is rendered as text nodes, and email addresses are not exposed. This board has no public anonymous posting, external voting service, or notification provider. Close the service and dispose its panel when finished.


## Availability calendar and slot preview

`@clank.run/framework/availability` adds private dated availability windows without an external calendar provider. Route `/__clank/availability/*` to `openAvailability({ path, auth }).handle`, create `createAvailabilityClient({ auth })` with the host CSRF provider, and mount `mountAvailability(element, client, { blocked, onSelect })`. The calendar marks available days, navigates months, adds/edits/removes windows, and previews 15/30/60-minute slots for the selected day. Times are entered and displayed in the current device zone; storage uses absolute epoch milliseconds. Input rejects impossible local dates and daylight-saving gaps.

The client exposes `list`, `save({ title, startAt, endAt, id?, expectedVersion? })`, and `remove(id, expectedVersion)`. Windows cannot overlap within an account, adjacent boundaries are allowed, and edits/deletes require the observed version. An identical title/time creation retry returns the existing window. Limits are 200 windows per account, 100-character titles, and seven days per window. Dated windows are explicit; no recurring weekly schedule or external synchronization is implied.

`availableSlots(windows, { startAt, endAt, durationMinutes, stepMinutes?, blocked?, bufferMinutes?, limit? })` merges adjacent/overlapping input windows, aligns slots to the window start, excludes overlapping blocked bookings with symmetric buffers, and returns `{ slots, truncated }`. Intervals are half-open, so a slot can start exactly when an unbuffered booking ends. Computation supports up to 1,000 windows and blocked intervals over at most 31 days, with 1–1,440-minute duration/step, 0–1,440-minute buffers, and at most 5,000 results. Duration is actual elapsed time across daylight-saving changes.

Pass current host bookings through `blocked()` for the preview and revalidate/reserve a selected slot in the host's atomic booking mutation. Selecting a preview does not reserve capacity, and this module does not expose another account's calendar. Refresh retrieves changes from other devices. Dispose the panel and close the service when finished.
