import {
  extractDeploymentBundle,
  type DeploymentConfig,
} from "./deploy.ts";
import {
  applyMigrations,
  backupSQLite,
  restoreSQLiteBackup,
} from "./migrations.ts";
import {
  type DeploymentProviderDesiredState,
  type DeploymentProviderOperation,
} from "./provider.ts";
import {
  decodeDeploymentRuntimeCapsule,
  deploymentRuntimeDigest,
  type DeploymentRuntimeCapsule,
  type DeploymentRuntimeIngressManifest,
} from "./runtime-placement.ts";

export const DEPLOYMENT_PROVIDER_DATA_PROTOCOL = "clank-provider-data/1";
const MAX_PROVIDER_DATABASE_BYTES =
  2 * 1024 * 1024 * 1024 - 2 * 1024 * 1024 - 100 * 1024 * 1024 - 32;

export interface DeploymentProviderDataStoreOptions {
  /** Private provider-owned root. One directory is created per project. */
  rootDirectory: string;
  /**
   * Maximum snapshot or resulting SQLite database. Defaults to 512 MiB and
   * remains below the runtime capsule's 2 GiB aggregate wire ceiling.
   */
  maxDatabaseBytes?: number;
}

export interface DeploymentProviderDataState {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_DATA_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly fence: number;
  readonly capsuleSha256: string;
  readonly databasePath: string;
  readonly releaseDirectory: string;
  readonly committedAt: number;
  readonly rollbackAvailable: boolean;
}

export interface PreparedDeploymentRuntimeData {
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly fence: number;
  readonly capsuleSha256: string;
  readonly releaseDirectory: string;
  readonly databasePath: string;
  /** Exact verified deployment config extracted from the runtime capsule. */
  readonly config: DeploymentConfig;
  /** Sensitive values are memory-only and must not be logged or persisted. */
  readonly environment: Readonly<Record<string, string>>;
  readonly ingress: DeploymentRuntimeIngressManifest;
  readonly migrationCount: number;
  readonly previous: DeploymentProviderDataState | null;
  readonly alreadyCommitted: boolean;
}

export interface DeploymentProviderDataApplyInput {
  readonly operation: DeploymentProviderOperation;
  readonly desired: DeploymentProviderDesiredState;
  readonly runtime: DeploymentRuntimeCapsule;
  readonly signal: AbortSignal;
}

