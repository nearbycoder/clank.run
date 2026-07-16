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
- references to reserved `clank_` and legacy `proact_` SQL tables.

Extension loading is disabled, foreign keys and `trusted_schema=OFF` are enforced, durability is `FULL`, and integrity plus foreign-key checks run before and after migration.

`allowUnsafeMigrations: true` is only a request. The platform operator must also set `CLANK_ALLOW_UNSAFE_MIGRATIONS=1`; otherwise deployment is rejected. Enabling it lets migration SQL execute with control-plane filesystem authority and is inappropriate for untrusted deployers.

## Backup and failure

Before migration, Clank stops the active app and uses Node's SQLite backup API. Backup and restore reject symbolic links, verify source and destination integrity, keep files private, and replace through a verified temporary file. On migration, startup, or health failure Clank stops the candidate, restores the snapshot, and restarts the prior release.

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

Large online backfills should be application jobs rather than one long deployment transaction. JavaScript migration files and multi-node external-database drivers are future work.
