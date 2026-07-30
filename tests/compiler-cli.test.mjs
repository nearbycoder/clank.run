import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = new URL("..", import.meta.url);
const frameworkVersion = JSON.parse(
  await readFile(fileURLToPath(new URL("package.json", repository)), "utf8"),
).version;

async function fakeTailwind(root) {
  const executable = join(root, "fake-tailwind.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const input = process.argv[process.argv.indexOf("-i") + 1];
const output = process.argv[process.argv.indexOf("-o") + 1];
const source = await readFile(input, "utf8");
await writeFile(output, "/* compiled Tailwind test output */\\n" + source.replace('@import "tailwindcss";', ""));
`);
  await chmod(executable, 0o700);
  return executable;
}

function runCli(args, cwd = repository) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("scripts/clank.mjs", repository)),
      ...args,
    ], { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`CLI exited with ${code}`)));
  });
}

function runCliResult(args, cwd = repository, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("scripts/clank.mjs", repository)),
      ...args,
    ], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCliOutput(args, cwd = repository, env = process.env) {
  const result = await runCliResult(args, cwd, env);
  if (result.code !== 0) throw new Error(`CLI exited with ${result.code}: ${result.stderr}`);
  return result;
}

function runFrameworkBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("scripts/build.mjs", repository)),
    ], { cwd: repository, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Build exited with ${code}`)));
  });
}

async function linkFramework(target) {
  await mkdir(join(target, "node_modules", "@clank.run"), { recursive: true });
  await symlink(
    fileURLToPath(repository),
    join(target, "node_modules", "@clank.run", "framework"),
    "dir",
  );
}

function runNodeTests(cwd, testPath = "tests/app.contract.mjs") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--test",
      testPath,
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
      : reject(new Error(`Generated tests exited with ${code}.\n${stdout}\n${stderr}`)));
  });
}

test("public compiler CLI builds TSX and copies static assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-"));
  const input = join(root, "src");
  const output = join(root, "dist");
  await mkdir(input);
  await writeFile(join(input, "app.tsx"), `
    import { render, signal } from "/dist/index.js";
    const count = signal(0);
    const App = () => <button onClick={() => count.value++}>Count {count.value}</button>;
    render(document.querySelector("#app")!, <App />);
  `);
  await writeFile(join(input, "index.html"), `<main id="app"></main>`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "scripts/clank.mjs",
      "build",
      input,
      output,
      "--jsx-import-source=/dist/index.js",
    ], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`CLI exited with ${code}`)));
  });

  const javascript = await readFile(join(output, "app.js"), "utf8");
  assert.match(javascript, /__clankJSX\("button"/);
  assert.match(javascript, /__clankExpression\(\(\)=>count\.value\)/);
  assert.equal(await readFile(join(output, "index.html"), "utf8"), `<main id="app"></main>`);
  await rm(root, { recursive: true, force: true });
});

test("Clank CLI exposes its renamed version command", async () => {
  for (const command of ["--version", "-v", "version"]) {
    const result = await runCliOutput([command]);
    assert.equal(result.stdout.trim(), frameworkVersion);
    assert.equal(result.stderr, "");
  }
});

