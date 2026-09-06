import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservability, parseTraceparent } from "../dist/observability.js";
import { createTraceTimeline, renderTraceTimeline } from "../dist/trace-timeline.js";
import { createDevtools, renderDevtools } from "../dist/devtools.js";
import { defineDatabase, defineTable, defineBackend, openBackend } from "../dist/backend.js";
import { defineJobs, defineWorkflow, defineWorkflows } from "../dist/jobs.js";
import { s } from "../dist/ai.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

test("request traces survive worker restart, retries, deduplication, and deferred workflow steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-job-traces-"));
  const timeline = createTraceTimeline();
  const requestObs = createObservability({ serviceName: "web", exporter: timeline, log() {} });
  const workerObs = createObservability({ serviceName: "worker", exporter: timeline, log() {} });
  const schema = defineDatabase({ rows: defineTable({ value: s.string() }) });
  let attempts = 0;
  let seenContext;
  const jobs = defineJobs({ schema }).jobs(({ job }) => ({
    deliver: job({ args: { value: s.string() }, retry: { maxAttempts: 2 }, handler: ({ db }, input) => {
      seenContext = workerObs.tracer.current();
      if (++attempts === 1) throw new Error("private failure details");
      db.transaction(db => db.table("rows").insert(input));
    } }),
    step: job({ args: {}, handler: () => null }),
  }));
  const workflow = defineWorkflow({ args: {}, graph: ({ step }) => {
    const first = step(jobs.jobs.step, { args: () => ({}) });
    const second = step(jobs.jobs.step, { needs: [first], args: () => ({}) });
    return { first, second };
  } });
  const definition = defineBackend({ schema, jobs: defineWorkflows(jobs, { example: workflow }) }).functions(({ mutation, query }) => ({
    create: mutation({ args: {}, handler: ({ jobs: publisher }) => publisher.enqueue(jobs.jobs.deliver,
      { value: "private document value" }, { idempotencyKey: "stable-request" }).id }),
    list: query({ args: {}, handler: ({ db }) => db.table("rows").collect() }),
  }));
  let now = Date.now();
  let backend = await openBackend(definition, { path: join(root, "app.sqlite"), tracer: requestObs.tracer, jobs: { now: () => now } });
  try {
    const response = await requestObs.instrument(new Request("https://app.test/private-path", {
      headers: { "x-request-id": "request-123" },
    }), async () => new Response(backend.mutation("create", {}).value));
    const jobId = await response.text();
    const parent = parseTraceparent(response.headers.get("traceparent"));
    await requestObs.flush();
    const persisted = backend.database[SQLITE_INTERNAL].prepare("SELECT trace_context FROM clank_jobs WHERE id = ?").get(jobId).trace_context;
    assert.match(persisted, new RegExp(parent.traceId));
    // Another request reusing the idempotency key cannot replace the original trace.
    await requestObs.tracer.trace("mutation duplicate", () => backend.mutation("create", {}));
    assert.equal(backend.database[SQLITE_INTERNAL].prepare("SELECT trace_context FROM clank_jobs WHERE id = ?").get(jobId).trace_context, persisted);
    backend.close();
    backend = await openBackend(definition, { path: join(root, "app.sqlite"), tracer: workerObs.tracer, jobs: { now: () => now } });
    await backend.jobs.workOnce();
    now += 60_000;
    await backend.jobs.workOnce();
    await workerObs.flush();
    assert.equal(seenContext.traceId, parent.traceId);
    assert.equal(seenContext.requestId, "request-123");
    assert.equal(backend.jobs.get(jobId).state, "succeeded");
    const spans = timeline.snapshot(parent.traceId).spans;
    const mutation = spans.find(span => span.name === "mutation create");
    assert.equal(mutation.parentSpanId, parent.spanId);
    const deliveries = spans.filter(span => span.kind === "consumer");
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every(span => span.parentSpanId === mutation.spanId && span.jobId === jobId));
    assert.deepEqual(deliveries.map(span => span.status), ["error", "ok"]);
    assert.deepEqual(deliveries.map(span => span.attempt), [1, 2]);
    assert.doesNotMatch(JSON.stringify(timeline.snapshot()), /private document|private failure|private-path/);

    let workflowTrace;
    const handle = await workerObs.tracer.trace("mutation workflow", (span) => {
      workflowTrace = span.context.traceId;
      return backend.jobs.startWorkflow(workflow, {});
    });
    await backend.jobs.workOnce();
    await backend.jobs.workOnce();
    await workerObs.flush();
    assert.equal(backend.jobs.getWorkflow(handle.id).state, "succeeded");
    assert.equal(timeline.snapshot(workflowTrace).spans.filter(span => span.kind === "consumer").length, 2);
    const inspector = createDevtools({ timeline: () => timeline.snapshot(parent.traceId) });
    assert.match(renderDevtools(inspector.snapshot()), /Request and job timeline/);
    inspector.dispose();
  } finally { backend.close(); await requestObs.close(); await workerObs.close(); await rm(root, { recursive: true, force: true }); }
});

test("trace timeline bounds retention, filters unsafe metadata, escapes HTML, and rejects invalid IDs", async () => {
  const timeline = createTraceTimeline({ maxSpans: 1 });
  const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "private arbitrary name", kind: "internal",
    startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", status: "ok", attributes: { password: "secret" }, events: [] };
  await timeline.export([span, { ...span, spanId: "c".repeat(16) }]);
  assert.equal(timeline.snapshot().spans.length, 1);
  assert.equal(timeline.snapshot().truncated, true);
  assert.doesNotMatch(JSON.stringify(timeline.snapshot()), /private|secret|password/);
  assert.throws(() => timeline.snapshot("invalid"), /Invalid trace/);
  await timeline.export([{ ...span, spanId: "bad" }, { ...span, endTimeUnixNano: "1" }]);
  assert.equal(timeline.snapshot().spans[0].spanId, "c".repeat(16));
  const html = renderTraceTimeline({ ...timeline.snapshot(), spans: [{ ...timeline.snapshot().spans[0], name: '<SCRIPT>alert(1)</SCRIPT>' }] });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /partial/);
  timeline.clear();
  assert.equal(timeline.snapshot().spans.length, 0);
  assert.equal(timeline.snapshot().truncated, false);
  assert.throws(() => createTraceTimeline({ maxSpans: 0 }), /maxSpans/);
});
