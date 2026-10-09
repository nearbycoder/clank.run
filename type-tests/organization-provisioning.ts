import type { OrganizationProvisioningPolicy, OrganizationProvisioningAssignment, OrganizationSsoOptions, OrganizationSso } from "../src/organization-sso.ts";
import type { ClankPlatformOptions } from "../src/platform.ts";

const provisioning: OrganizationProvisioningPolicy = { token: "separate-operator-provisioning-credential", expiresAt: 1_800_000_000_000,
  groupRoles: [{ externalId: "developers", role: "developer" }, { externalId: "readers", role: "viewer" }] };
const assignment: OrganizationProvisioningAssignment = { resourceId: "scim_01234567890123456789012345678901", role: "developer", active: true, deactivated: false };
const options: OrganizationSsoOptions = { applicationOrigin: "https://platform.example.test", identityLinking: { policyRevision: 2 }, providers: [{
  organizationId: "company", issuer: "https://identity.example.test", clientId: "clank", offboardingToken: "separate-operator-offboarding-credential", provisioning }],
  onProvisioning(userId, organizationId, current) { void [userId, organizationId, current.resourceId, current.active, current.deactivated, current.role]; } };
const platform: ClankPlatformOptions = { dataDirectory: "/private/platform", publicUrl: "https://platform.example.test", organizationSso: {
  applicationOrigin: options.applicationOrigin, providers: options.providers, identityLinking: options.identityLinking } };
declare const sso: OrganizationSso;
const current: OrganizationProvisioningAssignment | null | undefined = sso.provisioningAssignment?.("verified-local-user", "company");
void [assignment, platform, current];

// @ts-expect-error SCIM cannot assign owner or operator authority.
const owner: OrganizationProvisioningPolicy = { token: "credential", expiresAt: 100, groupRoles: [{ externalId: "owners", role: "owner" }] };
// @ts-expect-error Deactivation is a boolean and is distinct from pending binding eligibility.
const invalidAssignment: OrganizationProvisioningAssignment = { resourceId: "id", role: "viewer", active: false, deactivated: "pending" };
// @ts-expect-error Provisioning hooks must complete synchronously inside the transaction.
const asynchronous: OrganizationSsoOptions = { ...options, onProvisioning: async () => {} };
// @ts-expect-error Native platform membership hooks cannot be replaced through configuration.
const override: ClankPlatformOptions = { ...platform, organizationSso: { ...options, onProvisioning() {} } };
void [owner, invalidAssignment, asynchronous, override];
