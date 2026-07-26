# Deployment platform

Clank Deploy is the open-source control plane for turning a Clank source directory into a running release. It uses Fetch, Node, SQLite, Web Crypto, and no runtime NPM dependencies.

The platform is intentionally inspectable:

- deployment configuration is checked-in JSON;
- builds run locally as an argument array, never as a server-side shell hook;
- every artifact and file has a SHA-256 digest;
- artifacts contain the exact Clank runtime used by the CLI;
- SQL migrations have ordered, immutable checksums;
- releases, failures, rollbacks, backups, tokens, secret-name changes, and projects are audited;
- secret values are encrypted and never returned by the API;
- failed migrations or health checks restore the prior database and process.

The browser console is also an operating surface, not only a login page. It shows site health, 1-hour through 30-day ingress performance, enforced capacity, releases, scheduled encrypted backups, logs, and the full custom-domain lifecycle. See [Deployment dashboard, quotas, and domains](platform-dashboard.md).

## Five-minute path

```sh
CLANK_PLATFORM_DATA=.clank-platform \
CLANK_PLATFORM_URL=http://127.0.0.1:4200 \
npm run dev:platform
```

Create the bootstrap account at `http://127.0.0.1:4200`, then:

```sh
clank login --server http://127.0.0.1:4200
clank create my-todo
cd my-todo
npm install
clank doctor
clank deploy
```

The first deploy creates and links a project automatically. Pass `--name`, `--slug`, or `--org` on that command when the directory name is not the intended platform identity. Remote platform URLs must use HTTPS; loopback HTTP is accepted only for development.

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
5. Stop the active process to quiesce SQLite writes.
6. Create a consistent SQLite backup.
7. Verify migration history and apply pending SQL in one `BEGIN IMMEDIATE`.
8. Start the candidate with persistent data and decrypted runtime secrets.
9. Poll the configured health route.
10. Mark it active only after health succeeds.

If backup, migration, startup, or health fails, Clank stops the candidate, restores the snapshot, restarts the prior release, marks the candidate failed, and records an audit event.

This creates a short SQLite write outage. Continuously writable multi-instance systems need an external database and another deployment driver.

Before creating a release directory, Clank checks the site's retained-artifact count and the uncompressed bundle plus current SQLite/WAL footprint under the durable project lock. After taking a pre-deploy snapshot, it records the exact snapshot size. This bounds cumulative deployment storage rather than only bounding each upload.

```sh
clank releases
clank releases delete <inactive-release-id> \
  --confirm="delete-release <project-slug> <inactive-release-id>"
```

Cleanup requires `rollback` permission. The active artifact is never removable. Add `--allow-rollback-loss` only when intentionally removing the active release's immediate predecessor; that removes the predecessor's runtime files and the active release's matching data-restore snapshot. Cleanup preserves release metadata and audit history.

## Site deletion

Owners and organization administrators can permanently reclaim a site slot from the dashboard or CLI:

```sh
clank project delete [project-id] \
  --confirm="delete-site <project-slug>" \
  --acknowledge-data-loss
```

Deletion requires an account-wide browser session or CLI token. A project-scoped token is deliberately insufficient, including one with `tokens` permission. Browser deletion also passes the normal same-origin and CSRF checks. The exact slug-bound phrase and separate acknowledgement make accidental generic confirmation impossible.

The operation holds the same durable project lock used by deploy, rollback, release cleanup, and backup work. It rechecks current membership under that lock, stops the supervised application, validates that the platform project path and its parents are real directories rather than symbolic links, and removes the complete project root. Only then does one control-database transaction revoke active project tokens, remove orchestration placement/operation state, delete project metadata and its cascading domain/release/secret/log/metric/backup-schedule rows, and append a surviving `project.delete` audit event.

If filesystem validation or removal fails, project metadata remains and Clank attempts to restart the prior active release. If the later metadata transaction fails after files were removed, the API reports a fixed recovery-safe error and a retry completes cleanup. A successful response means the platform-managed local application database, releases, rollback snapshots, encrypted recovery points, secrets, logs, metrics, domains, and scoped tokens are gone. External databases, copied artifacts, Caddy certificate storage, replicated/off-host backups, and other operator-managed copies are not discovered or erased.

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

Docker launches use name-only environment arguments (`-e NAME`); values are inherited by the Docker client rather than placed in process arguments. Privileged host/container administrators can still inspect runtime environment state. Platform-controlled names such as `PATH`, `HOME`, `HOST`, `PORT`, `NODE_ENV`, and `TRUST_PROXY` are reserved.

Secret changes take effect on the next release or supervised restart.

The local default creates a `0600` master-key file. Production should provide `CLANK_PLATFORM_MASTER_KEY` through separate secret management and back it up independently.

## Runners

The process runner is dependency-free and appropriate only when every app is trusted by the host operator.

The Docker runner adds read-only root, capability dropping, no-new-privileges, non-root execution, PID/memory/CPU limits, a temporary filesystem, and narrow release/data mounts:

```sh
CLANK_RUNNER=docker \
CLANK_DOCKER_IMAGE=node:22-bookworm-slim \
clank-platform
```

Containers improve isolation but are not perfect hostile-code sandboxes. High-risk public multi-tenancy should use microVMs or dedicated nodes, strict egress policy, image digests, and secret mounts or an external secret broker.

## API outline

Device/public:

- `POST /api/device/start`
- `POST /api/device/token`
- `POST /__clank/auth/invited-register` — invitation-bound account creation without public signup
- `GET /livez` — process liveness
- `GET /healthz`, `GET /readyz`, or `GET /_clank/readyz` — storage-backed control-plane readiness;
  the reserved path is evaluated before application-host ingress for hosted load balancers

Browser session:

- `GET /api/dashboard`
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
- project creation/listing/status;
- owner/admin-only permanent project deletion using an account-wide token;
- release upload/history/rollback;
- release storage usage and confirmation-gated inactive artifact cleanup;
- logs, encrypted secrets, scheduled/manual backup operations, and audit events.

Managed edge:

- `GET /_clank/tls/ask` — token-protected, constant-time Caddy certificate permission lookup.

See [CLI](cli.md), [Migrations](migrations.md), [Dashboard and domains](platform-dashboard.md), [Platform security](platform-security.md), and [Self-hosting](self-hosting.md).
