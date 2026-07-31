import test from "node:test";
import assert from "node:assert/strict";

import {
  createAnalyticsClient,
  defineAnalytics,
  defineDatabase,
  defineTable,
  openAnalytics,
  openSQLite,
  s,
} from "../dist/index.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 31, 12);

function definition(options = {}) {
  return defineAnalytics({
    events: {
      "todo.created": {
        description: "A user creates a to-do.",
        properties: {
          source: s.enum(["toolbar", "shortcut"]),
          latency_ms: s.number({ min: 0, max: 10_000 }),
          completed: s.boolean(),
        },
        dimensions: ["source", "completed"],
        measures: ["latency_ms"],
        retentionDays: options.retentionDays ?? 30,
      },
      "todo.completed": {
        description: "A user completes a to-do.",
        properties: { source: s.enum(["board", "list"]) },
        dimensions: ["source"],
      },
    },
    funnels: {
      activation: {
        description: "Creation followed by completion.",
        steps: ["todo.created", "todo.completed"],
        withinMs: DAY,
      },
    },
  });
}

async function runtime(t, options = {}) {
  const database = await openSQLite(defineDatabase({}));
  t.after(() => database.close());
  const analytics = await openAnalytics(options.definition ?? definition(options), database, {
    identitySecret: "a deliberate test-only analytics secret with 32 bytes",
    minimumCohortSize: options.minimumCohortSize ?? 3,
    maxFunnelScanEvents: options.maxFunnelScanEvents,
    maxStoredEvents: options.maxStoredEvents,
    now: options.now ?? (() => NOW),
  });
  return { analytics, database };
}

function created(source = "toolbar", latency = 120) {
  return { source, latency_ms: latency, completed: false };
}

test("analytics definitions are finite, aggregate-safe, immutable, and agent-readable", async (t) => {
  const { analytics } = await runtime(t);

  assert.equal(Object.isFrozen(analytics.definition.events["todo.created"]), true);
  assert.equal(analytics.manifest.protocol, "clank-analytics/1");
  assert.deepEqual(analytics.manifest.events["todo.created"].dimensions, ["source", "completed"]);
  assert.deepEqual(analytics.manifest.funnels.activation.steps, ["todo.created", "todo.completed"]);
  assert.deepEqual(analytics.manifest.privacy, {
    consentRequired: true,
    rawIdentitiesStored: false,
    rawEventsReadable: false,
    minimumCohortSize: 3,
    maximumRetentionDays: 400,
  });

  assert.throws(() => defineAnalytics({ events: {} }), /at least one event/u);
  assert.throws(() => defineAnalytics({
    events: { created: { description: "Missing namespace." } },
  }), /namespaced/u);
  assert.throws(() => defineAnalytics({
    events: {
      "user.opened": { description: "Unsafe.", properties: { email: s.email() } },
    },
  }), /identity-bearing or sensitive/u);
  assert.throws(() => defineAnalytics({
    events: {
      "page.opened": { description: "Unsafe.", properties: { route: s.string({ max: 20 }) } },
    },
  }), /must use s\.enum/u);
  assert.throws(() => defineAnalytics({
    events: {
      "job.finished": { description: "Unsafe.", properties: { duration: s.number() } },
    },
  }), /finite min and max/u);
  assert.throws(() => defineAnalytics({
    events: {
      "todo.created": { description: "Known." },
    },
    funnels: { bad: { description: "Bad.", steps: ["todo.created", "todo.missing"] } },
  }), /unknown event/u);
  assert.throws(() => defineAnalytics({
    events: {
      "todo.created": { description: "One.", sampleRate: 1 },
      "todo.completed": { description: "Two.", sampleRate: 0.5 },
    },
    funnels: { bad: { description: "Biased.", steps: ["todo.created", "todo.completed"] } },
  }), /same sampleRate/u);
  assert.throws(() => defineDatabase({
    analytics_state: defineTable({ value: s.boolean() }),
  }), /reserved/u);
});

