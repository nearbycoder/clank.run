# Self-hosting Clank Deploy

Clank Deploy is one Node control-plane process plus a supervised web process/container and any
configured worker/scheduler processes for each active project.

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
| `CLANK_HOSTING_PROFILE` | `isolated` in production; `trusted` otherwise | Declared application trust boundary |
| `CLANK_RUNNER` | selected by hosting profile | `process` or `docker` |
| `CLANK_DOCKER_IMAGE` | Node image | Pin by digest in production |
| `CLANK_APP_MEMORY` | `512m` | Container memory |
| `CLANK_APP_CPUS` | `1` | Container CPUs |
| `CLANK_APP_PIDS` | `128` | Container PID limit |
| `CLANK_RUNNER_COORDINATOR` | `0` | Set to `1` to enable the coordinator and administrator-created one-time enrollment |
| `CLANK_RUNNER_REGISTRATION_TOKEN` | none | Optional legacy shared coordinator enrollment secret |
| `CLANK_RUNNER_MAX_REQUEST_BYTES` | `131072` | Remote-node protocol request limit |
| `CLANK_RUNNER_MAX_ARTIFACT_BYTES` | `104857600` | Leased remote-node release-transfer limit |
| `CLANK_RUNNER_ARTIFACT_STORE` | `local` | Original remote-runner upload repository: `local` or `s3` |
| `CLANK_RUNNER_ARTIFACT_NAMESPACE` | none | Required stable repository identity when the store is `s3` |
| `CLANK_OBJECT_ENDPOINT` | `AWS_ENDPOINT_URL` | S3-compatible HTTPS origin |
| `CLANK_OBJECT_REGION` | `AWS_DEFAULT_REGION` | SigV4 region, commonly `auto` for compatible providers |
| `CLANK_OBJECT_BUCKET` | `AWS_S3_BUCKET_NAME` | Private bucket name |
| `CLANK_OBJECT_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | Bucket-scoped access-key ID |
| `CLANK_OBJECT_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | Bucket-scoped secret access key |
| `CLANK_OBJECT_SESSION_TOKEN` | `AWS_SESSION_TOKEN` | Optional signed temporary-credential token |
| `CLANK_OBJECT_PREFIX` | none | Optional private installation prefix |
| `CLANK_OBJECT_PATH_STYLE` | `0` | Use path-style compatible URLs when `1` |
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
| `CLANK_BACKUP_STORE` | `local` | Encrypted recovery repository: `local` or `s3` |
| `CLANK_BACKUP_NAMESPACE` | none | Required stable repository identity for object backups |
| `CLANK_BACKUP_PREFIX` | `backups` | Logical backup root inside the object-store prefix |
| `CLANK_BACKUP_CHUNK_BYTES` | `8388608` | Encrypted bytes per object, from 64 KiB through 64 MiB |
| `CLANK_JOB_ALERT_DUE_AFTER_MS` | `300000` | Waiting time before due work raises a control-plane attention state |
| `CLANK_PREVIEW_DEFAULT_TTL_MS` | `604800000` | Default preview lifetime |
| `CLANK_PREVIEW_MAX_TTL_MS` | `2592000000` | Maximum preview lifetime callers may request |
| `CLANK_PREVIEW_CLEANUP_INTERVAL_MS` | `300000` | Expired-preview cleanup cadence; `0` delegates cleanup to an external operator |
| `CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT` | `5` | Transactionally enforced account organization limit |
| `CLANK_MAX_PROJECTS_PER_ACCOUNT` | `10` | Transactionally enforced account-wide site limit |
| `CLANK_MAX_PROJECTS_PER_ORGANIZATION` | `10` | Transactionally enforced site limit |
| `CLANK_MAX_DOMAINS_PER_PROJECT` | `5` | Transactionally enforced custom-domain limit |
| `CLANK_METRICS_RETENTION_DAYS` | `30` | Ingress metric retention, 1–365 days |
| `CLANK_MAX_RELEASES_PER_PROJECT` | `50` | Retained runtime-artifact count per site |
| `CLANK_MAX_RELEASE_STORAGE_BYTES_PER_PROJECT` | `21474836480` | Uncompressed release files plus pre-deploy snapshots retained per site |
| `CLANK_MAX_REQUESTS_PER_MONTH_PER_ORGANIZATION` | `5000000` | Admitted managed-ingress requests per workspace UTC month |
| `CLANK_MAX_TRANSFER_BYTES_PER_MONTH_PER_ORGANIZATION` | `107374182400` | Known request plus declared-response bytes per workspace UTC month |
| `CLANK_MAX_REQUESTS_PER_MINUTE_PER_PROJECT` | `3000` | Admitted managed-ingress requests per project UTC minute |
| `CLANK_USAGE_RETENTION_MONTHS` | `24` | Monthly usage retention, 1–120 months |
| `CLANK_ALLOW_UNSAFE_MIGRATIONS` | `0` | Operator approval for unrestricted SQL |
| `ALLOWED_HOSTS` | loopback | Exact host allowlist |
| `TRUST_PROXY` | `0` | Trust forwarded client/protocol |

