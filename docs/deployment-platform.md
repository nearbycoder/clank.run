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
- `PORT`, `HOST`, `NODE_OPTIONS`, and `CLANK_*` variables are reserved.
- `database.path` is persistent project data outside release directories.
- Changing `database.path` during deployment is rejected to prevent silently forking production data.
- `jobs.entry` is one compiled provider-neutral worker/scheduler module inside an included path.
- `jobs.workers` controls independent processes; `jobs.concurrency` controls handlers per worker.
- `jobs.queues` is an optional allowlist and `jobs.scheduler` enables one independently leased
  cron scheduler.
- Provider placement reserves one runner process slot for the web process, one for each worker,
  and one for the scheduler. A release waits without partial activation when no matching node has
  the complete slot demand.

## Artifact protocol

The wire media type is `application/vnd.clank.deploy+gzip`. Its document protocol is `clank-deploy/1` and contains:

- normalized configuration;
- builder protocol, Clank version, and Node version;
- a sorted file list with path, size, mode, SHA-256 digest, and base64 content.

The gzip timestamp is fixed, so identical inputs on the same Clank and Node versions produce identical bytes. The CLI also sends an artifact digest and idempotency key.

```sh
clank deploy --dry-run
clank inspect .clank/artifacts/<digest>.clank.gz
```

Dry-run artifact creation is offline and does not require platform credentials. Ambiguous upload failures retain a private local attempt record for 24 hours, allowing the next identical command to reuse its idempotency key instead of accidentally creating a second release after a lost response.

The metadata supports the traceability goals of [SLSA provenance](https://slsa.dev/spec/v1.2/provenance), but `clank-deploy/1` is not a signed SLSA attestation. Signing and transparency-log integration are future extensions.

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
No production database rows or secret values are copied.

Previews consume normal account/workspace project capacity, cannot contain nested previews, and
are grouped under their parent in the control-plane UI. Startup cleanup runs before release
recovery, so an expired runtime is deleted rather than restarted. The background cleaner uses the
same durable lock and path-safe complete deletion path as a manual removal. See
[Preview environments](preview-environments.md) for the CLI, API, CI, and retention contracts.

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
