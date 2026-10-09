# Facets, paging and saved searches

Enable browsing on a source-linked search service when a screen needs complete authorized
facet counts, stable pages and account-owned saved definitions. The existing manual search
service, `SearchClient.search()` and `mountSearch()` remain available.

```ts
import { defineDatabase, defineTable, s } from "@clank.run/framework";
import { openSearch } from "@clank.run/framework/search";

const schema = defineDatabase({
  notes: defineTable({ title: s.string(), body: s.string(), category: s.string() }).owned(),
});
const search = await openSearch({
  path: "app.sqlite", auth, schema,
  source: {
    name: "notes", table: "notes", title: "title", body: "body", scope: "owner",
    facets: ["category"],
  },
  browsing: { policyRevision: "notes-policy/1" },
  authorize: ({ auth }, scope) => auth.requireUser().id === scope,
});
while (search.rebuild({ batchSize: 250 }).status !== "ready") {}
```

The application owns the session and the scope/record policies. For public source tables,
declare the persisted scope field and check current membership. Browser scope strings grant
no access. Policies must return `true` synchronously; rejected promises are contained and
access is denied. Update `policyRevision` whenever policy semantics change. Source-linked
index registration, repair, detach and writer-upgrade requirements still apply; see
[durable data workflows](durable-data-workflows.md#link-an-index-to-source-rows).

Declare at most eight distinct scalar source fields. Strings, finite numbers, booleans, null,
scalar unions and optional scalar fields are supported. A missing optional field counts as
null. Arrays and nested objects are rejected. Facet strings have a 200-character bound; a
source value outside that bound makes browsing unavailable until corrected.

```ts
import { createSearchBrowsingClient, mountSearchBrowsing } from "@clank.run/framework/search";

const client = createSearchBrowsingClient({ auth: browserAuth });
const definition = { text: "launch", filters: [{ field: "category", value: "release" }], sort: "title" } as const;
const first = await client.browse(currentUserId, definition, { limit: 20 });
if (first.nextCursor) {
  const next = await client.browse(currentUserId, definition, { limit: 20, cursor: first.nextCursor });
}
const dispose = mountSearchBrowsing(container, {
  client, currentUser: () => currentUserId, scope: () => currentUserId,
  fields: ["category"], open: id => navigateToRecord(id), pageSize: 20,
});
```

`text` accepts up to 500 characters and one to ten literal words combined with AND. Empty
text browses the entire scope. Filters use AND equality, with at most one filter per declared
facet. Values retain their types: `1`, `"1"`, true and null are distinct. Facets describe the
complete authorized match set **after all filters**; they are not disjunctive suggestions.
Each field returns `{ value, count }` entries. Counts include each source record once.

Relevance uses the existing per-record word scores, never global hidden-document statistics.
Title ordering uses NFC-normalized lowercase strings. Both orders use raw string ID ordering
to break ties, without depending on host locale settings. Snippets retain the original text.
Current record policy runs before values are fetched, ranked or counted. Indexed source
version, title/body and scope must agree with the current owner-scoped source row. Inaccessible,
stale, orphaned and duplicate entries contribute no values, counts, snippets or scores.

Pages return `hits`, complete `total`, `facets`, `revision` and `nextCursor`. The opaque cursor
pins current user, scope, canonical definition, index generation/revision, facet declaration,
policy revision and the currently authorized source versions. Each page rechecks current
access. A changed index, policy, ACL or definition returns `SEARCH_CURSOR_STALE` (409);
discard the cursor and search again. Index revisions include writes to hidden records, so
such a write can invalidate a cursor without exposing that record. Repair/replacement never
silently skips or duplicates a page. A rebuilding/detached index returns
`SEARCH_SOURCE_UNAVAILABLE` (503).

Browsing examines at most `maxCandidates` authorized candidates (5,000 by default, maximum
50,000), 16 MiB of current source JSON and 100 distinct values per facet. The existing whole
scope and index admission bounds still apply. These checks happen before large source values
are materialized. Unlike legacy limited search, overflow returns `SEARCH_BROWSING_CAPACITY`
(503), with no partial facet result. Filters do not rescue a source that exceeds examined
candidate/byte bounds; narrow text, partition the scope or adjust the declared source.
Pages contain 1–100 hits. Cursor input is capped at 2,000 characters and serialized definitions
at 8,000 characters.

## Save and edit definitions

```ts
const saved = await client.save(currentUserId, {
  key: "daily-release", expectedRevision: 0, name: "Daily releases", definition,
});
const edited = await client.save(currentUserId, {
  key: saved.key, expectedRevision: saved.revision, name: "Release review", definition,
});
const mine = await client.saved(currentUserId);
await client.removeSaved(currentUserId, edited.key, edited.revision);
```

A caller-selected key contains 1–120 characters and is owned by the current account, index
and scope. New definitions use revision zero; edits/deletes require the observed positive
revision. Names contain 1–100 characters and must remain nonempty after trimming. SQLite
commits each mutation and its last accepted fingerprint/result together. An identical retry
of the latest accepted save/delete returns the same revision after a lost response or restart.
A changed retry or older edit returns `SEARCH_DEFINITION_STALE` (409) and never executes again.
Current scope/session authorization applies before accepted-result replay.

Deletion clears the name, definition and declaration while retaining a compact key, revision
and retry fingerprint. A retired key cannot be recreated; choose a new key. This prevents an
old creation retry from silently creating a different definition. The widget retains uncertain
creation keys while mounted; after remount, refresh saved searches before creating another
definition. It supports load, rename/edit, save, delete and a new-definition action.

Definitions are pinned to the index generation, declared facets and policy revision. A changed
declaration returns `usable: false` and `definition: null`; private stale filters are never
automatically applied. Replace it using the observed revision and current definition, or delete
it. Ordinary source edits change result cursors but do not make saved query intent unusable.

Defaults allow 50 live definitions per account/index/scope (`maxSavedSearches`, maximum 200),
10,000 identities across the database (`maxSavedIdentities`, maximum 50,000), and 16 MiB of
logical stored metadata (`maxSavedBytes`, maximum 64 MiB). Global bounds include compact deleted
identities. Capacity applies backpressure and rolls back the complete mutation; accepted retry
identities are never silently evicted. SQLite page/WAL/backup overhead is additional.

The widget fences asynchronous replies and saved/result actions by account and scope, clears
private forms/results on detected identity change or denied access, and drops late replies on
disposal. Host applications should remount/dispose it when their session changes; a getter
cannot push an immediate logout notification by itself. All values render as text. Current
browser CSRF headers are attached to POST queries and mutations.

## Persistence and rollback

Browsing is opt-in and adds versioned private definition metadata to the same SQLite database.
It does not change the source-index binding format or register extra source projections.
Disabled browsing adds no definition metadata. Native writes execute inside the existing host
mutation transaction; current queries use its read snapshot and have no query cache. Saved
definitions are retrieved explicitly and are not a live-query subscription API.

Drain newer browsing writers before reverting to older code. Older binaries continue legacy
search and leave definition metadata intact. Do not remove retained keys to enable old retry
reuse. Unsupported metadata protocols fail closed. Source writers still require the existing
upgraded source-search implementation; direct trusted SQL modification and independently
retained backups remain outside the browser contract. Source-linked FTS retains its documented
point-in-time recovery incompatibility; this feature does not add transparent FTS recovery.
