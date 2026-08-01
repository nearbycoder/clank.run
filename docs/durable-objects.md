# Durable objects

Clank durable objects are stable, stateful server-side units addressed by namespace and ID. Calls
for one ID are serialized, state commits atomically, leases fence stale runtimes, and different IDs
can run concurrently. State, alarms, idempotency results, migrations, and live revision notices all
live in the application's isolated SQLite database, so ordinary Clank backups and restores include
them automatically.

Use a durable object when behavior naturally belongs to one identity: a cart, game session,
collaborative document coordinator, rate limiter, account balance, agent session, or device. Use a
normal backend table when records only need transactional CRUD. Use [durable jobs](jobs-and-cron.md)
when work should run later or retry independently of a caller. A durable object can schedule its
own one-at-a-time alarm, but it is not a general queue.

## Define a namespace

Definitions are dependency-free TypeScript contracts. The state, arguments, and results use the
same runtime schemas as backend actions, so the runtime and agent manifest cannot drift.

```ts
import { defineDurableObject, s } from "@clank.run/framework/durable-objects";

export const Cart = defineDurableObject({
  name: "carts",
  description: "One serialized shopping cart per signed-in account.",
  state: s.object({
    items: s.array(s.object({
      productId: s.string({ min: 1, max: 100 }),
      quantity: s.number({ integer: true, min: 1, max: 100 }),
    })),
  }),
  initial: () => ({ items: [] }),
  methods: ({ query, mutation }) => ({
    read: query({
      args: {},
      returns: s.object({
        items: s.array(s.object({
          productId: s.string(),
          quantity: s.number({ integer: true }),
        })),
      }),
      description: "Read the current cart.",
      agent: { title: "Read cart", idempotent: true },
      handler: ({ storage }) => storage.get(),
    }),
    add: mutation({
      args: {
        productId: s.string({ min: 1, max: 100 }),
        quantity: s.number({ integer: true, min: 1, max: 100 }),
      },
      returns: s.number({ integer: true, min: 1 }),
      description: "Add a quantity of one product.",
      agent: { title: "Add cart item", idempotent: true },
      handler: ({ storage }, input) => {
        const current = storage.get();
        const existing = current.items.find((item) => item.productId === input.productId);
        const items = existing
          ? current.items.map((item) => item.productId === input.productId
              ? { ...item, quantity: item.quantity + input.quantity }
              : item)
          : [...current.items, input];
        storage.set({ items });
        return items.find((item) => item.productId === input.productId)!.quantity;
      },
    }),
  }),
});
```

Namespace names are permanent storage identities. Renaming `carts` creates a different namespace;
it does not rename existing data. Object IDs contain 1–256 letters, numbers, `.`, `_`, `:`, `@`, or
`-`. Put authorization identity in an ID only when that value is already safe to retain as a
database key; prefer opaque application IDs over email addresses or other personal data.

Methods can be nested to create readable paths such as `items.add`. A method is invisible to agents
unless it has an explicit `agent` object. `agent: false` and omitted metadata are equivalent.

## Open and call the runtime

Open the runtime with the same SQLite database used by the application. Obtaining a stub is inert;
the first call activates and initializes the object.

```ts
import {
  defineDatabase,
  openDurableObjects,
  openSQLite,
} from "@clank.run/framework";
import { Cart } from "./objects.ts";

const schema = defineDatabase({});
const database = await openSQLite(schema, {
  path: process.env.CLANK_DATABASE ?? "app.sqlite",
});
const objects = openDurableObjects({ cart: Cart }, { database });

const cart = objects.get(Cart, accountId);
await cart.call(Cart.methods.add, {
  productId: "keyboard",
  quantity: 1,
}, {
  idempotencyKey: `checkout-request:${requestId}`,
});

const state = await cart.call(Cart.methods.read, {});
const detailed = await cart.invoke(Cart.methods.read, {});
// detailed = { value, revision, deduplicated }
```

`call()` returns the method value. `invoke()` also returns the committed object revision and whether
a mutation result came from the idempotency ledger. An idempotency key is scoped to one namespace
and object ID. Reusing it with different method arguments fails closed. Successful results are
retained for 24 hours by default; callers must not treat that bounded window as a permanent
business uniqueness constraint.

Do not call a durable object from inside `database.transaction()`. A call can await and obtain a
distributed lease, while Clank database mutation handlers are intentionally synchronous. Call the
object before or after the database transaction, or enqueue a durable job transactionally when the
two operations need a recoverable handoff.

## State and execution contract

Every method receives an immutable current snapshot through `storage.get()`. Mutation methods can:

- `storage.set(next)` to validate and replace all state;
- `storage.update(current => next)` to derive state synchronously;
- `storage.deleteAll()` to commit a tombstone after success;
- `storage.getAlarm()` to inspect the current alarm; and
- `storage.setAlarm(epochMs | Date | null)` to replace or clear it.

State changes remain staged while the handler runs. A thrown error, invalid result, timeout,
cancellation, lost lease, invalid state, or oversized value commits none of the handler's staged
state. Deletion also commits only after success. A later call to a deleted stable ID creates its
initial state again while preserving a monotonic object revision.

Calls for one namespace/ID enter a local FIFO lane and acquire a renewable database lease. Another
runtime sharing that SQLite file waits. Settlement compares the random token, runtime owner, and
object revision, so a stale handler cannot commit after lease expiry. Calls to different IDs do not
share a lane and may run concurrently.

