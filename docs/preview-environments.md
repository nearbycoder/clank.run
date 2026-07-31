# Preview environments

Clank previews are temporary deployments attached to a production project. Each preview is a real
isolated project with its own URL, SQLite database, migration history, releases, secrets, jobs,
logs, metrics, backups, and project-scoped tokens.

The important default is absence: creating a preview does **not** copy production data or secrets.
An application may populate synthetic data explicitly or opt into a production-reviewed
sanitization policy. Raw production copies are not an available mode. This prevents a routine
branch deploy from turning into an unreviewed production-data export.

## Deploy a preview

Link the directory to its production project once, then name the preview:

```sh
clank preview deploy feature-auth
clank preview deploy pull-482 --ttl=48
clank preview deploy feature-search --data=sanitized
clank preview list
```

`--ttl` is an integer number of hours. The hosted defaults are seven days with a maximum of 30
days. Deploying the same normalized name again reuses its isolated environment, publishes a new
atomic release, and refreshes its expiration. It never changes `.clank/project.json`, so the
directory remains linked to production.

For agents and CI:

```sh
clank preview deploy pull-482 --ttl=24 --json
```

The `clank-preview-result/1` document includes the preview ID, normalized name, parent project,
expiration, release digest, URL, data mode and sanitization counts, identity method, and
build/upload timing.

## Sanitized data branches

`--data=sanitized` branches a consistent production SQLite snapshot only after deploying the
preview release. The platform takes the policy from the **active production release**, never from
the pull request or preview artifact. A GitHub OIDC identity can therefore request the approved
branch but cannot broaden the table or column contract.

Declare the policy in production's `clank.deploy.json`, review it, and deploy it before using the
option:

```json
{
  "version": 1,
  "database": {
    "path": "app.sqlite",
    "migrations": "migrations",
    "allowUnsafeMigrations": false,
    "previewData": {
      "tables": {
        "customers": {
          "rows": 500,
          "columns": {
            "id": "keep",
            "email": "email",
            "display_name": "hash",
            "settings": {
              "json": {
                "default": "hash",
                "paths": {
                  "/theme": "keep",
                  "/notifications/enabled": "keep"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Only named tables retain rows; all other application tables are emptied. Framework auth, OAuth,
session, recovery-token, passkey, challenge, live-change, and job tables are always purged and
cannot be retained by policy. Migration and database-revision metadata remain so the preview
release can apply its pending migrations correctly.

Each table keeps at most 1,000 rows by default and at most 10,000 when configured. One branch is
capped at 50,000 rows. Selection is deterministic by primary key or row ID. Supported transforms
are:

| Transform | Result |
| --- | --- |
| `hash` | Per-preview HMAC pseudonym with no cross-preview correlation; the default for text and blobs |
| `email` | Stable `preview+…@example.invalid` address |
| `redact` | Fixed redaction marker, zero, or empty bytes |
| `keep` | Exact value, counted explicitly in the branch report |

Numeric/date-like SQLite columns remain structural by default. JSON columns use `json.default`
for every scalar leaf and accept JSON Pointer overrides in `json.paths`. Treat every `keep` as a
security review item. In particular, enums, foreign keys, dates, URLs, constrained strings, and
JSON schema requirements may need explicit structural handling to keep the target application
valid.

The sanitizer works on a private consistent staging snapshot, never the live production file. It
uses per-preview key derivation, disables credential inheritance, empties unlisted data, verifies
foreign keys and SQLite integrity, enables secure deletion, vacuums removed pages, and overwrites
staging files before unlinking them. The production database is never modified.

After sanitization, Clank applies the preview release's migrations and starts it through the normal
health gate. Local and provider-placed previews use the same contract. Provider snapshots and
restores are generation-bound and checksum verified. A local activation failure restores the
preview's pre-branch safety snapshot; production is unaffected.

The branch report contains only counts—tables copied/emptied, rows retained/removed, and values
transformed/explicitly kept. It contains no table names, column names, source values, hashes, or
credentials. The latest report and source/target release IDs appear in `clank preview list`, the
control plane, and the audit trail.

## GitHub pull-request previews

Connect a linked, provider-placed project once:

```sh
clank preview github configure nearbycoder/my-app
git add .github/workflows/clank-preview.yml \
  .github/workflows/clank-preview-cleanup.yml
git commit -m "Deploy Clank pull-request previews"
git push
```

For a public repository, the CLI resolves and binds GitHub's immutable numeric repository ID. For
a private repository, or if public lookup is unavailable, provide it explicitly:

```sh
clank preview github configure nearbycoder/private-app \
  --repository-id=123456789 \
  --cleanup-ref=refs/heads/main
```

The trusted cleanup ref is resolved from a public repository's default branch. When the ID is
provided explicitly, the ref is also explicit; this prevents a `pull_request_target` job from an
untrusted target branch from receiving cleanup authority. Both generated workflows are restricted
to pull requests targeting that branch.

Configuration is owner/admin-only and fails unless the project uses a provider runtime or the
self-hosted control plane declares an isolated hosting profile. This is intentional: a pull
request can execute untrusted application build and runtime code.

The command writes two workflow files by default:

- `clank-preview.yml` runs for `pull_request` open, reopen, and synchronize events. It checks out
  the merge revision, installs the committed dependency graph without lifecycle scripts, and
  deploys `pull-<number>`.
- `clank-preview-cleanup.yml` runs for `pull_request_target` close events. It is loaded from the
  trusted base branch, never checks out pull-request code, and permanently removes that preview.

Both workflows pin GitHub-maintained actions to full commit SHAs. They grant only the permissions
they need. The deploy workflow receives `contents: read`; both receive `id-token: write`.

No `CLANK_TOKEN`, GitHub secret, copied CLI profile, or `.clank/project.json` is placed in the
repository. In each job, the CLI requests a GitHub OIDC JWT with the exact control-plane origin as
its audience. Clank verifies GitHub's RS256 signature plus issuer, audience, immutable repository
ID, repository name, workflow path, workflow SHA, event, ref, time window, and one-time JWT ID.
It returns a 15-minute token restricted to the production parent and one derived `pull-N` child.
That token cannot deploy production, inspect a sibling preview, manage secrets, or create tokens.
The raw JWT, JWT ID, and returned token are not stored in workflow files, CLI config, or audit
metadata.

GitHub documents the [OIDC claims and request
variables](https://docs.github.com/en/actions/reference/security/oidc). Clank binds
`repository_id` rather than trusting a reusable owner/name subject, and also supports GitHub's
immutable subject rollout without depending on either subject format.

Inspect or disconnect the binding with:

```sh
clank preview github status
clank preview github disconnect \
  --confirm="disconnect-github-previews nearbycoder/my-app"
