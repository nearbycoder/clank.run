import { s, type InferSchemaShape, type Schema, type SchemaShape } from "./ai.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

export type AnalyticsConsent = "granted" | "denied" | "unknown";
export type AnalyticsInterval = "hour" | "day" | "week";

export interface AnalyticsEventInput<Properties extends SchemaShape = SchemaShape> {
  /** Why the application records this event. Included in the agent-readable manifest. */
  description: string;
  /** A closed set of low-risk, aggregate-safe properties. */
  properties?: Properties;
  /** Enum or boolean properties that may be used for aggregate breakdowns. */
  dimensions?: readonly (keyof Properties & string)[];
  /** Bounded numeric properties that may be averaged in aggregate queries. */
  measures?: readonly (keyof Properties & string)[];
  /** Event retention in days. Defaults to 30 and cannot exceed 400. */
  retentionDays?: number;
  /** Deterministic subject sampling rate. Defaults to 1. */
  sampleRate?: number;
}

export type AnalyticsEventInputs = Record<string, AnalyticsEventInput<any>>;
export type AnalyticsEventName<Events extends AnalyticsEventInputs> = keyof Events & string;
export type AnalyticsProperties<Definition> = Definition extends AnalyticsEventInput<infer Properties>
  ? InferSchemaShape<Properties>
  : never;
type AnalyticsPropertyShape<Definition> = Definition extends AnalyticsEventInput<infer Properties> ? Properties : {};

export interface AnalyticsFunnelInput<Event extends string = string> {
  description: string;
  /** Ordered event names. Each subject must produce every step in this order. */
  steps: readonly Event[];
  /** Maximum elapsed time from the first to last step. Defaults to 7 days. */
  withinMs?: number;
}

export type AnalyticsFunnelInputs<Event extends string> = Record<string, AnalyticsFunnelInput<Event>>;

interface NormalizedAnalyticsEvent<Properties extends SchemaShape = SchemaShape> {
  readonly description: string;
  readonly properties: Readonly<Properties>;
  readonly schema: Schema<InferSchemaShape<Properties>>;
  readonly dimensions: readonly (keyof Properties & string)[];
  readonly measures: readonly (keyof Properties & string)[];
  readonly retentionDays: number;
  readonly sampleRate: number;
}

interface NormalizedAnalyticsFunnel<Event extends string = string> {
  readonly description: string;
  readonly steps: readonly Event[];
  readonly withinMs: number;
}

export interface AnalyticsDefinition<
  Events extends AnalyticsEventInputs = AnalyticsEventInputs,
  Funnels extends AnalyticsFunnelInputs<AnalyticsEventName<Events>> = AnalyticsFunnelInputs<AnalyticsEventName<Events>>,
> {
  readonly events: { readonly [Name in keyof Events]: NormalizedAnalyticsEvent<AnalyticsPropertyShape<Events[Name]>> };
  readonly funnels: { readonly [Name in keyof Funnels]: NormalizedAnalyticsFunnel<AnalyticsEventName<Events>> };
}

export type AnalyticsEventsOf<Definition> = Definition extends AnalyticsDefinition<infer Events, any> ? Events : never;
export type AnalyticsFunnelsOf<Definition> = Definition extends AnalyticsDefinition<any, infer Funnels> ? Funnels : never;

export function defineAnalytics<
  const Events extends AnalyticsEventInputs,
  const Funnels extends AnalyticsFunnelInputs<AnalyticsEventName<Events>> = {},
