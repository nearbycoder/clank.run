# Organization and account security

`openOrganizationSso(database, auth, options)` provides OIDC authorization-code sign-in with PKCE. For a hosted control plane configure `openPlatform({ organizationSso: { applicationOrigin, providers } })`; each provider has an existing `organizationId`, exact `issuer`, `clientId`, optional `clientSecret`, and a separate random `offboardingToken` of at least 32 characters. Start a browser flow at `/__clank/sso/start/{organizationId}` and register `{applicationOrigin}/__clank/sso/callback` with the identity provider. Platform sign-ins provision viewer membership; administrators can change that role through the workspace member API.

The issuer and discovery issuer must match exactly. Discovery, token exchange and JWKS retrieval use HTTPS, bounded responses and deadlines, no redirects, public-address DNS validation and a pinned connection. Additional endpoint origins require explicit `endpointOrigins` entries. `allowInsecureLoopback: true` enables numeric loopback HTTP for local fixtures only. Tokens require RS256 or ES256 signatures, exact issuer, audience/authorized party, nonce, expiry, issuance time, and a verified email. State is browser-bound, durable, expiring and consumed once. These checks follow the [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) and [Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html) specifications.

External accounts bind to issuer and subject, never automatically to an existing account's email. A local account with the same email must be handled by an administrator before initial provisioning. SSO accounts are dedicated identities: offboarding disables the entire account. POST `{"subject":"exact-provider-subject"}` to `/__clank/sso/offboard/{organizationId}` with `Authorization: Bearer {offboardingToken}`. In one SQLite transaction this disables the identity, deletes browser sessions and account recovery tokens, revokes OAuth token families, and, on the platform, removes membership/project overrides and revokes platform tokens and pending device approvals. A retained tombstone also prevents initial provisioning after an earlier offboarding. Repeated requests are safe. Re-enrollment is intentionally an operator identity-management operation, not automatic email matching.

When embedding SSO outside the platform, `onProvision(userId, organizationId)` and `onOffboard(userId, organizationId)` can update the same database transaction. Hooks must be synchronous and must not perform external side effects. `issueFederatedSession` is a trusted server API; it does not accept unverified browser assertions.

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
