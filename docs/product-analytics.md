# Privacy-first product analytics

Clank includes typed product analytics in `@clank.run/framework/analytics`. Events live in the
application's own isolated SQLite database, use the application's existing backup and deployment
boundary, and require no analytics service or npm dependency. Definitions are data-first so a
human, an agent, and the runtime all see the same event, dimension, measure, retention, sampling,
and funnel contract.

Analytics is deliberately not a raw event warehouse. Consent is required for every write, raw
identities are HMAC-pseudonymized before storage, raw events cannot be read through the public API,
small cohorts are hidden, dimensions have finite cardinality, retention is bounded, and each app
has a hard event capacity. This gives an agent useful product signals without quietly creating a
second customer-data system.

## Define the product contract

Use namespaced event names and explain why each event exists. String properties must be finite
enums. Numeric properties require explicit minimum and maximum values. Only configured enum,
boolean, or literal properties can become dimensions; only configured bounded numbers can become
measures.

```ts
import { defineAnalytics, s } from "@clank.run/framework";

export const productAnalytics = defineAnalytics({
  events: {
    "todo.created": {
      description: "A signed-in user creates a to-do.",
      properties: {
        source: s.enum(["toolbar", "shortcut"]),
        latency_ms: s.number({ min: 0, max: 10_000 }),
      },
      dimensions: ["source"],
      measures: ["latency_ms"],
      retentionDays: 30,
    },
    "todo.completed": {
      description: "A signed-in user completes a to-do.",
      properties: { surface: s.enum(["board", "list"]) },
      dimensions: ["surface"],
      retentionDays: 30,
    },
  },
  funnels: {
    activation: {
      description: "Creation followed by a completed to-do.",
      steps: ["todo.created", "todo.completed"],
      withinMs: 7 * 24 * 60 * 60 * 1_000,
    },
  },
});
```

The runtime rejects fields that look identity-bearing or sensitive, including IDs, names, email,
phone, addresses, credentials, tokens, free-form content, searches, URLs, and IP or user-agent
data. It also rejects open strings, unbounded numbers, unknown properties, duplicate dimensions,
unknown funnel steps, and funnels whose events have different sampling rates. Keep business data
in normal typed tables; analytics properties should describe aggregate product state.

## Open it beside the app database

Open analytics once during server startup. Use a deployment secret of at least 32 bytes; never put
it in source or send it to a browser. Changing this secret changes pseudonyms, so use the same
secret for the lifetime of a production dataset.

```ts
import { openAnalytics } from "@clank.run/framework/analytics";
import { database } from "./database.ts";
import { productAnalytics } from "./product-analytics.ts";

export const analytics = await openAnalytics(productAnalytics, database, {
  identitySecret: process.env.CLANK_ANALYTICS_SECRET!,
  minimumCohortSize: 3,
  maxStoredEvents: 1_000_000,
});
```

`openAnalytics` creates reserved internal tables in that app database. Those tables cannot collide
with application tables, do not enter live-query document revisions, and remain inside the same
per-project SQL and backup boundary. Expired rows are deleted during writes or by `purge()`. The
defaults are 30 days per event, at most 400 days, one million stored events, 100,000 rows per funnel
scan, and a three-subject minimum cohort. Every limit can only be adjusted inside its documented
hard bound.

## Record from authoritative server actions

Call `track` after the associated application mutation succeeds. Resolve the subject from server
authentication—never accept a user ID supplied by the browser. The user or workspace's explicit
analytics preference determines `consent`; pass browser or account do-not-track state as well.

```ts
const todoId = context.db.table("todos").insert(args);

analytics.track("todo.created", {
  source: args.source,
  latency_ms: Math.min(10_000, performance.now() - startedAt),
}, {
  consent: context.user.profile.analyticsConsent ? "granted" : "denied",
  subject: context.user.id,
  sessionId: context.auth.session.id,
  idempotencyKey: `todo-created:${todoId}`,
});
```

Tracking returns `{ stored: true }` or a non-throwing reason: `consent`, `do_not_track`, `sampled`,
`duplicate`, or `capacity`. Schema errors still throw because they are programming mistakes.
Occurrences supplied by a browser must be within 24 hours of server time. Idempotency keys,
subjects, anonymous IDs, and session IDs are stored only as domain-separated keyed digests.

For optional interaction telemetry, `createAnalyticsClient` provides a typed, memory-only queue.
It validates before enqueueing, caps memory, batches at 25 events, honors consent and DNT both when
queued and when sent, and discards queued events when consent is withdrawn. Its `send` callback is
application-owned: post through a same-origin, rate-limited backend mutation and resolve identity
again on the server with `analytics.ingest`. The client event contains no subject identity and is
never persisted in local storage.

## Read aggregate product signals

`query` returns time buckets, an optional dimension breakdown, and an optional measure average.
Counts and averages become `null` when fewer than `minimumCohortSize` distinct pseudonymous
subjects contributed. A dimension's hidden event count is returned only as `withheld`; its value is
not disclosed. Empty time buckets safely return zero.

```ts
const usage = analytics.query({
  event: "todo.created",
  from: Date.now() - 30 * 24 * 60 * 60 * 1_000,
  to: Date.now(),
  interval: "day",
  dimension: "source",
  measure: "latency_ms",
});

const activation = analytics.funnel("activation", {
  from: Date.now() - 30 * 24 * 60 * 60 * 1_000,
  to: Date.now(),
});
```

Queries cannot span more than 400 days or 400 time buckets. Funnels scan a bounded row count,
count each pseudonymous subject once per reached step, enforce the declared step order and time
window, and suppress small stages. Results report the stored sample rate and never extrapolate it.
Expose only the particular aggregate queries an application's roles should access; having an MCP
token does not automatically grant analytics access.

## Agent discovery and privacy operations

`analytics.manifest` is immutable `clank-analytics/1` data. It describes every event JSON schema,
dimension, measure, retention period, sample rate, funnel, and privacy rule. An app can return that
manifest from an agent-readable query, and expose curated aggregate queries through normal Clank
backend actions. This keeps the app's MCP server synchronized with the exact analytics contract.

Use `analytics.forgetSubject({ subject: user.id })` when an authenticated account requests
erasure. Anonymous installations can erase with the original first-party `anonymousId`. The
method derives the same pseudonym and deletes all matching events without ever scanning for or
storing the raw identity. `diagnostics()` returns only total event count and oldest/newest
timestamps; it never returns subjects, sessions, properties, event names, or secret material.

## Operational notes

- Generate `CLANK_ANALYTICS_SECRET` independently from auth, OAuth, encryption, and CSRF secrets.
- Treat the consent decision as application data and audit preference changes in the normal app.
- Rate-limit browser ingestion. The storage ceiling is a last boundary, not a rate limiter.
- Schedule `purge()` if an app has long periods without writes and requires prompt expiry.
- Funnel conversion is based on stored samples. All events in a funnel must share one sample rate.
- Backups contain pseudonymous analytics rows until their normal backup retention expires. Apply
  account-erasure policy to backups as documented in [Recovery and rollback](./recovery.md).
- Do not expose internal analytics tables through database access, MCP tools, logs, exports, or
  collaboration presence. Use only the aggregate runtime methods.
