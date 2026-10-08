# Durable data workflows

Clank includes authenticated services and DOM controls for shared document editing, server search,
bulk changes, shared views, and resumable CSV imports. They use SQLite and the existing auth,
origin, and CSRF checks. Browser helpers use same-origin cookies and accept the same `auth` client
as `createSyncClient`. Every `mount…` function returns a cleanup function; call it on navigation,
workspace changes, or logout.

## Mount services beside your backend

The server supplies the database schema, editable fields, and authorization rules. Browser input
cannot select a different table or policy. Use the same SQLite path and auth definition as your
application. Pass its schema when authorization needs to read application records:

```ts
import { openBulkEditor } from "@clank.run/framework/bulk-edit";
import { openDurableImport } from "@clank.run/framework/durable-import";

// auth, schema, and application are your existing server definitions/runtime.
// This example's records table is .owned(), with title:string and score:integer.
const bulk = await openBulkEditor({
  path: "app.sqlite", auth, schema, table: "records", fields: ["title", "score"],
});
const imports = await openDurableImport({
  path: "app.sqlite", auth, schema, table: "records", fields: ["title", "score"],
  uniqueBy: ["title"], batchSize: 100,
});
const services = new Map([
  ["/__clank/bulk", bulk], ["/__clank/imports", imports],
]);
async function handle(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  for (const [prefix, service] of services) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return service.handle(request);
    }
  }
  return application.handle(request);
}
// On shutdown: close each service, then your application runtime.
```

Other default mount prefixes are `/__clank/documents`, `/__clank/search`, and
`/__clank/shared-views`. Set a service's `prefix` and the browser client's `url` together when
changing them. Route feature prefixes before the application's general `/__clank` handler.
These services are not automatically published as agent tools.

All authorization callbacks are **synchronous** and must return exactly `true` to grant access.
Use the provided `context.db` to evaluate current membership and row permissions in the same
transaction as the operation. An async callback returns a Promise and is denied. Query caching is
disabled for these services, so each HTTP read reevaluates current access, including policies
backed by external state. External permission changes do not proactively erase data already
rendered in another browser; refresh, polling, and subsequent operations discover revocation.

Owned tables retain the backend's account isolation. Bulk edits and imports targeting an unowned
table require an explicit `authorize` callback. For example, a policy for an application with an
unowned `memberships` table indexed by workspace/user can read it synchronously:

```ts
import type { AuthRequest, ReadDatabase } from "@clank.run/framework";

function canWrite(
  { auth, db }: { auth: AuthRequest; db: ReadDatabase<typeof schema> },
  record: Readonly<Record<string, unknown>>,
) {
  if (typeof record.workspaceId !== "string") return false;
  const member = db.table("memberships").query()
    .where("workspaceId", record.workspaceId)
    .where("userId", auth.requireUser().id).first();
  return member?.role === "owner" || member?.role === "editor";
}
```

Supply that policy to both services when the target is shared. Include `workspaceId` in imported
fields when it belongs to the target schema, and validate it through the policy. Do not authorize
from a browser-supplied role or an assumed current workspace. The backend's other application
mutation handlers are not called by these services: keep all required field constraints in the
schema and all required record rules in the supplied service policy.

## Preview and apply a bulk edit

```ts
import { createBulkEditClient, mountBulkEditor } from "@clank.run/framework/bulk-edit";
const client = createBulkEditClient({ auth: browserAuth });
const dispose = mountBulkEditor(bulkContainer, client, {
  selection: () => selectedRecordIds,
  changes: () => ({ score: Number(scoreInput.value) }),
  applied: () => refreshRecords(),
});
```

The control displays the before/after records and requires a separate apply action. The service
validates every selected record, editable field, schema value, permission, and reviewed version.
Apply rechecks all of them inside one transaction before writing any row. A denied or stale row
rejects the entire batch. The default limit is 200 records; `maxRecords` allows up to 1,000.
Preview includes each record's declared fields, so preview authorization must grant record read
access as well as permission to propose the change.