This gives exactly one accepted state transition, not exactly-once external side effects. A method
can call a remote API and lose its lease before committing local state. Use the call's stable
idempotency key with the remote provider too, or move failure-prone delivery into a durable job.
Honor `context.signal` in fetches and long-running work.

Defaults bound state to 1 MiB, arguments and results to 256 KiB, errors to 16 KiB, leases to 30
seconds, and acquisition to 30 seconds. `OpenDurableObjectsOptions` can lower or raise these within
hard ceilings. State is JSON—not class instances, functions, promises, cyclic structures, or binary
buffers. Store large bytes in [object storage](object-storage.md) and retain only the verified key
and metadata in object state.

## Durable alarms

An object owns at most one alarm. Scheduling a new time replaces the old one. The handler gets the
same mutation storage and fencing as an ordinary call:

```ts
export const Session = defineDurableObject({
  // state, initial, and methods...
  alarm: {
    description: "Expire an inactive session.",
    retry: {
      maxAttempts: 5,
      initialDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 15 * 60_000,
    },
    timeoutMs: 15 * 60_000,
    handler({ storage }) {
      storage.update((state) => ({ ...state, expired: true }));
    },
  },
});

const scheduler = objects.startAlarmScheduler();
```

The scheduler claims due IDs through their ordinary object lease. A successful alarm clears the
current alarm unless the handler schedules another. Failures retain a bounded error and reschedule
with exponential backoff; an exhausted alarm is parked with diagnostics instead of looping
forever. `runAlarmsOnce()` is available for deterministic process loops and tests. Call
`await scheduler.close()` and then `await objects.close()` during graceful shutdown.

Run one or more schedulers only where every process shares the same application SQLite file. The
lease makes duplicate scheduler processes safe. An app that never defines alarms does not need a
scheduler.

## Evolve state with migrations

New objects begin at the definition's current version. Existing objects migrate when first
activated. Every intermediate migration is required, synchronous, deterministic, and validated by
the current state schema before commit:

```ts
export const Cart = defineDurableObject({
  name: "carts",
  version: 2,
  state: s.object({
    items: s.array(cartItem),
    currency: s.string(),
  }),
  initial: () => ({ items: [], currency: "USD" }),
  migrations: {
    2: (old) => ({ ...old as object, currency: "USD" }),
  },
  methods: ({ query }) => ({
    read: query({ args: {}, handler: ({ storage }) => storage.get() }),
  }),
});
```

Do not edit an already released migration or reuse a version for a different shape. A runtime whose
definition is older than stored state fails with `SCHEMA_TOO_NEW`; plan rolling releases so old code
can stop receiving object calls before the first new-version activation. Back up the application
database before a destructive migration just as with normal schema changes.

## Live server subscriptions

`stub.subscribe(listener)` immediately receives the current snapshot or `null`, then observes
committed changes through Clank's ordinary database revision journal. It works across application
processes sharing the SQLite file and returns an unsubscribe function:

```ts
const stop = objects.get(Cart, accountId).subscribe((snapshot) => {
  console.log(snapshot?.revision, snapshot?.state);
});
```

This is a trusted server API and exposes the complete object state. Do not forward snapshots to a
browser without application authorization and response shaping. For ordinary browser UI, expose a
typed backend query and mutation so auth, ownership, live cache partitioning, and MCP stay on the
same reviewed boundary.

## Expose selected methods to an app MCP server

`durableObjectMcpTools()` converts only methods with explicit `agent` metadata. Authorization is
mandatory and runs for the exact authenticated agent context, namespace, object ID, method, and
request before arguments reach the object:

```ts
import {
  createMcpServer,
  durableObjectMcpTools,
} from "@clank.run/framework";

const tools = durableObjectMcpTools(objects, Cart, {
  async authorize(agent, attempt) {
    return attempt.id === agent.accountId;
  },
});

const mcp = createMcpServer({
  name: "shop",
  tools,
  authenticate: authenticateAgentRequest,
});
```

Tools wrap input as `{ id, input, idempotencyKey? }`, return `{ value, revision, deduplicated }`,
and request `agent:read` for queries or `agent:write` for mutations. Destructive, idempotent,
read-only, and open-world hints come from the method contract. Registration does not grant access,
and a general account membership check is insufficient when only some object IDs are visible.

Use `durableObjectManifest()` when an operator or generator needs the namespace, state version,
JSON Schemas, methods, alarms, and agent annotations without opening a runtime.

## Inspect and operate

`stub.inspect()` reads one trusted server snapshot. `namespace.list({ prefix, limit })` returns at
most 1,000 non-deleted objects in stable ID order. Neither is an end-user API. `diagnostics()`
returns only aggregate namespace, object, alarm, lease, call, and subscription counts; it never
contains IDs or state.

The runtime uses the same `clank_` reserved SQLite namespace and global change journal as other
first-party services. Application migrations must not modify these tables. Database backup,
restore, preview policy, filesystem durability, and per-project isolation apply exactly as they do
to backend documents.

## Placement boundary

The built-in driver coordinates multiple processes that share one SQLite file on one durable POSIX
volume. It is not a multi-region consensus database. Local Clank placement and statefully pinned
provider placement satisfy that contract; independently replicated files and network filesystems
do not. An infrastructure adapter may move the complete app database after fencing the old
generation, but it may not run writable copies on two nodes.

That deliberate boundary keeps the application API small and dependency-free while preserving a
clear path to a future transactional shared-store driver. The namespace/method/state contract does
not depend on SQLite-specific application code.
