# Offline mutations

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
