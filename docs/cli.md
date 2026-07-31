# Deployment CLI

The `clank` executable contains both the compiler and deployment client. It does not install application dependencies or execute remote build hooks.

The package also exposes three operator processes: `clank-platform` starts the control plane,
`clank-runner` connects an authenticated remote deployment node, and `clank-provider` runs the
reference stateful Docker provider plus private runtime ingress. Their `--help` output lists
environment-only configuration; the complete trust and idempotency contract is in [Deployment
provider adapters](provider-adapters.md).

## Interactive launcher

Run the command without arguments in a terminal:

```sh
clank
```

Clank opens a dependency-free guided launcher for building with an agent, creating from a starter,
checking the current project, logging in, deploying, viewing account plans and limits, or viewing
every command. Agent building collects the product request and a blueprint or configured agent
executable; starter creation presents the built-in templates and asks for the target directory.

The templates are:

| Template | Direct command | Includes |
| --- | --- | --- |
| Authenticated Todo | `clank create my-app --template=auth-todo` | Auth, private SQLite data, durable jobs, SSR, hydration, Tailwind, migrations, and live sync |
| Minimal full-stack | `clank create my-app --template=minimal` | SSR, hydration, reactive TypeScript, Tailwind, health checks, and deployment |

`auth-todo` remains the default when `--template` is omitted. In a non-interactive terminal, bare `clank` prints the complete help instead of waiting for input. Agents and scripts should continue to use explicit commands and `--json` surfaces.

`clank templates --json` returns the stable `clank-template-catalog/1` contract with the installed
framework version, default template, capability identifiers, and recommendation state. The human
form prints the same catalog and copyable create commands.

## Browser journeys

```sh
clank journey journeys/smoke.json
clank journey journeys/acceptance.json --headed
clank journey journeys/acceptance.json --output=.clank/journey.json --json
```

`journey` replays bounded, selector-free acceptance flows against a real Chrome browser in a fresh
profile. Generated blueprint apps include a mobile smoke journey and `npm run test:journey`.
Environment-backed secret inputs support login without recording passwords. See [Semantic browser
journeys](browser-journeys.md) for operations, security boundaries, and CI output.

## Compose with an agent

```sh
clank compose my-app \
  --request="Build a private customer project tracker" \
  --proposal=./proposals/customer-tracker.clank.app.ts \
  --json
```

`compose` validates an agent-proposed data-only blueprint and freezes its exact generated-file
plan before it changes application files. The JSON result contains a review ID, SHA-256 plan
digest, file-by-file changes, and a copyable apply command. Apply requires the exact digest and
fails if any reviewed destination changed in the meantime.

For a persistent provider adapter, pass `--agent=./path/to/executable`. Clank communicates through
the bounded `clank-compose-request/1` and `clank-compose-proposal/1` stdin/stdout protocol without
a shell or ambient application secrets. Interactive runs can send revision feedback before
approval. See [Conversational application building](conversational-build.md) for the complete
protocol, security boundary, review storage, and existing-app workflow.

## Create

```sh
clank create my-app
clank create my-site --template=minimal
clank create my-app --name="Customer workspace"
clank create my-app --json
cd my-app
npm install
npm run dev
```

The generated app includes auth, an owned Todo table, a transactional background job, SSR,
hydration, live updates, Tailwind, a health route, deployment configuration, its first migration, a
human `README.md`, and an agent-oriented `AGENTS.md`. Its only runtime dependency is the official
`@clank.run/framework` package, which has no transitive dependencies. Tailwind and its CLI are
local build-only development dependencies; compiled CSS is included in the artifact. The exact
Clank runtime is still embedded into deployment artifacts, so the platform never runs an install
hook.

The JSON form returns `clank-create-result/1`: normalized project identity, selected template
metadata, exact framework dependency, every generated path with byte count and SHA-256, and the
install/dev/doctor/login/deploy commands. It writes no human prose around the JSON. Project titles
are limited to 100 visible characters and encoded for their TypeScript, TSX, and Markdown contexts,
so names containing quotes, braces, ampersands, or markup cannot alter generated source.

Until a Clank version is published, or while changing the framework and an app together, point the scaffold at the current checkout:

```sh
node /path/to/clank/scripts/clank.mjs create my-app --framework=local
cd my-app
npm install
```

`--framework` also accepts an explicit npm dependency spec, tarball, or `file:` path. Blueprint `plan` and `generate` accept the same option so their checksum includes the actual dependency choice.

## Integrated development loop

Generated applications use one local command:

```sh
npm run dev
# equivalent to:
clank dev
```

`clank dev` reads `clank.deploy.json`, executes its shell-free `build.command`, launches the
compiled `entry`, and checks the declared health route. It watches the project while excluding
generated output, dependency directories, local Clank state, and live SQLite files. After a
relevant change it:

1. reruns the complete build, including Tailwind;
2. starts the replacement on a private loopback port;
3. waits for the declared health check to return `2xx`;
4. atomically switches the local development proxy to the healthy process;
5. reloads connected browser tabs; and
6. gracefully stops the prior process.

