import type {
  DeploymentProviderDesiredState,
  DeploymentProviderOperation,
} from "./provider.js";
import type {
  DeploymentRuntimeCapsule,
  DeploymentRuntimeIngressManifest,
} from "./runtime-placement.js";
import type { DeploymentConfig } from "./deploy.js";

export declare const DEPLOYMENT_PROVIDER_DATA_PROTOCOL: "clank-provider-data/1";

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
  }): Promise<DeploymentProviderDataState | null>;
  delete(input: {
    projectId: string;
    confirmation: string;
  }): Promise<boolean>;
}

/**
 * Opens a private per-project SQLite and release lifecycle. The caller must
 * quiesce the current runtime and keep the prepared runtime unreachable until
 * apply resolves successfully.
 */
export declare function openDeploymentProviderDataStore(
  options: DeploymentProviderDataStoreOptions,
): Promise<DeploymentProviderDataStore>;
