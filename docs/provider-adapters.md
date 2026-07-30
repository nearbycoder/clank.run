# Deployment provider adapters

Clank separates durable deployment coordination from infrastructure mutations. The control plane
owns desired generations, node identity, placement, operation leases, release provenance, and
fencing. A deployment provider owns the host-specific act of converging one project to a running
release or a stopped state.

This boundary is intentionally small:

```ts
import type { DeploymentProvider } from "@clank.run/framework/provider";

const provider: DeploymentProvider = {
  kind: "microvm",
  async reconcile(request) {
    // Node and operation credentials are never passed to provider code.
    // Persist the highest generation and fence before mutating infrastructure.
    await reconcileMicroVm({
      projectId: request.operation.projectId,
      operationId: request.operation.id,
      fence: request.operation.fence,
      generation: request.desired.generation,
      state: request.desired.state,
      releaseId: request.desired.releaseId,
      artifact: request.artifact,
      runtime: request.runtime,
      signal: request.signal,
    });
  },
};
```

For a running generation, `request.artifact` contains the original compressed bytes, their
SHA-256, and a decoded `clank-deploy/1` bundle. Clank independently checks the transport digest,
every file path, size, mode, checksum, deployment config, and aggregate bound before the provider
runs. A reconcile operation that selects `clank-runtime/1` also receives `request.runtime`: the
project/release/generation-bound final environment, database placement intent and optional SQLite
snapshot, and ingress identity. Its `request.artifact` is the verified release nested in that
capsule. A stopped generation has no release, artifact, or runtime.

## Standard agent

`openProviderDeploymentAgent()` layers this contract over the normal remote-node lifecycle:

```ts
import {
  createDeploymentCoordinatorClient,
  fileDeploymentNodeCredentials,
} from "@clank.run/framework/runner";
import {
  openProviderDeploymentAgent,
} from "@clank.run/framework/provider";

const agent = await openProviderDeploymentAgent({
  client: createDeploymentCoordinatorClient({
    baseUrl: "https://clank.example.com",
  }),
  node: {
    id: "runner-west-01",
    region: "us-west",
    capacity: 20,
    labels: { isolation: "microvm", architecture: "amd64" },
  },
  provider,
  registrationToken: process.env.CLANK_RUNNER_REGISTRATION_TOKEN,
  credentials: fileDeploymentNodeCredentials(
    "/var/lib/clank-runner/credentials.json",
  ),
  concurrency: 4,
});
```

The wrapper accepts only canonical `reconcile` operations, validates the desired payload, and
downloads either the legacy artifact or the explicitly selected runtime capsule only for a running
state. It independently verifies the bytes and binds a capsule to the operation's exact project,
release, and generation before calling the provider, then reports the matching generation as
observed. A rejected stale observation fails the operation instead of claiming success.

The operation result sent back to the control plane is fixed to provider kind, generation,
release ID, and state. Provider return values, exception details, credentials, paths, and runtime
metadata do not become durable control-plane records.

## Authenticated HTTP bridge

Provider code can run in a separate private service. Clank includes both sides of one exact binary
protocol:

```ts
import {
  createDeploymentProviderHandler,
  createHttpDeploymentProvider,
} from "@clank.run/framework/provider";

const remoteProvider = createHttpDeploymentProvider({
  baseUrl: "https://runtime.internal.example",
  token: process.env.CLANK_PROVIDER_TOKEN!,
});

const handler = createDeploymentProviderHandler(provider, {
  token: process.env.CLANK_PROVIDER_TOKEN!,
  maxArtifactBytes: 100 * 1024 * 1024,
  maxRuntimeBytes: 768 * 1024 * 1024,
  onError(error) {
    privateOperatorLog(error);
  },
});
```

The fixed path is `POST /v1/clank/reconcile`. Legacy running requests carry
`application/vnd.clank.deploy+gzip`; runtime requests carry `application/vnd.clank.runtime`.
Both are exact binary bytes, not base64 JSON. Bounded headers identify the project, operation,
fence, attempt, generation, desired state, release, protocol, and body SHA-256. Secret values,
SQLite bytes, and ingress tokens stay only in the runtime body. Stopped requests carry no body,
release, protocol, or digest. A successful provider returns `204`.

Both sides require a separate 32–512 character bearer token. Non-loopback clients require HTTPS,
refuse redirects, apply deadlines and body limits, discard bounded failure bodies, and retry only
the same idempotent request after network, 408, 425, 429, or 5xx failure. The handler rehashes and
decodes the artifact or runtime capsule again because the HTTP hop is a new trust boundary.
Provider exceptions reach only the private `onError` hook; callers receive a stable generic error.

