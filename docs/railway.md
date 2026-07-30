# Railway production deployment

This profile runs the Clank control plane and its trusted application processes in one Railway
service. Railway terminates TLS and forwards every control-plane and application hostname to the
same listener; Clank then routes application hosts to their supervised loopback processes.

## Topology

```text
clank.run ───────────────┐
*.apps.clank.run ────────┼─ Railway edge ─ Clank control plane :$PORT
approved custom domains ┘                    ├─ app :4300 ─ projects/<id>/data/app.sqlite
                                             ├─ app :4301 ─ projects/<id>/data/app.sqlite
                                             └─ /data/control.sqlite

Railway volume mounted at /data
```

The production entry point automatically reserves Railway's assigned `$PORT` from the application
allocator. If a prior configuration persisted that listener port on a project, startup moves the
project to the first free application port before recovering its active release.

Use exactly one replica. Clank's control database and each application database use SQLite, and the
included application supervisor is single-leader. Horizontal replicas need the external storage,
leader, and infrastructure execution integrations described in [Self-hosting](self-hosting.md).

## Repository configuration

- `Dockerfile` builds the dependency-free TypeScript sources and copies only the production
  control-plane runtime into the final image.
- `railway.json` selects the Dockerfile, probes storage-backed `/_clank/readyz`, gives graceful
  shutdown 30 seconds, and restarts failed processes. The reserved path is checked before
  application-host dispatch because Railway sends its own health-check hostname.
- A Railway volume must be mounted at `/data`.

The service needs these variables:

```sh
HOST=0.0.0.0
NODE_ENV=production
TRUST_PROXY=1
CLANK_PLATFORM_URL=https://clank.run
CLANK_PLATFORM_DATA=/data
CLANK_PLATFORM_MASTER_KEY=<base64url-encoded 32-byte secret>
CLANK_PLATFORM_ADMIN_EMAILS=operator@example.com
CLANK_SIGNUP=bootstrap
CLANK_HOSTING_PROFILE=trusted
CLANK_RUNNER=process
CLANK_INGRESS=1
CLANK_INGRESS_BASE_DOMAIN=apps.clank.run
CLANK_APP_URL_TEMPLATE=https://{slug}.apps.clank.run
CLANK_CUSTOM_DOMAIN_TARGET=apps.clank.run
CLANK_MAX_PROJECTS_PER_ACCOUNT=10
CLANK_MAX_PROJECTS_PER_ORGANIZATION=10
CLANK_MAX_DOMAINS_PER_PROJECT=5
CLANK_METRICS_RETENTION_DAYS=30
CLANK_BACKUP_INTERVAL_MS=86400000
CLANK_BACKUP_MAX_COUNT=30
CLANK_BACKUP_MAX_AGE_MS=7776000000
CLANK_ALLOW_UNSAFE_MIGRATIONS=0
```

Leave `CLANK_RUNNER_REGISTRATION_TOKEN` unset on the current single-service topology. Enabling the
remote-node coordinator does not improve isolation by itself and is unnecessary until a separate
runner host is provisioned.

Do not put `CLANK_PLATFORM_MASTER_KEY` in source control. Back it up separately from the volume:
losing it makes encrypted secrets and recovery points unreadable.

`bootstrap` lets the first browser user create the only public account, then closes registration.
Additional people join through email-bound invitations created by an owner or administrator.
The explicit `trusted` hosting profile is required because Railway's hosted container does not
provide a Docker daemon. It preserves the inexpensive single-service topology, but every invited
deployer must be treated as having the control-plane Unix user's authority. Do not change
`CLANK_SIGNUP` to `public` on this topology; the control plane refuses that unsafe combination.
`CLANK_PLATFORM_ADMIN_EMAILS` is an exact, comma-separated operator allowlist. Matching accounts
receive the separate `platform_admin` role; removing an address revokes that role on the next
control-plane start. Global administration is available only to an interactive browser session,
never to a CLI bearer token. After signing in, an allowlisted operator can open `/admin` for
installation-wide analytics and the redacted account directory. Read-only support impersonation is
short-lived, recent-auth gated, reason-bound, visibly labeled, and audited; it is not a substitute
for limiting and protecting the operator allowlist.