test("bare Clank is helpful without a TTY and the interactive launcher routes guided choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-bare-"));
  try {
    const bare = await runCliOutput([], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.match(bare.stdout, new RegExp(`Clank ${frameworkVersion.replaceAll(".", "\\.")}`, "u"));
    assert.match(bare.stdout, /clank create <directory>/u);
    assert.match(bare.stdout, /clank login\s+Authorize with https:\/\/clank\.run/u);
    assert.equal(bare.stderr, "");

    const {
      DEFAULT_PLATFORM_SERVER,
      runInteractive,
    } = await import("../scripts/cli-deploy.mjs");
    assert.equal(DEFAULT_PLATFORM_SERVER, "https://clank.run");

    const answers = ["1", "2", "guided-app"];
    const prompts = [];
    const invocations = [];
    let output = "";
    await runInteractive({
      ask: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
      write: (value) => { output += value; },
      execute: async (command, args) => { invocations.push({ command, args }); },
    });
    assert.match(output, /What would you like to do/u);
    assert.match(output, /Choose a template/u);
    assert.match(output, /Authenticated Todo/u);
    assert.match(output, /Minimal full-stack/u);
    assert.deepEqual(invocations, [{
      command: "create",
      args: ["guided-app", "--template=minimal"],
    }]);
    assert.deepEqual(prompts, [
      "\nSelect [1]: ",
      "\nTemplate [1]: ",
      "Project directory [my-clank-app]: ",
    ]);

    const loginInvocations = [];
    await runInteractive({
      ask: async () => "3",
      write: () => {},
      execute: async (command, args) => { loginInvocations.push({ command, args }); },
    });
    assert.deepEqual(loginInvocations, [{ command: "login", args: [] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI help is command-aware, agent-readable, and never executes the target command", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-help-"));
  try {
    const deployHelp = await runCliResult(["deploy", "--help"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(deployHelp.code, 0);
    assert.match(deployHelp.stdout, /clank deploy/);
    assert.match(deployHelp.stdout, /--dry-run/);
    assert.equal(deployHelp.stderr, "");

    const machineHelp = await runCliOutput(["help", "doctor", "--json"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    const parsed = JSON.parse(machineHelp.stdout);
    assert.equal(parsed.protocol, "clank-cli-help/1");
    assert.equal(parsed.command, "doctor");
    assert.match(parsed.usage, /--json/);
    const completeHelp = JSON.parse((await runCliOutput([
      "help",
      "--json",
    ], repository, {
      ...process.env,
      CLANK_HOME: root,
    })).stdout);
    assert.ok(completeHelp.commands.some((entry) =>
      entry.name === "templates" && entry.usage.includes("--json")));
    assert.ok(completeHelp.commands.some((entry) =>
      entry.name === "dev" && entry.usage.includes("--no-reload")));

    const typo = await runCliResult(["depoy"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /Did you mean "clank deploy"/);

    const optionTypo = await runCliResult(["deploy", "--dryrun", "--json"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(optionTypo.code, 1);
    const error = JSON.parse(optionTypo.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "UNKNOWN_OPTION");
    assert.match(error.error.message, /--dry-run/);

    const invalidDev = await runCliResult(["dev", "--host=bad,host", "--json"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(invalidDev.code, 1);
    assert.equal(invalidDev.stderr, "");
    const devError = JSON.parse(invalidDev.stdout);
    assert.equal(devError.protocol, "clank-dev-event/1");
    assert.equal(devError.type, "fatal");
    assert.match(devError.message, /Development host/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clank jobs launches the configured provider-neutral process with bounded worker settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-jobs-"));
  const resultPath = join(root, "worker-environment.json");
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "migrations"), { recursive: true });
    await writeFile(join(root, "dist", "server.js"), "");
    await writeFile(join(root, "dist", "jobs.js"), `
      import { writeFile } from "node:fs/promises";
      await writeFile(process.env.CLANK_TEST_JOB_RESULT, JSON.stringify({
        role: process.env.CLANK_PROCESS_ROLE,
        concurrency: process.env.CLANK_WORKER_CONCURRENCY,
        queues: process.env.CLANK_WORKER_QUEUES,
      }));
    `);
    await writeFile(join(root, "clank.deploy.json"), JSON.stringify({
      version: 1,
      entry: "dist/server.js",
      include: ["dist", "migrations"],
      database: {
        path: "app.sqlite",
        migrations: "migrations",
        allowUnsafeMigrations: false,
      },
      health: { path: "/healthz", timeoutMs: 5_000 },
      env: {},
      jobs: {
        entry: "dist/jobs.js",
        workers: 1,
        concurrency: 2,
        queues: ["default"],
        scheduler: true,
      },
    }));
    const result = await runCliResult([
      "jobs",
      "worker",
      "--concurrency=3",
      "--queues=email,reports",
    ], root, {
      ...process.env,
      CLANK_TEST_JOB_RESULT: resultPath,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Starting worker · concurrency 3 · queues email,reports/);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      role: "worker",
      concurrency: "3",
      queues: "email,reports",
    });

    const invalid = await runCliResult([
      "jobs",
      "scheduler",
      "--concurrency=2",
    ], root);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /apply only to clank jobs worker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clank jobs inspects and operates a linked project without exposing application payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-platform-jobs-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const jobId = `job_${"a".repeat(32)}`;
  const observed = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST") {
      response.end(JSON.stringify({
        ok: true,
        job: { id: jobId, name: "mail.send", queue: "email", state: "dead" },
      }));
      return;
    }
    response.end(JSON.stringify({
      ok: true,
      compatibility: "ready",
      health: "attention",
      stats: {
        queued: 0,
        retry: 0,
        running: 0,
        dead: 1,
        overdue: 0,
        expiredLeases: 0,
        scheduleErrors: 0,
      },
      scheduleCount: 0,
      jobs: [{
        id: jobId,
        name: "mail.send",
        queue: "email",
        state: "dead",
        attempt: 3,
        maxAttempts: 3,
        runAt: 1_700_000_000_000,
        completedAt: 1_700_000_001_000,
        hasError: true,
      }],
      privacy: {
        arguments: "hidden",
        results: "hidden",
        errors: "presence_only",
        identities: "hidden",
      },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  try {
    await mkdir(join(project, ".clank"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_platform_jobs_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    await writeFile(join(project, ".clank", "project.json"), JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_jobs_test",
    }));

    const listed = await runCliResult([
      "jobs",
      "list",
      "--state=dead",
      "--queue=email",
      "--limit=5",
      "--json",
    ], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(listed.code, 0, listed.stderr);
    const parsed = JSON.parse(listed.stdout);
    assert.equal(parsed.jobs[0].id, jobId);
    assert.equal("args" in parsed.jobs[0], false);
    assert.equal("error" in parsed.jobs[0], false);
    assert.deepEqual(observed[0], {
      method: "GET",
      url: "/api/projects/project_jobs_test/jobs?limit=5&state=dead&queue=email",
      authorization: "Bearer clnk_platform_jobs_test_token",
      body: undefined,
    });

    const cancelled = await runCliResult(["jobs", "cancel", jobId], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /Cancellation requested/);
    assert.deepEqual(observed[1], {
      method: "POST",
      url: `/api/projects/project_jobs_test/jobs/${jobId}/cancel`,
      authorization: "Bearer clnk_platform_jobs_test_token",
      body: {},
    });

    const invalid = await runCliResult(["jobs", "list", "--state=secret"], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /--state must be one of/);
    assert.equal(observed.length, 2);
    const ignoredStatusLimit = await runCliResult(["jobs", "status", "--limit=2"], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(ignoredStatusLimit.code, 1);
    assert.match(ignoredStatusLimit.stderr, /--limit applies only/);
    const ignoredMutationFilter = await runCliResult(
      ["jobs", "retry", jobId, "--state=dead"],
      project,
      {
        ...process.env,
        CLANK_HOME: home,
      },
    );
    assert.equal(ignoredMutationFilter.code, 1);
    assert.match(ignoredMutationFilter.stderr, /--state, --queue, and --limit apply only/);
    assert.equal(observed.length, 2);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment CLI rejects malformed credential state without exposing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-config-"));
  const canary = "credential-canary-must-stay-private";
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({
      version: 1,
      current: "https://platform.example",
      profiles: [{ token: canary, expiresAt: Date.now() + 60_000 }],
    }));
    const result = await runCliResult(["whoami"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid CLI configuration/);
    assert.doesNotMatch(result.stderr, new RegExp(canary));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment CLI bounds platform JSON responses before buffering them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-response-"));
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(8 * 1024 * 1024),
    });
    response.end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}`;
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({
      version: 1,
      current: `${platform}/`,
      profiles: {
        [`${platform}/`]: {
          token: "clnk_test_token_for_cli_response_bounds",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    const result = await runCliResult(["whoami"], repository, {
      ...process.env,
      CLANK_HOME: root,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Platform response exceeds 4194304 bytes/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("release cleanup CLI sends explicit confirmation and rollback-loss intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-release-cleanup-"));
  const home = join(root, "home");
  const project = join(root, "project");
  let observed;
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  try {
    await mkdir(join(project, ".clank"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_release_cleanup_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    await writeFile(join(project, ".clank", "project.json"), JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_release_cleanup",
    }));
    const releaseId = "release_cleanup_123";
    const confirmation = `delete-release tasks ${releaseId}`;
    const result = await runCliResult([
      "releases",
      "delete",
      releaseId,
      `--confirm=${confirmation}`,
      "--allow-rollback-loss",
    ], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Removed release storage/);
    assert.deepEqual(observed, {
      method: "DELETE",
      url: `/api/projects/project_release_cleanup/releases/${releaseId}`,
      authorization: "Bearer clnk_release_cleanup_test_token",
      body: {
        confirmation,
        allowRollbackLoss: true,
      },
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("project deletion CLI requires explicit data-loss intent and removes a matching local link", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-project-delete-"));
  const home = join(root, "home");
  const project = join(root, "project");
  let observed;
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      project: { id: "project_delete_test", slug: "tasks" },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  try {
    await mkdir(join(project, ".clank"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_project_delete_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    const linkPath = join(project, ".clank", "project.json");
    await writeFile(linkPath, JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_delete_test",
    }));
    const missingAcknowledgement = await runCliResult([
      "project",
      "delete",
      "--confirm=delete-site tasks",
    ], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(missingAcknowledgement.code, 1);
    assert.match(missingAcknowledgement.stderr, /acknowledge-data-loss/);
    assert.equal(observed, undefined);
    assert.equal(JSON.parse(await readFile(linkPath, "utf8")).projectId, "project_delete_test");

    const result = await runCliResult([
      "project",
      "delete",
      "--confirm=delete-site tasks",
      "--acknowledge-data-loss",
    ], project, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Deleted tasks .* application data/);
    assert.deepEqual(observed, {
      method: "DELETE",
      url: "/api/projects/project_delete_test",
      authorization: "Bearer clnk_project_delete_test_token",
      body: {
        confirmation: "delete-site tasks",
        acknowledgeDataLoss: true,
      },
    });
    await assert.rejects(access(linkPath), (error) => error.code === "ENOENT");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("activity CLI validates cursors and emits the workspace audit feed as structured JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-activity-"));
  const home = join(root, "home");
  let observed;
  const server = createHttpServer((request, response) => {
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      events: [{
        id: 8,
        action: "project.delete",
        createdAt: 1_700_000_000_000,
        organization: { id: "organization_activity", name: "Workspace" },
        project: { id: "project_activity", name: "Tasks", deleted: true },
        actor: { id: "user_activity", email: "owner@example.com", tokenId: null },
        metadata: { slug: "tasks" },
      }],
      nextBefore: 8,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_activity_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    const invalid = await runCliResult(["activity", "--limit=201"], repository, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /--limit must be an integer from 1 to 200/);
    assert.equal(observed, undefined);

    const result = await runCliResult([
      "audit",
      "--org=organization_activity",
      "--limit=2",
      "--before=9",
      "--json",
    ], repository, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      events: [{
        id: 8,
        action: "project.delete",
        createdAt: 1_700_000_000_000,
        organization: { id: "organization_activity", name: "Workspace" },
        project: { id: "project_activity", name: "Tasks", deleted: true },
        actor: { id: "user_activity", email: "owner@example.com", tokenId: null },
        metadata: { slug: "tasks" },
      }],
      nextBefore: 8,
    });
    assert.deepEqual(observed, {
      method: "GET",
      url: "/api/audit?limit=2&before=9&organizationId=organization_activity",
      authorization: "Bearer clnk_activity_test_token",
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("usage CLI exposes the stable monthly workspace contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-usage-"));
  const home = join(root, "home");
  const observed = [];
  const usage = {
    ok: true,
    protocol: "clank-usage/1",
    workspace: { id: "organization_usage", name: "Usage workspace", slug: "usage-workspace" },
    period: {
      key: "2026-07",
      startedAt: 1_783_000_000_000,
      endsAt: 1_785_700_000_000,
      current: true,
      closed: false,
      complete: true,
      trackingStartedAt: 1_780_000_000_000,
      timezone: "UTC",
    },
    usage: {
      requests: 1200,
      requestBytes: 1000,
      responseBytes: 2_000_000,
      knownTransferBytes: 2_001_000,
      rejectedRequests: 3,
    },
    limits: {
      requests: 5_000_000,
      knownTransferBytes: 100_000_000_000,
      requestsPerMinutePerProject: 3000,
    },
    remaining: { requests: 4_998_800, knownTransferBytes: 99_997_999_000 },
    resources: {
      asOf: 1_783_500_000_000,
      projects: 2,
      previews: 1,
      members: 1,
      domains: 1,
      releases: 4,
      releaseStorageBytes: 8_000_000,
    },
    projects: [{
      id: "project_usage",
      name: "Tasks",
      slug: "tasks",
      kind: "production",
      deleted: false,
      requests: 1200,
      requestBytes: 1000,
      responseBytes: 2_000_000,
      knownTransferBytes: 2_001_000,
      rejectedRequests: 3,
      updatedAt: 1_783_500_000_000,
    }],
    retentionMonths: 24,
    metering: {
      requestBoundary: "managed_ingress_admission",
      transferBoundary: "request_body_and_declared_response_content_length",
      streamedResponseBytesKnown: false,
      pricingIncluded: false,
    },
  };
  const server = createHttpServer((request, response) => {
    observed.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/projects/project_usage"
      ? { ok: true, project: { id: "project_usage", organizationId: "organization_usage" } }
      : usage));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  const environment = { ...process.env, CLANK_HOME: home };
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_usage_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    const structured = await runCliResult([
      "usage",
      "--org=organization_usage",
      "--month=2026-07",
      "--json",
    ], repository, environment);
    assert.equal(structured.code, 0, structured.stderr);
    assert.deepEqual(JSON.parse(structured.stdout), usage);

    const human = await runCliResult([
      "usage",
      "--org=organization_usage",
      "--month=2026-07",
    ], repository, environment);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Usage workspace · 2026-07 UTC · current partial month/);
    assert.match(human.stdout, /Requests: 1,200 \/ 5,000,000 · 3 rejected/);
    assert.match(human.stdout, /tasks  1,200 requests  2.00 MB known transfer/);
    assert.match(human.stdout, /no prices or invoices are calculated/);
    const invalidMonth = await runCliResult([
      "usage",
      "--org=organization_usage",
      "--month=2026-13",
      "--json",
    ], repository, environment);
    assert.equal(invalidMonth.code, 1);
    assert.deepEqual(JSON.parse(invalidMonth.stderr).error, {
      code: "INVALID_USAGE_MONTH",
      message: "--month must use YYYY-MM.",
    });
    const linked = join(root, "project");
    await mkdir(join(linked, ".clank"), { recursive: true });
    await writeFile(join(linked, ".clank", "project.json"), JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_usage",
    }));
    const resolved = await runCliResult([
      "usage",
      linked,
      "--month=2026-07",
      "--json",
    ], repository, environment);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).workspace.id, "organization_usage");
    assert.deepEqual(observed, [{
      method: "GET",
      url: "/api/usage?organizationId=organization_usage&month=2026-07",
      authorization: "Bearer clnk_usage_test_token",
    }, {
      method: "GET",
      url: "/api/usage?organizationId=organization_usage&month=2026-07",
      authorization: "Bearer clnk_usage_test_token",
    }, {
      method: "GET",
      url: "/api/projects/project_usage",
      authorization: "Bearer clnk_usage_test_token",
    }, {
      method: "GET",
      url: "/api/usage?organizationId=organization_usage&month=2026-07",
      authorization: "Bearer clnk_usage_test_token",
    }]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("organization CLI lists and administers roles and invitations", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-organization-access-"));
  const home = join(root, "home");
  const observed = [];
  const expiresAt = 1_900_000_000_000;
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? {
      ok: true,
      invitations: [{
        id: "invitation_cli_test",
        email: "developer@example.com",
        role: "developer",
        delivery: {
          status: "retrying",
          attempts: 2,
          sentAt: null,
        },
        expiresAt,
      }],
    } : { ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  const env = { ...process.env, CLANK_HOME: home };
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_organization_access_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    const listed = await runCliResult([
      "org",
      "invitations",
      "organization_cli_test",
    ], repository, env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /invitation_cli_test  developer@example\.com  developer/);
    assert.match(listed.stdout, /email retrying \(2 attempts\)/);
    assert.match(listed.stdout, new RegExp(new Date(expiresAt).toISOString()));

    const changed = await runCliResult([
      "org",
      "role",
      "organization_cli_test",
      "user_cli_test",
      "admin",
    ], repository, env);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stdout, /Changed user_cli_test to admin/);

    const revoked = await runCliResult([
      "org",
      "revoke-invite",
      "organization_cli_test",
      "invitation_cli_test",
    ], repository, env);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.match(revoked.stdout, /Revoked invitation invitation_cli_test/);
    assert.deepEqual(observed, [{
      method: "GET",
      url: "/api/organizations/organization_cli_test",
      authorization: "Bearer clnk_organization_access_test_token",
      body: undefined,
    }, {
      method: "PATCH",
      url: "/api/organizations/organization_cli_test/members/user_cli_test",
      authorization: "Bearer clnk_organization_access_test_token",
      body: { role: "admin" },
    }, {
      method: "DELETE",
      url: "/api/organizations/organization_cli_test/invitations/invitation_cli_test",
      authorization: "Bearer clnk_organization_access_test_token",
      body: undefined,
    }]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("create scaffolds a named, buildable authenticated application", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-create-"));
  const target = join(root, "team-tasks");
  try {
    await runCli(["create", target, "--name", "Team Tasks"], repository);

    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    const server = await readFile(join(target, "src", "server.tsx"), "utf8");
    const jobs = await readFile(join(target, "src", "jobs.ts"), "utf8");
    const view = await readFile(join(target, "src", "view.tsx"), "utf8");
    const tsconfig = JSON.parse(await readFile(join(target, "tsconfig.json"), "utf8"));
    const gitignore = await readFile(join(target, ".gitignore"), "utf8");
    const readme = await readFile(join(target, "README.md"), "utf8");
    const agentGuide = await readFile(join(target, "AGENTS.md"), "utf8");
    assert.equal(packageJson.name, "team-tasks");
    assert.equal(packageJson.dependencies["@clank.run/framework"], `^${frameworkVersion}`);
    assert.equal(packageJson.devDependencies.tailwindcss, "^4.2.4");
    assert.equal(packageJson.devDependencies["@tailwindcss/cli"], "^4.2.4");
    assert.match(packageJson.scripts.build, /--tailwind=src\/styles\.css/);
    assert.equal(packageJson.scripts.dev, "clank dev");
    assert.match(packageJson.scripts.test, /node --disable-warning=ExperimentalWarning --test/u);
    assert.equal(packageJson.scripts.doctor, "clank doctor");
    assert.equal(packageJson.scripts["jobs:worker"], "clank jobs worker");
    assert.equal(packageJson.scripts["jobs:scheduler"], "clank jobs scheduler");
    assert.equal(packageJson.scripts["deploy:check"], "clank deploy --dry-run");
    assert.doesNotMatch(server, /__PROJECT_TITLE__/);
    assert.doesNotMatch(view, /__PROJECT_TITLE__/);
    assert.doesNotMatch(JSON.stringify(packageJson), /__CLANK_VERSION__/);
    assert.match(server, /const projectTitle = "Team Tasks"/);
    assert.match(server, /title: projectTitle/);
    assert.match(server, /href="\/styles\.css"/);
    assert.doesNotMatch(server, /@tailwindcss\/browser|cdn\.jsdelivr\.net/);
    assert.match(jobs, /runJobProcess/);
    assert.match(server, /imports: \{ "@clank\.run\/framework": "\/_clank\/index\.js" \}/);
    assert.match(view, /const projectTitle = "Team Tasks"/);
    assert.match(view, />\{projectTitle\}</);
    assert.match(view, /<For each=\{props\.todos\} by="_id"/);
    assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
    assert.match(gitignore, /\.clank/);
    assert.match(readme, /# Team Tasks/);
    assert.match(agentGuide, /Never edit, rename, or remove an applied migration/);
    assert.equal(
      JSON.parse(await readFile(join(target, "fixtures", "default.json"), "utf8")).protocol,
      "clank-fixture/1",
    );
    assert.match(await readFile(join(target, "tests", "app.contract.mjs"), "utf8"), /keeps fixture data private/u);

    await runCli(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "server.js"), "utf8"), /Team Tasks/);
    assert.match(await readFile(join(target, "dist", "jobs.js"), "utf8"), /runJobProcess/);
    assert.match(await readFile(join(target, "dist", "view.js"), "utf8"), /Team Tasks/);
    await linkFramework(target);
    await runNodeTests(target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create supports the minimal full-stack template and rejects unknown templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-create-minimal-"));
  const target = join(root, "small-start");
  try {
    const created = await runCliResult([
      "create",
      target,
      "--template=minimal",
      "--name=Small Start",
    ]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /Deploy: clank login && npm run deploy/u);

    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    const server = await readFile(join(target, "src", "server.tsx"), "utf8");
    const view = await readFile(join(target, "src", "view.tsx"), "utf8");
    const readme = await readFile(join(target, "README.md"), "utf8");
    assert.equal(packageJson.name, "small-start");
    assert.equal(packageJson.dependencies["@clank.run/framework"], `^${frameworkVersion}`);
    assert.equal(packageJson.devDependencies.tailwindcss, "^4.2.4");
    assert.match(server, /const projectTitle = "Small Start"/u);
    assert.match(server, /title: projectTitle/u);
    assert.match(view, /const projectTitle = "Small Start"/u);
    assert.match(view, />\{projectTitle\}</u);
    assert.match(view, /agentId="starter-counter"/u);
    assert.match(await readFile(join(target, "tests", "app.contract.mjs"), "utf8"), /deterministic hydration/u);
    assert.match(readme, /clank login\nnpm run deploy/u);

    await runCli(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "server.js"), "utf8"), /Small Start/u);
    assert.match(await readFile(join(target, "dist", "view.js"), "utf8"), /starter-counter/u);
    await linkFramework(target);
    await runNodeTests(target);

    const invalid = await runCliResult([
      "create",
      join(root, "invalid"),
      "--template=unknown",
    ]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Unknown template: unknown/u);
    assert.match(invalid.stderr, /auth-todo or minimal/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template discovery and create expose safe agent-readable contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-create-agent-"));
  const target = join(root, "agent-safe");
  try {
    const catalog = JSON.parse((await runCliOutput([
      "templates",
      "--json",
    ])).stdout);
    assert.equal(catalog.protocol, "clank-template-catalog/1");
    assert.equal(catalog.version, frameworkVersion);
    assert.equal(catalog.defaultTemplate, "auth-todo");
    assert.deepEqual(
      catalog.templates.map((entry) => entry.id),
      ["auth-todo", "minimal"],
    );
    assert.equal(catalog.templates[0].recommended, true);
    assert.equal(catalog.templates[0].features.includes("mcp-oauth"), true);
    assert.equal(catalog.templates[0].features.includes("ui-mcp-parity"), true);
    assert.equal(catalog.templates[0].features.includes("deterministic-fixture"), true);
    assert.equal(catalog.templates[0].features.includes("app-contract-tests"), true);
    assert.equal(catalog.templates[1].features.includes("app-contract-tests"), true);
    assert.equal(catalog.templates[1].features.includes("mcp-oauth"), false);

    const humanCatalog = await runCliOutput(["templates"]);
    assert.match(humanCatalog.stdout, /auth-todo \(recommended\)/u);
    assert.match(humanCatalog.stdout, /clank create my-app --template=minimal/u);

    const dangerousTitle = 'Agent "</script>" {Tasks} & Co';
    const created = await runCliOutput([
      "create",
      target,
      "--template=auth-todo",
      `--name=${dangerousTitle}`,
      "--json",
    ]);
    const result = JSON.parse(created.stdout);
    assert.equal(result.protocol, "clank-create-result/1");
    assert.equal(result.ok, true);
    assert.equal(result.project.name, dangerousTitle);
    assert.equal(result.project.directory, target);
    assert.equal(result.project.frameworkDependency, `^${frameworkVersion}`);
    assert.equal(result.template.id, "auth-todo");
    assert.equal(result.commands.test, "npm test");
    assert.equal(result.commands.login, "clank login");
    assert.equal(result.commands.deploy, "npm run deploy");
    assert.equal(result.files.length > 10, true);
    assert.equal(result.files.some((entry) => entry.path === "fixtures/default.json"), true);
    assert.equal(result.files.some((entry) => entry.path === "tests/app.contract.mjs"), true);
    assert.deepEqual(
      result.files.map((entry) => entry.path),
      result.files.map((entry) => entry.path).toSorted(),
    );
    assert.equal(
      result.files.every((entry) =>
        Number.isSafeInteger(entry.bytes)
        && entry.bytes > 0
        && /^[a-f0-9]{64}$/u.test(entry.sha256)),
      true,
    );

    const server = await readFile(join(target, "src", "server.tsx"), "utf8");
    const view = await readFile(join(target, "src", "view.tsx"), "utf8");
    const readme = await readFile(join(target, "README.md"), "utf8");
    assert.match(server, /const projectTitle = "Agent \\"<\/script>\\" \{Tasks\} & Co"/u);
    assert.match(server, /title: projectTitle/u);
    assert.match(view, /\{projectTitle\}/u);
    assert.doesNotMatch(server + view, /__PROJECT_TITLE/u);
    assert.match(readme, /Agent "&lt;\/script&gt;" \{Tasks\} &amp; Co/u);
    await runCli(["build", "src", "dist"], target);
    assert.match(
      await readFile(join(target, "dist", "server.js"), "utf8"),
      /Agent \\"<\/script>\\" \{Tasks\} & Co/u,
    );

    const invalid = await runCliResult([
      "create",
      join(root, "too-long"),
      `--name=${"x".repeat(101)}`,
      "--json",
    ]);
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, "INVALID_PROJECT_NAME");

    const symlinkDestination = join(root, "symlink-destination");
    const symlinkTarget = join(root, "symlink-target");
    await mkdir(symlinkDestination);
    await symlink(symlinkDestination, symlinkTarget);
    const unsafeTarget = await runCliResult([
      "create",
      symlinkTarget,
      "--json",
    ]);
    assert.equal(unsafeTarget.code, 1);
    assert.equal(JSON.parse(unsafeTarget.stderr).error.code, "UNSAFE_TARGET");
    assert.deepEqual(await readdir(symlinkDestination), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create can use this checkout without a published package and dry-run deploy is offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-local-create-"));
  const home = join(root, "home");
  const target = join(root, "local-app");
  try {
    await mkdir(home);
    const created = await runCliResult([
      "create",
      target,
      "--framework=local",
    ], repository, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(created.code, 0, created.stderr);
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(
      packageJson.dependencies["@clank.run/framework"],
      `file:${fileURLToPath(repository).replace(/\/$/u, "")}`,
    );

    const before = await runCliOutput(["doctor", "--json"], target, {
      ...process.env,
      CLANK_HOME: home,
    });
    const beforeReport = JSON.parse(before.stdout);
    assert.equal(beforeReport.protocol, "clank-doctor/1");
    assert.equal(beforeReport.ok, true);
    assert.equal(beforeReport.checks.find((check) => check.id === "build").status, "warn");
    assert.equal(beforeReport.checks.find((check) => check.id === "login").status, "warn");

    const sentinel = join(root, "artifact-sentinel");
    const artifactPath = join(target, "verified.clank.gz");
    const tailwind = await fakeTailwind(root);
    await writeFile(sentinel, "do not replace");
    await symlink(sentinel, artifactPath);
    const dryRun = await runCliOutput([
      "deploy",
      "--dry-run",
      `--output=${artifactPath}`,
      "--json",
    ], target, {
      ...process.env,
      CLANK_HOME: home,
      CLANK_TAILWIND_EXECUTABLE: tailwind,
    });
    const result = JSON.parse(dryRun.stdout);
    assert.equal(result.protocol, "clank-deploy-result/1");
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.match(result.artifact.digest, /^[a-f0-9]{64}$/);
    assert.equal(result.artifact.path, artifactPath);
    await access(result.artifact.path);
    assert.equal(await readFile(sentinel, "utf8"), "do not replace");
    const artifactStats = await lstat(artifactPath);
    assert.equal(artifactStats.isFile(), true);
    assert.equal(artifactStats.isSymbolicLink(), false);

    const after = JSON.parse((await runCliOutput(["doctor", "--json"], target, {
      ...process.env,
      CLANK_HOME: home,
    })).stdout);
    assert.equal(after.checks.find((check) => check.id === "build").status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy retries reuse a persisted idempotency key after network ambiguity and provider pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-retry-"));
  const home = join(root, "home");
  const target = join(root, "retry-app");
  const keys = [];
  let requests = 0;
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests++;
    keys.push(request.headers["x-clank-idempotency-key"]);
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    if (requests === 2) {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "1",
      });
      response.end(JSON.stringify({
        error: {
          code: "PROVIDER_DEPLOYMENT_PENDING",
          message: "The provider deployment is still pending. Retry this exact deploy.",
        },
      }));
      return;
    }
    if (requests === 4) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: "PROVIDER_DEPLOYMENT_FAILED",
          message: "The provider rejected this deployment.",
        },
      }));
      return;
    }
    const digest = request.headers["x-clank-content-sha256"];
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      release: {
        id: "release_retry_test",
        digest,
        url: "https://retry-app.apps.example.test",
        directUrl: "http://127.0.0.1:9999",
        project: { placement: "provider" },
      },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}/`;
  try {
    await mkdir(home);
    const tailwind = await fakeTailwind(root);
    const environment = {
      ...process.env,
      CLANK_HOME: home,
      CLANK_TAILWIND_EXECUTABLE: tailwind,
    };
    await runCli(["create", target], repository);
    await mkdir(join(target, ".clank"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_retry_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    await writeFile(join(target, ".clank", "project.json"), JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_retry_test",
    }));

    const first = await runCliResult(["deploy", "--json"], target, environment);
    assert.equal(first.code, 1);
    await access(join(target, ".clank", "deploy-attempt.json"));

    const second = await runCliResult(["deploy", "--json"], target, environment);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /still pending/u);
    await access(join(target, ".clank", "deploy-attempt.json"));

    const third = await runCliResult(["deploy", "--json"], target, environment);
    assert.equal(third.code, 0, third.stderr);
    const deployed = JSON.parse(third.stdout);
    assert.equal(deployed.release.id, "release_retry_test");
    assert.equal(deployed.release.url, "https://retry-app.apps.example.test");
    assert.equal(deployed.project.placement, "provider");
    assert.equal(requests, 3);
    assert.equal(keys[0], keys[1]);
    assert.equal(keys[1], keys[2]);
    await assert.rejects(access(join(target, ".clank", "deploy-attempt.json")), (error) => error.code === "ENOENT");

    const terminal = await runCliResult(["deploy", "--json"], target, environment);
    assert.equal(terminal.code, 1);
    assert.match(terminal.stderr, /provider rejected/u);
    assert.notEqual(keys[3], keys[2]);
    await assert.rejects(
      access(join(target, ".clank", "deploy-attempt.json")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("preview CLI deploys, lists, and removes an isolated linked environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-preview-"));
  const home = join(root, "home");
  const target = join(root, "preview-app");
  const observed = [];
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  const preview = {
    id: "preview_cli_test",
    kind: "preview",
    parentProjectId: "project_preview_parent",
    previewName: "feature-auth",
    previewExpiresAt: expiresAt,
    slug: "preview-app-feature-auth",
    runtimeStatus: "online",
    url: "https://preview-app-feature-auth.apps.example.test",
  };
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    observed.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: request.headers["content-type"] === "application/json" && body
        ? JSON.parse(body.toString("utf8"))
        : undefined,
    });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "POST"
      && request.url === "/api/projects/project_preview_parent/previews"
    ) {
      response.writeHead(201);
      response.end(JSON.stringify({ ok: true, created: true, preview }));
      return;
    }
    if (
      request.method === "POST"
      && request.url === "/api/projects/preview_cli_test/releases"
    ) {
      response.writeHead(201);
      response.end(JSON.stringify({
        ok: true,
        release: {
          id: "release_preview_cli",
          digest: request.headers["x-clank-content-sha256"],
          url: preview.url,
        },
      }));
      return;
    }
    if (
      request.method === "GET"
      && request.url === "/api/projects/project_preview_parent/previews"
    ) {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, previews: [preview] }));
      return;
    }
    if (
      request.method === "DELETE"
      && request.url === "/api/projects/project_preview_parent/previews/preview_cli_test"
    ) {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, preview: { ...preview, deletedAt: Date.now() } }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const platform = `http://127.0.0.1:${address.port}`;
  const tailwind = await fakeTailwind(root);
  const environment = {
    ...process.env,
    CLANK_HOME: home,
    CLANK_TAILWIND_EXECUTABLE: tailwind,
  };
  try {
    await mkdir(home);
    await runCli(["create", target], repository);
    await mkdir(join(target, ".clank"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      current: platform,
      profiles: {
        [platform]: {
          token: "clnk_preview_test_token",
          expiresAt: Date.now() + 60_000,
        },
      },
    }));
    await writeFile(join(target, ".clank", "project.json"), JSON.stringify({
      version: 1,
      server: platform,
      projectId: "project_preview_parent",
    }));

    const deployed = await runCliResult([
      "preview",
      "deploy",
      "feature-auth",
      "--ttl=24",
      "--json",
    ], target, environment);
    assert.equal(deployed.code, 0, deployed.stderr);
    const result = JSON.parse(deployed.stdout);
    assert.equal(result.protocol, "clank-preview-result/1");
    assert.equal(result.preview.id, preview.id);
    assert.equal(result.preview.expiresAt, expiresAt);
    assert.equal(result.release.url, preview.url);

    const listed = await runCliResult(["preview", "list", "--json"], target, environment);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).previews[0].previewName, "feature-auth");

    const removed = await runCliResult([
      "preview",
      "remove",
      "feature-auth",
      "--confirm=delete-preview feature-auth",
      "--acknowledge-data-loss",
      "--json",
    ], target, environment);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).preview.id, preview.id);

    assert.deepEqual(observed.map(({ method, url }) => ({ method, url })), [{
      method: "POST",
      url: "/api/projects/project_preview_parent/previews",
    }, {
      method: "POST",
      url: "/api/projects/preview_cli_test/releases",
    }, {
      method: "GET",
      url: "/api/projects/project_preview_parent/previews",
    }, {
      method: "GET",
      url: "/api/projects/project_preview_parent/previews",
    }, {
      method: "DELETE",
      url: "/api/projects/project_preview_parent/previews/preview_cli_test",
    }]);
    assert.deepEqual(observed[0].body, { name: "feature-auth", ttlHours: 24 });
    assert.equal(observed[1].contentType, "application/vnd.clank.deploy+gzip");
    assert.deepEqual(observed[4].body, {
      confirmation: "delete-preview feature-auth",
      acknowledgeDataLoss: true,
    });
    assert.ok(observed.every((request) =>
      request.authorization === "Bearer clnk_preview_test_token"));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler CLI refuses overlapping input and output directories before deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-overlap-"));
  const input = join(root, "src");
  const sentinel = join(input, "keep.ts");
  await mkdir(input);
  await writeFile(sentinel, "export const keep = true;");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "scripts/clank.mjs",
      "build",
      input,
      root,
    ], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.notEqual(code, 0);
  assert.equal(await readFile(sentinel, "utf8"), "export const keep = true;");
  await rm(root, { recursive: true, force: true });
});

test("compiler builds Tailwind atomically through an explicit shell-free executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-tailwind-"));
  const input = join(root, "src");
  const output = join(root, "dist");
  try {
    await mkdir(join(input, "styles"), { recursive: true });
    await writeFile(join(input, "app.tsx"), "export const className = 'bg-slate-950 text-white';\n");
    await writeFile(join(input, "styles", "tailwind.css"), '@import "tailwindcss";\n@source "../**/*.tsx";\n');
    const executable = await fakeTailwind(root);
    const built = await runCliResult([
      "build",
      "src",
      "dist",
      "--tailwind=src/styles/tailwind.css",
    ], root, {
      ...process.env,
      CLANK_TAILWIND_EXECUTABLE: executable,
    });
    assert.equal(built.code, 0, built.stderr);
    assert.match(await readFile(join(output, "styles.css"), "utf8"), /compiled Tailwind test output/);
    assert.doesNotMatch(await readFile(join(output, "styles.css"), "utf8"), /@import "tailwindcss"/);
    assert.match(await readFile(join(output, "app.js"), "utf8"), /bg-slate-950 text-white/);
    assert.deepEqual(
      (await readdir(output))
        .filter((name) => name.includes(".clank-build-")),
      [],
    );

    const outside = await runCliResult([
      "build",
      "src",
      "dist",
      "--tailwind=../outside.css",
    ], root, process.env);
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /Tailwind input must be inside the compiler input directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("framework builds are safe to run concurrently and remove stale outputs", async () => {
  const stale = fileURLToPath(new URL("dist/stale-build-output.js", repository));
  await writeFile(stale, "stale");
  try {
    await Promise.all([runFrameworkBuild(), runFrameworkBuild()]);
    await access(fileURLToPath(new URL("dist/index.js", repository)));
    await access(fileURLToPath(new URL("dist/ai.js", repository)));
    await assert.rejects(access(stale), { code: "ENOENT" });
  } finally {
    await rm(stale, { force: true });
  }
});

test("public compiler builds update shared output atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-concurrent-cli-"));
  const input = join(root, "src");
  const output = join(root, "dist");
  await mkdir(input);
  await mkdir(output);
  await writeFile(join(input, "app.ts"), "export const ready: boolean = true;");
  await writeFile(join(input, "index.html"), "<main>Ready</main>");
  await writeFile(join(output, "stale.txt"), "remove me");
  try {
    await Promise.all([
      runCli(["build", input, output]),
      runCli(["build", input, output]),
    ]);
    assert.match(await readFile(join(output, "app.js"), "utf8"), /ready/);
    assert.equal(await readFile(join(output, "index.html"), "utf8"), "<main>Ready</main>");
    await assert.rejects(access(join(output, "stale.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSR reference apps map the bare module specifier emitted by their shared views", async () => {
  for (const example of ["fullstack", "auth-todo"]) {
    const serverSource = await readFile(
      fileURLToPath(new URL(`examples/${example}/server.tsx`, repository)),
      "utf8",
    );
    const sharedView = await readFile(
      fileURLToPath(new URL(`examples/${example}/view.js`, repository)),
      "utf8",
    );
    assert.match(
      sharedView,
      /from "@clank\.run\/framework"/,
      `${example} should exercise the package-style browser import`,
    );
    assert.match(
      serverSource,
      /imports:\s*\{\s*"@clank\.run\/framework":\s*"\/dist\/index\.js"\s*\}/,
      `${example} must resolve the same package-style import in its browser import map`,
    );
  }
});

test("the browser package barrel has no eager Node-only module imports", async () => {
  const files = await readdir(fileURLToPath(new URL("dist", repository)));
  for (const filename of files.filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(fileURLToPath(new URL(`dist/${filename}`, repository)), "utf8");
    assert.doesNotMatch(
      source,
      /^\s*(?:import(?:\s+[^"'`]*?\s+from)?|export\s+[^"'`]*?\s+from)\s*["']node:/mu,
      `${filename} must defer Node-only imports until its server API is called`,
    );
  }
});

test("clank dev rebuilds, health-swaps, live-reloads, and preserves the last good server", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-cli-dev-"));
  const input = join(root, "src");
  const output = join(root, "dist");
  const migrations = join(root, "migrations");
  await Promise.all([
    mkdir(input),
    mkdir(output),
    mkdir(migrations),
  ]);
  const sourcePath = join(input, "server.ts");
  const source = (marker) => `
    import { createServer } from "node:http";
    const marker = ${JSON.stringify(marker)};
    createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><main>" + marker + "</main></body></html>");
    }).listen(Number(process.env.PORT), process.env.HOST);
  `;
  await writeFile(sourcePath, source("revision-one"));
  await writeFile(join(root, "clank.deploy.json"), JSON.stringify({
    version: 1,
    entry: "dist/server.js",
    include: ["dist", "migrations"],
    build: {
      command: ["clank", "build", "src", "dist"],
    },
    database: {
      path: "app.sqlite",
      migrations: "migrations",
      allowUnsafeMigrations: false,
    },
    health: {
      path: "/healthz",
      timeoutMs: 5_000,
    },
    env: {},
  }));

  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("scripts/clank.mjs", repository)),
    "dev",
    root,
    `--port=${port}`,
    "--json",
  ], {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputBuffer = "";
  let diagnostics = "";
  const events = [];
  const waiters = new Set();
  const publish = (event) => {
    events.push(event);
    for (const waiter of waiters) waiter();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outputBuffer += chunk;
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) publish(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const waitForEvent = (type, after = 0) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Timed out waiting for ${type}. stderr: ${diagnostics}`));
    }, 10_000);
    const check = () => {
      const event = events.slice(after).find((entry) => entry.type === type);
      if (!event) return;
      clearTimeout(deadline);
      waiters.delete(check);
      resolve(event);
    };
    waiters.add(check);
    check();
  });

  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  try {
    const ready = await waitForEvent("ready");
    assert.equal(ready.protocol, "clank-dev-event/1");
    assert.equal(ready.url, base);
    const initial = await fetch(base);
    assert.equal(initial.status, 200);
    const initialHtml = await initial.text();
    assert.match(initialHtml, /revision-one/u);
    assert.match(initialHtml, /\/_clank\/dev-client\.js/u);

    const client = await fetch(`${base}/_clank/dev-client.js`);
    assert.equal(client.status, 200);
    assert.match(await client.text(), /EventSource/u);
    const stream = await fetch(`${base}/_clank/dev-events`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let streamText = decoder.decode((await reader.read()).value);
    assert.match(streamText, /connected/u);

    const beforeRestart = events.length;
    await writeFile(sourcePath, source("revision-two"));
    const restarted = await waitForEvent("restarted", beforeRestart);
    assert.equal(restarted.revision, 2);
    while (!streamText.includes("event: reload")) {
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Live-reload event timed out.")), 5_000)),
      ]);
      if (next.done) break;
      streamText += decoder.decode(next.value);
    }
    assert.match(streamText, /event: reload/u);
    assert.match(streamText, /"revision":2/u);
    assert.match(await (await fetch(base)).text(), /revision-two/u);

    const beforeFailure = events.length;
    await symlink("server.ts", join(input, "bad.ts"));
    const failed = await waitForEvent("build_failed", beforeFailure);
    assert.match(failed.message, /Symbolic links are not compiled/u);
    assert.match(await (await fetch(base)).text(), /revision-two/u);
    await rm(join(input, "bad.ts"));
    await reader.cancel();
  } finally {
    controller.abort();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0, diagnostics);
});

test("development server resolves documented trailing-slash example URLs", async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("scripts/dev.mjs", repository)),
  ], {
    cwd: repository,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Dev server timed out: ${diagnostics}`)),
        5_000,
      );
      child.stdout.on("data", (chunk) => {
        diagnostics += chunk;
        if (diagnostics.includes("Clank dev server:")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with ${code}: ${diagnostics}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/examples/dashboard/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Relay Admin/);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});
