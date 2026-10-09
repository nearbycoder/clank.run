# Deployment dependency gates

Require managed services before activating new code on a target project. Gates apply to ordinary
uploads, local canaries, explicit rollback, environment promotion and channel activation.
Configure **Project → Environments → Required services for this project**, or use the linked CLI.
Configure each target independently; a family root's requirements do not implicitly configure
its staging or production projects. Accepted writer restart is independent of new readiness.

## Configure services

A requirement names a project in the same workspace, readiness `active` or `healthy`, and an
optional exact upload SHA-256 `digest`. Individual projects must have the same owner. Preview
projects, self references, cycles, duplicates, external URLs, custom headers and scripts are
rejected. At most 16 services are required. Every check and activation requires current target
authority and current read access to every service.

```sh
clank dependency get --json
```

An unconfigured target returns version zero, no requirements, a 5,000 ms deadline and denied
overrides. Save a bounded JSON file, for example `dependencies.json`:

```json
{
  "requirements": [
    { "projectId": "MANAGED_SERVICE_ID", "readiness": "healthy" }
  ],
  "timeoutMs": 5000,
  "overridePolicy": "deny"
}
```

```sh
clank dependency configure --config=dependencies.json --expected-version=0 --json
clank dependency get --json
clank dependency check --expected-version=1 --json
clank dependency history --json
clank dependency activations --json
```

Configuration requires a current owner/admin, target token-management permission and the
installation's configured fresh-authentication policy. Initial setup requires an idle project
without a deployment lease or staged writer. Later updates increment the version and invalidate
activations that captured the old configuration. Concurrent saves admit one version; stale
saves return `DEPENDENCY_VERSION_STALE`. Inspect current configuration after a lost save response
before reviewing another update. An empty list preserves the versioned configuration.

Required services cannot be deleted until references are removed. Configuration publication
and deletion share a graph lease before any service files are removed.

The total health deadline is 100–10,000 ms. Up to four probes run concurrently, with a maximum
1,500 ms per request. `active` requires a successfully active release; `healthy` also requires
its exact managed runtime to answer its configured health path with a successful HTTP status.
An optional digest must match the retained upload. Redirects are not followed. Response bodies,
application errors and runtime credentials are not retained. Fixed reasons distinguish inactive
code, digest mismatch, unavailable runtime, failed health and timeout.

## Review exact services

A check returns its ID, configuration version and exact release, upload digest, activation time,
provider generation when applicable, and monotonic activation sequence. The private review also
binds workspace, placement and node. History retains the newest 100 checks and newest 100
completed activation receipts, plus all unresolved work. Current permission filters or redacts
dependency details.

Explicit checks last five minutes and belong to their creating credential. A browser session's
check cannot be used by a device-token CLI request, even for the same account. Activation probes
health again while requiring the reviewed configuration and service identities to remain exact.
Replacing a service with an identical upload still changes its activation sequence. Expired or
pruned unaccepted checks fail with `DEPENDENCY_CHECK_EXPIRED`; inspect state, check again and
use a new activation key.

```sh
clank dependency check --expected-version=1 --json
clank deploy --dependency-version=1 --dependency-check=CHECK_ID --json
```

Environment and channel activation accept the same optional flags alongside their existing
exact artifact, target, versions and request key. Create the check with the same CLI credential
on the target project. Dashboard promotion/channel review checks the target automatically,
displays the exact services, and retains the check ID and version with the reviewed request.
Editing fields invalidates review. Pending exact requests survive project navigation in that
browser session; reload requires review again. Sign-out and revoked project access clear drafts
and visible details.

Configured clients without an explicit check capture the current services during activation.
Unconfigured existing clients retain their original behavior. An explicit version or check
opts even an empty configuration into reviewed activation. Gates protect new code acceptance;
they do not continuously stop accepted writers when a service later becomes unhealthy. Accepted
writer restart and verified prior-writer compensation bypass new readiness. Current identity
and authority are checked across awaits and in the acceptance publication transaction.

## Rollback and exact retries

Configured rollback requires an inactive retained release, an explicit request key, and the
current target release and monotonic activation sequence from `dependency get`. The sequence
prevents an old request becoming valid just because the target returns to the same release.

```sh
clank dependency get --json
clank dependency check --expected-version=1 --json
clank rollback OLD_RELEASE_ID --key=reviewed_rollback_0001 \
  --expected-active=CURRENT_RELEASE_ID --expected-activation=ACTIVATION_SEQUENCE \
  --dependency-version=1 --dependency-check=CHECK_ID --json
```

Keep all fields and the key unchanged on retry. Accepted replay returns its original result
without activating old code again or checking current service health. Current permission still
applies. Changed input fails with `DEPENDENCY_RETRY_CHANGED`. Expired ordinary upload receipts
fail closed rather than silently accepting their keys as new operations. Failed work requires
inspection and a new request after recovery; a new key cannot bypass an unresolved writer.
Reviewed rollback to an already active release is rejected instead of retaining an ambiguous
no-op request.

