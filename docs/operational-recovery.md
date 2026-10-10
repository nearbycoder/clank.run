# Recovery, controlled rollouts and operational evidence

These features are opt-in operator configuration. They add no runtime packages and make no calls to GitHub Actions. Local regression coverage is in `operational-foundations.test.mjs`, `point-in-time.test.mjs`, `data-plane.test.mjs`, and the managed-canary cases in `platform.test.mjs`.

## Automated restore drills and operational alerts

Pass `operations` to `openPlatform`:

```ts
const platform = await openPlatform({
  // Existing platform configuration...
  operations: {
    intervalMs: 60_000,
    usageWarningPercent: 80,
    notify: async (alert, signal) => {
      // Deliver to your operator-selected destination. Deduplicate alert.id.
      await incidentDestination.write(alert, { signal });
    },
    restoreDrills: {
      intervalMs: 24 * 60 * 60_000,
      timeoutMs: 30_000,
      boot: async (projectId, { databasePath, signal }) => {
        // Select trusted bootstrap code for this project. Open ONLY databasePath.
        return bootDisposableApplication(projectId, databasePath, signal);
      },
      checks: [{ name: "Application boot", path: "/healthz", status: 200 }],
    },
  },
});
```

A drill decrypts the newest retained backup, opens a private disposable SQLite copy, boots the supplied application, runs loopback HTTP checks and records its receipt. It never replaces production data. The callback must not load tenant JavaScript into a shared control-plane process, start production jobs, send real notifications or connect to production writable services. Use a trusted adapter or isolated runtime with those capabilities disabled. No drill can prove correctness of external data that was not backed up.

The monitor persists incident transitions and notification attempts for deployment failures, unhealthy always-on applications, overdue jobs, backup failures/overdue schedules, forecast usage warnings and failed drills. Notifications use leased at-least-once delivery, exponential backoff and stable IDs; a resolution cannot overtake its undelivered opening notification. Delivery callbacks must honor their abort signal. Operators can read `GET /api/admin/operations` or run a poll with `POST /api/admin/operations/run`; both require a platform-admin browser session and mutations require CSRF. Polling handles at most 1,000 projects/workspaces and five rotating job inspections per pass. Configure multiple operational domains if the platform exceeds those bounds. Setting `intervalMs: false` retains manual execution.

Drill claims and results survive control-plane restarts. One due drill runs per pass. Failed setup retries after five minutes; completed reports preserve the rehearsal's phase, checks and timings. Independent encrypted object storage remains necessary to survive loss of the application volume.

## Per-commit point-in-time recovery

`openPointInTimeRecovery(database, options)` attaches a SQLite session to every write transaction. Encrypted changesets, their hash chain and the new state seal commit in the same SQLite transaction as application and service writes. A failed or oversized commit rolls back both. A consistent encrypted base backup and immutable exported journal files recover exact committed boundaries; this is not periodic snapshot approximation.

```ts
const database = await openSQLite(schema, { path: "/srv/project/data/app.sqlite" });
// For a NEW database, finish all service/schema initialization before attaching.
// For an EXISTING journal, attach before opening services or admitting writes.
const recovery = await openPointInTimeRecovery(database, {
  directory: "/srv/project/recovery/epoch-2026-10",
  encryptionKey: keyFromSecretStore, // exactly 32 bytes; never store beside the archive
  exportIntervalMs: 1_000,
  maxTransactionBytes: 4 * 1024 * 1024,
  maxStateBytes: 32 * 1024 * 1024,
  maxJournalEntries: 10_000,
  maxJournalBytes: 128 * 1024 * 1024,
});
// Admit application requests only after the awaited call completes.
// At shutdown: stop application writers, await recovery.close(), database.close().
```

A recovery-enabled database must use one Clank connection. Another connection's write fences further managed writes through SQLite `data_version`; reopening verifies the canonical persisted state seal to detect changes while the process was down. Reopening a journal-bearing database without reattaching recovery rejects managed writes. Raw SQL tools, multiple writer processes, migrations and arbitrary connection access are outside the supported write contract. Administrative tools must stop the application and follow epoch rotation below. Restore a known verified epoch if an unexpected writer invalidates the seal; do not overwrite the stored seal to dismiss the error.

