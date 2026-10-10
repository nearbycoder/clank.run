# Project cost attribution and budgets

Clank can reconcile measured project usage against a versioned operator rate card. The result is an auditable estimate in the currency’s smallest units. It is not an invoice, a forecast, or a guaranteed ceiling on concurrent spending. Missing coverage remains unknown; a measured zero remains zero.

## Operator measurement contract

Configure `openPlatform({ projectCosts })` on the trusted control server. The collector runs only after a freshly authenticated human project owner or administrator requests reconciliation. It receives the project ID, UTC period boundaries, a captured `asOf` time and an abort signal. It must return cumulative quantities from the period start through `observedUntil`, which cannot exceed `asOf`. The server never accepts measured quantities from a browser, CLI or agent.

```ts
import { openPlatform } from '@clank.run/framework/platform';
import type { ProjectCostMeasurement } from '@clank.run/framework/project-costs';

// Implement this adapter against your independently measured, durable ledger.
// Never substitute request counts, capacity forecasts, or fabricated zeroes.
declare function readMeasuredLedger(input: {
  projectId: string; periodStartedAt: number; periodEndsAt: number;
  asOf: number; signal: AbortSignal;
}): Promise<ProjectCostMeasurement>;

const platform = await openPlatform({
  dataDirectory: './platform-data',
  publicUrl: 'https://platform.example.test',
  projectCosts: {
    timeoutMs: 5000,
    maxObservations: 10000,
    maxReceipts: 10000,
    maxPolicies: 1000,
    rateCards: [{
      id: 'operator-2026-10', revision: 1, currency: 'USD',
      effectiveFrom: Date.UTC(2026, 9, 1),
      rates: {
        storageByteMilliseconds: { amountMinor: 1, perUnits: 1000000 },
        transferBytes: { amountMinor: 1, perUnits: 1000000 },
        runtimeMilliseconds: { amountMinor: 1, perUnits: 1000 },
      },
    }],
    measure: input => readMeasuredLedger(input),
  },
});
```

The three supported meters are storage byte-milliseconds, measured transfer bytes, and measured runtime milliseconds. Quantities are nonnegative decimal strings of at most 36 digits, without signs, exponent notation or leading zeroes. Each meter supplies `{ units, complete }`. Use `{ units: null, complete: false }` when unavailable. A known partial quantity can have `complete: false`; its component contributes to the known subtotal while the total remains unknown.

`source` identifies the trusted collector with an opaque value, never a path or credential. `sourceRevision` identifies its measured ledger revision. Corrections may reduce cumulative quantities but cannot move coverage backward or substitute a different source. Keep the ledger durable and honor cancellation. Clank bounds its wait and rejects late completion; it cannot forcibly stop an arbitrary adapter’s own external side effects. This adapter must be read-only.

Each rate specifies integer `amountMinor` per positive integer `perUnits`. Calculation uses exact integer arithmetic: quantity × amountMinor / perUnits, rounded upward once per cumulative component. The total sums those components. With rates of one smallest currency unit per 100 units, quantities 200, 300 and 100 cost exactly 6. A correction to 100, 200 and 100 costs 4. Retained revisions expose both measurements; it does not add the old total to the new total.

## Immutable prices and reconciliation

Rate cards start at a UTC month boundary. IDs, revisions and effective dates are immutable after registration. A newly reconciled month selects its applicable card; subsequent corrections retain that month’s accepted card even when a later card is configured. Historical months are bounded to the latest 24 UTC months. Unknown prices, altered stored cards, corrupt observations and unsupported storage protocols fail closed.

Use the public client with the current native authentication headers:

```ts
import { createProjectCostClient } from '@clank.run/framework/project-costs';

declare const projectId: string;
declare const currentHeaders: () => HeadersInit;
const client = createProjectCostClient({
  url: 'https://platform.example.test', headers: currentHeaders,
});
const current = await client.read(projectId);
const snapshot = await client.reconcile(projectId, {
  month: current.month,
  expectedVersion: current.snapshot?.version ?? 0,
  operationId: crypto.randomUUID(),
  reason: 'Reconcile the reviewed measured ledger revision',
});
const history = await client.history(projectId, current.month);
```

Fresh native human authentication is required for reconciliation, policy changes and overrides, even when the platform’s general fresh-authentication option is disabled. Current organization membership and the project owner/admin role are rechecked after collector awaits and inside the SQLite commit. Machine principals, impersonation and ordinary browser-supplied meter values cannot authorize changes. Reads follow current project access; machine read credentials must be scoped to that exact project.