test("analytics enforces an atomic per-application storage capacity", async (t) => {
  const { analytics } = await runtime(t, { maxStoredEvents: 1, minimumCohortSize: 1 });
  assert.deepEqual(await analytics.track("todo.created", created(), { consent: "granted", subject: "one" }), { stored: true });
  assert.deepEqual(await analytics.track("todo.created", created(), { consent: "granted", subject: "two" }), {
    stored: false,
    reason: "capacity",
  });
  assert.equal(analytics.diagnostics().storedEvents, 1);
});

test("analytics tracking requires consent, honors DNT, validates data, pseudonymizes identity, and deduplicates", async (t) => {
  const { analytics, database } = await runtime(t);
  const context = { consent: "granted", subject: "raw-user-123", sessionId: "raw-session-456" };

  assert.deepEqual(await analytics.track("todo.created", created(), { ...context, consent: "unknown" }), {
    stored: false,
    reason: "consent",
  });
  assert.deepEqual(await analytics.track("todo.created", created(), { ...context, doNotTrack: true }), {
    stored: false,
    reason: "do_not_track",
  });
  assert.deepEqual(await analytics.track("todo.created", created(), { ...context, idempotencyKey: "retry-1" }), { stored: true });
  assert.deepEqual(await analytics.track("todo.created", created(), { ...context, idempotencyKey: "retry-1" }), {
    stored: false,
    reason: "duplicate",
  });
  assert.throws(() => analytics.track("todo.created", { ...created(), source: "other" }, context), /Expected one of/u);
  assert.throws(() => analytics.track("todo.created", { ...created(), extra: true }, context), /Unknown property/u);
  assert.throws(() => analytics.track("todo.created", created(), { ...context, occurredAt: NOW + DAY + 1 }), /within 24 hours/u);

  const rows = database[SQLITE_INTERNAL].prepare("SELECT * FROM clank_analytics_events").all();
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /raw-user-123|raw-session-456|retry-1/u);
  assert.match(String(rows[0].subject_key), /^[A-Za-z0-9_-]{43}$/u);
  assert.match(String(rows[0].session_key), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(analytics.diagnostics().storedEvents, 1);
});

test("analytics events join an active application transaction and roll back atomically", async (t) => {
  const schema = defineDatabase({ todos: defineTable({ title: s.string({ min: 1, max: 100 }) }) });
  const database = await openSQLite(schema);
  t.after(() => database.close());
  const analytics = await openAnalytics(definition(), database, {
    identitySecret: "a deliberate test-only analytics secret with 32 bytes",
    minimumCohortSize: 1,
    now: () => NOW,
  });

  assert.throws(() => database.transaction((db) => {
    db.table("todos").insert({ title: "rolled back" });
    analytics.track("todo.created", created(), { consent: "granted", subject: "one" });
    throw new Error("abort both");
  }), /abort both/u);
  assert.equal(database.read((db) => db.table("todos").collect().length), 0);
  assert.equal(analytics.diagnostics().storedEvents, 0);

  database.transaction((db) => {
    db.table("todos").insert({ title: "committed" });
    analytics.track("todo.created", created(), { consent: "granted", subject: "one" });
  });
  assert.equal(database.read((db) => db.table("todos").collect().length), 1);
  assert.equal(analytics.diagnostics().storedEvents, 1);
});