Local rollback supports the existing `--restore-data --confirm="restore TARGET_SLUG"` contract.
It retains a separate durable safety snapshot before copying older data, so a failed or
interrupted rollback restores its own prior writer and current data.

## Human readiness approval

Overrides default to denied. `overridePolicy: "administrator"` permits an explicit human browser
owner/admin with current token-management permission and configured fresh authentication.
Device and project tokens cannot approve readiness overrides. The dashboard requires an 8–500
character reason and exact typed confirmation:

```text
override-dependencies TARGET_SLUG CONFIGURATION_VERSION
```

Approval binds the configuration, credential, exact service identities and activation request,
and is audited on acceptance. It bypasses readiness alone. Changed identity, revoked authority,
certification, attestation, migration policy, target changes and recovery fences still reject.
The CLI provides no human-approval substitute.

## Provider scope

Gated provider activation requires a current operator certificate for the exact assigned,
co-located Docker/XFS host. Initialized targets verify it before staging and before acceptance.
Initial targets verify their newly assigned host before acceptance. Remote hosts need matching
remote proof; a local certificate does not certify Railway or another production machine.

After initialization, gated provider uploads and rollback preserve the exact migration corpus
and database path. New, removed or changed migrations are rejected before staging. Provider
rollback activates code only; use the separately reviewed provider data-recovery workflow for
data restoration. Private compensation restores the prior generation's frozen environment so
newly edited candidate secrets cannot break prior accepted code.

A failed first activation verifies that its exact owned generation stopped and retains its
initialized application data. When the provider actually observed that generation running,
recovery records its initialization, host and exact artifact durably. The artifact remains
protected until a subsequent reviewed activation accepts a writer. That activation preserves
the initialized data and exact migration corpus, including after controller restart. A failure
without a verified running generation does not establish initialization proof; ambiguous data
requires operator inspection. Missing, changed or expired host proof keeps recovery fenced until
the operator verifies the host again.

## Interruption and recovery

A durable receipt captures dependencies, prior target, candidate and the data-change boundary
before destructive work. Controller interruption fences new writers and ingress until verified
recovery. Neither an exact staged local retry nor a new key can claim that the candidate committed.

```sh
clank dependency activations --json
clank dependency recover ACTIVATION_ID \
  --confirm="recover-dependencies TARGET_SLUG ACTIVATION_ID" --json
```

Recovery requires current rollback permission, owner/admin role, configured fresh authentication
and exact confirmation. The dashboard lists interrupted work under **Dependency checks and
activations**. Recovery verifies owned artifacts, snapshot identity/size, current target and
provider host, then stops the candidate and restores the prior writer. It may compensate after
service access is lost without granting that access again. Unverified cleanup remains
`recovery-required`; prior/candidate artifacts remain protected from deletion.

For environment or channel activation, recover through the original environment promotion
history. That finishes both durable receipts together. Standalone dependency recovery rejects
unresolved combined work with `PROMOTION_RECOVERY_REQUIRED`.

Before downgrading, recover every unresolved activation, clear each requirement list and verify
there are no dependency edges. Retained provider initialization must have a verified accepted
writer or its project must be removed through the explicit project deletion workflow.
Additive tables may remain, but older controllers cannot enforce
gates or deletion protection. Do not run old and new controllers concurrently on one control store.

## HTTP contract

Routes require current target permission and existing CSRF/session or bearer-token contracts.
Bounded bodies reject unknown fields.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/api/projects/:id/dependencies` | Configuration plus target release and activation sequence |
| PUT | `/api/projects/:id/dependencies` | `expectedVersion`, `requirements`, `timeoutMs`, `overridePolicy` |
| POST | `/api/projects/:id/dependencies/check` | Exact `expectedVersion`; credential-bound retained check |
| GET | `/api/projects/:id/dependencies/checks` | Newest 100 currently visible reports |
| GET | `/api/projects/:id/dependencies/activations` | Retained state with authorized or redacted details |
| POST | `/api/projects/:id/dependencies/activations/:activation/recover` | Exact `confirmation`; verified recovery |

Uploads accept optional `x-clank-dependency-version`, `x-clank-dependency-check`, and a bounded
JSON `x-clank-dependency-override` header. Promotion, channel activation and rollback bodies
accept optional `expectedDependencyVersion`, `dependencyCheckId` and `dependencyOverride`.
Override contains `expectedVersion`, `reason` and `confirmation`. Configured explicit rollback
also requires `idempotencyKey`, `expectedActiveReleaseId` and `expectedActivationSequence`.
Existing expected target, environment/channel versions, attestation and idempotency fields
remain part of the exact request.
