import type {AuthClient, AuthRequest, AuthRuntime} from "./auth.js";
import type {SQLiteDatabase} from "./backend.js";
import type {SQLiteInternal} from "./sqlite-internal.js";

export type OrganizationFactorRequirement = "none" | "mfa-or-passkey" | "passkey";
export interface OrganizationSecurityRequirements {
  readonly factor: OrganizationFactorRequirement;
  readonly ssoOnly: boolean;
  /** Hard session age, measured from creation rather than last activity or step-up. */
  readonly sessionMaxAgeMs: number;
  readonly enrollmentGraceMs: number;
}
export interface OrganizationSecurityPolicy extends OrganizationSecurityRequirements {
  readonly organizationId: string;
  readonly version: number;
  readonly updatedAt: number;
}
export interface OrganizationSecurityDecision {
  readonly allowed: boolean;
  readonly reasons: readonly ("membership" | "session" | "session-age" | "factor" | "organization-sso")[];
  readonly graceEndsAt: number | null;
  readonly policyVersion: number;
}
export interface OrganizationSecurityMembership {readonly role: "owner" | "admin" | "developer" | "viewer"; readonly createdAt: number;}
export interface OrganizationSecurityPolicyOptions {
  /** Synchronous current membership lookups in this same transactional store. */
  readonly membership: (organizationId: string, userId: string) => OrganizationSecurityMembership | null;
  /** A bounded complete inventory. Exceeding the limit must reject, never truncate. */
  readonly members: (organizationId: string) => readonly {readonly userId: string; readonly membership: OrganizationSecurityMembership}[];
  readonly exists: (organizationId: string) => boolean;
  readonly audit: (actorId: string, organizationId: string, action: string, metadata: Readonly<Record<string, unknown>>) => undefined;
  /** Independent operator authority, repeated inside recovery's transaction. */
  readonly authorizeRecovery?: (current: AuthRequest<any>, organizationId: string) => undefined;
  /** Restore this verified active enrolled-passkey account as an owner atomically. */
  readonly recoverOwner?: (organizationId: string, userId: string) => undefined;
  readonly maxPolicies?: number;
  readonly maxReceipts?: number;
  readonly maxDelegations?: number;
  readonly maxEnrollments?: number;
  readonly now?: () => number;
}
export interface OrganizationSecurityPolicyChange {
  readonly requirements: OrganizationSecurityRequirements;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface OrganizationSecurityPolicyRecovery {
  readonly ownerId: string;
  readonly confirmation: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface OrganizationSecurityPreview {
  readonly policy: OrganizationSecurityPolicy;
  readonly capableAdministrators: number;
  readonly recoveryAvailable: boolean;
  readonly affectedMembers: number;
  readonly current: OrganizationSecurityDecision;
  readonly proposed: OrganizationSecurityDecision;
}
export interface OrganizationSecurityPolicyController {
  read(organizationId: string, caller: AuthRequest<any>): OrganizationSecurityPolicy;
  preview(organizationId: string, caller: AuthRequest<any>, requirements: OrganizationSecurityRequirements): OrganizationSecurityPreview;
  change(organizationId: string, caller: AuthRequest<any>, input: OrganizationSecurityPolicyChange): OrganizationSecurityPolicy;
  recover(organizationId: string, caller: AuthRequest<any>, input: OrganizationSecurityPolicyRecovery): OrganizationSecurityPolicy;
  /** Trusted server boundary. JSON AuthState cannot prove a current session. */
  authorizeAuth(organizationId: string, caller: AuthRequest<any> | null): void;
  /** Captures the actual live human session; callers must authenticate the credential separately. */
  captureDelegation(organizationId: string, credentialId: string, caller: AuthRequest<any>): void;
  /** Carry an already admitted exact delegation into a new credential family. */
  continueDelegation(organizationId: string, sourceId: string, targetId: string, userId: string): void;
  authorizeDelegation(organizationId: string, credentialId: string, userId: string): void;
  /** Internal OAuth integration: identity is already authenticated independently. */
  bindDelegationAuth(organizationId: string, credentialId: string, caller: AuthRequest<any>): void;
  close(): void;
}

export declare function openOrganizationSecurityPolicies(database: SQLiteDatabase<any>, auth: AuthRuntime<any>, options: OrganizationSecurityPolicyOptions): OrganizationSecurityPolicyController;

export interface OrganizationSecurityClientOptions {
  readonly auth: Pick<AuthClient<any>, 'user' | 'session' | 'csrfHeader' | 'reload'>;
  readonly url?: string;
  /** Platform default; use /__clank/organizations for a bound application backend. */
  readonly prefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export interface OrganizationSecurityClient {
  read(organizationId: string): Promise<OrganizationSecurityPolicy>;
  preview(organizationId: string, requirements: OrganizationSecurityRequirements): Promise<OrganizationSecurityPreview>;
  change(organizationId: string, input: OrganizationSecurityPolicyChange): Promise<OrganizationSecurityPolicy>;
  recover(organizationId: string, input: OrganizationSecurityPolicyRecovery): Promise<OrganizationSecurityPolicy>;
}

export declare function createOrganizationSecurityClient(options: OrganizationSecurityClientOptions): OrganizationSecurityClient;

/** @internal Shared fail-closed storage guard for native integrations. */
export declare function assertOrganizationSecurityProtocol(sql: SQLiteInternal): void;