test("analytics queries expose bounded aggregates, cohort privacy, measures, and ordered funnels", async (t) => {
  const { analytics } = await runtime(t);
  const people = [
    ["one", "toolbar", 100],
    ["two", "toolbar", 200],
    ["three", "toolbar", 300],
    ["four", "shortcut", 400],
  ];
  for (const [subject, source, latency] of people) {
    await analytics.track("todo.created", created(source, latency), {
      consent: "granted",
      subject,
      occurredAt: NOW - 1_000,
    });
  }
  for (const subject of ["one", "two", "three"]) {
    await analytics.track("todo.completed", { source: "board" }, {
      consent: "granted",
      subject,
      occurredAt: NOW,
    });
  }

  const query = analytics.query({
    event: "todo.created",
    from: NOW - DAY,
    to: NOW + 1,
    interval: "day",
    dimension: "source",
    measure: "latency_ms",
  });
  assert.equal(query.total, 4);
  assert.equal(query.average, 250);
  assert.deepEqual(query.breakdown, [{ value: "toolbar", count: 3, average: 200 }]);
  assert.equal(query.withheld, 1);
  assert.deepEqual(query.series.map((entry) => entry.count), [4, 0]);

  const privateQuery = analytics.query({
    event: "todo.completed",
    from: NOW - DAY,
    to: NOW + 1,
    dimension: "source",
  });
  assert.equal(privateQuery.total, 3);
  assert.equal(privateQuery.breakdown[0].count, 3);

  const funnel = analytics.funnel("activation", { from: NOW - DAY, to: NOW + 1 });
  assert.deepEqual(funnel.steps, [
    { event: "todo.created", subjects: 4, conversionFromFirst: 1 },
    { event: "todo.completed", subjects: 3, conversionFromFirst: 0.75 },
  ]);
  assert.equal(funnel.scannedEvents, 7);
  assert.deepEqual(funnel.sampleRates, { "todo.created": 1, "todo.completed": 1 });

  assert.throws(() => analytics.query({ event: "todo.created", from: NOW - DAY, to: NOW, dimension: "latency_ms" }), /not a configured analytics dimension/u);
  assert.throws(() => analytics.query({ event: "todo.created", from: NOW - 401 * DAY, to: NOW }), /cannot exceed 400 days/u);
});

test("analytics subject erasure and expiry remove every matching pseudonymous event", async (t) => {
  const clock = { now: NOW };
  const { analytics } = await runtime(t, { retentionDays: 1, minimumCohortSize: 1, now: () => clock.now });
  await analytics.track("todo.created", created(), { consent: "granted", subject: "erase-me" });
  await analytics.track("todo.completed", { source: "list" }, { consent: "granted", subject: "erase-me" });
  await analytics.track("todo.created", created(), { consent: "granted", anonymousId: "anonymous" });
  assert.equal(analytics.diagnostics().storedEvents, 3);
  assert.equal(await analytics.forgetSubject({ subject: "erase-me" }), 2);
  assert.equal(analytics.diagnostics().storedEvents, 1);
  clock.now += 31 * DAY;
  assert.equal(analytics.purge(), 1);
  assert.deepEqual(analytics.diagnostics(), { storedEvents: 0, oldestAt: null, newestAt: null });
  assert.throws(() => analytics.forgetSubject({}), /requires subject or anonymousId/u);
});

test("the analytics browser client validates, gates, bounds, and batches memory-only events", async () => {
  const sent = [];
  let consent = false;
  let dnt = false;
  const client = createAnalyticsClient(definition(), {
    consent: () => consent,
    doNotTrack: () => dnt,
    maxQueue: 2,
    flushIntervalMs: 60_000,
    now: () => NOW,
    async send(events) { sent.push([...events]); },
  });

  assert.deepEqual(client.track("todo.created", created()), { queued: false, reason: "consent" });
  consent = true;
  dnt = true;
  assert.deepEqual(client.track("todo.created", created()), { queued: false, reason: "do_not_track" });
  dnt = false;
  assert.deepEqual(client.track("todo.created", created()), { queued: true });
  assert.deepEqual(client.track("todo.completed", { source: "list" }), { queued: true });
  assert.deepEqual(client.track("todo.created", created()), { queued: false, reason: "capacity" });
  assert.equal(client.queued, 2);
  await client.flush();
  assert.equal(client.queued, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((event) => event.name), ["todo.created", "todo.completed"]);
  assert.equal(sent[0][0].occurredAt, NOW);
  assert.match(sent[0][0].idempotencyKey, /^[0-9a-f-]{36}$/u);
  assert.equal("subject" in sent[0][0], false);
  client.track("todo.created", created());
  consent = false;
  await client.flush();
  assert.equal(client.queued, 0, "withdrawing consent must discard queued browser events");
  assert.equal(sent.length, 1);
  await client.close();
  assert.throws(() => client.track("todo.created", created()), /closed/u);
});
