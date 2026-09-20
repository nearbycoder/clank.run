import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { compile } from "../scripts/compiler.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "clank-deployment-improvements-"));
test.after(() => rm(fixture, { recursive: true, force: true }));
await mkdir(join(fixture, "dist"));
await mkdir(join(fixture, "scripts"));
await writeFile(join(fixture, "package.json"), await readFile(join(repo, "package.json")));
for (const file of await readdir(join(repo, "dist"))) {
  if (!["deploy.js", "platform.js", "data-plane.js"].includes(file)) await symlink(join(repo, "dist", file), join(fixture, "dist", file));
}
for (const name of ["deploy", "platform", "data-plane"]) {
  const filename = join(repo, "src", `${name}.ts`);
  let source = await readFile(filename, "utf8");
  if (name === "platform") source += "\nexport { normalizePublicUrl, normalizeEdgeAddresses, providerIngressOrigin };\n";
  await writeFile(join(fixture, "dist", `${name}.js`), compile(source, { filename, sourceMap: false }));
}
for (const file of await readdir(join(repo, "scripts"))) {
  if (file === "clank.mjs" || file === "cli-deploy.mjs") {
    const source = await readFile(join(repo, "scripts", file), "utf8");
    await writeFile(join(fixture, "scripts", file), source + (file === "cli-deploy.mjs" ? "\nexport { normalizeServer, runBuild };\n" : ""));
  } else await symlink(join(repo, "scripts", file), join(fixture, "scripts", file));
}
const { createDeploymentBundle, decodeDeploymentBundle, parseDeploymentConfig, readDeploymentConfig } = await import(pathToFileURL(join(fixture, "dist/deploy.js")));
const { normalizePublicUrl, normalizeEdgeAddresses, providerIngressOrigin } = await import(pathToFileURL(join(fixture, "dist/platform.js")));
const { createManagedIngress, inspectDomainRouting } = await import(pathToFileURL(join(fixture, "dist/data-plane.js")));
const { normalizeServer, runBuild } = await import(pathToFileURL(join(fixture, "scripts/cli-deploy.mjs")));

const base = { version: 1, entry: "dist/server.js", include: ["dist", "migrations"] };

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "clank-moon-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "migrations"));
  await writeFile(join(root, "dist/server.js"), "export const ready = true;\n");
  return root;
}

async function cli(args, cwd, timeoutMs = 15_000) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(fixture, "scripts/clank.mjs"), ...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

test("054: worker entry is required in both created and decoded deployment artifacts", async (t) => {
  const root = await project(t);
  const config = parseDeploymentConfig({ ...base, jobs: { entry: "dist/jobs.js" } });
  await assert.rejects(createDeploymentBundle(root, config), /jobs entry dist\/jobs\.js was not packaged/u);
  const withoutJobs = await createDeploymentBundle(root, parseDeploymentConfig(base));
  const tampered = JSON.parse(gunzipSync(withoutJobs).toString());
  tampered.config.jobs = config.jobs;
  delete tampered.provenance.configurationSha256;
  await assert.rejects(decodeDeploymentBundle(gzipSync(JSON.stringify(tampered))), /jobs entry is missing/u);
  await writeFile(join(root, "dist/jobs.js"), "export const worker = true;\n");
  const valid = await decodeDeploymentBundle(await createDeploymentBundle(root, config));
  assert.ok(valid.files.some((file) => file.path === valid.config.jobs.entry));
  const shared = parseDeploymentConfig({ ...base, jobs: { entry: base.entry, workers: 0, scheduler: true } });
  assert.equal((await decodeDeploymentBundle(await createDeploymentBundle(root, shared))).config.jobs.entry, base.entry);
});

