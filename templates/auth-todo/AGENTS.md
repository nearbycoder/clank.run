# Agent guide

This is a Clank full-stack application. Keep the safe path short, the generated output reproducible, and the app deployable after every task.

## Working commands

- `npm run dev` builds, starts, watches, health-swaps, and browser-reloads the app at http://127.0.0.1:3000.
- `npm run jobs:worker` builds and starts a durable background worker.
- `npm run jobs:scheduler` builds and starts the cron scheduler.
- `npm run build` compiles `src/` into `dist/`.
- `npm run doctor` performs local readiness diagnostics.
- `npm run deploy:check` builds and verifies a deterministic artifact without login or upload.
- `npm run deploy` builds, creates/links the project when needed, migrates, health-checks, and activates it.
- `clank help --json` exposes the CLI contract for automation.

## File map

- `src/backend.ts`: auth, schemas, owned data, queries, mutations, durable jobs, and authorization.
- `src/jobs.ts`: provider-neutral worker/scheduler process entry.
- `src/view.tsx`: accessible UI and stable agent-addressable controls.
- `src/app.tsx`: hydration, auth client, live query, and browser interactions.
- `src/server.tsx`: routes, SSR, CSP, static files, and API wiring.
- `migrations/`: immutable ordered SQL history.
- `clank.deploy.json`: build, artifact, database, health, jobs, and public environment contract.
- `.clank/`: local artifacts and project link; never commit it.

## Invariants

- Preserve user ownership on every todo query and mutation.
- Enqueue follow-up work through mutation `jobs` so application writes and job delivery commit
  atomically. Keep handlers idempotent because delivery is at least once.
- Honor `context.signal`, bound external calls, and put permanent failures in the dead-letter state
  for explicit inspection or retry.
- Treat browser and agent input as untrusted; validate at the backend boundary.
- Give every backend function a precise `description`; mark additive writes with
  `agent: { destructive: false }`, destructive writes explicitly, and internal functions with
  `agent: false`.
- Preserve the default `/__clank/mcp` endpoint and OAuth flow unless an integration requires a
  documented path change.
- Never edit, rename, or remove an applied migration. Add the next numbered migration.
- Keep secrets out of source, deployment config, logs, labels, and agent metadata. Use `clank secrets set`.
- Keep stable `agentId` and useful `agentLabel` values on important controls.
- Keep `/healthz` cheap and independent of optional external services.
- Do not hand-edit `dist/`; it is generated.

## Definition of done

Run `npm run build`, `npm run doctor`, and `npm run deploy:check`. For UI changes, verify registration/login and todo creation in a browser. For data changes, verify both a fresh database and an existing migrated database. For backend changes, connect to `/__clank/mcp`, inspect `tools/list`, and verify the narrowest OAuth scope that can perform the action.
