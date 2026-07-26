# Deployment dashboard, quotas, and domains

Clank Deploy includes a dependency-free browser console for operating sites, traffic, releases, logs, and custom domains. It is served by the same authenticated control plane as the CLI API; there is no separate dashboard service or browser package to install.

## Dashboard

Open the configured `CLANK_PLATFORM_URL` and sign in with a platform account. A valid browser session opens the dashboard directly after a refresh. Expired sessions return to the sign-in view, and every browser mutation requires the session CSRF token.

The overview shows:

- sites and current supervisor state;
- requests, 5xx error rate, and known ingress bytes for the last 24 hours;
- enforced site capacity across the account's organizations; and
- a site picker with request and p95-latency summaries.

Each site has performance, domains, deployments, backups, and logs views. The performance chart supports `1h`, `24h`, `7d`, and `30d` windows. The domains view walks through ownership, routing, and TLS eligibility independently so a DNS failure is not reported as a certificate failure. The deployments view shows enforced artifact count/byte usage and can remove inactive runtime files while retaining release metadata and audit history. The backups view exposes the automatic cadence and next run, retained encrypted restore points, last scheduler failure, and manual create/verify controls. A project without a first deployment reports that its isolated database is not available instead of failing the whole project screen.

The dashboard uses the same organization membership and project-permission checks as the CLI. API values are inserted with DOM `textContent` or attributes rather than HTML parsing. The page has a nonce-bound script, restrictive CSP, no-store responses, framing denial, and no third-party assets.

## Enforced capacity

Limits are operator configuration, not cosmetic dashboard values:

| Environment variable | Default | Enforcement boundary |
| --- | ---: | --- |
| `CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT` | `5` | Account-owned organization count and insert in one SQLite transaction |
| `CLANK_MAX_PROJECTS_PER_ACCOUNT` | `10` | Account-owned site count and insert in one SQLite transaction |
| `CLANK_MAX_PROJECTS_PER_ORGANIZATION` | `10` | Site count and insert in one SQLite transaction |
| `CLANK_MAX_DOMAINS_PER_PROJECT` | `5` | Domain assignment and count in one SQLite transaction |
| `CLANK_METRICS_RETENTION_DAYS` | `30` | Minute ingress-metric retention |
| `CLANK_MAX_RELEASES_PER_PROJECT` | `50` | Available release-artifact count (valid range 2–100) checked under the distributed project lock |
| `CLANK_MAX_RELEASE_STORAGE_BYTES_PER_PROJECT` | `21474836480` | Uncompressed release files and pre-deploy snapshots checked under the same lock |

The API returns `ORGANIZATION_LIMIT_REACHED`, `ACCOUNT_PROJECT_LIMIT_REACHED`, `PROJECT_LIMIT_REACHED`, or `DOMAIN_LIMIT_REACHED` with HTTP `409` when capacity is exhausted. Account limits count organizations created by the account and projects owned by the account; joining someone else's organization does not consume the invitee's creator quota. A pending or verified hostname belongs to exactly one project; another project cannot replace its challenge. The console hostname, custom-domain target, base domain, and the base-domain application namespace are reserved.

These are fixed installation-wide ceilings today. Account and organization limits are checked in the same SQLite write transactions as their inserts. Release limits are rechecked while holding the project's durable cross-control-plane lease, so concurrent deploys cannot bypass capacity. A hosted service can later resolve plan-specific limits before entering those transactions; billing state must never be the only enforcement layer.

## Release storage lifecycle

Each available release counts its extracted file sizes plus its pre-deploy SQLite rollback snapshot. The compressed upload size remains visible separately for protocol accounting. A deployment is rejected with `RELEASE_LIMIT_REACHED` or `RELEASE_STORAGE_LIMIT_REACHED` before activation when it would exceed either ceiling.

The active release cannot be cleaned. Removing the active release's immediate predecessor removes the one-click code target and the active release's matching pre-deploy data snapshot, so the API requires both the exact confirmation text and an explicit rollback-loss flag. Other inactive, failed, or crashed artifacts need the same exact confirmation but no rollback-loss override. Cleanup requires `rollback` permission and removes only runtime files and release-local rollback material; immutable release metadata, logs, and audit evidence remain.

On upgrade, pre-existing releases initialize storage accounting from their recorded upload bytes because older rows did not retain extracted-size totals. New deployments record the exact extracted file total and actual snapshot size. Operators that need exact accounting for old releases can clean obsolete artifacts or redeploy them.

## Ingress metrics

Metrics are recorded only for requests that pass through managed ingress. Clank stores one row per project and minute with:

- request count and 2xx/3xx/4xx/5xx counts;
- 5xx error count;
- latency sum, maximum, and cumulative `50`, `100`, `250`, `500`, `1000`, `2500`, `5000`, and `+Inf` millisecond buckets; and
- request bytes plus response bytes when the upstream declares `Content-Length`.

The p95 value is the upper bound of the matching fixed bucket, not a precomputed quantile. That makes buckets safely aggregatable across time, following the [Prometheus histogram model](https://prometheus.io/docs/practices/histograms/). Method names are normalized, and the persisted series has no path, hostname, email, or user labels, avoiding high-cardinality and personal-data growth. The HTTP names and duration/size concepts follow the [OpenTelemetry HTTP metric conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/).

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

- `GET /api/dashboard` — account, organizations, enforced limits, sites, 24-hour summaries, and domain-edge configuration.
- `GET /api/projects/:id/metrics?range=24h` — bounded metric summary and downsampled points.
- `GET /api/projects/:id/domains` — ownership, routing, observed DNS, TLS state, site limit, and reconciliation status.
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
- `GET /_clank/tls/ask?token=…&domain=…` — private Caddy permission lookup; not a customer API.

Browser mutations require same-origin session authentication and CSRF. CLI calls use bearer tokens, whose organization role and project scope are re-evaluated on every request.