export interface DeploymentProviderDataSnapshot {
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly databasePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface DeploymentProviderDataStore {
  /**
   * Stages code and data, applies migrations, then calls `validate` before
   * committing the generation. The current project runtime must already be
   * stopped or write-quiesced, and `validate` must not publish external traffic.
   */
  apply(
    input: DeploymentProviderDataApplyInput,
    validate: (prepared: PreparedDeploymentRuntimeData) => Promise<void>,
    /**
     * Quiesces anything started by `validate` before an uncommitted database
     * change is rolled back. If cleanup cannot be proven, recovery stays
     * journaled and fails closed for a later retry.
     */
    discard?: (
      prepared: PreparedDeploymentRuntimeData,
      reason: unknown,
    ) => Promise<void>,
  ): Promise<DeploymentProviderDataState>;
  inspect(projectId: string): Promise<DeploymentProviderDataState | null>;
  snapshot(projectId: string): Promise<DeploymentProviderDataSnapshot | null>;
  rollback(input: {
    projectId: string;
    generation: number;
    confirmation: string;
    /** Optional project-wide lifecycle fence carried into restored state. */
    fence?: number;
  }): Promise<DeploymentProviderDataState | null>;
  delete(input: {
    projectId: string;
    confirmation: string;
  }): Promise<boolean>;
}

interface ActiveRecord {
  projectId: string;
  releaseId: string;
  generation: number;
  fence: number;
  capsuleSha256: string;
  databasePath: string;
  releaseDirectory: string;
  committedAt: number;
}

interface RollbackRecord {
  databasePath: string;
  databaseExisted: boolean;
  snapshotPath: string | null;
}

interface StoredState {
  protocol: typeof DEPLOYMENT_PROVIDER_DATA_PROTOCOL;
  active: ActiveRecord;
  previous: ActiveRecord | null;
  rollback: RollbackRecord | null;
}

interface StoredFence {
  protocol: "clank-provider-data-fence/1";
  projectId: string;
  fence: number;
}

interface ApplyJournalRecord {
  protocol: "clank-provider-data-journal/1";
  kind: "apply";
  operationId: string;
  projectId: string;
  releaseId: string;
  generation: number;
  fence: number;
  capsuleSha256: string;
  databasePath: string;
  databaseExisted: boolean;
  safetySnapshotPath: string | null;
  stagingDirectory: string;
  releaseDirectory: string;
  supersededSnapshotPath: string | null;
  supersededReleaseDirectory: string | null;
  createdAt: number;
}

interface RollbackJournalRecord {
  protocol: "clank-provider-data-journal/1";
  kind: "rollback";
  operationId: string;
  projectId: string;
  generation: number;
  targetGeneration: number | null;
  databasePath: string;
  currentSnapshotPath: string;
  activeReleaseDirectory: string;
  targetDatabaseExisted: boolean;
  targetSnapshotPath: string | null;
  createdAt: number;
}

type JournalRecord = ApplyJournalRecord | RollbackJournalRecord;

interface ProjectPaths {
  projectId: string;
  project: string;
  data: string;
  generations: string;
  recovery: string;
  staging: string;
  state: string;
  fence: string;
  journal: string;
}

/**
 * Opens the provider-owned filesystem data lifecycle. This module never
 * stops or launches application code or publishes ingress; callers coordinate
 * those boundaries around `apply`.
 */
export async function openDeploymentProviderDataStore(
  options: DeploymentProviderDataStoreOptions,
): Promise<DeploymentProviderDataStore> {
  const fs = await nodeFs();
  const path = await nodePath();
  const root = path.resolve(nonEmpty(options.rootDirectory, "rootDirectory"));
  const projects = path.join(root, "projects");
  const maxDatabaseBytes = integer(
    options.maxDatabaseBytes ?? 512 * 1024 * 1024,
    "maxDatabaseBytes",
    1_024,
    MAX_PROVIDER_DATABASE_BYTES,
  );
  await ensureDirectory(fs, root);
  await ensureDirectory(fs, projects);
  const tails = new Map<string, Promise<void>>();

  const exclusive = async <Value>(
    projectId: string,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const prior = tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    tails.set(projectId, tail);
    await prior;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(projectId) === tail) tails.delete(projectId);
    }
  };

  const pathsFor = async (projectIdInput: string, create = true): Promise<ProjectPaths> => {
    const projectId = identifier(projectIdInput, "projectId");
    const project = path.join(projects, projectId);
    const locations = {
      projectId,
      project,
      data: path.join(project, "data"),
      generations: path.join(project, "generations"),
      recovery: path.join(project, "recovery"),
      staging: path.join(project, ".staging"),
      state: path.join(project, "state.json"),
      fence: path.join(project, "fence.json"),
      journal: path.join(project, "journal.json"),
    };
    if (create) {
      for (const directory of [
        locations.project,
        locations.data,
        locations.generations,
        locations.recovery,
        locations.staging,
      ]) {
        await ensureDirectory(fs, directory);
      }
    } else if (!await directoryExists(fs, project)) {
      return locations;
    } else {
      for (const directory of [
        locations.project,
        locations.data,
        locations.generations,
        locations.recovery,
        locations.staging,
      ]) {
        await requireDirectory(fs, directory);
      }
    }
    return locations;
  };

  const rollbackJournal = async (
    locations: ProjectPaths,
    journal: ApplyJournalRecord,
  ): Promise<void> => {
    const database = resolveRelative(path, locations.project, journal.databasePath);
    await requireDatabaseParent(fs, path, locations.data, database, false);
    if (journal.databaseExisted) {
      if (!journal.safetySnapshotPath) {
        throw new Error("Provider data journal is missing its safety snapshot.");
      }
      const safetySnapshot = resolveRelative(
        path,
        locations.project,
        journal.safetySnapshotPath,
      );
      await assertDatabaseBound(fs, safetySnapshot, maxDatabaseBytes);
      await restoreSQLiteBackup(
        safetySnapshot,
        database,
      );
    } else {
      await removeDatabaseFiles(fs, database);
    }
    await fs.rm(locations.journal, { force: true });
    await syncDirectory(fs, locations.project);
    await Promise.allSettled([
      fs.rm(resolveRelative(path, locations.project, journal.releaseDirectory), {
        recursive: true,
        force: true,
      }),
      fs.rm(resolveRelative(path, locations.project, journal.stagingDirectory), {
        recursive: true,
        force: true,
      }),
      ...(journal.safetySnapshotPath
        ? [
          fs.rm(resolveRelative(path, locations.project, journal.safetySnapshotPath), {
            force: true,
          }),
        ]
        : []),
    ]);
  };

  const finishRollbackJournal = async (
    locations: ProjectPaths,
    journal: RollbackJournalRecord,
  ): Promise<void> => {
    await fs.rm(
      resolveRelative(path, locations.project, journal.activeReleaseDirectory),
      { recursive: true, force: true },
    );
    if (journal.targetSnapshotPath) {
      await fs.rm(
        resolveRelative(path, locations.project, journal.targetSnapshotPath),
        { force: true },
      );
    }
    await fs.rm(
      resolveRelative(path, locations.project, journal.currentSnapshotPath),
      { force: true },
    );
    await fs.rm(locations.journal, { force: true });
    await syncDirectory(fs, locations.project);
  };

  const cancelRollbackJournal = async (
    locations: ProjectPaths,
    journal: RollbackJournalRecord,
  ): Promise<void> => {
    const database = resolveRelative(
      path,
      locations.project,
      journal.databasePath,
    );
    await requireDatabaseParent(fs, path, locations.data, database, false);
    const currentSnapshot = resolveRelative(
      path,
      locations.project,
      journal.currentSnapshotPath,
    );
    await assertDatabaseBound(fs, currentSnapshot, maxDatabaseBytes);
    await restoreSQLiteBackup(currentSnapshot, database);
    await fs.rm(locations.journal, { force: true });
    await syncDirectory(fs, locations.project);
    await fs.rm(currentSnapshot, { force: true }).catch(() => {});
  };

  const recoverJournal = async (
    locations: ProjectPaths,
    state: StoredState | null,
  ): Promise<void> => {
    const journal = await readJournal(fs, locations.journal);
    if (!journal) return;
    if (journal.projectId !== locations.projectId) {
      throw new Error("Provider data journal belongs to another project.");
    }
    if (journal.kind === "rollback") {
      const committed = journal.targetGeneration === null
        ? state === null
        : state?.active.generation === journal.targetGeneration;
      if (committed) {
        if (
          state
          && state.active.releaseDirectory === journal.activeReleaseDirectory
        ) {
          throw new Error("Provider rollback journal would remove the active release.");
        }
        await finishRollbackJournal(locations, journal);
        return;
      }
      if (!state || state.active.generation !== journal.generation) {
        throw new Error("Provider rollback journal conflicts with committed state.");
      }
      if (
        state.active.databasePath !== journal.databasePath
        || state.active.releaseDirectory !== journal.activeReleaseDirectory
        || (state.previous?.generation ?? null) !== journal.targetGeneration
        || state.rollback?.databaseExisted !== journal.targetDatabaseExisted
        || state.rollback?.snapshotPath !== journal.targetSnapshotPath
      ) {
        throw new Error("Provider rollback journal does not match committed state.");
      }
      await cancelRollbackJournal(locations, journal);
      return;
    }
    if (state && state.active.generation >= journal.generation) {
      if (
        state.active.projectId !== journal.projectId
        || state.active.generation !== journal.generation
        || state.active.releaseId !== journal.releaseId
        || state.active.capsuleSha256 !== journal.capsuleSha256
        || state.active.databasePath !== journal.databasePath
        || state.active.releaseDirectory !== journal.releaseDirectory
      ) {
        throw new Error("Provider apply journal conflicts with committed state.");
      }
      if (
        journal.safetySnapshotPath
        && state.rollback?.snapshotPath !== journal.safetySnapshotPath
      ) {
        await fs.rm(resolveRelative(path, locations.project, journal.safetySnapshotPath), {
          force: true,
        });
      }
      await fs.rm(resolveRelative(path, locations.project, journal.stagingDirectory), {
        recursive: true,
        force: true,
      });
      if (journal.supersededSnapshotPath) {
        await fs.rm(
          resolveRelative(path, locations.project, journal.supersededSnapshotPath),
          { force: true },
        );
      }
      if (journal.supersededReleaseDirectory) {
        await fs.rm(
          resolveRelative(path, locations.project, journal.supersededReleaseDirectory),
          { recursive: true, force: true },
        );
      }
      await fs.rm(locations.journal, { force: true });
      await syncDirectory(fs, locations.project);
      return;
    }
    await rollbackJournal(locations, journal);
  };

  const loadState = async (locations: ProjectPaths): Promise<StoredState | null> =>
    projectState(await readState(fs, locations.state), locations.projectId);
  const loadFence = async (locations: ProjectPaths): Promise<number> =>
    readFence(fs, locations.fence, locations.projectId);
  const recoverProject = async (locations: ProjectPaths): Promise<StoredState | null> => {
    const state = await loadState(locations);
    await recoverJournal(locations, state);
    const recovered = await loadState(locations);
    await pruneProjectStorage(fs, path, locations, recovered);
    return recovered;
  };

  const manager: DeploymentProviderDataStore = {
    async apply(input, validate, discard) {
      if (typeof validate !== "function") throw new TypeError("validate must be a function.");
      if (discard !== undefined && typeof discard !== "function") {
        throw new TypeError("discard must be a function.");
      }
      const operation = providerOperation(input.operation);
      if (!(input.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
      throwIfAborted(input.signal);
      const desired = providerDesiredState(input.desired);
      const runtime = await verifiedRuntime(input.runtime, maxDatabaseBytes);
      if (
        operation.projectId !== runtime.manifest.projectId
        || desired.state !== "running"
        || desired.runtimeProtocol !== runtime.manifest.protocol
        || desired.releaseId !== runtime.manifest.releaseId
        || desired.generation !== runtime.manifest.generation
      ) {
        throw new TypeError("Provider runtime does not match its operation and desired state.");
      }
      return exclusive(operation.projectId, async () => {
        const locations = await pathsFor(operation.projectId);
        let state = await recoverProject(locations);
        throwIfAborted(input.signal);
        const committedFence = await loadFence(locations);
        if (state && runtime.manifest.generation < state.active.generation) {
          throw new Error("Provider runtime generation is stale.");
        }
        if (state && runtime.manifest.generation === state.active.generation) {
          if (
            runtime.manifest.releaseId !== state.active.releaseId
            || runtime.sha256 !== state.active.capsuleSha256
          ) {
            throw new Error("Provider runtime generation conflicts with committed state.");
          }
          if (operation.fence < state.active.fence) {
            throw new Error("Provider runtime fence is stale.");
          }
          await verifyReleaseDirectory(
            fs,
            path,
            resolveRelative(
              path,
              locations.project,
              state.active.releaseDirectory,
            ),
            runtime,
          );
          const prepared = preparedData(
            path,
            locations,
            state.active,
            runtime,
            0,
            state.previous ? publicState(state.previous, false) : null,
            true,
          );
          try {
            await validate(prepared);
            throwIfAborted(input.signal);
            if (operation.fence > state.active.fence) {
              state = {
                ...state,
                active: { ...state.active, fence: operation.fence },
              };
              await atomicWriteJson(fs, path, locations.state, state);
              await writeFence(fs, path, locations, operation.fence);
            }
          } catch (error) {
            if (discard) {
              try {
                await discard(prepared, error);
              } catch (discardError) {
                throw new AggregateError(
                  [error, discardError],
                  "Provider runtime validation and candidate cleanup both failed.",
                );
              }
            }
            throw error;
          }
          return publicStoredState(state);
        }

        const databaseRelative = safeRelative(runtime.manifest.database.path, "database path");
        const database = resolveRelative(path, locations.data, databaseRelative);
        await requireDatabaseParent(fs, path, locations.data, database, true);
        const databaseProjectRelative = relativeFrom(path, locations.project, database);
        if (operation.fence <= Math.max(state?.active.fence ?? 0, committedFence)) {
          throw new Error("Provider runtime fence is stale.");
        }
        if (state && state.active.databasePath !== databaseProjectRelative) {
          throw new Error("Provider database path cannot change between generations.");
        }
        const databaseExists = await regularFileExists(fs, database);
        if (databaseExists) {
          await assertDatabaseFootprint(fs, database, maxDatabaseBytes);
        }
        if (!state && databaseExists) {
          throw new Error("Provider data exists without a committed generation.");
        }
        if (runtime.manifest.database.mode === "preserve") {
          if (!state || !databaseExists) {
            throw new Error("Preserved provider data has no committed generation.");
          }
        }
        if (runtime.manifest.database.mode === "initialize" && (state || databaseExists)) {
          throw new Error("Initialized provider data already exists.");
        }
        const releaseName = `g${runtime.manifest.generation}-${runtime.manifest.releaseId}`;
        const releaseDirectory = path.join(locations.generations, releaseName);
        if (await pathExists(fs, releaseDirectory)) {
          throw new Error("Provider release directory already exists without committed state.");
        }
        const transactionId = `${operation.id}-${operation.fence}-${crypto.randomUUID()}`;
        const stagingDirectory = path.join(locations.staging, transactionId);
        const stagedRelease = path.join(stagingDirectory, "release");
        const safetySnapshot = databaseExists
          ? path.join(locations.recovery, `${transactionId}.sqlite`)
          : null;
        try {
          await ensureDirectory(fs, stagingDirectory);
          await extractDeploymentBundle(runtime.artifact.bundle, stagedRelease);
          if (safetySnapshot) await backupSQLite(database, safetySnapshot);
        } catch (error) {
          await Promise.allSettled([
            fs.rm(stagingDirectory, { recursive: true, force: true }),
            ...(safetySnapshot
              ? [fs.rm(safetySnapshot, { force: true })]
              : []),
          ]);
          throw error;
        }
        const journal: ApplyJournalRecord = {
          protocol: "clank-provider-data-journal/1",
          kind: "apply",
          operationId: operation.id,
          projectId: operation.projectId,
          releaseId: runtime.manifest.releaseId,
          generation: runtime.manifest.generation,
          fence: operation.fence,
          capsuleSha256: runtime.sha256,
          databasePath: databaseProjectRelative,
          databaseExisted: databaseExists,
          safetySnapshotPath: safetySnapshot
            ? relativeFrom(path, locations.project, safetySnapshot)
            : null,
          stagingDirectory: relativeFrom(path, locations.project, stagingDirectory),
          releaseDirectory: relativeFrom(path, locations.project, releaseDirectory),
          supersededSnapshotPath: state?.rollback?.snapshotPath ?? null,
          supersededReleaseDirectory: state?.previous
            ? state.previous.releaseDirectory
            : null,
          createdAt: Date.now(),
        };
        try {
          await atomicWriteJson(fs, path, locations.journal, journal);
        } catch (error) {
          await fs.rm(stagingDirectory, { recursive: true, force: true });
          if (safetySnapshot) await fs.rm(safetySnapshot, { force: true });
          throw error;
        }

        let committed = false;
        let exposedPrepared: PreparedDeploymentRuntimeData | null = null;
        try {
          if (runtime.databaseSnapshot) {
            const incoming = path.join(locations.recovery, `${transactionId}.incoming.sqlite`);
            try {
              await writePrivateBytes(fs, incoming, runtime.databaseSnapshot);
              await restoreSQLiteBackup(incoming, database);
            } finally {
              await fs.rm(incoming, { force: true });
            }
          }
          throwIfAborted(input.signal);
          const migrationDirectory = resolveRelative(
            path,
            stagedRelease,
            safeRelative(runtime.artifact.bundle.config.database.migrations, "migrations path"),
          );
          const migrationPlan = await applyMigrations({
            path: database,
            directory: migrationDirectory,
            allowUnsafe: runtime.artifact.bundle.config.database.allowUnsafeMigrations,
          });
          await assertDatabaseFootprint(fs, database, maxDatabaseBytes);
          await fs.rename(stagedRelease, releaseDirectory);
          await syncDirectory(fs, locations.generations);
          await verifyReleaseDirectory(fs, path, releaseDirectory, runtime);
          const active: ActiveRecord = {
            projectId: operation.projectId,
            releaseId: runtime.manifest.releaseId,
            generation: runtime.manifest.generation,
            fence: operation.fence,
            capsuleSha256: runtime.sha256,
            databasePath: databaseProjectRelative,
            releaseDirectory: relativeFrom(path, locations.project, releaseDirectory),
            committedAt: Date.now(),
          };
          const prepared = preparedData(
            path,
            locations,
            active,
            runtime,
            migrationPlan.pending.length,
            state ? publicState(state.active, Boolean(state.rollback)) : null,
            false,
          );
          exposedPrepared = prepared;
          await validate(prepared);
          throwIfAborted(input.signal);
          const next: StoredState = {
            protocol: DEPLOYMENT_PROVIDER_DATA_PROTOCOL,
            active,
            previous: state?.active ?? null,
            rollback: {
              databasePath: databaseProjectRelative,
              databaseExisted: databaseExists,
              snapshotPath: safetySnapshot
                ? relativeFrom(path, locations.project, safetySnapshot)
                : null,
            },
          };
          await atomicWriteJson(fs, path, locations.state, next);
          committed = true;
          await writeFence(fs, path, locations, operation.fence);
          await recoverJournal(locations, next);
          return publicStoredState(next);
        } catch (error) {
          if (!committed) {
            if (discard && exposedPrepared) {
              try {
                await discard(exposedPrepared, error);
              } catch (discardError) {
                throw new AggregateError(
                  [error, discardError],
                  "Provider runtime candidate cleanup failed; database recovery remains journaled.",
                );
              }
            }
            try {
              await rollbackJournal(locations, journal);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Provider runtime data preparation and automatic rollback both failed.",
              );
            }
            throw error;
          }
          // The state rename is the commit point. Cleanup is recoverable and
          // must never roll the database back underneath committed metadata.
          try {
            await recoverJournal(locations, next);
          } catch {
            // A later inspect/apply/snapshot operation retries recovery.
          }
          return publicStoredState(next);
        }
      });
    },

    async inspect(projectIdInput) {
      const projectId = identifier(projectIdInput, "projectId");
      return exclusive(projectId, async () => {
        const locations = await pathsFor(projectId, false);
        if (!await directoryExists(fs, locations.project)) return null;
        const recovered = await recoverProject(locations);
        return recovered ? publicStoredState(recovered) : null;
      });
    },

    async snapshot(projectIdInput) {
      const projectId = identifier(projectIdInput, "projectId");
      return exclusive(projectId, async () => {
        const locations = await pathsFor(projectId, false);
        if (!await directoryExists(fs, locations.project)) return null;
        const recovered = await recoverProject(locations);
        if (!recovered) return null;
        const database = resolveRelative(
          path,
          locations.project,
          recovered.active.databasePath,
        );
        await requireDatabaseParent(fs, path, locations.data, database, false);
        await assertDatabaseFootprint(fs, database, maxDatabaseBytes);
        const temporary = path.join(
          locations.recovery,
          `snapshot-${crypto.randomUUID()}.sqlite`,
        );
        try {
          await backupSQLite(database, temporary);
          await assertDatabaseBound(fs, temporary, maxDatabaseBytes);
          const bytes = new Uint8Array(await fs.readFile(temporary));
          return Object.freeze({
            projectId,
            releaseId: recovered.active.releaseId,
            generation: recovered.active.generation,
            databasePath: safeRelative(
              path.relative(locations.data, database).replaceAll(path.sep, "/"),
              "database path",
            ),
            bytes,
            sha256: await digest(bytes),
          });
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    },

    async rollback(input) {
      const projectId = identifier(input.projectId, "projectId");
      const generation = positiveInteger(input.generation, "generation");
      const requestedFence = input.fence === undefined
        ? null
        : positiveInteger(input.fence, "fence");
      if (input.confirmation !== `rollback ${projectId} ${generation}`) {
        throw new TypeError(`confirmation must equal "rollback ${projectId} ${generation}".`);
      }
      return exclusive(projectId, async () => {
        const locations = await pathsFor(projectId, false);
        if (!await directoryExists(fs, locations.project)) return null;
        const current = await recoverProject(locations);
        if (!current) return null;
        if (current.active.generation !== generation) {
          throw new Error("Provider rollback generation is stale.");
        }
        if (!current.rollback) throw new Error("Provider rollback data is unavailable.");
        if (requestedFence !== null && requestedFence < current.active.fence) {
          throw new Error("Provider rollback fence is stale.");
        }
        const fence = requestedFence ?? current.active.fence;
        await writeFence(fs, path, locations, fence);
        const database = resolveRelative(
          path,
          locations.project,
          current.rollback.databasePath,
        );
        await requireDatabaseParent(fs, path, locations.data, database, false);
        await assertDatabaseFootprint(fs, database, maxDatabaseBytes);
        if (current.rollback.databaseExisted && !current.rollback.snapshotPath) {
          throw new Error("Provider rollback snapshot is unavailable.");
        }
        const currentSnapshot = path.join(
          locations.recovery,
          `rollback-${crypto.randomUUID()}.sqlite`,
        );
        await backupSQLite(database, currentSnapshot);
        const journal: RollbackJournalRecord = {
          protocol: "clank-provider-data-journal/1",
          kind: "rollback",
          operationId: crypto.randomUUID(),
          projectId,
          generation,
          targetGeneration: current.previous?.generation ?? null,
          databasePath: current.active.databasePath,
          currentSnapshotPath: relativeFrom(path, locations.project, currentSnapshot),
          activeReleaseDirectory: current.active.releaseDirectory,
          targetDatabaseExisted: current.rollback.databaseExisted,
          targetSnapshotPath: current.rollback.snapshotPath,
          createdAt: Date.now(),
        };
        try {
          await atomicWriteJson(fs, path, locations.journal, journal);
        } catch (error) {
          await fs.rm(currentSnapshot, { force: true });
          throw error;
        }
        let committed = false;
        try {
          if (journal.targetDatabaseExisted) {
            const targetSnapshot = resolveRelative(
              path,
              locations.project,
              journal.targetSnapshotPath!,
            );
            await assertDatabaseBound(fs, targetSnapshot, maxDatabaseBytes);
            await restoreSQLiteBackup(
              targetSnapshot,
              database,
            );
          } else {
            await removeDatabaseFiles(fs, database);
          }
          let restored: StoredState | null = null;
          if (current.previous) {
            restored = {
              protocol: DEPLOYMENT_PROVIDER_DATA_PROTOCOL,
              active: {
                ...current.previous,
                fence,
              },
              previous: null,
              rollback: null,
            };
            await atomicWriteJson(fs, path, locations.state, restored);
          } else {
            await fs.rm(locations.state, { force: true });
            await syncDirectory(fs, locations.project);
          }
          committed = true;
          await recoverJournal(locations, restored);
          return restored ? publicStoredState(restored) : null;
        } catch (error) {
          if (!committed) {
            try {
              await cancelRollbackJournal(locations, journal);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Provider rollback and its automatic recovery both failed.",
              );
            }
            throw error;
          }
          return current.previous
            ? publicState({
              ...current.previous,
              fence,
            }, false)
            : null;
        }
      });
    },

    async delete(input) {
      const projectId = identifier(input.projectId, "projectId");
      if (input.confirmation !== `delete ${projectId}`) {
        throw new TypeError(`confirmation must equal "delete ${projectId}".`);
      }
      return exclusive(projectId, async () => {
        const locations = await pathsFor(projectId, false);
        if (!await directoryExists(fs, locations.project)) return false;
        await requireDirectory(fs, locations.project);
        await fs.rm(locations.project, { recursive: true, force: false });
        await syncDirectory(fs, projects);
        return true;
      });
    },
  };
  return Object.freeze(manager);
}

async function verifiedRuntime(
  input: DeploymentRuntimeCapsule,
  maxDatabaseBytes: number,
): Promise<DeploymentRuntimeCapsule> {
  if (
    !input
    || !(input.bytes instanceof Uint8Array)
    || typeof input.sha256 !== "string"
    || await deploymentRuntimeDigest(input.bytes) !== input.sha256
  ) {
    throw new TypeError("Provider runtime capsule is invalid.");
  }
  return decodeDeploymentRuntimeCapsule(new Uint8Array(input.bytes), {
    maxDatabaseBytes,
    maxCapsuleBytes:
      2 * 1024 * 1024 + 100 * 1024 * 1024 + maxDatabaseBytes + 32,
  });
}

function preparedData(
  path: NodePath,
  locations: ProjectPaths,
  active: ActiveRecord,
  runtime: DeploymentRuntimeCapsule,
  migrationCount: number,
  previous: DeploymentProviderDataState | null,
  alreadyCommitted: boolean,
): PreparedDeploymentRuntimeData {
  return Object.freeze({
    projectId: active.projectId,
    releaseId: active.releaseId,
    generation: active.generation,
    fence: active.fence,
    capsuleSha256: active.capsuleSha256,
    releaseDirectory: resolveRelative(path, locations.project, active.releaseDirectory),
    databasePath: resolveRelative(path, locations.project, active.databasePath),
    config: runtime.artifact.bundle.config,
    environment: runtime.manifest.environment,
    ingress: runtime.manifest.ingress,
    migrationCount,
    previous,
    alreadyCommitted,
  });
}

function publicStoredState(state: StoredState): DeploymentProviderDataState {
  return publicState(state.active, Boolean(state.rollback));
}

function publicState(
  active: ActiveRecord,
  rollbackAvailable: boolean,
): DeploymentProviderDataState {
  return Object.freeze({
    protocol: DEPLOYMENT_PROVIDER_DATA_PROTOCOL,
    ...active,
    rollbackAvailable,
  });
}

async function readState(fs: NodeFs, filename: string): Promise<StoredState | null> {
  const value = await readPrivateJson(fs, filename);
  if (value === null) return null;
  const input = exactObject(value, ["protocol", "active", "previous", "rollback"], "provider data state");
  if (input.protocol !== DEPLOYMENT_PROVIDER_DATA_PROTOCOL) {
    throw new Error("Provider data state protocol is unsupported.");
  }
  return {
    protocol: DEPLOYMENT_PROVIDER_DATA_PROTOCOL,
    active: activeRecord(input.active),
    previous: input.previous === null ? null : activeRecord(input.previous),
    rollback: input.rollback === null ? null : rollbackRecord(input.rollback),
  };
}

async function readFence(
  fs: NodeFs,
  filename: string,
  projectId: string,
): Promise<number> {
  const value = await readPrivateJson(fs, filename);
  if (value === null) return 0;
  const input = exactObject(
    value,
    ["protocol", "projectId", "fence"],
    "provider data fence",
  );
  if (input.protocol !== "clank-provider-data-fence/1") {
    throw new Error("Provider data fence protocol is unsupported.");
  }
  if (identifier(input.projectId, "projectId") !== projectId) {
    throw new Error("Provider data fence belongs to another project.");
  }
  return positiveInteger(input.fence, "fence");
}

async function writeFence(
  fs: NodeFs,
  path: NodePath,
  locations: ProjectPaths,
  fence: number,
): Promise<void> {
  const prior = await readFence(fs, locations.fence, locations.projectId);
  if (fence < prior) throw new Error("Provider data fence cannot move backwards.");
  const value: StoredFence = {
    protocol: "clank-provider-data-fence/1",
    projectId: locations.projectId,
    fence,
  };
  await atomicWriteJson(fs, path, locations.fence, value);
}

async function readJournal(fs: NodeFs, filename: string): Promise<JournalRecord | null> {
  const value = await readPrivateJson(fs, filename);
  if (value === null) return null;
  const record = plainRecord(value, "provider data journal");
  const keys = record.kind === "apply"
    ? [
      "protocol",
      "kind",
      "operationId",
      "projectId",
      "releaseId",
      "generation",
      "fence",
      "capsuleSha256",
      "databasePath",
      "databaseExisted",
      "safetySnapshotPath",
      "stagingDirectory",
      "releaseDirectory",
      "supersededSnapshotPath",
      "supersededReleaseDirectory",
      "createdAt",
    ]
    : record.kind === "rollback"
      ? [
        "protocol",
        "kind",
        "operationId",
        "projectId",
        "generation",
        "targetGeneration",
        "databasePath",
        "currentSnapshotPath",
        "activeReleaseDirectory",
        "targetDatabaseExisted",
        "targetSnapshotPath",
        "createdAt",
      ]
      : [];
  if (keys.length === 0) throw new Error("Provider data journal kind is unsupported.");
  const input = exactObject(value, keys, "provider data journal");
  if (input.protocol !== "clank-provider-data-journal/1") {
    throw new Error("Provider data journal protocol is unsupported.");
  }
  if (input.kind === "rollback") {
    const journal: RollbackJournalRecord = {
      protocol: "clank-provider-data-journal/1",
      kind: "rollback",
      operationId: identifier(input.operationId, "operationId"),
      projectId: identifier(input.projectId, "projectId"),
      generation: positiveInteger(input.generation, "generation"),
      targetGeneration: input.targetGeneration === null
        ? null
        : positiveInteger(input.targetGeneration, "targetGeneration"),
      databasePath: scopedRelative(input.databasePath, "data", "database path"),
      currentSnapshotPath: directScopedRelative(
        input.currentSnapshotPath,
        "recovery",
        "current snapshot path",
      ),
      activeReleaseDirectory: directScopedRelative(
        input.activeReleaseDirectory,
        "generations",
        "active release directory",
      ),
      targetDatabaseExisted: boolean(
        input.targetDatabaseExisted,
        "targetDatabaseExisted",
      ),
      targetSnapshotPath: input.targetSnapshotPath === null
        ? null
        : directScopedRelative(
          input.targetSnapshotPath,
          "recovery",
          "target snapshot path",
        ),
      createdAt: positiveInteger(input.createdAt, "createdAt"),
    };
    if (
      (journal.targetGeneration !== null
        && journal.targetGeneration >= journal.generation)
      || !journal.activeReleaseDirectory.startsWith(
        `generations/g${journal.generation}-`,
      )
      || !/^recovery\/rollback-[0-9a-f-]{36}\.sqlite$/u.test(
        journal.currentSnapshotPath,
      )
      || journal.currentSnapshotPath === journal.targetSnapshotPath
    ) {
      throw new TypeError("Provider rollback journal bindings are invalid.");
    }
    return journal;
  }
  const journal: ApplyJournalRecord = {
    protocol: "clank-provider-data-journal/1",
    kind: "apply",
    operationId: identifier(input.operationId, "operationId"),
    projectId: identifier(input.projectId, "projectId"),
    releaseId: identifier(input.releaseId, "releaseId"),
    generation: positiveInteger(input.generation, "generation"),
    fence: positiveInteger(input.fence, "fence"),
    capsuleSha256: digestString(input.capsuleSha256),
    databasePath: scopedRelative(input.databasePath, "data", "database path"),
    databaseExisted: boolean(input.databaseExisted, "databaseExisted"),
    safetySnapshotPath: input.safetySnapshotPath === null
      ? null
      : directScopedRelative(input.safetySnapshotPath, "recovery", "safety snapshot path"),
    stagingDirectory: directScopedRelative(
      input.stagingDirectory,
      ".staging",
      "staging directory",
    ),
    releaseDirectory: directScopedRelative(
      input.releaseDirectory,
      "generations",
      "release directory",
    ),
    supersededSnapshotPath: input.supersededSnapshotPath === null
      ? null
      : directScopedRelative(
        input.supersededSnapshotPath,
        "recovery",
        "superseded snapshot path",
      ),
    supersededReleaseDirectory: input.supersededReleaseDirectory === null
      ? null
      : directScopedRelative(
        input.supersededReleaseDirectory,
        "generations",
        "superseded release directory",
      ),
    createdAt: positiveInteger(input.createdAt, "createdAt"),
  };
  const transaction = journal.stagingDirectory.slice(".staging/".length);
  if (
    journal.releaseDirectory
      !== `generations/g${journal.generation}-${journal.releaseId}`
    || !transaction.startsWith(`${journal.operationId}-${journal.fence}-`)
    || (
      journal.safetySnapshotPath
      && journal.safetySnapshotPath !== `recovery/${transaction}.sqlite`
    )
    || (
      journal.supersededSnapshotPath !== null
      && journal.supersededSnapshotPath === journal.safetySnapshotPath
    )
    || journal.supersededReleaseDirectory === journal.releaseDirectory
  ) {
    throw new TypeError("Provider apply journal bindings are invalid.");
  }
  return journal;
}

function activeRecord(value: unknown): ActiveRecord {
  const input = exactObject(value, [
    "projectId",
    "releaseId",
    "generation",
    "fence",
    "capsuleSha256",
    "databasePath",
    "releaseDirectory",
    "committedAt",
  ], "provider active state");
  const active = {
    projectId: identifier(input.projectId, "projectId"),
    releaseId: identifier(input.releaseId, "releaseId"),
    generation: positiveInteger(input.generation, "generation"),
    fence: positiveInteger(input.fence, "fence"),
    capsuleSha256: digestString(input.capsuleSha256),
    databasePath: scopedRelative(input.databasePath, "data", "database path"),
    releaseDirectory: directScopedRelative(
      input.releaseDirectory,
      "generations",
      "release directory",
    ),
    committedAt: positiveInteger(input.committedAt, "committedAt"),
  };
  if (
    active.releaseDirectory
    !== `generations/g${active.generation}-${active.releaseId}`
  ) {
    throw new TypeError("Provider release directory does not match its generation.");
  }
  return active;
}

function rollbackRecord(value: unknown): RollbackRecord {
  const input = exactObject(
    value,
    ["databasePath", "databaseExisted", "snapshotPath"],
    "provider rollback state",
  );
  return {
    databasePath: scopedRelative(input.databasePath, "data", "database path"),
    databaseExisted: boolean(input.databaseExisted, "databaseExisted"),
    snapshotPath: input.snapshotPath === null
      ? null
      : directScopedRelative(input.snapshotPath, "recovery", "snapshot path"),
  };
}

function projectState(state: StoredState | null, projectId: string): StoredState | null {
  if (
    state
    && (
      state.active.projectId !== projectId
      || (state.previous && state.previous.projectId !== projectId)
    )
  ) {
    throw new Error("Provider data state belongs to another project.");
  }
  if (
    state
    && (
      (state.previous && state.previous.generation >= state.active.generation)
      || (state.previous && state.previous.fence > state.active.fence)
      || (state.previous && state.previous.databasePath !== state.active.databasePath)
      || (state.rollback && state.rollback.databasePath !== state.active.databasePath)
      || (
        state.rollback
        && state.rollback.databaseExisted !== Boolean(state.rollback.snapshotPath)
      )
      || (
        state.rollback
        && state.rollback.databaseExisted !== Boolean(state.previous)
      )
    )
  ) {
    throw new Error("Provider data state relationships are inconsistent.");
  }
  return state;
}

function providerDesiredState(value: unknown): DeploymentProviderDesiredState {
  const input = exactObject(
    value,
    ["generation", "releaseId", "state", "runtimeProtocol"],
    "provider desired state",
  );
  const generation = positiveInteger(input.generation, "generation");
  const releaseId = input.releaseId === null
    ? null
    : identifier(input.releaseId, "releaseId");
  if (input.state !== "running" && input.state !== "stopped") {
    throw new TypeError("Provider desired state is invalid.");
  }
  if (input.runtimeProtocol !== "clank-runtime/1" && input.runtimeProtocol !== null) {
    throw new TypeError("Provider desired runtime protocol is invalid.");
  }
  if (
    (input.state === "running" && releaseId === null)
    || (input.state === "stopped" && releaseId !== null)
  ) {
    throw new TypeError("Provider desired release does not match its state.");
  }
  return Object.freeze({
    generation,
    releaseId,
    state: input.state,
    runtimeProtocol: input.runtimeProtocol,
  });
}

function providerOperation(value: unknown): DeploymentProviderOperation {
  const input = exactObject(
    value,
    ["id", "projectId", "fence", "attempt", "maxAttempts"],
    "provider operation",
  );
  return Object.freeze({
    id: identifier(input.id, "operationId"),
    projectId: identifier(input.projectId, "projectId"),
    fence: positiveInteger(input.fence, "fence"),
    attempt: positiveInteger(input.attempt, "attempt"),
    maxAttempts: positiveInteger(input.maxAttempts, "maxAttempts"),
  });
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const input = plainRecord(value, name);
  const expected = new Set(keys);
  if (Object.keys(input).some((key) => !expected.has(key))) {
    throw new TypeError(`${name} contains an unknown field.`);
  }
  if (keys.some((key) => !(key in input))) {
    throw new TypeError(`${name} is missing a required field.`);
  }
  return input;
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function resolveRelative(path: NodePath, root: string, relative: string): string {
  const safe = safeRelative(relative, "provider path");
  const target = path.resolve(root, ...safe.split("/"));
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new TypeError("Provider path escapes its project root.");
  }
  return target;
}

function relativeFrom(path: NodePath, root: string, target: string): string {
  return safeRelative(path.relative(root, target).replaceAll(path.sep, "/"), "provider path");
}

function safeRelative(value: unknown, name: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((segment) =>
      !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function scopedRelative(value: unknown, scope: string, name: string): string {
  const relative = safeRelative(value, name);
  if (!relative.startsWith(`${scope}/`)) {
    throw new TypeError(`${name} is outside its provider storage scope.`);
  }
  return relative;
}

function directScopedRelative(value: unknown, scope: string, name: string): string {
  const relative = scopedRelative(value, scope, name);
  if (relative.slice(scope.length + 1).includes("/")) {
    throw new TypeError(`${name} must be a direct provider storage child.`);
  }
  return relative;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function digestString(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Provider digest is invalid.");
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean.`);
  return value;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty path.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Provider data operation was aborted.");
}

async function readPrivateJson(fs: NodeFs, filename: string): Promise<unknown | null> {
  let handle: NodeFileHandle;
  try {
    handle = await fs.open(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return null;
    if (nodeCode(error) === "ELOOP") {
      throw new Error("Provider metadata must be a bounded regular file.");
    }
    throw error;
  }
  let encoded: string;
  try {
    const [stats, pathStats] = await Promise.all([
      handle.stat(),
      fs.lstat(filename),
    ]);
    if (
      pathStats.isSymbolicLink()
      || pathStats.dev !== stats.dev
      || pathStats.ino !== stats.ino
      || !stats.isFile()
      || stats.size > 64 * 1024
    ) {
      throw new Error("Provider metadata must be a bounded regular file.");
    }
    if ((stats.mode & 0o077) !== 0 || !ownedByCurrentUser(stats)) {
      throw new Error("Provider metadata permissions are unsafe.");
    }
    encoded = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(encoded);
  } catch {
    throw new Error("Provider metadata is invalid JSON.");
  }
}

async function atomicWriteJson(
  fs: NodeFs,
  path: NodePath,
  filename: string,
  value: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > 64 * 1024) throw new Error("Provider metadata exceeds 65536 bytes.");
  const temporary = `${filename}.tmp-${crypto.randomUUID()}`;
  try {
    await writePrivateBytes(fs, temporary, bytes);
    await fs.rename(temporary, filename);
    await syncDirectory(fs, path.dirname(filename));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function writePrivateBytes(
  fs: NodeFs,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filename, 0o600);
}

async function pruneProjectStorage(
  fs: NodeFs,
  path: NodePath,
  locations: ProjectPaths,
  state: StoredState | null,
): Promise<void> {
  const generationNames = new Set<string>();
  const recoveryNames = new Set<string>();
  if (state) {
    generationNames.add(pathName(state.active.releaseDirectory));
    if (state.previous) generationNames.add(pathName(state.previous.releaseDirectory));
    if (state.rollback?.snapshotPath) {
      recoveryNames.add(pathName(state.rollback.snapshotPath));
    }
  }
  await Promise.all([
    pruneOwnedDirectory(fs, path, locations.generations, generationNames),
    pruneOwnedDirectory(fs, path, locations.recovery, recoveryNames),
    pruneOwnedDirectory(fs, path, locations.staging, new Set()),
    pruneMetadataTemps(fs, path, locations.project),
  ]);
}

async function verifyReleaseDirectory(
  fs: NodeFs,
  path: NodePath,
  directory: string,
  runtime: DeploymentRuntimeCapsule,
): Promise<void> {
  const expected = new Map(
    runtime.artifact.bundle.files.map((file) => [file.path, file]),
  );
  const seen = new Set<string>();
  const visit = async (current: string): Promise<void> => {
    await requireDirectory(fs, current);
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relative = path.relative(directory, target).replaceAll(path.sep, "/");
      const safe = safeRelative(relative, "release path");
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) {
        throw new Error("Provider release symbolic links are not allowed.");
      }
      if (stats.isDirectory()) {
        await visit(target);
        continue;
      }
      const file = expected.get(safe);
      if (!file || !stats.isFile()) {
        throw new Error("Provider release contents do not match the runtime artifact.");
      }
      let handle: NodeFileHandle;
      try {
        handle = await fs.open(
          target,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
      } catch {
        throw new Error("Provider release contents do not match the runtime artifact.");
      }
      try {
        const [opened, current] = await Promise.all([
          handle.stat(),
          fs.lstat(target),
        ]);
        if (
          current.isSymbolicLink()
          || current.dev !== opened.dev
          || current.ino !== opened.ino
          || !opened.isFile()
          || !ownedByCurrentUser(opened)
          || opened.size !== file.size
          || (opened.mode & 0o777) !== file.mode
        ) {
          throw new Error("Provider release contents do not match the runtime artifact.");
        }
        const bytes = new Uint8Array(await handle.readFile());
        if (await digest(bytes) !== file.sha256) {
          throw new Error("Provider release contents do not match the runtime artifact.");
        }
      } finally {
        await handle.close();
      }
      seen.add(safe);
    }
  };
  await visit(directory);
  if (seen.size !== expected.size) {
    throw new Error("Provider release contents do not match the runtime artifact.");
  }
}

async function pruneOwnedDirectory(
  fs: NodeFs,
  path: NodePath,
  directory: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => !keep.has(entry.name))
    .map((entry) =>
      fs.rm(path.join(directory, entry.name), {
        recursive: true,
        force: true,
      })
    ));
}

async function pruneMetadataTemps(
  fs: NodeFs,
  path: NodePath,
  project: string,
): Promise<void> {
  const entries = await fs.readdir(project, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) =>
      /^(?:state|fence|journal)\.json\.tmp-[0-9a-f-]{36}$/u.test(entry.name)
    )
    .map((entry) =>
      fs.rm(path.join(project, entry.name), { force: true })
    ));
}

async function requireDatabaseParent(
  fs: NodeFs,
  path: NodePath,
  root: string,
  database: string,
  create: boolean,
): Promise<void> {
  await requireDirectory(fs, root);
  const parent = path.dirname(database);
  const relative = path.relative(root, parent).replaceAll(path.sep, "/");
  if (!relative) return;
  const safe = safeRelative(relative, "database parent");
  let cursor = root;
  for (const segment of safe.split("/")) {
    cursor = path.join(cursor, segment);
    if (create) {
      try {
        await fs.mkdir(cursor, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (nodeCode(error) !== "EEXIST") throw error;
      }
    }
    await requireDirectory(fs, cursor);
  }
}

function pathName(relative: string): string {
  return relative.slice(relative.lastIndexOf("/") + 1);
}

async function ensureDirectory(fs: NodeFs, directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectory(fs, directory);
  await fs.chmod(directory, 0o700);
}

async function requireDirectory(fs: NodeFs, directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Provider storage paths must be real directories.");
  }
  if ((stats.mode & 0o077) !== 0 || !ownedByCurrentUser(stats)) {
    throw new Error("Provider storage directory permissions are unsafe.");
  }
}

async function directoryExists(fs: NodeFs, directory: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink()) throw new Error("Provider storage symbolic links are not allowed.");
    if (!stats.isDirectory()) {
      throw new Error("Provider storage path exists but is not a directory.");
    }
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function regularFileExists(fs: NodeFs, filename: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filename);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Provider database must be a regular file.");
    }
    if ((stats.mode & 0o077) !== 0 || !ownedByCurrentUser(stats)) {
      throw new Error("Provider database permissions are unsafe.");
    }
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(fs: NodeFs, filename: string): Promise<boolean> {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertDatabaseBound(
  fs: NodeFs,
  filename: string,
  maximum: number,
): Promise<void> {
  const stats = await fs.lstat(filename);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size > maximum
    || (stats.mode & 0o077) !== 0
    || !ownedByCurrentUser(stats)
  ) {
    throw new Error(`Provider database exceeds ${maximum} bytes or is not a regular file.`);
  }
}

async function assertDatabaseFootprint(
  fs: NodeFs,
  filename: string,
  maximum: number,
): Promise<void> {
  await assertDatabaseBound(fs, filename, maximum);
  let total = (await fs.lstat(filename)).size;
  for (const sidecar of [`${filename}-wal`, `${filename}-shm`]) {
    let stats: NodeStats;
    try {
      stats = await fs.lstat(sidecar);
    } catch (error) {
      if (nodeCode(error) === "ENOENT") continue;
      throw error;
    }
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || (stats.mode & 0o077) !== 0
      || !ownedByCurrentUser(stats)
    ) {
      throw new Error("Provider database sidecar is unsafe.");
    }
    total += stats.size;
    if (!Number.isSafeInteger(total) || total > maximum) {
      throw new Error(`Provider database footprint exceeds ${maximum} bytes.`);
    }
  }
}

async function removeDatabaseFiles(fs: NodeFs, filename: string): Promise<void> {
  await Promise.all([
    fs.rm(filename, { force: true }),
    fs.rm(`${filename}-wal`, { force: true }),
    fs.rm(`${filename}-shm`, { force: true }),
  ]);
}

async function syncDirectory(fs: NodeFs, directory: string): Promise<void> {
  let handle: NodeFileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync. File fsync and atomic
    // rename still preserve the protocol; operators should use durable disks.
  } finally {
    await handle?.close();
  }
}

async function digest(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function ownedByCurrentUser(stats: NodeStats): boolean {
  const process = (globalThis as any).process;
  const getUid = process?.getuid;
  return typeof getUid !== "function"
    || stats.uid === Number(getUid.call(process));
}

interface NodeStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface NodeFileHandle {
  readFile(): Promise<Uint8Array>;
  readFile(options: { encoding: "utf8" }): Promise<string>;
  stat(): Promise<NodeStats>;
  writeFile(value: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface NodeFs {
  constants: {
    O_RDONLY: number;
    O_NOFOLLOW?: number;
  };
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<NodeStats>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  open(path: string, flags: string | number, mode?: number): Promise<NodeFileHandle>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string }>>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: boolean; recursive?: boolean }): Promise<void>;
}

interface NodePath {
  dirname(path: string): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

async function nodeFs(): Promise<NodeFs> {
  const name = "node:fs/promises";
  return import(name) as unknown as Promise<NodeFs>;
}

async function nodePath(): Promise<NodePath> {
  const name = "node:path";
  return import(name) as unknown as Promise<NodePath>;
}
