import type { AuthClient } from './auth.js';
export declare class TemporaryAccessError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number);
}
export type TemporaryAccessAction = 'preview.create';
export interface TemporaryAccessGrant {
    readonly id: string;
    readonly projectId: string;
    readonly organizationId: string;
    readonly issuerId: string;
    readonly recipientId: string;
    readonly action: TemporaryAccessAction;
    readonly reason: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly version: number;
    readonly state: 'active' | 'revoked' | 'expired';
    readonly active: boolean;
}
export interface TemporaryAccessSnapshot {
    readonly projectId: string;
    readonly version: number;
    readonly observedAt: number;
    readonly grants: readonly TemporaryAccessGrant[];
}
export interface TemporaryAccessCreate {
    readonly recipientId: string;
    readonly action: TemporaryAccessAction;
    readonly durationMs: number;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly operationId: string;
}
export interface TemporaryAccessRevoke {
    readonly grantId: string;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly operationId: string;
}
export interface TemporaryAccessResult {
    readonly grant: TemporaryAccessGrant;
    /** Version at acceptance; read again for the current project version. */
    readonly acceptedVersion: number;
}
export interface TemporaryAccessClient {
    read(projectId: string): Promise<TemporaryAccessSnapshot>;
    create(projectId: string, input: TemporaryAccessCreate): Promise<TemporaryAccessResult>;
    revoke(projectId: string, input: TemporaryAccessRevoke): Promise<TemporaryAccessResult>;
}
export interface TemporaryAccessClientOptions {
    readonly auth: Pick<AuthClient<any>, 'user' | 'session' | 'csrfHeader'>;
    readonly url?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}
export interface TemporaryAccessViewOptions {
    readonly projectId: string;
    readonly client: TemporaryAccessClient;
    readonly account: () => {
        readonly userId: string;
        readonly sessionId: string;
    } | null;
    /** Presentation only; the native server independently checks current authority. */
    readonly canManage: () => boolean;
    readonly members: readonly {
        readonly id: string;
        readonly label: string;
    }[];
}
export interface TemporaryAccessView {
    readonly disposed: boolean;
    refresh(): Promise<void>;
    hasPendingChanges(): boolean;
    dispose(): void;
}
/** Native controls; exact unknown-response intents are retained for an explicit retry. */
export declare function createTemporaryAccessView(root: HTMLElement, options: TemporaryAccessViewOptions): TemporaryAccessView;
/** Always rebind to the current native human session; no shared bearer credential. */
export declare function createTemporaryAccessClient(options: TemporaryAccessClientOptions): TemporaryAccessClient;
/** Validates untrusted transport/state before display; never proves authority. */
export declare function validateTemporaryAccessGrant(value: any, projectId: string): asserts value is TemporaryAccessGrant;
