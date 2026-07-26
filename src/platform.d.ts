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
}
export interface ClankPlatformOptions {
    dataDirectory: string;
    publicUrl: string;
    appHostname?: string;
    /** Public application URL pattern. Supports {slug} and {port}. */
    appUrlTemplate?: string;
    appPortStart?: number;
    appPortEnd?: number;
    runner?: PlatformRunnerOptions;
    /** Defaults to "bootstrap": only the first platform account may self-register. */
    signup?: boolean | "bootstrap";
    masterKey?: string | Uint8Array;
    maxArtifactBytes?: number;
    /** Operator-only escape hatch for configs that request unrestricted SQLite SQL. */
    allowUnsafeMigrations?: boolean;
    deviceCodeLifetimeMs?: number;
    accessTokenLifetimeMs?: number;
    limits?: PlatformLimits;
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
    close(): Promise<void>;
}
/** Opens Clank's self-hostable deployment control plane and release supervisor. */
export declare function openPlatform(options: ClankPlatformOptions): Promise<PlatformRuntime>;
