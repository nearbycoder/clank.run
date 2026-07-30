# Deployment dashboard, quotas, and domains

Clank includes a dependency-free browser console for operating projects, traffic, releases, logs, and custom domains. It is served by the same authenticated control plane as the CLI API; there is no separate dashboard service or browser package to install.

## Dashboard

Open the configured `CLANK_PLATFORM_URL` and sign in with a platform account. A valid browser session opens the dashboard directly after a refresh. Expired sessions return to the sign-in view, and every authenticated browser mutation requires the session CSRF token. The first installation account uses the one-time bootstrap unless the operator explicitly enables public registration. Later invitees can choose **Use invitation** to create the email-bound account without reopening public signup. The invitation explicitly determines whether the account receives only its own personal workspace or also joins an existing workspace.

The control plane resolves the browser session and requested console route before it returns HTML.
The first response therefore contains the correct visible account-access or application shell,
route title, navigation state, and escaped account identity. Client JavaScript attaches interactions
and revalidates live dashboard data after that first server render; it does not reveal or hide the
authenticated shell as a post-load correction.

The console uses normal, refresh-safe URLs rather than keeping navigation only in page memory:

| URL | View |
| --- | --- |
| `/login`, `/signup`, `/invite` | Account access and invitation-assisted registration |
| `/overview` | Account-wide project and traffic summary |
| `/activity` | Authorized workspace audit history |
| `/admin` | Browser-only global analytics, account directory, and support access for allowlisted operators |
| `/workspaces/<workspace-slug>/people` | Members, roles, and invitations for one workspace |
| `/projects/<project-slug>/performance` | Project traffic and latency, with `?range=15m\|1h\|24h\|7d\|30d` |
| `/projects/<project-slug>/domains` | Domain ownership, routing, and TLS |
| `/projects/<project-slug>/deployments` | Immutable releases and storage lifecycle |
| `/projects/<project-slug>/backups` | Scheduled and manual encrypted backups |
| `/projects/<project-slug>/logs` | Redacted runtime logs |
| `/projects/<project-slug>/jobs` | Private queue health, cron schedules, cancellation, and retry |
| `/projects/<project-slug>/settings` | Administrative and destructive project controls |

Links update browser history, Back/Forward restores the matching view, and every listed URL can be
opened or refreshed directly. The server recognizes only this bounded route grammar. Before login,
a protected deep link renders the generic account-access shell without confirming that its workspace
or project exists; after authentication, the client resolves the slug only against the caller's
authorized dashboard payload. Unknown sections return `404`, and trailing slashes redirect to their
canonical URL while preserving the query string.

The overview shows:

- projects and current supervisor state;
- requests, 5xx error rate, and known ingress bytes for the last 24 hours;
- enforced project capacity across the account's organizations; and
- a searchable project list with request and p95-latency summaries.

Selecting a project switches the desktop sidebar to contextual project navigation with an explicit
return to **All projects**. Phone and tablet layouts switch to an off-canvas sidebar with a
click-away backdrop; the closed drawer stays out of both the keyboard and accessibility trees.
Project sections become a complete two- or three-column tab grid, so every destination remains
visible without horizontal scrolling. Dense deployment, backup, and operator tables become
labelled record cards, domain instructions and runtime logs wrap safely, and interactive controls
use at least 44-pixel touch targets. Summary cards stay in two columns on ordinary phones and
collapse to one column on extra-narrow screens.
Each project URL loads shared project metadata plus only the selected view's bounded dataset. For
example, opening Performance requests metrics but does not also download domains, releases,
backups, jobs, and logs.

The workspace Activity view shows append-only API history across every organization where the current owner, administrator, or developer role permits audit access. Events identify their action, target, actor, timestamp, and expandable safe metadata. Pagination uses a descending event-ID cursor, so concurrent new events do not duplicate or skip older pages. Deleted projects remain named and visibly marked as deleted.

The **People** view creates and switches between the account's workspaces, then shows the current role, members, pending invitations, and project usage. The creation control reflects the transactionally enforced owned-workspace quota and selects the new workspace immediately. A signed-in recipient can paste an email-bound workspace token to join without using the CLI. Owners and administrators can invite by email, copy the single-use token once, revoke pending invitations, change roles, remove collaborators, or leave when last-owner protection permits. Allowlisted platform administrators get an additional **Personal workspace only** choice that onboards the recipient without granting access to any inviter workspace. The pending list labels both access scopes explicitly. Pending invitation addresses are hidden from unauthorized workspace members, including email redaction in developer activity metadata; disabled controls reflect server capabilities, but every operation is authorized again by the API.