`clank-platform` always reserves its own `PORT` from the application range. Persisted projects
that conflict with that listener are assigned the first free application port during startup.
Embedders calling `openPlatform()` directly should pass infrastructure listeners through
`reservedAppPorts`.

`bootstrap` permits one initial account and then closes ordinary registration. Its SQLite claim is shared by control-plane processes using the same data directory. `disabled` blocks ordinary registration immediately. In both modes, an owner/admin-issued invitation can still create only its bound email account through **Use invitation**; revoke outstanding invitations before disabling all intended onboarding.

Monthly request and transfer controls require managed ingress. Keep supervised application ports
on loopback or a private network; traffic routed directly to those ports is neither metered nor
limited. The transfer ledger includes request bodies and only responses with a declared
`Content-Length`, so streamed-response cost ceilings still belong at the application or public
edge. See [Usage accounting and traffic limits](usage-and-limits.md).

## Choose the hosting trust boundary

Clank makes the application-code boundary explicit before it opens storage or starts listening:

| Profile | Default runner | Intended use | Signup |
| --- | --- | --- | --- |
| `isolated` | Docker | Mutually untrusted deployers and public hosting | `bootstrap`, `disabled`, invitations, or `public` |
| `trusted` | Process | One operator, a trusted team, or an invited cohort whose code the host accepts as its own | `bootstrap`, `disabled`, or invitations |

`NODE_ENV=production` defaults to `isolated`; development defaults to `trusted` so a local checkout
remains zero-setup. An explicit `CLANK_RUNNER=docker` also selects the isolated profile. Process
execution in production therefore requires both:

```sh
CLANK_HOSTING_PROFILE=trusted
CLANK_RUNNER=process
```

The trusted profile is a cost and compatibility option, not a sandbox. Every deployed web, worker,
and scheduler process has the platform Unix user's authority over the host. Clank refuses
`CLANK_SIGNUP=public` in this profile. Invitations remain available because the operator explicitly
chooses each deployer and accepts that trust relationship.

The isolated profile refuses the process runner. Docker remains the minimum supported boundary,
not a claim that containers are equivalent to dedicated VMs. Public hosts should additionally pin
the runtime image by digest, restrict egress, keep the daemon socket unavailable to applications,
and use dedicated nodes or microVMs for hostile workloads.

Unknown profile or runner values are fatal. This is intentional: a misspelled isolation setting
must never fall back to process execution.

## Optional remote-node coordination

Keep the runner API disabled on a single-host installation. To let deployment nodes coordinate
without direct control-database access, enable the coordinator:

```sh
export CLANK_RUNNER_COORDINATOR=1
```

