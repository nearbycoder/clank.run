# Deployment platform

Clank Deploy is the open-source control plane for turning a Clank source directory into a running release. It uses Fetch, Node, SQLite, Web Crypto, and no runtime NPM dependencies.

The platform is intentionally inspectable:

- deployment configuration is checked-in JSON;
- builds run locally as an argument array, never as a server-side shell hook;
- every artifact and file has a SHA-256 digest;
- artifacts contain the exact Clank runtime used by the CLI;
- SQL migrations have ordered, immutable checksums;
- releases, failures, rollbacks, backups, job cancellation/retry, tokens, secret-name changes, and
  projects are audited;
- secret values are encrypted and never returned by the API;
- failed migrations or health checks restore the prior database and process.

The browser console is also an operating surface, not only a login page. It shows site health,
1-hour through 30-day ingress performance, enforced capacity, releases, private queue health and
cron schedules, scheduled encrypted backups, logs, and the full custom-domain lifecycle. See
[Deployment dashboard, quotas, and domains](platform-dashboard.md).

Bind independent development, staging and production projects, then promote a retained exact
artifact through the [environment promotion workflow](environment-promotions.md). Each target
uses its own secrets, data and versioned migration policy.

For multiple coordinators sharing one private Linux catalog, opt into [automatic supervisor leadership](supervisor-leadership.md). Dedicated standby processes take over retained desired state after the previous coordinator and tenant cleanup are fenced.

## Five-minute managed path

```sh
clank login
clank create my-todo
cd my-todo
npm install
clank doctor
clank deploy
```

`clank login` connects to `https://clank.run` by default. The first deploy creates and links an isolated project automatically. Pass `--name`, `--slug`, or `--org` on that command when the directory name is not the intended platform identity.

## Local control-plane development

Run the open-source platform locally only when developing or self-hosting the control plane:

```sh
CLANK_PLATFORM_DATA=.clank-platform \
CLANK_PLATFORM_URL=http://127.0.0.1:4200 \
npm run dev:platform

clank login --server=http://127.0.0.1:4200
```

Create the bootstrap account at `http://127.0.0.1:4200` before approving the local device login. Remote platform URLs must use HTTPS; loopback HTTP is accepted only for development.

## Device login

`clank login` follows the interaction in [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628):

1. The CLI requests a high-entropy device code and short user code.
2. The user signs in at the exact platform origin and reviews the client name and code.
3. Approval requires the browser session's CSRF token.
4. The CLI polls at the server-provided interval.
5. The raw access token is returned exactly once. Only its SHA-256 hash is stored by the platform.
6. The CLI stores it in `~/.clank/config.json` with mode `0600`.

Device codes expire after ten minutes by default. Access tokens expire after 90 days by default. `clank logout` revokes the current token before deleting it locally.

Requests that have already authenticated a CLI token revalidate its exact credential and admitted scope at existing current-authority commit boundaries. Rotating its stored credential, narrowing its permissions, or changing its project while a body or asynchronous operation is pending invalidates that request. The request-local fingerprint is not persisted or exposed in responses or audit records. Approved durable release windows retain their separately documented delegation and current-grant checks.

Self-registration defaults to `bootstrap`: only the first account can register. Operators may explicitly choose public or disabled registration.

Owners and administrators invite everyone else from **Workspace → People**. Configure a mail
driver to turn invitation creation into automatic email delivery; without one, Clank visibly keeps
the copy-once token workflow. Pending mail is durable across restarts, leased across control-plane
instances, and encrypted only until it is sent or invalidated. Read
[Invitations and email delivery](invitations.md) for setup and guarantees.

Version 0.7.0 preserves existing Proact accounts, sessions, platform records, and CLI links while moving all writes to Clank names. Review [Renaming from Proact](renaming-from-proact.md) before upgrading a hosted control plane.

## Deployment configuration

Every app has `clank.deploy.json`:

```json
{
  "version": 1,
  "entry": "dist/server.js",
  "include": ["dist", "public", "migrations"],
  "build": {
    "command": ["clank", "build", "src", "dist"]
  },
  "database": {
    "path": "app.sqlite",
    "migrations": "migrations",
    "allowUnsafeMigrations": false
  },
  "health": {
    "path": "/healthz",
    "timeoutMs": 15000
  },
  "env": {
    "FEATURE_SET": "stable"
  },
  "jobs": {
    "entry": "dist/jobs.js",
    "workers": 2,
    "concurrency": 4,
    "queues": [],
    "scheduler": true
  }
}
```

Rules:

- `entry` must be compiled `.js` or `.mjs` inside an included path.
- Include paths are literal files or directories, not shell globs.
- Symbolic links, special files, parent traversal, `.env*`, private-key names, and VCS metadata are rejected.
- `build.command` is executed locally without a shell.
- `env` is public artifact configuration; credentials belong in platform secrets.
- `PORT`, `HOST`, `NODE_OPTIONS`, and `CLANK_*` variables are reserved, except the bounded
  application capacity settings `CLANK_AUTH_CONCURRENCY` (1–16), `CLANK_AUTH_MAX_QUEUE` (1–128),
  and `CLANK_MAX_LIVE_CONNECTIONS` (1–20,000). See [capacity sizing](self-hosting.md).
