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
