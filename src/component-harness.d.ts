import { type Schema } from "./ai.js";
import { type Cleanup } from "./core.js";
import { type Renderable } from "./dom.js";
import { type HydrationDiagnostic } from "./hydration-inspection.js";
import { type JourneyExpectation, type JourneyInput, type JourneyReport } from "./journey.js";
import { type UiManifest } from "./ui-foundation.js";
declare const SPECIMEN: unique symbol;
export interface ComponentSpecimen<Props extends Record<string, unknown> = Record<string, unknown>> {
    readonly [SPECIMEN]: Props;
    readonly protocol: "clank-component-specimen/1";
    readonly name: string;
    readonly label: string;
    readonly revision: string;
}
export interface ComponentSpecimenInstance {
    readonly view: Renderable;
    readonly manifest: () => UiManifest;
    readonly dispose: Cleanup;
}
export interface ComponentSpecimenInput<Props extends Record<string, unknown>> {
    readonly name: string;
    readonly label?: string;
    readonly revision: string;
    readonly props: Schema<Props>;
    readonly value: Props;
    /** Runs inside the renderer's component scope, including during SSR. */
    readonly create: (props: Readonly<Props>) => ComponentSpecimenInstance;
    /** Part names from the manifest mapped to persistent semantic fixture targets. */
    readonly parts: Readonly<Record<string, string>>;
    readonly assertions: readonly JourneyExpectation[];
    readonly journeys: readonly JourneyInput[];
}
export interface ComponentSpecimenSnapshot {
    readonly protocol: "clank-component-snapshot/1";
    readonly name: string;
    readonly fingerprint: string;
    readonly contract: UiManifest;
}
export interface ComponentHarnessSnapshot {
    readonly protocol: "clank-component-harness/1";
    readonly name: string;
    readonly phase: "hydrated" | "mounted" | "disposed";
    readonly generation: number;
    readonly instancesCreated: number;
    readonly instancesDisposed: number;
    readonly contract: UiManifest | null;
    readonly hydration: readonly HydrationDiagnostic[];
    readonly truncated: boolean;
}
export interface ComponentHarness {
    snapshot(): ComponentHarnessSnapshot;
    reset(): void;
    select(specimen: ComponentSpecimen<any>): void;
    /** Reads current semantic/part state; full keyboard journeys run through Chrome. */
    check(): Promise<JourneyReport | null>;
    exportAssertions(): string;
    dispose(): void;
}
/** Captures a typed, bounded disposable fixture and its data-only journeys. */
export declare function defineComponentSpecimen<Props extends Record<string, unknown>>(input: ComponentSpecimenInput<Props>): ComponentSpecimen<Props>;
/** Deterministic, CLI-compatible assertion suite; excludes fixture props and timing data. */
export declare function exportComponentAssertions(specimen: ComponentSpecimen<any>): string;
/** SSR executes the same instance factory inside an owned render scope and releases it. */
export declare function renderComponentSpecimen(specimen: ComponentSpecimen<any>): Promise<{
    readonly html: string;
    readonly snapshot: ComponentSpecimenSnapshot;
}>;
/** Mount one isolated specimen in a dedicated document. Reset/select release the prior instance. */
export declare function mountComponentSpecimen(root: HTMLElement, specimen: ComponentSpecimen<any>): ComponentHarness;
/** Validate a detached SSR snapshot before attaching. Abort permits cancellation while hashing. */
export declare function hydrateComponentSpecimen(root: HTMLElement, specimen: ComponentSpecimen<any>, snapshot: ComponentSpecimenSnapshot, options?: {
    readonly signal?: AbortSignal;
}): Promise<ComponentHarness>;
/** Plain native controls for switching/resetting specimens and reviewing/exporting assertions. */
export declare function mountComponentHarnessControls(container: HTMLElement, harness: ComponentHarness, specimens: readonly ComponentSpecimen<any>[]): Cleanup;
export {};
