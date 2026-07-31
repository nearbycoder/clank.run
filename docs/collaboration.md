# Realtime collaboration

Clank includes dependency-free primitives for live presence, cursors, selections, typing state,
and ephemeral signals between people authorized to the same application room. The transport uses
ordinary authenticated Fetch writes plus an SSE stream, so it works through the same Node adapter,
cookies, origin policy, and rolling HTTP infrastructure as the rest of an app.

Collaboration is deliberately separate from persistent live queries:

- backend mutations and SQLite live queries are the durable source of truth;
- collaboration presence is short-lived, replaceable UI context;
- signals announce an event but do not become an event log; and
- MCP tools continue to operate on documented backend actions, not another person's cursor.

## Add an authenticated room

Use the auth adapter to reuse Clank's current session and CSRF boundary. The one application rule
you must provide is room authorization:

```ts
import { createAuthCollaborationHub } from "@clank.run/framework/collaboration";

const collaboration = createAuthCollaborationHub(auth, {
  async authorizeRoom(session, { room, operation }) {
    // Recheck membership on every connect, stream, update, signal, and heartbeat.
    return await canAccessDocument(session.requireUser().id, room);
  },
  displayName: (user) => user.profile.name ?? "Collaborator"
});

async function handle(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/__clank/collaboration") {
    return collaboration.handle(request);
  }
  return application.handle(request);
}
```

`authorizeRoom` is not optional in applications with object- or workspace-level access. A valid
session proves who someone is; it does not prove they may observe a particular document.
`createAuthCollaborationHub` resolves the current session on every request and delegates writes to
the auth runtime's ordinary `verifyCsrf()` check.

For another identity system, use `createCollaborationHub({ authorize, verifyCsrf })`. Both
callbacks are mandatory. The public principal contains a private stable `id` and a room-visible
`name`; peers receive only a random connection-scoped participant ID.

## Connect the browser

```ts
import { createCollaborationClient } from "@clank.run/framework/collaboration";

const room = createCollaborationClient({
  room: documentId,
  csrfToken: () => boot.auth.csrfToken,
  initialPresence: {
    route: location.pathname,
    cursor: { x: 0, y: 0 },
    selection: null
  }
});

await room.connect();

canvas.addEventListener("pointermove", (event) => {
  void room.update({
    route: location.pathname,
    cursor: { x: event.clientX, y: event.clientY },
    selection: selectedId.value
  });
});

effect(() => {
  renderPresence(room.participants.value);
});
```

The reactive surface is:

| Value | Meaning |
| --- | --- |
| `state` | `idle`, `connecting`, `connected`, `reconnecting`, `closed`, or `error`. |
| `participants` | Immutable current room participants and their complete presence objects. |
| `lastEvent` | Latest snapshot, join, presence, leave, or signal event. |
| `error` | Latest transport error, without changing the participant contract. |

`update()` replaces this connection's entire presence object. Replacement avoids stale cursor or
typing keys surviving after a UI mode changes. Keep a local presence signal when updates are
assembled by multiple components.

Use a signal for transient notification:

```ts
await room.signal("comment.created", { commentId });
```

Signals are delivered to currently connected room participants, including the sender, and are
never retained. Persist the comment through a typed backend mutation first; use the signal only to
guide immediate UI attention.

## Protocol and lifecycle

The endpoint defaults to `/__clank/collaboration`:

1. a CSRF-protected `connect` write creates a random connection and returns a complete snapshot;
2. the client opens an authenticated SSE stream for that exact room and connection;
3. presence writes replace bounded participant data;
4. signals broadcast bounded ephemeral payloads;
5. heartbeats keep the connection lease current; and
6. abort, explicit disconnect, or idle expiry publishes a leave event.

Every event uses `clank-collaboration/1` and a monotonically increasing in-room revision. A stream
always begins with a full snapshot, so reconnect does not require replaying an unbounded event
history. The browser client reconnects with bounded exponential backoff after proxy restarts or
rolling deployment transitions.

## Limits and privacy

Defaults are conservative and configurable:

| Limit | Default |
| --- | ---: |
| Active rooms | 1,000 |
| Participants per room | 50 |
| Connections per authenticated principal | 8 |
| Presence JSON | 4 KiB |
| Signal JSON | 8 KiB |
| Presence/signals per connection | 240/minute |
| Idle lease | 45 seconds |

Data is JSON-only, five levels deep, with bounded keys, arrays, strings, bodies, and SSE events.
Origins are same-origin, cross-site Fetch Metadata is rejected, responses are `no-store`, mutation
rates are bounded, and stream access rechecks both the principal and room.

Presence is visible to every authorized participant in the room. Do not put passwords, tokens,
private drafts, email addresses, or hidden database fields in it. Connection IDs are opaque routing
handles, not bearer credentials; the server still re-authenticates their owner on every request.

The built-in hub is intentionally process-memory state. It survives ordinary connection churn but
not a process restart, which is correct for ephemeral presence. The client reconnects and sends a
new snapshot. A deployment with multiple simultaneous app processes must provide sticky routing to
one hub or a reviewed shared collaboration adapter; SQLite live data remains the durable shared
state either way.

Call `hub.diagnostics()` for aggregate room, participant, and stream counts. It returns no room
names, participant identities, presence, connection IDs, or signal payloads. Call `hub.close()`
during graceful application shutdown.