>(input: { events: Events; funnels?: Funnels }): AnalyticsDefinition<Events, Funnels> {
  if (!input || typeof input !== "object") throw new TypeError("defineAnalytics() requires an event definition.");
  const sourceEvents = input.events;
  if (!sourceEvents || typeof sourceEvents !== "object" || Array.isArray(sourceEvents)) {
    throw new TypeError("analytics.events must be an object.");
  }
  const eventEntries = Object.entries(sourceEvents);
  if (eventEntries.length === 0) throw new TypeError("analytics.events must define at least one event.");
  if (eventEntries.length > MAX_EVENTS) throw new TypeError(`analytics.events cannot exceed ${MAX_EVENTS} events.`);

  const events: Record<string, NormalizedAnalyticsEvent<any>> = {};
  for (const [name, event] of eventEntries) {
    eventName(name);
    if (!event || typeof event !== "object") throw new TypeError(`Analytics event ${name} must be an object.`);
    const description = boundedText(event.description, `analytics.events.${name}.description`, 1, 500);
    const properties = Object.freeze({ ...(event.properties ?? {}) });
    if (Object.keys(properties).length > MAX_PROPERTIES) {
      throw new TypeError(`Analytics event ${name} cannot exceed ${MAX_PROPERTIES} properties.`);
    }
    const propertySchemas = new Map<string, Record<string, unknown>>();
    for (const [property, schema] of Object.entries(properties)) {
      propertyName(property, `analytics.events.${name}.properties`);
      if (!schema || typeof (schema as Schema).parse !== "function" || typeof (schema as Schema).toJSONSchema !== "function") {
        throw new TypeError(`Analytics property ${name}.${property} must be a Clank schema.`);
      }
      if (SENSITIVE_PROPERTY.test(property)) {
        throw new TypeError(`Analytics property ${name}.${property} looks identity-bearing or sensitive; record aggregate product state instead.`);
      }
      const json = (schema as Schema).toJSONSchema();
      validatePropertySchema(json, `${name}.${property}`);
      propertySchemas.set(property, json);
    }
    const dimensions = uniqueProperties(event.dimensions ?? [], properties, `${name}.dimensions`);
    const measures = uniqueProperties(event.measures ?? [], properties, `${name}.measures`);
    for (const dimension of dimensions) validateDimensionSchema(propertySchemas.get(dimension)!, `${name}.${dimension}`);
    for (const measure of measures) validateMeasureSchema(propertySchemas.get(measure)!, `${name}.${measure}`);
    const overlap = dimensions.find((dimension) => measures.includes(dimension));
    if (overlap) throw new TypeError(`Analytics property ${name}.${overlap} cannot be both a dimension and a measure.`);
    const retentionDays = positiveInteger(event.retentionDays ?? 30, `${name}.retentionDays`, 1, MAX_RETENTION_DAYS);
    const sampleRate = finiteNumber(event.sampleRate ?? 1, `${name}.sampleRate`, MIN_SAMPLE_RATE, 1);
    events[name] = Object.freeze({
      description,
      properties,
      schema: s.object(properties),
      dimensions: Object.freeze(dimensions),
      measures: Object.freeze(measures),
      retentionDays,
      sampleRate,
    });
  }

  const sourceFunnels = input.funnels ?? {};
  if (!sourceFunnels || typeof sourceFunnels !== "object" || Array.isArray(sourceFunnels)) {
    throw new TypeError("analytics.funnels must be an object.");
  }
  if (Object.keys(sourceFunnels).length > MAX_FUNNELS) {
    throw new TypeError(`analytics.funnels cannot exceed ${MAX_FUNNELS} funnels.`);
  }
  const funnels: Record<string, NormalizedAnalyticsFunnel> = {};
  for (const [name, funnel] of Object.entries(sourceFunnels)) {
    identifier(name, "analytics funnel", 80);
    if (!funnel || typeof funnel !== "object") throw new TypeError(`Analytics funnel ${name} must be an object.`);
    const description = boundedText(funnel.description, `analytics.funnels.${name}.description`, 1, 500);
    if (!Array.isArray(funnel.steps) || funnel.steps.length < 2 || funnel.steps.length > MAX_FUNNEL_STEPS) {
      throw new TypeError(`Analytics funnel ${name} must have 2-${MAX_FUNNEL_STEPS} steps.`);
    }
    const steps = funnel.steps.map((step, index) => {
      const value = boundedText(step, `${name}.steps[${index}]`, 1, 100);
      if (!Object.hasOwn(events, value)) throw new TypeError(`Analytics funnel ${name} references unknown event ${value}.`);
      return value;
    });
    if (new Set(steps).size !== steps.length) {
      throw new TypeError(`Analytics funnel ${name} steps must use distinct event names.`);
    }
    const sampleRates = new Set(steps.map((step) => events[step].sampleRate));
    if (sampleRates.size !== 1) {
      throw new TypeError(`Analytics funnel ${name} events must use the same sampleRate for valid conversion rates.`);
    }
    const withinMs = positiveInteger(funnel.withinMs ?? 7 * DAY, `${name}.withinMs`, MINUTE, MAX_RETENTION_DAYS * DAY);
    funnels[name] = Object.freeze({ description, steps: Object.freeze(steps), withinMs });
  }

  return Object.freeze({ events: Object.freeze(events), funnels: Object.freeze(funnels) }) as AnalyticsDefinition<Events, Funnels>;
}

export interface AnalyticsTrackContext {
  /** Explicit application consent. Unknown and denied are not persisted. */
  consent: AnalyticsConsent;
  /** Honor a browser or account-level do-not-track preference. */
  doNotTrack?: boolean;
  /** Server-resolved authenticated subject. Raw values are never persisted. */
  subject?: string;
  /** First-party anonymous subject. Raw values are never persisted. */
  anonymousId?: string;
  /** Optional first-party session identifier. Raw values are never persisted. */
  sessionId?: string;
  /** Optional retry key. Stored only as a keyed digest. */
  idempotencyKey?: string;
  /** Client occurrence time, bounded to 24 hours of server time. */
  occurredAt?: number;
}

export interface AnalyticsTrackResult {
  readonly stored: boolean;
  readonly reason?: "consent" | "do_not_track" | "sampled" | "duplicate" | "capacity";
}

export interface AnalyticsClientEvent<Name extends string = string, Properties = Record<string, unknown>> {
  readonly name: Name;
  readonly properties: Properties;
  readonly occurredAt: number;
  readonly idempotencyKey: string;
}

type ClientEventFor<Events extends AnalyticsEventInputs> = {
  [Name in AnalyticsEventName<Events>]: AnalyticsClientEvent<Name, AnalyticsProperties<Events[Name]>>
}[AnalyticsEventName<Events>];

interface AnalyticsQueryRange {
  from: number;
  to: number;
  interval?: AnalyticsInterval;
}

