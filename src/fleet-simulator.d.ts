import type { LinuxHostCertificationOptions } from "./host-certification.js";
export type LocalProviderFleetScenarioKind = "takeover" | "lease-loss" | "slow-transport" | "disk-read-only" | "coordinator-restart" | "provider-restart";
export interface LocalProviderFleetScenario {
    readonly protocol: "clank-fleet-scenario/1";
    readonly kind: LocalProviderFleetScenarioKind;
    readonly nodeTtlMs?: number;
    readonly operationLeaseMs?: number;
    readonly transportDelayMs?: number;
}
export interface LocalProviderFleetOptions {
    readonly certificate: LinuxHostCertificationOptions;
    readonly scenario: LocalProviderFleetScenario;
    readonly disposable: true;
    /** Two explicitly reserved, unused XFS project IDs. */
    readonly quotaIds: readonly [number, number];
    /** Ten unused local application ports beginning at this value. */
    readonly portStart: number;
    readonly signal?: AbortSignal;
}
export interface LocalProviderFleetEvent {
    readonly sequence: number;
    readonly elapsedMs: number;
    readonly node: "coordinator" | "node-a" | "node-b" | "fleet";
    readonly event: "started" | "claimed" | "executed" | "failed" | "desired" | "fault" | "restored" | "stale-rejected" | "stopped";
    readonly generation?: number;
    readonly fence?: number;
}
export interface LocalProviderFleetReport {
    readonly protocol: "clank-fleet-report/1";
    readonly scenario: Readonly<Required<LocalProviderFleetScenario>>;
    readonly status: "passed" | "blocked";
    readonly reason: "verified" | "certification-required" | "aborted" | "scenario-failed" | "cleanup-failed";
    readonly artifactSha256: string | null;
    readonly checks: readonly {
        readonly name: "host" | "processes" | "baseline" | "fault" | "recovery" | "fences" | "cleanup";
        readonly status: "passed" | "blocked";
    }[];
    readonly timeline: readonly LocalProviderFleetEvent[];
}
/** Captures a bounded, portable scenario. No host paths or secrets belong here. */
export declare function parseLocalProviderFleetScenario(input: unknown): Readonly<Required<LocalProviderFleetScenario>>;
/** Deterministic scenario export; excludes operator configuration and private reports. */
export declare function exportLocalProviderFleetScenario(input: LocalProviderFleetScenario): string;
/** Runs only fixed synthetic drills on a currently certified disposable Linux host. */
export declare function runLocalProviderFleetScenario(options: LocalProviderFleetOptions): Promise<LocalProviderFleetReport>;
