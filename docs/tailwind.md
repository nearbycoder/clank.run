# Tailwind CSS

Clank preserves class strings exactly and keeps styling outside its reactive kernel. Tailwind scans
ordinary TSX such as:

```tsx
<button
  class="rounded-full bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500"
  classList={{ "opacity-50": disabled.value }}
>
  Save
</button>
```

## Generated production pipeline

Both built-in templates and AI blueprint output include:

```css
/* src/styles.css */
@import "tailwindcss";
@source "./**/*.{ts,tsx}";
```

and build with:

```sh
clank build src dist --tailwind=src/styles.css
```

Clank first compiles TypeScript/TSX and copies static source files. It then invokes the project's
local `@tailwindcss/cli` directly with an argument array and `shell: false`, writes to a temporary
file, and atomically replaces `dist/styles.css` only after a successful minified build. Generated
servers link `/styles.css` and use `style-src 'self'`; they do not allow or load a Tailwind browser
CDN.

`npm run dev` uses `clank dev`, so the same declared build command recompiles Tailwind before a
replacement application is health-checked and activated. Invalid CSS or a missing Tailwind
executable leaves the last good local server and stylesheet in place.

The generated app declares `tailwindcss` and `@tailwindcss/cli` as build-only development
dependencies. The application runtime still has one zero-transitive-dependency framework package,
and Clank includes only compiled CSS in the deployment artifact. The platform does not run
`npm install` or any remote build hook.

This follows Tailwind's official [CLI installation](https://tailwindcss.com/docs/installation/tailwind-cli)
model. Versions are intentionally declared in the generated `package.json` so dependency updates
remain visible and reviewable.

## Standalone CLI without project packages

Tailwind also publishes a standalone executable. Set its path for the same Clank build:

```sh
CLANK_TAILWIND_EXECUTABLE=./tailwindcss \
  clank build src dist --tailwind=src/styles.css
```

The configured value is executed directly without a shell. If neither a local CLI module nor the
configured standalone executable exists, the build fails before deployment instead of shipping an
uncompiled stylesheet.

## Static class discovery

Keep complete class tokens in source:

```ts
// Good: both complete tokens are discoverable.
const tone = danger ? "bg-red-600" : "bg-emerald-600";

// Avoid: a static scanner cannot infer every interpolated result.
const tone = `bg-${color}-600`;
```

Reactive `classList` keys are also static strings and are discoverable. If a class truly comes from
external data, map the allowed values to complete class names or configure Tailwind's source
mechanism explicitly.

## Development-only browser examples

Some standalone HTML examples in this repository still use Tailwind's browser build so they can be
opened without installing anything. Tailwind documents that path for development only. Generated
apps, blueprint output, preview deploys, and production releases all use the compiled pipeline
above.

## Why there is no Clank Tailwind plugin

Tailwind needs source files containing class strings and an HTML document linking its generated
stylesheet. Clank supplies both without transforming `class` or `classList`. The `--tailwind`
compiler option is orchestration—not a CSS reimplementation—so Tailwind behavior stays standard
and its output remains inspectable.
