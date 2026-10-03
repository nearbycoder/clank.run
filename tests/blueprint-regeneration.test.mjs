import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../scripts/clank.mjs", import.meta.url));
const initial = { name: "Regeneration", description: "Initial description", admin: false, entities: { tasks: { description: "Tasks", displayField: "title", fields: { title: { type: "string", max: 40 } } } }, routes: [{ path: "/", view: "Tasks", entity: "tasks" }] };
function run(args) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [cli, ...args]); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("exit", (code) => resolve({ code, stdout, stderr })); }); }
async function proposal(path, app) { await writeFile(path, `export default ${JSON.stringify(app)};\n`); }

test("compose uses last generated source, preserves edits and SQL history, and refuses overlapping changes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-regeneration-"));
  const target = join(root, "app"), source = join(root, "proposal.ts");
  try {
    await proposal(source, initial);
    assert.equal((await run(["generate", target, `--blueprint=${source}`, "--framework=local"])).code, 0);
    const backend = join(target, "src/backend.ts");
    const original = await readFile(backend, "utf8");
    const originalSQL = await readFile(join(target, "migrations/0001_app_metadata.sql"), "utf8");
    await writeFile(backend, original + "\n// Keep this hand-written customization.\n");
    const next = structuredClone(initial); next.entities.tasks.fields.title.max = 80;
    await proposal(source, next);
    const reviewed = await run(["compose", target, "--request=Increase title length", `--proposal=${source}`, "--framework=local", "--json"]);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    const review = JSON.parse(reviewed.stdout);
    assert.equal(review.changes.find((change) => change.path === "src/backend.ts").preserved, true);
    const applied = await run(["compose", target, `--review=${review.reviewId}`, `--approve=${review.planDigest}`, "--json"]);
    assert.equal(applied.code, 0, applied.stderr);
    const after = await readFile(backend, "utf8");
    assert.match(after, /Keep this hand-written customization/u);
    assert.match(after, /"max":80/u);
    assert.equal(await readFile(join(target, "migrations/0001_app_metadata.sql"), "utf8"), originalSQL);
    const baseline = JSON.parse(await readFile(join(target, ".clank/generated-baseline.json"), "utf8"));
    assert.doesNotMatch(baseline.files["src/backend.ts"], /hand-written customization/u);
    assert.equal(baseline.files["migrations/0001_app_metadata.sql"], originalSQL);

    await writeFile(backend, after.replaceAll('"max":80', '"max":90'));
    next.entities.tasks.fields.title.max = 100; next.description = "Should not write on conflict";
    await proposal(source, next);
    const conflictReview = JSON.parse((await run(["compose", target, "--request=Change title again", `--proposal=${source}`, "--framework=local", "--json"])).stdout);
    assert.equal(conflictReview.changes.find((change) => change.path === "src/backend.ts").status, "conflict");
    const readme = await readFile(join(target, "README.md"), "utf8");
    const rejected = await run(["compose", target, `--review=${conflictReview.reviewId}`, `--approve=${conflictReview.planDigest}`, "--json"]);
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.stderr).error.code, "COMPOSE_REGENERATION_CONFLICT");
    assert.equal(await readFile(join(target, "README.md"), "utf8"), readme);
    assert.match(await readFile(backend, "utf8"), /"max":90/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary generate merges edits and refuses symbolic generated parents without touching the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-generate-safety-"));
  const target = join(root, "app"), source = join(root, "proposal.ts");
  try {
    await proposal(source, initial);
    assert.equal((await run(["generate", target, `--blueprint=${source}`])).code, 0);
    const backend = join(target, "src/backend.ts");
    await writeFile(backend, await readFile(backend, "utf8") + "\n// preserved\n");
    const next = structuredClone(initial); next.description = "Changed safely";
    await proposal(source, next);
    const result = await run(["generate", target, `--blueprint=${source}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(backend, "utf8"), /preserved/u);
    const readme = await readFile(join(target, "README.md"), "utf8");
    await rm(join(target, "src"), { recursive: true });
    const outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(target, "src"), "dir");
    next.description = "Unsafe parent"; await proposal(source, next);
    const rejected = await run(["generate", target, `--blueprint=${source}`, "--force"]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Unsafe generated parent/u);
    assert.equal(await readFile(join(target, "README.md"), "utf8"), readme);
  } finally { await rm(root, { recursive: true, force: true }); }
});
