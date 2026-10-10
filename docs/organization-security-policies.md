# Organization security policies

Organization security policies set requirements for human browser, CLI and MCP access to one workspace: verified factors, organization SSO, session age and enrollment grace.

Dedicated machine credentials keep their own current owner, project scope, generation and lifecycle checks.

## Enable native enforcement

Enable the controller explicitly when opening a platform:

```ts
import { openPlatform } from '@clank.run/framework/platform';

const platform = await openPlatform({
  dataDirectory: '/private/control',
  publicUrl: 'https://control.example.test',
  organizationSecurity: { operatorRecovery: true },
});
```

`operatorRecovery` permits a currently enabled platform administrator to recover a workspace that has no capable owner or administrator. The operator must have a real passkey or MFA verification from the last 5 minutes. A recovery needs an exact workspace confirmation, an enrolled-passkey account, a recorded reason, an expected policy version and an operation ID. Review your operator accounts before enabling this option.

In **People and access**, owners and administrators can inspect the current policy, edit requirements, and choose **Review Policy…**. The review shows the original version, proposed requirements, affected member count, capable administrator count, recovery availability and the caller's proposed access. **Save Reviewed Policy** sends the exact reviewed intent with its original expected version.

The panel includes passkey enrollment and verification, password/MFA verification, and organization SSO verification. MFA needs a configured delivery hook; unavailable MFA does not become a successful verification. Passkey enrollment does not itself establish recent authentication. Verify the enrolled passkey before saving. SSO must be configured with [organization and account security](organization-security.md).

A noncompliant human owner or administrator can discover a minimal remediation entry and inspect security requirements. This does not expose projects, usage, members, invitations or audit feeds. CLI credentials, support impersonation and ordinary members do not receive this administration bypass. Authentication, enrollment and policy-remediation endpoints remain available so the user can complete the requirements.

## Requirements and effective access

| Field | Supported value | Effect |
| --- | --- | --- |
| `factor` | `none`, `mfa-or-passkey`, `passkey` | Require actual session assurance verified by AuthServer. JSON display state and provider claims cannot establish it. |
| `ssoOnly` | Boolean | Require signed organization OIDC proof attached to this exact local session and current organization identity. A linked identity alone is insufficient. |
| `sessionMaxAgeMs` | 1 minute–30 days | Hard age from session creation. Activity and step-up do not reset this age. |
| `enrollmentGraceMs` | 0–7 days | Bounded grace for factor/SSO enrollment. It does not extend session age, credential expiry or membership authority. |

Before a saved row exists, requirements are `none`, nonexclusive SSO, 30-day maximum age and zero grace. Admission to a bound application still requires a current human session and current organization membership. Native platform operations continue their existing permissions checks.

Grace deadlines persist per organization/account and only tighten. Repeated saves, relaxed requirements, and leaving/rejoining cannot extend an already recorded deadline. A first admission for a new member records its bounded enrollment deadline; it cannot reset a retained account's deadline. Preview is an authorization-aware inspection, not permission to commit later.

Every accepted policy change increments its generation, including relaxation. Previously issued human delegation proofs stop matching that generation and must be authorized again. Relaxing policy never revives an old CLI or MCP grant. New grants retain the actual consenting browser session, organization and generation; losing that origin session, membership, factor assurance, SSO identity or hard-age eligibility closes delegated access too.

Native device authorization and project token issuance capture or carry a live human proof in the credential transaction. MCP authorization-code consent captures the proof; code exchange and refresh carry it into the credential family. Admission and guarded effects read current policy again after asynchronous body, cryptographic and refresh-recovery work. A GitHub Actions preview identity does not prove a human policy session; credential issuance is refused for a workspace with a saved policy.

## Browser client and retries

```ts
import { createAuthClient } from '@clank.run/framework/auth';
import { createOrganizationSecurityClient } from '@clank.run/framework/organization-security-policy';

const auth = createAuthClient();
const security = createOrganizationSecurityClient({ auth });
const current = await security.read(organizationId);
const requirements = {
  factor: 'passkey' as const,
  ssoOnly: false,
  sessionMaxAgeMs: 60 * 60 * 1000,
  enrollmentGraceMs: 0,
};
const preview = await security.preview(organizationId, requirements);
// Present preview to the administrator and retain this exact reviewed request.
const change = {
  requirements,
  expectedVersion: current.version,
  operationId: 'policy_' + crypto.randomUUID().replaceAll('-', ''),
};
const acknowledgement = await security.change(organizationId, change);
const latest = await security.read(organizationId);
```

