export declare const DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL: "clank-provider-ingress/1";
export interface DeploymentRuntimeIngressBinding {
    readonly protocol: "clank-runtime/1";
    readonly projectId: string;
    readonly releaseId: string;
    readonly generation: number;
    /** Provider-local route selected by the runtime capsule. */
    readonly path: string;
    /** High-entropy route credential. Only its SHA-256 digest is retained. */
    readonly token: string;
    /** Loopback origin of the isolated application runtime. */
    readonly upstream: string;
}
export interface DeploymentRuntimeIngressState {
    readonly protocol: typeof DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL;
    readonly projectId: string;
    readonly releaseId: string;
    readonly generation: number;
    readonly path: string;
    readonly activatedAt: number;
    readonly inFlight: number;
    /** True for the highest accepted generation of this project. */
    readonly latest: boolean;
}
export interface DeploymentRuntimeIngressDeactivateResult {
    readonly removed: boolean;
    readonly drained: boolean;
}
export interface DeploymentRuntimeIngress {
    /** Atomically publishes a newer generation or idempotently accepts the exact current one. */
    activate(binding: DeploymentRuntimeIngressBinding): Promise<DeploymentRuntimeIngressState>;
    /** Returns active non-secret binding metadata. */
    inspect(): readonly DeploymentRuntimeIngressState[];
    /** Handles the private provider route called by Clank managed ingress. */
    handle(request: Request): Promise<Response>;
    /** Waits for requests already assigned to an exact generation. */
    drain(projectId: string, generation: number, timeoutMs?: number): Promise<boolean>;
    /**
     * Atomically revokes an exact generation, then drains its assigned requests.
     * A retry waits for an already-draining generation.
     */
    deactivate(projectId: string, generation: number, timeoutMs?: number): Promise<DeploymentRuntimeIngressDeactivateResult>;
    /**
     * Releases an inactive project's generation high-water mark after its
     * provider-owned state has been permanently deleted.
     */
    forget(projectId: string, generation: number): boolean;
    /** Revokes every route and drains outstanding requests. */
    close(timeoutMs?: number): Promise<boolean>;
}
export interface DeploymentRuntimeIngressOptions {
    fetch?: typeof fetch;
    /** Per-request deadline including bounded body intake. Defaults to 30 seconds. */
    timeoutMs?: number;
    /** Maximum request body forwarded to a runtime. Defaults to 25 MiB. */
    maxBodyBytes?: number;
    /** Maximum private request URL. Defaults to 8 KiB. */
    maxUrlLength?: number;
    /** Maximum tracked projects and combined published/draining generations. Defaults to 10,000. */
    maxBindings?: number;
    /** Receives private upstream failures. */
    onError?: (error: unknown) => void;
}
/**
 * Creates the provider-private hop between generation-bound managed ingress
 * and loopback application runtimes. This component publishes routes; it does
 * not launch processes or persist application secrets.
 */
export declare function createDeploymentRuntimeIngress(options?: DeploymentRuntimeIngressOptions): DeploymentRuntimeIngress;
