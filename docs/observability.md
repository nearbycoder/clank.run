# Observability

One `createObservability` instance provides structured logs, W3C trace propagation, metrics, and readiness checks without a runtime package.

```ts
import {
  createObservability,
  createOtlpHttpSpanExporter,
} from "clank.run/observability";

const observability = createObservability({
  serviceName: "orbit-tasks",
  serviceVersion: "1.0.0",
  environment: process.env.NODE_ENV,
  exporter: process.env.OTLP_TRACES_URL
    ? createOtlpHttpSpanExporter({
        url: process.env.OTLP_TRACES_URL,
        headers: { authorization: `Bearer ${process.env.OTLP_TOKEN}` },
        serviceName: "orbit-tasks",
      })
    : undefined,
});

const app = createApp()
  .use(observability.middleware())
  .get("/healthz", () => observability.health.response());
```

Generated apps install the middleware and a database readiness check automatically.

## Logs

Logs are one JSON object per event and automatically include service, trace, span, and request IDs. Keys containing password, secret, token, authorization, cookie, or API-key patterns are recursively redacted. Values, nesting, arrays, event counts, and attribute counts are bounded.

Use child loggers for stable context:

```ts
const log = observability.logger.child({ component: "reminders" });
log.info("Reminder queued.", { taskId });
```

Do not attach email addresses, request bodies, query strings, session IDs, or unbounded user identifiers as metric labels.

## Traces

Incoming `traceparent` headers are validated according to W3C Trace Context. Server spans preserve sampled trace IDs, create a new span ID, return `traceparent`, and attach a safe request ID.

```ts
await observability.tracer.trace("reminder.send", async (span) => {
  span.setAttribute("reminder.channel", "email");
  await sendReminder();
});
```

Exceptions become bounded span events and error status. The OTLP/HTTP JSON exporter uses protocol byte encoding, HTTPS, explicit headers, a timeout, and redirect rejection.

## Metrics

The registry supports counters, gauges, and histograms and renders Prometheus text:

```ts
const sent = observability.metrics.counter(
  "app_reminders_sent_total",
  "Reminders accepted by the delivery service.",
  ["channel"],
);

sent.add(1, { channel: "email" });
```

Metric and label names are validated, label sets must match their declaration, histograms use cumulative buckets, and a global series limit prevents accidental memory exhaustion. HTTP middleware normalizes ID-like route segments before using the path as a label.

Expose `observability.metrics.response()` only on an operator-protected endpoint or private network.

## Readiness

Critical checks determine the HTTP status. Optional dependencies remain visible without taking the service out of rotation:

```ts
observability.health.register("database", checkDatabase);
observability.health.register("email", checkMail, { critical: false });
```

Checks run concurrently with individual timeouts. Responses use `no-store` and return `503` when a critical dependency fails.

