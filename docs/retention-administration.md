# Retention administration and holds

`@clank.run/framework/retention-administration` provides one scoped operator inventory,
reviewed purge batches, durable holds and periodic cleanup rules for import source metadata,
collaboration operations/receipts and signed platform audit exports. Application sources share
one SQLite database; the platform's audit inventory remains in its own control database.
A browser-supplied scope is never an ownership assertion: the server resolves every resource
from persisted source identity and checks the current session and operator policy.

## Declare application sources and authority

Open the source services and retention service with the same application schema, auth definition,
SQLite path and collaboration character limit. Keep scope and authorization callbacks synchronous
and read their decisions from trusted persisted data. Declare a new `policyRevision` whenever the
resolver or authorization policy changes; active schedules pause until reviewed under that revision.

```ts
import { openRetentionAdministration } from "@clank.run/framework/retention-administration";

const retention = await openRetentionAdministration({
  path: "app.sqlite", auth, schema,
  sources: { imports: true, collaboration: { maxCharacters: 200000 } },
  policyRevision: "retention-policy/1", intervalMs: false,
  scope({ db }, resource) {
    if (resource.kind === "import") return db.table("importScopes").query()
      .where("ownerId", resource.ownerId!).first()?.workspaceId ?? null;
    return db.table("documentScopes").query()
      .where("documentId", resource.id).first()?.workspaceId ?? null;
  },
  authorize({ auth, db }, workspaceId, operation) {
    const member = db.table("memberships").query().where("workspaceId", workspaceId)
      .where("userId", auth.requireUser().id).first();
    return member?.role === "owner" || member?.role === "admin";
  },
});
```

Mount `retention.handle` at `/__clank/retention` beside the existing auth/source handlers.
The service exposes browser queries and mutations; it does not expose agent actions. The native
SQLite controller and scoped writer are private implementation details, not arbitrary-table SQL
or cross-owner application mutation APIs. Async, rejected or non-boolean policies fail closed.
The controller refreshes the persisted session and reads current authorization inside the host
transaction, including when returning an exact previously accepted receipt.

## Inventory, review and accept

```ts
import { createRetentionAdministrationClient, mountRetentionAdministration }
  from "@clank.run/framework/retention-administration";

const client = createRetentionAdministrationClient({ auth: browserAuth });
const dispose = mountRetentionAdministration(document.querySelector("#retention")!, {
  client, currentUser: () => currentUserId, scope: () => currentWorkspaceId,
  kinds: ["import", "collaboration"], maxDeletes: 1000,
});
```

The widget displays current payload, receipt and history counts, the protected subset and active
or expired holds. Select resources, choose a past cutoff and review the explicit batch before
accepting it. Keep the same operation ID and exact preview when retrying an ambiguous result.
The server hashes a private snapshot of source data, policy, hold revision, current versions and
selected rows. Changed input rejects with `RETENTION_STALE`; a fresh preview is required.
Current authorization is checked again before either execution or receipt replay. Source removal
and the accepted receipt commit together. Disconnects and process death cannot expose a partial
purge. The browser preserves uncertain operation IDs while mounted, clears private forms/data
on detected account or scope changes/revocation, and drops responses after disposal.

Inventory pages contain at most 100 resources (default 50). Cursors pin the authorized inventory
and policy generation. A changed authorized resource invalidates the cursor; denied resources do
not appear in counts, bytes or cursor contents. The global resource admission ceiling still
includes denied sources and can refuse a database that exceeds its declared capacity.

## What the initial policy retires

- Imports: only completed or cancelled jobs qualify. Retire retained chunks, row corrections and
  their document-history copies; replace full correction/apply operation results with compact
  expired identities. Job metadata, original source identity and operation fingerprint remain.
  Replaying an expired accepted import operation returns `410 IMPORT_OPERATION_EXPIRED`; it
  cannot execute again. Application records created or updated by the import remain unchanged.
- Collaboration: retire old edit operations/receipts and their associated history. Advance the
  persisted retry floor so old revisions cannot recreate a retired edit. Current text, document
  identity, branches and their histories remain protected. Reconnect against current text;
  edits older than the floor reject with `COLLAB_EDIT_CONFLICT`.
- Platform audit: only independently acknowledged signed events qualify. Retire the local raw
  event and any held signed envelope together. Unacknowledged events remain blocked even when
  no signer is configured. Capture/export checkpoints and the increasing audit sequence remain,
  so independent archive verification continues after local retirement.

A record and its history group retire as one unit. If that group exceeds `maxDeletes`, the batch
leaves it intact; choose a larger permitted bound. Protected rows are a subset of the displayed
current/history/identity totals, rather than an additional disjoint storage category. Byte counts are UTF-8
logical stored data, not file allocation. Purges do not erase SQLite pages, WAL, backups, independent
archives, PITR journals, imported application values or protected document text/history.