- `database.path` is persistent project data outside release directories.
- Changing `database.path` during deployment is rejected to prevent silently forking production data.
- `database.previewData`, when present, is the active production release's bounded sanitization
  contract for explicit `clank preview deploy --data=sanitized` branches. It is never read from the
  preview artifact, and raw database copying remains unavailable.
- `jobs.entry` is one compiled provider-neutral worker/scheduler module inside an included path.
- The configured background entry must be present in the artifact, including scheduler-only
  deployments with zero workers. It may also be the web entry when the application supports both roles.
- `jobs.workers` controls independent processes; `jobs.concurrency` controls handlers per worker.
- `jobs.queues` is an optional allowlist and `jobs.scheduler` enables one independently leased
  cron scheduler.
- Provider placement reserves one runner process slot for the web process, one for each worker,
  and one for the scheduler. A release waits without partial activation when no matching node has
  the complete slot demand.

## Artifact protocol

The wire media type is `application/vnd.clank.deploy+gzip`. Its document protocol is `clank-deploy/1` and contains:

- normalized configuration;
- builder protocol, Clank version, Node version, and source revision;
- SHA-256 bindings for normalized configuration and the complete material manifest;
- the exact ordered immutable migration IDs;
- a sorted file list with path, size, mode, SHA-256 digest, and base64 content.

The gzip timestamp is fixed, so identical inputs on the same Clank and Node versions produce identical bytes. The CLI also sends an artifact digest and idempotency key.

```sh
clank deploy --dry-run
clank inspect .clank/artifacts/<digest>.clank.gz
```

Dry-run artifact creation is offline and does not require platform credentials. Ambiguous upload failures retain a private local attempt record for 24 hours, allowing the next identical command to reuse its idempotency key instead of accidentally creating a second release after a lost response.

