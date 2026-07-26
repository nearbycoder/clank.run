# __PROJECT_TITLE__

A minimal full-stack Clank application with server rendering, node-preserving hydration, reactive TypeScript, Tailwind styling, a health check, and deterministic deployment.

## Start

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000.

## Check and deploy

```sh
npm run build
npm run doctor
npm run deploy:check
clank login
npm run deploy
```

The first deployment creates and links an isolated project automatically. See `AGENTS.md` for the app map and safety invariants.
