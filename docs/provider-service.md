# Complete deployment provider service

`@clank.run/framework/provider-service` composes Clank's provider data store, isolated Docker
launcher, and generation-bound private ingress into one restart-safe `DeploymentProvider`. It is
the recommended provider implementation when self-hosting remote application compute.

The service remains a separate trusted-compute process, while the built-in control plane can now
assign explicit provider projects to it through a statefully pinned `clank-runner`. The control
plane publishes managed edge traffic only after this service and the runner report the exact
release generation as observed.

## Run the packaged provider

`clank-provider` exposes both the authenticated lifecycle bridge and generation-bound private
runtime ingress, so the reference Docker stack needs no application glue:

```sh
export HOST=0.0.0.0
export PORT=4600
export ALLOWED_HOSTS=runtime.internal.example
export CLANK_PROVIDER_DATA=/var/lib/clank-provider
export CLANK_PROVIDER_OWNER=provider-us-central-01
export CLANK_PROVIDER_IMAGE='registry.example/clank-node@sha256:<64-hex-digest>'
export CLANK_PROVIDER_TOKEN="$(secret read clank-runtime-provider)"
export CLANK_PROVIDER_MEMORY=512m
export CLANK_PROVIDER_CPUS=1
export CLANK_PROVIDER_PIDS=128
clank-provider
```

The provider process must use a private persistent volume and a private/TLS network path. Run it
as a dedicated non-root Unix account so the default container uid/gid can write only the provider
files it owns. `clank-provider --help` lists capacity, port, database, capsule, Docker, and drain
bounds. Mutable application image tags are rejected unless the operator explicitly enables the
development-only escape hatch.

Large capsule uploads have an independent request-receive deadline. Tune
`CLANK_PROVIDER_HTTP_REQUEST_TIMEOUT_MS` for the slowest private link instead of weakening
application timeouts. `CLANK_PROVIDER_MAX_ARTIFACT_BYTES` bounds legacy artifacts,
`CLANK_PROVIDER_MAX_RUNTIME_BYTES` bounds sensitive runtime capsules, and
`CLANK_PROVIDER_INGRESS_TIMEOUT_MS` separately limits application responses.

Point the packaged runner at this origin with a different authority for control-plane enrollment:

```sh
export CLANK_CONTROL_URL=https://deploy.example.com
export CLANK_RUNNER_NODE_ID=provider-us-central-01
export CLANK_RUNNER_ENDPOINT=https://runtime.internal.example
export CLANK_PROVIDER_URL=https://runtime.internal.example
export CLANK_PROVIDER_TOKEN="$(secret read clank-runtime-provider)"
clank-runner
```

The same provider token is shared only by this runner and provider bridge. It is not a Clank
account, CLI, node, application, or platform-master credential.

## Open the complete stack

One factory creates the provider data lifecycle, removes exact-owner Docker orphans, creates the
private ingress registry, and opens durable desired-state fencing:

```ts
import {
  openDockerDeploymentProviderService,
} from "@clank.run/framework/provider-service";
import {
  createDeploymentProviderHandler,
} from "@clank.run/framework/provider";

const service = await openDockerDeploymentProviderService({
  rootDirectory: "/var/lib/clank-provider",
  owner: "runner-west-01",
  image: "registry.example/clank-node@sha256:<64-hex-digest>",
  data: {
    maxDatabaseBytes: 512 * 1024 * 1024,
  },
  docker: {
    memory: "512m",
    cpus: "1",
    pidsLimit: 128,
    maxRuntimes: 100,
    maxContainers: 400,
  },
  ingress: {
    timeoutMs: 30_000,
    maxBodyBytes: 25 * 1024 * 1024,
  },
  onError(error) {
    privateProviderLog(error);
  },
});

const reconciliation = createDeploymentProviderHandler(service, {
  token: process.env.CLANK_PROVIDER_TOKEN!,
  onError(error) {
    privateProviderLog(error);
  },
});
```

Mount `reconciliation.handle(request)` only at its fixed authenticated `POST`
`/v1/clank/reconcile`, `/v1/clank/rollback`, and `/v1/clank/delete` paths. Route the
provider-private application path to `service.handle(request)`. Terminate TLS in front of both,
restrict network admission to the runner and managed edge respectively, and never expose
application loopback ports.

