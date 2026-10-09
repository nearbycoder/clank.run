import { defineDatabase, defineTable, openSQLite, s } from "../../dist/index.js";
import { openAgentBudgets } from "../../dist/agent-budgets.js";
const [path, grantId, operationId] = process.argv.slice(2);
const schema = defineDatabase({ items: defineTable({ text: s.string() }).owned(), outbox: defineTable({ key: s.string() }).owned() });
const database = await openSQLite(schema, { path });
const budgets = await openAgentBudgets(database, {
  actions: { add: { revision: "v1", args: s.object({ text: s.string() }), authorize: () => true, execute: ({ db }, input) => ({ id: db.table("items").insert(input) }) } },
  identity: () => ({ ownerId: "owner", principalId: "agent" }), authorizeManage: () => false, now: () => 10000,
});
process.once("message", () => {
  let result;
  try { result = { accepted: true, receipt: budgets.execute({ grantId, operationId, action: "add", input: { text: "hello" } }, null) }; }
  catch (error) { result = { accepted: false, code: error.code }; }
  database.close(); process.send({ result }, () => process.disconnect());
});
process.send({ ready: true });