All captured tables require a primary key with no null values. Virtual tables, generated/hidden columns, more than 200,000 rows per table, and state exceeding `maxStateBytes` are rejected. SQLite integer values outside JavaScript's safe integer decoding range are rejected by the native reader. The logical state seal is recomputed for each transaction, including internal service reads that acquire the capture transaction; benchmark this opt-in bounded-database mode before production adoption. It is intentionally not a low-cost WAL archive for large databases. Trigger and foreign-key cascade effects are captured once; replay suspends their automatic effects, applies the captured changes, restores trigger definitions and checks foreign keys plus the canonical committed state seal.

The journal remains durable in the live SQLite database until epoch rotation. `flush()` fsyncs immutable encrypted entries and an authenticated export checkpoint. `status().committedThrough` may exceed `exportedThrough` while export is pending. Copy the entire repository, including `epoch.json`, `head.json`, journal entries and `base/`, to independently retained storage; loss of the live database before export loses those unexported transactions. A current independently retained checkpoint is necessary to detect replacement of an entire repository with an older valid copy. Commit timestamps are recorded immediately before commit and strictly ordered; exact sequence selection is the strongest boundary.

The optional journal entry and encrypted byte limits fence the next mutation when capacity is exhausted. The application write, revision, history and recovery sequence roll back together. Reopening does not discard entries or reset the epoch. Rotate a quiesced, independently verified epoch to regain capacity.

Restore only into a stopped destination:

```ts
const restored = await restorePointInTime({
  directory: "/restore/epoch-2026-10",
  encryptionKey: keyFromSecretStore,
  targetPath: "/srv/recovered/data/app.sqlite",
  throughSequence: 125, // alternatively asOf: timestampMilliseconds
  confirmation: "restore point in time",
  maxDurationMs: 30_000,
  assertCurrent() { assertReservedDestinationStillOwned(); },
});
```

Restore authenticates the base and every exported entry through the authenticated checkpoint, rejects gaps, conflicting changes, tampering and unavailable requested sequences, and replays inside the bounded SQLite worker namespace. It publishes the stopped destination only after verification. The original destination survives failed verification. `asOf` selects the latest available recorded commit at or before the timestamp; requests before the base snapshot fail. The recovered database starts without the old journal metadata so it can begin a new epoch.

The default overall replay budget is 30 seconds, with `maxDurationMs` bounded from 1 through 60,000. Time is measured monotonically. The trusted `assertCurrent` callback must complete synchronously and return no value; promises and thenables are rejected. Clank calls it between asynchronous verification steps and before the final stopped-database publication, after the native replacement worker closes. An in-flight native worker remains subject to its existing process deadline and is awaited before cleanup. Keep the destination stopped and exclusively owned throughout; this callback does not create a distributed transaction or fence an independently running writer. `restoreSQLiteBackup(source, destination, assertCurrent)` offers the same publication assertion for an already verified backup.

### Encrypted provider checkpoints

`exportPointInTimeRecovery(recovery, bounds)` accepts only the original live native capture handle. A copied status object, JSON descriptor or closed handle cannot export. Its `clank-pitr-archive/1` envelope contains the complete encrypted base and contiguous exported journal, bounded encoded bytes and entry count, checksums, exact epoch/head and a whole-envelope HMAC. Retain the accepted epoch, sequence and digest independently of the archive.

```ts
const archive = await exportPointInTimeRecovery(recovery, {
  operationId: "checkpoint_2026_10_10_01",
  binding: { projectId, nodeId, releaseId, generation },
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 10_000,
});
await restorePointInTimeArchive(archive, {
  encryptionKey: independentlyRecoveredKey,
  targetPath: reservedStoppedDestination,
  confirmation: "restore point in time",
  throughSequence: chosenSequence,
  expectedEpoch: retainedCheckpoint.epoch,
  expectedSequence: retainedCheckpoint.sequence,
  expectedDigest: retainedCheckpoint.digest,
  expectedBinding: retainedCheckpoint.binding,
  operationId: retainedCheckpoint.operationId,
  assertCurrent() { assertReservedDestinationStillOwned(); },
});
```

