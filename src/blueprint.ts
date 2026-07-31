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

export interface AppAdminStudioDefinition {
  /** Static route for the generated studio. Defaults to /__clank/studio. */
  path?: string;
  /** Application roles allowed to open the studio. Must be explicit unless owner/admin exists. */
  roles?: readonly string[];
  /** Entity collections shown in the studio. Defaults to every entity. */
  entities?: readonly string[];
  /** Show generated mutation controls. Defaults to true; backend action roles still apply. */
  allowMutations?: boolean;
}

export type AppFixtureValue =
  | string
  | number
  | boolean
  | null
  | { ref: string };

export interface AppFixtureUserDefinition {
  email: string;
  role?: string;
  profile?: { name?: string };
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
  profile: { name?: string };
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
  admin?: false | AppAdminStudioDefinition;
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
  admin: false | {
    path: string;
    roles: readonly string[];
    entities: readonly string[];
    allowMutations: boolean;
  };
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

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const ACTION_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MIGRATION_ID = /^\d{4}$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const RESERVED_API_SEGMENTS = new Set(["path", "then"]);

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
  options: { frameworkVersion?: string; frameworkDependency?: string } = {},
): GeneratedAppFile[] {
  const app = normalizeApp(input);
  const frameworkVersion = options.frameworkVersion ?? "latest";
  const frameworkDependency = options.frameworkDependency
    ?? (frameworkVersion === "latest" ? "latest" : `^${frameworkVersion}`);
  const files: GeneratedAppFile[] = [
    {
      path: ".gitignore",
      contents: "dist/\n.clank/\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n.env\n.env.*\n",
    },
    {
      path: "AGENTS.md",
      contents: agentGuide(app),
    },
    {
      path: "README.md",
      contents: projectReadme(app),
    },
    {
      path: "package.json",
      contents: json({
        name: app.slug,
        private: true,
        type: "module",
        scripts: {
          build: "clank build src dist --tailwind=src/styles.css",
          dev: "clank dev",
          test: "npm run build && node --disable-warning=ExperimentalWarning --test tests/app.contract.mjs",
          "test:watch": "npm run build && node --disable-warning=ExperimentalWarning --test --watch tests/app.contract.mjs",
          "test:journey": "clank journey journeys/smoke.json",
          start: "node --disable-warning=ExperimentalWarning dist/server.js",
          plan: "clank plan",
          generate: "clank generate .",
          doctor: "clank doctor",
          "deploy:check": "clank deploy --dry-run",
          deploy: "clank deploy",
        },
        dependencies: { "@clank.run/framework": frameworkDependency },
        devDependencies: {
          "@tailwindcss/cli": "^4.2.4",
          tailwindcss: "^4.2.4",
        },
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
      contents: `export default ${sourceLiteral(app, 2)} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;\n`,
    },
    {
      path: "clank.deploy.json",
      contents: json({
        version: 1,
        entry: "dist/server.js",
        include: ["dist", "migrations"],
        build: { command: ["clank", "build", "src", "dist", "--tailwind=src/styles.css"] },
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
      path: "journeys/smoke.json",
      contents: json({
        name: `${app.name} smoke journey`,
        description: "Verify the server-rendered application shell in a real browser.",
        start: app.routes[0]!.path,
        viewport: { width: 390, height: 844 },
        steps: [{ expect: { text: app.name } }],
      }),
    },
    {
      path: "src/backend.ts",
      contents: backendSource(app),
    },
    {
      path: "src/styles.css",
      contents: '@import "tailwindcss";\n@source "./**/*.{ts,tsx}";\n',
    },
    {
      path: "src/view.tsx",
      contents: viewSource(app),
    },
    {
      path: "src/app.tsx",
      contents: browserSource(app),
    },
    {
      path: "src/server.tsx",
      contents: serverSource(app),
    },
    {
      path: "src/service-requirements.ts",
      contents: serviceRequirementsSource(app),
    },
    {
      path: "src/services.ts",
      contents: servicesSource(app),
    },
    {
      path: "tests/app.contract.mjs",
      contents: generatedTestSource(app),
    },
  ];
  for (const fixture of Object.values(app.fixtures)) {
    files.push({
      path: `fixtures/${fileName(fixture.name)}.json`,
      contents: json(fixture),
    });
  }
  for (const migration of app.migrations) {
    files.push({
      path: `migrations/${migration.id}_${fileName(migration.name)}.sql`,
      contents: `${migration.sql.trim()}\n`,
    });
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function serviceRequirementsSource(app: AppBlueprint): string {
  const requirements = Object.entries(app.services).map(([name, service]) => ({
    name,
    kind: service.kind,
    capabilities: service.capabilities ?? [],
    required: service.required ?? false,
  }));
  return `import type { ServiceRegistry, ServiceRequirement } from "@clank.run/framework/services";

export const serviceRequirements = ${sourceLiteral(requirements, 2)} as const satisfies readonly ServiceRequirement[];

export function assertServices(services: ServiceRegistry): void {
  services.assert(serviceRequirements);
}
`;
}

function servicesSource(app: AppBlueprint): string {
  const drivers = Object.entries(app.services).map(([name, service]) => `    {
      name: ${sourceLiteral(name)},
      kind: ${sourceLiteral(service.kind)},
      capabilities: ${sourceLiteral(service.capabilities ?? [])},
      service: Object.freeze({
        development: true,
        name: ${sourceLiteral(name)},
        kind: ${sourceLiteral(service.kind)},
      }),
      health: async () => ({ ok: true }),
    }`).join(",\n");
  return `import {
  createServiceRegistry,
  type ServiceDriver,
  type ServiceRegistry,
} from "@clank.run/framework/services";
import { assertServices } from "./service-requirements.ts";

/**
 * Replace or extend this function with real production drivers. Local drivers
 * exist only under clank dev so a missing required integration fails closed
 * during production startup instead of silently discarding work.
 */
export async function openAppServices(
  environment: Record<string, string | undefined>,
): Promise<ServiceRegistry> {
  const drivers: ServiceDriver[] = environment.CLANK_DEV === "1"
    ? [
${drivers}
      ]
    : [];
  const services = createServiceRegistry(drivers);
  assertServices(services);
  return services;
}
`;
}

function generatedTestSource(app: AppBlueprint): string {
  const nodeProtocol = "node:";
  const actions = Object.entries(app.entities).flatMap(([entityName, entity]) =>
    generatedEntityActions(app, entityName, entity).map((action) => ({
      path: `${entityName}.${action.localName}`,
      entity: entityName,
      behavior: action.behavior,
      roles: action.roles,
    })));
  const roles = Object.keys(app.auth.roles);
  const renderedRoutes = [
    ...app.routes.map((route) => ({
      path: route.path,
      label: humanize(route.view),
      roles: typeof route.access === "object" ? route.access.roles ?? [] : [],
      entities: route.entity ? [route.entity] : [],
      allowMutations: true,
      admin: false,
    })),
    ...(app.admin ? [{
      path: app.admin.path,
      label: "Admin Studio",
      roles: app.admin.roles,
      entities: app.admin.entities,
      allowMutations: app.admin.allowMutations,
      admin: true,
    }] : []),
  ];
  const uiActions = actions.filter((action) => {
    if (!["create", "toggle", "delete", "restore"].includes(action.behavior)) return false;
    return renderedRoutes.some((route) => {
      if (!route.allowMutations || !route.entities.includes(action.entity)) return false;
      const routeRoles = route.roles.length ? route.roles : roles;
      const actionRoles = action.roles.length ? action.roles : roles;
      return routeRoles.some((role) => actionRoles.includes(role));
    });
  }).map((action) => action.path);
  const contract = {
    app: {
      name: app.name,
      defaultRole: Object.keys(app.auth.roles)[0],
      roles,
    },
    actions,
    entities: Object.fromEntries(Object.entries(app.entities).map(([name, entity]) => [name, {
      ownership: entity.ownership,
      displayField: entity.displayField,
      completionField: entity.completionField ?? null,
      history: Boolean(app.admin && app.admin.entities.includes(name)),
      sample: viewRecordSample(name, entity),
    }])),
    routes: renderedRoutes,
    uiActions,
    fixtures: Object.values(app.fixtures).map((fixture) => ({
      name: fixture.name,
      file: `../fixtures/${fileName(fixture.name)}.json`,
      order: fixtureRecordOrder(fixture, app.entities),
    })),
  };
  return `import test from "${nodeProtocol}test";
import assert from "${nodeProtocol}assert/strict";
import { readFile } from "${nodeProtocol}fs/promises";
import {
  assertAgentActionParity,
  inspectAgentActions,
  openBackend,
  renderToString,
} from "@clank.run/framework";
import { backend } from "../dist/backend.js";
import { AppView } from "../dist/view.js";

const contract = ${sourceLiteral(contract, 2)};
const password = "fixture-password-123";

function viewProps(route, role) {
  const props = {
    route: route.path,
    user: {
      id: "fixture_user",
      email: "fixture@example.invalid",
      emailVerified: true,
      role,
      profile: { name: "Fixture User" },
      createdAt: 1,
      updatedAt: 1,
    },
    version: 0,
    connected: true,
    pending: false,
    error: "",
    studioReadOnly: false,
    logout: () => {},
  };
  for (const [entityName, entity] of Object.entries(contract.entities)) {
    props[\`\${entityName}Records\`] = [{ ...entity.sample, _version: entity.history ? 2 : entity.sample._version }];
    props[\`\${entityName}Version\`] = 0;
    props[\`\${entityName}Create\`] = async () => true;
    if (entity.completionField) props[\`\${entityName}Toggle\`] = async () => true;
    props[\`\${entityName}Remove\`] = async () => true;
    if (entity.history) {
      props[\`\${entityName}Revisions\`] = [{
        cursor: { revision: 1, sequence: 0 },
        operation: "create",
        recordedAt: 1,
        document: entity.sample,
      }];
      props[\`\${entityName}RefreshHistory\`] = async () => {};
      props[\`\${entityName}Restore\`] = async () => true;
    }
  }
  return props;
}

test("agent manifest exposes the generated backend contract", async () => {
  const runtime = await openBackend(backend, { path: ":memory:", wal: false });
  try {
    const response = await runtime.handle(new Request("https://fixture.test/__clank/manifest"));
    assert.equal(response.status, 200);
    const manifest = await response.json();
    const actual = manifest.functions
      .filter((entry) => entry.agent)
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(actual, contract.actions.map((action) => action.path).sort());
  } finally {
    runtime.close();
  }
});

for (const route of contract.routes) {
  test(\`server-rendered route \${route.path}\`, async () => {
    const role = route.roles[0] ?? contract.app.defaultRole;
    const html = await renderToString(AppView(viewProps(route, role)));
    assert.match(html, new RegExp(escapeRegExp(contract.app.name)));
    assert.match(html, new RegExp(escapeRegExp(route.label)));
    if (route.admin) assert.match(html, /Schema and data operations/u);
  });
}

test("rendered server actions match the current MCP-derived backend manifest", async () => {
  const runtime = await openBackend(backend, { path: ":memory:", wal: false });
  try {
    const response = await runtime.handle(new Request("https://fixture.test/__clank/manifest"));
    assert.equal(response.status, 200);
    const manifest = await response.json();
    const revision = response.headers.get("x-clank-contract-revision");
    const renderedActions = new Set();
    for (const route of contract.routes) {
      for (const role of contract.app.roles) {
        if (route.roles.length && !route.roles.includes(role)) continue;
        const html = await renderToString(AppView(viewProps(route, role)));
        const controls = inspectAgentActions(html);
        assertAgentActionParity(controls, manifest, { expectedRevision: revision });
        for (const control of controls) renderedActions.add(control.path);
      }
    }
    assert.deepEqual(
      [...new Set(contract.uiActions)].filter((action) => !renderedActions.has(action)),
      [],
      "every required server action must appear in at least one allowed route and role surface",
    );
  } finally {
    runtime.close();
  }
});

for (const fixtureContract of contract.fixtures) {
  test(\`fixture \${fixtureContract.name} seeds valid, isolated application data\`, async () => {
    const fixture = JSON.parse(await readFile(new URL(fixtureContract.file, import.meta.url), "utf8"));
    assert.equal(fixture.protocol, "clank-fixture/1");
    assert.equal(fixture.name, fixtureContract.name);
    const runtime = await openBackend(backend, { path: ":memory:", wal: false });
    try {
      const users = {};
      for (const [name, definition] of Object.entries(fixture.users)) {
        users[name] = await register(runtime, definition);
        runtime.auth.setRole(users[name].user.id, definition.role);
      }
      const created = {};
      for (const key of fixtureContract.order) {
        const separator = key.indexOf(".");
        const entityName = key.slice(0, separator);
        const recordName = key.slice(separator + 1);
        const definition = fixture.records[entityName][recordName];
        const owner = users[definition.owner];
        const action = actionFor(entityName, "create");
        setActionRole(runtime, owner.user.id, action, fixture.users[definition.owner].role);
        const caller = await runtime.caller(authRequest("/", owner.cookie));
        const input = resolveValues(definition.values, created);
        created[key] = caller.mutation(action.path, input).value;
      }
      restoreRoles(runtime, users, fixture.users);

      for (const [entityName, records] of Object.entries(fixture.records)) {
        const action = actionFor(entityName, "list");
        for (const [recordName, definition] of Object.entries(records)) {
          const owner = users[definition.owner];
          setActionRole(runtime, owner.user.id, action, fixture.users[definition.owner].role);
          const caller = await runtime.caller(authRequest("/", owner.cookie));
          const visible = caller.query(action.path, {}).value;
          const stored = visible.find((entry) => entry._id === created[\`\${entityName}.\${recordName}\`]);
          assert.ok(stored, \`\${entityName}.\${recordName} must be visible to its fixture owner\`);
          const expected = resolveValues(definition.values, created);
          for (const [field, value] of Object.entries(expected)) assert.deepEqual(stored[field], value);
        }
      }
      restoreRoles(runtime, users, fixture.users);

      const outsider = await register(runtime, {
        email: outsiderEmail(fixture),
        role: contract.app.defaultRole,
        profile: { name: "Fixture Outsider" },
      });
      for (const [entityName, entity] of Object.entries(contract.entities)) {
        const action = actionFor(entityName, "list");
        setActionRole(runtime, outsider.user.id, action, contract.app.defaultRole);
        const caller = await runtime.caller(authRequest("/", outsider.cookie));
        const visible = caller.query(action.path, {}).value;
        const fixtureCount = Object.keys(fixture.records[entityName] ?? {}).length;
        assert.equal(
          visible.length,
          entity.ownership === "public" ? fixtureCount : 0,
          \`\${entityName} ownership visibility\`,
        );
      }
    } finally {
      runtime.close();
    }
  });
}

function actionFor(entity, behavior) {
  const action = contract.actions.find((entry) => entry.entity === entity && entry.behavior === behavior);
  assert.ok(action, \`Missing generated \${behavior} action for \${entity}\`);
  return action;
}

function setActionRole(runtime, userId, action, fallback) {
  runtime.auth.setRole(userId, action.roles[0] ?? fallback);
}

function restoreRoles(runtime, users, definitions) {
  for (const [name, user] of Object.entries(users)) runtime.auth.setRole(user.user.id, definitions[name].role);
}

function outsiderEmail(fixture) {
  const used = new Set(Object.values(fixture.users).map((user) => user.email.toLowerCase()));
  let suffix = 0;
  while (true) {
    const candidate = \`outsider-\${fixture.name}\${suffix ? \`-\${suffix}\` : ""}@example.invalid\`.toLowerCase();
    if (!used.has(candidate)) return candidate;
    suffix++;
  }
}

function resolveValues(values, created) {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [
    field,
    value && typeof value === "object" ? created[value.ref] : value,
  ]));
}

function authRequest(path, cookie, body) {
  return new Request(\`https://fixture.test\${path}\`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin: "https://fixture.test",
      }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function register(runtime, definition) {
  const response = await runtime.handle(authRequest("/__clank/auth/register", undefined, {
    email: definition.email,
    password,
    profile: definition.profile,
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    user: payload.user,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/gu, "\\\\$&");
}
`;
}

function viewRecordSample(
  entityName: string,
  entity: AppEntityDefinition,
): Record<string, AppFixtureValue | number | string> {
  const values: Record<string, AppFixtureValue | number | string> = {
    _id: `${entityName}_fixture_record`,
    _creationTime: 1,
    _version: 1,
    _ownerId: "fixture_user",
  };
  for (const [fieldName, field] of Object.entries(entity.fields)) {
    if (Object.hasOwn(field, "default")) {
      values[fieldName] = field.default!;
    } else if (field.nullable) {
      values[fieldName] = null;
    } else if (field.type === "reference") {
      values[fieldName] = `${field.entity}_fixture_record`;
    } else {
      values[fieldName] = fixtureFieldSample(entityName, fieldName, field);
    }
  }
  return values;
}

export async function createAppPlan(
  input: AppBlueprintInput | AppBlueprint,
  options: { frameworkVersion?: string; frameworkDependency?: string } = {},
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
      routes: blueprint.routes.length + (blueprint.admin ? 1 : 0),
      actions: Object.keys(blueprint.actions).length,
      services: Object.keys(blueprint.services).length,
      migrations: blueprint.migrations.length + 1,
      fixtures: Object.keys(blueprint.fixtures).length,
    },
    warnings,
    files: plannedFiles,
  };
  return deepFreeze({ ...unsigned, digest: await sha256(canonical(unsigned)) });
}

function projectReadme(app: AppBlueprint): string {
  const routes = app.routes.map((route) =>
    `- \`${route.path}\` — ${humanize(route.view)}${route.entity ? ` over \`${route.entity}\`` : ""}; ${routeAccessLabel(route.access)}.`)
    .concat(app.admin ? [`- \`${app.admin.path}\` — Generated Admin Studio over ${app.admin.entities.map((name) => `\`${name}\``).join(", ")}; roles ${app.admin.roles.map((role) => `\`${role}\``).join(", ")}; ${app.admin.allowMutations ? "role-checked mutation controls" : "read-only"}.`] : [])
    .join("\n");
  const entities = Object.entries(app.entities).map(([name, entity]) =>
    `- \`${name}\` — ${entity.description} ${entity.ownership} ownership; ${entity.realtime ? "live subscription" : "request/response refresh"}; ${Object.keys(entity.fields).length} fields.`).join("\n");
  const actions = Object.entries(app.actions).map(([name, action]) =>
    `- \`${name}\` — ${action.description} ${action.behavior ? `Generated as \`${action.behavior}\`` : "Manual implementation required"}${action.roles?.length ? `; roles: ${action.roles.map((role) => `\`${role}\``).join(", ")}` : ""}.`).join("\n");
  const relationships = app.relationships.length
    ? app.relationships.map((relationship) =>
      `- \`${relationship.name}\` — ${relationship.from} → ${relationship.to}; ${relationship.kind}; \`${relationship.onDelete}\` on delete${relationship.reference ? ` through \`${relationship.reference.entity}.${relationship.reference.field}\`` : "; no generated reference enforcement"}.`).join("\n")
    : "- None declared.";
  const services = Object.keys(app.services).length
    ? Object.entries(app.services).map(([name, service]) =>
      `- \`${name}\` — ${service.kind}${service.required ? ", required" : ", optional"}; ${service.description}`).join("\n")
    : "- None declared.";
  return `# ${app.name}

${app.description}

This is a full-stack Clank application with built-in authentication, SQLite migrations, server rendering, hydration, and live synchronization.

## Start

\`\`\`sh
npm install
npm run dev
\`\`\`

Open http://127.0.0.1:3000. The first person can register, then each signed-in user receives isolated application data.

## Generated application contract

### Routes

${routes}

### Entities

${entities}

### Server actions

${actions || "- Safe CRUD actions are generated from each entity."}

The browser and each app's MCP endpoint call the same generated backend functions. Authorization
is enforced inside those functions; hiding a control is only a usability aid.

### Relationships

${relationships}

### Services

${services}

\`clank dev\` supplies explicit local-only service drivers. Required services fail production
startup until \`src/services.ts\` is wired to real drivers, so email, jobs, files, or webhooks are
never silently discarded.

## Check and deploy

\`\`\`sh
npm run build
npm run doctor
npm run deploy:check
clank login
npm run deploy
\`\`\`

\`clank login\` defaults to https://clank.run; pass \`--server\` only for an explicitly
self-hosted control plane. The first deployment creates and links the remote project
automatically. See \`AGENTS.md\` for the file map and invariants an agent should preserve.

## Test

\`\`\`sh
npm test
\`\`\`

The generated suite builds the application, loads every deterministic fixture under
\`fixtures/\` into an isolated in-memory database, verifies the exact agent manifest,
checks ownership isolation, server-renders every declared route and the enabled admin studio, and proves each rendered
server-action control resolves to a current, described MCP-visible backend function. Fixture
data is test-only and is never included in a deployment artifact.

With \`npm run dev\` running, \`npm run test:journey\` replays the generated mobile smoke journey
in an isolated Chrome profile. Add semantic controls with stable \`agentId\` values, then extend
\`journeys/smoke.json\` without CSS selectors. Put login credentials in environment-backed secret
references such as \`{ "env": "CLANK_TEST_PASSWORD" }\`; never commit their values.
`;
}

