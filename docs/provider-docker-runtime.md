# Provider Docker runtime

`@clank.run/framework/provider-docker` is Clank's zero-dependency reference launcher for isolated
remote application runtimes. It consumes only provider data that has already been verified,
extracted, and migrated by `@clank.run/framework/provider-data`. It starts the exact web, worker,
and scheduler entries from that release, health-checks the web process over loopback, and returns
a non-secret candidate for generation-bound ingress.

The launcher uses the Docker CLI directly and adds no runtime package. Docker is a useful minimum
boundary for mutually untrusted application accounts; it is not equivalent to a VM. Use dedicated
VMs or microVMs when the host, kernel, or Docker daemon must not be shared between tenants.

## Open the launcher

Create the provider data store first so its owner-only root exists. Pre-pull an application image,
resolve its immutable repository digest, and run the provider as a dedicated non-root operating
system user:

```ts
import {
  openDockerDeploymentRuntimeLauncher,
} from "@clank.run/framework/provider-docker";
import {
  openDeploymentProviderDataStore,
} from "@clank.run/framework/provider-data";

const rootDirectory = "/var/lib/clank-provider";

const data = await openDeploymentProviderDataStore({ rootDirectory });
const runtimes = await openDockerDeploymentRuntimeLauncher({
  rootDirectory,
  owner: "runner-west-01",
  image: "registry.example/clank-node@sha256:<64-hex-digest>",
  memory: "512m",
  cpus: "1",
  pidsLimit: 128,
  maxRuntimes: 100,
  maxContainers: 400,
  portStart: 46_000,
  portEnd: 49_999,
  onError(error) {
    privateProviderLog(error);
  },
});
```

Mutable image tags are rejected unless `allowMutableImage: true` is explicit. The default
container user is the provider process's uid and gid; uid 0 is rejected unless
`allowContainerRoot: true` is also explicit. This keeps owner-only releases and SQLite files
usable without changing their ownership while making a non-root provider service the safe
default.

`owner` is an exact Docker label and must identify one launcher process. On open, Clank lists
containers carrying both `run.clank.managed=provider-runtime` and that exact owner, forcibly
removes them, and verifies cleanup before returning. Every later stop also enumerates the exact
owner/project/release/generation labels, so a container whose create result was ambiguous cannot
disappear from tracking before removal is proven. It never adopts a process after restart. Choose
a stable node-specific owner and never run two live launchers with the same owner.

## Reconcile data, runtime, and ingress

Prefer the complete
[`openDockerDeploymentProviderService()` composition](provider-service.md), which persists the
desired generation/fence and implements this ordering. If building a custom provider, SQLite
migrations and restore require a stopped writer. Revoke and drain traffic, stop the current
runtime, apply provider data, and launch only the web candidate inside the store's private
validation callback:

```ts
let candidate: Awaited<ReturnType<typeof runtimes.launch>> | undefined;
let preparedRuntime: PreparedDeploymentRuntimeData | undefined;

await runtimeIngress.deactivate(
  request.operation.projectId,
  currentGeneration,
);
await runtimes.stop(request.operation.projectId);

try {
  const committed = await data.apply({
    operation: request.operation,
    desired: request.desired,
    runtime: request.runtime!,
    signal: request.signal,
  }, async (prepared) => {
    preparedRuntime = prepared;
    candidate = await runtimes.launch({
      prepared,
      signal: request.signal,
      deferBackground: true,
    });
  }, async () => {
    if (candidate) {
      await runtimes.stop(candidate.projectId, candidate.generation);
    }
  });

  if (!candidate || !preparedRuntime) {
    throw new Error("The private candidate was not launched.");
  }
  const active = await runtimes.activate(candidate, request.signal);

  await runtimeIngress.activate({
    protocol: "clank-runtime/1",
    projectId: committed.projectId,
    releaseId: committed.releaseId,
    generation: committed.generation,
    path: preparedRuntime.ingress.route,
    token: preparedRuntime.ingress.token,
    upstream: active.upstream,
  });
} catch (error) {
  await runtimes.stop(request.operation.projectId).catch(privateProviderLog);
  // Reconcile the last committed generation before restoring its route.
  throw error;
}
```

`PreparedDeploymentRuntimeData.config` is the exact normalized deployment config decoded from the
verified capsule. The launcher does not accept a second caller-supplied config, so an adapter
cannot accidentally start a different entry or job topology from the one that was migrated.

Ordinary `launch()` starts the web container, workers, and scheduler, then confirms the complete
topology. `deferBackground: true` starts and health-checks only the private web candidate while
retaining a memory-only activation plan. After `data.apply()` commits, `activate()` starts every
worker/scheduler, confirms they remain running, erases that plan, and atomically marks the runtime
active. `commit()` remains available only for a non-deferred candidate. If apply, abort, health,
background startup, or activation fails, Clank stops and removes the candidate containers and
releases their port.

Always pass the optional data-store discard callback when validation can start a process. It
proves the candidate stopped before an uncommitted SQLite change is restored. A cleanup failure
leaves the journal for restart recovery rather than rolling data back beneath a possibly live
runtime.

