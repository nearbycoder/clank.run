import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
});

test("TypeScript blueprint modules are statically parsed without executing code", () => {
  const source = `
    import type { AppBlueprintInput } from "clank.run/blueprint";
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
  assert.match(files.find((file) => file.path === "src/view.tsx").contents, /Complete/);
});

test("plan, explain, and generate CLI commands create a buildable app without blueprint execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-blueprint-cli-"));
  const source = join(root, "clank.app.ts");
  const target = join(root, "generated");
  await writeFile(source, `export default ${JSON.stringify(todoist, null, 2)} satisfies import("clank.run/blueprint").AppBlueprintInput;\n`);
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
    assert.equal(packageJson.dependencies["clank.run"], `^${version}`);
    assert.match(await readFile(join(target, "src", "server.tsx"), "utf8"), /Focused Tasks/);
    const savedPlan = JSON.parse(await readFile(join(target, ".clank", "plan.json"), "utf8"));
    assert.equal(savedPlan.digest, parsedPlan.digest);

    const repeated = await run(["generate", target, `--blueprint=${source}`]);
    assert.match(repeated.stdout, /0 files written, 11 unchanged/);
    await run(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "backend.js"), "utf8"), /by_priority/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
