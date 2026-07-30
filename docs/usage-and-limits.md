# Usage accounting and traffic limits

Clank records a small, durable monthly usage ledger at managed ingress. The ledger gives workspace
members and automation one stable view of consumed request capacity, known transfer, rejected
requests, and the limits currently enforced. It is deliberately transparent: the API describes
the measurement boundary and never turns incomplete network information into an estimated charge.

Usage controls are part of the existing control-plane process and SQLite catalog. They do not
require a billing service, Redis, telemetry vendor, or additional Railway resource.

## Inspect usage

Open **Usage** in the control-plane workspace navigation. Choose a workspace and UTC month to see:

- admitted requests and the monthly request limit;
- known transfer and the monthly known-transfer limit;
- requests rejected by a traffic limit;
- the per-project requests-per-minute ceiling;
- a production/preview project breakdown, including bounded history for deleted projects; and
- current projects, previews, members, domains, releases, and retained release storage.

The route is refresh-safe and server renders the correct authenticated Usage shell at `/usage`.
Its project table becomes labelled cards on narrow screens.

The same contract is available from the CLI:

```sh
clank usage
clank usage --month=2026-07
clank usage --org=<workspace-id>
clank usage --org=<workspace-id> --month=2026-07 --json
```

Inside a linked project, `clank usage` resolves the project's workspace. Outside a linked
directory, it selects the account's only accessible workspace or asks for `--org` when the choice
is ambiguous. `--json` emits the server's unmodified `clank-usage/1` document.

## API contract

An authenticated account or account-wide token can request:

```http
GET /api/usage?organizationId=<workspace-id>&month=2026-07
```

`month` is optional and defaults to the current UTC month. It must use `YYYY-MM` and remain within
the configured retention window. The caller must still belong to the workspace. A token scoped to
another workspace is denied, and project-scoped tokens cannot read workspace-wide usage.

The response shape is:

```json
{
  "ok": true,
  "protocol": "clank-usage/1",
  "workspace": {
    "id": "organization_...",
    "name": "Personal",
    "slug": "personal"
  },
  "period": {
    "key": "2026-07",
    "startedAt": 1782864000000,
    "endsAt": 1785542400000,
    "current": true,
    "closed": false,
    "complete": true,
    "trackingStartedAt": 1782864000000,
    "timezone": "UTC"
  },
  "usage": {
    "requests": 1200,
    "requestBytes": 31000,
    "responseBytes": 2000000,
    "knownTransferBytes": 2031000,
    "rejectedRequests": 3
  },
  "limits": {
    "requests": 5000000,
    "knownTransferBytes": 107374182400,
    "requestsPerMinutePerProject": 3000
  },
  "remaining": {
    "requests": 4998800,
    "knownTransferBytes": 107372151400
  },
  "resources": {
    "asOf": 1785000000000,
    "projects": 2,
    "previews": 1,
    "members": 1,
    "domains": 1,
    "releases": 4,
    "releaseStorageBytes": 8000000
  },
  "projects": [],
  "retentionMonths": 24,
  "metering": {
    "requestBoundary": "managed_ingress_admission",
    "transferBoundary": "request_body_and_declared_response_content_length",
    "streamedResponseBytesKnown": false,
    "pricingIncluded": false
  }
}
```

Timestamps are Unix milliseconds. `resources` is a current inventory taken at `asOf`; it is not a
historical reconstruction for the selected month.

## What a request means

A request enters the monthly and minute ledgers only after:

1. exact-host routing selects an active project;
2. the managed-ingress request body passes the configured size and UTF-8-independent byte reader;
3. the admission policy resolves the project's current workspace limits; and
4. one SQLite `BEGIN IMMEDIATE` transaction verifies and increments both applicable counters.

That transaction serializes simultaneous admissions across control-plane connections sharing the
same SQLite catalog. At an exact boundary, only the permitted number of requests is admitted.

The monthly limit is shared by production projects and previews in one workspace. The minute limit
is separate for each project and aligned to a UTC wall-clock minute. A denied request does not
increment admitted requests or request bytes, but does increment `rejectedRequests`.

Denials use HTTP `429`, a bounded `Retry-After`, and one stable code:

| Code | Boundary |
| --- | --- |
| `PROJECT_RATE_LIMIT_REACHED` | Project request ceiling for the current UTC minute |
| `WORKSPACE_REQUEST_LIMIT_REACHED` | Workspace admitted-request ceiling for the current UTC month |
| `WORKSPACE_TRANSFER_LIMIT_REACHED` | Workspace known-transfer ceiling for the current UTC month |

If admission storage or policy validation fails, ingress fails closed with HTTP `503`,
`ADMISSION_UNAVAILABLE`, and a short retry hint. Private storage errors are not returned.

