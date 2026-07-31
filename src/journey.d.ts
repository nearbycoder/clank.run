import type { AgentNode, AgentSurface } from "./ai.js";
export interface JourneyExpectation {
    target?: string;
    url?: string;
    text?: string;
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
    readonly env: string;
}
export type JourneyInputValue = string | number | boolean | readonly string[] | JourneySecretReference;
export type JourneyStep = Readonly<{ visit: string }>
    | Readonly<{ input: { target: string; value: JourneyInputValue } }>
    | Readonly<{ activate: string }>
    | Readonly<{ expect: JourneyExpectation }>
    | Readonly<{ wait: JourneyExpectation & { timeoutMs?: number } }>
    | Readonly<{ inspect: string }>;
export interface JourneyDefinition {
    readonly protocol: "clank-journey/1";
    readonly name: string;
    readonly description?: string;
    readonly start: string;
    readonly viewport: Readonly<{ width: number; height: number }>;
    readonly steps: readonly JourneyStep[];
}
export interface JourneyInput {
    name: string;
    description?: string;
    start?: string;
    viewport?: { width: number; height: number };
    steps: readonly JourneyStep[];
}
export interface JourneyDriver {
    navigate(url: string): void | Promise<void>;
    currentUrl(): string | Promise<string>;
    inspect(): readonly AgentNode[] | Promise<readonly AgentNode[]>;
    activate(id: string): boolean | Promise<boolean>;
    input(id: string, value: string | number | boolean | readonly string[], options?: Readonly<{ secret: boolean }>): boolean | Promise<boolean>;
    visibleText(): string | Promise<string>;
    settle(): void | Promise<void>;
    setViewport?(viewport: { width: number; height: number }): void | Promise<void>;
}
export interface JourneyStepReport {
    readonly index: number;
    readonly kind: "visit" | "input" | "activate" | "expect" | "wait" | "inspect";
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
    timeoutMs?: number;
    signal?: AbortSignal;
    resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
    onStep?: (report: JourneyStepReport) => void;
}
export declare function defineJourney(input: JourneyInput): JourneyDefinition;
export declare function runJourney(journey: JourneyDefinition, driver: JourneyDriver, options: RunJourneyOptions): Promise<JourneyReport>;
export declare function createDomJourneyDriver(windowObject: Window, surface: AgentSurface): JourneyDriver;
