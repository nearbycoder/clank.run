# Remote runtime placement

Clank has a versioned runtime-capsule contract for moving one verified application generation
across the control-plane, deployment-runner, and infrastructure-provider boundaries. It is the
transport foundation for remote placement; it does not enable remote placement by itself.

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

## Activation status

The capsule codec, lease-scoped coordinator call, standard deployment-agent access, desired-state
protocol selector, provider verification, authenticated HTTP forwarding, public declarations,
packaged-runner limits, and generation-bound managed-ingress route contract are implemented and
tested. The package-supported provider runtime registry validates that contract before forwarding
to a loopback application, retains only the route-token digest, permits safe generation overlap,
and revokes then drains exact generations. A remote ingress route fixes the allowlisted provider
origin, provider-local path, `clank-runtime/1` protocol, desired generation, project, and private route token. Public requests
cannot override those headers, health uses the same binding, and an old generation's circuit state
does not carry into the next generation.

The built-in control plane deliberately does **not** select `clank-runtime/1` for hosted projects
yet. The package-supported [provider data lifecycle](provider-data-lifecycle.md) now stages code
without persisting secrets; initializes, preserves, replaces, snapshots, rolls back, and deletes
per-project SQLite data; applies immutable migrations; retains one rollback generation; and
recovers interrupted apply and rollback journals.

Remote activation remains closed until the implemented data and ingress contracts are bound end
to end to an isolated runtime launcher, atomic control-plane publish/revoke, stateful node pinning,
encrypted recovery replication, restart reconciliation, and lease-loss/traffic-switch
certification.

Until those controls land, enabling a runner fleet does not move existing applications or their
data. The current single-host deployment path stays unchanged and no additional Railway service,
volume, database, or object store is required.

Continue with [Provider data lifecycle](provider-data-lifecycle.md), [Deployment provider
adapters](provider-adapters.md), [Durable distributed deployment](distributed-deployment.md),
[Managed ingress and external data](data-plane.md), [Recovery](recovery.md),
[Provider runtime ingress](provider-runtime-ingress.md), and
[Platform security](platform-security.md).