Allowlisted platform operators see a separate **Control plane** view. Its range-selectable global
traffic histogram, capacity totals, account growth, and top-project table aggregate the complete
installation. The cursor-paginated account directory exposes only operational identity and usage
metadata and supports bounded email/name search. CLI bearer tokens cannot open these APIs.

The **Limits…** action on every account opens the durable capacity editor. Operators can set
account-wide workspace and project capacity, then select any workspace owned by that account to
override its project, domain, release, release-storage, or backup retention limits. A blank field
removes the explicit override and restores inheritance. The editor always shows the effective value
and current usage. Saving a lower value never removes application resources; it blocks new capacity
until usage returns below the limit. Backup retention is the explicit exception: the next successful
backup reconciles the oldest encrypted restore points to the newly selected count. Every changed
value, its prior value, target scope, operator, and resulting effective limits are recorded in the
append-only audit log.

An operator may start a 15-minute read-only support session from an eligible account row after
entering a reason and the exact target email. The target's authorized dashboard becomes visible,
but every server-side mutation, identity control, device approval, and operator API is denied. A
persistent warning identifies both accounts, the reason, and expiry. Exit restores the real
operator, and sign-out revokes the support session before ending the account session. Operators
cannot impersonate themselves, disabled accounts, or other platform administrators, and both start
and stop events remain attributed to the real operator.
The operator view keeps the latest 25 start/stop records visible with the real operator, target,
reason, timestamp, and planned expiry; the durable audit table remains the source of truth.

Each project has performance, deployments, domains, logs, jobs, backups, and settings views. The
project header shows its production URL, runtime state, workspace, and current role. Performance
identifies the active production release, presents the exact `clank deploy` next step when no
release exists, and supports `15m`, `1h`, `24h`, `7d`, and `30d` metric windows. It includes the
complete time window (including idle buckets), previous-period changes, p50/p90/p95/p99 and maximum
latency, peak request rate, status classes, HTTP methods, non-overlapping latency buckets, and
request/response byte detail. Domains walks through ownership, routing, and TLS eligibility
independently so a DNS failure is not reported as a certificate failure. Deployments shows enforced
artifact count/byte usage and can remove inactive runtime files while retaining release metadata
and audit history. Jobs shows bounded queue counts, overdue work, expired leases, dead letters,
safe job metadata, and cron state. Authorized owners, administrators, and developers can request a
conditional cancellation or retry; viewer and support-impersonation sessions remain read-only.
Arguments, results, error text, application identities, worker identities, and lease credentials
never enter the dashboard response. Backups exposes the automatic cadence and next run, retained
encrypted restore points, last scheduler failure, and manual create/verify controls. Settings makes
operational identity and database provisioning state visible, then gives owners and administrators
a confirmation-gated way to permanently delete the project and reclaim its quota. A project
without a first deployment reports that its isolated database will be provisioned on first deploy
instead of failing the whole screen.

The dashboard uses the same organization membership and project-permission checks as the CLI. API values are inserted with DOM `textContent` or attributes rather than HTML parsing. The page has a nonce-bound script, restrictive CSP, no-store responses, framing denial, and no third-party assets.

## Enforced capacity

Limits are operator configuration, not cosmetic dashboard values:

| Environment variable | Default | Enforcement boundary |
| --- | ---: | --- |
| `CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT` | `5` | Account-owned organization count and insert in one SQLite transaction |
| `CLANK_MAX_PROJECTS_PER_ACCOUNT` | `10` | Account-owned project count and insert in one SQLite transaction |
| `CLANK_MAX_PROJECTS_PER_ORGANIZATION` | `10` | Project count and insert in one SQLite transaction |
| `CLANK_MAX_DOMAINS_PER_PROJECT` | `5` | Domain assignment and count in one SQLite transaction |
| `CLANK_MAX_RELEASES_PER_PROJECT` | `50` | Available release-artifact count (valid range 2–100) checked under the distributed project lock |
| `CLANK_MAX_RELEASE_STORAGE_BYTES_PER_PROJECT` | `21474836480` | Uncompressed release files and pre-deploy snapshots checked under the same lock |
| `CLANK_BACKUP_MAX_COUNT` | `30` | Retained encrypted restore points per project |
| `CLANK_METRICS_RETENTION_DAYS` | `30` | Installation-wide minute ingress-metric retention; not customer-adjustable |

