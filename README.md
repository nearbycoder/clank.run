<div align="center">
  <img src="./brand/clank-mark-192.png" width="112" height="112" alt="Clank logo">
  <h1>Clank</h1>
  <p><strong>The AI-first full-stack TypeScript framework.</strong></p>
  <p>
    Build one secure, reactive application for people and agents.<br>
    Ship its UI, API, database, auth, live sync, and MCP server together.
  </p>
  <p><a href="https://www.npmjs.com/package/@clank.run/framework"><code>@clank.run/framework</code></a> · <strong>Zero dependencies</strong> · Node.js 22.16+ · <a href="./LICENSE">MIT</a></p>
  <p>
    <a href="https://docs.clank.run"><strong>Documentation</strong></a>
    ·
    <a href="https://clank.run"><strong>Deploy</strong></a>
    ·
    <a href="./examples"><strong>Examples</strong></a>
    ·
    <a href="./CONTRIBUTING.md"><strong>Contribute</strong></a>
  </p>
</div>

---

Clank is a dependency-free framework and open-source deployment platform for building full-stack
TypeScript applications. It combines fine-grained reactivity, compiler-powered TSX, server
rendering with node-preserving hydration, built-in authentication, user-owned SQLite data, live
queries, automatic MCP tools, immutable migrations, and health-gated deployment.

“AI-first” does not mean adding a chat box to every page. It means every application has two
first-class interfaces backed by the same typed contracts:

| For people | For agents |
| --- | --- |
| Accessible HTML, responsive state, forms, navigation, Tailwind CSS, SSR, and live updates | Authenticated MCP tools, JSON Schema, OAuth + PKCE, explicit side-effect metadata, and semantic UI inspection |

## From zero to deployed

```sh
npm install --global @clank.run/framework

clank login
clank create my-app
cd my-app
npm install
npm run dev
```

When the app is ready:

```sh
clank doctor
clank deploy
```

