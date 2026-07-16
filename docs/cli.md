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

The generated app includes auth, an owned Todo table, SSR, hydration, live updates, Tailwind, a health route, deployment configuration, and its first migration. Its only dependency is the official `clank.run` package, which has no transitive dependencies. The exact CLI runtime is still embedded into deployment artifacts, so the platform never runs an install hook.

## Authenticate

```sh
clank login --server=https://deploy.example.com
clank whoami
clank logout
```

Passwords never pass through the CLI. Profiles are stored under `${CLANK_HOME:-~/.clank}/config.json`. Set `CLANK_HOME` to isolate CI or test credentials.

Existing Proact profiles and project links are imported automatically on first use. See [Renaming from Proact](renaming-from-proact.md).

## Projects

```sh
clank project create my-app
clank project create "Customer workspace" --slug=customer-workspace
clank project list
clank project link <project-id>
```

Links are written to `.clank/project.json` and should normally remain uncommitted.

## Deploy and inspect

```sh
clank deploy
clank deploy ../another-app
clank deploy --dry-run
clank deploy --output=/secure/path/release.clank.gz
clank inspect /secure/path/release.clank.gz
```

Deployment validates config, runs the local build without a shell, packages included files plus the exact Clank runtime, verifies the artifact locally, creates a project if needed, uploads with a digest/idempotency key, and waits for migration and health.

## Status and rollback

```sh
clank status
clank releases
clank logs --limit=500
clank rollback <release-id>
clank rollback <release-id> --restore-data --confirm="restore <slug>"
```

Logs are bounded. Known secret values of at least four characters are redacted, but apps must still avoid logging credentials.

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

Successful commands exit `0`; input, auth, build, upload, migration, or health failures exit non-zero. Failed server revocation prevents `logout` from silently deleting the only local token reference. `--local` is for platform recovery.
