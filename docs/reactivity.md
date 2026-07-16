# Reactivity

Clank tracks reads while a computed value or effect is running. A signal write synchronously invalidates computed values and reruns only the effects that read the changed source. Effects are deduplicated inside a batch.

## Signals

```ts
const count = signal(0, { name: "cart.count" });

count.value;                     // tracked read
count.get();                     // tracked read
count.peek();                    // untracked read
count.value = 2;                 // write
count.set(3);                    // write and return the new value
count.update(value => value + 1);

const unsubscribe = count.subscribe((next, previous) => {
  console.log(previous, "→", next);
});
```

Signals use `Object.is` equality by default. Supply `{ equals: false }` to notify on every assignment or provide a custom equality function.

## Computed values

```ts
const subtotal = signal(12);
const taxRate = signal(0.08);
const total = computed(() => subtotal.value * (1 + taxRate.value));
```

A computed value is lazy: it evaluates on its first read, caches the result, and runs again only after a dependency changes and the value is read. Recursive computed evaluation throws a descriptive cycle error.

## Effects and cleanup

```ts
const stop = effect((cleanup) => {
  const controller = new AbortController();
  fetch(`/search?q=${query.value}`, { signal: controller.signal });
  cleanup(() => controller.abort());
});

stop();
```

The previous cleanup runs before the next effect execution and again when disposed. Effects are synchronous. Use an async resource for request state and stale-result protection instead of making an effect callback itself async.

## Batches and transactions

```ts
batch(() => {
  firstName.value = "Grace";
  lastName.value = "Hopper";
}); // dependent effects run once here
```

`transaction()` adds rollback semantics:

```ts
transaction(() => {
  balance.value -= amount;
  inventory.value -= 1;
  if (inventory.value < 0) throw new Error("Out of stock");
});
```

If the callback throws, every signal written by that transaction is restored before effects flush. Nested transactions merge their journals into the parent on success.

## Untracked reads

```ts
effect(() => {
  console.log(activeId.value, untrack(() => debugSettings.value));
});
```

Changing `debugSettings` does not rerun this effect.

## Ownership

`createRoot()` owns computed values, effects, resources, and registered cleanup callbacks created inside it. Disposing the root releases all of them in reverse creation order.

```ts
const feature = createRoot(dispose => {
  const stopPolling = startPolling();
  onCleanup(stopPolling);
  return { dispose };
});
```

Components automatically receive an owned root; application code usually does not need to create one.

## Stores

```ts
const state = store({
  profile: { name: "Ada" },
  tags: ["math"],
});

effect(() => console.log(state.profile.name));
state.profile.name = "Grace";
state.tags.push("compiler");

const serializable = snapshot(state);
```

Stores are lazy deep proxies. Each accessed property gets an independent signal, and object-key iteration has its own dependency. `toRaw()` returns the original object for an individual proxy; `snapshot()` recursively returns plain current values.

## Async resources

```ts
const user = resource(
  async (id: string | undefined, { signal }) => {
    const response = await fetch(`/api/users/${id}`, { signal });
    return response.json();
  },
  { immediate: false },
);

await user.reload("42");
user.data.value;
user.status.value;  // idle | loading | refreshing | ready | error
user.loading.value;
user.error.value;
user.mutate(current => ({ ...current!, optimistic: true }));
user.abort();
```

Reloading aborts the prior request. Revision tracking also prevents a stale promise from overwriting newer data even when its underlying operation ignores abort signals.

## Streams

`consumeStream(iterable, initial, reduce)` folds an `AsyncIterable` into a signal. It is useful for token streams, event streams, and progressive server output.
