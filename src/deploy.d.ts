export interface DeployHealthConfig {
    path: string;
    timeoutMs: number;
}
export interface DeployDatabaseConfig {
    path: string;
    migrations: string;
    allowUnsafeMigrations: boolean;
    /** Trusted production policy for opt-in sanitized preview data branches. */
    previewData?: DeployPreviewDataConfig;
}
export type DeployPreviewDataTransform = "keep" | "hash" | "redact" | "email";
export interface DeployPreviewJsonTransform {
    json: {
        /** Applied to every JSON leaf not named in paths. Defaults to hash. */
        default?: DeployPreviewDataTransform;
        /** JSON Pointer to transform overrides. */
        paths?: Record<string, DeployPreviewDataTransform>;
    };
}
export interface DeployPreviewDataTableConfig {
    /** Deterministically retain at most this many rows. Defaults to 1,000. */
    rows?: number;
    /** Column overrides. Text/blob columns default to hash; numeric values remain structural. */
    columns?: Record<string, DeployPreviewDataTransform | DeployPreviewJsonTransform>;
}
export interface DeployPreviewDataConfig {
    /** Only named tables retain rows; every other non-framework table is emptied. */
    tables: Record<string, DeployPreviewDataTableConfig>;
}
export interface DeployBuildConfig {
    command: readonly string[];
}
export interface DeployJobsConfig {
    entry: string;
    workers: number;
    concurrency: number;
    queues: readonly string[];
    scheduler: boolean;
}
export interface DeploymentConfig {
    version: 1;
    entry: string;
    include: readonly string[];
    build?: DeployBuildConfig;
    database: DeployDatabaseConfig;
    health: DeployHealthConfig;
    env: Record<string, string>;
    jobs?: DeployJobsConfig;
}
export interface DeploymentFile {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mode: 0o600 | 0o644 | 0o700 | 0o755;
    readonly content: string;
}
export interface DeploymentBundle {
    readonly protocol: "clank-deploy/1";
    readonly config: DeploymentConfig;
    readonly provenance: {
        readonly builder: "clank-cli/1";
        readonly frameworkVersion: string;
        readonly nodeVersion: string;
        readonly sourceRevision?: string;
        readonly configurationSha256?: string;
        readonly materialsSha256?: string;
        readonly migrationIds?: readonly string[];
    };
    readonly files: DeploymentFile[];
}
export interface BundleLimits {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
}
export interface CreateDeploymentBundleOptions extends BundleLimits {
    frameworkRoot?: string;
    frameworkVersion?: string;
    nodeVersion?: string;
    sourceRevision?: string;
}
/** Reads and strictly validates the transparent deployment contract. */
export declare function readDeploymentConfig(root: string, filename?: string): Promise<DeploymentConfig>;
export declare function parseDeploymentConfig(value: unknown): DeploymentConfig;
/** Creates a deterministic gzip artifact whose files are individually checksummed. */
export declare function createDeploymentBundle(root: string, config: DeploymentConfig, options?: CreateDeploymentBundleOptions): Promise<Uint8Array>;
/** Validates a deployment artifact before any file is written or code is executed. */
export declare function decodeDeploymentBundle(bytes: Uint8Array, limits?: BundleLimits): Promise<DeploymentBundle>;
/** Extracts an already validated bundle into a new release directory. */
export declare function extractDeploymentBundle(bundle: DeploymentBundle, directory: string): Promise<void>;
export declare function deploymentDigest(bytes: Uint8Array): Promise<string>;
