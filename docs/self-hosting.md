# Self-hosting Clank Deploy

Clank Deploy is one Node control-plane process plus one supervised process or container per active project.

## Requirements

- Node 22.16+;
- persistent local storage;
- HTTPS proxy outside loopback;
- Docker for mutually untrusted deployers;
- external master key and off-host backups for production.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4200` | Control-plane port |
| `HOST` | `127.0.0.1` | Listener address |
| `CLANK_PLATFORM_URL` | loopback URL | Exact public console origin |
| `CLANK_PLATFORM_DATA` | `.clank-platform` | Persistent root |
| `CLANK_PLATFORM_MASTER_KEY` | generated file | Base64/base64url 32-byte key |
| `CLANK_SIGNUP` | `bootstrap` | `bootstrap`, `public`, or `disabled` |
| `CLANK_RUNNER` | `process` | `process` or `docker` |
| `CLANK_DOCKER_IMAGE` | Node image | Pin by digest in production |
| `CLANK_APP_MEMORY` | `512m` | Container memory |
| `CLANK_APP_CPUS` | `1` | Container CPUs |
| `CLANK_APP_PIDS` | `128` | Container PID limit |
| `CLANK_APP_PORT_START` | `4300` | Port-range start |
| `CLANK_APP_PORT_END` | `4999` | Port-range end |
| `CLANK_APP_URL_TEMPLATE` | loopback with `{port}` | Public app URL pattern |
| `CLANK_MAX_ARTIFACT_BYTES` | `104857600` | Artifact limit |
| `CLANK_INGRESS` | inferred from base domain | Enable managed exact-host ingress |
| `CLANK_INGRESS_BASE_DOMAIN` | none | Built-in `slug.<base>` site namespace |
| `CLANK_CUSTOM_DOMAIN_TARGET` | base domain | CNAME target displayed to customers |
| `CLANK_CUSTOM_DOMAIN_ADDRESSES` | none | Comma-separated edge A/AAAA values accepted for apex routing |
| `CLANK_TLS_ASK_TOKEN` | none | Secret for the private Caddy certificate permission check |
| `CLANK_INGRESS_MAX_BODY_BYTES` | `26214400` | Per-request managed-ingress body limit |
| `CLANK_DOMAIN_RECHECK_INTERVAL_MS` | `300000` | Background custom-domain routing interval; `0` disables it |
| `CLANK_DOMAIN_RECHECK_BATCH_SIZE` | `25` | Maximum domains durably claimed by one routing pass |
| `CLANK_DOMAIN_RECHECK_TIMEOUT_MS` | `10000` | Per-domain DNS lookup deadline |
| `CLANK_BACKUP_INTERVAL_MS` | `86400000` | Verified encrypted-backup cadence; `0` disables automatic runs |
| `CLANK_BACKUP_BATCH_SIZE` | `5` | Maximum projects durably claimed by one backup pass |
| `CLANK_BACKUP_MAX_COUNT` | `30` | Maximum retained backups per project |
| `CLANK_BACKUP_MAX_AGE_MS` | `7776000000` | Maximum retained backup age |
| `CLANK_BACKUP_MAX_DATABASE_BYTES` | `10737418240` | Maximum source database size accepted by backup creation |
| `CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT` | `5` | Transactionally enforced account organization limit |
| `CLANK_MAX_PROJECTS_PER_ACCOUNT` | `10` | Transactionally enforced account-wide site limit |
| `CLANK_MAX_PROJECTS_PER_ORGANIZATION` | `10` | Transactionally enforced site limit |
| `CLANK_MAX_DOMAINS_PER_PROJECT` | `5` | Transactionally enforced custom-domain limit |
| `CLANK_METRICS_RETENTION_DAYS` | `30` | Ingress metric retention, 1–365 days |
| `CLANK_MAX_RELEASES_PER_PROJECT` | `50` | Retained runtime-artifact count per site |
| `CLANK_MAX_RELEASE_STORAGE_BYTES_PER_PROJECT` | `21474836480` | Uncompressed release files plus pre-deploy snapshots retained per site |
| `CLANK_ALLOW_UNSAFE_MIGRATIONS` | `0` | Operator approval for unrestricted SQL |
| `ALLOWED_HOSTS` | loopback | Exact host allowlist |
| `TRUST_PROXY` | `0` | Trust forwarded client/protocol |

`bootstrap` permits one initial account and then closes ordinary registration. Its SQLite claim is shared by control-plane processes using the same data directory. `disabled` blocks ordinary registration immediately. In both modes, an owner/admin-issued invitation can still create only its bound email account through **Use invitation**; revoke outstanding invitations before disabling all intended onboarding.

## Production start

```sh
export CLANK_PLATFORM_URL=https://deploy.example.com
export CLANK_PLATFORM_DATA=/var/lib/clank
export CLANK_PLATFORM_MASTER_KEY="$(your-secret-manager read clank-master-key)"
export CLANK_RUNNER=docker
export CLANK_DOCKER_IMAGE=node@sha256:<approved-digest>
export CLANK_APP_URL_TEMPLATE='https://{slug}.apps.example.com'
export CLANK_INGRESS=1
export CLANK_INGRESS_BASE_DOMAIN=apps.example.com
export CLANK_CUSTOM_DOMAIN_TARGET=edge.apps.example.com
export CLANK_CUSTOM_DOMAIN_ADDRESSES=192.0.2.10,2001:db8::10
export CLANK_TLS_ASK_TOKEN="$(your-secret-manager read clank-tls-ask-token)"
export HOST=127.0.0.1
export PORT=4200
export ALLOWED_HOSTS=deploy.example.com,127.0.0.1,localhost
export TRUST_PROXY=1

