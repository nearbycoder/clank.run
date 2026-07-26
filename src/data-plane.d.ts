import type { Migration, MigrationPlan } from "./migrations.js";
export interface IngressRoute {
    id: string;
    projectId: string;
    hosts: readonly string[];
    upstream: string;
    active: boolean;
}
export interface IngressRouteStore {
    routes(): readonly IngressRoute[] | Promise<readonly IngressRoute[]>;
}
export interface ManagedIngress {
    handle(request: Request): Promise<Response>;
    health(): Promise<Record<string, {
        ok: boolean;
        status?: number;
        error?: string;
    }>>;
}
export interface IngressRequestMetric {
    projectId: string;
    routeId: string;
    method: string;
    statusCode: number;
    durationMs: number;
    requestBytes: number;
    responseBytes: number;
    recordedAt: number;
}
export declare function createManagedIngress(options: {
    routes: IngressRouteStore | (() => readonly IngressRoute[] | Promise<readonly IngressRoute[]>);
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxBodyBytes?: number;
    retries?: number;
    trustProxy?: boolean;
    allowedUpstreamHosts?: readonly string[];
    circuitFailures?: number;
    circuitResetMs?: number;
    onRequest?: (metric: IngressRequestMetric) => void | Promise<void>;
}): ManagedIngress;
export interface DomainChallenge {
    id: string;
    projectId: string;
    hostname: string;
    recordName: string;
    recordType: "TXT";
    recordValue: string;
    status: "pending" | "verified";
    expiresAt: number;
    verifiedAt?: number;
}
export interface DomainChallengeStore {
    save(challenge: DomainChallenge): void | Promise<void>;
    get(id: string): DomainChallenge | undefined | Promise<DomainChallenge | undefined>;
    byHostname(hostname: string): DomainChallenge | undefined | Promise<DomainChallenge | undefined>;
}
export interface DomainManager {
    begin(projectId: string, hostname: string): Promise<DomainChallenge>;
    verify(id: string): Promise<DomainChallenge>;
}
export declare class DomainVerificationError extends Error {
    readonly code: "INVALID_CHALLENGE" | "DNS_TXT_MISSING";
    constructor(code: "INVALID_CHALLENGE" | "DNS_TXT_MISSING", message: string);
}
export interface DomainDnsResolver {
    resolveCname(hostname: string): Promise<readonly string[]>;
    resolve4(hostname: string): Promise<readonly string[]>;
    resolve6(hostname: string): Promise<readonly string[]>;
}
export interface DomainRoutingTarget {
    cname?: string;
    addresses?: readonly string[];
}
export interface DomainRoutingReport {
    hostname: string;
    status: "pending" | "ready" | "misconfigured" | "error";
    target: {
        cname: string | null;
        addresses: readonly string[];
    };
    observed: {
        cnames: readonly string[];
        addresses: readonly string[];
    };
    checkedAt: number;
    error?: string;
}
/** Resolves a customer hostname and proves that it points at the configured Clank edge. */
export declare function inspectDomainRouting(hostnameInput: string, targetInput: DomainRoutingTarget, resolver?: DomainDnsResolver): Promise<DomainRoutingReport>;
export declare function createMemoryDomainStore(): DomainChallengeStore & {
    values(): DomainChallenge[];
};
export declare function createDomainManager(options: {
    store: DomainChallengeStore;
    resolveTxt?: (hostname: string) => Promise<readonly (readonly string[])[]>;
    challengeLifetimeMs?: number;
}): DomainManager;
export interface SqlStatement {
    text: string;
    parameters?: readonly unknown[];
}
export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
    rows: readonly Row[];
    rowCount: number;
}
export interface ExternalSqlDriver {
    readonly dialect: "postgres";
    query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>>;
    transaction(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
    health(): Promise<boolean>;
    close?(): void | Promise<void>;
}
export declare function createHttpPostgresDriver(options: {
    url: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
    headers?: Record<string, string>;
}): ExternalSqlDriver;
export declare function planExternalMigrations(driver: ExternalSqlDriver, migrations: readonly Migration[]): Promise<MigrationPlan>;
export declare function applyExternalMigrations(driver: ExternalSqlDriver, migrations: readonly Migration[]): Promise<MigrationPlan>;
export interface ExternalDatabaseBinding {
    id: string;
    engine: "postgres";
    region: string;
    connectionUrl: string;
    createdAt: number;
}
export interface ExternalDatabaseProvisioner {
    provision(input: {
        projectId: string;
        region: string;
        idempotencyKey: string;
    }): Promise<ExternalDatabaseBinding>;
    destroy(id: string, confirmation: string): Promise<void>;
}
export declare function createHttpDatabaseProvisioner(options: {
    url: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}): ExternalDatabaseProvisioner;
