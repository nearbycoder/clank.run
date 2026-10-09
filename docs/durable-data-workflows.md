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
push guarantee for externally managed membership changes. The document service also supports revision-aware cursors and reviewed proposals below.
Use the separate [presence service](collaboration.md) for generic room signals and typing indicators.

## Coordinate document selections

```ts
import { mountDocumentCursorPresence } from "@clank.run/framework/collaborative-documents";
const disposeCursors = mountDocumentCursorPresence(cursorContainer, documents, recordId, () => {
  // acceptedDocument is the exact revision displayed in your editor.
  if (hasUnsavedChanges) return null;
  return { revision: acceptedDocument.revision, anchor: editor.selectionStart, head: editor.selectionEnd };
});
```

Custom clients use `setCursor(documentId, selection)`, `cursors(documentId)` and
`clearCursor(documentId)`. Selections count UTF-16 code units and always carry a text revision.
Retained disjoint edits shift selections; deletions clamp positions within the removed range to
the end of the inserted replacement. Missing, noncontiguous or obsolete history discards a peer
cursor and rejects publication with `COLLAB_EDIT_CONFLICT`. Out-of-range coordinates are rejected.

Cursors are session-bound, have opaque public IDs, and never disclose session identifiers.
Publishing requires current document read permission plus normal mutation origin/CSRF checks.
Each cursor-list read also refreshes every participant's session and evaluates their authorization
using their own database ownership scope. Revoked users/sessions disappear before selections are
returned. This is ephemeral presence within one service process: route participants to the same
process when they need to see each other. Restart discards presence; reconnect publishes a fresh
selection. Text revisions remain durable.

`cursorTtlMs` defaults to 30 seconds (1–120 seconds); `maxCursors` defaults to 1,000 (maximum
10,000), with at most 100 cursors per document. Expired cursors are swept on publication/read.
Admission returns `CURSOR_CAPACITY` when full. The DOM helper polls every second, shows current
revision/selection coordinates, clears results on failure, and clears its cursor after any pending
request finishes during cleanup. Return `null` while displaying unsaved local text; those positions
do not describe the accepted server revision. Dispose on logout, navigation and account changes.

## Review named document proposals

```ts
import { mountDocumentBranchReview } from "@clank.run/framework/collaborative-documents";
const base = await documents.read(recordId);
let branch = await documents.createBranch(recordId, crypto.randomUUID(), "Improve greeting", base.revision);
branch = await documents.saveBranch(recordId, branch.id, branch.version, "Proposed text");
branch = await documents.proposeBranch(recordId, branch.id, branch.version);
const disposeReview = mountDocumentBranchReview(reviewContainer, documents, recordId, branch.id);
```

`branches(documentId)` returns at most 100 metadata summaries without source/proposed payloads;
`readBranch` resumes a persisted draft. Branches snapshot the exact source text/revision at creation.
Only the author can save or submit a draft; saving requires its expected version. Any current
document editor can decide a submitted proposal under the service's existing `authorize(..., "edit")`
policy. All branch reads require document read access, including creation and exact creation
retries that return source/proposed text. Creation requires both read and edit access;
read permission alone cannot accept a proposal.
Set `authorizeBranchDecision(context, branch, decision)` for reviewer roles, separation of author
and approver, or decision-specific rules. It must return exactly `true` and is checked again on
every decision/replay, in addition to document read/edit permission. These routes are not
automatically exposed to agents.

`previewBranch` produces current before/after text and exact branch/document fences.
`decideBranch(documentId, id, expectedVersion, "accept" | "reject", documentRevision)` rechecks
permissions and both fences in the write transaction. A changed review returns `BRANCH_STALE`.
Disjoint changes rebase through contiguous retained edit history; overlap returns
`BRANCH_MERGE_CONFLICT`, and old/missing history returns `COLLAB_EDIT_CONFLICT`. The DOM review
shows before/after text, requires a separate acceptance action, and blocks acceptance on conflict.
It still offers rejection of an overlapping/obsolete proposal, with the current fences. Resolve
conflicts explicitly in a fresh branch; the service never silently replaces newer text.