test("055: bundle byte accounting visits file records linearly and includes all source roots", async (t) => {
  const root = await project(t);
  for (let index = 0; index < 80; index++) await writeFile(join(root, "dist", `asset-${index}.txt`), "abcd");
  const config = parseDeploymentConfig(base);
  const original = Map.prototype.values;
  let visited = 0;
  Map.prototype.values = function () {
    const first = this.entries().next().value?.[1];
    if (first && typeof first.path === "string" && typeof first.sha256 === "string") visited += this.size;
    return original.call(this);
  };
  let packed;
  try { packed = await createDeploymentBundle(root, config); }
  finally { Map.prototype.values = original; }
  const bundle = await decodeDeploymentBundle(packed);
  assert.ok(visited <= bundle.files.length * 2, `${visited} file records visited for ${bundle.files.length} files`);
  const bytes = bundle.files.reduce((sum, file) => sum + file.size, 0);
  await createDeploymentBundle(root, config, { maxTotalBytes: bytes });
  await assert.rejects(createDeploymentBundle(root, config, { maxTotalBytes: bytes - 1 }), /too large/u);
  const framework = join(root, "framework");
  await mkdir(join(framework, "dist"), { recursive: true });
  await writeFile(join(framework, "dist/runtime.js"), "runtime");
  await writeFile(join(framework, "package.json"), "{}");
  await writeFile(join(framework, "LICENSE"), "license");
  const options = { frameworkRoot: framework, maxTotalBytes: bytes + 16 };
  const combined = await decodeDeploymentBundle(await createDeploymentBundle(root, config, options));
  assert.equal(combined.files.reduce((sum, file) => sum + file.size, 0), bytes + 16);
  await assert.rejects(createDeploymentBundle(root, config, { ...options, maxTotalBytes: bytes + 15 }), /too large/u);
});

test("056: artifact inspection rejects oversized and nonregular inputs before decoding", async (t) => {
  const root = await project(t);
  const oversized = join(root, "oversized.clank");
  await writeFile(oversized, "");
  await truncate(oversized, 100 * 1024 * 1024 + 1);
  for (const file of [oversized, join(root, "dist")]) {
    const result = await cli(["inspect", file], root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /regular file of at most 100 MiB/u);
  }
  const artifact = join(root, "valid.clank");
  await writeFile(artifact, await createDeploymentBundle(root, parseDeploymentConfig(base)));
  const valid = await cli(["inspect", artifact], root);
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).files[0].path, base.entry);
  assert.equal(valid.stderr, "");
});

test("057: failed JSON-mode builds expose bounded clean diagnostics without stdout noise", async (t) => {
  const root = await project(t);
  const config = { ...base, build: { command: [process.execPath, "-e", 'console.log("build stdout noise"); process.stderr.write("x".repeat(20000)+"\\u001b[31museful diagnostic\\u001b[0m\\u0007"); process.exit(7);'] } };
  await writeFile(join(root, "clank.deploy.json"), JSON.stringify(config));
  const result = await cli(["deploy", root, "--dry-run", "--json"], root);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const message = JSON.parse(result.stderr).error.message;
  assert.match(message, /^Build exited with 7\./u);
  assert.ok(message.endsWith("useful diagnostic"));
  assert.ok(message.length < 8_250);
  assert.doesNotMatch(message, /[\u0000-\u0009\u000b-\u001f\u007f]/u);
});

for (const code of [0, 7]) test(`057: JSON-mode builds settle after exit ${code} even when a descendant retains stderr`, async (t) => {
  const root = await project(t);
  const pidFile = join(root, "descendant.pid");
  const script = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "ignore", "inherit"] });
writeFileSync("descendant.pid", String(child.pid));
child.unref();
process.stderr.write("build diagnostic before exit\\n");
process.exit(${code});
`;
  await writeFile(join(root, "clank.deploy.json"), JSON.stringify({ ...base, build: { command: [process.execPath, "-e", script] } }));
  try {
    if (code === 0) {
      // This fixture's framework dependencies are symlinked, so exercise the
      // successful build directly without subsequently packaging the fixture.
      let timeout;
      try {
        await Promise.race([
          runBuild([process.execPath, "-e", script], root, { quiet: true }),
          new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Build did not settle before the descendant.")), 3_000); }),
        ]);
      } finally { clearTimeout(timeout); }
    } else {
      const result = await cli(["deploy", root, "--dry-run", "--json"], root, 3_000);
      assert.equal(result.code, 1, `CLI did not settle before the descendant: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(JSON.parse(result.stderr).error.message, /Build exited with 7\.\nbuild diagnostic before exit/u);
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0), "the descendant still holds the inherited stderr descriptor");
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  }
});