For custom UI, call `preview(ids, changes)` and pass its result to `apply(preview)`. A
`BULK_PREVIEW_STALE` response requires a fresh preview. If a response is lost, refresh current
records before retrying: the transaction may have committed even though the browser received no
confirmation. This service edits database records; enqueue external effects through your own
application's durable job flow when they are required.

## Persist collaborative document edits

```ts
import { openCollaborativeDocuments } from "@clank.run/framework/collaborative-documents";
import { s } from "@clank.run/framework";
const documents = await openCollaborativeDocuments({
  path: "app.sqlite", auth, schema,
  authorize({ auth, db }, documentId, operation) {
    const record = db.table("records").get(s.id("records").parse(documentId));
    // .owned() applies the current account; replace with a shared membership policy as needed.
    return record !== null;
  },
});
// Mount documents.handle under /__clank/documents as above.
```

```ts
import {
  createCollaborativeDocumentsClient, mountCollaborativeEditor, textEdit,
} from "@clank.run/framework/collaborative-documents";
const documents = createCollaborativeDocumentsClient({ auth: browserAuth });
// Create once after authorizing the corresponding application record.
await documents.create(recordId, "Initial text");
const dispose = mountCollaborativeEditor(editorContainer, documents, recordId);
// A custom editor can submit a bounded splice using a stable ID across network retries:
const before = await documents.read(recordId);
const operation = {
  documentId: recordId, operationId: crypto.randomUUID(), baseRevision: before.revision,
  ...textEdit(before.text, "Revised text"),
};
await documents.edit(operation);
```

Text, revisions, edit history, and operation fingerprints survive server restart. Concurrent edits
to disjoint ranges are transformed against retained operations. Overlapping ranges or a revision
older than the retained window return `COLLAB_EDIT_CONFLICT`. Positions count JavaScript UTF-16
code units, matching string slicing. The editor retains unsaved text when remote edits arrive,
shows the latest server text, and offers explicit discard or rebase before saving again.

A retry must reuse the same operation ID and exact input. Reuse with different content is rejected;
an exact retry returns the current document and the original `acceptedRevision`. The default text
limit is 200,000 code units (maximum 1,000,000); `retainedOperations` defaults to 1,000 (maximum
10,000). `retainedReceipts` defaults to 10,000 revisions and must be at least
`retainedOperations`. Receipts older than that window are pruned atomically with the next edit.
Pruning also retires the deleted operation/receipt's document-history copies. Existing archives,
SQLite WAL files and independent backups require their own reviewed retention policy.
An expired exact retry has an obsolete base revision and returns `COLLAB_EDIT_CONFLICT`; it
cannot apply the edit again. `maxReceipts` bounds live receipts across the service (100,000 by
default, maximum 1,000,000). Admission fails with `COLLAB_RECEIPT_CAPACITY` when full; retire
inactive documents through an explicitly reviewed retention policy rather than evicting valid receipts.

`subscribe(id, listener, intervalMs)` polls every second by default and rechecks authorization on
each read. It calls `listener(null, error)` on denied/unavailable reads; the built-in editor clears
text and disables editing then. Cleanup cancels further deliveries. There is no instantaneous
push guarantee for externally managed membership changes. Use the separate
[presence service](collaboration.md) when cursors or typing indicators are also useful.

## Search authorized records

```ts
import { openSearch } from "@clank.run/framework/search";
import { s } from "@clank.run/framework";
const search = await openSearch({
  path: "app.sqlite", auth, schema,
  authorize: ({ auth }, scope) => scope === auth.requireUser().id,
  authorizeRecord: ({ db }, indexed) => db.table("records").get(s.id("records").parse(indexed.id)) !== null,
});
// Trusted server code, after loading the authoritative record:
search.upsert({ scope: ownerId, id: record._id, title: record.title, body: record.description });
// On deletion: search.remove(ownerId, recordId).
```

