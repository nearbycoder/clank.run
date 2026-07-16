import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
  type DocumentFor,
} from "clank.run";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const authPepper = environment?.CLANK_AUTH_PEPPER ?? environment?.PROACT_AUTH_PEPPER;

export const auth = defineAuth({
  password: authPepper ? { pepper: authPepper } : undefined,
});

export const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).owned().index("by_done", ["done"]),
});

export type Todo = DocumentFor<typeof schema, "todos">;
const documentVersion = s.number({ integer: true, min: 1 });

export const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      args: {},
      handler: ({ db }) => db.table("todos").query().orderBy("_creationTime", "asc").collect(),
    }),
    add: mutation({
      args: { title: s.string({ min: 1, max: 160 }) },
      handler: ({ db }, { title }) => db.table("todos").insert({
        title: title.trim(),
        done: false,
      }),
    }),
    setDone: mutation({
      args: { id: s.id("todos"), done: s.boolean(), version: documentVersion },
      handler: ({ db }, { id, done, version }) =>
        db.table("todos").patch(id, { done }, { ifVersion: version }),
    }),
    remove: mutation({
      args: { id: s.id("todos"), version: documentVersion },
      handler: ({ db }, { id, version }) =>
        db.table("todos").delete(id, { ifVersion: version }),
    }),
  },
}));