type ListedAnalyticsProperty<Definition, Key extends "dimensions" | "measures"> =
  Definition extends Record<Key, readonly (infer Name)[]> ? Name & string : never;

export type AnalyticsQueryInput<Events extends AnalyticsEventInputs> = {
  [Name in AnalyticsEventName<Events>]: AnalyticsQueryRange & {
    event: Name;
    dimension?: ListedAnalyticsProperty<Events[Name], "dimensions">;
    measure?: ListedAnalyticsProperty<Events[Name], "measures">;
  }
}[AnalyticsEventName<Events>];

export interface AnalyticsSeriesPoint {
  readonly start: number;
  readonly end: number;
  /** Null means the cohort was smaller than the configured privacy threshold. */
  readonly count: number | null;
  readonly average: number | null;
}

export interface AnalyticsBreakdown {
  /** Null groups events whose optional dimension was omitted. */
  readonly value: string | number | boolean | null;
  readonly count: number;
  readonly average: number | null;
}

export interface AnalyticsQueryResult {
  readonly event: string;
  readonly from: number;
  readonly to: number;
  readonly interval: AnalyticsInterval;
  readonly sampleRate: number;
  readonly total: number | null;
  readonly average: number | null;
  readonly series: readonly AnalyticsSeriesPoint[];
  readonly breakdown: readonly AnalyticsBreakdown[];
  /** Events hidden from named dimension groups because their cohort was too small. */
  readonly withheld: number;
}

export interface AnalyticsFunnelResult {
  readonly funnel: string;
  readonly from: number;
  readonly to: number;
  readonly sampleRates: Readonly<Record<string, number>>;
  readonly steps: readonly {
    event: string;
    subjects: number | null;
    conversionFromFirst: number | null;
  }[];
  readonly scannedEvents: number;
}

export interface AnalyticsManifest {
  readonly protocol: "clank-analytics/1";
  readonly privacy: {
    readonly consentRequired: true;
    readonly rawIdentitiesStored: false;
    readonly rawEventsReadable: false;
    readonly minimumCohortSize: number;
    readonly maximumRetentionDays: number;
  };
  readonly events: Readonly<Record<string, {
    readonly description: string;
    readonly properties: Record<string, unknown>;
    readonly dimensions: readonly string[];
    readonly measures: readonly string[];
    readonly retentionDays: number;
    readonly sampleRate: number;
  }>>;
  readonly funnels: Readonly<Record<string, {
    readonly description: string;
    readonly steps: readonly string[];
    readonly withinMs: number;
  }>>;
}

export interface AnalyticsRuntime<Definition extends AnalyticsDefinition<any, any>> {
  readonly definition: Definition;
  readonly manifest: AnalyticsManifest;
  track<Name extends AnalyticsEventName<AnalyticsEventsOf<Definition>>>(
    name: Name,
    properties: AnalyticsProperties<AnalyticsEventsOf<Definition>[Name]>,
    context: AnalyticsTrackContext,
  ): AnalyticsTrackResult;
  ingest(
    events: readonly ClientEventFor<AnalyticsEventsOf<Definition>>[],
    context: Omit<AnalyticsTrackContext, "occurredAt" | "idempotencyKey">,
  ): readonly AnalyticsTrackResult[];
  query(input: AnalyticsQueryInput<AnalyticsEventsOf<Definition>>): AnalyticsQueryResult;
  funnel(name: keyof AnalyticsFunnelsOf<Definition> & string, input: { from: number; to: number }): AnalyticsFunnelResult;
  forgetSubject(input: { subject?: string; anonymousId?: string }): number;
  purge(now?: number): number;
  diagnostics(): { readonly storedEvents: number; readonly oldestAt: number | null; readonly newestAt: number | null };
}

export interface OpenAnalyticsOptions {
  /** Application secret used only to pseudonymize identities. At least 32 UTF-8 bytes. */
  identitySecret: string | Uint8Array;
  /** Aggregate groups below this unique-subject count are hidden. Defaults to 3. */
  minimumCohortSize?: number;
  /** Maximum rows one funnel query may scan. Defaults to 100,000. */
  maxFunnelScanEvents?: number;
  /** Hard per-application event capacity. Defaults to 1,000,000. */
  maxStoredEvents?: number;
  now?: () => number;
}

