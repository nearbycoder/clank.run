import { DatabaseSync } from "node:sqlite";
import { defineDatabase, defineTable, openSQLite } from "../../dist/backend.js";
import { defineAuth } from "../../dist/auth.js";
import { s } from "../../dist/ai.js";
import { openSearch } from "../../dist/search.js";
const [path, owner, mode] = process.argv.slice(2);
const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), score: s.number() }).owned(), articles: defineTable({ title: s.string(), body: s.string(), scope: s.string() }) });
const database = await openSQLite(schema, { path });
const service = mode === "rebuild" ? await openSearch({ path, schema, auth: defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }), source: { name: "notes", table: "notes", title: "title", body: "body", scope: "owner" }, authorize: () => true }) : undefined;
// Stop after a real FTS write, with both source/index still inside their SQLite
// transaction. The parent kills the process; SQLite must roll everything back.
const original = DatabaseSync.prototype.prepare;
let armed = false;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = original.call(this, sql);
  if (!sql.startsWith("INSERT INTO clank_source_search_fts")) return statement;
  return { all: statement.all.bind(statement), get: statement.get.bind(statement), run(...args) {
    const result = statement.run(...args);
    if (armed) { process.send({ uncommitted: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); }
    return result;
  } };
};
process.send({ ready: true });
process.once("message", () => {
  armed = true;
  if (service) service.rebuild({ batchSize: 1 });
  else database.transaction(db => db.table("notes").insert({ title: "Crash launch", body: "launch", score: 1 }), { userId: owner });
});
