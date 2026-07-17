import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishedPackageName = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).name;
const publishedPackageDirectory = (...segments) => join("node_modules", ...publishedPackageName.split("/"), ...segments);
const root = await mkdtemp(join(tmpdir(), "clank-conformance-"));
const packageDirectory = join(root, "package");
const toolsDirectory = join(root, "tools");
const applicationDirectory = join(root, "conformance-todo");
const platformDirectory = join(root, "platform");
const cliHome = join(root, "cli-home");
const password = "correct horse battery staple";
let platformProcess;

try {
  console.log("1/9 Packing Clank...");
  await mkdir(packageDirectory, { recursive: true });
  const packed = await command("npm", [
    "pack",
    "--json",
    "--pack-destination",
    packageDirectory,
  ], { cwd: repository });
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1);
  const tarball = join(packageDirectory, packResult[0].filename);

  console.log("2/9 Installing the packed release into a clean tool consumer...");
  await mkdir(toolsDirectory, { recursive: true });
  await writeFile(join(toolsDirectory, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }, null, 2));
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    tarball,
  ], { cwd: toolsDirectory });
  const packagedCli = join(toolsDirectory, publishedPackageDirectory("scripts", "clank.mjs"));
  const packagedPlatform = join(
    toolsDirectory,
    publishedPackageDirectory("scripts", "clank-platform.mjs"),
  );

  console.log("3/9 Generating and installing an authenticated app from its AI blueprint...");
  const blueprint = join(
    toolsDirectory,
    publishedPackageDirectory("examples", "blueprint-todo", "clank.app.ts"),
  );
  await clank(packagedCli, [
    "generate",
    applicationDirectory,
    `--blueprint=${blueprint}`,
  ]);
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    tarball,
  ], { cwd: applicationDirectory });
  const applicationCli = join(
    applicationDirectory,
    publishedPackageDirectory("scripts", "clank.mjs"),
  );
  await clank(applicationCli, ["build", "src", "dist"], { cwd: applicationDirectory });

  console.log("4/9 Starting the packaged control plane and authorizing the packaged CLI...");
  const platformPort = await freePort();
  const appPort = await freePort();
  const platformUrl = `http://127.0.0.1:${platformPort}`;
  platformProcess = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    packagedPlatform,
  ], {
    cwd: toolsDirectory,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(platformPort),
      CLANK_PLATFORM_URL: platformUrl,
      CLANK_PLATFORM_DATA: platformDirectory,
      CLANK_APP_PORT_START: String(appPort),
      CLANK_APP_PORT_END: String(appPort),
      CLANK_SIGNUP: "bootstrap",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const platformOutput = capture(platformProcess);
  await platformOutput.waitFor("Clank deployment platform:");

  const platformSession = await auth(platformUrl, "register", {
    email: "owner@conformance.test",
    password,
    profile: { name: "Conformance owner" },
  });
  const login = spawnClank(packagedCli, [
    "login",
    "--server",
    platformUrl,
  ], { cwd: toolsDirectory });
  const loginOutput = capture(login);
  const codeMatch = await loginOutput.waitFor(/Enter code: ([A-Z0-9-]+)/);
  await json(`${platformUrl}/api/device/approve`, {
    method: "POST",
    cookie: platformSession.cookie,
    csrf: platformSession.csrf,
    body: { code: codeMatch[1] },
  });
  await successfulExit(login, loginOutput);
  assert.match(loginOutput.stdout, /Authenticated with/);

  console.log("5/9 Deploying the generated app through the packaged CLI...");
  const firstDeploy = await clank(applicationCli, ["deploy"], { cwd: applicationDirectory });
  const firstRelease = captureValue(firstDeploy.stdout, /Deployed release (\S+)/);
  const applicationUrl = captureValue(firstDeploy.stdout, /URL: (https?:\/\/\S+)/);
  await waitFor(async () => (await fetch(`${applicationUrl}/healthz`)).ok);

  console.log("6/9 Verifying login, isolation, and live synchronization between two sessions...");
  const firstBrowser = await auth(applicationUrl, "register", {
    email: "person@conformance.test",
    password,
    profile: { name: "Conformance person" },
  });
  const secondBrowser = await auth(applicationUrl, "login", {
    email: "person@conformance.test",
    password,
  });
  const liveAbort = new AbortController();
  const liveResponse = await fetch(
    `${applicationUrl}/__clank/live/tasks.list?args=${encodeURIComponent("{}")}`,
    {
      headers: { cookie: secondBrowser.cookie },
      signal: liveAbort.signal,
    },
  );
  assert.equal(liveResponse.status, 200);
  const live = sse(liveResponse);
  await live.next((payload) => Array.isArray(payload.value) && payload.value.length === 0);

  await mutation(applicationUrl, firstBrowser, "tasks.create", {
    title: "Before migration",
  });
  await live.next((payload) =>
    payload.value?.some((todo) => todo.title === "Before migration"));

  const isolated = await auth(applicationUrl, "register", {
    email: "isolated@conformance.test",
    password,
    profile: { name: "Isolated person" },
  });
  assert.deepEqual(await query(applicationUrl, isolated, "tasks.list", {}), []);
  await live.close();
  liveAbort.abort();

  console.log("7/9 Applying an immutable migration in a second release...");
  await writeFile(join(applicationDirectory, "migrations", "0002_conformance_markers.sql"), `
CREATE TABLE conformance_markers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);
`);
  const secondDeploy = await clank(applicationCli, ["deploy"], { cwd: applicationDirectory });
  const secondRelease = captureValue(secondDeploy.stdout, /Deployed release (\S+)/);
  assert.notEqual(secondRelease, firstRelease);
  await mutation(applicationUrl, firstBrowser, "tasks.create", {
    title: "After migration",
  });
  await waitFor(async () =>
    (await query(applicationUrl, secondBrowser, "tasks.list", {}))
      .some((todo) => todo.title === "After migration"));

  const link = JSON.parse(await readFile(
    join(applicationDirectory, ".clank", "project.json"),
    "utf8",
  ));
  const databasePath = join(
    platformDirectory,
    "projects",
    link.projectId,
    "data",
    "app.sqlite",
  );
  let database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count,
    2,
  );
  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'conformance_markers'",
    ).get().count,
    1,
  );
  database.close();

  console.log("8/9 Forcing a failed health activation and verifying the prior release survives...");
  const configPath = join(applicationDirectory, "clank.deploy.json");
  const deployConfig = JSON.parse(await readFile(configPath, "utf8"));
  deployConfig.health.path = "/healthz-does-not-exist";
  deployConfig.health.timeoutMs = 500;
  await writeFile(configPath, `${JSON.stringify(deployConfig, null, 2)}\n`);
  const failed = await clank(applicationCli, ["deploy"], {
    cwd: applicationDirectory,
    expectFailure: true,
  });
  assert.match(failed.stderr, /Deployment failed|health/i);
  assert.deepEqual(
    (await query(applicationUrl, firstBrowser, "tasks.list", {})).map((todo) => todo.title),
    ["Before migration", "After migration"],
  );

  console.log("9/9 Restoring the first release and its pre-migration data...");
  deployConfig.health.path = "/healthz";
  deployConfig.health.timeoutMs = 15_000;
  await writeFile(configPath, `${JSON.stringify(deployConfig, null, 2)}\n`);
  await clank(applicationCli, [
    "rollback",
    firstRelease,
    "--restore-data",
    "--confirm=restore conformance-todo",
  ], { cwd: applicationDirectory });
  await waitFor(async () => {
    const todos = await query(applicationUrl, firstBrowser, "tasks.list", {});
    return todos.length === 1 && todos[0].title === "Before migration";
  });
  database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count,
    1,
  );
  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'conformance_markers'",
    ).get().count,
    0,
  );
  database.close();

  console.log("Clank conformance passed: packed consumer, auth, live sync, isolation, deploy, migration, failed activation, rollback, and data restore.");
} finally {
  if (platformProcess) await stop(platformProcess);
  await rm(root, { recursive: true, force: true });
}

