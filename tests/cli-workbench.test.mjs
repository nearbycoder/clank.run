import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { deflateSync } from "node:zlib";

const cli = resolve("scripts/clank.mjs");

test("workbench CLI evaluates policies, schema changes, and capacity as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-workbench-"));
  const policy = join(root, "policy.json");
  await writeFile(policy, JSON.stringify({ revision: "one", rules: [{ id: "members", actions: ["todos.*"], effect: "allow", roles: ["member"] }] }));
  const decision = await run(["workbench", "policy", policy, "todos.add", "--principal=person-1", "--kind=user", "--roles=member", "--json"]);
  assert.equal(JSON.parse(decision.stdout).effect, "allow");

  const current = join(root, "current.json");
  const target = join(root, "target.json");
  await writeFile(current, JSON.stringify({ tables: {} }));
  await writeFile(target, JSON.stringify({ tables: { todos: { columns: { title: { type: "text" } } } } }));
  const schema = await run(["workbench", "schema", current, target, "--json"]);
  assert.equal(JSON.parse(schema.stdout).changes[0].kind, "create-table");

  const workload = join(root, "workload.json");
  const rates = join(root, "rates.json");
  await writeFile(workload, JSON.stringify({ requestsPerMonth: 1_000_000, transferBytesPerMonth: 1_000_000_000, databaseBytes: 1_000, artifactBytes: 1_000 }));
  await writeFile(rates, JSON.stringify({ requestMillion: 1, transferGb: 1, storageGb: 1, processUnit: 10 }));
  const capacity = await run(["workbench", "capacity", workload, rates, "--json"]);
  assert.equal(JSON.parse(capacity.stdout).monthlyCost, 12);
});

test("workbench CLI help is discoverable from base help", async () => {
  const help = await run(["help"]);
  assert.match(help.stdout, /clank workbench help/u);
  const focused = await run(["workbench", "help"]);
  assert.match(focused.stdout, /provider conformance/u);
});

test("workbench CLI compares browser-ready PNG baselines without dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-visual-"));
  const baseline = join(root, "baseline.png");
  const current = join(root, "current.png");
  const screenshot = png(2, 1, [20, 40, 60, 255, 80, 100, 120, 255]);
  await writeFile(baseline, screenshot);
  await writeFile(current, screenshot);
  const comparison = await run(["workbench", "visual", baseline, current, "--json"]);
  assert.equal(JSON.parse(comparison.stdout).matches, true);
});

test("portable CLI exports omit local credentials and environment files", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-export-"));
  await writeFile(join(root, "app.ts"), "export const app = true;\n");
  await writeFile(join(root, ".env.production"), "SECRET=not-exported\n");
  await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=not-exported\n");
  const output = join(root, "portable.json");
  await run(["workbench", "export", root, "--name=test-app", "--framework=0.14.0", `--output=${output}`, "--json"]);
  const bundle = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(bundle.files.map((file) => file.path), ["app.ts"]);
  await run(["workbench", "export", root, "--name=test-app", "--framework=0.14.0", `--output=${output}`, "--force=true", "--json"]);
  const replaced = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(replaced.files.map((file) => file.path), ["app.ts"]);
});

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr || stdout}`)));
  });
}

function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) rows.set(rgba.slice(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(name, data), data.length + 8);
  return output;
}

function crc32(...chunks) {
  let value = 0xffffffff;
  for (const bytes of chunks) for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
