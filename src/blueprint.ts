export type AppFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "email"
  | "url"
  | "date"
  | "datetime"
  | "enum"
  | "reference";

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
  deployment: Required<Omit<AppDeploymentDefinition, "region">> & { region?: string };
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
  };
  warnings: readonly string[];
  files: readonly {
    path: string;
    bytes: number;
    sha256: string;
  }[];
  digest: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const MIGRATION_ID = /^\d{4}$/;

export function defineApp(input: AppBlueprintInput): AppBlueprint {
  return normalizeApp(input);
}

export function parseAppBlueprint(source: string, filename = "clank.app.ts"): AppBlueprint {
  if (filename.endsWith(".json")) {
    let value: unknown;
    try { value = JSON.parse(source); }
    catch (error) { throw new TypeError(`Invalid ${filename}: ${message(error)}`); }
    return normalizeApp(value as AppBlueprintInput);
  }
  const parser = new DataModuleParser(source, filename);
  return normalizeApp(parser.parse() as AppBlueprintInput);
}

export function generateAppFiles(
  input: AppBlueprintInput | AppBlueprint,
  options: { frameworkVersion?: string } = {},
): GeneratedAppFile[] {
  const app = normalizeApp(input);
  const frameworkVersion = options.frameworkVersion ?? "latest";
  const primaryName = primaryEntity(app);
  const primary = app.entities[primaryName];
  const display = primary.displayField;
  const completion = primary.completionField;
  const files: GeneratedAppFile[] = [
    {
      path: ".gitignore",
      contents: "dist/\n.clank/\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n.env\n.env.*\n",
    },
    {
      path: "package.json",
      contents: json({
        name: app.slug,
        private: true,
        type: "module",
        scripts: {
          build: "clank build src dist",
          dev: "clank build src dist && node --disable-warning=ExperimentalWarning dist/server.js",
          start: "node --disable-warning=ExperimentalWarning dist/server.js",
          plan: "clank plan",
          generate: "clank generate .",
          deploy: "clank deploy",
        },
        dependencies: { "clank.run": frameworkVersion === "latest" ? "latest" : `^${frameworkVersion}` },
      }),
    },
    {
      path: "tsconfig.json",
      contents: json({
        compilerOptions: {
          target: "ES2022",
          jsx: "preserve",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          isolatedModules: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
        },
        include: ["src", "clank.app.ts"],
      }),
    },
    {
      path: "clank.app.ts",
      contents: `export default ${JSON.stringify(app, null, 2)} satisfies import("clank.run/blueprint").AppBlueprintInput;\n`,
    },
    {
      path: "clank.deploy.json",
      contents: json({
        version: 1,
        entry: "dist/server.js",
        include: ["dist", "migrations"],
        build: { command: ["clank", "build", "src", "dist"] },
        database: {
          path: app.deployment.database === "sqlite" ? "app.sqlite" : "app.sqlite",
          migrations: "migrations",
          allowUnsafeMigrations: false,
        },
        health: { path: app.deployment.healthPath, timeoutMs: 15_000 },
        env: app.deployment.env,
      }),
    },
    {
      path: "migrations/0001_app_metadata.sql",
      contents: metadataMigration(app),
    },
    {
      path: "src/backend.ts",
      contents: backendSource(app),
    },
    {
      path: "src/view.tsx",
      contents: viewSource(app, primaryName, display, completion),
    },
    {
      path: "src/app.tsx",
      contents: browserSource(primaryName, completion),
    },
    {
      path: "src/server.tsx",
      contents: serverSource(app, primaryName, completion),
    },
    {
      path: "src/service-requirements.ts",
      contents: serviceRequirementsSource(app),
    },
  ];
  for (const migration of app.migrations) {
    files.push({
      path: `migrations/${migration.id}_${fileName(migration.name)}.sql`,
      contents: `${migration.sql.trim()}\n`,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function serviceRequirementsSource(app: AppBlueprint): string {
  const requirements = Object.entries(app.services).map(([name, service]) => ({
    name,
    kind: service.kind,
    capabilities: service.capabilities ?? [],
    required: service.required ?? false,
  }));
  return `import type { ServiceRegistry, ServiceRequirement } from "clank.run/services";

export const serviceRequirements = ${JSON.stringify(requirements, null, 2)} as const satisfies readonly ServiceRequirement[];

export function assertServices(services: ServiceRegistry): void {
  services.assert(serviceRequirements);
}
`;
}

export async function createAppPlan(
  input: AppBlueprintInput | AppBlueprint,
  options: { frameworkVersion?: string } = {},
): Promise<AppPlan> {
  const blueprint = normalizeApp(input);
  const files = generateAppFiles(blueprint, options);
  const plannedFiles = [];
  for (const file of files) {
    plannedFiles.push({
      path: file.path,
      bytes: new TextEncoder().encode(file.contents).byteLength,
      sha256: await sha256(file.contents),
    });
  }
  const warnings = appWarnings(blueprint);
  const unsigned = {
    protocol: "clank-plan/1" as const,
    blueprint,
    summary: {
      entities: Object.keys(blueprint.entities).length,
      relationships: blueprint.relationships.length,
      routes: blueprint.routes.length,
      actions: Object.keys(blueprint.actions).length,
      services: Object.keys(blueprint.services).length,
      migrations: blueprint.migrations.length + 1,
    },
    warnings,
    files: plannedFiles,
  };
  return deepFreeze({ ...unsigned, digest: await sha256(canonical(unsigned)) });
}

export function explainApp(input: AppBlueprintInput | AppBlueprint): string {
  const app = normalizeApp(input);
  const lines = [
    `${app.name} (${app.slug})`,
    app.description,
    "",
    `Authentication: ${app.auth.required ? "required" : "optional"}; organizations ${app.auth.organizations ? "enabled" : "disabled"}.`,
    `Data: ${Object.keys(app.entities).length} entities, ${app.relationships.length} relationships, ${app.deployment.database}.`,
    `Interface: ${app.routes.length} routes and ${Object.keys(app.actions).length} declared actions.`,
    `Operations: ${app.deployment.scale} scale, ${app.deployment.isolation} isolation, health at ${app.deployment.healthPath}.`,
  ];
  for (const [name, entity] of Object.entries(app.entities)) {
    lines.push(
      `- ${name}: ${entity.description} (${entity.ownership}, ${entity.realtime ? "live" : "request/response"}, ${Object.keys(entity.fields).length} fields)`,
    );
  }
  if (Object.keys(app.services).length) {
    lines.push("Services:");
    for (const [name, service] of Object.entries(app.services)) {
      lines.push(`- ${name}: ${service.kind}${service.required ? " (required)" : ""} — ${service.description}`);
    }
  }
  const warnings = appWarnings(app);
  if (warnings.length) {
    lines.push("Warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeApp(input: AppBlueprintInput): AppBlueprint {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("App blueprint must be an object.");
  const name = text(input.name, "name", 1, 100);
  const slug = input.slug === undefined ? slugify(name) : slugValue(input.slug);
  const description = text(input.description, "description", 1, 500);
  const version = input.version ?? 1;
  if (version !== 1) throw new TypeError("App blueprint version must be 1.");
  if (input.protocol !== undefined && input.protocol !== "clank-app/1") {
    throw new TypeError("App blueprint protocol must be clank-app/1.");
  }

  const sourceEntities = record(input.entities, "entities");
  if (Object.keys(sourceEntities).length === 0) throw new TypeError("App blueprint requires at least one entity.");
  const entities: Record<string, AppEntityDefinition> = {};
  for (const [entityName, raw] of Object.entries(sourceEntities)) {
    identifier(entityName, "entity");
    const entity = object(raw, `entities.${entityName}`);
    const fieldsInput = record(entity.fields, `entities.${entityName}.fields`);
    if (!Object.keys(fieldsInput).length) throw new TypeError(`Entity ${entityName} requires fields.`);
    const fields: Record<string, AppFieldDefinition> = {};
    for (const [fieldName, fieldRaw] of Object.entries(fieldsInput)) {
      identifier(fieldName, "field");
      fields[fieldName] = normalizeField(fieldRaw, `${entityName}.${fieldName}`);
    }
    const displayField = text(entity.displayField, `${entityName}.displayField`, 1, 100);
    if (!fields[displayField]) throw new TypeError(`${entityName}.displayField references an unknown field.`);
    if (!["string", "text", "email"].includes(fields[displayField].type)) {
      throw new TypeError(`${entityName}.displayField must reference a string-like field.`);
    }
    const completionField = entity.completionField === undefined
      ? undefined
      : text(entity.completionField, `${entityName}.completionField`, 1, 100);
    if (completionField && fields[completionField]?.type !== "boolean") {
      throw new TypeError(`${entityName}.completionField must reference a boolean field.`);
    }
    const indexes: Record<string, AppIndexDefinition> = {};
    for (const [indexName, indexRaw] of Object.entries(record(entity.indexes ?? {}, `${entityName}.indexes`))) {
      identifier(indexName, "index");
      const index = object(indexRaw, `${entityName}.indexes.${indexName}`);
      const fieldsForIndex = stringArray(index.fields, `${entityName}.indexes.${indexName}.fields`, 1);
      for (const field of fieldsForIndex) if (!fields[field]) throw new TypeError(`Index ${entityName}.${indexName} references unknown field ${field}.`);
      indexes[indexName] = { fields: fieldsForIndex };
    }
    entities[entityName] = {
      description: text(entity.description, `${entityName}.description`, 1, 500),
      ownership: enumValue(entity.ownership ?? "user", ["public", "user", "workspace"], `${entityName}.ownership`),
      realtime: booleanValue(entity.realtime ?? true, `${entityName}.realtime`),
      displayField,
      ...(completionField ? { completionField } : {}),
      fields,
      indexes,
    };
  }

  for (const [entityName, entity] of Object.entries(entities)) {
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (field.type === "reference" && !entities[field.entity!]) {
        throw new TypeError(`Reference ${entityName}.${fieldName} targets unknown entity ${field.entity}.`);
      }
    }
  }

  const roles: Record<string, AppRoleDefinition> = {};
  for (const [roleName, roleRaw] of Object.entries(record(input.auth?.roles ?? {}, "auth.roles"))) {
    identifier(roleName, "role");
    const role = object(roleRaw, `auth.roles.${roleName}`);
    roles[roleName] = {
      description: text(role.description, `auth.roles.${roleName}.description`, 1, 300),
      permissions: stringArray(role.permissions, `auth.roles.${roleName}.permissions`),
    };
  }
  if (!roles.member) roles.member = { description: "Standard application member.", permissions: ["app.use"] };
  if (input.auth?.required === false) {
    throw new TypeError("Generated Clank applications currently require built-in authentication.");
  }

  const relationships = (input.relationships ?? []).map((raw, index) => {
    const relation = object(raw, `relationships.${index}`);
    const from = text(relation.from, `relationships.${index}.from`, 1, 100);
    const to = text(relation.to, `relationships.${index}.to`, 1, 100);
    if (!entities[from] || !entities[to]) throw new TypeError(`Relationship ${index} references an unknown entity.`);
    return {
      name: identifier(text(relation.name, `relationships.${index}.name`, 1, 100), "relationship"),
      from,
      to,
      kind: enumValue(relation.kind, ["one-to-one", "one-to-many", "many-to-many"], `relationships.${index}.kind`),
      onDelete: enumValue(relation.onDelete ?? "restrict", ["restrict", "cascade", "nullify"], `relationships.${index}.onDelete`),
    } as AppRelationshipDefinition;
  });
  unique(relationships.map((relation) => relation.name), "relationship names");

  if (!Array.isArray(input.routes) || input.routes.length === 0) throw new TypeError("App blueprint requires at least one route.");
  const routes = input.routes.map((raw, index) => {
    const route = object(raw, `routes.${index}`);
    const path = routePath(route.path, `routes.${index}.path`);
    const entity = route.entity === undefined ? undefined : text(route.entity, `routes.${index}.entity`, 1, 100);
    if (entity && !entities[entity]) throw new TypeError(`Route ${path} references unknown entity ${entity}.`);
    const access = normalizeAccess(route.access ?? "authenticated", roles, `routes.${index}.access`);
    return {
      path,
      view: text(route.view, `routes.${index}.view`, 1, 100),
      ...(route.description === undefined ? {} : { description: text(route.description, `routes.${index}.description`, 1, 300) }),
      ...(entity ? { entity } : {}),
      access,
    } as AppRouteDefinition;
  });
  unique(routes.map((route) => route.path), "route paths");

  const actions: Record<string, AppActionDefinition> = {};
  for (const [actionName, actionRaw] of Object.entries(record(input.actions ?? {}, "actions"))) {
    if (!ACTION_NAME.test(actionName)) throw new TypeError(`Invalid action name: ${actionName}.`);
    const action = object(actionRaw, `actions.${actionName}`);
    const entity = action.entity === undefined ? undefined : text(action.entity, `${actionName}.entity`, 1, 100);
    if (entity && !entities[entity]) throw new TypeError(`Action ${actionName} references unknown entity ${entity}.`);
    const actionRoles = stringArray(action.roles ?? [], `${actionName}.roles`);
    for (const role of actionRoles) if (!roles[role]) throw new TypeError(`Action ${actionName} references unknown role ${role}.`);
    actions[actionName] = {
      description: text(action.description, `${actionName}.description`, 1, 500),
      ...(entity ? { entity } : {}),
      operation: enumValue(action.operation, ["create", "read", "update", "delete", "custom"], `${actionName}.operation`),
      roles: actionRoles,
      confirmation: enumValue(
        action.confirmation ?? (action.operation === "delete" ? "always" : action.operation === "read" ? "never" : "write"),
        ["never", "write", "always"],
        `${actionName}.confirmation`,
      ),
      realtime: booleanValue(action.realtime ?? false, `${actionName}.realtime`),
    };
  }

  const migrations = (input.migrations ?? []).map((raw, index) => {
    const migration = object(raw, `migrations.${index}`);
    const id = text(migration.id, `migrations.${index}.id`, 4, 4);
    if (!MIGRATION_ID.test(id) || id === "0001") throw new TypeError("Blueprint migration IDs must be four digits starting at 0002.");
    return {
      id,
      name: text(migration.name, `migrations.${index}.name`, 1, 100),
      sql: text(migration.sql, `migrations.${index}.sql`, 1, 100_000),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  unique(migrations.map((migration) => migration.id), "migration IDs");

  const services: Record<string, AppServiceDefinition> = {};
  for (const [serviceName, serviceRaw] of Object.entries(record(input.services ?? {}, "services"))) {
    identifier(serviceName, "service");
    const service = object(serviceRaw, `services.${serviceName}`);
    services[serviceName] = {
      kind: enumValue(service.kind, ["files", "images", "email", "jobs", "cron", "search", "webhooks", "custom"], `${serviceName}.kind`),
      description: text(service.description, `${serviceName}.description`, 1, 500),
      required: booleanValue(service.required ?? false, `${serviceName}.required`),
      capabilities: stringArray(service.capabilities ?? [], `${serviceName}.capabilities`),
    };
  }

  const deployment = object(input.deployment ?? {}, "deployment");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(deployment.env ?? {}, "deployment.env"))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key.startsWith("CLANK_")) throw new TypeError(`Invalid public deployment environment key: ${key}.`);
    env[key] = text(value, `deployment.env.${key}`, 0, 10_000);
  }

  const normalized: AppBlueprint = {
    protocol: "clank-app/1",
    name,
    slug,
    description,
    version,
    auth: {
      required: true,
      organizations: booleanValue(input.auth?.organizations ?? false, "auth.organizations"),
      roles,
    },
    entities,
    relationships,
    routes,
    actions,
    migrations,
    services,
    deployment: {
      database: enumValue(deployment.database ?? "sqlite", ["sqlite", "postgres"], "deployment.database"),
      scale: enumValue(deployment.scale ?? "single", ["single", "horizontal"], "deployment.scale"),
      isolation: enumValue(deployment.isolation ?? "container", ["process", "container", "microvm"], "deployment.isolation"),
      healthPath: routePath(deployment.healthPath ?? "/healthz", "deployment.healthPath"),
      ...(deployment.region === undefined ? {} : { region: text(deployment.region, "deployment.region", 1, 100) }),
      customDomains: booleanValue(deployment.customDomains ?? false, "deployment.customDomains"),
      env,
    },
  };
  return deepFreeze(normalized);
}

function normalizeField(raw: unknown, path: string): AppFieldDefinition {
  const field = object(raw, path);
  const type = enumValue(field.type, [
    "string", "text", "number", "boolean", "email", "url", "date", "datetime", "enum", "reference",
  ], `${path}.type`) as AppFieldType;
  const values = type === "enum" ? stringArray(field.values, `${path}.values`, 1) : undefined;
  if (values) unique(values, `${path}.values`);
  const entity = type === "reference" ? text(field.entity, `${path}.entity`, 1, 100) : undefined;
  const min = optionalFinite(field.min, `${path}.min`);
  const max = optionalFinite(field.max, `${path}.max`);
  if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${path}.min cannot exceed max.`);
  const output: AppFieldDefinition = {
    type,
    ...(field.description === undefined ? {} : { description: text(field.description, `${path}.description`, 1, 300) }),
    required: booleanValue(field.required ?? true, `${path}.required`),
    nullable: booleanValue(field.nullable ?? false, `${path}.nullable`),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(type === "number" ? { integer: booleanValue(field.integer ?? false, `${path}.integer`) } : {}),
    ...(values ? { values } : {}),
    ...(entity ? { entity } : {}),
  };
  if (Object.hasOwn(field, "default")) {
    const value = field.default;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`${path}.default must be a JSON scalar.`);
    }
    validateDefault(output, value as string | number | boolean | null, path);
    output.default = value as string | number | boolean | null;
  }
  return output;
}

function validateDefault(field: AppFieldDefinition, value: string | number | boolean | null, path: string): void {
  if (value === null) {
    if (!field.nullable) throw new TypeError(`${path}.default cannot be null unless nullable is true.`);
    return;
  }
  if (field.type === "number" && typeof value !== "number") throw new TypeError(`${path}.default must be a number.`);
  if (field.type === "boolean" && typeof value !== "boolean") throw new TypeError(`${path}.default must be a boolean.`);
  if (!["number", "boolean"].includes(field.type) && typeof value !== "string") throw new TypeError(`${path}.default must be a string.`);
  if (field.type === "enum" && !field.values!.includes(value as string)) throw new TypeError(`${path}.default is not an enum member.`);
}

function appWarnings(app: AppBlueprint): string[] {
  const warnings: string[] = [];
  if (app.auth.organizations) warnings.push("Organization ownership requires the platform organization/RBAC capability.");
  if (Object.values(app.entities).some((entity) => entity.ownership === "workspace")) {
    warnings.push("Workspace-owned entities require an organization context; generated baseline storage uses signed-in ownership until configured.");
  }
  if (app.deployment.database === "postgres") warnings.push("PostgreSQL requires an installed external database driver.");
  if (app.deployment.scale === "horizontal" && app.deployment.database === "sqlite") {
    warnings.push("Horizontal application writes require an external database; SQLite remains single-host.");
  }
  if (app.deployment.isolation === "process") warnings.push("Process isolation is for trusted applications only.");
  for (const [name, service] of Object.entries(app.services)) {
    if (service.required) warnings.push(`Required service ${name} (${service.kind}) must be provisioned before production deployment.`);
  }
  return warnings;
}

function backendSource(app: AppBlueprint): string {
  const auth = app.auth.required
    ? `export const auth = defineAuth({ defaultRole: ${JSON.stringify(Object.keys(app.auth.roles)[0] ?? "member")} });\n`
    : "";
  const tables = Object.entries(app.entities).map(([name, entity]) => {
    let chain = `defineTable({\n${Object.entries(entity.fields).map(([fieldName, field]) =>
      `      ${property(fieldName)}: ${schemaSource(field)},`).join("\n")}\n    })`;
    if (entity.ownership !== "public") chain += ".owned()";
    for (const [indexName, index] of Object.entries(entity.indexes ?? {})) {
      chain += `.index(${JSON.stringify(indexName)}, ${JSON.stringify(index.fields)})`;
    }
    return `  ${property(name)}: ${chain},`;
  }).join("\n");
  const groups = Object.entries(app.entities).map(([name, entity]) => entityFunctions(name, entity)).join(",\n");
  return `import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
  type DocumentFor,
} from "clank.run";

${auth}export const schema = defineDatabase({
${tables}
});

${Object.keys(app.entities).map((name) =>
    `export type ${typeName(name)} = DocumentFor<typeof schema, ${JSON.stringify(name)}>;`).join("\n")}

const documentVersion = s.number({ integer: true, min: 1 });

export const backend = defineBackend({
  schema,
  ${app.auth.required ? "auth," : ""}
}).functions(({ query, mutation }) => ({
${groups}
}));
`;
}

function entityFunctions(name: string, entity: AppEntityDefinition): string {
  const createFields = Object.entries(entity.fields).map(([fieldName, field]) =>
    `        ${property(fieldName)}: ${createSchemaSource(field)},`).join("\n");
  const insertFields = Object.entries(entity.fields).map(([fieldName]) =>
    `          ${property(fieldName)}: input.${fieldName},`).join("\n");
  const updateFields = Object.entries(entity.fields).map(([fieldName, field]) =>
    `          ${property(fieldName)}: s.optional(${schemaSource({ ...field, required: true, default: undefined }, false)}),`).join("\n");
  const toggle = entity.completionField ? `,
    toggle: mutation({
      args: {
        id: s.id(${JSON.stringify(name)}),
        value: s.boolean(),
        version: documentVersion,
      },
      handler: ({ db }, { id, value, version }) =>
        db.table(${JSON.stringify(name)}).patch(id, { ${property(entity.completionField)}: value }, { ifVersion: version }),
    })` : "";
  return `  ${property(name)}: {
    list: query({
      args: {},
      handler: ({ db }) => db.table(${JSON.stringify(name)}).query().orderBy("_creationTime", "asc").collect(),
    }),
    create: mutation({
      args: {
${createFields}
      },
      handler: ({ db }, input) => db.table(${JSON.stringify(name)}).insert({
${insertFields}
      }),
    }),
    update: mutation({
      args: {
        id: s.id(${JSON.stringify(name)}),
        version: documentVersion,
        changes: s.object({
${updateFields}
        }),
      },
      handler: ({ db }, { id, version, changes }) =>
        db.table(${JSON.stringify(name)}).patch(id, changes, { ifVersion: version }),
    }),
    remove: mutation({
      args: { id: s.id(${JSON.stringify(name)}), version: documentVersion },
      handler: ({ db }, { id, version }) =>
        db.table(${JSON.stringify(name)}).delete(id, { ifVersion: version }),
    })${toggle},
  }`;
}

function viewSource(
  app: AppBlueprint,
  entityName: string,
  displayField: string,
  completionField?: string,
): string {
  const type = typeName(entityName);
  const singular = humanize(entityName.replace(/s$/u, ""));
  const createDefaults = Object.entries(app.entities[entityName].fields)
    .filter(([name]) => name !== displayField)
    .map(([name, field]) => `${property(name)}: ${JSON.stringify(defaultFor(field, name))}`)
    .join(", ");
  return `/* @clankImportSource clank.run */
import { For, signal${app.auth.required ? ", type AuthUser, type DefaultAuthProfile" : ""} } from "clank.run";
import type { ${type} } from "./backend.ts";

export interface AppViewProps {
  ${app.auth.required ? "user: AuthUser<DefaultAuthProfile>;" : ""}
  records: ${type}[];
  version: number;
  connected: boolean;
  create(input: Omit<${type}, "_id" | "_creationTime" | "_version"${app.entities[entityName].ownership !== "public" ? ' | "_ownerId"' : ""}>): void | Promise<void>;
  ${completionField ? `toggle(id: ${type}["_id"], value: boolean, version: number): void | Promise<void>;` : ""}
  remove(id: ${type}["_id"], version: number): void | Promise<void>;
  ${app.auth.required ? "logout(): void | Promise<void>;" : ""}
}

export function AppView(props: AppViewProps) {
  const draft = signal("");
  const submit = async (event: Event) => {
    event.preventDefault();
    const value = draft.value.trim();
    if (!value) return;
    draft.value = "";
    await props.create({ ${property(displayField)}: value${createDefaults ? `, ${createDefaults}` : ""} });
  };
  return (
    <main class="mx-auto min-h-screen max-w-4xl px-6 py-12 text-slate-950">
      <header class="flex items-start justify-between gap-6">
        <div>
          <p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-600">Clank generated application</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-tight">{${JSON.stringify(app.name)}}</h1>
          <p class="mt-3 max-w-2xl text-slate-500">{${JSON.stringify(app.description)}}</p>
          <p class="mt-2 text-sm text-slate-500">
            {props.connected ? "Live sync connected." : "Reconnecting…"}
            <span class="sr-only"> Database snapshot {props.version}.</span>
          </p>
        </div>
        ${app.auth.required ? `<button class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold" onClick={props.logout}>Sign out</button>` : ""}
      </header>
      <form class="mt-10 flex gap-3" onSubmit={submit}>
        <input
          class="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 shadow-sm"
          placeholder=${JSON.stringify(`New ${singular.toLowerCase()}`)}
          maxlength={200}
          required
          bind:value={draft}
          agentId="new-record"
          agentLabel=${JSON.stringify(`New ${singular} ${humanize(displayField)}`)}
        />
        <button class="rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white" type="submit" agentId="create-record">
          Add ${singular}
        </button>
      </form>
      <section class="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <For each={props.records} by="_id" fallback={<p class="p-8 text-center text-slate-500">No ${humanize(entityName).toLowerCase()} yet.</p>}>
          {(record) => (
            <article class="flex items-center gap-3 border-b border-slate-100 p-4 last:border-0">
              ${completionField ? `<button
                class="h-6 w-6 rounded-full border border-slate-400 text-xs"
                onClick={() => props.toggle(record._id, !record.${completionField}, record._version)}
                agentId={\`record-\${record._id}-toggle\`}
                agentLabel={\`\${record.${completionField} ? "Reopen" : "Complete"} \${record.${displayField}}\`}
              >{record.${completionField} ? "✓" : ""}</button>` : ""}
              <span classList={{ "flex-1": true${completionField ? `, "line-through text-slate-400": record.${completionField}` : ""} }}>{record.${displayField}}</span>
              <button
                class="text-sm font-medium text-rose-600"
                onClick={() => props.remove(record._id, record._version)}
                agentId={\`record-\${record._id}-remove\`}
                agentLabel={\`Remove \${record.${displayField}}\`}
              >Remove</button>
            </article>
          )}
        </For>
      </section>
    </main>
  );
}
`;
}

function browserSource(entityName: string, completionField?: string): string {
  return `/* @clankImportSource clank.run */
import {
  ${"AuthGate,"}
  createClient,
  hydrate,
  onCleanup,
  readState,
  type AuthState,
  type DefaultAuthProfile,
} from "clank.run";
import type { backend, ${typeName(entityName)} } from "./backend.ts";
import { AppView } from "./view.tsx";

interface PageState {
  auth: AuthState<DefaultAuthProfile>;
  records: ${typeName(entityName)}[];
  version: number;
}

const boot = readState<PageState>()!;
const client = createClient<typeof backend>({ initialAuth: boot.auth });
client.seed(client.api.${entityName}.list, {}, boot.records, boot.version);

function LiveApp() {
  const records = client.live(client.api.${entityName}.list);
  onCleanup(() => records.dispose());
  return (
    <AppView
      user={client.auth.user.value!}
      records={records.data.value ?? boot.records}
      version={records.version.value}
      connected={!records.loading.value && !records.error.value}
      create={(input) => client.mutate(client.api.${entityName}.create, input)}
      ${completionField ? `toggle={(id, value, version) => client.mutate(client.api.${entityName}.toggle, { id, value, version })}` : ""}
      remove={(id, version) => client.mutate(client.api.${entityName}.remove, { id, version })}
      logout={() => client.auth.logout()}
    />
  );
}

hydrate(document.getElementById("app")!, (
  <AuthGate auth={client.auth}><LiveApp /></AuthGate>
));
`;
}

function serverSource(app: AppBlueprint, entityName: string, completionField?: string): string {
  return `/* @clankImportSource clank.run */
import {
  AuthGate,
  authState,
  createApi,
  createApp,
  createAuthClient,
  createObservability,
  html,
  openBackend,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
} from "clank.run";
import { backend } from "./backend.ts";
import { AppView } from "./view.tsx";

const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const root = decodeURIComponent(new URL("./", import.meta.url).pathname);
const frameworkRoot = decodeURIComponent(new URL("../node_modules/clank.run/dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE_PATH ?? environment?.CLANK_DATABASE ?? "app.sqlite";
const runtime = await openBackend(backend, { path: databasePath });
const observability = createObservability({
  serviceName: ${JSON.stringify(app.slug)},
  environment: environment?.NODE_ENV ?? "development",
});
observability.health.register("database", () => {
  runtime.version;
  return true;
});
const api = createApi<typeof backend>();
const appFiles = staticFiles(root);
const frameworkFiles = staticFiles(frameworkRoot, { prefix: "/_clank", cacheControl: "public, max-age=31536000, immutable" });

const app = createApp()
  .use(observability.middleware())
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get(${JSON.stringify(app.deployment.healthPath)}, () => observability.health.response())
  .get("/", async ({ request }) => {
    const caller = await runtime.caller(request);
    if (!caller.auth) throw new Error("Auth runtime is unavailable.");
    const bootAuth = authState(caller.auth);
    const initial = caller.auth.user ? caller.query(api.${entityName}.list) : { value: [], version: runtime.version };
    const authClient = createAuthClient({ initial: bootAuth, immediate: false });
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const page = await renderDocument(
      <AuthGate auth={authClient}>
        <AppView
          user={bootAuth.user!}
          records={initial.value}
          version={initial.version}
          connected={true}
          create={() => {}}
          ${completionField ? "toggle={() => {}}" : ""}
          remove={() => {}}
          logout={() => {}}
        />
      </AuthGate>,
      {
        title: ${JSON.stringify(app.name)},
        bodyClass: "m-0 bg-slate-50 antialiased",
        nonce,
        head: (
          <>
            <script type="importmap" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify({ imports: { clank: "/_clank/index.js" } }) }} />
            <script nonce={nonce} src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
          </>
        ),
        state: { auth: bootAuth, records: initial.value, version: initial.version },
        scripts: ["/app.js"],
      },
    );
    return html(page, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'self'",
          \`script-src 'self' 'nonce-\${nonce}' https://cdn.jsdelivr.net\`,
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
        ].join("; "),
      },
    });
  })
  .get("/app.js", ({ request }) => appFiles.handle(request))
  .get("/view.js", ({ request }) => appFiles.handle(request))
  .get("/_clank/*", ({ request }) => frameworkFiles.handle(request))
  .route("*", "*", ({ request }) => runtime.handle(request));

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 3000),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

observability.logger.info("Application started.", { url: server.url });
`;
}

function schemaSource(field: AppFieldDefinition, wrappers = true): string {
  let source: string;
  const options = {
    ...(field.description ? { description: field.description } : {}),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
  };
  switch (field.type) {
    case "string":
    case "text": source = `s.string(${JSON.stringify(options)})`; break;
    case "number": source = `s.number(${JSON.stringify({ ...options, integer: field.integer ?? false })})`; break;
    case "boolean": source = `s.boolean(${field.description ? JSON.stringify(field.description) : ""})`; break;
    case "email": source = `s.email(${JSON.stringify(options)})`; break;
    case "url": source = `s.url(${JSON.stringify(field.description ? { description: field.description } : {})})`; break;
    case "date": source = `s.date(${field.description ? JSON.stringify(field.description) : ""})`; break;
    case "datetime": source = `s.datetime(${field.description ? JSON.stringify(field.description) : ""})`; break;
    case "enum": source = `s.enum(${JSON.stringify(field.values)} as const${field.description ? `, ${JSON.stringify(field.description)}` : ""})`; break;
    case "reference": source = `s.id(${JSON.stringify(field.entity)}${field.description ? `, ${JSON.stringify(field.description)}` : ""})`; break;
  }
  if (!wrappers) return source;
  if (field.nullable) source = `s.nullable(${source})`;
  if (Object.hasOwn(field, "default")) source = `s.default(${source}, ${JSON.stringify(field.default)})`;
  else if (field.required === false) source = `s.optional(${source})`;
  return source;
}

function createSchemaSource(field: AppFieldDefinition): string {
  if (Object.hasOwn(field, "default")) return `s.default(${schemaSource({ ...field, default: undefined }, false)}, ${JSON.stringify(field.default)})`;
  return schemaSource(field);
}

function defaultFor(field: AppFieldDefinition, name: string): string | number | boolean | null | undefined {
  if (Object.hasOwn(field, "default")) return field.default;
  if (field.required === false) return undefined;
  if (field.nullable) return null;
  if (field.type === "boolean") return false;
  if (field.type === "number") return field.min ?? 0;
  if (field.type === "enum") return field.values![0];
  if (field.type === "reference") return "";
  return humanize(name);
}

function metadataMigration(app: AppBlueprint): string {
  return `CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_metadata (key, value, updated_at)
VALUES ('blueprint', ${sqlString(canonical(app))}, unixepoch() * 1000);
`;
}

function primaryEntity(app: AppBlueprint): string {
  return app.routes.find((route) => route.entity)?.entity ?? Object.keys(app.entities)[0];
}

class DataModuleParser {
  private index = 0;
  constructor(private readonly source: string, private readonly filename: string) {}

  parse(): unknown {
    const match = /\bexport\s+default\b/gu.exec(this.source);
    if (!match) throw this.error("Expected `export default` followed by a data object.");
    this.index = match.index + match[0].length;
    const value = this.value();
    this.space();
    const remainder = this.source.slice(this.index).trim();
    if (
      remainder
      && !/^;$/.test(remainder)
      && !/^(?:as\s+const|satisfies\s+[\s\S]+?);?$/.test(remainder)
    ) throw this.error("Only a data literal and optional `satisfies` or `as const` clause are allowed.");
    return value;
  }

  private value(): unknown {
    this.space();
    const character = this.source[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"' || character === "'") return this.string();
    if (character === "-" || /\d/u.test(character ?? "")) return this.number();
    const word = this.identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    throw this.error(`Unexpected value ${word || character || "at end of file"}.`);
  }

  private object(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    this.index++;
    this.space();
    while (this.source[this.index] !== "}") {
      const key = this.source[this.index] === '"' || this.source[this.index] === "'"
        ? this.string()
        : this.identifier();
      if (!key || typeof key !== "string") throw this.error("Expected an object key.");
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw this.error(`Unsafe object key ${key}.`);
      this.space();
      if (this.source[this.index++] !== ":") throw this.error("Expected `:` after an object key.");
      output[key] = this.value();
      this.space();
      if (this.source[this.index] === ",") {
        this.index++;
        this.space();
        if (this.source[this.index] === "}") break;
      } else if (this.source[this.index] !== "}") {
        throw this.error("Expected `,` or `}`.");
      }
    }
    if (this.source[this.index++] !== "}") throw this.error("Unterminated object.");
    return output;
  }

  private array(): unknown[] {
    const output: unknown[] = [];
    this.index++;
    this.space();
    while (this.source[this.index] !== "]") {
      output.push(this.value());
      this.space();
      if (this.source[this.index] === ",") {
        this.index++;
        this.space();
        if (this.source[this.index] === "]") break;
      } else if (this.source[this.index] !== "]") {
        throw this.error("Expected `,` or `]`.");
      }
    }
    if (this.source[this.index++] !== "]") throw this.error("Unterminated array.");
    return output;
  }

  private string(): string {
    const quote = this.source[this.index++];
    let output = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === quote) return output;
      if (character === "\\") {
        const escaped = this.source[this.index++];
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
        if (escaped === "u") {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw this.error("Invalid Unicode escape.");
          output += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else output += simple[escaped] ?? escaped;
      } else {
        if (character === "\n" || character === "\r") throw this.error("Unterminated string.");
        output += character;
      }
    }
    throw this.error("Unterminated string.");
  }

  private number(): number {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw this.error("Invalid number.");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw this.error("Number must be finite.");
    return value;
  }

  private identifier(): string {
    this.space();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/u);
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  private space(): void {
    while (this.index < this.source.length) {
      if (/\s/u.test(this.source[this.index])) {
        this.index++;
        continue;
      }
      if (this.source.startsWith("//", this.index)) {
        const end = this.source.indexOf("\n", this.index + 2);
        this.index = end === -1 ? this.source.length : end + 1;
        continue;
      }
      if (this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end === -1) throw this.error("Unterminated comment.");
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  private error(reason: string): TypeError {
    const before = this.source.slice(0, this.index);
    const line = before.split("\n").length;
    const column = this.index - before.lastIndexOf("\n");
    return new TypeError(`${this.filename}:${line}:${column}: ${reason}`);
  }
}

function normalizeAccess(value: unknown, roles: Record<string, AppRoleDefinition>, path: string): AppRouteDefinition["access"] {
  if (value === "public" || value === "authenticated") return value;
  const input = object(value, path);
  const allowed = stringArray(input.roles ?? [], `${path}.roles`);
  for (const role of allowed) if (!roles[role]) throw new TypeError(`${path} references unknown role ${role}.`);
  return { roles: allowed };
}

function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  return value as Record<string, any>;
}

function record(value: unknown, path: string): Record<string, unknown> {
  return object(value, path);
}

function text(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  const output = value.trim();
  if (output.length < minimum || output.length > maximum) throw new TypeError(`${path} must contain ${minimum}-${maximum} characters.`);
  return output;
}

function identifier(value: string, kind: string): string {
  if (!NAME.test(value)) throw new TypeError(`Invalid ${kind} name: ${value}.`);
  return value;
}

function slugValue(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw new TypeError("slug must contain lowercase letters, digits, and internal hyphens.");
  }
  return value;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63) || "clank-app";
}

function routePath(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\0")) {
    throw new TypeError(`${path} must be an absolute path without a query or hash.`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean.`);
  return value;
}

function optionalFinite(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite.`);
  return value;
}

function stringArray(value: unknown, path: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`${path} must be an array containing at least ${minimum} non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${path} must be one of: ${values.join(", ")}.`);
  return value as T;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique.`);
}

function property(value: string): string {
  return NAME.test(value) ? value : JSON.stringify(value);
}

function typeName(value: string): string {
  return value.split(/[^A-Za-z0-9]+/u).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("").replace(/s$/u, "") || "Record";
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function fileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "migration";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeTemplate(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