```ts
import { createSearchClient, mountSearch } from "@clank.run/framework/search";
const search = createSearchClient({ auth: browserAuth });
const dispose = mountSearch(searchContainer, search, {
  scope: () => currentUserId,
  open: id => navigateToRecord(id),
});
```

SQLite FTS5 persists the index. Index updates are trusted server methods, never exposed browser
mutations. Integrate `upsert`/`remove` with a durable application outbox or indexing worker;
index writes have their own transaction, so indexing is eventually consistent with a separate
business write. Keep `authorizeRecord` tied to current authoritative records when deletion or
record permissions can change independently of the index.

Scope authorization runs before candidate retrieval, and optional record authorization runs
before fetching text, scoring, or generating snippets. Scores use only each accessible record's
text, not statistics from hidden documents. Queries accept 1–10 literal words, combined with AND;
user-supplied FTS operators are not executed. Results contain text snippets, rendered using
`textContent` by the control.

A request returns up to 100 hits (20 by default), ranks at most 5,000 **authorized** candidates
by default (`maxCandidates` up to 50,000), and stops after 16 MiB of authorized text. Denied
matches neither consume that budget nor change `total` or `truncated`. `maxScopeRecords` bounds
each entire scope to 50,000 entries by default (maximum 50,000, at least `maxCandidates`);
indexing a new record at capacity rejects atomically. An oversized legacy scope returns
`SEARCH_SCOPE_CAPACITY` independently of the query phrase; partition or rebuild it before
serving searches. `total` counts authorized matches within the ranking budget, not the entire
corpus; `truncated` tells the UI to narrow the search. Ranking folds accents and snippets retain
the original spelling and text coordinates.
Indexed titles are limited to 1,000 UTF-8 bytes and bodies to 1 MiB each.

## Publish shared saved views

```ts
import { openSharedSavedViews } from "@clank.run/framework/saved-views";
const views = await openSharedSavedViews({
  path: "app.sqlite", auth, schema, fields: ["title", "score"],
  authorize({ auth, db }, workspaceId, operation) {
    const member = db.table("memberships").query()
      .where("workspaceId", workspaceId).where("userId", auth.requireUser().id).first();
    if (!member) return false;
    if (operation === "read") return true;
    if (operation === "default") return member.role === "owner";
    return member.role === "owner" || member.role === "editor";
  },
});
```

```ts
import { createSharedViewsClient, mountSharedSavedViews } from "@clank.run/framework/saved-views";
const views = createSharedViewsClient({ auth: browserAuth, workspaceId });
const dispose = mountSharedSavedViews(viewsContainer, views, {
  current: () => currentViewDefinition,
  apply: definition => updateView(definition),
});
```

Every view is visible to currently authorized workspace readers. Its author chooses who may edit:
`owner` (default) or `workspace` editors permitted by the policy. Only its author can change that
choice. Authors still require current workspace membership. Updating/deleting requires the
reviewed `expectedRevision`; stale writes return `VIEW_CHANGED`. Setting a workspace default
requires the separate `default` policy, and one transaction keeps at most one default.

The control exposes update/delete/default controls according to the server's current capabilities.
Each workspace allows 50 views by default (`maxViews` up to 200). Declared fields bound filter,
sort, and column definitions. A saved filter never grants access to data: apply it only to records
returned by an authorized query. Existing account-private `openSavedViews` storage and behavior
remain available separately.

## Resume large CSV imports

```ts
import { createDurableImportClient, mountDurableImporter } from "@clank.run/framework/durable-import";
const imports = createDurableImportClient({ auth: browserAuth });
const columns = [
  { source: "Title", target: "title", type: "text", required: true },
  { source: "Score", target: "score", type: "integer", required: true },
] as const;
const dispose = mountDurableImporter(importContainer, imports, { columns });
```