Stable export operation IDs retain the exact accepted encrypted archive in the source's native SQLite receipt store. Exact retry after restart returns that horizon even if newer application writes exist; a changed binding or bound conflicts. Receipt count and bytes are bounded, never silently evicted. Missing enrolled receipt tables, partial capture state and corrupt receipts require verified operator recovery. Restore removes the source's capture and export-receipt metadata so the separate database can enroll a fresh epoch and new operation identities.

Verification has one exclusive private `.verify-<project-SHA256>` workspace per project. Archive extraction and replay use exclusive `.clank-pitr-<destination-SHA256>-archive` and `-replay` directories beside the exact destination. Ordinary completion or failure cleans only directories created by that attempt. SIGKILL can leave these directories behind; the exact retry then refuses existing state with `EEXIST`, rather than allocating another workspace or deleting a possible live worker's files. Abandoning an export does not bypass its project's workspace fence. Older random `.verify-*` directories also block new capture until reconciled. Retained archive byte limits cover encrypted retention, not the separate bounded database materialization footprint.

An interrupted workspace requires operator recovery: stop and verify quiescence of the registered controller and its workers, inspect the exact private workspace and pending operation, preserve any needed evidence, and reconcile that workspace before restarting or retrying the unchanged operation. Do not remove unrelated directories, clear a live workspace or bypass native leases. Unknown workspace contents and symbolic links are never adopted or automatically reclaimed. Successful source receipt replay still preserves its exact retained horizon; interrupted temporary verification is a separate recovery boundary.

`createPointInTimeRecoveryProvider(recovery, { binding, token, assertCurrent })` mounts a private `GET /__clank/pitr/checkpoint` handler around that actual capture. Its server-owned binding and current native assertion must describe the same project, node, release and generation. Use a dedicated private control credential and dispatch this handler only through the registered provider integration. Ordinary provider snapshots and arbitrary application endpoints do not establish journal capture.

The platform's optional `pointInTime` configuration resolves these registered sources and separately resolves retained checkpoint keys with `restoreKey(projectId, checkpoint)`. Key resolution must remain available after the source node disappears. Encrypted archives, receipts and horizons commit together in the control database. Preserve the private `point-in-time/protocol` enrollment marker with that database; missing or partial enrolled tables fail closed. An enrolled installation requires its recovery configuration at startup, including when scheduling is disabled. Omitting the option cannot bypass retained destination fences or artifact pins. Catalogs from an unmarked private foundation format require explicit operator recovery.

`GET /api/projects/:projectId/point-in-time` reads current policy and checkpoint metadata. Current human administrators configure a policy with `PUT`, exact `operationId`, `expectedVersion`, `enabled`, `intervalMs` and confirmation `configure-recovery <slug>`. Configuration requires a freshly verified passkey or MFA in the current browser session. `POST .../point-in-time/checkpoints` requests an exact version-bound operation. Configuration replies separate the operation's historical receipt from the current policy.

`POST .../point-in-time/restores` creates a separate local project in the source workspace. Supply exact `operationId`, `checkpointId`, `expectedVersion`, `throughSequence`, `name`, `slug` and confirmation `restore-recovery <source-slug> <checkpoint-id> <sequence> <destination-slug>`. Current human workspace administration and fresh browser authentication are required. Clank reserves one suspended destination, verifies the encrypted checkpoint through the selected sequence using the independent key resolver, copies the retained checkpoint release artifact, and acknowledges that release and restore receipt in one control-database transaction. Source secrets are not copied. The destination stays suspended after acceptance; review its data and configure secrets before changing its ordinary runtime policy.

Status includes retained restore receipts and pending destinations. Retrying the exact request after interruption resumes its original stopped reservation; changing its checkpoint, sequence, actor or destination conflicts. Pending destinations reject deployment, activation and destructive changes. A live operation lease blocks a second restore, and current authority is checked throughout native verification and before acknowledgment. Accepted checkpoint artifacts and pending source artifacts are pinned against cleanup. Preserve an interrupted destination and its intent for exact retry or operator recovery; do not remove its native receipt or start a writer manually.

