# Headless UI interaction lab

This repository fixture exercises representative Clank headless controllers with native forms,
lazy popup presence, portals, focus management, keyboard input, responsive layout, and
Tailwind-ready state hooks. It imports the public `@clank.run/framework` package name; the example
page's import map resolves the focused `/dom` and `/ui` package paths to the repository build while
developing Clank itself.

From the repository root:

```sh
npm run dev
```

Open `http://127.0.0.1:4173/examples/headless-ui/`. Run `npm run build` after changing TypeScript
when the development supervisor is not already watching the fixture.
