import type { SpanExporter, SpanData } from "./observability.ts";

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

/** A local bounded span exporter. Raw attributes, URLs, payloads, and exceptions are excluded. */
export function createTraceTimeline(options: { maxSpans?: number } = {}): TraceTimeline {
  const maximum = options.maxSpans ?? 500;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5_000) throw new TypeError("Trace maxSpans must be 1–5000.");
  const spans = new Map<string, TimelineSpan>();
  let truncated = false;
  return {
    async export(batch) {
      for (const span of batch) {
        if (!/^[a-f0-9]{32}$/.test(span.traceId) || !/^[a-f0-9]{16}$/.test(span.spanId)
          || !/^\d{1,24}$/.test(span.startTimeUnixNano) || !/^\d{1,24}$/.test(span.endTimeUnixNano)) continue;
        const startedAt = Number(BigInt(span.startTimeUnixNano) / 1_000n) / 1_000;
        const durationMs = Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000;
        if (startedAt > 8_640_000_000_000_000 || durationMs < 0 || durationMs > 30 * 24 * 60 * 60_000) continue;
        const jobId = span.attributes?.["clank.job.id"];
        const attempt = span.attributes?.["clank.job.attempt"];
        const record = Object.freeze({ traceId: span.traceId, spanId: span.spanId,
          parentSpanId: span.parentSpanId && /^[a-f0-9]{16}$/.test(span.parentSpanId) ? span.parentSpanId : null,
          requestId: span.requestId && /^[A-Za-z0-9._-]{1,128}$/.test(span.requestId) ? span.requestId : null,
          name: span.kind === "server" ? "HTTP request" : /^(query|mutation|job) [A-Za-z0-9._-]+$/.test(span.name) ? span.name.slice(0, 200) : span.kind,
          kind: span.kind, startedAt, durationMs, status: span.status,
          jobId: typeof jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(jobId) ? jobId : null,
          attempt: typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null,
        });
        const key = `${span.traceId}:${span.spanId}`;
        spans.delete(key);
        spans.set(key, record);
        if (spans.size > maximum) { spans.delete(spans.keys().next().value!); truncated = true; }
      }
    },
    snapshot(traceId) {
      if (traceId !== undefined && !/^[a-f0-9]{32}$/.test(traceId)) throw new TypeError("Invalid trace ID.");
      return Object.freeze({ protocol: "clank-trace-timeline/1" as const, truncated,
        spans: Object.freeze([...spans.values()].filter((span) => traceId === undefined || span.traceId === traceId)
          .sort((left, right) => left.startedAt - right.startedAt)) });
    },
    clear() { spans.clear(); truncated = false; },
    async shutdown() { spans.clear(); },
  };
}

function escape(value: unknown): string { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }
export function renderTraceTimeline(snapshot: TraceTimelineSnapshot): string {
  const rows = snapshot.spans.map((span) => `<tr>${[
    span.name, span.requestId ?? "—", span.traceId, span.spanId, span.parentSpanId ?? "—",
    new Date(span.startedAt).toISOString(), span.durationMs.toFixed(2), span.status,
    span.jobId ?? "—", span.attempt ?? "—",
  ].map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("");
  return `<section aria-label="Request and job timeline"><h2>Request and job timeline</h2><p>Sampled, completed spans in start-time order. Missing parents may have expired, be unsampled, or belong to another process.</p>${snapshot.truncated ? "<p>History limit reached; this timeline is partial.</p>" : ""}<div class="scroll"><table><thead><tr><th>Operation</th><th>Request</th><th>Trace</th><th>Span</th><th>Parent</th><th>Started</th><th>Duration (ms)</th><th>Status</th><th>Job</th><th>Attempt</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
