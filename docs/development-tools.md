# Development updates and editor integration

`clank dev` still health-checks each replacement server before switching traffic. CSS-only source changes replace same-origin stylesheet links in place, keeping the document and reactive state alive. Changes to application code restart the server and reload the page. Failed builds keep the last healthy server.

To preserve a selected piece of client state during those reloads, register an explicit JSON snapshot:

```ts
import { signal, preserveDevelopmentState } from "@clank.run/framework";
const selectedTab = signal("overview");
const cleanup = preserveDevelopmentState("dashboard.tab", {
  snapshot: () => selectedTab.value,
  restore: value => { selectedTab.value = value; },
});
// Call cleanup when this component is disposed.
```

State uses a page-specific session-storage slot, expires after 30 seconds, and is consumed once. The whole snapshot is limited to 64 KiB, 100 registrations, and 200 form controls. Store only UI state; never register credentials or sensitive records. In production this API registers callbacks but no development client captures or persists them.

An input, textarea, or select with both a stable `id` and `data-dev-preserve` can retain its draft, checked state, focus, and selection. Password, file, hidden, payment, one-time-code, and autocomplete-off controls are excluded. Restoring controls does not fire change events or submit forms. Register actual signal state when the application needs a reactive value restored. Scroll position is also restored. Incompatible or oversized snapshots fall back to a normal reload.

This is selective CSS replacement and opt-in state recovery, not arbitrary JavaScript module replacement. Removing a state key or changing its shape should be accompanied by changing that key. Adapters validate restored values as appropriate for their application.

## Language Server Protocol

Run `clank editor /absolute/project/path` as a stdio language server. Connect it through your editor's LSP client for TypeScript and TSX files. For example, an LSP command configuration can use:

```json
{
  "command": "node",
  "args": ["/absolute/project/node_modules/@clank.run/framework/scripts/clank.mjs", "editor", "/absolute/project"],
  "filetypes": ["typescript", "typescriptreact"]
}
```

The server implements initialization, full-document synchronization, live compiler/TSX diagnostics, framework API completions, hover descriptions, close, and shutdown. It reads the installed package's declarations and analyzes only open documents within the configured root. It does not execute project code or load project plugins. Stale document versions are ignored; documents are limited to 1 MiB and messages to 4 MiB. Keep your existing TypeScript language server for semantic type checking, refactors, and dependency analysis.

Node 22.16 and 24 support transform-only TypeScript syntax. Node 26 compiles erasable TypeScript using its native stripping API. Explicit constructor fields and assignments, objects instead of enums, and ES modules instead of runtime namespaces work on every supported version. Node 26 source maps preserve line positions in the lowered TSX module.

Rollback: remove `preserveDevelopmentState` registrations and `data-dev-preserve` attributes, or use `clank dev --no-reload`. Stop the LSP process to disable editor integration. No database migration is involved.

## Semantic type-contract verification

The runtime package still has no npm dependencies. CI provisions an external, pinned TypeScript
5.9.3 compiler and `@types/node` 26.6.4 in a temporary tools directory. To use a separately
provisioned trusted copy locally, build first, then run:

```sh
node scripts/type-contracts.mjs --typescript /trusted/typescript/lib/typescript.js --type-roots /trusted/node_modules/@types
```

The source check uses the normal strict `tsconfig.json`. Its normalized baseline records the
290 diagnostics present at main commit `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`. Any new
file/code/message occurrence fails, including additional occurrences of an existing error.
Line movements do not create new errors. Decreasing debt passes without expanding the baseline;
remove resolved entries during a reviewed cleanup. Never regenerate the baseline from a failing
change to hide its diagnostics. The check reports the actual remaining count.

The second check packs the built framework, installs that exact tarball in a clean temporary
consumer without lifecycle scripts, and compiles every positive/negative consumer fixture with
`skipLibCheck: false`. This checks actual published declarations and ensures `@ts-expect-error`
assertions remain meaningful. Temporary consumers are removed even after failure. The full
runtime/release gate remains `npm run check`; semantic verification is a separate required CI job.
