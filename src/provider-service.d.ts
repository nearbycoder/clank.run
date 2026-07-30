import type {
  DeploymentProviderDataState,
  DeploymentProviderDataSnapshot,
  DeploymentProviderDataStore,
  DeploymentProviderDataStoreOptions,
} from "./provider-data.js";
import type {
  DockerDeploymentRuntimeDiagnostics,
  DockerDeploymentRuntimeLauncher,
  DockerDeploymentRuntimeLauncherOptions,
} from "./provider-docker.js";
import type {
  DeploymentRuntimeIngress,
  DeploymentRuntimeIngressOptions,
} from "./provider-runtime.js";
import type {
  DeploymentProvider,
  DeploymentProviderLifecycleRequest,
} from "./provider.js";

export declare const DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL: "clank-provider-service/1";
export declare const DEPLOYMENT_PROVIDER_CONTROL_PREFIX: "/v1/clank/control";
export declare const DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE: "application/vnd.clank.provider-snapshot";
export declare const DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE: "application/vnd.clank.provider-diagnostics+json";

export interface DeploymentProviderServiceState {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL;
  readonly projectId: string;
  readonly operationId: string;
  readonly fence: number;
  readonly generation: number;
  readonly state: "running" | "stopped";
  readonly releaseId: string | null;
  readonly capsuleSha256: string | null;
  readonly phase:
    | "reconciling"
    | "running"
    | "stopped"
    | "rolling-back"
    | "rolled-back"
    | "deleting";
  readonly updatedAt: number;
}

export type DeploymentProviderServiceLifecycleRequest =
  DeploymentProviderLifecycleRequest;

export interface DeploymentProviderServiceOptions {
  /** Existing private provider root shared by the injected data and runtime components. */
  rootDirectory: string;
  data: DeploymentProviderDataStore;
  runtimes: DockerDeploymentRuntimeLauncher;
  ingress: DeploymentRuntimeIngress;
  /** Stable provider kind reported to the coordinator. Defaults to `docker`. */
  kind?: string;
  /** Maximum route drain before reconciliation fails closed. Defaults to 30 seconds. */
  drainTimeoutMs?: number;
  /** Runtime database/snapshot verification bound. Defaults to 512 MiB. */
  maxDatabaseBytes?: number;
  /** Receives non-secret cleanup and infrastructure diagnostics. */
  onError?: (error: unknown) => void;
}

export interface DockerDeploymentProviderServiceOptions {
  rootDirectory: string;
  owner: string;
  image: string;
  kind?: string;
  drainTimeoutMs?: number;
  data?: Omit<DeploymentProviderDataStoreOptions, "rootDirectory">;
  docker?: Omit<
    DockerDeploymentRuntimeLauncherOptions,
    "rootDirectory" | "owner" | "image"
  >;
  ingress?: DeploymentRuntimeIngressOptions;
  /** Default private diagnostic hook used by every component. */
  onError?: (error: unknown) => void;
}

export interface DeploymentProviderService extends DeploymentProvider {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL;
  /** Handles provider-private runtime ingress plus authenticated control routes. */
  handle(request: Request): Promise<Response>;
  /** Reads durable, non-secret desired-state progress for one project. */
  inspect(projectId: string): Promise<DeploymentProviderServiceState | null>;
  /** Creates a consistent provider-data snapshot for external encrypted backup. */
  snapshot(projectId: string): Promise<DeploymentProviderDataSnapshot | null>;
  /** Returns bounded live output and resource attribution for one runtime. */
  diagnostics(
    projectId: string,
    logLimit?: number,
  ): Promise<DockerDeploymentRuntimeDiagnostics | null>;
  /** Drains every writer and restores the immediate provider-data predecessor. */
  rollback(
    request: DeploymentProviderServiceLifecycleRequest,
  ): Promise<DeploymentProviderDataState | null>;
  /** Drains every writer and permanently removes provider-owned project state. */
  delete(request: DeploymentProviderServiceLifecycleRequest): Promise<boolean>;
  /** Revokes traffic, drains requests, stops runtimes, and closes the service. */
  close(): Promise<void>;
}

/**
 * Composes provider data, an isolated Docker launcher, and private ingress into
 * one fenced desired-state provider.
 */
export declare function openDeploymentProviderService(
  options: DeploymentProviderServiceOptions,
): Promise<DeploymentProviderService>;

/** Opens the complete zero-dependency Docker provider stack with secure defaults. */
export declare function openDockerDeploymentProviderService(
  options: DockerDeploymentProviderServiceOptions,
): Promise<DeploymentProviderService>;

/** Returns the exact provider-private consistent snapshot path for one project. */
export declare function deploymentProviderSnapshotPath(projectId: string): string;

/** Returns the exact provider-private diagnostics path for one project. */
export declare function deploymentProviderDiagnosticsPath(projectId: string): string;
