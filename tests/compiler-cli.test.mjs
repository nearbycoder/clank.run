import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function runCliOutput(args, cwd = repository) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("scripts/clank.mjs", repository)),
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
      : reject(new Error(`CLI exited with ${code}: ${stderr}`)));
  });
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
    assert.equal(packageJson.name, "team-tasks");
    assert.equal(packageJson.dependencies["clank.run"], `^${frameworkVersion}`);
    assert.match(packageJson.scripts.dev, /dist\/server\.js/);
    assert.doesNotMatch(server, /__PROJECT_TITLE__/);
    assert.doesNotMatch(view, /__PROJECT_TITLE__/);
    assert.doesNotMatch(JSON.stringify(packageJson), /__CLANK_VERSION__/);
    assert.match(server, /title: "Team Tasks"/);
    assert.match(view, />Team Tasks</);
    assert.match(view, /<For each=\{props\.todos\} by="_id"/);
    assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
    assert.match(gitignore, /\.clank/);

    await runCli(["build", "src", "dist"], target);
    assert.match(await readFile(join(target, "dist", "server.js"), "utf8"), /Team Tasks/);
    assert.match(await readFile(join(target, "dist", "view.js"), "utf8"), /Team Tasks/);
  } finally {
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
