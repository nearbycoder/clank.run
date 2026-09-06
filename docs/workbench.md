# App Studio and the developer workbench

Clank's AI-first workflow has two deliberate halves. App Studio turns application intent into an
exact approval-bound generated plan. The workbench inspects and tests that app without hidden
services or package hooks.

## Conversational App Studio

`clank compose` is the interactive Studio: an agent proposes a data-only blueprint, Clank validates
it, and a person approves the exact generated-file digest. `createStudioReview()` exposes the same
contract to browser tools.

```ts
import { createStudioReview } from "@clank.run/framework/tooling";

const review = await createStudioReview({
  intent: "Build a private realtime Todoist-style app",
  blueprint: proposedBlueprint,
  questions: ["Should completed work be retained forever?"],
});
```

The review does not execute code, install, authenticate, or deploy. Its `approvalDigest` is the
ordinary `clank-plan/1` digest, so browser Studio and CLI composition cannot disagree.

## Production parity and database evolution

```sh
clank workbench parity local-runtime.json production-runtime.json --json
clank workbench schema schema-current.json schema-target.json \
  --output=0004_todo_labels.sql --json
```

Parity compares Node, database, isolation, region, environment names, migrations, and service
capabilities without secret values. Node, database, and migration differences are errors.

The schema workbench labels every table, column, type, nullability, default, and index change as
safe, review, or destructive. A required column without a default needs review; dropping data is
destructive; type changes produce an explicit rebuild placeholder. Output migrations are created
exclusively and owner-readable.

## Contract-generated tests and agent playground

`testActionContract()` generates valid, null, and missing-required-field cases from an action's
real JSON schema and executes its normal parser and handler.

```ts
const report = await testActionContract(todos.add, { user });

const playground = createAgentPlayground([todos.list, todos.add], {
  authorize: (call, action) => policyAllows(call.principal, action.manifest.name),
});

const transcript = await playground.call({
  action: "todos.add",
  input: { title: "Ship" },
  principal: "agent_codex",
  scopes: ["agent:write"],
});
```

Playground transcripts are bounded and redact password, token, secret, authorization, and cookie
keys. Production MCP still uses resource-bound OAuth and server authorization.

## Visual regression

`compareVisuals()` compares decoded RGBA screenshots with channel tolerance, a changed-pixel ratio,
and explicit ignored rectangles. Pair it with semantic `clank journey`: journeys prove behavior
and accessibility state; pixels catch layout, spacing, color, radius, and typography changes. The
dependency-free CLI accepts bounded, checksummed 8-bit RGB or RGBA PNG screenshots directly:

```sh
clank workbench visual test/baselines/home.png artifacts/home.png \
  --tolerance=4 --ratio=0.001 --json
```

A mismatch exits nonzero for CI. Decoding rejects malformed chunks, unsupported image modes,
compressed payloads over 16 MiB, and images over 16,777,216 pixels.

## Upgrade assistant

```sh
clank workbench upgrade clank-upgrade.json \
  --node=22 --exports=oldRouter,legacyApi --json
```

Upgrade manifests declare versions, minimum Node, removed/renamed exports, config edits, and
migration notes. Renames are mechanical edits; an old runtime or an in-use removed export without
a replacement is a blocker.

## Provider conformance kit

```sh
clank workbench provider ./my-provider.mjs --json
```

The kit validates provider shape, frozen credential-free stopped requests, exact-operation
idempotency, and abortable deadlines. Missing optional capabilities are skipped. Rollback and
delete are also skipped unless you explicitly use a disposable provider project:

```sh
clank workbench provider ./my-provider.mjs \
  --project=disposable-conformance-project --destructive=true --json
```

That opt-in exercises advertised rollback/delete capabilities with canonical confirmations and
can destroy the named provider project. Provider-specific crash and isolation tests remain
required.

## Shared control-plane design system

The hosted control plane consumes the same `clank` theme preset exposed by Design Studio. Its
canvas, surfaces, text, borders, accent, danger, radius, and shadow map from stable `--clank-*`
tokens during SSR. Applications can use any of ten presets or define a validated custom theme.

## Local DevTools

Start inspection before mounting components or handling the development requests you want to
observe. It records signal invalidations, dependency edges, computation durations, and disposal.
Names are developer-supplied labels; do not put user data in signal or computed names.

```ts
import { createDevtools, serveDevtools } from "@clank.run/framework/devtools";

const backend = await openBackend(definition, { path: "dev.sqlite", diagnostics: true });
const inspector = createDevtools({ queries: () => backend.inspectQueries() });
const panel = await serveDevtools(inspector);
console.log(panel.url);
// On shutdown: await panel.close(); inspector.dispose(); backend.close();
```

The panel binds only to `127.0.0.1`, uses no external assets or scripts, rejects cross-origin
requests, and offers an explicit refresh link. It is a local developer tool, not a production
operator endpoint. Query diagnostics are opt-in and grouped by declared query path, with run and
cache-hit counts, last execution time, current subscription counts, and the table names that
caused invalidation. Arguments, documents, results, authentication identifiers, and exceptions
are not included. Neither inspection callback failures nor reads add application dependencies.

For browser reactivity, use `createDevtools()` before mounting the application, then
`mountDevtools(container, inspector)`. Its refresh button renders a snapshot; call the returned
cleanup and `inspector.dispose()` when finished. `renderDevtools(inspector.snapshot())` also
returns escaped HTML for an existing authorized workbench.

The default history holds 500 events and up to 500 observed active computations. `maxEvents`
accepts 1–5,000; query diagnostics retain at most 500 paths. Truncation is visible, and computations
created before inspection may be absent until they next run. `clear()` clears event history;
`dispose()` removes the observer and releases all retained metadata. Inspection never retains
signal values, source objects, or application callbacks. With no observer attached, the kernel
skips event allocation and timing; CI continues to enforce the browser module and work budgets.
