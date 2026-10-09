import type { AgentNode, AgentSurface } from "./ai.js";
export interface JourneyExpectation {
    /** Exact semantic ID of the currently focused native element. */
    focused?: string;
    /** Require the document's measured scroll width to fit its client width. */
    noHorizontalOverflow?: true;
    /** Stable agentId or native element ID that must be present. */
    target?: string;
    /** Exact path and query, or an absolute URL on the configured application origin. */
    url?: string;
    /** Normalized visible page text that must be present. */
    text?: string;
    /** Semantic state asserted against the target. */
    state?: Readonly<{
        label?: string;
        role?: string;
        checked?: boolean;
        expanded?: boolean;
        disabled?: boolean;
        readonly?: boolean;
        invalid?: boolean;
        value?: string | readonly string[];
    }>;
}
export interface JourneySecretReference {
    /** Environment-style secret name resolved only while the journey runs. */
    readonly env: string;
}
export type JourneyInputValue = string | number | boolean | readonly string[] | JourneySecretReference;
export type JourneyKey = "Tab" | "Shift+Tab" | "Enter" | "Space" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown";
export type JourneyStep = Readonly<{
    visit: string;
}> | Readonly<{
    input: {
        target: string;
        value: JourneyInputValue;
    };
}> | Readonly<{
    activate: string;
}> | Readonly<{
    focus: string;
}> | Readonly<{
    press: JourneyKey;
}> | Readonly<{
    expect: JourneyExpectation;
}> | Readonly<{
    wait: JourneyExpectation & {
        timeoutMs?: number;
    };
}> | Readonly<{
    inspect: string;
}>;
export interface JourneyDefinition {
    readonly protocol: "clank-journey/1";
    readonly name: string;
    readonly description?: string;
    readonly start: string;
    readonly viewport: Readonly<{
        width: number;
        height: number;
    }>;
    readonly steps: readonly JourneyStep[];
}
export interface JourneyInput {
    name: string;
    description?: string;
    /** Relative start path. Defaults to /. */
    start?: string;
    viewport?: {
        width: number;
        height: number;
    };
    steps: readonly JourneyStep[];
}
export interface JourneyDriver {
    /** Native focus; optional for legacy journeys. */
    focus?(id: string): boolean | Promise<boolean>;
    /** Native browser input dispatch. Synthetic KeyboardEvent dispatch is insufficient. */
    press?(key: JourneyKey): void | Promise<void>;
    focusedTarget?(): string | undefined | Promise<string | undefined>;
    layout?(): Readonly<{
        clientWidth: number;
        scrollWidth: number;
    }> | Promise<Readonly<{
        clientWidth: number;
        scrollWidth: number;
    }>>;
    navigate(url: string): void | Promise<void>;
    currentUrl(): string | Promise<string>;
    inspect(): readonly AgentNode[] | Promise<readonly AgentNode[]>;
    activate(id: string): boolean | Promise<boolean>;
    input(id: string, value: string | number | boolean | readonly string[], options?: Readonly<{
        secret: boolean;
    }>): boolean | Promise<boolean>;
    visibleText(): string | Promise<string>;
    /** Wait for browser navigation, hydration, and queued DOM work to settle. */
    settle(): void | Promise<void>;
    setViewport?(viewport: {
        width: number;
        height: number;
    }): void | Promise<void>;
}
export interface JourneyStepReport {
    readonly index: number;
    readonly kind: "visit" | "input" | "activate" | "focus" | "press" | "expect" | "wait" | "inspect";
    readonly target?: string;
    readonly label?: string;
    readonly status: "passed" | "failed";
    readonly durationMs: number;
    readonly message?: string;
    readonly surface?: readonly AgentNode[];
}
export interface JourneyReport {
    readonly protocol: "clank-journey-report/1";
    readonly name: string;
    readonly ok: boolean;
    readonly origin: string;
    readonly path: string;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly steps: readonly JourneyStepReport[];
    readonly error?: string;
    readonly surface?: readonly AgentNode[];
}
export interface RunJourneyOptions {
    baseUrl: string;
    /** Overall timeout. Defaults to 2 minutes and is capped at 10 minutes. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Resolves secret references at execution time. Secret values never enter the report. */
    resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
    onStep?: (report: JourneyStepReport) => void;
}
/** Validates and snapshots a data-only browser journey contract. */
export declare function defineJourney(input: JourneyInput): JourneyDefinition;
/** Executes a journey through a real or test browser driver and returns a redacted report. */
export declare function runJourney(journey: JourneyDefinition, driver: JourneyDriver, options: RunJourneyOptions): Promise<JourneyReport>;
/** Adapts the current browser document to the journey driver contract. */
export declare function createDomJourneyDriver(windowObject: Window, surface: AgentSurface): JourneyDriver;
