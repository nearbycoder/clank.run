import type {SQLiteInternal} from "./sqlite-internal.js";
import type {OrganizationServiceAccount, ServiceAccountCredential, ServiceAccountIdentity, ServiceAccountPermission, IssuedServiceAccountCredential, AuthenticatedServiceAccount} from "./service-accounts.js";
export interface PlatformServiceAccountOptions {maxAccounts?: number; maxCredentials?: number; maxReceipts?: number;}
export interface ServiceAccountAuthority {readonly userId: string; authorize(organizationId: string, write: boolean): void; audit(action: string, metadata: Record<string, unknown>): void;}
export type {AuthenticatedServiceAccount} from "./service-accounts.js";
export declare class ServiceAccountError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string);
}
export declare function assertServiceAccountProtocol(sql: SQLiteInternal): void;
export declare function openPlatformServiceAccounts(sql: SQLiteInternal, options: PlatformServiceAccountOptions, hooks: {
  hash(value: string): string;
  encrypt(value: string): string;
  decrypt(value: string): string;
  eligibleOwner(organizationId: string, ownerId: string, projectId?: string, permissions?: readonly ServiceAccountPermission[]): boolean;
  now?(): number;
}): {
  list(organizationId: string, authority: ServiceAccountAuthority): readonly OrganizationServiceAccount[];
  read(organizationId: string, accountId: string, authority: ServiceAccountAuthority): {account: OrganizationServiceAccount; credentials: readonly ServiceAccountCredential[]};
  create(organizationId: string, authority: ServiceAccountAuthority, value: unknown): OrganizationServiceAccount;
  change(organizationId: string, accountId: string, authority: ServiceAccountAuthority, value: unknown): OrganizationServiceAccount;
  issue(organizationId: string, accountId: string, authority: ServiceAccountAuthority, value: unknown): IssuedServiceAccountCredential;
  resolve(accessToken: string): AuthenticatedServiceAccount;
  close(): void;
};