The API returns `ORGANIZATION_LIMIT_REACHED`, `ACCOUNT_PROJECT_LIMIT_REACHED`, `PROJECT_LIMIT_REACHED`, or `DOMAIN_LIMIT_REACHED` with HTTP `409` when capacity is exhausted. Account limits count organizations created by the account and projects owned by the account; joining someone else's organization does not consume the invitee's creator quota. A pending or verified hostname belongs to exactly one project; another project cannot replace its challenge. The console hostname, custom-domain target, base domain, and the base-domain application namespace are reserved.

Environment values are installation defaults, not immutable ceilings. A platform administrator can
store an explicit override for an account or workspace from the Control plane. Resolution is
deterministic:

1. a workspace override wins for resources inside that workspace;
2. otherwise the workspace inherits the account that owns it; and
3. otherwise the installation environment default applies.

The account's own override governs its total owned workspaces and projects. Workspace overrides are
available only for limits that naturally belong inside a workspace. Backup cadence, maximum source
database size, maximum backup age, upload size, and metric retention remain operator-wide safety
policies rather than tenant overrides.

Overrides live in the control SQLite database as one validated row per scope and quota key. The
admin API accepts only known keys and safe integer bounds, requires a same-origin browser
administrator session plus CSRF, rejects bearer tokens and active support impersonation, and writes
the override and audit event in one transaction. Account and organization limits are checked in the
same SQLite write transactions as their inserts. Domain checks remain in the hostname assignment
transaction. Release limits are rechecked while holding the project's durable cross-control-plane
lease, and backup retention is resolved each time a backup manager opens, so concurrent work and
long-running control planes cannot keep stale capacity.

A successful permanent project deletion immediately releases the account/organization project count, slug, application port, and custom-domain assignments. The deletion path uses the same durable per-project lock as deployment and backup work, then removes platform-managed storage and control metadata. Exact confirmation and explicit data-loss acknowledgement are required; only an owner/admin account session or account-wide token can perform it.

## Release storage lifecycle

Each available release counts its extracted file sizes plus its pre-deploy SQLite rollback snapshot. The compressed upload size remains visible separately for protocol accounting. A deployment is rejected with `RELEASE_LIMIT_REACHED` or `RELEASE_STORAGE_LIMIT_REACHED` before activation when it would exceed either ceiling.

The active release cannot be cleaned. Removing the active release's immediate predecessor removes the one-click code target and the active release's matching pre-deploy data snapshot, so the API requires both the exact confirmation text and an explicit rollback-loss flag. Other inactive, failed, or crashed artifacts need the same exact confirmation but no rollback-loss override. Cleanup requires `rollback` permission and removes only runtime files and release-local rollback material; immutable release metadata, logs, and audit evidence remain.

On upgrade, pre-existing releases initialize storage accounting from their recorded upload bytes because older rows did not retain extracted-size totals. New deployments record the exact extracted file total and actual snapshot size. Operators that need exact accounting for old releases can clean obsolete artifacts or redeploy them.

## Ingress metrics

Metrics are recorded only for requests that pass through managed ingress. Clank stores one row per project and minute with:

- request count and 2xx/3xx/4xx/5xx counts;
- 5xx error count;
- latency sum, maximum, and cumulative `50`, `100`, `250`, `500`, `1000`, `2500`, `5000`, and `+Inf` millisecond buckets; and
- request bytes plus response bytes when the upstream declares `Content-Length`; and
- fixed counters for `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and every other method.

Reported percentiles are upper bounds of matching fixed buckets, not precomputed quantiles. That makes buckets safely aggregatable across time, following the [Prometheus histogram model](https://prometheus.io/docs/practices/histograms/). Method names are normalized into eight bounded counters. Rows created before method counters were introduced appear as `OTHER`, preserving totals through the automatic schema upgrade. The persisted series has no path, hostname, IP, email, user, query-string, or user-agent labels, avoiding high-cardinality and personal-data growth. The HTTP names and duration/size concepts follow the [OpenTelemetry HTTP metric conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/).

The project API returns a fixed number of chart buckets for the complete selected window, a summary, and the equally sized preceding window. Percentage changes use the previous value as their denominator; a new nonzero series with no preceding value is reported as `null` rather than an infinite percentage. Server-error changes are returned as percentage-point differences. The smallest window is 15 minutes at one-minute resolution; longer windows downsample to keep responses and rendering bounded.

Latency currently measures ingress receipt through upstream response headers. It does not measure completion of a streamed body. Response bytes are zero when their final size is not declared. Application-level business metrics and end-to-end traces remain separate; see [Observability](observability.md).

## Custom-domain lifecycle

Set an edge target before allowing custom domains:

```sh
export CLANK_INGRESS=1
export CLANK_INGRESS_BASE_DOMAIN=apps.example.com
export CLANK_CUSTOM_DOMAIN_TARGET=edge.apps.example.com
export CLANK_CUSTOM_DOMAIN_ADDRESSES=192.0.2.10,2001:db8::10
export CLANK_TLS_ASK_TOKEN="$(openssl rand -hex 32)"
```

Clank tracks three separate states:

1. **Ownership** — the customer publishes the exact random TXT value at `_clank.<hostname>` and asks Clank to verify it.
2. **Routing** — the hostname must resolve through the configured CNAME target or to one of the configured edge addresses.
3. **Certificate** — a verified, correctly routed hostname on a deployed site becomes eligible for the edge certificate manager.

For a subdomain such as `tasks.customer.example`, prefer:

```text
tasks.customer.example.  CNAME  edge.apps.example.com.
```

At a zone apex, use provider-supported CNAME flattening/ALIAS/ANAME or the displayed A/AAAA addresses. A conventional CNAME cannot coexist with other data at the same owner name under [RFC 1034](https://www.rfc-editor.org/rfc/rfc1034). If the customer publishes restrictive CAA records, the chosen ACME issuer must also be authorized; see [RFC 8659](https://www.rfc-editor.org/rfc/rfc8659.html).

DNS checks use the host's recursive resolver and may reflect resolver caching. Clank checks routing when a domain is added, when ownership is verified, when **Check DNS** or its API equivalent is requested, and through a background reconciler every five minutes by default. The reconciler claims a bounded batch in SQLite, uses expiring lease tokens so multiple control planes do not duplicate the same check, limits concurrent lookups, applies a per-domain deadline, and schedules the next observation only after the current claim settles. The Domains UI and API expose whether automation is enabled, its cadence and bounds, the last completed pass, and the number of successful or failed checks.

Set `CLANK_DOMAIN_RECHECK_INTERVAL_MS=0` to disable automation, or tune the interval, batch size, and timeout with the variables documented in [Self-hosting](self-hosting.md). Manual checks and automatic checks use the same routing state transition. A stale or timed-out leased result cannot overwrite a later manual check.

Ownership verification remains an explicit action because it consumes the one-time TXT challenge and creates a durable trust decision. Once verified, ownership remains verified after the TXT record is removed, matching common SaaS onboarding behavior. Removing the domain from Clank releases the assignment and stops new routing immediately. An edge may retain already-issued certificate material until its normal cache lifecycle removes it.

## Self-hosted TLS with Caddy

Caddy is the recommended zero-Node-package edge for a self-hosted installation. It supports unknown customer hostnames with On-Demand TLS, caches certificates, renews them in the background, and requires an authorization endpoint to prevent issuance abuse. Caddy explicitly recommends a fast indexed lookup with no DNS or other network work in that endpoint; Clank's permission route does exactly that. See [Caddy's On-Demand TLS documentation](https://caddyserver.com/docs/automatic-https#on-demand-tls).

Example `Caddyfile`:

```caddyfile
{
  servers {
    strict_sni_host on
  }
  on_demand_tls {
    ask http://127.0.0.1:4200/_clank/tls/ask?token={$CLANK_TLS_ASK_TOKEN}
  }
}