```

Disconnecting revokes every outstanding federated preview token. It does not delete committed
workflow files or existing preview environments; remove those explicitly or allow TTL cleanup.
Use `--no-workflows` when maintaining reviewed workflow files yourself, or
`--deploy-workflow`/`--cleanup-workflow` to bind alternate files directly under
`.github/workflows`. Existing files are never overwritten unless `--force` is explicit.

Fork pull requests may not receive an OIDC token when repository policy withholds `id-token:
write`. The workflow then fails closed without a Clank credential or deployment. Maintainers can
review and rerun an allowed workflow; do not replace OIDC with a broadly scoped repository secret.

## Remove a preview

Expiration removes the runtime and all platform-managed resources. Remove it sooner with:

```sh
clank preview remove feature-auth \
  --confirm="delete-preview feature-auth" \
  --acknowledge-data-loss
```

The acknowledgement is deliberate because preview databases can contain useful test data. A
production project cannot be deleted while it still owns previews; remove or let them expire
first.

## Control-plane UI and API

The project's **Previews** page shows the active environment, URL, runtime status, current release,
and expiration. Authorized members can remove a preview there. Creation remains a CLI-first
operation so the exact local build and artifact digest are preserved.

The authenticated API is:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:parentId/previews` | List unexpired previews and the effective TTL/isolation policy |
| `POST` | `/api/projects/:parentId/previews` | Create or refresh `{ "name": string, "ttlHours"?: integer }` |
| `POST` | `/api/projects/:parentId/previews/:previewId/data` | Replace preview data from the trusted sanitized policy after exact confirmation |
| `DELETE` | `/api/projects/:parentId/previews/:previewId` | Permanently remove a preview after exact confirmation |
| `GET` | `/api/projects/:parentId/github-previews` | Read the repository/workflow binding and isolation policy |
| `PUT` | `/api/projects/:parentId/github-previews` | Owner/admin: bind an exact repository ID and two workflow paths |
| `DELETE` | `/api/projects/:parentId/github-previews` | Owner/admin: disconnect and revoke federated preview tokens |
| `POST` | `/api/preview-identities/github` | Exchange a verified, one-time GitHub Actions OIDC JWT |

Listing, creating, refreshing, and deleting previews requires preview-capable workspace access.
Ordinary project tokens must explicitly include `previews`. Federated tokens receive only that
permission and are additionally bound to one `preview_name`; the child read and release APIs
recognize that binding without granting read or deploy access to the parent production project.
Deploying a release to an existing preview otherwise uses the ordinary release API and
authorization rules.

## Isolation and limits

- Preview and production database paths live under different project IDs.
- Production secrets are not inherited. Set preview secrets explicitly if the app needs them.
- Empty is the default; raw production data copying is not exposed. Sanitized branches require a
  policy frozen into the active production release.
- Migrations run against only the preview database.
- Realtime connections, MCP/OAuth endpoints, durable jobs, and logs belong to the preview URL.
- Preview projects are hidden from the top-level production project list and appear under their
  parent.
- Every preview counts toward both account and workspace project limits. This prevents previews
  from bypassing compute, port, storage, and retention limits.
- Nested previews are rejected.
- Names are unique within one parent project. The public hostname also carries a random project-ID
  suffix, so deleting and recreating a name does not accidentally address an older environment.

## Self-hosting policy

Programmatic control planes can tune preview retention:

```ts
const platform = await openPlatform({
  // ...
  previews: {
    defaultTtlMs: 3 * 24 * 60 * 60_000,
    maxTtlMs: 14 * 24 * 60 * 60_000,
    cleanupIntervalMs: 60_000,
  },
});
```

Cleanup runs at startup before application recovery and then in bounded background batches.
Expired previews are not restarted. Deletion uses the same path containment, encrypted-backup
removal, remote-artifact cleanup, token revocation, process shutdown, and audit path as an explicit
project deletion. Set `cleanupIntervalMs: false` only when an external operator owns expiration.

GitHub federation additionally requires an HTTPS `publicUrl` and either
`hostingProfile: "isolated"` or a project with `placement: "provider"`. Signing keys are fetched
only from GitHub's fixed JWKS URL with bounded I/O, redirect refusal, an algorithm allowlist, and
short caching. `previews.githubOidcFetch` exists solely to provide an equivalent fixed-endpoint
transport in tests or controlled networking; it cannot change the trusted issuer, URL, algorithm,
claim policy, or response bounds.

## CI naming

Use stable, low-cardinality names such as `pull-482` or `branch-auth-refresh`. Always run the remove
command when a pull request closes; TTL cleanup is the safety net for interrupted workflows. Do not
put secrets, email addresses, commit messages, or untrusted free-form text in a preview name.
