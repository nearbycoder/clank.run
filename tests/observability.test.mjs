import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemorySpanExporter,
  createObservability,
  createOtlpHttpSpanExporter,
  formatTraceparent,
  parseTraceparent,
} from "../dist/index.js";

test("request instrumentation propagates W3C traces, redacts logs, and emits bounded metrics", async () => {
  const exporter = createMemorySpanExporter();
  const logs = [];
  const observability = createObservability({
    serviceName: "todo-api",
    serviceVersion: "1.2.3",
    exporter,
    log: (record) => logs.push(record),
  });
  const parent = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    sampled: true,
  };
  const response = await observability.instrument(new Request(
    "https://todo.test/tasks/550e8400e29b41d4a716446655440000",
    {
      method: "POST",
      headers: {
        traceparent: formatTraceparent(parent),
        "x-request-id": "request-1234",
      },
    },
  ), async () => {
    observability.logger.info("Creating task.", {
      taskId: "task-1",
      password: "do-not-log",
      nested: { accessToken: "also-secret" },
    });
    return Response.json({ ok: true }, { status: 201 });
  });
  await observability.flush();

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "request-1234");
  const responseTrace = parseTraceparent(response.headers.get("traceparent"));
  assert.equal(responseTrace.traceId, parent.traceId);
  assert.notEqual(responseTrace.spanId, parent.spanId);
  assert.equal(exporter.spans.length, 1);
  assert.equal(exporter.spans[0].parentSpanId, parent.spanId);
  assert.equal(exporter.spans[0].status, "ok");
  assert.equal(logs[0].traceId, parent.traceId);
  assert.equal(logs[0].requestId, "request-1234");
  assert.equal(logs[0].password, "[REDACTED]");
  assert.equal(logs[0].nested.accessToken, "[REDACTED]");
  assert.match(
    observability.metrics.prometheus(),
    /route="\/tasks\/:id".*status_class="2xx"/,
  );
  await observability.close();
});

test("tracer records exceptions, health distinguishes critical checks, and invalid parents are ignored", async () => {
  const exporter = createMemorySpanExporter();
  const observability = createObservability({
    serviceName: "worker",
    exporter,
    log: () => {},
  });
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01"), undefined);
  await assert.rejects(
    observability.tracer.trace("job.run", async () => {
      throw new Error("handler failed");
    }),
    /handler failed/,
  );
  await observability.flush();
  assert.equal(exporter.spans[0].status, "error");
  assert.ok(exporter.spans[0].events.some((event) => event.name === "exception"));

  observability.health.register("database", () => true);
  observability.health.register("optional-mail", () => false, { critical: false });
  let health = await observability.health.check();
  assert.equal(health.ok, true);
  observability.health.register("queue", () => {
    throw new Error("queue offline");
  });
  health = await observability.health.check();
  assert.equal(health.ok, false);
  const response = await observability.health.response();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.queue.detail, "queue offline");
});

test("OTLP HTTP exporter emits protocol JSON with byte IDs and transport headers", async () => {
  const calls = [];
  const exporter = createOtlpHttpSpanExporter({
    url: "https://otel.example.test/v1/traces",
    serviceName: "todo-api",
    headers: { "x-api-key": "collector-key" },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    },
  });
  await exporter.export([{
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: "fedcba9876543210",
    name: "POST /tasks",
    kind: "server",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    status: "ok",
    attributes: { "http.response.status_code": 201 },
    events: [],
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://otel.example.test/v1/traces");
  assert.equal(calls[0].init.headers["x-api-key"], "collector-key");
  const body = JSON.parse(calls[0].init.body);
  const resource = body.resourceSpans[0].resource.attributes;
  assert.ok(resource.some((entry) =>
    entry.key === "service.name" && entry.value.stringValue === "todo-api"));
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(Buffer.from(span.traceId, "base64").toString("hex"), "0123456789abcdef0123456789abcdef");
  assert.equal(span.kind, 2);
  assert.equal(span.status.code, 1);
});
