import type { AuthClient } from "./auth.js";
export type CustomerStatusHealth = "operational" | "degraded" | "major-outage" | "maintenance" | "unknown";
export type CustomerStatusUpdateState = "investigating" | "identified" | "monitoring" | "resolved";
export interface CustomerStatusComponentInput {
    readonly key: string;
    readonly label: string;
    readonly source: {
        readonly kind: "manual";
        readonly health: CustomerStatusHealth;
        readonly observedAt: number;
        readonly expiresAt: number;
    } | {
        readonly kind: "slo";
        readonly policyId: string;
        readonly expectedVersion: number;
    };
}
export interface CustomerStatusConfiguration {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly components: readonly CustomerStatusComponentInput[];
}
/** Public health contains no native project, policy, subscriber or incident identity. */
export interface CustomerStatusComponent {
    readonly key: string;
    readonly label: string;
    readonly health: CustomerStatusHealth;
    readonly observedAt: number;
    readonly expiresAt: number;
    readonly complete: boolean;
}
export interface CustomerStatusCopy {
    readonly title: string;
    readonly message: string;
    readonly state: CustomerStatusUpdateState;
    readonly components: readonly string[];
}
export interface CustomerStatusUpdate extends CustomerStatusCopy {
    readonly id: string;
    readonly publishedAt: number;
}
export interface CustomerStatusSnapshot {
    readonly protocol: "clank-customer-status/1";
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly components: readonly CustomerStatusComponent[];
    readonly updates: readonly CustomerStatusUpdate[];
    readonly publishedAt: number;
}
/** Administration metadata is authenticated and never projected by the public page. */
export interface CustomerStatusPage {
    readonly projectId: string;
    readonly version: number;
    readonly configuration: CustomerStatusConfiguration;
    readonly published: boolean;
    readonly publishedVersion: number | null;
    readonly updatedAt: number;
}
export type CustomerStatusPublication = {
    readonly kind: "page";
} | {
    readonly kind: "update";
    readonly copy: CustomerStatusCopy;
    readonly incident: {
        readonly id: string;
        readonly expectedVersion: number;
    } | null;
};
export interface CustomerStatusPreview {
    readonly id: string;
    readonly digest: string;
    readonly expectedVersion: number;
    readonly expiresAt: number;
    readonly page: CustomerStatusSnapshot;
    readonly update: CustomerStatusCopy | null;
}
export interface CustomerStatusPublishRequest {
    readonly expectedVersion: number;
    readonly previewId: string;
    readonly previewDigest: string;
    readonly operationId: string;
}
export interface CustomerStatusPreferences {
    readonly version: number;
    readonly subscribed: boolean;
    /** Empty means all public components. Only the native inbox channel is supported. */
    readonly components: readonly string[];
    readonly updatedAt: number;
}
export interface CustomerStatusNotification {
    readonly id: string;
    readonly update: CustomerStatusUpdate;
    readonly createdAt: number;
}
export interface CustomerStatusDomain {
    readonly id: string;
    readonly hostname: string;
    readonly recordName: string;
    readonly recordValue: string;
    readonly expiresAt: number;
    readonly ownership: "pending" | "verified";
    readonly routing: "pending" | "ready";
}
export interface CustomerStatusClient {
    publicPage(slug: string): Promise<CustomerStatusSnapshot>;
    page(projectId: string): Promise<CustomerStatusPage | null>;
    create(projectId: string, input: {
        readonly configuration: CustomerStatusConfiguration;
        readonly operationId: string;
    }): Promise<CustomerStatusPage>;
    configure(projectId: string, input: {
        readonly configuration: CustomerStatusConfiguration;
        readonly expectedVersion: number;
        readonly operationId: string;
    }): Promise<CustomerStatusPage>;
    preview(projectId: string, input: {
        readonly expectedVersion: number;
        readonly publication: CustomerStatusPublication;
    }): Promise<CustomerStatusPreview>;
    publish(projectId: string, input: CustomerStatusPublishRequest): Promise<CustomerStatusPage>;
    unpublish(projectId: string, input: {
        readonly expectedVersion: number;
        readonly operationId: string;
    }): Promise<CustomerStatusPage>;
    domains(projectId: string): Promise<readonly CustomerStatusDomain[]>;
    beginDomain(projectId: string, input: {
        readonly hostname: string;
        readonly expectedVersion: number;
        readonly operationId: string;
    }): Promise<CustomerStatusDomain>;
    verifyDomain(projectId: string, domainId: string, input: {
        readonly expectedVersion: number;
        readonly operationId: string;
    }): Promise<CustomerStatusDomain>;
    preferences(slug: string): Promise<CustomerStatusPreferences>;
    subscribe(slug: string, input: {
        readonly subscribed: boolean;
        readonly components: readonly string[];
        readonly expectedVersion: number;
        readonly operationId: string;
    }): Promise<CustomerStatusPreferences>;
    notifications(slug: string, after?: number): Promise<{
        readonly notifications: readonly CustomerStatusNotification[];
        readonly next: number | null;
    }>;
}
export interface CustomerStatusClientOptions {
    url?: string;
    fetch?: typeof fetch;
    auth?: Pick<AuthClient<any>, "csrfHeader">;
    headers?: () => HeadersInit;
    timeoutMs?: number;
}
export declare class CustomerStatusError extends Error {
    readonly name = "CustomerStatusError";
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** Validate and detach dedicated public copy; never accept a private incident object. */
export declare function validateCustomerStatusCopy(value: unknown): CustomerStatusCopy;
export declare function validateCustomerStatusConfiguration(value: unknown): CustomerStatusConfiguration;
/** Strict public projection also rejects unexpected private fields in an HTTP response. */
export declare function validateCustomerStatusSnapshot(value: unknown): CustomerStatusSnapshot;
/** Native session/CSRF is supplied by the application's auth client, never by a status DTO. */
export declare function createCustomerStatusClient(options?: CustomerStatusClientOptions): CustomerStatusClient;
