import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s, createPreviewFixture } from "../dist/index.js";

const definition = defineBackend({ auth: defineAuth(), schema: defineDatabase({
  tasks: defineTable({ title: s.string() }).owned(),
}) }).functions(({ query }) => ({ list: query({ args: {}, handler: ({ db }) => db.table("tasks").collect() }) }));
const fixture = { protocol: "clank-fixture/1", name: "demo", description: "Synthetic tasks",
  users: { alice: { email: "alice@example.invalid", role: "member", profile: {} }, bob: { email: "bob@example.invalid", role: "member", profile: {} } },
  records: { tasks: { first: { owner: "alice", values: { title: "Demo task" } } } } };

test("preview fixture generation creates a fresh private database with usable isolated demo accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-fixture-test-"));
  const outputPath = join(root, "fixture.sqlite");
  try {
    const report = await createPreviewFixture(definition, fixture, { outputPath, password: "preview-password-123" });
    assert.equal(report.users, 2);
    assert.equal(report.records, 1);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const original = await readFile(outputPath);
    await assert.rejects(createPreviewFixture(definition, fixture, { outputPath, password: "preview-password-123" }), { code: "EEXIST" });
    assert.deepEqual(await readFile(outputPath), original, "never overwrite an existing fixture or application database");
    const backend = await openBackend(definition, { path: outputPath });
    try {
      for (const [email, expected] of [["alice@example.invalid", 1], ["bob@example.invalid", 0]]) {
        const response = await backend.handle(new Request("https://preview.test/__clank/auth/login", {
          method: "POST", headers: { "content-type": "application/json", origin: "https://preview.test" },
          body: JSON.stringify({ email, password: "preview-password-123" }),
        }));
        assert.equal(response.status, 200);
        const caller = await backend.caller(new Request("https://preview.test/", { headers: { cookie: response.headers.get("set-cookie").split(";", 1)[0] } }));
        assert.equal(caller.query("list", {}).value.length, expected);
      }
    } finally { backend.close(); }
    await assert.rejects(createPreviewFixture(definition, { ...fixture, users: { alice: { ...fixture.users.alice, email: "person@example.com" } } }, { outputPath, password: "preview-password-123" }), /example.invalid/);
    await assert.rejects(createPreviewFixture(definition, fixture, { outputPath, password: "short" }), /12 characters/);
    await assert.rejects(createPreviewFixture(definition, { ...fixture, records: { tasks: { first: { owner: "alice", values: { title: { ref: "tasks.missing" } } } } } }, { outputPath: join(root, "invalid.sqlite"), password: "preview-password-123" }), /cycle or missing/);
    await assert.rejects(stat(join(root, "invalid.sqlite")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
