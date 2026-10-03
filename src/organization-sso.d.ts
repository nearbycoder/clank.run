import type { AuthRuntime, AuthUserId } from "./auth.js";
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
  /** HTTP is allowed only for numeric loopback development fixtures, never arbitrary hosts. */
  readonly allowInsecureLoopback?: boolean;
  /** Synchronous hooks share the identity/offboarding transaction. */
  readonly onProvision?: (userId: string, organizationId: string) => void;
  readonly onOffboard?: (userId: string, organizationId: string) => void;
}
export interface OrganizationSso { handles(request: Request): boolean; handle(request: Request): Promise<Response>; }

export declare function openOrganizationSso(database: SQLiteDatabase<any>, auth: AuthRuntime<any>, options: OrganizationSsoOptions): OrganizationSso;
