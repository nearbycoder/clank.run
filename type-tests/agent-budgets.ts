import { defineDatabase, defineTable, openSQLite, s, type Id } from "../src/index.ts";
import { defineAgentBudgetAction, openAgentBudgets, type AgentBudgetContext } from "../src/agent-budgets.ts";

const schema = defineDatabase({ items: defineTable({ text: s.string() }).owned() });
interface Caller { ownerId: string; principalId: string; admin: boolean; }
const insert = defineAgentBudgetAction(schema, {
  revision: "v1", args: s.object({ text: s.string() }),
  authorize(context: AgentBudgetContext<Caller, typeof schema>) {
    context.db.table("items").collect();
    if (false) {
      // @ts-expect-error Authorization receives read-only access.
      context.db.table("items").insert({ text: "invalid" });
      // @ts-expect-error Only declared schema tables exist.
      context.db.table("missing");
    }
    return Boolean(context.caller.principalId);
  },
  execute({ db }, input) {
    const id = db.table("items").insert(input);
    if (false) {
      // @ts-expect-error Schema fields remain typed in budget actions.
      db.table("items").patch(id, { unknown: true });
    }
    return { id };
  },
});
const database = await openSQLite(schema);
const budgets = await openAgentBudgets(database, {
  actions: { insert }, identity: (caller: Caller) => ({ ownerId: caller.ownerId, principalId: caller.principalId }),
  authorizeManage: ({ caller }) => caller.admin,
});
const caller: Caller = { ownerId: "owner", principalId: "agent", admin: true };
const grant = budgets.grant({ principalId: "agent", actions: ["insert"], limits: { calls: 1, writes: 1, records: 1, externalOperations: 0 }, expiresAt: Date.now() + 10000, reason: "One insertion" }, caller);
const receipt = budgets.execute({ grantId: grant.id, operationId: "one", action: "insert", input: { text: "accepted" } }, caller);
const id: Id<"items"> = receipt.output.id;
void id;
if (false) {
  // @ts-expect-error Unknown registered actions are rejected at compile time.
  budgets.execute({ grantId: grant.id, operationId: "two", action: "missing", input: {} }, caller);
  // @ts-expect-error Inputs follow the selected action's schema.
  budgets.execute({ grantId: grant.id, operationId: "two", action: "insert", input: { text: 12 } }, caller);
  // @ts-expect-error Receipts expose immutable counters.
  receipt.cost.calls = 0;
  // @ts-expect-error A caller cannot provide their own costs.
  budgets.execute({ grantId: grant.id, operationId: "two", action: "insert", input: { text: "hello" }, cost: { calls: 0 } }, caller);
}
database.close();
