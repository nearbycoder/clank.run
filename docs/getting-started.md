# Getting started with the npm package

Install one npm package, create an authenticated full-stack application, and run it locally. You do not need to clone the Clank repository or assemble a framework toolchain.

## Requirements

- Node.js 22.16 or newer.
- npm 10 or newer.
- A modern browser.

The official package is `@clank.run/framework`. The unscoped `clank` package on npm is a different project.

## 1. Install Clank

Install the package globally to make the `clank` command available in every project:

```sh
npm install --global @clank.run/framework
clank --version
```

The package contains the framework runtime, TypeScript and TSX compiler, project starter, development commands, deployment client, and type declarations. It has no transitive npm dependencies.

Run `clank` by itself in an interactive terminal to choose a template and follow a guided create, login, check, or deploy workflow:

```sh
clank
```

Agents and scripts can discover the same starters without parsing prose:

```sh
clank templates --json
clank create my-app --json
```

The first command returns template capabilities; the second returns the exact generated file
manifest and next commands.

Bare `clank` prints the full command reference when standard input is not interactive, so it never blocks an agent or CI job waiting for a prompt.

Prefer a project-local CLI? Install the same package in an existing project and run its binary through npm:

```sh
npm install @clank.run/framework
npx clank --version
```

The rest of this guide uses the global `clank` command.

## 2. Create an application

```sh
clank create my-app
cd my-app
npm install
```

`clank create` starts with a working product rather than a blank component. The generated application already has:

- email and password registration, login, logout, secure sessions, and CSRF protection;
- private per-user Todo data in SQLite;
- server rendering and node-preserving browser hydration;
- live updates across tabs and browsers;
- validated queries and mutations with inferred TypeScript types;
- Tailwind utility styling;
- an initial immutable database migration;
- health checks and deterministic deployment configuration;
- a deterministic synthetic fixture and application-owned backend/SSR contract test; and
- `README.md` and `AGENTS.md` instructions for people and coding agents.

The generated `package.json` has one application dependency:

```json
{
  "dependencies": {
    "@clank.run/framework": "^0.10.0"
  }
}
```

The scaffold uses the version of the CLI that created it. Commit the generated lockfile so every human, agent, and deployment uses the same resolved package.

## 3. Run it

```sh
npm run dev
```

Open `http://127.0.0.1:3000`, register an account, and create a Todo. Open the same URL in a second browser and sign in with the same account; committed changes update both sessions.

The starter stores local data in `app.sqlite`. That file, generated JavaScript, and local deployment state are ignored by Git.

## Your application files

This is the structure of the app created from npm, not the structure of the Clank framework repository:

```text
my-app/
├── fixtures/
│   └── default.json     deterministic synthetic test state
├── tests/
│   └── app.contract.mjs backend, agent manifest, isolation, and SSR contract
├── src/
│   ├── backend.ts       auth, schema, queries, mutations, and durable jobs
│   ├── jobs.ts          independent worker/scheduler process entry
│   ├── view.tsx         accessible server/client UI
│   ├── app.tsx          hydration, live data, and browser interactions
│   └── server.tsx       routes, SSR, security headers, and static files
├── migrations/
│   └── 0001_app_metadata.sql
├── AGENTS.md            app map, invariants, and definition of done
├── README.md            human setup and deployment instructions
├── clank.deploy.json    build, database, health, jobs, and artifact contract
├── package.json         scripts and the Clank package dependency
└── tsconfig.json
```

Start in `src/view.tsx` when changing what the app looks like. Put trusted data rules in `src/backend.ts`, browser coordination in `src/app.tsx`, and HTTP or SSR behavior in `src/server.tsx`. Never hand-edit `dist/`; Clank generates it.

Run `npm test` before and after a change. It builds the app and exercises the app-owned contract
against an isolated database; fixture files are never included in a deployment.

## Everyday commands

The generated npm scripts keep the normal workflow short:

```sh
npm run dev           # build, supervise, watch, and browser-reload the local server
npm run jobs:worker   # build and start a worker in a second terminal
npm run jobs:scheduler # run cron after adding schedules
npm run build         # compile src/ into dist/
npm run doctor        # check Node, config, migrations, login, and project link
npm run deploy:check  # build and verify an offline deployment artifact
npm run deploy        # build, migrate, health-check, and deploy
```

You can call the package CLI directly when you need more control:

```sh
clank dev
clank build src dist
clank watch src dist
clank jobs worker --concurrency=4
clank jobs scheduler
clank doctor --json
clank help --json
```

The JSON forms are stable interfaces for coding agents and automation.

## Make the first change

Components are ordinary functions that return typed TSX. Reactive values use `.value`, and Clank updates only the DOM bindings that read them:

```tsx
/* @clankImportSource @clank.run/framework */
import { computed, signal } from "@clank.run/framework";

export function Counter() {
  const count = signal(0);
  const label = computed(() => `Count: ${count.value}`);

  return (
    <button
      class="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white"
      onClick={() => count.value++}
      agentId="increment"
      agentLabel="Increase count"
    >
      {label.value}
    </button>
  );
}
```

The `@clankImportSource` comment tells Clank's compiler where JSX primitives come from. `agentId` gives an important control a stable machine-readable identity, while `agentLabel` explains its purpose without changing the visible UI.

## Add data safely

The starter's `src/backend.ts` is the source of truth for data and authorization:

```ts
import { defineDatabase, defineTable, s } from "@clank.run/framework";

export const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).owned(),
});
```

`.owned()` scopes records to the signed-in user. Define validated queries and mutations beside the schema; the browser client infers their arguments and results without a code-generation step. Read [Full-stack applications](full-stack.md), [Authentication](auth.md), and [Database revisions and correctness](database.md) before expanding the starter's data model.

Add a new numbered SQL file for every schema change:

```text
migrations/0002_add_due_dates.sql
```

Never edit or reorder an applied migration. Clank checks migration history before activation and backs up the database before production migrations. See [SQLite migrations](migrations.md).

## Move slow work out of requests

The authenticated starter shows the complete path: `defineJobs` declares a validated handler,
`defineBackend({ jobs })` gives mutations a transaction-scoped publisher, and `src/jobs.ts` runs an
independent worker or scheduler. Todo creation and its queue record commit atomically.

Run `npm run jobs:worker` in a second terminal while developing. A production deploy reads the
`jobs` section in `clank.deploy.json` and supervises the configured processes automatically. Job
delivery is at least once, so make external effects idempotent and honor the handler abort signal.
See [Durable jobs and cron](jobs-and-cron.md).

## Use the app's built-in MCP server

Every generated app exposes its agent-enabled backend queries and mutations through its own MCP
endpoint:

```text
https://<project>.apps.clank.run/__clank/mcp
```

The browser UI and an MCP client call the same functions from `src/backend.ts`, so validation,
authentication, `.owned()` data isolation, transactions, and live updates behave identically.
Server-backed controls use typed `agentAction={api.todos.add}` references, and `npm test` rejects
rendered controls that no longer match the current backend/MCP manifest or contract revision.
Connect from Codex with:

```sh
codex mcp add my-app \
  --url https://my-app.apps.clank.run/__clank/mcp
codex mcp login my-app
```

The user signs into the application and approves access in the browser. They do not need the
Clank CLI, deployment-account access, or a manual callback copy. See
[The MCP server built into every app](per-app-mcp.md) for the query/mutation mapping, OAuth model,
typed UI action binding, parity verifier, and contract-freshness checklist.

## Use Tailwind

The starter is already configured for Tailwind utility classes and compiles `src/styles.css` to
`dist/styles.css` during every build. You can edit `class` values in TSX immediately; Clank does
not wrap or reinterpret them, and production serves the static stylesheet without a browser CDN.
For the compiler contract and standalone-binary option, see [Tailwind CSS](tailwind.md).

## Build with an agent

Open the generated directory in your coding agent and describe the product you want. For example:

```text
Turn this starter into a shared meal planner. Keep authentication, make every
record user-owned, add immutable migrations, preserve live updates, and run
npm run build, npm run doctor, and npm run deploy:check when finished.
```

The generated `AGENTS.md` tells the agent where each concern belongs, which security and migration invariants it must preserve, and how to prove the app is deployable. The documentation is also available as [a compact agent map](https://docs.clank.run/llms.txt), [the complete Markdown corpus](https://docs.clank.run/llms-full.txt), and [structured JSON](https://docs.clank.run/api/docs.json).

## Deploy

Sign in once, check the app, and deploy:

```sh
clank login
clank whoami
npm run doctor
npm run deploy
```

Login uses `https://clank.run` by default. Pass `--server` only when using a self-hosted Clank control plane. The first deployment creates and links an isolated project automatically. The CLI builds locally, packages the exact framework runtime and application files, verifies their digests, applies migrations, waits for the health check, and then activates the release.

Use `npm run deploy:check` whenever you only want to build and inspect the artifact. It does not require login or network access. Continue with the [Deployment CLI](cli.md) for custom domains, secrets, logs, rollback, backups, organizations, and automation.

## Package imports

Import from the root for most apps:

```ts
import {
  createApp,
  defineBackend,
  renderDocument,
  signal,
} from "@clank.run/framework";
```

Focused public entry points are also available:

```ts
import { signal } from "@clank.run/framework/core";
import { render } from "@clank.run/framework/dom";
import { createRouter } from "@clank.run/framework/router";
import { createForm } from "@clank.run/framework/forms";
import { defineAuth } from "@clank.run/framework/auth";
import { defineBackend } from "@clank.run/framework/backend";
import { defineJobs, runJobProcess } from "@clank.run/framework/jobs";
import { createApp } from "@clank.run/framework/server";
import { serve } from "@clank.run/framework/node";
```

Imports do not mutate global state. The package ships its TypeScript declarations and supports strict editor type checking with `"jsx": "preserve"`.

## Next steps

- [Application recipes](application-recipes.md): choose the right client, server, data, and deployment shape.
- [Reactivity](reactivity.md): learn signals, computed values, effects, stores, resources, and transactions.
- [Rendering and components](rendering.md): understand TSX, keyed lists, SSR, and hydration.
- [Routing](routing.md): add URL-driven pages, parameters, loaders, guards, and navigation.
- [Authentication](auth.md): customize profiles, sessions, authorization, and the default auth UI.
- [Durable jobs and cron](jobs-and-cron.md): add transactional queues, worker processes, retries,
  dead letters, and time-zone-aware schedules.
- [Per-app MCP servers](per-app-mcp.md): connect agents directly to application queries and mutations.
- [Deployment CLI](cli.md): ship and operate the application.
- [Contributing to Clank](../CONTRIBUTING.md): clone the framework repository only when you want to change Clank itself.