function spawnClank(cli, args, options = {}) {
  return spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    cli,
    ...args,
  ], {
    cwd: options.cwd ?? repository,
    env: {
      ...process.env,
      CLANK_HOME: cliHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function clank(cli, args, options = {}) {
  const child = spawnClank(cli, args, options);
  const output = capture(child);
  const [code] = await once(child, "exit");
  const result = { stdout: output.stdout, stderr: output.stderr, code };
  if (options.expectFailure) {
    assert.notEqual(code, 0, `Expected Clank to fail.\n${output.stdout}\n${output.stderr}`);
  } else {
    assert.equal(code, 0, `Clank exited with ${code}.\n${output.stdout}\n${output.stderr}`);
  }
  return result;
}

async function command(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd ?? repository,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = capture(child);
  const [code] = await once(child, "exit");
  assert.equal(
    code,
    0,
    `${basename(executable)} exited with ${code}.\n${output.stdout}\n${output.stderr}`,
  );
  return { stdout: output.stdout, stderr: output.stderr };
}

function capture(child) {
  let stdout = "";
  let stderr = "";
  const listeners = new Set();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const listener of listeners) listener();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const listener of listeners) listener();
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitFor(pattern, timeout = 15_000) {
      return new Promise((resolvePromise, reject) => {
        const inspect = () => {
          const output = `${stdout}\n${stderr}`;
          const match = typeof pattern === "string"
            ? output.includes(pattern) && [pattern]
            : output.match(pattern);
          if (!match) return;
          cleanup();
          resolvePromise(match);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${pattern}.\n${stdout}\n${stderr}`));
        }, timeout);
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(inspect);
        };
        listeners.add(inspect);
        inspect();
      });
    },
  };
}

async function successfulExit(child, output) {
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `Process exited with ${code}.\n${output.stdout}\n${output.stderr}`);
}

async function auth(origin, operation, body) {
  const response = await fetch(`${origin}/__clank/auth/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-clank-client-ip": "127.0.0.1",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: payload.csrfToken,
    user: payload.user,
  };
}

async function json(url, options = {}) {
  const origin = new URL(url).origin;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : {
        "content-type": "application/json",
        origin,
      }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-clank-csrf": options.csrf } : {}),
      "x-clank-client-ip": "127.0.0.1",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function mutation(origin, session, name, input) {
  return json(`${origin}/__clank/mutation/${name}`, {
    method: "POST",
    cookie: session.cookie,
    csrf: session.csrf,
    body: input,
  });
}

async function query(origin, session, name, input) {
  const payload = await json(`${origin}/__clank/query/${name}`, {
    method: "POST",
    cookie: session.cookie,
    body: input,
  });
  return payload.value;
}

function sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  return {
    async next(predicate, timeout = 5_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const eventEnd = buffer.indexOf("\n\n");
        if (eventEnd !== -1) {
          const event = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const data = event.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const payload = JSON.parse(data);
          if (predicate(payload)) return payload;
          continue;
        }
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Timed out waiting for a live-query event.")),
            remaining,
          )),
        ]);
        if (result.done) throw new Error("Live-query stream closed unexpectedly.");
        buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
      }
      throw new Error("Timed out waiting for a matching live-query event.");
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await reader.cancel(); } catch {}
    },
  };
}

async function waitFor(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw lastError ?? new Error("Timed out waiting for condition.");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function captureValue(value, pattern) {
  const match = value.match(pattern);
  assert(match, `Expected ${pattern} in:\n${value}`);
  return match[1];
}
