# Remote runtime placement

Clank has an opt-in, versioned path for moving one verified application generation across the
control-plane, deployment-runner, and infrastructure-provider boundaries. Local projects remain
the zero-setup default. A provider project uses the same release artifact and CLI, but its runtime,
SQLite database, and private ingress live on one statefully pinned provider node.

The ordinary `clank-deploy/1` release remains a non-secret, immutable code archive. A
`clank-runtime/1` capsule binds that release to the final process environment, SQLite placement
intent, and managed-ingress identity needed by one exact project generation.

## Capsule contents

The binary capsule contains three length-delimited sections:

1. a UTF-8 JSON manifest;
2. the original compressed `clank-deploy/1` artifact; and
3. an optional SQLite snapshot.

The fixed header records each section length before any section is interpreted. The manifest
records:

- protocol, project ID, release ID, and desired generation;
- the final environment, including application secret values;
- the database path and `initialize`, `preserve`, or `replace` intent;
- optional snapshot length and SHA-256;
- a provider-local ingress route and high-entropy ingress token; and
- artifact length and SHA-256.

The artifact stays in its original binary form and the SQLite snapshot stays in its original
binary form. Neither is base64 encoded or placed in JSON.

```ts
import {
  createDeploymentRuntimeCapsule,
} from "@clank.run/framework/runtime-placement";

const runtime = await createDeploymentRuntimeCapsule({
  projectId: "project_01",
  releaseId: "release_07",
  generation: 12,
  environment: {
    NODE_ENV: "production",
    APP_SECRET: decryptedProjectSecret,
  },
  database: {
    path: "app.sqlite",
    mode: "replace",
    snapshot: sqliteSnapshot,
  },
  ingress: {
    route: "/projects/project_01",
    token: ingressOnlyToken,
  },
  artifact: releaseBytes,
});
```

Creation and decoding both:

- bound section and aggregate byte counts;
- require exact manifest fields and supported protocol values;
- reject unsafe identifiers, paths, routes, environment names, and control characters;
- decode and verify the nested deployment bundle again;
- require the database path to match the deployment config;
- enforce database-mode/snapshot consistency;
- require the SQLite file header when a snapshot is present; and
- verify the artifact, snapshot, and whole-capsule SHA-256 values.

`preserve` never carries a snapshot. `replace` always carries one. `initialize` can carry a
seed snapshot or ask the provider to create empty project data. These are desired-state semantics;
the provider must apply them atomically and idempotently.

## Lease-scoped transport

When a coordinator is configured with a runtime source, the runner client can call:

```ts
const runtime = await coordinator.runtime(
  session.node.id,
  session.token,
  operation,
);
```

The call needs both the exact current node credential and the unexpired operation token/fence. The
coordinator selects the canonical stored operation rather than trusting the runner's echoed
payload, loads the capsule, verifies its digest, rechecks the lease after provider work, and returns
an exact `application/vnd.clank.runtime` body with `private, no-store`.

The client refuses redirects and non-loopback cleartext HTTP, requires the exact media type,
declared length, and SHA-256, bounds the streamed response, and applies a separate deadline.
`clank-runner` exposes:

```sh
CLANK_RUNNER_RUNTIME_TIMEOUT_MS=120000
CLANK_RUNNER_MAX_RUNTIME_BYTES=805306368
```

Tune the artifact and runtime bounds together. The runtime ceiling must accommodate the manifest,
compressed release, and largest permitted SQLite handoff without exceeding the provider and
network limits.

## Provider contract

A reconcile operation opts into the capsule explicitly:

```ts
await orchestrator.setDesired({
  projectId,
  releaseId,
  state: "running",
  region: "iad",
  placementMode: "stateful",
  runtimeProtocol: "clank-runtime/1",
});
```

`openProviderDeploymentAgent()` then uses `context.runtime()` instead of the legacy artifact
download. Before provider code runs, Clank verifies the whole capsule and requires its project ID,
release ID, and generation to match the canonical desired operation.

The provider receives:

- `request.runtime`, the decoded and verified capsule;
- `request.artifact`, the verified nested release from that same capsule;
- the credential-free operation identity and monotonic fence;
- the desired generation/state/release; and
- an abort signal.

## Enable built-in provider placement

The packaged control plane keeps provider placement closed unless the operator configures the
coordinator, managed ingress, and an explicit default. Use `local` as the default to expose
per-project selection without moving new projects automatically:

