import type { ObjectStore } from "./object-storage.js";
import type { BackupObjectRepositoryOptions } from "./recovery.js";
import type { EmailAddress, EmailService } from "./services.js";
import type { BillingProvider } from "./billing.js";
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
export type PlatformProjectPlacement = "local" | "provider";
export type PlatformQuotaKey = "organizationsPerAccount" | "projectsPerAccount" | "projectsPerOrganization" | "domainsPerProject" | "releasesPerProject" | "releaseStorageBytesPerProject" | "bucketStorageBytesPerProject" | "bucketObjectsPerProject" | "backupsPerProject" | "requestsPerMonthPerOrganization" | "transferBytesPerMonthPerOrganization" | "requestsPerMinutePerProject";
export type PlatformQuotaValues = Record<PlatformQuotaKey, number>;
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
    /** Maximum application bucket bytes across one project. Defaults to 5 GiB. */
    bucketStorageBytesPerProject?: number;
    /** Maximum application bucket objects across one project. Defaults to 100,000. */
    bucketObjectsPerProject?: number;
    /** Maximum admitted requests per UTC month in one workspace. Defaults to 5,000,000. */
    requestsPerMonthPerOrganization?: number;
    /** Maximum known ingress plus declared-response bytes per UTC month in one workspace. Defaults to 100 GiB. */
    transferBytesPerMonthPerOrganization?: number;
    /** Maximum admitted requests per project in one UTC minute. Defaults to 3,000. */
    requestsPerMinutePerProject?: number;
    /** Retention for monthly usage records. Defaults to 24 months. */
    usageRetentionMonths?: number;
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
export interface PlatformJobOperationsOptions {
    /**
     * A due job becomes an operator alert after waiting this long.
     * Defaults to 5 minutes.
     */
    alertDueAfterMs?: number;
}
export interface PlatformPreviewOptions {
    /** Default lifetime for a preview environment. Defaults to 7 days. */
    defaultTtlMs?: number;
    /** Longest lifetime a caller may request. Defaults to 30 days. */
    maxTtlMs?: number;
    /** Expired-preview cleanup cadence. Defaults to 5 minutes; false disables background cleanup. */
    cleanupIntervalMs?: number | false;
    /**
     * Optional fixed-endpoint transport for GitHub Actions OIDC signing keys.
     * The issuer, JWKS URL, algorithms, claims, and response bounds remain enforced.
     */
    githubOidcFetch?: typeof fetch;
}
export interface PlatformInvitationDeliveryOptions {
    email: EmailService;
    from: EmailAddress;
    replyTo?: EmailAddress;
    /** Longest idle poll interval. Defaults to 30 seconds. */
    intervalMs?: number;
    /** Invitations claimed by one pass. Defaults to 20. */
    batchSize?: number;
    /** Concurrent provider requests. Defaults to 2. */
    concurrency?: number;
    /** Initial retry delay. Defaults to 30 seconds. */
    retryBaseMs?: number;
    /** Maximum provider attempts. Defaults to 6. */
    maxAttempts?: number;
    /** Delivery-claim lifetime. Defaults to 60 seconds. */
    leaseMs?: number;
}
export interface PlatformBillingPlan {
    /** Stable public identifier persisted in subscription and audit records. */
    id: string;
    /** Human-readable plan name. */
    name: string;
    /** Short, plain-text description shown in the control plane. */
    description: string;
    /** Transparent recurring monthly price in the smallest currency unit. Zero denotes a free plan. */
    monthlyPrice: {
        currency: string;
        amount: number;
    };
    /** Account entitlements layered over the platform limits. */
    quotas: Partial<PlatformQuotaValues>;
    featured?: boolean;
}
export interface PlatformBillingOptions {
    /** Ordered public plan catalog. */
    plans: readonly PlatformBillingPlan[];
    /** Plan inherited by accounts without an active paid or operator-granted plan. */
    defaultPlanId: string;
    /** Optional hosted checkout, portal, and signed-webhook provider. */
    provider?: BillingProvider;
    /** Entitlement grace after first entering past_due. Defaults to 7 days. */
    pastDueGraceMs?: number;
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
        /** Legacy shared enrollment secret. Prefer managedEnrollment for new installations. */
        registrationToken?: string;
        /**
         * Enables administrator-created, node-and-region-bound enrollment tokens
         * that expire and can be used exactly once. Defaults to false.
         */
        managedEnrollment?: boolean;
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
        /**
         * Enables provider-hosted, stateful projects. Local placement remains
         * the default unless `default` is explicitly set to `provider`.
         */
        placement?: {
            default?: PlatformProjectPlacement;
            /** Optional region constraint for every provider-hosted project. */
            region?: string;
            /** Additional exact runner labels. `provider=http` is always required. */
            labels?: Record<string, string>;
            /**
             * Non-loopback provider hostnames that managed ingress may contact.
             * Provider origins outside this allowlist are never published.
             */
            allowedProviderHosts?: readonly string[];
            /** Time one deploy request waits for exact provider observation. Defaults to 2 minutes. */
            activationTimeoutMs?: number;
            /** Maximum generated runtime capsule. Defaults to 768 MiB. */
            maxRuntimeBytes?: number;
            /** Maximum provider SQLite snapshot. Defaults to 512 MiB. */
            maxDatabaseBytes?: number;
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
    jobs?: PlatformJobOperationsOptions;
    previews?: PlatformPreviewOptions;
    /**
     * Optional durable invitation-email delivery. Without it, invitation
     * creation preserves the copy-once token workflow.
     */
    invitations?: PlatformInvitationDeliveryOptions;
    /** Optional provider-neutral hosted plan catalog and billing integration. */
    billing?: PlatformBillingOptions;
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