## Holds and schedules

`hold(scope, resource, expectedVersion, reason, expiresAt, operationId)` creates or replaces a
hold; use version 0 only for a missing hold. Expiry is a future UTC millisecond timestamp or null
for a continuing hold. `release` requires the inspected version. Hold versions increase across
release/recreation, so a stale release cannot remove a replacement hold. Expired holds remain
inspectable and consume capacity until explicitly released. A hold suppresses source-service
payload/history pruning, collaboration receipt pruning and acknowledged-envelope removal across
already-open upgraded connections and restarts, including the database's global and per-document
history cleanup. Existing source admission limits still apply. Held source history has a fixed
per-database ceiling of 100,000 snapshots and 128 MiB of UTF-8 snapshot data. New holds and
application writes roll back with `RETENTION_CAPACITY` when they would exceed that bound;
cleanup never drops held snapshots to admit more work. Release/expire holds and review the
retention policy before resuming writes. Current source rows have their own source-service bounds.

Holds follow the source identity after a trusted scope transfer and keep blocking retirement.
Their reasons are only visible in the original scope. Release requires the original hold scope and
current source scope to match; resolve a transfer under the application's trusted administrative
policy before releasing. Changing the resolver alone cannot silently clear evidence holds.

`saveSchedule(input, operationId)` persists a versioned rule with kinds, minimum age, cadence,
maximum deletions and active/paused state. The creating browser session and operator identity
remain its execution principal. `runDue()` is a trusted server entry point and returns the number
of accepted occurrences. Each occurrence refreshes that session and current scope permissions;
revocation, capacity exhaustion or a changed policy pauses the rule with a bounded error code.
Reauthenticate, inspect and save the current version before resuming. Competing processes accept
one occurrence, and purge/receipt/next due time commit atomically. Missed cadences coalesce into
one current batch. A persisted cursor rotates through batches so held early resources cannot
starve later resources. At most eight due rules and 100 resources per rule run in one call.

Background execution is opt-in: set `intervalMs` between 1 second and 1 hour, call `start()`
(default 60 seconds), or invoke `runDue()` from an existing trusted scheduler. Close the service
on shutdown. UTC timestamps avoid server timezone interpretation; the widget previews cutoff
and hold expiry using the operator browser's local time.

## Platform integration and capacity

Set `ClankPlatformOptions.retention` with `policyRevision` and optional bounds/cadence.
Use the same client with `url: "/api/retention"` and `kinds: ["audit"]`. Platform browser session,
CSRF and recent-authentication middleware remain in force. Account operators access their own
account; organization owners/admins access their current organization; configured platform admins
use the existing administrator role. Scoped tokens, impersonation and machine credentials cannot
use this operator API. The standalone widget is available for an operator page; the existing
platform dashboard and CLI do not automatically mount these controls.

Per database, defaults/maxima are 10,000/50,000 source resources, 100,000/100,000 accepted
retention receipts, 64/128 MiB of receipt results, 10,000/50,000 holds and 1,000/10,000 rules.
Accepted operation identities are never silently evicted. Receipt exhaustion rolls back the
whole operation. Choose capacity for lifetime accepted work and monitor growth. Schedule listing
has a 1 MiB stored-payload bound. Purge snapshots admit at most 16 MiB of source/history payload
before loading it; each batch allows 1–10,000 current/history records. Oversized inventories or
snapshots return `503 RETENTION_CAPACITY` without partial deletion.

Audit exporter outbox defaults/maxima are 10,000/100,000 envelopes and 64/128 MiB. Held
acknowledged envelopes count toward these limits but are not redelivered. A full outbox still
delivers pending entries; when held acknowledgements occupy all capacity, release and explicitly
retire the reviewed local data before capture resumes. Malformed or oversized new events remain
explicit failures while already signed pending entries can still be acknowledged.

## Upgrade, rollback and recovery

Upgrade every source writer before enabling retention. Shared schemas add defaulted import
`expired` identities and collaboration `retiredThrough` floors; metadata remains registered with
the source services. Install these schemas before sealing a PITR schema. Ordinary application
CRUD stays compatible, but old binaries that ignore holds/floors or reject new metadata must not
write while retention is enabled. For rollback, pause schedules, unmount administration and keep
upgraded source services while holds, expired identities and floors remain authoritative.

Native retention tables are versioned with protocol 1. An unsupported protocol or malformed
persisted hold/source metadata fails closed. A consistent database backup preserves them;
restoring a historical backup can revive pre-retirement retry identities. Reconcile holds, floors
and accepted identities against the current trusted operator record before reopening restored
sources. An independent audit archive keeps its own checkpoint and retention policy. No
cross-database atomic restore or physical-erasure guarantee is provided.
