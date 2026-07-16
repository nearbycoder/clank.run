# Architecture

## Module boundaries

```text
core.ts     platform-neutral reactive graph and ownership
dom.ts      direct DOM mounting, bindings, components, context, control flow
tsx.mjs     compile-time JSX parsing and reactive-expression lowering
router.ts   URL matching, navigation state, loaders, guards
ai.ts       schemas, actions, discovery, semantic UI contract
forms.ts    schema-aware form state, validation, submission, manifests
ui.ts       disclosure, dialog, tabs, pagination, browser directives
server.ts   Fetch request router and middleware
auth.ts     password/session service, cookies, CSRF, roles, auth UI/client
backend.ts  inferred schema/functions, SQLite documents, RPC, live queries
deploy.ts   deterministic artifact config, packaging, verification, extraction
migrations.ts immutable SQL ledger, backup, restore, transactional application
platform.ts device auth, projects, secrets, audit, releases, supervision
security.ts shared URL, origin, validation-redaction, and bounded JSON helpers
ssr.ts      escaped HTML rendering, document templates, serialized state
node.ts     dependency-free Node HTTP and static-file adapters
index.ts    public aggregate exports
```

The reactive kernel imports nothing. DOM depends only on the kernel. Routing depends on the kernel and DOM types. AI uses the kernel for action UI state and DOM types for described views. Forms depend on the kernel and schema contracts. Headless UI depends only on the kernel and browser standards. The server uses the routing matcher. There are no package imports.

## Reactive graph

A source owns a set of observers. During an observer execution, signal and computed reads register both sides of the dependency. Before reevaluation, prior dependencies are detached. Computed observers invalidate synchronously and propagate dirtiness; effects enter a deduplicated queue. The outermost batch drains that queue.

`Computed.peek()` prevents the caller from subscribing while still evaluating the computed under its own observer. This distinction keeps imperative snapshots fresh without accidentally wiring the surrounding effect to the computed.

Ownership is a separate tree. Roots collect cleanup callbacks. Components create child roots, so unmounting a subtree disposes its event handlers, directives, effects, computed values, resources, and nested mounts together.

## DOM strategy

Static element structure is created once. The TSX compiler wraps each dynamic child and property in a `ReactiveExpression`; the renderer turns each marker into one narrow effect. Primitive child changes mutate the existing `Text.data` and retain the exact node. Conditional regions get start/end markers and replace only their controlled nodes.

`For` builds a key-to-row map. An array update is reconciled in O(n): removed keys are disposed, new keys mount once, retained object keys update lazy per-property row signals, and only reordered row ranges receive DOM move calls. With `by="id"`, immutable object replacement updates changed row fields without replacing the row or its text nodes.

This avoids virtual-tree allocation and whole-tree diffing for ordinary state changes. See [Performance model](performance.md) for the exact update guarantees.

## Async consistency

Resources and router loaders use two defenses:

1. Abort the prior operation with `AbortController`.
2. Associate every run with a monotonically increasing revision and ignore any result that is no longer current.

This prevents stale state even when a promise cannot be physically canceled.

## Agent protocol

The action manifest and semantic DOM tree are complementary:

- The manifest describes callable application capabilities and their policies.
- The semantic tree describes the currently mounted interactive surface.

An agent may choose a named action directly or operate an explicit semantic control. Both paths still pass through application validation and, when correctly configured, authorization.

## Build strategy

Clank's compiler parses TSX directly, lowers elements to `jsx()` calls, and lowers dynamic expression sites to lazy `expression()` markers. Node's `stripTypeScriptTypes(..., { mode: "transform" })` then removes TypeScript syntax. The build changes local `.ts`/`.tsx` import suffixes to `.js` and emits source maps. No bundling means browser module boundaries remain visible and debuggable.

The checked-in declaration files are the stable consumer contract. Type tests instantiate real schemas and backend functions to ensure errors appear at call sites without generated types. The repository's strict `tsconfig.json` validates source and the examples when a TypeScript compiler is available, while the normal build itself remains package-free.

## Full-stack data flow

The schema is both a runtime validator and the root TypeScript value. Table documents, branded IDs, mutation arguments, handler results, zero-codegen API references, server calls, and browser calls are conditional types derived from that value.

SQLite stores canonical validated document JSON beside framework metadata. Owned tables store an immutable owner column outside application JSON. A mutation runs synchronously inside `BEGIN IMMEDIATE`; document writes, output validation, the persisted global revision, and journal records commit together. Queries use consistent read transactions and record table, document, and owner dependencies. Same-host processes catch up through the persisted journal and publish one current snapshot. A retained-history gap causes conservative full invalidation.

Auth uses internal SQLite tables through a private database capability. Password work runs outside transactions; user/session writes then enter the same revision and notification system. The backend selects the auth cache partition and database owner scope and refreshes long-lived callers before operations. Auth journal changes close affected live streams across processes, so role downgrades and revocations reconnect with current authorization.

SSR executes the same component tree without a DOM. Dynamic regions and keyed lists receive comment boundaries. Hydration walks those boundaries and installs the fine-grained effects on the existing nodes. A structural mismatch is surfaced as a warning and safely remounted instead of leaving partially attached behavior.

## Deployment data flow

The deployment config is normalized before its build runs. The CLI executes the build command as an argument array, walks only explicit include roots, rejects links and sensitive paths, and creates a deterministic gzip document with individual file hashes. It vendors the current Clank package so execution does not depend on mutable global installation state.

The control plane hashes device and access credentials, intersects organization role with project-token scope on every request, stores encrypted secrets and audit metadata in its own SQLite database, and allocates a persistent project data directory. Release directories are immutable after extraction except for a platform-generated launcher.

A deployment takes the project lock, verifies and extracts a staged artifact, quiesces the previous process, snapshots SQLite, applies immutable migrations, starts a candidate, and waits for health. Activation is the final state transition. Any earlier failure restores the snapshot and previous process.

Project mutations also acquire durable distributed leases. Authenticated deployment nodes, desired generations, idempotent durable operations, lease expiry, retries, draining, capacity placement, and monotonic fences reject stale workers. The included child-process supervisor still owns processes in memory and therefore runs as one active leader per project/data directory; remote agents can implement the durable orchestration contract. Child processes support trusted operation, while Docker adds a constrained container boundary for mutually untrusted applications.
