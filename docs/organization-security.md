# Organization and account security

`openOrganizationSso(database, auth, options)` provides OIDC authorization-code sign-in with PKCE. For a hosted control plane configure `openPlatform({ organizationSso: { applicationOrigin, providers } })`; each provider has an existing `organizationId`, exact `issuer`, `clientId`, optional `clientSecret`, and a separate random `offboardingToken` of at least 32 characters. Start a browser flow at `/__clank/sso/start/{organizationId}` and register `{applicationOrigin}/__clank/sso/callback` with the identity provider. Platform sign-ins provision viewer membership; administrators can change that role through the workspace member API.

The issuer and discovery issuer must match exactly. Discovery, token exchange and JWKS retrieval use HTTPS, bounded responses and deadlines, no redirects, public-address DNS validation and a pinned connection. Additional endpoint origins require explicit `endpointOrigins` entries. `allowInsecureLoopback: true` enables numeric loopback HTTP for local fixtures only. Tokens require RS256 or ES256 signatures, exact issuer, audience/authorized party, nonce, expiry, issuance time, and a verified email. State is browser-bound, durable, expiring and consumed once. These checks follow the [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) and [Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html) specifications.

External accounts bind to issuer and subject, never automatically to an existing account's email. A local account with the same email must be handled by an administrator before initial provisioning. By default, SSO accounts are dedicated identities: offboarding disables the entire account. Explicit verified linking below adopts a persisted shared-account mode. POST `{"subject":"exact-provider-subject"}` to `/__clank/sso/offboard/{organizationId}` with `Authorization: Bearer {offboardingToken}`. In one SQLite transaction this disables the identity, deletes browser sessions and account recovery tokens, revokes OAuth token families, and, on the platform, removes membership/project overrides and revokes platform tokens and pending device approvals. A retained tombstone also prevents initial provisioning after an earlier offboarding. Repeated requests are safe. Re-enrollment is intentionally an operator identity-management operation, not automatic email matching.

When embedding SSO outside the platform, `onProvision(userId, organizationId)` and `onOffboard(userId, organizationId)` can update the same database transaction. Hooks must be synchronous and must not perform external side effects. `issueFederatedSession` is a trusted server API; it does not accept unverified browser assertions.

## Verified organization identity linking

Linking is opt-in. Configure `identityLinking: { policyRevision: 1 }` on `openOrganizationSso`
or the platform's `organizationSso` options. Increase the positive integer revision whenever
providers, secrets, profile callbacks, endpoint allowlists or linking policy change. Older live
instances cannot accept linking against a newer persisted revision. The default limits are ten
active identities and fifty retained identities per account; `maxActiveIdentities` allows 1–10
and `maxRetainedIdentities` allows the active limit through 100. Only one active identity per
organization/account is allowed. Inactive issuer/subject ownership is retained, so unlinking never
transfers that provider identity to another person. Historic duplicate subjects are preserved;
new linking rejects conflicting ownership rather than merging accounts.

The signed-in user first completes local passkey or MFA verification. POST an empty object to
`/__clank/sso/link/{organizationId}` using the normal browser cookie, exact Origin and
`X-Clank-CSRF` header. Bearer credentials and cross-account targets are not accepted. The response
contains `authorizationUrl` and `expiresAt`; navigate the same browser to that URL. The provider
must perform fresh authentication (`prompt=login`, `max_age=0`) and return a signed `auth_time`
from the current flow. The callback rechecks the original local session's passkey/MFA assurance
within five minutes, current policy, provider configuration, account generation, revocation and
issuer/subject ownership before committing. It retains the local email/profile and redirects to
`/`. Provider email is required to be verified but is never used to merge or select accounts.

State expires after ten minutes. Global state capacity is 1,000, with at most ten retained link
flows per account in that interval. A lost accepted callback can be retried with the exact
state/code/browser binding and original live local session, including after a controller restart.
It returns the original redirect while its identity/version remains active. Changed codes,
configuration, revoked sessions, expired state or later unlink/relink reject the receipt. Failure
or interruption before acceptance consumes the state; start a fresh verification flow.

GET `/__clank/sso/identities` lists only the current browser account's configured providers and
bounded identity inventory. POST `/__clank/sso/unlink` with `identityId`, `expectedVersion` and a
stable 16–128-character `idempotencyKey`. Unlink requires current local step-up and another usable
local credential or configured active identity. It removes that organization's access and
revokes browser sessions, recovery tokens, generic OAuth grants, broad platform credentials and
pending device approvals. Sign back in with a remaining method. Other organizations' membership,
project overrides and credentials scoped exclusively to their projects remain. A platform's last
owner must grant another active owner before voluntary unlink. Explicit provider offboarding still
removes revoked ownership; this feature does not provide last-owner operator recovery.

Unlink retains at most 100 receipts per account without silently evicting retry keys. Exact retries
by the same freshly verified account return the original receipt, even after restart or a later
explicit relink; changed input with that key fails. The receipt describes the original acceptance,
including its then-current sign-out. A fresh relink proves both identities again and provisions
viewer membership, without restoring previously granted administrative roles. Provider offboarding
retains a durable tombstone and cannot be reversed by self-service relinking.

```ts
import { createOrganizationIdentityClient, AccountSecurity } from "@clank.run/framework/account-security";
const identities = createOrganizationIdentityClient({ auth: client.auth });
const securityView = AccountSecurity({ auth: client.auth, identities });
// Mount securityView using the application's normal renderer.
```

