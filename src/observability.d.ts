import type { Middleware } from "./server.js";
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
        checks: Record<string, HealthCheckResult & {
            critical: boolean;
        }>;
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
export declare function createObservability(options: ObservabilityOptions): Observability;
export declare function parseTraceparent(value?: string): TraceContext | undefined;
export declare function formatTraceparent(context: TraceContext): string;
export declare function createMemorySpanExporter(): SpanExporter & {
    spans: SpanData[];
};
export declare function createOtlpHttpSpanExporter(options: {
    url: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
    resource?: Attributes;
    serviceName?: string;
}): SpanExporter;
