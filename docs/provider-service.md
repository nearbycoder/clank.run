# Complete deployment provider service

`@clank.run/framework/provider-service` composes Clank's provider data store, isolated Docker
launcher, and generation-bound private ingress into one restart-safe `DeploymentProvider`. It is
the recommended provider implementation when self-hosting remote application compute.

The service is still deliberately separate from control-plane placement. It makes one assigned
provider node converge correctly; the next integration phase decides which node owns a project
and when managed edge traffic switches to it.

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

Mount `reconciliation.handle(request)` only at its fixed authenticated
`POST /v1/clank/reconcile` path. Route the provider-private application path to
`service.handle(request)`. Terminate TLS in front of both, restrict network admission to the
runner and managed edge respectively, and never expose application loopback ports.

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

These service methods are the provider-local safety boundary. The control plane must still preserve
an encrypted recovery point, deactivate public managed ingress, allocate the lifecycle operation
and fence, update desired/observed placement, and reconcile the selected release after rollback.
Do not call raw provider-data `rollback()` or `delete()` beneath a running service.

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