function agentGuide(app: AppBlueprint): string {
  return `# Agent guide

This repository is a Clank application generated from \`clank.app.ts\`. Prefer small, reviewable changes and keep the app deployable after every task.

## Working commands

- \`npm run dev\` builds, starts, watches, health-swaps, and browser-reloads the app at http://127.0.0.1:3000.
- \`npm test\` builds and runs the generated app contract against isolated in-memory databases.
- \`npm run test:watch\` reruns the generated contract while application tests are being edited.
- \`npm run test:journey\` replays the generated semantic mobile smoke journey in real Chrome while the dev server is running.
- \`npm run build\` compiles \`src/\` into \`dist/\`.
- \`npm run doctor\` performs local readiness diagnostics.
- \`npm run deploy:check\` builds and verifies a deterministic artifact without login or upload.
- \`npm run deploy\` builds, creates/links the project when needed, runs migrations, health-checks, and activates it.
- \`clank help --json\` exposes the CLI contract for automation.

## File map

- \`clank.app.ts\`: reviewable app blueprint; change it before regenerating architecture.
- \`src/backend.ts\`: schemas, owned data, queries, mutations, and authorization.
- \`src/view.tsx\`: accessible server/client UI and agent-addressable controls.
- \`src/app.tsx\`: hydration, auth client, live queries, and browser interactions.
- \`src/server.tsx\`: routes, SSR, CSP, static files, and API wiring.
- \`src/service-requirements.ts\`: normalized external capability contract.
- \`src/services.ts\`: local development drivers and production provisioning boundary.
- \`fixtures/\`: deterministic, non-production example users and records owned by the blueprint.
- \`tests/app.contract.mjs\`: application-owned backend, fixture, isolation, manifest, and SSR contract.
- \`journeys/\`: data-only real-browser flows addressed by stable \`agentId\` values, not CSS selectors.
- \`migrations/\`: immutable, ordered SQL history.
- \`clank.deploy.json\`: build, artifact, database, health, and public environment contract.
- \`.clank/\`: local plans, artifacts, and project link; never commit it.

## Invariants

- Preserve ownership and authorization on every private ${Object.keys(app.entities).join(", ")} operation.
- Treat all browser, agent, webhook, and model input as untrusted and validate it at the boundary.
- Model every UI operation that reads or persists server state as a \`src/backend.ts\` query or mutation, then call that same typed function from \`src/app.tsx\`; never create a UI-only server action that MCP cannot discover.
- Pass the typed \`createApi<typeof backend>()\` function reference to each server-backed control's \`agentAction\`; do not duplicate its path as a string.
- When UI behavior changes, update the shared backend function name, schema, \`description\`, and \`agent\` metadata in the same change. The agent-enabled paths in \`GET /__clank/manifest\` and authenticated MCP \`tools/list\` must remain identical.
- Give every backend function a precise \`description\`; mark additive writes with \`agent: { destructive: false }\`, destructive writes explicitly, and internal functions with \`agent: false\`.
- Preserve the default MCP endpoint and OAuth flow unless the application has a documented integration reason to change them.
- Preserve the admin studio role boundary and entity allowlist. Its controls must keep using the same typed backend actions and may never bypass backend role checks.
- Never edit, rename, or remove an applied migration; add the next numbered migration.
- Keep secrets out of source, \`clank.deploy.json\`, labels, logs, plans, and agent metadata. Use \`clank secrets set\`.
- Add stable \`agentId\` and useful \`agentLabel\` values to important controls without exposing secret values.
- Keep browser journeys aligned with visible product behavior. Reference login secrets as \`{ "env": "NAME" }\`; never put secret values in a journey.
- Keep the health route cheap and independent of optional external services.
- Do not hand-edit \`dist/\`; it is generated by \`npm run build\`.
- Keep fixtures deterministic, synthetic, and secret-free. Use \`.example.invalid\` identities and
  never copy production data into \`fixtures/\`.

## Definition of done

Run \`npm test\`, \`npm run doctor\`, and \`npm run deploy:check\`. With the development server running, run \`npm run test:journey\`. The generated contract rejects stale UI↔MCP action references. For UI changes, extend the semantic journey to cover registration/login and the main interaction at mobile and desktop sizes. For data changes, update the deterministic fixtures and verify a fresh database plus an existing migrated database. For backend changes, compare agent-enabled \`GET /__clank/manifest\` paths with authenticated \`tools/list\`, verify the contract revision changed, reconnect an existing MCP session, and verify the narrowest OAuth scope that can perform the action.
`;
}

