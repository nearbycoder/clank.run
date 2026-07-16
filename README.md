# Clank

Clank is a dependency-free, AI-first full-stack TypeScript framework and open-source deployment platform. It combines fine-grained reactivity, direct DOM rendering, SSR with node-preserving hydration, inference-first server functions, built-in auth, user-owned SQLite documents, live queries, deterministic artifacts, database migrations, and atomic deployment.

“AI-first” does not mean putting a chat box on every page. In Clank, the same application has two first-class interfaces:

- Humans receive accessible HTML, responsive state, forms, navigation, and Tailwind styling.
- Agents receive named actions with JSON Schema, explicit side-effect and confirmation metadata, and a compact semantic view of the interactive UI.

The framework itself has no dependencies, dev dependencies, peer dependencies, virtual DOM, runtime compiler, or bundler. Clank's build-time TSX compiler is included; Node 22.13+ supplies the final TypeScript-to-JavaScript transform.

## What works

| Layer | Features |
| --- | --- |
| Reactivity | Signals, lazy computed values, effects with cleanup, batching, rollback transactions, untracked reads, owned roots, deep proxy stores, snapshots, async resources, stream reduction |
| UI | Typed compiler-powered TSX, automatic reactive expressions and props, keyed lists, stable text nodes, lifecycle/context, forms, dialogs, tabs, disclosures, pagination, directives, `Show`, `For`, `Switch`, lazy components |
| Forms | Schema validation, typed fields, accessible control/error props, touched/dirty state, cross-field rules, cancellation, server errors, invalid-focus behavior, reset, agent-readable manifests |
| AI | Web-focused runtime schemas, JSON Schema output, typed actions, authorization, side-effect/confirmation policy, action runners, semantic views, native-label-aware inspect/activate/input surface with secret-value redaction |
| Routing | Parameters, optional segments, wildcards, repeated query values, async loaders, aborts, guards, redirects, titles, links, history navigation |
| Full stack | Inferred schemas/documents/arguments/results, branded IDs, query and mutation functions, zero-codegen typed API references |
| Auth | Email/password sessions, scrypt hashing, secure cookies, CSRF, roles, revocation, default auth UI, SSR boot state |
| Data | Node's built-in SQLite, JSON documents, declared expression indexes, owned tables, atomic mutations, persisted revisions, dependency-tracked query cache |
| Live sync | Auth-partitioned Fetch RPC and cache, EventSource streams, session revocation, automatic invalidation, SSR seeding, multi-tab synchronization |
| SSR | Async string rendering, full-document templates, safe state serialization, CSP nonces, context and keyed lists, marker-based DOM-preserving hydration |
| Server | Fetch router, security headers, safe CORS, bounded Node HTTP adapter, Host checks, symlink-aware static files, response helpers |
| Styling | Native `class`, reactive `classList`, style objects, CSS custom properties, Tailwind Play CDN and compiled Tailwind CSS compatibility |
| Deploy | Browser-approved CLI auth, projects, deterministic artifacts, encrypted secrets, immutable migrations, SQLite backups, health-gated releases, logs, audit, rollback |

## Run it

```sh
npm run check
npm run dev
```

Open `http://127.0.0.1:4173`. `npm` only runs scripts here; `package.json` installs nothing.

The development server also exposes several complete application shapes:

- `/examples/commerce/index.html`: catalog, filtering, cart dialog, and checkout form.
- `/examples/dashboard/index.html`: responsive SaaS admin, tabs, tables, pagination, invitations, and settings.
- `/examples/booking/index.html`: multi-step dates, room selection, guest details, pricing, and confirmation.
- `/examples/todo/index.html`: the smallest focused keyed CRUD example.

Run the SSR + SQLite + live-sync example separately:

```sh
npm run dev:fullstack
```

Open `http://127.0.0.1:4180` in two tabs. A committed mutation in either tab streams a new query snapshot to both. The first response already contains the todo HTML; the client hydrates those exact nodes.

Run the auth-first reference app:

```sh
npm run dev:auth
```

