import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const cli = fileURLToPath(new URL("../scripts/clank.mjs", import.meta.url));
const watchers = new Map();

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "clank-moon-cli-"));
  watchers.set(root, []);
  t.after(async () => {
    for (const process of watchers.get(root)) {
      process.child.kill("SIGTERM");
      const timeout = setTimeout(() => process.child.kill("SIGKILL"), 2_000);
      try { await process.exited; } finally { clearTimeout(timeout); }
    }
    watchers.delete(root);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "src"));
  return root;
}

function launch(args, cwd, preload) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...(preload ? ["--import", preload] : []), cli, ...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function run(args, cwd, preload) {
  const process = launch(args, cwd, preload);
  const timeout = setTimeout(() => process.child.kill("SIGKILL"), 15_000);
  try { return await process.exited; } finally { clearTimeout(timeout); }
}

async function until(check, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail(message);
}

async function content(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function watching(t, root, extra = []) {
  const process = launch(["watch", "src", "dist", ...extra], root);
  watchers.get(root).push(process);
  await until(() => process.stdout.includes("Watching "), `Watch did not start: ${process.stderr}`);
  return process;
}

test("091: watch refreshes copied JavaScript, images, fonts, and arbitrary static extensions", async (t) => {
  const root = await directory(t);
  const names = ["app.js", "worker.mjs", "image.webp", "font.woff2", "data.custom"];
  for (const name of names) await writeFile(join(root, "src", name), "before");
  await watching(t, root);
  for (const name of names) await writeFile(join(root, "src", name), `after ${name}`);
  await until(async () => (await Promise.all(names.map((name) => content(join(root, "dist", name)))))
    .every((value, index) => value === `after ${names[index]}`), "Copied static assets did not refresh");
});

test("092: watch reconciles renamed and deleted source directories", async (t) => {
  const root = await directory(t);
  await mkdir(join(root, "src", "old"));
  await writeFile(join(root, "src", "old", "asset.bin"), "retained");
  await watching(t, root);
  await rename(join(root, "src", "old"), join(root, "src", "new"));
  await until(async () => await content(join(root, "dist", "new", "asset.bin")) === "retained"
    && await content(join(root, "dist", "old", "asset.bin")) === null, "Directory rename left stale outputs");
  await rm(join(root, "src", "new"), { recursive: true });
  await until(async () => await content(join(root, "dist", "new", "asset.bin")) === null, "Directory removal left stale outputs");
});

test("093: watch coalesces changes during a slow build without overlapping writers", async (t) => {
  const root = await directory(t);
  const tailwind = join(root, "node_modules", "@tailwindcss", "cli", "dist");
  await mkdir(tailwind, { recursive: true });
  await writeFile(join(root, "src", "style.css"), "initial");
  await writeFile(join(tailwind, "index.mjs"), `
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
try { await mkdir("active-build"); }
catch { await appendFile("build-events", "overlap\\n"); process.exit(1); }
try {
  await appendFile("build-events", "start\\n");
  const source = await readFile(process.argv[process.argv.indexOf("-i") + 1], "utf8");
  await setTimeout(240);
  await writeFile(process.argv[process.argv.indexOf("-o") + 1], source);
  await appendFile("build-events", "end\\n");
} finally { await rm("active-build", { recursive: true }); }
`);
  const process = await watching(t, root, ["--tailwind=src/style.css"]);
  await writeFile(join(root, "src", "style.css"), "second");
  await until(async () => (await content(join(root, "build-events")))?.split("start").length >= 3, "Second build did not start");
  await writeFile(join(root, "src", "style.css"), "third");
  await delay(80);
  await writeFile(join(root, "src", "style.css"), "latest");
  await until(async () => await content(join(root, "dist", "styles.css")) === "latest", "Queued build did not publish the latest source");
  const events = await content(join(root, "build-events"));
  assert.doesNotMatch(events, /overlap/u);
  assert.equal(process.stderr, "");
});

test("094: colliding compiler outputs fail before replacing previous artifacts", async (t) => {
  const root = await directory(t);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "entry.js"), "last good build");
  await writeFile(join(root, "src", "entry.ts"), "export const value = 1;");
  for (const extension of ["tsx", "js"]) {
    const conflicting = join(root, "src", `entry.${extension}`);
    await writeFile(conflicting, "export const value = 2;");
    const result = await run(["build", "src", "dist"], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Output collision:.*entry\.ts/u);
    assert.match(result.stderr, new RegExp(`entry\\.${extension}.*produce entry\\.js`, "u"));
    assert.equal(await content(join(root, "dist", "entry.js")), "last good build");
    await rm(conflicting);
  }
});

