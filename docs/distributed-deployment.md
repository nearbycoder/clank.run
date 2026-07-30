# Durable distributed deployment

Clank deployment coordination is persisted in the control database. Process-local maps are still used as an optimization, but correctness is protected by authenticated leases and monotonic fencing tokens.

`openDeploymentOrchestrator` provides four durable contracts:

1. **Distributed project leases** serialize deploy, rollback, backup restore, and other destructive project operations across control-plane workers.
2. **Node sessions** authenticate deployment agents, publish region/capacity/labels, support draining, and expire without heartbeats.
3. **Desired placement state** records release, running/stopped state, assigned node, and a monotonically increasing generation.
4. **Operations** use idempotency keys, explicit queued/leased/retry/succeeded/failed states, retry timing, attempt limits, lease expiry, and fencing.

```ts
const orchestrator = openDeploymentOrchestrator(controlDatabase);

const agent = await orchestrator.registerNode({
  id: "iad-node-01",
  region: "iad",
  capacity: 100,
  labels: { runtime: "node24", isolation: "microvm" },
});

const desired = await orchestrator.setDesired({
  projectId,
  releaseId,
  state: "running",
  region: "iad",
});

const [operation] = await orchestrator.claim(agent.node.id, agent.token);
```

An agent must renew a leased operation before expiry. Completion and failure compare the node, token digest, lease expiry, and fence. If a worker resumes after another worker has reclaimed the operation, its stale completion is rejected.

Desired-state observations are generation checked. A late report for generation 4 cannot overwrite generation 5.

## Authenticated HTTP transport

Remote nodes should never open `control.sqlite`. Enable the optional coordinator transport on the
control plane with a separate secret:

```sh
CLANK_RUNNER_REGISTRATION_TOKEN="$(openssl rand -base64 48)" clank-platform
```

The fixed protocol prefix is `/api/runner/v1`. It is closed with `404` when the token is unset.
Outside loopback, clients accept only HTTPS and refuse redirects so a control-plane response cannot
forward a bearer credential to another origin.

```ts
import { createDeploymentCoordinatorClient } from "@clank.run/framework/runner";

const coordinator = createDeploymentCoordinatorClient({
  baseUrl: "https://deploy.example.com",
  timeoutMs: 10_000,
});

const session = await coordinator.register(process.env.CLANK_RUNNER_REGISTRATION_TOKEN!, {
  id: "runner-west-01",
  region: "us-west",
  endpoint: "https://runner-west.internal.example",
  capacity: 20,
  labels: {
    isolation: "docker",
    architecture: "amd64",
  },
});

await coordinator.heartbeat(session.node.id, session.token);
const operations = await coordinator.claim(session.node.id, session.token, 4);
```

Enrollment rotates and returns a node credential once. The node keeps that credential in its own
secret storage. Node tokens and operation lease tokens are stored only as SHA-256 digests in the
control database. Losing a node token requires re-enrollment; re-enrollment rotates it and lets
already leased work expire for safe reclamation.

| Call | Contract |
| --- | --- |
| `register` | Enrollment-token-authenticated node creation or credential rotation |
| `authenticate` | Credential and current heartbeat-lease verification |
| `heartbeat` | Lease renewal plus bounded capacity/label changes |
| `drain` | Stop new placement while preserving current work |
| `claim` | Bounded ready-operation claim with a fresh token and increasing fence |
| `artifact` | Download the exact content-addressed release bound to a current operation lease |
| `renew` | Extend one still-current operation lease |
| `complete` | Commit a bounded JSON result only for the current node/token/fence |
| `fail` | Store a bounded safe error and schedule retry or terminal failure |
| `observe` | Publish generation-fenced running/stopped/failed desired state |

Requests are JSON-only and body-bounded. Responses are no-store and response-bounded by the client.
Authentication failures are generic, bearer credentials are never accepted in URLs, and private
unexpected errors go only to the control plane's operator logger.

The registration token is more powerful than a node token because it can rotate any named node.
Use a dedicated secret—not the platform master key, account token, project token, or application
secret. Put edge rate limiting in front of enrollment, restrict it to a private network when
possible, and rotate it after provisioning-system exposure.

## Content-addressed release transfer

When an artifact provider is configured, the coordinator exposes a binary `artifact` call under the
same versioned prefix. It requires all three authorities at once:

1. the current node bearer credential;
2. an unexpired operation lease token whose node and monotonic fence match; and
3. a provider result for that operation's project and release.

The provider receives a frozen operation snapshot without its lease token. Both sides enforce an
independent byte ceiling. The coordinator verifies the provider's SHA-256 digest before sending,
and the client requires the exact media type, content length, and digest before returning bytes.
The response is private, no-store, non-sniffable, HTTPS-only outside loopback, and redirect
refusing.

Artifact selection uses the canonical operation payload read back from the transactional
coordinator after lease authentication. A compromised node cannot keep a valid operation token
while substituting another release ID in the echoed request. The coordinator rechecks the lease
after provider I/O and digest verification, so work reclaimed during a slow read receives no
artifact response.

```ts
const artifact = await coordinator.artifact(
  session.node.id,
  session.token,
  operation,
);

const bundle = await decodeDeploymentBundle(artifact.bytes);
await extractDeploymentBundle(bundle, stagingDirectory);
```

`clank-platform` automatically retains the original compressed, content-addressed upload for new
releases when remote-node enrollment is enabled. Local retention is owner-only, inode-checked, and
digest-checked. An operator can instead configure the framework's S3-compatible `ObjectStore`;
each release then records a stable repository namespace and exact key, and every leased download
is independently size- and digest-verified. Cleanup and site deletion remove the matching object.
A missing or changed namespace fails closed rather than treating a different bucket or prefix as
the old repository.