export async function openAnalytics<Definition extends AnalyticsDefinition<any, any>>(
  definition: Definition,
  database: { readonly [SQLITE_INTERNAL]: SQLiteInternal },
  options: OpenAnalyticsOptions,
): Promise<AnalyticsRuntime<Definition>> {
  if (!definition || typeof definition !== "object" || !definition.events || !definition.funnels) {
    throw new TypeError("openAnalytics() requires a definition returned by defineAnalytics().");
  }
  const internal = database?.[SQLITE_INTERNAL];
  if (!internal) throw new TypeError("openAnalytics() requires an open Clank SQLite database.");
  const secret = typeof options?.identitySecret === "string"
    ? new TextEncoder().encode(options.identitySecret)
    : options?.identitySecret instanceof Uint8Array
      ? new Uint8Array(options.identitySecret)
      : new Uint8Array();
  if (secret.byteLength < 32) throw new TypeError("analytics identitySecret must contain at least 32 UTF-8 bytes.");
  const minimumCohortSize = positiveInteger(options.minimumCohortSize ?? 3, "minimumCohortSize", 1, 100);
  const maxFunnelScanEvents = positiveInteger(options.maxFunnelScanEvents ?? 100_000, "maxFunnelScanEvents", 100, 1_000_000);
  const maxStoredEvents = positiveInteger(options.maxStoredEvents ?? 1_000_000, "maxStoredEvents", 1, 10_000_000);
  const now = options.now ?? Date.now;
  const moduleName = "node:crypto";
  const cryptoModule = await import(moduleName) as unknown as {
    createHmac(algorithm: string, key: unknown): { update(value: string): { digest(encoding: "base64url"): string } };
    createSecretKey(value: Uint8Array): unknown;
  };
  const key = cryptoModule.createSecretKey(secret);
  secret.fill(0);

  internal.exec(`CREATE TABLE IF NOT EXISTS clank_analytics_events (
    event_id INTEGER PRIMARY KEY,
    event_name TEXT NOT NULL CHECK (length(event_name) BETWEEN 3 AND 100),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > occurred_at),
    subject_key TEXT NOT NULL CHECK (length(subject_key) = 43),
    session_key TEXT CHECK (session_key IS NULL OR length(session_key) = 43),
    idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) = 43),
    properties_json TEXT NOT NULL CHECK (json_valid(properties_json) AND length(properties_json) <= ${MAX_PROPERTY_BYTES}),
    UNIQUE (event_name, idempotency_key)
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_analytics_events_time
    ON clank_analytics_events (event_name, occurred_at)`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_analytics_events_subject
    ON clank_analytics_events (subject_key, occurred_at)`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_analytics_events_expiry
    ON clank_analytics_events (expires_at)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_analytics_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    stored_events INTEGER NOT NULL CHECK (stored_events >= 0)
  )`);
  internal.prepare(`INSERT OR IGNORE INTO clank_analytics_state (singleton, stored_events)
    SELECT 1, COUNT(*) FROM clank_analytics_events`).run();

  const insert = internal.prepare(`INSERT OR IGNORE INTO clank_analytics_events
    (event_name, occurred_at, expires_at, subject_key, session_key, idempotency_key, properties_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const hmac = (domain: string, value: string): string => {
    const safe = boundedText(value, domain, 1, MAX_IDENTITY_LENGTH);
    return cryptoModule.createHmac("sha256", key).update(`${domain}\u0000${safe}`).digest("base64url");
  };

  const track = (name: string, properties: unknown, context: AnalyticsTrackContext): AnalyticsTrackResult => {
    const event = definition.events[name] as NormalizedAnalyticsEvent | undefined;
    if (!event) throw new TypeError(`Unknown analytics event: ${name}`);
    if (!context || context.consent !== "granted") return Object.freeze({ stored: false, reason: "consent" });
    if (context.doNotTrack === true) return Object.freeze({ stored: false, reason: "do_not_track" });
    const parsed = event.schema.parse(properties ?? {});
    const propertiesJson = JSON.stringify(parsed);
    if (propertiesJson === undefined || byteLength(propertiesJson) > MAX_PROPERTY_BYTES) {
      throw new TypeError(`Analytics event ${name} properties exceed ${MAX_PROPERTY_BYTES} bytes.`);
    }
    const current = finiteTimestamp(now(), "analytics clock");
    const occurredAt = context.occurredAt === undefined ? current : finiteTimestamp(context.occurredAt, "occurredAt");
    if (Math.abs(occurredAt - current) > MAX_CLOCK_SKEW) throw new TypeError("occurredAt must be within 24 hours of server time.");
    const identity = context.subject
      ? ["subject", context.subject] as const
      : context.anonymousId
        ? ["anonymous", context.anonymousId] as const
        : context.sessionId
          ? ["session", context.sessionId] as const
          : ["event", crypto.randomUUID()] as const;
    const subjectKey = hmac(identity[0], identity[1]);
    const samplingKey = hmac("sample", `${name}:${subjectKey}`);
    if (digestRatio(samplingKey) >= event.sampleRate) return Object.freeze({ stored: false, reason: "sampled" });
    const sessionKey = context.sessionId ? hmac("session", context.sessionId) : null;
    const idempotencyKey = context.idempotencyKey ? hmac("idempotency", context.idempotencyKey) : null;
    const write = () => {
      const expired = Number(internal.prepare("DELETE FROM clank_analytics_events WHERE expires_at <= ?").run(current).changes);
      if (expired) internal.prepare("UPDATE clank_analytics_state SET stored_events = MAX(0, stored_events - ?) WHERE singleton = 1").run(expired);
      const state = internal.prepare("SELECT stored_events FROM clank_analytics_state WHERE singleton = 1").get();
      if (!state || Number(state.stored_events) >= maxStoredEvents) return "capacity" as const;
      const result = insert.run(
        name,
        occurredAt,
        occurredAt + event.retentionDays * DAY,
        subjectKey,
        sessionKey,
        idempotencyKey,
        propertiesJson,
      );
      if (Number(result.changes) === 1) {
        internal.prepare("UPDATE clank_analytics_state SET stored_events = stored_events + 1 WHERE singleton = 1").run();
        return "stored" as const;
      }
      return "duplicate" as const;
    };
    const outcome = internal.inTransaction ? write() : internal.transaction(write);
    return outcome === "stored"
      ? Object.freeze({ stored: true })
      : Object.freeze({ stored: false, reason: outcome });
  };

  const manifest = analyticsManifest(definition, minimumCohortSize);
  return Object.freeze({
    definition,
    manifest,
    track,
    ingest(events, context) {
      if (!Array.isArray(events) || events.length > MAX_BATCH) {
        throw new TypeError(`Analytics batches cannot exceed ${MAX_BATCH} events.`);
      }
      const results: AnalyticsTrackResult[] = [];
      for (const [index, event] of events.entries()) {
        if (!event || typeof event !== "object") throw new TypeError(`Analytics batch event ${index} must be an object.`);
        results.push(track(event.name, event.properties, {
          ...context,
          occurredAt: event.occurredAt,
          idempotencyKey: event.idempotencyKey,
        }));
      }
      return Object.freeze(results);
    },
    query(input) {
      return queryAnalytics(definition, internal, input, minimumCohortSize, now());
    },
    funnel(name, input) {
      return queryFunnel(definition, internal, name, input, minimumCohortSize, maxFunnelScanEvents, now());
    },
    forgetSubject(input) {
      if (!input || (input.subject === undefined && input.anonymousId === undefined)) {
        throw new TypeError("forgetSubject() requires subject or anonymousId.");
      }
      const keys = [
        ...(input.subject === undefined ? [] : [hmac("subject", input.subject)]),
        ...(input.anonymousId === undefined ? [] : [hmac("anonymous", input.anonymousId)]),
      ];
      let removed = 0;
      for (const subjectKey of keys) {
        const erase = () => {
          const count = Number(internal.prepare("DELETE FROM clank_analytics_events WHERE subject_key = ?").run(subjectKey).changes);
          if (count) internal.prepare("UPDATE clank_analytics_state SET stored_events = MAX(0, stored_events - ?) WHERE singleton = 1").run(count);
          return count;
        };
        removed += internal.inTransaction ? erase() : internal.transaction(erase);
      }
      return removed;
    },
    purge(at = now()) {
      const timestamp = finiteTimestamp(at, "purge timestamp");
      const expire = () => {
        const count = Number(internal.prepare("DELETE FROM clank_analytics_events WHERE expires_at <= ?").run(timestamp).changes);
        if (count) internal.prepare("UPDATE clank_analytics_state SET stored_events = MAX(0, stored_events - ?) WHERE singleton = 1").run(count);
        return count;
      };
      return internal.inTransaction ? expire() : internal.transaction(expire);
    },
    diagnostics() {
      const row = internal.prepare(`SELECT COUNT(*) AS stored_events, MIN(occurred_at) AS oldest_at,
        MAX(occurred_at) AS newest_at FROM clank_analytics_events`).get()!;
      return Object.freeze({
        storedEvents: Number(row.stored_events),
        oldestAt: row.oldest_at === null ? null : Number(row.oldest_at),
        newestAt: row.newest_at === null ? null : Number(row.newest_at),
      });
    },
  }) as AnalyticsRuntime<Definition>;
}

export interface AnalyticsClientOptions<Definition extends AnalyticsDefinition<any, any>> {
  send(events: readonly ClientEventFor<AnalyticsEventsOf<Definition>>[]): Promise<void>;
  consent(): boolean;
  doNotTrack?: () => boolean;
  flushIntervalMs?: number;
  maxQueue?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface AnalyticsClient<Definition extends AnalyticsDefinition<any, any>> {
  track<Name extends AnalyticsEventName<AnalyticsEventsOf<Definition>>>(
    name: Name,
    properties: AnalyticsProperties<AnalyticsEventsOf<Definition>[Name]>,
  ): { readonly queued: boolean; readonly reason?: "consent" | "do_not_track" | "capacity" };
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly queued: number;
}

/**
 * Creates a memory-only batching client. The application owns transport and
 * resolves authenticated identity on the server; the browser never sends it.
 */
export function createAnalyticsClient<Definition extends AnalyticsDefinition<any, any>>(
  definition: Definition,
  options: AnalyticsClientOptions<Definition>,
): AnalyticsClient<Definition> {
  if (typeof options?.send !== "function" || typeof options?.consent !== "function") {
    throw new TypeError("createAnalyticsClient() requires send and consent functions.");
  }
  const flushIntervalMs = positiveInteger(options.flushIntervalMs ?? 2_000, "flushIntervalMs", 100, 60_000);
  const maxQueue = positiveInteger(options.maxQueue ?? 100, "maxQueue", 1, 1_000);
  const now = options.now ?? Date.now;
  const doNotTrack = options.doNotTrack ?? (() => typeof navigator !== "undefined" && navigator.doNotTrack === "1");
  const queue: ClientEventFor<AnalyticsEventsOf<Definition>>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;

  const schedule = () => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(report);
    }, flushIntervalMs);
    timer.unref?.();
  };
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Reporting cannot change delivery. */ }
  };
  const flush = async (): Promise<void> => {
    if (pending) return pending;
    if (!queue.length) return;
    if (!options.consent() || doNotTrack()) {
      queue.splice(0);
      return;
    }
    const batch = Object.freeze(queue.slice(0, MAX_BATCH));
    pending = Promise.resolve(options.send(batch)).then(() => {
      queue.splice(0, batch.length);
    }).finally(() => {
      pending = undefined;
      if (queue.length) schedule();
    });
    return pending;
  };

  return {
    track(name, properties) {
      if (closed) throw new Error("Analytics client is closed.");
      const event = definition.events[name] as NormalizedAnalyticsEvent | undefined;
      if (!event) throw new TypeError(`Unknown analytics event: ${String(name)}`);
      if (!options.consent()) return Object.freeze({ queued: false, reason: "consent" });
      if (doNotTrack()) return Object.freeze({ queued: false, reason: "do_not_track" });
      if (queue.length >= maxQueue) return Object.freeze({ queued: false, reason: "capacity" });
      const parsed = event.schema.parse(properties ?? {});
      const serialized = JSON.stringify(parsed);
      if (serialized === undefined || byteLength(serialized) > MAX_PROPERTY_BYTES) {
        throw new TypeError(`Analytics event ${String(name)} properties exceed ${MAX_PROPERTY_BYTES} bytes.`);
      }
      queue.push(Object.freeze({
        name,
        properties: parsed,
        occurredAt: finiteTimestamp(now(), "analytics clock"),
        idempotencyKey: crypto.randomUUID(),
      }) as ClientEventFor<AnalyticsEventsOf<Definition>>);
      if (queue.length >= MAX_BATCH) void flush().catch(report);
      else schedule();
      return Object.freeze({ queued: true });
    },
    flush,
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await flush();
    },
    get queued() { return queue.length; },
  };
}

function queryAnalytics(
  definition: AnalyticsDefinition<any, any>,
  internal: SQLiteInternal,
  input: AnalyticsQueryInput<any>,
  minimumCohortSize: number,
  now: number,
): AnalyticsQueryResult {
  if (!input || typeof input !== "object") throw new TypeError("analytics.query() requires an input object.");
  const event = definition.events[input.event] as NormalizedAnalyticsEvent | undefined;
  if (!event) throw new TypeError(`Unknown analytics event: ${String(input.event)}`);
  const range = queryRange(input.from, input.to, now);
  const interval = input.interval ?? "day";
  if (interval !== "hour" && interval !== "day" && interval !== "week") {
    throw new TypeError("Analytics interval must be hour, day, or week.");
  }
  const intervalMs = interval === "hour" ? HOUR : interval === "day" ? DAY : WEEK;
  const buckets = Math.ceil((range.to - range.from) / intervalMs);
  if (buckets > MAX_BUCKETS) throw new TypeError(`Analytics query cannot exceed ${MAX_BUCKETS} ${interval} buckets.`);
  const dimension = input.dimension === undefined ? undefined : propertyName(input.dimension, "analytics dimension");
  const measure = input.measure === undefined ? undefined : propertyName(input.measure, "analytics measure");
  if (dimension !== undefined && !event.dimensions.includes(dimension)) {
    throw new TypeError(`${input.event}.${dimension} is not a configured analytics dimension.`);
  }
  if (measure !== undefined && !event.measures.includes(measure)) {
    throw new TypeError(`${input.event}.${measure} is not a configured analytics measure.`);
  }
  const measureExpression = measure === undefined ? "NULL" : `AVG(json_extract(properties_json, ${sqlJsonPath(measure)}))`;
  const totalRow = internal.prepare(`SELECT COUNT(*) AS event_count, COUNT(DISTINCT subject_key) AS subjects,
    ${measureExpression} AS average FROM clank_analytics_events
    WHERE event_name = ? AND occurred_at >= ? AND occurred_at < ?`).get(input.event, range.from, range.to)!;
  const totalSubjects = Number(totalRow.subjects);
  const totalVisible = totalSubjects >= minimumCohortSize;
  const seriesRows = internal.prepare(`SELECT CAST((occurred_at - ?) / ? AS INTEGER) AS bucket,
    COUNT(*) AS event_count, COUNT(DISTINCT subject_key) AS subjects, ${measureExpression} AS average
    FROM clank_analytics_events WHERE event_name = ? AND occurred_at >= ? AND occurred_at < ?
    GROUP BY bucket ORDER BY bucket`).all(range.from, intervalMs, input.event, range.from, range.to);
  const byBucket = new Map(seriesRows.map((row) => [Number(row.bucket), row]));
  const series: AnalyticsSeriesPoint[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const row = byBucket.get(bucket);
    const subjects = Number(row?.subjects ?? 0);
    series.push(Object.freeze({
      start: range.from + bucket * intervalMs,
      end: Math.min(range.to, range.from + (bucket + 1) * intervalMs),
      count: row === undefined ? 0 : subjects >= minimumCohortSize ? Number(row.event_count) : null,
      average: subjects >= minimumCohortSize && row?.average !== null && row?.average !== undefined ? Number(row.average) : null,
    }));
  }
  let withheld = 0;
  const breakdown: AnalyticsBreakdown[] = [];
  if (dimension !== undefined) {
    const rows = internal.prepare(`SELECT json_extract(properties_json, ${sqlJsonPath(dimension)}) AS dimension_value,
      COUNT(*) AS event_count, COUNT(DISTINCT subject_key) AS subjects, ${measureExpression} AS average
      FROM clank_analytics_events WHERE event_name = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY dimension_value ORDER BY event_count DESC, CAST(dimension_value AS TEXT) LIMIT ${MAX_DIMENSION_VALUES + 1}`)
      .all(input.event, range.from, range.to);
    if (rows.length > MAX_DIMENSION_VALUES) throw new Error("Analytics dimension exceeded its declared cardinality bound.");
    for (const row of rows) {
      const count = Number(row.event_count);
      if (Number(row.subjects) < minimumCohortSize) {
        withheld += count;
        continue;
      }
      breakdown.push(Object.freeze({
        value: dimensionValue(row.dimension_value),
        count,
        average: row.average === null || row.average === undefined ? null : Number(row.average),
      }));
    }
  }
  return Object.freeze({
    event: input.event,
    from: range.from,
    to: range.to,
    interval,
    sampleRate: event.sampleRate,
    total: totalVisible ? Number(totalRow.event_count) : null,
    average: totalVisible && totalRow.average !== null ? Number(totalRow.average) : null,
    series: Object.freeze(series),
    breakdown: Object.freeze(breakdown),
    withheld,
  });
}

function queryFunnel(
  definition: AnalyticsDefinition<any, any>,
  internal: SQLiteInternal,
  name: string,
  input: { from: number; to: number },
  minimumCohortSize: number,
  maxScanEvents: number,
  now: number,
): AnalyticsFunnelResult {
  const funnel = definition.funnels[name] as NormalizedAnalyticsFunnel | undefined;
  if (!funnel) throw new TypeError(`Unknown analytics funnel: ${name}`);
  const range = queryRange(input?.from, input?.to, now);
  const placeholders = funnel.steps.map(() => "?").join(", ");
  const rows = internal.prepare(`SELECT subject_key, event_name, occurred_at FROM clank_analytics_events
    WHERE event_name IN (${placeholders}) AND occurred_at >= ? AND occurred_at < ?
    ORDER BY subject_key, occurred_at, event_id LIMIT ?`).all(...funnel.steps, range.from, range.to, maxScanEvents + 1);
  if (rows.length > maxScanEvents) throw new Error(`Analytics funnel exceeds the ${maxScanEvents}-event scan bound.`);
  const reached = new Array<number>(funnel.steps.length).fill(0);
  let currentSubject = "";
  let nextStep = 0;
  let startedAt = 0;
  const finish = () => {
    for (let index = 0; index < nextStep; index += 1) reached[index] += 1;
  };
  for (const row of rows) {
    const subject = String(row.subject_key);
    if (subject !== currentSubject) {
      if (currentSubject) finish();
      currentSubject = subject;
      nextStep = 0;
      startedAt = 0;
    }
    const event = String(row.event_name);
    const occurredAt = Number(row.occurred_at);
    if (nextStep < funnel.steps.length && event === funnel.steps[0]) {
      nextStep = 1;
      startedAt = occurredAt;
      continue;
    }
    if (nextStep > 0 && nextStep < funnel.steps.length && event === funnel.steps[nextStep]) {
      if (occurredAt - startedAt <= funnel.withinMs) nextStep += 1;
      else if (event === funnel.steps[0]) {
        nextStep = 1;
        startedAt = occurredAt;
      } else {
        nextStep = 0;
        startedAt = 0;
      }
    }
  }
  if (currentSubject) finish();
  const firstVisible = reached[0] >= minimumCohortSize;
  const steps = funnel.steps.map((event, index) => {
    const visible = reached[index] >= minimumCohortSize;
    return Object.freeze({
      event,
      subjects: visible ? reached[index] : null,
      conversionFromFirst: visible && firstVisible ? reached[index] / reached[0] : null,
    });
  });
  return Object.freeze({
    funnel: name,
    from: range.from,
    to: range.to,
    sampleRates: Object.freeze(Object.fromEntries(funnel.steps.map((event) => [event, definition.events[event].sampleRate]))),
    steps: Object.freeze(steps),
    scannedEvents: rows.length,
  });
}

function analyticsManifest(definition: AnalyticsDefinition<any, any>, minimumCohortSize: number): AnalyticsManifest {
  const events = Object.fromEntries(Object.entries(definition.events).map(([name, event]) => [name, Object.freeze({
    description: event.description,
    properties: event.schema.toJSONSchema(),
    dimensions: event.dimensions,
    measures: event.measures,
    retentionDays: event.retentionDays,
    sampleRate: event.sampleRate,
  })]));
  const funnels = Object.fromEntries(Object.entries(definition.funnels).map(([name, funnel]) => [name, Object.freeze({
    description: funnel.description,
    steps: funnel.steps,
    withinMs: funnel.withinMs,
  })]));
  return deepFreeze({
    protocol: "clank-analytics/1",
    privacy: {
      consentRequired: true,
      rawIdentitiesStored: false,
      rawEventsReadable: false,
      minimumCohortSize,
      maximumRetentionDays: MAX_RETENTION_DAYS,
    },
    events,
    funnels,
  }) as AnalyticsManifest;
}

function validatePropertySchema(json: Record<string, unknown>, path: string): void {
  const optional = json.optional;
  const schema = { ...json };
  delete schema.optional;
  if (schema.format !== undefined) throw new TypeError(`Analytics property ${path} cannot use identity-bearing formatted strings.`);
  if (schema.type === "boolean" || schema.const !== undefined) return;
  if (schema.type === "string") {
    if (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > MAX_DIMENSION_VALUES) {
      throw new TypeError(`Analytics string property ${path} must use s.enum() with at most ${MAX_DIMENSION_VALUES} values.`);
    }
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (!Number.isFinite(schema.minimum) || !Number.isFinite(schema.maximum)) {
      throw new TypeError(`Analytics numeric property ${path} must declare finite min and max bounds.`);
    }
    if (Number(schema.minimum) >= Number(schema.maximum)) {
      throw new TypeError(`Analytics numeric property ${path} must have a minimum below its maximum.`);
    }
    return;
  }
  throw new TypeError(`Analytics property ${path} must be an enum, boolean, literal, or bounded number${optional ? " (optional is supported)" : ""}.`);
}

function validateDimensionSchema(json: Record<string, unknown>, path: string): void {
  const schema = { ...json };
  delete schema.optional;
  if (schema.type === "boolean" || schema.const !== undefined) return;
  if (schema.type === "string" && Array.isArray(schema.enum) && schema.enum.length <= MAX_DIMENSION_VALUES) return;
  throw new TypeError(`Analytics dimension ${path} must be an enum, boolean, or literal property.`);
}

function validateMeasureSchema(json: Record<string, unknown>, path: string): void {
  const schema = { ...json };
  delete schema.optional;
  if ((schema.type === "number" || schema.type === "integer") && Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum)) return;
  throw new TypeError(`Analytics measure ${path} must be a bounded numeric property.`);
}

function uniqueProperties(values: readonly string[], properties: SchemaShape, path: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array.`);
  const output: string[] = [];
  for (const value of values) {
    const name = propertyName(value, path);
    if (!Object.hasOwn(properties, name)) throw new TypeError(`${path} references unknown property ${name}.`);
    if (output.includes(name)) throw new TypeError(`${path} contains duplicate property ${name}.`);
    output.push(name);
  }
  return output;
}

