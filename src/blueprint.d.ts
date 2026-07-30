export type AppFieldType = "string" | "text" | "number" | "boolean" | "email" | "url" | "date" | "datetime" | "enum" | "reference";
export interface AppFieldDefinition {
    type: AppFieldType;
    description?: string;
    required?: boolean;
    nullable?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
    values?: readonly string[];
    entity?: string;
    default?: string | number | boolean | null;
}
export interface AppIndexDefinition {
    fields: readonly string[];
}
export interface AppEntityDefinition {
    description: string;
    ownership?: "public" | "user" | "workspace";
    realtime?: boolean;
    displayField: string;
    completionField?: string;
    fields: Record<string, AppFieldDefinition>;
    indexes?: Record<string, AppIndexDefinition>;
}
export interface AppRelationshipDefinition {
    name: string;
    from: string;
    to: string;
    kind: "one-to-one" | "one-to-many" | "many-to-many";
    onDelete?: "restrict" | "cascade" | "nullify";
    /**
     * The field that stores the relationship. It must be a reference field on
     * either endpoint that targets the other endpoint. Clank infers it when
     * exactly one unambiguous reference exists.
     */
    reference?: {
        entity: string;
        field: string;
    };
}
export interface AppRoleDefinition {
    description: string;
    permissions: readonly string[];
}
export interface AppRouteAccess {
    roles?: readonly string[];
}
export interface AppRouteDefinition {
    path: string;
    view: string;
    description?: string;
    entity?: string;
    access?: "public" | "authenticated" | AppRouteAccess;
}
export interface AppActionDefinition {
    description: string;
    entity?: string;
    operation: "create" | "read" | "update" | "delete" | "custom";
    /**
     * The safe generated implementation. Ordinary CRUD behaviors are inferred
     * from operation and conventional names; custom actions remain explicit
     * extension points until application code implements them.
     */
    behavior?: "list" | "create" | "update" | "toggle" | "delete";
    roles?: readonly string[];
    confirmation?: "never" | "write" | "always";
    realtime?: boolean;
}
export interface AppMigrationDefinition {
    id: string;
    name: string;
    sql: string;
}
export interface AppServiceDefinition {
    kind: "files" | "images" | "email" | "jobs" | "cron" | "search" | "webhooks" | "custom";
    description: string;
    required?: boolean;
    capabilities?: readonly string[];
}
export interface AppDeploymentDefinition {
    database?: "sqlite" | "postgres";
    scale?: "single" | "horizontal";
    isolation?: "process" | "container" | "microvm";
    healthPath?: string;
    region?: string;
    customDomains?: boolean;
    env?: Record<string, string>;
}
export type AppFixtureValue = string | number | boolean | null | {
    ref: string;
};
export interface AppFixtureUserDefinition {
    email: string;
    role?: string;
    profile?: {
        name?: string;
    };
}
export interface AppFixtureRecordDefinition {
    owner?: string;
    values: Record<string, AppFixtureValue>;
}
export interface AppFixtureDefinition {
    description?: string;
    users?: Record<string, AppFixtureUserDefinition>;
    records?: Record<string, Record<string, AppFixtureRecordDefinition>>;
}
export interface AppFixtureUser {
    email: string;
    role: string;
    profile: {
        name?: string;
    };
}
export interface AppFixtureRecord {
    owner: string;
    values: Record<string, AppFixtureValue>;
}
export interface AppFixture {
    protocol: "clank-fixture/1";
    name: string;
    description: string;
    users: Record<string, AppFixtureUser>;
    records: Record<string, Record<string, AppFixtureRecord>>;
}
export interface AppBlueprintInput {
    protocol?: "clank-app/1";
    name: string;
    slug?: string;
    description: string;
    version?: number;
    auth?: {
        required?: true;
        organizations?: boolean;
        roles?: Record<string, AppRoleDefinition>;
    };
    entities: Record<string, AppEntityDefinition>;
    relationships?: readonly AppRelationshipDefinition[];
    routes: readonly AppRouteDefinition[];
    actions?: Record<string, AppActionDefinition>;
    migrations?: readonly AppMigrationDefinition[];
    services?: Record<string, AppServiceDefinition>;
    fixtures?: Record<string, AppFixtureDefinition>;
    deployment?: AppDeploymentDefinition;
}
export interface AppBlueprint extends AppBlueprintInput {
    protocol: "clank-app/1";
    slug: string;
    version: number;
    auth: {
        required: boolean;
        organizations: boolean;
        roles: Record<string, AppRoleDefinition>;
    };
    relationships: readonly AppRelationshipDefinition[];
    actions: Record<string, AppActionDefinition>;
    migrations: readonly AppMigrationDefinition[];
    services: Record<string, AppServiceDefinition>;
    fixtures: Record<string, AppFixture>;
    deployment: Required<Omit<AppDeploymentDefinition, "region">> & {
        region?: string;
    };
}
export interface GeneratedAppFile {
    path: string;
    contents: string;
    mode?: number;
}
export interface AppPlan {
    protocol: "clank-plan/1";
    blueprint: AppBlueprint;
    summary: {
        entities: number;
        relationships: number;
        routes: number;
        actions: number;
        services: number;
        migrations: number;
        fixtures: number;
    };
    warnings: readonly string[];
    files: readonly {
        path: string;
        bytes: number;
        sha256: string;
    }[];
    digest: string;
}
export declare function defineApp(input: AppBlueprintInput): AppBlueprint;
export declare function parseAppBlueprint(source: string, filename?: string): AppBlueprint;
export declare function generateAppFiles(input: AppBlueprintInput | AppBlueprint, options?: {
    frameworkVersion?: string;
    frameworkDependency?: string;
}): GeneratedAppFile[];
export declare function createAppPlan(input: AppBlueprintInput | AppBlueprint, options?: {
    frameworkVersion?: string;
    frameworkDependency?: string;
}): Promise<AppPlan>;
export declare function explainApp(input: AppBlueprintInput | AppBlueprint): string;
