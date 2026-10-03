# SQLite migrations

Framework document tables and indexes can still be created automatically. Deployment migrations cover relational support tables, columns, constraints, indexes, and SQL data changes.

## Files and ledger

```text
migrations/
  0001_create_accounts.sql
  0002_add_account_status.sql
```

Names match `<4-12 digits>_<lowercase-name>.sql`; IDs strictly increase.

Clank records:

```sql
CREATE TABLE clank_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

The checksum covers exact SQL bytes. Editing, renaming, or removing applied history stops deployment. Fix production with a new migration.

## Transactions and safety

All pending migrations run in one `BEGIN IMMEDIATE`. Either every migration and ledger row commits, or none does.

Defaults reject:

- `ATTACH`, `DETACH`, and `VACUUM`;
- `load_extension`;
- all `PRAGMA` statements;
- top-level `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `RELEASE`.
- references to reserved `clank_` and legacy `proact_` SQL tables, including single-quoted names accepted by SQLite. The conservative guard also rejects single-quoted literals beginning with these reserved prefixes.

Extension loading is disabled, foreign keys and `trusted_schema=OFF` are enforced, durability is `FULL`, and integrity plus foreign-key checks run before and after migration.

Planning, migrations, backup, restore, and database integrity inspection run in separate terminable processes. Each operation has a 10-second wall-clock deadline, a 128 MiB V8 heap limit, and a 16 MiB request/response limit. Each host process admits two active SQLite tasks and at most 16 waiting tasks; excess work fails with a retryable capacity error. Pending migration transactions recover through SQLite's journal after a worker is killed; the platform's existing deployment recovery restores its pre-change backup when applicable.

The execution deadline begins when a queued task starts. The scheduler rotates waiting projects, allows one active worker and four queued tasks per project, and expires queued tasks after ten seconds. These process limits do not enforce disk quotas; operators still need filesystem capacity limits and monitoring. The Docker provider supports opt-in [XFS project quotas](linux-provider-isolation.md).

Linux additionally requires the `prlimit` system utility from util-linux at `/usr/bin/prlimit` or `/bin/prlimit`. Workers run without JIT compilation, with kernel limits of 256 MiB for the data segment, 1 GiB of address space, 10 CPU seconds, and disabled core dumps. A missing utility rejects database work. These are system requirements, not npm dependencies. Other operating systems enforce the deadline and V8 limit but need an external sandbox for native allocation limits; SQLite's `hard_heap_limit` is only defense in depth because standard Node builds disable the memory accounting needed to enforce it.

`allowUnsafeMigrations: true` is only a request. The platform operator must also set `CLANK_ALLOW_UNSAFE_MIGRATIONS=1`; otherwise deployment is rejected. It relaxes SQL restrictions and should remain limited to reviewed operator migrations. The Linux filesystem namespace still applies, while non-Linux workers retain host-user filesystem authority.

## Backup and failure

Before applying pending migrations, Clank stops the active app. Planning and the pre-release snapshot can run while the prior release is still active. Backup uses Node's SQLite backup API. Backup and restore reject final symbolic links, verify source and destination integrity, keep files private, and replace through a verified temporary file. On migration, startup, or health failure Clank stops the candidate, restores the snapshot, and restarts the prior release.

Linux workers require Bubblewrap at `/usr/bin/bwrap` and permission to create their namespaces. Selected database directories are pinned with no-follow descriptors and mounted into a private filesystem; backup publication retains its destination descriptor through replacement and cleanup. See [SQLite worker isolation](sqlite-isolation.md) for requirements and real regression tests. Non-Linux workers retain host-user filesystem authority, so they require trusted deployers or an external sandbox.

Same-disk snapshots do not protect against disk loss. Export encrypted backups off-host and test restoration.

## Expand and contract

For code-only rollback:

1. Add compatible nullable structures.
2. Deploy code that reads old/new and writes new.
3. Backfill.
4. Depend on the new form.
5. Remove the old form after the rollback window.

Avoid dropping a required column in the same release that first stops using it.

## Data restore

Snapshot restore discards newer writes. It is available only to the immediately previous release and requires an exact project confirmation.

## Local checks

```sh
clank migrate plan
clank migrate apply
```

Large online backfills should be application jobs rather than one long deployment transaction. JavaScript migration files are intentionally unsupported. External PostgreSQL uses the structured HTTPS driver and immutable transactional ledger described in [Managed ingress and external data](data-plane.md).
