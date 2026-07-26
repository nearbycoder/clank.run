# Agent guide

This is a minimal Clank application. Keep the generated output reproducible and the app deployable after every task.

## Working commands

- `npm run dev` builds and starts the app at http://127.0.0.1:3000.
- `npm run build` compiles `src/` into `dist/`.
- `npm run doctor` performs local readiness diagnostics.
- `npm run deploy:check` builds and verifies a deterministic artifact without login or upload.
- `npm run deploy` builds, creates or links the project, migrates, health-checks, and activates it.

## File map

- `src/view.tsx`: shared server and browser UI.
- `src/app.tsx`: browser hydration and interactions.
- `src/server.tsx`: routes, SSR, CSP, static files, and the Node listener.
- `migrations/`: immutable ordered SQL history.
- `clank.deploy.json`: build, database, health, and artifact contract.
- `.clank/`: local artifacts and project link; never commit it.

## Invariants

- Treat browser and agent input as untrusted.
- Keep important controls accessible and give agent-facing controls stable `agentId` values.
- Never edit, rename, or remove an applied migration. Add the next numbered migration.
- Keep secrets out of source, deployment config, logs, labels, and agent metadata.
- Keep `/healthz` cheap and independent of optional services.
- Do not hand-edit `dist/`; it is generated.

## Definition of done

Run `npm run build`, `npm run doctor`, and `npm run deploy:check`. Verify the initial server-rendered UI, hydration, and the changed interaction in a browser.
