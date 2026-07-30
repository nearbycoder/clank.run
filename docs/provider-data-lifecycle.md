# Provider data lifecycle

Remote application placement is more than copying a release. A trusted runtime provider must keep
each project's SQLite file outside immutable code, migrate it before traffic changes, retain a
known rollback point, recover interrupted work, and erase it only after an explicit destructive
request.

Clank packages that boundary as `@clank.run/framework/provider-data`. It uses Node's built-in
SQLite and filesystem APIs and has no provider SDK or runtime dependency.

```ts
import {
  openDeploymentProviderDataStore,
} from "@clank.run/framework/provider-data";
import type {
  DeploymentProvider,
} from "@clank.run/framework/provider";

const data = await openDeploymentProviderDataStore({
  rootDirectory: "/var/lib/clank-provider",
  maxDatabaseBytes: 1024 * 1024 * 1024,
});

const provider: DeploymentProvider = {
  kind: "microvm",
  async reconcile(request) {
    if (request.desired.state === "stopped") {
      await stopProject(request.operation.projectId, request.signal);
      return;
    }
    if (!request.runtime) {
      throw new Error("This provider requires clank-runtime/1.");
    }

    // SQLite migrations and restore are stopped-runtime operations. Drain and
    // stop the current generation before allowing the store to mutate data.
    await stopProject(request.operation.projectId, request.signal);

    try {
      await data.apply({
        operation: request.operation,
        desired: request.desired,
        runtime: request.runtime,
        signal: request.signal,
      }, async (prepared) => {
        // The release and migrated database are private at this point.
        const candidate = await startPrivateCandidate({
          releaseDirectory: prepared.releaseDirectory,
          databasePath: prepared.databasePath,
          environment: prepared.environment,
          signal: request.signal,
        });
        try {
          await candidate.checkHealth();
          await retainPrivateCandidate(candidate, prepared);
        } catch (error) {
          await candidate.stop();
          throw error;
        }

        // Do not publish ingress here. Store enough provider-local runtime state
        // to make the same capsule/fence retry idempotent, then let apply commit.
      });
    } catch (error) {
      await restartCommittedProject(await data.inspect(request.operation.projectId));
      throw error;
    }

    // Only a committed generation may be switched into managed ingress.
    await publishProjectRoute(request.operation.projectId, request.signal);
  },
};
```

The callback receives final environment values and the managed-ingress token in memory. Treat it as
a secret-bearing runtime boundary: do not log, serialize, persist, or return the prepared object.
It also receives the exact normalized deployment config from the verified capsule, so a launcher
does not need a second caller-supplied copy.
It may start an unreachable candidate and run its health check, but it must not expose that
candidate to public traffic. If the callback throws or the signal is aborted, Clank restores the
prior database and removes the candidate release. Provider code must also stop a failed candidate
and restart the prior committed release before restoring ingress.

`apply`, `rollback`, and `delete` are stopped-runtime operations. The store owns files, not
processes, so it cannot prove that an application has released SQLite handles. Drain writes and
stop every web/job/scheduler process for the project before calling them. A live
`snapshot(projectId)` is safe because it uses SQLite's online backup API.

## What `apply` guarantees

The store independently rehashes and decodes the exact `clank-runtime/1` capsule. It then binds the
capsule to the provider operation's project and the desired state's protocol, release, and
generation. Calling the store directly cannot bypass the provider transport checks.

For one accepted generation it:

1. rejects stale generations and monotonically stale operation fences;
2. extracts the verified release into an owner-only staging directory;
3. creates a transactionally consistent safety copy of existing SQLite data;
4. initializes, preserves, or replaces the project database according to the capsule;
5. applies ordered immutable migrations from that exact release;
6. enforces the configured resulting database-size ceiling;
7. promotes the immutable release and calls the private validation hook;
8. atomically commits generation metadata and its fence high-water mark; and
9. retains only the active release, its immediate predecessor, and the snapshot needed to undo the
   active generation.

The provider root uses this layout:

```text
/var/lib/clank-provider/
└── projects/
    └── <project-id>/
        ├── data/          # the project's SQLite file
        ├── generations/   # active and one rollback release
        ├── recovery/      # immediate rollback snapshot
        ├── .staging/      # unreachable in-progress extraction
        ├── state.json     # active/previous generation, digest, and paths
        ├── fence.json     # durable stale-operation high-water mark
        └── journal.json   # exists only while apply or rollback is recoverable
```

Directories are `0700`; metadata, snapshots, and databases are `0600`. Metadata is strictly
versioned, size-bounded, exact-field decoded, project-bound, and path-scoped. Symbolic-link and
unsafe-permission storage paths fail closed. Environment values and ingress tokens never enter
these files. Start a provider entry point with `process.umask(0o077)`, as the packaged
`clank-runner` does. Database limits include an existing SQLite file plus its WAL and shared-memory
sidecars, so a large uncheckpointed journal cannot bypass the configured disk boundary.

### Database modes

