import { defineReviewedAction } from "../src/reviewed-actions.ts";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "../src/index.ts";

const schema = defineDatabase({ tasks: defineTable({ done: s.boolean() }).owned() });
const definition = defineBackend({ schema, auth: defineAuth() }).functions(() => ({}));
const finish = defineReviewedAction(schema, {
  revision: "finish-v1",
  title: "Finish a task",
  args: s.object({ id: s.id("tasks") }),
  authorize: ({ auth }) => Boolean(auth.user),
  preview: ({ db }, { id }) => {
    const task = db.table("tasks").get(id);
    if (!task) throw new Error("Task not found.");
    // @ts-expect-error Table names are checked against the supplied schema.
    db.table("unknown");
    // @ts-expect-error A task has no arbitrary secret field.
    task.secret;
    return { id, before: task.done, after: true };
  },
  authorizeApproval: ({ auth }, plan) => auth.user?.id === plan.requestedBy,
  execute: ({ db }, { id }, preview) => {
    // @ts-expect-error Preview fields are inferred, not any.
    preview.missing;
    db.table("tasks").patch(id, { done: true });
    return { id, before: preview.before };
  },
  compensate: ({ db }, receipt) => {
    // @ts-expect-error Receipt output is inferred, not any.
    receipt.output.missing;
    db.table("tasks").patch(receipt.output.id, { done: receipt.output.before });
    return { restored: receipt.output.id };
  },
});

const backend = await openBackend(definition, {
  path: "app.sqlite",
  reviewedActions: { actions: { finish } },
  agentActivity: {},
});