The same `/admin` page includes a live memory-attribution panel. It samples the Linux cgroup and
each supervised process, ranks hosted applications by proportional set size (PSS, with RSS as a
fallback), and reports the control-plane V8 heap, process peaks, swap, page cache, kernel memory,
and memory that cannot be attributed to a tracked process. PSS apportions shared pages instead of
counting the same page once per process. The panel is a current snapshot; Railway's metrics retain
the historical container-level series. Application rows identify web, worker, and scheduler roles
and worker instance numbers. Process and cgroup files are sampled close together but not atomically,
so their totals can differ slightly while memory is changing.

The storage-attribution panel compares the mounted filesystem's used blocks with a bounded,
link-safe scan of Clank's data root. It separates the control database and WAL, each project's
database, retained release artifacts, migration rollback snapshots, encrypted recovery backups,
orphaned project directories, and other filesystem allocation. The scan reports both completeness
and any unaccounted filesystem space, so an operator can distinguish application growth from
filesystem metadata or data outside Clank's known layout. Railway's volume metric remains the
historical source for the overall growth curve. The two totals are intentionally not expected to
match: [Railway reserves approximately 2–3% of every volume for filesystem
metadata](https://docs.railway.com/volumes/reference), which appears in Railway's block-level
metric but is outside the mounted filesystem usage Clank can inspect. A 50 GB volume can therefore
start with roughly 1–1.5 GB reported by Railway even when application files are nearly empty.

Leave `CLANK_RUNNER_REGISTRATION_TOKEN` unset for the inexpensive single-service topology. Enabling
remote-node enrollment retains one additional compressed upload for each new release so an exact
leased artifact can be transferred to another host; that copy is included in project release
quotas and the storage-attribution panel. Set `CLANK_RUNNER_MAX_ARTIFACT_BYTES` deliberately before
enabling enrollment.

For independent deployment nodes, create a Railway Bucket only when needed, reference its
S3-compatible variables into the control-plane service, and set:

```sh
CLANK_RUNNER_ARTIFACT_STORE=s3
CLANK_RUNNER_ARTIFACT_NAMESPACE=railway-production-v1
CLANK_OBJECT_ENDPOINT=<reference the bucket ENDPOINT>
CLANK_OBJECT_REGION=<reference the bucket REGION>
CLANK_OBJECT_BUCKET=<reference the bucket BUCKET>
CLANK_OBJECT_ACCESS_KEY_ID=<reference the bucket ACCESS_KEY_ID>
CLANK_OBJECT_SECRET_ACCESS_KEY=<reference the bucket SECRET_ACCESS_KEY>
CLANK_OBJECT_PREFIX=clank-production
```

Map Railway's provided `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, and
`SECRET_ACCESS_KEY` values into the corresponding `CLANK_OBJECT_*` service variables with Railway
variable references. New runner uploads then leave the mounted volume; existing release runtime
directories, databases, snapshots, backups unless separately configured, and legacy uploads remain
local.

The same private bucket can hold encrypted database recovery points under a separate logical root:

```sh
CLANK_BACKUP_STORE=s3
CLANK_BACKUP_NAMESPACE=railway-recovery-v1
CLANK_BACKUP_PREFIX=backups
CLANK_BACKUP_CHUNK_BYTES=8388608
```

This does not require remote runners. Clank uploads bounded encrypted chunks, verifies a completed
copy before removing its local committed copy, and retains a local copy whenever promotion fails.
The control database binds the repository namespace and root so a missing Railway variable fails
startup instead of presenting an empty backup list. Back up the control database and master key
separately; the bucket alone cannot decrypt or associate recovery points.

Clank never creates a bucket automatically. The current single-service `clank.run` production
topology deliberately stays on local release and backup storage until its measured recovery need
justifies the additional managed resource. If both switches are enabled later, reuse one bucket
and installation prefix to stay inexpensive, then monitor service egress and stored bytes.

## Domains

Attach both `clank.run` and `*.apps.clank.run` to the Railway service. Publish every routing, ACME,
and TXT validation record Railway returns.

`clank.run` is registered with and delegated to Vercel DNS. Replace Vercel's default apex and
wildcard routing aliases while preserving its CAA records:

- add an apex `ALIAS` targeting the hostname Railway supplies for `clank.run`;
- add the `*.apps` and `_acme-challenge.apps` CNAME records Railway supplies;
- add the `_railway-verify` and `_railway-verify.apps` TXT records Railway supplies.

The wildcard gives every project an immediate `https://<slug>.apps.clank.run` URL. Railway must also
know about a customer-owned custom domain before its edge can issue a certificate for that host.
For the current single-tenant deployment, add the hostname to the same service with:

```sh
railway domain customer.example --service clank
```

Then publish Railway's validation records plus the ownership record shown in the Clank console.
Clank will route the host only after both ownership and routing checks succeed.

## First account and CLI

1. Open `https://clank.run` and create the bootstrap owner with a unique password of at least 8
   characters.
2. In a local checkout, start browser-assisted device authorization:

   ```sh
   clank login
   ```

3. Create or scaffold an application and deploy it:

   ```sh
   clank create my-app
   cd my-app
   clank deploy
   ```

`clank create` scaffolds the authenticated to-do starter by default, including its migrations and
deployment manifest.

Each project receives a separate directory and SQLite database under `/data/projects/<project-id>`.
Database migrations are planned and applied by Clank during deployment; a failed health check or
migration leaves the active release unchanged.

Code-only application deployments are rolling inside the Railway container. Clank starts the
candidate on a spare loopback port, waits for its health check, switches managed ingress, and then
drains the prior release. Pending SQLite migrations retain a short exclusive maintenance window;
use an external database with expand/contract migrations when the schema must change without one.

Managed application processes receive reserved runtime values, including
`TRUST_PROXY=1`, an empty `ALLOWED_HOSTS`, and `CLANK_MANAGED_INGRESS=1`.
Together they let the Node adapter reconstruct each canonical or verified
custom-domain origin while the loopback-only ingress remains responsible for
exact host admission. Application manifests cannot override these values.

## Operations

Before each framework upgrade, download or snapshot the Railway volume and preserve the external
master key. After deployment, verify:

```sh
curl --fail https://clank.run/livez
curl --fail https://clank.run/readyz
curl --fail https://clank.run/_clank/readyz
railway logs --service clank --lines 100
railway metrics --service clank --since 1h --cpu --memory
railway metrics --service clank --since 24h --memory --raw --json
railway metrics --service clank --since 7d --volume
railway metrics --service clank --since 7d --volume --raw --json
```

Also verify browser session refresh, CLI device authorization, a disposable deployment, its
wildcard application URL, backup creation, rollback, and permanent deletion.

Railway's memory metric covers the complete service cgroup: the Clank supervisor, hosted
application web/worker/scheduler processes, native SQLite allocations, filesystem cache, and kernel bookkeeping. Use
the `/admin` memory panel to explain the current total and the Railway series to identify growth
across deploys. A process-runner application has direct per-process attribution. In Docker-runner
installations, the listed child can be the Docker client wrapper, so container-runtime metrics
remain the authoritative per-application source.

Railway does not overlap deployments that mount the same volume, even when a health check is
configured. The production entry point therefore binds the control-plane listener without waiting
for every project runtime to recover, starts those runtimes concurrently in the background, and
drains HTTP, live streams, applications, backups, and storage concurrently on `SIGTERM`. This
minimizes the unavoidable volume handoff. A truly zero-downtime control-plane image rollout
requires moving control data, release artifacts, application data, and runners off the mounted
local volume so the Railway service can run multiple stateless replicas.

The Railway deployment uses Clank's `process` runner because hosted Railway containers do not expose
a Docker daemon. This runner is intentionally for trusted deployers: application code runs with the
same container and volume authority as the control plane. Use Clank's Docker runner or a remote
sandbox worker before opening deployment access to mutually untrusted users. The required
`CLANK_HOSTING_PROFILE=trusted` setting is a visible acknowledgement of that boundary, not an
isolation mechanism.
