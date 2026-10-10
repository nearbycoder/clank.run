# Organization service accounts

Service accounts give automation a dedicated identity and an expiring credential for one organization project. A currently eligible human owner remains responsible for the account. A service account has no human password, browser session, device-code login or approval vote.

Enable the native administration and authentication contract explicitly:

```ts
import {openPlatform} from "@clank.run/framework/platform";

const platform = await openPlatform({
  dataDirectory: "./platform",
  publicUrl: "https://deploy.example.com",
  serviceAccounts: {},
});
```

Omitting `serviceAccounts` keeps machine credentials and administration unavailable. Existing human sessions and CLI credentials retain their contracts. Machine identities are separate records; their responsible owner is not an impersonated human caller.

## Create an identity and issue a scoped credential

An organization owner or administrator uses their current browser session and CSRF token. Every administration write requires recent signed passkey or MFA verification, even when optional global fresh-authentication enforcement is disabled. A password-only session cannot create, change or rotate an account. The eligible owner must be an active organization member. At issuance, that owner must independently hold every requested permission for the selected project.

```ts
import {createOrganizationServiceAccountClient}
  from "@clank.run/framework/service-accounts";

const accounts = createOrganizationServiceAccountClient({auth});
const account = await accounts.create(organizationId, {
  name: "Release robot",
  ownerId: responsibleHumanId,
  operationId: crypto.randomUUID(),
});
const issued = await accounts.issue(organizationId, account.id, {
  projectId,
  permissions: ["read", "deploy"],
  expiresAt: Date.now() + 60 * 60 * 1000,
  expectedVersion: account.version,
  operationId: crypto.randomUUID(),
});
// Deliver issued.accessToken to the authorized worker through its secret store.
// Do not include it in logs, URLs, source files or audit metadata.
```

Names permit up to 160 UTF-8 bytes without control characters. Identifiers and operation IDs contain 8–128 ASCII letters, digits, underscores or hyphens. Credentials last from five minutes to thirty days. Every grant must explicitly include `read`; other supported permissions are `logs`, `deploy`, `rollback`, `jobs`, `secrets` and `audit`. A machine receives no implicit logs access from `read` and no inherited administrator powers from its owner.

The credential prefix is `clsa_`. Send it in `Authorization: Bearer …` to the native platform. `GET /api/service-account` returns display metadata identifying the machine account, credential, organization, project, responsible owner, permissions and expiry. That JSON is not a trusted authentication result.

Machine requests may list their single project, read its releases, backups and aggregate usage, inspect explicitly authorized logs or audit, change secrets, upload releases, change its runtime policy, roll back, and inspect/cancel/retry jobs with the corresponding explicit permission. Other operations are refused, including organization administration, membership changes, credential creation, previews, cross-project operations and human approval controls. A valid machine cannot authenticate through the human session or device-code routes.

## Rotation, ownership and uncertain responses

`issue()` rotates the account's credential generation, revokes every preceding key, and increments its version in one control-store transaction. Changes to the owner or disabling an account also revoke its credentials. Enabling it later does not revive old keys; issue a new credential. Renaming an enabled account without changing its owner preserves the current generation. An administrator can disable an account whose owner has already become ineligible.

```ts
const current = await accounts.read(organizationId, account.id);
await accounts.change(organizationId, account.id, {
  name: current.account.name,
  ownerId: current.account.ownerId,
  enabled: false,
  expectedVersion: current.account.version,
  operationId: crypto.randomUUID(),
});
```

Administration receipts bind the exact intent to the acting human, organization and operation ID. A failed audit rolls back the account, credential and receipt together. Concurrent changes with the same expected version admit at most one new effect; a stale version returns a conflict.

A lost response never triggers an automatic client retry. Inspect current state, then explicitly retry the exact body with its original operation ID and expected version. Encrypted secret receipts return the same originally issued key after restart or an interrupted response. This is a historical acknowledgement: a later rotation, disable or owner change may already have invalidated that key. Read the current account and credential status before using a retried acknowledgement. A changed body with the same operation ID fails, and current human authority and fresh authentication remain required for receipt access.

