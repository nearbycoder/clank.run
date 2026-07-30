import type { ObjectStore } from "./object-storage.js";
import type { BackupObjectRepositoryOptions } from "./recovery.js";
export interface ProcessRunnerOptions {
    kind?: "process";
}
export interface DockerRunnerOptions {
    kind: "docker";
    executable?: string;
    image?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
}
export type PlatformRunnerOptions = ProcessRunnerOptions | DockerRunnerOptions;
export type PlatformHostingProfile = "trusted" | "isolated";
export interface PlatformLimits {
    /** Maximum organizations created by one account. Defaults to 5. */
    organizationsPerAccount?: number;
    /** Maximum sites created by one account across all organizations. Defaults to 10. */
    projectsPerAccount?: number;
    /** Maximum sites in one organization. Defaults to 10. */
    projectsPerOrganization?: number;
    /** Maximum custom domains attached to one site. Defaults to 5. */
    domainsPerProject?: number;
    /** Retention for minute-level ingress metrics. Defaults to 30 days. */
    metricRetentionDays?: number;
    /** Maximum retained release artifacts per project. Defaults to 50. */
    releasesPerProject?: number;
    /** Maximum retained release and pre-deploy snapshot bytes per project. Defaults to 20 GiB. */
    releaseStorageBytesPerProject?: number;
}
export interface PlatformBackupOptions {
    /** Encrypted backup cadence. Defaults to 24 hours; false disables automatic backups. */
    intervalMs?: number | false;
    /** Maximum projects claimed by one backup pass. Defaults to 5. */
    batchSize?: number;
    /** Maximum retained backups per project. Defaults to 30. */
    maxBackups?: number;
    /** Maximum backup age. Defaults to 90 days. */
    maxAgeMs?: number;
    /** Maximum source database size accepted by the backup engine. Defaults to 10 GiB. */
    maxDatabaseBytes?: number;
    /**
     * Optional off-host repository for encrypted backups. Each project receives
     * an isolated catalog and chunk namespace automatically.
     */
    objects?: Omit<BackupObjectRepositoryOptions, "repositoryId">;
}
export interface ClankPlatformOptions {
    dataDirectory: string;
    publicUrl: string;
    /** Recover active application processes before returning, or concurrently after startup. Defaults to "blocking". */
    startupRecovery?: "blocking" | "background";
    /** Exact control-plane account emails granted operator-level administration. */
    platformAdminEmails?: readonly string[];
    appHostname?: string;
    /** Public application URL pattern. Supports {slug} and {port}. */
    appUrlTemplate?: string;
    appPortStart?: number;
    appPortEnd?: number;
    /** Listener or infrastructure ports that application runtimes must never use. */
    reservedAppPorts?: readonly number[];
    /**
     * Declares the application-code trust boundary. "isolated" requires the
     * Docker runner. Defaults from the selected runner for programmatic callers.
     */
    hostingProfile?: PlatformHostingProfile;
    runner?: PlatformRunnerOptions;
    /**
     * Enables the authenticated remote deployment-node coordination API.
     * Omit it to keep every runner endpoint closed.
     */
    deploymentAgents?: {
        registrationToken: string;
        maxRequestBytes?: number;
        /** Maximum content-addressed release transferred to a current node lease. */
        maxArtifactBytes?: number;
        /**
         * Optional provider-neutral repository for original release uploads.
         * Omit it to retain owner-only files under dataDirectory.
         */
        artifacts?: {
            /**
             * Stable operator-selected repository identity persisted with each release.
             * Changing it does not silently reinterpret objects from an older store.
             */
            namespace: string;
            store: ObjectStore;
        };
    };
    /** Defaults to "bootstrap": only the first platform account may self-register. */
    signup?: boolean | "bootstrap";
    masterKey?: string | Uint8Array;
    maxArtifactBytes?: number;
    /** Operator-only escape hatch for configs that request unrestricted SQLite SQL. */
    allowUnsafeMigrations?: boolean;
    deviceCodeLifetimeMs?: number;
    accessTokenLifetimeMs?: number;
    limits?: PlatformLimits;
    backups?: PlatformBackupOptions;
    ingress?: {
        enabled?: boolean;
        baseDomain?: string;
        /** CNAME target shown to custom-domain owners. Defaults to baseDomain. */
        customDomainTarget?: string;
        /** Edge IPv4/IPv6 values accepted for apex/flattened DNS. */
        customDomainAddresses?: readonly string[];
        /** Secret embedded in the private Caddy on-demand TLS permission URL. */
        tlsAskToken?: string;
        timeoutMs?: number;
        maxBodyBytes?: number;
        resolveTxt?: (hostname: string) => Promise<readonly (readonly string[])[]>;
        resolveCname?: (hostname: string) => Promise<readonly string[]>;
        resolve4?: (hostname: string) => Promise<readonly string[]>;
        resolve6?: (hostname: string) => Promise<readonly string[]>;
        /** Refresh custom-domain routing in the background. Defaults to 5 minutes; false disables it. */
        domainRecheckIntervalMs?: number | false;
        /** Maximum domains claimed by one reconciliation pass. Defaults to 25. */
        domainRecheckBatchSize?: number;
        /** Maximum time spent on one domain before its claim is released. Defaults to 10 seconds. */
        domainRecheckTimeoutMs?: number;
    };
    /** Receives unexpected failures for private operator logging. */
    onError?: (error: unknown) => void;
}
export interface PlatformRuntime {
    readonly handle: (request: Request) => Promise<Response>;
    readonly publicUrl: string;
    readonly dataDirectory: string;
    readonly hostingProfile: PlatformHostingProfile;
    readonly runnerKind: "process" | "docker";
    close(): Promise<void>;
}
/** Opens Clank's self-hostable deployment control plane and release supervisor. */
export declare function openPlatform(options: ClankPlatformOptions): Promise<PlatformRuntime>;
