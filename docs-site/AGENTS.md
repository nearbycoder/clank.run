# Clank documentation site

This is the canonical documentation application for Clank. It is itself a zero-dependency Clank application and deploys through the public Clank CLI.

## Commands

- `npm run build` compiles the site, copies the current framework runtime, and snapshots the canonical Markdown corpus.
- `npm run dev` starts the built site at `http://127.0.0.1:4300`.
- `npm run doctor` checks the deployment contract.
- `npm run deploy:check` creates and verifies an offline deployment artifact.
- `npm run deploy` publishes through the linked Clank platform project.

## Source boundaries

- Edit framework prose in `../docs/*.md`; do not duplicate guide text inside the site.
- `content-manifest.mjs` owns navigation order and grouping. Every canonical guide must appear exactly once.
- `src/markdown.ts` is the trusted-Markdown renderer. It must escape raw HTML and reject unsafe links.
- `src/server.tsx` owns routes, metadata, agent endpoints, and server rendering.
- `src/search.tsx` is the shared SSR/hydrated search control.
- `src/app.tsx` contains progressive client enhancements.
- Generated `content/`, `dist/`, and `vendor/` directories are never edited or committed.

## Agent surfaces

Keep `/llms.txt`, `/llms-full.txt`, `/api/docs.json`, `/api/docs/:slug.json`, and `/raw/:slug.md` stable, complete, and discoverable from every page.

## Definition of done

Run `npm run build`, `npm run doctor`, and `npm run deploy:check`. Verify home, search, a long guide, raw Markdown, JSON, and both LLM text endpoints at desktop and phone widths. The full repository check must remain green.