Acceptance records the text operation and terminal branch state atomically. Exact save, submit,
create and decision retries preserve identity across lost responses and restarts; changed retry
inputs or reused creation IDs are rejected. Acceptance returns `acceptedRevision`; a repeated
acceptance never applies another edit. Rejected/accepted branches remain terminal.

The additive `collaborativeBranches` table is reserved service metadata. `maxBranches` bounds live
branch/receipt entries (default 1,000, maximum 10,000); each document admits at most 100.
`maxBranchBytes` bounds UTF-8 source/proposed text across live branches (default 64 MiB, maximum
1 GiB). Admission returns `BRANCH_CAPACITY` without modifying drafts or document text. Terminal
identities are not silently evicted: use an explicitly reviewed retention policy before purging
receipts. Historical snapshots, SQLite WAL files and backups follow independent retention rules.
Each rebase materializes at most 16 MiB of operation JSON; larger histories require a fresh review
against the current revision. Older binaries leave the added table intact; removing the new UI/routes
does not undo accepted text.

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

### Link an index to source rows

For atomic indexing, declare the source once on the server. The application schema is required;
title/body must be required string fields. Owned tables use `scope: "owner"`; public tables use
`scope: { field: "workspaceId" }` with a declared required string scope field and an explicit
scope authorization policy. Names and field identifiers contain ASCII letters, digits and
underscores, begin with a letter and have at most 64 characters.
Optional/defaulted source fields are rejected: normalize defaults into required stored fields
before indexing. Required string schemas, string enums and string literals are supported.

```ts
import { defineDatabase, defineTable, s } from "@clank.run/framework";
import { openSearch } from "@clank.run/framework/search";
const schema = defineDatabase({
  notes: defineTable({ title: s.string(), body: s.string() }).owned(),
});
const search = await openSearch({
  path: "app.sqlite", auth, schema,
  source: { name: "notes", table: "notes", title: "title", body: "body", scope: "owner" },
  authorize: ({ auth }, scope) => auth.requireUser().id === scope,
});
// Bounded server administration; schedule further calls while status is building.
const progress = search.rebuild({ batchSize: 250 });
const diagnostic = search.inspect({ limit: 250 });
```

The core SQLite transaction updates registered source indexes before commit for inserts,
patches, replacements, deletes and record-history restores, including independent connections
opened before registration. A failed index update rolls back source rows, history and index
together. Changing scope removes the old entry. All writers must use the upgraded core before
registration; old binaries and direct SQL writes are unsupported. The index retains each source
version. Each hit must also match the current owner-scoped source row, title, body and scope
before it consumes ranking capacity. Stale, deleted or inaccessible rows are never displayed.
Additional record ACLs still belong in `authorizeRecord`.

At most 16 named indexes can be registered. Each defaults to 50,000 source records and 16 MiB
of indexed title/body bytes; `source.maxRecords` allows 1–50,000 and `source.maxBytes` allows
1 byte–64 MiB. Scope limits and per-record byte limits above also apply. These limits apply to
the final transaction state, allowing valid multi-record byte/scope swaps. Registration rejects
an oversized source table. Rebuild rejects oversized content without advancing its cursor;
correct/delete the offending rows or drain writers and replace the binding with larger bounds.
FTS metadata, SQLite pages/WAL and independent backups have additional physical overhead.

An initial rebuild makes search return `SEARCH_SOURCE_UNAVAILABLE` until complete. Calls process
1–1,000 rows (250 by default), atomically advancing a persistent ID cursor. Source writes remain
indexed during rebuild, including new IDs behind that cursor. Restart or a lost response resumes
committed progress without rewriting application rows. `rebuild()` on a ready index is a no-op.
To repair drift, pass the current ready revision from `inspect()` as `ifRevision`. Starting repair
clears the derived index and starts one bounded batch; a lost-response retry with the old revision
conflicts instead of restarting progress. Inspect current state and resume without `ifRevision`.

