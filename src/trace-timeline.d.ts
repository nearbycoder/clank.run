import type { SpanExporter, SpanData } from "./observability.js";
export interface TimelineSpan {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string | null;
    readonly requestId: string | null;
    readonly name: string;
    readonly kind: SpanData["kind"];
    readonly startedAt: number;
    readonly durationMs: number;
    readonly status: SpanData["status"];
    readonly jobId: string | null;
    readonly attempt: number | null;
}
export interface TraceTimelineSnapshot {
    readonly protocol: "clank-trace-timeline/1";
    readonly spans: readonly TimelineSpan[];
    readonly truncated: boolean;
}
export interface TraceTimeline extends SpanExporter {
    snapshot(traceId?: string): TraceTimelineSnapshot;
    clear(): void;
}
export declare function createTraceTimeline(options?: { maxSpans?: number }): TraceTimeline;
export declare function renderTraceTimeline(snapshot: TraceTimelineSnapshot): string;
