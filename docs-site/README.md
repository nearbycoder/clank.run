# Clank Documentation

The application served at [docs.clank.run](https://docs.clank.run). It is built with Clank itself and has no package dependencies.

The site treats the repository's `docs/*.md` files as canonical. Its build validates that every guide appears exactly once in `content-manifest.mjs`, compiles the Clank server and browser enhancement, copies the exact local framework runtime, and snapshots the source corpus into a deterministic deployment artifact.

## Develop

```sh
cd docs-site
npm run dev
```

Open `http://127.0.0.1:4300`.

## Verify

```sh
npm run build
npm run doctor
npm run deploy:check
```

## Deploy

```sh
node ../scripts/clank.mjs login
npm run deploy
node ../scripts/clank.mjs domain add docs.clank.run
```

Publish the DNS records returned by the control plane, then run `clank domain verify <domain-id>`.

## Agent-readable endpoints

- `/llms.txt` — compact navigation and retrieval map
- `/llms-full.txt` — complete canonical corpus
- `/api/docs.json` — structured guide index
- `/api/docs/<slug>.json` — one guide with metadata and Markdown
- `/raw/<slug>.md` — canonical raw Markdown
- `/.well-known/clank` — agent discovery with the canonical MCP endpoint
- `/__clank/mcp` — public, read-only MCP tools for listing, searching, and reading guides
