# Design system and component workshop

Clank Design Studio at [design.clank.run](https://design.clank.run) is the canonical interactive
workshop for the framework's dependency-free headless UI. It renders all 39 component families
with their real Clank controllers, lets you compare ten complete themes, and exposes the same
contracts to people and agents through HTML, JSON, and MCP.

The studio is itself a Clank application. It is server rendered, hydrated in place, responsive,
deployed through the Clank control plane, and has no package dependencies. That makes it both a
reference and a continuously exercised integration test for the framework.

## Open the workshop

- [Component overview](https://design.clank.run)
- [Theme laboratory](https://design.clank.run/themes)
- Component specimens use `https://design.clank.run/components/<slug>`.
- The structured component catalog is [design.clank.run/api/catalog.json](https://design.clank.run/api/catalog.json).
- The structured theme catalog is [design.clank.run/api/themes.json](https://design.clank.run/api/themes.json).
- Agent discovery begins at [design.clank.run/.well-known/clank](https://design.clank.run/.well-known/clank).

Each component page includes a live specimen, responsive preview widths, optional grid and anatomy
outlines, the canonical semantic parts, a focused package import, upstream anatomy reference, and
the factory metadata an agent needs to generate the component correctly.

The Theme laboratory includes a searchable token inspector, a foreground/background contrast
calculator, CSS and JSON export, a two-theme comparison, and a sandbox for validated token
overrides. The sandbox previews changes locally without changing the built-in presets. Contrast
results describe the selected colors and text thresholds; they do not certify an entire interface.

Component previews support custom bounded widths, shareable settings, catalog filters, keyboard
interaction guidance, and a reset control that restores the specimen's initial state while retaining
preview settings and the share URL. Settings are validated when read from a shared URL. Exported themes use the existing theme
contract and can be reviewed before being copied or downloaded.

Use the inspector's arrow keys, Home, and End to move between its tabs. Usage examples can be
copied directly; a browser that denies clipboard access offers selected text for manual copying.
Favorite components provide local shortcuts and synchronize between tabs when browser storage is
available. Search the theme gallery by name, description, or tag, and filter by light or dark scheme.
The sandbox can also copy or download its applied overrides as CSS scoped to `[data-clank-sandbox]`.

## Theme package

Import the visual token layer separately from the unstyled controllers:

```ts
import {
  CLANK_THEME_PRESETS,
  applyClankTheme,
  createClankThemeStylesheet,
  defineClankTheme,
} from "@clank.run/framework/ui/theme";
```

`CLANK_THEME_PRESETS` contains ten immutable themes:

| Theme | Scheme | Character |
| --- | --- | --- |
| Clank | Dark | High-contrast workshop with electric green. |
| Porcelain | Light | Precise blue product UI with crisp geometry. |
| Midnight | Dark | Deep navy observability surfaces and cyan signals. |
| Sakura | Light | Editorial pink and plum with generous curves. |
| Terminal | Dark | Dense monospace controls, square edges, and zero motion. |
| Tangerine | Light | Warm commerce surfaces with saturated orange. |
| Nordic | Light | Cool paper whites, teal, and restrained density. |
| Grape | Dark | Aubergine panels and dramatic ultraviolet curves. |
| Sandstone | Light | Architectural neutrals, rust, and hairline geometry. |
| Candy | Light | Playful pink and violet with large friendly controls. |

Every preset implements the same 32-token `clank-theme/1` contract. Tokens cover canvas and
surface colors, text hierarchy, borders, accent and danger states, focus, overlay, four radius
levels, full rounding, three shadows, sans and mono fonts, control height, density, border width,
and motion timing.

## Apply a preset

Generate a static stylesheet during your build, then select a theme through a data attribute:

```ts
import {
  CLANK_THEME_PRESETS,
  createClankThemeStylesheet,
} from "@clank.run/framework/ui/theme";

const css = createClankThemeStylesheet(CLANK_THEME_PRESETS);
// Write `css` to an application-owned stylesheet during the build.
```

```html
<html data-clank-theme="midnight">
```

For a browser-controlled picker, `applyClankTheme(element, theme)` applies the exact CSS custom
properties and color scheme to an element and returns a cleanup function. It never injects remote
CSS, runs code from a theme, or requires a styling runtime.

```ts
import {
  applyClankTheme,
  getClankTheme,
} from "@clank.run/framework/ui/theme";

const midnight = getClankTheme("midnight");
if (!midnight) throw new Error("The built-in Midnight theme is missing.");
const restore = applyClankTheme(document.documentElement, midnight);

// Later, restore the element's previous values.
restore();
```

The component library remains headless. Presets only provide variables; your CSS or Tailwind
classes decide which variables each visual part consumes.

## Shared visual foundation

The documentation site, control plane, and Design Studio use the same Clank preset from
`@clank.run/framework/ui/theme`. Generate theme CSS from the preset rather than copying palette
values into an application. Use `text`, `textMuted`, and `textFaint` for readable text, and pair
`accent` or `accentHover` fills with `accentContrast`.

All ten built-in presets maintain at least 4.5:1 contrast for these text roles on the five standard
surfaces and for labels on filled accent and danger controls. Custom themes should verify their
own combinations, including hover states. Component controllers remain unstyled.

The workshop includes a live overview dialog, mobile component search, theme selection, viewport
controls, and optional grid and anatomy outlines. Keyboard users can operate the examples and
scroll documentation code blocks and tables without a pointer.

## Define a custom theme

Start with all required tokens and validate the object with `defineClankTheme()`. The function
rejects missing tokens, unknown tokens, unsafe CSS values, invalid identifiers, and unbounded
metadata, then deeply freezes the result.

```ts
import {
  CLANK_THEME_PRESETS,
  defineClankTheme,
} from "@clank.run/framework/ui/theme";

const base = CLANK_THEME_PRESETS[0];

export const ocean = defineClankTheme({
  id: "ocean",
  name: "Ocean",
  description: "A calm blue product theme.",
  scheme: "dark",
  tags: ["dark", "blue"],
  tokens: {
    ...base.tokens,
    canvas: "#06111c",
    surface: "#0b2033",
    accent: "#62d9ff",
    accentHover: "#8ce5ff",
    accentContrast: "#03141c",
    focus: "#8ce5ff",
  },
});
```

Keeping the complete token record explicit is deliberate: humans and agents can review the whole
theme, generated output cannot silently inherit a changing global default, and CSS generation is
deterministic.

## Use the Design Studio MCP server

The workshop exposes a public, read-only Streamable HTTP MCP endpoint:

```json
{
  "mcpServers": {
    "clank-design": {
      "type": "http",
      "url": "https://design.clank.run/__clank/mcp"
    }
  }
}
```

It does not require a Clank account because it only serves public framework metadata. Available
tools are:

- `design.components` — list all component families, optionally by module.
- `design.component` — read one factory, package subpath, parts, and specimen URL.
- `design.themes` — list the ten preset themes.
- `design.theme` — read one complete typed token map.

Application MCP servers remain separate and authenticated. The Design Studio describes framework
UI contracts; a deployed application's own MCP endpoint describes that application's queries and
mutations.

## Build and verify locally

Framework contributors can build the studio without installing anything:

```bash
npm run build:design
node design-site/dist/server.js
```

Then open `http://127.0.0.1:4400` for local development only. Production documentation and agent
configuration should always use `https://design.clank.run`.

The root `npm test` and `npm run check` commands build the studio, verify all 39 SSR routes, inspect
its security headers and immutable assets, exercise both JSON catalogs, and connect to its MCP
server. A successful main CI revision can deploy the fixed Design Studio project without changing
the public domain.