Do not expose this endpoint to browsers or reuse Clank account, CLI, enrollment, node, or operation
credentials for it. Prefer a private network plus narrowly scoped edge admission even though the
request is authenticated.

## Packaged runner

`clank-runner` connects the coordinator to the HTTP bridge without application code:

```sh
export CLANK_CONTROL_URL=https://clank.example.com
export CLANK_RUNNER_NODE_ID=runner-west-01
export CLANK_RUNNER_REGION=us-west
export CLANK_RUNNER_REGISTRATION_TOKEN="$(secret read clank-runner-enrollment)"
export CLANK_RUNNER_CREDENTIALS=/var/lib/clank-runner/credentials.json

export CLANK_PROVIDER_URL=https://runtime.internal.example
export CLANK_PROVIDER_TOKEN="$(secret read clank-runtime-provider)"

clank-runner
```

Run `clank-runner --check` before starting the service, or add `--json` for an agent-readable
result. With a saved node credential it authenticates the node; before first enrollment it
validates configuration without consuming the one-time value. After successful enrollment, remove
`CLANK_RUNNER_REGISTRATION_TOKEN` from the long-running service. The persisted node credential is
sufficient for restart. `SIGINT` and `SIGTERM` drain the node before exit. Run
`clank-runner --help` for capacity, label, concurrency, timeout, retry, artifact, and
runtime-capsule limits.

This process requires no extra npm package or managed service. A systemd unit, container, VM, or
existing scheduler can supervise it. The control plane's normal single-host mode remains the
zero-cost default.

## Provider correctness contract

Every adapter must satisfy all of these rules:

1. Store the latest accepted generation and monotonic fence per project in transactional durable
   state. Reject older work.
2. Treat the operation ID plus fence as an idempotency key. A response can be lost after the
   provider commits, so retry is normal.
3. Pass the abort signal to provider calls and stop local subprocess/container work when possible.
   Abort does not roll back an already committed remote mutation.
4. Stage a new release separately, health-check it, switch ingress atomically, then drain the old
   generation. Never overwrite an active release in place.
5. Keep application data outside immutable release directories. Mount or bind only the one
   project's data into its runtime.
6. Keep release artifacts non-secret. When a `clank-runtime/1` capsule is supplied, consume its
   final environment and database only inside the trusted project runtime boundary; never log,
   cache, or copy the body into generic provider metadata.
7. Use an isolated runtime boundary for mutually untrusted deployers. A process launcher is not a
   sandbox; Docker is a minimum, while hostile workloads should use dedicated VMs or microVMs.
8. Return success only after the requested state is externally usable. Keep private provider
   errors in operator telemetry.
9. Garbage-collect only releases no longer referenced by desired, observed, or rollback state.
10. Test retry after commit, lease loss, stale fences, abort, health failure, partial ingress
    switch, restart from durable state, and provider outage.

`openDeploymentProviderDataStore()` implements the provider-owned portion of rules 1, 2, 5, 6,
and 9 for immutable releases plus SQLite. It independently binds runtime capsules to desired
state, applies migrations behind a consistent safety snapshot, commits metadata atomically,
retains one rollback generation, and journals interrupted apply and rollback work. See
[Provider data lifecycle](provider-data-lifecycle.md) before writing a runtime adapter.

## What is and is not portable yet

The provider contract, HTTP bridge, runner command, release and runtime transport, object storage,
leases, credentials, and fencing are implemented and package-supported. They remove provider SDKs
from Clank and give Docker, VM, microVM, Nomad, Kubernetes, or hosted adapters the same narrow
surface.

The built-in control plane still activates its ordinary hosted projects through its local
supervisor. Enabling enrollment or starting `clank-runner` does not silently relocate existing
projects. A fully remote installation must deliberately connect desired-state creation, runtime
capsule creation, the packaged provider data lifecycle, isolated runtime launch and health,
TLS/edge routing, log and metric collection, and independent backup policy. The capsule is not
selected by the built-in platform until ingress activation and the complete cross-node recovery
path are integrated and tested. Clank refuses to pretend those data and security boundaries are
solved by uploading code alone.

See [Remote runtime placement](runtime-placement.md) for the exact body and trust boundary, then
[Provider data lifecycle](provider-data-lifecycle.md) for its safe local consumption. The eventual
provider integration should consume these contracts rather than adding provider-specific logic to
application code or the control database.
