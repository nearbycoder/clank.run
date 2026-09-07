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


## Restore and migration rehearsals

A rehearsal restores an encrypted backup or snapshots an existing SQLite database into a private
temporary directory. It can apply proposed migrations, boot the application against that copy,
and run HTTP checks over a random loopback port. The source database is never opened for writes.

```ts
// rehearsal.mjs — import your own application factory here.
import { createApplication } from "./server-factory.mjs";

export default {
  source: { databasePath: "./snapshots/application.sqlite" },
  migrations: { directory: "./migrations" },
  boot: ({ databasePath, signal }) => createApplication({
    databasePath, signal, backgroundWorkers: false, externalServices: false,
  }),
  checks: [
    { name: "health", path: "/healthz", status: 200 },
    { name: "homepage", path: "/", status: 200, includes: "Welcome" },
  ],
};
```

The factory is application-specific: it must return `{ handle(request), close() }`, use the
supplied database path, disable real mail/payment/network integrations and job consumers, and
release its resources in `close()`. These options are illustrative factory inputs, not automatic
framework switches. Rehearsals execute trusted local code; they are not an operating-system
sandbox. Honor the abort signal and keep shutdown bounded. Synchronous application code and
SQLite work cannot be forcibly interrupted by a JavaScript timer.

```sh
clank workbench restore ./rehearsal.mjs --json
clank workbench migrate ./rehearsal.mjs --json
```

Both commands exit nonzero for an unsuccessful report. Restore requires a boot factory; migration
can omit it for database-only inspection. For encrypted backups, supply
`source: { manager, backupId }`, where `manager` is an open backup manager; its verified read path
checks integrity and decrypts before rehearsal. Programmatic callers can import
`rehearseRecovery` and `rehearseMigrations` from `@clank.run/framework/rehearsal`.

Reports contain restoration, migration, boot, check, and total durations; applied migration IDs;
per-table before/after row counts; schema/data change flags; named check results; and a failure
phase. Row contents, SQL text, response bodies, and exception messages are excluded. Data changes
are compared using temporary keyed hashes, which are also excluded. Check failures indicate that
the supplied application expectations did not pass; successful checks do not prove compatibility
with every older application version or production workload.

The default database limit is 32 MiB (configurable to 512 MiB), with at most 500 tables, 200 columns
per table, and 100,000 rows. Up to 20 HTTP checks may read 64 KiB each. The default asynchronous
deadline is 30 seconds, configurable from 100 ms to five minutes. Temporary files are removed and
the application is closed on success or failure. Migration SQL cannot attach external databases,
run filesystem/extension functions, or use PRAGMA/VACUUM, even with `allowUnsafe`; ordinary
migration validation still applies unless explicitly disabled.

## Database query advisor

Opt in when opening the database or backend with `queryDiagnostics: true`, then connect
`createDevtools({ queries: () => backend.inspectQueries(), databaseQueries: () => backend.inspectDatabaseQueries() })`.
For an externally supplied database, enable `queryDiagnostics` on that database's `openSQLite`
call. Use the existing loopback-only DevTools server; do not expose diagnostics through public RPC.

`inspectDatabaseQueries()` groups up to 500 observed application query shapes, including point
lookups, with actual SQLite plans, execution count, returned-row count, cumulative time, and
maximum time. `adviseQueries()` from `@clank.run/framework/query-advisor` highlights slow runs,
repeated shapes, scans, and temporary sorts. Timing covers SQL execution, not document decoding
or the whole backend handler. Cached backend results perform no SQL and add no SQL runs.
Bound arguments, owner identities, document IDs, and returned values are never retained.
Diagnostics are process-local, reset on close, and disabled by default.

Candidate indexes use equality fields, range fields, explicit ordering, and ownership scope.
They are reviewable SQL, never automatically applied. Choose a unique migration index name,
rehearse it on representative data, and compare plans and write costs. Plans are sampled on first
observation of a shape; reopen after schema changes to refresh them. A scan can be the optimal
plan, and repetition alone does not prove an N+1 bug. Counts describe returned rows, not rows
visited internally by SQLite. Startup validation, history reads, and internal metadata queries
are outside this application-query report.
