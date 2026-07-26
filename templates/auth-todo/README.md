# __PROJECT_TITLE__

A full-stack Clank app with built-in authentication, private per-user todos, SQLite migrations, server rendering, hydration, Tailwind styling, and live synchronization across browsers.

## Start

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Register the first account, then open a second browser to see committed changes synchronize live.

## Check and deploy

```sh
npm run build
npm run doctor
npm run deploy:check
clank login --server https://your-clank-platform.example
npm run deploy
```

The first deployment creates and links the project automatically. No remote package install or build hook runs: the CLI sends a deterministic artifact containing the exact Clank runtime.

See `AGENTS.md` for the app map and safety invariants.
