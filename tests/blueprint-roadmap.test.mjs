import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { defineApp, generateAppFiles } from "../dist/blueprint.js";
import { openBackend } from "../dist/index.js";
import { mergeGeneratedFile } from "../scripts/blueprint-regeneration.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const entity = (ownership = "workspace") => ({ description: "Records", ownership, displayField: "name", fields: { name: { type: "string" } } });
const blueprint = {
  name: "Workspace Contract", description: "Isolation and relationship enforcement", admin: { roles: ["owner"], entities: ["tasks", "profiles"] },
  auth: { organizations: true, roles: { owner: { description: "Owner", permissions: ["*"] } } },
  entities: { tasks: entity(), profiles: { ...entity(), fields: { name: { type: "string" }, taskId: { type: "reference", entity: "tasks" } } }, tags: entity(), catalog: entity("public") },
  relationships: [
    { name: "taskProfile", from: "tasks", to: "profiles", kind: "one-to-one", onDelete: "cascade" },
    { name: "taskTags", from: "tasks", to: "tags", kind: "many-to-many", onDelete: "cascade" },
  ],
  routes: [{ path: "/", view: "Tasks", entity: "tasks" }, { path: "/tasks/:id", view: "Task details", entity: "tasks" }, { path: "/catalog", view: "Public catalog", entity: "catalog", access: "public" }, { path: "/catalog/:id", view: "Public detail", entity: "catalog", access: "public" }],
  actions: { "profiles.edit": { description: "Edit profile", entity: "profiles", operation: "update" } },
};

