import type { Renderable } from "./dom.js";
import type { OrganizationIdentityInventory, OrganizationIdentityUnlink, OrganizationIdentity } from "./organization-sso.js";
import type { AuthClient } from "./auth.js";
export interface OrganizationIdentityClient {
  list(): Promise<OrganizationIdentityInventory>;
  start(organizationId: string): Promise<{ authorizationUrl: string; expiresAt: number }>;
  unlink(input: OrganizationIdentityUnlink): Promise<{ identity: OrganizationIdentity; signedOut: true }>;
}
export declare function createOrganizationIdentityClient(options: { auth: AuthClient<any>; url?: string; prefix?: string; fetch?: typeof fetch }): OrganizationIdentityClient;
export declare function AccountSecurity(props: { auth: AuthClient<any>; identities?: OrganizationIdentityClient; onIdentityRedirect?: (authorizationUrl: string) => void }): Renderable;
export declare function PasswordRecoveryForm(props: { auth: AuthClient<any>; resetToken?: string }): Renderable;
export declare function EmailVerificationForm(props: { auth: AuthClient<any>; token: string }): Renderable;
