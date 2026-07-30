import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBackend, renderToString } from "../dist/index.js";
import {
  createAppPlan,
  defineApp,
  explainApp,
  generateAppFiles,
  parseAppBlueprint,
} from "../dist/blueprint.js";

const repository = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../scripts/clank.mjs", import.meta.url));
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

const todoist = {
  name: "Focused Tasks",
  description: "A collaborative task planner generated from a reviewable contract.",
  auth: {
    required: true,
    organizations: true,
    roles: {
      owner: {
        description: "Workspace owner.",
        permissions: ["tasks.*", "members.*"],
      },
      member: {
        description: "Workspace member.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  entities: {
    tasks: {
      description: "Actionable work.",
      ownership: "workspace",
      realtime: true,
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
        priority: {
          type: "enum",
          values: ["low", "normal", "high"],
          default: "normal",
        },
      },
      indexes: {
        by_done: { fields: ["done"] },
        by_priority: { fields: ["priority"] },
      },
    },
  },
  relationships: [],
  routes: [
    {
      path: "/",
      view: "TaskList",
      entity: "tasks",
      access: { roles: ["owner", "member"] },
    },
  ],
  actions: {
    "tasks.create": {
      description: "Create a task in the current workspace.",
      entity: "tasks",
      operation: "create",
      roles: ["owner", "member"],
    },
    "tasks.delete": {
      description: "Delete a task.",
      entity: "tasks",
      operation: "delete",
      roles: ["owner"],
      confirmation: "always",
    },
  },
  services: {
    reminders: {
      kind: "jobs",
      description: "Deliver scheduled reminders.",
      required: true,
      capabilities: ["delayed", "retry"],
    },
  },
  deployment: {
    database: "sqlite",
    scale: "single",
    isolation: "container",
    healthPath: "/healthz",
  },
};

const multiEntityApp = {
  name: "Delivery Workspace",
  description: "Projects with related tasks, notes, and release gates.",
  auth: {
    roles: {
      owner: { description: "Workspace owner.", permissions: ["workspace.*"] },
      member: { description: "Workspace member.", permissions: ["workspace.read", "workspace.write"] },
    },
  },
  entities: {
    projects: {
      description: "Top-level delivery projects.",
      ownership: "user",
      displayField: "name",
      fields: {
        name: { type: "string", min: 1, max: 100 },
      },
    },
    tasks: {
      description: "Work that is deleted with its project.",
      ownership: "user",
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
        projectId: { type: "reference", entity: "projects" },
      },
    },
    notes: {
      description: "Notes retained after their project is deleted.",
      ownership: "user",
      realtime: false,
      displayField: "body",
      fields: {
        body: { type: "text", min: 1, max: 2_000 },
        projectId: { type: "reference", entity: "projects", nullable: true },
      },
    },
    gates: {
      description: "Release gates that must be removed explicitly.",
      ownership: "user",
      displayField: "title",
      fields: {
        title: { type: "string", min: 1, max: 100 },
        projectId: { type: "reference", entity: "projects" },
      },
    },
  },
  relationships: [
    { name: "projectTasks", from: "projects", to: "tasks", kind: "one-to-many", onDelete: "cascade" },
    { name: "projectNotes", from: "projects", to: "notes", kind: "one-to-many", onDelete: "nullify" },
    { name: "projectGates", from: "projects", to: "gates", kind: "one-to-many", onDelete: "restrict" },
  ],
  routes: [
    { path: "/", view: "Projects", entity: "projects", access: { roles: ["owner", "member"] } },
    { path: "/tasks", view: "Tasks", entity: "tasks", access: "authenticated" },
    { path: "/about", view: "About", description: "Generated informational route.", access: "authenticated" },
  ],
  actions: {
    "projects.view": {
      description: "List visible projects.",
      entity: "projects",
      operation: "read",
      roles: ["owner", "member"],
    },
    "projects.create": {
      description: "Create a project.",
      entity: "projects",
      operation: "create",
      roles: ["owner", "member"],
    },
    "projects.rename": {
      description: "Change project fields.",
      entity: "projects",
      operation: "update",
      behavior: "update",
      roles: ["owner"],
    },
    "projects.delete": {
      description: "Delete a project and apply its relationship policies.",
      entity: "projects",
      operation: "delete",
      roles: ["owner"],
    },
    "tasks.view": {
      description: "List visible tasks.",
      entity: "tasks",
      operation: "read",
    },
    "tasks.add": {
      description: "Create a task.",
      entity: "tasks",
      operation: "create",
    },
    "tasks.complete": {
      description: "Change task completion.",
      entity: "tasks",
      operation: "update",
    },
    "tasks.edit": {
      description: "Change task fields.",
      entity: "tasks",
      operation: "update",
      behavior: "update",
    },
    "tasks.delete": {
      description: "Delete a task.",
      entity: "tasks",
      operation: "delete",
    },
  },
  services: {
    mail: {
      kind: "email",
      description: "Required project notification delivery.",
      required: true,
      capabilities: ["send"],
    },
  },
  deployment: {
    database: "sqlite",
    scale: "single",
    isolation: "container",
    healthPath: "/healthz",
  },
};

