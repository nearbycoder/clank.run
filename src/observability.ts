import type { Middleware } from "./server.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Attributes = Record<string, unknown>;

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
  requestId?: string;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Attributes;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: readonly SpanEvent[];
}

export interface SpanExporter {
  export(spans: readonly SpanData[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface Span {
  readonly context: TraceContext;
  readonly ended: boolean;
  setAttribute(name: string, value: unknown): this;
  addEvent(name: string, attributes?: Attributes): this;
  recordException(error: unknown): this;
  setStatus(status: "ok" | "error", message?: string): this;
  end(): void;
}

export interface Tracer {
  current(): TraceContext | undefined;
  startSpan(name: string, options?: {
    kind?: SpanData["kind"];
    parent?: TraceContext;
    attributes?: Attributes;
    sampled?: boolean;
  }): Span;
  withSpan<Value>(span: Span, operation: () => Value): Value;
  trace<Value>(name: string, operation: (span: Span) => Value | Promise<Value>, options?: {
    kind?: SpanData["kind"];
    attributes?: Attributes;
  }): Promise<Value>;
}

export interface Logger {
  debug(message: string, attributes?: Attributes): void;
  info(message: string, attributes?: Attributes): void;
  warn(message: string, attributes?: Attributes): void;
  error(message: string, attributes?: Attributes): void;
  child(attributes: Attributes): Logger;
}

export interface MetricLabels {
  [name: string]: string | number | boolean;
}

export interface Counter {
  add(value?: number, labels?: MetricLabels): void;
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void;
  add(value: number, labels?: MetricLabels): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

export interface MetricsRegistry {
  counter(name: string, help: string, labelNames?: readonly string[]): Counter;
  gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
  histogram(name: string, help: string, options?: {
    labelNames?: readonly string[];
    buckets?: readonly number[];
  }): Histogram;
  prometheus(): string;
  response(): Response;
}

export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
  latencyMs: number;
}

export interface HealthRegistry {
  register(name: string, check: () => boolean | void | Promise<boolean | void>, options?: {
    critical?: boolean;
    timeoutMs?: number;
  }): () => void;
  check(): Promise<{
    ok: boolean;
    checks: Record<string, HealthCheckResult & { critical: boolean }>;
  }>;
  response(): Promise<Response>;
}

export interface Observability {
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly metrics: MetricsRegistry;
  readonly health: HealthRegistry;
  middleware<State extends Record<string, unknown>>(): Middleware<State>;
  instrument(request: Request, handler: () => Promise<Response>): Promise<Response>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface ObservabilityOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  logLevel?: LogLevel;
  log?: (record: Record<string, unknown>) => void;
  exporter?: SpanExporter;
  sampleRate?: number;
  maxMetricSeries?: number;
  resource?: Attributes;
}

export function createObservability(options: ObservabilityOptions): Observability {
  const serviceName = identifier(options.serviceName, "serviceName", 100);
  const resource = sanitizeAttributes({
    "service.name": serviceName,
    ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
    ...(options.environment ? { "deployment.environment": options.environment } : {}),
    ...options.resource,
  });
  const storage = createContextStorage();
  const pending = new Set<Promise<void>>();
  const sampleRate = finiteRange(options.sampleRate ?? 1, "sampleRate", 0, 1);
  const writeLog = options.log ?? ((record) => console.log(JSON.stringify(record)));
  const minimumLevel = levelNumber(options.logLevel ?? "info");
  const metrics = createMetricsRegistry(options.maxMetricSeries ?? 10_000);
  const health = createHealthRegistry();

  const loggerFor = (bound: Attributes): Logger => {
    const write = (level: LogLevel, message: string, attributes: Attributes = {}) => {
      if (levelNumber(level) < minimumLevel) return;
      const context = storage.getStore();
      const record = sanitizeAttributes({
        timestamp: new Date().toISOString(),
        level,
        message: bounded(message, "log message", 1, 4_096),
        ...resource,
        ...bound,
        ...attributes,
        ...(context?.trace ? {
          traceId: context.trace.traceId,
          spanId: context.trace.spanId,
          ...(context.trace.requestId ? { requestId: context.trace.requestId } : {}),
        } : {}),
      });
      try { writeLog(record); }
      catch { /* Logging must not change request behavior. */ }
    };
    return {
      debug: (message, attributes) => write("debug", message, attributes),
      info: (message, attributes) => write("info", message, attributes),
      warn: (message, attributes) => write("warn", message, attributes),
      error: (message, attributes) => write("error", message, attributes),
      child: (attributes) => loggerFor({ ...bound, ...sanitizeAttributes(attributes) }),
    };
  };
  const logger = loggerFor({});

  const tracer: Tracer = {
    current: () => storage.getStore()?.trace,
    startSpan(name, spanOptions = {}) {
      const parent = spanOptions.parent ?? storage.getStore()?.trace;
      const traceId = parent?.traceId ?? randomHex(16);
      const sampled = spanOptions.sampled ?? parent?.sampled ?? Math.random() < sampleRate;
      const context: TraceContext = {
        traceId,
        spanId: randomHex(8),
        sampled,
        ...(parent?.requestId ? { requestId: parent.requestId } : {}),
      };
      const start = unixNano();
      const attributes = sanitizeAttributes(spanOptions.attributes ?? {});
      const events: SpanEvent[] = [];
      let status: SpanData["status"] = "unset";
      let statusMessage: string | undefined;
      let ended = false;
      const span: Span = {
        context,
        get ended() { return ended; },
        setAttribute(attributeName, value) {
          attributes[attributeName] = sanitizeValue(value, attributeName);
          return span;
        },
        addEvent(eventName, eventAttributes = {}) {
          if (events.length < 128) {
            events.push({
              name: bounded(eventName, "span event name", 1, 200),
              timeUnixNano: unixNano(),
              attributes: sanitizeAttributes(eventAttributes),
            });
          }
          return span;
        },
        recordException(error) {
          status = "error";
          statusMessage = safeError(error);
          return span.addEvent("exception", {
            "exception.type": error instanceof Error ? error.name : typeof error,
            "exception.message": safeError(error),
            ...(error instanceof Error && error.stack ? { "exception.stacktrace": error.stack } : {}),
          });
        },
        setStatus(nextStatus, message) {
          status = nextStatus;
          statusMessage = message;
          return span;
        },
        end() {
          if (ended) return;
          ended = true;
          if (!context.sampled || !options.exporter) return;
          const data: SpanData = {
            traceId,
            spanId: context.spanId,
            ...(parent ? { parentSpanId: parent.spanId } : {}),
            name: bounded(name, "span name", 1, 200),
            kind: spanOptions.kind ?? "internal",
            startTimeUnixNano: start,
            endTimeUnixNano: unixNano(),
            status,
            ...(statusMessage ? { statusMessage: statusMessage.slice(0, 4_096) } : {}),
            attributes,
            events,
          };
          const exportPromise = options.exporter.export([data]).catch((error) => {
            logger.warn("Trace export failed.", { error: safeError(error) });
          });
          pending.add(exportPromise);
          void exportPromise.finally(() => pending.delete(exportPromise));
        },
      };
      return span;
    },
    withSpan(span, operation) {
      const current = storage.getStore() ?? {};
      return storage.run({ ...current, trace: span.context }, operation);
    },
    async trace(name, operation, traceOptions = {}) {
      const span = tracer.startSpan(name, traceOptions);
      try {
        const result = await tracer.withSpan(span, () => operation(span));
        span.setStatus("ok");
        return result;
      } catch (error) {
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    },
  };

  const requests = metrics.counter(
    "clank_http_requests_total",
    "HTTP requests completed by the service.",
    ["method", "route", "status_class"],
  );
  const duration = metrics.histogram(
    "clank_http_request_duration_seconds",
    "HTTP request duration in seconds.",
    { labelNames: ["method", "route", "status_class"] },
  );
  const active = metrics.gauge(
    "clank_http_active_requests",
    "HTTP requests currently being served.",
    ["method"],
  );

  const instrument = async (request: Request, handler: () => Promise<Response>): Promise<Response> => {
    const started = performance.now();
    const parent = parseTraceparent(request.headers.get("traceparent") ?? undefined);
    const requestId = requestIdValue(request.headers.get("x-request-id"));
    const span = tracer.startSpan(`${request.method} ${new URL(request.url).pathname}`, {
      kind: "server",
      parent: parent ? { ...parent, requestId } : undefined,
      attributes: {
        "http.request.method": request.method,
        "url.path": new URL(request.url).pathname,
        "server.address": new URL(request.url).hostname,
      },
    });
    span.context.requestId = requestId;
    active.add(1, { method: request.method });
    return tracer.withSpan(span, async () => {
      let response: Response;
      try {
        response = await handler();
        span.setStatus(response.status >= 500 ? "error" : "ok");
      } catch (error) {
        span.recordException(error);
        const route = routeLabel(new URL(request.url).pathname);
        const elapsed = (performance.now() - started) / 1_000;
        requests.add(1, { method: request.method, route, status_class: "5xx" });
        duration.observe(elapsed, { method: request.method, route, status_class: "5xx" });
        span.end();
        logger.error("HTTP request failed.", {
          method: request.method,
          path: new URL(request.url).pathname,
          durationMs: rounded(elapsed * 1_000),
          error,
        });
        throw error;
      } finally {
        active.add(-1, { method: request.method });
      }
      const path = new URL(request.url).pathname;
      const route = routeLabel(path);
      const statusClass = `${Math.floor(response.status / 100)}xx`;
      const elapsed = (performance.now() - started) / 1_000;
      requests.add(1, { method: request.method, route, status_class: statusClass });
      duration.observe(elapsed, { method: request.method, route, status_class: statusClass });
      span.setAttribute("http.response.status_code", response.status);
      span.end();
      logger.info("HTTP request completed.", {
        method: request.method,
        path,
        status: response.status,
        durationMs: Math.round(elapsed * 1_000 * 100) / 100,
      });
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      headers.set("traceparent", formatTraceparent(span.context));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  };

  return {
    logger,
    tracer,
    metrics,
    health,
    middleware() {
      return ({ request }, next) => instrument(request, next);
    },
    instrument,
    async flush() {
      await Promise.all([...pending]);
    },
    async close() {
      await Promise.all([...pending]);
      await options.exporter?.shutdown?.();
    },
  };
}

export function parseTraceparent(value?: string): TraceContext | undefined {
  if (!value) return undefined;
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/u.exec(value.trim().toLowerCase());
  if (!match || /^0+$/u.test(match[1]!) || /^0+$/u.test(match[2]!)) return undefined;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    sampled: (Number.parseInt(match[3]!, 16) & 1) === 1,
  };
}

export function formatTraceparent(context: TraceContext): string {
  if (!/^[a-f0-9]{32}$/u.test(context.traceId) || !/^[a-f0-9]{16}$/u.test(context.spanId)) {
    throw new TypeError("Invalid trace context.");
  }
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export function createMemorySpanExporter(): SpanExporter & { spans: SpanData[] } {
  const spans: SpanData[] = [];
  return {
    spans,
    async export(batch) {
      spans.push(...structuredClone(batch));
    },
  };
}

export function createOtlpHttpSpanExporter(options: {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  resource?: Attributes;
  serviceName?: string;
}): SpanExporter {
  const url = secureUrl(options.url);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs");
  const headers = transportHeaders(options.headers ?? {});
  const resource = sanitizeAttributes({
    ...(options.serviceName ? { "service.name": options.serviceName } : {}),
    ...options.resource,
  });
  return {
    async export(spans) {
      if (!spans.length) return;
      const payload = {
        resourceSpans: [{
          resource: { attributes: otlpAttributes(resource) },
          scopeSpans: [{
            scope: { name: "clank", version: "1" },
            spans: spans.map((span) => ({
              traceId: hexToBase64(span.traceId),
              spanId: hexToBase64(span.spanId),
              ...(span.parentSpanId ? { parentSpanId: hexToBase64(span.parentSpanId) } : {}),
              name: span.name,
              kind: spanKind(span.kind),
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: otlpAttributes(span.attributes),
              events: span.events.map((event) => ({
                name: event.name,
                timeUnixNano: event.timeUnixNano,
                attributes: otlpAttributes(event.attributes),
              })),
              status: {
                code: span.status === "error" ? 2 : span.status === "ok" ? 1 : 0,
                ...(span.statusMessage ? { message: span.statusMessage } : {}),
              },
            })),
          }],
        }],
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(payload),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`OTLP endpoint returned ${response.status}.`);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function createMetricsRegistry(maxSeriesInput: number): MetricsRegistry {
  const maxSeries = positiveInteger(maxSeriesInput, "maxMetricSeries");
  type Series = { labels: Record<string, string>; value: number };
  type Metric = {
    name: string;
    help: string;
    type: "counter" | "gauge" | "histogram";
    labels: readonly string[];
    series: Map<string, Series>;
    buckets?: readonly number[];
    histograms?: Map<string, { labels: Record<string, string>; count: number; sum: number; buckets: number[] }>;
  };
  const metrics = new Map<string, Metric>();
  let seriesCount = 0;

  const define = (
    nameInput: string,
    helpInput: string,
    type: Metric["type"],
    labelsInput: readonly string[],
    buckets?: readonly number[],
  ): Metric => {
    const name = metricName(nameInput);
    const help = bounded(helpInput, "metric help", 1, 500);
    const labels = [...new Set(labelsInput.map(labelName))];
    const existing = metrics.get(name);
    if (existing) {
      if (existing.type !== type || JSON.stringify(existing.labels) !== JSON.stringify(labels)) {
        throw new TypeError(`Metric ${name} was already registered with another definition.`);
      }
      return existing;
    }
    const metric: Metric = {
      name,
      help,
      type,
      labels,
      series: new Map(),
      ...(buckets ? { buckets, histograms: new Map() } : {}),
    };
    metrics.set(name, metric);
    return metric;
  };

  const normalizedLabels = (metric: Metric, input: MetricLabels = {}): Record<string, string> => {
    const output: Record<string, string> = {};
    for (const name of metric.labels) {
      if (!(name in input)) throw new TypeError(`Metric ${metric.name} requires label ${name}.`);
      output[name] = String(input[name]).slice(0, 200);
    }
    for (const name of Object.keys(input)) {
      if (!metric.labels.includes(name)) throw new TypeError(`Metric ${metric.name} does not define label ${name}.`);
    }
    return output;
  };
  const keyFor = (labels: Record<string, string>) => JSON.stringify(labels);
  const seriesFor = (metric: Metric, labels: Record<string, string>): Series => {
    const key = keyFor(labels);
    let series = metric.series.get(key);
    if (!series) {
      if (seriesCount >= maxSeries) throw new Error(`Metric series limit ${maxSeries} exceeded.`);
      series = { labels, value: 0 };
      metric.series.set(key, series);
      seriesCount++;
    }
    return series;
  };

  const registry: MetricsRegistry = {
    counter(name, help, labelNames = []) {
      const metric = define(name, help, "counter", labelNames);
      return {
        add(value = 1, labels = {}) {
          if (!Number.isFinite(value) || value < 0) throw new TypeError("Counter increments must be non-negative finite numbers.");
          seriesFor(metric, normalizedLabels(metric, labels)).value += value;
        },
      };
    },
    gauge(name, help, labelNames = []) {
      const metric = define(name, help, "gauge", labelNames);
      return {
        set(value, labels = {}) {
          if (!Number.isFinite(value)) throw new TypeError("Gauge values must be finite.");
          seriesFor(metric, normalizedLabels(metric, labels)).value = value;
        },
        add(value, labels = {}) {
          if (!Number.isFinite(value)) throw new TypeError("Gauge values must be finite.");
          seriesFor(metric, normalizedLabels(metric, labels)).value += value;
        },
      };
    },
    histogram(name, help, histogramOptions = {}) {
      const buckets = Object.freeze([...(histogramOptions.buckets ?? [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])]
        .map((bucket) => finiteRange(bucket, "histogram bucket", 0, Number.MAX_VALUE))
        .sort((left, right) => left - right));
      if (new Set(buckets).size !== buckets.length) throw new TypeError("Histogram buckets must be unique.");
      const metric = define(name, help, "histogram", histogramOptions.labelNames ?? [], buckets);
      return {
        observe(value, labels = {}) {
          if (!Number.isFinite(value)) throw new TypeError("Histogram observations must be finite.");
          const normalized = normalizedLabels(metric, labels);
          const key = keyFor(normalized);
          let series = metric.histograms!.get(key);
          if (!series) {
            if (seriesCount >= maxSeries) throw new Error(`Metric series limit ${maxSeries} exceeded.`);
            series = { labels: normalized, count: 0, sum: 0, buckets: buckets.map(() => 0) };
            metric.histograms!.set(key, series);
            seriesCount++;
          }
          series.count++;
          series.sum += value;
          buckets.forEach((bucket, index) => {
            if (value <= bucket) series!.buckets[index]++;
          });
        },
      };
    },
    prometheus() {
      const lines: string[] = [];
      for (const metric of [...metrics.values()].sort((left, right) => left.name.localeCompare(right.name))) {
        lines.push(`# HELP ${metric.name} ${prometheusHelp(metric.help)}`);
        lines.push(`# TYPE ${metric.name} ${metric.type}`);
        if (metric.type === "histogram") {
          for (const series of metric.histograms!.values()) {
            metric.buckets!.forEach((bucket, index) => {
              lines.push(`${metric.name}_bucket${prometheusLabels({ ...series.labels, le: String(bucket) })} ${series.buckets[index]}`);
            });
            lines.push(`${metric.name}_bucket${prometheusLabels({ ...series.labels, le: "+Inf" })} ${series.count}`);
            lines.push(`${metric.name}_sum${prometheusLabels(series.labels)} ${series.sum}`);
            lines.push(`${metric.name}_count${prometheusLabels(series.labels)} ${series.count}`);
          }
        } else {
          for (const series of metric.series.values()) {
            lines.push(`${metric.name}${prometheusLabels(series.labels)} ${series.value}`);
          }
        }
      }
      return `${lines.join("\n")}\n`;
    },
    response() {
      return new Response(registry.prometheus(), {
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  };
  return registry;
}

function createHealthRegistry(): HealthRegistry {
  const checks = new Map<string, {
    check: () => boolean | void | Promise<boolean | void>;
    critical: boolean;
    timeoutMs: number;
  }>();
  return {
    register(nameInput, check, options = {}) {
      const name = identifier(nameInput, "health check name", 100);
      if (checks.has(name)) throw new TypeError(`Health check already exists: ${name}`);
      checks.set(name, {
        check,
        critical: options.critical ?? true,
        timeoutMs: positiveInteger(options.timeoutMs ?? 5_000, "health timeoutMs"),
      });
      return () => checks.delete(name);
    },
    async check() {
      const results: Record<string, HealthCheckResult & { critical: boolean }> = {};
      await Promise.all([...checks].map(async ([name, entry]) => {
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve(entry.check()),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Health check timed out.")), entry.timeoutMs);
            }),
          ]);
          results[name] = {
            ok: result !== false,
            critical: entry.critical,
            latencyMs: rounded(performance.now() - started),
          };
        } catch (error) {
          results[name] = {
            ok: false,
            critical: entry.critical,
            detail: safeError(error).slice(0, 500),
            latencyMs: rounded(performance.now() - started),
          };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }));
      return {
        ok: Object.values(results).every((result) => result.ok || !result.critical),
        checks: results,
      };
    },
    async response() {
      const result = await this.check();
      return Response.json(result, {
        status: result.ok ? 200 : 503,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  };
}

function createContextStorage(): {
  getStore(): { trace?: TraceContext } | undefined;
  run<Value>(store: { trace?: TraceContext }, operation: () => Value): Value;
} {
  const module = (globalThis as any).process?.getBuiltinModule?.("node:async_hooks");
  if (module?.AsyncLocalStorage) return new module.AsyncLocalStorage();
  let current: { trace?: TraceContext } | undefined;
  return {
    getStore: () => current,
    run(store, operation) {
      const previous = current;
      current = store;
      try { return operation(); }
      finally { current = previous; }
    },
  };
}

function sanitizeAttributes(input: Attributes = {}): Attributes {
  const output: Attributes = {};
  for (const [name, value] of Object.entries(input).slice(0, 256)) {
    output[name.slice(0, 200)] = sanitizeValue(value, name);
  }
  return output;
}

function sanitizeValue(value: unknown, name: string, depth = 0): unknown {
  if (/(?:password|passwd|secret|token|authorization|cookie|api[-_]?key)/iu.test(name)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 4_096 ? `${value.slice(0, 4_096)}…` : value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth >= 4) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, name, depth + 1));
  if (value && typeof value === "object") {
    const output: Attributes = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = sanitizeValue(entry, key, depth + 1);
    }
    return output;
  }
  return String(value);
}

function otlpAttributes(attributes: Attributes): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  return { stringValue: JSON.stringify(value) };
}

function spanKind(kind: SpanData["kind"]): number {
  return { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 }[kind];
}

function unixNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestIdValue(input: string | null): string {
  return input && /^[A-Za-z0-9_.-]{8,128}$/u.test(input) ? input : crypto.randomUUID();
}

function routeLabel(path: string): string {
  return path.split("/").map((segment) => {
    if (
      /^\d+$/u.test(segment)
      || /^[a-f0-9]{16,}$/iu.test(segment)
      || /^[A-Za-z0-9_-]{24,}$/u.test(segment)
    ) return ":id";
    return segment.slice(0, 100);
  }).join("/").slice(0, 500);
}

function metricName(value: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(value)) throw new TypeError(`Invalid metric name: ${value}`);
  return value;
}

function labelName(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new TypeError(`Invalid metric label: ${value}`);
  return value;
}

function prometheusLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  return `{${entries.map(([name, value]) =>
    `${name}="${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"")}"`).join(",")}}`;
}

function prometheusHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function hexToBase64(value: string): string {
  const bytes = Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function transportHeaders(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(name) || /[\r\n\0]/u.test(value)) {
      throw new TypeError(`Invalid OTLP header: ${name}`);
    }
    output[name] = value;
  }
  return output;
}

function secureUrl(input: string): string {
  const url = new URL(input);
  if (
    url.username
    || url.password
    || url.hash
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
  ) throw new TypeError("OTLP URL must use HTTPS, except for loopback development.");
  return url.href;
}

function identifier(value: string, name: string, maximum: number): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value) || value.length > maximum) {
    throw new TypeError(`Invalid ${name}: ${value}`);
  }
  return value;
}

function bounded(value: string, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} must contain ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function levelNumber(level: LogLevel): number {
  return { debug: 10, info: 20, warn: 30, error: 40 }[level];
}

function finiteRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
