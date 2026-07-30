# __PROJECT_TITLE__

A minimal full-stack Clank application with server rendering, node-preserving hydration, reactive TypeScript, Tailwind styling, a health check, and deterministic deployment.

## Start

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000.
Clank watches the project, rebuilds after source or migration changes, starts a healthy replacement
before stopping the previous process, and reloads connected browser tabs. A failed build leaves the
last good server running.

The build compiles `src/styles.css` with the local Tailwind CLI and serves the resulting static
`dist/styles.css`; production does not load Tailwind from a browser CDN.

`npm test` builds and verifies deterministic server-rendered hydration content with Node's built-in
test runner.

## Check and deploy

```sh
npm test
npm run doctor
npm run deploy:check
clank login
npm run deploy
```

The first deployment creates and links an isolated project automatically. See `AGENTS.md` for the app map and safety invariants.