test("app blueprints normalize, validate references, remain immutable, and explain their boundaries", () => {
  const app = defineApp(todoist);
  assert.equal(app.protocol, "clank-app/1");
  assert.equal(app.slug, "focused-tasks");
  assert.equal(app.entities.tasks.fields.done.default, false);
  assert.equal(Object.isFrozen(app.entities.tasks.fields), true);
  assert.match(explainApp(app), /Organization ownership requires/);
  assert.throws(() => {
    app.entities.tasks.fields.title.type = "boolean";
  }, TypeError);
  assert.throws(() => defineApp({
    ...todoist,
    relationships: [{
      name: "missing",
      from: "tasks",
      to: "projects",
      kind: "one-to-many",
    }],
  }), /unknown entity/);
  assert.throws(() => defineApp({
    ...multiEntityApp,
    entities: {
      task: {
        description: "Singular collision.",
        displayField: "title",
        fields: { title: { type: "string" } },
      },
      tasks: {
        description: "Plural collision.",
        displayField: "title",
        fields: { title: { type: "string" } },
      },
    },
    relationships: [],
    routes: [{ path: "/", view: "Tasks", entity: "tasks" }],
    actions: {},
  }), /both generate the type name Task/u);
  assert.throws(() => defineApp({
    ...todoist,
    routes: [{ path: "/", view: "TaskList", entity: "tasks", access: { roles: [] } }],
  }), /at least 1 non-empty strings/u);
  assert.throws(() => defineApp({
    ...todoist,
    relationships: [{
      name: "unresolved",
      from: "tasks",
      to: "tasks",
      kind: "one-to-many",
      onDelete: "restrict",
    }],
  }), /requires an explicit reference/u);
  assert.throws(() => defineApp({
    ...multiEntityApp,
    relationships: [{
      ...multiEntityApp.relationships[0],
      onDelete: "nullify",
    }],
  }), /is not nullable/u);
  assert.throws(() => defineApp({
    ...todoist,
    routes: [{ path: "/__clank/manifest", view: "Reserved", entity: "tasks" }],
  }), /framework endpoint/u);
  assert.throws(() => defineApp({
    ...todoist,
    routes: [{ path: "/healthz", view: "Health", entity: "tasks" }],
  }), /conflicts with an application route/u);
  assert.throws(() => defineApp({
    ...todoist,
    actions: {
      "tasks.then": {
        description: "Reserved action.",
        entity: "tasks",
        operation: "read",
      },
    },
  }), /typed API reference protocol/u);
});

test("TypeScript blueprint modules are statically parsed without executing code", () => {
  const source = `
    import type { AppBlueprintInput } from "@clank.run/framework/blueprint";
    // The CLI reads only this literal.
    export default ${JSON.stringify(todoist, null, 2)} satisfies AppBlueprintInput;
  `;
  assert.deepEqual(parseAppBlueprint(source), defineApp(todoist));
  globalThis.__clankBlueprintExecuted = false;
  assert.throws(
    () => parseAppBlueprint(`
      export default (() => {
        globalThis.__clankBlueprintExecuted = true;
        return {};
      })();
    `),
    /Unexpected value|Only a data literal/,
  );
  assert.equal(globalThis.__clankBlueprintExecuted, false);
  delete globalThis.__clankBlueprintExecuted;
});

