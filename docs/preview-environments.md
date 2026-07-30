# Preview environments

Clank previews are temporary deployments attached to a production project. Each preview is a real
isolated project with its own URL, SQLite database, migration history, releases, secrets, jobs,
logs, metrics, backups, and project-scoped tokens.

The important default is absence: creating a preview does **not** copy production data or secrets.
An application must populate test data explicitly. This prevents a routine branch deploy from
turning into an unreviewed production-data export.

## Deploy a preview

Link the directory to its production project once, then name the preview:

```sh
clank preview deploy feature-auth
clank preview deploy pull-482 --ttl=48
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
expiration, release digest, URL, and build/upload timing.

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
| `DELETE` | `/api/projects/:parentId/previews/:previewId` | Permanently remove a preview after exact confirmation |

Creating, refreshing, and deleting previews requires deploy-capable workspace access and an
account session or account CLI token. A project-scoped token cannot manage previews because it
would not automatically gain authority over the newly isolated child project. Deploying a release
to an existing preview uses the ordinary release API and authorization rules.

## Isolation and limits

- Preview and production database paths live under different project IDs.
- Production secrets are not inherited. Set preview secrets explicitly if the app needs them.
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

## CI naming

Use stable, low-cardinality names such as `pull-482` or `branch-auth-refresh`. Always run the remove
command when a pull request closes; TTL cleanup is the safety net for interrupted workflows. Do not
put secrets, email addresses, commit messages, or untrusted free-form text in a preview name.