Agents can inspect bounded metadata with `clank recovery status --json`. `clank recovery checkpoint --key <stable-operation> --expected-version <current-version>` uses current human administrative authorization and keeps exact retries bound to that version. `clank recovery restore-plan --request <json-file> --json` accepts `operationId`, `checkpointId`, `expectedVersion`, `throughSequence`, `name` and a canonical `slug`; it checks the retained horizon and prints the exact browser request and confirmation. It does not submit the restore or create a browser credential. Machine read grants can read recovery metadata only for their current project; every recovery mutation remains reserved for humans.

The stateless MCP endpoint is `POST /api/projects/:projectId/point-in-time/mcp`. It exposes only `recovery_status` and `recovery_restore_plan`, with the same current project read authority as the metadata API. The plan accepts the six fields above and returns the exact browser request after checking the current policy version and retained sequence. Neither tool reserves a destination, captures a checkpoint, configures a policy or submits a restore. Browser requests require the ordinary origin and CSRF checks; bearer requests require a current project read grant. Authority is checked again after reading the request and before returning its response. Requests are bounded to 16 KiB, responses to 1 MiB, and no persistent MCP session is created. Use the framework's current MCP protocol headers and request metadata described in the MCP guide.

In the project's **Backups** view, the recovery section shows the current policy, retained checkpoint sequences and times, exact release bindings and restore operations. Review a schedule or checkpoint request before applying it. To restore, select a checkpoint and sequence, enter a new project name and slug, review the source and suspended destination, and type the exact confirmation. Verify a passkey in the current browser before submitting a sensitive action; MFA is usable only when the authentication server has a configured delivery method. Verification never automatically submits a recovery request.

An unknown acknowledgment keeps the exact reviewed body and operation identity available for explicit retry. Refresh current status before clearing the review or choosing different input. Navigating to another project, signing out or losing current access clears private forms and fences late responses. Restore history links to an accessible destination's Settings, where runtime activation remains a separate decision. Readers and support sessions can inspect current metadata; their mutation controls stay disabled. Policy configuration and failed-export resolution verify their native policy and receipt acknowledgments before committing, including when SQLite ignores an update.

Disabling scheduling retains accepted archives and exact checkpoint retries. Resolve an unrecoverable pending export through `POST .../point-in-time/resolve` only after disabling its current policy and inspecting the exact pending ID. Supply `operationId`, `pendingOperationId`, `expectedVersion` and confirmation `abandon-recovery <slug> <pending-id>` with fresh current human administration. Resolution refuses a live export lease, preserves the original binding and operation evidence, and releases only that pending byte reservation. It does not resume a source writer or discard accepted checkpoints.

Export admission verifies that its native intent and lease writes were retained before contacting the provider. An ignored write rolls back that reservation. Byte admission checks pending reservations against their configured bounds and accepted reservations against their checkpoint and stored archive lengths; negative, understated or orphaned entries require operator recovery. Corrupt accounting never frees space for another export.

The current platform policy stays bound to its retained epoch. Changing provider generation can preserve that verified epoch; initializing a new epoch requires a separately reviewed operator transition or a new recovery project. Disabling and re-enabling a policy never resets its recorded history.

To rotate for a schema migration: stop all writers; flush and retain the old encrypted epoch; restore its final sequence into a new stopped database; apply migrations to that new database; open it and initialize services; attach a new recovery repository; verify a restore drill; switch to the new database. This also bounds retained journal storage. To roll back the feature, stop writers and restore the latest verified sequence into a database without recovery metadata, then deploy the prior configuration. Do not drop journal metadata from a live writer or delete its archive as part of disabling the feature.

## Managed canary deployments

`openPlatform({ canary: ... })` enables measured traffic stages for local code-only deployments with an existing running release and managed ingress:

```ts
canary: {
  stages: [
    { trafficPercent: 10, durationMs: 60_000, minimumSamples: 100 },
    { trafficPercent: 50, durationMs: 60_000, minimumSamples: 100 },
    { trafficPercent: 100, durationMs: 60_000, minimumSamples: 100 },
  ],
  maximumErrorRate: 0.01,
  maximumP95Ms: 500,
}
```