Open `http://127.0.0.1:4181`, create an account, and sign into that account from a second browser. Registration, secure sessions, a synchronized profile, create/rename/complete/remove todo operations, per-user data isolation, SSR, Tailwind, and live synchronization are already wired. The complete source and Tailscale instructions are in [`examples/auth-todo`](examples/auth-todo).

Create and deploy a new authenticated app:

```sh
npm run dev:platform
# Create an account at http://127.0.0.1:4200

clank login --server=http://127.0.0.1:4200
clank create my-app
cd my-app
npm install
clank deploy
```

The generated app installs only Clank, which has no transitive dependencies. The CLI builds locally without a shell, vendors the exact Clank runtime, verifies every path and SHA-256 digest, applies ordered SQLite migrations behind a backup, health-checks the candidate, and restores the previous release automatically on failure.

The smallest application is:

```tsx
import { computed, render, signal } from "./dist/index.js";

const count = signal(0);
const label = computed(() => `Count: ${count.value}`);

function App() {
  return (
    <button
      class="rounded-full bg-slate-900 px-4 py-2 text-white"
      onClick={() => count.value++}
      agentId="increment"
      agentLabel="Increase count"
    >
      {label.value}
    </button>
  );
}

render(document.querySelector("#app")!, <App />);
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Reactivity](docs/reactivity.md)
- [Rendering and components](docs/rendering.md)
- [Forms](docs/forms.md)
- [Headless UI behavior](docs/ui.md)
- [Performance model](docs/performance.md)
- [AI-first contracts](docs/ai-first.md)
- [AI application blueprints](docs/blueprints.md)
- [Authentication, MFA, passkeys, and recovery](docs/authentication.md)
- [Organizations, RBAC, invitations, and scoped tokens](docs/organizations.md)
- [Service drivers for files, email, jobs, and webhooks](docs/services.md)
- [Structured logs, traces, metrics, and health](docs/observability.md)
- [Encrypted backups and disaster recovery](docs/recovery.md)
- [Durable distributed deployment and agent fencing](docs/distributed-deployment.md)
- [Managed ingress, custom domains, and external PostgreSQL](docs/data-plane.md)
- [ASVS-oriented security verification](docs/security-asvs.md)
- [Threat model](docs/threat-model.md)
- [Chaos and failure testing](docs/chaos-testing.md)
- [Public beta readiness](docs/public-beta.md)
- [Application recipes for humans and agents](docs/application-recipes.md)
- [Packaged-release conformance](docs/conformance.md)
- [Code and product audit](docs/code-audit.md)
- [Release process](docs/releases.md)
- [Authentication](docs/auth.md)
- [Security and deployment](docs/security.md)
- [Deployment platform](docs/deployment-platform.md)
- [Deployment CLI](docs/cli.md)
- [Renaming from Proact](docs/renaming-from-proact.md)
- [SQLite migrations](docs/migrations.md)
- [Database revisions and correctness](docs/database.md)
- [Platform security](docs/platform-security.md)
- [Self-hosting](docs/self-hosting.md)
- [Routing](docs/routing.md)
- [Server primitives](docs/server.md)
- [Full-stack SSR, SQLite, and live sync](docs/full-stack.md)
- [Tailwind CSS](docs/tailwind.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api-reference.md)

## Design principles

1. **Inference should flow from runtime contracts.** Declare a validator once; TypeScript derives documents, IDs, function inputs, outputs, and clients while agents receive the equivalent JSON Schema.
2. **Fine-grained updates beat tree rerenders.** Components establish bindings once; signals update only the dependent region or property.
3. **The platform is the dependency.** Clank uses DOM, Fetch, URL, AbortController, Proxy, Web History, and Node primitives directly.
4. **Simple code should stay simple.** A component is a function, state is an object with `.value`, and UI is ordinary HTML structure.
5. **Dangerous behavior must be legible.** Actions declare side effects, confirmation expectations, validation, and authorization at their boundary.
6. **Private data should be private by construction.** Auth-required functions and owned tables make the safe path the short path.
7. **Deployment should be a verifiable transaction.** Build inputs, artifact contents, migration history, activation, failure recovery, and rollback are explicit and auditable.

Clank is MIT licensed.

The official npm package is `clank.run`; the installed executables are `clank` and `clank-platform`. The unrelated unscoped `clank` package on npm is not this framework.