Both modes remain in release quota accounting. No extra copy is retained while remote enrollment
is disabled, so the default single-host topology keeps its existing disk cost. Existing local
releases remain local after object storage is enabled, and releases created before enrollment was
enabled need a redeploy before a remote node can fetch them. See
[Object storage](object-storage.md) for environment configuration and failure boundaries.

The artifact contains deployable code and declared non-secret configuration. Platform-managed
secrets and application databases are not added to it. Delivering those to another host requires
the separately authenticated secret and data-plane contracts; never place them in an operation
payload or release archive.

## Platform behavior

The built-in platform acquires a durable `project:<id>` lease in addition to its local queue. It renews the lease during long operations and returns `PROJECT_BUSY` if another control worker owns it. A lost lease is surfaced as `PROJECT_LEASE_LOST` rather than silently claiming coordinated success.

## Deployment agent loop

`openDeploymentAgent` owns the provider-neutral worker lifecycle. A runtime integration supplies
only the fenced `execute` function; Clank handles enrollment, durable node credentials, startup
heartbeat, un-draining, bounded claims, concurrency, lease renewal, desired-state observations,
settlement, and graceful drain.

```ts
import {
  createDeploymentCoordinatorClient,
  fileDeploymentNodeCredentials,
  openDeploymentAgent,
} from "@clank.run/framework/runner";
import {
  decodeDeploymentBundle,
  extractDeploymentBundle,
} from "@clank.run/framework/deploy";

const client = createDeploymentCoordinatorClient({
  baseUrl: "https://deploy.example.com",
  timeoutMs: 10_000,
});

const agent = await openDeploymentAgent({
  client,
  node: {
    id: "runner-west-01",
    region: "us-west",
    capacity: 20,
    labels: { isolation: "docker", architecture: "amd64" },
  },
  // Needed on first enrollment or deliberate credential rotation only.
  registrationToken: process.env.CLANK_RUNNER_REGISTRATION_TOKEN,
  credentials: fileDeploymentNodeCredentials(
    "/var/lib/clank-runner/credentials.json",
  ),
  concurrency: 4,
  async execute(operation, context) {
    const artifact = await context.artifact();
    const bundle = await decodeDeploymentBundle(artifact.bytes);
    await extractDeploymentBundle(bundle, stagingDirectoryFor(operation.id));

    // The provider adapter must make each runtime mutation idempotent under
    // context.operation.fence and stop when context.signal aborts.
    const result = await reconcileRuntime(operation, {
      fence: context.operation.fence,
      signal: context.signal,
    });

    const desired = operation.payload as {
      generation: number;
      releaseId: string | null;
      state: "running" | "stopped";
    };
    await context.observe({
      generation: desired.generation,
      releaseId: desired.releaseId,
      state: desired.state,
    });
    return result; // Bounded, JSON-serializable, and non-secret.
  },
  onError(error) {
    writePrivateOperatorLog(error);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void agent.close());
}
await agent.done;
```

The file credential store serializes updates in one process, rejects symbolic links, non-regular
files, inode/path swaps, unexpected ownership, oversized documents, and group/world-readable modes,
and replaces an owner-only `0600` JSON file atomically. Put it on a persistent private volume. Use
a separate file per agent process; it is not a cross-process lock or network secret store. The
in-memory store is intended for tests and ephemeral nodes.

After the first successful enrollment, remove the enrollment secret from the node when your
provisioning system permits it. A restart authenticates with the saved node credential. If that
credential was rotated, startup fails unless the enrollment secret is deliberately supplied; with
it, the agent clears the invalid credential, re-enrolls, and atomically saves the replacement.
An already-running holder whose credential is rotated stops claims and renewals, aborts its active
work, reports the authentication failure privately, and resolves `done` so its process supervisor
can replace it.

### Execution and shutdown guarantees

- The executor receives an `AbortSignal`. It must pass that signal to provider calls and terminate
  subprocesses or containers when it fires; JavaScript cannot forcibly stop code that ignores it.
- Lease renewal runs while execution and settlement are in progress. Losing or expiring a lease
  aborts local work and never completes or fails through a stale fence.
- Executor failures reach `onError` locally, while the coordinator receives
  `Deployment execution failed.` by default. A custom `failureMessage` must return only bounded,
  non-secret text.
- A missing completion response is an uncertain outcome: the agent reports it locally and leaves
  the lease to expire instead of converting a possibly committed success into an explicit retry.
  Provider mutations must still be idempotent under the operation ID and fence.
- `close()` marks the node draining, stops new claims, finishes work accepted by an in-flight claim,
  and keeps heartbeats and operation renewals alive during the grace period. At
  `shutdownTimeoutMs`, remaining work is aborted and abandoned for fenced reclamation.
- Draining is enforced in the coordinator as well as the loop, so a misbehaving or racing node
  cannot claim queued work after the drain update commits.

Agent credentials and operation lease tokens are shown only to the worker and stored as digests in
the control database. Control-plane database access remains privileged and must not be exposed to
application processes.

The generic lifecycle is complete, but `execute` still has to map operations to the host's Docker,
VM, or microVM runtime and make the release/data plane reachable. In the current built-in platform,
local deployment activation remains owned by the included supervisor; enabling enrollment alone
does not move a project or provision infrastructure.

## Failure semantics

- Duplicate API requests converge through idempotency keys.
- Crashed workers leave leased operations that become reclaimable.
- Expired nodes become offline for placement.
- Draining nodes keep current work but receive no new desired placements or operation claims.
- Retry delay is exponential and bounded; exhausted operations enter `failed`.
- Node capacity is placement based, deterministic, and region aware.

SQLite coordination is suitable for multiple workers on one durable host. Multi-region control planes should bind the same orchestration semantics to the external transactional control database described in the data-plane guide.