Pass the service directly to `openProviderDeploymentAgent()` for an in-process runner, or run the
packaged `clank-runner` against the authenticated provider handler. No provider SDK, npm
dependency, database service, or paid control-plane resource is required.

## What one reconcile does

For a running `clank-runtime/1` desired generation, the service:

1. independently hashes, bounds, decodes, and binds the capsule before persisting intent;
2. atomically records the exact operation ID, monotonic fence, generation, release, and capsule
   digest in owner-only provider state;
3. revokes and drains any mismatched private route before stopping its writer;
4. recovers an interrupted data journal only after the old runtime is proven quiescent;
5. stages the immutable release, applies SQLite restore/migrations behind a safety snapshot, and
   launches only the private web candidate for health validation;
6. commits provider data metadata, then starts the deferred workers and scheduler;
7. publishes the exact project/release/generation/path/token binding to private ingress; and
8. records the generation as running only after the complete runtime is reachable.

The order is intentional. Workers cannot perform queue or cron work against an uncommitted
database. If metadata commit fails after web health, the data store invokes candidate cleanup
before restoring SQLite. If cleanup cannot be proven, it leaves the recovery journal intact
instead of changing database bytes under a possibly live process.

A stopped desired generation revokes new traffic, waits for assigned response streams, stops the
runtime, verifies removal, and durably records the stopped high-water mark. It preserves provider
data for a later restart, backup, rollback, or explicit deletion.

## Retry and crash behavior

The service persists no environment values, ingress tokens, application output, loopback origins,
or Docker identifiers. Its state contains only:

- project and operation IDs;
- fence and desired generation;
- running/stopped state and release ID;
- capsule SHA-256;
- reconciliation phase and timestamp.

An exact response-lost retry re-verifies the capsule and immutable release. If the matching data,
runtime, and ingress are still active, launch and activation are idempotent and traffic is not
drained. A lower generation, lower fence, conflicting operation at the same fence, or different
release/capsule at the same generation fails before infrastructure mutation.

After process or host restart, the ingress registry starts empty and the Docker launcher removes
only exact-owner orphan containers. The durable service state may say `running`, but it never
causes process adoption. The coordinator must replay the current capsule; the service recognizes
the committed data, starts a new candidate, activates its complete process topology, and restores
the private route.

If data commits but background or ingress activation fails, the candidate is removed and the
durable phase remains `reconciling`. An exact retry uses the already-committed release without
replaying migrations and attempts activation again.

## Inspection, rollback, deletion, backups, and shutdown

`inspect(projectId)` returns the durable non-secret state above. `snapshot(projectId)` delegates
to the provider data store's consistent SQLite backup and is intended to feed an independently
encrypted recovery repository. Both calls serialize with lifecycle work for the project and reject
new work after the service starts closing.

### Remote snapshot boundary

A runtime capsule may carry a separate high-entropy `ingress.controlToken`. The complete service
keeps only its SHA-256 in memory for the active generation; it never places the token in provider
state, Docker metadata, application environment, public ingress, or logs. When present, the
service exposes the exact private path returned by
`deploymentProviderSnapshotPath(projectId)`:

```http
GET /v1/clank/control/<project-id>/snapshot
Authorization: Bearer <generation-control-token>
```

The request succeeds only while the token, durable service state, active release, and active
generation all agree. It serializes with lifecycle work, asks the data store for a consistent
SQLite snapshot, rechecks the generation and SHA-256, and returns
`application/vnd.clank.provider-snapshot` with exact length, digest, release, and generation
headers. Missing, malformed, old, restarted-without-reconcile, stopped, or deleted bindings return
a fixed non-enumerating response. Query strings and non-`GET` methods are rejected.