A version conflict requires a current read and a new review. An unknown response after save may hide a successful commit: retain the exact operation ID, original version and requirements, and retry that same request. Changing intent under the same ID is rejected. The retained acknowledgement describes the original result; compare it with a current read before presenting it as current policy.

The console preserves bounded drafts across workspace switches within the same account/session. A refresh does not silently rebase a dirty draft. An unknown save retains an exact retry; controls cannot edit its intent until resolved. Signing out or replacing the account/session clears private state and makes late responses obsolete. The client similarly rejects account replacements during transport and never reloads the replacement account on behalf of an obsolete request. Requests use current CSRF, no redirects, no response caching, a bounded timeout and a 32 KiB response limit.

## Bind an embedded backend explicitly

`openOrganizationSecurityPolicies(database, auth, options)` exposes the same controller for a native SQLite application. Hooks provide synchronous current membership, a complete inventory of at most 1,000 members, organization existence and transactional auditing. Recovery authority and owner restoration must be configured together and complete synchronously without a return value. A failed hook rolls back native policy, audit and receipt writes; an external provider does not join that SQLite transaction.

Pass `{ organizationSecurity: { organizationId, policy: options } }` to `openBackend` to bind all application admission to that organization in the same authentication/policy store. The runtime exposes `organizationSecurity` for trusted server callers. Use the browser client with `prefix: '/__clank/organizations'` for its mounted routes. A serialized `AuthState` cannot authenticate a controller caller. Server integrations must supply independently authenticated runtime results and current same-store membership hooks.

The binding also gates direct callers, cached queries, live-query admission, mutation effects/receipts, bucket checks, reviewed actions and MCP grants. Current reviewed-action requester and approving sessions are checked at commit. An already-open controller cannot silently ignore a policy newly installed by another controller: unconfigured admission fails closed. Native MCP misconfiguration returns an opaque server error rather than listing protected tools or executing an effect.

A separate application's database does not automatically inherit a platform control-store policy. Bind the real authoritative store explicitly; do not copy policy JSON or browser identity claims and treat them as authority. Provider effects and separate stores need their own current checks and idempotency.

## Recover the last administrator

Ordinary policy saves require current owner/admin authority, current policy compliance and recent signed passkey/MFA verification. Without independent recovery, a save that leaves no enabled, enrollable/provider-qualified administrator is refused. A temporary expired session alone does not justify operator recovery: a capable administrator must sign in and handle the policy.

When no capable administrator remains, a current independent operator uses `security.recover(organizationId, input)` with:

- `ownerId`: a known enabled account with an enrolled passkey;
- `confirmation`: the exact organization ID;
- `reason`: 10–500 bytes of noncontrol-text explanation;
- `expectedVersion`: the current reviewed policy generation;
- `operationId`: the exact retained recovery request identifier.

Recovery restores that account as an owner and resets policy to passkey-required, SSO optional, 30-day hard age and zero grace. Owner restoration, policy generation, native audit and exact receipt commit atomically. The target must still verify its passkey to use the restored workspace. Subsequent policy changes stay current even when a historical recovery acknowledgement is retried. Current operator authority is rechecked before an exact retry; losing the platform administrator role prevents recovery.

This is an explicit operator procedure. The native policy panel reviews ordinary policy changes; it does not grant a human administrator independent operator rights or present an unverified recovery as completed.

## Storage, migration and rollback

Policy storage uses additive native SQLite tables with protocol 1. Unknown protocols reject startup and active guarded operations. Defaults admit at most 1,000 policies, 10,000 receipts, 50,000 delegation proofs and 10,000 enrollment records globally. Configured maxima are 10,000 policies and 100,000 of each other record type. Full capacity rejects admission instead of dropping retained evidence; previews refuse an incomplete membership inventory. Policy routes accept at most 16 KiB and reject unknown fields, bearer administration, cross-origin browser writes and unsupported organizations.

Once saved policies exist, startup requires the explicit enforcement binding. Do not roll back to a controller version that predates this policy protocol, remove its binding or edit its tables to regain access. Keep the enforcement-compatible controller running and use a reviewed versioned change or the independent recovery procedure. Back up the control store using existing supported backup procedures before a planned migration. No cross-store, production provider or hardware/browser certification follows from native fixture tests.