A compiler error or failed replacement does not take down the last good process. Rapid changes are
debounced and serialized, and repeated application crashes are bounded instead of creating an
unlimited restart loop. The proxy reserves only two local development paths:
`/_clank/dev-client.js` and `/_clank/dev-events`. It adds the reload client only to bounded,
uncompressed UTF-8 HTML responses, reuses an existing CSP nonce when present, and leaves API,
streaming, cookie, and non-HTML response bodies untouched. Proxy responses use `no-store` so an
immutable production asset policy cannot keep stale JavaScript during local development.

Useful options are explicit:

```sh
clank dev ./my-app --port=4100
clank dev --host=0.0.0.0 --port=3000
clank dev --no-reload
clank dev --json
```

The default is `http://127.0.0.1:3000`; `PORT` and `HOST` are also honored for the public
development listener. Binding a non-loopback host makes the app reachable from the local network,
so do it only on a trusted network. `--no-reload` keeps rebuild/restart supervision without
injecting a browser client. `--json` writes newline-delimited `clank-dev-event/1` lifecycle events
to stdout while build and application logs remain on stderr, giving agents a stable ready,
restarted, failure, and shutdown signal.

`clank watch` remains available as a compiler-only primitive when another process manager owns the
server. For normal application work, prefer `clank dev`.

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

When `jobs` is configured, doctor also validates the compiled background entry and reports the
configured worker/scheduler topology.

## Local workers and cron

```sh
clank jobs worker
clank jobs worker --concurrency=4 --queues=email,reports
clank jobs scheduler
```

These commands read `clank.deploy.json`, run the configured build without a shell, and launch its
compiled `jobs.entry` with the same environment contract used by cloud processes. The worker and
scheduler stay outside the web process; run them in separate terminals during development. Hosted
deployments start the configured topology automatically.

See [Durable jobs and cron](jobs-and-cron.md) for definition, enqueue, delivery, and deployment
semantics.

## Hosted job operations

From a linked deployed project:

```sh
clank jobs status
clank jobs status --json
clank jobs list
clank jobs list --state=dead --queue=email --limit=25
clank jobs cancel <job-id>
clank jobs retry <job-id>
```

