import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = new URL("..", import.meta.url);
const frameworkVersion = JSON.parse(
  await readFile(fileURLToPath(new URL("package.json", repository)), "utf8"),
).version;

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
  } finally {
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
    const view = await readFile(join(target, "src", "view.tsx"), "utf8");
    const tsconfig = JSON.parse(await readFile(join(target, "tsconfig.json"), "utf8"));
    const gitignore = await readFile(join(target, ".gitignore"), "utf8");
    const readme = await readFile(join(target, "README.md"), "utf8");
    const agentGuide = await readFile(join(target, "AGENTS.md"), "utf8");
    assert.equal(packageJson.name, "team-tasks");
    assert.equal(packageJson.dependencies["clank.run"], `^${frameworkVersion}`);
    assert.match(packageJson.scripts.dev, /dist\/server\.js/);
    assert.equal(packageJson.scripts.doctor, "clank doctor");
    assert.equal(packageJson.scripts["deploy:check"], "clank deploy --dry-run");
    assert.doesNotMatch(server, /__PROJECT_TITLE__/);
    assert.doesNotMatch(view, /__PROJECT_TITLE__/);
    assert.doesNotMatch(JSON.stringify(packageJson), /__CLANK_VERSION__/);
    assert.match(server, /title: "Team Tasks"/);
    assert.match(server, /imports: \{ "clank\.run": "\/_clank\/index\.js" \}/);
    assert.match(view, />Team Tasks</);
    assert.match(view, /<For each=\{props\.todos\} by="_id"/);
    assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
    assert.match(gitignore, /\.clank/);
    assert.match(readme, /# Team Tasks/);
    assert.match(agentGuide, /Never edit, rename, or remove an applied migration/);

    await runCli(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "server.js"), "utf8"), /Team Tasks/);
    assert.match(await readFile(join(target, "dist", "view.js"), "utf8"), /Team Tasks/);
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
      packageJson.dependencies["clank.run"],
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

test("deploy retries reuse a persisted idempotency key after an ambiguous network failure", async () => {
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
    const digest = request.headers["x-clank-content-sha256"];
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      release: {
        id: "release_retry_test",
        digest,
        url: "https://retry-app.apps.example.test",
        directUrl: "http://127.0.0.1:9999",
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

    const first = await runCliResult(["deploy", "--json"], target, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(first.code, 1);
    await access(join(target, ".clank", "deploy-attempt.json"));

    const second = await runCliResult(["deploy", "--json"], target, {
      ...process.env,
      CLANK_HOME: home,
    });
    assert.equal(second.code, 0, second.stderr);
    const deployed = JSON.parse(second.stdout);
    assert.equal(deployed.release.id, "release_retry_test");
    assert.equal(deployed.release.url, "https://retry-app.apps.example.test");
    assert.equal(requests, 2);
    assert.equal(keys[0], keys[1]);
    await assert.rejects(access(join(target, ".clank", "deploy-attempt.json")), (error) => error.code === "ENOENT");
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