`clank login` connects to [clank.run](https://clank.run) by default. Run `clank` without arguments
for the interactive launcher, or give the same commands directly to a coding agent or CI job.

The generated app is already a working product—not an empty component. It includes:

- registration, login, logout, secure sessions, and CSRF protection;
- private per-user SQLite data with typed queries and mutations;
- server rendering and node-preserving hydration;
- live updates across tabs and browsers;
- Tailwind-compatible styling;
- an authenticated, app-specific MCP server;
- an immutable initial migration and deterministic deployment contract; and
- focused `README.md` and `AGENTS.md` instructions.

The first deploy creates and links the hosted project automatically. Every later deploy builds a
checksummed artifact, backs up data, applies ordered migrations, health-checks the candidate, and
keeps the prior release available if activation fails.

> Prefer a smaller starting point? Use `clank create my-app --template=minimal`.

## One application, one contract

```mermaid
flowchart LR
    H["Human<br>browser UI"] --> C["Typed Clank<br>queries + mutations"]
    A["Agent<br>MCP + OAuth"] --> C
    C --> D["Isolated SQLite<br>live revisions"]
    C --> S["SSR + hydration<br>live synchronization"]
    C --> P["Deterministic deploy<br>migrate · verify · activate"]
```

Define trusted server functions once. Clank infers their TypeScript clients, validates their
inputs and outputs, updates subscribed browser queries after commits, and publishes the eligible
functions as MCP tools. The MCP contract revision changes whenever a tool name, schema,
description, scope, or annotation changes, so clients can refresh without serving a stale action
model.

Each deployed app owns its authentication boundary, data, OAuth issuer, and MCP endpoint:

```text
https://your-app.apps.clank.run/__clank/mcp
```

[Learn how per-app MCP works →](docs/per-app-mcp.md)

## Reactive code stays small

```tsx
/* @clankImportSource @clank.run/framework */
import { computed, signal } from "@clank.run/framework";

const count = signal(0);
const label = computed(() => `Count: ${count.value}`);

export function Counter() {
  return (
    <button
      class="rounded-full bg-slate-950 px-4 py-2 text-white"
      onClick={() => count.value++}
      agentId="increment"
      agentLabel="Increase count"
    >
      {label.value}
    </button>
  );
}
```

There is no virtual DOM. Components establish bindings once, and signals update only the text,
attribute, or keyed region that depends on them. The included compiler handles TypeScript and TSX;
applications do not need a separate runtime compiler or bundler.

## What is included

| Build the interface | Own the backend | Ship the product |
| --- | --- | --- |
| Signals, computed values, effects, stores, resources, typed TSX, keyed lists, forms, dialogs, tabs, routing, Tailwind CSS, SSR, and hydration | Runtime schemas, inferred API clients, auth, roles, owned documents, SQLite indexes, atomic mutations, live queries, files, email, jobs, and webhooks | Interactive CLI, browser-approved login, project provisioning, secrets, migrations, backups, job/cron operations, health gates, rolling activation, metrics, logs, custom domains, and rollback |

<details>
<summary><strong>Explore the complete framework feature map</strong></summary>

| Layer | Features |
| --- | --- |
| Reactivity | Signals, lazy computed values, effects with cleanup, batching, rollback transactions, untracked reads, owned roots, deep proxy stores, snapshots, async resources, stream reduction |
| UI | Typed compiler-powered TSX, automatic reactive expressions and props, keyed lists, stable text nodes, lifecycle/context, forms, dialogs, tabs, disclosures, pagination, directives, `Show`, `For`, `Switch`, lazy components |
| Forms | Schema validation, typed fields, accessible control/error props, touched/dirty state, cross-field rules, cancellation, server errors, invalid-focus behavior, reset, agent-readable manifests |
| AI | Web-focused runtime schemas, automatic MCP Streamable HTTP actions, OAuth + PKCE agent authorization, JSON Schema output, side-effect policy, action runners, semantic views, native-label-aware inspect/activate/input surface with secret-value redaction |
| Routing | Parameters, optional segments, wildcards, repeated query values, async loaders, aborts, guards, redirects, titles, links, history navigation |
| Full stack | Inferred schemas, documents, arguments, and results; branded IDs; query and mutation functions; zero-codegen typed API references |
| Auth | Email/password sessions, scrypt hashing, secure cookies, CSRF, roles, revocation, default auth UI, SSR boot state |
| Data | Node's built-in SQLite, JSON documents, declared expression indexes, owned tables, atomic mutations, persisted revisions, dependency-tracked query cache |
| Live sync | Auth-partitioned Fetch RPC and cache, EventSource streams, session revocation, automatic invalidation, SSR seeding, multi-tab synchronization |
| SSR | Async string rendering, full-document templates, safe state serialization, CSP nonces, context and keyed lists, marker-based DOM-preserving hydration |
| Server | Fetch router, security headers, safe CORS, bounded Node HTTP adapter, Host checks, symlink-aware static files, response helpers |
| Object storage | Atomic owner-only local objects plus zero-dependency S3-compatible storage with SigV4, bounded retries, deadlines, verified SHA-256, and chunked encrypted recovery |
| Styling | Native `class`, reactive `classList`, style objects, CSS custom properties, and an atomic production Tailwind CLI pipeline |
| Deploy | Browser console, workspaces and RBAC, activity feeds, ingress metrics, transparent monthly usage and traffic limits, custom DNS/TLS onboarding, deterministic artifacts, optional off-host release and backup objects, encrypted secrets, immutable migrations, encrypted local and generation-bound provider backup/restore, storage-backed readiness, health-gated releases, logs, audit, rollback |
| Hosting safety | Explicit trusted/isolated profiles, isolated production default, constrained Docker runner, bounded artifacts, resource ceilings, and fail-closed runner configuration |
| Distributed execution | Durable leases, authenticated nodes, placement, desired generations, fenced operations, verified leased runtime transfer, provider-neutral agents, crash-safe provider data, deferred Docker activation, generation-bound ingress, a complete restart-safe provider service, and an authenticated provider bridge |

</details>

## Work on Clank itself

The framework has no dependencies, dev dependencies, or peer dependencies. Node 22.16+ provides
the TypeScript transform and built-in SQLite primitives.

```sh
git clone https://github.com/nearbycoder/clank.run.git
cd clank.run
npm run check
npm run dev
```

Open `http://127.0.0.1:4173` for the dependency-free browser examples. `npm` only runs repository
scripts here; it does not install a framework toolchain.

| Example | What it demonstrates |
| --- | --- |
| [`/examples/todo`](examples/todo) | The smallest keyed CRUD interface |
| [`/examples/commerce`](examples/commerce) | Catalog filtering, cart state, dialogs, and checkout forms |
| [`/examples/dashboard`](examples/dashboard) | Responsive SaaS navigation, tables, pagination, invitations, and settings |
| [`/examples/booking`](examples/booking) | Multi-step selection, validation, pricing, and confirmation |
| [`examples/fullstack`](examples/fullstack) | SSR, SQLite, live queries, and synchronization |
| [`examples/auth-todo`](examples/auth-todo) | Auth, isolated user data, Tailwind, SSR, and full live CRUD |

Run the full-stack references separately:

```sh
npm run dev:fullstack  # http://127.0.0.1:4180
npm run dev:auth       # http://127.0.0.1:4181
```

To develop the open-source control plane, run `npm run dev:platform`. Local platform work can use
`clank login --server=http://127.0.0.1:4200`; normal hosted use never needs the server flag.

For opt-in remote stateful projects, the package also ships `clank-runner` and
`clank-provider`. The control plane stays local-by-default; operators explicitly enable provider
placement, enroll a node, and select `--placement=provider` at project creation. See [Remote
runtime placement](docs/runtime-placement.md) before using it with production data.

## Documentation

The [documentation site](https://docs.clank.run) is searchable, responsive, and published as HTML,
Markdown, JSON, `llms.txt`, and a complete agent corpus.

| Start | Build | Operate | Verify |
| --- | --- | --- | --- |
| [Getting started](docs/getting-started.md)<br>[Application recipes](docs/application-recipes.md)<br>[AI blueprints](docs/blueprints.md)<br>[CLI](docs/cli.md) | [Reactivity](docs/reactivity.md)<br>[Rendering](docs/rendering.md)<br>[Forms](docs/forms.md)<br>[Routing](docs/routing.md)<br>[Full stack](docs/full-stack.md)<br>[Durable jobs and cron](docs/jobs-and-cron.md)<br>[Tailwind](docs/tailwind.md) | [Deployment](docs/deployment-platform.md)<br>[Preview environments](docs/preview-environments.md)<br>[Usage and limits](docs/usage-and-limits.md)<br>[Runner fleet](docs/runner-fleet.md)<br>[Runtime placement](docs/runtime-placement.md)<br>[Provider adapters](docs/provider-adapters.md)<br>[Provider data lifecycle](docs/provider-data-lifecycle.md)<br>[Provider Docker runtime](docs/provider-docker-runtime.md)<br>[Provider runtime ingress](docs/provider-runtime-ingress.md)<br>[Complete provider service](docs/provider-service.md)<br>[Dashboard and domains](docs/platform-dashboard.md)<br>[Migrations](docs/migrations.md)<br>[Backups](docs/recovery.md)<br>[Self-hosting](docs/self-hosting.md)<br>[Railway](docs/railway.md) | [Agent protocol](docs/agent-protocol.md)<br>[Per-app MCP](docs/per-app-mcp.md)<br>[Authentication](docs/authentication.md)<br>[Threat model](docs/threat-model.md)<br>[ASVS verification](docs/security-asvs.md)<br>[Conformance](docs/conformance.md) |

<details>
<summary><strong>Complete documentation index</strong></summary>

- [Documentation site source](docs-site/README.md)
- [Headless UI behavior](docs/ui.md)
- [Performance model](docs/performance.md)
- [AI-first contracts](docs/ai-first.md)
- [Organizations, RBAC, invitations, and scoped tokens](docs/organizations.md)
- [Service drivers for files, email, jobs, and webhooks](docs/services.md)
- [Atomic local and S3-compatible object storage](docs/object-storage.md)
- [Typed durable queues, worker processes, and cron](docs/jobs-and-cron.md)
- [Structured logs, traces, metrics, and health](docs/observability.md)
- [Durable distributed deployment and agent fencing](docs/distributed-deployment.md)
- [One-time enrollment and deployment runner fleet operations](docs/runner-fleet.md)
- [Integrity-checked remote runtime placement capsules](docs/runtime-placement.md)
- [Portable deployment provider adapters and HTTP bridge](docs/provider-adapters.md)
- [Crash-safe provider SQLite and release lifecycle](docs/provider-data-lifecycle.md)
- [Isolated provider Docker launch and restart reconciliation](docs/provider-docker-runtime.md)
- [Generation-bound provider runtime ingress and draining](docs/provider-runtime-ingress.md)
- [Complete fenced provider service composition](docs/provider-service.md)
- [Isolated, expiring preview environments](docs/preview-environments.md)
- [Transparent usage accounting and traffic limits](docs/usage-and-limits.md)
- [Managed ingress, custom domains, and external PostgreSQL](docs/data-plane.md)
- [Chaos and failure testing](docs/chaos-testing.md)
- [Public beta readiness](docs/public-beta.md)
- [Code and product audit](docs/code-audit.md)
- [Maintenance and release certification](docs/maintenance.md)
- [Release process](docs/releases.md)
- [Authentication API](docs/auth.md)
- [Security and deployment](docs/security.md)
- [Database revisions and correctness](docs/database.md)
- [Platform security](docs/platform-security.md)
- [Server primitives](docs/server.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api-reference.md)
- [Renaming from Proact](docs/renaming-from-proact.md)

</details>

## Design principles

1. **Infer from runtime contracts.** Declare a validator once; TypeScript derives documents, IDs,
   function inputs, outputs, and clients while agents receive the equivalent JSON Schema.
2. **Update precisely.** Components establish bindings once; signals update only the dependent
   region or property.
3. **Use the platform.** Clank builds directly on DOM, Fetch, URL, AbortController, Proxy, Web
   History, Node, and SQLite primitives.
4. **Keep simple code simple.** A component is a function, state is an object with `.value`, and UI
   is ordinary HTML structure.
5. **Make dangerous behavior legible.** Actions declare side effects, confirmation expectations,
   validation, and authorization at their boundary.
6. **Make private data private by construction.** Auth-required functions and owned tables make the
   safe path the short path.
7. **Treat deployment as a transaction.** Build inputs, artifact contents, migrations, activation,
   recovery, and rollback remain explicit and auditable.

## Open source

Clank is [MIT licensed](LICENSE). Contributions are welcome—start with
[`CONTRIBUTING.md`](CONTRIBUTING.md), and report vulnerabilities through the private process in
[`SECURITY.md`](SECURITY.md).

The official npm package is [`@clank.run/framework`](https://www.npmjs.com/package/@clank.run/framework).
It installs the `clank` and `clank-platform` commands. The unrelated unscoped `clank` package is a
different project.
