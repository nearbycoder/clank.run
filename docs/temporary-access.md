# Temporary preview access

Temporary access lets a workspace owner or administrator give another current member a short window to create a new isolated preview for one parent project. The recipient keeps their existing role. A grant cannot deploy code, refresh an existing preview, read secrets, restore data, operate jobs, mint credentials, or administer the workspace.

This initial privilege is `preview.create`. The authoritative acceptance occurs in the native control SQLite transaction, where the controller can repeat the grant, membership, policy, session and expiry checks immediately before committing. Backup creation and remote job cancellation are not supported grant scopes.

## Enable the native boundary

```ts
import { openPlatform } from '@clank.run/framework/platform';

const platform = await openPlatform({
  dataDirectory: './platform-data',
  publicUrl: 'https://platform.example.test',
  organizationSecurity: {},
  temporaryAccess: { maxGrants: 1000, maxReceipts: 10000 },
});
```

Temporary access requires native [organization security enforcement](organization-security.md). Grant creation and revocation require a current human browser owner/admin session and native passkey or MFA reauthentication within five minutes. Using a grant requires the recipient's own current human session, recent native authentication, current project membership and the current organization policy. These requirements apply even when the platform's optional global freshness setting is disabled.

Machines, bearer tokens, delegated CLI/OAuth credentials and support impersonation cannot receive or inherit this privilege. Supplying browser display metadata does not establish native authority. Project and organization access restrictions, preview quotas, isolated data, placement and expiry policies continue to apply.

## Review and manage grants

Open a parent project's **Settings** page to review temporary access. Owners and administrators can select a current member, choose a duration, record a reason, issue a grant and revoke an active grant. Other members see only grants addressed to their own account. The console shows the retained reason, action, recipient, expiry and current state.

The typed client exposes the same native endpoints:

```ts
import { createTemporaryAccessClient }
  from '@clank.run/framework/temporary-access';
import type { AuthClient } from '@clank.run/framework';

declare const auth: AuthClient; // Your application's current native auth client.
const access = createTemporaryAccessClient({ auth });
const current = await access.read('parent_project_01');
const issued = await access.create('parent_project_01', {
  recipientId: 'current_member_01',
  action: 'preview.create',
  durationMs: 15 * 60 * 1000,
  reason: 'Create the isolated preview for the reviewed change.',
  expectedVersion: current.version,
  operationId: crypto.randomUUID(),
});
```

The server supports durations from one second through one hour. The console offers 15 minutes, 30 minutes and one hour. Grants apply to exactly one parent project and cannot be reassigned to another recipient or action. Grant references are account-bound identifiers, not bearer credentials.

Create and revoke requests require an expected project inventory version, a bounded operation ID and a reason. Another accepted mutation or invalidation changes that version. A stale request fails rather than replacing the administrator's reviewed intent. Read the current inventory and explicitly review a new request; do not silently increase its expected version.

The transport is bounded to a 64 KiB response and a configurable 100–30,000 ms deadline, with a 15-second default. It sends current CSRF headers, rejects redirects, and discards an account/session change before returning private results. Timeout or response loss does not trigger automatic retries.

## Use the exact preview privilege

A recipient with recent native authentication can send the grant reference on the existing preview creation endpoint:

```ts
const grants = await access.read('parent_project_01');
const grant = grants.grants.find(item => item.active);
if (!grant) throw new Error('No current preview creation grant.');

const response = await fetch('/api/projects/parent_project_01/previews', {
  method: 'POST',
  credentials: 'same-origin',
  redirect: 'error',
  headers: {
    'content-type': 'application/json',
    ...auth.csrfHeader(),
    'x-clank-temporary-access': grant.id,
  },
  body: JSON.stringify({ name: 'review-42', ttlHours: 1 }),
});
if (!response.ok) throw new Error('Review current native authority before retrying.');
```

The native server repeats grant checks after reading the request body, after acquiring the project lock and inside the write transaction. An existing preview name returns a conflict for an elevated request; it cannot extend an existing preview's lifetime. After an uncertain creation response, review the existing preview with an authorized operator. Reusing the same name cannot create a second preview or turn the grant into refresh authority. The grant-management console does not currently submit this preview creation request for the recipient.

## Exact acknowledgments and invalidation

Create/revoke operation IDs identify exact reviewed intents. Retrying an identical request returns its retained acknowledgment without issuing another grant or audit event. Reusing an operation ID for different input fails. The returned `acceptedVersion` describes historical acceptance; read the current inventory before making another decision. A historical receipt never reactivates a revoked or expired grant.

The native form preserves an uncertain mutation's UUID and input until the user explicitly retries the unchanged request. A failed polling read cannot replace that input. An account/session change or native access denial clears grant reasons, drafts, private DOM and timers. Unsaved drafts can be discarded explicitly, and navigation warns about a draft or unknown acknowledgment.

Membership deletion or update invalidates grants issued by or addressed to that member through native triggers. Removing and rejoining within the same millisecond cannot restore an old grant. Changes to the pinned organization policy version, issuer authority, recipient membership or project organization also close access. Role restoration or policy relaxation does not reactivate the grant.

Reopening the controller conservatively retires **all previously active grants**, including after process loss. Operators must review and issue a new grant after a control-server restart. This closes the uncertainty where an expiry check rejected inside a transaction whose clock writes then rolled back before a crash. An in-process observed clock floor also rejects clock rollback; the native store retains its committed maximum observed clock. Retained grants and receipts are preserved.

Native grant mutations and elevated preview allocation verify their stored rows, receipts and audit acknowledgment inside the same transaction. Ignored or altered native writes fail without acknowledging a partial grant or preview. Preview audit metadata records the grant reference alongside the existing isolated-preview metadata; no session credentials or request headers are copied into it.

## Capacity, compatibility and acceptance

The protocol is versioned. Unsupported retained state blocks authority without adoption or deletion. Storage bounds are explicit: up to 100 retained grants per parent project and configured global grant/receipt limits, each bounded to 1–100,000. Full storage fails rather than evicting evidence. Automatic evidence purge and additional privilege scopes are outside this initial contract.

Before disabling or downgrading temporary access, quiesce elevated operations and explicitly revoke active grants with the current binary. Reopening without temporary access while active grants remain is rejected. Retain grant, receipt and audit history; an older binary cannot enforce this new boundary.

Native tests exercise real authentication, control SQLite, streamed HTTP requests held during revoke/expiry/membership/policy changes, failed write acknowledgment and actual controller process loss. These checks do not certify a physical authenticator or real browser keyboard/button interaction. Feature 14 remains unaccepted until its organization-policy foundation, complete release gates and interactive console evidence are accepted.
