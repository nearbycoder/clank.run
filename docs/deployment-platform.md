# Deployment platform

Clank Deploy is the open-source control plane for turning a Clank source directory into a running release. It uses Fetch, Node, SQLite, Web Crypto, and no runtime NPM dependencies.

The platform is intentionally inspectable:

- deployment configuration is checked-in JSON;
- builds run locally as an argument array, never as a server-side shell hook;
- every artifact and file has a SHA-256 digest;
- artifacts contain the exact Clank runtime used by the CLI;
- SQL migrations have ordered, immutable checksums;
- releases, failures, rollbacks, tokens, secret-name changes, and projects are audited;
- secret values are encrypted and never returned by the API;
- failed migrations or health checks restore the prior database and process.

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
clank deploy
```

The first deploy creates and links a project automatically. Remote platform URLs must use HTTPS; loopback HTTP is accepted only for development.

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

Containers improve isolation but are not perfect hostile-code sandboxes. High-risk public multi-tenancy should use microVMs or dedicated nodes, strict egress policy, image digests, and external secret injection.

## API outline

Device/public:

- `POST /api/device/start`
- `POST /api/device/token`
- `GET /healthz`

Browser session:

- `GET /api/device/info`
- `POST /api/device/approve`
- `POST /api/device/deny`
- `/__clank/auth/*`

Bearer:

- account and token listing/revocation;
- project creation/listing/status;
- release upload/history/rollback;
- logs, encrypted secrets, and audit events.

See [CLI](cli.md), [Migrations](migrations.md), [Platform security](platform-security.md), and [Self-hosting](self-hosting.md).
