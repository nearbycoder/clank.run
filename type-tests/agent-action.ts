import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "../src/index.ts";

const schema = defineDatabase({ tasks: defineTable({ workspaceId: s.string(), done: s.boolean() }).owned() });
const taskArgs = s.object({ id: s.id("tasks") });
const definition = defineBackend({ schema, auth: defineAuth() }).functions(({ query, mutation }) => ({
  tasks: {
    get: query({ args: taskArgs, handler: ({ db }, { id }) => db.table("tasks").get(id) }),
    finish: mutation({ args: taskArgs, handler: ({ db }, { id }) => db.table("tasks").patch(id, { done: true }) }),
  },
}));
await openBackend(definition, {
  path: "app.sqlite",
  agent: {
    actionContext(action, input, auth, db) {
      if (action === "tasks.finish" || action === "tasks.get") {
        // @ts-expect-error The action name does not narrow unknown custom-tool arguments.
        input.id;
        const { id } = taskArgs.parse(input);
        const task = db.table("tasks").get(id);
        // @ts-expect-error Database fields must be declared by the schema.
        task?.missing;
        return task
          ? { workspaceId: task.workspaceId, resourceIds: [task._id] }
          : {};
      }
      return {};
    },
  },
});
