# Tailwind CSS

Clank preserves class strings exactly and keeps styling outside its reactive kernel. Tailwind scans ordinary TSX such as:

```tsx
<button
  class="rounded-full bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500"
  classList={{ "opacity-50": disabled.value }}
>
  Save
</button>
```

## Zero-install development

The example uses Tailwind v4's browser build:

```html
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style type="text/tailwindcss">
  @theme { --color-brand: #ff6b4a; }
  body { @apply bg-slate-50 text-slate-900; }
</style>
```

Tailwind documents the Play CDN as a development-only option. It is ideal for this zero-install demo, but production should serve compiled CSS. See the official [Play CDN guide](https://tailwindcss.com/docs/installation/play-cdn).

When using the browser build with a Content Security Policy, allow the exact CDN script origin and the development-time style injection it performs. The authenticated example uses a per-response script nonce and limits the exception to `style-src 'unsafe-inline'`. Compiled production CSS can remove both CDN access and that style exception.

## Production without project packages

Use Tailwind's standalone CLI executable, then create:

```css
/* src/styles.css */
@import "tailwindcss";
```

Compile it to a static file with the standalone binary for your platform:

```sh
./tailwindcss -i ./src/styles.css -o ./public/styles.css --watch
```

Then link `/styles.css` from HTML. The official [Tailwind CLI guide](https://tailwindcss.com/docs/installation/tailwind-cli) notes that a standalone executable is available for users who do not want a Node package install.

## Static class discovery

Keep complete class tokens in source:

```ts
// Good: both complete tokens are discoverable.
const tone = danger ? "bg-red-600" : "bg-emerald-600";

// Avoid: a static scanner cannot infer every interpolated result.
const tone = `bg-${color}-600`;
```

Reactive `classList` keys are also static strings and are discoverable. If a class truly comes from external data, map the allowed values to complete class names or configure the Tailwind source/safelist mechanism.

## Why there is no Clank plugin

Tailwind needs source files containing class strings and an HTML file containing its generated stylesheet. Clank supplies both without transforming the class attribute, so an adapter would add dependency and indirection without adding capability.
