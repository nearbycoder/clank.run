# Clank Design Studio

This directory is the canonical dependency-free component explorer served at `design.clank.run`.
It is a real Clank application and consumes the exact framework UI catalog and theme exports that
downstream applications use.

## Commands

- `npm run build` compiles the server and browser studio, generates the preset theme stylesheet,
  and vendors the current local Clank runtime.
- `npm run dev` starts the built site at `http://127.0.0.1:4400`.
- `npm run doctor` checks the deployment contract.
- `npm run deploy:check` builds and verifies an offline release artifact.
- `npm run deploy` publishes to the linked Clank project.

## Source boundaries

- `src/studio.tsx` owns navigation, preview controls, story documentation, and theme selection.
- `src/stories.tsx` must keep one live story for every entry in `UI_COMPONENT_CATALOG`.
- `src/styles.css` uses only semantic `--clank-*` theme variables for component presentation.
- `src/server.tsx` owns SSR, security headers, APIs, agent discovery, and the public read-only MCP server.
- `build.mjs` generates theme CSS from `CLANK_THEME_PRESETS`; never hand-copy preset values.
- Generated `dist/` and `vendor/` directories are never edited or committed.

## Definition of done

Run `npm run build`, `npm run doctor`, and `npm run deploy:check`. Verify the overview, theme lab,
all 39 component routes, direct SSR, hydration, theme switching, viewport controls, search, dialogs,
menus, selection, forms, portal styling, the JSON catalog, MCP discovery, and mobile layout.