async function generated(input = blueprint) {
  const dir = await mkdtemp(join(tmpdir(), "clank-roadmap-blueprint-"));
  const files = generateAppFiles(input);
  for (const file of files) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
    if (/^src\/.*\.tsx?$/u.test(file.path)) {
      const output = join(dir, file.path.replace(/^src\//u, "dist/").replace(/\.tsx?$/u, ".js"));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, compile(file.contents, { filename: file.path, sourceMap: false }));
    }
  }
  await mkdir(join(dir, "node_modules/@clank.run"), { recursive: true });
  await symlink(repository, join(dir, "node_modules/@clank.run/framework"), "dir");
  const module = await import(pathToFileURL(join(dir, "dist/backend.js")));
  const runtime = await openBackend(module.backend, { path: ":memory:", wal: false });
  return { dir, files, runtime, close: async () => { runtime.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function register(runtime, email, origin = "https://fixture.test") {
  const response = await runtime.handle(new Request(`${origin}/__clank/auth/register`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email, password: "correct horse battery staple", profile: { name: email } }) }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  return { ...payload, cookie, caller: await runtime.caller(new Request(`${origin}/`, { headers: { cookie } })) };
}

test("workspace generation shares with members, scopes every path, and revokes current callers", async () => {
  const project = await generated();
  try {
    const a = await register(project.runtime, "a@example.invalid");
    const b = await register(project.runtime, "b@example.invalid");
    const c = await register(project.runtime, "c@example.invalid");
    const personal = a.caller.mutation("tasks.create", { name: "Private personal" }).value;
    assert.equal(a.caller.query("tasks.list").value.length, 1);
    const workspace = a.caller.mutation("workspaces.create", { name: "Shared team" }).value;
    const task = a.caller.mutation("tasks.create", { name: "Shared record" }).value;
    const record = a.caller.query("tasks.list").value[0];
    assert.equal(record._id, task);
    assert.equal(record.workspaceId, workspace);
    assert.equal(a.caller.query("tasks.list").value.some((row) => row._id === personal), false);
    assert.throws(() => b.caller.mutation("workspaces.select", { id: workspace }), { code: "WORKSPACE_NOT_FOUND" });
    assert.throws(() => c.caller.query("tasks.detail", { id: task }), { code: "RECORD_NOT_FOUND" });
    assert.throws(() => c.caller.mutation("tasks.remove", { id: task, version: record._version }), { code: "RECORD_NOT_FOUND" });
    assert.throws(() => c.caller.mutation("profiles.create", { name: "Cross tenant", taskId: task }), { code: "REFERENCE_NOT_FOUND" });
    assert.deepEqual(c.caller.query("tasks.history", { id: task, limit: 100 }).value, []);
    const retained = a.caller.query("tasks.history", { id: task, limit: 25 }).value[0];
    assert.throws(() => c.caller.mutation("tasks.restore", { id: task, revision: retained.cursor.revision, sequence: retained.cursor.sequence, version: record._version }), { code: "RECORD_NOT_FOUND" });
    a.caller.mutation("workspaces.addMember", { workspaceId: workspace, userId: b.user.id });
    b.caller.mutation("workspaces.select", { id: workspace });
    assert.equal(b.caller.query("tasks.list").value[0]._id, task);
    assert.throws(() => b.caller.mutation("workspaces.addMember", { workspaceId: workspace, userId: c.user.id }), { code: "WORKSPACE_NOT_FOUND" });
    const sharedCreated = b.caller.mutation("tasks.create", { name: "Member creation" }).value;
    assert.ok(a.caller.query("tasks.list").value.some((row) => row._id === sharedCreated));
    a.caller.mutation("workspaces.removeMember", { workspaceId: workspace, userId: b.user.id });
    assert.equal(b.caller.query("tasks.list").value.length, 0, "existing caller and cached query must lose membership immediately");
    assert.throws(() => b.caller.query("tasks.detail", { id: sharedCreated }), { code: "RECORD_NOT_FOUND" });
    assert.equal(b.caller.query("workspaces.list").value.active, b.user.id);
    a.caller.mutation("workspaces.select", { id: a.user.id });
    assert.equal(a.caller.query("tasks.list").value[0]._id, personal);
  } finally { await project.close(); }
});

test("one-to-one and many-to-many are transactionally enforced including historical restores", async () => {
  const project = await generated();
  try {
    const a = await register(project.runtime, "a@example.invalid");
    const task = a.caller.mutation("tasks.create", { name: "One" }).value;
    const profile = a.caller.mutation("profiles.create", { name: "Only", taskId: task }).value;
    assert.throws(() => a.caller.mutation("profiles.create", { name: "Duplicate", taskId: task }), { code: "RELATIONSHIP_CARDINALITY" });
    const stored = a.caller.query("profiles.list").value[0];
    const revision = a.caller.query("profiles.history", { id: profile, limit: 25 }).value[0];
    a.caller.mutation("profiles.remove", { id: profile, version: stored._version });
    a.caller.mutation("profiles.create", { name: "Replacement", taskId: task });
    assert.throws(() => a.caller.mutation("profiles.restore", { id: profile, revision: revision.cursor.revision, sequence: revision.cursor.sequence, version: null }), { code: "RELATIONSHIP_CARDINALITY" });
    const secondTask = a.caller.mutation("tasks.create", { name: "Second" }).value;
    const secondProfile = a.caller.mutation("profiles.create", { name: "Second profile", taskId: secondTask }).value;
    const currentProfile = a.caller.query("profiles.list").value.find((row) => row._id === secondProfile);
    assert.throws(() => a.caller.mutation("profiles.edit", { id: secondProfile, version: currentProfile._version, changes: { taskId: task } }), { code: "RELATIONSHIP_CARDINALITY" });
    assert.equal(a.caller.query("profiles.list").value.find((row) => row._id === secondProfile).taskId, secondTask);
    const tag = a.caller.mutation("tags.create", { name: "Tag" }).value;
    a.caller.mutation("taskTagsLinks.create", { fromId: task, toId: tag });
    assert.throws(() => a.caller.mutation("taskTagsLinks.create", { fromId: task, toId: tag }), { code: "RELATIONSHIP_CARDINALITY" });
    const other = a.caller.mutation("tasks.create", { name: "Two" }).value;
    a.caller.mutation("taskTagsLinks.create", { fromId: other, toId: tag });
    assert.equal(a.caller.query("taskTagsLinks.list").value.length, 2);
    const first = a.caller.query("tasks.list").value.find((row) => row._id === task);
    a.caller.mutation("tasks.remove", { id: task, version: first._version });
    assert.equal(a.caller.query("taskTagsLinks.list").value.length, 1);
    assert.equal(a.caller.query("profiles.list").value.length, 1);
  } finally { await project.close(); }
});

test("public and typed detail queries expose only explicit public records", async () => {
  assert.throws(() => defineApp({ ...blueprint, routes: [{ path: "/", view: "Oops", entity: "tasks", access: "public" }] }), /explicitly public/u);
  assert.throws(() => defineApp({ ...blueprint, routes: [{ path: "/:id/edit", view: "Oops", entity: "tasks" }] }), /absolute path/u);
  assert.throws(() => defineApp({ ...blueprint, routes: [{ path: "/tasks/:id", view: "One", entity: "tasks" }, { path: "/tasks/:other", view: "Two", entity: "tasks" }] }), /route paths/u);
  const project = await generated();
  try {
    const a = await register(project.runtime, "a@example.invalid");
    const catalog = a.caller.mutation("catalog.create", { name: "Published" }).value;
    const anonymous = await project.runtime.caller(new Request("https://fixture.test/"));
    assert.equal(anonymous.query("catalog.publicList").value[0]._id, catalog);
    assert.equal(anonymous.query("catalog.detail", { id: catalog }).value.name, "Published");
    assert.throws(() => anonymous.query("tasks.detail", { id: "tasks:missing" }), { code: "UNAUTHENTICATED" });
    assert.throws(() => anonymous.mutation("catalog.create", { name: "Forbidden" }), { code: "UNAUTHENTICATED" });
    assert.throws(() => anonymous.query("catalog.detail", { id: catalog.slice(0, -1) + (catalog.endsWith("a") ? "b" : "a") }), { code: "RECORD_NOT_FOUND" });
  } finally { await project.close(); }
});

test("three-way regeneration merges separated edits and rejects conflicting edits and deletions", () => {
  const base = "first\nsecond\nthird\nfourth\nfifth\n";
  assert.deepEqual(mergeGeneratedFile(base, "hand\nsecond\nthird\nfourth\nfifth\n", "first\nsecond\nthird\nfourth\ngenerated\n"), { contents: "hand\nsecond\nthird\nfourth\ngenerated\n", conflict: false, preserved: true });
  assert.equal(mergeGeneratedFile(base, "hand\nsecond\nthird\nfourth\nfifth\n", "generated\nsecond\nthird\nfourth\nfifth\n").conflict, true);
  assert.equal(mergeGeneratedFile(base, undefined, base).deleted, true);
  assert.equal(mergeGeneratedFile(base, undefined, base + "new\n").conflict, true);
  assert.equal(mergeGeneratedFile(undefined, "handwritten", "generated").conflict, true);
  assert.equal(mergeGeneratedFile(base, base, "generated").contents, "generated");
  assert.equal(mergeGeneratedFile(base, "handwritten", base).contents, "handwritten");
});


test("generated HTTP routes render anonymous public pages and authenticated authorized detail records", async () => {
  const project = await generated();
  let serverModule;
  const prior = { PORT: process.env.PORT, CLANK_DATABASE_PATH: process.env.CLANK_DATABASE_PATH };
  try {
    const source = project.files.find((file) => file.path === "src/server.tsx").contents + "\nexport { server, runtime, close };\n";
    await writeFile(join(project.dir, "dist/server.js"), compile(source, { filename: "src/server.tsx", sourceMap: false }));
    process.env.PORT = "0";
    process.env.CLANK_DATABASE_PATH = join(project.dir, "server.sqlite");
    serverModule = await import(pathToFileURL(join(project.dir, "dist/server.js")));
    const owner = await register(serverModule.runtime, "owner@example.invalid", serverModule.server.url);
    const task = owner.caller.mutation("tasks.create", { name: "Private task" }).value;
    const catalog = owner.caller.mutation("catalog.create", { name: "Published <script>" }).value;
    const origin = serverModule.server.url;
    const publicPage = await fetch(new URL("/catalog", origin));
    assert.equal(publicPage.status, 200);
    const body = await publicPage.text();
    assert.match(body, /Published &lt;script&gt;/u);
    assert.doesNotMatch(body, /Private task|auth-sign-out|catalog-create/u);
    assert.equal((await fetch(new URL(`/catalog/${catalog}`, origin))).status, 200);
    assert.equal((await fetch(new URL("/catalog/not-an-id", origin))).status, 404);
    assert.equal((await fetch(new URL(`/tasks/${task}`, origin))).status, 401);
    const ownerPage = await fetch(new URL(`/tasks/${task}`, origin), { headers: { cookie: owner.cookie } });
    assert.equal(ownerPage.status, 200);
    assert.match(await ownerPage.text(), /Private task/u);
    const outsider = await register(serverModule.runtime, "other@example.invalid", serverModule.server.url);
    assert.equal((await fetch(new URL(`/tasks/${task}`, origin), { headers: { cookie: outsider.cookie } })).status, 404);
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await serverModule?.close();
    await project.close();
  }
});


test("detail loaders repeat role authorization even when the list route permits every signed-in user", async () => {
  const input = structuredClone(blueprint);
  input.auth.roles.member = { description: "Member", permissions: [] };
  input.routes[1].access = { roles: ["owner"] };
  const project = await generated(input);
  try {
    const member = await register(project.runtime, "member@example.invalid");
    project.runtime.auth.setRole(member.user.id, "member");
    const caller = await project.runtime.caller(new Request("https://fixture.test/", { headers: { cookie: member.cookie } }));
    const id = caller.mutation("tasks.create", { name: "Allowed list" }).value;
    assert.equal(caller.query("tasks.list").value.length, 1);
    assert.throws(() => caller.query("tasks.detail", { id }), (error) => error.status === 403);
  } finally { await project.close(); }
});
