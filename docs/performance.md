# Performance model

Clank uses compilation and fine-grained subscriptions instead of rerendering component trees. A component function runs once when mounted. Its TSX expressions become independent bindings that subscribe only to the signals they actually read.

## Update guarantees

| State change | DOM work |
| --- | --- |
| Text expression changes | Mutate the existing `Text.data`; node identity is retained |
| Attribute or property changes | Set that property on the existing element |
| One style object changes | Diff its property names and update changed/current entries |
| One `classList` object changes | Diff its active tokens; add/remove only changed tokens |
| Conditional changes branch | Dispose and mount only the nodes inside its markers |
| Keyed item field changes | Update bindings in that retained row |
| Keyed list reorders | Move retained DOM ranges; do not recreate them |
| Keyed list insertion/removal | Mount/dispose only the affected keys |

There is no virtual DOM tree, component rerender, or full-list diff of child VNodes on a normal signal update.

## Compiler-created granularity

```tsx
<article class={selected.value ? "selected" : ""}>
  <h2>{document.value.title}</h2>
  <p>{document.value.summary}</p>
</article>
```

This creates three subscriptions: one for `class`, one for the heading text, and one for the paragraph text. Changing `summary` does not execute the component, recreate the article, touch its class, or update the heading.

Event callbacks, `ref`, `use`, `key`, `bind:*`, and literal values are not wrapped in reactive effects.

## Keyed lists

```tsx
<For each={todos.value} by="id" fallback={<p>No todos</p>}>
  {(todo) => (
    <TodoRow todo={todo} />
  )}
</For>
```

Keys must be unique within the list. A property key such as `by="id"` or `(item) => item.id` is recommended for immutable records. Clank gives every retained object row a stable proxy with lazily created property signals. Replacing `{ id: "a", done: false }` with `{ id: "a", done: true }` preserves the row and notifies `todo.done` bindings without invalidating bindings that only read `todo.id` or `todo.title`.

Without `by`, object identity is the key. Primitive values use value plus index and are intended for simple display lists.

## Batching

Signal writes are synchronous. A single write invalidates all dependent computed values before
running effects, so an effect reached through several computed branches runs once with settled
values. Wrap related writes in `batch()` so each dependent effect executes once after the final
write. `transaction()` provides the same coalescing plus rollback on failure.

## Hosted request routing

Managed ingress reads a fresh routing snapshot for each request. Verified custom domains are
loaded in one query for all deployed projects, and installations with only local applications
skip provider fleet reads. Domain revocations, reassignments, process replacement, and provider
generation checks remain live; routing does not wait for a cache timeout.

The platform regression suite counts domain queries across multiple deployed applications and
checks immediate host reassignment and revocation alongside the rollout and provider tests.

## Measuring identity

The renderer regression suite asserts identity, not merely final HTML. It stores references to list elements and text nodes, edits and reorders immutable records, and verifies that the same objects remain mounted. This prevents a visually correct remount from being mistaken for a fine-grained update.

Run the performance invariants with:

```sh
npm test -- tests/dom.test.mjs
```

## Regression evidence

The performance pass covers reactive propagation, keyed DOM updates, SSR lifecycle, HTTP
streaming and static transfer, database/query caching, authentication and jobs, and local/provider
deployment paths. The fixes below use deterministic work counts and real HTTP/database tests;
they are not claims about production throughput or latency under an unmeasured workload.

| Regression scenario | Previous behavior | Fixed behavior |
| --- | --- | --- |
| One signal write through 100 computed branches to a shared effect | 100 effect executions | One execution with settled values |
| Shared signal update after 100 completed SSR requests | 100 obsolete effects ran | Zero obsolete effects run |
| Revalidate an unchanged 1 MiB static asset | Full body transferred again | Bodyless `304`, no file stream |
| Build ingress routes for three local applications | Three domain queries plus a fleet query | One domain query, no fleet query |
| HEAD or client disconnect during response backpressure | Unused body or locked reader remained | Stream cancelled and reader released |

The regressions live in `tests/core.test.mjs`, `tests/ssr.test.mjs`, `tests/node.test.mjs`, and
`tests/platform.test.mjs`. `npm run check` also verifies DOM identity, authentication/ownership,
live synchronization, durable jobs, provider fencing, rollout health gates, migration failure,
and rollback through the packaged-release conformance journey. CI runs the supported Node 22.16
and Node 24 versions. Reproduce timing measurements on the deployment workload before drawing
capacity conclusions from these narrower invariants.
