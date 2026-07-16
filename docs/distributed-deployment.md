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

## Failure semantics

- Duplicate API requests converge through idempotency keys.
- Crashed workers leave leased operations that become reclaimable.
- Expired nodes become offline for placement.
- Draining nodes keep current work but receive no new desired placements.
- Retry delay is exponential and bounded; exhausted operations enter `failed`.
- Node capacity is placement based, deterministic, and region aware.

SQLite coordination is suitable for multiple workers on one durable host. Multi-region control planes should bind the same orchestration semantics to the external transactional control database described in the data-plane guide.

