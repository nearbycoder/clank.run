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

Signal writes are synchronous. Wrap related writes in `batch()` so each dependent effect executes once after the final write. `transaction()` provides the same coalescing plus rollback on failure.

## Measuring identity

The renderer regression suite asserts identity, not merely final HTML. It stores references to list elements and text nodes, edits and reorders immutable records, and verifies that the same objects remain mounted. This prevents a visually correct remount from being mistaken for a fine-grained update.

Run the performance invariants with:

```sh
npm test -- tests/dom.test.mjs
```