An exact live launch retry is idempotent. The exact last committed generation can also be
relaunched after a deliberate stop, which is required to recover the prior generation after a
failed migration or ingress switch. A different release or capsule for that generation, a lower
generation, a second project beyond capacity, an unavailable port, or a second generation while
the project's current runtime remains present fails closed.

## Secrets do not become Docker configuration

Clank does not pass application-named variables to the host Docker process and does not use
`docker create --env` for the runtime envelope. It:

1. creates an interactive container with no application environment in its arguments or config;
2. starts and attaches to that exact container without a shell;
3. writes one bounded base64url JSON envelope through container stdin;
4. decodes and validates it inside the already-running Node process;
5. destroys stdin, sets the application environment, and imports the verified relative entry; and
6. retains it only in memory while background activation is deliberately deferred, then releases
   it after activation or cleanup without exposing it through inspection.

Names such as `DOCKER_HOST`, `LD_PRELOAD`, `NODE_OPTIONS`, proxy controls, and TLS controls can
therefore neither redirect the host Docker client nor affect the container's Node loader before
the bootstrap is running. Secret values are absent from Docker CLI arguments, host application
variables, labels, and persisted container environment metadata. They remain available to the
application process, its memory, `/proc` peers permitted by the host, a privileged Docker
administrator, and any child process it deliberately starts. Treat the provider host and Docker
daemon as trusted application compute.

The host Docker CLI inherits only a small operator allowlist for Docker connection/context/TLS,
proxy, rootless runtime, locale, `PATH`, and `HOME` configuration. Unusual installations can add
explicit trusted values through `dockerEnvironment`; never populate that option from a runtime
capsule or project secret.

The launcher never writes application stdout or stderr into durable Clank state. It keeps only a
128 KiB/1,000-entry per-runtime tail in provider-process memory for the authenticated diagnostics
boundary. Docker's bounded `local` log driver separately retains three 10 MiB files per container
for private operator diagnostics. Applications must still avoid logging secrets, and operators
must protect and expire Docker logs.

## Container boundary

Every runtime has:

- an immutable image selected with `--pull never`;
- a read-only root filesystem and read-only exact release mount;
- one read-write mount for only that project's provider data directory;
- all capabilities dropped, `no-new-privileges`, a non-root uid/gid, and Docker init;
- explicit memory, equal memory-plus-swap, CPU, and PID ceilings;
- bounded no-exec, no-suid, nodev `/tmp` and `/run` tmpfs mounts;
- `--restart no`, bounded stop time, and bounded local logs; and
- only the web port published on a provider-selected `127.0.0.1` port.

`diagnostics(projectId, logLimit?)` combines the memory-only output tail with one shell-free
`docker container stats --no-stream` invocation over the exact tracked container IDs. It returns
only role/instance identity, running state, memory/limit, CPU, PIDs, network I/O, block I/O, and a
path-free capacity sample for the filesystem containing the project's data directory. Filesystem
capacity covers the shared provider volume and is not per-project attribution. Malformed, partial,
duplicate, oversized, or mismatched Docker statistics fail the container resource sample closed
without changing lifecycle state. An unavailable filesystem sample is reported independently
without hiding bounded logs or valid Docker statistics. The complete provider service carries this
object through its separately authenticated private control route.

Workers and schedulers receive the same release and database but publish no port.
`CLANK_PROCESS_ROLE`, worker concurrency, worker queues, database aliases, managed-ingress
settings, host, and port are provider-controlled and overwrite any capsule value.

The default Docker `bridge` network preserves ordinary application egress but is not a
tenant-grade network policy. Configure a provider-controlled network, firewall application
egress, protect the Docker socket, enable rootless Docker or user namespaces where practical,
apply seccomp/AppArmor/SELinux, enforce disk quotas outside the container, and separate hostile
tiers onto stronger compute boundaries.

## Restart and shutdown behavior

The ingress registry and launcher registry are intentionally memory-only. After a provider
restart:

1. managed ingress has no active route and returns unavailable;
2. launcher open removes exact-owner orphan containers;
3. the coordinator reissues the current desired capsule under a new operation fence;
4. provider data recognizes the already-committed generation and re-verifies its release;
5. the launcher starts and health-checks a fresh candidate; and
6. only then does the provider restore the exact generation-bound ingress route.

This is restart reconciliation, not process adoption. A Docker container that happened to survive
cannot receive traffic merely because old control-plane observation said it was healthy.

`stop(projectId, generation?)` gracefully stops and removes every web/job container in that exact
runtime, then verifies none of its owned container IDs remain. `close()` rejects new work,
aborts in-progress launch and health work, stops all tracked runtimes, removes any remaining
exact-owner containers, verifies convergence, and rejects if Docker cleanup cannot be proven.
After confirmed provider-data deletion, call `forget(projectId, generation)` to release the
inactive generation high-water mark.

Continue with [Provider data lifecycle](provider-data-lifecycle.md),
[Provider runtime ingress](provider-runtime-ingress.md),
[Complete deployment provider service](provider-service.md),
[Deployment provider adapters](provider-adapters.md), and
[Remote runtime placement](runtime-placement.md).
