import { type InferSchemaShape, type Schema, type SchemaShape } from "./ai.js";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.js";

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
export type AnalyticsProperties<Definition> = Definition extends AnalyticsEventInput<infer Properties> ? InferSchemaShape<Properties> : never;
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

export interface AnalyticsDefinition<Events extends AnalyticsEventInputs = AnalyticsEventInputs, Funnels extends AnalyticsFunnelInputs<AnalyticsEventName<Events>> = AnalyticsFunnelInputs<AnalyticsEventName<Events>>> {
    readonly events: { readonly [Name in keyof Events]: NormalizedAnalyticsEvent<AnalyticsPropertyShape<Events[Name]>> };
    readonly funnels: { readonly [Name in keyof Funnels]: NormalizedAnalyticsFunnel<AnalyticsEventName<Events>> };
}

export type AnalyticsEventsOf<Definition> = Definition extends AnalyticsDefinition<infer Events, any> ? Events : never;
export type AnalyticsFunnelsOf<Definition> = Definition extends AnalyticsDefinition<any, infer Funnels> ? Funnels : never;

export declare function defineAnalytics<const Events extends AnalyticsEventInputs, const Funnels extends AnalyticsFunnelInputs<AnalyticsEventName<Events>> = {}>(input: {
    events: Events;
    funnels?: Funnels;
}): AnalyticsDefinition<Events, Funnels>;

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
    [Name in AnalyticsEventName<Events>]: AnalyticsClientEvent<Name, AnalyticsProperties<Events[Name]>>;
}[AnalyticsEventName<Events>];

interface AnalyticsQueryRange {
    from: number;
    to: number;
    interval?: AnalyticsInterval;
}

type ListedAnalyticsProperty<Definition, Key extends "dimensions" | "measures"> = Definition extends Record<Key, readonly (infer Name)[]> ? Name & string : never;

export type AnalyticsQueryInput<Events extends AnalyticsEventInputs> = {
    [Name in AnalyticsEventName<Events>]: AnalyticsQueryRange & {
        event: Name;
        dimension?: ListedAnalyticsProperty<Events[Name], "dimensions">;
        measure?: ListedAnalyticsProperty<Events[Name], "measures">;
    };
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
    track<Name extends AnalyticsEventName<AnalyticsEventsOf<Definition>>>(name: Name, properties: AnalyticsProperties<AnalyticsEventsOf<Definition>[Name]>, context: AnalyticsTrackContext): AnalyticsTrackResult;
    ingest(events: readonly ClientEventFor<AnalyticsEventsOf<Definition>>[], context: Omit<AnalyticsTrackContext, "occurredAt" | "idempotencyKey">): readonly AnalyticsTrackResult[];
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

export declare function openAnalytics<Definition extends AnalyticsDefinition<any, any>>(definition: Definition, database: {
    readonly [SQLITE_INTERNAL]: SQLiteInternal;
}, options: OpenAnalyticsOptions): Promise<AnalyticsRuntime<Definition>>;

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
    track<Name extends AnalyticsEventName<AnalyticsEventsOf<Definition>>>(name: Name, properties: AnalyticsProperties<AnalyticsEventsOf<Definition>[Name]>): {
        readonly queued: boolean;
        readonly reason?: "consent" | "do_not_track" | "capacity";
    };
    flush(): Promise<void>;
    close(): Promise<void>;
    readonly queued: number;
}

/** Creates a memory-only batching client. Identity is always resolved by the application server. */
export declare function createAnalyticsClient<Definition extends AnalyticsDefinition<any, any>>(definition: Definition, options: AnalyticsClientOptions<Definition>): AnalyticsClient<Definition>;

export {};