The decoder verifies the configuration, material, and migration bindings before returning an
artifact. Set `CLANK_SOURCE_REVISION` when a nonstandard CI system cannot provide `GITHUB_SHA` or
`RAILWAY_GIT_COMMIT_SHA`. The metadata supports the traceability goals of
[SLSA provenance](https://slsa.dev/spec/v1.2/provenance), but `clank-deploy/1` is not a signed SLSA
attestation. Signing and transparency-log integration are future extensions.

## Release transaction

Deployment runs in this order:

1. Authenticate the bearer token and verify project ownership.
2. Enforce request, gzip, file-count, file-size, and aggregate limits.
3. Verify config, paths, modes, file hashes, and artifact digest.
4. Extract into a non-active release directory.
5. Verify migration history and create a consistent SQLite backup while the active release continues serving.
6. If no migrations are pending, gracefully quiesce prior workers/scheduler while its web process
   continues serving, then launch the candidate web, workers, and scheduler.
7. Poll the candidate's configured health route and verify background-process startup without
   exposing it to public traffic.
8. Atomically switch managed ingress and active-release metadata to the healthy candidate. Resume
   the prior background set instead if the candidate fails.
9. Let requests already assigned to the prior web upstream finish, with a bounded two-second drain for
   long-lived streams, then stop the prior release.

A code-only candidate that fails startup or health never receives traffic and never stops the prior
release. Automatic crash recovery uses the same durable project lock as deploy, rollback, backup,
and deletion, so it cannot race a user deployment for the project's runtime ports.

When a measured canary fails, Clank removes it from new traffic and gives requests already
assigned to it the same bounded two-second drain before stopping the candidate. Requests that
exceed that limit can fail during termination. Verified process cleanup still precedes rollback
or writer replacement; an unresolved cleanup fence requires operator recovery.

### Isolated provider canaries

Provider projects can use the same measured traffic stages with explicit read-only isolation:

```ts
canary: {
  stages: [
    { trafficPercent: 10, durationMs: 30_000, minimumSamples: 100 },
    { trafficPercent: 100, durationMs: 60_000, minimumSamples: 500 },
  ],
  maximumErrorRate: 0.01,
  maximumP95Ms: 500,
  provider: { databasePolicy: "isolated-read-only", readPaths: ["/", "/healthz"] },
}
```

This requires native same-host Linux supervisor leadership, provider placement, managed ingress,
provider HTTP canary controls, and a primary deployment whose operation has completed. The first
release initializes the primary normally. Later candidates must have no declared jobs, an approved
public health path, and no pending migrations. The provider runs them with an isolated snapshot,
read-only database, no project environment secrets, and the provider's candidate resource limits.
Only anonymous GET/HEAD requests on approved exact paths enter the traffic split; writes,
authenticated requests, and other paths keep using the primary. Health probes do not count as
measured application samples. Every stage requires its configured sample count, error rate, and
p95 latency before its deadline. Undersampling or uncertainty fails the candidate.

The control plane retains a bounded exact operation, frozen policy, and monotonically increasing
controller epoch in its native catalog before sending prepare. Actual native supervisor and project
leases authorize each transition and asynchronous continuation; an epoch number alone does not.
Candidate traffic uses the same captured primary/candidate identity checks through response reads.
After a successful measurement, the platform first obtains and persists exact provider retirement,
then queues ordinary activation with the primary's latest data in `preserve` mode. Candidate data
is never promoted. A stopped/unknown response, expired lifetime, or missing inspect result cannot
stand in for acknowledged retirement.

Every native journal transition advances a retained epoch floor, mirrored in its project row in the
same transaction with exact readback. Missing tables, missing individual rows, and earlier transition
snapshots fail closed; startup does not reconstruct or reset them. The original provider operation's
controller epoch and an issued retirement epoch remain fixed for exact retries. New grants are above
the retained floor. A consistent rollback of the entire catalog still requires the provider's durable
fencing state; restoring both sides of a safety boundary is an operator recovery operation.

`GET /api/projects/:id/canary` includes the existing measured reports plus a nonsecret `provider`
status: operation ID, `controllerEpoch` (the current retained floor used as `expectedEpoch`, distinct
from the immutable provider operation epoch), release, phase, outcome, cleanup requirement, retry
status, reason, and update time. An uncertain control response returns
`PROVIDER_CANARY_RECOVERY_REQUIRED`; preserve the operation and retry exact cleanup before starting
another deployment. `POST /api/projects/:id/canary/recover` takes
`{ operationId, expectedEpoch }`, requires current deploy permission and configured fresh
authentication, and only retries cleanup. A stale operation or epoch returns a conflict. Once cleanup
finishes, interrupted or failed candidates require a new deployment idempotency key. An already
queued ordinary activation can resume with its original key and current authority.

The Console’s **Deployments → Canary rollout** panel shows retained measurements and provider
cleanup status even when measurement is disabled. **Clean up candidate** uses the displayed
operation and epoch; it only stops that candidate. A failed or uncertain request refreshes status
without automatically sending another mutation. Read-only support sessions cannot run cleanup.

The linked-project CLI provides the same controls:

```sh
clank canary status --json
clank canary recover canary_EXACT_OPERATION --expected-epoch 12 --json
```

Copy the exact operation and current retained epoch from status. A stale epoch is a conflict;
inspect again before deciding whether to retry. Cleanup does not promote a release.

Restart never resumes a partially measured stage or reuses its pass to allocate a new writer. It
withdraws candidate routing and retries exact retirement, including when provider canary policy is
now disabled. An ordinary activation already durably queued can continue. Retained uncertainty
blocks deployment, rollback, restore, failover, evacuation, deletion, and capsule admission. Cleanup
uses the retained provider origin and binding; a changed node endpoint cannot redirect the duty.
A revoked initiating credential cannot promote a candidate, but the current native controller still
performs its server-owned exact cleanup duty. Finite artifact and project cleanup keeps native lease
authority through asynchronous work and checks before each new destructive storage submission;
authority loss cannot cancel an external deletion that was already submitted. If the retained endpoint or cleanup credential is no
longer usable, preserve the catalog and provider state for operator recovery.

Enabling provider canaries permanently enrolls supervisor protocol 2 before active admission.
Earlier binaries reject that catalog before acquiring writer duties, even after candidates have
been retired or the option is disabled. There is no automatic downgrade: keep a compatible binary
for this catalog. Ordinary catalogs without provider-canary enrollment retain protocol 1.

An unexpected worker or scheduler exit crashes and restarts the complete release group instead of
leaving a healthy-looking web process with stale background work. Read
[Durable jobs and cron](jobs-and-cron.md) for queue correctness and process-provider requirements.

Pending SQLite migrations use the safer exclusive path: Clank stops the prior release, applies all
pending SQL in one `BEGIN IMMEDIATE`, starts and checks the candidate, and restores the verified
snapshot plus prior release if anything fails. This creates a short maintenance window because
arbitrary local schema changes cannot safely run beside unknown old application code.
Continuously writable multi-instance systems and zero-downtime schema changes need an external
database plus expand/contract migrations.

Before creating a release directory, Clank checks the site's retained-artifact count and the uncompressed bundle plus current SQLite/WAL footprint under the durable project lock. After taking a pre-deploy snapshot, it records the exact snapshot size. This bounds cumulative deployment storage rather than only bounding each upload.

```sh
clank releases
clank releases delete <inactive-release-id> \
  --confirm="delete-release <project-slug> <inactive-release-id>"
```

Cleanup requires `rollback` permission. The active artifact is never removable. Add `--allow-rollback-loss` only when intentionally removing the active release's immediate predecessor; that removes the predecessor's runtime files and the active release's matching data-restore snapshot. Cleanup preserves release metadata and audit history.

## Preview environments

`clank preview deploy <name>` creates or refreshes an expiring child environment without changing
the directory's production link. The child receives an independent project ID, hostname, port,
database, migration ledger, releases, secrets, jobs, logs, metrics, backups, and token namespace.
Data starts empty and secret values are never copied. An explicit `--data=sanitized` request may
branch only the rows and transforms frozen into the active production release; raw copies remain
unavailable and pull-request code cannot change the trusted policy.

Previews consume normal account/workspace project capacity, cannot contain nested previews, and
are grouped under their parent in the control-plane UI. Startup cleanup runs before release
recovery, so an expired runtime is deleted rather than restarted. The background cleaner uses the
same durable lock and path-safe complete deletion path as a manual removal. See
[Preview environments](preview-environments.md) for the CLI, API, CI, and retention contracts.

GitHub pull-request automation uses workload identity rather than a long-lived deployment secret.
`clank preview github configure <owner/repository>` binds an immutable GitHub repository ID and
exact deploy/cleanup workflow paths, then generates pinned workflows. The public exchange accepts
only GitHub-signed RS256 OIDC tokens for the configured repository, workflow, event, ref, and
control-plane audience. A JWT ID is single-use, and the resulting token expires after 15 minutes
with authority over exactly one `pull-N` preview. Federation is refused for a trusted in-process
runtime because pull-request code requires provider/container isolation.

## Site deletion

Owners and organization administrators can permanently reclaim a site slot from the dashboard or CLI:

```sh
clank project delete [project-id] \
  --confirm="delete-site <project-slug>" \
  --acknowledge-data-loss
```

Deletion requires an account-wide browser session or CLI token. A project-scoped token is deliberately insufficient, including one with `tokens` permission. Browser deletion also passes the normal same-origin and CSRF checks. The exact slug-bound phrase and separate acknowledgement make accidental generic confirmation impossible.

A production project with active preview children returns `PREVIEWS_EXIST`; delete or expire those
environments first. This prevents a parent-row cascade from leaving a supervised child process or
child storage outside the control database.

The operation holds the same durable project lock used by deploy, rollback, release cleanup, and backup work. It rechecks current membership under that lock, stops the supervised application, validates that the platform project path and its parents are real directories rather than symbolic links, and removes the complete project root. Only then does one control-database transaction revoke active project tokens, remove orchestration placement/operation state, delete project metadata and its cascading domain/release/secret/log/metric/backup-schedule rows, and append a surviving `project.delete` audit event.

If filesystem validation or removal fails, project metadata remains and Clank attempts to restart the prior active release. If the later metadata transaction fails after files were removed, the API reports a fixed recovery-safe error and a retry completes cleanup. A successful response means the platform-managed local application database, releases, rollback snapshots, local or object-backed encrypted recovery points, remote runner artifacts, secrets, logs, metrics, domains, and scoped tokens are gone. External databases, manual copies, provider-retained object versions, Caddy certificate storage, and other operator-managed copies are not discovered or erased.

## Workspace audit history

Every project and organization event carries durable organization attribution in the control database. The Activity dashboard and `clank activity --json` expose the same newest-first, cursor-paginated feed. Owners, administrators, and developers can read history only for organizations where their current role permits `audit`; viewers are excluded. Project-scoped tokens must include `audit`, are rechecked against current membership, and see only their project.

Project deletion removes application state but not its audit rows, organization attribution, actor identity, or safe metadata. The deleted target is therefore still visible through `GET /api/audit` after `/api/projects/:id/audit` naturally becomes unavailable. Upgrading an older control database adds the organization column in place and backfills it from live project rows or the project's recorded create/delete metadata.

The API is append-only, not a cryptographically signed transparency log. A trusted database administrator can still alter SQLite directly; export audit records to an independently controlled append-only sink when that threat is in scope.

## Rollback

Code-only rollback is the default:

```sh
clank releases
clank rollback <release-id>
```

The target runs against the current database and must pass health before activation. Use expand/contract migrations so earlier code tolerates the newer schema.

Data restore can lose newer writes, so it is constrained:

```sh
clank rollback <previous-release-id> \
  --restore-data \
  --confirm="restore my-project"
```

It is available only for the immediately previous release with a pre-deploy backup.

## Secrets

```sh
printf '%s' "$API_KEY" | clank secrets set API_KEY
clank secrets list
clank secrets delete API_KEY
```

Secret names and timestamps are visible; values are never returned. Values use AES-256-GCM under the platform master key and are decrypted only for runtime injection.

Docker launches pass one name-only `CLANK_RUNTIME_ENV_B64` envelope to the container. The
host-side Docker client receives no application-named variables, so values such as `DOCKER_HOST`,
`LD_PRELOAD`, proxy settings, or TLS settings cannot change which daemon or executable performs
the launch. The in-container Node bootstrap decodes the environment, deletes the envelope, and
then imports application code. No secret value is placed in a process argument. Privileged
host/container administrators can still inspect runtime environment state. Platform-controlled
names such as `PATH`, `HOME`, `HOST`, `PORT`, `NODE_ENV`, and `TRUST_PROXY` are reserved.

Secret changes take effect on the next release or supervised restart.

The local default creates a `0600` master-key file. Production should provide `CLANK_PLATFORM_MASTER_KEY` through separate secret management and back it up independently.

## Runners

Production `clank-platform` defaults to the `isolated` hosting profile. That profile selects Docker
when `CLANK_RUNNER` is unset and refuses to start with the process runner. Development defaults to
the `trusted` profile for a zero-setup local experience.

The process runner is dependency-free and appropriate only when every deployer and application is
trusted by the host operator. It must be selected deliberately in production:

```sh
CLANK_HOSTING_PROFILE=trusted CLANK_RUNNER=process clank-platform
```

The packaged control plane refuses public signup in this profile. Bootstrap and email-bound
invitations remain available for a personal host or explicitly trusted cohort.

The Docker runner adds read-only root, capability dropping, no-new-privileges, non-root execution, PID/memory/CPU limits, a temporary filesystem, and narrow release/data mounts:

```sh
CLANK_HOSTING_PROFILE=isolated \
CLANK_RUNNER=docker \
CLANK_DOCKER_IMAGE=node:22-bookworm-slim \
clank-platform
```

Invalid runner/profile values and an isolated/process mismatch fail before storage or a listener is
opened. Containers improve isolation but are not perfect hostile-code sandboxes. High-risk public
multi-tenancy should use microVMs or dedicated nodes, strict egress policy, image digests, and
secret mounts or an external secret broker.

## API outline

Device/public:

- `POST /api/device/start`
- `POST /api/device/token`
- `POST /__clank/auth/invited-register` — personal- or workspace-scoped invitation account creation without public signup
- `GET /livez` — process liveness
- `GET /healthz`, `GET /readyz`, or `GET /_clank/readyz` — storage-backed control-plane readiness;
  the reserved path is evaluated before application-host ingress for hosted load balancers

Browser session:

- `GET /api/dashboard`
- `GET /api/usage?organizationId=<id>&month=YYYY-MM` — retained workspace usage and effective traffic limits;
- `GET|POST /api/admin/invitations` and `DELETE /api/admin/invitations/:id` — browser-only platform administrator control of personal signup invitations;
- `GET /api/audit?limit=100&before=<event-id>&organizationId=<id>` — role-filtered workspace history that survives project deletion;
- project status, metrics, releases, logs, and domains;
- project and domain creation/removal with CSRF;
- `DELETE /api/projects/:id` with exact confirmation and explicit data-loss acknowledgement;
- `GET /api/device/info`
- `POST /api/device/approve`
- `POST /api/device/deny`
- `/__clank/auth/*`

Bearer:

- account and token listing/revocation;
- workspace usage through an account-wide or matching workspace token; project tokens are denied;
- project creation/listing/status;
- owner/admin-only permanent project deletion using an account-wide token;
- release upload/history/rollback;
- release storage usage and confirmation-gated inactive artifact cleanup;
- logs, encrypted secrets, scheduled/manual backup operations, and audit events.

Managed edge:

- `GET /_clank/tls/ask` — token-protected, constant-time Caddy certificate permission lookup.

See [CLI](cli.md), [Migrations](migrations.md), [Dashboard and domains](platform-dashboard.md), [Platform security](platform-security.md), and [Self-hosting](self-hosting.md).

## Staged secret rotation

The platform supports staged, encrypted secret versions through the existing `secrets` permission:

```sh
clank secrets stage PARTNER_KEY --from-env=NEW_PARTNER_KEY
clank secrets validate <rotation-id>
clank secrets rotations
clank secrets activate <rotation-id>
# Deploy or restart the application to consume the newly active version.
clank secrets rollback <rotation-id>
```

`stage` also reads from stdin when `--from-env` is absent. Candidate and previous values are
stored encrypted with the platform master key; APIs, CLI output, and audit entries contain only
names, opaque revisions, states, and validation metadata. Activation changes the secret used by
the next launch; it does not silently restart an application. Rollback restores the previous
configured secret and likewise requires a deployment/restart to update running processes.

Programmatic hosts can supply `openPlatform({ validateSecret: async ({ projectId, name, value,
signal }) => ... })` to probe a replacement credential against a trusted service. The probe has a
10-second deadline. Without a probe, validation is explicitly labelled `format-and-encryption`;
it does not establish that the remote service accepts the credential. Provider checks are labelled
`provider-check`. Validation expires after 15 minutes, and an interrupted validation can be
reclaimed after 15 seconds. A failed check cannot be activated.

Activation compares the exact secret revision captured at staging. An intervening secret update
blocks stale activation; rollback similarly refuses to overwrite a newer change. A project keeps
at most 1,000 rotation records. Deleting a secret removes its rotation history atomically, and
project deletion cascades through all versions.

`clank secrets rotations` reports the current versions and those consumed by the live local
runtime (web process and background services share launch secrets), or the provider generation
confirmed running by the coordinator. A `current: false` entry identifies an older/unknown
consumed version. No running consumer is reported for stopped apps or an unconfirmed provider
generation. The provider comparison uses its frozen encrypted environment; external services
outside Clank's runtime inventory are not automatically discovered.

The API exposes these routes:

```text
GET/POST /api/projects/:id/secrets/rotations
POST /api/projects/:id/secrets/rotations/:rotationId/{validate|activate|rollback}
```

Stage accepts
`{ name, value }`; lifecycle actions accept `{}`. Existing project authorization, browser CSRF,
and audit behavior apply to every operation.

Use [scheduled release windows](release-windows.md) to review an exact current channel pin for
a bounded future window. Execution rechecks current authority and required services, cancellation
prevents acceptance, and interrupted work retains verified recovery fences. The dashboard exposes
**Schedule current pin** and **Scheduled releases** in the Environments tab.

### Stage an upload without deploying it

`POST /api/projects/:projectId/releases/stage` stores an original deployment artifact for later observation. It does not deploy, extract a runtime, migrate or snapshot the application database, change traffic, schedule jobs, resolve deployment dependencies, or activate a provider generation. This artifact-only foundation does not enable shadow sessions or sampling.

Staging always requires a current human browser session, current project deploy permission, same-origin and CSRF checks, and a fresh passkey or MFA verification using the configured freshness age. This applies even when ordinary platform freshness is optional. CLI bearer tokens, service accounts, impersonation, password-only or SSO-only assurance, and expired verification cannot stage an upload. Native supervisor leadership is required. The first admitted staging request prepares the strict shadow catalog and irreversibly enrolls supervisor protocol three before recording an upload intent; an older coordinator must refuse that catalog. Retirement or disabling future shadow policy does not downgrade it.

Send the ordinary artifact media type, `x-clank-content-sha256`, `x-clank-idempotency-key`, and optional `x-clank-release-attestation` headers. Configured attestation requirements still apply. The endpoint accepts no query parameters. A successful `201` returns a `PlatformStagedReleaseResponse`: `{ok:true,release:{...}}`, with `projectId`, `purpose:'shadow-upload'`, `status:'staged'`, `artifactAvailable:true`, the exact original `artifactBytes`, release ID and digest. `createdAt` is an epoch-millisecond timestamp; `activatedAt` and provider generation remain null. No idempotency key, private artifact path, or runtime URL is returned. Release listings identify the purpose and show uncertain uploads as unavailable.

The same project/key namespace covers deployment and staging. New requests bind the action, project, artifact digest and digest of the exact bounded attestation header, including whether it was absent. A changed input or cross-purpose retry is rejected before deployment dependencies or restart scheduling change. Historical ordinary rows without an upload-request digest retain ordinary same-artifact replay compatibility; they never replay as staging. To deliberately deploy the same bytes, submit an ordinary deployment with a separate key. A staged release ID cannot be rolled back, promoted, pinned to a channel, scheduled in a release window, or supplied to runtime/runner activation.

Intake allows at most two concurrent operations with no waiting queue and refuses a busy project. A separate native catalog limit permits only two durable `uploading` reservations across coordinator restarts, including unknown publications. The original upload is limited to the smallest configured artifact limit, remote-runner limit when configured, and 100 MiB. Each response has a 60-second monotonic total deadline. An unavailable `uploading` row reserves release-count and original-byte quota before publication.

Publication requires either the platform's exclusive local file path or the exact built-in local/S3 ObjectStore. Structural adapters, wrappers, proxies, and S3 stores configured with custom fetch are ineligible. Local publication synchronizes the original file and directory after removing its temporary name. The private S3 path submits one signed conditional PUT with `If-None-Match: *`, without redirects or retries. Its native HTTP transport, clock, reads, and verified deletion are independent of ambient fetch; ordinary ObjectStore behavior is unchanged. Neither path adopts or overwrites an existing target, even when its bytes match.

A native receipt binds the exact request, artifact, location, and unique publication attempt. Its only transitions are `reserved` → `submitted` → `acknowledged`. The submitted receipt commits before the storage operation, and only its original current request can acknowledge a successful operation. A timeout, lost acknowledgment, lease loss, or process exit after submission permanently quarantines that upload: matching bytes, confirmed absence, a later promise resolution, and a new coordinator cannot prove the original submission settled. Exact retries refuse it without another write, and its quota and durable reservation remain occupied. There is no automatic orphan deletion or inferred settlement. A response timeout does not cancel a submitted write; its local intake slot also remains occupied until the promise settles.

An exact retry with fresh authority may continue an unsubmitted reserved attempt or complete final availability from an already acknowledged receipt. Only verified original bytes and current native authority permit staged/available status. Uncertain uploads block release cleanup, project deletion, and preview expiration before runtime shutdown or storage deletion. Explicit cleanup of an available staged artifact checks references, deletes it, verifies absence, and only then releases native storage accounting. Original receipt identity and artifact byte count remain retained; unknown deletion outcomes preserve accounting.

Staging atomically enrolls shadow schema version two without changing its prior enrollment identity. Current coordinators and guardians retain the greatest committed schema version they observe and refuse downgrade or missing publication schema; legacy schema-one binaries refuse version two. Restart validation rejects damaged retained receipts before writer admission. Whole-catalog rollback that removes every newer marker, column, and receipt across process restart remains outside that detection boundary. Lowering admission limits does not prevent validated older artifacts from being inspected or cleaned up.

### Retained shadow lifecycle foundation

`ClankPlatformOptions.shadowTraffic` accepts an explicit revision, exact read paths and GET/HEAD methods, and maximum sample percentage, duration, attempts, concurrency, response bytes, request duration, and retained report count. Configuration requires managed ingress, native supervisor leadership, and provider placement. The admission foundation exposes preview, start and exact stop, with native recovery. Its private observer mirrors eligible requests after the primary response starts; list/report and MCP integration remain separate work.

The private lifecycle shares the existing provider candidate slot and project epoch with ordinary canaries. A native transaction records each intent together with a compact replay receipt and project mirror before a provider effect. Readback verifies exact persisted values, including ignored or altered native writes. Each transition advances the status epoch while retaining the original provider operation and retirement identity. At most sixteen unresolved shadow operations are permitted across the catalog. An unresolved shadow operation blocks ordinary provider writers and referenced artifact cleanup until exact retirement is acknowledged and the native operation is complete.

Startup uses that same lifecycle to retire retained operations even when `shadowTraffic` is disabled. Cleanup reuses the retained provider origin, current credentials for the exact generation, and original binding identity; uncertain cleanup preserves the writer barrier. A delayed prepare cannot supersede the provider's durable retirement. Shutdown or lost authority can prevent cleanup from completing, leaving the obligation for a successor with current native authority. The live owner can interrupt its own held preparation for exact-session stop. A public stop uses the original operation and controller epoch, while the owner performs the native compare-and-swap against its latest status epoch.

Each project retains at most 1,024 compact replay fences without eviction. Completed aggregate bodies are pruned to the configured bound, at most 100, while immutable session, policy, primary, candidate, checkpoint, and recorded timestamp identity remains. The canonical receipt is limited to 16 KiB; identity plus aggregates to 32 KiB. A digest binds identity and aggregates. Pruning verifies exact absence and the retained body count before committing. A pruned body remains unavailable rather than being reconstructed from raw requests; no sampled paths, credentials, headers, or bodies are retained. Process-local elapsed observation time is not persisted as a deadline or restart proof.

Native component tests exercise the shared transaction and lease implementation, and actual child-process tests cover SIGKILL, normal lease takeover, disabled-policy cleanup, writer refusal during uncertainty, and delayed provider preparation. Their provider runtime launcher is a fixture; they do not establish Linux runtime isolation, certificate-backed public mirroring, browser acceptance, or completion of the shadow-traffic feature. Certificate-backed public success is separately gated on an independently generated current host certificate and must be run on the explicit disposable host.

### Shadow review and exact admission

`POST /api/projects/:projectId/shadow/preview` accepts only `{releaseId,expectedEpoch,policy}`. It requires a current human browser session with deploy permission, mandatory fresh passkey/MFA assurance, same origin and CSRF, and actual native supervisor/project ownership. The selected artifact must be an available staged shadow upload or inactive deployment from that project. Preview verifies code-only database compatibility, current genuine Linux host certification, and the exact authenticated provider primary. It creates no candidate, checkpoint, generation or review cache.

Policy fields may be omitted to retain configured bounds; explicit narrowing is never discarded. Mutation bodies are bounded to 8192 UTF-8 bytes. A preview returns a safe review and an opaque signed token valid for 120 seconds. The token's closed canonical payload is bounded to 3072 bytes and its complete wire representation to 4150 ASCII bytes. It binds the authenticated user/session, candidate artifact, full primary identity, policy and current slot epoch without returning provider credentials. Do not log the token.

`POST /api/projects/:projectId/shadow/start` accepts only `{reviewToken,idempotencyKey}`, with an ASCII `[A-Za-z0-9_-]{16,128}` key. New admission verifies current review authority and commits an immutable intent before provider preparation; a `202` is an intent acknowledgment, not cleanup or observation proof. Disconnecting after that acknowledgment does not discard the tracked owner. The tracked owner prepares the isolated candidate before accepting eligible observations; the acknowledgment itself proves neither preparation nor measured traffic.

An exact consumed retry under the original current user and browser session returns its retained identity, including after review expiry, policy changes or HMAC-key rotation. The stored input and review digests must both match; a different user or browser session cannot replay it merely by having deploy permission. A live newer shadow owner permits a coherent read of the historical receipt under its actual native capability, without cancelling either session or contacting the provider. Pruned aggregates return `report:null` and `reportAvailable:false`; immutable identity remains available.

`POST /api/projects/:projectId/shadow/:sessionId/stop` accepts only `{operationId,controllerEpoch}` using the original identity, not a later status epoch. It cannot stop a replacement session. A `202` can still report cleanup required; only a retained complete operation proves acknowledged retirement. Cleanup continues under native authority independently of expired human authorization. Snapshot elapsed time is a floored local monotonic duration while its original owner is live, and is null after restart; cross-host freshness remains unknown.

New shadow sessions commit the existing native shadow schema marker from `clank-platform-shadow/2` to `/3` before recording their intent; supervisor protocol remains `3`. The marker keeps the same tables, enrollment identity and publication receipts. Staging alone remains at schema `/2`. Current readers and guardians retain the greatest committed schema version, while older `/2` readers refuse `/3` even when no session remains. A provisional read from another connection cannot advance that committed floor. Preserve the catalog for recovery if its marker, required tables or publication column is missing; startup does not recreate them. Coherent restoration of every catalog marker and row from an older backup cannot be detected solely from that restored catalog.

Version-two reports have the exact shape `{protocol:2,counters,latency,skips}`. The six fixed `skips` keys are `ineligible`, `sampled-out`, `capacity`, `attempt-limit`, `handoff-timeout` and `withdrawn`; each is a nonnegative integer that saturates at 2,147,483,647. Skips are best-effort totals and never enter sample or latency denominators. The observer coalesces pending skips outside the primary callbacks; process or authority loss may discard increments that were not committed. Completed legacy `{counters,latency}` reports keep their original canonical bytes and digest. Recovery of an unfinished legacy session keeps that format and applies the existing interruption accounting; it never rewrites the report into v2. Aggregate pruning retains the immutable compact receipt (at most 16 KiB), with the full identity and aggregate bounded to 32 KiB. New report bodies and native replay validation must agree on the enrolled schema version.


### Read-only shadow history

`GET /api/projects/:projectId/shadow` returns exactly `{ok,enabled,epoch,policy,sessions,nextBefore}`. It requires current project read permission from a human session, CLI token, or service-account credential; it does not require a fresh mutation assurance. Impersonation and preview-only credentials cannot read it. Disabled policy returns `enabled:false` and `policy:null` while preserving retained safe session identities. Reading status never prepares, stops, recovers, reserves, or activates a candidate. A busy ordinary project operation refuses the read; a live shadow owner can lend only its captured native read assertion, which is checked again before publication.

The list accepts only literal `limit` (default `20`, canonical integer `1..20`) and `before`, each once, in either order. `nextBefore` is an opaque, project-bound HMAC cursor of at most 512 ASCII bytes. Pass it unchanged: encoded names or values, duplicate fields, empty fields, unknown fields, tampering, another project's cursor, and cursors signed before master-key rotation receive `400 SHADOW_CURSOR_INVALID`. Refresh the list after key rotation. Pagination fixes the original controller-epoch ceiling on the first page and returns descending original epochs; new sessions cannot enter that page sequence. Current phase, project epoch, and aggregate availability may still change. A verified cursor above the native retained floor refuses damaged state instead of returning an empty page.

`GET /api/projects/:projectId/shadow/:sessionId` accepts no query and returns the same `{ok,enabled,epoch,session}` envelope as exact admission replay. An unknown session receives `404 SHADOW_SESSION_NOT_FOUND`. Historical status uses the caller's current read authority, while consumed admission replay retains its stricter original human-session binding. Pruned sessions keep immutable identity with `report:null` and `reportAvailable:false`; legacy report bytes remain unchanged. Local elapsed milliseconds are nonnegative integers or `null` after restart, never durable cross-host freshness proof.

Every read validates the bounded native receipt set and its mirror, including rows outside the selected page. At most 1,024 replay identities and 100 retained aggregate bodies are accepted. Each safe serialized session is bounded to 32 KiB and the complete GET response to 1 MiB. Reads do not create or upgrade an unenrolled schema. A stale owner or invalid retained state fails closed; no cleanup work is hidden in a status request. The read-only MCP mount and integrated Console/CLI status are separate pending checkpoints.

### Detached shadow observations

Only the native HTTP adapter can establish the exact anonymous GET/HEAD request proof. An approved exact path with no query, body, credentials or custom headers may be selected against the live owner’s immutable policy. Cloned Requests and changed headers lose eligibility. The primary observer and body callbacks update fixed memory facts only: they do not read SQLite, reserve a sample, fetch, clone/tee a body, or read ahead. The adapter schedules a one-shot handoff after an actual primary write/end; only its detached task can commit the sample reservation and submit a candidate request. This removes a candidate dependency from delivery, but does not promise independent CPU scheduling within the shared process.

Each observation keeps its original monotonic deadline, bounded by the configured request duration and remaining session lifetime. At most sixteen ephemeral or running observations occupy the leader, also bounded by each session’s concurrency; capacity exhaustion never queues traffic. Waiting for handoff and uncertain cancellation still consume that occupancy. The candidate receives a new request containing only the approved method/path, optional bounded Accept, fixed identity/no-store headers and private candidate ingress identity. There is no retry, redirect, primary fallback, or forwarding of user credentials. Candidate bytes are discarded within the configured limit; primary bytes continue unchanged, even when observation is detached.

Native supervisor/project ownership, the initiating principal, immutable policy and exact primary/candidate state are checked around detached awaits and reservation/settlement transactions. Concurrent samples adopt the latest committed owner record. A report comparison requires both bounded EOFs and valid metadata; equal status classes or media types are transport observations, not semantic correctness. Missing, unread, oversized or cancelled bodies remain incomplete. A native lease loss leaves outstanding ordinals for successor interruption instead of allowing stale settlement. Stop disables intake before cancellation and exact retirement; an uncertain task or absence keeps the durable writer barrier. Restart does not replay sample requests.

Native component tests cover actual first-byte delivery while a separate SQLite writer holds reservation contention, parallel accounting, bounded capacity, deadline/authority loss and ignored or altered writes. Actual process tests cover SIGKILL/SIGSTOP with a committed sample reservation and disabled-policy recovery. Their runtime launcher remains a fixture. The certificate-gated public observer tests require separate disposable-host execution; no Docker runtime isolation, browser acceptance or completed Feature09 claim follows from local component tests.