test("blueprint suffix parsing stays linear and requires a real satisfies type", () => {
  assert.deepEqual(
    parseAppBlueprint(`export default ${JSON.stringify(todoist)} as
      const;`),
    defineApp(todoist),
  );
  const whitespaceOnlyType = `export default ${JSON.stringify(todoist)} satisfies ${" ".repeat(200_000)};`;
  assert.throws(
    () => parseAppBlueprint(whitespaceOnlyType),
    /Only a data literal and optional `satisfies` or `as const` clause/,
  );
});

test("blueprint plans and generated files are deterministic and checksummed", async () => {
  const first = await createAppPlan(todoist, { frameworkVersion: version });
  const second = await createAppPlan(structuredClone(todoist), { frameworkVersion: version });
  assert.deepEqual(first, second);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.ok(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(first.warnings.some((warning) => warning.includes("Organization")));
  const files = generateAppFiles(todoist, { frameworkVersion: version });
  assert.deepEqual(files.map((file) => file.path), [...files.map((file) => file.path)].sort());
  assert.match(files.find((file) => file.path === "src/backend.ts").contents, /by_priority/);
  const view = files.find((file) => file.path === "src/view.tsx").contents;
  assert.match(view, /Complete/);
  assert.match(view, /<nav class="my-6 flex flex-wrap gap-2"/);
  assert.doesNotMatch(view, /overflow-x-auto/);
  const serverSource = files.find((file) => file.path === "src/server.tsx").contents;
  assert.match(
    serverSource,
    /imports: \{ "@clank\.run\/framework": "\/_clank\/index\.js" \}/,
  );
  assert.match(serverSource, /href="\/styles\.css"/);
  assert.match(serverSource, /const serverClose = server\.close\(\);\s+runtime\.close\(\);\s+const closeResults = await Promise\.allSettled/u);
  assert.doesNotMatch(
    serverSource,
    /@tailwindcss\/browser|cdn\.jsdelivr\.net/,
  );
  assert.match(files.find((file) => file.path === "src/styles.css").contents, /@import "tailwindcss"/);
  const packageJson = JSON.parse(files.find((file) => file.path === "package.json").contents);
  assert.equal(packageJson.devDependencies.tailwindcss, "^4.2.4");
  assert.equal(packageJson.devDependencies["@tailwindcss/cli"], "^4.2.4");
  assert.match(packageJson.scripts.build, /--tailwind=src\/styles\.css/);
  assert.match(files.find((file) => file.path === "AGENTS.md").contents, /npm run deploy:check/);
  const readme = files.find((file) => file.path === "README.md").contents;
  assert.match(readme, /Focused Tasks/);
  assert.match(readme, /clank login\n/u);
  assert.doesNotMatch(readme, /clank login --server/u);
  assert.match(readme, /https:\/\/clank\.run/u);
});

test("generated TSX context-encodes every human-authored blueprint string", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-blueprint-encoding-"));
  const source = join(root, "clank.app.ts");
  const target = join(root, "generated");
  const payload = '</p><script>globalThis.__clankBlueprintInjected = true</script>{"';
  const hostile = structuredClone(todoist);
  hostile.name = `Encoded ${payload}`;
  hostile.description = payload;
  hostile.entities.tasks.description = payload;
  hostile.entities.tasks.fields.title.description = payload;
  hostile.entities.tasks.fields.priority.values = ["normal", payload];
  hostile.routes[0].view = payload;
  hostile.routes.push({
    path: "/about",
    view: payload,
    description: payload,
    access: "authenticated",
  });
  hostile.actions["tasks.create"].description = payload;
  await writeFile(source, `export default ${JSON.stringify(hostile, null, 2)} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;\n`);
  try {
    await run(["generate", target, `--blueprint=${source}`, "--framework=local"]);
    await run(["build", "src", "dist"], target);
    await mkdir(join(target, "node_modules", "@clank.run"), { recursive: true });
    await symlink(repository, join(target, "node_modules", "@clank.run", "framework"), "dir");
    globalThis.__clankBlueprintInjected = false;
    const generated = await import(`${pathToFileURL(join(target, "dist", "view.js")).href}?test=${Date.now()}`);
    const base = {
      user: {
        id: "user_test",
        email: "encoded@example.com",
        emailVerified: true,
        role: "owner",
        profile: {},
        createdAt: 1,
        updatedAt: 1,
      },
      version: 0,
      connected: true,
      pending: false,
      error: "",
      tasksRecords: [],
      tasksVersion: 0,
      tasksCreate: async () => true,
      tasksToggle: async () => true,
      tasksRemove: async () => true,
      logout: () => {},
    };
    const entityHtml = await renderToString(generated.AppView({ ...base, route: "/" }));
    const routeHtml = await renderToString(generated.AppView({ ...base, route: "/about" }));
    assert.equal(globalThis.__clankBlueprintInjected, false);
    assert.match(entityHtml, /&lt;script&gt;globalThis\.__clankBlueprintInjected/u);
    assert.match(routeHtml, /&lt;script&gt;globalThis\.__clankBlueprintInjected/u);
  } finally {
    delete globalThis.__clankBlueprintInjected;
    await rm(root, { recursive: true, force: true });
  }
});

