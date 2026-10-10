# Offline mutations

Binary attachments use the separate [offline attachment queue](#offline-attachments). The JSON mutation queue below does not store files.

Enable server receipts and create one browser queue for the current application/account:

```ts
// Server: successful receipts share the mutation's SQLite transaction.
const backend = await openBackend(definition, { path: "app.sqlite", offlineMutations: {} });

// Browser: use your existing authenticated SyncClient and auth state.
import { createOfflineQueue, renderOfflineQueue } from "@clank.run/framework/offline";
const queue = createOfflineQueue({
  namespace: "my-app", userId: currentUserId, storage: localStorage, client,
  currentUser: () => auth.user.peek()?.id ?? null,
});
await queue.enqueue(api.todos.add, { title: "Finish report" });
const unsubscribe = queue.subscribe(items => {
  pendingElement.innerHTML = renderOfflineQueue(items);
});
await queue.flush();
const reconnect = () => queue.flush().catch(reportQueueError);
window.addEventListener("online", reconnect);
```

`enqueue` persists before returning. `flush` sends in order, removes acknowledged work, and leaves
network failures pending with exponential retry delays from one second to one minute. Call
`flush` on reconnect, application startup, and your retry timer; there is no hidden background
worker. A pending item exposes `attempts`, `nextAttemptAt`, and a bounded error code. Rendering
shows only operation paths/statuses; mutation arguments and credentials are omitted.

An unsuccessful 409 response pauses the queue in `conflict`. Read the latest server value and
let the user reconcile it, then call `queue.retry(id, mergedInput)` and `queue.flush()`. A replacement
gets a new key; plain `retry(id)` preserves the original key. Permanent failures pause in `failed`;
inspect/reconcile their server outcome before `discard(id)` and enqueueing a new operation.
Later queued edits wait behind a conflict or failure. `clear()` discards pending work explicitly.

Receipts bind keys to the authenticated user, operation, and parsed input. They commit alongside
the mutation, so a lost response or server restart can safely replay the stored result. Auth,
origin, CSRF, and function authorization checks still run. Keys expire after seven days by default;
expired keys are rejected rather than executed again. Reconcile expired work before creating a
new key. Retention accepts one minute to 30 days and is fixed after the database's first receipt
initialization, preventing a later retention increase from resurrecting deleted keys. Receipts
are pruned on successful keyed mutations. They retain parsed arguments and results in the
application database; use its normal backup/access protections.

The server keeps at most 10,000 receipts by default (configurable to 100,000), at most 1,000 per
account, and at most 64 KiB per result. Capacity errors leave work pending. Browser storage holds
at most 100 items and 1 MiB per application/account. Storage failures are surfaced, and corrupt
queues are never silently overwritten. Input is persisted as JSON: do not queue credentials,
files, or values inappropriate for same-origin browser storage.

Every send carries its original account ID, checked against the authenticated server session.
On logout, call `queue.dispose()` and remove reconnect/timer/subscription handlers. Clear while
the original account is still authenticated if pending work should be deleted. A disposed queue
stops further sends; an already dispatched request may still commit. Create a new queue on login.
Web Locks serialize reads, writes, and sends across tabs where supported. Without Web Locks,
serialization covers this JavaScript context only: use one active tab or supply storage isolated
to that context, such as `sessionStorage`.

Use `client.mutateOnce(reference, args, { key, userId })` for custom queue implementations. Keys
are `<13-digit epoch milliseconds>.<UUID v4>`. Deduplication covers the transactional database
mutation and transactionally enqueued jobs. Keep external effects in durable jobs; arbitrary
synchronous external side effects cannot be rolled back with SQLite.

## Resolve field conflicts in the browser

Include the original and locally edited field values when enqueueing edits that use optimistic
versions, then mount the conflict resolver:

```ts
import { mountOfflineConflictResolver } from "@clank.run/framework/offline";
await queue.enqueue(api.todos.update, { id, title: localTitle, ifVersion: originalVersion }, {
  original: { title: originalTitle }, local: { title: localTitle },
});
const disposeResolver = mountOfflineConflictResolver(conflictContainer, queue, {
  async loadServer(item) {
    const record = await client.query(api.todos.get, { id: item.input.id });
    return { values: { title: record.title }, version: record._version };
  },
  buildInput(values, server, item) {
    return { id: item.input.id, ...values, ifVersion: server.version };
  },
});
```

Use your actual typed query/mutation references and validate/narrow `item.input` in TypeScript;
it is `unknown` because one queue may contain different operations. The mutation must enforce
the supplied version on the server. The resolver displays original, local, and server values and
requires a choice for fields changed differently on both sides. Before replacing the queued input,
it fetches the server again and rejects a comparison whose version or values changed. Use
“Refresh comparison” to review newer state. Resolved input and new reconciliation snapshots get a
fresh receipt key; call `queue.flush()` explicitly to send it.

`compareOfflineConflict(original, local, server)` provides the same field comparison for custom
controls. Comparison is bounded to 100 fields. Reconciliation snapshots share the queue's storage
limits and protections and display the selected field values, so include only data appropriate for
that browser/account. Dispose the resolver along with the queue on logout.


## Offline attachments

`openOfflineAttachmentQueue` stores immutable Blobs and exact mutation arguments in native
IndexedDB, in a versioned namespace for one application/account. Web Locks serialize sends,
retries and local discards across tabs. Unsupported browsers fail explicitly. Configure a
private, authenticated, user-owned bucket and enable normal server mutation receipts.
The bucket catalog and the application's records must use the **same SQLite file**; the native
resolver rejects separate catalogs rather than implying a distributed transaction.

```ts
import { openOfflineAttachmentQueue, mountOfflineAttachmentQueue } from "@clank.run/framework/offline";
import { createBucketClient } from "@clank.run/framework/buckets";
const attachments = await openOfflineAttachmentQueue({
  namespace: "notes", userId: currentUserId, bucketName: "files",
  bucket: createBucketClient("files", { csrfToken: () => currentCsrfToken }),
  client, currentUser: () => auth.user.peek()?.id ?? null,
});
// api.notes.attach takes { id, attachment }; the queue supplies the completed reference.
await attachments.enqueue(api.notes.attach, { id: noteId }, selectedFile);
const disposeView = mountOfflineAttachmentQueue(pendingElement, attachments);
await attachments.flush(); // Call explicitly on startup, reconnect or synchronization.
```

The mutation's attachment argument contains `bucket`, `key`, `objectId`, `sha256` and an opaque
`generation`. In the synchronous authenticated handler, call
`resolveBucketAttachment(context, args.attachment)` before the record write. Use the returned
verified metadata and your existing owner/ACL and optimistic record-version checks. The resolver
uses the record's current write transaction, so a concurrent bucket catalog writer cannot change
the selected generation between validation and commit. Copied contexts, contexts retained after
the handler returns, copied managers, foreign owners and stale generations are refused. Normal
server authorization, origin, CSRF and offline account binding remain mandatory. Do not replace
this check with trusting the browser's metadata or reading another catalog before a mutation.

The queue allocates one random object key, SHA-256 digest and timestamp/UUID receipt key per item.
Uploads require expected absence (`ifSha256: null`) and the exact content digest. A lost upload
response is reconciled by reading that key and checking owner, digest, size, type and generation.
Partial uploads have no completed object and cannot attach. Existing resumable policy controls
chunking; after interruption, an outstanding reservation can block a new attempt until its
expiry. An explicit retry can then restart the same expected-absence upload. No upload capability,
cookie, CSRF token or other authentication credential is persisted by the queue.

After completion, the exact attachment reference is persisted before the record mutation sends.
Lost mutation responses retain the original input and receipt key. Reopening storage and calling
`retry(id)` then `flush()` replays that request; server receipts and row changes share a transaction.
An ignored or altered native receipt insertion rolls back the row write before acknowledgment.
Expired receipt keys are rejected and are never renewed automatically. A changed generation or
foreign object fails without substitution, even when a rewrite has identical bytes. Persist and
check the complete reference when later serving an attachment; fetching by mutable key alone
cannot establish that it is still the selected generation. Object-store integrity remains checked
by ordinary bucket reads; publication and record attachment are separate operations.

Defaults are 100 items, 8 MiB per Blob, 50 MiB total binary bytes, 16 KiB JSON arguments per item
and 1 MiB total argument bytes. Item limits may decrease, Blob limits may increase to 64 MiB, and
total bytes may increase to 256 MiB. Atomic IndexedDB transactions enforce bounds across tabs.
Storage failures and unknown/corrupt records are surfaced without clearing or replacing them.
The queue exposes metadata-only pending/uploading/attaching/failed snapshots; it does not expose
Blob bytes or mutation arguments. Include only ordinary application data in queued arguments.
Send attempts have a 60-second deadline and stop after 1,000 attempts; retries retain identity.
A custom transport must honor the supplied abort signal and current-account assertion.

Network/server failures remain pending with bounded backoff. Permanent failures pause the queue;
`retry(id)` explicitly retries unchanged input. `discard(id)` removes only the device-local copy
and waits for the cross-tab send lock. It does not delete an uploaded object, undo an attachment,
or reverse an already dispatched request whose acknowledgment is unknown. Reconcile that outcome
before discarding. Changing arguments requires a separate reviewed application operation.

On logout/account change, call `disposeView()` and `attachments.dispose()` and remove your reconnect
handlers. Account checks run around storage, upload chunks and network awaits. Disposal aborts
owned sends, closes the database and clears subscribed views; an already dispatched request can
still commit to its original account. The supplied view polls for current-account/storage changes
and displays only metadata. New accounts open their own queue and cannot read another account's
pending inputs. Same-origin IndexedDB is local application storage, not an encrypted vault.