test("058: config read errors remain distinguishable from invalid JSON and special files", async (t) => {
  const root = await project(t);
  const file = join(root, "clank.deploy.json");
  await writeFile(file, JSON.stringify(base));
  const original = fs.promises.readFile;
  const denial = Object.assign(new Error("fixture read denied"), { code: "EACCES" });
  fs.promises.readFile = async function (path, ...args) {
    if (path === file) throw denial;
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readDeploymentConfig(root), (error) => error === denial); }
  finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
  await writeFile(file, "{");
  await assert.rejects(readDeploymentConfig(root), /must contain valid JSON/u);
  await rm(file);
  await mkdir(file);
  await assert.rejects(readDeploymentConfig(root), /must be a regular file/u);
  await rm(file, { recursive: true });
  await writeFile(join(root, "proact.deploy.json"), JSON.stringify(base));
  assert.equal((await readDeploymentConfig(root)).entry, base.entry);
});

test("059: IPv6 loopback URLs work without weakening credentials and non-loopback restrictions", () => {
  for (const normalize of [normalizePublicUrl, normalizeServer]) {
    assert.equal(normalize("http://[::1]:4300/"), "http://[::1]:4300");
    assert.equal(normalize("http://[0:0:0:0:0:0:0:1]:4300/base/"), "http://[::1]:4300/base");
    for (const value of ["http://[::2]", "http://[::ffff:127.0.0.1]", "http://example.test", "http://user:pass@[::1]", "http://[::1]/?secret=1", "http://[::1]/#fragment", "ftp://[::1]"]) {
      assert.throws(() => normalize(value), /HTTPS/u);
    }
  }
  assert.equal(providerIngressOrigin("http://[::1]:4400", []), "http://[::1]:4400");
  for (const value of ["http://[::2]", "http://user:pass@[::1]", "http://[::1]/path", "http://[::1]/?q=1"]) {
    assert.throws(() => providerIngressOrigin(value, []), /allowlist/u);
  }
});

test("059: managed ingress serves, checks health and drains an accepted IPv6 loopback provider", async () => {
  const upstream = providerIngressOrigin("http://[0:0:0:0:0:0:0:1]:4400", []);
  const requests = [];
  const route = { id: "route_123", projectId: "project_123", hosts: ["app.example.test"], upstream, active: true };
  const ingress = createManagedIngress({
    routes: () => [route],
    fetch: async (input) => { requests.push(String(input)); return new Response("provider response"); },
  });
  assert.deepEqual(await ingress.health(), { route_123: { ok: true, status: 200 } });
  const response = await ingress.handle(new Request("https://app.example.test/page?q=1"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "provider response");
  assert.deepEqual(requests, ["http://[::1]:4400/healthz", "http://[::1]:4400/page?q=1"]);
  assert.equal(ingress.activeRequests(upstream), 0);
  assert.equal(await ingress.drain(upstream), true);
  for (const denied of ["http://[::2]:4400", "http://[::ffff:127.0.0.1]:4400", "http://user:pass@[::1]:4400", "http://[::1]:4400/path"]) {
    const invalid = createManagedIngress({ routes: () => [{ ...route, upstream: denied }] });
    await assert.rejects(invalid.health(), /not allowed|must be an HTTP\(S\) origin|cannot include a path/u);
  }
});

test("060: edge IPv6 addresses are parsed, canonicalized, deduplicated, and matched to DNS answers", async () => {
  assert.deepEqual(normalizeEdgeAddresses(["2001:0DB8:0:0:0:0:0:1", "2001:db8::1", "::ffff:192.0.2.1", "::ffff:c000:201", "192.000.002.001"]),
    ["2001:db8::1", "::ffff:c000:201", "192.0.2.1"]);
  for (const invalid of ["::::", "1:2:3", "1:2:3:4:5:6:7:8:9", "1::2::3", "fe80::1%eth0", "[::1]", "::1]/path[", "abcd:xyz", "256.0.0.1"]) {
    assert.throws(() => normalizeEdgeAddresses([invalid]), /Invalid edge IP address/u);
  }
  const routing = await inspectDomainRouting("customer.example.test", { addresses: ["2001:db8::1"] }, {
    resolveCname: async () => [], resolve4: async () => [], resolve6: async () => ["2001:0DB8:0:0:0:0:0:1"],
  });
  assert.equal(routing.status, "ready");
  assert.deepEqual(routing.observed.addresses, ["2001:db8::1"]);
});