The screen provides local verification, an explicit inventory refresh, a native organization
selector, provider navigation and per-identity unlink controls. Client requests recheck live
server authentication before accepting inventory or redirects. Requests have a fifteen-second
deadline and stop reading at 256 KiB. Transport failures, malformed upstream responses and
server errors also reload current authentication, including a lost accepted unlink response. Account/session changes and screen
disposal clear cached identities, drafts and retry keys; late replies cannot repopulate or redirect
the next account. `onIdentityRedirect(url)` can integrate an application's own navigation. The
client's `unlink(input)` accepts an explicit stable retry body for callers retaining their own
pending operation; it reloads auth after the original acceptance.

Embedding hooks receive optional `onOffboard(userId, organizationId, { accountMode, reason })`
context, where mode is `dedicated` or `linked` and reason is `offboard` or `unlink`. Adapt custom
hooks before enabling linking: a linked account requires organization-scoped entitlement removal.
All hooks remain synchronous and share the acceptance transaction. The platform supplies this
scope handling. Dedicated SSO accounts that have never explicitly linked retain global-disable
offboarding. Once linking or explicit unlink adopts the shared-account mode, that flag persists
even if the linking option is disabled, so later offboarding still preserves unrelated identities.

The upgrade transaction replaces the private identity table to remove its old global `user_id`
uniqueness constraint, preserves every legacy identity/revocation/audit row, and adds versioned
identity, account-mode, flow and unlink receipts. Back up the control database first. Disabling
linking stops new link/unlink admission but keeps upgraded offboarding semantics. Downgrading to
an older binary with shared accounts is unsafe: stop admission, remove extra identities using the
upgraded controller, and restore a separately verified compatible schema/snapshot that preserves
required revocations. Merely deleting new tables or toggling the option is not a safe downgrade.

## Recent authentication

`auth.requireFreshAuthentication(requestAuth, maxAgeMs = 300000)` reloads the live browser session and requires recent MFA or a user-verified passkey. Password-only sessions, bearer tokens, SSO assertions without local step-up, expired assurance, and revoked sessions fail with `FRESH_AUTH_REQUIRED`. Use this guard in the transaction that performs a sensitive mutation, after any awaited work.

The client provides `reauthenticateWithPasskey()`, `startMfaReauthentication(password)`, and `finishMfaReauthentication(challengeId, code)`. MFA requires the configured `defineAuth({ mfa: { send } })` delivery hook. Challenges bind to the exact session and current password, expire, rate-limit failures, and consume once. Passkey step-up requires a signed assertion with user verification. No fresh session is minted: assurance is attached to the current session.

For platform actions enable `freshAuthentication: { required: true, maxAgeMs: 300000 }`. This gates project deletion, data restoration (including rollback with `restoreData`), ownership changes and project permission administration. It is opt-in for existing deployments; without it those operations retain their existing session/token authorization. The platform's built-in account supports passkey step-up. CLI bearer credentials cannot substitute for fresh browser authentication when the option is enabled.

## Project permissions

Organization owners and administrators retain administrative authority. Other members inherit their organization role until an administrator writes an explicit project override:

```http
PUT /api/projects/{projectId}/members/{userId}
Content-Type: application/json

{"permissions":["read","logs","deploy"]}
```

Browser mutations require the normal origin and CSRF checks. Allowed permissions are `read`, `logs`, `deploy`, `rollback`, `secrets`, `tokens`, `audit`, `previews`, and `jobs`. An empty array denies all project access; `DELETE` on the same member URL restores role inheritance. `GET /api/projects/{projectId}/members` lists overrides for administrators. The target must already belong to the workspace. Members cannot grant themselves additional authority. Preview projects inherit their parent project's override. Current overrides apply to browser requests and bearer credentials, project listing and dashboard payloads; tokens cannot exceed either their scopes or current member permissions. Removing workspace membership also removes project overrides, preventing stale grants when the member is invited again.

## Account security screens

Mount `AccountSecurity({ auth })` for email verification, passkey registration/removal, recent authentication, active-session inspection/revocation, global sign-out and password changes. Its **Refresh account security** button loads current passkeys and sessions. `PasswordRecoveryForm({ auth })` requests recovery; passing `resetToken` renders password reset. `EmailVerificationForm({ auth, token })` renders an explicit verification action. Configure the existing password-recovery and email-verification delivery hooks and route their token links to these forms. Forms use the real `AuthClient`, display operation status, and avoid rendering token values. `listSessions()` returns only the current account's active sessions; `revokeSession(id)` cannot revoke another account's session.

## Migration and verification

Startup adds session assurance columns, a session-bound challenge table, SSO identity/state/revocation/audit tables, and platform project permission rows. Existing sessions have no fresh assurance. Back up the control database before upgrades. Do not downgrade to a version that ignores project overrides, disabled identities or fresh-auth requirements: retained rows alone cannot make older authorization code enforce these policies. Keep SSO revocation tombstones through restores and investigate backup age before restoring an offboarded identity.

`tests/organization-security.test.mjs` exercises real local OIDC discovery/code exchange/PKCE/signed JWTs, claim and origin rejection, callback replay, email takeover refusal, offboarding before and after provisioning, session and token revocation, signed WebAuthn step-up, MFA expiry/replay/failure limits, cross-user isolation, project ACL routes and listings, and platform integration. No external identity-provider tenant is needed for these tests.
