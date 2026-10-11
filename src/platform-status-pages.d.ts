import type { SQLiteInternal } from "./sqlite-internal.js";
import type { CustomerStatusCopy, CustomerStatusPage, CustomerStatusSnapshot, CustomerStatusPreferences, CustomerStatusNotification, CustomerStatusDomain } from "./customer-status.js";
import type { DomainChallenge, DomainRoutingReport } from "./data-plane.js";
import type { ProjectSloAssessment } from "./project-slo.js";
export interface PlatformStatusPagesOptions {
    maxPages?: number;
    maxReceipts?: number;
    maxPreviews?: number;
    maxUpdates?: number;
    maxSubscribers?: number;
    maxNotifications?: number;
}
/** Private, request-local native authority. Never reconstructed from a browser DTO. */
export interface StatusPageAuthority {
    readonly userId: string;
    authorize(write?: boolean): void;
    binding(): string;
    audit(action: string, metadata: Record<string, unknown>): void | (() => void);
}
export interface StatusPageHooks {
    hash(value: string): string;
    /** Stable native ownership/organization/parent binding, without a browser claim. */
    scope(projectId: string): string | null;
    incidentVersion(projectId: string, incidentId: string, authority: StatusPageAuthority): number;
    domainReserved(hostname: string): boolean;
    slo(projectId: string, policyId: string, authority: StatusPageAuthority): ProjectSloAssessment;
}
/** One bounded native catalog. Public reads project stored approved data only. */
export declare function openPlatformStatusPages(sql: SQLiteInternal, options: PlatformStatusPagesOptions, hooks: StatusPageHooks): {
    close(): void;
    reservedHostname(hostname: string): boolean;
    publicHostname(hostname: string): CustomerStatusSnapshot | null;
    domains(projectId: string, authority: StatusPageAuthority): CustomerStatusDomain[];
    beginDomain(projectId: string, authority: StatusPageAuthority, value: unknown, make: (existing: DomainChallenge | undefined) => Promise<DomainChallenge>): Promise<CustomerStatusDomain>;
    verifyDomain(projectId: string, domainId: string, authority: StatusPageAuthority, value: unknown, verify: (challenge: DomainChallenge) => Promise<{
        challenge: DomainChallenge;
        report: DomainRoutingReport;
    }>): Promise<CustomerStatusDomain>;
    reservedSlug(name: string): boolean;
    publicPage(name: string): CustomerStatusSnapshot;
    page(projectId: string, authority: StatusPageAuthority): CustomerStatusPage | null;
    create(projectId: string, authority: StatusPageAuthority, value: unknown): CustomerStatusPage;
    configure(projectId: string, authority: StatusPageAuthority, value: unknown): CustomerStatusPage;
    preview(projectId: string, authority: StatusPageAuthority, value: unknown): {
        id: `${string}-${string}-${string}-${string}-${string}`;
        digest: string;
        expectedVersion: number;
        expiresAt: number;
        page: CustomerStatusSnapshot;
        update: CustomerStatusCopy | null;
    };
    publish(projectId: string, authority: StatusPageAuthority, value: unknown): CustomerStatusPage;
    unpublish(projectId: string, authority: StatusPageAuthority, value: unknown): CustomerStatusPage;
    preferences(name: string, authority: StatusPageAuthority): CustomerStatusPreferences;
    subscribe(name: string, authority: StatusPageAuthority, value: unknown): CustomerStatusPreferences;
    notifications(name: string, authority: StatusPageAuthority, after: number): {
        notifications: CustomerStatusNotification[];
        next: number | null;
    };
};