function queryRange(fromInput: unknown, toInput: unknown, nowInput: number): { from: number; to: number } {
  const current = finiteTimestamp(nowInput, "analytics clock");
  const from = finiteTimestamp(fromInput, "from");
  const to = finiteTimestamp(toInput, "to");
  if (from >= to) throw new TypeError("Analytics query from must be before to.");
  if (to > current + MAX_CLOCK_SKEW) throw new TypeError("Analytics query cannot extend more than 24 hours into the future.");
  if (to - from > MAX_RETENTION_DAYS * DAY) throw new TypeError(`Analytics queries cannot exceed ${MAX_RETENTION_DAYS} days.`);
  return { from, to };
}

function sqlJsonPath(property: string): string {
  return `'$."${property}"'`;
}

function dimensionValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Stored analytics dimension violates its declared schema.");
}

function digestRatio(digest: string): number {
  const bytes = base64UrlDecode(digest.slice(0, 11));
  let value = 0;
  for (const byte of bytes.slice(0, 6)) value = value * 256 + byte;
  return value / 281_474_976_710_656;
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function finiteTimestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} must be a non-negative millisecond timestamp.`);
  return value;
}

function positiveInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function eventName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})+$/u.test(value) || value.length > 100) {
    throw new TypeError(`Invalid analytics event name: ${value}. Use a namespaced name such as todo.created.`);
  }
  return value;
}

function propertyName(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) {
    throw new TypeError(`${path} must use lower-case identifier property names.`);
  }
  return value;
}

function identifier(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]*$/u.test(value) || value.length > maximum) {
    throw new TypeError(`Invalid ${path}: ${String(value)}.`);
  }
  return value;
}

function boundedText(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} must be ${minimum}-${maximum} safe text characters.`);
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const SENSITIVE_PROPERTY = /(?:^|_)(?:id|uuid|email|phone|name|address|password|secret|token|key|cookie|authorization|content|body|message|query|search|title|description|url|uri|ip|user_agent)(?:_|$)/iu;
const MAX_EVENTS = 500;
const MAX_PROPERTIES = 32;
const MAX_FUNNELS = 100;
const MAX_FUNNEL_STEPS = 20;
const MAX_DIMENSION_VALUES = 100;
const MAX_PROPERTY_BYTES = 4 * 1024;
const MAX_IDENTITY_LENGTH = 512;
const MAX_RETENTION_DAYS = 400;
const MAX_CLOCK_SKEW = 24 * 60 * 60 * 1_000;
const MAX_BUCKETS = 400;
const MAX_BATCH = 25;
const MIN_SAMPLE_RATE = 0.001;
const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