The candidate first passes its health endpoint, then receives each configured percentage of requests. Assignment uses a deterministic 100-request cycle; there is no user/session affinity. Samples count completed responses actually routed to that candidate, using body completion latency, final status and stream errors. Cancelled client requests do not satisfy sample requirements. Up to the newest 10,000 samples per stage are retained; delayed completions from an earlier stage are excluded. Each stage must meet its duration, sample count, error and p95 limits. Missing traffic fails safely rather than silently promoting. Health, process liveness, current deployment authority and the renewable project lock are rechecked throughout. Failure removes candidate routing and the existing deployment rollback path stops it and restores prior background workers. The prior application remains the routing fallback. Final promotion uses the existing activation transaction and drains the prior release.

Both web versions share the same database during a code-only canary. Application code and data writes must be backward compatible. Previous background workers are quiesced before candidate workers start. Pending migrations are rejected for an existing running canary baseline; perform them through an explicit maintenance deployment with canaries disabled. Provider generations are not supported by this local parallel-runtime implementation and configured provider canary deployments fail closed. A first deployment has no baseline and follows normal health-gated activation.

`GET /api/projects/:id/canary` returns durable stage and failure reports to an authorized project reader. Interrupted control-plane runs are marked interrupted on startup and retain the prior authoritative release. Disabling the option removes canary routing; durable reports remain. No migration is required for existing installations; the additive report table is created when configured.

Managed local runtimes run beneath a separate supervisor process, outside the imported application. Loss of the control-plane IPC connection stops the runtime's process group or removes its exact Docker container. A private, fsynced `runtime-guardians` fence remains until cleanup is verified, and startup refuses to admit replacement writers while an earlier fence is unresolved. Preserve these files after an uncertain Docker/host failure; verify the recorded runtime has stopped before operator recovery. The process runner remains a trusted-application development mode, not a security boundary against applications that can access the host or deliberately escape their process group. Local crash regressions are in `platform-crash.test.mjs`; `platform-docker-crash.test.mjs` additionally verifies real container removal and database write order on an explicitly disposable Docker host.

Background recovery and incoming application requests share the same project lock, so requests wait for an in-progress recovery instead of launching a second runtime. After an abrupt controller failure during a locked operation, recovery also waits for the previous controller's lease to expire, which can take up to 30 seconds. A controller that loses its lease during startup stops its candidate without starting additional workers, publishing the runtime, or overwriting the successor's release status.

## Streaming usage and forecasts

Ingress records response bytes when chunks are handed to the downstream reader, including terminal completion, cancellation and stream errors. It never bills a declared `Content-Length` as delivered bytes. HEAD and bodyless status responses count zero. Metrics emit once at body termination, and drain leases are released at that same boundary. This measures application payload consumed from managed ingress, not TLS, TCP, compression or remote receipt. Long streams are metered when they terminate, in the request's recorded usage period. Process death before termination can lose the unfinished metric.

Workspace usage payloads include `forecast.requests` and `forecast.transferBytes`, with observation duration, average rate, projected period total and estimated exhaustion time. Less than one hour of data reports insufficient evidence, while actual warning/exhaustion thresholds still apply. Forecasts extrapolate observed average demand and cannot predict bursts or future traffic changes.

## Independently verifiable audit exports

Configure `auditExport` with an Ed25519 private key, stable key ID and an operator-controlled destination callback. The exporter signs sequence-linked canonical event digests into a durable outbox before delivery. Acknowledged batches advance the checkpoint; retries reuse the identical signed entries. Destination storage must deduplicate by sequence and digest and preserve an independent checkpoint. Keep the private key outside the platform database and protect trusted public keys through a separate configuration channel.

`verifyAuditExport(entries, publicKeys, previousCheckpoint?)` verifies signatures, order, continuity, event content and allowed envelope fields and returns the next checkpoint. Omission, reordering and mutation are rejected. A verifier without an independently retained checkpoint cannot detect removal of an entire valid suffix or rollback to an older valid export. Existing audit IDs must be contiguous; historical deletion causes an explicit export error instead of claiming a complete chain. Plan retention and key rotation with the destination operator. `GET /api/admin/audit-export` exposes delivery status to browser platform admins. Removing the option stops export without deleting the audit log/outbox, and restoring the same keys and destination resumes it. Keys from earlier export periods must remain available to independent verifiers.
