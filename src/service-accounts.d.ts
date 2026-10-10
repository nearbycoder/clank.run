import type {AuthClient} from "./auth.js";

export type ServiceAccountPermission = "read" | "logs" | "deploy" | "rollback" | "jobs" | "secrets" | "audit";
export interface OrganizationServiceAccount {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ServiceAccountCredential {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
  /** Authenticated requests, including requests later rejected at commit. */
  readonly authenticatedRequests: number;
  readonly status: "active" | "revoked" | "expired";
}
/** Display metadata only. Receiving this JSON does not authenticate a server caller. */
export interface ServiceAccountIdentity {
  readonly kind: "service-account";
  readonly id: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly credentialId: string;
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly expiresAt: number;
}
/** Trusted server result from PlatformRuntime; JSON identity metadata is insufficient. */
export interface AuthenticatedServiceAccount {
  readonly identity: ServiceAccountIdentity;
  /** Repeat before each operation, including exact budget retries. */
  assertCurrent(): void;
}
export interface CreateServiceAccountRequest { readonly name: string; readonly ownerId: string; readonly operationId: string; }
export interface ChangeServiceAccountRequest extends CreateServiceAccountRequest { readonly enabled: boolean; readonly expectedVersion: number; }
export interface IssueServiceAccountCredentialRequest {
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly expiresAt: number;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface IssuedServiceAccountCredential {
  /** An exact historical acknowledgement. Read current state before using a retried result. */
  readonly account: OrganizationServiceAccount;
  readonly credential: ServiceAccountCredential;
  readonly accessToken: string;
}
export interface ServiceAccountClientOptions {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: () => HeadersInit;
  readonly auth?: Pick<AuthClient, "csrfHeader">;
  readonly timeoutMs?: number;
}
export interface OrganizationServiceAccountClient {
  list(organizationId: string): Promise<readonly OrganizationServiceAccount[]>;
  read(organizationId: string, accountId: string): Promise<{readonly account: OrganizationServiceAccount; readonly credentials: readonly ServiceAccountCredential[]}>;
  create(organizationId: string, input: CreateServiceAccountRequest): Promise<OrganizationServiceAccount>;
  change(organizationId: string, accountId: string, input: ChangeServiceAccountRequest): Promise<OrganizationServiceAccount>;
  issue(organizationId: string, accountId: string, input: IssueServiceAccountCredentialRequest): Promise<IssuedServiceAccountCredential>;
}

export declare function createOrganizationServiceAccountClient(options?: ServiceAccountClientOptions): OrganizationServiceAccountClient;
