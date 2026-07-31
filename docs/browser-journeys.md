# Semantic browser journeys

Clank journeys let a person or agent describe acceptance behavior as bounded data, then replay it
in a real Chrome browser. They address controls by stable `agentId` or native `id`, so tests follow
the same semantic surface an agent sees instead of depending on CSS classes, DOM nesting, pixels,
or a separate browser package.

Generated blueprint applications include `journeys/smoke.json` and a `test:journey` script. Start
the application in one terminal and replay the journey in another:

```sh
npm run dev
npm run test:journey
```

The CLI defaults to `http://127.0.0.1:3000`, launches installed Chrome or Chromium with a fresh
temporary profile, keeps the browser sandbox enabled, and deletes the profile when the run ends.
It returns nonzero when a step, page exception, navigation boundary, or timeout fails.

## A complete journey

```json
{
  "name": "Create a task",
  "start": "/",
  "viewport": { "width": 390, "height": 844 },
  "steps": [
    { "input": { "target": "login-email", "value": "agent@example.invalid" } },
    { "input": { "target": "login-password", "value": { "env": "CLANK_TEST_PASSWORD" } } },
    { "activate": "login-submit" },
    { "wait": { "url": "/tasks", "text": "My tasks", "timeoutMs": 10000 } },
    { "input": { "target": "task-title", "value": "Review launch plan" } },
    { "activate": "task-add" },
    { "wait": { "target": "task-review-launch-plan", "text": "Review launch plan" } },
    { "expect": { "target": "task-review-launch-plan", "state": { "checked": false } } },
    { "inspect": "final task surface" }
  ]
}
```

Set the login secret only for the process that runs the journey:

```sh
CLANK_TEST_PASSWORD='test-account-password' clank journey journeys/create-task.json
```

An `{ "env": "NAME" }` value is resolved at execution time. The raw value is never copied into
the normalized journey, step output, failure report, screenshot name, or semantic inspection.
Password controls reject literal values in the real-browser driver. Use a disposable seeded test
account; never automate a production account or commit credentials.

## Operations

| Operation | Contract | Purpose |
| --- | --- | --- |
| `visit` | relative path | Navigate without leaving the configured application origin. |
| `input` | `{ target, value }` | Enter text, numbers, booleans, selections, or a secret reference. |
| `activate` | stable ID | Click an enabled semantic control. |
| `expect` | expectation | Check immediately. |
| `wait` | expectation plus optional `timeoutMs` | Poll through hydration, navigation, and live updates. |
| `inspect` | bounded label | Attach a value-redacted semantic surface snapshot to the report. |

Expectations can combine visible `text`, a relative `url`, a semantic `target`, and target `state`.
Supported state is `label`, `role`, `checked`, `expanded`, `disabled`, `readonly`, `invalid`, or
`value`. Prefer role and behavioral state; assert visible copy only when the wording is itself part
of the product contract.

Journey definitions allow at most 100 steps. Suites allow at most 50 journeys and source files
are limited to 1 MiB. Navigation is same-origin, waits and complete runs are bounded, URL query
strings are omitted from summary reports, inspected control values are removed, and unexpected
page exceptions fail the run.

## CLI and CI

```sh
clank journey journeys/smoke.json --url=http://127.0.0.1:4100
clank journey journeys/acceptance.json --headed
clank journey journeys/acceptance.json --output=.clank/journey-report.json --json
clank journey journeys/acceptance.json --browser=/path/to/chrome
clank journey journeys/acceptance.json --cdp=http://127.0.0.1:9222
```

`--cdp` accepts only an HTTP loopback endpoint and rejects redirected or network WebSocket targets;
it cannot attach to a network browser. `--output` writes an owner-only JSON report atomically and
adds an owner-only PNG on failure when the run did not resolve secrets. Secret-bearing runs omit
screenshots so an application cannot accidentally render a credential into an artifact. JSON output uses
the stable `clank-journey-suite/1` envelope around `clank-journey-report/1` reports, making the
result suitable for agents and CI annotations.

JSON is the safe format for agent proposals. `.js` and `.mjs` files are supported for trusted
local composition, but they execute as ordinary local code and are not a sandbox.

## Authoring semantic controls

```tsx
<input
  agentId="task-title"
  agentLabel="Task title"
  bind:value={title}
/>
<button
  agentId="task-add"
  agentLabel="Add task"
  agentAction={api.todos.add}
  onClick={addTodo}
>
  Add
</button>
```

Use durable product-language IDs, not generated row positions. Server-backed controls should also
use the typed backend function reference in `agentAction`; generated contract tests then verify
that the UI, browser journey surface, and per-app MCP tools describe the same operation.

## Programmatic driver contract

```ts
import { createDomJourneyDriver, defineJourney, runJourney } from "@clank.run/framework/journey";
import { createAgentSurface } from "@clank.run/framework/ai";

const journey = defineJourney({
  name: "Settings open",
  steps: [
    { activate: "settings-open" },
    { wait: { url: "/settings" } }
  ]
});

const report = await runJourney(
  journey,
  createDomJourneyDriver(window, createAgentSurface(document)),
  { baseUrl: window.location.origin }
);
```

`runJourney` is driver-neutral for deterministic unit tests. `createDomJourneyDriver` adapts an
existing application window; the CLI's driver uses Chrome DevTools directly and remains
dependency-free.
