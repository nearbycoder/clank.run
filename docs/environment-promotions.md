# Artifact promotion across environments

An environment family binds development, staging and production to ordinary independent
projects in one workspace. Promotion sends a retained, verified compressed artifact through
the target deployment path without rebuilding it. The target resolves its own current secrets,
database, bucket namespace, quotas and migration policy. Source data and secrets stay with the
source project.

Use **Project → Environments** or `clank environment` in a directory linked to the family root.
A project can belong to one environment; previews and nested families are rejected. Binding
versions increase after every configuration change, including unbinding.

## Configure and review

Create independent projects, then bind their exact IDs:

```sh
clank environment list --json
clank environment bind development PROJECT_DEVELOPMENT --expected-version=0
clank environment bind staging PROJECT_STAGING --expected-version=0 --migration-policy=apply-safe
clank environment bind production PROJECT_PRODUCTION --expected-version=0 --migration-policy=code-only
```

Generated project IDs can start with a dash. In that case, put options before the
`--` terminator, for example:
`clank environment bind --expected-version=0 --migration-policy=code-only --json -- staging --PROJECT_ID`.

Workspace owners/admins configure bindings. Development/staging promotion requires current
deploy permission on the family root and target, plus read permission on the source.
Production promotion and direct production deployment/rollback require an owner/admin.
Project-scoped credentials cannot cross these projects. The platform rechecks sessions,
membership, project permissions and binding versions while work runs and when activation commits.

Choose a source release that activated successfully and retains its original upload. Capture
its immutable release ID and SHA-256, the target binding version and current active release ID.
The dashboard's **Review promotion** captures these values before enabling **Promote**.
Navigation between projects retains a pending request in that browser session. Reloading
requires reviewing again; durable history remains on the server.

```sh
clank environment promote staging --from=development \
  --release=SOURCE_RELEASE --digest=EXACT_SHA256 \
  --expected-version=1 --expected-active=TARGET_RELEASE \
  --key=promotion_request_0001 --json
clank environment history staging --json
```

For an uninitialized target under `apply-safe`, pass `--expected-active=none` explicitly.
The CLI never runs a build command for promotion. Signed-release installations require
`--attestation=target-attestation.json`, binding the unchanged artifact to the target project.
A source-project attestation cannot authorize the target. The dashboard accepts the same
bounded signed JSON during review. See [release attestations](release-attestations.md).

## Migration and hosting policies

`apply-safe` applies pending safe target migrations and rejects an artifact that enables unsafe
migrations. `code-only` requires an initialized target with no pending or changed migrations.
Production defaults to `code-only`; other environments default to `apply-safe`. Policy changes
increment the binding version and invalidate previous reviews.

Trusted local process hosting supports both policies and remains explicitly trusted. The
initial provider path supports a stable, initialized, co-located loopback provider with
`code-only` policy and an identical migration manifest. Configure operator-owned certificates
when opening the platform:

```ts
import { openPlatform } from "@clank.run/framework/platform";

const platform = await openPlatform({
  dataDirectory: "/operator/platform",
  publicUrl: "https://deploy.example.com",
  deploymentAgents: { registrationToken: process.env.RUNNER_REGISTRATION_TOKEN },
  providerPromotionHosts: {
    certified_node: {
      directory: "/operator/certificates/certified_node",
      profile: {
        mode: "docker-isolated",
        image: "node@sha256:EXACT_IMAGE_SHA256",
        user: "1000:1000",
        diskQuota: { mountDirectory: "/provider-data", hardBytes: 33554432, hardFiles: 64 },
        outboundNetwork: { allowCidrs: [] },
        networkProbe: { deniedAddress: "9.9.9.9" },
      },
    },
  },
});
```

Replace the image placeholder with an immutable digest. This trusted operator registry must
match the node's actual Docker, XFS and network profile. See [Linux host
certification](linux-host-certification.md) for explicit disposable probes. The platform
inspects the authenticated report before staging and again before activation. Missing, expired,
blocked or changed reports prevent acceptance. Node labels are not certificates; this is
point-in-time admission. Remote provider proof, provider `apply-safe`, and the legacy local
Docker runner's exact profile proof are unsupported and fail before staging. The registry is
bounded to 100 node IDs.

## Retry, failure and recovery

Keep the complete request, attestation and key after a lost response. An exact accepted retry
returns the same target release without reactivating it; changed requests with that key are
rejected. Current authorization and binding versions remain required for replay. Each family
retains at most 1,000 receipts; history returns up to 100 currently authorized records. Release
cleanup may remove runtime bytes while retaining safe provenance. Older local releases without
their original compressed upload cannot be reconstructed for promotion. New uploads retain and
charge those bytes against project storage capacity.

