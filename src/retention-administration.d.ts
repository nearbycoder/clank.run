import { type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export type RetentionKind = "import" | "collaboration" | "audit";
export type RetentionOperation = "read" | "purge" | "hold" | "schedule";
export interface RetentionResourceRef {
    readonly kind: RetentionKind;
    readonly id: string;
}
/** Trusted source identifiers used by the server's scope resolver. */
export interface RetentionResourceIdentity extends RetentionResourceRef {
    readonly ownerId?: string;
    readonly organizationId?: string | null;
    readonly projectId?: string | null;
}
export interface RetentionHold {
    readonly active: boolean;
    readonly version: number;
    readonly reason: string;
    readonly expiresAt: number | null;
}
export interface RetentionResource extends RetentionResourceRef {
    readonly state: string;
    readonly version: number;
    readonly createdAt: number;
    readonly payloadRows: number;
    readonly payloadBytes: number;
    readonly receiptRows: number;
    readonly receiptBytes: number;
    readonly historyRows: number;
    readonly historyBytes: number;
    readonly identityRows: number;
    /** Subset retained by the initial policy: current text/branches, metadata and identities. */
    readonly protectedRows: number;
    readonly protectedBytes: number;
    readonly hold: RetentionHold | null;
}
export interface RetentionInventory {
    readonly scope: string;
    readonly resources: readonly RetentionResource[];
    readonly next: string | null;
}
export interface RetentionPurgeSelection {
    readonly scope: string;
    readonly resources: readonly RetentionResourceRef[];
    readonly cutoff: number;
    readonly maxDeletes: number;
}
export interface RetentionPurgePreview extends RetentionPurgeSelection {
    readonly protocol: "clank-retention/1";
    readonly policyRevision: string;
    readonly holdRevision: number;
    readonly items: readonly (RetentionResourceRef & {
        readonly records: number;
        readonly bytes: number;
        readonly blocked: "held" | "active" | "unacknowledged" | null;
    })[];
    readonly records: number;
    readonly bytes: number;
    readonly digest: string;
}
export interface RetentionPurgeReceipt {
    readonly operationId: string;
    readonly scope: string;
    readonly records: number;
    readonly bytes: number;
    readonly acceptedAt: number;
}
export interface RetentionScheduleInput {
    readonly id: string;
    readonly scope: string;
    readonly expectedVersion: number;
    readonly kinds: readonly RetentionKind[];
    readonly olderThanMs: number;
    readonly everyMs: number;
    readonly maxDeletes: number;
    readonly state: "active" | "paused";
}
export interface RetentionSchedule extends Omit<RetentionScheduleInput, "expectedVersion"> {
    readonly version: number;
    readonly nextAt: number;
    readonly lastAt: number | null;
    readonly lastReceipt: RetentionPurgeReceipt | null;
    readonly error: string | null;
}
export interface RetentionAdministrationOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
    path: string;
    auth: AuthDefinition<any>;
    schema?: Schema;
    prefix?: string;
    sources: {
        imports?: boolean;
        collaboration?: {
            maxCharacters?: number;
        };
    };
    /** Change this whenever the trusted resolver/operator policy changes. */
    policyRevision: string;
    scope(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<Schema>;
    }, resource: RetentionResourceIdentity): string | null;
    authorize(context: {
        auth: AuthRequest<any>;
        db: ReadDatabase<Schema>;
    }, scope: string, operation: RetentionOperation): boolean;
    maxResources?: number;
    maxReceipts?: number;
    maxReceiptBytes?: number;
    maxHolds?: number;
    maxSchedules?: number;
    /** Background runner is opt-in; runDue can also be called by an existing trusted job. */
    intervalMs?: number | false;
}
export interface RetentionAdministrationService {
    handle(request: Request): Promise<Response>;
    runDue(): number;
    start(): void;
    close(): void;
}
export interface RetentionAdministrationClient {
    inventory(scope: string, options?: {
        kinds?: readonly RetentionKind[];
        after?: string;
        limit?: number;
    }): Promise<RetentionInventory>;
    preview(selection: RetentionPurgeSelection): Promise<RetentionPurgePreview>;
    accept(preview: RetentionPurgePreview, operationId: string): Promise<RetentionPurgeReceipt>;
    hold(scope: string, resource: RetentionResourceRef, expectedVersion: number, reason: string, expiresAt: number | null, operationId: string): Promise<RetentionHold>;
    release(scope: string, resource: RetentionResourceRef, expectedVersion: number, operationId: string): Promise<null>;
    schedules(scope: string): Promise<readonly RetentionSchedule[]>;
    saveSchedule(input: RetentionScheduleInput, operationId: string): Promise<RetentionSchedule>;
}
/** Per-database reviewed retirement with durable holds and freshly authorized schedules. */
export declare function openRetentionAdministration<Schema extends DatabaseSchema<any>>(options: RetentionAdministrationOptions<Schema>): Promise<RetentionAdministrationService>;
export declare function createRetentionAdministrationClient(options?: SyncClientOptions): RetentionAdministrationClient;
export interface RetentionAdministrationWidgetOptions {
    client: RetentionAdministrationClient;
    scope(): string | null;
    currentUser(): string | null;
    kinds?: readonly RetentionKind[];
    maxDeletes?: number;
}
/** Operator inventory, explicit batch review, holds and periodic cleanup rules. */
export declare function mountRetentionAdministration(root: HTMLElement, options: RetentionAdministrationWidgetOptions): () => void;