deploy.example.com {
  reverse_proxy 127.0.0.1:4200
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:4200
}
```

The permission endpoint returns `200` only for either:

- a deployed `slug.<base-domain>` site; or
- a deployed custom domain whose ownership is verified and routing is ready.

Every other name receives a non-2xx response. Keep the Clank listener and permission route on loopback or a private network, require the high-entropy token, disable debug logging in production because the permission URL contains it, and persist and back up Caddy's data directory. `strict_sni_host on` rejects a TLS SNI/HTTP Host mismatch instead of permitting domain fronting. Caddy documents both the permission endpoint and this server option in its [global options reference](https://caddyserver.com/docs/caddyfile/options#on-demand-tls).

Point `deploy.example.com`, `edge.apps.example.com`, and `*.apps.example.com` at the edge. The console gets its normal explicit certificate; built-in and customer hostnames are authorized on demand. Test with an ACME staging endpoint before production to avoid CA rate limits.

At larger multi-region scale, put a managed SaaS-domain edge in front and adapt its status/webhook API to the same three Clank states. For example, Cloudflare for SaaS separately exposes hostname ownership and certificate validation, and describes production readiness as an active hostname, active SSL, and DNS pointing to the SaaS target. See its [hostname validation model](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/). The open-source default stays provider-neutral and does not require customers to delegate their DNS zone.

## Browser/API endpoints

- `GET /api/dashboard` — account, organizations, enforced limits, projects, 24-hour summaries, and domain-edge configuration.
- `GET /api/admin/analytics?range=24h` — browser-platform-admin-only global capacity, traffic, account growth, and top-project summaries.
- `GET /api/admin/users?limit=50&before=<cursor>&query=<text>` — browser-platform-admin-only redacted account directory.
- `GET /api/admin/quotas/account/:accountId` — administrator-only account defaults, overrides, effective limits, usage, and owned workspace limits.
- `GET /api/admin/quotas/workspace/:workspaceId` — administrator-only workspace inheritance, overrides, effective limits, and usage.
- `PUT /api/admin/quotas/account/:accountId` — CSRF-protected `{ "overrides": { "<key>": number | null } }`; `null` removes an override.
- `PUT /api/admin/quotas/workspace/:workspaceId` — the same update contract for workspace-compatible keys.
- `POST /api/admin/impersonation` — recent-auth platform administrator starts a reason-bound read-only support session after exact email confirmation.
- `DELETE /api/admin/impersonation` — revoke the current browser-session-bound support session.
- `GET /api/audit?limit=100&before=<event-id>&organizationId=<id>` — role-filtered, cursor-paginated workspace activity including deleted projects.
- `POST /api/organizations` — create an owned workspace under the account quota.
- `GET /api/organizations/:id` — workspace capabilities, member roster, and administrator-only active invitation metadata.
- `POST /api/organizations/:id/invitations` — create or replace an email-bound, single-use invitation.
- `GET|POST /api/admin/invitations` — list or create platform-admin-only personal signup invitations.
- `DELETE /api/admin/invitations/:invitationId` — revoke an active personal signup invitation.
- `POST /__clank/auth/invited-register` — create an invitation-bound account and atomically apply its personal or workspace scope.
- `DELETE /api/organizations/:id/invitations/:invitationId` — revoke an active invitation.
- `PATCH /api/organizations/:id/members/:userId` — change a member role with last-owner and owner-only protections.
- `DELETE /api/organizations/:id/members/:userId` — leave or administratively remove membership and revoke workspace-scoped credentials.
- `GET /api/projects/:id` — project status, usage, current organization role, and whether the principal may delete the project or operate jobs.
- `DELETE /api/projects/:id` — owner/admin-only permanent deletion with `{ "confirmation": "delete-site <slug>", "acknowledgeDataLoss": true }`.
- `GET /api/projects/:id/metrics?range=15m|1h|24h|7d|30d` — bounded current/previous summaries, comparisons, and complete downsampled points.
- `GET /api/projects/:id/domains` — ownership, routing, observed DNS, TLS state, project limit, and reconciliation status.
- `POST /api/projects/:id/domains` — reserve a hostname and create the ownership challenge.
- `POST /api/projects/:id/domains/:domainId/verify` — verify TXT ownership and refresh routing.
- `POST /api/projects/:id/domains/:domainId/check` — refresh routing without changing ownership.
- `DELETE /api/projects/:id/domains/:domainId` — remove and release the hostname.
- `GET /api/projects/:id/backups` — safe backup metadata and durable scheduler status; host paths are omitted.
- `POST /api/projects/:id/backups` — create and verify an encrypted restore point.
- `POST /api/projects/:id/backups/:backupId/verify` — decrypt, authenticate, checksum, and integrity-check a restore point.
- `POST /api/projects/:id/backups/:backupId/restore` — confirmation-gated restore with an automatic safety copy.
- `GET /api/projects/:id/releases` — release history, artifact availability, cleanup protection, and count/byte usage.
- `DELETE /api/projects/:id/releases/:releaseId` — confirmation-gated inactive artifact and rollback-snapshot cleanup.
- `GET /api/projects/:id/jobs?state=&queue=&limit=` — bounded, payload-free queue state,
  schedule metadata, and attention counters.
- `POST /api/projects/:id/jobs/:jobId/cancel` — conditionally cancel queued/retrying work or
  request cooperative cancellation of a running job; requires `jobs`.
- `POST /api/projects/:id/jobs/:jobId/retry` — conditionally return a dead or cancelled job to
  the queue; requires `jobs`.
- `GET /_clank/tls/ask?token=…&domain=…` — private Caddy permission lookup; not a customer API.

Browser mutations require same-origin session authentication and CSRF. CLI calls use bearer tokens, whose organization role and project scope are re-evaluated on every request.
