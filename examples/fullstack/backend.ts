import {
  defineBackend,
  defineDatabase,
  defineTable,
  s,
  type DocumentFor,
} from "clank.run";

export const databaseSchema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).index("by_done", ["done"]),
});

export type Todo = DocumentFor<typeof databaseSchema, "todos">;
const documentVersion = s.number({ integer: true, min: 1 });

export const backend = defineBackend({ schema: databaseSchema }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      args: {},
      handler: ({ db }) => db.table("todos").query().orderBy("_creationTime", "asc").collect(),
    }),
    add: mutation({
      args: { title: s.string({ min: 1, max: 160 }) },
      handler: ({ db }, { title }) => db.table("todos").insert({ title, done: false }),
    }),
    toggle: mutation({
      args: { id: s.id("todos"), version: documentVersion },
      handler: ({ db }, { id, version }) => {
        const todo = db.table("todos").get(id);
        return todo
          ? db.table("todos").patch(id, { done: !todo.done }, { ifVersion: version })
          : null;
      },
    }),
    remove: mutation({
      args: { id: s.id("todos"), version: documentVersion },
      handler: ({ db }, { id, version }) =>
        db.table("todos").delete(id, { ifVersion: version }),
    }),
    clearCompleted: mutation({
      args: {},
      handler: ({ db }) => {
        const completed = db.table("todos").query().where("done", true).collect();
        for (const todo of completed) {
          db.table("todos").delete(todo._id, { ifVersion: todo._version });
        }
        return completed.length;
      },
    }),
  },
}));
