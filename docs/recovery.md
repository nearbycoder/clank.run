# Backup and disaster recovery

Clank distinguishes deployment rollback from database recovery:

- a release rollback changes application code and can optionally restore the immediately preceding migration snapshot;
- a recovery backup is an independently retained, encrypted, integrity-verified SQLite snapshot.

## Application API

```ts
import { openBackupManager } from "clank.run/recovery";

const backups = await openBackupManager({
  databasePath: "app.sqlite",
  repositoryDirectory: "/srv/clank/backups/orbit-tasks",
  encryptionKey: process.env.BACKUP_KEY!,
  maxBackups: 30,
  maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  verifyAfterCreate: true,
});

await backups.create({ reason: "scheduled" });
backups.start(6 * 60 * 60 * 1_000);
```

Each `clank-backup/1` record contains:

- a transactionally consistent SQLite snapshot;
- AES-256-GCM encrypted database bytes;
- authenticated manifest metadata;
- plaintext size and SHA-256 for restore verification;
- database revision and migration position;
- key ID, reason, and creation time; and
- retention metadata.

Logical manifests are HMAC authenticated and are also bound as AEAD additional data. Restore decrypts to a private temporary file, verifies the plaintext digest and byte count, runs SQLite `integrity_check`, and only then replaces the stopped database.

`restore` requires the exact confirmation `restore <backup-id>`.

## Platform workflow

Clank Deploy creates and verifies an encrypted backup for every deployed project every 24 hours by default. The schedule is durable: due work and expiring lease tokens live in the control database, so multiple control-plane processes cannot back up the same project concurrently. Existing databases are due when automation first starts; a newly deployed database is due after one interval. Manual backups reset the next scheduled time.

```sh
clank backup create --reason "before bulk import"
clank backup list
clank backup verify <backup-id>
clank backup restore <backup-id> \
  --confirm="restore-backup <project-slug> <backup-id>"
```

Before a platform restore, Clank creates and verifies a safety backup of the current database, stops the application, restores the requested backup, and restarts the active release. If restore or restart fails, it attempts to restore the safety backup before reporting failure.

Backup creation, verification, and restore are audited. The `rollback` project permission is required for mutations; read access can list backup metadata.

The deployment console's **Backups** view shows the cadence, next run, active work, last failure, retained restore points, and manual create/verify actions. Host filesystem paths are deliberately omitted from browser and CLI responses. Unexpected scheduler errors go only to the operator error callback; users receive a fixed failure status without exception text.

Platform retention defaults to 30 backups and 90 days per project. Configure it with:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CLANK_BACKUP_INTERVAL_MS` | `86400000` | Automatic cadence; `0` disables scheduling |
| `CLANK_BACKUP_BATCH_SIZE` | `5` | Maximum projects claimed in one pass |
| `CLANK_BACKUP_MAX_COUNT` | `30` | Maximum retained backups per project |
| `CLANK_BACKUP_MAX_AGE_MS` | `7776000000` | Maximum retained age |
| `CLANK_BACKUP_MAX_DATABASE_BYTES` | `10737418240` | Maximum source database size |

Disabling automation does not disable manual backup, verification, or restore. It also does not delete existing restore points.

## Recovery objectives

Operators should set and test explicit objectives:

- **RPO**: backup interval plus replication delay;
- **RTO**: detection, backup selection, decrypt/verify time, and application restart time;
- **retention**: enough restore points to cover delayed discovery;
- **key recovery**: backup keys must be stored separately from the backup repository; and
- **failure domain**: copy encrypted backup directories to storage outside the application host and region.

Run `verify` automatically and perform recurring restore drills into a temporary environment. A backup that has never been decrypted and opened is not a proven recovery point.

The built-in repository is local. A remote repository can synchronize completed backup directories because a backup becomes visible only after its encrypted envelope and authenticated manifest are complete. Replicate `projects/<id>/recovery/` off-host; the local schedule alone does not protect against loss of the platform disk or master key.
