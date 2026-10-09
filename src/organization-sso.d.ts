import type { AuthRuntime } from "./auth.js";
import type { SQLiteDatabase } from "./backend.js";

export interface OrganizationSsoProvider {
  readonly organizationId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  /** Exact additional origins hosting this issuer's authorization/token/JWKS endpoints. */
  readonly endpointOrigins?: readonly string[];
  /** A separate server-to-server secret used by the offboarding endpoint; at least 32 characters. */
  readonly offboardingToken: string;
  readonly profile?: (claims: Readonly<Record<string, unknown>>) => object;
}
export interface OrganizationSsoOptions {
  readonly applicationOrigin: string;
  readonly providers: readonly OrganizationSsoProvider[];
  readonly prefix?: string;
  /** Opt-in policy; increase revision whenever provider configuration or linking policy changes. */
  readonly identityLinking?: { readonly policyRevision: number; readonly maxActiveIdentities?: number; readonly maxRetainedIdentities?: number };
  /** HTTP is allowed only for numeric loopback development fixtures, never arbitrary hosts. */
  readonly allowInsecureLoopback?: boolean;
  /** Synchronous hooks share the identity/offboarding transaction. */
  readonly onProvision?: (userId: string, organizationId: string) => void;
  readonly onOffboard?: (userId: string, organizationId: string, context?: { accountMode: "dedicated" | "linked"; reason: "offboard" | "unlink" }) => void;
}
export interface OrganizationIdentity { readonly id: string; readonly organizationId: string; readonly issuer: string; readonly subject: string; readonly active: boolean; readonly version: number; readonly linkedAt: number; }
export interface OrganizationIdentityInventory { readonly enabled: boolean; readonly policyRevision: number | null; readonly providers: readonly { organizationId: string; issuer: string }[]; readonly identities: readonly OrganizationIdentity[]; }
export interface OrganizationIdentityUnlink { readonly identityId: string; readonly expectedVersion: number; readonly idempotencyKey: string; }
export interface OrganizationSso { handles(request: Request): boolean; handle(request: Request): Promise<Response>; }

export declare function openOrganizationSso(database: SQLiteDatabase<any>, auth: AuthRuntime<any>, options: OrganizationSsoOptions): OrganizationSso;
