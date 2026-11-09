import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineDatabase, defineTable, openSQLite } from "../dist/backend.js";
import { applyMigrations } from "../dist/migrations.js";
import { s } from "../dist/ai.js";
import { SQLITE_INTERNAL } from "../dist/sqlite-internal.js";

const notes = () => defineDatabase({ notes: defineTable({ title: s.string(), count: s.number() }) });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "clank-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "app.sqlite") };
}

/** Edit the file the way an operator with direct SQLite access could. */
function directly(path, action) {
  const native = new DatabaseSync(path);
  try { return action(native); } finally { native.close(); }
}

const meta = (path) => directly(path, (native) => Object.fromEntries(
  native.prepare("SELECT _key, _value FROM clank_meta ORDER BY _key").all().map((row) => [row._key, row._value]),
));
const corrupt = (path) => directly(path, (native) => {
  native.prepare("UPDATE clank_notes SET _data = ?").run(JSON.stringify({ title: 7, count: "many" }));
});

async function seeded(t, schema = notes()) {
  const f = await fixture(t);
  const db = await openSQLite(schema, { path: f.path });
  db.transaction((write) => { for (let index = 0; index < 5; index++) write.table("notes").insert({ title: `Note ${index}`, count: index }); });
  db.close();
  return f;
}

test("default ordering reads through an index instead of sorting the table", async (t) => {
  const f = await fixture(t);
  const schema = defineDatabase({
    notes: defineTable({ title: s.string(), count: s.number() }),
    drafts: defineTable({ title: s.string() }).owned(),
  });
  const db = await openSQLite(schema, { path: f.path });
  try {
    db.transaction((write) => { for (let index = 0; index < 50; index++) write.table("notes").insert({ title: `Note ${index}`, count: index }); });
    db.transaction((write) => { for (let index = 0; index < 50; index++) write.table("drafts").insert({ title: `Draft ${index}` }); }, { userId: "owner-a" });
    const plan = (sql, ...parameters) => db[SQLITE_INTERNAL].prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => row.detail).join(" | ");
    const shared = plan("SELECT _id, _owner_id, _creation_time, _version, _data FROM \"clank_notes\" ORDER BY _creation_time ASC, _id ASC LIMIT 20");
    assert.match(shared, /USING INDEX clank_notes_order/u);
    assert.doesNotMatch(shared, /TEMP B-TREE/u);
    const owned = plan("SELECT _id, _owner_id, _creation_time, _version, _data FROM \"clank_drafts\" WHERE _owner_id = ? ORDER BY _creation_time ASC, _id ASC LIMIT 20", "owner-a");
    assert.match(owned, /USING INDEX clank_drafts_owner_order \(_owner_id=\?\)/u);
    assert.doesNotMatch(owned, /TEMP B-TREE/u);
    // Creation time, then ID: the same order as before the index existed.
    const all = db.read((read) => read.table("notes").collect());
    const expected = [...all].sort((left, right) => left._creationTime - right._creationTime || (left._id < right._id ? -1 : 1));
    assert.deepEqual(all.map((row) => row._id), expected.map((row) => row._id));
    assert.deepEqual(db.read((read) => read.table("notes").query().limit(3).collect()).map((row) => row._id), expected.slice(0, 3).map((row) => row._id));
    assert.equal(db.read((read) => read.table("notes").query().first())._id, expected[0]._id);
    assert.equal(db.read((read) => read.table("drafts").query().limit(2).collect(), { userId: "owner-a" }).length, 2);
    assert.equal(db.read((read) => read.table("drafts").query().collect(), { userId: "owner-b" }).length, 0);
  } finally { db.close(); }
});

