# Agent guide

This is a Clank full-stack application. Keep the safe path short, the generated output reproducible, and the app deployable after every task.

## Working commands

- `npm run dev` builds and starts the app at http://127.0.0.1:3000.
- `npm run build` compiles `src/` into `dist/`.
- `npm run doctor` performs local readiness diagnostics.
- `npm run deploy:check` builds and verifies a deterministic artifact without login or upload.
- `npm run deploy` builds, creates/links the project when needed, migrates, health-checks, and activates it.
- `clank help --json` exposes the CLI contract for automation.

## File map

- `src/backend.ts`: auth, schemas, owned data, queries, mutations, and authorization.
- `src/view.tsx`: accessible UI and stable agent-addressable controls.
- `src/app.tsx`: hydration, auth client, live query, and browser interactions.
- `src/server.tsx`: routes, SSR, CSP, static files, and API wiring.
- `migrations/`: immutable ordered SQL history.
- `clank.deploy.json`: build, artifact, database, health, and public environment contract.
- `.clank/`: local artifacts and project link; never commit it.

## Invariants

- Preserve user ownership on every todo query and mutation.
- Treat browser and agent input as untrusted; validate at the backend boundary.
- Never edit, rename, or remove an applied migration. Add the next numbered migration.
- Keep secrets out of source, deployment config, logs, labels, and agent metadata. Use `clank secrets set`.
- Keep stable `agentId` and useful `agentLabel` values on important controls.
- Keep `/healthz` cheap and independent of optional external services.
- Do not hand-edit `dist/`; it is generated.

## Definition of done

Run `npm run build`, `npm run doctor`, and `npm run deploy:check`. For UI changes, verify registration/login and todo creation in a browser. For data changes, verify both a fresh database and an existing migrated database.
