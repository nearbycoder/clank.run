# Rendering and components

Clank compiles TSX into direct DOM construction and fine-grained reactive bindings. There is no virtual DOM and no whole-component rerender loop. A component executes once to establish structure; expressions update independently afterward.

## TSX components

```tsx
interface BadgeProps {
  tone: "green" | "amber";
  children: Renderable | Renderable[];
}

function Badge(props: BadgeProps) {
  return <span class={`badge badge-${props.tone}`}>{props.children}</span>;
}

function Status() {
  return (
    <section id="status">
      <Badge tone="green">Ready</Badge>
      <>One fragment can contain several siblings.</>
    </section>
  );
}
```

Lowercase tags create HTML/SVG elements. Uppercase or member-expression tags call components. Fragments create no wrapper element.

`h(type, props, ...children)` remains available as a lower-level integration API, but application code normally uses TSX.

## Automatic reactivity

Any nonliteral expression in a TSX child or ordinary element property is compiled into a lazy reactive marker:

```tsx
const count = signal(0);
const doubled = computed(() => count.value * 2);

function Counter() {
  return (
    <button disabled={count.value >= 10} onClick={() => count.value++}>
      Count {count.value}; doubled {doubled.value}
    </button>
  );
}
```

The compiler creates separate bindings for `disabled`, `count.value`, and `doubled.value`. The click handler remains a normal event callback. Updating `count` mutates the existing button property and text nodes without calling `Counter` again.

Component prop expressions are lazy too:

```tsx
function Greeting(props: { name: string }) {
  return <h1>Hello {props.name}</h1>;
}

<Greeting name={profile.value.name} />
```

The runtime exposes expression-backed props through getters. Reading `props.name` inside the heading's compiled expression observes the latest parent value.

JavaScript executed imperatively in the component body still runs once. Use TSX expressions, `Show`, `Switch`, or an `effect` for behavior that must react.

## Classes and styles

```tsx
<div
  class={compact.value ? "card compact" : "card"}
  classList={{
    selected: selected.value,
    disabled: !enabled.value,
  }}
  style={{
    color: foreground.value,
    "--progress": `${progress.value}%`,
  }}
/>
```

Dynamic `class` updates the existing element. `classList` diffs active tokens, including space-separated token groups. Dynamic style objects remove missing properties and update current ones. Static Tailwind class strings pass through unchanged.

## Events

```tsx
<button onClick={save}>Save</button>
<button on:click={save}>Save</button>
<button onClickCapture={save}>Capture</button>
<button onClickOnce={save}>Run once</button>
<button onTouchstartPassive={handleTouch}>Touch</button>
```

Event expressions are not reactive wrappers. Listeners attach once and are removed on unmount. The `Capture`, `Once`, and `Passive` suffixes map to standard event-listener options.

## Forms

`bind:` creates a two-way connection to a signal:

```tsx
const email = signal("");
const accepted = signal(false);

<input type="email" bind:value={email} />
<input type="checkbox" bind:checked={accepted} />
<p>{email.value}</p>
```

`bind:value` listens to `input`; other bound properties listen to `change`. The compiler passes the signal itself rather than wrapping it.

For validation, error state, cancellation, server errors, resets, and accessible field relationships, use `createForm()` rather than assembling those mechanics from individual signals. See [Forms](forms.md).

Clank's strict JSX declarations type native tags, element properties, event `currentTarget`, reactive values, ARIA/data attributes, bind/ref/use protocols, and hyphenated custom elements.

## Refs and directives

```tsx
const input = signal<HTMLInputElement | null>(null);

<input
  ref={input}
  use={(element) => {
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }}
/>
```

`ref` accepts a callback or signal. `use` accepts one directive or an array. A directive may return an unmount cleanup.

## Lifecycle and context

```tsx
const Theme = createContext("system");

function Shell() {
  provideContext(Theme, "dark");
  onMount(() => {
    console.log("mounted");
    return () => console.log("unmounted");
  });
  return <Page />;
}

function Page() {
  const theme = useContext(Theme);
  return <p>Theme: {theme}</p>;
}
```

Providers affect descendant components mounted from that component's output. Contexts always have a default value. Component scopes own nested effects, resources, directives, event listeners, and cleanup callbacks.

## Conditional control flow

```tsx
<Show when={user.value} fallback={<Login />}>
  <Profile user={user.value} />
</Show>

<Switch fallback="Unknown">
  <Match when={status.value === "ready"}>Ready</Match>
  <Match when={status.value === "error"}>Failed</Match>
</Switch>
```

Only the selected dynamic region is mounted. Changing the condition disposes the previous region before mounting the next.

## Keyed lists

```tsx
<For each={tasks.value} by="id" fallback={<p>No tasks</p>}>
  {(task, index) => (
    <article data-id={task.id}>
      <span>{index() + 1}. {task.title}</span>
      <button onClick={() => remove(task.id)}>Remove</button>
    </article>
  )}
</For>
```

`For` calls the row function once per new key. Retained object rows receive a stable reactive proxy, so immutable replacements update property bindings without recreating the row. The second argument is an index accessor because reordering can change it.

Use `by="id"` for a record property or `by={(item) => item.id}` for a custom key. Duplicate keys throw instead of producing ambiguous DOM. See [Performance model](performance.md) for identity guarantees.

## Lazy components and promises

`lazy()` accepts a dynamic component import. A Promise can also be rendered directly; its pending marker is replaced when it resolves. Rejection renders the error message unless the surrounding application supplies its own error UI.

## Raw HTML and hydration

`dangerouslySetInnerHTML={{ __html }}` is deliberately explicit and bypasses child mounting. Sanitize untrusted HTML first.

Ordinary URL attributes reject executable schemes and unsafe data URLs. Inline `on*` attributes and `iframe srcdoc` are rejected; use function event listeners and an explicitly reviewed raw-HTML path instead.

`renderToString()` emits comment boundaries around dynamic values and keyed `For` regions. `hydrate(root, view)` walks that marker structure, attaches reactive effects and event handlers, and preserves matching elements, rows, and text nodes. It records `data-clank-hydration="attached"` on success.

If the client tree differs structurally from the server tree, hydration warns, disposes the partial ownership scope, and remounts the root with `data-clank-hydration="remounted"`. Treat that fallback as a development signal: render deterministic initial data and seed live clients from `readState()` before hydration.

Event handlers and `onMount` callbacks do not run during SSR. They attach or run during hydration. Use `serializeState()`/`renderDocument({ state })` rather than interpolating JSON into scripts; it escapes HTML- and script-significant characters.

For a strict Content Security Policy, generate a fresh nonce per response and pass it to both the policy and document renderer:

```tsx
const page = await renderDocument(<App />, {
  nonce,
  state,
  scripts: ["/app.js"],
});
```

The nonce is applied to Clank's generated state and module scripts. Inline scripts supplied in `head` must receive the same `nonce` property.

## Compiler escape hatches

`expression(() => value)` manually creates the same reactive boundary emitted by the compiler. `jsx()` and `h()` are public for tooling and generated code. Most application code should not need them.