test("an owner-only index from an earlier release is replaced by the ordered one", async (t) => {
  const f = await fixture(t);
  const schema = () => defineDatabase({ drafts: defineTable({ title: s.string() }).owned() });
  (await openSQLite(schema(), { path: f.path })).close();
  directly(f.path, (native) => {
    native.exec("DROP INDEX clank_drafts_owner_order; CREATE INDEX clank_drafts_owner ON clank_drafts (_owner_id)");
  });
  (await openSQLite(schema(), { path: f.path })).close();
  const indexes = directly(f.path, (native) => native.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='clank_drafts' AND name LIKE 'clank_%' ORDER BY name").all().map((row) => row.name));
  assert.deepEqual(indexes, ["clank_drafts_owner_order"]);
});

test("validation is recorded by the first commit and then skipped for the same schema", async (t) => {
  const f = await fixture(t);
  const first = await openSQLite(notes(), { path: f.path });
  assert.equal(meta(f.path).validated_schema, undefined, "Opening alone must not write a validation record.");
  first.transaction((write) => write.table("notes").insert({ title: "one", count: 1 }));
  const recorded = meta(f.path);
  assert.equal(recorded.validated_revision, recorded.global_version);
  assert.equal(Number.isSafeInteger(recorded.validated_schema), true);
  first.transaction((write) => write.table("notes").insert({ title: "two", count: 2 }));
  assert.equal(meta(f.path).validated_revision, meta(f.path).global_version, "Each validating commit extends the record.");
  first.close();

  // The record covers validating writers only. A direct edit is outside it,
  // which is exactly what the explicit full mode exists for.
  corrupt(f.path);
  const trusted = await openSQLite(notes(), { path: f.path });
  assert.throws(() => trusted.read((read) => read.table("notes").collect()), /Expected a string/u, "Reads still validate every document.");
  trusted.close();
  await assert.rejects(openSQLite(notes(), { path: f.path, storedDataValidation: "always" }), /Expected a string/u);
  await assert.rejects(openSQLite(notes(), { path: f.path, storedDataValidation: "sometimes" }), /storedDataValidation/u);
});

test("a database that was validated but never written is validated again", async (t) => {
  const f = await seeded(t);
  directly(f.path, (native) => native.prepare("DELETE FROM clank_meta WHERE _key LIKE 'validated_%'").run());
  (await openSQLite(notes(), { path: f.path })).close();
  assert.equal(meta(f.path).validated_schema, undefined);
  corrupt(f.path);
  await assert.rejects(openSQLite(notes(), { path: f.path }), /Expected a string/u);
});

test("a changed schema or ownership reads every document again", async (t) => {
  const f = await seeded(t);
  const narrowed = defineDatabase({ notes: defineTable({ title: s.string({ max: 3 }), count: s.number() }) });
  await assert.rejects(openSQLite(narrowed, { path: f.path }), /at most 3 characters/u);
  const owned = defineDatabase({ notes: defineTable({ title: s.string(), count: s.number() }).owned() });
  await assert.rejects(openSQLite(owned, { path: f.path }), /unowned document/u);
  // A compatible change validates once, then becomes the recorded schema.
  const widened = () => defineDatabase({ notes: defineTable({ title: s.string(), count: s.number(), tag: s.optional(s.string()) }) });
  const before = meta(f.path).validated_schema;
  const db = await openSQLite(widened(), { path: f.path });
  db.transaction((write) => write.table("notes").insert({ title: "tagged", count: 9, tag: "x" }));
  db.close();
  assert.notEqual(meta(f.path).validated_schema, before);
  assert.equal(meta(f.path).validated_revision, meta(f.path).global_version);
});

test("a writer with another schema, or one that keeps no record, ends the trust", async (t) => {
  const f = await seeded(t);
  const widened = defineDatabase({ notes: defineTable({ title: s.string(), count: s.number(), tag: s.optional(s.string()) }) });
  // Two releases share the file during a rollout. The original one keeps writing.
  const original = await openSQLite(notes(), { path: f.path });
  const rollout = await openSQLite(widened, { path: f.path });
  const before = meta(f.path);
  rollout.transaction((write) => write.table("notes").insert({ title: "new field", count: 1, tag: "only valid for the wider schema" }));
  const after = meta(f.path);
  // The rollout read everything under its own schema, so the record is now its own.
  assert.notEqual(after.validated_schema, before.validated_schema);
  assert.equal(after.validated_revision, after.global_version);
  original.transaction((write) => write.table("notes").insert({ title: "still here", count: 2 }));
  assert.equal(meta(f.path).validated_schema, after.validated_schema);
  assert.notEqual(meta(f.path).validated_revision, meta(f.path).global_version, "A writer with another schema must not extend the record.");
  rollout.transaction((write) => write.table("notes").insert({ title: "later", count: 3 }));
  assert.notEqual(meta(f.path).validated_revision, meta(f.path).global_version, "A broken chain is never resumed.");
  original.close();
  rollout.close();
  await assert.rejects(openSQLite(notes(), { path: f.path }), /Unknown property/u, "The original schema must see the document it cannot accept.");

  // A release that predates the record advances the revision without it.
  const legacy = await seeded(t);
  directly(legacy.path, (native) => {
    native.exec("BEGIN IMMEDIATE");
    native.prepare("UPDATE clank_notes SET _data = ? WHERE rowid = (SELECT min(rowid) FROM clank_notes)").run(JSON.stringify({ title: 1, count: 1 }));
    native.prepare("UPDATE clank_meta SET _value = _value + 1 WHERE _key = 'global_version'").run();
    native.exec("COMMIT");
  });
  await assert.rejects(openSQLite(notes(), { path: legacy.path }), /Expected a string/u);
});

test("an applied migration forces the next open to read every document", async (t) => {
  const f = await seeded(t);
  const migrations = join(f.directory, "migrations");
  await mkdir(migrations);
  await writeFile(join(migrations, "0001_rewrite.sql"), `UPDATE clank_notes SET _data = '{"title":7,"count":"many"}';\n`);
  await applyMigrations({ path: f.path, directory: migrations, allowUnsafe: true });
  assert.equal(meta(f.path).validated_schema, undefined);
  assert.equal(meta(f.path).validated_revision, undefined);
  await assert.rejects(openSQLite(notes(), { path: f.path }), /Expected a string/u);
});

test("tables with refinements are validated on every open", async (t) => {
  const refined = (limit) => defineDatabase({
    notes: defineTable({ title: s.string(), count: s.refine(s.number(), (value) => value < limit, "Count is too large.") }),
  });
  const f = await seeded(t, refined(100));
  // The JSON Schema is identical; only the predicate changed.
  await assert.rejects(openSQLite(refined(3), { path: f.path }), /Count is too large/u);
  (await openSQLite(refined(100), { path: f.path })).close();
});
