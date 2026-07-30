# __PROJECT_TITLE__

A full-stack Clank app with built-in authentication, private per-user todos, durable background
jobs, SQLite migrations, server rendering, hydration, Tailwind styling, and live synchronization
across browsers.

## Start

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Register the first account, then open a second browser to see committed changes synchronize live.
Clank watches the project, rebuilds after source or migration changes, starts a healthy replacement
before stopping the previous process, and reloads connected browser tabs. A failed build leaves the
last good server running.

The build compiles `src/styles.css` with the local Tailwind CLI and serves the resulting static
`dist/styles.css`; production does not load Tailwind from a browser CDN.

Run the application-owned contract suite at any time:

```sh
npm test
```

It loads `fixtures/default.json` into an isolated in-memory database, verifies the agent action
manifest, typed UI↔MCP action references, ownership isolation, stored field values, and server
rendering. Fixtures are synthetic test inputs and are not included in the deployment artifact.

Todo creation also enqueues an `events` job in the same database transaction. Run a local worker
in a second terminal to process it without blocking requests:

```sh
npm run jobs:worker
```

Use `npm run jobs:scheduler` when you add cron schedules. A Clank deployment starts the configured
web, worker, and scheduler processes automatically.

## Check and deploy

```sh
npm test
npm run doctor
npm run deploy:check
clank login
npm run deploy
```

Login defaults to https://clank.run. Pass `--server` only for a self-hosted Clank platform. The first deployment creates and links the project automatically. No remote package install or build hook runs: the CLI sends a deterministic artifact containing the exact Clank runtime.

See `AGENTS.md` for the app map and safety invariants.