These subcommands use the authenticated control plane; they do not start a worker. `list` returns
at most 100 safe records. It intentionally omits arguments, results, error text, owner/group
identity, worker identity, and lease credentials. Status reports dead letters, overdue work,
expired leases, and schedule-error presence. Cancel and retry require the dedicated `jobs`
permission, and the server enforces the current state transition atomically. See
[Operate a deployed queue](jobs-and-cron.md#operate-a-deployed-queue).

## Authenticate

```sh
clank login
clank whoami
clank logout
```

`clank login` securely defaults to `https://clank.run`. The CLI prints the exact verification URL and a short code, then waits for browser approval. Use `clank login --server=https://deploy.example.com` only for an explicitly self-hosted control plane.

Passwords never pass through the CLI. Profiles are stored under `${CLANK_HOME:-~/.clank}/config.json`. Set `CLANK_HOME` to isolate CI or test credentials.

Existing Proact profiles and project links are imported automatically on first use. See [Renaming from Proact](renaming-from-proact.md).

Credential profiles and project links are size-bounded, structurally validated, canonicalized to one server URL, written with owner-only permissions, and replaced atomically. Invalid local state fails closed without echoing token contents. Ordinary platform requests time out after 30 seconds; deployment uploads and health-gated activation time out after five minutes. JSON responses are UTF-8 validated and capped at 4 MiB before parsing.

The Clank CLI is only for creating and deploying projects. People connecting an MCP client to a
deployed application do not install or authenticate this CLI. They give their MCP client the
application's `https://<app>/__clank/mcp` URL and complete that client's normal browser OAuth
flow. See [Agent protocol](agent-protocol.md#connect-from-codex).

## Projects

```sh
clank project create my-app
clank project create "Customer workspace" --slug=customer-workspace
clank project create remote-app --placement=provider
clank project list
clank project link <project-id>
clank project delete [project-id] \
  --confirm="delete-site <project-slug>" \
  --acknowledge-data-loss
```

Links are written to `.clank/project.json` and should normally remain uncommitted.

`--placement` accepts `local` or `provider` and is used only when the project is created. Provider
selection must be enabled by the self-hosted platform operator; Clank returns
`PROVIDER_PLACEMENT_DISABLED` otherwise. Placement is immutable because a silent change would
create or abandon a different SQLite database. `clank project list` includes each project's
placement.

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

Invitation creation prints its email-bound token once. When the platform has email delivery
configured, it also queues the same invitation through the durable encrypted outbox; the printed
token remains a fallback for unattended CLI use. Reissuing for the same email invalidates older
tokens. Invitation lists contain identifiers and safe metadata, never tokens, hashes, ciphertext,
or provider errors. Only owners and administrators can create/revoke invitations or change/remove
members; only an owner can grant or change the owner role, and the last owner is protected. See
[Invitations and email delivery](invitations.md).

## Workspace activity

```sh
clank activity
clank activity --org=<organization-id> --limit=100
clank activity --before=<cursor>
clank activity --json
```

`clank audit` is an alias. The feed is newest first and includes the event ID, action, target, actor, timestamp, and safe audit metadata. `--json` prints the complete stable response for agents and automation. Owners, administrators, and developers can read events for their current organizations; viewers cannot. A project-scoped token needs `audit` permission and receives only that project's events.

## Workspace usage

```sh
clank usage
clank usage --month=2026-07
clank usage --org=<organization-id>
clank usage --org=<organization-id> --month=2026-07 --json
```

The command reports monthly admitted requests, known transfer, rejected requests, the per-project
rate ceiling, current resources, and a production/preview project breakdown. In a linked directory
it selects that project's workspace. Outside one, it selects the only accessible workspace or
requires `--org` when the choice is ambiguous.

Months are UTC and constrained to the platform's retention window. Human output calls out partial
pre-upgrade history and the declared-response-byte boundary. `--json` returns the stable
`clank-usage/1` API document without calculating prices or invoices. See
[Usage accounting and traffic limits](usage-and-limits.md).

## Account plan and entitlements

```sh
clank billing
clank billing --json
```

When the selected platform has hosted plans enabled, this read-only command shows the account's
effective plan, billing state, current period or payment-grace deadline, and capacity after
operator overrides. It also prints the platform's `/billing` URL for interactive checkout or
subscription management. `--json` emits the unmodified `clank-billing/1` document.

The CLI cannot create checkout or portal sessions: those operations require a same-origin browser
session and CSRF token. See [Hosted plans and billing](hosted-plans-and-billing.md).

## Deploy and inspect

```sh
clank deploy
clank deploy ../another-app
clank deploy --dry-run
clank deploy --output=/secure/path/release.clank.gz
clank deploy --name="Customer workspace" --slug=customer-workspace --org=<organization-id>
clank deploy --name=remote-app --placement=provider
clank deploy --json
clank inspect /secure/path/release.clank.gz
```

Deployment validates config, runs the local build without a shell, packages included files plus the exact Clank runtime, verifies the artifact locally, creates and links a project if needed, uploads with a digest/idempotency key, and waits for migration and health. `--name`, `--slug`, `--org`, and `--placement` configure only that automatic first project creation, so login plus one deploy command is sufficient.

`--dry-run` is deliberately offline: it builds and writes a verified artifact without reading a login, creating a project, or contacting a platform. `--json` suppresses human progress output and emits one `clank-deploy-result/1` document with artifact, release, URL, and timing data.

Before upload the CLI stores a non-secret attempt record in `.clank/deploy-attempt.json`. If the
connection fails after the platform may have accepted the artifact, or a provider returns
`PROVIDER_DEPLOYMENT_PENDING`, the next identical deploy within 24 hours reuses the same
idempotency key and converges on the original release. A successful activation or definitive
validation/provider rejection clears the record; ambiguous and retryable responses preserve it.
A changed artifact digest creates a separate attempt.

## Preview environments

```sh
clank preview deploy feature-auth
clank preview deploy pull-482 --ttl=48 --json
clank preview deploy feature-search --data=sanitized
clank preview list
clank preview remove feature-auth \
  --confirm="delete-preview feature-auth" \
  --acknowledge-data-loss
clank preview github configure owner/repository
clank preview github status
```

Preview deploys use the production link without replacing it. Each normalized name has a separate,
expiring URL, SQLite database, releases, secrets, jobs, logs, and MCP endpoint. Repeating a name
refreshes its TTL and deploys a new release. Raw production data and secrets are never copied, and
the preview consumes an ordinary account/workspace project slot. See
[Preview environments](preview-environments.md).

Data starts empty. `--data=sanitized` opts into the bounded policy frozen in the active production
release, branches after the preview deploy, reapplies target migrations, and reports only aggregate
sanitization counts. Pull-request code cannot replace that policy, raw copies are unavailable, and
production secrets are never inherited.

`preview github configure` binds the linked project to the repository's immutable GitHub ID and
writes deploy plus cleanup workflows. Public repository IDs are resolved automatically; private
repositories pass `--repository-id=<id> --cleanup-ref=refs/heads/<trusted-branch>`. The workflows
are limited to that default/trusted base branch and exchange GitHub Actions OIDC for a
one-time, 15-minute, `pull-N`-restricted identity, so there is no Clank deployment secret to add
to GitHub. Configuration requires an isolated/provider runtime and owner/admin access.

The `--github`, `--project`, and `--server` flags emitted into those workflows are CI transport
inputs, not a replacement for interactive login. Outside GitHub Actions, `--github` fails before
contacting the platform. The returned credential is kept in memory, is never saved to
`CLANK_HOME`, and cannot deploy the production project.

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
For provider-hosted projects, the same command merges durable platform lifecycle events with the
current generation's bounded provider-process memory tail. Role-prefixed streams such as
`worker[1]:stderr` identify the topology without exposing container identity.

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