The control uploads, shows the durable import ID, starts/resumes execution, refreshes progress,
retries a failed batch, and cancels remaining rows. Save the ID to resume after browser restart.
For custom UI, use `uploadCsv(file, columns, { id, progress })` to resume an upload with the same
file, then `run(id, { progress, signal })`. The CSV reader streams files up to 100 MiB, including
quoted newlines, through bounded chunks instead of buffering the entire file. Each record is
bounded to 1 MiB of text; encoded JSON chunks are bounded to 4 MiB and 500 records. A server job
allows up to 1,000,000 rows, configurable downward with `maxRows`.

Chunks and progress live in owned SQLite tables. Reuploading starts from the file's beginning to
compare every previously stored normalized chunk; changed content returns `IMPORT_CHUNK_CHANGED`.
Job creation also accepts a caller-supplied stable key for retrying creation. Another account
cannot inspect, append to, execute, or cancel the job.

`run` drives bounded server transactions from the client; there is no hidden background worker.
The default apply batch is 100 rows (`batchSize` up to 500). Each batch reevaluates the current
schema, access rules, and optional `uniqueBy` constraint for every row before any target insert.
Any failed row persists safe row-number/error-code diagnostics and leaves the batch cursor and
all target records unchanged. Prior successful batches remain committed. Duplicate rows fail by
default; opt into `duplicates: "skip"` to count and skip them.

Insertions and cursor advances commit together. Retrying the same processed-row cursor after a
lost response returns durable progress without inserting a second copy. `retry` reopens only a
failed job after the underlying permission/duplicate problem is resolved; uploaded chunks are
immutable. Cancel prevents remaining batches and keeps already imported rows. Aborting or
unmounting the browser stops future requests, but a dispatched batch may still commit.

At most 20 unfinished imports are allowed per account. Completion or cancellation atomically
retires staged chunks and their document-history snapshots, retaining the small job receipt and
cursor so create/step retries cannot insert twice. Appending to a terminal job returns
`IMPORT_PAYLOAD_RETIRED` (410); inspect its receipt instead of reuploading. Cancelling an older
terminal job also retires any legacy chunks. This does not erase independent backups, WAL
pages or point-in-time recovery journals; their retention policies still apply.

`maxJobs` bounds all live job receipts (10,000 by default, maximum 100,000); old stable keys remain
reserved and new creation at capacity returns `IMPORT_JOB_CAPACITY`. `maxChunks` bounds each
job (2,000 by default, maximum 10,000), with a service-wide limit of 10,000 staged chunks.
`maxStagedBytes` bounds normalized live source payloads across all accounts (1 GiB by default,
maximum 4 GiB); staging at capacity returns `IMPORT_STAGING_CAPACITY`. Finish/cancel staged
jobs or review retention before increasing limits. These bounds include terminal receipt metadata
and avoid treating a deleted retry key as a new import.
The existing small-file CSV planner remains available for previews and simpler workflows.

## Database upgrades and rollback

These services add their internal tables on first open; they do not rewrite existing application
records or automatically backfill an index. Reserved names are `sharedSavedViews`,
`collaborativeDocs`, `collaborativeOperations`, `collaborativeReceipts`, `durableImportJobs`,
`durableImportChunks`, and `clank_search_fts`. Search without an application schema also uses
`searchServiceState`. Keep one compatible schema/auth definition for each shared SQLite file.

Take a consistent SQLite backup before enabling services or changing target schemas. For imports,
finish/cancel active jobs before incompatible schema changes; stored rows are validated again on
execution and may require a new job. Rollback can unmount the feature endpoints and controls;
keep their tables so a later compatible version can resume safely. Do not remove receipt or
cursor metadata and then replay old requests. Already committed bulk edits, imports, and document
edits require your application's data history/restore policy or a coordinated database restore;
unmounting a service does not reverse writes.
