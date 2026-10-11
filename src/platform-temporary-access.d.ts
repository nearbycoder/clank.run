import type { SQLiteInternal } from './sqlite-internal.js';
import { type TemporaryAccessCreate, type TemporaryAccessResult, type TemporaryAccessRevoke, type TemporaryAccessSnapshot } from './temporary-access.js';
/** Private native adapter. Browser JSON, tokens and machine principals cannot create it. */
export interface TemporaryAccessAuthority {
    readonly userId: string;
    assertCurrent(fresh: boolean): void;
}
export interface TemporaryAccessMembership {
    readonly organizationId: string;
    readonly role: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly policyVersion: number;
}
export interface PlatformTemporaryAccessOptions {
    readonly membership: (projectId: string, userId: string) => TemporaryAccessMembership | null;
    /** Must insert and verify the native audit row within this transaction. */
    readonly audit: (actorId: string, projectId: string, action: string, metadata: Readonly<Record<string, unknown>>) => void;
    readonly maxGrants?: number;
    readonly maxReceipts?: number;
    readonly now?: () => number;
}
export declare function openPlatformTemporaryAccess(sql: SQLiteInternal, options: PlatformTemporaryAccessOptions): {
    read(projectId: string, authority: TemporaryAccessAuthority): TemporaryAccessSnapshot;
    create(projectId: string, authority: TemporaryAccessAuthority, input: TemporaryAccessCreate): TemporaryAccessResult;
    revoke(projectId: string, authority: TemporaryAccessAuthority, input: TemporaryAccessRevoke): TemporaryAccessResult;
    capture(projectId: string, authority: TemporaryAccessAuthority, grantId: string): () => void;
    close(): void;
};