test("095: compiler bounds simultaneous source reads and settles workers before reporting errors", async (t) => {
  const root = await directory(t);
  for (let index = 0; index < 80; index++) await writeFile(join(root, "src", `${index}.ts`), `export const value = ${index};`);
  const preload = join(root, "measure.mjs");
  await writeFile(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
const original = fs.promises.readFile;
let active = 0, peak = 0;
fs.promises.readFile = async function(path, ...args) {
  if (!String(path).endsWith(".ts")) return original.call(this, path, ...args);
  active++; peak = Math.max(peak, active);
  try { await setTimeout(15); return await original.call(this, path, ...args); }
  finally { active--; }
};
syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync("concurrency.json", JSON.stringify({active, peak})));
`);
  const result = await run(["build", "src", "dist"], root, preload);
  assert.equal(result.code, 0, result.stderr);
  const measured = JSON.parse(await content(join(root, "concurrency.json")));
  assert.ok(measured.peak > 1 && measured.peak <= 16, `Peak simultaneous reads: ${measured.peak}`);
  assert.equal(measured.active, 0);
  await writeFile(join(root, "src", "0.ts"), "export const = ;");
  const failed = await run(["build", "src", "dist"], root, preload);
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(await content(join(root, "concurrency.json"))).active, 0);
});

test("096: installed Tailwind failures preserve diagnostics instead of claiming it is missing", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "src", "style.css"), "bad css");
  const missing = await run(["build", "src", "dist", "--tailwind=src/style.css"], root);
  assert.match(missing.stderr, /Tailwind CLI is unavailable/u);
  const entry = join(root, "node_modules", "@tailwindcss", "cli", "dist");
  await mkdir(entry, { recursive: true });
  await writeFile(join(entry, "index.mjs"), 'console.error("Invalid utility at style.css:1"); process.exit(2);');
  const result = await run(["build", "src", "dist", "--tailwind=src/style.css"], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid utility at style\.css:1/u);
  assert.match(result.stderr, /Tailwind build exited with 2/u);
  assert.doesNotMatch(result.stderr, /CLI is unavailable/u);
});

test("097: dot-prefixed child output directories are recognized as overlapping", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "src", "keep.ts"), "export const keep = true;");
  for (const output of ["src/..output", "src/..nested/dist"]) {
    const result = await run(["build", "src", output], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must not overlap/u);
    await assert.rejects(access(join(root, output)));
  }
  const sibling = await run(["build", "src", "..output"], root);
  assert.equal(sibling.code, 0, sibling.stderr);
});

test("098: workbench rejects unknown or valueless options before opening files or executing modules", async (t) => {
  const root = await directory(t);
  for (const args of [
    ["visual", "missing", "missing", "--tolerence=2"],
    ["provider", "missing", "--output=ignored"],
    ["schema", "missing", "missing", "--output="],
    ["performance", "missing", "missing", "--page"],
    ["export", "--json=true"], ["export", "-q"],
  ]) {
    const result = await run(["workbench", ...args], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option|requires a value/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
    assert.equal(result.stdout, "");
  }
});

test("099: workbench rejects surplus positionals before loading or writing anything", async (t) => {
  const root = await directory(t);
  for (const [command, maximum] of [["export", 1], ["provider", 1], ["schema", 2], ["visual", 2], ["promotion", 3]]) {
    const result = await run(["workbench", command, ...Array(maximum + 1).fill("missing"), "--json"], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Too many arguments/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
    assert.equal(result.stdout, "");
  }
});

test("100: visual JSON rejects lossy RGBA coercion and accepts byte boundaries", async (t) => {
  const root = await directory(t);
  const baseline = join(root, "baseline.json"), current = join(root, "current.json");
  await writeFile(baseline, JSON.stringify({ width: 1, height: 1, rgba: [0, 255, 0, 255] }));
  for (const invalid of [-1, 256, 1.5, "0", null, true, {}, []]) {
    await writeFile(current, JSON.stringify({ width: 1, height: 1, rgba: [invalid, 255, 0, 255] }));
    const result = await run(["workbench", "visual", baseline, current, "--json"], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /RGBA channels must be integers between 0 and 255/u);
    assert.equal(result.stdout, "");
  }
  await writeFile(current, await readFile(baseline));
  const equal = await run(["workbench", "visual", baseline, current, "--json"], root);
  assert.equal(equal.code, 0, equal.stderr);
  assert.equal(JSON.parse(equal.stdout).matches, true);
});
