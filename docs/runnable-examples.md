# Runnable documentation examples

`npm run docs:examples` compiles and executes every explicitly marked `clank-run` code fence under `docs/`. The full local check runs the same gate against the built package. Each example starts a fresh Node process in a temporary directory, with a ten-second timeout and bounded output. This is a verification runner for trusted repository documentation, not a sandbox for third-party code.

Use a unique lowercase ID within each guide and import public package entry points. Assertions make the expected behavior executable. Ordinary illustrative snippets without the marker are not executed.

## Schema validation

```ts clank-run=schema-validation
import assert from "node:assert/strict";
import { s } from "@clank.run/framework";
const name = s.string({ min: 1, max: 20 });
assert.equal(name.parse("Ada"), "Ada");
assert.equal(name.safeParse(42).success, false);
```

## Reactive state

```ts clank-run=reactive-state
import assert from "node:assert/strict";
import { signal, computed } from "@clank.run/framework";
const count = signal(2);
const doubled = computed(() => count.value * 2);
assert.equal(doubled.value, 4);
count.value = 3;
assert.equal(doubled.value, 6);
```

## Atomic database changes

```ts clank-run=atomic-database
import assert from "node:assert/strict";
import { defineDatabase, defineTable, openSQLite, s } from "@clank.run/framework";
const schema = defineDatabase({ notes: defineTable({ title: s.string() }) });
const db = await openSQLite(schema, { path: ":memory:" });
try {
  assert.throws(() => db.transaction(tx => { tx.table("notes").insert({ title: "Uncommitted" }); throw new Error("abort"); }));
  assert.equal(db.read(tx => tx.table("notes").collect()).length, 0);
} finally { db.close(); }
```

## Localized values

```ts clank-run=localized-values
import assert from "node:assert/strict";
import { createI18n, defineMessages } from "@clank.run/framework/i18n";
const i18n = createI18n({ defaultLocale: "en", messages: defineMessages({ greeting: "Hello, {name}" }) });
assert.equal(i18n.t("greeting", { name: "Ada" }), "Hello, Ada");
```

## Calendar recurrence

```ts clank-run=calendar-recurrence
import assert from "node:assert/strict";
import { previewSchedule } from "@clank.run/framework/schedules";
const schedule = previewSchedule({ frequency: "daily", startDate: "2026-03-07", time: "02:30", timeZone: "America/New_York" }, { after: Date.parse("2026-03-07T00:00:00Z"), limit: 2 });
assert.equal(schedule.occurrences[1].local, "2026-03-09T02:30");
assert.equal(schedule.skipped[0].reason, "daylight-saving-gap");
```

## Delivery controls

```ts clank-run=quiet-hours
import assert from "node:assert/strict";
import { nextNotificationDelivery } from "@clank.run/framework/notifications";
const at = nextNotificationDelivery({ timeZone: "UTC", quietHours: { start: "22:00", end: "08:00" } }, Date.parse("2026-10-03T23:00:00Z"));
assert.equal(new Date(at).toISOString(), "2026-10-04T08:00:00.000Z");
```

## Compiler contract

```ts clank-run=compiler-contract
import assert from "node:assert/strict";
import { compile } from "@clank.run/framework/compiler";
const code = compile("export const answer: number = 42;", { filename: "answer.ts", sourceMap: false });
const result = await import(`data:text/javascript,${encodeURIComponent(code)}`);
assert.equal(result.answer, 42);
```
