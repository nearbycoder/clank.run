# Clank Design Studio

The dependency-free component explorer served at [design.clank.run](https://design.clank.run).
It is built with Clank itself, renders every headless component family, and consumes the reusable
`@clank.run/framework/ui/theme` contract with ten built-in themes.

## Develop

```sh
cd design-site
npm run dev
```

Open `http://127.0.0.1:4400`.

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
node ../scripts/clank.mjs domain add design.clank.run
```

The site also publishes the complete component and theme contracts through `/api/catalog.json`,
`/api/themes.json`, `/.well-known/clank`, and the public read-only `/__clank/mcp` endpoint.