## What known transfer means

Known transfer is:

```text
admitted request-body bytes
+ Content-Length declared by admitted responses that can carry a body
```

`HEAD`, `204`, and `304` responses contribute zero response bytes even if a representation-length
header is present. Clank does not buffer application responses merely to count them. A streamed,
compressed-on-the-fly, or otherwise undeclared response therefore contributes zero known response
bytes.

The transfer check can include the complete request body before upstream work begins. Response
length becomes known only after upstream response headers arrive, so one or more already-admitted
concurrent responses can move the ledger past the monthly limit. Later requests are blocked.
Operators that need a hard network-cost ceiling must additionally bound response sizes and
concurrency at the application or edge.

Requests rejected before tenant admission—unknown hosts, inactive routes, oversized bodies, and
malformed proxy input—remain in edge/host diagnostics rather than a tenant ledger. Keep public
ingress behind WAF, DDoS, connection, and body-rate protection; monthly application quotas are not
a substitute for those controls.

## Completeness and upgrades

On the first upgrade that creates the usage ledger, Clank seeds the current month from retained
minute metrics and records `trackingStartedAt`. Metrics do not distinguish historical admission
rejections, and metrics older than their own retention may already be gone. For that reason:

- `period.complete` is `false` when tracking began after the requested month started;
- the console and CLI display a partial-history warning; and
- callers must not invent missing values.

The first full UTC month after tracking begins is complete. The current month can be complete even
though it is not closed; `current`, `closed`, and `complete` are separate fields.

## Retention, deletion, and privacy

Monthly rows are retained for the current month plus the configured number of previous calendar
months. Pruning runs at control-plane startup and opportunistically during ingress, so reducing
retention takes effect without requiring a new deployment.

Permanent project deletion removes application data, detailed ingress metrics, releases, secrets,
logs, domains, and tokens through the existing deletion lifecycle. Its bounded monthly usage rows
remain until usage retention expires so workspace totals stay auditable. Those rows contain only:

- workspace and project IDs;
- the last project name, slug, and production/preview kind;
- UTC month;
- admitted request, request-byte, declared-response-byte, and rejection totals; and
- the last ledger-update timestamp.

The ledger never stores URL paths, hostnames, query strings, headers, cookies, authorization
values, IP addresses, user agents, request/response bodies, user email addresses, or application
record identities. Removing a member immediately removes their API access without rewriting
workspace totals.

## Configure defaults

Self-hosted defaults are:

| Environment variable | Default | Valid range |
| --- | ---: | ---: |
| `CLANK_MAX_REQUESTS_PER_MONTH_PER_ORGANIZATION` | `5000000` | 1 through JavaScript's safe integer maximum |
| `CLANK_MAX_TRANSFER_BYTES_PER_MONTH_PER_ORGANIZATION` | `107374182400` | 1 byte through JavaScript's safe integer maximum |
| `CLANK_MAX_REQUESTS_PER_MINUTE_PER_PROJECT` | `3000` | 1–1,000,000 |
| `CLANK_USAGE_RETENTION_MONTHS` | `24` | 1–120 |

The first three values participate in the existing quota hierarchy:

1. an explicit workspace override;
2. otherwise the workspace owner's account override; and
3. otherwise the installation environment default.

Platform administrators edit those overrides through **Control plane → Accounts → Limits…**.
Changes apply on the next admission. Lowering a limit never deletes an application resource.
Retention is installation-wide rather than tenant-adjustable.

Programmatic installations pass the equivalent `PlatformLimits` fields to `openPlatform()`:

```ts
const platform = await openPlatform({
  // ...
  limits: {
    requestsPerMonthPerOrganization: 5_000_000,
    transferBytesPerMonthPerOrganization: 100 * 1024 * 1024 * 1024,
    requestsPerMinutePerProject: 3_000,
    usageRetentionMonths: 24,
  },
});
```

## Deployment boundary

Only traffic passing through Clank managed ingress is metered and limited. Do not expose supervised
application ports publicly or route around the control plane. The supported production topology
binds application ports to loopback/private networking and exposes only the TLS edge in front of
Clank.

If managed ingress is disabled, applications continue to run but the monthly usage ledger has no
traffic to observe. `resources` still reports current control-plane inventory.

## Billing boundary

Clank core does not contain prices, currencies, subscriptions, invoices, taxes, payment-provider
identifiers, or automatic suspension for unpaid accounts. The ledger is stable input for a future
external entitlement/billing adapter, not a monetary record. Such an adapter must version its own
pricing, preserve raw byte/request units, handle late or incomplete periods explicitly, and never
reinterpret `knownTransferBytes` as total network egress.