The browser-safe client resolves headers and CSRF anew for every request, uses same-origin credentials, refuses redirects, bounds request bodies to 16 KiB and responses to 1 MiB, and bounds fetch and body intake even when a transport ignores cancellation. The timeout defaults to ten seconds and accepts 500–30,000 milliseconds. Error responses do not expose server-supplied private messages.

## Current machine authority and operation budgets

Authentication checks the exact credential hash, grant, generation, expiry, enabled state, current organization membership, active responsible owner and that owner's current project permissions. Native writes repeat these checks after asynchronous body intake at existing current-authority boundaries. Successful machine responses also revalidate before returning. Rotating a credential while its upload is held refuses the old request without its guarded write or audit effects. This does not undo external side effects already accepted by a provider.

Trusted server integrations can resolve a machine directly:

```ts
const machine = platform.authenticateServiceAccount(request);
machine.assertCurrent();
const identity = {
  ownerId: machine.identity.organizationId,
  principalId: machine.identity.id,
};
```

Use this server result as a caller capability for [agent operation budgets](governance.md#agent-operation-budgets). Your budget `identity(caller)` callback must call `caller.assertCurrent()` on every invocation, including exact retries, then return the organization as `ownerId` and machine account as `principalId`. Keep budget management in an independently authenticated human or server administration capability; never infer management authority from the machine's responsible owner. Receiving `/api/service-account` JSON is insufficient.

Accepted budget mutations, debit and receipts remain atomic in the application's budget database. Current credential checks in a separate platform database are not a distributed transaction with that database or a remote provider. Keep actions synchronous and repeat current authorization where effects commit; external effects still require their provider's idempotency and authorization controls.

Native audit events identify `principalKind: "service-account"`, the service account ID, credential ID and generation while retaining the responsible human and token columns for compatibility. Credential metadata exposes `authenticatedRequests` and `lastUsedAt`. This counter measures authenticated attempts, including calls subsequently denied at commit; it is not a billing invoice or a count of accepted mutations. Project runtime/transfer/storage usage remains aggregate measured usage. Budget grants and their measured debits identify the machine principal separately from that aggregate.

## REST and bounded storage

Human administration uses these organization-scoped endpoints:

| Method | Path suffix after `/api/organizations/:organizationId/service-accounts` | Result |
| --- | --- | --- |
| GET | empty | `accounts` |
| POST | empty | `account` from the create body |
| GET | `/:accountId` | `detail` containing the account and credential metadata |
| POST | `/:accountId/change` | `account` from the versioned change body |
| POST | `/:accountId/credentials` | `issued` from the versioned credential body |

Endpoints accept no query parameters. Mutations use the exact documented fields and a 16 KiB body bound. Accounts and credentials are project/organization scoped; unrelated resources remain unavailable. Support impersonation and every token credential are refused for machine administration.

`serviceAccounts` accepts `maxAccounts`, `maxCredentials` and `maxReceipts`, defaulting to 1,000 accounts, 5,000 credential-history rows and 10,000 retained receipts globally. Each organization has at most fifty accounts and each account at most fifty credential rows. Supported global ceilings are 10,000 /50,000 /100,000 respectively. Exact authorized retries remain readable at capacity; new effects fail explicitly. History and encrypted receipts are not silently evicted to issue additional keys.

The protocol-versioned additive tables live in the native control SQLite store. Credentials persist only hashes outside the encrypted bounded receipt; receipts use the platform master key. Preserve that key with the matching control-store backup. Unknown protocols reject startup and current operations before modifying machine tables. A compatible rollback keeps the additive state, but older binaries do not authenticate the dedicated prefix and cannot certify newer machine protocols. Never roll back by reactivating old platform-token rows.

Native HTTP tests verify signed passkey step-up, strict project grants, machine audit attribution, owner loss, expiry, held-body rotation, budget identity and human-only administration refusal. Two real native controllers race a versioned rotation. Another native controller is killed after credential commit and before HTTP delivery; restart returns one exact encrypted acknowledgement while later disabled state remains authoritative. These disposable checks do not certify an external identity provider, production secret store or production deployment.