`inspect({ cursor, limit })` scans a bounded union of source/index IDs and reports missing, stale,
orphan and duplicate counts, overall indexed bytes/records and `nextCursor`. Follow that cursor to diagnose
the full index. Counts cover the scanned batch; they do not certify unscanned records. Rebuild,
inspect and detach are trusted server-only methods and are never HTTP or agent mutations. A
linked service does not expose manual `upsert`/`remove`, preventing forged source entries.
The browser search control ignores responses and open-record buttons after a scope change or
cleanup. Dispose and remount it on logout/account/workspace changes; external permission changes
are discovered on the next request.

First source registration adds reserved `clank_source_search_indexes` metadata and
`clank_source_search_fts` with its FTS shadow tables. Applications without source registration
gain no search tables. The `source_search_` application-table prefix is reserved; migrate any
existing application tables using that prefix before upgrading. SQLite keeps
`trusted_schema` disabled; no FTS triggers or dependencies are added. Existing manual indexes
remain compatible. Point-in-time recovery explicitly rejects virtual tables, including this FTS
index; use consistent SQLite snapshots and rebuilds. Do not weaken its existing recovery seal.
Search schema initialization is rejected on a database sealed for journaled recovery; do not
register an FTS index in an existing recovery epoch.

Rollback: drain writers, unmount search, call `search.detach(search.inspect().generation)` using
the upgraded service, and then revert code. Detach removes the binding and its derived rows
without changing source rows. Old service handles cannot rebuild or detach a replacement
generation. FTS tables remain as derived infrastructure; their presence still excludes journaled
recovery until an operator removes them after all indexes are detached and a consistent backup
has been taken. Changed definitions/limits require this fenced detach followed by registration;
unmounting alone leaves atomic source indexing active.

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

## Correct and upsert a reviewable import

Enable `reviewable` beside the existing streaming insert-only importer. Raw CSV rows are staged
without converting invalid cells; they remain immutable until the job finishes or is cancelled.
Mappings and typed row corrections are stored separately and apply only to unprocessed rows.
A changed file or initial mapping cannot resume an existing import identity.

```ts
import {
  openDurableImport, createDurableImportClient, mountReviewableImporter,
} from "@clank.run/framework/durable-import";

const imports = await openDurableImport({
  path: "app.sqlite", auth, schema, table: "records", fields: ["title", "score"],
  uniqueBy: ["title"], batchSize: 100,
  reviewable: { duplicates: "upsert" },
});
// Mount this handle at /__clank/imports through your existing HTTP router.
const currentUser = () => browserAuth.user.value?.id ?? null;
const client = createDurableImportClient<{ title: string; score: number }>({
  auth: browserAuth, currentUser,
});
const columns = [
  { source: "name", target: "title", type: "text" as const, required: true },
  { source: "points", target: "score", type: "integer" as const, required: true },
] as const;
const dispose = mountReviewableImporter(importContainer, client, { columns, currentUser });
// Dispose and remount on account/workspace changes and navigation.
```

For a custom UI, call `uploadReviewableCsv(file, columns, { key, id })`, then `sourceWindow(id)`
to inspect a bounded page of raw rows and current corrections. Supply a stable creation `key`
when retrying an upload whose initial response might be lost; the widget does this while mounted. CSV row numbers include the
header, so the first data row is 2. Save changes through `correctMapping(id, revision, columns,
operationId)` or `correctRows(id, revision, [{ row: 2, values: { score: 5 } }], operationId)`.
Use the current `job.review.revision`. Corrections must match declared target field types and
cannot alter processed rows. Changing a mapping affects remaining rows; saved value corrections
take precedence over that mapping. Applied target records and immutable chunks are untouched.

Call `preview(id)` to see authorized `insert`, `update`, `skip` or `invalid` effects and before/after
values for declared import fields. Accept that exact preview with `apply(preview, operationId)`.
The server recomputes it inside the SQLite write transaction and checks canonical source identity,
source batch, correction revision, job version/progress, route definition and existing target
versions. An unrelated target write does not invalidate a batch; an affected version or changed
matching key does. If any row is invalid, acceptance records a failed job without applying any
target writes or advancing progress. Inspect and correct those rows, then preview again.
`run`, `step`, legacy `append` and legacy `seal` cannot bypass reviewable batch acceptance.

