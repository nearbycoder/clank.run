# Chaos and failure testing

Clank tests failures as state-machine behavior, not only happy-path output. The deterministic chaos suite runs under Node's test runner as part of every `npm test` and `npm run check`.

## Automated scenarios

| Fault | Expected invariant | Evidence |
| --- | --- | --- |
| Deployment worker disappears after claiming work | Expired work is reclaimed with a higher fence; the stale worker cannot commit | `tests/chaos.test.mjs`, orchestration tests |
| Remote agent restarts, loses a lease, or drains mid-claim | Saved credentials resume without enrollment; lost work is aborted without stale settlement; drained nodes claim nothing new | Runner and orchestration tests |
| Node tampers with a leased artifact request or the lease expires during storage I/O | The coordinator selects the canonical stored release and rechecks the lease before returning bytes | Runner and platform tests |
| Retained artifact permissions, size, or digest are changed | No release bytes leave the control plane; only a generic failure crosses the protocol boundary | Runner and platform tests |
| Local/S3 object bytes, metadata, response size, or request timing are hostile | The adapter refuses unsafe files, redirects, incomplete metadata, digest mismatch, oversized streams, and expired deadlines | Object-storage tests |
| Remote release object write is inconsistent, stored bytes are changed, or the repository identity changes | Failed writes are cleaned without consuming quota; leased reads rehash bytes; a mismatched namespace is rejected before store access; release/site cleanup targets recorded keys | Platform object-repository and runner tests |
| Completion response is lost | A possibly committed success is not converted into an explicit failure/retry | Runner tests |
| Encrypted backup is corrupted | Authentication fails before replacement; the live database remains unchanged | Chaos and recovery tests |
| Application upstream becomes unreachable | Requests fail generically, the circuit opens, and a later probe recovers | Chaos and data-plane tests |
| Candidate startup/health fails | Prior data and active release are restored | Platform tests and packaged conformance |
| Migration or artifact is malformed | Intake fails before activation and does not escape its project boundary | Migration, deploy, platform, and conformance tests |
| Concurrent/stale state is written | Version/fence/idempotency checks reject the stale operation | Backend, jobs, orchestration, and platform tests |
| Credential payload is hostile | Body, base64url, CBOR collection, and nesting limits fail closed | Security, auth, and WebAuthn tests |

Run only the deterministic chaos file after building:

```sh
npm run build
node --test tests/chaos.test.mjs
```

Run the release-level lifecycle:

```sh
npm run conformance
```

## Staging drills

Before public beta and at least quarterly:

1. Kill a deployment worker after it claims an operation; verify another worker reclaims it and the old fence cannot commit.
2. Stop the active app during traffic; verify health alerts, bounded failures, restart policy, and ingress recovery.
3. Publish an artifact whose health check fails after a pending migration; verify data and code return to the previous release.
4. Restore an encrypted off-host backup into a clean directory with the original key; compare integrity, revision, migrations, and representative application queries.
5. Remove access to email, object storage, webhook targets, and external database APIs; verify timeouts, retries, idempotency, dead letters, and redacted logs.
6. Drain a node and expire its heartbeat; verify desired placement is reassigned without accepting a stale observation.
7. Rotate a node credential while its prior holder is executing; verify the prior agent loses its
   lease, cannot settle, and the replacement agent reclaims with a higher fence.
8. Drop only the completion response after the coordinator commits it; verify the agent does not
   send `fail` and the runtime mutation remains idempotent when reconciliation resumes.
9. Hold an artifact read past its operation-lease expiry, then substitute a different release ID
   in the node's echoed payload; verify neither attempt returns attacker-selected bytes.
10. Change a retained artifact's mode, contents, size, and path type one at a time; verify each
    attempt fails closed without exposing a storage path or private exception.
11. Rotate a project secret and scoped CLI token; verify the prior values stop working and audit records remain readable.
12. Simulate disk-full and read-only filesystem conditions in an isolated environment; verify no partial release is activated.

## Safety rules

- Never run destructive drills against the only copy of production data.
- Capture the exact version, topology, fault injection, expected invariant, observed recovery time, and follow-up owner.
- Use synthetic accounts and credentials.
- Treat an unexpected successful stale write, cross-tenant read, unauthenticated restore, plaintext backup, or secret log entry as a release blocker.
- Keep drills deterministic in CI; reserve network partitions, process kills, storage faults, and regional failures for staging.