test("plan, explain, and generate CLI commands create a buildable app without blueprint execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-blueprint-cli-"));
  const source = join(root, "clank.app.ts");
  const target = join(root, "generated");
  await writeFile(source, `export default ${JSON.stringify(todoist, null, 2)} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;\n`);
  try {
    const plan = await run(["plan", source]);
    const parsedPlan = JSON.parse(plan.stdout);
    assert.equal(parsedPlan.protocol, "clank-plan/1");
    assert.equal(parsedPlan.blueprint.slug, "focused-tasks");

    const explained = await run(["explain", source]);
    assert.match(explained.stdout, /Focused Tasks/);
    assert.match(explained.stdout, /Required service reminders/);

    await run(["generate", target, `--blueprint=${source}`]);
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies["@clank.run/framework"], `^${version}`);
    assert.equal(packageJson.scripts.doctor, "clank doctor");
    assert.match(await readFile(join(target, "src", "server.tsx"), "utf8"), /Focused Tasks/);
    const savedPlan = JSON.parse(await readFile(join(target, ".clank", "plan.json"), "utf8"));
    assert.equal(savedPlan.digest, parsedPlan.digest);

    const repeated = await run(["generate", target, `--blueprint=${source}`]);
    assert.match(repeated.stdout, /0 files written, 15 unchanged/);
    await run(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "backend.js"), "utf8"), /by_priority/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated multi-route backends enforce roles and transactional relationship deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-blueprint-runtime-"));
  const source = join(root, "clank.app.ts");
  const target = join(root, "generated");
  let runtime;
  await writeFile(source, `export default ${JSON.stringify(multiEntityApp, null, 2)} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;\n`);
  try {
    await run(["generate", target, `--blueprint=${source}`, "--framework=local"]);
    await run(["build", "src", "dist"], target);
    await mkdir(join(target, "node_modules", "@clank.run"), { recursive: true });
    await symlink(repository, join(target, "node_modules", "@clank.run", "framework"), "dir");
    const generated = await import(`${pathToFileURL(join(target, "dist", "backend.js")).href}?test=${Date.now()}`);
    const generatedServices = await import(`${pathToFileURL(join(target, "dist", "services.js")).href}?test=${Date.now()}`);
    await assert.rejects(
      () => generatedServices.openAppServices({}),
      /Service requirements are not satisfied: mail \(email\)/u,
    );
    const developmentServices = await generatedServices.openAppServices({ CLANK_DEV: "1" });
    assert.equal(developmentServices.describe()[0].name, "mail");
    await developmentServices.close();
    runtime = await openBackend(generated.backend, { path: ":memory:", wal: false });

    const owner = await register(runtime, "owner@example.com");
    const ownerCaller = await runtime.caller(authRequest("/", owner.cookie));
    const projectId = ownerCaller.mutation("projects.create", { name: "Launch" }).value;
    const project = ownerCaller.query("projects.view", {}).value[0];
    assert.equal(project._id, projectId);
    ownerCaller.mutation("tasks.add", { title: "Ship", projectId });
    ownerCaller.mutation("notes.create", { body: "Keep this", projectId });
    const gateId = ownerCaller.mutation("gates.create", { title: "Security review", projectId }).value;

    assert.throws(
      () => ownerCaller.mutation("projects.rename", { id: projectId, version: project._version, changes: {} }),
      (error) => error?.code === "EMPTY_UPDATE",
    );
    const rejected = await runtime.handle(authRequest("/__clank/mutation/projects.delete", owner.cookie, {
      body: { id: projectId, version: project._version },
      csrf: owner.csrf,
    }));
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, "RELATIONSHIP_RESTRICTED");
    assert.equal(ownerCaller.query("tasks.view", {}).value.length, 1, "cascade work must roll back after restrict");
    assert.equal(ownerCaller.query("notes.list", {}).value[0].projectId, projectId, "nullify work must roll back after restrict");

    const gate = ownerCaller.query("gates.list", {}).value.find((entry) => entry._id === gateId);
    ownerCaller.mutation("gates.remove", { id: gate._id, version: gate._version });
    ownerCaller.mutation("projects.delete", { id: projectId, version: project._version });
    assert.equal(ownerCaller.query("tasks.view", {}).value.length, 0);
    assert.equal(ownerCaller.query("notes.list", {}).value[0].projectId, null);
    assert.equal(ownerCaller.query("projects.view", {}).value.length, 0);

    const member = await register(runtime, "member@example.com");
    runtime.auth.setRole(member.user.id, "member");
    const memberCaller = await runtime.caller(authRequest("/", member.cookie));
    const memberProjectId = memberCaller.mutation("projects.create", { name: "Member project" }).value;
    const memberProject = memberCaller.query("projects.view", {}).value[0];
    assert.equal(memberProject._id, memberProjectId);
    assert.throws(
      () => memberCaller.mutation("projects.delete", { id: memberProjectId, version: memberProject._version }),
      /required role/u,
    );
    assert.throws(
      () => memberCaller.mutation("tasks.add", { title: "Cross-owner reference", projectId }),
      (error) => error?.code === "REFERENCE_NOT_FOUND",
    );
    const memberTaskId = memberCaller.mutation("tasks.add", {
      title: "Member task",
      projectId: memberProjectId,
    }).value;
    const memberTask = memberCaller.query("tasks.view", {}).value.find((entry) => entry._id === memberTaskId);
    assert.throws(
      () => memberCaller.mutation("tasks.edit", {
        id: memberTask._id,
        version: memberTask._version,
        changes: { projectId },
      }),
      (error) => error?.code === "REFERENCE_NOT_FOUND",
    );

    const manifestResponse = await runtime.handle(new Request("https://generated.test/__clank/manifest"));
    const agentFunctions = (await manifestResponse.json()).functions
      .filter((entry) => entry.agent)
      .map((entry) => entry.name);
    assert.ok(agentFunctions.includes("projects.view"));
    assert.ok(agentFunctions.includes("projects.rename"));
    assert.ok(agentFunctions.includes("tasks.complete"));
    assert.ok(agentFunctions.includes("tasks.edit"));
    assert.equal(agentFunctions.includes("projects.list"), false);
    assert.equal(agentFunctions.includes("projects.remove"), false);

    const server = await readFile(join(target, "src", "server.tsx"), "utf8");
    assert.match(server, /\.get\("\/tasks"/u);
    assert.match(server, /openAppServices/u);
    assert.match(await readFile(join(target, "src", "view.tsx"), "utf8"), /props\.projectsRecords/u);
    const browser = await readFile(join(target, "src", "app.tsx"), "utf8");
    assert.match(browser, /records_notes = signal/u);
    assert.match(browser, /client\.query\(client\.api\["notes"\]\["list"\]\)/u);
    assert.doesNotMatch(browser, /client\.live\(client\.api\["notes"\]/u);
  } finally {
    runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function authRequest(path, cookie, options = {}) {
  return new Request(`https://generated.test${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined ? {} : {
        "content-type": "application/json",
        origin: "https://generated.test",
      }),
      ...(cookie ? { cookie } : {}),
      ...(options.csrf ? { "x-clank-csrf": options.csrf } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function register(runtime, email) {
  const response = await runtime.handle(authRequest("/__clank/auth/register", undefined, {
    body: {
      email,
      password: "correct horse battery staple",
      profile: { name: email.split("@")[0] },
    },
  }));
  const payload = await response.json();
  assert.equal(response.status, 201);
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: payload.csrfToken,
    user: payload.user,
  };
}

function run(args, cwd = repository) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      cli,
      ...args,
    ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`CLI exited with ${code}.\n${stdout}\n${stderr}`)));
  });
}