This endpoint returns plaintext SQLite bytes and belongs only on the authenticated private TLS
provider origin. The control token is an authorization secret, not transport encryption. Never
mount the control prefix through an application's public domain or managed app route. The
receiving control plane must enforce response deadlines and byte limits, refuse redirects, verify
all identity headers and the body digest, and immediately import the bytes into an encrypted
recovery repository. The low-level service provides this boundary; whether a particular
control-plane release consumes it is documented separately in [Remote runtime
placement](runtime-placement.md#current-support-boundary).

### Remote diagnostics boundary

The same active control-token binding exposes the exact path returned by
`deploymentProviderDiagnosticsPath(projectId)`:

```http
GET /v1/clank/control/<project-id>/diagnostics?logs=200
Authorization: Bearer <generation-control-token>
Accept: application/vnd.clank.provider-diagnostics+json
```

The complete Docker launcher retains at most 128 KiB and 1,000 entries of live attached
stdout/stderr in provider-process memory. It stores no output in service state. One diagnostics
request asks Docker for one non-streaming sample covering every tracked web, worker, and scheduler
container in the project. The response contains role/instance identity, running state, current and
limit memory, CPU percentage, PIDs, cumulative network and block I/O, and capacity/used/available
bytes for the filesystem containing the project data directory. The filesystem values describe
the shared provider volume, not one project's allocation. The response deliberately omits
container IDs, names, image metadata, environment values, filesystem paths, and Docker errors.

The service allows only `GET`, an optional unique integer `logs` bound from 0 through 1,000, the
current generation control token, and a matching durable running state. It caps the complete JSON
response at 512 KiB and marks it `private, no-store`. Diagnostics serialize with lifecycle changes,
so a stopped, replaced, restarted-without-reconcile, or deleting generation cannot be sampled as
current. The request abort signal reaches the one-shot Docker stats command, so a disconnected or
timed-out dashboard request cannot hold that serialized lifecycle lane until the provider command
timeout.

The version 2 diagnostics object adds the bounded `filesystem` record. The built-in control plane
accepts version 1 during rolling upgrades and normalizes its missing capacity sample to
`available: false`. It independently enforces the private allowlisted provider origin,
deadline, exact media type/length/release/generation, no redirects or content encoding, a 512 KiB
body limit, exact fields, metric bounds, per-role uniqueness, and aggregate consistency. It then
rechecks the active pinned node and generation after the transfer. Configured project secret
values are redacted only at this receiving boundary before output reaches a project API or browser.
Treat raw provider logs as sensitive inside the private transport, because applications can log
data that is not registered as a project secret.

Network and block counters reset with each runtime generation and are diagnostics, not billing.
Filesystem utilization is a point-in-time provider-volume signal and is not project attribution or
quota enforcement. A Docker stats failure keeps bounded logs and an independent filesystem sample
available with `statisticsAvailable: false`; a filesystem sampling failure returns a fixed
unavailable record. A control-transport failure does not interrupt public application traffic.

### Remote job-control boundary

The same binding exposes a payload-free operational view and two conditional mutations:

```http
GET  /v1/clank/control/<project-id>/jobs?state=&queue=&limit=&alertDueAfterMs=
POST /v1/clank/control/<project-id>/jobs/<job-id>/cancel
POST /v1/clank/control/<project-id>/jobs/<job-id>/retry
Authorization: Bearer <generation-control-token>
Accept: application/vnd.clank.provider-jobs+json
```

The service resolves the validated active database path inside that provider project's private
directory. Inspection opens SQLite read-only and returns only counts, stable job metadata, cron
metadata, and error presence. Mutation bodies are declared-length JSON capped at 1 KiB; cancel
accepts `{}` and retry accepts only an optional bounded `runAt`. Conditional SQL and an immediate
transaction preserve worker races and append a payload-free event. Arguments, stored payloads,
results, error text, owners, groups, worker identities, lease tokens, filesystem paths, and
credentials are never returned.

Responses use `clank-provider-jobs/1`, exact project/release/generation identity, declared length,
`private, no-store`, and a 512 KiB aggregate ceiling. The built-in control plane independently
validates the entire public schema and rechecks placement after transfer. Job controls serialize
with provider lifecycle work, so they cannot cross a generation transition or read a deleted,
stopped, or stale database.

Use `rollback(request)` and `delete(request)` rather than reaching into the provider data store
beneath a live service:

```ts
const signal = new AbortController().signal;

await service.rollback({
  operation: {
    id: "op_rollback_43",
    projectId: "orbit_tasks",
    fence: 87,
    attempt: 1,
    maxAttempts: 10,
  },
  generation: 42,
  confirmation: "rollback orbit_tasks 42",
  signal,
});

await service.delete({
  operation: {
    id: "op_delete_44",
    projectId: "orbit_tasks",
    fence: 88,
    attempt: 1,
    maxAttempts: 10,
  },
  generation: 43,
  confirmation: "delete orbit_tasks",
  signal,
});
```

Both methods validate the exact current generation and a newer project-wide fence, revoke ingress,
wait for assigned response streams, stop every web/worker/scheduler process, and only then mutate
provider data. Rollback carries its fence into the restored generation. Destructive intent is
written before the data commit: an exact retry resumes `rolling-back` or `deleting`, while normal
reconciliation remains blocked until rollback reaches `rolled-back` or deletion removes the
project state. This covers process exit after SQLite commit but before service metadata commit.
Wrong confirmations, stale generations/fences, uncertain drains, and conflicting retries fail
before destructive mutation.

`close()` first prevents new reconcile work, revokes and drains private routes, closes and verifies
the Docker runtime boundary, then waits for in-flight per-project reconciliation to settle. A
failed drain or unproven container cleanup rejects shutdown and is sent only to the private
diagnostic hook.

These service methods are the provider-local safety boundary. `openProviderDeploymentAgent()` and
the authenticated provider bridge can now deliver canonical rollback/delete operations to them
without sharing coordinator credentials or accepting caller confirmation strings. The built-in
control plane must still preserve an encrypted recovery point, deactivate public managed ingress,
allocate that lifecycle operation and fence, update desired/observed placement, and reconcile the
selected release after rollback. Do not call raw provider-data `rollback()` or `delete()` beneath
a running service.

## Trust and operating boundary

The factory inherits all controls from the component guides:

- runtime capsules and durable service state are independently validated;
- service metadata is bounded, exact-field, `0600`, no-follow, atomically replaced, and
  current-user owned beneath a `0700` real directory;
- application secrets remain in the verified capsule and transient stdin activation plan;
- only the web container gets a loopback publish;
- background work is deferred until data commit;
- private ingress retains only the route-token digest; and
- generation/fence conflicts fail closed.

The service enforces one writer per provider root with a native SQLite write lock held for its
entire lifetime in private `service/.writer.sqlite`. A second live service rejects before startup
cleanup, owner metadata changes or Docker orphan removal. Close retains ownership until active
operations, runtime shutdown and candidate cleanup settle; process death releases the native
lock so a replacement can recover durable intents. The ownership file must remain at its stable
path: do not remove or replace it to force takeover. Direct provider-data and Docker component
users still must obey their documented single-writer requirements.

Pin every stateful project to the node owning its durable volume. Docker is a minimum
multi-account boundary, not a VM: protect the daemon and host, apply
egress and disk policy, enable rootless/user namespaces and LSM/seccomp where practical, and use
dedicated VMs or microVMs for hostile workloads.

## Opt-in provider canary preparation

The service accepts an optional `canaries` configuration with exact anonymous `GET`/`HEAD`
`readPaths`. `maxConcurrent` bounds simultaneous preparations (default 4, range 1–64),
`maxOperations` bounds the union of prepared and explicitly retired operation identities per primary incarnation (default 32,
range 1–64), and `maximumDurationMs` bounds preparation and candidate lifetime (default
30 minutes, range 100 milliseconds–30 minutes). `controlTimeoutMs` bounds the complete HTTP
control request (default 60 seconds, range 100 milliseconds–30 minutes); configuration is
captured when the service opens. Paths exclude queries, encoded or dot
segments, wildcards and private authenticated routes. The default service omits `canaries`.
Capsule intake is serialized across the provider, bounded before copying and copied before
asynchronous verification so callers cannot substitute bytes during preparation.

This exposes `service.canaries.binding`, `prepare`, `inspect`, `stop` and `retire` to trusted server
callers and the authenticated HTTP controls below. Service enablement alone does not start
platform traffic stages. Configure the separate [platform controller](deployment-platform.md#isolated-provider-canaries)
with native supervisor and project leases to run measured stages and durable exact retirement.

`binding(projectId)` returns the current primary release, generation, fence and an opaque
provider-issued incarnation, or `null` when unavailable. Preparation requires that exact binding,
the caller's current native coordinator epoch, a unique operation ID, a verified distinct
code-only capsule and an abort signal. Callers must assert their native coordinator lease before
and after every await; a submitted epoch number alone is not proof of authority.

Preparation writes a private durable intent before snapshot, data or runtime calls. It takes a
consistent SQLite checkpoint while the primary stays available, assigns a separate candidate
project, checks immutable migration history with `codeOnly: true`, and launches the candidate
with the Docker read-only data mount and deny-all outbound policy. Production environment
values are omitted. Declared jobs reject. Apps that require bootstrap writes or production
secrets cannot use this initial mode. The returned route credential is for the trusted ingress
controller and must never be included in public responses or logs.

The provider independently admits only the configured anonymous reads, strips other request
headers, and removes candidate cookie/site-data/authentication response headers. It rejects
expired candidates and stale primary/controller incarnations. Exact preparation retries return
the live binding; retired operations, altered identities, exhausted capacity and unresolved
cleanup reject. Expiry schedules cleanup. Inspecting a stopped record does not restart it.

Stopping withdraws routing and persists a stopping intent before draining and removing the
exact candidate runtime and data. Absence is verified before a stopped acknowledgement.
Primary reconciliation, rollback, deletion and evacuation perform this cleanup before changing
the authoritative writer. After the old service closes or exits, opening a replacement provider,
including a service without canaries enabled, retires persisted candidates. A replacement cannot
overlap a live service or its held preparation or cleanup operation.
Unknown journal protocols and failed cleanup block admission.

Use `retire` when a prepare request or its response may have been lost. Supply the exact
original `primary`, `operationId`, `controllerEpoch`, candidate `releaseId`, and source
`capsuleSha256`, plus the retiring coordinator's current `retirementEpoch`. The latter must
be at least the original prepare epoch. The source digest is the submitted capsule digest,
not the provider's derived checkpoint capsule digest. These fields are captured before any
await. Trusted callers must still assert their actual native coordinator lease before and
after every await; neither epoch number authorizes this operation by itself.

Retirement writes a bounded tombstone and a monotonic epoch floor before acknowledging an
absent candidate, even if preparation has not yet finished decoding its capsule. Preparation
rechecks this state after decoding, before any journal, checkpoint, data or runtime effects.
A retired operation and any other prepare below that primary incarnation's epoch floor
reject. An exact current candidate is drained and removed; unrelated later candidates and
their route credentials remain intact. Retirement verifies absence of runtime, ingress,
provider data, orphan directories and ordinary provider state. An ownership collision or
uncertain cleanup rejects without deleting unmatched state. A successful receipt has protocol
`clank-provider-canary-retirement/1` and phase `retired`; it contains no route credential.

Exact retirement retries retain the highest recorded retirement epoch and never lower the
floor. Reusing an operation with a different primary, original epoch, release or digest
rejects. The existing prepare journal retains only IDs for older operations: an ordinary
`stop` followed by another prepare may leave no full identity for that older operation.
Explicit retirement of such a spent, non-current ID rejects unless an exact retirement
tombstone is retained. Controllers needing a durable absence receipt should use `retire`
and finish unresolved retirement before admitting the next operation.

The additive private `service/<project>.canary-retirements.json` file uses protocol
`clank-provider-canary-retirements/1`. It stores one primary binding, the floor and at most
64 exact entries within the existing 64 KiB metadata bound. A persisted `retiring` entry
survives interrupted cleanup. Startup resumes it and verifies absence, including when
canaries are disabled; corruption, conflicts or failed cleanup prevent readiness. Retained
exact retries remain usable after restart or primary reconciliation until a verified new
primary incarnation replaces the resolved retirement history. Unresolved entries cannot be
discarded by that replacement. Back up provider metadata together; do not delete this file
to reclaim capacity. A fresh ordinary primary reconciliation permits new operation capacity.
Rolling back to a version without retirement support loses this receipt contract: restart
invalidates old primary bindings, and a controller must obtain and fence a new binding.

### Authenticated provider canary controls

`deploymentProviderCanaryPath(projectId, operation)` returns
`/v1/clank/control/<projectId>/canary/<operation>`. These provider-private routes require
`Authorization: Bearer <controlToken>`, using the separate generation control credential
from the primary runtime capsule. They never fall through to application ingress.

| Operation | Request | Successful response field |
| --- | --- | --- |
| `binding` | `GET`, no body | `binding`: complete current primary identity |
| `prepare` | `POST`, runtime capsule bytes; metadata in `x-clank-canary-input` | `state`: running candidate plus its private `route` |
| `inspect` | `POST`, JSON `{ primary, operationId, controllerEpoch }` | `state`: exact candidate state or `null`, without a route credential |
| `stop` | Same JSON identity as inspect | `state`: verified stopped candidate |
| `retire` | `POST`, JSON `{ primary, operationId, controllerEpoch, releaseId, capsuleSha256, retirementEpoch }` | `retirement`: durable exact absence receipt |

Prepare metadata is JSON `{ primary, operationId, controllerEpoch, releaseId, capsuleSha256 }`.
The release and source digest must match the submitted capsule. Its content type is
`application/vnd.clank.runtime`; other POST bodies require exactly `application/json`.
Every POST requires an exact positive decimal `Content-Length`. JSON bodies and prepare
metadata are limited to 4 KiB; runtime bytes use the existing database limit plus the
102 MiB capsule allowance and 32-byte framing bound. Total headers are limited to 16 KiB
and 64 fields. Queries, encoded control paths, compression, unknown routes, unexpected
fields and chunked bodies reject. A held unauthenticated body cannot reserve capsule intake.
Controllers must disable redirects when sending credentials and bound their response reads.

Successful responses use `DEPLOYMENT_PROVIDER_CANARY_CONTROL_PROTOCOL`
(`clank-provider-canary-control/1`), `DEPLOYMENT_PROVIDER_CANARY_CONTROL_MEDIA_TYPE`
(`application/vnd.clank.provider-canary-control+json`), an exact content length, and
`private, no-store`; they are limited to 64 KiB. Only an authenticated exact prepare response
contains the candidate route token. Binding, inspect, stop and retirement never return that
token or the control credential digest. A `null` inspect result is not proof of absence.

Before returning an HTTP binding, the provider writes and fsyncs one private bounded
`service/<project>.canary-binding.json` receipt and verifies its readback. Protocol
`clank-provider-canary-binding/1` retains the full primary identity, issuing service
incarnation and a 32-byte generation credential digest; it never stores a raw credential.
Repeated binding requests for the same live binding are idempotent. The native lifetime
SQLite lock prevents two live services from issuing or changing this receipt concurrently.
Corrupt, unsupported or incorrectly scoped receipts prevent startup, including with canaries
disabled. There is no TTL, silent eviction or deletion-based capacity reset.

Current credentials and the exact live issued binding are required for prepare, inspect and
stop. After a primary changes, its retained old credential is cleanup-only: it can retire only
operations on that exact issued binding, and cannot access current data, admit a candidate or
obtain another binding. Unknown old operations additionally require that the issuing service
has exited, the replacement owns the actual native lifetime lock, startup cleanup completed,
and exact runtime, ingress, data and ordinary-state absence passes after durable retirement.
A primary change within the same still-live service does not supply this restart proof for an
unknown old operation. Known retained operations can still complete exact cleanup.

A current authenticated binding request may replace the single old issued receipt only after
old candidate cleanup and unresolved retirement cleanup finish. A controller must durably
acknowledge its old operation's retirement before requesting that replacement; replacing the
receipt revokes its old credential. Retained retirement identities remain usable through the
trusted controller API until its documented history replacement. HTTP authentication never
widens to a newer or unrelated binding. Authority is rechecked after asynchronous body,
metadata and native controller work, using the originally admitted credential digest and
receipt. Numeric epochs alone still do not prove an actual coordinator lease.

`503 CANARY_CONTROL_UNCERTAIN` means the outcome is uncertain. It never acknowledges absence.
On failed or expired admitted preparation the service schedules exact retirement, but native
work that ignores abort may still hold its serialized lane. The lifetime lock remains held
through that work and shutdown cleanup. Durable candidate intent or the issued-binding
receipt survives process death. The controller must durably retry exact retirement before
advancing, including after a timeout, lost response, inspect `null`, or authentication refusal.
A disabled service accepts only retained exact retirement authorization. Keep these metadata
files in coherent backups; rolling back to a service version without issued-binding support
removes this HTTP recovery contract and is not a substitute for acknowledged cleanup.

Candidate data is never promoted. After successful evaluation, stop the candidate and verify
cleanup, then use ordinary fenced single-writer deployment with the latest primary data. A
failed canary leaves the primary database and release authoritative. Native SQLite/controller
fixtures and injected runtime lifecycle tests are separate from the real Docker profile;
neither certifies a production host or physical authenticator.

## Retained handoff barriers

The private handoff foundation does not enable online transfer or expose an enrollment API.
Unmarked provider roots keep ordinary startup behavior. Directory permission normalization
requires a safe native inspection proving the owner is unmarked. Marked, malformed or uncertain
state refuses without permission repair. A permission-drifted legacy WAL owner can also refuse
when inspection cannot prove marker absence without creating sidecars; preserve it for operator
recovery, with no automatic chmod, checkpoint or cleanup. Unchanged private WAL roots retain
their existing startup behavior. A retained handoff marker binds the provider node, native
Docker daemon identity and owner label. Startup must validate that exact
execution domain and every bounded catalog before opening provider data or performing Docker
orphan cleanup. A different or unavailable daemon is not evidence that the source is absent.

Any retained barrier refuses ordinary startup for the whole provider root. This intentional
restriction follows the launcher's owner-wide cleanup: selective project recovery needs a
separately reviewed lifecycle. Refusal is not a stop receipt. Missing, partial, newer or corrupt
metadata remains untouched; deleting it or retargeting the owner is not a recovery procedure.
Private installation and barrier writes are permitted only before ordinary service admission.
A later runtime bridge must establish live quiescence, exact runtime identity and native stop
proof separately.

Retained capture created before runtime enrollment may also refuse normal `openBackend`
bootstrap. Preserve the source and capture repository for a reviewed recovery or downtime
transition; do not bypass capture guards or create a replacement base or grant automatically.
The native metadata crash tests establish neither Docker host eligibility nor provider-wide
source stop, target activation or the interruption bound for online handoff.

Private runtime initialization now consumes one bounded canonical bootstrap and reads its
exact mounted catalog through native read-only transactions. Created/started grants permit
initial capture only; ordinary writes and later control states remain refused. Missing or
ambiguous native descriptor identity, including SQLite descriptor reuse, refuses enrollment
while preserving ordinary database support. Native descriptor observation excludes hostile
same-process interference and does not prove exclusive writer or provider ownership.
Initialization rechecks authority inside backup, worker and durable publication boundaries.
Workers retain default Linux namespace isolation. Revocation or close cannot acknowledge a
later publication; uncertain owned files remain for recovery. A killed initializer cannot
adopt its retained capture on restart. These private tests do not establish Docker runtime
mounts, provider-wide stop, target activation or the online interruption bound.

Successful private initialization returns a frozen, bounded metadata snapshot containing
only the original capture epoch, key identifier, schema hash, acknowledged base identifier
and zero cursor. It checks the original native insert and base acknowledgment, complete
retained capture metadata and logical state after durable publication. The snapshot grants
no authority: ordinary writes remain denied, and export, enrollment, readiness and later
control states remain unavailable. Revocation, close, metadata drift or uncertain cleanup
prevents the result; retained files remain recovery evidence, never permission to restart.

The private host catalog also records exact `issued → created → started` container
observations through its retained owner and original Docker client. These operations
do not create or start containers. They compare the complete grant, index and catalog
state, retain native file identities across inspection waits, and commit the grant
and its mirror together before file/directory synchronization and final inspection.
Exact retries preserve the version, including a committed maximum version; changed
identity, uncertain inspection or failed synchronization never grants permission.
Restart with any retained grant remains cleanup-only. Created/started rows are
historical observations, not liveness, readiness, writer admission or stop proof.
The conservative inspection parser also refuses native JSON escaping and integer-like
label-key ordering that differ from its exact re-encoding, including otherwise valid
unrelated labels. Scripted transport tests exercise this boundary without establishing
native Docker lifecycle or reference-profile eligibility. No launch or readiness path
uses these operations, and the current reference profile remains source-ineligible.

Continue with [Provider data lifecycle](provider-data-lifecycle.md),
[Provider Docker runtime](provider-docker-runtime.md),
[Provider runtime ingress](provider-runtime-ingress.md),
[Deployment provider adapters](provider-adapters.md),
[Remote runtime placement](runtime-placement.md), and
[Managed ingress](data-plane.md).

### Explicit shadow checkpoint state

The provider compatibility prerequisite for shadow traffic accepts the same
trusted `canaries.prepare` and authenticated HTTP prepare endpoint with the exact
additional pair `purpose: "shadow"` and `stateProtocol: "clank-provider-canary/2"`.
For HTTP put both fields in `x-clank-canary-input`, beside the existing exact
identity; retain the existing binary capsule body and current control credential.
Omitting both retains ordinary canary protocol1. Partial pairs, unknown versions,
and reuse of an operation for a different purpose are rejected. A controller must
never retry an unsupported shadow prepare as an ordinary canary.

A successful shadow response has protocol2, `purpose: "shadow"`, and
`snapshot: { sha256, bytes, startedAt, completedAt }`. This is the digest and byte
length of the verified SQLite checkpoint embedded in the isolated candidate,
not its source capsule or release artifact. Metadata is durably written and read
back before candidate data apply/launch. A running shadow requires it; a stopped
operation that failed before snapshot acquisition may retain null. An exact
running retry returns the same checkpoint instead of taking another snapshot.
Inspect and stop return the discriminated protocol1/protocol2 union; inspect
still excludes private route credentials. Shadow preparation uses the existing
read-only profile, code-only validation, empty application environment, disabled
jobs and exact public read-path policy. Candidate data is never promoted.

Acquisition timestamps use the provider's clock. They give an observed interval,
not a transaction timestamp or trustworthy cross-host age. A caller may record
its own observation time and monotonic elapsed interval, but must expose clock
uncertainty rather than subtract host wall clocks and claim exact freshness.

Before the first shadow intent the service irreversibly enrolls private owner
protocol2, with fsync and exact readback, while holding its native lifetime lock.
It preserves this version across restarts, ordinary canaries and disablement.
Older provider services refuse owner2 or retained journal2 before admitting
ordinary writes. The legacy Docker factory can perform its existing owned orphan
cleanup before reaching the refusal; downgrade is not a no-op recovery strategy.
Unknown/corrupt protocols, incomplete checkpoint metadata or a missing capability
fail closed. Current startup refuses a missing owner before Docker cleanup when
any other service metadata exists; it does not reconstruct an owner from a later
ordinary protocol1 journal. A service directory containing only validated native
lifetime-lock files can create its first marker and adopt independently staged
provider data through the existing high-water checks. Plain provider data cannot
prove earlier service enrollment after all service metadata is deleted. This
also does not make older binaries detect deletion of every future-version marker
or protect a simultaneous metadata rollback; retain coherent backups and do not
use downgrade as recovery. Startup cleans retained shadow candidates even with
canaries configured off. Exact retirement wire1 and its old-credential cleanup-only rules
remain unchanged, including a prepare lost before its journal was written. A
503 is uncertain; durably retry exact retirement rather than infer absence.

This prerequisite adds provider provenance and compatibility only. It does not
expose platform shadow sessions, mirror traffic, or complete Feature09 acceptance.
Native tests with injected runtime/ingress components do not replace real Docker
isolation, primary-data preservation and network cleanup evidence.
