import type { SQLiteInternal } from "./sqlite-internal.js";
export interface PlatformSupervisorOptions {
    readonly configurationId: string;
    readonly configurationRevision: number;
    readonly leaseMs?: number;
    readonly pollIntervalMs?: number;
}
export interface PlatformSupervisorStatus {
    readonly state: "standby" | "starting" | "leader" | "closing" | "closed" | "fenced";
    readonly epoch: number;
    readonly expiresAt: number;
    readonly responsibilities: readonly string[];
}
export declare class PlatformSupervisorError extends Error {
    readonly name = "PlatformSupervisorError";
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function normalizeSupervisorOptions(input: PlatformSupervisorOptions): Required<PlatformSupervisorOptions>;
/** @internal Native server-held authority; serialized status is not a capability. */
export interface SupervisorLease {
    readonly options: Required<PlatformSupervisorOptions>;
    readonly databasePath: string;
    readonly owner: string;
    readonly processBirth: string;
    acquire(): boolean;
    renew(): void;
    assertCurrent(connection?: Pick<SQLiteInternal, "prepare">): undefined;
    status(state: PlatformSupervisorStatus["state"]): PlatformSupervisorStatus;
    release(): boolean;
    close(): void;
    guardianIdentity(): Readonly<{ epoch: number; owner: string; tokenHash: string; configurationRevision: number; configurationId: string; controllerPid: number; controllerBirth: string }>;
}
export declare function linuxProcessBirth(pid: number): Promise<string>;
export declare function openSupervisorLease(databasePath: string, input: PlatformSupervisorOptions): Promise<SupervisorLease>;
export declare function waitForSupervisorCleanup(root: string, lease: SupervisorLease): Promise<void>;
export declare function armSupervisorGuardian(root: string, lease: SupervisorLease): Promise<{ stop(): Promise<void> }>;