This enables only `/api/runner/v1/*` on the control-plane hostname. It does not grant browser, CLI,
project, application, or MCP access. A platform administrator creates an expiring, one-time,
node-and-region-bound `clnke_...` enrollment in `/admin`. A node exchanges it for its own
`clnka_...` credential; the control database stores only digests. The plaintext enrollment is
shown once and should be removed from the node after provisioning.

The coordinator transport is useful on one host, a private network, or multiple runner hosts.
`openDeploymentAgent` supplies the authenticated heartbeat, claim, lease, fencing, and drain
lifecycle, and leased nodes can retrieve verified release archives retained after enrollment is
enabled. `openProviderDeploymentAgent` adds the strict `DeploymentProvider` reconciliation
contract, while `clank-runner` connects it to the authenticated binary HTTP bridge:

```sh
export CLANK_CONTROL_URL=https://deploy.example.com
export CLANK_RUNNER_NODE_ID=runner-01
export CLANK_RUNNER_REGION=us-central
export CLANK_RUNNER_REGISTRATION_TOKEN="$(your-secret-manager read one-time-runner-enrollment)"
export CLANK_RUNNER_CREDENTIALS=/var/lib/clank-runner/credentials.json
export CLANK_PROVIDER_URL=https://runtime.internal.example
export CLANK_PROVIDER_TOKEN="$(your-secret-manager read runtime-provider)"
clank-runner
```

The operator still supplies the provider host and edge routing; local SQLite data is never placed
in the non-secret release transfer. The separate runtime capsule carries final environment,
SQLite placement, and ingress identity. The packaged [complete provider
service](provider-service.md) safely composes its data, isolated Docker runtime, durable fencing,
and private ingress on that host. The current built-in supervisor keeps the capsule inactive until
stateful node pinning, independent recovery, and control-plane traffic switching are integrated.
Use the protocol as the secure boundary for a deliberate runner integration and follow
[Deployment runner fleet](runner-fleet.md),
[Remote runtime placement](runtime-placement.md),
[Deployment provider adapters](provider-adapters.md),
[Provider data lifecycle](provider-data-lifecycle.md),
[Complete deployment provider service](provider-service.md),
[Provider runtime ingress](provider-runtime-ingress.md), and
[Durable distributed deployment](distributed-deployment.md).

### Optional off-host release uploads

Remote enrollment uses the private data volume by default. To retain new original uploads through
an S3-compatible store, enable the coordinator and configure the explicit repository together:

```sh
export CLANK_RUNNER_COORDINATOR=1
export CLANK_RUNNER_ARTIFACT_STORE=s3
export CLANK_RUNNER_ARTIFACT_NAMESPACE=production-releases-v1
export CLANK_OBJECT_ENDPOINT=https://objects.example.com
export CLANK_OBJECT_REGION=auto
export CLANK_OBJECT_BUCKET=clank-releases
export CLANK_OBJECT_ACCESS_KEY_ID="$(your-secret-manager read object-access-key)"
export CLANK_OBJECT_SECRET_ACCESS_KEY="$(your-secret-manager read object-secret-key)"
export CLANK_OBJECT_PREFIX=installation-01
```

The namespace is a persisted operator identity, not a bucket credential. Keep it stable while old
releases exist. If the endpoint, bucket, credentials, or prefix must move, copy the objects while
preserving keys and keep the same namespace; use a new namespace only for a genuinely different
repository. Clank refuses old object reads and destructive cleanup when the configured namespace
does not match, allowing the operator to restore the correct configuration without losing
metadata.

New uploads use object storage; runtime directories, databases, pre-migration snapshots, recovery
backups unless separately configured below, and legacy local uploads remain under
`CLANK_PLATFORM_DATA`. Provider failures
are privately reported and returned as stable deployment errors. Cleanup attempts the remote
deletion only after local paths pass containment and symlink checks. The external delete and local
filesystem removal cannot share one transaction, so monitor failed cleanup and retry with the same
repository configuration. See [Object storage](object-storage.md).

### Optional off-host encrypted backups

Release transport and database recovery are independent switches. To move new encrypted recovery
points outside the platform volume, reuse the private S3-compatible connection above and add:

```sh
export CLANK_BACKUP_STORE=s3
export CLANK_BACKUP_NAMESPACE=production-recovery-v1
export CLANK_BACKUP_PREFIX=backups
export CLANK_BACKUP_CHUNK_BYTES=8388608
```

No runner enrollment token is required. Every project gets its own authenticated catalog below
`<backup-prefix>/<project-id>/`. Encrypted envelopes are uploaded in bounded chunks and verified
end to end before the local completed copy is removed. Existing local backups are promoted before
the next new backup; failed promotions leave their local recovery copy intact.

On first use, `control.sqlite` binds the repository namespace and logical backup root. Removing or
changing either setting then fails startup instead of silently showing an empty history. Preserve
the binding, master key, and object keys together during a provider migration. Permanent project
deletion removes platform-managed object backups as well as local project state; manually copied
or provider-retained versions remain the operator's responsibility. See
[Backup and disaster recovery](recovery.md).

## Production start

```sh
export CLANK_PLATFORM_URL=https://deploy.example.com
export CLANK_PLATFORM_DATA=/var/lib/clank
export CLANK_PLATFORM_MASTER_KEY="$(your-secret-manager read clank-master-key)"
export CLANK_HOSTING_PROFILE=isolated
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
  recovery/<backup-id>/       # completed local mode or pending object promotion
    database.enc
    manifest.json
```

Use a local filesystem with correct SQLite locking/rename semantics. The platform sets umask `0077`.

Clank automatically creates authenticated, AES-256-GCM encrypted recovery points. Local mode keeps
them under `recovery/`; object mode uses that directory only for private staging, legacy copies,
and failed promotions. Durable control-database claims prevent duplicate scheduled work when
multiple control-plane processes share the store. Release count and byte ceilings separately bound
retained extracted runtime files and pre-deploy rollback snapshots. Back up the control database,
recovery repository, recoverable artifacts or source, and master key through separate paths.
Pre-release snapshots remain rollback material, not part of the recovery retention policy. See
[Backup and disaster recovery](recovery.md).

Permanent site deletion removes platform-managed object backup chunks and catalog entries, remote
runner artifacts, and the complete matching `projects/<id>/` tree before it removes control rows and
revokes project tokens. It does not discover manual copies, provider-retained object versions,
external databases, unrelated artifact mirrors, or Caddy certificate storage. Include those systems
in tenant-retention and erasure runbooks, and preserve the control database if deletion audit
history must remain available.

Audit rows live in `control.sqlite`, retain organization attribution after project removal, and upgrade in place from earlier schemas. The public API does not mutate them, but SQLite administrators can. Export them to a separate append-only audit system when control-plane operator tampering or longer retention is in scope.

Authentication and CLI device-start rate-limit windows also live in `control.sqlite`. Their client/account keys are HMAC pseudonyms under the platform master key, expire automatically, and remain effective when requests move between control-plane processes or the process restarts. The table is bounded, so keep the console behind production edge rate limiting and DDoS controls.

## Upgrades

1. Back up data and key.
2. Stop new deploys and the platform.
3. Install and verify the new Clank build.
4. Start the selected active supervisor/worker topology.
5. Verify browser login, CLI login, organization and scoped-token access, project status, ingress/domain state, app health, test deploy, backup verification, rollback, and a disposable-site deletion.

Durable distributed locks, authenticated nodes, the generic deployment-agent lifecycle, desired
generations, operations/fencing, wildcard base-domain routing, ownership and routing verification,
Caddy certificate eligibility, ingress metrics, enforced account/organization/site/domain limits,
organization RBAC, scheduled encrypted backups, and external database drivers are implemented. The
included child-process supervisor remains single-leader and artifacts/backups are local by default;
a hosted multi-region service still needs leader integration, an infrastructure-specific remote
execution adapter, external object storage, globally transactional control storage, shared metric
storage, and a multi-region edge service.
