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
limit memory, CPU percentage, PIDs, and cumulative network and block I/O. It deliberately omits
container IDs, names, image metadata, environment values, filesystem paths, and Docker errors.

The service allows only `GET`, an optional unique integer `logs` bound from 0 through 1,000, the
current generation control token, and a matching durable running state. It caps the complete JSON
response at 512 KiB and marks it `private, no-store`. Diagnostics serialize with lifecycle changes,
so a stopped, replaced, restarted-without-reconcile, or deleting generation cannot be sampled as
current. The request abort signal reaches the one-shot Docker stats command, so a disconnected or
timed-out dashboard request cannot hold that serialized lifecycle lane until the provider command
timeout.

The built-in control plane independently enforces the private allowlisted provider origin,
deadline, exact media type/length/release/generation, no redirects or content encoding, a 512 KiB
body limit, exact fields, metric bounds, per-role uniqueness, and aggregate consistency. It then
rechecks the active pinned node and generation after the transfer. Configured project secret
values are redacted only at this receiving boundary before output reaches a project API or browser.
Treat raw provider logs as sensitive inside the private transport, because applications can log
data that is not registered as a project secret.

Network and block counters reset with each runtime generation and are diagnostics, not billing or
filesystem-capacity data. A Docker stats failure keeps bounded logs available with
`statisticsAvailable: false`; a control-transport failure does not interrupt public application
traffic.

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

Use one service writer per provider root. Pin every stateful project to the node owning its durable
volume. Docker is a minimum multi-account boundary, not a VM: protect the daemon and host, apply
egress and disk policy, enable rootless/user namespaces and LSM/seccomp where practical, and use
dedicated VMs or microVMs for hostile workloads.

Continue with [Provider data lifecycle](provider-data-lifecycle.md),
[Provider Docker runtime](provider-docker-runtime.md),
[Provider runtime ingress](provider-runtime-ingress.md),
[Deployment provider adapters](provider-adapters.md),
[Remote runtime placement](runtime-placement.md), and
[Managed ingress](data-plane.md).
