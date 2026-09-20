# Clank Design Studio

The dependency-free component explorer served at [design.clank.run](https://design.clank.run).
It is built with Clank itself, renders every headless component family, and consumes the reusable
`@clank.run/framework/ui/theme` contract with ten built-in themes.

The inspector supports keyboard tabs and copying the displayed usage example. Favorite components
stay in this browser and remain available when storage is blocked for the current session. The theme
gallery can be searched and filtered by light or dark appearance. Theme Sandbox exports its applied
overrides as scoped CSS through copy or download; invalid edits do not enter the export.

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
