import { DatabaseSync } from "node:sqlite";
import { defineDatabase, defineTable } from "../../dist/backend.js";
import { defineAuth } from "../../dist/auth.js";
import { s } from "../../dist/ai.js";
import { openDurableImport, createDurableImportClient } from "../../dist/durable-import.js";
const [path, stage] = process.argv.slice(2);
const schema = defineDatabase({ records: defineTable({ title: s.string({ min: 1, max: 5000 }), score: s.number({ integer: true }), active: s.default(s.boolean(), false) }).owned().index("by_title", ["title"]) });
const service = await openDurableImport({ path, auth: defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }), schema, table: "records", fields: ["title", "score"], uniqueBy: ["title"], reviewable: { duplicates: "upsert" } });
const original = DatabaseSync.prototype.prepare; let armed = false;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = original.call(this, sql);
  const boundary = stage === "target" ? sql.startsWith('INSERT OR IGNORE INTO "clank_records"') : sql.startsWith('INSERT OR IGNORE INTO "clank_durableImportOperations"');
  if (!boundary) return statement;
  return { all: statement.all.bind(statement), get: statement.get.bind(statement), run(...args) {
    const result = statement.run(...args);
    if (armed) { process.send({ uncommitted: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); }
    return result;
  } };
};
process.send({ ready: true });
process.once("message", async ({ user, preview }) => {
  armed = true;
  const client = createDurableImportClient({ url: "https://imports.test/__clank/imports", currentUser: () => user.id, auth: { csrfHeader: () => ({ "x-clank-csrf": user.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: "https://imports.test" } })) });
  try { await client.apply(preview, "crash"); throw new Error("Boundary was not reached."); } catch (error) { process.stderr.write(String(error)); process.exit(1); }
});
