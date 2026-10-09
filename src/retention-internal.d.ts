import type { AuthRequest } from "./auth.js";
import { type SQLiteInternal } from "./sqlite-internal.js";
import type { RetentionAdministrationOptions, RetentionHold, RetentionInventory, RetentionKind, RetentionPurgeReceipt, RetentionPurgeSelection, RetentionResourceRef, RetentionSchedule } from "./retention-administration.js";
export interface RetentionControllerOptions extends Omit<RetentionAdministrationOptions, "path" | "auth" | "sources" | "schema" | "prefix"> {
    native: SQLiteInternal;
    kinds: readonly RetentionKind[];
    refresh(userId: string, sessionId: string): AuthRequest<any> | null;
}
/** Private controller: called inside the host's existing SQLite/auth boundary. */
export declare function createRetentionController(options: RetentionControllerOptions): Promise<{
    inventory: (auth: AuthRequest<any>, input: {
        scope: string;
        kinds: readonly RetentionKind[];
        after?: string;
        limit: number;
    }) => RetentionInventory;
    preview: (auth: AuthRequest<any>, selection: RetentionPurgeSelection) => {
        digest: string;
        resources: {
            kind: RetentionKind;
            id: string;
        }[];
        protocol: "clank-retention/1";
        policyRevision: string;
        holdRevision: number;
        items: (RetentionResourceRef & {
            readonly records: number;
            readonly bytes: number;
            readonly blocked: "held" | "active" | "unacknowledged" | null;
        })[];
        records: number;
        bytes: number;
        scope: string;
        cutoff: number;
        maxDeletes: number;
    };
    accept: (auth: AuthRequest<any>, encoded: string, operationId: string) => RetentionPurgeReceipt;
    hold: (auth: AuthRequest<any>, input: {
        scope: string;
        resource: RetentionResourceRef;
        expectedVersion: number;
        reason: string;
        expiresAt: number | null;
        operationId: string;
    }) => RetentionHold;
    release: (auth: AuthRequest<any>, input: {
        scope: string;
        resource: RetentionResourceRef;
        expectedVersion: number;
        operationId: string;
    }) => null;
    schedules: (auth: AuthRequest<any>, scope: string) => RetentionSchedule[];
    saveSchedule: (auth: AuthRequest<any>, encoded: string, operationId: string) => RetentionSchedule;
    runDue: () => number;
    start: () => void;
    close(): void;
}>;
/** Shared wire allowlist; platform keeps its browser auth and CSRF middleware. */
export declare function dispatchRetention(controller: Awaited<ReturnType<typeof createRetentionController>>, auth: AuthRequest<any>, operation: string, method: string, input: any): unknown;
