import type { PreparedDeploymentRuntimeData } from "./provider-data.js";

export declare const DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL: "clank-provider-docker/1";

export interface DockerDeploymentRuntimeLauncherOptions {
    /** Same private provider root passed to openDeploymentProviderDataStore(). */
    rootDirectory: string;
    /** Unique owner label for this provider process. */
    owner: string;
    /** Immutable application image reference. Mutable tags are refused by default. */
    image: string;
    executable?: string;
    /**
     * Additional operator-controlled Docker client variables. Capsule
     * environment values are never copied here.
     */
    dockerEnvironment?: Readonly<Record<string, string>>;
    /** Allow a mutable image tag. Defaults to false. */
    allowMutableImage?: boolean;
    /** Explicit container uid:gid. Defaults to the non-root provider process uid:gid. */
    user?: string;
    /** Explicitly allow uid 0 in the application container. Defaults to false. */
    allowContainerRoot?: boolean;
    /** Docker network selected by the operator. Defaults to bridge. */
    network?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    /** First provider-local application port. Defaults to 46,000. */
    portStart?: number;
    /** Last provider-local application port. Defaults to 49,999. */
    portEnd?: number;
    /** Maximum simultaneous project runtimes. Defaults to 100. */
    maxRuntimes?: number;
    /** Maximum combined web/worker/scheduler containers. Defaults to maxRuntimes × 4. */
    maxContainers?: number;
    /** Docker CLI deadline. Defaults to 15 seconds. */
    commandTimeoutMs?: number;
    /** Graceful container stop deadline. Defaults to 10 seconds. */
    stopTimeoutMs?: number;
    fetch?: typeof fetch;
    /** Receives non-secret infrastructure failures and unexpected exits. */
    onError?: (error: unknown) => void;
}

export interface DockerDeploymentRuntimeLaunchInput {
    readonly prepared: PreparedDeploymentRuntimeData;
    readonly signal: AbortSignal;
    /**
     * Start only the private web candidate. Background workers and the scheduler
     * are retained as a memory-only activation plan until `activate()`.
     */
    readonly deferBackground?: boolean;
}

export interface DockerDeploymentRuntimeCandidate {
    readonly protocol: typeof DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL;
    readonly projectId: string;
    readonly releaseId: string;
    readonly generation: number;
    readonly capsuleSha256: string;
    readonly upstream: string;
}

export interface DockerDeploymentRuntimeState extends DockerDeploymentRuntimeCandidate {
    readonly status: "candidate" | "active" | "failed";
    readonly port: number;
    readonly containers: number;
    readonly launchedAt: number;
}

export interface DockerDeploymentRuntimeLauncher {
    /**
     * Launches and health-checks an ingress-private candidate. The environment
     * is delivered through container stdin and is not retained by the launcher.
     */
    launch(input: DockerDeploymentRuntimeLaunchInput): Promise<DockerDeploymentRuntimeCandidate>;
    /**
     * Starts a deferred candidate's background topology and atomically marks the
     * complete runtime active. Exact retries are idempotent.
     */
    activate(candidate: DockerDeploymentRuntimeCandidate, signal: AbortSignal): Promise<DockerDeploymentRuntimeState>;
    /** Marks an exact healthy candidate active after provider data commits. */
    commit(candidate: DockerDeploymentRuntimeCandidate): DockerDeploymentRuntimeState;
    /** Returns non-secret in-memory runtime metadata. */
    inspect(): readonly DockerDeploymentRuntimeState[];
    /** Gracefully stops one exact generation, or the project's current generation. */
    stop(projectId: string, generation?: number): Promise<boolean>;
    /**
     * Releases an inactive generation high-water mark after permanent provider
     * data deletion.
     */
    forget(projectId: string, generation: number): boolean;
    /** Stops tracked runtimes, removes scoped orphans, and rejects new work. */
    close(): Promise<void>;
}

/**
 * Opens a Docker runtime launcher that cleans exact-owner orphans before
 * accepting desired-state reconciliation.
 */
export declare function openDockerDeploymentRuntimeLauncher(
    options: DockerDeploymentRuntimeLauncherOptions,
): Promise<DockerDeploymentRuntimeLauncher>;
