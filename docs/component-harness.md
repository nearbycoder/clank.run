# Interactive component specimens

The optional `@clank.run/framework/component-harness` module runs the same typed fixture through
server rendering, hydration and a local interactive browser. Use a dedicated development page
or iframe with disposable data. Each document hosts one active harness; its root must be a
connected element below the document body. Importing the module mounts nothing and starts no
server. It adds no framework dependencies.

A specimen captures schema-validated JSON props, a synchronous instance factory, a UI manifest,
stable semantic part IDs, current-state assertions and full browser journeys. Every render,
reset and selection gets a fresh instance. The renderer owns reactive effects, lifecycle hooks
and portals created inside the factory. Register external resources with `onCleanup` or return
an idempotent `dispose` callback; the harness invokes that callback once per created instance.

## Define and render a fixture

```ts clank-run=component-specimen-ssr
import assert from "node:assert/strict";
import { s } from "@clank.run/framework/ai";
import { h } from "@clank.run/framework/dom";
import { createSwitch } from "@clank.run/framework/ui/controls";
import { defineComponentSpecimen, renderComponentSpecimen, exportComponentAssertions } from "@clank.run/framework/component-harness";

const notifications = defineComponentSpecimen({
  name: "notifications", revision: "switch/1", label: "Notifications switch",
  props: s.object({ enabled: s.boolean() }), value: { enabled: false },
  parts: { root: "notifications" },
  assertions: [{ target: "notifications", state: { role: "switch", checked: false } }],
  journeys: [390, 1280].map(width => ({
    name: `Switch keyboard ${width}`, start: "/specimens/notifications",
    viewport: { width, height: 844 },
    steps: [
      { wait: { target: "notifications", state: { checked: false } } },
      { focus: "notifications" }, { press: "Enter" },
      { expect: { target: "notifications", state: { checked: true }, focused: "notifications", noHorizontalOverflow: true } },
      { press: "Space" }, { expect: { target: "notifications", state: { checked: false } } }
    ]
  })),
  create(props) {
    const control = createSwitch({ id: "notifications", defaultChecked: props.enabled });
    return {
      view: h("button", control.root({ nativeButton: true, agentLabel: "Notifications" }), "Notifications"),
      manifest: () => control.manifest(), dispose() {}
    };
  }
});
const rendered = await renderComponentSpecimen(notifications);
assert.match(rendered.html, /aria-checked="false"/);
assert.equal(rendered.snapshot.protocol, "clank-component-snapshot/1");
assert.equal(exportComponentAssertions(notifications), exportComponentAssertions(notifications));
```

Share the exported specimen definition between your SSR route and browser entry. Embed
`rendered.html` in the dedicated root and serialize `rendered.snapshot` with `serializeState`
from the SSR module; do not interpolate JSON into a script without escaping it. Serve browser
modules through your ordinary development build. The factory is trusted developer code, not a
JavaScript sandbox. Keep the fixture route local or behind your development authentication and
never point destructive journeys at production data.

## Hydrate and interact

```ts
import { readState } from "@clank.run/framework/ssr";
import { hydrateComponentSpecimen, mountComponentHarnessControls } from "@clank.run/framework/component-harness";
import { notifications } from "./specimens.js";

const root = document.getElementById("specimen")!;
const harness = await hydrateComponentSpecimen(root, notifications, readState().snapshot);
const cleanup = mountComponentHarnessControls(document.getElementById("tools")!, harness, [notifications]);
addEventListener("pagehide", cleanup, { once: true });
```

The controls provide selection, reset, current assertions, assertion export and disposal.
Current assertions read the mounted semantic surface and declared part roles. Required manifest
parts must have unique mappings; a conditional popup may be absent until a journey opens it.
Declare assertions for those mounted states in the journey. A current assertion expecting the
initial unchecked state will correctly fail after the person checks the switch; reset restores
its captured starting state.

`mountComponentSpecimen(root, specimen)` starts without SSR. `harness.snapshot()` returns its
phase, generation, instance creation/disposal counts, normalized common UI contract and bounded
structural hydration diagnostics. Counts record disposal callback invocations; external resource
cleanup remains the fixture's responsibility. Snapshots exclude DOM nodes and rendered values.
Text corrections preserve SSR nodes. Structural mismatches use the renderer's normal remount
fallback and release the abandoned instance. The `hydrated` phase identifies the hydration
entry path; inspect diagnostics to distinguish a remount.

The SSR fingerprint covers name, revision, captured props, mappings, assertions and journeys.
Change the revision when changing factory behavior. Fingerprint or instance-contract mismatches
fail before accepting attachment. An optional `AbortSignal` cancels pending fingerprint validation
before the factory runs. Moving or detaching the root during validation fails before factory execution and releases its
original document reservation. Cancelled work cannot clear a newer mount. Reset, selection and disposal
invalidate in-flight checks; a stale check returns `null`. The controls fence late status updates.
Use the controls' returned cleanup when the host closes or removes the panel; it removes the
panel and disposes the harness. Direct harness disposal does not remove a separately mounted
controls panel.

## Replay native keyboard and focus behavior

Save `exportComponentAssertions(specimen)` or the controls' read-only JSON to a local file, then
run it against the disposable fixture route:

```sh
clank journey journeys/notifications.json --url=http://127.0.0.1:4100 --output=.clank/components.json --json
```

The stable `clank-component-assertions/1` envelope contains CLI-compatible `journeys`, semantic
part mappings and current assertions. It excludes props and timing results. The CLI replays the
journeys; current assertions run through the harness's Check button. Use different journey names
for desktop and narrow viewports. Native `focus`, `press`, `focused` and `noHorizontalOverflow`
checks expose real browser focus, Tab order, modal wrapping and responsive overflow. Chrome
receives key input through DevTools and applies its native default behavior. No synthetic DOM
keyboard event is used to claim native keyboard acceptance. The DOM journey adapter reports
focus and layout but deliberately has no native `press` capability. See [browser journeys](browser-journeys.md).

## Limits and compatibility

Definitions accept finite plain JSON only: 64 KiB props, 16 KiB mappings, depth 16 and 10,000
visited values. There are at most 64 parts, 64 current assertions, 100 combined current steps,
10 unique journeys and 50 specimen choices. The general serialized definition/export/snapshot
limit and rendered SSR output limit are 256 KiB. HTML is checked after trusted rendering; these
limits do not sandbox arbitrary factory execution. Factories and manifests must return
synchronously; their rejected promises are contained and rejected as invalid contracts. A view
may use the renderer's supported async SSR values.

The harness retains at most 1,000 hydration entries and marks truncated capture. It reserves one
active document to isolate portal/focus interactions, but does not replace browser-origin or
application authorization boundaries. No database, persistent schema, network protocol or
production route changes are required. Existing journeys and drivers remain compatible because
native focus/key/layout capabilities are optional. Roll back by removing the optional fixture
route and imports; existing framework applications do not load the harness automatically.
