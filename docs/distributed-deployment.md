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

## Platform behavior

The built-in platform acquires a durable `project:<id>` lease in addition to its local queue. It renews the lease during long operations and returns `PROJECT_BUSY` if another control worker owns it. A lost lease is surfaced as `PROJECT_LEASE_LOST` rather than silently claiming coordinated success.

## Agent loop

A production deployment agent should:

1. register or load its node credential;
2. heartbeat before half of the node TTL;
3. stop claiming new work while draining;
4. claim a bounded operation batch;
5. renew long-running operation leases;
6. make runtime changes using the operation fence;
7. report desired generation observations; and
8. complete or fail with a bounded, non-secret result.

Agent credentials and operation lease tokens are shown only to the worker and stored as digests. Control-plane database access remains privileged and should not be exposed to application processes.

`createDeploymentCoordinatorClient` implements the network calls above. A later execution adapter
still has to map claimed operations to the host's Docker, VM, or microVM runtime and make the
release/data plane reachable. In the current built-in platform, local deployment activation remains
owned by the included supervisor; enabling enrollment alone does not move a project or add an
infrastructure service.

## Failure semantics

- Duplicate API requests converge through idempotency keys.
- Crashed workers leave leased operations that become reclaimable.
- Expired nodes become offline for placement.
- Draining nodes keep current work but receive no new desired placements.
- Retry delay is exponential and bounded; exhausted operations enter `failed`.
- Node capacity is placement based, deterministic, and region aware.

SQLite coordination is suitable for multiple workers on one durable host. Multi-region control planes should bind the same orchestration semantics to the external transactional control database described in the data-plane guide.
