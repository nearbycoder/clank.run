# Getting started

## Requirements

- Node.js 22.13 or newer for the zero-package TypeScript build.
- A modern browser with ES modules, Proxy, AbortController, and the DOM APIs.

There is no install step in this repository. The `package.json` contains no dependency fields. Run:

```sh
npm run build
npm run dev
```

The build script first lowers TSX into fine-grained Clank bindings, then uses Node's built-in `stripTypeScriptTypes` transform. It writes browser modules to `dist/` without bundling them.

## Project shape

```text
src/                    framework TypeScript
dist/                   generated browser modules
examples/hello/         complete interactive application
examples/todo/          focused keyed todo application
examples/commerce/      client commerce catalog, cart, and checkout
examples/dashboard/     responsive SaaS admin and data table
examples/booking/       multi-step travel booking flow
examples/fullstack/     shared SSR/client todo with SQLite live sync
examples/auth-todo/     auth-first SSR todo with owned data and live sync
scripts/tsx.mjs         dependency-free fine-grained TSX transform
scripts/clank.mjs      public build/watch CLI
scripts/build.mjs       repository build orchestration
scripts/dev.mjs         static development server and watcher
tests/                  Node test-runner suites
docs/                   framework guides
```

## HTML entry point

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My Clank app</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

## Application entry point

```tsx
import { render, signal } from "/dist/index.js";

const name = signal("world");

function App() {
  return (
    <main class="mx-auto max-w-xl p-8">
      <h1 class="text-3xl font-bold">Hello, {name.value}</h1>
      <input bind:value={name} agentId="name" agentLabel="Name" />
    </main>
  );
}

const dispose = render(document.querySelector("#app")!, <App />);
```

`render()` returns a disposer. Call it when the application root should unmount.

## Compile your own app

The published package includes a `clank` executable. It compiles `.ts` and `.tsx`, copies static assets, and can watch the source tree:

```sh
clank build src dist
clank watch src dist
```

The default generated TSX import is `clank`. For direct browser modules without an import map, point it at the served framework module:

```sh
clank build src dist --jsx-import-source=/vendor/clank/index.js
```

You can override that choice in an individual `.tsx` file with `@clankImportSource` in its leading comment. Clank intentionally uses its own pragma name so TypeScript does not look for a conventional `jsx-runtime` package.

For editor type checking, use `"jsx": "preserve"` and include Clank's declarations. The compiler itself performs syntax lowering rather than static type checking; run `tsc --noEmit` in CI when a TypeScript compiler is available.

## Development commands

```sh
npm run build   # compile TypeScript with Node itself
npm test        # build, then run all tests
npm run check   # build, assert zero dependencies, run tests
npm run dev     # rebuild on changes and serve the example
```

## Import boundaries

The root module exports everything. Smaller public paths are also available:

```ts
import { signal } from "clank/core";
import { h, render } from "clank/dom";
import { createRouter } from "clank/router";
import { defineAction, s } from "clank/ai";
import { createForm } from "clank/forms";
import { createDialog, createTabs } from "clank/ui";
import { createApp, json } from "clank/server";
import { defineAuth, createAuthClient } from "clank/auth";
import { defineBackend, defineDatabase, defineTable } from "clank/backend";
import { renderDocument } from "clank/ssr";
import { serve, staticFiles } from "clank/node";
import { compile, transformTSX } from "clank/compiler";
```

No API mutates global state merely by being imported.

Clank's JSX declarations type native element properties, event `currentTarget`, reactive attributes, bind/ref/directive protocols, ARIA/data attributes, and hyphenated custom elements. Misspelled native tags fail strict TypeScript rather than silently becoming unknown elements.

## Todo example

The focused [todo source](../examples/todo/app.tsx) demonstrates the normal application shape: signals for state, computed derivations, a keyed `For`, ordinary event handlers, `bind:value`, semantic agent metadata, and Tailwind utility classes. After `npm run dev`, it is served at `/examples/todo/index.html`.

## Full-stack example

```sh
npm run dev:fullstack
```

The [full-stack todo](../examples/fullstack/backend.ts) declares its document schema and query/mutation tree once. The shared [view](../examples/fullstack/view.tsx) renders on the server and hydrates in the browser. The [server](../examples/fullstack/server.tsx) uses SQLite, the Fetch router, the Node adapter, and the Tailwind browser build without adding a package dependency. See the [full-stack guide](full-stack.md) for the complete data flow.

## Auth-first example

```sh
npm run dev:auth
```

The [authenticated Todo](../examples/auth-todo/backend.ts) adds `defineAuth()`, marks its private table `.owned()`, and uses `createClient<typeof backend>()` in the browser. The framework supplies registration, login, sessions, CSRF headers, an accessible default auth screen, SSR auth state, private query scoping, and live multi-tab updates.

Read [Authentication](auth.md) before adding custom profile fields, roles, or production deployment settings.

## Complete interface variants

Run `npm run dev`, then open:

- `/examples/commerce/`
- `/examples/dashboard/`
- `/examples/booking/`

They exercise the form and headless UI APIs across product catalog, administrative, and multi-step workflow designs. See [Application recipes](application-recipes.md) for how to choose the corresponding architecture.