function routeAccessLabel(access: AppRouteDefinition["access"]): string {
  if (access === "public") return "public shell";
  if (access === "authenticated") return "authenticated";
  return `roles ${access.roles?.map((role) => `\`${role}\``).join(", ")}`;
}

export function explainApp(input: AppBlueprintInput | AppBlueprint): string {
  const app = normalizeApp(input);
  const lines = [
    `${app.name} (${app.slug})`,
    app.description,
    "",
    `Authentication: ${app.auth.required ? "required" : "optional"}; organizations ${app.auth.organizations ? "enabled" : "disabled"}.`,
    `Data: ${Object.keys(app.entities).length} entities, ${app.relationships.length} relationships, ${app.deployment.database}.`,
    `Interface: ${app.routes.length} product routes${app.admin ? ` plus an admin studio at ${app.admin.path} for ${app.admin.roles.join(", ")}` : " with the admin studio disabled"}, and ${Object.keys(app.actions).length} declared actions.`,
    `Verification: ${Object.keys(app.fixtures).length} deterministic fixture${Object.keys(app.fixtures).length === 1 ? "" : "s"} plus generated backend and SSR contract tests.`,
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
    if (RESERVED_API_SEGMENTS.has(entityName)) {
      throw new TypeError(`Entity name ${entityName} conflicts with the typed API reference protocol.`);
    }
    const entity = object(raw, `entities.${entityName}`);
    const fieldsInput = record(entity.fields, `entities.${entityName}.fields`);
    if (!Object.keys(fieldsInput).length) throw new TypeError(`Entity ${entityName} requires fields.`);
    const fields: Record<string, AppFieldDefinition> = {};
    for (const [fieldName, fieldRaw] of Object.entries(fieldsInput)) {
      identifier(fieldName, "field");
      fields[fieldName] = normalizeField(fieldRaw, `${entityName}.${fieldName}`);
    }
    const displayField = text(entity.displayField, `${entityName}.displayField`, 1, 100);
    if (!Object.hasOwn(fields, displayField)) throw new TypeError(`${entityName}.displayField references an unknown field.`);
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
      unique(fieldsForIndex, `${entityName}.indexes.${indexName}.fields`);
      for (const field of fieldsForIndex) if (!Object.hasOwn(fields, field)) throw new TypeError(`Index ${entityName}.${indexName} references unknown field ${field}.`);
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
      if (field.type === "reference" && !Object.hasOwn(entities, field.entity!)) {
        throw new TypeError(`Reference ${entityName}.${fieldName} targets unknown entity ${field.entity}.`);
      }
    }
  }
  const generatedTypeNames = new Map<string, string>();
  for (const entityName of Object.keys(entities)) {
    const generated = typeName(entityName);
    const existing = generatedTypeNames.get(generated);
    if (existing) {
      throw new TypeError(`Entities ${existing} and ${entityName} both generate the type name ${generated}.`);
    }
    generatedTypeNames.set(generated, entityName);
  }

  const roles: Record<string, AppRoleDefinition> = {};
  for (const [roleName, roleRaw] of Object.entries(record(input.auth?.roles ?? {}, "auth.roles"))) {
    identifier(roleName, "role");
    const role = object(roleRaw, `auth.roles.${roleName}`);
    const permissions = stringArray(role.permissions, `auth.roles.${roleName}.permissions`);
    unique(permissions, `auth.roles.${roleName}.permissions`);
    roles[roleName] = {
      description: text(role.description, `auth.roles.${roleName}.description`, 1, 300),
      permissions,
    };
  }
  if (!roles.member) roles.member = { description: "Standard application member.", permissions: ["app.use"] };
  if (input.auth?.required === false) {
    throw new TypeError("Generated Clank applications currently require built-in authentication.");
  }

  const inferredAdminRoles = ["owner", "admin"].filter((role) => Object.hasOwn(roles, role));
  let admin: AppBlueprint["admin"] = false;
  if (input.admin !== false && (input.admin !== undefined || inferredAdminRoles.length > 0)) {
    const definition = object(input.admin ?? {}, "admin");
    const adminRoles = definition.roles === undefined
      ? inferredAdminRoles
      : stringArray(definition.roles, "admin.roles", 1);
    if (adminRoles.length === 0) {
      throw new TypeError("admin.roles is required when the app has no owner or admin role.");
    }
    unique(adminRoles, "admin.roles");
    for (const role of adminRoles) {
      if (!Object.hasOwn(roles, role)) throw new TypeError(`admin.roles references unknown role ${role}.`);
    }
    const adminEntities = definition.entities === undefined
      ? Object.keys(entities)
      : stringArray(definition.entities, "admin.entities", 1);
    unique(adminEntities, "admin.entities");
    for (const entity of adminEntities) {
      if (!Object.hasOwn(entities, entity)) throw new TypeError(`admin.entities references unknown entity ${entity}.`);
    }
    const path = routePath(definition.path ?? "/__clank/studio", "admin.path");
    if (
      path === "/__clank"
      || (path.startsWith("/__clank/") && path !== "/__clank/studio")
      || path === "/_clank"
      || path.startsWith("/_clank/")
      || ["/app.js", "/view.js", "/styles.css"].includes(path)
    ) {
      throw new TypeError(`Admin studio path ${path} conflicts with a generated framework endpoint.`);
    }
    admin = {
      path,
      roles: adminRoles,
      entities: adminEntities,
      allowMutations: booleanValue(definition.allowMutations ?? true, "admin.allowMutations"),
    };
  }

  const relationships = (input.relationships ?? []).map((raw, index) => {
    const relation = object(raw, `relationships.${index}`);
    const from = text(relation.from, `relationships.${index}.from`, 1, 100);
    const to = text(relation.to, `relationships.${index}.to`, 1, 100);
    if (!Object.hasOwn(entities, from) || !Object.hasOwn(entities, to)) throw new TypeError(`Relationship ${index} references an unknown entity.`);
    const onDelete = enumValue(relation.onDelete ?? "restrict", ["restrict", "cascade", "nullify"], `relationships.${index}.onDelete`);
    const reference = normalizeRelationshipReference(relation.reference, entities, from, to, `relationships.${index}.reference`);
    if (!reference) {
      throw new TypeError(`Relationship ${index} requires an explicit reference because no single reference field can be inferred.`);
    }
    if (reference && entities[reference.entity].ownership !== entities[referenceTarget(entities, reference)].ownership) {
      throw new TypeError(`Relationship ${index} cannot enforce deletion across different ownership scopes.`);
    }
    if (onDelete === "nullify" && reference && !entities[reference.entity].fields[reference.field].nullable) {
      throw new TypeError(`Relationship ${index} uses nullify but ${reference.entity}.${reference.field} is not nullable.`);
    }
    return {
      name: identifier(text(relation.name, `relationships.${index}.name`, 1, 100), "relationship"),
      from,
      to,
      kind: enumValue(relation.kind, ["one-to-one", "one-to-many", "many-to-many"], `relationships.${index}.kind`),
      onDelete,
      ...(reference ? { reference } : {}),
    } as AppRelationshipDefinition;
  });
  unique(relationships.map((relation) => relation.name), "relationship names");
  assertAcyclicCascadeRelationships(relationships, entities);

  if (!Array.isArray(input.routes) || input.routes.length === 0) throw new TypeError("App blueprint requires at least one route.");
  const routes = input.routes.map((raw, index) => {
    const route = object(raw, `routes.${index}`);
    const path = routePath(route.path, `routes.${index}.path`);
    if (
      path === "/app.js"
      || path === "/view.js"
      || path === "/styles.css"
      || path === "/_clank"
      || path.startsWith("/_clank/")
      || path === "/__clank"
      || path.startsWith("/__clank/")
    ) {
      throw new TypeError(`Route ${path} conflicts with a generated framework endpoint.`);
    }
    const entity = route.entity === undefined ? undefined : text(route.entity, `routes.${index}.entity`, 1, 100);
    if (entity && !Object.hasOwn(entities, entity)) throw new TypeError(`Route ${path} references unknown entity ${entity}.`);
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
    if (entity && !Object.hasOwn(entities, entity)) throw new TypeError(`Action ${actionName} references unknown entity ${entity}.`);
    if (entity && !actionName.startsWith(`${entity}.`)) {
      throw new TypeError(`Action ${actionName} must start with its entity name (${entity}.).`);
    }
    if (entity && actionName.slice(entity.length + 1).includes(".")) {
      throw new TypeError(`Action ${actionName} must contain one entity segment and one action segment.`);
    }
    const localActionName = entity ? actionName.slice(entity.length + 1) : actionName;
    if (entity && !ACTION_SEGMENT.test(localActionName)) {
      throw new TypeError(`Action ${actionName} must end with a non-empty action identifier.`);
    }
    if (RESERVED_API_SEGMENTS.has(localActionName)) {
      throw new TypeError(`Action ${actionName} conflicts with the typed API reference protocol.`);
    }
    const operation = enumValue(action.operation, ["create", "read", "update", "delete", "custom"], `${actionName}.operation`);
    const behavior = normalizeActionBehavior(
      action.behavior,
      operation,
      actionName,
      entity ? entities[entity] : undefined,
      `${actionName}.behavior`,
    );
    const actionRoles = stringArray(action.roles ?? [], `${actionName}.roles`);
    unique(actionRoles, `${actionName}.roles`);
    for (const role of actionRoles) if (!Object.hasOwn(roles, role)) throw new TypeError(`Action ${actionName} references unknown role ${role}.`);
    actions[actionName] = {
      description: text(action.description, `${actionName}.description`, 1, 500),
      ...(entity ? { entity } : {}),
      operation,
      ...(behavior ? { behavior } : {}),
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
    const capabilities = stringArray(service.capabilities ?? [], `${serviceName}.capabilities`);
    unique(capabilities, `${serviceName}.capabilities`);
    services[serviceName] = {
      kind: enumValue(service.kind, ["files", "images", "email", "jobs", "cron", "search", "webhooks", "custom"], `${serviceName}.kind`),
      description: text(service.description, `${serviceName}.description`, 1, 500),
      required: booleanValue(service.required ?? false, `${serviceName}.required`),
      capabilities,
    };
  }

  const fixtures = normalizeFixtures(input.fixtures, {
    slug,
    entities,
    roles,
  });

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
    fixtures,
    admin,
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
  if (routes.some((route) => route.path === normalized.deployment.healthPath)) {
    throw new TypeError(`Health path ${normalized.deployment.healthPath} conflicts with an application route.`);
  }
  if (normalized.admin && routes.some((route) => route.path === normalized.admin.path)) {
    throw new TypeError(`Admin studio path ${normalized.admin.path} conflicts with an application route.`);
  }
  if (normalized.admin && normalized.admin.path === normalized.deployment.healthPath) {
    throw new TypeError(`Admin studio path ${normalized.admin.path} conflicts with the health route.`);
  }
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
  if (
    type === "number"
    && field.integer === true
    && min !== undefined
    && max !== undefined
    && Math.ceil(min) > Math.floor(max)
  ) {
    throw new TypeError(`${path} has no integer value between min and max.`);
  }
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

function normalizeFixtures(
  raw: AppBlueprintInput["fixtures"],
  app: {
    slug: string;
    entities: Record<string, AppEntityDefinition>;
    roles: Record<string, AppRoleDefinition>;
  },
): Record<string, AppFixture> {
  fixtureEntityOrder(app.entities);
  const supplied = record(raw ?? {}, "fixtures");
  const inputs = Object.keys(supplied).length
    ? supplied
    : { default: defaultFixtureDefinition(app) };
  if (Object.keys(inputs).length > 20) throw new TypeError("fixtures must contain at most 20 named fixtures.");
  const fixtures: Record<string, AppFixture> = {};
  const fixturePaths = new Set<string>();
  for (const [fixtureName, fixtureRaw] of Object.entries(inputs)) {
    identifier(fixtureName, "fixture");
    const fixturePath = fileName(fixtureName);
    if (fixturePaths.has(fixturePath)) {
      throw new TypeError(`Fixture names must generate unique file names; ${fixtureName} conflicts with another fixture.`);
    }
    fixturePaths.add(fixturePath);
    const fixture = object(fixtureRaw, `fixtures.${fixtureName}`);
    const userInputs = record(fixture.users ?? {}, `fixtures.${fixtureName}.users`);
    if (Object.keys(userInputs).length === 0) {
      throw new TypeError(`fixtures.${fixtureName}.users requires at least one synthetic user.`);
    }
    if (Object.keys(userInputs).length > 10) {
      throw new TypeError(`fixtures.${fixtureName}.users must contain at most 10 users.`);
    }
    const users: Record<string, AppFixtureUser> = {};
    const emails = new Set<string>();
    for (const [userName, userRaw] of Object.entries(userInputs)) {
      identifier(userName, "fixture user");
      const user = object(userRaw, `fixtures.${fixtureName}.users.${userName}`);
      const email = fixtureEmail(user.email, `fixtures.${fixtureName}.users.${userName}.email`);
      const normalizedEmail = email.toLowerCase();
      if (emails.has(normalizedEmail)) {
        throw new TypeError(`fixtures.${fixtureName}.users email addresses must be unique.`);
      }
      emails.add(normalizedEmail);
      const role = user.role === undefined
        ? Object.keys(app.roles)[0]!
        : text(user.role, `fixtures.${fixtureName}.users.${userName}.role`, 1, 100);
      if (!Object.hasOwn(app.roles, role)) {
        throw new TypeError(`fixtures.${fixtureName}.users.${userName} references unknown role ${role}.`);
      }
      const profile: { name?: string } = {};
      const profileInput = record(user.profile ?? {}, `fixtures.${fixtureName}.users.${userName}.profile`);
      if (Object.keys(profileInput).some((key) => key !== "name")) {
        throw new TypeError(`fixtures.${fixtureName}.users.${userName}.profile only supports name.`);
      }
      for (const [key, value] of Object.entries(profileInput)) {
        identifier(key, "fixture profile");
        profile.name = text(value, `fixtures.${fixtureName}.users.${userName}.profile.${key}`, 0, 120);
      }
      users[userName] = { email, role, profile };
    }

    const records: Record<string, Record<string, AppFixtureRecord>> = {};
    let recordCount = 0;
    for (const [entityName, entityRecordsRaw] of Object.entries(
      record(fixture.records ?? {}, `fixtures.${fixtureName}.records`),
    )) {
      const entity = app.entities[entityName];
      if (!entity) {
        throw new TypeError(`fixtures.${fixtureName}.records references unknown entity ${entityName}.`);
      }
      const entityRecords: Record<string, AppFixtureRecord> = {};
      for (const [recordName, recordRaw] of Object.entries(
        record(entityRecordsRaw, `fixtures.${fixtureName}.records.${entityName}`),
      )) {
        identifier(recordName, "fixture record");
        recordCount++;
        if (recordCount > 100) {
          throw new TypeError(`fixtures.${fixtureName}.records must contain at most 100 records.`);
        }
        const fixtureRecord = object(
          recordRaw,
          `fixtures.${fixtureName}.records.${entityName}.${recordName}`,
        );
        const owner = fixtureRecord.owner === undefined
          ? Object.keys(users)[0]!
          : text(
            fixtureRecord.owner,
            `fixtures.${fixtureName}.records.${entityName}.${recordName}.owner`,
            1,
            100,
          );
        if (!Object.hasOwn(users, owner)) {
          throw new TypeError(
            `fixtures.${fixtureName}.records.${entityName}.${recordName} references unknown owner ${owner}.`,
          );
        }
        const valuesInput = record(
          fixtureRecord.values,
          `fixtures.${fixtureName}.records.${entityName}.${recordName}.values`,
        );
        const values: Record<string, AppFixtureValue> = {};
        for (const fieldName of Object.keys(valuesInput)) {
          if (!Object.hasOwn(entity.fields, fieldName)) {
            throw new TypeError(
              `fixtures.${fixtureName}.records.${entityName}.${recordName}.values references unknown field ${fieldName}.`,
            );
          }
        }
        for (const [fieldName, field] of Object.entries(entity.fields)) {
          if (!Object.hasOwn(valuesInput, fieldName)) {
            if (field.required !== false && !Object.hasOwn(field, "default")) {
              throw new TypeError(
                `fixtures.${fixtureName}.records.${entityName}.${recordName}.values requires ${fieldName}.`,
              );
            }
            continue;
          }
          values[fieldName] = normalizeFixtureValue(
            valuesInput[fieldName],
            field,
            `fixtures.${fixtureName}.records.${entityName}.${recordName}.values.${fieldName}`,
          );
        }
        entityRecords[recordName] = { owner, values };
      }
      records[entityName] = entityRecords;
    }
    const normalized: AppFixture = {
      protocol: "clank-fixture/1",
      name: fixtureName,
      description: fixture.description === undefined
        ? `Deterministic ${fixtureName} application fixture.`
        : text(fixture.description, `fixtures.${fixtureName}.description`, 1, 500),
      users,
      records,
    };
    validateFixtureReferences(normalized, app.entities);
    fixtureRecordOrder(normalized, app.entities);
    fixtures[fixtureName] = normalized;
  }
  return fixtures;
}

function defaultFixtureDefinition(app: {
  slug: string;
  entities: Record<string, AppEntityDefinition>;
  roles: Record<string, AppRoleDefinition>;
}): AppFixtureDefinition {
  const order = fixtureEntityOrder(app.entities);
  const completed = new Set<string>();
  const records: Record<string, Record<string, AppFixtureRecordDefinition>> = {};
  for (const entityName of order) {
    const entity = app.entities[entityName];
    const values: Record<string, AppFixtureValue> = {};
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (Object.hasOwn(field, "default") || field.required === false) continue;
      if (field.type === "reference") {
        if (completed.has(field.entity!)) values[fieldName] = { ref: `${field.entity}.primary` };
        else if (field.nullable) values[fieldName] = null;
        else {
          throw new TypeError(
            `Cannot generate a deterministic fixture for required reference ${entityName}.${fieldName}.`,
          );
        }
        continue;
      }
      values[fieldName] = fixtureFieldSample(entityName, fieldName, field);
    }
    records[entityName] = {
      primary: {
        owner: "primary",
        values,
      },
    };
    completed.add(entityName);
  }
  return {
    description: "Deterministic smoke-test data generated from the application blueprint.",
    users: {
      primary: {
        email: `fixture@${app.slug}.example.invalid`,
        role: Object.keys(app.roles)[0],
        profile: { name: "Fixture User" },
      },
    },
    records,
  };
}

function fixtureEntityOrder(entities: Record<string, AppEntityDefinition>): string[] {
  const output: string[] = [];
  const remaining = new Set(Object.keys(entities));
  while (remaining.size) {
    let changed = false;
    for (const entityName of [...remaining]) {
      const dependencies = Object.values(entities[entityName].fields)
        .filter((field) =>
          field.type === "reference"
          && field.required !== false
          && !field.nullable
          && !Object.hasOwn(field, "default"))
        .map((field) => field.entity!);
      if (dependencies.some((dependency) => remaining.has(dependency))) continue;
      output.push(entityName);
      remaining.delete(entityName);
      changed = true;
    }
    if (!changed) {
      throw new TypeError(
        `Required entity references must be acyclic so records can be created: ${[...remaining].join(", ")}.`,
      );
    }
  }
  return output;
}

function fixtureFieldSample(
  entityName: string,
  fieldName: string,
  field: AppFieldDefinition,
): AppFixtureValue {
  const label = `${humanize(entityName.replace(/s$/u, ""))} ${humanize(fieldName)}`;
  if (field.nullable) return null;
  switch (field.type) {
    case "string":
    case "text":
      return boundedFixtureString(label, field, `${entityName}.${fieldName}`);
    case "email":
      return boundedFixtureEmail(field, `${entityName}.${fieldName}`);
    case "url":
      return `https://example.invalid/${encodeURIComponent(entityName)}/${encodeURIComponent(fieldName)}`;
    case "date":
      return "2026-01-15";
    case "datetime":
      return "2026-01-15T12:00:00.000Z";
    case "enum":
      return field.values![0];
    case "number": {
      const lower = field.min ?? 0;
      const upper = field.max ?? Math.max(lower, 1);
      if (!field.integer) return Math.min(Math.max(1, lower), upper);
      const integerLower = Math.ceil(lower);
      const integerUpper = Math.floor(upper);
      if (integerLower > integerUpper) {
        throw new TypeError(`${entityName}.${fieldName} has no integer value within its fixture range.`);
      }
      return Math.min(Math.max(1, integerLower), integerUpper);
    }
    case "boolean":
      return false;
    case "reference":
      throw new TypeError(`Reference fixture values must be resolved after entity ordering.`);
  }
}

