# Scheduled release windows

Schedule an exact current [release channel](release-channels.md) pin for a bounded maintenance
window. The controller retains the reviewed source artifact, target binding, active target release,
dependency configuration and initiating credential identity. It attempts activation no earlier
than the start and publishes acceptance only before expiry. Scheduling does not reserve a clock
instant or guarantee delivery: controller downtime, work already running and provider latency can
consume the window. Expired work cannot publish a release.

## Review and queue

Use **Project → Environments → Release channels → Schedule current pin**, or `clank release-window`
in a directory linked to the environment family root. Inspect the current channel, environment,
active target release and target dependency configuration before preparing a data-only request.
The following illustrative JSON requires your actual IDs, versions and future timestamps:

```json
{
  "channel": "stable",
  "expectedVersion": 1,
  "targetEnvironment": "staging",
  "expectedEnvironmentVersion": 1,
  "expectedActiveReleaseId": "EXACT_ACTIVE_TARGET_RELEASE",
  "expectedDependencyVersion": 0,
  "idempotencyKey": "reviewed_release_window_0001",
  "startsAt": "2026-11-01T01:30:00-05:00",
  "expiresAt": "2026-11-01T01:45:00-05:00",
  "timeZone": "America/Chicago"
}
```

```sh
clank release-window queue --request=release-window.json --json
clank release-window list --json
clank release-window show EXACT_WINDOW_ID --json
```

Times require a valid ISO calendar date, seconds and an explicit `Z` or UTC offset. Bare local
times are rejected. The window starts in the future, ends within the next 30 days and lasts at
most 24 hours. `timeZone` selects the IANA timezone for a review preview; it does not reinterpret
the supplied instants. During the repeated autumn hour, `01:30:00-05:00` and `01:30:00-06:00`
are different instants, which the UTC fields and offset-bearing preview distinguish. The API
normalizes accepted instants to UTC.

The dashboard reviews the artifact digest, source entry, target identity, binding version,
expected active release, migration policy, dependency version, UTC instants and selected timezone.
Editing fields invalidates approval. A lost queue response retains the exact request and key;
**Retry exact channel request** inspects or returns the original schedule, without queueing another
activation. CLI retries reuse the unchanged JSON and attestation. Changing any approved field or
initiating credential under the same key returns `RELEASE_WINDOW_RETRY_CHANGED`, including after
acceptance or expiry. A new attempt requires a fresh review and new key.

Signed-release installations require `--attestation=target-attestation.json`, or the same bounded
file in the dashboard. The target-bound signature is checked when queued and again through the
normal activation path. Scheduling stores credential IDs and original scope, never raw bearer
credentials, session cookies or CSRF tokens. Public observations exclude those IDs and attestations.

## Current authority and readiness

Queueing and execution require current family-root deploy permission, source read permission,
target deploy permission and independent projects in the same workspace. Production additionally
requires a current workspace owner/admin. Revoking the initiating token, signing out its browser
session, changing its original scope or removing required authority prevents acceptance even if
the work was already staged. Impersonation cannot schedule releases.

Execution rechecks the approved current channel, source binding, target binding, expected active
target and dependency configuration. A newer pin or changed target makes the old schedule fail.
Required services are checked at execution and acceptance; a queue-time health check is never
stored as authority. Schedules cannot carry a human readiness override. Normal artifact retention,
migration, current secrets, quotas and [provider host certification](environment-promotions.md)
continue to apply. A provider target must meet the existing co-located `code-only` promotion
contract; scheduling does not permit new provider migrations.

## Cancellation and recovery

```sh
clank release-window cancel EXACT_WINDOW_ID --expected-version=1 --json
clank release-window recover EXACT_WINDOW_ID --expected-version=3 \
  --confirm='recover-release-window FAMILY_ROOT_SLUG EXACT_WINDOW_ID' --json
```

Read the current schedule before either operation. Exact-version cancellation can stop pending
work or mark running work `cancelling`, including while health checks are waiting. It prevents
acceptance and verifies compensation before reporting a terminal result. The initiating user may
cancel while still authorized; cancelling another user's work requires workspace administration.
An accepted schedule is terminal and cannot be cancelled or executed again.

States are `pending`, `running`, `cancelling`, `accepted`, `failed`, `cancelled`, `expired` and
`recovery-required`. Failed health, cancellation, expiry or lost authority restore the prior writer
through the existing promotion path. Local `apply-safe` recovery restores its pre-operation database.
Provider `code-only` recovery preserves already committed application writes, including writes by
an unpublished healthy candidate; cancellation is not a data rollback. Uncommitted provider data
application is recovered through its journal. An interrupted migration or unverifiable cleanup
remains visibly fenced. The dashboard shows the exact recovery phrase; recovery requires current
workspace administration, target rollback authority and any configured recent-authentication
policy. It finishes only after the underlying exact promotion is verified as failed and its prior
writer can safely return. Failed, cancelled and expired schedules never silently retry; review a
new request after recovery.

Durable claims use the existing transactional control store and project leases. Restarts resume
pending work and exact provider generations; acceptance commits the schedule, channel action,
environment promotion and dependency receipt in the same transaction. A controller crash after
acceptance cannot reactivate the artifact. These contracts do not establish replicated-controller
leadership, multi-region failover or a cross-store scheduler.

## Bounds, retention and compatibility

Each family retains at most 100 unresolved schedules and 1,000 schedules total. History is not
silently pruned: exact request fingerprints remain reserved and the total bound can be exhausted.
`RELEASE_WINDOW_CAPACITY` or `RELEASE_WINDOW_HISTORY_CAPACITY` requires operator inspection, not
reuse of an old key. Lists show the newest 100 currently authorized schedules; an exact ID reads
any authorized retained row. Current access to root, source and target filters inspection.

Unresolved schedules protect their channel from retirement and referenced projects from deletion.
Their source uploads are protected by the retained channel pin. Keep control metadata and uploads
together in recovery backups. The schema is additive and existing immediate promotion fingerprints
remain unchanged. Before downgrading to a controller without scheduling support, cancel pending
work and finish or recover every unresolved schedule using the compatible controller. Older
controllers cannot enforce these schedule pins or execute their durable work. Configuring
`releaseWindows: { intervalMs: false }` pauses automatic execution for an owned maintenance period;
it does not extend approved windows. The default interval is 1,000 ms, with supported intervals
from 100 to 60,000 ms.

## HTTP and types

Routes are under `/api/projects/:root/release-windows`. Browser writes require the existing
session and CSRF checks; bearer requests retain their original credential scope.

| Method and suffix | Contract |
| --- | --- |
| `GET /` | Newest 100 currently authorized retained schedules. |
| `POST /` | Exact JSON fields above; optional `x-clank-release-attestation`; returns `schedule` with status 201. |
| `GET /:id` | One exact currently authorized schedule. |
| `POST /:id/cancel` | `expectedVersion`; returns the current cancellation result. |
| `POST /:id/recover` | `expectedVersion`, exact `confirmation`; finishes verified prior-writer recovery. |

Import `PlatformReleaseWindowRequest`, `PlatformReleaseWindow`, `PlatformReleaseWindowCancelRequest`
and `PlatformReleaseWindowRecoveryRequest` from `@clank.run/framework/platform`. The dependency
version, nullable expected active release and explicit instants are required. Observation fields
are readonly. Readiness overrides and queue-time check IDs are excluded from the request type.
