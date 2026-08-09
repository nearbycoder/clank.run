# Revision and release lifecycle

Clank describes a change from UI intent through a data mutation, migration, artifact, canary,
production activation, and rollback using dependency-free, inspectable data envelopes.

## End-to-end revision inspection and time travel

`createRevisionLedger()` validates ordered events and JSON Pointer patches. `inspectRevision()`
replays any revision and returns its state plus its causal/correlation trace.

```ts
import { createRevisionLedger, inspectRevision } from "@clank.run/framework/lifecycle";

const ledger = createRevisionLedger({ todos: {} }, [
  {
    id: "ui-1", revision: 1, at: new Date().toISOString(),
    kind: "ui", actor: user.id, summary: "Submitted todo",
    correlationId: "request-8",
  },
  {
    id: "mutation-1", revision: 2, at: new Date().toISOString(),
    kind: "mutation", actor: user.id, summary: "Created todo",
    correlationId: "request-8", parentId: "ui-1",
    patches: [{ op: "set", path: "/todos/todo-1", value: { title: "Ship" } }],
  },
]);

const beforeMutation = inspectRevision(ledger, 1);
const current = inspectRevision(ledger);
```

This is application-state replay, not an encrypted backup replacement. Do not put secrets or raw
authorization data in event metadata. Ledgers are bounded, monotonic, and may only reference an
earlier parent.

## Provenance, promotion, and progressive delivery

`createReleaseProvenance()` hashes the artifact, source revision, configuration, immutable
migrations, framework, builder, and time. `verifyReleaseProvenance()` detects later mutation.
Promotion pins that release while traffic moves through ordered stages.

```ts
const promotion = createPromotionPlan(provenance, [
  { name: "canary", trafficPercent: 5, requiredChecks: ["health", "journey"] },
  { name: "production", trafficPercent: 100, requiredChecks: ["health"], requiresApproval: true },
]);

const rollout = assessRollout(
  { samples: 800, errorRate: 0.004, p95Ms: 240 },
  { minimumSamples: 500, maximumErrorRate: 0.01, maximumP95Ms: 500 },
);
```

Insufficient samples pause. A mature stage breaching error, latency, or saturation guardrails
rolls back. This layers over health-gated atomic activation; it never replaces the last healthy
release during a failed activation.

## Sanitized clones and portable exports

`createSanitizedClone()` supports `keep`, `hash`, `redact`, `email`, and `drop`. Use a separate
secret salt for each trust boundary and provide it through the environment:

```sh
CLANK_CLONE_SALT="$SAFE_RANDOM_VALUE" \
  clank workbench sanitize rows.json clone-policy.json \
  --output=sanitized.json
```

Portable exports contain sorted files, per-file SHA-256, and a whole-export digest. The CLI
excludes `.git`, `.clank`, `.env`, packages, SQLite files, and prior exports; rejects symbolic
links and oversized files; omits common registry, cloud, SSH, and environment credential files;
and writes mode 0600.

```sh
clank workbench export . --name=todo --framework=0.18.0 \
  --output=todo.clank-export.json
```

Exports intentionally omit platform identity, domains, deployment tokens, billing data, and the
production database. Call `verifyPortableProjectExport()` before importing.

## Capacity simulation

`estimateCapacity()` exposes requests, transfer, storage, realtime connections, job CPU, replicas,
and the caller-supplied rate card. `clank workbench capacity workload.json rate-card.json --json`
returns the calculated units, cost drivers, and assumptions. It is a transparent estimate, not a
bill.