```sh
export CLANK_RUNNER_COORDINATOR=1
export CLANK_INGRESS_BASE_DOMAIN=apps.example.com
export CLANK_PROVIDER_DEFAULT_PLACEMENT=local
export CLANK_PROVIDER_REGION=us-central
export CLANK_PROVIDER_ALLOWED_HOSTS=runtime.internal.example
export CLANK_PROVIDER_MAX_DATABASE_BYTES=536870912
```

`CLANK_PROVIDER_ALLOWED_HOSTS` is the comma-separated set of non-loopback node endpoint hostnames
that the public managed ingress may contact. A remote provider endpoint must use HTTPS and match
this list exactly. Loopback HTTP remains available for one-host development. Optional exact
capability selection uses `CLANK_PROVIDER_LABELS=key=value,key=value`.

The runner advertises the private provider-ingress endpoint separately:

```sh
export CLANK_CONTROL_URL=https://deploy.example.com
export CLANK_RUNNER_NODE_ID=provider-us-central-01
export CLANK_RUNNER_REGION=us-central
export CLANK_RUNNER_ENDPOINT=https://runtime.internal.example
export CLANK_PROVIDER_URL=https://runtime.internal.example
export CLANK_PROVIDER_TOKEN="$(secret read provider-bridge-token)"
export CLANK_RUNNER_CREDENTIALS=/var/lib/clank-runner/credentials.json
clank-runner
```

The provider service at `CLANK_PROVIDER_URL` accepts the authenticated reconcile/rollback/delete
bridge. `CLANK_RUNNER_ENDPOINT` is the origin that Clank's managed ingress uses after activation.
They can be the same private origin, as in the example, but they are independent trust decisions.

For production, store original runner uploads in the configured S3-compatible artifact repository
so a control-plane volume loss or replacement does not remove the only deployable archive. This
does not replace database backups.

Create placement once, either from the CLI or the control-plane dialog:

```sh
clank project create my-app --placement=provider
# Or let the first deploy create and link it:
clank deploy --name=my-app --placement=provider
```

Placement is immutable for a project. Preview environments inherit their parent placement. A
provider project receives an isolated provider data directory and SQLite database; it never uses a
local control-plane application database.

Programmatic embedders use the same explicit boundary:

```ts
await openPlatform({
  // ...
  deploymentAgents: {
    managedEnrollment: true,
    artifacts: {
      namespace: "production-releases-v1",
      store: releaseObjectStore,
    },
    placement: {
      default: "local",
      region: "us-central",
      labels: { tier: "stateful" },
      allowedProviderHosts: ["runtime.internal.example"],
      maxDatabaseBytes: 512 * 1024 * 1024,
    },
  },
  ingress: { baseDomain: "apps.example.com" },
});
```

## Deploy, retry, rollback, and delete

For each provider generation, the control plane encrypts the final environment under its platform
master key and retains the original content-addressed release. The environment is frozen before
desired state changes, then decrypted only while producing the exact lease-scoped runtime capsule.
Plaintext secrets and the generation-derived ingress/control tokens are not stored in the control
database.

Activation requires one exact tuple: project, release, desired generation, observed generation,
observed state, assigned node, and allowlisted node endpoint. Only then does Clank commit the
release and publish the managed-ingress route. A timeout returns
`PROVIDER_DEPLOYMENT_PENDING` without marking the release failed. The CLI keeps the deploy-attempt
idempotency key, so rerunning the same `clank deploy` resumes that generation instead of creating a
second release.

Code rollback creates a new generation from the selected immutable release while preserving the
current database. `--restore-data` is limited to the active release's immediate predecessor,
requires `--confirm="restore <slug>"`, first runs the provider's fenced rollback on the exact
active generation, and then reconciles the selected code as a new generation. Repeated requests
reuse the same destructive operation.

Project deletion requires the ordinary typed confirmation and data-loss acknowledgement. Clank
queues a fenced delete on the pinned node and waits for provider success before removing release
objects, credentials, routes, or control metadata. Pending, stale, offline, and failed provider
states preserve metadata and return a retryable or explicit error; they never silently orphan
remote data.

Inactive release cleanup removes both the retained artifact and every encrypted runtime-generation
record for that release. Active releases and converging staging releases are protected. A cleanup
that is repeated after interruption also scrubs any leftover provider-generation metadata before
returning success.