function boundedFixtureString(
  label: string,
  field: AppFieldDefinition,
  path: string,
): string {
  const minimum = Math.max(0, Math.ceil(field.min ?? 0));
  const maximum = Math.max(0, Math.floor(field.max ?? Math.max(minimum, label.length)));
  if (minimum > maximum) throw new TypeError(`${path} has no string length valid for a fixture.`);
  if (minimum > 4_096) {
    throw new TypeError(`${path}.min must not exceed 4096 for deterministic fixture generation.`);
  }
  let output = label.slice(0, maximum);
  if (output.length < minimum) output += "x".repeat(minimum - output.length);
  return output;
}

function boundedFixtureEmail(field: AppFieldDefinition, path: string): string {
  const minimum = Math.max(0, Math.ceil(field.min ?? 0));
  const maximum = Math.max(0, Math.floor(field.max ?? 320));
  if (minimum > 4_096) {
    throw new TypeError(`${path}.min must not exceed 4096 for deterministic fixture generation.`);
  }
  const suffix = "@example.invalid";
  const localLength = Math.max(1, minimum - suffix.length);
  const value = `${"f".repeat(localLength)}${suffix}`;
  if (value.length > maximum) throw new TypeError(`${path} has no email length valid for a fixture.`);
  return value;
}

function fixtureEmail(value: unknown, path: string): string {
  const email = text(value, path, 3, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new TypeError(`${path} must be a valid email address.`);
  return email;
}

function normalizeFixtureValue(
  value: unknown,
  field: AppFieldDefinition,
  path: string,
): AppFixtureValue {
  if (value === null) {
    if (!field.nullable) throw new TypeError(`${path} cannot be null.`);
    return null;
  }
  if (field.type === "reference") {
    const reference = object(value, path);
    if (Object.keys(reference).length !== 1 || typeof reference.ref !== "string") {
      throw new TypeError(`${path} must be an object containing only a fixture ref.`);
    }
    return { ref: fixtureReference(reference.ref, path) };
  }
  if (typeof value === "object" || !["string", "number", "boolean"].includes(typeof value)) {
    throw new TypeError(`${path} must be a JSON scalar.`);
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite.`);
    if (field.integer && !Number.isInteger(value)) throw new TypeError(`${path} must be an integer.`);
    if (field.min !== undefined && value < field.min) throw new TypeError(`${path} must be at least ${field.min}.`);
    if (field.max !== undefined && value > field.max) throw new TypeError(`${path} must be at most ${field.max}.`);
    return value;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean.`);
    return value;
  }
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  if (
    ["string", "text", "email"].includes(field.type)
    && field.min !== undefined
    && value.length < field.min
  ) throw new TypeError(`${path} is shorter than ${field.min}.`);
  if (
    ["string", "text", "email"].includes(field.type)
    && field.max !== undefined
    && value.length > field.max
  ) throw new TypeError(`${path} is longer than ${field.max}.`);
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new TypeError(`${path} must be a valid email address.`);
  }
  if (field.type === "url") {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new TypeError(`${path} must be an absolute URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`${path} must use http or https.`);
    }
  }
  if (field.type === "date" && !validFixtureDate(value)) {
    throw new TypeError(`${path} must use YYYY-MM-DD.`);
  }
  if (
    field.type === "datetime"
    && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))
  ) {
    throw new TypeError(`${path} must be an ISO 8601 date-time with a timezone.`);
  }
  if (field.type === "enum" && !field.values!.includes(value)) {
    throw new TypeError(`${path} must be one of: ${field.values!.join(", ")}.`);
  }
  return value;
}

function fixtureReference(value: string, path: string): string {
  const parts = value.split(".");
  if (parts.length !== 2 || parts.some((part) => !NAME.test(part))) {
    throw new TypeError(`${path}.ref must use entity.record syntax.`);
  }
  return value;
}

function validateFixtureReferences(
  fixture: AppFixture,
  entities: Record<string, AppEntityDefinition>,
): void {
  for (const [entityName, entityRecords] of Object.entries(fixture.records)) {
    for (const [recordName, record] of Object.entries(entityRecords)) {
      for (const [fieldName, value] of Object.entries(record.values)) {
        if (!value || typeof value !== "object") continue;
        const [targetEntity, targetRecord] = value.ref.split(".");
        const field = entities[entityName].fields[fieldName];
        if (field.type !== "reference" || field.entity !== targetEntity) {
          throw new TypeError(
            `fixtures.${fixture.name}.records.${entityName}.${recordName}.${fieldName} must reference ${field.entity}.`,
          );
        }
        const referenced = fixture.records[targetEntity]?.[targetRecord];
        if (!referenced) {
          throw new TypeError(
            `fixtures.${fixture.name}.records.${entityName}.${recordName}.${fieldName} references missing ${value.ref}.`,
          );
        }
        if (entities[targetEntity].ownership !== "public" && referenced.owner !== record.owner) {
          throw new TypeError(
            `fixtures.${fixture.name} reference ${entityName}.${recordName} → ${value.ref} must use the same owner.`,
          );
        }
      }
    }
  }
}

function fixtureRecordOrder(
  fixture: AppFixture,
  entities: Record<string, AppEntityDefinition>,
): string[] {
  const records = new Map<string, AppFixtureRecord>();
  for (const [entityName, entityRecords] of Object.entries(fixture.records)) {
    for (const [recordName, record] of Object.entries(entityRecords)) {
      records.set(`${entityName}.${recordName}`, record);
    }
  }
  const output: string[] = [];
  const remaining = new Set(records.keys());
  while (remaining.size) {
    let changed = false;
    for (const key of [...remaining]) {
      const record = records.get(key)!;
      const dependencies = Object.values(record.values)
        .filter((value): value is { ref: string } => !!value && typeof value === "object")
        .map((value) => value.ref);
      if (dependencies.some((dependency) => remaining.has(dependency))) continue;
      output.push(key);
      remaining.delete(key);
      changed = true;
    }
    if (!changed) {
      throw new TypeError(
        `fixtures.${fixture.name} record references must be acyclic: ${[...remaining].join(", ")}.`,
      );
    }
  }
  for (const key of output) {
    const entityName = key.split(".", 1)[0];
    if (!entities[entityName]) throw new TypeError(`Unknown fixture entity ${entityName}.`);
  }
  return output;
}

function validFixtureDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDefault(field: AppFieldDefinition, value: string | number | boolean | null, path: string): void {
  if (value === null) {
    if (!field.nullable) throw new TypeError(`${path}.default cannot be null unless nullable is true.`);
    return;
  }
  if (field.type === "reference") throw new TypeError(`${path}.default cannot provide a reference ID.`);
  if (field.type === "number") {
    if (typeof value !== "number") throw new TypeError(`${path}.default must be a number.`);
    if (field.integer && !Number.isInteger(value)) throw new TypeError(`${path}.default must be an integer.`);
    if (field.min !== undefined && value < field.min) throw new TypeError(`${path}.default must be at least ${field.min}.`);
    if (field.max !== undefined && value > field.max) throw new TypeError(`${path}.default must be at most ${field.max}.`);
    return;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${path}.default must be a boolean.`);
    return;
  }
  if (typeof value !== "string") throw new TypeError(`${path}.default must be a string.`);
  if (["string", "text", "email"].includes(field.type) && field.min !== undefined && value.length < field.min) {
    throw new TypeError(`${path}.default must contain at least ${field.min} characters.`);
  }
  if (["string", "text", "email"].includes(field.type) && field.max !== undefined && value.length > field.max) {
    throw new TypeError(`${path}.default must contain at most ${field.max} characters.`);
  }
  if (field.type === "enum" && !field.values!.includes(value)) {
    throw new TypeError(`${path}.default is not an enum member.`);
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new TypeError(`${path}.default must be a valid email address.`);
  }
  if (field.type === "url") {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new TypeError(`${path}.default must be an absolute URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`${path}.default must use http or https.`);
    }
  }
  if (field.type === "date" && !validFixtureDate(value)) {
    throw new TypeError(`${path}.default must use YYYY-MM-DD.`);
  }
  if (
    field.type === "datetime"
    && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))
  ) {
    throw new TypeError(`${path}.default must be an ISO 8601 date-time with a timezone.`);
  }
}

function normalizeRelationshipReference(
  raw: unknown,
  entities: Record<string, AppEntityDefinition>,
  from: string,
  to: string,
  path: string,
): AppRelationshipDefinition["reference"] {
  const candidates: Array<{ entity: string; field: string }> = [];
  for (const entityName of new Set([from, to])) {
    const other = entityName === from ? to : from;
    for (const [fieldName, field] of Object.entries(entities[entityName].fields)) {
      if (field.type === "reference" && field.entity === other) {
        candidates.push({ entity: entityName, field: fieldName });
      }
    }
  }
  if (raw === undefined) return candidates.length === 1 ? candidates[0] : undefined;
  const input = object(raw, path);
  const entity = text(input.entity, `${path}.entity`, 1, 100);
  const field = text(input.field, `${path}.field`, 1, 100);
  if (entity !== from && entity !== to) throw new TypeError(`${path}.entity must be ${from} or ${to}.`);
  const definition = entities[entity].fields[field];
  const other = entity === from ? to : from;
  if (!definition || definition.type !== "reference" || definition.entity !== other) {
    throw new TypeError(`${path} must identify a reference field from one relationship endpoint to the other.`);
  }
  return { entity, field };
}

function referenceTarget(
  entities: Record<string, AppEntityDefinition>,
  reference: NonNullable<AppRelationshipDefinition["reference"]>,
): string {
  return entities[reference.entity].fields[reference.field].entity!;
}

function assertAcyclicCascadeRelationships(
  relationships: readonly AppRelationshipDefinition[],
  entities: Record<string, AppEntityDefinition>,
): void {
  const graph = new Map<string, string[]>();
  for (const relationship of relationships) {
    if (relationship.onDelete !== "cascade" || !relationship.reference) continue;
    const parent = referenceTarget(entities, relationship.reference);
    const children = graph.get(parent) ?? [];
    children.push(relationship.reference.entity);
    graph.set(parent, children);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (entity: string) => {
    if (visiting.has(entity)) throw new TypeError("Cascade relationships must not contain a deletion cycle.");
    if (visited.has(entity)) return;
    visiting.add(entity);
    for (const child of graph.get(entity) ?? []) visit(child);
    visiting.delete(entity);
    visited.add(entity);
  };
  for (const entity of graph.keys()) visit(entity);
}

function normalizeActionBehavior(
  raw: unknown,
  operation: AppActionDefinition["operation"],
  actionName: string,
  entity: AppEntityDefinition | undefined,
  path: string,
): AppActionDefinition["behavior"] {
  const behavior = raw === undefined
    ? operation === "read"
      ? "list"
      : operation === "create"
        ? "create"
        : operation === "delete"
          ? "delete"
          : operation === "update"
            ? entity?.completionField && /(?:complete|done|reopen|toggle)$/iu.test(actionName)
              ? "toggle"
              : "update"
            : undefined
    : enumValue(raw, ["list", "create", "update", "toggle", "delete"], path);
  if (!behavior) return undefined;
  const expected = behavior === "list"
    ? "read"
    : behavior === "create"
      ? "create"
      : behavior === "delete"
        ? "delete"
        : "update";
  if (operation !== expected) throw new TypeError(`${path} is incompatible with operation ${operation}.`);
  if (!entity) throw new TypeError(`${path} requires an entity-backed action.`);
  if (behavior === "toggle" && !entity.completionField) {
    throw new TypeError(`${path} requires the entity to declare completionField.`);
  }
  return behavior;
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
  for (const relationship of app.relationships) {
    if (relationship.kind === "one-to-one" || relationship.kind === "many-to-many") {
      warnings.push(`Relationship ${relationship.name} declares ${relationship.kind} cardinality; the generated reference and deletion policy are enforced, but cardinality needs an explicit unique or join-entity model.`);
    }
  }
  for (const [name, action] of Object.entries(app.actions)) {
    if (!action.behavior) {
      warnings.push(`Custom action ${name} needs an application implementation before it can appear in HTTP or MCP.`);
    }
  }
  for (const route of app.routes) {
    if (route.access === "public") {
      warnings.push(`Public route ${route.path} still uses the generated authenticated application shell; add an explicit public data contract before exposing data.`);
    }
  }
  for (const [name, service] of Object.entries(app.services)) {
    if (service.required) warnings.push(`Required service ${name} (${service.kind}) uses a local development driver and must be provisioned before production startup.`);
  }
  return warnings;
}

interface GeneratedEntityAction {
  localName: string;
  behavior: NonNullable<AppActionDefinition["behavior"]> | "history" | "restore";
  description: string;
  roles: readonly string[];
  confirmation: NonNullable<AppActionDefinition["confirmation"]>;
}

function backendSource(app: AppBlueprint): string {
  const auth = app.auth.required
    ? `export const auth = defineAuth({ defaultRole: ${sourceLiteral(Object.keys(app.auth.roles)[0] ?? "member")} });\n`
    : "";
  const tables = Object.entries(app.entities).map(([name, entity]) => {
    let chain = `defineTable({\n${Object.entries(entity.fields).map(([fieldName, field]) =>
      `      ${property(fieldName)}: ${schemaSource(field)},`).join("\n")}\n    })`;
    if (entity.ownership !== "public") chain += ".owned()";
    for (const [indexName, index] of Object.entries(entity.indexes ?? {})) {
      chain += `.index(${sourceLiteral(indexName)}, ${sourceLiteral(index.fields)})`;
    }
    return `  ${property(name)}: ${chain},`;
  }).join("\n");
  const groups = Object.entries(app.entities)
    .map(([name, entity]) => entityFunctions(app, name, entity))
    .join(",\n");
  return `import {
  BackendActionError,
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
  type DocumentFor,
  type WriteDatabase,
} from "@clank.run/framework";

${auth}export const schema = defineDatabase({
${tables}
});

${Object.keys(app.entities).map((name) =>
    `export type ${typeName(name)} = DocumentFor<typeof schema, ${sourceLiteral(name)}>;`).join("\n")}

const documentVersion = s.number({ integer: true, min: 1 });
${deleteHelpersSource(app)}

export const backend = defineBackend({
  schema,
  ${app.auth.required ? "auth," : ""}
}).functions(({ query, mutation }) => ({
${groups}
}));
`;
}

function generatedEntityActions(
  app: AppBlueprint,
  name: string,
  entity: AppEntityDefinition,
): GeneratedEntityAction[] {
  const label = humanize(name);
  const singular = humanize(name.replace(/s$/u, ""));
  const declared: GeneratedEntityAction[] = Object.entries(app.actions)
    .filter(([, action]) => action.entity === name && action.behavior)
    .map(([actionName, action]) => ({
      localName: actionName.slice(name.length + 1),
      behavior: action.behavior!,
      description: action.description,
      roles: action.roles ?? [],
      confirmation: action.confirmation
        ?? (action.operation === "delete" ? "always" : action.operation === "read" ? "never" : "write"),
    }));
  const defaults: Array<Omit<GeneratedEntityAction, "localName"> & { preferredName: string }> = [
    {
      preferredName: "list",
      behavior: "list",
      description: `List ${label.toLowerCase()} visible to the current user.`,
      roles: routeRolesForEntity(app, name),
      confirmation: "never",
    },
    {
      preferredName: "create",
      behavior: "create",
      description: `Create one ${singular.toLowerCase()}.`,
      roles: routeRolesForEntity(app, name),
      confirmation: "write",
    },
    {
      preferredName: "remove",
      behavior: "delete",
      description: `Permanently remove one ${singular.toLowerCase()}.`,
      roles: routeRolesForEntity(app, name),
      confirmation: "always",
    },
    ...(entity.completionField ? [{
      preferredName: "toggle",
      behavior: "toggle" as const,
      description: `Change the completion state of one ${singular.toLowerCase()}.`,
      roles: routeRolesForEntity(app, name),
      confirmation: "write" as const,
    }] : []),
    ...(app.admin && app.admin.entities.includes(name) ? [{
      preferredName: "history",
      behavior: "history" as const,
      description: `List recent ${singular.toLowerCase()} revisions visible to the current administrator.`,
      roles: [...app.admin.roles],
      confirmation: "never" as const,
    }, {
      preferredName: "restore",
      behavior: "restore" as const,
      description: `Restore one historical ${singular.toLowerCase()} snapshot as a new version.`,
      roles: [...app.admin.roles],
      confirmation: "always" as const,
    }] : []),
  ];
  const output = [...declared];
  const used = new Set(output.map((action) => action.localName));
  for (const fallback of defaults) {
    if (output.some((action) => action.behavior === fallback.behavior)) continue;
    let localName = fallback.preferredName;
    let suffix = 2;
    while (used.has(localName)) localName = `${fallback.preferredName}${suffix++}`;
    used.add(localName);
    output.push({ ...fallback, localName });
  }
  return output;
}

function routeRolesForEntity(app: AppBlueprint, name: string): string[] {
  const roles = new Set<string>();
  for (const route of app.routes) {
    if (route.entity !== name) continue;
    if (typeof route.access === "string") return [];
    for (const role of route.access.roles ?? []) roles.add(role);
  }
  return [...roles].sort();
}

function entityFunctions(app: AppBlueprint, name: string, entity: AppEntityDefinition): string {
  const createFields = Object.entries(entity.fields).map(([fieldName, field]) =>
    `        ${property(fieldName)}: ${createSchemaSource(field)},`).join("\n");
  const insertFields = Object.entries(entity.fields).map(([fieldName]) =>
    `          ${property(fieldName)}: input.${fieldName},`).join("\n");
  const updateFields = Object.entries(entity.fields).map(([fieldName, field]) =>
    `          ${property(fieldName)}: s.optional(${schemaSource({ ...field, required: true, default: undefined }, false)}),`).join("\n");
  const cleanUpdateFields = Object.keys(entity.fields).map((fieldName) =>
    `          ...(changes.${fieldName} === undefined ? {} : { ${property(fieldName)}: changes.${fieldName} }),`).join("\n");
  const createReferenceGuards = Object.entries(entity.fields)
    .filter(([, field]) => field.type === "reference")
    .map(([fieldName, field]) => `        if (
          input.${fieldName} !== undefined
          && input.${fieldName} !== null
          && !db.table(${sourceLiteral(field.entity)}).get(input.${fieldName})
        ) {
          throw new BackendActionError(
            404,
            "REFERENCE_NOT_FOUND",
            ${sourceLiteral(`${humanize(fieldName)} does not reference a visible ${humanize(field.entity!).toLowerCase()} record.`)},
          );
        }`).join("\n");
  const updateReferenceGuards = Object.entries(entity.fields)
    .filter(([, field]) => field.type === "reference")
    .map(([fieldName, field]) => `        if (
          changes.${fieldName} !== undefined
          && changes.${fieldName} !== null
          && !db.table(${sourceLiteral(field.entity)}).get(changes.${fieldName})
        ) {
          throw new BackendActionError(
            404,
            "REFERENCE_NOT_FOUND",
            ${sourceLiteral(`${humanize(fieldName)} does not reference a visible ${humanize(field.entity!).toLowerCase()} record.`)},
          );
        }`).join("\n");
  const actions = generatedEntityActions(app, name, entity).map((action) => {
    const guard = action.roles.length
      ? `        auth.requireRole(${action.roles.map((role) => sourceLiteral(role)).join(", ")});\n`
      : "";
    const agent = `{
        title: ${sourceLiteral(humanize(action.localName))},
        description: ${sourceLiteral(action.description)},
        destructive: ${action.behavior === "delete" || action.confirmation === "always"},
        idempotent: ${action.behavior === "list" || action.behavior === "history" || action.behavior === "toggle"},
      }`;
    if (action.behavior === "list") {
      return `    ${property(action.localName)}: query({
      description: ${sourceLiteral(action.description)},
      args: {},
      agent: ${agent},
      handler: ({ db, auth }) => {
${guard}        return db.table(${sourceLiteral(name)}).query().orderBy("_creationTime", "asc").collect();
      },
    })`;
    }
    if (action.behavior === "history") {
      return `    ${property(action.localName)}: query({
      description: ${sourceLiteral(action.description)},
      args: {
        id: s.optional(s.id(${sourceLiteral(name)})),
        limit: s.default(s.number({ integer: true, min: 1, max: 100 }), 25),
      },
      agent: ${agent},
      handler: ({ db, auth }, { id, limit }) => {
${guard}        return id
          ? db.table(${sourceLiteral(name)}).history(id, { limit })
          : db.table(${sourceLiteral(name)}).history({ limit });
      },
    })`;
    }
    if (action.behavior === "create") {
      return `    ${property(action.localName)}: mutation({
      description: ${sourceLiteral(action.description)},
      args: {
${createFields}
      },
      agent: ${agent},
      handler: ({ db, auth }, input) => {
${guard}${createReferenceGuards ? `${createReferenceGuards}\n` : ""}        return db.table(${sourceLiteral(name)}).insert({
${insertFields}
        });
      },
    })`;
    }
    if (action.behavior === "toggle") {
      return `    ${property(action.localName)}: mutation({
      description: ${sourceLiteral(action.description)},
      args: {
        id: s.id(${sourceLiteral(name)}),
        value: s.boolean(),
        version: documentVersion,
      },
      agent: ${agent},
      handler: ({ db, auth }, { id, value, version }) => {
${guard}        return db.table(${sourceLiteral(name)}).patch(
          id,
          { ${property(entity.completionField!)}: value },
          { ifVersion: version },
        );
      },
    })`;
    }
    if (action.behavior === "update") {
      return `    ${property(action.localName)}: mutation({
      description: ${sourceLiteral(action.description)},
      args: {
        id: s.id(${sourceLiteral(name)}),
        version: documentVersion,
        changes: s.object({
${updateFields}
        }),
      },
      agent: ${agent},
      handler: ({ db, auth }, { id, version, changes }) => {
${guard}${updateReferenceGuards ? `${updateReferenceGuards}\n` : ""}        const update = {
${cleanUpdateFields}
        };
        if (Object.keys(update).length === 0) {
          throw new BackendActionError(400, "EMPTY_UPDATE", "At least one field must be changed.");
        }
        return db.table(${sourceLiteral(name)}).patch(id, update, { ifVersion: version });
      },
    })`;
    }
    if (action.behavior === "restore") {
      return `    ${property(action.localName)}: mutation({
      description: ${sourceLiteral(action.description)},
      args: {
        id: s.id(${sourceLiteral(name)}),
        revision: s.number({ integer: true, min: 1 }),
        sequence: s.number({ integer: true, min: 0 }),
        version: s.nullable(documentVersion),
      },
      agent: ${agent},
      handler: ({ db, auth }, { id, revision, sequence, version }) => {
${guard}        return db.table(${sourceLiteral(name)}).restore(
          id,
          { revision, sequence },
          { ifVersion: version },
        );
      },
    })`;
    }
    return `    ${property(action.localName)}: mutation({
      description: ${sourceLiteral(action.description)},
      args: { id: s.id(${sourceLiteral(name)}), version: documentVersion },
      agent: ${agent},
      handler: ({ db, auth }, { id, version }) => {
${guard}        return deleteEntity_${name}(db, id, version, {
          remaining: MAX_RELATED_DELETE_OPERATIONS,
          seen: new Set(),
        });
      },
    })`;
  });
  return `  ${property(name)}: {
${actions.join(",\n")}
  }`;
}

function deleteHelpersSource(app: AppBlueprint): string {
  const helpers = Object.keys(app.entities).map((name) => {
    const relationships = app.relationships.filter((relationship) =>
      relationship.reference
      && referenceTarget(app.entities, relationship.reference) === name);
    const operations = relationships.map((relationship) => {
      const reference = relationship.reference!;
      const child = reference.entity;
      const query = `db.table(${sourceLiteral(child)}).query().where(${sourceLiteral(reference.field)}, id)`;
      if (relationship.onDelete === "restrict") {
        return `  if (${query}.limit(1).first()) {
    throw new BackendActionError(
      409,
      "RELATIONSHIP_RESTRICTED",
      ${sourceLiteral(`Cannot delete ${humanize(name).toLowerCase()} while related ${humanize(child).toLowerCase()} exist.`)},
    );
  }`;
      }
      if (relationship.onDelete === "nullify") {
        return `  for (const related of ${query}.limit(MAX_RELATED_DELETE_OPERATIONS + 1).collect()) {
    consumeDeleteOperation(state);
    db.table(${sourceLiteral(child)}).patch(
      related._id,
      { ${property(reference.field)}: null },
      { ifVersion: related._version },
    );
  }`;
      }
      return `  for (const related of ${query}.limit(MAX_RELATED_DELETE_OPERATIONS + 1).collect()) {
    deleteEntity_${child}(db, related._id, related._version, state);
  }`;
    });
    return `function deleteEntity_${name}(
  db: WriteDatabase<typeof schema>,
  id: ${typeName(name)}["_id"],
  version: number,
  state: DeleteState,
): boolean {
  const key = ${sourceLiteral(`${name}:`)} + id;
  if (state.seen.has(key)) return true;
  state.seen.add(key);
  consumeDeleteOperation(state);
${operations.join("\n")}
  return db.table(${sourceLiteral(name)}).delete(id, { ifVersion: version });
}`;
  }).join("\n\n");
  return `
const MAX_RELATED_DELETE_OPERATIONS = 1_000;
interface DeleteState {
  remaining: number;
  seen: Set<string>;
}

function consumeDeleteOperation(state: DeleteState): void {
  state.remaining--;
  if (state.remaining < 0) {
    throw new BackendActionError(
      409,
      "RELATIONSHIP_LIMIT",
      "The relationship change exceeds the generated transaction limit.",
    );
  }
}

${helpers}
`;
}

function viewSource(app: AppBlueprint): string {
  const entityNames = Object.keys(app.entities);
  const types = entityNames.map(typeName).join(", ");
  const createTypes = entityNames.map((name) => createInputTypeSource(name, app.entities[name])).join("\n\n");
  const props = entityNames.map((name) => {
    const type = typeName(name);
    const entity = app.entities[name];
    const revisionProps = app.admin && app.admin.entities.includes(name)
      ? `\n  ${name}Revisions: Array<DocumentRevision<typeof schema, ${sourceLiteral(name)}>>;
  ${name}RefreshHistory(): void | Promise<void>;
  ${name}Restore(id: ${type}["_id"], cursor: DocumentRevisionCursor, version: number | null): Promise<boolean>;`
      : "";
    return `  ${name}Records: ${type}[];
  ${name}Version: number;
  ${name}Create(input: ${type}CreateInput): Promise<boolean>;
  ${entity.completionField ? `${name}Toggle(id: ${type}["_id"], value: boolean, version: number): Promise<boolean>;\n  ` : ""}${name}Remove(id: ${type}["_id"], version: number): Promise<boolean>;${revisionProps}`;
  }).join("\n");
  const panels = entityNames.map((name) => entityPanelSource(app, name, app.entities[name])).join("\n\n");
  const studio = adminStudioSource(app);
  const navigation = app.routes.map((route) => {
    const routeAgentId = route.path === "/"
      ? "route-home"
      : `route-${route.path.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`;
    const link = `<a
              classList={{
                "rounded-lg px-3 py-2 text-sm font-semibold transition": true,
                "bg-slate-950 text-white": props.route === ${sourceLiteral(route.path)},
                "text-slate-600 hover:bg-slate-100": props.route !== ${sourceLiteral(route.path)},
              }}
              href=${sourceLiteral(route.path)}
              aria-current={props.route === ${sourceLiteral(route.path)} ? "page" : undefined}
              agentId=${sourceLiteral(routeAgentId)}
            >{${sourceLiteral(humanize(route.view))}}</a>`;
    return typeof route.access === "object"
      ? `{roleAllowed(props.user.role, ${sourceLiteral(route.access.roles ?? [])}) ? (${link}) : null}`
      : link;
  }).join("\n            ");
  const adminNavigation = app.admin
    ? `{roleAllowed(props.user.role, ${sourceLiteral(app.admin.roles)}) ? (<a
              classList={{
                "rounded-lg px-3 py-2 text-sm font-semibold transition": true,
                "bg-slate-950 text-white": props.route === ${sourceLiteral(app.admin.path)},
                "text-slate-600 hover:bg-slate-100": props.route !== ${sourceLiteral(app.admin.path)},
              }}
              href=${sourceLiteral(app.admin.path)}
              aria-current={props.route === ${sourceLiteral(app.admin.path)} ? "page" : undefined}
              agentId="route-admin-studio"
            >Admin Studio</a>) : null}`
    : "";
  const routeViews = app.routes.map((route) => {
    const contents = route.entity
      ? `<${typeName(route.entity)}Panel {...props} />`
      : `<section class="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
              <p class="text-xs font-bold uppercase tracking-[.18em] text-emerald-600">{${sourceLiteral(humanize(route.view))}}</p>
              <h2 class="mt-2 text-2xl font-semibold">{${sourceLiteral(humanize(route.view))}}</h2>
              <p class="mt-3 text-slate-600">{${sourceLiteral(route.description ?? "This route is ready for application-specific content.")}}</p>
            </section>`;
    return `{props.route === ${sourceLiteral(route.path)} ? (${contents}) : null}`;
  }).join("\n          ");
  const adminView = app.admin
    ? `{props.route === ${sourceLiteral(app.admin.path)} && roleAllowed(props.user.role, ${sourceLiteral(app.admin.roles)}) ? (<AdminStudio {...props} />) : null}`
    : "";
  return `/* @clankImportSource @clank.run/framework */
import { For, createApi, signal, type AuthUser, type DefaultAuthProfile, type DocumentRevision, type DocumentRevisionCursor } from "@clank.run/framework";
import type { backend, schema, ${types} } from "./backend.ts";

${createTypes}

const api = createApi<typeof backend>();

export interface AppViewProps {
  route: string;
  user: AuthUser<DefaultAuthProfile>;
  version: number;
  connected: boolean;
  pending: boolean;
  error: string;
  studioReadOnly?: boolean;
  showHistory?: boolean;
${props}
  logout(): void | Promise<void>;
}

function roleAllowed(role: string, roles: readonly string[]): boolean {
  return roles.length === 0 || roles.includes(role);
}

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

${panels}

${studio}

export function AppView(props: AppViewProps) {
  return (
    <main class="mx-auto min-h-screen max-w-6xl px-4 py-8 text-slate-950 sm:px-6 sm:py-12">
      <header class="flex flex-col gap-6 border-b border-slate-200 pb-7 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-600">Clank generated application</p>
          <h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{${sourceLiteral(app.name)}}</h1>
          <p class="mt-3 max-w-2xl text-slate-500">{${sourceLiteral(app.description)}}</p>
          <p class="mt-2 text-sm text-slate-500" role="status">
            {props.connected ? "Live sync connected." : "Reconnecting…"}
            <span class="sr-only"> Database snapshot {props.version}.</span>
          </p>
        </div>
        <div class="flex items-center gap-3">
          <span class="min-w-0 truncate text-sm text-slate-500">{props.user.email}</span>
          <button class="shrink-0 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-white" onClick={props.logout} agentId="auth-sign-out">Sign out</button>
        </div>
      </header>
      <nav class="my-6 flex flex-wrap gap-2" aria-label="Application">
        ${navigation}
        ${adminNavigation}
      </nav>
      {props.error ? <p class="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{props.error}</p> : null}
      <div aria-busy={props.pending}>
        ${routeViews}
          ${adminView}
      </div>
    </main>
  );
}
`;
}

function createInputTypeSource(name: string, entity: AppEntityDefinition): string {
  const type = typeName(name);
  const fields = Object.entries(entity.fields).map(([fieldName, field]) => {
    const optional = field.required === false || Object.hasOwn(field, "default");
    return `  ${property(fieldName)}${optional ? "?" : ""}: ${type}[${sourceLiteral(fieldName)}];`;
  }).join("\n");
  return `export interface ${type}CreateInput {
${fields}
}`;
}

function entityPanelSource(app: AppBlueprint, name: string, entity: AppEntityDefinition): string {
  const type = typeName(name);
  const title = humanize(name);
  const singular = humanize(name.replace(/s$/u, ""));
  const actions = generatedEntityActions(app, name, entity);
  const create = actions.find((action) => action.behavior === "create")!;
  const remove = actions.find((action) => action.behavior === "delete")!;
  const toggle = actions.find((action) => action.behavior === "toggle");
  const history = actions.find((action) => action.behavior === "history");
  const restore = actions.find((action) => action.behavior === "restore");
  const signals = Object.entries(entity.fields).map(([fieldName, field]) =>
    `  const draft_${fieldName} = signal(${draftDefaultSource(field)});`).join("\n");
  const reset = Object.entries(entity.fields).map(([fieldName, field]) =>
    `    draft_${fieldName}.value = ${draftDefaultSource(field)};`).join("\n");
  const input = Object.entries(entity.fields).map(([fieldName, field]) =>
    `      ${property(fieldName)}: ${draftValueSource(type, fieldName, field)},`).join("\n");
  const controls = Object.entries(entity.fields).map(([fieldName, field]) =>
    fieldControlSource(app, name, fieldName, field)).join("\n");
  const details = Object.entries(entity.fields)
    .filter(([fieldName]) => fieldName !== entity.displayField && fieldName !== entity.completionField)
    .map(([fieldName, field]) => {
      const value = field.type === "reference"
        ? `record.${fieldName} == null
                    ? "—"
                    : props.${field.entity}Records.find((candidate) => candidate._id === record.${fieldName})?.${app.entities[field.entity!].displayField} ?? String(record.${fieldName})`
        : `valueLabel(record.${fieldName})`;
      return `<div>
                <dt class="text-xs font-semibold uppercase tracking-wide text-slate-400">{${sourceLiteral(humanize(fieldName))}}</dt>
                <dd class="mt-1 break-words text-sm text-slate-700">{${value}}</dd>
              </div>`;
    }).join("\n              ");
  const historyPanel = history && restore ? `{props.showHistory ? (
        <section class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-labelledby=${sourceLiteral(`${name}-history-title`)}>
          <div class="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div><h3 id=${sourceLiteral(`${name}-history-title`)} class="font-semibold">Revision timeline</h3>
            <p class="mt-1 text-sm text-slate-500">Every restore adds a new version; history is never rewound or rewritten.</p></div>
            <button class="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50" type="button" disabled={props.pending} onClick={props.${name}RefreshHistory} agentId=${sourceLiteral(`${name}-history-refresh`)} agentAction={api[${sourceLiteral(name)}][${sourceLiteral(history.localName)}]} agentLabel=${sourceLiteral(`Refresh ${title.toLowerCase()} revision timeline`)}>Refresh activity</button>
          </div>
          <ol class="divide-y divide-slate-100 px-5" aria-live="polite">
            <For each={props.${name}Revisions} by={(revision) => \`\${revision.cursor.revision}:\${revision.cursor.sequence}\`} fallback={<li class="py-6 text-sm text-slate-500">No retained revisions yet.</li>}>
              {(revision) => {
                const current = props.${name}Records.find((record) => record._id === revision.document._id);
                const canRestoreRevision = canRestore && (current?._version ?? null) !== revision.document._version;
                return (
                  <li class="relative grid gap-3 py-4 pl-7 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <span classList={{ "absolute left-0 top-5 grid h-4 w-4 place-items-center rounded-full ring-4 ring-white": true, "bg-emerald-500": revision.operation === "create" || revision.operation === "restore", "bg-sky-500": revision.operation === "update", "bg-rose-500": revision.operation === "delete" }} aria-hidden="true" />
                    <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="font-semibold">{valueLabel(revision.document.${entity.displayField})}</span><span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-slate-600">{revision.operation}</span></div>
                    <p class="mt-1 text-xs text-slate-500"><time datetime={new Date(revision.recordedAt).toISOString()}>{new Date(revision.recordedAt).toISOString()}</time> · document v{revision.document._version} · database r{revision.cursor.revision}.{revision.cursor.sequence}</p></div>
                    {canRestoreRevision ? <button class="justify-self-start rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 sm:justify-self-end" type="button" disabled={props.pending} onClick={() => props.${name}Restore(revision.document._id, revision.cursor, current?._version ?? null)} agentId={\`${name}-\${revision.document._id}-restore-\${revision.cursor.revision}-\${revision.cursor.sequence}\`} agentAction={api[${sourceLiteral(name)}][${sourceLiteral(restore.localName)}]} agentLabel={\`Restore \${revision.document.${entity.displayField}} from document version \${revision.document._version}\`}>Restore this version</button> : null}
                  </li>
                );
              }}
            </For>
          </ol>
        </section>
      ) : null}` : "";
  return `function ${type}Panel(props: AppViewProps) {
${signals}
  const canCreate = props.studioReadOnly !== true && roleAllowed(props.user.role, ${sourceLiteral(create.roles)});
  const canRemove = props.studioReadOnly !== true && roleAllowed(props.user.role, ${sourceLiteral(remove.roles)});
  ${toggle ? `const canToggle = props.studioReadOnly !== true && roleAllowed(props.user.role, ${sourceLiteral(toggle.roles)});` : ""}
  ${restore ? `const canRestore = props.studioReadOnly !== true && roleAllowed(props.user.role, ${sourceLiteral(restore.roles)});` : ""}
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!canCreate || props.pending) return;
    const created = await props.${name}Create({
${input}
    });
    if (!created) return;
${reset}
  };
  return (
    <section>
      <div class="mb-5">
        <p class="text-xs font-bold uppercase tracking-[.18em] text-emerald-600">{${sourceLiteral(title)}}</p>
        <h2 class="mt-1 text-2xl font-semibold">{${sourceLiteral(title)}}</h2>
        <p class="mt-2 text-slate-500">{${sourceLiteral(entity.description)}}</p>
      </div>
      {canCreate ? (
        <form class="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2" onSubmit={submit}>
${controls}
          <div class="flex items-end sm:col-span-2">
            <button class="w-full rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" type="submit" disabled={props.pending} agentId=${sourceLiteral(`${name}-create`)} agentAction={api[${sourceLiteral(name)}][${sourceLiteral(create.localName)}]}>
              Add {${sourceLiteral(singular)}}
            </button>
          </div>
        </form>
      ) : null}
      <div class="mt-6 grid gap-4">
        <For each={props.${name}Records} by="_id" fallback={<p class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">{${sourceLiteral(`No ${title.toLowerCase()} yet.`)}}</p>}>
          {(record) => (
            <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" agentId={\`${name}-\${record._id}\`} agentLabel={String(record.${entity.displayField})}>
              <div class="flex items-start gap-3">
                ${toggle && entity.completionField ? `{canToggle ? <button
                  class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-slate-400 text-xs hover:border-emerald-600 disabled:opacity-50"
                  disabled={props.pending}
                  onClick={() => props.${name}Toggle(record._id, !record.${entity.completionField}, record._version)}
                  agentId={\`${name}-\${record._id}-toggle\`}
                  agentAction={api[${sourceLiteral(name)}][${sourceLiteral(toggle.localName)}]}
                  agentLabel={\`\${record.${entity.completionField} ? "Reopen" : "Complete"} \${record.${entity.displayField}}\`}
                >{record.${entity.completionField} ? "✓" : ""}</button> : null}` : ""}
                <div class="min-w-0 flex-1">
                  <h3 classList={{ "break-words font-semibold": true${entity.completionField ? `, "line-through text-slate-400": record.${entity.completionField}` : ""} }}>{record.${entity.displayField}}</h3>
                  ${details ? `<dl class="mt-3 grid gap-3 sm:grid-cols-2">
              ${details}
                  </dl>` : ""}
                </div>
                {canRemove ? <button
                  class="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                  disabled={props.pending}
                  onClick={() => props.${name}Remove(record._id, record._version)}
                  agentId={\`${name}-\${record._id}-remove\`}
                  agentAction={api[${sourceLiteral(name)}][${sourceLiteral(remove.localName)}]}
                  agentLabel={\`Remove \${record.${entity.displayField}}\`}
                >Remove</button> : null}
              </div>
            </article>
          )}
        </For>
      </div>
      ${historyPanel}
    </section>
  );
}`;
}

function adminStudioSource(app: AppBlueprint): string {
  if (!app.admin) return "";
  const entityCards = app.admin.entities.map((name) => {
    const entity = app.entities[name];
    const fields = Object.entries(entity.fields).map(([fieldName, field]) =>
      `<li class="rounded-lg bg-slate-100 px-2 py-1"><span class="font-semibold">{${sourceLiteral(fieldName)}}</span> <span class="text-slate-500">{${sourceLiteral(field.type)}}</span></li>`).join("\n                ");
    return `<article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div class="flex items-start justify-between gap-4">
              <div><h3 class="font-semibold">{${sourceLiteral(humanize(name))}}</h3>
              <p class="mt-1 text-sm text-slate-500">{${sourceLiteral(entity.description)}}</p></div>
              <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">{props.${name}Records.length} records</span>
            </div>
            <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt class="text-slate-400">Ownership</dt><dd class="font-medium">{${sourceLiteral(humanize(entity.ownership ?? "user"))}}</dd></div>
              <div><dt class="text-slate-400">Updates</dt><dd class="font-medium">{${sourceLiteral(entity.realtime ? "Realtime" : "Request / response")}}</dd></div>
            </dl>
            <ul class="mt-4 flex flex-wrap gap-2 text-xs" aria-label={${sourceLiteral(`${humanize(name)} fields`)}}>
              ${fields}
            </ul>
          </article>`;
  }).join("\n          ");
  const panels = app.admin.entities.map((name) =>
    `<${typeName(name)}Panel {...props} studioReadOnly={${sourceLiteral(!app.admin!.allowMutations)}} showHistory={true} />`).join("\n        ");
  return `function AdminStudio(props: AppViewProps) {
  return (
    <section>
      <div class="rounded-2xl bg-slate-950 p-6 text-white shadow-sm sm:p-8">
        <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div><p class="text-xs font-bold uppercase tracking-[.18em] text-emerald-300">Generated admin studio</p>
          <h2 class="mt-2 text-2xl font-semibold sm:text-3xl">Schema and data operations</h2>
          <p class="mt-3 max-w-2xl text-slate-300">Inspect the generated schema and operate records through the same typed, role-checked server actions used by the product UI and MCP.</p></div>
          <div class="flex flex-wrap gap-2"><span class="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold">{props.user.role}</span>
          <a class="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20" href="/__clank/oauth/access">Agent access</a></div>
        </div>
        <dl class="mt-6 grid gap-3 sm:grid-cols-3">
          <div class="rounded-xl bg-white/5 p-4"><dt class="text-xs uppercase tracking-wide text-slate-400">Collections</dt><dd class="mt-1 text-2xl font-semibold">{${app.admin.entities.length}}</dd></div>
          <div class="rounded-xl bg-white/5 p-4"><dt class="text-xs uppercase tracking-wide text-slate-400">Records visible</dt><dd class="mt-1 text-2xl font-semibold">{${app.admin.entities.map((name) => `props.${name}Records.length`).join(" + ")}}</dd></div>
          <div class="rounded-xl bg-white/5 p-4"><dt class="text-xs uppercase tracking-wide text-slate-400">Mode</dt><dd class="mt-1 text-base font-semibold">{${sourceLiteral(app.admin.allowMutations ? "Role-checked writes" : "Read-only")}}</dd></div>
        </dl>
      </div>
      <div class="mt-6 grid gap-4 lg:grid-cols-2">
        ${entityCards}
      </div>
      <div class="mt-10 space-y-12">
        ${panels}
      </div>
    </section>
  );
}`;
}

function draftDefaultSource(field: AppFieldDefinition): string {
  if (field.type === "boolean") return sourceLiteral(Object.hasOwn(field, "default") ? field.default : false);
  if (field.type === "datetime") return '""';
  if (Object.hasOwn(field, "default")) return sourceLiteral(field.default === null ? "" : String(field.default));
  if (field.type === "enum") return sourceLiteral(field.values![0]);
  return '""';
}

function draftValueSource(type: string, fieldName: string, field: AppFieldDefinition): string {
  if (field.type === "boolean") return `draft_${fieldName}.value`;
  const empty = `draft_${fieldName}.value.trim() === ""`;
  let value: string;
  if (field.type === "number") value = `Number(draft_${fieldName}.value)`;
  else if (field.type === "datetime") value = `new Date(draft_${fieldName}.value).toISOString()`;
  else if (field.type === "reference" || field.type === "enum") {
    value = `draft_${fieldName}.value as ${type}[${sourceLiteral(fieldName)}]`;
  } else value = `draft_${fieldName}.value.trim()`;
  if (field.nullable) return `${empty} ? null : ${value}`;
  if (field.required === false || Object.hasOwn(field, "default")) return `${empty} ? undefined : ${value}`;
  return value;
}

function fieldControlSource(
  app: AppBlueprint,
  entityName: string,
  fieldName: string,
  field: AppFieldDefinition,
): string {
  const id = `${entityName}-${fieldName}`;
  const label = humanize(fieldName);
  const required = field.required !== false && !Object.hasOwn(field, "default") && !field.nullable;
  const attributes = [
    `id=${sourceLiteral(id)}`,
    `name=${sourceLiteral(fieldName)}`,
    ...(required ? ["required"] : []),
    ...(field.min === undefined ? [] : [field.type === "number" ? `min={${field.min}}` : `minlength={${field.min}}`]),
    ...(field.max === undefined ? [] : [field.type === "number" ? `max={${field.max}}` : `maxlength={${field.max}}`]),
    ...(field.type === "number" && field.integer ? ['step="1"'] : field.type === "number" ? ['step="any"'] : []),
    `agentId=${sourceLiteral(`${entityName}-${fieldName}-input`)}`,
    `agentLabel=${sourceLiteral(`${humanize(entityName.replace(/s$/u, ""))} ${label}`)}`,
  ].join(" ");
  const description = field.description
    ? `<p class="mt-1 text-xs text-slate-500">{${sourceLiteral(field.description)}}</p>`
    : "";
  if (field.type === "boolean") {
    return `          <div class="sm:col-span-2">
            <label class="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3" for=${sourceLiteral(id)}>
              <input type="checkbox" ${attributes} bind:checked={draft_${fieldName}} />
              <span class="font-medium">{${sourceLiteral(label)}}</span>
            </label>
            ${description}
          </div>`;
  }
  if (field.type === "enum") {
    const options = field.values!.map((value) => `<option value=${sourceLiteral(value)}>{${sourceLiteral(value)}}</option>`).join("");
    return `          <div>
            <label class="text-sm font-semibold" for=${sourceLiteral(id)}>{${sourceLiteral(label)}}</label>
            <select class="mt-1 w-full rounded-xl border border-slate-300 bg-white px-4 py-3" ${attributes} bind:value={draft_${fieldName}}>${options}</select>
            ${description}
          </div>`;
  }
  if (field.type === "reference") {
    const target = app.entities[field.entity!];
    return `          <div>
            <label class="text-sm font-semibold" for=${sourceLiteral(id)}>{${sourceLiteral(label)}}</label>
            <select class="mt-1 w-full rounded-xl border border-slate-300 bg-white px-4 py-3" ${attributes} bind:value={draft_${fieldName}}>
              <option value="">{${sourceLiteral(`Choose ${humanize(field.entity!).toLowerCase()}…`)}}</option>
              <For each={props.${field.entity}Records} by="_id">
                {(option) => <option value={option._id}>{option.${target.displayField}}</option>}
              </For>
            </select>
            ${description}
          </div>`;
  }
  if (field.type === "text") {
    return `          <div class="sm:col-span-2">
            <label class="text-sm font-semibold" for=${sourceLiteral(id)}>{${sourceLiteral(label)}}</label>
            <textarea class="mt-1 min-h-28 w-full resize-y rounded-xl border border-slate-300 bg-white px-4 py-3" ${attributes} bind:value={draft_${fieldName}} />
            ${description}
          </div>`;
  }
  const inputType = field.type === "string"
    ? "text"
    : field.type === "datetime"
      ? "datetime-local"
      : field.type;
  return `          <div>
            <label class="text-sm font-semibold" for=${sourceLiteral(id)}>{${sourceLiteral(label)}}</label>
            <input class="mt-1 w-full rounded-xl border border-slate-300 bg-white px-4 py-3" type=${sourceLiteral(inputType)} ${attributes} bind:value={draft_${fieldName}} />
            ${description}
          </div>`;
}

function browserSource(app: AppBlueprint): string {
  const names = Object.keys(app.entities);
  const historyNames = app.admin ? [...app.admin.entities] : [];
  const types = names.map(typeName).join(", ");
  const state = names.map((name) =>
    `    ${name}: { records: ${typeName(name)}[]; version: number;${historyNames.includes(name) ? ` revisions: Array<DocumentRevision<typeof schema, ${sourceLiteral(name)}>>;` : ""} };`).join("\n");
  const fallback = names.map((name) =>
    `      ${name}: { records: [], version: 0${historyNames.includes(name) ? ", revisions: []" : ""} },`).join("\n");
  const seeds = names.map((name) => {
    const list = generatedEntityActions(app, name, app.entities[name]).find((action) => action.behavior === "list")!;
    const history = generatedEntityActions(app, name, app.entities[name]).find((action) => action.behavior === "history");
    return `client.seed(client.api[${sourceLiteral(name)}][${sourceLiteral(list.localName)}], {}, boot.entities.${name}.records, boot.entities.${name}.version);${history ? `
client.seed(client.api[${sourceLiteral(name)}][${sourceLiteral(history.localName)}], { limit: 25 }, boot.entities.${name}.revisions, boot.entities.${name}.version);` : ""}`;
  }).join("\n");
  const live = names.map((name) => {
    const list = generatedEntityActions(app, name, app.entities[name]).find((action) => action.behavior === "list")!;
    return app.entities[name].realtime
      ? `  const canRead_${name} = roleAllowed(user.role, ${sourceLiteral(list.roles)});
  const live_${name} = canRead_${name}
    ? client.live(client.api[${sourceLiteral(name)}][${sourceLiteral(list.localName)}])
    : null;`
      : `  const canRead_${name} = roleAllowed(user.role, ${sourceLiteral(list.roles)});
  const records_${name} = signal(boot.entities.${name}.records);`;
  }).join("\n");
  const dispose = names
    .filter((name) => app.entities[name].realtime)
    .map((name) => `    live_${name}?.dispose();`).join("\n");
  const historyState = historyNames.map((name) => {
    const history = generatedEntityActions(app, name, app.entities[name]).find((action) => action.behavior === "history")!;
    return `  const revisions_${name} = signal(boot.entities.${name}.revisions);
  const canReadHistory_${name} = boot.route === ${sourceLiteral(app.admin!.path)} && roleAllowed(user.role, ${sourceLiteral(history.roles)});
  const liveHistory_${name} = canReadHistory_${name}
    ? client.live(client.api[${sourceLiteral(name)}][${sourceLiteral(history.localName)}], { limit: 25 })
    : null;
  const stopHistory_${name} = effect(() => {
    const next = liveHistory_${name}?.data.value;
    if (next) revisions_${name}.value = next;
  });
  const refreshHistory_${name} = () => canReadHistory_${name}
    ? client.query(client.api[${sourceLiteral(name)}][${sourceLiteral(history.localName)}], { limit: 25 }).then((value) => { revisions_${name}.value = value; })
    : Promise.resolve();`;
  }).join("\n");
  const historyDispose = historyNames.map((name) => `    stopHistory_${name}();
    liveHistory_${name}?.dispose();`).join("\n");
  const refresh = names
    .filter((name) => !app.entities[name].realtime)
    .map((name) => {
      const list = generatedEntityActions(app, name, app.entities[name]).find((action) => action.behavior === "list")!;
      return `    canRead_${name}
      ? client.query(client.api[${sourceLiteral(name)}][${sourceLiteral(list.localName)}]).then((value) => { records_${name}.value = value; })
      : Promise.resolve(),`;
    }).join("\n");
  const refreshHistory = historyNames.map((name) => `    refreshHistory_${name}(),`).join("\n");
  const version = [
    ...names.map((name) => app.entities[name].realtime
      ? `live_${name}?.version.value ?? boot.entities.${name}.version`
      : `boot.entities.${name}.version`),
    ...historyNames.map((name) => `liveHistory_${name}?.version.value ?? boot.entities.${name}.version`),
  ].join(", ");
  const connected = [
    ...names.filter((name) => app.entities[name].realtime)
      .map((name) => `(!live_${name} || (!live_${name}.loading.value && !live_${name}.error.value))`),
    ...historyNames.map((name) => `(!liveHistory_${name} || (!liveHistory_${name}.loading.value && !liveHistory_${name}.error.value))`),
  ].join(" && ") || "true";
  const props = names.map((name) => {
    const entity = app.entities[name];
    const actions = generatedEntityActions(app, name, entity);
    const create = actions.find((action) => action.behavior === "create")!;
    const remove = actions.find((action) => action.behavior === "delete")!;
    const toggle = actions.find((action) => action.behavior === "toggle");
    const history = actions.find((action) => action.behavior === "history");
    const restore = actions.find((action) => action.behavior === "restore");
    const records = entity.realtime
      ? `live_${name}?.data.value ?? boot.entities.${name}.records`
      : `records_${name}.value`;
    const entityVersion = entity.realtime
      ? `live_${name}?.version.value ?? boot.entities.${name}.version`
      : `boot.entities.${name}.version`;
    const revisionProps = history && restore ? `
      ${name}Revisions={revisions_${name}.value}
      ${name}RefreshHistory={refreshHistory_${name}}
      ${name}Restore={(id, cursor, version) => mutate(() => client.mutate(client.api[${sourceLiteral(name)}][${sourceLiteral(restore.localName)}], { id, revision: cursor.revision, sequence: cursor.sequence, version }))}` : "";
    return `      ${name}Records={${records}}
      ${name}Version={${entityVersion}}
      ${name}Create={(input) => mutate(() => client.mutate(client.api[${sourceLiteral(name)}][${sourceLiteral(create.localName)}], input))}
      ${toggle ? `${name}Toggle={(id, value, version) => mutate(() => client.mutate(client.api[${sourceLiteral(name)}][${sourceLiteral(toggle.localName)}], { id, value, version }))}\n      ` : ""}${name}Remove={(id, version) => mutate(() => client.mutate(client.api[${sourceLiteral(name)}][${sourceLiteral(remove.localName)}], { id, version }))}${revisionProps}`;
  }).join("\n");
  return `/* @clankImportSource @clank.run/framework */
import {
  AuthGate,
  createClient,
  effect,
  hydrate,
  onCleanup,
  readState,
  signal,
  type AuthState,
  type DefaultAuthProfile,
  type DocumentRevision,
} from "@clank.run/framework";
import type { backend, schema, ${types} } from "./backend.ts";
import { AppView } from "./view.tsx";

interface PageState {
  auth: AuthState<DefaultAuthProfile>;
  route: string;
  entities: {
${state}
  };
  version: number;
}

const boot = readState<PageState>() ?? {
  auth: { user: null, session: null },
  route: ${sourceLiteral(app.routes[0].path)},
  entities: {
${fallback}
  },
  version: 0,
};
const client = createClient<typeof backend>({ initialAuth: boot.auth });
${seeds}

function roleAllowed(role: string, roles: readonly string[]): boolean {
  return roles.length === 0 || roles.includes(role);
}

function LiveApp() {
  const user = client.auth.user.value!;
${live}
${historyState}
  const pending = signal(0);
  const error = signal("");
  const refreshStatic = () => Promise.all([
${refresh}
${refreshHistory}
  ]);
  onCleanup(() => {
${dispose}
${historyDispose}
  });
  const mutate = async <Output,>(operation: () => Promise<Output>): Promise<boolean> => {
    pending.value++;
    error.value = "";
    try {
      await operation();
      try {
        await refreshStatic();
      } catch {
        error.value = "The action completed, but request/response data could not be refreshed.";
      }
      return true;
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "The application action failed.";
      return false;
    } finally {
      pending.value--;
    }
  };
  return (
    <AppView
      route={boot.route}
      user={user}
      version={Math.max(boot.version, ${version})}
      connected={${connected}}
      pending={pending.value > 0}
      error={error.value}
${props}
      logout={() => client.auth.logout()}
    />
  );
}

hydrate(document.getElementById("app")!, (
  <AuthGate auth={client.auth}><LiveApp /></AuthGate>
));
`;
}

function serverSource(app: AppBlueprint): string {
  const names = Object.keys(app.entities);
  const initials = names.map((name) => {
    const actions = generatedEntityActions(app, name, app.entities[name]);
    const list = actions.find((action) => action.behavior === "list")!;
    const history = actions.find((action) => action.behavior === "history");
    const allowed = list.roles.length
      ? `${sourceLiteral(list.roles)}.includes(caller.auth.user.role)`
      : "true";
    const historyAllowed = history?.roles.length
      ? `${sourceLiteral(history.roles)}.includes(caller.auth.user.role)`
      : "true";
    return `  const initial_${name} = caller.auth.user && ${allowed}
    ? caller.query(api[${sourceLiteral(name)}][${sourceLiteral(list.localName)}])
    : { value: [], version: runtime.version };${history ? `
  const initialHistory_${name} = caller.auth.user && ${historyAllowed} && route === ${sourceLiteral(app.admin && app.admin.entities.includes(name) ? app.admin.path : "")}
    ? caller.query(api[${sourceLiteral(name)}][${sourceLiteral(history.localName)}], { limit: 25 })
    : { value: [], version: runtime.version };` : ""}`;
  }).join("\n");
  const stateEntities = names.map((name) => {
    const history = generatedEntityActions(app, name, app.entities[name]).some((action) => action.behavior === "history");
    return `        ${name}: { records: initial_${name}.value, version: initial_${name}.version${history ? `, revisions: initialHistory_${name}.value` : ""} },`;
  }).join("\n");
  const props = names.map((name) => {
    const entity = app.entities[name];
    const history = generatedEntityActions(app, name, entity).some((action) => action.behavior === "history");
    return `          ${name}Records={initial_${name}.value}
          ${name}Version={initial_${name}.version}
          ${name}Create={() => Promise.resolve(false)}
          ${entity.completionField ? `${name}Toggle={() => Promise.resolve(false)}\n          ` : ""}${name}Remove={() => Promise.resolve(false)}${history ? `
          ${name}Revisions={initialHistory_${name}.value}
          ${name}RefreshHistory={() => Promise.resolve()}
          ${name}Restore={() => Promise.resolve(false)}` : ""}`;
  }).join("\n");
  const versions = names.flatMap((name) => [
    `initial_${name}.version`,
    ...(generatedEntityActions(app, name, app.entities[name]).some((action) => action.behavior === "history")
      ? [`initialHistory_${name}.version`]
      : []),
  ]).join(", ");
  const access = app.routes.map((route) =>
    `${sourceLiteral(route.path)}: ${typeof route.access === "object" ? sourceLiteral(route.access.roles ?? []) : "[]"}`)
    .concat(app.admin ? [`${sourceLiteral(app.admin.path)}: ${sourceLiteral(app.admin.roles)}`] : [])
    .join(",\n  ");
  const routeRegistrations = app.routes.map((route) =>
    `  .get(${sourceLiteral(route.path)}, ({ request }) => renderRoute(request, ${sourceLiteral(route.path)}))`)
    .concat(app.admin
      ? [`  .get(${sourceLiteral(app.admin.path)}, ({ request }) => renderRoute(request, ${sourceLiteral(app.admin.path)}))`]
      : [])
    .join("\n");
  return `/* @clankImportSource @clank.run/framework */
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
} from "@clank.run/framework";
import { backend } from "./backend.ts";
import { openAppServices } from "./services.ts";
import { AppView } from "./view.tsx";

const processRef = (globalThis as unknown as {
  process?: {
    env?: Record<string, string | undefined>;
    once?(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  };
}).process;
const environment = processRef?.env ?? {};
const root = decodeURIComponent(new URL("./", import.meta.url).pathname);
const frameworkRoot = decodeURIComponent(new URL("../node_modules/@clank.run/framework/dist/", import.meta.url).pathname);
const databasePath = environment.CLANK_DATABASE_PATH ?? environment.CLANK_DATABASE ?? "app.sqlite";
const services = await openAppServices(environment);
const runtime = await openBackend(backend, {
  path: databasePath,
  agent: {
    name: ${sourceLiteral(app.slug)},
    title: ${sourceLiteral(app.name)},
    description: ${sourceLiteral(`${app.description} Its documented server actions are available to authenticated MCP clients.`)},
  },
});
const observability = createObservability({
  serviceName: ${sourceLiteral(app.slug)},
  environment: environment.NODE_ENV ?? "development",
});
observability.health.register("database", () => {
  runtime.version;
  return true;
});
observability.health.register("services", async () => {
  const checks = await services.health();
  return Object.values(checks).every((check) => check.ok);
});
const api = createApi<typeof backend>();
const appFiles = staticFiles(root);
const frameworkFiles = staticFiles(frameworkRoot, {
  prefix: "/_clank",
  cacheControl: environment.CLANK_DEV === "1"
    ? "no-cache"
    : "public, max-age=31536000, immutable",
});
const routeRoles: Readonly<Record<string, readonly string[]>> = {
  ${access}
};

async function renderRoute(request: Request, route: string): Promise<Response> {
  const caller = await runtime.caller(request);
  if (!caller.auth) throw new Error("Auth runtime is unavailable.");
  const requiredRoles = routeRoles[route] ?? [];
  if (caller.auth.user && requiredRoles.length && !requiredRoles.includes(caller.auth.user.role)) {
    return new Response("This account does not have access to this route.", {
      status: 403,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const bootAuth = authState(caller.auth);
${initials}
  const version = Math.max(runtime.version, ${versions});
  const authClient = createAuthClient({ initial: bootAuth, immediate: false });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const page = await renderDocument(
    <AuthGate auth={authClient}>
      <AppView
          route={route}
          user={bootAuth.user!}
          version={version}
          connected={true}
          pending={false}
          error=""
${props}
          logout={() => {}}
        />
    </AuthGate>,
    {
      title: ${sourceLiteral(app.name)},
      bodyClass: "m-0 bg-slate-50 antialiased",
      nonce,
      head: (
        <>
          <script type="importmap" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify({ imports: { "@clank.run/framework": "/_clank/index.js" } }) }} />
          <link rel="stylesheet" href="/styles.css" />
        </>
      ),
      state: {
        auth: bootAuth,
        route,
        entities: {
${stateEntities}
        },
        version,
      },
      scripts: ["/app.js"],
    },
  );
  return html(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'self'",
        \`script-src 'self' 'nonce-\${nonce}'\`,
        "style-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
    },
  });
}

const app = createApp()
  .use(observability.middleware())
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get(${sourceLiteral(app.deployment.healthPath)}, () => observability.health.response())
${routeRegistrations}
  .get("/app.js", ({ request }) => appFiles.handle(request))
  .get("/view.js", ({ request }) => appFiles.handle(request))
  .get("/styles.css", ({ request }) => appFiles.handle(request))
  .get("/_clank/*", ({ request }) => frameworkFiles.handle(request))
  .route("*", "*", ({ request }) => runtime.handle(request));

const server = await serve(app, {
  hostname: environment.HOST ?? "127.0.0.1",
  port: Number(environment.PORT ?? 3000),
  trustProxy: environment.TRUST_PROXY === "1",
  allowedHosts: environment.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  const serverClose = server.close();
  runtime.close();
  const closeResults = await Promise.allSettled([serverClose, services.close()]);
  await observability.close();
  const closeFailure = closeResults.find((result) => result.status === "rejected");
  if (closeFailure?.status === "rejected") throw closeFailure.reason;
};
const closeForSignal = () => void close().catch((error) => {
  console.error("Application shutdown failed.", error instanceof Error ? error.message : "Unknown failure.");
  processRef?.exit?.(1);
});
processRef?.once?.("SIGINT", closeForSignal);
processRef?.once?.("SIGTERM", closeForSignal);
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
    case "text": source = `s.string(${sourceLiteral(options)})`; break;
    case "number": source = `s.number(${sourceLiteral({ ...options, integer: field.integer ?? false })})`; break;
    case "boolean": source = `s.boolean(${field.description ? sourceLiteral(field.description) : ""})`; break;
    case "email": source = `s.email(${sourceLiteral(options)})`; break;
    case "url": source = `s.url(${sourceLiteral(field.description ? { description: field.description } : {})})`; break;
    case "date": source = `s.date(${field.description ? sourceLiteral(field.description) : ""})`; break;
    case "datetime": source = `s.datetime(${field.description ? sourceLiteral(field.description) : ""})`; break;
    case "enum": source = `s.enum(${sourceLiteral(field.values)} as const${field.description ? `, ${sourceLiteral(field.description)}` : ""})`; break;
    case "reference": source = `s.id(${sourceLiteral(field.entity)}${field.description ? `, ${sourceLiteral(field.description)}` : ""})`; break;
  }
  if (!wrappers) return source;
  if (field.nullable) source = `s.nullable(${source})`;
  if (Object.hasOwn(field, "default")) source = `s.default(${source}, ${sourceLiteral(field.default)})`;
  else if (field.required === false) source = `s.optional(${source})`;
  return source;
}

function createSchemaSource(field: AppFieldDefinition): string {
  return schemaSource(field);
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

function allowedDataModuleSuffix(input: string): boolean {
  let end = input.length;
  if (input.charCodeAt(end - 1) === 59) {
    end--;
    while (end > 0 && isWhitespaceCharacter(input[end - 1])) end--;
  }
  if (end === 0) return true;
  const suffix = input.slice(0, end);
  if (wordSequence(suffix, ["as", "const"])) return true;
  const keyword = "satisfies";
  if (!suffix.startsWith(keyword) || !isWhitespaceCharacter(suffix[keyword.length])) return false;
  let index = keyword.length + 1;
  while (index < suffix.length && isWhitespaceCharacter(suffix[index])) index++;
  return index < suffix.length;
}

function wordSequence(input: string, words: readonly string[]): boolean {
  let index = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex]!;
    if (!input.startsWith(word, index)) return false;
    index += word.length;
    if (wordIndex === words.length - 1) return index === input.length;
    if (!isWhitespaceCharacter(input[index])) return false;
    while (index < input.length && isWhitespaceCharacter(input[index])) index++;
  }
  return index === input.length;
}

function isWhitespaceCharacter(character: string | undefined): boolean {
  return character !== undefined && character.trim() === "";
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
    if (remainder && !allowedDataModuleSuffix(remainder)) {
      throw this.error("Only a data literal and optional `satisfies` or `as const` clause are allowed.");
    }
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
  const allowed = stringArray(input.roles, `${path}.roles`, 1);
  unique(allowed, `${path}.roles`);
  for (const role of allowed) if (!Object.hasOwn(roles, role)) throw new TypeError(`${path} references unknown role ${role}.`);
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
  if (UNSAFE_TEXT.test(output)) throw new TypeError(`${path} contains an unsafe control character.`);
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
  return trimBoundaryCode(value.toLowerCase().replace(/[^a-z0-9]+/gu, "-"), 45).slice(0, 63) || "clank-app";
}

function routePath(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !/^(?:\/|\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/u.test(value)
  ) {
    throw new TypeError(`${path} must be a static absolute path without parameters, a trailing slash, query, or hash.`);
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
  if (value.length > 1_000) throw new TypeError(`${path} must contain at most 1000 entries.`);
  const output = value.map((entry) => entry.trim());
  if (output.some((entry) => entry.length > 1_000 || UNSAFE_TEXT.test(entry))) {
    throw new TypeError(`${path} entries must contain at most 1000 safe text characters.`);
  }
  return output;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${path} must be one of: ${values.join(", ")}.`);
  return value as T;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique.`);
}

const SOURCE_LITERAL_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "<": "\\u003C",
  ">": "\\u003E",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

function sourceLiteral(value: unknown, space?: number): string {
  const serialized = JSON.stringify(value, null, space);
  if (serialized === undefined) throw new TypeError("Generated source values must be JSON serializable.");
  return serialized.replace(/[<>\u2028\u2029]/gu, (character) => SOURCE_LITERAL_ESCAPES[character]!);
}

function property(value: string): string {
  return NAME.test(value) ? value : sourceLiteral(value);
}

function typeName(value: string): string {
  return value.split(/[^A-Za-z0-9]+/u).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("").replace(/s$/u, "") || "Record";
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function fileName(value: string): string {
  return trimBoundaryCode(value.toLowerCase().replace(/[^a-z0-9]+/gu, "_"), 95) || "migration";
}

function trimBoundaryCode(value: string, code: number): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === code) start++;
  while (end > start && value.charCodeAt(end - 1) === code) end--;
  return value.slice(start, end);
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
