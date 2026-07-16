# AI-first contracts

Clank separates model providers from application contracts. It does not dictate which model or SDK to use. Instead, it makes capabilities discoverable, inputs deterministic, side effects explicit, and the rendered interface machine-readable.

## Runtime schemas

```ts
const CreateTask = s.object({
  title: s.string({ min: 1, max: 120, description: "Short task title" }),
  priority: s.optional(s.enum(["low", "normal", "high"] as const)),
  estimate: s.nullable(s.number({ min: 0 })),
  tags: s.array(s.string(), { max: 10 }),
});

const value = CreateTask.parse(modelOutput);
const result = CreateTask.safeParse(modelOutput);
const jsonSchema = CreateTask.toJSONSchema();
```

Available builders are `string`, `number`, `boolean`, `literal`, `enum`, `unknown`, `array`, `object`, `optional`, `nullable`, and `union`. Objects are strict by default and aggregate nested validation issues with paths. Set `{ strict: false }` to preserve unknown properties.

## Actions

```ts
const createTask = defineAction({
  name: "tasks.create",
  description: "Create one task in the current workspace.",
  input: CreateTask,
  output: s.object({ id: s.string(), created: s.boolean() }),
  sideEffects: "write",
  confirmation: "write",
  authorize: (_input, context) => context.user != null,
  handler: async (input, context) => {
    return database.create(input, context.user);
  },
});

const output = await createTask(input, { user, signal });
```

Action names use letters, digits, `.`, `_`, and `-`. Input is always validated before authorization and execution; output is validated when an output schema exists.

Side-effect levels are:

- `none`: pure computation.
- `read`: external or private data may be read, but not changed.
- `write`: state may be changed.
- `destructive`: deletion, irreversible mutation, or similarly sensitive behavior.

Confirmation policy is `never`, `write`, or `always`. The HTTP bridge requires `x-clank-confirmation: confirmed` for applicable write/destructive calls and returns `428 CONFIRMATION_REQUIRED` when it is absent. The host or agent is responsible for obtaining real user confirmation before setting that header; the header is not a substitute for authentication or authorization.

## Discovery and invocation bridge

```ts
const bridge = createAgentBridge([createTask, archiveTask]);

bridge.manifest();
await bridge.invoke("tasks.create", input, context);
await bridge.handle(request, context);
```

The manifest protocol is `clank-agent/1`. The Fetch handler supports:

- `GET /.well-known/clank` or `GET /manifest`
- `POST /actions/:name` with a JSON input body

Write/destructive example:

```ts
await fetch("/actions/tasks.create", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-clank-confirmation": "confirmed",
  },
  body: JSON.stringify(input),
});
```

Success is `{ ok: true, output }`. Failures have `{ ok: false, error: { code, message, details? } }` and appropriate 4xx or 500 status codes. Requests require JSON content type, are size-bounded, may be restricted to exact origins, and redact validation input values. Since the bridge consumes and returns Web `Request`/`Response`, it can be mounted in Node, edge, worker, Bun, or compatible server environments.

## Action UI state

```tsx
const save = actionRunner(saveDocument);

<button
  disabled={save.pending.value}
  onClick={() => save.run({ body: editor.value })}
>
  {save.pending.value ? "Saving…" : "Save"}
</button>
```

An action runner exposes `pending`, `data`, `error`, `canRun`, `run`, and `reset`. Revision tracking prevents an older execution from overwriting newer UI state.

## Semantic UI

Opt-in DOM properties become `data-clank-*` attributes:

```tsx
<button
  agentId="archive-document"
  agentLabel="Archive current document"
  agentDescription="Moves the document out of active results."
  agentAction="documents.archive"
  intent="destructive-control"
>
  Archive
</button>
```

`agentHidden: true` removes an area from semantic inspection. It does not visually hide the element and is not an authorization boundary.

On interactive HTML elements, `agentLabel` is also mirrored to `aria-label`. The same explicit name is therefore available to assistive technology, browser automation, and the Clank semantic surface; non-interactive elements retain only the `data-clank-label` metadata.

## Inspect and operate

```ts
const surface = createAgentSurface(document.querySelector("#app")!);

surface.inspect();
surface.input("task-title", "Ship documentation");
surface.activate("add-task");
```

The inspection tree contains interactive or explicitly semantic elements only. It understands explicit agent labels plus native `label`, `aria-labelledby`, roles, IDs, names, required/readonly/invalid/expanded/checked/multiple state, placeholders, form values, link targets, and semantic children. Password and file-input values are never included. This is smaller and more stable than raw HTML, CSS selectors, or screenshots.

`activate` and `input` target explicit `agentId` values or native element IDs. Those methods dispatch ordinary browser events so human and agent interaction use the same application behavior. File inputs are refused; password controls are write-only through this surface.

Schema-aware `createForm()` controllers also expose a `clank-form/1` manifest containing field schemas and suggested controls without live values.

## Agent-described views

`defineView({ name, description, props, render })` attaches `viewManifest` metadata to a component and can validate its props. Use it for reusable surfaces that an external planner or UI generator needs to discover.

## Security model

- Schemas validate shape; authorization still belongs in `authorize` and the handler's data layer.
- UI semantic IDs expose controls; they do not grant server permission.
- Never place secrets in labels, descriptions, manifests, validation details, or rendered DOM.
- Hosts must obtain meaningful user confirmation before sending the bridge confirmation header.
- Treat all model-generated action input as untrusted even when the model previously inspected the UI.
