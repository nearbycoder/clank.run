# Backup and disaster recovery

Clank distinguishes deployment rollback from database recovery:

- a release rollback changes application code and can optionally restore the immediately preceding migration snapshot;
- a recovery backup is an independently retained, encrypted, integrity-verified SQLite snapshot.

Remote runtime providers can obtain a generation-bound consistent export through
`openDeploymentProviderDataStore().snapshot(projectId)`. `BackupManager.createFromSnapshot()`
accepts that bounded export and encrypts it directly from memory without creating a plaintext
staging file on the repository host. The provider store's immediate rollback snapshot is
intentionally local, single-generation, and not a disaster-recovery copy. See [Provider data
lifecycle](provider-data-lifecycle.md) and [Complete provider
service](provider-service.md#remote-snapshot-boundary).

## Application API

```ts
import { createS3ObjectStore } from "@clank.run/framework/object-storage";
import { openBackupManager } from "@clank.run/framework/recovery";

const objects = createS3ObjectStore({
  endpoint: process.env.AWS_ENDPOINT_URL!,
  region: process.env.AWS_DEFAULT_REGION ?? "auto",
  bucket: process.env.AWS_S3_BUCKET_NAME!,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  maxObjectBytes: 32 * 1024 * 1024,
});

const backups = await openBackupManager({
  databasePath: "app.sqlite",
  repositoryDirectory: "/srv/clank/backups/orbit-tasks",
  encryptionKey: process.env.BACKUP_KEY!,
  maxBackups: 30,
  maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  verifyAfterCreate: true,
  objects: {
    store: objects,
    namespace: "production-recovery-v1",
    repositoryId: "orbit-tasks",
    chunkBytes: 8 * 1024 * 1024,
  },
});

await backups.create({ reason: "scheduled" });
backups.start(6 * 60 * 60 * 1_000);
```

An import-only repository does not need access to a live local database:

```ts
const backups = await openBackupManager({
  repositoryDirectory: "/srv/clank/backups/remote-orbit-tasks",
  encryptionKey: process.env.BACKUP_KEY!,
  maxDatabaseBytes: 512 * 1024 * 1024,
});

const backup = await backups.createFromSnapshot({
  bytes: consistentSQLiteBytes,
  sha256: expectedSha256,
  source: "app.sqlite",
  reason: "provider snapshot",
});

const restored = await backups.read(backup.id);
// `restored.bytes` is authenticated, checksum-verified, bounded, and SQLite-identified.
```

`createFromSnapshot()` copies the caller's `Uint8Array`, validates the SQLite header, byte limit,
optional SHA-256, source basename, and metadata before it allocates a recovery point. It writes
only the AES-256-GCM envelope and authenticated manifest. `read()` authenticates both, decrypts
into bounded memory, verifies the byte count, SHA-256, and SQLite header, and returns a fresh byte
array. Treat both input and output bytes as sensitive: keep them off logs, URLs, headers, and
unencrypted storage, and release references promptly.

Each `clank-backup/1` record contains:

- a transactionally consistent SQLite snapshot;
- AES-256-GCM encrypted database bytes;
- authenticated manifest metadata;
- plaintext size and SHA-256 for restore verification;
- database revision and migration position;
- key ID, reason, and creation time; and
- retention metadata.

Logical manifests are HMAC authenticated and are also bound as AEAD additional data. File restore
decrypts to a private temporary file, verifies the plaintext digest and byte count, runs SQLite
`integrity_check`, and only then replaces the stopped database. An import-only manager requires an
explicit `targetPath` for file restore; use `read()` when the verified bytes will travel inside a
fenced provider runtime capsule instead.

`restore` requires the exact confirmation `restore <backup-id>`.
`purge({ confirmation: "delete all backups" })` removes completed and incomplete repository state;
the deployment platform uses it only inside an already confirmed permanent project deletion.
`protectedBackupIds` can temporarily exempt restore targets from one create-time retention pass.
Clank uses that protection for the safety copy created immediately before a restore, so a full
retention window cannot prune the selected target.

Omit `objects` for the original owner-only local repository. With `objects`, Clank encrypts locally,
uploads bounded immutable chunks, authenticates the remote catalog, verifies the completed remote
copy, and then removes the committed local copy. Existing local recovery points are promoted before
the next new backup. If a provider write fails, the encrypted local recovery point remains listed
and is retried; it is never discarded merely because replication failed.

## Platform workflow

Clank Deploy creates and verifies an encrypted backup for every deployed local or provider project
every 24 hours by default. The schedule is durable: due work and expiring lease tokens live in the
control database, so multiple control-plane processes cannot back up the same project concurrently.
Existing databases are due when automation first starts; a newly deployed database is due after
one interval. Manual backups reset the next scheduled time.

```sh
clank backup create --reason "before bulk import"
clank backup list
clank backup verify <backup-id>
clank backup restore <backup-id> \
  --confirm="restore-backup <project-slug> <backup-id>"
```

For local placement, platform restore creates and verifies a safety backup of the current database,
stops the application, restores the requested backup, and restarts the active release. If restore
or restart fails, it attempts to restore the safety backup before reporting failure. Provider
restore currently returns `PROVIDER_RESTORE_PENDING`; use backup create/list/verify now, but retain
an independently tested provider-host restore procedure until fenced replacement generations are
available.

Provider backup creation requests a consistent snapshot only from the exact active pinned node,
release, generation, and allowlisted origin. A separate derived control token is carried in the
runtime capsule, retained only as an in-memory digest by the provider, and never shares public
ingress authority. The control plane refuses redirects and encoded responses, requires exact
length/media-type/digest/release/generation metadata, reads under a configured deadline and byte
limit, rehashes the body, rechecks placement, and immediately imports it into the encrypted
repository without plaintext disk staging. A provider generation created before snapshot-control
support must be deployed once before its first managed backup. Snapshot import and create-time
verification are bounded but memory-resident, so set `CLANK_PROVIDER_MAX_DATABASE_BYTES` below the
control-plane memory headroom available while the configured backup concurrency is active.

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
| `CLANK_PROVIDER_MAX_DATABASE_BYTES` | `536870912` | Provider export bound; the lower of this and the backup limit applies |
| `CLANK_BACKUP_STORE` | `local` | Recovery repository: `local` or `s3` |
| `CLANK_BACKUP_NAMESPACE` | none | Required stable physical-repository identity for `s3` |
| `CLANK_BACKUP_PREFIX` | `backups` | Logical root inside the configured object-store prefix |
| `CLANK_BACKUP_CHUNK_BYTES` | `8388608` | Encrypted bytes per object, from 64 KiB through 64 MiB |

Disabling automation does not disable manual backup or verification, nor local restore. It also
does not delete existing restore points.

The `s3` mode uses the shared `CLANK_OBJECT_*` connection variables documented in
[Object storage](object-storage.md). The platform records the namespace and logical root in its
control database. It refuses to start if object backup configuration later disappears or changes.
This protects against silent repository drift; preserve that control database and keep the
operator-selected namespace stable during a provider migration.

## Recovery objectives

Operators should set and test explicit objectives:

- **RPO**: backup interval plus replication delay;
- **RTO**: detection, backup selection, decrypt/verify time, and application restart time;
- **retention**: enough restore points to cover delayed discovery;
- **key recovery**: backup keys must be stored separately from the backup repository; and
- **failure domain**: select an object repository outside the application host and, where required,
  outside its region.

Run `verify` automatically and perform recurring restore drills into a temporary environment. A backup that has never been decrypted and opened is not a proven recovery point.

Local storage remains the zero-setup default and does not protect against platform-volume loss.
Object mode publishes a recovery point only after its authenticated chunk set has been reassembled
and verified. It still depends on the control database for project identity and on the platform
master key for decryption. Back up those through separate access paths, monitor failed promotions,
and test a clean-environment restore rather than treating object existence as proof of recovery.