Accepted receipt metadata and target activation commit together. A pending provider request
resumes its original generation on an exact retry, including after controller restart. A new
key cannot bypass an interrupted target's fence. Failed keys are terminal; inspect the target
before creating another request.

For local migrations, the platform stops prior writers before taking a safety copy. Failed
health or migration restores that copy and verifies the exact prior runtime. Unverifiable
cleanup/restoration leaves `recovery-required`. Controller death during migration requires
explicit recovery before startup, ingress wake-up, deployment or rollback can launch another
writer.

Provider code-only recovery quiesces the candidate through the fenced generation and data
journal, then restores the exact prior artifact on its pinned node. Uncommitted data application
is recovered. Already committed application writes remain under code-only policy, including
writes from an unpublished healthy candidate. Local code-only rollback also preserves committed
data. Release rollback does not undo external side effects. Missing host proof or uncertain
cleanup keeps provider recovery fenced.

Inspect history and the active target, then recover with recent authentication and an exact
confirmation:

```sh
clank environment recover staging PROMOTION_KEY \
  --confirm="recover-promotion TARGET_SLUG PROMOTION_KEY" --json
clank environment unbind staging --expected-version=CURRENT_VERSION
```

Recovery verifies ownership, the prior release, the unchanged authoritative target and required
snapshot/host proof. It can cancel an unstaged pending receipt after proving no release exists.
Accepted/failed receipts remain terminal. Recovery cannot overwrite a target that advanced
independently. Unbinding preserves data/releases. Bound projects and families with unresolved
promotion receipts cannot be deleted.

## HTTP and consumer types

All paths are beneath `/api/projects/:root/environments`, use existing browser CSRF or bearer
authentication, and reject unknown fields:

| Method and suffix | Request / result |
| --- | --- |
| `GET /` | `{ environments }`, authorized bindings and unbound tombstones |
| `PUT /:name` | `{ projectId, expectedVersion, migrationPolicy? }` → `{ environment }` |
| `DELETE /:name` | `{ expectedVersion }` → unbound versioned `{ environment }` |
| `POST /:name/promotions` | `{ sourceEnvironment, releaseId, digest, expectedVersion, expectedActiveReleaseId, idempotencyKey }` → `{ promotion, release }`, status 201 |
| `GET /:name/promotions` | `{ promotions }`, bounded authorized history |
| `POST /:name/promotions/:key/recover` | `{ confirmation }` → `{ promotion }` |

Pass a signed target attestation through `x-clank-release-attestation` using the existing header
encoding. Receipts have `pending`, `staging`, `accepted`, `failed` or `recovery-required` state.
Stale bindings/targets and changed retries return 409, as do unsupported policy/proof. A still
converging provider returns 503 with retry guidance. Failed health/migration returns 422 after
verified recovery. An unresolved recovery remains fenced and must not be treated as accepted.

`@clank.run/framework/platform` exports `PlatformEnvironmentName`,
`PlatformEnvironmentMigrationPolicy`, `PlatformEnvironment`,
`PlatformEnvironmentBindingRequest`, `PlatformPromotionRequest` and `PlatformPromotion`.
These describe the HTTP contract: `expectedActiveReleaseId` is required and explicitly nullable;
receipt fields are readonly observations.

The control-store migration adds bindings and receipts without rewriting existing releases.
Rolling back application code disables the endpoints while preserving these tables and project
data. Complete unresolved recovery with a compatible controller before rollback; disabling
endpoints does not undo accepted promotions or resolve staged provider generations.

Use [persistent release channels](release-channels.md) to retain named immutable artifact history,
review explicit promotion or rollback, and retire pins without deleting uploads or application data.

Automatic provider compensation restores the prior active generation’s frozen runtime environment,
including its original secret revisions. Resolving newly edited secrets again could make both
the candidate and its prior code fail health checks. New promotions and explicit deployment
continue to resolve current target secrets; compensation restores the runtime authorized before
the failed candidate and rechecks its exact generation, node and host admission.

Require managed services before target activation with [deployment dependency gates](deployment-dependencies.md).
The API/CLI accept an optional exact configuration version and credential-bound check ID; dashboard
promotion and channel reviews capture these automatically. Target gates also apply to ordinary
uploads and explicit rollback, with durable interruption recovery and audited human readiness approval.

Use [scheduled release windows](release-windows.md) to review an exact current channel pin for
a bounded future window. Execution rechecks current authority and required services, cancellation
prevents acceptance, and interrupted work retains verified recovery fences. The dashboard exposes
**Schedule current pin** and **Scheduled releases** in the Environments tab.
