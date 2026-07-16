# Chaos and failure testing

Clank tests failures as state-machine behavior, not only happy-path output. The deterministic chaos suite runs under Node's test runner as part of every `npm test` and `npm run check`.

## Automated scenarios

| Fault | Expected invariant | Evidence |
| --- | --- | --- |
| Deployment worker disappears after claiming work | Expired work is reclaimed with a higher fence; the stale worker cannot commit | `tests/chaos.test.mjs`, orchestration tests |
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
7. Rotate a project secret and scoped CLI token; verify the prior values stop working and audit records remain readable.
8. Simulate disk-full and read-only filesystem conditions in an isolated environment; verify no partial release is activated.

## Safety rules

- Never run destructive drills against the only copy of production data.
- Capture the exact version, topology, fault injection, expected invariant, observed recovery time, and follow-up owner.
- Use synthetic accounts and credentials.
- Treat an unexpected successful stale write, cross-tenant read, unauthenticated restore, plaintext backup, or secret log entry as a release blocker.
- Keep drills deterministic in CI; reserve network partitions, process kills, storage faults, and regional failures for staging.