clank-platform
```

Proxy the console and application hosts to port 4200. Clank performs exact-host project routing; the edge performs public DNS, TLS, WAF/rate limiting, and DDoS controls. The recommended Caddy On-Demand TLS configuration and DNS records are in [Deployment dashboard, quotas, and domains](platform-dashboard.md).

Use `/livez` only to determine whether the process can answer HTTP. Use `/healthz` or `/readyz` for
control-host readiness. Hosted load balancers that send a different `Host` header should use
`/_clank/readyz`, which is evaluated before application-host ingress. These readiness endpoints
execute a control-database probe and return `503` when the platform cannot safely accept work.
`SIGINT` and `SIGTERM` stop new HTTP work, drain an active scheduled backup, close supervised
applications and platform storage, and fail the process if shutdown cannot finish within 30 seconds.

## Tailscale

```sh
CLANK_PLATFORM_URL=https://host.tailnet-name.ts.net:8447 \
HOST=127.0.0.1 PORT=4200 TRUST_PROXY=1 \
ALLOWED_HOSTS=host.tailnet-name.ts.net,localhost,127.0.0.1 \
clank-platform

tailscale serve --https=8447 http://127.0.0.1:4200
```

Expose app ports separately or place a wildcard-capable proxy in front.

## Railway

The checked-in production image, health/restart policy, persistent-volume topology, DNS setup, and
operator runbook are in [Railway production deployment](railway.md).

## Storage

```text
control.sqlite
master.key
projects/<id>/
  data/app.sqlite
  releases/<release-id>/
  backups/<release-id>.sqlite
  recovery/<backup-id>/
    database.enc
    manifest.json
```

Use a local filesystem with correct SQLite locking/rename semantics. The platform sets umask `0077`.

Clank automatically creates authenticated, AES-256-GCM encrypted recovery points under `recovery/`. Durable control-database claims prevent duplicate scheduled work when multiple control-plane processes share the store. Release count and byte ceilings separately bound retained extracted runtime files and pre-deploy rollback snapshots. Back up the control database, completed recovery directories, recoverable artifacts/source, and master key through separate paths. Pre-release snapshots remain rollback material, not part of the recovery retention policy. See [Backup and disaster recovery](recovery.md).

Permanent site deletion removes the complete matching `projects/<id>/` tree after symlink-safe validation, then removes its control rows and revokes project tokens. It does not reach copied/off-host backups, external databases, artifact mirrors, or Caddy certificate storage. Include those systems in tenant-retention and erasure runbooks, and preserve the control database if deletion audit history must remain available.

Audit rows live in `control.sqlite`, retain organization attribution after project removal, and upgrade in place from earlier schemas. The public API does not mutate them, but SQLite administrators can. Export them to a separate append-only audit system when control-plane operator tampering or longer retention is in scope.

Authentication and CLI device-start rate-limit windows also live in `control.sqlite`. Their client/account keys are HMAC pseudonyms under the platform master key, expire automatically, and remain effective when requests move between control-plane processes or the process restarts. The table is bounded, so keep the console behind production edge rate limiting and DDoS controls.

## Upgrades

1. Back up data and key.
2. Stop new deploys and the platform.
3. Install and verify the new Clank build.
4. Start the selected active supervisor/worker topology.
5. Verify browser login, CLI login, organization and scoped-token access, project status, ingress/domain state, app health, test deploy, backup verification, rollback, and a disposable-site deletion.

Durable distributed locks, authenticated nodes, desired generations, operations/fencing, wildcard base-domain routing, ownership and routing verification, Caddy certificate eligibility, ingress metrics, enforced account/organization/site/domain limits, organization RBAC, scheduled encrypted backups, and external database drivers are implemented. The included child-process supervisor remains single-leader and artifacts/backups are local by default; a hosted multi-region service still needs leader/remote-runner integration, external object storage, globally transactional control storage, shared metric storage, and a multi-region edge service.