Every mutation requires an expected version, an operation ID and a bounded reason. Store an uncertain operation’s exact input and ID, then retry unchanged. An acknowledged operation has one retained receipt and audit event. Changing input under an old ID is rejected. A stale expected version requires reading current state and reviewing a new intent. History returns at most 25 recent revisions for the requested month.

## Budgets, alerts and admission

Set a currency, an exact decimal `limitMinor`, an integer warning percentage and a maximum measurement age. The currency must match the accepted rate card for a known budget comparison. Missing measurements, incomplete coverage or currency mismatch produce `unknown`; old coverage produces `stale`. Complete fresh measured totals produce `within-budget`, `warning` or `exhausted` using exact integer comparisons.

```ts
const policy = await client.policy(projectId, {
  expectedVersion: current.policy?.version ?? 0,
  operationId: crypto.randomUUID(),
  currency: 'USD', limitMinor: '10000', warningPercent: 80,
  admission: 'observe', maxMeasurementAgeMs: 60000,
  reason: 'Reviewed monthly operating budget',
});
```

`observe` reports status without blocking traffic. `deny-at-observed-limit` checks the current month’s latest reconciled estimate before admitting more ingress. Unknown, stale or exhausted measurements block admission until corrected or covered by an active reviewed override. Existing request/transfer quotas still apply. This policy does not reserve money for requests in flight and cannot guarantee a strict monetary ceiling when work runs concurrently or measurements lag.

With `operations` configured, cost policies feed private `cost_budget` operational alerts. Unknown coverage, stale measurements and warnings produce warning severity; exhausted budgets produce critical severity. A correction that returns within the budget resolves the alert. Platform administrators inspect these through the existing operational monitor. Public customer health does not include private project costs.

An owner/admin can grant an override with the current policy version and override version, a reason, and an expiry within one hour. An expiry of zero revokes it. Expiry, a newer policy or a newer override makes the old override inactive. Exact retries retain the original acknowledgment while exposing its current active state. Overrides do not disable existing capacity quotas.

## Console, CLI and MCP

When the operator enables measurement collection, project **Settings** shows measurements, their coverage, retained corrections, budget forms and expiring overrides. Forms pin the versions they were reviewed against. Polling preserves edits. Use **Discard draft and refresh** after reviewing a stale rejection. An uncertain operation disables draft editing and exposes **Retry unchanged operation**. The console warns before leaving an edited draft or uncertain operation.
Account/project changes or revoked access clear the view’s local drafts and private metadata. An already dispatched operation may have committed before the view closes.

```sh
clank costs
clank costs --month 2026-10 --json
clank costs --history --month 2026-10 --json
```

These commands read the linked project through its existing native CLI credential. They cannot reconcile measurements or change budgets.

`createProjectCostMcpTools(resolveClient)` returns `project_costs_read` and `project_costs_history`. Both require `agent:read`, declare read-only/idempotent annotations, reject extra input fields and use the same bounded HTTP reads. Mount them on an authenticated `createMcpServer`; resolve a client using that caller’s current native credential on every invocation. Never bind all callers to a privileged shared token. The native project API independently revalidates machine scope and revocation. The history tool requires a month; the read tool defaults to the current UTC month.

The HTTP contract is `GET /api/projects/:id/costs?month=YYYY-MM`, `GET /api/projects/:id/costs/history?month=YYYY-MM`, and fresh-human `POST` routes ending in `/reconcile`, `/policy` or `/override`. Responses use `clank-project-costs/1`. Mutations have an 8 KiB request envelope; the public client has a 256 KiB response envelope and a finite transport timeout. Reconciliation has a separate bounded operator collector timeout.

## Persistence, capacity and rollback

Cost state, registered cards, observations, policies, overrides and exact receipts are stored in the native platform control SQLite database under protocol version 1. Startup creates new tables transactionally. It never deletes retained cost evidence or adopts an unsupported version. Observations and receipts have explicit operator bounds; reaching one rejects a new operation without committing any observation, policy, receipt or audit event. Existing exact retries remain available. Policy inventory is bounded independently; alerts reject an inventory beyond that bound.

Omitting `projectCosts` later disables collection, but the current binary still reads retained state and enforces existing admission policies. An unsupported older binary cannot enforce this contract. Before a binary downgrade, quiesce ingress and collector work, review and explicitly change policies to `observe` through fresh current administration, preserve the control store and audit evidence, then verify the older deployment’s behavior before re-admitting traffic. Do not drop tables or weaken authentication to make a downgrade pass.
