# Hosted plans and billing

Clank can turn installation limits into a public plan catalog without moving authorization or
quota enforcement into a payment provider. Every account sees its current plan, exact monthly
price, billing state, and effective entitlements at `/billing` and through `clank billing`.
Platform administrators can grant a plan directly or add narrower quota overrides from the
existing account limits editor.

Billing is optional. A self-hosted installation with no billing configuration starts exactly as
before, exposes no billing route or navigation, and continues to use installation and operator
limits. A catalog can also run without a payment provider, which is useful for private,
invite-only, sponsored, or manually administered installations.

## Entitlement order

Clank resolves capacity at the point where a resource or request is admitted:

1. current installation defaults;
2. the account's durable snapshot of the plan's explicitly declared entitlements;
3. explicit account overrides set by a platform administrator; and
4. for workspace-scoped limits, explicit workspace overrides.

An `active`, `trialing`, or operator-granted `manual` plan contributes its snapshot. A `past_due`
subscription keeps its snapshot only through the configured grace interval. `canceled`, `unpaid`,
`paused`, `incomplete`, and expired states fall back to the default plan. Invalid persisted
entitlements also fail closed to the default.

Lowering or losing an entitlement never deletes a project, release, backup, domain, or workspace.
Existing resources remain visible and operable, but creation is denied until usage is back within
the effective limit. This makes cancellation and payment failures reversible instead of turning
them into destructive storage operations.

The available quota keys are:

| Key | Scope |
| --- | --- |
| `organizationsPerAccount` | account |
| `projectsPerAccount` | account |
| `projectsPerOrganization` | account or workspace |
| `domainsPerProject` | account or workspace |
| `releasesPerProject` | account or workspace |
| `releaseStorageBytesPerProject` | account or workspace |
| `backupsPerProject` | account or workspace |
| `requestsPerMonthPerOrganization` | account or workspace |
| `transferBytesPerMonthPerOrganization` | account or workspace |
| `requestsPerMinutePerProject` | account or workspace |

See [Usage and limits](usage-and-limits.md) for exact metering boundaries. A plan price does not
turn known transfer into an invoice: Clank reports the configured price and enforces capacity,
while the payment provider owns payment collection, tax behavior, receipts, and invoices.

## Inspect an account

Open **Billing** in the control plane, or use the read-only CLI command:

```sh
clank billing
clank billing --json
```

The normal command shows the current plan, state, period or grace deadline, the effective limits
after operator overrides, and the browser management URL. `--json` returns the unmodified
`clank-billing/1` API document for an agent or script.

An authenticated account or account-wide token can also read:

```http
GET /api/billing
```

Project-scoped tokens cannot read account billing. Checkout and portal creation deliberately
require an interactive browser session plus Clank's CSRF token; a bearer token cannot initiate
either operation.

## Configure a plan catalog

`clank-platform` accepts the catalog through one of:

- `CLANK_BILLING_PLANS_JSON`, for a small inline JSON document; or
- `CLANK_BILLING_PLANS_FILE`, for a regular, non-symbolic-link file.

The two settings are mutually exclusive and the input is limited to 256 KiB. Unknown fields,
unknown quotas, duplicate IDs, invalid prices, and out-of-range values stop startup. One through
twenty plans are allowed. The default plan must exist and have a zero monthly amount.

```json
{
  "defaultPlanId": "free",
  "pastDueGraceMs": 604800000,
  "plans": [
    {
      "id": "free",
      "name": "Free",
      "description": "A small place to try Clank.",
      "monthlyPrice": { "currency": "usd", "amount": 0 },
      "quotas": {
        "projectsPerAccount": 2,
        "backupsPerProject": 3
      }
    },
    {
      "id": "pro",
      "name": "Pro",
      "description": "Capacity for active side projects.",
      "monthlyPrice": { "currency": "usd", "amount": 1500 },
      "quotas": {
        "projectsPerAccount": 20,
        "projectsPerOrganization": 20,
        "domainsPerProject": 10,
        "backupsPerProject": 30
      },
      "featured": true,
      "stripePriceId": "price_replace_with_your_recurring_price"
    }
  ]
}
```

`monthlyPrice.amount` uses the currency's smallest unit: `1500` is USD 15.00. At most one plan may
be featured. `pastDueGraceMs` defaults to seven days and must be from one hour through ninety
days. A plan only needs to declare values that differ from the installation defaults; the public
catalog shows the fully resolved values.

The `stripePriceId` field is provider configuration and is stripped from the public catalog. Do
not place API keys, webhook secrets, customer IDs, or subscription IDs in this file.

For a catalog-only installation, set no Stripe variables. Operators can open **Control plane →
Accounts → Limits…** and choose an **Operator-granted plan**. Grants and revocations are durable
and audited. A provider-managed subscription cannot be overwritten with a manual plan; use its
billing portal or an explicit quota override.

## Connect Stripe

Create one recurring Stripe Price for every non-free catalog plan, put its `price_…` ID in the
matching catalog entry, and set both secrets:

```sh
CLANK_STRIPE_SECRET_KEY=sk_live_replace_me
CLANK_STRIPE_WEBHOOK_SECRET=whsec_replace_me
```

For test mode, use matching `sk_test_…`, test Price IDs, and a test-mode webhook. Live and test
events cannot cross. Configure the endpoint:

```text
https://your-control-plane.example/api/billing/webhook
```

Subscribe it to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Enable and configure Stripe's customer portal before exposing the **Manage billing** action.
Clank expects one configured subscription item with quantity one; portal plan changes must select
one of the catalog's mapped Prices.

Clank normally lets Stripe use the API version configured on the account. To pin a version that
you have already tested in Stripe Workbench, set:

```sh
CLANK_STRIPE_API_VERSION=2026-02-25.clover
```

This is optional and intentionally has no hard-coded default. Changing a pinned provider API
version is an operator-controlled compatibility change.

Restart the control plane after changing catalog or secret environment variables. Startup logs
report only whether billing is disabled, catalog-only, or provider-backed and the plan count;
they never print secret or provider resource values.

## Checkout and webhook lifecycle

The browser asks Clank to create checkout for a configured paid plan. Clank creates a durable,
expiring attempt first and sends its random ID as both Stripe idempotency and metadata. The
checkout return URL is fixed to the configured control-plane origin. The Stripe adapter only
accepts hosted redirects on `checkout.stripe.com`. Before the first checkout for each plan in a
running process, the adapter retrieves the configured Stripe Price and verifies that it is active,
in the matching live/test mode, uses the catalog currency and exact unit amount, and is a
licensed, per-unit monthly recurring Price. A mismatch fails closed before Clank returns a
checkout URL. Successful verification is cached in memory because Stripe Price amount and
currency are immutable.

Webhook processing then:

1. reads the exact raw request body with a 512 KiB limit;
2. verifies Stripe's HMAC-SHA256 signature and five-minute timestamp window;
3. verifies live/test mode and the event's bounded shape;
4. binds account, plan, customer, subscription, checkout attempt, and session identifiers;
5. records the event ID and digest transactionally for replay/conflict detection; and
6. applies only a newer subscription event to the entitlement snapshot.

Subscription events may arrive before checkout completion. Clank handles that ordering, rejects
conflicting reuse of an event ID, and treats exact replays as successful duplicates. Provider
errors returned to users are generic; raw provider bodies and identifiers are not written to
activity metadata.

## Provider-neutral API

Programmatic installations can supply any adapter implementing `BillingProvider`:

```ts
import { openPlatform } from "@clank.run/framework/platform";
import type { BillingProvider } from "@clank.run/framework/billing";

declare const provider: BillingProvider;

const platform = await openPlatform({
  dataDirectory: "./data",
  publicUrl: "https://platform.example",
  billing: {
    defaultPlanId: "free",
    plans: [
      {
        id: "free",
        name: "Free",
        description: "Start small.",
        monthlyPrice: { currency: "usd", amount: 0 },
        quotas: { projectsPerAccount: 1 }
      },
      {
        id: "pro",
        name: "Pro",
        description: "More capacity.",
        monthlyPrice: { currency: "usd", amount: 1500 },
        quotas: { projectsPerAccount: 20 }
      }
    ],
    provider
  }
});
```

The adapter owns hosted checkout, hosted account management, and signed-event normalization.
Clank owns account authorization, durable attempts, event ordering, entitlement snapshots, quota
precedence, and audit. The provider's `planIds` must exactly equal the paid catalog plan IDs so a
partial or stale mapping cannot start.

The included `createStripeBillingProvider()` adapter pins Stripe's API origin, disables redirects
and credentials, bounds response bodies and timeouts, validates all provider IDs and hosted URLs,
and never exposes its API key.

## Operational checklist

Before enabling paid checkout:

1. exercise checkout, portal, upgrade, downgrade, cancellation, payment failure, recovery, and
   duplicate webhook delivery in provider test mode;
2. verify every paid Price is recurring, active, unique, and mapped to exactly one plan;
3. confirm the public control-plane URL is HTTPS and the webhook points to the same deployment;
4. configure provider tax, receipt, refund, dispute, legal, and support behavior for your business;
5. back up the Clank control database and test restore;
6. alert on webhook HTTP failures and `BILLING_PROVIDER_UNAVAILABLE`;
7. review operator grants and quota overrides in the activity feed; and
8. confirm a downgrade blocks new capacity without deleting existing resources.

Billing records live in the same control-plane SQLite database as accounts and quotas, so the
existing encrypted backup and restore procedures cover them. Provider payment data remains with
the provider; Clank stores only opaque customer/subscription references and the minimum state
needed to authorize capacity. Account deletion cascades its billing state and checkout attempts.
At startup, unreferenced checkout attempts older than thirty days are removed; the attempt that
binds a current provider subscription remains. Provider event IDs and digests contain no account
or payment payload and are retained for seven years for replay/conflict detection, then pruned at
startup. Choose an independent provider-side financial-record retention policy for your legal and
accounting requirements.