| Mode | Snapshot | Behavior |
| --- | --- | --- |
| `initialize` | optional | Requires no committed generation or existing database. An optional seed snapshot is restored before migrations. |
| `preserve` | forbidden | Requires the currently committed database and migrates it in place behind a safety snapshot. |
| `replace` | required | Restores the supplied integrity-checked SQLite snapshot, then applies the release's migrations. |

The database path is bound to the release artifact and cannot change between committed
generations. Moving a database is an explicit export/delete/import operation, not a side effect of
a routine release. A database file found without committed provider metadata is never adopted or
overwritten implicitly; inspect it through an operator recovery workflow or remove it through the
confirmed project deletion path.

## Retry and crash behavior

`apply` serializes work per project in one provider process. The durable generation and fence make
exact retries idempotent: a repeated committed capsule runs the private validation callback with
`alreadyCommitted: true` and does not replay migrations. Before that callback, Clank walks the
stored immutable release and rechecks its exact file set, owners, modes, sizes, and SHA-256 values
against the capsule. A different capsule for the same generation or a changed stored release fails
as a conflict.

If validation starts a private candidate, pass the optional discard callback:

```ts
await data.apply(input, async (prepared) => {
  candidate = await runtimes.launch({
    prepared,
    signal: input.signal,
    deferBackground: true,
  });
}, async () => {
  if (candidate) {
    await runtimes.stop(candidate.projectId, candidate.generation);
  }
});
```

Clank invokes discard before restoring an uncommitted database whenever the prepared candidate
was exposed to validation. If cleanup fails, the database stays at the journaled intermediate
state and the operation fails closed. After the launcher removes the process, a later
`inspect`, `apply`, or snapshot safely completes journal recovery. Background workers should be
deferred until after apply commits; the complete provider service enforces both rules.

The journal makes the filesystem transaction restart-safe:

- before metadata commits, recovery restores the safety snapshot and removes the candidate;
- after metadata commits, recovery keeps the new database and finishes cleanup;
- an interrupted operator rollback restores the pre-rollback database while old metadata is
  active; and
- an already committed rollback finishes deleting only the generation it replaced.

`inspect`, `snapshot`, `rollback`, and the next `apply` recover an interrupted transaction before
returning. They also remove unreferenced staging, generation, and recovery entries. The state
rename is the commit point; a cleanup error can never roll database bytes back underneath new
metadata.

Use one writer process for a provider root. The in-process project mutex is not a distributed
filesystem lock. A stateful project must remain pinned to the provider node that owns its data, and
rolling provider replacement must stop the old writer before mounting that root in the new one.
Control-plane placement and ingress activation enforce that topology when the hosted integration
is enabled.

## Snapshot, rollback, and deletion

`snapshot(projectId)` uses SQLite's backup API, verifies and bounds the result, and returns bytes
plus their SHA-256, project, release, and generation binding. Send those bytes directly into an
encrypted [recovery repository](recovery.md); do not treat the immediate rollback snapshot as an
independent disaster-recovery backup.

```ts
const snapshot = await data.snapshot("orbit_tasks");

await data.rollback({
  projectId: "orbit_tasks",
  generation: 42,
  confirmation: "rollback orbit_tasks 42",
  fence: 87, // optional project-wide lifecycle fence
});

await data.delete({
  projectId: "orbit_tasks",
  confirmation: "delete orbit_tasks",
});
```

Rollback restores only the immediately preceding database/release and consumes that rollback
point. It requires the exact current generation and confirmation string, carries the latest fence
forward, and is itself journaled. A provider service supplies the optional project-wide operation
fence so restored state rejects every earlier writer; direct offline operator use may omit it.
Deletion recursively removes only the provider-owned project
root and requires an exact confirmation. Stop and revoke ingress before either operation; restore
and deletion do not coordinate public traffic themselves.

## Runtime launch and remaining hosted activation boundary

This package completes provider-side release staging, per-project SQLite
initialize/preserve/replace, migrations, consistent export, one-generation rollback, crash
recovery, and confirmed deletion. It deliberately does not launch untrusted code, publish routes,
issue TLS certificates, replicate recovery backups, or move a stateful project between nodes.

The package-supported [Provider Docker runtime](provider-docker-runtime.md) now binds this prepared
state to resource-bounded web, worker, and scheduler containers, private loopback health,
exact-owner orphan cleanup, and fail-closed restart reconciliation. The built-in control plane
still uses its local supervisor. The [complete deployment provider
service](provider-service.md) binds provider data, deferred Docker activation, durable
generation/fence intent, and private ingress end to end. Remote placement remains disabled until
the next integration binds that service to:

- atomic ingress publish/revoke with generation and token checks;
- durable provider-node pinning and rolling-update behavior;
- encrypted backup replication and restore drills; and
- end-to-end lease-loss, retry-after-commit, deletion, and traffic-switch tests.

Continue with [Remote runtime placement](runtime-placement.md), [Deployment provider
adapters](provider-adapters.md), [Provider runtime ingress](provider-runtime-ingress.md),
[Provider Docker runtime](provider-docker-runtime.md),
[Complete deployment provider service](provider-service.md),
[Managed ingress](data-plane.md), and [Backup and disaster recovery](recovery.md).