The authenticated HTTP provider bridge forwards the exact capsule bytes as its bounded request
body. Only the protocol selector, content digest, and non-secret operation metadata are placed in
headers. Environment values, SQLite bytes, and the ingress token are never placed in URLs,
headers, public failures, or durable operation results. The provider handler rehashes, decodes,
and rebinds the capsule because that HTTP hop is a separate trust boundary.

## Trust boundary

The runtime capsule is sensitive plaintext while in memory and transit. This is intentional: the
runtime provider must possess the application environment and data to launch the application.
Treat the provider host as part of the application's trusted compute boundary.

- Use HTTPS outside loopback and preferably a private network.
- Give the provider bridge a distinct, narrowly scoped, rotated bearer token.
- Never log, persist, inspect, or cache capsule bodies in generic proxies or request middleware.
- Keep node credentials, operation tokens, browser sessions, CLI tokens, and the platform master
  key out of the capsule and provider request.
- Isolate mutually untrusted applications with VMs or microVMs; a shared process is not a sandbox.
- Encrypt independent backups before sending them to an external repository.
- Make provider mutations idempotent under project, generation, operation ID, and fence.

Compromise of the trusted provider can expose every secret and database currently placed on it.
Capsule authentication and integrity prevent an untrusted runner or network peer from selecting or
altering another runtime; they do not make the destination host untrusted compute.

## Current support boundary

The codec, authenticated transports, stateful pinning, complete Docker provider service, opt-in
control-plane generation lifecycle, exact managed-ingress publication, restart-safe routing,
deploy retry, code/data rollback, preview inheritance, and provider-confirmed deletion are
implemented and tested end to end. Enabling the coordinator alone still moves nothing; only a
project created with `placement: "provider"` uses provider capacity.

Provider-hosted backup creation, scheduling, listing, and verification are implemented. A separate
generation-derived control credential authorizes one consistent SQLite export from the exact
active release/generation. The control plane requires the pinned node's current allowlisted
origin, refuses redirects and encoded responses, enforces deadline/length/media-type/identity
bounds, rehashes the body, rechecks placement after transfer, and imports it directly into the
encrypted local or S3-compatible recovery repository. The control token is never stored and does
not authorize public application ingress. Provider generations created before this credential was
added must be deployed once before their first managed backup.

Provider restore verifies the selected encrypted recovery point, creates a provider snapshot as a
second encrypted safety point, and freezes both identities plus target digest/size in a new
generation. The runtime source re-authenticates the target and places its bytes only in the private
capsule. The provider drains the old writer, makes an exact post-drain local safety snapshot,
replaces SQLite, reapplies current migrations, health-checks, and publishes ingress last. A timeout
returns `PROVIDER_RESTORE_PENDING`; retrying the same request resumes that generation without
duplicating the safety point. Restore intentionally pauses writes and still depends on the pinned
node.

The exact active generation now provides a bounded live-output tail plus one-shot Docker
memory/limit, CPU, PID, network-I/O, and block-I/O attribution. The control plane authenticates
the generation-only diagnostics route, enforces response metadata and byte limits, validates all
aggregates, rechecks placement after transfer, redacts configured project secrets, and displays
the result beside managed-ingress traffic metrics. Provider network and block counters are
cumulative only for the current runtime generation; they are operational signals, not billing
records or filesystem-capacity measurements.

Control-plane job inspection still returns `remote_unavailable`, and job mutations return
`PROVIDER_JOBS_PENDING`, until the job-specific SQLite diagnostics/mutation contract is carried
across this private boundary. Provider filesystem capacity and automatic failover from node-local
SQLite remain operator responsibilities.

An inexpensive single-host installation needs none of this configuration and incurs no additional
runner, bucket, or volume cost. Existing local projects and their databases are never relocated.

Continue with [Provider data lifecycle](provider-data-lifecycle.md), [Deployment provider
adapters](provider-adapters.md), [Durable distributed deployment](distributed-deployment.md),
[Managed ingress and external data](data-plane.md), [Recovery](recovery.md),
[Provider runtime ingress](provider-runtime-ingress.md),
[Provider Docker runtime](provider-docker-runtime.md),
[Complete deployment provider service](provider-service.md), and
[Platform security](platform-security.md).
