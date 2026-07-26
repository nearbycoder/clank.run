# Deployment CLI

The `clank` executable contains both the compiler and deployment client. It does not install application dependencies or execute remote build hooks.

## Create

```sh
clank create my-app
clank create my-app --name="Customer workspace"
cd my-app
npm install
npm run dev
```

The generated app includes auth, an owned Todo table, SSR, hydration, live updates, Tailwind, a health route, deployment configuration, its first migration, a human `README.md`, and an agent-oriented `AGENTS.md`. Its only dependency is the official `clank.run` package, which has no transitive dependencies. The exact CLI runtime is still embedded into deployment artifacts, so the platform never runs an install hook.

Until a Clank version is published, or while changing the framework and an app together, point the scaffold at the current checkout:

```sh
node /path/to/clank/scripts/clank.mjs create my-app --framework=local
cd my-app
npm install
```

`--framework` also accepts an explicit npm dependency spec, tarball, or `file:` path. Blueprint `plan` and `generate` accept the same option so their checksum includes the actual dependency choice.

## Help and readiness

```sh
clank help
clank deploy --help
clank help --json
clank doctor
clank doctor --json
```

Every command supports focused `--help` without authenticating or executing the command. Unknown commands and long options fail non-zero and suggest a close known spelling instead of being ignored.

`doctor` validates the Node version, deployment configuration, compiled entry state, migration names and checksums, package scripts, CLI login, and local project link. Missing login or a first-deploy link is a warning, not a local-build failure. Its `clank-doctor/1` JSON report and the `clank-cli-help/1` command manifest are stable agent surfaces.

## Authenticate

```sh
clank login --server=https://deploy.example.com
clank whoami
clank logout
```

Passwords never pass through the CLI. Profiles are stored under `${CLANK_HOME:-~/.clank}/config.json`. Set `CLANK_HOME` to isolate CI or test credentials.

Existing Proact profiles and project links are imported automatically on first use. See [Renaming from Proact](renaming-from-proact.md).

Credential profiles and project links are size-bounded, structurally validated, canonicalized to one server URL, written with owner-only permissions, and replaced atomically. Invalid local state fails closed without echoing token contents. Ordinary platform requests time out after 30 seconds; deployment uploads and health-gated activation time out after five minutes. JSON responses are UTF-8 validated and capped at 4 MiB before parsing.

## Projects

```sh
clank project create my-app
clank project create "Customer workspace" --slug=customer-workspace
clank project list
clank project link <project-id>
clank project delete [project-id] \
  --confirm="delete-site <project-slug>" \
  --acknowledge-data-loss
```

Links are written to `.clank/project.json` and should normally remain uncommitted.

Deletion is permanent and requires an account-wide token plus an owner/admin organization role. Project-scoped tokens are rejected even if they have `tokens` permission. A successful deletion removes the matching local project link, but leaves other directories and off-platform copies untouched. See [Site deletion](deployment-platform.md#site-deletion).

## Workspaces and access

```sh
clank org list
clank org create "Acme Engineering" --slug=acme
clank org members <organization-id>
clank org invite <organization-id> person@example.com --role=developer
clank org invitations <organization-id>
clank org revoke-invite <organization-id> <invitation-id>
clank org accept <single-use-token>
clank org role <organization-id> <user-id> <owner|admin|developer|viewer>
clank org remove <organization-id> <user-id>
```

Invitation creation prints its email-bound token once. Reissuing for the same email invalidates older tokens. Invitation lists contain identifiers and safe metadata, never tokens or hashes. Only owners and administrators can create/revoke invitations or change/remove members; only an owner can grant or change the owner role, and the last owner is protected.

## Workspace activity

```sh
clank activity
clank activity --org=<organization-id> --limit=100
clank activity --before=<cursor>
clank activity --json
```

`clank audit` is an alias. The feed is newest first and includes the event ID, action, target, actor, timestamp, and safe audit metadata. `--json` prints the complete stable response for agents and automation. Owners, administrators, and developers can read events for their current organizations; viewers cannot. A project-scoped token needs `audit` permission and receives only that project's events.

## Deploy and inspect

```sh
clank deploy
clank deploy ../another-app
clank deploy --dry-run
clank deploy --output=/secure/path/release.clank.gz
clank deploy --name="Customer workspace" --slug=customer-workspace --org=<organization-id>
clank deploy --json
clank inspect /secure/path/release.clank.gz
```

Deployment validates config, runs the local build without a shell, packages included files plus the exact Clank runtime, verifies the artifact locally, creates and links a project if needed, uploads with a digest/idempotency key, and waits for migration and health. `--name`, `--slug`, and `--org` configure that automatic first project creation, so login plus one deploy command is sufficient.

`--dry-run` is deliberately offline: it builds and writes a verified artifact without reading a login, creating a project, or contacting a platform. `--json` suppresses human progress output and emits one `clank-deploy-result/1` document with artifact, release, URL, and timing data.

Before upload the CLI stores a non-secret attempt record in `.clank/deploy-attempt.json`. If the connection fails after the platform may have accepted the artifact, the next identical deploy within 24 hours reuses the same idempotency key and converges on the original release. A definitive platform response clears the record.

## Status and rollback

```sh
clank status
clank releases
clank releases delete <inactive-release-id> \
  --confirm="delete-release <project-slug> <inactive-release-id>"
clank logs --limit=500
clank rollback <release-id>
clank rollback <release-id> --restore-data --confirm="restore <slug>"
```

`clank releases` reports the retained artifact count and uncompressed runtime/snapshot bytes. Cleanup requires the token's `rollback` permission, never removes the active artifact, and preserves release metadata, logs, and audit evidence. Removing the active release's immediate predecessor also destroys code rollback and its matching data snapshot, so it additionally requires `--allow-rollback-loss`.

Logs are bounded. Every non-empty known secret value is redacted, including short values, with longer overlapping values replaced first. Apps must still avoid logging credentials because transformed, encoded, split, or externally emitted values cannot be recognized reliably.

## Secrets

```sh
printf '%s' "$API_KEY" | clank secrets set API_KEY
clank secrets set API_KEY --from-env=API_KEY
clank secrets list
clank secrets delete API_KEY
```

There is deliberately no `secrets get`.

## Local migrations

```sh
clank migrate plan
clank migrate apply
```

Production migrations always run inside the deployment transaction.

## Automation

Use `clank token create` to issue a short-lived project token containing only the CI job's required permissions, and isolate it with a dedicated `CLANK_HOME`. Membership and token scope are re-evaluated on every request; removing the member or revoking the token stops future access.

Successful commands exit `0`; input, auth, build, upload, migration, or health failures exit non-zero. Commands that document `--json` emit structured failures to standard error with a stable code and message. Failed server revocation prevents `logout` from silently deleting the only local token reference. `--local` is for platform recovery.