The default reviewable duplicate policy is `error`. `skip` preserves a matched record and its
version. `upsert` requires nonempty scalar string/number/boolean `uniqueBy` fields, rejects missing/null identities and accepts
exactly one matching record in the current owner scope. Multiple matches and repeated identities
within a batch fail explicitly. Updates preserve unmapped fields. Inserts still require the full
target schema, including defaults. Values outside declared import fields are omitted from previews.
For unowned tables, both `authorizeRead` and the existing write `authorize` are mandatory; read
policy runs before returning existing values, and write policy checks both existing and proposed
records. All policies are synchronous, current and fail closed. Async/rejected policies grant no
access. These service writes do not invoke separate application mutation handlers.

Give each accepted correction or batch a stable operation ID. The exact result, target writes and
progress commit together. Retry the same input/ID after a lost response or restart; it returns the
retained result without another update. Reusing an ID for changed input conflicts. Current session,
owner and target authorization are still required for replay. If a target is deleted or no longer
authorized, its successful receipt cannot be retrieved. Retained results describe their original
acceptance, so use `inspect(id)` for current progress. The widget retains operation IDs across
retries while mounted and offers **Refresh import progress** to reconcile a lost response.

Reviewable files are limited to 5 MiB and 50,000 rows. SHA-256 covers canonical parsed headers plus
raw row arrays, each JSON-encoded with a trailing newline; the server hashes persisted chunks at
seal and verifies the client fingerprint. This identifies parsed data: equivalent quoting or line
endings yield the same identity. It does not attest verbatim file bytes. A canonical source is
bounded to 16 MiB (`maxSourceBytes` can lower it). Existing import job, chunk and global staging
limits also apply. Source windows allow at most 100 rows and previews use the configured batch
size (at most 500); each response is capped at 1 MiB. Request a smaller source window or configure
a smaller batch when values exceed that bound. Matching and accepted inserts are admitted only within `maxTargetRecords`
(default/maximum 50,000 records in the owner scope, or the whole unowned target); index unique
fields for efficient lookups. This capacity check is separate from record authorization.

`reviewable.maxCorrections` and `maxReceipts` default to and cannot exceed 100,000 global rows each.
Current correction bytes default to 16 MiB, at most 64 MiB via `maxCorrectionBytes`; receipt result
and target-ID bytes default to 32 MiB, at most 128 MiB via `maxReceiptBytes`. A row correction and
individual receipt result are at most 64 KiB. Capacity exhaustion rejects the entire operation;
receipts are never silently removed to permit potentially repeated writes. Correction replacement
retires its superseded document-history copy; completion/cancellation retires raw chunks, current
corrections and their document history in bounded pages. Source hash, initial mapping fingerprint,
job metadata and operation receipts remain. SQLite pages/WAL and independent backups need their
own retention policies; this does not erase archived physical bytes.

Enabling this mode adds owned correction/operation tables and defaulted metadata on import jobs and chunk checksums.
`DurableImportClient` retains its streaming-only structural contract; the factory returns the
additive `ReviewableImportClient<Values>` subtype. Legacy job outputs and streaming behavior remain available. The widget clears displayed source/preview data when a request detects session/access revocation.
Register feature tables before sealing
a PITR schema; the existing recovery schema guard still applies. Finish/cancel active reviewable
jobs and drain writers before changing their target schema, mapped field declaration, uniqueness,
duplicate policy or batch size. These definitions are fenced across restart. Direct SQL changes
and older import binaries writing reviewable metadata are unsupported. For rollback, finish or
cancel reviewable jobs, unmount their controls and keep retained source identities/operation
receipts. Use the upgraded importer to inspect those receipts; ordinary application CRUD remains
usable. No dependencies, new package files or release size allowances are added.
